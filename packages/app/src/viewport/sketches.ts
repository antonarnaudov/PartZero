/**
 * Sketches in the viewport: every sketch feature's curves as 3D polylines on its plane, for the
 * overlay (drawn when "Sketches" is on, and always for the selected sketch) and for picking a
 * sketch with the sketch filter.
 *
 * Planes follow SPEC v0 §3: named frames `XY` = (+X, +Y, +Z), `XZ` = (+X, +Z, −Y),
 * `YZ` = (+Y, +Z, +X) as (x axis, y axis, normal), or an explicit frame
 * `{ origin, normal, x_dir }` with `y = normal × x_dir`. Planes this module cannot place (a face
 * or datum reference of a later IR) are skipped rather than drawn in the wrong place.
 */
import { add, cross, normalize, scale, type Vec3 } from "./view-camera";

export interface SketchPolyline {
  sketch: string;
  curve: string;
  points: Vec3[];
}

type V2 = [number, number];

interface CurveLike {
  kind?: unknown;
  id?: unknown;
  start?: unknown;
  end?: unknown;
  center?: unknown;
  radius?: unknown;
  ccw?: unknown;
}

interface FeatureLike {
  type?: unknown;
  name?: unknown;
  plane?: unknown;
  curves?: unknown;
  suppressed?: unknown;
}

interface Frame3 {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
}

const NAMED: Record<string, Frame3> = {
  XY: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] },
  XZ: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1] },
  YZ: { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1] },
};

const isV2 = (v: unknown): v is V2 => Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x));
const isV3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x));

export function sketchFrame(plane: unknown): Frame3 | null {
  if (typeof plane === "string") return NAMED[plane] ?? null;
  if (plane && typeof plane === "object") {
    const p = plane as { origin?: unknown; normal?: unknown; x_dir?: unknown };
    if (isV3(p.origin) && isV3(p.normal) && isV3(p.x_dir)) {
      const n = normalize(p.normal);
      const x = normalize(p.x_dir);
      return { origin: p.origin, x, y: cross(n, x) };
    }
  }
  return null;
}

/** Points of one curve in sketch coordinates (arcs and circles sampled every ≤ 7.5°). */
export function curvePoints2d(c: CurveLike): V2[] | null {
  if (c.kind === "line" && isV2(c.start) && isV2(c.end)) return [c.start, c.end];
  if (c.kind === "circle" && isV2(c.center) && typeof c.radius === "number" && c.radius > 0) {
    const out: V2[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = (i / 48) * 2 * Math.PI;
      out.push([c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)]);
    }
    return out;
  }
  if (c.kind === "arc" && isV2(c.start) && isV2(c.end) && isV2(c.center)) {
    const [cx, cy] = c.center;
    const r = Math.hypot(c.start[0] - cx, c.start[1] - cy);
    const a0 = Math.atan2(c.start[1] - cy, c.start[0] - cx);
    let a1 = Math.atan2(c.end[1] - cy, c.end[0] - cx);
    const ccw = c.ccw !== false;
    if (ccw && a1 <= a0) a1 += 2 * Math.PI;
    if (!ccw && a1 >= a0) a1 -= 2 * Math.PI;
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)));
    const out: V2[] = [];
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
    }
    return out;
  }
  return null;
}

/** Every sketch's curves as 3D polylines (suppressed sketches excluded). */
export function sketchPolylines(ir: unknown): SketchPolyline[] {
  const parts = (ir as { parts?: Array<{ features?: FeatureLike[] }> } | null | undefined)?.parts;
  const out: SketchPolyline[] = [];
  for (const part of parts ?? []) {
    for (const f of part.features ?? []) {
      if (f.type !== "sketch" || f.suppressed === true || typeof f.name !== "string" || !Array.isArray(f.curves)) continue;
      const frame = sketchFrame(f.plane);
      if (!frame) continue;
      for (const c of f.curves as CurveLike[]) {
        const pts = curvePoints2d(c);
        if (!pts) continue;
        out.push({
          sketch: f.name,
          curve: typeof c.id === "string" ? c.id : "",
          points: pts.map(([u, v]) => add(frame.origin, add(scale(frame.x, u), scale(frame.y, v)))),
        });
      }
    }
  }
  return out;
}
