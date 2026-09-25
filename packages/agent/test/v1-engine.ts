/**
 * Record/replay of Forge's `aicad.metrics/1` reports for the v1 agent tests: with
 * `AICAD_RECORD_FIXTURES=forge-v1` the tests run against Forge (`forge/target/debug/aicad`) and
 * write every report they saw to `fixtures/v1-agent.json`; with `check-forge-v1` they run against
 * Forge and fail (in `finish()`) where that file no longer matches, writing nothing; otherwise they
 * replay it offline.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { v1 as tv1 } from "@aicad/agent-tools";
import type { EngineAvailability } from "@aicad/evals";

const FILE = fileURLToPath(new URL("./fixtures/v1-agent.json", import.meta.url));
export const RECORDING_V1 = process.env["AICAD_RECORD_FIXTURES"] === "forge-v1";
/** `AICAD_RECORD_FIXTURES=check-forge-v1`: run against Forge and fail where the recording no longer matches (writes nothing). */
const CHECKING_V1 = process.env["AICAD_RECORD_FIXTURES"] === "check-forge-v1";

class Recording implements tv1.EngineV1 {
  readonly kind = "forge";
  readonly entries = new Map<string, tv1.FixtureEntryV1>();
  readonly #inner = new tv1.ForgeCliEngineV1();
  availability(): Promise<EngineAvailability> {
    return this.#inner.availability();
  }
  async evaluate(doc: tv1.IrDocumentV1, options?: tv1.EvaluateOptionsV1): Promise<tv1.ReportV1> {
    const report = await this.#inner.evaluate(doc, options);
    const key = tv1.irHashV1(doc);
    if (!this.entries.has(key)) this.entries.set(key, { label: options?.name ?? "doc", ir_sha256: key, report });
    return report;
  }
}

let shared: { engine: tv1.EngineV1; finish(): void } | undefined;

/** The v1 engine of the agent tests (one per test process) and `finish()` for afterAll. */
export function v1AgentEngine(): { engine: tv1.EngineV1; finish(): void } {
  if (shared) return shared;
  if (RECORDING_V1) {
    const rec = new Recording();
    shared = {
      engine: rec,
      finish: () => writeFileSync(FILE, JSON.stringify({ schema: "aicad.agent.v1-fixtures/0", entries: [...rec.entries.values()].sort((a, b) => (a.ir_sha256 < b.ir_sha256 ? -1 : 1)) }, null, 1) + "\n"),
    };
  } else if (CHECKING_V1) {
    const entries = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as { entries: tv1.FixtureEntryV1[] }).entries : [];
    const check = new tv1.FixtureCheckEngineV1(new tv1.ForgeCliEngineV1(), entries);
    shared = {
      engine: check,
      finish: () => {
        const problems = check.problems();
        if (problems.length > 0) throw new Error(`test/fixtures/v1-agent.json is stale (re-record with AICAD_RECORD_FIXTURES=forge-v1):\n${problems.join("\n")}`);
      },
    };
  } else {
    const entries = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as { entries: tv1.FixtureEntryV1[] }).entries : [];
    shared = { engine: new tv1.FixtureEngineV1(entries), finish: () => undefined };
  }
  return shared;
}
