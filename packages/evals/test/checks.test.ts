import { describe, expect, it } from "vitest";
import type { SketchFeature } from "@aicad/ir-types";
import { describeTest, evaluateTest, type CheckContext } from "../src/checks.js";
import { sketchCircles } from "../src/ir-geom.js";
import type { HiddenTest } from "../src/task.js";
import { body, compileOk, feature, report, simpleReport } from "./helpers.js";

function run(t: Omit<HiddenTest, "id" | "description">, ctx: CheckContext) {
  return evaluateTest({ id: "t", description: "test", ...t } as HiddenTest, ctx);
}

// Two bodies: a 10x20x5 box at the origin (1000 mm³) and a 2x2x2 cube further out (8 mm³).
const big = body({ min: [0, 0, 0], max: [10, 20, 5], face_types: { plane: 6 }, faces: 6 });
const small = body({ min: [20, 0, 0], max: [22, 2, 2], face_types: { plane: 4, cylinder: 2 }, faces: 6 });
const two = { candidate: { report: simpleReport([small, big], [{ area: 200, loops: 3 }, { area: 4, loops: 1 }]), ir: null } };

describe("comparators", () => {
  it("eq compares exactly (numbers, strings, booleans, arrays)", () => {
    expect(run({ check: "body_count", eq: 2 }, two).pass).toBe(true);
    expect(run({ check: "body_count", eq: 3 }, two).pass).toBe(false);
    expect(run({ check: "status", eq: "ok" }, two).pass).toBe(true);
    expect(run({ check: "valid", eq: true }, two).pass).toBe(true);
    expect(run({ check: "bbox_size", eq: [22, 20, 5] }, two).pass).toBe(true);
    expect(run({ check: "bbox_size", eq: [22, 20, 5.0001] }, two).pass).toBe(false);
  });

  it("approx uses max(abs, rel·|expected|), element-wise for vectors", () => {
    expect(run({ check: "volume", approx: 1010, rel: 0.01 }, two).pass).toBe(true); // 1008 vs 1010 ± 10.1
    expect(run({ check: "volume", approx: 1030, rel: 0.01 }, two).pass).toBe(false);
    expect(run({ check: "volume", approx: 1030, abs: 25 }, two).pass).toBe(true);
    expect(run({ check: "volume", approx: 1030, abs: 1, rel: 0.03 }, two).pass).toBe(true); // max(1, 30.9)
    const vec = run({ check: "bbox_size", approx: [22, 20, 5.2], abs: 0.1 }, two);
    expect(vec.pass).toBe(false);
    expect(vec.message).toContain("element 2");
    expect(run({ check: "bbox_size", approx: [22, 20, 5.05], abs: 0.1 }, two).pass).toBe(true);
  });

  it("approx refuses to compare values of different shapes", () => {
    const r = run({ check: "bbox_size", approx: [22, 20], abs: 1 }, two);
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/cannot compare/);
  });

  it("between is inclusive, scalar or per element", () => {
    expect(run({ check: "volume", between: [1008, 2000] }, two).pass).toBe(true);
    expect(run({ check: "volume", between: [1009, 2000] }, two).pass).toBe(false);
    expect(run({ check: "bbox_sorted", between: [[4, 6], [19, 21], [21, 23]] }, two).pass).toBe(true);
    expect(run({ check: "bbox_sorted", between: [[4, 6], [19, 21], [23, 30]] }, two).pass).toBe(false);
  });

  it("gte / lte", () => {
    expect(run({ check: "body_count", gte: 2 }, two).pass).toBe(true);
    expect(run({ check: "body_count", gte: 3 }, two).pass).toBe(false);
    expect(run({ check: "body_count", lte: 1 }, two).pass).toBe(false);
  });

  it("records the expectation and the measured value for reports", () => {
    const r = run({ check: "volume", approx: 30.44, rel: 0.01 }, two);
    expect(r.expected).toBe("≈ 30.44 ±1%");
    expect(r.actual).toBe(1008);
    expect(run({ check: "bbox_sorted", approx: [5, 20, 22], abs: 0.1 }, two).expected).toBe("≈ [5, 20, 22] ±0.1");
    expect(run({ check: "volume", approx: 1, abs: 0.5, rel: 0.02 }, two).expected).toBe("≈ 1 ±max(0.5, 2%)");
    expect(run({ check: "body_count", gte: 3 }, two).expected).toBe("≥ 3");
  });
});

