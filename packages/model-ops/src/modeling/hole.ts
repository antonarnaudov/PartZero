/**
 * Hole (SPEC-v1 §6.5): holes drilled into a planar face (or an origin/datum plane) at positions —
 * picked points on the face, typed (u, v) positions, a sketch's points, a grid or a bolt circle —
 * as simple, counterbored, countersunk or heat-set insert holes, optionally threaded (cosmetic),
 * through or blind, sized from the verified ISO table (M2–M8 with a fit) or a custom diameter.
 */
import { z } from "zod";
import { fromUv, holeInstances, singleHoleResolver, tidy, toUv, type V3 } from "./frames.js";
import { argError, bodiesRef, faceRef, featureOf, planeRef, type ReportLike } from "./keys.js";
import { probePlaneFrame } from "./probe.js";
import { defineModelingTool, docOf, editTarget, featureOps, IdArg, irScalar, isObject, partFor, PickArg, ScalarArg, scalarOf, TargetsArg, Vec3Arg, type ModelingContext, type Scalar } from "./tool.js";

export const HOLE_SIZES = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"] as const;
export const HOLE_KINDS = ["simple", "counterbore", "countersink", "insert"] as const;

const PointUv = z.strictObject({ id: IdArg.optional(), u: ScalarArg, v: ScalarArg });

export const HoleArgs = z.strictObject({
  feature: IdArg.optional().describe("Edit this hole (id or name) instead of adding one; arguments left out keep their values."),
  face: PickArg.optional().describe("The planar face to drill into, by name (e1/cap:end). The holes cut the body that owns it."),
  plane: PickArg.optional().describe('Or an origin plane (XY) or a datum plane (then `targets` says which bodies; default "all").'),
  flip: z.boolean().optional().describe("Drill the other way (default: into the material under the face)."),
  points: z.array(Vec3Arg).min(1).max(500).optional().describe("Hole centres as world points on the face [x, y, z] (e.g. where the face was clicked)."),
  at: z.array(PointUv).min(1).max(500).optional().describe("Hole centres as (u, v) in the face's plane frame (SPEC §3.1), optionally with ids."),
  sketch_points: z.strictObject({ sketch: IdArg, ids: z.union([z.literal("all"), z.array(IdArg).min(1).max(500)]) }).optional().describe("Hole centres at a sketch's points (point curves or <circle>.center)."),
  grid: z.strictObject({ nx: ScalarArg, ny: ScalarArg, dx: ScalarArg, dy: ScalarArg, center: z.tuple([ScalarArg, ScalarArg]).optional() }).optional().describe("A rectangular grid of nx × ny holes, pitch dx, dy, centred on center (u, v)."),
  circle: z.strictObject({ n: ScalarArg, d: ScalarArg, start: ScalarArg.optional(), center: z.tuple([ScalarArg, ScalarArg]).optional() }).optional().describe("A bolt circle: n holes on a circle of diameter d, the first at angle start."),
  size: z.enum(HOLE_SIZES).optional().describe("Metric screw size (ISO table; default M3 for a new hole)."),
  diameter: ScalarArg.optional().describe("A custom diameter (mm): overrides the table."),
  fit: z.enum(["close", "normal", "loose", "tap"]).optional().describe("Clearance fit for the size (ISO 273); tap = the tap drill. Default normal."),
  kind: z.enum(HOLE_KINDS).optional().describe("simple (default), counterbore (ISO 4762 socket head), countersink (ISO 10642 flat head) or insert (heat-set insert)."),
  cbore_diameter: ScalarArg.optional(),
  cbore_depth: ScalarArg.optional(),
  csink_diameter: ScalarArg.optional(),
  csink_angle: ScalarArg.optional(),
  insert_diameter: ScalarArg.optional(),
  insert_depth: ScalarArg.optional(),
  threaded: z.boolean().optional().describe("Cosmetic thread (no geometry; the diameter becomes the tap drill)."),
  thread_depth: ScalarArg.optional(),
  depth: z.union([z.literal("through"), ScalarArg]).optional().describe('"through" (default) or a blind depth (mm).'),
  up_to: PickArg.optional().describe("Or drill up to this face."),
  tip: z.union([z.literal("flat"), ScalarArg]).optional().describe('Blind holes: the drill point angle (default 118) or "flat".'),
  targets: TargetsArg.optional().describe('Bodies to cut when drilling from a plane: "all" or body names.'),
  name: IdArg.optional(),
});
export type HoleArgs = z.infer<typeof HoleArgs>;

const OWNED = ["on", "flip", "at", "size", "fit", "d", "depth", "tip", "cbore", "csink", "insert", "thread", "targets"] as const;
const PLACEMENTS = ["points", "at", "sketch_points", "grid", "circle"] as const;

function sc(v: Scalar | undefined): number | string | undefined {
  return v === undefined ? undefined : irScalar(v);
}

