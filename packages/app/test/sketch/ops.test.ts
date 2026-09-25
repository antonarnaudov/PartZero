/**
 * The sketch modify operations one by one, on the real WASM session, with geometric assertions:
 * tangency and radius of a fillet, the legs of a chamfer, offset distances, mirrored coordinates,
 * and which constraints each operation keeps, moves or drops.
 */
import { describe, expect, it } from "vitest";
import type { v1 } from "@aicad/ir-types";
import type { LiteralCurve, SketchSnapshot } from "../../src/sketch/engine-types";
import type { P2 } from "../../src/sketch/geom";
import { start, type Driver } from "./harness";

type Line = Extract<LiteralCurve, { kind: "line" }>;
type Arc = Extract<LiteralCurve, { kind: "arc" }>;
type Circle = Extract<LiteralCurve, { kind: "circle" }>;

const lines = (cs: readonly LiteralCurve[]): Line[] => cs.filter((c): c is Line => c.kind === "line");
const byId = <T extends LiteralCurve>(s: SketchSnapshot, id: string): T => s.curves.find((c) => c.id === id) as T;
const near = (p: P2, q: P2, tol = 1e-9): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;
const sub = (a: P2, b: P2): P2 => [a[0] - b[0], a[1] - b[1]];
const dot = (a: P2, b: P2): number => a[0] * b[0] + a[1] * b[1];
const len = (a: P2): number => Math.hypot(a[0], a[1]);

/** Distance from `p` to the infinite line through `l`. */
function distToLine(p: P2, l: Line): number {
  const d = sub(l.end, l.start);
  return Math.abs(d[0] * (p[1] - l.start[1]) - d[1] * (p[0] - l.start[0])) / len(d);
}

/** The line ending (or starting) at `p`. */
function lineAt(s: SketchSnapshot, p: P2, tol = 1e-9): Line {
  const l = lines(s.curves).find((x) => !x.construction && (near(x.start, p, tol) || near(x.end, p, tol)));
  if (!l) throw new Error(`no line ends at ${p.join(", ")}`);
  return l;
}

const PARAMS_DOC = {
  schema: "aicad.ir/1",
  params: [{ name: "height", unit: "mm", value: 30 }],
  parts: [{ id: "p", name: "p", features: [] }],
} as unknown as v1.IrDocument;

/**
 * A fully constrained 50 × `height` rectangle from the origin: rect2 snapped to the origin
 * (fix), H/V from the tool, a literal width dimension and a height bound to the parameter.
 */
async function constrainedRect(): Promise<{ d: Driver; width: string; height: string }> {
  const d = await start({ document: PARAMS_DOC });
  const m = d.mode;
  m.setTool("rect2");
  d.click([0.1, 0.1]);
  d.click([40, 25]);
  m.setTool("dimension");
  d.click([20, 0]);
  d.click([20, -8]);
  m.setDimText("50");
  expect(m.commitDimension()).toBe(true);
  d.click([50, 12]);
  d.click([62, 12]);
  m.setDimText("height");
  expect(m.commitDimension()).toBe(true);
  const s = m.getState().snapshot!;
  expect(s.status).toBe("fully_constrained");
  const width = s.constraints.find((c) => c.type === "distance" && c.value === 50)!.id;
  const height = s.constraints.find((c) => c.type === "distance" && c.expr === "height")!.id;
  m.setTool("select");
  return { d, width, height };
}

/** Fillet (or chamfer) the corner at `vertex` with a typed size. */
function corner(d: Driver, tool: "fillet" | "chamfer", vertex: P2, size: string): void {
  d.mode.setTool(tool);
  d.click(vertex);
  d.type(size);
  expect(d.mode.commitTyped()).toBe(true);
}

