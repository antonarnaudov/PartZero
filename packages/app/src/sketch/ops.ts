/**
 * Sketch modify operations as edit batches (plan T0 #7): trim, extend, offset, mirror, corner
 * fillet and chamfer. Each returns the `sketchEdit` list to commit (the session solves and checks
 * it), or a reason why it does not apply.
 *
 * Constraint bookkeeping: an operation that moves a curve end drops the constraints that pinned
 * that end (they would pull it back) and the length dimensions of the curves it shortens, keeps
 * orientation constraints (horizontal, parallel, …), and binds new ends to what cut them
 * (`point_on_line` / `point_on_circle`), so the result stays associative.
 */
import type { v1 } from "@aicad/ir-types";
import type { SketchEdit } from "./engine-types";
import { findCurve } from "./constraints";
import {
  add,
  angleOf,
  arcParams,
  cross,
  dist,
  dot,
  EPS,
  intersect,
  len,
  mirrorPoint,
  nearestOnSegment,
  norm,
  perp,
  polar,
  projectOnLine,
  scale,
  sub,
  wrap,
  type LiteralCurve,
  type P2,
} from "./geom";
import type { IdAllocator } from "./ids";

export type OpResult = { ok: true; edits: SketchEdit[]; note?: string } | { ok: false; reason: string };

type Line = Extract<LiteralCurve, { kind: "line" }>;
type Arc = Extract<LiteralCurve, { kind: "arc" }>;

/** The entity arguments of a constraint. */
export function argsOf(c: v1.Constraint): string[] {
  switch (c.type) {
    case "horizontal":
    case "vertical":
      return [c.line];
    case "radius":
    case "diameter":
      return [c.curve];
    case "point_on_line":
    case "midpoint":
      return [c.point, c.line];
    case "point_on_circle":
      return [c.point, c.curve];
    case "symmetric":
      return [c.a, c.b, c.line];
    case "fix":
      return [c.entity];
    default:
      return [c.a, c.b];
  }
}

function onCurveConstraint(point: string, target: LiteralCurve, id: string): v1.Constraint {
  return target.kind === "line" ? { type: "point_on_line", id, point, line: target.id } : { type: "point_on_circle", id, point, curve: target.id };
}

/** Constraints to drop when `refs` (curve ends) move, and when `shortened` curves change length. */
function dropsFor(feature: v1.SketchFeature, refs: readonly string[], shortened: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of feature.constraints ?? []) {
    const args = argsOf(c);
    const onMovedEnd = args.some((a) => refs.includes(a));
    const lengthOf =
      (c.type === "distance" && shortened.some((id) => (c.a === `${id}.start` && c.b === `${id}.end`) || (c.a === `${id}.end` && c.b === `${id}.start`))) ||
      (c.type === "equal" && shortened.some((id) => c.a === id || c.b === id)) ||
      (c.type === "midpoint" && shortened.includes(c.line));
    if (onMovedEnd || lengthOf) out.push(c.id);
  }
  return out;
}

function lit(p: P2): P2 {
  return [p[0] + 0, p[1] + 0];
}

// ─── Trim ────────────────────────────────────────────────────────────────────────────────────

interface Cut {
  /** Line: t ∈ (0,1); arc/circle: ccw angle offset from the span start. */
  t: number;
  point: P2;
  by: LiteralCurve;
}

function cutsOn(c: LiteralCurve, curves: readonly LiteralCurve[]): Cut[] {
  const cuts: Cut[] = [];
  for (const o of curves) {
    if (o.id === c.id || o.kind === "point") continue;
    for (const p of intersect(c, o)) {
      let t: number;
      if (c.kind === "line") t = nearestOnSegment(c.start, c.end, p).t;
      else if (c.kind === "arc") t = wrap(angleOf(sub(p, c.center)) - arcParams(c).a0);
      else if (c.kind === "circle") t = wrap(angleOf(sub(p, c.center)));
      else continue;
      cuts.push({ t, point: p, by: o });
    }
  }
  return cuts;
}

