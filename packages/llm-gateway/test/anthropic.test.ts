import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "../src/adapters/anthropic.js";
import { GatewayError } from "../src/errors.js";
import type { AssistantMessage, ChatRequest, ToolUseBlock } from "../src/types.js";
import { PNG_1PX, collect, ctxFor, firstTurn, iterate, loadFixture } from "./helpers.js";

const adapter = new AnthropicAdapter();

async function streamFixture(name: string, request: ChatRequest) {
  const ctx = ctxFor(request);
  const built = adapter.buildRequest(ctx);
  return collect(adapter.parseStream(iterate(loadFixture(name).events ?? []), ctx, built));
}

describe("AnthropicAdapter request mapping", () => {
  it("maps a first turn for claude-opus-5-5 to the exact Messages API payload", () => {
    const built = adapter.buildRequest(ctxFor(firstTurn("claude-opus-5-5", { reasoning: { effort: "high" } })));
    expect(built.operation).toBe("anthropic.messages.create");
    expect(built.preferStream).toBe(true);
    expect(built.warnings).toEqual([]);
    expect(built.payload).toMatchSnapshot();
  });

  it("never forces tool use: tool_choice is auto (Opus 5.5 rejects any/tool) and tools are strict", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("claude-opus-5-5"))).payload as Record<string, any>;
    expect(p["tool_choice"]).toEqual({ type: "auto" });
    const render = p["tools"][0];
    expect(render.strict).toBe(true);
    expect(render.eager_input_streaming).toBe(true);
    expect(render.input_schema.additionalProperties).toBe(false);
    // Unsupported strict constraints move into the description instead of being sent.
    expect(render.input_schema.properties.scale).toEqual({ type: "number", description: "(minimum: 0.1, maximum: 10)" });
    // Non-strict tool passes through untouched.
    expect(p["tools"][1].strict).toBeUndefined();
  });

  it("uses adaptive thinking + output_config.effort, with the profile default effort when none is given", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("claude-opus-5-5"))).payload as Record<string, any>;
    expect(p["thinking"]).toEqual({ type: "adaptive" });
    expect(p["output_config"]).toEqual({ effort: "medium" });
    const summarized = adapter.buildRequest(ctxFor(firstTurn("claude-fable-5-1", { reasoning: { summary: true } }))).payload as Record<string, any>;
    expect(summarized["thinking"]).toEqual({ type: "adaptive", display: "summarized" });
    expect(summarized["output_config"]).toEqual({ effort: "high" });
  });

  it("maps Haiku 4.5 effort to budget_tokens thinking (no effort parameter)", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("claude-haiku-4-5", { reasoning: { effort: "high" }, maxOutputTokens: 8000 })))
      .payload as Record<string, any>;
    expect(p["thinking"]).toEqual({ type: "enabled", budget_tokens: 4000 });
    expect(p["output_config"]).toBeUndefined();
    const none = adapter.buildRequest(ctxFor(firstTurn("claude-haiku-4-5"))).payload as Record<string, any>;
    expect(none["thinking"]).toBeUndefined();
    const tiny = adapter.buildRequest(ctxFor(firstTurn("claude-haiku-4-5", { reasoning: { effort: "low" }, maxOutputTokens: 800 })));
    expect((tiny.payload as Record<string, any>)["thinking"]).toBeUndefined();
    expect(tiny.warnings[0]).toMatch(/budget_tokens must be >= 1024 and at most half of max_tokens/);
  });

  it("places cache breakpoints on the static prefix plus automatic tail caching, TTL applied everywhere", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("claude-opus-5-5", { cache: { ttl: "1h", tools: true } }))).payload as Record<string, any>;
    expect(p["cache_control"]).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p["tools"][1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(p["tools"][0].cache_control).toBeUndefined();
    expect(p["system"][0].cache_control).toBeUndefined();
    expect(p["system"][1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  it("rejects more than 4 cache breakpoints", () => {
    const req = firstTurn("claude-opus-5-5", { cache: { tools: true } });
    req.system = req.system!.map((s) => ({ ...s, cacheBreakpoint: true }));
    req.messages = [{ role: "user", content: [{ type: "text", text: "hi", cacheBreakpoint: true }] }];
    expect(() => adapter.buildRequest(ctxFor(req))).toThrow(GatewayError);
  });

  it("disables parallel tool use via tool_choice when asked, and maps toolChoice none", () => {
    const serial = adapter.buildRequest(ctxFor(firstTurn("claude-opus-5-5", { parallelToolCalls: false }))).payload as Record<string, any>;
    expect(serial["tool_choice"]).toEqual({ type: "auto", disable_parallel_tool_use: true });
    const none = adapter.buildRequest(ctxFor(firstTurn("claude-opus-5-5", { toolChoice: "none" }))).payload as Record<string, any>;
    expect(none["tool_choice"]).toEqual({ type: "none" });
  });

  it("rejects image formats the model does not accept", () => {
    const req = firstTurn("claude-opus-5-5");
    req.messages = [{ role: "user", content: [{ type: "image", source: { type: "base64", mediaType: "image/bmp" as "image/png", data: PNG_1PX } }] }];
    expect(() => adapter.buildRequest(ctxFor(req))).toThrow(/does not accept image\/bmp/);
  });
});

describe("AnthropicAdapter streaming and replay", () => {
  it("accumulates a streamed tool_use turn into normalized events and a verbatim-replayable message", async () => {
    const { events, response } = await streamFixture("anthropic/stream-tool-use.json", firstTurn("claude-opus-5-5"));
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "reasoning_start",
      "reasoning_end",
      "text_delta",
      "text_delta",
      "tool_use_start",
      "tool_use_input_delta",
      "tool_use_input_delta",
      "tool_use_end",
      "usage",
      "message_end",
    ]);
    expect(response.stopReason).toBe("tool_use");
    expect(response.message.content.map((b) => b.type)).toEqual(["reasoning", "text", "tool_use"]);
    const call = response.message.content[2] as ToolUseBlock;
    expect(call).toMatchObject({ id: "toolu_01RenderA", name: "render_views", input: { views: ["iso", "top"] } });
    expect(call.inputError).toBeUndefined();
    // Thinking block (empty text under display 'omitted') kept with its signature, exactly as the SDK accumulates it.
    expect(response.message.content[0]).toMatchObject({
      kind: "thinking",
      native: { provider: "anthropic", data: { type: "thinking", thinking: "", signature: "EqQBCkYIBxgCKkBsigOpus55binding==" } },
    });
    expect(response.message.content[0]).not.toHaveProperty("text");
    expect(response.usage).toEqual({
      inputTokens: 2100,
      outputTokens: 180,
      cacheReadTokens: 6000,
      cacheWriteTokens: 900,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0,
    });
    // $4 in, $20 out, $0.20 cache read, $5 cache write (per MTok).
    expect(response.costUsd).toBeCloseTo((2100 * 4 + 180 * 20 + 6000 * 0.2 + 900 * 5) / 1e6, 12);
  });

  it("replays the assistant turn byte-for-byte on the next request (append-only history)", async () => {
    const first = firstTurn("claude-opus-5-5");
    const { response } = await streamFixture("anthropic/stream-tool-use.json", first);
    const second: ChatRequest = {
      ...first,
      messages: [
        ...first.messages,
        response.message,
        {
          role: "user",
          content: [
            { type: "text", text: "(render attached)" },
            {
              type: "tool_result",
              toolUseId: "toolu_01RenderA",
              content: [
                { type: "text", text: "2 views rendered" },
                { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } },
              ],
            },
          ],
        },
      ],
    };
    const p = adapter.buildRequest(ctxFor(second)).payload as Record<string, any>;
    const rawEvents = loadFixture("anthropic/stream-tool-use.json").events as Array<Record<string, any>>;
    expect(p["messages"][1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "EqQBCkYIBxgCKkBsigOpus55binding==" },
        { type: "text", text: "I'll render the bracket first.", citations: null },
        { ...rawEvents[8]!["content_block"], input: { views: ["iso", "top"] } },
      ],
    });
    // tool_result leads the user turn and carries the image natively.
    expect(p["messages"][2]).toMatchSnapshot();
  });

  it("drops reasoning produced by another provider (cannot be replayed) with a warning", () => {
    const foreign: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "reasoning", kind: "reasoning", native: { provider: "openai", model: "gpt-6-astra", data: { type: "reasoning", id: "rs_1" } } },
        { type: "tool_use", id: "call_1", name: "measure", input: { entity: "face:1" } },
      ],
    };
    const req = firstTurn("claude-opus-5-5");
    req.messages = [...req.messages, foreign, { role: "user", content: [{ type: "tool_result", toolUseId: "call_1", content: "3 mm" }] }];
    const built = adapter.buildRequest(ctxFor(req));
    expect((built.payload as Record<string, any>)["messages"][1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "call_1", name: "measure", input: { entity: "face:1" } }],
    });
    expect(built.warnings[0]).toMatch(/dropped reasoning blocks produced by another provider \(1 from openai\)/);
  });

  it("surfaces refusals with category and never lets a cut-off tool call execute", async () => {
    const { response } = await streamFixture("anthropic/stream-refusal.json", firstTurn("claude-opus-5-5"));
    expect(response.stopReason).toBe("refusal");
    expect(response.refusal).toEqual({ category: "cyber", explanation: "Request resembles exploit development." });
    const call = response.message.content[0] as ToolUseBlock;
    expect(call.inputError).toMatch(/not valid JSON/);
    expect(call.rawInput).toBe('{"code": "box(');
  });

  it("maps pause_turn and 1h cache writes from a non-streaming Message", () => {
    const req = firstTurn("claude-sonnet-5");
    const ctx = ctxFor(req);
    const response = adapter.parseResponse(loadFixture("anthropic/message-pause.json").response, ctx, adapter.buildRequest(ctx));
    expect(response.stopReason).toBe("pause");
    expect(response.message.content.map((b) => (b.type === "reasoning" ? b.kind : b.type))).toEqual(["text", "server_tool_use"]);
    expect(response.usage.cacheWrite1hTokens).toBe(2000);
    // Sonnet 5: $2 in, $10 out, 1h write $4/MTok.
    expect(response.costUsd).toBeCloseTo((1000 * 2 + 50 * 10 + 2000 * 4) / 1e6, 12);
  });

  it("fails loudly when the stream ends before message_stop", async () => {
    const events = (loadFixture("anthropic/stream-final-text.json").events ?? []).slice(0, -1);
    const req = firstTurn("claude-opus-5-5");
    const ctx = ctxFor(req);
    await expect(collect(adapter.parseStream(iterate(events), ctx, adapter.buildRequest(ctx)))).rejects.toMatchObject({ code: "connection" });
  });
});
