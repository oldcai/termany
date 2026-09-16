import assert from "node:assert/strict";
import test from "node:test";
import { localMarkdownMediaPath, markdownMediaUrl } from "./markdownLocalMedia";

test("rewrites absolute local media paths for the server media endpoint", () => {
  assert.equal(localMarkdownMediaPath("/Users/idoubi/idoubi-ai.png"), "/Users/idoubi/idoubi-ai.png");
  assert.equal(localMarkdownMediaPath("file:///Users/idoubi/a%20shot.png"), "/Users/idoubi/a shot.png");
  assert.equal(localMarkdownMediaPath("C:%5CUsers%5Cidoubi%5Cshot.webp"), "C:\\Users\\idoubi\\shot.webp");
  assert.equal(localMarkdownMediaPath("%5C%5Cserver%5Cshare%5Cshot.jpg"), "\\\\server\\share\\shot.jpg");
  assert.equal(
    markdownMediaUrl("/Users/idoubi/idoubi-ai.png", "http://localhost:5174/api/fs/media"),
    "http://localhost:5174/api/fs/media?path=%2FUsers%2Fidoubi%2Fidoubi-ai.png"
  );
});

test("leaves remote, relative, anchor and non-media links untouched", () => {
  for (const value of [
    "https://idoubi.ai/shot.png",
    "//cdn.example.com/shot.png",
    "images/shot.png",
    "#preview",
    "/docs/getting-started",
    "mailto:me@idoubi.cc",
  ]) {
    assert.equal(localMarkdownMediaPath(value), undefined, value);
  }
});
