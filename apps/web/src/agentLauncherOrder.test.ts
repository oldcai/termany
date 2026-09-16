import assert from "node:assert/strict";
import test from "node:test";

import { agentLauncherSection, sortAgentLauncherRecipients } from "./agentLauncherOrder";

test("Bot launcher sorts names alphabetically without case sensitivity", () => {
  const input = ["openclaw001", "hermes001", "termany001", "omp001", "gemini001", "claude001", "codex001", "opencode001", "cursor001", "kimi001"]
    .map((title) => ({ title }));

  assert.deepEqual(
    sortAgentLauncherRecipients(input).map(({ title }) => title),
    ["claude001", "codex001", "cursor001", "gemini001", "hermes001", "kimi001", "omp001", "openclaw001", "opencode001", "termany001"]
  );
});

test("Bot launcher groups accented Latin names by base letter and other names under #", () => {
  assert.equal(agentLauncherSection("  apple"), "A");
  assert.equal(agentLauncherSection("éclair"), "E");
  assert.equal(agentLauncherSection("张三"), "#");
  assert.equal(agentLauncherSection("007"), "#");

  const sorted = sortAgentLauncherRecipients(["张三", "éclair", "apple", "007"].map((title) => ({ title })));
  assert.deepEqual(sorted.map(({ title }) => title), ["apple", "éclair", "007", "张三"]);
});
