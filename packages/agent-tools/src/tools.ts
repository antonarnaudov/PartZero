/**
 * The v0 design tools. Every result is a short, plain-text delta (≤ ~2k tokens) that names
 * features and curves by their CadScript names and carries a repair hint for every error.
 *
 * Designer: apply_cadscript, ask_user, checkpoint, get_code, ir_summary, measure, propose,
 *           rollback, run_tests
 * Spec writer: set_spec_tests, submit_spec
 */
import { z } from "zod";
import type { HiddenTest, Subject } from "@aicad/evals";
import type { FeatureReport } from "@aicad/ir-types";
import { capList, clip, ident, num, oneLine, plural } from "./format.js";
import { defineTool, ToolRegistry, type AgentTool, type ToolOutput } from "./registry.js";
import type { ApplyOutcome, DesignSession, Verification } from "./session.js";
import { patchSource, PatchError, featureConstNames } from "./source.js";
import { designSpecSchema, formatTestResult, specCoverageProblems, specTestProblems, specTestSchema, summarizeTests, toHiddenTests, type DesignSpec, type SpecTestResult } from "./spec.js";
import { specTestProblemsV1, V1_COVERAGE_OPTIONS } from "./v1/spec-subject.js";
import { featureResultText, irSummary, measureText, modelTotals, totalsText } from "./summaries.js";

/**
 * What a clarification question is about: a closed set of labels. The independent spec writer sees
 * only this label and the user's answer, never the designer's question text (audit M19).
 */
export const CLARIFICATION_TOPICS = ["units", "overall_size", "thickness", "hole_size", "count", "position", "fit", "shape", "material_process", "other"] as const;
export type ClarificationTopic = (typeof CLARIFICATION_TOPICS)[number];

/** A readable label for a clarification topic (unknown or missing → "other"). */
export function clarificationTopicLabel(topic: string | undefined): string {
  const labels: Record<ClarificationTopic, string> = {
    units: "units",
    overall_size: "overall size",
    thickness: "thickness or height",
    hole_size: "hole or fastener size",
    count: "number of features",
    position: "position or spacing",
    fit: "fit or clearance",
    shape: "shape",
    material_process: "material or process",
    other: "other",
  };
  return (CLARIFICATION_TOPICS as readonly string[]).includes(topic ?? "") ? labels[topic as ClarificationTopic] : labels.other;
}

export interface UserQuestion {
  id: string;
  /** What the question is about (default `other`). */
  topic?: ClarificationTopic | undefined;
  question: string;
  options?: string[] | undefined;
  default: string;
}

/**
 * What the dialect-independent tools (get_code, ask_user, checkpoint, run_tests, propose,
 * set_spec_tests, submit_spec) need from a session: the v0 {@link DesignSession} and the v1
 * `v1.DesignSessionV1` both provide it.
 */
export interface CoreSession {
  readonly source: string;
  /** `"v1"` for an IR v1 session (spec tests are validated for v1 models). */
  readonly dialect?: "v1";
  readonly verification: { readonly ok: boolean };
  readonly tests: readonly HiddenTest[];
  readonly testsFrozen: boolean;
  /** The starting model of an edit task (for `$context` tests). */
  readonly context: Subject | undefined;
  featureSource(name: string): { text: string; line: number; endLine: number } | undefined;
  checkpoint(label: string): { id: string; label: string; applyIndex: number; state: { verification: { ok: boolean } } };
  runTests(): SpecTestResult[] | undefined;
  setSpecTests(tests: readonly HiddenTest[]): void;
  freezeSpec(spec: Omit<DesignSpec, "tests">): DesignSpec;
}

/** The context of the dialect-independent tools. */
export interface CoreToolContext {
  session: CoreSession;
  /** Answers questions: the user (interactive) or the task's recorded defaults (eval). */
  askUser(questions: readonly UserQuestion[]): Promise<string[]> | string[];
  /** Ask/explain mode: tools that change the design refuse. */
  readOnly?: boolean;
  /**
   * The maker's request (spec writer), with the user's clarification answers appended: `submit_spec`
   * checks that every feature it names has a requirement, and every requirement a test. It is only
   * scanned for feature words and sizes, never shown to a model from here.
   */
  request?: string | undefined;
}

