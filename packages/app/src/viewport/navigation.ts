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
 * A wheel event does not say which device sent it, so {@link classifyWheel} decides, unless the
 * user picked a device in Settings ▸ Navigation ({@link NavPreset}: Auto, Mouse, Trackpad). Auto
 * follows how Chromium builds wheel events on macOS (web_input_event_builders_mac.mm):
 * - a trackpad (a *continuous* device) reports whole-pixel deltas and `wheelDelta = −3 × delta`
 *   (ticks = pixels / 40, × 120);
 * - a notched mouse wheel reports `delta = lines × 40` (accelerated, often fractional such as
 *   4.000244…) but `wheelDelta = notches × 120` — so at exactly one line per notch it ALSO has the
 *   −3× ratio. `wheelDelta` in steps of 120 without that ratio is a mouse; the ratio without steps
 *   of 120 is a trackpad; both at once (|delta| = 40, 80, …) is ambiguous.
 * The rules, strongest first:
 * - `ctrlKey` (Chromium reports a pinch as ctrl+wheel) → zoom;
 * - line/page delta modes (Firefox's mouse wheel) → a mouse → zoom;
 * - legacy `wheelDelta` in steps of 120 and not −3 × delta → a mouse; −3 × delta and not in steps
 *   of 120 → a trackpad; both → ambiguous, a mouse unless a trackpad gesture is under way;
 *   `wheelDelta` 0 for a non-zero delta (a sub-notch wheel event; a Mac trackpad never has it) →
 *   probably a mouse;
 * - a horizontal component (without Shift, which the OS may map a vertical wheel to) → trackpad;
 * - without legacy fields: fractional pixel deltas → probably a trackpad, else probably a mouse.
 * A gesture keeps its device while its events keep coming (≤ 200 ms apart) unless an event proves
 * otherwise, so a trackpad scroll whose delta happens to be 40 px does not flip to zoom mid-gesture.
 *
 * The sequences in `test/fixtures/wheel-sequences.ts` model those builders; real recordings can be
 * captured in Settings ▸ Navigation ("Copy events") and added there.
 */

export type NavAction = { type: "orbit"; dx: number; dy: number } | { type: "pan"; dx: number; dy: number } | { type: "zoom"; factor: number };

/** Settings ▸ Navigation: detect the device per gesture, or force one (pinch always zooms). */
export const NAV_PRESETS = ["auto", "mouse", "trackpad"] as const;
export type NavPreset = (typeof NAV_PRESETS)[number];

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
/** Chromium's legacy wheelDelta per wheel notch. */
const NOTCH = 120;

export function newWheelMemory(): WheelMemory {
  return { device: null, lastAt: -Infinity };
}

export interface WheelSignal {
  device: WheelDevice;
  /** The event itself proves the device (else an ongoing gesture's device wins). */
  strong: boolean;
  /** Which rule decided (Settings ▸ Navigation shows it; tests assert it). */
  rule: string;
}

/** What one axis's legacy `wheelDelta` says about the device. */
function legacyAxis(delta: number, legacy: number): WheelSignal | null {
  if (delta === 0) return null;
  if (legacy === 0) return { device: "mouse", strong: false, rule: "wheelDelta 0 (sub-notch wheel)" };
  const notch = legacy % NOTCH === 0;
  // Blink truncates ticks × 120 to an integer: allow < 1 of rounding.
  const triple = Math.abs(Math.abs(legacy) - 3 * Math.abs(delta)) < 1;
  if (notch && !triple) return { device: "mouse", strong: true, rule: "wheelDelta in notches" };
  if (triple && !notch) return { device: "trackpad", strong: true, rule: "wheelDelta −3×delta" };
  if (notch && triple) return { device: "mouse", strong: false, rule: "ambiguous (40 px per notch)" };
  return null;
}

/** Which device most likely produced this event, ignoring gesture memory (see the module docs). */
export function wheelSignal(e: WheelLike): WheelSignal {
  if (e.ctrlKey) return { device: "pinch", strong: true, rule: "ctrl (pinch)" };
  if (e.deltaMode !== 0) return { device: "mouse", strong: true, rule: "line/page mode" };
  if (e.wheelDeltaY !== undefined || e.wheelDeltaX !== undefined) {
    const s = legacyAxis(e.deltaY, e.wheelDeltaY ?? 0) ?? legacyAxis(e.deltaX, e.wheelDeltaX ?? 0);
    // A horizontal component still marks a trackpad when the legacy fields were inconclusive.
    if (s && (s.strong || e.deltaX === 0 || e.shiftKey)) return s;
  }
  // A horizontal component (without Shift, which the OS may map a vertical wheel to) → trackpad.
  if (e.deltaX !== 0 && !e.shiftKey) return { device: "trackpad", strong: true, rule: "horizontal component" };
  // Fractional pixel deltas come from trackpads; mice step in whole pixels (no legacy fields).
  if (!Number.isInteger(e.deltaY) || !Number.isInteger(e.deltaX)) return { device: "trackpad", strong: false, rule: "fractional pixels" };
  return { device: "mouse", strong: false, rule: "whole pixels" };
}

export function wheelDevice(e: WheelLike): WheelDevice {
  return wheelSignal(e).device;
}

/** The device a wheel event is handled as: the preset's, or Auto's guess with gesture memory. */
export function resolveWheelDevice(e: WheelLike, mem: WheelMemory, preset: NavPreset = "auto"): WheelDevice {
  const sig = wheelSignal(e);
  let device = sig.device;
  if (preset !== "auto" && device !== "pinch") device = preset;
  else {
    const continuing = mem.device !== null && e.timeStamp - mem.lastAt <= GESTURE_GAP_MS;
    // Evidence in the event itself wins; an ambiguous event continues the ongoing gesture.
    if (continuing && !sig.strong && mem.device !== "pinch") device = mem.device!;
  }
  mem.device = device;
  mem.lastAt = e.timeStamp;
  return device;
}

/** Classify a wheel event into a camera action, updating the gesture memory. */
export function classifyWheel(e: WheelLike, mem: WheelMemory, preset: NavPreset = "auto"): NavAction | null {
  const device = resolveWheelDevice(e, mem, preset);
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
