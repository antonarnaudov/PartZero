import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, typecheck } from "@aicad/cadscript";
import { IR0_CAPABILITIES, isSupported, schemaProblems, semanticProblems, taskFiles, type TaskFile } from "../src/task.js";
import { CORPUS_DIR, corpusTasks } from "./helpers.js";

const tasks = corpusTasks();

function raw(id: string): TaskFile {
  return JSON.parse(readFileSync(join(CORPUS_DIR, `${id}.task.json`), "utf8")) as TaskFile;
}

describe("MakerBench corpus", () => {
  it("has 61 tasks: 34 T1, 14 T2, 8 T4, 5 T5", () => {
    expect(taskFiles(CORPUS_DIR)).toHaveLength(61);
    const byTier = Object.fromEntries(["T1", "T2", "T4", "T5"].map((t) => [t, tasks.filter((x) => x.tier === t).length]));
    expect(byTier).toEqual({ T1: 34, T2: 14, T4: 8, T5: 5 });
  });

  it("is loaded in id order with unique ids", () => {
    const ids = tasks.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const task of tasks) {
    describe(task.id, () => {
      it("validates against makerbench-task.schema.json", () => {
        expect(schemaProblems(raw(task.id))).toEqual([]);
      });

      it("passes the semantic checks", () => {
        expect(semanticProblems(raw(task.id), task.file)).toEqual([]);
      });

      it("has at least 3 hidden tests, each with a plain-words description", () => {
        expect(task.hidden_tests.length).toBeGreaterThanOrEqual(3);
        for (const t of task.hidden_tests) expect(t.description.length).toBeGreaterThanOrEqual(8);
      });

      it("requires IR v0 only (solvable by today's engines)", () => {
        expect(task.requires).toContain("ir/0");
        expect(isSupported(task, IR0_CAPABILITIES)).toBe(true);
      });

      it("has a reference (and context) that compiles and type-checks cleanly", () => {
        for (const src of [task.referenceSource, task.contextSource].filter((s): s is string => s !== undefined)) {
          const r = compile(src);
          expect(r.diagnostics).toEqual([]);
          expect(r.ok).toBe(true);
          expect(typecheck(src)).toEqual([]);
        }
      });

      if (task.tier === "T4") {
        it("T4: starts from a context file that differs from the reference", () => {
          expect(task.contextSource).toBeDefined();
          expect(task.contextSource).not.toBe(task.referenceSource);
        });
      }
      if (task.tier === "T5") {
        it("T5: records the clarifying questions and the assumed defaults", () => {
          expect(task.clarify?.questions.length).toBeGreaterThan(0);
          expect(task.clarify?.assumptions.length).toBeGreaterThan(10);
        });
      }
    });
  }
});

describe("task schema", () => {
  const good = raw("t1-m3-washer");
  const mutate = (f: (t: Record<string, unknown>) => void) => {
    const t = structuredClone(good) as unknown as Record<string, unknown>;
    f(t);
    return schemaProblems(t);
  };
  const tests = (t: Record<string, unknown>) => t.hidden_tests as Record<string, unknown>[];

  it("accepts a valid task", () => {
    expect(schemaProblems(good)).toEqual([]);
  });

  it("rejects fewer than 3 hidden tests", () => {
    expect(mutate((t) => (t.hidden_tests = tests(t).slice(0, 2))).join()).toMatch(/must NOT have fewer than 3 items/);
  });

  it("rejects unknown checks, unknown properties and approx without a tolerance", () => {
    expect(mutate((t) => (tests(t)[0]!.check = "weight")).join()).toMatch(/hidden_tests\/0\/check/);
    expect(mutate((t) => (tests(t)[0]!.colour = "red")).join()).toMatch(/colour/);
    expect(mutate((t) => delete tests(t)[4]!.rel).join()).toMatch(/hidden_tests\/4/);
    expect(mutate((t) => (tests(t)[4]!.abs = 1)).join()).toEqual("");
  });

  it("requires a context for T4 and clarify for T5, and a well-formed id", () => {
    expect(mutate((t) => (t.tier = "T4")).join()).toMatch(/context/);
    expect(mutate((t) => (t.tier = "T5")).join()).toMatch(/clarify/);
    expect(mutate((t) => (t.id = "Washer M3")).join()).toMatch(/\/id/);
    expect(mutate((t) => (t.requires = ["feature/revolve"])).join()).toMatch(/requires/);
  });
});

describe("semantic task checks", () => {
  const file = join(CORPUS_DIR, "t1-m3-washer.task.json");
  const good = raw("t1-m3-washer");
  const withTest = (extra: Record<string, unknown>) => ({
    ...good,
    hidden_tests: [...good.hidden_tests, { id: "extra", description: "an extra test", ...extra }],
  }) as TaskFile;

  it("needs exactly one comparator", () => {
    expect(semanticProblems(withTest({ check: "volume", gte: 1, lte: 2 }), file).join()).toMatch(/exactly one comparator/);
    expect(semanticProblems(withTest({ check: "volume" }), file).join()).toMatch(/exactly one comparator/);
  });

  it("rejects parameters a check does not take and vector/scalar mix-ups", () => {
    expect(semanticProblems(withTest({ check: "volume", axis: "x", gte: 1 }), file).join()).toMatch(/"axis" is not a parameter of volume/);
    expect(semanticProblems(withTest({ check: "bbox_sorted", approx: 5, abs: 1 }), file).join()).toMatch(/vector/);
    expect(semanticProblems(withTest({ check: "face_count", type: "cylindre", eq: 1 }), file).join()).toMatch(/type "cylindre"/);
    expect(semanticProblems(withTest({ check: "hole_pattern", diameter: [3, 4], points: [[0, 0], [1, 1]], eq: 1 }), file).join()).toMatch(
      /predicate/,
    );
  });

  it("hole_positions takes 3D points, or [a, b] offset pairs with relative_to edges (and body only then)", () => {
    const edges = { check: "hole_positions", diameter: [3.2, 3.5], relative_to: "edges" };
    expect(semanticProblems(withTest({ ...edges, points: [[5, 5], [5, 14]] }), file)).toEqual([]);
    expect(semanticProblems(withTest({ ...edges, points: [[5, 5], [5, 14]], body: 0 }), file)).toEqual([]);
    expect(semanticProblems(withTest({ ...edges, points: [[5, 5, 0]] }), file).join()).toMatch(/offset pairs/);
    expect(semanticProblems(withTest({ ...edges, points: [[-1, 5]] }), file).join()).toMatch(/cannot be negative/);
    const model = { check: "hole_positions", diameter: [3.2, 3.5], points: [[5, 5, 0]] };
    expect(semanticProblems(withTest({ ...model, relative_to: "model" }), file)).toEqual([]);
    expect(semanticProblems(withTest({ ...model, body: 0 }), file).join()).toMatch(/"body" is only used by hole_positions with relative_to "edges"/);
    expect(semanticProblems(withTest({ check: "hole_pattern", diameter: [3, 4], points: [[0, 0], [1, 1]], relative_to: "edges" }), file).join()).toMatch(
      /"relative_to" is not a parameter of hole_pattern/,
    );
    expect(schemaProblems({ ...good, hidden_tests: [...good.hidden_tests, { id: "x", description: "an extra test", ...model, relative_to: "corner" }] }).join()).toMatch(
      /relative_to/,
    );
  });

  it("only allows $context and change checks when there is a context file", () => {
    expect(semanticProblems(withTest({ check: "volume", approx: "$context", rel: 0.01 }), file).join()).toMatch(/context file/);
    expect(semanticProblems(withTest({ check: "changed_curves", eq: 0 }), file).join()).toMatch(/needs a context file/);
  });

  it("checks the id against the file name and test ids for duplicates", () => {
    expect(semanticProblems({ ...good, id: "t1-m3-washer-2" }, file).join()).toMatch(/does not match the file name/);
    expect(semanticProblems(withTest({ id: "valid", check: "valid", eq: true }), file).join()).toMatch(/duplicate id "valid"/);
  });
});