export interface DesignToolContext extends CoreToolContext {
  session: DesignSession;
}

export interface Proposal {
  summary: string;
  assumptions: string[];
  known_issues: string[];
  /** Ids of failing spec tests the designer is certain contradict the request (exact ids). */
  acknowledged_tests?: string[];
}

export const DESIGNER_TOOLS = ["apply_cadscript", "ask_user", "checkpoint", "get_code", "ir_summary", "measure", "propose", "rollback", "run_tests"] as const;
export const SPEC_WRITER_TOOLS = ["set_spec_tests", "submit_spec"] as const;
export const READ_ONLY_TOOLS = ["get_code", "ir_summary", "measure", "run_tests"] as const;

/** Most spec tests one `set_spec_tests` call may set (keeps every test listing inside the result cap). */
export const MAX_SPEC_TESTS = 12;

const LEVEL_NAMES = ["compile", "kernel", "expectations", "spec tests"] as const;

function readOnlyRefusal(name: string): ToolOutput {
  return { text: `${name} is not available in question mode: this request only asks about the design. Answer from get_code / ir_summary / measure.`, isError: true, data: { kind: "read_only" } };
}

// ─── Apply result formatting ─────────────────────────────────────────────────────────────────

function sameResult(a: FeatureReport | undefined, b: FeatureReport): boolean {
  return a !== undefined && a.status === b.status && JSON.stringify(a.bodies ?? a.regions ?? null) === JSON.stringify(b.bodies ?? b.regions ?? null);
}

function testsLine(tests: readonly SpecTestResult[]): string[] {
  const s = summarizeTests(tests);
  const lines = [`L3 spec tests: ${s.passed}/${s.total} pass`];
  const failing = tests.filter((t) => !t.pass);
  lines.push(...capList(failing, 8, (t) => `  ${formatTestResult(t)}`, (n) => `  … ${n} more failing (run_tests lists all)`));
  if (failing.length === 0) {
    const tight = tests.filter((t) => t.margin !== undefined).sort((a, b) => a.margin! - b.margin!)[0];
    if (tight) lines.push(`  tightest: ${formatTestResult(tight)}`);
  }
  return lines;
}

