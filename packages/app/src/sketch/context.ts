/**
 * The model around a sketch, for context: the display bodies' B-rep edges projected onto the
 * sketch plane. Edges lying in the plane (a face the sketch sits on) are drawn stronger and their
 * vertices are position-only snap targets (binding sketch curves to model edges is SPEC set C,
 * FM4).
 */
import type { RenderBody } from "../engine/types";
import { toPlane, type Frame3 } from "./frames";
import type { P2 } from "./geom";

export interface ContextGeometry {
  /** Edges behind or in front of the plane, projected. */
  lines: Array<[P2, P2]>;
  /** Edges in the plane. */
  onPlane: Array<[P2, P2]>;
  /** Vertices of the in-plane edges (snap targets). */
  points: P2[];
}

export const EMPTY_CONTEXT: ContextGeometry = { lines: [], onPlane: [], points: [] };

/** Project every edge polyline of `bodies` onto the plane of `frame` (capped at `maxSegments`). */
export function contextFromBodies(bodies: readonly RenderBody[], frame: Frame3, maxSegments = 20000): ContextGeometry {
  const out: ContextGeometry = { lines: [], onPlane: [], points: [] };
  const seen = new Set<string>();
  const key = (p: P2): string => `${p[0].toFixed(5)},${p[1].toFixed(5)}`;
  let n = 0;
  for (const b of bodies) {
    for (const e of b.edges) {
      const pts = e.points;
      let prev: { uv: P2; h: number } | null = null;
      let first: P2 | null = null;
      let last: P2 | null = null;
      let planar = true;
      const segs: Array<[P2, P2]> = [];
      for (let i = 0; i + 2 < pts.length; i += 3) {
        const q = toPlane(frame, [pts[i]!, pts[i + 1]!, pts[i + 2]!]);
        if (Math.abs(q.h) > 1e-4) planar = false;
        if (prev) segs.push([prev.uv, q.uv]);
        if (!first) first = q.uv;
        last = q.uv;
        prev = q;
      }
      if (n + segs.length > maxSegments) return out;
      n += segs.length;
      (planar ? out.onPlane : out.lines).push(...segs);
      if (planar) {
        for (const p of [first, last]) {
          if (p && !seen.has(key(p))) {
            seen.add(key(p));
            out.points.push(p);
          }
        }
      }
    }
  }
  return out;
}
