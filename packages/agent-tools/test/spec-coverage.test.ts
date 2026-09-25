/**
 * "One test per requested feature" (docs/BACKLOG.md, CLI providers): submit_spec refuses a spec in
 * which a requirement has no test or the request names a feature no requirement mentions.
 */
import { describe, expect, it } from "vitest";
import { coveredRequirementIds, designRegistry, DesignSession, featureScope, specCoverage, specCoverageProblems, specFeatureGaps, v1, type CoverageOptions, type DesignToolContext } from "../src/index.js";
import { fixtureEngine } from "./helpers.js";

const KNOB =
  "Simple round knob for a potentiometer with a 6 mm round shaft: 30 mm diameter, 15 mm tall, a 6 mm hole 10 mm deep from the bottom for the shaft, and a 2 mm 45° chamfer around the top edge.";

describe("requirement coverage", () => {
  it("reads the requirement ids a test description starts with", () => {
    expect(coveredRequirementIds("R2: four M3 holes")).toEqual(["R2"]);
    expect(coveredRequirementIds("R1+R2: π/4·(7² − 3.2²)·1")).toEqual(["R1", "R2"]);
    expect(coveredRequirementIds("r1, r3 – size and bore")).toEqual(["R1", "R3"]);
    expect(coveredRequirementIds("R1 and R4: outside")).toEqual(["R1", "R4"]);
    expect(coveredRequirementIds("Volume of the part")).toEqual([]);
    // Wider formats models write.
    expect(coveredRequirementIds("R1 R2: size and bore")).toEqual(["R1", "R2"]);
    expect(coveredRequirementIds("[R2] bore volume")).toEqual(["R2"]);
    expect(coveredRequirementIds("(R3) chamfer faces")).toEqual(["R3"]);
    expect(coveredRequirementIds("R2 - bore depth")).toEqual(["R2"]);
    expect(coveredRequirementIds("R2 bore: depth")).toEqual([]);
  });

  it("finds untested requirements and requested features no requirement names", () => {
    const reqs = [
      { id: "R1", text: "30 mm diameter, 15 mm tall" },
      { id: "R2", text: "2 mm chamfer on the top edge" },
    ];
    const c = specCoverage(reqs, [{ description: "R1: size" }], KNOB);
    expect(c.untested).toEqual(["R2"]);
    expect(c.unmentioned).toEqual([{ feature: "hole", word: "hole" }]);
    const problems = specCoverageProblems(reqs, [{ description: "R1: size" }], KNOB);
    expect(problems[0]).toMatch(/the request asks for a "hole" \(hole\) but no requirement names it/);
    expect(problems[1]).toMatch(/^R2 \(2 mm chamfer on the top edge\) has no test/);
  });

  it("synonyms satisfy a feature (a hole requirement may say bore); ids outside the R pattern count by prefix", () => {
    expect(specCoverage([{ id: "R1", text: "blind shaft bore" }], [{ description: "R1: floor", check: "face_count", eq: 3 }], "a 6 mm hole for the shaft")).toEqual({ untested: [], unmentioned: [], exemptionRefused: [], blind: [], loose: [] });
    expect(specCoverage([{ id: "size", text: "30 mm" }], [{ description: "size: 30 x 30" }]).untested).toEqual([]);
    // A cosmetic thread changes no geometry: the only feature that may go untested.
    expect(specCoverage([{ id: "R1", text: "M3 threaded", untested_reason: "cosmetic thread" }], [], "M3 thread")).toEqual({ untested: [], unmentioned: [], exemptionRefused: [], blind: [], loose: [] });
    // No request (edit tools, tests): only the requirement rule applies.
    expect(specCoverage([{ id: "R1", text: "plate" }], [{ description: "R1: size" }]).unmentioned).toEqual([]);
  });
});

