import assert from "node:assert/strict";
import test from "node:test";
import { extractDroppedPaths } from "./desktopFileDrop";

test("extracts decoded local paths from a URI list", () => {
  const transfer = {
    getData: (type: string) => type === "text/uri-list"
      ? "# Finder metadata\nfile:///Users/me/My%20File.txt\nhttps://example.com/not-local"
      : "",
    files: [],
  } as unknown as DataTransfer;

  assert.deepEqual(extractDroppedPaths(transfer), ["/Users/me/My File.txt"]);
});

test("falls back to WebView File.path values", () => {
  const transfer = {
    getData: () => "",
    files: [{ path: "/tmp/one.txt" }, {}, { path: "/tmp/two.png" }],
  } as unknown as DataTransfer;

  assert.deepEqual(extractDroppedPaths(transfer), ["/tmp/one.txt", "/tmp/two.png"]);
});
