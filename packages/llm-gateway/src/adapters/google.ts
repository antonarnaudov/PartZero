import type {
  Content,
  FunctionCallingConfigMode,
  FunctionDeclaration,
  FunctionResponse,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
  PartMediaResolutionLevel,
  ThinkingConfig,
  ThinkingLevel,
} from "@google/genai";
import { GatewayError } from "../errors.js";
import { toGoogleSchema } from "../schema.js";
import type {
  AssistantContentBlock,
  ChatResponse,
  ImageBlock,
  NativePayload,
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
  mappedEffort,
  noteDropped,
  num,
  resolveEffort,
  textOfToolResult,
  toolNamesById,
  type AdapterContext,
  type BuiltRequest,
  type ProviderAdapter,
} from "./adapter.js";

/**
 * Dummy signature for function calls that Gemini did not produce (history from another model or injected calls).
 * Documented in generate-content/thought-signatures.md -> FAQ 1.
 */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

/** Prefix for call ids we synthesize when Gemini returns a functionCall without an `id`. */
const SYNTH_ID_PREFIX = "gemini-call-";

const MEDIA_RESOLUTION: Record<string, PartMediaResolutionLevel> = {
  low: "MEDIA_RESOLUTION_LOW" as PartMediaResolutionLevel,
  high: "MEDIA_RESOLUTION_HIGH" as PartMediaResolutionLevel,
  original: "MEDIA_RESOLUTION_HIGH" as PartMediaResolutionLevel,
};

/**
 * Gemini generateContent adapter (@google/genai `ai.models.generateContent` / `generateContentStream`).
 *
 * generateContent is Google's recommended path for production (the Interactions API is in beta). Thought signatures
 * are handled the way the SDK's own chat history does it: every part the model returned is kept, unmerged and in
 * order, and replayed unchanged (generate-content/thought-signatures.md). Unified text/reasoning blocks group runs of
 * parts; each block carries its raw parts in `native.data`.
 */
export class GoogleAdapter implements ProviderAdapter {
  readonly provider = "google" as const;

