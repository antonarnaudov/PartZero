/**
 * Box selection by projection, with occlusion.
 *
 * - **Window** (drag left → right): entities entirely inside the rectangle.
 * - **Crossing** (drag right → left): entities inside or crossing the rectangle.
 * - A box selects **one kind**: faces when the filter allows faces, else edges, else vertices,
 *   else bodies (a box over a part should not return a mix of 200 faces, edges and vertices).
 * - Only **visible** entities are selected unless `includeHidden`: a software depth buffer of the
 *   rectangle (the same rasterizer the placeholder renderer uses) decides whether any sample of
 *   the entity inside the rectangle is in front.
 */
import type { CameraFrame, ScreenPoint } from "../viewport/view-camera";
import { rasterTriangle } from "../viewport/raster";
import { edgePoints, type BodyInfo, type SceneTopology } from "./topology";
import type { BoxMode, KindMask, SelectionItem } from "./types";

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BoxSelectOptions {
  frame: CameraFrame;
  topo: SceneTopology;
  filter: KindMask;
  rect: Rect;
  mode: BoxMode;
  hidden?: ReadonlySet<string>;
  includeHidden?: boolean;
}

export type BoxKind = "face" | "edge" | "vertex" | "body";

/** The kind a box selects with this filter (see the module docs). */
export function boxKind(filter: KindMask): BoxKind | null {
  if (filter.face) return "face";
  if (filter.edge) return "edge";
  if (filter.vertex) return "vertex";
  if (filter.body) return "body";
  return null;
}

/** Window when dragged left→right, crossing when dragged right→left (AutoCAD/Fusion convention). */
export function boxModeOf(startX: number, endX: number): BoxMode {
  return endX >= startX ? "window" : "crossing";
}

export function normRect(r: Rect): Rect {
  return { x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1), x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1) };
}

const inside = (r: Rect, x: number, y: number): boolean => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;

/** Does segment ab meet the rectangle? (Liang–Barsky.) Returns the clipped midpoint parameter or null. */
export function segmentRect(r: Rect, ax: number, ay: number, bx: number, by: number): number | null {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (clip(-dx, ax - r.x0) && clip(dx, r.x1 - ax) && clip(-dy, ay - r.y0) && clip(dy, r.y1 - ay)) return (t0 + t1) / 2;
  return null;
}

/** Barycentric coordinates of (x, y) in the screen triangle, or null outside. */
function bary(x: number, y: number, a: ScreenPoint, b: ScreenPoint, c: ScreenPoint): [number, number, number] | null {
  const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d;
  const l2 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d;
  const l3 = 1 - l1 - l2;
  return l1 >= 0 && l2 >= 0 && l3 >= 0 ? [l1, l2, l3] : null;
}

/** A depth buffer over the rectangle: the nearest view depth per cell (Infinity = empty). */
class RectDepth {
  readonly w: number;
  readonly h: number;
  readonly s: number;
  readonly key: Float32Array;
  constructor(
    readonly rect: Rect,
    maxCells = 512 * 512,
  ) {
    const rw = Math.max(1, rect.x1 - rect.x0);
    const rh = Math.max(1, rect.y1 - rect.y0);
    this.s = Math.min(1, Math.sqrt(maxCells / (rw * rh)));
    this.w = Math.max(1, Math.ceil(rw * this.s) + 2);
    this.h = Math.max(1, Math.ceil(rh * this.s) + 2);
    this.key = new Float32Array(this.w * this.h).fill(-Infinity);
  }
  /** Buffer coordinates of a screen point. */
  bx(x: number): number {
    return (x - this.rect.x0) * this.s + 1;
  }
  by(y: number): number {
    return (y - this.rect.y0) * this.s + 1;
  }
  add(a: ScreenPoint, b: ScreenPoint, c: ScreenPoint, ids: Int32Array): void {
    rasterTriangle(this.key, ids, this.w, this.h, this.bx(a.x), this.by(a.y), -a.depth, this.bx(b.x), this.by(b.y), -b.depth, this.bx(c.x), this.by(c.y), -c.depth, 0);
  }
  /** Is a sample at (x, y) with view depth `depth` in front (within `tol`) of the buffer? */
  visible(x: number, y: number, depth: number, tol: number): boolean {
    const cx = Math.floor(this.bx(x));
    const cy = Math.floor(this.by(y));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) return true;
        const k = this.key[yy * this.w + xx]!;
        if (k === -Infinity || -k >= depth - tol) return true;
      }
    }
    return false;
  }
}

