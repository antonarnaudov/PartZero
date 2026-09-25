import { describe, expect, it } from "vitest";
import { constraintsFor, applicableKinds } from "../../src/sketch/constraints";
import { dimGraphic, dimText, proposeDimension } from "../../src/sketch/dimension";
import type { LiteralCurve } from "../../src/sketch/geom";
import { IdAllocator } from "../../src/sketch/ids";
import { autoConstraintsFor, bindKinds, snap } from "../../src/sketch/snap";

const rect: LiteralCurve[] = [
  { kind: "line", id: "l1", start: [0, 0], end: [40, 0] },
  { kind: "line", id: "l2", start: [40, 0], end: [40, 20] },
  { kind: "line", id: "l3", start: [40, 20], end: [0, 20] },
  { kind: "line", id: "l4", start: [0, 20], end: [0, 0] },
  { kind: "circle", id: "c1", center: [20, 10], radius: 5 },
  { kind: "point", id: "p1", at: [60, 30] },
];

const ids = (): ((p: string) => string) => {
  const a = new IdAllocator([]);
  return (p) => a.next(p);
};

describe("snapping and inference", () => {
  it("prefers endpoints, centres and points, then midpoints, intersections and curves", () => {
    expect(snap([40.3, 0.2], { curves: rect, tol: 1 })).toMatchObject({ kind: "endpoint", ref: "l1.end", point: [40, 0] });
    expect(snap([20.2, 10.1], { curves: rect, tol: 1 })).toMatchObject({ kind: "center", ref: "c1.center" });
    expect(snap([59.6, 30.3], { curves: rect, tol: 1 })).toMatchObject({ kind: "point", ref: "p1" });
    expect(snap([20.3, 0.2], { curves: rect, tol: 1 })).toMatchObject({ kind: "midpoint", curve: "l1", point: [20, 0] });
    expect(snap([25.2, 10.1], { curves: rect, tol: 1 })).toMatchObject({ kind: "quadrant", curve: "c1" });
    const on = snap([30, 0.4], { curves: rect, tol: 1 });
    expect(on).toMatchObject({ kind: "onCurve", curve: "l1" });
    expect(on.point[1]).toBe(0);
    expect(snap([0.3, -0.2], { curves: [], tol: 1 })).toMatchObject({ kind: "origin", point: [0, 0] });
    expect(snap([100, 0.5], { curves: [], tol: 1 })).toMatchObject({ kind: "axis", point: [100, 0] });
    expect(snap([40.3, 0.2], { curves: rect, tol: 1, disabled: true })).toMatchObject({ kind: "free", point: [40.3, 0.2] });
  });

  it("infers horizontal, vertical and parallel directions from the anchor", () => {
    const h = snap([70, 30.4], { curves: [], tol: 1, anchor: [50, 30] });
    expect(h.hv).toBe("h");
    expect(h.point).toEqual([70, 30]);
    const v = snap([50.5, 80], { curves: [], tol: 1, anchor: [50, 30] });
    expect(v.hv).toBe("v");
    expect(v.point[0]).toBe(50);
    const diag: LiteralCurve[] = [{ kind: "line", id: "d", start: [0, 0], end: [10, 10] }];
    const par = snap([80.2, 79.9], { curves: diag, tol: 0.5, anchor: [50, 50] });
    expect(par.parallelTo).toBe("d");
    expect(par.point[0] - 50).toBeCloseTo(par.point[1] - 50, 9);
    const perp = snap([60.1, 40], { curves: diag, tol: 0.5, anchor: [50, 50] });
    expect(perp.perpendicularTo).toBe("d");
  });

  it("turns snaps into auto-constraints", () => {
    const n = ids();
    expect(autoConstraintsFor("l9.start", snap([40.3, 0.2], { curves: rect, tol: 1 }), n)).toEqual([]); // welds
    expect(autoConstraintsFor("l9.start", snap([20.2, 10.1], { curves: rect, tol: 1 }), n)).toEqual([{ type: "coincident", id: "co1", a: "l9.start", b: "c1.center" }]);
    expect(autoConstraintsFor("l9.start", snap([0.1, 0.1], { curves: [], tol: 1 }), n)).toEqual([{ type: "fix", id: "fx1", entity: "l9.start", x: 0, y: 0 }]);
    expect(autoConstraintsFor("l9.start", snap([20.3, 0.2], { curves: rect, tol: 1 }), n)).toEqual([{ type: "midpoint", id: "mp1", point: "l9.start", line: "l1" }]);
    const onCircle = bindKinds(autoConstraintsFor("p9", snap([25.2, 10.1], { curves: rect, tol: 1 }), n), rect);
    expect(onCircle[0]).toMatchObject({ type: "point_on_circle", point: "p9", curve: "c1" });
  });
});

