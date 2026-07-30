/**
 * Drains each web pane's in-page console/network ring and forwards it to the
 * server.
 *
 * Why poll at all, rather than have the page push: the page never sends
 * anything. Rust reads its buffer from outside the content process, which is
 * why a page's Content-Security-Policy cannot interfere — verified against
 * `connect-src 'none'`, where the page's own fetch is blocked and we still get
 * everything. Any push design dies on the first CSP-hardened site.
 *
 * Why always on, rather than only while a panel is open: the point is that an
 * agent can ask "what went wrong" *after* the fact. If collection only ran
 * while someone was watching, the answer would always be "nothing was
 * recorded". A drain is one eval round trip and measures ~0ms.
 */
import { apiPath } from "./api";
import { isTauri } from "./env";

const POLL_MS = 1000;
/** Back off hard when the window is hidden; nothing is watching. */
const HIDDEN_POLL_MS = 10_000;

interface DrainValue {
  href?: string;
  logs?: unknown[];
  net?: unknown[];
  dropped?: { logs?: number; net?: number };
  seq?: number;
}

interface EvalResult {
  ok: boolean;
  value?: DrainValue | null;
  error?: string | null;
}

/**
 * One drain's worth of entries, held until the server confirms receipt. The
 * page ring was already destructively emptied by the drain, so this queue is
 * the only remaining copy — dropping it on a failed POST would lose history.
 */
interface PendingBatch {
  href?: string;
  /** The load these entries belong to, captured at drain time — a retry after
   * a navigation must not relabel old entries with the new load. */
  nav: number;
  logs: unknown[];
  net: unknown[];
  dropped: { logs: number; net: number };
}

/** Bound on queued batches while the server is away; beyond it the oldest is
 * evicted with its counts folded into `dropped`, so loss is reported. */
const MAX_PENDING_BATCHES = 8;

interface PaneEntry {
  label: string;
  nav: number;
  /** The load the server has actually been told about. Below `nav` until a
   * batch carrying the new one is accepted. */
  sentNav: number;
  timer: number;
  stopped: boolean;
  /** Skip a tick already in flight rather than stacking round trips. */
  inFlight: boolean;
  pending: PendingBatch[];
}

const panes = new Map<string, PaneEntry>();

export interface WebPaneStats {
  /** console.error, uncaught exceptions and unhandled rejections. */
  errors: number;
  /** Warnings, counted separately so a badge can rank them lower. */
  warnings: number;
  /** Non-2xx/3xx responses and outright network failures. */
  failedRequests: number;
}

const EMPTY_STATS: WebPaneStats = { errors: 0, warnings: 0, failedRequests: 0 };
const stats = new Map<string, WebPaneStats>();
const listeners = new Map<string, Set<() => void>>();

function bump(paneId: string, logs: unknown[], net: unknown[]): void {
  const current = stats.get(paneId) ?? EMPTY_STATS;
  let { errors, warnings, failedRequests } = current;
  for (const raw of logs) {
    const item = raw as { level?: string; count?: number };
    // Consecutive duplicates were already collapsed page-side; count them all
    // so a render loop reads as "×47", not "×1".
    const n = typeof item.count === "number" && item.count > 0 ? item.count : 1;
    if (item.level === "error") errors += n;
    else if (item.level === "warn") warnings += n;
  }
  for (const raw of net) {
    const item = raw as { ok?: boolean; count?: number };
    // Same collapsing as the logs above: a retry loop against one dead endpoint
    // arrives as a single entry with count=47, not 47 entries.
    const n = typeof item.count === "number" && item.count > 0 ? item.count : 1;
    if (item.ok !== true) failedRequests += n;
  }
  if (errors === current.errors && warnings === current.warnings && failedRequests === current.failedRequests) {
    return;
  }
  // New object each time: useSyncExternalStore compares snapshots by identity.
  stats.set(paneId, { errors, warnings, failedRequests });
  for (const notify of listeners.get(paneId) ?? []) notify();
}

export function webPaneStats(paneId: string): WebPaneStats {
  return stats.get(paneId) ?? EMPTY_STATS;
}

export function subscribeWebPaneStats(paneId: string, notify: () => void): () => void {
  let set = listeners.get(paneId);
  if (!set) {
    set = new Set();
    listeners.set(paneId, set);
  }
  set.add(notify);
  return () => {
    set?.delete(notify);
    if (set && set.size === 0) listeners.delete(paneId);
  };
}

