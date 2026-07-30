/**
 * Durable console/network history for web panes.
 *
 * The page-side ring (see web_pane/instrument.js) is the only collection point
 * a page's Content-Security-Policy cannot interfere with, but it dies with the
 * document — cleared on every navigation and reload, which is exactly the
 * moment you most want the history: right after the reload that reproduced the
 * bug. So the renderer drains it and forwards here.
 *
 * Server-side rather than renderer-side for three reasons:
 *   - an out-of-process reader (an agent over HTTP) must not depend on a
 *     renderer being alive, or mid-reload;
 *   - reads are cursor-based, and a cursor is only meaningful against a store
 *     that outlives the producer;
 *   - the UI panel will read this same ring, which is what makes "the human
 *     sees exactly what the agent sees" structural rather than conventional.
 *
 * This mirrors the house position already stated in apps/web/src/state/sync.ts:
 * "The webview is a reflection of server state now (SQLite), not the source of
 * truth."
 */

/** Console lines, uncaught errors and unhandled rejections. */
export interface ConsoleEntry {
  seq: number;
  at: number;
  nav: number;
  kind: string;
  level: string;
  text: string;
  stack?: string;
  /** Consecutive identical lines are collapsed by the page-side ring. */
  count: number;
}

export interface NetworkEntry {
  seq: number;
  at: number;
  nav: number;
  kind: string;
  method: string;
  url: string;
  status: number;
  ok: boolean;
  ms: number;
  err?: string;
  /** Consecutive identical requests are collapsed by the page-side ring, so a
   * retry loop against one dead endpoint is one entry with count=47. Dropping
   * it here would under-report the failure it exists to show. */
  count: number;
}

export interface WebInspectBatch {
  paneId: string;
  href?: string;
  nav?: number;
  logs?: unknown[];
  net?: unknown[];
  dropped?: { logs?: number; net?: number };
}

export interface WebInspectRead {
  paneId: string;
  href: string;
  logs: ConsoleEntry[];
  net: NetworkEntry[];
  /** Pass back as `since` to get only what is new. */
  cursor: number;
  /** Entries the page or this ring discarded, since the last read. */
  dropped: { logs: number; net: number };
  nav: number;
}

const LOG_MAX = 500;
const NET_MAX = 300;
const TEXT_MAX = 4096;
const URL_MAX = 2048;

interface PaneRing {
  logs: ConsoleEntry[];
  net: NetworkEntry[];
  seq: number;
  nav: number;
  /** The last `nav` the renderer sent, only ever compared for change. The
   * renderer's counter lives in the native pane, which a zen-mode remount
   * rebuilds from zero, so it is not usable as a key on its own. */
  reportedNav: number;
  href: string;
  dropped: { logs: number; net: number };
  /** Wall clock, for pruning. */
  touchedAt: number;
  /**
   * Monotonic, for ordering. Date.now() has millisecond resolution and two
   * panes updated in the same tick would otherwise sort arbitrarily — which a
   * test caught.
   */
  touchSeq: number;
}

const rings = new Map<string, PaneRing>();
let touchSeq = 0;

function ringFor(paneId: string): PaneRing {
  let ring = rings.get(paneId);
  if (!ring) {
    ring = {
      logs: [],
      net: [],
      seq: 0,
      nav: 0,
      reportedNav: -1,
      href: "",
      dropped: { logs: 0, net: 0 },
      touchedAt: Date.now(),
      touchSeq: ++touchSeq,
    };
    rings.set(paneId, ring);
  }
  return ring;
}

