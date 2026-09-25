/**
 * The v1 design session: CadScript v1 source, its `aicad.ir/1` document, the latest
 * `aicad.metrics/1` report, spec tests and checkpoints — and the verification ladder
 * (ARCHITECTURE §6), extended for v1 (SPEC-v1 §7.3, IR-V1-IMPLEMENTATION-PLAN W10):
 *
 *   L0 static   CadScript v1 compile (front end + IR v1 rejections) and `tsc` against @aicad/std v1
 *   L1 kernel   engine evaluation: parameters, features, document rejections — and every
 *               **warning**-severity code on a feature edited since the last state that passed
 *               L1 (directly, through a parameter it uses, derived parameters included, or — a
 *               sketch — through its curves), until it is explained (`accept_warnings`); `info`
 *               never blocks. Re-applying the same source, or an unrelated patch, does not clear
 *               an unexplained warning. An explanation covers the warning instance it was given
 *               for (feature, code, details) while that feature stays unedited; it lapses when the
 *               feature is edited again, when the warning changes, and on rollback past it.
 *   L2 per-op   the step's expectations (bodies, regions, holes, volume, bbox)
 *   L3 tests    the frozen spec tests; at PROPOSE also the editability probe (every driving
 *               parameter ±20 %, kept inside its declared bounds and its unit's domain, must
 *               still evaluate)
 *
 * Every failure carries a repair hint from the v1 playbooks, computed from the report's `details`.
 */
import { v1 as cs } from "@aicad/cadscript";
import { contentHash, curveChanges, EngineError, featureChanges, type HiddenTest, type IrChange, type Subject } from "@aicad/evals";
import { v1 as ir, type IrDocument, type metricsV1 } from "@aicad/ir-types";
import { num } from "../format.js";
import type { DiagnosticInfo, Expectation, ExpectationResult, Level } from "../session.js";
import { findFeature, locateStatements } from "../source.js";
import type { DesignSpec, SpecTestResult } from "../spec.js";
import { bboxSize, changesText } from "../summaries.js";
import { irHashV1, type EngineV1, type ReportV1 } from "./engine.js";
import { featureParamNamesV1, paramNamesV1 } from "./param-uses.js";
import { compileHintV1, rejectionHintV1, repairHintV1, staticHintV1 } from "./playbooks.js";
import { obj, str } from "./render.js";
import { runSpecTestsV1, subjectOfV1 } from "./spec-subject.js";

export type IrV1 = ir.IrDocument;

/** A warning or info the engine raised on a feature. */
export interface WarningOutcome {
  feature: string;
  code: string;
  severity: "warning" | "info";
  message: string;
  hint: string;
  /** The feature (or a parameter it uses) changed in this apply. */
  edited: boolean;
  /** Explained by the designer (`accept_warnings`): the reason. */
  accepted?: string;
  /** Its instance tag ({@link warningInstanceTag}): names it when several warnings on the feature share the code. */
  instance: string;
  /** How many warnings on this feature carry this code (itself included). */
  siblings: number;
}

export interface FeatureOutcomeV1 {
  part: string;
  feature: string;
  type: string;
  status: "ok" | "error";
  code?: string;
  message?: string;
  hint?: string;
  entry: metricsV1.FeatureReport;
}

export interface ParamOutcome {
  name: string;
  scope: string;
  unit: string;
  value?: number | boolean;
  code?: string;
  message?: string;
  hint?: string;
}

export interface RejectionOutcome {
  code: string;
  path: string;
  message: string;
  hint: string;
}

export interface KernelOutcomeV1 {
  status: "ok" | "error";
  engine: string;
  features: FeatureOutcomeV1[];
  params: ParamOutcome[];
  warnings: WarningOutcome[];
  /** The document was rejected (every rejection, with hints). */
  rejections: RejectionOutcome[];
}

export interface VerificationV1 {
  compileOk: boolean;
  /** Errors first, then warnings (infos except renames are dropped). */
  diagnostics: DiagnosticInfo[];
  kernel?: KernelOutcomeV1;
  engineError?: { code: string; message: string; hint: string };
  expectations: ExpectationResult[];
  tests?: SpecTestResult[];
  /** Warning-severity codes on features this change edited that were not explained: L1 failures. */
  unexplained: WarningOutcome[];
  ok: boolean;
  level: Level;
  failedAt?: Level;
  /** Stable signature of what failed (empty when ok); equal signatures mean "the same error". */
  errorSignature: string;
}

export interface DesignStateV1 {
  source: string;
  compile: cs.CompileResult;
  ir: IrV1 | null;
  report: ReportV1 | null;
  verification: VerificationV1;
  /**
   * The explanations in force in this state, each tied to the warning instance it explains (a
   * rollback restores the checkpoint's own). Absent: none.
   */
  accepted?: readonly AcceptedWarning[];
  /**
   * The verified baseline as of this state: the IR of the last state at or before it that passed
   * L1 (or the starting model), which the next apply's warnings are checked against. A rollback
   * restores it with the state, so a warning explained only after the checkpoint must be explained
   * again. Set when the state becomes current; absent (null) before any.
   */
  baseline?: IrV1 | null;
}

/** A warning the designer explained, tied to the warning it was given for. */
export interface AcceptedWarning extends WarningAcceptance {
  /** {@link warningFingerprint} of the explained warning: the same code with other details is another warning. */
  fingerprint: string;
  /** The IR it was given on: editing the feature since then (directly, through a parameter or its curves) voids it. */
  ir: IrV1;
}

/**
 * What identifies one warning instance: its code and details (its message when it has none). A
 * REF_SET_CHANGED that drops three edges is not the +1 edge one the designer explained.
 */
export function warningFingerprint(feature: string, w: Pick<metricsV1.Warning, "code" | "details" | "message">): string {
  return contentHash({ feature, code: w.code, ...(w.details !== undefined ? { details: w.details } : { message: w.message }) });
}

