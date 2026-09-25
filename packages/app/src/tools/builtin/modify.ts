/**
 * Modify tools on an IR v1 model (FULL-MODELING-PLAN §1.2 rows 9–10, §2.5–§2.6): **Fillet**,
 * **Chamfer** and **Shell**. Each is a toolbar tool with a property panel:
 *
 * - selection inputs that pick in the viewport (edges, or faces for all their edges; faces to
 *   remove; a body), turned into Refs by Forge's `refFor` — verified to resolve to exactly the
 *   picked set, with a capture — in the state where the feature goes;
 * - typed sizes (numbers or parameter expressions) with a **handle** (a radius knob on the first
 *   edge, a distance arrow, a thickness arrow on the opened face) that clamps at drag start to
 *   Forge's feasible range and says what limits it;
 * - a **live checked preview**: the candidate is evaluated by Forge; a failure is shown on its field
 *   with the largest value that builds and a one-click "Use …";
 * - OK commits ONE catalogue op (`addFeature`; re-edit: `updateFeature`), exactly what the agent's
 *   `add_feature` / `update_feature` tools and MCP send — so a tool's result and the agent's are the
 *   same IR, the same transaction, the same undo step.
 *
 * Re-edit (the timeline's double-click, `feature.edit`) opens the same panel prefilled: the current
 * edges and faces are shown by name and kept unless the input is changed.
 */
import { feasibleRange, insertionPoint, type IrOp, type RefForResult } from "@aicad/model-ops";
import type { metricsV1 } from "@aicad/ir-types";
import type { AppServices } from "../../services";
import type {
  FeatureInfo,
  FieldError,
  NumberValue,
  PanelHandle,
  PanelSpec,
  PanelValues,
  PreviewOutcome,
  SelectionItem,
  SummaryRow,
  ToolContext,
  ToolDefinition,
} from "../framework/types";
import type { ToolRegistry } from "../registry";
import {
  checkedPreview,
  commandEngine,
  docFeatures,
  edgeAnchor,
  faceAnchor,
  partOf,
  picksOf,
  previewId,
  RefCache,
  refError,
  scalarOf,
  scalarText,
  v1Document,
  volumeRow,
  withEditedFeature,
  withNewFeature,
  type ErrorMapper,
  type Json,
} from "./feature-kit";

type Vec3 = [number, number, number];

/** Tools that change solids need a v1 model with a body. */
function needsBody(what: string) {
  return (ctx: ToolContext): true | { reason: string } => {
    if (!ctx.services.doc.isV1) return { reason: `${what} needs an IR v1 model (File ▸ New).` };
    const bodies = ctx.services.doc.getState().bodies.length;
    return bodies > 0 ? true : { reason: `${what} needs a solid: extrude a sketch first.` };
  };
}

/** The current members of an existing feature's Ref field as selection items (shown by name, kept unless changed). */
function refMembers(services: AppServices, feature: FeatureInfo, field: string): SelectionItem[] {
  const report = services.doc.getState().report as unknown as metricsV1.EvalReport | null;
  const entry = report?.features?.find((f) => f.feature_id === feature.id);
  const ref = entry?.refs?.find((r) => r.field === field);
  if (!ref) return [];
  return ref.members.map((m) => {
    const kind = m.probe.kind as "face" | "edge" | "vertex" | "body";
    if (kind === "body") return { kind: "body" as const, part: feature.part, body: m.key, label: m.name, refMember: true as const };
    return { kind, part: feature.part, key: m.key, point: m.probe.point as unknown as readonly [number, number, number], label: m.name, refMember: true as const };
  });
}

