import { describe, expect, it } from "vitest";
import type { RenderBody } from "../src/engine/types";
import { displayBodies, edgeFlags, effectiveMode, hexToRgb, modeAvailable, rgbToHex } from "../src/viewport/display";
import { angleAround, clamp, dragValue, gripPoint, perpendicular, rayLineParam, rayPlane, snap, unwrapDegrees } from "../src/viewport/manipulators/drag-math";
import { ManipulatorHost } from "../src/viewport/manipulators/host";
import { classifyWheel, dragRole, newWheelMemory, wheelDevice, wheelSignal, type NavPreset, type WheelLike } from "../src/viewport/navigation";
import { cubeCells, dirKey, visibleFaces } from "../src/viewport/view-cube-geometry";
import { anglesLookingAlong, basis, cameraFrame, defaultCamera, viewAngles, type Vec3 } from "../src/viewport/view-camera";
import { sectionPlane, ViewStore } from "../src/viewport/view-store";
import { macContinuous, macNotched, SEQUENCES } from "./fixtures/wheel-sequences";

const wheel = (p: Partial<WheelLike>): WheelLike => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false, timeStamp: 0, ...p });

describe("navigation: mouse and trackpad at the same time (FD3)", () => {
  it("tells a pinch, a notched mouse wheel and a trackpad scroll apart", () => {
    expect(wheelDevice(wheel({ ctrlKey: true, deltaY: 3.2 }))).toBe("pinch");
    expect(wheelDevice(wheel({ deltaMode: 1, deltaY: 3 }))).toBe("mouse");
    expect(wheelDevice(wheel({ deltaY: -100, wheelDeltaY: 120 }))).toBe("mouse");
    expect(wheelDevice(wheel({ deltaY: 4, wheelDeltaY: -12 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaX: 2, deltaY: 1 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaY: 1.5 }))).toBe("trackpad");
    expect(wheelDevice(wheel({ deltaY: 100 }))).toBe("mouse");
  });

  it("maps trackpad scroll to orbit, Shift+scroll to pan, pinch and wheel to zoom", () => {
    const m = newWheelMemory();
    expect(classifyWheel(wheel({ deltaX: 3, deltaY: -2, timeStamp: 0 }), m)).toEqual({ type: "orbit", dx: -3, dy: 2 });
    expect(classifyWheel(wheel({ deltaX: 3, deltaY: -2, shiftKey: true, timeStamp: 10 }), m)).toEqual({ type: "pan", dx: -3, dy: 2 });
    const pinch = classifyWheel(wheel({ ctrlKey: true, deltaY: 10, timeStamp: 20 }), m);
    expect(pinch?.type).toBe("zoom");
    expect(pinch?.type === "zoom" && pinch.factor).toBeGreaterThan(1);
    const zoomIn = classifyWheel(wheel({ deltaY: -100, timeStamp: 1000 }), newWheelMemory());
    expect(zoomIn?.type === "zoom" && zoomIn.factor).toBeLessThan(1);
  });

  it("keeps a gesture's device while its events keep coming", () => {
    const m = newWheelMemory();
    expect(classifyWheel(wheel({ deltaX: 1, deltaY: 2, timeStamp: 0 }), m)?.type).toBe("orbit");
    // A purely vertical integer delta alone would read as a mouse; mid-gesture it stays an orbit.
    expect(classifyWheel(wheel({ deltaY: 4, timeStamp: 50 }), m)?.type).toBe("orbit");
    expect(classifyWheel(wheel({ deltaY: 4, timeStamp: 1000 }), m)?.type).toBe("zoom");
  });

  const run = (events: readonly WheelLike[], preset: NavPreset = "auto") => {
    const m = newWheelMemory();
    return events.map((e) => classifyWheel(e, m, preset)?.type ?? null);
  };

  for (const seq of SEQUENCES) {
    it(`Auto reads Chromium's events right: ${seq.name}`, () => {
      expect(run(seq.events)).toEqual(seq.events.map(() => seq.expect));
    });
  }

  it("a Mac notch of exactly one line (40 px, wheelDelta 120) is a mouse, not the −3× trackpad signature", () => {
    // Both rules match this event: it must not be read as a trackpad on its own.
    const e = macNotched(1, 1, 0);
    expect(wheelSignal(e)).toMatchObject({ device: "mouse", strong: false });
    expect(classifyWheel(e, newWheelMemory())?.type).toBe("zoom");
    // …while the same numbers inside a trackpad gesture keep orbiting.
    const m = newWheelMemory();
    classifyWheel(macContinuous(0, 12, 0), m);
    expect(classifyWheel(macContinuous(0, 40, 16), m)?.type).toBe("orbit");
    // Unambiguous: wheelDelta in notches without the ratio, or the ratio without notches.
    expect(wheelSignal(macNotched(6554 / 65536, 1, 0))).toMatchObject({ device: "mouse", strong: true });
    expect(wheelSignal(macContinuous(0, 7, 0))).toMatchObject({ device: "trackpad", strong: true });
    // A sub-notch wheel event (wheelDelta 0) is never a Mac trackpad's.
    expect(wheelSignal({ ...macNotched(6554 / 65536, 0, 0) })).toMatchObject({ device: "mouse", strong: false });
  });

  it("Settings presets force the device (pinch always zooms)", () => {
    const trackpad = SEQUENCES.find((s) => s.expect === "orbit")!.events;
    const mouse = SEQUENCES.find((s) => s.name.startsWith("mac notched mouse, slow"))!.events;
    expect(new Set(run(trackpad, "mouse"))).toEqual(new Set(["zoom"]));
    expect(new Set(run(mouse, "trackpad"))).toEqual(new Set(["orbit"]));
    expect(new Set(run(mouse, "mouse"))).toEqual(new Set(["zoom"]));
    const pinch = SEQUENCES.find((s) => s.name.startsWith("mac pinch"))!.events;
    for (const p of ["auto", "mouse", "trackpad"] as const) expect(new Set(run(pinch, p))).toEqual(new Set(["zoom"]));
  });

  it("keeps the navigation preset as a preference", () => {
    const store = new ViewStore({ persist: false });
    expect(store.getState().navigation).toBe("auto");
    store.setNavigation("trackpad");
    expect(store.getState().navigation).toBe("trackpad");
  });

  it("maps pointer buttons: right orbits, middle pans, left selects (Alt+left navigates)", () => {
    const none = { shiftKey: false, altKey: false };
    expect(dragRole(2, none)).toBe("orbit");
    expect(dragRole(2, { shiftKey: true, altKey: false })).toBe("pan");
    expect(dragRole(1, none)).toBe("pan");
    expect(dragRole(0, none)).toBe("select");
    expect(dragRole(0, { shiftKey: false, altKey: true })).toBe("orbit");
    expect(dragRole(0, { shiftKey: true, altKey: true })).toBe("pan");
    expect(dragRole(3, none)).toBeNull();
  });
});

