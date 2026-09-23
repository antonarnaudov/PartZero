/**
 * The placeholder viewport: a small software renderer on a Canvas 2D, used until
 * `@aicad/forge-web` is available.
 *
 * - Faces are rasterized into a depth buffer and a triangle-id buffer (flat shading, headlight),
 *   so occlusion is correct and picking is pixel-exact: the id under the cursor names the face.
 * - B-rep edge polylines are depth-tested against that buffer and drawn as anti-aliased lines;
 *   the visible runs are kept for edge picking.
 * - Hover/selection only recolor the existing id buffer (no re-rasterization).
 * - Orbit (drag), pan (right/middle/shift-drag), zoom (wheel, toward the cursor), double-click to
 *   fit. While the camera moves the buffer renders at 1× device pixels, then refines.
 */
import type { Projection, ViewName } from "../engine/forge-web-contract";
import type { PickResult, RenderBody } from "../engine/types";
import type { ViewportAdapter, ViewportColors } from "./adapter";
import {
  add,
  cross,
  defaultCamera,
  dot,
  fitDistance,
  MAX_PITCH,
  normalize,
  projector,
  scale,
  STANDARD_VIEWS,
  sub,
  type OrbitCamera,
  type Projector,
  type Vec3,
} from "./camera";

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
  projector: Projector;
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
  private camera: OrbitCamera = defaultCamera();
  private width = 1;
  private height = 1;
  private dpr = 1;
  private colors: ViewportColors = DEFAULT_VIEWPORT_COLORS;
  /** 4 variants (normal, hover, selected, selected+hover) × LEVELS packed colors. */
  private palette = new Uint32Array(4 * LEVELS);
  private hover: PickResult | null = null;
  private selFaces = new Set<string>();
  private selEdges = new Set<string>();
  private bounds: { center: Vec3; radius: number } | null = null;
  private frame: Frame | null = null;
  private rasterValid = false;
  private raf = 0;
  private interactiveUntil = 0;
  private refineTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private readonly cleanups: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const g = canvas.getContext("2d", { alpha: false });
    if (!g) throw new Error("Canvas 2D is not available");
    this.g = g;
    this.buffer = document.createElement("canvas");
    const bg = this.buffer.getContext("2d");
    if (!bg) throw new Error("Canvas 2D is not available");
    this.bg = bg;
    this.buildPalette();
    this.attachControls();
  }

  backend(): string {
    return "Canvas 2D";
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

  setHover(p: PickResult | null): void {
    this.hover = p;
    this.invalidate(false);
  }

  setSelection(picks: PickResult[]): void {
    this.selFaces = new Set(picks.filter((p) => p.face).map((p) => `${p.body}\u0000${p.face}`));
    this.selEdges = new Set(picks.filter((p) => p.edge && !p.face).map((p) => `${p.body}\u0000${p.edge}`));
    this.invalidate(false);
  }

  setColors(colors: ViewportColors): void {
    this.colors = colors;
    this.buildPalette();
    this.invalidate(false);
  }

  // ─── Camera ────────────────────────────────────────────────────────────────────────────────

  fitView(): void {
    if (!this.bounds) return;
    this.camera = {
      ...this.camera,
      target: this.bounds.center,
      distance: fitDistance(this.bounds.radius, this.camera.fov, this.width / this.height),
    };
    this.invalidate(true);
  }

  setView(v: ViewName): void {
    this.camera = { ...this.camera, ...STANDARD_VIEWS[v] };
    this.fitView();
    this.invalidate(true);
  }

  setProjection(p: Projection): void {
    this.camera = { ...this.camera, projection: p };
    this.invalidate(true);
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

  // ─── Picking ───────────────────────────────────────────────────────────────────────────────

  pick(x: number, y: number): Promise<PickResult | null> {
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
    if (best) {
      const body = this.bodies[best.body]!;
      return Promise.resolve({ body: body.name, edge: body.edges[best.edge]!.name });
    }
    const bx = Math.floor(x * f.scale);
    const by = Math.floor(y * f.scale);
    if (bx < 0 || by < 0 || bx >= f.w || by >= f.h) return Promise.resolve(null);
    const id = f.ids[by * f.w + bx]!;
    if (id < 0) return Promise.resolve(null);
    const face = this.faces[this.triFaceGlobal[id]!]!;
    return Promise.resolve({ body: this.bodies[face.body]!.name, face: face.name });
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.refineTimer);
    for (const c of this.cleanups) c();
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

  /** Keep rendering at reduced resolution while the camera moves; refine when it stops. */
  private interacting(): void {
    this.interactiveUntil = performance.now() + 160;
    clearTimeout(this.refineTimer);
    this.refineTimer = setTimeout(() => this.invalidate(true), 180);
  }

  private buildPalette(): void {
    const body = parseColor(this.colors.body);
    const accent = parseColor(this.colors.accent);
    const hover = parseColor(this.colors.hover);
    const variants = [body, mix(body, hover, 0.45), mix(body, accent, 0.6), mix(mix(body, accent, 0.6), hover, 0.3)];
    variants.forEach((c, v) => {
      for (let l = 0; l < LEVELS; l++) this.palette[v * LEVELS + l] = pack(c, l / (LEVELS - 1));
    });
  }

  private render(): void {
    if (this.disposed) return;
    const t0 = performance.now();
    const targetScale = performance.now() < this.interactiveUntil ? Math.min(this.dpr, 1) : this.dpr;
    if (!this.rasterValid || !this.frame || this.frame.scale !== targetScale) this.raster(targetScale);
    this.colorize();
    this.composite();
    this.canvas.dataset["frameMs"] = (performance.now() - t0).toFixed(1);
  }

  /** Rasterize faces into depth + id buffers, and compute visible edge runs. */
  private raster(bufferScale: number): void {
    const w = Math.max(1, Math.round(this.width * bufferScale));
    const h = Math.max(1, Math.round(this.height * bufferScale));
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
        projector: projector(this.camera, this.width, this.height),
      };
      this.buffer.width = w;
      this.buffer.height = h;
    }
    f.scale = bufferScale;
    if (f.level.length !== this.triCount) f.level = new Uint8Array(this.triCount);
    f.depth.fill(-Infinity);
    f.ids.fill(-1);
    f.edgeRuns = [];
    const proj = projector(this.camera, this.width, this.height);
    f.projector = proj;
    this.frame = f;

    const b = proj.basis;
    const light = normalize(add(add(scale(b.forward, -0.75), scale(b.up, 0.55)), scale(b.right, -0.3)));
    const perspective = this.camera.projection === "perspective";
    const near = this.camera.distance * 1e-3;
    const out = { x: 0, y: 0, z: 0 };
    const key = (z: number): number => (perspective ? 1 / z : -z);
    const { depth, ids } = f;

    let triBase = 0;
    for (const body of this.bodies) {
      const p = body.positions;
      const n = p.length / 3;
      const sx = new Float32Array(n);
      const sy = new Float32Array(n);
      const sk = new Float32Array(n);
      const behind = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        proj.project([p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!], out);
        sx[i] = out.x * bufferScale;
        sy[i] = out.y * bufferScale;
        sk[i] = key(out.z);
        behind[i] = perspective && out.z < near ? 1 : 0;
      }
      const tris = body.triFace.length;
      for (let t = 0; t < tris; t++) {
        const a = body.indices[t * 3]!, c1 = body.indices[t * 3 + 1]!, c2 = body.indices[t * 3 + 2]!;
        const nx = body.triNormal[t * 3]!, ny = body.triNormal[t * 3 + 1]!, nz = body.triNormal[t * 3 + 2]!;
        f.level[triBase + t] = Math.round((0.36 + 0.64 * Math.max(0, nx * light[0] + ny * light[1] + nz * light[2])) * (LEVELS - 1));
        if (behind[a] || behind[c1] || behind[c2]) continue;
        const facing = perspective
          ? nx * (b.eye[0] - p[a * 3]!) + ny * (b.eye[1] - p[a * 3 + 1]!) + nz * (b.eye[2] - p[a * 3 + 2]!)
          : -(nx * b.forward[0] + ny * b.forward[1] + nz * b.forward[2]);
        if (facing <= 0) continue;
        rasterTriangle(depth, ids, w, h, sx[a]!, sy[a]!, sk[a]!, sx[c1]!, sy[c1]!, sk[c1]!, sx[c2]!, sy[c2]!, sk[c2]!, triBase + t);
      }
      triBase += tris;
    }

    // Edges: sample each segment per buffer pixel against the depth buffer.
    const tolRel = 0.003;
    const tolAbs = this.camera.distance * 0.003;
    this.bodies.forEach((body, bi) => {
      body.edges.forEach((e, ei) => {
        const pts = e.points;
        let px = 0, py = 0, pk = 0, pBehind = true;
        for (let k = 0; k * 3 < pts.length; k++) {
          proj.project([pts[k * 3]!, pts[k * 3 + 1]!, pts[k * 3 + 2]!], out);
          const cx = out.x, cy = out.y, ck = key(out.z), cBehind = perspective && out.z < near;
          if (k > 0 && !pBehind && !cBehind) {
            visibleRuns(f, px, py, pk, cx, cy, ck, perspective ? tolRel : 0, perspective ? 0 : tolAbs, (x0, y0, x1, y1) =>
              f.edgeRuns.push({ body: bi, edge: ei, x0, y0, x1, y1 }),
            );
          }
          px = cx;
          py = cy;
          pk = ck;
          pBehind = cBehind;
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
    this.faces.forEach((face, i) => {
      const bodyName = this.bodies[face.body]!.name;
      let s = this.selFaces.has(`${bodyName}\u0000${face.name}`) ? 2 : 0;
      if (hoverBody === bodyName && this.hover?.face === face.name) s += 1;
      faceState[i] = s;
    });
    const triColor = new Uint32Array(this.triCount);
    for (let t = 0; t < this.triCount; t++) triColor[t] = this.palette[faceState[this.triFaceGlobal[t]!]! * LEVELS + f.level[t]!]!;
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
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, this.colors.background);
    grad.addColorStop(1, this.colors.backgroundBottom);
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    const proj = f?.projector ?? projector(this.camera, w, h);
    this.drawGrid(proj);
    if (!f) return;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.buffer, 0, 0, f.w, f.h, 0, 0, w, h);

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
    stroke(plain, this.colors.edge, 1.1);
    stroke(selected, this.colors.accent, 2.4);
    stroke(hovered, this.colors.hover, 2.4);
    this.drawTriad(proj);
  }

  private drawGrid(proj: Projector): void {
    const g = this.g;
    const radius = this.bounds ? Math.max(this.bounds.radius, 5) : 50;
    const step = niceStep(radius / 4);
    const half = Math.ceil((radius * 2.2) / step) * step;
    const cx = this.bounds ? Math.round(this.bounds.center[0] / step) * step : 0;
    const cy = this.bounds ? Math.round(this.bounds.center[1] / step) * step : 0;
    const a = { x: 0, y: 0, z: 0 };
    const b = { x: 0, y: 0, z: 0 };
    const near = this.camera.distance * 1e-3;
    const line = (p: Vec3, q: Vec3, color: string, width: number): void => {
      proj.project(p, a);
      proj.project(q, b);
      if (this.camera.projection === "perspective" && (a.z < near || b.z < near)) return;
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

  private drawTriad(proj: Projector): void {
    const g = this.g;
    const { right, up } = proj.basis;
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

  // ─── Controls ──────────────────────────────────────────────────────────────────────────────

  private attachControls(): void {
    const c = this.canvas;
    let drag: { id: number; x: number; y: number; mode: "orbit" | "pan" } | null = null;
    const down = (e: PointerEvent): void => {
      if (drag) return;
      const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
      if (e.button !== 0 && !pan) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mode: pan ? "pan" : "orbit" };
      c.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (dx === 0 && dy === 0) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const cam = this.camera;
      if (drag.mode === "orbit") {
        this.camera = {
          ...cam,
          yaw: cam.yaw - dx * 0.008,
          pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, cam.pitch + dy * 0.008)),
        };
      } else {
        const { right, up } = projector(cam, this.width, this.height).basis;
        const wpp = (2 * cam.distance * Math.tan(cam.fov / 2)) / this.height;
        this.camera = { ...cam, target: add(cam.target, add(scale(right, -dx * wpp), scale(up, dy * wpp))) };
      }
      this.interacting();
      this.invalidate(true);
    };
    const up = (e: PointerEvent): void => {
      if (drag && e.pointerId === drag.id) {
        drag = null;
        if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
      }
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      const cam = this.camera;
      const f = Math.exp(Math.max(-100, Math.min(100, e.deltaY)) * 0.0022);
      const rect = c.getBoundingClientRect();
      const mx = e.clientX - rect.left - this.width / 2;
      const my = e.clientY - rect.top - this.height / 2;
      const { right, up } = projector(cam, this.width, this.height).basis;
      const wpp = (2 * cam.distance * Math.tan(cam.fov / 2)) / this.height;
      // Keep the point under the cursor (on the target plane) fixed while zooming.
      const offset = add(scale(right, mx * wpp), scale(up, -my * wpp));
      const r = this.bounds?.radius ?? 100;
      const distance = Math.max(r * 0.02, Math.min(r * 200, cam.distance * f));
      const k = 1 - distance / cam.distance;
      this.camera = { ...cam, distance, target: add(cam.target, scale(offset, k)) };
      this.interacting();
      this.invalidate(true);
    };
    const dbl = (): void => this.fitView();
    const ctxMenu = (e: Event): void => e.preventDefault();
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("pointercancel", up);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("dblclick", dbl);
    c.addEventListener("contextmenu", ctxMenu);
    this.cleanups.push(() => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("pointercancel", up);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("dblclick", dbl);
      c.removeEventListener("contextmenu", ctxMenu);
    });
  }
}

