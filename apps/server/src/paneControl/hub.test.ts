import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ControlError } from "@termany/core";
import { ControlHub, type HostConnection } from "./hub.js";
import type { PaneRecord } from "./selectors.js";

/** A renderer stand-in that records what the server sent it. */
function fakeHost() {
  const sent: any[] = [];
  let closed = false;
  const conn: HostConnection = {
    send: (payload) => sent.push(JSON.parse(payload)),
    close: () => {
      closed = true;
    },
  };
  return { conn, sent, get closed() { return closed; } };
}

const pane = (paneId: string, over: Partial<PaneRecord> = {}): PaneRecord => ({
  paneId,
  title: paneId,
  view: "terminal",
  path: `ws / page / tab / ${paneId}`,
  workspaceId: "ws1",
  nodeId: "n1",
  tabId: "t1",
  index: 1,
  focused: false,
  active: false,
  ...over,
});

const isError = (x: unknown): x is ControlError =>
  typeof x === "object" && x !== null && "code" in x;

describe("ControlHub — pane reporting", () => {
  test("no hosts means no panes", () => {
    const hub = new ControlHub();
    assert.deepEqual(hub.panes(), []);
    assert.equal(hub.hostCount, 0);
  });

  test("a host's reported panes become visible", () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    assert.deepEqual(hub.panes().map((p) => p.paneId), ["a"]);
  });

  test("a later report replaces the earlier one", () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("b")] }));
    assert.deepEqual(hub.panes().map((p) => p.paneId), ["b"]);
  });

  test("two windows both contribute, and each pane routes to its own", () => {
    const hub = new ControlHub();
    const one = fakeHost();
    const two = fakeHost();
    const a = hub.attach(one.conn);
    const b = hub.attach(two.conn);
    hub.handleMessage(a.hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    hub.handleMessage(b.hostId, JSON.stringify({ type: "panes", panes: [pane("b")] }));

    assert.deepEqual(hub.panes().map((p) => p.paneId).sort(), ["a", "b"]);
    assert.equal(hub.hostFor("a"), a.hostId);
    assert.equal(hub.hostFor("b"), b.hostId);
    assert.equal(hub.hostFor("nope"), undefined);
  });

  test("detaching drops that host's panes and leaves the other's", () => {
    const hub = new ControlHub();
    const one = fakeHost();
    const two = fakeHost();
    const a = hub.attach(one.conn);
    const b = hub.attach(two.conn);
    hub.handleMessage(a.hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    hub.handleMessage(b.hostId, JSON.stringify({ type: "panes", panes: [pane("b")] }));
    a.detach();
    assert.deepEqual(hub.panes().map((p) => p.paneId), ["b"]);
  });

  test("garbage frames are ignored rather than thrown", () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, "not json");
    hub.handleMessage(hostId, "null");
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: "nope" }));
    hub.handleMessage(hostId, JSON.stringify({ type: "unknown" }));
    assert.deepEqual(hub.panes(), []);
  });

  test("a message from an unknown host is ignored", () => {
    const hub = new ControlHub();
    hub.handleMessage(999, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    assert.deepEqual(hub.panes(), []);
  });

  test("the pane count one host may claim is capped", () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    const many = Array.from({ length: 900 }, (_, i) => pane(`p${i}`));
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: many }));
    assert.equal(hub.panes().length, 512);
  });
});

