import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlError, PaneView } from "@termany/core";
import {
  effectiveScope,
  inScope,
  isControlError,
  listInScope,
  type PaneRecord,
  resolveTarget,
} from "./selectors.js";

let seq = 0;

function pane(paneId: string, over: Partial<PaneRecord> = {}): PaneRecord {
  seq += 1;
  return {
    paneId,
    title: paneId,
    view: "terminal" as PaneView,
    path: `ws / page / tab / ${paneId}`,
    workspaceId: "ws1",
    nodeId: "n1",
    tabId: "t1",
    index: 1,
    focused: false,
    active: false,
    cwd: "/repo/app",
    projectRoot: "/repo",
    seq,
    ...over,
  };
}

/**
 * The caller sits in tab t1 of project /repo. Around it: a same-tab web pane, a
 * background tab in the same project, and a whole other project — the three
 * things scoping has to keep straight.
 */
function world() {
  const caller = pane("caller", { index: 1, focused: true, active: true });
  const webSibling = pane("web-sib", { view: "web", index: 2, active: true, title: "docs" });
  const bgTerm = pane("bg-term", { tabId: "t2", index: 1, focused: true, title: "server" });
  const bgWeb = pane("bg-web", { tabId: "t2", index: 2, view: "web", title: "preview" });
  const otherProject = pane("other", {
    workspaceId: "ws2",
    nodeId: "n2",
    tabId: "t9",
    cwd: "/elsewhere/src",
    projectRoot: "/elsewhere",
    view: "web",
    title: "docs",
  });
  const noCwd = pane("orphan", {
    tabId: "t2",
    index: 3,
    cwd: undefined,
    projectRoot: undefined,
    view: "web",
  });
  return {
    caller,
    panes: [caller, webSibling, bgTerm, bgWeb, otherProject, noCwd],
  };
}

const asError = (x: PaneRecord | ControlError): ControlError => {
  assert.ok(isControlError(x), `expected an error, got pane ${JSON.stringify(x)}`);
  return x;
};

const asPane = (x: PaneRecord | ControlError): PaneRecord => {
  assert.ok(!isControlError(x), `expected a pane, got error ${JSON.stringify(x)}`);
  return x;
};

describe("effectiveScope", () => {
  test("defaults to project, not global", () => {
    assert.equal(effectiveScope({ view: "web" }), "project");
    assert.equal(effectiveScope("some-id"), "project");
  });

  test("the selector's own scope beats the request's", () => {
    assert.equal(effectiveScope({ view: "web", scope: "global" }, "tab"), "global");
  });

  test("the request's scope applies when the selector has none", () => {
    assert.equal(effectiveScope({ ref: "focused" }, "workspace"), "workspace");
  });
});

describe("inScope", () => {
  const { caller, panes } = world();
  const at = (id: string) => panes.find((p) => p.paneId === id)!;

  test("tab scope is the caller's tab only", () => {
    assert.equal(inScope(at("web-sib"), caller, "tab"), true);
    assert.equal(inScope(at("bg-term"), caller, "tab"), false);
  });

  test("page scope spans the tabs of one page", () => {
    assert.equal(inScope(at("bg-term"), caller, "page"), true);
    assert.equal(inScope(at("other"), caller, "page"), false);
  });

  test("project scope compares resolved roots, not tabs", () => {
    assert.equal(inScope(at("bg-web"), caller, "project"), true);
    assert.equal(inScope(at("other"), caller, "project"), false);
  });

  test("a pane whose cwd never resolved belongs to no project", () => {
    assert.equal(inScope(at("orphan"), caller, "project"), false);
    assert.equal(inScope(at("orphan"), caller, "global"), true, "but global still sees it");
  });

  test("global sees the other project", () => {
    assert.equal(inScope(at("other"), caller, "global"), true);
  });
});

describe("resolveTarget — bare ids and self", () => {
  test('"self" is the caller', () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, "self")).paneId, "caller");
  });

  test("a pane id inside the project resolves", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, "bg-web")).paneId, "bg-web");
  });

  /** Knowing a UUID must not be a way around project scoping. */
  test("a pane id in ANOTHER project does not resolve by default", () => {
    const { caller, panes } = world();
    const e = asError(resolveTarget(panes, caller, "other"));
    assert.equal(e.code, "E_NO_MATCH");
    assert.match(e.message, /scope:"global"/, "says how to widen");
  });

  test("the same id resolves once global scope is asked for", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, "other", { scope: "global" })).paneId, "other");
  });

  test("the not-found message does not confirm out-of-scope panes exist", () => {
    const { caller, panes } = world();
    const real = asError(resolveTarget(panes, caller, "other"));
    const fake = asError(resolveTarget(panes, caller, "no-such-pane-at-all"));
    assert.equal(
      real.message.replace("other", "X"),
      fake.message.replace("no-such-pane-at-all", "X"),
      "an existing out-of-scope pane and a made-up id read identically"
    );
  });
});