/**
 * The short tag that names one warning instance in tool results and in `accept_warnings`
 * (`instance`): the first 8 hex digits of its {@link warningFingerprint}, so the same warning keeps
 * its tag across applies.
 */
export function warningInstanceTag(feature: string, w: Pick<metricsV1.Warning, "code" | "details" | "message">): string {
  return warningFingerprint(feature, w).slice(0, 8);
}

export interface CheckpointV1 {
  id: string;
  label: string;
  applyIndex: number;
  state: DesignStateV1;
}

export interface ApplyOutcomeV1 {
  index: number;
  before: DesignStateV1;
  after: DesignStateV1;
  changes: IrChange[];
  changesText: string;
  /**
   * `accept_warnings` entries that matched no warning of the evaluated model (the warning is not
   * there, the model did not evaluate, or several warnings share the entry's feature and code and it
   * names no instance): not recorded, so they cannot explain a later warning. `why` says which.
   */
  ignoredAcceptances?: (WarningAcceptance & { why: string })[];
  /** The apply's `guard` refused the evaluated state: it was not committed (the session is unchanged). */
  refused?: string;
}

/**
 * A warning the designer explained instead of fixing. One entry explains one warning: when several
 * warnings on the feature share the code (three skipped pattern instances), each needs its own entry
 * naming its `instance` tag — an entry without one then explains none of them.
 */
export interface WarningAcceptance {
  feature: string;
  code: string;
  reason: string;
  /** The warning's instance tag ({@link warningInstanceTag}); needed only when several on the feature share the code. */
  instance?: string | undefined;
}

export interface SessionOptionsV1 {
  engine: EngineV1;
  /** Starting source (edit tasks): compiled, evaluated, and the `$context` model of the spec tests. */
  source?: string;
  /** Document name for the engine. */
  name?: string;
  /**
   * Milliseconds left of the task's wall-time cap: every engine evaluation is cut there
   * (`ENGINE_TIMEOUT`), and none starts once it is used up. Default: no cap.
   */
  timeLeftMs?: () => number;
}

export interface ApplyOptionsV1 {
  expect?: readonly Expectation[];
  /**
   * Warnings on edited features the designer explains (they stop failing L1). Each explains the one
   * warning with that feature and code present on the evaluated model — or, when several share them,
   * the one its `instance` names — and only that.
   */
  acceptWarnings?: readonly WarningAcceptance[];
  /**
   * The IR the new source was spliced from (a tool's IR edit): compiled against it so its ids and
   * reference captures carry over. Default: the current IR.
   */
  base?: IrV1;
  /**
   * Checked on the evaluated state before it becomes current: a reason refuses it, and the session
   * stays as it was (`ApplyOutcomeV1.refused`). A one-step repair re-checks its own promise here.
   */
  guard?: (after: DesignStateV1) => string | undefined;
}

/** One failed variation of the editability probe. */
export interface ProbeFailure {
  param: string;
  value: number;
  code: string;
  where: string;
  hint: string;
}

export interface EditabilityResult {
  /** Parameters varied (driving numeric parameters, in declaration order). */
  varied: string[];
  failures: ProbeFailure[];
  /** Parameters with nothing to vary: bools, derived (expression) parameters, zero values. */
  skipped: string[];
  /**
   * Driving parameters (or single variations) not probed, with the reason: the wall-time budget
   * ran out, the `maxParams` cap, or no value within ±20 % stays inside the declared bounds and
   * the unit's domain.
   */
  notProbed: { param: string; value?: number; reason: string }[];
}

export interface EditabilityOptions {
  /** Vary at most this many parameters (declaration order); default: every driving parameter. */
  maxParams?: number;
  /** Milliseconds left of the task's wall-time budget; the probe stops before an evaluation that would not fit. */
  timeLeftMs?: () => number;
}

const EMPTY: DesignStateV1["compile"] = { ok: false, ir: null, diagnostics: [], spans: {}, curveSpans: {}, partSpans: {}, paramSpans: {}, pathSpans: {}, comments: {} };

function emptyVerification(): VerificationV1 {
  return { compileOk: false, diagnostics: [], expectations: [], unexplained: [], ok: false, level: 0, errorSignature: "" };
}

function relClose(a: number, e: number, rel: number): boolean {
  return Math.abs(a - e) <= rel * Math.max(Math.abs(e), 1e-9);
}

/** Every parameter of a document, document ones first. */
export function allParams(doc: IrV1 | null | undefined): (ir.Parameter & { scope: string })[] {
  if (!doc) return [];
  return [...(doc.params ?? []).map((p) => ({ ...p, scope: "doc" })), ...doc.parts.flatMap((part) => (part.params ?? []).map((p) => ({ ...p, scope: part.name })))];
}

/**
 * The names of features whose IR differs between two documents — a sketch whose curves were added,
 * removed or moved included (`featureChanges` compares everything but the curves) —, plus features
 * that use a changed parameter — directly or through derived parameters (`a` changed, `b = a * 2`,
 * a fillet uses `b`), bounds included. "Uses" means an identifier in one of its expressions
 * (SPEC-v1 §2.3 Scalar sites), not a key, id or enum that happens to spell the parameter's name
 * (`r`, `depth`, `h`).
 */
