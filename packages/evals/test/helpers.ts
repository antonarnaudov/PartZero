import { fileURLToPath } from "node:url";
import { compile, v1 as cs } from "@aicad/cadscript";
import type { BodyMetrics, EvalReport, FeatureReport, IrDocument, metricsV1, v1 as irv1 } from "@aicad/ir-types";
import { FixtureEngine } from "../src/engine.js";
import { loadTasks, type LoadedTask } from "../src/task.js";

export const CORPUS_DIR = fileURLToPath(new URL("../../../corpus/makerbench/", import.meta.url));
export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/makerbench/", import.meta.url));
/** MakerBench v1: tasks that require `ir/1` (CadScript v1 references). */
export const CORPUS_V1_DIR = fileURLToPath(new URL("../../../corpus/makerbench/v1/", import.meta.url));
export const FIXTURES_V1_DIR = fileURLToPath(new URL("../fixtures/makerbench-v1/", import.meta.url));

let cached: LoadedTask[] | undefined;
/** The MakerBench corpus, loaded and validated once per test file. */
export function corpusTasks(): LoadedTask[] {
  cached ??= loadTasks(CORPUS_DIR);
  return cached;
}

let fixtures: FixtureEngine | undefined;
export function fixtureEngine(): FixtureEngine {
  fixtures ??= new FixtureEngine(FIXTURES_DIR);
  return fixtures;
}

let cachedV1: LoadedTask[] | undefined;
/** The MakerBench v1 corpus, loaded and validated once per test file. */
export function corpusTasksV1(): LoadedTask[] {
  cachedV1 ??= loadTasks(CORPUS_V1_DIR);
  return cachedV1;
}

let fixturesV1: FixtureEngine | undefined;
/** Recorded `aicad.metrics/1` reports of the v1 corpus (references, contexts, mutants, param variants). */
export function fixtureEngineV1(): FixtureEngine {
  fixturesV1 ??= new FixtureEngine(FIXTURES_V1_DIR);
  return fixturesV1;
}

export function compileV1Ok(source: string): irv1.IrDocument {
  const r = cs.compile(source);
  if (!r.ok || !r.ir) throw new Error(`does not compile: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return r.ir;
}

/** A synthetic v1 body: an axis-aligned box by default. */
export function bodyV1(p: Partial<metricsV1.BodyReport> & { min?: [number, number, number]; max?: [number, number, number] } = {}): metricsV1.BodyReport {
  const b = body({ ...(p.min ? { min: p.min } : {}), ...(p.max ? { max: p.max } : {}) });
  return { origin: { feature: "f1", member: "outline.bottom" }, shells: 1, ...b, ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== "min" && k !== "max")) } as metricsV1.BodyReport;
}

export function featureV1(p: Partial<metricsV1.FeatureReport> & { type: string }): metricsV1.FeatureReport {
  const id = p.feature_id ?? `f_${p.feature ?? p.type}`;
  return { part: "part", feature: p.feature ?? p.type, feature_id: id, status: "ok", warnings: [], ...p };
}

export function reportV1(
  features: metricsV1.FeatureReport[],
  opts: { bodies?: metricsV1.BodyReport[]; params?: metricsV1.ParamReport[]; status?: "ok" | "error" } = {},
): metricsV1.EvalReport {
  const r: metricsV1.EvalReport = {
    schema: "aicad.metrics/1",
    engine: "test",
    document: "doc",
    status: opts.status ?? (features.every((f) => f.status === "ok") ? "ok" : "error"),
    features,
    params: opts.params ?? [],
    parts: [{ part: "part", part_id: "p1", bodies: opts.bodies ?? [] }],
  };
  return r;
}

/** A synthetic body: an axis-aligned box by default. */
export function body(p: Partial<BodyMetrics> & { min?: [number, number, number]; max?: [number, number, number] } = {}): BodyMetrics {
  const min = p.min ?? p.bbox_min ?? [0, 0, 0];
  const max = p.max ?? p.bbox_max ?? [10, 10, 10];
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    volume: p.volume ?? size[0]! * size[1]! * size[2]!,
    area: p.area ?? 2 * (size[0]! * size[1]! + size[1]! * size[2]! + size[0]! * size[2]!),
    centroid: p.centroid ?? [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    bbox_min: min,
    bbox_max: max,
    faces: p.faces ?? 6,
    edges: p.edges ?? 12,
    face_types: p.face_types ?? { plane: 6 },
    edge_types: p.edge_types ?? { line: 12 },
    valid: p.valid ?? true,
  };
}

export function feature(p: Partial<FeatureReport> & { type: string }): FeatureReport {
  return { part: "part", feature: p.feature ?? `f_${p.type}`, status: "ok", ...p };
}

export function report(features: FeatureReport[], status: "ok" | "error" = "ok"): EvalReport {
  return { schema: "aicad.metrics/0", engine: "test", document: "doc", status, features };
}

/** A report with one sketch (given regions) and one extrude creating `bodies`. */
export function simpleReport(bodies: BodyMetrics[], regions: { area: number; loops: number }[] = [{ area: 1, loops: 1 }]): EvalReport {
  return report([
    feature({ type: "sketch", feature: "base", regions: regions.map((r) => ({ ...r, outer_curves: ["a"] })) }),
    feature({ type: "extrude", feature: "solid", bodies }),
  ]);
}

export function compileOk(source: string): IrDocument {
  const r = compile(source);
  if (!r.ok || !r.ir) throw new Error(`does not compile: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return r.ir;
}

/** Strip wall-clock fields so two runs can be compared. */
export function withoutTimings<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (k, v: unknown) => (k.endsWith("_ms") || k === "latency_ms" ? undefined : v))) as T;
}
