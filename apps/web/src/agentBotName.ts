/** An agent name is a starting point, not a replacement for a name the user
 * has already chosen. Treat whitespace-only drafts as empty. */
export function botNameAfterAgentSelection(currentName: string, agentName: string): string {
  return currentName.trim() ? currentName : agentName;
}
