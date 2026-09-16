import assert from "node:assert/strict";
import test from "node:test";
import { isAgentAvailableForBot } from "./agentAvailability";

test("the Bot picker includes only installed, enabled, ready agents", () => {
  assert.equal(isAgentAvailableForBot({ enabled: true, terminalDetected: true, detected: true }), true);
  assert.equal(isAgentAvailableForBot({ enabled: false, terminalDetected: true, detected: true }), false);
  assert.equal(isAgentAvailableForBot({ enabled: true, terminalDetected: false, detected: true }), false);
  assert.equal(isAgentAvailableForBot({ enabled: true, terminalDetected: true, detected: false }), false);
  assert.equal(isAgentAvailableForBot({ enabled: true }), false);
});
