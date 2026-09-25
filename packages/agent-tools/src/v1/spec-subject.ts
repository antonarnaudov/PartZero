/**
 * Spec tests on IR v1 models. The check DSL of `@aicad/evals` measures `aicad.metrics/0` reports
 * and v0 IR; until it measures v1 directly (W11: hole checks from the report's `holes`, `param`
 * checks), an IR v1 model is measured through an adapter that is exact for the checks it allows:
 *
 * - **Model and body checks** read the v1 report: `status`, per-feature `type` and regions, and the
 *   **final** bodies of each part (`parts[].bodies`, SPEC-v1 §6.0.5) — never a feature's own
 *   `bodies`, which in v1 are the bodies it created *or modified* (a join lists its target again).
 * - **IR checks** `feature_names`, `changed_features` and `changed_curves` compare documents
 *   generically and work on v1 IR as they are.
 * - **`curve_count`, `hole_pattern`, `hole_positions`** read v0 sketch circles and planes. On v1
 *   (compound curves, expressions, holes as features, sketches on faces) they would miscount, so
 *   they are **rejected** in v1 spec tests ({@link specTestProblemsV1}) rather than measured wrong.
 */
import type { BodyMetrics, EvalReport, FeatureReport, IrDocument } from "@aicad/ir-types";
import type { v1 as ir, metricsV1 } from "@aicad/ir-types";
import type { HiddenTest, Subject } from "@aicad/evals";
import { runSpecTests, specTestProblems, type CoverageOptions, type SpecTestResult } from "../spec.js";

/** IR checks the v1 adapter cannot measure faithfully yet. */
export const V1_UNSUPPORTED_CHECKS: readonly string[] = ["curve_count", "hole_pattern", "hole_positions"];

/**
 * The "one test per requested feature" gate on CadScript v1 specs: the checks v1 refuses do not
 * count, and `inner_loops` does not see a hole — a v1 hole is a feature, and a blind bore cut from
 * its own circle sketch adds no inner loop to any sketch (the knob's bore).
 */
export const V1_COVERAGE_OPTIONS: Readonly<CoverageOptions> = Object.freeze({ unavailableChecks: V1_UNSUPPORTED_CHECKS, unseenChecks: Object.freeze({ hole: ["inner_loops"] }) });

function v0Body(b: metricsV1.BodyReport): BodyMetrics {
  return {
    volume: b.volume,
    area: b.area,
    centroid: b.centroid,
    bbox_min: b.bbox_min,
    bbox_max: b.bbox_max,
    faces: b.faces,
    edges: b.edges,
    face_types: b.face_types,
    edge_types: b.edge_types,
    valid: b.valid,
  };
}

/** The v0-shaped view of a v1 report and IR that the check DSL measures (see the module doc). */
export function subjectOfV1(report: metricsV1.EvalReport, doc: ir.IrDocument | null): Subject {
  const features: FeatureReport[] = report.features.map((f) => {
    const out: FeatureReport = { part: f.part, feature: f.feature, type: f.type as FeatureReport["type"], status: f.status };
    if (f.error) out.error = { code: f.error.code, message: f.error.message };
    if (f.regions) out.regions = f.regions;
    return out;
  });
  // Final bodies go on the last successful feature of each part: bodiesOf() sums ok features.
  for (const part of report.parts ?? []) {
    const last = [...features].reverse().find((f) => f.part === part.part && f.status === "ok");
    if (last && part.bodies.length > 0) last.bodies = part.bodies.map(v0Body);
  }
  const v0: EvalReport = { schema: "aicad.metrics/0", engine: report.engine, document: report.document, status: report.status, features };
  if (report.error) v0.error = { code: report.error.code, message: report.error.message };
  return { report: v0, ir: doc as unknown as IrDocument | null };
}

/** DSL problems for spec tests on a v1 model: the v0 rules, plus the checks v1 cannot measure yet. */
export function specTestProblemsV1(tests: readonly HiddenTest[], hasContext: boolean): string[] {
  const problems = specTestProblems(tests, hasContext);
  for (const t of tests) {
    if (V1_UNSUPPORTED_CHECKS.includes(t.check)) {
      problems.push(
        `${t.id}: ${t.check} is not available on CadScript v1 models yet (holes are features and sketches use compound curves); check holes with face_count type "cylinder", volume, or bodies_matching instead`,
      );
    }
  }
  return problems;
}

/** Run spec tests on a v1 model (and, for edit tasks, the v1 starting model). */
export function runSpecTestsV1(tests: readonly HiddenTest[], candidate: { report: metricsV1.EvalReport; ir: ir.IrDocument | null }, context?: Subject): SpecTestResult[] {
  const results = runSpecTests(tests, subjectOfV1(candidate.report, candidate.ir), context);
  // A check the adapter cannot measure never passes by accident (tests set before this rule, or hidden tests).
  return results.map((r, i) =>
    V1_UNSUPPORTED_CHECKS.includes(tests[i]!.check)
      ? { id: r.id, description: r.description, check: r.check, pass: false, expected: r.expected, message: `${r.check} is not measurable on CadScript v1 models yet` }
      : r,
  );
}