/** The verification ladder as text (shared by apply_cadscript and rollback). */
export function formatVerification(v: Verification, previous?: readonly FeatureReport[]): string[] {
  const lines: string[] = [];
  const errors = v.diagnostics.filter((d) => d.severity === "error");
  const warnings = v.diagnostics.filter((d) => d.severity !== "error");
  if (errors.length > 0) {
    lines.push(`L0 compile: ${plural(errors.length, "error")}`);
    for (const d of errors.slice(0, 6)) {
      lines.push(`  ✗ ${d.line}:${d.col} ${d.code}${d.feature ? ` in ${ident(d.feature)}` : ""}: ${oneLine(d.message)}`);
      if (d.excerpt) lines.push(`    > ${oneLine(d.excerpt)}`);
      lines.push(`    fix: ${oneLine(d.hint)}`);
    }
    if (errors.length > 6) lines.push(`  … ${errors.length - 6} more errors (fix these first)`);
  } else {
    lines.push("L0 compile + typecheck: ok");
  }
  for (const d of warnings.slice(0, 2)) lines.push(`  note ${d.code}${d.feature ? ` in ${ident(d.feature)}` : ""}: ${oneLine(d.message)}`);

  if (v.engineError) {
    lines.push(`L1 kernel: engine error ${ident(v.engineError.code)}: ${oneLine(v.engineError.message)}`, `  fix: ${oneLine(v.engineError.hint)}`);
  }
  const k = v.kernel;
  if (k) {
    const failed = k.features.filter((f) => f.status !== "ok");
    lines.push(`L1 kernel (${oneLine(k.engine, 80)}): ${k.status}${failed.length > 0 ? `, ${plural(failed.length, "feature")} failed` : ""}`);
    if (k.documentError) lines.push(`  ✗ document ${ident(k.documentError.code)}: ${oneLine(k.documentError.message)}`, `    fix: ${oneLine(k.documentError.hint)}`);
    // Root causes first: a DEPENDENCY_FAILED consumer repeats its sketch's error.
    const ordered = [...failed].sort((a, b) => Number(a.code === "DEPENDENCY_FAILED") - Number(b.code === "DEPENDENCY_FAILED"));
    for (const f of ordered.slice(0, 6)) {
      lines.push(`  ✗ ${ident(f.feature)} (${ident(f.type)}) ${ident(f.code ?? "UNKNOWN")}: ${oneLine(f.message ?? "")}`);
      lines.push(`    fix: ${oneLine(f.hint ?? "")}`);
    }
    if (ordered.length > 6) lines.push(`  … ${ordered.length - 6} more failed features`);
    const prevByName = new Map((previous ?? []).map((f) => [f.feature, f] as const));
    const okChanged = k.features.filter((f) => f.status === "ok").filter((f) => !sameResult(prevByName.get(f.feature), f as FeatureReport));
    const okSame = k.features.filter((f) => f.status === "ok").length - okChanged.length;
    lines.push(
      ...capList(
        okChanged,
        8,
        (f) => `  ✓ ${ident(f.feature)} (${ident(f.type)}): ${featureResultText(f as FeatureReport)}`,
        (n) => `  … ${n} more changed features (measure lists all)`,
      ),
    );
    if (okSame > 0) lines.push(`  (${plural(okSame, "other feature")} unchanged)`);
  }
  if (v.expectations.length > 0) {
    lines.push(
      `L2 expect: ${v.expectations.map((x) => `${x.pass ? "✓" : "✗"} ${ident(x.feature)}.${x.check} ${x.expected}${x.pass ? "" : ` — actual ${x.actual}`}`).join("; ")}`,
    );
  }
  if (v.tests) lines.push(...testsLine(v.tests));
  return lines;
}

export function formatApply(o: ApplyOutcome, notes: readonly string[] = []): string {
  const v = o.after.verification;
  const head = v.ok
    ? `apply #${o.index}: OK (L0–L2 pass${v.tests ? `; spec tests ${summarizeTests(v.tests).passed}/${v.tests.length}` : ""})`
    : `apply #${o.index}: FAILED at L${v.failedAt ?? 0} (${LEVEL_NAMES[v.failedAt ?? 0]})`;
  const lines = [head];
  if (notes.length > 0) lines.push(`patches: ${notes.join("; ")}`);
  lines.push(`changes: ${o.changesText}`);
  lines.push(...formatVerification(v, o.before.report?.features));
  if (o.after.report && o.after.report.status === "ok") lines.push(`model: ${totalsText(modelTotals(o.after.report))}`);
  if (!v.ok) lines.push("next: fix the first root-cause error above with the smallest change (patch that feature), then apply again.");
  else if (v.tests && v.tests.some((t) => !t.pass)) lines.push("next: keep building; failing spec tests show what is still missing or off.");
  else if (v.tests) lines.push("next: all spec tests pass — check anything else the request needs, then propose.");
  return lines.join("\n");
}

// ─── Tools ───────────────────────────────────────────────────────────────────────────────────

// Every tool input is a strict object: unknown keys are errors (the advertised JSON Schema says
// `additionalProperties: false`, so silently stripping them would hide a model's mistake).
const expectationSchema = z.strictObject({
  feature: z.string().describe("Feature const name."),
  bodies: z.number().int().optional().describe("Exact number of bodies it creates."),
  regions: z.number().int().optional().describe("Sketch: exact number of regions."),
  holes: z.number().int().optional().describe("Sketch: exact number of holes (inner loops) over all regions."),
  volume: z.number().optional().describe("Total volume of its bodies, mm³ (±1%)."),
  bbox_size: z.array(z.number()).optional().describe("Axis-aligned size [x, y, z] of its bodies, mm (±0.05)."),
});

const patchSchema = z.strictObject({
  feature: z.string().describe("Const name of the feature to replace or delete, or the name of a new feature to insert."),
  code: z.string().describe("The complete replacement statement(s), e.g. `const plate = extrude(base, { distance: 8 });`. Empty string deletes the feature."),
  after: z.string().optional().describe("New features only: insert after this feature const (default: end of file)."),
});

