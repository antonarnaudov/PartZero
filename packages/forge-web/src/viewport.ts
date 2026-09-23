/**
 * `Viewport`: forge-render on a canvas, with on-demand rendering, CAD mouse controls,
 * hover/selection, section plane and picking. All coordinates are CSS pixels relative to
 * the canvas; the device-pixel ratio is applied here.
 */
import * as raw from "../pkg/forge_wasm.js";
import { forgeError, init, irText } from "./engine.js";
import type {
  Backend,
  CameraState,
  ControlsOptions,
  DisplayOptions,
  EntityRef,
  ForgeError,
  EvaluateOptions,
  IrInput,
  LoadResult,
  PickResult,
  Projection,
  RenderBody,
  SectionPlane,
  StandardView,
  ViewportEvent,
  ViewportOptions,
  ViewportStats,
} from "./types.js";

type Canvas = HTMLCanvasElement | OffscreenCanvas;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

function isHtmlCanvas(c: Canvas): c is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== "undefined" && c instanceof HTMLCanvasElement;
}

function requestFrame(cb: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
  else setTimeout(cb, 16);
}

interface RawPick {
  kind: PickResult["kind"];
  body: string;
  bodyIndex: number;
  face: string | null;
  faceIndex: number | null;
  edge: string | null;
  edgeIndex: number | null;
  point: [number, number, number] | null;
  pixel: [number, number];
}

type Drag = { mode: "orbit" | "pan"; x: number; y: number; startX: number; startY: number; moved: boolean; id: number };

/** Pointer travel (CSS px) below which a press–release counts as a click. */
const CLICK_SLOP = 4;

/**
 * Normalise anything thrown by the WASM bindings into a {@link ForgeError}: errors that
 * already carry a string `code` (e.g. `RENDER_NO_ADAPTER`, `RENDER_CANVAS`) pass through
 * unchanged; a WebAssembly trap becomes `FORGE_WASM_TRAP`; anything else gets `fallback`.
 */
export function asForgeError(e: unknown, fallback: string): ForgeError {
  if (e instanceof Error && typeof (e as Partial<ForgeError>).code === "string") return e as ForgeError;
  if (typeof WebAssembly !== "undefined" && e instanceof WebAssembly.RuntimeError) {
    const err = forgeError("FORGE_WASM_TRAP", `the Forge WASM module trapped: ${e.message}`);
    (err as Error & { cause?: unknown }).cause = e;
    return err;
  }
  const message = e instanceof Error ? e.message : String(e);
  const err = forgeError(fallback, message);
  (err as Error & { cause?: unknown }).cause = e;
  return err;
}

// Minimal structural WebGPU types for the probe (the package does not depend on
// @webgpu/types).
interface ProbeBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface ProbeDevice {
  createBuffer(d: { size: number; usage: number }): ProbeBuffer;
  createCommandEncoder(): { copyBufferToBuffer(a: ProbeBuffer, ao: number, b: ProbeBuffer, bo: number, n: number): void; finish(): unknown };
  queue: { writeBuffer(b: ProbeBuffer, offset: number, data: Uint32Array): void; submit(c: unknown[]): void };
  pushErrorScope(filter: string): void;
  popErrorScope(): Promise<{ message: string } | null>;
  destroy(): void;
}
interface ProbeGpu {
  requestAdapter(o?: { powerPreference?: string }): Promise<{ requestDevice(): Promise<ProbeDevice> } | null>;
}

/** WebGPU buffer usage / map-mode bits (WebGPU spec constants). */
const MAP_READ = 0x0001;
const COPY_SRC = 0x0004;
const COPY_DST = 0x0008;
const MAP_MODE_READ = 0x0001;
/** How long each probe step may take before the device is called broken. */
const PROBE_TIMEOUT_MS = 3000;

/** `p`, or a rejection after {@link PROBE_TIMEOUT_MS} (a late rejection of `p` is ignored). */
async function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  p.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not complete in ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The device check's verdict, per `navigator.gpu` object. */
let webgpuHealth: { gpu: ProbeGpu; verdict: Promise<ForgeError | null> } | null = null;

