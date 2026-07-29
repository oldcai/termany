# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Email **support@thinkany.ai** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- any suggested fix.

We aim to acknowledge reports within a few business days and will keep you updated
as we investigate and ship a fix. Responsible disclosure is appreciated — please
give us a reasonable window to release a patch before any public disclosure.

## Scope notes

- Termany is **BYOK**: model-provider API keys are entered by the user and stored
  locally in `~/.termany/termany.db`. They are never committed to this repo or sent
  anywhere other than the provider the user configured.
- The desktop app runs a local PTY/API server. It binds loopback only — `127.0.0.1`
  plus, best-effort, `[::1]` (override with `TERMANY_BIND`, which opts you out of
  that protection) — and it has **no
  authentication** — instead it rejects any request that does not come from the
  app itself, by checking `Host` (which blocks DNS rebinding), `Origin` against an
  allowlist, and `Sec-Fetch-Site`. The same check runs on the WebSocket upgrade,
  which CORS does not cover. See `apps/server/src/security.ts`.
- Reports about that surface are in scope — in particular anything that reaches
  `/api/fs/*`, `/api/scroll`, or the PTY WebSocket from another machine, from a
  web page the user merely visited, or from a page loaded in a browser pane.
