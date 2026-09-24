/**
 * The in-app design agent protocol (version 1): renderer ⇄ Electron main ⇄ agent utility process.
 *
 *   renderer ──invoke agent:start / agent:answer / agent:stop──▶ main ──postMessage──▶ agent worker
 *   renderer ◀──────────── agent:event (AgentEvent stream) ◀─── main ◀──postMessage── agent worker
 *
 * **Types only** (the sandboxed preload imports nothing at runtime). The desktop main process
 * validates every renderer message against these shapes (`packages/desktop/src/agent/protocol.ts`),
 * and every message carries `v: 1`, so an incompatible renderer/main pair fails loudly instead of
 * misbehaving.
 *
 * Secrets never cross this boundary towards the renderer: settings views carry only whether a key
 * is configured, where it comes from and its last four characters. CLI agents (ADR 0014) run on the
 * user's own login; the app never reads their credentials, and the views carry only the login state
 * and the plan name.
 *
 * Every change since v1 shipped is additive (docs/CLI-PROVIDERS.md §11.4): the version stays 1.
 */

export type AgentProtocolVersion = 1;

/** API-key providers (official SDKs; the key is optional since ADR 0014). */
export type ApiProviderId = "anthropic" | "openai" | "google" | "openai-compat";
/** CLI coding agents run headless on the user's own login (ADR 0014, docs/CLI-PROVIDERS.md). */
export type CliProviderId = "claude-cli" | "gemini-cli" | "codex-cli" | "opencode" | "cursor-agent";
/** Local model servers. */
export type LocalProviderId = "ollama";
/** Every provider the gateway speaks (`@aicad/llm-gateway` `Provider`). */
export type ProviderId = ApiProviderId | CliProviderId | LocalProviderId;
/** How a provider is reached: an API key, the user's CLI subscription, or a local server. */
export type ProviderKindId = "api" | "cli" | "local";
/** Who pays: per-token on a key, the user's CLI plan (notional cost), or nobody (local compute). */
export type BillingKind = "metered" | "subscription" | "local";
/** Settings → Advanced: how CLI providers run the tool loops (docs/CLI-PROVIDERS.md §3.4). */
export type CliModeSetting = "auto" | "completion" | "runtime";

/** Roles whose model the user picks in Settings (gateway router roles). */
export type AgentRoleId = "designer" | "judge" | "triage" | "spec_writer";

/** Orchestrator states (`@aicad/agent` `AgentState`). */
export type AgentPhase = "TRIAGE" | "ASK" | "CLARIFY" | "SPEC" | "BUILD" | "REPAIR" | "REPLAN" | "PROPOSE" | "DONE";

/** How model calls are served. `scripted` / `replay` run offline (tests, demos) and need no keys. */
export type AgentTransportKind = "live" | "scripted" | "replay";

/** One selection chip, described semantically for the agent (e.g. face `plate/cap:end`). */
export interface AgentSelectionItem {
  kind: "feature" | "face" | "edge" | "body";
  /** Feature id, or the provenance name of a face/edge/body. */
  ref: string;
  label: string;
  /** What it is, in words the model can use ("the far end cap of extrude `plate` (part `plate`)"). */
  description?: string;
}

export interface AgentStartRequest {
  v: AgentProtocolVersion;
  /** The user's message. */
  prompt: string;
  /** CadScript of the open document (the draft branch starts from it). */
  source: string;
  documentName: string;
  selection: AgentSelectionItem[];
  /** Manufacturing process hint. */
  process?: "fdm" | "cnc" | "laser" | "any";
  /** Per-run overrides of the stored settings (keys are never accepted here). */
  settings?: { budgetUsd?: number };
}

export type AgentStartErrorCode =
  | "NO_API_KEY"
  | "BUSY"
  | "INVALID_REQUEST"
  | "UNAVAILABLE"
  | "CLI_NOT_INSTALLED"
  | "CLI_UNSUPPORTED"
  | "CLI_BLOCKED"
  | "CLI_NOT_LOGGED_IN"
  | "LOCAL_UNAVAILABLE";

export type AgentStartResponse = { ok: true; runId: string } | { ok: false; code: AgentStartErrorCode; message: string };

export interface AgentAnswerRequest {
  v: AgentProtocolVersion;
  runId: string;
  questionId: string;
  /** One answer per question, in order. */
  answers: string[];
}

export interface AgentStopRequest {
  v: AgentProtocolVersion;
  runId: string;
}

/** A clarifying question (`@aicad/agent-tools` `UserQuestion`). */
export interface AgentQuestion {
  id: string;
  question: string;
  options?: string[];
  default: string;
}

export interface AgentModelInfo {
  id: string;
  name: string;
  provider: ProviderId;
  kind: ProviderKindId;
  billing: BillingKind;
}

