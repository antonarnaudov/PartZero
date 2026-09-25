/**
 * Every value of an IR v1 model in one list (FULL-MODELING-PLAN T0 #14, Fusion's "Change
 * Parameters"): the user parameters, and each feature's dimensions — an extrude's distance, a
 * fillet's radius, a sketch's driving dimensions and compound sizes, a pattern's count and
 * spacing, a hole's depth. Each dimension is a Scalar field (SPEC-v1 §2.2): a literal or an
 * expression over parameters, edited with `setField` and promoted to a parameter with
 * `addParam` + `setField { expr }` in one transaction.
 *
 * Which fields are dimensions, and their units, follows the SPEC's feature tables (§4.1, §6);
 * coordinates of explicit sketch geometry and references are not dimensions and are left out.
 */
import type { PARAM_UNITS } from "@aicad/model-ops";

/** A parameter unit (SPEC-v1 §2.1). */
export type ParamUnit = (typeof PARAM_UNITS)[number];

type Json = Record<string, unknown>;

export interface ModelValue {
  /** `feature/path`: a stable key while the feature and field exist. */
  key: string;
  part: string;
  partName: string;
  feature: string;
  featureName: string;
  featureType: string;
  /** JSON pointer into the feature (`setField.path`). */
  path: string;
  /** What the value is, for people: `distance`, `rect outline · width`, `distance d3`. */
  label: string;
  unit: ParamUnit;
  /** The stored value: a literal, or an expression (text). */
  value: number | string;
  /** Whether the stored value is an expression (it uses parameters). */
  isExpression: boolean;
  /** A suppressed feature's values are listed but greyed. */
  suppressed: boolean;
}

/** Units by field name (SPEC-v1 §6); `value` follows the constraint type, `start` only in a bolt circle. */
const MM: ReadonlySet<string> = new Set([
  "distance",
  "r",
  "d",
  "d2",
  "thickness",
  "radius",
  "w",
  "h",
  "dx",
  "dy",
  "spacing",
  "spacing2",
  "blind",
  "circumradius",
  "inradius",
  "across_flats",
  "side",
  "x",
  "y",
  "offset",
  "depth",
]);
const DEG: ReadonlySet<string> = new Set(["angle", "tip", "rotation"]);
const COUNT: ReadonlySet<string> = new Set(["count", "count2", "n", "nx", "ny"]);
/** Objects that are references (a Ref, a query): their contents are not dimensions. */
const REF_FIELDS: ReadonlySet<string> = new Set(["q", "capture", "targets", "tools", "edges", "faces", "open", "body", "target", "bodies", "edge", "face", "up_to"]);

const LABELS: Record<string, string> = {
  distance: "distance",
  angle: "angle",
  r: "radius",
  d: "diameter",
  d2: "distance 2",
  thickness: "thickness",
  radius: "radius",
  w: "width",
  h: "height",
  dx: "spacing x",
  dy: "spacing y",
  spacing: "spacing",
  spacing2: "spacing 2",
  blind: "depth",
  circumradius: "circumradius",
  inradius: "inradius",
  across_flats: "across flats",
  side: "side",
  tip: "tip angle",
  rotation: "rotation",
  count: "count",
  count2: "count 2",
  n: "count",
  nx: "count x",
  ny: "count y",
  x: "x",
  y: "y",
  offset: "offset",
  start: "start angle",
};

function unitOf(key: string, parent: Json, inConstraint: boolean): ParamUnit | null {
  if (key === "value" && inConstraint) return parent["type"] === "angle" ? "deg" : "mm";
  if (key === "start" && "n" in parent && "d" in parent) return "deg"; // bolt circle (SPEC-v1 §6.5)
  if (key === "d" && "n" in parent && "center" in parent) return "mm"; // bolt circle diameter
  if (MM.has(key)) return "mm";
  if (DEG.has(key)) return "deg";
  if (COUNT.has(key)) return "count";
  return null;
}

const escapePointer = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1");

function isScalar(v: unknown): v is number | string {
  return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim().length > 0);
}

/** Words that are keywords of a Scalar-typed field, not expressions (`depth: "through"`). */
const KEYWORDS: ReadonlySet<string> = new Set(["through", "all", "flat", "none", "normal", "reverse", "symmetric"]);

interface Walk {
  push(path: string, label: string, unit: ParamUnit, value: number | string): void;
}

