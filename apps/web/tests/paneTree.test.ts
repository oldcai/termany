import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildPaneIndex,
  cwdChain,
  cwdChainIn,
  findTabContaining,
  type HTab,
  type Pane,
  removeTab,
  type TreeNode,
  updateTabContaining,
  type Workspace,
} from "../src/state/paneTree.js";

const leaf = (id: string, extra: Partial<Pane & { kind: "leaf" }> = {}): Pane => ({
  kind: "leaf",
  id,
  title: id,
  ...extra,
});

const tab = (id: string, layout: Pane, focused: string): HTab => ({ id, title: id, layout, focused });

const node = (id: string, htabs: HTab[], children: TreeNode[] = []): TreeNode => ({
  id,
  title: id,
  expanded: true,
  children,
  htabs,
  activeHTab: htabs[0].id,
});

/**
 * Two workspaces, a nested page, several tabs, and splits — so "the active tab
 * of the active page of the active workspace" is a small minority of the panes.
 * Everything outside it is what the old active-tab-only actions silently
 * refused to touch.
 */
function fixture(): Workspace[] {
  const ws1: Workspace = {
    id: "ws1",
    title: "ws 1",
    activeNode: "n1",
    roots: [
      node(
        "n1",
        [
          tab("t1", { kind: "split", dir: "row", children: [leaf("p1"), leaf("p2")] }, "p1"),
          tab("t2", leaf("p3", { view: "web", webUrl: "https://example.test/" }), "p3"),
        ],
        [node("n11", [tab("t3", leaf("p4", { view: "agent", cwdFrom: "p1" }), "p4")])]
      ),
    ],
  };
  const ws2: Workspace = {
    id: "ws2",
    title: "ws 2",
    activeNode: "n2",
    roots: [
      node("n2", [
        tab(
          "t4",
          {
            kind: "split",
            dir: "col",
            children: [leaf("p5"), { kind: "split", dir: "row", children: [leaf("p6"), leaf("p7")] }],
          },
          "p6"
        ),
      ]),
    ],
  };
  return [ws1, ws2];
}

describe("findTabContaining", () => {
  test("finds a pane in the active tab", () => {
    assert.deepEqual(findTabContaining(fixture(), "p1"), {
      workspaceId: "ws1",
      nodeId: "n1",
      tabId: "t1",
      paneId: "p1",
    });
  });

  test("finds a pane in a BACKGROUND tab of the active page", () => {
    assert.deepEqual(findTabContaining(fixture(), "p3"), {
      workspaceId: "ws1",
      nodeId: "n1",
      tabId: "t2",
      paneId: "p3",
    });
  });

  test("finds a pane on a nested, non-active page", () => {
    assert.deepEqual(findTabContaining(fixture(), "p4"), {
      workspaceId: "ws1",
      nodeId: "n11",
      tabId: "t3",
      paneId: "p4",
    });
  });

  test("finds a pane in another workspace entirely", () => {
    assert.deepEqual(findTabContaining(fixture(), "p7"), {
      workspaceId: "ws2",
      nodeId: "n2",
      tabId: "t4",
      paneId: "p7",
    });
  });

  test("returns undefined for an id no tab holds", () => {
    assert.equal(findTabContaining(fixture(), "nope"), undefined);
  });
});

describe("updateTabContaining", () => {
  /** The regression this whole refactor exists for: an RPC naming a pane in a
   *  backgrounded tab used to hit `h.id !== n.activeHTab` and no-op silently. */
  test("reaches a pane in a background tab", () => {
    const out = updateTabContaining(fixture(), "p3", (h) => ({ ...h, title: "renamed" }));
    assert.equal(out[0].roots[0].htabs[1].title, "renamed");
  });

  test("reaches a pane on a nested page in a non-active workspace", () => {
    const out = updateTabContaining(fixture(), "p7", (h) => ({ ...h, focused: "p7" }));
    assert.equal(out[1].roots[0].htabs[0].focused, "p7");
  });

  test("hands the callback the owning tab, node and workspace", () => {
    let seen: { tab: string; node: string; workspace: string } | undefined;
    updateTabContaining(fixture(), "p4", (h, ctx) => {
      seen = { tab: h.id, node: ctx.node.id, workspace: ctx.workspace.id };
      return h;
    });
    assert.deepEqual(seen, { tab: "t3", node: "n11", workspace: "ws1" });
  });

  test("applies to exactly one tab", () => {
    let calls = 0;
    updateTabContaining(fixture(), "p6", (h) => {
      calls += 1;
      return h;
    });
    assert.equal(calls, 1);
  });

  test("no match returns the very same array (no subscriber churn)", () => {
    const before = fixture();
    assert.equal(updateTabContaining(before, "ghost", (h) => ({ ...h, title: "x" })), before);
  });

  test("a callback that changes nothing returns the very same array", () => {
    const before = fixture();
    assert.equal(updateTabContaining(before, "p1", (h) => h), before);
  });

  test("clones only along the path to the hit", () => {
    const before = fixture();
    const after = updateTabContaining(before, "p3", (h) => ({ ...h, title: "renamed" }));

    assert.notEqual(after, before, "root array is rebuilt");
    assert.notEqual(after[0], before[0], "the owning workspace is rebuilt");
    assert.equal(after[1], before[1], "the untouched workspace keeps identity");
    assert.equal(
      after[0].roots[0].children[0],
      before[0].roots[0].children[0],
      "the untouched child page keeps identity"
    );
    assert.equal(
      after[0].roots[0].htabs[0],
      before[0].roots[0].htabs[0],
      "the untouched sibling tab keeps identity"
    );
  });

  test("does not mutate the input", () => {
    const before = fixture();
    const snapshot = JSON.stringify(before);
    updateTabContaining(before, "p3", (h) => ({ ...h, title: "renamed" }));
    assert.equal(JSON.stringify(before), snapshot);
  });
});

