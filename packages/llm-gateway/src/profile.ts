import { z } from "zod";
import { GatewayError } from "./errors.js";
import { PROVIDER_KINDS, type ModelRef, type ProviderKind } from "./types.js";

/**
 * Model profiles are DATA. Everything provider- or model-specific that an adapter needs to decide lives here, so a new
 * model (or a pricing change) is a config change, not a code change. Built-in profiles are in `builtin-profiles.ts`;
 * any field can be overridden from a JSON config file (see `config.ts`).
 */

const effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
const ttl = z.enum(["5m", "1h"]);
const provider = z.enum([
  "anthropic",
  "openai",
  "google",
  "openai-compat",
  "ollama",
  "claude-cli",
  "gemini-cli",
  "codex-cli",
  "opencode",
  "cursor-agent",
]);
const cliAgent = z.enum(["claude", "gemini", "codex", "opencode", "cursor"]);
/** CLI provider id -> the `cli.agent` it must declare. */
const CLI_AGENT_OF: Readonly<Record<string, string>> = {
  "claude-cli": "claude",
  "gemini-cli": "gemini",
  "codex-cli": "codex",
  opencode: "opencode",
  "cursor-agent": "cursor",
};
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
  /** CLI providers: the unified effort maps to a CLI flag through `cli.effortArg` (`--effort`, `model_reasoning_effort`, `--variant`). */
  "cli-effort-flag",
  /** Native Ollama `think` flag (reserved for a native adapter). */
  "ollama-think",
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
      /** `cli-managed`: the CLI places its own cache breakpoints; the gateway has no control. */
      style: z.enum(["anthropic-breakpoints", "openai-explicit", "openai-implicit", "google-implicit", "cli-managed", "none"]),
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
  /** How tool JSON Schemas are rewritten for this model (`cli-envelope`: tools travel inside the turn envelope schema). */
  toolSchemaStyle: z.enum(["anthropic", "openai-strict", "google", "openai-compat", "cli-envelope", "ollama"]),
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
  /**
   * Who pays (ADR 0014): `metered` API keys; `subscription` = the user's CLI plan (pricing is notional);
   * `local` = local compute (cost 0).
   */
  billing: z.enum(["metered", "subscription", "local"]).default("metered"),
  /** CLI providers only (docs/CLI-PROVIDERS.md §7.3). */
  cli: z
    .object({
      agent: cliAgent,
      /**
       * Value for the CLI's model flag (`--model=opus`, `--model=flash`, `--model=provider/model`); null = the CLI's
       * default. Same rule as parse.ts `safeModel`: it may never start with "-" (argv flag injection).
       */
      modelArg: z
        .string()
        .regex(/^(?!-)[\w.:/@-]{1,128}$/, "cli.modelArg must match ^[\\w.:/@-]{1,128}$ and must not start with '-'")
        .nullable(),
      /** Unified effort -> CLI-native value (`--effort`, `model_reasoning_effort`, `--variant`). Never starts with "-". */
      effortArg: z.partialRecord(effort, z.string().regex(/^(?!-)[\w.-]{1,32}$/, "cli.effortArg values are short words and must not start with '-'")).optional(),
      modes: z.array(z.enum(["completion", "runtime"])).min(1),
      envelopeVia: z.enum(["json-schema", "mcp-submit", "text-json"]),
      /** Set for profiles created by model discovery. */
      discoveredAt: z.string().optional(),
    })
    .optional(),
  /** Local model servers (Ollama). Local profiles currently reach the server through its OpenAI-compatible `/v1`. */
  local: z
    .object({
      /** Server root, default `http://127.0.0.1:11434`. */
      baseURL: z.string(),
      /** Model tag, e.g. `qwen3:8b`. */
      tag: z.string(),
      /** Context the server must provide. The `/v1` route cannot set it per request: see the profile quirks. */
      numCtx: z.number().int().positive(),
      keepAlive: z.string().optional(),
      think: z.boolean().optional(),
    })
    .optional(),
}).superRefine((p, ctx) => {
  const kind = PROVIDER_KINDS[p.provider];
  if (kind === "cli") {
    if (p.cli === undefined) ctx.addIssue({ code: "custom", path: ["cli"], message: `provider ${p.provider} needs a 'cli' block` });
    else if (CLI_AGENT_OF[p.provider] !== p.cli.agent) {
      ctx.addIssue({ code: "custom", path: ["cli", "agent"], message: `provider ${p.provider} needs cli.agent '${CLI_AGENT_OF[p.provider]}'` });
    }
    if (p.billing === "local") ctx.addIssue({ code: "custom", path: ["billing"], message: "CLI profiles bill 'subscription' or 'metered'" });
  } else if (p.cli !== undefined) {
    ctx.addIssue({ code: "custom", path: ["cli"], message: `'cli' is only valid for CLI providers, not ${p.provider}` });
  }
  if (p.provider === "ollama" && p.local === undefined) ctx.addIssue({ code: "custom", path: ["local"], message: "provider ollama needs a 'local' block" });
  if (p.local !== undefined && p.billing !== "local") ctx.addIssue({ code: "custom", path: ["billing"], message: "profiles with a 'local' block bill 'local'" });
  if (p.local !== undefined && p.provider !== "ollama" && p.provider !== "openai-compat") {
    ctx.addIssue({ code: "custom", path: ["local"], message: `'local' is only valid for ollama or openai-compat profiles, not ${p.provider}` });
  }
});

export type ModelProfile = z.infer<typeof modelProfileSchema>;

/**
 * (additive) The kind of a PROFILE, for routing, small-model choice and start prechecks (`LOCAL_UNAVAILABLE`): `local`
 * for any profile with a `local` block (Ollama profiles reach the server through `openai-compat`), for provider
 * `ollama` and for `billing: "local"`; otherwise the provider's kind. Hosts must use this instead of testing
 * `provider === "ollama"`, which built-in local profiles never are.
 */
export function profileKind(p: Pick<ModelProfile, "provider" | "local" | "billing">): ProviderKind {
  if (p.local !== undefined || p.provider === "ollama" || p.billing === "local") return "local";
  return PROVIDER_KINDS[p.provider];
}
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