/** Trim the piece of curve `id` under `at` back to its neighbouring intersections. */
export function trim(id: string, at: P2, curves: readonly LiteralCurve[], feature: v1.SketchFeature, ids: IdAllocator): OpResult {
  const c = findCurve(curves, id);
  if (!c || c.kind === "point") return { ok: false, reason: "Click the piece of a curve to trim." };
  const all = cutsOn(c, curves);
  if (c.kind === "line") {
    const L = len(sub(c.end, c.start));
    const tol = 1e-7 / Math.max(L, EPS);
    const cuts = all.filter((k) => k.t > tol && k.t < 1 - tol).sort((a, b) => a.t - b.t);
    const tc = nearestOnSegment(c.start, c.end, at).t;
    const lo = [...cuts].reverse().find((k) => k.t < tc) ?? null;
    const hi = cuts.find((k) => k.t > tc) ?? null;
    if (!lo && !hi) return { ok: true, edits: [{ op: "removeCurve", id }], note: "No intersection: the curve was deleted." };
    return trimLine(c, lo, hi, feature, ids);
  }
  if (c.kind === "arc") {
    const ap = arcParams(c);
    const tol = 1e-7 / Math.max(ap.r, EPS);
    const cuts = all.filter((k) => k.t > tol && k.t < ap.sweep - tol).sort((a, b) => a.t - b.t);
    const tc = wrap(angleOf(sub(at, ap.center)) - ap.a0);
    const lo = [...cuts].reverse().find((k) => k.t < tc) ?? null;
    const hi = cuts.find((k) => k.t > tc) ?? null;
    if (!lo && !hi) return { ok: true, edits: [{ op: "removeCurve", id }], note: "No intersection: the curve was deleted." };
    return trimArc(c, lo, hi, feature, ids);
  }
  // Circle: at least two cuts; the clicked piece goes, the rest becomes an arc with the same id.
  const cuts = [...all].sort((a, b) => a.t - b.t);
  const unique = cuts.filter((k, i) => i === 0 || k.t - cuts[i - 1]!.t > 1e-9);
  if (unique.length < 2) return unique.length === 0 ? { ok: true, edits: [{ op: "removeCurve", id }], note: "No intersection: the circle was deleted." } : { ok: false, reason: "A circle needs two intersections to trim." };
  const tc = wrap(angleOf(sub(at, c.center)));
  let k = unique.findIndex((u) => u.t > tc);
  if (k < 0) k = 0;
  const hi = unique[k]!;
  const lo = unique[(k - 1 + unique.length) % unique.length]!;
  // Keep ccw from `hi` to `lo`.
  const arc: Arc = { kind: "arc", id, start: lit(polar(c.center, c.radius, hi.t)), end: lit(polar(c.center, c.radius, lo.t)), center: c.center, ccw: true, ...(c.construction ? { construction: true } : {}) };
  const keep = (feature.constraints ?? []).filter((con) => argsOf(con).some((a) => a === id || a.startsWith(`${id}.`)));
  const readd: v1.Constraint[] = keep.map((con) => (con.type === "fix" && con.entity === id ? { type: "fix", id: con.id, entity: `${id}.center` } : con));
  const edits: SketchEdit[] = [
    { op: "removeCurve", id },
    { op: "addCurve", curve: arc },
    ...readd.map((constraint): SketchEdit => ({ op: "addConstraint", constraint })),
    { op: "addConstraint", constraint: onCurveConstraint(`${id}.start`, hi.by, ids.next("on")) },
    { op: "addConstraint", constraint: onCurveConstraint(`${id}.end`, lo.by, ids.next("on")) },
  ];
  return { ok: true, edits };
}

