import assert from "node:assert/strict";
import test from "node:test";
import { agentInstallCommand, enableAgentAfterInstallLaunch } from "./agentInstall";

test("built-in agents use product-owned official installers", () => {
  for (const id of [
    "claude", "codex", "gemini", "grok", "openclaw", "fastclaw",
    "hermes", "opencode", "cursor", "kimi", "omp",
  ]) {
    assert.ok(agentInstallCommand(id, "posix"), `${id} needs a POSIX installer`);
    assert.ok(agentInstallCommand(id, "windows"), `${id} needs a Windows installer`);
  }
  assert.equal(agentInstallCommand("grok", "posix"), "curl -fsSL https://x.ai/cli/install.sh | bash");
  assert.equal(agentInstallCommand("codex", "windows"), 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"');
  assert.equal(agentInstallCommand("gemini", "posix"), "npm install -g @google/gemini-cli");
});

test("custom agents cannot supply a one-click installer", () => {
  assert.equal(agentInstallCommand("custom-agent", "posix"), undefined);
});

test("a launched install enables only the selected agent", () => {
  const agents = [
    { id: "opencode", enabled: false, name: "OpenCode" },
    { id: "cursor", enabled: false, name: "Cursor" },
    { id: "kimi", enabled: true, name: "Kimi" },
  ];

  const next = enableAgentAfterInstallLaunch(agents, "opencode");

  assert.deepEqual(next.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "opencode", enabled: true },
    { id: "cursor", enabled: false },
    { id: "kimi", enabled: true },
  ]);
  assert.equal(next[1], agents[1]);
  assert.equal(next[2], agents[2]);
});
