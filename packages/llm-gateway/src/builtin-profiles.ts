import type { DiscoveredModel } from "./cli/provider.js";
import { profileKind, type ModelProfile } from "./profile.js";
import type { Billing, CliProviderId, ModelRef, Provider, ReasoningEffort } from "./types.js";

/**
 * Built-in model profiles, as of 2026-09-23.
 *
 * Every number here was checked against the source listed in `verification.sources`; anything that is an estimate, a
 * value derived from a documented multiplier, or our own tuning is listed in `verification.unverified`. Only model
 * ids that appear in the providers' current official docs are included. Override any field from a JSON config file.
 */

const AS_OF = "2026-09-23";

const ANTHROPIC_SOURCES = [
  "claude-api skill 2.1.280 shared/models.md",
  "claude-api skill 2.1.280 shared/model-migration.md",
  "claude-api skill 2.1.280 shared/prompt-caching.md",
  "claude-api skill 2.1.280 shared/tool-use-concepts.md",
  "@anthropic-ai/sdk 0.128.0 type definitions",
];

const ANTHROPIC_IMAGE_FORMATS: ModelProfile["capabilities"]["images"]["formats"] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

const anthropicCommonQuirks = [
  "Stream long outputs: SDK HTTP timeouts above ~16K max_tokens (model-migration.md); the gateway always streams Claude.",
  "Prompt cache is a prefix match in render order tools -> system -> messages; max 4 breakpoints (prompt-caching.md).",
  "Handle stop_reason 'refusal' before reading content; stop_details is informational and may be null.",
  "Pass thinking blocks back unchanged, including empty ones; never edit earlier turns (append-only history).",
];

