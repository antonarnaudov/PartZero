/**
 * Wavefront OBJ → {@link RenderBody}[] for the Forge CLI engine.
 *
 * `aicad export` (forge-io) writes one `o <part>/<feature>[#n]` object per body and one
 * `g <feature>/<face>` group per B-rep face, so face provenance survives the round trip. OBJ has
 * no B-rep edges; we recover them from the mesh: a triangle edge whose two triangles belong to
 * different face groups lies on a B-rep edge (and so does an unshared, open-boundary edge). The
 * segments are chained into polylines per face pair and named like Forge names B-rep edges:
 * `<feature>/edge:{<faceA>|<faceB>}` (faces sorted; `#n` suffix when a pair meets more than once).
 * Face ranges count triangles, as in `@aicad/forge-web`.
 */
import type { EdgePolyline, FaceRange, RenderBody } from "./types";

export interface ParseObjOptions {
  /** Recover B-rep edges from face-group boundaries (default true). */
  deriveEdges?: boolean;
  /** Grid used to weld coincident positions when deriving edges, mm (default 1e-6). */
  weldTolerance?: number;
}

export class ObjParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`OBJ line ${line}: ${message}`);
    this.name = "ObjParseError";
    this.line = line;
  }
}

interface BodyBuilder {
  name: string;
  keyToIndex: Map<string, number>;
  positions: number[];
  normals: number[];
  /** Local vertices without an OBJ normal (filled from face normals afterwards). */
  missingNormal: Set<number>;
  indices: number[];
  faceRanges: FaceRange[];
  /** Face name per triangle. */
  triFaces: string[];
}

function newBody(name: string): BodyBuilder {
  return { name, keyToIndex: new Map(), positions: [], normals: [], missingNormal: new Set(), indices: [], faceRanges: [], triFaces: [] };
}

/** Parse OBJ text into render bodies (one per `o`). */
export function parseObj(text: string, options: ParseObjOptions = {}): RenderBody[] {
  const deriveEdges = options.deriveEdges ?? true;
  const weld = options.weldTolerance ?? 1e-6;
  const vs: number[] = [];
  const vns: number[] = [];
  const bodies: BodyBuilder[] = [];
  let body: BodyBuilder | undefined;
  let face = "";

  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln]!;
    // A comment starts at a `#` at the line start or after whitespace; Forge body names contain
    // `#` (`part/pucks#1`), so a `#` inside a token is data.
    const hash = raw.search(/(^|\s)#/);
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim();
    if (line === "") continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    switch (tag) {
      case "v": {
        if (parts.length < 4) throw new ObjParseError("vertex needs 3 coordinates", ln + 1);
        vs.push(num(parts[1], ln), num(parts[2], ln), num(parts[3], ln));
        break;
      }
      case "vn": {
        if (parts.length < 4) throw new ObjParseError("normal needs 3 components", ln + 1);
        vns.push(num(parts[1], ln), num(parts[2], ln), num(parts[3], ln));
        break;
      }
      case "o": {
        body = newBody(parts.slice(1).join(" ") || `body${bodies.length}`);
        bodies.push(body);
        face = "";
        break;
      }
      case "g": {
        face = parts.slice(1).join(" ");
        break;
      }
      case "f": {
        if (!body) {
          body = newBody("body");
          bodies.push(body);
        }
        if (parts.length < 4) throw new ObjParseError("face needs at least 3 vertices", ln + 1);
        const corner = parts.slice(1).map((tok) => vertexIndex(body!, tok, vs, vns, ln));
        const faceName = face || body.name;
        // Fan-triangulate polygons.
        for (let k = 1; k + 1 < corner.length; k++) {
          const last = body.faceRanges[body.faceRanges.length - 1];
          const tri = body.indices.length / 3;
          if (last && last.face === faceName && last.start + last.count === tri) {
            last.count += 1;
          } else {
            body.faceRanges.push({ face: faceName, start: tri, count: 1 });
          }
          body.indices.push(corner[0]!, corner[k]!, corner[k + 1]!);
          body.triFaces.push(faceName);
        }
        break;
      }
      default:
        // vt, s, usemtl, mtllib, l, … are irrelevant for display.
        break;
    }
  }

  return bodies
    .filter((b) => b.indices.length > 0)
    .map((b) => {
      fillMissingNormals(b);
      return {
        name: b.name,
        positions: Float32Array.from(b.positions),
        normals: Float32Array.from(b.normals),
        indices: Uint32Array.from(b.indices),
        faceRanges: b.faceRanges,
        edges: deriveEdges ? deriveFaceBoundaryEdges(b.positions, b.indices, b.triFaces, weld) : [],
      };
    });
}

