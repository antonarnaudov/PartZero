/**
 * Offline replays of CLI fixtures:
 *
 * - `fixtures/clients/*.jsonl`: the MCP frames each CLI sends to our server. Claude Code's are
 *   recorded from a live run; the others are synthetic, built from documented shapes (each file's
 *   `_fixture` line says which). Every frame goes through `McpConnection` as the shim would see it.
 * - `fixtures/cli/claude/runtime-read-2.1.260.*`: a recorded `claude -p` runtime-mode stream through
 *   aicad-mcp plus the broker's log of the same run.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { designRegistry } from "@aicad/agent-tools";
import { branchSlug } from "../src/host/design-host.js";
import { MCP_LATEST_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS, McpConnection, type McpBackend, type McpToolRequest } from "../src/mcp.js";
import { registryToolDefs, scopeToolNames } from "../src/scopes.js";
import { toBrokerTools } from "../src/tools.js";
import { PKG_DIR } from "./helpers/util.js";

const DIR = join(PKG_DIR, "test", "fixtures");

interface Fixture {
  file: string;
  meta: { client: string; evidence: string };
  frames: Record<string, unknown>[];
}

function loadClientFixtures(): Fixture[] {
  const dir = join(DIR, "clients");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((file) => {
      const lines = readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l.trim() !== "");
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const meta = parsed[0]!["_fixture"] as Fixture["meta"];
      return { file, meta, frames: parsed.slice(1) };
    });
}

const ANSWERED = new Set(["initialize", "ping", "tools/list", "tools/call"]);

describe("MCP client fixtures", () => {
  const fixtures = loadClientFixtures();

  it("has the recorded Claude Code frames and a synthetic set for every other CLI", () => {
    expect(fixtures.map((f) => f.meta.client).sort()).toEqual(["claude-code", "codex", "cursor-agent", "future-client", "gemini-cli", "opencode"]);
    for (const f of fixtures) expect(f.meta.evidence.length).toBeGreaterThan(20);
    expect(fixtures.find((f) => f.meta.client === "claude-code")!.meta.evidence).toMatch(/^recorded/);
    for (const f of fixtures.filter((x) => x.meta.client !== "claude-code")) expect(f.file).toMatch(/\.synthetic\.jsonl$/);
  });

  for (const f of loadClientFixtures()) {
    it(`${f.meta.client}: every request gets the right answer`, async () => {
      const calls: McpToolRequest[] = [];
      const tools = toBrokerTools(registryToolDefs(designRegistry(), scopeToolNames("design")));
      const backend: McpBackend = {
        initialize: async () => ({ version: "0.0.1", instructions: "cad", tools: [...tools, { ...tools[0]!, name: "submit_turn" }] }),
        callTool: async (req) => {
          calls.push(req);
          return { text: `ok ${req.name}`, isError: false };
        },
      };
      const conn = new McpConnection(backend);
      for (const frame of f.frames) {
        const res = await conn.receive(JSON.stringify(frame));
        const method = frame["method"] as string;
        if (!("id" in frame)) {
          expect(res, `${method} is a notification`).toBeUndefined();
          continue;
        }
        expect(res, method).toBeDefined();
        expect(res!.id).toEqual(frame["id"]);
        if (!ANSWERED.has(method)) {
          expect(res, method).toMatchObject({ error: { code: -32601 } });
          continue;
        }
        expect("result" in res!, `${method}: ${JSON.stringify(res)}`).toBe(true);
        const result = (res as { result: Record<string, unknown> }).result;
        if (method === "initialize") {
          const asked = (frame["params"] as { protocolVersion: string }).protocolVersion;
          expect(result["protocolVersion"]).toBe((MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_LATEST_PROTOCOL_VERSION);
          expect(result["serverInfo"]).toEqual({ name: "cad", version: "0.0.1" });
        }
        if (method === "tools/call") expect(result).toEqual({ content: [{ type: "text", text: `ok ${(frame["params"] as { name: string }).name}` }], isError: false });
      }
      const sent = f.frames.filter((x) => x["method"] === "tools/call").map((x) => x["params"] as { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> });
      expect(calls).toEqual(sent.map((p) => ({ name: p.name, args: p.arguments ?? {}, toolUseId: (p._meta?.["claudecode/toolUseId"] as string | undefined) ?? null })));
      // Bare tool names on the wire: no CLI-side prefix (mcp__cad__, mcp_cad_, cad_) reaches the server.
      for (const c of calls) expect(c.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(conn.client?.name.length).toBeGreaterThan(0);
      expect(branchSlug(conn.client?.name)).toMatch(/^[a-z0-9-]+$/);
    });
  }

  it("Claude Code 2.1.260 negotiates 2025-11-25 and sends its tool-use id in _meta", async () => {
    const f = loadClientFixtures().find((x) => x.meta.client === "claude-code")!;
    const init = f.frames[0]!["params"] as { protocolVersion: string; clientInfo: { name: string } };
    expect(init.protocolVersion).toBe("2025-11-25");
    expect(init.clientInfo.name).toBe("claude-code");
    expect(branchSlug(init.clientInfo.name)).toBe("claude-code");
    const call = f.frames.find((x) => x["method"] === "tools/call")!["params"] as { _meta: Record<string, unknown> };
    expect(call._meta).toEqual({ "claudecode/toolUseId": "toolu_0001", progressToken: 2 });
  });
});

describe("recorded claude -p runtime stream (read scope)", () => {
  const events = readFileSync(join(DIR, "cli", "claude", "runtime-read-2.1.260.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const broker = JSON.parse(readFileSync(join(DIR, "cli", "claude", "runtime-read-2.1.260.broker.json"), "utf8")) as {
    scope: string;
    tools: string[];
    calls: { seq: number; name: string; isError: boolean; text: string }[];
  };
  const qualified = new Set(broker.tools.map((t) => `mcp__cad__${t}`));

  it("every init lists exactly our scope's tools and only the cad server (tripwire precondition)", () => {
    const inits = events.filter((e) => e["type"] === "system" && e["subtype"] === "init");
    expect(inits.length).toBe(2); // one per user message in stream-json input mode
    for (const i of inits) {
      expect(new Set(i["tools"] as string[])).toEqual(qualified);
      expect(i["mcp_servers"]).toEqual([{ name: "cad", status: "connected" }]);
      expect(i["apiKeySource"]).toBe("none");
      expect(i["plugins"]).toEqual([]);
      expect(i["skills"]).toEqual([]);
      expect(i["slash_commands"]).toEqual([]);
      expect(i["permissionMode"]).toBe("dontAsk");
      expect(String(i["model"])).toMatch(/^[\w.:/@-]{1,128}$/);
    }
  });

  it("every tool call is one of ours, and every tool result is the broker's text, in order", () => {
    const uses = events
      .filter((e) => e["type"] === "assistant")
      .flatMap((e) => (e["message"] as { content: { type: string; id?: string; name?: string }[] }).content.filter((b) => b.type === "tool_use"));
    const results = events
      .filter((e) => e["type"] === "user")
      .flatMap((e) => (e["message"] as { content: { type: string; tool_use_id?: string; content?: { text: string }[] }[] }).content.filter((b) => b.type === "tool_result"));
    expect(uses.map((u) => u.name)).toEqual(broker.calls.map((c) => `mcp__cad__${c.name}`));
    for (const u of uses) expect(qualified.has(u.name!)).toBe(true);
    expect(results.map((r) => r.tool_use_id)).toEqual(uses.map((u) => u.id));
    expect(results.map((r) => r.content![0]!.text)).toEqual(broker.calls.map((c) => c.text));
  });

  it("two turns over one process: two results, cumulative cost, no permission denials", () => {
    const results = events.filter((e) => e["type"] === "result");
    expect(results.map((r) => [r["subtype"], r["is_error"], r["num_turns"], r["permission_denials"]])).toEqual([
      ["success", false, 2, []],
      ["success", false, 2, []],
    ]);
    const costs = results.map((r) => r["total_cost_usd"] as number);
    expect(costs[1]!).toBeGreaterThan(costs[0]!); // total_cost_usd is cumulative per process
    const plan = events.find((e) => e["type"] === "rate_limit_event")!["rate_limit_info"] as Record<string, unknown>;
    expect(plan["status"]).toBe("allowed");
  });
});
