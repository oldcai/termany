//! Runtime acceptance battery for the web_pane layer (plan.md Phase 1).
//!
//! Gated behind `TERMANY_WEB_PANE_SELFTEST=1`; inert otherwise. It drives the
//! real `create_pane` + `eval::run` code paths rather than a mock, because the
//! things that can break here are all runtime behaviours of WKWebView and wry
//! that no unit test can reach: whether the callback fires at all, whether the
//! injected script survives the page's CSP, and whether a value we hand back
//! aborts the process.
//!
//! Supersedes the earlier throwaway spike_a.rs.
//!
//! Point it at scratchpad/spike-a-server.mjs (or any http server) with
//! `TERMANY_WEB_PANE_SELFTEST_URL`.

use super::{create_pane, eval, CreateOptions};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

fn options(label: &str, url: &str) -> CreateOptions {
    CreateOptions {
        label: label.to_string(),
        url: url.to_string(),
        x: 20.0,
        y: 40.0,
        width: 420.0,
        height: 280.0,
        focus: false,
        drag_drop_enabled: false,
    }
}

fn eval_options(label: &str, js: &str, timeout_ms: Option<u64>) -> eval::EvalOptions {
    eval::EvalOptions {
        label: label.to_string(),
        js: js.to_string(),
        timeout_ms,
        await_promise: true,
        max_result_bytes: None,
    }
}

/// `expect` is a substring the rendered outcome must contain. Anything else is
/// reported as FAIL so a regression is obvious without reading every line.
fn check<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    name: &str,
    js: &str,
    timeout_ms: Option<u64>,
    expect: &str,
) -> bool {
    let Some(webview) = app.get_webview(label) else {
        log::error!("[web_pane/selftest] {name:<34} FAIL  pane vanished");
        return false;
    };
    let rendered = match eval::run(&webview, super::next_job_id(), &eval_options(label, js, timeout_ms))
    {
        Ok(result) => format!(
            "ok={} value={:?} error={:?} name={:?} elapsed={}ms",
            result.ok, result.value, result.error, result.name, result.elapsed_ms
        ),
        Err(err) => format!("Err({err})"),
    };
    let passed = rendered.contains(expect);
    if passed {
        log::info!("[web_pane/selftest] {name:<34} PASS  {rendered}");
    } else {
        log::error!("[web_pane/selftest] {name:<34} FAIL  expected {expect:?} in: {rendered}");
    }
    passed
}

