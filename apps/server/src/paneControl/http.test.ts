import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PolicyMode } from "@termany/core";
import { dispatch, type DispatchDeps, statusForError } from "./http.js";
import { ControlHub } from "./hub.js";
import { IdentityRegistry } from "./identity.js";
import { AuditRing } from "./rings.js";
import type { PaneRecord } from "./selectors.js";

const pane = (paneId: string, over: Partial<PaneRecord> = {}): PaneRecord => ({
  paneId,
  title: paneId,
  view: "terminal",
  path: `ws 1 / page 1 / tab 1 / ${paneId}`,
  workspaceId: "ws1",
  nodeId: "n1",
  tabId: "t1",
  index: 1,
  focused: false,
  active: false,
  cwd: "/repo/app",
  ...over,
});

/**
 * A whole control stack with a stubbed renderer. `cwds` decides what directory
 * each pane resolves to, which is what drives project scoping.
 */
function harness(
  panes: PaneRecord[],
  opts: { mode?: PolicyMode; consent?: boolean; repos?: string[] } = {}
) {
  const hub = new ControlHub();
  const identity = new IdentityRegistry();
  const audit = new AuditRing();
  const consentPrompts: string[] = [];

  const { hostId } = hub.attach({ send: () => {}, close: () => {} });
  hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes }));

  const repos = opts.repos ?? ["/repo"];
  const deps: DispatchDeps = {
    hub,
    identity,
    audit,
    policyMode: () => opts.mode ?? "ask",
    cwdForPane: async (p) => p.cwd,
    projectRootFor: (cwd) => repos.find((r) => cwd === r || cwd.startsWith(`${r}/`)) ?? cwd,
    requestConsent: async (prompt) => {
      consentPrompts.push(prompt);
      return opts.consent ?? false;
    },
  };
  return { deps, audit, identity, consentPrompts, hub };
}

const callerOf = (paneId: string) => ({
  paneId,
  source: "env" as const,
  issuedAt: 0,
});

/** The world used by most tests: caller + a sibling web pane in /repo, plus a
 *  pane belonging to an unrelated checkout. */
function world() {
  return [
    pane("caller", { index: 1, focused: true, active: true }),
    pane("web", { index: 2, view: "web", title: "docs", active: true }),
    pane("outsider", {
      tabId: "t9",
      workspaceId: "ws2",
      nodeId: "n2",
      view: "web",
      title: "other docs",
      cwd: "/elsewhere/src",
      path: "ws 2 / page 2 / tab 1 / outsider",
    }),
  ];
}

describe("dispatch — plumbing", () => {
  test("an unknown method is E_UNSUPPORTED", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "nope.nope", {});
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "E_UNSUPPORTED");
  });

  test("no connected window is E_NO_HOST", async () => {
    const { deps } = harness([]);
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", {});
    assert.equal(out.error.code, "E_NO_HOST");
  });

  /** A valid token whose pane has since closed. Distinct from "who are you". */
  test("a valid token for a vanished pane is E_PANE_NOT_MOUNTED", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("ghost"), "panes.list", {});
    assert.equal(out.error.code, "E_PANE_NOT_MOUNTED");
  });
});

describe("dispatch — session.whoami", () => {
  test("reports the caller's own pane and project", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "session.whoami", {});
    assert.equal(out.ok, true);
    assert.equal(out.paneId, "caller");
    assert.equal(out.path, "ws 1 / page 1 / tab 1 / caller");
    assert.equal(out.cwd, "/repo/app");
  });

  /** D11: the caller should be able to see how confined it is without guessing. */
  test("project.root is the nearest repo and paneCount counts only that project", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "session.whoami", {});
    assert.equal(out.project.root, "/repo");
    assert.equal(out.project.paneCount, 2, "caller and web, not the outsider");
  });

  test("the default scope it advertises is project, not global", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "session.whoami", {});
    assert.equal(out.defaultScope, "project");
  });

  test("a pane with no resolvable directory says so rather than inventing a root", async () => {
    const panes = [pane("caller", { cwd: undefined })];
    const { deps } = harness(panes);
    const out: any = await dispatch(deps, callerOf("caller"), "session.whoami", {});
    assert.equal(out.project.root, "");
    assert.equal(out.project.paneCount, 0);
  });

  test("exposes the terminal session id separately from the pane id", async () => {
    const panes = [pane("caller", { terminalSessionId: "caller:ssh:box" })];
    const { deps } = harness(panes);
    const out: any = await dispatch(deps, callerOf("caller"), "session.whoami", {});
    assert.equal(out.paneId, "caller");
    assert.equal(out.terminalSessionId, "caller:ssh:box");
  });
});

