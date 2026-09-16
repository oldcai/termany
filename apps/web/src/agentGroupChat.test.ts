import assert from "node:assert/strict";
import test from "node:test";
import { groupDecisionPrompt, groupControllerSessionId, groupLeadMember, validateGroupDecision, addressesEveryone, groupConversationPrompt, groupMemberIds, groupMemberSessionId, groupMentionQuery, insertGroupMention, mentionedGroupMembers, runGroupConversation, splitGroupReply, GROUP_MAX_TURNS } from "./agentGroupChat";
import type { AgentConversation, AgentMessage } from "./state/store";

const bot = (id: string, workspaceId = "ws"): AgentConversation => ({
  kind: "leaf", id, title: id, workspaceId, createdAt: 1, updatedAt: 1,
  agentMessages: [{ id: "private", role: "user", content: "Private conversation secret", createdAt: 1 }],
});

test("group members are unique Bots in this workspace, including legacy Bots", () => {
  const legacy = { ...bot("legacy"), workspaceId: undefined };
  const nestedGroup = { ...bot("group"), agentGroup: { memberIds: ["a", "legacy"] } };
  assert.deepEqual(groupMemberIds(["a", "a", "other", "missing", "group", "legacy"],
    [bot("a"), bot("other", "elsewhere"), nestedGroup, legacy], "ws", "ws"), ["a", "legacy"]);
});

test("each group and Bot pair has an independent stable runtime session", () => {
  const ids = [groupMemberSessionId("a", "b"), groupMemberSessionId("c", "b"), groupMemberSessionId("a", "c"),
    groupMemberSessionId("a:bot:b", "c"), groupMemberSessionId("a", "b:bot:c")];
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids[0], groupMemberSessionId("a", "b"));
  assert.ok(!ids.includes("a") && !ids.includes("b"));
});

test("each Topic gets isolated controller and member runtime sessions", () => {
  assert.notEqual(groupControllerSessionId("group", "topic-a"), groupControllerSessionId("group", "topic-b"));
  assert.notEqual(groupMemberSessionId("group", "bot", "topic-a"), groupMemberSessionId("group", "bot", "topic-b"));
  assert.notEqual(groupMemberSessionId("group-a", "bot", "topic"), groupMemberSessionId("group-b", "bot", "topic"));
});

test("group context contains shared replies and recipients without leaking private Bot history", () => {
  const members = [bot("Researcher"), bot("Writer")];
  const history: AgentMessage[] = [
    { id: "1", role: "user", content: "Research a topic", createdAt: 1, recipient: { id: "Researcher", name: "Researcher" } },
    { id: "2", role: "assistant", content: "Shared research", createdAt: 2, sender: { id: "Researcher", name: "Researcher" } },
    { id: "3", role: "user", content: "Summarize it", createdAt: 3 },
  ];
  const prompt = groupConversationPrompt({ name: "Team", description: "Work together", members }, members[1], history);
  const context = JSON.parse(prompt.split("\n").at(-1)!);
  assert.equal(context.currentBot.id, "Writer");
  assert.deepEqual(context.messages.map((message: any) => message.content), history.map((message) => message.content));
  assert.equal(context.messages[0].to, "Researcher");
  assert.equal(context.messages[1].speakerId, "Researcher");
  assert.equal(context.group.description, "Work together");
  assert.doesNotMatch(prompt, /Private conversation secret/);
});

test("group context stays bounded and keeps the most recent user message", () => {
  const member = bot("a");
  const history: AgentMessage[] = Array.from({ length: 100 }, (_, index) => ({
    id: String(index), role: "user", content: "x".repeat(20_000), createdAt: index,
  }));
  history.push({ id: "latest", role: "user", content: "Current question", createdAt: 101 });
  const prompt = groupConversationPrompt({ name: "Team", members: [member] }, member, history);
  const context = JSON.parse(prompt.split("\n").at(-1)!);
  assert.equal(context.messages.at(-1).content, "Current question");
  assert.ok(context.messages.reduce((size: number, message: any) => size + message.content.length, 0) <= 48_000);
});