describe("view cube", () => {
  it("has 54 cells whose directions cover 6 faces, 12 edges and 8 corners", () => {
    const cells = cubeCells();
    expect(cells).toHaveLength(54);
    const keys = new Set(cells.map((c) => c.key));
    expect(keys.size).toBe(26);
    expect(cells.filter((c) => c.view).map((c) => c.view).sort()).toEqual(["back", "bottom", "front", "left", "right", "top"]);
    // Corner (+1, −1, +1) is the iso view direction.
    expect(keys.has(dirKey([1, -1, 1]))).toBe(true);
  });

  it("shows three faces from iso, front-most last, and a face's cell direction orients to that view", () => {
    const [yaw, pitch] = viewAngles("iso");
    const faces = visibleFaces(basis({ yaw, pitch }));
    expect(faces.map((f) => f.view).sort()).toEqual(["front", "right", "top"]);
    for (const c of cubeCells().filter((x) => x.view)) {
      const [y, p] = anglesLookingAlong(c.dir.map((v) => -v) as Vec3, viewAngles(c.view!)[0]);
      const [ey, ep] = viewAngles(c.view!);
      expect(p).toBeCloseTo(ep, 9);
      if (Math.abs(ep) < 1.5) expect(Math.cos(y - ey)).toBeCloseTo(1, 9);
    }
  });
});

