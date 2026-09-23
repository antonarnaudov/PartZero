import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FixtureEngine, loadTasks, type FixtureFile, type LoadedTask } from "@aicad/evals";
import { CORPUS_DIR } from "./scenarios.js";

export const FIXTURE_FILE = fileURLToPath(new URL("./fixtures/engine-reports.json", import.meta.url));
const EVALS_FIXTURES = fileURLToPath(new URL("../../evals/fixtures/makerbench/", import.meta.url));

let engine: FixtureEngine | undefined;

/** Offline engine: oracle reports recorded for the agent scenarios plus the evals MakerBench fixtures. */
export function fixtureEngine(): FixtureEngine {
  if (!engine) {
    const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as FixtureFile;
    const files = [read(FIXTURE_FILE)];
    for (const f of readdirSync(EVALS_FIXTURES).filter((x) => x.endsWith(".json")).sort()) files.push(read(EVALS_FIXTURES + f));
    engine = new FixtureEngine(files);
  }
  return engine;
}

let tasks: LoadedTask[] | undefined;
export function corpusTasks(): LoadedTask[] {
  tasks ??= loadTasks(CORPUS_DIR);
  return tasks;
}

/** A deterministic clock: every reading advances 10 ms. */
export function fakeClock(): () => number {
  let t = 0;
  return () => (t += 10);
}
