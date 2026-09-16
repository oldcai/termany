import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const sessionId = `handoff-${process.pid}`;
let turns = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") {
    send({ id, result: { protocolVersion: params.protocolVersion, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    send({ id, result: { sessionId } });
  } else if (method === "session/prompt") {
    send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Warning: Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.\n\n" },
    } } });
    turns++;
    const context = JSON.parse(params.prompt.at(-1).text.split("\n").at(-1));
    let text;
    if (context.task === "group_dispatch") {
      if (params.prompt.length !== 1) throw new Error("Controller must not receive a Bot identity");
      const step = context.completedTurns.length;
      text = JSON.stringify({ memberId: ["a", "b", "a", null][step],
        triggerMessageIds: [["u"], ["a-1:1"], ["b-2"], []][step] });
    } else if (context.currentBot.id === "a" && turns === 1) {
      text = "First finding\n<!-- message_break -->\n@Writer Check the finding.";
    } else if (context.currentBot.id === "b") {
      const incoming = context.messages.filter((message) => context.turn.triggerMessageIds.includes(message.id));
      text = `@Researcher Checked: ${incoming.map((message) => message.content).join(" ")}`;
    } else {
      const incoming = context.messages.filter((message) => context.turn.triggerMessageIds.includes(message.id));
      text = `Final result after ${turns} turns: ${incoming.map((message) => message.speaker).join(", ")}`;
    }
    send({ method: "session/update", params: { sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text },
    } } });
    send({ id, result: { stopReason: "end_turn" } });
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: method } });
  }
}
