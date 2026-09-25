/**
 * 2D geometry of the sketcher (sketch coordinates, mm): vectors, the literal curves of a sketch
 * snapshot (points on them, nearest points, intersections, arc parameters) and constructions
 * (3-point circles, tangent arcs). Pure functions; the committed geometry always goes through
 * the solver (forge-sketch), so these decide only where the pointer is and what to propose.
 */
import type { LiteralCurve, P2 } from "./engine-types";

export type { LiteralCurve, P2 };

export const EPS = 1e-9;

export const add = (a: P2, b: P2): P2 => [a[0] + b[0], a[1] + b[1]];
export const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
export const scale = (a: P2, k: number): P2 => [a[0] * k, a[1] * k];
export const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: P2, b: P2): number => a[0] * b[1] - a[1] * b[0];
export const len = (a: P2): number => Math.hypot(a[0], a[1]);
export const dist = (a: P2, b: P2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: P2, b: P2, t: number): P2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const mid = (a: P2, b: P2): P2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** Left normal (rotate +90°). */
export const perp = (a: P2): P2 => [-a[1], a[0]];
export const angleOf = (a: P2): number => Math.atan2(a[1], a[0]);
export const polar = (c: P2, r: number, a: number): P2 => [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];

export function norm(a: P2): P2 {
  const l = len(a);
  return l > EPS ? [a[0] / l, a[1] / l] : [0, 0];
}

/** Normalize an angle to [0, 2π). */
export function wrap(a: number): number {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

export const deg = (rad: number): number => (rad * 180) / Math.PI;
export const rad = (d: number): number => (d * Math.PI) / 180;

/** An arc in angular form: counter-clockwise from `a0` over `sweep` (0, 2π). */
export interface ArcParams {
  center: P2;
  r: number;
  a0: number;
  sweep: number;
}

type Arc = Extract<LiteralCurve, { kind: "arc" }>;
type Line = Extract<LiteralCurve, { kind: "line" }>;
type Circle = Extract<LiteralCurve, { kind: "circle" }>;

/** An IR arc (`ccw` either way) as a counter-clockwise angular span. */
export function arcParams(a: Arc): ArcParams {
  const [s, e] = a.ccw ? [a.start, a.end] : [a.end, a.start];
  const r = dist(a.center, s);
  const a0 = angleOf(sub(s, a.center));
  const a1 = angleOf(sub(e, a.center));
  let sweep = wrap(a1 - a0);
  if (sweep < EPS) sweep = 2 * Math.PI;
  return { center: a.center, r, a0, sweep };
}

/** Is the angle `t` within the arc's span (with a small angular slack)? */
export function onArcSpan(p: ArcParams, t: number, slack = 1e-9): boolean {
  const d = wrap(t - p.a0);
  return d <= p.sweep + slack || d >= 2 * Math.PI - slack;
}

/** The arc through three points (start, a point on it, end), or null when collinear. */
export function arcThrough(start: P2, onArc: P2, end: P2): { center: P2; ccw: boolean } | null {
  const c = circleThrough(start, onArc, end);
  if (!c) return null;
  // ccw when going start → onArc → end turns left.
  const ccw = cross(sub(onArc, start), sub(end, onArc)) > 0;
  return { center: c.center, ccw };
}

/** The circle through three points, or null when (nearly) collinear. */
export function circleThrough(a: P2, b: P2, c: P2): { center: P2; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  const scaleRef = Math.max(dist(a, b), dist(b, c), dist(a, c));
  if (Math.abs(d) < 1e-12 * Math.max(1, scaleRef * scaleRef)) return null;
  const a2 = dot(a, a);
  const b2 = dot(b, b);
  const c2 = dot(c, c);
  const ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  const center: P2 = [ux, uy];
  return { center, r: dist(center, a) };
}

/**
 * The arc tangent to direction `dir` at `start` that ends at `end` (a tangent arc), or null
 * when `end` lies on the tangent line.
 */
export function tangentArc(start: P2, dir: P2, end: P2): { center: P2; ccw: boolean } | null {
  const t = norm(dir);
  const chord = sub(end, start);
  const n = perp(t);
  const k = dot(chord, n);
  if (Math.abs(k) < EPS * Math.max(1, len(chord))) return null;
  // Center on the normal line: |start + n·s − end| = |s|  ⇒  s = |chord|² / (2 chord·n).
  const s = dot(chord, chord) / (2 * k);
  const center = add(start, scale(n, s));
  return { center, ccw: s > 0 };
}

/** Point of a curve by reference name: `start`, `end`, `center`, `at`, `mid`. */
export function curvePoint(c: LiteralCurve, which: string): P2 | null {
  switch (c.kind) {
    case "point":
      return which === "at" ? c.at : null;
    case "line":
      return which === "start" ? c.start : which === "end" ? c.end : which === "mid" ? mid(c.start, c.end) : null;
    case "arc":
      if (which === "start") return c.start;
      if (which === "end") return c.end;
      if (which === "center") return c.center;
      if (which === "mid") {
        const p = arcParams(c);
        return polar(p.center, p.r, p.a0 + p.sweep / 2);
      }
      return null;
    case "circle":
      return which === "center" ? c.center : null;
  }
}

/** The point on a segment nearest `p`, with its parameter t ∈ [0, 1]. */
export function nearestOnSegment(a: P2, b: P2, p: P2): { point: P2; t: number } {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < EPS) return { point: a, t: 0 };
  const t = Math.min(1, Math.max(0, dot(sub(p, a), d) / l2));
  return { point: lerp(a, b, t), t };
}

