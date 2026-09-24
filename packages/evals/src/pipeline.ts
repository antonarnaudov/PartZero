/**
 * The evaluation pipeline, per task:
 *
 *   solver ─► CadScript compile ─► engine eval ─► hidden tests ─► score
 *   (solver)   (compile)           (kernel)        (tests)
 *
 * The first stage that fails is the task's failure category. A task **passes** when the candidate
 * compiles without errors, the engine report has status `ok`, and every hidden test passes.
 * T4 context models are compiled and evaluated with the same engine (category `harness` if that fails).
 */
import { compile } from "@aicad/cadscript";
import type { EvalReport, IrDocument } from "@aicad/ir-types";
import { bodiesOf, describeTest, evaluateTests, type CheckContext, type Subject, type TestResult } from "./checks.js";
import { EngineError, type Engine } from "./engine.js";
import type { Solver } from "./solver.js";
import { publicTask, TIERS, type CheckName, type LoadedTask, type Process, type Tier } from "./task.js";

export const RESULTS_SCHEMA = "aicad.evals.results/0";

export type FailureCategory = "solver" | "compile" | "kernel" | "tests" | "harness";
export const FAILURE_CATEGORIES: readonly FailureCategory[] = ["solver", "compile", "kernel", "tests", "harness"];

export interface CompileDiagnostic {
  code: string;
  message: string;
  line: number;
  col: number;
  hint?: string;
}

export interface TaskResult {
  id: string;
  tier: Tier;
  title: string;
  process: Process;
  tags: string[];
  pass: boolean;
  /** First failing stage; null when the task passed. */
  category: FailureCategory | null;
  /** Fraction of hidden tests passed (0 when the candidate never reached the tests). */
  score: number;
  /** Compiled, evaluated with status ok, ≥ 1 body, every body valid. */
  valid: boolean;
  tests: TestResult[];
  /** `report.status` of the candidate, when the engine produced a report. */
  report_status?: "ok" | "error";
  /** The engine's identifier (`report.engine`). */
  engine?: string;
  /** Feature-level failures from the engine report. */
  feature_errors?: { feature: string; code: string; message: string }[];
  compile_diagnostics?: CompileDiagnostic[];
  /** Solver, engine or harness error. */
  error?: { code: string; message: string };
  cost_usd?: number;
  /** Who paid `cost_usd` (the solver's `billing`); `subscription` amounts are notional. Absent = metered. */
  billing?: "metered" | "subscription" | "local";
  /** Solver latency (solver-reported, else measured wall time). */
  latency_ms: number;
  engine_ms?: number;
}

export interface RateSummary {
  tasks: number;
  passed: number;
  /** passed / tasks (one sample per task). */
  pass_at_1: number;
  valid: number;
  validity_rate: number;
  tests_total: number;
  tests_passed: number;
  test_pass_rate: number;
}

export interface Distribution {
  n: number;
  total: number;
  mean: number;
  p50: number;
  p90: number;
  max: number;
}

export interface SuiteSummary extends RateSummary {
  by_tier: Partial<Record<Tier, RateSummary>>;
  categories: Record<FailureCategory, number>;
  /** Pass rate of each check type across all tasks. */
  checks: Partial<Record<CheckName, { total: number; passed: number }>>;
  cost_usd: Distribution;
  latency_ms: Distribution;
}

export interface SuiteResult {
  schema: typeof RESULTS_SCHEMA;
  suite: string;
  solver: string;
  engine: { kind: string; ids: string[] };
  /** Tasks skipped because the solver or the engine capabilities do not cover them. */
  skipped: { id: string; reason: string }[];
  summary: SuiteSummary;
  tasks: TaskResult[];
}

export interface RunOptions {
  solver: Solver;
  engine: Engine;
  /** Parallel tasks (results are always in task-id order). Default 4. */
  concurrency?: number;
  suite?: string;
  onResult?: (r: TaskResult) => void;
}

function errorInfo(e: unknown): { code: string; message: string } {
  if (e instanceof EngineError) return { code: e.code, message: e.message };
  if (e instanceof Error) return { code: e.name || "Error", message: e.message };
  return { code: "Error", message: String(e) };
}

