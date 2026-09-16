/** Uppercase Latin section label used by the Bot picker. Accented Latin names
 * join their base letter; names beginning with digits, symbols or another
 * script are collected under `#` after A–Z. */
export function agentLauncherSection(title: string): string {
  const first = title.trim().normalize("NFKD").charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

/** Return a copy so launcher sorting never mutates the store-derived arrays. */
export function sortAgentLauncherRecipients<T extends { title: string }>(recipients: T[]): T[] {
  return [...recipients].sort((a, b) => {
    const sectionA = agentLauncherSection(a.title);
    const sectionB = agentLauncherSection(b.title);
    if (sectionA !== sectionB) {
      if (sectionA === "#") return 1;
      if (sectionB === "#") return -1;
      return sectionA.localeCompare(sectionB, "en");
    }
    return a.title.localeCompare(b.title, "en", { sensitivity: "base", numeric: true });
  });
}