/**
 * Is the browser's WebGPU device fit for forge-render? Checked **before** a canvas is
 * committed to WebGPU, because a canvas keeps its first context type: WebGL2 is only
 * possible on a canvas WebGPU never touched.
 *
 * Audit V3: a broken adapter (Chromium's SwiftShader WebGPU with unsafe flags) created a
 * device whose buffer mappings failed — blank canvas, `RENDER_READBACK` on every pick —
 * and `backend: "auto"` never fell back to WebGL2. The probe uploads with
 * `writeBuffer`, copies, and maps a read-back buffer, the operations forge-render relies
 * on (scene uploads, pick read-back), inside a validation error scope.
 *
 * Resolves to `null` when the device is healthy **or** WebGPU is absent (forge-wasm then
 * falls back to WebGL2 itself), else to the reason (`RENDER_WEBGPU_UNHEALTHY`). Runs
 * once per `navigator.gpu`. The verdict only orders the attempts (see
 * {@link Viewport.create}); forge-wasm's own self-test of the device it would render with
 * is authoritative.
 */
export function probeWebGpu(): Promise<ForgeError | null> {
  const gpu = (globalThis as { navigator?: { gpu?: ProbeGpu | null } }).navigator?.gpu;
  if (!gpu) return Promise.resolve(null);
  if (webgpuHealth?.gpu !== gpu) webgpuHealth = { gpu, verdict: checkWebGpu(gpu) };
  return webgpuHealth.verdict;
}

async function checkWebGpu(gpu: ProbeGpu): Promise<ForgeError | null> {
  const bad = (why: string) => forgeError("RENDER_WEBGPU_UNHEALTHY", `WebGPU device check failed: ${why}`);
  let device: ProbeDevice | null = null;
  try {
    const adapter = await withTimeout(gpu.requestAdapter({ powerPreference: "high-performance" }), "requestAdapter");
    if (!adapter) return null;
    device = await withTimeout(adapter.requestDevice(), "requestDevice");
    device.pushErrorScope("validation");
    const pattern = new Uint32Array([0x464f5247, 0x45524e44, 0x00c0ffee, 0xdeadbeef]);
    const src = device.createBuffer({ size: pattern.byteLength, usage: COPY_SRC | COPY_DST });
    const dst = device.createBuffer({ size: pattern.byteLength, usage: MAP_READ | COPY_DST });
    device.queue.writeBuffer(src, 0, pattern);
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(src, 0, dst, 0, pattern.byteLength);
    device.queue.submit([enc.finish()]);
    await withTimeout(dst.mapAsync(MAP_MODE_READ), "the read-back");
    const got = new Uint32Array(dst.getMappedRange().slice(0));
    dst.unmap();
    src.destroy();
    dst.destroy();
    const scope = await withTimeout(device.popErrorScope(), "popErrorScope");
    if (scope) return bad(`validation error: ${scope.message}`);
    if (got.length !== pattern.length || got.some((v, i) => v !== pattern[i])) return bad("read-back returned wrong data");
    return null;
  } catch (e) {
    return bad(e instanceof Error ? e.message : String(e));
  } finally {
    try {
      device?.destroy();
    } catch {
      // A broken device may throw on destroy too; nothing else holds it.
    }
  }
}

/**
 * `raw.createViewport` for `backend`, honouring the WebGPU device check (`probe`, set only
 * for `"auto"` when the check failed): WebGL2 is tried first, and WebGPU — decided by
 * forge-wasm's self-test of the real device — only when WebGL2 cannot start, so a slow
 * but working WebGPU (a check step over its time budget) is still used on a browser
 * without WebGL2. A failed WebGL2 context request leaves the canvas free for WebGPU.
 *
 * Rejects with a {@link ForgeError}; when no backend starts, `RENDER_NO_ADAPTER` whose
 * message lists every reason, the device check's included.
 */
