/**
 * Reports for the catalogue codes **no engine raises** in the recorded fixtures, built from the
 * SPEC-v1 detail shapes (§5.7, §6.0.3, §6.6–§6.8, §7.5), each for a stated reason:
 * - FILLET_FAILED, CHAMFER_FAILED, SHELL_FAILED, INVALID_RESULT: construction failures with no
 *   reliable trigger in either engine (a trigger would be an engine bug, fixed when found);
 * - BOOLEAN_NON_MANIFOLD: both engines report an edge-only contact as BOOLEAN_NO_INTERSECTION;
 * - REF_NEIGHBORHOOD_CHANGED: needs a capture whose neighbourhood shrank (a merge), which neither
 *   engine's programs produce;
 * - MEASURE_NOT_REFERENCE, MEASURE_UNIT_MISMATCH, MEASURE_FORWARD: measured parameters arrive with
 *   IR v1.1 (codes.rs marks them `v1.1`);
 * - NON_FINITE: JSON has no non-finite number, so no conformance document can carry one.
 * The sketch outcomes (SKETCH_LOOP_FLIPPED, SKETCH_SOLVE_FAILED, SKETCH_DEGENERATE_LOOP) come from
 * Forge now (`scenarios.ts`). Every other code comes from a report Forge or the OCCT oracle
 * produced (`fixtures.ts`). Each case pairs a real compiled IR with a report that passes the
 * `aicad.metrics/1` schema; the playbook test drops a case as soon as an engine raises its code.
 */
import { v1 as cs } from "@aicad/cadscript";
import { v1 as irTypes, type metricsV1 } from "@aicad/ir-types";
import type { Occurrence } from "./fixtures.js";

const IMPORT = 'import { part, sketch, line, extrude, XY, Z, rect, C, tag, fillet, chamfer, shell } from "@aicad/std";\n';
const BOX = 'part("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 20, h: 20 }) });\nconst e = extrude(s, { distance: 5 });\n';

const BOX_BODY: metricsV1.BodyReport = {
  origin: { feature: "f_e", member: "o.bottom" },
  volume: 2000,
  area: 1200,
  centroid: [0, 0, 2.5],
  bbox_min: [-10, -10, 0],
  bbox_max: [10, 10, 5],
  faces: 6,
  edges: 12,
  shells: 1,
  face_types: { plane: 6 },
  edge_types: { line: 12 },
  valid: true,
};

const EDGE_TR = { key: "f_e/edge:{f_e/side:o.right|f_e/side:o.top}", name: "e/edge:{e/side:o.right|e/side:o.top}" };
const EDGE_BL = { key: "f_e/edge:{f_e/side:o.bottom|f_e/side:o.left}", name: "e/edge:{e/side:o.bottom|e/side:o.left}" };

interface SpecCase {
  code: string;
  /** CadScript body after the import. */
  source: string;
  /** The feature the code is raised on; omitted for rejections and parameters. */
  feature?: string;
  kind: "error" | "warning" | "info" | "rejection";
  details: Record<string, unknown>;
  message: string;
  /** Extra fields on the feature entry (refs, …). */
  entry?: Partial<metricsV1.FeatureReport>;
}

