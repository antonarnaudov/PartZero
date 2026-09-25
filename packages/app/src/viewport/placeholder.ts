/**
 * The placeholder viewport: a small software renderer on a Canvas 2D, used when
 * `@aicad/forge-web` cannot start (no WebGPU/WebGL2, or not bundled).
 *
 * - Faces are rasterized into a depth buffer and a triangle-id buffer (flat shading, headlight),
 *   so occlusion is correct and picking is pixel-exact: the id under the cursor names the face.
 * - B-rep edge polylines are depth-tested against that buffer and drawn as anti-aliased lines;
 *   the visible runs are kept for edge picking.
 * - It uses the shared camera (`view-camera.ts`, forge-render's convention) and draws every
 *   display mode itself (wireframe, hidden line and X-ray included), per-body colours, and a
 *   section plane (triangles and edge segments on the removed side are skipped; no caps).
 * - Input is handled by the host (navigation, picking): this class only draws and picks.
 */
import type { RenderBody } from "../engine/types";
import type { RawHit } from "../selection/picking";
import type { AdapterCapabilities, DisplaySettings, HighlightRef, SectionPlane, ViewportAdapter, ViewportColors } from "./adapter";
import { DISPLAY_MODES, type DisplayMode } from "./display";
import { rasterTriangle } from "./raster";
import {
  add,
  cameraFrame,
  defaultCamera,
  dot,
  fitSphere,
  normalize,
  orbit as orbitCamera,
  pan as panCamera,
  scale,
  sphereFromBox,
  viewAngles,
  zoomAt as zoomCamera,
  type CameraFrame,
  type CameraState,
  type Projection,
  type StandardView,
  type Vec3,
} from "./view-camera";

export { rasterTriangle };

export const DEFAULT_VIEWPORT_COLORS: ViewportColors = {
  background: "#272b32",
  backgroundBottom: "#1c1f24",
  grid: "rgba(255,255,255,0.045)",
  gridMajor: "rgba(255,255,255,0.09)",
  body: "#a4adb8",
  edge: "#14161a",
  accent: "#4c8dff",
  hover: "#f0b35a",
  text: "#d7dae0",
};

