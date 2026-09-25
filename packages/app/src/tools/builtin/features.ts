/**
 * Feature tools on an IR v1 document, committing catalogue ops through the command layer (the same
 * ops the agent and MCP issue):
 *
 * - **Extrude** (`feature.extrude`, E): a sketch's regions into a solid — distance (a number or a
 *   parameter expression), direction, and new body / join / cut / intersect. It previews the
 *   candidate's bodies live and commits one `addFeature`; re-editing an extrude (`feature.edit`,
 *   the timeline's double-click) commits `setField`s.
 * - **Feature properties** ({@link featurePropertiesPanel}): the panel `feature.edit` opens for a
 *   feature no dedicated tool edits yet — its name and its top-level numbers (distance, angle,
 *   radius, thickness, …) and choices, each a `setField`.
 */
import type { IrOp } from "@aicad/model-ops";
import type { RenderBody } from "../../engine/types";
import type { AppServices } from "../../services";
import type {
  ChoiceFieldSpec,
  FeatureInfo,
  FieldSpec,
  NumberFieldSpec,
  NumberValue,
  PanelSpec,
  PanelValues,
  PreviewOutcome,
  Quantity,
  ToolContext,
  ToolDefinition,
} from "../framework/types";
import type { ToolRegistry } from "../registry";

type Json = Record<string, unknown>;

interface DocFeature {
  id: string;
  name: string;
  type: string;
  json: Json;
  part: string;
}

/** The IR v1 document the app holds, parsed (null on a CadScript document). */
function v1Doc(services: AppServices): { parts: Array<{ id: string; name: string; features: Json[] }> } | null {
  const s = services.doc.getState();
  if (s.format !== "ir-v1") return null;
  try {
    return JSON.parse(s.source) as { parts: Array<{ id: string; name: string; features: Json[] }> };
  } catch {
    return null;
  }
}

function features(services: AppServices): DocFeature[] {
  const d = v1Doc(services);
  if (!d) return [];
  return d.parts.flatMap((p) => p.features.map((f) => ({ id: String(f["id"]), name: String(f["name"]), type: String(f["type"]), json: f, part: p.id })));
}

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

/** The document with `feature` appended to its part (for a preview evaluation; never stored). */
function candidate(services: AppServices, part: string, feature: Json): string | null {
  const d = v1Doc(services);
  if (!d) return null;
  const p = d.parts.find((x) => x.id === part) ?? d.parts[0];
  if (!p) return null;
  p.features.push(feature);
  return JSON.stringify(d);
}

const PREVIEW_TINT: [number, number, number] = [0.33, 0.62, 0.98];

async function previewBodies(services: AppServices, text: string | null, signal: AbortSignal): Promise<PreviewOutcome> {
  if (!text) return { ok: true };
  const r = await services.engines.active.evaluate(text, services.doc.displayTessellation);
  if (signal.aborted) return { ok: true };
  const report = r.report as unknown as { features: Array<{ status: string; feature: string; error?: { code: string; message: string } }> };
  const failed = report.features[report.features.length - 1];
  if (failed && failed.status === "error") {
    return { ok: false, errors: [{ ...(failed.error?.code ? { code: failed.error.code } : {}), message: failed.error?.message ?? `${failed.feature} fails` }] };
  }
  const bodies: RenderBody[] = r.bodies.map((b) => ({ ...b, color: PREVIEW_TINT }));
  return { ok: true, bodies };
}

// ─── Extrude ─────────────────────────────────────────────────────────────────────────────────

function extrudeFields(sketches: readonly DocFeature[]): FieldSpec[] {
  return [
    {
      key: "sketch",
      label: "Profile",
      kind: "choice",
      style: "dropdown",
      options: sketches.map((s) => ({ value: s.id, label: s.name })),
      ...(sketches.length ? { default: sketches[sketches.length - 1]!.id } : {}),
      hint: "The sketch whose closed regions are extruded",
    },
    { key: "distance", label: "Distance", kind: "number", quantity: "length", min: 0, minExclusive: true, default: "10 mm" },
    { key: "direction", label: "Direction", kind: "choice", options: DIRECTIONS, default: "normal" },
    { key: "op", label: "Operation", kind: "choice", options: BODY_OPS, default: "new_body" },
  ];
}

