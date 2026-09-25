/**
 * Triangle meshes imported as **reference bodies** (FULL-MODELING-PLAN §1.3 "STL/3MF/OBJ import as a reference mesh"):
 * displayed and measured, never edited, never part of the IR or a boolean.
 *
 * Readers (stl.ts, obj.ts, threemf.ts) produce a {@link TriangleMesh}. {@link measureMesh} computes what the Reference
 * panel shows: bounding box, surface area, and the enclosed volume when the mesh is closed and consistently oriented
 * (never a volume for an open mesh: a wrong number is worse than none). {@link meshToRenderBody} turns it into a
 * display body for either viewport.
 */
import type { RenderBody } from "../../engine/types";

export type MeshFormat = "stl" | "obj" | "3mf";

export interface TriangleMesh {
  /** Vertex positions, xyz interleaved, in mm. */
  positions: Float32Array;
  /** Three vertex indices per triangle. */
  indices: Uint32Array;
}

export type MeshErrorCode = "MESH_EMPTY" | "MESH_MALFORMED" | "MESH_TOO_LARGE" | "MESH_UNSUPPORTED" | "MESH_NOT_FINITE";

export class MeshError extends Error {
  readonly code: MeshErrorCode;
  constructor(code: MeshErrorCode, message: string) {
    super(message);
    this.name = "MeshError";
    this.code = code;
  }
}

export interface MeshLimits {
  /** Most triangles accepted (default 10 million). */
  maxTriangles: number;
}

export const DEFAULT_MESH_LIMITS: MeshLimits = { maxTriangles: 10_000_000 };

export interface MeshMeasure {
  triangles: number;
  vertices: number;
  bbox: { min: [number, number, number]; max: [number, number, number] } | null;
  /** Bounding-box size, mm. */
  size: [number, number, number];
  /** Surface area, mm². */
  area: number;
  /** Enclosed volume, mm³: only for a closed, consistently oriented mesh (null otherwise). */
  volume: number | null;
  /** Every edge is shared by exactly two triangles. */
  closed: boolean;
  /** No edge is used twice in the same direction (the triangles agree on inside and outside). */
  oriented: boolean;
  /** Triangles with (near) zero area. */
  degenerate: number;
}

/**
 * Weld exactly equal vertex positions (bitwise, so the result is deterministic) and build an indexed mesh from
 * unindexed triangle corners (`corners`: 9 floats per triangle).
 */
export function weld(corners: Float32Array): TriangleMesh {
  const count = corners.length / 3;
  const map = new Map<string, number>();
  const bits = new Uint32Array(corners.buffer, corners.byteOffset, corners.length);
  const positions: number[] = [];
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const key = `${bits[i * 3]},${bits[i * 3 + 1]},${bits[i * 3 + 2]}`;
    let v = map.get(key);
    if (v === undefined) {
      v = positions.length / 3;
      map.set(key, v);
      positions.push(corners[i * 3]!, corners[i * 3 + 1]!, corners[i * 3 + 2]!);
    }
    indices[i] = v;
  }
  return { positions: new Float32Array(positions), indices };
}

/** Throw unless every coordinate is finite and every index is in range. */
export function checkMesh(mesh: TriangleMesh, limits: MeshLimits = DEFAULT_MESH_LIMITS): void {
  const tris = mesh.indices.length / 3;
  if (!Number.isInteger(tris)) throw new MeshError("MESH_MALFORMED", "the index count is not a multiple of 3");
  if (tris === 0) throw new MeshError("MESH_EMPTY", "the file has no triangles");
  if (tris > limits.maxTriangles) throw new MeshError("MESH_TOO_LARGE", `the mesh has ${tris.toLocaleString("en-US")} triangles (the limit is ${limits.maxTriangles.toLocaleString("en-US")})`);
  for (let i = 0; i < mesh.positions.length; i++) {
    if (!Number.isFinite(mesh.positions[i]!)) throw new MeshError("MESH_NOT_FINITE", "the mesh has a coordinate that is not a finite number");
  }
  const nv = mesh.positions.length / 3;
  for (let i = 0; i < mesh.indices.length; i++) if (mesh.indices[i]! >= nv) throw new MeshError("MESH_MALFORMED", `triangle ${Math.floor(i / 3)} refers to a vertex that does not exist`);
}

