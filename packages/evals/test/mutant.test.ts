import { describe, expect, it } from "vitest";
import { compile } from "@aicad/cadscript";
import { mutateIr, MUTATIONS, type MutationKind } from "../src/mutate.js";
import { runSuite } from "../src/pipeline.js";
import { MutantSolver } from "../src/solver.js";
import type { CheckName } from "../src/task.js";
import { compileOk, corpusTasks, fixtureEngine } from "./helpers.js";

const tasks = corpusTasks();

/** Checks that must catch each mutation (at least one failing test per task is of these kinds). */
const CATCHES: Record<MutationKind, readonly CheckName[]> = {
  scale: [
    "bbox_size",
    "bbox_sorted",
    "bbox_min",
    "bbox_max",
    "volume",
    "area",
    "bodies_matching",
    "hole_pattern",
    "hole_positions",
    "curve_count",
    "changed_curves",
    "changed_features",
  ],
  drop_hole: ["inner_loops", "hole_pattern", "hole_positions", "curve_count", "face_count", "volume", "area", "bodies_matching", "changed_curves"],
  hole_size: ["hole_pattern", "hole_positions", "curve_count", "volume", "area", "bodies_matching", "changed_curves"],
};

/** Checks that measure something the mutation does not change: they must keep passing. */
const UNAFFECTED: Record<MutationKind, readonly CheckName[]> = {
  scale: ["status", "valid", "body_count", "feature_count", "region_count", "inner_loops", "face_count", "edge_count", "feature_names"],
  drop_hole: ["status", "valid", "body_count", "feature_count", "bbox_size", "bbox_sorted", "bbox_min", "bbox_max", "feature_names"],
  hole_size: [
    "status",
    "valid",
    "body_count",
    "feature_count",
    "region_count",
    "inner_loops",
    "face_count",
    "bbox_size",
    "bbox_sorted",
    "bbox_min",
    "bbox_max",
    "feature_names",
  ],
};

describe("mutateIr", () => {
  const washer = compileOk(tasks.find((t) => t.id === "t1-m3-washer")!.referenceSource);

  it("drop_hole removes the bore of a washer, not its rim (holes are found by containment)", () => {
    const m = mutateIr(washer, "drop_hole")!;
    const sketch = m.parts[0]!.features[0]!;
    expect(sketch.type === "sketch" && sketch.curves.map((c) => c.id)).toEqual(["rim"]);
  });

  it("hole_size grows only the smallest holes", () => {
    const fan = compileOk(tasks.find((t) => t.id === "t1-fan40-mount")!.referenceSource);
    const m = mutateIr(fan, "hole_size")!;
    const radii = (m.parts[0]!.features[0]! as { curves: { id: string; radius?: number }[] }).curves.filter((c) => c.radius !== undefined);
    expect(radii.find((c) => c.id === "air")!.radius).toBe(19);
    expect(radii.find((c) => c.id === "m3_a")!.radius).toBeCloseTo(1.87, 12);
  });

  it("returns null when there are no holes, and never touches the input", () => {
    const knob = compileOk(tasks.find((t) => t.id === "t1-knob")!.referenceSource);
    const before = structuredClone(knob);
    expect(mutateIr(knob, "drop_hole")).toBeNull();
    expect(mutateIr(knob, "hole_size")).toBeNull();
    expect(mutateIr(knob, "scale")).not.toBeNull();
    expect(knob).toEqual(before);
  });
});

describe.each(MUTATIONS)("MutantSolver %s", (kind) => {
  const solver = new MutantSolver(tasks, kind);
  const applicable = tasks.filter((t) => solver.applicable(t));

  it("applies to the expected tasks", () => {
    expect(applicable.length).toBe(kind === "scale" ? 40 : 18);
  });

  it("produces CadScript that compiles and differs from the reference", () => {
    for (const t of applicable) {
      const src = solver.mutant(t)!;
      expect(compile(src).ok).toBe(true);
      expect(compile(src).ir).not.toEqual(compile(t.referenceSource).ir);
    }
  });

  it("is caught by the hidden tests of every non-T5 task, by the right checks", async () => {
    const result = await runSuite(tasks, { solver, engine: fixtureEngine() });
    expect(result.skipped.map((s) => s.id).sort()).toEqual(tasks.filter((t) => !solver.applicable(t)).map((t) => t.id));
    const problems: string[] = [];
    for (const r of result.tasks) {
      if (r.tier === "T5") continue; // T5 only checks plausibility ranges; mutants may still be plausible.
      const failing = r.tests.filter((t) => !t.pass);
      if (r.pass || r.category !== "tests") problems.push(`${r.id}: expected a test failure, got pass=${r.pass} category=${r.category}`);
      if (!failing.some((t) => CATCHES[kind].includes(t.check))) problems.push(`${r.id}: no ${kind}-sensitive check failed`);
      for (const t of failing) {
        if (UNAFFECTED[kind].includes(t.check)) problems.push(`${r.id}: ${t.check} (${t.id}) should not be affected by ${kind}`);
      }
    }
    expect(problems).toEqual([]);
    expect(result.summary.validity_rate).toBe(1); // mutants are valid geometry, just wrong
  });
});

describe("T5 plausibility", () => {
  it("accepts a scaled design (under-specified prompts only check plausibility)", async () => {
    const t5 = tasks.filter((t) => t.tier === "T5");
    const result = await runSuite(t5, { solver: new MutantSolver(tasks, "scale"), engine: fixtureEngine() });
    expect(result.summary.pass_at_1).toBe(1);
  });
});