describe("ControlHub — request and reply", () => {
  test("a reply resolves the matching request", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));

    const inflight = hub.request("a", "pane.describe", { x: 1 });
    assert.equal(host.sent.length, 1);
    assert.equal(host.sent[0].method, "pane.describe");
    assert.deepEqual(host.sent[0].params, { x: 1 });

    hub.handleMessage(
      hostId,
      JSON.stringify({ type: "reply", id: host.sent[0].id, ok: true, result: { done: true } })
    );
    assert.deepEqual(await inflight, { done: true });
  });

  test("an error reply comes back as the ControlError", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));

    const inflight = hub.request("a", "web.eval", {});
    hub.handleMessage(
      hostId,
      JSON.stringify({
        type: "reply",
        id: host.sent[0].id,
        ok: false,
        error: { code: "E_UNSUPPORTED", message: "not a web pane" },
      })
    );
    const out = await inflight;
    assert.ok(isError(out));
    assert.equal(out.code, "E_UNSUPPORTED");
  });

  test("concurrent requests stay correlated, whatever order they answer in", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a"), pane("b")] }));

    const first = hub.request("a", "one", {});
    const second = hub.request("b", "two", {});
    const [idA, idB] = host.sent.map((f) => f.id);
    assert.notEqual(idA, idB, "each request gets its own id");

    // Answer out of order on purpose.
    hub.handleMessage(hostId, JSON.stringify({ type: "reply", id: idB, ok: true, result: "B" }));
    hub.handleMessage(hostId, JSON.stringify({ type: "reply", id: idA, ok: true, result: "A" }));
    assert.equal(await first, "A");
    assert.equal(await second, "B");
  });

  test("a duplicate or late reply is ignored", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));

    const inflight = hub.request("a", "one", {});
    const id = host.sent[0].id;
    hub.handleMessage(hostId, JSON.stringify({ type: "reply", id, ok: true, result: "first" }));
    hub.handleMessage(hostId, JSON.stringify({ type: "reply", id, ok: true, result: "second" }));
    assert.equal(await inflight, "first");
    assert.equal(hub.pendingCount, 0);
  });

  /** One window must not be able to answer for another's pane. */
  test("a reply from the wrong host is ignored", async () => {
    const hub = new ControlHub();
    const one = fakeHost();
    const two = fakeHost();
    const a = hub.attach(one.conn);
    const b = hub.attach(two.conn);
    hub.handleMessage(a.hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    hub.handleMessage(b.hostId, JSON.stringify({ type: "panes", panes: [pane("b")] }));

    const inflight = hub.request("a", "one", {}, 50);
    const id = one.sent[0].id;
    hub.handleMessage(b.hostId, JSON.stringify({ type: "reply", id, ok: true, result: "spoofed" }));

    const out = await inflight;
    assert.ok(isError(out), "the impostor reply did not settle it");
    assert.equal(out.code, "E_TIMEOUT");
  });

  test("no window connected is E_NO_HOST", async () => {
    const hub = new ControlHub();
    const out = await hub.request("a", "one", {});
    assert.ok(isError(out));
    assert.equal(out.code, "E_NO_HOST");
  });

  /** A window IS connected, it just doesn't have that pane — a different problem
   *  from having no window at all, and worth a different code. */
  test("a connected window without that pane is E_PANE_NOT_MOUNTED", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    const out = await hub.request("missing", "one", {});
    assert.ok(isError(out));
    assert.equal(out.code, "E_PANE_NOT_MOUNTED");
  });

  test("silence times out instead of hanging", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    const out = await hub.request("a", "one", {}, 20);
    assert.ok(isError(out));
    assert.equal(out.code, "E_TIMEOUT");
    assert.match(out.message, /20ms/);
    assert.equal(hub.pendingCount, 0, "the pending entry is cleaned up");
  });

  /** Disconnect is a more precise signal than waiting out the timeout. */
  test("a disconnect fails everything in flight for that host at once", async () => {
    const hub = new ControlHub();
    const host = fakeHost();
    const { hostId, detach } = hub.attach(host.conn);
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));

    const first = hub.request("a", "one", {}, 60_000);
    const second = hub.request("a", "two", {}, 60_000);
    detach();

    for (const out of [await first, await second]) {
      assert.ok(isError(out));
      assert.equal(out.code, "E_NO_HOST");
      assert.match(out.message, /disconnected/);
    }
    assert.equal(hub.pendingCount, 0);
  });

  test("a send that throws resolves rather than escaping", async () => {
    const hub = new ControlHub();
    const { hostId } = hub.attach({
      send: () => {
        throw new Error("socket already closed");
      },
      close: () => {},
    });
    hub.handleMessage(hostId, JSON.stringify({ type: "panes", panes: [pane("a")] }));
    const out = await hub.request("a", "one", {});
    assert.ok(isError(out));
    assert.equal(out.code, "E_NO_HOST");
    assert.match(out.message, /socket already closed/);
    assert.equal(hub.pendingCount, 0);
  });
});
