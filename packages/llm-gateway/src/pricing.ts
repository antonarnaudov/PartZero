import type { ModelProfile, Pricing } from "./profile.js";
import type { ChatRequest, ImageBlock, Message, Usage } from "./types.js";

export interface EffectivePrices {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
  cacheWrite1hPerMTok: number;
}

/** Resolve the price table in force at `now` (dated schedules) without the long-context surcharge. */
export function pricesAt(pricing: Pricing, now: Date): EffectivePrices {
  let table: Omit<Pricing, "longContext" | "schedule" | "source"> = pricing;
  const iso = now.toISOString().slice(0, 10);
  const due = (pricing.schedule ?? []).filter((s) => s.effectiveFrom <= iso).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const latest = due.at(-1);
  if (latest !== undefined) table = latest;
  return {
    inputPerMTok: table.inputPerMTok,
    outputPerMTok: table.outputPerMTok,
    cacheReadPerMTok: table.cacheReadPerMTok,
    cacheWritePerMTok: table.cacheWritePerMTok,
    // Only Anthropic reports 1h writes; other providers never have 1h tokens, so the fallback is never billed.
    cacheWrite1hPerMTok: table.cacheWrite1hPerMTok ?? table.cacheWritePerMTok,
  };
}

/** Total prompt size as the provider counts it for long-context tiers (uncached + cache reads + cache writes). */
export function totalPromptTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** USD cost of a completed call from normalized usage and the model's pricing table. */
export function computeCostUsd(profile: ModelProfile, usage: Usage, now: Date = new Date()): number {
  const p = pricesAt(profile.pricing, now);
  const lc = profile.pricing.longContext;
  const long = lc !== undefined && totalPromptTokens(usage) > lc.thresholdInputTokens;
  const inMul = long ? lc.inputMultiplier : 1;
  const outMul = long ? lc.outputMultiplier : 1;
  const cacheMul = long ? lc.cacheMultiplier : 1;
  const write5m = Math.max(0, usage.cacheWriteTokens - usage.cacheWrite1hTokens);
  const usd =
    usage.inputTokens * p.inputPerMTok * inMul +
    usage.outputTokens * p.outputPerMTok * outMul +
    usage.cacheReadTokens * p.cacheReadPerMTok * cacheMul +
    write5m * p.cacheWritePerMTok * cacheMul +
    usage.cacheWrite1hTokens * p.cacheWrite1hPerMTok * cacheMul;
  return usd / 1_000_000;
}

/**
 * Conservative characters-per-token ratio for budget projection. Current Claude tokenizers produce ~30% more tokens
 * than older ones for the same text, so we assume 3 chars/token (over-estimates tokens, i.e. errs on the safe side).
 */
const CHARS_PER_TOKEN = 3;
/** Per-message and per-tool framing overhead (role markers, JSON keys). */
const MESSAGE_OVERHEAD_TOKENS = 8;

function textTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function imageTokens(_image: ImageBlock, profile: ModelProfile): number {
  return profile.capabilities.images.estimatedTokensPerImage;
}

function messageTokens(message: Message, profile: ModelProfile): number {
  let tokens = MESSAGE_OVERHEAD_TOKENS;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        tokens += textTokens(block.text);
        break;
      case "image":
        tokens += imageTokens(block, profile);
        break;
      case "tool_use":
        tokens += textTokens(block.name) + textTokens(JSON.stringify(block.input));
        break;
      case "tool_result":
        if (typeof block.content === "string") tokens += textTokens(block.content);
        else for (const c of block.content) tokens += c.type === "text" ? textTokens(c.text) : imageTokens(c, profile);
        break;
      case "reasoning":
        // Replayed reasoning is re-rendered server-side (and may be dropped). Heuristic: half the serialized size,
        // since encrypted payloads and signatures are base64 and denser than the tokens they stand for.
        tokens += Math.ceil(textTokens(JSON.stringify(block.native.data ?? "")) / 2);
        break;
    }
  }
  return tokens;
}

/** Upper-bound estimate of the prompt tokens a request will be billed for. */
export function estimateInputTokens(req: ChatRequest, profile: ModelProfile): number {
  let tokens = 0;
  for (const s of req.system ?? []) tokens += textTokens(s.text) + MESSAGE_OVERHEAD_TOKENS;
  for (const t of req.tools ?? []) tokens += textTokens(t.name + t.description + JSON.stringify(t.inputSchema)) + MESSAGE_OVERHEAD_TOKENS;
  for (const m of req.messages) tokens += messageTokens(m, profile);
  return Math.ceil(tokens);
}

export interface CostProjection {
  estimatedInputTokens: number;
  projectedOutputTokens: number;
  projectedUsd: number;
}

/**
 * Worst-case cost of a call: every input token billed at the highest applicable input rate (uncached, or cache
 * write when the provider may write the prefix: 1.25x for 5m / OpenAI, 2x for Anthropic 1h) plus `outputTokens`
 * output tokens. Cache hits only make the real call cheaper.
 */
export function projectCostUsd(
  req: ChatRequest,
  profile: ModelProfile,
  outputTokens: number,
  now: Date = new Date(),
): CostProjection {
  const estimatedInputTokens = estimateInputTokens(req, profile);
  const base: Usage = {
    inputTokens: estimatedInputTokens,
    outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
  };
  let projectedUsd = computeCostUsd(profile, base, now);
  const style = profile.capabilities.caching.style;
  if (style === "anthropic-breakpoints" || style === "openai-explicit") {
    const oneHour = style === "anthropic-breakpoints" && req.cache?.ttl === "1h";
    const allWritten: Usage = {
      ...base,
      inputTokens: 0,
      cacheWriteTokens: estimatedInputTokens,
      cacheWrite1hTokens: oneHour ? estimatedInputTokens : 0,
    };
    projectedUsd = Math.max(projectedUsd, computeCostUsd(profile, allWritten, now));
  }
  return { estimatedInputTokens, projectedOutputTokens: outputTokens, projectedUsd };
}

/** Resolve the effective max output tokens for a request (default from the profile, clamped to its ceiling). */
export function resolveMaxOutputTokens(req: ChatRequest, profile: ModelProfile): number {
  const requested = req.maxOutputTokens ?? profile.defaultMaxOutputTokens;
  return Math.max(1, Math.min(requested, profile.maxOutputTokens));
}
