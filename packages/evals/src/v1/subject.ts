/**
 * IR v1 subjects for the hidden-test DSL: what a check sees of a candidate evaluated with the
 * IR v1 pipeline (`aicad.ir/1` → `aicad.metrics/1`, SPEC-v1 §7).
 *
 * - **Model and body checks** read a v0-shaped view of the v1 report ({@link v0ViewOfV1}): the
 *   report `status`, per-feature types, statuses and regions, and the **final** bodies of each
 *   part (`parts[].bodies`, §6.0.5) — never a feature's own `bodies`, which in v1 are the bodies
 *   it created *or modified* (a join lists its target again).
 * - **Hole checks** read the report's hole instances (`holes`, §6.5) and the full circles of the
 *   solved sketches (`sketch.solved`, §4.4) that sweeps leave as **holes**, placed in model space
 *   with the sketch's plane frame (§3.1: named planes, explicit frames, datum frames from the
 *   report, face frames from the face's probe). Which circles are holes follows the regions and
 *   the sweep's `op`: a `cut` extrude's outer circles, the inner circles of a `new_body`, `join`
 *   or `intersect` extrude (never a boss, pin or bead: `circles: "all"` asks for those too);
 *   a sketch nothing sweeps (one that only places hole features) and revolve profiles make no
 *   holes; a sketch circle that coincides with a hole instance (the same part and diameter, on
 *   its axis, its sweep overlapping the hole along the axis) is that hole drawn twice and counts
 *   once. `curve_count` counts with the same rules for what makes geometry ({@link curvesV1}).
 * - **The census is declarative**: it counts the holes the timeline *made* (successful hole
 *   features, sweeps and patterns), not the holes the final bodies still have. A hole a later
 *   join fills, or a later cut consumes, is still counted, and so is a cut circle that misses the
 *   body inside a multi-tool cut: the report has no per-face data to confirm a hole's wall
 *   survives. Hole checks alone are therefore not sound, and task validation requires every
 *   task with a hole check to measure the geometry as well: a `volume` or `face_count` test (for
 *   a `param` hole check, one with the same `set`), which a filled or missing hole changes.
 * - **Pattern copies** (§6.10) of hole seeds and of the circles of sweep seeds are added with the
 *   pattern's transform. A **body-seed** pattern (`seed: { bodies }`) copies the holes and swept
 *   circles of the bodies it copies: each hole is attributed to the bodies it may lie on (the
 *   bodies its feature created or modified whose box meets the hole's stretch of axis, carried
 *   into a join's result and dropped when its body is cut away or consumed), and the seed's
 *   bodies are its resolved `/seed/bodies` members (body keys, §5.2 rule 7). A hole on seeded
 *   bodies only is copied, one on none is not; when the report cannot tell (it may lie on a
 *   seeded body and on another), the copy is **uncertain** ({@link HoleInstance.uncertain}) and
 *   every check that meets it fails with the reason instead of counting it or not. A copy is
 *   placed when the pattern's layout can be evaluated here: named or explicit directions and
 *   axes, datum axes and planes, and `{edge}` / `{cylinder}` axes read off the member's key and
 *   probe ({@link axisFromKey}): hole faces and their rims; extrude sides of circles and arcs,
 *   junction edges (the line through the swept vertex) and cap edges (a circle about a swept
 *   circle's axis, or the line of a swept line); revolve sides and junction edges (the revolve
 *   axis). Refused, with the reason: pattern copies' entities, revolve end-cap edges, blend,
 *   shell and merged faces, and edges whose faces do not tell a line from a circle. A copy that
 *   cannot be placed is counted but has no position ({@link HoleInstance.center} absent), and a
 *   position check that meets it fails with the reason — so a task should pattern about axes of
 *   these forms (or explicit ones) when a position test depends on the copies.
 */
import type { BodyMetrics, EvalReport, FeatureReport, SketchCurve, SketchFeature } from "@aicad/ir-types";
import type { metricsV1, v1 as irv1 } from "@aicad/ir-types";
import { v1 as irConst } from "@aicad/ir-types";
import { logicalCurves, loopBoxArea, loopContains, sketchCircles, type LogicalCurve, type PlaneFrame, type SketchCircle, type V3 } from "../ir-geom.js";
import { evalCount, evalNumber, evalScalar, evalVector, paramValues, type Evaluated, type ParamValues } from "./expr.js";

export type ReportV1 = metricsV1.EvalReport;
export type DocV1 = irv1.IrDocument;
export type FeatureReportV1 = metricsV1.FeatureReport;

/** What the v1 checks look at: the engine's `aicad.metrics/1` report and the compiled v1 IR. */
export interface SubjectV1 {
  report: ReportV1;
  /** The candidate's compiled IR (null when it did not compile). */
  doc: DocV1 | null;
}

// ─── The v0 view ───────────────────────────────────────────────────────────────────────────

function v0Body(b: metricsV1.BodyReport): BodyMetrics {
  return {
    volume: b.volume,
    area: b.area,
    centroid: b.centroid,
    bbox_min: b.bbox_min,
    bbox_max: b.bbox_max,
    faces: b.faces,
    edges: b.edges,
    face_types: b.face_types,
    edge_types: b.edge_types,
    valid: b.valid,
  };
}

/**
 * The `aicad.metrics/0`-shaped view of a v1 report that the model and body checks measure: one
 * entry per feature (type, status, error code and message, regions) and the final bodies of each
 * part on the part's last successful feature, so `bodiesOf()` (the bodies of every ok feature)
 * is exactly the final state.
 */
export function v0ViewOfV1(report: ReportV1): EvalReport {
  const features: FeatureReport[] = report.features.map((f) => {
    const out: FeatureReport = { part: f.part, feature: f.feature, type: f.type as FeatureReport["type"], status: f.status };
    if (f.error) out.error = { code: f.error.code, message: f.error.message };
    if (f.regions) out.regions = f.regions;
    return out;
  });
  for (const part of report.parts ?? []) {
    const last = [...features].reverse().find((f) => f.part === part.part && f.status === "ok");
    if (last && part.bodies.length > 0) last.bodies = part.bodies.map(v0Body);
  }
  const v0: EvalReport = { schema: "aicad.metrics/0", engine: report.engine, document: report.document, status: report.status, features };
  if (report.error) v0.error = { code: report.error.code, message: report.error.message };
  return v0;
}

// ─── Small vector helpers ──────────────────────────────────────────────────────────────────

type M3 = [number, number, number];

const add = (a: V3, b: V3): M3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): M3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, k: number): M3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): M3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);

function unit(a: V3): M3 | null {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}

/** The first component (x, y, z) with |c| > 1e-9 made positive (SPEC-v1 §3.2). */
function signCanonical(d: V3): M3 {
  const c = [d[0], d[1], d[2]].find((x) => Math.abs(x) > 1e-9) ?? 1;
  return c < 0 ? scale(d, -1) : [d[0], d[1], d[2]];
}

/** Rotate `p` about the line (o, unit d) by `deg` degrees (right-hand rule). */
function rotateAbout(p: V3, o: V3, d: V3, deg: number): M3 {
  const t = (deg * Math.PI) / 180;
  const v = sub(p, o);
  const c = Math.cos(t);
  const s = Math.sin(t);
  const r = add(add(scale(v, c), scale(cross(d, v), s)), scale(d, dot(d, v) * (1 - c)));
  return add(o, r);
}