function sameItems(a: readonly SelectionItem[], b: readonly SelectionItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface RefChoice {
  /** The Ref JSON to write (the new one, or the feature's current one when the input is unchanged). */
  ref: unknown;
  result: RefForResult | null;
}

/**
 * The Ref of a selection input: the feature's own when re-editing and the input is unchanged,
 * otherwise Forge's `refFor` of the picks (where the feature goes, or in its input state).
 */
async function refOf(
  refs: RefCache,
  services: AppServices,
  items: readonly SelectionItem[],
  kind: "face" | "edge" | "body",
  at: { part: string; existing: FeatureInfo | null; initial: readonly SelectionItem[]; field: string },
  card?: "one" | "some" | "any",
): Promise<RefChoice> {
  if (at.existing && sameItems(items, at.initial)) return { ref: at.existing.json[at.field], result: null };
  const picks = picksOf(services, items);
  if (picks.length < items.length) throw Object.assign(new Error("A picked body is not in the current model; pick it again."), { code: "COMMAND_PICK_NOT_FOUND" });
  const result = await refs.get({ kind, picks, ...(card ? { card } : {}) }, at.existing ? { feature: at.existing.id } : { part: at.part });
  return { ref: result.ref, result };
}

function num(values: PanelValues, key: string): number | string | null {
  return scalarOf(values[key] as NumberValue);
}

/** The engine's feasible range of a size field, for a new feature (at the insertion point) or an existing one. */
async function feasibleOf(services: AppServices, existing: FeatureInfo | null, part: string, candidate: Json | null, field: string): Promise<{ min?: number; max?: number; reason?: string } | null> {
  const engine = commandEngine(services);
  const v = v1Document(services);
  if (!engine || !v) return null;
  let target: Parameters<typeof feasibleRange>[2];
  if (existing) target = { feature: existing.id };
  else if (candidate) target = { candidate, part, after: insertionPoint(v.document, part, v.rollback).after };
  else return null;
  const r = await feasibleRange(engine, v.document, target, field);
  // A size must stay above zero; the handle stops a hair above it.
  return { min: 0.01, ...(r.max !== undefined ? { max: r.max } : {}), ...(r.reason ? { reason: shortLimit(r.reason) } : {}) };
}

/** "max feasible r = 3.41 (face width 6.82 at slab/side:right)" → "face width 6.82 at slab/side:right". */
function shortLimit(reason: string): string {
  const m = /\(([^()]*(?:width|wall|gap|curvature|collapses|thickness)[^()]*)\)/.exec(reason);
  return m?.[1] ?? reason;
}

/**
 * A `*_FAILED` preview whose cause is the size (a blend or a wall running into another feature,
 * SPEC-v1 §6.6: a capability gap, not a size limit): when a smaller size builds, the error moves to
 * the size field with the largest that does, and the panel offers "Use …".
 */
async function sizeFailure(
  outcome: PreviewOutcome,
  failCode: string,
  services: AppServices,
  existing: FeatureInfo | null,
  part: string,
  candidate: Json,
  field: string,
  value: number | null,
): Promise<PreviewOutcome> {
  if (outcome.ok) return outcome;
  const e = outcome.errors[0];
  if (!e || e.code !== failCode || value === null) return outcome;
  let range: { max?: number } | null = null;
  try {
    range = await feasibleOf(services, existing, part, candidate, field);
  } catch {
    range = null;
  }
  if (range?.max === undefined || !(value > range.max)) return outcome;
  return { ok: false, errors: [{ field, code: e.code, message: e.message, feasible: { min: 0, max: range.max } }] };
}

function blendSummary(services: AppServices, kind: "fillet" | "chamfer") {
  return (entry: metricsV1.FeatureReport, report: metricsV1.EvalReport): SummaryRow[] => {
    const b = entry[kind];
    const rows: SummaryRow[] = [];
    if (b) {
      const added = b.chain_added?.length ?? 0;
      rows.push({ label: "Edges", value: `${b.edges.length}${added ? ` (${added} along the tangent chain)` : ""}`, tone: "ok" });
      rows.push({ label: "Faces created", value: String(b.faces_created.length) });
    }
    const v = volumeRow(services, report);
    if (v) rows.push(v);
    return rows;
  };
}

// ─── Fillet and chamfer ──────────────────────────────────────────────────────────────────────

const CHAMFER_FORMS = [
  { value: "equal", label: "Equal", hint: "The same distance on both faces" },
  { value: "two", label: "Two distances", hint: "A distance on each face" },
  { value: "angle", label: "Distance + angle", hint: "A distance and an angle from the face" },
];

function blendPanel(kind: "fillet" | "chamfer", ctx: ToolContext, existing: FeatureInfo | null): PanelSpec {
  const services = ctx.services;
  const refs = new RefCache(services);
  const label = kind === "fillet" ? "Fillet" : "Chamfer";
  const size = kind === "fillet" ? "r" : "d";
  const j = existing?.json ?? {};
  const initialEdges = existing ? refMembers(services, existing, "/edges") : null;
  const initialSide = existing && kind === "chamfer" && j["side"] ? refMembers(services, existing, "/side") : [];
  const form = j["d2"] !== undefined ? "two" : j["angle"] !== undefined ? "angle" : "equal";
  let part = existing?.part ?? partOf(services, ctx.selection.items());

  const featureOf = async (values: PanelValues, id: string): Promise<{ json: Json; set: Json } | { errors: FieldError[] }> => {
    const edges = values["edges"] as readonly SelectionItem[];
    part = existing?.part ?? partOf(services, edges);
    let edgeRef: RefChoice;
    try {
      edgeRef = await refOf(refs, services, edges, "edge", { part, existing, initial: initialEdges ?? [], field: "edges" });
    } catch (e) {
      return { errors: [refError(e, "edges")] };
    }
    const r = num(values, size);
    if (r === null) return { errors: [{ field: size, code: "REQUIRED", message: "Enter a size." }] };
    const json: Json = { type: kind, id, name: id, [size]: r, edges: edgeRef.ref };
    if (values["tangent_chain"] === false) json["tangent_chain"] = false;
    if (kind === "chamfer") {
      const f = String(values["form"]);
      if (f === "two") {
        const d2 = num(values, "d2");
        if (d2 === null) return { errors: [{ field: "d2", code: "REQUIRED", message: "Enter the second distance." }] };
        json["d2"] = d2;
      }
      if (f === "angle") {
        const a = num(values, "angle");
        if (a === null) return { errors: [{ field: "angle", code: "REQUIRED", message: "Enter the angle." }] };
        json["angle"] = a;
      }
      if (f !== "equal") {
        try {
          const side = await refOf(refs, services, values["side"] as readonly SelectionItem[], "face", { part, existing, initial: initialSide, field: "side" }, "one");
          json["side"] = side.ref;
        } catch (e) {
          return { errors: [refError(e, "side")] };
        }
      }
    }
    // What an edit changes: every field the panel owns (null removes one the form no longer has).
    const set: Json = {};
    for (const k of [size, "edges", "tangent_chain", "d2", "angle", "side"]) {
      const next = json[k] ?? (k === "tangent_chain" ? undefined : null);
      const before = j[k];
      if (next === undefined) {
        if (before !== undefined) set[k] = null;
        continue;
      }
      if (next === null) {
        if (before !== undefined) set[k] = null;
        continue;
      }
      if (JSON.stringify(next) !== JSON.stringify(before)) set[k] = next;
    }
    return { json, set };
  };

  const map: ErrorMapper = (e, refField) => {
    const d = e.details;
    if (e.code === "FILLET_RADIUS_TOO_LARGE") return { field: "r", ...(typeof d["max_feasible_r"] === "number" ? { max: d["max_feasible_r"] } : {}) };
    if (e.code === "CHAMFER_DISTANCE_TOO_LARGE") return { field: "d", ...(typeof d["max_feasible_d"] === "number" ? { max: d["max_feasible_d"] } : {}) };
    if (e.code === "INVALID_RADIUS" || e.code === "INVALID_DISTANCE") return { field: size };
    if (e.code === "INVALID_ANGLE") return { field: "angle" };
    if (e.code === "CHAMFER_SIDE_NOT_ADJACENT" || refField === "/side") return { field: "side" };
    if (e.code === "CHAMFER_OPTIONS_CONFLICT") return { field: "form" };
    if (refField === "/edges" || e.code.startsWith("REF_") || e.code.startsWith("FILLET_") || e.code.startsWith("CHAMFER_")) return { field: "edges" };
    return null;
  };

  const handles = (values: PanelValues): PanelHandle[] => {
    const first = (values["edges"] as readonly SelectionItem[])[0];
    if (!first) return [];
    const a = first.kind === "edge" ? edgeAnchor(services, first) : faceAnchor(services, first);
    if (!a) return [];
    return [{ field: size, kind: kind === "fillet" ? "radius" : "linear", origin: a.origin, axis: a.axis, min: 0.01, step: 0.5, fineStep: 0.1, label: kind === "fillet" ? "Radius" : "Distance" }];
  };

  const fields: PanelSpec["fields"] = [
    {
      key: "edges",
      label: "Edges",
      kind: "selection",
      accepts: ["edge", "face"],
      min: 1,
      hint: "Click edges — or a face for all its edges. Click again to remove.",
    },
    ...(kind === "chamfer" ? [{ key: "form", label: "Type", kind: "choice" as const, options: CHAMFER_FORMS, default: "equal" }] : []),
    {
      key: size,
      label: kind === "fillet" ? "Radius" : "Distance",
      kind: "number",
      quantity: "length",
      min: 0,
      minExclusive: true,
      step: 0.5,
      default: kind === "fillet" ? "2 mm" : "1 mm",
    },
    ...(kind === "chamfer"
      ? [
          { key: "d2", label: "Distance 2", kind: "number" as const, quantity: "length" as const, min: 0, minExclusive: true, step: 0.5, default: "1 mm", visibleWhen: (v: PanelValues) => v["form"] === "two" },
          { key: "angle", label: "Angle", kind: "number" as const, quantity: "angle" as const, min: 0, max: 90, minExclusive: true, step: 5, default: "45°", visibleWhen: (v: PanelValues) => v["form"] === "angle" },
          {
            key: "side",
            label: "Measured on",
            kind: "selection" as const,
            accepts: ["face" as const],
            min: 1,
            max: 1,
            fromSelection: false,
            hint: "The face the first distance is measured on (next to every edge).",
            visibleWhen: (v: PanelValues) => v["form"] !== "equal",
          },
        ]
      : []),
    { key: "tangent_chain", label: "Tangent chain", kind: "toggle", default: true, hint: "Also take edges that continue tangentially" },
  ];

  const pidFor = (): string => existing?.id ?? previewId(v1Document(services)?.document ?? "{}", kind);

  const initial: Record<string, unknown> = {};
  if (existing) {
    initial["edges"] = initialEdges ?? [];
    initial[size] = scalarText(j[size], "1");
    initial["tangent_chain"] = j["tangent_chain"] !== false;
    if (kind === "chamfer") {
      initial["form"] = form;
      if (j["d2"] !== undefined) initial["d2"] = scalarText(j["d2"], "1");
      if (j["angle"] !== undefined) initial["angle"] = scalarText(j["angle"], "45");
      initial["side"] = initialSide;
    }
  }

  return {
    title: existing ? `Edit ${existing.name ?? existing.id}` : label,
    icon: kind,
    description: kind === "fillet" ? "Rounds the picked edges with a constant radius" : "Bevels the picked edges",
    fields,
    ...(existing ? { initial: initial as NonNullable<PanelSpec["initial"]> } : {}),
    apply: !existing,
    preview: async (values, io): Promise<PreviewOutcome> => {
      const v = v1Document(services);
      if (!v) return { ok: false, errors: [{ code: "NOT_V1", message: `${label} needs an IR v1 model.` }] };
      const id = pidFor();
      const f = await featureOf(values, id);
      if (io.signal.aborted) return { ok: true };
      if ("errors" in f) return { ok: false, errors: f.errors };
      const text = existing ? withEditedFeature(v.document, v.rollback, existing.id, f.set) : withNewFeature(v.document, v.rollback, part, f.json).text;
      const outcome = await checkedPreview(services, text, id, io.signal, map, blendSummary(services, kind));
      if (io.signal.aborted) return outcome;
      return sizeFailure(outcome, kind === "fillet" ? "FILLET_FAILED" : "CHAMFER_FAILED", services, existing, part, f.json, size, (values[size] as NumberValue).value);
    },
    toOps: async (values): Promise<IrOp[]> => {
      const f = await featureOf(values, pidFor());
      if ("errors" in f) throw new Error(f.errors[0]?.message ?? "The inputs do not check");
      if (existing) return Object.keys(f.set).length ? [{ op: "updateFeature", feature: existing.id, set: f.set }] : [];
      const { id: _id, name: _name, ...feature } = f.json;
      return [{ op: "addFeature", part, feature: feature as { type: string } & Json }];
    },
    label: (values) => (existing ? `Edit ${existing.name ?? existing.id}` : `${label} ${(values["edges"] as readonly SelectionItem[]).length} edge${(values["edges"] as readonly SelectionItem[]).length === 1 ? "" : "s"}`),
    handles,
    feasible: async (field, values) => {
      if (field !== size) return null;
      const f = await featureOf(values, pidFor());
      if ("errors" in f) return null;
      return feasibleOf(services, existing, part, f.json, size);
    },
  };
}

export const filletTool: ToolDefinition = {
  id: "feature.fillet",
  label: "Fillet",
  group: "modify",
  icon: "fillet",
  shortcut: "Shift+F",
  order: 10,
  description: "Round edges with a radius: pick edges (or faces), drag the handle or type the size",
  accepts: ["edge", "face"],
  features: ["fillet"],
  enabledWhen: needsBody("Fillet"),
  activate: (ctx) => blendPanel("fillet", ctx, null),
  fromFeature: (feature, ctx) => blendPanel("fillet", ctx, feature),
};

export const chamferTool: ToolDefinition = {
  id: "feature.chamfer",
  label: "Chamfer",
  group: "modify",
  icon: "chamfer",
  order: 20,
  description: "Bevel edges: equal distance, two distances, or a distance and an angle",
  accepts: ["edge", "face"],
  features: ["chamfer"],
  enabledWhen: needsBody("Chamfer"),
  activate: (ctx) => blendPanel("chamfer", ctx, null),
  fromFeature: (feature, ctx) => blendPanel("chamfer", ctx, feature),
};

// ─── Shell ───────────────────────────────────────────────────────────────────────────────────

function shellPanel(ctx: ToolContext, existing: FeatureInfo | null): PanelSpec {
  const services = ctx.services;
  const refs = new RefCache(services);
  const j = existing?.json ?? {};
  const initialOpen = existing ? refMembers(services, existing, "/open") : [];
  const initialBody = existing ? refMembers(services, existing, "/body") : [];
  let part = existing?.part ?? partOf(services, ctx.selection.items());
  const pidFor = (): string => existing?.id ?? previewId(v1Document(services)?.document ?? "{}", "shell");

  const featureOf = async (values: PanelValues, id: string): Promise<{ json: Json; set: Json } | { errors: FieldError[] }> => {
    const open = values["open"] as readonly SelectionItem[];
    const bodyItems = values["body"] as readonly SelectionItem[];
    part = existing?.part ?? partOf(services, [...open, ...bodyItems]);
    const thickness = num(values, "thickness");
    if (thickness === null) return { errors: [{ field: "thickness", code: "REQUIRED", message: "Enter the wall thickness." }] };
    let bodyRef: unknown;
    try {
      if (existing && sameItems(bodyItems, initialBody) && sameItems(open, initialOpen)) bodyRef = j["body"];
      else if (bodyItems.length > 0) bodyRef = (await refOf(refs, services, bodyItems, "body", { part, existing, initial: initialBody, field: "body" }, "one")).ref;
      else if (open.length > 0) {
        const first = await refs.get({ kind: "body", picks: picksOf(services, [open[0]!]), card: "one" }, existing ? { feature: existing.id } : { part });
        bodyRef = first.ref;
      } else {
        const bodies = services.doc.getState().bodies;
        if (bodies.length !== 1) return { errors: [{ field: "body", code: "REQUIRED", message: "Pick the body to shell, or a face to remove." }] };
        bodyRef = (await refOf(refs, services, [{ kind: "body", part, body: bodies[0]!.name }], "body", { part, existing: null, initial: [], field: "body" }, "one")).ref;
      }
    } catch (e) {
      return { errors: [refError(e, bodyItems.length ? "body" : "open")] };
    }
    const json: Json = { type: "shell", id, name: id, thickness, body: bodyRef };
    if (open.length > 0) {
      try {
        json["open"] = (await refOf(refs, services, open, "face", { part, existing, initial: initialOpen, field: "open" })).ref;
      } catch (e) {
        return { errors: [refError(e, "open")] };
      }
    }
    if (values["direction"] === "outward") json["direction"] = "outward";
    const set: Json = {};
    for (const k of ["thickness", "body", "open", "direction"]) {
      const next = json[k];
      if (next === undefined) {
        if (j[k] !== undefined) set[k] = null;
      } else if (JSON.stringify(next) !== JSON.stringify(j[k])) set[k] = next;
    }
    return { json, set };
  };

  const map: ErrorMapper = (e, refField) => {
    const d = e.details;
    if (e.code === "SHELL_THICKNESS_TOO_LARGE") return { field: "thickness", ...(typeof d["max_feasible_thickness"] === "number" ? { max: d["max_feasible_thickness"] } : {}) };
    if (e.code === "SHELL_FACE_NOT_ON_BODY" || refField === "/open") return { field: "open" };
    if (refField === "/body") return { field: "body" };
    if (e.code === "INVALID_THICKNESS") return { field: "thickness" };
    return null;
  };

  return {
    title: existing ? `Edit ${existing.name ?? existing.id}` : "Shell",
    icon: "shell",
    description: "Hollows a body to a wall thickness; the picked faces are removed (opened)",
    fields: [
      { key: "open", label: "Faces to remove", kind: "selection", accepts: ["face"], min: 0, hint: "None: a closed hollow body with an inner void." },
      { key: "body", label: "Body", kind: "selection", accepts: ["body"], min: 0, max: 1, hint: "Taken from the faces; pick one only when no face is removed." },
      { key: "thickness", label: "Thickness", kind: "number", quantity: "length", min: 0, minExclusive: true, step: 0.5, default: "2 mm" },
      {
        key: "direction",
        label: "Direction",
        kind: "choice",
        options: [
          { value: "inward", label: "Inside", hint: "The walls grow inward: the outside stays" },
          { value: "outward", label: "Outside", hint: "The walls grow outward: the inside stays" },
        ],
        default: "inward",
      },
    ],
    ...(existing
      ? { initial: { open: initialOpen, body: initialBody, thickness: scalarText(j["thickness"], "2"), direction: j["direction"] === "outward" ? "outward" : "inward" } as NonNullable<PanelSpec["initial"]> }
      : {}),
    apply: !existing,
    preview: async (values, io): Promise<PreviewOutcome> => {
      const v = v1Document(services);
      if (!v) return { ok: false, errors: [{ code: "NOT_V1", message: "Shell needs an IR v1 model." }] };
      const id = pidFor();
      const f = await featureOf(values, id);
      if (io.signal.aborted) return { ok: true };
      if ("errors" in f) return { ok: false, errors: f.errors };
      const text = existing ? withEditedFeature(v.document, v.rollback, existing.id, f.set) : withNewFeature(v.document, v.rollback, part, f.json).text;
      const outcome = await checkedPreview(services, text, id, io.signal, map, (entry, report) => {
        const rows: SummaryRow[] = [];
        if (entry.shell) rows.push({ label: "Opened faces", value: entry.shell.closed_void ? "none (inner void)" : String(entry.shell.removed_faces.length), tone: "ok" });
        const vr = volumeRow(services, report);
        if (vr) rows.push(vr);
        return rows;
      });
      if (io.signal.aborted) return outcome;
      return sizeFailure(outcome, "SHELL_FAILED", services, existing, part, f.json, "thickness", (values["thickness"] as NumberValue).value);
    },
    toOps: async (values): Promise<IrOp[]> => {
      const f = await featureOf(values, pidFor());
      if ("errors" in f) throw new Error(f.errors[0]?.message ?? "The inputs do not check");
      if (existing) return Object.keys(f.set).length ? [{ op: "updateFeature", feature: existing.id, set: f.set }] : [];
      const { id: _id, name: _name, ...feature } = f.json;
      return [{ op: "addFeature", part, feature: feature as { type: string } & Json }];
    },
    label: () => (existing ? `Edit ${existing.name ?? existing.id}` : "Shell"),
    handles: (values): PanelHandle[] => {
      const face = (values["open"] as readonly SelectionItem[])[0];
      const a = face ? faceAnchor(services, face) : null;
      if (!a) return [];
      const inward = values["direction"] !== "outward";
      const axis: Vec3 = inward ? [-a.axis[0], -a.axis[1], -a.axis[2]] : a.axis;
      return [{ field: "thickness", kind: "linear", origin: a.origin, axis, min: 0.01, step: 0.5, fineStep: 0.1, label: "Thickness" }];
    },
    feasible: async (field, values) => {
      if (field !== "thickness") return null;
      const f = await featureOf(values, pidFor());
      if ("errors" in f) return null;
      return feasibleOf(services, existing, part, f.json, "thickness");
    },
  };
}

export const shellTool: ToolDefinition = {
  id: "feature.shell",
  label: "Shell",
  group: "modify",
  icon: "shell",
  order: 30,
  description: "Hollow a body to a wall thickness, removing the picked faces",
  accepts: ["face", "body"],
  features: ["shell"],
  enabledWhen: needsBody("Shell"),
  activate: (ctx) => shellPanel(ctx, null),
  fromFeature: (feature, ctx) => shellPanel(ctx, feature),
};

/** Feature types these tools make (for tests and the palette). */
export const MODIFY_FEATURES = ["fillet", "chamfer", "shell"] as const;

export function registerModifyTools(registry: ToolRegistry): () => void {
  const offs = [filletTool, chamferTool, shellTool].map((t) => registry.register(t));
  return () => {
    for (const off of offs) off();
  };
}

/** For tests: every feature of the document (id, type). */
export function documentFeatureTypes(services: AppServices): Array<[string, string]> {
  return docFeatures(services).map((f) => [f.id, f.type]);
}
