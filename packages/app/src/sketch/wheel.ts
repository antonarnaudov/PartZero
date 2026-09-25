/**
 * Which device sent a wheel event, for FD3 (a mouse and a Mac trackpad at the same time), and
 * what it does in the sketch view.
 *
 * | Device | Sketch view (2D, no orbit) | 3D viewport (`viewport/navigation.ts`) |
 * |---|---|---|
 * | Mouse wheel | zoom at the cursor, a fixed step per notch | zoom at the cursor |
 * | Trackpad pinch (Chromium: ctrl + wheel) | zoom at the cursor | zoom |
 * | Trackpad two-finger scroll | pan | orbit |
 * | Trackpad Shift + two-finger scroll | pan | pan |
 *
 * A wheel event does not say which device sent it. What Chromium (Electron) actually produces:
 * - **macOS notched mouse wheel** (non-precise): `deltaY` = Cocoa's line delta × 40 px. Cocoa's
 *   accelerated line delta for one slow tick is 0.1000061 lines, so the pixel deltas are
 *   multiples of **4.000244140625** (the value Mapbox GL detects the same way); `wheelDeltaY` =
 *   lines × 120, so `|wheelDeltaY| ≈ 3|deltaY|`, the same ratio a trackpad has. Integer-ness and
 *   the −3× ratio therefore do *not* separate a Mac mouse from a trackpad; the 4.000244 grid does.
 * - **macOS trackpad / Magic Mouse** (precise): pixel deltas, often fractional, usually with some
 *   horizontal component; a pinch arrives as `ctrlKey` + small `deltaY`.
 * - **Windows/Linux notched wheel**: `deltaMode` 0 with `deltaY` 100 (or 53, 125…) per notch and
 *   `wheelDeltaY` ±120 per notch (not 3 × deltaY); Firefox reports `deltaMode` 1 (lines).
 *
 * {@link wheelSignal} applies those rules in order; a *strong* signal is proof from the event
 * itself, a *weak* one a guess from the magnitude, and an ongoing gesture (events ≤ 200 ms apart)
 * keeps its device over weak guesses, so a trackpad scroll whose delta happens to be a round
 * number does not flip to zoom mid-gesture.
 *
 * `viewport/navigation.ts` (the 3D viewport stream) has its own `wheelSignal` with the same shape;
 * it treats `|wheelDelta| = 3|delta|` as a trackpad and fractional deltas as a trackpad, which
 * misreads a Mac mouse. The two should become one classifier in C10's input router (this one's
 * rules; docs/fm/sketcher.md, integrator follow-ups).
 */

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  /** Chromium's legacy `wheelDeltaX/Y` (non-standard; present in Electron). */
  wheelDeltaX?: number;
  wheelDeltaY?: number;
  timeStamp: number;
}

export type WheelDevice = "mouse" | "trackpad" | "pinch";

export interface WheelMemory {
  device: WheelDevice | null;
  lastAt: number;
}

export const GESTURE_GAP_MS = 200;
/** One slow notch of a macOS mouse wheel in Chromium, in CSS pixels (0.1000061 lines × 40). */
export const MAC_WHEEL_TICK_PX = 4.000244140625;
/** Zoom per mouse-wheel notch (a fixed step, like CAD apps: 15 %). */
export const ZOOM_PER_NOTCH = 1.15;
/** Pinch: zoom per unit of `deltaY`. */
export const PINCH_ZOOM_PER_UNIT = 0.01;

export function newWheelMemory(): WheelMemory {
  return { device: null, lastAt: -Infinity };
}

/** `|x|` is a whole number (≥ 1) of `step`s. */
function onGrid(x: number, step: number): boolean {
  const n = Math.abs(x) / step;
  const k = Math.round(n);
  return k >= 1 && Math.abs(n - k) <= 1e-9 * k;
}

/** The main scroll delta: vertical, else horizontal (macOS maps Shift + wheel to horizontal). */
function mainDelta(e: WheelLike): number {
  return e.deltaY !== 0 ? e.deltaY : e.deltaX;
}

/** Which device most likely sent `e` (see the module docs for the rules and their order). */
export function wheelSignal(e: WheelLike): { device: WheelDevice; strong: boolean } {
  if (e.ctrlKey) return { device: "pinch", strong: true };
  if (e.deltaMode !== 0) return { device: "mouse", strong: true };
  // A horizontal component without Shift (which the OS may map a vertical wheel to): a trackpad.
  if (e.deltaX !== 0 && !e.shiftKey) return { device: "trackpad", strong: true };
  const d = mainDelta(e);
  if (d === 0) return { device: "trackpad", strong: false };
  // macOS notched wheel: whole multiples of 4.000244140625 px.
  if (onGrid(d, MAC_WHEEL_TICK_PX)) return { device: "mouse", strong: true };
  // Windows/Linux notched wheel: legacy deltas in steps of 120 that are not 3 × the pixel delta.
  const w = e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 ? e.wheelDeltaY : e.wheelDeltaX;
  if (w !== undefined && w !== 0 && w % 120 === 0 && Math.abs(Math.abs(w) - 3 * Math.abs(d)) > 1e-6) return { device: "mouse", strong: true };
  // Fractional pixels that are not on the Mac wheel grid: a precise device.
  if (!Number.isInteger(d)) return { device: "trackpad", strong: true };
  // Whole pixels: small ones start trackpad gestures; large ones are wheel notches.
  if (Math.abs(d) < 4) return { device: "trackpad", strong: false };
  return { device: "mouse", strong: false };
}

/** Notches in a mouse wheel event (fractional for accelerated or high-resolution wheels). */
export function wheelNotches(e: WheelLike): number {
  const d = mainDelta(e);
  if (e.deltaMode === 1) return Math.abs(d) / 3; // lines: 3 per notch
  if (e.deltaMode === 2) return Math.abs(d); // pages
  if (onGrid(d, MAC_WHEEL_TICK_PX)) return Math.abs(d) / MAC_WHEEL_TICK_PX;
  const w = e.wheelDeltaY !== undefined && e.wheelDeltaY !== 0 ? e.wheelDeltaY : e.wheelDeltaX;
  if (w !== undefined && w !== 0 && w % 120 === 0) return Math.abs(w) / 120;
  return Math.abs(d) / 100;
}

export type SketchWheelAction = { type: "zoom"; factor: number } | { type: "pan"; dx: number; dy: number };

/**
 * The sketch view's action for a wheel event (zoom factor > 1 zooms in; pan in CSS pixels, the
 * sketch following the fingers), updating the gesture memory.
 */
export function sketchWheel(e: WheelLike, mem: WheelMemory): SketchWheelAction | null {
  const sig = wheelSignal(e);
  const continuing = mem.device !== null && e.timeStamp - mem.lastAt <= GESTURE_GAP_MS;
  const device = continuing && !sig.strong ? mem.device! : sig.device;
  mem.device = device;
  mem.lastAt = e.timeStamp;
  if (device === "pinch") {
    const dy = Math.max(-100, Math.min(100, e.deltaY));
    return dy === 0 ? null : { type: "zoom", factor: Math.exp(-dy * PINCH_ZOOM_PER_UNIT) };
  }
  if (device === "mouse") {
    const d = mainDelta(e);
    if (d === 0) return null;
    const n = Math.min(wheelNotches(e), 10);
    return { type: "zoom", factor: Math.pow(ZOOM_PER_NOTCH, d < 0 ? n : -n) };
  }
  if (e.deltaX === 0 && e.deltaY === 0) return null;
  return { type: "pan", dx: -e.deltaX, dy: -e.deltaY };
}
