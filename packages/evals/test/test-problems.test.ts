import { describe, expect, it } from "vitest";
import { testProblems } from "../src/task.js";
import { corpusTasks } from "./helpers.js";

describe("testProblems (hidden tests validated outside a task file)", () => {
  it("accepts every corpus task's hidden tests", () => {
    for (const t of corpusTasks()) expect(testProblems(t.hidden_tests, { hasContext: t.context !== undefined }), t.id).toEqual([]);
  });

  it("reports schema problems with the test's index and id", () => {
    const problems = testProblems([{ id: "vol", description: "volume about right", check: "volume", approx: 10 }]);
    expect(problems.join("\n")).toMatch(/^tests\[0\] \(vol\)/);
    expect(testProblems([{ id: "x", description: "unknown check here", check: "weight", eq: 1 }]).join()).toMatch(/tests\[0\] \(x\)\/check/);
  });

  it("applies the semantic checks and rejects duplicate ids", () => {
    const two = { id: "n", description: "two comparators", check: "body_count", eq: 1, gte: 1 };
    expect(testProblems([two]).join()).toMatch(/exactly one comparator/);
    const ctx = { id: "c", description: "same volume as before", check: "volume", approx: "$context", rel: 0.01 };
    expect(testProblems([ctx]).join()).toMatch(/context file/);
    expect(testProblems([ctx], { hasContext: true })).toEqual([]);
    const ok = { id: "b", description: "exactly one body", check: "body_count", eq: 1 };
    expect(testProblems([ok, ok]).join()).toMatch(/duplicate id "b"/);
  });
});