interface Projected {
  body: BodyInfo;
  pts: Array<ScreenPoint | null>;
}

function projectBody(frame: CameraFrame, b: BodyInfo): Projected {
  const p = b.body.positions;
  const n = Math.floor(p.length / 3);
  const pts: Array<ScreenPoint | null> = new Array(n);
  for (let i = 0; i < n; i++) pts[i] = frame.project([p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!]);
  return { body: b, pts };
}

/** Select the entities of one kind in the rectangle (see the module docs). */
export function boxSelect(o: BoxSelectOptions): SelectionItem[] {
  const kind = boxKind(o.filter);
  if (!kind) return [];
  const r = normRect(o.rect);
  if (r.x1 - r.x0 < 1 || r.y1 - r.y0 < 1) return [];
  const bodies = [...o.topo.bodies.values()].filter((b) => !o.hidden?.has(b.name));
  const projected = bodies.map((b) => projectBody(o.frame, b));
  const depth = o.includeHidden ? null : new RectDepth(r);
  if (depth) {
    const ids = new Int32Array(depth.w * depth.h);
    for (const pb of projected) {
      const idx = pb.body.body.indices;
      for (let t = 0; t + 2 < idx.length; t += 3) {
        const a = pb.pts[idx[t]!];
        const b = pb.pts[idx[t + 1]!];
        const c = pb.pts[idx[t + 2]!];
        if (!a || !b || !c) continue;
        if (Math.max(a.x, b.x, c.x) < r.x0 || Math.min(a.x, b.x, c.x) > r.x1 || Math.max(a.y, b.y, c.y) < r.y0 || Math.min(a.y, b.y, c.y) > r.y1) continue;
        depth.add(a, b, c, ids);
      }
    }
  }
  const tolAt = (p: ScreenPoint): number => Math.max(1e-6, p.depth * 4e-3) + o.frame.worldPerPixel * 1.5;
  const vis = (p: ScreenPoint): boolean => !depth || depth.visible(p.x, p.y, p.depth, tolAt(p));
  const out: SelectionItem[] = [];

  if (kind === "vertex") {
    for (const { body, vertex } of o.topo.allVertices) {
      if (o.hidden?.has(body)) continue;
      const p = o.frame.project(vertex.point);
      if (p && inside(r, p.x, p.y) && vis(p)) out.push({ kind: "vertex", body, key: vertex.key, point: vertex.point });
    }
    return out;
  }

  if (kind === "edge") {
    for (const b of bodies) {
      for (const e of b.edges.values()) {
        const pts = edgePoints(e).map((q) => o.frame.project(q));
        if (pts.some((q) => q === null) || pts.length === 0) continue;
        const sp = pts as ScreenPoint[];
        const allIn = sp.every((q) => inside(r, q.x, q.y));
        let touches = allIn || sp.some((q) => inside(r, q.x, q.y));
        const samples: ScreenPoint[] = sp.filter((q) => inside(r, q.x, q.y));
        for (let i = 0; i + 1 < sp.length; i++) {
          const a = sp[i]!;
          const c = sp[i + 1]!;
          const t = segmentRect(r, a.x, a.y, c.x, c.y);
          if (t !== null) {
            touches = true;
            samples.push({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, depth: a.depth + (c.depth - a.depth) * t });
          }
        }
        const ok = o.mode === "window" ? allIn : touches;
        if (ok && samples.some(vis)) out.push({ kind: "edge", body: b.name, key: e.name });
      }
    }
    return out;
  }

  // Faces (and bodies, which are the union of their faces).
  const corners: Array<[number, number]> = [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x0, r.y1],
    [r.x1, r.y1],
    [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2],
  ];
  const perspective = o.frame.state.projection === "perspective";
  for (const pb of projected) {
    const idx = pb.body.body.indices;
    const pos = pb.body.body.positions;
    /** A triangle faces the viewer (closed solids: back faces are never visible). */
    const facing = (t: number): boolean => {
      const i0 = idx[t * 3]! * 3;
      const i1 = idx[t * 3 + 1]! * 3;
      const i2 = idx[t * 3 + 2]! * 3;
      const ax = pos[i0]!, ay = pos[i0 + 1]!, az = pos[i0 + 2]!;
      const ux = pos[i1]! - ax, uy = pos[i1 + 1]! - ay, uz = pos[i1 + 2]! - az;
      const vx = pos[i2]! - ax, vy = pos[i2 + 1]! - ay, vz = pos[i2 + 2]! - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (perspective) return nx * (o.frame.eye[0] - ax) + ny * (o.frame.eye[1] - ay) + nz * (o.frame.eye[2] - az) > 0;
      return nx * o.frame.forward[0] + ny * o.frame.forward[1] + nz * o.frame.forward[2] < 0;
    };
    let bodyAllIn = true;
    let bodyTouch = false;
    let bodyVisible = false;
    for (const f of pb.body.faces.values()) {
      let allIn = true;
      let touch = false;
      let visible = false;
      for (const range of f.ranges) {
        for (let t = range.start; t < range.start + range.count; t++) {
          const a = pb.pts[idx[t * 3]!];
          const b = pb.pts[idx[t * 3 + 1]!];
          const c = pb.pts[idx[t * 3 + 2]!];
          if (!a || !b || !c) {
            allIn = false;
            continue;
          }
          const tri = [a, b, c];
          const ins = tri.map((q) => inside(r, q.x, q.y));
          if (!ins.every(Boolean)) allIn = false;
          let meets = ins.some(Boolean);
          const samples: ScreenPoint[] = tri.filter((_, k) => ins[k]);
          const cen: ScreenPoint = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3, depth: (a.depth + b.depth + c.depth) / 3 };
          if (inside(r, cen.x, cen.y)) samples.push(cen);
          for (let k = 0; k < 3; k++) {
            const p = tri[k]!;
            const q = tri[(k + 1) % 3]!;
            const tt = segmentRect(r, p.x, p.y, q.x, q.y);
            if (tt !== null) {
              meets = true;
              samples.push({ x: p.x + (q.x - p.x) * tt, y: p.y + (q.y - p.y) * tt, depth: p.depth + (q.depth - p.depth) * tt });
            }
          }
          for (const [x, y] of corners) {
            const w = bary(x, y, a, b, c);
            if (w) {
              meets = true;
              samples.push({ x, y, depth: a.depth * w[0] + b.depth * w[1] + c.depth * w[2] });
            }
          }
          if (meets) touch = true;
          if (!visible && samples.length > 0 && (o.includeHidden || facing(t)) && samples.some(vis)) visible = true;
        }
      }
      if (!allIn) bodyAllIn = false;
      if (touch) bodyTouch = true;
      if (visible) bodyVisible = true;
      if (kind === "face" && (o.mode === "window" ? allIn : touch) && visible) out.push({ kind: "face", body: pb.body.name, key: f.name });
    }
    if (kind === "body" && (o.mode === "window" ? bodyAllIn && pb.body.faces.size > 0 : bodyTouch) && bodyVisible) out.push({ kind: "body", body: pb.body.name });
  }
  return out;
}
