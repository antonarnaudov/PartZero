import { describe, expect, it } from "vitest";
import { OpenAICompatAdapter } from "../src/adapters/openai-compat.js";
import { deepMerge, type ModelProfile } from "../src/profile.js";
import type { ChatRequest, ToolUseBlock } from "../src/types.js";
import { PNG_1PX, collect, ctxFor, iterate, loadFixture, measureTool, profile, renderTool } from "./helpers.js";

const adapter = new OpenAICompatAdapter();

function textTurn(model: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model,
    system: [{ type: "text", text: "You are a CAD assistant." }],
    tools: [renderTool, measureTool],
    messages: [{ role: "user", content: [{ type: "text", text: "How thick is the wall?" }] }],
    reasoning: { effort: "high" },
    ...extra,
  };
}

/** An OpenRouter-hosted vision model defined purely by config (profile override), as a user would. */
const openRouterVision: ModelProfile = deepMerge(profile("gpt-oss-120b"), {
  id: "openrouter-vision",
  apiModelId: "vendor/vision-model",
  family: "example-vision",
  vendor: "example",
  capabilities: {
    vision: true,
    toolResultImages: "user_followup",
    images: { formats: ["image/png", "image/jpeg"], urlSource: true, estimatedTokensPerImage: 1000 },
  },
  reasoning: { style: "compat-openrouter" },
  compat: { baseURL: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", providerReportsCost: true },
});

describe("OpenAICompatAdapter request mapping (Chat Completions)", () => {
  it("maps a turn for gpt-oss-120b (vLLM) to the exact chat.completions payload", () => {
    const built = adapter.buildRequest(ctxFor(textTurn("gpt-oss-120b")));
    expect(built.operation).toBe("openai-compat.chat.completions.create");
    expect(built.endpoint).toBe("http://localhost:8000/v1");
    expect(built.streamExtras).toEqual({ stream_options: { include_usage: true } });
    expect(built.payload).toMatchSnapshot();
  });

  it("replays reasoning fields and native tool calls (incl. provider extras) unchanged", () => {
    const first = textTurn("gpt-oss-120b");
    const ctx = ctxFor(first);
    const r = adapter.parseResponse(loadFixture("compat/completion-tool-call.json").response, ctx, adapter.buildRequest(ctx));
    const native = (r.message.content[2] as ToolUseBlock).native!;
    // e.g. Gemini's OpenAI-compatible endpoint puts thought signatures in extra_content on tool calls.
    (native.data as Record<string, unknown>)["extra_content"] = { google: { thought_signature: "SIG" } };
    const next: ChatRequest = {
      ...first,
      messages: [...first.messages, r.message, { role: "user", content: [{ type: "tool_result", toolUseId: "chatcmpl-tool-7a", content: "2.4 mm" }] }],
    };
    const p = adapter.buildRequest(ctxFor(next)).payload as Record<string, any>;
    expect(p["messages"][2]).toEqual({
      role: "assistant",
      content: "Measuring the wall.",
      reasoning_content: "The user wants wall thickness; call measure.",
      tool_calls: [
        { id: "chatcmpl-tool-7a", type: "function", function: { name: "measure", arguments: '{"entity": "face:12"}' }, extra_content: { google: { thought_signature: "SIG" } } },
      ],
    });
    expect(p["messages"][3]).toEqual({ role: "tool", tool_call_id: "chatcmpl-tool-7a", content: "2.4 mm" });
  });

  it("rejects user images for a text-only model but degrades tool-result images to a placeholder", () => {
    const withImage = textTurn("gpt-oss-120b", {
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } }] }],
    });
    expect(() => adapter.buildRequest(ctxFor(withImage))).toThrow(/does not accept images/);
    const toolImage = textTurn("gpt-oss-120b", {
      messages: [
        { role: "user", content: [{ type: "text", text: "render" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "render_views", input: { views: ["iso"] } }] },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "done" }, { type: "image", source: { type: "base64", mediaType: "image/png", data: PNG_1PX } }] }],
        },
      ],
    });
    const built = adapter.buildRequest(ctxFor(toolImage));
    expect((built.payload as Record<string, any>)["messages"][3]).toEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "done\n[1 image(s) omitted: gpt-oss-120b cannot receive images in tool results]",
    });
    expect(built.warnings).toEqual(["gpt-oss-120b: dropped 1 image(s) from tool result c1"]);
  });

  it("delivers tool-result images as a follow-up user message when the profile says so (OpenRouter-style config)", () => {
    const req: ChatRequest = {
      ...textTurn("openrouter-vision"),
      messages: [
        { role: "user", content: [{ type: "text", text: "render" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "render_views", input: { views: ["iso"] } }] },
        {
          role: "user",
          content: [{ type: "tool_result", toolUseId: "c1", content: [{ type: "text", text: "done" }, { type: "image", source: { type: "url", url: "https://example.com/r.png" } }] }],
        },
      ],
    };
    const p = adapter.buildRequest(ctxFor(req, openRouterVision)).payload as Record<string, any>;
    expect(p["messages"].slice(3)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "done" },
      {
        role: "user",
        content: [
          { type: "text", text: "Images returned by tool call c1:" },
          { type: "image_url", image_url: { url: "https://example.com/r.png" } },
        ],
      },
    ]);
    expect(p["reasoning"]).toEqual({ effort: "high" });
    expect(p["reasoning_effort"]).toBeUndefined();
  });
});