describe("sketch fillet", () => {
  it("rounds a corner with a tangent arc of the typed radius", async () => {
    const { d } = await constrainedRect();
    corner(d, "fillet", [50, 0], "5");
    const s = d.mode.getState().snapshot!;
    expect(s.ok).toBe(true);
    const arc = s.curves.find((c): c is Arc => c.kind === "arc")!;
    // Radius 5 at both ends, centre 5 in from both edges of the 90° corner.
    expect(len(sub(arc.start, arc.center))).toBeCloseTo(5, 9);
    expect(len(sub(arc.end, arc.center))).toBeCloseTo(5, 9);
    expect(near(arc.center, [45, 5], 1e-9)).toBe(true);
    // Tangent where it meets each line: the radius is perpendicular to the line there, and the
    // tangent points sit r / tan(45°) = 5 from the old vertex.
    for (const end of [arc.start, arc.end]) {
      const l = lineAt(s, end);
      expect(Math.abs(dot(sub(l.end, l.start), sub(end, arc.center))) / len(sub(l.end, l.start))).toBeLessThan(1e-9);
      expect(len(sub(end, [50, 0]))).toBeCloseTo(5, 9);
    }
    expect(s.constraints.filter((c) => c.type === "tangent")).toHaveLength(2);
    expect(s.constraints.find((c) => c.type === "radius")?.value).toBe(5);
  });

  it("keeps a fully constrained rectangle fully constrained, with its dimensions and their parameter", async () => {
    const { d, width, height } = await constrainedRect();
    const before = d.mode.getState().snapshot!;
    const fix = before.constraints.find((c) => c.type === "fix")!.id;
    corner(d, "fillet", [50, 0], "5");
    let s = d.mode.getState().snapshot!;
    expect(s.status).toBe("fully_constrained");
    expect(s.dof).toBe(0);
    expect(s.redundant).toHaveLength(0);
    // The same dimension ids, values and binding; the width is now measured to the virtual sharp.
    expect(s.constraints.find((c) => c.id === width)).toMatchObject({ value: 50, driving: true });
    expect(s.constraints.find((c) => c.id === height)).toMatchObject({ expr: "height" });
    expect(s.constraints.find((c) => c.id === height)!.measured).toBeCloseTo(30, 9);
    const vs = s.curves.find((c) => c.kind === "point" && c.construction) as Extract<LiteralCurve, { kind: "point" }>;
    expect(near(vs.at, [50, 0])).toBe(true);
    const f = d.mode.getState().feature!;
    const w = f.constraints!.find((c) => c.id === width) as Extract<v1.Constraint, { type: "distance" }>;
    expect([w.a, w.b]).toContain(vs.id);

    // Fillet the fixed origin corner too: the fix moves to that corner's virtual sharp.
    corner(d, "fillet", [0, 0], "3");
    s = d.mode.getState().snapshot!;
    expect(s.status).toBe("fully_constrained");
    const fx = d.mode.getState().feature!.constraints!.find((c) => c.id === fix) as Extract<v1.Constraint, { type: "fix" }>;
    const vs2 = s.curves.find((c) => c.kind === "point" && c.id === fx.entity) as Extract<LiteralCurve, { kind: "point" }>;
    expect(vs2.construction).toBe(true);
    expect(near(vs2.at, [0, 0])).toBe(true);

    // The rounded rectangle still follows its dimensions: a wider width moves the fillet.
    d.mode.editDimension(width);
    d.mode.setDimText("60");
    expect(d.mode.commitDimension()).toBe(true);
    s = d.mode.getState().snapshot!;
    expect(s.status).toBe("fully_constrained");
    const arc = s.curves.filter((c): c is Arc => c.kind === "arc").find((a) => a.center[0] > 30)!;
    expect(near(arc.center, [55, 5], 1e-8)).toBe(true);

    const fin = await d.mode.finish();
    expect(fin!.check.ok).toBe(true);
    expect(fin!.feature.constraints!.some((c) => c.id === height && c.type === "distance" && c.value === "height")).toBe(true);
  });

  it("binds a centre rectangle's construction diagonal to the virtual sharp", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("rectCenter");
    d.click([0.1, 0.1]); // the centre on the origin
    d.click([20, 10]);
    const dofBefore = m.getState().snapshot!.dof!;
    corner(d, "fillet", [-20, -10], "2");
    const s = m.getState().snapshot!;
    expect(s.ok).toBe(true);
    expect(s.dof).toBe(dofBefore);
    const diag = lines(s.curves).find((l) => l.construction)!;
    expect(near(diag.start, [-20, -10]) || near(diag.end, [-20, -10])).toBe(true);
    expect(m.getState().feature!.constraints!.some((c) => c.type === "coincident" && [c.a, c.b].some((x) => x.startsWith(diag.id)))).toBe(true);
  });

  it("names the constraints that can no longer hold (equal lengths of a shortened line)", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("rect2");
    d.click([100, 100], { alt: true });
    d.click([140, 130], { alt: true });
    const s0 = m.getState().snapshot!;
    const [bottom, , top] = [lineAt(s0, [100, 100]), null, lineAt(s0, [140, 130])];
    m.setTool("select");
    m.select([{ kind: "curve", id: bottom.id }, { kind: "curve", id: top.id }]);
    expect(m.constrain("equal")).toBe(true);
    corner(d, "fillet", [140, 100], "4");
    const s = m.getState().snapshot!;
    expect(s.ok).toBe(true);
    expect(s.constraints.some((c) => c.type === "equal")).toBe(false);
    expect(m.getState().notice?.text).toMatch(/Removed 1 constraint .*equal/);
  });
});

