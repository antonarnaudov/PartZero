/**
 * Snapping and inference while drawing (plan §2.7 "Gestures"): TS for latency, deterministic
 * (fixed candidate order, ties broken by distance then order). A snap says where the point goes
 * and what it is bound to; {@link autoConstraintsFor} turns that binding into IR constraints
 * when the gesture commits (Alt suppresses them).
 *
 * | Kind | Where | Auto-constraint for a new point `q` |
 * |---|---|---|
 * | `endpoint` | a line/arc end | none: the ends coincide exactly, so they weld (SPEC-v1 §4.3) |
 * | `point`, `center` | a sketch point, an arc/circle centre | `coincident(q, ref)` |
 * | `origin` | the sketch origin | `fix(q, x: 0, y: 0)` |
 * | `midpoint` | the middle of a line | `midpoint(q, line)` |
 * | `quadrant`, `onCurve` | on a circle/arc/line | `point_on_circle` / `point_on_line` |
 * | `intersection` | two curves cross | on-curve for both |
 * | `axis`, `grid`, `model`, `free` | position only | none (implicit origin/axes arrive with SPEC set A) |
 *
 * Direction inference relative to the tool's anchor: horizontal / vertical (→ `horizontal` /
 * `vertical` on the new line), parallel / perpendicular to a line, tangent to the curve the
 * chain continues from.
 */
import type { v1 } from "@aicad/ir-types";
import {
  angleOf,
  arcParams,
  dist,
  intersect,
  mid,
  nearestOnCurve,
  norm,
  onArcSpan,
  polar,
  projectOnLine,
  sub,
  type LiteralCurve,
  type P2,
} from "./geom";

export type SnapKind = "endpoint" | "center" | "point" | "origin" | "midpoint" | "quadrant" | "intersection" | "onCurve" | "axis" | "model" | "grid" | "free";

export interface Guide {
  from: P2;
  to: P2;
  kind: "h" | "v" | "parallel" | "perpendicular" | "tangent" | "align";
}

export interface SnapResult {
  point: P2;
  kind: SnapKind;
  /** IR point reference for `endpoint`, `center`, `point`. */
  ref?: string;
  /** The curve for `midpoint`, `quadrant`, `onCurve`; the first of two for `intersection`. */
  curve?: string;
  /** The second curve of an `intersection`. */
  curve2?: string;
  /** The direction from the anchor is horizontal / vertical. */
  hv?: "h" | "v";
  parallelTo?: string;
  perpendicularTo?: string;
  tangentTo?: string;
  guides: Guide[];
}

export interface SnapContext {
  curves: readonly LiteralCurve[];
  /** Tolerance in sketch mm (pixels × mm-per-pixel). */
  tol: number;
  /** The previous point of the gesture (H/V, parallel, perpendicular inference). */
  anchor?: P2 | null;
  /** The curve the chain continues from, for tangent inference (and its tangent direction at the anchor). */
  tangent?: { curve: string; dir: P2 } | null;
  /** Point refs and curves not to snap to (the geometry being drawn or dragged). */
  excludeRefs?: ReadonlySet<string>;
  excludeCurves?: ReadonlySet<string>;
  /** Projected model vertices (position-only snaps). */
  modelPoints?: readonly P2[];
  /** Grid step (mm) when grid snapping is on. */
  grid?: number | null;
  /** Alt: no snapping or inference. */
  disabled?: boolean;
}

interface Candidate {
  point: P2;
  kind: SnapKind;
  prio: number;
  ref?: string;
  curve?: string;
  curve2?: string;
}

const ANGLE_TOL = (2 * Math.PI) / 180;

/** The key points of the sketch (endpoints, centres, points, midpoints, quadrants) and the origin. */
export function keyPoints(curves: readonly LiteralCurve[], ctx?: Pick<SnapContext, "excludeRefs" | "excludeCurves">): Candidate[] {
  const out: Candidate[] = [{ point: [0, 0], kind: "origin", prio: 0 }];
  const skipRef = (r: string): boolean => ctx?.excludeRefs?.has(r) ?? false;
  for (const c of curves) {
    if (ctx?.excludeCurves?.has(c.id)) continue;
    switch (c.kind) {
      case "point":
        if (!skipRef(c.id)) out.push({ point: c.at, kind: "point", prio: 0, ref: c.id });
        break;
      case "line":
        if (!skipRef(`${c.id}.start`)) out.push({ point: c.start, kind: "endpoint", prio: 0, ref: `${c.id}.start` });
        if (!skipRef(`${c.id}.end`)) out.push({ point: c.end, kind: "endpoint", prio: 0, ref: `${c.id}.end` });
        out.push({ point: mid(c.start, c.end), kind: "midpoint", prio: 1, curve: c.id });
        break;
      case "arc": {
        if (!skipRef(`${c.id}.start`)) out.push({ point: c.start, kind: "endpoint", prio: 0, ref: `${c.id}.start` });
        if (!skipRef(`${c.id}.end`)) out.push({ point: c.end, kind: "endpoint", prio: 0, ref: `${c.id}.end` });
        if (!skipRef(`${c.id}.center`)) out.push({ point: c.center, kind: "center", prio: 0, ref: `${c.id}.center` });
        const ap = arcParams(c);
        for (let k = 0; k < 4; k++) {
          const t = (k * Math.PI) / 2;
          if (onArcSpan(ap, t, 1e-9)) out.push({ point: polar(ap.center, ap.r, t), kind: "quadrant", prio: 1, curve: c.id });
        }
        break;
      }
      case "circle":
        if (!skipRef(`${c.id}.center`)) out.push({ point: c.center, kind: "center", prio: 0, ref: `${c.id}.center` });
        for (let k = 0; k < 4; k++) out.push({ point: polar(c.center, c.radius, (k * Math.PI) / 2), kind: "quadrant", prio: 1, curve: c.id });
        break;
    }
  }
  return out;
}

