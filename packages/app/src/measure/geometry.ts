/**
 * Exact geometry of displayed entities, recovered from the render mesh where the mesh carries it
 * exactly, flagged approximate where it does not.
 *
 * Forge's render mesh is not an arbitrary triangle soup: tessellation vertices lie **on** the
 * exact B-rep (edge polylines on the exact curves, face vertices on the exact surfaces) and each
 * vertex carries the **exact surface normal**. So:
 * - a vertex position is exact (f32);
 * - a straight edge's end points are exact, and a circular edge's points all lie on the exact
 *   circle, so its centre, normal and radius are recovered exactly (to f32);
 * - a planar face has one exact normal, and its area is exact once the chord segments along its
 *   circular boundary edges are corrected by their exact circular-segment areas;
 * - a cylindrical face's axis and radius follow exactly from positions + exact normals.
 * Anything else (a freeform surface, a non-circular curve) is measured on the mesh and marked
 * `exact: false` (shown with "≈"). Body volume and area come from the evaluation report, which
 * Forge computes on the exact geometry.
 */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../viewport/view-camera";
import { facesOfEdgeName } from "../selection/picking";
import { edgePoints, faceTriangles, faceVertexIndices, type BodyInfo, type EdgeInfo } from "../selection/topology";

/** Relative tolerance for "these f32 values describe the same exact geometry". */
export const GEOM_REL_TOL = 2e-5;

export type EdgeGeom =
  | { type: "line"; p0: Vec3; p1: Vec3; dir: Vec3; length: number; exact: true }
  | { type: "circle"; center: Vec3; normal: Vec3; radius: number; closed: boolean; sweep: number; length: number; p0: Vec3; p1: Vec3; exact: true }
  | { type: "curve"; points: Vec3[]; length: number; exact: false };

export type FaceGeom =
  | { type: "plane"; normal: Vec3; point: Vec3; area: number; exact: boolean; centroid: Vec3 }
  | { type: "cylinder"; axis: Vec3; point: Vec3; radius: number; area: number; exact: boolean; centroid: Vec3; inner: boolean }
  | { type: "surface"; area: number; exact: false; centroid: Vec3 };

function pt(a: Float32Array, i: number): Vec3 {
  return [a[i * 3]!, a[i * 3 + 1]!, a[i * 3 + 2]!];
}

function polylineLength(p: Vec3[]): number {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += length(sub(p[i]!, p[i - 1]!));
  return s;
}

function scaleOf(points: Vec3[]): number {
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  return Math.max(1e-6, length(sub(hi, lo)));
}

/** Circumcentre of three points (null when collinear). */
export function circumcenter(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; normal: Vec3; radius: number } | null {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-24) return null;
  const t = add(scale(cross(n, ab), dot(ac, ac)), scale(cross(ac, n), dot(ab, ab)));
  const off = scale(t, 1 / (2 * n2));
  return { center: add(a, off), normal: normalize(n), radius: length(off) };
}

