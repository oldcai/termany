import crypto from "node:crypto";
import path from "node:path";

/**
 * Proving "I am a process running inside pane X".
 *
 * Two ways in, because there are two ways an agent gets started:
 *
 *  - **Termany launched it.** The pane's token goes into the process environment
 *    at spawn time (PTY or ACP). Nothing to negotiate.
 *  - **The user launched it by hand** in an existing shell. It has no injected
 *    token, so it writes a nonce as an OSC sequence to its own tty and then
 *    redeems that nonce over HTTP. The security property is the tty: a hostile
 *    web page can make HTTP requests to loopback all day, but it cannot make a
 *    chosen byte sequence appear in the output stream of a real PTY. Whichever
 *    pane's PTY emitted the nonce is the pane the token gets bound to.
 *
 * The matching hazard is replay: that sequence lands in the pane's scrollback,
 * and a scrollback replay would re-emit it. `sanitizeForReplay` in index.ts
 * strips OSC 7717 for exactly that reason — see OSC_CLAIM_REPLAY_PATTERN.
 */

/** How a caller's token was obtained. Audit entries keep this. */
export type IdentitySource = "env" | "osc";

export interface CallerIdentity {
  paneId: string;
  source: IdentitySource;
  issuedAt: number;
}

/**
 * `ESC ] 7717 ; claim ; <nonce> BEL` (or ST-terminated). Deliberately a private
 * OSC number, and deliberately not one xterm.js acts on — an unrecognised OSC is
 * silently dropped by the terminal, so the user never sees the handshake.
 */
export const OSC_CLAIM_PATTERN = /\x1b\]7717;claim;([A-Za-z0-9_-]{16,128})(?:\x07|\x1b\\)/g;

/** The same sequence, permissive about its payload, for stripping on replay.
 *  Wider than the parser on purpose: anything shaped like a claim must not
 *  survive into a replayed stream, even a malformed one. */
export const OSC_CLAIM_REPLAY_PATTERN = /\x1b\]7717;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Nonces found in a chunk of PTY output. Bounded so a flood of malformed
 *  sequences in one chunk can't turn into unbounded bookkeeping. */
export function extractOscClaims(data: string, limit = 8): string[] {
  const out: string[] = [];
  // A fresh regex each call: the exported one carries /g state.
  const re = new RegExp(OSC_CLAIM_PATTERN.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null && out.length < limit) out.push(m[1]);
  return out;
}

/**
 * The project a directory belongs to: the nearest ancestor holding a `.git`,
 * else the directory itself. Matches how the worktree logic decides, so an
 * agent's idea of "my project" is the same one the rest of the app uses.
 *
 * `hasGit` is injected so this stays testable without a real repo on disk.
 */
export function projectRootFor(cwd: string, hasGit: (dir: string) => boolean): string {
  let dir = path.resolve(cwd);
  for (let hops = 0; hops < 64; hops++) {
    if (hasGit(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(cwd);
}

/** A nonce is only worth honouring briefly — it's shouted into a terminal. */
const CLAIM_TTL_MS = 30_000;

/** Cap on outstanding claims, so noise in one pane can't grow without bound. */
const MAX_PENDING_CLAIMS = 64;

interface PendingClaim {
  paneId: string;
  seenAt: number;
}

export class IdentityRegistry {
  private byToken = new Map<string, CallerIdentity>();
  private byPane = new Map<string, string>();
  private pending = new Map<string, PendingClaim>();

  constructor(private now: () => number = Date.now) {}

  /**
   * The token for `paneId`, minted on first ask and stable afterwards — a pane's
   * shell may spawn several agents, and they are all equally that pane.
   */
  tokenForPane(paneId: string, source: IdentitySource = "env"): string {
    const existing = this.byPane.get(paneId);
    if (existing) return existing;
    const token = crypto.randomBytes(32).toString("base64url");
    this.byToken.set(token, { paneId, source, issuedAt: this.now() });
    this.byPane.set(paneId, token);
    return token;
  }

  /** Drop a pane's token when the pane goes away, so it can't outlive it. */
  revokePane(paneId: string): void {
    const token = this.byPane.get(paneId);
    if (!token) return;
    this.byPane.delete(paneId);
    this.byToken.delete(token);
  }

  /**
   * Who is calling. Undefined for an absent, malformed or unknown token — the
   * caller learns nothing about which of those it was.
   */
  identify(token: string | undefined | null): CallerIdentity | undefined {
    if (!token) return undefined;
    return this.byToken.get(token);
  }

  /**
   * Record that `paneId`'s PTY emitted `nonce`. Called from the output path, so
   * it must stay cheap and must never throw.
   */
  noteOscClaim(paneId: string, nonce: string): void {
    this.prunePending();
    // Full means noise, and refusing the newest claim is the wrong way to answer
    // it: a pane that merely *displays* claim-shaped bytes could otherwise keep
    // this table saturated and silently break every honest handshake, in every
    // pane. Evict the oldest instead — a claim only has to survive one redeem.
    while (this.pending.size >= MAX_PENDING_CLAIMS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
    this.pending.set(nonce, { paneId, seenAt: this.now() });
  }

  /**
   * Trade a nonce for that pane's token. Single use: a nonce that has been
   * redeemed (or has expired, or was never seen on a real tty) is gone.
   */
  redeemClaim(nonce: string): { token: string; paneId: string } | undefined {
    this.prunePending();
    const claim = this.pending.get(nonce);
    if (!claim) return undefined;
    this.pending.delete(nonce);
    return { token: this.tokenForPane(claim.paneId, "osc"), paneId: claim.paneId };
  }

  /** For diagnostics and tests. */
  get pendingCount(): number {
    this.prunePending();
    return this.pending.size;
  }

  private prunePending(): void {
    const cutoff = this.now() - CLAIM_TTL_MS;
    for (const [nonce, claim] of this.pending) {
      if (claim.seenAt < cutoff) this.pending.delete(nonce);
    }
  }
}

/** Environment variables handed to every process Termany starts in a pane. */
export function controlEnvironment(
  paneId: string,
  token: string,
  baseUrl: string
): Record<string, string> {
  return {
    TERMANY_PANE_ID: paneId,
    TERMANY_CONTROL_URL: `${baseUrl}/api/control`,
    TERMANY_CONTROL_TOKEN: token,
  };
}

/** Pull a bearer token out of request headers. Accepts the Authorization header
 *  and an explicit `x-termany-token`, because a shell one-liner reaches for
 *  whichever is less quoting trouble. */
export function tokenFromHeaders(headers: {
  authorization?: string | string[];
  "x-termany-token"?: string | string[];
}): string | undefined {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const explicit = first(headers["x-termany-token"])?.trim();
  if (explicit) return explicit;
  const auth = first(headers.authorization)?.trim();
  if (!auth) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1].trim() : undefined;
}