const CASES: SpecCase[] = [
  // Blends and shell (§6.6–§6.8): the oracle raises the *_TOO_LARGE / *_UNSUPPORTED codes
  // (`oracle-programs.ts`); a construction failure has no reliable trigger in either engine.
  { code: "FILLET_FAILED", source: `${BOX}const corners = fillet(e.sides().edges().parallel(Z), { r: 1 });\n`, feature: "corners", kind: "error", details: { edges: [EDGE_TR], reason: "corner patch did not close" }, message: "fillet failed" },
  { code: "CHAMFER_FAILED", source: `${BOX}const bevel = chamfer(e.cap("end").edges(), { d: 1 });\n`, feature: "bevel", kind: "error", details: { edges: [EDGE_BL], reason: "bevel faces do not meet" }, message: "chamfer failed" },
  { code: "SHELL_FAILED", source: `${BOX}const hollow = shell(e, { open: e.cap("end"), thickness: 1 });\n`, feature: "hollow", kind: "error", details: { reason: "offset surface self-intersects" }, message: "shell failed" },
  // Booleans (§6.0.3): both engines report an edge-only contact of two bodies as BOOLEAN_NO_INTERSECTION (min_distance 0).
  { code: "BOOLEAN_NON_MANIFOLD", source: `${BOX}const s2 = sketch(XY, { o: rect({ center: [20, 20], w: 20, h: 20 }) });\nconst j = extrude(s2, { distance: 5, op: "join", targets: e });\n`, feature: "j", kind: "error", details: { probe: { kind: "edge", point: [10, 10, 2.5] } }, message: "non-manifold result" },
  // References (§5.7): needs a capture whose neighbourhood shrank (a merge); neither engine's fixtures have one.
  { code: "REF_NEIGHBORHOOD_CHANGED", source: `${BOX}const t = tag(e.side("o.left"));\n`, feature: "t", kind: "warning", details: { field: "/target", key: "f_e/side:o.left", was: 2, now: 1 }, message: "neighbourhood changed" },
  { code: "INVALID_RESULT", source: BOX, feature: "e", kind: "error", details: { issues: ["shell 0 is not closed (2 free edges)"] }, message: "invalid body" },
  // Rejections no conformance document raises through either engine.
  { code: "MEASURE_NOT_REFERENCE", source: BOX, kind: "rejection", details: { name: "gap", sketch: "f_s", constraint: "w" }, message: "measure of a driving dimension" },
  { code: "MEASURE_UNIT_MISMATCH", source: BOX, kind: "rejection", details: { name: "gap", sketch: "f_s", constraint: "a1" }, message: "measure unit mismatch" },
  { code: "MEASURE_FORWARD", source: BOX, kind: "rejection", details: { name: "gap", sketch: "f_s", constraint: "w" }, message: "measure used before its sketch" },
  { code: "NON_FINITE", source: BOX, kind: "rejection", details: { field: "/parts/0/features/1/distance" }, message: "not finite" },
];

function compileCase(c: SpecCase): irTypes.IrDocument {
  const r = cs.compile(IMPORT + c.source);
  if (!r.ok || !r.ir) throw new Error(`spec case ${c.code} does not compile: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return r.ir;
}

function buildReport(c: SpecCase, doc: irTypes.IrDocument): { report: metricsV1.EvalReport; feature?: metricsV1.FeatureReport } {
  if (c.kind === "rejection") {
    const report: metricsV1.EvalReport = {
      schema: irTypes.METRICS_SCHEMA,
      engine: "spec",
      document: "spec",
      status: "error",
      features: [],
      error: { code: c.code, message: c.message, details: { errors: [{ code: c.code, path: "/", message: c.message, details: c.details }] } },
    };
    return { report };
  }
  let target: metricsV1.FeatureReport | undefined;
  const features: metricsV1.FeatureReport[] = doc.parts.flatMap((p) =>
    p.features.map((f) => {
      const entry: metricsV1.FeatureReport = { part: p.name, feature: f.name, feature_id: f.id, type: f.type, status: "ok", warnings: [] };
      if (f.name === c.feature) {
        if (c.kind === "error") {
          entry.status = "error";
          entry.error = { code: c.code, message: c.message, details: c.details };
        } else {
          entry.warnings = [{ code: c.code, severity: c.kind === "info" ? "info" : "warning", message: c.message, details: c.details }];
        }
        Object.assign(entry, c.entry ?? {});
        target = entry;
      }
      return entry;
    }),
  );
  const report: metricsV1.EvalReport = {
    schema: irTypes.METRICS_SCHEMA,
    engine: "spec",
    document: "spec",
    status: c.kind === "error" ? "error" : "ok",
    features,
    parts: doc.parts.map((p) => ({ part: p.name, part_id: p.id, bodies: p.features.some((f) => f.id === "f_e") ? [BOX_BODY] : [] })),
  };
  return { report: irTypes.parseEvalReport(report), ...(target ? { feature: target } : {}) };
}

/** One spec-derived occurrence per code (compiled IR + a schema-valid report). */
export function specOccurrences(): Map<string, Occurrence> {
  const out = new Map<string, Occurrence>();
  for (const c of CASES) {
    const doc = compileCase(c);
    const { report, feature } = buildReport(c, doc);
    const f = feature === undefined ? undefined : report.features.find((x) => x.feature === feature.feature);
    out.set(c.code, {
      source: "spec",
      label: `spec:${c.code}`,
      report,
      ir: doc,
      ...(f ? { feature: f } : {}),
      details: c.details,
      severity: c.kind === "warning" || c.kind === "info" ? c.kind : "error",
    });
  }
  return out;
}