test("human transcript roles never become member names or mention targets", () => {
  const members = [bot("张三"), bot("李四"), bot("王五")];
  const history: AgentMessage[] = [
    { id: "u", role: "user", content: "来玩谁是卧底了", createdAt: 1 },
    { id: "a", role: "assistant", content: "我来参加", createdAt: 2, sender: { id: "李四", name: "李四" } },
  ];
  const context = JSON.parse(groupConversationPrompt({ name: "游戏", members }, members[0], history).split("\n").at(-1)!);
  assert.equal(context.messages[0].role, "user");
  assert.equal(context.messages[0].speaker, undefined);
  assert.equal(context.messages[0].speakerId, undefined);
  assert.equal(context.messages[1].speaker, "李四");
  assert.deepEqual(context.mentionTargets, [{ id: "李四", name: "李四" }, { id: "王五", name: "王五" }]);
  assert.deepEqual(mentionedGroupMembers("@User 你来当裁判", members), []);

  // A real Bot deliberately named User is still an addressable member.
  const namedUser = bot("User");
  const renamed = { name: "游戏", members: [members[0], namedUser] };
  const withNamedBot = JSON.parse(groupConversationPrompt(renamed, members[0], history).split("\n").at(-1)!);
  assert.deepEqual(withNamedBot.mentionTargets, [{ id: "User", name: "User" }]);
  assert.deepEqual(mentionedGroupMembers("@User 请回复", renamed.members), [namedUser]);
});

test("the global user name identifies the human without becoming a Bot mention target", () => {
  const members = [bot("老师"), bot("助教")];
  const group = { name: "课堂", humanName: "idoubi", members };
  const history: AgentMessage[] = [{ id: "u", role: "user", content: "开始吧", createdAt: 1 }];
  const memberContext = JSON.parse(groupConversationPrompt(group, members[0], history).split("\n").at(-1)!);
  assert.deepEqual(memberContext.human, { id: "human", name: "idoubi", privateAddress: "human" });
  assert.deepEqual(memberContext.mentionTargets, [{ id: "助教", name: "助教" }]);
  assert.match(groupConversationPrompt(group, members[0], history), /address them by human\.name/);

  const decisionContext = { messages: history, privateDeliveries: [], completedTurns: [] };
  const controllerContext = JSON.parse(groupDecisionPrompt(group, decisionContext).split("\n").at(-1)!);
  assert.deepEqual(controllerContext.human, { kind: "human", name: "idoubi", privateAddress: "human" });
});

const chatMessage = (id: string, content: string, role: AgentMessage["role"] = "assistant"): AgentMessage => ({ id, content, role, createdAt: 1 });

test("mentions resolve exact Chinese and spaced names in mention order, excluding code and emails", () => {
  const members = [bot("Ann"), bot("Anna"), bot("我的 codex"), bot("设计师")];
  const text = "@我的 codex 请分析，@Anna 请接手。 @设计师：你好 @Anna\ncontact@Ann.com `@Ann`\n```text\n@Ann\n```\n> @Ann\n[reference @Ann](https://example.com)";
  assert.deepEqual(mentionedGroupMembers(text, members).map((member) => member.id), ["我的 codex", "Anna", "设计师"]);
  assert.deepEqual(mentionedGroupMembers("＠ａｎｎ 请回复", members).map((member) => member.id), ["Ann"]);
  assert.deepEqual(mentionedGroupMembers("@Annalise @missing", members), []);
  assert.deepEqual(mentionedGroupMembers("<!-- @Anna -->\n```text\n@Ann", members), []);
  assert.equal(addressesEveryone("请 @all 回复"), true);
  assert.equal(addressesEveryone("@所有成员：讨论一下"), true);
  assert.equal(addressesEveryone("email@all.com `@everyone`"), false);
});

test("mention autocomplete edits only the query before the caret and supports spaced names", () => {
  const value = "请 @我的 co 看看方案";
  const query = groupMentionQuery(value, 8)!;
  assert.deepEqual(query, { start: 2, end: 8, query: "我的 co" });
  const result = insertGroupMention(value, query, "我的 codex");
  assert.equal(result.value, "请 @我的 codex  看看方案");
  assert.equal(result.value.slice(0, result.cursor), "请 @我的 codex ");
  assert.equal(groupMentionQuery("hello@example.com", 17), null);
  assert.equal(groupMentionQuery("@Ann\nnext", 9), null);
  assert.equal(groupMentionQuery("@我的 codex 请看看", 13, [bot("我的 codex")]), null);
  assert.equal(groupMentionQuery("@all ", 5), null);
  assert.equal(groupMentionQuery("@Ann ", 5, [bot("Ann"), bot("Ann Smith")])?.query, "Ann ");
});