describe("sketch chamfer", () => {
  it("cuts the typed leg distance along both lines and keeps the rectangle fully constrained", async () => {
    const { d, width, height } = await constrainedRect();
    corner(d, "chamfer", [50, 30], "4");
    const s = d.mode.getState().snapshot!;
    expect(s.status).toBe("fully_constrained");
    // The chamfer line joins the points 4 from the old corner along each edge.
    const cut = lines(s.curves).find((l) => !near(sub(l.end, l.start), [0, 0]) && Math.abs(l.end[0] - l.start[0]) > 1e-6 && Math.abs(l.end[1] - l.start[1]) > 1e-6)!;
    const ends = [cut.start, cut.end];
    expect(ends.some((p) => near(p, [46, 30], 1e-9))).toBe(true);
    expect(ends.some((p) => near(p, [50, 26], 1e-9))).toBe(true);
    // The legs are the dimensions, with the typed value (not the diagonal).
    const legs = s.constraints.filter((c) => c.type === "distance" && c.id !== width && c.id !== height);
    expect(legs.map((c) => c.value)).toEqual([4, 4]);
    expect(s.constraints.find((c) => c.id === height)).toMatchObject({ expr: "height" });
  });

  it("chamfers a construction corner with a construction line", async () => {
    const d = await start();
    const m = d.mode;
    m.toggleConstruction(); // new curves are construction
    m.setTool("rect2");
    d.click([0, 0], { alt: true });
    d.click([20, 10], { alt: true });
    corner(d, "chamfer", [20, 10], "2");
    const s = m.getState().snapshot!;
    expect(s.ok).toBe(true);
    expect(lines(s.curves)).toHaveLength(5);
    expect(lines(s.curves).every((l) => l.construction)).toBe(true);
  });
});

