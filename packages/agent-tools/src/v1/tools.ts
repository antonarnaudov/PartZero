/**
 * The v1 design tools (CadScript v1 over an `aicad.ir/1` session). Results are short plain-text
 * deltas (≤ ~2k tokens) naming parameters, features and entities by their CadScript names, with a
 * repair hint for every error — computed from the report's `details`.
 *
 * Designer: apply_cadscript, set_param, accept_ref_candidate, accept_ref_proposal, sketch_edit,
 *           query, describe, ir_summary, measure, get_code, run_tests, checkpoint, rollback,
 *           ask_user, propose
 * Spec writer: set_spec_tests, submit_spec (shared with v0)
 *
 * The one-step repairs (set_param, accept_ref_candidate, accept_ref_proposal, sketch_edit) are IR
 * edits spliced back into the source (`applyIrEdit`, W8), then applied through the same ladder as
 * apply_cadscript — the command-layer ops of SPEC-v1 §0.6/§5.9, from the agent's side.
 */
import ts from "typescript";
import { z } from "zod";
import { v1 as cs } from "@aicad/cadscript";
import { EngineError } from "@aicad/evals";
import { capList, clip, ident, jsonQuote, num, oneLine, plural } from "../format.js";
import { defineTool, ToolRegistry, type AgentTool, type ToolOutput } from "../registry.js";
import { patchSource, PatchError } from "../source.js";
import { formatTestResult, summarizeTests } from "../spec.js";
import { coreTools, type CoreToolContext } from "../tools.js";
import { acceptCandidateEdit, acceptProposalEdit, candidateResolutionProblem, EditError, setParamEdit, sketchEdit, spliceEdit, type CandidateChoice } from "./edits.js";
import { repairHintV1 } from "./playbooks.js";
import { atPointer, displayName, irFeatureByName, obj, probeText, queryText, str } from "./render.js";
import type { ReportV1 } from "./engine.js";
import type { ApplyOutcomeV1, DesignSessionV1, VerificationV1 } from "./session.js";
import { featureResultTextV1, irSummaryV1, measureTextV1, modelTotalsV1, totalsTextV1 } from "./summaries.js";

export interface DesignToolContextV1 extends CoreToolContext {
  session: DesignSessionV1;
}

export const DESIGNER_TOOLS_V1 = [
  "accept_ref_candidate",
  "accept_ref_proposal",
  "apply_cadscript",
  "ask_user",
  "checkpoint",
  "describe",
  "get_code",
  "ir_summary",
  "measure",
  "propose",
  "query",
  "rollback",
  "run_tests",
  "set_param",
  "sketch_edit",
] as const;
export const READ_ONLY_TOOLS_V1 = ["describe", "get_code", "ir_summary", "measure", "query", "run_tests"] as const;
export const SPEC_WRITER_TOOLS_V1 = ["set_spec_tests", "submit_spec"] as const;

const LEVEL_NAMES = ["compile", "kernel", "expectations", "spec tests"] as const;

function readOnlyRefusal(name: string): ToolOutput {
  return { text: `${name} is not available in question mode: this request only asks about the design. Answer from get_code / ir_summary / measure / query.`, isError: true, data: { kind: "read_only" } };
}

// ─── Apply results ───────────────────────────────────────────────────────────────────────────

function testsLines(v: VerificationV1): string[] {
  if (!v.tests) return [];
  const s = summarizeTests(v.tests);
  const lines = [`L3 spec tests: ${s.passed}/${s.total} pass`];
  const failing = v.tests.filter((t) => !t.pass);
  lines.push(...capList(failing, 8, (t) => `  ${formatTestResult(t)}`, (n) => `  … ${n} more failing (run_tests lists all)`));
  if (failing.length === 0) {
    const tight = v.tests.filter((t) => t.margin !== undefined).sort((a, b) => a.margin! - b.margin!)[0];
    if (tight) lines.push(`  tightest: ${formatTestResult(tight)}`);
  }
  return lines;
}

