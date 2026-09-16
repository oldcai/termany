import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_SKILL_BUDGET_NOTICE } from "@termany/core";
import { latestAssistantPreview, markdownPreview, splitAgentMessage } from "./agentMessagePreview";
import type { AgentMessage } from "./state/store";

const reply = (content: string, createdAt = 1, extra: Partial<AgentMessage> = {}): AgentMessage =>
  ({ id: String(createdAt), role: "assistant", content, createdAt, ...extra });

test("previews remove Markdown formatting while preserving visible content", () => {
  assert.equal(markdownPreview('**traffic 很地道**，表示网站的“流量”。\n\n*更多*见[说明](https://example.com)。'),
    'traffic 很地道，表示网站的“流量”。 更多见说明。');
  assert.equal(markdownPreview('# 总结\n\n> 已完成\n\n- [x] **翻译**\n- 校对\n\n---'), '总结 已完成 翻译 校对');
  assert.equal(markdownPreview('| 名称 | 状态 |\n| --- | --- |\n| Bot | **就绪** |'), '名称 状态 Bot 就绪');
});

test("previews preserve code, escaped punctuation and filenames", () => {
  assert.equal(markdownPreview('`a_b **literal** &amp;` 与 a_b.txt，\\*文字\\*'), 'a_b **literal** &amp; 与 a_b.txt，*文字*');
  assert.equal(markdownPreview('```sh\necho hello\n```\n\n完成'), 'echo hello 完成');
  assert.equal(markdownPreview('&lt;Bot&gt; &amp; &#x1f44b; &#20320;'), '<Bot> & 👋 你');
});

test("previews use image captions and omit HTML without creating interactive markup", () => {
  assert.equal(markdownPreview('![示例图](https://example.com/a.png) <b>文字</b>'), '示例图 文字');
  assert.equal(markdownPreview('<script>alert(1)</script>\n\n安全文本'), '安全文本');
});

test("previews choose the latest assistant reply, ignoring newer user messages and empty drafts", () => {
  const messages = [reply('旧回复'), reply('**新回复**', 2), reply('最新问题', 3, { role: 'user' }), reply('', 4)];
  assert.equal(latestAssistantPreview(messages)?.text, '新回复');
  assert.equal(latestAssistantPreview([messages[2]]), undefined);
  assert.equal(latestAssistantPreview(), undefined);
});

test("restored history uses reply time and retains the final group bubble on equal timestamps", () => {
  assert.equal(latestAssistantPreview([reply('最新', 5), reply('较旧', 2)])?.text, '最新');
  const sender = { id: 'a', name: '翻译' };
  assert.deepEqual(latestAssistantPreview([reply('第一段', 5, { sender }), reply('最后一段', 5, { sender })]),
    { text: '最后一段', sender });
});

test("preview and conversation share the answer after the final tool call", () => {
  const message = reply('正在查找中间结果最终回复', 2, { parts: [
    { kind: 'text', text: '正在查找' },
    { kind: 'tool', id: 'tool-1', title: '查找' },
    { kind: 'text', text: '中间结果' },
    { kind: 'tool', id: 'tool-2', title: '核对' },
    { kind: 'text', text: '**最终回复**' },
  ] });
  assert.equal(splitAgentMessage(message).steps.length, 4);
  assert.equal(splitAgentMessage(message).body, '**最终回复**');
  assert.equal(latestAssistantPreview([message])?.text, '最终回复');
});

test("errors remain visible, while tool-only messages do not replace the last answer", () => {
  const toolOnly = reply('Working', 2, { parts: [{ kind: 'tool', id: 't', title: 'Running' }] });
  assert.equal(latestAssistantPreview([reply('上一条回复'), toolOnly])?.text, '上一条回复');
  assert.equal(latestAssistantPreview([toolOnly, reply('', 3, { error: 'Failed to authenticate' })])?.text, 'Failed to authenticate');
});

test("saved runtime notices do not appear in conversation previews", () => {
  assert.equal(latestAssistantPreview([reply('实际回复'), reply(CODEX_SKILL_BUDGET_NOTICE, 2)])?.text, '实际回复');
  assert.equal(latestAssistantPreview([reply(`${CODEX_SKILL_BUDGET_NOTICE}\n\n**实际回复**`)])?.text, '实际回复');
});
