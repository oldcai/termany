/**
 * Where an ACP agent's models and their credentials actually come from.
 *
 * The picker's model list is the agent's, and so are the API keys behind it:
 * each agent keeps its own config file and its own login. Termany's model
 * settings configure Chat mode and are deliberately kept out of an agent's
 * environment (see agentCredentials.ts on the server), so there is nothing here
 * for Termany to store — only somewhere to point.
 *
 * Only paths and commands verified against the shipped CLIs are listed; an
 * agent missing from here gets the explanation without an invented answer.
 */
export interface AgentModelSetup {
  /** File that holds the agent's model and provider configuration. */
  configPath?: string;
  /** One-shot command that signs the agent in to a provider. */
  loginCommand?: string;
}

const SETUP: { match: RegExp; setup: AgentModelSetup }[] = [
  {
    match: /\bgrok\b/i,
    setup: { configPath: "~/.grok/config.toml", loginCommand: "grok login" },
  },
  {
    match: /\bopencode\b/i,
    setup: { configPath: "~/.config/opencode/opencode.jsonc", loginCommand: "opencode auth login" },
  },
  {
    match: /\bcodex\b/i,
    setup: { configPath: "~/.codex/config.toml", loginCommand: "codex login" },
  },
  {
    match: /\bclaude\b/i,
    setup: { configPath: "~/.claude/settings.json", loginCommand: "claude auth login" },
  },
];

export function agentModelSetup(agent: { id: string; command?: string } | undefined): AgentModelSetup {
  if (!agent) return {};
  const subject = `${agent.id} ${agent.command ?? ""}`;
  return SETUP.find((rule) => rule.match.test(subject))?.setup ?? {};
}
