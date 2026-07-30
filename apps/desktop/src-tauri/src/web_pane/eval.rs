//! Running JavaScript inside a web pane and getting the value back.
//!
//! Four wry behaviours shape everything here; all four were confirmed
//! empirically in Spike A rather than merely read out of the source:
//!
//!   1. Before the first navigation commit the callback is dropped on the
//!      floor. Because the callback owns our sender, that surfaces as
//!      `Disconnected`, not a timeout — which is what lets us fail fast.
//!   2. A thrown exception arrives as `""`, indistinguishable from
//!      `undefined`. Hence the envelope.
//!   3. The returned JS value is JSON-serialised by wry, so a JS String
//!      arrives JSON-quoted and needs decoding twice.
//!   4. A non-JSON-representable value (NaN) throws an Objective-C exception
//!      inside NSJSONSerialization and terminates the process. Guarded on the
//!      JS side by instrument.js, which only ever returns Strings.

use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::time::{Duration, Instant};
use tauri::{Runtime, Webview};

pub const DEFAULT_TIMEOUT_MS: u64 = 5_000;
const MIN_TIMEOUT_MS: u64 = 50;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_MAX_RESULT_BYTES: usize = 512 * 1024;
/// Backoff for polling a parked promise. Tight at first so a fast await costs
/// one extra round trip, then flat so a slow one is not a busy loop.
const POLL_BACKOFF_MS: [u64; 6] = [5, 10, 20, 40, 80, 100];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalOptions {
    pub label: String,
    pub js: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default = "default_true")]
    pub await_promise: bool,
    #[serde(default)]
    pub max_result_bytes: Option<usize>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalResult {
    pub ok: bool,
    pub value: Option<serde_json::Value>,
    pub error: Option<String>,
    /// The JS constructor name ("TypeError", ...) when the expression threw.
    pub name: Option<String>,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, serde::Deserialize)]
struct Envelope {
    ok: bool,
    #[serde(default)]
    value: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    pending: Option<String>,
    #[serde(default)]
    truncated: bool,
}

pub enum EvalWait {
    Timeout,
    /// wry destroyed the callback: the page has not committed yet, or it
    /// navigated away mid-flight.
    Dropped,
    Dispatch(String),
}

pub fn clamp_timeout(requested: Option<u64>) -> Duration {
    let ms = requested
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    Duration::from_millis(ms)
}

/// One evaluateJavaScript round trip.
///
/// std's sync_channel rather than a tokio oneshot: `tauri::async_runtime`
/// re-exports no oneshot, tauri's tokio feature set omits `time` (so no
/// `tokio::time::timeout`), `SyncSender::send` takes `&self` and therefore
/// drops straight into wry's `Fn` (not FnOnce) callback with no
/// Mutex<Option<..>> dance, and `RecvTimeoutError` distinguishes a real
/// timeout from a destroyed callback.
fn eval_once<R: Runtime>(
    webview: &Webview<R>,
    js: String,
    budget: Duration,
) -> Result<String, EvalWait> {
    let (tx, rx) = sync_channel::<String>(1);
    webview
        .eval_with_callback(js, move |value| {
            let _ = tx.send(value);
        })
        .map_err(|e| EvalWait::Dispatch(e.to_string()))?;
    match rx.recv_timeout(budget) {
        Ok(value) => Ok(value),
        Err(RecvTimeoutError::Timeout) => Err(EvalWait::Timeout),
        Err(RecvTimeoutError::Disconnected) => Err(EvalWait::Dropped),
    }
}

fn wait_error(err: EvalWait, timeout: Duration) -> String {
    match err {
        EvalWait::Timeout => format!("eval timed out after {}ms", timeout.as_millis()),
        EvalWait::Dropped => {
            "web pane discarded the evaluation (it is navigating, or has not loaded a page yet)"
                .to_string()
        }
        EvalWait::Dispatch(e) => e,
    }
}