/** The v1 verification ladder as text. */
export function formatVerificationV1(v: VerificationV1, previous?: ApplyOutcomeV1["before"]): string[] {
  const lines: string[] = [];
  const errors = v.diagnostics.filter((d) => d.severity === "error");
  const notes = v.diagnostics.filter((d) => d.severity !== "error");
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
  for (const d of notes.slice(0, 2)) lines.push(`  note ${d.code}${d.feature ? ` in ${ident(d.feature)}` : ""}: ${oneLine(d.message)}`);
  if (v.engineError) lines.push(`L1 kernel: engine error ${ident(v.engineError.code)}: ${oneLine(v.engineError.message)}`, `  fix: ${oneLine(v.engineError.hint)}`);
  const k = v.kernel;
  if (k) {
    const failed = k.features.filter((f) => f.status !== "ok");
    const badParams = k.params.filter((p) => p.code);
    const count = failed.length + badParams.length;
    lines.push(`L1 kernel (${oneLine(k.engine, 80)}): ${k.status}${k.rejections.length > 0 ? ", document rejected" : count > 0 ? `, ${plural(count, "failure")}` : ""}${v.unexplained.length > 0 ? `, ${plural(v.unexplained.length, "unexplained warning")}` : ""}`);
    for (const r of k.rejections.slice(0, 4)) lines.push(`  ✗ rejected ${ident(r.code)}${r.path ? ` at ${oneLine(r.path, 80)}` : ""}: ${oneLine(r.message)}`, `    fix: ${oneLine(r.hint)}`);
    for (const p of badParams.slice(0, 4)) lines.push(`  ✗ parameter ${ident(p.name)} ${ident(p.code!)}: ${oneLine(p.message ?? "")}`, `    fix: ${oneLine(p.hint ?? "")}`);
    // Root causes first: consumers only repeat them.
    const consumer = (c: string | undefined) => c === "DEPENDENCY_FAILED" || c === "PARAM_FAILED";
    const ordered = [...failed].sort((a, b) => Number(consumer(a.code)) - Number(consumer(b.code)));
    for (const f of ordered.slice(0, 5)) {
      lines.push(`  ✗ ${ident(f.feature)} (${ident(f.type)}) ${ident(f.code ?? "UNKNOWN")}: ${oneLine(f.message ?? "")}`);
      lines.push(...(f.hint ?? "").split("\n").map((l, i) => (i === 0 ? `    fix: ${oneLine(l)}` : `      ${oneLine(l)}`)));
    }
    if (ordered.length > 5) lines.push(`  … ${ordered.length - 5} more failed features`);
    for (const w of v.unexplained.slice(0, 4)) {
      const shared = w.siblings > 1;
      lines.push(`  ⚠ ${ident(w.feature)} warning ${ident(w.code)}${shared ? ` [${w.instance}]` : ""} (on a feature you just changed): ${oneLine(w.message)}`);
      lines.push(`    fix: ${oneLine(w.hint)}`);
      lines.push(
        `    or, if intended: apply again with accept_warnings: [{ feature: ${jsonQuote(w.feature)}, code: ${jsonQuote(w.code)}, ${shared ? `instance: ${jsonQuote(w.instance)}, ` : ""}reason: "…" }]${shared ? ` (${w.siblings} ${w.code} warnings on ${w.feature}: one entry each)` : ""}`,
      );
    }
    const others = k.warnings.filter((w) => !v.unexplained.includes(w) && (w.severity === "warning" || w.edited));
    for (const w of others.slice(0, 3)) lines.push(`  note ${w.severity} ${ident(w.code)} on ${ident(w.feature)}${w.accepted ? " (explained)" : ""}: ${oneLine(w.message, 200)}`);
    const prev = new Map((previous?.report?.features ?? []).map((f) => [f.feature, JSON.stringify([f.status, f.bodies, f.regions, f.holes])] as const));
    const ok = k.features.filter((f) => f.status === "ok");
    const changed = ok.filter((f) => prev.get(f.feature) !== JSON.stringify([f.entry.status, f.entry.bodies, f.entry.regions, f.entry.holes]));
    lines.push(...capList(changed, 8, (f) => `  ✓ ${ident(f.feature)} (${ident(f.type)}): ${featureResultTextV1(f.entry)}`, (n) => `  … ${n} more changed features (measure lists all)`));
    if (ok.length - changed.length > 0) lines.push(`  (${plural(ok.length - changed.length, "other feature")} unchanged)`);
  }
  if (v.expectations.length > 0) {
    lines.push(`L2 expect: ${v.expectations.map((x) => `${x.pass ? "✓" : "✗"} ${ident(x.feature)}.${x.check} ${x.expected}${x.pass ? "" : ` — actual ${x.actual}`}`).join("; ")}`);
  }
  lines.push(...testsLines(v));
  return lines;
}

export function formatApplyV1(o: ApplyOutcomeV1, notes: readonly string[] = []): string {
  const v = o.after.verification;
  const head = v.ok
    ? `apply #${o.index}: OK (L0–L2 pass${v.tests ? `; spec tests ${summarizeTests(v.tests).passed}/${v.tests.length}` : ""})`
    : `apply #${o.index}: FAILED at L${v.failedAt ?? 0} (${LEVEL_NAMES[v.failedAt ?? 0]})`;
  const lines = [head];
  if (notes.length > 0) lines.push(`edit: ${notes.join("; ")}`);
  lines.push(`changes: ${o.changesText}`);
  for (const a of (o.ignoredAcceptances ?? []).slice(0, 4)) {
    const which = a.instance !== undefined ? `, instance: ${jsonQuote(a.instance)}` : "";
    lines.push(`  note accept_warnings { feature: ${jsonQuote(a.feature)}, code: ${jsonQuote(a.code)}${which} } explains nothing: ${oneLine(a.why, 240)}, so it was not recorded (explain a warning once it is reported)`);
  }
  lines.push(...formatVerificationV1(v, o.before));
  if (o.after.report && o.after.report.status === "ok") lines.push(`model: ${totalsTextV1(modelTotalsV1(o.after.report))}`);
  if (!v.ok) lines.push("next: fix the first root-cause error above with the smallest change (its fix line), then apply again.");
  else if (v.tests && v.tests.some((t) => !t.pass)) lines.push("next: keep building; failing spec tests show what is still missing or off.");
  else if (v.tests) lines.push("next: all spec tests pass — check anything else the request needs, then propose.");
  return lines.join("\n");
}

