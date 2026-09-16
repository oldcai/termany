import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { gitDiffs } from "./git";

const execFileAsync = promisify(execFile);

test("an untracked diff reads and returns only a bounded file prefix", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "termany-git-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });

  // Sparse growth makes the regression cheap to create: the old readFile()
  // path still had to allocate/read the full 32 MiB, while the bounded reader
  // touches only the prefix the API can actually return.
  const relative = "large-untracked.txt";
  const file = await open(path.join(root, relative), "w");
  await file.write(Buffer.alloc(8192, 0x61), 0, 8192, 0);
  await file.truncate(32 * 1024 * 1024);
  await file.close();

  const diffs = await gitDiffs({
    cwd: root,
    files: [{ path: relative, section: "untracked" }],
  });
  const diff = diffs[`untracked:${relative}`];

  assert.ok(diff);
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= 512 * 1024);
  assert.match(diff.diff, /^--- \/dev\/null\n\+\+\+ b\/large-untracked\.txt/m);
});
