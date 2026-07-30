import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isTauri } from "../env";
import {
  noteWebPaneNavigation,
  subscribeWebPaneStats,
  watchWebPane,
  webPaneStats,
} from "../webInspect";
import { isRectOccluded, subscribeOcclusionChanged } from "../nativeViewOcclusion";
import { BackIcon, ExternalOpenIcon, ForwardIcon, InspectIcon, RefreshIcon } from "./icons";

const DEFAULT_URL = "https://github.com/thinkany-ai/termany";
const NATIVE_VIEW_INSET = {
  top: 1,
  right: 1,
  bottom: 12,
  left: 1,
};

/**
 * Build a JS handle over a webview that Rust already created.
 *
 * `skip` is not part of WebviewOptions — it is Tauri's own escape hatch for
 * exactly this case (@tauri-apps/api/webview.js:144, and `getAllWebviews()` at
 * :38 uses it too). Without it the constructor fires
 * `plugin:webview|create_webview` and collides with the label Rust just made.
 * Every method the occlusion dance needs — show/hide/setPosition/setSize/
 * setFocus/close — is a pure label-keyed invoke, so the handle is fully
 * functional.
 *
 * Private API, so it is confined to this one function: if it ever breaks, the
 * public fallback is `Webview.getByLabel()`, at the cost of an extra IPC round
 * trip per pane.
 */
function attachWebviewHandle(
  WebviewCtor: typeof import("@tauri-apps/api/webview").Webview,
  parent: import("@tauri-apps/api/window").Window,
  label: string,
): import("@tauri-apps/api/webview").Webview {
  return new WebviewCtor(parent, label, {
    skip: true,
  } as unknown as ConstructorParameters<typeof WebviewCtor>[2]);
}

function normalizeUrl(value: string): string {
  const raw = value.trim();
  if (!raw) return DEFAULT_URL;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(raw)) return `http://${raw}`;
  return `https://${raw}`;
}

