import test from "node:test";
import assert from "node:assert/strict";
import {
  isNearLatestMessage,
  latestMessagePageStart,
  previousMessagePageStart,
} from "./agentMessagePagination";

test("opens a conversation on its newest message page", () => {
  assert.equal(latestMessagePageStart(0), 0);
  assert.equal(latestMessagePageStart(40), 0);
  assert.equal(latestMessagePageStart(41), 1);
  assert.equal(latestMessagePageStart(125), 85);
});

test("reveals history one page at a time", () => {
  assert.equal(previousMessagePageStart(85), 45);
  assert.equal(previousMessagePageStart(25), 0);
  assert.equal(previousMessagePageStart(0), 0);
});

test("only follows new replies while the reader remains near the latest message", () => {
  assert.equal(isNearLatestMessage(700, 240, 1000), true);
  assert.equal(isNearLatestMessage(679, 240, 1000), false);
});
