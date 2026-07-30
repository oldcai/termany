//! Native child webviews behind a "web" pane.
//!
//! Creation lives here rather than in the renderer because
//! `initialization_script` is a Rust-only builder method — the JS
//! `WebviewOptions` has no equivalent, and the JS `Webview` class has no
//! `eval` either. Everything else (position, size, show/hide, focus, close)
//! stays in `WebBrowserPane.tsx`, which drives it through a `skip: true`
//! handle over the label we create here. That split is deliberate: the
//! renderer's reveal/occlusion sequencing is subtle and hard-won, and porting
//! it would risk it for no gain.

mod eval;
pub mod selftest;
mod state;

use eval::{EvalOptions, EvalResult};
use state::{LoadState, PaneInfo, WebPaneState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Runtime, Url, Webview,
    WebviewUrl,
};

pub use state::WebPaneState as State;

/// Monotonic, salted so a page cannot guess the next id and pre-poison the
/// slot it will be polled from.
///
/// The salt is load-bearing, not decoration: `__TERMANY__.run/take/cancel` are
/// callable by page script, keyed only by this id, so with a counter starting
/// at 0 a page could park a forged settled job at the id Rust is about to poll
/// — or cancel the real one out from under it.
static JOB_SEQ: AtomicU64 = AtomicU64::new(0);
static JOB_SALT: OnceLock<u64> = OnceLock::new();

fn next_job_id() -> u64 {
    let salt = *JOB_SALT.get_or_init(|| {
        // No RNG dependency for this: ASLR gives a heap address the page cannot
        // observe, and the clock keeps two runs at the same address apart.
        let heap = Box::new(0u8);
        let addr = &*heap as *const u8 as u64;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        addr.rotate_left(17) ^ nanos.wrapping_mul(0x9E37_79B9_7F4A_7C15)
    });
    salt.wrapping_add(JOB_SEQ.fetch_add(1, Ordering::Relaxed))
}

const INSTRUMENT_JS: &str = include_str!("instrument.js");

/// Stricter than a bare `starts_with("web_")`: mirrors the sanitiser in
/// WebBrowserPane.tsx plus Tauri's own label charset, and bounds the length so
/// a hostile label cannot be used to probe unrelated webviews.
fn is_web_pane_label(label: &str) -> bool {
    !label.is_empty()
        && label.starts_with("web_")
        && label.len() <= 128
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'/'))
}

/// Validate the *caller*, then resolve the *target*.
///
/// The caller check is not paranoia. `capabilities/default.json` scopes its
/// permissions with `"windows": ["main"]`, and per tauri-utils
/// acl/capability.rs:150-157 that enables the capability on **every webview of
/// that window** — the `web_*` children included. Remote origins are still
/// blocked by the ACL, but `is_local_url` counts the configured `devUrl`
/// origin as local, so in a dev build a page pointed at localhost:15173 would
/// otherwise be able to drive every other pane through these commands.
fn resolve_pane<R: Runtime>(
    app: &AppHandle<R>,
    caller: &Webview<R>,
    label: &str,
) -> Result<Webview<R>, String> {
    if caller.label() != "main" {
        return Err("web pane commands are only available to the main webview".into());
    }
    if !is_web_pane_label(label) {
        return Err(format!("invalid webview label: {label}"));
    }
    app.get_webview(label)
        .ok_or_else(|| format!("web pane not found: {label}"))
}

fn state_of<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, WebPaneState> {
    app.state::<WebPaneState>()
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOptions {
    pub label: String,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub focus: bool,
    #[serde(default)]
    pub drag_drop_enabled: bool,
}

#[tauri::command]
pub async fn web_pane_create<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    options: CreateOptions,
) -> Result<PaneInfo, String> {
    if caller.label() != "main" {
        return Err("web pane commands are only available to the main webview".into());
    }
    create_pane(&app, options)
}

