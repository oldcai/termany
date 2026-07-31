import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  controlEnvironment,
  extractOscClaims,
  IdentityRegistry,
  OSC_CLAIM_REPLAY_PATTERN,
  projectRootFor,
  tokenFromHeaders,
} from "./identity.js";

const NONCE = "abcdef0123456789";

/** A clock the tests drive by hand, so TTL behaviour doesn't need real waiting. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("extractOscClaims", () => {
  test("finds a BEL-terminated claim", () => {
    assert.deepEqual(extractOscClaims(`\x1b]7717;claim;${NONCE}\x07`), [NONCE]);
  });

  test("finds an ST-terminated claim", () => {
    assert.deepEqual(extractOscClaims(`\x1b]7717;claim;${NONCE}\x1b\\`), [NONCE]);
  });

  test("finds a claim buried in ordinary output", () => {
    const chunk = `$ my-agent\r\nstarting\x1b]7717;claim;${NONCE}\x07 up\r\n`;
    assert.deepEqual(extractOscClaims(chunk), [NONCE]);
  });

  test("ignores a nonce that is too short to be one", () => {
    assert.deepEqual(extractOscClaims("\x1b]7717;claim;short\x07"), []);
  });

  test("ignores other OSC sequences", () => {
    assert.deepEqual(extractOscClaims("\x1b]0;window title\x07\x1b]52;c;Zm9v\x07"), []);
  });

  test("has no leftover regex state between calls", () => {
    const chunk = `\x1b]7717;claim;${NONCE}\x07`;
    assert.deepEqual(extractOscClaims(chunk), [NONCE]);
    assert.deepEqual(extractOscClaims(chunk), [NONCE], "a second identical call still matches");
  });

  test("caps how many claims one chunk can register", () => {
    const chunk = Array.from(
      { length: 20 },
      (_, i) => `\x1b]7717;claim;${String(i).padStart(16, "0")}\x07`
    ).join("");
    assert.equal(extractOscClaims(chunk).length, 8);
  });
});

describe("OSC_CLAIM_REPLAY_PATTERN", () => {
  /** The replay stripper has to be wider than the parser: a malformed claim must
   *  not survive into a replayed stream either. */
  test("strips well-formed and malformed claims alike", () => {
    const raw = `a\x1b]7717;claim;${NONCE}\x07b\x1b]7717;garbage\x07c`;
    assert.equal(raw.replace(OSC_CLAIM_REPLAY_PATTERN, ""), "abc");
  });

  test("leaves other OSC sequences alone", () => {
    const raw = "\x1b]0;title\x07keep";
    assert.equal(raw.replace(OSC_CLAIM_REPLAY_PATTERN, ""), raw);
  });
});

describe("projectRootFor", () => {
  const repos = (dirs: string[]) => (dir: string) => dirs.includes(dir);

  test("finds the nearest .git ancestor", () => {
    assert.equal(projectRootFor("/a/b/c/d", repos(["/a/b"])), "/a/b");
  });

  test("prefers the nearest when repos nest", () => {
    assert.equal(projectRootFor("/a/b/c/d", repos(["/a", "/a/b/c"])), "/a/b/c");
  });

  test("a repo root resolves to itself", () => {
    assert.equal(projectRootFor("/a/b", repos(["/a/b"])), "/a/b");
  });

  test("no repo anywhere falls back to the directory itself", () => {
    assert.equal(projectRootFor("/a/b/c", repos([])), "/a/b/c");
  });

  test("normalises the path it returns", () => {
    assert.equal(projectRootFor("/a/b/../b/c/", repos([])), "/a/b/c");
  });
});

describe("IdentityRegistry", () => {
  test("a pane's token is stable across calls", () => {
    const reg = new IdentityRegistry();
    assert.equal(reg.tokenForPane("pane-1"), reg.tokenForPane("pane-1"));
  });

  test("different panes get different tokens", () => {
    const reg = new IdentityRegistry();
    assert.notEqual(reg.tokenForPane("pane-1"), reg.tokenForPane("pane-2"));
  });

  test("a token identifies its pane", () => {
    const reg = new IdentityRegistry();
    const token = reg.tokenForPane("pane-1");
    assert.deepEqual(reg.identify(token)?.paneId, "pane-1");
    assert.equal(reg.identify(token)?.source, "env");
  });

  test("unknown, empty and absent tokens are all just undefined", () => {
    const reg = new IdentityRegistry();
    reg.tokenForPane("pane-1");
    assert.equal(reg.identify("made-up"), undefined);
    assert.equal(reg.identify(""), undefined);
    assert.equal(reg.identify(undefined), undefined);
    assert.equal(reg.identify(null), undefined);
  });

  test("revoking a pane invalidates its token", () => {
    const reg = new IdentityRegistry();
    const token = reg.tokenForPane("pane-1");
    reg.revokePane("pane-1");
    assert.equal(reg.identify(token), undefined);
  });

  test("a revoked pane gets a fresh token, not the old one back", () => {
    const reg = new IdentityRegistry();
    const first = reg.tokenForPane("pane-1");
    reg.revokePane("pane-1");
    assert.notEqual(reg.tokenForPane("pane-1"), first);
  });

  test("tokens are long enough to be unguessable", () => {
    const reg = new IdentityRegistry();
    assert.ok(reg.tokenForPane("pane-1").length >= 40);
  });
});