export function WebBrowserPane({
  id,
  initialUrl,
  onUrlChange,
}: {
  id: string;
  initialUrl?: string;
  onUrlChange?: (url: string) => void;
}) {
  const startingUrl = normalizeUrl(initialUrl ?? DEFAULT_URL);
  const [url, setUrl] = useState(startingUrl);
  const [draftUrl, setDraftUrl] = useState(startingUrl);
  const [viewKey, setViewKey] = useState(0);
  const [nativeState, setNativeState] = useState<"loading" | "ready" | "error">(
    isTauri ? "loading" : "ready",
  );
  const [nativeError, setNativeError] = useState<string | null>(null);
  const [viewSuppressed, setViewSuppressed] = useState(
    () => isTauri && document.body.classList.contains("native-webviews-suppressed"),
  );
  const stats = useSyncExternalStore(
    useCallback((notify: () => void) => subscribeWebPaneStats(id, notify), [id]),
    useCallback(() => webPaneStats(id), [id])
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  // Read from the navigation listener, which must not re-subscribe whenever a
  // parent re-renders or the url changes.
  const urlRef = useRef(startingUrl);
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  // Mount-unique suffix: zen (maximize) toggling remounts this pane, and the
  // fresh webview would otherwise reuse the label of its still-closing
  // predecessor, which rejects the creation.
  const mountId = useRef(Math.random().toString(36).slice(2, 8)).current;
  const label = useMemo(
    () => `web_${id.replace(/[^a-zA-Z0-9_/-]/g, "_")}_${mountId}_${viewKey}`,
    [id, mountId, viewKey]
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const next = normalizeUrl(draftUrl);
    setDraftUrl(next);
    setUrl(next);
    urlRef.current = next;
    onUrlChange?.(next);
    // Navigate in place. Bumping viewKey would change the label and make the
    // effect destroy and rebuild the whole native webview, losing session
    // state, in-memory cookies, scroll position and history — which is what
    // typing an address used to do. The cases that still need a rebuild are a
    // pane whose creation failed and one whose creation has not finished: there
    // is no webview to navigate, and `web_pane_navigate` would reject into the
    // catch below while the address bar already showed the new URL.
    if (!isTauri || nativeState !== "ready") {
      setViewKey((n) => n + 1);
      return;
    }
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("web_pane_navigate", { label, url: next }))
      .catch((err) => {
        console.warn("Failed to navigate", err);
        // A rejection (an unsupported scheme, say) would otherwise leave the
        // toolbar claiming a page the pane never loaded. Rebuilding runs the
        // same URL through creation, which surfaces the real error in the pane.
        setViewKey((n) => n + 1);
      });
  };

  const reload = () => {
    if (!isTauri || nativeState !== "ready") {
      setViewKey((n) => n + 1);
      return;
    }
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("web_pane_reload", { label }))
      .catch((err) => console.warn("Failed to reload", err));
  };

  const goHistory = (direction: "back" | "forward") => {
    if (!isTauri) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("web_pane_history", { label, direction }))
      .catch((err) => console.warn(`Failed to go ${direction}`, err));
  };

  const openDevtools = () => {
    if (!isTauri) return;
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("web_pane_devtools", { label, open: true }))
      .catch((err) => console.warn("Failed to open devtools", err));
  };

  const openExternal = () => {
    if (!isTauri) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => {});
  };

  useEffect(() => {
    if (!isTauri) return;
    const host = viewportRef.current;
    if (!host) return;

    let cancelled = false;
    let webview: import("@tauri-apps/api/webview").Webview | null = null;
    let stopWatching: (() => void) | undefined;
    let focusTimer = 0;
    let visible = false;
    let suppressed = document.body.classList.contains("native-webviews-suppressed");
    setViewSuppressed(suppressed);
    setNativeState("loading");
    setNativeError(null);

    const bounds = () => {
      const rect = host.getBoundingClientRect();
      const inset = NATIVE_VIEW_INSET;
      return {
        x: Math.max(0, Math.round(rect.left + inset.left)),
        y: Math.max(0, Math.round(rect.top + inset.top)),
        width: Math.max(1, Math.round(rect.width - inset.left - inset.right)),
        height: Math.max(1, Math.round(rect.height - inset.top - inset.bottom)),
      };
    };

    const isHostVisible = () => {
      const rect = host.getBoundingClientRect();
      return host.isConnected && rect.width > 2 && rect.height > 2;
    };

    const canReveal = () => !suppressed && isHostVisible() && !isRectOccluded(bounds());

    const create = async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const { Webview, getCurrentWebview } = await import("@tauri-apps/api/webview");
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (cancelled) return;
        const appWindow = getCurrentWindow();
        // Created in Rust so it can carry an initialization script — the JS
        // WebviewOptions has no equivalent. Everything below is unchanged.
        await invoke("web_pane_create", {
          options: {
            label,
            url,
            ...bounds(),
            // A newly-created native view can finish mounting after a DOM modal
            // has opened. Keep it unfocused until canReveal() confirms it is
            // still safe to place above the app's DOM.
            focus: false,
            dragDropEnabled: false,
          },
        });
        if (cancelled) {
          // The native view now exists but `webview` is still null, so the
          // cleanup that ran while we were awaiting did nothing. Close it by
          // label or it is orphaned: painted above the app, referenced by no
          // React state, and — because the label embeds mountId+viewKey — not
          // even colliding with the next mount, so it never errors. Zen
          // toggling remounts this pane, which makes it a routine path.
          void invoke("web_pane_close", { label }).catch(() => {});
          return;
        }
        webview = attachWebviewHandle(Webview, getCurrentWebview().window, label);
        // Start draining the page's console/network ring into the server's
        // durable history. Always on, not only while a panel is open: the
        // point is that an agent can ask what went wrong *after* the fact.
        stopWatching = watchWebPane(id, label);
        const bringForward = async () => {
          if (cancelled || !webview) return;
          try {
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            await appWindow.show();
            await appWindow.setFocus();
            // show()/focus() cross the native bridge. Suppression may have
            // changed while the preceding calls were in flight, so check at
            // the last possible moment before revealing the child view.
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            await webview.show();
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            await webview.setFocus();
            if (!canReveal()) {
              visible = false;
              await webview.hide();
              return;
            }
            visible = true;
          } catch (err) {
            console.warn("Failed to focus webview", err);
          }
        };
        // `tauri://created` and `tauri://error` are client-side-only events the
        // Webview constructor emits from its own then/catch
        // (@tauri-apps/api/webview.js:49, :258) — with `skip: true` they never
        // fire. Both outcomes now come from the invoke above instead: success
        // falls through here, and a Rust `Err(String)` rejects into the catch
        // below with the same message shape the error state already rendered.
        setNativeState("ready");
        syncBounds();
        void bringForward();
        focusTimer = window.setTimeout(() => void bringForward(), 120);
      } catch (err) {
        if (cancelled) return;
        webview = null;
        setNativeState("error");
        setNativeError(err instanceof Error ? err.message : String(err));
      }
    };

    const syncBounds = () => {
      if (!webview) return;
      const next = bounds();
      // Resizing the native view to dodge a popup would reflow the page
      // inside it — worse than a brief blank — so this pane only ever fully
      // shows or fully hides, at its normal size. Rect-scoped (not the old
      // app-wide flag) so only pane(s) an open popup actually overlaps go
      // blank; see nativeViewOcclusion.
      const occluded = suppressed || isRectOccluded(next);
      setViewSuppressed(occluded);
      if (occluded || !isHostVisible()) {
        // Do not trust `visible` while creation is in flight: Tauri may make
        // the native view visible before the created event reaches us.
        visible = false;
        void webview.hide().catch(() => {});
        return;
      }
      void import("@tauri-apps/api/dpi").then(({ LogicalPosition, LogicalSize }) => {
        // The import is asynchronous; a modal may have opened since this sync
        // began. Never let that stale continuation re-show the native view.
        if (!canReveal()) return;
        // Caught, like the hide() calls around it: canReveal() checks
        // visibility, not liveness, so a continuation can land after the pane
        // is gone and reject on a label that no longer exists.
        void webview?.setPosition(new LogicalPosition(next.x, next.y)).catch(() => {});
        void webview?.setSize(new LogicalSize(next.width, next.height)).catch(() => {});
        if (!visible) {
          visible = true;
          void webview
            ?.show()
            .then(() => {
              if (!canReveal()) {
                visible = false;
                void webview?.hide().catch(() => {});
              }
            })
            .catch(() => {});
        }
      });
    };

    const ro = new ResizeObserver(syncBounds);
    const onSuppressed = (event: Event) => {
      suppressed = Boolean((event as CustomEvent<boolean>).detail);
      syncBounds();
    };
    ro.observe(host);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("termany:native-webviews-suppressed", onSuppressed);
    const unsubscribeOcclusion = subscribeOcclusionChanged(syncBounds);
    void create();
    queueMicrotask(syncBounds);

    return () => {
      cancelled = true;
      window.clearTimeout(focusTimer);
      ro.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("termany:native-webviews-suppressed", onSuppressed);
      unsubscribeOcclusion();
      stopWatching?.();
      void webview?.hide().catch(() => {});
      if (webview) {
        // Through the command, not the JS handle: `web_pane_close` closes the
        // same webview *and* drops its entry in Rust's WebPaneState, which
        // nothing else prunes. Guarded on `webview` because a close by label
        // while creation is still in flight would delete the entry that
        // creation is about to read back.
        void import("@tauri-apps/api/core")
          .then(({ invoke }) => invoke("web_pane_close", { label }))
          .catch(() => {});
      }
    };
    // `url` is deliberately not a dependency. It is read once, to create the
    // pane; every later change navigates in place instead. Re-running on it
    // would destroy and rebuild the native webview on every address-bar
    // submit. When a rebuild really is needed (creation failed) `label`
    // changes, and the closure that runs then carries the current url.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  // Keep the address bar honest. Clicking a link and following a redirect both
  // navigate the pane without going through `submit`, so before this the
  // address bar kept showing whatever was last typed. Same-document History API
  // changes (pushState/replaceState) are *not* covered: WKWebView reports those
  // through didSameDocumentNavigation, which wry does not surface at all, so an
  // SPA route change still leaves the toolbar on the URL that loaded the app.
  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ label: string; url: string; navCount?: number }>("web-pane://state", (event) => {
          if (event.payload.label !== label) return;
          // Tag subsequent entries with the load they belong to, so "this
          // error is from before the reload" stays answerable.
          if (typeof event.payload.navCount === "number") {
            noteWebPaneNavigation(id, event.payload.navCount);
          }
          const next = event.payload.url;
          if (!next || next === urlRef.current) return;
          urlRef.current = next;
          setUrl(next);
          // Never overwrite a half-typed address under the user's cursor.
          if (document.activeElement !== addressRef.current) setDraftUrl(next);
          onUrlChangeRef.current?.(next);
        })
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [label]);

  return (
    <div className="web-pane">
      <form className="web-toolbar" onSubmit={submit}>
        <button
          className="web-nav-btn"
          type="button"
          title="Back"
          disabled={isTauri && nativeState !== "ready"}
          onClick={() => goHistory("back")}
        >
          <BackIcon />
        </button>
        <button
          className="web-nav-btn"
          type="button"
          title="Forward"
          disabled={isTauri && nativeState !== "ready"}
          onClick={() => goHistory("forward")}
        >
          <ForwardIcon />
        </button>
        <button className="web-nav-btn" type="button" title="Reload" onClick={reload}>
          <RefreshIcon />
        </button>
        <input
          ref={addressRef}
          className="web-address"
          value={draftUrl}
          onChange={(e) => setDraftUrl(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        {isTauri && (stats.errors > 0 || stats.warnings > 0) && (
          <button
            className={`web-badge ${stats.errors > 0 ? "error" : "warn"}`}
            type="button"
            title={
              `${stats.errors} error${stats.errors === 1 ? "" : "s"}, ` +
              `${stats.warnings} warning${stats.warnings === 1 ? "" : "s"} — open the inspector`
            }
            onClick={() => openDevtools()}
          >
            {stats.errors > 0 ? stats.errors : stats.warnings}
          </button>
        )}
        {isTauri && stats.failedRequests > 0 && (
          <button
            className="web-badge net"
            type="button"
            title={`${stats.failedRequests} failed request${
              stats.failedRequests === 1 ? "" : "s"
            } — open the inspector`}
            onClick={() => openDevtools()}
          >
            ⇅{stats.failedRequests}
          </button>
        )}
        {isTauri && (
          <button
            className="web-nav-btn"
            type="button"
            title="Inspect (Web Inspector)"
            disabled={nativeState !== "ready"}
            onClick={() => openDevtools()}
          >
            <InspectIcon />
          </button>
        )}
        <button className="web-nav-btn" type="button" title="Open in browser" onClick={openExternal}>
          <ExternalOpenIcon />
        </button>
      </form>
      <div className="web-viewport" ref={viewportRef}>
        {!isTauri && <iframe className="web-fallback-frame" title={url} src={url} />}
        {isTauri && nativeState === "loading" && <div className="web-status">Loading page...</div>}
        {isTauri && nativeState === "ready" && viewSuppressed && (
          <div className="web-status web-status-suppressed" />
        )}
        {isTauri && nativeState === "error" && (
          <div className="web-status web-status-error">
            <div>Cannot open this page here.</div>
            {nativeError && <div className="web-status-detail">{nativeError}</div>}
            <button className="web-status-action" type="button" onClick={openExternal}>
              Open in browser
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