describe("model and body measurements", () => {
  it("aggregates over all bodies: sums, union box, sorted extents, mass-weighted centroid", () => {
    expect(run({ check: "volume", eq: 1008 }, two).pass).toBe(true);
    expect(run({ check: "bbox_min", eq: [0, 0, 0] }, two).pass).toBe(true);
    expect(run({ check: "bbox_max", axis: "x", eq: 22 }, two).pass).toBe(true);
    expect(run({ check: "bbox_size", axis: "y", eq: 20 }, two).pass).toBe(true);
    expect(run({ check: "bbox_sorted", eq: [5, 20, 22] }, two).pass).toBe(true);
    const cx = (1000 * 5 + 8 * 21) / 1008;
    expect(run({ check: "centroid", axis: "x", approx: cx, abs: 1e-9 }, two).pass).toBe(true);
    expect(run({ check: "face_count", eq: 12 }, two).pass).toBe(true);
    expect(run({ check: "face_count", type: "cylinder", eq: 2 }, two).pass).toBe(true);
    expect(run({ check: "face_count", type: "torus", eq: 0 }, two).pass).toBe(true);
    expect(run({ check: "edge_count", type: "line", eq: 24 }, two).pass).toBe(true);
  });

  it("body selects by volume rank: 0 = largest, -1 = smallest", () => {
    expect(run({ check: "bbox_size", body: 0, eq: [10, 20, 5] }, two).pass).toBe(true);
    expect(run({ check: "volume", body: -1, eq: 8 }, two).pass).toBe(true);
    expect(run({ check: "volume", body: 1, eq: 8 }, two).pass).toBe(true);
    const missing = run({ check: "volume", body: 2, eq: 8 }, two);
    expect(missing.pass).toBe(false);
    expect(missing.message).toMatch(/no body #2/);
  });

  it("counts regions, hole loops and successful features", () => {
    expect(run({ check: "region_count", eq: 2 }, two).pass).toBe(true);
    expect(run({ check: "inner_loops", eq: 2 }, two).pass).toBe(true);
    expect(run({ check: "feature_count", eq: 2 }, two).pass).toBe(true);
    expect(run({ check: "feature_count", type: "extrude", eq: 1 }, two).pass).toBe(true);
    expect(run({ check: "feature_count", type: "revolve", eq: 0 }, two).pass).toBe(true);
  });

  it("valid needs at least one body and every body valid", () => {
    const broken = { candidate: { report: simpleReport([big, body({ valid: false })]), ir: null } };
    expect(run({ check: "valid", eq: true }, broken).pass).toBe(false);
    expect(run({ check: "valid", body: 0, eq: true }, broken).pass).toBe(true);
    const empty = { candidate: { report: report([feature({ type: "sketch" })]), ir: null } };
    expect(run({ check: "valid", eq: true }, empty).pass).toBe(false);
    expect(run({ check: "body_count", eq: 0 }, empty).pass).toBe(true);
    const box = run({ check: "bbox_size", approx: [1, 1, 1], abs: 1 }, empty);
    expect(box.pass).toBe(false);
    expect(box.message).toBe("the model has no bodies");
  });

  it("ignores bodies of failed features and reports status", () => {
    const failed = report(
      [
        feature({ type: "extrude", bodies: [big] }),
        feature({ type: "revolve", status: "error", error: { code: "REVOLVE_CROSSES_AXIS", message: "x" } }),
      ],
      "error",
    );
    const ctx = { candidate: { report: failed, ir: null } };
    expect(run({ check: "status", eq: "ok" }, ctx).pass).toBe(false);
    expect(run({ check: "body_count", eq: 1 }, ctx).pass).toBe(true);
    expect(run({ check: "feature_count", type: "revolve", eq: 0 }, ctx).pass).toBe(true);
  });

  it("bodies_matching counts bodies meeting every condition", () => {
    const where = [
      { check: "bbox_sorted" as const, approx: [2, 2, 2], abs: 0.01 },
      { check: "face_count" as const, type: "cylinder", eq: 2 },
    ];
    expect(run({ check: "bodies_matching", where, eq: 1 }, two).pass).toBe(true);
    expect(run({ check: "bodies_matching", where: [{ check: "volume", gte: 1 }], eq: 2 }, two).pass).toBe(true);
    expect(run({ check: "bodies_matching", where: [where[0]!, { check: "face_count", type: "cylinder", eq: 3 }], eq: 0 }, two).pass).toBe(true);
    expect(describeTest({ id: "x", description: "x", check: "bodies_matching", where, eq: 1 })).toBe(
      "= 1 bodies with bbox_sorted ≈ [2, 2, 2] ±0.01, face_count = 2",
    );
  });
});

const PLATE = `import { part, sketch, line, circle, extrude, XY } from "@aicad/std";
part("p");
const outline = sketch(XY, {
  a: line([0, 0], [50, 0]),
  b: line([50, 0], [50, 40]),
  c: line([50, 40], [0, 40]),
  d: line([0, 40], [0, 0]),
  h1: circle({ center: [5, 5], radius: 1.7 }),
  h2: circle({ center: [36, 5], radius: 1.7 }),
  h3: circle({ center: [36, 25], radius: 1.7 }),
  big: circle({ center: [20, 25], radius: 6 }),
});
const plate = extrude(outline, { distance: 3 });
`;

// The same three holes rotated 90° and mirrored, sketched on a frame 3 mm up (the top face).
const PLATE_ROTATED_TOP = `import { part, sketch, line, circle, extrude, frame } from "@aicad/std";
part("p");
const outline = sketch(frame({ origin: [100, 0, 3], normal: [0, 0, -1], xDir: [1, 0, 0] }), {
  a: line([0, 0], [40, 0]),
  b: line([40, 0], [40, 50]),
  c: line([40, 50], [0, 50]),
  d: line([0, 50], [0, 0]),
  h1: circle({ center: [5, 5], radius: 1.7 }),
  h2: circle({ center: [5, 36], radius: 1.7 }),
  h3: circle({ center: [25, 36], radius: 1.7 }),
});
const plate = extrude(outline, { distance: 3 });
`;

describe("IR checks", () => {
  const ir = compileOk(PLATE);
  const ctx = { candidate: { report: simpleReport([big]), ir } };

  it("curve_count filters by kind and diameter range", () => {
    expect(run({ check: "curve_count", eq: 8 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", kind: "line", eq: 4 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", kind: "circle", diameter: [3.2, 3.5], eq: 3 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", diameter: [11.9, 12.1], eq: 1 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", kind: "arc", eq: 0 }, ctx).pass).toBe(true);
  });

  it("hole_pattern compares pairwise spacing, so placement, rotation and mirroring do not matter", () => {
    const pattern: HiddenTest = { id: "p", description: "p", check: "hole_pattern", diameter: [3.2, 3.5], points: [[0, 0], [31, 0], [31, 20]] };
    expect(evaluateTest(pattern, ctx).pass).toBe(true);
    const rotated = { candidate: { report: simpleReport([big]), ir: compileOk(PLATE_ROTATED_TOP) } };
    expect(evaluateTest(pattern, rotated).pass).toBe(true);
    const wrong = evaluateTest({ ...pattern, points: [[0, 0], [31, 0], [31, 21]] }, ctx);
    expect(wrong.pass).toBe(false);
    expect(wrong.message).toMatch(/hole spacing/);
    const count = evaluateTest({ ...pattern, points: [[0, 0], [31, 0]] }, ctx);
    expect(count.pass).toBe(false);
    expect(count.message).toBe("found 3 circle(s) with a diameter in [3.2, 3.5], expected 2; circles present: Ø3.4 ×3, Ø12 ×1");
  });

  it("hole_positions matches points against hole axes (either face of the plate)", () => {
    const pos: HiddenTest = { id: "p", description: "p", check: "hole_positions", diameter: [3.2, 3.5], points: [[5, 5, 0], [36, 5, 0], [36, 25, 0]] };
    expect(evaluateTest(pos, ctx).pass).toBe(true);
    expect(evaluateTest({ ...pos, points: [[5, 5, 3], [36, 5, 50], [36, 25, -7]] }, ctx).pass).toBe(true);
    const off = evaluateTest({ ...pos, points: [[5, 5, 0], [36, 5, 0], [36, 26, 0]] }, ctx);
    expect(off.pass).toBe(false);
    expect(off.message).toMatch(/no hole axis within 0.05 mm of \[36, 26, 0\]/);
    // The rotated plate's holes are sketched 3 mm up on a flipped frame at x = 100.
    const rotated = { candidate: { report: simpleReport([big]), ir: compileOk(PLATE_ROTATED_TOP) } };
    expect(evaluateTest({ ...pos, points: [[105, -5, 0], [105, -36, 0], [125, -36, 0]] }, rotated).pass).toBe(true);
  });

  describe("hole_positions relative_to edges", () => {
    // The plate is 50 x 40 x 3; h1 (5, 5) → [5, 5], h2 (36, 5) → [5, 14], h3 (36, 25) → [14, 15].
    const plateBody = body({ min: [0, 0, 0], max: [50, 40, 3] });
    const onPlate = { candidate: { report: simpleReport([plateBody]), ir } };
    const edges: HiddenTest = {
      id: "e",
      description: "e",
      check: "hole_positions",
      relative_to: "edges",
      diameter: [3.2, 3.5],
      points: [[5, 5], [5, 14], [14, 15]],
    };

    it("measures each hole's distance to the nearest edge across the hole, order-free", () => {
      const r = evaluateTest(edges, onPlate);
      expect(r.pass).toBe(true);
      expect(r.actual).toEqual([5, 5, 5, 14, 14, 15]);
      expect(r.expected).toBe("3 holes Ø[3.2, 3.5] at [[5, 5], [5, 14], [14, 15]] mm from the nearest edges ±0.05");
      expect(evaluateTest({ ...edges, points: [[15, 14], [5, 5], [14, 5]] }, onPlate).pass).toBe(true);
    });

    it("does not depend on placement, rotation or the face the holes are sketched on", () => {
      // PLATE_ROTATED_TOP maps (u, v) to (100 + u, −v, 3) and extrudes down: x ∈ [100, 140], y ∈ [−50, 0].
      const rotatedBody = body({ min: [100, -50, 0], max: [140, 0, 3] });
      const rotated = { candidate: { report: simpleReport([rotatedBody]), ir: compileOk(PLATE_ROTATED_TOP) } };
      expect(evaluateTest(edges, rotated).pass).toBe(true);
    });

    it("fails with the offsets it found (a centred pattern is not an edge inset)", () => {
      const r = evaluateTest({ ...edges, points: [[5, 5], [5, 14], [14, 16]] }, onPlate);
      expect(r.pass).toBe(false);
      expect(r.message).toBe("no hole [14, 16] mm from the nearest edges (±0.05, measured along X/Y); found [[5, 5], [5, 14], [14, 15]]");
      expect(evaluateTest({ ...edges, points: [[5, 5], [5, 14]] }, onPlate).message).toMatch(/found 3 circle\(s\)/);
    });

    it("uses the union box of all bodies, or the body chosen with body", () => {
      const farAway = body({ min: [200, 0, 0], max: [201, 1, 1], volume: 1 });
      const two = { candidate: { report: simpleReport([plateBody, farAway]), ir } };
      expect(evaluateTest(edges, two).pass).toBe(false);
      expect(evaluateTest({ ...edges, body: 0 }, two).pass).toBe(true);
    });

    it("needs hole axes parallel to X, Y or Z", () => {
      const tilted = compileOk(
        PLATE.replace("sketch(XY,", "sketch(frame({ origin: [0, 0, 0], normal: [1, 1, 0], xDir: [0, 0, 1] }),").replace(
          "extrude, XY }",
          "extrude, frame }",
        ),
      );
      const r = evaluateTest(edges, { candidate: { report: simpleReport([plateBody]), ir: tilted } });
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/not parallel to X, Y or Z/);
    });
  });

  it("IR checks fail with a clear message when there is no IR", () => {
    const noIr = { candidate: { report: simpleReport([big]), ir: null } };
    expect(run({ check: "curve_count", eq: 0 }, noIr).message).toMatch(/no IR/);
    expect(evaluateTest({ id: "p", description: "p", check: "hole_pattern", diameter: [1, 2], points: [[0, 0], [1, 1]] }, noIr).message).toMatch(
      /no IR/,
    );
  });
});

