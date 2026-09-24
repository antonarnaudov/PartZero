/**
 * MakerBench integration: the agent (scripted LLM) as a Solver through the real evals pipeline —
 * compile → engine (oracle fixtures) → hidden tests — on three T1 tasks. Two of the three designers
 * make a classic mistake first (open loop, profile across the revolve axis) and fix it from the
 * playbook hint.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OracleEngine, runSuite, type Engine } from "@aicad/evals";
import { LLMSolver, runBakeOff, ScriptedTransport, scriptedGateway, type Scripts } from "../src/index.js";
import { corpusTasks, fixtureEngine } from "./helpers.js";
import { GASKET_OPEN, GASKET_OUTLINE_FIX, SPACER_CROSS, SPACER_PROFILE_FIX, WASHER_NO_BORE, WASHER_OUTLINE } from "./scenarios.js";
import { apply, GASKET_REQS, GASKET_TESTS, propose, SPACER_REQS, SPACER_TESTS, specTurns, triage, WASHER_REQS, WASHER_TESTS } from "./scripts.js";

const IDS = ["t1-m3-washer", "t1-m5-spacer", "t1-rect-gasket"];

function tasks() {
  return corpusTasks().filter((t) => IDS.includes(t.id));
}

/** Scripts in task-id order (runSuite runs tasks sorted by id; concurrency 1). */
function scripts(hints: string[]): Scripts {
  return {
    triage: [triage("design"), triage("design"), triage("design")],
    spec_writer: [...specTurns(WASHER_TESTS, WASHER_REQS), ...specTurns(SPACER_TESTS, SPACER_REQS), ...specTurns(GASKET_TESTS, GASKET_REQS)],
    designer: [
      // t1-m3-washer: rim first, then the bore.
      apply({ source: WASHER_NO_BORE, expect: [{ feature: "washer", bodies: 1, bbox_size: [7, 7, 1] }] }, "Disc first."),
      apply({ patches: [{ feature: "outline", code: WASHER_OUTLINE }], expect: [{ feature: "outline", holes: 1 }] }, "Add the 3.2 mm bore."),
      propose("M3 washer, 3.2 × 7 × 1 mm.", ["1 mm thickness as requested"]),
      // t1-m5-spacer: profile on the wrong side of the axis, then fixed from the hint.
      apply({ source: SPACER_CROSS }, "Revolve a rectangle."),
      (call) => {
        hints.push(call.toolResults[0]!.content);
        return apply({ patches: [SPACER_PROFILE_FIX] }, "Keep the profile on the u > 0 side.");
      },
      propose("M5 spacer, 10 mm OD, 5.3 mm bore, 15 mm long."),
      // t1-rect-gasket: open loop, then fixed from the hint.
      apply({ source: GASKET_OPEN }, "Whole gasket."),
      (call) => {
        hints.push(call.toolResults[0]!.content);
        return apply({ patches: [GASKET_OUTLINE_FIX] }, "Close the corner.");
      },
      propose("Gasket 90 × 70 × 1.5 mm."),
    ],
  };
}

/** Offline by default; `AICAD_EVALS_REAL_ENGINE=oracle` also runs the scripted agent against the real OCCT oracle. */
const ENGINES: [string, () => Engine][] = [["oracle fixtures", fixtureEngine], ...(process.env["AICAD_EVALS_REAL_ENGINE"] === "oracle" ? [["real OCCT oracle", () => new OracleEngine()] as [string, () => Engine]] : [])];

describe.each(ENGINES)("LLMSolver on MakerBench (scripted LLM, %s)", (_label, makeEngine) => {
  it("passes three T1 tasks through the real pipeline, repairing two mistakes from playbook hints", { timeout: 300_000 }, async () => {
    const hints: string[] = [];
    const transport = new ScriptedTransport(scripts(hints));
    const engine = makeEngine();
    const solver = new LLMSolver({ gateway: scriptedGateway(transport), engine, tasks: corpusTasks(), budgetUsd: 1 });
    expect(solver.name).toBe("agent:claude-opus-5-5");
    const result = await runSuite(tasks(), { solver, engine, concurrency: 1 });

    expect(result.tasks.map((t) => [t.id, t.pass, t.category])).toEqual(IDS.map((id) => [id, true, null]));
    expect(result.summary).toMatchObject({ pass_at_1: 1, validity_rate: 1, tests_passed: result.summary.tests_total });
    expect(hints[0]).toContain("REVOLVE_CROSSES_AXIS");
    expect(hints[0]).toContain("Axis = the line u = 0 in sketch 'profile' coordinates");
    expect(hints[0]).toMatch(/'bottom' \(reaches \(-2.65, 0\), 2.65 mm across\)/);
    expect(hints[1]).toContain("set 'o_top'.start to [45, 35]");
    for (const t of result.tasks) {
      expect(t.cost_usd).toBeGreaterThan(0);
      expect(t.cost_usd).toBeLessThan(1);
    }
    expect(Object.fromEntries([...solver.runs].map(([id, r]) => [id, [r.status, r.turns, r.failedApplies, r.specTests]]))).toEqual({
      "t1-m3-washer": ["proposed", 3, 0, { passed: 5, total: 5 }],
      "t1-m5-spacer": ["proposed", 3, 1, { passed: 5, total: 5 }],
      "t1-rect-gasket": ["proposed", 3, 1, { passed: 5, total: 5 }],
    });
    expect(transport.remaining()).toEqual({ triage: 0, spec_writer: 0, designer: 0 });
  });

});

describe("bake-off", () => {
  it("runs a bake-off per designer model and writes the comparison table", async () => {
    const out = mkdtempSync(join(tmpdir(), "aicad-bench-"));
    const { rows, table } = await runBakeOff({
      tasks: tasks(),
      models: ["claude-opus-5-5", "claude-sonnet-5"],
      engine: fixtureEngine(),
      gateway: () => scriptedGateway(new ScriptedTransport(scripts([]))),
      budgetUsd: 1,
      concurrency: 1,
      outDir: out,
    });
    expect(rows.map((r) => [r.model, r.pass_at_1, r.by_tier["T1"], r.median_turns, r.proposed])).toEqual([
      ["claude-opus-5-5", 1, { passed: 3, tasks: 3 }, 3, 3],
      ["claude-sonnet-5", 1, { passed: 3, tasks: 3 }, 3, 3],
    ]);
    // Sonnet 5 costs half of Opus 5.5 per token on the designer/spec calls.
    expect(rows[1]!.median_cost_usd).toBeLessThan(rows[0]!.median_cost_usd);
    expect(table.split("\n")[0]).toBe(
      "| Designer model | Mode | pass@1 | T1 pass@1 | Validity | Hidden tests | Median cost | Total cost | p50 latency | Median turns | Proposed | Stops |",
    );
    expect(table).toContain("| `claude-opus-5-5` | gateway | 100.0% (3/3) | 3/3 | 100.0% | 100.0% | $");
    expect(rows.map((r) => [r.mode, r.billing])).toEqual([
      ["gateway", "metered"],
      ["gateway", "metered"],
    ]);
    for (const f of ["comparison.md", "comparison.json", "claude-opus-5-5/results.json", "claude-sonnet-5/report.md", "claude-sonnet-5/agent-runs.json"]) {
      expect(existsSync(join(out, f)), f).toBe(true);
    }
    expect(readFileSync(join(out, "comparison.md"), "utf8")).toContain("# MakerBench designer bake-off");
  });
});
