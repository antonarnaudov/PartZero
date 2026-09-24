/**
 * The designer-model bake-off: MakerBench once per designer model through the real evals pipeline
 * (solver → compile → engine → hidden tests), then a comparison table.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LLMGateway } from "@aicad/llm-gateway";
import { distribution, renderReport, runSuite, TIERS, type Engine, type LoadedTask, type SuiteResult } from "@aicad/evals";
import type { AgentOptions } from "./agent.js";
import { LLMSolver, type AgentRunRecord } from "./solver.js";

export interface BakeOffOptions {
  tasks: readonly LoadedTask[];
  /** Designer model profile ids. */
  models: readonly string[];
  engine: Engine;
  /** One gateway per model run (fresh ledger), or a shared one. */
  gateway: LLMGateway | ((model: string) => LLMGateway);
  budgetUsd?: number;
  concurrency?: number;
  /** Write `<out>/<model>/results.json`, `report.md` and `<out>/comparison.{md,json}`. */
  outDir?: string;
  agent?: LLMSolverAgentOptions;
  onResult?: (model: string, line: string) => void;
}

type LLMSolverAgentOptions = Partial<Omit<AgentOptions, "gateway" | "engine" | "models" | "budgetUsd">>;

export interface ModelRun {
  model: string;
  result: SuiteResult;
  runs: Record<string, AgentRunRecord>;
}

export interface ComparisonRow {
  model: string;
  tasks: number;
  pass_at_1: number;
  by_tier: Record<string, { passed: number; tasks: number }>;
  validity_rate: number;
  test_pass_rate: number;
  median_cost_usd: number;
  total_cost_usd: number;
  p50_latency_ms: number;
  median_turns: number;
  proposed: number;
  stopped: Record<string, number>;
  /** How the designer ran (ADR 0014): gateway, cli-completion, cli-runtime, or `mixed` across tasks. */
  mode: AgentRunRecord["mode"] | "mixed" | "none";
  /** Who paid: `subscription` costs are notional (the CLI plan's API list-price equivalent). */
  billing: AgentRunRecord["billing"] | "mixed" | "none";
}

function uniform<T extends string>(values: readonly T[]): T | "mixed" | "none" {
  const set = new Set(values);
  if (set.size === 0) return "none";
  return set.size === 1 ? values[0]! : "mixed";
}

function median(values: readonly number[]): number {
  return distribution(values).p50;
}

export function comparisonRows(runs: readonly ModelRun[]): ComparisonRow[] {
  return runs.map(({ model, result, runs: records }) => {
    const s = result.summary;
    const recs = Object.values(records);
    const stopped: Record<string, number> = {};
    for (const r of recs) if (r.status !== "proposed") stopped[r.stopReason] = (stopped[r.stopReason] ?? 0) + 1;
    const byTier: Record<string, { passed: number; tasks: number }> = {};
    for (const tier of TIERS) {
      const t = s.by_tier[tier];
      if (t) byTier[tier] = { passed: t.passed, tasks: t.tasks };
    }
    return {
      model,
      tasks: s.tasks,
      pass_at_1: s.pass_at_1,
      by_tier: byTier,
      validity_rate: s.validity_rate,
      test_pass_rate: s.test_pass_rate,
      median_cost_usd: s.cost_usd.p50,
      total_cost_usd: s.cost_usd.total,
      p50_latency_ms: s.latency_ms.p50,
      median_turns: median(recs.map((r) => r.turns)),
      proposed: recs.filter((r) => r.status === "proposed").length,
      stopped,
      mode: uniform(recs.map((r) => r.mode)),
      billing: uniform(recs.map((r) => r.billing)),
    };
  });
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** A cost cell: subscription (CLI plan) amounts are notional, so they read "≈$0.042 (plan)" (§13.4). */
function costCell(usd: number, digits: number, billing: ComparisonRow["billing"]): string {
  if (billing === "subscription") return `≈$${usd.toFixed(digits)} (plan)`;
  if (billing === "local") return "local";
  return `$${usd.toFixed(digits)}${billing === "mixed" ? " (mixed)" : ""}`;
}

/** Markdown comparison: pass@1 per tier, validity, hidden tests, median cost, p50 latency, turns, mode. */
export function comparisonTable(rows: readonly ComparisonRow[]): string {
  const tiers = TIERS.filter((t) => rows.some((r) => r.by_tier[t]));
  const head = ["Designer model", "Mode", "pass@1", ...tiers.map((t) => `${t} pass@1`), "Validity", "Hidden tests", "Median cost", "Total cost", "p50 latency", "Median turns", "Proposed", "Stops"];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const r of rows) {
    const cells = [
      `\`${r.model}\``,
      r.mode === "none" ? "–" : r.mode,
      `${pct(r.pass_at_1)} (${Math.round(r.pass_at_1 * r.tasks)}/${r.tasks})`,
      ...tiers.map((t) => (r.by_tier[t] ? `${r.by_tier[t]!.passed}/${r.by_tier[t]!.tasks}` : "–")),
      pct(r.validity_rate),
      pct(r.test_pass_rate),
      costCell(r.median_cost_usd, 3, r.billing),
      costCell(r.total_cost_usd, 2, r.billing),
      `${(r.p50_latency_ms / 1000).toFixed(1)} s`,
      String(r.median_turns),
      `${r.proposed}/${r.tasks}`,
      Object.entries(r.stopped)
        .map(([k, v]) => `${k}×${v}`)
        .join(", ") || "–",
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

export async function runBakeOff(options: BakeOffOptions): Promise<{ runs: ModelRun[]; rows: ComparisonRow[]; table: string }> {
  const runs: ModelRun[] = [];
  for (const model of options.models) {
    const gateway = typeof options.gateway === "function" ? options.gateway(model) : options.gateway;
    const solver = new LLMSolver({
      gateway,
      engine: options.engine,
      models: { designer: model },
      budgetUsd: options.budgetUsd ?? 1.5,
      tasks: options.tasks,
      ...(options.agent ? { agent: options.agent } : {}),
    });
    const result = await runSuite(options.tasks, {
      solver,
      engine: options.engine,
      concurrency: options.concurrency ?? 2,
      suite: "makerbench",
      onResult: (r) => options.onResult?.(model, `${r.pass ? "pass" : "FAIL"} ${r.id}${r.category ? ` [${r.category}]` : ""} $${(r.cost_usd ?? 0).toFixed(3)}`),
    });
    const record: ModelRun = { model, result, runs: Object.fromEntries([...solver.runs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) };
    runs.push(record);
    if (options.outDir) {
      const dir = join(options.outDir, model.replace(/[^A-Za-z0-9_.-]/g, "_"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "results.json"), JSON.stringify(result, null, 2) + "\n");
      writeFileSync(join(dir, "report.md"), renderReport(result) + "\n");
      writeFileSync(join(dir, "agent-runs.json"), JSON.stringify(record.runs, null, 2) + "\n");
    }
  }
  const rows = comparisonRows(runs);
  const table = comparisonTable(rows);
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeFileSync(join(options.outDir, "comparison.md"), `# MakerBench designer bake-off\n\n- Engine: ${options.engine.kind}\n- Tasks: ${options.tasks.length}\n- Budget per task: $${(options.budgetUsd ?? 1.5).toFixed(2)}\n\n${table}\n`);
    writeFileSync(join(options.outDir, "comparison.json"), JSON.stringify(rows, null, 2) + "\n");
  }
  return { runs, rows, table };
}
