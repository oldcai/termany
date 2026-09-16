import assert from "node:assert/strict";
import test from "node:test";
import {
  ATLAS_REPAIR_MIN_INTERVAL_MS,
  createGlyphAtlasRepairer,
  onAtlasPagesMerged,
} from "./glyphAtlas";

/** A terminal stand-in that just counts the repairs it was asked to do. */
function fakeTerminal() {
  return { repairs: 0, clearTextureAtlas() { this.repairs++; } };
}

/** Manual clock + scheduler, so cooldown behaviour is asserted, not slept through. */
function harness(terminals: { clearTextureAtlas(): void }[]) {
  let clock = 0;
  const queue: { run: () => void; at: number }[] = [];
  const repairer = createGlyphAtlasRepairer({
    terminals: () => terminals,
    schedule: (run, delayMs) => queue.push({ run, at: clock + delayMs }),
    now: () => clock,
  });
  return {
    repairer,
    queue,
    advance(ms: number) {
      clock += ms;
      for (const task of queue.splice(0)) task.run();
    },
    get clock() {
      return clock;
    },
  };
}

test("a burst of merge signals collapses into a single repair", () => {
  // One page merge fires the event once per merged page (4) and again for every
  // pane forwarding it off the shared atlas, so a single merge in an 8-pane
  // window arrives here ~32 times. Repairing per signal would re-rasterise the
  // whole atlas dozens of times over for one underlying event.
  const term = fakeTerminal();
  const h = harness([term]);

  for (let i = 0; i < 32; i++) h.repairer.requestRepair();
  assert.equal(h.queue.length, 1, "32 signals, one scheduled repair");

  h.advance(0);
  assert.equal(term.repairs, 1);
});

test("a merge repairs every pane, not just the one that noticed", () => {
  // The whole point: panes share one atlas but each holds its own GPU copy of
  // it. The merge invalidates all of them, and clearing the atlas from a single
  // terminal would leave the others drawing with coordinates for a texture that
  // no longer exists — trading one garbled pane for several.
  const terms = [fakeTerminal(), fakeTerminal(), fakeTerminal()];
  const h = harness(terms);

  h.repairer.requestRepair();
  h.advance(0);

  for (const term of terms) assert.equal(term.repairs, 1);
});

test("the first merge repairs without waiting out a cooldown", () => {
  const term = fakeTerminal();
  const h = harness([term]);

  h.repairer.requestRepair();
  assert.equal(h.queue[0].at, 0, "nothing to cool down from yet");
});

test("a merge inside the cooldown is delayed, never dropped", () => {
  // Dropping would be the easy rate limit and the wrong one: a dropped repair
  // leaves that pane garbled until the *next* merge, which may be minutes away.
  const term = fakeTerminal();
  const h = harness([term]);

  h.repairer.requestRepair();
  h.advance(0);
  assert.equal(term.repairs, 1);

  h.advance(100);
  h.repairer.requestRepair();
  assert.equal(
    h.queue[0].at,
    ATLAS_REPAIR_MIN_INTERVAL_MS,
    "held back to one repair per cooldown, measured from the last repair"
  );

  h.advance(ATLAS_REPAIR_MIN_INTERVAL_MS);
  assert.equal(term.repairs, 2, "and it still happens");
});

test("a merge after the cooldown repairs immediately", () => {
  const term = fakeTerminal();
  const h = harness([term]);

  h.repairer.requestRepair();
  h.advance(0);
  h.advance(ATLAS_REPAIR_MIN_INTERVAL_MS);

  h.repairer.requestRepair();
  assert.equal(h.queue[0].at, h.clock);
});

test("panes opened between the merge and the repair are repaired too", () => {
  // The stale-texture damage is done at merge time to every pane sharing the
  // atlas, and a pane attached moments later joins that same atlas — so the
  // pane list is read when the repair runs, not when it was requested.
  const terms = [fakeTerminal()];
  const h = harness(terms);

  h.repairer.requestRepair();
  terms.push(fakeTerminal());
  h.advance(0);

  assert.deepEqual(terms.map((t) => t.repairs), [1, 1]);
});

test("a pane torn down mid-repair does not strand the rest", () => {
  const before = fakeTerminal();
  const after = fakeTerminal();
  const closed = {
    clearTextureAtlas() {
      throw new Error("terminal disposed");
    },
  };
  const h = harness([before, closed, after]);

  h.repairer.requestRepair();
  h.advance(0);

  assert.equal(before.repairs, 1);
  assert.equal(after.repairs, 1, "a dead pane must not eat the panes behind it");
});

// --- reading the merge signal off the addon ---------------------------------

test("the merge signal is read off the addon despite missing typings", () => {
  // @xterm/addon-webgl 0.18 emits onRemoveTextureAtlasCanvas — fired only from
  // a page merge, which is exactly the moment glyph coordinates are rewritten —
  // but leaves it out of its .d.ts.
  const listeners: (() => void)[] = [];
  const addon = {
    onRemoveTextureAtlasCanvas: (listener: () => void) => {
      listeners.push(listener);
      return { dispose() {} };
    },
  };

  let merges = 0;
  const disposable = onAtlasPagesMerged(addon, () => merges++);
  assert.ok(disposable, "subscribed");

  for (const listener of listeners) listener();
  assert.equal(merges, 1);
});

test("an addon without the merge signal degrades quietly", () => {
  // A future addon version may rename or drop it; losing the repair is a
  // rendering glitch, throwing here would cost the pane its GPU renderer.
  assert.equal(onAtlasPagesMerged({}, () => {}), undefined);
  assert.equal(onAtlasPagesMerged({ onRemoveTextureAtlasCanvas: 42 }, () => {}), undefined);
});