const getCode = defineTool({
  name: "get_code",
  readOnly: true,
  description: "Read the current CadScript file, or only one feature's `const` statement (with the comments above it and its line numbers).",
  input: z.strictObject({ feature: z.string().optional().describe("Feature const name; omit for the whole file.") }),
  run(input, { session }: CoreToolContext) {
    const feature = input.feature;
    if (feature !== undefined) {
      const f = session.featureSource(feature);
      if (!f) return { text: `No feature const "${feature}". Features: ${featureConstNames(session.source).join(", ") || "none"}.`, isError: true };
      return { text: `${feature} (lines ${f.line}–${f.endLine}):\n${f.text}` };
    }
    if (session.source.trim() === "") return { text: "(empty file: nothing has been applied yet — start with apply_cadscript { source })" };
    const n = session.source.split("\n").length;
    return { text: clip(`${plural(n, "line")}:\n${session.source}`, undefined, "call get_code with feature: <name>") };
  },
});

const applyCadscript = defineTool({
  name: "apply_cadscript",
  description:
    "Change the design, then verify it: L0 compile + typecheck, L1 kernel evaluation, L2 your `expect` checks, L3 the spec tests. " +
    "Give EITHER `source` (the complete file: first version or big rewrites) OR `patches` (edit features by const name: replace, delete, or insert new ones). " +
    "The result is a short delta: errors with a concrete fix, bodies of changed features, spec test status. Build in small steps (1–3 features per call).",
  input: z.strictObject({
    source: z.string().optional().describe("The COMPLETE new CadScript file."),
    patches: z.array(patchSchema).optional().describe("Targeted edits, applied in order. Prefer this for small changes."),
    expect: z.array(expectationSchema).optional().describe("L2 checks for this step, e.g. [{ feature: 'plate', bodies: 1, bbox_size: [80, 50, 8] }]."),
    note: z.string().optional().describe("One line: what this step does."),
  }),
  async run(input, { session, readOnly }: DesignToolContext) {
    if (readOnly) return readOnlyRefusal("apply_cadscript");
    const source = input.source;
    const patches = input.patches;
    if (source !== undefined && patches !== undefined) {
      return {
        text: "Give either `source` (whole file) or `patches`, not both (omit the one you do not use; an empty `patches` list counts as given). Nothing was applied.",
        isError: true,
        data: { kind: "bad_input" },
      };
    }
    if (source === undefined && !patches?.length) {
      return { text: "Give exactly one of `source` (whole file) or `patches` (non-empty list). Nothing was applied.", isError: true, data: { kind: "bad_input" } };
    }
    let next = source ?? "";
    let notes: string[] = [];
    if (patches?.length) {
      try {
        const r = patchSource(session.source, patches);
        next = r.source;
        notes = r.notes;
      } catch (e) {
        if (e instanceof PatchError) return { text: `${e.message}. Nothing was applied.`, isError: true, data: { kind: "bad_input" } };
        throw e;
      }
    }
    const expect = input.expect ?? [];
    const outcome = await session.apply(next, { expect });
    const v = outcome.after.verification;
    return {
      text: formatApply(outcome, notes),
      isError: !v.ok,
      data: {
        kind: "apply",
        index: outcome.index,
        ok: v.ok,
        failedAt: v.failedAt,
        level: v.level,
        errorSignature: v.errorSignature,
        engineError: v.engineError?.code,
        tests: v.tests ? summarizeTests(v.tests) : undefined,
        note: input.note,
      },
    };
  },
});

const irSummaryTool = defineTool({
  name: "ir_summary",
  readOnly: true,
  description: "Compact list of every feature with its key parameters (plane, curves, distances, axis) and its latest result (regions, bodies, errors).",
  input: z.strictObject({}),
  run(_input, { session }: DesignToolContext) {
    if (session.ir) return { text: irSummary(session.ir, session.report) };
    if (session.source.trim() === "") return { text: "Nothing has been applied yet." };
    const last = [...session.checkpoints].reverse().find((c) => c.state.ir);
    const errs = session.verification.diagnostics.filter((d) => d.severity === "error").length;
    return {
      text: `The current source does not compile (${plural(errs, "error")}; see the last apply result).${last?.state.ir ? `\nLast compiled checkpoint ${last.id} "${last.label}":\n${irSummary(last.state.ir, last.state.report)}` : ""}`,
      isError: true,
    };
  },
});

