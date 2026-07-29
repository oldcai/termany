/**
 * Wire-level guard for the local API.
 *
 * The server hosts a PTY, arbitrary file read/write (`/api/fs/*`) and every
 * pane's scrollback (`/api/scroll`) with no authentication. That is only
 * defensible while the surface is genuinely reachable by this machine's own
 * app and nothing else. Two things have to hold for that:
 *
 *   1. The socket binds loopback (see BIND_HOST below), so nobody on the LAN
 *      can reach it at all.
 *   2. A page the user merely *visits* cannot drive it either. Loopback
 *      binding alone does not give you this — `http://localhost:5174` is
 *      reachable from any origin's JavaScript, and DNS rebinding defeats the
 *      bind by pointing an attacker-controlled name at 127.0.0.1.
 *
 * `guard()` is (2). It is deliberately server-side: `Access-Control-Allow-Origin`
 * only stops a browser from *reading* a response, and a `text/plain` fetch is a
 * CORS "simple request" — it executes with no preflight regardless of what we
 * echo back. So the check has to gate the handler, not the response headers.
 *
 * Kept a pure function of headers + config so it is testable without a socket.
 */

/** Origins the app itself legitimately runs under. */
function defaultOrigins(vitePort: number): string[] {
  return [
    // Packaged Tauri, macOS + Linux.
    "tauri://localhost",
    // Packaged Tauri, Windows (WebView2 serves the app over a custom
    // https/http scheme mapped onto `tauri.localhost`).
    "http://tauri.localhost",
    "https://tauri.localhost",
    // `npm run dev:web-client` — vite, strictPort (apps/web/vite.config.ts).
    `http://localhost:${vitePort}`,
    `http://127.0.0.1:${vitePort}`,
  ];
}

export const VITE_DEV_PORT = 15173;

export interface GuardConfig {
  /**
   * The host the server actually bound to. When it is loopback we can insist
   * the request was addressed to a loopback name, which is what blocks DNS
   * rebinding. When the operator has deliberately bound elsewhere
   * (TERMANY_BIND, the documented remote-server workflow) that check would be
   * wrong, so it is skipped and Origin does the work alone.
   */
  bindHost: string;
  /** Extra origins from TERMANY_ALLOWED_ORIGINS. */
  allowedOrigins?: readonly string[];
}

export type GuardReason = "host" | "origin" | "sec-fetch-site";

export interface GuardVerdict {
  ok: boolean;
  reason?: GuardReason;
  /** The offending header value, for the log line. Never sent to the client. */
  detail?: string;
}

const OK: GuardVerdict = { ok: true };

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "localhost" || value === "[::1]";
}

/** `localhost:5174`, `127.0.0.1:5174`, `[::1]:5174`, or the same without a port. */
function isLoopbackAuthority(host: string): boolean {
  const value = host.trim().toLowerCase();
  if (!value) return false;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return isLoopbackHost(bracketed[1]);
  const name = value.replace(/:\d+$/, "");
  // A bare `::1` (no brackets) is not legal in a Host header, but be lenient.
  return isLoopbackHost(name);
}

export function guard(
  headers: {
    host?: string;
    origin?: string;
    "sec-fetch-site"?: string;
  },
  config: GuardConfig
): GuardVerdict {
  // 1. Host — anti-DNS-rebinding. An attacker who points evil.com at 127.0.0.1
  //    still has the browser send `Host: evil.com`, so this catches it even
  //    though the packet arrives on loopback.
  if (isLoopbackHost(config.bindHost)) {
    const host = headers.host ?? "";
    if (!isLoopbackAuthority(host)) return { ok: false, reason: "host", detail: host || "(absent)" };
  }

  // 2. Origin. Present means a page, which must be one of ours.
  const origin = headers.origin;
  if (origin !== undefined && origin !== "") {
    const allowed = config.allowedOrigins ?? defaultOrigins(VITE_DEV_PORT);
    if (!allowed.includes(origin)) return { ok: false, reason: "origin", detail: origin };
    // An allowlisted Origin has already settled the question. Do NOT also
    // consult Sec-Fetch-Site here: the app's own client legitimately calls
    // across sites — the dev client is served from localhost:15173 and the API
    // lives on 127.0.0.1, which browsers correctly label `cross-site` — so
    // rejecting on it would 403 Termany itself.
    return OK;
  }

  // 3. No Origin. That is either a non-browser caller (curl, an agent, the
  //    Rust shell's version probe) or a browser sub-resource load — a
  //    cross-site <img>/<script> pointed at this port. The latter cannot read
  //    the response, but it can still trigger a side effect, and it is the one
  //    browser request shape rule 2 never sees. Sec-Fetch-Site separates them;
  //    a non-browser caller omits it entirely.
  if (headers["sec-fetch-site"] === "cross-site") {
    return { ok: false, reason: "sec-fetch-site", detail: "cross-site" };
  }

  return OK;
}

/**
 * Resolve the allowlist once at startup.
 *
 * TERMANY_ALLOWED_ORIGINS exists because the exact origin a *packaged* webview
 * sends is engine- and version-dependent — some WebKit builds report `null` for
 * custom schemes — and a wrong allowlist bricks the app rather than failing
 * safe. Rejections are logged with the exact value (see logRejection), so an
 * unexpected origin is a one-line fix rather than a mystery.
 */
export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.TERMANY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...defaultOrigins(VITE_DEV_PORT), ...extra];
}

export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMANY_BIND?.trim() || "127.0.0.1";
}

// One line per distinct offender. A page hammering the port would otherwise
// bury everything else in the log, and the interesting signal is the set of
// values seen, not the count.
const reported = new Set<string>();

export function logRejection(verdict: GuardVerdict, path: string): void {
  const key = `${verdict.reason}:${verdict.detail}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(
    `[termany] blocked a request to ${path}: ${verdict.reason} = ${verdict.detail}. ` +
      `If this is Termany itself, add the origin to TERMANY_ALLOWED_ORIGINS and report it.`
  );
}
