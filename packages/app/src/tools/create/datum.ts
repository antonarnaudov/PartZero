/**
 * Construct: Plane (offset from a plane or face with a drag arrow, at an angle about an axis, midway
 * between two planes, through three points) and Axis (along an edge, through a cylinder, where two
 * planes meet, through two points) — panels over the `datum_plane` and `datum_axis` commands.
 */
import { datumAxisModelingTool, datumPlaneModelingTool, pickOfPlaneRef, type DatumAxisArgs, type DatumPlaneArgs } from "@aicad/model-ops";
import type { AppServices } from "../../services";
import type { FeatureInfo, FieldSpec, PanelHandle, PanelSpec, PanelValues, SelectionItem, SummaryRow, ToolContext, ToolDefinition } from "../framework/types";
import { itemsOf, modelingPanel, numberOf, PanelArgError, pickName, scalarArg, v3, type PreviewInfo } from "./kit";
import { NAME_FIELD } from "./extrude";
import { needsV1 } from "./model";

const is =
  (key: string, ...values: string[]) =>
  (v: PanelValues): boolean =>
    values.includes(String(v[key]));

const AXIS_IDS = new Set(["X", "Y", "Z"]);
const PLANE_IDS = new Set(["XY", "XZ", "YZ"]);

/** A plane-like pick (a face, an origin plane, a datum plane). */
function planePick(it: SelectionItem | undefined, field: string, what: string): string {
  if (!it) throw new PanelArgError(field, what);
  if (it.kind === "origin" && !PLANE_IDS.has(it.feature)) throw new PanelArgError(field, `${it.label ?? it.feature} is an axis; pick a plane or a planar face.`, "NOT_A_PLANE");
  return pickName(it);
}

/** An axis-like pick (an edge, an origin axis, a datum axis, a cylindrical face). */
function axisPick(it: SelectionItem | undefined, field: string): string {
  if (!it) throw new PanelArgError(field, "Pick the axis to rotate about: an edge, X/Y/Z or a datum axis.");
  if (it.kind === "origin" && !AXIS_IDS.has(it.feature)) throw new PanelArgError(field, `${it.label ?? it.feature} is a plane; pick an axis.`, "NOT_AN_AXIS");
  return pickName(it);
}

/** A point pick: a vertex (associative) or the world point where a face or edge was clicked. */
function pointPick(it: SelectionItem): string | [number, number, number] {
  if (it.kind === "vertex") return it.key;
  if ((it.kind === "face" || it.kind === "edge") && it.point) return [it.point[0], it.point[1], it.point[2]];
  if (it.kind === "origin" && it.feature === "O") return [0, 0, 0];
  throw new PanelArgError("points", "Pick corners (vertices) of the model.", "NOT_A_POINT");
}

// ─── Plane ───────────────────────────────────────────────────────────────────────────────────