function applyData(outcome: ApplyOutcomeV1, note?: string, extra: Record<string, unknown> = {}): NonNullable<ToolOutput["data"]> {
  const v = outcome.after.verification;
  return {
    kind: "apply",
    index: outcome.index,
    ok: v.ok,
    failedAt: v.failedAt,
    level: v.level,
    errorSignature: v.errorSignature,
    engineError: v.engineError?.code,
    tests: v.tests ? summarizeTests(v.tests) : undefined,
    note,
    ...extra,
  };
}

/**
 * Splice an IR edit into the source and apply it through the ladder. `guard` re-checks the edit's
 * promise on the evaluated state; when it refuses, nothing is committed and `refusal` words the result.
 */
async function applyEdit(
  session: DesignSessionV1,
  after: ReturnType<typeof setParamEdit>,
  what: string,
  extra: Record<string, unknown> = {},
  check?: { guard: (state: ApplyOutcomeV1["after"]) => string | undefined; refusal: (reason: string, state: ApplyOutcomeV1["after"]) => ToolOutput },
): Promise<ToolOutput> {
  const before = session.editableIr()!;
  let source: string;
  try {
    source = spliceEdit(session.source, before, after);
  } catch (e) {
    return { text: `${(e as Error).message}. Nothing was applied; make the change with apply_cadscript patches instead.`, isError: true, data: { kind: "bad_input" } };
  }
  const outcome = await session.apply(source, { base: after, ...(check ? { guard: check.guard } : {}) });
  if (outcome.refused !== undefined && check) return check.refusal(outcome.refused, outcome.after);
  const v = outcome.after.verification;
  return { text: formatApplyV1(outcome, [what]), isError: !v.ok, data: applyData(outcome, what, extra) };
}

function needsModel(session: DesignSessionV1, tool: string): ToolOutput | undefined {
  if (session.ir || (tool === "set_param" && session.editableIr())) return undefined;
  return { text: `${tool} needs a compiled model: ${session.source.trim() === "" ? "nothing has been applied yet (apply_cadscript { source })" : "the current source does not compile — fix the errors from the last apply first"}.`, isError: true };
}

// ─── Tools ───────────────────────────────────────────────────────────────────────────────────

const expectationSchema = z.strictObject({
  feature: z.string().describe("Feature const name."),
  bodies: z.number().int().optional().describe("Exact number of bodies it creates or modifies."),
  regions: z.number().int().optional().describe("Sketch: exact number of regions."),
  holes: z.number().int().optional().describe("Hole feature: number of hole instances; sketch: number of inner loops."),
  volume: z.number().optional().describe("Total volume of the bodies it creates or modifies, mm³ (±1%)."),
  bbox_size: z.array(z.number()).optional().describe("Axis-aligned size [x, y, z] of those bodies, mm (±0.05)."),
});

const patchSchema = z.strictObject({
  feature: z.string().describe("Const name of the parameter or feature to replace or delete, or the name of a new one to insert."),
  code: z.string().describe("The complete replacement statement(s), e.g. `const plate = extrude(base, { distance: thick });`. Empty string deletes it."),
  after: z.string().optional().describe("New statements only: insert after this const (default: end of file)."),
});

const acceptanceSchema = z.strictObject({
  feature: z.string().describe("Feature const name the warning is on."),
  code: z.string().describe("The warning code, e.g. REF_SET_CHANGED."),
  instance: z
    .string()
    .max(16)
    .optional()
    .describe("Only when several warnings on the feature share the code: the instance tag shown in brackets after the code, e.g. [3fa2c01b]. One entry explains one warning."),
  reason: z.string().max(300).describe("Why it is intended (goes into the proposal's known issues)."),
});

