/**
 * Feature tools on an IR v1 document, committing catalogue ops through the command layer (the same
 * ops the agent and MCP issue):
 *
 * - **The create and construct tools** (`tools/create`): Extrude, Revolve, Hole, Push/Pull,
 *   Combine, Plane and Axis — panels over the model-ops commands the agent and MCP call too.
 * - **Feature properties** ({@link featurePropertiesPanel}): the panel `feature.edit` opens for a
 *   feature no dedicated tool edits yet — its name and its top-level numbers (distance, angle,
 *   radius, thickness, …) and choices, each a `setField`.
 */
import type { IrOp } from "@aicad/model-ops";
import { registerCreateTools } from "../create";
import type { ChoiceFieldSpec, FeatureInfo, FieldSpec, NumberFieldSpec, NumberValue, PanelSpec, Quantity } from "../framework/types";
import type { ToolRegistry } from "../registry";

/** A number field's value as IR: a literal number (base units) or a canonical expression string. */
export function irScalar(v: NumberValue): number | string | null {
  if (v.expression) return v.canonical;
  return v.value ?? (v.canonical !== null && Number.isFinite(Number(v.canonical)) ? Number(v.canonical) : null);
}

/** A Scalar field of a feature as the text a number field starts with. */
function scalarText(v: unknown, fallback: string): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "string" && v.length > 0) return v;
  return fallback;
}

const DIRECTIONS: ChoiceFieldSpec["options"] = [
  { value: "normal", label: "One side" },
  { value: "reverse", label: "Flip" },
  { value: "symmetric", label: "Symmetric" },
];

const BODY_OPS: ChoiceFieldSpec["options"] = [
  { value: "new_body", label: "New body" },
  { value: "join", label: "Join" },
  { value: "cut", label: "Cut" },
  { value: "intersect", label: "Intersect" },
];

// ─── Any feature: its name, numbers and choices ──────────────────────────────────────────────

/** Top-level numeric fields and what they measure. */
const NUMBER_FIELDS: Record<string, { label: string; quantity: Quantity; min?: number; minExclusive?: boolean }> = {
  distance: { label: "Distance", quantity: "length" },
  angle: { label: "Angle", quantity: "angle" },
  r: { label: "Radius", quantity: "length", min: 0, minExclusive: true },
  d: { label: "Distance", quantity: "length", min: 0, minExclusive: true },
  thickness: { label: "Thickness", quantity: "length", min: 0, minExclusive: true },
  count: { label: "Count", quantity: "count", min: 1 },
  spacing: { label: "Spacing", quantity: "length" },
  offset: { label: "Offset", quantity: "length" },
};

const CHOICE_FIELDS: Record<string, { label: string; options: ChoiceFieldSpec["options"] }> = {
  direction: { label: "Direction", options: DIRECTIONS },
  op: { label: "Operation", options: BODY_OPS },
};

/** The property panel of any feature: name, top-level numbers and choices; OK commits `setField`s. */
export function featurePropertiesPanel(feature: FeatureInfo): PanelSpec {
  const j = feature.json;
  const fields: FieldSpec[] = [
    { key: "name", label: "Name", kind: "text", default: feature.name ?? feature.id, pattern: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/, patternMessage: "Letters, digits and _; not starting with a digit." },
  ];
  const initial: Record<string, string> = { name: feature.name ?? feature.id };
  for (const [key, spec] of Object.entries(NUMBER_FIELDS)) {
    const v = j[key];
    if (typeof v !== "number" && typeof v !== "string") continue;
    const field: NumberFieldSpec = { key, kind: "number", label: spec.label, quantity: spec.quantity, ...(spec.min !== undefined ? { min: spec.min } : {}), ...(spec.minExclusive ? { minExclusive: true } : {}) };
    fields.push(field);
    initial[key] = scalarText(v, "0");
  }
  for (const [key, spec] of Object.entries(CHOICE_FIELDS)) {
    const v = j[key];
    if (typeof v !== "string" || !spec.options.some((o) => o.value === v)) continue;
    fields.push({ key, kind: "choice", label: spec.label, options: spec.options });
    initial[key] = v;
  }
  return {
    title: `Edit ${feature.name ?? feature.id}`,
    icon: feature.type,
    description: `${feature.type} · ${feature.id}`,
    fields,
    initial,
    toOps: (values): IrOp[] => {
      const ops: IrOp[] = [];
      const set: Record<string, unknown> = {};
      for (const f of fields) {
        if (f.kind === "number") {
          const next = irScalar(values[f.key] as NumberValue);
          if (next !== null && next !== j[f.key]) set[f.key] = next;
        } else if (f.kind === "choice") {
          if (values[f.key] !== j[f.key]) set[f.key] = values[f.key];
        }
      }
      if (Object.keys(set).length) ops.push({ op: "updateFeature", feature: feature.id, set });
      const name = String(values["name"] ?? "");
      if (name && name !== (feature.name ?? feature.id)) ops.push({ op: "renameFeature", feature: feature.id, name });
      return ops;
    },
    label: () => `Edit ${feature.name ?? feature.id}`,
  };
}

/** The feature tools: the create and construct tools (`tools/create`: Extrude, Revolve, Hole, Push/Pull, Combine, Plane, Axis). */
export function registerFeatureTools(registry: ToolRegistry): void {
  registerCreateTools(registry);
}
