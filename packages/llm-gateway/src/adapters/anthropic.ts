import type Anthropic from "@anthropic-ai/sdk";
import { GatewayError } from "../errors.js";
import { toAnthropicSchema } from "../schema.js";
import type {
  AssistantContentBlock,
  ChatResponse,
  ImageBlock,
  ReasoningBlock,
  StopReason,
  StreamEvent,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from "../types.js";
import {
  asRecord,
  checkImage,
  finalizeResponse,
  foreignReasoningWarning,
  noteDropped,
  num,
  parseToolArguments,
  resolveEffort,
  type AdapterContext,
  type BuiltRequest,
  type ParsedResponse,
  type ProviderAdapter,
} from "./adapter.js";

/**
 * Anthropic Messages API adapter (@anthropic-ai/sdk).
 *
 * Follows the claude-api skill docs:
 * - adaptive thinking + `output_config.effort` on current models; `budget_tokens` only for Haiku 4.5;
 * - `tool_choice` auto/none only (Opus 5.5 / Fable 5.1 reject forced tool use), `strict: true` tools;
 * - streaming always (long outputs; `eager_input_streaming` on client tools; stable tool bytes for the cache);
 * - prompt caching: explicit breakpoint on the static prefix + top-level automatic caching for the tail, <= 4 slots;
 * - `refusal` / `pause_turn` stop reasons surfaced, never retried around;
 * - assistant turns replayed verbatim (thinking blocks unchanged, even empty ones), history never edited.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = "anthropic" as const;

  buildRequest(ctx: AdapterContext): BuiltRequest {
    const { profile, request } = ctx;
    const warnings: string[] = [];
    const cache = { auto: true, system: true, tools: false, ttl: "5m" as const, ...request.cache };
    const cacheControl: Anthropic.CacheControlEphemeral = cache.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    const cachingEnabled = profile.capabilities.caching.style === "anthropic-breakpoints";
    let breakpoints = 0;
    const mark = <T extends object>(block: T, wanted: boolean | undefined): T => {
      if (!wanted || !cachingEnabled) return block;
      breakpoints += 1;
      return { ...block, cache_control: cacheControl };
    };
    const streaming = profile.capabilities.alwaysStream || request.stream === true;

    // tools -> system -> messages is the render (and cache-prefix) order.
    const tools = (request.tools ?? []).map((t, i, all): Anthropic.Tool => {
      const tool: Anthropic.Tool = {
        name: t.name,
        description: t.description,
        input_schema: toAnthropicSchema(t.name, t.inputSchema, t.strict === true) as Anthropic.Tool.InputSchema,
      };
      if (t.strict === true && profile.capabilities.strictTools) tool.strict = true;
      if (streaming && profile.capabilities.eagerInputStreaming) tool.eager_input_streaming = true;
      return mark(tool, cache.tools && i === all.length - 1);
    });

    const systemBlocks = request.system ?? [];
    const system = systemBlocks.map((s, i): Anthropic.TextBlockParam =>
      mark({ type: "text", text: s.text }, s.cacheBreakpoint === true || (cache.system && i === systemBlocks.length - 1)),
    );

    const dropped = new Map<string, number>();
    const messages: Anthropic.MessageParam[] = [];
    for (const m of request.messages) {
      if (m.role === "user") {
        // tool_result blocks must lead the user turn that answers a tool_use.
        const results = m.content.filter((b): b is ToolResultBlock => b.type === "tool_result");
        const others = m.content.filter((b) => b.type !== "tool_result");
        const content: Anthropic.ContentBlockParam[] = [];
        for (const r of results) content.push(mark(this.#toolResult(ctx, r), r.cacheBreakpoint));
        for (const b of others) {
          if (b.type === "text") content.push(mark({ type: "text", text: b.text }, b.cacheBreakpoint));
          else if (b.type === "image") content.push(mark(this.#image(ctx, b, "user message"), b.cacheBreakpoint));
        }
        if (content.length > 0) messages.push({ role: "user", content });
      } else {
        const content: Anthropic.ContentBlockParam[] = [];
        for (const b of m.content) {
          if (b.native?.provider === "anthropic") {
            // Verbatim replay (thinking signatures bind the conversation prefix). Only cache_control may be added.
            content.push(mark(b.native.data as Anthropic.ContentBlockParam, b.type !== "reasoning" && b.cacheBreakpoint === true));
          } else if (b.type === "text") {
            content.push(mark({ type: "text", text: b.text }, b.cacheBreakpoint));
          } else if (b.type === "tool_use") {
            content.push(mark({ type: "tool_use", id: b.id, name: b.name, input: b.input }, b.cacheBreakpoint));
          } else {
            noteDropped(dropped, b.native.provider);
          }
        }
        if (content.length > 0) messages.push({ role: "assistant", content });
      }
    }
    warnings.push(...foreignReasoningWarning("anthropic", dropped));

    const payload: Anthropic.MessageCreateParamsNonStreaming = {
      model: profile.apiModelId,
      max_tokens: ctx.maxOutputTokens,
      messages,
    };
    if (system.length > 0) payload.system = system;
    if (tools.length > 0) {
      payload.tools = tools;
      payload.tool_choice =
        request.toolChoice === "none"
          ? { type: "none" }
          : request.parallelToolCalls === false && profile.capabilities.parallelToolCallsToggle
            ? { type: "auto", disable_parallel_tool_use: true }
            : { type: "auto" };
    }
    this.#reasoning(ctx, payload, warnings);
    if (cache.auto && cachingEnabled) {
      payload.cache_control = cacheControl;
      breakpoints += 1;
    }
    if (breakpoints > profile.capabilities.caching.maxBreakpoints) {
      throw new GatewayError(
        "invalid_request",
        `${profile.id}: ${breakpoints} cache breakpoints requested (including automatic tail caching), max ${profile.capabilities.caching.maxBreakpoints}`,
        { provider: "anthropic" },
      );
    }
    if (request.metadata?.userId !== undefined) payload.metadata = { user_id: request.metadata.userId };

    const opts = request.providerOptions?.anthropic;
    const body: Record<string, unknown> = { ...payload, ...(opts?.extra ?? {}) };
    if (opts?.betas !== undefined && opts.betas.length > 0) body["betas"] = opts.betas;
    return { operation: "anthropic.messages.create", payload: body, preferStream: streaming, warnings };
  }

  #reasoning(ctx: AdapterContext, payload: Anthropic.MessageCreateParamsNonStreaming, warnings: string[]): void {
    const { profile, request } = ctx;
    const effort = resolveEffort(ctx, warnings);
    const summary = request.reasoning?.summary === true && profile.reasoning.summaries;
    if (profile.reasoning.style === "anthropic-adaptive") {
      // Adaptive is the default on current models; sending it explicitly keeps the request self-describing.
      payload.thinking = summary ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
      if (effort !== undefined) payload.output_config = { effort };
    } else if (profile.reasoning.style === "anthropic-budget") {
      if (effort === undefined) return; // Haiku 4.5: no thinking unless asked for.
      // budget_tokens must be >= 1024 and < max_tokens; thinking counts against max_tokens, so keep at least half
      // of max_tokens for the answer and tool calls.
      const budget = Math.min(profile.reasoning.budgetTokens?.[effort] ?? 4096, Math.floor(ctx.maxOutputTokens / 2));
      if (budget < 1024) {
        warnings.push(`${profile.id}: thinking skipped; budget_tokens must be >= 1024 and at most half of max_tokens (${ctx.maxOutputTokens})`);
        return;
      }
      payload.thinking = summary ? { type: "enabled", budget_tokens: budget, display: "summarized" } : { type: "enabled", budget_tokens: budget };
    }
  }

  #image(ctx: AdapterContext, image: ImageBlock, where: string): Anthropic.ImageBlockParam {
    checkImage(ctx, image, where);
    const source: Anthropic.ImageBlockParam["source"] =
      image.source.type === "url"
        ? { type: "url", url: image.source.url }
        : { type: "base64", media_type: image.source.mediaType, data: image.source.data };
    return { type: "image", source };
  }

  #toolResult(ctx: AdapterContext, r: ToolResultBlock): Anthropic.ToolResultBlockParam {
    const block: Anthropic.ToolResultBlockParam = { type: "tool_result", tool_use_id: r.toolUseId };
    if (typeof r.content === "string") block.content = r.content;
    else {
      block.content = r.content.map((c): Anthropic.TextBlockParam | Anthropic.ImageBlockParam =>
        c.type === "text" ? { type: "text", text: c.text } : this.#image(ctx, c, `tool result ${r.toolUseId}`),
      );
    }
    if (r.isError === true) block.is_error = true;
    return block;
  }

  parseResponse(raw: unknown, ctx: AdapterContext, built: BuiltRequest): ChatResponse {
    const msg = raw as Anthropic.Message;
    const content = msg.content.map((b) => blockFromAnthropic(b, ctx.profile.id));
    return finalizeResponse(ctx, built, {
      id: msg.id,
      providerModel: msg.model,
      content,
      ...stopFromAnthropic(msg.stop_reason, msg.stop_details),
      usage: usageFromAnthropic(msg.usage),
      providerRaw: msg,
    });
  }

  async *parseStream(events: AsyncIterable<unknown>, ctx: AdapterContext, built: BuiltRequest): AsyncGenerator<StreamEvent, ChatResponse> {
    let message: Anthropic.Message | undefined;
    const blocks: Array<{ start: Record<string, unknown>; text: string; thinking: string; signature?: string; json: string; citations: unknown[] }> = [];
    let stopReason: Anthropic.StopReason | null = null;
    let stopDetails: Anthropic.RefusalStopDetails | null = null;
    let usage: Record<string, unknown> = {};
    let ended = false;

    for await (const raw of events) {
      const event = raw as Anthropic.RawMessageStreamEvent;
      switch (event.type) {
        case "message_start":
          message = event.message;
          usage = { ...asRecord(event.message.usage) };
          yield { type: "message_start", provider: "anthropic", model: ctx.profile.id, providerModel: event.message.model };
          break;
        case "content_block_start": {
          const start = { ...(event.content_block as unknown as Record<string, unknown>) };
          blocks[event.index] = { start, text: "", thinking: "", json: "", citations: [] };
          const type = start["type"];
          if (type === "tool_use") {
            yield { type: "tool_use_start", index: event.index, id: String(start["id"]), name: String(start["name"]) };
          } else if (type === "thinking" || type === "redacted_thinking") {
            yield { type: "reasoning_start", index: event.index, kind: type };
          } else if (type === "text" && typeof start["text"] === "string" && start["text"].length > 0) {
            blocks[event.index]!.text = start["text"];
            yield { type: "text_delta", index: event.index, text: start["text"] };
          }
          break;
        }
        case "content_block_delta": {
          const b = blocks[event.index];
          if (b === undefined) throw new GatewayError("invalid_request", `anthropic: delta for unknown block ${event.index}`, { provider: "anthropic" });
          const d = event.delta;
          if (d.type === "text_delta") {
            b.text += d.text;
            yield { type: "text_delta", index: event.index, text: d.text };
          } else if (d.type === "thinking_delta") {
            b.thinking += d.thinking;
            yield { type: "reasoning_delta", index: event.index, text: d.thinking };
          } else if (d.type === "signature_delta") {
            b.signature = d.signature;
          } else if (d.type === "input_json_delta") {
            b.json += d.partial_json;
            yield { type: "tool_use_input_delta", index: event.index, id: String(b.start["id"]), partialJson: d.partial_json };
          } else if (d.type === "citations_delta") {
            b.citations.push(d.citation);
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks[event.index];
          if (b === undefined) break;
          const type = b.start["type"];
          if (type === "tool_use") {
            const parsed = parseToolArguments(b.json);
            yield {
              type: "tool_use_end",
              index: event.index,
              id: String(b.start["id"]),
              name: String(b.start["name"]),
              input: parsed.input,
              ...(parsed.error === undefined ? {} : { inputError: parsed.error }),
            };
          } else if (type === "thinking" || type === "redacted_thinking") {
            yield { type: "reasoning_end", index: event.index };
          }
          break;
        }
        case "message_delta":
          stopReason = event.delta.stop_reason;
          stopDetails = event.delta.stop_details;
          // message_delta usage is cumulative; null fields keep the message_start values.
          for (const [k, v] of Object.entries(event.usage)) if (v !== null && v !== undefined) usage[k] = v;
          yield { type: "usage", usage: usageFromAnthropic(usage as unknown as Anthropic.Usage) };
          break;
        case "message_stop":
          ended = true;
          break;
      }
    }
    if (!ended || message === undefined) {
      throw new GatewayError("connection", "anthropic: stream ended before message_stop", { provider: "anthropic", retryable: true });
    }

    // Rebuild content blocks the way the SDK's MessageStream accumulates them, so they replay verbatim.
    const content: AssistantContentBlock[] = [];
    const finalBlocks: unknown[] = [];
    for (const b of blocks) {
      if (b === undefined) continue;
      const type = b.start["type"];
      let native: Record<string, unknown>;
      if (type === "text") {
        native = { ...b.start, text: b.text };
        if (b.citations.length > 0) native["citations"] = b.citations;
      } else if (type === "thinking") {
        native = { ...b.start, thinking: b.thinking, ...(b.signature === undefined ? {} : { signature: b.signature }) };
      } else if (type === "tool_use") {
        const parsed = parseToolArguments(b.json);
        native = { ...b.start, input: parsed.input };
        const block = blockFromAnthropic(native as unknown as Anthropic.ContentBlock, ctx.profile.id) as ToolUseBlock;
        if (parsed.error !== undefined) {
          block.inputError = parsed.error;
          block.rawInput = b.json;
        }
        content.push(block);
        finalBlocks.push(native);
        continue;
      } else {
        native = { ...b.start };
      }
      finalBlocks.push(native);
      content.push(blockFromAnthropic(native as unknown as Anthropic.ContentBlock, ctx.profile.id));
    }
    const finalMessage = { ...message, content: finalBlocks, stop_reason: stopReason, stop_details: stopDetails, usage };
    const parsed: ParsedResponse = {
      id: message.id,
      providerModel: message.model,
      content,
      ...stopFromAnthropic(stopReason, stopDetails),
      usage: usageFromAnthropic(usage as unknown as Anthropic.Usage),
      providerRaw: finalMessage,
    };
    const response = finalizeResponse(ctx, built, parsed);
    yield { type: "message_end", response };
    return response;
  }
}

function blockFromAnthropic(b: Anthropic.ContentBlock, model: string): AssistantContentBlock {
  const native = { provider: "anthropic" as const, model, data: b };
  switch (b.type) {
    case "text": {
      const block: TextBlock = { type: "text", text: b.text, native };
      return block;
    }
    case "tool_use": {
      const input = asRecord(b.input);
      const block: ToolUseBlock = { type: "tool_use", id: b.id, name: b.name, input, native };
      if (typeof b.input !== "object" || b.input === null || Array.isArray(b.input)) block.inputError = "tool input is not a JSON object";
      return block;
    }
    case "thinking": {
      const block: ReasoningBlock = { type: "reasoning", kind: "thinking", native };
      if (b.thinking.length > 0) block.text = b.thinking;
      return block;
    }
    default:
      // redacted_thinking, server tool blocks, fallback markers, ...: opaque, replayed verbatim.
      return { type: "reasoning", kind: b.type, native };
  }
}

function stopFromAnthropic(
  stop: Anthropic.StopReason | null,
  details: Anthropic.RefusalStopDetails | null | undefined,
): { stopReason: StopReason; providerStopReason: string | null; refusal?: { category: string | null; explanation: string | null } } {
  const map: Record<string, StopReason> = {
    end_turn: "end_turn",
    stop_sequence: "end_turn",
    tool_use: "tool_use",
    max_tokens: "max_tokens",
    model_context_window_exceeded: "max_tokens",
    pause_turn: "pause",
    refusal: "refusal",
  };
  const stopReason = stop === null ? "error" : (map[stop] ?? "error");
  if (stopReason === "refusal") {
    const d = asRecord(details);
    return {
      stopReason,
      providerStopReason: stop,
      refusal: {
        category: typeof d["category"] === "string" ? d["category"] : null,
        explanation: typeof d["explanation"] === "string" ? d["explanation"] : null,
      },
    };
  }
  return { stopReason, providerStopReason: stop };
}

export function usageFromAnthropic(u: Anthropic.Usage | undefined): Usage {
  const usage = asRecord(u);
  const creation = asRecord(usage["cache_creation"]);
  const details = asRecord(usage["output_tokens_details"]);
  return {
    inputTokens: num(usage["input_tokens"]),
    outputTokens: num(usage["output_tokens"]),
    cacheReadTokens: num(usage["cache_read_input_tokens"]),
    cacheWriteTokens: num(usage["cache_creation_input_tokens"]),
    cacheWrite1hTokens: num(creation["ephemeral_1h_input_tokens"]),
    reasoningTokens: num(details["thinking_tokens"]),
  };
}
