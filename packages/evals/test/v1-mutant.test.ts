import { describe, expect, it } from "vitest";
import { v1 as cs } from "@aicad/cadscript";
import { runSuite } from "../src/pipeline.js";
import { MutantSolver } from "../src/solver.js";
import type { CheckName } from "../src/task.js";
import { mutateIrV1, MUTATIONS_V1, type MutationKindV1 } from "../src/v1/mutate.js";
import { compileV1Ok, corpusTasksV1, fixtureEngineV1 } from "./helpers.js";

const tasks = corpusTasksV1();
const doc = (id: string) => compileV1Ok(tasks.find((t) => t.id === id)!.referenceSource);
type Obj = Record<string, unknown>;
const feature = (d: ReturnType<typeof doc>, name: string) => (d.parts.flatMap((p) => p.features) as unknown as Obj[]).find((f) => f["name"] === name)!;

/** How many v1 tasks each mutation applies to. */
const APPLICABLE: Record<MutationKindV1, number> = {
  scale: 41,
  drop_hole: 21,
  hole_size: 23,
  drop_blend: 14,
  blend_size: 14,
  shell_thickness: 8,
  pattern_count: 6,
  hole_flip: 10,
};

const GEOMETRY: readonly CheckName[] = ["volume", "area", "centroid", "bodies_matching", "face_count", "edge_count", "param"];
const HOLES: readonly CheckName[] = ["hole_count", "hole_positions", "hole_pattern", "curve_count"];

/** Checks that must catch each mutation (at least one failing test per caught task is of these kinds). */
const CATCHES: Record<MutationKindV1, readonly CheckName[]> = {
  scale: [...GEOMETRY, ...HOLES, "bbox_size", "bbox_sorted", "bbox_min", "bbox_max", "param_value", "shell_thickness", "blend_edges"],
  drop_hole: [...GEOMETRY, ...HOLES],
  hole_size: [...GEOMETRY, ...HOLES],
  drop_blend: [...GEOMETRY, "blend_edges"],
  blend_size: [...GEOMETRY, "blend_edges"],
  shell_thickness: [...GEOMETRY, "shell_thickness"],
  pattern_count: [...GEOMETRY, ...HOLES],
  hole_flip: [...GEOMETRY, ...HOLES],
};

/** Checks that measure something the mutations do not change: they must keep passing. */
const UNAFFECTED: readonly CheckName[] = ["body_count", "feature_names", "param_count"];

