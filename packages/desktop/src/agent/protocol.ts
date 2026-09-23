/**
 * Runtime side of the agent protocol (v1; the types live in `@aicad/app/bridge`, see
 * `packages/app/src/agent-protocol.ts`).
 *
 * - `parse*` validate every renderer → main message. The renderer is sandboxed but still treated
 *   as untrusted input: shapes, sizes and enums are checked, unknown fields are dropped.
 * - {@link HostToWorker} / {@link WorkerToHost} are the main ⇄ agent utility process messages.
 *   API keys travel only in `start.secrets` (main → worker, in memory) and never come back.
 * - {@link composePrompt} turns selection chips into semantic context for the agent.
 */
import type {
  AgentAnswerRequest,
  AgentEvent,
  AgentProtocolVersion,
  AgentRoleId,
  AgentSelectionItem,
  AgentStartRequest,
  AgentStopRequest,
  ClearApiKeyRequest,
  ProviderId,
  SetApiKeyRequest,
  SettingsUpdate,
} from "@aicad/app/bridge";

export const PROTOCOL_VERSION: AgentProtocolVersion = 1;
export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "google", "openai-compat"];
export const ROLE_IDS: readonly AgentRoleId[] = ["designer", "judge", "triage", "spec_writer"];
export const MIN_BUDGET_USD = 0.01;
export const MAX_BUDGET_USD = 100;
const SELECTION_KINDS = ["feature", "face", "edge", "body"] as const;
const PROCESSES = ["fdm", "cnc", "laser", "any"] as const;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProtocolError(`${what} must be an object`);
  return v as Obj;
}

function version(o: Obj, what: string): void {
  if (o["v"] !== PROTOCOL_VERSION) throw new ProtocolError(`${what}: unsupported protocol version ${JSON.stringify(o["v"])} (expected ${PROTOCOL_VERSION})`);
}

