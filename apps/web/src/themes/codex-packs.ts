/**
 * The locally installed CodexThemes packages (~/.codexthemes) as a theme
 * source.
 *
 * These are NOT copied into localStorage: the folder on disk is the single
 * source of truth, and localStorage records only *which* theme is selected.
 * That keeps the Appearance panel honest — built-ins come from the bundle,
 * these come from the folder, and the two lists can't drift into duplicates.
 */
import { apiPath } from "../api";
import { fromCodexTheme } from "./codex-import";
import { fetchCodexListings, type CodexListing } from "./codex-listings";
import { registerTheme } from "./index";
import type { Theme } from "./types";

export { fetchCodexListings, type CodexListing } from "./codex-listings";

/** Theme id a package maps to — stable, so a re-read updates in place. */
export const codexThemeId = (packId: string) => `custom-codex-${packId}`;
export const isCodexPackTheme = (themeId: string) => themeId.startsWith("custom-codex-");

/** Read a package's artwork as a data URL so it can ride along in the Theme. */
async function readArt(artPath: string): Promise<{ mimeType: string; base64: string } | undefined> {
  const res = await fetch(apiPath(`/api/fs/media?path=${encodeURIComponent(artPath)}`));
  if (!res.ok) return undefined;
  const blob = await res.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error("failed to read artwork"));
    fr.readAsDataURL(blob);
  });
  return { mimeType: blob.type || "image/jpeg", base64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}

/** Convert one listing into a Theme and add it to the in-memory registry. */
export async function registerCodexListing(item: CodexListing): Promise<Theme> {
  const art = item.artPath ? await readArt(item.artPath) : undefined;
  return registerTheme(fromCodexTheme({ format: "codex-theme", manifest: item.manifest, art }));
}

/**
 * Re-register the package behind a `custom-codex-…` id, for the startup path
 * where the selected theme lives on disk rather than in the bundle. Returns
 * false when the package is no longer installed.
 */
export async function hydrateCodexTheme(themeId: string): Promise<boolean> {
  try {
    const { themes } = await fetchCodexListings();
    const item = themes.find((t) => codexThemeId(t.manifest.id) === themeId);
    if (!item) return false;
    await registerCodexListing(item);
    return true;
  } catch {
    return false; // server not up yet / folder unreadable — keep the fallback
  }
}
