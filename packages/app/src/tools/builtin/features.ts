/**
 * Feature tools on an IR v1 document, committing catalogue ops through the command layer (the same
 * ops the agent and MCP issue):
 *
 * - **Extrude** (`feature.extrude`, E): a sketch's regions into a solid — distance (a number or a
 *   parameter expression), direction, and new body / join / cut / intersect. It previews the
 *   candidate's bodies live and commits one `addFeature`; re-editing an extrude (`feature.edit`,
 *   the timeline's double-click) commits `setField`s.
 * - **Thread** (`feature.thread`): a screw thread of a standard (ISO metric, UNC/UNF) on a picked
 *   cylindrical face — a hole wall gets a nut thread, a boss a bolt thread — modelled (the real
 *   helical groove, for printing) or cosmetic. Commits one `addFeature` (`type: "thread"`, SPEC-v1
 *   §6.13); re-editing commits `updateFeature`. `tool.start { id: "feature.thread", args }` makes it
 *   a command the agent and MCP call like the user does.
 * - **Feature properties** ({@link featurePropertiesPanel}): the panel `feature.edit` opens for a
 *   feature no dedicated tool edits yet — its name and its top-level numbers (distance, angle,
 *   radius, thickness, …) and choices, each a `setField`.
 */
import { v1 as irV1 } from "@aicad/ir-types";
import type { IrOp } from "@aicad/model-ops";
import type { RenderBody } from "../../engine/types";
import type { AppServices } from "../../services";
import type {
  ChoiceFieldSpec,
  FeatureInfo,
  FieldSpec,
  NumberFieldSpec,
  SelectionItem,
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
  const r = await services.engines.active.evaluate(text);
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

// ─── Thread (SPEC-v1 §6.13) ──────────────────────────────────────────────────────────────────

interface ThreadRow {
  family: string;
  major: number;
  pitch: number;
}

const FAMILY_ORDER = ["metric_coarse", "metric_fine", "unc", "unf"];

/** `THREAD_STANDARDS` as choices: metric coarse, metric fine, UNC, UNF, each by size. */
export const THREAD_CHOICES: ChoiceFieldSpec["options"] = (Object.entries(irV1.THREAD_STANDARDS.threads) as [string, ThreadRow][])
  .sort(([, a], [, b]) => FAMILY_ORDER.indexOf(a.family) - FAMILY_ORDER.indexOf(b.family) || a.major - b.major || a.pitch - b.pitch)
  .map(([name, r]) => ({ value: name, label: name, hint: `Ø${+r.major.toFixed(3)} mm × P${+r.pitch.toFixed(4)} mm` }));

const ID = String.raw`[A-Za-z_][A-Za-z0-9_]*`;

/**
 * The IR reference of a picked face, from its provenance key (SPEC-v1 §5.2): an extrude or
 * revolve side `F/side:<curve>`, a cap `F/cap:start|end`, a hole wall `H/wall@<position>`. Null for
 * any other key (a thread needs a plain bore or boss side).
 */
export function faceRefForKey(key: string): Json | null {
  let m = new RegExp(`^(${ID})/side:([A-Za-z0-9_.]+)$`).exec(key);
  if (m) return { kind: "face", q: { op: "side", feature: m[1], curve: m[2] } };
  m = new RegExp(`^(${ID})/wall@(${ID})$`).exec(key);
  if (m) return { kind: "face", q: { op: "hole_face", feature: m[1], at: m[2], part: "wall" } };
  m = new RegExp(`^(${ID})/cap:(start|end)$`).exec(key);
  if (m) return { kind: "face", q: { op: "cap", feature: m[1], end: m[2] } };
  return null;
}

function pickedFace(values: PanelValues): { part: string; ref: Json | null } | null {
  const sel = values["face"];
  if (!Array.isArray(sel) || sel.length !== 1) return null;
  const item = sel[0] as SelectionItem;
  if (item.kind !== "face") return null;
  return { part: item.part, ref: faceRefForKey(item.key) };
}

const THREAD_KINDS: ChoiceFieldSpec["options"] = [
  { value: "modeled", label: "Modelled", hint: "the real helical groove (prints as a thread)" },
  { value: "cosmetic", label: "Cosmetic", hint: "recorded only; the face stays a plain cylinder" },
];

const HANDS: ChoiceFieldSpec["options"] = [
  { value: "right", label: "Right hand" },
  { value: "left", label: "Left hand" },
];

function threadFields(withFace: boolean): FieldSpec[] {
  const fields: FieldSpec[] = [];
  if (withFace) fields.push({ key: "face", label: "Face", kind: "selection", accepts: ["face"], min: 1, max: 1, hint: "A hole wall (nut thread) or a boss side (bolt thread)" });
  fields.push(
    { key: "standard", label: "Standard", kind: "choice", style: "dropdown", options: THREAD_CHOICES, default: "M8", hint: "ISO metric coarse/fine, Unified UNC/UNF" },
    { key: "length", label: "Length", kind: "number", quantity: "length", min: 0, minExclusive: true, optional: true, hint: "Empty: the whole face" },
    { key: "kind", label: "Geometry", kind: "choice", options: THREAD_KINDS, default: "modeled" },
    { key: "hand", label: "Hand", kind: "choice", options: HANDS, default: "right" },
  );
  return fields;
}

/** The thread feature's fields from a panel (without `face`). */
function threadJson(values: PanelValues): Json {
  const out: Json = { standard: String(values["standard"] ?? "M8") };
  const length = values["length"] ? irScalar(values["length"] as NumberValue) : null;
  if (length !== null) out["length"] = length;
  if (values["hand"] === "left") out["hand"] = "left";
  if (values["kind"] === "cosmetic") out["modeled"] = false;
  return out;
}

export const threadTool: ToolDefinition = {
  id: "feature.thread",
  label: "Thread",
  group: "create",
  icon: "hole",
  order: 40,
  description: "A standard screw thread (M8, 1/2-20 UNF, …) on a hole wall or a boss: the real helical groove, ready to print",
  accepts: ["face"],
  features: ["thread"],
  enabledWhen(ctx) {
    if (!ctx.services.doc.isV1) return { reason: "Threads need an IR v1 model (File ▸ New)." };
    return features(ctx.services).some((f) => f.type === "hole" || f.type === "extrude" || f.type === "revolve") ? true : { reason: "Make a hole or a boss first." };
  },
  activate(ctx): PanelSpec {
    return {
      title: "Thread",
      description: "Pick a hole wall or a boss side; the standard sets the diameter and pitch",
      fields: threadFields(true),
      apply: true,
      validate: (values) => {
        const f = pickedFace(values);
        if (f && f.ref === null) return [{ field: "face", message: "Pick a hole wall or the side of a round extrude or revolve." }];
        return [];
      },
      preview: (values, io) => {
        const f = pickedFace(values);
        if (!f?.ref) return { ok: true };
        const feature = { type: "thread", id: "__preview", name: "__preview", face: f.ref, ...threadJson(values) };
        return previewBodies(ctx.services, candidate(ctx.services, f.part, feature), io.signal);
      },
      toOps: (values): IrOp[] => {
        const f = pickedFace(values);
        if (!f?.ref) return [];
        return [{ op: "addFeature", part: f.part, feature: { type: "thread", face: f.ref, ...threadJson(values) } as { type: string } & Json }];
      },
      label: (values) => `Thread ${String(values["standard"] ?? "")}`.trim(),
    };
  },
  fromFeature(feature: FeatureInfo): PanelSpec {
    const j = feature.json;
    const before = threadJson({
      standard: typeof j["standard"] === "string" ? j["standard"] : "M8",
      hand: j["hand"] === "left" ? "left" : "right",
      kind: j["modeled"] === false ? "cosmetic" : "modeled",
    });
    return {
      title: `Edit ${feature.name ?? feature.id}`,
      fields: threadFields(false),
      initial: {
        standard: typeof j["standard"] === "string" ? j["standard"] : "M8",
        ...(j["length"] !== undefined ? { length: scalarText(j["length"], "") } : {}),
        hand: j["hand"] === "left" ? "left" : "right",
        kind: j["modeled"] === false ? "cosmetic" : "modeled",
      },
      toOps: (values): IrOp[] => {
        const next = threadJson(values);
        const set: Record<string, unknown> = {};
        if (next["standard"] !== before["standard"]) set["standard"] = next["standard"];
        if ((next["length"] ?? null) !== (j["length"] ?? null)) set["length"] = next["length"] ?? null;
        if ((next["hand"] ?? "right") !== (j["hand"] ?? "right")) set["hand"] = next["hand"] ?? null;
        if ((next["modeled"] ?? true) !== (j["modeled"] ?? true)) set["modeled"] = next["modeled"] ?? null;
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
  registry.register(threadTool);
}