export const BUILTIN_PROFILES: readonly ModelProfile[] = [
  // ---------------------------------------------------------------- Anthropic
  {
    id: "claude-opus-5-5",
    provider: "anthropic",
    billing: "metered",
    apiModelId: "claude-opus-5-5",
    vendor: "anthropic",
    family: "claude-opus",
    displayName: "Claude Opus 5.5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 4,
      outputPerMTok: 20,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 5,
      cacheWrite1hPerMTok: 8,
      source: "model-migration.md 'Migrating to Claude Opus 5.5' -> Pricing",
    },
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "tool-flag",
      forcedToolChoice: false,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "native",
      images: { formats: ANTHROPIC_IMAGE_FORMATS, urlSource: true, estimatedTokensPerImage: 4800 },
      caching: { style: "anthropic-breakpoints", minCacheableTokens: 512, maxBreakpoints: 4, ttls: ["5m", "1h"] },
      alwaysStream: true,
      eagerInputStreaming: true,
      samplingParams: false,
    },
    reasoning: {
      style: "anthropic-adaptive",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      canDisable: false,
      summaries: true,
      replay: "required",
    },
    promptVariant: "claude-5",
    toolSchemaStyle: "anthropic",
    quirks: [
      ...anthropicCommonQuirks,
      "Thinking cannot be disabled: thinking {type: disabled} and budget_tokens both 400; effort is the only control (API default medium).",
      "Forced tool_choice (any/tool) returns 400 -> use auto + strict tools, steer in the prompt, check a call happened.",
      "Thinking blocks are bound to the model and the conversation prefix; only Fable 5.1 / Mythos 5.1 read Opus 5.5 blocks.",
      "Text between tool calls comes back as progress-update thinking blocks (empty under display 'omitted').",
      "Safety classifiers: cyber, bio, reasoning_extraction; reasoning_extraction declines are not retried on fallbacks.",
      "Computer use only via computer_toolset_20260801.",
    ],
    verification: {
      sources: ANTHROPIC_SOURCES,
      verified: [
        "apiModelId",
        "contextWindow",
        "maxOutputTokens",
        "pricing.inputPerMTok",
        "pricing.outputPerMTok",
        "pricing.cacheReadPerMTok",
        "capabilities.forcedToolChoice",
        "capabilities.strictTools",
        "capabilities.caching.minCacheableTokens",
        "capabilities.caching.maxBreakpoints",
        "reasoning.style",
        "reasoning.efforts",
        "reasoning.defaultEffort",
        "reasoning.canDisable",
      ],
      unverified: [
        "pricing.cacheWritePerMTok (docs: derived from 1.25x, 'confirm at launch')",
        "pricing.cacheWrite1hPerMTok (docs: derived from 2x, 'confirm at launch')",
        "capabilities.images.estimatedTokensPerImage (budget estimate)",
        "defaultMaxOutputTokens (docs suggest 64K for long agentic turns; our choice)",
      ],
      asOf: AS_OF,
    },
  },
  {
    id: "claude-fable-5-1",
    provider: "anthropic",
    billing: "metered",
    apiModelId: "claude-fable-5-1",
    vendor: "anthropic",
    family: "claude-fable",
    displayName: "Claude Fable 5.1",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 10,
      outputPerMTok: 50,
      cacheReadPerMTok: 0.25,
      cacheWritePerMTok: 12.5,
      cacheWrite1hPerMTok: 20,
      source: "models.md + model-migration.md 'Migrating to Claude Fable 5.1 from Claude Fable 5' -> Pricing",
    },
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "tool-flag",
      forcedToolChoice: false,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "native",
      images: { formats: ANTHROPIC_IMAGE_FORMATS, urlSource: true, estimatedTokensPerImage: 4800 },
      caching: { style: "anthropic-breakpoints", minCacheableTokens: 512, maxBreakpoints: 4, ttls: ["5m", "1h"] },
      alwaysStream: true,
      eagerInputStreaming: true,
      samplingParams: false,
    },
    reasoning: {
      style: "anthropic-adaptive",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      canDisable: false,
      summaries: true,
      replay: "required",
    },
    promptVariant: "claude-5",
    toolSchemaStyle: "anthropic",
    quirks: [
      ...anthropicCommonQuirks,
      "Thinking always on; any thinking config other than adaptive 400s; no assistant prefill; no sampling params.",
      "Forced tool_choice (any/tool) returns 400 (Messages, Batches and count_tokens).",
      "Thinking blocks readable only by Fable 5.1 / Mythos 5.1; editing earlier turns invalidates later thinking blocks.",
      "Cache reads are 0.025x input ($0.25/MTok): keep the cache warm; a miss costs relatively more.",
      "Turns can run many minutes at higher effort: plan timeouts, streaming and progress UX.",
    ],
    dataRetention: "Covered Model: 30-day retention required; ZDR organizations get 400 invalid_request_error.",
    verification: {
      sources: ANTHROPIC_SOURCES,
      verified: [
        "apiModelId",
        "contextWindow",
        "maxOutputTokens",
        "pricing (all fields)",
        "capabilities.forcedToolChoice",
        "capabilities.caching.minCacheableTokens",
        "reasoning.style",
        "reasoning.canDisable",
        "dataRetention",
      ],
      unverified: [
        "reasoning.defaultEffort (docs recommend 'high' for most tasks; API default not stated)",
        "capabilities.images.estimatedTokensPerImage (budget estimate)",
      ],
      asOf: AS_OF,
    },
  },
  {
    id: "claude-opus-5",
    provider: "anthropic",
    billing: "metered",
    apiModelId: "claude-opus-5",
    vendor: "anthropic",
    family: "claude-opus",
    displayName: "Claude Opus 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 5,
      outputPerMTok: 25,
      cacheReadPerMTok: 0.5,
      cacheWritePerMTok: 6.25,
      cacheWrite1hPerMTok: 10,
      source: "model-migration.md 'Migrating to Claude Opus 5' ($5/$25) + prompt-caching.md multipliers",
    },
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "tool-flag",
      forcedToolChoice: true,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "native",
      images: { formats: ANTHROPIC_IMAGE_FORMATS, urlSource: true, estimatedTokensPerImage: 4800 },
      caching: { style: "anthropic-breakpoints", minCacheableTokens: 512, maxBreakpoints: 4, ttls: ["5m", "1h"] },
      alwaysStream: true,
      eagerInputStreaming: true,
      samplingParams: false,
    },
    reasoning: {
      style: "anthropic-adaptive",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      canDisable: true,
      summaries: true,
      replay: "required",
    },
    promptVariant: "claude-5",
    toolSchemaStyle: "anthropic",
    quirks: [
      ...anthropicCommonQuirks,
      "Thinking on by default; thinking {type: disabled} only at effort high or lower (xhigh/max + disabled = 400).",
      "Raw thinking never returned; display defaults to 'omitted'.",
      "Cyber safety classifiers can return stop_reason 'refusal'.",
    ],
    verification: {
      sources: ANTHROPIC_SOURCES,
      verified: [
        "apiModelId",
        "contextWindow",
        "maxOutputTokens",
        "pricing.inputPerMTok",
        "pricing.outputPerMTok",
        "pricing.cacheReadPerMTok (docs: Fable 5.1 reads are 'half of Claude Opus 5's')",
        "capabilities.forcedToolChoice",
        "capabilities.caching.minCacheableTokens",
        "reasoning.efforts",
        "reasoning.canDisable",
      ],
      unverified: [
        "pricing.cacheWritePerMTok / cacheWrite1hPerMTok (derived from 1.25x / 2x multipliers)",
        "reasoning.defaultEffort (general docs: API default 'high')",
        "capabilities.images.estimatedTokensPerImage (budget estimate)",
      ],
      asOf: AS_OF,
    },
  },
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    billing: "metered",
    apiModelId: "claude-sonnet-5",
    vendor: "anthropic",
    family: "claude-sonnet",
    displayName: "Claude Sonnet 5",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 64_000,
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2.5,
      cacheWrite1hPerMTok: 4,
      source: "product-owner brief ($2/$10) + prompt-caching.md multipliers (0.1x read, 1.25x/2x write)",
    },
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "tool-flag",
      forcedToolChoice: true,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "native",
      images: { formats: ANTHROPIC_IMAGE_FORMATS, urlSource: true, maxLongEdgePx: 2576, estimatedTokensPerImage: 4800 },
      caching: { style: "anthropic-breakpoints", minCacheableTokens: 1024, maxBreakpoints: 4, ttls: ["5m", "1h"] },
      alwaysStream: true,
      eagerInputStreaming: true,
      samplingParams: false,
    },
    reasoning: {
      style: "anthropic-adaptive",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      canDisable: true,
      summaries: true,
      replay: "required",
    },
    promptVariant: "claude-5",
    toolSchemaStyle: "anthropic",
    quirks: [
      ...anthropicCommonQuirks,
      "Adaptive thinking on by default; budget_tokens 400s; non-default sampling params 400.",
      "New tokenizer (~30% more tokens than Sonnet 4.6).",
      "Mid-conversation system messages treated as unsupported (sources conflict) - use top-level system.",
      "Amazon Bedrock only: forced tool_choice requires thinking disabled.",
    ],
    verification: {
      sources: [...ANTHROPIC_SOURCES, "product-owner brief 2026-09-23"],
      verified: [
        "apiModelId",
        "contextWindow",
        "maxOutputTokens",
        "capabilities.images.maxLongEdgePx",
        "capabilities.caching.minCacheableTokens",
        "reasoning.efforts",
        "reasoning.defaultEffort",
      ],
      unverified: [
        "pricing.inputPerMTok / outputPerMTok (from the product-owner brief; not in the local Anthropic docs)",
        "pricing.cache* (derived from documented multipliers)",
        "capabilities.images.estimatedTokensPerImage (budget estimate)",
      ],
      asOf: AS_OF,
    },
  },
  {
    id: "claude-haiku-4-5",
    provider: "anthropic",
    billing: "metered",
    apiModelId: "claude-haiku-4-5",
    vendor: "anthropic",
    family: "claude-haiku",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    defaultMaxOutputTokens: 16_000,
    pricing: {
      inputPerMTok: 1,
      outputPerMTok: 5,
      cacheReadPerMTok: 0.1,
      cacheWritePerMTok: 1.25,
      cacheWrite1hPerMTok: 2,
      source: "product-owner brief ($1/$5) + prompt-caching.md multipliers",
    },
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "tool-flag",
      forcedToolChoice: true,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "native",
      images: { formats: ANTHROPIC_IMAGE_FORMATS, urlSource: true, estimatedTokensPerImage: 1600 },
      caching: { style: "anthropic-breakpoints", minCacheableTokens: 4096, maxBreakpoints: 4, ttls: ["5m", "1h"] },
      alwaysStream: true,
      eagerInputStreaming: true,
      samplingParams: true,
    },
    reasoning: {
      style: "anthropic-budget",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      budgetTokens: { low: 2048, medium: 6144, high: 12288, xhigh: 24576, max: 32768 },
      canDisable: true,
      summaries: true,
      replay: "required",
    },
    promptVariant: "claude-4",
    toolSchemaStyle: "anthropic",
    quirks: [
      ...anthropicCommonQuirks,
      "No effort parameter; extended thinking via thinking {type: enabled, budget_tokens} (>= 1024, < max_tokens).",
      "Streaming output ceiling is 64K (lower than current models' 128K).",
      "Minimum cacheable prefix is 4096 tokens (shorter prefixes silently do not cache).",
      "Previous-turn thinking blocks are stripped when a plain user message follows tool use (messages-cache miss).",
    ],
    verification: {
      sources: [...ANTHROPIC_SOURCES, "product-owner brief 2026-09-23"],
      verified: [
        "apiModelId",
        "contextWindow",
        "maxOutputTokens",
        "capabilities.caching.minCacheableTokens",
        "reasoning.style (effort unsupported on Haiku 4.5; budget_tokens thinking)",
      ],
      unverified: [
        "pricing (product-owner brief + derived cache multipliers)",
        "reasoning.budgetTokens (our tuning: unified effort -> budget_tokens)",
        "capabilities.images.estimatedTokensPerImage (budget estimate)",
        "capabilities.samplingParams",
      ],
      asOf: AS_OF,
    },
  },

  // ---------------------------------------------------------------- OpenAI (Responses API)
  openaiGpt6("gpt-6-astra", "GPT-6 Astra", {
    pricing: { inputPerMTok: 10, outputPerMTok: 50, cacheReadPerMTok: 1, cacheWritePerMTok: 12.5 },
    noneEffort: false,
    defaultEffort: undefined,
    extraQuirks: [
      "reasoning.effort 'none' returns 400 (use 'low').",
      "Tool calling requires the Responses API (Chat Completions does not support function calling on GPT-6 Astra).",
    ],
  }),
  openaiGpt6("gpt-6-sol", "GPT-6 Sol", {
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
    noneEffort: true,
    defaultEffort: "medium",
    extraQuirks: ["Chat Completions supports function calling only with reasoning_effort 'none' - use Responses."],
  }),
  openaiGpt6("gpt-6-luna", "GPT-6 Luna", {
    pricing: { inputPerMTok: 0.1, outputPerMTok: 0.5, cacheReadPerMTok: 0.01, cacheWritePerMTok: 0.125 },
    noneEffort: true,
    defaultEffort: "medium",
    extraQuirks: ["Chat Completions supports function calling only with reasoning_effort 'none' - use Responses."],
  }),

  // ---------------------------------------------------------------- Google (generateContent)
  gemini("gemini-3.8-flash", "Gemini 3.8 Flash", {
    family: "gemini-flash",
    pricing: {
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      cacheReadPerMTok: 0.075,
      cacheWritePerMTok: 0.75,
      schedule: [
        { effectiveFrom: "2027-01-01", inputPerMTok: 1.5, outputPerMTok: 7.5, cacheReadPerMTok: 0.15, cacheWritePerMTok: 1.5 },
      ],
      source: "ai.google.dev/gemini-api/docs/pricing (introductory through 2026-12-31, standard from 2027-01-01)",
    },
    efforts: ["low", "medium", "high"],
    defaultEffort: "medium",
    minCacheableTokens: 4096,
    extraQuirks: [
      "thinkingLevel 'minimal' is not supported and returns an error (default 'medium').",
      "Strip temperature/top_p/top_k and candidate_count (latest-model migration checklist).",
      "Every FunctionResponse must include the call id and name.",
    ],
    verifiedExtra: ["reasoning.defaultEffort", "capabilities.caching.minCacheableTokens", "pricing.schedule"],
  }),
  gemini("gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", {
    family: "gemini-pro",
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 12,
      cacheReadPerMTok: 0.2,
      cacheWritePerMTok: 2,
      longContext: { thresholdInputTokens: 200_000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: 2 },
      source: "ai.google.dev/gemini-api/docs/pricing (<=200k / >200k prompt tiers)",
    },
    efforts: ["low", "medium", "high"],
    defaultEffort: "high",
    minCacheableTokens: 4096,
    extraQuirks: [
      "Preview model. thinkingLevel 'minimal' not supported (default 'high').",
      "A separate endpoint 'gemini-3.1-pro-preview-customtools' prioritizes custom tools (add as a profile override if wanted).",
      "Keep temperature at the default 1.0 (Gemini 3 guide).",
    ],
    verifiedExtra: ["reasoning.defaultEffort", "capabilities.caching.minCacheableTokens", "pricing.longContext"],
  }),
  gemini("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", {
    family: "gemini-flash-lite",
    pricing: {
      inputPerMTok: 0.3,
      outputPerMTok: 2.5,
      cacheReadPerMTok: 0.03,
      cacheWritePerMTok: 0.3,
      source: "ai.google.dev/gemini-api/docs/pricing",
    },
    efforts: ["low", "medium", "high"],
    defaultEffort: undefined,
    minCacheableTokens: undefined,
    extraQuirks: [
      "Default thinking level is 'minimal' (not in the unified ladder); omit effort to keep it.",
    ],
    verifiedExtra: [],
  }),

  // ---------------------------------------------------------------- OpenAI-compatible (open / local models)
  {
    id: "gpt-oss-120b",
    provider: "openai-compat",
    billing: "metered",
    apiModelId: "openai/gpt-oss-120b",
    vendor: "openai",
    family: "gpt-oss",
    displayName: "gpt-oss-120b (self-hosted, OpenAI-compatible endpoint)",
    contextWindow: 131_072,
    maxOutputTokens: 131_072,
    defaultMaxOutputTokens: 16_000,
    pricing: {
      inputPerMTok: 0,
      outputPerMTok: 0,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
      source: "self-hosted: no per-token price; override for hosted endpoints (e.g. OpenRouter reports usage.cost)",
    },
    capabilities: {
      vision: false,
      tools: true,
      strictTools: false,
      strictToolsVia: "none",
      forcedToolChoice: false,
      parallelToolCalls: true,
      parallelToolCallsToggle: false,
      toolResultImages: "none",
      images: { formats: [], urlSource: false, estimatedTokensPerImage: 1 },
      caching: { style: "none", maxBreakpoints: 0, ttls: [] },
      alwaysStream: false,
      eagerInputStreaming: false,
      samplingParams: true,
    },
    reasoning: {
      style: "compat-reasoning-effort",
      efforts: ["low", "medium", "high"],
      canDisable: false,
      summaries: false,
      replay: "recommended",
    },
    promptVariant: "generic",
    toolSchemaStyle: "openai-compat",
    quirks: [
      "Served model id differs per server (vLLM: Hugging Face repo id; Ollama: 'gpt-oss:120b'); override apiModelId.",
      "Reasoning arrives in a non-standard assistant field whose name depends on the server.",
      "Chat Completions tool messages accept text only; images in tool results are not deliverable (text-only model).",
    ],
    compat: {
      baseURL: "http://localhost:8000/v1",
      maxTokensParam: "max_tokens",
      reasoningFields: ["reasoning_content", "reasoning", "reasoning_details"],
      replayReasoningFields: true,
      providerReportsCost: false,
      streamUsage: true,
    },
    verification: {
      sources: ["developers.openai.com/api/docs/models/gpt-oss-120b.md", "OpenRouter docs: reasoning-tokens.mdx"],
      verified: ["contextWindow", "maxOutputTokens", "capabilities.vision (text-only input)", "reasoning.efforts"],
      unverified: [
        "apiModelId (depends on the serving stack)",
        "compat.baseURL (vLLM default port)",
        "compat.reasoningFields (server-specific: vLLM/Ollama/OpenRouter differ)",
        "capabilities.forcedToolChoice / parallelToolCalls (server-specific)",
        "pricing (self-hosted)",
      ],
      asOf: AS_OF,
    },
  },
];

