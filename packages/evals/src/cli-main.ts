/**
 * The `aicad-evals` command line (logic only; `cli.ts` wires it to the process).
 *
 *   aicad-evals run --tasks <dir>[,<dir>] [--solver reference|mutant:<kind>] [--engine auto|forge|oracle|fixture] [--out <dir>]
 *   aicad-evals validate --tasks <dir>[,<dir>]
 *   aicad-evals fixtures --tasks <dir>[,<dir>] [--engine oracle|forge] [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compile, formatDiagnostic, typecheck, v1 as cs } from "@aicad/cadscript";
import { ALLOW_RETRY_ENV, FixtureEngine, ForgeCliEngine, OracleEngine, type Engine } from "./engine.js";
import { recordTaskFixtures, writeFixture } from "./fixtures.js";
import { isMutationKind, MUTATIONS } from "./mutate.js";
import { runSuite } from "./pipeline.js";
import { packageRoot } from "./paths.js";
import { renderReport } from "./report.js";
import { MutantSolver, ReferenceSolver, type Solver } from "./solver.js";
import { IR0_CAPABILITIES, IR1_CAPABILITIES, isSupported, isV1Task, loadTasks, readTask, TaskLoadError, taskFiles, TIERS, type LoadedTask, type Tier } from "./task.js";
import { isMutationKindV1, MUTATIONS_V1 } from "./v1/mutate.js";

const ALL_MUTATIONS = [...new Set([...MUTATIONS, ...MUTATIONS_V1])];

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Base directory for relative paths (the process cwd). */
  cwd: string;
}

export const USAGE = `Usage:
  aicad-evals run --tasks <dir>[,<dir>] [options]
      Run a solver over MakerBench tasks and write <out>/results.json and <out>/report.md.
      IR v1 tasks (requires ir/1, e.g. corpus/makerbench/v1) are compiled with CadScript v1 and
      evaluated with the engine's IR v1 pipeline.
      --solver reference | mutant:${ALL_MUTATIONS.join(" | mutant:")}   (default: reference)
               (v0 tasks: mutant:${MUTATIONS.join("|")}; v1 tasks: mutant:${MUTATIONS_V1.join("|")})
      --engine auto | forge | oracle | fixture   (default: auto = forge, else oracle, else fixture)
      --out <dir>              (default: artifacts/evals/<solver>-<engine>)
      --fixtures <dir>[,<dir>] fixture reports for --engine fixture
                               (default: packages/evals/fixtures/makerbench and makerbench-v1)
      --forge-bin <path>       aicad binary (default: forge/target/debug/aicad)
      --oracle-dir <path>      oracle uv project (default: oracle/)
      --oracle-standalone      IR v1: never let the oracle replay Forge's report (by default it does,
                               only for a constrained sketch it cannot evaluate alone, SPEC-v1 §8.1)
      --tier T1,T2             only these tiers
      --only <id,id>           only these task ids
      --capabilities <list>    engine capabilities (default: the IR v1 feature set for engines that
                               evaluate IR v1, else the ir/0 set); tasks needing more are skipped
      --concurrency <n>        parallel tasks (default 4; results are always in task order)
      --fail-under <rate>      exit 1 when pass@1 is below this fraction (e.g. 1 for reference runs)
      --allow-retry            do not fail when the OS killed an aicad run (SIGKILL under memory
                               pressure) and it was run again; by default that exits 1 and lists
                               the documents in results.json (engine_retries). Also ${ALLOW_RETRY_ENV}=1.
  aicad-evals validate --tasks <dir>[,<dir>]
      Validate task files (JSON Schema + semantics) and compile/type-check their CadScript files
      (CadScript v1 for tasks that require ir/1).
  aicad-evals fixtures --tasks <dir>[,<dir>] [--engine oracle|forge] [--out <dir>] [--only <id,id>] [--allow-retry]
      Record engine reports for every reference, T4 context and mutant (for --engine fixture); IR v1
      tasks also record the param variants. Default out: packages/evals/fixtures/makerbench (v0
      tasks) and packages/evals/fixtures/makerbench-v1 (v1 tasks).
Exit codes: 0 ok, 1 failures (invalid tasks, pass@1 under --fail-under, an aicad run retried
without --allow-retry), 2 usage error or engine unavailable.
`;

