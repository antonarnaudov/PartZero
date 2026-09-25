import { describe, expect, it } from "vitest";
import { irHashV1 } from "../src/engine.js";
import { fixtureDocumentsV1 } from "../src/fixtures.js";
import { runSuite } from "../src/pipeline.js";
import { renderReport } from "../src/report.js";
import { ReferenceSolver } from "../src/solver.js";
import { corpusTasksV1, fixtureEngineV1, withoutTimings } from "./helpers.js";

const tasks = corpusTasksV1();

describe("IR v1 fixtures", () => {
  it("were recorded with a real engine (the OCCT oracle or Forge), not synthesised", () => {
    const engines = fixtureEngineV1().recordedWith;
    expect(engines.length).toBeGreaterThan(0);
    for (const e of engines) expect(e).toMatch(/^(occt|forge) /);
  });

  it("cover every reference, context, mutant and param variant (re-record with `aicad-evals fixtures` after editing a .cad.ts)", async () => {
    const missing: string[] = [];
    for (const t of tasks) {
      for (const { label, doc } of fixtureDocumentsV1(t)) {
        await fixtureEngineV1()
          .evaluateV1(doc)
          .catch(() => missing.push(`${t.id} ${label} (${irHashV1(doc).slice(0, 12)})`));
      }
    }
    expect(missing).toEqual([]);
  });
});

describe("ReferenceSolver on MakerBench v1", () => {
  it("scores 100% on every task (FixtureEngine, IR v1 pipeline)", async () => {
    const result = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: fixtureEngineV1() });
    const failures = result.tasks
      .filter((t) => !t.pass)
      .map((t) => `${t.id} [${t.category}] ${t.error?.message ?? ""} ${t.tests.filter((x) => !x.pass).map((x) => `${x.id}: ${x.message ?? x.expected}`).join("; ")}`);
    expect(failures).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.summary).toMatchObject({ tasks: 41, passed: 41, pass_at_1: 1, validity_rate: 1, test_pass_rate: 1 });
    expect(result.summary.tests_total).toBe(tasks.reduce((n, t) => n + t.hidden_tests.length, 0));
    expect(result.engine.ids.every((id) => /^occt /.test(id))).toBe(true);
  });

  it("is deterministic and task-ordered regardless of concurrency", async () => {
    const a = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: fixtureEngineV1(), concurrency: 1 });
    const b = await runSuite([...tasks].reverse(), { solver: new ReferenceSolver(tasks), engine: fixtureEngineV1(), concurrency: 8 });
    expect(a.tasks.map((t) => t.id)).toEqual(tasks.map((t) => t.id));
    expect(withoutTimings(b)).toEqual(withoutTimings(a));
  });

  it("renders the per-tier table", async () => {
    const md = renderReport(await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: fixtureEngineV1() }));
    expect(md).toMatch(/\| T4 \| 8 \| 8 \| 100\.0%/);
    expect(md).toContain("## Failures\n\nNone.");
  });
});
