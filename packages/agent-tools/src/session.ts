/**
 * The in-memory design session an agent works on: the CadScript source, its compiled IR, the
 * latest evaluation report, spec tests and checkpoints — plus the verification ladder every
 * mutation goes through (ARCHITECTURE §6 "Verification ladder"):
 *
 *   L0 static   compile (CadScript front end + IR validation) and `tsc` against @aicad/std
 *   L1 kernel   engine evaluation: report status, per-feature errors, bodies
 *   L2 per-op   the expectations the agent attached to the step (bodies, holes, volume, bbox)
 *   L3 tests    the frozen spec tests (only when L0–L2 pass)
 *
 * A level runs only when the level below passes. Every failure carries a repair hint from the
 * operation playbooks.
 */
import { compile, typecheck, type CompileResult, type Diagnostic } from "@aicad/cadscript";
import type { BodyMetrics, EvalReport, IrDocument, RegionMetrics } from "@aicad/ir-types";
import { EngineError, irHash, type Engine, type HiddenTest, type IrChange, type Subject } from "@aicad/evals";
import { dims, num } from "./format.js";
import { repairHint, staticHint } from "./playbooks.js";
import { findFeature, locateStatements } from "./source.js";
import { runSpecTests, type DesignSpec, type SpecTestResult } from "./spec.js";
import { bboxSize, changesText } from "./summaries.js";

export interface DiagnosticInfo {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  hint: string;
  line: number;
  col: number;
  /** The feature const whose statement contains the diagnostic. */
  feature?: string;
  /** The offending source line (trimmed). */
  excerpt?: string;
}

export interface FeatureOutcome {
  part: string;
  feature: string;
  type: string;
  status: "ok" | "error";
  code?: string;
  message?: string;
  hint?: string;
  bodies?: BodyMetrics[];
  regions?: RegionMetrics[];
}

export interface KernelOutcome {
  status: "ok" | "error";
  engine: string;
  features: FeatureOutcome[];
  documentError?: { code: string; message: string; hint: string };
}

export interface EngineFailure {
  code: string;
  message: string;
  hint: string;
}

/** An L2 expectation the agent attaches to a step. Tolerances: volume ±1 %, bbox ±0.05 mm. */
export interface Expectation {
  feature: string;
  bodies?: number | undefined;
  regions?: number | undefined;
  holes?: number | undefined;
  volume?: number | undefined;
  /** Axis-aligned size [x, y, z] of the feature's bodies together. */
  bbox_size?: number[] | undefined;
}

export interface ExpectationResult {
  feature: string;
  check: "bodies" | "regions" | "holes" | "volume" | "bbox_size" | "exists";
  expected: string;
  actual: string;
  pass: boolean;
}

export type Level = 0 | 1 | 2 | 3;

export interface Verification {
  compileOk: boolean;
  /** Errors first, then warnings (infos except renames are dropped). */
  diagnostics: DiagnosticInfo[];
  kernel?: KernelOutcome;
  engineError?: EngineFailure;
  expectations: ExpectationResult[];
  tests?: SpecTestResult[];
  /** L0–L2 passed. */
  ok: boolean;
  /** Highest level that ran. */
  level: Level;
  /** The level that failed (undefined when ok). */
  failedAt?: Level;
  /** Stable signature of what failed (empty when ok); equal signatures mean "the same error". */
  errorSignature: string;
}

export interface DesignState {
  source: string;
  compile: CompileResult;
  ir: IrDocument | null;
  report: EvalReport | null;
  verification: Verification;
}

export interface Checkpoint {
  id: string;
  label: string;
  /** Number of applies when the checkpoint was taken. */
  applyIndex: number;
  state: DesignState;
}

export interface ApplyOutcome {
  index: number;
  before: DesignState;
  after: DesignState;
  changes: IrChange[];
  changesText: string;
}

export interface SessionOptions {
  engine: Engine;
  /** Starting source (edit tasks). Its evaluated state is the `$context` model for spec tests. */
  source?: string;
  /** Document name for the engine (temp file stem). */
  name?: string;
}

const EMPTY_SOURCE = "";

function emptyVerification(): Verification {
  return { compileOk: false, diagnostics: [], expectations: [], ok: false, level: 0, errorSignature: "" };
}

function relClose(a: number, e: number, rel: number): boolean {
  return Math.abs(a - e) <= rel * Math.max(Math.abs(e), 1e-9);
}

