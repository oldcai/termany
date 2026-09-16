import type { AgentConversation, AgentMessage } from "./state/store";
import { AGENT_MESSAGE_BREAK, splitAgentReply, visibleAgentMessages } from "./agentMessages";
import { agentMessagePromptContent } from "./agentFileAttachments";
import { privateContext, type AgentPrivateMessage } from "./agentPrivateMessages";

export interface AgentGroup {
  name: string;
  description?: string;
  humanName?: string;
  leadMemberId?: string;
  members: AgentConversation[];
}

/** Legacy groups have no saved lead; their first valid member is the stable default. */
export function groupLeadMember(group: AgentGroup): AgentConversation | undefined {
  return group.members.find((member) => member.id === group.leadMemberId) ?? group.members[0];
}

export interface GroupTurn {
  round: number;
  triggerMessageIds: string[];
  unavailableMemberIds?: string[];
}

export interface GroupReply {
  messages: AgentMessage[];
  privateMessages?: AgentPrivateMessage[];
  failed?: boolean;
}

export interface GroupConversationResult {
  limited: boolean;
  failed: boolean;
  unavailableMemberIds: string[];
}

export interface GroupFailover {
  unavailableMemberIds: string[];
  replacementMemberId: string;
}

// Execution guard only; the model decides when the conversation is complete.
export const GROUP_MAX_TURNS = 24;
export const GROUP_MEMBER_INACTIVITY_TIMEOUT_MS = 90_000;
export const GROUP_MESSAGE_BREAK = AGENT_MESSAGE_BREAK;

/** Exclude code, quoted replies, links and email addresses from mention labels. */
function routingText(content: string): string {
  let fence = "";
  const prose = content.split("\n").map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = "";
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
  return prose.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "");
}

const normalizeName = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
const mentionBoundary = (value: string) => !value || /[\s,，.。!！?？:：;；、()（）\[\]{}<>"“”'‘’「」]/u.test(value);

/** Longest names win, so @Ann never accidentally addresses @Anna. */
export function mentionedGroupMembers(content: string, members: AgentConversation[]): AgentConversation[] {
  const text = normalizeName(routingText(content));
  const candidates = [...members].filter((member) => member.title.trim())
    .sort((a, b) => b.title.length - a.title.length);
  const result = new Set<string>();
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@" || !mentionBoundary(text[index - 1] ?? "")) continue;
    const match = candidates.find((member) => {
      const name = normalizeName(member.title);
      return text.startsWith(name, index + 1) && mentionBoundary(text[index + 1 + name.length] ?? "");
    });
    if (match) {
      result.add(match.id);
      index += normalizeName(match.title).length;
    }
  }
  return [...result].flatMap((id) => members.filter((member) => member.id === id));
}

export function addressesEveryone(content: string): boolean {
  return /(?:^|[\s,，、])@(?:all|everyone|所有成员|所有人|全体成员|大家)(?=$|[\s,，.。!！?？:：;；、])/iu.test(routingText(content));
}

export interface GroupMentionQuery { start: number; end: number; query: string }

/** Keep spaces in the query: names such as “我的 codex” are valid members. */
export function groupMentionQuery(value: string, cursor: number, members: AgentConversation[] = []): GroupMentionQuery | null {
  const before = value.slice(0, cursor);
  const start = before.lastIndexOf("@");
  if (start < 0 || !mentionBoundary(before[start - 1] ?? "")) return null;
  const query = before.slice(start + 1);
  if (query.length > 80 || /[\n@,，。!！?？:：;；]/u.test(query)) return null;
  // Once a complete mention is followed by a space, normal message typing
  // resumes; keep supporting spaces while a member's name is incomplete.
  const normalized = normalizeName(query);
  const continuingName = members.some((member) => normalizeName(member.title).startsWith(normalized));
  if (!continuingName && ["all", "everyone", ...members.map((member) => member.title)].some((name) => {
    const complete = normalizeName(name);
    return normalized.startsWith(complete) && /\s/.test(normalized[complete.length] ?? "");
  })) return null;
  return { start, end: cursor, query };
}

export function insertGroupMention(value: string, query: GroupMentionQuery, name: string) {
  const mention = `@${name} `;
  return { value: value.slice(0, query.start) + mention + value.slice(query.end), cursor: query.start + mention.length };
}

