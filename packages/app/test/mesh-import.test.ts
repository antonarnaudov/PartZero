import { describe, expect, it } from "vitest";
import { writeZip } from "../src/file/partzero/zip";
import { encodePng, renderThumbnail, renderThumbnailRgba } from "../src/file/thumbnail";
import { measureMesh, meshFormatOf, meshToRenderBody, MeshError, readMesh, readObj, readStl, readThreeMf, writeBinaryStl, type TriangleMesh } from "../src/file/mesh";

const enc = new TextEncoder();

/** An axis-aligned box as 12 outward-facing triangles. */
function box(sx: number, sy: number, sz: number): TriangleMesh {
  const positions = new Float32Array([0, 0, 0, sx, 0, 0, sx, sy, 0, 0, sy, 0, 0, 0, sz, sx, 0, sz, sx, sy, sz, 0, sy, sz]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // bottom (−z)
    4, 5, 6, 4, 6, 7, // top (+z)
    0, 1, 5, 0, 5, 4, // front (−y)
    2, 3, 7, 2, 7, 6, // back (+y)
    1, 2, 6, 1, 6, 5, // right (+x)
    3, 0, 4, 3, 4, 7, // left (−x)
  ]);
  return { positions, indices };
}

function asciiStl(mesh: TriangleMesh): string {
  const lines = ["solid box"];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    lines.push("  facet normal 0 0 0", "    outer loop");
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t + k]! * 3;
      lines.push(`      vertex ${mesh.positions[v]} ${mesh.positions[v + 1]} ${mesh.positions[v + 2]}`);
    }
    lines.push("    endloop", "  endfacet");
  }
  lines.push("endsolid box");
  return lines.join("\n");
}

function threeMf(model: string, extra: Array<{ name: string; data: Uint8Array }> = []): Uint8Array {
  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
  return writeZip([
    { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types/>') },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "3D/3dmodel.model", data: enc.encode(model) },
    ...extra,
  ]);
}

function boxObjectXml(id: number, mesh: TriangleMesh): string {
  const v: string[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) v.push(`<vertex x="${mesh.positions[i]}" y="${mesh.positions[i + 1]}" z="${mesh.positions[i + 2]}"/>`);
  const t: string[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) t.push(`<triangle v1="${mesh.indices[i]}" v2="${mesh.indices[i + 1]}" v3="${mesh.indices[i + 2]}"/>`);
  return `<object id="${id}" type="model"><mesh><vertices>${v.join("")}</vertices><triangles>${t.join("")}</triangles></mesh></object>`;
}

describe("measureMesh", () => {
  it("measures a closed box: size, area, volume", () => {
    const m = measureMesh(box(10, 20, 5));
    expect(m.triangles).toBe(12);
    expect(m.size).toEqual([10, 20, 5]);
    expect(m.area).toBeCloseTo(2 * (10 * 20 + 10 * 5 + 20 * 5), 6);
    expect(m.closed).toBe(true);
    expect(m.oriented).toBe(true);
    expect(m.volume).toBeCloseTo(1000, 6);
    expect(m.degenerate).toBe(0);
  });

  it("gives no volume for an open mesh", () => {
    const b = box(1, 1, 1);
    const open = { positions: b.positions, indices: b.indices.slice(0, 30) };
    const m = measureMesh(open);
    expect(m.closed).toBe(false);
    expect(m.volume).toBeNull();
  });
});

describe("STL", () => {
  it("reads binary STL and welds shared corners", () => {
    const mesh = readStl(writeBinaryStl(box(10, 20, 5)));
    expect(mesh.indices.length).toBe(36);
    expect(mesh.positions.length).toBe(8 * 3);
    expect(measureMesh(mesh).volume).toBeCloseTo(1000, 3);
  });

  it("reads ASCII STL, and binary STL whose header starts with `solid`", () => {
    const a = readStl(enc.encode(asciiStl(box(2, 3, 4))));
    expect(measureMesh(a).volume).toBeCloseTo(24, 4);
    const bin = writeBinaryStl(box(2, 3, 4));
    bin.set(enc.encode("solid exported by some CAD"), 0);
    expect(measureMesh(readStl(bin)).volume).toBeCloseTo(24, 4);
  });

  it("refuses files that are not STL, empty ones and non-finite coordinates", () => {
    expect(() => readStl(enc.encode("hello world"))).toThrow(MeshError);
    expect(() => readStl(enc.encode("solid x\nendsolid x"))).toThrow(/no triangles/);
    expect(() => readStl(enc.encode("solid x\nfacet normal 0 0 0\nouter loop\nvertex 0 0 NaN\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid"))).toThrow(/not a number/);
    const huge = writeBinaryStl(box(1, 1, 1));
    expect(() => readStl(huge, { maxTriangles: 5 })).toThrow(/limit/);
  });
});

describe("OBJ", () => {
  it("reads vertices and polygon faces (fans), with slashes and negative indices", () => {
    const text = ["# a quad and a triangle", "v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "vn 0 0 1", "f 1/1/1 2/2/1 3/3/1 4/4/1", "v 0 0 1", "f -1 1 2"].join("\n");
    const m = readObj(enc.encode(text));
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3, 4, 0, 1]);
    expect(() => readObj(enc.encode("v 0 0 0\nf 1 2 3"))).toThrow(/does not exist/);
  });
});

