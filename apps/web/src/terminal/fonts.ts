/**
 * Bundled icon-fallback font for the terminal.
 *
 * Prompt frameworks (powerlevel10k, starship, oh-my-posh…) and tools like eza
 * emit Nerd Font glyphs from the Unicode Private Use Area. None of the system
 * monospace fonts we default to carry those glyphs, so they rendered as tofu
 * boxes (xterm.js custom-draws the U+E0B0 powerline separators, which is why
 * only the pictographic icons were missing). We ship "Symbols Nerd Font Mono"
 * (see the @font-face in styles.css, font file under src/assets/fonts/) and
 * splice it into the font stack: browsers fall back per-glyph, so letters keep
 * coming from the primary font and only PUA icons reach the symbols font.
 */
export const SYMBOLS_FONT_FAMILY = "Symbols Nerd Font Mono";

/** CSS-wide keywords that resolve to whatever the platform picks — the
 *  symbols font has to sit in front of these to ever be consulted. */
const GENERIC_FAMILIES = new Set([
  "monospace",
  "ui-monospace",
  "system-ui",
  "sans-serif",
  "serif",
]);

function normalize(entry: string): string {
  return entry.trim().replace(/^["']|["']$/g, "").trim().toLowerCase();
}

/**
 * Return `fontFamily` with the bundled symbols font spliced in as a fallback:
 * after every real family (never overriding a font the user picked), but ahead
 * of any trailing generic keywords. Idempotent — an existing entry, however
 * quoted or cased, is left untouched.
 */
export function withSymbolsFallback(fontFamily: string): string {
  const symbols = SYMBOLS_FONT_FAMILY.toLowerCase();
  const entries = fontFamily
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.some((entry) => normalize(entry) === symbols)) return fontFamily;

  let insertAt = entries.length;
  while (insertAt > 0 && GENERIC_FAMILIES.has(normalize(entries[insertAt - 1]))) {
    insertAt -= 1;
  }
  entries.splice(insertAt, 0, `"${SYMBOLS_FONT_FAMILY}"`);
  return entries.join(", ");
}