/** The placement (`at`) of a hole from its arguments, or undefined when none is given. */
async function placement(args: HoleArgs, ctx: ModelingContext, part: string, on: unknown): Promise<unknown> {
  if (args.at) return { list: args.at.map((p, i) => ({ id: p.id ?? `p${i + 1}`, at: [irScalar(p.u), irScalar(p.v)] })) };
  if (args.points) {
    const frame = await probePlaneFrame(ctx, part, on, args.face ? "face" : "plane");
    return { list: args.points.map((p, i) => ({ id: `p${i + 1}`, at: toUv(frame, p as V3).map((x) => tidy(x, 4)) })) };
  }
  if (args.sketch_points) {
    const s = featureOf(docOf(ctx), args.sketch_points.sketch);
    if (!s || s.type !== "sketch") throw argError("sketch_points", `${args.sketch_points.sketch} is not a sketch`, "MODEL_NOT_A_SKETCH");
    return { points: { sketch: s.id, ids: args.sketch_points.ids } };
  }
  if (args.grid) {
    const g = args.grid;
    return { grid: { nx: irScalar(g.nx), ny: irScalar(g.ny), dx: irScalar(g.dx), dy: irScalar(g.dy), ...(g.center ? { center: g.center.map(irScalar) } : {}) } };
  }
  if (args.circle) {
    const c = args.circle;
    return { circle: { n: irScalar(c.n), d: irScalar(c.d), ...(c.start !== undefined ? { start: irScalar(c.start) } : {}), ...(c.center ? { center: c.center.map(irScalar) } : {}) } };
  }
  return undefined;
}

/** A hole feature's fields as arguments (for re-editing it). */
function holeArgsOf(f: Record<string, unknown>): Partial<HoleArgs> {
  const out: Partial<HoleArgs> = {};
  if (typeof f["size"] === "string") out.size = f["size"] as HoleArgs["size"];
  if (scalarOf(f["d"]) !== undefined) out.diameter = scalarOf(f["d"])!;
  if (typeof f["fit"] === "string") out.fit = f["fit"] as HoleArgs["fit"];
  if (f["flip"] === true) out.flip = true;
  const depth = f["depth"];
  if (depth === "through") out.depth = "through";
  else if (isObject(depth) && depth["blind"] !== undefined) out.depth = scalarOf(depth["blind"])!;
  const tip = f["tip"];
  if (tip === "flat") out.tip = "flat";
  else if (scalarOf(tip) !== undefined) out.tip = scalarOf(tip)!;
  const cbore = f["cbore"];
  const csink = f["csink"];
  const insert = f["insert"];
  if (cbore !== undefined) {
    out.kind = "counterbore";
    if (isObject(cbore)) {
      out.cbore_diameter = scalarOf(cbore["d"])!;
      out.cbore_depth = scalarOf(cbore["depth"])!;
    }
  } else if (csink !== undefined) {
    out.kind = "countersink";
    if (isObject(csink)) {
      out.csink_diameter = scalarOf(csink["d"])!;
      if (scalarOf(csink["angle"]) !== undefined) out.csink_angle = scalarOf(csink["angle"])!;
    }
  } else if (insert !== undefined) {
    out.kind = "insert";
    if (isObject(insert)) {
      out.insert_diameter = scalarOf(insert["d"])!;
      out.insert_depth = scalarOf(insert["depth"])!;
    }
  } else out.kind = "simple";
  const thread = f["thread"];
  if (thread === true) out.threaded = true;
  else if (isObject(thread)) {
    out.threaded = true;
    if (scalarOf(thread["depth"]) !== undefined) out.thread_depth = scalarOf(thread["depth"])!;
  }
  const at = f["at"];
  if (isObject(at) && Array.isArray(at["list"])) {
    out.at = (at["list"] as Array<{ id: string; at: [Scalar, Scalar] }>).map((p) => ({ id: p.id, u: p.at[0], v: p.at[1] }));
  } else if (isObject(at) && isObject(at["grid"])) {
    const g = at["grid"];
    out.grid = { nx: scalarOf(g["nx"])!, ny: scalarOf(g["ny"])!, dx: scalarOf(g["dx"])!, dy: scalarOf(g["dy"])!, ...(Array.isArray(g["center"]) ? { center: g["center"] as [Scalar, Scalar] } : {}) };
  } else if (isObject(at) && isObject(at["circle"])) {
    const c = at["circle"];
    out.circle = { n: scalarOf(c["n"])!, d: scalarOf(c["d"])!, ...(scalarOf(c["start"]) !== undefined ? { start: scalarOf(c["start"])! } : {}), ...(Array.isArray(c["center"]) ? { center: c["center"] as [Scalar, Scalar] } : {}) };
  } else if (isObject(at) && isObject(at["points"])) {
    const p = at["points"];
    out.sketch_points = { sketch: String(p["sketch"]), ids: p["ids"] as "all" | string[] };
  }
  return out;
}

