import { useRef, type CompositionEvent, type KeyboardEvent } from "react";

/**
 * Tells apart a real Enter/Escape from the one that only confirmed an IME
 * composition.
 *
 * `KeyboardEvent.isComposing` on its own is not enough in WebKit, which is what
 * the desktop app runs on: it fires `compositionend` BEFORE the keydown of the
 * key that committed the text, where Chrome fires it after. By the time the
 * handler runs the flag is already false, so the app acts on a keystroke the
 * user meant for the input method. Typing Latin letters under a Chinese IME is
 * the everyday case — the Enter that turns "ddd" into text would also submit
 * the dialog around it.
 *
 * Three signals, because no single one covers every IME and platform:
 * composition start/end that we track ourselves, the standard flag, and
 * keyCode 229 (the "handled by IME" sentinel). The short window after
 * `compositionend` is what catches WebKit's inverted ordering.
 *
 *   const ime = useImeGuard();
 *   <input {...ime.props} onKeyDown={(e) => {
 *     if (ime.handled(e)) return;
 *     ...
 *   }} />
 */
export function useImeGuard() {
  const composing = useRef(false);
  const endedAt = useRef(0);

  return {
    props: {
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: (event: CompositionEvent) => {
        composing.current = false;
        endedAt.current = event.timeStamp;
      },
    },
    /** True when this keydown belongs to the input method, not to the app. */
    handled(event: KeyboardEvent): boolean {
      return (
        composing.current ||
        event.nativeEvent.isComposing ||
        event.nativeEvent.keyCode === 229 ||
        // Same key gesture as the commit, a few ms later — see above.
        event.timeStamp - endedAt.current < 100
      );
    },
  };
}
