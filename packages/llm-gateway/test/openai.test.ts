import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { describe, expect, it } from "vitest";
import { OpenAIAdapter } from "../src/adapters/openai.js";
import type { ChatRequest, ToolUseBlock } from "../src/types.js";
import { PNG_1PX, collect, ctxFor, firstTurn, iterate, loadFixture } from "./helpers.js";

const adapter = new OpenAIAdapter();

function parse(name: string, request: ChatRequest) {
  const ctx = ctxFor(request);
  return adapter.parseResponse(loadFixture(name).response, ctx, adapter.buildRequest(ctx));
}

describe("OpenAIAdapter request mapping (Responses API)", () => {
  it("maps a first turn for gpt-6-astra to the exact Responses payload", () => {
    const built = adapter.buildRequest(ctxFor(firstTurn("gpt-6-astra", { reasoning: { effort: "high", summary: true }, cache: { key: "task-42" } })));
    expect(built.operation).toBe("openai.responses.create");
    expect(built.warnings).toEqual([]);
    expect(built.payload).toMatchSnapshot();
  });

  it("is stateless, keeps the system prompt as a cache-breakpointed developer message and sets explicit-cache options", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("gpt-6-astra"))).payload as Record<string, any>;
    expect(p["store"]).toBe(false);
    expect(p["include"]).toEqual(["reasoning.encrypted_content"]);
    expect(p["input"][0].role).toBe("developer");
    expect(p["input"][0].content[1].prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    expect(p["input"][0].content[0].prompt_cache_breakpoint).toBeUndefined();
    expect(p["prompt_cache_options"]).toEqual({ mode: "implicit", ttl: "30m" });
    const explicitOnly = adapter.buildRequest(ctxFor(firstTurn("gpt-6-astra", { cache: { auto: false } }))).payload as Record<string, any>;
    expect(explicitOnly["prompt_cache_options"]).toEqual({ mode: "explicit", ttl: "30m" });
  });

  it("rewrites strict tool schemas to OpenAI strict form and keeps non-strict tools non-strict", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("gpt-6-astra"))).payload as Record<string, any>;
    const [render, measure] = p["tools"];
    expect(render.strict).toBe(true);
    expect(render.parameters.required).toEqual(["views", "highlight", "scale"]);
    expect(render.parameters.additionalProperties).toBe(false);
    expect(render.parameters.properties.highlight.type).toEqual(["string", "null"]);
    expect(render.parameters.properties.views.type).toBe("array");
    expect(measure.strict).toBe(false);
    expect(p["tool_choice"]).toBe("auto");
  });

  it("omits reasoning.effort when the profile has no documented default (GPT-6 Astra) and uses it otherwise", () => {
    const astra = adapter.buildRequest(ctxFor(firstTurn("gpt-6-astra"))).payload as Record<string, any>;
    expect(astra["reasoning"]).toBeUndefined();
    const sol = adapter.buildRequest(ctxFor(firstTurn("gpt-6-sol"))).payload as Record<string, any>;
    expect(sol["reasoning"]).toEqual({ effort: "medium" });
  });

  it("sends images in tool results as input_image content of function_call_output, with the profile's default detail", () => {
    const req: ChatRequest = {
      ...firstTurn("gpt-6-astra"),
      messages: [
        { role: "user", content: [{ type: "text", text: "check it" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_R", name: "render_views", input: { views: ["iso"] } }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_R",
              isError: true,
              content: [
                { type: "text", text: "partial render" },
                { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } },
              ],
            },
          ],
        },
      ],
    };
    const p = adapter.buildRequest(ctxFor(req)).payload as Record<string, any>;
    expect(p["input"].slice(1)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "check it" }] },
      { type: "function_call", call_id: "call_R", name: "render_views", arguments: '{"views":["iso"]}' },
      {
        type: "function_call_output",
        call_id: "call_R",
        output: [
          { type: "input_text", text: "Error:" },
          { type: "input_text", text: "partial render" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG_1PX}`, detail: "high" },
        ],
      },
    ]);
  });
});

describe("OpenAIAdapter responses and replay", () => {
  it("parses reasoning, commentary and a strict function call; strips strict-mode nulls; accounts cache writes", () => {
    const r = parse("openai/response-tool-call.json", firstTurn("gpt-6-astra"));
    expect(r.stopReason).toBe("tool_use");
    expect(r.message.content.map((b) => b.type)).toEqual(["reasoning", "text", "tool_use"]);
    expect(r.message.content[0]).toMatchObject({ kind: "reasoning", text: "Need a render before measuring." });
    const call = r.message.content[2] as ToolUseBlock;
    // "highlight": null was only there because strict mode made the optional field required+nullable.
    expect(call.input).toEqual({ views: ["iso", "top"] });
    expect(r.usage).toEqual({ inputTokens: 2000, outputTokens: 600, cacheReadTokens: 8000, cacheWriteTokens: 2000, cacheWrite1hTokens: 0, reasoningTokens: 400 });
    // $10 in, $1 cached, $12.5 cache write, $50 out (gpt-6-astra model page).
    expect(r.costUsd).toBeCloseTo((2000 * 10 + 8000 * 1 + 2000 * 12.5 + 600 * 50) / 1e6, 12);
  });

  it("replays every output item unchanged (encrypted reasoning, message phase, function call) via toResponseInputItems", () => {
    const first = firstTurn("gpt-6-astra");
    const r = parse("openai/response-tool-call.json", first);
    const next: ChatRequest = {
      ...first,
      messages: [...first.messages, r.message, { role: "user", content: [{ type: "tool_result", toolUseId: "call_Render1", content: "ok" }] }],
    };
    const p = adapter.buildRequest(ctxFor(next)).payload as Record<string, any>;
    const output = (loadFixture("openai/response-tool-call.json").response as Record<string, any>)["output"];
    expect(p["input"].slice(2, 5)).toEqual(toResponseInputItems(output));
    expect(p["input"][2]).toMatchObject({ type: "reasoning", encrypted_content: "gAAAAABoEncryptedReasoningBlob==" });
    expect(p["input"][3]).toMatchObject({ type: "message", phase: "commentary" });
    expect(p["input"][5]).toEqual({ type: "function_call_output", call_id: "call_Render1", output: "ok" });
  });

  it("streams: normalized events line up with the final response parsed from response.completed", async () => {
    const req = firstTurn("gpt-6-astra");
    const ctx = ctxFor(req);
    const { events, response } = await collect(adapter.parseStream(iterate(loadFixture("openai/stream-tool-call.json").events ?? []), ctx, adapter.buildRequest(ctx)));
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "reasoning_start",
      "reasoning_delta",
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
    const deltas = events.filter((e) => e.type === "text_delta").map((e) => (e.type === "text_delta" ? e.index : -1));
    expect(deltas).toEqual([1, 1]);
    expect((response.message.content[1] as { text: string }).text).toBe("Rendering the bracket first.");
    expect(response.stopReason).toBe("tool_use");
  });

  it("maps incomplete/max_output_tokens to max_tokens and marks the cut-off call unsafe", () => {
    const r = parse("openai/response-incomplete.json", firstTurn("gpt-6-astra"));
    expect(r.stopReason).toBe("max_tokens");
    expect(r.providerStopReason).toBe("incomplete:max_output_tokens");
    const call = r.message.content[0] as ToolUseBlock;
    expect(call.inputError).toMatch(/not valid JSON/);
  });

  it("maps a refusal content part to a refusal", () => {
    const r = parse("openai/response-refusal.json", firstTurn("gpt-6-luna"));
    expect(r.stopReason).toBe("refusal");
    expect(r.refusal?.explanation).toBe("I can't help with that request.");
  });

  it("applies the >272K long-context surcharge to the whole request", () => {
    const req = firstTurn("gpt-6-sol");
    const ctx = ctxFor(req);
    const response = structuredClone(loadFixture("openai/response-refusal.json").response) as Record<string, any>;
    response["usage"] = { input_tokens: 300_000, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 1000, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 301_000 };
    const r = adapter.parseResponse(response, ctx, adapter.buildRequest(ctx));
    expect(r.costUsd).toBeCloseTo((300_000 * 2 * 2 + 1000 * 10 * 1.5) / 1e6, 12);
  });
});
