export type { ITerminalBackend, ClientMessage } from "./backend.js";
export { WebSocketBackend } from "./ws-backend.js";
export type {
  ControlError,
  ControlErrorCode,
  ControlResult,
  PaneCandidate,
  PaneTarget,
  PaneView,
  PolicyMode,
  ResolvedPane,
  Scope,
  Tier,
  WhoAmI,
} from "./paneControl.js";
export { DEFAULT_POLICY, DEFAULT_SCOPE } from "./paneControl.js";
