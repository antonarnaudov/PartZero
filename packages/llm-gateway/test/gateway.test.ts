import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BudgetExceededError, GatewayError } from "../src/errors.js";
import { LLMGateway } from "../src/gateway.js";
import { Conversation } from "../src/conversation.js";
import { ReplayTransport, RecordingTransport, type ProviderTransport, type TransportCall } from "../src/transport/transport.js";
import type { StreamEvent, ToolUseBlock } from "../src/types.js";
import { FIXED_NOW, PNG_1PX, firstTurn, loadFixture } from "./helpers.js";

const clock = () => FIXED_NOW;

function anthropicReplay(...names: string[]) {
  return new ReplayTransport(names.map((n) => loadFixture(n)));
}

describe("LLMGateway end-to-end over a replay transport", () => {
  it("runs a Claude tool-use round trip with an append-only conversation", async () => {
    const transport = anthropicReplay("anthropic/stream-tool-use.json", "anthropic/stream-final-text.json");
    const gateway = new LLMGateway({ transports: { anthropic: transport }, clock });
    const convo = new Conversation(firstTurn("claude-opus-5-5").messages);
    const base = firstTurn("claude-opus-5-5");

    const r1 = await gateway.chat({ ...base, messages: [...convo.messages] });
    expect(r1.stopReason).toBe("tool_use");
    convo.appendResponse(r1);
    expect(convo.pendingToolCalls()).toEqual([{ id: "toolu_01RenderA", name: "render_views", input: { views: ["iso", "top"] } }]);
    convo.appendUser([
      {
        type: "tool_result",
        toolUseId: "toolu_01RenderA",
        content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } }],
      },
    ]);

    const r2 = await gateway.chat({ ...base, messages: [...convo.messages] });
    expect(r2.stopReason).toBe("end_turn");
    expect(r2.message.content).toMatchObject([{ type: "text", text: "The bracket wall is 2.4 mm thick." }]);

    // Both calls streamed (Claude profiles always stream) and the second carried the first turn verbatim.
    expect(transport.calls).toHaveLength(2);
    const second = transport.calls[1]!.payload as Record<string, any>;
    expect(second["messages"][1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "EqQBCkYIBxgCKkBsigOpus55binding==" });
    // The request prefix of call 2 starts with call 1's messages, byte-identical (cache + thinking binding).
    const first = transport.calls[0]!.payload as Record<string, any>;
    expect(JSON.stringify(second["messages"][0])).toBe(JSON.stringify(first["messages"][0]));
    expect(JSON.stringify(second["tools"])).toBe(JSON.stringify(first["tools"]));
    expect(JSON.stringify(second["system"])).toBe(JSON.stringify(first["system"]));
    expect(gateway.totalCostUsd).toBeCloseTo(r1.costUsd + r2.costUsd, 12);
    expect(gateway.ledger).toHaveLength(2);
  });

  it("streams events through ChatStream and exposes the final response", async () => {
    const gateway = new LLMGateway({ transports: { anthropic: anthropicReplay("anthropic/stream-final-text.json") }, clock });
    const stream = gateway.stream(firstTurn("claude-opus-5-5"));
    const types: StreamEvent["type"][] = [];
    for await (const e of stream) types.push(e.type);
    expect(types).toEqual(["message_start", "text_delta", "usage", "message_end"]);
    expect((await stream.finalResponse()).stopReason).toBe("end_turn");
  });

  it("uses the non-streaming transport when the profile does not require streaming", async () => {
    const transport = new ReplayTransport([loadFixture("openai/response-tool-call.json")]);
    const gateway = new LLMGateway({ transports: { openai: transport }, clock });
    const r = await gateway.chat(firstTurn("gpt-6-astra"));
    expect(r.stopReason).toBe("tool_use");
    expect(transport.calls[0]!.operation).toBe("openai.responses.create");
  });

  it("exact-match replay catches request-mapping drift", async () => {
    const fx = loadFixture("google/response-parallel-calls.json");
    const gateway = new LLMGateway({ transports: { google: new ReplayTransport([fx], { match: "exact" }) }, clock });
    await expect(gateway.chat(firstTurn("gemini-3.8-flash"))).rejects.toMatchObject({ code: "replay_mismatch" });
  });

  it("records exchanges as fixtures with RecordingTransport", async () => {
    const inner = new ReplayTransport([loadFixture("google/response-parallel-calls.json")]);
    const recorder = new RecordingTransport(inner);
    const gateway = new LLMGateway({ transports: { google: recorder }, clock });
    await gateway.chat(firstTurn("gemini-3.8-flash"));
    expect(recorder.fixtures).toHaveLength(1);
    expect(recorder.fixtures[0]).toMatchObject({ provider: "google", operation: "google.models.generateContent", mode: "send" });
    expect((recorder.fixtures[0]!.request as Record<string, unknown>)["model"]).toBe("gemini-3.8-flash");
  });

  it("normalizes transport errors and releases the budget reservation", async () => {
    const failing: ProviderTransport = {
      send: async () => {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      },
      stream: async function* () {
        throw Object.assign(new Error("overloaded"), { status: 529 });
      },
    };
    const gateway = new LLMGateway({ transports: { openai: failing, anthropic: failing }, clock });
    const task = gateway.createTask({ id: "t-err", budgetUsd: 10 });
    await expect(task.chat(firstTurn("gpt-6-luna"))).rejects.toMatchObject({ code: "rate_limited", retryable: true, status: 429 });
    await expect(task.chat(firstTurn("claude-haiku-4-5"))).rejects.toMatchObject({ code: "overloaded", retryable: true });
    expect(task.budget.reservedUsd).toBe(0);
    expect(task.costUsd).toBe(0);
  });
});