function trimLine(c: Line, lo: Cut | null, hi: Cut | null, feature: v1.SketchFeature, ids: IdAllocator): OpResult {
  const id = c.id;
  const base = c.construction ? { construction: true } : {};
  if (!lo && hi) {
    const drops = dropsFor(feature, [`${id}.start`], [id]);
    return {
      ok: true,
      edits: [
        ...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })),
        { op: "replaceCurve", curve: { kind: "line", id, start: lit(hi.point), end: c.end, ...base } },
        { op: "addConstraint", constraint: onCurveConstraint(`${id}.start`, hi.by, ids.next("on")) },
      ],
    };
  }
  if (lo && !hi) {
    const drops = dropsFor(feature, [`${id}.end`], [id]);
    return {
      ok: true,
      edits: [
        ...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })),
        { op: "replaceCurve", curve: { kind: "line", id, start: c.start, end: lit(lo.point), ...base } },
        { op: "addConstraint", constraint: onCurveConstraint(`${id}.end`, lo.by, ids.next("on")) },
      ],
    };
  }
  // Middle piece: `id` keeps [start, lo]; a new line takes [hi, end] and the old end's constraints.
  const nid = ids.next("l");
  const cons = feature.constraints ?? [];
  const drops = dropsFor(feature, [`${id}.end`], [id]);
  const moved: v1.Constraint[] = [];
  const copies: v1.Constraint[] = [];
  for (const con of cons) {
    const args = argsOf(con);
    if (args.includes(`${id}.end`)) moved.push(renameArg(con, `${id}.end`, `${nid}.end`));
    else if ((con.type === "horizontal" || con.type === "vertical") && con.line === id) copies.push({ ...con, id: ids.next(con.type === "horizontal" ? "h" : "v"), line: nid });
    else if ((con.type === "parallel" || con.type === "perpendicular") && (con.a === id || con.b === id))
      copies.push({ ...con, id: ids.next(con.type === "parallel" ? "par" : "perp"), a: con.a === id ? nid : con.a, b: con.b === id ? nid : con.b });
  }
  return {
    ok: true,
    edits: [
      ...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })),
      { op: "replaceCurve", curve: { kind: "line", id, start: c.start, end: lit(lo!.point), ...base } },
      { op: "addCurve", curve: { kind: "line", id: nid, start: lit(hi!.point), end: c.end, ...base } },
      ...moved.map((constraint): SketchEdit => ({ op: "addConstraint", constraint })),
      ...copies.map((constraint): SketchEdit => ({ op: "addConstraint", constraint })),
      { op: "addConstraint", constraint: onCurveConstraint(`${id}.end`, lo!.by, ids.next("on")) },
      { op: "addConstraint", constraint: onCurveConstraint(`${nid}.start`, hi!.by, ids.next("on")) },
      { op: "addConstraint", constraint: { type: "parallel", id: ids.next("par"), a: id, b: nid } },
    ],
  };
}

function renameArg(c: v1.Constraint, from: string, to: string): v1.Constraint {
  const r = (x: string): string => (x === from ? to : x);
  switch (c.type) {
    case "horizontal":
    case "vertical":
      return { ...c, line: r(c.line) };
    case "radius":
    case "diameter":
      return { ...c, curve: r(c.curve) };
    case "point_on_line":
    case "midpoint":
      return { ...c, point: r(c.point), line: r(c.line) };
    case "point_on_circle":
      return { ...c, point: r(c.point), curve: r(c.curve) };
    case "symmetric":
      return { ...c, a: r(c.a), b: r(c.b), line: r(c.line) };
    case "fix":
      return { ...c, entity: r(c.entity) };
    default:
      return { ...c, a: r(c.a), b: r(c.b) } as v1.Constraint;
  }
}

function arcFromSpan(c: Arc, s0: number, s1: number): Arc {
  const ap = arcParams(c);
  const p0 = lit(polar(ap.center, ap.r, ap.a0 + s0));
  const p1 = lit(polar(ap.center, ap.r, ap.a0 + s1));
  const base = c.construction ? { construction: true } : {};
  return c.ccw ? { kind: "arc", id: c.id, start: p0, end: p1, center: c.center, ccw: true, ...base } : { kind: "arc", id: c.id, start: p1, end: p0, center: c.center, ccw: false, ...base };
}

