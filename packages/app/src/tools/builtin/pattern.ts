/**
 * Pattern tools on an IR v1 model (FULL-MODELING-PLAN §1.2 row 9, §2.5–§2.6; SPEC-v1 §6.10): **Linear
 * pattern**, **Circular pattern** and **Mirror**, each of features (extrude, revolve, hole: the seed's
 * operation is repeated — a hole pattern drills every copy) or of bodies (copies as new bodies, or
 * joined). One IR feature type, `pattern`, with a `linear`, `circular` or `mirror` layout.
 *
 * - Seeds are picked in the timeline (features) or the viewport (a face picks the feature that made
 *   it; for bodies, a body or a face of it).
 * - Directions, axes and planes are picked: the origin axes and planes, straight or circular edges,
 *   cylindrical faces (their axis), planar faces (mirror), datum planes and axes.
 * - The live preview is checked by Forge; the spacing (linear) and total angle (circular) have
 *   handles; errors land on their field.
 * - OK commits one `addFeature` (re-edit: `updateFeature`) — the agent's `add_feature` with the
 *   same JSON.
 *
 * Sketch-driven patterns (instances at a sketch's points) are not in IR v1 (FULL-MODELING-PLAN
 * §1.3, FM8): the tools do not offer them.
 */
import type { IrOp } from "@aicad/model-ops";
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
  add,
  centreOf,
  checkedPreview,
  docFeatures,
  edgeDirection,
  len,
  partOf,
  picksOf,
  previewId,
  RefCache,
  refError,
  scalarOf,
  scalarText,
  scale,
  signCanonical,
  sub,
  unit,
  v1Document,
  volumeRow,
  withEditedFeature,
  withNewFeature,
  type ErrorMapper,
  type Json,
  type Vec3,
} from "./feature-kit";

type Layout = "linear" | "circular" | "mirror";

const SEED_TYPES = new Set(["extrude", "revolve", "hole"]);
const AXES: Record<string, Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
const PLANES = new Set(["XY", "XZ", "YZ"]);

function num(values: PanelValues, key: string): number | string | null {
  return scalarOf(values[key] as NumberValue);
}

function needsSeedSource(what: string) {
  return (ctx: ToolContext): true | { reason: string } => {
    if (!ctx.services.doc.isV1) return { reason: `${what} needs an IR v1 model (File ▸ New).` };
    return docFeatures(ctx.services).some((f) => SEED_TYPES.has(f.type)) || ctx.services.doc.getState().bodies.length > 0
      ? true
      : { reason: `${what} needs a feature or a body to repeat: extrude a sketch first.` };
  };
}

/** The feature ids the seed items designate (a face: the feature that made it), in timeline order. */
function seedFeatures(services: AppServices, items: readonly SelectionItem[]): { ids: string[]; bad: string[] } {
  const all = docFeatures(services);
  const wanted = new Set<string>();
  for (const it of items) {
    if (it.kind === "feature") wanted.add(all.find((f) => f.id === it.feature || f.name === it.feature)?.id ?? it.feature);
    else if (it.kind === "face" || it.kind === "edge") {
      const head = it.key.slice(0, Math.max(0, it.key.indexOf("/")));
      if (head) wanted.add(head);
    }
  }
  const ids = all.filter((f) => wanted.has(f.id)).map((f) => f.id);
  const bad = all.filter((f) => wanted.has(f.id) && !SEED_TYPES.has(f.type)).map((f) => `${f.name} (${f.type})`);
  return { ids, bad };
}

/** An origin item's id (`X`, `XY`, …), a datum's feature id, or null. */
function originId(it: SelectionItem | undefined): string | null {
  return it && it.kind === "origin" ? it.feature : null;
}

function datumId(services: AppServices, it: SelectionItem | undefined): string | null {
  if (!it || it.kind !== "datum") return null;
  return docFeatures(services).find((f) => f.id === it.feature || f.name === it.feature)?.id ?? it.feature;
}

const originItem = (id: string): SelectionItem => ({ kind: "origin", feature: id, label: id.length === 2 ? `${id} plane` : `${id} axis` });

