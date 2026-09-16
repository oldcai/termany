import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_SKILL_BUDGET_NOTICE, splitAgentRuntimeNotices } from "@termany/core";
import { agentReplyPrompt, splitAgentReply, visibleAgentMessages } from "./agentMessages";
import { groupConversationPrompt } from "./agentGroupChat";
import type { AgentConversation, AgentMessage } from "./state/store";

test("the exact runtime notice is separated without hiding ordinary warnings or quoted examples", () => {
  assert.deepEqual(splitAgentRuntimeNotices(`${CODEX_SKILL_BUDGET_NOTICE}\n\nActual answer`), {
    content: "Actual answer", notices: [CODEX_SKILL_BUDGET_NOTICE],
  });
  for (const content of ["Warning: this command deletes files.", `> ${CODEX_SKILL_BUDGET_NOTICE}`, `\`\`\`text\n${CODEX_SKILL_BUDGET_NOTICE}\n\`\`\``,
    `The diagnostic was:\n${CODEX_SKILL_BUDGET_NOTICE}`]) {
    assert.deepEqual(splitAgentRuntimeNotices(content), { content, notices: [] });
  }
});

test("saved warning bubbles disappear while user messages, tool records and errors remain", () => {
  const history: AgentMessage[] = [
    { id: "u", role: "user", content: CODEX_SKILL_BUDGET_NOTICE, createdAt: 1 },
    { id: "notice", role: "assistant", content: CODEX_SKILL_BUDGET_NOTICE, createdAt: 2 },
    { id: "reply", role: "assistant", content: `${CODEX_SKILL_BUDGET_NOTICE}\n\nReply`, createdAt: 3,
      parts: [{ kind: "text", text: CODEX_SKILL_BUDGET_NOTICE }, { kind: "tool", id: "t", title: "Read" }, { kind: "text", text: "Reply" }] },
    { id: "error", role: "assistant", content: "", error: "Authentication failed", createdAt: 4 },
  ];
  const cleaned = visibleAgentMessages(history);
  assert.deepEqual(cleaned.map((message) => message.id), ["u", "reply", "error"]);
  assert.equal(cleaned[0].content, CODEX_SKILL_BUDGET_NOTICE);
  assert.equal(cleaned[1].content, "Reply");
  assert.deepEqual(cleaned[1].parts?.[0], { kind: "text", text: "" });
  assert.equal(cleaned[1].parts?.[1].kind, "tool");
  assert.equal(history[2].content, `${CODEX_SKILL_BUDGET_NOTICE}\n\nReply`);
});

test("old runtime warnings never enter the group conversation context", () => {
  const member: AgentConversation = { kind: "leaf", id: "a", title: "A", createdAt: 1, updatedAt: 1 };
  const prompt = groupConversationPrompt({ name: "Team", members: [member] }, member, [
    { id: "u", role: "user", content: "Hello", createdAt: 1 },
    { id: "w", role: "assistant", content: CODEX_SKILL_BUDGET_NOTICE, createdAt: 2 },
  ]);
  assert.doesNotMatch(prompt, /Skill descriptions were shortened/);
});

test("ordinary reply paragraphs become a bounded conversational bubble stack", () => {
  const item: AgentMessage = { id: "reply", role: "assistant", createdAt: 2,
    content: ["First beat", "Second beat", "Third beat", "Fourth beat", "Fifth beat"].join("\n\n") };
  const replies = splitAgentReply(item);
  assert.deepEqual(replies.map((reply) => reply.content),
    ["First beat", "Second beat", "Third beat", "Fourth beat\n\nFifth beat"]);
  assert.equal(new Set(replies.map((reply) => reply.replyGroupId)).size, 1);
  assert.equal(new Set(replies.map((reply) => reply.id)).size, 4);
});

test("reply splitting keeps structured Markdown together and respects explicit breaks", () => {
  const list = "1. First\n\n   Detail\n\n2. Second";
  assert.deepEqual(splitAgentReply({ id: "list", role: "assistant", content: list, createdAt: 1 })
    .map((reply) => reply.content), [list]);
  const explicit = "One\n<!-- message_break -->\nTwo";
  assert.deepEqual(splitAgentReply({ id: "explicit", role: "assistant", content: explicit, createdAt: 1 })
    .map((reply) => reply.content), ["One", "Two"]);
});

test("generated images survive empty replies and appear in only one split bubble", () => {
  const image = { id: "image", kind: "image" as const, path: "/tmp/image.png", mimeType: "image/png" };
  const imageOnly: AgentMessage = { id: "only", role: "assistant", content: "", createdAt: 1, attachments: [image] };
  const visible = visibleAgentMessages([imageOnly]);
  assert.equal(visible.length, 1);
  assert.deepEqual(visible[0].attachments, [image]);

  const replies = splitAgentReply({ ...imageOnly, id: "split", content: "First\n\nSecond" });
  assert.deepEqual(replies.map((reply) => reply.attachments?.length ?? 0), [1, 0]);
});

test("Bot delivery records survive empty replies and follow the final split bubble", () => {
  const delivery = { id: "delivery", recipient: { id: "target", name: "Target" }, content: "Draw a chair" };
  const relay: AgentMessage = { id: "relay", role: "assistant", content: "", createdAt: 1,
    botDeliveries: [delivery] };
  assert.equal(visibleAgentMessages([relay]).length, 1);

  const replies = splitAgentReply({ ...relay, content: "Sending it\n\nDone" });
  assert.deepEqual(replies.map((reply) => reply.botDeliveries?.length ?? 0), [0, 1]);
});

test("every ordinary runtime receives the messenger reply contract", () => {
  const prompt = agentReplyPrompt("讲个故事");
  assert.match(prompt, /2–3 messages/);
  assert.match(prompt, /<!-- message_break -->/);
  assert.match(prompt, /讲个故事/);
  assert.equal(agentReplyPrompt("/model"), "/model");
});
