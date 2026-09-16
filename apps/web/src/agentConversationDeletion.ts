import { groupControllerSessionId, groupMemberSessionId } from "./agentGroupChat";
import { directA2ASessionId } from "./agentA2A";
import { agentConversationTopicSessionId } from "./agentGroupTopics";
import type { AgentConversation } from "./state/store";

/**
 * Remove one Bot/group while keeping every remaining group roster valid.
 * Session ids are returned to the store so the state transformation stays
 * deterministic and the imperative runtime cleanup happens in one place.
 */
export function removeAgentConversation(
  conversations: AgentConversation[],
  conversationId: string,
  now = Date.now()
): { conversations: AgentConversation[]; sessionIds: string[] } {
  const target = conversations.find((conversation) => conversation.id === conversationId);
  if (!target) return { conversations, sessionIds: [] };

  const sessionIds = new Set<string>();
  if (target.agentGroup) {
    const topics = target.agentGroup.topics?.length ? target.agentGroup.topics : [undefined];
    topics.forEach((topic) => {
      sessionIds.add(groupControllerSessionId(target.id, topic?.id));
      target.agentGroup!.memberIds.forEach((memberId) => {
        sessionIds.add(groupMemberSessionId(target.id, memberId, topic?.id));
      });
    });
  } else {
    const targetTopicIds = target.agentTopics?.length
      ? target.agentTopics.map((topic) => topic.id)
      : [undefined];
    targetTopicIds.forEach((topicId) => sessionIds.add(topicId
      ? agentConversationTopicSessionId(target.id, topicId)
      : target.id));
    conversations.forEach((conversation) => {
      if (!conversation.agentGroup && conversation.id !== target.id) {
        targetTopicIds.forEach((topicId) =>
          sessionIds.add(directA2ASessionId(target.id, conversation.id, topicId))
        );
        const sourceTopicIds = conversation.agentTopics?.length
          ? conversation.agentTopics.map((topic) => topic.id)
          : [undefined];
        sourceTopicIds.forEach((topicId) =>
          sessionIds.add(directA2ASessionId(conversation.id, target.id, topicId))
        );
      }
      if (conversation.agentGroup?.memberIds.includes(target.id)) {
        const topics = conversation.agentGroup.topics?.length ? conversation.agentGroup.topics : [undefined];
        const leadMemberId = conversation.agentGroup.leadMemberId ?? conversation.agentGroup.memberIds[0];
        topics.forEach((topic) => {
          sessionIds.add(groupMemberSessionId(conversation.id, target.id, topic?.id));
          if (leadMemberId === target.id) {
            sessionIds.add(groupControllerSessionId(conversation.id, topic?.id));
          }
        });
      }
    });
  }

  return {
    conversations: conversations
      .filter((conversation) => conversation.id !== conversationId)
      .map((conversation) => {
        if (!conversation.agentGroup?.memberIds.includes(conversationId)) return conversation;
        const memberIds = conversation.agentGroup.memberIds.filter((id) => id !== conversationId);
        return {
          ...conversation,
          agentGroup: {
            ...conversation.agentGroup,
            memberIds,
            leadMemberId: (conversation.agentGroup.leadMemberId ?? conversation.agentGroup.memberIds[0]) === conversationId
              ? memberIds[0]
              : conversation.agentGroup.leadMemberId,
          },
          updatedAt: now,
        };
      }),
    sessionIds: [...sessionIds],
  };
}
