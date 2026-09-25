/**
 * From a cursor position to the selectable item under it, honouring the kind filter:
 *
 * 1. **Vertex** (new): the nearest B-rep vertex within {@link VERTEX_RADIUS_PX} of the cursor that
 *    is visible. Visibility is proven by the GPU pick: the entity under the cursor is incident to
 *    the vertex, or a pick at the vertex's own pixel lands on it (or on nothing: an outline corner).
 * 2. **Edge**: the GPU pick's edge (forge-render snaps to edges within its pick radius).
 * 3. **Face**, or its **body** with the body filter: the face under the cursor. When the GPU pick
 *    returned an edge that the filter excludes, the face under the cursor comes from a CPU ray cast.
 *
 * Everything here is deterministic given the pick results, so it is unit-tested with a fake picker.
 */
import type { CameraFrame, Vec3 } from "../viewport/view-camera";
import { raycast } from "./raycast";
import type { SceneTopology, VertexInfo } from "./topology";
import type { EntityItem, KindMask, SelectionItem } from "./types";

/** What the renderer reports under a pixel (forge-web's pick, or the placeholder's). */
export interface RawHit {
  kind: "face" | "edge" | "section";
  body: string;
  face?: string | null;
  edge?: string | null;
  point?: Vec3 | null;
}

export type GpuPick = (x: number, y: number) => Promise<RawHit | null>;

export interface PickContext {
  pick: GpuPick;
  frame: CameraFrame;
  topo: SceneTopology;
  filter: KindMask;
  /** Bodies not drawn (hidden in the browser). */
  hidden?: ReadonlySet<string>;
  /** Section plane (the side the normal points to is removed): its hits are ignored by the ray cast. */
  clip?: { normal: Vec3; offset: number } | null;
}

/** Screen distance (CSS px) within which a vertex wins over the face or edge under the cursor. */
export const VERTEX_RADIUS_PX = 8;

/** The face names inside `…/edge:{A|B}` (top-level `|` only; keys may nest braces). */
export function facesOfEdgeName(edge: string): string[] {
  const i = edge.indexOf("edge:{");
  if (i < 0) return [];
  const out: string[] = [];
  let depth = 0;
  let start = i + 6;
  for (let k = start; k < edge.length; k++) {
    const ch = edge[k];
    if (ch === "{") depth++;
    else if (ch === "}") {
      if (depth === 0) {
        out.push(edge.slice(start, k));
        break;
      }
      depth--;
    } else if (ch === "|" && depth === 0) {
      out.push(edge.slice(start, k));
      start = k + 1;
    }
  }
  return out.filter((s) => s.length > 0);
}

/** Faces around a vertex, from the names of its edges. */
export function facesOfVertex(v: VertexInfo): Set<string> {
  const s = new Set<string>();
  for (const e of v.edges) for (const f of facesOfEdgeName(e)) s.add(f);
  return s;
}

function incident(v: VertexInfo, hit: RawHit | null): boolean {
  if (!hit) return false;
  if (hit.edge && v.edges.includes(hit.edge)) return true;
  if (hit.face && facesOfVertex(v).has(hit.face)) return true;
  return false;
}

/** Vertices near the cursor, nearest first (screen distance), with their projections. */
export function nearbyVertices(ctx: Pick<PickContext, "frame" | "topo" | "hidden">, x: number, y: number, radius = VERTEX_RADIUS_PX): Array<{ body: string; vertex: VertexInfo; d: number; sx: number; sy: number }> {
  const out: Array<{ body: string; vertex: VertexInfo; d: number; sx: number; sy: number }> = [];
  for (const { body, vertex } of ctx.topo.allVertices) {
    if (ctx.hidden?.has(body)) continue;
    const p = ctx.frame.project(vertex.point);
    if (!p) continue;
    const d = Math.hypot(p.x - x, p.y - y);
    if (d <= radius) out.push({ body, vertex, d, sx: p.x, sy: p.y });
  }
  out.sort((a, b) => a.d - b.d || a.vertex.key.localeCompare(b.vertex.key));
  return out;
}

async function visibleVertex(ctx: PickContext, hit: RawHit | null, x: number, y: number): Promise<EntityItem | null> {
  const candidates = nearbyVertices(ctx, x, y).slice(0, 3);
  for (const c of candidates) {
    if (hit && hit.body === c.body && incident(c.vertex, hit)) return { kind: "vertex", body: c.body, key: c.vertex.key, point: c.vertex.point };
    const at = await ctx.pick(c.sx, c.sy);
    if (!at) return { kind: "vertex", body: c.body, key: c.vertex.key, point: c.vertex.point };
    if (at.body === c.body && incident(c.vertex, at)) return { kind: "vertex", body: c.body, key: c.vertex.key, point: c.vertex.point };
    if (at.point) {
      const tol = ctx.frame.pixelSizeAt(c.vertex.point) * 3;
      const [a, b] = [at.point, c.vertex.point];
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol) return { kind: "vertex", body: c.body, key: c.vertex.key, point: c.vertex.point };
    }
  }
  return null;
}

function faceUnderCursor(ctx: PickContext, x: number, y: number): { body: string; face: string; point: Vec3 } | null {
  const { origin, dir } = ctx.frame.ray(x, y);
  const hit = raycast(ctx.topo, origin, dir, ctx.hidden);
  if (!hit) return null;
  if (ctx.clip) {
    const [n, k] = [ctx.clip.normal, ctx.clip.offset];
    if (n[0] * hit.point[0] + n[1] * hit.point[1] + n[2] * hit.point[2] - k > 0) return null;
  }
  return hit;
}

/** The item a click at `(x, y)` would select (also the hover pre-highlight). */
export async function pickItem(ctx: PickContext, x: number, y: number): Promise<SelectionItem | null> {
  const f = ctx.filter;
  const raw = await ctx.pick(x, y);
  const hit = raw && ctx.hidden?.has(raw.body) ? null : raw;
  if (f.vertex) {
    const v = await visibleVertex(ctx, hit, x, y);
    if (v) return v;
  }
  if (!hit || hit.kind === "section") {
    if (hit?.kind === "section" && f.body) return { kind: "body", body: hit.body };
    return null;
  }
  const point = hit.point ?? undefined;
  if (hit.kind === "edge" && hit.edge) {
    if (f.edge) return { kind: "edge", body: hit.body, key: hit.edge, ...(point ? { point } : {}) };
    // The GPU snapped to an edge the filter excludes: take the face under the cursor instead.
    const under = f.face || f.body ? faceUnderCursor(ctx, x, y) : null;
    if (!under) return null;
    if (f.face) return { kind: "face", body: under.body, key: under.face, point: under.point };
    return { kind: "body", body: under.body };
  }
  if (hit.kind === "face" && hit.face) {
    if (f.face) return { kind: "face", body: hit.body, key: hit.face, ...(point ? { point } : {}) };
    if (f.body) return { kind: "body", body: hit.body };
  }
  return null;
}