function openaiGpt6(
  id: string,
  displayName: string,
  opts: {
    pricing: { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number; cacheWritePerMTok: number };
    noneEffort: boolean;
    defaultEffort: "medium" | undefined;
    extraQuirks: string[];
  },
): ModelProfile {
  return {
    id,
    provider: "openai",
    billing: "metered",
    apiModelId: id,
    vendor: "openai",
    family: "gpt-6",
    displayName,
    contextWindow: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    defaultMaxOutputTokens: 32_000,
    pricing: {
      ...opts.pricing,
      longContext: { thresholdInputTokens: 272_000, inputMultiplier: 2, outputMultiplier: 1.5, cacheMultiplier: 2 },
      source: `developers.openai.com/api/docs/models/${id}.md`,
    },
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "tool-flag",
      forcedToolChoice: true,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "native",
      images: {
        formats: ["image/png", "image/jpeg", "image/webp", "image/gif"],
        urlSource: true,
        defaultDetail: "high",
        estimatedTokensPerImage: 2500,
      },
      caching: { style: "openai-explicit", minCacheableTokens: 1024, maxBreakpoints: 4, ttls: [] },
      alwaysStream: false,
      eagerInputStreaming: false,
      samplingParams: false,
    },
    reasoning: {
      style: "openai-effort",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      ...(opts.defaultEffort === undefined ? {} : { defaultEffort: opts.defaultEffort }),
      canDisable: opts.noneEffort,
      summaries: true,
      replay: "required",
    },
    promptVariant: "gpt-6",
    toolSchemaStyle: "openai-strict",
    quirks: [
      ...opts.extraQuirks,
      "Stateless (store: false): replay every output item unchanged, including reasoning items with encrypted_content and assistant `phase`.",
      "Reasoning is reusable only within the same model family; switching families drops it server-side.",
      "Strict tools: every object needs additionalProperties:false and all properties required (optional -> nullable).",
      "Temperature/top_p/top_logprobs rejected when reasoning effort is not 'none'.",
      "Explicit prompt caching (GPT-5.6+): prompt_cache_breakpoint on input_text/input_image, up to 4 cache writes, 30m TTL, writes billed 1.25x.",
      "Prompts over 272K input tokens are billed 2x input/cache and 1.5x output for the whole request.",
      "Image detail 'auto' behaves like 'original' (up to 30,000 patches); the profile defaults to 'high' (<= 2,500 patches).",
      "Change effort mid-conversation with configuration_update items to keep the cache (not used by the gateway).",
    ],
    verification: {
      sources: [
        `developers.openai.com/api/docs/models/${id}.md`,
        "developers.openai.com/api/docs/guides/latest-model.md",
        "developers.openai.com/api/docs/guides/reasoning.md",
        "developers.openai.com/api/docs/guides/prompt-caching.md",
        "developers.openai.com/api/docs/guides/function-calling.md",
        "developers.openai.com/api/docs/guides/images-vision.md",
        "openai 7.22.0 type definitions",
      ],
      verified: [
        "apiModelId",
        "contextWindow",
        "maxInputTokens",
        "maxOutputTokens",
        "pricing (input, cached input, cache writes, output, >272K surcharge)",
        "reasoning.efforts",
        ...(opts.defaultEffort === undefined ? [] : ["reasoning.defaultEffort"]),
        "reasoning.canDisable ('none' effort support)",
        "capabilities.caching.style (explicit caching on GPT-5.6 and later)",
        "capabilities.caching.minCacheableTokens",
        "capabilities.images.formats",
        "capabilities.toolResultImages (function_call_output accepts input_image)",
      ],
      unverified: [
        "defaultMaxOutputTokens (docs: reserve >= 25,000 tokens for reasoning + output; our choice)",
        "capabilities.images.estimatedTokensPerImage (patch cap at detail 'high'; patch ~ token assumed)",
        "capabilities.images.defaultDetail (our cost-control choice)",
      ],
      asOf: AS_OF,
    },
  };
}

