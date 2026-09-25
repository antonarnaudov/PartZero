/**
 * Move/Copy (M): the panel over the `move_bodies` command (the IR's `transform`, SPEC-v1 §6.13).
 * Pick bodies (click any face of each), then drag the X/Y/Z arrows or type the offsets, and
 * optionally rotate about X, Y, Z or a picked edge / axis with the rotate ring; Copy keeps the
 * originals. Moved bodies keep their identity, so features on their faces follow them.
 */
import { moveModelingTool, type MoveArgs } from "@aicad/model-ops";
import type { RenderBody } from "../../engine/types";
import type { AppServices } from "../../services";
import type { FeatureInfo, FieldSpec, PanelHandle, PanelSpec, PanelValues, SelectionItem, ToolContext, ToolDefinition } from "../framework/types";
import { itemsOf, modelingPanel, numberOf, PanelArgError, pickName, scalarArg, v3 } from "./kit";
import { NAME_FIELD } from "./extrude";
import { bodiesOfItems, bodyNames, needsV1 } from "./model";

type V3 = [number, number, number];

const AXES = [
  { value: "none", label: "No rotation" },
  { value: "X", label: "About X" },
  { value: "Y", label: "About Y" },
  { value: "Z", label: "About Z" },
  { value: "pick", label: "About a picked edge or axis" },
];

function fields(edit: boolean): FieldSpec[] {
  const rotates = (v: PanelValues): boolean => v["axis"] !== "none";
  return [
    { key: "bodies", label: "Bodies", kind: "selection", accepts: ["body", "face"], min: edit ? 0 : 1, hint: edit ? "Empty: keep the bodies it moves" : "Click a face of each body to move" },
    { key: "dx", label: "X", kind: "number", quantity: "length", default: "0" },
    { key: "dy", label: "Y", kind: "number", quantity: "length", default: "0" },
    { key: "dz", label: "Z", kind: "number", quantity: "length", default: "0" },
    { key: "axis", label: "Rotate", kind: "choice", style: "dropdown", options: AXES, default: "none" },
    { key: "pivot", label: "Axis", kind: "selection", accepts: ["edge", "origin", "datum", "face"], min: 0, max: 1, fromSelection: false, hint: "A straight edge, a datum axis or a cylindrical face", visibleWhen: (v) => v["axis"] === "pick" },
    { key: "angle", label: "Angle", kind: "number", quantity: "angle", default: "0", step: 15, visibleWhen: rotates },
    { key: "copy", label: "Copy", kind: "toggle", default: false, hint: "Keep the originals and add moved copies" },
    ...(edit ? [NAME_FIELD] : []),
  ];
}

function args(values: PanelValues, feature: string | null): MoveArgs {
  const bodies = bodiesOfItems(itemsOf(values["bodies"]));
  if (!feature && bodies.length === 0) throw new PanelArgError("bodies", "Pick the bodies to move.");
  const d = ["dx", "dy", "dz"].map((k) => scalarArg(values[k]));
  if (d.some((x) => x === undefined)) throw new PanelArgError(["dx", "dy", "dz"][d.findIndex((x) => x === undefined)]!, "Enter a distance.");
  const axis = String(values["axis"] ?? "none");
  const out: MoveArgs = { ...(feature ? { feature } : {}), ...(bodies.length ? { bodies } : {}), translate: d as [number | string, number | string, number | string], copy: values["copy"] === true };
  if (axis !== "none") {
    const angle = scalarArg(values["angle"]);
    if (angle === undefined) throw new PanelArgError("angle", "Enter an angle.");
    const it = itemsOf(values["pivot"])[0];
    if (axis === "pick" && !it && feature) out.rotate_angle = angle; // keep the axis it has
    else {
      if (axis === "pick" && !it) throw new PanelArgError("pivot", "Pick the axis to rotate about.");
      out.rotate = { axis: axis === "pick" ? pickName(it!) : axis, angle };
    }
  } else if (feature) out.no_rotation = true;
  // Nothing to move yet: a prompt on the first field, not an error (the arrows are already there).
  if (!feature && axis === "none" && d.every((x) => x === 0)) throw new PanelArgError("dx", "Drag an arrow, or type a distance or a rotation.", "REQUIRED");
  const name = typeof values["name"] === "string" && values["name"] !== "" ? values["name"] : undefined;
  if (name) out.name = name;
  return out;
}

/** The centre of the bounding box of the named render bodies (the displayed model). */
function centreOf(bodies: readonly RenderBody[], names: readonly string[]): V3 | null {
  let lo: V3 = [Infinity, Infinity, Infinity];
  let hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    if (!names.includes(b.name)) continue;
    for (let i = 0; i < b.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k]!, b.positions[i + k]!);
        hi[k] = Math.max(hi[k]!, b.positions[i + k]!);
      }
    }
  }
  if (!Number.isFinite(lo[0])) return null;
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

