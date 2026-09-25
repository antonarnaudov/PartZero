import { describe, expect, it } from "vitest";
import { faceFrame, namedFrame, toPlane, toWorld } from "../../src/sketch/frames";
import { arcParams, arcThrough, circleThrough, intersect, nearestOnCurve, tangentArc, type LiteralCurve, type P2 } from "../../src/sketch/geom";
import { fitBox, initialView, isTrackpadPan, PlaneView, zoomAt } from "../../src/sketch/view";

const close = (a: P2, b: P2, eps = 1e-9): void => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
};

describe("sketch geometry", () => {
  it("intersects segments, circles and arc spans", () => {
    const l1: LiteralCurve = { kind: "line", id: "a", start: [0, 0], end: [10, 0] };
    const l2: LiteralCurve = { kind: "line", id: "b", start: [5, -5], end: [5, 5] };
    const l3: LiteralCurve = { kind: "line", id: "c", start: [20, -5], end: [20, 5] };
    close(intersect(l1, l2)[0]!, [5, 0]);
    expect(intersect(l1, l3)).toHaveLength(0);
    expect(intersect(l1, l3, true)).toHaveLength(1);
    const c: LiteralCurve = { kind: "circle", id: "c", center: [0, 0], radius: 5 };
    const pts = intersect(l2, c);
    expect(pts).toHaveLength(1);
    close(pts[0]!, [5, 0]);
    // Upper half arc only.
    const arc: LiteralCurve = { kind: "arc", id: "u", start: [5, 0], end: [-5, 0], center: [0, 0], ccw: true };
    const across: LiteralCurve = { kind: "line", id: "v", start: [0, -10], end: [0, 10] };
    const hits = intersect(arc, across);
    expect(hits).toHaveLength(1);
    close(hits[0]!, [0, 5]);
  });

  it("builds 3-point circles and arcs, and tangent arcs", () => {
    const c = circleThrough([1, 0], [0, 1], [-1, 0])!;
    close(c.center, [0, 0]);
    expect(c.r).toBeCloseTo(1, 12);
    expect(circleThrough([0, 0], [1, 1], [2, 2])).toBeNull();
    const a = arcThrough([1, 0], [0, 1], [-1, 0])!;
    expect(a.ccw).toBe(true);
    expect(arcThrough([1, 0], [0, -1], [-1, 0])!.ccw).toBe(false);
    // Continue a line along +x into a ccw quarter turn ending at (1, 1).
    const t = tangentArc([0, 0], [1, 0], [1, 1])!;
    close(t.center, [0, 1]);
    expect(t.ccw).toBe(true);
    expect(tangentArc([0, 0], [1, 0], [5, 0])).toBeNull();
  });

  it("describes arcs counter-clockwise whatever their ccw flag", () => {
    const ccw = arcParams({ kind: "arc", id: "a", start: [1, 0], end: [0, 1], center: [0, 0], ccw: true });
    expect(ccw.sweep).toBeCloseTo(Math.PI / 2, 12);
    const cw = arcParams({ kind: "arc", id: "a", start: [1, 0], end: [0, 1], center: [0, 0], ccw: false });
    expect(cw.sweep).toBeCloseTo((3 * Math.PI) / 2, 12);
    const n = nearestOnCurve({ kind: "arc", id: "a", start: [1, 0], end: [0, 1], center: [0, 0], ccw: true }, [-3, -3]);
    expect(n.point[0] === 1 || n.point[1] === 1).toBe(true);
  });
});

describe("sketch frames", () => {
  it("names the origin planes as v0 §2 does", () => {
    expect(namedFrame("XY").normal).toEqual([0, 0, 1]);
    expect(namedFrame("XZ").normal).toEqual([0, -1, 0]);
    expect(namedFrame("YZ").normal).toEqual([1, 0, 0]);
  });

  it("builds face frames per the SPEC-v1 §3.1 table", () => {
    const table: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
      [[0, 0, -1], [1, 0, 0], [0, -1, 0]],
      [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      [[-1, 0, 0], [0, 1, 0], [0, 0, -1]],
    ];
    for (const [n, x, y] of table) {
      const f = faceFrame(n, [3, 4, 5])!;
      f.x.forEach((v, i) => expect(v).toBeCloseTo(x[i]!, 12));
      f.y.forEach((v, i) => expect(v).toBeCloseTo(y[i]!, 12));
    }
    // The origin is the world origin projected onto the face plane.
    const top = faceFrame([0, 0, 1], [7, -2, 10])!;
    expect(top.origin).toEqual([0, 0, 10]);
    const back = toPlane(top, toWorld(top, [3, 4]));
    close(back.uv, [3, 4]);
    expect(back.h).toBeCloseTo(0, 12);
  });
});

describe("sketch view", () => {
  it("maps sketch and screen both ways, zooms about the cursor, fits boxes", () => {
    const s = initialView(800, 600);
    const v = new PlaneView(s);
    close(v.toSketch(v.toScreen([12.5, -3])), [12.5, -3]);
    const z = zoomAt(s, [100, 100], 2);
    close(new PlaneView(z).toSketch([100, 100]), v.toSketch([100, 100]), 1e-9);
    const f = fitBox(s, { min: [0, 0], max: [100, 50] });
    const fv = new PlaneView(f);
    const [x0, y0] = fv.toScreen([0, 0]);
    const [x1, y1] = fv.toScreen([100, 50]);
    expect(x0).toBeGreaterThan(0);
    expect(x1).toBeLessThan(800);
    expect(y1).toBeGreaterThan(0);
    expect(y0).toBeLessThan(600);
  });

  it("tells trackpad pans from mouse wheels (FD3)", () => {
    const base = { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, shiftKey: false };
    expect(isTrackpadPan({ ...base, deltaY: 100 })).toBe(false);
    expect(isTrackpadPan({ ...base, deltaY: 3.25 })).toBe(true);
    expect(isTrackpadPan({ ...base, deltaX: 2, deltaY: 10 })).toBe(true);
    expect(isTrackpadPan({ ...base, deltaY: 10, ctrlKey: true })).toBe(false);
    expect(isTrackpadPan({ ...base, deltaY: 100, shiftKey: true })).toBe(true);
    expect(isTrackpadPan({ ...base, deltaY: 3, deltaMode: 1 })).toBe(false);
  });
});