test("explicit mentions bypass the model and route directly", async () => {
  const members = [bot("张三"), bot("李四"), bot("王五")];
  const calls: string[] = [];
  await runGroupConversation({ group: { name: "游戏", members },
    user: chatMessage("u", "@李四 请回复", "user"), signal: new AbortController().signal,
    decide: async () => assert.fail("an explicit recipient must not invoke dispatch"),
    reply: async (member) => { calls.push(member.id); return [chatMessage("reply", "收到")]; },
  });
  assert.deepEqual(calls, ["李四"]);
});

test("one ambiguous dispatch can choose an ordered multi-member sequence", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  let decisions = 0;
  await runGroupConversation({ group, user: chatMessage("u", "Start", "user"), signal: new AbortController().signal,
    decide: async (context) => {
      decisions++;
      if (decisions > 1) {
        assert.equal(context.completedTurns.length, 3);
        return { mode: "none", memberIds: [], triggerMessageIds: [] };
      }
      return { mode: "sequential", memberIds: ["A", "C", "A"], triggerMessageIds: ["u"] };
    },
    reply: async (member, turn, visible) => {
      calls.push(member.id);
      assert.deepEqual(turn.triggerMessageIds, ["u"]);
      assert.equal(visible.filter((message) => message.role === "assistant").length, calls.length - 1);
      return [chatMessage(String(calls.length), `Result ${calls.length}`)];
    },
  });
  assert.deepEqual(calls, ["A", "C", "A"]);
  assert.equal(decisions, 2);
});

test("the lead member visibly responds before the initial dispatched workers", async () => {
  const group = { name: "Team", leadMemberId: "A", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  let decisions = 0;
  await runGroupConversation({ group, user: chatMessage("u", "Organize the team", "user"),
    signal: new AbortController().signal,
    decide: async (context) => {
      decisions++;
      if (decisions === 1) return { mode: "parallel", memberIds: ["B", "C"], triggerMessageIds: ["u"] };
      assert.deepEqual(context.completedTurns.map((turn) => turn.memberId), ["A", "B", "C"]);
      return { mode: "none", memberIds: [], triggerMessageIds: [] };
    },
    reply: async (member, _turn, visible) => {
      calls.push(member.id);
      if (member.id !== "A") {
        assert.equal(visible.filter((message) => message.role === "assistant").length, 1);
      }
      return [chatMessage(`reply-${member.id}-${calls.length}`, "done")];
    },
  });
  assert.deepEqual(calls, ["A", "B", "C"]);
  assert.equal(decisions, 2);
});

test("the coordinator keeps supervising until a user-facing result is complete", async () => {
  const group = { name: "Team", leadMemberId: "A", members: [bot("A"), bot("B")] };
  const calls: string[] = [];
  let decisions = 0;
  const result = await runGroupConversation({ group, user: chatMessage("u", "Research and summarize", "user"),
    signal: new AbortController().signal,
    decide: async (context) => {
      decisions++;
      if (decisions === 1) return { mode: "single", memberIds: ["B"], triggerMessageIds: ["u"] };
      if (decisions === 2) {
        assert.deepEqual(context.completedTurns.map((turn) => turn.memberId), ["A", "B"]);
        return { mode: "single", memberIds: ["A"], triggerMessageIds: ["research"] };
      }
      assert.deepEqual(context.completedTurns.map((turn) => turn.memberId), ["A", "B", "A"]);
      return { mode: "none", memberIds: [], triggerMessageIds: [] };
    },
    reply: async (member, _turn, visible) => {
      calls.push(member.id);
      if (member.id === "A" && calls.filter((id) => id === "A").length > 1) {
        assert.equal(visible.some((item) => item.id === "research"), true);
      }
      return [chatMessage(member.id === "B" ? "research" : "final", member.id === "B" ? "findings" : "final answer")];
    },
  });
  assert.deepEqual(calls, ["A", "B", "A"]);
  assert.equal(decisions, 3);
  assert.equal(result.failed, false);
});

test("@all runs members in parallel against the same transcript", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = runGroupConversation({ group, user: chatMessage("u", "@all answer", "user"), signal: new AbortController().signal,
    decide: async () => assert.fail("@all must not invoke dispatch"),
    reply: async (member, _turn, visible) => {
      started.push(member.id);
      assert.deepEqual(visible.map((message) => message.id), ["u"]);
      if (started.length === group.members.length) release();
      await gate;
      return [chatMessage(`r-${member.id}`, "done")];
    },
  });
  await running;
  assert.deepEqual(started, ["A", "B", "C"]);
});

