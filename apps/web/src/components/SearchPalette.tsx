import { textInputProps } from "../textInputProps";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { useImeGuard } from "../imeGuard";
import { ACTIONS, formatChord } from "../keybindings";
import { useStore, type Pane, type TreeNode, type Workspace } from "../state/store";
import { CommandIcon, PageIcon, SearchIcon, TerminalIcon } from "./icons";

function leavesOf(pane: Pane): Array<{ id: string; title: string }> {
  return pane.kind === "leaf" ? [{ id: pane.id, title: pane.title }] : pane.children.flatMap(leavesOf);
}

/**
 * Higher = better match; -1 = no match. Only the item's OWN title counts —
 * matching through an ancestor's title too would flood every page's
 * default-named tabs/panes ("tab 1", "terminal") into every search, since
 * they'd "match" through nothing but a parent page's name.
 */
function titleScore(label: string, q: string): number {
  const l = label.toLowerCase();
  if (l === q) return 100;
  if (l.startsWith(q)) return 60;
  if (l.includes(q)) return 30;
  return -1;
}

interface PaneNode {
  paneId: string;
  tabId: string;
  label: string;
  tabTitle: string;
  score: number;
}
interface TabNode {
  tabId: string;
  label: string;
  score: number;
  panes: PaneNode[];
  best: number;
}
/** A page that matched, or is just an ancestor of something that did (context). */
interface PageNode {
  workspaceId: string;
  nodeId: string;
  title: string;
  matched: boolean;
  tabs: TabNode[];
  children: PageNode[];
  best: number;
}

/**
 * Build the SAME shape as the page tree, but pruned to only the branches that
 * lead to a match, and with each level's own match score attached — so the
 * result reads as a real (filtered) tree instead of a flat list: a page that
 * matched only through a nested child still shows that child indented
 * underneath it, exactly where it lives in the sidebar.
 */
function buildPages(ws: Workspace, nodes: TreeNode[], q: string): PageNode[] {
  const out: PageNode[] = [];
  for (const n of nodes) {
    const ownScore = titleScore(n.title, q);
    const children = buildPages(ws, n.children, q);

    const tabs: TabNode[] = [];
    for (const h of n.htabs) {
      const tabScore = titleScore(h.title, q);
      const panes: PaneNode[] = [];
      for (const leaf of leavesOf(h.layout)) {
        const paneScore = titleScore(leaf.title, q);
        if (paneScore >= 0) {
          panes.push({ paneId: leaf.id, tabId: h.id, label: leaf.title, tabTitle: h.title, score: paneScore });
        }
      }
      panes.sort((a, b) => b.score - a.score);
      const tabBest = Math.max(tabScore, ...panes.map((p) => p.score));
      if (tabBest >= 0) tabs.push({ tabId: h.id, label: h.title, score: tabScore, panes, best: tabBest });
    }
    tabs.sort((a, b) => b.best - a.best);

    const best = Math.max(
      ownScore,
      ...tabs.map((t) => t.best),
      ...children.map((c) => c.best),
      -1
    );
    if (best >= 0) {
      children.sort((a, b) => b.best - a.best);
      out.push({ workspaceId: ws.id, nodeId: n.id, title: n.title, matched: ownScore >= 0, tabs, children, best });
    }
  }
  return out.sort((a, b) => b.best - a.best);
}

/** A single renderable row, flattened from the (already sorted) page tree. */
interface Row {
  key: string;
  depth: number;
  kind: "page" | "tab" | "pane" | "action";
  label: string;
  /** Non-selectable rows are pure context: an ancestor page shown only to place a real match underneath it. */
  selectable: boolean;
  target?: { workspaceId: string; nodeId: string; tabId?: string; paneId?: string };
  /** For a pane row, which tab it lives in — shown when the tab itself isn't its own row. */
  tabTitle?: string;
  /** For an action row: the id to dispatch, and its current chord for display. */
  actionId?: string;
  chord?: string;
}

function flattenPages(pages: PageNode[], depth: number, out: Row[]): void {
  for (const p of pages) {
    out.push({
      key: p.nodeId,
      depth,
      kind: "page",
      label: p.title,
      selectable: p.matched,
      target: p.matched ? { workspaceId: p.workspaceId, nodeId: p.nodeId } : undefined,
    });
    for (const t of p.tabs) {
      if (t.score >= 0) {
        out.push({
          key: t.tabId,
          depth: depth + 1,
          kind: "tab",
          label: t.label,
          selectable: true,
          target: { workspaceId: p.workspaceId, nodeId: p.nodeId, tabId: t.tabId },
        });
        for (const pane of t.panes) {
          out.push({
            key: pane.paneId,
            depth: depth + 2,
            kind: "pane",
            label: pane.label,
            selectable: true,
            target: { workspaceId: p.workspaceId, nodeId: p.nodeId, tabId: pane.tabId, paneId: pane.paneId },
          });
        }
      } else {
        // The tab itself didn't match, only its pane(s) did — skip the tab
        // header row and show the pane directly, still one level in.
        for (const pane of t.panes) {
          out.push({
            key: pane.paneId,
            depth: depth + 1,
            kind: "pane",
            label: pane.label,
            selectable: true,
            target: { workspaceId: p.workspaceId, nodeId: p.nodeId, tabId: pane.tabId, paneId: pane.paneId },
            tabTitle: pane.tabTitle,
          });
        }
      }
    }
    flattenPages(p.children, depth + 1, out);
  }
}

const KIND_ICON = {
  page: PageIcon,
  tab: TerminalIcon,
  pane: TerminalIcon,
  action: CommandIcon,
} as const;
const KIND_LABEL_KEY = {
  page: "search.kind.page",
  tab: "search.kind.tab",
  pane: "search.kind.pane",
  action: "search.kind.action",
} as const;