  buildRequest(ctx: AdapterContext): BuiltRequest {
    const { profile, request } = ctx;
    const warnings: string[] = [];
    if (request.cache?.system === true || request.cache?.tools === true || hasBreakpoints(ctx)) {
      warnings.push(`${profile.id}: explicit cache breakpoints ignored (Gemini generateContent uses implicit caching)`);
    }
    const names = toolNamesById(request.messages);
    const contents: Content[] = [];
    const dropped = new Map<string, number>();

    for (const m of request.messages) {
      if (m.role === "user") {
        const parts: Part[] = [];
        // All functionResponse parts first (parallel calls: FC1, FC2, then FR1, FR2 - never interleaved).
        for (const b of m.content) if (b.type === "tool_result") parts.push({ functionResponse: this.#functionResponse(ctx, b, names) });
        for (const b of m.content) {
          if (b.type === "text") parts.push({ text: b.text });
          else if (b.type === "image") parts.push(this.#imagePart(ctx, b));
        }
        if (parts.length > 0) contents.push({ role: "user", parts });
      } else {
        const parts: Part[] = [];
        let foreignCallNeedsSignature = true;
        for (const b of m.content) {
          if (b.native?.provider === "google") {
            const nativeParts = b.native.data as Part[];
            if (nativeParts.some((p) => p.functionCall !== undefined && p.thoughtSignature !== undefined)) foreignCallNeedsSignature = false;
            parts.push(...nativeParts);
          } else if (b.type === "text") {
            parts.push({ text: b.text });
          } else if (b.type === "tool_use") {
            const call: Part = { functionCall: { name: b.name, args: b.input, ...(b.id.startsWith(SYNTH_ID_PREFIX) ? {} : { id: b.id }) } };
            // Gemini 3 validates a signature on the first functionCall of each step; foreign calls have none.
            if (foreignCallNeedsSignature) {
              call.thoughtSignature = SKIP_THOUGHT_SIGNATURE;
              foreignCallNeedsSignature = false;
            }
            parts.push(call);
          } else {
            noteDropped(dropped, b.native.provider);
          }
        }
        if (parts.length > 0) contents.push({ role: "model", parts });
      }
    }
    warnings.push(...foreignReasoningWarning("google", dropped));

    const config: GenerateContentConfig = { maxOutputTokens: ctx.maxOutputTokens };
    const system = request.system ?? [];
    if (system.length > 0) config.systemInstruction = { parts: system.map((s) => ({ text: s.text })) };

    const tools = request.tools ?? [];
    if (tools.length > 0) {
      const declarations = tools.map(
        (t): FunctionDeclaration => ({ name: t.name, description: t.description, parametersJsonSchema: toGoogleSchema(t.name, t.inputSchema) }),
      );
      config.tools = [{ functionDeclarations: declarations }];
      const wantsValidated = tools.some((t) => t.strict === true) && profile.capabilities.strictToolsVia === "validated-mode";
      const mode = request.toolChoice === "none" ? "NONE" : wantsValidated ? "VALIDATED" : "AUTO";
      config.toolConfig = { functionCallingConfig: { mode: mode as FunctionCallingConfigMode } };
      if (request.parallelToolCalls === false) warnings.push(`${profile.id}: parallel function calls cannot be disabled on Gemini`);
    }

    const effort = resolveEffort(ctx, warnings);
    const summary = request.reasoning?.summary === true && profile.reasoning.summaries;
    if (profile.reasoning.style === "google-thinking-level" && (effort !== undefined || summary)) {
      const thinking: ThinkingConfig = {};
      if (effort !== undefined) thinking.thinkingLevel = mappedEffort(ctx, effort) as ThinkingLevel;
      if (summary) thinking.includeThoughts = true;
      config.thinkingConfig = thinking;
    }

    const payload: GenerateContentParameters = { model: profile.apiModelId, contents, config };
    const extra = request.providerOptions?.google?.extra;
    const body: Record<string, unknown> = extra === undefined ? { ...payload } : { ...payload, config: { ...config, ...extra } };
    return { operation: "google.models.generateContent", payload: body, preferStream: request.stream === true || profile.capabilities.alwaysStream, warnings };
  }

  #imagePart(ctx: AdapterContext, image: ImageBlock): Part {
    checkImage(ctx, image, "user message");
    if (image.source.type !== "base64") throw new GatewayError("unsupported_input", "gemini: image URLs unsupported", { provider: "google" });
    const part: Part = { inlineData: { mimeType: image.source.mediaType, data: image.source.data } };
    const level = MEDIA_RESOLUTION[image.detail ?? ctx.profile.capabilities.images.defaultDetail ?? "auto"];
    if (level !== undefined) part.mediaResolution = { level };
    return part;
  }

  #functionResponse(ctx: AdapterContext, r: ToolResultBlock, names: Map<string, string>): FunctionResponse {
    const name = r.toolName ?? names.get(r.toolUseId);
    if (name === undefined) {
      throw new GatewayError("invalid_request", `gemini: tool result ${r.toolUseId} has no name and no matching tool_use in history`, {
        provider: "google",
      });
    }
    const text = textOfToolResult(r.content);
    // FunctionResponse.response: "output" for results, "error" for failures (SDK type docs).
    const response: Record<string, unknown> = r.isError === true ? { error: text } : { output: text };
    const fr: FunctionResponse = { name, response };
    if (!r.toolUseId.startsWith(SYNTH_ID_PREFIX)) fr.id = r.toolUseId;
    if (typeof r.content !== "string") {
      const images = r.content.filter((c): c is ImageBlock => c.type === "image");
      if (images.length > 0) {
        if (ctx.profile.capabilities.toolResultImages !== "native") {
          throw new GatewayError("unsupported_input", `${ctx.profile.id}: images in tool results are not supported`, { provider: "google" });
        }
        fr.parts = images.map((img, i) => {
          checkImage(ctx, img, `tool result ${r.toolUseId}`);
          if (img.source.type !== "base64") throw new GatewayError("unsupported_input", "gemini: tool-result images must be base64", { provider: "google" });
          const ext = img.source.mediaType.split("/")[1] ?? "bin";
          return { inlineData: { mimeType: img.source.mediaType, data: img.source.data, displayName: `${r.toolUseId}-image-${i + 1}.${ext}` } };
        });
        // Reference each image once from the structured response ({"$ref": displayName}).
        response["images"] = fr.parts.map((p) => ({ $ref: p.inlineData?.displayName }));
      }
    }
    return fr;
  }

  parseResponse(raw: unknown, ctx: AdapterContext, built: BuiltRequest): ChatResponse {
    const response = raw as GenerateContentResponse;
    const grouper = new PartGrouper(ctx.profile.id);
    const candidate = response.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) drain(grouper.push(part));
    drain(grouper.close());
    return finalizeResponse(ctx, built, {
      id: response.responseId ?? "",
      providerModel: response.modelVersion ?? ctx.profile.apiModelId,
      content: grouper.blocks,
      ...stopFromGoogle(response, grouper.blocks),
      usage: usageFromGoogle(response),
      providerRaw: response,
    });
  }

