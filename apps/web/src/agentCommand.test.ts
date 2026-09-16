import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentCommand, normalizeCustomAgentCommand } from "./agentCommand";

test("terminal launch uses the CLI command rather than conversation runtime settings", () => {
  assert.equal(buildAgentCommand("fastclaw", ""), "fastclaw");
  assert.equal(buildAgentCommand(" claude ", " --dangerously-skip-permissions "), "claude --dangerously-skip-permissions");
});

test("generated custom-agent ids never become commands", () => {
  const id = "685e85a1-c5a3-43df-b152-c0a7fe103a44";
  assert.equal(normalizeCustomAgentCommand(id, id), "");
  assert.equal(normalizeCustomAgentCommand(id, "  my-agent  "), "my-agent");
  assert.equal(normalizeCustomAgentCommand("my-agent", "my-agent"), "my-agent");
});
