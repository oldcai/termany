import assert from "node:assert/strict";
import test from "node:test";
import { agentGreetingPrompt } from "./agentGreeting";

test("private greetings include Bot profile, interface language, local time and variation", () => {
  const prompt = agentGreetingPrompt({
    bot: { id: "writer", name: "  小书童  ", description: "  帮用户润色文字  ", labels: "writing, warm" },
    language: "zh-CN",
    now: new Date("2026-09-13T01:30:00.000Z"),
    timeZone: "Asia/Shanghai",
    variation: "topic-variation",
  });

  assert.match(prompt, /exactly one short, natural sentence/);
  assert.match(prompt, /holiday, festival/);
  assert.match(prompt, /topic-variation/);
  assert.match(prompt, /zh-CN/);
  assert.match(prompt, /Asia\/Shanghai/);
  assert.match(prompt, /2026/);
  assert.match(prompt, /小书童/);
  assert.match(prompt, /帮用户润色文字/);
  assert.match(prompt, /writing, warm/);
  assert.match(prompt, /private chat/);
});

test("group greetings identify the leader as speaker and include the group context", () => {
  const prompt = agentGreetingPrompt({
    bot: { id: "lead", name: "Lead", description: "Coordinate research", labels: "planning" },
    group: {
      name: "Launch crew",
      description: "Prepare the release",
      humanName: "Ada",
      members: [
        { id: "lead", name: "Lead", description: "Coordinate research" },
        { id: "writer", name: "Writer", description: "Draft copy" },
      ],
    },
    language: "en",
    now: new Date("2026-12-25T10:00:00.000Z"),
    timeZone: "UTC",
    variation: "group-variation",
  });

  assert.match(prompt, /currentBot is the leader/);
  assert.match(prompt, /Launch crew/);
  assert.match(prompt, /Prepare the release/);
  assert.match(prompt, /Ada/);
  assert.match(prompt, /Writer/);
  assert.match(prompt, /group-variation/);
});
