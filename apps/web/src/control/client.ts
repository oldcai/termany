import { apiUrl } from "../api";
import { terminalSessionId } from "../terminal/manager";
import { useStore } from "../state/store";
import {
  type ControlPane,
  controlPaneIndex,
  indexFingerprint,
  paneHasTerminal,
} from "./paneIndex";

/**
 * The renderer's end of the pane-control channel.
 *
 * A WebSocket rather than polling because the traffic runs both ways: this side
 * pushes a pane index whenever the layout changes, and the server pushes requests
 * that only the renderer can answer. It is also the ownership signal — when this
 * socket closes, the server stops believing these panes exist (D4), which is
 * exactly right for a window that was just closed.
 *
 * Nothing here is authenticated: the connection is loopback-only and passes the
 * same origin guard as the PTY socket. Agent-side calls are the ones that carry
 * a token, and they arrive over HTTP.
 */

type ServerRequest = { type: "request"; id: number; method: string; params: unknown };

/** Handlers Phase 4 fills in (`term.send`, `pane.open`, `web.eval`…). Anything
 *  not in here is answered E_UNSUPPORTED rather than left hanging. */
export type RequestHandler = (params: any) => Promise<unknown>;

const handlers = new Map<string, RequestHandler>();

export function registerControlHandler(method: string, handler: RequestHandler): void {
  handlers.set(method, handler);
}

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;

let socket: WebSocket | null = null;
let reconnectAt = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribe: (() => void) | null = null;
let lastFingerprint = "";
let stopped = false;

function controlUrl(): string {
  return `${apiUrl().replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/control`;
}

function snapshot(): ControlPane[] {
  const state = useStore.getState();
  return controlPaneIndex({
    workspaces: state.workspaces,
    activeWorkspace: state.activeWorkspace,
    sessionIdFor: terminalSessionId,
    hasTerminal: paneHasTerminal,
  });
}

function pushIndex(force = false): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const panes = snapshot();
  const fingerprint = indexFingerprint(panes);
  if (!force && fingerprint === lastFingerprint) return;
  lastFingerprint = fingerprint;
  try {
    socket.send(JSON.stringify({ type: "panes", panes }));
  } catch {
    /* the socket is going away; the reconnect will resend from scratch */
  }
}

async function handleRequest(req: ServerRequest): Promise<void> {
  const reply = (body: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "reply", id: req.id, ...body }));
    }
  };

  const handler = handlers.get(req.method);
  if (!handler) {
    reply({
      ok: false,
      error: { code: "E_UNSUPPORTED", message: `this window cannot do ${req.method}` },
    });
    return;
  }

  try {
    reply({ ok: true, result: await handler(req.params) });
  } catch (e) {
    // A handler that throws must still produce a reply, or the server waits out
    // its whole timeout for an answer that is never coming.
    reply({
      ok: false,
      error: { code: "E_UNSUPPORTED", message: e instanceof Error ? e.message : String(e) },
    });
  }
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectAt);
  reconnectAt = Math.min(reconnectAt * 2, RECONNECT_MAX_MS);
}

function connect(): void {
  if (stopped || socket) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(controlUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    reconnectAt = RECONNECT_MIN_MS;
    // The server has no memory of us across a reconnect, so always resend.
    lastFingerprint = "";
    pushIndex(true);
  };

  ws.onmessage = (event) => {
    let msg: ServerRequest;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg?.type === "request" && typeof msg.id === "number") void handleRequest(msg);
  };

  const drop = () => {
    if (socket === ws) socket = null;
    scheduleReconnect();
  };
  ws.onclose = drop;
  ws.onerror = drop;
}

/**
 * Start mirroring this window's panes to the server. Idempotent, and safe to
 * call before the store has settled — the first push happens on connect.
 */
export function startControlClient(): void {
  stopped = false;
  if (!unsubscribe) {
    // Layout changes are the only thing worth re-pushing for, and the
    // fingerprint check in pushIndex absorbs the unrelated store churn.
    unsubscribe = useStore.subscribe(() => pushIndex());
  }
  connect();
}

export function stopControlClient(): void {
  stopped = true;
  unsubscribe?.();
  unsubscribe = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  socket?.close();
  socket = null;
}
