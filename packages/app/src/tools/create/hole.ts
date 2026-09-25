/**
 * Hole (H): the panel over the `hole` command. Pick a planar face (the click places the hole where
 * you clicked), or type positions, use a sketch's points, a grid or a bolt circle; simple,
 * counterbored, countersunk or heat-set insert; M2–M8 from the verified ISO table with a fit, or a
 * custom diameter; threaded (cosmetic); through or blind with a depth arrow.
 */
import { HOLE_SIZES, holeModelingTool, type HoleArgs } from "@aicad/model-ops";
import type { AppServices } from "../../services";
import type { FeatureInfo, FieldSpec, PanelHandle, PanelSpec, PanelValues, SummaryRow, ToolContext, ToolDefinition } from "../framework/types";
import { itemsOf, modelingPanel, numberOf, PanelArgError, scalarArg, v3, type PreviewInfo } from "./kit";
import { NAME_FIELD } from "./extrude";
import { bodyNames, faceItemOf, needsV1, sketchesOf, type ModelFeature } from "./model";

const PLACEMENTS = [
  { value: "click", label: "Where I clicked", hint: "The point you clicked on the face" },
  { value: "uv", label: "Position (u, v)", hint: "Typed coordinates in the face's plane" },
  { value: "sketch", label: "Sketch points", hint: "Every point of a sketch" },
  { value: "grid", label: "Grid", hint: "nx × ny holes" },
  { value: "circle", label: "Bolt circle", hint: "n holes on a circle" },
];

const KINDS = [
  { value: "simple", label: "Simple" },
  { value: "counterbore", label: "Counterbore" },
  { value: "countersink", label: "Countersink" },
  { value: "insert", label: "Insert", hint: "Heat-set insert (standard bore and depth)" },
];

const SIZES = [...HOLE_SIZES.map((s) => ({ value: s, label: s })), { value: "custom", label: "Custom diameter" }];

const is =
  (key: string, ...values: string[]) =>
  (v: PanelValues): boolean =>
    values.includes(String(v[key]));

