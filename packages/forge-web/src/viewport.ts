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
  IrInput,
  LoadResult,
  PickResult,
  Projection,
  RenderBody,
  SectionPlane,
  StandardView,
  TessellationOptions,
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

  private constructor(r: raw.RawViewport, canvas: Canvas, cssW: number, cssH: number, dpr: number, autoRender: boolean) {
    this.#raw = r;
    this.canvas = canvas;
    this.#cssW = cssW;
    this.#cssH = cssH;
    this.#dpr = dpr;
    this.#autoRender = autoRender;
  }

  /**
   * Create a viewport on `canvas` (an `HTMLCanvasElement`, or an `OffscreenCanvas` — then
   * pass `width`/`height`). Loads the WASM module if needed. With `backend: "auto"`,
   * WebGPU is used when the browser offers an adapter, else WebGL2.
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
    const r = await raw.createViewport(canvas, options.backend ?? "auto", pw, ph, dpr);
    const vp = new Viewport(r, canvas, cssW, cssH, dpr, options.autoRender ?? true);
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
    this.#raw.setBodies(bodies);
    this.requestRender();
  }

  /**
   * Evaluate + tessellate + upload in one call on this thread, without copying meshes
   * through JS (the fastest path for interactive edits). Additive to the core contract.
   */
  loadIr(ir: IrInput, options: TessellationOptions = {}): LoadResult {
    this.#live();
    const r = this.#raw.loadIr(irText(ir), options.chordalDeflection, options.angularDeflection) as LoadResult;
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
    const p = (await this.#raw.pick(x * this.#dpr, y * this.#dpr)) as RawPick | null;
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
    // Render synchronously: the canvas was cleared by the size change.
    this.render();
  }

  /** Schedule one frame on the next animation frame (no-op with `autoRender: false`). */
  requestRender(): void {
    if (!this.#autoRender || this.#frameQueued || this.#disposed) return;
    this.#frameQueued = true;
    requestFrame(() => {
      this.#frameQueued = false;
      if (!this.#disposed) this.render();
    });
  }

  /** Render and present one frame now. */
  render(): void {
    this.#live();
    const t0 = now();
    this.#raw.render();
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
    if (!d || d.moved || e.button !== 0 || !(options.select ?? true)) return;
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
    });
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
    this.#hoverPending = { x, y };
    if (this.#hoverBusy) return;
    this.#hoverBusy = true;
    void (async () => {
      while (this.#hoverPending && !this.#disposed) {
        const { x: px, y: py } = this.#hoverPending;
        this.#hoverPending = null;
        const seq = ++this.#hoverSeq;
        const p = await this.pick(px, py).catch(() => null);
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

  #live(): void {
    if (this.#disposed) throw forgeError("RENDER_DISPOSED", "the viewport was disposed");
  }
}

function sameEntity(a: PickResult, b: PickResult): boolean {
  return a.kind === b.kind && a.body === b.body && a.face === b.face && a.edge === b.edge;
}