class UsageError extends Error {}

interface Parsed {
  command: string | undefined;
  flags: Map<string, string>;
}

const VALUE_FLAGS = new Set([
  "--tasks",
  "--solver",
  "--engine",
  "--out",
  "--fixtures",
  "--forge-bin",
  "--oracle-dir",
  "--tier",
  "--only",
  "--capabilities",
  "--concurrency",
  "--fail-under",
]);
const BOOLEAN_FLAGS = new Set(["--oracle-standalone", "--allow-retry"]);

function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      flags.set("--help", "1");
    } else if (BOOLEAN_FLAGS.has(a)) {
      flags.set(a, "1");
    } else if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new UsageError(`${a} needs a value`);
      flags.set(a, v);
    } else if (a.startsWith("-")) {
      throw new UsageError(`unknown option ${a}`);
    } else if (command === undefined) {
      command = a;
    } else {
      throw new UsageError(`unexpected argument ${a}`);
    }
  }
  return { command, flags };
}

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** The `--tasks` directories (comma-separated). */
function requireTasksDirs(p: Parsed, io: CliIo): string[] {
  const dirs = list(p.flags.get("--tasks"));
  if (!dirs || dirs.length === 0) throw new UsageError("--tasks <dir> is required");
  return dirs.map((d) => resolve(io.cwd, d));
}

