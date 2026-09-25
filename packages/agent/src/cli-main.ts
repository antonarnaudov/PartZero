/**
 * The `aicad-agent` command line (logic only; `cli.ts` wires it to the process).
 *
 *   aicad-agent run --prompt "…" [--context file.cad.ts] [--engine oracle|forge|fixture|auto] [--designer-model id] …
 *   aicad-agent bench --tasks corpus/makerbench --models a,b [--engine oracle] [--out artifacts/bench/<run>] …
 *
 * CLI agents (ADR 0014): any CLI profile id (`claude-cli:opus`, `gemini-cli:pro`, `codex-cli:gpt-6-sol`,
 * discovered `opencode:<provider/model>`) works for every model flag, on the user's own logged-in CLI and
 * plan: no API key. `--cli-mode` picks completion or runtime mode for the tool loops (§3.4). The CLI code is
 * loaded only when a CLI profile is used (Node only).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AnthropicSdkTransport,
  BUILTIN_CLI_PROFILES,
  BUILTIN_LOCAL_PROFILES,
  BUILTIN_PROFILES,
  GatewayError,
  GoogleSdkTransport,
  isCliProvider,
  LLMGateway,
  OpenAISdkTransport,
  RecordingTransport,
  ReplayTransport,
  smallModelForProfile,
  type CliBinary,
  type CliMcpHost,
  type CliProviderId,
  type Fixture,
  type GatewayConfig,
  type GatewayOptions,
  type PlanUsage,
  type Provider,
  type ProviderAdapter,
  type ProviderTransport,
} from "@aicad/llm-gateway";
import { FixtureEngine, ForgeCliEngine, IR0_CAPABILITIES, isSupported, loadTasks, OracleEngine, TaskLoadError, TIERS, type Engine, type Tier } from "@aicad/evals";
import { summarizeTests, v1 as tv1 } from "@aicad/agent-tools";
import { Agent, type AgentOptions } from "./agent.js";
import { runBakeOff } from "./bench.js";
import { BENCH_LIMITS, type AgentLimits } from "./run-context.js";
import { resolveModels, type ModelOverrides } from "./models.js";
import type { AgentRuntime, CliModeOption } from "./runtime.js";
import { formatTraceSummary } from "./trace.js";
import type { TriageKind } from "./triage.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
}

/** Injection points for tests (offline gateways, fake engines, fake CLI binaries). */
export interface CliDeps {
  makeGateway?: (config: GatewayConfig | undefined) => LLMGateway;
  makeEngine?: (kind: string) => Engine;
  /** `--ir v1`: the engine returning `aicad.metrics/1` reports (default: Forge's CLI). */
  makeEngineV1?: () => tv1.EngineV1;
  env?: Record<string, string | undefined>;
  /** CLI agents: the binary per provider (default: detection) and the MCP host (default: `@aicad/mcp-server` when installed). */
  cli?: {
    binary?(provider: CliProviderId): Promise<CliBinary>;
    /** `null`: no MCP host (completion mode with the text-json envelope only). */
    mcpHost?: CliMcpHost | null;
    workspaceRoot?: string;
  };
}