function trimArc(c: Arc, lo: Cut | null, hi: Cut | null, feature: v1.SketchFeature, ids: IdAllocator): OpResult {
  const ap = arcParams(c);
  // IR end names of the ccw span's start and end.
  const ccwStart = c.ccw ? `${c.id}.start` : `${c.id}.end`;
  const ccwEnd = c.ccw ? `${c.id}.end` : `${c.id}.start`;
  if (lo && hi) {
    // Split: `id` keeps [0, lo], a new arc takes [hi, sweep].
    const nid = ids.next("a");
    const first = arcFromSpan(c, 0, lo.t);
    const secondRaw = arcFromSpan(c, hi.t, ap.sweep);
    const second: Arc = { ...secondRaw, id: nid };
    const drops = dropsFor(feature, [ccwEnd], []);
    const moved = (feature.constraints ?? []).filter((con) => argsOf(con).includes(ccwEnd)).map((con) => renameArg(con, ccwEnd, c.ccw ? `${nid}.end` : `${nid}.start`));
    return {
      ok: true,
      edits: [
        ...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })),
        { op: "replaceCurve", curve: first },
        { op: "addCurve", curve: second },
        ...moved.map((constraint): SketchEdit => ({ op: "addConstraint", constraint })),
        { op: "addConstraint", constraint: { type: "coincident", id: ids.next("con"), a: `${c.id}.center`, b: `${nid}.center` } },
        { op: "addConstraint", constraint: { type: "equal", id: ids.next("eq"), a: c.id, b: nid } },
        { op: "addConstraint", constraint: onCurveConstraint(ccwEnd, lo.by, ids.next("on")) },
        { op: "addConstraint", constraint: onCurveConstraint(c.ccw ? `${nid}.start` : `${nid}.end`, hi.by, ids.next("on")) },
      ],
    };
  }
  const moving = lo ? ccwEnd : ccwStart;
  const next = lo ? arcFromSpan(c, 0, lo.t) : arcFromSpan(c, hi!.t, ap.sweep);
  const by = (lo ?? hi)!.by;
  const drops = dropsFor(feature, [moving], []);
  return {
    ok: true,
    edits: [
      ...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })),
      { op: "replaceCurve", curve: next },
      { op: "addConstraint", constraint: onCurveConstraint(moving, by, ids.next("on")) },
    ],
  };
}

// ─── Extend ──────────────────────────────────────────────────────────────────────────────────

/** Extend the end of a line or arc nearest `at` to the next curve it meets. */
export function extend(id: string, at: P2, curves: readonly LiteralCurve[], feature: v1.SketchFeature, ids: IdAllocator): OpResult {
  const c = findCurve(curves, id);
  const others = curves.filter((o) => o.id !== id && o.kind !== "point");
  if (c?.kind === "line") {
    const atEnd = dist(at, c.end) <= dist(at, c.start);
    const from = atEnd ? c.end : c.start;
    const dir = norm(atEnd ? sub(c.end, c.start) : sub(c.start, c.end));
    const far = add(from, scale(dir, 1e6));
    const ray: Line = { kind: "line", id: "__ray", start: from, end: far };
    let best: { p: P2; d: number; by: LiteralCurve } | null = null;
    for (const o of others) {
      for (const p of intersect(ray, o)) {
        const d = dot(sub(p, from), dir);
        if (d > 1e-7 && (!best || d < best.d)) best = { p, d, by: o };
      }
    }
    if (!best) return { ok: false, reason: "Nothing to extend to in that direction." };
    const ref = `${id}.${atEnd ? "end" : "start"}`;
    const drops = dropsFor(feature, [ref], [id]);
    const base = c.construction ? { construction: true } : {};
    const curve: Line = atEnd ? { kind: "line", id, start: c.start, end: lit(best.p), ...base } : { kind: "line", id, start: lit(best.p), end: c.end, ...base };
    return {
      ok: true,
      edits: [...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })), { op: "replaceCurve", curve }, { op: "addConstraint", constraint: onCurveConstraint(ref, best.by, ids.next("on")) }],
    };
  }
  if (c?.kind === "arc") {
    const ap = arcParams(c);
    const endPt = polar(ap.center, ap.r, ap.a0 + ap.sweep);
    const startPt = polar(ap.center, ap.r, ap.a0);
    const atCcwEnd = dist(at, endPt) <= dist(at, startPt);
    const full: LiteralCurve = { kind: "circle", id: "__full", center: ap.center, radius: ap.r };
    let best: { gap: number; by: LiteralCurve } | null = null;
    for (const o of others) {
      for (const p of intersect(full, o)) {
        const t = wrap(angleOf(sub(p, ap.center)) - ap.a0);
        // Angular distance beyond the end being extended.
        const gap = atCcwEnd ? t - ap.sweep : wrap(-t);
        const g = atCcwEnd ? (gap > 1e-9 ? gap : Infinity) : gap > 1e-9 && gap < 2 * Math.PI - ap.sweep ? gap : Infinity;
        if (Number.isFinite(g) && g < 2 * Math.PI - ap.sweep && (!best || g < best.gap)) best = { gap: g, by: o };
      }
    }
    if (!best) return { ok: false, reason: "Nothing to extend to along this arc." };
    const next = atCcwEnd ? arcFromSpan(c, 0, ap.sweep + best.gap) : arcFromSpan(c, -best.gap, ap.sweep);
    const ref = atCcwEnd === c.ccw ? `${id}.end` : `${id}.start`;
    const drops = dropsFor(feature, [ref], []);
    return {
      ok: true,
      edits: [...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })), { op: "replaceCurve", curve: next }, { op: "addConstraint", constraint: onCurveConstraint(ref, best.by, ids.next("on")) }],
    };
  }
  return { ok: false, reason: "Click near the end of a line or an arc." };
}