describe("OpenAICompatAdapter responses", () => {
  it("parses reasoning_content, text and tool calls with cached-token accounting", () => {
    const req = textTurn("gpt-oss-120b");
    const ctx = ctxFor(req);
    const r = adapter.parseResponse(loadFixture("compat/completion-tool-call.json").response, ctx, adapter.buildRequest(ctx));
    expect(r.stopReason).toBe("tool_use");
    expect(r.message.content.map((b) => b.type)).toEqual(["reasoning", "text", "tool_use"]);
    expect(r.message.content[2]).toMatchObject({ id: "chatcmpl-tool-7a", name: "measure", input: { entity: "face:12" } });
    expect(r.usage).toEqual({ inputTokens: 476, outputTokens: 90, cacheReadTokens: 1024, cacheWriteTokens: 0, cacheWrite1hTokens: 0, reasoningTokens: 40 });
    expect(r.costUsd).toBe(0);
    expect(r.costSource).toBe("profile");
  });

  it("accumulates streamed reasoning, reasoning_details, content and tool-call deltas; uses provider-reported cost", async () => {
    const req = textTurn("openrouter-vision");
    const ctx = ctxFor(req, openRouterVision);
    const { events, response } = await collect(adapter.parseStream(iterate(loadFixture("compat/stream-tool-call.json").events ?? []), ctx, adapter.buildRequest(ctx)));
    expect(events.map((e) => e.type)).toEqual([
      "message_start",
      "reasoning_start",
      "reasoning_delta",
      "reasoning_start",
      "reasoning_delta",
      "reasoning_delta",
      "reasoning_delta",
      "text_delta",
      "tool_use_start",
      "tool_use_input_delta",
      "tool_use_input_delta",
      "usage",
      "reasoning_end",
      "reasoning_end",
      "tool_use_end",
      "message_end",
    ]);
    expect(response.message.content.map((b) => (b.type === "reasoning" ? (b.native.data as { field: string }).field : b.type))).toEqual([
      "reasoning",
      "reasoning_details",
      "text",
      "tool_use",
    ]);
    expect(response.message.content[1]).toMatchObject({
      text: "Need the hole diameter.",
      native: { data: { value: [{ text: "Need the " }, { text: "hole diameter." }] } },
    });
    expect(response.message.content[3]).toMatchObject({ id: "call_or_1", name: "measure", input: { entity: "edge:4" } });
    expect(response.stopReason).toBe("tool_use");
    expect(response.costUsd).toBe(0.00042);
    expect(response.costSource).toBe("provider");
  });
});
