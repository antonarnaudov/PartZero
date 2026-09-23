import { z } from "zod";
import { GatewayError } from "./errors.js";
import type { ModelRef } from "./types.js";

/**
 * Model profiles are DATA. Everything provider- or model-specific that an adapter needs to decide lives here, so a new
 * model (or a pricing change) is a config change, not a code change. Built-in profiles are in `builtin-profiles.ts`;
 * any field can be overridden from a JSON config file (see `config.ts`).
 */

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const ttl = z.enum(["5m", "1h"]);
const provider = z.enum(["anthropic", "openai", "google", "openai-compat"]);
const imageMediaType = z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]);

const priceTable = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cacheReadPerMTok: z.number().nonnegative(),
  /** 5-minute (Anthropic) or default (OpenAI explicit) cache-write price. */
  cacheWritePerMTok: z.number().nonnegative(),
  cacheWrite1hPerMTok: z.number().nonnegative().optional(),
});

export const pricingSchema = priceTable.extend({
  /** Whole-request surcharge once the prompt exceeds a threshold (OpenAI >272K, Gemini Pro >200K). */
  longContext: z
    .object({
      thresholdInputTokens: z.number().int().positive(),
      inputMultiplier: z.number().positive(),
      outputMultiplier: z.number().positive(),
      cacheMultiplier: z.number().positive(),
    })
    .optional(),
  /** Dated price changes (e.g. introductory pricing that ends). The latest entry with `effectiveFrom <= now` wins. */
  schedule: z.array(priceTable.extend({ effectiveFrom: z.string() })).optional(),
  /** Where the numbers come from. */
  source: z.string(),
});

export const reasoningStyle = z.enum([
  /** `thinking: {type: "adaptive"}` + `output_config.effort` (Claude Opus 5.x, Fable 5.1, Sonnet 5). */
  "anthropic-adaptive",
  /** `thinking: {type: "enabled", budget_tokens}` (Claude Haiku 4.5). */
  "anthropic-budget",
  /** Responses API `reasoning.effort`. */
  "openai-effort",
  /** `thinkingConfig.thinkingLevel` (Gemini 3.x). */
  "google-thinking-level",
  /** Chat Completions `reasoning_effort` (vLLM, Ollama, most OpenAI-compatible servers). */
  "compat-reasoning-effort",
  /** OpenRouter `reasoning: {effort}`. */
  "compat-openrouter",
  "none",
]);