/**
 * ⌘K quick-find: search across every workspace's pages, tabs, and panes by
 * title and jump straight there — Notion-style. Terminal *contents* aren't
 * indexed (only titles), since scanning scrollback for every session on every
 * keystroke would be expensive.
 *
 * Results render as a real (filtered) tree — a match nested three pages deep
 * shows indented under its actual ancestors, not as a flat row with a
 * breadcrumb string — so the hierarchy you already know from the sidebar is
 * what disambiguates same-named pages/tabs here too.
 *
 * It doubles as the command palette: every bindable action (keybindings.ts) is
 * listed and runnable here, each showing its current chord. That's deliberately
 * NOT a Warp-style `/` in the terminal — panes run agent CLIs whose own slash
 * commands own that key, and keystrokes go straight to the PTY with no input
 * layer of ours to intercept them. An app-level chord has neither problem.
 */
export function SearchPalette({
  onClose,
  onRunAction,
}: {
  onClose: () => void;
  onRunAction: (actionId: string) => void;
}) {
  const { t } = useI18n();
  const workspaces = useStore((s) => s.workspaces);
  const jumpToResult = useStore((s) => s.jumpToResult);
  const keybindings = useStore((s) => s.keybindings);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const ime = useImeGuard();

  const actionRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows: Array<Row & { score: number }> = [];
    for (const action of ACTIONS) {
      if (action.hideInPalette) continue;
      const label = t(`action.${action.id}`);
      // Match the translated label AND the English one, so muscle memory for
      // "split" keeps working with the UI in Chinese.
      const score = q ? Math.max(titleScore(label, q), titleScore(action.label, q)) : 0;
      if (score < 0) continue;
      const chord = keybindings[action.id] ?? action.default;
      rows.push({
        key: `action:${action.id}`,
        depth: 0,
        kind: "action",
        label,
        selectable: true,
        actionId: action.id,
        chord: formatChord(chord),
        score,
      });
    }
    return rows.sort((a, b) => b.score - a.score).map(({ score: _score, ...row }) => row);
  }, [query, keybindings, t]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Empty query: the action list IS the useful default — it's what makes the
    // shortcuts discoverable. Listing every page instead would just be the
    // sidebar again.
    if (!q) return actionRows;
    const pages = workspaces
      .flatMap((ws) => buildPages(ws, ws.roots, q))
      .sort((a, b) => b.best - a.best);
    const out: Row[] = [];
    flattenPages(pages, 0, out);
    // Actions first: they're a fixed, exactly-matchable vocabulary, whereas page
    // titles are user data that fuzzy-matches far more loosely.
    return [...actionRows, ...out];
  }, [workspaces, query, actionRows]);

  const selectable = useMemo(() => rows.filter((r) => r.selectable), [rows]);
  const selectableIndex = useMemo(() => {
    const m = new Map<string, number>();
    selectable.forEach((r, i) => m.set(r.key, i));
    return m;
  }, [selectable]);

  useEffect(() => setSelected(0), [rows]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const activate = (row: Row) => {
    if (row.actionId) {
      // Close first: several actions open another overlay, and leaving the
      // palette mounted on top of it would swallow the new one's focus.
      onClose();
      onRunAction(row.actionId);
      return;
    }
    if (!row.target) return;
    jumpToResult(row.target);
    onClose();
  };

  return (
    <div className="search-backdrop" onClick={onClose}>
      <div className="search-palette" onClick={(e) => e.stopPropagation()}>
        <div className="search-input-row">
          <span className="search-input-ico">
            <SearchIcon />
          </span>
          <input
            {...textInputProps}
            className="search-input"
            autoFocus
            value={query}
            placeholder={t("search.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            {...ime.props}
            onKeyDown={(e) => {
              if (ime.handled(e)) return;
              if (e.key === "Escape") {
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSelected((i) => Math.min(i + 1, selectable.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSelected((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const row = selectable[selected];
                if (row) activate(row);
              }
            }}
          />
        </div>

        <div className="search-results" ref={listRef}>
          {query.trim() === "" && <div className="search-section">{t("search.commands")}</div>}
          {query.trim() !== "" && rows.length === 0 && (
            <div className="search-empty">{t("search.noMatch", { query: query.trim() })}</div>
          )}
          {rows.map((row) => {
            const idx = selectableIndex.get(row.key);
            const Icon = KIND_ICON[row.kind];
            const indent = 10 + row.depth * 12;
            if (!row.selectable) {
              return (
                <div key={row.key} className="search-context-row" style={{ paddingLeft: indent }}>
                  <span className="search-row-ico">
                    <Icon />
                  </span>
                  <span className="search-context-label">{row.label}</span>
                </div>
              );
            }
            return (
              <button
                key={row.key}
                data-idx={idx}
                className={`search-row ${row.kind} ${idx === selected ? "active" : ""}`}
                style={{ paddingLeft: indent }}
                onMouseEnter={() => setSelected(idx!)}
                onClick={() => activate(row)}
              >
                <span className="search-row-ico">
                  <Icon />
                </span>
                <span className="search-row-main">
                  <span className="search-row-label">{row.label || t("search.untitled")}</span>
                  {row.kind === "pane" && row.tabTitle && (
                    <span className="search-row-breadcrumb">
                      {t("search.inTab", { tab: row.tabTitle })}
                    </span>
                  )}
                </span>
                {row.chord ? (
                  <kbd className="search-row-chord">{row.chord}</kbd>
                ) : (
                  <span className="search-row-kind">{t(KIND_LABEL_KEY[row.kind])}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