describe("Budget guard", () => {
  it("refuses a call projected over the cap before issuing it", async () => {
    const transport = new ReplayTransport([loadFixture("anthropic/stream-tool-use.json")]);
    const gateway = new LLMGateway({ transports: { anthropic: transport }, clock });
    // Worst case: 64K output tokens at $50/MTok on Fable 5.1 alone is $3.20.
    const task = gateway.createTask({ id: "t-cap", budgetUsd: 1 });
    const err = await task.chat(firstTurn("claude-fable-5-1")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err).toMatchObject({ code: "budget_exceeded", taskId: "t-cap", capUsd: 1, spentUsd: 0 });
    expect((err as BudgetExceededError).projectedUsd).toBeGreaterThan(3.2);
    expect(transport.calls).toHaveLength(0);
  });

  it("charges actual cost, keeps a ledger and refuses once the remaining budget cannot cover the next projection", async () => {
    const transport = anthropicReplay("anthropic/stream-tool-use.json", "anthropic/stream-final-text.json");
    const gateway = new LLMGateway({ transports: { anthropic: transport }, clock });
    const req = firstTurn("claude-opus-5-5", { maxOutputTokens: 1000 });
    const projected = gateway.project(req).projectedUsd;
    const task = gateway.createTask({ id: "t-ledger", budgetUsd: projected * 1.2 });
    const r1 = await task.chat(req);
    expect(task.costUsd).toBeCloseTo(r1.costUsd, 12);
    expect(task.ledger).toMatchObject([{ taskId: "t-ledger", model: "claude-opus-5-5", responseId: "msg_01AbCdEf" }]);
    expect(r1.costUsd).toBeLessThan(projected);
    // Remaining < projection of the same call -> refused.
    await expect(task.chat(req)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(transport.calls).toHaveLength(1);
    expect(gateway.ledger[0]).toMatchObject({ taskId: "t-ledger" });
  });

  it("counts in-flight reservations so concurrent calls cannot jointly overshoot", () => {
    const gateway = new LLMGateway({ clock });
    const task = gateway.createTask({ id: "t-conc", budgetUsd: 1 });
    const hold = task.budget.reserve(0.7, "claude-opus-5-5");
    expect(() => task.budget.reserve(0.4, "claude-opus-5-5")).toThrow(BudgetExceededError);
    task.budget.release(hold);
    expect(() => task.budget.reserve(0.4, "claude-opus-5-5")).not.toThrow();
  });

  it("projection uses cache-write rates when writes may occur and the configured output assumption", () => {
    const gateway = new LLMGateway({ clock });
    const req = firstTurn("claude-opus-5-5", { maxOutputTokens: 2000 });
    const p = gateway.project(req);
    // All input at the $5 cache-write rate (>= $4 uncached) + 2000 output tokens at $20.
    expect(p.projectedUsd).toBeCloseTo((p.estimatedInputTokens * 5 + 2000 * 20) / 1e6, 12);
    expect(gateway.project(req, 100).projectedUsd).toBeCloseTo((p.estimatedInputTokens * 5 + 100 * 20) / 1e6, 12);
  });
});

describe("Router", () => {
  it("default routing (Opus 5.5 designer, Fable 5.1 judge) satisfies the cross-family rule", () => {
    const warn = vi.fn();
    const gateway = new LLMGateway({ clock, onRoutingWarning: warn });
    expect(warn).not.toHaveBeenCalled();
    expect(gateway.router.resolve("designer")).toEqual({ role: "designer", model: "claude-opus-5-5", effort: "medium" });
    const req = gateway.requestFor("spec_writer", { messages: [] });
    expect(req).toMatchObject({ model: "claude-opus-5-5", reasoning: { effort: "high" } });
    const explicit = gateway.requestFor("spec_writer", { messages: [], reasoning: { effort: "low" } });
    expect(explicit.reasoning?.effort).toBe("low");
  });

  const roles = (judge: string) => ({
    triage: { model: "claude-haiku-4-5" },
    designer: { model: "claude-opus-5-5" },
    spec_writer: { model: "claude-opus-5-5" },
    judge: { model: judge },
    advisor: { model: "claude-opus-5-5" },
    economy: { model: "claude-sonnet-5" },
  });

  it("warns when the judge shares the designer's family (e.g. ZDR fallback judge = Opus 5.5)", () => {
    const warn = vi.fn();
    const gateway = new LLMGateway({ clock, onRoutingWarning: warn, config: { routing: { roles: roles("claude-opus-5") } } });
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: "judge_same_family" }));
    expect(gateway.router.warnings).toHaveLength(1);
  });

  it("vendor rule and strict mode", () => {
    expect(() => new LLMGateway({ clock, config: { routing: { roles: roles("claude-fable-5-1"), judgeRule: "vendor", strict: true } } })).toThrow(
      /different vendor/,
    );
    const ok = new LLMGateway({ clock, config: { routing: { roles: roles("gpt-6-astra"), judgeRule: "vendor", strict: true } } });
    expect(ok.router.warnings).toEqual([]);
  });

  it("fails fast on unknown models in routing", () => {
    expect(() => new LLMGateway({ clock, config: { routing: { roles: roles("gpt-7") } } })).toThrow(/No model profile 'gpt-7'/);
  });
});

