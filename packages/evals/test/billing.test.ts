/**
 * Solver billing (ADR 0014): a solver on a CLI plan reports `billing: "subscription"`; the pipeline keeps
 * it per task and the report labels the costs as notional rather than money spent.
 */
import { describe, expect, it } from "vitest";
import { runSuite } from "../src/pipeline.js";
import { renderReport } from "../src/report.js";
import { ReferenceSolver, solverFromFunction } from "../src/solver.js";
import { corpusTasks, fixtureEngine } from "./helpers.js";

describe("solver billing", () => {
  const tasks = () => corpusTasks().filter((t) => t.id === "t1-m3-washer");

  it("subscription costs are kept per task and reported as notional plan usage", async () => {
    const reference = new ReferenceSolver(tasks());
    const solver = solverFromFunction("agent:claude-cli:opus", async (t) => ({ ...(await reference.solve(t)), costUsd: 0.042, billing: "subscription" }));
    const result = await runSuite(tasks(), { solver, engine: fixtureEngine() });
    expect(result.tasks[0]).toMatchObject({ pass: true, cost_usd: 0.042, billing: "subscription" });
    expect(renderReport(result)).toContain("- **Cost (notional, the solver's CLI plan; not billed per token):** total ≈$0.04, median $0.04");
  });

  it("metered costs (the default) keep the plain label and no billing field", async () => {
    const reference = new ReferenceSolver(tasks());
    const solver = solverFromFunction("agent:claude-opus-5-5", async (t) => ({ ...(await reference.solve(t)), costUsd: 0.042, billing: "metered" }));
    const result = await runSuite(tasks(), { solver, engine: fixtureEngine() });
    expect(result.tasks[0]!.billing).toBeUndefined();
    expect(renderReport(result)).toContain("- **Cost:** total $0.04, median $0.04");
  });
});
