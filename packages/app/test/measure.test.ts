import { describe, expect, it } from "vitest";
import { parseObj } from "../src/engine/obj";
import { circumcenter, edgeGeom, faceGeom } from "../src/measure/geometry";
import { bodyMetrics, closestOnTriangle, closestSegmentSegment, formatMeasurement, measureSelection, type Measurement } from "../src/measure/measure";
import { buildTopology } from "../src/selection/topology";
import type { SelectionItem } from "../src/selection/types";
import nemaObj from "./fixtures/nema17-plate.obj?raw";

// NEMA 17 plate (corpus/makerbench/t1-nema17-plate.cad.ts): 50×50×5, pilot r 11 at the origin,
// four M3 holes r 1.7 at (±15.5, ±15.5).
const topo = buildTopology(parseObj(nemaObj));
const BODY = "plate/plate";
const body = topo.bodies.get(BODY)!;
const face = (key: string): SelectionItem => ({ kind: "face", body: BODY, key });
const edge = (key: string): SelectionItem => ({ kind: "edge", body: BODY, key });
const vertexAt = (x: number, y: number, z: number): SelectionItem => {
  const v = [...body.vertices.values()].find((q) => q.point[0] === x && q.point[1] === y && q.point[2] === z)!;
  return { kind: "vertex", body: BODY, key: v.key, point: v.point };
};
const row = (items: SelectionItem[], id: string): Measurement => {
  const r = measureSelection(items, topo);
  const m = r?.rows.find((x) => x.id === id);
  if (!m) throw new Error(`no ${id} in ${JSON.stringify(r)}`);
  return m;
};

