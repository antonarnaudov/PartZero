import { normalizePick, type ForgeWebViewport, type Projection, type ViewName } from "../engine/forge-web-contract";
import type { PickResult, RenderBody } from "../engine/types";
import type { ViewportAdapter, ViewportColors } from "./adapter";

/** Thin adapter over `@aicad/forge-web`'s `Viewport` (the real renderer). */
export class ForgeWebViewportAdapter implements ViewportAdapter {
  readonly kind = "forge-web" as const;
  readonly canvas: HTMLCanvasElement;
  private readonly vp: ForgeWebViewport;

  constructor(vp: ForgeWebViewport, canvas: HTMLCanvasElement) {
    this.vp = vp;
    this.canvas = canvas;
  }

  backend(): string {
    return this.vp.backend() === "webgpu" ? "WebGPU" : "WebGL2";
  }

  setBodies(bodies: readonly RenderBody[]): void {
    this.vp.setBodies([...bodies]);
  }

  async pick(x: number, y: number): Promise<PickResult | null> {
    return normalizePick(await this.vp.pick(x, y));
  }

  setHover(p: PickResult | null): void {
    this.vp.setHover(p);
  }

  setSelection(p: PickResult[]): void {
    this.vp.setSelection(p);
  }

  fitView(): void {
    this.vp.fitView();
  }

  setView(v: ViewName): void {
    this.vp.setView(v);
  }

  setProjection(p: Projection): void {
    this.vp.setProjection(p);
  }

  setColors(_colors: ViewportColors): void {
    // forge-render owns its look; theme integration is an open item of the forge-web contract.
  }

  resize(width: number, height: number, dpr: number): void {
    this.vp.resize(width, height, dpr);
  }

  dispose(): void {
    this.vp.dispose();
    this.canvas.remove();
  }
}
