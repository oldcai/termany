import assert from "node:assert/strict";
import test from "node:test";
import { deliverPrivateMessages, directReplyPrompt, parsePrivateReply, privateContext, privateReplyDeliveries, unreadAgentMessages, type AgentPrivateMessage } from "./agentPrivateMessages";
import { groupConversationPrompt, runGroupConversation } from "./agentGroupChat";
import type { AgentConversation, AgentMessage } from "./state/store";

const bot = (id: string): AgentConversation => ({ id, kind: "leaf", title: id, createdAt: 1, updatedAt: 1, workspaceId: "ws" });
const note = (id: string, from: string, to: string, content: string): AgentPrivateMessage => ({
  id, sender: { id: from, name: from }, recipient: { id: to, name: to }, content, createdAt: 2,
});

test("private text never appears publicly at any streaming boundary", () => {
  const raw = "公开开始[[private:B]]秘密词苹果[[/private]]公开继续[[private:human]]你的秘密词梨[[/private]]结束";
  for (let end = 0; end <= raw.length; end++) {
    const result = parsePrivateReply(raw.slice(0, end));
    assert.ok("公开开始公开继续结束".startsWith(result.publicText), `leaked at character ${end}: ${result.publicText}`);
  }
  const result = parsePrivateReply(raw);
  assert.equal(result.publicText, "公开开始公开继续结束");
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.incomplete, false);
});

test("incomplete, malformed and unknown private recipients fail closed", () => {
  for (const raw of ["[[private:B]]secret", "[[private nope]]secret[[/private]]",
    "[[private:missing]]secret[[/private]]", "[[private:B]]one[[private:C]]two[[/private]]"]) {
    const result = privateReplyDeliveries(raw, bot("A"), [bot("A"), bot("B")], "reply");
    assert.equal(result.invalid, true);
    assert.deepEqual(result.messages, []);
    assert.doesNotMatch(parsePrivateReply(raw).publicText, /secret|one|two/);
  }
  const realUser = { ...bot("u"), title: "User" };
  const result = privateReplyDeliveries("[[private:User]]for bot[[/private]][[private:human]]for human[[/private]]", bot("A"), [bot("A"), realUser], "reply");
  assert.deepEqual(result.messages.map((message) => message.recipient.id), ["u", "human"]);
});

test("private context is limited to sender and recipient and retains the triggering message", () => {
  const messages = [note("ab", "A", "B", "B-secret"), note("ac", "A", "C", "C-secret"), note("ah", "A", "human", "human-secret")];
  assert.deepEqual(privateContext(messages, "B").map((message) => message.content), ["B-secret"]);
  assert.equal(privateContext(messages, "A").length, 3);
  assert.equal(privateContext(messages, "outsider").length, 0);
  const lots = [...messages, ...Array.from({ length: 20 }, (_, index) => note(String(index), "C", "B", "x".repeat(4000)))];
  const selected = privateContext(lots, "B", ["ab"]);
  assert.ok(selected.some((message) => message.id === "ab"));
  assert.ok(selected.reduce((total, message) => total + message.content.length, 0) <= 24_000);
});

test("human deliveries create unread direct messages once, without exposing other agents' secrets", () => {
  const group = { ...bot("g"), agentGroup: { memberIds: ["A", "B", "C"] } };
  const before = [group, bot("A"), bot("B"), bot("C")];
  const incoming = [note("ab", "A", "B", "B-secret"), note("ah", "A", "human", "human-secret")];
  const after = deliverPrivateMessages(before, "g", incoming);
  const inbox = after.find((conversation) => conversation.id === "A")!;
  assert.equal(inbox.agentMessages?.[0].content, "human-secret");
  assert.equal(inbox.agentMessages?.[0].sourceGroup?.id, "g");
  assert.equal(unreadAgentMessages(inbox), 1);
  assert.equal(unreadAgentMessages({ ...inbox, agentUnread: 0, agentReadAt: inbox.agentMessages![0].createdAt }), 0);
  assert.equal(unreadAgentMessages({ ...inbox, agentUnread: 7 }), 7);
  assert.equal(after[0].agentMessages, undefined);
  assert.equal(after[2].agentMessages, undefined);
  assert.equal(before[1].agentMessages, undefined);
  assert.equal(deliverPrivateMessages(after, "g", incoming), after);
  assert.equal(deliverPrivateMessages(after, "g", [note("bad", "outsider", "human", "bad")]), after);
  assert.match(directReplyPrompt("收到", inbox.agentMessages!), /human-secret/);
  assert.doesNotMatch(directReplyPrompt("收到", inbox.agentMessages!), /B-secret/);
});

test("a direct inbox reply keeps A2A source context for the human's follow-up", () => {
  const history: AgentMessage[] = [
    { id: "a2a-answer", role: "assistant", content: "这是 termany001 的笑话。", createdAt: 2,
      sourceBot: { id: "opencode", name: "opencode001" } },
  ];
  const prompt = directReplyPrompt("再讲一个", history);
  assert.match(prompt, /Agent-to-Agent/);
  assert.match(prompt, /opencode001/);
  assert.match(prompt, /这是 termany001 的笑话/);
  assert.match(prompt, /再讲一个/);
});

test("a model-selected sequence adds private deliveries to the planned recipient's triggers", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const user: AgentMessage = { id: "u", role: "user", content: "Start", createdAt: 1 };
  const privateMessages: AgentPrivateMessage[] = [];
  const calls: string[] = [];
  let decisions = 0;
  await runGroupConversation({ group, user, signal: new AbortController().signal,
    decide: async (context) => {
      assert.doesNotMatch(JSON.stringify(context), /B-secret|human-secret/);
      decisions++;
      if (decisions > 1) return { mode: "none", memberIds: [], triggerMessageIds: [] };
      return { mode: "sequential", memberIds: ["A", "B", "C"], triggerMessageIds: ["u"] };
    }, reply: async (member, turn) => {
    calls.push(member.id);
    const context = JSON.parse(groupConversationPrompt(group, member, [user], turn, privateMessages).split("\n").at(-1)!);
    assert.doesNotMatch(JSON.stringify(context.messages), /secret/);
    const deliveries = member.id === "A" ? [note("ab", "A", "B", "B-secret")] :
      member.id === "B" ? [note("bh", "B", "human", "human-secret")] : [];
    if (member.id === "B") {
      assert.deepEqual(turn.triggerMessageIds, ["u", "ab"]);
      assert.equal(context.privateInbox[0].content, "B-secret");
    }
    if (member.id === "C") assert.deepEqual(context.privateInbox, []);
    privateMessages.push(...deliveries);
    return { messages: [], privateMessages: deliveries };
  } });
  assert.deepEqual(calls, ["A", "B", "C"]);
  assert.equal(decisions, 2);
});

test("the model can continue a private-only exchange and then stop", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  await runGroupConversation({ group, user: { id: "u", role: "user", content: "@A start", createdAt: 1 }, signal: new AbortController().signal,
    decide: async (context) => {
      const step = context.completedTurns.length;
      assert.doesNotMatch(JSON.stringify(context), /secret|answer/);
      return { memberId: ["A", "B", "A", null][step], triggerMessageIds: [["u"], ["ab"], ["ba"], []][step] };
    },
    reply: async (member) => {
      calls.push(member.id);
      return { messages: [], privateMessages: calls.length === 1 ? [note("ab", "A", "B", "secret")]
        : calls.length === 2 ? [note("ba", "B", "A", "answer")] : [] };
    } });
  assert.deepEqual(calls, ["A", "B", "A"]);
});
