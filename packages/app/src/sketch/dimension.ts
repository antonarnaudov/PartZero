/**
 * Dimensions: what the dimension tool proposes for a pick (plan §2.7 "Dimensions"), the value
 * it measures now, and how a dimension is drawn (witness lines, dimension line, label).
 *
 * | Pick | Dimension |
 * |---|---|
 * | a line | aligned length: `distance(l.start, l.end)` |
 * | two points | aligned distance: `distance(a, b)` |
 * | a point and a line; two parallel lines | perpendicular distance: `distance(point, line)` |
 * | two non-parallel lines | angle: `angle(a, b)`, counter-clockwise, below 180° |
 * | a circle / an arc | diameter / radius (Shift toggles) |
 * | a point and a circle; two circles | centre distance |
 *
 * Horizontal and vertical point-to-point distances need SPEC set C (FM4); until then a line
 * constrained horizontal or vertical is dimensioned by its length.
 */
import type { v1 } from "@aicad/ir-types";
import type { ConstraintInfo } from "./engine-types";
import { findCurve, refPoint, splitRef } from "./constraints";
import { add, angleOf, arcParams, cross, deg, dist, dot, len, mid, norm, perp, polar, projectOnLine, scale, sub, wrap, type LiteralCurve, type P2 } from "./geom";

export type DimPick = { kind: "curve"; id: string } | { kind: "point"; ref: string };

/** A dimension constraint without its id and value. */
export type DimShape =
  | { type: "distance"; a: string; b: string }
  | { type: "angle"; a: string; b: string }
  | { type: "radius"; curve: string }
  | { type: "diameter"; curve: string };

export interface DimProposal {
  shape: DimShape;
  /** The value measured on the current geometry (mm or degrees). */
  measured: number;
  field: "length" | "angle";
}

function curve(curves: readonly LiteralCurve[], id: string): LiteralCurve | undefined {
  return findCurve(curves, id);
}

/** Measure a dimension shape on the geometry. */
export function measure(shape: DimShape, curves: readonly LiteralCurve[]): number | null {
  switch (shape.type) {
    case "distance": {
      const a = refPoint(curves, shape.a);
      if (!a) return null;
      const bc = curve(curves, shape.b);
      if (bc?.kind === "line") return dist(a, projectOnLine(bc.start, bc.end, a));
      const b = refPoint(curves, shape.b);
      return b ? dist(a, b) : null;
    }
    case "angle": {
      const a = curve(curves, shape.a);
      const b = curve(curves, shape.b);
      if (a?.kind !== "line" || b?.kind !== "line") return null;
      return deg(wrap(angleOf(sub(b.end, b.start)) - angleOf(sub(a.end, a.start))));
    }
    case "radius":
    case "diameter": {
      const c = curve(curves, shape.curve);
      const r = c?.kind === "circle" ? c.radius : c?.kind === "arc" ? dist(c.center, c.start) : null;
      return r === null ? null : shape.type === "radius" ? r : 2 * r;
    }
  }
}

function lineDir(c: Extract<LiteralCurve, { kind: "line" }>): P2 {
  return norm(sub(c.end, c.start));
}

/** The dimension for a pick, or null when the pick does not make one. `alt` toggles radius/diameter. */
export function proposeDimension(picks: readonly DimPick[], curves: readonly LiteralCurve[], alt = false): DimProposal | null {
  const shape = shapeFor(picks, curves, alt);
  if (!shape) return null;
  const measured = measure(shape, curves);
  if (measured === null || !Number.isFinite(measured)) return null;
  return { shape, measured, field: shape.type === "angle" ? "angle" : "length" };
}