test("a Bot continues work only through an explicit handoff", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  await runGroupConversation({ group, user: chatMessage("u", "@A organize this", "user"), signal: new AbortController().signal,
    decide: async () => assert.fail("an explicit recipient must not invoke dispatch"),
    reply: async (member) => {
      calls.push(member.id);
      return [chatMessage(`r-${member.id}`, member.id === "A" ? "@B take the next step" : "done")];
    },
  });
  assert.deepEqual(calls, ["A", "B"]);
});

test("a failed member is quarantined and its task is reassigned to a healthy member", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  const failovers: { unavailableMemberIds: string[]; replacementMemberId: string }[] = [];
  const turns: { memberId: string; triggers: string[] }[] = [];
  let decisions = 0;
  const result = await runGroupConversation({ group, user: chatMessage("u", "@A do it", "user"),
    signal: new AbortController().signal, decide: async (context) => {
      decisions++;
      assert.deepEqual(context.unavailableMemberIds, ["A"]);
      return { mode: "none", memberIds: [], triggerMessageIds: [] };
    },
    reply: async (member, turn) => {
      calls.push(member.id);
      turns.push({ memberId: member.id, triggers: turn.triggerMessageIds });
      return member.id === "A" ? { messages: [], failed: true } : [chatMessage("r", "done")];
    },
    onFailover: (failover) => failovers.push(failover),
  });
  assert.deepEqual(calls, ["A", "B"]);
  assert.deepEqual(turns, [
    { memberId: "A", triggers: ["u"] },
    { memberId: "B", triggers: ["u"] },
  ]);
  assert.equal(decisions, 1);
  assert.deepEqual(failovers, [{ unavailableMemberIds: ["A"], replacementMemberId: "B" }]);
  assert.deepEqual(result, { limited: false, failed: false, unavailableMemberIds: ["A"] });
});

test("a healthy lead publicly monitors and reorganizes after a member failure", async () => {
  const group = { name: "Team", leadMemberId: "A", members: [bot("B"), bot("C"), bot("A")] };
  const calls: { memberId: string; unavailable: string[] }[] = [];
  await runGroupConversation({ group, user: chatMessage("u", "@B do it", "user"),
    signal: new AbortController().signal,
    decide: async () => assert.fail("a healthy lead should handle recovery without hidden dispatch"),
    reply: async (member, turn) => {
      calls.push({ memberId: member.id, unavailable: turn.unavailableMemberIds ?? [] });
      return member.id === "B" ? { messages: [], failed: true } : [chatMessage(`r-${member.id}`, "done")];
    },
  });
  assert.deepEqual(calls, [
    { memberId: "B", unavailable: [] },
    { memberId: "C", unavailable: ["B"] },
    { memberId: "A", unavailable: ["B"] },
  ]);
});

test("parallel failures are recovered sequentially without retrying quarantined members", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  let activeRecoveries = 0;
  let maxActiveRecoveries = 0;
  let decisions = 0;
  const result = await runGroupConversation({ group, user: chatMessage("u", "@all do it", "user"),
    signal: new AbortController().signal, decide: async (context) => {
      decisions++;
      assert.deepEqual(context.unavailableMemberIds, ["A", "B"]);
      return { mode: "none", memberIds: [], triggerMessageIds: [] };
    },
    reply: async (member, _turn, visible) => {
      calls.push(member.id);
      if (calls.length <= 3) {
        return member.id === "C" ? [chatMessage("c", "healthy result")] : { messages: [], failed: true };
      }
      assert.equal(visible.some((message) => message.id === "c"), true);
      activeRecoveries++;
      maxActiveRecoveries = Math.max(maxActiveRecoveries, activeRecoveries);
      await Promise.resolve();
      activeRecoveries--;
      return [chatMessage(`recovery-${calls.length}`, "recovered")];
    },
  });
  assert.deepEqual(calls, ["A", "B", "C", "C", "C"]);
  assert.equal(maxActiveRecoveries, 1);
  assert.equal(decisions, 1);
  assert.deepEqual(result.unavailableMemberIds, ["A", "B"]);
  assert.equal(result.failed, false);
});

