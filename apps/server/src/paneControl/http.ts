import {
  type ControlError,
  type ControlResult,
  DEFAULT_SCOPE,
  type PaneTarget,
  type PolicyMode,
  type ResolvedPane,
  type Scope,
  type WhoAmI,
} from "@termany/core";
import type { ControlHub } from "./hub.js";
import type { CallerIdentity, IdentityRegistry } from "./identity.js";
import { decide, isDisabled, type Operation, tierFor } from "./policy.js";
import type { AuditRing } from "./rings.js";
import {
  inScope,
  isControlError,
  listInScope,
  type PaneRecord,
  resolveTarget,
} from "./selectors.js";

/**
 * One dispatcher, called through two skins.
 *
 * `dispatch` is the whole surface: HTTP wraps it for agents (a shell process
 * wants `curl`, not a socket), and the Phase 5 MCP facade will wrap the same
 * function rather than reimplementing it. Keeping that a promise means the
 * authorization and audit path can only exist once — two copies would drift, and
 * the copy that drifted would be the one without the consent check.
 */

export interface DispatchDeps {
  hub: ControlHub;
  identity: IdentityRegistry;
  audit: AuditRing;
  policyMode: () => PolicyMode;
  /** A pane's directory, resolved however the server best can. */
  cwdForPane: (pane: PaneRecord) => Promise<string | undefined>;
  /** Nearest `.git` above `cwd`, else `cwd`. */
  projectRootFor: (cwd: string) => string;
  /** Ask the user to approve one call. Phase 4 wires this to real UI. */
  requestConsent: (prompt: string) => Promise<boolean>;
}

const fail = (code: ControlError["code"], message: string): { ok: false; error: ControlError } => ({
  ok: false,
  error: { code, message },
});

const failWith = (error: ControlError): { ok: false; error: ControlError } => ({ ok: false, error });

/** The wire shape of a pane. Drops the server's internal bookkeeping. */
function toResolved(p: PaneRecord): ResolvedPane {
  return {
    paneId: p.paneId,
    title: p.title,
    view: p.view,
    path: p.path,
    terminalSessionId: p.terminalSessionId,
    cwd: p.cwd,
    projectRoot: p.projectRoot,
    active: p.active,
  };
}

/**
 * Fill in cwd and project root for every pane, which is what scoping runs on.
 *
 * Done for the whole index rather than lazily because `inScope` needs a project
 * root for each pane before it can say which ones the caller may even see. The
 * cost of that is why `cwdForPane` is expected to memoise — resolving a live
 * shell's directory costs a subprocess on macOS.
 */
async function enrich(deps: DispatchDeps, panes: PaneRecord[]): Promise<PaneRecord[]> {
  return Promise.all(
    panes.map(async (p) => {
      const cwd = await deps.cwdForPane(p);
      return { ...p, cwd, projectRoot: cwd ? deps.projectRootFor(cwd) : undefined };
    })
  );
}

/** Which scope a request asked for, defaulting per D11 to the caller's project. */
function requestedScope(params: any): Scope | undefined {
  const s = params?.scope;
  return s === "tab" || s === "page" || s === "workspace" || s === "project" || s === "global"
    ? s
    : undefined;
}

/** Read-only methods never need a write prompt. Everything else does. */
const OPERATION: Record<string, Operation> = {
  "session.whoami": "read",
  "panes.list": "read",
  "panes.resolve": "read",
};

