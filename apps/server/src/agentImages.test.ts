import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAgentImages, saveAgentOutputImages } from "./agentImages.js";

test("loads bounded local images for model and ACP vision requests", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-agent-image-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const imagePath = path.join(directory, "shot.png");
  await fs.writeFile(imagePath, Buffer.from("test image"));
  const images = await loadAgentImages([{ path: imagePath, mimeType: "image/jpeg" }]);
  assert.deepEqual(images, [{
    path: imagePath,
    mimeType: "image/png",
    data: Buffer.from("test image").toString("base64"),
  }]);
});

test("rejects unsupported attachments before contacting a model", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-agent-image-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "notes.txt");
  await fs.writeFile(filePath, "not an image");
  await assert.rejects(loadAgentImages([{ path: filePath }]), /Unsupported image format/);
});

test("persists ACP output images as stable path-backed chat attachments", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "termany-agent-output-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("generated image bytes");
  const content = [{ type: "content", content: {
    type: "image", mimeType: "image/png", data: bytes.toString("base64"),
  } }];

  const first = await saveAgentOutputImages(content, directory);
  const repeated = await saveAgentOutputImages(content, directory);
  assert.equal(first.length, 1);
  assert.deepEqual(repeated, first, "repeated tool updates reuse one attachment");
  assert.equal(first[0].kind, "image");
  assert.equal(first[0].mimeType, "image/png");
  assert.equal(path.dirname(first[0].path), directory);
  assert.deepEqual(await fs.readFile(first[0].path), bytes);
  assert.deepEqual(await saveAgentOutputImages([
    { type: "content", content: { type: "text", text: "not an image" } },
    { type: "image", mimeType: "image/svg+xml", data: bytes.toString("base64") },
  ], directory), []);
});
