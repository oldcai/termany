import {
  type ControlError,
  DEFAULT_SCOPE,
  type PaneCandidate,
  type PaneTarget,
  type PaneView,
  type Scope,
} from "@termany/core";

/**
 * Turning "the web pane next to me" into one specific pane.
 *
 * Pure on purpose: everything that needs the filesystem (resolving a pane's cwd,
 * finding the `.git` above it) happens in identity.ts and arrives here already
 * decided, as fields on PaneRecord. That keeps the part with all the branching —
 * scope filtering and ambiguity — testable without a renderer or a repo.
 *
 * The one rule worth restating: **a selector that matches several panes is an
 * error carrying the candidates, never a pick.** An agent that meant one pane
 * and silently got another types into the wrong shell.
 */

/** A pane as the server sees it: the renderer's view plus what scoping needs. */
export interface PaneRecord {
  paneId: string;
  title: string;
  view: PaneView;
  path: string;
  workspaceId: string;
  nodeId: string;
  tabId: string;
  /** 1-based position within its own tab, in layout order. */
  index: number;
  /** The focused pane of its tab — which may be a background tab. */
  focused: boolean;
  /** On screen right now: active workspace, active page, active tab. */
  active: boolean;
  /** Absolute cwd, once resolved. Absent for panes with no directory. */
  cwd?: string;
  /** Nearest `.git` ancestor of `cwd`, else `cwd` itself. Absent with no cwd. */
  projectRoot?: string;
  /** Where to read scrollback: `paneId`, or `${paneId}:ssh:${host}` for SSH. */
  terminalSessionId?: string;
  /** Monotonic open order, so `last-opened` has an answer. */
  seq?: number;
  /**
   * Candidate directories in priority order — the pane, then the panes it
   * anchors to. Supplied by the renderer (only the store knows the anchor
   * chain); the server walks it to decide `cwd`.
   */
  cwdChain?: string[];
}

const err = (code: ControlError["code"], message: string, candidates?: PaneCandidate[]): ControlError =>
  candidates ? { code, message, candidates } : { code, message };

const candidateOf = (p: PaneRecord): PaneCandidate => ({
  paneId: p.paneId,
  title: p.title,
  view: p.view,
  path: p.path,
});

/** Cap on how many candidates an E_AMBIGUOUS carries — enough to choose from
 *  without turning one mistake into a wall of text in an agent's context. */
const MAX_CANDIDATES = 12;

export function ambiguous(selector: string, matches: PaneRecord[]): ControlError {
  const shown = matches.slice(0, MAX_CANDIDATES);
  const extra = matches.length - shown.length;
  return err(
    "E_AMBIGUOUS",
    `${selector} matched ${matches.length} panes; name one specifically` +
      (extra > 0 ? ` (${extra} more not listed)` : ""),
    shown.map(candidateOf)
  );
}

/**
 * Does `pane` fall inside `scope`, measured from `caller`?
 *
 * `"project"` compares resolved project roots, so a pane whose cwd never
 * resolved (no shell ever spawned, and no `cwdFrom` anchor that had one) belongs
 * to no project and is only reachable at `"global"`. That is deliberate: an
 * unattributable pane silently counting as "mine" is the failure mode worth
 * avoiding.
 */
export function inScope(pane: PaneRecord, caller: PaneRecord, scope: Scope): boolean {
  switch (scope) {
    case "tab":
      return pane.tabId === caller.tabId;
    case "page":
      return pane.nodeId === caller.nodeId;
    case "workspace":
      return pane.workspaceId === caller.workspaceId;
    case "project":
      return pane.projectRoot !== undefined && pane.projectRoot === caller.projectRoot;
    case "global":
      return true;
  }
}

/** Which scope applies: the selector's own, else the request's, else project. */
export function effectiveScope(target: PaneTarget, requested?: Scope): Scope {
  if (typeof target === "object" && "scope" in target && target.scope) return target.scope;
  return requested ?? DEFAULT_SCOPE;
}

/** Case-insensitive, and "contains" unless the caller asked for "exact". */
function titleMatches(title: string, needle: string, mode: "exact" | "contains"): boolean {
  const a = title.toLowerCase();
  const b = needle.toLowerCase();
  return mode === "exact" ? a === b : a.includes(b);
}

/** Exactly one match resolves; zero and many are the two error shapes. */
function only(
  selector: string,
  matches: PaneRecord[],
  emptyMessage: string
): PaneRecord | ControlError {
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) return err("E_NO_MATCH", emptyMessage);
  return ambiguous(selector, matches);
}

export interface ResolveOptions {
  /** Scope for selector forms that don't carry their own. */
  scope?: Scope;
}

/**
 * Resolve `target` against `panes`, from the vantage point of `caller`.
 *
 * Returns the matched record, or a ControlError. Never throws, and never
 * narrows a multi-way match down to one by preference.
 */