  async *parseStream(events: AsyncIterable<unknown>, ctx: AdapterContext, built: BuiltRequest): AsyncGenerator<StreamEvent, ChatResponse> {
    const grouper = new PartGrouper(ctx.profile.id);
    let last: GenerateContentResponse | undefined;
    let id = "";
    let providerModel = ctx.profile.apiModelId;
    let started = false;
    for await (const raw of events) {
      const chunk = raw as GenerateContentResponse;
      if (!started) {
        started = true;
        yield { type: "message_start", provider: "google", model: ctx.profile.id, providerModel: chunk.modelVersion ?? providerModel };
      }
      if (chunk.responseId !== undefined) id = chunk.responseId;
      if (chunk.modelVersion !== undefined) providerModel = chunk.modelVersion;
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) yield* grouper.push(part);
      if (chunk.usageMetadata !== undefined) yield { type: "usage", usage: usageFromGoogle(chunk) };
      last = chunk;
    }
    if (last === undefined) throw new GatewayError("connection", "gemini: empty stream", { provider: "google", retryable: true });
    yield* grouper.close();
    const response = finalizeResponse(ctx, built, {
      id,
      providerModel,
      content: grouper.blocks,
      ...stopFromGoogle(last, grouper.blocks),
      usage: usageFromGoogle(last),
      providerRaw: { ...last, candidates: [{ ...(last.candidates?.[0] ?? {}), content: { role: "model", parts: grouper.allParts } }] },
    });
    yield { type: "message_end", response };
    return response;
  }
}

function hasBreakpoints(ctx: AdapterContext): boolean {
  if ((ctx.request.system ?? []).some((s) => s.cacheBreakpoint === true)) return true;
  return ctx.request.messages.some((m) => m.content.some((b) => "cacheBreakpoint" in b && b.cacheBreakpoint === true));
}

/**
 * Groups streamed/returned parts into unified blocks without ever merging parts: consecutive text parts form one
 * text block, consecutive thought parts one reasoning block, each functionCall its own tool_use block. A part that
 * only carries a thoughtSignature attaches to the block it follows. Streaming and non-streaming use the same rules,
 * so stream event indices match the final `message.content`.
 */
class PartGrouper {
  readonly blocks: AssistantContentBlock[] = [];
  readonly allParts: Part[] = [];
  #open: { kind: "text" | "thought"; index: number; parts: Part[] } | undefined;
  #calls = 0;
  readonly #model: string;

  constructor(model: string) {
    this.#model = model;
  }

  #native(parts: Part[]): NativePayload {
    return { provider: "google", model: this.#model, data: parts };
  }

