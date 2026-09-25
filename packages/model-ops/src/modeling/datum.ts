/**
 * Construction geometry (SPEC-v1 §3.3, §3.4): datum planes — offset from a plane or face, at an
 * angle about an axis, midway between two planes, through three points — and datum axes — along a
 * straight or circular edge, through a cylinder, where two planes meet, through two points.
 * Planes and axes are picked as provenance names (`e1/cap:end`, `XY`, `X`, a datum's name); points as
 * vertices (`vertex:{…}` names from the selection) or world points [x, y, z].
 */
import { z } from "zod";
import { singleHoleResolver, tidy } from "./frames.js";
import { argError, axisRef, edgeRef, faceRef, planeRef, vertexQuery, type ReportLike } from "./keys.js";
import { defineModelingTool, docOf, editTarget, featureOps, IdArg, irScalar, partFor, PickArg, ScalarArg, scalarOf, Vec3Arg } from "./tool.js";
import type { DocJson, FeatureJson } from "../doc.js";

const PointArg = z.union([PickArg, Vec3Arg]);

export const DatumPlaneArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this datum plane (id or name) instead of adding one."),
  mode: z.enum(["offset", "angle", "midplane", "three_points"]).optional().describe("offset (default), angle, midplane or three_points."),
  from: PickArg.optional().describe("offset / angle: the plane it starts from: XY, XZ, YZ, a datum plane or a planar face name."),
  distance: ScalarArg.optional().describe("offset: signed distance along the plane's normal (mm)."),
  axis: PickArg.optional().describe("angle: the axis to rotate about (X, Y, Z, a datum axis, a straight edge); it must lie in the plane."),
  angle: ScalarArg.optional().describe("angle: degrees (right-hand rule about the axis)."),
  a: PickArg.optional().describe("midplane: the first plane or face."),
  b: PickArg.optional().describe("midplane: the second plane or face (parallel to the first)."),
  points: z.array(PointArg).length(3).optional().describe("three_points: three vertices (names) or world points [x, y, z]."),
  name: IdArg.optional(),
});
export type DatumPlaneArgs = z.infer<typeof DatumPlaneArgs>;

export const DatumAxisArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this datum axis (id or name) instead of adding one."),
  mode: z.enum(["edge", "cylinder", "planes", "points"]).optional().describe("edge (a straight or circular edge), cylinder (a cylindrical face's axis), planes (where two planes meet), points (through two points)."),
  edge: PickArg.optional(),
  face: PickArg.optional(),
  a: PickArg.optional(),
  b: PickArg.optional(),
  points: z.array(PointArg).length(2).optional(),
  flip: z.boolean().optional().describe("Reverse the axis direction."),
  name: IdArg.optional(),
});
export type DatumAxisArgs = z.infer<typeof DatumAxisArgs>;

/** A PointRef: a vertex reference, or a literal point. */
function pointRef(doc: DocJson, p: string | readonly number[], field: string, report: ReportLike | null): unknown {
  if (Array.isArray(p)) return p.map((x) => tidy(x as number, 6));
  const q = vertexQuery(doc, p as string, singleHoleResolver(report));
  if (!q) throw argError(field, `${String(p)} is not a vertex a tool can reference (pick a corner where two named edges meet, or give [x, y, z])`, "MODEL_UNSUPPORTED_VERTEX", { pick: p });
  return { vertex: { kind: "vertex", q, card: "one" } };
}

function need<T>(v: T | undefined, field: string, what: string): T {
  if (v === undefined) throw argError(field, what, "MODEL_MISSING_ARG");
  return v;
}

const PLANE_OWNED = ["mode", "from", "distance", "axis", "angle", "a", "b", "points"] as const;