/** The point on the infinite line through a, b nearest `p`. */
export function projectOnLine(a: P2, b: P2, p: P2): P2 {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < EPS) return a;
  return add(a, scale(d, dot(sub(p, a), d) / l2));
}

/** Distance from `p` to the curve, and the nearest point on it. */
export function nearestOnCurve(c: LiteralCurve, p: P2): { point: P2; distance: number } {
  switch (c.kind) {
    case "point":
      return { point: c.at, distance: dist(c.at, p) };
    case "line": {
      const q = nearestOnSegment(c.start, c.end, p).point;
      return { point: q, distance: dist(q, p) };
    }
    case "circle": {
      const d = sub(p, c.center);
      const q = len(d) < EPS ? add(c.center, [c.radius, 0]) : add(c.center, scale(norm(d), c.radius));
      return { point: q, distance: dist(q, p) };
    }
    case "arc": {
      const ap = arcParams(c);
      const t = angleOf(sub(p, ap.center));
      if (onArcSpan(ap, t)) {
        const q = polar(ap.center, ap.r, t);
        return { point: q, distance: dist(q, p) };
      }
      const ds = dist(c.start, p);
      const de = dist(c.end, p);
      return ds <= de ? { point: c.start, distance: ds } : { point: c.end, distance: de };
    }
  }
}

/** Parameter of a point along a curve: t ∈ [0,1] for lines, the angle offset from `a0` for arcs/circles. */
export function paramOn(c: LiteralCurve, p: P2): number {
  switch (c.kind) {
    case "line":
      return nearestOnSegment(c.start, c.end, p).t;
    case "arc": {
      const ap = arcParams(c);
      return wrap(angleOf(sub(p, ap.center)) - ap.a0);
    }
    case "circle":
      return wrap(angleOf(sub(p, c.center)));
    case "point":
      return 0;
  }
}

function lineLine(a: Line, b: Line, segments: boolean): P2[] {
  const r = sub(a.end, a.start);
  const s = sub(b.end, b.start);
  const den = cross(r, s);
  if (Math.abs(den) < EPS * Math.max(1, len(r) * len(s))) return [];
  const qp = sub(b.start, a.start);
  const t = cross(qp, s) / den;
  const u = cross(qp, r) / den;
  const slack = 1e-9;
  if (segments && (t < -slack || t > 1 + slack || u < -slack || u > 1 + slack)) return [];
  return [add(a.start, scale(r, t))];
}

function lineCircle(a: P2, b: P2, center: P2, r: number, segment: boolean): P2[] {
  const d = sub(b, a);
  const f = sub(a, center);
  const A = dot(d, d);
  if (A < EPS) return [];
  const B = 2 * dot(f, d);
  const C = dot(f, f) - r * r;
  let disc = B * B - 4 * A * C;
  if (disc < -1e-9 * Math.max(1, B * B)) return [];
  disc = Math.max(0, disc);
  const sq = Math.sqrt(disc);
  const ts = sq < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const slack = 1e-9;
  return ts.filter((t) => !segment || (t >= -slack && t <= 1 + slack)).map((t) => add(a, scale(d, t)));
}

