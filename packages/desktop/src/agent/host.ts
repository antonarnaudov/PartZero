/**
 * `AgentHost`: the main-process side of the in-app agent.
 *
 * - Validates renderer requests (`protocol.ts`), resolves settings, keys and provider readiness, and starts runs in
 *   the agent utility process (forked lazily, re-forked after a crash).
 * - Providers (ADR 0014): API keys are optional. CLI agents are detected here (`cli-detect.ts`: version, lockdown,
 *   login, no model call) and local models probed (`local-detect.ts`); the start precheck refuses a run whose models
 *   need a CLI that is missing, too old, blocked or logged out, or a local model that is not there, with the provider,
 *   the roles and the fix (docs/CLI-PROVIDERS.md §11.3).
 * - Forwards the worker's event stream to the renderer, unchanged except for crash/timeout events it synthesizes
 *   itself; caches plan usage, blocks a CLI binary after a lockdown violation, kills the CLI process groups the
 *   worker reported if the worker dies (§5.8 backstop), and empties the CLI workspace root on quit.
 * - Keys: resolved here (keychain → env → `.env`) only for the API providers a run needs, posted to the worker in the
 *   `start` message, and never sent anywhere else. CLI runs need none: the CLI uses its own login.
 */
import type {
  AgentAnswerRequest,
  AgentEvent,
  AgentEventBody,
  AgentRoleId,
  AgentSettingsView,
  AgentStartErrorCode,
  AgentStartResponse,
  AgentStopRequest,
  ApiProviderId,
  CliProviderId,
  CliProviderStatus,
  LocalProviderStatus,
  SettingsUpdate,
} from "@aicad/app/bridge";
import { profileKind, type ProfileRegistry } from "@aicad/llm-gateway";
import { cliPathProblem, planResetAt, type CliDetector } from "./cli-detect.js";
import { providerInfo, type KeyResolver } from "./keys.js";
import type { LocalModels } from "./local-detect.js";
import { clearCliWorkspaces } from "./workspaces.js";
import {
  binaryToWire,
  isCliProviderId,
  isTerminalEvent,
  parseAnswerRequest,
  parseProbeProvidersRequest,
  parseSettingsUpdate,
  parseStartRequest,
  parseStopRequest,
  parseWorkerMessage,
  PROTOCOL_VERSION,
  ProtocolError,
  scrubKeyLike,
  type CliBinaryWire,
  type HostToWorker,
  type TransportConfig,
  type WorkerRunConfig,
} from "./protocol.js";
import {
  autoDefaults,
  buildSettingsView,
  cliProblem,
  displayProvider,
  effectiveModels,
  profileRegistry,
  providerLabel,
  providersForRun,
  readinessFrom,
  RUN_ROLES,
  type SettingsStore,
} from "./settings.js";

/** The utility process as the host sees it (Electron `UtilityProcess`, or a fake in tests). */
export interface WorkerHandle {
  postMessage(message: HostToWorker): void;
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
}

/** What the worker needs to run CLI providers, besides the detected binaries. */
export interface CliRunSetup {
  /**
   * Private root for CLI workspaces and broker sockets (`<userData>/cli-work`, or a per-profile private folder:
   * `setup.ts`). Exclusive to this app instance: {@link AgentHost.dispose} empties it on quit.
   */
  workspaceRoot: string;
  /** The app executable for the MCP shim, or null when it cannot run as Node (packaged builds). */
  exePath: string | null;
  /** Development: the workspace's `packages/mcp-server`. */
  mcpServerDir: string | null;
  /** CLI login locations and proxy settings for CLI children only (`env.ts` `cliChildHostEnv`). */
  childEnv?: Record<string, string>;
  /** What the `auto` CLI mode means here (`env.ts` `DevOverrides.cliAutoMode`; default `runtime`). */
  autoMode?: "runtime" | "completion";
}

export interface AgentHostDeps {
  spawnWorker(): WorkerHandle;
  keys: KeyResolver;
  settings: SettingsStore;
  transport: TransportConfig;
  forgeBin: string;
  /** Deliver an event to the renderer. */
  send(event: AgentEvent): void;
  log?(level: "info" | "warn" | "error", message: string): void;
  /** How long a stopped run may take to wind down before the process is killed (default 8 s). */
  stopGraceMs?: number;
  newRunId?(): string;
  now?(): number;
  /** CLI agent detection (absent: no CLI provider is ever ready, e.g. unit tests of API-only behavior). */
  cli?: CliDetector;
  /** Local model server (absent: no local provider). */
  local?: LocalModels;
  cliRun?: CliRunSetup;
  /** Why CLI providers are off in this app (no private workspace root, `setup.ts`): shown in Settings and by the start precheck. */
  cliOff?: string;
  /** Backstop when the worker dies: kill one CLI process group (default: SIGKILL to `-pid`). */
  killProcessGroup?(pid: number): void;
}