// ─── Offset ──────────────────────────────────────────────────────────────────────────────────

/**
 * Offset curves by `distance` towards `side` (a point): each line gets a parallel copy with a
 * driving distance to its original, each arc/circle a concentric copy; consecutive offset lines
 * of a chain are joined at their intersection so the copy stays closed where the original was.
 */
export function offset(selected: readonly string[], distance: number, side: P2, curves: readonly LiteralCurve[], ids: IdAllocator, construction = false): OpResult {
  if (!(distance > 0)) return { ok: false, reason: "The offset distance must be positive." };
  const src = selected.map((id) => findCurve(curves, id)).filter((c): c is LiteralCurve => !!c && c.kind !== "point");
  if (src.length === 0) return { ok: false, reason: "Select lines, arcs or circles to offset." };
  // One side for the chain: the side of `side` relative to the curve nearest to it.
  const ref = src.map((c) => ({ c, d: nearestOn(c, side) })).sort((a, b) => a.d - b.d)[0]!.c;
  const outward = sideSign(ref, side);
  const edits: SketchEdit[] = [];
  const newLines = new Map<string, Line>();
  const base = construction ? { construction: true } : {};
  for (const c of src) {
    const s = c === ref ? outward : chainSign(c, ref, outward, src);
    if (c.kind === "line") {
      const n = scale(perp(norm(sub(c.end, c.start))), s * distance);
      const id = ids.next("l");
      const nl: Line = { kind: "line", id, start: add(c.start, n), end: add(c.end, n), ...base };
      newLines.set(c.id, nl);
    } else if (c.kind === "circle") {
      const r = c.radius + s * distance;
      if (!(r > 1e-6)) return { ok: false, reason: `Offsetting ${c.id} inward by ${distance} collapses it.` };
      const id = ids.next("c");
      edits.push({ op: "addCurve", curve: { kind: "circle", id, center: c.center, radius: r, ...base } });
      edits.push({ op: "addConstraint", constraint: { type: "coincident", id: ids.next("con"), a: `${c.id}.center`, b: `${id}.center` } });
    } else if (c.kind === "arc") {
      const ap = arcParams(c);
      const r = ap.r + s * distance;
      if (!(r > 1e-6)) return { ok: false, reason: `Offsetting ${c.id} inward by ${distance} collapses it.` };
      const id = ids.next("a");
      const k = r / ap.r;
      edits.push({ op: "addCurve", curve: { kind: "arc", id, center: c.center, start: add(c.center, scale(sub(c.start, c.center), k)), end: add(c.center, scale(sub(c.end, c.center), k)), ccw: c.ccw, ...base } });
      edits.push({ op: "addConstraint", constraint: { type: "coincident", id: ids.next("con"), a: `${c.id}.center`, b: `${id}.center` } });
    }
  }
  // Join consecutive offset lines whose originals share an end.
  const lines = [...newLines.entries()];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const [oa, na] = lines[i]!;
      const [ob, nb] = lines[j]!;
      const a = findCurve(curves, oa) as Line;
      const b = findCurve(curves, ob) as Line;
      const shared = sharedEnd(a, b);
      if (!shared) continue;
      const r = sub(na.end, na.start);
      const q = sub(nb.end, nb.start);
      const den = cross(r, q);
      if (Math.abs(den) < 1e-12) continue;
      const t = cross(sub(nb.start, na.start), q) / den;
      const p = lit(add(na.start, scale(r, t)));
      if (shared[0] === "start") na.start = p;
      else na.end = p;
      if (shared[1] === "start") nb.start = p;
      else nb.end = p;
    }
  }
  for (const [orig, nl] of newLines) {
    edits.push({ op: "addCurve", curve: nl });
    edits.push({ op: "addConstraint", constraint: { type: "parallel", id: ids.next("par"), a: orig, b: nl.id } });
    edits.push({ op: "addConstraint", constraint: { type: "distance", id: ids.next("d"), a: `${nl.id}.start`, b: orig, value: distance } });
  }
  return { ok: true, edits };
}

