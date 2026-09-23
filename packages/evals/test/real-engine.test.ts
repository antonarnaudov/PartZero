/**
 * Opt-in: evaluate every reference (and every mutant) with a REAL engine instead of fixtures.
 *
 *   AICAD_EVALS_REAL_ENGINE=oracle pnpm --filter @aicad/evals test real-engine
 *   AICAD_EVALS_REAL_ENGINE=forge  pnpm --filter @aicad/evals test real-engine   (needs forge/target/debug/aicad)
 *
 * Skipped by default so `pnpm test` stays hermetic and fast.
 */
import { describe, expect, it } from "vitest";
import { ForgeCliEngine, OracleEngine, type Engine } from "../src/engine.js";
import { runSuite } from "../src/pipeline.js";
import { MutantSolver, ReferenceSolver } from "../src/solver.js";
import { corpusTasks } from "./helpers.js";

const which = process.env.AICAD_EVALS_REAL_ENGINE;
const engine: Engine | undefined = which === "oracle" ? new OracleEngine() : which === "forge" ? new ForgeCliEngine() : undefined;

describe.skipIf(!engine)(`real engine (${which ?? "set AICAD_EVALS_REAL_ENGINE"})`, () => {
  const tasks = corpusTasks();

  it("is available", async () => {
    expect(await engine!.availability()).toMatchObject({ available: true });
  });

  it("scores every reference 100%", { timeout: 900_000 }, async () => {
    const result = await runSuite(tasks, { solver: new ReferenceSolver(tasks), engine: engine!, concurrency: 8 });
    const failures = result.tasks
      .filter((t) => !t.pass)
      .map((t) => `${t.id} [${t.category}] ${t.error?.message ?? ""} ${t.tests.filter((x) => !x.pass).map((x) => `${x.id}: ${x.message ?? x.expected}`).join("; ")}`);
    expect(failures).toEqual([]);
  });

  it("fails every applicable non-T5 mutant", { timeout: 900_000 }, async () => {
    for (const kind of ["scale", "drop_hole", "hole_size"] as const) {
      const result = await runSuite(tasks, { solver: new MutantSolver(tasks, kind), engine: engine!, concurrency: 8 });
      const escaped = result.tasks.filter((t) => t.tier !== "T5" && t.pass).map((t) => `${kind}: ${t.id}`);
      expect(escaped).toEqual([]);
    }
  });
});
