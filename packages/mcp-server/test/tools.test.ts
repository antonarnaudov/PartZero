import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESIGNER_TOOLS, designRegistry, READ_ONLY_TOOLS, SPEC_WRITER_TOOLS } from "@aicad/agent-tools";
import type * as Gateway from "../../llm-gateway/src/cli/mcp.js";
import { BROKER_CLOSED_TEXT, encodeFrame, MAX_BRIDGE_FRAME_BYTES } from "../src/bridge-protocol.js";
import { callTimeoutFor, createMcpHost } from "../src/broker.js";
import { askUserFits, registryToolDefs, scopeToolNames, SUBMIT_TURN_TOOL, withReadOnly } from "../src/scopes.js";
import { toBrokerTool, toBrokerTools } from "../src/tools.js";
import { MCP_SCOPES, type BrokerLimits, type CliMcpSession, type McpAttachment, type McpScope, type McpToolCall, type McpToolResult } from "../src/types.js";
import { MCP_SERVER_VERSION } from "../src/version.js";
import { PKG_DIR } from "./helpers/util.js";

describe("scopes", () => {
  it("maps every scope to its frozen tool set", () => {
    expect(scopeToolNames("spec")).toEqual([...SPEC_WRITER_TOOLS].sort());
    expect(scopeToolNames("design")).toEqual([...DESIGNER_TOOLS].sort());
    expect(scopeToolNames("design", { askUser: false })).toEqual([...DESIGNER_TOOLS].filter((n) => n !== "ask_user").sort());
    expect(scopeToolNames("read")).toEqual([...READ_ONLY_TOOLS].sort());
    expect(scopeToolNames("submit")).toEqual(["submit_turn"]);
    expect(scopeToolNames("ext-read")).toEqual([...READ_ONLY_TOOLS].sort());
    expect(scopeToolNames("ext-edit")).toEqual(["apply_cadscript", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests"]);
    expect(scopeToolNames("ext-export")).toEqual(["export_design"]);
    expect(MCP_SCOPES).toEqual(["spec", "design", "read", "submit", "ext-read", "ext-edit", "ext-export"]);
  });

  it("keeps ask_user only when the CLI's call timeout outlasts the question wait", () => {
    expect(askUserFits(900_000)).toBe(true);
    expect(askUserFits(630_000)).toBe(false);
    expect(askUserFits(60_000)).toBe(false);
    expect(callTimeoutFor(["ask_user", "get_code"])).toBe(900_000);
    expect(callTimeoutFor(["get_code"])).toBe(150_000);
    expect(callTimeoutFor(["get_code"], { handlerTimeoutMs: 10_000 })).toBe(40_000);
    // Any call may wait for the user (the interactive budget checkpoint): the CLI must allow the wait too.
    expect(callTimeoutFor(["apply_cadscript", "get_code"], {}, { mayWaitForUser: true })).toBe(900_000);
  });
});

describe("tools from the registry", () => {
  it("sends the registry's schema bytes and annotations derived from readOnly", () => {
    const registry = designRegistry();
    for (const scope of ["spec", "design", "read"] as const) {
      const tools = toBrokerTools(registryToolDefs(registry, scopeToolNames(scope)));
      expect(tools.map((t) => t.name)).toEqual(scopeToolNames(scope));
      for (const t of tools) {
        expect(JSON.stringify(t.inputSchema)).toBe(JSON.stringify(registry.schema(t.name)));
        expect(t.description).toBe(registry.get(t.name)!.description);
        const ro = registry.get(t.name)!.readOnly === true;
        expect(t.annotations).toEqual({ readOnlyHint: ro, destructiveHint: false, idempotentHint: ro, openWorldHint: false });
      }
      // The welcome frame fits the bridge limit with room to spare.
      const frame = encodeFrame({ t: "welcome", v: 1, scope, server: { name: "cad", version: MCP_SERVER_VERSION }, instructions: "x".repeat(4000), tools });
      expect(Buffer.byteLength(frame)).toBeLessThan(MAX_BRIDGE_FRAME_BYTES / 8);
    }
  });

  it("withReadOnly fills readOnly for registry.defs() from READ_ONLY_TOOLS, which matches the registry's flags", () => {
    const registry = designRegistry();
    const raw = registry.defs();
    expect(raw.every((d) => !("readOnly" in d))).toBe(true); // why the fill is needed
    const filled = withReadOnly(raw);
    for (const d of filled) expect(d.readOnly, d.name).toBe(registry.get(d.name)!.readOnly === true);
    expect(filled.filter((d) => d.readOnly).map((d) => d.name).sort()).toEqual([...READ_ONLY_TOOLS].sort());
    expect(withReadOnly([{ ...raw.find((d) => d.name === "get_code")!, readOnly: false }])[0]!.readOnly).toBe(false); // an explicit value wins
  });

  it("every tool schema is strict: closed objects all the way down", () => {
    const registry = designRegistry();
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`));
      if (typeof node !== "object" || node === null) return;
      const o = node as Record<string, unknown>;
      if (o["type"] === "object") expect(o["additionalProperties"], path).toBe(false);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    for (const n of registry.names()) walk(registry.schema(n), n);
  });

  it("rejects names and schemas an MCP client would choke on", () => {
    const base = { description: "d", inputSchema: { type: "object", properties: {} } };
    expect(() => toBrokerTool({ ...base, name: "Bad-Name" })).toThrow(/snake_case/);
    expect(() => toBrokerTool({ ...base, name: "x".repeat(65) })).toThrow(/snake_case/);
    expect(() => toBrokerTool({ name: "ok", description: "d", inputSchema: { type: "string" } })).toThrow(/object schema/);
    expect(() => toBrokerTools([{ ...base, name: "a" }, { ...base, name: "a" }])).toThrow(/duplicate/);
  });

  it("announces the package version", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8")) as { version: string; license: string };
    expect(MCP_SERVER_VERSION).toBe(pkg.version);
    expect(pkg.license).toBe("MPL-2.0");
  });
});

describe("frozen contract with the gateway (CLI-PROVIDERS.md §7.6)", () => {
  const gatewayMcp = join(PKG_DIR, "..", "llm-gateway", "src", "cli", "mcp.ts");
  it.skipIf(!existsSync(gatewayMcp))("uses the gateway's limits, closed text and submit tool name", async () => {
    const { DEFAULT_BROKER_LIMITS, SUBMIT_BROKER_LIMITS } = await import("../src/broker.js");
    const gw = (await import(/* @vite-ignore */ gatewayMcp)) as typeof Gateway;
    expect(DEFAULT_BROKER_LIMITS).toEqual(gw.DEFAULT_BROKER_LIMITS);
    expect(SUBMIT_BROKER_LIMITS).toEqual(gw.SUBMIT_BROKER_LIMITS);
    for (const reason of ["proposed", "call_limit", "x (y)"]) expect(BROKER_CLOSED_TEXT(reason)).toBe(gw.BROKER_CLOSED_TEXT(reason));
    expect(SUBMIT_TURN_TOOL).toBe(gw.SUBMIT_TURN_TOOL);
  });

  it("createMcpHost() is assignable to the gateway's CliMcpHost (checked by tsc -p tsconfig.json)", () => {
    // Compile-time checks: a drift between the two declarations fails `pnpm typecheck`.
    const host: Gateway.CliMcpHost = createMcpHost({ shim: { command: "node", args: [], env: {} } });
    const checks: [
      Assert<Equal<McpScope, Gateway.McpScope>>,
      Assert<Equal<McpToolCall, Gateway.McpToolCall>>,
      Assert<Equal<McpToolResult, Gateway.McpToolResult>>,
      Assert<Equal<BrokerLimits, Gateway.BrokerLimits>>,
      Assert<Equal<McpAttachment, Gateway.McpAttachment>>,
      Assert<Equal<CliMcpSession, Gateway.CliMcpSession>>,
    ] = [true, true, true, true, true, true];
    expect(checks.every(Boolean)).toBe(true);
    expect(typeof host.open).toBe("function");
  });
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