describe("manipulator drag math", () => {
  it("projects the pointer ray onto a handle axis", () => {
    // A ray straight down through x = 7 meets the X axis at s = 7.
    expect(rayLineParam({ origin: [7, 0, 10], dir: [0, 0, -1] }, [0, 0, 0], [1, 0, 0])).toBeCloseTo(7, 12);
    expect(rayLineParam({ origin: [7, 0, 10], dir: [1, 0, 0] }, [0, 0, 0], [1, 0, 0])).toBeNull();
    expect(rayPlane({ origin: [1, 2, 5], dir: [0, 0, -1] }, [0, 0, 0], [0, 0, 1])).toEqual([1, 2, 0]);
    expect(rayPlane({ origin: [1, 2, 5], dir: [0, 0, 1] }, [0, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("snaps (1 mm, 0.5 with Shift, 15°) and clamps to the feasible range", () => {
    expect(snap(3.26, 0.5)).toBe(3.5);
    expect(snap(0.1 + 0.2, 0.1)).toBe(0.3);
    expect(clamp(5, 0, 3)).toEqual({ value: 3, clamped: "max" });
    expect(clamp(-1, 0, 3)).toEqual({ value: 0, clamped: "min" });
    const h = { id: "d", kind: "linear" as const, origin: [0, 0, 0] as Vec3, axis: [1, 0, 0] as Vec3, value: 10, max: 12 };
    expect(dragValue(h, { value: 10, param: 4 }, 5.3, { fine: false, snap: true })).toEqual({ value: 11 });
    expect(dragValue(h, { value: 10, param: 4 }, 5.3, { fine: true, snap: true })).toEqual({ value: 11.5 });
    expect(dragValue(h, { value: 10, param: 4 }, 9, { fine: false, snap: true })).toEqual({ value: 12, clamped: "max" });
    const r = { id: "a", kind: "rotate" as const, origin: [0, 0, 0] as Vec3, axis: [0, 0, 1] as Vec3, value: 0 };
    expect(dragValue(r, { value: 0, param: 170 }, -170, { fine: false, snap: true, accumulated: unwrapDegrees(-170 - 170) })).toEqual({ value: 15 });
  });

  it("measures angles around an axis from a reference and places grips", () => {
    expect(angleAround([0, 1, 0], [0, 0, 1], [1, 0, 0])).toBeCloseTo(90, 12);
    expect(angleAround([0, -1, 3], [0, 0, 1], [1, 0, 0])).toBeCloseTo(-90, 12);
    const p = perpendicular([0, 0, 1]);
    expect(Math.abs(p[2])).toBeLessThan(1e-12);
    expect(gripPoint({ id: "a", kind: "linear", origin: [1, 1, 1], axis: [0, 0, 2], value: 3 }, 10)).toEqual([1, 1, 4]);
    const g = gripPoint({ id: "r", kind: "rotate", origin: [0, 0, 0], axis: [0, 0, 1], ref: [1, 0, 0], value: 90 }, 10);
    expect(g[0]).toBeCloseTo(0, 9);
    expect(g[1]).toBeCloseTo(10, 9);
  });

  it("drives a drag through the host: start, snapped drags, end; Esc snaps back", () => {
    const host = new ManipulatorHost();
    const seen: string[] = [];
    const off = host.show([{ id: "depth", kind: "pushPull", origin: [0, 0, 0], axis: [0, 0, 1], value: 5, min: 0.5, max: 20 }], (c) => seen.push(`${c.phase}:${c.value}${c.clamped ? `:${c.clamped}` : ""}`));
    // Side view, orthographic: screen up is +Z.
    const [yaw, pitch] = viewAngles("front");
    const frame = cameraFrame({ ...defaultCamera(), yaw, pitch, distance: 100, target: [0, 0, 0], projection: "orthographic" }, 800, 600);
    const grip = frame.project([0, 0, 5])!;
    expect(host.begin("depth", frame, grip.x, grip.y)).toBe(true);
    const up3 = frame.project([0, 0, 8.2])!;
    expect(host.move(frame, up3.x, up3.y, { fine: false, snap: true })).toBe(8);
    const way = frame.project([0, 0, 40])!;
    expect(host.move(frame, way.x, way.y, { fine: false, snap: true })).toBe(20);
    expect(host.getState().active?.clamped).toBe("max");
    expect(host.end()).toBe(20);
    expect(host.begin("depth", frame, frame.project([0, 0, 20])!.x, frame.project([0, 0, 20])!.y)).toBe(true);
    host.move(frame, grip.x, grip.y, { fine: false, snap: true });
    host.cancelDrag();
    expect(host.handle("depth")!.value).toBe(20);
    expect(seen).toEqual(["start:5", "drag:8", "drag:20:max", "end:20", "start:20", "drag:5", "cancel:20"]);
    off();
    expect(host.getState().handles).toEqual([]);
  });

  it("clamps at once when the feasible range arrives during the drag (it is asked at drag start)", () => {
    const host = new ManipulatorHost();
    const seen: string[] = [];
    host.show([{ id: "r", kind: "radius", origin: [0, 0, 0], axis: [0, 0, 1], value: 2 }], (c) => seen.push(`${c.phase}:${c.value}${c.clamped ? `:${c.clamped}` : ""}`));
    const [yaw, pitch] = viewAngles("front");
    const frame = cameraFrame({ ...defaultCamera(), yaw, pitch, distance: 100, target: [0, 0, 0], projection: "orthographic" }, 800, 600);
    const grip = frame.project([0, 0, 2])!;
    host.begin("r", frame, grip.x, grip.y);
    const far = frame.project([0, 0, 30])!;
    expect(host.move(frame, far.x, far.y, { fine: false, snap: true })).toBe(30);
    host.update("r", { min: 0.01, max: 7.5, limitReason: "face width 15" });
    expect(host.handle("r")!.value).toBe(7.5);
    expect(host.getState().active).toEqual({ id: "r", value: 7.5, clamped: "max" });
    // A range that does not cut the value, or an update of another field, changes nothing.
    host.update("r", { max: 20 });
    expect(host.handle("r")!.value).toBe(7.5);
    expect(host.end()).toBe(7.5);
    expect(seen).toEqual(["start:2", "drag:30", "drag:7.5:max", "end:7.5"]);
  });
});

describe("sketches in the viewport", () => {
  it("places sketch curves on their plane (named frames and explicit frames)", async () => {
    const { sketchFrame, curvePoints2d, sketchPolylines } = await import("../src/viewport/sketches");
    expect(sketchFrame("XZ")).toEqual({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1] });
    const f = sketchFrame({ origin: [0, 0, 5], normal: [0, 0, 2], x_dir: [3, 0, 0] })!;
    expect(f.y).toEqual([0, 1, 0]);
    expect(sketchFrame({ face: "x" })).toBeNull();
    expect(curvePoints2d({ kind: "line", start: [0, 0], end: [1, 2] })).toEqual([[0, 0], [1, 2]]);
    const circle = curvePoints2d({ kind: "circle", center: [1, 1], radius: 2 })!;
    expect(circle).toHaveLength(49);
    for (const [x, y] of circle) expect(Math.hypot(x - 1, y - 1)).toBeCloseTo(2, 12);
    // A quarter arc counter-clockwise from +X to +Y, and the other way round clockwise.
    const ccw = curvePoints2d({ kind: "arc", start: [1, 0], end: [0, 1], center: [0, 0], ccw: true })!;
    expect(ccw.at(-1)![0]).toBeCloseTo(0, 12);
    expect(ccw.every(([x, y]) => x >= -1e-12 && y >= -1e-12)).toBe(true);
    const cw = curvePoints2d({ kind: "arc", start: [1, 0], end: [0, 1], center: [0, 0], ccw: false })!;
    expect(cw.some(([, y]) => y < -0.5)).toBe(true);
    const ir = {
      parts: [
        {
          features: [
            { type: "sketch", name: "s", plane: "YZ", curves: [{ kind: "line", id: "l", start: [0, 0], end: [2, 3] }] },
            { type: "sketch", name: "off", plane: "XY", suppressed: true, curves: [{ kind: "line", id: "l", start: [0, 0], end: [1, 1] }] },
            { type: "extrude", name: "e" },
          ],
        },
      ],
    };
    expect(sketchPolylines(ir)).toEqual([{ sketch: "s", curve: "l", points: [[0, 0, 0], [0, 2, 3]] }]);
    expect(sketchPolylines(null)).toEqual([]);
  });
});

describe("placeholder section clipping", () => {
  it("keeps the part of a triangle or segment on the kept side of the plane", async () => {
    const { clipByPlane } = await import("../src/viewport/placeholder");
    const plane = { origin: [1, 0, 0] as Vec3, normal: [1, 0, 0] as Vec3 };
    const tri = clipByPlane([[0, 0, 0], [2, 0, 0], [0, 2, 0]], plane);
    expect(tri).toEqual([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 2, 0]]);
    expect(clipByPlane([[2, 0, 0], [3, 0, 0], [2, 1, 0]], plane)).toEqual([]);
    const seg = clipByPlane([[3, 0, 0], [0, 0, 0]], plane);
    expect(seg.slice(0, 2)).toEqual([[1, 0, 0], [0, 0, 0]]);
  });
});

describe("display modes and body display", () => {
  const body = (name: string): RenderBody => ({
    name,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    faceRanges: [{ face: `${name}/cap:end`, start: 0, count: 1 }],
    edges: [{ edge: `${name}/edge:{a|b}`, points: new Float32Array([0, 0, 0, 1, 0, 0]) }],
  });

  it("hides bodies, applies colours and emulates wireframe when the renderer lacks it", () => {
    const states = new Map([
      ["p/a", { visible: false, color: null }],
      ["p/b", { visible: true, color: [1, 0, 0] as [number, number, number] }],
    ]);
    const out = displayBodies({ bodies: [body("p/a"), body("p/b"), body("p/c")], states, mode: "wireframe", nativeModes: [] });
    expect(out.map((b) => b.name)).toEqual(["p/b", "p/c"]);
    expect(out[0]!.color).toEqual([1, 0, 0]);
    expect(out[0]!.indices.length).toBe(0);
    expect(out[0]!.edges).toHaveLength(1);
    const native = displayBodies({ bodies: [body("p/c")], states: new Map(), mode: "wireframe", nativeModes: ["wireframe"] });
    expect(native[0]!.indices.length).toBe(3);
  });

  it("falls back from modes the renderer cannot draw, and maps edge flags", () => {
    expect(effectiveMode("xray", [])).toBe("shadedEdges");
    expect(effectiveMode("xray", ["xray"])).toBe("xray");
    expect(effectiveMode("wireframe", [])).toBe("wireframe");
    expect(modeAvailable("hiddenLine", [])).toBe(false);
    expect(edgeFlags("shaded")).toEqual({ edges: false, silhouettes: false });
    expect(edgeFlags("hiddenLine")).toEqual({ edges: true, silhouettes: true });
    expect(rgbToHex(hexToRgb("#4a82d4")!)).toBe("#4a82d4");
    expect(hexToRgb("nope")).toBeNull();
  });

  it("keeps section state: base plane, offset along the normal, flip", () => {
    const v = new ViewStore({ persist: false });
    v.setSection({ base: "XY", origin: [0, 0, 0], normal: [0, 0, 1], offset: 2.5, flipped: false });
    expect(sectionPlane(v.getState().section!)).toEqual({ origin: [0, 0, 2.5], normal: [0, 0, 1] });
    v.patchSection({ flipped: true, offset: 1 });
    expect(sectionPlane(v.getState().section!)).toEqual({ origin: [0, 0, 1], normal: [-0, -0, -1] });
    v.isolate(["p/a"], ["p/a", "p/b"]);
    expect([...v.hiddenBodies()]).toEqual(["p/b"]);
    v.showAll();
    expect(v.hiddenBodies().size).toBe(0);
  });
});