describe("sketch trim and extend", () => {
  it("trims the clicked piece, binds the new end to the cutter and names the dropped length", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([-20, 0], { alt: true });
    d.click([20, 0], { alt: true });
    d.key("Escape");
    d.click([0, -20], { alt: true });
    d.click([0, 20], { alt: true });
    d.key("Escape");
    let s = m.getState().snapshot!;
    const h = lines(s.curves).find((l) => l.start[1] === 0 && l.end[1] === 0)!;
    const v = lines(s.curves).find((l) => l.id !== h.id)!;
    m.setTool("select");
    m.select([{ kind: "curve", id: h.id }]);
    expect(m.constrain("horizontal")).toBe(true);
    m.setTool("dimension");
    d.click([-10, 0]);
    d.click([-10, -6]);
    m.setDimText("40");
    expect(m.commitDimension()).toBe(true);
    const len40 = m.getState().snapshot!.constraints.find((c) => c.type === "distance")!.id;
    m.setTool("trim");
    d.click([12, 0]);
    s = m.getState().snapshot!;
    const h2 = byId<Line>(s, h.id);
    // The kept piece runs from the far end to the cutter, exactly on it.
    expect(near(h2.start, [-20, 0])).toBe(true);
    expect(Math.abs(h2.end[0])).toBeLessThan(1e-9);
    expect(distToLine(h2.end, byId<Line>(s, v.id))).toBeLessThan(1e-9);
    const f = m.getState().feature!;
    expect(f.constraints!.some((c) => c.type === "point_on_line" && c.point === `${h.id}.end` && c.line === v.id)).toBe(true);
    // Horizontal stays; the length dimension of the trimmed line goes, by name.
    expect(f.constraints!.some((c) => c.type === "horizontal" && c.line === h.id)).toBe(true);
    expect(f.constraints!.some((c) => c.id === len40)).toBe(false);
    expect(m.getState().notice?.text).toContain(len40);
  });

  it("extends a line along its direction onto the next curve, keeping its other end", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([0, -20], { alt: true });
    d.click([0, 20], { alt: true });
    d.key("Escape");
    d.click([10, 5], { alt: true });
    d.click([4, 8], { alt: true }); // a slanted line pointing at x = 0
    d.key("Escape");
    let s = m.getState().snapshot!;
    const l = lines(s.curves).find((x) => x.start[0] === 10)!;
    const dir0 = sub(l.end, l.start);
    m.setTool("select");
    m.select([{ kind: "point", ref: `${l.id}.start` }]);
    expect(m.constrain("fix")).toBe(true);
    m.setTool("extend");
    d.click([4.5, 7.75]);
    s = m.getState().snapshot!;
    const l2 = byId<Line>(s, l.id);
    expect(near(l2.start, [10, 5])).toBe(true);
    expect(Math.abs(l2.end[0])).toBeLessThan(1e-9);
    expect(l2.end[1]).toBeCloseTo(10, 9); // along the original direction: (10,5) + t·(−6, 3)
    const dir1 = sub(l2.end, l2.start);
    expect(Math.abs(dir0[0] * dir1[1] - dir0[1] * dir1[0])).toBeLessThan(1e-9);
    expect(m.getState().feature!.constraints!.some((c) => c.type === "fix" && c.entity === `${l.id}.start`)).toBe(true);
  });
});

