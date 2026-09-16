import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SYMBOLS_FONT_FAMILY, withSymbolsFallback } from "./fonts";

test("appends the symbols font ahead of a trailing generic keyword", () => {
  assert.equal(
    withSymbolsFallback('Menlo, "SF Mono", Monaco, monospace'),
    'Menlo, "SF Mono", Monaco, "Symbols Nerd Font Mono", monospace'
  );
});

test("appends at the end when no generic keyword closes the stack", () => {
  assert.equal(withSymbolsFallback("Menlo"), 'Menlo, "Symbols Nerd Font Mono"');
});

test("stays ahead of a run of trailing generics", () => {
  assert.equal(
    withSymbolsFallback("Menlo, ui-monospace, monospace"),
    'Menlo, "Symbols Nerd Font Mono", ui-monospace, monospace'
  );
});

test("leaves the stack alone when the symbols font is already present", () => {
  const stack = 'Menlo, "Symbols Nerd Font Mono", monospace';
  assert.equal(withSymbolsFallback(stack), stack);
});

test("detects an existing entry regardless of quoting and case", () => {
  const stack = "Menlo, symbols nerd font mono";
  assert.equal(withSymbolsFallback(stack), stack);
});

test("is idempotent", () => {
  const once = withSymbolsFallback('Menlo, "SF Mono", monospace');
  assert.equal(withSymbolsFallback(once), once);
});

test("handles an empty stack", () => {
  assert.equal(withSymbolsFallback(""), '"Symbols Nerd Font Mono"');
  assert.equal(withSymbolsFallback("   "), '"Symbols Nerd Font Mono"');
});

test("family name matches the @font-face rule in styles.css", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const face = css.match(/@font-face\s*\{[^}]*\}/)?.[0] ?? "";
  assert.match(face, new RegExp(`font-family:\\s*"${SYMBOLS_FONT_FAMILY}"\\s*;`));
});
