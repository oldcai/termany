const STORAGE_KEY = "termany.font-config";

export interface FontConfig {
  family: string;
  size: number;
}

export const DEFAULT_FONT_CONFIG: FontConfig = {
  family: 'Menlo, "SF Mono", Monaco, monospace',
  size: 13,
};

export const MIN_FONT_SIZE = 9;
export const MAX_FONT_SIZE = 32;

export function loadFontConfig(): FontConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed.family === "string" && typeof parsed.size === "number") {
        return {
          family: parsed.family,
          size: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, parsed.size)),
        };
      }
    }
  } catch {
    /* corrupted or missing — fall through to default */
  }
  return { ...DEFAULT_FONT_CONFIG };
}

export function saveFontConfig(config: FontConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}