function str(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value === undefined ? "" : String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Accept a drained batch. Everything is re-validated and re-clamped here: the
 * payload originated in an arbitrary web page, and the page-side caps are a
 * courtesy, not a guarantee.
 */
export function recordWebEvents(batch: WebInspectBatch): { cursor: number } {
  const ring = ringFor(batch.paneId);
  ring.touchedAt = Date.now();
  ring.touchSeq = ++touchSeq;
  if (typeof batch.href === "string" && batch.href) ring.href = str(batch.href, URL_MAX);
  // Count loads here rather than trusting the reported number: a zen-mode
  // remount builds a fresh native pane whose counter restarts at 0, and reusing
  // a number already worn by retained entries would let `navOnly` mix two loads.
  if (typeof batch.nav === "number" && batch.nav !== ring.reportedNav) {
    ring.reportedNav = batch.nav;
    ring.nav++;
  }
  ring.dropped.logs += num(batch.dropped?.logs);
  ring.dropped.net += num(batch.dropped?.net);

  for (const raw of Array.isArray(batch.logs) ? batch.logs : []) {
    const item = raw as Record<string, unknown>;
    ring.logs.push({
      seq: ++ring.seq,
      at: Date.now(),
      nav: ring.nav,
      kind: str(item.k, 32) || "console",
      level: str(item.level, 16) || "log",
      text: str(item.text, TEXT_MAX),
      stack: item.stack ? str(item.stack, TEXT_MAX) : undefined,
      count: Math.max(1, num(item.count, 1)),
    });
  }
  for (const raw of Array.isArray(batch.net) ? batch.net : []) {
    const item = raw as Record<string, unknown>;
    ring.net.push({
      seq: ++ring.seq,
      at: Date.now(),
      nav: ring.nav,
      kind: str(item.k, 32) || "fetch",
      method: str(item.method, 16) || "GET",
      url: str(item.url, URL_MAX),
      status: num(item.status),
      ok: item.ok === true,
      ms: num(item.ms),
      err: item.err ? str(item.err, 512) : undefined,
      count: Math.max(1, num(item.count, 1)),
    });
  }

  // Drop-oldest, counting what went so a reader can tell a gap from a lull.
  while (ring.logs.length > LOG_MAX) {
    ring.logs.shift();
    ring.dropped.logs++;
  }
  while (ring.net.length > NET_MAX) {
    ring.net.shift();
    ring.dropped.net++;
  }
  return { cursor: ring.seq };
}

/**
 * Read forward from `since`.
 *
 * `dropped` is reported and reset per read, so a caller polling with a cursor
 * learns it missed something instead of silently seeing a shorter list.
 */
export function readWebEvents(
  paneId: string,
  options: { since?: number; limit?: number; navOnly?: boolean } = {}
): WebInspectRead {
  const ring = rings.get(paneId);
  if (!ring) {
    return {
      paneId,
      href: "",
      logs: [],
      net: [],
      cursor: 0,
      dropped: { logs: 0, net: 0 },
      nav: 0,
    };
  }
  const since = num(options.since, 0);
  const limit = Math.max(1, Math.min(num(options.limit, 200), 1000));
  const wanted = (entry: { seq: number; nav: number }) =>
    entry.seq > since && (!options.navOnly || entry.nav === ring.nav);

  // Newest wins when truncating: a caller asking for 50 of 400 wants the
  // recent ones.
  const logs = ring.logs.filter(wanted).slice(-limit);
  const net = ring.net.filter(wanted).slice(-limit);
  const dropped = { ...ring.dropped };
  ring.dropped = { logs: 0, net: 0 };
  return { paneId, href: ring.href, logs, net, cursor: ring.seq, dropped, nav: ring.nav };
}

export function clearWebEvents(paneId: string): void {
  rings.delete(paneId);
}

/** Panes with history, most recently active first. */
export function listWebInspectPanes(): { paneId: string; href: string; entries: number }[] {
  return [...rings.entries()]
    .sort((a, b) => b[1].touchSeq - a[1].touchSeq)
    .map(([paneId, ring]) => ({
      paneId,
      href: ring.href,
      entries: ring.logs.length + ring.net.length,
    }));
}

/**
 * Forget panes nothing has written to in a while.
 *
 * Pane ids are UUIDs that never repeat, so without this the map grows for the
 * life of the process — one entry per web pane ever opened.
 */
export function pruneWebInspect(maxAgeMs = 60 * 60 * 1000, now = Date.now()): number {
  let removed = 0;
  for (const [paneId, ring] of rings) {
    if (now - ring.touchedAt > maxAgeMs) {
      rings.delete(paneId);
      removed++;
    }
  }
  return removed;
}

/** Test seam. */
export function resetWebInspect(): void {
  rings.clear();
  touchSeq = 0;
}
