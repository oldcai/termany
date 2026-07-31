import { buildPaneIndex, cwdChainIn, type PaneView, type Workspace } from "../state/paneTree";

/**
 * The renderer's answer to "what panes exist, and how would you name them?".
 *
 * The server can't work this out for itself: titles, focus, layout position and
 * the `cwdFrom` anchor chain only exist in the store. So the renderer flattens
 * the tree into this and pushes it over the control socket whenever it changes.
 *
 * Only layout facts go in. Resolving a pane's actual directory — and from that
 * its project — needs the live PTY and the filesystem, so the server does that
 * half and this side stays free of anything it would have to guess at.
 */
export interface ControlPane {
  paneId: string;
  title: string;
  view: PaneView;
  path: string;
  workspaceId: string;
  nodeId: string;
  tabId: string;
  /** 1-based position within its own tab, in layout order. */
  index: number;
  focused: boolean;
  active: boolean;
  /**
   * Where to read this pane's scrollback, which is not always `paneId`: an SSH
   * pane's shell lives under `${paneId}:ssh:${host}`. Absent for panes with no
   * terminal at all (R8 — conflating the two makes an agent read the wrong ring).
   */
  terminalSessionId?: string;
  /** Candidate directories in priority order: the pane, then its anchors. */
  cwdChain: string[];
  /** Open order, so `{ ref: "last-opened" }` has an answer. */
  seq: number;
}

/**
 * First-seen order per pane id.
 *
 * Creation order isn't recoverable from a layout tree, and it can't be: the tree
 * records where panes are, not when they arrived. So it's observed here instead,
 * which does mean the panes present at startup share the order of the first walk
 * rather than the order the user originally made them in. That's honest — after a
 * relaunch "last opened" has no meaning until something is actually opened.
 */
const firstSeen = new Map<string, number>();
let nextSeq = 1;

function seqFor(paneId: string): number {
  const known = firstSeen.get(paneId);
  if (known !== undefined) return known;
  const seq = nextSeq++;
  firstSeen.set(paneId, seq);
  return seq;
}

/** Forget panes that no longer exist, so the map can't grow without bound. */
function prune(live: Set<string>): void {
  if (firstSeen.size <= live.size * 2) return;
  for (const paneId of firstSeen.keys()) {
    if (!live.has(paneId)) firstSeen.delete(paneId);
  }
}

export interface PaneIndexInput {
  workspaces: Workspace[];
  activeWorkspace: string;
  /** `terminalSessionId` from the terminal manager, injected to keep this pure. */
  sessionIdFor: (paneId: string, sshTarget?: string) => string;
  /** Which panes actually have a live or restorable terminal behind them. */
  hasTerminal: (view: PaneView, sshTarget?: string) => boolean;
}

export function controlPaneIndex(input: PaneIndexInput): ControlPane[] {
  const flat = buildPaneIndex(input.workspaces, input.activeWorkspace);
  prune(new Set(flat.map((p) => p.paneId)));

  return flat.map((p) => ({
    paneId: p.paneId,
    title: p.title,
    view: p.view,
    path: p.path,
    workspaceId: p.workspaceId,
    nodeId: p.nodeId,
    tabId: p.tabId,
    index: p.index,
    focused: p.focused,
    active: p.active,
    terminalSessionId: input.hasTerminal(p.view, p.sshTarget)
      ? input.sessionIdFor(p.paneId, p.sshTarget)
      : undefined,
    cwdChain: cwdChainIn(flat, p.paneId),
    seq: seqFor(p.paneId),
  }));
}

/**
 * A terminal pane has a shell; so does an SSH pane whatever its view says. The
 * shell-less views (files, git, web, monitor) have no ring of their own — they
 * borrow a directory through `cwdFrom`, not a session.
 */
export function paneHasTerminal(view: PaneView, sshTarget?: string): boolean {
  return view === "terminal" || sshTarget !== undefined;
}

/** Cheap change detection, so an unchanged index isn't re-sent every render.
 *  Every field that is pushed is hashed: a field left out here is a field the
 *  server keeps serving stale, and `terminalSessionId` in particular can flip
 *  (connecting SSH) with no other visible change at all. */
export function indexFingerprint(panes: ControlPane[]): string {
  return panes
    .map((p) =>
      [
        p.paneId,
        p.title,
        p.view,
        p.path,
        p.workspaceId,
        p.nodeId,
        p.tabId,
        p.index,
        p.focused ? 1 : 0,
        p.active ? 1 : 0,
        p.terminalSessionId ?? "",
        p.cwdChain.join(">"),
      ].join(":")
    )
    .join("|");
}

/** Test seam: forget the observed open order. */
export function resetPaneIndexOrder(): void {
  firstSeen.clear();
  nextSeq = 1;
}
