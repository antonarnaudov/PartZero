/**
 * Record/replay for v1 tool tests: with `AICAD_RECORD_FIXTURES=forge-v1` a test file runs against
 * Forge (`forge/target/debug/aicad`) and writes every report it saw to its fixture file; with
 * `check-forge-v1` it runs against Forge and fails (in `finish()`) where the file no longer matches,
 * writing nothing; otherwise it replays that file offline (`FIXTURE_MISSING` for any document it did
 * not record).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineAvailability } from "@aicad/evals";
import { FixtureCheckEngineV1, FixtureEngineV1, ForgeCliEngineV1, irHashV1, type EngineV1, type EvaluateOptionsV1, type FixtureEntryV1, type IrDocumentV1, type ReportV1 } from "../../src/v1/engine.js";

export const RECORDING = process.env["AICAD_RECORD_FIXTURES"] === "forge-v1";
/** `AICAD_RECORD_FIXTURES=check-forge-v1`: run against Forge and fail on any report the recording no longer matches (writes nothing). */
export const CHECKING = process.env["AICAD_RECORD_FIXTURES"] === "check-forge-v1";

class RecordingEngineV1 implements EngineV1 {
  readonly kind = "forge";
  readonly entries = new Map<string, FixtureEntryV1>();
  readonly #inner = new ForgeCliEngineV1();

  availability(): Promise<EngineAvailability> {
    return this.#inner.availability();
  }

  async evaluate(doc: IrDocumentV1, options?: EvaluateOptionsV1): Promise<ReportV1> {
    const report = await this.#inner.evaluate(doc, options);
    const key = irHashV1(doc);
    if (!this.entries.has(key)) this.entries.set(key, { label: options?.name ?? "doc", ir_sha256: key, report });
    return report;
  }
}

/** The engine a v1 tool test file uses, and `finish()` to call after all its tests (writes in record mode). */
export function v1TestEngine(name: string): { engine: EngineV1; finish(): void } {
  const file = fileURLToPath(new URL(`../fixtures/${name}.json`, import.meta.url));
  if (RECORDING) {
    const rec = new RecordingEngineV1();
    return {
      engine: rec,
      finish: () => writeFileSync(file, JSON.stringify({ schema: "aicad.agent-tools.v1-session/0", entries: [...rec.entries.values()].sort((a, b) => (a.ir_sha256 < b.ir_sha256 ? -1 : 1)) }, null, 1) + "\n"),
    };
  }
  const entries = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { entries: FixtureEntryV1[] }).entries : [];
  if (CHECKING) {
    const check = new FixtureCheckEngineV1(new ForgeCliEngineV1(), entries);
    return {
      engine: check,
      finish: () => {
        const problems = check.problems();
        if (problems.length > 0) throw new Error(`test/fixtures/${name}.json is stale (re-record with AICAD_RECORD_FIXTURES=forge-v1):\n${problems.join("\n")}`);
      },
    };
  }
  return { engine: new FixtureEngineV1(entries), finish: () => undefined };
}
