/**
 * Keep agent conversations on the subscription the agent CLI is already logged
 * into.
 *
 * The Claude and Codex ACP adapters both prefer a credential from the
 * environment over their CLI's stored login, and neither asks first — the
 * `claude` CLI prompts once before honouring an ANTHROPIC_API_KEY, but the SDK
 * the adapter is built on just uses it. So a single `export ANTHROPIC_API_KEY`
 * in ~/.zshrc silently moves every conversation onto per-token billing, which
 * surfaces as an opaque "Credit balance is too low" rather than as a choice the
 * user made.
 *
 * A terminal pane is the user's own shell and keeps whatever they export there.
 * A Termany conversation is ours, and it stays predictable: one agent, one
 * account, the one they logged into.
 */

interface CredentialRule {
  /** Matched against the agent id and its adapter command line. */
  match: RegExp;
  vars: string[];
}

const RULES: CredentialRule[] = [
  { match: /\bclaude\b/i, vars: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] },
  { match: /\bcodex\b/i, vars: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
  // OpenCode is deliberately absent: it has no single subscription to fall back
  // to, and env-provided provider keys are a supported way to configure it.
];

/**
 * Strip the credential variables that would override `agent`'s own login.
 * Returns a copy; `env` is left untouched.
 */
export function subscriptionEnvironment(
  env: NodeJS.ProcessEnv,
  agent: { id: string; runtime?: unknown }
): NodeJS.ProcessEnv {
  const next = { ...env };
  const subject = runtimeSubject(agent);
  for (const rule of RULES) {
    if (!rule.match.test(subject)) continue;
    for (const name of rule.vars) delete next[name];
  }
  return next;
}

/** Which variables would be dropped for `agent` — for logging and tests. */
export function overriddenCredentials(agent: {
  id: string;
  runtime?: unknown;
}): string[] {
  const subject = runtimeSubject(agent);
  return RULES.filter((rule) => rule.match.test(subject)).flatMap((rule) => rule.vars);
}

function runtimeSubject(agent: { id: string; runtime?: unknown }): string {
  const runtime = agent.runtime && typeof agent.runtime === "object"
    ? agent.runtime as { command?: unknown; args?: unknown }
    : {};
  return `${agent.id} ${typeof runtime.command === "string" ? runtime.command : ""} ${
    typeof runtime.args === "string" ? runtime.args : ""
  }`;
}