export interface GroupDecision {
  mode: "none" | "single" | "parallel" | "sequential";
  memberIds: string[];
  triggerMessageIds: string[];
}

export interface GroupDecisionContext {
  messages: AgentMessage[];
  privateDeliveries: Omit<AgentPrivateMessage, "content">[];
  completedTurns: (GroupTurn & { memberId: string; messageIds: string[]; privateMessageIds: string[] })[];
  unavailableMemberIds?: string[];
}

/** Validate the transport contract, never infer a recipient or a fallback.
 * The legacy memberId shape stays readable while existing controller sessions
 * age out, but all new prompts request an explicit execution mode. */
export function validateGroupDecision(raw: unknown, group: AgentGroup, context: GroupDecisionContext): GroupDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid group decision");
  const value = raw as Record<string, unknown>;
  const triggerMessageIds = value.triggerMessageIds;
  if (!Array.isArray(triggerMessageIds) || triggerMessageIds.some((id) => typeof id !== "string")) {
    throw new Error("Invalid group decision triggers");
  }
  const legacy = Object.prototype.hasOwnProperty.call(value, "memberId");
  const mode = legacy
    ? value.memberId === null ? "none" : "single"
    : value.mode;
  const memberIds = legacy
    ? value.memberId === null ? [] : [value.memberId]
    : value.memberIds;
  if (!(["none", "single", "parallel", "sequential"] as unknown[]).includes(mode) || !Array.isArray(memberIds) ||
      memberIds.some((id) => typeof id !== "string")) {
    throw new Error("Invalid group decision mode");
  }
  if (mode === "none") {
    if (memberIds.length || triggerMessageIds.length) throw new Error("Invalid empty group decision");
    return { mode, memberIds: [], triggerMessageIds: [] };
  }
  if (!memberIds.length || (mode === "single" && memberIds.length !== 1) ||
      (mode === "parallel" && new Set(memberIds).size !== memberIds.length) ||
      memberIds.some((id) => !group.members.some((member) => member.id === id))) {
    throw new Error("Group decision selected an unknown member");
  }
  const visibleIds = new Set([
    ...context.messages.map((message) => message.id),
    ...context.privateDeliveries.filter((message) => memberIds.every((id) => message.sender.id === id || message.recipient.id === id))
      .map((message) => message.id),
  ]);
  if (!triggerMessageIds.length || triggerMessageIds.some((id) => !visibleIds.has(id))) {
    throw new Error("Group decision selected an inaccessible message");
  }
  return { mode: mode as GroupDecision["mode"], memberIds: memberIds as string[],
    triggerMessageIds: [...new Set(triggerMessageIds as string[])] };
}

/** Explicit addressing is routing, not merely display metadata. */
export function explicitGroupDecision(content: string, group: AgentGroup, triggerMessageId: string): GroupDecision | null {
  const members = addressesEveryone(content) ? group.members : mentionedGroupMembers(content, group.members);
  if (!members.length) return null;
  return {
    mode: members.length === 1 ? "single" : "parallel",
    memberIds: members.map((member) => member.id),
    triggerMessageIds: [triggerMessageId],
  };
}

function handoffsFrom(
  messages: AgentMessage[],
  deliveries: AgentPrivateMessage[],
  group: AgentGroup,
  alreadyScheduled: Set<string>
): { memberId: string; triggerMessageIds: string[] }[] {
  const triggers = new Map<string, Set<string>>();
  const add = (memberId: string, messageId: string, senderId?: string) => {
    if (memberId === senderId || alreadyScheduled.has(memberId)) return;
    const ids = triggers.get(memberId) ?? new Set<string>();
    ids.add(messageId);
    triggers.set(memberId, ids);
  };
  for (const message of messages) {
    for (const member of mentionedGroupMembers(message.content, group.members)) {
      add(member.id, message.id, message.sender?.id);
    }
  }
  for (const delivery of deliveries) {
    if (group.members.some((member) => member.id === delivery.recipient.id)) {
      add(delivery.recipient.id, delivery.id, delivery.sender.id);
    }
  }
  return [...triggers].map(([memberId, ids]) => ({ memberId, triggerMessageIds: [...ids] }));
}

/** Explicit mentions bypass the controller. Ambiguous tasks remain supervised:
 * after explicit public/private handoffs settle, the coordinator checks shared
 * progress and either schedules the next step or declares the task complete. */