const measureTool = defineTool({
  name: "measure",
  readOnly: true,
  description:
    "Metrics from the latest evaluation. Without arguments: every feature briefly plus model totals. With `feature`: bodies in detail (volume, area, centroid, bbox, face/edge counts by type) or sketch regions (area, loops, holes, outer curves).",
  input: z.strictObject({
    feature: z.string().optional().describe("Feature const name."),
    body: z.number().int().optional().describe("With feature: only this body index."),
  }),
  run(input, { session }: DesignToolContext) {
    const report = session.report;
    if (!report) return { text: "No evaluation report: the current source does not compile. Fix the errors from the last apply first.", isError: true };
    return { text: measureText(report, { feature: input.feature, body: input.body }) };
  },
});

const setSpecTests = defineTool({
  name: "set_spec_tests",
  description:
    "Set the executable spec tests (replaces any previous set). Each test is one measurement plus one expectation in the check DSL. Returns the problems if any test is invalid; fix them and call again.",
  input: z.strictObject({ tests: z.array(specTestSchema).max(MAX_SPEC_TESTS).describe("3–12 tests covering the requirements: at least one per requirement, and one per feature the request names.") }),
  run(input, { session }: CoreToolContext) {
    if (session.testsFrozen) {
      return {
        text: "The spec tests are frozen. The builder cannot change them; if you are certain a test contradicts the request, put its exact id in acknowledged_tests when you propose and say why in known_issues.",
        isError: true,
      };
    }
    const tests = toHiddenTests(input.tests);
    if (tests.length === 0) return { text: "Give at least one test.", isError: true };
    const problems = session.dialect === "v1" ? specTestProblemsV1(tests, session.context !== undefined) : specTestProblems(tests, session.context !== undefined);
    if (problems.length > 0) {
      return { text: `Invalid tests (nothing stored):\n${capList(problems, 12, (p) => `- ${p}`).join("\n")}`, isError: true, data: { kind: "spec_tests", ok: false } };
    }
    session.setSpecTests(tests);
    return { text: `${plural(tests.length, "test")} set: ${tests.map((t) => t.id).join(", ")}. Call submit_spec to finish.`, data: { kind: "spec_tests", ok: true, count: tests.length } };
  },
});

const submitSpec = defineTool({
  name: "submit_spec",
  description:
    "Finish: record the DesignSpec (summary, requirements, assumptions with defaults, key dimensions) and freeze the tests set with set_spec_tests. " +
    "Refused while a requirement has no test (description starting with its id), the request names a feature (hole, bore, slot, pocket, chamfer, fillet, boss, rib, lip, thread, hollow) that no requirement mentions, " +
    "or a requirement naming such a feature (a cosmetic thread aside) has untested_reason, only tests that cannot see it (a bbox or body count never sees a bore: use volume, face_count, edge_count, area, inner_loops — on CadScript v1 not for a hole — or, on CadScript v0 models, hole checks), " +
    "or only tests that do not pin it (gte/lte, a between from 0, a tolerance wider than ±10 % — counts ±25 % or ±1 — or a count type the feature never has, e.g. face_count type torus or edge_count type ellipse eq 0 for a bore: pin it with eq, approx or a tight between). " +
    "Holes, bores, slots, pockets, fillets and chamfers are small: pin their face_count/edge_count exactly (eq, e.g. face_count type cylinder eq <holes>); a volume/area test pins a cavity only within ±2 % and with a band (twice the tolerance) narrower than the cavity's own volume, which the gate reads from the sizes its requirement states (diameter and depth, or \"through\" and the part's thickness — never a height), and never pins a fillet or chamfer. " +
    'In an edit task a test compared with the starting model ("$context") pins only what a requirement keeps as it is: a feature the request adds, removes or resizes needs its own absolute value.',
  input: designSpecSchema,
  run(input, { session, request }: CoreToolContext) {
    if (session.testsFrozen) return { text: "The spec is already frozen.", isError: true };
    if (session.tests.length === 0) return { text: "Set valid tests with set_spec_tests first.", isError: true };
    const gaps = specCoverageProblems(input.requirements, session.tests, request, { ...(session.dialect === "v1" ? V1_COVERAGE_OPTIONS : {}), keyDimensions: input.key_dimensions });
    if (gaps.length > 0) {
      return {
        text: `Not frozen: the spec does not check everything the request asks for (one test per requested feature):\n${capList(gaps, 10, (g) => `- ${g}`).join("\n")}\nFix the tests with set_spec_tests (and the requirements), then call submit_spec again.`,
        isError: true,
        // The refused spec rides along: if the spec writer never gets past this, the orchestrator
        // freezes its tests with these requirements and lists what stays unchecked (specFeatureGaps).
        data: { kind: "spec_coverage", gaps, spec: input },
      };
    }
    const spec = session.freezeSpec(input);
    return { text: `Spec frozen: ${plural(spec.requirements.length, "requirement")}, ${plural(spec.tests.length, "test")}.`, data: { kind: "spec", spec } };
  },
});