/// wry JSON-serialises the JS return value before handing it to the callback,
/// so our envelope — itself a JS String — arrives JSON-quoted. Decode twice.
fn decode_envelope(raw: &str) -> Result<Envelope, String> {
    if raw.is_empty() {
        // wry discards the NSError, so this covers both "the expression threw"
        // and "it returned undefined". instrument.js exists precisely so this
        // is unreachable for well-formed calls; reaching it means the wrapper
        // itself did not run.
        return Err(
            "web pane returned nothing — the instrumentation did not run in this document"
                .to_string(),
        );
    }
    let inner: String = serde_json::from_str(raw)
        .map_err(|_| format!("malformed eval response: {}", truncate(raw, 200)))?;
    serde_json::from_str(&inner)
        .map_err(|_| format!("malformed eval envelope: {}", truncate(&inner, 200)))
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    text.chars().take(max).collect::<String>() + "…"
}

/// How the caller's source is spliced into the wrapper.
///
/// Expression first, statements as a fallback, because the two cannot be told
/// apart without parsing and a wrong guess is a compile error for the whole
/// script.
#[derive(Clone, Copy, PartialEq)]
pub enum Form {
    /// `return (<src>);` — the common case, and the only one that yields a
    /// value for a bare expression like `1+1` or `document.title`.
    Expression,
    /// `<src>` as a function body, for sources that declare and `return`
    /// themselves (`let a = 1; return a;`).
    Statements,
}

/// Build the wrapper that runs the caller's JS inside instrument.js's job table.
///
/// The source is **spliced in textually**, not handed to `eval()`. That is not
/// a style preference: a page's `script-src` governs `eval` (and `new
/// Function`) unless it grants `'unsafe-eval'`, so an eval-based wrapper fails
/// with EvalError on most real sites with a CSP. `evaluateJavaScript:` itself
/// is *not* governed — the wrapper runs fine — so splicing sidesteps the
/// restriction entirely. Confirmed against `script-src 'self' 'unsafe-inline'`,
/// where the eval form failed and this one works.
///
/// The cost is that a syntax error in the caller's source breaks the whole
/// script rather than surfacing as an envelope; `run` detects that and says so.
fn wrapper(job_id: u64, js: &str, form: Form, await_promise: bool, max_bytes: usize) -> String {
    let id = serde_json::to_string(&job_id.to_string()).unwrap_or_else(|_| "\"0\"".into());
    let awaiting = if await_promise { "true" } else { "false" };
    let body = match form {
        Form::Expression => format!("return (\n{js}\n);"),
        Form::Statements => js.to_string(),
    };
    format!(
        r#"(function(){{
  try {{
    var T = window.__TERMANY__;
    if (!T || T.v !== 1) return '{{"ok":false,"error":"instrumentation not installed in this document","name":"TermanyNotReady"}}';
    return T.run({id}, function(){{ {body}
 }}, {awaiting}, {max_bytes});
  }} catch (e) {{
    try {{ return JSON.stringify({{ok:false, error:String((e&&e.stack)||e), name:(e&&e.name)||"Error"}}); }}
    catch (_) {{ return '{{"ok":false,"error":"unserializable error","name":"Error"}}'; }}
  }}
}})()"#
    )
}

/// Is the instrumentation present? Used only to tell "your source did not
/// compile" apart from "our script never ran in this document".
const READY_PROBE: &str =
    r#"(function(){try{return (window.__TERMANY__&&window.__TERMANY__.v===1)?"ready":"absent"}catch(e){return "absent"}})()"#;

/// Take everything the page has buffered since the last drain.
///
/// A plain function call, not an eval of caller-supplied source, so it is
/// immune to both the CSP problem and to a syntax error in someone's snippet.
pub fn drain<R: Runtime>(webview: &Webview<R>, max_bytes: usize) -> Result<EvalResult, String> {
    let started = Instant::now();
    let script = format!(
        r#"(function(){{
  try {{
    var T = window.__TERMANY__;
    if (!T || T.v !== 1) return '{{"ok":false,"error":"instrumentation not installed in this document","name":"TermanyNotReady"}}';
    return T.drain({max_bytes});
  }} catch (e) {{ return '{{"ok":false,"error":"drain failed","name":"Error"}}'; }}
}})()"#
    );
    let timeout = Duration::from_millis(DEFAULT_TIMEOUT_MS);
    let raw = eval_once(webview, script, timeout).map_err(|e| wait_error(e, timeout))?;
    let env = decode_envelope(&raw)?;
    Ok(envelope_to_result(env, started.elapsed().as_millis() as u64))
}