export class DesignSession {
  readonly engine: Engine;
  readonly name: string;
  readonly checkpoints: Checkpoint[] = [];
  #state: DesignState;
  #lastIr: IrDocument | null = null;
  #cache = new Map<string, EvalReport>();
  #tests: HiddenTest[] = [];
  #spec: DesignSpec | undefined;
  #frozen = false;
  #context: Subject | undefined;
  #applies = 0;
  #nextCheckpoint = 1;

  private constructor(options: SessionOptions) {
    this.engine = options.engine;
    this.name = options.name ?? "design";
    this.#state = { source: EMPTY_SOURCE, compile: compile(EMPTY_SOURCE), ir: null, report: null, verification: emptyVerification() };
  }

  /** Open a session. With a starting source it is compiled and evaluated (and becomes the edit context). */
  static async open(options: SessionOptions): Promise<DesignSession> {
    const s = new DesignSession(options);
    if (options.source !== undefined && options.source.trim() !== "") {
      s.#state = await s.#evaluate(options.source, []);
      if (s.#state.ir) s.#lastIr = s.#state.ir;
      if (s.#state.ir && s.#state.report && s.#state.report.status === "ok") s.#context = { report: s.#state.report, ir: s.#state.ir };
      s.checkpoint("start");
    }
    return s;
  }

  get state(): DesignState {
    return this.#state;
  }
  get source(): string {
    return this.#state.source;
  }
  get ir(): IrDocument | null {
    return this.#state.ir;
  }
  get report(): EvalReport | null {
    return this.#state.report;
  }
  get verification(): Verification {
    return this.#state.verification;
  }
  get applies(): number {
    return this.#applies;
  }
  /** The starting model of an edit task (for `$context` and `changed_*` checks). */
  get context(): Subject | undefined {
    return this.#context;
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

  /** Compile, evaluate and verify `source`, then make it the current state. */
  async apply(source: string, options: { expect?: readonly Expectation[] } = {}): Promise<ApplyOutcome> {
    const before = this.#state;
    const after = await this.#evaluate(source, options.expect ?? []);
    this.#applies += 1;
    const base = before.ir ?? this.#lastIr;
    const delta = changesText(base, after.ir);
    this.#state = after;
    if (after.ir) this.#lastIr = after.ir;
    return { index: this.#applies, before, after, changes: delta.changes, changesText: delta.text };
  }

  /** Set (replace) the spec tests. Throws once they are frozen. */
  setSpecTests(tests: readonly HiddenTest[]): void {
    if (this.#frozen) throw new Error("spec tests are frozen");
    this.#tests = tests.map((t) => structuredClone(t));
  }

  /** Record the DesignSpec and freeze the tests: from now on the builder can only read them. */
  freezeSpec(spec: Omit<DesignSpec, "tests">): DesignSpec {
    this.#spec = { ...structuredClone(spec), tests: this.#tests.map((t) => structuredClone(t)) };
    this.#frozen = true;
    return this.#spec;
  }

  /** Freeze whatever tests exist (e.g. when the spec writer could not finish). */
  freezeTests(): void {
    this.#frozen = true;
  }

  /** Run the spec tests on the current state; undefined when there are no tests or no report. */
  runTests(): SpecTestResult[] | undefined {
    const { ir, report } = this.#state;
    if (this.#tests.length === 0 || !report) return undefined;
    return runSpecTests(this.#tests, { report, ir }, this.#context);
  }

  checkpoint(label: string): Checkpoint {
    const cp: Checkpoint = { id: `cp${this.#nextCheckpoint++}`, label, applyIndex: this.#applies, state: this.#state };
    this.checkpoints.push(cp);
    return cp;
  }

  findCheckpoint(ref: string): Checkpoint | undefined {
    return this.checkpoints.find((c) => c.id === ref) ?? [...this.checkpoints].reverse().find((c) => c.label === ref);
  }

  /** Restore a checkpoint's state (the checkpoint list itself is kept; history is append-only). */
  rollback(ref: string): Checkpoint {
    const cp = this.findCheckpoint(ref);
    if (!cp) throw new Error(`no checkpoint "${ref}" (have: ${this.checkpoints.map((c) => `${c.id} "${c.label}"`).join(", ") || "none"})`);
    this.#state = cp.state;
    if (cp.state.ir) this.#lastIr = cp.state.ir;
    return cp;
  }

  // ── The ladder ──

  async #evaluate(source: string, expect: readonly Expectation[]): Promise<DesignState> {
    const base = this.#state?.ir ?? this.#lastIr ?? undefined;
    let c: CompileResult;
    let diagnostics: DiagnosticInfo[];
    try {
      c = compile(source, { base: base ?? undefined, fileName: `${this.name}.cad.ts` });
      diagnostics = this.#diagnostics(source, c);
    } catch (e) {
      // The front end (or tsc) can throw on pathological input, e.g. a stack overflow on thousands of
      // nested brackets. That is an L0 failure of this source, not a failure of the session.
      c = failedCompile();
      diagnostics = [compilerFailure(e)];
    }
    const v: Verification = { ...emptyVerification(), compileOk: c.ok && c.ir !== null, diagnostics };
    const failL0 = (): DesignState => {
      v.failedAt = 0;
      v.errorSignature = diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => `${d.code}@${d.line}:${d.col}:${d.message}`)
        .sort()
        .join("|");
      return { source, compile: c, ir: c.ir, report: null, verification: v };
    };
    if (!v.compileOk || diagnostics.some((d) => d.severity === "error") || !c.ir) return failL0();
    const ir = c.ir;

    // L1: kernel.
    v.level = 1;
    let report: EvalReport;
    try {
      report = await this.#report(ir);
    } catch (e) {
      const code = e instanceof EngineError ? e.code : "ENGINE_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      v.engineError = { code, message, hint: repairHint(code) };
      v.failedAt = 1;
      v.errorSignature = `${code}:${message}`;
      return { source, compile: c, ir, report: null, verification: v };
    }
    v.kernel = this.#kernel(report, ir);
    if (report.status !== "ok") {
      v.failedAt = 1;
      v.errorSignature = [
        ...(v.kernel.documentError ? [`${v.kernel.documentError.code}:${v.kernel.documentError.message}`] : []),
        ...v.kernel.features.filter((f) => f.status !== "ok").map((f) => `${f.code}@${f.feature}:${f.message}`),
      ]
        // Root causes first: a DEPENDENCY_FAILED consumer only repeats its sketch's error.
        .sort((a, b) => Number(a.startsWith("DEPENDENCY_FAILED")) - Number(b.startsWith("DEPENDENCY_FAILED")) || (a < b ? -1 : a > b ? 1 : 0))
        .join("|");
      return { source, compile: c, ir, report, verification: v };
    }

    // L2: per-step expectations.
    v.level = 2;
    v.expectations = checkExpectations(expect, report);
    if (v.expectations.some((x) => !x.pass)) {
      v.failedAt = 2;
      v.errorSignature = v.expectations
        .filter((x) => !x.pass)
        .map((x) => `EXPECT@${x.feature}.${x.check}:${x.actual}`)
        .sort()
        .join("|");
      return { source, compile: c, ir, report, verification: v };
    }
    v.ok = true;

    // L3: spec tests.
    if (this.#tests.length > 0) {
      v.level = 3;
      v.tests = runSpecTests(this.#tests, { report, ir }, this.#context);
    }
    return { source, compile: c, ir, report, verification: v };
  }

  async #report(ir: IrDocument): Promise<EvalReport> {
    const key = irHash(ir);
    const hit = this.#cache.get(key);
    if (hit) return structuredClone(hit);
    const report = await this.engine.evaluate(ir, { name: this.name });
    this.#cache.set(key, structuredClone(report));
    return report;
  }

  #diagnostics(source: string, c: CompileResult): DiagnosticInfo[] {
    const lines = source.split("\n");
    const statements = locateStatements(source).statements;
    const featureAt = (line: number) => statements.find((s) => s.kind === "feature" && s.line <= line && line <= s.endLine)?.name;
    const info = (d: Diagnostic): DiagnosticInfo => {
      const out: DiagnosticInfo = {
        code: d.code,
        severity: d.severity,
        message: d.message,
        hint: combineHints(d.code, d.hint, repairHint(d.code, { source, span: d.span, message: d.message })),
        line: d.span.start.line,
        col: d.span.start.col,
      };
      const f = featureAt(d.span.start.line);
      if (f !== undefined) out.feature = f;
      const text = lines[d.span.start.line - 1]?.trim();
      if (text) out.excerpt = text.length > 160 ? `${text.slice(0, 157)}…` : text;
      return out;
    };
    const cs = c.diagnostics.filter((d) => d.severity !== "info" || d.code === "CS_RENAME_DETECTED").map(info);
    // tsc repeats most compiler errors in other words: keep a TS error only on lines without a CadScript error.
    const csErrorLines = new Set(cs.filter((d) => d.severity === "error").map((d) => d.line));
    let tsDiags: DiagnosticInfo[] = [];
    if (source.trim() !== "") {
      tsDiags = typecheck(source)
        .filter((d) => d.severity === "error" && !csErrorLines.has(d.span.start.line))
        .map(info);
    }
    const rank = (d: DiagnosticInfo) => (d.severity === "error" ? 0 : d.severity === "warning" ? 1 : 2);
    return [...cs, ...tsDiags].sort((a, b) => rank(a) - rank(b) || a.line - b.line || a.col - b.col);
  }

  #kernel(report: EvalReport, ir: IrDocument): KernelOutcome {
    const features = report.features.map((f): FeatureOutcome => {
      const out: FeatureOutcome = { part: f.part, feature: f.feature, type: f.type, status: f.status };
      if (f.bodies) out.bodies = f.bodies;
      if (f.regions) out.regions = f.regions;
      if (f.status !== "ok") {
        const code = f.error?.code ?? "UNKNOWN";
        out.code = code;
        out.message = f.error?.message ?? "";
        out.hint = repairHint(code, { ir, feature: f.feature, message: out.message, report });
      }
      return out;
    });
    const k: KernelOutcome = { status: report.status, engine: report.engine, features };
    if (report.error) k.documentError = { code: report.error.code, message: report.error.message, hint: repairHint(report.error.code) };
    return k;
  }

  /** The `const` statement text of a feature in the current source. */
  featureSource(name: string): { text: string; line: number; endLine: number } | undefined {
    const s = findFeature(this.#state.source, name);
    return s ? { text: this.#state.source.slice(s.attachedStart, s.end), line: s.line, endLine: s.endLine } : undefined;
  }
}

function failedCompile(): CompileResult {
  return { ok: false, ir: null, diagnostics: [], spans: {}, curveSpans: {}, partSpans: {}, pathSpans: {}, comments: {} };
}

/** An L0 diagnostic for a compiler exception: `CS_TOO_COMPLEX` for a stack overflow, else `CS_COMPILER_ERROR`. */
function compilerFailure(e: unknown): DiagnosticInfo {
  const tooComplex = e instanceof RangeError;
  const code = tooComplex ? "CS_TOO_COMPLEX" : "CS_COMPILER_ERROR";
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return {
    code,
    severity: "error",
    message: tooComplex ? `the source is nested too deeply to compile (${detail})` : `the compiler failed on this source (${detail})`,
    hint: repairHint(code),
    line: 1,
    col: 1,
  };
}

/** A computed playbook hint beats the compiler's hint; the compiler's (specific) hint beats the static playbook text. */
function combineHints(code: string, compilerHint: string | undefined, playbook: string): string {
  const computed = playbook !== staticHint(code);
  if (computed || !compilerHint) return playbook;
  return compilerHint;
}

/** L2: compare each expectation with the report. */
export function checkExpectations(expect: readonly Expectation[], report: EvalReport): ExpectationResult[] {
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
      const holes = regions.reduce((n, r) => n + r.loops - 1, 0);
      out.push({ feature: e.feature, check: "holes", expected: `= ${e.holes}`, actual: String(holes), pass: holes === e.holes });
    }
    if (e.volume !== undefined) {
      const v = bodies.reduce((s, b) => s + b.volume, 0);
      out.push({ feature: e.feature, check: "volume", expected: `≈ ${num(e.volume)} ±1%`, actual: num(v), pass: relClose(v, e.volume, 0.01) });
    }
    if (e.bbox_size !== undefined) {
      if (bodies.length === 0) {
        out.push({ feature: e.feature, check: "bbox_size", expected: `≈ ${dims(e.bbox_size)} ±0.05`, actual: "no bodies", pass: false });
      } else {
        const min = [0, 1, 2].map((i) => Math.min(...bodies.map((b) => b.bbox_min[i]!)));
        const max = [0, 1, 2].map((i) => Math.max(...bodies.map((b) => b.bbox_max[i]!)));
        const size = bboxSize({ bbox_min: min as [number, number, number], bbox_max: max as [number, number, number] });
        const pass = e.bbox_size.length === 3 && size.every((s, i) => Math.abs(s - e.bbox_size![i]!) <= 0.05);
        out.push({ feature: e.feature, check: "bbox_size", expected: `≈ ${dims(e.bbox_size)} ±0.05`, actual: dims(size), pass });
      }
    }
  }
  return out;
}