export async function runGroupConversation({ group, user, history = [], privateMessages = [], signal, decide, reply, onFailover, maxTurns = GROUP_MAX_TURNS }: {
  group: AgentGroup;
  user: AgentMessage;
  history?: AgentMessage[];
  privateMessages?: AgentPrivateMessage[];
  signal: AbortSignal;
  decide: (context: GroupDecisionContext) => Promise<unknown>;
  reply: (member: AgentConversation, turn: GroupTurn, messages: AgentMessage[]) => Promise<AgentMessage[] | GroupReply>;
  onFailover?: (failover: GroupFailover) => void;
  maxTurns?: number;
}): Promise<GroupConversationResult> {
  const finish = (limited = false, failed = false, unavailable = new Set<string>()): GroupConversationResult => ({
    limited, failed, unavailableMemberIds: [...unavailable],
  });
  const unavailable = new Set<string>();
  const monitoredUnavailable = new Set<string>();
  const lead = groupLeadMember(group);
  const envelope = ({ id, sender, recipient, createdAt }: AgentPrivateMessage) => ({ id, sender, recipient, createdAt });
  const context: GroupDecisionContext = {
    messages: [...history.filter((message) => message.id !== user.id), user],
    privateDeliveries: privateMessages.map(envelope),
    completedTurns: [],
    unavailableMemberIds: [],
  };
  const quarantine = (memberId: string) => {
    unavailable.add(memberId);
    context.unavailableMemberIds = [...unavailable];
  };
  let decision = explicitGroupDecision(user.content, group, user.id);
  let deferredInitialDecision: (Omit<GroupDecision, "mode"> & {
    mode: Exclude<GroupDecision["mode"], "none">;
  }) | undefined;
  const supervised = !decision;
  if (!decision) {
    const raw = await decide({ ...context, messages: [...context.messages],
      privateDeliveries: [...context.privateDeliveries], completedTurns: [] });
    if (signal.aborted) return finish();
    decision = validateGroupDecision(raw, group, context);
    // The controller is intentionally hidden, but an unaddressed group message
    // should still feel owned by the visible lead. Put the lead in front of the
    // controller's initial route while preserving any later lead turn the
    // controller selected for consolidation.
    if (decision.mode !== "none" && lead && decision.memberIds[0] !== lead.id) {
      deferredInitialDecision = { ...decision, mode: decision.mode };
      decision = {
        mode: "single",
        memberIds: [lead.id],
        triggerMessageIds: decision.triggerMessageIds,
      };
    }
  }
  if (decision.mode === "none") return finish();

  let pending: { memberId: string; triggerMessageIds: string[]; unavailableMemberIds?: string[] }[] =
    decision.memberIds.map((memberId) => ({ memberId, triggerMessageIds: decision!.triggerMessageIds }));
  let mode = decision.mode;
  while (pending.length && !signal.aborted) {
    const remaining = maxTurns - context.completedTurns.length;
    if (remaining <= 0) return finish(true, false, unavailable);
    const batch = pending.slice(0, remaining);
    const truncated = batch.length < pending.length;
    const scheduled = new Set(batch.map((item) => item.memberId));
    const batchMessages: AgentMessage[] = [];
    const batchDeliveries: AgentPrivateMessage[] = [];
    const execute = async (item: typeof batch[number], index: number, visible: AgentMessage[], member: AgentConversation) => {
      const turn: GroupTurn = { round: context.completedTurns.length + index + 1,
        triggerMessageIds: item.triggerMessageIds,
        ...(item.unavailableMemberIds?.length ? { unavailableMemberIds: item.unavailableMemberIds } : {}) };
      const rawOutcome = await reply(member, turn, visible);
      const outcome = Array.isArray(rawOutcome) ? { messages: rawOutcome } : rawOutcome;
      return { member, turn, outcome };
    };
    const record = ({ member, turn, outcome }: Awaited<ReturnType<typeof execute>>) => {
      if (outcome.failed) return false;
      const replies = outcome.messages;
      const deliveries = outcome.privateMessages ?? [];
      context.messages.push(...replies);
      context.privateDeliveries.push(...deliveries.map(envelope));
      context.completedTurns.push({ ...turn, memberId: member.id,
        messageIds: replies.map((message) => message.id), privateMessageIds: deliveries.map((message) => message.id) });
      if (member.id === lead?.id && turn.unavailableMemberIds?.length) {
        turn.unavailableMemberIds.forEach((memberId) => monitoredUnavailable.add(memberId));
      }
      batchMessages.push(...replies);
      batchDeliveries.push(...deliveries);
      return true;
    };
    const candidatesFor = (memberId: string, attempted = new Set<string>()) => {
      const preferred = group.members.find((member) => member.id === memberId);
      return [...(preferred ? [preferred] : []), ...group.members.filter((member) => member.id !== memberId)]
        .filter((member) => !unavailable.has(member.id) && !attempted.has(member.id));
    };
    const executeWithFailover = async (item: typeof batch[number], index: number, visible: AgentMessage[],
      initial?: Awaited<ReturnType<typeof execute>>) => {
      const attempted = new Set<string>();
      const failedMemberIds: string[] = [];
      let result = initial;
      if (result) {
        attempted.add(result.member.id);
        if (!result.outcome.failed) return result;
        quarantine(result.member.id);
        failedMemberIds.push(result.member.id);
      }
      while (!signal.aborted) {
        const member = candidatesFor(item.memberId, attempted)[0];
        if (!member) return result;
        attempted.add(member.id);
        result = await execute({ ...item, unavailableMemberIds: [...unavailable] }, index, visible, member);
        if (!result.outcome.failed) {
          if (failedMemberIds.length) {
            onFailover?.({ unavailableMemberIds: failedMemberIds, replacementMemberId: member.id });
          }
          return result;
        }
        quarantine(member.id);
        failedMemberIds.push(member.id);
      }
      return result;
    };

    if (mode === "parallel") {
      const visible = [...context.messages];
      const initial = await Promise.all(batch.map((item, index) => {
        const member = group.members.find((candidate) => candidate.id === item.memberId)!;
        return execute(item, index, visible, member);
      }));
      if (signal.aborted) return finish(false, false, unavailable);
      // Quarantine every failed primary before choosing replacements. Recovery
      // is sequential so one healthy member session is never used concurrently.
      for (const result of initial) if (result.outcome.failed) quarantine(result.member.id);
      for (const result of initial) {
        if (result.outcome.failed) continue;
        record(result);
        scheduled.add(result.member.id);
      }
      let unrecovered = false;
      for (let index = 0; index < initial.length; index++) {
        const first = initial[index];
        if (!first.outcome.failed) continue;
        const result = await executeWithFailover(batch[index], 0, [...context.messages], first);
        if (signal.aborted) return finish(false, false, unavailable);
        if (!result || !record(result)) unrecovered = true;
        else scheduled.add(result.member.id);
      }
      if (unrecovered) return finish(false, true, unavailable);
    } else {
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index];
        const result = await executeWithFailover(item, 0, [...context.messages]);
        if (signal.aborted) return finish(false, false, unavailable);
        if (!result || !record(result)) return finish(false, true, unavailable);
        scheduled.add(result.member.id);
        // A planned later member may receive a public/private handoff from an
        // earlier member. Preserve that delivery as an explicit trigger rather
        // than scheduling the recipient a second time after the sequence.
        const upcoming = new Map(batch.slice(index + 1).map((entry) => [entry.memberId, entry]));
        const completed = new Set(batch.slice(0, index + 1).map((entry) => entry.memberId));
        completed.add(result.member.id);
        const outcome = result.outcome;
        for (const handoff of handoffsFrom(outcome.messages, outcome.privateMessages ?? [], group, completed)) {
          const planned = upcoming.get(handoff.memberId);
          if (planned) planned.triggerMessageIds = [...new Set([...planned.triggerMessageIds, ...handoff.triggerMessageIds])];
        }
      }
    }
    if (truncated) return finish(true, false, unavailable);
    pending = handoffsFrom(batchMessages, batchDeliveries, group, scheduled);
    if (deferredInitialDecision) {
      const deferred = deferredInitialDecision;
      deferredInitialDecision = undefined;
      const plannedIds = new Set(deferred.memberIds);
      const handoffByMember = new Map(pending.map((item) => [item.memberId, item.triggerMessageIds]));
      const additional = pending.filter((item) => !plannedIds.has(item.memberId));
      pending = deferred.memberIds.map((memberId) => ({
        memberId,
        triggerMessageIds: [...new Set([...deferred.triggerMessageIds, ...(handoffByMember.get(memberId) ?? [])])],
      }));
      pending.push(...additional);
      mode = deferred.mode === "single" && additional.length ? "parallel" : deferred.mode;
      continue;
    }
    let failureCoordination: string[] = [];
    if (!pending.length) {
      const unmonitored = [...unavailable].filter((memberId) => !monitoredUnavailable.has(memberId));
      if (unmonitored.length && lead && !unavailable.has(lead.id)) {
        unmonitored.forEach((memberId) => monitoredUnavailable.add(memberId));
        pending = [{ memberId: lead.id,
          triggerMessageIds: [...new Set([user.id, ...batchMessages.map((message) => message.id)])],
          unavailableMemberIds: unmonitored }];
        mode = "single";
        continue;
      }
      // A broken lead cannot supervise publicly. Give the isolated controller
      // one failover-enabled chance to select a healthy recovery owner.
      failureCoordination = unmonitored;
      failureCoordination.forEach((memberId) => monitoredUnavailable.add(memberId));
    }
    if (!pending.length && (supervised || failureCoordination.length)) {
      const raw = await decide({ ...context, messages: [...context.messages],
        privateDeliveries: [...context.privateDeliveries], completedTurns: [...context.completedTurns] });
      if (signal.aborted) return finish(false, false, unavailable);
      const next = validateGroupDecision(raw, group, context);
      if (next.mode === "none") return finish(false, false, unavailable);
      pending = next.memberIds.map((memberId) => ({ memberId, triggerMessageIds: next.triggerMessageIds,
        ...(failureCoordination.length ? { unavailableMemberIds: failureCoordination } : {}) }));
      mode = next.mode;
      continue;
    }
    mode = pending.length > 1 ? "parallel" : "single";
  }
  return finish(false, false, unavailable);
}