function gemini(
  id: string,
  displayName: string,
  opts: {
    family: string;
    pricing: ModelProfile["pricing"];
    efforts: ModelProfile["reasoning"]["efforts"];
    defaultEffort: "medium" | "high" | undefined;
    minCacheableTokens: number | undefined;
    extraQuirks: string[];
    verifiedExtra: string[];
  },
): ModelProfile {
  return {
    id,
    provider: "google",
    billing: "metered",
    apiModelId: id,
    vendor: "google",
    family: opts.family,
    displayName,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    defaultMaxOutputTokens: 32_768,
    pricing: opts.pricing,
    capabilities: {
      vision: true,
      tools: true,
      strictTools: true,
      strictToolsVia: "validated-mode",
      forcedToolChoice: true,
      parallelToolCalls: true,
      parallelToolCallsToggle: false,
      toolResultImages: "native",
      images: {
        formats: ["image/png", "image/jpeg", "image/webp"],
        urlSource: false,
        defaultDetail: "high",
        estimatedTokensPerImage: 1120,
      },
      caching: {
        style: "google-implicit",
        ...(opts.minCacheableTokens === undefined ? {} : { minCacheableTokens: opts.minCacheableTokens }),
        maxBreakpoints: 0,
        ttls: [],
      },
      alwaysStream: false,
      eagerInputStreaming: false,
      samplingParams: false,
    },
    reasoning: {
      style: "google-thinking-level",
      efforts: opts.efforts,
      ...(opts.defaultEffort === undefined ? {} : { defaultEffort: opts.defaultEffort }),
      effortMap: { low: "LOW", medium: "MEDIUM", high: "HIGH" },
      canDisable: false,
      summaries: true,
      replay: "required",
    },
    promptVariant: "gemini-3",
    toolSchemaStyle: "google",
    quirks: [
      ...opts.extraQuirks,
      "Gemini 3: thoughtSignature on the first functionCall part of each step must be returned in its original part or the request 400s.",
      "Never merge or split parts that carry a thoughtSignature; replay parts in the order received.",
      "Parallel calls: send all functionCall parts, then all functionResponse parts (interleaving 400s).",
      "Foreign/injected function calls need the dummy signature 'skip_thought_signature_validator'.",
      "Multimodal function responses (Gemini 3): images as inlineData parts nested in functionResponse (png/jpeg/webp).",
      "Implicit caching only in generateContent; explicit cachedContent is a separate resource (not used).",
      "Image URLs are not accepted as inline sources here (fileData needs a Files API / GCS URI); send base64.",
      "No switch to disable parallel function calls.",
    ],
    verification: {
      sources: [
        `ai.google.dev/gemini-api/docs/models/${id}.md.txt`,
        "ai.google.dev/gemini-api/docs/pricing.md.txt",
        "ai.google.dev/gemini-api/docs/generate-content/thinking.md.txt",
        "ai.google.dev/gemini-api/docs/generate-content/caching.md.txt",
        "ai.google.dev/gemini-api/docs/generate-content/function-calling.md.txt",
        "ai.google.dev/gemini-api/docs/generate-content/thought-signatures.md.txt",
        "@google/genai 2.24.0 type definitions",
      ],
      verified: [
        "apiModelId",
        "contextWindow (input token limit 1,048,576)",
        "maxOutputTokens (65,536)",
        "pricing.inputPerMTok",
        "pricing.outputPerMTok (includes thinking tokens)",
        "pricing.cacheReadPerMTok (context caching price)",
        "reasoning.efforts / effortMap (thinkingLevel low/medium/high)",
        "capabilities.strictToolsVia (VALIDATED mode ensures schema adherence)",
        "capabilities.toolResultImages",
        "capabilities.images.formats (function-response MIME types)",
        "capabilities.images.estimatedTokensPerImage (media_resolution_high = 1120)",
        ...opts.verifiedExtra,
      ],
      unverified: [
        "pricing.cacheWritePerMTok (implicit caching has no write surcharge; set to the input price, unused)",
        "capabilities.images.urlSource (conservative: false)",
        "defaultMaxOutputTokens (our choice)",
      ],
      asOf: AS_OF,
    },
  };
}

