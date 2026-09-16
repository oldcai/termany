/** Legacy codex-acp emits this runtime notice as an assistant text chunk. */
export const CODEX_SKILL_BUDGET_NOTICE = "Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.";

/** Remove only this known leading notice. Ordinary warnings, quotes and code
 * belong to the reply and must remain visible. Also cleans older saved replies. */
export function splitAgentRuntimeNotices(text: string): { content: string; notices: string[] } {
  let content = text;
  const notices: string[] = [];
  while (content.trimStart().startsWith(CODEX_SKILL_BUDGET_NOTICE)) {
    const rest = content.trimStart().slice(CODEX_SKILL_BUDGET_NOTICE.length);
    if (rest && !/^\s/.test(rest)) break;
    notices.push(CODEX_SKILL_BUDGET_NOTICE);
    content = rest.replace(/^\s*\n\s*/, "");
  }
  return { content, notices };
}