const applyCadscript = defineTool({
  name: "apply_cadscript",
  description:
    "Change the design (CadScript v1), then verify it: L0 compile + typecheck, L1 kernel (errors, and warnings on what you changed), L2 your `expect` checks, L3 the spec tests. " +
    "Give EITHER `source` (the complete file: first version or big rewrites) OR `patches` (edit consts by name: replace, delete, or insert). " +
    "The result is a short delta: errors with a concrete fix, results of changed features, spec test status. Build in small steps (1–3 features per call).",
  input: z.strictObject({
    source: z.string().optional().describe("The COMPLETE new CadScript v1 file."),
    patches: z.array(patchSchema).optional().describe("Targeted edits, applied in order. Prefer this for small changes."),
    expect: z.array(expectationSchema).optional().describe("L2 checks for this step, e.g. [{ feature: 'plate', bodies: 1, bbox_size: [80, 50, 8] }]."),
    accept_warnings: z
      .array(acceptanceSchema)
      .optional()
      .describe("Warnings on features you changed that are intended, one entry per warning with the reason (and its instance tag when several on a feature share the code); unexplained ones fail L1."),
    note: z.string().optional().describe("One line: what this step does."),
  }),
  async run(input, { session, readOnly }: DesignToolContextV1) {
    if (readOnly) return readOnlyRefusal("apply_cadscript");
    if (input.source !== undefined && input.patches !== undefined) {
      return { text: "Give either `source` (whole file) or `patches`, not both (omit the one you do not use). Nothing was applied.", isError: true, data: { kind: "bad_input" } };
    }
    if (input.source === undefined && !input.patches?.length && !input.accept_warnings?.length) {
      return { text: "Give exactly one of `source` (whole file) or `patches` (non-empty list). Nothing was applied.", isError: true, data: { kind: "bad_input" } };
    }
    let next = input.source ?? session.source;
    let notes: string[] = [];
    if (input.patches?.length) {
      try {
        const r = patchSource(session.source, input.patches);
        next = r.source;
        notes = r.notes;
      } catch (e) {
        if (e instanceof PatchError) return { text: `${e.message}. Nothing was applied.`, isError: true, data: { kind: "bad_input" } };
        throw e;
      }
    }
    const outcome = await session.apply(next, { expect: input.expect ?? [], acceptWarnings: input.accept_warnings ?? [] });
    const v = outcome.after.verification;
    return { text: formatApplyV1(outcome, notes), isError: !v.ok, data: applyData(outcome, input.note) };
  },
});

const setParam = defineTool({
  name: "set_param",
  description:
    "Set one parameter's value (a number, true/false, or an expression string such as \"width - 2 * wall\" to make it derived) and re-verify. " +
    "The one-step fix for PARAM_OUT_OF_RANGE, a too-large fillet/chamfer/shell value bound to a parameter, and dimension changes the user asks for.",
  input: z.strictObject({
    name: z.string().describe("Parameter const name."),
    value: z.union([z.number(), z.boolean(), z.string()]).describe("New value: number (in the parameter's unit), boolean, or an expression string."),
  }),
  async run(input, { session, readOnly }: DesignToolContextV1) {
    if (readOnly) return readOnlyRefusal("set_param");
    const missing = needsModel(session, "set_param");
    if (missing) return missing;
    let after;
    try {
      after = setParamEdit(session.editableIr()!, input.name, input.value);
    } catch (e) {
      if (e instanceof EditError) return { text: `${e.message}. Nothing was applied.`, isError: true, data: { kind: "bad_input" } };
      throw e;
    }
    return applyEdit(session, after, `${input.name} = ${typeof input.value === "number" ? num(input.value) : JSON.stringify(input.value)}`, { tool: "set_param" });
  },
});

