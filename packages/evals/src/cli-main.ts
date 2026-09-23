/**
 * The `aicad-evals` command line (logic only; `cli.ts` wires it to the process).
 *
 *   aicad-evals run --tasks <dir> [--solver reference|mutant:<kind>] [--engine auto|forge|oracle|fixture] [--out <dir>]
 *   aicad-evals validate --tasks <dir>
 *   aicad-evals fixtures --tasks <dir> [--engine oracle|forge] [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compile, formatDiagnostic, typecheck } from "@aicad/cadscript";
import { FixtureEngine, ForgeCliEngine, OracleEngine, type Engine } from "./engine.js";
import { recordFixtures, writeFixture } from "./fixtures.js";
import { isMutationKind, MUTATIONS } from "./mutate.js";
import { runSuite } from "./pipeline.js";
import { packageRoot } from "./paths.js";
import { renderReport } from "./report.js";
import { MutantSolver, ReferenceSolver, type Solver } from "./solver.js";
import { IR0_CAPABILITIES, isSupported, loadTasks, readTask, TaskLoadError, taskFiles, TIERS, type LoadedTask, type Tier } from "./task.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Base directory for relative paths (the process cwd). */
  cwd: string;
}

export const USAGE = `Usage:
  aicad-evals run --tasks <dir> [options]
      Run a solver over MakerBench tasks and write <out>/results.json and <out>/report.md.
      --solver reference | mutant:${MUTATIONS.join(" | mutant:")}   (default: reference)
      --engine auto | forge | oracle | fixture   (default: auto = forge, else oracle, else fixture)
      --out <dir>              (default: artifacts/evals/<solver>-<engine>)
      --fixtures <dir>         fixture reports for --engine fixture (default: packages/evals/fixtures/makerbench)
      --forge-bin <path>       aicad binary (default: forge/target/debug/aicad)
      --oracle-dir <path>      oracle uv project (default: oracle/)
      --tier T1,T2             only these tiers
      --only <id,id>           only these task ids
      --capabilities <list>    engine capabilities (default: ir/0 feature set); tasks needing more are skipped
      --concurrency <n>        parallel tasks (default 4; results are always in task order)
      --fail-under <rate>      exit 1 when pass@1 is below this fraction (e.g. 1 for reference runs)
  aicad-evals validate --tasks <dir>
      Validate task files (JSON Schema + semantics) and compile/type-check their CadScript files.
  aicad-evals fixtures --tasks <dir> [--engine oracle|forge] [--out <dir>] [--only <id,id>]
      Record engine reports for every reference, T4 context and mutant (for --engine fixture).
Exit codes: 0 ok, 1 failures (invalid tasks, pass@1 under --fail-under), 2 usage error or engine unavailable.
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

function parseArgs(argv: string[]): Parsed {
  const flags = new Map<string, string>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") {
      flags.set("--help", "1");
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

function requireTasksDir(p: Parsed, io: CliIo): string {
  const dir = p.flags.get("--tasks");
  if (!dir) throw new UsageError("--tasks <dir> is required");
  return resolve(io.cwd, dir);
}

function selectTasks(tasks: LoadedTask[], p: Parsed): LoadedTask[] {
  const tiers = list(p.flags.get("--tier"));
  if (tiers) for (const t of tiers) if (!(TIERS as readonly string[]).includes(t)) throw new UsageError(`unknown tier ${t}`);
  const only = list(p.flags.get("--only"));
  if (only) for (const id of only) if (!tasks.some((t) => t.id === id)) throw new UsageError(`unknown task ${id}`);
  return tasks.filter((t) => (!tiers || tiers.includes(t.tier as Tier)) && (!only || only.includes(t.id)));
}

async function makeEngine(kind: string, p: Parsed, io: CliIo): Promise<Engine> {
  const forge = () => {
    const bin = p.flags.get("--forge-bin");
    return new ForgeCliEngine(bin ? { bin: resolve(io.cwd, bin) } : {});
  };
  const oracle = () => {
    const dir = p.flags.get("--oracle-dir");
    return new OracleEngine(dir ? { oracleDir: resolve(io.cwd, dir) } : {});
  };
  const fixture = () => new FixtureEngine(resolve(io.cwd, p.flags.get("--fixtures") ?? join(packageRoot(), "fixtures", "makerbench")));
  if (kind === "forge") return forge();
  if (kind === "oracle") return oracle();
  if (kind === "fixture") return fixture();
  if (kind === "auto") {
    for (const make of [forge, oracle, fixture]) {
      const e = make();
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
    if (!isMutationKind(kind)) throw new UsageError(`unknown mutation ${kind} (${MUTATIONS.join(", ")})`);
    return new MutantSolver(tasks, kind);
  }
  throw new UsageError(`unknown solver ${name} (reference | mutant:<kind>)`);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

async function cmdRun(p: Parsed, io: CliIo): Promise<number> {
  const dir = requireTasksDir(p, io);
  const all = loadTasks(dir);
  const selected = selectTasks(all, p);
  const caps = list(p.flags.get("--capabilities")) ?? [...IR0_CAPABILITIES];
  const unsupported = selected.filter((t) => !isSupported(t, caps));
  const tasks = selected.filter((t) => isSupported(t, caps));
  const solver = makeSolver(p.flags.get("--solver") ?? "reference", all);
  const engine = await makeEngine(p.flags.get("--engine") ?? "auto", p, io);
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
  if (failUnder !== undefined && s.pass_at_1 < Number(failUnder)) {
    io.stderr(`aicad-evals: pass@1 ${pct(s.pass_at_1)} is below --fail-under ${failUnder}\n`);
    return 1;
  }
  return 0;
}

function cmdValidate(p: Parsed, io: CliIo): number {
  const dir = requireTasksDir(p, io);
  let problems = 0;
  let count = 0;
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
    for (const [f, src] of sources) {
      const diags = [...compile(src, { fileName: f }).diagnostics.filter((d) => d.severity === "error"), ...typecheck(src)];
      for (const d of diags) {
        problems++;
        io.stdout(`${formatDiagnostic(d, f)}\n`);
      }
    }
  }
  io.stdout(`${count} tasks, ${problems} problems\n`);
  return problems > 0 ? 1 : 0;
}

async function cmdFixtures(p: Parsed, io: CliIo): Promise<number> {
  const dir = requireTasksDir(p, io);
  const tasks = selectTasks(loadTasks(dir), p);
  const kind = p.flags.get("--engine") ?? "oracle";
  if (kind === "fixture") throw new UsageError("fixtures must be recorded with a real engine (oracle or forge)");
  const engine = await makeEngine(kind, p, io);
  const a = await engine.availability();
  if (!a.available) {
    io.stderr(`aicad-evals: engine ${engine.kind} is not available: ${a.detail}\n`);
    return 2;
  }
  const out = resolve(io.cwd, p.flags.get("--out") ?? join(packageRoot(), "fixtures", "makerbench"));
  const concurrency = Number(p.flags.get("--concurrency") ?? 4);
  let next = 0;
  let entries = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++]!;
      const f = await recordFixtures(t, engine);
      writeFixture(out, f);
      entries += f.entries.length;
      io.stderr(`  ${t.id}: ${f.entries.map((e) => `${e.label}=${e.report.status}`).join(", ")}\n`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length)) }, worker));
  io.stdout(`recorded ${entries} reports for ${tasks.length} tasks in ${out}\n`);
  return 0;
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
