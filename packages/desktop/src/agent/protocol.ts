/**
 * Runtime side of the agent protocol (v1; the types live in `@aicad/app/bridge`, see
 * `packages/app/src/agent-protocol.ts`).
 *
 * - `parse*` validate every renderer → main message. The renderer is sandboxed but still treated
 *   as untrusted input: shapes, sizes and enums are checked, unknown fields are dropped.
 * - {@link HostToWorker} / {@link WorkerToHost} are the main ⇄ agent utility process messages.
 *   API keys travel only in `start.secrets` (main → worker, in memory) and never come back.
 * - {@link composePrompt} turns selection chips into semantic context for the agent.
 * - {@link CliBinaryWire}: a detected CLI binary as it travels to the worker (plain JSON, no Sets).
 */
import { basename, isAbsolute, join } from "node:path";
import type {
  AgentAnswerRequest,
  AgentEvent,
  AgentProtocolVersion,
  AgentRoleId,
  AgentSelectionItem,
  AgentStartRequest,
  AgentStopRequest,
  ApiProviderId,
  ClearApiKeyRequest,
  CliModeSetting,
  CliProviderId,
  ProbeProvidersRequest,
  ProviderId,
  SetApiKeyRequest,
  SettingsUpdate,
} from "@aicad/app/bridge";
import type { CliBinary, ModelProfile } from "@aicad/llm-gateway";
import type { WorkerSelfTestReport } from "./self-test.js";

export const PROTOCOL_VERSION: AgentProtocolVersion = 1;
/** API-key providers: the only ones with keys (`keys.ts`). */
export const PROVIDER_IDS: readonly ApiProviderId[] = ["anthropic", "openai", "google", "openai-compat"];
/** CLI agents (ADR 0014), in the auto-default order of docs/CLI-PROVIDERS.md §9.3. */
export const CLI_PROVIDER_IDS: readonly CliProviderId[] = ["claude-cli", "codex-cli", "gemini-cli", "opencode", "cursor-agent"];
export const ALL_PROVIDER_IDS: readonly ProviderId[] = [...PROVIDER_IDS, ...CLI_PROVIDER_IDS, "ollama"];
export const CLI_MODES: readonly CliModeSetting[] = ["auto", "completion", "runtime"];

export function isApiProviderId(p: string): p is ApiProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(p);
}

export function isCliProviderId(p: string): p is CliProviderId {
  return (CLI_PROVIDER_IDS as readonly string[]).includes(p);
}
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

/** Loopback hosts, where cleartext http never leaves the machine: localhost, 127.0.0.0/8, [::1]. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  return m !== null && m[1] === "127" && m.slice(2).every((o) => Number(o) <= 255);
}

/**
 * Why a base URL must not receive an API key and the design, or null when it is fine: https
 * anywhere, cleartext http only on loopback, never credentials in the URL.
 */
export function baseUrlProblem(value: string): string | null {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "is not a valid URL";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "must be an http(s) URL";
  if (u.username || u.password) return "must not contain credentials; enter the key separately";
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) {
    return "must use https:// (cleartext http:// is allowed only for localhost, 127.0.0.0/8 and [::1])";
  }
  return null;
}

/** An https URL, or an http URL on a loopback host, without credentials; returns the normalized URL. */
export function parseBaseUrl(v: unknown, what = "compatBaseUrl"): string {
  const s = str(v, what, 500, 1).trim();
  const problem = baseUrlProblem(s);
  if (problem) throw new ProtocolError(`${what} ${problem}`);
  return s.replace(/\/+$/, "");
}

/**
 * A CLI path override as typed in Settings: an absolute path whose file name is one of the CLI's own names
 * (`claude`, `gemini`, …; `.exe`/`.cmd` on Windows). Whether it exists and is executable is checked by the main
 * process before it is stored (`cli-detect.ts` `cliPathProblem`), because that needs the file system.
 */
export function parseCliPath(v: unknown, provider: CliProviderId, binaryNames: readonly string[]): string {
  const s = str(v, `cliPaths.${provider}`, 1024, 1).trim();
  if (s.includes("\u0000")) throw new ProtocolError(`cliPaths.${provider} has invalid characters`);
  if (!isAbsolute(s)) throw new ProtocolError(`cliPaths.${provider} must be an absolute path`);
  const name = basename(s).replace(/\.(exe|cmd)$/i, "");
  if (!binaryNames.includes(name)) throw new ProtocolError(`cliPaths.${provider} must point to ${binaryNames.join(" or ")} (got ${JSON.stringify(basename(s))})`);
  return s;
}

export interface SettingsUpdateOptions {
  /** File names each CLI may have (`CliProvider.binaryNames`), for `cliPaths`. */
  cliBinaryNames?: Readonly<Partial<Record<CliProviderId, readonly string[]>>>;
}