function circleCircle(c0: P2, r0: number, c1: P2, r1: number): P2[] {
  const d = dist(c0, c1);
  if (d < EPS || d > r0 + r1 + 1e-9 || d < Math.abs(r0 - r1) - 1e-9) return [];
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const u = scale(sub(c1, c0), 1 / d);
  const p = add(c0, scale(u, a));
  if (h < 1e-12) return [p];
  const n = perp(u);
  return [add(p, scale(n, h)), sub(p, scale(n, h))];
}

function circleOf(c: LiteralCurve): { center: P2; r: number } | null {
  if (c.kind === "circle") return { center: c.center, r: c.radius };
  if (c.kind === "arc") return { center: c.center, r: dist(c.center, c.start) };
  return null;
}

function onCurveSpan(c: LiteralCurve, p: P2): boolean {
  if (c.kind !== "arc") return true;
  const ap = arcParams(c);
  return onArcSpan(ap, angleOf(sub(p, ap.center)), 1e-7);
}

/**
 * Intersection points of two curves (segments and arc spans only unless `extended`, which
 * treats lines as infinite and arcs as full circles — used by extend).
 */
export function intersect(a: LiteralCurve, b: LiteralCurve, extended = false): P2[] {
  if (a.kind === "point" || b.kind === "point") return [];
  let pts: P2[];
  if (a.kind === "line" && b.kind === "line") {
    pts = lineLine(a, b, !extended);
  } else if (a.kind === "line" || b.kind === "line") {
    const l = (a.kind === "line" ? a : b) as Line;
    const o = (a.kind === "line" ? b : a) as Arc | Circle;
    const circ = circleOf(o)!;
    pts = lineCircle(l.start, l.end, circ.center, circ.r, !extended);
    if (!extended) pts = pts.filter((p) => onCurveSpan(o, p));
  } else {
    const ca = circleOf(a)!;
    const cb = circleOf(b)!;
    pts = circleCircle(ca.center, ca.r, cb.center, cb.r);
    if (!extended) pts = pts.filter((p) => onCurveSpan(a, p) && onCurveSpan(b, p));
  }
  return pts;
}

/** Axis-aligned bounds of curves (`null` when empty). */
export function bounds(curves: readonly LiteralCurve[]): { min: P2; max: P2 } | null {
  let min: P2 = [Infinity, Infinity];
  let max: P2 = [-Infinity, -Infinity];
  const grow = (p: P2, r = 0): void => {
    min = [Math.min(min[0], p[0] - r), Math.min(min[1], p[1] - r)];
    max = [Math.max(max[0], p[0] + r), Math.max(max[1], p[1] + r)];
  };
  for (const c of curves) {
    switch (c.kind) {
      case "point":
        grow(c.at);
        break;
      case "line":
        grow(c.start);
        grow(c.end);
        break;
      case "circle":
        grow(c.center, c.radius);
        break;
      case "arc":
        grow(c.start);
        grow(c.end);
        grow(c.center, dist(c.center, c.start));
        break;
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** Unit tangent of a curve at point `p` on it (direction of travel start → end / ccw). */
export function tangentAt(c: LiteralCurve, p: P2): P2 {
  switch (c.kind) {
    case "line":
      return norm(sub(c.end, c.start));
    case "circle":
      return norm(perp(sub(p, c.center)));
    case "arc": {
      const t = norm(perp(sub(p, c.center)));
      return c.ccw ? t : scale(t, -1);
    }
    case "point":
      return [1, 0];
  }
}

/** The mirror image of `p` about the line through a, b. */
export function mirrorPoint(p: P2, a: P2, b: P2): P2 {
  const q = projectOnLine(a, b, p);
  return sub(scale(q, 2), p);
}

/** Round a length for display (mm, up to 3 decimals, no trailing zeros). */
export function fmt(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return "—";
  const s = x.toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
