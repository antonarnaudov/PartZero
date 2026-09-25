/**
 * Measuring the current selection: one entity (position, length, radius/diameter, area, body
 * volume), two entities (minimum distance, angle, centre distance, axis deltas), or several
 * (total length / total area). Exact wherever the geometry is (see `geometry.ts`); approximate
 * results are flagged and shown with "≈".
 */
import type { EvalReport } from "@aicad/ir-types";
import { edgeGeom, faceGeom, type EdgeGeom, type FaceGeom } from "./geometry";
import { facesOfEdgeName, facesOfVertex } from "../selection/picking";
import { edgePoints, faceTriangles, type SceneTopology } from "../selection/topology";
import type { EntityItem, SelectionItem } from "../selection/types";
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../viewport/view-camera";

export type MeasureUnit = "mm" | "mm²" | "mm³" | "°";

export interface Measurement {
  /** Stable id, e.g. `distance`, `angle`, `radius`. */
  id: string;
  label: string;
  value: number;
  unit: MeasureUnit;
  exact: boolean;
  /** For a distance: the two closest points (drawn as a dimension line). */
  from?: Vec3;
  to?: Vec3;
}

export interface MeasureResult {
  /** What was measured, e.g. "Edge", "Face ↔ Face". */
  title: string;
  rows: Measurement[];
}

type Geom =
  | { kind: "point"; p: Vec3 }
  | { kind: "edge"; g: EdgeGeom; points: Vec3[] }
  | { kind: "face"; g: FaceGeom; tris: Vec3[][] }
  | { kind: "body"; name: string };

function geomOf(topo: SceneTopology, it: SelectionItem): Geom | null {
  if (it.kind === "body") return topo.bodies.has(it.body) ? { kind: "body", name: it.body } : null;
  if (it.kind !== "face" && it.kind !== "edge" && it.kind !== "vertex") return null;
  const b = topo.bodies.get((it as EntityItem).body);
  if (!b) return null;
  if (it.kind === "vertex") {
    const v = b.vertices.get(it.key);
    const p = v?.point ?? it.point;
    return p ? { kind: "point", p } : null;
  }
  if (it.kind === "edge") {
    const e = b.edges.get(it.key);
    return e ? { kind: "edge", g: edgeGeom(e), points: edgePoints(e) } : null;
  }
  const g = faceGeom(b, it.key);
  return g ? { kind: "face", g, tris: faceTriangles(b, it.key) } : null;
}

// ─── Closest points ────────────────────────────────────────────────────────────────────────

export function closestOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2)) : 0;
  return add(a, scale(ab, t));
}

/** Closest point of triangle abc to p (Ericson, Real-Time Collision Detection §5.1.5). */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return add(a, scale(ab, d1 / (d1 - d3)));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return add(a, scale(ac, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return add(b, scale(sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
  const denom = 1 / (va + vb + vc);
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)));
}

