/**
 * The `aicad-agent` command line (logic only; `cli.ts` wires it to the process).
 *
 *   aicad-agent run --prompt "…" [--context file.cad.ts] [--engine oracle|forge|fixture|auto] [--designer-model id] …
 *   aicad-agent bench --tasks corpus/makerbench --models a,b [--engine oracle] [--out artifacts/bench/<run>] …
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  AnthropicSdkTransport,
  GatewayError,
  GoogleSdkTransport,
  LLMGateway,
  OpenAISdkTransport,
  RecordingTransport,
  ReplayTransport,
  type Fixture,
  type GatewayConfig,
  type Provider,
  type ProviderTransport,
} from "@aicad/llm-gateway";
import { FixtureEngine, ForgeCliEngine, IR0_CAPABILITIES, isSupported, loadTasks, OracleEngine, TaskLoadError, TIERS, type Engine, type Tier } from "@aicad/evals";
import { summarizeTests } from "@aicad/agent-tools";
import { Agent } from "./agent.js";
import { runBakeOff } from "./bench.js";
import type { ModelOverrides } from "./models.js";
import { formatTraceSummary } from "./trace.js";
import type { TriageKind } from "./triage.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
}

/** Injection points for tests (offline gateways, fake engines). */
export interface CliDeps {
  makeGateway?: (config: GatewayConfig | undefined) => LLMGateway;
  makeEngine?: (kind: string) => Engine;
  env?: Record<string, string | undefined>;
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
  aicad-agent bench --tasks <dir> --models <id,id,…> [options]
      MakerBench bake-off: run every task once per designer model, write per-model results and a comparison table.
      --engine auto|oracle|forge|fixture   (default oracle)
      --out <dir>                 (default artifacts/bench/<timestamp>)
      --tier T1,T2   --only <id,id>   --limit <n>
      --budget <usd>              per task (default 1.5)
      --concurrency <n>           parallel tasks per model (default 2)
      --gateway-config <file>
Keys: ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY (per model provider).
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
]);

function parseArgs(argv: string[]): { command: string | undefined; flags: Map<string, string> } {
  const flags = new Map<string, string>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") flags.set("--help", "1");
    else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      flags.set(a, v);
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
  const engine = await makeEngine(flags.get("--engine") ?? "auto", flags, io, deps);
  const a = await engine.availability();
  if (!a.available) {
    io.stderr(`aicad-agent: engine ${engine.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const config = loadConfig(flags, io);
  const recordFile = flags.get("--record");
  const replayFile = flags.get("--replay");
  if (recordFile && replayFile) throw new UsageError("--record and --replay are exclusive");
  let recorders: RecordingTransport[] = [];
  let gateway: LLMGateway;
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
    gateway = new LLMGateway(config ? { config } : {});
  }
  const agent = new Agent({
    gateway,
    engine,
    models: overrides(flags),
    budgetUsd: num(flags, "--budget", 1.5, (x) => x > 0),
    mode: "eval",
    ...(kind ? { kind } : {}),
    hooks: { onEvent: (e) => io.stderr(`  [${(e.t / 1000).toFixed(1)}s ${e.state}] ${e.type}: ${e.text.split("\n")[0]}\n`) },
  });
  const r = await agent.run({ prompt, context, name: contextFile ? contextFile.replace(/.*\//, "").replace(/\.cad\.ts$/, "") : "design", process: flags.get("--process") });
  if (r.answer !== undefined) io.stdout(`${r.answer}\n`);
  else io.stdout(r.cadscript.endsWith("\n") ? r.cadscript : `${r.cadscript}\n`);
  const tests = r.tests ? summarizeTests(r.tests) : undefined;
  io.stderr(`\n${formatTraceSummary(r.trace, { status: r.status, ...(tests ? { tests: `${tests.passed}/${tests.total}${tests.failing.length ? ` (failing: ${tests.failing.join(", ")})` : ""}` } : {}) })}\n`);
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
  const limit = flags.get("--limit");
  if (limit !== undefined) tasks = tasks.slice(0, num(flags, "--limit", tasks.length, (x) => Number.isInteger(x) && x > 0));
  const engine = await makeEngine(flags.get("--engine") ?? "oracle", flags, io, deps);
  const a = await engine.availability();
  if (!a.available) {
    io.stderr(`aicad-agent: engine ${engine.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const config = loadConfig(flags, io);
  const gateway = (_model: string) => (deps.makeGateway ? deps.makeGateway(config) : new LLMGateway(config ? { config } : {}));
  // Check model ids and keys up front: a missing key would fail every task.
  const env = deps.env ?? process.env;
  const keyFor: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY" };
  const probe = gateway("");
  for (const m of models) {
    if (!probe.registry.has(m)) throw new UsageError(`unknown model ${m} (known: ${probe.registry.list().map((p) => p.id).join(", ")})`);
    const key = keyFor[probe.profile(m).provider];
    if (!deps.makeGateway && key && !env[key]) {
      io.stderr(`aicad-agent: ${m} needs ${key}\n`);
      return 2;
    }
  }
  const out = resolve(io.cwd, flags.get("--out") ?? join("artifacts", "bench", new Date().toISOString().replace(/[:.]/g, "-")));
  io.stderr(`aicad-agent: bake-off of ${models.join(", ")} on ${tasks.length} tasks, engine ${engine.kind} (${a.detail})\n`);
  const { table } = await runBakeOff({
    tasks,
    models,
    engine,
    gateway,
    budgetUsd: num(flags, "--budget", 1.5, (x) => x > 0),
    concurrency: num(flags, "--concurrency", 2, (x) => Number.isInteger(x) && x > 0),
    outDir: out,
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
