import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_CLI_PROFILES, BUILTIN_PROFILES } from "../../src/builtin-profiles.js";
import { CliAdapter, type CliTurnOutcome } from "../../src/cli/adapter.js";
import type { CliMcpHost, McpToolCall, McpToolResult } from "../../src/cli/mcp.js";
import type { CliBinary } from "../../src/cli/provider.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { CliTransport, cliGatewayParts } from "../../src/cli/transport.js";
import { GatewayError } from "../../src/errors.js";
import { LLMGateway } from "../../src/gateway.js";
import { ReplayTransport, type Fixture } from "../../src/transport/transport.js";
import type { ChatRequest, StreamEvent, ToolDef } from "../../src/types.js";
import { binaryFor, fixturePath, makeFakeCli, parseFixture, removeDir, tempDir } from "./helpers.js";

const claude = CLI_PROVIDERS.get("claude-cli")!;
const gemini = CLI_PROVIDERS.get("gemini-cli")!;
const classify: ToolDef = {
  name: "classify",
  description: "Classify the request.",
  inputSchema: { type: "object", properties: { kind: { type: "string", enum: ["quick_edit", "new_part", "question"] } }, required: ["kind"], additionalProperties: false },
};
const request = (model: string, extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model,
  system: [{ type: "text", text: "You are the triage step." }],
  tools: [classify],
  messages: [{ role: "user", content: [{ type: "text", text: "make the plate 2 mm thicker" }] }],
  ...extra,
});
const profiles = [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES];
const hex = (n: number): string => "ab".repeat(n);

async function outcomeFrom(rel: string, over: Partial<CliTurnOutcome> = {}): Promise<CliTurnOutcome> {
  const events = await parseFixture(claude, rel);
  const structured = [...events].reverse().find((e) => e.type === "structured");
  return {
    provider: "claude-cli",
    version: "2.1.260",
    events,
    exit: { code: 0, signal: null, reason: "exited" },
    envelope: structured?.type === "structured" ? structured.value : null,
    envelopeSource: structured === undefined ? null : "structured",
    failure: null,
    durationMs: 4200,
    ...over,
  };
}

function replayGateway(outcome: CliTurnOutcome, mode: "send" | "stream" = "send"): { gw: LLMGateway; replay: ReplayTransport } {
  const fx: Fixture = { provider: "claude-cli", operation: "cli.turn", mode, request: {}, ...(mode === "send" ? { response: outcome } : { events: [outcome] }) };
  const replay = new ReplayTransport([fx]);
  const gw = new LLMGateway({ profiles, adapters: { "claude-cli": new CliAdapter(claude, { randomHex: hex }) }, transports: { "claude-cli": replay } });
  return { gw, replay };
}

