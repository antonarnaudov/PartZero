import type OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import { GatewayError } from "../errors.js";
import { stripOptionalNulls, toOpenAIStrictSchema } from "../schema.js";
import type { AssistantContentBlock, ChatResponse, ImageBlock, StopReason, StreamEvent, ToolResultBlock, Usage } from "../types.js";
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

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type InputContent = OpenAI.Responses.ResponseInputText | OpenAI.Responses.ResponseInputImage;

/**
 * OpenAI Responses API adapter (`openai` SDK, `client.responses.create`).
 *
 * - Stateless (`store: false`): the gateway owns append-only history, so every output item (reasoning items with
 *   `encrypted_content`, messages with `phase`, function calls) is replayed unchanged via the SDK's
 *   `toResponseInputItems` (reasoning.md -> "Preserve reasoning without stored responses").
 * - System prompt as a leading developer message, so explicit cache breakpoints can sit on it (GPT-5.6+ explicit
 *   prompt caching; `instructions` cannot carry breakpoints).
 * - Strict tools rewritten to OpenAI's strict form; `null`s for originally optional fields are stripped on the way back.
 * - Images in tool results use `function_call_output.output` content arrays (`input_image`).
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = "openai" as const;

  buildRequest(ctx: AdapterContext): BuiltRequest {
    const { profile, request } = ctx;
    const warnings: string[] = [];
    const cache = { auto: true, system: true, tools: false, ...request.cache };
    const explicitCaching = profile.capabilities.caching.style === "openai-explicit";
    let breakpoints = 0;
    const mark = <T extends InputContent>(part: T, wanted: boolean | undefined): T => {
      if (!wanted || !explicitCaching) return part;
      breakpoints += 1;
      return { ...part, prompt_cache_breakpoint: { mode: "explicit" } };
    };

    const input: ResponseInputItem[] = [];
    const systemBlocks = request.system ?? [];
    if (systemBlocks.length > 0) {
      input.push({
        type: "message",
        role: "developer",
        content: systemBlocks.map((s, i) =>
          mark<OpenAI.Responses.ResponseInputText>(
            { type: "input_text", text: s.text },
            s.cacheBreakpoint === true || (cache.system && i === systemBlocks.length - 1),
          ),
        ),
      });
    }

    const dropped = new Map<string, number>();
    for (const m of request.messages) {
      if (m.role === "user") {
        for (const b of m.content) if (b.type === "tool_result") input.push(this.#toolOutput(ctx, b, mark));
        const parts: InputContent[] = [];
        for (const b of m.content) {
          if (b.type === "text") parts.push(mark<OpenAI.Responses.ResponseInputText>({ type: "input_text", text: b.text }, b.cacheBreakpoint));
          else if (b.type === "image") parts.push(mark(this.#image(ctx, b, "user message"), b.cacheBreakpoint));
        }
        if (parts.length > 0) input.push({ type: "message", role: "user", content: parts });
      } else {
        for (const b of m.content) {
          if (b.native?.provider === "openai") {
            input.push(...toResponseInputItems([b.native.data as OpenAI.Responses.ResponseOutputItem]));
          } else if (b.type === "text") {
            input.push({ type: "message", role: "assistant", content: b.text });
          } else if (b.type === "tool_use") {
            input.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
          } else {
            noteDropped(dropped, b.native.provider);
          }
        }
      }
    }
    warnings.push(...foreignReasoningWarning("openai", dropped));

    const payload: OpenAI.Responses.ResponseCreateParamsNonStreaming = {
      model: profile.apiModelId,
      input,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: ctx.maxOutputTokens,
    };

    const tools = request.tools ?? [];
    if (tools.length > 0) {
      payload.tools = tools.map((t): OpenAI.Responses.FunctionTool => {
        const strict = t.strict === true && profile.capabilities.strictTools;
        return {
          type: "function",
          name: t.name,
          description: t.description,
          parameters: strict ? toOpenAIStrictSchema(t.name, t.inputSchema) : t.inputSchema,
          // Explicit false: Responses otherwise tries to normalize every schema into strict mode.
          strict,
        };
      });
      payload.tool_choice = request.toolChoice === "none" ? "none" : "auto";
      if (request.parallelToolCalls !== undefined && profile.capabilities.parallelToolCallsToggle) {
        payload.parallel_tool_calls = request.parallelToolCalls;
      }
    }

    const effort = resolveEffort(ctx, warnings);
    const summary = request.reasoning?.summary === true && profile.reasoning.summaries;
    if (profile.reasoning.style === "openai-effort" && (effort !== undefined || summary)) {
      const reasoning: OpenAI.Reasoning = {};
      if (effort !== undefined) reasoning.effort = mappedEffort(ctx, effort) as OpenAI.ReasoningEffort;
      if (summary) reasoning.summary = "auto";
      payload.reasoning = reasoning;
    }

    if (explicitCaching) {
      if (cache.auto || breakpoints > 0) payload.prompt_cache_options = { mode: cache.auto ? "implicit" : "explicit", ttl: "30m" };
      if (breakpoints > profile.capabilities.caching.maxBreakpoints) {
        throw new GatewayError(
          "invalid_request",
          `${profile.id}: ${breakpoints} explicit cache breakpoints requested, max ${profile.capabilities.caching.maxBreakpoints} cache writes`,
          { provider: "openai" },
        );
      }
    }
    if (request.cache?.key !== undefined) payload.prompt_cache_key = request.cache.key;
    if (request.metadata?.userId !== undefined) payload.safety_identifier = request.metadata.userId;
    if (request.metadata?.tags !== undefined) payload.metadata = request.metadata.tags;

    const body: Record<string, unknown> = { ...payload, ...(request.providerOptions?.openai?.extra ?? {}) };
    return { operation: "openai.responses.create", payload: body, preferStream: request.stream === true || profile.capabilities.alwaysStream, warnings };
  }

  #image(ctx: AdapterContext, image: ImageBlock, where: string): OpenAI.Responses.ResponseInputImage {
    checkImage(ctx, image, where);
    return { type: "input_image", image_url: imageUrl(image), detail: image.detail ?? ctx.profile.capabilities.images.defaultDetail ?? "auto" };
  }

  #toolOutput(
    ctx: AdapterContext,
    r: ToolResultBlock,
    mark: <T extends InputContent>(part: T, wanted: boolean | undefined) => T,
  ): OpenAI.Responses.ResponseInputItem.FunctionCallOutput {
    // The Responses API has no is_error flag; say it in the output text.
    const errorPrefix = r.isError === true ? "Error: " : "";
    if (typeof r.content === "string" || r.content.every((c) => c.type === "text")) {
      const text = errorPrefix + textOfToolResult(r.content);
      // A plain string cannot carry a cache breakpoint; use the content-array form only when one is requested.
      if (r.cacheBreakpoint !== true) return { type: "function_call_output", call_id: r.toolUseId, output: text };
      return { type: "function_call_output", call_id: r.toolUseId, output: [mark<OpenAI.Responses.ResponseInputText>({ type: "input_text", text }, true)] };
    }
    const parts: InputContent[] = [];
    if (errorPrefix !== "") parts.push({ type: "input_text", text: "Error:" });
    for (const c of r.content) {
      parts.push(c.type === "text" ? { type: "input_text", text: c.text } : this.#image(ctx, c, `tool result ${r.toolUseId}`));
    }
    const last = parts.length - 1;
    const marked = parts.map((p, i) => (i === last ? mark(p, r.cacheBreakpoint) : p));
    return { type: "function_call_output", call_id: r.toolUseId, output: marked };
  }

  parseResponse(raw: unknown, ctx: AdapterContext, built: BuiltRequest): ChatResponse {
    const response = raw as OpenAI.Responses.Response;
    const schemas = new Map((ctx.request.tools ?? []).filter((t) => t.strict === true).map((t) => [t.name, t.inputSchema]));
    const content: AssistantContentBlock[] = [];
    let refusalText: string | undefined;
    for (const item of response.output) {
      const native = { provider: "openai" as const, model: ctx.profile.id, data: item };
      if (item.type === "message") {
        const text = item.content.map((c) => (c.type === "output_text" ? c.text : "")).join("");
        const refusal = item.content.map((c) => (c.type === "refusal" ? c.refusal : "")).join("");
        if (refusal.length > 0) refusalText = refusal;
        content.push({ type: "text", text: text.length > 0 ? text : refusal, native });
      } else if (item.type === "function_call") {
        const block = toolUseFromArgs({ id: item.call_id, name: item.name, native }, item.arguments);
        const schema = schemas.get(item.name);
        if (schema !== undefined && block.inputError === undefined) block.input = stripOptionalNulls(block.input, schema) as Record<string, unknown>;
        content.push(block);
      } else if (item.type === "reasoning") {
        const summary = item.summary.map((s) => s.text).join("\n\n");
        content.push({ type: "reasoning", kind: "reasoning", ...(summary.length > 0 ? { text: summary } : {}), native });
      } else {
        content.push({ type: "reasoning", kind: item.type, native });
      }
    }
    const stop = stopFromOpenAI(response, content, refusalText);
    return finalizeResponse(ctx, built, {
      id: response.id,
      providerModel: response.model,
      content,
      ...stop,
      usage: usageFromOpenAI(response.usage),
      providerRaw: response,
    });
  }

  async *parseStream(events: AsyncIterable<unknown>, ctx: AdapterContext, built: BuiltRequest): AsyncGenerator<StreamEvent, ChatResponse> {
    let started = false;
    const kinds = new Map<number, { type: string; id?: string; name?: string; args: string }>();
    for await (const raw of events) {
      const event = raw as OpenAI.Responses.ResponseStreamEvent;
      switch (event.type) {
        case "response.created":
          started = true;
          yield { type: "message_start", provider: "openai", model: ctx.profile.id, providerModel: event.response.model };
          break;
        case "response.output_item.added": {
          const item = event.item;
          if (item.type === "function_call") {
            kinds.set(event.output_index, { type: item.type, id: item.call_id, name: item.name, args: "" });
            yield { type: "tool_use_start", index: event.output_index, id: item.call_id, name: item.name };
          } else {
            kinds.set(event.output_index, { type: item.type, args: "" });
            if (item.type === "reasoning") yield { type: "reasoning_start", index: event.output_index, kind: "reasoning" };
          }
          break;
        }
        case "response.output_text.delta":
        case "response.refusal.delta":
          yield { type: "text_delta", index: event.output_index, text: event.delta };
          break;
        case "response.reasoning_summary_text.delta":
          yield { type: "reasoning_delta", index: event.output_index, text: event.delta };
          break;
        case "response.function_call_arguments.delta": {
          const k = kinds.get(event.output_index);
          if (k !== undefined) k.args += event.delta;
          yield { type: "tool_use_input_delta", index: event.output_index, id: k?.id ?? event.item_id, partialJson: event.delta };
          break;
        }
        case "response.output_item.done": {
          const item = event.item;
          if (item.type === "function_call") {
            const parsed = parseToolArguments(item.arguments);
            yield {
              type: "tool_use_end",
              index: event.output_index,
              id: item.call_id,
              name: item.name,
              input: parsed.input,
              ...(parsed.error === undefined ? {} : { inputError: parsed.error }),
            };
          } else if (item.type === "reasoning") {
            yield { type: "reasoning_end", index: event.output_index };
          }
          break;
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          if (!started) yield { type: "message_start", provider: "openai", model: ctx.profile.id, providerModel: event.response.model };
          // The terminal event carries the complete Response object: parse it as the authoritative final state.
          const response = this.parseResponse(event.response, ctx, built);
          yield { type: "usage", usage: response.usage };
          yield { type: "message_end", response };
          return response;
        }
        case "error":
          throw new GatewayError("server_error", `openai: stream error ${event.code ?? ""}: ${event.message}`, {
            provider: "openai",
            retryable: true,
          });
        default:
          break;
      }
    }
    throw new GatewayError("connection", "openai: stream ended without a terminal response event", { provider: "openai", retryable: true });
  }
}

function stopFromOpenAI(
  response: OpenAI.Responses.Response,
  content: AssistantContentBlock[],
  refusalText: string | undefined,
): { stopReason: StopReason; providerStopReason: string | null; refusal?: { category: string | null; explanation: string | null } } {
  const status = response.status ?? null;
  const reason = response.incomplete_details?.reason ?? null;
  if (status === "completed") {
    if (refusalText !== undefined) return { stopReason: "refusal", providerStopReason: "refusal", refusal: { category: null, explanation: refusalText } };
    if (content.some((b) => b.type === "tool_use")) return { stopReason: "tool_use", providerStopReason: status };
    return { stopReason: "end_turn", providerStopReason: status };
  }
  if (status === "incomplete") {
    if (reason === "max_output_tokens") return { stopReason: "max_tokens", providerStopReason: `incomplete:${reason}` };
    if (reason === "content_filter") {
      return { stopReason: "refusal", providerStopReason: `incomplete:${reason}`, refusal: { category: "content_filter", explanation: null } };
    }
    return { stopReason: "error", providerStopReason: `incomplete:${reason ?? "unknown"}` };
  }
  return { stopReason: "error", providerStopReason: status === "failed" ? `failed:${response.error?.code ?? "unknown"}` : status };
}

export function usageFromOpenAI(u: OpenAI.Responses.ResponseUsage | undefined): Usage {
  const usage = asRecord(u);
  const inDetails = asRecord(usage["input_tokens_details"]);
  const outDetails = asRecord(usage["output_tokens_details"]);
  const total = num(usage["input_tokens"]);
  const cached = num(inDetails["cached_tokens"]);
  const written = num(inDetails["cache_write_tokens"]);
  return {
    // input_tokens is the total; cached and cache-write tokens are subsets (prompt-caching.md cost formula).
    inputTokens: Math.max(0, total - cached - written),
    outputTokens: num(usage["output_tokens"]),
    cacheReadTokens: cached,
    cacheWriteTokens: written,
    cacheWrite1hTokens: 0,
    reasoningTokens: num(outDetails["reasoning_tokens"]),
  };
}

