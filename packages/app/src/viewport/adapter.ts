/**
 * `ViewportAdapter`: what the viewport host needs from a renderer. Two implementations:
 * - `ForgeWebViewportAdapter`: the real renderer (`@aicad/forge-web`'s `Viewport`, WebGPU/WebGL2);
 * - `PlaceholderViewport`: a Canvas 2D stand-in (flat-shaded faces + B-rep edges), so the shell is
 *   usable and testable before forge-web lands.
 * {@link createViewportAdapter} prefers forge-web and falls back automatically.
 */
import { available, load, source } from "virtual:aicad/forge-web";
import { isForgeWebModule, missingForgeWebMembers, type Projection, type ViewName } from "../engine/forge-web-contract";
import type { PickResult, RenderBody } from "../engine/types";
import { ForgeWebViewportAdapter } from "./forge-web-adapter";
import { PlaceholderViewport } from "./placeholder";

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

export interface ViewportAdapter {
  readonly kind: "placeholder" | "forge-web";
  /** e.g. `Canvas 2D`, `WebGPU`, `WebGL2`. */
  backend(): string;
  readonly canvas: HTMLCanvasElement;
  setBodies(bodies: readonly RenderBody[]): void;
  /** Pick at CSS-pixel coordinates relative to the canvas. */
  pick(x: number, y: number): Promise<PickResult | null>;
  setHover(p: PickResult | null): void;
  setSelection(p: PickResult[]): void;
  fitView(): void;
  setView(v: ViewName): void;
  setProjection(p: Projection): void;
  setColors(colors: ViewportColors): void;
  resize(width: number, height: number, dpr: number): void;
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
      const viewport = await m.Viewport.create(canvas);
      // Orbit/pan/zoom only: hover and selection go through the shell (commands, stores).
      viewport.attachControls(canvas, { hover: false, select: false });
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