async function createRaw(
  canvas: Canvas,
  backend: "auto" | Backend,
  probe: ForgeError | null,
  pw: number,
  ph: number,
  dpr: number,
): Promise<raw.RawViewport> {
  if (!probe) {
    try {
      return await raw.createViewport(canvas, backend, pw, ph, dpr);
    } catch (e) {
      throw asForgeError(e, "RENDER_INIT");
    }
  }
  const reasons = [probe.message];
  for (const b of ["webgl2", "webgpu"] as const) {
    try {
      return await raw.createViewport(canvas, b, pw, ph, dpr);
    } catch (e) {
      const err = asForgeError(e, "RENDER_INIT");
      if (err.code !== "RENDER_NO_ADAPTER") {
        // The canvas may hold a context now: stop, but keep why WebGPU was not used.
        const out = forgeError(err.code, `${err.message} (${reasons.join("; ")})`);
        (out as Error & { cause?: unknown }).cause = err;
        throw out;
      }
      reasons.push(err.message);
    }
  }
  const out = forgeError("RENDER_NO_ADAPTER", reasons.join("; "));
  (out as Error & { cause?: unknown }).cause = probe;
  throw out;
}

export class Viewport {
  readonly canvas: Canvas;
  #raw: raw.RawViewport;
  #dpr: number;
  #cssW: number;
  #cssH: number;
  #autoRender: boolean;
  #frameQueued = false;
  #disposed = false;
  #lastFrameMs = 0;
  #avgFrameMs = 0;
  #intervals: number[] = [];
  #lastFrameAt = 0;
  #drag: Drag | null = null;
  #listeners = new Set<(e: ViewportEvent) => void>();
  #selection: PickResult[] = [];
  #hover: PickResult | null = null;
  #hoverSeq = 0;
  #hoverBusy = false;
  #hoverPending: { x: number; y: number } | null = null;
  #controlsCleanup: (() => void) | null = null;
  #resizeObserver: ResizeObserver | null = null;
  #fallback: ForgeError | null;
  #fault: ForgeError | null = null;

  private constructor(
    r: raw.RawViewport,
    canvas: Canvas,
    cssW: number,
    cssH: number,
    dpr: number,
    autoRender: boolean,
    fallback: ForgeError | null,
  ) {
    this.#raw = r;
    this.canvas = canvas;
    this.#cssW = cssW;
    this.#cssH = cssH;
    this.#dpr = dpr;
    this.#autoRender = autoRender;
    this.#fallback = fallback;
  }

  /**
   * Create a viewport on `canvas` (an `HTMLCanvasElement`, or an `OffscreenCanvas` — then
   * pass `width`/`height`). Loads the WASM module if needed. With `backend: "auto"`,
   * WebGPU is used when the browser offers an adapter whose device passes a read-back
   * check ({@link probeWebGpu}) and forge-wasm's self-test (a frame and a pick read-back
   * before the canvas is committed), else WebGL2 ({@link Viewport.backendFallback} says
   * why). When the check fails, WebGL2 is tried first and WebGPU only if WebGL2 cannot
   * start.
   *
   * Rejects with a {@link ForgeError}: `RENDER_NO_ADAPTER` when no backend could start
   * (the message lists each backend's reason, the device check's included), `RENDER_GPU`
   * when the device faulted setting up the canvas or drawing the first frame,
   * `RENDER_CANVAS`, `RENDER_BACKEND`, `RENDER_SURFACE`, `FORGE_WASM_TRAP` if the module
   * trapped, else `RENDER_INIT`.
   */
  static async create(canvas: Canvas, options: ViewportOptions = {}): Promise<Viewport> {
    await init(options.wasm);
    const dpr = options.devicePixelRatio ?? (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? 1;
    let cssW = options.width;
    let cssH = options.height;
    if (isHtmlCanvas(canvas)) {
      cssW ??= canvas.clientWidth || canvas.width / dpr;
      cssH ??= canvas.clientHeight || canvas.height / dpr;
    } else {
      cssW ??= canvas.width / dpr;
      cssH ??= canvas.height / dpr;
    }
    cssW = Math.max(1, cssW);
    cssH = Math.max(1, cssH);
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    canvas.width = pw;
    canvas.height = ph;
    const backend = options.backend ?? "auto";
    // Decide before the canvas gets any context (see probeWebGpu).
    const probe = backend === "auto" ? await probeWebGpu() : null;
    const r = await createRaw(canvas, backend, probe, pw, ph, dpr);
    let fallback: ForgeError | null = null;
    if (backend === "auto" && r.backend() === "webgl2") {
      const why = r.backendFallback();
      fallback = probe ?? (why ? forgeError("RENDER_WEBGPU_UNHEALTHY", why) : null);
    }
    const vp = new Viewport(r, canvas, cssW, cssH, dpr, options.autoRender ?? true, fallback);
    // WebGPU reports some faults after the call that caused them returned.
    r.onGpuFault((e: unknown) => {
      if (vp.#disposed || vp.#fault) return;
      vp.#unhandled(vp.#noteFault(asForgeError(e, "RENDER_GPU")));
    });
    if (options.display) vp.setDisplayOptions(options.display);
    if ((options.autoResize ?? true) && isHtmlCanvas(canvas) && typeof ResizeObserver !== "undefined") {
      vp.#resizeObserver = new ResizeObserver(() => {
        if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
          vp.resize(canvas.clientWidth, canvas.clientHeight, (globalThis as { devicePixelRatio?: number }).devicePixelRatio ?? vp.#dpr);
        }
      });
      vp.#resizeObserver.observe(canvas);
    }
    vp.requestRender();
    return vp;
  }

