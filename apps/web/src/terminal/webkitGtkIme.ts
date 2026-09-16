import type { Terminal } from "@xterm/xterm";

/**
 * Linux WebKitGTK IME fix (issue #22): with Fcitx5/Rime, committed CJK
 * phrases arrive duplicated or interleaved with stale preedit fragments
 * ("甲乙丙" becomes "甲乙甲乙丙甲乙丙…") while ASCII typing is fine. PTY
 * tracing showed the malformed chunks are produced in the frontend: xterm's
 * CompositionHelper finalize and its keyCode-229 textarea-diff fallback both
 * re-read the hidden textarea on deferred timers, and WebKitGTK updates that
 * textarea on a different schedule than the engines those diffs were tuned
 * for, so stale snapshots get (re)sent.
 *
 * The fix takes ownership of the whole composition on this engine. Every
 * 229 keydown and composition/preedit event is stopped at document capture
 * phase so xterm never runs any of its composition paths, and the committed
 * text is delivered to the terminal exactly once by us: preferably by
 * cancelling the engine's final `beforeinput` (`insertText` /
 * `insertFromComposition`) and forwarding its data, with `compositionend`'s
 * data as the fallback — flushed by a short timer, by the next real keydown
 * (so Enter right after a commit lands *after* the text), or by the next
 * composition starting. After a commit the hidden textarea is wiped and the
 * engine's short-lived echo events for the same text are swallowed, leaving
 * nothing stale behind for xterm to diff against.
 *
 * Tradeoff: xterm's inline preedit rendering is disabled on this engine
 * (composition events never reach it); Fcitx5's own candidate window still
 * shows the composition state.
 */

/** How long a commit waits for the engine's `beforeinput` after `compositionend`. */
export const COMMIT_FLUSH_MS = 50;
/** Window in which late echo events for an already-committed text are swallowed. */
export const COMMIT_ECHO_MS = 150;

interface StoppableEvent {
  preventDefault(): void;
  stopPropagation(): void;
}
export interface ImeKeyEventLike extends StoppableEvent {
  keyCode: number;
}
export interface ImeCompositionEventLike extends StoppableEvent {
  data: string | null;
}
export interface ImeInputEventLike extends StoppableEvent {
  inputType: string;
  data: string | null;
}

/** Injectable side effects — keeps the state machine testable without a DOM. */
export interface GtkImeMachineHooks {
  /** Deliver committed text to the terminal (term.input(data, true)). */
  commit(data: string): void;
  /** Wipe xterm's hidden textarea so stale preedit can't be re-read later. */
  clearTextarea(): void;
  setTimer(fn: () => void, ms: number): number;
  clearTimer(id: number): void;
  now(): number;
  log?(line: string): void;
}