export async function dispatch(
  deps: DispatchDeps,
  caller: CallerIdentity,
  method: string,
  params: any
): Promise<ControlResult<any>> {
  const operation = OPERATION[method];
  if (!operation) return fail("E_UNSUPPORTED", `unknown method: ${method}`);

  const panes = await enrich(deps, deps.hub.panes());
  if (panes.length === 0) {
    return fail("E_NO_HOST", "no Termany window is connected");
  }

  const self = panes.find((p) => p.paneId === caller.paneId);
  if (!self) {
    // The token is valid but its pane is gone (closed, or its window went away).
    return fail(
      "E_PANE_NOT_MOUNTED",
      `the calling pane (${caller.paneId}) is not mounted in any window`
    );
  }

  // The kill switch is absolute and applies before any method's own path —
  // `off` means the surface is gone, not gone-except-for-the-cheap-reads.
  if (isDisabled(deps.policyMode())) {
    deps.audit.record({
      method,
      tier: tierFor(operation, false),
      outcome: "denied",
      callerPaneId: self.paneId,
      callerPath: self.path,
      detail: "E_FORBIDDEN",
    });
    return fail("E_FORBIDDEN", "pane control is turned off in Settings");
  }

  const scope = requestedScope(params);

  if (method === "session.whoami") {
    const project = self.projectRoot;
    const inProject = project
      ? panes.filter((p) => p.projectRoot === project).length
      : 0;
    const who: WhoAmI = {
      paneId: self.paneId,
      terminalSessionId: self.terminalSessionId,
      title: self.title,
      view: self.view,
      path: self.path,
      cwd: self.cwd,
      // No resolvable directory means no project. Saying so beats inventing one:
      // an agent that thinks it has a project root it doesn't have will scope
      // every later call against a directory nobody chose.
      project: { root: project ?? "", paneCount: inProject },
      defaultScope: DEFAULT_SCOPE,
    };
    deps.audit.record({
      method,
      tier: "read",
      outcome: "allowed",
      callerPaneId: self.paneId,
      callerPath: self.path,
    });
    return { ok: true, ...who } as ControlResult<WhoAmI>;
  }

  if (method === "panes.list") {
    const effective = scope ?? DEFAULT_SCOPE;
    const crossProject = effective === "global";
    const verdict = decide({
      mode: deps.policyMode(),
      operation,
      crossProject,
      method,
      callerPath: self.path,
      targetPath: `${effective} scope`,
    });
    if (verdict.kind === "deny") {
      deps.audit.record({
        method,
        tier: tierFor(operation, crossProject),
        outcome: "denied",
        callerPaneId: self.paneId,
        callerPath: self.path,
        detail: "E_FORBIDDEN",
      });
      return fail("E_FORBIDDEN", verdict.message);
    }
    const visible = listInScope(panes, self, effective);
    deps.audit.record({
      method,
      tier: tierFor(operation, crossProject),
      outcome: "allowed",
      callerPaneId: self.paneId,
      callerPath: self.path,
      detail: `${visible.length} panes in ${effective} scope`,
    });
    return {
      ok: true,
      scope: effective,
      panes: visible.map(toResolved),
      resolved: toResolved(self),
    };
  }

  // panes.resolve — hand back exactly what a selector points at, so a caller can
  // check its addressing before doing anything with side effects.
  const target = params?.target as PaneTarget | undefined;
  if (target === undefined) return fail("E_NO_MATCH", "target is required");

  const hit = resolveTarget(panes, self, target, { scope });
  if (isControlError(hit)) {
    deps.audit.record({
      method,
      tier: tierFor(operation, scope === "global"),
      outcome: "error",
      callerPaneId: self.paneId,
      callerPath: self.path,
      detail: hit.code,
    });
    return failWith(hit);
  }

  // The caller's own pane is never "outside its project". Anything else has to
  // share a resolved root — a pane with no resolvable directory counts as
  // outside, matching what `inScope` will and won't show at project scope.
  const crossProject = hit.paneId !== self.paneId && !inScope(hit, self, "project");

  const verdict = decide({
    mode: deps.policyMode(),
    operation,
    crossProject,
    method,
    callerPath: self.path,
    targetPath: hit.path,
  });

  const tier = tierFor(operation, crossProject);

  if (verdict.kind === "deny") {
    deps.audit.record({
      method,
      tier,
      outcome: "denied",
      callerPaneId: self.paneId,
      callerPath: self.path,
      targetPaneId: hit.paneId,
      targetPath: hit.path,
      detail: "E_FORBIDDEN",
    });
    return fail("E_FORBIDDEN", verdict.message);
  }

  if (verdict.kind === "ask") {
    const approved = await deps.requestConsent(verdict.prompt);
    deps.audit.record({
      method,
      tier,
      outcome: approved ? "asked-allowed" : "asked-denied",
      callerPaneId: self.paneId,
      callerPath: self.path,
      targetPaneId: hit.paneId,
      targetPath: hit.path,
    });
    if (!approved) return fail("E_CONSENT_DENIED", "the user declined this request");
  } else {
    deps.audit.record({
      method,
      tier,
      outcome: "allowed",
      callerPaneId: self.paneId,
      callerPath: self.path,
      targetPaneId: hit.paneId,
      targetPath: hit.path,
    });
  }

  return { ok: true, resolved: toResolved(hit) };
}

/** HTTP status for a failed call. Kept here so both skins agree. */
export function statusForError(code: ControlError["code"]): number {
  switch (code) {
    case "E_FORBIDDEN":
    case "E_CONSENT_DENIED":
      return 403;
    case "E_NO_MATCH":
    case "E_PANE_NOT_MOUNTED":
      return 404;
    case "E_AMBIGUOUS":
      return 409;
    case "E_UNSUPPORTED":
      return 400;
    case "E_NO_HOST":
      return 503;
    case "E_TIMEOUT":
      return 504;
  }
}

/** Identify a caller, or say why not. 401 is for "who are you", never for
 *  "you may not" — that distinction is what makes a bad token debuggable. */
export function authenticate(
  identity: IdentityRegistry,
  token: string | undefined
): CallerIdentity | undefined {
  return identity.identify(token);
}