// PLATE with h3 drawn as two semicircles and the Ø12 hole as three 120° arcs (as DXF/SVG imports
// often do), plus an obround slot and a lens: loops with arcs that are *not* full circles.
const ARC_PLATE = `import { part, sketch, line, arc, circle, extrude, XY } from "@aicad/std";
part("p");
const outline = sketch(XY, {
  a: line([0, 0], [50, 0]),
  b: line([50, 0], [50, 40]),
  c: line([50, 40], [0, 40]),
  d: line([0, 40], [0, 0]),
  h1: circle({ center: [5, 5], radius: 1.7 }),
  h2: circle({ center: [36, 5], radius: 1.7 }),
  h3_top: arc({ start: [37.7, 25], end: [34.3, 25], center: [36, 25], ccw: true }),
  h3_bottom: arc({ start: [37.7, 25], end: [34.3, 25], center: [36, 25], ccw: false }),
  big_a: arc({ start: [26, 25], end: [17, 30.196152422706632], center: [20, 25], ccw: true }),
  big_b: arc({ start: [17, 30.196152422706632], end: [17, 19.803847577293368], center: [20, 25], ccw: true }),
  big_c: arc({ start: [17, 19.803847577293368], end: [26, 25], center: [20, 25], ccw: true }),
  slot_r: arc({ start: [44, 30], end: [44, 34], center: [44, 32], ccw: true }),
  slot_t: line([44, 34], [40, 34]),
  slot_l: arc({ start: [40, 34], end: [40, 30], center: [40, 32], ccw: true }),
  slot_b: line([40, 30], [44, 30]),
  lens_top: arc({ start: [8, 30], end: [14, 30], center: [11, 26], ccw: false }),
  lens_bottom: arc({ start: [14, 30], end: [8, 30], center: [11, 34], ccw: false }),
});
const plate = extrude(outline, { distance: 3 });
`;

