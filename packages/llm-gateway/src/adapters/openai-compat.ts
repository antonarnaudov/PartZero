import type OpenAI from "openai";
import { GatewayError } from "../errors.js";
import type { AssistantContentBlock, ChatResponse, ImageBlock, StopReason, StreamEvent, Usage } from "../types.js";
import {
  asRecord,
  checkImage,
  finalizeResponse,
  foreignReasoningWarning,
  imageUrl,
  mappedEffort,
  noteDropped,
  num,
  parseToolArguments,
  resolveEffort,
  textOfToolResult,
  toolUseFromArgs,
  type AdapterContext,
  type BuiltRequest,
  type ProviderAdapter,
} from "./adapter.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart;

const DEFAULT_COMPAT = {
  maxTokensParam: "max_tokens" as const,
  reasoningFields: ["reasoning_content", "reasoning", "reasoning_details"],
  replayReasoningFields: true,
  providerReportsCost: false,
  streamUsage: true,
};

/**
 * OpenAI-compatible Chat Completions adapter (`openai` SDK with a custom `baseURL`): vLLM, Ollama, OpenRouter, LM Studio.
 *
 * The wire format is the de-facto standard, but reasoning and a few fields are server-specific, so the profile's
 * `compat` block says which assistant fields carry reasoning (`reasoning_content` on vLLM, `reasoning` /
 * `reasoning_details` on OpenRouter), whether to send them back (OpenRouter requires `reasoning_details` to be passed
 * back unmodified in tool loops), and whether the endpoint reports `usage.cost`. Tool calls are replayed with any
 * extra fields the server attached (e.g. `extra_content.google.thought_signature` on Gemini's compatibility endpoint).
 */
export class OpenAICompatAdapter implements ProviderAdapter {
  readonly provider = "openai-compat" as const;