/// The creation itself, without the caller check, so the selftest harness can
/// drive the same path the command does.
pub(crate) fn create_pane<R: Runtime>(
    app: &AppHandle<R>,
    options: CreateOptions,
) -> Result<PaneInfo, String> {
    let app = app.clone();
    let label = options.label.clone();
    if !is_web_pane_label(&label) {
        return Err(format!("invalid webview label: {label}"));
    }
    if app.get_webview(&label).is_some() {
        // Clearer than Tauri's WebviewLabelAlreadyExists, which today surfaces
        // to the user as a bare "Cannot open this page here".
        return Err(format!("a web pane with label {label} already exists"));
    }

    let url: Url = options
        .url
        .parse()
        .map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", url.scheme()));
    }

    let state = state_of(&app);
    // Insert before building so a callback firing during add_child finds its
    // entry already present.
    state.insert_creating(&label, url.as_str());

    let nav_app = app.clone();
    let nav_label = label.clone();
    let load_app = app.clone();
    let load_label = label.clone();
    let title_app = app.clone();
    let title_label = label.clone();

    let builder = WebviewBuilder::<R>::new(&label, WebviewUrl::External(url.clone()))
        // Main frame only — the all-frames variant would give every ad iframe
        // its own copy of the instrumentation and its own buffers.
        .initialization_script(INSTRUMENT_JS)
        .focused(options.focus)
        // The URL is deliberately *not* recorded: wry calls this for sub-frame
        // navigations too (wkwebview/navigation.rs:50-81 has no `isMainFrame`
        // test), so a hidden iframe could otherwise put any origin it liked in
        // the pane's address bar, in `openExternal`, and in the persisted pane
        // url. `on_page_load` below is main-frame only and owns the url.
        .on_navigation(move |_url| {
            emit_state(&nav_app, &nav_label, |s| {
                s.mark_load(&nav_label, LoadState::Creating, None)
            });
            true
        })
        .on_page_load(move |_webview, payload| {
            let load = match payload.event() {
                PageLoadEvent::Started => LoadState::Started,
                PageLoadEvent::Finished => LoadState::Finished,
            };
            let url = payload.url().to_string();
            emit_state(&load_app, &load_label, |s| {
                s.mark_load(&load_label, load, Some(url))
            });
        })
        .on_document_title_changed(move |_webview, title| {
            emit_state(&title_app, &title_label, |s| {
                s.mark_title(&title_label, title)
            });
        });
    let builder = if options.drag_drop_enabled {
        builder
    } else {
        builder.disable_drag_drop_handler()
    };

    let Some(window) = app.get_window("main") else {
        state.remove(&label);
        return Err("main window not found".into());
    };

    window
        .add_child(
            builder,
            LogicalPosition::new(options.x, options.y),
            LogicalSize::new(options.width, options.height),
        )
        .map_err(|e| {
            state.remove(&label);
            e.to_string()
        })?;

    log::info!("[termany] web pane {label} created at {}", url.as_str());
    state
        .get(&label)
        .ok_or_else(|| "web pane vanished during creation".to_string())
}

/// Push the pane's state to the renderer.
///
/// Targeted at `main` rather than broadcast: every child webview has Tauri's
/// listener object injected, so `EventTarget::Any` would deliver pane state
/// *into* the pages we are watching.
fn emit_state<R: Runtime>(app: &AppHandle<R>, label: &str, update: impl FnOnce(&WebPaneState)) {
    let state = app.state::<WebPaneState>();
    update(&state);
    if let Some(info) = state.get(label) {
        let _ = app.emit_to(EventTarget::webview("main"), "web-pane://state", info);
    }
}

#[tauri::command]
pub async fn web_pane_eval<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    options: EvalOptions,
) -> Result<EvalResult, String> {
    let webview = resolve_pane(&app, &caller, &options.label)?;
    // Fail fast instead of waiting out the timeout for a callback wry already
    // destroyed. See PaneInfo::committed.
    if !state_of(&app).is_committed(&options.label) {
        return Err("web pane has not loaded a page yet".into());
    }
    let job_id = next_job_id();
    // eval blocks on a channel; a sync command would run on the event-loop
    // thread and freeze the UI for the whole timeout.
    tauri::async_runtime::spawn_blocking(move || eval::run(&webview, job_id, &options))
        .await
        .map_err(|e| format!("eval task failed: {e}"))?
}

/// Console, error and network entries the page has buffered since the last
/// call. Cleared by the read, so callers accumulate rather than re-reading.
#[tauri::command]
pub async fn web_pane_drain<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
    max_bytes: Option<usize>,
) -> Result<EvalResult, String> {
    let webview = resolve_pane(&app, &caller, &label)?;
    if !state_of(&app).is_committed(&label) {
        // Nothing has run in this document yet; an empty drain is the honest
        // answer, not an error the renderer's poll loop would have to
        // special-case — so `ok` has to be true, which `Default` is not.
        return Ok(EvalResult {
            ok: true,
            ..Default::default()
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        eval::drain(&webview, max_bytes.unwrap_or(512 * 1024))
    })
    .await
    .map_err(|e| format!("drain task failed: {e}"))?
}

#[tauri::command]
pub async fn web_pane_status<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
) -> Result<PaneInfo, String> {
    resolve_pane(&app, &caller, &label)?;
    state_of(&app)
        .get(&label)
        .ok_or_else(|| format!("web pane not found: {label}"))
}