const acceptRefCandidate = defineTool({
  name: "accept_ref_candidate",
  description:
    "Repair a failed reference (REF_MISSING, REF_AMBIGUOUS, REF_SPLIT, REF_UNCERTAIN) in one step: rewrite it to the synthesised query of candidate N " +
    "as numbered in the error's fix line (pick by the probe: position and facing), then re-verify; it refuses (applying nothing) when the rewritten reference would not resolve to exactly that candidate (key and probe), or when the engine fails on the edit so that cannot be checked. It replaces the whole query, so it refuses a reference " +
    "to several entities (.some(), .exactly(n), other members still resolved): rewrite that query with apply_cadscript patches.",
  input: z.strictObject({
    feature: z.string().describe("Feature const name whose reference failed."),
    field: z.string().describe('The reference field from the error, e.g. "/edges", "/on/face", "/target".'),
    candidate: z.number().int().describe("Candidate number from the fix line (1 = first)."),
  }),
  async run(input, { session, readOnly }: DesignToolContextV1) {
    if (readOnly) return readOnlyRefusal("accept_ref_candidate");
    const missing = needsModel(session, "accept_ref_candidate");
    if (missing) return missing;
    let edit: { doc: ReturnType<typeof setParamEdit>; chosen: CandidateChoice };
    try {
      edit = acceptCandidateEdit(session.ir!, session.report, input.feature, input.field, input.candidate);
    } catch (e) {
      if (e instanceof EditError) return { text: `${e.message}. Nothing was applied.`, isError: true, data: { kind: "bad_input" } };
      throw e;
    }
    const f = irFeatureByName(edit.doc, input.feature);
    const kind = str(obj(f ? atPointer(f, input.field) : undefined), "kind") ?? "face";
    const q = queryText({ report: session.report, ir: session.ir }, edit.chosen.query, kind);
    const chosen = edit.chosen;
    const instead = `aim the reference with apply_cadscript patches instead (candidate ${chosen.index}'s query was ${oneLine(q, 160)}; the query tool shows what a selector matches)`;
    const mismatch = (problem: string): ToolOutput => ({ text: `accept_ref_candidate refused: ${problem}. Nothing was applied; ${instead}.`, isError: true, data: { kind: "candidate_mismatch" } });
    const unchecked = (why: string, code?: string): ToolOutput => ({
      text: `accept_ref_candidate refused: ${why}, so it cannot be checked that ${input.feature} ${input.field} would designate candidate ${chosen.index} ${displayName(chosen.name)}. Nothing was applied; call it again, or ${instead}.`,
      isError: true,
      data: { kind: "candidate_unchecked", ...(code !== undefined ? { code } : {}) },
    });
    // The synthesised query only SHOULD select the candidate (SPEC-v1 §5.8): evaluate the edit first
    // (the ladder's apply below reuses this report) and refuse it when the reference would designate
    // anything else — the model could still verify with the feature re-aimed at another entity. An
    // edit that cannot be checked (the engine failed on it) is refused too: never applied unchecked.
    let preview: ReportV1;
    try {
      preview = await session.evaluateScratch(edit.doc, session.name);
    } catch (e) {
      const code = e instanceof EngineError ? e.code : "ENGINE_FAILED";
      return unchecked(`the engine could not evaluate the edited model (${code}: ${oneLine(e instanceof Error ? e.message : String(e), 200)})`, code);
    }
    const problem = candidateResolutionProblem(preview, input.feature, input.field, chosen);
    if (problem !== undefined) return mismatch(problem);
    // The ladder evaluates the spliced source again (a cache miss re-runs the engine): its own report is checked the same way before it is kept.
    const before = obj(atPointer(irFeatureByName(session.ir!, input.feature)!, input.field));
    const dropped = before?.["capture"] !== undefined;
    const out = await applyEdit(session, edit.doc, `${input.feature} ${input.field} → candidate ${chosen.index} ${displayName(chosen.name)} (${oneLine(q, 160)})`, { tool: "accept_ref_candidate" }, {
      guard: (state) =>
        state.report
          ? candidateResolutionProblem(state.report, input.feature, input.field, chosen)
          : state.verification.engineError
            ? `the engine could not evaluate the edited model (${state.verification.engineError.code}: ${oneLine(state.verification.engineError.message, 200)})`
            : "the edited source did not compile",
      refusal: (reason, state) => (state.report ? mismatch(reason) : unchecked(reason, state.verification.engineError?.code)),
    });
    if (out.data?.kind !== "apply") return out;
    // SPEC-v1 §5.9 also refreshes the reference's capture; the agent's engine (the aicad CLI) cannot capture yet.
    // The query as the applied IR holds it (review: the compile/print round trip may reorder keys or
    // drop defaults of the candidate's synthesised query; comparing that would lose the entry at once).
    const applied = session.ir ? obj(atPointer(irFeatureByName(session.ir, input.feature) ?? {}, input.field)) : undefined;
    session.noteCandidateRepair(input.feature, input.field, applied?.["q"] ?? edit.chosen.query, dropped);
    const note =
      `note: ${input.feature} ${input.field} now has no capture${dropped ? " (its old one was dropped)" : ""} — this engine cannot capture references yet (SPEC-v1 §5.9 refreshes it): ` +
      "if a later upstream change splits or removes the entity, the query alone decides (no REF_SPLIT / REF_MISSING against it). It is listed under the proposal's known_issues.";
    return { ...out, text: `${out.text}\n${note}`, data: { ...out.data, uncaptured: true } };
  },
});

const acceptRefProposal = defineTool({
  name: "accept_ref_proposal",
  description: "Accept the engine's proposal for a reference (REF_REPAIRED, REF_SET_CHANGED): write the rewritten query into the file, then re-verify.",
  input: z.strictObject({
    feature: z.string().describe("Feature const name."),
    field: z.string().describe('The reference field, e.g. "/edges".'),
  }),
  async run(input, { session, readOnly }: DesignToolContextV1) {
    if (readOnly) return readOnlyRefusal("accept_ref_proposal");
    const missing = needsModel(session, "accept_ref_proposal");
    if (missing) return missing;
    let after;
    try {
      after = acceptProposalEdit(session.ir!, session.report, input.feature, input.field);
    } catch (e) {
      if (e instanceof EditError) return { text: `${e.message}. Nothing was applied.`, isError: true, data: { kind: "bad_input" } };
      throw e;
    }
    return applyEdit(session, after, `${input.feature} ${input.field} → the engine's proposal`, { tool: "accept_ref_proposal" });
  },
});