function str(v: unknown, what: string, max: number, min = 0): string {
  if (typeof v !== "string") throw new ProtocolError(`${what} must be a string`);
  if (v.length > max) throw new ProtocolError(`${what} is too long (max ${max})`);
  if (v.length < min) throw new ProtocolError(`${what} is too short`);
  return v;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], what: string): T {
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new ProtocolError(`${what} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function id(v: unknown, what: string): string {
  const s = str(v, what, 100, 1);
  if (!/^[A-Za-z0-9_.:-]+$/.test(s)) throw new ProtocolError(`${what} has invalid characters`);
  return s;
}

export function parseBudget(v: unknown, what = "budgetUsd"): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < MIN_BUDGET_USD || v > MAX_BUDGET_USD) {
    throw new ProtocolError(`${what} must be a number between ${MIN_BUDGET_USD} and ${MAX_BUDGET_USD}`);
  }
  return Math.round(v * 100) / 100;
}

function selectionItem(v: unknown, i: number): AgentSelectionItem {
  const o = obj(v, `selection[${i}]`);
  const out: AgentSelectionItem = {
    kind: oneOf(o["kind"], SELECTION_KINDS, `selection[${i}].kind`),
    ref: str(o["ref"], `selection[${i}].ref`, 500, 1),
    label: str(o["label"], `selection[${i}].label`, 200),
  };
  if (o["description"] !== undefined) out.description = str(o["description"], `selection[${i}].description`, 1000);
  return out;
}

export function parseStartRequest(v: unknown): AgentStartRequest {
  const o = obj(v, "start request");
  version(o, "start request");
  const prompt = str(o["prompt"], "prompt", 20_000);
  if (prompt.trim().length === 0) throw new ProtocolError("prompt is empty");
  const selection = o["selection"] === undefined ? [] : o["selection"];
  if (!Array.isArray(selection) || selection.length > 32) throw new ProtocolError("selection must be an array of at most 32 items");
  const out: AgentStartRequest = {
    v: PROTOCOL_VERSION,
    prompt,
    source: str(o["source"], "source", 5_000_000),
    documentName: str(o["documentName"], "documentName", 200),
    selection: selection.map(selectionItem),
  };
  if (o["process"] !== undefined) out.process = oneOf(o["process"], PROCESSES, "process");
  if (o["settings"] !== undefined) {
    const s = obj(o["settings"], "settings");
    out.settings = s["budgetUsd"] === undefined ? {} : { budgetUsd: parseBudget(s["budgetUsd"], "settings.budgetUsd") };
  }
  return out;
}

export function parseAnswerRequest(v: unknown): AgentAnswerRequest {
  const o = obj(v, "answer request");
  version(o, "answer request");
  const answers = o["answers"];
  if (!Array.isArray(answers) || answers.length === 0 || answers.length > 10) throw new ProtocolError("answers must be an array of 1–10 strings");
  return {
    v: PROTOCOL_VERSION,
    runId: id(o["runId"], "runId"),
    questionId: id(o["questionId"], "questionId"),
    answers: answers.map((a, i) => str(a, `answers[${i}]`, 2000)),
  };
}

export function parseStopRequest(v: unknown): AgentStopRequest {
  const o = obj(v, "stop request");
  version(o, "stop request");
  return { v: PROTOCOL_VERSION, runId: id(o["runId"], "runId") };
}

/** http(s) URL without credentials; returns the normalized URL. */
export function parseBaseUrl(v: unknown): string {
  const s = str(v, "compatBaseUrl", 500, 1).trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ProtocolError("compatBaseUrl is not a valid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ProtocolError("compatBaseUrl must be an http(s) URL");
  if (u.username || u.password) throw new ProtocolError("compatBaseUrl must not contain credentials; enter the key separately");
  return s.replace(/\/+$/, "");
}

export function parseSettingsUpdate(v: unknown): SettingsUpdate {
  const o = obj(v, "settings update");
  version(o, "settings update");
  const out: SettingsUpdate = { v: PROTOCOL_VERSION };
  if (o["models"] !== undefined) {
    const m = obj(o["models"], "models");
    const models: Partial<Record<AgentRoleId, string | null>> = {};
    for (const [role, model] of Object.entries(m)) {
      const r = oneOf(role, ROLE_IDS, "models role");
      models[r] = model === null ? null : id(model, `models.${r}`);
    }
    out.models = models;
  }
  if (o["budgetUsd"] !== undefined) out.budgetUsd = parseBudget(o["budgetUsd"]);
  if (o["compatBaseUrl"] !== undefined) out.compatBaseUrl = o["compatBaseUrl"] === null ? null : parseBaseUrl(o["compatBaseUrl"]);
  return out;
}

/**
 * An API key as typed or pasted: trimmed, 8–512 printable non-space ASCII characters. The error
 * messages never echo the key.
 */
export function parseApiKey(v: unknown): string {
  if (typeof v !== "string") throw new ProtocolError("key must be a string");
  const key = v.trim();
  if (key.length < 8 || key.length > 512) throw new ProtocolError("key must be 8–512 characters");
  if (!/^[\x21-\x7e]+$/.test(key)) throw new ProtocolError("key contains spaces or non-printable characters");
  return key;
}

export function parseSetApiKey(v: unknown): SetApiKeyRequest {
  const o = obj(v, "setApiKey request");
  version(o, "setApiKey request");
  return { v: PROTOCOL_VERSION, provider: oneOf(o["provider"], PROVIDER_IDS, "provider"), key: parseApiKey(o["key"]) };
}

export function parseClearApiKey(v: unknown): ClearApiKeyRequest {
  const o = obj(v, "clearApiKey request");
  version(o, "clearApiKey request");
  return { v: PROTOCOL_VERSION, provider: oneOf(o["provider"], PROVIDER_IDS, "provider") };
}

// ─── Main ⇄ agent utility process ──────────────────────────────────────────────────────────

export type TransportConfig = { kind: "live" } | { kind: "scripted"; scriptPath: string } | { kind: "replay"; fixturesPath: string };

export interface WorkerRunConfig {
  /** Effective gateway profile id per role. */
  models: Record<AgentRoleId, string>;
  budgetUsd: number;
  compatBaseUrl: string | null;
  transport: TransportConfig;
  /** Forge CLI binary for the fallback engine. */
  forgeBin: string;
}

export type HostToWorker =
  | {
      type: "start";
      v: AgentProtocolVersion;
      runId: string;
      request: AgentStartRequest;
      config: WorkerRunConfig;
      /** API keys of the providers this run needs (in memory only; never echoed back). */
      secrets: Partial<Record<ProviderId, string>>;
    }
  | { type: "answer"; v: AgentProtocolVersion; runId: string; questionId: string; answers: string[] }
  | { type: "stop"; v: AgentProtocolVersion; runId: string };

export type WorkerToHost =
  | { type: "ready"; v: AgentProtocolVersion }
  | { type: "event"; v: AgentProtocolVersion; event: AgentEvent }
  | { type: "log"; v: AgentProtocolVersion; level: "info" | "warn" | "error"; message: string };

const TERMINAL: ReadonlySet<string> = new Set(["result", "error"]);

export function isTerminalEvent(e: Pick<AgentEvent, "type">): boolean {
  return TERMINAL.has(e.type);
}

/** Minimal shape check of a worker message (the worker is ours, but a crash can leave garbage). */
export function parseWorkerMessage(v: unknown): WorkerToHost | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Obj;
  if (o["v"] !== PROTOCOL_VERSION) return null;
  if (o["type"] === "ready") return { type: "ready", v: PROTOCOL_VERSION };
  if (o["type"] === "log" && typeof o["message"] === "string" && (o["level"] === "info" || o["level"] === "warn" || o["level"] === "error")) {
    return { type: "log", v: PROTOCOL_VERSION, level: o["level"], message: o["message"].slice(0, 4000) };
  }
  if (o["type"] === "event") {
    const e = o["event"] as Obj | undefined;
    if (!e || typeof e !== "object" || e["v"] !== PROTOCOL_VERSION || typeof e["runId"] !== "string" || typeof e["type"] !== "string" || typeof e["seq"] !== "number") return null;
    return { type: "event", v: PROTOCOL_VERSION, event: e as unknown as AgentEvent };
  }
  return null;
}

/**
 * Defence in depth for log lines: mask anything that looks like a provider key (`sk-…`, `AIza…`,
 * long opaque tokens), even though keys are never put into messages on purpose.
 */
export function scrubKeyLike(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{2})[A-Za-z0-9_-]{8,}/g, "$1…[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, "AIza…[redacted]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
}

// ─── Selection → semantic context ──────────────────────────────────────────────────────────

/**
 * The user's message plus the selection as a `<selection>` block the designer can resolve
 * "this" / "it" / "here" against (ARCHITECTURE §7 "selection-aware chat").
 */
export function composePrompt(prompt: string, selection: readonly AgentSelectionItem[]): string {
  const text = prompt.trim();
  if (selection.length === 0) return text;
  const lines = selection.map((s) => {
    const name = s.kind === "feature" ? s.label : s.ref;
    return `- ${s.kind} \`${name}\`${s.description ? ` — ${s.description}` : ""}`;
  });
  return [
    text,
    "",
    "<selection>",
    'The user selected these entities in the app (resolve "this", "it", "here" against them; face and edge names are Forge provenance names):',
    ...lines,
    "</selection>",
  ].join("\n");
}