describe("a requested feature cannot escape its test (the knob's blind bore)", () => {
  const PROMPT = "Round knob: 30 mm diameter, 20 mm tall, a 6 mm blind bore 12 mm deep from the bottom.";
  const size = { id: "R1", text: "30 mm diameter, 20 mm tall" };
  const bore = { id: "R2", text: "6 mm blind bore, 12 mm deep" };
  const sizeTest = { description: "R1: 30 x 30 x 20", check: "bbox_sorted" };

  it("refuses untested_reason on a requirement that names a measurable feature", () => {
    const problems = specCoverageProblems([size, { ...bore, untested_reason: "a bore can't be checked" }], [sizeTest], PROMPT);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^R2 \(6 mm blind bore, 12 mm deep\) names a "bore" \(hole\), which is measurable: remove its untested_reason/);
  });

  it("refuses a covering test whose check cannot see the feature (a bbox never changes with a blind bore)", () => {
    const problems = specCoverageProblems([size, bore], [sizeTest, { description: "R2: bbox height is 20", check: "bbox_size" }], PROMPT);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^R2 .* names a "bore" \(hole\) but its tests only use bbox_size, which do not change when the hole is missing/);
    expect(problems[0]).toContain("volume, area, face_count, edge_count, inner_loops, hole_pattern, hole_positions, curve_count");
  });

  it("accepts a test that sees it and pins it: volume, face_count, a hole check, or bodies_matching on one of them", () => {
    for (const t of [
      { description: "R2: volume without the bore", check: "volume", approx: 13798, rel: 0.01 },
      { description: "R2: the bore's floor and wall", check: "face_count", eq: 4 },
      { description: "R2: bore adds area", check: "area", between: [2600, 2700] },
      { description: "[R2] bore position", check: "hole_positions" },
      { description: "R1 R2: the one body has the bore", check: "bodies_matching", where: [{ check: "volume", approx: 13798, rel: 0.01 }], eq: 1 },
      { description: "R1 R2: some body has the bore", check: "bodies_matching", where: [{ check: "volume", approx: 13798, rel: 0.01 }], gte: 1 },
    ]) {
      expect(specCoverageProblems([size, bore], [sizeTest, t], PROMPT), t.description).toEqual([]);
    }
    // bodies_matching on a bbox alone is still blind.
    expect(specCoverageProblems([size, bore], [sizeTest, { description: "R2: one body", check: "bodies_matching", where: [{ check: "bbox_size", approx: [30, 30, 20], abs: 0.1 }], eq: 1 }], PROMPT)).toHaveLength(1);
  });

  it("refuses vacuous and one-sided tests: they pass whether or not the bore is there", () => {
    for (const t of [
      { description: "R2: bore", check: "volume", gte: 0 },
      { description: "R2: bore", check: "face_count", gte: 0 },
      { description: "R2: bore", check: "face_count", lte: 99 },
      { description: "R2: bore", check: "volume", lte: 1e9 },
      { description: "R2: bore", check: "edge_count", gte: 3 },
      { description: "R2: any body", check: "bodies_matching", where: [{ check: "volume", gte: 0 }], eq: 1 },
      { description: "R2: maybe a body", check: "bodies_matching", where: [{ check: "volume", approx: 13798, rel: 0.01 }], gte: 0 },
    ]) {
      const problems = specCoverageProblems([size, bore], [sizeTest, t], PROMPT);
      expect(problems, JSON.stringify(t)).toHaveLength(1);
      expect(problems[0]).toMatch(
        /^R2 \(6 mm blind bore, 12 mm deep\) names a "bore" \(hole\) but its .+ test .+, which passes without the hole: pin it with an exact count \(face_count or edge_count eq — one missing through hole changes a count by 1; e\.g\. face_count type cylinder eq <holes>\) or its volume within ±2 % and with a band \(twice the tolerance\) under the hole's own 339\.29 mm³ \(Ø6, 12 deep\)$/,
      );
      expect(problems[0]).toMatch(/one-sided bound \(gte\/lte; gte 0 always passes\)/);
      expect(specCoverage([size, bore], [sizeTest, t], PROMPT).loose.map((l) => `${l.id}:${l.feature}`)).toEqual(["R2:hole"]);
    }
    // One pinned test is enough next to a loose one.
    expect(specCoverageProblems([size, bore], [sizeTest, { description: "R2: bore", check: "volume", gte: 0 }, { description: "R2: floor", check: "face_count", type: "plane", eq: 3 }], PROMPT)).toEqual([]);
  });

  describe("wide ranges, wide tolerances and blind type filters do not pin a feature (the knob plate's bore)", () => {
    const REQUEST = "A knob plate 80x50x8 with a blind bore of 6 mm, 5 deep";
    const plate = { id: "R1", text: "plate 80 x 50 x 8" };
    const bore = { id: "R2", text: "a blind bore 6 mm diameter 5 deep" };
    const plateTest = { description: "R1: 80 x 50 x 8", check: "bbox_sorted", approx: [8, 50, 80], abs: 0.05 };
    const problems = (t: Record<string, unknown>) => specCoverageProblems([plate, bore], [plateTest, { description: "R2: bore", ...t } as { description: string }], REQUEST);

    it.each([
      [{ check: "volume", between: [0, 1e12] }, "its volume test has a range from 0 (between [0, 1000000000000] also passes when the feature is missing)"],
      [{ check: "volume", between: [1, 1e12] }, "its volume test has a range wider than ±2 % of its middle (between [1, 1000000000000])"],
      [{ check: "volume", approx: 32000, abs: 1e9 }, "its volume test has a tolerance wider than ±2 % of its value (abs 1000000000 on 32000)"],
      [{ check: "volume", approx: 31859, rel: 0.5 }, "its volume test has a tolerance wider than ±2 % (rel 0.5)"],
      // A bore is a few per cent of the volume: ±5 % passes without it (and ±10 % would too).
      [{ check: "volume", approx: 31859, rel: 0.05 }, "its volume test has a tolerance wider than ±2 % (rel 0.05)"],
      [{ check: "volume", between: [30000, 33000] }, "its volume test has a range wider than ±2 % of its middle (between [30000, 33000])"],
      // Within ±2 %, but the band is wider than the bore itself (π/4·6²·5 = 141.4 mm³, 0.44 % of the plate): it passes without the bore.
      [{ check: "volume", approx: 31859, rel: 0.01 }, "its volume test allows a band of 637.18 mm³, as wide as the hole's own volume or wider (≈ 141.37 mm³ at least: Ø6, 5 deep)"],
      [{ check: "volume", approx: 31859, rel: 0.02 }, "its volume test allows a band of 1274.4 mm³"],
      [{ check: "area", between: [2600, 2700] }, "its area test allows a band of 100 mm², as wide as the hole's own area or wider (≈ 94.248 mm² of wall at least: Ø6, 5 deep)"],
      [{ check: "area", between: [-5, 10500] }, "its area test has a range from -5"],
      // A hole's count must be exact: one missing through hole changes a count by 1.
      [{ check: "face_count", between: [1, 99] }, "its face_count test allows between [1, 99] on a count of a hole"],
      [{ check: "face_count", between: [0, 9] }, "its face_count test has a range from 0"],
      [{ check: "face_count", approx: 9, abs: 5 }, "its face_count test allows ±5 (approx 9) on a count of a hole"],
      [{ check: "face_count", between: [7, 9] }, "its face_count test allows between [7, 9] on a count of a hole"],
      [{ check: "face_count", between: [8, 12] }, "its face_count test allows between [8, 12] on a count of a hole"],
      [{ check: "face_count", approx: 9, abs: 2 }, "its face_count test allows ±2 (approx 9) on a count of a hole"],
      [{ check: "face_count", approx: 7, abs: 1 }, "its face_count test allows ±1 (approx 7) on a count of a hole (a missing through hole changes a count by 1: only an exact count sees it)"],
      [{ check: "edge_count", type: "circle", approx: 2, rel: 0.5 }, "its edge_count type circle test allows ±1 (approx 2) on a count of a hole"],
      [{ check: "bodies_matching", where: [{ check: "volume", approx: 31859, rel: 0.01 }], between: [0, 3] }, "its bodies_matching test counts bodies with a bound that passes when none matches (has a range from 0"],
      [{ check: "bodies_matching", where: [{ check: "volume", between: [0, 1e9] }], eq: 1 }, "its bodies_matching test condition volume has a range from 0"],
    ])("refuses %j", (t, why) => {
      const p = problems(t);
      expect(p).toHaveLength(1);
      expect(p[0]).toContain(why);
      expect(specCoverage([plate, bore], [plateTest, { description: "R2: bore", ...t } as { description: string }], REQUEST).loose.map((l) => l.id)).toEqual(["R2"]);
    });

    it.each([
      [{ check: "face_count", type: "torus", eq: 0 }, "face_count type torus"],
      [{ check: "face_count", type: "sphere", between: [0, 0] }, "face_count type sphere"],
      [{ check: "bodies_matching", where: [{ check: "face_count", type: "torus", eq: 0 }], eq: 1 }, "bodies_matching"],
    ])("a face type a hole never has is blind: %j", (t, label) => {
      const p = problems(t);
      expect(p).toHaveLength(1);
      expect(p[0]).toContain(`its tests only use ${label}, which do not change when the hole is missing`);
    });

    it.each([
      { check: "volume", approx: 31859, rel: 0.002 },
      { check: "volume", approx: 31859, abs: 50 },
      { check: "volume", between: [31800, 31900] },
      { check: "area", between: [2620, 2680] },
      { check: "face_count", eq: 8 },
      { check: "face_count", between: [8, 8] },
      { check: "face_count", approx: 8, abs: 0.5 },
      { check: "face_count", type: "cylinder", eq: 1 },
      { check: "face_count", type: "plane", eq: 7 },
      { check: "edge_count", type: "circle", eq: 2 },
      { check: "inner_loops", between: [1, 1] },
      { check: "bodies_matching", where: [{ check: "face_count", type: "cylinder", eq: 1 }], eq: 1 },
    ])("accepts %j", (t) => {
      expect(problems(t)).toEqual([]);
    });

    it("the looser pins still hold for features that are not cavities (a boss: ±10 %, counts ±25 % or ±1)", () => {
      const boss = { id: "R2", text: "a 10 mm boss on top" };
      const bossProblems = (t: Record<string, unknown>) => specCoverageProblems([plate, boss], [plateTest, { description: "R2: boss", ...t } as { description: string }], "A plate 80x50x8 with a 10 mm boss");
      for (const t of [
        { check: "volume", approx: 32785, rel: 0.05 },
        { check: "face_count", between: [8, 12] },
        { check: "face_count", approx: 9, abs: 2 },
      ]) {
        expect(bossProblems(t), JSON.stringify(t)).toEqual([]);
      }
      const p = bossProblems({ check: "volume", approx: 32785, rel: 0.5 });
      expect(p).toHaveLength(1);
      expect(p[0]).toContain("its volume test has a tolerance wider than ±10 % (rel 0.5), which passes without the boss: pin it with eq, approx (rel ≤ 0.1, or abs within 10 % of the value; counts 25 % or ±1) or between (as tight, lower bound above 0)");
    });

    it("per feature group: a fillet has no plane face, a chamfer no cylinder, a slot no cone", () => {
      const req = (text: string) => [{ id: "R1", text }];
      const t = (type: string) => [{ description: "R1: faces", check: "face_count", type, eq: 4 }];
      expect(specCoverage(req("2 mm fillet on the top edges"), t("plane")).blind.map((b) => b.feature)).toEqual(["fillet"]);
      expect(specCoverage(req("2 mm fillet on the top edges"), t("torus")).blind).toEqual([]);
      expect(specCoverage(req("1 mm chamfer"), t("cylinder")).blind.map((b) => b.feature)).toEqual(["chamfer"]);
      expect(specCoverage(req("1 mm chamfer"), t("cone")).blind).toEqual([]);
      expect(specCoverage(req("a 4 mm slot"), t("cone")).blind.map((b) => b.feature)).toEqual(["slot"]);
      // Pockets, bosses, ribs, lips and shells can have any face type.
      expect(specCoverage(req("a spherical pocket"), t("sphere")).blind).toEqual([]);
    });
  });

  it("'socket' names a pocket, but not in a socket head, cap or set screw", () => {
    const pockets = (request: string) => specCoverage([{ id: "R1", text: "30 mm across" }], [{ description: "R1: size", check: "bbox_sorted", approx: [5, 30, 30], abs: 0.1 }], request).unmentioned.map((u) => u.feature);
    for (const request of ["a bracket for M3 socket head cap screws", "use socket-head screws", "a clamp with an M4 socket set screw", "fastened with socket cap screws", "Socket Head Screw holder plate", "a plate for a socket wrench"]) {
      expect(pockets(request), request).toEqual([]);
    }
    for (const request of ["a holder with a socket for a 608 bearing", "a tray with sockets for magnets", "a socket, 22 mm across"]) {
      expect(pockets(request), request).toEqual(["pocket"]);
    }
    // A request that names both: the screw is ignored, the bore is still a hole.
    expect(pockets("a plate with two 3.4 mm bores for M3 socket head cap screws")).toEqual(["hole"]);
  });

  it("names more words for requested features: opening, aperture, socket, keyway", () => {
    for (const [request, feature] of [
      ["a knob with a D-shaped shaft opening", "hole"],
      ["a panel with a 20 mm aperture", "hole"],
      ["a holder with a socket for a 608 bearing", "pocket"],
      ["a pulley with a keyway", "slot"],
    ] as const) {
      expect(specCoverage([{ id: "R1", text: "30 mm across" }], [{ description: "R1: size", check: "bbox_sorted", approx: [5, 30, 30], abs: 0.1 }], request).unmentioned.map((u) => u.feature), request).toEqual([feature]);
    }
    expect(specCoverage([{ id: "R2", text: "D-shaped opening for the shaft" }], [{ description: "R2: shaft", check: "face_count", eq: 9 }], "a knob with a D-shaped shaft opening")).toEqual({ untested: [], unmentioned: [], exemptionRefused: [], blind: [], loose: [] });
  });

  it("on CadScript v1 models the hole checks v1 refuses neither count nor are suggested", () => {
    const holeCheck = { description: "[R2] bore position", check: "hole_positions" };
    expect(specCoverageProblems([size, bore], [sizeTest, holeCheck], PROMPT)).toEqual([]);
    const problems = specCoverageProblems([size, bore], [sizeTest, holeCheck], PROMPT, v1.V1_COVERAGE_OPTIONS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("add a test on its id with volume, area, face_count, edge_count (or bodies_matching");
    expect(problems[0]).toContain("its tests only use hole_positions, which do not change when the hole is missing");
    expect(problems[0]).not.toMatch(/hole_pattern|curve_count|inner_loops/);
  });

  it("on CadScript v1 models inner_loops does not see a hole (a blind bore cut from its own sketch adds no inner loop); it still sees a slot", () => {
    const loops = { description: "R2: the bore", check: "inner_loops", eq: 1 };
    expect(specCoverageProblems([size, bore], [sizeTest, loops], PROMPT)).toEqual([]);
    const problems = specCoverageProblems([size, bore], [sizeTest, loops], PROMPT, v1.V1_COVERAGE_OPTIONS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("its tests only use inner_loops, which do not change when the hole is missing");
    const slot = { id: "R2", text: "a 4 mm slot through the plate" };
    expect(specCoverageProblems([size, slot], [sizeTest, { description: "R2: slot", check: "inner_loops", eq: 1 }], "a plate with a 4 mm slot", v1.V1_COVERAGE_OPTIONS)).toEqual([]);
  });

  it("refuses the knob's vacuous volume test: ±5 % passes with the bore (2.7 % of the volume) missing", () => {
    // The backlog's knob: 30 mm diameter, 15 mm tall, a 6 mm bore 10 mm deep, a 2 mm chamfer.
    // Without bore and chamfer it is π·15²·15 = 10602.9 mm³, 4.56 % above the 10140 the test expects.
    const reqs = [
      { id: "R1", text: "30 mm diameter, 15 mm tall" },
      { id: "R2", text: "6 mm hole 10 mm deep from the bottom for the shaft" },
      { id: "R3", text: "2 mm 45° chamfer around the top edge" },
    ];
    const tests = [
      { description: "R1: size", check: "bbox_size", approx: [30, 30, 15], abs: 0.1 },
      { description: "R2: bore", check: "volume", approx: 10140, rel: 0.05 },
      { description: "R3: chamfer", check: "volume", approx: 10140, rel: 0.05 },
    ];
    expect(Math.abs(Math.PI * 15 ** 2 * 15 - 10140) / 10140).toBeLessThan(0.05);
    const problems = specCoverageProblems(reqs, tests, KNOB, v1.V1_COVERAGE_OPTIONS);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^R2 \(6 mm hole 10 mm deep from the bottom for the shaft\) names a "hole" \(hole\) but its volume test has a tolerance wider than ±2 % \(rel 0\.05\), which passes without the hole/);
    // The chamfer (≈ 180 mm³, 1.7 % of the knob) hides inside ±5 % too: a blend is pinned by an exact count only.
    expect(problems[1]).toMatch(/^R3 \(2 mm 45° chamfer around the top edge\) names a "chamfer" \(chamfer\) but its volume test cannot be held against the chamfer's own volume: a chamfer's share depends on the lengths of the edges it bevels, which no spec states, which passes without the chamfer: pin it with an exact count/);
    // Fixed: the bore's volume within 1 % (a band of 203 mm³ under the bore's 283 mm³), or its two new faces counted exactly; the chamfer's cone counted.
    const cone = { description: "R3: chamfer", check: "face_count", type: "cone", eq: 1 };
    expect(specCoverageProblems(reqs, [tests[0]!, { ...tests[1]!, rel: 0.01 }, cone], KNOB, v1.V1_COVERAGE_OPTIONS)).toEqual([]);
    expect(specCoverageProblems(reqs, [tests[0]!, { description: "R2: bore wall", check: "face_count", type: "cylinder", eq: 2 }, cone], KNOB, v1.V1_COVERAGE_OPTIONS)).toEqual([]);
  });


  it("names the accepted id formats when a requirement has no test", () => {
    const problems = specCoverageProblems([size, bore], [sizeTest], PROMPT);
    expect(problems[0]).toContain('"R1 R2: …", "[R2] …"');
  });
});