export function editedFeatures(before: IrV1 | null | undefined, after: IrV1): Set<string> {
  const empty: IrV1 = { schema: after.schema, parts: [] };
  const base = before ?? empty;
  const out = new Set<string>();
  for (const c of featureChanges(base as unknown as IrDocument, after as unknown as IrDocument)) if (c.what !== "removed") out.add(c.path);
  const present = new Set(after.parts.flatMap((p) => p.features.map((f) => f.name)));
  for (const c of curveChanges(base as unknown as IrDocument, after as unknown as IrDocument)) {
    const sketch = c.path.slice(0, c.path.indexOf("."));
    if (present.has(sketch)) out.add(sketch);
  }
  const was = new Map(allParams(base).map((p) => [p.name, JSON.stringify(p)] as const));
  const params = allParams(after);
  const changed = new Set(params.filter((p) => was.get(p.name) !== JSON.stringify(p)).map((p) => p.name));
  // Close over derived parameters: anything whose value or bounds read a changed parameter changed too.
  const reads = new Map(params.map((p) => [p.name, paramNamesV1(p)] as const));
  for (let grew = changed.size > 0; grew; ) {
    grew = false;
    for (const p of params) {
      if (changed.has(p.name)) continue;
      if ([...reads.get(p.name)!].some((n) => changed.has(n))) {
        changed.add(p.name);
        grew = true;
      }
    }
  }
  if (changed.size > 0) {
    for (const part of after.parts) for (const f of part.features) if ([...featureParamNamesV1(f)].some((n) => changed.has(n))) out.add(f.name);
  }
  return out;
}

export class DesignSessionV1 {
  readonly engine: EngineV1;
  readonly name: string;
  readonly checkpoints: CheckpointV1[] = [];
  readonly dialect = "v1" as const;
  #state: DesignStateV1;
  #lastIr: IrV1 | null = null;
  /**
   * The IR of the last state that passed L1 (or the starting model of an edit task): warnings on
   * features edited since then must be explained. Diffing against the previous apply instead would
   * let a re-apply of the same source (or any unrelated patch) pass with the warning unexplained.
   * Each committed state records it (`DesignStateV1.baseline`); a rollback restores the checkpoint's.
   */
  #verifiedIr: IrV1 | null = null;
  #cache = new Map<string, ReportV1>();
  #tests: HiddenTest[] = [];
  #spec: DesignSpec | undefined;
  #frozen = false;
  #context: Subject | undefined;
  #contextV1: { report: ReportV1; ir: IrV1 } | undefined;
  #applies = 0;
  #nextCheckpoint = 1;
  /** References `accept_ref_candidate` rewrote without a capture (see {@link DesignSessionV1.uncapturedRepairs}). */
  #candidateRepairs: { feature: string; field: string; /** contentHash of the query. */ query: string; dropped: boolean }[] = [];
  readonly #timeLeftMs: (() => number) | undefined;

  private constructor(options: SessionOptionsV1) {
    this.engine = options.engine;
    this.name = options.name ?? "design";
    this.#timeLeftMs = options.timeLeftMs;
    this.#state = { source: "", compile: EMPTY, ir: null, report: null, verification: emptyVerification() };
  }

