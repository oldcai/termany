import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultAgentRuntime } from "@termany/core";
import type { AgentConfig } from "./agentConfig.js";

function usesBuiltInGeminiRuntime(agent: AgentConfig): boolean {
  const preset = defaultAgentRuntime("gemini");
  return agent.id === "gemini" &&
    agent.runtime?.protocol === "acp" &&
    preset?.protocol === "acp" &&
    agent.runtime.distribution === "system" &&
    agent.runtime.command === preset.command &&
    agent.runtime.args === preset.args;
}

/** Google retired Gemini CLI access for personal OAuth accounts on 2026-06-18.
 * Inspect only the selected auth type so those accounts are not offered as a
 * working Bot runtime. API-key, Vertex and enterprise configurations remain
 * eligible and are validated by Gemini itself when the session starts. */
export async function checkGeminiAuthSupport(
  agent: AgentConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!usesBuiltInGeminiRuntime(agent)) return;
  const home = env.GEMINI_CLI_HOME || path.join(os.homedir(), ".gemini");
  try {
    const settings = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
    if (settings?.security?.auth?.selectedType === "oauth-personal") {
      throw new Error(
        "Gemini CLI no longer supports personal Google accounts. " +
        "Switch Gemini CLI to API-key, Vertex AI, or Code Assist Standard/Enterprise authentication."
      );
    }
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException)?.code === "ENOENT") return;
    throw error;
  }
}
