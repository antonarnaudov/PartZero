/**
 * CPU ray casting against the displayed triangles: the nearest face along a ray. The GPU pick is
 * the primary picker (pixel-exact, snaps to edges); this answers the questions it cannot, e.g. "the
 * face under the cursor" when the GPU pick snapped to an edge that the selection filter excludes.
 */
import type { Vec3 } from "../viewport/view-camera";
import type { BodyInfo, SceneTopology } from "./topology";

export interface RayHit {
  body: string;
  face: string;
  point: Vec3;
  /** Distance along the ray. */
  t: number;
}

/** Slab test: does the ray meet the box (with a small margin)? Returns the entry distance. */
function rayBox(o: Vec3, d: Vec3, min: Vec3, max: Vec3): number | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (let k = 0; k < 3; k++) {
    const pad = (max[k]! - min[k]!) * 1e-6 + 1e-9;
    const lo = min[k]! - pad;
    const hi = max[k]! + pad;
    if (Math.abs(d[k]!) < 1e-15) {
      if (o[k]! < lo || o[k]! > hi) return null;
      continue;
    }
    let a = (lo - o[k]!) / d[k]!;
    let b = (hi - o[k]!) / d[k]!;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return null;
  }
  return t1 < 0 ? null : t0;
}

/** Möller–Trumbore (both sides); the distance or null. */
export function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-18) return null;
  const inv = 1 / det;
  const tx = o[0] - a[0], ty = o[1] - a[1], tz = o[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : null;
}

function castBody(body: BodyInfo, o: Vec3, d: Vec3, best: RayHit | null): RayHit | null {
  const { positions, indices } = body.body;
  const at = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  let out = best;
  for (const f of body.faces.values()) {
    for (const r of f.ranges) {
      for (let tri = r.start; tri < r.start + r.count; tri++) {
        const i0 = indices[tri * 3];
        const i1 = indices[tri * 3 + 1];
        const i2 = indices[tri * 3 + 2];
        if (i0 === undefined || i1 === undefined || i2 === undefined) continue;
        const t = rayTriangle(o, d, at(i0), at(i1), at(i2));
        if (t !== null && (!out || t < out.t)) {
          out = { body: body.name, face: f.name, t, point: [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t] };
        }
      }
    }
  }
  return out;
}

/** The nearest face hit by the ray (origin `o`, unit direction `d`), skipping `hidden` bodies. */
export function raycast(topo: SceneTopology, o: Vec3, d: Vec3, hidden?: ReadonlySet<string>): RayHit | null {
  const order: Array<{ body: BodyInfo; t: number }> = [];
  for (const b of topo.bodies.values()) {
    if (hidden?.has(b.name) || !b.bbox) continue;
    const t = rayBox(o, d, b.bbox.min, b.bbox.max);
    if (t !== null) order.push({ body: b, t });
  }
  order.sort((a, b) => a.t - b.t);
  let best: RayHit | null = null;
  for (const { body, t } of order) {
    if (best && t > best.t) break;
    best = castBody(body, o, d, best);
  }
  return best;
}