describe("full circles drawn as arcs", () => {
  const ir = compileOk(ARC_PLATE);
  const ctx = { candidate: { report: simpleReport([body({ max: [50, 40, 3] })]), ir } };
  const sketch = ir.parts[0]!.features[0]! as SketchFeature;

  it("recognises closed loops of co-circular arcs as circles, in curve order", () => {
    expect(sketchCircles(sketch).map((c) => [c.id, 2 * c.radius])).toEqual([
      ["h1", 3.4],
      ["h2", 3.4],
      ["h3_top+h3_bottom", 3.4000000000000057],
      ["big_a+big_b+big_c", 12],
    ]);
  });

  it("curve_count counts such a loop once, as a circle, and not its arcs", () => {
    expect(run({ check: "curve_count", kind: "circle", eq: 4 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", kind: "circle", diameter: [3.2, 3.5], eq: 3 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", kind: "circle", diameter: [11.9, 12.1], eq: 1 }, ctx).pass).toBe(true);
    // Slot and lens arcs are real arcs: they share a loop with lines or lie on different circles.
    expect(run({ check: "curve_count", kind: "arc", eq: 4 }, ctx).pass).toBe(true);
    expect(run({ check: "curve_count", eq: 14 }, ctx).pass).toBe(true); // 6 lines + 4 arcs + 4 circles
  });

  it("hole_pattern and hole_positions find holes drawn as arcs", () => {
    expect(
      evaluateTest({ id: "p", description: "p", check: "hole_pattern", diameter: [3.2, 3.5], points: [[0, 0], [31, 0], [31, 20]] }, ctx).pass,
    ).toBe(true);
    expect(evaluateTest({ id: "p", description: "p", check: "hole_positions", diameter: [11.9, 12.1], points: [[20, 25, 0]] }, ctx).pass).toBe(
      true,
    );
    const census = evaluateTest({ id: "p", description: "p", check: "hole_pattern", diameter: [3.2, 3.5], points: [[0, 0], [1, 0]] }, ctx);
    expect(census.message).toBe("found 3 circle(s) with a diameter in [3.2, 3.5], expected 2; circles present: Ø3.4 ×3, Ø12 ×1");
  });

  it("gives the same answers as the plate drawn with circle curves", () => {
    const circles = { candidate: { report: ctx.candidate.report, ir: compileOk(PLATE) } };
    const tests: Omit<HiddenTest, "id" | "description">[] = [
      { check: "curve_count", kind: "circle", diameter: [3.2, 3.5], eq: 3 },
      { check: "curve_count", kind: "circle", diameter: [11.9, 12.1], eq: 1 },
    ];
    for (const t of tests) {
      expect(run(t, ctx).pass).toBe(run(t, circles).pass);
    }
  });

  it("does not treat an open chain of co-circular arcs as a circle", () => {
    // Half of h3 closed by a line: a D-shaped hole, not a circle.
    const d = compileOk(ARC_PLATE.replace("h3_bottom: arc({ start: [37.7, 25], end: [34.3, 25], center: [36, 25], ccw: false })", "h3_flat: line([37.7, 25], [34.3, 25])"));
    const dCtx = { candidate: { report: ctx.candidate.report, ir: d } };
    expect(run({ check: "curve_count", kind: "circle", diameter: [3.2, 3.5], eq: 2 }, dCtx).pass).toBe(true);
    expect(run({ check: "curve_count", kind: "arc", diameter: [3.2, 3.5], eq: 1 }, dCtx).pass).toBe(true);
  });
});

