/**
 * `ViewportAdapter`: what the viewport host needs from a renderer (contract C4, part 1). Two
 * implementations:
 * - `ForgeWebViewportAdapter`: the real renderer (`@aicad/forge-web`'s `Viewport`, WebGPU/WebGL2);
 * - `PlaceholderViewport`: a Canvas 2D stand-in (flat-shaded faces + B-rep edges), used when
 *   forge-web cannot start, so the shell stays usable and testable.
 * {@link createViewportAdapter} prefers forge-web and falls back automatically.
 *
 * Both share one camera convention (`view-camera.ts`, the port of forge-render's camera), so
 * overlays (view cube, manipulators, measure labels, box select) work identically on both. Input
 * (orbit, pan, zoom, picking, box select) is handled by the host, not by the adapters.
 */
import { available, load, source } from "virtual:aicad/forge-web";
import { isForgeWebModule, missingForgeWebMembers } from "../engine/forge-web-contract";
import type { RenderBody } from "../engine/types";
import type { RawHit } from "../selection/picking";
import type { DisplayMode } from "./display";
import { ForgeWebViewportAdapter, type ForgeWebViewportV2 } from "./forge-web-adapter";
import { PlaceholderViewport } from "./placeholder";
import type { CameraState, Projection, StandardView, Vec3 } from "./view-camera";

export interface ViewportColors {
  background: string;
  backgroundBottom: string;
  grid: string;
  gridMajor: string;
  body: string;
  edge: string;
  accent: string;
  hover: string;
  text: string;
}

/** A face or edge to highlight, by provenance name. */
export interface HighlightRef {
  body: string;
  face?: string;
  edge?: string;
}

export interface SectionPlane {
  origin: Vec3;
  /** Towards the removed half-space. */
  normal: Vec3;
}

/** Renderer display settings (what the display-mode menu and the grid/axes toggles set). */
export interface DisplaySettings {
  mode: DisplayMode;
  grid: boolean;
  /** The corner axes gizmo. */
  axes: boolean;
}

export interface AdapterCapabilities {
  /** Display modes the renderer draws natively (the rest are emulated or unavailable). */
  nativeModes: readonly DisplayMode[];
  /** Whether the renderer can draw bodies semi-transparent (X-ray). */
  transparency: boolean;
}

export interface ViewportAdapter {
  readonly kind: "placeholder" | "forge-web";
  /** e.g. `Canvas 2D`, `WebGPU`, `WebGL2`. */
  backend(): string;
  readonly canvas: HTMLCanvasElement;
  capabilities(): AdapterCapabilities;
  setBodies(bodies: readonly RenderBody[]): void;
  /** Pick at CSS-pixel coordinates relative to the canvas. */
  pick(x: number, y: number): Promise<RawHit | null>;
  setHover(p: HighlightRef | null): void;
  setSelection(p: readonly HighlightRef[]): void;
  fitView(): void;
  setView(v: StandardView): void;
  setProjection(p: Projection): void;
  setColors(colors: ViewportColors): void;
  setDisplay(settings: DisplaySettings): void;
  setSection(plane: SectionPlane | null): void;
  camera(): CameraState;
  setCamera(state: Partial<CameraState>): void;
  /** Pointer-motion camera moves, in CSS px. */
  orbit(dx: number, dy: number): void;
  pan(dx: number, dy: number): void;
  zoomAt(x: number, y: number, factor: number): void;
  /** CSS size of the canvas. */
  size(): { width: number; height: number };
  resize(width: number, height: number, dpr: number): void;
  /** Called after every frame (camera changes included), for overlays. */
  onFrame(listener: () => void): () => void;
  dispose(): void;
}

export interface CreateViewportOptions {
  /** Try `@aicad/forge-web` first (default true). */
  preferForgeWeb?: boolean;
  onFallback?: (reason: string) => void;
}

function makeCanvas(container: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "viewport-canvas";
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "3D viewport");
  container.appendChild(canvas);
  return canvas;
}

/** Create the best available viewport inside `container` (the adapter owns its canvas). */
export async function createViewportAdapter(container: HTMLElement, options: CreateViewportOptions = {}): Promise<ViewportAdapter> {
  if ((options.preferForgeWeb ?? true) && available) {
    const canvas = makeCanvas(container);
    try {
      const m: unknown = await load();
      if (!isForgeWebModule(m)) throw new Error(`contract mismatch (missing: ${missingForgeWebMembers(m).join(", ")})`);
      await m.init();
      const viewport = (await m.Viewport.create(canvas)) as unknown as ForgeWebViewportV2;
      return new ForgeWebViewportAdapter(viewport, canvas);
    } catch (e) {
      canvas.remove();
      options.onFallback?.(`forge-web viewport unavailable (${e instanceof Error ? e.message : String(e)}); using the placeholder`);
    }
  } else if (!available) {
    options.onFallback?.(`forge-web not bundled (${source}); using the placeholder`);
  }
  return new PlaceholderViewport(makeCanvas(container));
}