/** Classify an edge polyline as a line, a circle (arc) or a general curve. */
export function edgeGeom(e: EdgeInfo): EdgeGeom {
  const p = edgePoints(e);
  const len = polylineLength(p);
  if (p.length < 2) return { type: "curve", points: p, length: 0, exact: false };
  const s = scaleOf(p);
  const tol = s * GEOM_REL_TOL + 1e-7;
  const p0 = p[0]!;
  const p1 = p[p.length - 1]!;
  if (!e.closed) {
    const dir = normalize(sub(p1, p0));
    const straight = p.every((q) => length(cross(sub(q, p0), dir)) <= tol);
    if (straight && length(sub(p1, p0)) > 0) return { type: "line", p0, p1, dir, length: length(sub(p1, p0)), exact: true };
  }
  if (p.length >= 3) {
    // Three well-spread points (a closed polyline repeats its first point at the end).
    const n = e.closed ? p.length - 1 : p.length;
    const a = p[0]!;
    const b = p[Math.floor(n / 3)]!;
    const c = p[Math.floor((2 * n) / 3)]!;
    const cc = circumcenter(a, b, c);
    if (cc && cc.radius > tol) {
      const onCircle = p.every((q) => Math.abs(length(sub(q, cc.center)) - cc.radius) <= tol && Math.abs(dot(sub(q, cc.center), cc.normal)) <= tol);
      if (onCircle) {
        let sweep = 2 * Math.PI;
        if (!e.closed) {
          // Signed angles along the polyline (consistent orientation around the normal).
          let total = 0;
          for (let i = 1; i < p.length; i++) {
            const u = sub(p[i - 1]!, cc.center);
            const v = sub(p[i]!, cc.center);
            total += Math.atan2(dot(cross(u, v), cc.normal), dot(u, v));
          }
          sweep = Math.abs(total);
        }
        return { type: "circle", center: cc.center, normal: cc.normal, radius: cc.radius, closed: e.closed, sweep, length: cc.radius * sweep, p0, p1, exact: true };
      }
    }
  }
  return { type: "curve", points: p, length: len, exact: false };
}

function triArea(a: Vec3, b: Vec3, c: Vec3): number {
  return length(cross(sub(b, a), sub(c, a))) / 2;
}

/** Point-in-triangle in a plane (barycentric, with a tolerance). */
function inTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3, n: Vec3): boolean {
  const s = (u: Vec3, v: Vec3, w: Vec3): number => dot(cross(sub(v, u), sub(w, u)), n);
  const d = s(a, b, c);
  if (Math.abs(d) < 1e-18) return false;
  const l1 = s(p, b, c) / d;
  const l2 = s(a, p, c) / d;
  const l3 = s(a, b, p) / d;
  return l1 >= -1e-9 && l2 >= -1e-9 && l3 >= -1e-9;
}

/** The boundary edges of a face: edges whose provenance name mentions the face (`edge:{A|B}`). */
export function boundaryEdges(body: BodyInfo, face: string): EdgeInfo[] {
  const out: EdgeInfo[] = [];
  for (const e of body.edges.values()) if (facesOfEdgeName(e.name).includes(face)) out.push(e);
  return out;
}

/**
 * Classify a face: plane, cylinder (exact) or a general surface (mesh area).
 *
 * Recognition uses **positions** (which lie exactly on the surface) and the face's boundary
 * curves, not the vertex normals: the Forge CLI path reads meshes from OBJ, whose normals are
 * averaged across faces. Orientation (outward) comes from the triangle winding (CCW from outside).
 */