export type AgentRunStatus = "proposed" | "answered" | "stopped" | "failed";

/** The final result of a run. */
export interface AgentRunResult {
  status: AgentRunStatus;
  /** `@aicad/agent` stop reason (`proposed`, `cancelled`, `budget`, …). */
  stopReason: string;
  message: string;
  /** The document source the run started from. */
  baseSource: string;
  /** The proposed CadScript (the draft branch head, or the best verified state when stopped). */
  proposedSource: string;
  /** `proposedSource !== baseSource`. */
  changed: boolean;
  /** The proposed state passes L0–L2. */
  verified: boolean;
  summary: string;
  /** Assumptions the agent made (shown as parameter chips). */
  assumptions: string[];
  knownIssues: string[];
  /** ASK route: the answer. */
  answer?: string;
  tests?: { passed: number; total: number };
  /** Notional (API list price) for subscription runs, 0 for local models. */
  costUsd: number;
  budgetUsd: number;
  latencyMs: number;
  turns: number;
  /** Billing of the designer's profile. */
  billing?: BillingKind;
  /**
   * (additive) The run stopped on a plan or rate limit of a CLI or API provider (docs/CLI-PROVIDERS.md §12):
   * `quota_exhausted` (the plan's usage limit; `resetsAt` from the plan usage the CLI reported) or `rate_limited`.
   */
  quota?: { kind: "quota_exhausted" | "rate_limited"; provider: string | null; resetsAt: string | null };
}

interface AgentEventBase {
  v: AgentProtocolVersion;
  runId: string;
  /** Increments per event of a run (gaps mean lost events). */
  seq: number;
  /** Milliseconds since the run started. */
  t: number;
}

export type AgentEventBody =
  | {
      type: "started";
      models: Partial<Record<AgentRoleId, AgentModelInfo>>;
      budgetUsd: number;
      transport: AgentTransportKind;
      /** Engine the agent verifies with (`forge-web (wasm, node)` or `forge CLI`). */
      engine: string;
    }
  | { type: "phase"; phase: AgentPhase; detail: string }
  | { type: "tool"; name: string; ok: boolean; summary: string }
  | { type: "llm"; role: string; model: string; costUsd: number; summary: string; billing?: BillingKind }
  /** `notional`: some spend in the run is a CLI plan's list-price estimate, not a bill. */
  | { type: "cost"; spentUsd: number; budgetUsd: number; notional?: boolean }
  /** Plan usage windows a CLI reported during the run (Claude `rate_limit_event`). */
  | { type: "plan"; provider: CliProviderId; usage: PlanUsageView }
  | { type: "draft"; source: string; applyIndex: number; verified: boolean; reason: "apply" | "rollback" }
  | { type: "note"; text: string }
  | { type: "question"; questionId: string; kind: "clarify" | "budget"; questions: AgentQuestion[] }
  | { type: "answered"; questionId: string; answers: string[] }
  | { type: "result"; result: AgentRunResult }
  | { type: "error"; code: string; message: string };

/** One event of a run. `result` and `error` are terminal. */
export type AgentEvent = AgentEventBase & AgentEventBody;

export type AgentEventType = AgentEventBody["type"];

// ─── Settings ──────────────────────────────────────────────────────────────────────────────

export type KeySource = "keychain" | "env" | "dotenv";

export interface ProviderKeyStatus {
  id: ApiProviderId;
  label: string;
  configured: boolean;
  /** Where the effective key comes from (`keychain` = entered in Settings, encrypted with the OS keychain). */
  source: KeySource | null;
  /** Last four characters of the effective key (null for short keys). */
  last4: string | null;
  /** Environment variable read in development (e.g. `ANTHROPIC_API_KEY`). */
  envVar: string;
  /** Whether a key is mandatory (OpenAI-compatible local servers may need none). */
  keyRequired: boolean;
}

export interface ModelProfileInfo {
  id: string;
  name: string;
  provider: ProviderId;
  family: string;
  kind: ProviderKindId;
  billing: BillingKind;
  /** Whether a run could use it right now (CLI ready and logged in, key set, local model pulled). */
  available: boolean;
  /** (additive) Why it is unavailable, e.g. "Claude Code is not installed". */
  reason?: string;
}

/** Plan usage windows of a CLI subscription (utilization 0..1). */
export interface PlanUsageView {
  status: "allowed" | "allowed_warning" | "rejected" | "unknown";
  /** label: "5-hour", "7-day", … */
  windows: Array<{ id: string; label: string; utilization: number | null; resetsAt: string | null }>;
  observedAt: string;
}