function fields(sketches: readonly ModelFeature[], edit: boolean): FieldSpec[] {
  const notInsert = (v: PanelValues): boolean => v["kind"] !== "insert";
  return [
    { key: "face", label: "Face", kind: "selection", accepts: ["face"], min: edit ? 0 : 1, max: 1, hint: edit ? "Empty: keep the face it is on" : "The planar face to drill into" },
    { key: "placement", label: "Place", kind: "choice", style: "dropdown", options: PLACEMENTS, default: "click" },
    { key: "u", label: "U", kind: "number", quantity: "length", default: "0", visibleWhen: is("placement", "uv") },
    { key: "v", label: "V", kind: "number", quantity: "length", default: "0", visibleWhen: is("placement", "uv") },
    {
      key: "sketch",
      label: "Sketch",
      kind: "choice",
      style: "dropdown",
      options: sketches.length ? sketches.map((s) => ({ value: s.id, label: s.name })) : [{ value: "", label: "(no sketch)" }],
      visibleWhen: is("placement", "sketch"),
    },
    { key: "nx", label: "Columns", kind: "number", quantity: "count", min: 1, default: "2", visibleWhen: is("placement", "grid") },
    { key: "ny", label: "Rows", kind: "number", quantity: "count", min: 1, default: "2", visibleWhen: is("placement", "grid") },
    { key: "dx", label: "Pitch X", kind: "number", quantity: "length", default: "20", visibleWhen: is("placement", "grid") },
    { key: "dy", label: "Pitch Y", kind: "number", quantity: "length", default: "20", visibleWhen: is("placement", "grid") },
    { key: "count", label: "Holes", kind: "number", quantity: "count", min: 1, default: "4", visibleWhen: is("placement", "circle") },
    { key: "circle", label: "Circle ⌀", kind: "number", quantity: "length", min: 0, minExclusive: true, default: "30", visibleWhen: is("placement", "circle") },
    { key: "start", label: "Start angle", kind: "number", quantity: "angle", default: "0", visibleWhen: is("placement", "circle") },
    { key: "cu", label: "Centre U", kind: "number", quantity: "length", default: "0", visibleWhen: is("placement", "grid", "circle") },
    { key: "cv", label: "Centre V", kind: "number", quantity: "length", default: "0", visibleWhen: is("placement", "grid", "circle") },
    { key: "kind", label: "Type", kind: "choice", style: "dropdown", options: KINDS, default: "simple" },
    { key: "size", label: "Size", kind: "choice", style: "dropdown", options: SIZES, default: "M3", hint: "ISO metric screws (clearance from ISO 273)" },
    { key: "diameter", label: "Diameter", kind: "number", quantity: "length", min: 0, minExclusive: true, default: "3", visibleWhen: is("size", "custom") },
    {
      key: "fit",
      label: "Fit",
      kind: "choice",
      options: [
        { value: "close", label: "Close" },
        { value: "normal", label: "Normal" },
        { value: "loose", label: "Loose" },
      ],
      default: "normal",
      visibleWhen: (v) => v["threaded"] !== true && v["size"] !== "custom" && v["kind"] !== "insert",
    },
    { key: "threaded", label: "Threaded", kind: "toggle", default: false, hint: "Cosmetic thread: tap-drill diameter", visibleWhen: notInsert },
    {
      key: "extent",
      label: "Depth",
      kind: "choice",
      options: [
        { value: "through", label: "Through all" },
        { value: "blind", label: "Blind" },
      ],
      default: "through",
      visibleWhen: notInsert,
    },
    { key: "depth", label: "Depth", kind: "number", quantity: "length", min: 0, minExclusive: true, default: "6", visibleWhen: (v) => v["extent"] === "blind" && v["kind"] !== "insert" },
    {
      key: "tip",
      label: "Bottom",
      kind: "choice",
      options: [
        { value: "118", label: "Drill point 118°" },
        { value: "flat", label: "Flat" },
      ],
      default: "118",
      visibleWhen: (v) => v["extent"] === "blind" && v["kind"] !== "insert",
    },
    { key: "flip", label: "Flip direction", kind: "toggle", default: false },
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function args(values: PanelValues, feature: string | null, keepPlacement: boolean): HoleArgs {
  const face = itemsOf(values["face"])[0];
  const out: HoleArgs = feature ? { feature } : {};
  if (face && face.kind === "face") out.face = face.key;
  else if (!feature) throw new PanelArgError("face", "Select the planar face to drill into.");
  const placement = String(values["placement"] ?? "click");
  const need = (key: string, what: string): number | string => {
    const v = scalarArg(values[key]);
    if (v === undefined) throw new PanelArgError(key, `Enter ${what}.`);
    return v;
  };
  if (placement === "click") {
    const p = face && face.kind === "face" ? face.point : undefined;
    if (p) out.points = [[p[0], p[1], p[2]]];
    else if (!keepPlacement) throw new PanelArgError("placement", "Click the face where the hole goes, or type its position.", "NO_POINT");
  } else if (placement === "uv") {
    out.at = [{ u: need("u", "U"), v: need("v", "V") }];
  } else if (placement === "sketch") {
    const s = String(values["sketch"] ?? "");
    if (!s) throw new PanelArgError("sketch", "Pick a sketch with points.");
    out.sketch_points = { sketch: s, ids: "all" };
  } else if (placement === "grid") {
    out.grid = { nx: need("nx", "the columns"), ny: need("ny", "the rows"), dx: need("dx", "the pitch"), dy: need("dy", "the pitch"), center: [need("cu", "the centre"), need("cv", "the centre")] };
  } else if (placement === "circle") {
    out.circle = { n: need("count", "the count"), d: need("circle", "the circle diameter"), start: need("start", "the start angle"), center: [need("cu", "the centre"), need("cv", "the centre")] };
  }
  const kind = String(values["kind"] ?? "simple") as HoleArgs["kind"];
  out.kind = kind;
  const size = String(values["size"] ?? "M3");
  if (size === "custom") out.diameter = need("diameter", "a diameter");
  else out.size = size as HoleArgs["size"];
  if (kind !== "insert") {
    out.threaded = values["threaded"] === true;
    if (values["extent"] === "blind") {
      out.depth = need("depth", "a depth");
      out.tip = values["tip"] === "flat" ? "flat" : 118;
    } else out.depth = "through";
  }
  const fit = String(values["fit"] ?? "normal");
  if (!out.threaded && size !== "custom" && kind !== "insert") out.fit = fit as HoleArgs["fit"];
  out.flip = values["flip"] === true;
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  if (name) out.name = name;
  return out;
}

/** The depth arrow of a blind hole, at the first hole, along the drilling direction. */
function handles(values: PanelValues, info: PreviewInfo): PanelHandle[] {
  if (values["extent"] !== "blind" || values["kind"] === "insert") return [];
  const h = info.entry?.holes?.[0];
  const depth = numberOf(values["depth"]);
  if (!h || depth === null) return [];
  return [{ id: "depth", field: "depth", kind: "linear", origin: h.center as [number, number, number], axis: v3.unit(h.axis as [number, number, number]), value: depth, min: 0.1, label: "Depth" }];
}

function summary(_values: PanelValues, info: PreviewInfo): SummaryRow[] {
  const holes = info.entry?.holes ?? [];
  if (holes.length === 0) return [];
  const h = holes[0]!;
  return [
    { label: "Holes", value: String(holes.length) },
    { label: "Diameter", value: `${h.d.toFixed(2)} mm${h.size ? ` (${h.size})` : ""}` },
    { label: "Depth", value: h.depth === null || h.depth === undefined ? "through" : `${Number(h.depth).toFixed(2)} mm` },
  ];
}

function panel(services: AppServices, feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  const sketches = sketchesOf(services);
  return modelingPanel(services, {
    tool: holeModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Hole",
    icon: "hole",
    description: "Drills standard or custom holes into a planar face",
    fields: fields(sketches, feature !== null),
    ...(initial ? { initial } : {}),
    ...(feature ? {} : { apply: true }),
    args: (values) => args(values, feature?.id ?? null, feature !== null),
    argField: { points: "placement", at: "placement", sketch_points: "sketch", grid: "placement", circle: "placement", diameter: "diameter", up_to: "extent", d: "diameter", cbore: "depth", csink: "kind", insert: "kind", thread: "threaded" },
    codeField: {
      HOLE_POINT_OFF_FACE: "placement",
      HOLE_DUPLICATE_POSITION: "placement",
      HOLE_MISSES_BODY: "face",
      HOLE_OPTIONS_CONFLICT: "kind",
      HOLE_SIZE_UNKNOWN: "size",
      PLANE_NOT_PLANAR: "face",
      MODEL_UNSUPPORTED_FACE: "face",
      REF_UNRESOLVED: "face",
    },
    handles,
    summary,
  });
}

export const holeTool: ToolDefinition = {
  id: "feature.hole",
  label: "Hole",
  group: "create",
  icon: "hole",
  shortcut: "H",
  order: 30,
  description: "Drill ISO-sized, counterbored, countersunk, threaded or insert holes into a face",
  accepts: ["face"],
  features: ["hole"],
  enabledWhen(ctx) {
    const v1 = needsV1(ctx, "Hole");
    if (v1) return v1;
    return bodyNames(ctx.services).length > 0 ? true : { reason: "Make a body first (Extrude, E)." };
  },
  activate(ctx: ToolContext): PanelSpec {
    const face = ctx.selection.items().find((i) => i.kind === "face");
    return panel(ctx.services, null, face && face.kind === "face" && !face.point ? { placement: "uv" } : undefined);
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const a = holeModelingTool.argsOf!(feature.json as never, null as never);
    const on = (feature.json["on"] as { face?: unknown } | undefined)?.face;
    const face = on ? faceItemOf(on, ctx.services) : null;
    const initial: Record<string, string | number | boolean | readonly unknown[]> = { name: feature.name ?? feature.id, kind: a.kind ?? "simple", flip: a.flip === true };
    if (face) initial["face"] = [face];
    if (a.at && a.at.length === 1) Object.assign(initial, { placement: "uv", u: String(a.at[0]!.u), v: String(a.at[0]!.v) });
    else if (a.grid) Object.assign(initial, { placement: "grid", nx: String(a.grid.nx), ny: String(a.grid.ny), dx: String(a.grid.dx), dy: String(a.grid.dy), ...(a.grid.center ? { cu: String(a.grid.center[0]), cv: String(a.grid.center[1]) } : {}) });
    else if (a.circle) Object.assign(initial, { placement: "circle", count: String(a.circle.n), circle: String(a.circle.d), ...(a.circle.start !== undefined ? { start: String(a.circle.start) } : {}), ...(a.circle.center ? { cu: String(a.circle.center[0]), cv: String(a.circle.center[1]) } : {}) });
    else if (a.sketch_points) Object.assign(initial, { placement: "sketch", sketch: a.sketch_points.sketch });
    else initial["placement"] = "click";
    if (a.diameter !== undefined && a.size === undefined) Object.assign(initial, { size: "custom", diameter: String(a.diameter) });
    else if (a.size) initial["size"] = a.size;
    if (a.fit && a.fit !== "tap") initial["fit"] = a.fit;
    if (a.threaded) initial["threaded"] = true;
    if (a.depth !== undefined && a.depth !== "through") Object.assign(initial, { extent: "blind", depth: String(a.depth), tip: a.tip === "flat" ? "flat" : "118" });
    return panel(ctx.services, feature, initial as PanelSpec["initial"]);
  },
};