  *push(part: Part): Generator<StreamEvent> {
    const isSignatureOnly = part.thoughtSignature !== undefined && part.functionCall === undefined && (part.text === undefined || part.text === "");
    if (part.functionCall === undefined && part.text === "" && part.thoughtSignature === undefined) return; // empty chunk part
    this.allParts.push(part);

    if (isSignatureOnly) {
      const target = this.#open ?? (this.blocks.length > 0 ? { index: this.blocks.length - 1 } : undefined);
      if (target !== undefined) {
        const block = this.blocks[target.index];
        if (block?.native !== undefined) (block.native.data as Part[]).push(part);
        return;
      }
      this.blocks.push({ type: "reasoning", kind: "signature", native: this.#native([part]) });
      return;
    }

    if (part.text !== undefined && part.functionCall === undefined) {
      const kind = part.thought === true ? "thought" : "text";
      if (this.#open?.kind !== kind) {
        yield* this.close();
        const index = this.blocks.length;
        const parts: Part[] = [];
        this.#open = { kind, index, parts };
        if (kind === "text") this.blocks.push({ type: "text", text: "", native: this.#native(parts) });
        else {
          this.blocks.push({ type: "reasoning", kind: "thought", text: "", native: this.#native(parts) });
          yield { type: "reasoning_start", index, kind: "thought" };
        }
      }
      const open = this.#open!;
      open.parts.push(part);
      const block = this.blocks[open.index] as TextBlock | ReasoningBlock;
      block.text = (block.text ?? "") + part.text;
      if (part.text.length > 0) yield kind === "text" ? { type: "text_delta", index: open.index, text: part.text } : { type: "reasoning_delta", index: open.index, text: part.text };
      return;
    }

    yield* this.close();
    const index = this.blocks.length;
    if (part.functionCall !== undefined) {
      this.#calls += 1;
      const fc = part.functionCall;
      const id = fc.id ?? `${SYNTH_ID_PREFIX}${this.#calls}`;
      const name = fc.name ?? "";
      const block: ToolUseBlock = { type: "tool_use", id, name, input: asRecord(fc.args), native: this.#native([part]) };
      this.blocks.push(block);
      yield { type: "tool_use_start", index, id, name };
      yield { type: "tool_use_end", index, id, name, input: block.input };
      return;
    }
    // inlineData, executableCode, codeExecutionResult, ...: opaque, replayed verbatim.
    this.blocks.push({ type: "reasoning", kind: "other", native: this.#native([part]) });
  }

  *close(): Generator<StreamEvent> {
    const open = this.#open;
    this.#open = undefined;
    if (open === undefined) return;
    const block = this.blocks[open.index];
    if (block?.type === "reasoning") {
      if (block.text === "") delete block.text;
      yield { type: "reasoning_end", index: open.index };
    }
  }
}

/** Run a generator for its side effects (non-streaming parse does not need the events). */
function drain(gen: Generator<StreamEvent>): void {
  for (let r = gen.next(); r.done !== true; r = gen.next()) {
    // events are discarded
  }
}

const REFUSAL_FINISH = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"]);

function stopFromGoogle(
  response: GenerateContentResponse,
  blocks: AssistantContentBlock[],
): { stopReason: StopReason; providerStopReason: string | null; refusal?: { category: string | null; explanation: string | null } } {
  const candidate = response.candidates?.[0];
  if (candidate === undefined) {
    const block = response.promptFeedback?.blockReason;
    if (block !== undefined) {
      return {
        stopReason: "refusal",
        providerStopReason: `prompt_blocked:${block}`,
        refusal: { category: block, explanation: response.promptFeedback?.blockReasonMessage ?? null },
      };
    }
    return { stopReason: "error", providerStopReason: null };
  }
  const finish = candidate.finishReason ?? null;
  if (finish === "STOP" || finish === null) {
    return { stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn", providerStopReason: finish };
  }
  if (finish === "MAX_TOKENS") return { stopReason: "max_tokens", providerStopReason: finish };
  if (REFUSAL_FINISH.has(finish)) {
    return { stopReason: "refusal", providerStopReason: finish, refusal: { category: finish, explanation: candidate.finishMessage ?? null } };
  }
  // MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, TOO_MANY_TOOL_CALLS, LANGUAGE, OTHER, ...
  return { stopReason: "error", providerStopReason: finish };
}

export function usageFromGoogle(response: GenerateContentResponse): Usage {
  const u = asRecord(response.usageMetadata);
  const prompt = num(u["promptTokenCount"]) + num(u["toolUsePromptTokenCount"]);
  const cached = num(u["cachedContentTokenCount"]);
  const thoughts = num(u["thoughtsTokenCount"]);
  return {
    // promptTokenCount includes cached tokens; thinking tokens are billed as output ("Output price (including thinking tokens)").
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: num(u["candidatesTokenCount"]) + thoughts,
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: thoughts,
  };
}
