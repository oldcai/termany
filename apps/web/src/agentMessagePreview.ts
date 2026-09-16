import { Marked, type Token, type Tokens } from "marked";
import { splitAgentRuntimeNotices } from "@termany/core";
import type { AgentMessage, AgentPart } from "./state/store";

/** Keep the work log separate from the answer in both the thread and inbox. */
export function splitAgentMessage(item: AgentMessage): { steps: AgentPart[]; body: string } {
  const parts = item.parts ?? [];
  let lastTool = -1;
  parts.forEach((part, index) => {
    if (part.kind === "tool") lastTool = index;
  });
  if (lastTool < 0) return { steps: [], body: item.content };
  const body = parts.slice(lastTool + 1).map((part) => part.kind === "text" ? part.text : "").join("");
  return { steps: parts.slice(0, lastTool + 1), body };
}

const markdown = new Marked({ gfm: true, breaks: true });
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeText(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    if (!entity.startsWith("#")) return entities[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

/** Extract text from Markdown tokens without inserting links, images or HTML into the row button. */
function tokenText(tokens: Token[]): string {
  return tokens.map((token): string => {
    switch (token.type) {
      case "html":
      case "def":
      case "checkbox": return "";
      case "space":
      case "br":
      case "hr": return " ";
      case "code": return `${token.text} `;
      case "codespan":
      case "escape": return token.text;
      case "list": return (token as Tokens.List).items.map((item) => tokenText(item.tokens)).join(" ") + " ";
      case "table": {
        const table = token as Tokens.Table;
        return [table.header, ...table.rows].map((row) => row.map((cell) => tokenText(cell.tokens)).join(" ")).join(" ") + " ";
      }
      default: {
        const text = "tokens" in token && token.tokens
          ? tokenText(token.tokens)
          : decodeText("text" in token ? token.text : "");
        return ["paragraph", "heading", "blockquote"].includes(token.type) ? text + " " : text;
      }
    }
  }).join("");
}

export function markdownPreview(content: string): string {
  return tokenText(markdown.lexer(content)).replace(/\s+/g, " ").trim();
}

export function latestAssistantPreview(messages: readonly AgentMessage[] = []): { text: string; sender?: AgentMessage["sender"] } | undefined {
  let latest: { message: AgentMessage; text: string } | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || (latest && message.createdAt <= latest.message.createdAt)) continue;
    const { body } = splitAgentMessage(message);
    const text = markdownPreview(splitAgentRuntimeNotices(body).content.trim() || message.error || "");
    if (text) latest = { message, text };
  }
  return latest ? { text: latest.text, sender: latest.message.sender } : undefined;
}
