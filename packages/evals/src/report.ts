/** A readable Markdown report of a {@link SuiteResult}: headline rates, per-tier table, failures. */
import { fmtNum, fmtValue } from "./checks.js";
import { FAILURE_CATEGORIES, type RateSummary, type SuiteResult } from "./pipeline.js";
import { TIERS } from "./task.js";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function usd(x: number): string {
  return `$${x.toFixed(x > 0 && x < 0.01 ? 4 : 2)}`;
}

function row(cells: (string | number)[]): string {
  return `| ${cells.join(" | ")} |`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function rateRow(label: string, r: RateSummary): string {
  return row([
    label,
    r.tasks,
    r.passed,
    pct(r.pass_at_1),
    pct(r.validity_rate),
    `${r.tests_passed}/${r.tests_total} (${pct(r.test_pass_rate)})`,
  ]);
}

export function renderReport(result: SuiteResult): string {
  const s = result.summary;
  const lines: string[] = [];
  lines.push(`# ${result.suite} run: ${result.solver} × ${result.engine.kind}`);
  lines.push("");
  lines.push(`- **Solver:** ${result.solver}`);
  lines.push(`- **Engine:** ${result.engine.kind}${result.engine.ids.length ? ` (${result.engine.ids.join("; ")})` : ""}`);
  lines.push(`- **Tasks:** ${s.tasks}${result.skipped.length ? ` (${result.skipped.length} skipped)` : ""}`);
  lines.push(
    `- **pass@1:** ${pct(s.pass_at_1)} (${s.passed}/${s.tasks}) · **validity:** ${pct(s.validity_rate)} · **hidden tests:** ${pct(s.test_pass_rate)} (${s.tests_passed}/${s.tests_total})`,
  );
  if (s.cost_usd.n > 0) {
    // Subscription (CLI plan) costs are notional: the API list-price equivalent, not money spent (ADR 0014).
    const costed = result.tasks.filter((t) => t.cost_usd !== undefined);
    const plan = costed.length > 0 && costed.every((t) => t.billing === "subscription");
    const label = plan ? "Cost (notional, the solver's CLI plan; not billed per token)" : "Cost";
    lines.push(`- **${label}:** total ${plan ? "≈" : ""}${usd(s.cost_usd.total)}, median ${usd(s.cost_usd.p50)}, p90 ${usd(s.cost_usd.p90)} per task`);
  }
  lines.push(`- **Solver latency:** p50 ${fmtNum(s.latency_ms.p50)} ms, p90 ${fmtNum(s.latency_ms.p90)} ms`);
  lines.push("");
  lines.push("## By tier");
  lines.push("");
  lines.push(row(["Tier", "Tasks", "Passed", "pass@1", "Valid", "Hidden tests"]));
  lines.push(row(["---", "---:", "---:", "---:", "---:", "---:"]));
  for (const tier of TIERS) {
    const r = s.by_tier[tier];
    if (r) lines.push(rateRow(tier, r));
  }
  lines.push(rateRow("**All**", s));
  lines.push("");
  const failedCats = FAILURE_CATEGORIES.filter((c) => s.categories[c] > 0);
  if (failedCats.length > 0) {
    lines.push("## Failure categories");
    lines.push("");
    lines.push(row(["Category", "Tasks"]));
    lines.push(row(["---", "---:"]));
    for (const c of failedCats) lines.push(row([c, s.categories[c]]));
    lines.push("");
  }
  lines.push("## Checks");
  lines.push("");
  lines.push(row(["Check", "Passed", "Rate"]));
  lines.push(row(["---", "---:", "---:"]));
  for (const [name, c] of Object.entries(s.checks)) lines.push(row([`\`${name}\``, `${c.passed}/${c.total}`, pct(c.total ? c.passed / c.total : 0)]));
  lines.push("");
  if (s.scorability) {
    lines.push("## Hidden tests by scorability");
    lines.push("");
    lines.push("`geometry`: measurable on any tool's STEP; `seam`: face/edge counts (seam conventions); `ir`: needs our IR or report.");
    lines.push("");
    lines.push(row(["Scorability", "Passed", "Rate"]));
    lines.push(row(["---", "---:", "---:"]));
    for (const [name, c] of Object.entries(s.scorability)) lines.push(row([name, `${c.passed}/${c.total}`, pct(c.total ? c.passed / c.total : 0)]));
    lines.push("");
  }
  const failures = result.tasks.filter((t) => !t.pass);
  lines.push("## Failures");
  lines.push("");
  if (failures.length === 0) lines.push("None.");
  for (const t of failures) {
    lines.push(`### ${t.id} (${t.tier}): ${t.title}`);
    lines.push("");
    lines.push(`Category: **${t.category}** · score ${pct(t.score)}`);
    lines.push("");
    if (t.error) lines.push(`- Error \`${t.error.code}\`: ${escapeCell(t.error.message)}`);
    for (const d of (t.compile_diagnostics ?? []).slice(0, 5)) {
      lines.push(`- \`${d.code}\` at ${d.line}:${d.col}: ${escapeCell(d.message)}${d.hint ? ` (hint: ${escapeCell(d.hint)})` : ""}`);
    }
    for (const f of t.feature_errors ?? []) lines.push(`- Feature \`${f.feature}\` failed: \`${f.code}\` ${escapeCell(f.message)}`);
    if (t.category === "tests" || t.category === "kernel") {
      for (const test of t.tests.filter((x) => !x.pass)) {
        const got = test.actual !== undefined ? `; got ${fmtValue(test.actual)}` : "";
        const why = test.message ? ` (${escapeCell(test.message)})` : "";
        lines.push(`- FAIL \`${test.id}\`: ${escapeCell(test.description)}. Expected ${escapeCell(test.expected)}${got}${why}`);
      }
    }
    lines.push("");
  }
  if (result.skipped.length > 0) {
    lines.push("## Skipped");
    lines.push("");
    for (const k of result.skipped) lines.push(`- ${k.id}: ${k.reason}`);
    lines.push("");
  }
  if (result.engine_retries && result.engine_retries.length > 0) {
    lines.push("## Engine runs retried");
    lines.push("");
    lines.push("The OS killed these `aicad` runs (SIGKILL, usually memory pressure) and they were run again; the scores above use the second run.");
    lines.push("");
    for (const r of result.engine_retries) lines.push(`- ${escapeCell(r)}`);
    lines.push("");
  }
  return lines.join("\n");
}
