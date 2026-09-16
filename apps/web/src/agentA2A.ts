import { activeAgentConversationTopic, agentConversationTopics, allAgentConversationMessages } from "./agentGroupTopics";
import type { AgentConversation, AgentMessage } from "./state/store";

export interface AgentA2AMessage {
  id: string;
  sender: { id: string; name: string };
  recipient: { id: string; name: string };
  content: string;
  createdAt: number;
}

const OPEN = "[[a2a:";
const CLOSE = "[[/a2a]]";

/** A delegated Bot keeps continuity per source/target pair without borrowing
 * either Bot's private direct session or any group-chat session. */
export function directA2ASessionId(sourceBotId: string, targetBotId: string, topicId?: string): string {
  const base = `a2a:${encodeURIComponent(sourceBotId)}:bot:${encodeURIComponent(targetBotId)}`;
  return topicId ? `${base}:topic:${encodeURIComponent(topicId)}` : base;
}

export function a2aInboxStreamingId(recipientId: string): string {
  return `a2a-inbox:${encodeURIComponent(recipientId)}`;
}

/** Hide transport envelopes from the visible reply, including a partial
 * opening marker while the response is still streaming. */
export function parseA2AReply(text: string) {
  const lower = text.toLowerCase();
  const deliveries: { to: string; content: string }[] = [];
  let publicText = "";
  let cursor = 0;
  let incomplete = false;
  let invalid = false;
  while (cursor < text.length) {
    const start = lower.indexOf("[[a2a", cursor);
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
    const header = text.slice(start, headerEnd + 2).match(/^\[\[a2a:([^\]\r\n]+)\]\]$/i);
    const content = text.slice(headerEnd + 2, end).trim();
    if (!header || !content || content.toLowerCase().includes("[[a2a") || content.length > 12_000 || deliveries.length >= 8) invalid = true;
    else deliveries.push({ to: header[1].trim(), content });
    cursor = end + CLOSE.length;
  }
  return { publicText, deliveries, incomplete, invalid };
}

export function a2aReplyMessages(text: string, sender: AgentConversation, peers: AgentConversation[], replyId: string) {
  const parsed = parseA2AReply(text);
  let invalid = parsed.invalid || parsed.incomplete;
  const messages: AgentA2AMessage[] = parsed.deliveries.flatMap((delivery, index) => {
    // Recipient intent belongs to the model. The transport layer accepts only
    // the opaque id it was given in availableBots; it never guesses names.
    const recipient = peers.find((peer) => peer.id === delivery.to);
    const normalizedTitle = recipient?.title.trim().normalize("NFKC").toLocaleLowerCase();
    const duplicateName = recipient && peers.some((peer) => peer.id !== recipient.id &&
      peer.title.trim().normalize("NFKC").toLocaleLowerCase() === normalizedTitle);
    if (!recipient || recipient.id === sender.id || duplicateName) { invalid = true; return []; }
    return [{ id: `${replyId}:a2a:${index}`, sender: { id: sender.id, name: sender.title },
      recipient: { id: recipient.id, name: recipient.title }, content: delivery.content, createdAt: Date.now() }];
  });
  return { messages: invalid ? [] : messages, invalid };
}

export function directA2ASourcePrompt(content: string, source: AgentConversation, peers: AgentConversation[],
  privateContext = ""): string {
  return [
    privateContext,
    "You can send a private Agent-to-Agent message to another Termany Bot.",
    "You—not client-side name-matching rules—must infer which Bot the human intends from the complete availableBots list and the conversation context. Names are arbitrary user input: never assume naming patterns, numeric suffixes, aliases, or prefixes.",
    "If exactly one Bot is clearly intended, use that entry's exact opaque id with this transport syntax: [[a2a:RECIPIENT_ID]]message for that Bot[[/a2a]]. Never put a display name, nickname, partial name, or invented value in RECIPIENT_ID.",
    "If the intent is unclear, no Bot is a reliable match, or multiple Bots could match—including Bots with the same display name—do not emit any A2A envelope. Ask the human one concise question identifying the possible Bots so they can clarify.",
    "Use A2A only when the human asks you to contact, tell, ask, reply to, or delegate to another Bot. Resolve follow-up references from the conversation context. Termany hides the envelope; put a short sending confirmation outside it only after choosing one unambiguous Bot.",
    "Never claim this capability is unavailable. Never expose or quote the transport syntax to the human.",
    JSON.stringify({ currentBot: { id: source.id, name: source.title }, availableBots: peers.map((peer) => ({ id: peer.id, name: peer.title, description: peer.agentDescription ?? "" })) }),
    "Human request:",
    content,
  ].filter(Boolean).join("\n");
}

export function directA2ATargetPrompt(delivery: AgentA2AMessage, target: AgentConversation): string {
  return [
    "You received a private Agent-to-Agent message in Termany.",
    `It came from ${JSON.stringify(delivery.sender.name)} for you, ${JSON.stringify(target.title)}.`,
    "Complete the request and respond directly to the human as yourself. Your response will be delivered to your own conversation inbox.",
    "Message:",
    delivery.content,
  ].join("\n");
}

export function deliverA2AReply(conversations: AgentConversation[], recipientId: string, reply: AgentMessage): AgentConversation[] {
  return conversations.map((conversation) => {
    if (conversation.id !== recipientId || conversation.agentGroup ||
      allAgentConversationMessages(conversation).some((message) => message.id === reply.id)) return conversation;
    const savedReply = { ...reply, content: reply.content.slice(0, 12_000) };
    const unread = conversation.agentUnread ?? allAgentConversationMessages(conversation).filter((message) =>
      message.role === "assistant" && (message.sourceGroup || message.sourceBot) &&
      message.createdAt > (conversation.agentReadAt ?? 0)
    ).length;
    if (conversation.agentTopics?.length) {
      const topics = agentConversationTopics(conversation);
      const activeTopic = activeAgentConversationTopic(conversation) ?? topics[0];
      return {
        ...conversation,
        agentMessages: undefined,
        agentTopics: topics.map((topic) => topic.id === activeTopic.id ? {
          ...topic,
          agentMessages: [...(topic.agentMessages ?? []), savedReply]
            .sort((a, b) => a.createdAt - b.createdAt).slice(-24),
          updatedAt: Math.max(topic.updatedAt, reply.createdAt),
        } : topic),
        agentActiveTopicId: activeTopic.id,
        agentUnread: unread + 1,
        updatedAt: Math.max(conversation.updatedAt, reply.createdAt),
      };
    }
    const messages = [...(conversation.agentMessages ?? []), savedReply]
      .sort((a, b) => a.createdAt - b.createdAt).slice(-24);
    return { ...conversation, agentMessages: messages,
      agentUnread: unread + 1,
      updatedAt: Math.max(conversation.updatedAt, reply.createdAt) };
  });
}