interface PreparedBody {
  name: string;
  positions: Float32Array;
  indices: Uint32Array;
  /** Global face index per local triangle. */
  triFace: Int32Array;
  /** Unit world normal per triangle (oriented outward). */
  triNormal: Float32Array;
  edges: Array<{ name: string; points: Float32Array }>;
  color: [number, number, number] | null;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface EdgeRun {
  body: number;
  edge: number;
  /** CSS px. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Frame {
  w: number;
  h: number;
  /** Buffer pixels per CSS pixel. */
  scale: number;
  /** Larger = nearer; -Infinity = background. */
  depth: Float32Array;
  /** Global triangle index, or -1. */
  ids: Int32Array;
  image: ImageData;
  pixels: Uint32Array;
  /** Shading level (0..63) per global triangle for this camera. */
  level: Uint8Array;
  edgeRuns: EdgeRun[];
  cam: CameraFrame;
}

const LEVELS = 64;
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function parseColor(c: string): Rgb {
  const hex = c.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgb = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  return { r: 164, g: 173, b: 184 };
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

function pack(c: Rgb, k: number): number {
  const r = Math.round(Math.min(255, c.r * k));
  const g = Math.round(Math.min(255, c.g * k));
  const b = Math.round(Math.min(255, c.b * k));
  return LITTLE_ENDIAN ? ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
}

function niceStep(x: number): number {
  const p = 10 ** Math.floor(Math.log10(Math.max(x, 1e-6)));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export class PlaceholderViewport implements ViewportAdapter {
  readonly kind = "placeholder" as const;
  readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly buffer: HTMLCanvasElement;
  private readonly bg: CanvasRenderingContext2D;
  private bodies: PreparedBody[] = [];
  /** Global faces: body index + provenance name. */
  private faces: Array<{ body: number; name: string }> = [];
  private triCount = 0;
  /** Global face index per global triangle. */
  private triFaceGlobal = new Int32Array(0);
  private cam: CameraState = defaultCamera();
  private width = 1;
  private height = 1;
  private dpr = 1;
  private colors: ViewportColors = DEFAULT_VIEWPORT_COLORS;
  /** Per body colour: 4 variants (normal, hover, selected, selected+hover) × LEVELS packed colours. */
  private palettes = new Map<string, Uint32Array>();
  private hover: HighlightRef | null = null;
  private selFaces = new Set<string>();
  private selEdges = new Set<string>();
  private bounds: { center: Vec3; radius: number } | null = null;
  private display: DisplaySettings = { mode: "shadedEdges", grid: true, axes: true };
  private section: SectionPlane | null = null;
  private frame: Frame | null = null;
  private rasterValid = false;
  private raf = 0;
  private disposed = false;
  private readonly frameListeners = new Set<() => void>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const g = canvas.getContext("2d", { alpha: false });
    if (!g) throw new Error("Canvas 2D is not available");
    this.g = g;
    this.buffer = document.createElement("canvas");
    const bg = this.buffer.getContext("2d");
    if (!bg) throw new Error("Canvas 2D is not available");
    this.bg = bg;
    const r = canvas.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
  }

  backend(): string {
    return "Canvas 2D";
  }

  capabilities(): AdapterCapabilities {
    return { nativeModes: DISPLAY_MODES, transparency: true };
  }

  // ─── Scene ─────────────────────────────────────────────────────────────────────────────────

  setBodies(bodies: readonly RenderBody[]): void {
    const hadBounds = this.bounds !== null;
    this.faces = [];
    const faceIndex = new Map<string, number>();
    this.bodies = bodies.map((b, bi) => prepare(b, bi, this.faces, faceIndex));
    this.triCount = this.bodies.reduce((n, b) => n + b.triFace.length, 0);
    this.triFaceGlobal = new Int32Array(this.triCount);
    let o = 0;
    for (const b of this.bodies) {
      this.triFaceGlobal.set(b.triFace, o);
      o += b.triFace.length;
    }
    this.bounds = computeBounds(this.bodies);
    if (!hadBounds && this.bounds) this.fitView();
    this.invalidate(true);
  }

  setHover(p: HighlightRef | null): void {
    this.hover = p;
    this.invalidate(false);
  }

  setSelection(picks: readonly HighlightRef[]): void {
    this.selFaces = new Set(picks.filter((p) => p.face).map((p) => `${p.body}\u0000${p.face}`));
    this.selEdges = new Set(picks.filter((p) => p.edge && !p.face).map((p) => `${p.body}\u0000${p.edge}`));
    this.invalidate(false);
  }

  setColors(colors: ViewportColors): void {
    this.colors = colors;
    this.palettes.clear();
    this.invalidate(false);
  }

  setDisplay(settings: DisplaySettings): void {
    this.display = { ...settings };
    this.invalidate(true);
  }

  setSection(plane: SectionPlane | null): void {
    this.section = plane ? { origin: [...plane.origin], normal: normalize(plane.normal) } : null;
    this.invalidate(true);
  }

  // ─── Camera ────────────────────────────────────────────────────────────────────────────────

  camera(): CameraState {
    return { ...this.cam, target: [...this.cam.target] };
  }

  setCamera(state: Partial<CameraState>): void {
    this.cam = { ...this.cam, ...state, ...(state.target ? { target: [...state.target] as Vec3 } : {}) };
    this.invalidate(true);
  }

  fitView(): void {
    if (!this.bounds) return;
    this.cam = fitSphere(this.cam, this.bounds, this.width / this.height);
    this.invalidate(true);
  }

  setView(v: StandardView): void {
    const [yaw, pitch] = viewAngles(v);
    this.cam = { ...this.cam, yaw, pitch };
    this.fitView();
    this.invalidate(true);
  }

  setProjection(p: Projection): void {
    this.cam = { ...this.cam, projection: p };
    this.invalidate(true);
  }

  orbit(dx: number, dy: number): void {
    this.cam = orbitCamera(this.cam, dx, dy);
    this.invalidate(true);
  }

  pan(dx: number, dy: number): void {
    this.cam = panCamera(this.cam, dx, dy, this.height);
    this.invalidate(true);
  }

  zoomAt(x: number, y: number, factor: number): void {
    this.cam = zoomCamera(this.cam, x, y, this.width, this.height, factor);
    this.invalidate(true);
  }

  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = dpr;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.rasterValid = false;
    this.render();
  }

  onFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  // ─── Picking ───────────────────────────────────────────────────────────────────────────────

  pick(x: number, y: number): Promise<RawHit | null> {
    if (!this.frame || !this.rasterValid) this.render();
    const f = this.frame;
    if (!f) return Promise.resolve(null);
    // Visible edges within 4 px win (as in CAD apps), nearest first.
    let best: EdgeRun | null = null;
    let bestD = 4;
    for (const r of f.edgeRuns) {
      const d = distToSegment(x, y, r.x0, r.y0, r.x1, r.y1);
      if (d <= bestD) {
        bestD = d;
        best = r;
      }
    }
    const bx = Math.floor(x * f.scale);
    const by = Math.floor(y * f.scale);
    const inside = bx >= 0 && by >= 0 && bx < f.w && by < f.h;
    const point = inside ? this.pointAt(f, x, y, f.depth[by * f.w + bx]!) : null;
    if (best) {
      const body = this.bodies[best.body]!;
      const t = segmentParam(x, y, best.x0, best.y0, best.x1, best.y1);
      const ex = best.x0 + (best.x1 - best.x0) * t;
      const ey = best.y0 + (best.y1 - best.y0) * t;
      const ebx = Math.floor(ex * f.scale);
      const eby = Math.floor(ey * f.scale);
      const k = ebx >= 0 && eby >= 0 && ebx < f.w && eby < f.h ? f.depth[eby * f.w + ebx]! : -Infinity;
      return Promise.resolve({ kind: "edge", body: body.name, edge: body.edges[best.edge]!.name, point: this.pointAt(f, ex, ey, k) });
    }
    if (!inside || this.display.mode === "wireframe") return Promise.resolve(null);
    const id = f.ids[by * f.w + bx]!;
    if (id < 0) return Promise.resolve(null);
    const face = this.faces[this.triFaceGlobal[id]!]!;
    return Promise.resolve({ kind: "face", body: this.bodies[face.body]!.name, face: face.name, point });
  }

  /** World point at a pixel from the depth key (null for the background). */
  private pointAt(f: Frame, x: number, y: number, key: number): Vec3 | null {
    if (!Number.isFinite(key)) return null;
    const { origin, dir } = f.cam.ray(x, y);
    const depth = this.cam.projection === "perspective" ? 1 / key : -key;
    const along = depth / Math.max(1e-12, dot(dir, f.cam.forward));
    return add(origin, scale(dir, along));
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.frameListeners.clear();
    this.canvas.remove();
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────────────────────

  private invalidate(geometry: boolean): void {
    if (geometry) this.rasterValid = false;
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  private palette(color: [number, number, number] | null): Uint32Array {
    const key = color ? color.join(",") : "";
    let p = this.palettes.get(key);
    if (p) return p;
    const hiddenLine = this.display.mode === "hiddenLine";
    const base = hiddenLine ? parseColor(this.colors.background) : color ? { r: color[0] * 255, g: color[1] * 255, b: color[2] * 255 } : parseColor(this.colors.body);
    const accent = parseColor(this.colors.accent);
    const hover = parseColor(this.colors.hover);
    const variants = [base, mix(base, hover, 0.45), mix(base, accent, 0.6), mix(mix(base, accent, 0.6), hover, 0.3)];
    p = new Uint32Array(4 * LEVELS);
    variants.forEach((c, v) => {
      for (let l = 0; l < LEVELS; l++) p![v * LEVELS + l] = pack(c, hiddenLine ? 1 : l / (LEVELS - 1));
    });
    this.palettes.set(key, p);
    return p;
  }

  private render(): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const targetScale = this.dpr;
    if (!this.rasterValid || !this.frame || this.frame.scale !== targetScale) {
      this.palettes.clear();
      this.raster(targetScale);
    }
    this.colorize();
    this.composite();
    this.canvas.dataset["frameMs"] = (performance.now() - t0).toFixed(1);
    for (const l of [...this.frameListeners]) l();
  }

  private clipped(p: Vec3): boolean {
    const s = this.section;
    if (!s) return false;
    return dot(s.normal, p) - dot(s.normal, s.origin) > 0;
  }

  /** Rasterize faces into depth + id buffers, and compute visible edge runs. */
  private raster(bufferScale: number): void {
    const w = Math.max(1, Math.round(this.width * bufferScale));
    const h = Math.max(1, Math.round(this.height * bufferScale));
    const cam = cameraFrame(this.cam, this.width, this.height);
    let f = this.frame;
    if (!f || f.w !== w || f.h !== h) {
      const image = new ImageData(w, h);
      f = {
        w,
        h,
        scale: bufferScale,
        depth: new Float32Array(w * h),
        ids: new Int32Array(w * h),
        image,
        pixels: new Uint32Array(image.data.buffer),
        level: new Uint8Array(this.triCount),
        edgeRuns: [],
        cam,
      };
      this.buffer.width = w;
      this.buffer.height = h;
    }
    f.scale = bufferScale;
    f.cam = cam;
    if (f.level.length !== this.triCount) f.level = new Uint8Array(this.triCount);
    f.depth.fill(-Infinity);
    f.ids.fill(-1);
    f.edgeRuns = [];
    this.frame = f;

    const b = cam.basis;
    const light = normalize(add(add(scale(cam.forward, -0.75), scale(b.up, 0.55)), scale(b.right, -0.3)));
    const perspective = this.cam.projection === "perspective";
    const near = this.cam.distance * 1e-3;
    const key = (z: number): number => (perspective ? 1 / z : -z);
    const { depth, ids } = f;
    const mode = this.display.mode;
    const drawFaces = mode !== "wireframe";

    let triBase = 0;
    for (const body of this.bodies) {
      const p = body.positions;
      const n = p.length / 3;
      const sx = new Float32Array(n);
      const sy = new Float32Array(n);
      const sk = new Float32Array(n);
      const behind = new Uint8Array(n);
      const cut = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const q: Vec3 = [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
        const s = cam.project(q);
        cut[i] = this.clipped(q) ? 1 : 0;
        if (!s || (perspective && s.depth < near)) {
          behind[i] = 1;
          continue;
        }
        sx[i] = s.x * bufferScale;
        sy[i] = s.y * bufferScale;
        sk[i] = key(s.depth);
      }
      const tris = body.triFace.length;
      for (let t = 0; t < tris; t++) {
        const a = body.indices[t * 3]!, c1 = body.indices[t * 3 + 1]!, c2 = body.indices[t * 3 + 2]!;
        const nx = body.triNormal[t * 3]!, ny = body.triNormal[t * 3 + 1]!, nz = body.triNormal[t * 3 + 2]!;
        f.level[triBase + t] = Math.round((0.36 + 0.64 * Math.max(0, nx * light[0] + ny * light[1] + nz * light[2])) * (LEVELS - 1));
        if (!drawFaces || behind[a] || behind[c1] || behind[c2]) continue;
        if (cut[a] && cut[c1] && cut[c2]) continue;
        const facing = perspective
          ? nx * (cam.eye[0] - p[a * 3]!) + ny * (cam.eye[1] - p[a * 3 + 1]!) + nz * (cam.eye[2] - p[a * 3 + 2]!)
          : -(nx * cam.forward[0] + ny * cam.forward[1] + nz * cam.forward[2]);
        // With a section, back faces show through the cut (as caps would).
        if (facing <= 0 && !this.section) continue;
        if (this.section && (cut[a] || cut[c1] || cut[c2])) {
          // A triangle crossing the plane: clip it in world space and rasterize the kept part.
          const poly = clipByPlane(
            [
              [p[a * 3]!, p[a * 3 + 1]!, p[a * 3 + 2]!],
              [p[c1 * 3]!, p[c1 * 3 + 1]!, p[c1 * 3 + 2]!],
              [p[c2 * 3]!, p[c2 * 3 + 1]!, p[c2 * 3 + 2]!],
            ],
            this.section,
          );
          const sp = poly.map((q) => cam.project(q));
          if (sp.some((s) => !s || (perspective && s.depth < near))) continue;
          for (let k = 1; k + 1 < sp.length; k++) {
            const s0 = sp[0]!, s1 = sp[k]!, s2 = sp[k + 1]!;
            rasterTriangle(depth, ids, w, h, s0.x * bufferScale, s0.y * bufferScale, key(s0.depth), s1.x * bufferScale, s1.y * bufferScale, key(s1.depth), s2.x * bufferScale, s2.y * bufferScale, key(s2.depth), triBase + t);
          }
          continue;
        }
        rasterTriangle(depth, ids, w, h, sx[a]!, sy[a]!, sk[a]!, sx[c1]!, sy[c1]!, sk[c1]!, sx[c2]!, sy[c2]!, sk[c2]!, triBase + t);
      }
      triBase += tris;
    }

    // Edges: sample each segment per buffer pixel against the depth buffer (X-ray and wireframe
    // show every edge).
    const allVisible = mode === "wireframe" || mode === "xray";
    const tolRel = 0.003;
    const tolAbs = this.cam.distance * 0.003;
    this.bodies.forEach((body, bi) => {
      body.edges.forEach((e, ei) => {
        const pts = e.points;
        let px = 0, py = 0, pk = 0, pBehind = true, pCut = false;
        let pq: Vec3 = [0, 0, 0];
        for (let k = 0; k * 3 < pts.length; k++) {
          const q: Vec3 = [pts[k * 3]!, pts[k * 3 + 1]!, pts[k * 3 + 2]!];
          const s = cam.project(q);
          const cCut = this.clipped(q);
          const cBehind = !s || (perspective && s.depth < near);
          const cx = s?.x ?? 0, cy = s?.y ?? 0, ck = s ? key(s.depth) : 0;
          if (k > 0 && !pBehind && !cBehind && !(pCut && cCut)) {
            const emit = (x0: number, y0: number, x1: number, y1: number): void => {
              f!.edgeRuns.push({ body: bi, edge: ei, x0, y0, x1, y1 });
            };
            let [ax, ay, ak, bx, by, bk] = [px, py, pk, cx, cy, ck];
            if ((pCut || cCut) && this.section) {
              // A segment crossing the section plane keeps its part on the kept side.
              const kept = clipByPlane([pq, q], this.section);
              const s0 = kept[0] ? cam.project(kept[0]) : null;
              const s1 = kept[1] ? cam.project(kept[1]) : null;
              if (s0 && s1) [ax, ay, ak, bx, by, bk] = [s0.x, s0.y, key(s0.depth), s1.x, s1.y, key(s1.depth)];
            }
            if (allVisible) emit(ax, ay, bx, by);
            else visibleRuns(f!, ax, ay, ak, bx, by, bk, perspective ? tolRel : 0, perspective ? 0 : tolAbs, emit);
          }
          px = cx;
          py = cy;
          pk = ck;
          pq = q;
          pBehind = cBehind;
          pCut = cCut;
        }
      });
    });
    this.rasterValid = true;
  }

  /** Colors from the id buffer: per-triangle shading level + face state (hover/selected). */
  private colorize(): void {
    const f = this.frame;
    if (!f) return;
    const faceState = new Uint8Array(this.faces.length);
    const hoverBody = this.hover?.body;
    const hoverWholeBody = !!this.hover && !this.hover.face && !this.hover.edge;
    this.faces.forEach((face, i) => {
      const bodyName = this.bodies[face.body]!.name;
      let s = this.selFaces.has(`${bodyName}\u0000${face.name}`) ? 2 : 0;
      if (hoverBody === bodyName && (hoverWholeBody || this.hover?.face === face.name)) s += 1;
      faceState[i] = s;
    });
    const palettes = this.bodies.map((b) => this.palette(b.color));
    const triColor = new Uint32Array(this.triCount);
    for (let t = 0; t < this.triCount; t++) {
      const fi = this.triFaceGlobal[t]!;
      const pal = palettes[this.faces[fi]!.body]!;
      triColor[t] = pal[faceState[fi]! * LEVELS + f.level[t]!]!;
    }
    const { ids, pixels } = f;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      pixels[i] = id < 0 ? 0 : triColor[id]!;
    }
    this.bg.putImageData(f.image, 0, 0);
  }

  private composite(): void {
    const f = this.frame;
    const g = this.g;
    const { width: w, height: h } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.globalAlpha = 1;
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, this.colors.background);
    grad.addColorStop(1, this.colors.backgroundBottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const cam = f?.cam ?? cameraFrame(this.cam, w, h);
    if (this.display.grid) this.drawGrid(cam);
    if (!f) return;
    if (this.display.mode !== "wireframe") {
      g.imageSmoothingEnabled = true;
      g.globalAlpha = this.display.mode === "xray" ? 0.35 : 1;
      g.drawImage(this.buffer, 0, 0, f.w, f.h, 0, 0, w, h);
      g.globalAlpha = 1;
    }

    // Edges (visible runs), then highlighted ones on top.
    const hoverEdge = this.hover?.edge;
    const hoverBody = this.hover?.body;
    g.lineCap = "round";
    const stroke = (runs: EdgeRun[], color: string, width: number): void => {
      if (runs.length === 0) return;
      g.beginPath();
      for (const r of runs) {
        g.moveTo(r.x0, r.y0);
        g.lineTo(r.x1, r.y1);
      }
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke();
    };
    const plain: EdgeRun[] = [];
    const selected: EdgeRun[] = [];
    const hovered: EdgeRun[] = [];
    for (const r of f.edgeRuns) {
      const body = this.bodies[r.body]!;
      const name = body.edges[r.edge]!.name;
      if (hoverBody === body.name && hoverEdge === name) hovered.push(r);
      else if (this.selEdges.has(`${body.name}\u0000${name}`)) selected.push(r);
      else plain.push(r);
    }
    const showPlain = this.display.mode !== "shaded";
    const edgeColor = this.display.mode === "wireframe" || this.display.mode === "xray" ? this.colors.text : this.colors.edge;
    if (showPlain) stroke(plain, edgeColor, 1.1);
    stroke(selected, this.colors.accent, 2.4);
    stroke(hovered, this.colors.hover, 2.4);
    if (this.display.axes) this.drawTriad(cam);
  }

  private drawGrid(cam: CameraFrame): void {
    const g = this.g;
    const radius = this.bounds ? Math.max(this.bounds.radius, 5) : 50;
    const step = niceStep(radius / 4);
    const half = Math.ceil((radius * 2.2) / step) * step;
    const cx = this.bounds ? Math.round(this.bounds.center[0] / step) * step : 0;
    const cy = this.bounds ? Math.round(this.bounds.center[1] / step) * step : 0;
    const near = this.cam.distance * 1e-3;
    const line = (p: Vec3, q: Vec3, color: string, width: number): void => {
      const a = cam.project(p);
      const b = cam.project(q);
      if (!a || !b || (this.cam.projection === "perspective" && (a.depth < near || b.depth < near))) return;
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke();
    };
    const n = Math.round(half / step);
    for (let i = -n; i <= n; i++) {
      const major = Math.round((cx + i * step) / step) % 5 === 0;
      line([cx + i * step, cy - half, 0], [cx + i * step, cy + half, 0], major ? this.colors.gridMajor : this.colors.grid, 1);
      const majorY = Math.round((cy + i * step) / step) % 5 === 0;
      line([cx - half, cy + i * step, 0], [cx + half, cy + i * step, 0], majorY ? this.colors.gridMajor : this.colors.grid, 1);
    }
    // World axes through the origin.
    line([cx - half, 0, 0], [cx + half, 0, 0], "rgba(229,83,75,0.45)", 1.2);
    line([0, cy - half, 0], [0, cy + half, 0], "rgba(87,171,90,0.45)", 1.2);
  }

  private drawTriad(cam: CameraFrame): void {
    const g = this.g;
    const { right, up } = cam.basis;
    const ox = 40, oy = this.height - 40, len = 24;
    const axes: Array<[Vec3, string, string]> = [
      [[1, 0, 0], "#e5534b", "X"],
      [[0, 1, 0], "#57ab5a", "Y"],
      [[0, 0, 1], "#539bf5", "Z"],
    ];
    g.font = "600 10px ui-sans-serif, system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const [axis, color, label] of axes) {
      const dx = dot(axis, right) * len;
      const dy = -dot(axis, up) * len;
      g.beginPath();
      g.moveTo(ox, oy);
      g.lineTo(ox + dx, oy + dy);
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = color;
      g.fillText(label, ox + dx * 1.35, oy + dy * 1.35);
    }
  }
}