/** Closest points between segments p0p1 and q0q1 (Ericson §5.1.9). */
export function closestSegmentSegment(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3): [Vec3, Vec3] {
  const d1 = sub(p1, p0);
  const d2 = sub(q1, q0);
  const r = sub(p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-24 && e <= 1e-24) return [p0, q0];
  if (a <= 1e-24) {
    s = 0;
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = dot(d1, r);
    if (e <= 1e-24) {
      t = 0;
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-24 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  return [add(p0, scale(d1, s)), add(q0, scale(d2, t))];
}

/** Primitive sets for a generic minimum distance: points, segments, triangles. */
interface Prims {
  points: Vec3[];
  segments: Array<[Vec3, Vec3]>;
  tris: Vec3[][];
}

function primsOf(g: Geom, topo: SceneTopology): Prims {
  if (g.kind === "point") return { points: [g.p], segments: [], tris: [] };
  if (g.kind === "edge") {
    const segs: Array<[Vec3, Vec3]> = [];
    for (let i = 1; i < g.points.length; i++) segs.push([g.points[i - 1]!, g.points[i]!]);
    return { points: [], segments: segs, tris: [] };
  }
  if (g.kind === "face") return { points: [], segments: [], tris: g.tris };
  const b = topo.bodies.get(g.name);
  const tris: Vec3[][] = [];
  for (const f of b?.faces.keys() ?? []) tris.push(...faceTriangles(b!, f));
  return { points: [], segments: [], tris };
}

/** Sample points of a primitive set (for the triangle–triangle case). */
function samples(p: Prims): Vec3[] {
  const out = [...p.points];
  for (const [a, b] of p.segments) out.push(a, b, scale(add(a, b), 0.5));
  for (const t of p.tris) out.push(t[0]!, t[1]!, t[2]!, scale(add(add(t[0]!, t[1]!), t[2]!), 1 / 3));
  return out;
}

function closestToPrims(q: Vec3, p: Prims): Vec3 {
  let best: Vec3 = p.points[0] ?? p.segments[0]?.[0] ?? p.tris[0]?.[0] ?? q;
  let bd = length(sub(best, q));
  const consider = (c: Vec3): void => {
    const d = length(sub(c, q));
    if (d < bd) {
      bd = d;
      best = c;
    }
  };
  for (const x of p.points) consider(x);
  for (const [a, b] of p.segments) consider(closestOnSegment(q, a, b));
  for (const t of p.tris) consider(closestOnTriangle(q, t[0]!, t[1]!, t[2]!));
  return best;
}

/** Minimum distance between two primitive sets (exact for point/segment pairs, sampled otherwise). */
function minDistance(a: Prims, b: Prims): { d: number; from: Vec3; to: Vec3; sampled: boolean } {
  let best = { d: Infinity, from: [0, 0, 0] as Vec3, to: [0, 0, 0] as Vec3, sampled: false };
  const take = (x: Vec3, y: Vec3, sampled: boolean): void => {
    const d = length(sub(x, y));
    if (d < best.d) best = { d, from: x, to: y, sampled };
  };
  // Segment–segment pairs are exact.
  for (const [p0, p1] of a.segments) for (const [q0, q1] of b.segments) {
    const [x, y] = closestSegmentSegment(p0, p1, q0, q1);
    take(x, y, false);
  }
  // Points against everything (exact).
  for (const x of a.points) take(x, closestToPrims(x, b), false);
  for (const y of b.points) take(closestToPrims(y, a), y, false);
  // Triangles: sample the other set's points (vertices, midpoints, centroids) both ways.
  const triInvolved = a.tris.length > 0 || b.tris.length > 0;
  if (triInvolved) {
    const sampled = a.points.length + b.points.length === 0;
    for (const x of cap(samples(a))) take(x, closestToPrims(x, b), sampled);
    for (const y of cap(samples(b))) take(closestToPrims(y, a), y, sampled);
  }
  return best;
}

function cap<T>(xs: T[], n = 4000): T[] {
  if (xs.length <= n) return xs;
  const step = xs.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.floor(i * step)]!);
  return out;
}

// ─── Angles ────────────────────────────────────────────────────────────────────────────────

