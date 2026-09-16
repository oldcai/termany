import { getCurrentWindow } from "@tauri-apps/api/window";
import { useMemo, type MouseEvent } from "react";
import { isTauri } from "./env";

/**
 * Native title-bar behaviour for the app's own chrome: drag the window from the
 * empty parts of the top bar, double-click them to zoom.
 *
 * The desktop window is borderless (decorations: false), so neither gesture
 * comes for free — and the obvious way to get them, tagging the bar with
 * `data-tauri-drag-region`, does not work here. Tauri's injected handler treats
 * a bare attribute as "direct clicks on this element only", and it insists the
 * two coordinates of the zoom gesture match to the pixel. Owning the gesture in
 * the app instead lets it span the bar's several background elements, and lets
 * the tolerance be a human one. It also keeps a single owner: with the
 * attribute still in place, a zero-jitter double-click could satisfy Tauri and
 * the app both, maximizing and immediately restoring.
 *
 * The zoom rides on mousedown/mouseup and their click counts rather than the
 * obvious `dblclick`, which never arrives on macOS: dragging goes through
 * `performWindowDragWithEvent:`, whose own event loop consumes the release of
 * the first click, so that click never completes and no double-click is ever
 * synthesized from it.
 *
 * Elements that carry `data-titlebar` are the bar's background. A click landing
 * on any other element is on a tab, a button, or a label, so it belongs to that
 * control — dragging a tab must not drag the window out from under it.
 */
const TITLE_BAR_ATTR = "data-titlebar";

/** Marks an element as bar background. Spread onto the elements themselves. */
export const titleBarBackground = { [TITLE_BAR_ATTR]: "" } as const;

/** What a press or release on the bar should do to the window. */
export type TitleBarAction = "drag" | "zoom" | null;

/** The parts of a mouse event the gesture reads, so it can be tested plainly. */
export type TitleBarMouse = {
  button: number;
  /** Click count: 1 for the first press of a gesture, 2 for the second. */
  detail: number;
  screenX: number;
  screenY: number;
  /** Whether the event landed on the bar background rather than a control. */
  background: boolean;
};

/**
 * How far the pointer may drift between the second press and its release and
 * still count as a double-click. macOS cancels the zoom if the pointer moves,
 * which is the behaviour to match; the few pixels of slack are for trackpads,
 * where a two-finger-free double tap rarely lands twice on the same pixel.
 */
const ZOOM_JITTER_PX = 4;

/**
 * Tracks one press/release pair. Platforms disagree on when a double-click
 * zooms: Windows and Linux do it on the second press, macOS on its release, so
 * that sliding off cancels. macOS therefore must not start a drag on that
 * second press either — the native drag session runs its own event loop and
 * would eat the release the zoom hangs on.
 */
export function createTitleBarGesture(isMac: boolean) {
  let armed: { x: number; y: number } | null = null;

  return {
    down(e: TitleBarMouse): TitleBarAction {
      armed = null;
      if (e.button !== 0 || !e.background) return null;
      if (e.detail === 2) {
        if (!isMac) return "zoom";
        armed = { x: e.screenX, y: e.screenY };
        return null;
      }
      // Every other press drags, including the third of a rapid burst: the
      // zoom already happened on the second, and a title bar stays draggable.
      return e.detail >= 1 ? "drag" : null;
    },

    up(e: TitleBarMouse): TitleBarAction {
      const start = armed;
      armed = null;
      if (!start || e.button !== 0 || e.detail !== 2 || !e.background) return null;
      // Screen coordinates, not client: had the first click of the gesture
      // nudged the window, client coordinates would report a move the hand
      // never made.
      const moved = Math.hypot(e.screenX - start.x, e.screenY - start.y);
      return moved <= ZOOM_JITTER_PX ? "zoom" : null;
    },
  };
}

const IS_MAC = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");

function read(event: MouseEvent): TitleBarMouse {
  const target = event.target;
  return {
    button: event.button,
    detail: event.detail,
    screenX: event.screenX,
    screenY: event.screenY,
    background: target instanceof Element && target.hasAttribute(TITLE_BAR_ATTR),
  };
}

/**
 * Mouse handlers to spread onto a bar that should behave like a title bar. The
 * bar's background elements need {...titleBarBackground} on them as well.
 *
 *   const titleBar = useTitleBarGesture();
 *   <div className="htabbar" {...titleBar} {...titleBarBackground}>
 */
export function useTitleBarGesture() {
  const gesture = useMemo(() => createTitleBarGesture(IS_MAC), []);

  const apply = (action: TitleBarAction) => {
    if (action === "drag") void getCurrentWindow().startDragging();
    else if (action === "zoom") void getCurrentWindow().toggleMaximize();
  };

  return {
    onMouseDown: (event: MouseEvent) => {
      if (!isTauri) return;
      const action = gesture.down(read(event));
      if (!action) return;
      // Without this the press leaves a text caret on the bar.
      event.preventDefault();
      apply(action);
    },
    onMouseUp: (event: MouseEvent) => {
      if (!isTauri) return;
      apply(gesture.up(read(event)));
    },
  };
}
