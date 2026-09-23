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
 * is configured, where it comes from and its last four characters.
 */

export type AgentProtocolVersion = 1;

/** LLM providers the gateway speaks (`@aicad/llm-gateway` `Provider`). */
export type ProviderId = "anthropic" | "openai" | "google" | "openai-compat";

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

export type AgentStartErrorCode = "NO_API_KEY" | "BUSY" | "INVALID_REQUEST" | "UNAVAILABLE";

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
  costUsd: number;
  budgetUsd: number;
  latencyMs: number;
  turns: number;
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
  | { type: "llm"; role: string; model: string; costUsd: number; summary: string }
  | { type: "cost"; spentUsd: number; budgetUsd: number }
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
  id: ProviderId;
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
}

export interface AgentSettingsView {
  v: AgentProtocolVersion;
  providers: ProviderKeyStatus[];
  secureStorage: { available: boolean; detail: string };
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
}

export interface SettingsUpdate {
  v: AgentProtocolVersion;
  /** Model per role; `null` resets a role to the default routing. */
  models?: Partial<Record<AgentRoleId, string | null>>;
  budgetUsd?: number;
  compatBaseUrl?: string | null;
}

export interface SetApiKeyRequest {
  v: AgentProtocolVersion;
  provider: ProviderId;
  key: string;
}

export interface ClearApiKeyRequest {
  v: AgentProtocolVersion;
  provider: ProviderId;
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
}
