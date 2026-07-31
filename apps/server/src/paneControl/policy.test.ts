import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { decide, isDisabled, type PolicyRequest, tierFor } from "./policy.js";
import { AuditRing } from "./rings.js";

const req = (over: Partial<PolicyRequest> = {}): PolicyRequest => ({
  operation: "write",
  crossProject: false,
  method: "term.send",
  callerPath: "ws 1 / page 1 / tab 1 / agent",
  targetPath: "ws 1 / page 1 / tab 1 / shell",
  ...over,
});

describe("decide — the default is ask", () => {
  test("an unset mode behaves as ask", () => {
    assert.equal(decide(req({ mode: undefined })).kind, "ask");
  });

  test("in-project reads go through without prompting", () => {
    assert.equal(decide(req({ mode: "ask", operation: "read" })).kind, "allow");
  });

  test("in-project writes prompt", () => {
    const d = decide(req({ mode: "ask", operation: "write" }));
    assert.equal(d.kind, "ask");
    assert.match(d.kind === "ask" ? d.prompt : "", /term\.send/);
  });
});

describe("decide — off is absolute", () => {
  test("reads are denied", () => {
    assert.equal(decide(req({ mode: "off", operation: "read" })).kind, "deny");
  });

  test("writes are denied", () => {
    assert.equal(decide(req({ mode: "off", operation: "write" })).kind, "deny");
  });

  /** No consent path at all: a user who flipped this off wants the surface gone,
   *  not gone-unless-asked-nicely. */
  test("there is no prompt to say yes to", () => {
    const d = decide(req({ mode: "off", crossProject: true }));
    assert.equal(d.kind, "deny");
    assert.match(d.kind === "deny" ? d.message : "", /turned off/);
  });

  test("isDisabled agrees, and defaults to enabled", () => {
    assert.equal(isDisabled("off"), true);
    assert.equal(isDisabled("ask"), false);
    assert.equal(isDisabled(undefined), false);
  });
});

describe("decide — crossing a project boundary", () => {
  test("prompts even in allow-project", () => {
    const d = decide(req({ mode: "allow-project", crossProject: true }));
    assert.equal(d.kind, "ask");
    assert.match(d.kind === "ask" ? d.prompt : "", /outside its project/);
  });

  /**
   * D11 makes cross-project WRITES unconditional prompts. Reads are not gated:
   * a caller that explicitly asked for scope "global" has to be able to see what
   * is out there or the scope means nothing — the plan's own acceptance test is
   * "global can see project B's panes, but writing to them triggers consent".
   */
  test("reads across the boundary are allowed, so global discovery works", () => {
    assert.equal(decide(req({ mode: "ask", operation: "read", crossProject: true })).kind, "allow");
  });

  test("writes across the boundary prompt even under allow-project", () => {
    assert.equal(
      decide(req({ mode: "allow-project", operation: "write", crossProject: true })).kind,
      "ask"
    );
  });

  test("only an explicit allow-all skips the prompt", () => {
    assert.equal(decide(req({ mode: "allow-all", crossProject: true })).kind, "allow");
  });
});

describe("decide — allow-project", () => {
  test("in-project writes stop prompting", () => {
    assert.equal(decide(req({ mode: "allow-project", operation: "write" })).kind, "allow");
  });
});

describe("tierFor", () => {
  test("mirrors the operation inside a project", () => {
    assert.equal(tierFor("read", false), "read");
    assert.equal(tierFor("write", false), "write");
  });

  test("crossing the boundary outranks the operation kind", () => {
    assert.equal(tierFor("read", true), "cross-project");
    assert.equal(tierFor("write", true), "cross-project");
  });
});

describe("AuditRing", () => {
  const entry = (over: Partial<Parameters<AuditRing["record"]>[0]> = {}) => ({
    method: "term.send",
    tier: "write" as const,
    outcome: "allowed" as const,
    callerPaneId: "p1",
    callerPath: "a",
    ...over,
  });

  test("assigns monotonic sequence numbers", () => {
    const ring = new AuditRing();
    assert.equal(ring.record(entry()).seq, 1);
    assert.equal(ring.record(entry()).seq, 2);
  });

  test("reads only what is new", () => {
    const ring = new AuditRing();
    ring.record(entry());
    const first = ring.read();
    assert.equal(first.entries.length, 1);
    assert.equal(ring.read(first.cursor).entries.length, 0, "nothing new since the cursor");
  });

  /** Denials are the entries most worth having, so they are recorded too. */
  test("records denials and consent refusals, not just successes", () => {
    const ring = new AuditRing();
    ring.record(entry({ outcome: "denied", detail: "E_FORBIDDEN" }));
    ring.record(entry({ outcome: "asked-denied" }));
    assert.deepEqual(ring.read().entries.map((e) => e.outcome), ["denied", "asked-denied"]);
  });

  test("drops oldest past capacity and counts the loss", () => {
    const ring = new AuditRing(3);
    for (let i = 0; i < 5; i++) ring.record(entry());
    const out = ring.read();
    assert.equal(ring.size, 3);
    assert.deepEqual(out.entries.map((e) => e.seq), [3, 4, 5]);
    assert.equal(out.dropped, 2);
  });

  /** A reader that keeps up sees zero; a non-zero value means a real gap. The
   *  gap belongs to the reader's own cursor, so a second poll of this
   *  un-gated endpoint cannot consume the app's evidence that it missed some. */
  test("the drop count follows the reader's cursor and survives another read", () => {
    const ring = new AuditRing(2);
    for (let i = 0; i < 4; i++) ring.record(entry());
    const first = ring.read();
    assert.equal(first.dropped, 2);
    assert.equal(ring.read().dropped, 2, "another reader's poll does not clear the gap");
    assert.equal(ring.read(first.cursor).dropped, 0, "a reader that kept up has no gap");
  });

  /** Truncation must not skip past unread entries: a reader following `cursor`
   *  would never be able to go back for them. */
  test("an over-limit read returns the oldest unread entries, not the newest", () => {
    const ring = new AuditRing(10);
    for (let i = 0; i < 6; i++) ring.record(entry());
    const first = ring.read(0, 2);
    assert.deepEqual(first.entries.map((e) => e.seq), [1, 2]);
    assert.equal(first.cursor, 2, "the cursor is what was actually handed over");
    assert.deepEqual(ring.read(first.cursor, 2).entries.map((e) => e.seq), [3, 4]);
  });

  test("sequence numbers are not reused after a drop", () => {
    const ring = new AuditRing(2);
    for (let i = 0; i < 4; i++) ring.record(entry());
    assert.equal(ring.record(entry()).seq, 5);
  });

  test("an empty ring reports the caller's own cursor back", () => {
    assert.deepEqual(new AuditRing().read(7), { entries: [], dropped: 0, cursor: 7 });
  });
});
