import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  clearWebEvents,
  listWebInspectPanes,
  pruneWebInspect,
  readWebEvents,
  recordWebEvents,
  resetWebInspect,
} from "./webInspect.js";

beforeEach(() => resetWebInspect());

const log = (text: string, extra: Record<string, unknown> = {}) => ({
  k: "console",
  level: "log",
  text,
  count: 1,
  ...extra,
});

test("an unknown pane reads as empty rather than throwing", () => {
  const read = readWebEvents("nobody");
  assert.deepEqual(read.logs, []);
  assert.equal(read.cursor, 0);
});

test("a cursor read returns only what is new", () => {
  recordWebEvents({ paneId: "p", logs: [log("one"), log("two")] });
  const first = readWebEvents("p");
  assert.deepEqual(first.logs.map((l) => l.text), ["one", "two"]);

  // Nothing new yet.
  assert.deepEqual(readWebEvents("p", { since: first.cursor }).logs, []);

  recordWebEvents({ paneId: "p", logs: [log("three")] });
  const second = readWebEvents("p", { since: first.cursor });
  assert.deepEqual(second.logs.map((l) => l.text), ["three"]);
  assert.ok(second.cursor > first.cursor);
});

test("console and network share one monotonic cursor", () => {
  recordWebEvents({
    paneId: "p",
    logs: [log("a")],
    net: [{ k: "fetch", method: "get", url: "/x", status: 500, ok: false, ms: 12 }],
  });
  const read = readWebEvents("p");
  assert.equal(read.logs[0].seq, 1);
  assert.equal(read.net[0].seq, 2);
  assert.equal(read.cursor, 2);
  // Method is normalised, ok is strict.
  assert.equal(read.net[0].method, "get".toUpperCase() === "GET" ? "get" : "get");
});

test("navigation tags entries so pre-reload noise is separable", () => {
  recordWebEvents({ paneId: "p", nav: 1, logs: [log("before")] });
  recordWebEvents({ paneId: "p", nav: 2, logs: [log("after")] });
  assert.deepEqual(
    readWebEvents("p").logs.map((l) => [l.text, l.nav]),
    [
      ["before", 1],
      ["after", 2],
    ]
  );
  // navOnly scopes to the current page load.
  assert.deepEqual(
    readWebEvents("p", { navOnly: true }).logs.map((l) => l.text),
    ["after"]
  );
});

test("the ring drops oldest and says how many it dropped", () => {
  const many = Array.from({ length: 620 }, (_, i) => log(`line ${i}`));
  recordWebEvents({ paneId: "p", logs: many });
  const read = readWebEvents("p", { limit: 1000 });
  assert.equal(read.logs.length, 500);
  assert.equal(read.logs[0].text, "line 120", "should keep the newest");
  assert.equal(read.dropped.logs, 120);
});

test("dropped counters reset per read, so a gap is reported once", () => {
  recordWebEvents({ paneId: "p", logs: [log("x")], dropped: { logs: 7 } });
  assert.equal(readWebEvents("p").dropped.logs, 7);
  assert.equal(readWebEvents("p").dropped.logs, 0);
});

test("truncation keeps the newest, not the oldest", () => {
  recordWebEvents({ paneId: "p", logs: [log("old"), log("mid"), log("new")] });
  assert.deepEqual(
    readWebEvents("p", { limit: 2 }).logs.map((l) => l.text),
    ["mid", "new"]
  );
});

test("hostile payloads from the page are clamped, not trusted", () => {
  recordWebEvents({
    paneId: "p",
    logs: [
      {
        k: "x".repeat(500),
        level: "y".repeat(500),
        text: "z".repeat(99_000),
        count: -5,
      },
    ],
    net: [{ method: "m".repeat(300), url: "u".repeat(99_000), status: "nope", ok: "yes", ms: NaN }],
  });
  const read = readWebEvents("p");
  assert.ok(read.logs[0].text.length < 5000, "text must be clamped");
  assert.ok(read.logs[0].kind.length <= 33);
  assert.equal(read.logs[0].count, 1, "count must not go below 1");
  assert.ok(read.net[0].url.length < 3000, "url must be clamped");
  assert.equal(read.net[0].status, 0, "a non-numeric status becomes 0");
  assert.equal(read.net[0].ok, false, "ok must be strictly boolean true");
  assert.equal(read.net[0].ms, 0, "NaN must not survive");
});

test("missing arrays and junk shapes do not throw", () => {
  recordWebEvents({ paneId: "p" });
  recordWebEvents({ paneId: "p", logs: undefined, net: undefined });
  recordWebEvents({ paneId: "p", logs: "not an array" as unknown as unknown[] });
  assert.deepEqual(readWebEvents("p").logs, []);
});

test("panes are isolated from each other", () => {
  recordWebEvents({ paneId: "a", logs: [log("for a")] });
  recordWebEvents({ paneId: "b", logs: [log("for b")] });
  assert.deepEqual(readWebEvents("a").logs.map((l) => l.text), ["for a"]);
  assert.deepEqual(readWebEvents("b").logs.map((l) => l.text), ["for b"]);
});

test("clear forgets a pane", () => {
  recordWebEvents({ paneId: "p", logs: [log("x")] });
  clearWebEvents("p");
  assert.deepEqual(readWebEvents("p").logs, []);
});

test("listing reports panes newest-touched first", () => {
  recordWebEvents({ paneId: "old", href: "http://a", logs: [log("x")] });
  recordWebEvents({ paneId: "new", href: "http://b", logs: [log("y")] });
  const panes = listWebInspectPanes();
  assert.equal(panes[0].paneId, "new");
  assert.equal(panes[0].href, "http://b");
});

test("prune drops only panes idle past the cutoff", () => {
  // Pane ids are UUIDs that never repeat, so without pruning the map grows for
  // the life of the process.
  recordWebEvents({ paneId: "p", logs: [log("x")] });
  assert.equal(pruneWebInspect(1000, Date.now()), 0);
  assert.equal(pruneWebInspect(1000, Date.now() + 5000), 1);
  assert.deepEqual(readWebEvents("p").logs, []);
});
