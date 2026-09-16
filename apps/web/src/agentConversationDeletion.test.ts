import assert from "node:assert/strict";
import test from "node:test";

import { groupControllerSessionId, groupMemberSessionId } from "./agentGroupChat";
import { directA2ASessionId } from "./agentA2A";
import { removeAgentConversation } from "./agentConversationDeletion";
import { agentConversationTopicSessionId } from "./agentGroupTopics";
import type { AgentConversation } from "./state/store";

const bot = (id: string): AgentConversation => ({
  kind: "leaf",
  id,
  title: id,
  createdAt: 1,
  updatedAt: 1,
});

const group = (id: string, memberIds: string[]): AgentConversation => ({
  ...bot(id),
  agentGroup: { memberIds },
});

test("deleting a Bot removes it from group rosters and returns every owned session", () => {
  const conversations = [bot("bot one"), bot("bot two"), bot("bot three"), group("team", ["bot one", "bot two", "bot three"])];
  const result = removeAgentConversation(conversations, "bot one", 42);

  assert.deepEqual(result.conversations.map((conversation) => conversation.id), ["bot two", "bot three", "team"]);
  assert.deepEqual(result.conversations[2].agentGroup?.memberIds, ["bot two", "bot three"]);
  assert.equal(result.conversations[2].updatedAt, 42);
  assert.deepEqual(new Set(result.sessionIds), new Set([
    "bot one",
    directA2ASessionId("bot one", "bot two"),
    directA2ASessionId("bot two", "bot one"),
    directA2ASessionId("bot one", "bot three"),
    directA2ASessionId("bot three", "bot one"),
    groupControllerSessionId("team"),
    groupMemberSessionId("team", "bot one"),
  ]));
});

test("deleting the lead member promotes the next member and resets the coordinator session", () => {
  const team = group("team", ["one", "two", "three"]);
  team.agentGroup!.leadMemberId = "two";
  const result = removeAgentConversation([bot("one"), bot("two"), bot("three"), team], "two", 42);
  assert.equal(result.conversations[2].agentGroup?.leadMemberId, "one");
  assert.ok(result.sessionIds.includes(groupControllerSessionId("team")));
});

test("deleting a group returns its controller and isolated member sessions", () => {
  const conversations = [bot("one"), bot("two"), group("team / alpha", ["one", "two"])];
  const result = removeAgentConversation(conversations, "team / alpha");

  assert.deepEqual(result.conversations.map((conversation) => conversation.id), ["one", "two"]);
  assert.deepEqual(new Set(result.sessionIds), new Set([
    groupControllerSessionId("team / alpha"),
    groupMemberSessionId("team / alpha", "one"),
    groupMemberSessionId("team / alpha", "two"),
  ]));
});

test("deleting a Topic-backed group returns every Topic runtime session", () => {
  const topicGroup = group("team", ["one", "two"]);
  topicGroup.agentGroup = {
    memberIds: ["one", "two"],
    topics: [
      { id: "a", title: "A", createdAt: 1, updatedAt: 1 },
      { id: "b", title: "B", createdAt: 2, updatedAt: 2 },
    ],
  };
  const result = removeAgentConversation([bot("one"), bot("two"), topicGroup], "team");
  assert.deepEqual(new Set(result.sessionIds), new Set([
    groupControllerSessionId("team", "a"),
    groupMemberSessionId("team", "one", "a"),
    groupMemberSessionId("team", "two", "a"),
    groupControllerSessionId("team", "b"),
    groupMemberSessionId("team", "one", "b"),
    groupMemberSessionId("team", "two", "b"),
  ]));
});

test("deleting an unknown conversation is a no-op", () => {
  const conversations = [bot("one")];
  const result = removeAgentConversation(conversations, "missing");
  assert.equal(result.conversations, conversations);
  assert.deepEqual(result.sessionIds, []);
});

test("deleting a Topic-backed Bot returns every private Topic runtime session", () => {
  const topicBot = bot("topic bot");
  topicBot.agentTopics = [
    { id: "a", title: "A", createdAt: 1, updatedAt: 1 },
    { id: "b", title: "B", createdAt: 2, updatedAt: 2 },
  ];
  const result = removeAgentConversation([topicBot], "topic bot");
  assert.deepEqual(new Set(result.sessionIds), new Set([
    agentConversationTopicSessionId("topic bot", "a"),
    agentConversationTopicSessionId("topic bot", "b"),
  ]));
});