function planeFields(edit: boolean): FieldSpec[] {
  return [
    {
      key: "mode",
      label: "Type",
      kind: "choice",
      options: [
        { value: "offset", label: "Offset" },
        { value: "angle", label: "Angle" },
        { value: "midplane", label: "Midplane" },
        { value: "three_points", label: "3 points" },
      ],
      default: "offset",
    },
    { key: "from", label: "Plane", kind: "selection", accepts: ["face", "origin", "datum"], min: edit ? 0 : 1, max: 1, hint: edit ? "Empty: keep the plane it starts from" : "A planar face, XY/XZ/YZ or a datum plane", visibleWhen: is("mode", "offset", "angle") },
    { key: "distance", label: "Offset", kind: "number", quantity: "length", default: "10", visibleWhen: is("mode", "offset") },
    { key: "axis", label: "Axis", kind: "selection", accepts: ["edge", "origin", "datum"], min: edit ? 0 : 1, max: 1, fromSelection: false, hint: "A straight edge, X/Y/Z or a datum axis in the plane", visibleWhen: is("mode", "angle") },
    { key: "angle", label: "Angle", kind: "number", quantity: "angle", default: "45", step: 15, visibleWhen: is("mode", "angle") },
    { key: "planes", label: "Planes", kind: "selection", accepts: ["face", "origin", "datum"], min: edit ? 0 : 2, max: 2, hint: "Two parallel planes or faces", visibleWhen: is("mode", "midplane") },
    { key: "points", label: "Points", kind: "selection", accepts: ["vertex", "face", "edge", "origin"], min: edit ? 0 : 3, max: 3, hint: "Three corners (vertices)", visibleWhen: is("mode", "three_points") },
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function planeArgs(values: PanelValues, feature: string | null): DatumPlaneArgs {
  const mode = String(values["mode"] ?? "offset") as NonNullable<DatumPlaneArgs["mode"]>;
  const out: DatumPlaneArgs = { ...(feature ? { feature } : {}), mode };
  const from = itemsOf(values["from"])[0];
  if (mode === "offset" || mode === "angle") {
    if (from || !feature) out.from = planePick(from, "from", "Pick the plane or planar face to start from.");
  }
  if (mode === "offset") {
    const d = scalarArg(values["distance"]);
    if (d === undefined) throw new PanelArgError("distance", "Enter an offset.");
    out.distance = d;
  } else if (mode === "angle") {
    const axis = itemsOf(values["axis"])[0];
    if (axis || !feature) out.axis = axisPick(axis, "axis");
    const a = scalarArg(values["angle"]);
    if (a === undefined) throw new PanelArgError("angle", "Enter an angle.");
    out.angle = a;
  } else if (mode === "midplane") {
    const planes = itemsOf(values["planes"]);
    if (planes.length === 2) {
      out.a = planePick(planes[0], "planes", "");
      out.b = planePick(planes[1], "planes", "");
    } else if (!feature) throw new PanelArgError("planes", "Pick two parallel planes or faces.");
  } else {
    const pts = itemsOf(values["points"]);
    if (pts.length === 3) out.points = pts.map(pointPick) as DatumPlaneArgs["points"];
    else if (!feature) throw new PanelArgError("points", "Pick three corners.");
  }
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  if (name) out.name = name;
  return out;
}

/** The offset arrow: from the plane it starts from, along its normal (the new plane at its tip). */
function planeHandles(values: PanelValues, info: PreviewInfo | null): PanelHandle[] {
  if (!info) return [];
  const d = info.entry?.datum as { origin?: number[]; normal?: number[] } | undefined;
  if (values["mode"] !== "offset" || !d?.origin || !d.normal) return [];
  const dist = numberOf(values["distance"]);
  if (dist === null) return [];
  const n = v3.unit(d.normal as [number, number, number]);
  const origin = v3.sub(d.origin as [number, number, number], v3.scale(n, dist));
  return [{ id: "distance", field: "distance", kind: "linear", origin, axis: n, value: dist, label: "Offset" }];
}

function datumSummary(info: PreviewInfo): SummaryRow[] {
  const d = info.entry?.datum as { origin?: number[]; normal?: number[]; direction?: number[] } | undefined;
  if (!d?.origin) return [];
  const f = (v: number[]): string => v.map((x) => (Math.abs(x) < 5e-7 ? 0 : x).toFixed(2)).join(", ");
  return [
    { label: "Origin", value: `(${f(d.origin)})` },
    ...(d.normal ? [{ label: "Normal", value: `(${f(d.normal)})` }] : []),
    ...(d.direction ? [{ label: "Direction", value: `(${f(d.direction)})` }] : []),
  ];
}

function planePanel(services: AppServices, feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  return modelingPanel(services, {
    tool: datumPlaneModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Plane",
    icon: "plane",
    description: "A construction plane to sketch on, drill from or mirror about",
    fields: planeFields(feature !== null),
    ...(initial ? { initial } : {}),
    ...(feature ? {} : { apply: true }),
    args: (values) => planeArgs(values, feature?.id ?? null),
    argField: { a: "planes", b: "planes", points: "points" },
    codeField: { PLANE_NOT_PLANAR: "from", PLANE_DEGENERATE: "from", DATUM_DEGENERATE: "mode", MODEL_NOT_A_PLANE: "from", MODEL_NOT_AN_AXIS: "axis", MODEL_UNSUPPORTED_VERTEX: "points" },
    handles: planeHandles,
    summary: (_v, info) => datumSummary(info),
  });
}

function originItem(id: string): SelectionItem {
  return { kind: "origin", feature: id, label: id };
}

export const datumPlaneTool: ToolDefinition = {
  id: "construct.plane",
  label: "Plane",
  group: "construct",
  icon: "plane",
  order: 10,
  description: "Add a construction plane: offset, at an angle, midway, or through three points",
  accepts: ["face", "origin", "datum"],
  features: ["datum_plane"],
  enabledWhen: (ctx) => needsV1(ctx, "Plane") ?? true,
  activate(ctx: ToolContext): PanelSpec {
    const sel = ctx.selection.items();
    const vertices = sel.filter((i) => i.kind === "vertex");
    const planes = sel.filter((i) => i.kind === "face" || i.kind === "datum" || (i.kind === "origin" && PLANE_IDS.has(i.feature)));
    const initial: Record<string, unknown> = {};
    if (vertices.length === 3) initial["mode"] = "three_points";
    else if (planes.length === 2) initial["mode"] = "midplane";
    if (planes.length === 0 && vertices.length === 0) initial["from"] = [originItem("XY")];
    return planePanel(ctx.services, null, initial as PanelSpec["initial"]);
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const a = datumPlaneModelingTool.argsOf!(feature.json as never, null as never);
    const from = pickOfPlaneRef(feature.json["from"]);
    const initial: Record<string, unknown> = { mode: a.mode ?? "offset", name: feature.name ?? feature.id, from: [], planes: [], points: [], axis: [] };
    if (from && PLANE_IDS.has(from)) initial["from"] = [originItem(from)];
    if (a.distance !== undefined) initial["distance"] = String(a.distance);
    if (a.angle !== undefined) initial["angle"] = String(a.angle);
    return planePanel(ctx.services, feature, initial as PanelSpec["initial"]);
  },
};

// ─── Axis ────────────────────────────────────────────────────────────────────────────────────

function axisFields(edit: boolean): FieldSpec[] {
  return [
    {
      key: "mode",
      label: "Type",
      kind: "choice",
      options: [
        { value: "edge", label: "Edge" },
        { value: "cylinder", label: "Cylinder" },
        { value: "planes", label: "Two planes" },
        { value: "points", label: "Two points" },
      ],
      default: "edge",
    },
    { key: "edge", label: "Edge", kind: "selection", accepts: ["edge"], min: edit ? 0 : 1, max: 1, hint: "A straight or circular edge", visibleWhen: is("mode", "edge") },
    { key: "face", label: "Face", kind: "selection", accepts: ["face"], min: edit ? 0 : 1, max: 1, hint: "A cylindrical face (its axis)", visibleWhen: is("mode", "cylinder") },
    { key: "planes", label: "Planes", kind: "selection", accepts: ["face", "origin", "datum"], min: edit ? 0 : 2, max: 2, hint: "Two planes that meet", visibleWhen: is("mode", "planes") },
    { key: "points", label: "Points", kind: "selection", accepts: ["vertex", "face", "edge", "origin"], min: edit ? 0 : 2, max: 2, hint: "Two corners (vertices)", visibleWhen: is("mode", "points") },
    { key: "flip", label: "Flip direction", kind: "toggle", default: false },
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function axisArgs(values: PanelValues, feature: string | null): DatumAxisArgs {
  const mode = String(values["mode"] ?? "edge") as NonNullable<DatumAxisArgs["mode"]>;
  const out: DatumAxisArgs = { ...(feature ? { feature } : {}), mode, flip: values["flip"] === true };
  if (mode === "edge") {
    const e = itemsOf(values["edge"])[0];
    if (e && e.kind === "edge") out.edge = e.key;
    else if (!feature) throw new PanelArgError("edge", "Pick a straight or circular edge.");
  } else if (mode === "cylinder") {
    const f = itemsOf(values["face"])[0];
    if (f && f.kind === "face") out.face = f.key;
    else if (!feature) throw new PanelArgError("face", "Pick a cylindrical face.");
  } else if (mode === "planes") {
    const planes = itemsOf(values["planes"]);
    if (planes.length === 2) {
      out.a = planePick(planes[0], "planes", "");
      out.b = planePick(planes[1], "planes", "");
    } else if (!feature) throw new PanelArgError("planes", "Pick two planes that meet.");
  } else {
    const pts = itemsOf(values["points"]);
    if (pts.length === 2) out.points = pts.map(pointPick) as DatumAxisArgs["points"];
    else if (!feature) throw new PanelArgError("points", "Pick two corners.");
  }
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  if (name) out.name = name;
  return out;
}

function axisPanel(services: AppServices, feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  return modelingPanel(services, {
    tool: datumAxisModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Axis",
    icon: "axis",
    description: "A construction axis to revolve or pattern about",
    fields: axisFields(feature !== null),
    ...(initial ? { initial } : {}),
    ...(feature ? {} : { apply: true }),
    args: (values) => axisArgs(values, feature?.id ?? null),
    argField: { a: "planes", b: "planes" },
    codeField: { AXIS_REF_UNSUPPORTED: "mode", DATUM_DEGENERATE: "mode", MODEL_UNSUPPORTED_EDGE: "edge", MODEL_UNSUPPORTED_FACE: "face" },
    summary: (_v, info) => datumSummary(info),
  });
}

export const datumAxisTool: ToolDefinition = {
  id: "construct.axis",
  label: "Axis",
  group: "construct",
  icon: "axis",
  order: 20,
  description: "Add a construction axis: along an edge, through a cylinder, two planes or two points",
  accepts: ["edge", "face"],
  features: ["datum_axis"],
  enabledWhen: (ctx) => needsV1(ctx, "Axis") ?? true,
  activate(ctx: ToolContext): PanelSpec {
    const sel = ctx.selection.items();
    const initial: Record<string, unknown> = {};
    if (sel.some((i) => i.kind === "edge")) initial["mode"] = "edge";
    else if (sel.filter((i) => i.kind === "vertex").length === 2) initial["mode"] = "points";
    else if (sel.filter((i) => i.kind === "origin" || i.kind === "datum").length === 2) initial["mode"] = "planes";
    else if (sel.some((i) => i.kind === "face")) initial["mode"] = "cylinder";
    return axisPanel(ctx.services, null, initial as PanelSpec["initial"]);
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const a = datumAxisModelingTool.argsOf!(feature.json as never, null as never);
    return axisPanel(ctx.services, feature, { mode: a.mode ?? "edge", flip: a.flip === true, name: feature.name ?? feature.id, edge: [], face: [], planes: [], points: [] });
  },
};