  /** Open a session; a starting source is compiled, evaluated and becomes the edit context. */
  static async open(options: SessionOptionsV1): Promise<DesignSessionV1> {
    const s = new DesignSessionV1(options);
    if (options.source !== undefined && options.source.trim() !== "") {
      s.#state = await s.#evaluate(options.source, {}, true);
      if (s.#state.ir) s.#lastIr = s.#state.ir;
      // The starting model is the baseline: its own warnings are not the designer's edits.
      if (s.#state.ir) s.#verifiedIr = s.#state.ir;
      s.#state.baseline = s.#verifiedIr;
      const { ir: doc, report } = s.#state;
      if (doc && report && report.status === "ok") {
        s.#contextV1 = { report, ir: doc };
        s.#context = subjectOfV1(report, doc);
      }
      s.checkpoint("start");
    }
    return s;
  }

  get state(): DesignStateV1 {
    return this.#state;
  }
  get source(): string {
    return this.#state.source;
  }
  get ir(): IrV1 | null {
    return this.#state.ir;
  }
  get report(): ReportV1 | null {
    return this.#state.report;
  }
  get verification(): VerificationV1 {
    return this.#state.verification;
  }
  get applies(): number {
    return this.#applies;
  }
  /** The starting model of an edit task, as the spec tests see it. */
  get context(): Subject | undefined {
    return this.#context;
  }
  /** The starting model of an edit task, as v1 (for summaries). */
  get contextV1(): { report: ReportV1; ir: IrV1 } | undefined {
    return this.#contextV1;
  }
  get tests(): readonly HiddenTest[] {
    return this.#tests;
  }
  get spec(): DesignSpec | undefined {
    return this.#spec;
  }
  get testsFrozen(): boolean {
    return this.#frozen;
  }
  /** The explanations that explain a warning of the current model (one per feature, code and reason). */
  get acceptedWarnings(): WarningAcceptance[] {
    const out = new Map<string, WarningAcceptance>();
    for (const a of this.#state.accepted ?? []) out.set(`${a.feature}|${a.code}|${a.reason}`, { feature: a.feature, code: a.code, reason: a.reason });
    return [...out.values()];
  }

  /**
   * Record a reference `accept_ref_candidate` rewrote to a candidate's query without a capture
   * (SPEC-v1 §5.9 refreshes the capture; the agent's engine cannot capture yet). `query` is the
   * reference's `q` as the applied IR holds it (after the compile/print round trip), kept as a
   * canonical hash: key order and absent keys do not matter. `dropped`: the reference had a capture
   * before; a later repair of the same field keeps that fact (the first repair dropped it).
   */
  noteCandidateRepair(feature: string, field: string, query: unknown, dropped: boolean): void {
    const was = this.#candidateRepairs.find((r) => r.feature === feature && r.field === field);
    this.#candidateRepairs = [...this.#candidateRepairs.filter((r) => r !== was), { feature, field, query: contentHash(query ?? null), dropped: dropped || (was?.dropped ?? false) }];
  }

  /**
   * The references of the current model that `accept_ref_candidate` re-aimed and that still carry
   * that query with no capture: a later upstream edit that splits or removes the entity is then
   * resolved by the query alone, with no REF_SPLIT / REF_MISSING against a captured entity.
   * PROPOSE lists them under known_issues. A rollback past the repair, or a later rewrite, drops it.
   */
  get uncapturedRepairs(): { feature: string; field: string; dropped: boolean }[] {
    const doc = this.#state.ir;
    if (!doc) return [];
    return this.#candidateRepairs
      .filter((r) => {
        const f = doc.parts.flatMap((p) => p.features).find((x) => x.name === r.feature);
        const ref = f ? refAtPointer(f, r.field) : undefined;
        return ref !== undefined && ref["capture"] === undefined && contentHash(ref["q"] ?? null) === r.query;
      })
      .map(({ feature, field, dropped }) => ({ feature, field, dropped }));
  }

  /**
   * Warning-severity codes on the current model that nobody explained (on features the designer
   * did not edit, or left over from the starting model): PROPOSE lists them under known_issues.
   */
  get openWarnings(): WarningOutcome[] {
    return (this.#state.verification.kernel?.warnings ?? []).filter((w) => w.severity === "warning" && w.accepted === undefined);
  }

  /**
   * Compile, evaluate and verify `source`, then make it the current state (unless `guard` refuses
   * it). `acceptWarnings` explain the matching warnings of the evaluated model only: the ones that
   * match nothing are returned in `ignoredAcceptances`, never kept for later.
   */
  async apply(source: string, options: ApplyOptionsV1 = {}): Promise<ApplyOutcomeV1> {
    const before = this.#state;
    const after = await this.#evaluate(source, options, false);
    const base = before.ir ?? this.#lastIr;
    const delta = changesTextV1(base, after.ir);
    const given = options.acceptWarnings ?? [];
    const ignored = given.filter((a) => !(after.accepted ?? []).some((x) => x.feature === a.feature && x.code === a.code && x.reason === a.reason && x.instance === a.instance));
    const extra = ignored.length > 0 ? { ignoredAcceptances: ignored.map((a) => ({ ...a, why: ignoredWhy(a, after) })) } : {};
    const refused = options.guard?.(after);
    if (refused !== undefined) return { index: this.#applies, before, after, ...delta, ...extra, refused };
    this.#applies += 1;
    if (after.ir) this.#lastIr = after.ir;
    if (after.ir && passedL1(after.verification)) this.#verifiedIr = after.ir;
    after.baseline = this.#verifiedIr;
    this.#state = after;
    return { index: this.#applies, before, after, ...delta, ...extra };
  }

  /**
   * The IR an edit tool starts from: the current IR, or — when the current source was rejected by
   * the compiler for IR-level reasons (e.g. a parameter out of range) — the analysis' partial IR,
   * so `set_param` can repair it. Undefined when the source does not parse.
   */
  editableIr(): IrV1 | undefined {
    if (this.#state.ir) return this.#state.ir;
    if (this.#state.source.trim() === "") return undefined;
    try {
      const a = cs.analyze(this.#state.source, { base: this.#lastIr ?? undefined });
      return a.hasSyntaxErrors ? undefined : a.doc;
    } catch {
      return undefined;
    }
  }

  /** Evaluate a document without touching the session state (tools that look: query, describe, the probe). */
  async evaluateScratch(doc: IrV1, name = `${this.name}-scratch`): Promise<ReportV1> {
    return this.#report(doc, name);
  }

  setSpecTests(tests: readonly HiddenTest[]): void {
    if (this.#frozen) throw new Error("spec tests are frozen");
    this.#tests = tests.map((t) => structuredClone(t));
  }

  freezeSpec(spec: Omit<DesignSpec, "tests">): DesignSpec {
    this.#spec = { ...structuredClone(spec), tests: this.#tests.map((t) => structuredClone(t)) };
    this.#frozen = true;
    return this.#spec;
  }

  freezeTests(): void {
    this.#frozen = true;
  }

  runTests(): SpecTestResult[] | undefined {
    const { ir: doc, report } = this.#state;
    if (this.#tests.length === 0 || !report) return undefined;
    return runSpecTestsV1(this.#tests, { report, ir: doc }, this.#context);
  }

  checkpoint(label: string): CheckpointV1 {
    const cp: CheckpointV1 = { id: `cp${this.#nextCheckpoint++}`, label, applyIndex: this.#applies, state: this.#state };
    this.checkpoints.push(cp);
    return cp;
  }

  findCheckpoint(ref: string): CheckpointV1 | undefined {
    return this.checkpoints.find((c) => c.id === ref) ?? [...this.checkpoints].reverse().find((c) => c.label === ref);
  }

  rollback(ref: string): CheckpointV1 {
    const cp = this.findCheckpoint(ref);
    if (!cp) throw new Error(`no checkpoint "${ref}" (have: ${this.checkpoints.map((c) => `${c.id} "${c.label}"`).join(", ") || "none"})`);
    this.#state = cp.state;
    if (cp.state.ir) this.#lastIr = cp.state.ir;
    // The checkpoint's own baseline: a later verified state must not make its warnings count as unedited.
    this.#verifiedIr = cp.state.baseline ?? null;
    return cp;
  }

  /** The `const` statement text of a feature or parameter in the current source. */
  featureSource(name: string): { text: string; line: number; endLine: number } | undefined {
    const s = findFeature(this.#state.source, name);
    return s ? { text: this.#state.source.slice(s.attachedStart, s.end), line: s.line, endLine: s.endLine } : undefined;
  }

  /**
   * The editability probe (L3): vary every driving numeric parameter by −20 % and +20 % and
   * evaluate each variant; the model must still evaluate. A variation stays inside the parameter's
   * declared bounds and its unit's domain (counts ≥ 1, or ≥ 2 when already ≥ 2, and by at least 1;
   * angles in (0, 360]); a bound that is an expression is applied as the engine evaluates it (a
   * variant the engine rejects as outside the parameter's own range is retried at that bound).
   * Stops before an evaluation the wall-time budget cannot fit; what it could not vary is listed in
   * `notProbed`, never silently dropped.
   */
  async editabilityProbe(options: EditabilityOptions = {}): Promise<EditabilityResult | undefined> {
    const doc = this.#state.ir;
    if (!doc || !this.#state.verification.ok) return undefined;
    const max = options.maxParams ?? Infinity;
    const varied: string[] = [];
    const skipped: string[] = [];
    const failures: ProbeFailure[] = [];
    const notProbed: EditabilityResult["notProbed"] = [];
    let slowest = 0;
    const fits = (): boolean => options.timeLeftMs === undefined || options.timeLeftMs() > Math.max(1000, 2 * slowest);
    const run = async (name: string, value: number): Promise<{ report?: ReportV1; failure?: Omit<ProbeFailure, "param" | "value"> }> => {
      const variant = structuredClone(doc);
      paramIn(variant, name)!.value = value;
      const t0 = Date.now();
      try {
        const report = await this.#report(variant, `${this.name}-probe`);
        const first = firstFailure(report, variant);
        return first ? { report, failure: first } : { report };
      } catch (e) {
        const code = e instanceof EngineError ? e.code : "ENGINE_FAILED";
        return { failure: { code, where: "engine", hint: repairHintV1(code) } };
      } finally {
        slowest = Math.max(slowest, Date.now() - t0);
      }
    };
    for (const p of allParams(doc)) {
      if (typeof p.value !== "number" || p.unit === "bool") {
        skipped.push(p.name);
        continue;
      }
      const values = variations(p);
      if (values.length === 0) {
        if (p.value === 0) skipped.push(p.name);
        else notProbed.push({ param: p.name, reason: "no value within ±20 % stays inside its bounds and its unit's domain" });
        continue;
      }
      if (varied.length >= max) {
        notProbed.push({ param: p.name, reason: `the probe's cap of ${max} parameters` });
        continue;
      }
      if (!fits()) {
        notProbed.push({ param: p.name, reason: "the task's wall-time budget ran out" });
        continue;
      }
      varied.push(p.name);
      for (const value of values) {
        if (!fits()) {
          notProbed.push({ param: p.name, value, reason: "the task's wall-time budget ran out" });
          continue;
        }
        let tried = value;
        let r = await run(p.name, value);
        // An expression bound (not clamped above): the engine reports the parameter's own range with the bounds evaluated.
        const own = r.report?.params?.find((x) => x.name === p.name)?.error;
        if (r.failure?.code === "PARAM_OUT_OF_RANGE" && own?.code === "PARAM_OUT_OF_RANGE") {
          const lo = own.details?.["min"];
          const hi = own.details?.["max"];
          const clamped = Math.min(typeof hi === "number" ? hi : Infinity, Math.max(typeof lo === "number" ? lo : -Infinity, value));
          const inDomain = inUnitDomain(p, clamped);
          if (!Number.isFinite(clamped) || clamped === p.value || !inDomain || !fits()) {
            notProbed.push({ param: p.name, value, reason: `outside its declared range [${typeof lo === "number" ? lo : "−∞"}, ${typeof hi === "number" ? hi : "∞"}]` });
            continue;
          }
          tried = clamped;
          r = await run(p.name, clamped);
        }
        if (r.failure) failures.push({ param: p.name, value: tried, ...r.failure });
      }
    }
    return { varied, failures, skipped, notProbed };
  }

  // ── The ladder ──

  async #evaluate(source: string, options: ApplyOptionsV1, opening: boolean): Promise<DesignStateV1> {
    const base = options.base ?? this.#state?.ir ?? this.#lastIr ?? undefined;
    let c: cs.CompileResult;
    let diagnostics: DiagnosticInfo[];
    try {
      c = cs.compile(source, { base: base ?? undefined, fileName: `${this.name}.cad.ts` });
      diagnostics = this.#diagnostics(source, c);
    } catch (e) {
      c = EMPTY;
      diagnostics = [compilerFailure(e)];
    }
    const v: VerificationV1 = { ...emptyVerification(), compileOk: c.ok && c.ir !== null, diagnostics };
    // Without an evaluated model nothing can be matched: the explanations in force stay as they are.
    const kept = opening ? {} : this.#state.accepted?.length ? { accepted: this.#state.accepted } : {};
    if (!v.compileOk || diagnostics.some((d) => d.severity === "error") || !c.ir) {
      v.failedAt = 0;
      v.errorSignature = diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.code}@${d.line}:${d.col}:${d.message}`)
        .sort()
        .join("|");
      return { source, compile: c, ir: c.ir, report: null, verification: v, ...kept };
    }
    const doc = c.ir;

    // L1: kernel.
    v.level = 1;
    let report: ReportV1;
    try {
      report = await this.#report(doc, this.name);
    } catch (e) {
      const code = e instanceof EngineError ? e.code : "ENGINE_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      v.engineError = { code, message, hint: repairHintV1(code) };
      v.failedAt = 1;
      v.errorSignature = `${code}:${message}`;
      return { source, compile: c, ir: doc, report: null, verification: v, ...kept };
    }
    const edited = opening ? new Set<string>() : editedFeatures(this.#verifiedIr, doc);
    const { kernel, accepted } = this.#kernel(report, doc, edited, opening ? [] : (this.#state.accepted ?? []), options.acceptWarnings ?? []);
    v.kernel = kernel;
    const state = (): DesignStateV1 => ({ source, compile: c, ir: doc, report, verification: v, ...(accepted.length > 0 ? { accepted } : {}) });
    v.unexplained = v.kernel.warnings.filter((w) => w.severity === "warning" && w.edited && w.accepted === undefined);
    if (report.status !== "ok" || v.kernel.rejections.length > 0) {
      v.failedAt = 1;
      v.errorSignature = [
        ...v.kernel.rejections.map((r) => `${r.code}@${r.path}:${r.message}`),
        ...v.kernel.params.filter((p) => p.code).map((p) => `${p.code}@param:${p.name}:${p.message}`),
        ...v.kernel.features.filter((f) => f.status !== "ok").map((f) => `${f.code}@${f.feature}:${f.message}`),
      ]
        .sort((a, b) => Number(a.startsWith("DEPENDENCY_FAILED") || a.startsWith("PARAM_FAILED")) - Number(b.startsWith("DEPENDENCY_FAILED") || b.startsWith("PARAM_FAILED")) || (a < b ? -1 : a > b ? 1 : 0))
        .join("|");
      return state();
    }
    if (v.unexplained.length > 0) {
      v.failedAt = 1;
      v.errorSignature = v.unexplained.map((w) => `W:${w.code}@${w.feature}:${w.message}`).sort().join("|");
      return state();
    }

    // L2: per-step expectations.
    v.level = 2;
    v.expectations = checkExpectationsV1(options.expect ?? [], report);
    if (v.expectations.some((x) => !x.pass)) {
      v.failedAt = 2;
      v.errorSignature = v.expectations
        .filter((x) => !x.pass)
        .map((x) => `EXPECT@${x.feature}.${x.check}:${x.actual}`)
        .sort()
        .join("|");
      return state();
    }
    v.ok = true;

    // L3: spec tests.
    if (this.#tests.length > 0) {
      v.level = 3;
      v.tests = runSpecTestsV1(this.#tests, { report, ir: doc }, this.#context);
    }
    return state();
  }

  /** One engine evaluation (cached by content hash), cut at the task's wall-time cap. */
  async #report(doc: IrV1, name: string): Promise<ReportV1> {
    const key = irHashV1(doc);
    const hit = this.#cache.get(key);
    if (hit) return structuredClone(hit);
    const left = this.#timeLeftMs?.() ?? Number.POSITIVE_INFINITY;
    if (!(left > 0)) throw new EngineError("ENGINE_TIMEOUT", "not evaluated: the task's wall-time cap is used up");
    const report = await this.engine.evaluate(doc, { name, ...(Number.isFinite(left) ? { timeoutMs: Math.ceil(left) } : {}) });
    this.#cache.set(key, structuredClone(report));
    return report;
  }

  #diagnostics(source: string, c: cs.CompileResult): DiagnosticInfo[] {
    const lines = source.split("\n");
    const statements = locateStatements(source).statements;
    const featureAt = (line: number) => statements.find((s) => s.kind === "feature" && s.line <= line && line <= s.endLine)?.name;
    let partial: IrV1 | null | undefined;
    const doc = (): IrV1 | null => {
      if (partial === undefined) {
        try {
          partial = cs.analyze(source).doc;
        } catch {
          partial = null;
        }
      }
      return partial;
    };
    const info = (d: cs.Diagnostic): DiagnosticInfo => {
      const computed = d.severity === "error" ? compileHintV1(d.code, source, d.span, doc()) : undefined;
      const out: DiagnosticInfo = {
        code: d.code,
        severity: d.severity,
        message: d.message,
        hint: computed ?? d.hint ?? staticHintV1(d.code) ?? "Fix the reported problem and re-apply.",
        line: d.span.start.line,
        col: d.span.start.col,
      };
      const f = featureAt(d.span.start.line);
      if (f !== undefined) out.feature = f;
      const text = lines[d.span.start.line - 1]?.trim();
      if (text) out.excerpt = text.length > 160 ? `${text.slice(0, 157)}…` : text;
      return out;
    };
    const kept = c.diagnostics.filter((d) => d.severity !== "info" || d.code === "CS_RENAME_DETECTED").map(info);
    const errorLines = new Set(kept.filter((d) => d.severity === "error").map((d) => d.line));
    let tsDiags: DiagnosticInfo[] = [];
    if (source.trim() !== "" && kept.every((d) => d.code !== "CS_TOO_COMPLEX")) {
      try {
        tsDiags = cs
          .typecheck(source)
          .filter((d) => d.severity === "error" && !errorLines.has(d.span.start.line))
          .map(info);
      } catch {
        tsDiags = [];
      }
    }
    const rank = (d: DiagnosticInfo) => (d.severity === "error" ? 0 : d.severity === "warning" ? 1 : 2);
    return [...kept, ...tsDiags].sort((a, b) => rank(a) - rank(b) || a.line - b.line || a.col - b.col);
  }

  /**
   * The kernel outcome of a report, and the explanations in force for it: a warning is explained by
   * this apply's `accept_warnings` entry for its feature and code, or by an earlier explanation of
   * the same instance ({@link warningFingerprint}) whose feature was not edited since it was given.
   * Explanations that match no warning of this report lapse.
   */
  #kernel(report: ReportV1, doc: IrV1, edited: ReadonlySet<string>, previous: readonly AcceptedWarning[], given: readonly WarningAcceptance[]): { kernel: KernelOutcomeV1; accepted: AcceptedWarning[] } {
    const view = { report, ir: doc };
    const editedSince = new Map<IrV1, Set<string>>();
    const stillValid = (a: AcceptedWarning): boolean => {
      let e = editedSince.get(a.ir);
      if (!e) editedSince.set(a.ir, (e = editedFeatures(a.ir, doc)));
      return !e.has(a.feature);
    };
    const accepted: AcceptedWarning[] = [];
    const siblings = new Map<string, number>();
    for (const f of report.features) for (const w of f.warnings ?? []) siblings.set(`${f.feature}|${w.code}`, (siblings.get(`${f.feature}|${w.code}`) ?? 0) + 1);
    const explain = (feature: string, w: metricsV1.Warning): string | undefined => {
      const fingerprint = warningFingerprint(feature, w);
      const tag = fingerprint.slice(0, 8);
      const shared = (siblings.get(`${feature}|${w.code}`) ?? 0) > 1;
      // One entry, one warning: with several of the same code on the feature, only the instance it names.
      const now = given.find((a) => a.feature === feature && a.code === w.code && (a.instance !== undefined ? a.instance.trim().toLowerCase() === tag : !shared));
      const record = now
        ? { feature, code: w.code, reason: now.reason, ...(now.instance !== undefined ? { instance: now.instance } : {}), fingerprint, ir: doc }
        : previous.find((a) => a.feature === feature && a.code === w.code && a.fingerprint === fingerprint && stillValid(a));
      if (!record) return undefined;
      if (!accepted.some((a) => a.fingerprint === record.fingerprint && a.reason === record.reason)) accepted.push(record);
      return record.reason;
    };
    const features = report.features.map((f): FeatureOutcomeV1 => {
      const out: FeatureOutcomeV1 = { part: f.part, feature: f.feature, type: f.type, status: f.status, entry: f };
      if (f.status !== "ok") {
        out.code = f.error?.code ?? "UNKNOWN";
        out.message = f.error?.message ?? "";
        out.hint = repairHintV1(out.code, { ...view, details: f.error?.details, feature: f });
      }
      return out;
    });
    const warnings: WarningOutcome[] = report.features.flatMap((f) =>
      (f.warnings ?? []).map((w): WarningOutcome => {
        const reason = explain(f.feature, w);
        return {
          feature: f.feature,
          code: w.code,
          severity: w.severity,
          message: w.message,
          hint: repairHintV1(w.code, { ...view, details: w.details, feature: f }),
          edited: edited.has(f.feature),
          ...(reason !== undefined ? { accepted: reason } : {}),
          instance: warningInstanceTag(f.feature, w),
          siblings: siblings.get(`${f.feature}|${w.code}`) ?? 1,
        };
      }),
    );
    const params = (report.params ?? []).map((p): ParamOutcome => {
      const out: ParamOutcome = { name: p.name, scope: p.scope, unit: p.unit };
      if (p.value !== undefined) out.value = p.value;
      if (p.error) {
        out.code = p.error.code;
        out.message = p.error.message;
        out.hint = repairHintV1(p.error.code, { ...view, details: p.error.details, param: p.name });
      }
      return out;
    });
    const rejections: RejectionOutcome[] = [];
    if (report.error) {
      const all = (report.error.details?.["errors"] as unknown[] | undefined) ?? [report.error];
      for (const e of all) {
        const eo = obj(e);
        rejections.push({ code: str(eo, "code") ?? report.error.code, path: str(eo, "path") ?? "", message: str(eo, "message") ?? report.error.message, hint: rejectionHintV1(e, view) });
      }
    }
    return { kernel: { status: report.status, engine: report.engine, features, params, warnings, rejections }, accepted };
  }
}

/** `~base (curves ~c1), +slab, ~param width 80→100`: features, sketch curves and parameters that changed. */
function changesTextV1(before: IrV1 | null | undefined, after: IrV1 | null): { changes: IrChange[]; changesText: string } {
  if (!after) return { changes: [], changesText: "IR unavailable (compile errors)" };
  const delta = changesText((before ?? null) as unknown as IrDocument | null, after as unknown as IrDocument);
  const text = [delta.changes.length > 0 ? delta.text : "", paramChangesText(before, after)].filter(Boolean).join(", ");
  return { changes: delta.changes, changesText: text || "no IR changes" };
}

function paramChangesText(before: IrV1 | null | undefined, after: IrV1): string {
  const was = new Map(allParams(before).map((p) => [p.name, p] as const));
  return allParams(after)
    .flatMap((p) => {
      const b = was.get(p.name);
      if (!b) return [`+param ${p.name}`];
      return JSON.stringify(b.value) !== JSON.stringify(p.value) ? [`~param ${p.name} ${JSON.stringify(b.value)}→${JSON.stringify(p.value)}`] : [];
    })
    .join(", ");
}

/** The reference object at a JSON pointer of a feature (`/target`, `/on/face`), if there is one. */
function refAtPointer(f: ir.Feature, pointer: string): Record<string, unknown> | undefined {
  let cur: unknown = f;
  for (const part of pointer.split("/").slice(1)) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  return cur !== null && typeof cur === "object" && !Array.isArray(cur) && "q" in cur ? (cur as Record<string, unknown>) : undefined;
}

/** Why an `accept_warnings` entry explained nothing on the evaluated state. */
function ignoredWhy(a: WarningAcceptance, after: DesignStateV1): string {
  if (!after.report) return "the model did not evaluate";
  const same = (after.verification.kernel?.warnings ?? []).filter((w) => w.feature === a.feature && w.code === a.code);
  if (same.length === 0) return "the evaluated model has no such warning";
  const tags = same.map((w) => w.instance).join(", ");
  if (a.instance === undefined) return `${same.length} ${a.code} warnings on ${a.feature} share it: give one entry per warning, each with its instance (${tags})`;
  return `no ${a.code} warning on ${a.feature} has instance ${JSON.stringify(a.instance)} (instances: ${tags})`;
}

/** Whether a state passed L1 (it reached L2: no kernel failure and no unexplained warning). */
function passedL1(v: VerificationV1): boolean {
  return v.level >= 2 || (v.kernel !== undefined && v.failedAt === undefined);
}

function paramIn(doc: IrV1, name: string): ir.Parameter | undefined {
  return [...(doc.params ?? []), ...doc.parts.flatMap((x) => x.params ?? [])].find((x) => x.name === name);
}

/** Whether `x` is a value the probe may try for `p`: an integer ≥ 1 (≥ 2 once ≥ 2) for a count, an angle in (0, 360] stays there. */
function inUnitDomain(p: Pick<ir.Parameter, "value" | "unit">, x: number): boolean {
  const v = p.value as number;
  if (!Number.isFinite(x)) return false;
  if (p.unit === "count") return Number.isInteger(x) && x >= (v >= 2 ? 2 : 1);
  if (p.unit === "deg" && v > 0 && v <= 360) return x > 0 && x <= 360;
  return true;
}

/**
 * The (at most two) values the probe tries for one parameter: ±20 %, clamped to its literal bounds
 * and to its unit's domain — a count stays ≥ 1 (≥ 2 when it is already ≥ 2) and moves by at least
 * 1; an angle in (0, 360] stays there (a 360° revolve is not tried at 432°).
 */
export function variations(p: Pick<ir.Parameter, "value" | "unit" | "min" | "max">): number[] {
  const v = p.value as number;
  let lo = typeof p.min === "number" ? p.min : -Infinity;
  let hi = typeof p.max === "number" ? p.max : Infinity;
  // ±20 % of zero is zero: a zero-valued parameter has no relative variation to try.
  if (v === 0) return [];
  if (p.unit === "count") lo = Math.max(lo, v >= 2 ? 2 : 1);
  if (p.unit === "deg" && v > 0 && v <= 360) {
    hi = Math.min(hi, 360);
    lo = Math.max(lo, Number.MIN_VALUE);
  }
  const clamp = (x: number) => Math.min(hi, Math.max(lo, x));
  const out = p.unit === "count" ? [clamp(Math.min(Math.round(v * 0.8), v - 1)), clamp(Math.max(Math.round(v * 1.2), v + 1))] : [clamp(v * 0.8), clamp(v * 1.2)].map((x) => Number(x.toPrecision(12)));
  return [...new Set(out)].filter((x) => x !== v && Number.isFinite(x) && x >= lo && x <= hi && (p.unit !== "count" || Number.isInteger(x)));
}

/** The first failure of a report: a rejection, a parameter or a feature. */
function firstFailure(report: ReportV1, doc: IrV1): { code: string; where: string; hint: string } | undefined {
  const view = { report, ir: doc };
  if (report.error) {
    const first = ((report.error.details?.["errors"] as unknown[] | undefined) ?? [report.error])[0];
    return { code: report.error.code, where: "document", hint: rejectionHintV1(first, view) };
  }
  const p = (report.params ?? []).find((x) => x.error);
  if (p?.error) return { code: p.error.code, where: `parameter ${p.name}`, hint: repairHintV1(p.error.code, { ...view, details: p.error.details, param: p.name }) };
  // Root causes first: consumers only repeat them.
  const failed = report.features.filter((f) => f.status !== "ok");
  const root = failed.find((f) => f.error?.code !== "DEPENDENCY_FAILED" && f.error?.code !== "PARAM_FAILED") ?? failed[0];
  if (root) return { code: root.error?.code ?? "UNKNOWN", where: root.feature, hint: repairHintV1(root.error?.code ?? "UNKNOWN", { ...view, details: root.error?.details, feature: root }) };
  return undefined;
}

function compilerFailure(e: unknown): DiagnosticInfo {
  const tooComplex = e instanceof RangeError;
  const code = tooComplex ? "CS_TOO_COMPLEX" : "CS_COMPILER_ERROR";
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return {
    code,
    severity: "error",
    message: tooComplex ? `the source is nested too deeply to compile (${detail})` : `the compiler failed on this source (${detail})`,
    hint: staticHintV1(code) ?? "Rewrite the last change more simply.",
    line: 1,
    col: 1,
  };
}

/** L2 on a v1 report: a feature's bodies are the ones it created or modified (SPEC-v1 §6.0.5). */
export function checkExpectationsV1(expect: readonly Expectation[], report: ReportV1): ExpectationResult[] {
  const out: ExpectationResult[] = [];
  for (const e of expect) {
    const f = report.features.find((x) => x.feature === e.feature);
    if (!f) {
      out.push({ feature: e.feature, check: "exists", expected: "evaluated", actual: "not in the report (missing or suppressed)", pass: false });
      continue;
    }
    const bodies = f.bodies ?? [];
    const regions = f.regions ?? [];
    if (e.bodies !== undefined) out.push({ feature: e.feature, check: "bodies", expected: `= ${e.bodies}`, actual: String(bodies.length), pass: bodies.length === e.bodies });
    if (e.regions !== undefined) out.push({ feature: e.feature, check: "regions", expected: `= ${e.regions}`, actual: String(regions.length), pass: regions.length === e.regions });
    if (e.holes !== undefined) {
      const holes = f.holes ? f.holes.length : regions.reduce((n, r) => n + r.loops - 1, 0);
      out.push({ feature: e.feature, check: "holes", expected: `= ${e.holes}`, actual: String(holes), pass: holes === e.holes });
    }
    if (e.volume !== undefined) {
      const vol = bodies.reduce((s, b) => s + b.volume, 0);
      out.push({ feature: e.feature, check: "volume", expected: `≈ ${num(e.volume)} ±1%`, actual: num(vol), pass: relClose(vol, e.volume, 0.01) });
    }
    if (e.bbox_size !== undefined) {
      if (bodies.length === 0) {
        out.push({ feature: e.feature, check: "bbox_size", expected: `≈ ${e.bbox_size.map(num).join("×")} ±0.05`, actual: "no bodies", pass: false });
      } else {
        const min = [0, 1, 2].map((i) => Math.min(...bodies.map((b) => b.bbox_min[i]!)));
        const max = [0, 1, 2].map((i) => Math.max(...bodies.map((b) => b.bbox_max[i]!)));
        const size = bboxSize({ bbox_min: min as [number, number, number], bbox_max: max as [number, number, number] });
        const pass = e.bbox_size.length === 3 && size.every((s, i) => Math.abs(s - e.bbox_size![i]!) <= 0.05);
        out.push({ feature: e.feature, check: "bbox_size", expected: `≈ ${e.bbox_size.map(num).join("×")} ±0.05`, actual: size.map(num).join("×"), pass });
      }
    }
  }
  return out;
}