describe("$context and edit checks", () => {
  const before = compileOk(PLATE);
  const after = compileOk(
    PLATE.replace("radius: 1.7 }),\n  h2", "radius: 2.2 }),\n  h2").replace("big: circle", "big2: circle").replace("distance: 3", "distance: 4"),
  );
  const ctx: CheckContext = {
    candidate: { report: simpleReport([body({ max: [50, 40, 4] })]), ir: after },
    context: { report: simpleReport([body({ max: [50, 40, 3] })]), ir: before },
  };

  it("resolves $context to the same measurement on the context model", () => {
    expect(run({ check: "bbox_size", axis: "x", approx: "$context", abs: 0.001 }, ctx).pass).toBe(true);
    const z = run({ check: "bbox_size", axis: "z", approx: "$context", abs: 0.001 }, ctx);
    expect(z.pass).toBe(false);
    expect(z.expected).toBe("≈ 3 ±0.001 (context)");
    expect(run({ check: "feature_names", eq: "$context" }, ctx).pass).toBe(true);
  });

  it("counts changed curves (added, removed, modified) and changed features by name", () => {
    // h1 modified, big removed, big2 added.
    expect(run({ check: "changed_curves", eq: 3 }, ctx).pass).toBe(true);
    // The extrude distance changed; the sketch's plane did not.
    expect(run({ check: "changed_features", eq: 1 }, ctx).pass).toBe(true);
    const same = { ...ctx, candidate: { ...ctx.candidate, ir: before } };
    expect(run({ check: "changed_curves", eq: 0 }, same).pass).toBe(true);
    expect(run({ check: "changed_features", eq: 0 }, same).pass).toBe(true);
  });

  it("fails clearly without a context model", () => {
    const alone = { candidate: ctx.candidate };
    expect(run({ check: "changed_curves", eq: 0 }, alone).message).toMatch(/no context/);
    expect(run({ check: "bbox_size", approx: "$context", abs: 1 }, alone).message).toMatch(/without a context/);
  });
});
