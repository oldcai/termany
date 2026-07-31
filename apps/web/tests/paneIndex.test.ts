import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  controlPaneIndex,
  indexFingerprint,
  paneHasTerminal,
  resetPaneIndexOrder,
} from "../src/control/paneIndex.js";
import type { HTab, Pane, TreeNode, Workspace } from "../src/state/paneTree.js";

const leaf = (id: string, extra: Partial<Pane & { kind: "leaf" }> = {}): Pane => ({
  kind: "leaf",
  id,
  title: id,
  ...extra,
});

const tab = (id: string, layout: Pane, focused: string): HTab => ({
  id,
  title: id,
  layout,
  focused,
});

const node = (id: string, htabs: HTab[], children: TreeNode[] = []): TreeNode => ({
  id,
  title: id,
  expanded: true,
  children,
  htabs,
  activeHTab: htabs[0].id,
});

const sessionIdFor = (paneId: string, sshTarget?: string) =>
  sshTarget ? `${paneId}:ssh:${encodeURIComponent(sshTarget)}` : paneId;

function build(workspaces: Workspace[], activeWorkspace = "ws1") {
  return controlPaneIndex({
    workspaces,
    activeWorkspace,
    sessionIdFor,
    hasTerminal: paneHasTerminal,
  });
}

function fixture(): Workspace[] {
  return [
    {
      id: "ws1",
      title: "ws 1",
      activeNode: "n1",
      roots: [
        node("n1", [
          tab(
            "t1",
            {
              kind: "split",
              dir: "row",
              children: [
                leaf("shell"),
                leaf("browser", { view: "web", cwdFrom: "shell" }),
                leaf("box", { sshTarget: "user@host" }),
              ],
            },
            "shell"
          ),
        ]),
      ],
    },
  ];
}

describe("controlPaneIndex", () => {
  beforeEach(resetPaneIndexOrder);

  test("carries the layout facts the server cannot work out itself", () => {
    const [shell] = build(fixture());
    assert.equal(shell.paneId, "shell");
    assert.equal(shell.title, "shell");
    assert.equal(shell.view, "terminal");
    assert.equal(shell.path, "ws 1 / n1 / t1 / shell");
    assert.equal(shell.tabId, "t1");
    assert.equal(shell.index, 1);
    assert.equal(shell.focused, true);
    assert.equal(shell.active, true);
  });

  /** R8: an SSH pane's ring is not its pane id, and conflating them makes an
   *  agent read the wrong scrollback. */
  test("an SSH pane reports its own session id, not its pane id", () => {
    const box = build(fixture()).find((p) => p.paneId === "box")!;
    assert.equal(box.terminalSessionId, "box:ssh:user%40host");
  });

  test("a plain terminal's session id is its pane id", () => {
    const shell = build(fixture()).find((p) => p.paneId === "shell")!;
    assert.equal(shell.terminalSessionId, "shell");
  });

  test("a shell-less pane reports no session id at all", () => {
    const browser = build(fixture()).find((p) => p.paneId === "browser")!;
    assert.equal(browser.terminalSessionId, undefined);
  });

  test("the cwd chain follows the anchor", () => {
    const browser = build(fixture()).find((p) => p.paneId === "browser")!;
    assert.deepEqual(browser.cwdChain, ["browser", "shell"]);
  });

  test("open order is assigned once and stays put", () => {
    const first = build(fixture());
    const again = build(fixture());
    assert.deepEqual(
      first.map((p) => p.seq),
      again.map((p) => p.seq),
      "a re-walk does not renumber"
    );
  });

  test("a pane added later ranks after the ones already seen", () => {
    build(fixture());
    const grown = fixture();
    const root = grown[0].roots[0].htabs[0].layout as Extract<Pane, { kind: "split" }>;
    root.children.push(leaf("newcomer"));
    const after = build(grown);
    const max = Math.max(...after.filter((p) => p.paneId !== "newcomer").map((p) => p.seq));
    assert.ok(after.find((p) => p.paneId === "newcomer")!.seq > max);
  });
});

describe("paneHasTerminal", () => {
  test("terminal panes do", () => {
    assert.equal(paneHasTerminal("terminal"), true);
  });

  test("shell-less views do not", () => {
    for (const view of ["files", "git", "agent", "web", "monitor"] as const) {
      assert.equal(paneHasTerminal(view), false, view);
    }
  });

  /** An SSH pane keeps its shell whatever the body is currently showing. */
  test("an SSH target means a terminal regardless of view", () => {
    assert.equal(paneHasTerminal("web", "user@host"), true);
  });
});

describe("indexFingerprint", () => {
  beforeEach(resetPaneIndexOrder);

  test("is stable for an unchanged layout", () => {
    assert.equal(indexFingerprint(build(fixture())), indexFingerprint(build(fixture())));
  });

  test("changes when a title changes", () => {
    const before = indexFingerprint(build(fixture()));
    const renamed = fixture();
    const root = renamed[0].roots[0].htabs[0].layout as Extract<Pane, { kind: "split" }>;
    (root.children[0] as Extract<Pane, { kind: "leaf" }>).title = "renamed";
    assert.notEqual(indexFingerprint(build(renamed)), before);
  });

  test("changes when focus moves", () => {
    const before = indexFingerprint(build(fixture()));
    const moved = fixture();
    moved[0].roots[0].htabs[0].focused = "browser";
    assert.notEqual(indexFingerprint(build(moved)), before);
  });

  test("changes when the active workspace changes", () => {
    const before = indexFingerprint(build(fixture(), "ws1"));
    assert.notEqual(indexFingerprint(build(fixture(), "other")), before);
  });
});