/** One CLI agent as detected on this machine (docs/CLI-PROVIDERS.md §11.4). No model call is ever made to get it. */
export interface CliProviderStatus {
  id: CliProviderId;
  /** "Claude Code". */
  label: string;
  installed: boolean;
  path: string | null;
  pathSource: "settings" | "path" | "known-dir" | "login-shell" | null;
  version: string | null;
  support: "ready" | "unsupported_version" | "blocked" | "not_installed";
  /** e.g. "needs >= 2.1.260", "web search cannot be disabled". */
  supportDetail: string;
  lockdownLevel: "verified" | "static" | "none" | null;
  residualRisks: string[];
  auth: "logged_in" | "logged_out" | "unknown";
  /** e.g. "max"; never an email, org or account id. */
  plan: string | null;
  billing: BillingKind;
  /** Shown verbatim: "Run `claude auth login` in a terminal". */
  loginHint: string;
  modes: Array<"completion" | "runtime">;
  planUsage: PlanUsageView | null;
  checkedAt: string | null;
}

/** A local model server (Ollama) and the models it has. The app never pulls models. */
export interface LocalProviderStatus {
  id: "ollama";
  baseUrl: string;
  running: boolean;
  version: string | null;
  models: Array<{ id: string; tag: string; tools: boolean; vision: boolean; contextLength: number | null }>;
  detail: string;
}

export interface AgentSettingsView {
  v: AgentProtocolVersion;
  providers: ProviderKeyStatus[];
  secureStorage: { available: boolean; detail: string };
  /** False when this build takes no API keys (the Alpha 0 build): Settings shows no key entry. Absent: true. */
  apiKeysEnabled?: boolean;
  /** Effective model per role (the user's choice or the default routing). */
  models: Record<AgentRoleId, string>;
  defaults: Record<AgentRoleId, string>;
  profiles: ModelProfileInfo[];
  /** Per-task budget, USD. */
  budgetUsd: number;
  /** Base URL for OpenAI-compatible endpoints (vLLM, Ollama, OpenRouter, …); null = the profile's default. */
  compatBaseUrl: string | null;
  transport: AgentTransportKind;
  /** Routing problems, e.g. a judge from the designer's model family. */
  warnings: string[];
  /**
   * CLI agents found on this machine. Optional only so an older shell (and the app's test doubles) still type-check;
   * the desktop app always sets it.
   */
  cli?: CliProviderStatus[];
  /** Local model servers (Ollama). */
  local?: LocalProviderStatus[];
  /** Settings → Advanced: how CLI providers run the tool loops. */
  cliMode?: CliModeSetting;
  /** The provider the default models come from when the user chose none ("Using Claude Code (detected)"). */
  autoDefault?: { provider: ProviderId; label: string } | null;
  /** The Ollama base URL from Settings (null = http://127.0.0.1:11434). */
  ollamaBaseUrl?: string | null;
}

export interface SettingsUpdate {
  v: AgentProtocolVersion;
  /** Model per role; `null` resets a role to the default routing. */
  models?: Partial<Record<AgentRoleId, string | null>>;
  budgetUsd?: number;
  compatBaseUrl?: string | null;
  /** Path override per CLI (absolute, existing, executable, with the CLI's own file name); null clears it. */
  cliPaths?: Partial<Record<CliProviderId, string | null>>;
  cliMode?: CliModeSetting;
  /** https://…, or http:// on loopback; null restores http://127.0.0.1:11434. */
  ollamaBaseUrl?: string | null;
}

export interface SetApiKeyRequest {
  v: AgentProtocolVersion;
  provider: ApiProviderId;
  key: string;
}

export interface ClearApiKeyRequest {
  v: AgentProtocolVersion;
  provider: ApiProviderId;
}

/** Re-run detection (CLI version, lockdown, login; Ollama) now, bypassing the caches. */
export interface ProbeProvidersRequest {
  v: AgentProtocolVersion;
  /** Only these providers (default: all). */
  providers?: ProviderId[];
}

/** `window.aicad.agent` */
export interface AgentBridge {
  start(request: AgentStartRequest): Promise<AgentStartResponse>;
  answer(request: AgentAnswerRequest): Promise<{ ok: boolean }>;
  stop(request: AgentStopRequest): Promise<{ ok: boolean }>;
  /** Subscribe to run events; returns an unsubscribe function. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
}

/** `window.aicad.settings` */
export interface SettingsBridge {
  get(): Promise<AgentSettingsView>;
  update(update: SettingsUpdate): Promise<AgentSettingsView>;
  /** Encrypts and stores the key in the main process; the renderer never gets it back. */
  setApiKey(request: SetApiKeyRequest): Promise<AgentSettingsView>;
  clearApiKey(request: ClearApiKeyRequest): Promise<AgentSettingsView>;
  /** Channel `settings:probeProviders`. Optional only for older shells; the desktop app implements it. */
  probeProviders?(request: ProbeProvidersRequest): Promise<AgentSettingsView>;
}
