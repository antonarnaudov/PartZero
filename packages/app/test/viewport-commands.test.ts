import { beforeEach, describe, expect, it } from "vitest";
import { parseObj } from "../src/engine/obj";
import type { RenderBody } from "../src/engine/types";
import { raycast } from "../src/selection/raycast";
import type { RawHit } from "../src/selection/picking";
import type { AdapterCapabilities, DisplaySettings, HighlightRef, SectionPlane, ViewportAdapter } from "../src/viewport/adapter";
import type { DisplayMode } from "../src/viewport/display";
import { routedExecute, viewportCommands } from "../src/viewport/registry";
import { viewportRuntime, type ViewportRuntime } from "../src/viewport/runtime";
import {
  cameraFrame,
  defaultCamera,
  fitSphere,
  orbit,
  pan,
  sphereFromBox,
  standardViewOf,
  viewAngles,
  zoomAt,
  type CameraState,
  type Projection,
  type StandardView,
} from "../src/viewport/view-camera";
import { BOX, makeHarness, type Harness } from "./helpers";
import nemaObj from "./fixtures/nema17-plate.obj?raw";

const W = 900;
const H = 700;
const BODY = "plate/plate";

/** A renderer stand-in: the shared camera, a CPU pick, and a record of what it was told. */
class FakeAdapter implements ViewportAdapter {
  readonly kind = "placeholder" as const;
  readonly canvas = {} as HTMLCanvasElement;
  cam: CameraState = defaultCamera();
  bodies: readonly RenderBody[] = [];
  selection: readonly HighlightRef[] = [];
  hover: HighlightRef | null = null;
  display: DisplaySettings | null = null;
  section: SectionPlane | null = null;
  constructor(readonly native: readonly DisplayMode[] = []) {}
  backend(): string {
    return "fake";
  }
  capabilities(): AdapterCapabilities {
    return { nativeModes: this.native, transparency: this.native.includes("xray") };
  }
  setBodies(b: readonly RenderBody[]): void {
    this.bodies = b;
  }
  pick(x: number, y: number): Promise<RawHit | null> {
    const f = cameraFrame(this.cam, W, H);
    const { origin, dir } = f.ray(x, y);
    const topo = viewportRuntime(harness.services).topo;
    const h = raycast(topo, origin, dir);
    return Promise.resolve(h ? { kind: "face", body: h.body, face: h.face, point: h.point } : null);
  }
  setHover(p: HighlightRef | null): void {
    this.hover = p;
  }
  setSelection(p: readonly HighlightRef[]): void {
    this.selection = p;
  }
  fitView(): void {
    this.cam = fitSphere(this.cam, sphereFromBox([-25, -25, 0], [25, 25, 5]), W / H);
  }
  setView(v: StandardView): void {
    const [yaw, pitch] = viewAngles(v);
    this.cam = { ...this.cam, yaw, pitch };
  }
  setProjection(p: Projection): void {
    this.cam = { ...this.cam, projection: p };
  }
  setColors(): void {}
  setDisplay(s: DisplaySettings): void {
    this.display = s;
  }
  setSection(p: SectionPlane | null): void {
    this.section = p;
  }
  camera(): CameraState {
    return { ...this.cam };
  }
  setCamera(s: Partial<CameraState>): void {
    this.cam = { ...this.cam, ...s };
  }
  orbit(dx: number, dy: number): void {
    this.cam = orbit(this.cam, dx, dy);
  }
  pan(dx: number, dy: number): void {
    this.cam = pan(this.cam, dx, dy, H);
  }
  zoomAt(x: number, y: number, f: number): void {
    this.cam = zoomAt(this.cam, x, y, W, H, f);
  }
  size(): { width: number; height: number } {
    return { width: W, height: H };
  }
  resize(): void {}
  onFrame(): () => void {
    return () => undefined;
  }
  dispose(): void {}
}

let harness: Harness;
let rt: ViewportRuntime;
let adapter: FakeAdapter;
const exec = (id: string, args: Record<string, unknown> = {}) => routedExecute(harness.services, harness.commands, { id, args }, "test");