// ─── Rasterization ───────────────────────────────────────────────────────────────────────────

/**
 * Fill one triangle into the depth/id buffers (pixel centers, edge functions). `k` is the depth
 * key (1/z for perspective, −z for orthographic): linear in screen space, larger = nearer.
 */
export function rasterTriangle(
  depth: Float32Array,
  ids: Int32Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  k0: number,
  x1: number,
  y1: number,
  k1: number,
  x2: number,
  y2: number,
  k2: number,
  id: number,
): void {
  let area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area === 0 || !Number.isFinite(area)) return;
  if (area < 0) {
    // Make the winding consistent so all three edge functions are positive inside.
    [x1, x2] = [x2, x1];
    [y1, y2] = [y2, y1];
    [k1, k2] = [k2, k1];
    area = -area;
  }
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(y0, y1, y2)));
  if (minX > maxX || minY > maxY) return;
  const inv = 1 / area;
  // Edge function coefficients: w_i(x, y) = A_i·x + B_i·y + C_i.
  const a0 = -(y2 - y1), b0 = x2 - x1, c0 = -(a0 * x1 + b0 * y1);
  const a1 = -(y0 - y2), b1 = x0 - x2, c1 = -(a1 * x2 + b1 * y2);
  const a2 = -(y1 - y0), b2 = x1 - x0, c2 = -(a2 * x0 + b2 * y0);
  for (let py = minY; py <= maxY; py++) {
    const cy = py + 0.5;
    let e0 = a0 * (minX + 0.5) + b0 * cy + c0;
    let e1 = a1 * (minX + 0.5) + b1 * cy + c1;
    let e2 = a2 * (minX + 0.5) + b2 * cy + c2;
    let i = py * w + minX;
    for (let px = minX; px <= maxX; px++, i++, e0 += a0, e1 += a1, e2 += a2) {
      if (e0 < 0 || e1 < 0 || e2 < 0) continue;
      const k = (e0 * k0 + e1 * k1 + e2 * k2) * inv;
      if (k > depth[i]!) {
        depth[i] = k;
        ids[i] = id;
      }
    }
  }
}

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
  const fallback = b.faceRanges.length === 0 ? faceOf(b.name) : -1;
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
    const v0: Vec3 = [p[i0 * 3]!, p[i0 * 3 + 1]!, p[i0 * 3 + 2]!];
    const v1: Vec3 = [p[i1 * 3]!, p[i1 * 3 + 1]!, p[i1 * 3 + 2]!];
    const v2: Vec3 = [p[i2 * 3]!, p[i2 * 3 + 1]!, p[i2 * 3 + 2]!];
    signedVolume += dot(v0, cross(v1, v2));
    const u = normalize(cross(sub(v1, v0), sub(v2, v0)));
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
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  const radius = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2, 1e-3);
  return { center, radius };
}

function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