// ─── Feature lookup and parameters ─────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

interface PartCtx {
  part: string;
  params: ParamValues;
  /** IR feature by id (this part). */
  features: Map<string, Obj>;
  /** Report entry by feature id (this part). */
  entries: Map<string, FeatureReportV1>;
}

function partContexts(s: SubjectV1): PartCtx[] {
  const out: PartCtx[] = [];
  for (const part of s.doc?.parts ?? []) {
    const features = new Map<string, Obj>();
    for (const f of part.features as unknown as Obj[]) features.set(String(f["id"]), f);
    const entries = new Map<string, FeatureReportV1>();
    for (const e of s.report.features) if (e.part === part.name) entries.set(e.feature_id, e);
    out.push({ part: part.name, params: paramValues(s.report, part.name), features, entries });
  }
  return out;
}

/** The IR feature of a report entry, with its part's parameter values. */
export function irFeatureOf(s: SubjectV1, entry: FeatureReportV1): { feature: Obj; params: ParamValues } | null {
  const part = s.doc?.parts.find((p) => p.name === entry.part);
  const f = (part?.features as unknown as Obj[] | undefined)?.find((x) => x["id"] === entry.feature_id);
  return f ? { feature: f, params: paramValues(s.report, entry.part) } : null;
}

// ─── Plane frames (§3.1) ───────────────────────────────────────────────────────────────────

const NAMED_FRAMES: Record<string, PlaneFrame> = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], normal: [1, 0, 0] },
};

function frameFromReport(d: metricsV1.DatumReport | undefined): PlaneFrame | null {
  if (!d || !("normal" in d)) return null;
  return { origin: d.origin, x: d.x, y: d.y, normal: d.normal };
}

/** The face frame of §3.1 from the face's outward normal `n` and a point `p` on its plane. */
function faceFrame(p: V3, n: V3, origin: V3 | null, xDir: V3 | null): Evaluated<PlaneFrame> {
  const nn = unit(n);
  if (!nn) return { ok: false, reason: "the face probe has no normal" };
  const o = origin ?? [0, 0, 0];
  const org = sub(o, scale(nn, dot(sub(o, p), nn)));
  let x: M3 | null;
  if (xDir) {
    x = unit(sub(xDir, scale(nn, dot(xDir, nn))));
  } else {
    const axes: M3[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const al = axes.map((a) => Math.abs(dot(nn, a)));
    const best = Math.min(...al);
    // [W0-32]: values within ANGULAR_TOLERANCE of the smallest are ties (the first axis wins).
    const a = axes[al.findIndex((v) => v <= best + irConst.ANGULAR_TOLERANCE)]!;
    x = unit(sub(a, scale(nn, dot(a, nn))));
  }
  if (!x) return { ok: false, reason: "degenerate face frame" };
  return { ok: true, value: { origin: org, x, y: cross(nn, x), normal: nn } };
}

/**
 * The frame of a PlaneRef as the feature `entry` evaluated it. `field` is the JSON pointer of the
 * PlaneRef inside the feature (`/plane`, `/on`), used to find a face reference's report entry.
 */
function planeFrameV1(ctx: PartCtx, plane: unknown, entry: FeatureReportV1 | undefined, field: string): Evaluated<PlaneFrame> {
  if (typeof plane === "string") {
    const f = NAMED_FRAMES[plane];
    return f ? { ok: true, value: f } : { ok: false, reason: `unknown plane ${plane}` };
  }
  if (!isObj(plane)) return { ok: false, reason: "no plane" };
  if (typeof plane["datum"] === "string") {
    const f = frameFromReport(ctx.entries.get(plane["datum"])?.datum);
    return f ? { ok: true, value: f } : { ok: false, reason: `datum plane ${plane["datum"]} has no evaluated frame` };
  }
  if ("face" in plane) {
    const ref = entry?.refs?.find((r) => r.field === `${field}/face`);
    const probe = ref?.members[0]?.probe;
    if (!probe || !probe.normal) return { ok: false, reason: `the face of ${field} has no probe in the report` };
    const origin = plane["origin"] ? evalVector(plane["origin"], ctx.params) : null;
    if (origin && !origin.ok) return origin;
    const xDir = plane["x_dir"] ? evalVector(plane["x_dir"], ctx.params) : null;
    if (xDir && !xDir.ok) return xDir;
    return faceFrame(probe.point, probe.normal, origin ? (origin.value as unknown as V3) : null, xDir ? (xDir.value as unknown as V3) : null);
  }
  const o = evalVector(plane["origin"], ctx.params);
  const n = evalVector(plane["normal"], ctx.params);
  const x = evalVector(plane["x_dir"], ctx.params);
  if (!o.ok) return o;
  if (!n.ok) return n;
  if (!x.ok) return x;
  const nn = unit(n.value as unknown as V3);
  const xx = unit(x.value as unknown as V3);
  if (!nn || !xx) return { ok: false, reason: "degenerate frame" };
  return { ok: true, value: { origin: o.value as unknown as V3, x: xx, y: cross(nn, xx), normal: nn } };
}

function toModel(f: PlaneFrame, p: readonly number[]): M3 {
  return add(f.origin, add(scale(f.x, p[0]!), scale(f.y, p[1]!)));
}

// ─── Axes and directions (§3.2) ────────────────────────────────────────────────────────────

interface Line3 {
  origin: M3;
  dir: M3;
}

const NAMED_DIRS: Record<string, M3> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
  "+X": [1, 0, 0],
  "+Y": [0, 1, 0],
  "+Z": [0, 0, 1],
  "-X": [-1, 0, 0],
  "-Y": [0, -1, 0],
  "-Z": [0, 0, -1],
};