// ─── Edge visibility ─────────────────────────────────────────────────────────────────────────

/**
 * Split a screen-space segment (CSS px, depth keys at the ends) into runs not hidden by nearer
 * surfaces. A sample is visible when some pixel of its 3×3 neighbourhood is not nearer than the
 * edge (edges lie on the boundary of the faces they bound).
 */
function visibleRuns(
  f: Frame,
  x0: number,
  y0: number,
  k0: number,
  x1: number,
  y1: number,
  k1: number,
  tolRel: number,
  tolAbs: number,
  emit: (x0: number, y0: number, x1: number, y1: number) => void,
): void {
  const s = f.scale;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * s));
  if (steps > 20_000) return;
  let runStart = -1;
  const at = (t: number): [number, number] => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const [x, y] = at(t);
    const k = k0 + (k1 - k0) * t;
    const tol = tolRel ? Math.abs(k) * tolRel : tolAbs;
    const bx = Math.floor(x * s);
    const by = Math.floor(y * s);
    let visible = false;
    for (let dy = -1; dy <= 1 && !visible; dy++) {
      const yy = by + dy;
      if (yy < 0 || yy >= f.h) {
        visible = true;
        break;
      }
      for (let dx = -1; dx <= 1; dx++) {
        const xx = bx + dx;
        if (xx < 0 || xx >= f.w || f.depth[yy * f.w + xx]! <= k + tol) {
          visible = true;
          break;
        }
      }
    }
    if (visible && runStart < 0) runStart = i;
    if ((!visible || i === steps) && runStart >= 0) {
      const end = visible ? i : i - 1;
      if (end > runStart || steps === 1) {
        const [ax, ay] = at(runStart / steps);
        const [bx2, by2] = at(end / steps);
        emit(ax, ay, bx2, by2);
      }
      runStart = -1;
    }
  }
}

