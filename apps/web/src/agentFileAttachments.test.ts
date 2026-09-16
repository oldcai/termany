import assert from "node:assert/strict";
import test from "node:test";
import { agentMessagePromptContent, fileAttachmentName } from "./agentFileAttachments";

test("file attachment names work for Unix and Windows paths", () => {
  assert.equal(fileAttachmentName("/Users/me/code/drizzle.config.ts"), "drizzle.config.ts");
  assert.equal(fileAttachmentName("C:\\work\\notes.md"), "notes.md");
});

test("file paths stay out of display content but enter the runtime prompt", () => {
  const display = "Review this";
  const prompt = agentMessagePromptContent({
    content: display,
    files: [{ id: "f", kind: "file", name: "notes.md", path: "/tmp/notes.md" }],
  });
  assert.equal(display, "Review this");
  assert.equal(prompt, "Review this\nAttached files:\n\"/tmp/notes.md\"");
});

test("a reply carries the referenced message into the runtime prompt", () => {
  const prompt = agentMessagePromptContent({
    content: "That is the part I meant.",
    replyTo: { id: "earlier", content: "Which section should I change?" },
  });
  assert.equal(prompt,
    "Replying to this earlier message:\n> Which section should I change?\n\nThat is the part I meant.");
});