function walkObject(node: Json, path: string, label: string, w: Walk, inConstraint: boolean): void {
  for (const [k, v] of Object.entries(node)) {
    if (REF_FIELDS.has(k)) continue;
    const p = `${path}/${escapePointer(k)}`;
    if (isScalar(v)) {
      if (typeof v === "string" && KEYWORDS.has(v)) continue;
      const unit = unitOf(k, node, inConstraint);
      if (!unit) continue;
      w.push(p, label ? `${label} · ${LABELS[k] ?? k}` : (LABELS[k] ?? k), unit, v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      walkObject(v as Json, p, label ? `${label} · ${LABELS[k] ?? k}` : k === "at" ? "placement" : k === "layout" ? "" : (LABELS[k] ?? k), w, false);
    }
  }
}

/** The dimensions of one feature (see the module comment). */
export function featureValues(feature: Json): Array<{ path: string; label: string; unit: ParamUnit; value: number | string }> {
  const out: Array<{ path: string; label: string; unit: ParamUnit; value: number | string }> = [];
  const w: Walk = { push: (path, label, unit, value) => out.push({ path, label, unit, value }) };
  if (feature["type"] === "sketch") {
    const curves = Array.isArray(feature["curves"]) ? (feature["curves"] as Json[]) : [];
    curves.forEach((c, i) => {
      if (!c || typeof c !== "object") return;
      const kind = typeof c["kind"] === "string" ? c["kind"] : "curve";
      const id = typeof c["id"] === "string" ? c["id"] : String(i);
      for (const k of ["radius", "w", "h", "r", "circumradius", "inradius", "across_flats", "side", "n", "rotation"]) {
        const v = c[k];
        if (!isScalar(v)) continue;
        const unit: ParamUnit = k === "n" ? "count" : k === "rotation" ? "deg" : "mm";
        w.push(`/curves/${i}/${k}`, `${kind} ${id} · ${k === "n" ? "sides" : (LABELS[k] ?? k)}`, unit, v);
      }
    });
    const constraints = Array.isArray(feature["constraints"]) ? (feature["constraints"] as Json[]) : [];
    constraints.forEach((c, i) => {
      if (!c || typeof c !== "object") return;
      const type = typeof c["type"] === "string" ? c["type"] : "constraint";
      const id = typeof c["id"] === "string" ? ` ${c["id"]}` : "";
      if (isScalar(c["value"]) && c["driving"] !== false) w.push(`/constraints/${i}/value`, `${type}${id}`, type === "angle" ? "deg" : "mm", c["value"]);
      if (type === "fix") {
        for (const k of ["x", "y"]) if (isScalar(c[k])) w.push(`/constraints/${i}/${k}`, `fix${id} · ${k}`, "mm", c[k]);
      }
    });
    return out;
  }
  const body: Json = {};
  for (const [k, v] of Object.entries(feature)) {
    if (["id", "name", "type", "v", "suppressed", "note", "intent", "author", "assumptions", "decision_ids", "sketch", "regions", "axis", "normal", "origin", "x_dir", "points", "skip", "seed"].includes(k)) continue;
    body[k] = v;
  }
  // A hole's depth `{ "blind": d }` reads as its depth.
  walkObject(body, "", "", w, false);
  return out.map((v) => {
    if (v.label === "depth · depth") return { ...v, label: "depth" };
    // A chamfer's `d` and `d2` are distances along the faces (SPEC-v1 §6.7), not diameters.
    if (feature["type"] === "chamfer" && v.path === "/d") return { ...v, label: "distance" };
    return v;
  });
}

interface DocLike {
  parts?: Array<{ id?: unknown; name?: unknown; features?: unknown[] }>;
}

/** Every feature dimension of the document, in timeline order. */
export function modelValues(document: DocLike | null | undefined): ModelValue[] {
  const out: ModelValue[] = [];
  for (const part of document?.parts ?? []) {
    const partId = typeof part.id === "string" ? part.id : "";
    const partName = typeof part.name === "string" ? part.name : partId;
    for (const f of part.features ?? []) {
      if (!f || typeof f !== "object") continue;
      const j = f as Json;
      const id = typeof j["id"] === "string" ? j["id"] : "";
      if (!id) continue;
      for (const v of featureValues(j)) {
        out.push({
          key: `${id}${v.path}`,
          part: partId,
          partName,
          feature: id,
          featureName: typeof j["name"] === "string" ? j["name"] : id,
          featureType: typeof j["type"] === "string" ? j["type"] : "",
          path: v.path,
          label: v.label,
          unit: v.unit,
          value: v.value,
          isExpression: typeof v.value === "string",
          suppressed: j["suppressed"] === true,
        });
      }
    }
  }
  return out;
}

/** Parameter name grammar (SPEC-v1 §2.1): a letter, then letters, digits and `_`. */
export const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A free parameter name for promoting a value: `slab_distance`, `outline_width_2`. */
export function suggestParamName(v: Pick<ModelValue, "featureName" | "label">, taken: ReadonlySet<string>): string {
  const words = `${v.featureName} ${v.label.split(" · ").pop() ?? v.label}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  let base = /^[a-z]/.test(words) ? words : `p_${words}`;
  if (base.length > 48) base = base.slice(0, 48).replace(/_+$/, "");
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
}

/**
 * The document with one scratch parameter per expression value, so the engine evaluates every
 * expression exactly as the model does (same scope: a part's values see its part parameters).
 * Returns the text and each value's scratch name.
 */
export function withScratchParams(document: string, values: readonly ModelValue[], prefix = "pzv"): { text: string; names: Map<string, string> } | null {
  let d: { params?: Json[]; parts?: Array<Json & { params?: Json[] }> };
  try {
    d = JSON.parse(document) as typeof d;
  } catch {
    return null;
  }
  const names = new Map<string, string>();
  const taken = new Set<string>([...(d.params ?? []), ...(d.parts ?? []).flatMap((p) => p.params ?? [])].map((p) => String(p["name"])));
  let n = 0;
  for (const v of values) {
    if (!v.isExpression) continue;
    const part = d.parts?.find((p) => p["id"] === v.part);
    if (!part) continue;
    let name = `${prefix}${n++}`;
    while (taken.has(name)) name = `${prefix}${n++}`;
    taken.add(name);
    names.set(v.key, name);
    part.params = [...(part.params ?? []), { name, unit: v.unit, value: v.value }];
  }
  if (names.size === 0) return null;
  return { text: JSON.stringify(d), names };
}