#[tauri::command]
pub async fn web_pane_close<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
) -> Result<(), String> {
    let result = match resolve_pane(&app, &caller, &label) {
        Ok(webview) => webview.close().map_err(|e| e.to_string()),
        // Closing something already gone is the normal race on unmount, not an
        // error worth surfacing.
        Err(e) if e.starts_with("web pane not found") => Ok(()),
        Err(e) => return Err(e),
    };
    // Only this pane's entry. A sweep of everything missing from
    // `app.webviews()` would also take panes still inside their blocking
    // `add_child` — they are not registered until it returns — and the
    // concurrent create would then fail with "web pane vanished during
    // creation" while its native webview stayed alive above the app.
    state_of(&app).remove(&label);
    result
}

/// Navigate in place.
///
/// Before this existed the renderer changed the URL by bumping `viewKey`,
/// which changed the label, which made the effect tear the whole native
/// webview down and build a new one — losing session state, in-memory cookies,
/// scroll position and history on every address-bar submit. `navigate` goes
/// through a real WKNavigationAction, so the page-load callbacks see it (which
/// is what lets the address bar track in-page navigation) and it works on pages
/// that shadow `location`.
#[tauri::command]
pub async fn web_pane_navigate<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
    url: String,
) -> Result<(), String> {
    resolve_pane(&app, &caller, &label)?;
    navigate_pane(&app, &label, &url)
}

/// The navigation itself, without the caller check, so the selftest harness can
/// drive the same path the command does.
pub(crate) fn navigate_pane<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    url: &str,
) -> Result<(), String> {
    let webview = app
        .get_webview(label)
        .ok_or_else(|| format!("web pane not found: {label}"))?;
    let parsed: Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("unsupported scheme: {}", parsed.scheme()));
    }
    // Shut the eval gate before the request goes out, not after.
    state_of(app).mark_navigating(label, parsed.as_str());
    webview.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn web_pane_reload<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
) -> Result<(), String> {
    let webview = resolve_pane(&app, &caller, &label)?;
    let current = state_of(&app).get(&label).map(|i| i.url).unwrap_or_default();
    state_of(&app).mark_navigating(&label, &current);
    webview.reload().map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevtoolsResult {
    pub requested: bool,
    pub reported_open: bool,
    /// False where the platform cannot answer honestly, so the renderer can
    /// annotate the control instead of showing a state that is a lie.
    pub reliable: bool,
}

/// Open the page's own Web Inspector.
///
/// Returns the requested state, the queried state, and whether the query can
/// be trusted: on Windows `close_devtools` is unsupported and
/// `is_devtools_open` always reports false. Three fields now beats a breaking
/// change later.
#[tauri::command]
pub async fn web_pane_devtools<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
    open: bool,
) -> Result<DevtoolsResult, String> {
    let webview = resolve_pane(&app, &caller, &label)?;
    if open {
        webview.open_devtools();
    } else {
        webview.close_devtools();
    }
    Ok(DevtoolsResult {
        requested: open,
        reported_open: webview.is_devtools_open(),
        reliable: !cfg!(target_os = "windows"),
    })
}

#[tauri::command]
pub async fn web_pane_history<R: Runtime>(
    app: AppHandle<R>,
    caller: Webview<R>,
    label: String,
    direction: String,
) -> Result<(), String> {
    let webview = resolve_pane(&app, &caller, &label)?;
    let script = match direction.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        _ => return Err("invalid history direction".into()),
    };
    webview.eval(script).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_labels_the_renderer_actually_produces() {
        // WebBrowserPane.tsx: `web_${paneId sanitised}_${mountId}_${viewKey}`
        assert!(is_web_pane_label("web_a1b2c3d4_x9y8z7_0"));
        assert!(is_web_pane_label("web_0"));
        assert!(is_web_pane_label(
            "web_11111111-2222-3333-4444-555555555555_abc_12"
        ));
    }

    #[test]
    fn rejects_anything_that_is_not_a_web_pane() {
        assert!(!is_web_pane_label("main"));
        assert!(!is_web_pane_label(""));
        assert!(!is_web_pane_label("webx"));
        assert!(!is_web_pane_label("web"));
        // No traversal, no whitespace, no NUL, no unicode tricks.
        assert!(!is_web_pane_label("web_../main"));
        assert!(!is_web_pane_label("web_a b"));
        assert!(!is_web_pane_label("web_a\0b"));
        assert!(!is_web_pane_label("web_ä"));
        assert!(!is_web_pane_label(&format!("web_{}", "x".repeat(200))));
    }

    #[test]
    fn job_ids_do_not_repeat() {
        let a = next_job_id();
        let b = next_job_id();
        assert_ne!(a, b);
    }

    #[test]
    fn the_instrumentation_payload_is_actually_embedded() {
        // include_str! silently yields an empty file if the path is wrong.
        assert!(INSTRUMENT_JS.contains("__TERMANY__"));
        assert!(INSTRUMENT_JS.contains("configurable: false"));
        // The crash guard: every exported function must return a String.
        assert!(INSTRUMENT_JS.contains("function envelope"));
    }
}
