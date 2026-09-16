import { apiPath } from "../api";

/** One installed package, as listed by GET /api/codex-themes. */
export interface CodexListing {
  manifest: { id: string; displayName?: string; description?: string; mode?: string };
  artPath: string | null;
  previewPath: string | null;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface FetchCodexListingsOptions {
  /** Cancel retries when the Appearance panel closes. */
  signal?: AbortSignal;
  /** The bundled server can still be starting when the panel first opens. */
  attempts?: number;
  retryDelayMs?: number;
  /** Test seams; production callers use the local API and window.fetch. */
  endpoint?: string;
  request?: FetchLike;
}

function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      globalThis.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

export async function fetchCodexListings(
  options: FetchCodexListingsOptions = {}
): Promise<{ themes: CodexListing[]; root: string | null }> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const request = options.request ?? fetch;
  const endpoint = options.endpoint ?? apiPath("/api/codex-themes");
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await request(endpoint, { cache: "no-store", signal: options.signal });
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`theme service returned invalid JSON (${res.status})`);
      }
      if (!res.ok) {
        const message = (data as { error?: unknown })?.error;
        throw new Error(typeof message === "string" ? message : `theme request failed (${res.status})`);
      }
      if (!Array.isArray((data as { themes?: unknown })?.themes)) {
        throw new Error("theme service returned an invalid response");
      }
      return {
        themes: (data as { themes: CodexListing[] }).themes,
        root: typeof (data as { root?: unknown }).root === "string" ? (data as { root: string }).root : null,
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = error;
      if (attempt < attempts) await retryDelay((options.retryDelayMs ?? 250) * attempt, options.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("failed to load custom themes");
}
