import { textInputProps } from "../textInputProps";
import { useEffect, useRef, useState } from "react";
import { useImeGuard } from "../imeGuard";
import { clearSessionSearch, findInSession, focusSession, onSearchResults } from "../terminal/manager";
import { ChevronIcon, CloseIcon, SearchIcon } from "./icons";

/**
 * Scrollback find (⌘F), scoped to the focused pane — the same shape iTerm2,
 * Warp and Wave all use: a small bar over the terminal, Enter/⇧Enter to step
 * through hits, Esc to dismiss. Closing clears the highlights and hands focus
 * back to the shell, so ⌘F → type → Esc leaves the terminal exactly as it was.
 */
export function FindBar({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const ime = useImeGuard();
  const [query, setQuery] = useState("");
  const [misses, setMisses] = useState(false);
  const [hits, setHits] = useState({ index: -1, count: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => onSearchResults(sessionId, setHits), [sessionId]);

  // Re-run as the query changes so matches track typing, like a browser's find.
  useEffect(() => {
    if (!query) {
      clearSessionSearch(sessionId);
      setMisses(false);
      setHits({ index: -1, count: 0 });
      return;
    }
    setMisses(!findInSession(sessionId, query, "next"));
  }, [query, sessionId]);

  const step = (dir: "next" | "prev") => {
    if (query) setMisses(!findInSession(sessionId, query, dir));
  };

  const close = () => {
    clearSessionSearch(sessionId);
    onClose();
    focusSession(sessionId);
  };

  return (
    <div className="find-bar">
      <span className="find-bar-ico">
        <SearchIcon />
      </span>
      <input
        {...textInputProps}
        ref={inputRef}
        className={`find-bar-input ${misses ? "miss" : ""}`}
        autoFocus
        placeholder="Find in terminal…"
        {...ime.props}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (ime.handled(e)) return;
          if (e.key === "Escape") close();
          else if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? "prev" : "next");
          }
        }}
      />
      {/* -1 while xterm is still scanning a long buffer — show nothing yet. */}
      {query !== "" && hits.count >= 0 && (
        <span className="find-bar-count">
          {hits.count === 0 ? "no results" : `${hits.index + 1}/${hits.count}`}
        </span>
      )}
      <button className="find-bar-btn" title="Previous match (⇧⏎)" onClick={() => step("prev")}>
        <ChevronIcon dir="up" />
      </button>
      <button className="find-bar-btn" title="Next match (⏎)" onClick={() => step("next")}>
        <ChevronIcon dir="down" />
      </button>
      <button className="find-bar-btn" title="Close (esc)" onClick={close}>
        <CloseIcon />
      </button>
    </div>
  );
}