function best(cands: Candidate[], p: P2, tol: number): Candidate | null {
  let pick: Candidate | null = null;
  let pickD = Infinity;
  for (const c of cands) {
    const d = dist(c.point, p);
    if (d > tol) continue;
    if (!pick || c.prio < pick.prio || (c.prio === pick.prio && d < pickD - 1e-12)) {
      pick = c;
      pickD = d;
    }
  }
  return pick;
}

/** Snap the pointer `p` (sketch coordinates). */
export function snap(p: P2, ctx: SnapContext): SnapResult {
  if (ctx.disabled) return { point: p, kind: "free", guides: [] };
  const tol = ctx.tol;
  const curves = ctx.curves.filter((c) => !ctx.excludeCurves?.has(c.id));

  // 1. Key points (and projected model vertices).
  const cands = keyPoints(curves, ctx);
  for (const m of ctx.modelPoints ?? []) cands.push({ point: m, kind: "model", prio: 1 });
  // 2. Intersections of the curves near the pointer.
  const near = curves.filter((c) => c.kind !== "point" && nearestOnCurve(c, p).distance <= tol * 2);
  for (let i = 0; i < near.length; i++) {
    for (let j = i + 1; j < near.length; j++) {
      for (const q of intersect(near[i]!, near[j]!)) cands.push({ point: q, kind: "intersection", prio: 1, curve: near[i]!.id, curve2: near[j]!.id });
    }
  }
  const hit = best(cands, p, tol);
  if (hit) {
    const r: SnapResult = { point: hit.point, kind: hit.kind, guides: [] };
    if (hit.ref !== undefined) r.ref = hit.ref;
    if (hit.curve !== undefined) r.curve = hit.curve;
    if (hit.curve2 !== undefined) r.curve2 = hit.curve2;
    annotateDirection(r, ctx);
    return r;
  }

  // 3. On a curve.
  let on: { curve: LiteralCurve; point: P2; d: number } | null = null;
  for (const c of curves) {
    if (c.kind === "point") continue;
    const n = nearestOnCurve(c, p);
    if (n.distance <= tol && (!on || n.distance < on.d)) on = { curve: c, point: n.point, d: n.distance };
  }

  // 4. Direction inference from the anchor (H/V first, then parallel/perpendicular/tangent).
  let q: P2 = on ? on.point : p;
  const r: SnapResult = on ? { point: q, kind: "onCurve", curve: on.curve.id, guides: [] } : { point: q, kind: "free", guides: [] };
  const a = ctx.anchor;
  if (a && !on) {
    const d = sub(p, a);
    if (Math.abs(d[1]) <= tol && Math.abs(d[0]) > tol) {
      q = [p[0], a[1]];
      r.hv = "h";
      r.guides.push({ from: a, to: q, kind: "h" });
    } else if (Math.abs(d[0]) <= tol && Math.abs(d[1]) > tol) {
      q = [a[0], p[1]];
      r.hv = "v";
      r.guides.push({ from: a, to: q, kind: "v" });
    } else if (Math.hypot(d[0], d[1]) > tol * 3) {
      const dir = angleOf(d);
      const inferred = inferDirection(a, p, dir, curves, ctx.tangent ?? null);
      if (inferred) {
        q = inferred.point;
        Object.assign(r, inferred.tags);
        r.guides.push(inferred.guide);
      }
    }
    r.point = q;
  }

  // 5. Alignment with a key point (dotted inference line), when nothing else bound x or y.
  if (!on) {
    // (The origin's alignments are the sketch axes, step 6.)
    const keys = cands.filter((c) => c.kind === "endpoint" || c.kind === "center" || c.kind === "point");
    if (r.hv !== "v" && !r.parallelTo && !r.perpendicularTo && !r.tangentTo) {
      const kx = keys.find((k) => Math.abs(k.point[0] - q[0]) <= tol && Math.abs(k.point[1] - q[1]) > tol);
      if (kx) {
        q = [kx.point[0], q[1]];
        r.guides.push({ from: kx.point, to: q, kind: "align" });
      }
    }
    if (r.hv !== "h" && !r.parallelTo && !r.perpendicularTo && !r.tangentTo) {
      const ky = keys.find((k) => Math.abs(k.point[1] - q[1]) <= tol && Math.abs(k.point[0] - q[0]) > tol);
      if (ky) {
        q = [q[0], ky.point[1]];
        r.guides.push({ from: ky.point, to: q, kind: "align" });
      }
    }
    r.point = q;
  }

  // 6. The sketch axes, then the grid.
  if (r.kind === "free" && r.guides.length === 0) {
    if (Math.abs(q[1]) <= tol) {
      r.point = [q[0], 0];
      r.kind = "axis";
    } else if (Math.abs(q[0]) <= tol) {
      r.point = [0, q[1]];
      r.kind = "axis";
    } else if (ctx.grid && ctx.grid > 0) {
      r.point = [Math.round(q[0] / ctx.grid) * ctx.grid, Math.round(q[1] / ctx.grid) * ctx.grid];
      r.kind = "grid";
    }
  }
  return r;
}