function shapeFor(picks: readonly DimPick[], curves: readonly LiteralCurve[], alt: boolean): DimShape | null {
  const asPoint = (p: DimPick): string | null => {
    if (p.kind === "point") return p.ref;
    const c = curve(curves, p.id);
    return c?.kind === "point" ? c.id : null;
  };
  const asCurve = (p: DimPick): LiteralCurve | null => {
    if (p.kind !== "curve") return null;
    const c = curve(curves, p.id);
    return c && c.kind !== "point" ? c : null;
  };
  if (picks.length === 1) {
    const c = asCurve(picks[0]!);
    if (!c) return null;
    if (c.kind === "line") return { type: "distance", a: `${c.id}.start`, b: `${c.id}.end` };
    const round = c.kind === "circle" ? !alt : alt;
    return round ? { type: "diameter", curve: c.id } : { type: "radius", curve: c.id };
  }
  if (picks.length !== 2) return null;
  const [p0, p1] = picks as [DimPick, DimPick];
  const a = asPoint(p0);
  const b = asPoint(p1);
  const ca = asCurve(p0);
  const cb = asCurve(p1);
  if (a && b) return a === b ? null : { type: "distance", a, b };
  const center = (c: LiteralCurve): string | null => (c.kind === "circle" || c.kind === "arc" ? `${c.id}.center` : null);
  if (a && cb) return cb.kind === "line" ? { type: "distance", a, b: cb.id } : center(cb) ? { type: "distance", a, b: center(cb)! } : null;
  if (b && ca) return ca.kind === "line" ? { type: "distance", a: b, b: ca.id } : center(ca) ? { type: "distance", a: b, b: center(ca)! } : null;
  if (ca && cb) {
    if (ca.kind === "line" && cb.kind === "line") {
      if (ca.id === cb.id) return null;
      const s = Math.abs(cross(lineDir(ca), lineDir(cb)));
      if (s < 1e-9) return { type: "distance", a: `${ca.id}.start`, b: cb.id };
      const m = measure({ type: "angle", a: ca.id, b: cb.id }, curves)!;
      return m <= 180 ? { type: "angle", a: ca.id, b: cb.id } : { type: "angle", a: cb.id, b: ca.id };
    }
    const c0 = center(ca);
    const c1 = center(cb);
    if (c0 && c1 && c0 !== c1) return { type: "distance", a: c0, b: c1 };
    if (ca.kind === "line" && c1) return { type: "distance", a: c1, b: ca.id };
    if (cb.kind === "line" && c0) return { type: "distance", a: c0, b: cb.id };
  }
  return null;
}

/** The IR constraint of a proposal with its id and value (driving) or as a reference. */
export function dimensionConstraint(shape: DimShape, id: string, value: v1.Scalar | null): v1.Constraint {
  const v = value === null ? { driving: false } : { value };
  switch (shape.type) {
    case "distance":
      return { type: "distance", id, a: shape.a, b: shape.b, ...v };
    case "angle":
      return { type: "angle", id, a: shape.a, b: shape.b, ...v };
    case "radius":
      return { type: "radius", id, curve: shape.curve, ...v };
    case "diameter":
      return { type: "diameter", id, curve: shape.curve, ...v };
  }
}

/** The shape of an existing dimension constraint (null for other constraints). */
export function shapeOf(c: v1.Constraint): DimShape | null {
  switch (c.type) {
    case "distance":
      return { type: "distance", a: c.a, b: c.b };
    case "angle":
      return { type: "angle", a: c.a, b: c.b };
    case "radius":
      return { type: "radius", curve: c.curve };
    case "diameter":
      return { type: "diameter", curve: c.curve };
    default:
      return null;
  }
}

// ─── Drawing ─────────────────────────────────────────────────────────────────────────────────

export interface DimGraphic {
  /** Witness and dimension lines, sketch coordinates. */
  lines: Array<[P2, P2]>;
  /** An arc for angle dimensions. */
  arc?: { center: P2; r: number; a0: number; a1: number };
  /** Arrow tips: position and pointing direction (unit). */
  arrows: Array<{ at: P2; dir: P2 }>;
  /** The label anchor (sketch coordinates). */
  label: P2;
}

/**
 * The drawing of a dimension. `offset` is the label position the user dragged to (sketch
 * coordinates), or null for the default placement; `px` is mm per pixel (default spacing).
 */