describe("constraints and dimensions from a selection", () => {
  it("builds the palette's constraints and rejects bad selections", () => {
    const a = new IdAllocator(rect.map((c) => c.id));
    expect(constraintsFor("parallel", [{ kind: "curve", id: "l1" }, { kind: "curve", id: "l3" }], rect, a)).toMatchObject({ ok: true, constraints: [{ type: "parallel", a: "l1", b: "l3" }] });
    expect(constraintsFor("tangent", [{ kind: "curve", id: "l1" }, { kind: "curve", id: "c1" }], rect, a)).toMatchObject({ ok: true, constraints: [{ type: "tangent" }] });
    expect(constraintsFor("coincident", [{ kind: "point", ref: "p1" }, { kind: "curve", id: "c1" }], rect, a)).toMatchObject({ ok: true, constraints: [{ type: "point_on_circle", point: "p1", curve: "c1" }] });
    expect(constraintsFor("fix", [{ kind: "point", ref: "l2.end" }], rect, a)).toMatchObject({ ok: true, constraints: [{ type: "fix", entity: "l2.end", x: 40, y: 20 }] });
    expect(constraintsFor("symmetric", [{ kind: "point", ref: "l1.start" }, { kind: "point", ref: "l1.end" }, { kind: "curve", id: "l3" }], rect, a)).toMatchObject({ ok: true });
    expect(constraintsFor("equal", [{ kind: "curve", id: "l1" }, { kind: "curve", id: "c1" }], rect, a).ok).toBe(false);
    expect(applicableKinds([{ kind: "curve", id: "l1" }], rect)).toEqual(expect.arrayContaining(["horizontal", "vertical", "fix"]));
  });

  it("proposes and draws dimensions", () => {
    expect(proposeDimension([{ kind: "curve", id: "l1" }], rect)).toMatchObject({ shape: { type: "distance", a: "l1.start", b: "l1.end" }, measured: 40 });
    expect(proposeDimension([{ kind: "curve", id: "c1" }], rect)).toMatchObject({ shape: { type: "diameter" }, measured: 10 });
    expect(proposeDimension([{ kind: "curve", id: "c1" }], rect, true)).toMatchObject({ shape: { type: "radius" }, measured: 5 });
    expect(proposeDimension([{ kind: "curve", id: "l1" }, { kind: "curve", id: "l3" }], rect)).toMatchObject({ shape: { type: "distance", a: "l1.start", b: "l3" }, measured: 20 });
    expect(proposeDimension([{ kind: "curve", id: "l1" }, { kind: "curve", id: "l2" }], rect)).toMatchObject({ shape: { type: "angle" }, measured: 90 });
    expect(proposeDimension([{ kind: "point", ref: "p1" }, { kind: "curve", id: "l3" }], rect)).toMatchObject({ measured: 10 });
    const g = dimGraphic({ type: "distance", a: "l1.start", b: "l1.end" }, rect, null, 0.1)!;
    expect(g.lines).toHaveLength(3);
    expect(dimText({ type: "diameter", curve: "c1" }, { id: "d", type: "diameter", driving: true, value: 10 }, 10)).toBe("⌀10");
    expect(dimText({ type: "distance", a: "a", b: "b" }, { id: "d", type: "distance", driving: true, value: 24, expr: "width * 2" }, 24)).toBe("width * 2 = 24");
    expect(dimText({ type: "angle", a: "a", b: "b" }, { id: "d", type: "angle", driving: false, measured: 30 }, 30)).toBe("(30°)");
  });
});