describe("exact geometry from the render mesh", () => {
  it("recognises straight and circular edges exactly", () => {
    const top = edgeGeom(body.edges.get("plate/edge:{plate/cap:end|plate/side:top}")!);
    expect(top.type).toBe("line");
    expect(top.length).toBeCloseTo(50, 6);
    const pilot = edgeGeom(body.edges.get("plate/edge:{plate/cap:end|plate/side:pilot}")!);
    expect(pilot.type).toBe("circle");
    if (pilot.type !== "circle") return;
    expect(pilot.radius).toBeCloseTo(11, 4);
    expect(pilot.closed).toBe(true);
    expect(pilot.length).toBeCloseTo(2 * Math.PI * 11, 3);
    expect(Math.abs(pilot.normal[2])).toBeCloseTo(1, 6);
    expect(pilot.center[0]).toBeCloseTo(0, 4);
    const m3 = edgeGeom(body.edges.get("plate/edge:{plate/cap:start|plate/side:m3_a}")!);
    expect(m3.type === "circle" && m3.radius).toBeCloseTo(1.7, 4);
  });

  it("gives planar faces their exact area, circular holes subtracted exactly", () => {
    const g = faceGeom(body, "plate/cap:end")!;
    expect(g.type).toBe("plane");
    expect(g.exact).toBe(true);
    const exact = 2500 - Math.PI * 11 * 11 - 4 * Math.PI * 1.7 * 1.7;
    expect(g.area).toBeCloseTo(exact, 2);
    // The raw triangulation is noticeably off (the chords): the correction matters.
    const side = faceGeom(body, "plate/side:right")!;
    expect(side.type === "plane" && side.area).toBeCloseTo(50 * 5, 6);
  });

  it("recognises hole walls as cylinders with exact radius and area", () => {
    const g = faceGeom(body, "plate/side:pilot")!;
    expect(g.type).toBe("cylinder");
    if (g.type !== "cylinder") return;
    expect(g.radius).toBeCloseTo(11, 4);
    expect(g.inner).toBe(true);
    expect(g.exact).toBe(true);
    expect(g.area).toBeCloseTo(2 * Math.PI * 11 * 5, 2);
    expect(Math.abs(g.axis[2])).toBeCloseTo(1, 6);
  });

  it("finds circumcentres and closest points", () => {
    const c = circumcenter([1, 0, 0], [0, 1, 0], [-1, 0, 0])!;
    expect(c.radius).toBeCloseTo(1, 12);
    expect(c.center.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 0]);
    expect(circumcenter([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
    const q0 = closestOnTriangle([0.2, 0.2, 5], [0, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(q0[0]).toBeCloseTo(0.2, 12);
    expect(q0[1]).toBeCloseTo(0.2, 12);
    expect(q0[2]).toBe(0);
    const [p, q] = closestSegmentSegment([0, 0, 0], [1, 0, 0], [0.5, -1, 1], [0.5, 1, 1]);
    expect(p).toEqual([0.5, 0, 0]);
    expect(q).toEqual([0.5, 0, 1]);
  });
});

describe("measuring selections", () => {
  it("one entity: vertex position, edge length, hole radius and diameter, face area", () => {
    expect(row([vertexAt(25, 25, 5)], "z").value).toBe(5);
    expect(row([edge("plate/edge:{plate/cap:end|plate/side:top}")], "length").value).toBeCloseTo(50, 6);
    const r = row([face("plate/side:m3_a")], "radius");
    expect(r.value).toBeCloseTo(1.7, 4);
    expect(r.exact).toBe(true);
    expect(row([face("plate/side:m3_a")], "diameter").value).toBeCloseTo(3.4, 4);
    expect(row([edge("plate/edge:{plate/cap:end|plate/side:pilot}")], "diameter").value).toBeCloseTo(22, 3);
    expect(row([face("plate/cap:end")], "area").value).toBeCloseTo(2500 - Math.PI * (121 + 4 * 2.89), 2);
  });

  it("two entities: parallel faces, vertex to vertex, hole axes, angles", () => {
    const d = row([face("plate/cap:end"), face("plate/cap:start")], "distance");
    expect(d.value).toBeCloseTo(5, 6);
    expect(d.exact).toBe(true);
    expect(d.from && d.to).toBeTruthy();
    const vv = measureSelection([vertexAt(25, 25, 5), vertexAt(-25, -25, 0)], topo)!;
    expect(vv.rows.find((x) => x.id === "distance")!.value).toBeCloseTo(Math.hypot(50, 50, 5), 6);
    expect(vv.rows.find((x) => x.id === "dz")!.value).toBe(5);
    // M3 hole axes are 31 mm apart.
    const axes = row([face("plate/side:m3_a"), face("plate/side:m3_b")], "axis");
    expect(axes.value).toBeCloseTo(31, 3);
    expect(axes.exact).toBe(true);
    expect(row([face("plate/cap:end"), face("plate/side:right")], "angle").value).toBeCloseTo(90, 6);
    expect(row([edge("plate/edge:{plate/cap:end|plate/side:top}"), edge("plate/edge:{plate/cap:end|plate/side:right}")], "angle").value).toBeCloseTo(90, 6);
    expect(row([edge("plate/edge:{plate/cap:end|plate/side:top}"), edge("plate/edge:{plate/cap:start|plate/side:bottom}")], "distance").value).toBeCloseTo(Math.hypot(50, 5), 6);
    // Vertex to planar face: the perpendicular foot lies on the face → exact.
    const vf = row([vertexAt(25, 25, 5), face("plate/cap:start")], "distance");
    expect(vf.value).toBeCloseTo(5, 6);
    expect(vf.exact).toBe(true);
  });

  it("several entities: totals; bodies read exact metrics from the report", () => {
    const tot = row([edge("plate/edge:{plate/cap:end|plate/side:top}"), edge("plate/edge:{plate/cap:end|plate/side:right}"), edge("plate/edge:{plate/cap:end|plate/side:pilot}")], "length");
    expect(tot.value).toBeCloseTo(100 + 2 * Math.PI * 11, 3);
    const report = { features: [{ part: "plate", feature: "plate", bodies: [{ volume: 10417.75, area: 7054.1, centroid: [0, 0, 2.5], bbox_min: [-25, -25, 0], bbox_max: [25, 25, 5] }] }] };
    expect(bodyMetrics(report as never, BODY)?.volume).toBe(10417.75);
    const vol = measureSelection([{ kind: "body", body: BODY }], topo, report as never)!;
    expect(vol.rows.find((x) => x.id === "volume")).toMatchObject({ value: 10417.75, exact: true });
    expect(measureSelection([], topo)).toBeNull();
  });

  it("formats values, marking approximate ones", () => {
    expect(formatMeasurement({ value: 5, unit: "mm", exact: true })).toBe("5 mm");
    expect(formatMeasurement({ value: 2083.55049, unit: "mm²", exact: true })).toBe("2083.55 mm²");
    expect(formatMeasurement({ value: 12.3456, unit: "mm", exact: false })).toBe("≈ 12.346 mm");
    expect(formatMeasurement({ value: 90.0000001, unit: "°", exact: true })).toBe("90°");
  });
});