interface ActiveRun {
  runId: string;
  startedAt: number;
  lastSeq: number;
  stopTimer: ReturnType<typeof setTimeout> | null;
}

interface Precheck {
  code: AgentStartErrorCode;
  message: string;
}

let counter = 0;

function defaultKillGroup(pid: number): void {
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL");
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export class AgentHost {
  readonly #deps: AgentHostDeps;
  #registry: ProfileRegistry;
  #worker: WorkerHandle | null = null;
  #run: ActiveRun | null = null;
  #starting = false;
  #cliGroups: number[] = [];
  /** The worker that reported {@link #cliGroups}: a replaced worker's late exit must not kill its successor's CLIs. */
  #cliGroupsOwner: WorkerHandle | null = null;

  constructor(deps: AgentHostDeps) {
    this.#deps = deps;
    this.#registry = profileRegistry(deps.local?.profiles());
  }

  get activeRunId(): string | null {
    return this.#run?.runId ?? null;
  }

  get registry(): ProfileRegistry {
    return this.#registry;
  }

  /** Whether provider detection applies: offline (scripted / replay) runs ignore model settings and never spawn CLIs. */
  get #live(): boolean {
    return this.#deps.transport.kind === "live";
  }

  /** Refresh detection (cached unless `force`) and rebuild the registry with local and discovered profiles. */
  async #refresh(options: { force?: boolean; providers?: readonly string[] } = {}): Promise<{ cli: CliProviderStatus[]; local: LocalProviderStatus | null }> {
    if (!this.#live) return { cli: [], local: null };
    const cliIds = options.providers?.filter(isCliProviderId);
    const wantLocal = options.providers === undefined || options.providers.includes("ollama");
    const [cli, local] = await Promise.all([
      this.#deps.cli ? this.#deps.cli.status({ ...(options.force ? { force: true } : {}), ...(cliIds ? { providers: cliIds } : {}) }) : Promise.resolve([]),
      this.#deps.local ? (wantLocal ? this.#deps.local.status({ force: options.force === true }) : Promise.resolve(this.#deps.local.view())) : Promise.resolve(null),
    ]);
    this.#registry = profileRegistry([...(this.#deps.local?.profiles() ?? []), ...(this.#deps.cli?.discovered() ?? [])]);
    return { cli, local };
  }

  #view(cli: CliProviderStatus[], local: LocalProviderStatus | null): AgentSettingsView {
    const stored = this.#deps.settings.get();
    const warnings: string[] = [];
    if (this.#deps.cliOff !== undefined && this.#live) warnings.push(`${this.#deps.cliOff}.`);
    for (const s of cli) {
      if (s.planUsage?.status === "rejected") warnings.push(`${s.label}: the plan's usage limit was reached at the last run${resetText(s)}.`);
    }
    return buildSettingsView({ stored, keys: this.#deps.keys, transport: this.#deps.transport.kind, registry: this.#registry, cli, local, warnings });
  }

  /** The settings view, with provider detection (cached: CLI detection 10 min, logins 60 s, Ollama 30 s). */
  async settingsView(): Promise<AgentSettingsView> {
    const { cli, local } = await this.#refresh();
    return this.#view(cli, local);
  }

  /** Settings → Re-check: detection again now, bypassing the caches (and lifting a tripwire block if it passes). */
  async probeProviders(raw: unknown): Promise<AgentSettingsView> {
    const req = parseProbeProvidersRequest(raw);
    const { cli, local } = await this.#refresh({ force: true, ...(req.providers ? { providers: req.providers } : {}) });
    return this.#view(cli, local);
  }

  /** Validate and store a settings update; a changed CLI path or Ollama URL is probed again right away. */
  async updateSettings(raw: unknown): Promise<AgentSettingsView> {
    const names: Partial<Record<CliProviderId, readonly string[]>> = {};
    for (const id of this.#deps.cli?.providerIds ?? []) names[id] = this.#deps.cli!.provider(id)!.binaryNames;
    const u: SettingsUpdate = parseSettingsUpdate(raw, { cliBinaryNames: names });
    for (const [id, path] of Object.entries(u.cliPaths ?? {}) as Array<[CliProviderId, string | null]>) {
      if (path === null) continue;
      const problem = cliPathProblem(path, names[id] ?? []);
      if (problem) throw new ProtocolError(`The ${providerLabel(id)} path ${problem}.`);
    }
    this.#deps.settings.update(u, this.#registry);
    const probe = [...Object.keys(u.cliPaths ?? {}), ...(u.ollamaBaseUrl !== undefined ? ["ollama"] : [])];
    if (probe.length > 0) await this.#refresh({ force: true, providers: probe });
    return this.settingsView();
  }

  async start(raw: unknown): Promise<AgentStartResponse> {
    let request;
    try {
      request = parseStartRequest(raw);
    } catch (e) {
      return { ok: false, code: "INVALID_REQUEST", message: e instanceof ProtocolError ? e.message : "invalid request" };
    }
    if (this.#run || this.#starting) return { ok: false, code: "BUSY", message: "The agent is already working on a request. Stop it first." };
    this.#starting = true;
    try {
      return await this.#start(request);
    } finally {
      this.#starting = false;
    }
  }

  async #start(request: ReturnType<typeof parseStartRequest>): Promise<AgentStartResponse> {
    const stored = this.#deps.settings.get();
    let cli: CliProviderStatus[] = [];
    let local: LocalProviderStatus | null = null;
    if (this.#live) ({ cli, local } = await this.#refresh());
    const readiness = readinessFrom(cli, local, this.#deps.keys);
    const auto = autoDefaults(readiness, this.#registry);
    const models = effectiveModels(stored, this.#registry, auto.models);
    const secrets: Partial<Record<ApiProviderId, string>> = {};
    const notes: string[] = [];
    let cliConfig: WorkerRunConfig["cli"];
    if (this.#live) {
      const problem = this.#precheck(models, readiness, auto.provider === null && Object.keys(stored.models).length === 0);
      if (problem) return { ok: false, ...problem };
      for (const provider of providersForRun(models, this.#registry)) {
        const k = this.#deps.keys.resolve(provider);
        if (k.key) secrets[provider] = k.key;
      }
      const binaries: Partial<Record<CliProviderId, CliBinaryWire>> = {};
      for (const role of RUN_ROLES) {
        const p = this.#registry.get(models[role]);
        if (profileKind(p) !== "cli" || !isCliProviderId(p.provider) || binaries[p.provider]) continue;
        const b = this.#deps.cli?.binary(p.provider);
        if (!b) return { ok: false, code: "CLI_NOT_INSTALLED", message: `${providerLabel(p.provider)} is not available. Open Settings and press Re-check.` };
        binaries[p.provider] = binaryToWire(b);
        const s = cli.find((x) => x.id === p.provider);
        if (s?.lockdownLevel === "static") notes.push(`${s.label} ${s.version ?? ""} is newer than the last verified version: the app relies on runtime tripwires for its lockdown.`.replace("  ", " "));
        if (s?.planUsage?.status === "rejected") notes.push(`${s.label}: the plan's usage limit was reached at the last run${resetText(s)}; the run may stop with quota_exhausted.`);
        if (s?.billing === "metered") notes.push(`${s.label} is logged in with an API key: this run is billed per token by the vendor.`);
      }
      if (Object.keys(binaries).length > 0) {
        const setup = this.#deps.cliRun;
        if (!setup) return { ok: false, code: "UNAVAILABLE", message: "CLI providers are not set up in this build." };
        const mode = stored.cliMode === "auto" && setup.autoMode === "completion" ? "completion" : stored.cliMode;
        cliConfig = { binaries, mode, workspaceRoot: setup.workspaceRoot, exePath: setup.exePath, mcpServerDir: setup.mcpServerDir };
        if (setup.childEnv && Object.keys(setup.childEnv).length > 0) cliConfig.childEnv = { ...setup.childEnv };
      }
    }

    let worker: WorkerHandle;
    try {
      worker = this.#ensureWorker();
    } catch (e) {
      return { ok: false, code: "UNAVAILABLE", message: `Could not start the agent process: ${e instanceof Error ? e.message : String(e)}` };
    }
    const runId = this.#deps.newRunId?.() ?? `run-${Date.now().toString(36)}-${(++counter).toString(36)}`;
    this.#run = { runId, startedAt: this.#now(), lastSeq: 0, stopTimer: null };
    const config: WorkerRunConfig = {
      models,
      budgetUsd: request.settings?.budgetUsd ?? stored.budgetUsd,
      compatBaseUrl: stored.compatBaseUrl,
      transport: this.#deps.transport,
      forgeBin: this.#deps.forgeBin,
    };
    if (this.#live) {
      config.profiles = [...(this.#deps.local?.profiles() ?? []), ...(this.#deps.cli?.discovered() ?? [])];
      if (this.#deps.local) config.localEndpoints = [this.#deps.local.endpoint];
    }
    if (cliConfig) config.cli = cliConfig;
    if (notes.length > 0) config.notes = notes;
    worker.postMessage({ type: "start", v: PROTOCOL_VERSION, runId, request, config, secrets });
    return { ok: true, runId };
  }

  /** §11.3: every provider the run's models use must be ready; the message names the provider, roles and fix. */
  #precheck(models: Record<AgentRoleId, string>, readiness: ReturnType<typeof readinessFrom>, nothingSetUp: boolean): Precheck | null {
    const problems: Array<Precheck & { order: number }> = [];
    const seen = new Set<string>();
    RUN_ROLES.forEach((role, order) => {
      const profile = this.#registry.get(models[role]);
      const provider = displayProvider(profile);
      const kind = profileKind(profile);
      const key = kind === "local" ? `local:${profile.id}` : provider;
      if (seen.has(key)) return;
      seen.add(key);
      const roles = RUN_ROLES.filter((r) => (kind === "local" ? models[r] === profile.id : displayProvider(this.#registry.get(models[r])) === provider));
      const roleText = roles.map((r) => `${r}: ${this.#registry.get(models[r]).displayName}`).join(", ");
      if (kind === "cli" && isCliProviderId(provider) && this.#deps.cliOff !== undefined) {
        problems.push({ order, code: "UNAVAILABLE", message: `${providerLabel(provider)} cannot run: ${this.#deps.cliOff} (${roleText}). Pick another model in Settings.` });
      } else if (kind === "cli" && isCliProviderId(provider)) {
        const p = cliProblem(readiness.cli.get(provider), provider);
        if (p) problems.push({ order, code: p.code, message: `${p.reason} (${roleText}). ${p.fix}.` });
      } else if (kind === "local") {
        const tag = profile.local?.tag ?? profile.apiModelId;
        const l = readiness.local;
        if (!l?.running) problems.push({ order, code: "LOCAL_UNAVAILABLE", message: `Ollama is not running at ${this.#deps.local?.baseUrl ?? "http://127.0.0.1:11434"} (${roleText}). Start it (\`ollama serve\`), or pick another model in Settings.` });
        else if (!l.models.some((m) => m.tag === tag)) problems.push({ order, code: "LOCAL_UNAVAILABLE", message: `${tag} is not in Ollama (${roleText}). Run \`ollama pull ${tag}\`, then press Re-check.` });
        else if (!l.models.some((m) => m.tag === tag && m.tools)) problems.push({ order, code: "LOCAL_UNAVAILABLE", message: `${tag} has no tool calling, which the agent needs (${roleText}). Pick another model in Settings.` });
      } else if (kind === "api" && provider !== "ollama" && !isCliProviderId(provider)) {
        const info = providerInfo(provider);
        if (info.keyRequired && !this.#deps.keys.store.enabled) {
          problems.push({ order, code: "NO_API_KEY", message: `${info.label} API models are turned off in this build, which runs on Claude Code (${roleText}). Pick a Claude Code model in Settings.` });
        } else if (info.keyRequired && !this.#deps.keys.resolve(provider).key) {
          const hint = nothingSetUp ? " No provider is set up yet: you can also use a CLI agent you already have (Claude Code, Codex, Gemini CLI, opencode) or a local Ollama model, without any key." : "";
          problems.push({ order, code: "NO_API_KEY", message: `No API key for ${info.label} (${roleText}) — add it in Settings or set ${info.envVars[0]}.${hint}` });
        }
      }
    });
    if (problems.length === 0) return null;
    problems.sort((a, b) => a.order - b.order);
    return { code: problems[0]!.code, message: problems.map((p) => p.message).join(" ") };
  }

  answer(raw: unknown): { ok: boolean } {
    const req: AgentAnswerRequest = parseAnswerRequest(raw);
    if (!this.#run || this.#run.runId !== req.runId || !this.#worker) return { ok: false };
    this.#worker.postMessage({ type: "answer", v: PROTOCOL_VERSION, runId: req.runId, questionId: req.questionId, answers: req.answers });
    return { ok: true };
  }

  stop(raw: unknown): { ok: boolean } {
    const req: AgentStopRequest = parseStopRequest(raw);
    return this.#stopRun(req.runId);
  }

  /** Stop whatever runs (window closed, renderer crashed, app quitting). */
  stopAll(): void {
    if (this.#run) this.#stopRun(this.#run.runId);
  }

  /**
   * App quit (`will-quit`): kill the worker and the CLI process groups it reported, then empty the CLI workspace root
   * (§5.8). A runtime phase or CLI call the quit interrupted never reaches the code that removes its workspace, which
   * can hold the phase's system prompt, image attachments and the CLI's temp or crash files. The root is exclusive to
   * this instance (`setup.ts`), and a CLI started too recently to be reported is killed by the worker's SIGTERM
   * handler: its working folder is gone by then.
   */
  dispose(): void {
    const w = this.#worker;
    this.#worker = null;
    if (this.#run?.stopTimer) clearTimeout(this.#run.stopTimer);
    this.#run = null;
    w?.kill();
    this.#killCliGroups();
    if (this.#deps.cliRun) clearCliWorkspaces(this.#deps.cliRun.workspaceRoot);
  }

  #stopRun(runId: string): { ok: boolean } {
    const run = this.#run;
    if (!run || run.runId !== runId || !this.#worker) return { ok: false };
    this.#worker.postMessage({ type: "stop", v: PROTOCOL_VERSION, runId });
    if (!run.stopTimer) {
      run.stopTimer = setTimeout(() => {
        if (this.#run !== run) return;
        // The run did not wind down (e.g. stuck in a long synchronous evaluation): kill the process.
        this.#emit(run, { type: "error", code: "STOP_TIMEOUT", message: "Stopped: the agent process did not wind down in time and was terminated. Your document is unchanged." });
        const w = this.#worker;
        this.#worker = null;
        w?.kill();
        this.#killCliGroups();
      }, this.#deps.stopGraceMs ?? 8000);
    }
    return { ok: true };
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  #killCliGroups(): void {
    const groups = this.#cliGroups;
    this.#cliGroups = [];
    this.#cliGroupsOwner = null;
    for (const pid of groups) (this.#deps.killProcessGroup ?? defaultKillGroup)(pid);
  }

  #ensureWorker(): WorkerHandle {
    if (this.#worker) return this.#worker;
    const w = this.#deps.spawnWorker();
    this.#worker = w;
    w.onMessage((raw) => this.#onWorkerMessage(w, raw));
    w.onExit((code) => {
      if (this.#worker === w) this.#worker = null;
      // The worker kills its CLI process groups on exit; this covers a crash that skipped that. Groups a newer worker
      // reported (this one was replaced after a stop timeout) are not this worker's to kill.
      if (this.#cliGroupsOwner === null || this.#cliGroupsOwner === w) this.#killCliGroups();
      const run = this.#run;
      if (run) this.#emit(run, { type: "error", code: "WORKER_EXITED", message: `The agent process exited unexpectedly (code ${code}). Your document is unchanged.` });
    });
    return w;
  }

  #onWorkerMessage(w: WorkerHandle, raw: unknown): void {
    if (w !== this.#worker) return;
    const m = parseWorkerMessage(raw);
    if (!m) return;
    if (m.type === "log") {
      this.#deps.log?.(m.level, scrubKeyLike(m.message));
      return;
    }
    if (m.type === "procs") {
      this.#cliGroups = m.pids;
      this.#cliGroupsOwner = w;
      return;
    }
    if (m.type === "cli") {
      // Local log line without the payload (§5.6 step 5); the binary stays blocked until Re-check passes.
      this.#deps.cli?.markBlocked(m.provider, m.realPath, m.detail.slice(0, 120));
      return;
    }
    if (m.type !== "event") return;
    const run = this.#run;
    if (!run || m.event.runId !== run.runId) return;
    if (m.event.type === "plan" && isCliProviderId(m.event.provider)) this.#deps.cli?.setPlanUsage(m.event.provider, m.event.usage);
    run.lastSeq = Math.max(run.lastSeq, m.event.seq);
    this.#deps.send(m.event);
    if (isTerminalEvent(m.event)) this.#finish(run);
  }

  /** Emit a host-originated event (continues the run's sequence) and end the run if terminal. */
  #emit(run: ActiveRun, body: AgentEventBody): void {
    const event = { v: PROTOCOL_VERSION, runId: run.runId, seq: ++run.lastSeq, t: Math.round(this.#now() - run.startedAt), ...body } as AgentEvent;
    this.#deps.send(event);
    if (isTerminalEvent(event)) this.#finish(run);
  }

  #finish(run: ActiveRun): void {
    if (run.stopTimer) clearTimeout(run.stopTimer);
    if (this.#run === run) this.#run = null;
  }
}

/** When the plan that ran out is usable again: the reset of the window that ran out, not the latest one (`planResetAt`). */
function resetText(s: CliProviderStatus): string {
  const at = s.planUsage ? planResetAt(s.planUsage.windows) : null;
  return at ? ` (resets ${at})` : "";
}