describe("CliAdapter.buildRequest", () => {
  it("one stateless cli.turn payload: transcript prompt, system + appendix, json-schema envelope, default limits", () => {
    const { gw, replay } = replayGateway({} as CliTurnOutcome);
    void gw.chat(request("claude-cli:haiku", { reasoning: { effort: "high" }, providerOptions: { cli: { limits: { wallMs: 300_000 } } } })).catch(() => undefined);
    const call = replay.calls[0]!;
    expect(call.operation).toBe("cli.turn");
    const p = call.payload as Record<string, unknown>;
    expect(p).toMatchObject({ protocol: 1, provider: "claude-cli", model: "haiku", effort: null, toolNames: ["classify"], images: [], limits: { maxTurns: 3, wallMs: 300_000, stallMs: 120_000 } });
    expect(p["prompt"]).toContain("<transcript-abababab>");
    expect(p["systemPrompt"]).toMatch(/^You are the triage step\.\n\n# Reply protocol \(aicad-envelope-v1\)/);
    expect((p["structured"] as { via: string }).via).toBe("json-schema");
  });

  it("maps efforts through cli.effortArg (Opus) and falls back per channel", () => {
    const opus = new CliAdapter(claude, { randomHex: hex });
    const reg = new LLMGateway({ profiles }).registry;
    const ctx = (model: string, extra: Partial<ChatRequest> = {}, platform?: string) => {
      const a = platform === undefined ? opus : new CliAdapter(CLI_PROVIDERS.get(model.startsWith("gemini") ? "gemini-cli" : "claude-cli")!, { randomHex: hex, platform });
      const profile = reg.get(model);
      return a.buildRequest({ profile, request: request(model, extra), maxOutputTokens: 1000, now: new Date() });
    };
    expect((ctx("claude-cli:opus", { reasoning: { effort: "xhigh" } }).payload as { effort: string }).effort).toBe("xhigh");
    const win = ctx("claude-cli:opus", {}, "win32");
    expect((win.payload as { structured: { via: string } }).structured.via).toBe("text-json");
    expect(win.warnings.join()).toMatch(/too long for argv/);
    const g = ctx("gemini-cli:flash", {}, "darwin");
    expect((g.payload as { structured: { via: string } }).structured.via).toBe("text-json");
    expect(g.warnings.join()).toMatch(/no MCP host/);
    const none = ctx("claude-cli:haiku", { toolChoice: "none" });
    expect((none.payload as { structured: unknown }).structured).toBeNull();
    expect((none.payload as { systemPrompt: string }).systemPrompt).toContain("plain text only");
  });

  it("Codex falls back to text-json when a tool schema is not strict-compatible", () => {
    const codex = CLI_PROVIDERS.get("codex-cli")!;
    const loose: ToolDef = { name: "loose", description: "x", inputSchema: { type: "object", properties: {}, additionalProperties: true } };
    const profile = new LLMGateway({ profiles }).registry.get("codex-cli:gpt-6-sol");
    const built = new CliAdapter(codex, { randomHex: hex }).buildRequest({ profile, request: request("codex-cli:gpt-6-sol", { tools: [loose] }), maxOutputTokens: 1000, now: new Date() });
    expect((built.payload as { structured: { via: string } }).structured.via).toBe("text-json");
  });
});

describe("CliAdapter.parseResponse through LLMGateway (replayed CliTurnOutcome from the live Claude fixture)", () => {
  it("maps the envelope to tool_use blocks with billing, notional provider cost, plan usage and CLI info", async () => {
    const { gw } = replayGateway(await outcomeFrom("claude/completion-json-schema.jsonl"));
    const task = gw.createTask({ id: "t1", budgetUsd: 1 });
    const r = await task.chat(request("claude-cli:haiku"));
    expect(r.message.content).toEqual([{ type: "tool_use", id: "cli_abababab_0_0", name: "classify", input: { kind: "quick_edit" } }]);
    expect(r).toMatchObject({ provider: "claude-cli", model: "claude-cli:haiku", providerModel: "claude-haiku-4-5-20251001", stopReason: "tool_use", billing: "subscription", costSource: "provider" });
    expect(r.costUsd).toBeCloseTo(0.004068, 6);
    expect(r.planUsage?.windows.map((w) => w.id)).toEqual(["five_hour", "seven_day"]);
    expect(r.cli).toEqual({ provider: "claude-cli", version: "2.1.260", sessionId: "00000000-0000-4000-8000-000000000001", turns: 2, modelsUsed: ["claude-haiku-4-5-20251001"], envelopeVia: "json-schema", durationMs: 4200 });
    expect(r.usage.inputTokens).toBe(2543);
    expect(task.ledger[0]).toMatchObject({ billing: "subscription", source: "call", costUsd: r.costUsd });
    expect(gw.ledger[0]).toMatchObject({ billing: "subscription" });
  });

  it("plain completions return the final text", async () => {
    const { gw } = replayGateway(await outcomeFrom("claude/completion-plain.jsonl"));
    const r = await gw.chat(request("claude-cli:haiku", { tools: [] }));
    expect(r.message.content).toEqual([{ type: "text", text: "pong" }]);
    expect(r.stopReason).toBe("end_turn");
    expect(r.cli?.envelopeVia).toBeNull();
  });

  it("stream() synthesizes events from the single outcome", async () => {
    const { gw } = replayGateway(await outcomeFrom("claude/completion-json-schema.jsonl"), "stream");
    const events: StreamEvent[] = [];
    const s = gw.stream(request("claude-cli:haiku"));
    for await (const e of s) events.push(e);
    expect(events.map((e) => e.type)).toEqual(["message_start", "tool_use_start", "tool_use_end", "usage", "message_end"]);
    expect((await s.finalResponse()).billing).toBe("subscription");
  });

  it("CLI failures become GatewayErrors with the mapped code and details", async () => {
    const cases: Array<[CliTurnOutcome["failure"], string, boolean]> = [
      [{ code: "not_logged_in", message: "not logged in" }, "not_logged_in", false],
      [{ code: "quota_exhausted", message: "limit", resetsAt: "2026-09-24T12:00:00.000Z" }, "quota_exhausted", false],
      [{ code: "rate_limited", message: "429", retryAfterMs: 30_000 }, "rate_limited", true],
      [{ code: "lockdown_violation", message: "Bash" }, "lockdown_violation", false],
      [{ code: "stalled", message: "stall" }, "timeout", false],
      [{ code: "unsupported", message: "flag" }, "config", false],
      [{ code: "max_turns", message: "turns" }, "bad_output", false],
      [{ code: "crashed", message: "boom" }, "server_error", false],
    ];
    for (const [failure, code, retryable] of cases) {
      const { gw } = replayGateway(await outcomeFrom("claude/completion-plain.jsonl", { failure }));
      const err = await gw.chat(request("claude-cli:haiku")).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(GatewayError);
      expect((err as GatewayError).code, failure?.code).toBe(code);
      expect((err as GatewayError).retryable).toBe(retryable);
    }
    const { gw } = replayGateway(await outcomeFrom("claude/completion-plain.jsonl", { failure: { code: "quota_exhausted", message: "x", resetsAt: "2026-09-24T12:00:00.000Z" } }));
    const err = (await gw.chat(request("claude-cli:haiku")).catch((e: unknown) => e)) as GatewayError;
    expect(err.details["resetsAt"]).toBe("2026-09-24T12:00:00.000Z");
  });

  it("an invalid envelope is bad_output; a reply naming an unknown tool keeps inputError", async () => {
    const { gw } = replayGateway(await outcomeFrom("claude/completion-json-schema.jsonl", { envelope: { text: "", tool_calls: [{ name: "rm_rf", arguments: {} }] } }));
    const r = await gw.chat(request("claude-cli:haiku"));
    expect(r.message.content[0]).toMatchObject({ type: "tool_use", name: "rm_rf", inputError: "unknown tool rm_rf" });
    const bad = replayGateway(await outcomeFrom("claude/completion-json-schema.jsonl", { envelope: { tool_calls: [] } })).gw;
    expect((await bad.chat(request("claude-cli:haiku")).catch((e: unknown) => e)) as GatewayError).toMatchObject({ code: "bad_output" });
  });

  it("without an injected CLI adapter the gateway explains how to wire one", async () => {
    const gw = new LLMGateway({ profiles });
    await expect(gw.chat(request("claude-cli:haiku"))).rejects.toMatchObject({ code: "config", message: expect.stringMatching(/cliGatewayParts/) });
  });
});

describe("CliTransport end to end with fake CLI binaries (offline)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) removeDir(dir);
    dir = null;
  });

  const env = (): Record<string, string> => ({ PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: dir ?? "/tmp", OPENAI_API_KEY: "sk-test-never-forwarded-000000" });

  it("claude: LLMGateway -> CliAdapter -> CliTransport -> fake claude replaying the live fixture", async () => {
    dir = tempDir();
    const record = join(dir, "rec.json");
    const path = makeFakeCli(dir, "claude", { fixture: fixturePath("claude/completion-json-schema.jsonl"), record, help: fixturePath("help/claude-2.1.260.txt") });
    const binary = binaryFor("claude-cli", path, "2.1.260", ["claude-2.1.260.txt"]);
    const plans: unknown[] = [];
    const parts = cliGatewayParts({ providers: ["claude-cli"], binary: async () => binary, env, workspaceRoot: join(dir, "aicad-cli"), onPlanUsage: (u) => plans.push(u) });
    const gw = new LLMGateway({ profiles, adapters: parts.adapters, transports: parts.transports });
    const r = await gw.chat(request("claude-cli:haiku"));
    const call = r.message.content[0];
    expect(call?.type === "tool_use" ? [call.name, call.input] : null).toEqual(["classify", { kind: "quick_edit" }]);
    expect(r.billing).toBe("subscription");
    expect(plans).toHaveLength(1);
    const rec = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; env: Record<string, string>; stdin: string };
    expect(rec.env["OPENAI_API_KEY"]).toBeUndefined();
    expect(rec.stdin).toContain("make the plate 2 mm thicker");
    expect(rec.argv).toContain("--json-schema");
    expect(rec.argv.join(" ")).not.toContain("make the plate");
  });

  it("refuses a binary that changed since detection (the CLI auto-updated)", async () => {
    dir = tempDir();
    const path = makeFakeCli(dir, "claude", { fixture: fixturePath("claude/completion-plain.jsonl") });
    const binary: CliBinary = { ...binaryFor("claude-cli", path, "2.1.260", ["claude-2.1.260.txt"]), stat: { size: 1, mtimeMs: 1 } };
    const parts = cliGatewayParts({ providers: ["claude-cli"], binary: async () => binary, env, workspaceRoot: join(dir, "aicad-cli") });
    const gw = new LLMGateway({ profiles, adapters: parts.adapters, transports: parts.transports });
    await expect(gw.chat(request("claude-cli:haiku"))).rejects.toMatchObject({ code: "config", message: expect.stringMatching(/changed since detection/) });
  });

  it("gemini + mcp-submit: the broker records the envelope; workspace settings expose only mcp_cad_submit_turn", async () => {
    dir = tempDir();
    const record = join(dir, "rec.json");
    const path = makeFakeCli(dir, "gemini", { version: "0.49.0", fixture: fixturePath("gemini/completion-mcp-submit.jsonl"), record, delayMs: 30 });
    const binary = binaryFor("gemini-cli", path, "0.49.0", ["gemini-0.49.0.txt"]);
    const opened: Array<{ scope: string; tools: string[] }> = [];
    let disposed = 0;
    const results: McpToolResult[] = [];
    const host: CliMcpHost = {
      async open(req) {
        opened.push({ scope: req.scope, tools: req.tools.map((t) => t.name) });
        // Simulate the model's submit_turn call arriving through the shim: first invalid, then valid.
        setTimeout(() => {
          const call = (args: Record<string, unknown>, seq: number): Promise<McpToolResult> => req.handler({ seq, name: "submit_turn", args, toolUseId: null } satisfies McpToolCall);
          void call({ text: "" }, 1)
            .then((r) => results.push(r))
            .then(() => call({ text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] }, 2))
            .then((r) => results.push(r));
        }, 5);
        return {
          attachment: { serverName: "cad", command: process.execPath, args: ["/nonexistent/stdio.js"], env: { AICAD_MCP_BRIDGE: join(req.dir, "b.sock") }, ticketEnv: "AICAD_MCP_TICKET", toolNames: req.tools.map((t) => t.name), callTimeoutMs: 900_000 },
          ticket: "c".repeat(64),
          state: "open",
          close() {},
          async dispose() {
            disposed += 1;
          },
          log: () => [],
        };
      },
    };
    const parts = cliGatewayParts({ providers: ["gemini-cli"], binary: async () => binary, env, mcpHost: host, workspaceRoot: join(dir, "aicad-cli") });
    const gw = new LLMGateway({ profiles, adapters: parts.adapters, transports: parts.transports });
    const r = await gw.chat(request("gemini-cli:pro"));
    expect(opened).toEqual([{ scope: "submit", tools: ["submit_turn"] }]);
    expect(disposed).toBe(1);
    expect(results.map((x) => x.isError)).toEqual([true, false]);
    expect(results[0]?.text).toMatch(/Invalid turn envelope/);
    expect(results[1]).toMatchObject({ text: "Recorded. End your turn now.", close: "submitted" });
    expect(r.cli?.envelopeVia).toBe("mcp-submit");
    expect(r.message.content[0]).toMatchObject({ type: "tool_use", name: "classify", input: { kind: "quick_edit" } });
    expect(r.cli?.modelsUsed).toEqual(["gemini-3.1-pro-preview"]);
    expect(r.costUsd).toBe(0);
    const rec = JSON.parse(readFileSync(record, "utf8")) as { env: Record<string, string>; geminiSettings: string; argv: string[] };
    expect(rec.env["AICAD_MCP_TICKET"]).toBe("c".repeat(64));
    expect(rec.env["GEMINI_CLI_TRUST_WORKSPACE"]).toBe("true");
    expect(JSON.parse(rec.geminiSettings).tools.core).toEqual(["mcp_cad_submit_turn"]);
    expect(rec.argv.join(" ")).not.toContain("c".repeat(64));
    // The Gemini session the CLI reported is deleted afterwards, from a fresh `aicad-run` directory, without the ticket.
    const cleanup = JSON.parse(readFileSync(`${record}.cleanup`, "utf8")) as { argv: string[]; cwd: string; ticket: string | null };
    expect(cleanup.argv).toEqual(["--extensions=none", "--delete-session=b1111111-2222-4333-8444-555555555555"]);
    // Gemini keys sessions by the full project path (§15 G4): cleanup runs in the invocation's own workspace.
    expect(cleanup.cwd).toBe((JSON.parse(readFileSync(record, "utf8")) as { cwd: string }).cwd);
    expect(cleanup.cwd.endsWith("/aicad-run")).toBe(true);
    expect(cleanup.ticket).toBeNull();
  });

  it("text-json: one repair invocation after an invalid reply", async () => {
    dir = tempDir();
    const record = join(dir, "rec.json");
    const stateFile = join(dir, "state");
    writeFileSync(stateFile, "0");
    const path = makeFakeCli(dir, "gemini", { version: "0.49.0", fixtures: [fixturePath("gemini/text-json-invalid.jsonl"), fixturePath("gemini/text-json-valid.jsonl")], stateFile, record });
    const binary = binaryFor("gemini-cli", path, "0.49.0", ["gemini-0.49.0.txt"]);
    const transport = new CliTransport({ provider: gemini, binary: async () => binary, env, workspaceRoot: join(dir, "aicad-cli") });
    const gw = new LLMGateway({ profiles, adapters: { "gemini-cli": new CliAdapter(gemini) }, transports: { "gemini-cli": transport } });
    const r = await gw.chat(request("gemini-cli:flash"));
    expect(r.cli?.envelopeVia).toBe("text-json");
    expect(r.message.content[0]).toMatchObject({ type: "tool_use", name: "classify" });
    expect(r.warnings.join(" ")).toMatch(/repaired an invalid envelope/);
    expect(r.usage.inputTokens).toBe(2200);
    expect(readFileSync(stateFile, "utf8")).toBe("2");
    const rec = JSON.parse(readFileSync(record, "utf8")) as { stdin: string };
    expect(rec.stdin).toContain("<previous-reply>\nSure! I will classify it as a quick edit.\n</previous-reply>");
    expect(rec.stdin).toContain("Reply with only that JSON object.");
  });
});

describe("budget: external charges for CLI runtime phases", () => {
  it("Task.chargeExternal settles into the budget and both ledgers, never throws, clamps bad numbers", () => {
    const gw = new LLMGateway({ profiles });
    const task = gw.createTask({ id: "t", budgetUsd: 0.1 });
    task.chargeExternal({ model: "claude-cli:opus", responseId: "sess-1", costUsd: 0.25, billing: "subscription" });
    task.chargeExternal({ model: "claude-cli:opus", responseId: "sess-2", costUsd: Number.NaN, billing: "subscription" });
    expect(task.costUsd).toBeCloseTo(0.25, 10);
    expect(task.ledger.map((e) => [e.costUsd, e.source, e.billing])).toEqual([
      [0.25, "external", "subscription"],
      [0, "external", "subscription"],
    ]);
    expect(gw.ledger.map((e) => e.source)).toEqual(["external", "external"]);
    expect(() => task.budget.reserve(0.01, "x")).toThrow(/budget/);
  });
});