const sketchEditTool = defineTool({
  name: "sketch_edit",
  description:
    "Edit a constrained sketch's constraints and re-verify: remove constraints by id (the fix for SKETCH_CONSTRAINT_CONFLICT's suggested removal and SKETCH_REDUNDANT_CONSTRAINTS) and/or set dimension values. " +
    "The result shows the sketch's solve status, DOF and any conflicts. To add constraints, patch the sketch with apply_cadscript.",
  input: z.strictObject({
    sketch: z.string().describe("Sketch const name."),
    remove: z.array(z.string()).optional().describe("Constraint ids to remove."),
    set: z
      .array(z.strictObject({ constraint: z.string().describe("Dimension id."), value: z.union([z.number(), z.string()]).describe("mm or degrees, or an expression over parameters.") }))
      .optional()
      .describe("Dimension values to set."),
  }),
  async run(input, { session, readOnly }: DesignToolContextV1) {
    if (readOnly) return readOnlyRefusal("sketch_edit");
    const missing = needsModel(session, "sketch_edit");
    if (missing) return missing;
    if (!input.remove?.length && !input.set?.length) return { text: "Give remove and/or set. Nothing was applied.", isError: true, data: { kind: "bad_input" } };
    let after;
    try {
      after = sketchEdit(session.ir!, input.sketch, { remove: input.remove ?? [], set: Object.fromEntries((input.set ?? []).map((x) => [x.constraint, x.value])) });
    } catch (e) {
      if (e instanceof EditError) return { text: `${e.message}. Nothing was applied.`, isError: true, data: { kind: "bad_input" } };
      throw e;
    }
    const what = [input.remove?.length ? `removed ${input.remove.join(", ")}` : "", input.set?.length ? `set ${input.set.map((x) => `${x.constraint} = ${typeof x.value === "number" ? num(x.value) : x.value}`).join(", ")}` : ""].filter(Boolean).join("; ");
    const out = await applyEdit(session, after, `${input.sketch}: ${what}`, { tool: "sketch_edit" });
    const entry = session.report?.features.find((f) => f.feature === input.sketch);
    const sk = entry?.sketch;
    const status = entry ? `\nsketch ${ident(input.sketch)}: ${entry.status}${sk?.status ? `, ${sk.status}` : ""}${sk?.dof !== undefined && sk.dof !== null ? `, ${plural(sk.dof, "DOF")}` : ""}` : "";
    return { ...out, text: clip(`${out.text}${status}`) };
  },
});

/**
 * `source` with `names` added to its `import { … } from "@aicad/std"` (a probe's `tag`, and the
 * builtins a selector uses, may not be imported yet).
 */
