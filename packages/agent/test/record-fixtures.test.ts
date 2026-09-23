/**
 * Re-record the engine reports the offline tests replay:
 *
 *   pnpm --filter @aicad/agent fixtures     (AICAD_RECORD_FIXTURES=oracle; needs uv + oracle/)
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile } from "@aicad/cadscript";
import { FIXTURE_SCHEMA, irHash, OracleEngine, type FixtureEntry } from "@aicad/evals";
import { FIXTURE_FILE } from "./helpers.js";
import { AGENT_SCENARIOS } from "./scenarios.js";

describe.skipIf(process.env["AICAD_RECORD_FIXTURES"] !== "oracle")("record engine fixtures (oracle)", () => {
  it("records every scenario", { timeout: 600_000 }, async () => {
    const engine = new OracleEngine();
    expect((await engine.availability()).available).toBe(true);
    const entries: FixtureEntry[] = [];
    const engines = new Set<string>();
    for (const [label, source] of Object.entries(AGENT_SCENARIOS)) {
      const r = compile(source);
      if (!r.ok || !r.ir) throw new Error(`${label} does not compile: ${r.diagnostics.map((d) => d.message).join("; ")}`);
      const report = await engine.evaluate(r.ir, { name: label });
      engines.add(report.engine);
      entries.push({ label, ir_sha256: irHash(r.ir), report });
    }
    writeFileSync(FIXTURE_FILE, JSON.stringify({ schema: FIXTURE_SCHEMA, task: "agent-scenarios", engine: [...engines].sort().join("; "), entries }, null, 1) + "\n");
  });
});
