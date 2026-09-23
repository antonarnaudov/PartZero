/**
 * Sketch geometry for repair hints: endpoint matching (SPEC §3.1 stage 1), curve intersections
 * (stage 2, approximately), and the side of a revolve axis each curve lies on (§4.3 [R-7]).
 *
 * These helpers only *explain* errors the engine already reported; they never decide validity.
 * Tolerance follows the spec: points coincide when their distance is ≤ 1e-6 mm.
 */
import { LINEAR_TOLERANCE, type ArcSketchCurve, type SketchCurve } from "@aicad/ir-types";

export type P2 = readonly [number, number];

const TOL = LINEAR_TOLERANCE;
const TAU = 2 * Math.PI;

export function dist(a: P2, b: P2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function coincident(a: P2, b: P2, tol = TOL): boolean {
  return dist(a, b) <= tol;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────────────────────

export interface CurveEnd {
  curve: string;
  /** Index of the curve in the sketch. */
  index: number;
  which: "start" | "end";
  p: P2;
}

/** Ends of lines and arcs, in curve order, `start` before `end` (circles have none). */
export function curveEnds(curves: readonly SketchCurve[]): CurveEnd[] {
  const out: CurveEnd[] = [];
  curves.forEach((c, index) => {
    if (c.kind === "circle") return;
    out.push({ curve: c.id, index, which: "start", p: c.start });
    out.push({ curve: c.id, index, which: "end", p: c.end });
  });
  return out;
}

export interface EndpointIssue {
  end: CurveEnd;
  /** Coinciding ends of other curves: none = open loop, two or more = branching. */
  partners: CurveEnd[];
}

/** The first end (SPEC §3.1 stage-1 order) that does not meet exactly one other curve end. */
export function firstEndpointIssue(curves: readonly SketchCurve[]): EndpointIssue | undefined {
  const ends = curveEnds(curves);
  for (const e of ends) {
    const partners = ends.filter((o) => o.index !== e.index && coincident(e.p, o.p));
    if (partners.length !== 1) return { end: e, partners };
  }
  return undefined;
}

/** All ends that do not meet exactly one other curve end. */
export function endpointIssues(curves: readonly SketchCurve[]): EndpointIssue[] {
  const ends = curveEnds(curves);
  const out: EndpointIssue[] = [];
  for (const e of ends) {
    const partners = ends.filter((o) => o.index !== e.index && coincident(e.p, o.p));
    if (partners.length !== 1) out.push({ end: e, partners });
  }
  return out;
}

/** Nearest ends of *other* curves to `end`, closest first. */
export function nearestEnds(curves: readonly SketchCurve[], end: CurveEnd, k = 1): { end: CurveEnd; distance: number }[] {
  return curveEnds(curves)
    .filter((o) => o.index !== end.index)
    .map((o) => ({ end: o, distance: dist(o.p, end.p) }))
    .sort((a, b) => a.distance - b.distance || a.end.index - b.end.index)
    .slice(0, k);
}

// ─── Arcs ────────────────────────────────────────────────────────────────────────────────────

function norm(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

export function arcRadius(a: ArcSketchCurve): number {
  return dist(a.start, a.center);
}

/** Sweep of an arc in (0, 2π), measured in its own direction. */
export function arcSweep(a: ArcSketchCurve): number {
  const a0 = Math.atan2(a.start[1] - a.center[1], a.start[0] - a.center[0]);
  const a1 = Math.atan2(a.end[1] - a.center[1], a.end[0] - a.center[0]);
  const s = a.ccw ? norm(a1 - a0) : norm(a0 - a1);
  return s === 0 ? TAU : s;
}

/** Is the direction `theta` (radians) on the arc? */
export function arcContainsAngle(a: ArcSketchCurve, theta: number, slack = 1e-12): boolean {
  const a0 = Math.atan2(a.start[1] - a.center[1], a.start[0] - a.center[0]);
  const off = a.ccw ? norm(theta - a0) : norm(a0 - theta);
  return off <= arcSweep(a) + slack || off >= TAU - slack;
}

function onCurveAngle(c: SketchCurve, p: P2): boolean {
  if (c.kind !== "arc") return true;
  return arcContainsAngle(c, Math.atan2(p[1] - c.center[1], p[0] - c.center[0]), 1e-9);
}

// ─── Distances and intersections ─────────────────────────────────────────────────────────────

export function pointSegmentDistance(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from a point to a curve. */
export function distanceToCurve(p: P2, c: SketchCurve): number {
  if (c.kind === "line") return pointSegmentDistance(p, c.start, c.end);
  const r = c.kind === "circle" ? c.radius : arcRadius(c);
  const d = dist(p, c.center);
  if (c.kind === "circle" || onCurveAngle(c, p)) return Math.abs(d - r);
  return Math.min(dist(p, c.start), dist(p, c.end));
}

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}

interface Hit {
  points: P2[];
  /** Collinear or co-circular overlap longer than the tolerance. */
  overlap: boolean;
}

function lineLine(a: { start: P2; end: P2 }, b: { start: P2; end: P2 }): Hit {
  const rx = a.end[0] - a.start[0];
  const ry = a.end[1] - a.start[1];
  const sx = b.end[0] - b.start[0];
  const sy = b.end[1] - b.start[1];
  const qx = b.start[0] - a.start[0];
  const qy = b.start[1] - a.start[1];
  const d = cross(rx, ry, sx, sy);
  const la = Math.hypot(rx, ry);
  const lb = Math.hypot(sx, sy);
  if (Math.abs(d) <= 1e-12 * la * lb) {
    // Parallel: overlap when collinear and the projections share more than TOL.
    if (Math.abs(cross(qx, qy, rx, ry)) / la > TOL) return { points: [], overlap: false };
    const t0 = (qx * rx + qy * ry) / (la * la);
    const t1 = t0 + (sx * rx + sy * ry) / (la * la);
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(1, Math.max(t0, t1));
    const len = (hi - lo) * la;
    if (len > TOL) return { points: [[a.start[0] + lo * rx, a.start[1] + lo * ry], [a.start[0] + hi * rx, a.start[1] + hi * ry]], overlap: true };
    return { points: len >= -TOL ? [[a.start[0] + lo * rx, a.start[1] + lo * ry]] : [], overlap: false };
  }
  const t = cross(qx, qy, sx, sy) / d;
  const u = cross(qx, qy, rx, ry) / d;
  const ea = TOL / la;
  const eb = TOL / lb;
  if (t < -ea || t > 1 + ea || u < -eb || u > 1 + eb) return { points: [], overlap: false };
  return { points: [[a.start[0] + t * rx, a.start[1] + t * ry]], overlap: false };
}

function lineCircle(l: { start: P2; end: P2 }, center: P2, r: number): P2[] {
  const dx = l.end[0] - l.start[0];
  const dy = l.end[1] - l.start[1];
  const fx = l.start[0] - center[0];
  const fy = l.start[1] - center[1];
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  let disc = b * b - 4 * a * c;
  const len = Math.sqrt(a);
  // Tangency within tolerance counts as one contact point.
  const gap = Math.abs(cross(dx, dy, -fx, -fy)) / len - r;
  if (disc < 0 && gap > TOL) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-b / (2 * a)] : [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
  const e = TOL / len;
  return ts.filter((t) => t >= -e && t <= 1 + e).map((t): P2 => [l.start[0] + t * dx, l.start[1] + t * dy]);
}

function circleCircle(c1: P2, r1: number, c2: P2, r2: number): Hit {
  const d = dist(c1, c2);
  if (d <= TOL) return { points: [], overlap: Math.abs(r1 - r2) <= TOL };
  if (d > r1 + r2 + TOL || d < Math.abs(r1 - r2) - TOL) return { points: [], overlap: false };
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const mx = c1[0] + (a * (c2[0] - c1[0])) / d;
  const my = c1[1] + (a * (c2[1] - c1[1])) / d;
  const ox = (h * (c2[1] - c1[1])) / d;
  const oy = (h * (c2[0] - c1[0])) / d;
  if (h <= TOL) return { points: [[mx, my]], overlap: false };
  return {
    points: [
      [mx + ox, my - oy],
      [mx - ox, my + oy],
    ],
    overlap: false,
  };
}

function circleOf(c: SketchCurve): { center: P2; r: number } | undefined {
  if (c.kind === "circle") return { center: c.center, r: c.radius };
  if (c.kind === "arc") return { center: c.center, r: arcRadius(c) };
  return undefined;
}

/** Contact points of two curves (proper intersections, tangencies, touching endpoints). */
export function intersections(a: SketchCurve, b: SketchCurve): Hit {
  if (a.kind === "line" && b.kind === "line") return lineLine(a, b);
  if (a.kind === "line" || b.kind === "line") {
    const l = (a.kind === "line" ? a : b) as { start: P2; end: P2 };
    const o = a.kind === "line" ? b : a;
    const circ = circleOf(o)!;
    return { points: lineCircle(l, circ.center, circ.r).filter((p) => onCurveAngle(o, p)), overlap: false };
  }
  const ca = circleOf(a)!;
  const cb = circleOf(b)!;
  const hit = circleCircle(ca.center, ca.r, cb.center, cb.r);
  if (hit.overlap) {
    // Co-circular: overlapping unless both are arcs that only share endpoints.
    if (a.kind === "circle" || b.kind === "circle") return hit;
    const probe = (x: ArcSketchCurve, y: ArcSketchCurve) => {
      const a0 = Math.atan2(x.start[1] - x.center[1], x.start[0] - x.center[0]);
      const mid = a0 + ((x.ccw ? 1 : -1) * arcSweep(x)) / 2;
      return arcContainsAngle(y, mid, 1e-9);
    };
    return { points: [], overlap: probe(a as ArcSketchCurve, b as ArcSketchCurve) || probe(b as ArcSketchCurve, a as ArcSketchCurve) };
  }
  return { points: hit.points.filter((p) => onCurveAngle(a, p) && onCurveAngle(b, p)), overlap: false };
}

function endsOf(c: SketchCurve): P2[] {
  return c.kind === "circle" ? [] : [c.start, c.end];
}

export interface Crossing {
  a: SketchCurve;
  b: SketchCurve;
  /** A contact point away from every shared endpoint (undefined for an overlap). */
  at?: P2;
  overlap: boolean;
}

/** The first curve pair (SPEC §3.1 stage-2 order) that touches away from a shared endpoint or overlaps. */
export function firstCrossing(curves: readonly SketchCurve[]): Crossing | undefined {
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const a = curves[i]!;
      const b = curves[j]!;
      const hit = intersections(a, b);
      if (hit.overlap) return { a, b, overlap: true };
      const shared = endsOf(a).filter((p) => endsOf(b).some((q) => coincident(p, q)));
      const bad = hit.points.find((p) => shared.every((s) => dist(p, s) > 2 * TOL));
      if (bad) return { a, b, at: bad, overlap: false };
    }
  }
  return undefined;
}

// ─── Revolve axis ────────────────────────────────────────────────────────────────────────────

export interface Axis2 {
  origin: P2;
  direction: P2;
}

export interface SideExtent {
  /** Smallest / largest signed distance of the curve from the axis line (left of the direction = positive). */
  min: number;
  max: number;
  argmin: P2;
  argmax: P2;
}

export function signedDistance(p: P2, axis: Axis2): number {
  const l = Math.hypot(axis.direction[0], axis.direction[1]);
  const nx = axis.direction[0] / l;
  const ny = axis.direction[1] / l;
  return cross(nx, ny, p[0] - axis.origin[0], p[1] - axis.origin[1]);
}

/** Signed-distance range of a curve relative to the axis line. */
export function sideExtent(c: SketchCurve, axis: Axis2): SideExtent {
  const pts: P2[] = [];
  if (c.kind === "line") pts.push(c.start, c.end);
  else {
    const circ = circleOf(c)!;
    if (c.kind === "arc") pts.push(c.start, c.end);
    const phi = Math.atan2(axis.direction[1], axis.direction[0]);
    for (const theta of [phi + Math.PI / 2, phi - Math.PI / 2]) {
      const p: P2 = [circ.center[0] + circ.r * Math.cos(theta), circ.center[1] + circ.r * Math.sin(theta)];
      if (c.kind === "circle" || arcContainsAngle(c, theta, 1e-12)) pts.push(p);
    }
  }
  let min = Infinity;
  let max = -Infinity;
  let argmin: P2 = pts[0]!;
  let argmax: P2 = pts[0]!;
  for (const p of pts) {
    const d = signedDistance(p, axis);
    if (d < min) {
      min = d;
      argmin = p;
    }
    if (d > max) {
      max = d;
      argmax = p;
    }
  }
  return { min, max, argmin, argmax };
}

/** A plain-words description of the axis line in sketch coordinates, plus which side is "left". */
export function describeAxis(axis: Axis2): { line: string; positiveSide: string; negativeSide: string } {
  const [du, dv] = axis.direction;
  const [ou, ov] = axis.origin;
  const f = (x: number) => String(Number(x.toFixed(6)));
  if (Math.abs(du) <= 1e-12) {
    // Vertical axis u = ou; left of +v is u < ou.
    const up = dv > 0;
    return { line: `the line u = ${f(ou)}`, positiveSide: up ? `u < ${f(ou)}` : `u > ${f(ou)}`, negativeSide: up ? `u > ${f(ou)}` : `u < ${f(ou)}` };
  }
  if (Math.abs(dv) <= 1e-12) {
    const right = du > 0;
    return { line: `the line v = ${f(ov)}`, positiveSide: right ? `v > ${f(ov)}` : `v < ${f(ov)}`, negativeSide: right ? `v < ${f(ov)}` : `v > ${f(ov)}` };
  }
  return { line: `the line through [${f(ou)}, ${f(ov)}] along [${f(du)}, ${f(dv)}]`, positiveSide: "left of the axis direction", negativeSide: "right of the axis direction" };
}
