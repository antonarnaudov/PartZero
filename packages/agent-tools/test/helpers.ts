import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixtureEngine, type FixtureFile } from "@aicad/evals";

export const FIXTURE_FILE = fileURLToPath(new URL("./fixtures/engine-reports.json", import.meta.url));
const EVALS_FIXTURES = fileURLToPath(new URL("../../evals/fixtures/makerbench/", import.meta.url));

let engine: FixtureEngine | undefined;

/** Offline engine: the scenario reports recorded with the oracle plus the evals MakerBench fixtures. */
export function fixtureEngine(): FixtureEngine {
  if (!engine) {
    const files: FixtureFile[] = [JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as FixtureFile];
    for (const f of readdirSync(EVALS_FIXTURES).filter((x) => x.endsWith(".json")).sort()) {
      files.push(JSON.parse(readFileSync(EVALS_FIXTURES + f, "utf8")) as FixtureFile);
    }
    engine = new FixtureEngine(files);
  }
  return engine;
}
