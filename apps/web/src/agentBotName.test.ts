import assert from "node:assert/strict";
import test from "node:test";
import { botNameAfterAgentSelection } from "./agentBotName";

test("selecting an agent fills an empty Bot name", () => {
  assert.equal(botNameAfterAgentSelection("", "Claude"), "Claude");
  assert.equal(botNameAfterAgentSelection("   ", "Codex"), "Codex");
});

test("selecting an agent preserves a custom Bot name", () => {
  assert.equal(botNameAfterAgentSelection("Release reviewer", "Claude"), "Release reviewer");
});
