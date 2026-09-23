import { describe, expect, it } from "vitest";
import { chainSegments, ObjParseError, parseObj } from "../src/engine/obj";
import nemaObj from "./fixtures/nema17-plate.obj?raw";
import twoObj from "./fixtures/two-regions.obj?raw";

// Fixtures are verbatim `aicad export --out x.obj` output (forge-io OBJ writer):
// nema17-plate = corpus/makerbench/t1-nema17-plate.cad.ts; two-regions = corpus/cadscript/extrude_two_regions.cad.ts.

describe("parseObj on Forge CLI output", () => {
  it("reads one body per `o`, with per-face groups as face ranges", () => {
    const bodies = parseObj(nemaObj);
    expect(bodies).toHaveLength(1);
    const plate = bodies[0]!;
    expect(plate.name).toBe("plate/plate");
    expect(plate.indices.length).toBe(476 * 3);
    expect(plate.positions.length).toBe(plate.normals.length);
    const faces = [...new Set(plate.faceRanges.map((r) => r.face))].sort();
    expect(faces).toEqual(
      [
        "plate/cap:end",
        "plate/cap:start",
        "plate/side:bottom",
        "plate/side:left",
        "plate/side:m3_a",
        "plate/side:m3_b",
        "plate/side:m3_c",
        "plate/side:m3_d",
        "plate/side:pilot",
        "plate/side:right",
        "plate/side:top",
      ].sort(),
    );
    // Face ranges (in triangles, as in @aicad/forge-web) tile the triangles exactly, in order.
    let next = 0;
    for (const r of plate.faceRanges) {
      expect(r.start).toBe(next);
      next += r.count;
    }
    expect(next).toBe(plate.indices.length / 3);
    // Indices are local to the body.
    const nVerts = plate.positions.length / 3;
    expect(Math.max(...plate.indices)).toBeLessThan(nVerts);
  });

  it("recovers exactly the B-rep edges (metrics: 22 edges = 12 lines + 10 circles)", () => {
    const plate = parseObj(nemaObj)[0]!;
    expect(plate.edges).toHaveLength(22);
    const names = plate.edges.map((e) => e.edge);
    expect(new Set(names).size).toBe(22);
    // Named like forge-render names B-rep edges: <feature>/edge:{<faceA>|<faceB>}.
    expect(names).toContain("plate/edge:{plate/cap:end|plate/side:pilot}");
    expect(names).toContain("plate/edge:{plate/side:bottom|plate/side:right}");
    // Circles are closed polylines; straight edges are 2-point polylines.
    const pilot = plate.edges.find((e) => e.edge === "plate/edge:{plate/cap:end|plate/side:pilot}")!;
    const n = pilot.points.length / 3;
    expect(n).toBeGreaterThan(8);
    expect([pilot.points[0], pilot.points[1], pilot.points[2]]).toEqual([pilot.points[(n - 1) * 3], pilot.points[(n - 1) * 3 + 1], pilot.points[(n - 1) * 3 + 2]]);
    const corner = plate.edges.find((e) => e.edge === "plate/edge:{plate/side:bottom|plate/side:right}")!;
    expect(corner.points.length).toBe(6);
  });

  it("keeps multi-body naming (#n) and each body's own faces", () => {
    const bodies = parseObj(twoObj);
    expect(bodies.map((b) => b.name)).toEqual(["part/pucks#0", "part/pucks#1"]);
    const faces1 = new Set(bodies[1]!.faceRanges.map((r) => r.face));
    expect(faces1).toEqual(new Set(["pucks/cap:end", "pucks/cap:start", "pucks/side:ring_outer", "pucks/side:ring_inner"]));
    expect(bodies[0]!.edges).toHaveLength(2); // disc: two circles
    expect(bodies[1]!.edges).toHaveLength(4); // ring: four circles
  });
});

describe("parseObj on hand-written input", () => {
  it("fan-triangulates polygons, resolves negative indices and fills missing normals", () => {
    const text = ["v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f -4 -3 -2 -1"].join("\n");
    const [b] = parseObj(text);
    expect(b!.name).toBe("body");
    expect(Array.from(b!.indices)).toEqual([0, 1, 2, 0, 2, 3]);
    expect(b!.faceRanges).toEqual([{ face: "body", start: 0, count: 2 }]);
    for (let i = 0; i < 4; i++) expect(Array.from(b!.normals.slice(i * 3, i * 3 + 3))).toEqual([0, 0, 1]);
    // An open quad: 4 boundary segments chained into one closed polyline.
    expect(b!.edges).toHaveLength(1);
    expect(b!.edges[0]!.points.length / 3).toBe(5);
  });

  it("rejects out-of-range indices with the line number", () => {
    expect(() => parseObj("v 0 0 0\nf 1 2 3")).toThrow(ObjParseError);
    expect(() => parseObj("v 0 0 0\nf 1 2 3")).toThrow(/line 2/);
  });

  it("ignores comments and unknown statements", () => {
    const text = "# hi\nmtllib x.mtl\no a/b\ng b/cap:end\nv 0 0 0 # c\nv 1 0 0\nv 0 1 0\nvt 0 0\ns off\nf 1/1 2/1 3/1\n";
    const [b] = parseObj(text);
    expect(b!.name).toBe("a/b");
    expect(b!.faceRanges[0]!.face).toBe("b/cap:end");
  });
});

describe("chainSegments", () => {
  it("chains open paths from their ends and closes loops", () => {
    expect(chainSegments([[1, 2], [0, 1], [2, 3]])).toEqual([[0, 1, 2, 3]]);
    const loops = chainSegments([[0, 1], [1, 2], [2, 0]]);
    expect(loops).toHaveLength(1);
    expect(loops[0]![0]).toBe(loops[0]![loops[0]!.length - 1]);
  });
});