function nearestOn(c: LiteralCurve, p: P2): number {
  if (c.kind === "line") return dist(nearestOnSegment(c.start, c.end, p).point, p);
  if (c.kind === "circle") return Math.abs(dist(c.center, p) - c.radius);
  if (c.kind === "arc") return Math.abs(dist(c.center, p) - dist(c.center, c.start));
  return Infinity;
}

/** +1 when `p` is on the left of a line (or outside a circle/arc), else −1. */
function sideSign(c: LiteralCurve, p: P2): number {
  if (c.kind === "line") return cross(sub(c.end, c.start), sub(p, c.start)) >= 0 ? 1 : -1;
  if (c.kind === "circle") return dist(c.center, p) >= c.radius ? 1 : -1;
  if (c.kind === "arc") return dist(c.center, p) >= dist(c.center, c.start) ? 1 : -1;
  return 1;
}

/** The side for a curve of a chain, consistent with the reference curve's side. */
function chainSign(c: LiteralCurve, ref: LiteralCurve, refSign: number, chain: readonly LiteralCurve[]): number {
  // Lines of a loop traversed consistently: the left side is inside for a ccw loop. Compare the
  // loop's orientation along each line: follow shared ends from `ref` to `c`.
  if (c.kind !== "line" || ref.kind !== "line") return refSign;
  const lines = chain.filter((x): x is Line => x.kind === "line");
  // Orientation flips when a shared end is start-start or end-end.
  const seen = new Map<string, number>([[ref.id, refSign]]);
  const queue: Line[] = [ref];
  while (queue.length) {
    const a = queue.shift()!;
    const sa = seen.get(a.id)!;
    for (const b of lines) {
      if (seen.has(b.id)) continue;
      const s = sharedEnd(a, b);
      if (!s) continue;
      const flip = s[0] === s[1];
      seen.set(b.id, flip ? -sa : sa);
      queue.push(b);
    }
  }
  return seen.get(c.id) ?? refSign;
}

function sharedEnd(a: Line, b: Line): ["start" | "end", "start" | "end"] | null {
  const pairs: Array<["start" | "end", "start" | "end"]> = [
    ["start", "start"],
    ["start", "end"],
    ["end", "start"],
    ["end", "end"],
  ];
  for (const [x, y] of pairs) if (dist(a[x], b[y]) <= 1e-6) return [x, y];
  return null;
}

// ─── Mirror ──────────────────────────────────────────────────────────────────────────────────

