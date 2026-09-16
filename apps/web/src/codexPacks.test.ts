import assert from "node:assert/strict";
import test from "node:test";
import { fetchCodexListings } from "./themes/codex-listings";

test("fetchCodexListings retries a transient failure", async () => {
  let calls = 0;
  const result = await fetchCodexListings({
    attempts: 3,
    endpoint: "http://termany.test/api/codex-themes",
    retryDelayMs: 0,
    request: async () => {
      calls += 1;
      if (calls < 3) throw new Error("server is starting");
      return new Response(
        JSON.stringify({
          themes: [{ manifest: { id: "ink" }, artPath: null, previewPath: null }],
          root: "/tmp/themes",
        }),
        { status: 200 }
      );
    },
  });

  assert.equal(calls, 3);
  assert.equal(result.themes[0]?.manifest.id, "ink");
  assert.equal(result.root, "/tmp/themes");
});

test("fetchCodexListings rejects an invalid response instead of reporting an empty library", async () => {
  await assert.rejects(
    fetchCodexListings({
      attempts: 1,
      endpoint: "http://termany.test/api/codex-themes",
      request: async () => new Response(JSON.stringify({ root: "/tmp/themes" }), { status: 200 }),
    }),
    /invalid response/
  );
});

test("fetchCodexListings reports an HTTP error from the theme service", async () => {
  await assert.rejects(
    fetchCodexListings({
      attempts: 1,
      endpoint: "http://termany.test/api/codex-themes",
      request: async () => new Response(JSON.stringify({ error: "theme scan failed" }), { status: 503 }),
    }),
    /theme scan failed/
  );
});