fn take_script(job_id: u64, max_bytes: usize) -> String {
    let id = serde_json::to_string(&job_id.to_string()).unwrap_or_else(|_| "\"0\"".into());
    format!(
        r#"(function(){{
  try {{
    var T = window.__TERMANY__;
    if (!T || T.v !== 1) return '{{"ok":false,"error":"instrumentation went away","name":"TermanyNotReady"}}';
    return T.take({id}, {max_bytes});
  }} catch (e) {{ return '{{"ok":false,"error":"take failed","name":"Error"}}'; }}
}})()"#
    )
}

fn envelope_to_result(env: Envelope, elapsed_ms: u64) -> EvalResult {
    EvalResult {
        ok: env.ok,
        value: env.value,
        error: env.error,
        name: env.name,
        truncated: env.truncated,
        elapsed_ms,
    }
}

/// Run `js` in the pane and wait for a value, awaiting a promise if asked.
pub fn run<R: Runtime>(
    webview: &Webview<R>,
    job_id: u64,
    options: &EvalOptions,
) -> Result<EvalResult, String> {
    let timeout = clamp_timeout(options.timeout_ms);
    let max_bytes = options.max_result_bytes.unwrap_or(DEFAULT_MAX_RESULT_BYTES);
    let started = Instant::now();
    let deadline = started + timeout;

    // Expression form first. An empty reply means the script did not compile,
    // which for a caller passing statements ("let a = 1; return a") is
    // expected — retry as a function body before giving up. Two round trips
    // only on that fallback path.
    let mut raw = eval_once(
        webview,
        wrapper(
            job_id,
            &options.js,
            Form::Expression,
            options.await_promise,
            max_bytes,
        ),
        timeout,
    )
    .map_err(|e| wait_error(e, timeout))?;
    if raw.is_empty() {
        // The caller's budget is for the whole call, not per round trip: giving
        // the retry another full `timeout` is how three sequential attempts add
        // up to 3x what was asked for on one blocking thread.
        raw = eval_once(
            webview,
            wrapper(
                job_id,
                &options.js,
                Form::Statements,
                options.await_promise,
                max_bytes,
            ),
            deadline.saturating_duration_since(Instant::now()),
        )
        .map_err(|e| wait_error(e, timeout))?;
    }
    if raw.is_empty() {
        // Neither form compiled. Distinguish a bad expression from a document
        // our script never reached, because the fixes are entirely different.
        let ready = eval_once(
            webview,
            READY_PROBE.to_string(),
            deadline.saturating_duration_since(Instant::now()),
        )
        .ok()
        .and_then(|r| serde_json::from_str::<String>(&r).ok())
        .unwrap_or_default();
        return Err(if ready == "ready" {
            "the expression did not compile — check it for a syntax error".to_string()
        } else {
            "web pane returned nothing — the instrumentation did not run in this document"
                .to_string()
        });
    }
    let env = decode_envelope(&raw)?;

    let Some(pending) = env.pending.clone() else {
        return Ok(envelope_to_result(env, started.elapsed().as_millis() as u64));
    };
    if !options.await_promise {
        // Caller opted out of waiting; report the parked job rather than
        // pretending it settled.
        return Ok(EvalResult {
            ok: true,
            value: Some(serde_json::json!({ "pending": pending })),
            elapsed_ms: started.elapsed().as_millis() as u64,
            ..Default::default()
        });
    }

    let mut attempt = 0usize;
    loop {
        let now = Instant::now();
        if now >= deadline {
            // Stop listening, but free the slot in the page so a long-running
            // promise does not leak an entry for the life of the document.
            let _ = webview.eval(format!(
                "try{{window.__TERMANY__&&window.__TERMANY__.cancel({});}}catch(e){{}}",
                serde_json::to_string(&job_id.to_string()).unwrap_or_else(|_| "\"0\"".into())
            ));
            return Err(format!("eval timed out after {}ms", timeout.as_millis()));
        }
        let nap = Duration::from_millis(POLL_BACKOFF_MS[attempt.min(POLL_BACKOFF_MS.len() - 1)]);
        std::thread::sleep(nap.min(deadline - now));
        attempt += 1;

        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            continue; // let the deadline branch above own the cancel + error
        }
        let raw = eval_once(webview, take_script(job_id, max_bytes), remaining)
            .map_err(|e| wait_error(e, timeout))?;
        let env = decode_envelope(&raw)?;
        if env.pending.is_none() {
            return Ok(envelope_to_result(env, started.elapsed().as_millis() as u64));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_the_double_encoded_envelope() {
        // What wry actually delivers: the JS String '{"ok":true,"value":2}'
        // arrives JSON-quoted.
        let raw = serde_json::to_string(r#"{"ok":true,"value":2}"#).unwrap();
        let env = decode_envelope(&raw).expect("should decode");
        assert!(env.ok);
        assert_eq!(env.value, Some(serde_json::json!(2)));
    }

    #[test]
    fn decodes_a_thrown_expression() {
        let raw =
            serde_json::to_string(r#"{"ok":false,"error":"TypeError: boom","name":"TypeError"}"#)
                .unwrap();
        let env = decode_envelope(&raw).expect("should decode");
        assert!(!env.ok);
        assert_eq!(env.name.as_deref(), Some("TypeError"));
    }

    #[test]
    fn empty_response_is_a_clear_error_not_a_success() {
        // wry hands back "" both when the expression threw and when it
        // returned undefined. Never let that read as ok.
        let err = decode_envelope("").expect_err("empty must not decode");
        assert!(err.contains("instrumentation"), "unhelpful message: {err}");
    }

    #[test]
    fn malformed_payloads_are_rejected_with_context() {
        assert!(decode_envelope("not json").is_err());
        // Valid JSON string, but its contents are not an envelope.
        let raw = serde_json::to_string("still not an envelope").unwrap();
        let err = decode_envelope(&raw).expect_err("should reject");
        assert!(err.contains("envelope"), "unhelpful message: {err}");
    }

    #[test]
    fn timeouts_are_clamped_to_a_sane_band() {
        assert_eq!(clamp_timeout(None).as_millis() as u64, DEFAULT_TIMEOUT_MS);
        assert_eq!(clamp_timeout(Some(0)).as_millis() as u64, MIN_TIMEOUT_MS);
        assert_eq!(
            clamp_timeout(Some(10_000_000)).as_millis() as u64,
            MAX_TIMEOUT_MS
        );
        assert_eq!(clamp_timeout(Some(2_500)).as_millis() as u64, 2_500);
    }

    #[test]
    fn the_wrapper_never_uses_eval() {
        // A page's script-src governs eval() unless it grants 'unsafe-eval',
        // so an eval-based wrapper fails with EvalError on most real sites
        // that set a CSP. Splicing the source in textually avoids it. This is
        // a regression guard for a bug that was found on a live page, not a
        // hypothetical.
        for form in [Form::Expression, Form::Statements] {
            let script = wrapper(1, "document.title", form, true, 1024);
            assert!(
                !script.contains("eval("),
                "wrapper must not compile a string at runtime"
            );
            assert!(!script.contains("new Function"));
        }
    }

    #[test]
    fn expression_form_returns_the_value() {
        let script = wrapper(1, "1+1", Form::Expression, true, 1024);
        assert!(script.contains("return (\n1+1\n);"));
    }

    #[test]
    fn statement_form_splices_the_body_verbatim() {
        let script = wrapper(7, "let a = 1;\nreturn a;", Form::Statements, false, 64);
        assert!(script.contains("let a = 1;\nreturn a;"));
        // No `return (...)` wrapper — the source returns for itself.
        assert!(!script.contains("return (\nlet a"));
    }

    #[test]
    fn a_line_comment_cannot_swallow_the_wrapper_tail() {
        // The expression is placed on its own line precisely so a trailing
        // `// comment` cannot comment out the closing paren.
        let script = wrapper(1, "1 + 1 // trailing comment", Form::Expression, true, 1024);
        assert!(script.contains("1 + 1 // trailing comment\n);"));
    }

    #[test]
    fn the_job_id_is_json_encoded_not_concatenated() {
        let script = wrapper(42, "1", Form::Expression, true, 1024);
        assert!(script.contains(r#"T.run("42""#));
    }

    #[test]
    fn truncate_counts_characters_not_bytes() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello", 2), "he…");
        // Must not split a multi-byte char.
        assert_eq!(truncate("日本語テスト", 3), "日本語…");
    }
}