/** Selection items for an existing AxisRef / Dir / PlaneRef value (shown, kept unless changed). */
function refValueItems(services: AppServices, feature: FeatureInfo | null, value: unknown, path: string): SelectionItem[] {
  if (typeof value === "string") return [originItem(value.replace(/^[+-]/, ""))];
  if (!value || typeof value !== "object") return [];
  const v = value as Json;
  if (typeof v["datum"] === "string") return [{ kind: "datum", feature: v["datum"], label: v["datum"] }];
  const key = ["edge", "cylinder", "face"].find((k) => v[k] !== undefined);
  if (key && feature) {
    const report = services.doc.getState().report as unknown as metricsV1.EvalReport | null;
    const entry = report?.features?.find((f) => f.feature_id === feature.id);
    const ref = entry?.refs?.find((r) => r.field === `${path}/${key}`);
    return (ref?.members ?? []).map((m) => ({ kind: m.probe.kind as "edge" | "face", part: feature.part, key: m.key, point: m.probe.point as unknown as readonly [number, number, number], label: m.name, refMember: true as const }));
  }
  if (v["line"] && typeof v["line"] === "object") {
    const d = (v["line"] as { direction?: unknown }).direction;
    if (Array.isArray(d)) {
      const axis = Object.entries(AXES).find(([, a]) => Math.abs(Math.abs(a[0] * Number(d[0]) + a[1] * Number(d[1]) + a[2] * Number(d[2])) - 1) < 1e-9);
      if (axis) return [originItem(axis[0])];
    }
  }
  return [];
}

