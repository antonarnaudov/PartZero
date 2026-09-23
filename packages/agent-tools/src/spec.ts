/**
 * Spec tests: the spec writer's executable tests, written in the `@aicad/evals` hidden-test DSL
 * (same checks, same evaluator), plus the DesignSpec they come with. Results carry **margins**:
 * how much slack a passing test has, or how far a failing one is off.
 */
import { z } from "zod";
import { CHECKS, evaluateTests, measure, testProblems, type CheckContext, type HiddenTest, type Subject, type TestResult } from "@aicad/evals";
import { num, oneLine, vec } from "./format.js";

const BODY_CONDITION_CHECKS = ["volume", "area", "centroid", "bbox_size", "bbox_sorted", "bbox_min", "bbox_max", "face_count", "edge_count", "valid"] as const;

const comparators = {
  eq: z
    .union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional()
    .describe("Exact value (numbers, strings, booleans, or a list such as feature_names)."),
  approx: z
    .union([z.number(), z.array(z.number()), z.literal("$context")])
    .optional()
    .describe('Expected number or vector; needs abs and/or rel. "$context" = same as the starting model (edit tasks).'),
  abs: z.number().optional().describe("Absolute tolerance for approx (mm, mm², mm³)."),
  rel: z.number().optional().describe("Relative tolerance for approx (0.01 = 1%)."),
  between: z
    .union([z.array(z.number()), z.array(z.array(z.number()))])
    .optional()
    .describe("Inclusive [min, max]; for vector measures one [min, max] per element."),
  gte: z.number().optional().describe("Lower bound (inclusive)."),
  lte: z.number().optional().describe("Upper bound (inclusive)."),
};

const params = {
  type: z.string().optional().describe("face_count: plane|cylinder|cone|sphere|torus; edge_count: line|circle|ellipse; feature_count: sketch|extrude|revolve."),
  axis: z.enum(["x", "y", "z"]).optional().describe("Pick one component of a vector measure."),
};

export const bodyConditionSchema = z.strictObject({
  check: z.enum(BODY_CONDITION_CHECKS),
  ...comparators,
  ...params,
});

/** Spec test ids: snake_case identifiers (they are matched exactly and printed into prompts). */
export const SPEC_TEST_ID = /^[A-Za-z][A-Za-z0-9_]*$/;
export const MAX_SPEC_TEST_ID_CHARS = 48;
export const MAX_SPEC_TEST_DESCRIPTION_CHARS = 240;

export const specTestSchema = z.strictObject({
  id: z.string().min(1).max(MAX_SPEC_TEST_ID_CHARS).regex(SPEC_TEST_ID).describe("Unique snake_case id, e.g. outer_size."),
  description: z
    .string()
    .max(MAX_SPEC_TEST_DESCRIPTION_CHARS)
    .describe("What it verifies in plain words (one line), starting with the requirement id, e.g. 'R1: 7 mm across and 1 mm thick'."),
  check: z.enum(CHECKS).describe("The measurement (see the check reference in your instructions)."),
  ...comparators,
  ...params,
  body: z.number().int().optional().describe("Measure one body: 0 = largest by volume, -1 = smallest. Omit for all bodies together."),
  kind: z.enum(["line", "arc", "circle"]).optional().describe("curve_count: which curve kind."),
  diameter: z.array(z.number()).optional().describe("curve_count / hole_pattern / hole_positions: inclusive [min, max] diameter, mm."),
  points: z
    .array(z.array(z.number()))
    .optional()
    .describe(
      "hole_pattern: 2D/3D centres (spacing only matters); hole_positions: 3D points on hole axes, or with relative_to \"edges\" [a, b] distances from the hole to the nearest part edge along the two directions across it.",
    ),
  relative_to: z
    .enum(["model", "edges"])
    .optional()
    .describe('hole_positions: "model" (default) = absolute 3D points; "edges" = [a, b] offsets from the part edges (placement-independent, e.g. a 3.5 mm inset).'),
  tol: z.number().optional().describe("hole_pattern / hole_positions distance tolerance, mm (default 0.05)."),
  where: z.array(bodyConditionSchema).optional().describe("bodies_matching: per-body conditions; the measure is how many bodies meet all of them."),
});

export type SpecTest = z.infer<typeof specTestSchema>;