describe("small features are pinned by what they change, not by a fixed fraction of the part (review: the knob miss is still open for common parts)", () => {
  const REQUEST = "An 80x50x8 mounting plate with four 3 mm through holes at the corners";
  const plate = { id: "R1", text: "80 x 50 x 8 mm plate" };
  const holes = { id: "R2", text: "four 3 mm through holes at the corners" };
  const plateTest = { description: "R1: 80 x 50 x 8", check: "bbox_sorted", approx: [8, 50, 80], abs: 0.05 };
  const problems = (req: { id: string; text: string }, t: Record<string, unknown>, request = REQUEST, opts: CoverageOptions = v1.V1_COVERAGE_OPTIONS) =>
    specCoverageProblems([plate, req], [plateTest, { description: `${req.id}: feature`, ...t } as { description: string }], request, opts);

  it("four 3 mm through holes in an 80x50x8 plate: ±2 % of the volume (1271 mm³) hides the holes (226 mm³); a band under 226 mm³ or an exact count pins them", () => {
    // Without the holes the plate is 32000 mm³, 0.71 % above the 31774 the test expects.
    expect((32000 - 31774) / 31774).toBeLessThan(0.02);
    const p = problems(holes, { check: "volume", approx: 31774, rel: 0.02 });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("its volume test allows a band of 1271 mm³, as wide as the hole's own volume or wider (≈ 226.19 mm³ at least: 4 × Ø3, through 8 mm (80×50×8)), which passes without the hole");
    expect(p[0]).toContain("with a band (twice the tolerance) under the hole's own 226.19 mm³");
    for (const t of [
      { check: "volume", approx: 31774, rel: 0.002 },
      { check: "volume", approx: 31774, abs: 100 },
      { check: "face_count", type: "cylinder", eq: 4 },
      { check: "edge_count", type: "circle", eq: 8 },
      { check: "face_count", eq: 10 },
    ]) {
      expect(problems(holes, t), JSON.stringify(t)).toEqual([]);
    }
    // The band must be narrower than the share: abs 113 is a band of 226 mm³.
    expect(problems(holes, { check: "volume", approx: 31774, abs: 113.1 })).toHaveLength(1);
  });

  it("a through hole's depth comes from the thickness the spec states anywhere (a key dimension, another requirement); without one its volume cannot pin it", () => {
    const bracket = { id: "R2", text: "two M4 clearance holes through the flange" };
    const r1 = { id: "R1", text: "L bracket 40 x 30" };
    const size = { description: "R1: size", check: "bbox_sorted", approx: [3, 30, 40], abs: 0.1 };
    const request = "An L bracket with two M4 clearance holes";
    const t = (abs: number) => ({ description: "R2: holes", check: "volume", approx: 5000, abs });
    const none = specCoverageProblems([r1, bracket], [size, t(10)], request);
    expect(none).toHaveLength(1);
    expect(none[0]).toContain('its volume test cannot be held against the hole\'s own volume: the requirement states no depth ("N mm deep", or "through" and the part\'s thickness)');
    // An M4 hole is at least its 3.2 mm tap drill; 80 x 50 x 8 in R1 makes 8 mm the part's thinnest: 2 × π/4·3.2²·8 = 128.7 mm³.
    expect(specCoverage([plate, bracket], [plateTest, t(10)], request).loose).toEqual([]);
    const flange = { keyDimensions: [{ name: "flange thickness", value: 3, unit: "mm" }] };
    const scope = featureScope("hole", bracket.text, { texts: [r1.text], ...flange });
    expect(scope.volume?.value).toBeCloseTo(2 * (Math.PI / 4) * 3.2 ** 2 * 3, 9);
    expect(scope.volume?.basis).toBe("≈ 48.255 mm³ at least: 2 × Ø3.2, through flange thickness 3 mm");
    expect(specCoverageProblems([r1, bracket], [size, t(10)], request, flange)).toEqual([]);
    expect(specCoverageProblems([r1, bracket], [size, t(25)], request, flange)[0]).toContain("allows a band of 50 mm³, as wide as the hole's own volume or wider (≈ 48.255 mm³ at least: 2 × Ø3.2, through flange thickness 3 mm)");
  });

  it("a fillet-only requirement pinned by volume is refused (2 mm fillets on four 8 mm edges remove 27 mm³, 0.09 %); only an exact count pins a blend", () => {
    const fillets = { id: "R2", text: "2 mm fillets on the vertical edges" };
    const request = "An 80x50x8 plate with 2 mm fillets on the vertical edges";
    expect(4 * (1 - Math.PI / 4) * 2 ** 2 * 8).toBeCloseTo(27.5, 1);
    for (const t of [
      { check: "volume", approx: 31900, rel: 0.1 },
      { check: "volume", approx: 31972.5, rel: 0.0001 },
      { check: "area", approx: 10000, abs: 1 },
    ]) {
      const p = problems(fillets, t, request);
      expect(p, JSON.stringify(t)).toHaveLength(1);
      expect(p[0]).toContain("cannot be held against the fillet's own");
      expect(p[0]).toContain("a fillet's share depends on the lengths of the edges it rounds, which no spec states");
      expect(p[0]).toContain("pin it with an exact count (face_count eq — a fillet adds one face per edge: face_count type cylinder eq <edges> on straight edges, type torus on round ones, or the untyped face_count); no volume or area tolerance pins a fillet");
    }
    // A fillet on one edge adds exactly one face: ±1 passes without it.
    const one = { id: "R2", text: "a 3 mm fillet on the front top edge" };
    const p = problems(one, { check: "face_count", approx: 7, abs: 1 }, "a plate with a 3 mm fillet on the front top edge");
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("its face_count test allows ±1 (approx 7) on a count of a fillet (a fillet on one edge adds one face: only an exact count sees it)");
    expect(problems(one, { check: "face_count", between: [6, 8] }, "a plate with a 3 mm fillet on the front top edge")[0]).toContain("allows between [6, 8] on a count of a fillet");
    expect(problems(one, { check: "face_count", eq: 7 }, "a plate with a 3 mm fillet on the front top edge")).toEqual([]);
    expect(problems(fillets, { check: "face_count", type: "cylinder", eq: 4 }, request)).toEqual([]);
    expect(problems({ id: "R2", text: "1 mm chamfer around the top" }, { check: "face_count", type: "plane", eq: 10 }, "a plate with a 1 mm chamfer around the top")).toEqual([]);
  });

  describe("loopholes that pass whether or not the feature is there (review)", () => {
    const bore = { id: "R2", text: "a 6 mm blind bore 12 mm deep" };
    const request = "a plate with a 6 mm blind bore 12 mm deep";
    it.each([
      [{ check: "volume", approx: "$context", abs: 1e9 }, 'its volume test compares with the starting model ("$context"), which holds only while the model is unchanged: it fails when the requested hole change is made'],
      [{ check: "face_count", approx: "$context", abs: 0 }, 'its face_count test compares with the starting model ("$context"), which holds only while the model is unchanged'],
      [{ check: "edge_count", eq: "$context" }, 'its edge_count test compares with the starting model ("$context")'],
      [{ check: "volume", approx: "$context", rel: 0.001 }, 'its volume test compares with the starting model ("$context")'],
      [{ check: "bodies_matching", eq: 0, where: [{ check: "volume", approx: 25000, abs: 10 }] }, "its bodies_matching test counts bodies with a bound that passes when none matches (eq 0)"],
      [{ check: "bodies_matching", approx: 0, abs: 0.5, where: [{ check: "volume", approx: 25000, abs: 10 }] }, "its bodies_matching test counts bodies with a bound that passes when none matches (approx 0 abs 0.5)"],
      [{ check: "bodies_matching", lte: 1, where: [{ check: "volume", approx: 25000, abs: 10 }] }, "its bodies_matching test counts bodies with a bound that passes when none matches (only has a one-sided bound"],
      [{ check: "edge_count", type: "ellipse", eq: 0 }, "its tests only use edge_count type ellipse, which do not change when the hole is missing"],
      [{ check: "edge_count", type: "line", eq: 12 }, "its tests only use edge_count type line, which do not change when the hole is missing"],
      [{ check: "edge_count", type: "circle", eq: 0 }, "its tests only use edge_count type circle, which do not change when the hole is missing"],
      [{ check: "face_count", type: "bspline", eq: 0 }, "its tests only use face_count type bspline"],
    ])("refuses %j on a bore", (t, why) => {
      const p = problems(bore, t, request);
      expect(p).toHaveLength(1);
      expect(p[0]).toContain(why);
    });

    it("a round through hole adds no plane; a counterbore's step, a blind floor or a rectangular opening do", () => {
      const p = problems(holes, { check: "face_count", type: "plane", eq: 6 });
      expect(p).toHaveLength(1);
      expect(p[0]).toContain("its tests only use face_count type plane, which do not change when the hole is missing");
      for (const text of ["four 3 mm counterbored through holes", "four 3 mm blind holes 5 mm deep", "a 20 x 10 mm rectangular through opening"]) {
        expect(problems({ id: "R2", text }, { check: "face_count", type: "plane", eq: 10 }, `a plate with ${text}`), text).toEqual([]);
      }
    });

    it("a round hole drilled at an angle may have ellipse edges; a type count of 0 sees a feature being removed", () => {
      expect(problems({ id: "R2", text: "a 6 mm hole at 30° through the slope" }, { check: "edge_count", type: "ellipse", eq: 2 }, "a wedge with a 6 mm hole at 30°")).toEqual([]);
      expect(problems({ id: "R2", text: "remove the 1 mm chamfer on the top edge" }, { check: "face_count", type: "cone", eq: 0 }, "remove the chamfer")).toEqual([]);
      expect(problems({ id: "R2", text: "keep the 1 mm chamfer on the top edge" }, { check: "face_count", type: "cone", eq: 0 }, "keep the chamfer")).toHaveLength(1);
    });

    it("$context pins only what a requirement keeps: a kept bore's exact count, a kept boss by rel (not by abs, whose value is unknown)", () => {
      const kept = { id: "R2", text: "keep the 6 mm blind bore 12 mm deep unchanged" };
      expect(problems(kept, { check: "face_count", approx: "$context", abs: 0 }, request)).toEqual([]);
      expect(problems(kept, { check: "face_count", eq: "$context" }, request)).toEqual([]);
      expect(problems(kept, { check: "face_count", approx: "$context", rel: 0.1 }, request)[0]).toContain("allows rel 0.1 on a count of a hole");
      const boss = { id: "R2", text: "keep the 10 mm boss" };
      expect(problems(boss, { check: "volume", approx: "$context", rel: 0.01 }, "keep the boss")).toEqual([]);
      expect(problems(boss, { check: "volume", approx: "$context", abs: 1e9 }, "keep the boss")[0]).toContain('has abs 1000000000 on "$context", whose value is unknown here');
    });
  });

  describe("featureScope: the sizes a requirement states, read as lower bounds", () => {
    it.each([
      ["a 6 mm blind bore 12 mm deep", [], (Math.PI / 4) * 36 * 12, Math.PI * 6 * 12, "≈ 339.29 mm³ at least: Ø6, 12 deep"],
      ["four 3 mm through holes", ["80x50x8 plate"], 4 * (Math.PI / 4) * 9 * 8, undefined, "≈ 226.19 mm³ at least: 4 × Ø3, through 8 mm (80×50×8)"],
      ["4x M3 holes through the 5 mm thick lid", [], 4 * (Math.PI / 4) * 2.4 ** 2 * 5, undefined, "≈ 90.478 mm³ at least: 4 × Ø2.4, through 5 mm thick"],
      ["a Ø22 socket 7 mm deep for a 608 bearing", [], (Math.PI / 4) * 22 * 22 * 7, Math.PI * 22 * 7, "≈ 2660.9 mm³ at least: Ø22, 7 deep"],
      ["a 20 x 10 mm pocket 3 mm deep", [], (Math.PI / 4) * 200 * 3, (Math.PI / 2) * 30 * 3, "≈ 471.24 mm³ at least: 20×10, 3 deep"],
      ["a 40 x 20 x 5 recess", [], (Math.PI / 4) * 40 * 20 * 5, undefined, "≈ 3141.6 mm³ at least: 40×20×5"],
      ["a slot 4 mm wide and 20 mm long, 2 mm deep", [], (Math.PI / 4) * 80 * 2, (Math.PI / 2) * 24 * 2, "≈ 125.66 mm³ at least: 4×20, 2 deep"],
      ["a 6 mm hole of diameter 6, depth of 10", [], (Math.PI / 4) * 36 * 10, Math.PI * 6 * 10, "≈ 282.74 mm³ at least: Ø6, 10 deep"],
    ])("%s", (text, others, volume, area, basis) => {
      const group = /slot/.test(text) ? "slot" : /pocket|recess|socket/.test(text) ? "pocket" : "hole";
      const s = featureScope(group, text, { texts: others });
      expect(s.volume?.value).toBeCloseTo(volume, 9);
      expect(s.volume?.basis).toBe(basis);
      if (area === undefined) expect(s.area).toBeUndefined();
      else expect(s.area?.value).toBeCloseTo(area, 9);
    });

    it("no size, no share; counts only from a plural noun; blends never have one", () => {
      expect(featureScope("hole", "a hole for the shaft").unknownShare).toBe('states no size (a diameter, or "A x B", with a depth)');
      expect(featureScope("hole", "a 6 mm hole for the shaft").unknownShare).toBe('states no depth ("N mm deep", or "through" and the part\'s thickness)');
      expect(featureScope("hole", "2 mm chamfer on four edges and a 6 mm hole 10 mm deep").volume?.value).toBeCloseTo((Math.PI / 4) * 36 * 10, 9);
      expect(featureScope("hole", "10 mm deep holes of 3 mm diameter, two of them").volume?.value).toBeCloseTo((Math.PI / 4) * 9 * 10, 9);
      expect(featureScope("fillet", "2 mm fillets on 4 edges")).toEqual({ group: "fillet", text: "2 mm fillets on 4 edges", round: false, through: false, angled: false, removal: false, keep: false, roundEdge: false });
      // A part size in a hole's requirement is not the hole's: the plate's 80x50x8 gives the depth, not the footprint.
      const plateHole = featureScope("hole", "a 6 mm hole through the 80x50x8 plate");
      expect(plateHole.round).toBe(true);
      expect(plateHole.volume?.value).toBeCloseTo((Math.PI / 4) * 36 * 8, 9);
      expect(featureScope("hole", "a hole through the 80 x 50 x 8 plate").volume).toBeUndefined();
      expect(featureScope("hole", "a 20 x 10 mm rectangular opening through the 5 mm thick panel").volume?.value).toBeCloseTo((Math.PI / 4) * 200 * 5, 9);
    });

    it("property: for random round holes the share never exceeds the volume the holes really remove", () => {
      let seed = 12345;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
      const words = ["", "one ", "two ", "three ", "four ", "six "];
      for (let i = 0; i < 500; i++) {
        const d = Math.round((1 + rand() * 20) * 10) / 10;
        const n = Math.floor(rand() * words.length);
        const count = n === 0 ? 1 : [1, 2, 3, 4, 6][n - 1]!;
        const plural = count > 1 || n > 0;
        const through = rand() < 0.5;
        const t = Math.round((2 + rand() * 30) * 10) / 10;
        const depth = Math.round((1 + rand() * 30) * 10) / 10;
        const form = Math.floor(rand() * 3);
        const size = form === 0 ? `${d} mm` : form === 1 ? `Ø${d}` : `${d} mm diameter`;
        const noun = plural ? "holes" : "hole";
        const text = through ? `${words[n]}${size} through ${noun}` : `${words[n]}${size} ${noun} ${depth} mm deep`;
        const plateText = `${Math.round(t * 20)}x${Math.round(t * 10)}x${t} plate`;
        const truth = count * (Math.PI / 4) * d * d * (through ? t : depth);
        const s = featureScope("hole", text, { texts: [plateText] });
        expect(s.volume, text).toBeDefined();
        expect(s.volume!.value, `${text} / ${plateText}`).toBeLessThanOrEqual(truth * (1 + 1e-12));
        expect(s.volume!.value, `${text} / ${plateText}`).toBeCloseTo(truth, 6);
        if (!through) expect(s.area!.value).toBeLessThanOrEqual(count * Math.PI * d * depth * (1 + 1e-12));
        else expect(s.area).toBeUndefined();
      }
    });
  });
});

