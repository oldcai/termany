import { markdownPreview } from "./agentMessagePreview";
import type { AgentConversation, AgentGroupTopic, AgentMessage } from "./state/store";

export const LEGACY_GROUP_TOPIC_ID = "legacy";

export function groupTopicTitle(messages: readonly AgentMessage[] = []): string {
  const firstUser = messages.find((message) => message.role === "user");
  return firstUser ? markdownPreview(firstUser.content).slice(0, 80) : "";
}

/** Topics are shared by private and group conversations. Private Topics live
 * at the conversation level; group Topics remain inside `agentGroup` so saved
 * layouts from before private Topics continue to load without migration. */
export function agentConversationTopics(conversation: AgentConversation): AgentGroupTopic[] {
  const stored = conversation.agentGroup?.topics ?? conversation.agentTopics;
  if (stored?.length) return stored;
  const messages = conversation.agentMessages ?? [];
  const createdAt = messages[0]?.createdAt ?? conversation.createdAt;
  const updatedAt = messages.reduce((latest, message) => Math.max(latest, message.createdAt), createdAt);
  return [{
    id: LEGACY_GROUP_TOPIC_ID,
    title: groupTopicTitle(messages),
    createdAt,
    updatedAt,
    agentMessages: messages,
  }];
}

export function activeAgentConversationTopic(conversation: AgentConversation): AgentGroupTopic | undefined {
  const topics = agentConversationTopics(conversation);
  const activeTopicId = conversation.agentGroup?.activeTopicId ?? conversation.agentActiveTopicId;
  return topics.find((topic) => topic.id === activeTopicId) ?? topics[0];
}

/** A private Topic gets its own runtime session just like every group Topic. */
export function agentConversationTopicSessionId(conversationId: string, topicId: string): string {
  return `conversation:${encodeURIComponent(conversationId)}:topic:${encodeURIComponent(topicId)}`;
}

/** Materialize the pre-Topic transcript as one deterministic topic. This keeps
 * existing group history intact without mutating persisted state during render. */
export function agentGroupTopics(conversation: AgentConversation): AgentGroupTopic[] {
  if (!conversation.agentGroup) return [];
  return agentConversationTopics(conversation);
}

export function activeAgentGroupTopic(conversation: AgentConversation): AgentGroupTopic | undefined {
  return conversation.agentGroup ? activeAgentConversationTopic(conversation) : undefined;
}

export function allAgentConversationMessages(conversation: AgentConversation): AgentMessage[] {
  return agentConversationTopics(conversation).flatMap((topic) => topic.agentMessages ?? []);
}