// ================================================================================================= CLI agents (ADR 0014)

/**
 * CLI profiles (docs/CLI-PROVIDERS.md §9.1): static aliases that each CLI resolves itself (`--model opus`). Pricing is
 * the NOTIONAL list price of the matching API model (subscription runs are not billed per token; the number feeds the
 * budget guard and the "plan usage" display), or zeros where no API equivalent exists. Context windows and limits are
 * copied from the matching API profile, else a conservative 128k / 16k.
 *
 * Not part of `BUILTIN_PROFILES` (the default registry): Node hosts that inject `cliGatewayParts` register them, e.g.
 * `new LLMGateway({ profiles: [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, ...BUILTIN_LOCAL_PROFILES], ... })`.
 */
const CLI_AS_OF = "2026-09-24";
const ALL_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const IMAGE_FORMATS: ModelProfile["capabilities"]["images"]["formats"] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

function apiProfile(id: string): ModelProfile {
  const p = BUILTIN_PROFILES.find((x) => x.id === id);
  if (p === undefined) throw new Error(`builtin-profiles: no API profile ${id}`);
  return p;
}

const CLI_LABEL: Record<CliProviderId, string> = {
  "claude-cli": "Claude Code",
  "gemini-cli": "Gemini CLI",
  "codex-cli": "Codex CLI",
  opencode: "opencode",
  "cursor-agent": "Cursor Agent",
};
const CLI_AGENT: Record<CliProviderId, "claude" | "gemini" | "codex" | "opencode" | "cursor"> = {
  "claude-cli": "claude",
  "gemini-cli": "gemini",
  "codex-cli": "codex",
  opencode: "opencode",
  "cursor-agent": "cursor",
};

