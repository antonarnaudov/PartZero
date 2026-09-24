#!/usr/bin/env node
// Minimal stdio MCP server for the live smoke (test only): one tool, `ping`, answering "pong".
// Newline-delimited JSON-RPC 2.0 on stdout; nothing else is ever written there. Exits on stdin EOF.
import { createInterface } from "node:readline";

const TOOLS = [{ name: "ping", description: "Returns the word pong.", inputSchema: { type: "object", properties: {}, additionalProperties: false } }];

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications
  switch (req.method) {
    case "initialize":
      send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cad", version: "0.0.0-test" } } });
      break;
    case "ping":
      send({ id: req.id, result: {} });
      break;
    case "tools/list":
      send({ id: req.id, result: { tools: TOOLS } });
      break;
    case "tools/call":
      if (req.params?.name === "ping") send({ id: req.id, result: { content: [{ type: "text", text: "pong" }], isError: false } });
      else send({ id: req.id, result: { content: [{ type: "text", text: `Unknown tool ${req.params?.name}` }], isError: true } });
      break;
    default:
      send({ id: req.id, error: { code: -32601, message: "Method not found" } });
  }
});
rl.on("close", () => process.exit(0));