describe("dispatch — panes.list", () => {
  /** The headline D11 behaviour: another project's panes are simply not there. */
  test("defaults to the caller's project only", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", {});
    assert.equal(out.scope, "project");
    assert.deepEqual(out.panes.map((p: any) => p.paneId), ["caller", "web"]);
  });

  test("global scope reveals the other project", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", { scope: "global" });
    assert.deepEqual(out.panes.map((p: any) => p.paneId), ["caller", "web", "outsider"]);
  });

  /** Discovery across the boundary must not prompt, or scope:"global" would be
   *  useless — it's writing out there that costs consent. */
  test("global listing does not ask for consent", async () => {
    const { deps, consentPrompts } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", { scope: "global" });
    assert.equal(out.ok, true);
    assert.deepEqual(consentPrompts, []);
  });

  test("tab scope narrows to the caller's own tab", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", { scope: "tab" });
    assert.deepEqual(out.panes.map((p: any) => p.paneId), ["caller", "web"]);
  });

  test("a nonsense scope falls back to the default rather than erroring", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", { scope: "banana" });
    assert.equal(out.scope, "project");
  });

  test("policy off blocks even a read", async () => {
    const { deps } = harness(world(), { mode: "off" });
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", {});
    assert.equal(out.error.code, "E_FORBIDDEN");
  });

  test("each pane carries its resolved project root", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.list", { scope: "global" });
    const byId = Object.fromEntries(out.panes.map((p: any) => [p.paneId, p]));
    assert.equal(byId.web.projectRoot, "/repo");
    assert.equal(byId.outsider.projectRoot, "/elsewhere/src");
  });
});

describe("dispatch — panes.resolve", () => {
  test("a missing target is rejected", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.resolve", {});
    assert.equal(out.error.code, "E_NO_MATCH");
  });

  test("resolves a sibling and returns the resolved envelope", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.resolve", {
      target: { sibling: { view: "web" } },
    });
    assert.equal(out.ok, true);
    assert.equal(out.resolved.paneId, "web");
    assert.equal(out.resolved.path, "ws 1 / page 1 / tab 1 / web");
    assert.equal(out.resolved.view, "web");
  });

  test("an ambiguous selector comes back with candidates", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.resolve", {
      target: { view: "web" },
      scope: "global",
    });
    assert.equal(out.error.code, "E_AMBIGUOUS");
    assert.deepEqual(out.error.candidates.map((c: any) => c.paneId).sort(), ["outsider", "web"]);
  });

  test("the other project's pane is invisible at the default scope", async () => {
    const { deps } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.resolve", {
      target: "outsider",
    });
    assert.equal(out.error.code, "E_NO_MATCH");
  });

  test("resolving in-project needs no consent", async () => {
    const { deps, consentPrompts } = harness(world());
    const out: any = await dispatch(deps, callerOf("caller"), "panes.resolve", { target: "web" });
    assert.equal(out.ok, true);
    assert.deepEqual(consentPrompts, []);
  });

  test("self always resolves, even with no directory at all", async () => {
    const { deps } = harness([pane("caller", { cwd: undefined })]);
    const out: any = await dispatch(deps, callerOf("caller"), "panes.resolve", { target: "self" });
    assert.equal(out.ok, true);
    assert.equal(out.resolved.paneId, "caller");
  });
});

describe("dispatch — audit trail", () => {
  test("a successful call is recorded with who and what", async () => {
    const { deps, audit } = harness(world());
    await dispatch(deps, callerOf("caller"), "panes.resolve", { target: "web" });
    const [entry] = audit.read().entries;
    assert.equal(entry.method, "panes.resolve");
    assert.equal(entry.outcome, "allowed");
    assert.equal(entry.callerPaneId, "caller");
    assert.equal(entry.targetPaneId, "web");
    assert.equal(entry.tier, "read");
  });

  /** The blocked calls are the ones worth being able to read about afterwards. */
  test("a policy denial is recorded", async () => {
    const { deps, audit } = harness(world(), { mode: "off" });
    await dispatch(deps, callerOf("caller"), "panes.list", {});
    const [entry] = audit.read().entries;
    assert.equal(entry.outcome, "denied");
    assert.equal(entry.detail, "E_FORBIDDEN");
  });

  test("a failed resolution is recorded with its error code", async () => {
    const { deps, audit } = harness(world());
    await dispatch(deps, callerOf("caller"), "panes.resolve", { target: { view: "monitor" } });
    const [entry] = audit.read().entries;
    assert.equal(entry.outcome, "error");
    assert.equal(entry.detail, "E_NO_MATCH");
  });

  test("an unknown method never reaches the audit ring", async () => {
    const { deps, audit } = harness(world());
    await dispatch(deps, callerOf("caller"), "nope", {});
    assert.equal(audit.size, 0);
  });
});

describe("statusForError", () => {
  test("maps each code to a status a client can act on", () => {
    assert.equal(statusForError("E_FORBIDDEN"), 403);
    assert.equal(statusForError("E_CONSENT_DENIED"), 403);
    assert.equal(statusForError("E_NO_MATCH"), 404);
    assert.equal(statusForError("E_PANE_NOT_MOUNTED"), 404);
    assert.equal(statusForError("E_AMBIGUOUS"), 409);
    assert.equal(statusForError("E_UNSUPPORTED"), 400);
    assert.equal(statusForError("E_NO_HOST"), 503);
    assert.equal(statusForError("E_TIMEOUT"), 504);
  });
});
