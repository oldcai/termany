import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_ECHO_MS, createGtkImeCommitMachine } from "./webkitGtkIme";

interface FakeEvent {
  keyCode: number;
  inputType: string;
  data: string | null;
  prevented: boolean;
  stopped: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function fakeEvent(props: Partial<Pick<FakeEvent, "keyCode" | "inputType" | "data">> = {}): FakeEvent {
  const e: FakeEvent = {
    keyCode: 0,
    inputType: "",
    data: null,
    prevented: false,
    stopped: false,
    preventDefault() {
      e.prevented = true;
    },
    stopPropagation() {
      e.stopped = true;
    },
    ...props,
  };
  return e;
}

function makeHarness() {
  const commits: string[] = [];
  let clears = 0;
  let now = 1000;
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const machine = createGtkImeCommitMachine({
    commit: (data) => commits.push(data),
    clearTextarea: () => clears++,
    setTimer: (fn) => {
      const id = nextTimer++;
      timers.set(id, fn);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    now: () => now,
  });
  return {
    machine,
    commits,
    get clears() {
      return clears;
    },
    advance(ms: number) {
      now += ms;
    },
    firePendingTimers() {
      const fns = [...timers.values()];
      timers.clear();
      for (const fn of fns) fn();
    },
    get pendingTimerCount() {
      return timers.size;
    },
  };
}

/** Feed the preedit phase of a composition: 229 keydowns + composition/input noise. */
function feedPreedit(h: ReturnType<typeof makeHarness>, updates: string[]) {
  h.machine.keydown(fakeEvent({ keyCode: 229 }));
  h.machine.compositionstart(fakeEvent({ data: "" }));
  for (const text of updates) {
    h.machine.keydown(fakeEvent({ keyCode: 229 }));
    h.machine.beforeinput(fakeEvent({ inputType: "insertCompositionText", data: text }));
    h.machine.input(fakeEvent({ inputType: "insertCompositionText", data: text }));
    h.machine.compositionupdate(fakeEvent({ data: text }));
  }
}

test("commits a Fcitx5 phrase exactly once via the final beforeinput", () => {
  const h = makeHarness();
  const key229 = fakeEvent({ keyCode: 229 });
  h.machine.keydown(key229);
  assert.equal(key229.stopped, true, "xterm's keyCode-229 textarea-diff fallback must be blocked");
  assert.equal(key229.prevented, false, "the keydown itself must stay native so the IME works");

  const start = fakeEvent({ data: "" });
  h.machine.compositionstart(start);
  assert.equal(start.stopped, true, "xterm's CompositionHelper must never enter composition");

  const preedit = fakeEvent({ inputType: "insertCompositionText", data: "jia" });
  h.machine.beforeinput(preedit);
  assert.equal(preedit.stopped, true);
  assert.equal(preedit.prevented, false, "preedit must still mutate the textarea natively");
  h.machine.input(fakeEvent({ inputType: "insertCompositionText", data: "jia" }));
  h.machine.compositionupdate(fakeEvent({ data: "jia" }));

  const end = fakeEvent({ data: "甲乙丙" });
  h.machine.compositionend(end);
  assert.equal(end.stopped, true);
  assert.deepEqual(h.commits, [], "nothing sent yet — the commit rides the next beforeinput");

  const commit = fakeEvent({ inputType: "insertText", data: "甲乙丙" });
  h.machine.beforeinput(commit);
  assert.equal(commit.prevented, true, "native insertion is ours to cancel");
  assert.equal(commit.stopped, true);
  assert.deepEqual(h.commits, ["甲乙丙"]);
  assert.ok(h.clears >= 1, "the hidden textarea is wiped after the commit");
  assert.equal(h.pendingTimerCount, 0, "fallback timer cancelled once the commit lands");

  // WebKitGTK can still fire the follow-up input event despite preventDefault.
  const echo = fakeEvent({ inputType: "insertText", data: "甲乙丙" });
  h.machine.input(echo);
  assert.equal(echo.stopped, true, "the echoed input event must not reach xterm");
  assert.deepEqual(h.commits, ["甲乙丙"], "still exactly one copy");
});

test("falls back to compositionend data when the commit beforeinput has no data", () => {
  const h = makeHarness();
  feedPreedit(h, ["ni", "nihao"]);
  h.machine.compositionend(fakeEvent({ data: "你好" }));
  const commit = fakeEvent({ inputType: "insertText", data: null });
  h.machine.beforeinput(commit);
  assert.equal(commit.prevented, true);
  assert.deepEqual(h.commits, ["你好"]);
});

test("flushes the pending commit when no beforeinput ever follows", () => {
  const h = makeHarness();
  feedPreedit(h, ["bing"]);
  h.machine.compositionend(fakeEvent({ data: "丙" }));
  assert.deepEqual(h.commits, []);
  assert.equal(h.pendingTimerCount, 1);
  h.firePendingTimers();
  assert.deepEqual(h.commits, ["丙"]);
  assert.ok(h.clears >= 1);
  h.firePendingTimers();
  assert.deepEqual(h.commits, ["丙"], "the timer path fires at most once");
});

test("flushes before a real key so Enter lands after the committed text", () => {
  const h = makeHarness();
  feedPreedit(h, ["hao"]);
  h.machine.compositionend(fakeEvent({ data: "好" }));

  const enter = fakeEvent({ keyCode: 13 });
  h.machine.keydown(enter);
  assert.deepEqual(h.commits, ["好"], "text must be committed before Enter reaches xterm");
  assert.equal(enter.stopped, false, "Enter itself passes through to xterm");

  // The engine's commit events straggle in after our flush: swallow, don't resend.
  const late = fakeEvent({ inputType: "insertText", data: "好" });
  h.machine.beforeinput(late);
  assert.equal(late.prevented, true);
  assert.equal(late.stopped, true);
  const lateInput = fakeEvent({ inputType: "insertText", data: "好" });
  h.machine.input(lateInput);
  assert.equal(lateInput.stopped, true);
  assert.deepEqual(h.commits, ["好"]);
});

test("flushes an unsent commit when the next composition starts", () => {
  const h = makeHarness();
  feedPreedit(h, ["jia"]);
  h.machine.compositionend(fakeEvent({ data: "甲" }));
  feedPreedit(h, ["yi"]);
  assert.deepEqual(h.commits, ["甲"], "previous word flushed before the new preedit opens");
  h.machine.compositionend(fakeEvent({ data: "乙" }));
  h.machine.beforeinput(fakeEvent({ inputType: "insertText", data: "乙" }));
  assert.deepEqual(h.commits, ["甲", "乙"]);
});

test("leaves plain ASCII typing alone", () => {
  const h = makeHarness();
  const key = fakeEvent({ keyCode: 65 });
  h.machine.keydown(key);
  assert.equal(key.stopped, false);
  const before = fakeEvent({ inputType: "insertText", data: "a" });
  h.machine.beforeinput(before);
  assert.equal(before.prevented, false);
  assert.equal(before.stopped, false);
  const input = fakeEvent({ inputType: "insertText", data: "a" });
  h.machine.input(input);
  assert.equal(input.stopped, false);
  assert.deepEqual(h.commits, [], "xterm owns ordinary typing");
});

test("leaves paste alone", () => {
  const h = makeHarness();
  const before = fakeEvent({ inputType: "insertFromPaste", data: "ls -la" });
  h.machine.beforeinput(before);
  assert.equal(before.prevented, false);
  assert.equal(before.stopped, false);
  assert.deepEqual(h.commits, []);
});

test("sends nothing for a cancelled composition", () => {
  const h = makeHarness();
  feedPreedit(h, ["n"]);
  h.machine.compositionend(fakeEvent({ data: "" }));
  h.firePendingTimers();
  assert.deepEqual(h.commits, []);
});

test("treats a stray insertText during preedit as composition noise, not a commit", () => {
  const h = makeHarness();
  h.machine.compositionstart(fakeEvent({ data: "" }));
  const stray = fakeEvent({ inputType: "insertText", data: "x" });
  h.machine.beforeinput(stray);
  assert.equal(stray.stopped, true, "hidden from xterm — its helper thinks it is not composing");
  assert.equal(stray.prevented, false, "but the native mutation stays: it is the IME's preedit");
  assert.deepEqual(h.commits, []);
  h.machine.compositionend(fakeEvent({ data: "x" }));
  h.machine.beforeinput(fakeEvent({ inputType: "insertText", data: "x" }));
  assert.deepEqual(h.commits, ["x"]);
});

test("swallows only the immediate echo, not identical text typed later", () => {
  const h = makeHarness();
  feedPreedit(h, ["abc"]);
  h.machine.compositionend(fakeEvent({ data: "abc" }));
  h.machine.beforeinput(fakeEvent({ inputType: "insertText", data: "abc" }));
  assert.deepEqual(h.commits, ["abc"]);

  h.advance(COMMIT_ECHO_MS + 1);
  const later = fakeEvent({ inputType: "insertText", data: "abc" });
  h.machine.beforeinput(later);
  assert.equal(later.prevented, false, "past the echo window this is ordinary input for xterm");
  assert.equal(later.stopped, false);
  assert.deepEqual(h.commits, ["abc"], "the machine does not commit it either — xterm will");
});

test("accepts a commit-shaped input event when beforeinput never fires", () => {
  const h = makeHarness();
  feedPreedit(h, ["ding"]);
  h.machine.compositionend(fakeEvent({ data: "丁" }));
  const input = fakeEvent({ inputType: "insertText", data: "丁" });
  h.machine.input(input);
  assert.equal(input.stopped, true);
  assert.deepEqual(h.commits, ["丁"]);
  assert.equal(h.pendingTimerCount, 0);
  h.firePendingTimers();
  assert.deepEqual(h.commits, ["丁"]);
});

test("treats WebKit's insertFromComposition commit shape like insertText", () => {
  const h = makeHarness();
  feedPreedit(h, ["wu"]);
  h.machine.compositionend(fakeEvent({ data: "戊" }));
  const commit = fakeEvent({ inputType: "insertFromComposition", data: "戊" });
  h.machine.beforeinput(commit);
  assert.equal(commit.prevented, true);
  assert.deepEqual(h.commits, ["戊"]);
});

test("compositionupdate alone still marks the machine as composing", () => {
  const h = makeHarness();
  // Some engines skip compositionstart entirely.
  const update = fakeEvent({ data: "j" });
  h.machine.compositionupdate(update);
  assert.equal(update.stopped, true);
  const stray = fakeEvent({ inputType: "insertText", data: "j" });
  h.machine.beforeinput(stray);
  assert.equal(stray.stopped, true);
  assert.deepEqual(h.commits, []);
});
