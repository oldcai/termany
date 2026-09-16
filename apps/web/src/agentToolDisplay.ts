import type { AgentPart } from "./state/store";

export type AgentToolKind = "read" | "run" | "search" | "edit" | "delegate" | "other";

export interface AgentToolDisplay {
  kind: AgentToolKind;
  name: string;
  target: string;
  rawDetail?: string;
}

type ToolPart = Extract<AgentPart, { kind: "tool" }>;

function parsedInput(input?: string): Record<string, unknown> {
  if (!input?.trim().startsWith("{")) return {};
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** ACP adapters sometimes put every argument in `title` rather than rawInput.
 * Extract the simple key/value fields without discarding that original title. */
function titleField(title: string, key: string): string {
  const match = new RegExp(`(?:^|[:,]\\s*)${key}:\\s*([\\s\\S]*?)(?=,\\s*[a-zA-Z_][\\w-]*:\\s|$)`, "i").exec(title);
  return match?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

function inputField(part: ToolPart, key: string): string {
  const value = parsedInput(part.input)[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : titleField(part.title, key);
}

function shortPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  const pieces = normalized.split("/").filter(Boolean);
  if (pieces.at(-1)?.toLowerCase() === "skill.md" && pieces.length > 1) return `${pieces.at(-2)}/SKILL.md`;
  return pieces.at(-1) || value;
}

function cleanCommand(value: string): string {
  return value.replace(/^\$\s*/, "").replace(/\s+/g, " ").trim();
}

export function agentToolDisplay(part: ToolPart): AgentToolDisplay {
  const match = /^([a-zA-Z][\w.-]*)(?=\s*:|\s|$)/.exec(part.title.trim());
  const name = ((match?.[1] ?? part.title.trim()) || "tool").toLowerCase();
  const rawArguments = Boolean(match && part.title.slice(match[0].length).trim().startsWith(":"));
  const rawDetail = rawArguments ? part.title : undefined;

  if (/^(read|read_file|memory_get|load|open_file)$/.test(name)) {
    const path = inputField(part, "path") || inputField(part, "file") || inputField(part, "uri");
    return { kind: "read", name, target: shortPath(path) || name, rawDetail };
  }
  if (/^(exec|execute|shell|run|run_command|bash|terminal)$/.test(name)) {
    const command = cleanCommand(inputField(part, "command") || (part.input?.startsWith("$") ? part.input : ""));
    const label = inputField(part, "title");
    return { kind: "run", name, target: command || label || name, rawDetail };
  }
  if (/^(search|grep|rg|find|glob|memory_search)$/.test(name)) {
    const query = inputField(part, "pattern") || inputField(part, "query") || inputField(part, "q");
    const path = inputField(part, "path") || inputField(part, "directory");
    return { kind: "search", name, target: [query, path && shortPath(path)].filter(Boolean).join(" · ") || name, rawDetail };
  }
  if (/^(edit|write|apply_patch|patch|update|progress_card)$/.test(name)) {
    const target = inputField(part, "path") || inputField(part, "file") || inputField(part, "title");
    return { kind: "edit", name, target: target ? shortPath(target) : name.replace(/_/g, " "), rawDetail };
  }
  if (/^(sessions_spawn|spawn|delegate|agent|task)$/.test(name)) {
    const target = inputField(part, "label") || inputField(part, "taskName") || inputField(part, "task");
    return { kind: "delegate", name, target: target || name.replace(/_/g, " "), rawDetail };
  }
  return { kind: "other", name, target: name.replace(/_/g, " "), rawDetail };
}
