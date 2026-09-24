import { GatewayError } from "../errors.js";
import { computeCostUsd } from "../pricing.js";
import type { ModelProfile } from "../profile.js";
import type { TransportOperation } from "../transport/transport.js";
import {
  REASONING_EFFORTS,
  type AssistantContentBlock,
  type ChatRequest,
  type ChatResponse,
  type ImageBlock,
  type Message,
  type Provider,
  type ReasoningEffort,
  type RefusalInfo,
  type StopReason,
  type StreamEvent,
  type ToolUseBlock,
  type Usage,
} from "../types.js";

export interface AdapterContext {
  profile: ModelProfile;
  request: ChatRequest;
  /** Resolved (defaulted + clamped) max output tokens. */
  maxOutputTokens: number;
  /** Clock used for dated pricing. */
  now: Date;
}

export interface BuiltRequest {
  operation: TransportOperation;
  /** Exact provider request body (the SDK method's first argument, minus `stream`). */
  payload: Record<string, unknown>;
  /** Extra fields for streaming calls (merged by the transport). */
  streamExtras?: Record<string, unknown>;
  endpoint?: string;
  /** Use the streaming transport even for `chat()`. */
  preferStream: boolean;
  warnings: string[];
}

/** Everything an adapter extracted from the provider response; the gateway-facing ChatResponse is derived from it. */
export interface ParsedResponse {
  id: string;
  providerModel: string;
  content: AssistantContentBlock[];
  stopReason: StopReason;
  providerStopReason: string | null;
  refusal?: RefusalInfo;
  usage: Usage;
  /** USD cost reported by the provider itself (OpenRouter `usage.cost`), when trusted by the profile. */
  providerCostUsd?: number;
  warnings?: string[];
  providerRaw: unknown;
}

/**
 * A provider adapter is pure mapping code: unified request -> provider payload, provider response/events -> unified
 * response/events. It never performs I/O; the gateway pairs it with a transport.
 */
export interface ProviderAdapter {
  readonly provider: Provider;
  buildRequest(ctx: AdapterContext): BuiltRequest;
  parseResponse(raw: unknown, ctx: AdapterContext, built: BuiltRequest): ChatResponse;
  parseStream(events: AsyncIterable<unknown>, ctx: AdapterContext, built: BuiltRequest): AsyncGenerator<StreamEvent, ChatResponse>;
}

// ------------------------------------------------------------------------------------------------ shared helpers

export function finalizeResponse(ctx: AdapterContext, built: BuiltRequest, parsed: ParsedResponse): ChatResponse {
  const content = guardUnsafeToolCalls(parsed.content, parsed.stopReason);
  const providerCost = parsed.providerCostUsd;
  const response: ChatResponse = {
    id: parsed.id,
    provider: ctx.profile.provider,
    model: ctx.profile.id,
    providerModel: parsed.providerModel,
    message: { role: "assistant", content, producedBy: { provider: ctx.profile.provider, model: ctx.profile.id } },
    stopReason: parsed.stopReason,
    providerStopReason: parsed.providerStopReason,
    usage: parsed.usage,
    costUsd: providerCost ?? computeCostUsd(ctx.profile, parsed.usage, ctx.now),
    costSource: providerCost === undefined ? "profile" : "provider",
    warnings: [...built.warnings, ...(parsed.warnings ?? [])],
    providerRaw: parsed.providerRaw,
    billing: ctx.profile.billing,
  };
  if (parsed.refusal !== undefined) response.refusal = parsed.refusal;
  return response;
}

/**
 * A tool call cut off by `max_tokens` usually still parses as a valid (partial) object, and a refusal can cut a
 * tool call mid-input. Mark those calls so the orchestrator never executes them (Anthropic tool-use guidance; the
 * same failure modes exist on every provider).
 */
function guardUnsafeToolCalls(content: AssistantContentBlock[], stop: StopReason): AssistantContentBlock[] {
  if (stop !== "max_tokens" && stop !== "refusal" && stop !== "error") return content;
  const reason =
    stop === "max_tokens"
      ? "tool input may be truncated (stopped at max_tokens); retry with a higher maxOutputTokens"
      : `turn ended with stop reason '${stop}'; do not execute this call`;
  return content.map((b) => (b.type === "tool_use" && b.inputError === undefined ? { ...b, inputError: reason } : b));
}