export function withStdImports(source: string, names: readonly string[]): string {
  const sf = ts.createSourceFile("main.cad.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const imp = sf.statements.find((st): st is ts.ImportDeclaration => ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === "@aicad/std");
  const bindings = imp?.importClause?.namedBindings;
  if (!imp || !bindings || !ts.isNamedImports(bindings)) return `import { ${[...new Set(names)].join(", ")} } from "@aicad/std";\n${source}`;
  const have = new Set(bindings.elements.map((e) => e.name.text));
  const missing = [...new Set(names)].filter((n) => !have.has(n));
  if (missing.length === 0) return source;
  const last = bindings.elements[bindings.elements.length - 1];
  const at = last ? last.end : bindings.getStart(sf) + 1;
  return `${source.slice(0, at)}${last ? ", " : " "}${missing.join(", ")}${source.slice(at)}`;
}

/** The @aicad/std builtins a selector names (X, Z, bodies, edgesBetween, …). */
function builtinsIn(selector: string): string[] {
  const builtins = new Set<string>(cs.BUILTINS);
  return [...new Set([...selector.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map((m) => m[0]).filter((w) => builtins.has(w)))];
}

/** A tag appended to the model to evaluate selectors without changing it. */
const PROBE = "q__aicad_probe";
const COUNT_SUFFIX = /\.(one|some|any|exactly)\s*\([^()]*\)\s*$/;

async function probeSelectors(session: DesignSessionV1, selectors: readonly { name: string; selector: string }[], after?: string): Promise<{ ok: true; report: NonNullable<DesignSessionV1["report"]>; doc: NonNullable<DesignSessionV1["ir"]> } | { ok: false; text: string }> {
  let source = withStdImports(session.source, ["tag", ...selectors.flatMap((s) => builtinsIn(s.selector))]);
  try {
    for (const s of selectors) source = patchSource(source, [{ feature: s.name, code: `const ${s.name} = tag(${s.selector});`, ...(after ? { after } : {}) }]).source;
  } catch (e) {
    return { ok: false, text: `${(e as Error).message}` };
  }
  const c = cs.compile(source, { base: session.ir ?? undefined });
  const errors = c.diagnostics.filter((d) => d.severity === "error");
  if (!c.ir || errors.length > 0) {
    return {
      ok: false,
      text: `The selector does not compile:\n${capList(errors, 4, (d) => `  ✗ ${d.code}: ${oneLine(d.message)}${d.hint ? `\n    fix: ${oneLine(d.hint)}` : ""}`).join("\n")}`,
    };
  }
  try {
    return { ok: true, report: await session.evaluateScratch(c.ir, `${session.name}-query`), doc: c.ir };
  } catch (e) {
    return { ok: false, text: `The engine could not evaluate the query: ${oneLine(e instanceof Error ? e.message : String(e))}` };
  }
}

const queryTool = defineTool({
  name: "query",
  readOnly: true,
  description:
    "Evaluate a selector (a CadScript query chain such as `slab.sides().edges().parallel(Z)`) against the current model without changing it: how many entities match, " +
    "their display names and probes (position, facing), and whether it is unique. Use it to aim a reference before writing it, or to see what a failed one matches.",
  input: z.strictObject({
    selector: z.string().describe("A query chain over feature handles, optionally ending with .one()/.some()/.any()/.exactly(n)."),
    after: z.string().optional().describe("Evaluate at this point of the timeline: right after this feature const (default: the end)."),
  }),
  async run(input, { session }: DesignToolContextV1) {
    const missing = needsModel(session, "query");
    if (missing) return missing;
    const selector = input.selector.trim().replace(/;$/, "");
    if (/[;\n]/.test(selector) || /\b(const|let|var|import|function)\b/.test(selector)) return { text: "Give one selector expression (a query chain), not statements.", isError: true, data: { kind: "bad_input" } };
    const counted = COUNT_SUFFIX.test(selector);
    const r = await probeSelectors(session, [{ name: PROBE, selector: counted ? selector : `${selector}.any()` }], input.after);
    if (!r.ok) return { text: r.text, isError: true };
    const entry = r.report.features.find((f) => f.feature === PROBE);
    if (!entry) return { text: "The query was not evaluated (a failed or suppressed feature before it, or a rejected document): fix the model first.", isError: true };
    const ref = entry.refs?.[0];
    const members = ref?.members ?? [];
    const lines = [`${selector}: ${plural(members.length, "entity", "entities")}${members.length === 1 ? " (unique)" : members.length > 1 ? " (not unique: .one() would fail with REF_AMBIGUOUS)" : " (nothing matches: .one()/.some() would fail with REF_MISSING)"}`];
    lines.push(...capList(members, 12, (m) => `  ${displayName(m.name)} — ${probeText(m.probe)}`, (n) => `  … ${n} more (narrow the selector)`));
    if (entry.status !== "ok" && entry.error) {
      lines.push(`declared count fails: ${ident(entry.error.code)}`);
      lines.push(...repairHintV1(entry.error.code, { report: r.report, ir: r.doc, details: entry.error.details, feature: { ...entry, feature: "(query)" } }).split("\n").map((l) => `  ${oneLine(l)}`));
    }
    return { text: clip(lines.join("\n")), data: { kind: "query", count: members.length } };
  },
});

const describeTool = defineTool({
  name: "describe",
  readOnly: true,
  description:
    "Find entities of the current model by display name or key (e.g. `slab/side:outline.left`) or near a point: kind, name, probe (position and facing), and the features whose references use it.",
  input: z.strictObject({
    name: z.string().optional().describe("Display name or key (or a part of one) of a face, edge or vertex."),
    point: z.array(z.number()).optional().describe("[x, y, z]: list the entities whose probes are nearest to it."),
  }),
  async run(input, { session }: DesignToolContextV1) {
    const missing = needsModel(session, "describe");
    if (missing) return missing;
    if (input.name === undefined && input.point === undefined) return { text: "Give name or point.", isError: true, data: { kind: "bad_input" } };
    if (input.point !== undefined && input.point.length !== 3) return { text: "point is [x, y, z].", isError: true, data: { kind: "bad_input" } };
    const kinds = [
      { name: `${PROBE}_f`, selector: "bodies().faces().any()" },
      { name: `${PROBE}_e`, selector: "bodies().edges().any()" },
      { name: `${PROBE}_v`, selector: "bodies().vertices().any()" },
    ];
    const r = await probeSelectors(session, kinds);
    if (!r.ok) return { text: r.text, isError: true };
    const all = kinds.flatMap((k) => r.report.features.find((f) => f.feature === k.name)?.refs?.[0]?.members ?? []);
    const users = (key: string) =>
      (session.report?.features ?? []).filter((f) => (f.refs ?? []).some((x) => x.members.some((m) => m.key === key))).map((f) => ident(f.feature));
    let hits = all;
    if (input.name !== undefined) {
      const q = input.name.trim();
      const exact = all.filter((m) => m.name === q || m.key === q);
      hits = exact.length > 0 ? exact : all.filter((m) => m.name.includes(q) || m.key.includes(q));
    }
    if (input.point !== undefined) {
      const p = input.point;
      hits = [...hits].sort((a, b) => Math.hypot(...a.probe.point.map((x, i) => x - p[i]!)) - Math.hypot(...b.probe.point.map((x, i) => x - p[i]!))).slice(0, 5);
    }
    if (hits.length === 0) return { text: `No entity ${input.name !== undefined ? `named like ${jsonQuote(input.name)}` : "there"} (the model has ${plural(all.length, "entity", "entities")}; ir_summary and query show names).` };
    const lines = capList(
      hits,
      10,
      (m) => {
        const u = users(m.key);
        const dist = input.point !== undefined ? `, ${num(Math.hypot(...m.probe.point.map((x, i) => x - input.point![i]!)))} mm from the point` : "";
        return `${displayName(m.name)} (key ${displayName(m.key)}): ${probeText(m.probe)}${dist}${u.length ? `; referenced by ${u.join(", ")}` : ""}`;
      },
      (n) => `… ${n} more (be more specific)`,
    );
    return { text: clip(lines.join("\n")), data: { kind: "describe", count: hits.length } };
  },
});

const irSummaryTool = defineTool({
  name: "ir_summary",
  readOnly: true,
  description: "Compact view of the model: parameters (value, unit, bounds, evaluated), every feature as its CadScript call with its latest result, warnings and failed references.",
  input: z.strictObject({}),
  run(_input, { session }: DesignToolContextV1) {
    if (session.ir) return { text: irSummaryV1(session.ir, session.report) };
    if (session.source.trim() === "") return { text: "Nothing has been applied yet." };
    const last = [...session.checkpoints].reverse().find((c) => c.state.ir);
    const errs = session.verification.diagnostics.filter((d) => d.severity === "error").length;
    return {
      text: `The current source does not compile (${plural(errs, "error")}; see the last apply result).${last?.state.ir ? `\nLast compiled checkpoint ${last.id} "${last.label}":\n${irSummaryV1(last.state.ir, last.state.report)}` : ""}`,
      isError: true,
    };
  },
});

const measureTool = defineTool({
  name: "measure",
  readOnly: true,
  description:
    "Metrics from the latest evaluation. Without arguments: every feature briefly plus the final bodies. With `feature`: its bodies in detail (origin, volume, area, centroid, bbox, face/edge counts), sketch regions and solve state, hole instances, blend summary and reference members.",
  input: z.strictObject({
    feature: z.string().optional().describe("Feature const name."),
    body: z.number().int().optional().describe("With feature: only this body index."),
  }),
  run(input, { session }: DesignToolContextV1) {
    const report = session.report;
    if (!report) return { text: "No evaluation report: the current source does not compile. Fix the errors from the last apply first.", isError: true };
    return { text: measureTextV1(report, { feature: input.feature, body: input.body, ir: session.ir }) };
  },
});

const rollbackTool = defineTool({
  name: "rollback",
  description: "Restore a checkpoint (by id like cp3, or by label). The file, IR and report return to that state; use it when an approach is not working.",
  input: z.strictObject({ to: z.string().describe("Checkpoint id (cp3) or label.") }),
  run(input, { session, readOnly }: DesignToolContextV1) {
    if (readOnly) return readOnlyRefusal("rollback");
    let cp;
    try {
      cp = session.rollback(input.to);
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
    const lines = [`Rolled back to ${cp.id} "${cp.label}" (after apply #${cp.applyIndex}).`];
    if (cp.state.ir) lines.push(irSummaryV1(cp.state.ir, cp.state.report, { maxChars: 3500 }));
    return { text: lines.join("\n"), data: { kind: "rollback", id: cp.id } };
  },
});

/** All v1 design tools (the dialect-independent ones included). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function designToolsV1(): AgentTool<DesignToolContextV1, any>[] {
  return [applyCadscript, setParam, acceptRefCandidate, acceptRefProposal, sketchEditTool, queryTool, describeTool, irSummaryTool, measureTool, rollbackTool, ...coreTools()];
}

export function designRegistryV1(): ToolRegistry<DesignToolContextV1> {
  return new ToolRegistry(designToolsV1());
}

/** The v1 designer's tools (sorted). */
export function designerRegistryV1(): ToolRegistry<DesignToolContextV1> {
  return designRegistryV1().subset([...DESIGNER_TOOLS_V1]);
}

/** The v1 spec writer's tools (sorted). */
export function specWriterRegistryV1(): ToolRegistry<DesignToolContextV1> {
  return designRegistryV1().subset([...SPEC_WRITER_TOOLS_V1]);
}
