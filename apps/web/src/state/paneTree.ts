import type { PaneView } from "@termany/core";

/**
 * The layout model — the shapes that get persisted, and the pure functions that
 * address panes inside them.
 *
 * This module has no runtime imports (the one above is type-only, so it is
 * erased). The store (zustand, terminal manager, themes, localStorage) sits on
 * top of it, so anything reasoning about where a pane lives can be exercised
 * under plain `node --test` without a DOM.
 *
 * The addressing distinction that matters: `updateNode`-based helpers in the
 * store reach a pane through the *active* tab, which is the right default for a
 * keystroke — the user can only press ⌘D on what they're looking at. It is the
 * wrong default for anything driven from outside the UI (a pane-control RPC, a
 * late-arriving async result), because the pane it names may well be sitting in
 * a backgrounded tab. `findTabContaining` / `updateTabContaining` address by
 * pane id across every workspace instead.
 */

/**
 * A pane layout inside a tab: either a single terminal (leaf) or a row/col split
 * of child panes. `dir: "row"` = side by side (vertical divider, ⌘D);
 * `dir: "col"` = stacked top/bottom (horizontal divider, ⌘⇧D).
 *
 * A leaf's `id` is the terminal session id in the registry.
 */
export type { PaneView };

/** One slice of a reply, in arrival order: prose or a tool invocation.
 *  `status` is the ACP tool-call status: pending | in_progress | completed | failed.
 *  `input`/`output` are display-ready detail strings (command / result),
 *  revealed when the tool row is expanded. */
export type AgentPart =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; title: string; status?: string; input?: string; output?: string };

export interface AgentMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /** The reply interleaved with the tool calls that produced it (ACP runtimes).
   *  Only present when at least one tool ran; `content` stays the full text. */
  parts?: AgentPart[];
  /** Wall-clock run time, shown on the collapsed tool-call header. */
  durationMs?: number;
  /** Why the reply stopped, rendered in place of (or after) the content. */
  error?: string;
}

export type Pane =
  | {
      kind: "leaf";
      id: string;
      title: string;
      view?: PaneView;
      /** Directory anchor: the pane whose directory this leaf resolves its
       *  own from while it has no shell of its own — the file tree's root,
       *  an agent's working folder and a terminal's first-spawn cwd all
       *  follow it. Set at creation to the pane the user was coming from;
       *  anchors form a chain that is walked at spawn (see cwdCandidates). */
      cwdFrom?: string;
      /** Explicit directory root requested by an external action, such as
       *  dropping a folder/file from Finder onto this pane. */
      filesRoot?: string;
      /** File to preview when opening this pane in files view. */
      filesSelected?: string;
      /** Last URL explicitly opened in this pane's browser view. */
      webUrl?: string;
      /** OpenSSH destination for a remote terminal. When absent this pane runs
       *  the local login shell. Kept in layout state so relaunch reconnects to
       *  the same host. */
      sshTarget?: string;
      /** Human-readable profile name shown in the terminal header. */
      sshLabel?: string;
      /** Which agent CLI conversation this pane hosts, registered when the
       *  session-history browser resumes into it — lets a later click on the
       *  same conversation jump here instead of resuming a second copy. */
      agentSession?: { agent: string; sessionId: string };
      /** Native Agent-pane conversation state. Stored with the layout so a
       *  conversation survives switching tabs and relaunching the app. */
      agentMessages?: AgentMessage[];
      /** "providerId/modelName"; unset follows the current default model. */
      agentModel?: string;
      /** ACP session selector picks (model, and whatever else the agent
       *  offers), as agentId → configId → value. An ACP session always starts
       *  on the agent's defaults, so these are replayed onto every session the
       *  pane opens; keyed by agent because the value ids are the agent's own. */
      agentConfig?: Record<string, Record<string, string>>;
      /** Agent registry id for an ACP-backed native conversation. Undefined
       *  means "never chosen" (the pane defaults to the first enabled
       *  runtime); "" is an explicit Chat-mode choice (Termany's lightweight
       *  BYOK chat endpoint). */
      agentRuntime?: string;
      /** Working folder the user picked explicitly for the ACP agent. Unset
       *  inherits the source terminal's live cwd (via cwdFrom). */
      agentCwd?: string;
    }
  | {
      kind: "split";
      dir: "row" | "col";
      children: Pane[];
      /**
       * Each child's fractional size (sums to 1, length === children.length).
       * Omitted means "evenly sized"; resizeSplit fills it in on first drag.
       * Cleared whenever children are added/removed so it can't go stale.
       */
      sizes?: number[];
    };

/** Which side of a target pane a drag is dropping onto. */
export type DropEdge = "left" | "right" | "top" | "bottom";