export const USAGE = `Usage:
  aicad-agent run --prompt "<request>" [options]
      Run the agent once; print the final CadScript (stdout) and a trace summary (stderr).
      --context <file.cad.ts>     edit this model (T4-style)
      --process fdm|cnc|laser|any
      --engine auto|oracle|forge|fixture   (default auto: forge, else oracle)
      --designer-model <id>       designer (and spec writer) model; triage uses the provider's small model
      --spec-model <id>  --triage-model <id>
      --kind design|quick_edit|ask   skip triage
      --budget <usd>              hard cap per task (default 1.5)
      --gateway-config <file>     llm-gateway JSON config (profiles, routing, providers)
      --out <file.cad.ts>         also write the final CadScript here
      --trace <file.json>         write the full result (trace, spec, proposal, conversations)
      --fixtures <dir>            fixture reports for --engine fixture
      --record <file.json>        record every provider exchange (for offline trajectory replay)
      --replay <file.json>        replay recorded exchanges instead of calling providers (no keys needed)
      --cli-mode auto|completion|runtime   CLI profiles: how the tool loops run (default auto: runtime when possible)
      --cli-bin <provider>=<path>  use this CLI binary (repeatable), e.g. claude-cli=/opt/bin/claude
      --ir v0|v1                  the CadScript dialect (default v0); v1 = parameters, queries, holes, blends, patterns (engine: Forge, or --engine oracle)
      --task-wall <seconds>       stop the task after this much wall time (default: none; bench 480)
      --max-failed-applies <n>    stop after this many failed applies (default 10, 6 in CLI runtime mode and in bench)
  aicad-agent bench --tasks <dir> --models <id,id,…> [options]
      MakerBench bake-off: run every task once per designer model, write per-model results and a comparison table.
      --engine auto|oracle|forge|fixture   (default oracle)
      --out <dir>                 (default artifacts/bench/<timestamp>)
      --tier T1,T2   --only <id,id>   --limit <n>
      --budget <usd>              per task (default 1.5)
      --concurrency <n>           parallel tasks per model (default 2; 1 on a CLI plan)
      --gateway-config <file>
      --cli-mode auto|completion|runtime   --cli-bin <provider>=<path>
      --task-wall <seconds>       per-task wall-time cap (default 480)
      --max-failed-applies <n>    per-task failed-apply stop (default 6)
      On a CLI plan (subscription profiles) the bench runs 5 tasks unless --limit is given; --limit 0 runs all.
Models: API profiles (claude-opus-5-5, gpt-6-sol, …), local ones (ollama:<tag>) and CLI agents on your own
  logged-in plan: claude-cli:opus|sonnet|haiku|fable, gemini-cli:pro|flash|flash-lite|auto, codex-cli:default|gpt-6-sol|gpt-6-luna.
Keys: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY for API profiles only; CLI profiles use the CLI's own login.
Exit codes: 0 ok (run: proposed or answered), 1 run stopped or failed, 2 usage error or engine unavailable.
`;

class UsageError extends Error {}

const VALUE_FLAGS = new Set([
  "--prompt",
  "--context",
  "--process",
  "--engine",
  "--designer-model",
  "--spec-model",
  "--triage-model",
  "--kind",
  "--budget",
  "--gateway-config",
  "--out",
  "--trace",
  "--fixtures",
  "--tasks",
  "--models",
  "--tier",
  "--only",
  "--limit",
  "--concurrency",
  "--oracle-dir",
  "--forge-bin",
  "--record",
  "--replay",
  "--cli-mode",
  "--cli-bin",
  "--ir",
  "--task-wall",
  "--max-failed-applies",
]);

/** Flags that may be given more than once (values joined with ","). */
const REPEATABLE = new Set(["--cli-bin"]);

function parseArgs(argv: string[]): { command: string | undefined; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") flags.set("--help", "1");
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      const prev = flags.get(a);
      flags.set(a, REPEATABLE.has(a) && prev !== undefined ? `${prev},${v}` : v);
    } else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (command === undefined) command = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  return { command, flags };
}

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);
}

function num(flags: Map<string, string>, name: string, fallback: number, test: (x: number) => boolean): number {
  const v = flags.get(name);
  if (v === undefined) return fallback;
  const x = Number(v);
  if (!test(x)) throw new UsageError(`${name}: invalid value ${v}`);
  return x;
}

function loadConfig(flags: Map<string, string>, io: CliIo): GatewayConfig | undefined {
  const f = flags.get("--gateway-config");
  if (!f) return undefined;
  return JSON.parse(readFileSync(resolve(io.cwd, f), "utf8")) as GatewayConfig;
}

