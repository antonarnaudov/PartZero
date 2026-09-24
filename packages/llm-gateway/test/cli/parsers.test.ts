import { describe, expect, it } from "vitest";
import type { CliEvent, CliResultEvent } from "../../src/cli/events.js";
import { CLI_PROVIDERS } from "../../src/cli/registry.js";
import { tripwire } from "../../src/cli/lockdown.js";
import { linesOf, parseFixture } from "./helpers.js";

const claude = CLI_PROVIDERS.get("claude-cli")!;
const gemini = CLI_PROVIDERS.get("gemini-cli")!;
const codex = CLI_PROVIDERS.get("codex-cli")!;
const opencode = CLI_PROVIDERS.get("opencode")!;
const cursor = CLI_PROVIDERS.get("cursor-agent")!;

const result = (events: CliEvent[]): CliResultEvent => {
  const r = events.filter((e): e is CliResultEvent => e.type === "result").at(-1);
  if (r === undefined) throw new Error("no result event");
  return r;
};
const types = (events: CliEvent[]): string[] => events.map((e) => e.type);

describe("Claude Code parser (fixtures recorded live from claude 2.1.260, scrubbed)", () => {
  it("json-schema completion: init tools = [StructuredOutput], envelope from StructuredOutput and result.structured_output", async () => {
    const ev = await parseFixture(claude, "claude/completion-json-schema.jsonl");
    expect(types(ev)).toEqual(["init", "plan_usage", "structured", "turn", "structured", "result"]);
    const init = ev[0];
    expect(init).toMatchObject({ type: "init", tools: ["StructuredOutput"], mcpServers: [], model: "claude-haiku-4-5-20251001", version: "2.1.260" });
    const envelope = { text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] };
    expect(ev.filter((e) => e.type === "structured").map((e) => (e.type === "structured" ? e.value : null))).toEqual([envelope, envelope]);
    const r = result(ev);
    expect(r).toMatchObject({ ok: true, subtype: "success", turns: 2, failure: null, models: ["claude-haiku-4-5-20251001"] });
    expect(r.costUsd).toBeCloseTo(0.004068, 6);
    // modelUsage totals (includes Claude Code's side calls), thinking as reasoning tokens.
    expect(r.usage).toEqual({ inputTokens: 2543, outputTokens: 305, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 200 });
  });

  it("plan usage from rate_limit_event: status, 5-hour and 7-day windows as 0..1 with ISO reset times", async () => {
    const ev = await parseFixture(claude, "claude/completion-json-schema.jsonl");
    const p = ev.find((e) => e.type === "plan_usage");
    expect(p?.type === "plan_usage" ? p.usage : null).toMatchObject({
      provider: "claude-cli",
      status: "allowed",
      windows: [
        { id: "five_hour", utilization: 0.17, resetsAt: new Date(1790219400 * 1000).toISOString() },
        { id: "seven_day", utilization: 0.05, resetsAt: new Date(1790445600 * 1000).toISOString() },
      ],
      overage: { status: "rejected", inUse: false },
    });
  });

  it("plain completion: no tools, text block, thinking dropped", async () => {
    const ev = await parseFixture(claude, "claude/completion-plain.jsonl");
    expect(ev[0]).toMatchObject({ type: "init", tools: [], mcpServers: [] });
    expect(ev.filter((e) => e.type === "text")).toEqual([{ type: "text", messageId: "msg_fixture1", text: "pong", delta: false }]);
    expect(ev.some((e) => e.type === "reasoning")).toBe(false);
    expect(result(ev)).toMatchObject({ ok: true, text: "pong", turns: 1 });
  });

  it("runtime with an MCP server: mcp__cad__ping call and its result; tripwires pass for the scoped tool", async () => {
    const allowed = new Set(["mcp__cad__ping"]);
    const ev = await parseFixture(claude, "claude/runtime-mcp-ping.jsonl", { mode: "runtime", allowed });
    expect(ev[0]).toMatchObject({ type: "init", tools: ["mcp__cad__ping"], mcpServers: [{ name: "cad", status: "connected" }] });
    const call = ev.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", qualifiedName: "mcp__cad__ping", server: "cad", tool: "ping", input: {} });
    const res = ev.find((e) => e.type === "tool_result");
    expect(res).toMatchObject({ type: "tool_result", isError: false, text: "pong" });
    expect(res?.type === "tool_result" && call?.type === "tool_call" ? res.callId === call.callId : false).toBe(true);
    expect(ev.filter((e) => e.type === "turn").map((e) => (e.type === "turn" ? e.stopReason : null))).toEqual(["tool_use", "end_turn"]);
    const ctx = { allowed, structuredToolName: null, expectMcp: "cad" as const };
    expect(ev.map((e) => tripwire(e, ctx)).filter((v) => v !== null)).toEqual([]);
    expect(result(ev)).toMatchObject({ ok: true, text: "done", turns: 2 });
  });

  it("not logged in: result is_error with the login text maps to not_logged_in (no model call was made)", async () => {
    const ev = await parseFixture(claude, "claude/not-logged-in.jsonl");
    expect(result(ev)).toMatchObject({ ok: false, costUsd: 0, failure: { code: "not_logged_in" } });
  });

  it("maps result subtypes and API errors to failures", async () => {
    const line = (o: Record<string, unknown>): string => JSON.stringify({ type: "result", is_error: true, num_turns: 1, total_cost_usd: 0, session_id: "s", ...o });
    const run = async (o: Record<string, unknown>, pre: string[] = []): Promise<CliResultEvent> => {
      const ev: CliEvent[] = [];
      for await (const e of claude.parseEvents(linesOf([...pre, line(o)].join("\n")), { mode: "completion", allowed: new Set(), serverName: "cad" })) ev.push(e);
      return result(ev);
    };
    expect((await run({ subtype: "error_max_turns" })).failure?.code).toBe("max_turns");
    expect((await run({ subtype: "error_max_budget_usd" })).failure?.code).toBe("budget");
    expect((await run({ subtype: "error_max_structured_output_retries" })).failure?.code).toBe("bad_output");
    expect((await run({ subtype: "error_during_execution", api_error_status: 429 })).failure).toMatchObject({ code: "rate_limited" });
    expect((await run({ subtype: "success", result: "Prompt is too long" })).failure?.code).toBe("context_overflow");
    const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1790219400, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1790219400 } } } });
    expect((await run({ subtype: "success", result: "limit reached" }, [rejected])).failure).toMatchObject({ code: "quota_exhausted", resetsAt: new Date(1790219400 * 1000).toISOString() });
  });

  it("flags refusals and drops malformed lines with a warning", async () => {
    const text = [
      "not json",
      JSON.stringify({ type: "assistant", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "text", text: "I can't help with that." }], stop_reason: "refusal", usage: { input_tokens: 5, output_tokens: 3 } } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", stop_reason: "refusal", num_turns: 1, total_cost_usd: 0.001 }),
    ].join("\n");
    const ev: CliEvent[] = [];
    for await (const e of claude.parseEvents(linesOf(text), { mode: "completion", allowed: new Set(), serverName: "cad" })) ev.push(e);
    expect(types(ev)).toEqual(["warning", "text", "refusal", "turn", "refusal", "result"]);
  });
});

