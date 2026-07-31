/**
 * The pane-control wire contract, shared by the server (which answers RPCs) and
 * the renderer (which owns the panes those RPCs name).
 *
 * Two rules shape everything here:
 *
 *  1. **Panes are addressed by selector, not by raw id.** An agent living in a
 *     pane knows "the web pane next to me", not a UUID it never saw. Selectors
 *     also let the server reject an ambiguous request instead of guessing.
 *  2. **An ambiguous selector is an error, never a guess.** `E_AMBIGUOUS`
 *     carries the candidates so the caller can narrow it down. Silently picking
 *     the first match is how an agent ends up typing into the wrong shell.
 */

/** What a pane's body is showing. Mirrors the renderer's layout model. */
export type PaneView = "terminal" | "files" | "git" | "agent" | "web" | "monitor";

/**
 * How wide a selector is allowed to look.
 *
 * The default is `"project"`, not `"global"`: an agent working in one checkout
 * should not discover — let alone drive — the panes of an unrelated checkout
 * just because both happen to be open. A pane belongs to a project when its
 * resolved cwd is at or under the caller's project root (the nearest `.git`
 * above the caller's own cwd, or that cwd itself when there is no repo).
 *
 * Reaching outside that requires `"global"` explicitly, and `"global"` writes
 * always take the consent path — even for a pane the caller created itself.
 */
export type Scope = "tab" | "page" | "workspace" | "project" | "global";

export const DEFAULT_SCOPE: Scope = "project";

/**
 * Which pane an RPC means.
 *
 * A bare string is a pane id, or the literal `"self"` — the caller's own pane.
 * The object forms are what an agent can actually express without having been
 * told any ids.
 */
export type PaneTarget =
  | string
  | { ref: "self" | "focused" | "next" | "prev" | "last-opened" }
  /** Within the caller's own tab — "the web pane beside me". */
  | { sibling: { view?: PaneView; index?: number; title?: string } }
  | { view: PaneView; scope?: Scope }
  /** `match` defaults to "contains", and is always case-insensitive. */
  | { title: string; scope?: Scope; match?: "exact" | "contains" }
  /** 1-based, within `tab` when given, else within the caller's tab. */
  | { index: number; tab?: string };

/**
 * Who a pane turned out to be. Every response carries this, so a caller never
 * has to follow up with `panes.list` to find out what it just acted on.
 */
export interface ResolvedPane {
  paneId: string;
  title: string;
  view: PaneView;
  /** "ws 1 / page 1 / tab 2 / pane 3" — for a human reading a log line. */
  path: string;
  /**
   * The scrollback ring to read for this pane, which is NOT always `paneId`: an
   * SSH pane's shell lives under `${paneId}:ssh:${host}`. Absent when the pane
   * has no terminal at all (a web or files pane).
   */
  terminalSessionId?: string;
  /** Absent when the pane isn't currently mounted in a live renderer. */
  cwd?: string;
  /** The project this pane counts as belonging to, if any. */
  projectRoot?: string;
  /** On screen right now, as opposed to sitting in a background tab. */
  active: boolean;
}

/** A candidate offered back when a selector matched more than one pane. */
export interface PaneCandidate {
  paneId: string;
  title: string;
  view: PaneView;
  path: string;
}

export type ControlErrorCode =
  /** Nothing matched the selector. */
  | "E_NO_MATCH"
  /** More than one pane matched; `candidates` says which. */
  | "E_AMBIGUOUS"
  /** No renderer is connected, so nothing can answer for live panes. */
  | "E_NO_HOST"
  /** The pane exists in the saved layout but isn't mounted right now. */
  | "E_PANE_NOT_MOUNTED"
  /** This pane kind can't do that (eval on a terminal, send on a web pane). */
  | "E_UNSUPPORTED"
  /** Policy says no, and no amount of consent would change that. */
  | "E_FORBIDDEN"
  /** The user was asked and said no. */
  | "E_CONSENT_DENIED"
  /** The renderer accepted the request but never answered. */
  | "E_TIMEOUT";

export interface ControlError {
  code: ControlErrorCode;
  message: string;
  /** Present on E_AMBIGUOUS. */
  candidates?: PaneCandidate[];
}

export type ControlResult<T> = ({ ok: true } & T) | { ok: false; error: ControlError };

/**
 * The caller's own identity, as proven by its token (env-injected for panes
 * Termany launched, OSC-challenge-registered for agents the user started by
 * hand). This is the anchor every relative selector resolves against.
 */
export interface WhoAmI {
  paneId: string;
  terminalSessionId?: string;
  title: string;
  view: PaneView;
  path: string;
  cwd?: string;
  /**
   * The project the caller is confined to by default. `root` is the nearest
   * `.git` ancestor of the caller's cwd, falling back to the cwd itself.
   * `paneCount` is how many panes fall inside it — so an agent can tell at a
   * glance whether the thing it's looking for is even in scope.
   */
  project: { root: string; paneCount: number };
  /** The scope applied when a selector doesn't name one. */
  defaultScope: Scope;
}

/**
 * Authorization tiers (D9). The default is `"ask"`; `"off"` makes every control
 * endpoint answer `E_FORBIDDEN`.
 *
 * A token proves "I am a process running inside pane X". It must not silently
 * also mean "I may drive any pane in any project" — prompt injection is a
 * residual risk no transport can remove, so consent, an audit trail and a kill
 * switch are the mitigation.
 */
export type PolicyMode = "off" | "ask" | "allow-project" | "allow-all";

export const DEFAULT_POLICY: PolicyMode = "ask";

/**
 * How much authority a given call needs.
 *
 *  - `read`  — describing panes, reading scrollback or captured console output
 *  - `write` — typing into a pane, evaluating JS, opening or closing panes
 *  - `cross-project` — anything at `scope: "global"` reaching outside the
 *    caller's project, which always prompts regardless of who created the pane
 */
export type Tier = "read" | "write" | "cross-project";