async function makeEngine(kind: string, flags: Map<string, string>, io: CliIo, deps: CliDeps): Promise<Engine> {
  if (deps.makeEngine) return deps.makeEngine(kind);
  const forge = () => new ForgeCliEngine(flags.get("--forge-bin") ? { bin: resolve(io.cwd, flags.get("--forge-bin")!) } : {});
  const oracle = () => new OracleEngine(flags.get("--oracle-dir") ? { oracleDir: resolve(io.cwd, flags.get("--oracle-dir")!) } : {});
  if (kind === "forge") return forge();
  if (kind === "oracle") return oracle();
  if (kind === "fixture") {
    const dir = flags.get("--fixtures");
    if (!dir) throw new UsageError("--engine fixture needs --fixtures <dir> (recorded reports only cover recorded models)");
    return new FixtureEngine(resolve(io.cwd, dir));
  }
  if (kind === "auto") {
    for (const make of [forge, oracle]) {
      const e = make();
      const a = await e.availability();
      if (a.available) return e;
      io.stderr(`aicad-agent: ${e.kind} unavailable: ${a.detail}\n`);
    }
    throw new UsageError("no engine available (build forge-cli or install uv for the oracle)");
  }
  throw new UsageError(`unknown engine ${kind} (auto | oracle | forge | fixture)`);
}

// ── CLI agents as providers (ADR 0014) ──

/** Every built-in profile: API, CLI agents and local models (a CLI profile is inert until it is used). */
const ALL_PROFILES = [...BUILTIN_PROFILES, ...BUILTIN_CLI_PROFILES, ...BUILTIN_LOCAL_PROFILES];

function cliMode(flags: Map<string, string>): CliModeOption {
  const m = flags.get("--cli-mode") ?? "auto";
  if (m !== "auto" && m !== "completion" && m !== "runtime") throw new UsageError(`--cli-mode must be auto, completion or runtime`);
  return m;
}

function cliBins(flags: Map<string, string>, cwd: string): Partial<Record<CliProviderId, string>> {
  const out: Partial<Record<CliProviderId, string>> = {};
  for (const item of list(flags.get("--cli-bin")) ?? []) {
    const eq = item.indexOf("=");
    const id = item.slice(0, eq);
    if (eq <= 0 || !isCliProvider(id)) throw new UsageError(`--cli-bin takes <provider>=<path> with a CLI provider (claude-cli, gemini-cli, codex-cli, opencode, cursor-agent); got ${item}`);
    out[id] = resolve(cwd, item.slice(eq + 1));
  }
  return out;
}

interface CliHost {
  adapters: Partial<Record<Provider, ProviderAdapter>>;
  transports: Partial<Record<Provider, ProviderTransport>>;
  runtime: AgentRuntime | undefined;
}

/**
 * `@aicad/mcp-server` when the host has it (the desktop app injects its own): the broker for runtime mode and
 * `mcp-submit`. `@aicad/agent` does not depend on it (hosts inject the MCP host), so in the monorepo the sibling
 * package's build is the fallback.
 */
async function defaultMcpHost(): Promise<CliMcpHost | null> {
  type McpModule = { createMcpHost(o: { shim: unknown }): CliMcpHost; nodeShimCommand(): unknown };
  for (const spec of ["@aicad/mcp-server", new URL("../../mcp-server/dist/index.js", import.meta.url).href]) {
    try {
      const mod = (await import(spec)) as McpModule;
      return mod.createMcpHost({ shim: mod.nodeShimCommand() });
    } catch {
      // not installed or not built: try the next place
    }
  }
  return null;
}

/**
 * The CLI providers `models` need: detected (no model call; a CLI that is missing, too old or cannot be
 * locked down fails here, before any task), then adapters, transports and the runtime (§8.3).
 */
