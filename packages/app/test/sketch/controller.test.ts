/**
 * Sketch mode end to end on the real WASM session: every drawing tool, auto-constraints,
 * constraints from the palette, dimensions (numbers, expressions, `name = value`, driven), DOF,
 * conflicts, drags, trim/extend/offset/mirror/fillet/chamfer, undo/redo and finish.
 */
import { describe, expect, it } from "vitest";
import type { LiteralCurve } from "../../src/sketch/engine-types";
import { start } from "./harness";

const lines = (cs: readonly LiteralCurve[]): Array<Extract<LiteralCurve, { kind: "line" }>> => cs.filter((c): c is Extract<LiteralCurve, { kind: "line" }> => c.kind === "line");

describe("sketch mode", () => {
  it("draws a rectangle from the origin, dimensions it, and finishes fully constrained", async () => {
    const d = await start();
    const m = d.mode;
    expect(m.getState().phase).toBe("active");
    m.setTool("rect2");
    d.click([0.2, 0.1]); // snaps to the origin: fix(corner, 0, 0)
    d.click([40, 25]);
    let s = m.getState().snapshot!;
    expect(lines(s.curves)).toHaveLength(4);
    expect(s.dof).toBe(2);
    expect(s.constraints.map((c) => c.type)).toEqual(expect.arrayContaining(["horizontal", "vertical", "fix"]));

    // Dimension the bottom edge (a line) and the right edge.
    m.setTool("dimension");
    const bottom = lines(s.curves).find((l) => l.start[1] === 0 && l.end[1] === 0)!;
    d.click([20, 0]);
    d.click([20, -8]);
    expect(m.getState().dimEdit?.proposal?.shape).toMatchObject({ type: "distance" });
    m.setDimText("50");
    expect(m.commitDimension()).toBe(true);
    d.click([50, 12]); // the right edge moved to x = 50 with the width
    d.click([65, 12]);
    m.setDimText("30");
    expect(m.commitDimension()).toBe(true);
    s = m.getState().snapshot!;
    expect(s.status).toBe("fully_constrained");
    expect(s.entities.every((e) => e.dof === 0)).toBe(true);
    const b2 = s.curves.find((c) => c.id === bottom.id) as Extract<LiteralCurve, { kind: "line" }>;
    expect(Math.abs(b2.end[0] - b2.start[0])).toBeCloseTo(50, 9);

    // A third, conflicting dimension is refused with "make driven".
    d.click([0, 12]);
    d.click([-10, 12]);
    m.setDimText("20");
    expect(m.commitDimension()).toBe(false);
    expect(m.getState().dimEdit?.conflict).toBe(true);
    expect(m.makeDriven()).toBe(true);
    const ref = m.getState().snapshot!.constraints.find((c) => c.driving === false)!;
    expect(ref.measured).toBeCloseTo(30, 9);

    const f = await m.finish();
    expect(f).not.toBeNull();
    expect(f!.check.ok).toBe(true);
    expect(f!.check.regions).toBe(1);
    expect(f!.feature.type).toBe("sketch");
    expect(f!.feature.plane).toBe("XY");
    expect(d.sink.results).toHaveLength(1);
    expect(m.getState().phase).toBe("off");
  });

  it("chains lines with horizontal/vertical inference and closes the loop", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([10, 10]);
    d.click([50, 10.3]); // horizontal inference
    d.click([50.2, 40]); // vertical inference
    d.click([10, 10]); // closes on the first point: the chain ends
    const s = m.getState().snapshot!;
    expect(lines(s.curves)).toHaveLength(3);
    const types = s.constraints.map((c) => c.type);
    expect(types.filter((t) => t === "horizontal")).toHaveLength(1);
    expect(types.filter((t) => t === "vertical")).toHaveLength(1);
    expect(s.welds).toHaveLength(3);
    expect(s.profile.regions).toHaveLength(1);
    // The next click starts a new chain.
    d.click([100, 100]);
    d.click([120, 100]);
    expect(lines(m.getState().snapshot!.curves)).toHaveLength(4);
  });

  it("types a length while drawing a line, and a diameter while drawing a circle", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([5, 5]);
    d.move([30, 5.2]);
    d.type("25");
    expect(m.getState().typed?.label).toBe("Length");
    expect(m.commitTyped()).toBe(true);
    let s = m.getState().snapshot!;
    const l = lines(s.curves)[0]!;
    expect(Math.hypot(l.end[0] - l.start[0], l.end[1] - l.start[1])).toBeCloseTo(25, 9);
    expect(s.constraints.some((c) => c.type === "distance" && c.value === 25)).toBe(true);
    d.key("Escape");
    m.setTool("circleCenter");
    d.click([100, 100]);
    d.move([110, 100]);
    d.type("12");
    expect(m.commitTyped()).toBe(true);
    s = m.getState().snapshot!;
    const c = s.curves.find((x) => x.kind === "circle") as Extract<LiteralCurve, { kind: "circle" }>;
    expect(c.radius).toBeCloseTo(6, 9);
  });

  it("draws every shape tool", async () => {
    const d = await start();
    const m = d.mode;
    const count = (): number => m.getState().snapshot!.curves.length;
    m.setTool("rectCenter");
    d.click([100, 100]);
    d.click([120, 110]);
    expect(count()).toBe(6); // 4 lines + construction diagonal + centre point
    m.setTool("circle2");
    d.click([200, 0]);
    d.click([220, 0]);
    m.setTool("circle3");
    d.click([300, 0]);
    d.click([310, 10]);
    d.click([320, 0]);
    m.setTool("arc3");
    d.click([400, 0]);
    d.click([440, 0]);
    d.click([420, 15]);
    m.setTool("arcCenter");
    d.click([500, 0]);
    d.click([520, 0]);
    d.move([514, 14]);
    d.move([500, 20]);
    d.click([500, 20]);
    m.setTool("slot");
    d.click([600, 0]);
    d.click([640, 0]);
    d.click([620, 6]);
    m.setTool("polygon");
    d.type("5");
    m.commitTyped();
    d.click([700, 0]);
    d.click([715, 0]);
    m.setTool("point");
    d.click([800, 5]);
    const s = m.getState().snapshot!;
    expect(s.ok).toBe(true);
    const kinds = s.curves.reduce<Record<string, number>>((a, c) => ({ ...a, [c.kind]: (a[c.kind] ?? 0) + 1 }), {});
    // rectCenter 5 lines; slot 2 lines; polygon 5 lines → 12 lines. circles: 2 + polygon's construction circle.
    expect(kinds["line"]).toBe(12);
    expect(kinds["circle"]).toBe(3);
    expect(kinds["arc"]).toBe(4); // 3-point, centre, 2 slot caps
    expect(kinds["point"]).toBe(2);
    // The slot's caps are tangent and equal; the polygon's sides equal.
    const types = s.constraints.map((c) => c.type);
    expect(types.filter((t) => t === "tangent")).toHaveLength(4);
    expect(types.filter((t) => t === "equal").length).toBeGreaterThanOrEqual(5);
    // A tangent arc continues from a line end.
    m.setTool("line");
    d.click([0, 200]);
    d.click([30, 200]);
    d.key("Escape");
    m.setTool("arcTangent");
    d.click([30, 200]);
    d.click([40, 210]);
    const s2 = m.getState().snapshot!;
    expect(s2.constraints.filter((c) => c.type === "tangent")).toHaveLength(5);
    expect(s2.ok).toBe(true);
  });

  it("adds palette constraints to a selection and explains conflicts", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([0, 0], { alt: true });
    d.click([30, 7], { alt: true });
    d.key("Escape");
    d.click([0, 20], { alt: true });
    d.click([30, 31], { alt: true });
    d.key("Escape");
    const [a, b] = lines(m.getState().snapshot!.curves);
    m.setTool("select");
    m.select([{ kind: "curve", id: a!.id }, { kind: "curve", id: b!.id }]);
    expect(m.constrain("parallel")).toBe(true);
    m.select([{ kind: "curve", id: a!.id }]);
    expect(m.constrain("horizontal")).toBe(true);
    let s = m.getState().snapshot!;
    const b2 = s.curves.find((c) => c.id === b!.id) as Extract<LiteralCurve, { kind: "line" }>;
    expect(b2.end[1]).toBeCloseTo(b2.start[1], 9);
    // Vertical on the same line conflicts with horizontal.
    m.select([{ kind: "curve", id: a!.id }]);
    expect(m.constrain("vertical")).toBe(false);
    expect(m.getState().notice?.kind).toBe("error");
    // Equal lengths, then delete the constraint by selection.
    m.select([{ kind: "curve", id: a!.id }, { kind: "curve", id: b!.id }]);
    expect(m.constrain("equal")).toBe(true);
    s = m.getState().snapshot!;
    const eq = s.constraints.find((c) => c.type === "equal")!;
    m.select([{ kind: "constraint", id: eq.id }]);
    m.deleteSelection();
    expect(m.getState().snapshot!.constraints.some((c) => c.type === "equal")).toBe(false);
    // Construction toggle.
    m.select([{ kind: "curve", id: a!.id }]);
    d.key("x");
    expect(m.getState().snapshot!.curves.find((c) => c.id === a!.id)!.construction).toBe(true);
  });

  it("binds dimensions to expressions and new parameters", async () => {
    const document = { schema: "aicad.ir/1", params: [{ name: "width", unit: "mm", value: 12 }], parts: [{ id: "p", name: "p", features: [] }] } as unknown as import("@aicad/ir-types").v1.IrDocument;
    const d = await start({ document });
    const m = d.mode;
    m.setTool("line");
    d.click([0, 0], { alt: true });
    d.click([10, 3], { alt: true });
    d.key("Escape");
    m.setTool("dimension");
    d.click([5, 1.5]);
    d.click([5, -5]);
    m.setDimText("width * 2");
    expect(m.commitDimension()).toBe(true);
    let c = m.getState().snapshot!.constraints.find((x) => x.type === "distance")!;
    expect(c.expr).toBe("width * 2");
    expect(c.measured).toBeCloseTo(24, 9);
    m.editDimension(c.id);
    m.setDimText("depth = 7");
    expect(m.commitDimension()).toBe(true);
    c = m.getState().snapshot!.constraints.find((x) => x.id === c.id)!;
    expect(c.expr).toBe("depth");
    expect(c.measured).toBeCloseTo(7, 9);
    m.editDimension(c.id);
    m.setDimText("nope +");
    expect(m.commitDimension()).toBe(false);
    expect(m.getState().dimEdit?.error).toBeTruthy();
    m.cancelDimension();
    const f = await m.finish({ force: true });
    expect(f!.params.map((p) => p.name)).toEqual(["depth"]);
  });

  it("drags geometry within its constraints", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("rect2");
    d.click([0.1, 0.1]);
    d.click([40, 20]);
    m.setTool("select");
    d.drag([40, 20], [60, 30]);
    const s = m.getState().snapshot!;
    const pts = lines(s.curves).flatMap((l) => [l.start, l.end]);
    expect(pts.some((p) => Math.abs(p[0] - 60) < 1e-3 && Math.abs(p[1] - 30) < 1e-3)).toBe(true);
    expect(pts.some((p) => p[0] === 0 && p[1] === 0)).toBe(true); // the fixed corner stays
    expect(s.status).toBe("under_constrained");
    // Undo restores the rectangle; redo the drag.
    m.undo();
    expect(lines(m.getState().snapshot!.curves).some((l) => l.end[0] === 40 || l.start[0] === 40)).toBe(true);
    m.redo();
    expect(lines(m.getState().snapshot!.curves).flatMap((l) => [l.start, l.end]).some((p) => Math.abs(p[0] - 60) < 1e-3)).toBe(true);
    // Box select (window) picks the four lines.
    d.drag([-5, -5], [70, 40]);
    expect(m.getState().selection.filter((x) => x.kind === "curve")).toHaveLength(4);
  });

  it("trims, extends, offsets, mirrors, fillets and chamfers", async () => {
    const d = await start();
    const m = d.mode;
    // A cross: trim the right arm away.
    m.setTool("line");
    d.click([-20, 0], { alt: true });
    d.click([20, 0], { alt: true });
    d.key("Escape");
    d.click([0, -20], { alt: true });
    d.click([0, 20], { alt: true });
    d.key("Escape");
    m.setTool("trim");
    d.click([12, 0]);
    let s = m.getState().snapshot!;
    const h = lines(s.curves).find((l) => l.start[1] === 0 && l.end[1] === 0)!;
    expect(Math.max(h.start[0], h.end[0])).toBeCloseTo(0, 9);
    expect(s.constraints.some((c) => c.type === "point_on_line")).toBe(true);
    // Extend a short line to the vertical one.
    m.setTool("line");
    d.click([10, 10], { alt: true });
    d.click([5, 10], { alt: true });
    d.key("Escape");
    m.setTool("extend");
    d.click([5.5, 10]);
    s = m.getState().snapshot!;
    expect(lines(s.curves).some((l) => (l.end[0] === 0 && l.end[1] === 10) || (Math.abs(l.end[0]) < 1e-9 && Math.abs(l.end[1] - 10) < 1e-9))).toBe(true);

    // Fillet and chamfer rectangle corners, offset its bottom, mirror a circle.
    m.setTool("rect2");
    d.click([100, 100], { alt: true });
    d.click([140, 120], { alt: true });
    m.setTool("fillet");
    d.click([140, 100]);
    d.type("5");
    expect(m.commitTyped()).toBe(true);
    s = m.getState().snapshot!;
    const arc = s.curves.find((c) => c.kind === "arc");
    expect(arc).toBeDefined();
    expect(s.constraints.filter((c) => c.type === "tangent")).toHaveLength(2);
    expect(s.constraints.find((c) => c.type === "radius")?.value).toBe(5);
    m.setTool("chamfer");
    d.click([100, 120]);
    d.type("3");
    expect(m.commitTyped()).toBe(true);
    const before = m.getState().snapshot!.curves.length;
    m.setTool("offset");
    d.click([120, 100]);
    d.move([120, 95]);
    d.type("4");
    expect(m.commitTyped()).toBe(true);
    expect(m.getState().snapshot!.curves.length).toBe(before + 1);
    m.setTool("circleCenter");
    d.click([200, 30], { alt: true });
    d.click([205, 30], { alt: true });
    m.setTool("line");
    d.click([220, 0], { alt: true });
    d.click([220, 60], { alt: true });
    d.key("Escape");
    s = m.getState().snapshot!;
    const circle = s.curves.find((c) => c.kind === "circle")!;
    const axis = lines(s.curves).find((l) => l.start[0] === 220)!;
    m.setTool("select");
    m.select([{ kind: "curve", id: circle.id }]);
    m.setTool("mirror");
    d.click([220, 30]);
    s = m.getState().snapshot!;
    const circles = s.curves.filter((c): c is Extract<LiteralCurve, { kind: "circle" }> => c.kind === "circle");
    expect(circles).toHaveLength(2);
    expect(circles.some((c) => Math.abs(c.center[0] - 240) < 1e-9)).toBe(true);
    expect(s.constraints.some((c) => c.type === "symmetric")).toBe(true);
    expect(axis).toBeDefined();
    expect(s.ok).toBe(true);
  });

  it("cancels without committing, and Esc unwinds tool → selection → finish", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("circleCenter");
    d.click([0, 0]);
    d.click([10, 0]);
    m.cancel();
    expect(m.getState().phase).toBe("off");
    expect(d.sink.results).toHaveLength(0);

    const d2 = await start();
    d2.mode.setTool("rect2");
    d2.click([0, 0]);
    d2.click([10, 10]);
    expect(d2.key("Escape")).toBe(true); // leaves the tool
    expect(d2.mode.getState().tool).toBe("select");
    expect(d2.key("Escape")).toBe(true); // finishes
    await new Promise((r) => setTimeout(r, 0));
    expect(d2.sink.results).toHaveLength(1);
  });

  it("refuses to finish a failing sketch unless forced", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([0, 0]);
    d.click([10, 5]);
    d.key("Escape");
    expect(await m.finish()).toBeNull();
    expect(m.getState().notice?.text).toMatch(/would fail/);
    const f = await m.finish({ force: true });
    expect(f?.check.ok).toBe(false);
    expect(f?.check.error?.code).toBe("SKETCH_OPEN_LOOP");
  });
});
