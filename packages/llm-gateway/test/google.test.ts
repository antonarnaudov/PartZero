import { describe, expect, it } from "vitest";
import { GoogleAdapter, SKIP_THOUGHT_SIGNATURE } from "../src/adapters/google.js";
import type { ChatRequest, ToolUseBlock } from "../src/types.js";
import { PNG_1PX, collect, ctxFor, firstTurn, iterate, loadFixture } from "./helpers.js";

const adapter = new GoogleAdapter();

function parse(name: string, request: ChatRequest) {
  const ctx = ctxFor(request);
  return adapter.parseResponse(loadFixture(name).response, ctx, adapter.buildRequest(ctx));
}

describe("GoogleAdapter request mapping (generateContent)", () => {
  it("maps a first turn for gemini-3.8-flash to the exact generateContent parameters", () => {
    const built = adapter.buildRequest(ctxFor(firstTurn("gemini-3.8-flash", { cache: { auto: true } })));
    expect(built.operation).toBe("google.models.generateContent");
    expect(built.warnings).toEqual([]);
    expect(built.payload).toMatchSnapshot();
  });

  it("uses VALIDATED function calling for strict tools, the profile default thinking level, and a sanitized JSON Schema", () => {
    const p = adapter.buildRequest(ctxFor(firstTurn("gemini-3.8-flash"))).payload as Record<string, any>;
    expect(p["config"].toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(p["config"].thinkingConfig).toEqual({ thinkingLevel: "MEDIUM" });
    const schema = p["config"].tools[0].functionDeclarations[0].parametersJsonSchema;
    // `pattern` is outside Gemini's documented subset: dropped and restated in the description.
    expect(schema.properties.highlight).toEqual({ type: "string", description: "Entity id to highlight (pattern: \"^(face|edge):\\\\d+$\")" });
    expect(schema.properties.scale).toEqual({ type: "number", minimum: 0.1, maximum: 10 });
    expect(p["config"].temperature).toBeUndefined();
  });

  it("clamps efforts above the model's ladder (xhigh -> HIGH) with a warning and maps summaries to includeThoughts", () => {
    const built = adapter.buildRequest(ctxFor(firstTurn("gemini-3.1-pro-preview", { reasoning: { effort: "xhigh", summary: true } })));
    expect((built.payload as Record<string, any>)["config"].thinkingConfig).toEqual({ thinkingLevel: "HIGH", includeThoughts: true });
    expect(built.warnings).toEqual(["gemini-3.1-pro-preview: reasoning effort 'xhigh' not supported, using 'high'"]);
  });

  it("warns that explicit cache breakpoints are not a thing on generateContent", () => {
    const built = adapter.buildRequest(ctxFor(firstTurn("gemini-3.8-flash", { cache: { tools: true } })));
    expect(built.warnings[0]).toMatch(/implicit caching/);
  });

  it("rejects URL images (inline data only)", () => {
    const req = firstTurn("gemini-3.8-flash");
    req.messages = [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }];
    expect(() => adapter.buildRequest(ctxFor(req))).toThrow(/does not accept image URLs/);
  });
});

