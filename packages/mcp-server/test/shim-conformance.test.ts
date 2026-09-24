/**
 * Conformance: the official MCP SDK client ↔ the real `aicad-mcp` shim process (dist/stdio.js) ↔ a
 * real broker whose handler runs the agent-tools registry on a DesignSession (CLI-PROVIDERS.md §13.1).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { designRegistry, DesignSession } from "@aicad/agent-tools";
import { closedText, HOST_UNAVAILABLE_TEXT } from "../src/bridge-protocol.js";
import { createMcpHost } from "../src/broker.js";
import { sessionToolHandler } from "../src/host/session-handler.js";
import { registryToolDefs, scopeToolNames } from "../src/scopes.js";
import type { BrokerLimits, CliMcpSession, McpScope } from "../src/types.js";
import { disc, StubEngine } from "./helpers/stub-engine.js";
import { SHIM, shortTmp } from "./helpers/util.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

beforeAll(() => {
  if (!existsSync(SHIM)) throw new Error(`build the package first (pnpm --filter @aicad/mcp-server build): ${SHIM} is missing`);
});

async function openSession(
  scope: McpScope,
  source = disc(5, 5),
  extra: { orchTag?: string; limits?: Partial<BrokerLimits> } = {},
): Promise<{ mcp: CliMcpSession; session: DesignSession; hellos: unknown[] }> {
  const tmp = shortTmp();
  cleanups.push(tmp.cleanup);
  const session = await DesignSession.open({ engine: new StubEngine(), source, name: "t" });
  const registry = designRegistry();
  const names = scopeToolNames(scope);
  const host = createMcpHost({ shim: { command: process.execPath, args: [SHIM], env: {} } });
  const mcp = await host.open({
    dir: join(tmp.dir, "s"),
    scope,
    tools: registryToolDefs(registry, names),
    instructions: "Use the cad tools only.",
    handler: sessionToolHandler({ session, registry: registry.subset(names) }),
    ...extra,
  });
  cleanups.push(() => mcp.dispose());
  return { mcp, session, hellos: [] };
}

async function sdkClient(env: Record<string, string>): Promise<{ client: Client; stderr: string[] }> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SHIM], env, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (c: Buffer) => stderr.push(c.toString("utf8")));
  const client = new Client({ name: "conformance-client", version: "1.0.0" });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return { client, stderr };
}

describe("SDK client ↔ shim ↔ broker", () => {
  it("initializes, lists the scope's tools with the registry's exact schemas, and runs calls on the session", async () => {
    const { mcp, session } = await openSession("design");
    const { client } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: mcp.ticket });
    expect(client.getServerVersion()).toEqual({ name: "cad", version: "0.0.1" });
    expect(client.getInstructions()).toBe("Use the cad tools only.");
    expect(client.getServerCapabilities()).toEqual({ tools: { listChanged: false } });

    const { tools } = await client.listTools();
    const registry = designRegistry();
    expect(tools.map((t) => t.name)).toEqual(scopeToolNames("design"));
    for (const t of tools) {
      // The SDK re-orders keys when it parses the list; the bytes on the wire are checked in tools.test.ts.
      expect(t.inputSchema).toEqual(registry.schema(t.name));
      expect(t.annotations).toEqual({ readOnlyHint: registry.get(t.name)!.readOnly === true, destructiveHint: false, idempotentHint: registry.get(t.name)!.readOnly === true, openWorldHint: false });
    }

    const code = await client.callTool({ name: "get_code", arguments: {} });
    expect(code.isError).toBe(false);
    expect((code.content as { text: string }[])[0]!.text).toContain("const e = extrude(s, { distance: 5 });");

    const applied = await client.callTool({ name: "apply_cadscript", arguments: { source: disc(5, 7) } });
    expect(applied.isError).toBe(false);
    expect(session.source).toBe(disc(5, 7));

    const bad = await client.callTool({ name: "apply_cadscript", arguments: { nonsense: 1 } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0]!.text).toMatch(/^Invalid input for apply_cadscript/);

    const odd = await client.callTool({ name: "../evil name", arguments: {} });
    expect(odd).toEqual({ content: [{ type: "text", text: 'Unknown tool "../evil name".' }], isError: true });

    expect(mcp.log().map((l) => [l.seq, l.name, l.isError])).toEqual([
      [1, "get_code", false],
      [2, "apply_cadscript", false],
      [3, "apply_cadscript", true],
    ]);
    expect(await client.ping()).toEqual({});
  });

  it("closes the broker after propose; later calls get the closed text", async () => {
    const { mcp } = await openSession("design");
    const { client } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: mcp.ticket });
    const p = await client.callTool({ name: "propose", arguments: { summary: "A disc.", assumptions: [], known_issues: [] } });
    expect(p.isError).toBe(false);
    expect(mcp.state).toBe("closing");
    const after = await client.callTool({ name: "get_code", arguments: {} });
    expect(after).toEqual({ content: [{ type: "text", text: closedText("proposed") }], isError: true });
  });

  it("after the close grace the shim still answers the closed text (with the run's tag), not the unavailable text", async () => {
    const tag = "[orchestrator 5eed]";
    const { mcp } = await openSession("design", disc(5, 5), { orchTag: tag, limits: { closeGraceMs: 50 } });
    const { client } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: mcp.ticket });
    const p = await client.callTool({ name: "propose", arguments: { summary: "A disc.", assumptions: [], known_issues: [] } });
    expect(p.isError).toBe(false);
    const during = await client.callTool({ name: "get_code", arguments: {} });
    expect(during).toEqual({ content: [{ type: "text", text: closedText("proposed", tag) }], isError: true });
    await new Promise((r) => setTimeout(r, 250)); // the broker ends the connection after closeGraceMs
    expect(mcp.state).toBe("closed");
    const after = await client.callTool({ name: "get_code", arguments: {} });
    expect(after).toEqual({ content: [{ type: "text", text: closedText("proposed", tag) }], isError: true });
  });

  it("scopes: read exposes only the read-only tools; a call outside the scope is refused by the broker", async () => {
    const { mcp, session } = await openSession("read");
    const { client } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: mcp.ticket });
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["get_code", "ir_summary", "measure", "run_tests"]);
    const r = await client.callTool({ name: "apply_cadscript", arguments: { source: "" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/^Unknown tool "apply_cadscript"/);
    expect(session.applies).toBe(0);
  });

  it("answers -32601 for resources and prompts in bridge mode", async () => {
    const { mcp } = await openSession("read");
    const { client } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: mcp.ticket });
    await expect(client.listResources()).rejects.toThrow(/-32601|Method not found/);
    await expect(client.listPrompts()).rejects.toThrow(/-32601|Method not found/);
  });

  it("with a wrong ticket: no tools, every call answers the unavailable text, and the shim does not hang", async () => {
    const { mcp } = await openSession("design");
    const { client, stderr } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: "0".repeat(64) });
    expect(client.getInstructions()).toBe(HOST_UNAVAILABLE_TEXT);
    expect((await client.listTools()).tools).toEqual([]);
    expect(await client.callTool({ name: "get_code", arguments: {} })).toEqual({ content: [{ type: "text", text: HOST_UNAVAILABLE_TEXT }], isError: true });
    expect(mcp.log()).toEqual([]);
    expect(stderr.join("")).toContain("bridge denied: bad_ticket");
    expect(stderr.join("")).not.toContain(mcp.ticket);
  });

  it("without bridge env: serves no tools and says the host is unavailable", async () => {
    const { client } = await sdkClient({});
    expect((await client.listTools()).tools).toEqual([]);
    expect((await client.callTool({ name: "get_code", arguments: {} })).isError).toBe(true);
  });

  it("answers the unavailable text once the host disposes the broker mid-session", async () => {
    const { mcp } = await openSession("read");
    const { client } = await sdkClient({ ...mcp.attachment.env, AICAD_MCP_TICKET: mcp.ticket });
    expect((await client.callTool({ name: "get_code", arguments: {} })).isError).toBe(false);
    await mcp.dispose();
    const r = await client.callTool({ name: "get_code", arguments: {} });
    expect(r).toEqual({ content: [{ type: "text", text: HOST_UNAVAILABLE_TEXT }], isError: true });
  });
});
