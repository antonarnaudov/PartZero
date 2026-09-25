/**
 * Wavefront OBJ reader: `v` and `f` records (polygons become triangle fans; `v/vt/vn` and negative indices are
 * accepted). Texture coordinates, normals, groups and materials are ignored. OBJ has no units: taken as millimetres.
 */
import { checkMesh, DEFAULT_MESH_LIMITS, MeshError, type MeshLimits, type TriangleMesh } from "./mesh";

export function readObj(bytes: Uint8Array, limits: MeshLimits = DEFAULT_MESH_LIMITS): TriangleMesh {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new MeshError("MESH_MALFORMED", "the OBJ file is not UTF-8 text");
  }
  const pos: number[] = [];
  const idx: number[] = [];
  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]!.trim();
    if (line.startsWith("v ") || line.startsWith("v\t")) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) throw new MeshError("MESH_MALFORMED", `line ${ln + 1}: a vertex needs three coordinates`);
      for (let k = 1; k <= 3; k++) {
        const v = Number(parts[k]);
        if (!Number.isFinite(v)) throw new MeshError("MESH_NOT_FINITE", `line ${ln + 1}: ${parts[k]!.slice(0, 40)} is not a number`);
        pos.push(v);
      }
    } else if (line.startsWith("f ") || line.startsWith("f\t")) {
      const parts = line.split(/\s+/).slice(1);
      if (parts.length < 3) throw new MeshError("MESH_MALFORMED", `line ${ln + 1}: a face needs at least three vertices`);
      const nv = pos.length / 3;
      const face = parts.map((p) => {
        const i = Number.parseInt(p.split("/")[0]!, 10);
        if (!Number.isInteger(i) || i === 0) throw new MeshError("MESH_MALFORMED", `line ${ln + 1}: bad vertex index ${p.slice(0, 40)}`);
        const r = i > 0 ? i - 1 : nv + i;
        if (r < 0 || r >= nv) throw new MeshError("MESH_MALFORMED", `line ${ln + 1}: vertex index ${i} does not exist yet`);
        return r;
      });
      for (let k = 1; k + 1 < face.length; k++) idx.push(face[0]!, face[k]!, face[k + 1]!);
      if (idx.length / 3 > limits.maxTriangles) throw new MeshError("MESH_TOO_LARGE", `the OBJ has more than ${limits.maxTriangles.toLocaleString("en-US")} triangles`);
    }
  }
  if (idx.length === 0) throw new MeshError("MESH_EMPTY", "the OBJ file has no faces");
  const mesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  checkMesh(mesh, limits);
  return mesh;
}
