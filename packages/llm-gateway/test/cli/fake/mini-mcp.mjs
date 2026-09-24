// Minimal MCP stdio server for the real-CLI harnesses (opencode, Gemini). Newline-delimited JSON-RPC 2.0.
// It serves the tools named in MINI_MCP_TOOLS (comma list; default submit_turn), answers every call with
// "Recorded. End your turn now.", and appends {env, calls} records to MINI_MCP_LOG. Test-only; no network.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.MINI_MCP_LOG;
const tools = (process.env.MINI_MCP_TOOLS ?? "submit_turn").split(",").filter(Boolean);
const record = (o) => {
  if (log) appendFileSync(log, `${JSON.stringify(o)}\n`);
};
record({ kind: "start", ticket: process.env.AICAD_MCP_TICKET ?? null, bridge: process.env.AICAD_MCP_BRIDGE ?? null });

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return; // notifications
  switch (msg.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "cad", version: "0.0.0" } } });
      break;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: tools.map((name) => ({
            name,
            description: `Test tool ${name}.`,
            inputSchema: { type: "object", properties: { text: { type: "string" }, tool_calls: { type: "array", items: { type: "object" } } }, additionalProperties: true },
          })),
        },
      });
      break;
    case "tools/call":
      record({ kind: "call", name: msg.params?.name ?? null, args: msg.params?.arguments ?? null });
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "Recorded. End your turn now." }], isError: false } });
      break;
    case "ping":
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
      break;
    default:
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
});
rl.on("close", () => process.exit(0));
