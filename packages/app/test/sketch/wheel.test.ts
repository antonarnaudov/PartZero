/**
 * FD3 in the sketch view: wheel events from a mouse and a Mac trackpad at the same time.
 *
 * The traces are in the shape Chromium (Electron) produces on each platform, from its event
 * builders (macOS: non-precise wheel delta = Cocoa lines × 40 px, `wheelDelta` = lines × 120;
 * precise devices: pixel deltas, `wheelDelta` = 3 × delta; Windows: 100 px and 120 per notch;
 * Firefox: lines). They are synthesized from those rules, not recorded on a device.
 */
import { describe, expect, it } from "vitest";
import { SketchMode } from "../../src/sketch/controller";
import { MAC_WHEEL_TICK_PX, newWheelMemory, sketchWheel, wheelNotches, wheelSignal, type WheelLike } from "../../src/sketch/wheel";

type Ev = Partial<WheelLike> & { t: number };

const ev = (e: Ev): WheelLike => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, timeStamp: e.t, ...e });

/** Run a trace through one gesture memory; the action type of each event. */
function actions(trace: Ev[]): string[] {
  const mem = newWheelMemory();
  return trace.map((e) => sketchWheel(ev(e), mem)?.type ?? "none");
}

const T = MAC_WHEEL_TICK_PX;

// macOS, Chromium, a notched mouse wheel: slow ticks, then a faster (accelerated) spin.
const MAC_MOUSE_DOWN: Ev[] = [
  { deltaY: T, wheelDeltaY: -12, t: 0 },
  { deltaY: T, wheelDeltaY: -12, t: 140 },
  { deltaY: 2 * T, wheelDeltaY: -24, t: 180 },
  { deltaY: 3 * T, wheelDeltaY: -36, t: 200 },
  { deltaY: 9 * T, wheelDeltaY: -108, t: 215 },
];
const MAC_MOUSE_UP: Ev[] = MAC_MOUSE_DOWN.map((e) => ({ ...e, deltaY: -e.deltaY!, wheelDeltaY: -e.wheelDeltaY! }));

// macOS trackpad, two-finger scroll: sub-pixel and whole-pixel deltas with horizontal jitter,
// then the momentum tail in whole pixels.
const MAC_TRACKPAD: Ev[] = [
  { deltaY: 1, wheelDeltaY: -3, t: 0 },
  { deltaX: 0.5, deltaY: 3, wheelDeltaX: -1, wheelDeltaY: -9, t: 16 },
  { deltaY: 7, wheelDeltaY: -21, t: 33 },
  { deltaY: 12.5, wheelDeltaY: -37, t: 50 },
  { deltaY: 40, wheelDeltaY: -120, t: 66 },
  { deltaY: 20, wheelDeltaY: -60, t: 83 },
  { deltaY: 9, wheelDeltaY: -27, t: 100 },
  { deltaY: 4, wheelDeltaY: -12, t: 116 },
  { deltaY: 1, wheelDeltaY: -3, t: 133 },
];