export function dimGraphic(shape: DimShape, curves: readonly LiteralCurve[], offset: P2 | null, px: number): DimGraphic | null {
  const gap = 18 * px;
  switch (shape.type) {
    case "distance": {
      const a = refPoint(curves, shape.a);
      if (!a) return null;
      const lineB = curve(curves, shape.b);
      const b = lineB?.kind === "line" ? projectOnLine(lineB.start, lineB.end, a) : refPoint(curves, shape.b);
      if (!b) return null;
      const d = sub(b, a);
      const l = len(d);
      const u: P2 = l > 1e-12 ? scale(d, 1 / l) : [1, 0];
      const n = perp(u);
      // Default: offset to the left of a → b (outside a CCW profile for its bottom edge… close enough).
      const m = mid(a, b);
      const off = offset ? dot(sub(offset, m), n) : gap;
      const along = offset ? dot(sub(offset, m), u) : 0;
      const a2 = add(a, scale(n, off));
      const b2 = add(b, scale(n, off));
      const ext = Math.sign(off || 1) * 4 * px;
      return {
        lines: [
          [a, add(a2, scale(n, ext))],
          [b, add(b2, scale(n, ext))],
          [a2, b2],
        ],
        arrows: [
          { at: a2, dir: scale(u, -1) },
          { at: b2, dir: u },
        ],
        label: add(add(m, scale(n, off)), scale(u, along)),
      };
    }
    case "radius":
    case "diameter": {
      const c = curve(curves, shape.curve);
      if (!c || (c.kind !== "circle" && c.kind !== "arc")) return null;
      const center = c.center;
      const r = c.kind === "circle" ? c.radius : dist(c.center, c.start);
      let dir: P2 = offset ? norm(sub(offset, center)) : norm([1, 1]);
      if (len(dir) < 0.5) dir = [1, 0];
      if (c.kind === "arc" && !offset) {
        const ap = arcParams(c);
        dir = norm(sub(polar(ap.center, ap.r, ap.a0 + ap.sweep / 2), ap.center));
      }
      const rim = add(center, scale(dir, r));
      const label = offset ?? add(rim, scale(dir, gap * 1.5));
      const lines: Array<[P2, P2]> = shape.type === "diameter" ? [[sub(center, scale(dir, r)), rim]] : [[center, rim]];
      const outside = dist(label, center) > r;
      if (outside) lines.push([rim, label]);
      return { lines, arrows: [{ at: rim, dir }], label };
    }
    case "angle": {
      const la = curve(curves, shape.a);
      const lb = curve(curves, shape.b);
      if (la?.kind !== "line" || lb?.kind !== "line") return null;
      const r0 = sub(la.end, la.start);
      const s0 = sub(lb.end, lb.start);
      const den = cross(r0, s0);
      if (Math.abs(den) < 1e-12) return null;
      const t = cross(sub(lb.start, la.start), s0) / den;
      const vertex = add(la.start, scale(r0, t));
      const a0 = angleOf(r0);
      const a1 = a0 + wrap(angleOf(s0) - a0);
      const rr = offset ? dist(offset, vertex) : Math.max(30 * px, 0.4 * Math.min(len(r0), len(s0)));
      const am = (a0 + a1) / 2;
      return {
        lines: [],
        arc: { center: vertex, r: rr, a0, a1 },
        arrows: [
          { at: polar(vertex, rr, a0), dir: [Math.sin(a0), -Math.cos(a0)] },
          { at: polar(vertex, rr, a1), dir: [-Math.sin(a1), Math.cos(a1)] },
        ],
        label: offset ?? polar(vertex, rr + 10 * px, am),
      };
    }
  }
}

/** The label text of a dimension: `12.5`, `⌀10`, `R5`, `30°`; expressions show `name = value`. */
export function dimText(shape: DimShape, info: ConstraintInfo | undefined, measured: number | null): string {
  const value = info?.driving === false ? (info.measured ?? measured) : (info?.value ?? info?.measured ?? measured);
  const n = value === null || value === undefined ? "?" : format(value, shape.type === "angle");
  const prefix = shape.type === "diameter" ? "⌀" : shape.type === "radius" ? "R" : "";
  const body = `${prefix}${n}${shape.type === "angle" ? "°" : ""}`;
  const shown = info?.expr ? `${info.expr} = ${body}` : body;
  return info?.driving === false ? `(${shown})` : shown;
}

function format(x: number, angle: boolean): string {
  const s = x.toFixed(angle ? 2 : 3);
  return s.replace(/\.?0+$/, "");
}

/** Curve ids a point reference or a curve id belongs to. */
export function curveOfRef(ref: string): string {
  return splitRef(ref)[0];
}
