import assert from "node:assert/strict";
import test from "node:test";
import { compareConversationOrganization, conversationMoveUpdates } from "./agentConversationOrganization";

const conversations = [
  { id: "a", agentFolderId: "work" },
  { id: "b", agentFolderId: "work" },
  { id: "c" },
];

test("dragging into a folder updates only that destination order", () => {
  const updates = conversationMoveUpdates(conversations, "c", { folderId: "work", pinned: false, beforeId: "b" });
  assert.deepEqual(updates.map(({ id, agentFolderId, agentSortOrder }) => ({ id, agentFolderId, agentSortOrder })), [
    { id: "a", agentFolderId: "work", agentSortOrder: 0 },
    { id: "c", agentFolderId: "work", agentSortOrder: 1 },
    { id: "b", agentFolderId: "work", agentSortOrder: 2 },
  ]);
});

test("pinning preserves a conversation's folder and supports pinned reordering", () => {
  const pinned = [{ id: "p", agentPinned: true }, ...conversations];
  const updates = conversationMoveUpdates(pinned, "b", { pinned: true, beforeId: "p" });
  assert.deepEqual(updates.map(({ id, agentFolderId, agentPinned }) => ({ id, agentFolderId, agentPinned })), [
    { id: "b", agentFolderId: "work", agentPinned: true },
    { id: "p", agentFolderId: undefined, agentPinned: true },
  ]);
});

test("dropping onto a Bot swaps their positions inside one section", () => {
  const input = [
    { id: "a", agentFolderId: "work" },
    { id: "b", agentFolderId: "work" },
    { id: "c", agentFolderId: "work" },
  ];
  const updates = conversationMoveUpdates(input, "a", { folderId: "work", pinned: false, swapId: "c" });
  assert.deepEqual(updates.map(({ id, agentSortOrder }) => ({ id, agentSortOrder })), [
    { id: "c", agentSortOrder: 0 },
    { id: "b", agentSortOrder: 1 },
    { id: "a", agentSortOrder: 2 },
  ]);
});

test("dropping onto a Bot in another folder swaps both Bots between sections", () => {
  const input = [
    { id: "a", agentFolderId: "work" },
    { id: "b", agentFolderId: "work" },
    { id: "c", agentFolderId: "home" },
    { id: "d", agentFolderId: "home" },
  ];
  const updates = conversationMoveUpdates(input, "a", { folderId: "home", pinned: false, swapId: "d" });
  assert.deepEqual(updates.map(({ id, agentFolderId, agentSortOrder }) => ({ id, agentFolderId, agentSortOrder })), [
    { id: "d", agentFolderId: "work", agentSortOrder: 0 },
    { id: "b", agentFolderId: "work", agentSortOrder: 1 },
    { id: "c", agentFolderId: "home", agentSortOrder: 0 },
    { id: "a", agentFolderId: "home", agentSortOrder: 1 },
  ]);
});

test("manual positions sort ahead while untouched conversations keep stable recency order", () => {
  const input = [{ id: "recent" }, { id: "second" }, { id: "manual", agentSortOrder: 2 }];
  assert.deepEqual([...input].sort(compareConversationOrganization).map(({ id }) => id),
    ["manual", "recent", "second"]);
});