export const designSpecSchema = z.strictObject({
  summary: z.string().describe("One or two sentences: what is being made and for what."),
  requirements: z
    .array(z.strictObject({ id: z.string().describe("R1, R2, …"), text: z.string().describe("One verifiable requirement.") }))
    .describe("Every requirement the request states or clearly implies."),
  assumptions: z
    .array(
      z.strictObject({
        id: z.string().describe("A1, A2, …"),
        text: z.string().describe("What was not specified."),
        default: z.string().describe("The value chosen (an editable parameter chip)."),
      }),
    )
    .describe("Unstated choices with the default taken."),
  key_dimensions: z
    .array(z.strictObject({ name: z.string(), value: z.number(), unit: z.string().describe("mm, deg, mm², mm³") }))
    .describe("The numbers the design hinges on."),
});

export type DesignSpecInput = z.infer<typeof designSpecSchema>;

export interface DesignSpec extends DesignSpecInput {
  tests: HiddenTest[];
}

/** Drop absent optional keys so the DSL validator sees exactly what was given. */
function clean<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}

export function toHiddenTests(tests: readonly SpecTest[]): HiddenTest[] {
  return tests.map((t) => clean(t) as unknown as HiddenTest);
}

/** DSL problems (schema + semantics) for spec tests; empty = valid. */
export function specTestProblems(tests: readonly HiddenTest[], hasContext: boolean): string[] {
  return testProblems(tests, { hasContext });
}

export interface SpecTestResult extends TestResult {
  /**
   * Slack: for a passing test how far the value could move before failing, for a failing test
   * (negative) how far it is outside the tolerance. Same unit as the measure; absent for exact
   * checks and hole predicates.
   */
  margin?: number;
}

function numbers(v: unknown): number[] | undefined {
  if (typeof v === "number") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as number[];
  return undefined;
}

function marginOf(t: HiddenTest, actual: unknown, expected: unknown): number | undefined {
  const a = numbers(actual);
  if (!a) return undefined;
  if (t.approx !== undefined) {
    const e = numbers(expected);
    if (!e || e.length !== a.length) return undefined;
    return Math.min(...a.map((ai, i) => Math.max(t.abs ?? 0, (t.rel ?? 0) * Math.abs(e[i]!)) - Math.abs(ai - e[i]!)));
  }
  if (t.between !== undefined) {
    const ranges = (Array.isArray(t.between[0]) ? t.between : [t.between]) as [number, number][];
    if (ranges.length !== a.length) return undefined;
    return Math.min(...a.map((ai, i) => Math.min(ai - ranges[i]![0], ranges[i]![1] - ai)));
  }
  if (t.gte !== undefined && a.length === 1) return a[0]! - t.gte;
  if (t.lte !== undefined && a.length === 1) return t.lte - a[0]!;
  return undefined;
}

/** Run spec tests on the candidate (and, for edit tasks, the starting model). Never throws. */
export function runSpecTests(tests: readonly HiddenTest[], candidate: Subject, context?: Subject): SpecTestResult[] {
  const ctx: CheckContext = { candidate, context };
  const results = evaluateTests(tests, ctx);
  return results.map((r, i): SpecTestResult => {
    const t = tests[i]!;
    let expected: unknown = t.approx ?? t.eq;
    if (expected === "$context" && context) {
      const m = measure(t, context, ctx);
      expected = m.ok ? m.value : undefined;
    }
    const margin = r.actual === undefined ? undefined : marginOf(t, r.actual, expected);
    return margin === undefined || !Number.isFinite(margin) ? r : { ...r, margin };
  });
}

function fmtActual(v: unknown): string {
  if (typeof v === "number") return num(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return vec(v as number[]);
  return oneLine(JSON.stringify(v) ?? String(v), 300);
}

/** One line per test: `✓ id: expectation — actual X (margin m)` / `✗ … off by …`. */
export function formatTestResult(r: SpecTestResult): string {
  const mark = r.pass ? "✓" : "✗";
  const actual = r.actual === undefined ? "" : ` — actual ${fmtActual(r.actual)}`;
  const margin = r.margin === undefined ? "" : r.pass ? ` (margin ${num(r.margin)})` : ` (outside by ${num(-r.margin)})`;
  const msg = !r.pass && r.message ? `; ${oneLine(r.message, 300)}` : "";
  return `${mark} ${r.id}: ${oneLine(r.expected, 200)}${actual}${margin}${msg}`;
}

export function summarizeTests(results: readonly SpecTestResult[]): { passed: number; total: number; failing: string[] } {
  return { passed: results.filter((r) => r.pass).length, total: results.length, failing: results.filter((r) => !r.pass).map((r) => r.id) };
}