function annotateDirection(r: SnapResult, ctx: SnapContext): void {
  const a = ctx.anchor;
  if (!a) return;
  const d = sub(r.point, a);
  const l = Math.hypot(d[0], d[1]);
  if (l <= ctx.tol) return;
  if (Math.abs(d[1]) <= 1e-9 * Math.max(1, l)) r.hv = "h";
  else if (Math.abs(d[0]) <= 1e-9 * Math.max(1, l)) r.hv = "v";
}

function inferDirection(
  a: P2,
  p: P2,
  dir: number,
  curves: readonly LiteralCurve[],
  tangent: { curve: string; dir: P2 } | null,
): { point: P2; tags: Partial<SnapResult>; guide: Guide } | null {
  const along = (u: P2): P2 => projectOnLine(a, [a[0] + u[0], a[1] + u[1]], p);
  const diff = (x: number, y: number): number => {
    const t = Math.abs(((x - y) % Math.PI) + Math.PI) % Math.PI;
    return Math.min(t, Math.PI - t);
  };
  if (tangent) {
    const u = norm(tangent.dir);
    if (diff(dir, angleOf(u)) <= ANGLE_TOL) {
      const q = along(u);
      return { point: q, tags: { tangentTo: tangent.curve }, guide: { from: a, to: q, kind: "tangent" } };
    }
  }
  for (const c of curves) {
    if (c.kind !== "line") continue;
    const u = norm(sub(c.end, c.start));
    const lineDir = angleOf(u);
    if (diff(dir, lineDir) <= ANGLE_TOL) {
      const q = along(u);
      return { point: q, tags: { parallelTo: c.id }, guide: { from: a, to: q, kind: "parallel" } };
    }
    if (diff(dir, lineDir + Math.PI / 2) <= ANGLE_TOL) {
      const w: P2 = [-u[1], u[0]];
      const q = along(w);
      return { point: q, tags: { perpendicularTo: c.id }, guide: { from: a, to: q, kind: "perpendicular" } };
    }
  }
  return null;
}

/**
 * The auto-constraints that bind a new point `ref` (e.g. `l3.start`) to what it snapped to.
 * `newId(prefix)` allocates constraint ids.
 */
export function autoConstraintsFor(ref: string, s: SnapResult, newId: (prefix: string) => string): v1.Constraint[] {
  switch (s.kind) {
    case "point":
    case "center":
      return s.ref ? [{ type: "coincident", id: newId("co"), a: ref, b: s.ref }] : [];
    case "origin":
      return [{ type: "fix", id: newId("fx"), entity: ref, x: 0, y: 0 }];
    case "midpoint":
      return s.curve ? [{ type: "midpoint", id: newId("mp"), point: ref, line: s.curve }] : [];
    case "quadrant":
    case "onCurve":
      return s.curve ? [onCurve(ref, s.curve, newId)] : [];
    case "intersection":
      return [s.curve, s.curve2].filter((c): c is string => !!c).map((c) => onCurve(ref, c, newId));
    default:
      return [];
  }
}

function onCurve(ref: string, curveKindAndId: string, newId: (prefix: string) => string): v1.Constraint {
  return { type: "point_on_line", id: newId("on"), point: ref, line: curveKindAndId };
}

/**
 * Fix up on-curve constraints by curve kind: `point_on_line` for lines, `point_on_circle` for
 * circles and arcs (the snap only knows curve ids).
 */
export function bindKinds(cons: v1.Constraint[], curves: readonly LiteralCurve[]): v1.Constraint[] {
  return cons.map((c) => {
    if (c.type !== "point_on_line") return c;
    const target = curves.find((x) => x.id === c.line);
    if (target && (target.kind === "circle" || target.kind === "arc")) return { type: "point_on_circle", id: c.id, point: c.point, curve: c.line };
    return c;
  });
}
