/**
 * Camera navigation for **both** a mouse and a Mac trackpad at the same time (owner decision FD3):
 *
 * | Device | Orbit | Pan | Zoom |
 * |---|---|---|---|
 * | Mouse | right-drag | middle-drag, or Shift+right-drag | wheel (towards the cursor) |
 * | Trackpad | two-finger scroll | Shift + two-finger scroll | pinch |
 *
 * Left-drag is left to selection (box select) and to tools; a right click without a drag stays
 * free for a context menu.
 *
 * A wheel event does not say which device sent it, so {@link classifyWheel} decides:
 * - `ctrlKey` (Chromium reports a pinch as ctrl+wheel) → zoom;
 * - line/page delta modes, or legacy `wheelDelta` in steps of 120 → a notched mouse wheel → zoom;
 * - pixel deltas with a horizontal component, or whose legacy `wheelDelta` is `−3 × delta`
 *   (Chromium's trackpad signature) → trackpad scroll → orbit, or pan with Shift.
 * A gesture keeps its first classification while its events keep coming (≤ 200 ms apart), so a
 * trackpad scroll that happens to have a zero horizontal delta does not flip to zoom mid-gesture.
 */

export type NavAction = { type: "orbit"; dx: number; dy: number } | { type: "pan"; dx: number; dy: number } | { type: "zoom"; factor: number };

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Chromium's legacy `wheelDeltaX/Y` (non-standard; present in Electron). */
  wheelDeltaX?: number;
  wheelDeltaY?: number;
  timeStamp: number;
}

export type WheelDevice = "mouse" | "trackpad" | "pinch";

/** Memory of the current wheel gesture (see the module docs). */
export interface WheelMemory {
  device: WheelDevice | null;
  lastAt: number;
}

export const GESTURE_GAP_MS = 200;
/** Zoom per wheel pixel (mouse) and per pinch unit. */
export const WHEEL_ZOOM_PER_PX = 0.0015;
export const PINCH_ZOOM_PER_UNIT = 0.01;
/** Trackpad scroll → orbit pixels (1:1 feels like dragging). */
export const TRACKPAD_ORBIT_SCALE = 1;

export function newWheelMemory(): WheelMemory {
  return { device: null, lastAt: -Infinity };
}

/**
 * Which device most likely produced this event, ignoring gesture memory. `strong` when the event
 * itself proves it (ctrl = pinch, a line/page mode or 120-step legacy delta = notched wheel,
 * Chromium's −3× trackpad signature, a horizontal component); `weak` when inferred from the
 * delta values alone (then an ongoing gesture's device wins).
 */
export function wheelSignal(e: WheelLike): { device: WheelDevice; strong: boolean } {
  if (e.ctrlKey) return { device: "pinch", strong: true };
  if (e.deltaMode !== 0) return { device: "mouse", strong: true };
  const wy = e.wheelDeltaY;
  const wx = e.wheelDeltaX;
  // Chromium trackpads: wheelDelta = −3 × delta exactly (both axes).
  if (wy !== undefined && wy !== 0 && Math.abs(Math.abs(wy) - Math.abs(e.deltaY) * 3) < 1e-6) return { device: "trackpad", strong: true };
  if (wx !== undefined && wx !== 0 && Math.abs(Math.abs(wx) - Math.abs(e.deltaX) * 3) < 1e-6) return { device: "trackpad", strong: true };
  // Notched wheels: legacy deltas in steps of 120.
  if (wy !== undefined && wy !== 0 && wy % 120 === 0) return { device: "mouse", strong: true };
  // A horizontal component (without Shift, which the OS may map a vertical wheel to) → trackpad.
  if (e.deltaX !== 0 && !e.shiftKey) return { device: "trackpad", strong: true };
  // Fractional pixel deltas come from trackpads; mice step in whole pixels.
  if (!Number.isInteger(e.deltaY) || !Number.isInteger(e.deltaX)) return { device: "trackpad", strong: false };
  return { device: "mouse", strong: false };
}

export function wheelDevice(e: WheelLike): WheelDevice {
  return wheelSignal(e).device;
}

/** Classify a wheel event into a camera action, updating the gesture memory. */
export function classifyWheel(e: WheelLike, mem: WheelMemory): NavAction | null {
  const sig = wheelSignal(e);
  let device = sig.device;
  const continuing = mem.device !== null && e.timeStamp - mem.lastAt <= GESTURE_GAP_MS;
  // Evidence in the event itself wins; an ambiguous event continues the ongoing gesture.
  if (continuing && !sig.strong) device = mem.device!;
  mem.device = device;
  mem.lastAt = e.timeStamp;
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
  const dx = e.deltaX * unit;
  const dy = e.deltaY * unit;
  if (device === "pinch") {
    return { type: "zoom", factor: Math.exp(Math.max(-100, Math.min(100, dy)) * PINCH_ZOOM_PER_UNIT) };
  }
  if (device === "mouse") {
    // macOS turns Shift+wheel into a horizontal scroll: use whichever axis moved.
    const d = dy !== 0 ? dy : dx;
    if (d === 0) return null;
    return { type: "zoom", factor: Math.exp(Math.max(-400, Math.min(400, d)) * WHEEL_ZOOM_PER_PX) };
  }
  if (dx === 0 && dy === 0) return null;
  // Trackpad: fingers moving right turn the model right (like dragging it).
  if (e.shiftKey) return { type: "pan", dx: -dx, dy: -dy };
  return { type: "orbit", dx: -dx * TRACKPAD_ORBIT_SCALE, dy: -dy * TRACKPAD_ORBIT_SCALE };
}

export type DragRole = "orbit" | "pan" | "select" | null;

/**
 * What a pointer drag started with `button` does: right orbits (Shift+right pans), middle pans,
 * left belongs to selection/tools (Alt+left orbits, Alt+Shift+left pans, for one-button mice).
 */
export function dragRole(button: number, mods: { shiftKey: boolean; altKey: boolean }): DragRole {
  if (button === 2) return mods.shiftKey ? "pan" : "orbit";
  if (button === 1) return "pan";
  if (button === 0) {
    if (mods.altKey) return mods.shiftKey ? "pan" : "orbit";
    return "select";
  }
  return null;
}

/** Pointer travel (CSS px) below which a press–release is a click, not a drag. */
export const CLICK_SLOP_PX = 4;
