import assert from "node:assert/strict";
import test from "node:test";
import { autoExpandedRowKeys, parseDiff, type GitRow } from "./components/GitDiffView";

function row(path: string, patch: Partial<GitRow> = {}): GitRow {
  return {
    path,
    section: "unstaged",
    status: "M",
    additions: 1,
    deletions: 1,
    ...patch,
  };
}

test("auto expansion stays bounded when many untracked file sizes are unknown", () => {
  const rows = Array.from({ length: 100 }, (_, i) => row(`new-${i}.txt`, {
    section: "untracked",
    status: "?",
    additions: 0,
    deletions: 0,
  }));

  const expanded = autoExpandedRowKeys(rows);

  assert.equal(expanded.size, 4);
  assert.ok(expanded.has("untracked:new-0.txt"));
  assert.ok(!expanded.has("untracked:new-4.txt"));
});

test("one huge first diff does not cause later huge files to auto-expand", () => {
  const expanded = autoExpandedRowKeys([
    row("first.lock", { additions: 20_000, deletions: 10_000 }),
    row("second.lock", { additions: 15_000, deletions: 0 }),
    row("small.ts"),
  ]);

  assert.deepEqual([...expanded], ["unstaged:first.lock", "unstaged:small.ts"]);
});

test("incremental parsing stops at the requested render tranche", () => {
  const diff = `@@ -1,1 +1,100000 @@\n${Array.from({ length: 10_000 }, (_, i) => `+line ${i}`).join("\n")}`;

  const lines = parseDiff(diff, 301);

  assert.equal(lines.length, 301);
  assert.equal(lines[0].kind, "hunk");
  assert.equal(lines[300].newNo, 300);
});
