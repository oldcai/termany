import assert from "node:assert/strict";
import test from "node:test";
import { agentToolDisplay } from "./agentToolDisplay";

const tool = (title: string, input?: string) => ({ kind: "tool" as const, id: "tool", title, input });

test("compacts verbose tool titles into readable activity rows", () => {
  assert.deepEqual(agentToolDisplay(tool(
    "read: optional: true, path: /Users/me/.agents/skills/frontend-design/SKILL.md, offset: 1, limit: 200"
  )), {
    kind: "read", name: "read", target: "frontend-design/SKILL.md",
    rawDetail: "read: optional: true, path: /Users/me/.agents/skills/frontend-design/SKILL.md, offset: 1, limit: 200",
  });
  assert.equal(agentToolDisplay(tool(
    "exec: title: Inspect files, command: pwd && find . -type f, workdir: /workspace"
  )).target, "pwd && find . -type f");
  assert.deepEqual(agentToolDisplay(tool("memory_get: path: memory/2026-09-12.md, from: 1, lines: 120")), {
    kind: "read", name: "memory_get", target: "2026-09-12.md",
    rawDetail: "memory_get: path: memory/2026-09-12.md, from: 1, lines: 120",
  });
});

test("uses structured inputs when an adapter provides them", () => {
  assert.deepEqual(agentToolDisplay(tool("Search", JSON.stringify({ pattern: "AgentSteps", path: "/repo/src" }))), {
    kind: "search", name: "search", target: "AgentSteps · src", rawDetail: undefined,
  });
});