interface CliProfileSpec {
  provider: CliProviderId;
  alias: string;
  modelArg: string | null;
  model: string;
  vendor: string;
  family: string;
  /** API profile the limits and notional pricing are copied from (null: 128k / 16k, zero pricing). */
  base: string | null;
  notionalPricing: boolean;
  modes: Array<"completion" | "runtime">;
  envelopeVia: "json-schema" | "mcp-submit" | "text-json";
  efforts: ReasoningEffort[];
  effortArg?: Partial<Record<ReasoningEffort, string>>;
  vision: boolean;
  promptVariant?: string;
  billing?: Billing;
  quirks: string[];
  sources: string[];
  verified: string[];
  unverified: string[];
  discoveredAt?: string;
}

const CLI_COMMON_QUIRKS = [
  "Runs the user's installed CLI on their own login: every call is one fresh, locked-down invocation (built-in tools off, empty temp workspace, allowlisted env).",
  "Completion mode returns one turn envelope {text, tool_calls}; the orchestrator runs the tools (docs/CLI-PROVIDERS.md §3.2).",
  "Pricing is notional (API list price) for budget and display; the user's plan limits are the real cap.",
];

export function cliProfile(spec: CliProfileSpec): ModelProfile {
  const base = spec.base === null ? null : apiProfile(spec.base);
  const label = CLI_LABEL[spec.provider];
  const pricing: ModelProfile["pricing"] =
    spec.notionalPricing && base !== null
      ? { ...base.pricing, source: `notional: ${spec.vendor} API list price of ${base.id}; subscription runs are not billed per token` }
      : { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, source: "no API equivalent on this login (request quotas): notional 0" };
  const effortArg = spec.effortArg ?? Object.fromEntries(spec.efforts.map((e) => [e, e]));
  const profile: ModelProfile = {
    id: `${spec.provider}:${spec.alias}`,
    provider: spec.provider,
    apiModelId: spec.modelArg ?? "default",
    vendor: spec.vendor,
    family: spec.family,
    displayName: `${spec.model} (${label}, your plan)`,
    contextWindow: base?.contextWindow ?? 128_000,
    maxOutputTokens: base?.maxOutputTokens ?? 16_000,
    defaultMaxOutputTokens: Math.min(base?.defaultMaxOutputTokens ?? 16_000, 32_000),
    pricing,
    capabilities: {
      vision: spec.vision,
      tools: true,
      strictTools: false,
      strictToolsVia: "none",
      forcedToolChoice: false,
      parallelToolCalls: true,
      parallelToolCallsToggle: true,
      toolResultImages: "none",
      images: {
        formats: spec.vision ? (base?.capabilities.images.formats ?? IMAGE_FORMATS) : [],
        urlSource: false,
        estimatedTokensPerImage: base?.capabilities.images.estimatedTokensPerImage ?? 1_600,
      },
      caching: { style: "cli-managed", maxBreakpoints: 0, ttls: [] },
      alwaysStream: false,
      eagerInputStreaming: false,
      samplingParams: false,
    },
    reasoning: { style: spec.efforts.length > 0 ? "cli-effort-flag" : "none", efforts: spec.efforts, canDisable: false, summaries: false, replay: "none" },
    promptVariant: spec.promptVariant ?? base?.promptVariant ?? "generic",
    toolSchemaStyle: "cli-envelope",
    quirks: [...CLI_COMMON_QUIRKS, ...spec.quirks],
    dataRetention: `Your ${spec.vendor} plan's terms apply (consumer data handling, not API zero data retention).`,
    verification: { sources: ["docs/CLI-PROVIDERS.md §4, §9.1", ...spec.sources], verified: spec.verified, unverified: spec.unverified, asOf: CLI_AS_OF },
    billing: spec.billing ?? "subscription",
    cli: {
      agent: CLI_AGENT[spec.provider],
      modelArg: spec.modelArg,
      modes: spec.modes,
      envelopeVia: spec.envelopeVia,
      ...(spec.efforts.length > 0 ? { effortArg } : {}),
      ...(spec.discoveredAt === undefined ? {} : { discoveredAt: spec.discoveredAt }),
    },
  };
  return profile;
}

const claudeCli = (alias: string, model: string, family: string, base: string, efforts: ReasoningEffort[], extra: string[] = []): ModelProfile =>
  cliProfile({
    provider: "claude-cli",
    alias,
    modelArg: alias,
    model,
    vendor: "anthropic",
    family,
    base,
    notionalPricing: true,
    modes: ["completion", "runtime"],
    envelopeVia: "json-schema",
    efforts,
    vision: true,
    quirks: [
      "Notional cost is Claude Code's own total_cost_usd (list basis); plan usage comes from rate_limit_event (5-hour and 7-day windows).",
      ...extra,
    ],
    sources: ["claude --help 2.1.260", "live claude -p runs 2026-09-24 (test/cli/fixtures/claude)"],
    verified: ["cli.modelArg", "cli.envelopeVia", "capabilities.tools"],
    unverified: ["contextWindow / maxOutputTokens (copied from the API profile)", "pricing (notional)", "capabilities.vision (stream-json image input, from the SDK docs)"],
  });

