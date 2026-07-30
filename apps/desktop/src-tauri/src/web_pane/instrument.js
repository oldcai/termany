/**
 * Injected into every web pane at document-start via
 * `WebviewBuilder::initialization_script`, on every top-level navigation.
 *
 * THE ONE RULE: every function reachable from Rust returns a JS **String**.
 *
 * Not a style choice. wry hands whatever we return to
 * +[NSJSONSerialization dataWithJSONObject:options:error:] and a value it
 * cannot represent (NaN, Infinity) makes it throw NSInvalidArgumentException —
 * an Objective-C exception, not a Rust panic, so `catch_unwind` cannot
 * intercept it and libc++abi terminates the process. Confirmed in Spike A:
 * evaluating a bare `NaN` killed the app outright. There is no Rust-side
 * defence; this file is the only one.
 *
 * The second reason everything is a String: wry discards the NSError, so a
 * thrown exception reaches Rust as "" — indistinguishable from `undefined`
 * (also ""). The {ok,...} envelope is what makes the two tellable apart.
 *
 * Nothing here ever sends anything anywhere. Rust pulls, using
 * evaluateJavaScript from outside the content process, which is why the page's
 * own Content-Security-Policy is irrelevant to us — verified in Spike A
 * against `connect-src 'none'`, where the page's own fetch was blocked and our
 * drain still returned everything.
 */