const UNIT: Record<string, V3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

/** The X/Y/Z arrows at the bodies' centre, and the rotate ring about an origin axis. */
function handles(services: AppServices, values: PanelValues, items: () => readonly SelectionItem[]): PanelHandle[] {
  const names = bodiesOfItems(items().length ? items() : itemsOf(values["bodies"]));
  const c = centreOf(services.doc.getState().bodies, names);
  if (!c) return [];
  const out: PanelHandle[] = [];
  for (const [key, axis, label] of [
    ["dx", UNIT["X"]!, "X"],
    ["dy", UNIT["Y"]!, "Y"],
    ["dz", UNIT["Z"]!, "Z"],
  ] as const) {
    const v = numberOf(values[key]);
    if (v !== null) out.push({ id: key, field: key, kind: "linear", origin: c, axis, value: v, label });
  }
  const axis = String(values["axis"] ?? "none");
  const angle = numberOf(values["angle"]);
  const dir = UNIT[axis];
  if (dir && angle !== null) {
    // The ring sits on the axis line (through the origin), level with the bodies' centre.
    const centre = v3.scale(dir, v3.dot(c, dir));
    let ref = v3.sub(c, centre);
    if (v3.norm(ref) < 1e-6) ref = axis === "Z" ? [1, 0, 0] : [0, 0, 1];
    out.push({ id: "angle", field: "angle", kind: "rotate", origin: centre, axis: dir, ref: v3.unit(ref), value: angle, min: -360, max: 360, label: "Angle" });
  }
  return out;
}

function panel(services: AppServices, feature: FeatureInfo | null, initial: PanelSpec["initial"]): PanelSpec {
  let picked: readonly SelectionItem[] = [];
  const spec = modelingPanel(services, {
    tool: moveModelingTool,
    title: feature ? `Edit ${feature.name ?? feature.id}` : "Move/Copy",
    icon: "move",
    description: "Moves or copies bodies: a rotation, then a translation",
    fields: fields(feature !== null),
    ...(initial ? { initial } : {}),
    args: (values) => {
      picked = itemsOf(values["bodies"]);
      return args(values, feature?.id ?? null);
    },
    cut: "marker",
    argField: { translate: "dx", rotate: "axis" },
    codeField: { INVALID_ANGLE: "angle", AXIS_REF_UNSUPPORTED: "pivot", MODEL_NOT_AN_AXIS: "pivot", MODEL_UNKNOWN_BODY: "bodies" },
    handles: (values) => handles(services, values, () => picked),
    summary: (_v, info) => {
      const n = info.entry?.bodies?.length ?? 0;
      const created = info.entry?.bodies?.filter((b) => b.change === "created").length ?? 0;
      return [{ label: created ? "Copies" : "Moved", value: `${created || n} bod${(created || n) === 1 ? "y" : "ies"}` }];
    },
  });
  return spec;
}

export const moveTool: ToolDefinition = {
  id: "feature.move",
  label: "Move/Copy",
  group: "modify",
  icon: "move",
  shortcut: "M",
  order: 50,
  description: "Move, rotate or copy bodies with arrows and a rotate ring, or typed values",
  accepts: ["body", "face"],
  features: ["transform"],
  enabledWhen(ctx) {
    const v1 = needsV1(ctx, "Move/Copy");
    if (v1) return v1;
    return bodyNames(ctx.services).length > 0 ? true : { reason: "Make a body first (Extrude, E)." };
  },
  activate(ctx: ToolContext): PanelSpec {
    return panel(ctx.services, null, undefined);
  },
  fromFeature(feature: FeatureInfo, ctx: ToolContext): PanelSpec {
    const a = moveModelingTool.argsOf!(feature.json as never, null as never);
    const t = a.translate ?? [0, 0, 0];
    const r = feature.json["rotate"] as { axis?: unknown } | undefined;
    const axis = r === undefined ? "none" : typeof r.axis === "string" && ["X", "Y", "Z"].includes(r.axis) ? r.axis : "pick";
    return panel(ctx.services, feature, {
      bodies: [],
      dx: String(t[0]),
      dy: String(t[1]),
      dz: String(t[2]),
      axis,
      ...(a.rotate ? { angle: String(a.rotate.angle) } : r && (r as { angle?: unknown }).angle !== undefined ? { angle: String((r as { angle: unknown }).angle) } : {}),
      copy: a.copy === true,
      name: feature.name ?? feature.id,
    });
  },
};
