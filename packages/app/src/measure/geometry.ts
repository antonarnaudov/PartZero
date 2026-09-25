/**
 * Geometry of displayed entities, recovered from the render mesh — **exact only where the mesh
 * proves it**, approximate (`exact: false`, shown with "≈") everywhere else.
 *
 * What the mesh gives us:
 * - Tessellation vertices lie **on** the exact B-rep (edge polylines on the exact curves, face
 *   vertices on the exact surfaces), so a vertex position is exact (f32).
 * - forge-web's render mesh (`forge_mesh::tessellate_render`, the default engine) splits vertices
 *   per face and gives each the **face's exact surface normal**. A vertex no other face uses has
 *   its own face's normal in any Forge mesh; a vertex shared between faces (the CLI engine's OBJ)
 *   carries an average and proves nothing.
 *
 * What positions alone cannot tell: the render tessellation gives a low-sweep arc a single
 * segment (e.g. r 3, 15°: 15° is under the 0.35 rad angular limit and the sagitta under 0.05 mm),
 * and the cylinder wall along it a single quad — positions identical to a straight edge and a
 * planar face. Any three points fit a circle, and four symmetric samples of any symmetric arc
 * (an ellipse's, say) are concyclic. So:
 * - a **line** is exact with ≥ 3 collinear points, or with 2 when the adjacent faces' exact
 *   normals prove it: two non-parallel verified planes (their intersection is a line), or a
 *   curved face whose normal is the same at both ends (a ruling of a cylinder or cone);
 * - a **circle** is exact with ≥ {@link MIN_CIRCLE_POINTS} distinct points on it;
 * - a **plane** is exact when every vertex carries the face's own normal and they are all equal;
 *   its area is exact once every boundary edge is an exact line or circle (the chord segments
 *   along circles are corrected by their exact circular-segment areas);
 * - a **cylinder** is exact when its boundary has an exact circle and every vertex normal is
 *   radial (perpendicular to the axis, through it);
 * - anything else — a freeform surface, a non-circular curve, and every face or edge of a mesh
 *   whose normals are averaged across faces — is measured on the mesh and flagged approximate.
 * Body volume and area come from the evaluation report (exact in the kernel).
 *
 * The complete answer is the kernel's: curve and surface types per edge and face in the render
 * mesh, or a kernel `measure` query (docs/fm/view-sel-followups.md). Until then these rules keep
 * "exact" honest.
 */
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from "../viewport/view-camera";
import { facesOfEdgeName } from "../selection/picking";
import { edgePoints, faceTriangles, type BodyInfo, type EdgeInfo } from "../selection/topology";

/** Relative tolerance for "these f32 values describe the same exact geometry". */
export const GEOM_REL_TOL = 2e-5;
/** |n₁ × n₂| at or below this: two kernel normals (f32) point the same way. */
export const NORMAL_TOL = 1e-5;
/** Normals against directions recomputed from f32 positions (a cylinder's radial directions). */
export const RADIAL_TOL = 1e-4;
/**
 * A circle is claimed exact only with at least this many distinct points: three fit any circle,
 * and four symmetric samples of any symmetric arc (an isosceles trapezoid) are concyclic.
 */
export const MIN_CIRCLE_POINTS = 5;

export type EdgeGeom =
  | { type: "line"; p0: Vec3; p1: Vec3; dir: Vec3; length: number; exact: boolean }
  | { type: "circle"; center: Vec3; normal: Vec3; radius: number; closed: boolean; sweep: number; length: number; p0: Vec3; p1: Vec3; exact: boolean }
  | { type: "curve"; points: Vec3[]; length: number; exact: false };

/**
 * `verified`: the surface type and its parameters (normal; axis and radius) are proven by the
 * mesh. `exact`: the area is exact too (implies `verified`).
 */
export type FaceGeom =
  | { type: "plane"; normal: Vec3; point: Vec3; area: number; exact: boolean; verified: boolean; centroid: Vec3 }
  | { type: "cylinder"; axis: Vec3; point: Vec3; radius: number; area: number; exact: boolean; verified: boolean; centroid: Vec3; inner: boolean }
  | { type: "surface"; area: number; exact: false; verified: false; centroid: Vec3 };

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