describe("Gemini CLI parser (documented stream-json shapes)", () => {
  it("mcp-submit completion: submit_turn call, stats usage, model list from stats.models", async () => {
    const ev = await parseFixture(gemini, "gemini/completion-mcp-submit.jsonl", { allowed: new Set(["mcp_cad_submit_turn"]) });
    expect(types(ev)).toEqual(["init", "text", "turn", "tool_call", "tool_result", "text", "turn", "result"]);
    expect(ev.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "mcp_cad_submit_turn", server: "cad", tool: "submit_turn" });
    expect(result(ev)).toMatchObject({
      ok: true,
      models: ["gemini-3.1-pro-preview"],
      usage: { inputTokens: 1500, cacheReadTokens: 500, outputTokens: 150 },
      costUsd: null,
      sessionId: "b1111111-2222-4333-8444-555555555555",
    });
  });

  it("TerminalQuotaError -> quota_exhausted", async () => {
    const ev = await parseFixture(gemini, "gemini/quota-terminal.jsonl");
    expect(result(ev)).toMatchObject({ ok: false, failure: { code: "quota_exhausted" } });
    expect(ev.some((e) => e.type === "warning" || e.type === "retry")).toBe(true);
  });

  it("a built-in tool call trips the lockdown", async () => {
    const ev = await parseFixture(gemini, "gemini/builtin-tool.jsonl");
    const call = ev.find((e) => e.type === "tool_call")!;
    expect(tripwire(call, { allowed: new Set(["mcp_cad_submit_turn"]), structuredToolName: null, expectMcp: "cad" })).toMatchObject({ kind: "builtin_activity" });
  });
});