/** Mirror curves about a line: copies bound by `symmetric` (points on the axis: `point_on_line`). */
export function mirror(selected: readonly string[], axisId: string, curves: readonly LiteralCurve[], ids: IdAllocator): OpResult {
  const axis = findCurve(curves, axisId);
  if (axis?.kind !== "line") return { ok: false, reason: "Pick a line as the mirror axis." };
  const src = selected.map((id) => findCurve(curves, id)).filter((c): c is LiteralCurve => !!c && c.id !== axisId);
  if (src.length === 0) return { ok: false, reason: "Select the curves to mirror." };
  const m = (p: P2): P2 => lit(mirrorPoint(p, axis.start, axis.end));
  const onAxis = (p: P2): boolean => dist(p, projectOnLine(axis.start, axis.end, p)) <= 1e-6;
  const edits: SketchEdit[] = [];
  const cons: v1.Constraint[] = [];
  const bind = (a: string, b: string, p: P2): void => {
    if (onAxis(p)) cons.push({ type: "point_on_line", id: ids.next("on"), point: a, line: axisId });
    else cons.push({ type: "symmetric", id: ids.next("sym"), a, b, line: axisId });
  };
  for (const c of src) {
    const base = c.construction ? { construction: true } : {};
    switch (c.kind) {
      case "point": {
        const id = ids.next("p");
        edits.push({ op: "addCurve", curve: { kind: "point", id, at: m(c.at), ...base } });
        bind(c.id, id, c.at);
        break;
      }
      case "line": {
        const id = ids.next("l");
        edits.push({ op: "addCurve", curve: { kind: "line", id, start: m(c.start), end: m(c.end), ...base } });
        bind(`${c.id}.start`, `${id}.start`, c.start);
        bind(`${c.id}.end`, `${id}.end`, c.end);
        break;
      }
      case "circle": {
        const id = ids.next("c");
        edits.push({ op: "addCurve", curve: { kind: "circle", id, center: m(c.center), radius: c.radius, ...base } });
        bind(`${c.id}.center`, `${id}.center`, c.center);
        cons.push({ type: "equal", id: ids.next("eq"), a: c.id, b: id });
        break;
      }
      case "arc": {
        const id = ids.next("a");
        edits.push({ op: "addCurve", curve: { kind: "arc", id, start: m(c.start), end: m(c.end), center: m(c.center), ccw: !c.ccw, ...base } });
        bind(`${c.id}.center`, `${id}.center`, c.center);
        bind(`${c.id}.start`, `${id}.start`, c.start);
        cons.push({ type: "equal", id: ids.next("eq"), a: c.id, b: id });
        break;
      }
    }
  }
  return { ok: true, edits: [...edits, ...cons.map((constraint): SketchEdit => ({ op: "addConstraint", constraint }))] };
}

// ─── Corner fillet and chamfer ───────────────────────────────────────────────────────────────

interface Corner {
  a: Line;
  b: Line;
  aEnd: "start" | "end";
  bEnd: "start" | "end";
  vertex: P2;
}

/** The corner where exactly two lines meet nearest `at` (within `tol`). */
export function findCorner(at: P2, curves: readonly LiteralCurve[], tol: number): Corner | null {
  const lines = curves.filter((c): c is Line => c.kind === "line" && !c.construction);
  let best: { corner: Corner; d: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const s = sharedEnd(lines[i]!, lines[j]!);
      if (!s) continue;
      const v = lines[i]![s[0]];
      const d = dist(v, at);
      if (d > tol) continue;
      const others = lines.filter((l, k) => k !== i && k !== j && (dist(l.start, v) <= 1e-6 || dist(l.end, v) <= 1e-6));
      if (others.length) continue;
      if (!best || d < best.d) best = { corner: { a: lines[i]!, b: lines[j]!, aEnd: s[0], bEnd: s[1], vertex: v }, d };
    }
  }
  return best?.corner ?? null;
}

function cornerFrame(k: Corner): { u1: P2; u2: P2; l1: number; l2: number; theta: number } {
  const far1 = k.aEnd === "start" ? k.a.end : k.a.start;
  const far2 = k.bEnd === "start" ? k.b.end : k.b.start;
  const u1 = norm(sub(far1, k.vertex));
  const u2 = norm(sub(far2, k.vertex));
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(u1, u2))));
  return { u1, u2, l1: dist(far1, k.vertex), l2: dist(far2, k.vertex), theta };
}