/** Compile + evaluate a CadScript source. */
async function evaluateSource(
  source: string,
  fileName: string,
  engine: Engine,
  name: string,
): Promise<{ ir: IrDocument | null; diagnostics: CompileDiagnostic[]; report?: EvalReport; engineMs?: number; error?: unknown }> {
  const c = compile(source, { fileName });
  const diagnostics = c.diagnostics
    .filter((d) => d.severity === "error")
    .map((d) => {
      const out: CompileDiagnostic = { code: d.code, message: d.message, line: d.span.start.line, col: d.span.start.col };
      if (d.hint !== undefined) out.hint = d.hint;
      return out;
    });
  if (!c.ok || !c.ir) return { ir: null, diagnostics };
  const t0 = performance.now();
  try {
    const report = await engine.evaluate(c.ir, { name });
    return { ir: c.ir, diagnostics, report, engineMs: Math.round(performance.now() - t0) };
  } catch (error) {
    return { ir: c.ir, diagnostics, error, engineMs: Math.round(performance.now() - t0) };
  }
}

/** Context models are evaluated once per task and engine. */
const contextCache = new WeakMap<Engine, Map<string, Promise<Subject>>>();

function contextSubject(task: LoadedTask, engine: Engine): Promise<Subject> {
  let perEngine = contextCache.get(engine);
  if (!perEngine) contextCache.set(engine, (perEngine = new Map()));
  const key = `${task.id}\n${task.contextSource}`;
  let p = perEngine.get(key);
  if (!p) {
    p = (async () => {
      const r = await evaluateSource(task.contextSource!, task.context!, engine, `${task.id}.context`);
      if (!r.ir) throw new Error(`context ${task.context} does not compile: ${r.diagnostics.map((d) => d.message).join("; ")}`);
      if (!r.report) throw r.error ?? new Error("context evaluation failed");
      if (r.report.status !== "ok") throw new Error(`context ${task.context} evaluates with status error`);
      return { report: r.report, ir: r.ir };
    })();
    perEngine.set(key, p);
  }
  return p;
}

/** Run one task end to end. Never throws; every failure becomes a categorised result. */
export async function runTask(task: LoadedTask, solver: Solver, engine: Engine): Promise<TaskResult> {
  const base = { id: task.id, tier: task.tier, title: task.title, process: task.process, tags: [...task.tags] };
  const failed = (category: FailureCategory, extra: Partial<TaskResult>, latency: number): TaskResult => ({
    ...base,
    pass: false,
    category,
    score: 0,
    valid: false,
    // The hidden tests still count (as failed) in every rate.
    tests: task.hidden_tests.map((t) => ({
      id: t.id,
      description: t.description,
      check: t.check,
      pass: false,
      expected: describeTest(t),
      message: `not run: the ${category} stage failed`,
    })),
    latency_ms: latency,
    ...extra,
  });

  // 1. Solver.
  const t0 = performance.now();
  let out;
  try {
    out = await solver.solve(publicTask(task));
  } catch (e) {
    return failed("solver", { error: errorInfo(e) }, Math.round(performance.now() - t0));
  }
  const latency = out.latencyMs ?? Math.round(performance.now() - t0);
  const cost = { ...(out.costUsd !== undefined ? { cost_usd: out.costUsd } : {}), ...(out.billing !== undefined && out.billing !== "metered" ? { billing: out.billing } : {}) };

  // 2. Compile + 3. kernel.
  const r = await evaluateSource(out.cadscript, `${task.id}.cad.ts`, engine, task.id);
  if (!r.ir) return failed("compile", { compile_diagnostics: r.diagnostics, ...cost }, latency);
  const engineMs = r.engineMs !== undefined ? { engine_ms: r.engineMs } : {};
  if (!r.report) return failed("kernel", { error: errorInfo(r.error), ...cost, ...engineMs }, latency);
  const report = r.report;

  let context: Subject | undefined;
  if (task.contextSource !== undefined) {
    try {
      context = await contextSubject(task, engine);
    } catch (e) {
      return failed("harness", { error: errorInfo(e), report_status: report.status, engine: report.engine, ...cost, ...engineMs }, latency);
    }
  }

  // 4. Hidden tests.
  const ctx: CheckContext = { candidate: { report, ir: r.ir }, context };
  const tests = evaluateTests(task.hidden_tests, ctx);
  const passed = tests.filter((t) => t.pass).length;
  const bodies = bodiesOf(report);
  const valid = report.status === "ok" && bodies.length > 0 && bodies.every((b) => b.valid);
  const pass = report.status === "ok" && passed === tests.length;
  const result: TaskResult = {
    ...base,
    pass,
    category: pass ? null : report.status !== "ok" ? "kernel" : "tests",
    score: tests.length > 0 ? passed / tests.length : 0,
    valid,
    tests,
    report_status: report.status,
    engine: report.engine,
    latency_ms: latency,
    ...cost,
    ...engineMs,
  };
  const featureErrors = report.features
    .filter((f) => f.status !== "ok")
    .map((f) => ({ feature: f.feature, code: f.error?.code ?? "UNKNOWN", message: f.error?.message ?? "" }));
  if (featureErrors.length > 0) result.feature_errors = featureErrors;
  return result;
}