describe("Codex CLI parser (exec_events.rs shapes)", () => {
  it("output-schema completion: agent_message JSON becomes a structured event; usage net of cache", async () => {
    const ev = await parseFixture(codex, "codex/completion-output-schema.jsonl");
    expect(types(ev)).toEqual(["init", "reasoning", "text", "structured", "turn", "result"]);
    expect(ev.find((e) => e.type === "structured")).toMatchObject({ value: { text: "", tool_calls: [{ name: "classify", arguments: { kind: "quick_edit" } }] } });
    expect(result(ev)).toMatchObject({ ok: true, usage: { inputTokens: 1376, cacheReadTokens: 1024, outputTokens: 120, reasoningTokens: 64 }, sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
  });

  it("runtime: mcp_tool_call items, cumulative usage diffed per turn", async () => {
    const ev = await parseFixture(codex, "codex/runtime-mcp.jsonl", { mode: "runtime", allowed: new Set(["cad__get_code"]) });
    expect(ev.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "cad__get_code", server: "cad", tool: "get_code" });
    expect(ev.find((e) => e.type === "tool_result")).toMatchObject({ isError: false, text: "export default part(...)" });
    const turns = ev.filter((e) => e.type === "turn");
    expect(turns.map((t) => (t.type === "turn" ? [t.stopReason, t.usage?.inputTokens, t.usage?.cacheReadTokens, t.usage?.outputTokens] : null))).toEqual([
      ["tool_use", 3000, 0, 40],
      ["end_turn", 0, 2900, 15],
    ]);
    expect(result(ev)).toMatchObject({ ok: true, turns: 2, text: "Done." });
  });

  it('"hit your usage limit" (curly apostrophe) -> quota_exhausted with the reset time; Reconnecting -> retry', async () => {
    const ev = await parseFixture(codex, "codex/usage-limit.jsonl");
    expect(ev.find((e) => e.type === "retry")).toMatchObject({ attempt: 1 });
    const r = result(ev);
    expect(r.failure?.code).toBe("quota_exhausted");
    expect(typeof r.failure?.resetsAt).toBe("string");
  });

  it("command_execution is built-in activity", async () => {
    const ev = await parseFixture(codex, "codex/builtin-command.jsonl");
    const call = ev.find((e) => e.type === "tool_call")!;
    expect(tripwire(call, { allowed: new Set(), structuredToolName: null, expectMcp: "none" })).toMatchObject({ kind: "builtin_activity" });
  });
});

describe("opencode parser (run --format json shapes)", () => {
  it("steps, submit_turn tool, summed usage and cost; the exit is the result", async () => {
    const ev = await parseFixture(opencode, "opencode/runtime-mcp-submit.jsonl", { allowed: new Set(["cad_submit_turn"]) });
    expect(types(ev)).toEqual(["init", "text", "tool_call", "tool_result", "turn", "text", "turn", "result"]);
    expect(ev.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "cad_submit_turn", server: "cad", tool: "submit_turn" });
    const r = result(ev);
    expect(r).toMatchObject({ ok: true, subtype: "exit", turns: 2, text: "Done.", sessionId: "ses_6a1b2c3d4e5fAbCdEf" });
    expect(r.usage).toMatchObject({ inputTokens: 3700, outputTokens: 85, reasoningTokens: 20, cacheReadTokens: 1700 });
    expect(r.costUsd).toBeCloseTo(0.0012, 8);
  });

  it("APIError 401 -> not_logged_in", async () => {
    expect(result(await parseFixture(opencode, "opencode/auth-401.jsonl"))).toMatchObject({ ok: false, failure: { code: "not_logged_in" } });
  });

  it("a denied built-in tool still trips the lockdown", async () => {
    const ev = await parseFixture(opencode, "opencode/builtin-bash.jsonl");
    const call = ev.find((e) => e.type === "tool_call")!;
    expect(tripwire(call, { allowed: new Set(["cad_submit_turn"]), structuredToolName: null, expectMcp: "cad" })).toMatchObject({ kind: "builtin_activity" });
  });
});

describe("Cursor Agent parser (docs shapes; the provider ships blocked)", () => {
  it("mcpToolCall and result usage", async () => {
    const ev = await parseFixture(cursor, "cursor/stream.jsonl", { allowed: new Set(["cad:get_code"]) });
    expect(ev.find((e) => e.type === "tool_call")).toMatchObject({ qualifiedName: "cad:get_code", server: "cad", tool: "get_code" });
    expect(ev.find((e) => e.type === "tool_result")).toMatchObject({ isError: false, text: "export default part(...)" });
    expect(result(ev)).toMatchObject({ ok: true, usage: { inputTokens: 900, outputTokens: 20 } });
  });

  it("a non-MCP tool_call key is built-in activity", async () => {
    const ev = await parseFixture(cursor, "cursor/builtin-shell.jsonl");
    const call = ev.find((e) => e.type === "tool_call")!;
    expect(tripwire(call, { allowed: new Set(["cad:get_code"]), structuredToolName: null, expectMcp: "cad" })).toMatchObject({ kind: "builtin_activity" });
  });
});
