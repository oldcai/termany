import { splitAgentRuntimeNotices } from "@termany/core";
import type { AgentMessage } from "./state/store";

export const AGENT_MESSAGE_BREAK = "<!-- message_break -->";

const MAX_REPLY_MESSAGES = 4;
const TARGET_REPLY_MESSAGE_LENGTH = 160;
const MESSAGE_BREAK_PATTERN = /^\s*<!--\s*message_break\s*-->\s*$/i;

const toggleCodeFence = (line: string, inCodeBlock: boolean) =>
  /^\s{0,3}(?:`{3,}|~{3,})/.test(line) ? !inCodeBlock : inCodeBlock;

function explicitReplyMessages(reply: string): string[] | null {
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;
  let foundBreak = false;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  for (const line of reply.trim().split("\n")) {
    if (!inCodeBlock && MESSAGE_BREAK_PATTERN.test(line)) {
      foundBreak = true;
      flush();
      continue;
    }
    current.push(line);
    inCodeBlock = toggleCodeFence(line, inCodeBlock);
  }
  flush();
  return foundBreak ? blocks : null;
}

function replyParagraphs(reply: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inCodeBlock = false;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  for (const line of reply.trim().split("\n")) {
    if (!line.trim() && !inCodeBlock) flush();
    else current.push(line);
    inCodeBlock = toggleCodeFence(line, inCodeBlock);
  }
  flush();
  return blocks;
}

function hasStructuredMarkdown(reply: string): boolean {
  return reply.split("\n").some((line) =>
    /^\s{0,3}(?:[-*+]\s+|\d+[.)]\s+|>\s+|#{1,6}\s+)/.test(line) ||
    /^\s*\|.*\|\s*$/.test(line) || /^\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+$/.test(line)
  );
}

function splitLongReplyBlock(block: string): string[] {
  if (block.length <= TARGET_REPLY_MESSAGE_LENGTH || block.includes("```") ||
    block.includes("~~~") || block.includes("\n")) return [block];
  const sentences = block.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+/u)
    .map((sentence) => sentence.trim()).filter(Boolean);
  if (sentences.length < 2) return [block];
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > TARGET_REPLY_MESSAGE_LENGTH) {
      parts.push(current);
      current = sentence;
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) parts.push(current);
  return parts;
}

function limitReplyMessages(parts: string[]): string[] {
  if (parts.length <= MAX_REPLY_MESSAGES) return parts;
  return [...parts.slice(0, MAX_REPLY_MESSAGES - 1), parts.slice(MAX_REPLY_MESSAGES - 1).join("\n\n")];
}

/** Split one model turn into conversational bubbles without breaking fenced
 * code. Explicit separators win; otherwise paragraphs and long prose provide
 * natural boundaries. Tool activity stays attached to the first bubble and a
 * final error stays attached to the last. */
export function splitAgentReply(item: AgentMessage): AgentMessage[] {
  const parts = item.parts ?? [];
  let lastTool = -1;
  parts.forEach((part, index) => { if (part.kind === "tool") lastTool = index; });
  const body = lastTool < 0 ? item.content : parts.slice(lastTool + 1)
    .map((part) => part.kind === "text" ? part.text : "").join("");
  const explicit = explicitReplyMessages(body);
  const automatic = hasStructuredMarkdown(body) ? [body.trim()] : replyParagraphs(body).flatMap(splitLongReplyBlock);
  const blocks = limitReplyMessages(explicit ?? automatic);
  if (!blocks.length) return [lastTool >= 0 ? { ...item, content: body } : item];
  const replyGroupId = blocks.length > 1 ? item.replyGroupId ?? item.id : item.replyGroupId;
  return blocks.map((content, index) => ({
    ...item,
    id: index ? `${item.id}:${index}` : item.id,
    content,
    attachments: index === 0 ? item.attachments : undefined,
    files: index === 0 ? item.files : undefined,
    ...(replyGroupId ? { replyGroupId } : {}),
    parts: index === 0 && lastTool >= 0 ? [...parts.slice(0, lastTool + 1), { kind: "text", text: content }] : undefined,
    botDeliveries: index === blocks.length - 1 ? item.botDeliveries : undefined,
    durationMs: index === 0 ? item.durationMs : undefined,
    error: index === blocks.length - 1 ? item.error : undefined,
  }));
}

/** Give every runtime the same compact messenger response contract. */
export function agentReplyPrompt(prompt: string): string {
  if (/^\s*\/[a-z][\w-]*(?:\s|$)/i.test(prompt)) return prompt;
  return [
    "Reply like a capable person in a messaging app. Match the human's language and answer directly.",
    "A simple answer is one compact message. A richer answer is usually 2–3 messages and never more than 4. Each message should carry one conversational beat and usually contain 1–3 short sentences.",
    `When separate bubbles improve the rhythm, put a line containing exactly ${AGENT_MESSAGE_BREAK} between them. Keep code blocks, tables, and tightly related lists in one message. Never put the separator inside a code block or hidden transport block, quote it, or explain it.`,
    "Avoid unnecessary headings, repeated introductions, and generic offers to do more.",
    "Request and conversation context:",
    prompt,
  ].join("\n");
}

/** Old adapters persisted diagnostics as chat text; filter those on read as
 * well as on arrival so they never appear as speakers or enter group prompts. */
export function visibleAgentMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.flatMap((message) => {
    if (message.role !== "assistant") return [message];
    const content = splitAgentRuntimeNotices(message.content).content;
    const parts = message.parts?.map((part) => part.kind === "text"
      ? { ...part, text: splitAgentRuntimeNotices(part.text).content } : part);
    if (!content.trim() && !message.attachments?.length && !message.files?.length && !message.error && !message.botDeliveries?.length &&
      !parts?.some((part) => part.kind === "tool" || part.text.trim())) return [];
    return [{ ...message, content, parts }];
  });
}