const unescapeKey = (s: string) => s.replace(/%([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** A provenance key split at its top level (§5.2 rule 1): `fid/role[@qual]`, and an edge's two face keys. */
interface KeyParts {
  /** The feature id (unescaped). */
  fid: string;
  /** The role (`side:c`, `cap:end`, `wall`, `edge:{A|B}`, …), still escaped. */
  role: string;
  /** The qualifier after the first top-level `@`, still escaped. */
  qual?: string;
  /** `edge:{A|B}`: the two face keys. */
  faces?: [string, string];
}

function parseKey(key: string): KeyParts | null {
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const rest = key.slice(slash + 1);
  let depth = 0;
  let at = -1;
  let bar = -1;
  for (let i = 0; i < rest.length && at < 0; i++) {
    const ch = rest[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "@" && depth === 0) at = i;
    else if (ch === "|" && depth === 1 && bar < 0) bar = i;
  }
  const role = at < 0 ? rest : rest.slice(0, at);
  const out: KeyParts = { fid: unescapeKey(key.slice(0, slash)), role };
  if (at >= 0) out.qual = rest.slice(at + 1);
  if (role.startsWith("edge:{") && role.endsWith("}") && bar > 0) out.faces = [role.slice(6, bar), role.slice(bar + 1, -1)];
  return out;
}

/** An extrude or revolve as its entities' geometry needs it: the sketch frame, the solved curves, a revolve's axis. */
interface Sweep {
  type: "extrude" | "revolve";
  frame: PlaneFrame;
  solved: metricsV1.LiteralCurve[];
  /** Revolve: the axis in model space (v0 §4.3). */
  axis?: Line3;
}

/** The sweep `fid` (null when it is not an extrude or revolve of this part). */
function sweepOf(ctx: PartCtx, fid: string): Evaluated<Sweep> | null {
  const f = ctx.features.get(fid);
  if (!f || (f["type"] !== "extrude" && f["type"] !== "revolve")) return null;
  const skId = String(f["sketch"]);
  const skEntry = ctx.entries.get(skId);
  if (!skEntry?.sketch) return { ok: false, reason: `the sketch of ${fid} has no solved geometry in the report` };
  const frame = planeFrameV1(ctx, ctx.features.get(skId)?.["plane"], skEntry, "/plane");
  if (!frame.ok) return frame;
  const sweep: Sweep = { type: f["type"], frame: frame.value, solved: skEntry.sketch.solved };
  if (f["type"] === "revolve") {
    const ax = isObj(f["axis"]) ? f["axis"] : {};
    const o = evalVector(ax["origin"], ctx.params);
    const d = evalVector(ax["direction"], ctx.params);
    if (!o.ok) return o;
    if (!d.ok) return d;
    const dir = unit(add(scale(frame.value.x, d.value[0]!), scale(frame.value.y, d.value[1]!)));
    if (!dir) return { ok: false, reason: `revolve ${fid} has a zero axis direction` };
    sweep.axis = { origin: toModel(frame.value, o.value), dir };
  }
  return { ok: true, value: sweep };
}

/**
 * What an axis needs to know of a face: its normal when it is planar, its axis when it is a
 * surface of revolution (a cylinder, cone, torus or sphere side; a planar floor is both).
 */
interface FaceGeom {
  plane?: M3;
  rev?: Line3;
}

const HOLE_REV_ROLES = new Set(["wall", "cbore_wall", "csink", "tip"]);
const HOLE_FLAT_ROLES = new Set(["floor", "cbore_floor"]);

/**
 * The geometry of the face keyed `key`, read off the key (§5.2) and the report: hole faces
 * (from the hole instance), extrude caps and sides (from the sketch frame and the solved curve),
 * revolve sides (about the revolve axis). Other faces (blends, shells, merged faces, pattern
 * copies, revolve end caps) cannot be placed from the report.
 */
function faceGeom(ctx: PartCtx, key: string): Evaluated<FaceGeom> {
  const k = parseKey(key);
  const fail = (why: string): Evaluated<FaceGeom> => ({ ok: false, reason: `the face ${key} cannot be placed from the report (${why})` });
  if (!k || k.faces) return fail("not a face key");
  if (key.includes("/copy:{")) return fail("a pattern copy's key names the seed, not the copy");
  if (k.qual !== undefined && (HOLE_REV_ROLES.has(k.role) || HOLE_FLAT_ROLES.has(k.role))) {
    const h = ctx.entries.get(k.fid)?.holes?.find((x) => x.at === unescapeKey(k.qual!));
    const d = h ? unit(h.axis) : null;
    if (!h || !d) return fail(`no hole instance ${unescapeKey(k.qual)} of ${k.fid}`);
    const rev: Line3 = { origin: [...h.center], dir: d };
    return { ok: true, value: HOLE_FLAT_ROLES.has(k.role) ? { rev, plane: d } : { rev } };
  }
  const sw = sweepOf(ctx, k.fid);
  if (!sw) return fail(`${k.fid} is not a hole, extrude or revolve`);
  if (!sw.ok) return fail(sw.reason);
  const { type, frame, solved, axis } = sw.value;
  if (type === "extrude" && (k.role === "cap:start" || k.role === "cap:end")) return { ok: true, value: { plane: [...frame.normal] } };
  if (!k.role.startsWith("side:")) return fail(`${type} role ${k.role}`);
  const c = solved.find((x) => x.id === unescapeKey(k.role.slice(5)));
  if (!c || c.kind === "point") return fail(`no solved curve ${unescapeKey(k.role.slice(5))}`);
  if (type === "revolve") {
    const rev = axis!;
    // A profile line perpendicular to the axis sweeps a flat annulus: planar and of revolution.
    if (c.kind === "line") {
      const d = unit(sub(toModel(frame, c.end), toModel(frame, c.start)));
      if (d && Math.abs(dot(d, rev.dir)) <= irConst.ANGULAR_TOLERANCE) return { ok: true, value: { rev, plane: rev.dir } };
    }
    return { ok: true, value: { rev } };
  }
  if (c.kind === "line") {
    const n = unit(cross(frame.normal, sub(toModel(frame, c.end), toModel(frame, c.start))));
    return n ? { ok: true, value: { plane: n } } : fail(`degenerate line ${c.id}`);
  }
  return { ok: true, value: { rev: { origin: toModel(frame, c.center), dir: [...frame.normal] } } };
}

const parallel = (a: V3, b: V3) => Math.abs(dot(a, b)) >= 1 - irConst.ANGULAR_TOLERANCE;

function coaxial(a: Line3, b: Line3): boolean {
  if (!parallel(a.dir, b.dir)) return false;
  const v = sub(b.origin, a.origin);
  const off = len(sub(v, scale(a.dir, dot(v, a.dir))));
  return off <= 1e-6 * Math.max(1, len(a.origin), len(b.origin));
}

/**
 * The axis line of an `{edge}` / `{cylinder}` AxisRef member (§3.2), read off its provenance key
 * (§5.2), its probe and the report — the geometry itself is not in the report:
 * - a **junction edge** of a sweep (`F/edge:{…}@c.end`, checked first: its face keys name the
 *   curves on both sides, which may be arcs): for an extrude, the line through that sketch
 *   vertex along the sketch normal; for a revolve, the circle it sweeps, about the revolve axis;
 * - any other **edge** `…/edge:{A|B}`, from the geometry of its two faces ({@link faceGeom}): a
 *   surface of revolution meeting a plane perpendicular to its axis, or a coaxial one, makes a
 *   circle about that axis (a hole's rim, a cap edge of a swept circle or arc); two planes that
 *   are not parallel make a line along `nA × nB` through the member's probe point (a cap edge of
 *   a swept line). Anything else (the faces cannot be placed, or could meet in a line or a
 *   circle) is refused with the reason;
 * - a **face** (`{cylinder}`): its axis when it is a surface of revolution (a hole face, the
 *   side of a swept circle or arc, a revolve side).
 * A pattern copy's entity (`P/copy:{…}`) is refused: the key names the seed, not the copy.
 */
function axisFromKey(ctx: PartCtx, key: string, probe?: metricsV1.Probe): Evaluated<Line3> {
  const refuse = (why: string): Evaluated<Line3> => ({ ok: false, reason: `the axis of ${key} cannot be placed from the report (${why})` });
  if (key.includes("/copy:{")) return { ok: false, reason: `the axis of the pattern copy ${key} cannot be placed from the report` };
  const k = parseKey(key);
  if (!k) return refuse("not a provenance key");
  if (!k.faces) {
    const g = faceGeom(ctx, key);
    if (!g.ok) return g;
    return g.value.rev ? { ok: true, value: g.value.rev } : refuse("a planar face has no axis");
  }
  if (k.qual !== undefined) {
    const sw = sweepOf(ctx, k.fid);
    const q = unescapeKey(k.qual);
    const dotAt = q.lastIndexOf(".");
    if (!sw || dotAt <= 0) return refuse(`a qualified edge of ${k.fid}, which is not an extrude or revolve`);
    if (!sw.ok) return sw;
    if (sw.value.type === "revolve") return { ok: true, value: sw.value.axis! };
    const c = sw.value.solved.find((x) => x.id === q.slice(0, dotAt));
    const end = q.slice(dotAt + 1);
    const at = c && (c.kind === "line" || c.kind === "arc") ? (end === "start" ? c.start : end === "end" ? c.end : undefined) : undefined;
    if (!at) return refuse(`no sketch vertex ${q}`);
    return { ok: true, value: { origin: toModel(sw.value.frame, at), dir: [...sw.value.frame.normal] } };
  }
  const [a, b] = [faceGeom(ctx, k.faces[0]), faceGeom(ctx, k.faces[1])];
  if (!a.ok) return refuse(a.reason);
  if (!b.ok) return refuse(b.reason);
  for (const [p, q] of [
    [a.value, b.value],
    [b.value, a.value],
  ] as const) {
    if (p.rev && q.plane && parallel(p.rev.dir, q.plane)) return { ok: true, value: p.rev };
    if (p.rev && q.rev && coaxial(p.rev, q.rev)) return { ok: true, value: p.rev };
  }
  if (a.value.plane && b.value.plane && !parallel(a.value.plane, b.value.plane)) {
    if (!probe) return refuse("a line edge needs the member's probe point");
    return { ok: true, value: { origin: [...probe.point], dir: unit(cross(a.value.plane, b.value.plane))! } };
  }
  return refuse("its faces do not tell whether it is a line or a circle");
}

/**
 * The line of an AxisRef (§3.2). `entry` and `field` (the AxisRef's JSON pointer in the
 * feature) locate an `{edge}` / `{cylinder}` reference's resolved member in the report.
 */
function axisLine(ctx: PartCtx, a: unknown, entry?: FeatureReportV1, field?: string): Evaluated<Line3> {
  if (typeof a === "string") {
    const d = NAMED_DIRS[a];
    return d ? { ok: true, value: { origin: [0, 0, 0], dir: d } } : { ok: false, reason: `unknown axis ${a}` };
  }
  if (!isObj(a)) return { ok: false, reason: "no axis" };
  let line: Line3 | null = null;
  if (typeof a["datum"] === "string") {
    const d = ctx.entries.get(a["datum"])?.datum;
    if (!d || !("direction" in d)) return { ok: false, reason: `datum axis ${a["datum"]} has no evaluated axis` };
    line = { origin: [...d.origin], dir: [...d.direction] };
  } else if (isObj(a["line"])) {
    const o = evalVector(a["line"]["origin"], ctx.params);
    const d = evalVector(a["line"]["direction"], ctx.params);
    if (!o.ok) return o;
    if (!d.ok) return d;
    const u = unit(d.value as unknown as V3);
    if (!u) return { ok: false, reason: "zero axis direction" };
    line = { origin: o.value as unknown as M3, dir: u };
  } else if ("edge" in a || "cylinder" in a) {
    const which = "edge" in a ? "edge" : "cylinder";
    const ref = entry?.refs?.find((r) => r.field === `${field}/${which}`);
    const member = ref?.status !== "failed" ? ref?.members[0] : undefined;
    if (!member) return { ok: false, reason: `the ${which} axis${field ? ` at ${field}` : ""} has no resolved member in the report` };
    const l = axisFromKey(ctx, member.key, member.probe);
    if (!l.ok) return l;
    line = { origin: l.value.origin, dir: signCanonical(l.value.dir) };
  } else {
    return { ok: false, reason: "unknown axis form" };
  }
  if (a["flip"] !== undefined) {
    const f = evalScalar(a["flip"], ctx.params);
    if (!f.ok) return f;
    if (f.value === true) line = { origin: line.origin, dir: scale(line.dir, -1) };
  }
  return { ok: true, value: line };
}

/** A Dir (§3.2): named, a vector, or an AxisRef object (its direction). */
function direction(ctx: PartCtx, d: unknown, entry?: FeatureReportV1, field?: string): Evaluated<M3> {
  if (typeof d === "string") {
    const v = NAMED_DIRS[d];
    return v ? { ok: true, value: v } : { ok: false, reason: `unknown direction ${d}` };
  }
  if (Array.isArray(d)) {
    const v = evalVector(d, ctx.params);
    if (!v.ok) return v;
    const u = unit(v.value as unknown as V3);
    return u ? { ok: true, value: u } : { ok: false, reason: "zero direction" };
  }
  const l = axisLine(ctx, d, entry, field);
  return l.ok ? { ok: true, value: l.value.dir } : l;
}

// ─── Pattern transforms (§6.10) ────────────────────────────────────────────────────────────

/** A rigid map of one pattern instance: points and directions. */
interface Xform {
  point(p: V3): M3;
  dir(d: V3): M3;
}

/**
 * The instance transforms of a pattern feature (the seed excluded, `skip` and the report's
 * `skipped` instances removed), or a reason when the layout cannot be evaluated here. `count`
 * is always the number of created instances (the report's `instances` minus `skipped`).
 */
function patternXforms(ctx: PartCtx, f: Obj, entry: FeatureReportV1): { count: number; xforms: Evaluated<Xform[]> } {
  const skippedRun = new Set((entry.pattern?.skipped ?? []).map((i) => i.join(",")));
  const count = Math.max(0, (entry.pattern?.instances ?? 0) - skippedRun.size);
  const skip = new Set(((f["skip"] as number[][] | undefined) ?? []).map((i) => i.join(",")));
  const keep = (idx: number[]) => !skip.has(idx.join(",")) && !skippedRun.has(idx.join(","));
  const layout = f["layout"];
  const fail = (reason: string) => ({ count, xforms: { ok: false as const, reason } });
  if (!isObj(layout)) return fail("no layout");
  if (isObj(layout["linear"])) {
    const l = layout["linear"];
    const d1 = direction(ctx, l["dir"], entry, "/layout/linear/dir");
    const n1 = evalCount(l["count"], ctx.params);
    const s1 = evalNumber(l["spacing"], ctx.params);
    if (!d1.ok) return fail(d1.reason);
    if (!n1.ok) return fail(n1.reason);
    if (!s1.ok) return fail(s1.reason);
    let d2: M3 = [0, 0, 0];
    let n2 = 1;
    let s2 = 0;
    if (l["dir2"] !== undefined) {
      const dd = direction(ctx, l["dir2"], entry, "/layout/linear/dir2");
      const nn = l["count2"] === undefined ? { ok: true as const, value: 1 } : evalCount(l["count2"], ctx.params);
      const ss = evalNumber(l["spacing2"], ctx.params);
      if (!dd.ok) return fail(dd.reason);
      if (!nn.ok) return fail(nn.reason);
      if (!ss.ok) return fail(ss.reason);
      [d2, n2, s2] = [dd.value, nn.value, ss.value];
    }
    const two = l["dir2"] !== undefined;
    const out: Xform[] = [];
    for (let i = 0; i < n1.value; i++) {
      for (let j = 0; j < n2; j++) {
        if (i === 0 && j === 0) continue;
        if (!keep(two ? [i, j] : [i])) continue;
        const t = add(scale(d1.value, i * s1.value), scale(d2, j * s2));
        out.push({ point: (p) => add(p, t), dir: (d) => [d[0], d[1], d[2]] });
      }
    }
    return { count, xforms: { ok: true, value: out } };
  }
  if (isObj(layout["circular"])) {
    const c = layout["circular"];
    const ax = axisLine(ctx, c["axis"], entry, "/layout/circular/axis");
    const n = evalCount(c["count"], ctx.params);
    const ang = c["angle"] === undefined ? { ok: true as const, value: 360 } : evalNumber(c["angle"], ctx.params);
    if (!ax.ok) return fail(ax.reason);
    if (!n.ok) return fail(n.reason);
    if (!ang.ok) return fail(ang.reason);
    const step = ang.value === 360 ? 360 / n.value : ang.value / (n.value - 1);
    const out: Xform[] = [];
    for (let k = 1; k < n.value; k++) {
      if (!keep([k])) continue;
      const a = k * step;
      const { origin, dir } = ax.value;
      out.push({ point: (p) => rotateAbout(p, origin, dir, a), dir: (d) => rotateAbout(d, [0, 0, 0], dir, a) });
    }
    return { count, xforms: { ok: true, value: out } };
  }
  if (isObj(layout["mirror"])) {
    const fr = planeFrameV1(ctx, layout["mirror"]["plane"], entry, "/layout/mirror/plane");
    if (!fr.ok) return fail(fr.reason);
    if (!keep([1])) return { count, xforms: { ok: true, value: [] } };
    const { origin, normal } = fr.value;
    const reflect = (d: V3): M3 => sub(d, scale(normal, 2 * dot(d, normal)));
    return {
      count,
      xforms: { ok: true, value: [{ point: (p) => add(origin, reflect(sub(p, origin))), dir: reflect }] },
    };
  }
  return fail("unknown layout");
}

// ─── Holes and circles ─────────────────────────────────────────────────────────────────────

/** A hole as the hole checks see it. */
export interface HoleInstance {
  /** `<feature name>/<position id>` or `<sketch name>.<curve id>`, `#<n>` for pattern copies. */
  id: string;
  /** The part (name) whose timeline made it. */
  part: string;
  /** `hole`: a hole feature's instance (§6.5); `circle`: a full circle of a solved sketch. */
  source: "hole" | "circle";
  /** Diameter, mm. */
  diameter: number;
  /** Model-space centre (on the placement plane / sketch plane); absent when a pattern copy cannot be placed. */
  center?: V3;
  /** Unit axis (the drilling direction, or the sketch normal). */
  axis?: V3;
  /**
   * The stretch of the axis the hole or swept circle occupies, as `[from, to]` offsets along
   * `axis` from `center` (mm): a hole's `[0, depth]` (a through hole: to the far side of the
   * bodies it drilled, `Infinity` when the report lists none), an extrude's sweep range
   * (`[0, d]`, `[−d, 0]`, `[−d/2, d/2]`), `[0, 0]` for a revolve's profile circle.
   */
  span?: [number, number];
  /** The hole feature's report entry for this instance (hole instances only). */
  hole?: metricsV1.HoleReport;
  /** Why a pattern copy has no position. */
  unplaced?: string;
  /**
   * Why it is unknown whether this pattern copy exists: a body-seed pattern (§6.10) copies the
   * holes of the bodies it seeds, and the report cannot tell whether the seed lies on one of
   * them. A check that meets such a copy fails with this reason rather than guess a count.
   */
  uncertain?: string;
}

function seedHoleCopies(ctx: PartCtx, seeds: HoleInstance[], pattern: FeatureReportV1, f: Obj): HoleInstance[] {
  if (seeds.length === 0) return [];
  const { count, xforms } = patternXforms(ctx, f, pattern);
  const out: HoleInstance[] = [];
  /** A copy of `s` for instance `k` (1-based): what a copy keeps of its seed whatever its position. */
  const copy = (s: HoleInstance, k: number): HoleInstance => {
    const c: HoleInstance = { id: `${s.id}#${pattern.feature}.${k}`, part: s.part, source: s.source, diameter: s.diameter };
    if (s.span) c.span = [s.span[0], s.span[1]];
    if (s.hole) c.hole = s.hole;
    if (s.uncertain) c.uncertain = s.uncertain;
    return c;
  };
  if (!xforms.ok) {
    for (let k = 1; k <= count; k++) {
      for (const s of seeds) out.push({ ...copy(s, k), unplaced: `pattern ${pattern.feature}: ${xforms.reason}` });
    }
    return out;
  }
  xforms.value.forEach((x, k) => {
    for (const s of seeds) {
      const c = copy(s, k + 1);
      if (s.center && s.axis) {
        c.center = x.point(s.center);
        c.axis = x.dir(s.axis);
      } else {
        c.unplaced = s.unplaced ?? `the seed ${s.id} has no position`;
      }
      out.push(c);
    }
  });
  return out;
}

function solvedAsSketch(entry: FeatureReportV1): SketchFeature | null {
  const solved = entry.sketch?.solved;
  if (!solved) return null;
  const curves = solved.filter((c) => c.kind !== "point" && !c.construction);
  return { type: "sketch", id: entry.feature_id, name: entry.feature, plane: "XY", curves } as unknown as SketchFeature;
}

/** Which circles of swept sketches a census takes: {@link holesV1} (`holes`) or {@link curvesV1} (`curves`). */
type CircleCensus = "holes" | "curves";

/** Whether a RegionSelection id names curve `id`: the id itself, or a member of that compound curve. */
const selects = (sel: string, id: string) => id === sel || id.startsWith(`${sel}.`);

/**
 * The full circles of the sketch that the sweep `f` (an ok extrude or revolve) consumes, as the
 * census takes them:
 * - `curves`: every circle of the sketch;
 * - `holes`: the circles the sweep leaves as **holes**, from the sketch's regions (v0 §3.2: a
 *   loop at even depth is a region's outer loop, one at odd depth a hole of the region around
 *   it) and the sweep's `op` and `regions`: a `cut` removes the regions it selects, so the outer
 *   circle of a selected region is a hole (a circle inside one is a pin left standing);
 *   `new_body`, `join` and `intersect` keep the selected regions' material, so an inner circle
 *   of a selected region is a hole (an outer circle is a boss, a pin or a disc, never a hole).
 *   Revolves sweep circles into tori, never into holes along the sketch normal, so they take
 *   none. A sketch report without `regions` (an engine always reports them for an ok sketch)
 *   takes every circle.
 */
function sweepCircles(ctx: PartCtx, f: Obj, sk: FeatureReportV1, census: CircleCensus): HoleInstance[] {
  const solved = solvedAsSketch(sk);
  if (!solved) return [];
  let circles: SketchCircle[] = sketchCircles(solved);
  if (census === "holes") {
    if (f["type"] !== "extrude") return [];
    const regions = sk.regions;
    if (regions) {
      const sel = f["regions"];
      const selected = regions.map((r) => !Array.isArray(sel) || r.outer_curves.some((id) => (sel as unknown[]).some((x) => typeof x === "string" && selects(x, id))));
      const byId = new Map(solved.curves.map((c) => [c.id, c] as const));
      const loops = regions.map((r) => r.outer_curves.map((id) => byId.get(id)).filter((c): c is SketchCurve => c !== undefined));
      const cut = f["op"] === "cut";
      circles = circles.filter((c) => {
        const own = regions.findIndex((r) => c.curves.some((id) => r.outer_curves.includes(id)));
        if (cut) return own >= 0 && selected[own]!;
        if (own >= 0) return false;
        // An inner loop: a hole of the region around it, which is selected when all are, and
        // otherwise is the innermost region whose outer loop contains it.
        if (!Array.isArray(sel)) return true;
        const p: readonly [number, number] = [c.center[0] + c.radius, c.center[1]];
        let parent = -1;
        let area = Infinity;
        loops.forEach((loop, i) => {
          if (loop.length === 0 || !loopContains(loop, p)) return;
          const a = loopBoxArea(loop);
          if (a < area) [parent, area] = [i, a];
        });
        return parent >= 0 && selected[parent]!;
      });
    }
  }
  const frame = planeFrameV1(ctx, ctx.features.get(sk.feature_id)?.["plane"], sk, "/plane");
  const span = sweepSpan(ctx, f);
  return circles.map((c) => {
    const h: HoleInstance = { id: `${sk.feature}.${c.id}`, part: ctx.part, source: "circle", diameter: 2 * c.radius, span };
    if (frame.ok) {
      h.center = toModel(frame.value, c.center);
      h.axis = frame.value.normal;
    } else {
      h.unplaced = `sketch ${sk.feature}: ${frame.reason}`;
    }
    return h;
  });
}

/**
 * The stretch of the sketch normal an extrude sweeps (v0 §4.2): `[0, d]` (`normal`), `[−d, 0]`
 * (`reverse`), `[−d/2, d/2]` (`symmetric`); a revolve's circles, and an extrude whose distance
 * cannot be evaluated here, `[0, 0]` (the sketch plane only).
 */
function sweepSpan(ctx: PartCtx, f: Obj): [number, number] {
  if (f["type"] !== "extrude") return [0, 0];
  const d = evalNumber(f["distance"], ctx.params);
  if (!d.ok) return [0, 0];
  const dir = f["direction"] ?? "normal";
  return dir === "reverse" ? [-d.value, 0] : dir === "symmetric" ? [-d.value / 2, d.value / 2] : [0, d.value];
}

/** The eight corners of a body's box. */
function boxCorners(b: metricsV1.BodyReport): M3[] {
  const out: M3[] = [];
  for (const x of [b.bbox_min[0], b.bbox_max[0]]) for (const y of [b.bbox_min[1], b.bbox_max[1]]) for (const z of [b.bbox_min[2], b.bbox_max[2]]) out.push([x, y, z]);
  return out;
}

function holeFeatureInstances(ctx: PartCtx, entry: FeatureReportV1): HoleInstance[] {
  const bodies = entry.bodies ?? [];
  return (entry.holes ?? []).map((h) => {
    const axis = unit(h.axis) ?? h.axis;
    // A through hole reaches the far side of the bodies the feature drilled (their boxes).
    const reach = bodies.length === 0 ? Infinity : Math.max(0, ...bodies.flatMap(boxCorners).map((c) => dot(sub(c, h.center), axis)));
    return {
      id: `${entry.feature}/${h.at}`,
      part: ctx.part,
      source: "hole" as const,
      diameter: h.d,
      center: h.center,
      axis,
      span: [0, h.depth ?? reach] as [number, number],
      hole: h,
    };
  });
}

// ─── Which bodies carry each hole (for body-seed patterns) ─────────────────────────────────

/** A body's origin as one string (`feature/member`, `@i` or `@i.j` for a pattern instance). */
function originKey(o: metricsV1.Origin): string {
  return `${o.feature}/${o.member}${o.instance ? `@${o.instance.join(".")}` : ""}`;
}

/** The origin (as {@link originKey}) a body key `F/body:m[@i[.j]]` (§5.2 rule 7) names, or null. */
function bodyKeyOrigin(key: string): string | null {
  const k = parseKey(key);
  if (!k || k.faces || !k.role.startsWith("body:")) return null;
  return `${k.fid}/${unescapeKey(k.role.slice(5))}${k.qual !== undefined ? `@${unescapeKey(k.qual)}` : ""}`;
}

/** Whether the segment p0–p1 meets the box of `b` grown by `1e-6·max(1, diag)` (slab test). */
function segmentMeetsBox(p0: V3, p1: V3, b: metricsV1.BodyReport): boolean {
  const diag = Math.hypot(b.bbox_max[0] - b.bbox_min[0], b.bbox_max[1] - b.bbox_min[1], b.bbox_max[2] - b.bbox_min[2]);
  const tol = 1e-6 * Math.max(1, diag);
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 3; i++) {
    const [lo, hi] = [b.bbox_min[i]! - tol, b.bbox_max[i]! + tol];
    const d = p1[i]! - p0[i]!;
    if (Math.abs(d) < 1e-15) {
      if (p0[i]! < lo || p0[i]! > hi) return false;
      continue;
    }
    const [ta, tb] = [(lo - p0[i]!) / d, (hi - p0[i]!) / d];
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The bodies (origins) of `bodies` a hole or swept circle may lie on: those whose box meets the
 * stretch of its axis it occupies ({@link HoleInstance.span}, an infinite end clipped to the
 * sweep's start). A hole that meets none (it must lie on a body it drilled) and a copy without a
 * position may lie on any of them (`mustLieOnOne`: also a hole carried into a join's result).
 * The set may be wider than the truth, never narrower, except for a swept circle that meets no
 * body's box: it made no hole on any body.
 */
function carriersOf(h: HoleInstance, bodies: readonly metricsV1.BodyReport[], mustLieOnOne = h.source === "hole"): Set<string> {
  const all = () => new Set(bodies.map((b) => originKey(b.origin)));
  if (!h.center || !h.axis) return all();
  const [s0, s1] = h.span ?? [0, 0];
  const p0 = add(h.center, scale(h.axis, Number.isFinite(s0) ? s0 : 0));
  const p1 = add(h.center, scale(h.axis, Number.isFinite(s1) ? s1 : 0));
  const hit = bodies.filter((b) => segmentMeetsBox(p0, p1, b));
  if (hit.length === 0 && mustLieOnOne) return all();
  return new Set(hit.map((b) => originKey(b.origin)));
}

/** Whether a feature's `removed` bodies (and consumed tools) are merged into its result bodies (a join) rather than cut away. */
function mergesBodies(ctx: PartCtx, f: Obj | undefined): boolean {
  if (!f) return false;
  if (f["type"] === "pattern") {
    const seed = f["seed"];
    if (isObj(seed) && Array.isArray(seed["features"])) return (seed["features"] as string[]).some((id) => ctx.features.get(id)?.["op"] === "join");
    return f["op"] === "join";
  }
  return f["op"] === "join";
}

/**
 * The origins a successful feature takes out of the part: its `removed` origins (§6.0.5) and,
 * for a `boolean` without `keep_tools`, its tool bodies (consumed tools are never listed, §6.0.5).
 */
function consumedBy(entry: FeatureReportV1, f: Obj | undefined): Set<string> {
  const out = new Set((entry.removed ?? []).map(originKey));
  if (f?.["type"] === "boolean" && f["keep_tools"] !== true) {
    for (const m of entry.refs?.find((r) => r.field === "/tools")?.members ?? []) {
      const o = bodyKeyOrigin(m.key);
      if (o) out.add(o);
    }
  }
  return out;
}

/**
 * The copies a **body-seed** pattern (§6.10 `seed: { bodies }`) makes of the holes and swept
 * circles on the bodies it copies. The seed's bodies are the resolved members of its
 * `/seed/bodies` reference in the report (body keys, §5.2 rule 7); each earlier hole of the part
 * is on the bodies `carriers` records for it. A hole whose carriers are all seeded is copied; one
 * with no seeded carrier is not; one with some (the report cannot tell which body it is on), or
 * any hole when the seed's bodies cannot be read, gives copies marked {@link HoleInstance.uncertain}.
 */
function bodySeedCopies(ctx: PartCtx, entry: FeatureReportV1, f: Obj, earlier: readonly HoleInstance[], carriers: ReadonlyMap<HoleInstance, Set<string>>): HoleInstance[] {
  const ref = entry.refs?.find((r) => r.field === "/seed/bodies");
  const keys = ref && ref.status !== "failed" ? ref.members.map((m) => bodyKeyOrigin(m.key)) : [];
  const readable = keys.length > 0 && keys.every((k) => k !== null);
  const seeded = new Set(keys.filter((k): k is string => k !== null));
  const seeds: HoleInstance[] = [];
  for (const h of earlier) {
    const on = [...(carriers.get(h) ?? [])];
    if (on.length === 0) continue; // on no body any more (cut away, or never made)
    const n = on.filter((o) => seeded.has(o)).length;
    if (readable && n === on.length) {
      seeds.push(h);
    } else if (!readable || n > 0) {
      const why = readable
        ? `pattern ${entry.feature} copies the bodies ${[...seeded].join(", ")}, and ${h.id} may lie on ${on.join(" or ")}: the report cannot tell whether it is copied`
        : `pattern ${entry.feature} copies bodies its report does not name (no resolved /seed/bodies body keys): whether ${h.id} is copied cannot be told`;
      seeds.push({ ...h, uncertain: h.uncertain ?? why });
    }
  }
  return seedHoleCopies(ctx, seeds, entry, f);
}

/**
 * The instances of successful hole features, the circles of successful sweeps
 * ({@link sweepCircles}), and the copies successful patterns make of both (hole seeds; the
 * circles of extrude and revolve seeds), in timeline order, with a sketch circle that coincides
 * with a hole instance counted once ({@link withoutDoubleDrawnCircles}).
 */
function circleCensus(s: SubjectV1, census: CircleCensus): HoleInstance[] {
  const out: HoleInstance[] = [];
  for (const ctx of partContexts(s)) {
    const byFeature = new Map<string, HoleInstance[]>();
    const seen = new Set<string>();
    const mineSoFar: HoleInstance[] = [];
    /** The bodies (origins) each hole of this part may lie on, kept up to date through the timeline. */
    const carriers = new Map<HoleInstance, Set<string>>();
    for (const entry of s.report.features.filter((e) => e.part === ctx.part)) {
      if (entry.status !== "ok") continue;
      const f = ctx.features.get(entry.feature_id);
      let mine: HoleInstance[] = [];
      if (entry.type === "hole") mine = holeFeatureInstances(ctx, entry);
      else if ((entry.type === "extrude" || entry.type === "revolve") && f) {
        const sk = ctx.entries.get(String(f["sketch"]));
        if (sk?.status === "ok") mine = sweepCircles(ctx, f, sk, census);
      } else if (entry.type === "pattern" && f) {
        const seed = f["seed"];
        if (isObj(seed) && Array.isArray(seed["features"])) {
          const seeds = (seed["features"] as string[]).flatMap((id) => byFeature.get(id) ?? []);
          mine = seedHoleCopies(ctx, seeds, entry, f);
        } else if (isObj(seed) && seed["bodies"] !== undefined) {
          mine = bodySeedCopies(ctx, entry, f, mineSoFar, carriers);
        }
      }
      // Bodies this feature takes out of the part: a join carries their holes on into the
      // result body around them; a cut or a consumed tool takes them away.
      const consumed = consumedBy(entry, f);
      if (consumed.size > 0) {
        const merges = mergesBodies(ctx, f);
        for (const h of mineSoFar) {
          const on = carriers.get(h)!;
          if (![...on].some((o) => consumed.has(o))) continue;
          for (const o of consumed) on.delete(o);
          if (merges) for (const o of carriersOf(h, entry.bodies ?? [], true)) on.add(o);
        }
      }
      for (const h of mine) carriers.set(h, carriersOf(h, entry.bodies ?? []));
      byFeature.set(entry.feature_id, entry.type === "pattern" ? [] : mine);
      // A sketch swept twice has its circles once.
      for (const h of mine) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        mineSoFar.push(h);
      }
    }
    out.push(...mineSoFar);
  }
  return withoutDoubleDrawnCircles(out);
}

/**
 * Every hole of the model as the hole checks see it: hole feature instances, the circles that
 * sweeps leave as holes (a `cut`'s outer circles, the inner circles of a `new_body`, `join` or
 * `intersect` extrude: {@link sweepCircles}), and the pattern copies of both.
 */
export function holesV1(s: SubjectV1): HoleInstance[] {
  return circleCensus(s, "holes");
}

/**
 * Every full circle that makes geometry, as `hole_positions` / `hole_pattern` with
 * `circles: "all"` see them: every circle of the sketches successful sweeps consume (bosses,
 * pins and beads as well as holes), every hole instance, and the pattern copies of both.
 */
export function circlesV1(s: SubjectV1): HoleInstance[] {
  return circleCensus(s, "curves");
}

/**
 * Sketch circles that coincide with a hole instance, which is then that hole drawn twice: the
 * same part, the same diameter, centred on its axis, and the stretch of the axis the circle's
 * sweep occupies ({@link HoleInstance.span}) overlapping the hole's. Two coaxial holes of one
 * diameter in different parts, or in one part at different places along the axis, stay two.
 * A copy whose existence is uncertain removes nothing.
 */
function withoutDoubleDrawnCircles(holes: HoleInstance[]): HoleInstance[] {
  const instances = holes.filter((h) => h.source === "hole" && h.center && h.axis && !h.uncertain);
  const sameHole = (c: HoleInstance, h: HoleInstance) => {
    if (c.part !== h.part || Math.abs(h.diameter - c.diameter) > 1e-6) return false;
    const a = h.axis!;
    const along = dot(c.axis!, a);
    if (Math.abs(Math.abs(along) - 1) > 1e-9) return false;
    const v = sub(c.center!, h.center!);
    const t = dot(v, a);
    if (len(sub(v, scale(a, t))) > 1e-6) return false;
    // The circle's stretch, as offsets along the hole's axis from the hole's centre.
    const [c0, c1] = (c.span ?? [0, 0]).map((x) => t + Math.sign(along) * x) as [number, number];
    const [h0, h1] = h.span ?? [0, Infinity];
    return Math.min(c0, c1) <= h1 + 1e-6 && Math.max(c0, c1) >= h0 - 1e-6;
  };
  return holes.filter((c) => c.source !== "circle" || !c.center || !c.axis || c.uncertain || !instances.some((h) => sameHole(c, h)));
}

/**
 * The logical curves `curve_count` counts on a v1 model, with the hole checks' rules for what
 * makes geometry: the lines and arcs of every sketch a successful extrude or revolve consumes
 * (compound members expanded, construction curves and points left out; a sketch that only
 * places holes, or nothing, makes no geometry), and one circle each for every full circle of
 * those sketches (a circle drawn as arcs counted once), every hole feature instance, and every
 * pattern copy of either — a sketch circle that coincides with a hole instance (a hole cut from a
 * circle and drilled there, or marked by one) counted once. A circle copied by a body-seed
 * pattern that may not be on the bodies it copies carries the reason (`uncertain`), and
 * `curve_count` fails with it rather than count it.
 */
export function curvesV1(s: SubjectV1): (LogicalCurve & { uncertain?: string })[] {
  const out: (LogicalCurve & { uncertain?: string })[] = [];
  for (const ctx of partContexts(s)) {
    const swept = new Set<string>();
    for (const [id, f] of ctx.features) {
      if ((f["type"] === "extrude" || f["type"] === "revolve") && ctx.entries.get(id)?.status === "ok") swept.add(String(f["sketch"]));
    }
    for (const e of s.report.features) {
      if (e.part !== ctx.part || e.status !== "ok" || e.type !== "sketch" || !swept.has(e.feature_id)) continue;
      const sk = solvedAsSketch(e);
      if (sk) out.push(...logicalCurves(sk).filter((c) => c.kind !== "circle"));
    }
  }
  for (const h of circleCensus(s, "curves")) out.push(h.uncertain ? { kind: "circle", diameter: h.diameter, uncertain: `${h.id}: ${h.uncertain}` } : { kind: "circle", diameter: h.diameter });
  return out;
}

// ─── Blends, shells, parameters, references ────────────────────────────────────────────────

/** One successful fillet or chamfer: its edge count and evaluated size (r, or chamfer d). */
export interface BlendInfo {
  feature: string;
  type: "fillet" | "chamfer";
  edges: number;
  size: Evaluated;
}

export function blendsV1(s: SubjectV1): BlendInfo[] {
  const out: BlendInfo[] = [];
  for (const e of s.report.features) {
    if (e.status !== "ok" || (e.type !== "fillet" && e.type !== "chamfer")) continue;
    const blend = e.type === "fillet" ? e.fillet : e.chamfer;
    const ir = irFeatureOf(s, e);
    const size: Evaluated = ir ? evalNumber(ir.feature[e.type === "fillet" ? "r" : "d"], ir.params) : { ok: false, reason: `no IR for ${e.feature}` };
    out.push({ feature: e.feature, type: e.type, edges: blend?.edges.length ?? 0, size });
  }
  return out;
}

/** One successful shell: its evaluated thickness and the number of opened faces. */
export interface ShellInfo {
  feature: string;
  thickness: Evaluated;
  open: number;
}

export function shellsV1(s: SubjectV1): ShellInfo[] {
  const out: ShellInfo[] = [];
  for (const e of s.report.features) {
    if (e.status !== "ok" || e.type !== "shell") continue;
    const ir = irFeatureOf(s, e);
    out.push({
      feature: e.feature,
      thickness: ir ? evalNumber(ir.feature["thickness"], ir.params) : { ok: false, reason: `no IR for ${e.feature}` },
      open: e.shell?.removed_faces.length ?? 0,
    });
  }
  return out;
}

/**
 * The unstable reference fields of a candidate (`ref_stability`), one line each:
 * - every reference field whose resolution is not `exact` (accepted with warnings, or failed);
 * - with a context model (T4 edits), every reference field of a context feature (matched by
 *   feature **id**, the persistent identity; fields by JSON pointer) that the candidate resolves
 *   to a different multiset of member keys, or no longer has (the feature is gone, suppressed or
 *   failed without that field).
 *
 * The comparison is what makes the check meaningful: a reference without a capture (CadScript
 * v1 compiles none) re-evaluates its query and reports `exact` whenever it resolves (SPEC-v1 §5.7
 * step 2), so its status alone cannot tell a fillet that kept its edges from one that now rounds
 * different edges. Keys are provenance keys (§5.2): the edit may move and resize the entities but
 * must keep designating the same ones. Features the candidate adds have no context to compare
 * with; only their status counts. `type` restricts both sides to one feature type.
 */
export function refChanges(candidate: SubjectV1, context: SubjectV1 | undefined, type?: string): string[] {
  const out = new Map<string, string>();
  const keep = (f: FeatureReportV1) => type === undefined || f.type === type;
  const keysOf = (r: metricsV1.RefReport) => r.members.map((m) => m.key).sort();
  for (const f of candidate.report.features.filter(keep)) {
    for (const r of f.refs ?? []) {
      if (r.status !== "exact") out.set(`${f.feature_id}${r.field}`, `${f.feature}${r.field} is ${r.status}${r.code ? ` (${r.code})` : ""}`);
    }
  }
  if (context) {
    const byId = new Map(candidate.report.features.map((f) => [f.feature_id, f] as const));
    for (const cf of context.report.features.filter(keep)) {
      for (const cr of cf.refs ?? []) {
        const id = `${cf.feature_id}${cr.field}`;
        if (out.has(id)) continue;
        const f = byId.get(cf.feature_id);
        const r = f?.refs?.find((x) => x.field === cr.field);
        if (!f || !r) {
          out.set(id, `${cf.feature}${cr.field} is gone (${!f ? "no such feature" : `${f.status}, no such reference`})`);
          continue;
        }
        const [was, now] = [keysOf(cr), keysOf(r)];
        if (was.length !== now.length || was.some((k, i) => k !== now[i])) {
          const added = now.filter((k) => !was.includes(k)).length;
          const removed = was.filter((k) => !now.includes(k)).length;
          out.set(id, `${cf.feature}${cr.field} now selects ${now.length} (was ${was.length}: ${added} added, ${removed} removed)`);
        }
      }
    }
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
}

/** Parameter changes between two v1 documents (added, removed, or a different unit/value/bounds). */
export function paramChanges(before: DocV1, after: DocV1): string[] {
  const all = (d: DocV1) => {
    const m = new Map<string, unknown>();
    for (const p of d.params ?? []) m.set(p.name, { unit: p.unit, value: p.value, min: p.min, max: p.max });
    for (const part of d.parts) for (const p of part.params ?? []) m.set(p.name, { unit: p.unit, value: p.value, min: p.min, max: p.max });
    return m;
  };
  const a = all(before);
  const b = all(after);
  const out: string[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (JSON.stringify(a.get(name)) !== JSON.stringify(b.get(name))) out.push(name);
  }
  return out;
}

/**
 * The document with parameters set to literal values (the command layer's `setParam`, SPEC-v1
 * §2.1): each name is looked up in the document's parameters, then each part's. Returns the
 * names it could not find.
 */
export function withParams(doc: DocV1, set: Readonly<Record<string, number | boolean>>): { doc: DocV1; missing: string[] } {
  const out = structuredClone(doc);
  const missing: string[] = [];
  for (const [name, value] of Object.entries(set)) {
    const lists = [out.params ?? [], ...out.parts.map((p) => p.params ?? [])];
    const p = lists.flat().find((x) => x.name === name);
    if (!p) missing.push(name);
    else (p as { value: unknown }).value = value;
  }
  return { doc: out, missing };
}