function extrudeJson(values: PanelValues): Json | null {
  const distance = irScalar(values["distance"] as NumberValue);
  const sketch = values["sketch"];
  if (distance === null || typeof sketch !== "string" || sketch === "") return null;
  const direction = String(values["direction"] ?? "normal");
  const op = String(values["op"] ?? "new_body");
  return {
    type: "extrude",
    sketch,
    distance,
    ...(direction !== "normal" ? { direction } : {}),
    ...(op !== "new_body" ? { op, targets: "all" } : {}),
  };
}

function selectedSketch(ctx: ToolContext, sketches: readonly DocFeature[]): string | null {
  for (const item of ctx.selection.items()) {
    if (item.kind === "feature") {
      const f = sketches.find((s) => s.id === item.feature || s.name === item.feature);
      if (f) return f.id;
    }
  }
  return null;
}

export const extrudeTool: ToolDefinition = {
  id: "feature.extrude",
  label: "Extrude",
  group: "create",
  icon: "extrude",
  shortcut: "E",
  order: 10,
  description: "Pull a sketch's closed regions into a solid: new body, join, cut or intersect",
  accepts: ["feature"],
  features: ["extrude"],
  enabledWhen(ctx) {
    if (!ctx.services.doc.isV1) return { reason: "Extrude needs an IR v1 model (File ▸ New)." };
    return features(ctx.services).some((f) => f.type === "sketch") ? true : { reason: "Draw a sketch first (Sketch, ⇧S)." };
  },
  activate(ctx): PanelSpec {
    const sketches = features(ctx.services).filter((f) => f.type === "sketch");
    const picked = selectedSketch(ctx, sketches);
    const part = sketches.find((s) => s.id === picked)?.part ?? sketches[sketches.length - 1]?.part ?? "p1";
    return {
      title: "Extrude",
      description: "Pulls the profile's closed regions along the sketch normal",
      fields: extrudeFields(sketches),
      ...(picked ? { initial: { sketch: picked } } : {}),
      apply: true,
      preview: (values, io) => {
        const f = extrudeJson(values);
        return previewBodies(ctx.services, f ? candidate(ctx.services, part, { ...f, id: "__preview", name: "__preview" }) : null, io.signal);
      },
      toOps: (values): IrOp[] => {
        const f = extrudeJson(values);
        return f ? [{ op: "addFeature", part, feature: f as { type: string } & Json }] : [];
      },
      label: (values) => `Extrude ${sketches.find((s) => s.id === values["sketch"])?.name ?? ""}`.trim(),
    };
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const sketches = features(ctx.services).filter((f) => f.type === "sketch");
    const j = feature.json;
    const before = { sketch: j["sketch"], distance: j["distance"], direction: j["direction"] ?? "normal", op: j["op"] ?? "new_body" };
    return {
      title: `Edit ${feature.name ?? feature.id}`,
      fields: extrudeFields(sketches),
      initial: {
        sketch: String(before.sketch),
        distance: scalarText(before.distance, "10"),
        direction: String(before.direction),
        op: String(before.op),
      },
      toOps: (values): IrOp[] => {
        const next = extrudeJson(values);
        if (!next) return [];
        const set: Record<string, unknown> = {};
        if (next["sketch"] !== before.sketch) set["sketch"] = next["sketch"];
        if (next["distance"] !== before.distance) set["distance"] = next["distance"];
        if ((next["direction"] ?? "normal") !== before.direction) set["direction"] = next["direction"] ?? null;
        if ((next["op"] ?? "new_body") !== before.op) {
          set["op"] = next["op"] ?? null;
          set["targets"] = next["targets"] ?? null;
        }
        return Object.keys(set).length ? [{ op: "updateFeature", feature: feature.id, set }] : [];
      },
      label: () => `Edit ${feature.name ?? feature.id}`,
    };
  },
};

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

export function registerFeatureTools(registry: ToolRegistry): void {
  registry.register(extrudeTool);
}
