export interface OrganizableConversation {
  id: string;
  agentFolderId?: string;
  agentPinned?: boolean;
  agentSortOrder?: number;
}

export interface AgentConversationOrganizationUpdate {
  id: string;
  agentFolderId?: string;
  agentPinned: boolean;
  agentSortOrder: number;
}

/** Manual order applies only inside the same visual section. Conversations
 * without a manual position retain the caller's recency order. */
export function compareConversationOrganization(
  left: OrganizableConversation,
  right: OrganizableConversation
): number {
  const leftOrder = left.agentSortOrder;
  const rightOrder = right.agentSortOrder;
  if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
  if (leftOrder !== undefined) return -1;
  if (rightOrder !== undefined) return 1;
  return 0;
}

/** Return field-level updates for one drag without replacing live transcripts.
 * Pinning preserves the previous folder so unpinning returns the conversation
 * to where it came from. */
export function conversationMoveUpdates(
  conversations: readonly OrganizableConversation[],
  movingId: string,
  target: { folderId?: string; pinned: boolean; beforeId?: string; swapId?: string }
): AgentConversationOrganizationUpdate[] {
  const moving = conversations.find((conversation) => conversation.id === movingId);
  if (!moving) return [];

  const swapped = target.swapId
    ? conversations.find((conversation) => conversation.id === target.swapId)
    : undefined;
  if (swapped && swapped.id !== moving.id) {
    const movingPinned = Boolean(moving.agentPinned);
    const swappedPinned = Boolean(swapped.agentPinned);
    const movingFolderId = movingPinned ? undefined : moving.agentFolderId;
    const swappedFolderId = swappedPinned ? undefined : swapped.agentFolderId;
    const inSection = (conversation: OrganizableConversation, pinned: boolean, folderId?: string) =>
      Boolean(conversation.agentPinned) === pinned && (pinned || conversation.agentFolderId === folderId);
    const updatesFor = (
      section: readonly OrganizableConversation[],
      pinned: boolean,
      folderId?: string
    ) => section.map((conversation, agentSortOrder) => ({
      id: conversation.id,
      agentFolderId: pinned ? conversation.agentFolderId : folderId,
      agentPinned: pinned,
      agentSortOrder,
    }));

    if (movingPinned === swappedPinned && (movingPinned || movingFolderId === swappedFolderId)) {
      const section = conversations.filter((conversation) => inSection(conversation, movingPinned, movingFolderId));
      const movingIndex = section.findIndex((conversation) => conversation.id === moving.id);
      const swappedIndex = section.findIndex((conversation) => conversation.id === swapped.id);
      const destination = [...section];
      [destination[movingIndex], destination[swappedIndex]] = [destination[swappedIndex], destination[movingIndex]];
      return updatesFor(destination, movingPinned, movingFolderId);
    }

    const source = conversations
      .filter((conversation) => inSection(conversation, movingPinned, movingFolderId))
      .map((conversation) => conversation.id === moving.id ? swapped : conversation);
    const destination = conversations
      .filter((conversation) => inSection(conversation, swappedPinned, swappedFolderId))
      .map((conversation) => conversation.id === swapped.id ? moving : conversation);
    return [
      ...updatesFor(source, movingPinned, movingFolderId),
      ...updatesFor(destination, swappedPinned, swappedFolderId),
    ];
  }

  const siblings = conversations.filter((conversation) =>
    conversation.id !== movingId && Boolean(conversation.agentPinned) === target.pinned &&
    (target.pinned || conversation.agentFolderId === target.folderId)
  );
  const beforeIndex = target.beforeId
    ? siblings.findIndex((conversation) => conversation.id === target.beforeId)
    : -1;
  const index = beforeIndex < 0 ? siblings.length : beforeIndex;
  const destination = [...siblings.slice(0, index), moving, ...siblings.slice(index)];
  return destination.map((conversation, agentSortOrder) => ({
    id: conversation.id,
    agentFolderId: conversation.id === movingId && !target.pinned
      ? target.folderId : conversation.agentFolderId,
    agentPinned: target.pinned,
    agentSortOrder,
  }));
}
