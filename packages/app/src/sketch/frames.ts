/**
 * Sketch plane frames (SPEC-v1 §3.1): the origin planes `XY`, `XZ`, `YZ` (v0 §2) and the face
 * frame of a planar face, from its outward normal and a point on it. The command layer
 * evaluates the real frame from the IR; these give the sketcher the same frame to draw in (the
 * face-frame rule is tested against the SPEC's table).
 */
import type { P2 } from "./geom";

export type V3 = [number, number, number];

export interface Frame3 {
  origin: V3;
  /** Sketch u axis (unit). */
  x: V3;
  /** Sketch v axis (unit). */
  y: V3;
  /** Plane normal, `x × y` (unit). */
  normal: V3;
}

const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit3 = (a: V3): V3 => scale3(a, 1 / len3(a));

export type NamedPlane = "XY" | "XZ" | "YZ";

/** v0 §2: XY (x=+X, y=+Y), XZ (x=+X, y=+Z), YZ (x=+Y, y=+Z); normal = x × y. */
export function namedFrame(p: NamedPlane): Frame3 {
  const f = (x: V3, y: V3): Frame3 => ({ origin: [0, 0, 0], x, y, normal: cross3(x, y) });
  switch (p) {
    case "XY":
      return f([1, 0, 0], [0, 1, 0]);
    case "XZ":
      return f([1, 0, 0], [0, 0, 1]);
    case "YZ":
      return f([0, 1, 0], [0, 0, 1]);
  }
}

/**
 * The face frame of SPEC-v1 §3.1 for a planar face with outward unit normal `n` through
 * `pointOnFace`: origin = the world origin projected onto the plane; x = the world axis with the
 * smallest |n·axis| (ties X, Y, Z), projected and normalized; y = n × x.
 */
export function faceFrame(n: V3, pointOnFace: V3): Frame3 | null {
  const l = len3(n);
  if (!(l > 1e-12)) return null;
  const normal = scale3(n, 1 / l);
  const axes: V3[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let best = axes[0]!;
  let bestDot = Infinity;
  for (const a of axes) {
    const d = Math.abs(dot3(normal, a));
    if (d < bestDot - 1e-15) {
      bestDot = d;
      best = a;
    }
  }
  const proj = sub3(best, scale3(normal, dot3(best, normal)));
  if (len3(proj) <= 1e-9) return null;
  const x = unit3(proj);
  const y = cross3(normal, x);
  // The world origin projected onto the plane through `pointOnFace`.
  const h = dot3(pointOnFace, normal);
  const origin = scale3(normal, h);
  return { origin, x, y, normal };
}

/** Sketch (u, v) → world. */
export function toWorld(f: Frame3, p: P2): V3 {
  return add3(f.origin, add3(scale3(f.x, p[0]), scale3(f.y, p[1])));
}

/** World → sketch (u, v) and the signed distance from the plane. */
export function toPlane(f: Frame3, q: V3): { uv: P2; h: number } {
  const d = sub3(q, f.origin);
  return { uv: [dot3(d, f.x), dot3(d, f.y)], h: dot3(d, f.normal) };
}