function num(tok: string | undefined, ln: number): number {
  const n = Number(tok);
  if (tok === undefined || !Number.isFinite(n)) throw new ObjParseError(`not a number: ${String(tok)}`, ln + 1);
  return n;
}

/** Resolve an OBJ index (1-based, negative = relative to the end). */
function resolveIndex(tok: string, count: number, ln: number, what: string): number {
  const i = Number.parseInt(tok, 10);
  if (!Number.isFinite(i) || i === 0) throw new ObjParseError(`bad ${what} index ${tok}`, ln + 1);
  const idx = i > 0 ? i - 1 : count + i;
  if (idx < 0 || idx >= count) throw new ObjParseError(`${what} index ${tok} out of range`, ln + 1);
  return idx;
}

function vertexIndex(b: BodyBuilder, tok: string, vs: number[], vns: number[], ln: number): number {
  const [vTok, , nTok] = tok.split("/");
  const vi = resolveIndex(vTok ?? "", vs.length / 3, ln, "vertex");
  const ni = nTok ? resolveIndex(nTok, vns.length / 3, ln, "normal") : -1;
  const key = `${vi}/${ni}`;
  const existing = b.keyToIndex.get(key);
  if (existing !== undefined) return existing;
  const local = b.positions.length / 3;
  b.positions.push(vs[vi * 3]!, vs[vi * 3 + 1]!, vs[vi * 3 + 2]!);
  if (ni >= 0) {
    b.normals.push(vns[ni * 3]!, vns[ni * 3 + 1]!, vns[ni * 3 + 2]!);
  } else {
    b.normals.push(0, 0, 0);
    b.missingNormal.add(local);
  }
  b.keyToIndex.set(key, local);
  return local;
}

/** Area-weighted vertex normals for vertices the OBJ gave no normal. */
function fillMissingNormals(b: BodyBuilder): void {
  if (b.missingNormal.size === 0) return;
  const p = b.positions;
  const n = b.normals;
  for (let t = 0; t < b.indices.length; t += 3) {
    const [i0, i1, i2] = [b.indices[t]!, b.indices[t + 1]!, b.indices[t + 2]!];
    const ux = p[i1 * 3]! - p[i0 * 3]!, uy = p[i1 * 3 + 1]! - p[i0 * 3 + 1]!, uz = p[i1 * 3 + 2]! - p[i0 * 3 + 2]!;
    const vx = p[i2 * 3]! - p[i0 * 3]!, vy = p[i2 * 3 + 1]! - p[i0 * 3 + 1]!, vz = p[i2 * 3 + 2]! - p[i0 * 3 + 2]!;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const i of [i0, i1, i2]) {
      if (!b.missingNormal.has(i)) continue;
      n[i * 3] = n[i * 3]! + cx;
      n[i * 3 + 1] = n[i * 3 + 1]! + cy;
      n[i * 3 + 2] = n[i * 3 + 2]! + cz;
    }
  }
  for (const i of b.missingNormal) {
    const len = Math.hypot(n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!) || 1;
    n[i * 3] = n[i * 3]! / len;
    n[i * 3 + 1] = n[i * 3 + 1]! / len;
    n[i * 3 + 2] = n[i * 3 + 2]! / len;
  }
}

interface SegmentInfo {
  a: number;
  b: number;
  faces: string[];
  uses: number;
}

/**
 * B-rep edges recovered from a mesh with per-triangle face names: segments between triangles of
 * different faces, plus open-boundary segments, chained into polylines per (sorted) face pair.
 */