// ─── Geometry helpers ────────────────────────────────────────────────────────────────────────

/**
 * The part of a convex polygon on the kept side of a section plane (Sutherland–Hodgman against
 * one plane; the side the normal points to is removed).
 */
export function clipByPlane(poly: readonly Vec3[], plane: SectionPlane): Vec3[] {
  const n = plane.normal;
  const k = dot(n, plane.origin);
  const d = (q: Vec3): number => dot(n, q) - k;
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!;
    const next = poly[(i + 1) % poly.length]!;
    const dc = d(cur);
    const dn = d(next);
    if (dc <= 0) out.push(cur);
    if ((dc < 0 && dn > 0) || (dc > 0 && dn < 0)) {
      const t = dc / (dc - dn);
      out.push([cur[0] + (next[0] - cur[0]) * t, cur[1] + (next[1] - cur[1]) * t, cur[2] + (next[2] - cur[2]) * t]);
    }
  }
  return out;
}

function prepare(b: RenderBody, bodyIndex: number, faces: Array<{ body: number; name: string }>, faceIndex: Map<string, number>): PreparedBody {
  const triCount = Math.floor(b.indices.length / 3);
  const triFace = new Int32Array(triCount);
  const faceOf = (name: string): number => {
    const key = `${bodyIndex}\u0000${name}`;
    let fi = faceIndex.get(key);
    if (fi === undefined) {
      fi = faces.length;
      faces.push({ body: bodyIndex, name });
      faceIndex.set(key, fi);
    }
    return fi;
  };
  const fallback = b.faceRanges.length === 0 && triCount > 0 ? faceOf(b.name) : -1;
  triFace.fill(fallback);
  for (const r of b.faceRanges) {
    const fi = faceOf(r.face);
    for (let t = r.start; t < r.start + r.count && t < triCount; t++) triFace[t] = fi;
  }
  for (let t = 0; t < triCount; t++) if (triFace[t]! < 0) triFace[t] = faceOf(b.name);

  const p = b.positions;
  const triNormal = new Float32Array(triCount * 3);
  let signedVolume = 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = b.indices[t * 3]!, i1 = b.indices[t * 3 + 1]!, i2 = b.indices[t * 3 + 2]!;
    const v0x = p[i0 * 3]!, v0y = p[i0 * 3 + 1]!, v0z = p[i0 * 3 + 2]!;
    const v1x = p[i1 * 3]!, v1y = p[i1 * 3 + 1]!, v1z = p[i1 * 3 + 2]!;
    const v2x = p[i2 * 3]!, v2y = p[i2 * 3 + 1]!, v2z = p[i2 * 3 + 2]!;
    signedVolume += v0x * (v1y * v2z - v1z * v2y) - v0y * (v1x * v2z - v1z * v2x) + v0z * (v1x * v2y - v1y * v2x);
    const u = normalize([
      (v1y - v0y) * (v2z - v0z) - (v1z - v0z) * (v2y - v0y),
      (v1z - v0z) * (v2x - v0x) - (v1x - v0x) * (v2z - v0z),
      (v1x - v0x) * (v2y - v0y) - (v1y - v0y) * (v2x - v0x),
    ]);
    triNormal[t * 3] = u[0];
    triNormal[t * 3 + 1] = u[1];
    triNormal[t * 3 + 2] = u[2];
  }
  // Inside-out mesh (negative volume): flip normals so culling and shading stay right.
  if (signedVolume < 0) for (let i = 0; i < triNormal.length; i++) triNormal[i] = -triNormal[i]!;

  return {
    name: b.name,
    positions: p,
    indices: b.indices,
    triFace,
    triNormal,
    edges: b.edges.map((e) => ({ name: e.edge, points: e.points })),
    color: b.color ?? null,
  };
}

function computeBounds(bodies: PreparedBody[]): { center: Vec3; radius: number } | null {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const b of bodies) {
    const p = b.positions;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]!); maxX = Math.max(maxX, p[i]!);
      minY = Math.min(minY, p[i + 1]!); maxY = Math.max(maxY, p[i + 1]!);
      minZ = Math.min(minZ, p[i + 2]!); maxZ = Math.max(maxZ, p[i + 2]!);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return sphereFromBox([minX, minY, minZ], [maxX, maxY, maxZ]);
}

function segmentParam(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  return len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
}

function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const t = segmentParam(px, py, x0, y0, x1, y1);
  return Math.hypot(px - (x0 + t * (x1 - x0)), py - (y0 + t * (y1 - y0)));
}

export type { DisplayMode };