const tolFor = (points: Vec3[]): number => scaleOf(points) * GEOM_REL_TOL + 1e-7;

/** Two unit normals point the same way. */
export function sameDirection(a: Vec3, b: Vec3, tol = NORMAL_TOL): boolean {
  return dot(a, b) > 0 && length(cross(a, b)) <= tol;
}

// ─── What the mesh's normals prove ─────────────────────────────────────────────────────────

interface MeshFacts {
  faceOrdinal: Map<string, number>;
  /** Per vertex: the ordinal of the only face using it, −1 unused, −2 shared by several faces. */
  owner: Int32Array;
  faceVerts: Map<string, number[]>;
  planes: Map<string, PlaneEvidence>;
}

type PlaneEvidence = { kind: "plane"; normal: Vec3 } | { kind: "curved" } | { kind: "unknown" };

const factsCache = new WeakMap<BodyInfo, MeshFacts>();

function meshFacts(body: BodyInfo): MeshFacts {
  const cached = factsCache.get(body);
  if (cached) return cached;
  const { indices, positions } = body.body;
  const nv = Math.floor(positions.length / 3);
  const owner = new Int32Array(nv).fill(-1);
  const faceOrdinal = new Map<string, number>();
  const faceVerts = new Map<string, number[]>();
  let ord = 0;
  for (const [name, info] of body.faces) {
    const me = ord++;
    faceOrdinal.set(name, me);
    const seen = new Set<number>();
    for (const r of info.ranges) {
      for (let t = r.start; t < r.start + r.count; t++) {
        for (let k = 0; k < 3; k++) {
          const i = indices[t * 3 + k];
          if (i === undefined || i >= nv) continue;
          seen.add(i);
          const o = owner[i]!;
          if (o === -1) owner[i] = me;
          else if (o !== me) owner[i] = -2;
        }
      }
    }
    faceVerts.set(name, [...seen].sort((a, b) => a - b));
  }
  const f: MeshFacts = { faceOrdinal, owner, faceVerts, planes: new Map() };
  factsCache.set(body, f);
  return f;
}

function faceVerts(body: BodyInfo, face: string): number[] {
  return meshFacts(body).faceVerts.get(face) ?? [];
}

/**
 * The exact surface normal of `face` at vertex `i` — only when no other face uses the vertex, so
 * the engine's normal is that face's own and not an average across faces.
 */
export function trustedNormal(body: BodyInfo, face: string, i: number): Vec3 | null {
  const f = meshFacts(body);
  const ord = f.faceOrdinal.get(face);
  if (ord === undefined || f.owner[i] !== ord) return null;
  const N = body.body.normals;
  if (N.length < (i + 1) * 3) return null;
  const n = pt(N, i);
  const l = length(n);
  if (!(l > 0.99 && l < 1.01)) return null;
  return scale(n, 1 / l);
}

/** The face's trusted normal at a point of its boundary (every vertex of the face there agrees). */
function normalAt(body: BodyInfo, face: string, p: Vec3, tol: number): Vec3 | null {
  const P = body.body.positions;
  let found: Vec3 | null = null;
  for (const i of faceVerts(body, face)) {
    if (length(sub(pt(P, i), p)) > tol) continue;
    const n = trustedNormal(body, face, i);
    if (!n) return null;
    if (found && !sameDirection(found, n)) return null;
    found ??= n;
  }
  return found;
}

/**
 * Whether a face is planar, by its normals: every vertex carries the face's own normal and they
 * are all equal (a plane, with its exact normal), some differ (curved), or the mesh cannot tell
 * (vertices shared with other faces: normals averaged).
 */
