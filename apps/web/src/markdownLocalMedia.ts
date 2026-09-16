const MEDIA_EXTENSION = /\.(?:apng|avif|bmp|gif|ico|jpe?g|m4v|mov|mp4|png|svg|webp)$/i;

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolve only absolute local media references emitted in Agent Markdown.
 * Relative paths and web URLs remain normal Markdown links, while file URLs
 * and native POSIX/Windows paths can be served by Termany's media endpoint.
 */
export function localMarkdownMediaPath(value: string): string | undefined {
  const raw = value.trim();
  if (!raw) return undefined;

  const decoded = decodePath(raw);
  let filePath: string;
  if (/^[a-z]:[\\/]/i.test(decoded) || /^\\\\/.test(decoded)) {
    filePath = decoded;
  } else if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol !== "file:") return undefined;
      const pathname = decodePath(url.pathname);
      filePath = url.hostname && url.hostname !== "localhost"
        ? `//${url.hostname}${pathname}`
        : /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
    } catch {
      return undefined;
    }
  } else if (decoded.startsWith("/") && !decoded.startsWith("//")) {
    filePath = decoded;
  } else {
    return undefined;
  }

  return MEDIA_EXTENSION.test(filePath) ? filePath : undefined;
}

export function markdownMediaUrl(value: string, endpoint: string): string | undefined {
  const filePath = localMarkdownMediaPath(value);
  return filePath ? `${endpoint}?path=${encodeURIComponent(filePath)}` : undefined;
}