/** Measure a mesh (float64 accumulation; see {@link MeshMeasure}). */
export function measureMesh(mesh: TriangleMesh): MeshMeasure {
  const p = mesh.positions;
  const idx = mesh.indices;
  const tris = idx.length / 3;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]! * 3;
    for (let k = 0; k < 3; k++) {
      const c = p[v + k]!;
      if (c < min[k]!) min[k] = c;
      if (c > max[k]!) max[k] = c;
    }
  }
  let area = 0;
  let vol6 = 0;
  let degenerate = 0;
  // Directed edge (a → b) counts, keyed a * nv + b (exact for meshes below ~94 million vertices).
  const nv = p.length / 3;
  const directed = new Map<number, number>();
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3]!;
    const b = idx[t * 3 + 1]!;
    const c = idx[t * 3 + 2]!;
    const ax = p[a * 3]!, ay = p[a * 3 + 1]!, az = p[a * 3 + 2]!;
    const bx = p[b * 3]!, by = p[b * 3 + 1]!, bz = p[b * 3 + 2]!;
    const cx = p[c * 3]!, cy = p[c * 3 + 1]!, cz = p[c * 3 + 2]!;
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const a2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
    area += a2 / 2;
    // Degenerate: the doubled area is tiny compared with the squared longest edge (scale-free test).
    const l2 = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2);
    if (a === b || b === c || a === c || a2 <= 1e-12 * l2) degenerate++;
    vol6 += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
    for (const [s, e] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const key = s * nv + e;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let closed = tris > 0;
  let oriented = true;
  for (const [key, n] of directed) {
    if (n > 1) oriented = false;
    const s = Math.floor(key / nv);
    const e = key - s * nv;
    const back = directed.get(e * nv + s) ?? 0;
    // Undirected use count: this direction plus the reverse one.
    if (n + back !== 2) closed = false;
  }
  const hasBox = tris > 0;
  return {
    triangles: tris,
    vertices: nv,
    bbox: hasBox ? { min, max } : null,
    size: hasBox ? [max[0] - min[0], max[1] - min[1], max[2] - min[2]] : [0, 0, 0],
    area,
    volume: closed && oriented ? Math.abs(vol6) / 6 : null,
    closed,
    oriented,
    degenerate,
  };
}

/** A display body: flat-shaded, one face range, no edges. The name is `ref:<id>`. */
export function meshToRenderBody(mesh: TriangleMesh, name: string, color?: [number, number, number]): RenderBody {
  const tris = mesh.indices.length / 3;
  const positions = new Float32Array(tris * 9);
  const normals = new Float32Array(tris * 9);
  const indices = new Uint32Array(tris * 3);
  const p = mesh.positions;
  for (let t = 0; t < tris; t++) {
    const c0 = mesh.indices[t * 3]! * 3;
    const c1 = mesh.indices[t * 3 + 1]! * 3;
    const c2 = mesh.indices[t * 3 + 2]! * 3;
    const ux = p[c1]! - p[c0]!, uy = p[c1 + 1]! - p[c0 + 1]!, uz = p[c1 + 2]! - p[c0 + 2]!;
    const vx = p[c2]! - p[c0]!, vy = p[c2 + 1]! - p[c0 + 1]!, vz = p[c2 + 2]! - p[c0 + 2]!;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 0) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    for (let k = 0; k < 3; k++) {
      const src = [c0, c1, c2][k]!;
      const dst = t * 9 + k * 3;
      positions[dst] = p[src]!;
      positions[dst + 1] = p[src + 1]!;
      positions[dst + 2] = p[src + 2]!;
      normals[dst] = nx;
      normals[dst + 1] = ny;
      normals[dst + 2] = nz;
      indices[t * 3 + k] = t * 3 + k;
    }
  }
  return {
    name,
    positions,
    normals,
    indices,
    faceRanges: [{ face: name, start: 0, count: tris }],
    edges: [],
    ...(color ? { color } : {}),
  };
}

/** Apply a uniform scale (unit conversion) in place and return the mesh. */
export function scaleMesh(mesh: TriangleMesh, scale: number): TriangleMesh {
  if (scale !== 1) for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] = mesh.positions[i]! * scale;
  return mesh;
}