export const holeModelingTool = defineModelingTool<HoleArgs>({
  id: "hole",
  title: "Hole",
  agentTool: "hole",
  featureTypes: ["hole"],
  description:
    'Drill holes into a planar face (the Hole tool). New: {face, points | at | sketch_points | grid | circle, size?, fit?, kind?, threaded?, depth?}. face is a face name (e1/cap:end); points are world points on it, at are (u, v) in its frame. size M2–M8 (ISO table, verified sources) or diameter; kind simple | counterbore | countersink | insert; depth "through" or a blind depth. Edit: {feature, …changed}. Refused with the engine code (HOLE_POINT_OFF_FACE, HOLE_MISSES_BODY, HOLE_OPTIONS_CONFLICT) when it would not build.',
  args: HoleArgs,
  async build(args, ctx) {
    const doc = docOf(ctx);
    const existing = args.feature ? editTarget(doc, args.feature, ["hole"]) : null;
    const prev = existing ?? ({} as Record<string, unknown>);
    const base: Partial<HoleArgs> = existing ? holeArgsOf(existing) : {};
    if (PLACEMENTS.some((k) => args[k] !== undefined)) for (const k of PLACEMENTS) delete base[k];
    const a: HoleArgs = { ...base, ...args };
    const report = ctx.report as ReportLike | null;
    const hole = singleHoleResolver(report);
    // Where: a face (the body under it is the target) or a plane (explicit targets).
    let on: unknown;
    if (args.face) on = { face: faceRef(doc, args.face, "face", hole) };
    else if (args.plane) on = planeRef(doc, args.plane, "plane", hole);
    else if (existing) on = prev["on"];
    else throw argError("face", "pick the planar face to drill into", "MODEL_MISSING_ARG");
    const onFace = isObject(on) && on["face"] !== undefined;
    const part = existing ? partFor(doc, existing.id) : partFor(doc, onFace ? String((((on as Record<string, unknown>)["face"] as Record<string, unknown>)["q"] as Record<string, unknown>)["feature"] ?? "") : null);
    let at = await placement(a, ctx, part, on);
    if (at === undefined && existing && !PLACEMENTS.some((k) => a[k] !== undefined)) at = prev["at"];
    if (at === undefined) throw argError("at", "say where the holes go: points on the face, (u, v) positions, sketch points, a grid or a bolt circle", "MODEL_MISSING_ARG");
    const kind = a.kind ?? "simple";
    const custom = a.diameter !== undefined;
    const size = a.size ?? (custom ? undefined : "M3");
    const threaded = a.threaded === true;
    const fields: Record<string, unknown> = { on, at };
    if (a.flip) fields["flip"] = true;
    if (size) fields["size"] = size;
    if (custom) fields["d"] = irScalar(a.diameter!);
    if (a.fit && a.fit !== "normal" && !(threaded && (a.fit === "close" || a.fit === "loose"))) fields["fit"] = a.fit;
    if (kind === "counterbore") {
      fields["cbore"] = a.cbore_diameter !== undefined || a.cbore_depth !== undefined || !size ? { d: sc(a.cbore_diameter) ?? 6, depth: sc(a.cbore_depth) ?? 3 } : "iso4762";
    } else if (kind === "countersink") {
      fields["csink"] = a.csink_diameter !== undefined || !size ? { d: sc(a.csink_diameter) ?? 6, ...(a.csink_angle !== undefined ? { angle: sc(a.csink_angle) } : {}) } : "iso10642";
    } else if (kind === "insert") {
      fields["insert"] = a.insert_diameter !== undefined || a.insert_depth !== undefined || !size ? { d: sc(a.insert_diameter) ?? 4, depth: sc(a.insert_depth) ?? 6 } : "std";
    }
    if (threaded && kind !== "insert") fields["thread"] = a.thread_depth !== undefined ? { depth: sc(a.thread_depth) } : true;
    if (kind !== "insert") {
      if (args.up_to) fields["depth"] = { up_to: faceRef(doc, args.up_to, "up_to", hole) };
      else if (a.depth === undefined || a.depth === "through") fields["depth"] = existing && args.depth === undefined && isObject(prev["depth"]) && (prev["depth"] as Record<string, unknown>)["up_to"] !== undefined ? prev["depth"] : "through";
      else fields["depth"] = { blind: irScalar(a.depth) };
      const blind = isObject(fields["depth"]) && (fields["depth"] as Record<string, unknown>)["blind"] !== undefined;
      if (blind && a.tip !== undefined && a.tip !== 118) fields["tip"] = a.tip === "flat" ? "flat" : irScalar(a.tip);
    }
    if (!onFace || (a.targets !== undefined && args.targets !== undefined)) {
      if (args.targets !== undefined) fields["targets"] = args.targets === "all" ? "all" : bodiesRef(doc, args.targets, report, "targets");
      else fields["targets"] = prev["targets"] ?? "all";
    }
    const what = existing ? `Edit ${existing.name}` : `Hole ${size ?? ""}`.trim();
    return featureOps(doc, "hole", { fields, name: args.name }, existing, OWNED, part, what);
  },
  argsOf(f) {
    return { feature: f.id, ...holeArgsOf(f), name: f.name };
  },
});

/** Where the holes of a hole feature are, in world coordinates (from the report), for handles. */
export function holeCenters(report: ReportLike | null, holeId: string): V3[] {
  return holeInstances(report, holeId).map((h) => h.center);
}

export { fromUv };