/** Coordination is isolated from the lead member's ordinary private/group reply sessions. */
export function groupTopicPaneId(groupId: string, topicId: string): string {
  return `group:${encodeURIComponent(groupId)}:topic:${encodeURIComponent(topicId)}`;
}

export function groupControllerSessionId(groupId: string, topicId?: string): string {
  return topicId
    ? `${groupTopicPaneId(groupId, topicId)}:controller`
    : `group:${encodeURIComponent(groupId)}:controller`;
}

/** Only task-independent dispatch and message transport contracts live here. */
export function groupDecisionPrompt(group: AgentGroup, context: GroupDecisionContext, coordinator = groupLeadMember(group)): string {
  const latestUser = [...context.messages].reverse().find((message) => message.role === "user");
  const messages = sharedGroupMessages(context.messages, latestUser ? [latestUser.id] : []);
  return [
    "You are the lead member supervising this group task. Inspect the request, member profiles, shared results, and completed turns. Choose single for one best next worker, parallel for independent next steps, sequential when later members should see earlier work, or none only when the user's task is complete and the shared transcript already contains a user-facing final result (or when no reply is appropriate). Never repeat completed work. For multi-member work that needs a unified answer, schedule specialists first and the lead member last to consolidate and verify their results. The human participant is identified by human.name. This is a coordination decision, not a participant reply. Use only the supplied context; do not call tools.",
    "Return only JSON with mode (none, single, parallel, or sequential), memberIds (exact member ids, ordered for sequential), and triggerMessageIds (accessible message ids they should respond to; empty only for none). Private delivery envelopes are visible here, but their bodies are available only to their sender and recipient.",
    JSON.stringify({ task: "group_dispatch", group: { name: group.name, description: group.description ?? "" },
      leadMember: coordinator ? { id: coordinator.id, name: coordinator.title, description: coordinator.agentDescription ?? "" } : null,
      members: group.members.map((member) => ({ id: member.id, name: member.title, description: member.agentDescription ?? "" })),
      human: { kind: "human", name: group.humanName?.trim() || "human", privateAddress: "human" }, messages,
      privateDeliveries: context.privateDeliveries.map(({ id, sender, recipient, createdAt }) => ({ id, sender, recipient, createdAt })),
      completedTurns: context.completedTurns, unavailableMemberIds: context.unavailableMemberIds ?? [] }),
  ].join("\n");
}

