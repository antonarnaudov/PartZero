/**
 * Opt-in live runs: one real T1 MakerBench task end to end per provider whose key is set
 * (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY), evaluated with the real OCCT oracle,
 * inside a $1 task budget. Skipped without keys (and without a working `uv run oracle`).
 *
 *   ANTHROPIC_API_KEY=… pnpm --filter @aicad/agent test:live
 *   LIVE_TASK=t1-m5-spacer LIVE_ANTHROPIC_DESIGNER=claude-sonnet-5 … (overrides)
 *
 * Results (with full conversations) are written to artifacts/live/<model>/<task>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OracleEngine, runSuite } from "@aicad/evals";
import { LLMGateway } from "@aicad/llm-gateway";
import { LLMSolver } from "../../src/index.js";
import { corpusTasks } from "../helpers.js";

const env = process.env;
const TASK = env["LIVE_TASK"] ?? "t1-m3-washer";
const OUT = fileURLToPath(new URL("../../../../artifacts/live/", import.meta.url));
const PROVIDERS = [
  { key: "ANTHROPIC_API_KEY", model: env["LIVE_ANTHROPIC_DESIGNER"] ?? "claude-opus-5-5" },
  { key: "OPENAI_API_KEY", model: env["LIVE_OPENAI_DESIGNER"] ?? "gpt-6-astra" },
  { key: "GEMINI_API_KEY", model: env["LIVE_GOOGLE_DESIGNER"] ?? "gemini-3.1-pro-preview" },
];

const oracle = new OracleEngine();

for (const p of PROVIDERS) {
  describe.skipIf(!env[p.key])(`live: ${p.model} designer`, () => {
    it(`solves ${TASK} end to end within a $1 budget`, { timeout: 900_000 }, async (ctx) => {
      const a = await oracle.availability();
      if (!a.available) ctx.skip(`oracle unavailable: ${a.detail}`);
      const all = corpusTasks();
      const tasks = all.filter((t) => t.id === TASK);
      expect(tasks).toHaveLength(1);
      const solver = new LLMSolver({ gateway: new LLMGateway(), engine: oracle, models: { designer: p.model }, budgetUsd: 1, tasks: all, keepConversations: true });
      const result = await runSuite(tasks, { solver, engine: oracle, concurrency: 1 });
      const t = result.tasks[0]!;
      const run = solver.runs.get(TASK);
      const dir = join(OUT, p.model);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${TASK}.json`), JSON.stringify({ result, run }, null, 2) + "\n");
      console.log(`[live ${p.model}] ${TASK}: ${t.pass ? "PASS" : `FAIL (${t.category})`} tests ${t.tests.filter((x) => x.pass).length}/${t.tests.length}, $${(t.cost_usd ?? 0).toFixed(4)}, ${t.latency_ms} ms, ${run?.turns} turns, ${run?.status}/${run?.stopReason}`);
      expect(t.category).not.toBe("solver");
      expect(run?.status).not.toBe("failed");
      // The cap is enforced on projected cost before each call; one call may overshoot its projection slightly.
      expect(t.cost_usd ?? 0).toBeLessThanOrEqual(1.25);
    });
  });
}