export interface HTab {
  id: string;
  title: string;
  layout: Pane;
  /** The focused leaf (session id) — where split/close act and keyboard goes. */
  focused: string;
  /** When set, only this leaf is shown, filling the tab (Wave-style magnify). */
  maximized?: string;
  /**
   * Index into this tab's layout presets, advanced by retilePanes. Undefined
   * means "hand-arranged" — the next press lands on preset 0 rather than
   * skipping past it.
   */
  layoutPreset?: number;
}

export interface TreeNode {
  id: string;
  title: string;
  expanded: boolean;
  children: TreeNode[];
  htabs: HTab[];
  activeHTab: string;
}

export interface Workspace {
  id: string;
  title: string;
  /** Emoji icon; when unset the UI falls back to the title's first letter. */
  icon?: string;
  roots: TreeNode[];
  activeNode: string;
}

/** Where a pane lives, in jumpToResult coordinates. */
export interface PaneLocation {
  workspaceId: string;
  nodeId: string;
  tabId: string;
  paneId: string;
}

// --- leaf walking ----------------------------------------------------------

/** Every leaf (session) id under a pane, in layout order. */
export function leafIds(pane: Pane): string[] {
  return pane.kind === "leaf" ? [pane.id] : pane.children.flatMap(leafIds);
}

export function findLeaf(pane: Pane, leafId: string): (Pane & { kind: "leaf" }) | undefined {
  if (pane.kind === "leaf") return pane.id === leafId ? pane : undefined;
  for (const c of pane.children) {
    const hit = findLeaf(c, leafId);
    if (hit) return hit;
  }
  return undefined;
}

/** Rebuild `pane` with `fn` applied to the leaf `leafId`; everything else keeps
 *  its identity, and a pane id that isn't in this layout is a no-op. */
export function mapLeaf(
  pane: Pane,
  leafId: string,
  fn: (leaf: Pane & { kind: "leaf" }) => Pane & { kind: "leaf" }
): Pane {
  if (pane.kind === "leaf") return pane.id === leafId ? fn(pane) : pane;
  return { ...pane, children: pane.children.map((c) => mapLeaf(c, leafId, fn)) };
}

// --- addressing by pane id, across every workspace -------------------------

/**
 * Locate the tab holding `paneId`, searching every workspace and every page —
 * not just the active one. Undefined when no tab holds it (a stale id from a
 * closed pane, or one the caller made up).
 */
