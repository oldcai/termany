import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultAgentRuntime } from "@termany/core";
import { checkGeminiAuthSupport } from "./geminiAuth.js";

test("Gemini personal OAuth is rejected while supported auth and custom runtimes remain eligible", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-gemini-auth-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const agent = {
    id: "gemini",
    name: "Gemini",
    command: "gemini",
    args: "",
    enabled: true,
    builtIn: true,
    runtime: defaultAgentRuntime("gemini"),
  };
  const writeAuth = (selectedType: string) => fs.writeFile(
    path.join(directory, "settings.json"),
    JSON.stringify({ security: { auth: { selectedType } } })
  );

  await writeAuth("oauth-personal");
  await assert.rejects(
    checkGeminiAuthSupport(agent, { GEMINI_CLI_HOME: directory }),
    /no longer supports personal Google accounts/
  );
  await checkGeminiAuthSupport(
    { ...agent, runtime: { ...agent.runtime!, distribution: "custom" } },
    { GEMINI_CLI_HOME: directory }
  );
  for (const selectedType of ["gemini-api-key", "vertex-ai", "compute-default-credentials"]) {
    await writeAuth(selectedType);
    await checkGeminiAuthSupport(agent, { GEMINI_CLI_HOME: directory });
  }
});
