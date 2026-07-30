//! Per-pane bookkeeping for the native child webviews behind a "web" pane.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long a page-initiated navigation holds the eval gate shut while waiting
/// for the new document to commit.
///
/// Bounded rather than open-ended because wry's navigation handler fires for
/// **sub-frames** too (wkwebview/navigation.rs:50-81 has no `isMainFrame`
/// test) while `didCommitNavigation` — the only thing that reopens the gate —
/// is main-frame only. Without the bound one ad iframe navigating would
/// silence a pane's capture for the life of the document.
const NAV_GAP: Duration = Duration::from_millis(500);

#[derive(Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LoadState {
    Creating,
    Started,
    Finished,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneInfo {
    pub label: String,
    pub url: String,
    pub title: String,
    pub load: LoadState,
    /// True once the webview has committed a navigation.
    ///
    /// Load-bearing, not diagnostic: before the first commit wry stashes the
    /// script in `pending_scripts` and **drops the callback**
    /// (wkwebview/mod.rs:720-723), and `pending_scripts` is set to None
    /// permanently on that first commit (navigation.rs:34) — it is never
    /// re-armed for later navigations. So this flag is our only gate, and
    /// without it an early eval waits out the full timeout for a callback that
    /// no longer exists. Verified in Spike A (Q7).
    pub committed: bool,
    pub nav_count: u64,
    /// When the page asked to navigate itself (link, redirect, form submit).
    /// Holds the eval gate shut for `NAV_GAP`, since that navigation reaches us
    /// through `on_navigation` rather than `mark_navigating`. Not serialised:
    /// the renderer has no use for it.
    #[serde(skip)]
    navigating_since: Option<Instant>,
}

impl PaneInfo {
    fn new(label: String, url: String) -> Self {
        Self {
            label,
            url,
            title: String::new(),
            load: LoadState::Creating,
            committed: false,
            nav_count: 0,
            navigating_since: None,
        }
    }
}

#[derive(Default)]
pub struct WebPaneState(Mutex<HashMap<String, PaneInfo>>);

impl WebPaneState {
    pub fn insert_creating(&self, label: &str, url: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(
                label.to_string(),
                PaneInfo::new(label.to_string(), url.to_string()),
            );
        }
    }

    pub fn remove(&self, label: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(label);
        }
    }

    pub fn get(&self, label: &str) -> Option<PaneInfo> {
        self.0.lock().ok()?.get(label).cloned()
    }

    pub fn is_committed(&self, label: &str) -> bool {
        self.0
            .lock()
            .ok()
            .and_then(|map| {
                map.get(label).map(|info| {
                    info.committed
                        && info
                            .navigating_since
                            .map_or(true, |since| since.elapsed() >= NAV_GAP)
                })
            })
            .unwrap_or(false)
    }

    pub fn mark_load(&self, label: &str, load: LoadState, url: Option<String>) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(info) = map.get_mut(label) {
                match load {
                    LoadState::Started => {
                        info.committed = true;
                        info.nav_count += 1;
                        info.navigating_since = None;
                    }
                    // A link click, a redirect or a form submit arrives here
                    // rather than through `mark_navigating`, and the document
                    // it leaves behind is about to be destroyed just the same.
                    LoadState::Creating => info.navigating_since = Some(Instant::now()),
                    LoadState::Finished => {}
                }
                info.load = load;
                if let Some(url) = url {
                    info.url = url;
                }
            }
        }
    }

    /// Close the eval gate for the gap between asking for a navigation and the
    /// new document committing.
    ///
    /// wry's own `pending_scripts` is not re-armed after the first commit
    /// (navigation.rs:34), so during that window `evaluateJavaScript` would run
    /// against the *old* document — a job started there dies with the page it
    /// started in. This flag is the only thing standing in the way.
    pub fn mark_navigating(&self, label: &str, url: &str) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(info) = map.get_mut(label) {
                info.committed = false;
                info.load = LoadState::Creating;
                info.url = url.to_string();
            }
        }
    }

    pub fn mark_title(&self, label: &str, title: String) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(info) = map.get_mut(label) {
                info.title = title;
            }
        }
    }
}
