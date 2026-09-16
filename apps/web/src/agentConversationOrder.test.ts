import assert from "node:assert/strict";
import test from "node:test";
import { compareConversationActivity, lastConversationTime } from "./agentConversationOrder";

test("conversation order follows messages, not metadata edits", () => {
  const renamed = { createdAt: 10, updatedAt: 500, agentMessages: [{ createdAt: 20 }] };
  const recentReply = { createdAt: 5, updatedAt: 100, agentMessages: [{ createdAt: 100 }] };
  assert.deepEqual(
    [renamed, recentReply].sort((a, b) => lastConversationTime(b) - lastConversationTime(a)),
    [recentReply, renamed]
  );
});

test("empty conversations use creation time", () => {
  assert.equal(lastConversationTime({ createdAt: 50 }), 50);
  assert.equal(lastConversationTime({ createdAt: 50, agentMessages: [] }), 50);
});

test("restored transcripts use their most recent message, even when out of order", () => {
  assert.equal(lastConversationTime({
    createdAt: 500,
    agentMessages: [{ createdAt: 100 }, { createdAt: 300 }, { createdAt: 200 }],
  }), 300);
});

test("private Topics contribute their most recent message", () => {
  assert.equal(lastConversationTime({
    createdAt: 10,
    agentTopics: [
      { agentMessages: [{ createdAt: 20 }] },
      { agentMessages: [{ createdAt: 80 }, { createdAt: 40 }] },
    ],
  }), 80);
});

test("working conversations sort ahead of newer idle conversations", () => {
  const working = { createdAt: 10, agentMessages: [{ createdAt: 20 }] };
  const newerIdle = { createdAt: 10, agentMessages: [{ createdAt: 100 }] };
  assert.deepEqual(
    [newerIdle, working].sort((left, right) =>
      compareConversationActivity(left, right, left === working, right === working)
    ),
    [working, newerIdle]
  );
});

test("conversations with the same running state sort newest-first", () => {
  const older = { createdAt: 10, agentMessages: [{ createdAt: 20 }] };
  const newer = { createdAt: 10, agentMessages: [{ createdAt: 100 }] };
  assert.deepEqual(
    [older, newer].sort((left, right) => compareConversationActivity(left, right, false, false)),
    [newer, older]
  );
});
