// 127.0.0.1, not `localhost`: the server's primary bind is IPv4 loopback and
// the [::1] listener beside it is best-effort (see BIND_HOST / SECONDARY_BIND
// in apps/server/src/index.ts). Naming the address avoids depending on which
// one `localhost` happens to resolve to — macOS picks ::1 first.
const DEFAULT_WS_URL = "ws://127.0.0.1:5174";

export function apiUrl(): string {
  const configured = import.meta.env.VITE_API_URL || import.meta.env.VITE_PTY_URL || DEFAULT_WS_URL;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(configured) ? configured : `http://${configured}`;
  const normalized = withScheme
    .replace(/^ws:/, "http:")
    .replace(/^wss:/, "https:")
    .replace(/\/+$/, "");
  return normalized || "http://localhost:5174";
}

export function apiPath(path: string): string {
  return `${apiUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
