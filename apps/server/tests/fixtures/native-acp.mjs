// Offline peer: exercises native/legacy ACP using the real transport and SDK.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
const dialect = process.argv[2];
if (dialect === "child") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  appendFileSync("native-child.pid", String(child.pid));
}
if (dialect === "exit") {
  process.stderr.write("Native agent startup failed: missing dependency\n");
  process.exit(2);
}
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const sessionId = `native-${process.pid}`;
let model = "default", mode = "ask", turns = 0, pending, lastPrompt = "";
const models = () => ({ currentModelId: model, availableModels: [{ modelId: "default", name: "Default" }, { modelId: "other", name: "Other model" }] });
const modes = () => ({ currentModeId: mode, availableModes: [{ id: "ask", name: "Ask" }, { id: "code", name: "Code" }] });
const options = () => [{ id: "model", name: "Model", category: "model", type: "select", currentValue: model,
  options: models().availableModels.map((m) => ({ value: m.modelId, name: m.name })) }];
const update = (value) => send({ method: "session/update", params: { sessionId, update: value } });
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync("acp-transcript.jsonl", JSON.stringify(message) + "\n");
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params.protocolVersion,
      agentCapabilities: dialect === "corrupt" ? { loadSession: true } : {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: dialect === "legacy" ? { sessionId, modes: modes(), models: models() } : { sessionId, configOptions: options(), modes: modes() } });
  } else if (method === "session/load" && dialect === "corrupt") {
    update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: lastPrompt } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我具备网页浏览能力。" } });
    send({ id, result: {} });
  } else if (method === "session/set_model" && dialect === "legacy") {
    model = params.modelId;
    update({ sessionUpdate: "current_model_update", modelId: model });
    send({ id, result: {} });
  } else if (method === "session/set_mode") {
    mode = params.modeId;
    update({ sessionUpdate: "current_mode_update", currentModeId: mode });
    send({ id, result: {} });
  } else if (method === "session/set_config_option" && dialect !== "legacy") {
    model = params.value;
    send({ id, result: { configOptions: options() } });
  } else if (method === "session/prompt") {
    turns++;
    const promptText = typeof params.prompt === "string" ? params.prompt
      : (params.prompt ?? []).map((block) => block?.type === "text" ? block.text : "").join("\n");
    lastPrompt = promptText;
    if (dialect === "corrupt") {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我���备网页浏览能力。" } });
      send({ id, result: { stopReason: "end_turn" } });
      continue;
    }
    if (promptText === "Image") {
      update({ sessionUpdate: "tool_call", toolCallId: "image", title: "Generate image", status: "completed", kind: "other",
        content: [{ type: "content", content: { type: "image", mimeType: "image/png",
          data: Buffer.from("generated image bytes").toString("base64") } }] });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
      send({ id, result: { stopReason: "end_turn" } });
      continue;
    }
    pending = message;
    update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking" } });
    update({ sessionUpdate: "tool_call", toolCallId: "read", title: "Read a file", status: "pending", kind: "read" });
    send({ id: "permission", method: "session/request_permission", params: { sessionId,
      toolCall: { toolCallId: "read", title: "Read a file", status: "pending" },
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "reject", name: "Reject", kind: "reject_once" }],
    } });
  } else if (id === "permission" && message.result && pending) {
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ turns, model, mode, permission: message.result.outcome, prompt: pending.params.prompt }) } });
    send({ id: pending.id, result: { stopReason: "end_turn" } });
    pending = undefined;
  } else if (method === "session/cancel" && pending) {
    send({ id: pending.id, result: { stopReason: "cancelled" } });
    pending = undefined;
  } else if (method && id !== undefined) {
    send({ id, error: { code: -32601, message: `Unsupported method ${method}` } });
  }
}
