import type { ControlError } from "@termany/core";
import type { PaneRecord } from "./selectors.js";

/**
 * The bridge between "the server, which answers RPCs" and "a renderer, which
 * owns the panes those RPCs name".
 *
 * Why a socket rather than the server just knowing: panes live in the renderer's
 * store. Their titles, focus, layout and live cwd only exist where React is
 * running. So the server has to ask, which means it needs an outbound channel and
 * an ownership signal that dies with the connection (D4). An agent, by contrast,
 * is a shell process with no lifecycle worth speaking of — it gets plain HTTP.
 *
 * More than one renderer can be attached at once (a desktop window and a browser
 * tab, say), so panes are tracked per host and requests are routed to the host
 * that actually holds the pane. Anything else silently drives the wrong window.
 */

export interface HostConnection {
  send(payload: string): void;
  close(): void;
}

/** Server → renderer. */
export type HostRequest = { type: "request"; id: number; method: string; params: unknown };

/** Renderer → server. */
export type HostMessage =
  | { type: "panes"; panes: PaneRecord[] }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: ControlError };

const DEFAULT_TIMEOUT_MS = 10_000;

/** Cap on panes one host may claim, so a broken client can't exhaust memory. */
const MAX_PANES_PER_HOST = 512;

interface Host {
  id: number;
  conn: HostConnection;
  panes: PaneRecord[];
}

interface Pending {
  hostId: number;
  settle: (value: unknown | ControlError) => void;
  timer: ReturnType<typeof setTimeout>;
}

const noHost = (message: string): ControlError => ({ code: "E_NO_HOST", message });

export class ControlHub {
  private hosts = new Map<number, Host>();
  private pending = new Map<number, Pending>();
  private nextHostId = 1;
  private nextRequestId = 1;

  /** Attach a renderer. The returned `detach` must run on socket close. */
  attach(conn: HostConnection): { hostId: number; detach: () => void } {
    const hostId = this.nextHostId++;
    this.hosts.set(hostId, { id: hostId, conn, panes: [] });
    return { hostId, detach: () => this.detach(hostId) };
  }

  /**
   * Drop a host and fail everything still waiting on it. A renderer that went
   * away cannot answer, and leaving those promises hanging would stall callers
   * until their own timeouts — the disconnect is the more precise signal.
   */
  private detach(hostId: number): void {
    this.hosts.delete(hostId);
    for (const [id, p] of this.pending) {
      if (p.hostId !== hostId) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.settle(noHost("the window holding this pane disconnected"));
    }
  }

  /** Feed one renderer→server frame in. Malformed input is dropped, not thrown:
   *  this runs on a socket handler where a throw would take the connection out. */
  handleMessage(hostId: number, raw: string): void {
    const host = this.hosts.get(hostId);
    if (!host) return;

    let msg: HostMessage;
    try {
      msg = JSON.parse(raw) as HostMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "panes") {
      host.panes = Array.isArray(msg.panes) ? msg.panes.slice(0, MAX_PANES_PER_HOST) : [];
      return;
    }

    if (msg.type === "reply") {
      const p = this.pending.get(msg.id);
      // An unknown id is a reply to something that already timed out. Ignoring it
      // is correct — the caller has long since been answered.
      if (!p || p.hostId !== hostId) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.settle(msg.ok ? msg.result : msg.error);
    }
  }

  /**
   * Every pane across every attached renderer, in host attach order.
   *
   * De-duplicated by pane id, because every window hydrates the same persisted
   * layout: a second window would otherwise make every pane appear twice, which
   * turns unique selectors into E_AMBIGUOUS carrying the same id twice.
   */
  panes(): PaneRecord[] {
    const out: PaneRecord[] = [];
    const seen = new Set<string>();
    for (const host of this.hosts.values()) {
      for (const pane of host.panes) {
        if (seen.has(pane.paneId)) continue;
        seen.add(pane.paneId);
        out.push(pane);
      }
    }
    return out;
  }

  /** Which renderer holds `paneId`. */
  hostFor(paneId: string): number | undefined {
    for (const host of this.hosts.values()) {
      if (host.panes.some((p) => p.paneId === paneId)) return host.id;
    }
    return undefined;
  }

  get hostCount(): number {
    return this.hosts.size;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Ask the renderer holding `paneId` to do something, and wait for its answer.
   * Resolves with the result, or with a ControlError — it does not reject, so
   * every caller handles failure on one path.
   */
  async request(
    paneId: string,
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<unknown | ControlError> {
    const hostId = this.hostFor(paneId);
    if (hostId === undefined) {
      return this.hosts.size === 0
        ? noHost("no Termany window is connected")
        : ({ code: "E_PANE_NOT_MOUNTED", message: `pane ${paneId} is not mounted` } as ControlError);
    }
    return this.requestHost(hostId, method, params, timeoutMs);
  }

  /** As `request`, but aimed at a specific renderer. */
  async requestHost(
    hostId: number,
    method: string,
    params: unknown,
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<unknown | ControlError> {
    const host = this.hosts.get(hostId);
    if (!host) return noHost("no Termany window is connected");

    const id = this.nextRequestId++;
    const frame: HostRequest = { type: "request", id, method, params };

    return new Promise<unknown | ControlError>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          code: "E_TIMEOUT",
          message: `${method} got no answer within ${timeoutMs}ms`,
        } satisfies ControlError);
      }, timeoutMs);
      // Deliberately NOT unref'd. An unref'd timer lets the event loop drain
      // while a request is still outstanding, so the promise never settles —
      // which costs nothing on a server that holds listening sockets anyway, and
      // makes the timeout path untestable.
      this.pending.set(id, { hostId, settle: resolve, timer });

      try {
        host.conn.send(JSON.stringify(frame));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(noHost(`could not reach the window: ${e instanceof Error ? e.message : String(e)}`));
      }
    });
  }
}