describe("review 3: shares that overstated a feature, $context counts, and type counts round parts never change", () => {
  const opts = v1.V1_COVERAGE_OPTIONS;
  const circle = (d: number) => (Math.PI / 4) * d * d;

  it("a diameter after Ø is never a count: 'Ø12 through holes, one per corner' is refused with a ±3000 mm³ volume test (four holes remove 2714 mm³)", () => {
    const request = "a 200 x 150 x 6 plate with Ø12 through holes, one per corner";
    const r1 = { id: "R1", text: "200 x 150 x 6 plate" };
    const r2 = { id: "R2", text: "Ø12 through holes, one per corner" };
    const size = { description: "R1: size", check: "bbox_sorted", approx: [6, 150, 200], abs: 0.1 };
    expect(4 * circle(12) * 6).toBeLessThan(3000);
    const p = specCoverageProblems([r1, r2], [size, { description: "R2: holes", check: "volume", approx: 177285.7, abs: 3000 }], request, opts);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("its volume test allows a band of 6000 mm³, as wide as the hole's own volume or wider (≈ 678.58 mm³ at least: Ø12, through 6 mm (200×150×6))");
    // An exact count pins them.
    expect(specCoverageProblems([r1, r2], [size, { description: "R2: holes", check: "face_count", type: "cylinder", eq: 4 }], request, opts)).toEqual([]);
    expect(featureScope("hole", "Ø10 through holes at both ends", { texts: ["100 x 20 x 5 bar"] }).volume?.basis).toBe("≈ 392.7 mm³ at least: Ø10, through 5 mm (100×20×5)");
    expect(featureScope("hole", "Ø3 through holes, 2 per side (8 holes)", { texts: ["80x50x8 plate"] }).volume?.basis).toBe("≈ 452.39 mm³ at least: 8 × Ø3, through 8 mm (80×50×8)");
    expect(featureScope("hole", "a 200 x 150 x 6 plate with Ø12 through holes").volume?.basis).toBe("≈ 678.58 mm³ at least: Ø12, through 6 mm (200×150×6)");
    expect(featureScope("hole", "4x M3 holes through the 5 mm thick lid").volume?.basis).toBe("≈ 90.478 mm³ at least: 4 × Ø2.4, through 5 mm thick");
    expect(featureScope("hole", "2 × Ø6 bores through the 10 mm plate", { texts: ["60 x 40 base"] }).volume?.basis).toBe("≈ 565.49 mm³ at least: 2 × Ø6, through 10 mm plate");
  });

  it("a height is never the wall a through hole crosses: the 3 mm sheet L-bracket's 40 mm upright is refused as a depth", () => {
    const request = "L-bracket from 3 mm sheet: 40 mm tall upright, 60 x 40 base, with two Ø5 through holes in the base";
    const r1 = { id: "R1", text: "L-bracket from 3 mm sheet: 40 mm tall upright, 60 x 40 base" };
    const r2 = { id: "R2", text: "two Ø5 through holes in the base" };
    const size = { description: "R1: size", check: "bbox_sorted", approx: [40, 40, 60], abs: 0.1 };
    const p = specCoverageProblems([r1, r2], [size, { description: "R2: holes", check: "volume", approx: 13742, rel: 0.015 }], request, opts);
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("allows a band of 412.26 mm³, as wide as the hole's own volume or wider (≈ 117.81 mm³ at least: 2 × Ø5, through 3 mm sheet)");
    // Without the sheet's thickness, nothing states the wall: the volume cannot pin the holes (never the 40 mm height).
    const noSheet = featureScope("hole", r2.text, { texts: ["L-bracket: 40 mm tall upright, 60 x 40 base"], keyDimensions: [{ name: "height", value: 40, unit: "mm" }] });
    expect(noSheet.volume).toBeUndefined();
    expect(noSheet.unknownShare).toBe('states no depth ("N mm deep", or "through" and the part\'s thickness)');
    // An enclosure's or bracket's "A x B x C" is its envelope, not its wall; a plate's is.
    expect(featureScope("hole", "four Ø4 through holes in the lid", { texts: ["an enclosure 80 x 60 x 40"] }).volume).toBeUndefined();
    expect(featureScope("hole", "four Ø4 through holes in the lid", { texts: ["an enclosure 80 x 60 x 40, 2 mm walls"] }).volume?.basis).toBe("≈ 100.53 mm³ at least: 4 × Ø4, through 2 mm thick");
    expect(featureScope("hole", "four Ø4 through holes", { texts: ["an L bracket", "an 80 x 50 x 8 mm plate"] }).volume?.basis).toBe("≈ 402.12 mm³ at least: 4 × Ø4, through 8 mm (80×50×8)");
    // Stock named by its thickness counts only when a larger part length is stated ("a 100 mm plate" alone may be its width).
    expect(featureScope("hole", "a Ø6 through hole", { texts: ["a 100 mm plate"] }).volume).toBeUndefined();
    expect(featureScope("hole", "a Ø6 through hole", { texts: ["a 6 mm aluminium plate, 100 mm wide"] }).volume?.basis).toBe("≈ 169.65 mm³ at least: Ø6, through 6 mm aluminium plate");
  });

  it("property: unstated counts after a diameter, and heights larger than the wall, never raise the share above the holes' own volume", () => {
    let seed = 777;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    for (let i = 0; i < 600; i++) {
      const d = Math.round((1 + rand() * 20) * 10) / 10;
      const wall = Math.round((1 + rand() * 10) * 10) / 10;
      const height = Math.round((wall + 1 + rand() * 60) * 10) / 10;
      const w = Math.round(wall * 10 + 20 + rand() * 100);
      const l = Math.round(wall * 10 + 20 + rand() * 100);
      // [text, true count]: counts stated, unstated, or after a size; diameters after Ø, M or "mm diameter".
      const holes = pick<[string, number]>([
        [`Ø${d} through holes`, 2 + Math.floor(rand() * 7)],
        [`Ø${d} through holes, one per corner`, 4],
        [`Ø${d} through holes, 2 per side (8 holes)`, 8],
        [`${d} mm diameter through holes at both ends`, 2],
        [`four Ø${d} through holes`, 4],
        [`2x Ø${d} through holes`, 2],
        [`a Ø${d} through hole`, 1],
      ]);
      // [context, wall the holes really cross]: heights and envelopes larger than the wall are stated too.
      const context = pick<string[]>([
        [`${w} x ${l} x ${wall} plate`, `${height} mm tall`],
        [`L-bracket from ${wall} mm sheet: ${height} mm tall upright, ${w} x ${l} base`],
        [`enclosure ${w} x ${l} x ${height}, ${wall} mm walls`],
        [`a box ${w} x ${l} x ${height}`, `wall thickness ${wall}`],
        [`${height} mm high part`, `${wall} mm thick flange`],
      ]);
      const truth = holes[1] * circle(d) * wall;
      const s = featureScope("hole", holes[0], { texts: context, keyDimensions: [{ name: "height", value: height, unit: "mm" }] });
      if (s.volume !== undefined) expect(s.volume.value, `${holes[0]} / ${context.join(" / ")}`).toBeLessThanOrEqual(truth * (1 + 1e-12));
      expect(s.volume, `${holes[0]} / ${context.join(" / ")}: the wall is stated`).toBeDefined();
    }
  });

  it("an edit task's $context count cannot pin an added hole (it passes when the hole is missing); an absolute count can", () => {
    const request = "add a Ø5 through hole in the centre of the plate";
    const r1 = { id: "R1", text: "Ø5 through hole in the centre" };
    for (const t of [
      { description: "R1: hole", check: "face_count", approx: "$context", abs: 0 },
      { description: "R1: hole", check: "edge_count", eq: "$context" },
      { description: "R1: hole", check: "face_count", type: "cylinder", eq: "$context" },
    ]) {
      const p = specCoverageProblems([r1], [t], request, opts);
      expect(p, JSON.stringify(t)).toHaveLength(1);
      expect(p[0]).toContain('compares with the starting model ("$context"), which holds only while the model is unchanged: it fails when the requested hole change is made');
    }
    expect(specCoverageProblems([r1], [{ description: "R1: hole", check: "face_count", type: "cylinder", eq: 1 }], request, opts)).toEqual([]);
    // Removing a feature: "$context" holds while it is still there.
    const removal = { id: "R1", text: "remove the 1 mm chamfer on the top edge" };
    expect(specCoverageProblems([removal], [{ description: "R1: chamfer", check: "face_count", eq: "$context" }], "remove the chamfer", opts)).toHaveLength(1);
    expect(featureScope("hole", "the four Ø3 holes stay as they are").keep).toBe(true);
    expect(featureScope("hole", "remove the Ø3 hole but keep the rest").keep).toBe(false);
  });

  it("type counts that cannot change on round edges and plain round holes do not pin them (the knob is a round part)", () => {
    const knob = "a Ø30 x 20 knob";
    const refused = (text: string, t: Record<string, unknown>, why: string) => {
      const p = specCoverageProblems([{ id: "R2", text }], [{ description: "R2: feature", ...t }], `${knob} with ${text}`, opts);
      expect(p, `${text} ${JSON.stringify(t)}`).toHaveLength(1);
      expect(p[0]).toContain(why);
    };
    const accepted = (text: string, t: Record<string, unknown>) => expect(specCoverageProblems([{ id: "R2", text }], [{ description: "R2: feature", ...t }], `${knob} with ${text}`, opts), `${text} ${JSON.stringify(t)}`).toEqual([]);
    refused("a 2 mm fillet on the top circular edge", { check: "face_count", type: "cylinder", eq: 1 }, "its tests only use face_count type cylinder, which do not change when the fillet is missing");
    accepted("a 2 mm fillet on the top circular edge", { check: "face_count", type: "torus", eq: 1 });
    accepted("2 mm fillets on the vertical edges", { check: "face_count", type: "cylinder", eq: 4 });
    refused("a 1 mm chamfer on the top circular edge", { check: "face_count", type: "plane", eq: 2 }, "its tests only use face_count type plane, which do not change when the chamfer is missing");
    refused("a 1 mm chamfer around the rim", { check: "face_count", type: "plane", eq: 2 }, "face_count type plane");
    accepted("a 1 mm chamfer on the top circular edge", { check: "face_count", type: "cone", eq: 1 });
    accepted("1 mm chamfer around the top", { check: "face_count", type: "plane", eq: 10 });
    refused("a Ø6 through hole", { check: "face_count", type: "cone", eq: 2 }, "its tests only use face_count type cone, which do not change when the hole is missing");
    refused("a Ø6 flat-bottomed hole 10 mm deep", { check: "face_count", type: "cone", eq: 2 }, "face_count type cone");
    accepted("a Ø6 hole 10 mm deep", { check: "face_count", type: "cone", eq: 1 });
    accepted("a Ø6 through hole with a 90° countersink", { check: "face_count", type: "cone", eq: 1 });
    accepted("a 6 x 4 mm rectangular through opening", { check: "face_count", type: "plane", eq: 10 });
  });
});