(function () {
  "use strict";

  // initialization_script runs on every top-level navigation, and Tauri's own
  // docs recommend guarding on location. Bail on the synthetic documents that
  // are not a page the user is looking at.
  var href;
  try {
    href = String(window.location.href);
  } catch (e) {
    return;
  }
  if (/^(about:blank$|blob:|devtools:|chrome-)/.test(href)) return;
  if (window.__TERMANY__ && window.__TERMANY__.v === 1) return; // idempotent

  var MAX_BYTES_DEFAULT = 512 * 1024;
  var MAX_DEPTH = 6;
  var MAX_ITEMS = 100;
  var MAX_STRING = 8192;

  /**
   * Turn an arbitrary JS value into something JSON.stringify cannot choke on.
   * Cycles, DOM nodes, functions, symbols, bigints and non-finite numbers all
   * have to be neutralised here — a raw JSON.stringify would either throw or
   * (worse) hand a NaN through.
   */
  function sanitize(value, depth, seen) {
    if (value === null) return null;
    var type = typeof value;
    if (type === "boolean") return value;
    if (type === "number") return isFinite(value) ? value : String(value); // NaN/Infinity -> "NaN"
    if (type === "bigint") return String(value) + "n";
    if (type === "string") {
      return value.length > MAX_STRING
        ? value.slice(0, MAX_STRING) + "…(+" + (value.length - MAX_STRING) + " chars)"
        : value;
    }
    if (type === "undefined") return "[undefined]";
    if (type === "symbol") {
      try { return String(value); } catch (e) { return "[Symbol]"; }
    }
    if (type === "function") {
      return "[Function: " + (value.name || "anonymous") + "]";
    }
    if (depth >= MAX_DEPTH) return "[depth limit]";
    if (seen.indexOf(value) !== -1) return "[Circular]";

    try {
      if (value instanceof Error) {
        return { __error: value.name, message: value.message, stack: String(value.stack || "") };
      }
      if (typeof Node !== "undefined" && value instanceof Node) {
        var desc = value.nodeName || "node";
        if (value.id) desc += "#" + value.id;
        if (value.className && typeof value.className === "string") {
          desc += "." + value.className.trim().split(/\s+/).join(".");
        }
        return "[" + desc + "]";
      }
      if (typeof Window !== "undefined" && value instanceof Window) return "[Window]";
      if (typeof Document !== "undefined" && value instanceof Document) return "[Document]";
    } catch (e) {
      /* instanceof can throw on exotic proxies — fall through */
    }

    seen.push(value);
    try {
      if (Array.isArray(value)) {
        var arr = [];
        for (var i = 0; i < value.length && i < MAX_ITEMS; i++) {
          arr.push(sanitize(value[i], depth + 1, seen));
        }
        if (value.length > MAX_ITEMS) arr.push("…(+" + (value.length - MAX_ITEMS) + " more)");
        return arr;
      }
      var out = {};
      var count = 0;
      var keys;
      try { keys = Object.keys(value); } catch (e) { keys = []; }
      for (var k = 0; k < keys.length; k++) {
        if (count >= MAX_ITEMS) {
          out["…"] = "(+" + (keys.length - MAX_ITEMS) + " more keys)";
          break;
        }
        var key = keys[k];
        try {
          // A getter can throw, or be a side-effecting trap. Never let that
          // escape into page code.
          out[key] = sanitize(value[key], depth + 1, seen);
        } catch (e) {
          out[key] = "[threw on access]";
        }
        count++;
      }
      return out;
    } finally {
      seen.pop();
    }
  }

  /** Always returns a String. Never throws. */
  function envelope(obj, maxBytes) {
    var text;
    try {
      text = JSON.stringify(obj);
    } catch (e) {
      return '{"ok":false,"error":"envelope serialization failed","name":"TermanySerialize"}';
    }
    if (typeof text !== "string") {
      return '{"ok":false,"error":"envelope produced no output","name":"TermanySerialize"}';
    }
    var limit = maxBytes || MAX_BYTES_DEFAULT;
    if (text.length > limit) {
      try {
        // A failure that overflows is still a failure: reporting ok:true here
        // would tell Rust an expression succeeded when it actually threw, and
        // an unclipped Error.stack is big enough to reach this branch.
        if (obj && obj.ok === false) {
          return JSON.stringify({
            ok: false,
            error: String(obj.error || "").slice(0, 1024) || "[error too large]",
            name: String(obj.name || "Error"),
            truncated: true,
          });
        }
        return JSON.stringify({
          ok: true,
          value: "[result too large: " + text.length + " chars]",
          truncated: true,
        });
      } catch (e) {
        return '{"ok":false,"error":"result too large","name":"TermanyTooLarge"}';
      }
    }
    return text;
  }

  function describe(err) {
    try {
      if (err instanceof Error) {
        return { error: String(err.stack || err.message || err), name: err.name || "Error" };
      }
      return { error: String(err), name: "Thrown" };
    } catch (e) {
      return { error: "unserializable error", name: "Error" };
    }
  }

  var jobs = Object.create(null);

  // ---- capture -------------------------------------------------------------
  //
  // Two separate rings on purpose: a console flood must not evict the one
  // network record that explains the bug. Bounded in three independent ways
  // (entry count, per-entry chars, total bytes) because any one of them alone
  // is defeatable by a page that logs 10MB blobs.
  var LOG_MAX = 500;
  var NET_MAX = 300;
  var ENTRY_MAX = 4096;
  var TOTAL_MAX = 1 << 20; // 1 MiB across both rings
  var logs = [];
  var net = [];
  var dropped = { logs: 0, net: 0 };
  var seq = 0;
  var bytes = 0;

  function clip(text) {
    if (typeof text !== "string") text = String(text);
    return text.length > ENTRY_MAX
      ? text.slice(0, ENTRY_MAX) + "…(+" + (text.length - ENTRY_MAX) + " chars)"
      : text;
  }

  function push(ring, max, kind, entry) {
    if (bytes > TOTAL_MAX) {
      dropped[kind]++;
      return;
    }
    // Collapse consecutive identical lines into a count. Without this a React
    // render loop buries everything that came before it, in the ring and in
    // the reader's context window alike.
    var last = ring[ring.length - 1];
    if (last && last.k === entry.k && last.text === entry.text && last.level === entry.level) {
      last.count++;
      last.lastAt = entry.at;
      return;
    }
    entry.seq = ++seq;
    entry.count = 1;
    entry.lastAt = entry.at;
    ring.push(entry);
    bytes += (entry.text || "").length + 64;
    while (ring.length > max) {
      var evicted = ring.shift();
      bytes -= (evicted.text || "").length + 64;
      dropped[kind]++;
    }
  }

  function now() {
    try {
      return Math.round(performance.now());
    } catch (e) {
      return 0;
    }
  }

  function argText(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var v = args[i];
      try {
        if (typeof v === "string") parts.push(v);
        else {
          var s = sanitize(v, 0, []);
          parts.push(typeof s === "string" ? s : JSON.stringify(s));
        }
      } catch (e) {
        parts.push("[unserializable]");
      }
    }
    return clip(parts.join(" "));
  }

  // Each wrapper is individually guarded. Breaking a customer's console or
  // fetch is strictly worse than collecting nothing.
  ["log", "info", "warn", "error", "debug", "trace"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      try {
        push(logs, LOG_MAX, "logs", {
          k: "console",
          level: level,
          text: argText(arguments),
          at: now(),
        });
      } catch (e) {
        /* swallow */
      }
      try {
        return original.apply(console, arguments);
      } catch (e) {
        /* swallow */
      }
    };
  });

  try {
    window.addEventListener("error", function (event) {
      try {
        var where = event && event.filename
          ? " (" + event.filename + ":" + event.lineno + ":" + event.colno + ")"
          : "";
        var stack = event && event.error && event.error.stack ? String(event.error.stack) : "";
        push(logs, LOG_MAX, "logs", {
          k: "exception",
          level: "error",
          text: clip(String((event && event.message) || "uncaught error") + where),
          stack: clip(stack),
          at: now(),
        });
      } catch (e) {}
    });
    window.addEventListener("unhandledrejection", function (event) {
      try {
        var reason = event && event.reason;
        var text = reason instanceof Error ? reason.name + ": " + reason.message : String(reason);
        push(logs, LOG_MAX, "logs", {
          k: "rejection",
          level: "error",
          text: clip(text),
          stack: clip(reason && reason.stack ? String(reason.stack) : ""),
          at: now(),
        });
      } catch (e) {}
    });
  } catch (e) {}

  // Method/url/status/duration only. Bodies and headers are deliberately not
  // recorded: they are where the credentials live, they dwarf everything else
  // in size, and they are rarely what identifies a failure.
  //
  // Query strings and fragments are where the rest of the credentials live —
  // OAuth `code`/`access_token`, pre-signed `X-Amz-Signature`, password-reset
  // and session tokens — and this ring is read by out-of-process callers, so
  // the same rule applies: keep the parameter *names*, which is what identifies
  // a request, and drop every value.
  function redactUrl(url) {
    var text = String(url);
    var hash = text.indexOf("#");
    if (hash !== -1) text = text.slice(0, hash); // implicit-flow tokens live here
    var q = text.indexOf("?");
    if (q === -1) return text;
    var parts = text.slice(q + 1).split("&");
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf("=");
      if (eq !== -1) parts[i] = parts[i].slice(0, eq + 1) + "…";
    }
    return text.slice(0, q + 1) + parts.join("&");
  }

  try {
    var originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function (input, init) {
        var started = now();
        var method = "GET";
        var url = "";
        try {
          method = (init && init.method) || (input && input.method) || "GET";
          url = redactUrl(
            typeof input === "string" ? input : (input && input.url) || String(input)
          );
        } catch (e) {}
        var record = function (status, ok, err) {
          try {
            push(net, NET_MAX, "net", {
              k: "fetch",
              level: ok ? "info" : "error",
              method: String(method).toUpperCase(),
              url: clip(url),
              status: status,
              ok: ok,
              ms: now() - started,
              err: err ? clip(String(err)) : undefined,
              text: String(method).toUpperCase() + " " + url + " " + (err ? "failed" : status),
              at: started,
            });
          } catch (e) {}
        };
        try {
          return originalFetch.apply(this, arguments).then(
            function (response) {
              record(response && response.status, !!(response && response.ok), null);
              return response;
            },
            function (error) {
              record(0, false, error);
              throw error;
            }
          );
        } catch (e) {
          record(0, false, e);
          throw e;
        }
      };
    }
  } catch (e) {}

  try {
    var XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      var openOriginal = XHR.prototype.open;
      var sendOriginal = XHR.prototype.send;
      XHR.prototype.open = function (method, url) {
        try {
          this.__termanyReq = {
            method: String(method || "GET").toUpperCase(),
            url: redactUrl(url || ""),
          };
        } catch (e) {}
        return openOriginal.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        var self = this;
        var started = now();
        try {
          // loadend rather than load, so aborts and network failures are
          // recorded too — the cases you most want to see.
          self.addEventListener("loadend", function () {
            try {
              var req = self.__termanyReq || { method: "GET", url: "" };
              var status = self.status || 0;
              push(net, NET_MAX, "net", {
                k: "xhr",
                level: status >= 200 && status < 400 ? "info" : "error",
                method: req.method,
                url: clip(req.url),
                status: status,
                ok: status >= 200 && status < 400,
                ms: now() - started,
                text: req.method + " " + req.url + " " + status,
                at: started,
              });
            } catch (e) {}
          });
        } catch (e) {}
        return sendOriginal.apply(this, arguments);
      };
    }
  } catch (e) {}

  var api = {
    v: 1,

    /**
     * Hand over everything buffered since the last call and clear.
     *
     * Rust pulls this; the page never pushes. That is the whole reason a
     * page's Content-Security-Policy cannot interfere — there is no request to
     * block. Verified against `connect-src 'none'`.
     */
    drain: function (maxBytes) {
      var limit = maxBytes || MAX_BYTES_DEFAULT;
      // Hand over as much as fits, oldest first, and clear only that much.
      // Serialising everything and letting envelope() swap in its
      // "[result too large]" placeholder would still empty the rings — losing
      // the whole flood, which is exactly the capture the reader is after —
      // while keeping everything would wedge every later drain the same way.
      var nLogs = logs.length;
      var nNet = net.length;
      var payload;
      for (;;) {
        payload = {
          ok: true,
          value: {
            href: String(location.href),
            logs: logs.slice(0, nLogs),
            net: net.slice(0, nNet),
            dropped: { logs: dropped.logs, net: dropped.net },
            seq: seq,
          },
        };
        var body;
        try {
          body = JSON.stringify(payload);
        } catch (e) {
          body = "";
        }
        if (body.length <= limit || nLogs + nNet <= 1) break;
        nLogs = nLogs >> 1;
        nNet = nNet >> 1;
      }
      var text = envelope(payload, limit);
      logs = logs.slice(nLogs);
      net = net.slice(nNet);
      dropped = { logs: 0, net: 0 };
      bytes = 0;
      for (var i = 0; i < logs.length; i++) bytes += (logs[i].text || "").length + 64;
      for (var j = 0; j < net.length; j++) bytes += (net[j].text || "").length + 64;
      return text;
    },

    /**
     * Entry point for web_pane_eval.
     *
     * WKWebView's evaluateJavaScript does not await promises, so a thenable
     * result is parked in `jobs` and the caller polls `take`. Returning
     * {ok:true,pending:id} rather than blocking keeps the single eval round
     * trip short and lets Rust own the deadline.
     */
    run: function (id, fn, awaitPromise, maxBytes) {
      var result;
      try {
        result = fn();
      } catch (e) {
        var d = describe(e);
        return envelope({ ok: false, error: d.error, name: d.name }, maxBytes);
      }
      var thenable = result && (typeof result === "object" || typeof result === "function") &&
        typeof result.then === "function";
      if (!thenable || !awaitPromise) {
        return envelope({ ok: true, value: sanitize(result, 0, []) }, maxBytes);
      }
      jobs[id] = { settled: false, payload: null };
      try {
        result.then(
          function (v) {
            if (jobs[id]) jobs[id] = { settled: true, payload: { ok: true, value: sanitize(v, 0, []) } };
          },
          function (e) {
            var dd = describe(e);
            if (jobs[id]) jobs[id] = { settled: true, payload: { ok: false, error: dd.error, name: dd.name } };
          }
        );
      } catch (e) {
        delete jobs[id];
        var d2 = describe(e);
        return envelope({ ok: false, error: d2.error, name: d2.name }, maxBytes);
      }
      return envelope({ ok: true, pending: String(id) }, maxBytes);
    },

    /** Poll a parked job. Returns the envelope once settled, then forgets it. */
    take: function (id, maxBytes) {
      var job = jobs[id];
      if (!job) {
        return envelope({ ok: false, error: "no such job: " + id, name: "TermanyNoJob" }, maxBytes);
      }
      if (!job.settled) return envelope({ ok: true, pending: String(id) }, maxBytes);
      delete jobs[id];
      return envelope(job.payload, maxBytes);
    },

    /** Free a slot whose caller has stopped listening. */
    cancel: function (id) {
      delete jobs[id];
      return "ok";
    },

    ping: function () {
      return "pong";
    },
  };

  try {
    // Non-configurable so a page script cannot delete or shadow it, and frozen
    // so it cannot swap the methods out either — Rust trusts drain/take to
    // return the string envelope, and a page-supplied replacement returning
    // e.g. NaN would reach WKWebView's completion handler unsanitized. We win
    // the race unconditionally: WKUserScriptInjectionTime::AtDocumentStart
    // runs before any page script (wry wkwebview/mod.rs:783).
    Object.freeze(api);
    Object.defineProperty(window, "__TERMANY__", {
      value: api,
      writable: false,
      configurable: false,
      enumerable: false,
    });
  } catch (e) {
    /* never throw into page code */
  }
})();
