import { fileURLToPath } from "node:url";
import { compile } from "@aicad/cadscript";
import type { BodyMetrics, EvalReport, FeatureReport, IrDocument } from "@aicad/ir-types";
import { FixtureEngine } from "../src/engine.js";
import { loadTasks, type LoadedTask } from "../src/task.js";

export const CORPUS_DIR = fileURLToPath(new URL("../../../corpus/makerbench/", import.meta.url));
export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/makerbench/", import.meta.url));

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