describe("Config overrides", () => {
  it("deep-merges profile overrides and defines new profiles via extends", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-gateway-"));
    const path = join(dir, "gateway.json");
    writeFileSync(
      path,
      JSON.stringify({
        profiles: {
          "claude-opus-5-5": { pricing: { cacheWritePerMTok: 5.5 } },
          "qwen-local": { extends: "gpt-oss-120b", apiModelId: "qwen3-coder", vendor: "alibaba", family: "qwen", compat: { baseURL: "http://127.0.0.1:11434/v1" } },
        },
        providers: { anthropic: { maxRetries: 4 } },
      }),
    );
    const gateway = await LLMGateway.fromConfigFile(path, { clock });
    expect(gateway.profile("claude-opus-5-5").pricing).toMatchObject({ inputPerMTok: 4, cacheWritePerMTok: 5.5 });
    expect(gateway.profile("qwen-local")).toMatchObject({ provider: "openai-compat", apiModelId: "qwen3-coder", contextWindow: 131_072 });
    expect(gateway.profile("qwen-local").compat).toMatchObject({ baseURL: "http://127.0.0.1:11434/v1", maxTokensParam: "max_tokens" });
  });

  it("rejects invalid overrides with a config error", () => {
    expect(() => new LLMGateway({ config: { profiles: { "claude-opus-5-5": { contextWindow: -1 } } } })).toThrow(GatewayError);
    expect(() => new LLMGateway({ config: { profiles: { brand_new: { provider: "openai" } } } })).toThrow(/Invalid model profile 'brand_new'/);
    expect(() => new LLMGateway({ config: { profiles: { x: { extends: "nope" } } } })).toThrow(/extends unknown profile/);
  });

  it("turns eager_input_streaming off behind a custom Anthropic base URL", async () => {
    const transport = anthropicReplay("anthropic/stream-final-text.json");
    const gateway = new LLMGateway({ transports: { anthropic: transport }, clock, config: { providers: { anthropic: { baseURL: "https://proxy.example" } } } });
    await gateway.chat(firstTurn("claude-opus-5-5"));
    const tools = (transport.calls[0]!.payload as Record<string, any>)["tools"];
    expect(tools[0].eager_input_streaming).toBeUndefined();
  });
});

describe("Conversation", () => {
  it("is append-only: earlier turns are frozen", async () => {
    const gateway = new LLMGateway({ transports: { anthropic: anthropicReplay("anthropic/stream-tool-use.json") }, clock });
    const convo = new Conversation(firstTurn("claude-opus-5-5").messages);
    convo.appendResponse(await gateway.chat(firstTurn("claude-opus-5-5")));
    const turn = convo.messages[1]!;
    expect(() => {
      (turn.content[1] as { text: string }).text = "edited";
    }).toThrow(TypeError);
    expect(() => (convo.messages as unknown[]).push({})).toThrow(TypeError);
  });

  it("does not offer truncated or refused tool calls for execution", async () => {
    const gateway = new LLMGateway({ transports: { anthropic: anthropicReplay("anthropic/stream-refusal.json") }, clock });
    const r = await gateway.chat(firstTurn("claude-opus-5-5"));
    const convo = new Conversation().appendUser("x").appendResponse(r);
    expect((r.message.content[0] as ToolUseBlock).inputError).toBeDefined();
    expect(convo.pendingToolCalls()).toEqual([]);
  });
});

describe("Transport call shape", () => {
  it("passes stream extras and the endpoint for OpenAI-compatible servers", async () => {
    const calls: TransportCall[] = [];
    const capture: ProviderTransport = {
      send: async () => {
        throw new Error("unused");
      },
      stream: async function* (call) {
        calls.push(call);
        yield* (loadFixture("compat/stream-tool-call.json").events ?? []) as unknown[];
      },
    };
    const gateway = new LLMGateway({ transports: { "openai-compat": capture }, clock });
    const r = await gateway.chat({ model: "gpt-oss-120b", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], stream: true });
    expect(r.stopReason).toBe("tool_use");
    expect(calls[0]).toMatchObject({ endpoint: "http://localhost:8000/v1", streamExtras: { stream_options: { include_usage: true } } });
  });
});