describe("IdentityRegistry — OSC claims", () => {
  test("a nonce seen on a pane's tty redeems to that pane", () => {
    const reg = new IdentityRegistry();
    reg.noteOscClaim("pane-7", NONCE);
    const out = reg.redeemClaim(NONCE);
    assert.equal(out?.paneId, "pane-7");
    assert.equal(reg.identify(out!.token)?.paneId, "pane-7");
  });

  test("the redeemed identity records that it came from a tty", () => {
    const reg = new IdentityRegistry();
    reg.noteOscClaim("pane-7", NONCE);
    const out = reg.redeemClaim(NONCE)!;
    assert.equal(reg.identify(out.token)?.source, "osc");
  });

  /** The whole point: a nonce nobody saw on a real PTY buys nothing. */
  test("a nonce that was never emitted cannot be redeemed", () => {
    const reg = new IdentityRegistry();
    assert.equal(reg.redeemClaim(NONCE), undefined);
  });

  test("a nonce is single use", () => {
    const reg = new IdentityRegistry();
    reg.noteOscClaim("pane-7", NONCE);
    assert.ok(reg.redeemClaim(NONCE));
    assert.equal(reg.redeemClaim(NONCE), undefined, "replaying the nonce fails");
  });

  test("a nonce expires", () => {
    const clock = fakeClock();
    const reg = new IdentityRegistry(clock.now);
    reg.noteOscClaim("pane-7", NONCE);
    clock.advance(31_000);
    assert.equal(reg.redeemClaim(NONCE), undefined);
  });

  test("a nonce still works just inside its window", () => {
    const clock = fakeClock();
    const reg = new IdentityRegistry(clock.now);
    reg.noteOscClaim("pane-7", NONCE);
    clock.advance(29_000);
    assert.equal(reg.redeemClaim(NONCE)?.paneId, "pane-7");
  });

  test("expired claims are pruned rather than accumulating", () => {
    const clock = fakeClock();
    const reg = new IdentityRegistry(clock.now);
    for (let i = 0; i < 10; i++) reg.noteOscClaim("pane-7", `nonce-${i}-aaaaaaaaaaaa`);
    assert.equal(reg.pendingCount, 10);
    clock.advance(31_000);
    assert.equal(reg.pendingCount, 0);
  });

  test("outstanding claims are capped", () => {
    const reg = new IdentityRegistry();
    for (let i = 0; i < 200; i++) reg.noteOscClaim("pane-7", `nonce-${i}-aaaaaaaaaaaa`);
    assert.equal(reg.pendingCount, 64);
  });

  test("a redeemed claim yields the pane's existing token", () => {
    const reg = new IdentityRegistry();
    const envToken = reg.tokenForPane("pane-7");
    reg.noteOscClaim("pane-7", NONCE);
    assert.equal(reg.redeemClaim(NONCE)?.token, envToken);
  });
});

describe("tokenFromHeaders", () => {
  test("reads a Bearer authorization header", () => {
    assert.equal(tokenFromHeaders({ authorization: "Bearer abc123" }), "abc123");
  });

  test("is case-insensitive about the scheme", () => {
    assert.equal(tokenFromHeaders({ authorization: "bearer abc123" }), "abc123");
  });

  test("reads the explicit header, and prefers it", () => {
    assert.equal(
      tokenFromHeaders({ authorization: "Bearer from-auth", "x-termany-token": "from-header" }),
      "from-header"
    );
  });

  test("ignores a non-Bearer authorization scheme", () => {
    assert.equal(tokenFromHeaders({ authorization: "Basic abc123" }), undefined);
  });

  test("no headers means no token", () => {
    assert.equal(tokenFromHeaders({}), undefined);
  });

  test("takes the first value when a header is repeated", () => {
    assert.equal(tokenFromHeaders({ "x-termany-token": ["one", "two"] }), "one");
  });
});

describe("controlEnvironment", () => {
  test("names the pane, the endpoint and the token", () => {
    assert.deepEqual(controlEnvironment("pane-1", "tok", "http://127.0.0.1:5174"), {
      TERMANY_PANE_ID: "pane-1",
      TERMANY_CONTROL_URL: "http://127.0.0.1:5174/api/control",
      TERMANY_CONTROL_TOKEN: "tok",
    });
  });
});
