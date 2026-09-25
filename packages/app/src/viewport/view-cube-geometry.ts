/**
 * View cube geometry (pure): a unit cube whose six faces are each split into a 3 × 3 grid. The
 * centre cell of a face is that face's standard view; border cells are its edges and corners,
 * whose direction is the sum of the adjacent faces' normals (Fusion/Onshape behaviour). A cell's
 * direction points **out of** the cube: clicking it puts the eye on that side, looking back in.
 */
import { add, dot, scale, type Basis, type StandardView, type Vec3 } from "./view-camera";

export interface CubeFace {
  view: StandardView;
  label: string;
  normal: Vec3;
  /** In-plane axes seen from outside: `u` right, `v` up (u × v = normal). */
  u: Vec3;
  v: Vec3;
}

export const CUBE_FACES: readonly CubeFace[] = [
  { view: "front", label: "FRONT", normal: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { view: "back", label: "BACK", normal: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
  { view: "right", label: "RIGHT", normal: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { view: "left", label: "LEFT", normal: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
  { view: "top", label: "TOP", normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { view: "bottom", label: "BOTTOM", normal: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
];

/** Border width of the edge/corner cells, in face half-widths (the face spans −1…1). */
export const CUBE_BORDER = 0.36;

export interface CubeCell {
  face: CubeFace;
  /** −1, 0, 1 along u and v. */
  i: number;
  j: number;
  /** Outward direction of the cell (not normalized): normal + i·u + j·v. */
  dir: Vec3;
  /** Stable key of the direction (cells of one edge or corner on different faces share it). */
  key: string;
  /** Corner points in world space (on the cube surface). */
  corners: Vec3[];
  /** The standard view of a centre cell. */
  view: StandardView | null;
}

const RANGES: Record<number, [number, number]> = { [-1]: [-1, -1 + CUBE_BORDER], 0: [-1 + CUBE_BORDER, 1 - CUBE_BORDER], 1: [1 - CUBE_BORDER, 1] };

export function dirKey(d: Vec3): string {
  return d.map((x) => Math.round(x)).join(",");
}

export function cubeCells(): CubeCell[] {
  const out: CubeCell[] = [];
  for (const face of CUBE_FACES) {
    for (const j of [-1, 0, 1]) {
      for (const i of [-1, 0, 1]) {
        const [a0, a1] = RANGES[i]!;
        const [b0, b1] = RANGES[j]!;
        const pt = (a: number, b: number): Vec3 => add(face.normal, add(scale(face.u, a), scale(face.v, b)));
        const dir = add(face.normal, add(scale(face.u, i), scale(face.v, j)));
        out.push({ face, i, j, dir, key: dirKey(dir), corners: [pt(a0, b0), pt(a1, b0), pt(a1, b1), pt(a0, b1)], view: i === 0 && j === 0 ? face.view : null });
      }
    }
  }
  return out;
}

/** Screen image (y down) of a world vector under a rotation-only (orthographic) projection. */
export function imageOf(b: Basis, p: Vec3, s: number): [number, number] {
  return [dot(p, b.right) * s, -dot(p, b.up) * s];
}

/** Faces turned towards the viewer, farthest first (painter's order). */
export function visibleFaces(b: Basis): CubeFace[] {
  return CUBE_FACES.filter((f) => dot(f.normal, b.back) > 1e-6).sort((x, y) => dot(x.normal, b.back) - dot(y.normal, b.back));
}