const geminiCli = (alias: string, model: string, family: string, base: string, modes: Array<"completion" | "runtime">): ModelProfile =>
  cliProfile({
    provider: "gemini-cli",
    alias,
    modelArg: alias,
    model,
    vendor: "google",
    family,
    base,
    notionalPricing: false,
    modes,
    envelopeVia: "mcp-submit",
    efforts: [],
    vision: true,
    quirks: ["No JSON-schema output: the envelope comes back through the submit_turn MCP tool.", "Auto routing and quota fallback can switch models; the actual model is recorded."],
    sources: ["gemini --help 0.49.0", "research pass (offline, --fake-responses)"],
    verified: ["cli.modelArg", "cli.envelopeVia"],
    unverified: ["contextWindow (copied from the API profile)", "capabilities.vision (@path images)"],
  });

const codexCli = (alias: string, modelArg: string | null, model: string, base: string, notional: boolean, modes: Array<"completion" | "runtime">): ModelProfile =>
  cliProfile({
    provider: "codex-cli",
    alias,
    modelArg,
    model,
    vendor: "openai",
    family: "gpt-6",
    base,
    notionalPricing: notional,
    modes,
    envelopeVia: "json-schema",
    efforts: ["low", "medium", "high", "xhigh"],
    vision: true,
    quirks: ["Built from the Codex source and docs only: lockdown level 'static' until verified with a ChatGPT plan.", "--output-schema is strict: tool schemas are rewritten to OpenAI strict form."],
    sources: ["codex-rs exec/src/cli.rs, exec_events.rs (0.156.1)"],
    verified: ["cli.envelopeVia"],
    unverified: ["cli.modelArg", "contextWindow (copied from the API profile)", "pricing (notional)"],
  });

export const BUILTIN_CLI_PROFILES: readonly ModelProfile[] = [
  claudeCli("opus", "Claude Opus", "claude-opus", "claude-opus-5-5", ALL_EFFORTS),
  claudeCli("sonnet", "Claude Sonnet", "claude-sonnet", "claude-sonnet-5", ALL_EFFORTS),
  claudeCli("haiku", "Claude Haiku", "claude-haiku", "claude-haiku-4-5", [], ["The alias runs as claude-haiku-4-5-20251001 (seen live); no --effort control."]),
  claudeCli("fable", "Claude Fable", "claude-fable", "claude-fable-5-1", ALL_EFFORTS),
  geminiCli("pro", "Gemini Pro", "gemini-pro", "gemini-3.1-pro-preview", ["completion", "runtime"]),
  geminiCli("flash", "Gemini Flash", "gemini-flash", "gemini-3.8-flash", ["completion", "runtime"]),
  geminiCli("flash-lite", "Gemini Flash-Lite", "gemini-flash", "gemini-3.5-flash-lite", ["completion"]),
  geminiCli("auto", "Gemini (auto routing)", "gemini-auto", "gemini-3.1-pro-preview", ["completion", "runtime"]),
  codexCli("default", null, "Codex default model", "gpt-6-sol", false, ["completion", "runtime"]),
  codexCli("gpt-6-sol", "gpt-6-sol", "GPT-6 Sol", "gpt-6-sol", true, ["completion", "runtime"]),
  codexCli("gpt-6-luna", "gpt-6-luna", "GPT-6 Luna", "gpt-6-luna", true, ["completion"]),
  cliProfile({
    provider: "cursor-agent",
    alias: "auto",
    modelArg: null,
    model: "Cursor (auto)",
    vendor: "cursor",
    family: "cursor-auto",
    base: null,
    notionalPricing: false,
    modes: ["completion"],
    envelopeVia: "text-json",
    efforts: [],
    vision: false,
    quirks: ["BLOCKED: web search cannot be switched off in headless runs, so the lockdown refuses every Cursor build (docs/CLI-PROVIDERS.md §4.6)."],
    sources: ["cursor-agent --help 2026.01.28"],
    verified: ["cli.envelopeVia"],
    unverified: ["everything else: no verified build exists"],
  }),
];

/**
 * A profile for a model found by CLI discovery (Codex `debug models`, opencode `models --verbose`, Cursor `models`).
 * Id `<provider>:<modelArg>`; limits from `base` when given (e.g. the API profile of the same model).
 */
export function profileFromDiscovery(provider: CliProviderId, m: DiscoveredModel, base?: ModelProfile, now: Date = new Date()): ModelProfile {
  const envelopeVia = provider === "claude-cli" || provider === "codex-cli" ? "json-schema" : provider === "cursor-agent" ? "text-json" : "mcp-submit";
  const p = cliProfile({
    provider,
    alias: m.modelArg,
    modelArg: m.modelArg,
    model: m.displayName,
    vendor: m.vendor,
    family: m.family,
    base: null,
    notionalPricing: false,
    modes: provider === "cursor-agent" ? ["completion"] : ["completion", "runtime"],
    envelopeVia,
    efforts: [],
    vision: m.vision,
    billing: m.billing === "local" ? "subscription" : m.billing,
    quirks: ["Discovered from the CLI's model list; limits are conservative unless an API profile matched."],
    sources: [`${CLI_LABEL[provider]} model discovery`],
    verified: ["cli.modelArg (listed by the CLI)"],
    unverified: ["contextWindow", "pricing (0 unless an API profile matched)"],
    discoveredAt: now.toISOString(),
  });
  if (base !== undefined) {
    p.contextWindow = base.contextWindow;
    p.maxOutputTokens = base.maxOutputTokens;
    p.defaultMaxOutputTokens = Math.min(base.defaultMaxOutputTokens, 32_000);
    p.pricing = { ...base.pricing, source: `notional: API list price of ${base.id}` };
  } else if (m.contextWindow !== null && m.contextWindow > 0) {
    p.contextWindow = Math.floor(m.contextWindow);
    p.maxOutputTokens = Math.min(p.maxOutputTokens, p.contextWindow);
    p.defaultMaxOutputTokens = Math.min(p.defaultMaxOutputTokens, p.maxOutputTokens);
  }
  return p;
}

// ================================================================================================= local models (Ollama)

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