describe("wheel device (FD3)", () => {
  it("reads a macOS mouse wheel as a mouse, including its fractional accelerated deltas", () => {
    for (const e of [...MAC_MOUSE_DOWN, ...MAC_MOUSE_UP]) expect(wheelSignal(ev(e))).toEqual({ device: "mouse", strong: true });
    expect(actions(MAC_MOUSE_DOWN)).toEqual(["zoom", "zoom", "zoom", "zoom", "zoom"]);
    // One notch zooms a fixed 15 %, whatever the pixel size of the notch.
    expect(wheelNotches(ev(MAC_MOUSE_DOWN[0]!))).toBeCloseTo(1, 12);
    const up = sketchWheel(ev(MAC_MOUSE_UP[0]!), newWheelMemory());
    expect(up).toEqual({ type: "zoom", factor: expect.closeTo(1.15, 12) as number });
    const down = sketchWheel(ev(MAC_MOUSE_DOWN[0]!), newWheelMemory());
    expect(down?.type === "zoom" && down.factor).toBeCloseTo(1 / 1.15, 12);
  });

  it("reads a macOS two-finger scroll as a trackpad pan for the whole gesture", () => {
    expect(actions(MAC_TRACKPAD)).toEqual(Array(MAC_TRACKPAD.length).fill("pan"));
    const a = sketchWheel(ev(MAC_TRACKPAD[1]!), newWheelMemory());
    expect(a).toEqual({ type: "pan", dx: -0.5, dy: -3 });
  });

  it("pans with Shift + two fingers, and zooms with Shift + a mouse wheel (macOS turns it horizontal)", () => {
    expect(actions([{ deltaY: 2.5, shiftKey: true, t: 0 }, { deltaX: 1, deltaY: 6, shiftKey: true, t: 16 }])).toEqual(["pan", "pan"]);
    expect(actions([{ deltaX: T, shiftKey: true, t: 0 }])).toEqual(["zoom"]);
  });

  it("zooms with a pinch (ctrl + wheel), in and out", () => {
    const mem = newWheelMemory();
    const zin = sketchWheel(ev({ ctrlKey: true, deltaY: -2.5, t: 0 }), mem);
    const zout = sketchWheel(ev({ ctrlKey: true, deltaY: 1.25, t: 16 }), mem);
    expect(zin?.type === "zoom" && zin.factor).toBeGreaterThan(1);
    expect(zout?.type === "zoom" && zout.factor).toBeLessThan(1);
  });

  it("reads Windows notches and Firefox lines as a mouse, and a precision touchpad as a trackpad", () => {
    expect(wheelSignal(ev({ deltaY: 100, wheelDeltaY: -120, t: 0 }))).toEqual({ device: "mouse", strong: true });
    expect(wheelNotches(ev({ deltaY: 200, wheelDeltaY: -240, t: 0 }))).toBe(2);
    expect(wheelSignal(ev({ deltaY: 3, deltaMode: 1, t: 0 }))).toEqual({ device: "mouse", strong: true });
    expect(wheelNotches(ev({ deltaY: 3, deltaMode: 1, t: 0 }))).toBe(1);
    expect(actions([{ deltaY: 2.6666, t: 0 }, { deltaY: 5.3333, t: 10 }, { deltaY: 8, t: 20 }])).toEqual(["pan", "pan", "pan"]);
  });

  it("starts a new gesture after a pause", () => {
    const mem = newWheelMemory();
    expect(sketchWheel(ev({ deltaY: 2.5, t: 0 }), mem)?.type).toBe("pan");
    expect(sketchWheel(ev({ deltaY: 40, t: 50 }), mem)?.type).toBe("pan"); // same gesture
    expect(sketchWheel(ev({ deltaY: 40, t: 600 }), mem)?.type).toBe("zoom"); // a new one: a wheel notch
  });

  it("zooms the sketch view at the cursor for the mouse and pans it for the trackpad", () => {
    const m = new SketchMode(null);
    m.setViewport(800, 600);
    const s0 = m.getState().view;
    for (const e of MAC_MOUSE_UP) m.wheel({ ...ev(e), px: [400, 300] });
    const s1 = m.getState().view;
    expect(s1.scale).toBeGreaterThan(s0.scale * 1.15 ** 10);
    expect(s1.cx).toBeCloseTo(s0.cx, 9); // zoomed at the centre: the centre stays
    for (const e of MAC_TRACKPAD) m.wheel({ ...ev({ ...e, t: e.t + 1000 }), px: [400, 300] });
    const s2 = m.getState().view;
    expect(s2.scale).toBe(s1.scale);
    // Positive deltas (fingers moving up, natural scrolling) move the sketch up like page content:
    // the v at the view centre falls by the scrolled pixels.
    const total = MAC_TRACKPAD.reduce((a, e) => a + (e.deltaY ?? 0), 0);
    expect(s2.cy - s1.cy).toBeCloseTo(-total / s1.scale, 9);
  });
});