/** Split chat messages while keeping fenced code and structured Markdown intact. */
export function splitGroupReply(item: AgentMessage): AgentMessage[] {
  return splitAgentReply(item);
}

/** A group member never reuses the Bot's private session or another group's. */
export function groupMemberSessionId(groupId: string, botId: string, topicId?: string): string {
  return topicId
    ? `${groupTopicPaneId(groupId, topicId)}:bot:${encodeURIComponent(botId)}`
    : `group:${encodeURIComponent(groupId)}:bot:${encodeURIComponent(botId)}`;
}

export function groupMemberIds(ids: string[], bots: AgentConversation[], workspaceId: string, firstWorkspaceId: string): string[] {
  return [...new Set(ids)].filter((id) => bots.some((bot) =>
    bot.id === id && !bot.agentGroup && (bot.workspaceId ?? firstWorkspaceId) === workspaceId
  ));
}

function sharedGroupMessages(messages: AgentMessage[], triggerMessageIds: string[] = []) {
  messages = visibleAgentMessages(messages);
  let remaining = 48_000;
  const selected = new Map<string, string>();
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const include = (message: AgentMessage) => {
    if (selected.has(message.id) || (!message.content.trim() && !message.attachments?.length && !message.files?.length) || remaining <= 0) return;
    const imageNote = message.attachments?.length ? `[Attached images: ${message.attachments.length}]` : "";
    const content = [agentMessagePromptContent(message), imageNote].filter(Boolean).join("\n").slice(0, Math.min(12_000, remaining));
    remaining -= content.length;
    selected.set(message.id, content);
  };
  if (latestUser) include(latestUser);
  const triggers = new Set(triggerMessageIds);
  for (const message of [...messages].reverse()) if (triggers.has(message.id)) include(message);
  for (const message of [...messages].reverse()) include(message);
  return messages.filter((message) => selected.has(message.id)).map((message) => ({
    role: message.role,
    // A transcript role is not a display name or an addressable group member.
    speaker: message.role === "assistant" ? message.sender?.name : undefined,
    speakerId: message.role === "assistant" ? message.sender?.id : undefined,
    id: message.id,
    to: message.recipients?.map((recipient) => recipient.name).join(", ") || message.recipient?.name || "everyone",
    content: selected.get(message.id),
  }));
}