describe("sketch offset and mirror", () => {
  it("offsets a closed rectangle by the typed distance, joined at the corners", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("rect2");
    d.click([0, 0], { alt: true });
    d.click([40, 20], { alt: true });
    const orig = lines(m.getState().snapshot!.curves);
    m.setTool("select");
    m.select(orig.map((l) => ({ kind: "curve" as const, id: l.id })));
    m.setTool("offset");
    d.click([20, 0]);
    d.move([20, -3]); // outside
    d.type("2");
    expect(m.commitTyped()).toBe(true);
    const s = m.getState().snapshot!;
    expect(s.ok).toBe(true);
    const added = lines(s.curves).filter((l) => !orig.some((o) => o.id === l.id));
    expect(added).toHaveLength(4);
    // Each copy is parallel to its original at distance 2, on the outside.
    for (const o of orig) {
      const copy = added.find((a) => Math.abs(distToLine(a.start, o) - 2) < 1e-9 && Math.abs(distToLine(a.end, o) - 2) < 1e-9);
      expect(copy, `offset of ${o.id}`).toBeDefined();
    }
    const xs = added.flatMap((l) => [l.start[0], l.end[0]]);
    const ys = added.flatMap((l) => [l.start[1], l.end[1]]);
    expect(Math.min(...xs)).toBeCloseTo(-2, 9);
    expect(Math.max(...xs)).toBeCloseTo(42, 9);
    expect(Math.min(...ys)).toBeCloseTo(-2, 9);
    expect(Math.max(...ys)).toBeCloseTo(22, 9);
    // Joined: every corner of the copy is shared by two copy lines.
    const ends = added.flatMap((l) => [l.start, l.end]);
    for (const p of ends) expect(ends.filter((q) => near(p, q, 1e-9))).toHaveLength(2);
    // One region: the 2 mm frame between the copy and the original (a hole).
    expect(s.profile.regions).toHaveLength(1);
    expect(s.profile.regions[0]!.holes).toHaveLength(1);
    expect(s.profile.regions[0]!.area).toBeCloseTo(44 * 24 - 40 * 20, 9);
  });

  it("offsets a circle concentrically", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("circleCenter");
    d.click([10, 10], { alt: true });
    d.click([15, 10], { alt: true });
    const c = m.getState().snapshot!.curves.find((x): x is Circle => x.kind === "circle")!;
    m.setTool("offset");
    d.click([15, 10]);
    d.move([13, 10]); // inside
    d.type("1.5");
    expect(m.commitTyped()).toBe(true);
    const s = m.getState().snapshot!;
    const inner = s.curves.find((x): x is Circle => x.kind === "circle" && x.id !== c.id)!;
    expect(inner.radius).toBeCloseTo(3.5, 9);
    expect(near(inner.center, c.center)).toBe(true);
  });

  it("mirrors a line, an arc and a circle to exact mirror coordinates", async () => {
    const d = await start();
    const m = d.mode;
    m.setTool("line");
    d.click([0, -50], { alt: true });
    d.click([0, 50], { alt: true }); // the axis x = 0
    d.key("Escape");
    d.click([5, 5], { alt: true });
    d.click([15, 8], { alt: true });
    d.key("Escape");
    m.setTool("circleCenter");
    d.click([12, 20], { alt: true });
    d.click([15, 20], { alt: true });
    m.setTool("arc3");
    d.click([5, 30], { alt: true });
    d.click([15, 30], { alt: true });
    d.click([10, 34], { alt: true });
    let s = m.getState().snapshot!;
    const axis = lines(s.curves).find((l) => l.start[0] === 0)!;
    const src = s.curves.filter((c) => c.id !== axis.id);
    m.setTool("select");
    m.select(src.map((c) => ({ kind: "curve" as const, id: c.id })));
    m.setTool("mirror");
    d.click([0, 0]);
    s = m.getState().snapshot!;
    expect(s.ok).toBe(true);
    const mir = (p: P2): P2 => [-p[0], p[1]];
    for (const c of src) {
      const copies = s.curves.filter((x) => x.kind === c.kind && !src.some((o) => o.id === x.id) && x.id !== axis.id);
      if (c.kind === "line") expect(copies.some((x) => x.kind === "line" && near(x.start, mir(c.start)) && near(x.end, mir(c.end)))).toBe(true);
      if (c.kind === "circle") expect(copies.some((x) => x.kind === "circle" && near(x.center, mir(c.center)) && Math.abs(x.radius - c.radius) < 1e-9)).toBe(true);
      if (c.kind === "arc")
        expect(copies.some((x) => x.kind === "arc" && near(x.center, mir(c.center)) && near(x.start, mir(c.start)) && near(x.end, mir(c.end)) && x.ccw === !c.ccw)).toBe(true);
    }
    expect(s.constraints.filter((c) => c.type === "symmetric").length).toBeGreaterThanOrEqual(5);
  });
});
