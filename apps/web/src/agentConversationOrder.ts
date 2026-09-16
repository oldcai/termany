type ConversationActivity = {
  createdAt: number;
  agentMessages?: readonly { createdAt: number }[];
  agentTopics?: readonly { agentMessages?: readonly { createdAt: number }[] }[];
  agentGroup?: { topics?: readonly { agentMessages?: readonly { createdAt: number }[] }[] };
};

/** Identity/settings edits must not move a conversation ahead of a newer reply. */
export function lastConversationTime(conversation: ConversationActivity): number {
  const messages = conversation.agentGroup?.topics?.length
    ? conversation.agentGroup.topics.flatMap((topic) => topic.agentMessages ?? [])
    : conversation.agentTopics?.length
      ? conversation.agentTopics.flatMap((topic) => topic.agentMessages ?? [])
    : conversation.agentMessages ?? [];
  return messages.length
    ? messages.reduce((latest, message) => Math.max(latest, message.createdAt), -Infinity)
    : conversation.createdAt;
}

/** Running conversations lead the section; idle conversations follow newest-first. */
export function compareConversationActivity(
  left: ConversationActivity,
  right: ConversationActivity,
  leftWorking: boolean,
  rightWorking: boolean
): number {
  if (leftWorking !== rightWorking) return leftWorking ? -1 : 1;
  return lastConversationTime(right) - lastConversationTime(left);
}