describe("GoogleAdapter responses, thought signatures and replay", () => {
  it("parses thought summaries and parallel calls; the signature stays on the first functionCall part", () => {
    const r = parse("google/response-parallel-calls.json", firstTurn("gemini-3.8-flash"));
    expect(r.stopReason).toBe("tool_use");
    expect(r.message.content.map((b) => b.type)).toEqual(["reasoning", "tool_use", "tool_use"]);
    expect(r.message.content[1]).toMatchObject({
      id: "fc-render-1",
      name: "render_views",
      input: { views: ["iso"] },
      native: { data: [{ functionCall: { id: "fc-render-1" }, thoughtSignature: "SIG_A_base64==" }] },
    });
    // promptTokenCount includes cached tokens; thinking tokens bill as output.
    expect(r.usage).toEqual({ inputTokens: 904, outputTokens: 380, cacheReadTokens: 4096, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 300 });
    // Introductory 3.8 Flash pricing on 2026-09-23: $0.75 in, $0.075 cached, $3.75 out.
    expect(r.costUsd).toBeCloseTo((904 * 0.75 + 4096 * 0.075 + 380 * 3.75) / 1e6, 12);
  });

  it("replays the model turn unmerged and in order, then sends all functionResponses after the calls", () => {
    const first = firstTurn("gemini-3.8-flash");
    const r = parse("google/response-parallel-calls.json", first);
    const next: ChatRequest = {
      ...first,
      messages: [
        ...first.messages,
        r.message,
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "fc-render-1",
              content: [
                { type: "text", text: "iso view" },
                { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } },
              ],
            },
            { type: "tool_result", toolUseId: "fc-measure-2", content: "2.4 mm", isError: false },
          ],
        },
      ],
    };
    const p = adapter.buildRequest(ctxFor(next)).payload as Record<string, any>;
    const original = (loadFixture("google/response-parallel-calls.json").response as Record<string, any>)["candidates"][0].content;
    expect(p["contents"][1]).toEqual({ role: "model", parts: original.parts });
    expect(p["contents"][2]).toMatchSnapshot();
  });

  it("adds the documented dummy signature to foreign function calls (history from another model)", () => {
    const req = firstTurn("gemini-3.8-flash");
    req.messages = [
      ...req.messages,
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "measure", input: { entity: "face:1" } },
          { type: "tool_use", id: "toolu_2", name: "measure", input: { entity: "face:2" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "1" }, { type: "tool_result", toolUseId: "toolu_2", content: "2" }] },
    ];
    const p = adapter.buildRequest(ctxFor(req)).payload as Record<string, any>;
    expect(p["contents"][1].parts).toEqual([
      { functionCall: { name: "measure", args: { entity: "face:1" }, id: "toolu_1" }, thoughtSignature: SKIP_THOUGHT_SIGNATURE },
      { functionCall: { name: "measure", args: { entity: "face:2" }, id: "toolu_2" } },
    ]);
    expect(p["contents"][2].parts.map((x: any) => x.functionResponse.name)).toEqual(["measure", "measure"]);
  });

  it("streams text and attaches the trailing signature-only part to the text block (no merged parts)", async () => {
    const req = firstTurn("gemini-3.8-flash");
    const ctx = ctxFor(req);
    const { events, response } = await collect(adapter.parseStream(iterate(loadFixture("google/stream-text-signature.json").events ?? []), ctx, adapter.buildRequest(ctx)));
    expect(events.map((e) => e.type)).toEqual(["message_start", "text_delta", "text_delta", "usage", "message_end"]);
    expect(response.stopReason).toBe("end_turn");
    expect(response.message.content).toHaveLength(1);
    expect(response.message.content[0]).toMatchObject({
      type: "text",
      text: "The wall is 2.4 mm thick.",
      native: { data: [{ text: "The wall is " }, { text: "2.4 mm thick." }, { text: "", thoughtSignature: "SIG_C_base64==" }] },
    });
    expect(response.usage.outputTokens).toBe(162);
  });

  it("maps SAFETY and blocked prompts to refusals, MALFORMED_FUNCTION_CALL to error", () => {
    const req = firstTurn("gemini-3.8-flash");
    expect(parse("google/response-safety.json", req)).toMatchObject({ stopReason: "refusal", refusal: { category: "SAFETY", explanation: "Blocked for safety." } });
    expect(parse("google/response-prompt-blocked.json", req)).toMatchObject({ stopReason: "refusal", refusal: { category: "PROHIBITED_CONTENT" } });
    expect(parse("google/response-malformed.json", req)).toMatchObject({ stopReason: "error", providerStopReason: "MALFORMED_FUNCTION_CALL" });
  });

  it("prices Gemini 3.1 Pro above 200K prompt tokens at the long-context tier", () => {
    const req = firstTurn("gemini-3.1-pro-preview");
    const ctx = ctxFor(req);
    const raw = structuredClone(loadFixture("google/response-safety.json").response) as Record<string, any>;
    raw["usageMetadata"] = { promptTokenCount: 250_000, cachedContentTokenCount: 50_000, candidatesTokenCount: 1000, thoughtsTokenCount: 1000 };
    const r = adapter.parseResponse(raw, ctx, adapter.buildRequest(ctx));
    // >200k: $4 in, $0.40 cached, $18 out.
    expect(r.costUsd).toBeCloseTo((200_000 * 4 + 50_000 * 0.4 + 2000 * 18) / 1e6, 12);
  });

  it("synthesizes ids for calls without one and omits them again on the way back", () => {
    const req = firstTurn("gemini-3.8-flash");
    const ctx = ctxFor(req);
    const raw = { candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "measure", args: { entity: "e" } }, thoughtSignature: "S" }] } }] };
    const r = adapter.parseResponse(raw, ctx, adapter.buildRequest(ctx));
    const call = r.message.content[0] as ToolUseBlock;
    expect(call.id).toBe("gemini-call-1");
    const next: ChatRequest = { ...req, messages: [...req.messages, r.message, { role: "user", content: [{ type: "tool_result", toolUseId: call.id, content: "ok" }] }] };
    const p = adapter.buildRequest(ctxFor(next)).payload as Record<string, any>;
    expect(p["contents"][2].parts[0]).toEqual({ functionResponse: { name: "measure", response: { output: "ok" } } });
  });
});