describe("resolveTarget — ambiguity is an error, never a guess", () => {
  test('view:"web" across a project lists every candidate', () => {
    const { caller, panes } = world();
    const e = asError(resolveTarget(panes, caller, { view: "web" }));
    assert.equal(e.code, "E_AMBIGUOUS");
    assert.deepEqual(e.candidates?.map((c) => c.paneId).sort(), ["bg-web", "web-sib"]);
    assert.match(e.message, /matched 2 panes/);
  });

  test("candidates carry enough to choose with", () => {
    const { caller, panes } = world();
    const e = asError(resolveTarget(panes, caller, { view: "web" }));
    const c = e.candidates!.find((x) => x.paneId === "web-sib")!;
    assert.deepEqual(c, {
      paneId: "web-sib",
      title: "docs",
      view: "web",
      path: "ws / page / tab / web-sib",
    });
  });

  test("an ambiguous title match errors rather than taking the first", () => {
    const { caller, panes } = world();
    const e = asError(resolveTarget(panes, caller, { title: "e", scope: "project" }));
    assert.equal(e.code, "E_AMBIGUOUS");
    assert.ok((e.candidates?.length ?? 0) > 1);
  });

  test("narrowing to the caller's own tab disambiguates the same request", () => {
    const { caller, panes } = world();
    const hit = asPane(resolveTarget(panes, caller, { view: "web", scope: "tab" }));
    assert.equal(hit.paneId, "web-sib");
  });

  test("the candidate list is capped and says how many were dropped", () => {
    const many = Array.from({ length: 20 }, (_, i) => pane(`w${i}`, { view: "web", index: i + 2 }));
    const caller = pane("caller", { index: 1 });
    const e = asError(resolveTarget([caller, ...many], caller, { view: "web" }));
    assert.equal(e.candidates?.length, 12);
    assert.match(e.message, /matched 20 panes/);
    assert.match(e.message, /8 more not listed/);
  });
});

describe("resolveTarget — sibling", () => {
  test("finds the web pane beside the caller", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, { sibling: { view: "web" } })).paneId, "web-sib");
  });

  test("is same-tab even when the scope is global", () => {
    const { caller, panes } = world();
    const hit = asPane(
      resolveTarget(panes, caller, { sibling: { view: "web" } }, { scope: "global" })
    );
    assert.equal(hit.paneId, "web-sib", "the other project's web pane is not a sibling");
  });

  test("never returns the caller itself", () => {
    const { caller, panes } = world();
    const e = asError(resolveTarget(panes, caller, { sibling: { view: "terminal" } }));
    assert.equal(e.code, "E_NO_MATCH", "the only terminal in this tab is the caller");
  });

  test("an empty sibling selector is rejected, not treated as 'any'", () => {
    const { caller, panes } = world();
    assert.equal(asError(resolveTarget(panes, caller, { sibling: {} })).code, "E_NO_MATCH");
  });

  test("combines view with index", () => {
    const { caller, panes } = world();
    const hit = asPane(resolveTarget(panes, caller, { sibling: { view: "web", index: 2 } }));
    assert.equal(hit.paneId, "web-sib");
  });
});

describe("resolveTarget — refs", () => {
  test("focused is the pane the user is actually on", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, { ref: "focused" })).paneId, "caller");
  });

  test("focused reports no match rather than picking a background tab's focus", () => {
    const { panes } = world();
    const blurred = panes.map((p) => ({ ...p, active: false }));
    const caller = blurred[0];
    assert.equal(asError(resolveTarget(blurred, caller, { ref: "focused" })).code, "E_NO_MATCH");
  });

  test("next and prev walk the caller's tab and wrap", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, { ref: "next" })).paneId, "web-sib");
    assert.equal(
      asPane(resolveTarget(panes, caller, { ref: "prev" })).paneId,
      "web-sib",
      "two panes, so prev wraps to the same one"
    );
  });

  test("next errors in a single-pane tab instead of returning self", () => {
    const solo = pane("solo");
    assert.equal(asError(resolveTarget([solo], solo, { ref: "next" })).code, "E_NO_MATCH");
  });

  test("last-opened takes the highest open order in scope", () => {
    const { caller, panes } = world();
    const hit = asPane(resolveTarget(panes, caller, { ref: "last-opened" }));
    assert.equal(hit.paneId, "bg-web", "orphan is later but belongs to no project");
  });

  test("last-opened ignores panes with no known open order", () => {
    const caller = pane("caller", { seq: 1 });
    const unknown = pane("unknown", { seq: undefined });
    assert.equal(
      asError(resolveTarget([caller, unknown], caller, { ref: "last-opened" })).code,
      "E_NO_MATCH"
    );
  });
});

describe("resolveTarget — index", () => {
  test("is 1-based within the caller's tab", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, { index: 2 })).paneId, "web-sib");
  });

  test("can name another tab explicitly", () => {
    const { caller, panes } = world();
    assert.equal(asPane(resolveTarget(panes, caller, { index: 1, tab: "t2" })).paneId, "bg-term");
  });

  test("out of range is a clean no-match", () => {
    const { caller, panes } = world();
    assert.equal(asError(resolveTarget(panes, caller, { index: 99 })).code, "E_NO_MATCH");
  });
});

describe("listInScope", () => {
  test("defaults to the caller's project", () => {
    const { caller, panes } = world();
    const ids = listInScope(panes, caller).map((p) => p.paneId);
    assert.deepEqual(ids, ["caller", "web-sib", "bg-term", "bg-web"]);
  });

  test("global adds the other project and the unattributable pane", () => {
    const { caller, panes } = world();
    const ids = listInScope(panes, caller, "global").map((p) => p.paneId);
    assert.deepEqual(ids, ["caller", "web-sib", "bg-term", "bg-web", "other", "orphan"]);
  });

  test("tab scope is just the caller's tab", () => {
    const { caller, panes } = world();
    assert.deepEqual(listInScope(panes, caller, "tab").map((p) => p.paneId), ["caller", "web-sib"]);
  });
});
