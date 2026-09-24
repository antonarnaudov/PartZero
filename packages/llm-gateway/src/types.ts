/**
 * Unified, provider-neutral chat types.
 *
 * Design rules (ADR 0009 + ARCHITECTURE §6):
 * - History is append-only. An assistant turn returned by the gateway is appended verbatim; earlier turns are never
 *   edited. Provider-specific payloads that must round-trip (thinking blocks, reasoning items, thought signatures,
 *   OpenAI message items with `phase`) ride along in `native` and are replayed byte-for-byte to the same provider.
 * - Tool choice is `auto` or `none` only. Forced tool use is rejected by several current models
 *   (Claude Opus 5.5 / Fable 5.1), so the main loop never depends on it.
 */

/** Vendor APIs reached with keys through official SDKs (ADR 0009). */
export type ApiProvider = "anthropic" | "openai" | "google" | "openai-compat";
/** Local model servers (ADR 0014). Local profiles currently route through `openai-compat` (see `BUILTIN_LOCAL_PROFILES`). */
export type LocalProvider = "ollama";
/** CLI coding agents run headless on the user's own login (ADR 0014, docs/CLI-PROVIDERS.md). Node-only: `@aicad/llm-gateway/cli`. */
export type CliProviderId = "claude-cli" | "gemini-cli" | "codex-cli" | "opencode" | "cursor-agent";
export type Provider = ApiProvider | LocalProvider | CliProviderId;

export type ProviderKind = "api" | "cli" | "local";
export const PROVIDER_KINDS: Readonly<Record<Provider, ProviderKind>> = {
  anthropic: "api",
  openai: "api",
  google: "api",
  "openai-compat": "api",
  ollama: "local",
  "claude-cli": "cli",
  "gemini-cli": "cli",
  "codex-cli": "cli",
  opencode: "cli",
  "cursor-agent": "cli",
};
export const CLI_PROVIDER_IDS: readonly CliProviderId[] = ["claude-cli", "gemini-cli", "codex-cli", "opencode", "cursor-agent"];

export function providerKind(p: Provider): ProviderKind {
  return PROVIDER_KINDS[p];
}

export function isCliProvider(p: string): p is CliProviderId {
  return (CLI_PROVIDER_IDS as readonly string[]).includes(p);
}

/** Who pays for a call: a metered key, the user's CLI subscription (notional cost), or local compute. */
export type Billing = "metered" | "subscription" | "local";

/** How a CLI returns the turn envelope in completion mode (docs/CLI-PROVIDERS.md §3.2.2). */
export type EnvelopeVia = "json-schema" | "mcp-submit" | "text-json";

/** A model reference is a profile id from the {@link ProfileRegistry} (for example `claude-opus-5-5`). */
export type ModelRef = string;

/** Unified reasoning effort ladder. Mapped per provider by the model profile. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export type CacheTtl = "5m" | "1h";

/**
 * Provider payload that must be replayed unchanged when the conversation continues on the same provider.
 * `model` records who produced it (reasoning is model-bound on several providers).
 */
export interface NativePayload {
  provider: Provider;
  model: string;
  /** Opaque provider data. Never edit it. */
  data: unknown;
}