beforeEach(async () => {
  harness = await makeHarness({ source: BOX });
  rt = viewportRuntime(harness.services);
  rt.animationMs = 0;
  rt.setCommandRunner((cmd) => void harness.commands.executeUnknown(cmd, { source: "ui" }));
  adapter = new FakeAdapter();
  rt.attach(adapter);
  rt.setSceneBodies(parseObj(nemaObj));
  adapter.fitView();
});

describe("view commands", () => {
  it("turns to all seven standard views and orients to cube edges and corners", async () => {
    for (const v of ["front", "back", "left", "right", "top", "bottom", "iso"] as const) {
      expect(await exec("view.setView", { view: v })).toMatchObject({ ok: true, value: { view: v } });
      expect(standardViewOf(adapter.cam)).toBe(v);
      expect(rt.view.getState().view).toBe(v);
    }
    expect(await exec("view.lookAlong", { dir: [-1, 1, -1] })).toMatchObject({ ok: true, value: { view: "iso" } });
    expect(await exec("view.lookAlong", { dir: [0, 0, 0] })).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    // The Shift+1…7 shortcuts are commands too.
    expect(viewportCommands(harness.services).keymap().get("shift+5")).toBe("view.top");
  });

  it("refuses display modes the renderer cannot draw, emulates wireframe, applies grid toggles", async () => {
    const r = await exec("view.setDisplayMode", { mode: "xray" });
    expect(r).toMatchObject({ ok: false, error: { code: "FAILED" } });
    expect(r.ok ? "" : r.error.message).toMatch(/renderer/);
    expect(await exec("view.setDisplayMode", { mode: "wireframe" })).toMatchObject({ ok: true, value: { mode: "wireframe", drawn: "wireframe" } });
    expect(adapter.bodies[0]!.indices.length).toBe(0);
    expect(adapter.display).toMatchObject({ mode: "wireframe" });
    await exec("view.setDisplayMode", { mode: "shaded" });
    expect(adapter.bodies[0]!.indices.length).toBeGreaterThan(0);
    await exec("view.setToggle", { toggle: "grid", on: false });
    expect(adapter.display).toMatchObject({ grid: false, mode: "shaded" });
  });

  it("draws X-ray and hidden line natively when the renderer has display modes", async () => {
    const native = new FakeAdapter(["shaded", "shadedEdges", "wireframe", "hiddenLine", "xray"]);
    rt.attach(native);
    expect(await exec("view.setDisplayMode", { mode: "xray" })).toMatchObject({ ok: true, value: { drawn: "xray" } });
    expect(native.display).toMatchObject({ mode: "xray" });
    await exec("view.setDisplayMode", { mode: "wireframe" });
    // Native wireframe keeps the triangles (the renderer skips them itself).
    expect(native.bodies[0]!.indices.length).toBeGreaterThan(0);
  });

  it("colours, hides, isolates and shows bodies", async () => {
    expect(await exec("view.setBodyColor", { body: BODY, color: "#d4524a" })).toMatchObject({ ok: true, value: { color: "#d4524a" } });
    expect(adapter.bodies[0]!.color).toEqual([212 / 255, 82 / 255, 74 / 255]);
    expect(await exec("view.setBodyColor", { body: "nope/x", color: "#000000" })).toMatchObject({ ok: false });
    await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/cap:end" }] });
    await exec("view.setBodyVisible", { body: BODY, visible: false });
    expect(adapter.bodies).toHaveLength(0);
    expect(rt.selection.items).toHaveLength(0);
    expect(await exec("view.showAll")).toMatchObject({ ok: true });
    expect(adapter.bodies).toHaveLength(1);
    const snap = await exec("view.snapshot");
    expect(snap).toMatchObject({ ok: true, value: { colors: { [BODY]: "#d4524a" }, hidden: [] } });
  });

  it("sections along principal planes and from a face, with offset and flip", async () => {
    expect(await exec("view.section", { base: "XY" })).toMatchObject({ ok: true });
    expect(adapter.section).toEqual({ origin: [0, 0, 2.5], normal: [0, 0, 1] });
    await exec("view.setSectionOffset", { offset: 1 });
    expect(adapter.section?.origin).toEqual([0, 0, 1]);
    await exec("view.flipSection");
    expect(adapter.section?.normal).toEqual([-0, -0, -1]);
    expect(await exec("view.section", { base: "face" })).toMatchObject({ ok: false });
    await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/side:right" }] });
    expect(await exec("view.section", { base: "face", offset: -10 })).toMatchObject({ ok: true });
    expect(adapter.section?.normal[0]).toBeCloseTo(1, 9);
    expect(adapter.section?.origin[0]).toBeCloseTo(15, 9);
    await exec("view.clearSection");
    expect(adapter.section).toBeNull();
  });

  it("starts another document with a clean view: bodies visible, default colours, no section, no selection", async () => {
    await exec("view.setDisplayMode", { mode: "wireframe" });
    await exec("view.setBodyColor", { body: BODY, color: "#d4524a" });
    await exec("view.section", { base: "XZ" });
    await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/cap:end" }] });
    await exec("measure.toggle");
    await exec("view.setBodyVisible", { body: BODY, visible: false });
    expect(adapter.bodies).toHaveLength(0);
    expect(adapter.section).not.toBeNull();
    expect(rt.measure.getState().open).toBe(true);

    // Same body names as before (a template opened again): nothing carries over by name.
    harness.services.doc.load({ path: null, name: "again", format: "cadscript", source: BOX });
    expect(rt.view.getState().bodies).toEqual({});
    expect(rt.view.getState().section).toBeNull();
    expect(adapter.section).toBeNull();
    expect(rt.selection.items).toEqual([]);
    expect(rt.selection.getState().hover).toBeNull();
    expect(rt.measure.getState().open).toBe(false);
    rt.setSceneBodies(parseObj(nemaObj));
    expect(adapter.bodies).toHaveLength(1);
    expect(adapter.bodies[0]!.color).toBeUndefined();
    // Preferences are the user's and stay.
    expect(rt.view.getState().display).toBe("wireframe");
  });

  it("keeps the view when the same document regenerates", async () => {
    await exec("view.setBodyVisible", { body: BODY, visible: false });
    await exec("view.section", { base: "XY" });
    harness.services.doc.setSource(`${BOX}\n// edited\n`);
    await harness.services.doc.idle();
    expect(rt.view.getState().bodies[BODY]).toMatchObject({ visible: false });
    expect(rt.view.getState().section).not.toBeNull();
  });

  it("looks at a selected face and zooms to the selection", async () => {
    await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/side:right" }] });
    expect(await exec("view.normalTo")).toMatchObject({ ok: true });
    const f = cameraFrame(adapter.cam, W, H);
    expect(f.forward[0]).toBeCloseTo(-1, 9);
    expect(standardViewOf(adapter.cam)).toBe("right");
    await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/side:m3_a" }] });
    const before = adapter.cam.distance;
    await exec("view.zoomToSelection");
    expect(adapter.cam.distance).toBeLessThan(before / 4);
    expect(adapter.cam.target[0]).toBeCloseTo(15.5, 3);
    await exec("selection.set", { items: [] });
    expect(await exec("view.normalTo")).toMatchObject({ ok: false });
  });
});