test("the group fails only after every member is unavailable", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B"), bot("C")] };
  const calls: string[] = [];
  const result = await runGroupConversation({ group, user: chatMessage("u", "@A do it", "user"),
    signal: new AbortController().signal, decide: async () => assert.fail("explicit routing must bypass dispatch"),
    reply: async (member) => { calls.push(member.id); return { messages: [], failed: true }; },
  });
  assert.deepEqual(calls, ["A", "B", "C"]);
  assert.deepEqual(result, { limited: false, failed: true, unavailableMemberIds: ["A", "B", "C"] });
});

test("the model may decide that no reply is appropriate", async () => {
  let calls = 0;
  const result = await runGroupConversation({ group: { name: "Team", members: [bot("A"), bot("B")] },
    user: chatMessage("u", "FYI", "user"), signal: new AbortController().signal,
    decide: async () => ({ mode: "none", memberIds: [], triggerMessageIds: [] }),
    reply: async () => { calls++; return []; },
  });
  assert.equal(calls, 0);
  assert.equal(result.limited, false);
});

test("invalid or failed dispatch never falls back to a member", async () => {
  const group = { name: "Team", members: [bot("A"), bot("B")] };
  for (const decision of [undefined, {}, { memberId: "User", triggerMessageIds: ["u"] },
    { memberId: "A", triggerMessageIds: ["missing"] }, { memberId: "A", triggerMessageIds: [] },
    { memberId: null, triggerMessageIds: ["u"] }]) {
    let calls = 0;
    await assert.rejects(runGroupConversation({ group, user: chatMessage("u", "start", "user"), signal: new AbortController().signal,
      decide: async () => decision, reply: async () => { calls++; return []; },
    }));
    assert.equal(calls, 0);
  }
  await assert.rejects(runGroupConversation({ group, user: chatMessage("u", "start", "user"), signal: new AbortController().signal,
    decide: async () => { throw new Error("Model unavailable"); }, reply: async () => { assert.fail("must not reply"); },
  }), /Model unavailable/);
});

test("controller context includes profiles and progress, but no private message bodies", () => {
  const group = { name: "Team", description: "Configured by user", leadMemberId: "B",
    members: [{ ...bot("A"), agentDescription: "Configured role" }, bot("B"), bot("C")] };
  const context = { messages: [chatMessage("u", "Continue", "user")], completedTurns: [],
    privateDeliveries: [{ id: "secret", sender: { id: "A", name: "A" }, recipient: { id: "B", name: "B" }, createdAt: 1 }] };
  const prompt = groupDecisionPrompt(group, context);
  const data = JSON.parse(prompt.split("\n").at(-1)!);
  assert.equal(data.members[0].description, "Configured role");
  assert.equal(data.group.description, "Configured by user");
  assert.equal(data.leadMember.id, "B");
  assert.match(prompt, /lead member last to consolidate/);
  assert.equal(data.privateDeliveries[0].recipient.id, "B");
  assert.equal(data.privateDeliveries[0].content, undefined);
  assert.doesNotMatch(prompt, /Private conversation secret/);
  assert.throws(() => validateGroupDecision({ memberId: "C", triggerMessageIds: ["secret"] }, group, context), /inaccessible/);
  assert.deepEqual(validateGroupDecision({ memberId: "B", triggerMessageIds: ["secret"] }, group, context).memberIds, ["B"]);
  assert.notEqual(groupControllerSessionId("g"), groupMemberSessionId("g", "controller"));
  assert.notEqual(groupControllerSessionId("g"), groupControllerSessionId("other"));
});

test("group lead falls back to the first valid member for legacy or stale settings", () => {
  const members = [bot("A"), bot("B")];
  assert.equal(groupLeadMember({ name: "Team", members })?.id, "A");
  assert.equal(groupLeadMember({ name: "Team", leadMemberId: "B", members })?.id, "B");
  assert.equal(groupLeadMember({ name: "Team", leadMemberId: "missing", members })?.id, "A");
});

test("stopping during dispatch never starts the selected member", async () => {
  const abort = new AbortController();
  const group = { name: "Team", members: [bot("A")] };
  await runGroupConversation({ group, user: chatMessage("u", "Start", "user"), signal: abort.signal,
    decide: async () => { abort.abort(); return { memberId: "A", triggerMessageIds: ["u"] }; },
    reply: async () => { assert.fail("dispatch was cancelled"); },
  });
});

