/**
 * `downgrade_to_v0` for the agent's hand-off (SPEC-v1 §9.1 [W0-18], the inverse of the migration
 * on documents whose surface equals v0): the in-app designer still writes CadScript v0, so a model
 * that v0 can express (sketches of lines, arcs and circles, extrudes and revolves, literal values,
 * no parameters) reaches it as its own v0 CadScript, and its proposal comes back as a code edit.
 * Anything v1-only returns null (the designer then gets the CadScript v1 print); an expression in
 * a numeric field fails the v0 schema, which decides last.
 */
import { safeParseIrDocument, type IrDocument } from "@aicad/ir-types";

type Json = Record<string, unknown>;

const V0_FEATURES = new Set(["sketch", "extrude", "revolve"]);
const V0_CURVES = new Set(["line", "arc", "circle"]);
/** Fields v1 adds that v0 has no place for (non-semantic metadata); anything else unknown is not v0. */
const DROPPED = new Set(["author", "note", "intent", "assumptions", "decision_ids", "v"]);

export function downgradeToV0(v1Text: string): IrDocument | null {
  let d: Json;
  try {
    d = JSON.parse(v1Text) as Json;
  } catch {
    return null;
  }
  if (d["schema"] !== "aicad.ir/1" || (Array.isArray(d["params"]) && d["params"].length > 0)) return null;
  const parts = d["parts"];
  if (!Array.isArray(parts)) return null;
  const out: Json = { schema: "aicad.ir/0", ...(d["meta"] ? { meta: d["meta"] } : {}), parts: [] as Json[] };
  for (const p of parts as Json[]) {
    if (Array.isArray(p["params"]) && p["params"].length > 0) return null;
    const features = p["features"] as Json[];
    const nameOf = new Map(features.map((f) => [String(f["id"]), String(f["name"])]));
    const next: Json[] = [];
    for (const f0 of features) {
      if (!V0_FEATURES.has(String(f0["type"]))) return null;
      const f: Json = {};
      for (const [k, v] of Object.entries(f0)) if (!DROPPED.has(k)) f[k] = v;
      if (f["suppressed"] !== undefined && typeof f["suppressed"] !== "boolean") return null;
      if (f["type"] === "sketch") {
        if (Array.isArray(f["constraints"]) && f["constraints"].length > 0) return null;
        delete f["constraints"];
        const curves = f["curves"] as Json[];
        if (!curves.every((c) => V0_CURVES.has(String(c["kind"])) && c["construction"] !== true)) return null;
      } else {
        // v1 references the sketch by id, v0 by name.
        const sketch = nameOf.get(String(f["sketch"]));
        if (!sketch) return null;
        f["sketch"] = sketch;
      }
      next.push(f);
    }
    (out["parts"] as Json[]).push({ id: p["id"], name: p["name"], features: next });
  }
  const parsed = safeParseIrDocument(out);
  return parsed.success ? parsed.data : null;
}
