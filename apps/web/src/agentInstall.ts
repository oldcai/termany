export type AgentInstallPlatform = "posix" | "windows";

type AgentInstaller = Record<AgentInstallPlatform, string>;

/** Official unattended installers for Termany's built-in terminal agents.
 * Keep this allowlist product-owned: custom commands must never turn into
 * arbitrary one-click shell execution. */
const INSTALLERS: Record<string, AgentInstaller> = {
  claude: {
    posix: "curl -fsSL https://claude.ai/install.sh | bash",
    windows: "irm https://claude.ai/install.ps1 | iex",
  },
  codex: {
    posix: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    windows: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
  },
  gemini: {
    posix: "npm install -g @google/gemini-cli",
    windows: "npm install -g @google/gemini-cli",
  },
  grok: {
    posix: "curl -fsSL https://x.ai/cli/install.sh | bash",
    windows: "irm https://x.ai/cli/install.ps1 | iex",
  },
  openclaw: {
    posix: "curl -fsSL https://openclaw.ai/install.sh | bash",
    windows: "iwr -useb https://openclaw.ai/install.ps1 | iex",
  },
  fastclaw: {
    posix: "curl -fsSL https://raw.githubusercontent.com/fastclaw-ai/fastclaw/main/install.sh | bash",
    // The repository's default branch currently carries the Windows installer;
    // its README still points at a not-yet-published copy on main.
    windows: "powershell -ExecutionPolicy Bypass -Command \"iex(New-Object Net.WebClient).DownloadString('https://raw.githubusercontent.com/fastclaw-ai/fastclaw/dev/install.ps1')\"",
  },
  hermes: {
    posix: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
    windows: "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
  },
  opencode: {
    posix: "curl -fsSL https://opencode.ai/install | bash",
    windows: "npm install -g opencode-ai@latest",
  },
  cursor: {
    posix: "curl https://cursor.com/install -fsS | bash",
    windows: "irm 'https://cursor.com/install?win32=true' | iex",
  },
  kimi: {
    posix: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
    windows: "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
  },
  omp: {
    posix: "curl -fsSL https://omp.sh/install | sh",
    windows: "irm https://omp.sh/install.ps1 | iex",
  },
};

export function currentAgentInstallPlatform(): AgentInstallPlatform {
  return typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "windows" : "posix";
}

export function agentInstallCommand(
  agentId: string,
  platform: AgentInstallPlatform = currentAgentInstallPlatform(),
): string | undefined {
  return INSTALLERS[agentId]?.[platform];
}

/**
 * An explicit install action also opts the agent into Termany. Keep this tied
 * to the install action instead of detection: detection runs whenever Settings
 * opens and must not undo a user's later choice to disable an installed agent.
 */
export function enableAgentAfterInstallLaunch<T extends { id: string; enabled: boolean }>(
  agents: readonly T[],
  agentId: string,
): T[] {
  return agents.map((agent) => (
    agent.id === agentId && !agent.enabled ? { ...agent, enabled: true } : agent
  ));
}
