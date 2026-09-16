import assert from "node:assert/strict";
import test from "node:test";
import { countRunningTasks } from "./updater";

test("counts only tasks that are still working", () => {
  assert.equal(
    countRunningTasks({
      activities: {
        first: { status: "working" },
        second: { status: "done" },
        third: { status: "error" },
        fourth: { status: "working" },
      },
    }),
    2,
  );
});

test("treats missing or malformed activity payloads as idle", () => {
  assert.equal(countRunningTasks(null), 0);
  assert.equal(countRunningTasks({}), 0);
  assert.equal(countRunningTasks({ activities: null }), 0);
  assert.equal(countRunningTasks({ activities: { bad: null } }), 0);
});
