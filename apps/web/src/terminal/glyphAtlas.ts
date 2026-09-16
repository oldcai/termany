/**
 * Repairs the "wrong glyphs everywhere until you drag the split" corruption.
 *
 * xterm's WebGL renderer keeps rasterised glyphs in a texture atlas, and
 * `CharAtlasCache` hands the SAME atlas to every terminal whose font, theme and
 * device pixel ratio match — which here is every pane. Each pane still owns a
 * separate WebGL context, though, so each holds its own GPU copy of every atlas
 * page and re-uploads a page only when it looks stale. "Stale" is decided by
 * comparing `atlas.pages[i].version` against the version this pane last
 * uploaded *for index i*.
 *
 * That comparison is sound while pages only ever gain glyphs, because a page's
 * version only counts up. But once the atlas hits its page budget it merges the
 * four fullest pages into one double-sized page and deletes the originals,
 * which shifts every later page down an index — and rewrites, in place, the
 * texture coordinates of every glyph that moved. Now index i names a different
 * page than it did at this pane's last upload, so the check compares two
 * unrelated counters. They are small integers of similar magnitude, so sooner
 * or later they match, the pane skips the upload it needed, and draws the
 * merged layout's coordinates into a texture still holding the old page.
 *
 * The result is the giveaway symptom: not noise, but specific characters coming
 * out as specific *other* glyphs — every character living on that one page —
 * consistently, and staying that way. Panes that happened to render during the
 * merge are fine; the idle ones rot.
 *
 * Resizing heals it because `handleResize` re-runs `_refreshCharAtlas`, whose
 * `setAtlas` marks every page dirty and forces a full re-upload. Hence "drag
 * the pane and it comes back".
 *
 * So watch for the merge and repair on purpose. `clearTextureAtlas` is xterm's
 * documented remedy for a corrupt texture: it empties the shared atlas, bumps
 * every page version and forces a full redraw. It has to be called on *every*
 * pane — emptying the atlas from one terminal invalidates the coordinates the
 * others are still drawing with, so repairing one pane alone would garble the
 * neighbours it left behind.
 */

/** A disposable subscription, matching xterm's `IDisposable` structurally. */
export interface AtlasSubscription {
  dispose(): void;
}

/** The one method a repair needs; `Terminal` satisfies it. */
export interface RepairableTerminal {
  clearTextureAtlas(): void;
}

/**
 * Floor on how often the atlas may be emptied. A repair throws away every
 * rasterised glyph, so they have to be re-drawn as they reappear on screen —
 * cheap once in a while, but merges arrive in clusters once the atlas is
 * saturated, and without a floor a bad cluster would re-rasterise the visible
 * screen over and over. Requests inside the window are delayed to its end, not
 * discarded: a dropped repair leaves a pane garbled until the next merge.
 */
export const ATLAS_REPAIR_MIN_INTERVAL_MS = 2000;

export interface GlyphAtlasRepairer {
  /** Note that the shared atlas re-indexed its pages. Safe to call in bursts. */
  requestRepair(): void;
}

export function createGlyphAtlasRepairer(options: {
  /** Read when the repair runs, so panes attached in the meantime are covered. */
  terminals: () => Iterable<RepairableTerminal>;
  schedule?: (run: () => void, delayMs: number) => void;
  now?: () => number;
  minIntervalMs?: number;
}): GlyphAtlasRepairer {
  const schedule =
    options.schedule ??
    ((run: () => void, delayMs: number) => {
      window.setTimeout(run, delayMs);
    });
  const now = options.now ?? (() => Date.now());
  const minIntervalMs = options.minIntervalMs ?? ATLAS_REPAIR_MIN_INTERVAL_MS;

  let pending = false;
  let lastRepairAt = -Infinity;

  const repair = () => {
    pending = false;
    lastRepairAt = now();
    for (const terminal of options.terminals()) {
      try {
        terminal.clearTextureAtlas();
      } catch {
        // A pane can be disposed between the merge and this repair. The panes
        // after it in the list still have a stale texture to fix.
      }
    }
  };

  return {
    requestRepair() {
      // The merge fires once per merged page and again through every pane
      // forwarding the shared atlas's event, so one merge lands here dozens of
      // times. Deferring also keeps the repair out of the render pass that
      // triggered the merge, which is still mid-rasterisation.
      if (pending) return;
      pending = true;
      schedule(repair, Math.max(0, minIntervalMs - (now() - lastRepairAt)));
    },
  };
}

type AtlasCanvasEvent = (listener: (canvas: HTMLCanvasElement) => void) => AtlasSubscription;

/**
 * Subscribe to the atlas page merge — the only event that says glyph
 * coordinates were rewritten. `WebglAddon` emits `onRemoveTextureAtlasCanvas`
 * (fired solely from the merge path) but omits it from its typings, so it is
 * read off the instance and ignored if a future version stops emitting it.
 */
export function onAtlasPagesMerged(
  addon: object,
  listener: () => void
): AtlasSubscription | undefined {
  const { onRemoveTextureAtlasCanvas: event } = addon as { onRemoveTextureAtlasCanvas?: unknown };
  if (typeof event !== "function") return undefined;
  return (event as AtlasCanvasEvent).call(addon, () => listener());
}
