import assert from "node:assert/strict";
import test from "node:test";

import { a2aReplyMessages, deliverA2AReply, directA2ASessionId,
  directA2ASourcePrompt, directA2ATargetPrompt, parseA2AReply } from "./agentA2A";
import type { AgentConversation } from "./state/store";

const bot = (id: string, title = id): AgentConversation => ({
  id,
  title,
  kind: "leaf",
  createdAt: 1,
  updatedAt: 1,
});

const bots = [bot("opencode", "opencode001"), bot("termany", "termany001"), bot("writer", "Writer Bot")];

test("direct A2A sessions are isolated and the target prompt preserves identity", () => {
  assert.notEqual(directA2ASessionId("one", "target"), directA2ASessionId("two", "target"));
  assert.notEqual(directA2ASessionId("one:bot:two", "target"), directA2ASessionId("one", "two:bot:target"));
  const prompt = directA2ASourcePrompt("@termany001 hello", bots[0], bots.slice(1));
  assert.match(prompt, /opencode001/);
  assert.match(prompt, /termany001/);
  assert.match(prompt, /@termany001 hello/);
});

test("the model owns recipient intent and must clarify ambiguous Bot names", () => {
  const peers = [bot("first-id", "Helper"), bot("second-id", "Helper")];
  const prompt = directA2ASourcePrompt("ask Helper to review this", bots[0], peers);
  assert.match(prompt, /Names are arbitrary user input/);
  assert.match(prompt, /same display name/);
  assert.match(prompt, /Ask the human one concise question/);
  assert.match(prompt, /first-id/);
  assert.match(prompt, /second-id/);
});

test("A2A transport is hidden while streaming and validates recipients", () => {
  const raw = "Sent it.[[a2a:termany]]tell a joke[[/a2a]]";
  assert.equal(parseA2AReply(raw).publicText, "Sent it.");
  assert.equal(parseA2AReply("Sent[[a2").publicText, "Sent");
  const malformed = parseA2AReply("Sent[[a2a to=termany]]secret[[/a2a]]");
  assert.equal(malformed.publicText, "Sent");
  assert.equal(malformed.invalid, true);
  const delivery = a2aReplyMessages(raw, bots[0], bots.slice(1), "reply");
  assert.equal(delivery.invalid, false);
  assert.equal(delivery.messages[0].recipient.id, "termany");
  assert.equal(delivery.messages[0].content, "tell a joke");
  assert.equal(a2aReplyMessages("[[a2a:term]]partial id[[/a2a]]", bots[0], bots.slice(1), "reply").invalid, true);
  assert.equal(a2aReplyMessages("[[a2a:termany001]]wrongly used a display name[[/a2a]]", bots[0], bots.slice(1), "reply").invalid, true);
  assert.equal(a2aReplyMessages("[[a2a:missing]]secret[[/a2a]]", bots[0], bots.slice(1), "reply").invalid, true);
  const duplicates = [bot("helper-one", "Helper"), bot("helper-two", "Helper")];
  assert.equal(a2aReplyMessages("[[a2a:helper-one]]secret[[/a2a]]", bots[0], duplicates, "reply").invalid, true);
});

test("a target reply lands in its own unread inbox", () => {
  const delivery = a2aReplyMessages("[[a2a:termany]]tell a joke[[/a2a]]", bots[0], bots.slice(1), "reply").messages[0];
  const prompt = directA2ATargetPrompt(delivery, bots[1]);
  assert.match(prompt, /opencode001/);
  const reply = { id: "answer", role: "assistant" as const, content: "A joke", createdAt: 10,
    sourceBot: delivery.sender };
  const delivered = deliverA2AReply(bots, "termany", reply);
  assert.equal(delivered[1].agentMessages?.at(-1)?.content, "A joke");
  assert.equal(delivered[1].agentUnread, 1);
  assert.equal(deliverA2AReply(delivered, "termany", reply)[1].agentUnread, 1);
});

test("an A2A reply lands in the target Bot's active Topic", () => {
  const target = { ...bots[1], agentActiveTopicId: "second", agentTopics: [
    { id: "first", title: "First", createdAt: 1, updatedAt: 1, agentMessages: [] },
    { id: "second", title: "Second", createdAt: 2, updatedAt: 2, agentMessages: [] },
  ] };
  const reply = { id: "topic-answer", role: "assistant" as const, content: "Topic answer", createdAt: 12,
    sourceBot: { id: "opencode", name: "opencode001" } };
  const delivered = deliverA2AReply([bots[0], target], "termany", reply)[1];
  assert.equal(delivered.agentTopics?.[0].agentMessages?.length, 0);
  assert.equal(delivered.agentTopics?.[1].agentMessages?.[0].content, "Topic answer");
  assert.equal(delivered.agentUnread, 1);
});
