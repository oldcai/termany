import assert from "node:assert/strict";
import test from "node:test";
import {
  guard,
  isLoopbackHost,
  resolveAllowedOrigins,
  resolveBindHost,
  VITE_DEV_PORT,
} from "./security.js";

const LOOPBACK = { bindHost: "127.0.0.1" };

test("allows the packaged app's own origin", () => {
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]) {
    assert.deepEqual(guard({ host: "localhost:5174", origin }, LOOPBACK), { ok: true }, origin);
  }
});

test("allows the vite dev client", () => {
  assert.equal(
    guard({ host: "127.0.0.1:5175", origin: `http://localhost:${VITE_DEV_PORT}` }, LOOPBACK).ok,
    true
  );
});

test("allows a non-browser caller that sends no Origin", () => {
  // curl, an agent process, the Rust shell's version probe.
  assert.equal(guard({ host: "127.0.0.1:5174" }, LOOPBACK).ok, true);
});

test("rejects a page the user merely visited", () => {
  const verdict = guard(
    { host: "localhost:5174", origin: "https://evil.example" },
    LOOPBACK
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "origin");
  assert.equal(verdict.detail, "https://evil.example");
});

test("rejects DNS rebinding — loopback packet, attacker Host", () => {
  // evil.example resolved to 127.0.0.1, so the request really does arrive on
  // the loopback socket. The Host header is what gives it away.
  const verdict = guard({ host: "evil.example:5174" }, LOOPBACK);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "host");
});

test("rejects a missing Host while bound to loopback", () => {
  const verdict = guard({}, LOOPBACK);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "host");
  assert.equal(verdict.detail, "(absent)");
});

test("accepts every loopback spelling of Host", () => {
  for (const host of [
    "localhost:5174",
    "127.0.0.1:5174",
    "[::1]:5174",
    "localhost",
    "127.0.0.1",
    "LOCALHOST:5174",
  ]) {
    assert.equal(guard({ host }, LOOPBACK).ok, true, host);
  }
});

test("skips the Host check when the operator bound off-loopback on purpose", () => {
  // TERMANY_BIND=0.0.0.0 is the documented remote-server workflow; insisting
  // on a loopback Host there would reject every legitimate request.
  assert.equal(guard({ host: "192.168.1.5:5174" }, { bindHost: "0.0.0.0" }).ok, true);
  // Origin still applies.
  assert.equal(
    guard({ host: "192.168.1.5:5174", origin: "https://evil.example" }, { bindHost: "0.0.0.0" }).ok,
    false
  );
});

test("rejects a cross-site load that carries no Origin", () => {
  // <img src="http://localhost:5174/api/..."> sends no Origin but does send
  // Sec-Fetch-Site. It cannot read the response, but it can still trigger a
  // side effect, so it does not get to reach a handler.
  const verdict = guard(
    { host: "localhost:5174", "sec-fetch-site": "cross-site" },
    LOOPBACK
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "sec-fetch-site");
});

test("allows same-origin and none Sec-Fetch-Site", () => {
  for (const site of ["same-origin", "same-site", "none"]) {
    assert.equal(guard({ host: "localhost:5174", "sec-fetch-site": site }, LOOPBACK).ok, true, site);
  }
});

test("an allowlisted Origin wins over a cross-site Sec-Fetch-Site", () => {
  // REGRESSION: the app's own client really is cross-site. The dev client is
  // served from localhost:15173 while the API answers on 127.0.0.1 — different
  // registrable domains — so every legitimate XHR carries
  // `Sec-Fetch-Site: cross-site`. Judging on it after Origin already matched
  // would 403 Termany itself.
  for (const origin of ["tauri://localhost", `http://localhost:${VITE_DEV_PORT}`]) {
    assert.equal(
      guard({ host: "127.0.0.1:5175", origin, "sec-fetch-site": "cross-site" }, LOOPBACK).ok,
      true,
      origin
    );
  }
});

test("a hostile Origin is still rejected however it labels itself", () => {
  for (const site of ["same-origin", "same-site", "none", "cross-site"]) {
    const verdict = guard(
      { host: "localhost:5174", origin: "https://evil.example", "sec-fetch-site": site },
      LOOPBACK
    );
    assert.equal(verdict.ok, false, site);
    assert.equal(verdict.reason, "origin", site);
  }
});

test("an empty Origin is treated as absent, not as an origin to match", () => {
  assert.equal(guard({ host: "localhost:5174", origin: "" }, LOOPBACK).ok, true);
});

test("honours an explicit allowlist", () => {
  const config = { bindHost: "127.0.0.1", allowedOrigins: ["https://trusted.example"] };
  assert.equal(guard({ host: "localhost:5174", origin: "https://trusted.example" }, config).ok, true);
  // An explicit list replaces the defaults rather than extending them.
  assert.equal(guard({ host: "localhost:5174", origin: "tauri://localhost" }, config).ok, false);
});

test("resolveAllowedOrigins appends TERMANY_ALLOWED_ORIGINS to the defaults", () => {
  const origins = resolveAllowedOrigins({ TERMANY_ALLOWED_ORIGINS: "null, https://a.example" });
  assert.ok(origins.includes("tauri://localhost"));
  assert.ok(origins.includes("null"));
  assert.ok(origins.includes("https://a.example"));
});

test("resolveAllowedOrigins tolerates an unset or empty variable", () => {
  assert.deepEqual(resolveAllowedOrigins({}), resolveAllowedOrigins({ TERMANY_ALLOWED_ORIGINS: "" }));
});

test("resolveBindHost defaults to loopback and honours TERMANY_BIND", () => {
  assert.equal(resolveBindHost({}), "127.0.0.1");
  assert.equal(resolveBindHost({ TERMANY_BIND: "" }), "127.0.0.1");
  assert.equal(resolveBindHost({ TERMANY_BIND: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveBindHost({ TERMANY_BIND: "  ::  " }), "::");
});

test("isLoopbackHost", () => {
  for (const host of ["127.0.0.1", "::1", "[::1]", "localhost", "LocalHost"]) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", ""]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
});