function sameItems(a: readonly SelectionItem[], b: readonly SelectionItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Built {
  json: Json;
  set: Json;
  seedItems: readonly SelectionItem[];
}

function patternPanel(layout: Layout, ctx: ToolContext, existing: FeatureInfo | null): PanelSpec {
  const services = ctx.services;
  const refs = new RefCache(services);
  const j = existing?.json ?? {};
  const oldSeed = (j["seed"] ?? {}) as Json;
  const oldLayout = ((j["layout"] ?? {}) as Json)[layout] as Json | undefined;
  const seedKind: "features" | "bodies" = existing ? (oldSeed["bodies"] ? "bodies" : "features") : ctx.selection.items().some((i) => i.kind === "body") ? "bodies" : "features";
  const title = layout === "linear" ? "Linear Pattern" : layout === "circular" ? "Circular Pattern" : "Mirror";
  const initialBodies: SelectionItem[] = (() => {
    if (!existing || !oldSeed["bodies"]) return [];
    const report = services.doc.getState().report as unknown as metricsV1.EvalReport | null;
    const ref = report?.features?.find((f) => f.feature_id === existing.id)?.refs?.find((r) => r.field === "/seed/bodies");
    return (ref?.members ?? []).map((m) => ({ kind: "body" as const, part: existing.part, body: m.key, label: m.name, refMember: true as const }));
  })();
  const initialFeatures: SelectionItem[] = Array.isArray(oldSeed["features"])
    ? (oldSeed["features"] as string[]).map((id) => ({ kind: "feature" as const, feature: id, label: docFeatures(services).find((f) => f.id === id)?.name ?? id }))
    : [];
  const dirKey = layout === "linear" ? "dir" : layout === "circular" ? "axis" : "plane";
  const initialDir = existing && oldLayout ? refValueItems(services, existing, oldLayout[dirKey], `/layout/${layout}/${dirKey}`) : [originItem(layout === "linear" ? "X" : layout === "circular" ? "Z" : "YZ")];
  const initialDir2 = existing && oldLayout?.["dir2"] !== undefined ? refValueItems(services, existing, oldLayout["dir2"], `/layout/linear/dir2`) : [originItem("Y")];
  const flipped = (v: unknown): boolean => (typeof v === "string" ? v.startsWith("-") : !!(v && typeof v === "object" && (v as Json)["flip"] === true));
  let part = existing?.part ?? partOf(services, ctx.selection.items());
  const pidFor = (): string => existing?.id ?? previewId(v1Document(services)?.document ?? "{}", "pattern");

  /** A direction (linear), an axis (circular) or a plane (mirror) from its picked item. */
  const directionOf = async (items: readonly SelectionItem[], field: string, flip: boolean, initial: readonly SelectionItem[], old: unknown): Promise<unknown> => {
    if (existing && sameItems(items, initial) && flip === flipped(old)) return old;
    const it = items[0];
    const o = originId(it);
    if (layout === "mirror") {
      if (o && PLANES.has(o)) return o;
      const d = datumId(services, it);
      if (d) return { datum: d };
      if (it?.kind === "face") return { face: (await refs.get({ kind: "face", picks: picksOf(services, [it]), card: "one" }, existing ? { feature: existing.id } : { part })).ref };
      throw Object.assign(new Error("Pick a plane: an origin plane, a planar face or a datum plane."), { code: "BAD_PICK" });
    }
    let v: unknown;
    if (o && AXES[o]) v = layout === "linear" ? (flip ? `-${o}` : o) : flip ? { line: { origin: [0, 0, 0], direction: scale(AXES[o]!, -1) } } : o;
    else if (datumId(services, it)) v = { datum: datumId(services, it), ...(flip ? { flip: true } : {}) };
    else if (it?.kind === "edge") v = { edge: (await refs.get({ kind: "edge", picks: picksOf(services, [it]), card: "one" }, existing ? { feature: existing.id } : { part })).ref, ...(flip ? { flip: true } : {}) };
    else if (it?.kind === "face" && layout === "circular") v = { cylinder: (await refs.get({ kind: "face", picks: picksOf(services, [it]), card: "one" }, existing ? { feature: existing.id } : { part })).ref, ...(flip ? { flip: true } : {}) };
    else throw Object.assign(new Error(layout === "linear" ? "Pick a direction: an origin axis, a straight edge or a datum axis." : "Pick an axis: an origin axis, a circular or straight edge, a cylindrical face or a datum axis."), { code: "BAD_PICK" });
    void field;
    return v;
  };

  const build = async (values: PanelValues, id: string): Promise<Built | { errors: FieldError[] }> => {
    const kind = String(values["seedKind"]) as "features" | "bodies";
    const seedItems = (values[kind === "features" ? "features" : "bodies"] as readonly SelectionItem[]) ?? [];
    part = existing?.part ?? partOf(services, seedItems);
    let seed: Json;
    if (kind === "features") {
      if (existing && sameItems(seedItems, initialFeatures) && oldSeed["features"]) seed = { features: oldSeed["features"] };
      else {
        const { ids, bad } = seedFeatures(services, seedItems);
        if (bad.length) return { errors: [{ field: "features", code: "PATTERN_SEED_UNSUPPORTED", message: `Only extrudes, revolves and holes repeat as features (${bad.join(", ")}): pattern the body instead.` }] };
        if (!ids.length) return { errors: [{ field: "features", code: "REQUIRED", message: "Pick the features to repeat (timeline, or a face they made)." }] };
        const all = docFeatures(services);
        part = all.find((f) => f.id === ids[0])?.part ?? part;
        seed = { features: ids };
      }
    } else {
      try {
        if (existing && sameItems(seedItems, initialBodies) && oldSeed["bodies"]) seed = { bodies: oldSeed["bodies"] };
        else {
          const picks = picksOf(services, seedItems);
          if (picks.length < seedItems.length) return { errors: [{ field: "bodies", code: "COMMAND_PICK_NOT_FOUND", message: "A picked body is not in the current model; pick it again." }] };
          seed = { bodies: (await refs.get({ kind: "body", picks }, existing ? { feature: existing.id } : { part })).ref };
        }
      } catch (e) {
        return { errors: [refError(e, "bodies")] };
      }
    }
    let lay: Json;
    try {
      if (layout === "linear") {
        const count = num(values, "count");
        const spacing = num(values, "spacing");
        if (count === null) return { errors: [{ field: "count", code: "REQUIRED", message: "Enter the count." }] };
        if (spacing === null) return { errors: [{ field: "spacing", code: "REQUIRED", message: "Enter the spacing." }] };
        lay = { dir: await directionOf(values["direction"] as readonly SelectionItem[], "direction", values["flip"] === true, initialDir, oldLayout?.["dir"]), count, spacing };
        if (values["second"] === true) {
          const count2 = num(values, "count2");
          const spacing2 = num(values, "spacing2");
          if (count2 === null) return { errors: [{ field: "count2", code: "REQUIRED", message: "Enter the second count." }] };
          if (spacing2 === null) return { errors: [{ field: "spacing2", code: "REQUIRED", message: "Enter the second spacing." }] };
          try {
            lay["dir2"] = await directionOf(values["direction2"] as readonly SelectionItem[], "direction2", values["flip2"] === true, initialDir2, oldLayout?.["dir2"]);
          } catch (e) {
            return { errors: [pickError(e, "direction2")] };
          }
          lay["count2"] = count2;
          lay["spacing2"] = spacing2;
        }
      } else if (layout === "circular") {
        const count = num(values, "count");
        const angle = num(values, "angle");
        if (count === null) return { errors: [{ field: "count", code: "REQUIRED", message: "Enter the count." }] };
        if (angle === null) return { errors: [{ field: "angle", code: "REQUIRED", message: "Enter the angle." }] };
        lay = { axis: await directionOf(values["axis"] as readonly SelectionItem[], "axis", values["flip"] === true, initialDir, oldLayout?.["axis"]), count };
        if (angle !== 360) lay["angle"] = angle;
      } else {
        lay = { plane: await directionOf(values["plane"] as readonly SelectionItem[], "plane", false, initialDir, oldLayout?.["plane"]) };
      }
    } catch (e) {
      return { errors: [pickError(e, layout === "linear" ? "direction" : layout === "circular" ? "axis" : "plane")] };
    }
    const json: Json = { type: "pattern", id, name: id, seed, layout: { [layout]: lay } };
    if (kind === "bodies" && values["result"] === "join") {
      json["op"] = "join";
      json["targets"] = "all";
    }
    const set: Json = {};
    for (const k of ["seed", "layout", "op", "targets"]) {
      const next = json[k];
      if (next === undefined) {
        if (j[k] !== undefined) set[k] = null;
      } else if (JSON.stringify(next) !== JSON.stringify(j[k])) set[k] = next;
    }
    return { json, set, seedItems };
  };

  const map: ErrorMapper = (e, refField) => {
    const seedField = String(e.details["seed"] ?? "") === "bodies" ? "bodies" : "features";
    if (e.code === "PATTERN_SEED_UNSUPPORTED" || e.code === "UNRESOLVED_FEATURE") return { field: "features" };
    if (e.code === "INVALID_COUNT") return { field: refField?.includes("2") ? "count2" : "count" };
    if (e.code === "INVALID_ANGLE") return { field: "angle" };
    if (e.code === "INVALID_VALUE" && layout === "linear") return { field: "spacing" };
    if (e.code === "AXIS_REF_UNSUPPORTED") return { field: layout === "linear" ? "direction" : "axis" };
    if (e.code === "PLANE_NOT_PLANAR") return { field: "plane" };
    if (refField?.startsWith("/seed")) return { field: "bodies" };
    if (refField?.startsWith("/layout")) return { field: layout === "linear" ? (refField.includes("dir2") ? "direction2" : "direction") : layout === "circular" ? "axis" : "plane" };
    void seedField;
    return null;
  };

  const directionVector = (items: readonly SelectionItem[], flip: boolean): Vec3 | null => {
    const it = items[0];
    const o = originId(it);
    let v: Vec3 | null = o && AXES[o] ? AXES[o]! : it?.kind === "edge" ? edgeDirection(services, it) : null;
    if (!v) return null;
    if (it?.kind === "edge") v = signCanonical(v);
    return flip ? scale(v, -1) : v;
  };

  const seedFields: PanelSpec["fields"] = [
    {
      key: "seedKind",
      label: "Repeat",
      kind: "choice",
      options: [
        { value: "features", label: "Features", hint: "Repeat extrudes, revolves and holes: each copy cuts or joins like the original" },
        { value: "bodies", label: "Bodies", hint: "Copy whole bodies (after fillets and shells too)" },
      ],
      default: "features",
    },
    { key: "features", label: "Features", kind: "selection", accepts: ["feature", "face"], min: 1, hint: "Click features in the timeline, or a face they made.", visibleWhen: (v) => v["seedKind"] === "features" },
    { key: "bodies", label: "Bodies", kind: "selection", accepts: ["body"], min: 1, hint: "Click the bodies to copy.", visibleWhen: (v) => v["seedKind"] === "bodies" },
  ];
  const resultField: PanelSpec["fields"][number] = {
    key: "result",
    label: "Result",
    kind: "choice",
    options: [
      { value: "new_body", label: "New bodies" },
      { value: "join", label: "Join" },
    ],
    default: "new_body",
    visibleWhen: (v) => v["seedKind"] === "bodies",
  };
  const layoutFields: PanelSpec["fields"] =
    layout === "linear"
      ? [
          { key: "direction", label: "Direction", kind: "selection", accepts: ["origin", "edge", "datum"], min: 1, max: 1, fromSelection: false, hint: "An origin axis, a straight edge or a datum axis." },
          { key: "flip", label: "Flip direction", kind: "toggle", default: false },
          { key: "count", label: "Count", kind: "number", quantity: "count", min: 1, step: 1, default: "3", hint: "Including the original" },
          { key: "spacing", label: "Spacing", kind: "number", quantity: "length", step: 1, default: "10 mm" },
          { key: "second", label: "Second direction", kind: "toggle", default: false },
          { key: "direction2", label: "Direction 2", kind: "selection", accepts: ["origin", "edge", "datum"], min: 1, max: 1, fromSelection: false, visibleWhen: (v) => v["second"] === true },
          { key: "flip2", label: "Flip direction 2", kind: "toggle", default: false, visibleWhen: (v) => v["second"] === true },
          { key: "count2", label: "Count 2", kind: "number", quantity: "count", min: 1, step: 1, default: "2", visibleWhen: (v) => v["second"] === true },
          { key: "spacing2", label: "Spacing 2", kind: "number", quantity: "length", step: 1, default: "10 mm", visibleWhen: (v) => v["second"] === true },
        ]
      : layout === "circular"
        ? [
            { key: "axis", label: "Axis", kind: "selection", accepts: ["origin", "edge", "face", "datum"], min: 1, max: 1, fromSelection: false, hint: "An origin axis, a circular or straight edge, a cylindrical face, or a datum axis." },
            { key: "count", label: "Count", kind: "number", quantity: "count", min: 2, step: 1, default: "6", hint: "Including the original" },
            { key: "angle", label: "Total angle", kind: "number", quantity: "angle", min: 0, max: 360, minExclusive: true, step: 15, default: "360°", hint: "360°: evenly around; less: from the original to the last copy" },
            { key: "flip", label: "Reverse", kind: "toggle", default: false, visibleWhen: (v) => (v["angle"] as NumberValue | undefined)?.value !== 360 },
          ]
        : [{ key: "plane", label: "Mirror plane", kind: "selection", accepts: ["origin", "face", "datum"], min: 1, max: 1, fromSelection: false, hint: "An origin plane, a planar face or a datum plane." }];

  const initial: Record<string, unknown> = { seedKind, direction: initialDir, axis: initialDir, plane: initialDir };
  if (layout !== "linear") delete initial["direction"];
  if (layout !== "circular") delete initial["axis"];
  if (layout !== "mirror") delete initial["plane"];
  if (existing) {
    initial["features"] = initialFeatures;
    initial["bodies"] = initialBodies;
    if (j["op"] === "join") initial["result"] = "join";
    if (layout === "linear" && oldLayout) {
      initial["flip"] = flipped(oldLayout["dir"]);
      initial["count"] = scalarText(oldLayout["count"], "3");
      initial["spacing"] = scalarText(oldLayout["spacing"], "10");
      if (oldLayout["dir2"] !== undefined) {
        initial["second"] = true;
        initial["direction2"] = initialDir2;
        initial["flip2"] = flipped(oldLayout["dir2"]);
        initial["count2"] = scalarText(oldLayout["count2"] ?? 1, "1");
        initial["spacing2"] = scalarText(oldLayout["spacing2"], "10");
      }
    }
    if (layout === "circular" && oldLayout) {
      initial["flip"] = flipped(oldLayout["axis"]);
      initial["count"] = scalarText(oldLayout["count"], "6");
      initial["angle"] = scalarText(oldLayout["angle"] ?? 360, "360");
    }
  } else if (layout === "linear") initial["direction2"] = initialDir2;
  // Seeds from the selection when the tool starts: bodies go to Bodies, features and faces to Features.
  if (!existing) {
    const sel = ctx.selection.items();
    initial["features"] = sel.filter((i) => i.kind === "feature" || i.kind === "face");
    initial["bodies"] = sel.filter((i) => i.kind === "body");
  }

  return {
    title: existing ? `Edit ${existing.name ?? existing.id}` : title,
    icon: layout === "linear" ? "linearPattern" : layout === "circular" ? "circularPattern" : "mirror",
    description:
      layout === "linear"
        ? "Repeats features or bodies along one or two directions"
        : layout === "circular"
          ? "Repeats features or bodies around an axis"
          : "Mirrors features or bodies across a plane",
    fields: [...seedFields, ...layoutFields, resultField],
    initial: initial as NonNullable<PanelSpec["initial"]>,
    apply: !existing,
    preview: async (values, io): Promise<PreviewOutcome> => {
      const v = v1Document(services);
      if (!v) return { ok: false, errors: [{ code: "NOT_V1", message: `${title} needs an IR v1 model.` }] };
      const id = pidFor();
      const b = await build(values, id);
      if (io.signal.aborted) return { ok: true };
      if ("errors" in b) return { ok: false, errors: b.errors };
      const text = existing ? withEditedFeature(v.document, v.rollback, existing.id, b.set) : withNewFeature(v.document, v.rollback, part, b.json).text;
      return checkedPreview(services, text, id, io.signal, map, (entry, report) => {
        const rows: SummaryRow[] = [];
        if (entry.pattern) {
          const skipped = entry.pattern.skipped?.length ?? 0;
          rows.push({ label: "Copies", value: `${entry.pattern.instances}${skipped ? ` (${skipped} skipped: they meet nothing)` : ""}`, tone: skipped ? "warn" : "ok" });
        }
        const vr = volumeRow(services, report);
        if (vr) rows.push(vr);
        return rows;
      });
    },
    toOps: async (values): Promise<IrOp[]> => {
      const b = await build(values, pidFor());
      if ("errors" in b) throw new Error(b.errors[0]?.message ?? "The inputs do not check");
      if (existing) return Object.keys(b.set).length ? [{ op: "updateFeature", feature: existing.id, set: b.set }] : [];
      const { id: _id, name: _name, ...feature } = b.json;
      return [{ op: "addFeature", part, feature: feature as { type: string } & Json }];
    },
    label: () => (existing ? `Edit ${existing.name ?? existing.id}` : title),
    handles: (values): PanelHandle[] => {
      const kind = String(values["seedKind"]);
      const seeds = (values[kind === "bodies" ? "bodies" : "features"] as readonly SelectionItem[]) ?? [];
      const centre = centreOf(services, seeds);
      if (!centre) return [];
      if (layout === "linear") {
        const d = directionVector(values["direction"] as readonly SelectionItem[], values["flip"] === true);
        return d ? [{ field: "spacing", kind: "linear", origin: centre, axis: d, step: 1, fineStep: 0.5, label: "Spacing" }] : [];
      }
      if (layout === "circular") {
        const it = (values["axis"] as readonly SelectionItem[])[0];
        const o = originId(it);
        if (!o || !AXES[o]) return [];
        const a: Vec3 = values["flip"] === true ? scale(AXES[o]!, -1) : AXES[o]!;
        const along = centre[0] * a[0] + centre[1] * a[1] + centre[2] * a[2];
        const c: Vec3 = scale(a, along);
        const r = sub(centre, c);
        if (len(r) < 1e-6) return [];
        return [{ field: "angle", kind: "rotate", origin: c, axis: a, ref: unit(r), min: 1, max: 360, step: 15, fineStep: 1, size: len(r), label: "Total angle" }];
      }
      void add;
      return [];
    },
  };
}

function pickError(e: unknown, field: string): FieldError {
  const code = (e as { code?: unknown })?.code;
  if (code === "BAD_PICK") return { field, code: "BAD_PICK", message: (e as Error).message };
  return refError(e, field);
}

export const linearPatternTool: ToolDefinition = {
  id: "pattern.linear",
  label: "Linear Pattern",
  group: "pattern",
  icon: "linearPattern",
  order: 10,
  description: "Repeat features or bodies along a direction (and a second one)",
  accepts: ["feature", "face", "body"],
  // Re-edits every pattern: the panel of its layout.
  features: ["pattern"],
  enabledWhen: needsSeedSource("Linear pattern"),
  activate: (ctx) => patternPanel("linear", ctx, null),
  fromFeature: (feature, ctx) => {
    const layout = Object.keys((feature.json["layout"] ?? {}) as Json)[0];
    return patternPanel(layout === "circular" ? "circular" : layout === "mirror" ? "mirror" : "linear", ctx, feature);
  },
};

export const circularPatternTool: ToolDefinition = {
  id: "pattern.circular",
  label: "Circular Pattern",
  group: "pattern",
  icon: "circularPattern",
  order: 20,
  description: "Repeat features or bodies around an axis",
  accepts: ["feature", "face", "body"],
  enabledWhen: needsSeedSource("Circular pattern"),
  activate: (ctx) => patternPanel("circular", ctx, null),
};

export const mirrorTool: ToolDefinition = {
  id: "pattern.mirror",
  label: "Mirror",
  group: "pattern",
  icon: "mirror",
  order: 30,
  description: "Mirror features or bodies across a plane",
  accepts: ["feature", "face", "body"],
  enabledWhen: needsSeedSource("Mirror"),
  activate: (ctx) => patternPanel("mirror", ctx, null),
};

export function registerPatternTools(registry: ToolRegistry): () => void {
  const offs = [linearPatternTool, circularPatternTool, mirrorTool].map((t) => registry.register(t));
  return () => {
    for (const off of offs) off();
  };
}