  // ---- Scene -------------------------------------------------------------------------

  /** Replace the scene with `evaluate(...).bodies`. Keeps the camera (the first scene is framed). */
  setBodies(bodies: RenderBody[]): void {
    this.#live();
    try {
      this.#raw.setBodies(bodies);
    } catch (e) {
      throw this.#noteFault(asForgeError(e, "RENDER_BODY"));
    }
    this.requestRender();
  }

  /**
   * Evaluate + tessellate + upload in one call on this thread, without copying meshes
   * through JS (the fastest path for interactive edits). Additive to the core contract.
   */
  loadIr(ir: IrInput, options: EvaluateOptions = {}): LoadResult {
    this.#live();
    let r: LoadResult;
    try {
      r = this.#raw.loadIr(
        irText(ir),
        options.chordalDeflection,
        options.angularDeflection,
        options.reportVersion,
      ) as LoadResult;
    } catch (e) {
      throw this.#noteFault(asForgeError(e, "RENDER_LOAD"));
    }
    this.requestRender();
    return r;
  }

  // ---- Picking, hover, selection -----------------------------------------------------

  /**
   * What is under CSS pixel `(x, y)`: the face under the cursor (pixel-exact), or an edge
   * within the snapping radius, or a section cap; `null` for the background.
   */
  async pick(x: number, y: number): Promise<PickResult | null> {
    this.#live();
    let p: RawPick | null;
    try {
      p = (await this.#raw.pick(x * this.#dpr, y * this.#dpr)) as RawPick | null;
    } catch (e) {
      throw this.#noteFault(asForgeError(e, "RENDER_PICK"));
    }
    if (!p) return null;
    return { ...p, pixel: [p.pixel[0] / this.#dpr, p.pixel[1] / this.#dpr] };
  }

  /** Highlight one entity (face tint / thicker edge); `null` clears. */
  setHover(entity: EntityRef | null): void {
    this.#live();
    this.#raw.setHover(entity ?? null);
    this.requestRender();
  }

  /** Replace the selection highlight. Returns how many entities resolved in the current scene. */
  setSelection(entities: EntityRef[]): number {
    this.#live();
    const n = this.#raw.setSelection(entities);
    this.requestRender();
    return n;
  }

  // ---- View ----------------------------------------------------------------------------

  /** Cut the model with a plane (the side the normal points to is removed); `null` removes it. */
  setSectionPlane(plane: SectionPlane | null): void {
    this.#live();
    if (plane) {
      const [ox, oy, oz] = plane.origin;
      const [nx, ny, nz] = plane.normal;
      this.#raw.setSection(ox, oy, oz, nx, ny, nz);
    } else {
      this.#raw.clearSection();
    }
    this.requestRender();
  }

  /** Frame the whole scene. */
  fitView(): void {
    this.#live();
    this.#raw.fitView();
    this.requestRender();
  }

  /** Standard view (and fit). */
  setView(view: StandardView): void {
    this.#live();
    this.#raw.setView(view);
    this.requestRender();
  }

  setProjection(projection: Projection): void {
    this.#live();
    this.#raw.setProjection(projection);
    this.requestRender();
  }

  projection(): Projection {
    return this.#raw.projection() as Projection;
  }

  /** Orbit by a pointer motion (CSS px). */
  orbit(dx: number, dy: number): void {
    this.#raw.orbit(dx * this.#dpr, dy * this.#dpr);
    this.requestRender();
  }

  /** Pan by a pointer motion (CSS px). */
  pan(dx: number, dy: number): void {
    this.#raw.pan(dx * this.#dpr, dy * this.#dpr);
    this.requestRender();
  }

  /** Zoom by `factor` (< 1 zooms in) keeping the point under CSS pixel `(x, y)` fixed. */
  zoomAt(x: number, y: number, factor: number): void {
    this.#raw.zoomAt(x * this.#dpr, y * this.#dpr, factor);
    this.requestRender();
  }

  cameraState(): CameraState {
    return this.#raw.cameraState() as CameraState;
  }

  setCameraState(state: Partial<CameraState>): void {
    this.#raw.setCameraState(state);
    this.requestRender();
  }

  setDisplayOptions(options: DisplayOptions): void {
    this.#live();
    this.#raw.setOptions(options);
    this.requestRender();
  }

  /** `"webgpu"` or `"webgl2"`. */
  backend(): Backend {
    return this.#raw.backend() as Backend;
  }

  /**
   * Why `backend: "auto"` chose WebGL2 although the browser offers WebGPU
   * (`RENDER_WEBGPU_UNHEALTHY`: the device failed {@link probeWebGpu}); `null` otherwise.
   */
  backendFallback(): ForgeError | null {
    return this.#fallback;
  }

  /**
   * The first GPU fault of the device (`RENDER_GPU`: a validation, out-of-memory or
   * internal error, or a lost device), or `null` while it is healthy. A faulted viewport
   * draws and picks nothing: {@link Viewport.render}, {@link Viewport.pick},
   * {@link Viewport.setBodies} and {@link Viewport.loadIr} throw the fault, automatic
   * rendering stops, and the fault is emitted once as an `error` event (or, with no
   * listener, thrown asynchronously) — it is never silent.
   *
   * Reads the device's own record too, so a fault no call has reported yet (a WebGPU
   * error from {@link Viewport.resize}'s texture recreation, a lost device) is returned
   * — and emitted — at once rather than at the next render, pick or upload.
   */
  gpuFault(): ForgeError | null {
    if (!this.#fault && !this.#disposed) {
      const f: unknown = this.#raw.gpuFault();
      if (f) this.#noteFault(asForgeError(f, "RENDER_GPU"));
    }
    return this.#fault;
  }

  // ---- Size and frames -------------------------------------------------------------------

  /** Resize to `width × height` CSS px at device-pixel ratio `dpr` (default: unchanged). */
  resize(width: number, height: number, dpr: number = this.#dpr): void {
    this.#live();
    this.#cssW = Math.max(1, width);
    this.#cssH = Math.max(1, height);
    this.#dpr = dpr > 0 ? dpr : 1;
    const pw = Math.max(1, Math.round(this.#cssW * this.#dpr));
    const ph = Math.max(1, Math.round(this.#cssH * this.#dpr));
    if (this.canvas.width !== pw) this.canvas.width = pw;
    if (this.canvas.height !== ph) this.canvas.height = ph;
    this.#raw.resize(pw, ph, this.#dpr);
    // Render synchronously: the canvas was cleared by the size change. A faulted device
    // draws nothing (the fault was reported when it happened).
    if (!this.#fault) this.render();
  }

  /** Schedule one frame on the next animation frame (no-op with `autoRender: false`). */
  requestRender(): void {
    if (!this.#autoRender || this.#frameQueued || this.#disposed || this.#fault) return;
    this.#frameQueued = true;
    requestFrame(() => {
      this.#frameQueued = false;
      if (this.#disposed) return;
      try {
        this.render();
      } catch (e) {
        this.#unhandled(e);
      }
    });
  }

  /** Render and present one frame now. Throws `RENDER_GPU` once the device faulted. */
  render(): void {
    this.#live();
    const t0 = now();
    try {
      this.#raw.render();
    } catch (e) {
      throw this.#noteFault(asForgeError(e, "RENDER_FRAME"));
    }
    const t1 = now();
    this.#lastFrameMs = t1 - t0;
    this.#avgFrameMs = this.#avgFrameMs === 0 ? this.#lastFrameMs : this.#avgFrameMs * 0.9 + this.#lastFrameMs * 0.1;
    if (this.#lastFrameAt > 0 && t1 - this.#lastFrameAt < 250) {
      this.#intervals.push(t1 - this.#lastFrameAt);
      if (this.#intervals.length > 30) this.#intervals.shift();
    } else {
      this.#intervals = [];
    }
    this.#lastFrameAt = t1;
    if (this.#listeners.size > 0) this.#emit({ type: "frame", stats: this.stats() });
  }

  /** Scene counters and frame timing. */
  stats(): ViewportStats {
    const s = this.#raw.stats() as Omit<ViewportStats, "lastFrameMs" | "avgFrameMs" | "frameIntervalMs">;
    const iv = this.#intervals;
    return {
      ...s,
      lastFrameMs: this.#lastFrameMs,
      avgFrameMs: this.#avgFrameMs,
      frameIntervalMs: iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : 0,
    };
  }

  /** Release GPU resources and listeners. The viewport cannot be used afterwards. */
  dispose(): void {
    if (this.#disposed) return;
    this.#controlsCleanup?.();
    this.#resizeObserver?.disconnect();
    this.#listeners.clear();
    this.#disposed = true;
    this.#raw.onGpuFault(undefined);
    this.#raw.free();
  }

  // ---- Events and controls ---------------------------------------------------------------

  /** Subscribe to hover / select / frame events; returns the unsubscribe function. */
  on(listener: (e: ViewportEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The selection made through {@link attachControls} clicks. */
  selection(): PickResult[] {
    return [...this.#selection];
  }

  /** Pointer-down handler (CSS px from `offsetX/offsetY`). */
  onPointerDown(e: PointerEvent, options: ControlsOptions = {}): void {
    const leftMode = options.leftDrag ?? "orbit";
    const mode: Drag["mode"] =
      e.button === 1 || (e.button === 0 && e.shiftKey && leftMode === "orbit") ? "pan" : e.button === 2 ? "orbit" : leftMode;
    this.#drag = { mode, x: e.offsetX, y: e.offsetY, startX: e.offsetX, startY: e.offsetY, moved: false, id: e.pointerId };
    (e.target as Element | null)?.setPointerCapture?.(e.pointerId);
  }

  /** Pointer-move handler: drags orbit/pan; free moves update the hover (if enabled). */
  onPointerMove(e: PointerEvent, options: ControlsOptions = {}): void {
    const d = this.#drag;
    if (d && d.id === e.pointerId) {
      const dx = e.offsetX - d.x;
      const dy = e.offsetY - d.y;
      d.x = e.offsetX;
      d.y = e.offsetY;
      if (!d.moved && Math.hypot(e.offsetX - d.startX, e.offsetY - d.startY) < CLICK_SLOP) return;
      d.moved = true;
      if (d.mode === "orbit") this.orbit(dx, dy);
      else this.pan(dx, dy);
      return;
    }
    if (options.hover ?? true) this.#queueHover(e.offsetX, e.offsetY);
  }

  /** Pointer-up handler: a click (no drag) selects when enabled. */
  onPointerUp(e: PointerEvent, options: ControlsOptions = {}): void {
    const d = this.#drag;
    this.#drag = null;
    (e.target as Element | null)?.releasePointerCapture?.(e.pointerId);
    if (!d || d.moved || e.button !== 0 || !(options.select ?? true) || this.#fault) return;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    void this.pick(e.offsetX, e.offsetY).then((p) => {
      if (this.#disposed) return;
      if (!p || p.kind === "section") {
        if (!additive) this.#selection = [];
      } else if (additive) {
        const i = this.#selection.findIndex((s) => sameEntity(s, p));
        if (i >= 0) this.#selection.splice(i, 1);
        else this.#selection.push(p);
      } else {
        this.#selection = [p];
      }
      this.setSelection(this.#selection);
      this.#emit({ type: "select", selection: this.selection(), pick: p });
    }, (err: unknown) => this.#unhandled(err));
  }

  /** Wheel handler: zoom to the cursor. */
  onWheel(e: WheelEvent): void {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    // Pinch gestures arrive as ctrl+wheel with small deltas.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    const factor = Math.exp(Math.max(-400, Math.min(400, e.deltaY * unit)) * k);
    this.zoomAt(e.offsetX, e.offsetY, factor);
  }

  /**
   * Wire the handlers to `target` (default: the canvas): left-drag orbit, shift+left or
   * middle drag pan, right-drag orbit, wheel zoom-to-cursor, hover highlight, click select.
   * Returns a function that removes the listeners. Calling it again replaces the wiring.
   */
  attachControls(target?: HTMLElement, options: ControlsOptions = {}): () => void {
    this.#controlsCleanup?.();
    const el = target ?? (isHtmlCanvas(this.canvas) ? this.canvas : null);
    if (!el) throw forgeError("RENDER_CONTROLS", "attachControls needs an element for an OffscreenCanvas");
    const down = (e: PointerEvent) => this.onPointerDown(e, options);
    const move = (e: PointerEvent) => this.onPointerMove(e, options);
    const up = (e: PointerEvent) => this.onPointerUp(e, options);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    const leave = () => {
      if (!this.#drag && (options.hover ?? true)) this.#setHoverPick(null);
    };
    const menu = (e: Event) => e.preventDefault();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("wheel", wheel, { passive: false });
    el.addEventListener("contextmenu", menu);
    const style = el.style;
    const touch = style.touchAction;
    style.touchAction = "none";
    const cleanup = () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("wheel", wheel);
      el.removeEventListener("contextmenu", menu);
      style.touchAction = touch;
      if (this.#controlsCleanup === cleanup) this.#controlsCleanup = null;
    };
    this.#controlsCleanup = cleanup;
    return cleanup;
  }

  // ---- internals -------------------------------------------------------------------------

  /** At most one hover pick in flight; the latest pointer position wins. */
  #queueHover(x: number, y: number): void {
    if (this.#fault) return;
    this.#hoverPending = { x, y };
    if (this.#hoverBusy) return;
    this.#hoverBusy = true;
    void (async () => {
      while (this.#hoverPending && !this.#disposed) {
        const { x: px, y: py } = this.#hoverPending;
        this.#hoverPending = null;
        const seq = ++this.#hoverSeq;
        // Hover is best effort (a failed read-back just highlights nothing), but a GPU
        // fault is reported.
        const p = await this.pick(px, py).catch((e: unknown) => {
          if ((e as Partial<ForgeError>).code === "RENDER_GPU") this.#unhandled(e);
          return null;
        });
        if (seq === this.#hoverSeq && !this.#drag) this.#setHoverPick(p);
      }
      this.#hoverBusy = false;
    })();
  }

  #setHoverPick(p: PickResult | null): void {
    const same = p === null ? this.#hover === null : this.#hover !== null && sameEntity(this.#hover, p);
    this.#hover = p;
    if (same) return;
    this.setHover(p && p.kind !== "section" ? p : null);
    this.#emit({ type: "hover", pick: p });
  }

  #emit(e: ViewportEvent): void {
    for (const l of this.#listeners) l(e);
  }

  /** Keep the first GPU fault and emit it once as an `error` event; returns `err`. */
  #noteFault(err: ForgeError): ForgeError {
    if (err.code === "RENDER_GPU" && !this.#fault && !this.#disposed) {
      this.#fault = err;
      this.#emit({ type: "error", error: err });
    }
    return err;
  }

  /**
   * A failure of work nobody awaits (a scheduled frame, a hover or click pick, a fault
   * WebGPU reported late). A GPU fault already reached the `error` listeners; anything
   * else — or a fault nobody listens to — is thrown asynchronously, so it is never
   * swallowed.
   */
  #unhandled(e: unknown): void {
    const err = asForgeError(e, "RENDER_INIT");
    if (err.code === "RENDER_GPU" && this.#listeners.size > 0) return;
    queueMicrotask(() => {
      throw err;
    });
  }

  #live(): void {
    if (this.#disposed) throw forgeError("RENDER_DISPOSED", "the viewport was disposed");
  }
}

function sameEntity(a: PickResult, b: PickResult): boolean {
  return a.kind === b.kind && a.body === b.body && a.face === b.face && a.edge === b.edge;
}
