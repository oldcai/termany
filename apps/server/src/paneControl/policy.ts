import { DEFAULT_POLICY, type PolicyMode, type Tier } from "@termany/core";

/**
 * Whether a control call is allowed, needs the user asked, or is refused.
 *
 * The rule that must not erode (D9): a token proves "I am a process inside pane
 * X". It does not, on its own, mean "I may drive any pane in any project".
 * Prompt injection is a residual risk no transport can remove — an agent can be
 * talked into making a request it was never meant to make, and the request will
 * arrive perfectly authenticated. Consent, an audit trail and a kill switch are
 * the mitigation, which is why `ask` is the default and `off` is absolute.
 *
 * Crossing a project boundary makes a WRITE prompt, every time, even for a pane
 * the caller created itself — only an explicit `allow-all` skips it. Reading
 * across the boundary does not prompt: an agent that asked for `scope: "global"`
 * has to be able to see what is out there, or the scope would be useless, and
 * discovery is the cheap half. Acting on what it found is the expensive half.
 */

export type Operation = "read" | "write";

export type Decision =
  | { kind: "allow" }
  | { kind: "ask"; prompt: string }
  | { kind: "deny"; message: string };

export interface PolicyRequest {
  mode?: PolicyMode;
  operation: Operation;
  /** True when the resolved pane falls outside the caller's project. */
  crossProject: boolean;
  /** For the consent prompt and the audit entry. */
  method: string;
  callerPath: string;
  targetPath: string;
}

/** The audit label for a call. `cross-project` outranks the operation kind,
 *  because leaving the project is the more consequential fact about it. */
export function tierFor(operation: Operation, crossProject: boolean): Tier {
  if (crossProject) return "cross-project";
  return operation;
}

export function decide(req: PolicyRequest): Decision {
  const mode = req.mode ?? DEFAULT_POLICY;

  // The kill switch. No consent path, no exceptions — a user who set this wants
  // the surface gone, not gone-unless-asked-nicely.
  if (mode === "off") {
    return { kind: "deny", message: "pane control is turned off in Settings" };
  }

  if (mode === "allow-all") return { kind: "allow" };

  // Discovery is allowed at any scope; a caller that asked to look outside its
  // project can look. Acting out there is what costs a prompt.
  if (req.operation === "read") return { kind: "allow" };

  if (req.crossProject) {
    return {
      kind: "ask",
      prompt:
        `${req.callerPath} wants to ${req.method} on ${req.targetPath}, ` +
        `which is outside its project`,
    };
  }

  if (mode === "allow-project") return { kind: "allow" };

  return {
    kind: "ask",
    prompt: `${req.callerPath} wants to ${req.method} on ${req.targetPath}`,
  };
}

/** Is this mode one where nothing at all gets through? */
export function isDisabled(mode: PolicyMode | undefined): boolean {
  return (mode ?? DEFAULT_POLICY) === "off";
}