export function createGtkImeCommitMachine(hooks: GtkImeMachineHooks) {
  let composing = false;
  let pending: { fallback: string; timer: number } | null = null;
  let echo: { data: string; at: number } | null = null;

  const isCommitShape = (inputType: string) =>
    inputType === "insertText" || inputType === "insertFromComposition";

  function settle(data: string) {
    if (data) {
      hooks.commit(data);
      echo = { data, at: hooks.now() };
    }
    hooks.clearTextarea();
  }

  function resolvePending(data: string | null, reason: string) {
    if (!pending) return;
    const { fallback, timer } = pending;
    pending = null;
    hooks.clearTimer(timer);
    const text = data || fallback;
    hooks.log?.(`gtk-ime:commit(${reason}) ${JSON.stringify(text)}`);
    settle(text);
  }

  function isEcho(ev: ImeInputEventLike): boolean {
    return (
      echo !== null &&
      isCommitShape(ev.inputType) &&
      ev.data === echo.data &&
      hooks.now() - echo.at <= COMMIT_ECHO_MS
    );
  }

  return {
    keydown(ev: ImeKeyEventLike) {
      if (ev.keyCode === 229) {
        // Hide the IME-processed keydown from xterm: its 229 fallback is the
        // deferred textarea diff that emits the stale fragments. Propagation
        // only — preventDefault would interfere with the IME itself.
        ev.stopPropagation();
        return;
      }
      // A real key while a commit is still pending (Enter straight after
      // choosing a candidate): deliver the text now so it precedes the key.
      if (pending) resolvePending(null, "keydown");
    },
    compositionstart(ev: ImeCompositionEventLike) {
      if (pending) resolvePending(null, "compositionstart");
      composing = true;
      ev.stopPropagation();
    },
    compositionupdate(ev: ImeCompositionEventLike) {
      // Some engines open a composition without compositionstart.
      composing = true;
      ev.stopPropagation();
    },
    compositionend(ev: ImeCompositionEventLike) {
      composing = false;
      ev.stopPropagation();
      if (pending) resolvePending(null, "compositionend");
      pending = {
        fallback: ev.data ?? "",
        timer: hooks.setTimer(() => resolvePending(null, "timeout"), COMMIT_FLUSH_MS),
      };
    },
    beforeinput(ev: ImeInputEventLike) {
      if (composing) {
        // Preedit mutations: keep them native (the IME needs the textarea to
        // update) but invisible to xterm, whose CompositionHelper was never
        // told a composition is running.
        ev.stopPropagation();
        return;
      }
      if (pending && isCommitShape(ev.inputType)) {
        ev.preventDefault();
        ev.stopPropagation();
        resolvePending(ev.data, "beforeinput");
        return;
      }
      if (isEcho(ev)) {
        ev.preventDefault();
        ev.stopPropagation();
        hooks.clearTextarea();
      }
    },
    input(ev: ImeInputEventLike) {
      if (composing) {
        ev.stopPropagation();
        return;
      }
      if (pending && isCommitShape(ev.inputType)) {
        // Engine variant that commits without a beforeinput: the textarea has
        // already mutated, so stop propagation and clean up after the fact.
        ev.stopPropagation();
        resolvePending(ev.data, "input");
        return;
      }
      if (isEcho(ev)) {
        ev.stopPropagation();
        hooks.clearTextarea();
      }
    },
  };
}

/**
 * True only inside Linux WebKitGTK (Tauri's engine on Linux, also Epiphany).
 * Mirrors isMacWebKit in manager.ts: pure-WebKit UA with no Chrome token,
 * but on the Linux side of the platform split. Android WebViews are excluded
 * explicitly — their UAs carry "Linux" too.
 */
export function isLinuxWebKitGtk(): boolean {
  const ua = navigator.userAgent;
  const isPureWebKit = ua.includes("AppleWebKit") && !/Chrome|Chromium|Edg\//.test(ua);
  const isLinux = /Linux|X11/.test(navigator.platform) || /Linux|X11/.test(ua);
  return isPureWebKit && isLinux && !ua.includes("Android");
}

export function fixWebkitGtkImeComposition(term: Terminal, log?: (line: string) => void) {
  if (!isLinuxWebKitGtk() || !term.textarea) return;
  const ta = term.textarea;
  const machine = createGtkImeCommitMachine({
    commit: (data) => term.input(data, true),
    clearTextarea: () => {
      ta.value = "";
    },
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (id) => window.clearTimeout(id),
    now: () => performance.now(),
    log,
  });
  const forTa =
    <E extends Event>(handler: (ev: E) => void) =>
    (ev: Event) => {
      if (ev.target === ta) handler(ev as E);
    };
  // Document capture phase: ancestor capture listeners run before xterm's own
  // textarea listeners regardless of attach order (same trick as
  // fixAbandonedImeFinalize), so the machine gets to stop every event before
  // xterm sees it.
  document.addEventListener("keydown", forTa<KeyboardEvent>((ev) => machine.keydown(ev)), true);
  document.addEventListener(
    "compositionstart",
    forTa<CompositionEvent>((ev) => machine.compositionstart(ev)),
    true
  );
  document.addEventListener(
    "compositionupdate",
    forTa<CompositionEvent>((ev) => machine.compositionupdate(ev)),
    true
  );
  document.addEventListener(
    "compositionend",
    forTa<CompositionEvent>((ev) => machine.compositionend(ev)),
    true
  );
  document.addEventListener(
    "beforeinput",
    forTa<InputEvent>((ev) => machine.beforeinput(ev)),
    true
  );
  document.addEventListener("input", forTa<InputEvent>((ev) => machine.input(ev)), true);
}
