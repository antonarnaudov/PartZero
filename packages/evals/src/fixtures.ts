/**
 * Recording engine fixtures: every task's reference, T4 context and applicable mutants are
 * compiled and evaluated with a real engine, and the reports are stored by IR content hash so
 * {@link FixtureEngine} can replay them offline. IR v1 tasks also record their hand-written
 * candidates (`candidates.ts`) and the `param` variants of each of those documents (the
 * candidate re-evaluated with a test's parameters set).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, print, v1 as cs } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import {
  EngineError,
  FIXTURE_SCHEMA,
  FIXTURE_SCHEMA_V1,
  irHash,
  irHashV1,
  type Engine,
  type FixtureEntry,
  type FixtureEntryV1,
  type FixtureFile,
  type FixtureFileV1,
  type IrDocumentV1,
} from "./engine.js";
import { candidatesOf } from "./candidates.js";
import { mutateIr, MUTATIONS } from "./mutate.js";
import { paramSets, variantLabel } from "./pipeline.js";
import { isV1Task, type LoadedTask } from "./task.js";
import { mutateIrV1, MUTATIONS_V1 } from "./v1/mutate.js";
import { withParams } from "./v1/subject.js";

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

function compileV1OrThrow(source: string, what: string): IrDocumentV1 {
  const r = cs.compile(source, { fileName: what });
  if (!r.ok || !r.ir) throw new Error(`${what} does not compile: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.message).join("; ")}`);
  return r.ir;
}

/**
 * The documents an IR v1 task's fixtures cover, labelled: the reference, the T4 context, every
 * applicable v1 mutant (printed and recompiled, exactly as the pipeline sees it), every
 * hand-written candidate (`candidate:<label>`), and for each of these the `param` variants of the
 * task's tests (parameters that exist in the document).
 */
export function fixtureDocumentsV1(task: LoadedTask): { label: string; doc: IrDocumentV1 }[] {
  const ref = compileV1OrThrow(task.referenceSource, task.reference);
  const base = [{ label: "reference", doc: ref }];
  if (task.contextSource !== undefined) base.push({ label: "context", doc: compileV1OrThrow(task.contextSource, task.context!) });
  for (const kind of MUTATIONS_V1) {
    const m = mutateIrV1(ref, kind);
    if (m) base.push({ label: `mutant:${kind}`, doc: compileV1OrThrow(cs.print(m), `${task.id} mutant:${kind}`) });
  }
  for (const c of candidatesOf(task)) base.push({ label: `candidate:${c.label}`, doc: compileV1OrThrow(c.source, `${task.id} candidate:${c.label}`) });
  const out = [...base];
  const sets = paramSets(task.hidden_tests);
  for (const b of base) {
    if (b.label === "context") continue;
    for (const set of sets) {
      const { doc, missing } = withParams(b.doc, set);
      if (missing.length === 0) out.push({ label: `${b.label}/${variantLabel(set)}`, doc });
    }
  }
  return out;
}

/** Record an IR v1 task's fixtures (the engine must evaluate IR v1). */
export async function recordFixturesV1(task: LoadedTask, engine: Engine): Promise<FixtureFileV1> {
  if (!engine.evaluateV1) throw new EngineError("ENGINE_UNAVAILABLE", `engine ${engine.kind} does not evaluate IR v1`);
  const entries: FixtureEntryV1[] = [];
  const engines = new Set<string>();
  for (const { label, doc } of fixtureDocumentsV1(task)) {
    const name = label === "reference" ? task.id : `${task.id}.${label.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
    const report = await engine.evaluateV1(doc, { name });
    engines.add(report.engine);
    entries.push({ label, ir_sha256: irHashV1(doc), report });
  }
  return { schema: FIXTURE_SCHEMA_V1, task: task.id, engine: [...engines].sort().join("; "), entries };
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

/**
 * Write a fixture file. v0 fixtures are indented; v1 reports are larger (references, probes,
 * keys), so a v1 file has one compact line per entry.
 */
export function writeFixture(dir: string, fixture: FixtureFile | FixtureFileV1): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fixture.task}.json`);
  if (fixture.schema === FIXTURE_SCHEMA_V1) {
    const head = JSON.stringify({ schema: fixture.schema, task: fixture.task, engine: fixture.engine });
    const entries = fixture.entries.map((e) => JSON.stringify(e)).join(",\n");
    writeFileSync(path, `${head.slice(0, -1)},"entries":[\n${entries}\n]}\n`);
  } else {
    writeFileSync(path, JSON.stringify(fixture, null, 1) + "\n");
  }
  return path;
}

/** Record a task's fixtures with the version its `requires` asks for. */
export function recordTaskFixtures(task: LoadedTask, engine: Engine): Promise<FixtureFile | FixtureFileV1> {
  return isV1Task(task) ? recordFixturesV1(task, engine) : recordFixtures(task, engine);
}
