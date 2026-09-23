/**
 * Recording engine fixtures: every task's reference, T4 context and applicable mutants are
 * compiled and evaluated with a real engine, and the reports are stored by IR content hash so
 * {@link FixtureEngine} can replay them offline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, print } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import { FIXTURE_SCHEMA, irHash, type Engine, type FixtureEntry, type FixtureFile } from "./engine.js";
import { mutateIr, MUTATIONS } from "./mutate.js";
import type { LoadedTask } from "./task.js";

function compileOrThrow(source: string, what: string): IrDocument {
  const r = compile(source, { fileName: what });
  if (!r.ok || !r.ir) throw new Error(`${what} does not compile: ${r.diagnostics.map((d) => d.message).join("; ")}`);
  return r.ir;
}

/** The documents a task's fixtures cover, labelled. */
export function fixtureDocuments(task: LoadedTask): { label: string; ir: IrDocument }[] {
  const ref = compileOrThrow(task.referenceSource, task.reference);
  const docs = [{ label: "reference", ir: ref }];
  if (task.contextSource !== undefined) docs.push({ label: "context", ir: compileOrThrow(task.contextSource, task.context!) });
  for (const kind of MUTATIONS) {
    const m = mutateIr(ref, kind);
    // Exactly what the pipeline evaluates for MutantSolver: the mutant printed and recompiled.
    if (m) docs.push({ label: `mutant:${kind}`, ir: compileOrThrow(print(m), `${task.id} mutant:${kind}`) });
  }
  return docs;
}

export async function recordFixtures(task: LoadedTask, engine: Engine): Promise<FixtureFile> {
  const entries: FixtureEntry[] = [];
  const engines = new Set<string>();
  for (const { label, ir } of fixtureDocuments(task)) {
    const report = await engine.evaluate(ir, { name: label === "reference" ? task.id : `${task.id}.${label.replace(":", "_")}` });
    engines.add(report.engine);
    entries.push({ label, ir_sha256: irHash(ir), report });
  }
  return { schema: FIXTURE_SCHEMA, task: task.id, engine: [...engines].sort().join("; "), entries };
}

export function writeFixture(dir: string, fixture: FixtureFile): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fixture.task}.json`);
  writeFileSync(path, JSON.stringify(fixture, null, 1) + "\n");
  return path;
}
