/**
 * Drag math for manipulator handles: the cursor ray projected onto the handle's axis or plane,
 * then snapped to increments and clamped to the feasible range. Pure functions (unit-tested).
 */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../view-camera";
import type { HandleSpec } from "./types";

export interface Ray {
  origin: Vec3;
  dir: Vec3;
}

/**
 * Parameter `s` of the point on the line `p + s·a` closest to the ray; `null` when the ray is
 * (nearly) parallel to the line, where the drag is undefined.
 */
export function rayLineParam(ray: Ray, p: Vec3, a: Vec3): number | null {
  const u = normalize(a);
  const d = normalize(ray.dir);
  const w = sub(p, ray.origin);
  const b = dot(u, d);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  // Minimize |p + s·u − (o + t·d)|: s = (b·(w·d) − (w·u)) / (1 − b²).
  return (b * dot(w, d) - dot(w, u)) / denom;
}

/** Intersection of the ray with the plane through `p` with normal `n` (null when parallel or behind). */
export function rayPlane(ray: Ray, p: Vec3, n: Vec3): Vec3 | null {
  const denom = dot(ray.dir, n);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(sub(p, ray.origin), n) / denom;
  if (t < 0) return null;
  return add(ray.origin, scale(ray.dir, t));
}

/** Signed angle (degrees) of `v` around `axis`, measured from `ref`. */
export function angleAround(v: Vec3, axis: Vec3, ref: Vec3): number {
  const a = normalize(axis);
  const r = normalize(sub(ref, scale(a, dot(ref, a))));
  const q = sub(v, scale(a, dot(v, a)));
  const y = cross(a, r);
  return (Math.atan2(dot(q, y), dot(q, r)) * 180) / Math.PI;
}

/** A unit vector perpendicular to `axis` (for rotate handles without `ref`). */
export function perpendicular(axis: Vec3): Vec3 {
  const a = normalize(axis);
  const helper: Vec3 = Math.abs(a[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return normalize(cross(helper, a));
}

export function snap(value: number, step: number): number {
  if (!(step > 0)) return value;
  const s = Math.round(value / step) * step;
  // Kill float noise (0.1 + 0.2 style) so typed and dragged values compare equal.
  return Number(s.toFixed(10));
}

export function clamp(value: number, min?: number, max?: number): { value: number; clamped?: "min" | "max" } {
  if (min !== undefined && value < min) return { value: min, clamped: "min" };
  if (max !== undefined && value > max) return { value: max, clamped: "max" };
  return { value };
}

export function defaultStep(h: Pick<HandleSpec, "kind" | "step" | "fineStep">, fine: boolean): number {
  if (h.kind === "rotate") return fine ? (h.fineStep ?? 1) : (h.step ?? 15);
  return fine ? (h.fineStep ?? 0.5) : (h.step ?? 1);
}

/** Where the drag started, captured on pointer-down. */
export interface DragStart {
  value: number;
  /** The raw parameter (s along the axis, or the angle) at pointer-down. */
  param: number;
}

/** The raw drag parameter of a ray for a handle: axis parameter (mm) or angle (degrees). */
export function dragParam(h: HandleSpec, ray: Ray): number | null {
  if (h.kind === "rotate") {
    const hit = rayPlane(ray, h.origin, h.axis);
    if (!hit) return null;
    const v = sub(hit, h.origin);
    if (length(v) < 1e-12) return null;
    return angleAround(v, h.axis, h.ref ?? perpendicular(h.axis));
  }
  return rayLineParam(ray, h.origin, h.axis);
}

/** Unwrap an angle delta into (−180, 180] so a drag across ±180° continues smoothly. */
export function unwrapDegrees(delta: number): number {
  let d = delta % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

/**
 * The handle value for the current ray, given the drag start. Rotation accumulates across the
 * ±180° seam through `prevParam` (the previous raw angle).
 */
export function dragValue(
  h: HandleSpec,
  start: DragStart,
  param: number,
  opts: { fine: boolean; snap: boolean; accumulated?: number },
): { value: number; clamped?: "min" | "max" } {
  const delta = h.kind === "rotate" ? (opts.accumulated ?? unwrapDegrees(param - start.param)) : param - start.param;
  let v = start.value + delta;
  if (h.kind === "radius" || h.kind === "pushPull" || h.kind === "linear") v = Number.isFinite(v) ? v : start.value;
  if (opts.snap) v = snap(v, defaultStep(h, opts.fine));
  return clamp(v, h.min, h.max);
}

/** The world position of a handle's grip (arrow tip, knob, or the ring point at the value). */
export function gripPoint(h: HandleSpec, size: number): Vec3 {
  if (h.kind === "rotate") {
    const ref = h.ref ?? perpendicular(h.axis);
    const a = normalize(h.axis);
    const r = normalize(sub(ref, scale(a, dot(ref, a))));
    const y = cross(a, r);
    const t = (h.value * Math.PI) / 180;
    return add(h.origin, add(scale(r, Math.cos(t) * size), scale(y, Math.sin(t) * size)));
  }
  return add(h.origin, scale(normalize(h.axis), h.value));
}
