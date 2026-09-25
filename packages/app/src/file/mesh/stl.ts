/**
 * STL reader (binary and ASCII). STL has no units: coordinates are taken as millimetres, as slicers do.
 * Binary is recognised by its exact size (84 + 50 × count), whatever its header says (many binary files start with
 * `solid`); anything else must be ASCII `solid … endsolid`.
 */
import { checkMesh, DEFAULT_MESH_LIMITS, MeshError, weld, type MeshLimits, type TriangleMesh } from "./mesh";

export function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
  return bytes.length === 84 + n * 50;
}

export function readStl(bytes: Uint8Array, limits: MeshLimits = DEFAULT_MESH_LIMITS): TriangleMesh {
  const mesh = isBinaryStl(bytes) ? readBinary(bytes, limits) : readAscii(bytes, limits);
  checkMesh(mesh, limits);
  return mesh;
}

function readBinary(bytes: Uint8Array, limits: MeshLimits): TriangleMesh {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(80, true);
  if (n === 0) throw new MeshError("MESH_EMPTY", "the STL file has no triangles");
  if (n > limits.maxTriangles) throw new MeshError("MESH_TOO_LARGE", `the STL has ${n.toLocaleString("en-US")} triangles (the limit is ${limits.maxTriangles.toLocaleString("en-US")})`);
  const corners = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50 + 12; // skip the facet normal: it is recomputed from the corners
    for (let k = 0; k < 9; k++) corners[t * 9 + k] = view.getFloat32(base + k * 4, true);
  }
  return weld(corners);
}

function readAscii(bytes: Uint8Array, limits: MeshLimits): TriangleMesh {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MeshError("MESH_MALFORMED", "this is neither a binary STL (its size does not match its triangle count) nor ASCII text");
  }
  if (!/^\s*solid\b/i.test(text)) throw new MeshError("MESH_MALFORMED", "not an STL file (a binary STL's size does not match its triangle count, and the text does not start with `solid`)");
  const coords: number[] = [];
  const re = /\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    for (let k = 1; k <= 3; k++) {
      const v = Number(m[k]);
      if (!Number.isFinite(v)) throw new MeshError("MESH_NOT_FINITE", `an STL vertex has a coordinate that is not a number: ${m[k]!.slice(0, 40)}`);
      coords.push(v);
    }
    if (coords.length / 9 > limits.maxTriangles) throw new MeshError("MESH_TOO_LARGE", `the STL has more than ${limits.maxTriangles.toLocaleString("en-US")} triangles`);
  }
  if (coords.length === 0) throw new MeshError("MESH_EMPTY", "the STL file has no triangles");
  if (coords.length % 9 !== 0) throw new MeshError("MESH_MALFORMED", "an STL facet does not have exactly three vertices");
  return weld(new Float32Array(coords));
}

/** A binary STL of `mesh` (tests and fixtures). */
export function writeBinaryStl(mesh: TriangleMesh): Uint8Array {
  const n = mesh.indices.length / 3;
  const out = new Uint8Array(84 + n * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, n, true);
  for (let t = 0; t < n; t++) {
    const base = 84 + t * 50 + 12;
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k]! * 3;
      for (let c = 0; c < 3; c++) view.setFloat32(base + (k * 3 + c) * 4, mesh.positions[v + c]!, true);
    }
  }
  return out;
}
