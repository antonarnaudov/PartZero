/**
 * The agent host logic that runs inside the agent utility process (`worker.ts` wires it to
 * `process.parentPort`). Kept free of Electron so it is unit-testable in plain Node.
 *
 * One run at a time: `start` builds an {@link LLMGateway} with every provider kind the run's models need (ADR 0014):
 *
 * - API providers: the official SDK transports with the keys from the main process;
 * - CLI agents (Claude Code, Gemini CLI, Codex, opencode): `cliGatewayParts` from `@aicad/llm-gateway/cli`. Every
 *   completion-mode model call is one fresh, locked-down CLI invocation on the user's own login: built-in tools off,
 *   only our MCP server (when one is used), an empty 0700 workspace, an allowlisted environment, its own process group,
 *   the version gate and the runtime tripwires. In agent-runtime mode (`auto` when available, or `runtime`) each SPEC /
 *   BUILD / ASK phase is one such CLI process running its own loop over our CAD tools (`@aicad/agent/cli-runtime`,
 *   through the MCP broker). The binaries are the ones the main process detected; the gateway re-stats them before
 *   every spawn and refuses one that changed. A lockdown violation in either mode is reported to the main process,
 *   which blocks that binary;
 * - local models (Ollama): the OpenAI-compatible transport to the local endpoint, without the compat key;
 * - offline: the scripted / replay transports.
 *
 * It then runs `@aicad/agent` in interactive mode and streams {@link AgentEvent}s back:
 *
 *   trace state → `phase` · tool call → `tool` (summarized) · model call → `llm` + `cost` (notional for CLI plans)
 *   apply/rollback → `draft` (CadScript snapshot) · ask_user / budget checkpoint → `question`
 *   CLI plan usage → `plan` · end → `result` (proposal, summary, assumptions, known issues, cost) or `error`
 *
 * Every string that leaves this module is scrubbed of the run's API keys.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentApprovalRequest,
  AgentEvent,
  AgentEventBody,
  AgentModelInfo,
  AgentOpsReply,
  AgentOpsRequest,
  AgentQuestion,
  AgentQuestionKind,
  AgentRoleId,
  AgentRunResult,
  AgentStepView,
  ApiProviderId,
  BillingKind,
  CliProviderId,
  ProviderKindId,
} from "@aicad/app/bridge";
import {
  Agent,
  ScriptedTransport,
  type AgentOptions,
  type AgentResult,
  type AgentRuntime,
  type RuntimePhase,
  type RuntimePhaseOutcome,
  type RuntimePhaseSpec,
  type ScriptTurn,
  type Scripts,
  type TraceEvent,
} from "@aicad/agent";
import type { UserQuestion } from "@aicad/agent-tools";
import {
  AnthropicSdkTransport,
  BUILTIN_CLI_PROFILES,
  BUILTIN_LOCAL_PROFILES,
  BUILTIN_PROFILES,
  GatewayError,
  GoogleSdkTransport,
  LLMGateway,
  OpenAISdkTransport,
  profileKind,
  ReplayTransport,
  type Fixture,
  type ModelProfile,
  type PlanUsage,
  type Provider,
  type ProviderAdapter,
  type ProviderTransport,
  type TransportCall,
} from "@aicad/llm-gateway";
import {
  CLI_ENV_LOCATION,
  CLI_ENV_NETWORK,
  cliGatewayParts,
  liveCliProcessGroups,
  ollamaContextCheck,
  sweepCliWorkspaces,
  type CliMcpHost,
  type CliTurnOutcome,
} from "@aicad/llm-gateway/cli";
import { CommandEngineError, forgeWebCommandEngine, requireCommandEngine, type ForgeWebCommandModule, type HostState, type IrCommandEngine, type IrOp, type OpsApplyOptions, type OpsCommit, type OpsHost } from "@aicad/model-ops";
import type { metricsV1 } from "@aicad/ir-types";
import { planResetAt, planUsageView } from "./cli-detect.js";
import { bundledPromptsDir } from "../bundle-paths.js";
import { createAgentEngine, ForgeWebNodeEngine, type AgentEngine } from "./engine.js";
import { loadCliRuntime, loadMcpServer, mcpShimCommand, type CliRuntimeModule, type McpServerModule } from "./optional-modules.js";
import {
  baseUrlProblem,
  binaryFromWire,
  brokerSocketFits,
  composePrompt,
  isCliProviderId,
  MAX_SOCKET_PATH_BYTES,
  PROTOCOL_VERSION,
  type HostToWorker,
  type McpShimCommand,
  type WorkerCliConfig,
  type WorkerRunConfig,
  type WorkerToHost,
} from "./protocol.js";
import { displayProvider, providerLabel, routingFor } from "./settings.js";

export { loadCliRuntime, loadMcpServer, type CliRuntimeModule, type McpServerModule } from "./optional-modules.js";

export interface RunnerDeps {
  post(message: WorkerToHost): void;
  /** Engine factory (tests inject a fake; default: forge-web in Node → Forge CLI). */
  createEngine?(forgeBin: string): Promise<AgentEngine>;
  now?(): number;
  /**
   * The base environment CLI children start from (default: this process's, which the main process allowlisted). The
   * run's `WorkerCliConfig.childEnv` (CLI login locations, proxies) is added on top, for CLI children only.
   */
  env?(): Record<string, string>;
  /** Loads `@aicad/mcp-server` (tests inject; default {@link loadMcpServer}). */
  loadMcpServer?(dir: string | null, shimPath: string | null): Promise<{ module: McpServerModule; stdio: string } | null>;
  /** Loads the agent-runtime driver (`@aicad/agent/cli-runtime`) when the agent package has it (default {@link loadCliRuntime}). */
  loadCliRuntime?(): Promise<CliRuntimeModule | null>;
  /** The role prompts' folder (tests; default: a bundled worker's `bundle/prompts`, else the agent package's own). */
  promptsDir?: string | null;
}