describe("removeTab", () => {
  const refill = (): HTab => tab("fresh", leaf("fresh-pane"), "fresh-pane");

  test("closing the active tab lands on the last remaining one", () => {
    const n = node("n", [tab("a", leaf("p1"), "p1"), tab("b", leaf("p2"), "p2")]);
    const out = removeTab({ ...n, activeHTab: "a" }, "a", refill);
    assert.deepEqual(out.htabs.map((h) => h.id), ["b"]);
    assert.equal(out.activeHTab, "b");
  });

  test("closing a background tab leaves the selection alone", () => {
    const n = node("n", [tab("a", leaf("p1"), "p1"), tab("b", leaf("p2"), "p2")]);
    const out = removeTab({ ...n, activeHTab: "a" }, "b", refill);
    assert.deepEqual(out.htabs.map((h) => h.id), ["a"]);
    assert.equal(out.activeHTab, "a", "still on the tab the user was looking at");
  });

  test("closing the last tab refills so the page is never tabless", () => {
    const n = node("n", [tab("a", leaf("p1"), "p1")]);
    const out = removeTab(n, "a", refill);
    assert.deepEqual(out.htabs.map((h) => h.id), ["fresh"]);
    assert.equal(out.activeHTab, "fresh");
  });

  test("an unknown tab id keeps the node's identity", () => {
    const n = node("n", [tab("a", leaf("p1"), "p1")]);
    assert.equal(removeTab(n, "ghost", refill), n);
  });
});

describe("buildPaneIndex", () => {
  test("walks every pane in every workspace, in layout order", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    assert.deepEqual(index.map((p) => p.paneId), ["p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  });

  test("numbers panes 1-based within their own tab", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    const at = (id: string) => index.find((p) => p.paneId === id)!;
    assert.equal(at("p1").index, 1);
    assert.equal(at("p2").index, 2);
    assert.equal(at("p3").index, 1, "first pane of its own tab, not the third overall");
    assert.equal(at("p7").index, 3, "splits flatten in visual order");
  });

  test("an unset view reads as terminal", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    assert.equal(index.find((p) => p.paneId === "p1")!.view, "terminal");
    assert.equal(index.find((p) => p.paneId === "p3")!.view, "web");
  });

  test("focused is per-tab, so background tabs have one too", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    const focused = index.filter((p) => p.focused).map((p) => p.paneId);
    assert.deepEqual(focused, ["p1", "p3", "p4", "p6"]);
  });

  test("active is only the active tab of the active page of the active workspace", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    assert.deepEqual(index.filter((p) => p.active).map((p) => p.paneId), ["p1", "p2"]);
  });

  test("without an active workspace id nothing claims to be on screen", () => {
    assert.equal(buildPaneIndex(fixture()).some((p) => p.active), false);
  });

  test("path reads workspace / page / tab / pane", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    assert.equal(index.find((p) => p.paneId === "p4")!.path, "ws 1 / n11 / t3 / p4");
  });

  test("carries the fields selectors and cwd resolution need", () => {
    const p3 = buildPaneIndex(fixture(), "ws1").find((p) => p.paneId === "p3")!;
    assert.equal(p3.webUrl, "https://example.test/");
    assert.equal(p3.tabId, "t2");
    assert.equal(p3.nodeId, "n1");
    assert.equal(p3.workspaceId, "ws1");
  });
});

describe("cwdChain", () => {
  test("starts with the pane itself, then walks anchors", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    assert.deepEqual(cwdChainIn(index, "p4"), ["p4", "p1"]);
  });

  test("a pane with no anchor is just itself", () => {
    const index = buildPaneIndex(fixture(), "ws1");
    assert.deepEqual(cwdChainIn(index, "p1"), ["p1"]);
  });

  test("survives a cycle", () => {
    const index = buildPaneIndex(
      [
        {
          id: "w",
          title: "w",
          activeNode: "n",
          roots: [
            node("n", [
              tab(
                "t",
                {
                  kind: "split",
                  dir: "row",
                  children: [leaf("a", { cwdFrom: "b" }), leaf("b", { cwdFrom: "a" })],
                },
                "a"
              ),
            ]),
          ],
        },
      ],
      "w"
    );
    assert.deepEqual(cwdChainIn(index, "a"), ["a", "b"]);
  });

  test("respects the hop limit", () => {
    const ids = ["c0", "c1", "c2", "c3"];
    const index = buildPaneIndex(
      [
        {
          id: "w",
          title: "w",
          activeNode: "n",
          roots: [
            node("n", [
              tab(
                "t",
                {
                  kind: "split",
                  dir: "row",
                  children: ids.map((id, i) =>
                    leaf(id, i + 1 < ids.length ? { cwdFrom: ids[i + 1] } : {})
                  ),
                },
                "c0"
              ),
            ]),
          ],
        },
      ],
      "w"
    );
    assert.deepEqual(cwdChainIn(index, "c0", 2), ["c0", "c1"]);
  });

  test("an unknown pane id yields just that id", () => {
    assert.deepEqual(cwdChainIn(buildPaneIndex(fixture(), "ws1"), "ghost"), ["ghost"]);
  });

  /** The store walks live state and the control client walks a flat index; both
   *  go through this one lookup form so the two can't drift apart. */
  test("drives off any anchor lookup, not just a pane index", () => {
    const anchors: Record<string, string> = { a: "b", b: "c" };
    assert.deepEqual(cwdChain((id) => anchors[id], "a"), ["a", "b", "c"]);
  });
});