export function parseSettingsUpdate(v: unknown, options: SettingsUpdateOptions = {}): SettingsUpdate {
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
  if (o["cliPaths"] !== undefined) {
    const m = obj(o["cliPaths"], "cliPaths");
    const paths: Partial<Record<CliProviderId, string | null>> = {};
    for (const [provider, path] of Object.entries(m)) {
      const p = oneOf(provider, CLI_PROVIDER_IDS, "cliPaths provider");
      paths[p] = path === null ? null : parseCliPath(path, p, options.cliBinaryNames?.[p] ?? []);
    }
    out.cliPaths = paths;
  }
  if (o["cliMode"] !== undefined) out.cliMode = oneOf(o["cliMode"], CLI_MODES, "cliMode");
  if (o["ollamaBaseUrl"] !== undefined) out.ollamaBaseUrl = o["ollamaBaseUrl"] === null ? null : parseBaseUrl(o["ollamaBaseUrl"], "ollamaBaseUrl");
  return out;
}

export function parseProbeProvidersRequest(v: unknown): ProbeProvidersRequest {
  const o = obj(v, "probeProviders request");
  version(o, "probeProviders request");
  const out: ProbeProvidersRequest = { v: PROTOCOL_VERSION };
  if (o["providers"] !== undefined) {
    const list = o["providers"];
    if (!Array.isArray(list) || list.length > ALL_PROVIDER_IDS.length) throw new ProtocolError("providers must be an array of provider ids");
    out.providers = [...new Set(list.map((p, i) => oneOf(p, ALL_PROVIDER_IDS, `providers[${i}]`)))];
  }
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

/**
 * A detected CLI binary as it crosses to the worker: `CliBinary` with its `--help` sets as arrays. The worker
 * rebuilds the `CliBinary`; the gateway re-stats the file before every spawn (size, mtime) and refuses a binary that
 * changed since detection, so a CLI that updated itself fails closed until Settings → Re-check.
 */
export interface CliBinaryWire {
  provider: CliProviderId;
  path: string;
  realPath: string;
  source: CliBinary["source"];
  version: string;
  rawVersion: string;
  help: { flags: string[]; subcommands: string[]; sha256: string; choices: Array<[string, string[]]> };
  stat: { size: number; mtimeMs: number };
}

export function binaryToWire(b: CliBinary): CliBinaryWire {
  return {
    provider: b.provider,
    path: b.path,
    realPath: b.realPath,
    source: b.source,
    version: b.version,
    rawVersion: b.rawVersion,
    help: { flags: [...b.help.flags], subcommands: [...b.help.subcommands], sha256: b.help.sha256, choices: [...(b.help.choices ?? new Map()).entries()].map(([k, v]) => [k, [...v]]) },
    stat: { size: b.stat.size, mtimeMs: b.stat.mtimeMs },
  };
}

export function binaryFromWire(w: CliBinaryWire): CliBinary {
  return {
    provider: w.provider,
    path: w.path,
    realPath: w.realPath,
    source: w.source,
    version: w.version,
    rawVersion: w.rawVersion,
    help: { flags: new Set(w.help.flags), subcommands: new Set(w.help.subcommands), sha256: w.help.sha256, choices: new Map(w.help.choices.map(([k, v]) => [k, v])) },
    stat: { size: w.stat.size, mtimeMs: w.stat.mtimeMs },
  };
}

/** How the MCP shim is launched by a CLI (`@aicad/mcp-server` `McpShimCommand`). */
export interface McpShimCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What the worker needs to run CLI providers (docs/CLI-PROVIDERS.md §11.1). */
export interface WorkerCliConfig {
  /** The detected binaries of the CLI providers the run's models use. */
  binaries: Partial<Record<CliProviderId, CliBinaryWire>>;
  mode: CliModeSetting;
  /** Private root for CLI workspaces and broker sockets (`<userData>/cli-work`, or a shorter private root: `setup.ts`). */
  workspaceRoot: string;
  /**
   * (additive) The host's CLI login locations and proxy settings (`CLI_ENV_LOCATION`, `CLI_ENV_NETWORK`), for CLI
   * children only. The utility process itself never has them in its own environment (`env.ts` `agentWorkerEnv`), so a
   * `NODE_EXTRA_CA_CERTS` or proxy from the app's environment cannot reach the process that holds the API keys.
   */
  childEnv?: Record<string, string>;
  /**
   * The app executable, for the MCP shim (`ELECTRON_RUN_AS_NODE=1 <exe> <mcp-server>/dist/stdio.js`); null when the
   * shim cannot run (then Gemini and opencode fall back to the text-json envelope, and runtime mode is off).
   */
  exePath: string | null;
  /** Development: the workspace's `packages/mcp-server` when the package is not a dependency of the desktop app. */
  mcpServerDir: string | null;
  /**
   * (additive) The bundled shim (`bundle/mcp/stdio.mjs`; asar-unpacked in a packaged build, so the app executable run
   * as Node can read it). When set it wins over {@link mcpServerDir}, and the MCP host is the one bundled into the worker.
   */
  mcpShimPath?: string | null;
}

/** macOS `sun_path` limit (Linux allows 107): the broker socket path must not be longer. */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * Whether the MCP broker socket fits under a CLI workspace root: the gateway puts it at `<root>/s/<8 hex>/b.sock`
 * (docs/CLI-PROVIDERS.md §5.4). Always true on Windows (named pipes).
 */
export function brokerSocketFits(root: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return true;
  return Buffer.byteLength(join(root, "s", "00000000", "b.sock"), "utf8") <= MAX_SOCKET_PATH_BYTES;
}

export interface WorkerRunConfig {
  /** Effective gateway profile id per role. */
  models: Record<AgentRoleId, string>;
  budgetUsd: number;
  compatBaseUrl: string | null;
  transport: TransportConfig;
  /** Forge CLI binary for the fallback engine. */
  forgeBin: string;
  /** Profiles beyond the built-in API and CLI ones: local (Ollama) and discovered CLI models. */
  profiles?: ModelProfile[];
  /** CLI providers (absent: the run uses none). */
  cli?: WorkerCliConfig;
  /** Base URLs of local model servers (`<ollama>/v1`): OpenAI-compatible calls there never get the compat key or override. */
  localEndpoints?: string[];
  /** Notes the run starts with (e.g. a plan-usage warning from the detection cache). */
  notes?: string[];
  /**
   * The machine and material conventions line of the active printer profile (ALPHA-0-PLAN W5), for
   * the Agent's `conventions` option. The runner passes it where it builds the Agent (W4b).
   */
  conventions?: string;
}

export type HostToWorker =
  | {
      type: "start";
      v: AgentProtocolVersion;
      runId: string;
      request: AgentStartRequest;
      config: WorkerRunConfig;
      /** API keys of the providers this run needs (in memory only; never echoed back). CLI runs need none. */
      secrets: Partial<Record<ApiProviderId, string>>;
    }
  | { type: "answer"; v: AgentProtocolVersion; runId: string; questionId: string; answers: string[] }
  | { type: "stop"; v: AgentProtocolVersion; runId: string }
  /**
   * `--self-test` only (main.ts): the worker checks its bundle and answers with a `selftest` message. `exePath` and
   * `workspaceRoot` are what a CLI run gets ({@link WorkerCliConfig}): the worker runs the MCP shim through them once.
   */
  | { type: "selftest"; v: AgentProtocolVersion; mcpShimPath: string | null; mcpServerDir: string | null; exePath: string | null; workspaceRoot: string | null };

export type WorkerToHost =
  | { type: "ready"; v: AgentProtocolVersion }
  | { type: "event"; v: AgentProtocolVersion; event: AgentEvent }
  | { type: "log"; v: AgentProtocolVersion; level: "info" | "warn" | "error"; message: string }
  /** A CLI broke its lockdown (§5.6): the main process marks that exact binary blocked until Re-check. */
  | { type: "cli"; v: AgentProtocolVersion; kind: "lockdown_violation"; provider: CliProviderId; realPath: string; detail: string }
  /** Process-group ids of the live CLI processes (the main process kills them if the worker dies: §5.8 backstop). */
  | { type: "procs"; v: AgentProtocolVersion; pids: number[] }
  /** The answer to a `selftest` request (`agent/self-test.ts`). */
  | { type: "selftest"; v: AgentProtocolVersion; report: WorkerSelfTestReport };

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
  if (o["type"] === "cli" && o["kind"] === "lockdown_violation" && typeof o["provider"] === "string" && isCliProviderId(o["provider"]) && typeof o["realPath"] === "string") {
    return { type: "cli", v: PROTOCOL_VERSION, kind: "lockdown_violation", provider: o["provider"], realPath: o["realPath"].slice(0, 4096), detail: typeof o["detail"] === "string" ? o["detail"].slice(0, 500) : "" };
  }
  if (o["type"] === "selftest" && typeof o["report"] === "object" && o["report"] !== null) {
    return { type: "selftest", v: PROTOCOL_VERSION, report: o["report"] as WorkerSelfTestReport };
  }
  if (o["type"] === "procs" && Array.isArray(o["pids"])) {
    const pids = o["pids"].filter((p): p is number => typeof p === "number" && Number.isInteger(p) && p > 1).slice(0, 64);
    return { type: "procs", v: PROTOCOL_VERSION, pids };
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