// ─── Transports ────────────────────────────────────────────────────────────────────────────

/** A provider with no key: fails every call with an actionable message (the main process pre-checks, this is defence in depth). */
class MissingKeyTransport implements ProviderTransport {
  readonly #provider: string;
  constructor(provider: string) {
    this.#provider = provider;
  }
  #fail(): never {
    throw new GatewayError("auth", `No API key configured for ${this.#provider}. Add one in Settings.`);
  }
  send(): Promise<unknown> {
    this.#fail();
  }
  // eslint-disable-next-line require-yield
  async *stream(): AsyncIterable<unknown> {
    this.#fail();
  }
}

/**
 * OpenAI-compatible servers: one SDK client per base URL (the Settings override, else the profile's). A local model
 * server (`localEndpoints`, e.g. Ollama's `/v1`) always gets its own endpoint and never the compat key.
 */
class CompatTransport implements ProviderTransport {
  readonly #clients = new Map<string, OpenAISdkTransport>();
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string | null;
  readonly #local: ReadonlySet<string>;
  constructor(apiKey: string | undefined, baseUrl: string | null, localEndpoints: readonly string[] = []) {
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#local = new Set(localEndpoints.map((e) => e.replace(/\/+$/, "")));
  }
  #client(call: TransportCall): OpenAISdkTransport {
    const local = call.endpoint !== undefined && this.#local.has(call.endpoint.replace(/\/+$/, ""));
    const baseURL = local ? call.endpoint! : (this.#baseUrl ?? call.endpoint);
    if (!baseURL) throw new GatewayError("invalid_request", "No base URL for the OpenAI-compatible endpoint: set one in Settings.");
    // Settings are validated on the way in; this also covers a profile's endpoint (defence in depth).
    const problem = baseUrlProblem(baseURL);
    if (problem) throw new GatewayError("invalid_request", `The OpenAI-compatible base URL ${problem}.`);
    const cacheKey = `${local ? "local" : "compat"} ${baseURL}`;
    let c = this.#clients.get(cacheKey);
    if (!c) {
      c = new OpenAISdkTransport({ apiKey: local ? "not-needed" : (this.#apiKey ?? "not-needed"), baseURL }, "openai-compat");
      this.#clients.set(cacheKey, c);
    }
    return c;
  }
  // Async so that a refused endpoint is a rejected call (like any transport error), not a sync throw.
  async send(call: TransportCall): Promise<unknown> {
    return this.#client(call).send(call);
  }
  async *stream(call: TransportCall): AsyncIterable<unknown> {
    yield* this.#client(call).stream(call);
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}

/** Waits `ms` before each call (scripted demos: makes live progress visible; Stop can interrupt it). */
class PacedTransport implements ProviderTransport {
  readonly #inner: ProviderTransport;
  readonly #ms: number;
  constructor(inner: ProviderTransport, ms: number) {
    this.#inner = inner;
    this.#ms = ms;
  }
  async send(call: TransportCall): Promise<unknown> {
    await sleep(this.#ms, call.signal);
    return this.#inner.send(call);
  }
  async *stream(call: TransportCall): AsyncIterable<unknown> {
    await sleep(this.#ms, call.signal);
    yield* this.#inner.stream(call);
  }
}

/**
 * The CLI providers that broke their lockdown in this run (§5.6), shared by every CLI path of the run: the first
 * violation of a provider is reported once to the main process (which blocks that exact binary), and every later
 * completion call to it in the run is refused without spawning it.
 */
class CliViolations {
  readonly #seen = new Map<CliProviderId, string>();
  readonly #report: (provider: CliProviderId, detail: string) => void;
  constructor(report: (provider: CliProviderId, detail: string) => void) {
    this.#report = report;
  }
  blocked(provider: CliProviderId): string | null {
    return this.#seen.get(provider) ?? null;
  }
  record(provider: CliProviderId, detail: string): void {
    if (this.#seen.has(provider)) return;
    this.#seen.set(provider, detail.slice(0, 200));
    this.#report(provider, detail);
  }
}

/**
 * Completion mode: reports a CLI invocation that broke its lockdown so the main process blocks that binary, and
 * refuses every later call to that CLI in the same run. The outcome itself is unchanged: the adapter turns it into a
 * `lockdown_violation` gateway error and the run stops.
 */
class ObservedCliTransport implements ProviderTransport {
  readonly #inner: ProviderTransport;
  readonly #provider: CliProviderId;
  readonly #violations: CliViolations;
  constructor(inner: ProviderTransport, provider: CliProviderId, violations: CliViolations) {
    this.#inner = inner;
    this.#provider = provider;
    this.#violations = violations;
  }
  #refuse(): void {
    const blocked = this.#violations.blocked(this.#provider);
    if (blocked !== null) throw new GatewayError("lockdown_violation", `${this.#provider} is blocked for this run after a lockdown violation (${blocked}); press Re-check in Settings to test it again`);
  }
  #check(outcome: unknown): void {
    const f = (outcome as Partial<CliTurnOutcome> | null)?.failure;
    if (f?.code !== "lockdown_violation") return;
    this.#violations.record(this.#provider, f.message);
  }
  async send(call: TransportCall): Promise<unknown> {
    this.#refuse();
    const out = await this.#inner.send(call);
    this.#check(out);
    return out;
  }
  async *stream(call: TransportCall): AsyncIterable<unknown> {
    this.#refuse();
    for await (const out of this.#inner.stream(call)) {
      this.#check(out);
      yield out;
    }
  }
}

/** A scripted-transport file: `{ paceMs?, triage?: ScriptTurn[], spec_writer?: …, designer?: … }` (JSON). */
export function parseScriptFile(text: string): { scripts: Scripts; paceMs: number } {
  const j = JSON.parse(text) as Record<string, unknown>;
  if (typeof j !== "object" || j === null) throw new Error("script file must be a JSON object");
  const scripts: Scripts = {};
  for (const role of ["triage", "spec_writer", "designer"] as const) {
    const turns = j[role];
    if (turns === undefined) continue;
    if (!Array.isArray(turns)) throw new Error(`script.${role} must be an array of turns`);
    scripts[role] = turns.map((t, i) => {
      if (typeof t !== "object" || t === null) throw new Error(`script.${role}[${i}] must be an object`);
      const turn = t as ScriptTurn;
      if (turn.tools !== undefined && !Array.isArray(turn.tools)) throw new Error(`script.${role}[${i}].tools must be an array`);
      return turn;
    });
  }
  const pace = j["paceMs"];
  return { scripts, paceMs: typeof pace === "number" && pace > 0 ? Math.min(pace, 10_000) : 0 };
}

// ─── Agent runtime ─────────────────────────────────────────────────────────────────────────

/**
 * Runtime mode: reports a phase that ended in a lockdown violation (§5.6 steps 4 and 5; the orchestrator itself stops
 * the run with `lockdown_violation`), so the main process blocks that binary exactly as in completion mode.
 */
class ReportingRuntime implements AgentRuntime {
  readonly kind = "cli" as const;
  readonly #inner: AgentRuntime;
  readonly #violations: CliViolations;
  constructor(inner: AgentRuntime, violations: CliViolations) {
    this.#inner = inner;
    this.#violations = violations;
  }
  supports(profile: ModelProfile, phase: RuntimePhase): boolean {
    return this.#inner.supports(profile, phase);
  }
  async runPhase(spec: RuntimePhaseSpec): Promise<RuntimePhaseOutcome> {
    const outcome = await this.#inner.runPhase(spec);
    if (outcome.endedBy === "lockdown_violation" || outcome.failure?.code === "lockdown_violation") {
      const provider = outcome.cli?.provider ?? spec.profile.provider;
      if (isCliProviderId(provider)) this.#violations.record(provider, outcome.failure?.message ?? "lockdown violation");
    }
    return outcome;
  }
}

// ─── Gateway ───────────────────────────────────────────────────────────────────────────────

interface BuiltGateway {
  gateway: LLMGateway;
  note?: string;
  /** Extra agent options for CLI providers (the runtime, when available). */
  agentOptions?: Partial<AgentOptions> & Record<string, unknown>;
  notes?: string[];
}

export interface CliHooks {
  /** The environment CLI children start from (the worker's own plus the run's `childEnv`). */
  env(): Record<string, string>;
  onPlanUsage(usage: PlanUsage): void;
  onViolation(provider: CliProviderId, realPath: string, detail: string): void;
  loadMcpServer(dir: string | null, shimPath: string | null): Promise<{ module: McpServerModule; stdio: string } | null>;
  loadCliRuntime(): Promise<CliRuntimeModule | null>;
}

/** Every profile the worker knows: built-in API and CLI profiles plus the local and discovered ones from the main process. */
export function workerProfiles(extra: readonly ModelProfile[] | undefined): ModelProfile[] {
  const byId = new Map<string, ModelProfile>();
  for (const p of [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, ...(extra ?? BUILTIN_LOCAL_PROFILES)]) byId.set(p.id, p);
  return [...byId.values()];
}

/** The MCP shim command for CLIs: the app executable run as Node (development builds; packaged builds turn that off). */
function shimCommand(cli: WorkerCliConfig, stdio: string): McpShimCommand | null {
  return cli.exePath === null ? null : mcpShimCommand(cli.exePath, stdio);
}

/** The note for a workspace root whose broker socket would be too long (§5.4). */
function socketNote(root: string): string {
  return `The CLI workspace folder (${root}) is too long for the CAD MCP broker's socket (at most ${MAX_SOCKET_PATH_BYTES} bytes): CLI providers run one call at a time, and Gemini CLI and opencode answer through the text-json envelope.`;
}

async function cliParts(
  cli: WorkerCliConfig,
  hooks: CliHooks,
  runtime: CliRuntimeModule | null,
  violations: CliViolations,
): Promise<{ adapters: Partial<Record<Provider, ProviderAdapter>>; transports: Partial<Record<Provider, ProviderTransport>>; mcpHost: CliMcpHost | null; notes: string[] }> {
  const notes: string[] = [];
  const providers = (Object.keys(cli.binaries) as CliProviderId[]).filter(isCliProviderId);
  let mcpHost: CliMcpHost | null = null;
  // The MCP server is needed for the mcp-submit envelope (every CLI but Claude Code) and for the agent runtime.
  const needsMcp = providers.some((p) => p !== "claude-cli") || runtime !== null;
  // The broker listens on `<root>/s/<8 hex>/b.sock`; a root too long for that is checked here, not at the first phase.
  const socketOk = brokerSocketFits(cli.workspaceRoot);
  if (needsMcp && socketOk && cli.exePath !== null) {
    const loaded = await hooks.loadMcpServer(cli.mcpServerDir, cli.mcpShimPath ?? null).catch(() => null);
    const shim = loaded ? shimCommand(cli, loaded.stdio) : null;
    if (loaded && shim) mcpHost = loaded.module.createMcpHost({ shim });
  }
  if (mcpHost === null && socketOk && providers.some((p) => p === "gemini-cli" || p === "opencode")) {
    notes.push("The CAD MCP server is not available in this build: Gemini CLI and opencode answer through the text-json envelope.");
  }
  const parts = cliGatewayParts({
    providers,
    binary: async (provider) => {
      const w = cli.binaries[provider];
      if (!w) throw new GatewayError("not_installed", `${provider} is not available: open Settings and press Re-check`);
      return binaryFromWire(w);
    },
    env: hooks.env,
    ...(mcpHost ? { mcpHost } : {}),
    workspaceRoot: cli.workspaceRoot,
    onPlanUsage: hooks.onPlanUsage,
  });
  const transports: Partial<Record<Provider, ProviderTransport>> = {};
  for (const [id, t] of Object.entries(parts.transports) as Array<[CliProviderId, ProviderTransport]>) transports[id] = new ObservedCliTransport(t, id, violations);
  return { adapters: parts.adapters, transports, mcpHost, notes };
}

export async function buildGateway(config: WorkerRunConfig, secrets: Partial<Record<ApiProviderId, string>>, hooks?: CliHooks): Promise<BuiltGateway> {
  const t = config.transport;
  if (t.kind === "scripted") {
    const { scripts, paceMs } = parseScriptFile(readFileSync(t.scriptPath, "utf8"));
    const scripted = new ScriptedTransport(scripts);
    return {
      gateway: new LLMGateway({ transports: { anthropic: paceMs > 0 ? new PacedTransport(scripted, paceMs) : scripted }, onRoutingWarning: () => undefined }),
      note: "scripted transport (offline): model settings are ignored, no API calls are made",
    };
  }
  if (t.kind === "replay") {
    const fixtures = JSON.parse(readFileSync(t.fixturesPath, "utf8")) as Fixture[];
    if (!Array.isArray(fixtures)) throw new Error("replay fixtures file must be a JSON array of fixtures");
    return {
      gateway: new LLMGateway({ transports: { anthropic: new ReplayTransport(fixtures, { match: "sequential" }) }, onRoutingWarning: () => undefined }),
      note: "replay transport (offline): recorded responses, no API calls are made",
    };
  }
  const transports: Partial<Record<Provider, ProviderTransport>> = { ...liveTransports(secrets, config.compatBaseUrl, config.localEndpoints ?? []) };
  let adapters: Partial<Record<Provider, ProviderAdapter>> = {};
  const notes: string[] = [];
  let agentOptions: BuiltGateway["agentOptions"];
  if (config.cli && hooks) {
    const cli = config.cli;
    // One report per provider per run, whichever path (completion call or runtime phase) saw the violation.
    const violations = new CliViolations((provider, detail) => hooks.onViolation(provider, cli.binaries[provider]?.realPath ?? "", detail));
    const socketOk = brokerSocketFits(cli.workspaceRoot);
    const runtime = cli.mode !== "completion" && socketOk ? await hooks.loadCliRuntime().catch(() => null) : null;
    const parts = await cliParts(cli, hooks, runtime, violations);
    Object.assign(transports, parts.transports);
    adapters = parts.adapters;
    // Checked up front: without this the first runtime phase would fail with "broker socket path is longer than 103 bytes".
    const wantsBroker = cli.mode === "auto" || (Object.keys(cli.binaries) as CliProviderId[]).some((p) => p !== "claude-cli");
    if (!socketOk && wantsBroker) notes.push(socketNote(cli.workspaceRoot));
    notes.push(...parts.notes);
    agentOptions = { cliMode: cli.mode };
    if (cli.mode !== "completion") {
      if (runtime && parts.mcpHost) {
        try {
          const inner = new runtime.CliAgentRuntime({
            binary: async (provider) => {
              const w = cli.binaries[provider];
              if (!w) throw new GatewayError("not_installed", `${provider} is not available`);
              return binaryFromWire(w);
            },
            env: hooks.env,
            mcpHost: parts.mcpHost,
            workspaceRoot: cli.workspaceRoot,
          });
          agentOptions.runtime = new ReportingRuntime(inner, violations);
        } catch (e) {
          notes.push(`The CLI agent runtime could not start (${(e as Error).message}); CLI providers run one call at a time.`);
        }
      } else if (cli.mode === "runtime") {
        notes.push(
          brokerSocketFits(cli.workspaceRoot)
            ? "Agent-runtime mode is not available in this build (it needs @aicad/agent/cli-runtime, the CAD MCP server and the MCP shim): the run stops at the first tool loop. Pick \"Automatic (recommended)\" or \"Single calls only\" in Settings → Agent mode for CLI providers."
            : "Agent-runtime mode is not available: the CLI workspace folder is too long for the MCP broker's socket, so the run stops at the first tool loop. Pick \"Automatic (recommended)\" or \"Single calls only\" in Settings → Agent mode for CLI providers.",
        );
      }
    }
  }
  return {
    gateway: new LLMGateway({
      config: { routing: routingFor(config.models) },
      profiles: workerProfiles(config.profiles),
      transports,
      adapters,
      onRoutingWarning: () => undefined,
    }),
    notes,
    ...(agentOptions ? { agentOptions } : {}),
  };
}

/**
 * The providers' official API endpoints, passed explicitly: without a `baseURL` the SDKs read
 * `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `GOOGLE_GEMINI_BASE_URL` from the environment, which
 * would send the key from Settings to whatever endpoint the environment names. (The worker's
 * environment is allowlisted too; this holds even if it were not.)
 */
export const OFFICIAL_BASE_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/",
} as const;

/** Live SDK transports with the run's keys (the OpenAI-compatible endpoint comes from Settings or the profile). */
export function liveTransports(secrets: Partial<Record<ApiProviderId, string>>, compatBaseUrl: string | null, localEndpoints: readonly string[] = []): Record<ApiProviderId, ProviderTransport> {
  const k = secrets;
  return {
    anthropic: k.anthropic ? new AnthropicSdkTransport({ apiKey: k.anthropic, baseURL: OFFICIAL_BASE_URLS.anthropic }) : new MissingKeyTransport("Anthropic"),
    openai: k.openai ? new OpenAISdkTransport({ apiKey: k.openai, baseURL: OFFICIAL_BASE_URLS.openai }, "openai") : new MissingKeyTransport("OpenAI"),
    google: k.google ? new GoogleSdkTransport({ apiKey: k.google, baseURL: OFFICIAL_BASE_URLS.google }) : new MissingKeyTransport("Google Gemini"),
    "openai-compat": new CompatTransport(k["openai-compat"], compatBaseUrl, localEndpoints),
  };
}

// ─── Trace → protocol events ───────────────────────────────────────────────────────────────

/** Map an orchestrator trace event to protocol event bodies (without cost; see the run). */
export function traceToEvents(e: TraceEvent): AgentEventBody[] {
  switch (e.type) {
    case "state": {
      const i = e.text.indexOf(": ");
      return [{ type: "phase", phase: e.state, detail: i >= 0 ? e.text.slice(i + 2) : "" }];
    }
    case "tool": {
      const m = /^(\S+) (ok|ERROR): ([\s\S]*)$/.exec(e.text);
      return m ? [{ type: "tool", name: m[1]!, ok: m[2] === "ok", summary: m[3]!.slice(0, 400) }] : [{ type: "note", text: e.text.slice(0, 400) }];
    }
    case "llm": {
      const m = /^(\S+) (\S+) \$([\d.]+) ([\s\S]*)$/.exec(e.text);
      return m ? [{ type: "llm", role: m[1]!, model: m[2]!, costUsd: Number(m[3]), summary: m[4]!.slice(0, 300) }] : [{ type: "note", text: e.text.slice(0, 300) }];
    }
    case "note":
    case "stop":
      return [{ type: "note", text: e.text.slice(0, 600) }];
  }
}

/** Scrub every secret from all strings of a value (deep). */
export function redact<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const scrub = (s: string): string => secrets.reduce((acc, k) => (k.length >= 8 ? acc.split(k).join("[redacted]") : acc), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function toRunResult(r: AgentResult, baseSource: string, budgetUsd: number, billing?: BillingKind): AgentRunResult {
  const proposedSource = r.status === "answered" || r.cadscript === "" ? baseSource : r.cadscript;
  const passed = r.tests?.filter((t) => t.pass).length;
  // The live operator changed the open document itself: "changed" is whether any step stayed.
  const kept = r.surface === "ops" ? (r.steps ?? []).filter((s) => s.ok && !s.undone).length : 0;
  const out: AgentRunResult = {
    status: r.status,
    stopReason: r.stopReason,
    message: r.message,
    baseSource,
    proposedSource,
    changed: r.surface === "ops" ? kept > 0 : proposedSource !== baseSource,
    ...(r.surface === "ops" ? { surface: "ops" as const, steps: kept } : {}),
    verified: r.verified,
    summary: r.proposal?.summary ?? r.message,
    assumptions: r.proposal?.assumptions ?? [],
    knownIssues: r.proposal?.known_issues ?? [],
    costUsd: r.costUsd,
    budgetUsd,
    latencyMs: r.latencyMs,
    turns: r.turns,
  };
  if (r.answer !== undefined) out.answer = r.answer;
  if (r.tests && r.tests.length > 0) out.tests = { passed: passed ?? 0, total: r.tests.length };
  if (billing !== undefined) out.billing = billing;
  return out;
}

/** The model info a `started` event carries: local profiles are shown as Ollama's. */
export function modelInfo(p: ModelProfile): AgentModelInfo {
  return { id: p.id, name: p.displayName, provider: displayProvider(p), kind: profileKind(p) as ProviderKindId, billing: (p.billing ?? "metered") as BillingKind };
}

// ─── One run ───────────────────────────────────────────────────────────────────────────────

/** How long the worker waits for the renderer to answer one op (an evaluation of a large part included). */
export const OPS_REPLY_TIMEOUT_MS = 120_000;

/**
 * The renderer's open document as an {@link OpsHost}, for the live operator in this process: every
 * `apply` / `undo` / read travels to the window that started the run (worker → main → renderer, the
 * app's `appOpsHost`: its command registry as the agent, in the run's undo group) and back. Reports
 * and read-only queries run here, on this process's own Forge engine, from the document text.
 */
export class RemoteOpsHost implements OpsHost {
  readonly #call: (method: AgentOpsRequest["method"], ops?: readonly IrOp[], options?: OpsApplyOptions) => Promise<unknown>;
  readonly #engine: IrCommandEngine | null;
  #reports = new Map<string, Promise<metricsV1.EvalReport>>();

  constructor(call: (method: AgentOpsRequest["method"], ops?: readonly IrOp[], options?: OpsApplyOptions) => Promise<unknown>, engine: IrCommandEngine | null) {
    this.#call = call;
    this.#engine = engine;
  }

  async document(): Promise<string> {
    const v = await this.#call("document");
    if (typeof v !== "string") throw new CommandEngineError("IR_UNAVAILABLE", "the app returned no document");
    return v;
  }

  async hostState(): Promise<HostState> {
    const v = (await this.#call("hostState")) as Partial<HostState> | null;
    return { rollback: typeof v?.rollback === "string" ? v.rollback : null, appearance: v?.appearance && typeof v.appearance === "object" ? { ...v.appearance } : {} };
  }

  async apply(ops: readonly IrOp[], options: OpsApplyOptions = {}): Promise<OpsCommit> {
    const v = (await this.#call("apply", ops, options)) as OpsCommit | null;
    if (!v || typeof v !== "object" || typeof v.changed !== "boolean") throw new CommandEngineError("IR_UNAVAILABLE", "the app returned no transaction result");
    return v;
  }

  async report(): Promise<metricsV1.EvalReport> {
    const doc = await this.document();
    const hit = this.#reports.get(doc);
    if (hit) return hit;
    const p = this.engine().report(doc);
    this.#reports.clear();
    this.#reports.set(doc, p);
    return p;
  }

  engine(): IrCommandEngine {
    return requireCommandEngine(this.#engine, "the agent process has no Forge WASM engine");
  }

  async undo(): Promise<boolean> {
    return (await this.#call("undo")) === true;
  }
}

class Run {
  readonly id: string;
  readonly controller = new AbortController();
  #seq = 0;
  #questions = 0;
  #pending: { questionId: string; questions: readonly UserQuestion[]; resolve: (answers: string[]) => void } | null = null;
  #opsSeq = 0;
  readonly #opsPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #t0: number;
  readonly #deps: RunnerDeps;
  readonly #secrets: string[];
  #done = false;

  constructor(id: string, deps: RunnerDeps, secrets: readonly string[]) {
    this.id = id;
    this.#deps = deps;
    this.#secrets = [...secrets];
    this.#t0 = this.#now();
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  get done(): boolean {
    return this.#done;
  }

  emit(body: AgentEventBody): void {
    if (this.#done) return;
    const event = redact({ v: PROTOCOL_VERSION, runId: this.id, seq: ++this.#seq, t: Math.round(this.#now() - this.#t0), ...body } as AgentEvent, this.#secrets);
    if (body.type === "result" || body.type === "error") {
      this.#done = true;
      this.#failOps("IR_GROUP_CLOSED", "the run has ended");
    }
    this.#deps.post({ type: "event", v: PROTOCOL_VERSION, event });
  }

  /** One op call on the renderer's document (the live operator), answered by {@link Run.opsReply}. */
  ops(method: AgentOpsRequest["method"], ops?: readonly IrOp[], options?: OpsApplyOptions): Promise<unknown> {
    if (this.#done) return Promise.reject(new CommandEngineError("IR_GROUP_CLOSED", "the run has ended"));
    const id = ++this.#opsSeq;
    const request: AgentOpsRequest = {
      v: PROTOCOL_VERSION,
      runId: this.id,
      id,
      method,
      ...(ops ? { ops: [...ops] } : {}),
      ...(options && (options.label || options.ack) ? { options: { ...(options.label ? { label: options.label } : {}), ...(options.ack ? { ack: [...options.ack] } : {}) } } : {}),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#opsPending.delete(id);
        reject(new CommandEngineError("APP_UNREACHABLE", `the app did not answer the ${method} op in ${Math.round(OPS_REPLY_TIMEOUT_MS / 1000)} s`));
      }, OPS_REPLY_TIMEOUT_MS);
      (timer as { unref?: () => void }).unref?.();
      this.#opsPending.set(id, { resolve, reject, timer });
      this.#deps.post({ type: "ops", v: PROTOCOL_VERSION, request });
    });
  }

  opsReply(reply: AgentOpsReply): void {
    const p = this.#opsPending.get(reply.id);
    if (!p) return;
    this.#opsPending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply.value);
    else p.reject(new CommandEngineError(reply.error.code, reply.error.message, (reply.error.errors ?? []) as never, reply.error.details ?? {}));
  }

  #failOps(code: string, message: string): void {
    for (const [id, p] of this.#opsPending) {
      clearTimeout(p.timer);
      p.reject(new CommandEngineError(code, message));
      this.#opsPending.delete(id);
    }
  }

  ask(kind: AgentQuestionKind, questions: readonly UserQuestion[], extra: { step?: AgentStepView; approval?: AgentApprovalRequest } = {}): Promise<string[]> {
    const questionId = `q${++this.#questions}`;
    const qs: AgentQuestion[] = questions.map((q) => ({ id: q.id, question: q.question, default: q.default, ...(q.options && q.options.length > 0 ? { options: q.options } : {}) }));
    this.emit({ type: "question", questionId, kind, questions: qs, ...(extra.step ? { step: extra.step } : {}), ...(extra.approval ? { approval: extra.approval } : {}) });
    return new Promise((resolve) => {
      if (this.controller.signal.aborted) return resolve(questions.map((q) => q.default));
      this.#pending = { questionId, questions, resolve };
    });
  }

  answer(questionId: string, answers: readonly string[]): boolean {
    const p = this.#pending;
    if (!p || p.questionId !== questionId) return false;
    this.#pending = null;
    const full = p.questions.map((q, i) => (answers[i]?.trim() ? answers[i]!.trim() : q.default));
    this.emit({ type: "answered", questionId, answers: full });
    p.resolve(full);
    return true;
  }

  stop(): void {
    this.controller.abort();
    const p = this.#pending;
    if (p) {
      this.#pending = null;
      p.resolve(p.questions.map((q) => q.default));
    }
  }
}

function processEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

const CHILD_ENV_NAMES: ReadonlySet<string> = new Set([...CLI_ENV_LOCATION, ...CLI_ENV_NETWORK].map((k) => k.toUpperCase()));

/**
 * The run's `childEnv` as CLI children may get it: only CLI login locations and proxy settings (defence in depth: the
 * main process sends nothing else, and the gateway allowlists again per CLI).
 */
export function cliChildEnv(raw: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (typeof v === "string" && v.length <= 8192 && CHILD_ENV_NAMES.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

/** Plan-limit stops (§12): what the result says about them, from the stop message and the plan usage seen in the run. */
export function quotaInfo(
  r: Pick<AgentResult, "stopReason" | "message">,
  plans: ReadonlyMap<string, PlanUsage>,
  fallbackProvider: string | null,
): { kind: "quota_exhausted" | "rate_limited"; provider: string | null; resetsAt: string | null } | null {
  if (r.stopReason !== "model_error") return null;
  const m = /\b(quota_exhausted|rate_limited)\b(?:\):\s*([a-z][a-z0-9-]*):)?/.exec(r.message);
  if (!m) return null;
  const kind = m[1] as "quota_exhausted" | "rate_limited";
  const rejected = [...plans.values()].filter((u) => u.status === "rejected");
  const provider = m[2] !== undefined && isCliProviderId(m[2]) ? m[2] : (rejected.at(-1)?.provider ?? fallbackProvider);
  const plan = (provider !== null ? plans.get(provider) : undefined) ?? rejected.at(-1);
  // The reset of the window that ran out (the 5-hour one, typically), not the latest window's (days later).
  const resetsAt = plan?.status === "rejected" ? planResetAt(plan.windows) : null;
  return { kind, provider, resetsAt };
}

export class AgentRunner {
  readonly #deps: RunnerDeps;
  #run: Run | null = null;
  #swept = new Set<string>();

  constructor(deps: RunnerDeps) {
    this.#deps = deps;
  }

  get busy(): boolean {
    return this.#run !== null && !this.#run.done;
  }

  handle(message: HostToWorker): void {
    switch (message.type) {
      case "start":
        void this.#start(message);
        return;
      case "answer":
        if (this.#run?.id === message.runId) this.#run.answer(message.questionId, message.answers);
        return;
      case "stop":
        if (this.#run?.id === message.runId) this.#run.stop();
        return;
      case "opsReply":
        if (this.#run?.id === message.reply.runId) this.#run.opsReply(message.reply);
        return;
    }
  }

  /** Resolves when the current run (if any) has finished. */
  async #start(msg: Extract<HostToWorker, { type: "start" }>): Promise<void> {
    const secretValues = Object.values(msg.secrets).filter((s): s is string => typeof s === "string" && s.length > 0);
    const run = new Run(msg.runId, this.#deps, secretValues);
    if (this.busy) {
      run.emit({ type: "error", code: "BUSY", message: "Another agent run is in progress." });
      return;
    }
    this.#run = run;
    const { request, config } = msg;
    let lastPids = "";
    const reportProcs = (): void => {
      const pids = liveCliProcessGroups();
      const key = pids.join(",");
      if (key === lastPids) return;
      lastPids = key;
      this.#deps.post({ type: "procs", v: PROTOCOL_VERSION, pids });
    };
    const procTimer = config.cli ? setInterval(reportProcs, 500) : null;
    (procTimer as { unref?: () => void } | null)?.unref?.();
    try {
      if (config.cli && !this.#swept.has(config.cli.workspaceRoot)) {
        this.#swept.add(config.cli.workspaceRoot);
        // Leftovers of crashed runs older than 24 h (the workspace root is private to this app).
        await sweepCliWorkspaces(config.cli.workspaceRoot).catch(() => 0);
      }
      const baseEnv = this.#deps.env ?? processEnv;
      const childEnv = cliChildEnv(config.cli?.childEnv);
      // Plan usage reaches the runner twice for a completion call (the gateway's CLI hook and the orchestrator's
      // `onPlanUsage`) and once for a runtime phase (the orchestrator only): one `plan` event per distinct report.
      const plans = new Map<string, PlanUsage>();
      const planKeys = new Map<string, string>();
      const onPlanUsage = (usage: PlanUsage): void => {
        const view = planUsageView(usage);
        const key = JSON.stringify(view);
        plans.set(usage.provider, usage);
        if (planKeys.get(usage.provider) === key) return;
        planKeys.set(usage.provider, key);
        run.emit({ type: "plan", provider: usage.provider, usage: view });
      };
      const hooks: CliHooks = {
        env: () => ({ ...baseEnv(), ...childEnv }),
        onPlanUsage,
        onViolation: (provider, realPath, detail) => this.#deps.post({ type: "cli", v: PROTOCOL_VERSION, kind: "lockdown_violation", provider, realPath, detail: detail.slice(0, 300) }),
        loadMcpServer: this.#deps.loadMcpServer ?? loadMcpServer,
        loadCliRuntime: this.#deps.loadCliRuntime ?? loadCliRuntime,
      };
      const built = await buildGateway(config, msg.secrets, hooks);
      const { gateway, note } = built;
      const engine = await (this.#deps.createEngine ?? createAgentEngine)(config.forgeBin);
      const models: Partial<Record<AgentRoleId, AgentModelInfo>> = {};
      const profiles: Partial<Record<AgentRoleId, ModelProfile>> = {};
      for (const role of ["designer", "spec_writer", "triage", "judge"] as const) {
        const p = gateway.profile(gateway.router.resolve(role).model);
        profiles[role] = p;
        models[role] = modelInfo(p);
      }
      const offline = config.transport.kind !== "live";
      const billingOf = (id: string): BillingKind | undefined => (gateway.registry.has(id) ? ((gateway.profile(id).billing ?? "metered") as BillingKind) : undefined);
      const planRun = !offline && (["designer", "spec_writer", "triage"] as const).some((r) => profiles[r]?.billing === "subscription");
      const budgetUsd = request.settings?.budgetUsd ?? config.budgetUsd;
      const live = request.surface === "ops";
      const autonomy = config.autonomy ?? "review";
      run.emit({ type: "started", models, budgetUsd, transport: config.transport.kind, engine: engine.label, ...(live ? { surface: "ops" as const, autonomy } : {}) });
      if (note) run.emit({ type: "note", text: note });
      for (const text of [...(config.notes ?? []), ...(built.notes ?? [])]) run.emit({ type: "note", text });
      // Local models behind Ollama's /v1 endpoint: warn when the server's context is below what the profile needs.
      const localChecked = new Set<string>();
      const checkLocal = async (p: ModelProfile | undefined): Promise<void> => {
        if (!p || offline || profileKind(p) !== "local" || localChecked.has(p.id)) return;
        const r = await ollamaContextCheck(p, { allowRemote: true }).catch(() => null);
        if (r?.ok !== null && r !== null) localChecked.add(p.id);
        if (r?.warning) run.emit({ type: "note", text: r.warning });
      };
      for (const role of ["designer", "spec_writer", "triage"] as const) await checkLocal(profiles[role]);
      let lastCost = -1;
      const emitCost = (): void => {
        const spent = gateway.totalCostUsd;
        if (spent !== lastCost) {
          lastCost = spent;
          const notional = planRun || gateway.ledger.some((e) => e.billing === "subscription");
          run.emit({ type: "cost", spentUsd: spent, budgetUsd, ...(notional ? { notional: true } : {}) });
        }
      };
      emitCost();
      const options: AgentOptions = {
        gateway,
        engine: engine.engine,
        budgetUsd,
        mode: "interactive",
        askUser: (qs) => run.ask("clarify", qs),
        signal: run.controller.signal,
        taskId: `app-${msg.runId}`,
        hooks: {
          onEvent: (e) => {
            for (const body of traceToEvents(e)) {
              if (body.type === "llm") {
                const billing = billingOf(body.model);
                run.emit(billing === undefined ? body : { ...body, billing });
                if (gateway.registry.has(body.model)) void checkLocal(gateway.profile(body.model));
              } else run.emit(body);
            }
            if (e.type === "llm") emitCost();
          },
          onDraft: (d) => run.emit({ type: "draft", source: d.source, applyIndex: d.applyIndex, verified: d.verified, reason: d.reason }),
          onBudgetCheckpoint: async ({ spentUsd, capUsd }) => {
            const question = planRun
              ? `About 80 % of this task's plan-usage budget is spent (≈ $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} at API list prices; not billed). Continue up to the cap?`
              : `The task has spent $${spentUsd.toFixed(2)} of its $${capUsd.toFixed(2)} budget (80 %). Continue up to the cap?`;
            const [a] = await run.ask("budget", [{ id: "continue", question, options: ["Continue", "Stop here"], default: "Stop here" }]);
            return a === "Continue";
          },
          // Every CLI plan report of the run, runtime phases included (§12): the main process caches it for Settings.
          onPlanUsage,
        },
        // (additive, ADR 0014) `cliMode` and, when the agent package provides it, the CLI agent runtime.
        ...built.agentOptions,
      };
      // A bundled worker ships the role prompts next to it (bundle-paths.ts); unbundled, the agent package's own.
      const promptsDir = this.#deps.promptsDir !== undefined ? this.#deps.promptsDir : bundledPromptsDir(dirname(fileURLToPath(import.meta.url)));
      if (promptsDir !== null) options.promptsDir = promptsDir;
      if (config.conventions) options.conventions = config.conventions;
      if (live) {
        // The live operator: it operates the renderer's open document through the ops channel; reports and
        // queries run on this process's Forge engine.
        const commands = engine.engine instanceof ForgeWebNodeEngine ? forgeWebCommandEngine((await engine.engine.module()) as unknown as ForgeWebCommandModule) : null;
        options.ops = new RemoteOpsHost((method, ops, o) => run.ops(method, ops, o), commands);
        options.autonomy = autonomy;
        const hooks = options.hooks!;
        hooks.onStep = (s) => run.emit({ type: "step", step: { ...s } });
        hooks.onPlan = (steps) => run.emit({ type: "outline", steps: steps.map((x) => x.slice(0, 200)).slice(0, 12) });
        hooks.reviewStep = async (s) => {
          const [a] = await run.ask("step", [{ id: "step", question: `Step ${s.index}: ${s.note}. Keep it?`, options: ["Keep", "Undo"], default: "Keep" }], { step: { ...s } });
          return a === "Undo" ? "undo" : "keep";
        };
        hooks.requestApproval = async (req) => {
          const what = [...req.features.map((f) => `feature ${f}`), ...req.params.map((p) => `parameter ${p}`), ...(req.rollback ? ["the rollback marker"] : [])].join(", ");
          const [a] = await run.ask("approval", [{ id: "approval", question: `The agent asks to change your ${what}: ${req.reason}`, options: ["Allow", "Don't allow"], default: "Don't allow" }], { approval: { ...req } });
          return a === "Allow";
        };
      }
      const agent = new Agent(options);
      const result = await agent.run({
        prompt: composePrompt(request.prompt, request.selection),
        context: !live && request.source.trim() ? request.source : undefined,
        name: request.documentName || "document",
        process: request.process,
      });
      emitCost();
      const out = toRunResult(result, request.source, budgetUsd, offline ? undefined : (profiles.designer?.billing as BillingKind | undefined));
      const designerProvider = profiles.designer && isCliProviderId(profiles.designer.provider) ? profiles.designer.provider : null;
      const quota = offline ? null : quotaInfo(result, plans, designerProvider);
      if (quota !== null) {
        const who = quota.provider !== null && isCliProviderId(quota.provider) ? providerLabel(quota.provider) : "The provider";
        const what =
          quota.kind === "quota_exhausted"
            ? `${who}: your plan's usage limit is reached${quota.resetsAt ? `; it resets at ${quota.resetsAt}` : ""}.`
            : `${who} is rate limiting requests${quota.resetsAt ? ` until ${quota.resetsAt}` : ""}; try again later.`;
        out.quota = { kind: quota.kind, provider: quota.provider, resetsAt: quota.resetsAt };
        out.message = `${what} (${out.message})`;
        out.summary = out.message;
      }
      run.emit({ type: "result", result: out });
    } catch (e) {
      run.emit({ type: "error", code: e instanceof GatewayError ? `GATEWAY_${e.code.toUpperCase()}` : "RUN_FAILED", message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (procTimer !== null) clearInterval(procTimer);
      reportProcs();
    }
  }
}