export const datumPlaneModelingTool = defineModelingTool<DatumPlaneArgs>({
  id: "datum_plane",
  title: "Datum Plane",
  agentTool: "datum_plane",
  featureTypes: ["datum_plane"],
  description:
    'Add a construction plane (the Plane tool) to sketch on, drill from or mirror about. {mode: "offset", from, distance} | {mode: "angle", from, axis, angle} | {mode: "midplane", a, b} | {mode: "three_points", points: [p0, p1, p2]}. Planes are XY/XZ/YZ, datum planes or planar face names; axes X/Y/Z, datum axes or straight edges; points vertex names or [x, y, z]. Edit: {feature, …changed}.',
  args: DatumPlaneArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["datum_plane"]) : null;
    const prevMode = existing ? (existing["mode"] as string) : undefined;
    const mode = args.mode ?? (prevMode === "through" ? "three_points" : (prevMode as DatumPlaneArgs["mode"])) ?? "offset";
    const hole = singleHoleResolver(ctx.report);
    const keep = (k: string): unknown => (existing && (prevMode === mode || (prevMode === "through" && mode === "three_points")) ? existing[k] : undefined);
    const fields: Record<string, unknown> = {};
    switch (mode) {
      case "offset":
        fields["mode"] = "offset";
        fields["from"] = args.from ? planeRef(doc, args.from, "from", hole) : need(keep("from"), "from", "pick the plane or planar face to offset from");
        fields["distance"] = args.distance !== undefined ? irScalar(args.distance) : (keep("distance") ?? 10);
        break;
      case "angle":
        fields["mode"] = "angle";
        fields["from"] = args.from ? planeRef(doc, args.from, "from", hole) : need(keep("from"), "from", "pick the plane to rotate");
        fields["axis"] = args.axis ? axisRef(doc, args.axis, "axis", hole) : need(keep("axis"), "axis", "pick the axis to rotate about (it must lie in the plane)");
        fields["angle"] = args.angle !== undefined ? irScalar(args.angle) : (keep("angle") ?? 45);
        break;
      case "midplane":
        fields["mode"] = "midplane";
        fields["a"] = args.a ? planeRef(doc, args.a, "a", hole) : need(keep("a"), "a", "pick the first plane or face");
        fields["b"] = args.b ? planeRef(doc, args.b, "b", hole) : need(keep("b"), "b", "pick the second plane or face");
        break;
      case "three_points":
        fields["mode"] = "through";
        fields["points"] = args.points ? args.points.map((p, i) => pointRef(doc, p, `points.${i}`, ctx.report)) : need(keep("points"), "points", "pick three points");
        break;
    }
    const part = existing ? partFor(doc, existing.id) : partFor(doc, ctx.host.rollback);
    return featureOps(doc, "datum_plane", { fields, name: args.name }, existing, PLANE_OWNED, part, existing ? `Edit ${existing.name}` : "Datum plane");
  },
  argsOf(f) {
    const mode = f["mode"] as string;
    return {
      feature: f.id,
      mode: mode === "through" ? "three_points" : (mode as DatumPlaneArgs["mode"]),
      ...(scalarOf(f["distance"]) !== undefined ? { distance: scalarOf(f["distance"])! } : {}),
      ...(scalarOf(f["angle"]) !== undefined ? { angle: scalarOf(f["angle"])! } : {}),
      name: f.name,
    };
  },
});

const AXIS_OWNED = ["mode", "edge", "face", "a", "b", "points", "flip"] as const;

export const datumAxisModelingTool = defineModelingTool<DatumAxisArgs>({
  id: "datum_axis",
  title: "Datum Axis",
  agentTool: "datum_axis",
  featureTypes: ["datum_axis"],
  description:
    'Add a construction axis (the Axis tool) to revolve or pattern about. {mode: "edge", edge} (a straight or circular edge name) | {mode: "cylinder", face} (a cylindrical face) | {mode: "planes", a, b} (where two planes meet) | {mode: "points", points: [p0, p1]}; flip reverses it. Edit: {feature, …changed}.',
  args: DatumAxisArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["datum_axis"]) : null;
    const prevMode = existing ? (existing["mode"] as DatumAxisArgs["mode"]) : undefined;
    const mode = args.mode ?? prevMode ?? (args.edge ? "edge" : args.face ? "cylinder" : args.points ? "points" : "planes");
    const hole = singleHoleResolver(ctx.report);
    const keep = (k: string): unknown => (existing && prevMode === mode ? existing[k] : undefined);
    const fields: Record<string, unknown> = { mode };
    switch (mode) {
      case "edge":
        fields["edge"] = args.edge ? edgeRef(doc, args.edge, "edge", hole) : need(keep("edge"), "edge", "pick a straight or circular edge");
        break;
      case "cylinder":
        fields["face"] = args.face ? faceRef(doc, args.face, "face", hole) : need(keep("face"), "face", "pick a cylindrical face");
        break;
      case "planes":
        fields["a"] = args.a ? planeRef(doc, args.a, "a", hole) : need(keep("a"), "a", "pick the first plane");
        fields["b"] = args.b ? planeRef(doc, args.b, "b", hole) : need(keep("b"), "b", "pick the second plane");
        break;
      case "points":
        fields["points"] = args.points ? args.points.map((p, i) => pointRef(doc, p, `points.${i}`, ctx.report)) : need(keep("points"), "points", "pick two points");
        break;
    }
    const flip = args.flip ?? (existing?.["flip"] === true);
    if (flip) fields["flip"] = true;
    const part = existing ? partFor(doc, existing.id) : partFor(doc, ctx.host.rollback);
    return featureOps(doc, "datum_axis", { fields, name: args.name }, existing, AXIS_OWNED, part, existing ? `Edit ${existing.name}` : "Datum axis");
  },
  argsOf(f: FeatureJson) {
    return { feature: f.id, mode: f["mode"] as DatumAxisArgs["mode"], ...(f["flip"] === true ? { flip: true } : {}), name: f.name };
  },
});

