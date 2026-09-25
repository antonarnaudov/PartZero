/**
 * The sketch view: the sketch plane seen along its normal (orthographic, "look at"), in CSS
 * pixels. Sketch u runs right and v up. Navigation follows FD3 — trackpad and mouse at once
 * (the wheel device is told apart in `wheel.ts`):
 *
 * | Input | Action |
 * |---|---|
 * | Mouse wheel | zoom at the cursor (a fixed step per notch) |
 * | Trackpad pinch (ctrl + wheel) | zoom at the cursor |
 * | Trackpad two-finger scroll, with or without Shift | pan (the flat sketch view has no orbit) |
 * | Middle drag, right drag, Space + drag | pan |
 *
 * `SketchView` is the contract the sketch overlay needs from any camera: when the viewport
 * exports its camera matrices (plan contract C4, `camera().project/ray`), a camera-linked view
 * implements the same interface and the overlay draws in 3D context unchanged.
 */
import type { P2 } from "./geom";

export interface SketchView {
  /** Sketch → CSS pixels (relative to the overlay's top-left). */
  toScreen(p: P2): P2;
  /** CSS pixels → sketch (on the plane). */
  toSketch(px: P2): P2;
  /** Sketch millimetres per CSS pixel (tolerances, label sizes). */
  mmPerPx(): number;
}

export interface ViewState {
  /** Sketch point at the overlay's centre. */
  cx: number;
  cy: number;
  /** CSS pixels per millimetre. */
  scale: number;
  /** Overlay size in CSS pixels. */
  width: number;
  height: number;
}

export const MIN_SCALE = 1e-3;
export const MAX_SCALE = 1e4;

export function initialView(width: number, height: number): ViewState {
  // About 120 mm across a typical viewport.
  return { cx: 0, cy: 0, scale: Math.max(0.5, Math.min(width, height) / 120), width, height };
}

export class PlaneView implements SketchView {
  constructor(readonly s: ViewState) {}

  toScreen(p: P2): P2 {
    return [this.s.width / 2 + (p[0] - this.s.cx) * this.s.scale, this.s.height / 2 - (p[1] - this.s.cy) * this.s.scale];
  }

  toSketch(px: P2): P2 {
    return [this.s.cx + (px[0] - this.s.width / 2) / this.s.scale, this.s.cy - (px[1] - this.s.height / 2) / this.s.scale];
  }

  mmPerPx(): number {
    return 1 / this.s.scale;
  }
}

/** Pan by a pointer motion of (dx, dy) CSS pixels: the sketch follows the pointer. */
export function pan(s: ViewState, dx: number, dy: number): ViewState {
  return { ...s, cx: s.cx - dx / s.scale, cy: s.cy + dy / s.scale };
}

/** Zoom by `factor` (> 1 zooms in) keeping the sketch point under `px` fixed. */
export function zoomAt(s: ViewState, px: P2, factor: number): ViewState {
  if (!(factor > 0) || !Number.isFinite(factor)) return s;
  const v = new PlaneView(s);
  const anchor = v.toSketch(px);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s.scale * factor));
  const next = { ...s, scale };
  const moved = new PlaneView(next).toSketch(px);
  return { ...next, cx: next.cx + (anchor[0] - moved[0]), cy: next.cy + (anchor[1] - moved[1]) };
}

/** Fit a sketch-space box (with a margin); keeps the scale when the box is empty. */
export function fitBox(s: ViewState, box: { min: P2; max: P2 } | null, margin = 0.15): ViewState {
  if (!box) return { ...s, cx: 0, cy: 0 };
  const w = Math.max(box.max[0] - box.min[0], 1e-6);
  const h = Math.max(box.max[1] - box.min[1], 1e-6);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((s.width * (1 - 2 * margin)) / w, (s.height * (1 - 2 * margin)) / h)));
  return { ...s, cx: (box.min[0] + box.max[0]) / 2, cy: (box.min[1] + box.max[1]) / 2, scale };
}

/** A readable grid step (1, 2, 5 × 10^k mm) of at least `minPx` CSS pixels. */
export function gridStep(scale: number, minPx = 12): number {
  const raw = minPx / scale;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (p * m >= raw) return p * m;
  return p * 10;
}