export interface TextBlock {
  type: "text";
  text: string;
  /** Place a prompt-cache breakpoint after this block (providers with explicit breakpoints only). */
  cacheBreakpoint?: boolean;
  native?: NativePayload;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ImageSource =
  | { type: "base64"; mediaType: ImageMediaType; data: string }
  | { type: "url"; url: string };

export interface ImageBlock {
  type: "image";
  source: ImageSource;
  /**
   * Resolution hint: OpenAI `detail`, Gemini `mediaResolution` (`original` maps to Gemini's high). Ignored by
   * Anthropic. When omitted, the profile's `images.defaultDetail` applies.
   */
  detail?: "low" | "high" | "auto" | "original";
  cacheBreakpoint?: boolean;
}

export interface ToolUseBlock {
  type: "tool_use";
  /** Call id to echo in the matching tool result (Anthropic `id`, OpenAI `call_id`, Gemini `functionCall.id`). */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set when the provider's arguments could not be parsed as a JSON object (malformed or truncated input).
   * Never run the tool in that case: return an `isError` tool result carrying `rawInput` so the model can retry.
   */
  inputError?: string;
  rawInput?: string;
  cacheBreakpoint?: boolean;
  native?: NativePayload;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  /** Tool name. Optional: adapters that need it (Gemini) resolve it from the matching `tool_use` in history. */
  toolName?: string;
  content: string | Array<TextBlock | ImageBlock>;
  isError?: boolean;
  cacheBreakpoint?: boolean;
}

/**
 * Opaque provider-specific reasoning (Anthropic thinking / redacted_thinking, OpenAI reasoning items, Gemini thought
 * parts, OpenAI-compatible `reasoning_*` fields) and any other provider block the gateway does not interpret.
 * Replayed only to the provider that produced it; the provider decides whether the target model can read it.
 */
export interface ReasoningBlock {
  type: "reasoning";
  /** Provider-level kind: `thinking`, `redacted_thinking`, `reasoning`, `thought`, `compat_reasoning`, `other`. */
  kind: string;
  /** Human-readable summary or progress text when the provider returned one (often empty). */
  text?: string;
  native: NativePayload;
}

export type UserContentBlock = TextBlock | ImageBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ToolUseBlock | ReasoningBlock;

export interface UserMessage {
  role: "user";
  content: UserContentBlock[];
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  /** Which profile/provider produced this turn (informational; replay decisions use each block's `native`). */
  producedBy?: { provider: Provider; model: string };
}

export type Message = UserMessage | AssistantMessage;

export interface SystemBlock {
  type: "text";
  text: string;
  cacheBreakpoint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool input; must be an object schema. */
  inputSchema: Record<string, unknown>;
  /** Ask the provider to guarantee schema-valid arguments (Anthropic/OpenAI `strict`, Gemini `VALIDATED` mode). */
  strict?: boolean;
  /** Tool never changes the design. MCP readOnlyHint; adapters never send it to a provider. */
  readOnly?: boolean;
}

export interface CacheOptions {
  /**
   * Provider-managed placement for the growing conversation tail
   * (Anthropic top-level `cache_control`, OpenAI implicit mode). Default true.
   */
  auto?: boolean;
  /** Explicit breakpoint after the last system block (tools + system prefix). Default true. */
  system?: boolean;
  /** Explicit breakpoint after the last tool definition. Default false. */
  tools?: boolean;
  /** Anthropic TTL. Default `5m`. OpenAI explicit caching always uses `30m`. */
  ttl?: CacheTtl;
  /** OpenAI `prompt_cache_key` routing hint. */
  key?: string;
}

export interface ReasoningOptions {
  effort?: ReasoningEffort;
  /** Ask for readable reasoning summaries (Anthropic `display: summarized`, OpenAI `summary: auto`, Gemini `includeThoughts`). */
  summary?: boolean;
}

export interface ChatMetadata {
  /** Opaque end-user id (Anthropic `metadata.user_id`, OpenAI `safety_identifier`). Never put PII here. */
  userId?: string;
  /** Task id for cost attribution in the gateway's ledger. */
  taskId?: string;
  /** String tags (OpenAI `metadata`). */
  tags?: Record<string, string>;
}

/** Escape hatch for provider-specific request fields. Merged last into the provider payload. */
export interface ProviderOptions {
  anthropic?: { betas?: string[]; extra?: Record<string, unknown> };
  openai?: { extra?: Record<string, unknown> };
  google?: { extra?: Record<string, unknown> };
  "openai-compat"?: { extra?: Record<string, unknown> };
  /** CLI providers (completion mode): per-call limits over the defaults (maxTurns 3, wall 180 s, stall 120 s). */
  cli?: { limits?: { maxTurns?: number; wallMs?: number; stallMs?: number; maxBudgetUsd?: number } };
}

export interface ChatRequest {
  model: ModelRef;
  system?: SystemBlock[];
  messages: Message[];
  tools?: ToolDef[];
  /** Default `auto`. There is no forced mode on purpose (see module docs). */
  toolChoice?: "auto" | "none";
  /** Default: provider default (parallel allowed). */
  parallelToolCalls?: boolean;
  /** Defaults to the profile's `defaultMaxOutputTokens`; clamped to the profile's `maxOutputTokens`. */
  maxOutputTokens?: number;
  reasoning?: ReasoningOptions;
  cache?: CacheOptions;
  /** Use the provider's streaming transport even for `chat()` (recommended for long outputs). */
  stream?: boolean;
  metadata?: ChatMetadata;
  providerOptions?: ProviderOptions;
  signal?: AbortSignal;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause" | "error";

export interface Usage {
  /** Input tokens billed at the full (uncached) rate. */
  inputTokens: number;
  /** Output tokens, including reasoning tokens (billed as output on every provider). */
  outputTokens: number;
  cacheReadTokens: number;
  /** All cache-write tokens (Anthropic: 5m + 1h; OpenAI explicit caching writes). */
  cacheWriteTokens: number;
  /** Subset of `cacheWriteTokens` written with a 1-hour TTL (Anthropic only). */
  cacheWrite1hTokens: number;
  /** Subset of `outputTokens` spent on reasoning, when the provider reports it. */
  reasoningTokens: number;
}

export interface RefusalInfo {
  /** Provider category (`cyber`, `bio`, `reasoning_extraction`, `SAFETY`, `content_filter`, ...), if any. */
  category?: string | null;
  explanation?: string | null;
}

export interface ChatResponse {
  id: string;
  provider: Provider;
  /** Profile id used for the call. */
  model: ModelRef;
  /** Model id reported by the provider. */
  providerModel: string;
  /** Append this to history verbatim. */
  message: AssistantMessage;
  stopReason: StopReason;
  /** Raw provider stop/finish reason for diagnostics. */
  providerStopReason: string | null;
  refusal?: RefusalInfo;
  usage: Usage;
  costUsd: number;
  /** `profile` = computed from the pricing table; `provider` = reported by the provider (e.g. OpenRouter `usage.cost`). */
  costSource: "profile" | "provider";
  /** Non-fatal adaptations the adapter made (clamped effort, dropped foreign reasoning, ...). */
  warnings: string[];
  /** Untouched provider response (or the accumulated final object for streams). */
  providerRaw: unknown;
  /** From the profile (a CLI logged in with an API key is `metered`). Subscription costs are notional. */
  billing: Billing;
  /** Plan usage windows reported by a CLI (Claude `rate_limit_event`). */
  planUsage?: PlanUsage;
  /** CLI calls only. */
  cli?: CliCallInfo;
}

export interface CliCallInfo {
  provider: CliProviderId;
  version: string;
  sessionId: string | null;
  /** CLI-internal model round trips. */
  turns: number | null;
  /** Actual models (may differ from the requested alias). */
  modelsUsed: string[];
  envelopeVia: EnvelopeVia | null;
  durationMs: number;
}

export interface PlanUsage {
  provider: CliProviderId;
  status: "allowed" | "allowed_warning" | "rejected" | "unknown";
  windows: PlanWindow[];
  overage: { status: string; inUse: boolean } | null;
  /** ISO timestamp. */
  observedAt: string;
}

/** `utilization` is 0..1. */
export interface PlanWindow {
  id: string;
  utilization: number | null;
  resetsAt: string | null;
}

/** Normalized streaming events. `index` is the block's position in the final `message.content`. */
export type StreamEvent =
  | { type: "message_start"; provider: Provider; model: ModelRef; providerModel: string }
  | { type: "text_delta"; index: number; text: string }
  | { type: "reasoning_start"; index: number; kind: string }
  | { type: "reasoning_delta"; index: number; text: string }
  | { type: "reasoning_end"; index: number }
  | { type: "tool_use_start"; index: number; id: string; name: string }
  | { type: "tool_use_input_delta"; index: number; id: string; partialJson: string }
  | { type: "tool_use_end"; index: number; id: string; name: string; input: Record<string, unknown>; inputError?: string }
  | { type: "usage"; usage: Usage }
  | { type: "message_end"; response: ChatResponse };

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: 0,
  };
}