const runTests = defineTool({
  name: "run_tests",
  readOnly: true,
  description: "Run the frozen spec tests on the current model. Every result has its margin: the slack left (passing) or how far outside the tolerance (failing).",
  input: z.strictObject({}),
  run(_input, { session }: CoreToolContext) {
    if (session.tests.length === 0) return { text: "There are no spec tests for this task; verify against the request with measure." };
    const results = session.runTests();
    if (!results) return { text: "No evaluation report: the current source does not compile or evaluate. Fix it first.", isError: true };
    const s = summarizeTests(results);
    return { text: [`${s.passed}/${s.total} spec tests pass`, ...results.map((r) => formatTestResult(r))].join("\n"), data: { kind: "tests", ...s } };
  },
});

const checkpointTool = defineTool({
  name: "checkpoint",
  description: "Save the current state under a label, to roll back to later. (A checkpoint is also taken automatically after every successful apply.)",
  input: z.strictObject({ label: z.string().max(80).describe("Short label, e.g. 'base plate ok'.") }),
  run(input, { session, readOnly }: CoreToolContext) {
    if (readOnly) return readOnlyRefusal("checkpoint");
    const cp = session.checkpoint(input.label);
    return { text: `Checkpoint ${cp.id} "${cp.label}" saved (after apply #${cp.applyIndex}, ${cp.state.verification.ok ? "verified ok" : "NOT verified ok"}).`, data: { kind: "checkpoint", id: cp.id } };
  },
});

