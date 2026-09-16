import type { AgentConversation, AgentMessage } from "./state/store";
import { activeAgentConversationTopic, agentConversationTopics, allAgentConversationMessages } from "./agentGroupTopics";

export interface AgentPrivateMessage {
  id: string;
  sender: { id: string; name: string };
  /** "human" is a delivery address, never an @mention alias. */
  recipient: { id: string; name: string };
  content: string;
  createdAt: number;
  /** Group Topics have isolated private routing context as well as public history. */
  topicId?: string;
}

const OPEN = "[[private:";
const CLOSE = "[[/private]]";

/** Fail closed while streaming: even a partial opening marker is withheld.
 * Private blocks never pass through Markdown, work logs or the public history. */
export function parsePrivateReply(text: string) {
  const lower = text.toLowerCase();
  const deliveries: { to: string; content: string }[] = [];
  let publicText = "";
  let cursor = 0;
  let incomplete = false;
  let invalid = false;
  while (cursor < text.length) {
    const start = lower.indexOf("[[private", cursor);
    if (start < 0) {
      const remaining = text.slice(cursor);
      let held = 0;
      for (let size = 1; size < OPEN.length; size++) {
        if (remaining.toLowerCase().endsWith(OPEN.slice(0, size))) held = size;
      }
      publicText += held ? remaining.slice(0, -held) : remaining;
      incomplete = held > 0;
      break;
    }
    publicText += text.slice(cursor, start);
    const headerEnd = lower.indexOf("]]", start);
    const end = lower.indexOf(CLOSE, headerEnd < 0 ? start : headerEnd + 2);
    if (headerEnd < 0 || end < 0) { incomplete = true; break; }
    const header = text.slice(start, headerEnd + 2).match(/^\[\[private:([^\]\r\n]+)\]\]$/i);
    const content = text.slice(headerEnd + 2, end).trim();
    if (!header || !content || content.toLowerCase().includes("[[private") || content.length > 12_000 || deliveries.length >= 20) invalid = true;
    else deliveries.push({ to: header[1].trim(), content });
    cursor = end + CLOSE.length;
  }
  return { publicText, deliveries, incomplete, invalid };
}

export function privateReplyDeliveries(text: string, sender: AgentConversation, members: AgentConversation[], replyId: string, topicId?: string) {
  const parsed = parsePrivateReply(text);
  const messages: AgentPrivateMessage[] = [];
  let invalid = parsed.invalid || parsed.incomplete;
  const normalize = (name: string) => name.normalize("NFKC").toLocaleLowerCase();
  for (const [index, delivery] of parsed.deliveries.entries()) {
    const matches = members.filter((member) => member.id === delivery.to || normalize(member.title) === normalize(delivery.to));
    const recipient = delivery.to === "human" ? { id: "human", name: "" }
      : matches.length === 1 ? { id: matches[0].id, name: matches[0].title } : undefined;
    if (!recipient || recipient.id === sender.id) { invalid = true; continue; }
    messages.push({ id: `${replyId}:private:${index}`, sender: { id: sender.id, name: sender.title },
      recipient, content: delivery.content, createdAt: Date.now(), ...(topicId ? { topicId } : {}) });
  }
  return { messages: invalid ? [] : messages, invalid };
}

export function privateContext(messages: AgentPrivateMessage[], speakerId: string, triggerIds: string[] = []) {
  const visible = messages.filter((message) => message.sender.id === speakerId || message.recipient.id === speakerId);
  const selected = new Map<string, AgentPrivateMessage>();
  let remaining = 24_000;
  const include = (message: AgentPrivateMessage) => {
    if (selected.has(message.id) || remaining <= 0) return;
    const content = message.content.slice(0, remaining);
    remaining -= content.length;
    selected.set(message.id, { ...message, content });
  };
  for (const message of visible) if (triggerIds.includes(message.id)) include(message);
  for (const message of [...visible].reverse()) include(message);
  return visible.flatMap((message) => selected.has(message.id) ? [selected.get(message.id)!] : []);
}

/** One atomic state update stores private traffic and delivers human inbox copies. */
export function deliverPrivateMessages(conversations: AgentConversation[], groupId: string, incoming: AgentPrivateMessage[]): AgentConversation[] {
  const group = conversations.find((conversation) => conversation.id === groupId && conversation.agentGroup);
  if (!group?.agentGroup) return conversations;
  const ids = new Set(group.agentGroup.memberIds);
  const known = new Set((group.agentPrivateMessages ?? []).map((message) => message.id));
  const messages = incoming.filter((message) => {
    if (known.has(message.id) || !ids.has(message.sender.id) ||
      (message.recipient.id !== "human" && !ids.has(message.recipient.id))) return false;
    known.add(message.id);
    return true;
  });
  if (!messages.length) return conversations;
  return conversations.map((conversation) => {
    if (conversation.id === groupId) return { ...conversation,
      agentPrivateMessages: [...(conversation.agentPrivateMessages ?? []), ...messages].slice(-200) };
    const direct = messages.filter((message) => message.sender.id === conversation.id && message.recipient.id === "human");
    if (!direct.length || conversation.agentGroup) return conversation;
    let at = Math.max(Date.now(), ...allAgentConversationMessages(conversation).map((message) => message.createdAt));
    const copies: AgentMessage[] = direct.map((message) => ({
      id: message.id, role: "assistant", content: message.content, createdAt: ++at,
      sourceGroup: { id: group.id, name: group.title },
    }));
    if (conversation.agentTopics?.length) {
      const topics = agentConversationTopics(conversation);
      const activeTopic = activeAgentConversationTopic(conversation) ?? topics[0];
      return {
        ...conversation,
        agentMessages: undefined,
        agentTopics: topics.map((topic) => topic.id === activeTopic.id ? {
          ...topic,
          agentMessages: [...(topic.agentMessages ?? []), ...copies].slice(-24),
          updatedAt: at,
        } : topic),
        agentActiveTopicId: activeTopic.id,
        agentUnread: (conversation.agentUnread ?? unreadAgentMessages(conversation)) + copies.length,
        updatedAt: at,
      };
    }
    return { ...conversation, agentMessages: [...(conversation.agentMessages ?? []), ...copies].slice(-24),
      agentUnread: (conversation.agentUnread ?? unreadAgentMessages(conversation)) + copies.length, updatedAt: at };
  });
}

export function unreadAgentMessages(conversation: AgentConversation): number {
  if (conversation.agentUnread !== undefined) return conversation.agentUnread;
  // Compatibility with conversations saved before explicit unread counters:
  // only proactive private deliveries used to be considered unread.
  const messages = allAgentConversationMessages(conversation);
  return messages.filter((message) => message.sourceGroup && message.role === "assistant" &&
    message.createdAt > (conversation.agentReadAt ?? 0)).length;
}

/** A direct ACP session did not generate the proactive message in the group
 * runtime, so explicitly provide that private context when the human replies. */
export function directReplyPrompt(content: string, history: AgentMessage[]): string {
  const privateMessages = history.filter((message) => message.sourceGroup || message.sourceBot).slice(-12);
  if (!privateMessages.length) return content;
  return ["This is your private conversation with the human. These earlier replies were delivered here from group or Agent-to-Agent work. Use them to understand the human's reply. Do not publish this private conversation elsewhere unless the human asks.",
    JSON.stringify(privateMessages.map((message) => ({ source: message.sourceGroup ?? message.sourceBot, content: message.content.slice(0, 4000) }))),
    "The human now says:", content].join("\n");
}