export function resolveTarget(
  panes: PaneRecord[],
  caller: PaneRecord,
  target: PaneTarget,
  opts: ResolveOptions = {}
): PaneRecord | ControlError {
  const scope = effectiveScope(target, opts.scope);
  const visible = panes.filter((p) => inScope(p, caller, scope));

  // A bare pane id, or the literal "self".
  if (typeof target === "string") {
    if (target === "self") return caller;
    const hit = visible.find((p) => p.paneId === target);
    if (hit) return hit;
    // Deliberately the same message whether or not the pane exists elsewhere —
    // the reply shouldn't confirm the existence of panes outside the scope the
    // caller was granted, but it should say how to widen it.
    return err(
      "E_NO_MATCH",
      scope === "global"
        ? `no pane with id ${target}`
        : `no pane with id ${target} in ${scope} scope (pass scope:"global" to look wider)`
    );
  }

  if ("ref" in target) return resolveRef(visible, caller, target.ref);

  if ("sibling" in target) {
    const { view, index, title } = target.sibling;
    if (view === undefined && index === undefined && title === undefined) {
      return err("E_NO_MATCH", "sibling selector needs at least one of view, index or title");
    }
    // Siblings are always same-tab regardless of scope, and never the caller —
    // but still only panes the scope admits, or a same-tab shell that `cd`ed
    // into another repo would be reachable without asking for `global`.
    const matches = visible.filter(
      (p) =>
        p.tabId === caller.tabId &&
        p.paneId !== caller.paneId &&
        (view === undefined || p.view === view) &&
        (index === undefined || p.index === index) &&
        (title === undefined || titleMatches(p.title, title, "contains"))
    );
    const desc = `sibling ${JSON.stringify(target.sibling)}`;
    return only(desc, matches, `no sibling pane in this tab matched ${JSON.stringify(target.sibling)}`);
  }

  if ("view" in target) {
    const matches = visible.filter((p) => p.view === target.view);
    return only(
      `view:"${target.view}"`,
      matches,
      `no ${target.view} pane in ${scope} scope`
    );
  }

  if ("title" in target) {
    const mode = target.match ?? "contains";
    const matches = visible.filter((p) => titleMatches(p.title, target.title, mode));
    return only(
      `title ${mode} "${target.title}"`,
      matches,
      `no pane in ${scope} scope with a title ${mode} "${target.title}"`
    );
  }

  if ("index" in target) {
    const tabId = target.tab ?? caller.tabId;
    const matches = visible.filter((p) => p.tabId === tabId && p.index === target.index);
    return only(
      `index ${target.index}`,
      matches,
      `no pane at index ${target.index} in tab ${tabId}`
    );
  }

  return err("E_NO_MATCH", `unrecognised pane selector: ${JSON.stringify(target)}`);
}

/**
 * The relative refs, all of them measured over the scoped slice. `next`/`prev`
 * walk the caller's own tab in layout order and wrap; `focused` means the pane
 * the user actually has focus on — and answers E_NO_MATCH when that pane is
 * outside the caller's scope, because "what am I looking at" must not be a way
 * around scoping for a caller that never asked for `global`.
 */
function resolveRef(
  visible: PaneRecord[],
  caller: PaneRecord,
  ref: "self" | "focused" | "next" | "prev" | "last-opened"
): PaneRecord | ControlError {
  if (ref === "self") return caller;

  if (ref === "focused") {
    const hit = visible.find((p) => p.active && p.focused);
    return hit ?? err("E_NO_MATCH", "no pane currently has focus");
  }

  if (ref === "next" || ref === "prev") {
    const tab = visible
      .filter((p) => p.tabId === caller.tabId)
      .sort((a, b) => a.index - b.index);
    if (tab.length < 2) return err("E_NO_MATCH", "the caller's tab has no other pane");
    const at = tab.findIndex((p) => p.paneId === caller.paneId);
    if (at < 0) return err("E_NO_MATCH", "the caller's own pane is not in its tab");
    const step = ref === "next" ? 1 : -1;
    return tab[(at + step + tab.length) % tab.length];
  }

  // last-opened: highest open sequence within scope, the caller aside. Panes the
  // renderer never gave a seq for can't win — undefined is not "oldest", it's
  // "unknown", and guessing would make the answer depend on walk order.
  const ranked = visible
    .filter((p) => p.paneId !== caller.paneId && p.seq !== undefined)
    .sort((a, b) => b.seq! - a.seq!);
  return ranked[0] ?? err("E_NO_MATCH", "no other pane with a known open order");
}

/** Every pane in scope, for `panes.list`. Order is the renderer's walk order. */
export function listInScope(
  panes: PaneRecord[],
  caller: PaneRecord,
  scope: Scope = DEFAULT_SCOPE
): PaneRecord[] {
  return panes.filter((p) => inScope(p, caller, scope));
}

/** Is this a ControlError rather than a resolved pane? */
export function isControlError(x: PaneRecord | ControlError): x is ControlError {
  return "code" in x;
}