describe("specFeatureGaps: what stays unchecked when the spec writer never passes submit_spec", () => {
  it("lists every requested feature no pinned test checks, one line each", () => {
    const reqs = [
      { id: "R1", text: "30 mm diameter, 15 mm tall" },
      { id: "R2", text: "blind 6 mm shaft bore" },
      { id: "R3", text: "2 mm chamfer" },
    ];
    const tests = [
      { description: "R1: size", check: "bbox_sorted", approx: [15, 30, 30], abs: 0.1 },
      { description: "R3: one cone", check: "face_count", type: "cone", eq: 1 },
    ];
    expect(specFeatureGaps(reqs, tests, KNOB)).toEqual(['spec: requested hole "bore" has no test that fails when it is missing (R2 has no test)']);
    expect(specFeatureGaps(reqs, [...tests, { description: "R2: bore", check: "volume", gte: 0 }], KNOB)).toEqual(['spec: requested hole "bore" has no test that fails when it is missing (R2\'s volume test only has a one-sided bound (gte/lte; gte 0 always passes))']);
    expect(specFeatureGaps(reqs, [...tests, { description: "R2: bore", check: "volume", between: [0, 1e12] }], KNOB)).toEqual([
      'spec: requested hole "bore" has no test that fails when it is missing (R2\'s volume test has a range from 0 (between [0, 1000000000000] also passes when the feature is missing))',
    ]);
    expect(specFeatureGaps(reqs, [...tests, { description: "R2: bore", check: "bbox_size", approx: [30, 30, 15], abs: 0.1 }], KNOB)).toEqual([
      'spec: requested hole "bore" has no test that fails when it is missing (R2 is only checked by bbox_size)',
    ]);
    expect(specFeatureGaps(reqs, [...tests, { description: "R2: bore floor", check: "face_count", type: "plane", eq: 3 }], KNOB)).toEqual([]);
    // No requirements (the spec writer never submitted one): every feature the request names.
    expect(specFeatureGaps([], tests, KNOB)).toEqual([
      'spec: requested hole "hole" has no test that fails when it is missing (no requirement names it)',
      'spec: requested chamfer "chamfer" has no test that fails when it is missing (no requirement names it)',
    ]);
  });
});