function angleBetween(u: Vec3, v: Vec3): number {
  const c = Math.max(-1, Math.min(1, dot(normalize(u), normalize(v))));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Direction of a geometry for angle purposes: line direction, plane normal, cylinder axis. */
function directionOf(g: Geom): { dir: Vec3; kind: "line" | "normal" } | null {
  if (g.kind === "edge" && g.g.type === "line") return { dir: g.g.dir, kind: "line" };
  if (g.kind === "edge" && g.g.type === "circle") return { dir: g.g.normal, kind: "normal" };
  if (g.kind === "face" && g.g.type === "plane") return { dir: g.g.normal, kind: "normal" };
  if (g.kind === "face" && g.g.type === "cylinder") return { dir: g.g.axis, kind: "line" };
  return null;
}

/** A centre for centre-to-centre distances: circle centre, cylinder axis point, vertex. */
function centreOf(g: Geom): { p: Vec3; axis?: Vec3 } | null {
  if (g.kind === "point") return { p: g.p };
  if (g.kind === "edge" && g.g.type === "circle") return { p: g.g.center, axis: g.g.normal };
  if (g.kind === "face" && g.g.type === "cylinder") return { p: g.g.point, axis: g.g.axis };
  return null;
}

// ─── Body metrics from the report (exact) ──────────────────────────────────────────────────

interface BodyMetricsLike {
  volume: number;
  area: number;
  centroid: [number, number, number];
  bbox_min: [number, number, number];
  bbox_max: [number, number, number];
}

/** The report's metrics of a render body (`part/feature` or `part/feature#i`). */
export function bodyMetrics(report: EvalReport | null | undefined, name: string): BodyMetricsLike | null {
  const features = (report as { features?: Array<{ part?: string; feature?: string; bodies?: BodyMetricsLike[] }> } | null | undefined)?.features;
  for (const f of features ?? []) {
    const bodies = f.bodies ?? [];
    for (let i = 0; i < bodies.length; i++) {
      const n = bodies.length === 1 ? `${f.part}/${f.feature}` : `${f.part}/${f.feature}#${i}`;
      if (n === name) return bodies[i]!;
    }
  }
  return null;
}

// ─── Measure ───────────────────────────────────────────────────────────────────────────────

const row = (id: string, label: string, value: number, unit: MeasureUnit, exact: boolean, extra: Partial<Measurement> = {}): Measurement => ({ id, label, value, unit, exact, ...extra });

function single(g: Geom, report: EvalReport | null | undefined, topo: SceneTopology): MeasureResult {
  if (g.kind === "point") {
    return { title: "Vertex", rows: [row("x", "X", g.p[0], "mm", true), row("y", "Y", g.p[1], "mm", true), row("z", "Z", g.p[2], "mm", true)] };
  }
  if (g.kind === "edge") {
    const e = g.g;
    if (e.type === "line") return { title: "Line edge", rows: [row("length", "Length", e.length, "mm", true)] };
    if (e.type === "circle") {
      return {
        title: e.closed ? "Circle edge" : "Arc edge",
        rows: [
          row("radius", "Radius", e.radius, "mm", true),
          row("diameter", "Diameter", e.radius * 2, "mm", true),
          row("length", e.closed ? "Circumference" : "Arc length", e.length, "mm", true),
          ...(e.closed ? [] : [row("sweep", "Sweep", (e.sweep * 180) / Math.PI, "°", true)]),
          row("cx", "Centre X", e.center[0], "mm", true),
          row("cy", "Centre Y", e.center[1], "mm", true),
          row("cz", "Centre Z", e.center[2], "mm", true),
        ],
      };
    }
    return { title: "Curve edge", rows: [row("length", "Length", e.length, "mm", false)] };
  }
  if (g.kind === "face") {
    const f = g.g;
    if (f.type === "plane") return { title: "Planar face", rows: [row("area", "Area", f.area, "mm²", f.exact)] };
    if (f.type === "cylinder") {
      return {
        title: f.inner ? "Cylindrical face (hole)" : "Cylindrical face",
        rows: [row("radius", "Radius", f.radius, "mm", true), row("diameter", "Diameter", f.radius * 2, "mm", true), row("area", "Area", f.area, "mm²", f.exact)],
      };
    }
    return { title: "Face", rows: [row("area", "Area", f.area, "mm²", false)] };
  }
  const m = bodyMetrics(report, g.name);
  if (m) {
    return {
      title: "Body",
      rows: [
        row("volume", "Volume", m.volume, "mm³", true),
        row("area", "Surface area", m.area, "mm²", true),
        row("sx", "Size X", m.bbox_max[0] - m.bbox_min[0], "mm", true),
        row("sy", "Size Y", m.bbox_max[1] - m.bbox_min[1], "mm", true),
        row("sz", "Size Z", m.bbox_max[2] - m.bbox_min[2], "mm", true),
      ],
    };
  }
  const b = topo.bodies.get(g.name);
  const bb = b?.bbox;
  return {
    title: "Body",
    rows: bb
      ? [row("sx", "Size X", bb.max[0] - bb.min[0], "mm", false), row("sy", "Size Y", bb.max[1] - bb.min[1], "mm", false), row("sz", "Size Z", bb.max[2] - bb.min[2], "mm", false)]
      : [],
  };
}

/**
 * Topologically touching entities (adjacent faces, a face and its boundary edge, edges sharing a
 * vertex, a vertex on its edge or face): their distance is exactly 0. Returns a contact point.
 */
export function contactPoint(topo: SceneTopology, x: SelectionItem, y: SelectionItem): Vec3 | null {
  if (!isEntityItem(x) || !isEntityItem(y) || x.body !== y.body) return null;
  const b = topo.bodies.get(x.body);
  if (!b) return null;
  const [p, q] = x.kind <= y.kind ? [x, y] : [y, x];
  const firstPoint = (edge: string): Vec3 | null => {
    const e = b.edges.get(edge);
    return e && e.points.length >= 3 ? [e.points[0]!, e.points[1]!, e.points[2]!] : null;
  };
  if (p.kind === "face" && q.kind === "face") {
    for (const e of b.edges.values()) {
      const fs = facesOfEdgeName(e.name);
      if (fs.includes(p.key) && fs.includes(q.key)) return firstPoint(e.name);
    }
    return null;
  }
  if (p.kind === "edge" && q.kind === "face") return facesOfEdgeName(p.key).includes(q.key) ? firstPoint(p.key) : null;
  if (p.kind === "edge" && q.kind === "vertex") return b.vertices.get(q.key)?.edges.includes(p.key) ? (b.vertices.get(q.key)?.point ?? null) : null;
  if (p.kind === "face" && q.kind === "vertex") {
    const v = b.vertices.get(q.key);
    return v && facesOfVertex(v).has(p.key) ? v.point : null;
  }
  if (p.kind === "edge" && q.kind === "edge") {
    for (const v of b.vertices.values()) if (v.edges.includes(p.key) && v.edges.includes(q.key)) return v.point;
  }
  return null;
}

function isEntityItem(it: SelectionItem): it is EntityItem {
  return it.kind === "face" || it.kind === "edge" || it.kind === "vertex";
}

function pair(a: Geom, b: Geom, topo: SceneTopology, contact: Vec3 | null = null): MeasureResult {
  const rows: Measurement[] = [];
  const kindName = (g: Geom): string => (g.kind === "point" ? "Vertex" : g.kind === "edge" ? "Edge" : g.kind === "face" ? "Face" : "Body");
  const title = `${kindName(a)} ↔ ${kindName(b)}`;

  // Parallel planes: the exact perpendicular offset.
  const da = directionOf(a);
  const db = directionOf(b);
  let parallelDistance: Measurement | null = null;
  if (contact) {
    // Touching (they share an edge or a vertex): exactly 0.
    parallelDistance = row("distance", "Distance (touching)", 0, "mm", true);
  } else if (a.kind === "face" && b.kind === "face" && a.g.type === "plane" && b.g.type === "plane" && length(cross(a.g.normal, b.g.normal)) < 1e-6) {
    const d = Math.abs(dot(sub(b.g.point, a.g.point), a.g.normal));
    const from = a.g.centroid;
    const to = sub(from, scale(a.g.normal, dot(sub(from, b.g.point), a.g.normal)));
    parallelDistance = row("distance", "Distance (parallel planes)", d, "mm", true, { from, to });
  } else if (a.kind === "point" && b.kind === "face" && b.g.type === "plane") {
    // Point to plane: exact when the foot of the perpendicular lies on the face.
    const n = b.g.normal;
    const foot = sub(a.p, scale(n, dot(sub(a.p, b.g.point), n)));
    if (b.tris.some((t) => length(sub(closestOnTriangle(foot, t[0]!, t[1]!, t[2]!), foot)) < 1e-6)) {
      parallelDistance = row("distance", "Distance", Math.abs(dot(sub(a.p, b.g.point), n)), "mm", true, { from: a.p, to: foot });
    }
  } else if (b.kind === "point" && a.kind === "face" && a.g.type === "plane") {
    return pair(b, a, topo, contact);
  }
  if (parallelDistance) rows.push(parallelDistance);
  else {
    const pa = primsOf(a, topo);
    const pb = primsOf(b, topo);
    const m = minDistance(pa, pb);
    const exactPrims = pa.tris.length === 0 && pb.tris.length === 0 && [a, b].every((g) => g.kind === "point" || (g.kind === "edge" && g.g.type === "line"));
    rows.push(row("distance", "Minimum distance", m.d, "mm", exactPrims, { from: m.from, to: m.to }));
  }

  // Point–point deltas.
  if (a.kind === "point" && b.kind === "point") {
    const d = sub(b.p, a.p);
    rows.push(row("dx", "ΔX", Math.abs(d[0]), "mm", true), row("dy", "ΔY", Math.abs(d[1]), "mm", true), row("dz", "ΔZ", Math.abs(d[2]), "mm", true));
  }

  // Centre-to-centre (circles, cylinders, vertices), and axis-to-axis for parallel axes.
  const ca = centreOf(a);
  const cb = centreOf(b);
  if (ca && cb && (ca.axis || cb.axis)) {
    if (ca.axis && cb.axis && length(cross(ca.axis, cb.axis)) < 1e-6) {
      const off = sub(cb.p, ca.p);
      const perp = sub(off, scale(ca.axis, dot(off, ca.axis)));
      rows.push(row("axis", "Axis distance", length(perp), "mm", true, { from: ca.p, to: add(ca.p, perp) }));
    } else {
      rows.push(row("centre", "Centre distance", length(sub(cb.p, ca.p)), "mm", true, { from: ca.p, to: cb.p }));
    }
  }

  // Angle.
  if (da && db) {
    let ang = angleBetween(da.dir, db.dir);
    if (da.kind === db.kind) {
      // Lines and normals are unoriented here: report the acute angle between lines, and the
      // angle between planes as the angle between their normals folded to [0, 90].
      ang = Math.min(ang, 180 - ang);
    } else {
      // Line vs plane: complement of the line–normal angle.
      ang = Math.abs(90 - Math.min(ang, 180 - ang));
    }
    rows.push(row("angle", "Angle", ang, "°", true));
  }
  return { title, rows };
}

function many(gs: Geom[]): MeasureResult {
  const rows: Measurement[] = [];
  const edges = gs.filter((g): g is Extract<Geom, { kind: "edge" }> => g.kind === "edge");
  const faces = gs.filter((g): g is Extract<Geom, { kind: "face" }> => g.kind === "face");
  if (edges.length > 0) rows.push(row("length", `Total length (${edges.length} edges)`, edges.reduce((s, e) => s + e.g.length, 0), "mm", edges.every((e) => e.g.exact)));
  if (faces.length > 0) rows.push(row("area", `Total area (${faces.length} faces)`, faces.reduce((s, f) => s + f.g.area, 0), "mm²", faces.every((f) => f.g.exact)));
  return { title: `${gs.length} entities`, rows };
}

/** Measure a selection (null when nothing measurable is selected). */
export function measureSelection(items: readonly SelectionItem[], topo: SceneTopology, report?: EvalReport | null): MeasureResult | null {
  const measurable = items.filter((it) => geomOf(topo, it) !== null);
  const gs = measurable.map((it) => geomOf(topo, it)!);
  if (gs.length === 0) return null;
  if (gs.length === 1) return single(gs[0]!, report, topo);
  if (gs.length === 2) return pair(gs[0]!, gs[1]!, topo, contactPoint(topo, measurable[0]!, measurable[1]!));
  return many(gs);
}

/** Display a measurement value (3 decimals, trailing zeros dropped; "≈" when approximate). */
export function formatMeasurement(m: Pick<Measurement, "value" | "unit" | "exact">): string {
  const digits = m.unit === "°" ? 2 : 3;
  const v = Number(m.value.toFixed(digits));
  const s = Object.is(v, -0) ? "0" : String(v);
  return `${m.exact ? "" : "≈ "}${s}${m.unit === "°" ? "°" : ` ${m.unit}`}`;
}