/** Reset the badge counts, e.g. when the user clears the panel. */
export function resetWebPaneStats(paneId: string): void {
  if (!stats.has(paneId)) return;
  stats.delete(paneId);
  for (const notify of listeners.get(paneId) ?? []) notify();
}

async function drainOnce(paneId: string, entry: PaneEntry): Promise<void> {
  if (entry.stopped || entry.inFlight) return;
  entry.inFlight = true;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const result = await invoke<EvalResult>("web_pane_drain", { label: entry.label });
    if (entry.stopped) return;
    const value = result?.value;
    if (value) {
      const logs = Array.isArray(value.logs) ? value.logs : [];
      const net = Array.isArray(value.net) ? value.net : [];
      const dropped = { logs: value.dropped?.logs ?? 0, net: value.dropped?.net ?? 0 };
      if (logs.length || net.length || dropped.logs || dropped.net) {
        // Badges count at drain time, once — a batch retried later must not
        // count again.
        bump(paneId, logs, net);
        entry.pending.push({ href: value.href, nav: entry.nav, logs, net, dropped });
        while (entry.pending.length > MAX_PENDING_BATCHES) {
          const evicted = entry.pending.shift();
          const oldest = entry.pending[0];
          if (evicted && oldest) {
            oldest.dropped.logs += evicted.dropped.logs + evicted.logs.length;
            oldest.dropped.net += evicted.dropped.net + evicted.net.length;
          }
        }
      } else if (entry.nav !== entry.sentNav && entry.pending.at(-1)?.nav !== entry.nav) {
        // A quiet page still has to report that it navigated: the server keeps
        // the previous load as current until a batch says otherwise, and
        // `navOnly` would go on answering with pre-reload entries. Only one
        // such batch is ever queued, so a server that is away cannot fill the
        // queue with them and evict real entries.
        entry.pending.push({
          href: value.href,
          nav: entry.nav,
          logs: [],
          net: [],
          dropped: { logs: 0, net: 0 },
        });
      }
    }
    // Flush in order; a batch leaves the queue only once the server has
    // actually accepted it. Anything else — network failure, restart gap,
    // 4xx/5xx — leaves it queued for the next tick, and the eviction bound
    // above keeps a permanently rejected batch from pinning memory.
    while (entry.pending.length) {
      const batch = entry.pending[0];
      const res = await fetch(apiPath("/api/web/events"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paneId,
          href: batch.href,
          nav: batch.nav,
          logs: batch.logs,
          net: batch.net,
          dropped: batch.dropped,
        }),
      });
      if (!res.ok) break;
      entry.pending.shift();
      entry.sentNav = batch.nav;
    }
  } catch {
    // A pane closing mid-drain, a page mid-navigation, or the server briefly
    // away are all routine here. Unsent batches stay in `pending`; the next
    // tick retries them.
  } finally {
    entry.inFlight = false;
  }
}

function schedule(paneId: string, entry: PaneEntry): void {
  if (entry.stopped) return;
  const delay = typeof document !== "undefined" && document.hidden ? HIDDEN_POLL_MS : POLL_MS;
  entry.timer = window.setTimeout(() => {
    void drainOnce(paneId, entry).finally(() => schedule(paneId, entry));
  }, delay);
}

/**
 * Start draining a pane. Returns a stop function.
 *
 * Safe to call for the same pane twice (the previous watcher is replaced), and
 * a no-op outside Tauri, where the pane is a cross-origin iframe with nothing
 * to read.
 */
export function watchWebPane(paneId: string, label: string): () => void {
  if (!isTauri) return () => {};
  stopWatching(paneId);
  const entry: PaneEntry = {
    label,
    nav: 0,
    sentNav: -1,
    timer: 0,
    stopped: false,
    inFlight: false,
    pending: [],
  };
  panes.set(paneId, entry);
  schedule(paneId, entry);
  return () => stopWatching(paneId);
}

/**
 * Note that the pane navigated, so entries land tagged with the load they
 * belong to — which is what makes "this error is from before the reload"
 * answerable.
 */
export function noteWebPaneNavigation(paneId: string, nav: number): void {
  const entry = panes.get(paneId);
  if (entry) entry.nav = nav;
}

export function stopWatching(paneId: string): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.stopped = true;
  window.clearTimeout(entry.timer);
  panes.delete(paneId);
}
