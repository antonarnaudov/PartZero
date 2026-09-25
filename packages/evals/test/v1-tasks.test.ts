import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { v1 as cs } from "@aicad/cadscript";
import { capabilitiesUsedV1, IR1_CAPABILITIES, isSupported, isV1Task, schemaProblems, semanticProblems, testProblems, testScorability, type TaskFile } from "../src/task.js";
import { compileV1Ok, CORPUS_V1_DIR, corpusTasks, corpusTasksV1 } from "./helpers.js";

const tasks = corpusTasksV1();

describe("MakerBench v1 corpus (corpus/makerbench/v1)", () => {
  it("has the 41 Phase C tasks, every one an IR v1 task that Forge's v1 pipeline supports", () => {
    expect(tasks).toHaveLength(41);
    for (const t of tasks) {
      expect(isV1Task(t), t.id).toBe(true);
      expect(isSupported(t, IR1_CAPABILITIES), `${t.id} requires ${t.requires.join(", ")}`).toBe(true);
    }
  });

  it("declares exactly the capabilities its reference (and T4 context) uses, T5 included", () => {
    // Capability filtering (`isSupported`) must never schedule a reference on an engine that
    // cannot evaluate it, and must not keep a task from an engine that can.
    const wrong: string[] = [];
    for (const t of tasks) {
      const used = new Set(capabilitiesUsedV1(compileV1Ok(t.referenceSource)));
      if (t.contextSource !== undefined) for (const c of capabilitiesUsedV1(compileV1Ok(t.contextSource))) used.add(c);
      const [want, got] = [[...used].sort(), [...t.requires].sort()];
      if (JSON.stringify(want) !== JSON.stringify(got)) wrong.push(`${t.id}: requires ${got.join(", ")}; the reference uses ${want.join(", ")}`);
    }
    expect(wrong).toEqual([]);
  });

  it("covers every tier, with at least five hidden tests per task", () => {
    const byTier = Object.fromEntries(["T1", "T2", "T4", "T5"].map((tier) => [tier, tasks.filter((t) => t.tier === tier).length]));
    expect(byTier).toEqual({ T1: 19, T2: 10, T4: 8, T5: 4 });
    for (const t of tasks) expect(t.hidden_tests.length, t.id).toBeGreaterThanOrEqual(5);
  });

  it("exercises every Phase C operation and the new checks", () => {
    const requires = new Set(tasks.flatMap((t) => t.requires));
    for (const op of ["op/boolean", "op/hole", "op/fillet", "op/chamfer", "op/shell", "op/pattern", "sketch/constraints", "plane/datum", "multi-part"]) {
      expect(requires.has(op), op).toBe(true);
    }
    const checks = new Set(tasks.flatMap((t) => t.hidden_tests.map((h) => h.check)));
    for (const c of ["hole_count", "blend_edges", "shell_thickness", "shell_open_faces", "param_value", "param_count", "param", "ref_stability", "warning_count", "changed_params"]) {
      expect(checks.has(c as never), c).toBe(true);
    }
  });

  it("exercises every hole kind, placement form, depth form, fit, flip and flat tip in the references", () => {
    type Obj = Record<string, unknown>;
    const holes = tasks.flatMap((t) => compileV1Ok(t.referenceSource).parts.flatMap((p) => p.features as unknown as Obj[])).filter((f) => f["type"] === "hole");
    const seen = new Set<string>();
    for (const h of holes) {
      seen.add(`kind:${h["cbore"] ? "counterbore" : h["csink"] ? "countersink" : h["insert"] ? "insert" : "simple"}`);
      if (h["thread"]) seen.add("thread");
      seen.add(`at:${Object.keys(h["at"] as Obj)[0]}`);
      const d = h["depth"];
      seen.add(`depth:${d === undefined ? "insert" : typeof d === "string" ? d : Object.keys(d as Obj)[0]}`);
      seen.add(`fit:${(h["fit"] as string | undefined) ?? "normal"}`);
      if (h["flip"] === true) seen.add("flip");
      if (h["tip"] === "flat") seen.add("tip:flat");
      if (typeof (h["on"] as Obj)["face"] !== "object") seen.add("on:plane");
    }
    for (const want of [
      "kind:simple", "kind:counterbore", "kind:countersink", "kind:insert", "thread",
      "at:list", "at:grid", "at:circle", "at:points",
      "depth:through", "depth:blind", "depth:up_to", "depth:insert",
      "fit:close", "fit:normal", "fit:loose", "fit:tap",
      "flip", "tip:flat", "on:plane",
    ]) {
      expect(seen.has(want), want).toBe(true);
    }
  });

  it("pairs every test of how the model was built with a method-agnostic geometry test", () => {
    // hole_count, blend_edges and shell_* read the hole/fillet/chamfer/shell features: a correct
    // part built another way fails them, so each such task also measures the geometry.
    const built = new Set(["hole_count", "blend_edges", "shell_thickness", "shell_open_faces"]);
    const geometric = new Set(["volume", "area", "centroid", "bbox_size", "bbox_sorted", "bbox_min", "bbox_max", "hole_positions", "hole_pattern", "bodies_matching"]);
    for (const t of tasks) {
      if (!t.hidden_tests.some((h) => built.has(h.check))) continue;
      expect(t.hidden_tests.some((h) => geometric.has(h.check) && testScorability(h) === "geometry"), t.id).toBe(true);
    }
  });

  it("names the construction in the prompt of every task that tests how the model was built", () => {
    // hole_count reads hole features, blend_edges fillet and chamfer features, shell_* shell
    // features: a correct part built another way (a circle cut, a chamfered profile, a pocket)
    // fails them, so the prompt must ask for that construction (the candidates
    // `--circle-cut-bolt-holes`, `--intersected-chamfers` and `--pocketed-not-shelled` show the
    // alternative failing only there).
    const WORDS: Record<string, RegExp> = { hole_count: /hole features?\b/, fillet: /fillet features?\b/, chamfer: /chamfer features?\b/, shell: /shell feature\b/ };
    const missing: string[] = [];
    for (const t of tasks) {
      const checks = t.hidden_tests.flatMap((h) => (h.check === "param" && h.test ? [h.test] : [h]));
      for (const h of checks) {
        const word = h.check === "hole_count" ? "hole_count" : h.check === "blend_edges" ? String(h.type) : h.check.startsWith("shell_") ? "shell" : undefined;
        if (word && !WORDS[word]!.test(t.prompt)) missing.push(`${t.id}: ${h.check}${h.check === "blend_edges" ? ` ${h.type}` : ""} but the prompt does not ask for a ${word.replace("hole_count", "hole")} feature`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it("tags every hidden test with what it needs from a candidate (the STEP-scorable census)", () => {
    const census = { geometry: 0, seam: 0, ir: 0 };
    for (const t of tasks) for (const h of t.hidden_tests) census[testScorability(h)]++;
    // Pinned: a change to the corpus or the tagging shows up here.
    expect(census).toEqual({ geometry: 208, seam: 25, ir: 77 });
  });

  it("uses ids disjoint from the IR v0 corpus", () => {
    const v0 = new Set(corpusTasks().map((t) => t.id));
    expect(tasks.filter((t) => v0.has(t.id)).map((t) => t.id)).toEqual([]);
  });

  it("has references (and T4 contexts) that compile with CadScript v1 and type-check", () => {
    for (const t of tasks) {
      for (const [file, src] of [[t.reference, t.referenceSource], [t.context, t.contextSource]] as const) {
        if (src === undefined) continue;
        const r = cs.compile(src, { fileName: file });
        expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`), `${t.id} ${file}`).toEqual([]);
        expect(cs.typecheck(src), `${t.id} ${file}`).toEqual([]);
      }
    }
  });
});

describe("validation of the v1 checks", () => {
  const base = (): TaskFile => {
    const t = tasks.find((x) => x.id === "t1-cbore-m4-plate")!;
    const { file: _f, referenceSource: _r, contextSource: _c, ...rest } = t;
    return structuredClone(rest);
  };
  const file = `${CORPUS_V1_DIR}t1-cbore-m4-plate.task.json`;

  it("accepts the corpus tasks", () => {
    for (const t of tasks) {
      const { file: f, referenceSource: _r, contextSource: _c, ...rest } = t;
      expect(schemaProblems(rest), t.id).toEqual([]);
      expect(semanticProblems(rest, f), basename(f)).toEqual([]);
    }
  });

  it("rejects v1 checks in IR v0 tasks", () => {
    const t = base();
    t.requires = ["ir/0"];
    expect(semanticProblems(t, file).join("\n")).toMatch(/hole_count measures IR v1 models only/);
  });

  it("rejects malformed param tests", () => {
    const t = base();
    t.hidden_tests = [
      { id: "a", description: "no test inside", check: "param", set: { thick: 10 } } as never,
      { id: "b", description: "a comparator on param", check: "param", set: { thick: 10 }, test: { check: "volume", approx: 1, rel: 0.1 }, eq: 1 } as never,
      { id: "c", description: "context inside a param test", check: "param", set: { thick: 10 }, test: { check: "volume", approx: "$context", rel: 0.1 } } as never,
      { id: "d", description: "nested param test", check: "param", set: { thick: 10 }, test: { check: "param", set: { thick: 9 }, test: { check: "status", eq: "ok" } } } as never,
    ];
    const problems = semanticProblems(t, file).join("\n");
    expect(problems).toMatch(/\(a\): param needs "test"/);
    expect(problems).toMatch(/\(b\): param takes no comparator/);
    expect(problems).toMatch(/\(c\)\.test: "\$context" is not allowed in a param test/);
    expect(problems).toMatch(/\(d\)\.test: a param test cannot contain another param test/);
  });

  it("checks types, names and ranges of the v1 parameters", () => {
    const t = base();
    t.hidden_tests = [
      { id: "a", description: "blend without type", check: "blend_edges", eq: 1 } as never,
      { id: "b", description: "wrong blend type", check: "blend_edges", type: "round", eq: 1 } as never,
      { id: "c", description: "reversed size", check: "blend_edges", type: "fillet", size: [3, 2], eq: 1 } as never,
      { id: "d", description: "through and depth", check: "hole_count", hole: { through: true, depth: [1, 2] }, eq: 1 } as never,
      { id: "e", description: "param_value without name", check: "param_value", eq: 1 } as never,
      { id: "f", description: "unit filter", check: "param_count", type: "inch", gte: 1 } as never,
      { id: "g", description: "v1 feature type", check: "feature_count", type: "fillet", eq: 1 } as never,
    ];
    const problems = semanticProblems(t, file).join("\n");
    expect(problems).toMatch(/\(a\): blend_edges needs type/);
    expect(problems).toMatch(/\(b\): type "round" is not one of fillet, chamfer/);
    expect(problems).toMatch(/\(c\): size range is reversed/);
    expect(problems).toMatch(/\(d\): hole.depth selects blind holes/);
    expect(problems).toMatch(/\(e\): param_value needs "name"/);
    expect(problems).toMatch(/\(f\): type "inch" is not one of mm/);
    expect(problems).not.toMatch(/\(g\)/);
    // The schema rejects unknown hole filter keys and non-literal set values.
    expect(schemaProblems({ ...t, hidden_tests: [{ id: "h", description: "unknown key", check: "hole_count", hole: { colour: "red" }, eq: 1 }] }).join("\n")).toMatch(/hole/);
    expect(schemaProblems({ ...t, hidden_tests: [{ id: "i", description: "string value", check: "param", set: { thick: "10" }, test: { check: "status", eq: "ok" } }] }).join("\n")).toMatch(/set/);
    // circles selects IR v1 circles (holes by default, or every swept circle), on hole predicates only.
    const circles = { id: "j", description: "bosses", check: "hole_positions", circles: "all", diameter: [4, 5], points: [[0, 0, 0]] };
    const volume = { id: "v", description: "volume", check: "volume", approx: 1, rel: 0.01 };
    expect(semanticProblems({ ...t, hidden_tests: [circles as never, volume as never] }, file)).toEqual([]);
    expect(semanticProblems({ ...t, requires: ["ir/0"], hidden_tests: [circles as never] }, file).join("\n")).toMatch(/\(j\): circles selects IR v1 circles/);
    expect(semanticProblems({ ...t, hidden_tests: [{ id: "k", description: "count", check: "hole_count", circles: "all", eq: 1 } as never] }, file).join("\n")).toMatch(/circles/);
    expect(schemaProblems({ ...t, hidden_tests: [{ ...circles, circles: "bosses" }] }).join("\n")).toMatch(/circles/);
  });

  it("validates the hole side parameters: dir is a signed axis, entry needs model points", () => {
    const t = base();
    t.hidden_tests = [
      { id: "a", description: "entry with edge offsets", check: "hole_positions", diameter: [4, 5], relative_to: "edges", entry: true, points: [[8, 8]] } as never,
      { id: "b", description: "entry with model points", check: "hole_positions", diameter: [4, 5], entry: true, points: [[0, 0, 8]] } as never,
      { id: "c", description: "entry on a count", check: "hole_count", entry: true, eq: 1 } as never,
    ];
    const problems = semanticProblems(t, file).join("\n");
    expect(problems).toMatch(/\(a\): entry compares 3D entry points/);
    expect(problems).not.toMatch(/\(b\)/);
    expect(problems).toMatch(/\(c\): "entry" is not a parameter of hole_count/);
    expect(schemaProblems({ ...t, hidden_tests: [{ id: "d", description: "bad direction", check: "hole_count", hole: { dir: "up" }, eq: 1 }] }).join("\n")).toMatch(/dir/);
  });

  it("requires a hole check to come with a volume or face_count test (the hole census is declarative)", () => {
    const t = base();
    const holes = { id: "h", description: "holes", check: "hole_count", eq: 2 };
    const volume = { id: "v", description: "volume", check: "volume", approx: 1, rel: 0.01 };
    const faces = { id: "f", description: "faces", check: "face_count", eq: 10 };
    expect(semanticProblems({ ...t, hidden_tests: [holes as never] }, file).join("\n")).toMatch(/hole checks need a volume or face_count test/);
    expect(semanticProblems({ ...t, hidden_tests: [holes as never, volume as never] }, file)).toEqual([]);
    expect(semanticProblems({ ...t, hidden_tests: [holes as never, faces as never] }, file)).toEqual([]);
    // A param hole check needs a param volume or face_count test with the same set (in any key order).
    const pHoles = { id: "ph", description: "more holes", check: "param", set: { n: 4, w: 2 }, test: { check: "hole_count", eq: 4 } };
    const pOther = { id: "pv", description: "other volume", check: "param", set: { n: 5 }, test: { check: "volume", approx: 1, rel: 0.01 } };
    const pSame = { id: "ps", description: "same volume", check: "param", set: { w: 2, n: 4 }, test: { check: "volume", approx: 1, rel: 0.01 } };
    expect(semanticProblems({ ...t, hidden_tests: [volume as never, pHoles as never, pOther as never] }, file).join("\n")).toMatch(/ph: a param hole check needs a param volume or face_count test with the same set/);
    expect(semanticProblems({ ...t, hidden_tests: [volume as never, pHoles as never, pSame as never] }, file)).toEqual([]);
  });

  it("requires warning_count to name its code (an unfiltered count includes engine-internal notes)", () => {
    const t = base();
    const problems = semanticProblems({ ...t, hidden_tests: [{ id: "w", description: "no warnings", check: "warning_count", eq: 0 } as never] }, file).join("\n");
    expect(problems).toMatch(/\(w\): warning_count needs "code"/);
    expect(schemaProblems({ ...t, hidden_tests: [{ id: "w", description: "no warnings", check: "warning_count", eq: 0 }] }).join("\n")).toMatch(/code/);
    expect(semanticProblems({ ...t, hidden_tests: [{ id: "w", description: "no warnings", check: "warning_count", code: "SKETCH_UNDER_CONSTRAINED", eq: 0 } as never] }, file)).toEqual([]);
  });

  it("testProblems accepts the v1 checks only with v1: true (spec tests of IR v1 models)", () => {
    const tests = [{ id: "c", description: "four counterbores", check: "hole_count", hole: { kind: "counterbore" }, eq: 4 }];
    expect(testProblems(tests).join("\n")).toMatch(/IR v1 models only/);
    expect(testProblems(tests, { v1: true })).toEqual([]);
  });
});