export function planeEvidence(body: BodyInfo, face: string): PlaneEvidence {
  const f = meshFacts(body);
  const hit = f.planes.get(face);
  if (hit) return hit;
  const idx = faceVerts(body, face);
  let ev: PlaneEvidence = { kind: "unknown" };
  let n0: Vec3 | null = null;
  let trusted = idx.length >= 3;
  let curved = false;
  for (const i of idx) {
    const n = trustedNormal(body, face, i);
    if (!n) {
      trusted = false;
      continue;
    }
    if (!n0) n0 = n;
    else if (!sameDirection(n, n0)) curved = true;
  }
  // Two trusted normals that differ prove curvature even if other vertices are shared.
  if (curved) ev = { kind: "curved" };
  else if (trusted && n0) {
    const P = body.body.positions;
    const pts = idx.map((i) => pt(P, i));
    const tol = tolFor(pts);
    let facet: Vec3 = [0, 0, 0];
    for (const [a, b, c] of faceTriangles(body, face)) facet = add(facet, cross(sub(b!, a!), sub(c!, a!)));
    const coplanar = pts.every((q) => Math.abs(dot(sub(q, pts[0]!), n0!)) <= tol);
    if (coplanar && dot(normalize(facet), n0) > 0.999) ev = { kind: "plane", normal: n0 };
    else ev = { kind: "curved" };
  }
  f.planes.set(face, ev);
  return ev;
}

/**
 * A two-point straight polyline is a straight B-rep edge only if the adjacent faces say so: two
 * non-parallel planes meet in a line; a curved face whose normal is the same at both ends holds
 * them on one ruling (a cylinder's or a cone's). Otherwise it may be a low-sweep arc or curve
 * tessellated as a single chord.
 */
function certifiedLine(body: BodyInfo, edge: string, p0: Vec3, p1: Vec3, tol: number): boolean {
  const faces = facesOfEdgeName(edge);
  if (faces.length !== 2 || faces[0] === faces[1]) return false;
  const ev = faces.map((f) => planeEvidence(body, f));
  const planes = ev.map((e) => (e.kind === "plane" ? e.normal : null));
  if (planes[0] && planes[1]) return length(cross(planes[0], planes[1])) > 1e-6;
  for (let k = 0; k < 2; k++) {
    if (planes[k]) continue;
    const a = normalAt(body, faces[k]!, p0, tol);
    const b = normalAt(body, faces[k]!, p1, tol);
    if (!a || !b || !sameDirection(a, b)) return false;
  }
  return true;
}

// ─── Edges ─────────────────────────────────────────────────────────────────────────────────

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

/**
 * Classify an edge polyline as a line, a circle (arc) or a general curve. `body` supplies the
 * adjacent faces' normals that certify a two-point line; without it such an edge is approximate.
 */
export function edgeGeom(e: EdgeInfo, body?: BodyInfo): EdgeGeom {
  const p = edgePoints(e);
  const len = polylineLength(p);
  if (p.length < 2) return { type: "curve", points: p, length: 0, exact: false };
  const tol = tolFor(p);
  const p0 = p[0]!;
  const p1 = p[p.length - 1]!;
  if (!e.closed) {
    const dir = normalize(sub(p1, p0));
    const straight = p.every((q) => length(cross(sub(q, p0), dir)) <= tol);
    if (straight && length(sub(p1, p0)) > 0) {
      const exact = p.length >= 3 || (body !== undefined && certifiedLine(body, e.name, p0, p1, tol));
      return { type: "line", p0, p1, dir, length: length(sub(p1, p0)), exact };
    }
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
        return {
          type: "circle",
          center: cc.center,
          normal: cc.normal,
          radius: cc.radius,
          closed: e.closed,
          sweep,
          length: cc.radius * sweep,
          p0,
          p1,
          exact: n >= MIN_CIRCLE_POINTS,
        };
      }
    }
  }
  return { type: "curve", points: p, length: len, exact: false };
}

// ─── Faces ─────────────────────────────────────────────────────────────────────────────────

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
 * Classify a face: plane, cylinder or a general surface (mesh area), with what the mesh proves
 * (`verified`, `exact`; see the module comment). Recognition uses **positions** (which lie exactly
 * on the surface) and the boundary curves; the engine's normals confirm it where they are the
 * face's own. Orientation (outward) comes from the triangle winding (CCW from outside).
 */