const rollbackTool = defineTool({
  name: "rollback",
  description: "Restore a checkpoint (by id like cp3, or by label). The file, IR and report return to that state; use it when an approach is not working.",
  input: z.strictObject({ to: z.string().describe("Checkpoint id (cp3) or label.") }),
  run(input, { session, readOnly }: DesignToolContext) {
    if (readOnly) return readOnlyRefusal("rollback");
    let cp;
    try {
      cp = session.rollback(input.to);
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
    const lines = [`Rolled back to ${cp.id} "${cp.label}" (after apply #${cp.applyIndex}).`];
    if (cp.state.ir) lines.push(irSummary(cp.state.ir, cp.state.report, { maxChars: 3500 }));
    return { text: lines.join("\n"), data: { kind: "rollback", id: cp.id } };
  },
});

const askUser = defineTool({
  name: "ask_user",
  description:
    "Ask the user up to 3 short questions — only when an ambiguity changes topology or interfaces, the units are unclear or requirements conflict, AND there is no safe default. Every question carries the default you will use if unanswered. Otherwise state the assumption and proceed.",
  input: z.strictObject({
    questions: z
      .array(
        z.strictObject({
          id: z.string().describe("q1, q2, …"),
          topic: z
            .enum(CLARIFICATION_TOPICS)
            .optional()
            .describe("What the question is about (default other). The spec writer sees only this label and the user's answer, not your question."),
          question: z.string(),
          options: z.array(z.string()).optional().describe("2–4 multiple-choice answers."),
          default: z.string().describe("The answer you will assume."),
        }),
      )
      .describe("1–3 questions."),
  }),
  async run(input, ctx: CoreToolContext) {
    const qs = input.questions;
    if (qs.length === 0 || qs.length > 3) return { text: "Ask between 1 and 3 questions.", isError: true };
    const answers = await ctx.askUser(qs);
    return {
      text: qs.map((q, i) => `${q.id}: ${q.question}\n  answer: ${answers[i] ?? q.default}`).join("\n"),
      data: { kind: "ask_user", questions: qs, answers },
    };
  },
});

const propose = defineTool({
  name: "propose",
  description:
    "Finish the task: hand the current model to the user as a proposal. Call it once the model verifies and the spec tests pass (or you cannot make progress). List every assumption you made and every known issue honestly.",
  input: z.strictObject({
    summary: z.string().describe("2–4 sentences: what was built and how it meets the request."),
    assumptions: z.array(z.string()).describe("Each unstated choice with its value, e.g. 'wall 2 mm (not specified)'."),
    known_issues: z.array(z.string()).describe("Anything that does not meet the request or a test; empty if none."),
    acknowledged_tests: z
      .array(z.string())
      .optional()
      .describe("Exact ids of failing spec tests you are certain contradict the request (say why in known_issues). Omit when every test passes."),
  }),
  run(input, { session }: CoreToolContext) {
    const proposal: Proposal = {
      summary: input.summary,
      assumptions: input.assumptions,
      known_issues: input.known_issues,
      ...(input.acknowledged_tests === undefined ? {} : { acknowledged_tests: input.acknowledged_tests }),
    };
    const v = session.verification;
    return { text: `Proposal recorded (${v.ok ? "model verified" : "model NOT verified"}).`, data: { kind: "propose", proposal } };
  },
});

/** The tools every dialect shares: get_code, ask_user, checkpoint, run_tests, propose, set_spec_tests, submit_spec. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function coreTools(): AgentTool<CoreToolContext, any>[] {
  return [askUser, checkpointTool, getCode, propose, runTests, setSpecTests, submitSpec];
}

/** All v0 design tools. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function designTools(): AgentTool<DesignToolContext, any>[] {
  return [applyCadscript, irSummaryTool, measureTool, rollbackTool, ...coreTools()];
}

export function designRegistry(): ToolRegistry<DesignToolContext> {
  return new ToolRegistry(designTools());
}

/** The designer's tools (sorted). */
export function designerRegistry(): ToolRegistry<DesignToolContext> {
  return designRegistry().subset([...DESIGNER_TOOLS]);
}

/** The spec writer's tools (sorted). */
export function specWriterRegistry(): ToolRegistry<DesignToolContext> {
  return designRegistry().subset([...SPEC_WRITER_TOOLS]);
}

/**
 * Eval-mode answers: the task's recorded defaults, else "use your best judgement". The answer never
 * repeats the question's text or default: answers reach the independent spec writer, which must not
 * see the designer's free text.
 */
export function evalModeAnswers(recordedDefaults?: string): (questions: readonly UserQuestion[]) => string[] {
  return (questions) =>
    questions.map(() =>
      recordedDefaults !== undefined && recordedDefaults.trim() !== ""
        ? `The user is not available. Recorded defaults for this request: ${recordedDefaults.trim()} For anything not covered, use your best judgement (your default is fine).`
        : "The user is not available: use your best judgement (your default is fine) and list it as an assumption.",
    );
}

/** A one-line verdict for traces (v0 and v1 verifications alike). */
export function verificationLine(v: Pick<Verification, "ok" | "tests" | "failedAt" | "errorSignature">): string {
  if (v.ok) return `ok${v.tests ? ` (tests ${summarizeTests(v.tests).passed}/${v.tests.length})` : ""}`;
  return `failed at L${v.failedAt ?? 0}: ${oneLine(v.errorSignature.slice(0, 160))}`;
}

export { num };