describe("submit_spec", () => {
  it("refuses a spec that leaves a requested feature untested, then accepts the fixed one", async () => {
    const session = await DesignSession.open({ engine: fixtureEngine() });
    const ctx: DesignToolContext = { session, askUser: () => [], request: KNOB };
    const reg = designRegistry();
    const tests = [
      { id: "valid", description: "R1: valid", check: "valid", eq: true },
      { id: "chamfer", description: "R3: one cone", check: "face_count", type: "cone", eq: 1 },
    ];
    const reqs = [
      { id: "R1", text: "30 x 15 mm knob" },
      { id: "R2", text: "6 mm blind bore, 10 mm deep" },
      { id: "R3", text: "2 mm chamfer" },
    ];
    expect((await reg.execute({ name: "set_spec_tests", input: { tests } }, ctx)).isError).toBeFalsy();
    const refused = await reg.execute({ name: "submit_spec", input: { summary: "knob", requirements: reqs, assumptions: [], key_dimensions: [] } }, ctx);
    expect(refused).toMatchObject({ isError: true, data: { kind: "spec_coverage", spec: { summary: "knob", requirements: reqs } } });
    expect(refused.text).toContain("R2 (6 mm blind bore, 10 mm deep) has no test");
    expect(session.testsFrozen).toBe(false);
    await reg.execute({ name: "set_spec_tests", input: { tests: [...tests, { id: "floor", description: "R2: the bore's flat floor", check: "face_count", type: "plane", eq: 3 }] } }, ctx);
    const ok = await reg.execute({ name: "submit_spec", input: { summary: "knob", requirements: reqs, assumptions: [], key_dimensions: [] } }, ctx);
    expect(ok.text).toBe("Spec frozen: 3 requirements, 3 tests.");
  });
});