describe("selection commands", () => {
  it("validates items against the scene and mirrors the primary into the document selection", async () => {
    expect(await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/side:nope" }] })).toMatchObject({ ok: false });
    const r = await exec("selection.set", {
      items: [
        { kind: "face", body: BODY, key: "plate/cap:end" },
        { kind: "edge", body: BODY, key: "plate/edge:{plate/cap:end|plate/side:top}" },
      ],
    });
    expect(r).toMatchObject({ ok: true, value: { items: [{ label: "End cap of plate" }, { label: "Edge: end cap / side top (plate)" }] } });
    await harness.services.doc.idle();
    expect(harness.services.doc.getState().selection.entity).toEqual({ body: BODY, face: "plate/cap:end" });
    expect(adapter.selection).toEqual([
      { body: BODY, face: "plate/cap:end" },
      { body: BODY, edge: "plate/edge:{plate/cap:end|plate/side:top}" },
    ]);
    // Escape (the app's selection.clear) clears the model selection too.
    await harness.commands.execute({ id: "selection.clear" });
    expect(rt.selection.items).toEqual([]);
  });

  it("filters by kind and box-selects through the command", async () => {
    await exec("selection.filterOnly", { kind: "edge" });
    const r = await exec("selection.box", { rect: { x0: 0, y0: 0, x1: W, y1: H } });
    expect(r.ok).toBe(true);
    expect(rt.selection.items.every((i) => i.kind === "edge")).toBe(true);
    expect(rt.selection.items.length).toBeGreaterThan(5);
    await exec("selection.filterAll");
    const v = [...rt.topo.bodies.get(BODY)!.vertices.values()][0]!;
    const t = await exec("selection.toggle", { item: { kind: "vertex", body: BODY, key: v.key } });
    expect(t).toMatchObject({ ok: true, value: { added: true } });
    expect(rt.selection.items.at(-1)).toMatchObject({ kind: "vertex", point: v.point });
    const all = await exec("selection.selectAll");
    expect(all).toMatchObject({ ok: true, value: { selected: 11 } });
  });

  it("clicks: plain click replaces, additive click toggles", async () => {
    const f = cameraFrame(adapter.cam, W, H);
    const top = f.project([0, 18, 5])!;
    await rt.clickAt(top.x, top.y, false);
    expect(rt.selection.items).toMatchObject([{ kind: "face", key: "plate/cap:end" }]);
    const side = f.project([25, 0, 2.5])!;
    await rt.clickAt(side.x, side.y, true);
    expect(rt.selection.items.map((i) => (i.kind === "face" ? i.key : ""))).toEqual(["plate/cap:end", "plate/side:right"]);
    await rt.clickAt(side.x, side.y, true);
    expect(rt.selection.items).toHaveLength(1);
    await rt.clickAt(2, 2, false);
    expect(rt.selection.items).toHaveLength(0);
  });
});

describe("measure commands", () => {
  it("measures the selection or given items, exact values without ≈", async () => {
    await exec("selection.set", { items: [{ kind: "face", body: BODY, key: "plate/cap:end" }, { kind: "face", body: BODY, key: "plate/cap:start" }] });
    const r = await exec("measure.selection");
    expect(r).toMatchObject({ ok: true, value: { result: { title: "Face ↔ Face" } } });
    const rows = (x: typeof r) => (x.ok ? (x.value as { result: { rows: Array<{ id: string; text: string; exact: boolean }> } }).result.rows : []);
    expect(rows(r)).toEqual(expect.arrayContaining([expect.objectContaining({ id: "distance", text: "5 mm", exact: true }), expect.objectContaining({ id: "angle", text: "0°" })]));
    const m = await exec("measure.items", { items: [{ kind: "face", body: BODY, key: "plate/side:pilot" }] });
    expect(rows(m)).toEqual([expect.objectContaining({ id: "radius", text: "11 mm" }), expect.objectContaining({ id: "diameter", text: "22 mm" }), expect.objectContaining({ id: "area", exact: true })]);
    expect(await exec("measure.toggle")).toMatchObject({ ok: true, value: { open: true } });
  });

  it("every viewport command has a JSON Schema (agent and MCP tools are generated from it)", () => {
    const d = viewportCommands(harness.services).describe();
    expect(d.length).toBeGreaterThan(40);
    for (const c of d) expect(c.argsSchema).toBeTruthy();
    expect(d.map((c) => c.id)).toEqual(expect.arrayContaining(["selection.get", "measure.selection", "view.snapshot"]));
  });
});