fn probe<R: Runtime>(app: &AppHandle<R>, name: &str, url: &str) -> (u32, u32) {
    let label = format!("web_selftest_{name}");
    log::info!("[web_pane/selftest] ===== {name} :: {url} =====");
    let mut passed = 0u32;
    let mut failed = 0u32;
    let mut tally = |ok: bool| {
        if ok {
            passed += 1;
        } else {
            failed += 1;
        }
    };

    if let Err(err) = create_pane(app, options(&label, url)) {
        log::error!("[web_pane/selftest] create_pane failed: {err}");
        return (0, 1);
    }

    // Before the first commit wry drops the callback. The committed gate lives
    // in the command, so here we assert the underlying symptom is the fast
    // "discarded" error rather than a full-timeout hang.
    let uncommitted = app
        .get_webview(&label)
        .map(|webview| {
            eval::run(
                &webview,
                super::next_job_id(),
                &eval_options(&label, "1+1", Some(1500)),
            )
        })
        .map(|r| match r {
            Ok(v) => format!("ok={} value={:?}", v.ok, v.value),
            Err(e) => format!("Err({e})"),
        })
        .unwrap_or_else(|| "pane vanished".into());
    log::info!("[web_pane/selftest] {:<34} {uncommitted}", "pre-commit eval");

    std::thread::sleep(Duration::from_millis(2500)); // let the page commit and settle

    tally(check(app, &label, "arithmetic", "1+1", None, "value=Some(Number(2))"));
    tally(check(
        app,
        &label,
        "instrumentation installed",
        "typeof window.__TERMANY__",
        None,
        r#"String("object")"#,
    ));
    // The exception path. wry hands back "" for both a throw and undefined, so
    // the envelope is the only thing that tells them apart.
    tally(check(
        app,
        &label,
        "throw is distinguishable",
        "(function(){ throw new TypeError('boom') })()",
        None,
        r#"name=Some("TypeError")"#,
    ));
    tally(check(
        app,
        &label,
        "undefined is not an error",
        "void 0",
        None,
        "ok=true",
    ));
    // THE crash guard. A bare NaN reaching NSJSONSerialization throws an
    // Objective-C exception and terminates the process; sanitize() must have
    // turned it into a string long before that.
    tally(check(app, &label, "NaN does not abort", "NaN", None, "ok=true"));
    tally(check(
        app,
        &label,
        "Infinity does not abort",
        "[Infinity, -Infinity, NaN]",
        None,
        "ok=true",
    ));
    tally(check(
        app,
        &label,
        "cycles do not hang",
        "(function(){ var a={}; a.self=a; return a })()",
        None,
        "Circular",
    ));
    tally(check(
        app,
        &label,
        "awaits a promise",
        "new Promise(function(r){ setTimeout(function(){ r(42) }, 300) })",
        None,
        "value=Some(Number(42))",
    ));
    tally(check(
        app,
        &label,
        "rejected promise surfaces",
        "Promise.reject(new Error('nope'))",
        None,
        "ok=false",
    ));
    // A promise that outlives the deadline must produce a timeout, never a hang.
    tally(check(
        app,
        &label,
        "slow promise times out",
        "new Promise(function(r){ setTimeout(r, 9000) })",
        Some(1200),
        "timed out",
    ));
    // A page must not be able to unhook us: the property is non-configurable
    // and we win the definition race at document-start.
    // Statement form, so it needs its own `return` — an expression cannot
    // contain try/catch.
    tally(check(
        app,
        &label,
        "page cannot unhook us",
        "try { Object.defineProperty(window,'__TERMANY__',{value:null}); } catch(e) {} return typeof window.__TERMANY__;",
        None,
        r#"String("object")"#,
    ));
    tally(check(
        app,
        &label,
        "DOM nodes serialize safely",
        "document.body",
        None,
        "ok=true",
    ));
    // The eval-less splicing has to work for both shapes, since we cannot tell
    // an expression from a statement list without parsing.
    tally(check(
        app,
        &label,
        "statement form (fallback path)",
        "let a = 20; let b = 22; return a + b;",
        None,
        "value=Some(Number(42))",
    ));
    tally(check(
        app,
        &label,
        "syntax error is named as such",
        "this is not ( valid javascript",
        None,
        "syntax error",
    ));

    // Capture (plan.md Phase 2). The page under test logs, warns, errors,
    // rejects, throws and fetches on load, so a drain right after commit
    // should carry all of it — including on the CSP profile where the page's
    // own fetch is blocked, which is the claim the design rests on.
    let drained = app
        .get_webview(&label)
        .map(|webview| eval::drain(&webview, 512 * 1024));
    match drained {
        Some(Ok(result)) => {
            let value = result.value.unwrap_or(serde_json::Value::Null);
            let logs = value.get("logs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            let nets = value.get("net").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
            let kinds: Vec<String> = value
                .get("logs")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e.get("k").and_then(|k| k.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            // Every profile yields something. Under /strict the page's own
            // scripts are blocked, but WebKit reports each CSP violation to
            // the console and we capture those — which is a feature, not
            // noise: "why is nothing running on this page" is exactly the
            // question those messages answer.
            //
            // The headline claim is /egress-blocked: the page's fetch is
            // blocked by connect-src, and we still see both its console output
            // and a record of the failed request. That profile must match
            // /permissive, the no-CSP control.
            let want_net = name == "permissive" || name == "egressblocked";
            let ok = logs > 0 && (nets > 0) == want_net;
            if ok {
                log::info!(
                    "[web_pane/selftest] {:<34} PASS  logs={logs} net={nets} kinds={kinds:?}",
                    "capture: drain"
                );
                tally(true);
            } else {
                log::error!(
                    "[web_pane/selftest] {:<34} FAIL  logs={logs} net={nets} (want logs>0, net>0=={want_net}) kinds={kinds:?}",
                    "capture: drain"
                );
                tally(false);
            }
            // A second drain must come back empty: the read clears.
            if let Some(webview) = app.get_webview(&label) {
                let again = eval::drain(&webview, 512 * 1024)
                    .ok()
                    .and_then(|r| r.value)
                    .and_then(|v| v.get("logs").and_then(|l| l.as_array()).map(|a| a.len()))
                    .unwrap_or(999);
                if again == 0 {
                    log::info!("[web_pane/selftest] {:<34} PASS  second drain empty", "capture: drain clears");
                    tally(true);
                } else {
                    log::error!("[web_pane/selftest] {:<34} FAIL  second drain had {again}", "capture: drain clears");
                    tally(false);
                }
            }
        }
        other => {
            log::error!("[web_pane/selftest] {:<34} FAIL  {other:?}", "capture: drain");
            tally(false);
            tally(false);
        }
    }

    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    app.state::<super::State>().remove(&label);
    (passed, failed)
}

/// Create and destroy panes in bulk, closing each **by label only** — never
/// through a handle.
///
/// That is precisely the shape of the orphan hazard in WebBrowserPane.tsx: if
/// the effect unmounts while `web_pane_create` is still in flight, the
/// renderer has no handle yet, so its cleanup can do nothing and must fall
/// back to closing by label. If that path did not work, every zen toggle would
/// strand a native view above the app — invisible to React, and not even
/// colliding with the next label, so it would never error.
fn lifecycle<R: Runtime>(app: &AppHandle<R>, url: &str, rounds: usize) -> bool {
    let baseline = app.webviews().len();
    for i in 0..rounds {
        let label = format!("web_lifecycle_{i}");
        if let Err(err) = create_pane(app, options(&label, url)) {
            log::error!("[web_pane/selftest] lifecycle create #{i} failed: {err}");
            return false;
        }
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        } else {
            log::error!("[web_pane/selftest] lifecycle #{i}: pane missing right after create");
            return false;
        }
        app.state::<super::State>().remove(&label);
    }
    // close() is dispatched to the main thread; give it room to drain.
    std::thread::sleep(Duration::from_millis(1500));
    let after = app.webviews().len();
    if after == baseline {
        log::info!(
            "[web_pane/selftest] {:<34} PASS  {rounds} created+closed, webviews {baseline} -> {after}",
            "lifecycle leaves no orphans"
        );
        true
    } else {
        log::error!(
            "[web_pane/selftest] {:<34} FAIL  webviews {baseline} -> {after} after {rounds} rounds",
            "lifecycle leaves no orphans"
        );
        false
    }
}

/// In-place navigation (plan.md Phase 1.5).
///
/// The thing that must hold: the *same* native webview survives a URL change.
/// Before this the renderer changed the label to force a rebuild, which threw
/// away session state, cookies, scroll and history on every address-bar
/// submit.
fn navigation<R: Runtime>(app: &AppHandle<R>, base: &str) -> bool {
    let label = "web_navtest";
    let mut ok = true;
    if let Err(err) = create_pane(app, options(label, &format!("{base}/permissive"))) {
        log::error!("[web_pane/selftest] navigation create failed: {err}");
        return false;
    }
    std::thread::sleep(Duration::from_millis(2500));

    let first = app.state::<super::State>().get(label);
    ok &= check(app, label, "nav: initial path", "location.pathname", None, "/permissive");

    if let Err(err) = super::navigate_pane(app, label, &format!("{base}/strict")) {
        log::error!("[web_pane/selftest] navigate failed: {err}");
        ok = false;
    }
    // The gap between asking and committing: eval must refuse, not run against
    // the document that is about to be destroyed.
    let gap = app
        .get_webview(label)
        .map(|_| app.state::<super::State>().get(label).map(|i| i.committed));
    log::info!(
        "[web_pane/selftest] {:<34} committed during nav gap = {gap:?} (want Some(Some(false)))",
        "nav: eval gate closes"
    );
    if gap != Some(Some(false)) {
        log::error!("[web_pane/selftest] nav gate did not close");
        ok = false;
    }

    std::thread::sleep(Duration::from_millis(2500));
    ok &= check(app, label, "nav: landed on new path", "location.pathname", None, "/strict");

    // Same webview, not a rebuilt one — this is the whole point.
    let after = app.state::<super::State>().get(label);
    let same = app.get_webview(label).is_some();
    let advanced = match (&first, &after) {
        (Some(a), Some(b)) => b.nav_count > a.nav_count,
        _ => false,
    };
    if same && advanced {
        log::info!(
            "[web_pane/selftest] {:<34} PASS  same webview, nav_count {} -> {}",
            "nav: no rebuild",
            first.as_ref().map(|i| i.nav_count).unwrap_or(0),
            after.as_ref().map(|i| i.nav_count).unwrap_or(0)
        );
    } else {
        log::error!(
            "[web_pane/selftest] {:<34} FAIL  same={same} advanced={advanced}",
            "nav: no rebuild"
        );
        ok = false;
    }

    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
    app.state::<super::State>().remove(label);
    ok
}

pub fn run<R: Runtime>(app: AppHandle<R>) {
    let base = std::env::var("TERMANY_WEB_PANE_SELFTEST_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:5197".to_string());
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500)); // main window has to exist first
        let mut passed = 0u32;
        let mut failed = 0u32;
        for (name, path) in [
            ("permissive", "/permissive"),
            // The claim the whole capture design rests on: the page's own
            // egress is shut, ours is not a channel at all. Also the case that
            // caught the eval() bug — its script-src omits 'unsafe-eval'.
            ("egressblocked", "/egress-blocked"),
            // The harshest a real site can be: no page scripts at all.
            ("strict", "/strict"),
        ] {
            let (p, f) = probe(&app, name, &format!("{base}{path}"));
            passed += p;
            failed += f;
        }
        if navigation(&app, &base) {
            passed += 1;
        } else {
            failed += 1;
        }
        if lifecycle(&app, &format!("{base}/permissive"), 50) {
            passed += 1;
        } else {
            failed += 1;
        }
        if failed == 0 {
            log::info!("[web_pane/selftest] ===== ALL PASS ({passed}) =====");
        } else {
            log::error!("[web_pane/selftest] ===== {failed} FAILED, {passed} passed =====");
        }
    });
}
