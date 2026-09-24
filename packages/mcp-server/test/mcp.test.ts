import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { BrokerTool } from "../src/bridge-protocol.js";
import { MCP_LATEST_PROTOCOL_VERSION, McpConnection, serveStreams, type McpBackend, type McpToolRequest } from "../src/mcp.js";
import { tick, until } from "./helpers/util.js";

const TOOL: BrokerTool = {
  name: "get_code",
  description: "Read the code.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false, required: [] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

function fakeBackend(options: { resources?: boolean; delayMs?: number } = {}) {
  const calls: { req: McpToolRequest; id: unknown }[] = [];
  const cancelled: unknown[] = [];
  let closed = false;
  const backend: McpBackend = {
    async initialize() {
      return { version: "1.2.3", instructions: "use the tools", tools: [TOOL], ...(options.resources ? { resources: true } : {}) };
    },
    async callTool(req, id) {
      calls.push({ req, id });
      if (options.delayMs) await tick(options.delayMs);
      if (req.name === "boom") throw new Error("secret stack");
      return { text: `ran ${req.name}`, isError: req.name !== "get_code" };
    },
    cancel(id) {
      cancelled.push(id);
    },
    ...(options.resources
      ? {
          resources: {
            list: async () => [{ uri: "cad://doc/d/code", name: "code", mimeType: "text/typescript" }],
            templates: () => [{ uriTemplate: "cad://doc/{id}/{view}", name: "view" }],
            read: async (uri: string) => (uri === "cad://doc/d/code" ? [{ uri, mimeType: "text/typescript", text: "code" }] : null),
          },
        }
      : {}),
    close() {
      closed = true;
    },
  };
  return { backend, calls, cancelled, isClosed: () => closed };
}

const req = (id: number | string, method: string, params?: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

async function initialized(conn: McpConnection, version = "2025-06-18") {
  const r = await conn.receive(req(0, "initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.260" } }));
  await conn.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return r;
}

describe("McpConnection", () => {
  it("initializes: echoes a supported protocol version, else answers the newest", async () => {
    const a = new McpConnection(fakeBackend().backend);
    expect(await initialized(a, "2025-03-26")).toEqual({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "cad", version: "1.2.3" }, instructions: "use the tools" },
    });
    expect(a.client).toEqual({ name: "claude-code", version: "2.1.260" });
    const b = new McpConnection(fakeBackend().backend);
    const r = await initialized(b, "2099-01-01");
    expect(r && "result" in r ? r.result["protocolVersion"] : null).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });

  it("refuses work before initialize and a second initialize", async () => {
    const c = new McpConnection(fakeBackend().backend);
    expect(await c.receive(req(1, "tools/list"))).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(await c.receive(req(2, "ping"))).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    await initialized(c);
    expect(await c.receive(req(3, "initialize", {}))).toMatchObject({ id: 3, error: { code: -32600 } });
  });

  it("lists tools with annotations and forwards calls with the client's tool-use id", async () => {
    const f = fakeBackend();
    const c = new McpConnection(f.backend);
    await initialized(c);
    expect(await c.receive(req(1, "tools/list"))).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: TOOL.name, description: TOOL.description, inputSchema: TOOL.inputSchema, annotations: TOOL.annotations }] } });
    const r = await c.receive(req(2, "tools/call", { name: "get_code", arguments: { feature: "e" }, _meta: { "claudecode/toolUseId": "toolu_9", progressToken: 2 } }));
    expect(r).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ran get_code" }], isError: false } });
    expect(f.calls[0]).toEqual({ req: { name: "get_code", args: { feature: "e" }, toolUseId: "toolu_9" }, id: 2 });
    // Unknown names are forwarded: the backend decides (the broker records the violation).
    expect(await c.receive(req(3, "tools/call", { name: "Bash" }))).toMatchObject({ result: { isError: true } });
    expect(f.calls[1]!.req).toEqual({ name: "Bash", args: {}, toolUseId: null });
  });

  it("validates tools/call params and hides backend exceptions", async () => {
    const c = new McpConnection(fakeBackend().backend);
    await initialized(c);
    expect(await c.receive(req(1, "tools/call", { arguments: {} }))).toMatchObject({ error: { code: -32602 } });
    expect(await c.receive(req(2, "tools/call", { name: "get_code", arguments: "x" }))).toMatchObject({ error: { code: -32602 } });
    const r = await c.receive(req(3, "tools/call", { name: "boom" }));
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(r).toMatchObject({ result: { isError: true } });
  });

  it("does not answer a call the client cancelled", async () => {
    const f = fakeBackend({ delayMs: 30 });
    const c = new McpConnection(f.backend);
    await initialized(c);
    const pending = c.receive(req(5, "tools/call", { name: "get_code" }));
    await tick(5);
    expect(await c.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5, reason: "user" } }))).toBeUndefined();
    expect(await pending).toBeUndefined();
    expect(f.cancelled).toEqual([5]);
  });

  it("answers -32601 for unsupported methods and ignores unknown notifications", async () => {
    const c = new McpConnection(fakeBackend().backend);
    await initialized(c);
    for (const m of ["resources/list", "resources/read", "prompts/list", "logging/setLevel", "sampling/createMessage", "completion/complete"]) {
      expect(await c.receive(req(1, m, {}))).toMatchObject({ error: { code: -32601 } });
    }
    expect(await c.receive(JSON.stringify({ jsonrpc: "2.0", method: "notifications/roots/list_changed" }))).toBeUndefined();
    expect(await c.receive(JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} }))).toBeUndefined();
  });

  it("serves resources only when the backend has them", async () => {
    const c = new McpConnection(fakeBackend({ resources: true }).backend);
    const init = await initialized(c);
    expect(init && "result" in init ? init.result["capabilities"] : null).toEqual({ tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } });
    expect(await c.receive(req(1, "resources/list"))).toMatchObject({ result: { resources: [{ uri: "cad://doc/d/code" }] } });
    expect(await c.receive(req(2, "resources/templates/list"))).toMatchObject({ result: { resourceTemplates: [{ uriTemplate: "cad://doc/{id}/{view}" }] } });
    expect(await c.receive(req(3, "resources/read", { uri: "cad://doc/d/code" }))).toMatchObject({ result: { contents: [{ text: "code" }] } });
    expect(await c.receive(req(4, "resources/read", { uri: "cad://doc/d/nope" }))).toMatchObject({ error: { code: -32002 } });
  });
});

describe("serveStreams", () => {
  it("speaks NDJSON, rejects oversized frames with id null, and closes the backend on EOF", async () => {
    const f = fakeBackend();
    const input = new PassThrough();
    const output = new PassThrough();
    const out: unknown[] = [];
    output.on("data", (c: Buffer) => {
      for (const l of c.toString("utf8").split("\n").filter(Boolean)) out.push(JSON.parse(l));
    });
    const { done } = serveStreams({ backend: f.backend, input, output });
    input.write(req(1, "initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "x", version: "1" } }) + "\n");
    input.write("x".repeat(1024 * 1024 + 10) + "\n");
    input.write(req(2, "tools/call", { name: "get_code" }) + "\n");
    await until(() => out.length >= 3, 3_000, "three responses");
    expect(out).toContainEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Frame larger than 1048576 bytes" } });
    expect(out).toContainEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "ran get_code" }], isError: false } });
    input.end();
    await done;
    expect(f.isClosed()).toBe(true);
  });
});
