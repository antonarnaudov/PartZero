/**
 * The hand-written MakerBench v1 candidates (`corpus/makerbench/v1/candidates`, `candidates.ts`):
 * each wrong one fails its task's hidden tests — through the check that names the mistake, not by
 * accident — and each correct one built another way than the reference passes them.
 */
import { describe, expect, it } from "vitest";
import { v1 as cs } from "@aicad/cadscript";
import { loadCandidates, readCandidate } from "../src/candidates.js";
import { runSuite, type TaskResult } from "../src/pipeline.js";
import { solverFromFunction } from "../src/solver.js";
import { CORPUS_V1_DIR, corpusTasksV1, fixtureEngineV1 } from "./helpers.js";

const tasks = corpusTasksV1();
const candidates = loadCandidates(CORPUS_V1_DIR);

/** The hidden tests that must catch each wrong candidate (at least one of them fails). */
const CAUGHT_BY: Record<string, readonly string[]> = {
  "t1-bolt-circle-flange--chamfer-bottom": ["chamfer_on_top"],
  "t1-cbore-m4-plate--cbore-from-bottom": ["from_top", "cbores"],
  "t1-csink-angle-bracket--csink-outside": ["positions"],
  "t1-magnetic-parts-tray--pointed-magnet-pockets": ["flat_bottoms", "volume"],
  "t2-insert-boss-enclosure--inserts-from-below": ["insert_positions", "inserts"],
  "t4-counterbore-the-holes--cbore-from-bottom": ["same_places", "cbores"],
  "t4-deeper-pocket-keeps-fillet--fillet-rebound": ["refs_stable"],
  "t1-knob-v1--chamfer-bottom": ["chamfer_on_top"],
  "t4-add-top-fillet--fillet-bottom": ["fillet_on_top"],
  "t2-rounded-box-chamfered-lid--chamfer-underneath": ["lid_chamfer_on_top"],
  "t1-bolt-circle-flange--circle-cut-bolt-holes": ["bolt_holes"],
  "t1-chamfered-spacer-block--intersected-chamfers": ["chamfers"],
  "t2-filleted-soap-dish--pocketed-not-shelled": ["shelled", "open_top"],
};

/**
 * The construction families (holes, blends, shells): a correct part built another way than the
 * feature the prompt asks for. Its geometry passes every geometry test, and it fails exactly the
 * tests that read the construction — the choice the task notes record.
 */
const CONSTRUCTION_ONLY: Record<string, readonly string[]> = {
  "t1-bolt-circle-flange--circle-cut-bolt-holes": ["bolt_holes"],
  "t1-chamfered-spacer-block--intersected-chamfers": ["chamfers"],
  "t2-filleted-soap-dish--pocketed-not-shelled": ["open_top", "shelled"],
};

async function score(id: string, source: string): Promise<TaskResult> {
  const task = tasks.find((t) => t.id === id)!;
  const result = await runSuite([task], { solver: solverFromFunction("candidate", () => Promise.resolve({ cadscript: source })), engine: fixtureEngineV1() });
  return result.tasks[0]!;
}

describe("MakerBench v1 candidates", () => {
  it("are named after an existing task, state their verdict and compile", () => {
    expect(candidates.length).toBeGreaterThanOrEqual(12);
    for (const c of candidates) {
      expect(tasks.some((t) => t.id === c.task), c.file).toBe(true);
      expect(c.why.length, c.file).toBeGreaterThan(20);
      expect(cs.compile(c.source).ok, c.file).toBe(true);
    }
    // Every wrong candidate names the tests that catch it.
    expect(candidates.filter((c) => c.expect === "fail").map((c) => `${c.task}--${c.label}`).sort()).toEqual(Object.keys(CAUGHT_BY).sort());
  });

  it("reject a malformed name or header", () => {
    expect(() => readCandidate("/x/no-label.cad.ts")).toThrow(/<task id>--<label>/);
  });

  it.each(candidates.map((c) => [`${c.task}--${c.label}`, c] as const))("%s gets its verdict", async (name, c) => {
    const r = await score(c.task, c.source);
    const failing = r.tests.filter((t) => !t.pass).map((t) => t.id);
    if (c.expect === "pass") {
      expect({ pass: r.pass, category: r.category, failing }, c.why).toEqual({ pass: true, category: null, failing: [] });
      return;
    }
    expect(r.pass, c.why).toBe(false);
    expect(r.category, `${name}: ${r.error?.message ?? ""}`).toBe("tests");
    expect(failing.some((id) => CAUGHT_BY[name]!.includes(id)), `${name} failed ${failing.join(", ")}`).toBe(true);
    if (CONSTRUCTION_ONLY[name]) expect([...failing].sort(), `${name}: only the construction tests fail`).toEqual(CONSTRUCTION_ONLY[name]);
  });

  it("cover each construction family, and the task notes record the choice", () => {
    for (const name of Object.keys(CONSTRUCTION_ONLY)) {
      const task = tasks.find((t) => name.startsWith(`${t.id}--`))!;
      expect(task.notes ?? "", name).toMatch(/Construction:/);
    }
  });

  it("the rebound fillet is caught by reference stability, with the reason", async () => {
    const c = candidates.find((x) => x.label === "fillet-rebound")!;
    const r = await score(c.task, c.source);
    const refs = r.tests.find((t) => t.id === "refs_stable")!;
    expect(refs).toMatchObject({ pass: false, actual: 1 });
    expect(refs.message).toMatch(/pocketCorners\/edges now selects 4 \(was 4: 4 added, 4 removed\)/);
    // blend_edges alone cannot tell: the new fillet also rounds four edges at R5.
    expect(r.tests.find((t) => t.id === "fillet_kept")!.pass).toBe(true);
  });
});