describe("3MF", () => {
  it("reads a mesh object with a build transform, in millimetres", () => {
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>${boxObjectXml(1, box(10, 10, 10))}</resources>
  <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build>
</model>`;
    const m = readThreeMf(threeMf(model));
    const s = measureMesh(m);
    expect(s.volume).toBeCloseTo(1000, 3);
    expect(s.bbox?.min[0]).toBeCloseTo(100, 5);
  });

  it("converts units and follows components across model files (production extension)", () => {
    const object = `<?xml version="1.0"?><model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${boxObjectXml(7, box(1, 1, 1))}</resources><build/></model>`;
    const root = `<?xml version="1.0"?>
<model unit="inch" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06">
  <resources><object id="2" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="7" transform="2 0 0 0 2 0 0 0 2 0 0 0"/></components></object></resources>
  <build><item objectid="2"/></build>
</model>`;
    const m = readThreeMf(threeMf(root, [{ name: "3D/Objects/object_1.model", data: enc.encode(object) }]));
    const s = measureMesh(m);
    expect(s.size[0]).toBeCloseTo(2 * 25.4, 3);
    expect(s.volume).toBeCloseTo((2 * 25.4) ** 3, 0);
  });

  it("refuses broken references and component cycles", () => {
    const missing = `<model unit="millimeter"><resources></resources><build><item objectid="9"/></build></model>`;
    expect(() => readThreeMf(threeMf(missing))).toThrow(/does not exist/);
    const cycle = `<model unit="millimeter"><resources><object id="1"><components><component objectid="2"/></components></object><object id="2"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>`;
    expect(() => readThreeMf(threeMf(cycle))).toThrow(/cycle/);
    expect(() => readThreeMf(enc.encode("not a zip"))).toThrow(MeshError);
  });

  it("dispatches by extension", () => {
    expect(meshFormatOf("/a/b/Part.STL")).toBe("stl");
    expect(meshFormatOf("x.3mf")).toBe("3mf");
    expect(meshFormatOf("x.step")).toBeNull();
    expect(readMesh(writeBinaryStl(box(1, 1, 1)), "stl").indices.length).toBe(36);
  });
});

describe("display body and thumbnail", () => {
  it("turns a mesh into a flat-shaded display body with one face range", () => {
    const body = meshToRenderBody(box(1, 2, 3), "ref:ref1", [0.5, 0.5, 0.9]);
    expect(body.name).toBe("ref:ref1");
    expect(body.positions.length).toBe(12 * 9);
    expect(body.faceRanges).toEqual([{ face: "ref:ref1", start: 0, count: 12 }]);
    expect(body.color).toEqual([0.5, 0.5, 0.9]);
    // The bottom face's normal points down.
    expect(Array.from(body.normals.subarray(0, 3))).toEqual([0, 0, -1]);
  });

  it("renders a deterministic PNG that zlib can read", async () => {
    const body = meshToRenderBody(box(10, 20, 5), "b");
    const a = renderThumbnail([body], { width: 64, height: 48 });
    const b = renderThumbnail([body], { width: 64, height: 48 });
    expect(a).not.toBeNull();
    expect(a!.png).toEqual(b!.png);
    expect(Array.from(a!.png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // IDAT is a valid zlib stream of 48 rows × (1 + 64 × 4) bytes.
    const view = new DataView(a!.png.buffer, a!.png.byteOffset);
    const ihdrLen = view.getUint32(8);
    const idatAt = 8 + 12 + ihdrLen;
    const idatLen = view.getUint32(idatAt);
    const zlibStream = new Blob([a!.png.slice(idatAt + 8, idatAt + 8 + idatLen)]).stream().pipeThrough(new DecompressionStream("deflate"));
    const raw = new Uint8Array(await new Response(zlibStream).arrayBuffer());
    expect(raw.length).toBe(48 * (1 + 64 * 4));
    const rgba = renderThumbnailRgba([body], 64, 48)!;
    const covered = rgba.filter((_, i) => i % 4 === 3 && rgba[i]! > 0).length;
    expect(covered).toBeGreaterThan(64 * 48 * 0.1);
    expect(renderThumbnail([], { width: 8, height: 8 })).toBeNull();
    expect(() => encodePng(new Uint8Array(3), 1, 1)).toThrow();
  });
});
