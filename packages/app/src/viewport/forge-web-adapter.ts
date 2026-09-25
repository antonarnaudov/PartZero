import type { RenderBody } from "../engine/types";
import type { RawHit } from "../selection/picking";
import type { AdapterCapabilities, DisplaySettings, HighlightRef, SectionPlane, ViewportAdapter, ViewportColors } from "./adapter";
import { DISPLAY_MODES, edgeFlags, type DisplayMode } from "./display";
import type { CameraState, Projection, StandardView, Vec3 } from "./view-camera";

/**
 * The members of `@aicad/forge-web`'s `Viewport` this adapter uses (its public API; the app's
 * `forge-web-contract.ts` names only the subset the first shell needed). `setDisplayMode` and
 * `displayModes` exist once forge-render's display modes are wired into forge-wasm
 * (docs/fm/view-sel-followups.md); they are feature-detected.
 */
export interface ForgeWebViewportV2 {
  setBodies(bodies: RenderBody[]): void;
  pick(x: number, y: number): Promise<{ kind: "face" | "edge" | "section"; body: string; face: string | null; edge: string | null; point: [number, number, number] | null } | null>;
  setHover(e: object | null): void;
  setSelection(e: object[]): number;
  setSectionPlane(p: { origin: [number, number, number]; normal: [number, number, number] } | null): void;
  fitView(): void;
  setView(v: string): void;
  setProjection(p: Projection): void;
  cameraState(): CameraState;
  setCameraState(s: Partial<CameraState>): void;
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoomAt(x: number, y: number, factor: number): void;
  setDisplayOptions(o: Record<string, unknown>): void;
  resize(w: number, h: number, dpr: number): void;
  dispose(): void;
  backend(): "webgpu" | "webgl2";
  on(listener: (e: { type: string }) => void): () => void;
  setDisplayMode?(mode: string): boolean;
  displayModes?(): string[];
}

/** Adapter over `@aicad/forge-web`'s `Viewport` (the real renderer). */
export class ForgeWebViewportAdapter implements ViewportAdapter {
  readonly kind = "forge-web" as const;
  readonly canvas: HTMLCanvasElement;
  private readonly vp: ForgeWebViewportV2;
  private width = 1;
  private height = 1;
  private readonly native: DisplayMode[];

  constructor(vp: ForgeWebViewportV2, canvas: HTMLCanvasElement) {
    this.vp = vp;
    this.canvas = canvas;
    const modes = typeof vp.displayModes === "function" ? vp.displayModes() : [];
    this.native = DISPLAY_MODES.filter((m) => modes.includes(m));
    const r = canvas.getBoundingClientRect();
    this.width = Math.max(1, r.width);
    this.height = Math.max(1, r.height);
  }

  backend(): string {
    return this.vp.backend() === "webgpu" ? "WebGPU" : "WebGL2";
  }

  capabilities(): AdapterCapabilities {
    return { nativeModes: this.native, transparency: this.native.includes("xray") };
  }

  setBodies(bodies: readonly RenderBody[]): void {
    this.vp.setBodies([...bodies]);
  }

  async pick(x: number, y: number): Promise<RawHit | null> {
    const p = await this.vp.pick(x, y);
    if (!p) return null;
    return { kind: p.kind, body: p.body, face: p.face, edge: p.edge, point: p.point ? [p.point[0], p.point[1], p.point[2]] : null };
  }

  setHover(p: HighlightRef | null): void {
    this.vp.setHover(p ? toEntity(p) : null);
  }

  setSelection(p: readonly HighlightRef[]): void {
    this.vp.setSelection(p.map(toEntity));
  }

  fitView(): void {
    this.vp.fitView();
  }

  setView(v: StandardView): void {
    this.vp.setView(v);
  }

  setProjection(p: Projection): void {
    this.vp.setProjection(p);
  }

  setColors(_colors: ViewportColors): void {
    // forge-render owns its look; theme colours are an open item of the forge-web contract.
  }

  setDisplay(s: DisplaySettings): void {
    this.vp.setDisplayOptions({ grid: s.grid, axes: s.axes, ...edgeFlags(s.mode) });
    if (this.native.length > 0 && typeof this.vp.setDisplayMode === "function") {
      this.vp.setDisplayMode(this.native.includes(s.mode) ? s.mode : "shadedEdges");
    }
  }

  setSection(plane: SectionPlane | null): void {
    this.vp.setSectionPlane(plane ? { origin: [...plane.origin] as Vec3, normal: [...plane.normal] as Vec3 } : null);
  }

  camera(): CameraState {
    const s = this.vp.cameraState();
    return { target: [s.target[0], s.target[1], s.target[2]], distance: s.distance, yaw: s.yaw, pitch: s.pitch, fovY: s.fovY, projection: s.projection };
  }

  setCamera(state: Partial<CameraState>): void {
    // forge-wasm reads `target` as a Float32Array-compatible list.
    this.vp.setCameraState(state.target ? { ...state, target: [...state.target] as Vec3 } : state);
  }

  orbit(dx: number, dy: number): void {
    this.vp.orbit(dx, dy);
  }

  pan(dx: number, dy: number): void {
    this.vp.pan(dx, dy);
  }

  zoomAt(x: number, y: number, factor: number): void {
    this.vp.zoomAt(x, y, factor);
  }

  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(width: number, height: number, dpr: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.vp.resize(width, height, dpr);
  }

  onFrame(listener: () => void): () => void {
    return this.vp.on((e) => {
      if (e.type === "frame") listener();
    });
  }

  dispose(): void {
    this.vp.dispose();
    this.canvas.remove();
  }
}

function toEntity(p: HighlightRef): object {
  if (p.edge) return { body: p.body, edge: p.edge };
  if (p.face) return { body: p.body, face: p.face };
  return { body: p.body };
}
