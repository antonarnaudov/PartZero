/**
 * A read-only index of the displayed scene's topology, built from the render bodies: faces
 * (triangle ranges), edges (exact polylines) and **vertices**, which the render mesh does not list:
 * a B-rep vertex is where edges end, so vertices are the de-duplicated end points of open edge
 * polylines (a closed edge — a full circle — has none; Forge's topology is seam-free). The
 * tessellator places polyline end points exactly on the B-rep vertices (f32), so incident edges
 * share bit-identical end points; a tiny tolerance merges any float noise.
 */
import type { RenderBody } from "../engine/types";
import type { Vec3 } from "../viewport/view-camera";

export interface FaceInfo {
  name: string;
  /** Triangle ranges of the face (a face may be split over several ranges). */
  ranges: Array<{ start: number; count: number }>;
}

export interface EdgeInfo {
  name: string;
  points: Float32Array;
  closed: boolean;
}

export interface VertexInfo {
  /** Derived key `vertex:{e1|e2|…}` (incident edge names, sorted, de-duplicated). */
  key: string;
  point: Vec3;
  edges: string[];
}

export interface BodyInfo {
  name: string;
  body: RenderBody;
  faces: Map<string, FaceInfo>;
  edges: Map<string, EdgeInfo>;
  vertices: Map<string, VertexInfo>;
  bbox: { min: Vec3; max: Vec3 } | null;
}

export interface SceneTopology {
  bodies: Map<string, BodyInfo>;
  /** Every vertex of every body (for snapping and vertex picking). */
  allVertices: Array<{ body: string; vertex: VertexInfo }>;
  bbox: { min: Vec3; max: Vec3 } | null;
}

/** Points closer than this (relative to the body size) are the same vertex. */
const VERTEX_MERGE_REL = 1e-7;

function pointAt(a: Float32Array, i: number): Vec3 {
  return [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
}

function bboxOf(positions: Float32Array): { min: Vec3; max: Vec3 } | null {
  if (positions.length < 3) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }
  return min[0] <= max[0] ? { min, max } : null;
}

function mergeBox(a: { min: Vec3; max: Vec3 } | null, b: { min: Vec3; max: Vec3 } | null): { min: Vec3 ; max: Vec3 } | null {
  if (!a) return b ? { min: [...b.min], max: [...b.max] } : null;
  if (!b) return a;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Derived vertex key from incident edge names (sorted, as forge-core renders `vertex:{…}`). */
export function vertexKey(edges: readonly string[]): string {
  return `vertex:{${[...new Set(edges)].sort().join("|")}}`;
}

export function indexBody(body: RenderBody): BodyInfo {
  const faces = new Map<string, FaceInfo>();
  for (const r of body.faceRanges) {
    let f = faces.get(r.face);
    if (!f) {
      f = { name: r.face, ranges: [] };
      faces.set(r.face, f);
    }
    f.ranges.push({ start: r.start, count: r.count });
  }
  const bbox = bboxOf(body.positions);
  const size = bbox ? Math.hypot(bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]) : 1;
  const tol = Math.max(1e-9, size * VERTEX_MERGE_REL);
  const edges = new Map<string, EdgeInfo>();
  // Vertex clustering: a grid hash at the merge tolerance, deterministic (edges in input order).
  const clusters: Array<{ point: Vec3; edges: string[] }> = [];
  const grid = new Map<string, number[]>();
  const cell = (v: number): number => Math.floor(v / (tol * 4));
  const addEnd = (p: Vec3, edge: string): void => {
    const cx = cell(p[0]);
    const cy = cell(p[1]);
    const cz = cell(p[2]);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          for (const ci of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            const c = clusters[ci]!;
            if (Math.abs(c.point[0] - p[0]) <= tol && Math.abs(c.point[1] - p[1]) <= tol && Math.abs(c.point[2] - p[2]) <= tol) {
              c.edges.push(edge);
              return;
            }
          }
        }
    const k = `${cx},${cy},${cz}`;
    const list = grid.get(k) ?? [];
    list.push(clusters.length);
    grid.set(k, list);
    clusters.push({ point: p, edges: [edge] });
  };
  for (const e of body.edges) {
    const n = Math.floor(e.points.length / 3);
    if (n === 0) continue;
    const first = pointAt(e.points, 0);
    const last = pointAt(e.points, n - 1);
    const closed = n > 2 && first[0] === last[0] && first[1] === last[1] && first[2] === last[2];
    edges.set(e.edge, { name: e.edge, points: e.points, closed });
    if (closed) continue;
    addEnd(first, e.edge);
    if (n > 1) addEnd(last, e.edge);
  }
  const vertices = new Map<string, VertexInfo>();
  for (const c of clusters) {
    let key = vertexKey(c.edges);
    // Two distinct vertices bounded by the same edges (e.g. both ends of one edge that is the only
    // edge at each end): keep them apart by position order.
    if (vertices.has(key)) {
      let i = 1;
      while (vertices.has(`${key}@${i}`)) i++;
      key = `${key}@${i}`;
    }
    vertices.set(key, { key, point: c.point, edges: [...new Set(c.edges)].sort() });
  }
  return { name: body.name, body, faces, edges, vertices, bbox };
}

export function buildTopology(bodies: readonly RenderBody[]): SceneTopology {
  const map = new Map<string, BodyInfo>();
  const allVertices: SceneTopology["allVertices"] = [];
  let bbox: { min: Vec3; max: Vec3 } | null = null;
  for (const b of bodies) {
    if (map.has(b.name)) continue;
    const info = indexBody(b);
    map.set(b.name, info);
    bbox = mergeBox(bbox, info.bbox);
    for (const v of info.vertices.values()) allVertices.push({ body: b.name, vertex: v });
  }
  return { bodies: map, allVertices, bbox };
}

/** Triangle vertex positions of a face, as a flat list of 3 points per triangle. */
export function faceTriangles(body: BodyInfo, face: string): Vec3[][] {
  const f = body.faces.get(face);
  if (!f) return [];
  const { positions, indices } = body.body;
  const out: Vec3[][] = [];
  for (const r of f.ranges) {
    for (let t = r.start; t < r.start + r.count; t++) {
      if (t * 3 + 2 >= indices.length) break;
      out.push([pointAt(positions, indices[t * 3]!), pointAt(positions, indices[t * 3 + 1]!), pointAt(positions, indices[t * 3 + 2]!)]);
    }
  }
  return out;
}

/** The distinct vertex indices used by a face's triangles. */
export function faceVertexIndices(body: BodyInfo, face: string): number[] {
  const f = body.faces.get(face);
  if (!f) return [];
  const { indices } = body.body;
  const seen = new Set<number>();
  for (const r of f.ranges) {
    for (let t = r.start; t < r.start + r.count; t++) {
      for (let k = 0; k < 3; k++) {
        const i = indices[t * 3 + k];
        if (i !== undefined) seen.add(i);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function edgePoints(e: EdgeInfo): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i + 2 < e.points.length; i += 3) out.push([e.points[i]!, e.points[i + 1]!, e.points[i + 2]!]);
  return out;
}

/** Whether `name` still exists in the scene (for re-resolution). */
export function hasEntity(topo: SceneTopology, kind: "face" | "edge" | "vertex" | "body", body: string, key?: string): boolean {
  const b = topo.bodies.get(body);
  if (!b) return false;
  if (kind === "body") return true;
  if (!key) return false;
  if (kind === "face") return b.faces.has(key);
  if (kind === "edge") return b.edges.has(key);
  return b.vertices.has(key);
}
