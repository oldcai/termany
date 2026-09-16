import assert from "node:assert/strict";
import test from "node:test";
import { createTitleBarGesture, type TitleBarMouse } from "./titleBar";

const at = (x: number, y: number, over: Partial<TitleBarMouse> = {}): TitleBarMouse => ({
  button: 0,
  detail: 1,
  screenX: x,
  screenY: y,
  background: true,
  ...over,
});

test("drags the window from a single press on the bar background", () => {
  const mac = createTitleBarGesture(true);
  assert.equal(mac.down(at(100, 10)), "drag");
  const win = createTitleBarGesture(false);
  assert.equal(win.down(at(100, 10)), "drag");
});

test("macOS zooms on the release of the second click, not its press", () => {
  const g = createTitleBarGesture(true);
  g.down(at(100, 10));
  assert.equal(g.up(at(100, 10)), null);
  // The second press must not start a drag — the native session would swallow
  // the release we zoom on.
  assert.equal(g.down(at(100, 10, { detail: 2 })), null);
  assert.equal(g.up(at(100, 10, { detail: 2 })), "zoom");
});

test("macOS cancels the zoom when the pointer moves off the press", () => {
  const g = createTitleBarGesture(true);
  g.down(at(100, 10, { detail: 2 }));
  assert.equal(g.up(at(140, 10, { detail: 2 })), null);
});

test("macOS tolerates the pixel of jitter a trackpad double-tap produces", () => {
  const g = createTitleBarGesture(true);
  g.down(at(100, 10, { detail: 2 }));
  assert.equal(g.up(at(101, 11, { detail: 2 })), "zoom");
});

test("Windows and Linux zoom on the press, as those title bars do", () => {
  const g = createTitleBarGesture(false);
  assert.equal(g.down(at(100, 10, { detail: 2 })), "zoom");
  assert.equal(g.up(at(100, 10, { detail: 2 })), null);
});

test("ignores presses that land on a tab or button", () => {
  const g = createTitleBarGesture(true);
  assert.equal(g.down(at(100, 10, { background: false })), null);
  assert.equal(g.down(at(100, 10, { detail: 2, background: false })), null);
  assert.equal(g.up(at(100, 10, { detail: 2, background: false })), null);
});

test("ignores non-primary buttons", () => {
  const g = createTitleBarGesture(true);
  assert.equal(g.down(at(100, 10, { button: 2 })), null);
  assert.equal(g.down(at(100, 10, { button: 2, detail: 2 })), null);
});

test("does not zoom on a release the app never armed", () => {
  const g = createTitleBarGesture(true);
  assert.equal(g.up(at(100, 10, { detail: 2 })), null);
});

test("does not zoom when the release lands off the bar background", () => {
  const g = createTitleBarGesture(true);
  g.down(at(100, 10, { detail: 2 }));
  assert.equal(g.up(at(100, 10, { detail: 2, background: false })), null);
});

test("the third press of a burst still drags, the zoom having already fired", () => {
  const g = createTitleBarGesture(true);
  g.down(at(100, 10, { detail: 2 }));
  assert.equal(g.up(at(100, 10, { detail: 2 })), "zoom");
  assert.equal(g.down(at(100, 10, { detail: 3 })), "drag");
});

test("a fresh press after a zoom drags again", () => {
  const g = createTitleBarGesture(true);
  g.down(at(100, 10, { detail: 2 }));
  g.up(at(100, 10, { detail: 2 }));
  assert.equal(g.down(at(200, 10)), "drag");
  assert.equal(g.up(at(200, 10)), null);
});