  buildRequest(ctx: AdapterContext): BuiltRequest {
    const { profile, request } = ctx;
    const compat = { ...DEFAULT_COMPAT, ...profile.compat };
    const warnings: string[] = [];
    if (hasCacheMarks(ctx)) warnings.push(`${profile.id}: cache breakpoints ignored (OpenAI-compatible endpoint)`);

    const messages: ChatMessage[] = [];
    const system = request.system ?? [];
    if (system.length > 0) messages.push({ role: "system", content: system.map((s) => s.text).join("\n\n") });

    const dropped = new Map<string, number>();
    for (const m of request.messages) {
      if (m.role === "user") {
        const followupImages: ContentPart[] = [];
        for (const b of m.content) {
          if (b.type !== "tool_result") continue;
          const prefix = b.isError === true ? "Error: " : "";
          const images = typeof b.content === "string" ? [] : b.content.filter((c): c is ImageBlock => c.type === "image");
          let text = prefix + textOfToolResult(b.content);
          if (images.length > 0) {
            if (profile.capabilities.toolResultImages === "user_followup") {
              followupImages.push({ type: "text", text: `Images returned by tool call ${b.toolUseId}:` });
              for (const img of images) followupImages.push(this.#image(ctx, img, `tool result ${b.toolUseId}`));
            } else {
              text += `\n[${images.length} image(s) omitted: ${profile.id} cannot receive images in tool results]`;
              warnings.push(`${profile.id}: dropped ${images.length} image(s) from tool result ${b.toolUseId}`);
            }
          }
          // Tool messages accept text parts only on Chat Completions.
          messages.push({ role: "tool", tool_call_id: b.toolUseId, content: text });
        }
        const parts: ContentPart[] = [...followupImages];
        for (const b of m.content) {
          if (b.type === "text") parts.push({ type: "text", text: b.text });
          else if (b.type === "image") parts.push(this.#image(ctx, b, "user message"));
        }
        if (parts.length > 0) {
          const onlyText = parts.every((p) => p.type === "text");
          messages.push({ role: "user", content: onlyText ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts });
        }
      } else {
        const texts: string[] = [];
        const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
        const reasoningFields: Record<string, unknown> = {};
        for (const b of m.content) {
          if (b.type === "text") texts.push(b.text);
          else if (b.type === "tool_use") {
            const nativeCall = b.native?.provider === "openai-compat" ? (b.native.data as OpenAI.Chat.Completions.ChatCompletionMessageToolCall) : undefined;
            toolCalls.push(nativeCall ?? { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } });
          } else if (b.native.provider === "openai-compat") {
            const data = asRecord(b.native.data);
            if (compat.replayReasoningFields && typeof data["field"] === "string") reasoningFields[data["field"]] = data["value"];
          } else {
            noteDropped(dropped, b.native.provider);
          }
        }
        const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
          role: "assistant",
          content: texts.length > 0 ? texts.join("") : null,
        };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push({ ...msg, ...reasoningFields } as ChatMessage);
      }
    }
    warnings.push(...foreignReasoningWarning("openai-compat", dropped));

    const payload: Record<string, unknown> = { model: profile.apiModelId, messages };
    payload[compat.maxTokensParam] = ctx.maxOutputTokens;
    const tools = request.tools ?? [];
    if (tools.length > 0) {
      payload["tools"] = tools.map(
        (t): OpenAI.Chat.Completions.ChatCompletionFunctionTool => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema, ...(t.strict === true && profile.capabilities.strictTools ? { strict: true } : {}) },
        }),
      );
      payload["tool_choice"] = request.toolChoice === "none" ? "none" : "auto";
      if (request.parallelToolCalls !== undefined && profile.capabilities.parallelToolCallsToggle) payload["parallel_tool_calls"] = request.parallelToolCalls;
    }
    const effort = resolveEffort(ctx, warnings);
    if (effort !== undefined) {
      if (profile.reasoning.style === "compat-reasoning-effort") payload["reasoning_effort"] = mappedEffort(ctx, effort);
      else if (profile.reasoning.style === "compat-openrouter") payload["reasoning"] = { effort: mappedEffort(ctx, effort) };
    }
    if (request.metadata?.userId !== undefined) payload["user"] = request.metadata.userId;
    Object.assign(payload, request.providerOptions?.["openai-compat"]?.extra ?? {});

    const built: BuiltRequest = {
      operation: "openai-compat.chat.completions.create",
      payload,
      preferStream: request.stream === true || profile.capabilities.alwaysStream,
      warnings,
    };
    if (compat.streamUsage) built.streamExtras = { stream_options: { include_usage: true } };
    const endpoint = profile.compat?.baseURL;
    if (endpoint !== undefined) built.endpoint = endpoint;
    return built;
  }

  #image(ctx: AdapterContext, image: ImageBlock, where: string): ContentPart {
    checkImage(ctx, image, where);
    const detail = image.detail === "original" ? "high" : image.detail;
    return { type: "image_url", image_url: { url: imageUrl(image), ...(detail === undefined ? {} : { detail }) } };
  }

  parseResponse(raw: unknown, ctx: AdapterContext, built: BuiltRequest): ChatResponse {
    const completion = raw as OpenAI.Chat.Completions.ChatCompletion;
    const choice = completion.choices[0];
    if (choice === undefined) throw new GatewayError("server_error", "openai-compat: response has no choices", { provider: "openai-compat" });
    const message = choice.message as unknown as Record<string, unknown>;
    const compat = { ...DEFAULT_COMPAT, ...ctx.profile.compat };
    const content: AssistantContentBlock[] = [];
    for (const field of compat.reasoningFields) {
      const value = message[field];
      if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) continue;
      content.push(reasoningBlock(ctx, field, value));
    }
    const text = typeof message["content"] === "string" ? message["content"] : "";
    if (text.length > 0) content.push({ type: "text", text });
    const calls = (choice.message.tool_calls ?? []) as OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[];
    for (const call of calls) {
      const native = { provider: "openai-compat" as const, model: ctx.profile.id, data: call };
      content.push(toolUseFromArgs({ id: call.id, name: call.function.name, native }, call.function.arguments));
    }
    const refusal = typeof message["refusal"] === "string" && message["refusal"].length > 0 ? message["refusal"] : undefined;
    const usage = usageFromCompat(completion.usage);
    const parsed = {
      id: completion.id,
      providerModel: completion.model,
      content,
      ...stopFromCompat(choice.finish_reason, refusal),
      usage,
      providerRaw: completion,
    };
    const cost = providerCost(ctx, completion.usage);
    return finalizeResponse(ctx, built, cost === undefined ? parsed : { ...parsed, providerCostUsd: cost });
  }

  async *parseStream(events: AsyncIterable<unknown>, ctx: AdapterContext, built: BuiltRequest): AsyncGenerator<StreamEvent, ChatResponse> {
    const compat = { ...DEFAULT_COMPAT, ...ctx.profile.compat };
    type Slot =
      | { kind: "text"; text: string }
      | { kind: "reasoning"; field: string; value: unknown }
      | { kind: "tool"; call: Record<string, unknown>; fn: { name: string; arguments: string } };
    const slots: Slot[] = [];
    let textIndex: number | undefined;
    const reasoningIndex = new Map<string, number>();
    const toolIndex = new Map<number, number>();
    let finish: string | null = null;
    let refusal = "";
    let usageRaw: OpenAI.Completions.CompletionUsage | undefined;
    let id = "";
    let model = ctx.profile.apiModelId;
    let started = false;

    for await (const raw of events) {
      const chunk = raw as OpenAI.Chat.Completions.ChatCompletionChunk;
      if (!started) {
        started = true;
        yield { type: "message_start", provider: "openai-compat", model: ctx.profile.id, providerModel: chunk.model };
      }
      id = chunk.id || id;
      model = chunk.model || model;
      if (chunk.usage !== undefined && chunk.usage !== null) {
        usageRaw = chunk.usage;
        yield { type: "usage", usage: usageFromCompat(chunk.usage) };
      }
      const choice = chunk.choices[0];
      if (choice === undefined) continue;
      const delta = choice.delta as unknown as Record<string, unknown>;
      for (const field of compat.reasoningFields) {
        const piece = delta[field];
        if (piece === undefined || piece === null || piece === "") continue;
        let index = reasoningIndex.get(field);
        if (index === undefined) {
          index = slots.length;
          reasoningIndex.set(field, index);
          slots.push({ kind: "reasoning", field, value: Array.isArray(piece) ? [] : "" });
          yield { type: "reasoning_start", index, kind: "compat_reasoning" };
        }
        const slot = slots[index] as Extract<Slot, { kind: "reasoning" }>;
        if (Array.isArray(piece)) slot.value = [...(slot.value as unknown[]), ...piece];
        else if (typeof piece === "string") slot.value = (slot.value as string) + piece;
        const text = reasoningText(piece);
        if (text.length > 0) yield { type: "reasoning_delta", index, text };
      }
      if (typeof delta["content"] === "string" && delta["content"].length > 0) {
        if (textIndex === undefined) {
          textIndex = slots.length;
          slots.push({ kind: "text", text: "" });
        }
        (slots[textIndex] as Extract<Slot, { kind: "text" }>).text += delta["content"];
        yield { type: "text_delta", index: textIndex, text: delta["content"] };
      }
      if (typeof delta["refusal"] === "string") refusal += delta["refusal"];
      for (const tc of (choice.delta.tool_calls ?? []) as unknown as Array<Record<string, unknown>>) {
        const tcIndex = num(tc["index"]);
        let index = toolIndex.get(tcIndex);
        const fn = asRecord(tc["function"]);
        if (index === undefined) {
          index = slots.length;
          toolIndex.set(tcIndex, index);
          const { index: _i, function: _f, ...rest } = tc;
          slots.push({ kind: "tool", call: { ...rest }, fn: { name: typeof fn["name"] === "string" ? fn["name"] : "", arguments: "" } });
          yield { type: "tool_use_start", index, id: String(tc["id"] ?? ""), name: typeof fn["name"] === "string" ? fn["name"] : "" };
        } else {
          const slot = slots[index] as Extract<Slot, { kind: "tool" }>;
          const { index: _i, function: _f, ...rest } = tc;
          Object.assign(slot.call, rest);
          if (typeof fn["name"] === "string" && slot.fn.name === "") slot.fn.name = fn["name"];
        }
        const slot = slots[index] as Extract<Slot, { kind: "tool" }>;
        if (typeof fn["arguments"] === "string" && fn["arguments"].length > 0) {
          slot.fn.arguments += fn["arguments"];
          yield { type: "tool_use_input_delta", index, id: String(slot.call["id"] ?? ""), partialJson: fn["arguments"] };
        }
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) finish = choice.finish_reason;
    }
    if (!started) throw new GatewayError("connection", "openai-compat: empty stream", { provider: "openai-compat", retryable: true });

    const content: AssistantContentBlock[] = [];
    for (const [index, slot] of slots.entries()) {
      if (slot.kind === "text") content.push({ type: "text", text: slot.text });
      else if (slot.kind === "reasoning") {
        content.push(reasoningBlock(ctx, slot.field, slot.value));
        yield { type: "reasoning_end", index };
      } else {
        const call = { ...slot.call, type: "function", function: slot.fn };
        const native = { provider: "openai-compat" as const, model: ctx.profile.id, data: call };
        const block = toolUseFromArgs({ id: String(slot.call["id"] ?? `call_${index}`), name: slot.fn.name, native }, slot.fn.arguments);
        content.push(block);
        const parsed = parseToolArguments(slot.fn.arguments);
        yield {
          type: "tool_use_end",
          index,
          id: block.id,
          name: block.name,
          input: parsed.input,
          ...(parsed.error === undefined ? {} : { inputError: parsed.error }),
        };
      }
    }
    const parsed = {
      id,
      providerModel: model,
      content,
      ...stopFromCompat(finish, refusal.length > 0 ? refusal : undefined),
      usage: usageFromCompat(usageRaw),
      providerRaw: { id, model, finish_reason: finish, usage: usageRaw ?? null, content },
    };
    const cost = providerCost(ctx, usageRaw);
    const response = finalizeResponse(ctx, built, cost === undefined ? parsed : { ...parsed, providerCostUsd: cost });
    yield { type: "message_end", response };
    return response;
  }
}

