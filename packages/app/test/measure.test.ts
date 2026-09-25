import { describe, expect, it } from "vitest";
import { parseObj } from "../src/engine/obj";
import { circumcenter, edgeGeom, faceGeom, MIN_CIRCLE_POINTS } from "../src/measure/geometry";
import { bodyMetrics, closestOnTriangle, closestSegmentSegment, contactPoint, formatMeasurement, measureSelection, type Measurement } from "../src/measure/measure";
import { buildTopology, type EdgeInfo } from "../src/selection/topology";
import type { SelectionItem } from "../src/selection/types";
import { forgeWebBody, sharedVertexBody } from "./forge-web-fixture";
import nemaObj from "./fixtures/nema17-plate.obj?raw";

// NEMA 17 plate (corpus/makerbench/t1-nema17-plate.cad.ts): 50×50×5, pilot r 11 at the origin,
// four M3 holes r 1.7 at (±15.5, ±15.5) — as the default engine (forge-web) hands it over: a
// render mesh split per face, each vertex with its face's exact normal.
const topo = buildTopology([forgeWebBody("nema")]);
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

describe("exact geometry from the render mesh (forge-web)", () => {
  it("recognises straight and circular edges exactly", () => {
    // Two points only: the two adjacent planes (by their exact normals) make it a line.
    const top = edgeGeom(body.edges.get("plate/edge:{plate/cap:end|plate/side:top}")!, body);
    expect(top).toMatchObject({ type: "line", exact: true });
    expect(top.length).toBeCloseTo(50, 6);
    // Without the faces' evidence a two-point polyline proves nothing.
    expect(edgeGeom(body.edges.get("plate/edge:{plate/cap:end|plate/side:top}")!).exact).toBe(false);
    const pilot = edgeGeom(body.edges.get("plate/edge:{plate/cap:end|plate/side:pilot}")!);
    expect(pilot).toMatchObject({ type: "circle", exact: true });
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
    expect(g).toMatchObject({ type: "plane", exact: true, verified: true });
    const exact = 2500 - Math.PI * 11 * 11 - 4 * Math.PI * 1.7 * 1.7;
    expect(g.area).toBeCloseTo(exact, 2);
    // The raw triangulation is noticeably off (the chords): the correction matters.
    const side = faceGeom(body, "plate/side:right")!;
    expect(side.type === "plane" && side.area).toBeCloseTo(50 * 5, 6);
    expect(side.exact).toBe(true);
  });

  it("recognises hole walls as cylinders with exact radius and area", () => {
    const g = faceGeom(body, "plate/side:pilot")!;
    expect(g.type).toBe("cylinder");
    if (g.type !== "cylinder") return;
    expect(g.radius).toBeCloseTo(11, 4);
    expect(g.inner).toBe(true);
    expect(g.verified).toBe(true);
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

  it("touching entities are exactly 0 apart (shared edge or vertex)", () => {
    const d = row([face("plate/cap:end"), face("plate/side:right")], "distance");
    expect(d).toMatchObject({ value: 0, exact: true });
    expect(contactPoint(topo, face("plate/cap:end"), edge("plate/edge:{plate/cap:end|plate/side:top}"))).not.toBeNull();
    expect(contactPoint(topo, vertexAt(25, 25, 5), face("plate/side:top"))).toEqual([25, 25, 5]);
    expect(contactPoint(topo, edge("plate/edge:{plate/cap:end|plate/side:top}"), edge("plate/edge:{plate/cap:end|plate/side:right}"))).toEqual([25, 25, 5]);
    expect(contactPoint(topo, face("plate/cap:end"), face("plate/cap:start"))).toBeNull();
    expect(row([vertexAt(25, 25, 5), edge("plate/edge:{plate/cap:end|plate/side:right}")], "distance").value).toBe(0);
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

// ─── Never a silently wrong "exact" ──────────────────────────────────────────────────────────

const deg = Math.PI / 180;

describe("low-sweep arcs drawn as one chord (real forge-web meshes)", () => {
  // An offset rectangle (r 2…3, z 0…1) revolved 15° about Z: each arc is ONE segment and each
  // cylinder wall ONE quad — positions identical to a planar hexahedron.
  const wt = buildTopology([forgeWebBody("wedge15")]);
  const W = "w/wedge";
  const wb = wt.bodies.get(W)!;
  const m = (items: SelectionItem[]) => measureSelection(items, wt)!;
  const wedgeRow = (items: SelectionItem[], id: string): Measurement => m(items).rows.find((x) => x.id === id)!;
  const wEdge = (key: string): SelectionItem => ({ kind: "edge", body: W, key: `wedge/edge:{${key}}` });
  const wFace = (key: string): SelectionItem => ({ kind: "face", body: W, key: `wedge/${key}` });

  it("the mesh really has single-segment arcs and single-quad walls", () => {
    for (const e of wb.edges.values()) expect(e.points.length).toBe(6);
    expect(faceGeom(wb, "wedge/side:outer")!.type).not.toBe("cylinder");
  });

  it("a one-segment arc is not an exact line: its chord is shown with ≈", () => {
    const g = edgeGeom(wb.edges.get("wedge/edge:{wedge/side:outer|wedge/side:top}")!, wb);
    expect(g).toMatchObject({ type: "line", exact: false });
    const r = m([wEdge("wedge/side:outer|wedge/side:top")]);
    expect(r.title).toBe("Edge");
    expect(r.rows[0]).toMatchObject({ id: "length", exact: false });
    // The chord 2·3·sin 7.5° is below the true arc length 3·15°: the "≈" is warranted.
    expect(r.rows[0]!.value).toBeCloseTo(6 * Math.sin(7.5 * deg), 5);
    expect(formatMeasurement(r.rows[0]!)).toMatch(/^≈ /);
    expect(3 * 15 * deg - r.rows[0]!.value).toBeGreaterThan(1e-3);
  });

  it("straight edges are still exact where the faces prove them: plane ∩ plane, and a ruling", () => {
    // End cap ∩ top: two non-parallel verified planes.
    expect(wedgeRow([wEdge("wedge/endcap:start|wedge/side:top")], "length")).toMatchObject({ value: 1, exact: true });
    // End cap ∩ outer wall: the wall's own normal is the same at both ends (a ruling).
    const ruling = wedgeRow([wEdge("wedge/endcap:start|wedge/side:outer")], "length");
    expect(ruling.exact).toBe(true);
    expect(ruling.value).toBeCloseTo(1, 6);
  });

  it("a curved wall tessellated as one flat quad is not a plane, and its area is approximate", () => {
    const g = faceGeom(wb, "wedge/side:outer")!;
    expect(g.type).toBe("surface");
    expect(g.exact).toBe(false);
    const r = m([wFace("side:outer")]);
    expect(r.title).toBe("Face");
    expect(r.rows[0]).toMatchObject({ id: "area", exact: false });
    // Section / look-at refuse it as a planar face.
    expect(faceGeom(wb, "wedge/side:inner")!.type).toBe("surface");
  });

  it("a true plane bounded by uncertified chords has an approximate area; one bounded by proven lines is exact", () => {
    const top = faceGeom(wb, "wedge/side:top")!;
    expect(top).toMatchObject({ type: "plane", verified: true, exact: false });
    // The annular sector's true area is (15/360)·π·(3² − 2²); the mesh's trapezoid is ~1 % short.
    const sector = (15 / 360) * Math.PI * 5;
    expect(Math.abs(top.area - sector) / sector).toBeGreaterThan(1e-3);
    expect(Math.abs(top.area - sector) / sector).toBeLessThan(0.02);
    expect(faceGeom(wb, "wedge/endcap:start")).toMatchObject({ type: "plane", verified: true, exact: true });
    expect(wedgeRow([wFace("endcap:start")], "area").value).toBeCloseTo(1, 6);
    // Parallel verified planes: exact distance.
    expect(wedgeRow([wFace("side:top"), wFace("side:bottom")], "distance")).toMatchObject({ value: 1, exact: true });
  });

  it("arcs of three segments (four points) fit a circle, but only approximately", () => {
    const t45 = buildTopology([forgeWebBody("wedge45")]);
    const b45 = t45.bodies.get(W)!;
    const e = b45.edges.get("wedge/edge:{wedge/side:outer|wedge/side:top}")!;
    expect(e.points.length / 3).toBeLessThan(MIN_CIRCLE_POINTS);
    const g = edgeGeom(e, b45);
    expect(g).toMatchObject({ type: "circle", exact: false });
    expect(g.type === "circle" && g.radius).toBeCloseTo(3, 4);
    const r = measureSelection([{ kind: "edge", body: W, key: e.name }], t45)!;
    expect(r.title).toBe("Edge (≈ arc)");
    expect(r.rows.every((x) => !x.exact)).toBe(true);
    const wall = faceGeom(b45, "wedge/side:outer")!;
    expect(wall).toMatchObject({ type: "cylinder", verified: false, exact: false });
    expect(measureSelection([{ kind: "face", body: W, key: "wedge/side:outer" }], t45)!.rows.find((x) => x.id === "radius")!.exact).toBe(false);
  });
});

describe("circle fits need enough points", () => {
  const ellipse = (ts: number[]): EdgeInfo => ({
    name: "x/edge:{x/a|x/b}",
    closed: false,
    points: Float32Array.from(ts.flatMap((t) => [4 * Math.cos(t), 2 * Math.sin(t), 0])),
  });

  it("three points of an ellipse fit a circle: never exact", () => {
    expect(edgeGeom(ellipse([-0.3, 0, 0.3]))).toMatchObject({ type: "circle", exact: false });
  });

  it("four symmetric points of an ellipse are concyclic (an isosceles trapezoid): never exact", () => {
    expect(edgeGeom(ellipse([-0.45, -0.15, 0.15, 0.45]))).toMatchObject({ type: "circle", exact: false });
  });

  it("with five or more points the ellipse is a curve, and a real circle is exact", () => {
    expect(edgeGeom(ellipse([-0.6, -0.3, 0, 0.3, 0.6]))).toMatchObject({ type: "curve", exact: false });
    expect(edgeGeom(ellipse([-0.45, -0.3, -0.15, 0, 0.15, 0.3, 0.45])).type).toBe("curve");
    const arc: EdgeInfo = { name: "x/edge:{x/a|x/b}", closed: false, points: Float32Array.from([0, 1, 2, 3, 4].flatMap((k) => [3 * Math.cos(k * 0.2), 3 * Math.sin(k * 0.2), 0])) };
    const g = edgeGeom(arc);
    expect(g).toMatchObject({ type: "circle", exact: true });
    expect(g.type === "circle" && g.radius).toBeCloseTo(3, 5);
  });
});

describe("the CLI engine's mesh (vertices shared between faces, normals averaged)", () => {
  // forge-io's OBJ of the same plate: nothing can prove a face planar or a two-point edge straight.
  const ot = buildTopology(parseObj(nemaObj));
  const ob = ot.bodies.get(BODY)!;
  const orow = (items: SelectionItem[], id: string): Measurement => measureSelection(items, ot)!.rows.find((x) => x.id === id)!;

  it("keeps the values but flags what the mesh cannot prove", () => {
    const cap = faceGeom(ob, "plate/cap:end")!;
    expect(cap).toMatchObject({ type: "plane", verified: false, exact: false });
    // Still the corrected value, as an approximation.
    expect(cap.area).toBeCloseTo(2500 - Math.PI * (121 + 4 * 2.89), 2);
    expect(orow([face("plate/cap:end")], "area").exact).toBe(false);
    expect(orow([edge("plate/edge:{plate/cap:end|plate/side:top}")], "length")).toMatchObject({ exact: false });
    expect(orow([face("plate/side:m3_a")], "radius").exact).toBe(false);
    expect(orow([face("plate/cap:end"), face("plate/cap:start")], "distance").exact).toBe(false);
  });

  it("what positions alone prove stays exact: vertices, well-sampled circles, touching entities", () => {
    const v = [...ob.vertices.values()].find((q) => q.point[0] === 25 && q.point[1] === 25 && q.point[2] === 5)!;
    expect(orow([{ kind: "vertex", body: BODY, key: v.key, point: v.point }], "z")).toMatchObject({ value: 5, exact: true });
    expect(orow([edge("plate/edge:{plate/cap:end|plate/side:pilot}")], "diameter")).toMatchObject({ exact: true });
    expect(orow([face("plate/cap:end"), face("plate/side:right")], "distance")).toMatchObject({ value: 0, exact: true });
  });

  it("the same forge-web mesh with its vertices merged loses the proof too", () => {
    const merged = buildTopology([sharedVertexBody(forgeWebBody("nema"))]);
    const mb = merged.bodies.get(BODY)!;
    expect(faceGeom(mb, "plate/side:right")).toMatchObject({ type: "plane", verified: false, exact: false });
    expect(faceGeom(buildTopology([sharedVertexBody(forgeWebBody("wedge15"))]).bodies.get("w/wedge")!, "wedge/side:outer")).toMatchObject({ exact: false });
  });
});