test("stopping during a reply or a failed reply prevents further model calls", async () => {
  const group = { name: "Team", members: [bot("A")] };
  for (const failed of [false, true]) {
    const abort = new AbortController();
    let decisions = 0;
    await runGroupConversation({ group, user: chatMessage("u", "Start", "user"), signal: abort.signal,
      decide: async () => { decisions++; return { memberId: "A", triggerMessageIds: ["u"] }; },
      reply: async () => { if (!failed) abort.abort(); return { messages: [], failed }; },
    });
    assert.equal(decisions, 1);
  }
});

test("the execution guard bounds an oversized sequential route", async () => {
  const group = { name: "Team", members: [bot("A")] };
  let calls = 0;
  const result = await runGroupConversation({ group, user: chatMessage("u", "Start", "user"), signal: new AbortController().signal,
    decide: async () => ({ mode: "sequential", memberIds: Array(GROUP_MAX_TURNS + 1).fill("A"), triggerMessageIds: ["u"] }),
    reply: async () => { calls++; return []; },
  });
  assert.equal(calls, GROUP_MAX_TURNS);
  assert.equal(result.limited, true);
});

test("separate replies keep sender attribution, unique IDs, tools, and final errors", () => {
  const item: AgentMessage = { ...chatMessage("reply", "work log and response"), sender: { id: "A", name: "A" }, error: "interrupted", durationMs: 300,
    parts: [{ kind: "text", text: "Reading files" }, { kind: "tool", id: "t", title: "Read", status: "completed" },
      { kind: "text", text: "First\n<!-- message_break -->\n@B Second" }] };
  const replies = splitGroupReply(item);
  assert.deepEqual(replies.map((reply) => reply.content), ["First", "@B Second"]);
  assert.equal(new Set(replies.map((reply) => reply.id)).size, 2);
  assert.deepEqual(replies.map((reply) => reply.sender), [item.sender, item.sender]);
  assert.equal(replies[0].parts?.[1].kind, "tool");
  assert.deepEqual(replies[0].parts?.at(-1), { kind: "text", text: "First" });
  assert.equal(replies[1].parts, undefined);
  assert.equal(replies[0].error, undefined);
  assert.equal(replies[1].error, "interrupted");
  const toolsOnly = splitGroupReply({ ...item, content: "@B work log", parts: [
    { kind: "text", text: "@B work log" }, { kind: "tool", id: "t", title: "Read" },
  ] });
  assert.equal(toolsOnly[0].content, "");
  assert.equal(toolsOnly[0].parts?.length, 2);
});

test("the model's message separators determine bubble count, preserving paragraphs and code", () => {
  const code = "```html\n<!-- message_break -->\n\n<p>hello</p>\n```";
  assert.deepEqual(splitGroupReply(chatMessage("code", code)).map((reply) => reply.content), [code]);
  const list = "1. First\n\n   Detail\n\n2. Second";
  assert.deepEqual(splitGroupReply(chatMessage("list", list)).map((reply) => reply.content), [list]);
  const paragraphs = ["One", "Two", "Three", "Four", "Five"];
  assert.deepEqual(splitGroupReply(chatMessage("paragraphs", paragraphs.join("\n\n"))).map((reply) => reply.content),
    ["One", "Two", "Three", "Four\n\nFive"]);
  const replies = splitGroupReply(chatMessage("many", paragraphs.join("\n<!-- message_break -->\n")));
  assert.deepEqual(replies.map((reply) => reply.content), ["One", "Two", "Three", "Four\n\nFive"]);
});

test("handoff prompts retain addressed messages and the original request across long rounds", () => {
  const members = [bot("A"), bot("B")];
  const history: AgentMessage[] = [chatMessage("u", "Original request", "user"),
    { ...chatMessage("handoff", "@B Check this"), sender: { id: "A", name: "A" }, recipients: [{ id: "B", name: "B" }] },
    ...Array.from({ length: 10 }, (_, index) => chatMessage(`long-${index}`, "x".repeat(12_000)))];
  const turn = { round: 2, triggerMessageIds: ["handoff"] };
  const context = JSON.parse(groupConversationPrompt({ name: "Team", members }, members[1], history, turn).split("\n").at(-1)!);
  assert.equal(context.originalRequest, "Original request");
  assert.deepEqual(context.turn, turn);
  assert.equal(context.messages.find((message: any) => message.id === "handoff").content, "@B Check this");
  assert.equal(context.messages.find((message: any) => message.id === "handoff").to, "B");
  assert.ok(context.messages.reduce((size: number, message: any) => size + message.content.length, 0) <= 48_000);
});