export function faceGeom(body: BodyInfo, face: string): FaceGeom | null {
  const tris = faceTriangles(body, face);
  if (tris.length === 0) return null;
  const idx = faceVertexIndices(body, face);
  const P = body.body.positions;
  const pts = idx.map((i) => pt(P, i));
  let meshArea = 0;
  let cx: Vec3 = [0, 0, 0];
  let nsum: Vec3 = [0, 0, 0];
  for (const [a, b, c] of tris) {
    const n2 = cross(sub(b!, a!), sub(c!, a!));
    const ar = length(n2) / 2;
    meshArea += ar;
    nsum = add(nsum, n2);
    cx = add(cx, scale(add(add(a!, b!), c!), ar / 3));
  }
  const centroid = meshArea > 0 ? scale(cx, 1 / meshArea) : pts[0]!;
  const s = scaleOf(pts);
  const tol = s * GEOM_REL_TOL + 1e-7;

  // Plane: every vertex on the plane of the (area-weighted, outward) facet normal.
  const n0 = normalize(nsum);
  if (length(n0) > 0) {
    const point = pts[0]!;
    if (pts.every((q) => Math.abs(dot(sub(q, point), n0)) <= tol)) {
      const { area, exact } = planarExactArea(body, face, tris, n0, meshArea);
      return { type: "plane", normal: n0, point, area, exact, centroid };
    }
  }

  // Cylinder: coaxial circular boundary curves of one radius, every vertex at that radius.
  const circles = boundaryEdges(body, face)
    .map(edgeGeom)
    .filter((g): g is Extract<EdgeGeom, { type: "circle" }> => g.type === "circle");
  if (circles.length > 0) {
    const c0 = circles[0]!;
    const axis = c0.normal;
    const radial = (q: Vec3): Vec3 => {
      const v = sub(q, c0.center);
      return sub(v, scale(axis, dot(v, axis)));
    };
    const coaxial = circles.every((c) => length(cross(c.normal, axis)) <= 1e-5 && length(radial(c.center)) <= tol * 4 && Math.abs(c.radius - c0.radius) <= tol * 4);
    const onCylinder = coaxial && pts.every((q) => Math.abs(length(radial(q)) - c0.radius) <= tol * 4);
    if (onCylinder) {
      const radius = c0.radius;
      const hs = pts.map((q) => dot(sub(q, c0.center), axis));
      const h0 = Math.min(...hs);
      const h1 = Math.max(...hs);
      const twoHeights = hs.every((h) => Math.abs(h - h0) <= tol || Math.abs(h - h1) <= tol);
      const sweep = circles.some((c) => c.closed) ? 2 * Math.PI : Math.max(...circles.map((c) => c.sweep));
      // Inner (a hole) when the outward facet normals point towards the axis.
      let outward = 0;
      for (const [a, b, c] of tris) {
        const m = scale(add(add(a!, b!), c!), 1 / 3);
        outward += dot(cross(sub(b!, a!), sub(c!, a!)), radial(m));
      }
      const axisPoint = add(c0.center, scale(axis, h0));
      return {
        type: "cylinder",
        axis,
        point: axisPoint,
        radius,
        area: twoHeights ? radius * sweep * (h1 - h0) : meshArea,
        exact: twoHeights,
        centroid,
        inner: outward < 0,
      };
    }
  }
  return { type: "surface", area: meshArea, exact: false, centroid };
}

/**
 * Exact area of a planar face: the triangulated area plus, for every chord of a circular boundary
 * edge, the circular segment between chord and arc — added where the arc bulges out of the
 * triangulation (a convex rim), subtracted where it bulges into it (a hole). Straight boundary
 * edges are exact already. Returns `exact: false` when a boundary edge is neither line nor circle.
 */
function planarExactArea(body: BodyInfo, face: string, tris: Vec3[][], n: Vec3, meshArea: number): { area: number; exact: boolean } {
  let area = meshArea;
  for (const e of boundaryEdges(body, face)) {
    const g = edgeGeom(e);
    if (g.type === "line") continue;
    if (g.type !== "circle") return { area: meshArea, exact: false };
    const p = edgePoints(e);
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1]!;
      const b = p[i]!;
      const chord = length(sub(b, a));
      if (chord <= 0) continue;
      const half = Math.min(1, chord / (2 * g.radius));
      const theta = 2 * Math.asin(half);
      const seg = ((g.radius * g.radius) / 2) * (theta - Math.sin(theta));
      // A point just past the chord's midpoint towards the arc.
      const m = scale(add(a, b), 0.5);
      const out = normalize(sub(m, g.center));
      const sag = g.radius - length(sub(m, g.center));
      const probe = add(m, scale(out, Math.max(sag * 0.5, 1e-9)));
      const covered = tris.some(([x, y, z]) => inTriangle(probe, x!, y!, z!, n));
      area += covered ? -seg : seg;
    }
  }
  return { area, exact: true };
}

export function faceArea(body: BodyInfo, face: string): { area: number; exact: boolean } {
  const g = faceGeom(body, face);
  return g ? { area: g.area, exact: g.exact } : { area: 0, exact: false };
}
