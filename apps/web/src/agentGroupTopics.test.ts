import assert from "node:assert/strict";
import test from "node:test";
import { activeAgentConversationTopic, activeAgentGroupTopic, agentConversationTopics, agentGroupTopics, allAgentConversationMessages } from "./agentGroupTopics";
import type { AgentConversation, AgentMessage } from "./state/store";

const item = (id: string, role: AgentMessage["role"], content: string, createdAt: number): AgentMessage =>
  ({ id, role, content, createdAt });

const group = (messages: AgentMessage[]): AgentConversation => ({
  kind: "leaf", id: "group", title: "Team", createdAt: 1, updatedAt: 1,
  agentGroup: { memberIds: ["one", "two"] }, agentMessages: messages,
});

test("a legacy group transcript becomes one topic without losing messages", () => {
  const conversation = group([
    item("old", "user", "# Research **competitors**", 1),
    item("reply", "assistant", "private result", 2),
    item("new", "user", "Ship the launch plan", 3),
  ]);
  const topics = agentGroupTopics(conversation);
  assert.equal(topics.length, 1);
  assert.equal(topics[0].id, "legacy");
  assert.equal(topics[0].title, "Research competitors");
  assert.equal(topics[0].updatedAt, 3);
  assert.deepEqual(topics[0].agentMessages, conversation.agentMessages);
});

test("stored topics select independently and aggregate only for the inbox", () => {
  const one = item("one", "user", "One", 2);
  const two = item("two", "assistant", "Two", 3);
  const conversation: AgentConversation = {
    ...group([]),
    agentGroup: {
      memberIds: ["one", "two"],
      activeTopicId: "b",
      topics: [
        { id: "a", title: "A", createdAt: 1, updatedAt: 2, agentMessages: [one] },
        { id: "b", title: "B", createdAt: 2, updatedAt: 3, agentMessages: [two] },
      ],
    },
  };
  assert.equal(activeAgentGroupTopic(conversation)?.id, "b");
  assert.deepEqual(allAgentConversationMessages(conversation), [one, two]);
});

test("private conversations materialize legacy history and select stored topics", () => {
  const legacy = item("legacy-message", "user", "Plan the launch", 4);
  const conversation: AgentConversation = {
    kind: "leaf", id: "bot", title: "Bot", createdAt: 1, updatedAt: 4,
    agentMessages: [legacy],
  };
  assert.deepEqual(agentConversationTopics(conversation)[0].agentMessages, [legacy]);

  const one = item("one", "user", "One", 5);
  const two = item("two", "assistant", "Two", 6);
  const topicConversation: AgentConversation = {
    ...conversation,
    agentMessages: undefined,
    agentActiveTopicId: "b",
    agentTopics: [
      { id: "a", title: "A", createdAt: 1, updatedAt: 5, agentMessages: [one] },
      { id: "b", title: "B", createdAt: 2, updatedAt: 6, agentMessages: [two] },
    ],
  };
  assert.equal(activeAgentConversationTopic(topicConversation)?.id, "b");
  assert.deepEqual(allAgentConversationMessages(topicConversation), [one, two]);
});
