import { describe, expect, it } from "vitest";
import { compile } from "@aicad/cadscript";
import { irHash } from "../src/engine.js";
import { runSuite } from "../src/pipeline.js";
import { renderReport } from "../src/report.js";
import { ReferenceSolver } from "../src/solver.js";
import { corpusTasks, fixtureEngine, withoutTimings } from "./helpers.js";

const tasks = corpusTasks();

describe("fixtures", () => {
  it("were recorded with a real engine (the OCCT oracle or Forge), not synthesised", () => {
    const engines = fixtureEngine().recordedWith;
    expect(engines.length).toBeGreaterThan(0);
    for (const e of engines) expect(e).toMatch(/^(occt|forge) /);
  });

  it("cover every reference and T4 context (re-record with `aicad-evals fixtures` after editing a .cad.ts)", async () => {
    const missing: string[] = [];
    for (const t of tasks) {
      for (const [label, src] of [["reference", t.referenceSource], ["context", t.contextSource]] as const) {
        if (src === undefined) continue;
        const ir = compile(src).ir!;
        await fixtureEngine()
          .evaluate(ir)
          .catch(() => missing.push(`${t.id} ${label} (${irHash(ir).slice(0, 12)})`));
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("ReferenceSolver", () => {
  it("scores 100% on every task (FixtureEngine)", async () => {
    const result = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: fixtureEngine() });
    const failures = result.tasks
      .filter((t) => !t.pass)
      .map((t) => `${t.id} [${t.category}] ${t.tests.filter((x) => !x.pass).map((x) => `${x.id}: ${x.message ?? x.expected}`).join("; ")}`);
    expect(failures).toEqual([]);
    expect(result.summary.pass_at_1).toBe(1);
    expect(result.summary.validity_rate).toBe(1);
    expect(result.summary.test_pass_rate).toBe(1);
    expect(result.summary.tests_total).toBe(tasks.reduce((n, t) => n + t.hidden_tests.length, 0));
    for (const tier of ["T1", "T2", "T4", "T5"] as const) expect(result.summary.by_tier[tier]?.pass_at_1).toBe(1);
    expect(Object.values(result.summary.categories).every((n) => n === 0)).toBe(true);
    expect(result.summary.cost_usd).toMatchObject({ n: 61, total: 0 });
  });

  it("produces deterministic, task-ordered results regardless of concurrency", async () => {
    const a = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: fixtureEngine(), concurrency: 1 });
    const b = await runSuite([...tasks].reverse(), { solver: new ReferenceSolver(tasks), engine: fixtureEngine(), concurrency: 8 });
    expect(a.tasks.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
    expect(withoutTimings(b)).toEqual(withoutTimings(a));
  });

  it("renders a report with the per-tier table and no failures", async () => {
    const result = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: fixtureEngine() });
    const md = renderReport(result);
    expect(md).toContain("# makerbench run: reference × fixture");
    expect(md).toMatch(/\| T1 \| 34 \| 34 \| 100\.0% \| 100\.0% \|/);
    expect(md).toMatch(/\| T4 \| 8 \| 8 \| 100\.0%/);
    expect(md).toContain("## Failures\n\nNone.");
  });
});
