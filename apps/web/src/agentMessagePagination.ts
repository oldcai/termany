export const AGENT_MESSAGE_PAGE_SIZE = 40;

/** Start at the newest page when a conversation is opened. */
export function latestMessagePageStart(total: number, pageSize = AGENT_MESSAGE_PAGE_SIZE): number {
  return Math.max(0, total - pageSize);
}

/** Reveal one earlier page without changing the newest end of the range. */
export function previousMessagePageStart(currentStart: number, pageSize = AGENT_MESSAGE_PAGE_SIZE): number {
  return Math.max(0, currentStart - pageSize);
}

/** A small grace area prevents tiny trackpad movements from disabling follow mode. */
export function isNearLatestMessage(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  threshold = 80,
): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