export function deriveFaceBoundaryEdges(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  triFaces: readonly string[],
  weldTolerance = 1e-6,
): EdgePolyline[] {
  // Weld coincident positions (vertices are duplicated across faces with different normals).
  const weldId = new Int32Array(positions.length / 3);
  const weldPos: number[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < weldId.length; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    const key = `${Math.round(x / weldTolerance)},${Math.round(y / weldTolerance)},${Math.round(z / weldTolerance)}`;
    let id = byKey.get(key);
    if (id === undefined) {
      id = weldPos.length / 3;
      byKey.set(key, id);
      weldPos.push(x, y, z);
    }
    weldId[i] = id;
  }

  const segments = new Map<string, SegmentInfo>();
  for (let t = 0; t * 3 < indices.length; t++) {
    const face = triFaces[t] ?? "";
    const w = [weldId[indices[t * 3]!]!, weldId[indices[t * 3 + 1]!]!, weldId[indices[t * 3 + 2]!]!];
    for (let k = 0; k < 3; k++) {
      const a = w[k]!, b = w[(k + 1) % 3]!;
      if (a === b) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = `${lo}:${hi}`;
      let s = segments.get(key);
      if (!s) {
        s = { a: lo, b: hi, faces: [], uses: 0 };
        segments.set(key, s);
      }
      s.uses++;
      if (!s.faces.includes(face)) s.faces.push(face);
    }
  }

  // Group boundary segments by face pair.
  const groups = new Map<string, Array<[number, number]>>();
  for (const s of segments.values()) {
    const isFaceBoundary = s.faces.length >= 2;
    const isOpenBoundary = s.uses === 1;
    if (!isFaceBoundary && !isOpenBoundary) continue;
    const pair = isFaceBoundary ? [...s.faces].sort().join("|") : `${s.faces[0] ?? ""}|<open>`;
    const first = pair.slice(0, pair.indexOf("|"));
    const name = `${first.includes("/") ? first.slice(0, first.indexOf("/")) : first}/edge:{${pair}}`;
    let g = groups.get(name);
    if (!g) {
      g = [];
      groups.set(name, g);
    }
    g.push([s.a, s.b]);
  }

  const edges: EdgePolyline[] = [];
  for (const name of [...groups.keys()].sort()) {
    const chains = chainSegments(groups.get(name)!);
    chains.forEach((chain, i) => {
      const pts = new Float32Array(chain.length * 3);
      chain.forEach((id, j) => {
        pts[j * 3] = weldPos[id * 3]!;
        pts[j * 3 + 1] = weldPos[id * 3 + 1]!;
        pts[j * 3 + 2] = weldPos[id * 3 + 2]!;
      });
      edges.push({ edge: i === 0 ? name : `${name}#${i}`, points: pts });
    });
  }
  return edges;
}

/** Chain undirected segments into polylines (open chains first, then closed loops). */
export function chainSegments(segs: ReadonlyArray<readonly [number, number]>): number[][] {
  const adj = new Map<number, number[]>();
  const add = (v: number, s: number): void => {
    const l = adj.get(v);
    if (l) l.push(s);
    else adj.set(v, [s]);
  };
  segs.forEach(([a, b], i) => {
    add(a, i);
    add(b, i);
  });
  const used = new Uint8Array(segs.length);
  const chains: number[][] = [];

  const walk = (start: number): number[] => {
    const chain = [start];
    let v = start;
    for (;;) {
      const next = (adj.get(v) ?? []).find((s) => !used[s]);
      if (next === undefined) break;
      used[next] = 1;
      const [a, b] = segs[next]!;
      v = a === v ? b : a;
      chain.push(v);
      if (v === start) break;
    }
    return chain;
  };

  // Open chains start at vertices of odd degree; the rest are loops.
  const starts = [...adj.keys()].sort((x, y) => x - y);
  for (const v of starts) {
    if ((adj.get(v)!.length & 1) === 1 && adj.get(v)!.some((s) => !used[s])) chains.push(walk(v));
  }
  for (const v of starts) {
    while (adj.get(v)!.some((s) => !used[s])) chains.push(walk(v));
  }
  return chains;
}