/** Resolve the effort for a request: explicit, else profile default; clamp unsupported levels with a warning. */
export function resolveEffort(ctx: AdapterContext, warnings: string[]): ReasoningEffort | undefined {
  const requested = ctx.request.reasoning?.effort ?? ctx.profile.reasoning.defaultEffort;
  if (requested === undefined) return undefined;
  const supported = ctx.profile.reasoning.efforts;
  if (supported.length === 0) {
    warnings.push(`${ctx.profile.id}: reasoning effort '${requested}' ignored (model has no effort control)`);
    return undefined;
  }
  if (supported.includes(requested)) return requested;
  const rank = REASONING_EFFORTS.indexOf(requested);
  const below = supported.filter((e) => REASONING_EFFORTS.indexOf(e) <= rank);
  const clamped = below.at(-1) ?? supported[0];
  if (clamped === undefined) return undefined;
  warnings.push(`${ctx.profile.id}: reasoning effort '${requested}' not supported, using '${clamped}'`);
  return clamped;
}

export function mappedEffort(ctx: AdapterContext, effort: ReasoningEffort): string {
  return ctx.profile.reasoning.effortMap?.[effort] ?? effort;
}

/** Map tool_use ids to tool names across the history (Gemini's functionResponse needs the name). */
export function toolNamesById(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_use") names.set(b.id, b.name);
  }
  return names;
}

export function checkImage(ctx: AdapterContext, image: ImageBlock, where: string): void {
  const caps = ctx.profile.capabilities;
  if (!caps.vision) {
    throw new GatewayError("unsupported_input", `${ctx.profile.id} does not accept images (${where})`, { provider: ctx.profile.provider });
  }
  if (image.source.type === "url" && !caps.images.urlSource) {
    throw new GatewayError(
      "unsupported_input",
      `${ctx.profile.id} does not accept image URLs (${where}); send base64 data instead`,
      { provider: ctx.profile.provider },
    );
  }
  if (image.source.type === "base64" && !caps.images.formats.includes(image.source.mediaType)) {
    throw new GatewayError(
      "unsupported_input",
      `${ctx.profile.id} does not accept ${image.source.mediaType} (${where}); supported: ${caps.images.formats.join(", ")}`,
      { provider: ctx.profile.provider },
    );
  }
}

export function imageUrl(image: ImageBlock): string {
  return image.source.type === "url" ? image.source.url : `data:${image.source.mediaType};base64,${image.source.data}`;
}

/** Strict parse of tool arguments into a JSON object. */
export function parseToolArguments(raw: string): { input: Record<string, unknown>; error?: string } {
  if (raw.trim() === "") return { input: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return { input: value as Record<string, unknown> };
    return { input: {}, error: "tool arguments are not a JSON object" };
  } catch (e) {
    return { input: {}, error: `tool arguments are not valid JSON: ${(e as Error).message}` };
  }
}

export function toolUseFromArgs(
  base: Omit<ToolUseBlock, "type" | "input" | "inputError" | "rawInput">,
  raw: string,
): ToolUseBlock {
  const parsed = parseToolArguments(raw);
  const block: ToolUseBlock = { type: "tool_use", ...base, input: parsed.input };
  if (parsed.error !== undefined) {
    block.inputError = parsed.error;
    block.rawInput = raw;
  }
  return block;
}

export function textOfToolResult(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Count provider-native reasoning blocks from other providers that cannot be replayed, for a single warning. */
export function foreignReasoningWarning(provider: Provider, dropped: Map<string, number>): string[] {
  if (dropped.size === 0) return [];
  const parts = [...dropped.entries()].map(([p, n]) => `${n} from ${p}`);
  return [`${provider}: dropped reasoning blocks produced by another provider (${parts.join(", ")}); they cannot be replayed cross-provider`];
}

export function noteDropped(dropped: Map<string, number>, provider: string): void {
  dropped.set(provider, (dropped.get(provider) ?? 0) + 1);
}
