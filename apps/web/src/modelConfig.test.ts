import assert from "node:assert/strict";
import test from "node:test";
import { configuredDefaultModel, configuredDefaultModelLabel } from "./modelConfig";

test("Termany is available only when its default model is configured", () => {
  assert.equal(configuredDefaultModel({ defaultModel: "", providers: [] }), "");
  assert.equal(configuredDefaultModel({
    defaultModel: "openai/gpt-5",
    providers: [{ id: "openai", name: "OpenAI", models: ["gpt-5"] }],
  }), "openai/gpt-5");
  assert.equal(configuredDefaultModel({
    defaultModel: "openai/removed",
    providers: [{ id: "openai", name: "OpenAI", models: ["gpt-5"] }],
  }), "");
});

test("the default model label uses the provider name rather than its internal id", () => {
  assert.equal(configuredDefaultModelLabel({
    defaultModel: "51b8160b/google/gemini-2.5-pro",
    providers: [{
      id: "51b8160b",
      name: "Google AI",
      models: ["google/gemini-2.5-pro"],
    }],
  }), "Google AI/google/gemini-2.5-pro");
  assert.equal(configuredDefaultModelLabel({
    defaultModel: "local/model",
    providers: [{ id: "local", name: "", models: ["model"] }],
  }), "local/model");
});
