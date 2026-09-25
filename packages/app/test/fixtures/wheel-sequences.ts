/**
 * Wheel-event sequences as Chromium (Electron) delivers them, for the navigation classifier.
 *
 * MODELLED, not recorded: they follow how Chromium builds wheel events —
 * macOS `WebMouseWheelEventBuilder::Build` (web_input_event_builders_mac.mm) and Blink's
 * `WheelEvent` (`wheelDelta = −ticks × 120`, truncated to an integer):
 * - a *continuous* device (trackpad, Magic Mouse): `delta` = whole-pixel point delta,
 *   ticks = delta / 40, so `wheelDelta = −3 × delta`;
 * - a notched wheel: `delta = lines × 40` with macOS acceleration (fixed-point lines, 0.1 is
 *   0.100006103515625), ticks = whole notches, so `wheelDelta = −120 × notches`.
 * Real recordings (Settings ▸ Navigation ▸ Copy events) should be added next to these, with the
 * machine and device they came from.
 */
import type { WheelLike } from "../../src/viewport/navigation";

export interface WheelSequence {
  name: string;
  /** What every event of the sequence must do in Auto. */
  expect: "zoom" | "orbit" | "pan";
  events: WheelLike[];
}

const base = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false };

/** A continuous device on macOS: whole pixels, wheelDelta = −3 × delta. */
export function macContinuous(dx: number, dy: number, t: number, mods: { shiftKey?: boolean } = {}): WheelLike {
  return { ...base, ...mods, deltaX: dx, deltaY: dy, wheelDeltaX: Math.trunc(-3 * dx), wheelDeltaY: Math.trunc(-3 * dy), timeStamp: t };
}

/** A notched wheel on macOS: accelerated lines × 40, wheelDelta = −120 × notches. */
export function macNotched(lines: number, notches: number, t: number): WheelLike {
  return { ...base, deltaY: lines * 40, wheelDeltaX: 0, wheelDeltaY: -120 * notches, timeStamp: t };
}

/** macOS's fixed-point 0.1 line (6554 / 65536). */
const TENTH = 6554 / 65536;

const at = (i: number, gap: number, t0 = 0): number => t0 + i * gap;

export const SEQUENCES: WheelSequence[] = [
  {
    name: "mac notched mouse, slow (0.1 line per notch, 4.000244 px)",
    expect: "zoom",
    events: [0, 1, 2, 3, 4].map((i) => macNotched(TENTH, 1, at(i, 90))),
  },
  {
    name: "mac notched mouse, exactly one line per notch (40 px, wheelDelta 120: the −3× ratio too)",
    expect: "zoom",
    events: [0, 1, 2, 3].map((i) => macNotched(1, 1, at(i, 120))),
  },
  {
    name: "mac notched mouse, accelerating",
    expect: "zoom",
    events: [macNotched(1, 1, 0), macNotched(2.5, 1, 40), macNotched(4, 2, 70), macNotched(6, 2, 95), macNotched(-1, -1, 600)],
  },
  {
    name: "mac trackpad, two-finger vertical scroll with momentum (one event of exactly 40 px)",
    expect: "orbit",
    events: [1, 2, 4, 7, 10, 12, 40, 12, 8, 5, 3, 2, 1].map((dy, i) => macContinuous(0, dy, at(i, 16))),
  },
  {
    name: "mac trackpad, diagonal scroll",
    expect: "orbit",
    events: [
      [1, 0],
      [2, 1],
      [3, 3],
      [0, 5],
      [-2, 6],
    ].map(([dx, dy], i) => macContinuous(dx!, dy!, at(i, 16))),
  },
  {
    name: "mac trackpad, Shift + two-finger scroll",
    expect: "pan",
    events: [
      [0, 3],
      [2, 5],
      [4, 0],
      [3, -2],
    ].map(([dx, dy], i) => macContinuous(dx!, dy!, at(i, 16), { shiftKey: true })),
  },
  {
    name: "mac pinch (ctrl + fractional pixels)",
    expect: "zoom",
    events: [-1.5, -2.25, -3, -1].map((dy, i) => ({ ...base, ctrlKey: true, deltaY: dy, wheelDeltaX: 0, wheelDeltaY: Math.trunc(-3 * dy), timeStamp: at(i, 16) })),
  },
  {
    name: "Windows notched mouse (100 px per notch, wheelDelta 120)",
    expect: "zoom",
    events: [0, 1, 2].map((i) => ({ ...base, deltaY: 100, wheelDeltaX: 0, wheelDeltaY: -120, timeStamp: at(i, 80) })),
  },
  {
    name: "Firefox notched mouse (line mode, no legacy fields)",
    expect: "zoom",
    events: [0, 1].map((i) => ({ ...base, deltaMode: 1, deltaY: 3, timeStamp: at(i, 80) })),
  },
];