describe("mutateIrV1", () => {
  it("scale grows every length by 10%: literal mm parameters with their bounds, and literal lengths in the features", () => {
    const m = mutateIrV1(doc("t1-cbore-m4-plate"), "scale")!;
    expect(m.params!.find((p) => p.name === "thick")).toMatchObject({ value: 8 * 1.1, min: 5 * 1.1 });
    expect(feature(m, "outline")["curves"]).toMatchObject([{ w: 100 * 1.1, h: 60 * 1.1 }]);
    expect(feature(m, "mounts")["at"]).toMatchObject({ grid: { dx: 84 * 1.1, dy: 44 * 1.1 } });
    expect(feature(m, "plate")["distance"]).toBe("thick"); // an expression scales through its parameter
    // A model without parameters (the knob) scales too.
    const knob = mutateIrV1(doc("t1-knob-v1"), "scale")!;
    expect(knob).not.toBeNull();
    expect(JSON.stringify(knob)).not.toEqual(JSON.stringify(doc("t1-knob-v1")));
    // Blend sizes, shell thickness and pattern spacing are lengths as well.
    const dish = mutateIrV1(doc("t2-filleted-soap-dish"), "scale")!;
    expect(feature(dish, "bottomEdges")["r"]).toBeCloseTo(3 * 1.1, 12);
  });

  it("hole_flip moves every side-sensitive hole on a cap to the other cap; through plain holes and other placements stay", () => {
    const m = mutateIrV1(doc("t1-cbore-m4-plate"), "hole_flip")!;
    expect(feature(m, "mounts")["on"]).toMatchObject({ face: { q: { op: "cap", end: "start" } } });
    const sampler = mutateIrV1(doc("t1-hole-sampler-plate"), "hole_flip")!;
    expect(feature(sampler, "plain")["on"]).toMatchObject({ face: { q: { end: "end" } } }); // a plain through hole has no side
    for (const h of ["cbored", "csunk", "insert"]) expect(feature(sampler, h)["on"], h).toMatchObject({ face: { q: { end: "start" } } });
    expect(mutateIrV1(doc("t1-bolt-circle-flange"), "hole_flip")).toBeNull(); // only through plain holes
  });

  it("drop_hole removes one position (list, sketch points, grid column, bolt circle), else suppresses a free hole", () => {
    expect(feature(mutateIrV1(doc("t1-cbore-m4-plate"), "drop_hole")!, "mounts")["at"]).toMatchObject({ grid: { nx: 1, ny: 2 } });
    expect((feature(mutateIrV1(doc("t2-insert-boss-enclosure"), "drop_hole")!, "inserts")["at"] as { points: { ids: string[] } }).points.ids).toHaveLength(3);
    expect(feature(mutateIrV1(doc("t1-bolt-circle-flange"), "drop_hole")!, "boltHoles")["at"]).toMatchObject({ circle: { n: "(bolts) - 1" } });
    expect(feature(mutateIrV1(doc("t1-knob-v1"), "drop_hole")!, "shaft")["suppressed"]).toBe(true);
    // A single-position hole that a later pattern uses as a seed is not suppressed: the mutation does not apply.
    expect(mutateIrV1(doc("t1-pulley-lightening-holes"), "drop_hole")).toBeNull();
  });

  it("hole_size steps every sized hole up one size (M8 down) and grows explicit diameters", () => {
    const m = mutateIrV1(doc("t1-hole-sampler-plate"), "hole_size")!;
    expect(feature(m, "plain")["d"]).toBeCloseTo(5.5, 12);
    expect(feature(m, "cbored")["size"]).toBe("M4");
    expect(feature(m, "csunk")["size"]).toBe("M5");
  });

  it("drop_blend suppresses the last free fillet or chamfer; blend_size halves it; shell_thickness halves the wall", () => {
    expect(feature(mutateIrV1(doc("t2-filleted-soap-dish"), "drop_blend")!, "bottomEdges")["suppressed"]).toBe(true);
    expect(feature(mutateIrV1(doc("t2-filleted-soap-dish"), "blend_size")!, "bottomEdges")["r"]).toBe(1.5);
    expect(feature(mutateIrV1(doc("t2-filleted-soap-dish"), "shell_thickness")!, "hollow")["thickness"]).toBe("0.5 * (wall)");
    expect(mutateIrV1(doc("t1-cbore-m4-plate"), "drop_blend")).toBeNull();
  });

  it("pattern_count takes one instance away from a linear or circular pattern, and suppresses a free mirror", () => {
    expect((feature(mutateIrV1(doc("t2-spoked-wheel"), "pattern_count")!, "allSpokes")["layout"] as { circular: { count: unknown } }).circular.count).toBe("(spokes) - 1");
    expect(feature(mutateIrV1(doc("t1-mirrored-bracket-arms"), "pattern_count")!, "otherArm")["suppressed"]).toBe(true);
  });

  it("never touches its input", () => {
    for (const t of tasks) {
      const d = compileV1Ok(t.referenceSource);
      const before = structuredClone(d);
      for (const k of MUTATIONS_V1) mutateIrV1(d, k);
      expect(d, t.id).toEqual(before);
    }
  });
});

describe.each(MUTATIONS_V1)("MutantSolver %s on MakerBench v1", (kind) => {
  const solver = new MutantSolver(tasks, kind);
  const applicable = tasks.filter((t) => solver.applicable(t));

  it("applies to the expected tasks", () => {
    expect(applicable.length).toBe(APPLICABLE[kind]);
  });

  it("produces CadScript v1 that compiles and differs from the reference", () => {
    for (const t of applicable) {
      const src = solver.mutant(t)!;
      const r = cs.compile(src);
      expect(r.ok, t.id).toBe(true);
      expect(r.ir).not.toEqual(cs.compile(t.referenceSource).ir);
    }
  });

  it("is caught on every non-T5 task: by the right hidden tests, or by an explicit (SPEC-coded) kernel error", async () => {
    const result = await runSuite(tasks, { solver, engine: fixtureEngineV1() });
    expect(result.skipped.map((s) => s.id).sort()).toEqual(tasks.filter((t) => !solver.applicable(t)).map((t) => t.id));
    const problems: string[] = [];
    for (const r of result.tasks) {
      if (r.tier === "T5") continue; // T5 only checks plausibility ranges; mutants may still be plausible.
      if (r.pass) {
        problems.push(`${r.id}: escaped`);
        continue;
      }
      if (r.category === "kernel") {
        const codes = (r.feature_errors ?? []).map((e) => e.code);
        if (codes.length === 0 || codes.some((c) => /^(FORGE|OCCT|ORACLE)_/.test(c))) problems.push(`${r.id}: kernel failure without a SPEC code (${codes.join(", ")})`);
        continue;
      }
      if (r.category !== "tests") problems.push(`${r.id}: caught in the ${r.category} stage`);
      const failing = r.tests.filter((t) => !t.pass);
      if (!failing.some((t) => CATCHES[kind].includes(t.check))) problems.push(`${r.id}: no ${kind}-sensitive check failed (${failing.map((t) => t.check).join(", ")})`);
      for (const t of failing) if (UNAFFECTED.includes(t.check)) problems.push(`${r.id}: ${t.check} (${t.id}) should not be affected by ${kind}`);
    }
    expect(problems).toEqual([]);
  });
});
