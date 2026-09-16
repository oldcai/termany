import { indentWithTab } from "@codemirror/commands";
import { defaultHighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { useEffect, useRef } from "react";
import { applyTextInputProps } from "../textInputProps";

/** Match the app's own chrome instead of CodeMirror's default white/dark-blue
 *  chrome, so the editor reads as part of the pane, not an embedded widget. */
const appTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent" },
  ".cm-content": { fontFamily: "Menlo, monospace", fontSize: "12.5px", caretColor: "var(--fg)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--fg-dim)",
    border: "none",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--bg-3)" },
  ".cm-activeLine": { backgroundColor: "var(--bg-3)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto" },
});

/**
 * An editable, syntax-highlighted view of a file's content — CodeMirror 6
 * under a thin React wrapper. Uncontrolled by design: React never re-renders
 * on keystrokes (that'd fight the editor's own cursor/selection/undo state).
 * It creates one CodeMirror instance per `path` and tears it down when the
 * file changes; ⌘S hands the current text to `onSave`, and any edit at all
 * reports through `onDirtyChange` so the pane can show an unsaved indicator.
 */
export function CodeEditor({
  path,
  content,
  dark,
  readOnly = false,
  onSave,
  onDirtyChange,
}: {
  path: string;
  content: string;
  dark: boolean;
  /** Blocks edits entirely — for previews that are only a truncated prefix of
   *  a too-large file, where saving would silently discard the rest of it. */
  readOnly?: boolean;
  onSave: (text: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    const languageConf = new Compartment();

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: content,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              run: (v) => {
                onSaveRef.current(v.state.doc.toString());
                return true;
              },
            },
          ]),
          languageConf.of([]),
          dark ? [oneDark] : [syntaxHighlighting(defaultHighlightStyle)],
          appTheme,
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onDirtyChangeRef.current(true);
          }),
        ],
      }),
    });

    // Auto-detect the language from the filename and load it in async — a
    // plain view first, then upgraded in place once the language support
    // (parser + highlighting queries) finishes loading.
    const desc = LanguageDescription.matchFilename(languages, path);
    desc?.load().then((support) => {
      if (cancelled) return;
      view.dispatch({ effects: languageConf.reconfigure(support) });
    });

    return () => {
      cancelled = true;
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` seeds
    // the doc only at creation; re-running on every keystroke would fight
    // CodeMirror's own state.
  }, [path, dark, readOnly]);

  return (
    <div
      className="code-editor"
      ref={hostRef}
      onFocusCapture={(event) => {
        // CodeMirror creates its search/replace fields outside React.
        if (event.target.matches("input, textarea, [contenteditable]")) {
          applyTextInputProps(event.target);
        }
      }}
    />
  );
}