export function faceGeom(body: BodyInfo, face: string): FaceGeom | null {
  const tris = faceTriangles(body, face);
  if (tris.length === 0) return null;
  const idx = faceVerts(body, face);
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
  const tol = tolFor(pts);
  const ev = planeEvidence(body, face);

  // Plane: every vertex on the plane of the (area-weighted, outward) facet normal — unless the
  // face's own normals show it is curved (a low-sweep strip tessellated as one flat quad).
  const n0 = normalize(nsum);
  if (length(n0) > 0 && ev.kind !== "curved") {
    const point = pts[0]!;
    if (pts.every((q) => Math.abs(dot(sub(q, point), n0)) <= tol)) {
      if (ev.kind === "plane") {
        const { area, exact } = planarArea(body, face, tris, ev.normal, meshArea);
        return { type: "plane", normal: ev.normal, point, area, exact, verified: true, centroid };
      }
      // Flat in the mesh, but the normals cannot prove it (shared vertices): the corrected area
      // is the best estimate, flagged approximate.
      const { area } = planarArea(body, face, tris, n0, meshArea);
      return { type: "plane", normal: n0, point, area, exact: false, verified: false, centroid };
    }
  }

  // Cylinder: coaxial circular boundary curves of one radius, every vertex at that radius.
  const circles = boundaryEdges(body, face)
    .map((e) => edgeGeom(e, body))
    .filter((g): g is Extract<EdgeGeom, { type: "circle" }> => g.type === "circle");
  if (circles.length > 0) {
    const c0 = circles.find((c) => c.exact) ?? circles[0]!;
    const axis = c0.normal;
    const radial = (q: Vec3): Vec3 => {
      const v = sub(q, c0.center);
      return sub(v, scale(axis, dot(v, axis)));
    };
    const coaxial = circles.every((c) => length(cross(c.normal, axis)) <= 1e-5 && length(radial(c.center)) <= tol * 4 && Math.abs(c.radius - c0.radius) <= tol * 4);
    const onCylinder = coaxial && pts.every((q) => Math.abs(length(radial(q)) - c0.radius) <= tol * 4);
    if (onCylinder) {
      // The face's own normals must be radial: perpendicular to the axis, through it. One that is
      // not (a barrel, a cone) means another surface; untrusted normals leave it unverified.
      let normals: "radial" | "not-radial" | "unknown" = "radial";
      for (const i of idx) {
        const n = trustedNormal(body, face, i);
        if (!n) {
          normals = "unknown";
          continue;
        }
        const r = radial(pt(P, i));
        const lr = length(r);
        if (lr <= 0 || Math.abs(dot(n, axis)) > RADIAL_TOL || length(cross(n, scale(r, 1 / lr))) > RADIAL_TOL) {
          normals = "not-radial";
          break;
        }
      }
      if (normals !== "not-radial") {
        const radius = c0.radius;
        const hs = pts.map((q) => dot(sub(q, c0.center), axis));
        const h0 = Math.min(...hs);
        const h1 = Math.max(...hs);
        const twoHeights = hs.every((h) => Math.abs(h - h0) <= tol || Math.abs(h - h1) <= tol);
        const exactCircles = circles.filter((c) => c.exact);
        const sweep = circles.some((c) => c.closed) ? 2 * Math.PI : Math.max(...(exactCircles.length > 0 ? exactCircles : circles).map((c) => c.sweep));
        const verified = normals === "radial" && c0.exact;
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
          exact: verified && twoHeights,
          verified,
          centroid,
          inner: outward < 0,
        };
      }
    }
  }
  return { type: "surface", area: meshArea, exact: false, verified: false, centroid };
}

/**
 * Area of a planar face: the triangulated area plus, for every chord of a circular boundary edge,
 * the circular segment between chord and arc — added where the arc bulges out of the
 * triangulation (a convex rim), subtracted where it bulges into it (a hole). Exact when every
 * boundary edge is an exact line or an exact circle; otherwise the corrected value is approximate.
 */
function planarArea(body: BodyInfo, face: string, tris: Vec3[][], n: Vec3, meshArea: number): { area: number; exact: boolean } {
  let area = meshArea;
  let exact = true;
  for (const e of boundaryEdges(body, face)) {
    const g = edgeGeom(e, body);
    if (!g.exact) exact = false;
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
  return { area, exact };
}

export function faceArea(body: BodyInfo, face: string): { area: number; exact: boolean } {
  const g = faceGeom(body, face);
  return g ? { area: g.area, exact: g.exact } : { area: 0, exact: false };
}