export const modelProfileSchema = z.object({
  /** Registry key; what callers pass as `ChatRequest.model`. */
  id: z.string().min(1),
  provider,
  /** Model id sent to the provider API. */
  apiModelId: z.string().min(1),
  /** Organization that trained the model (`anthropic`, `openai`, `google`, `meta`, ...). */
  vendor: z.string().min(1),
  /** Model family/line used by the cross-family judge rule (`claude-opus`, `claude-fable`, `gpt-6`, `gemini-flash`, ...). */
  family: z.string().min(1),
  displayName: z.string(),
  contextWindow: z.number().int().positive(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive(),
  defaultMaxOutputTokens: z.number().int().positive(),
  pricing: pricingSchema,
  capabilities: z.object({
    vision: z.boolean(),
    tools: z.boolean(),
    strictTools: z.boolean(),
    /** How `ToolDef.strict` is honored. */
    strictToolsVia: z.enum(["tool-flag", "validated-mode", "none"]),
    /** Whether the model accepts forced tool choice (`any`/`tool`/`required`). The gateway never sends it; informational. */
    forcedToolChoice: z.boolean(),
    parallelToolCalls: z.boolean(),
    /** Can parallel tool calls be switched off by the request? */
    parallelToolCallsToggle: z.boolean(),
    /** How images inside tool results are delivered. */
    toolResultImages: z.enum(["native", "user_followup", "none"]),
    images: z.object({
      formats: z.array(imageMediaType),
      urlSource: z.boolean(),
      maxLongEdgePx: z.number().int().positive().optional(),
      /** Detail sent when an image block has none (OpenAI: GPT-6 treats `auto` as `original`, up to 30,000 patches). */
      defaultDetail: z.enum(["low", "high", "auto", "original"]).optional(),
      /** Conservative per-image token estimate used for budget projection only. */
      estimatedTokensPerImage: z.number().int().positive(),
    }),
    caching: z.object({
      style: z.enum(["anthropic-breakpoints", "openai-explicit", "openai-implicit", "google-implicit", "none"]),
      minCacheableTokens: z.number().int().positive().optional(),
      maxBreakpoints: z.number().int().nonnegative(),
      ttls: z.array(ttl),
    }),
    /** Always use the streaming transport (avoids SDK HTTP timeouts on long outputs; keeps tool bytes stable). */
    alwaysStream: z.boolean(),
    /** Anthropic `eager_input_streaming` on client tools when streaming. */
    eagerInputStreaming: z.boolean(),
    /** Whether non-default sampling parameters are accepted. The gateway never sends them; informational. */
    samplingParams: z.boolean(),
  }),
  reasoning: z.object({
    style: reasoningStyle,
    /** Unified efforts the model accepts natively; others are clamped to the nearest supported level with a warning. */
    efforts: z.array(effort),
    /** Effort sent when the request does not specify one. Omitted = let the provider default apply. */
    defaultEffort: effort.optional(),
    /** Provider value for each unified effort, when it differs from the unified name. */
    effortMap: z.partialRecord(effort, z.string()).optional(),
    /** `anthropic-budget` style: `budget_tokens` per effort. */
    budgetTokens: z.partialRecord(effort, z.number().int().positive()).optional(),
    /** Can reasoning be turned off entirely? */
    canDisable: z.boolean(),
    summaries: z.boolean(),
    /** Must provider reasoning payloads be replayed on later turns (tool loops)? */
    replay: z.enum(["required", "recommended", "none"]),
  }),
  /** Which prompt variant (role prompts, DSL reference phrasing) the agent should load for this model. */
  promptVariant: z.string(),
  /** How tool JSON Schemas are rewritten for this model. */
  toolSchemaStyle: z.enum(["anthropic", "openai-strict", "google", "openai-compat"]),
  /** Known quirks, one sentence each, with the doc they come from. */
  quirks: z.array(z.string()),
  dataRetention: z.string().optional(),
  /** OpenAI-compatible endpoint settings (provider `openai-compat` only). */
  compat: z
    .object({
      baseURL: z.string().optional(),
      /** Env var holding the API key (e.g. `OPENROUTER_API_KEY`). Local servers usually need none. */
      apiKeyEnv: z.string().optional(),
      maxTokensParam: z.enum(["max_tokens", "max_completion_tokens"]),
      /** Assistant-message fields carrying reasoning (`reasoning_content`, `reasoning`, `reasoning_details`). */
      reasoningFields: z.array(z.string()),
      /** Send those fields back unchanged on later turns (OpenRouter requires this for tool loops). */
      replayReasoningFields: z.boolean(),
      /** Use `usage.cost` (USD) reported by the endpoint instead of the pricing table (OpenRouter). */
      providerReportsCost: z.boolean(),
      /** Send `stream_options: {include_usage: true}` when streaming. */
      streamUsage: z.boolean(),
    })
    .optional(),
  verification: z.object({
    /** Docs consulted. */
    sources: z.array(z.string()),
    /** Field paths confirmed against those docs. */
    verified: z.array(z.string()),
    /** Field paths that are estimates, derived values or our own tuning. */
    unverified: z.array(z.string()),
    asOf: z.string(),
  }),
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type Pricing = z.infer<typeof pricingSchema>;
export type ReasoningStyle = z.infer<typeof reasoningStyle>;

/** A JSON override: any subset of profile fields (deep-merged), optionally based on another profile. */
export type ProfileOverride = { extends?: string } & Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge key-wise, arrays and scalars replace. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out as T;
}

export class ProfileRegistry {
  readonly #profiles = new Map<string, ModelProfile>();

  constructor(profiles: readonly ModelProfile[] = []) {
    for (const p of profiles) this.register(p);
  }

  register(profile: ModelProfile): void {
    const parsed = modelProfileSchema.safeParse(profile);
    if (!parsed.success) {
      throw new GatewayError("config", `Invalid model profile '${profile.id}': ${z.prettifyError(parsed.error)}`);
    }
    this.#profiles.set(parsed.data.id, parsed.data);
  }

  /**
   * Apply JSON overrides. An override for an existing id deep-merges into it; a new id must either `extends` an
   * existing profile or be a complete profile. The merged result is validated.
   */
  applyOverrides(overrides: Record<string, ProfileOverride>): void {
    for (const [id, override] of Object.entries(overrides)) {
      const { extends: parentId, ...fields } = override;
      const base = this.#profiles.get(id) ?? (parentId === undefined ? undefined : this.#profiles.get(parentId));
      if (parentId !== undefined && !this.#profiles.has(parentId)) {
        throw new GatewayError("config", `Profile '${id}' extends unknown profile '${parentId}'`);
      }
      const merged = base === undefined ? { ...fields, id } : deepMerge(base, { ...fields, id });
      this.register(merged as ModelProfile);
    }
  }

  get(id: ModelRef): ModelProfile {
    const p = this.#profiles.get(id);
    if (p === undefined) {
      throw new GatewayError("unknown_model", `No model profile '${id}'. Known: ${[...this.#profiles.keys()].join(", ")}`);
    }
    return p;
  }

  has(id: ModelRef): boolean {
    return this.#profiles.has(id);
  }

  list(): ModelProfile[] {
    return [...this.#profiles.values()];
  }
}
