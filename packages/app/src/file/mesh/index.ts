/** Reference-mesh readers and measures (see mesh.ts). */
import { DEFAULT_MESH_LIMITS, MeshError, type MeshFormat, type MeshLimits, type TriangleMesh } from "./mesh";
import { readObj } from "./obj";
import { readStl } from "./stl";
import { readThreeMf } from "./threemf";

export * from "./mesh";
export { readObj } from "./obj";
export { isBinaryStl, readStl, writeBinaryStl } from "./stl";
export { readThreeMf } from "./threemf";

/** The mesh format of a file name, from its extension. */
export function meshFormatOf(path: string): MeshFormat | null {
  const m = /\.(stl|obj|3mf)$/i.exec(path);
  return m ? (m[1]!.toLowerCase() as MeshFormat) : null;
}

export function readMesh(bytes: Uint8Array, format: MeshFormat, limits: MeshLimits = DEFAULT_MESH_LIMITS): TriangleMesh {
  switch (format) {
    case "stl":
      return readStl(bytes, limits);
    case "obj":
      return readObj(bytes, limits);
    case "3mf":
      return readThreeMf(bytes, limits);
    default:
      throw new MeshError("MESH_UNSUPPORTED", `unsupported mesh format: ${String(format)}`);
  }
}
