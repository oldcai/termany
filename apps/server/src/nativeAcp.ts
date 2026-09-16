import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { defaultAgentRuntime } from "@termany/core";
import type { AgentConfig } from "./agentConfig.js";

const execFileAsync = promisify(execFile);
const checked = new Map<string, Promise<void>>();
/** A colorized help line reads as "\x1b[38;5;209macp", whose escape sequence
 *  ends in a word character — so the command name loses its word boundary and
 *  the probe below would read a supported CLI as unsupported. CLIs colorize
 *  whenever the launching environment carries FORCE_COLOR, even off a TTY. */
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const NATIVE_AGENTS = new Set(["gemini", "grok", "kimi", "kilocode", "cursor", "openclaw", "hermes", "omp"]);

/** Some older CLIs treat an unknown `acp` argument as a prompt. Probe help
 * before launching the built-in adapter, so we never send protocol JSON to
 * an interactive agent by accident. Custom adapters keep their own contract. */
export async function checkNativeAcpSupport(agent: AgentConfig, command: string, env: NodeJS.ProcessEnv): Promise<void> {
  const preset = defaultAgentRuntime(agent.id);
  const runtime = agent.runtime;
  if (!NATIVE_AGENTS.has(agent.id) || runtime?.protocol !== "acp" || preset?.protocol !== "acp" ||
      runtime.distribution !== "system" || runtime.command !== preset.command || runtime.args !== preset.args) return;

  const info = await stat(command);
  const key = `${agent.id}:${command}:${info.mtimeMs}:${info.size}`;
  let check = checked.get(key);
  if (!check) {
    check = (async () => {
      const args = agent.id === "grok"
        ? ["agent", "stdio", "--help"]
        : agent.id === "cursor" || agent.id === "kimi" ? ["acp", "--help"] : ["--help"];
      let help: string;
      try {
        const result = await execFileAsync(command, args, { env, timeout: 15_000, maxBuffer: 256_000 });
        help = `${result.stdout}\n${result.stderr}`.replace(ANSI_ESCAPE, "");
      } catch (error) {
        throw new Error(`Cannot start ${agent.name}. Check or reinstall its CLI. ${error instanceof Error ? error.message : String(error)}`);
      }
      const supportsAcp = agent.id === "grok"
        ? /Usage:\s+grok agent stdio\b/i.test(help)
        : agent.id === "gemini" ? /--acp\b/.test(help) : /\bacp\b/i.test(help);
      if (!supportsAcp) {
        throw new Error(`${agent.name}'s installed CLI does not support ACP. Update it to a version that supports ${preset.command} ${preset.args}.`);
      }
    })();
    checked.set(key, check);
    void check.catch(() => checked.delete(key));
  }
  await check;
}
