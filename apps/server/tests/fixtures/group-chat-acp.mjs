import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const sessionId = `group-test-${process.pid}`;
let model = "model-a";
let promptCount = 0;
const config = () => [{ id: "model", name: "Model", type: "select", category: "model", currentValue: model,
  options: [{ value: "model-a", name: "Model A" }, { value: "model-b", name: "Model B" }] }];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } });
  else if (method === "session/new") send({ id, result: { sessionId, configOptions: config() } });
  else if (method === "session/set_config_option") {
    model = params.value;
    send({ id, result: { configOptions: config() } });
  } else if (method === "session/prompt") {
    send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: JSON.stringify({ sessionId, pid: process.pid, model, prompt: params.prompt, promptCount: ++promptCount }) } } } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) send({ id, error: { code: -32601, message: method } });
}