export function findTabContaining(
  workspaces: Workspace[],
  paneId: string
): PaneLocation | undefined {
  const inNodes = (nodes: TreeNode[], workspaceId: string): PaneLocation | undefined => {
    for (const node of nodes) {
      for (const tab of node.htabs) {
        if (findLeaf(tab.layout, paneId)) {
          return { workspaceId, nodeId: node.id, tabId: tab.id, paneId };
        }
      }
      const hit = inNodes(node.children, workspaceId);
      if (hit) return hit;
    }
    return undefined;
  };
  for (const workspace of workspaces) {
    const hit = inNodes(workspace.roots, workspace.id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Apply `fn` to the tab holding `paneId`, wherever that tab lives.
 *
 * Returns the original `workspaces` array by reference when nothing matched, or
 * when `fn` hands back the very tab it was given — a no-op action (a split that
 * would exceed the pane cap, a rename to the same string) must not invalidate
 * every subscriber. Only the nodes on the path to the hit are cloned.
 */
export function updateTabContaining(
  workspaces: Workspace[],
  paneId: string,
  fn: (tab: HTab, ctx: { node: TreeNode; workspace: Workspace }) => HTab
): Workspace[] {
  let found = false;

  const inNodes = (nodes: TreeNode[], workspace: Workspace): TreeNode[] => {
    let changed = false;
    const out = nodes.map((node) => {
      if (found) return node;

      const i = node.htabs.findIndex((tab) => findLeaf(tab.layout, paneId));
      if (i >= 0) {
        found = true;
        const next = fn(node.htabs[i], { node, workspace });
        if (next === node.htabs[i]) return node;
        const htabs = [...node.htabs];
        htabs[i] = next;
        changed = true;
        return { ...node, htabs };
      }

      const children = inNodes(node.children, workspace);
      if (children !== node.children) {
        changed = true;
        return { ...node, children };
      }
      return node;
    });
    return changed ? out : nodes;
  };

  let changed = false;
  const out = workspaces.map((workspace) => {
    if (found) return workspace;
    const roots = inNodes(workspace.roots, workspace);
    if (roots === workspace.roots) return workspace;
    changed = true;
    return { ...workspace, roots };
  });
  return changed ? out : workspaces;
}

/**
 * Drop `tabId` from `node`, keeping `activeHTab` pointing at something real.
 * `refill` supplies a replacement tab for the case where this was the node's
 * last one — a page with zero tabs has nowhere to draw.
 */
export function removeTab(node: TreeNode, tabId: string, refill: () => HTab): TreeNode {
  const htabs = node.htabs.filter((h) => h.id !== tabId);
  if (htabs.length === node.htabs.length) return node;
  if (htabs.length === 0) {
    const fresh = refill();
    return { ...node, htabs: [fresh], activeHTab: fresh.id };
  }
  // Closing the tab you were on lands you on the last remaining one; closing a
  // background tab leaves the selection alone.
  const activeHTab = node.activeHTab === tabId ? htabs[htabs.length - 1].id : node.activeHTab;
  return { ...node, htabs, activeHTab };
}

// --- flat index over every open pane ---------------------------------------

/** One pane, flattened out of the tree with everything needed to address it. */
export interface PaneDescriptor {
  paneId: string;
  title: string;
  /** Normalised: an unset `view` is a terminal. */
  view: PaneView;
  workspaceId: string;
  workspaceTitle: string;
  nodeId: string;
  nodeTitle: string;
  tabId: string;
  tabTitle: string;
  /** "ws 1 / page 1 / tab 2 / pane 3", for a human reading an RPC reply. */
  path: string;
  /** 1-based position within its own tab, in layout order. */
  index: number;
  /** The focused pane of its tab (which may itself be a background tab). */
  focused: boolean;
  /** On screen right now: active workspace, active page, active tab. Always
   *  false unless `buildPaneIndex` was told which workspace is active. */
  active: boolean;
  cwdFrom?: string;
  sshTarget?: string;
  webUrl?: string;
  agentRuntime?: string;
}

/**
 * Every open pane, in a stable walk order: workspace order, then depth-first
 * page order, then tab order, then layout order. Callers that need "the pane
 * the user last opened" have to track that themselves — creation order is not
 * recoverable from the layout.
 *
 * `activeWorkspaceId` is what makes `active` meaningful: each workspace carries
 * its own `activeNode`, so without it every workspace would look on-screen.
 */
export function buildPaneIndex(
  workspaces: Workspace[],
  activeWorkspaceId?: string
): PaneDescriptor[] {
  const out: PaneDescriptor[] = [];

  const walk = (nodes: TreeNode[], workspace: Workspace, activeNodeId: string, wsActive: boolean) => {
    for (const node of nodes) {
      const nodeActive = wsActive && node.id === activeNodeId;
      for (const tab of node.htabs) {
        const tabActive = nodeActive && tab.id === node.activeHTab;
        let index = 0;
        const visit = (pane: Pane) => {
          if (pane.kind !== "leaf") {
            for (const child of pane.children) visit(child);
            return;
          }
          index += 1;
          out.push({
            paneId: pane.id,
            title: pane.title,
            view: pane.view ?? "terminal",
            workspaceId: workspace.id,
            workspaceTitle: workspace.title,
            nodeId: node.id,
            nodeTitle: node.title,
            tabId: tab.id,
            tabTitle: tab.title,
            path: [workspace.title, node.title, tab.title, pane.title].join(" / "),
            index,
            focused: tab.focused === pane.id,
            active: tabActive,
            cwdFrom: pane.cwdFrom,
            sshTarget: pane.sshTarget,
            webUrl: pane.webUrl,
            agentRuntime: pane.agentRuntime,
          });
        };
        visit(tab.layout);
      }
      walk(node.children, workspace, activeNodeId, wsActive);
    }
  };

  for (const workspace of workspaces) {
    walk(workspace.roots, workspace, workspace.activeNode, workspace.id === activeWorkspaceId);
  }
  return out;
}

/**
 * Ordered cwd candidates for `paneId`: the pane itself first — its live shell or
 * last-known directory always beats inheritance — then its `cwdFrom` anchor
 * chain. The chain exists because an anchor may itself never have opened a
 * shell; the server tries each candidate in turn and takes the first that
 * resolves to a directory. Capped, and cycle-safe.
 *
 * Takes a lookup rather than a container so the store (walking live state) and
 * the control client (walking a flat index) share one implementation.
 */
export function cwdChain(
  anchorOf: (paneId: string) => string | undefined,
  paneId: string,
  limit = 8
): string[] {
  const out = [paneId];
  const seen = new Set(out);
  let cur = anchorOf(paneId);
  while (cur && !seen.has(cur) && out.length < limit) {
    out.push(cur);
    seen.add(cur);
    cur = anchorOf(cur);
  }
  return out;
}

/** `cwdChain` over a flat pane index. */
export function cwdChainIn(index: PaneDescriptor[], paneId: string, limit = 8): string[] {
  const byId = new Map(index.map((p) => [p.paneId, p]));
  return cwdChain((id) => byId.get(id)?.cwdFrom, paneId, limit);
}