function hasCacheMarks(ctx: AdapterContext): boolean {
  return (
    (ctx.request.system ?? []).some((s) => s.cacheBreakpoint === true) ||
    ctx.request.messages.some((m) => m.content.some((b) => "cacheBreakpoint" in b && b.cacheBreakpoint === true))
  );
}

function reasoningText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((d) => {
        const r = asRecord(d);
        return typeof r["text"] === "string" ? r["text"] : typeof r["summary"] === "string" ? r["summary"] : "";
      })
      .join("");
  }
  return "";
}

function reasoningBlock(ctx: AdapterContext, field: string, value: unknown): AssistantContentBlock {
  const text = reasoningText(value);
  return {
    type: "reasoning",
    kind: "compat_reasoning",
    ...(text.length > 0 ? { text } : {}),
    native: { provider: "openai-compat", model: ctx.profile.id, data: { field, value } },
  };
}

function stopFromCompat(
  finish: string | null,
  refusal: string | undefined,
): { stopReason: StopReason; providerStopReason: string | null; refusal?: { category: string | null; explanation: string | null } } {
  if (refusal !== undefined) return { stopReason: "refusal", providerStopReason: finish ?? "refusal", refusal: { category: null, explanation: refusal } };
  switch (finish) {
    case "stop":
      return { stopReason: "end_turn", providerStopReason: finish };
    case "tool_calls":
    case "function_call":
      return { stopReason: "tool_use", providerStopReason: finish };
    case "length":
      return { stopReason: "max_tokens", providerStopReason: finish };
    case "content_filter":
      return { stopReason: "refusal", providerStopReason: finish, refusal: { category: "content_filter", explanation: null } };
    default:
      return { stopReason: "error", providerStopReason: finish };
  }
}

export function usageFromCompat(u: OpenAI.Completions.CompletionUsage | undefined | null): Usage {
  const usage = asRecord(u);
  const inDetails = asRecord(usage["prompt_tokens_details"]);
  const outDetails = asRecord(usage["completion_tokens_details"]);
  const prompt = num(usage["prompt_tokens"]);
  const cached = num(inDetails["cached_tokens"]);
  const written = num(inDetails["cache_write_tokens"]);
  return {
    inputTokens: Math.max(0, prompt - cached - written),
    outputTokens: num(usage["completion_tokens"]),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    cacheWrite1hTokens: 0,
    reasoningTokens: num(outDetails["reasoning_tokens"]),
  };
}

function providerCost(ctx: AdapterContext, u: unknown): number | undefined {
  if (ctx.profile.compat?.providerReportsCost !== true) return undefined;
  const cost = asRecord(u)["cost"];
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}
