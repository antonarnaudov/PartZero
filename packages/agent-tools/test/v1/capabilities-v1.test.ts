/**
 * The engine capability probe: the designer is told up front which v1 operations the attached engine
 * rejects (docs/BACKLOG.md: an unsupported operation found by a failed apply spends one of the six
 * failed applies of a CLI runtime run). Scripted engines for the classification rules; the recorded
 * Forge answer (`v1-forge-reports.json`, `capabilities`) for what Forge says today.
 */
import { describe, expect, it } from "vitest";
import { v1 as cs } from "@aicad/cadscript";
import { EngineError } from "@aicad/evals";
import { v1 as irTypes, type metricsV1 } from "@aicad/ir-types";
import { capabilitiesNoteV1, capabilityProbeSourceV1, probeEngineCapabilitiesV1, PROBED_OPERATIONS_V1, ScriptedEngineV1 } from "../../src/v1/index.js";
import { v1Fixtures } from "./fixtures.js";

/** Every feature ok, except those `fail` names (feature name → code): a feature error. */
function reportOf(doc: irTypes.IrDocument, fail: Record<string, string> = {}): metricsV1.EvalReport {
  const body: metricsV1.BodyReport = { origin: { feature: "f", member: "o.bottom" }, volume: 2000, area: 1200, centroid: [0, 0, 2.5], bbox_min: [-10, -10, 0], bbox_max: [10, 10, 5], faces: 6, edges: 12, shells: 1, face_types: { plane: 6 }, edge_types: { line: 12 }, valid: true };
  const features = doc.parts.flatMap((p) =>
    p.features.map((f): metricsV1.FeatureReport => {
      const code = fail[f.name];
      return code
        ? { part: p.name, feature: f.name, feature_id: f.id, type: f.type, status: "error", warnings: [], error: { code, message: `${code} (scripted)`, details: code === "UNSUPPORTED_FEATURE_VERSION" ? { type: f.type, supported: [] } : {} } }
        : { part: p.name, feature: f.name, feature_id: f.id, type: f.type, status: "ok", warnings: [] };
    }),
  );
  return irTypes.parseEvalReport({ schema: irTypes.METRICS_SCHEMA, engine: "scripted 1.0", document: "capabilities", status: Object.keys(fail).length > 0 ? "error" : "ok", features, params: [], parts: doc.parts.map((p) => ({ part: p.name, part_id: p.id, bodies: [body] })) });
}

/** A document-level rejection, as Forge answers an operation it does not implement. */
function rejection(doc: irTypes.IrDocument, types: readonly string[], code = "UNSUPPORTED_FEATURE"): metricsV1.EvalReport {
  const errors = doc.parts.flatMap((p, i) => p.features.flatMap((f, j) => (types.includes(f.type) ? [{ code, message: `this engine does not implement "${f.type}"`, path: `/parts/${i}/features/${j}/type`, details: { type: f.type } }] : [])));
  return irTypes.parseEvalReport({ schema: irTypes.METRICS_SCHEMA, engine: "scripted 1.0", document: "capabilities", status: "error", error: { code, message: "rejected", details: { errors } }, features: [], params: [], parts: [] });
}

describe("the engine capability probe", () => {
  it("compiles to one part per probed operation, each with the operation as feature f_<op>", () => {
    const r = cs.compile(capabilityProbeSourceV1());
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ir!.parts.map((p) => p.name)).toEqual(PROBED_OPERATIONS_V1.map((o) => `probe_${o.op}`));
    for (const o of PROBED_OPERATIONS_V1) {
      const part = r.ir!.parts.find((p) => p.name === `probe_${o.op}`)!;
      expect(part.features.find((f) => f.name === `f_${o.op}`)?.type, o.op).toBe(o.type);
    }
  });

  it("drops the parts a document rejection names, asks again, and classifies every operation", async () => {
    const engine = new ScriptedEngineV1((doc) => (doc.parts.some((p) => p.features.some((f) => f.type === "draft")) ? rejection(doc, ["draft"]) : reportOf(doc, { f_hole: "UNSUPPORTED_FEATURE_VERSION", f_mirror: "BOOLEAN_EMPTY_RESULT" })));
    const c = await probeEngineCapabilitiesV1(engine);
    expect(engine.evaluations).toBe(2);
    expect(c).toEqual({
      engine: "scripted 1.0",
      evaluated: ["revolve", "boolean", "fillet", "chamfer", "shell", "linearPattern", "circularPattern"],
      unsupported: [
        { op: "hole", type: "hole", code: "UNSUPPORTED_FEATURE_VERSION" },
        { op: "draft", type: "draft", code: "UNSUPPORTED_FEATURE" },
      ],
      // Another error is not an answer: never reported as unsupported.
      unknown: ["mirror"],
    });
    expect(capabilitiesNoteV1(c)).toBe(
      "The attached engine does not evaluate `hole`, `draft` (it answers UNSUPPORTED_FEATURE_VERSION / UNSUPPORTED_FEATURE): do not use them; build that geometry with the operations it has (it evaluated `revolve`, `boolean`, `fillet`, `chamfer`, `shell`, `linearPattern`, `circularPattern`, extrude and sketches).",
    );
  });

  it("says nothing it does not know: an engine failure or another rejection gives no answer, and full support no note", async () => {
    expect(await probeEngineCapabilitiesV1(new ScriptedEngineV1(() => { throw new EngineError("ENGINE_TIMEOUT", "timed out"); }))).toBeUndefined();
    expect(await probeEngineCapabilitiesV1(new ScriptedEngineV1((doc) => rejection(doc, ["hole"], "DUPLICATE_NAME")))).toBeUndefined();
    const all = await probeEngineCapabilitiesV1(new ScriptedEngineV1((doc) => reportOf(doc)));
    expect(all?.unsupported).toEqual([]);
    expect(capabilitiesNoteV1(all)).toBeUndefined();
    expect(capabilitiesNoteV1(undefined)).toBeUndefined();
  });

  it("passes the caller's time limit to every evaluation", async () => {
    const limits: (number | undefined)[] = [];
    await probeEngineCapabilitiesV1(new ScriptedEngineV1((doc, o) => (limits.push(o.timeoutMs), reportOf(doc))), { timeoutMs: 1234 });
    expect(limits).toEqual([1234]);
  });

  it("Forge today (recorded): the operations it rejects are named, with the code it answers", () => {
    const c = v1Fixtures().capabilities;
    expect(c).toBeDefined();
    expect(c!.unknown).toEqual([]);
    expect(c!.unsupported.map((u) => `${u.op}:${u.code}`)).toEqual(["draft:UNSUPPORTED_FEATURE"]);
    expect([...c!.evaluated, ...c!.unsupported.map((u) => u.op)].sort()).toEqual(PROBED_OPERATIONS_V1.map((o) => o.op).sort());
  });
});