function withEnd(l: Line, which: "start" | "end", p: P2): Line {
  return which === "start" ? { ...l, start: lit(p) } : { ...l, end: lit(p) };
}

/** Round a corner with an arc of radius `r` tangent to both lines (plus its radius dimension). */
export function filletCorner(k: Corner, r: number, feature: v1.SketchFeature, ids: IdAllocator): OpResult {
  const f = cornerFrame(k);
  if (!(r > 0)) return { ok: false, reason: "The fillet radius must be positive." };
  if (f.theta < 1e-3 || Math.PI - f.theta < 1e-3) return { ok: false, reason: "The lines are (nearly) parallel: no corner to round." };
  const t = r / Math.tan(f.theta / 2);
  if (t >= f.l1 - 1e-6 || t >= f.l2 - 1e-6) return { ok: false, reason: `A radius of ${r} does not fit these lines.` };
  const p1 = add(k.vertex, scale(f.u1, t));
  const p2 = add(k.vertex, scale(f.u2, t));
  const bis = norm(add(f.u1, f.u2));
  const center = add(k.vertex, scale(bis, r / Math.sin(f.theta / 2)));
  const ccw = cross(sub(p1, center), sub(p2, center)) > 0;
  const aid = ids.next("a");
  const refs = [`${k.a.id}.${k.aEnd}`, `${k.b.id}.${k.bEnd}`];
  const drops = dropsFor(feature, refs, [k.a.id, k.b.id]);
  const arc: Arc = { kind: "arc", id: aid, start: lit(p1), end: lit(p2), center: lit(center), ccw };
  return {
    ok: true,
    edits: [
      ...drops.map((d): SketchEdit => ({ op: "removeConstraint", id: d })),
      { op: "replaceCurve", curve: withEnd(k.a, k.aEnd, p1) },
      { op: "replaceCurve", curve: withEnd(k.b, k.bEnd, p2) },
      { op: "addCurve", curve: arc },
      { op: "addConstraint", constraint: { type: "tangent", id: ids.next("tan"), a: k.a.id, b: aid } },
      { op: "addConstraint", constraint: { type: "tangent", id: ids.next("tan"), a: k.b.id, b: aid } },
      { op: "addConstraint", constraint: { type: "radius", id: ids.next("r"), curve: aid, value: r } },
    ],
    ...(drops.length ? { note: `Removed ${drops.length} constraint(s) on the old corner.` } : {}),
  };
}

/** Cut a corner with a line `d` from the corner along each line. */
export function chamferCorner(k: Corner, d: number, feature: v1.SketchFeature, ids: IdAllocator): OpResult {
  const f = cornerFrame(k);
  if (!(d > 0)) return { ok: false, reason: "The chamfer distance must be positive." };
  if (d >= f.l1 - 1e-6 || d >= f.l2 - 1e-6) return { ok: false, reason: `A chamfer of ${d} does not fit these lines.` };
  const p1 = add(k.vertex, scale(f.u1, d));
  const p2 = add(k.vertex, scale(f.u2, d));
  const lid = ids.next("l");
  const refs = [`${k.a.id}.${k.aEnd}`, `${k.b.id}.${k.bEnd}`];
  const drops = dropsFor(feature, refs, [k.a.id, k.b.id]);
  return {
    ok: true,
    edits: [
      ...drops.map((x): SketchEdit => ({ op: "removeConstraint", id: x })),
      { op: "replaceCurve", curve: withEnd(k.a, k.aEnd, p1) },
      { op: "replaceCurve", curve: withEnd(k.b, k.bEnd, p2) },
      { op: "addCurve", curve: { kind: "line", id: lid, start: lit(p1), end: lit(p2) } },
      { op: "addConstraint", constraint: { type: "distance", id: ids.next("d"), a: `${lid}.start`, b: `${lid}.end`, value: dist(p1, p2) } },
    ],
    ...(drops.length ? { note: `Removed ${drops.length} constraint(s) on the old corner.` } : {}),
  };
}