async function cliHost(models: readonly string[], registry: LLMGateway, flags: Map<string, string>, io: CliIo, deps: CliDeps, env: Record<string, string | undefined>): Promise<CliHost | null> {
  const providers = [...new Set(models.map((m) => registry.profile(m).provider).filter(isCliProvider))];
  if (providers.length === 0) return null;
  const mode = cliMode(flags);
  // Node-only code, loaded only now: the root entry never pulls in child_process.
  const cli = await import("@aicad/llm-gateway/cli");
  const { CliAgentRuntime, cliBinaryResolver, RUNTIME_VERIFIED_PROVIDERS } = await import("./cli-runtime.js");
  const baseEnv = Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string"));
  const resolver = cliBinaryResolver({ overrides: cliBins(flags, io.cwd), env: baseEnv });
  const binary = deps.cli?.binary ?? ((id: CliProviderId) => resolver.binary(id));
  for (const id of providers) {
    try {
      const b = await binary(id);
      io.stderr(`aicad-agent: ${id} ${b.version} at ${b.realPath} (your own login and plan)\n`);
    } catch (e) {
      throw new UsageError(`${id} is not ready: ${(e as Error).message}`);
    }
  }
  const mcpHost = deps.cli?.mcpHost !== undefined ? deps.cli.mcpHost : await defaultMcpHost();
  if (mcpHost === null) {
    if (mode === "runtime") throw new UsageError("--cli-mode runtime needs the CAD MCP server (@aicad/mcp-server, built)");
    io.stderr("aicad-agent: the CAD MCP server is not available, so CLI tool loops run in completion mode\n");
  }
  const parts = cli.cliGatewayParts({
    providers,
    binary,
    env: () => baseEnv,
    ...(mcpHost === null ? {} : { mcpHost }),
    ...(deps.cli?.workspaceRoot === undefined ? {} : { workspaceRoot: deps.cli.workspaceRoot }),
  });
  // Runtime mode is on for the CLIs with a recorded runtime session; AICAD_CLI_RUNTIME_PROVIDERS=gemini-cli,opencode
  // (comma-separated) opts others in, to record their fixtures.
  const optIn = (env["AICAD_CLI_RUNTIME_PROVIDERS"] ?? "").split(",").map((s) => s.trim()).filter(isCliProvider);
  const runtime =
    mcpHost === null || mode === "completion"
      ? undefined
      : new CliAgentRuntime({
          binary,
          env: () => baseEnv,
          mcpHost,
          ...(deps.cli?.workspaceRoot === undefined ? {} : { workspaceRoot: deps.cli.workspaceRoot }),
          ...(optIn.length === 0 ? {} : { runtimeProviders: [...new Set([...RUNTIME_VERIFIED_PROVIDERS, ...optIn])] }),
        });
  return { adapters: parts.adapters, transports: parts.transports, runtime };
}

function withCli(options: GatewayOptions, host: CliHost | null): GatewayOptions {
  if (host === null) return options;
  return { ...options, adapters: { ...options.adapters, ...host.adapters }, transports: { ...options.transports, ...host.transports } };
}

function planLine(u: PlanUsage): string {
  const w = u.windows.map((x) => `${x.id} ${x.utilization === null ? "?" : `${Math.round(x.utilization * 100)}%`}${x.resetsAt ? ` (resets ${x.resetsAt})` : ""}`).join(", ");
  return `plan usage (${u.provider}): ${u.status}${w ? `; ${w}` : ""}`;
}

/** `--task-wall` / `--max-failed-applies` as agent limits (only what was given). */
function limitFlags(flags: Map<string, string>): Partial<AgentLimits> {
  const out: Partial<AgentLimits> = {};
  if (flags.has("--task-wall")) out.maxWallMs = num(flags, "--task-wall", 0, (x) => Number.isFinite(x) && x > 0) * 1000;
  if (flags.has("--max-failed-applies")) out.maxFailedApplies = num(flags, "--max-failed-applies", 0, (x) => Number.isInteger(x) && x > 0);
  return out;
}

function overrides(flags: Map<string, string>): ModelOverrides {
  const o: ModelOverrides = {};
  const d = flags.get("--designer-model");
  const s = flags.get("--spec-model");
  const t = flags.get("--triage-model");
  if (d) o.designer = d;
  if (s) o.spec_writer = s;
  if (t) o.triage = t;
  return o;
}