// ─── Aggregates ────────────────────────────────────────────────────────────────────────────

function rate(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function rates(results: readonly TaskResult[]): RateSummary {
  const passed = results.filter((r) => r.pass).length;
  const valid = results.filter((r) => r.valid).length;
  const testsTotal = results.reduce((n, r) => n + r.tests.length, 0);
  const testsPassed = results.reduce((n, r) => n + r.tests.filter((t) => t.pass).length, 0);
  return {
    tasks: results.length,
    passed,
    pass_at_1: rate(passed, results.length),
    valid,
    validity_rate: rate(valid, results.length),
    tests_total: testsTotal,
    tests_passed: testsPassed,
    test_pass_rate: rate(testsPassed, testsTotal),
  };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i]!;
}

export function distribution(values: readonly number[]): Distribution {
  const s = [...values].sort((a, b) => a - b);
  const total = s.reduce((a, b) => a + b, 0);
  return { n: s.length, total, mean: rate(total, s.length), p50: quantile(s, 0.5), p90: quantile(s, 0.9), max: s[s.length - 1] ?? 0 };
}

export function summarize(results: readonly TaskResult[]): SuiteSummary {
  const byTier: Partial<Record<Tier, RateSummary>> = {};
  for (const tier of TIERS) {
    const rs = results.filter((r) => r.tier === tier);
    if (rs.length > 0) byTier[tier] = rates(rs);
  }
  const categories = Object.fromEntries(FAILURE_CATEGORIES.map((c) => [c, 0])) as Record<FailureCategory, number>;
  for (const r of results) if (r.category) categories[r.category]++;
  const checks: Partial<Record<CheckName, { total: number; passed: number }>> = {};
  for (const r of results) {
    for (const t of r.tests) {
      const c = (checks[t.check] ??= { total: 0, passed: 0 });
      c.total++;
      if (t.pass) c.passed++;
    }
  }
  const sortedChecks = Object.fromEntries(Object.entries(checks).sort(([a], [b]) => (a < b ? -1 : 1)));
  return {
    ...rates(results),
    by_tier: byTier,
    categories,
    checks: sortedChecks,
    cost_usd: distribution(results.flatMap((r) => (r.cost_usd !== undefined ? [r.cost_usd] : []))),
    latency_ms: distribution(results.map((r) => r.latency_ms)),
  };
}

/** Run a solver over tasks with a bounded pool; results are in task order. */
export async function runSuite(tasks: readonly LoadedTask[], options: RunOptions): Promise<SuiteResult> {
  const { solver, engine } = options;
  const skipped: { id: string; reason: string }[] = [];
  const runnable: LoadedTask[] = [];
  for (const t of [...tasks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (solver.applicable && !solver.applicable(t)) skipped.push({ id: t.id, reason: `${solver.name} does not apply` });
    else runnable.push(t);
  }
  const results: TaskResult[] = new Array<TaskResult>(runnable.length);
  let next = 0;
  const worker = async () => {
    while (next < runnable.length) {
      const i = next++;
      const r = await runTask(runnable[i]!, solver, engine);
      results[i] = r;
      options.onResult?.(r);
    }
  };
  const n = Math.max(1, Math.min(options.concurrency ?? 4, runnable.length));
  await Promise.all(Array.from({ length: n }, worker));
  const ids = [...new Set(results.flatMap((r) => (r.engine ? [r.engine] : [])))].sort();
  return {
    schema: RESULTS_SCHEMA,
    suite: options.suite ?? "makerbench",
    solver: solver.name,
    engine: { kind: engine.kind, ids },
    skipped,
    summary: summarize(results),
    tasks: results,
  };
}
