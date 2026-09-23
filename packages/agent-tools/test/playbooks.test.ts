import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile, DIAGNOSTIC_CODES } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import { coveredCodes, DOCUMENT_ERROR_CODES, ENGINE_ERROR_CODES, KERNEL_ERROR_CODES, PLAYBOOK, repairHint, staticHint } from "../src/index.js";
import { SCENARIOS } from "./scenarios.js";

const SPEC = fileURLToPath(new URL("../../../forge/crates/forge-ir/SPEC.md", import.meta.url));

function ir(source: string): IrDocument {
  const r = compile(source);
  if (!r.ir) throw new Error(r.diagnostics.map((d) => d.message).join("; "));
  return r.ir;
}

describe("playbook coverage", () => {
  it("has a hint for every CadScript diagnostic code", () => {
    for (const code of Object.keys(DIAGNOSTIC_CODES)) expect(PLAYBOOK[code], code).toBeTruthy();
  });

  it("has a hint for every error code in forge-ir SPEC.md", () => {
    const spec = readFileSync(SPEC, "utf8");
    const codes = [...new Set([...spec.matchAll(/`([A-Z][A-Z_]{4,})`/g)].map((m) => m[1]!))].filter(
      (c) => !["LINEAR_TOLERANCE", "RESERVED_NAMES", "MATCH", "ROBUSTNESS", "CODE_MISMATCH", "POTENTIAL_SILENT_WRONG", "FORGE_INTERNAL", "OCCT_INVALID_RESULT"].includes(c),
    );
    expect(codes.length).toBeGreaterThan(8);
    for (const c of codes) expect(PLAYBOOK[c], c).toBeTruthy();
    for (const c of KERNEL_ERROR_CODES) expect(spec).toContain(c);
  });

  it("covers engine plumbing, document rejections, engine-internal prefixes and TS codes", () => {
    for (const c of [...ENGINE_ERROR_CODES, ...DOCUMENT_ERROR_CODES]) expect(PLAYBOOK[c], c).toBeTruthy();
    expect(staticHint("OCCT_BUILD_FAILED")).toMatch(/Engine-internal/);
    expect(staticHint("FORGE_INTERNAL")).toMatch(/Engine-internal/);
    expect(staticHint("TS2353")).toMatch(/Unknown property/);
    expect(staticHint("TS9999")).toMatch(/type error/);
    expect(repairHint("SOMETHING_NEW")).toMatch(/smallest change/);
    expect(coveredCodes()).toContain("SKETCH_OPEN_LOOP");
  });
});

describe("computed hints", () => {
  it("SKETCH_OPEN_LOOP names the dangling end, its nearest partner and the fix", () => {
    const h = repairHint("SKETCH_OPEN_LOOP", { ir: ir(SCENARIOS.plate_open), feature: "base" });
    expect(h).toContain("'right'.end (40, 25) has no partner");
    expect(h).toContain("nearest curve end is 'top'.start (40, 26), 1 mm away (also unmatched");
    expect(h).toContain("set 'top'.start to [40, 25]");
  });

  it("SKETCH_BRANCHING names the shared point and the extra ends", () => {
    const h = repairHint("SKETCH_BRANCHING", { ir: ir(SCENARIOS.plate_branch), feature: "base" });
    expect(h).toMatch(/'bottom'\.start \(-40, -25\) coincides with 2 other ends \('left'\.end, 'dup'\.start\)/);
  });

  it("SKETCH_CURVES_CROSS says where and how far a hole must move", () => {
    const h = repairHint("SKETCH_CURVES_CROSS", { ir: ir(SCENARIOS.plate_hole_cross), feature: "base" });
    expect(h).toMatch(/line 'right' .* and circle 'h1' c=\(38, 0\) r=3 meet at \(40, -?2\.236/);
    expect(h).toMatch(/center is 2 mm from 'right' but its radius is 3/);
  });

  it("REVOLVE_CROSSES_AXIS lists the curves on the wrong side of the axis", () => {
    const h = repairHint("REVOLVE_CROSSES_AXIS", {
      ir: ir(SCENARIOS.rod_cross),
      feature: "rod",
      message: "region ['axis_side', 'cap', 'on_axis', 'outer'] of sketch 'profile' has points on both sides of the revolve axis",
    });
    expect(h).toContain("Axis = the line u = 0");
    expect(h).toContain("mostly on the u > 0 side (up to 10 mm)");
    expect(h).toMatch(/'axis_side' \(reaches \(-5, 0\), 5 mm across\)/);
    expect(h).toContain("to the u < 0 side");
  });

  it("DEPENDENCY_FAILED points at the sketch to fix", () => {
    const h = repairHint("DEPENDENCY_FAILED", { ir: ir(SCENARIOS.plate_open), feature: "slab", message: "sketch 'base' failed with SKETCH_OPEN_LOOP: …" });
    expect(h).toBe("'slab' consumes sketch 'base', which failed with SKETCH_OPEN_LOOP. Fix 'base' (see its own error and hint); 'slab' recovers automatically.");
  });

  it("INCONSISTENT_ARC computes the corrected end point from the source", () => {
    const source = `import { part, sketch, line, arc, extrude, XY } from "@aicad/std";
part("p");
const s = sketch(XY, {
  a: arc({ start: [10, 0], end: [0, 11], center: [0, 0], ccw: true }),
  b: line([0, 11], [10, 0]),
});
`;
    const d = compile(source).diagnostics.find((x) => x.code === "INCONSISTENT_ARC")!;
    const h = repairHint("INCONSISTENT_ARC", { source, span: d.span });
    expect(h).toContain("|start−center| = 10 but |end−center| = 11");
    expect(h).toContain("set end to [0, 10]");
  });

  it("falls back to the static hint when nothing can be computed", () => {
    expect(repairHint("SKETCH_OPEN_LOOP")).toBe(PLAYBOOK["SKETCH_OPEN_LOOP"]);
    expect(repairHint("REVOLVE_CROSSES_AXIS", { ir: ir(SCENARIOS.rod_ok), feature: "rod" })).toBe(PLAYBOOK["REVOLVE_CROSSES_AXIS"]);
  });
});