async function cmdRun(flags: Map<string, string>, io: CliIo, deps: CliDeps): Promise<number> {
  const prompt = flags.get("--prompt");
  if (!prompt) throw new UsageError("--prompt is required");
  const contextFile = flags.get("--context");
  const context = contextFile ? readFileSync(resolve(io.cwd, contextFile), "utf8") : undefined;
  const kind = flags.get("--kind") as TriageKind | undefined;
  if (kind !== undefined && !["design", "quick_edit", "ask"].includes(kind)) throw new UsageError(`--kind must be design, quick_edit or ask`);
  const ir = flags.get("--ir") ?? "v0";
  if (ir !== "v0" && ir !== "v1") throw new UsageError("--ir must be v0 or v1");
  const limits = limitFlags(flags);
  let engine: Engine;
  let engineV1: tv1.EngineV1 | undefined;
  if (ir === "v1") {
    const e = flags.get("--engine") ?? "auto";
    if (e !== "auto" && e !== "forge" && e !== "oracle") {
      throw new UsageError("--ir v1 runs on Forge (--engine forge, or auto) or on the OCCT oracle's v1 pipeline (--engine oracle: CI/dev only, a cross-check of Forge on the same documents); --engine fixture replays aicad.metrics/0 reports only");
    }
    engineV1 = deps.makeEngineV1
      ? deps.makeEngineV1()
      : e === "oracle"
        ? new tv1.OracleCliEngineV1(flags.get("--oracle-dir") ? { oracleDir: resolve(io.cwd, flags.get("--oracle-dir")!) } : {})
        : new tv1.ForgeCliEngineV1(flags.get("--forge-bin") ? { bin: resolve(io.cwd, flags.get("--forge-bin")!) } : {});
    // The v0 engine is not used by a v1 run; the option stays required for v0 callers.
    engine = new ForgeCliEngine(flags.get("--forge-bin") ? { bin: resolve(io.cwd, flags.get("--forge-bin")!) } : {});
  } else {
    engine = await makeEngine(flags.get("--engine") ?? "auto", flags, io, deps);
  }
  const probed = engineV1 ?? engine;
  const a = await probed.availability();
  if (!a.available) {
    io.stderr(`aicad-agent: engine ${probed.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const config = loadConfig(flags, io);
  const recordFile = flags.get("--record");
  const replayFile = flags.get("--replay");
  if (recordFile && replayFile) throw new UsageError("--record and --replay are exclusive");
  let recorders: RecordingTransport[] = [];
  let gateway: LLMGateway;
  let host: CliHost | null = null;
  const mode = cliMode(flags);
  if (replayFile) {
    const fixtures = JSON.parse(readFileSync(resolve(io.cwd, replayFile), "utf8")) as Fixture[];
    const transports: Partial<Record<Provider, ProviderTransport>> = {};
    for (const p of ["anthropic", "openai", "google", "openai-compat"] as const) {
      transports[p] = new ReplayTransport(fixtures.filter((f) => f.provider === p), { match: "sequential" });
    }
    gateway = new LLMGateway({ ...(config ? { config } : {}), transports });
  } else if (deps.makeGateway) {
    gateway = deps.makeGateway(config);
  } else if (recordFile) {
    const opts = (c: { baseURL?: string | undefined; maxRetries?: number | undefined; timeoutMs?: number | undefined } | undefined) => ({
      ...(c?.baseURL ? { baseURL: c.baseURL } : {}),
      ...(c?.maxRetries !== undefined ? { maxRetries: c.maxRetries } : {}),
      ...(c?.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}),
    });
    const providers = config?.providers;
    recorders = [
      new RecordingTransport(new AnthropicSdkTransport(opts(providers?.anthropic))),
      new RecordingTransport(new OpenAISdkTransport(opts(providers?.openai), "openai")),
      new RecordingTransport(new GoogleSdkTransport(opts(providers?.google))),
    ];
    gateway = new LLMGateway({ ...(config ? { config } : {}), transports: { anthropic: recorders[0]!, openai: recorders[1]!, google: recorders[2]! } });
  } else {
    const base: GatewayOptions = { profiles: ALL_PROFILES, ...(config ? { config } : {}) };
    const probe = new LLMGateway(base);
    const roles = resolveModels(probe, overrides(flags));
    host = await cliHost(Object.values(roles).map((c) => c.model), probe, flags, io, deps, deps.env ?? process.env);
    gateway = new LLMGateway(withCli(base, host));
  }
  const options: AgentOptions = {
    gateway,
    engine,
    ...(engineV1 ? { ir: "v1" as const, engineV1 } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
    models: overrides(flags),
    budgetUsd: num(flags, "--budget", 1.5, (x) => x > 0),
    mode: "eval",
    cliMode: mode,
    ...(host?.runtime ? { runtime: host.runtime } : {}),
    ...(kind ? { kind } : {}),
    hooks: { onEvent: (e) => io.stderr(`  [${(e.t / 1000).toFixed(1)}s ${e.state}] ${e.type}: ${e.text.split("\n")[0]}\n`) },
  };
  const agent = new Agent(options);
  const r = await agent.run({ prompt, context, name: contextFile ? contextFile.replace(/.*\//, "").replace(/\.cad\.ts$/, "") : "design", process: flags.get("--process") });
  if (r.answer !== undefined) io.stdout(`${r.answer}\n`);
  else io.stdout(r.cadscript.endsWith("\n") ? r.cadscript : `${r.cadscript}\n`);
  const tests = r.tests ? summarizeTests(r.tests) : undefined;
  io.stderr(`\n${formatTraceSummary(r.trace, { status: r.status, ...(tests ? { tests: `${tests.passed}/${tests.total}${tests.failing.length ? ` (failing: ${tests.failing.join(", ")})` : ""}` } : {}) })}\n`);
  if (r.billing === "subscription") io.stderr(`cost is notional: the designer ran on your CLI plan (${r.mode}), not billed per token\n`);
  if (r.planUsage) io.stderr(`${planLine(r.planUsage)}\n`);
  if (r.proposal) {
    io.stderr(`proposal: ${r.proposal.summary}\n`);
    for (const x of r.proposal.assumptions) io.stderr(`  assumption: ${x}\n`);
    for (const x of r.proposal.known_issues) io.stderr(`  known issue: ${x}\n`);
  }
  const out = flags.get("--out");
  if (out) {
    const p = resolve(io.cwd, out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, r.cadscript);
  }
  if (recordFile) {
    const p = resolve(io.cwd, recordFile);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(recorders.flatMap((r) => r.fixtures), null, 1) + "\n");
  }
  const trace = flags.get("--trace");
  if (trace) {
    const p = resolve(io.cwd, trace);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(r, null, 2) + "\n");
  }
  return r.status === "proposed" || r.status === "answered" ? 0 : 1;
}

async function cmdBench(flags: Map<string, string>, io: CliIo, deps: CliDeps): Promise<number> {
  const dir = flags.get("--tasks");
  if (!dir) throw new UsageError("--tasks <dir> is required");
  const models = list(flags.get("--models"));
  if (!models || models.length === 0) throw new UsageError("--models <id,id,…> is required");
  if ((flags.get("--ir") ?? "v0") !== "v0") throw new UsageError("bench runs the v0 MakerBench tasks (--ir v0); v1 tasks and checks come with MakerBench v1");
  let tasks = loadTasks(resolve(io.cwd, dir)).filter((t) => isSupported(t, IR0_CAPABILITIES));
  const tiers = list(flags.get("--tier"));
  if (tiers) {
    for (const t of tiers) if (!(TIERS as readonly string[]).includes(t)) throw new UsageError(`unknown tier ${t}`);
    tasks = tasks.filter((t) => tiers.includes(t.tier as Tier));
  }
  const only = list(flags.get("--only"));
  if (only) {
    for (const id of only) if (!tasks.some((t) => t.id === id)) throw new UsageError(`unknown task ${id}`);
    tasks = tasks.filter((t) => only.includes(t.id));
  }
  const config = loadConfig(flags, io);
  const base: GatewayOptions = { profiles: ALL_PROFILES, ...(config ? { config } : {}) };
  // Check model ids and keys up front: a missing key would fail every task.
  const env = deps.env ?? process.env;
  const keyFor: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY" };
  const probe = deps.makeGateway ? deps.makeGateway(config) : new LLMGateway(base);
  for (const m of models) {
    if (!probe.registry.has(m)) throw new UsageError(`unknown model ${m} (known: ${probe.registry.list().map((p) => p.id).join(", ")})`);
    const key = keyFor[probe.profile(m).provider];
    if (!deps.makeGateway && key && !env[key]) {
      io.stderr(`aicad-agent: ${m} needs ${key}\n`);
      return 2;
    }
  }
  // A CLI plan (subscription) is shared with the user's own work and has five-hour limits (§13.4):
  // one task at a time, and 5 tasks unless --limit says otherwise (--limit 0: all, said out loud).
  const onPlan = models.some((m) => probe.profile(m).billing === "subscription");
  const limit = flags.get("--limit");
  if (limit !== undefined) {
    const n = num(flags, "--limit", tasks.length, (x) => Number.isInteger(x) && x >= 0);
    if (n > 0) tasks = tasks.slice(0, n);
    else if (onPlan) io.stderr(`aicad-agent: --limit 0: running all ${tasks.length} tasks per model on your CLI plan (its usage limits apply)\n`);
  } else if (onPlan && tasks.length > 5) {
    tasks = tasks.slice(0, 5);
    io.stderr("aicad-agent: CLI plan models: running the first 5 tasks (--limit <n> to change, --limit 0 for all)\n");
  }
  const engine = await makeEngine(flags.get("--engine") ?? "oracle", flags, io, deps);
  const a = await engine.availability();
  if (!a.available) {
    io.stderr(`aicad-agent: engine ${engine.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const small = models.flatMap((m) => {
    const s = smallModelForProfile(probe.profile(m));
    return s !== null && probe.registry.has(s) ? [s] : [];
  });
  const host = deps.makeGateway ? null : await cliHost([...models, ...small], probe, flags, io, deps, env);
  const gateway = (_model: string) => (deps.makeGateway ? deps.makeGateway(config) : new LLMGateway(withCli(base, host)));
  const out = resolve(io.cwd, flags.get("--out") ?? join("artifacts", "bench", new Date().toISOString().replace(/[:.]/g, "-")));
  io.stderr(`aicad-agent: bake-off of ${models.join(", ")} on ${tasks.length} tasks, engine ${engine.kind} (${a.detail})\n`);
  const { table } = await runBakeOff({
    tasks,
    models,
    engine,
    gateway,
    budgetUsd: num(flags, "--budget", 1.5, (x) => x > 0),
    concurrency: num(flags, "--concurrency", onPlan ? 1 : 2, (x) => Number.isInteger(x) && x > 0),
    outDir: out,
    agent: { cliMode: cliMode(flags), ...(host?.runtime ? { runtime: host.runtime } : {}), limits: { ...BENCH_LIMITS, ...limitFlags(flags) } },
    onResult: (model, line) => io.stderr(`  ${model}: ${line}\n`),
  });
  io.stdout(`${table}\n\nwrote ${join(out, "comparison.md")}\n`);
  return 0;
}

export async function main(argv: string[], io: CliIo, deps: CliDeps = {}): Promise<number> {
  try {
    const { command, flags } = parseArgs(argv);
    if (flags.has("--help") || command === undefined) {
      io.stdout(USAGE);
      return command === undefined && !flags.has("--help") ? 2 : 0;
    }
    if (command === "run") return await cmdRun(flags, io, deps);
    if (command === "bench") return await cmdBench(flags, io, deps);
    throw new UsageError(`unknown command ${command}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`aicad-agent: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof GatewayError && (e.code === "unknown_model" || e.code === "config")) {
      io.stderr(`aicad-agent: ${e.message}\n`);
      return 2;
    }
    if (e instanceof TaskLoadError) {
      io.stderr(`aicad-agent: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