/** Each turn carries only this group's shared transcript. Private Bot history
 * is deliberately absent, including when a member joins an existing group. */
export function groupConversationPrompt(group: AgentGroup, speaker: AgentConversation, messages: AgentMessage[], turn?: GroupTurn, privateMessages: AgentPrivateMessage[] = []): string {
  const latestUser = [...messages].reverse().find((message) => message.role === "user");
  const recent = sharedGroupMessages(messages, turn?.triggerMessageIds);
  return [
    "You are the current member in a group conversation. Decide how to respond using the group and member profiles, conversation, and triggering messages in turn. The user role is the human participant described by human; address them by human.name instead of a generic label when natural. members lists the Bots and their identities.",
    "When turn.unavailableMemberIds is present, act as the recovery owner: do not claim those members completed their work; clearly report useful status and reorganize, reassign, or finish the missing work.",
    `Message transport: ordinary text is public. Use ${GROUP_MESSAGE_BREAK} on its own line to separate messages. @names are public addresses; the dispatch model decides who acts next.`,
    "Private delivery: [[private:RECIPIENT_ID]]message[[/private]] sends to a member id; [[private:human]]message[[/private]] sends to the human in your direct chat with an unread notification. Private blocks are removed from the public stream. Multiple private blocks and private-only replies are supported. privateInbox bodies are visible only to their sender and recipient; keep their contents within that audience unless disclosure is authorized. Tool input and output are not private message delivery channels.",
    JSON.stringify({
      group: { name: group.name, description: group.description ?? "" },
      human: { id: "human", name: group.humanName?.trim() || "human", privateAddress: "human" },
      members: group.members.map((member) => ({ id: member.id, name: member.title, description: member.agentDescription ?? "" })),
      mentionTargets: group.members.filter((member) => member.id !== speaker.id && member.title.trim())
        .map((member) => ({ id: member.id, name: member.title })),
      currentBot: { id: speaker.id, name: speaker.title },
      turn,
      originalRequest: latestUser ? agentMessagePromptContent(latestUser).slice(0, 12_000) : undefined,
      messages: recent,
      privateInbox: privateContext(privateMessages, speaker.id, turn?.triggerMessageIds),
    }),
  ].join("\n");
}