/** Every task of every `--tasks` directory, sorted by id; ids must be unique across directories. */
function loadAllTasks(dirs: readonly string[]): LoadedTask[] {
  const all = dirs.flatMap((d) => loadTasks(d));
  const seen = new Set<string>();
  for (const t of all) {
    if (seen.has(t.id)) throw new UsageError(`task id ${t.id} appears in more than one --tasks directory`);
    seen.add(t.id);
  }
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function selectTasks(tasks: LoadedTask[], p: Parsed): LoadedTask[] {
  const tiers = list(p.flags.get("--tier"));
  if (tiers) for (const t of tiers) if (!(TIERS as readonly string[]).includes(t)) throw new UsageError(`unknown tier ${t}`);
  const only = list(p.flags.get("--only"));
  if (only) for (const id of only) if (!tasks.some((t) => t.id === id)) throw new UsageError(`unknown task ${id}`);
  return tasks.filter((t) => (!tiers || tiers.includes(t.tier as Tier)) && (!only || only.includes(t.id)));
}

/**
 * The engine `kind` names. Every Forge CLI engine it creates (the engine itself, or the oracle's
 * replay engine) is added to `forges`, whose `retried` documents the command checks afterwards.
 */
async function makeEngine(kind: string, p: Parsed, io: CliIo, forges: ForgeCliEngine[] = []): Promise<Engine> {
  const forge = () => {
    const bin = p.flags.get("--forge-bin");
    const f = new ForgeCliEngine(bin ? { bin: resolve(io.cwd, bin) } : {});
    forges.push(f);
    return f;
  };
  const oracle = async () => {
    const dir = p.flags.get("--oracle-dir");
    let replay: Engine | undefined;
    if (!p.flags.has("--oracle-standalone")) {
      const f = forge();
      if ((await f.availability()).available) replay = f;
    }
    return new OracleEngine({ ...(dir ? { oracleDir: resolve(io.cwd, dir) } : {}), replay });
  };
  const fixture = () =>
    new FixtureEngine(
      (list(p.flags.get("--fixtures")) ?? [join(packageRoot(), "fixtures", "makerbench"), join(packageRoot(), "fixtures", "makerbench-v1")]).map((d) =>
        resolve(io.cwd, d),
      ),
    );
  if (kind === "forge") return forge();
  if (kind === "oracle") return oracle();
  if (kind === "fixture") return fixture();
  if (kind === "auto") {
    for (const make of [forge, oracle, fixture]) {
      const e = await make();
      const a = await e.availability();
      if (a.available) return e;
      io.stderr(`aicad-evals: ${e.kind} unavailable: ${a.detail}\n`);
    }
    throw new UsageError("no engine available");
  }
  throw new UsageError(`unknown engine ${kind} (forge | oracle | fixture | auto)`);
}

function makeSolver(name: string, tasks: LoadedTask[]): Solver {
  if (name === "reference") return new ReferenceSolver(tasks);
  if (name.startsWith("mutant:")) {
    const kind = name.slice("mutant:".length);
    if (!isMutationKind(kind) && !isMutationKindV1(kind)) throw new UsageError(`unknown mutation ${kind} (${ALL_MUTATIONS.join(", ")})`);
    return new MutantSolver(tasks, kind);
  }
  throw new UsageError(`unknown solver ${name} (reference | mutant:<kind>)`);
}

/**
 * The documents the OS killed and that were run again (`ForgeCliEngine.retried`), and whether
 * the run must fail for them (no `--allow-retry`, no `AICAD_EVALS_ALLOW_RETRY=1`).
 */
function retries(forges: readonly ForgeCliEngine[], p: Parsed): { retried: string[]; fail: boolean } {
  const retried = forges.flatMap((f) => f.retried);
  const allowed = p.flags.has("--allow-retry") || process.env[ALLOW_RETRY_ENV] === "1";
  return { retried, fail: retried.length > 0 && !allowed };
}

function reportRetries(r: { retried: string[]; fail: boolean }, io: CliIo): void {
  if (r.retried.length === 0) return;
  io.stderr(`aicad-evals: aicad runs killed by the OS (SIGKILL) and run again:\n${r.retried.map((x) => `  ${x}\n`).join("")}`);
  io.stderr(r.fail ? `aicad-evals: failing: a gate never passes on a second run unnoticed (rerun with lower --concurrency, or pass --allow-retry for a memory-constrained local run)\n` : `aicad-evals: allowed (--allow-retry)\n`);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function cmdRun(p: Parsed, io: CliIo): Promise<number> {
  const all = loadAllTasks(requireTasksDirs(p, io));
  const selected = selectTasks(all, p);
  const solver = makeSolver(p.flags.get("--solver") ?? "reference", all);
  const forges: ForgeCliEngine[] = [];
  const engine = await makeEngine(p.flags.get("--engine") ?? "auto", p, io, forges);
  const caps = list(p.flags.get("--capabilities")) ?? [...(engine.evaluateV1 ? IR1_CAPABILITIES : IR0_CAPABILITIES)];
  const unsupported = selected.filter((t) => !isSupported(t, caps));
  const tasks = selected.filter((t) => isSupported(t, caps));
  const a = await engine.availability();
  if (!a.available) {
    io.stderr(`aicad-evals: engine ${engine.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const concurrency = Number(p.flags.get("--concurrency") ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new UsageError("--concurrency must be a positive integer");
  const failUnder = p.flags.get("--fail-under");
  if (failUnder !== undefined && !(Number(failUnder) >= 0 && Number(failUnder) <= 1)) throw new UsageError("--fail-under must be in [0, 1]");

  io.stderr(`aicad-evals: ${tasks.length} tasks, solver ${solver.name}, engine ${engine.kind} (${a.detail})\n`);
  const result = await runSuite(tasks, {
    solver,
    engine,
    concurrency,
    onResult: (r) => io.stderr(`  ${r.pass ? "pass" : "FAIL"} ${r.id}${r.category ? ` [${r.category}]` : ""}\n`),
  });
  result.skipped.push(...unsupported.map((t) => ({ id: t.id, reason: `requires ${t.requires.filter((r) => !caps.includes(r)).join(", ")}` })));
  result.skipped.sort((x, y) => (x.id < y.id ? -1 : 1));
  const retry = retries(forges, p);
  if (retry.retried.length > 0) result.engine_retries = retry.retried;

  const safeSolver = solver.name.replace(/[^A-Za-z0-9_-]/g, "-");
  const out = resolve(io.cwd, p.flags.get("--out") ?? join("artifacts", "evals", `${safeSolver}-${engine.kind}`));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(out, "report.md"), renderReport(result) + "\n");

  const s = result.summary;
  io.stdout(
    `pass@1 ${pct(s.pass_at_1)} (${s.passed}/${s.tasks}), validity ${pct(s.validity_rate)}, hidden tests ${pct(s.test_pass_rate)} (${s.tests_passed}/${s.tests_total})\n`,
  );
  for (const tier of TIERS) {
    const r = s.by_tier[tier];
    if (r) io.stdout(`  ${tier}: ${r.passed}/${r.tasks} (${pct(r.pass_at_1)})\n`);
  }
  io.stdout(`wrote ${join(out, "results.json")} and ${join(out, "report.md")}\n`);
  reportRetries(retry, io);
  if (failUnder !== undefined && s.pass_at_1 < Number(failUnder)) {
    io.stderr(`aicad-evals: pass@1 ${pct(s.pass_at_1)} is below --fail-under ${failUnder}\n`);
    return 1;
  }
  return retry.fail ? 1 : 0;
}

function cmdValidate(p: Parsed, io: CliIo): number {
  let problems = 0;
  let count = 0;
  for (const dir of requireTasksDirs(p, io)) {
    for (const file of taskFiles(dir)) {
      count++;
      const r = readTask(file);
      const name = file.slice(dir.length + 1);
      for (const prob of r.problems) {
        problems++;
        io.stdout(`${name}: ${prob}\n`);
      }
      if (!r.task) continue;
      const sources: [string, string][] = [[r.task.reference, r.task.referenceSource]];
      if (r.task.context !== undefined) sources.push([r.task.context, r.task.contextSource!]);
      const v1 = isV1Task(r.task);
      for (const [f, src] of sources) {
        const diags = v1
          ? [...cs.compile(src, { fileName: f }).diagnostics.filter((d) => d.severity === "error"), ...cs.typecheck(src)]
          : [...compile(src, { fileName: f }).diagnostics.filter((d) => d.severity === "error"), ...typecheck(src)];
        for (const d of diags) {
          problems++;
          io.stdout(`${formatDiagnostic(d, f)}\n`);
        }
      }
    }
  }
  io.stdout(`${count} tasks, ${problems} problems\n`);
  return problems > 0 ? 1 : 0;
}

async function cmdFixtures(p: Parsed, io: CliIo): Promise<number> {
  const tasks = selectTasks(loadAllTasks(requireTasksDirs(p, io)), p);
  const kind = p.flags.get("--engine") ?? "oracle";
  if (kind === "fixture") throw new UsageError("fixtures must be recorded with a real engine (oracle or forge)");
  const forges: ForgeCliEngine[] = [];
  const engine = await makeEngine(kind, p, io, forges);
  const a = await engine.availability();
  if (!a.available) {
    io.stderr(`aicad-evals: engine ${engine.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const given = p.flags.get("--out");
  const outOf = (t: LoadedTask) => resolve(io.cwd, given ?? join(packageRoot(), "fixtures", isV1Task(t) ? "makerbench-v1" : "makerbench"));
  const concurrency = Number(p.flags.get("--concurrency") ?? 4);
  let next = 0;
  let entries = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++]!;
      const f = await recordTaskFixtures(t, engine);
      writeFixture(outOf(t), f);
      entries += f.entries.length;
      io.stderr(`  ${t.id}: ${f.entries.map((e) => `${e.label}=${e.report.status}`).join(", ")}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  io.stdout(`recorded ${entries} reports for ${tasks.length} tasks in ${[...new Set(tasks.map(outOf))].join(", ")}\n`);
  const retry = retries(forges, p);
  reportRetries(retry, io);
  return retry.fail ? 1 : 0;
}

export async function main(argv: string[], io: CliIo): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
    if (p.flags.has("--help") || p.command === undefined) {
      io.stdout(USAGE);
      return p.command === undefined && !p.flags.has("--help") ? 2 : 0;
    }
    switch (p.command) {
      case "run":
        return await cmdRun(p, io);
      case "validate":
        return cmdValidate(p, io);
      case "fixtures":
        return await cmdFixtures(p, io);
      default:
        throw new UsageError(`unknown command ${p.command}`);
    }
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`aicad-evals: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    if (e instanceof TaskLoadError) {
      io.stderr(`aicad-evals: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