/** What `/api/show` tells us about a local model. */
export interface OllamaModelInfo {
  tag: string;
  family: string | null;
  parameterSize: string | null;
  tools: boolean;
  vision: boolean;
  thinking: boolean;
  contextLength: number | null;
}

const OLLAMA_VENDOR: Record<string, string> = { qwen3: "alibaba", qwen2: "alibaba", qwen3moe: "alibaba", llama: "meta", gemma3: "google", mistral: "mistral", gptoss: "openai", "gpt-oss": "openai", deepseek2: "deepseek" };

/**
 * An `ollama:<tag>` profile. Local profiles reach the server through its OpenAI-compatible `/v1` endpoint (the
 * `openai-compat` adapter), which cannot set `num_ctx` per request: the server must provide at least `local.numCtx`
 * (set `OLLAMA_CONTEXT_LENGTH`), or long prompts are silently truncated (the default is 4k below 24 GiB of VRAM).
 */
export function ollamaProfile(m: OllamaModelInfo, baseURL: string = DEFAULT_OLLAMA_URL, discovered = true): ModelProfile {
  const root = baseURL.replace(/\/+$/, "");
  const numCtx = Math.min(32_768, m.contextLength ?? 8_192);
  const maxOut = Math.min(16_384, numCtx);
  const family = m.family ?? m.tag.split(":")[0] ?? m.tag;
  return {
    id: `ollama:${m.tag}`,
    provider: "openai-compat",
    apiModelId: m.tag,
    vendor: OLLAMA_VENDOR[family] ?? "local",
    family,
    displayName: `${m.tag} (Ollama, local)`,
    contextWindow: numCtx,
    maxOutputTokens: maxOut,
    defaultMaxOutputTokens: Math.min(8_192, maxOut),
    pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0, source: "local compute: no per-token price" },
    capabilities: {
      vision: m.vision,
      tools: m.tools,
      strictTools: false,
      strictToolsVia: "none",
      forcedToolChoice: false,
      parallelToolCalls: true,
      parallelToolCallsToggle: false,
      toolResultImages: "none",
      images: { formats: m.vision ? ["image/png", "image/jpeg"] : [], urlSource: false, estimatedTokensPerImage: m.vision ? 1_000 : 1 },
      caching: { style: "none", maxBreakpoints: 0, ttls: [] },
      alwaysStream: false,
      eagerInputStreaming: false,
      samplingParams: true,
    },
    reasoning: m.thinking
      ? { style: "compat-reasoning-effort", efforts: ["low", "medium", "high"], canDisable: true, summaries: false, replay: "none" }
      : { style: "none", efforts: [], canDisable: false, summaries: false, replay: "none" },
    promptVariant: "generic",
    toolSchemaStyle: "openai-compat",
    quirks: [
      `The /v1 endpoint cannot set num_ctx: start Ollama with OLLAMA_CONTEXT_LENGTH >= ${numCtx}, or prompts are silently truncated (default 4k below 24 GiB VRAM).`,
      "Only models whose /api/show capabilities include tools are offered for agent roles; vision gates the judge.",
      "The app never pulls models: run `ollama pull <tag>` yourself (disk space is your call).",
    ],
    dataRetention: "Local: prompts never leave this machine (unless the Ollama URL points elsewhere).",
    compat: {
      baseURL: `${root}/v1`,
      maxTokensParam: "max_tokens",
      reasoningFields: ["reasoning", "reasoning_content"],
      replayReasoningFields: false,
      providerReportsCost: false,
      streamUsage: true,
    },
    local: { baseURL: root, tag: m.tag, numCtx, keepAlive: "10m", think: m.thinking },
    billing: "local",
    verification: {
      sources: ["docs/CLI-PROVIDERS.md §10", discovered ? "Ollama /api/show" : "ollama.com/library (tag names)"],
      verified: discovered ? ["capabilities.tools", "capabilities.vision", "local.tag"] : ["local.tag"],
      unverified: discovered ? ["contextWindow (capped at 32k for local memory)"] : ["capabilities (confirmed by /api/show once pulled)", "contextWindow"],
      asOf: CLI_AS_OF,
    },
  };
}

/**
 * Default local profiles: tool-capable models from the Ollama library, offered before discovery ran. They work only
 * once pulled (`ollama pull <tag>`); discovery replaces them with what `/api/show` reports.
 */
export const BUILTIN_LOCAL_PROFILES: readonly ModelProfile[] = [
  ollamaProfile({ tag: "qwen3:8b", family: "qwen3", parameterSize: "8.2B", tools: true, vision: false, thinking: true, contextLength: 40_960 }, DEFAULT_OLLAMA_URL, false),
  ollamaProfile({ tag: "gpt-oss:20b", family: "gpt-oss", parameterSize: "20.9B", tools: true, vision: false, thinking: true, contextLength: 131_072 }, DEFAULT_OLLAMA_URL, false),
  ollamaProfile({ tag: "qwen3-coder:30b", family: "qwen3moe", parameterSize: "30.5B", tools: true, vision: false, thinking: false, contextLength: 262_144 }, DEFAULT_OLLAMA_URL, false),
];

// ================================================================================================= small models

const SMALL_MODEL: Partial<Record<Provider, ModelRef>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-6-luna",
  google: "gemini-3.5-flash-lite",
  "claude-cli": "claude-cli:haiku",
  "gemini-cli": "gemini-cli:flash-lite",
  "codex-cli": "codex-cli:gpt-6-luna",
};

/** The small, fast model per provider (triage), or null to use the designer (§9.3). One table for every host. */
export function smallModelFor(provider: Provider): ModelRef | null {
  return SMALL_MODEL[provider] ?? null;
}

/**
 * (additive) {@link smallModelFor} by profile: a local profile (an `ollama:<tag>` profile routes through
 * `openai-compat`) never gets a hosted small model, whatever its transport provider; it uses the designer.
 */
export function smallModelForProfile(p: Pick<ModelProfile, "provider" | "local" | "billing">): ModelRef | null {
  return profileKind(p) === "local" ? null : smallModelFor(p.provider);
}
