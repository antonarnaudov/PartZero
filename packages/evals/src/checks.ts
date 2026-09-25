/**
 * The hidden-test DSL: every test is **a measurement** (`check` + parameters) and **an
 * expectation** (one comparator: `eq`, `approx` ± `abs`/`rel`, `between`, `gte`, `lte`).
 *
 * Measurements are taken on the candidate's `aicad.metrics/0` report (model and body checks) or
 * on its compiled IR (IR checks). `"$context"` as the expected value means "the same measurement
 * on the T4 context model". `hole_pattern` / `hole_positions` are predicates without a comparator.
 *
 * The IR checks see **full circles**: a `circle` curve, or a closed loop of arcs on one circle (a
 * hole drawn as two semicircles counts as one circle, not as two arcs).
 *
 * **IR v1 models** (tasks that require `ir/1`) carry their `aicad.metrics/1` report and v1 IR in
 * {@link Subject.v1}: model and body checks measure the v0-shaped view of the report (the final
 * bodies of each part), the hole checks see hole feature instances and pattern copies as well as
 * sketch circles (`v1/subject.ts`), and the v1-only checks ({@link V1_CHECKS}) read the report's
 * per-feature summaries, parameters, references and warnings. `param` re-evaluates the candidate
 * with parameters set: the pipeline evaluates those variants before the tests run
 * ({@link CheckContext.variants}).
 */
import type { BodyMetrics, EvalReport, IrDocument } from "@aicad/ir-types";
import { canonicalJson } from "./hash.js";
import { circlesOf, curveChanges, featureChanges, featureNames, logicalCurves, sketchesOf, type CircleInfo, type V3 } from "./ir-geom.js";
import { CONTEXT_REF, testScorability, V1_CHECKS, type Axis, type BodyCondition, type CheckName, type HiddenTest, type HoleFilter, type NestedTest, type Range, type Scorability } from "./task.js";
import { blendsV1, circlesV1, curvesV1, holesV1, paramChanges, refChanges, shellsV1, type HoleInstance, type SubjectV1 } from "./v1/subject.js";

/** What a check can look at: an engine report and (for IR checks) the compiled IR. */
export interface Subject {
  /** The report (for an IR v1 model: the v0-shaped view of its v1 report, `v0ViewOfV1`). */
  report: EvalReport;
  /** The compiled IR v0 (null for IR v1 models and candidates that did not compile). */
  ir: IrDocument | null;
  /** IR v1 models: the `aicad.metrics/1` report and the compiled v1 IR. */
  v1?: SubjectV1 | undefined;
}

/** A `param` variant: the candidate re-evaluated with some parameters set. */
export type VariantOutcome = { ok: true; subject: Subject } | { ok: false; reason: string };

export interface CheckContext {
  candidate: Subject;
  /** T4: the context model, for `"$context"` and `changed_*` checks. */
  context?: Subject | undefined;
  /** `param` tests: the candidate's variants, keyed by {@link variantKey} of the `set`. */
  variants?: ReadonlyMap<string, VariantOutcome> | undefined;
}

/** The key of a `param` test's variant in {@link CheckContext.variants}. */
export function variantKey(set: Readonly<Record<string, number | boolean>>): string {
  return canonicalJson(set);
}

export type Value = number | string | boolean | number[] | string[];
/** A measurement; `detail` explains it when the test fails (e.g. which references changed). */
type Measured = { ok: true; value: Value; detail?: string } | { ok: false; reason: string };

export interface TestResult {
  id: string;
  description: string;
  check: CheckName;
  /** What the test needs from a candidate (the STEP-scorable subset keeps `geometry`). */
  scorability?: Scorability;
  pass: boolean;
  /** Human-readable expectation, e.g. `≈ [5, 50, 50] ±0.1`. */
  expected: string;
  /** The measured value (absent when it could not be measured). */
  actual?: Value;
  /** Why the test failed (measurement problem or comparison detail). */
  message?: string;
}

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const DEFAULT_TOL = 0.05;

// ─── Bodies ────────────────────────────────────────────────────────────────────────────────

/** Bodies of all successful body-creating features, in report order. */
export function bodiesOf(report: EvalReport): BodyMetrics[] {
  return report.features.filter((f) => f.status === "ok").flatMap((f) => f.bodies ?? []);
}

/** Bodies sorted by volume, largest first (stable for ties). */
export function rankedBodies(report: EvalReport): BodyMetrics[] {
  return bodiesOf(report)
    .map((b, i) => ({ b, i }))
    .sort((p, q) => q.b.volume - p.b.volume || p.i - q.i)
    .map((p) => p.b);
}

function selectBodies(report: EvalReport, body: number | undefined): { ok: true; bodies: BodyMetrics[] } | { ok: false; reason: string } {
  if (body === undefined) return { ok: true, bodies: bodiesOf(report) };
  const ranked = rankedBodies(report);
  const b = body >= 0 ? ranked[body] : ranked[ranked.length + body];
  if (!b) return { ok: false, reason: `no body #${body} (the model has ${ranked.length} bodies)` };
  return { ok: true, bodies: [b] };
}

function unionBox(bodies: BodyMetrics[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const b of bodies) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, b.bbox_min[i]!);
      max[i] = Math.max(max[i]!, b.bbox_max[i]!);
    }
  }
  return { min, max };
}

function pickAxis(v: number[], axis: Axis | undefined): Value {
  return axis === undefined ? v : v[AXIS_INDEX[axis]]!;
}

/** A body measurement over a set of bodies (sum / union / mass-weighted, as appropriate). */
function measureBodies(check: string, bodies: BodyMetrics[], p: { type?: string | undefined; axis?: Axis | undefined }): Measured {
  switch (check) {
    case "valid":
      return { ok: true, value: bodies.length > 0 && bodies.every((b) => b.valid) };
    case "volume":
      return { ok: true, value: bodies.reduce((s, b) => s + b.volume, 0) };
    case "area":
      return { ok: true, value: bodies.reduce((s, b) => s + b.area, 0) };
    case "face_count":
      return { ok: true, value: bodies.reduce((s, b) => s + (p.type === undefined ? b.faces : (b.face_types[p.type] ?? 0)), 0) };
    case "edge_count":
      return { ok: true, value: bodies.reduce((s, b) => s + (p.type === undefined ? b.edges : (b.edge_types[p.type] ?? 0)), 0) };
  }
  if (bodies.length === 0) return { ok: false, reason: "the model has no bodies" };
  switch (check) {
    case "centroid": {
      const v = bodies.reduce((s, b) => s + b.volume, 0);
      const c = [0, 1, 2].map((i) => bodies.reduce((s, b) => s + b.volume * b.centroid[i]!, 0) / v);
      return { ok: true, value: pickAxis(c, p.axis) };
    }
    case "bbox_size": {
      const { min, max } = unionBox(bodies);
      return { ok: true, value: pickAxis([0, 1, 2].map((i) => max[i]! - min[i]!), p.axis) };
    }
    case "bbox_sorted": {
      const { min, max } = unionBox(bodies);
      return { ok: true, value: [0, 1, 2].map((i) => max[i]! - min[i]!).sort((a, b) => a - b) };
    }
    case "bbox_min":
      return { ok: true, value: pickAxis(unionBox(bodies).min, p.axis) };
    case "bbox_max":
      return { ok: true, value: pickAxis(unionBox(bodies).max, p.axis) };
  }
  return { ok: false, reason: `"${check}" is not a body measurement` };
}

// ─── Measurements ──────────────────────────────────────────────────────────────────────────

const NO_IR = "no IR available (the candidate did not compile)";

function needsV1(check: string): string {
  return `${check} measures IR v1 models only`;
}

/** The compiled IR of either version, for the checks that compare documents generically. */
function anyIr(s: Subject): IrDocument | null {
  return s.v1 ? (s.v1.doc as unknown as IrDocument | null) : s.ir;
}

function holeMatches(f: HoleFilter | undefined, h: HoleInstance): boolean {
  if (!f) return true;
  const r = h.hole;
  if (!r) return false;
  const inR = (x: number | null | undefined, range: Range | undefined) => range === undefined || (x !== null && x !== undefined && inRange(x, range));
  if (f.kind !== undefined && r.kind !== f.kind) return false;
  if (f.size !== undefined && r.size !== f.size) return false;
  if (!inR(r.d, f.d)) return false;
  if (f.through !== undefined && (r.depth === null) !== f.through) return false;
  if (!inR(r.depth, f.depth)) return false;
  if (!inR(r.cbore?.d, f.cbore_d) || !inR(r.cbore?.depth, f.cbore_depth)) return false;
  if (!inR(r.csink?.d, f.csink_d) || !inR(r.csink?.angle, f.csink_angle)) return false;
  if (!inR(r.insert?.d, f.insert_d) || !inR(r.insert?.depth, f.insert_depth)) return false;
  if (f.threaded !== undefined && (r.thread !== undefined) !== f.threaded) return false;
  if (!inR(r.thread?.pitch, f.thread_pitch)) return false;
  if (f.dir !== undefined) {
    const want = HOLE_DIR_VECTORS[f.dir];
    const a = h.axis;
    if (!a || a[0] * want[0] + a[1] * want[1] + a[2] * want[2] < 1 - 1e-9) return false;
  }
  return true;
}

const HOLE_DIR_VECTORS: Record<NonNullable<HoleFilter["dir"]>, V3> = {
  "+X": [1, 0, 0],
  "-X": [-1, 0, 0],
  "+Y": [0, 1, 0],
  "-Y": [0, -1, 0],
  "+Z": [0, 0, 1],
  "-Z": [0, 0, -1],
};

/** The v1-only measurements (the subject has a v1 report). */
function measureV1(t: HiddenTest | BodyCondition | NestedTest, v1: SubjectV1, ctx: CheckContext | undefined): Measured {
  const report = v1.report;
  switch (t.check) {
    case "hole_count": {
      const holes = holesV1(v1).filter((h) => h.source === "hole" && holeMatches(t.hole, h));
      const unsure = holes.find((h) => h.uncertain);
      if (unsure) return { ok: false, reason: `hole ${unsure.id} (Ø${fmtNum(unsure.diameter)}) may or may not exist: ${unsure.uncertain}` };
      return { ok: true, value: holes.length };
    }
    case "blend_edges": {
      let n = 0;
      for (const b of blendsV1(v1)) {
        if (b.type !== t.type) continue;
        if (t.size !== undefined) {
          if (!b.size.ok) return { ok: false, reason: `${b.type} ${b.feature}: ${b.size.reason}` };
          if (!inRange(b.size.value, t.size)) continue;
        }
        n += b.edges;
      }
      return { ok: true, value: n };
    }
    case "shell_thickness": {
      const shells = shellsV1(v1);
      if (shells.length === 0) return { ok: false, reason: "no shell feature succeeded" };
      let min = Infinity;
      for (const sh of shells) {
        if (!sh.thickness.ok) return { ok: false, reason: `shell ${sh.feature}: ${sh.thickness.reason}` };
        min = Math.min(min, sh.thickness.value);
      }
      return { ok: true, value: min };
    }
    case "shell_open_faces":
      return { ok: true, value: shellsV1(v1).reduce((n, sh) => n + sh.open, 0) };
    case "param_value": {
      const p = (report.params ?? []).find((x) => x.name === t.name);
      if (!p) return { ok: false, reason: `the model has no parameter named ${t.name}` };
      if (p.value === undefined || p.value === null) return { ok: false, reason: `parameter ${t.name} failed: ${p.error?.code ?? "no value"}` };
      return { ok: true, value: p.value as number | boolean };
    }
    case "param_count":
      return { ok: true, value: (report.params ?? []).filter((p) => t.type === undefined || p.unit === t.type).length };
    case "ref_stability": {
      // A reference without a capture re-evaluates its query and is `exact` whenever it
      // resolves (SPEC-v1 §5.7 step 2), so on a T4 edit stability is measured against the
      // context model: the same field of the same feature must resolve to the same keys.
      const changes = refChanges(v1, ctx?.context?.v1, t.type);
      const out: Measured = { ok: true, value: changes.length };
      if (changes.length > 0) out.detail = `unstable: ${changes.slice(0, 4).join("; ")}${changes.length > 4 ? `; … ${changes.length - 4} more` : ""}`;
      return out;
    }
    case "warning_count":
      // Always by code: an unfiltered count would include engine-internal notes (the oracle's
      // ORACLE_REPLAYED info) that differ between engines and that the differential leaves out.
      if (t.code === undefined) return { ok: false, reason: 'warning_count needs "code"' };
      return { ok: true, value: report.features.reduce((n, f) => n + (f.warnings ?? []).filter((w) => w.code === t.code).length, 0) };
    case "changed_params": {
      const base = ctx?.context?.v1?.doc;
      if (!v1.doc) return { ok: false, reason: NO_IR };
      if (!base) return { ok: false, reason: "no IR v1 context model to compare with" };
      return { ok: true, value: paramChanges(base, v1.doc).length };
    }
  }
  return { ok: false, reason: `"${t.check}" is not an IR v1 measurement` };
}

function inRange(x: number, r: Range | undefined): boolean {
  return r === undefined || (x >= r[0] - 1e-9 && x <= r[1] + 1e-9);
}

/** Take the measurement a test describes on one subject. */
export function measure(t: HiddenTest | BodyCondition | NestedTest, s: Subject, ctx?: CheckContext): Measured {
  const report = s.report;
  if ((V1_CHECKS as readonly string[]).includes(t.check)) {
    if (t.check === "param") {
      const v = variantOf(t as HiddenTest, ctx);
      if (!v.ok) return v;
      return measure((t as HiddenTest).test!, v.subject, { candidate: v.subject });
    }
    return s.v1 ? measureV1(t, s.v1, ctx) : { ok: false, reason: needsV1(t.check) };
  }
  switch (t.check) {
    case "status":
      return { ok: true, value: report.status };
    case "body_count":
      return { ok: true, value: bodiesOf(report).length };
    case "feature_count":
      return {
        ok: true,
        value: report.features.filter((f) => f.status === "ok" && (t.type === undefined || f.type === t.type)).length,
      };
    case "region_count":
      return { ok: true, value: report.features.reduce((n, f) => n + (f.regions?.length ?? 0), 0) };
    case "inner_loops":
      return { ok: true, value: report.features.reduce((n, f) => n + (f.regions ?? []).reduce((m, r) => m + r.loops - 1, 0), 0) };
    case "valid":
    case "volume":
    case "area":
    case "centroid":
    case "bbox_size":
    case "bbox_sorted":
    case "bbox_min":
    case "bbox_max":
    case "face_count":
    case "edge_count": {
      const sel = selectBodies(report, t.body);
      if (!sel.ok) return sel;
      return measureBodies(t.check, sel.bodies, t);
    }
    case "bodies_matching": {
      const where = (t as HiddenTest).where ?? [];
      const n = bodiesOf(report).filter((b) =>
        where.every((w) => {
          const m = measureBodies(w.check, [b], w);
          return m.ok && compare(w, m.value, expectedOf(w, s, ctx)).pass;
        }),
      ).length;
      return { ok: true, value: n };
    }
    case "curve_count": {
      if (s.v1) {
        if (!s.v1.doc) return { ok: false, reason: NO_IR };
        const curves = curvesV1(s.v1).filter(
          (c) => (t.kind === undefined || c.kind === t.kind) && (t.diameter === undefined || (c.diameter !== undefined && inRange(c.diameter, t.diameter))),
        );
        const unsure = curves.find((c) => c.uncertain);
        if (unsure) return { ok: false, reason: `a circle may or may not exist: ${unsure.uncertain}` };
        return { ok: true, value: curves.length };
      }
      if (!s.ir) return { ok: false, reason: NO_IR };
      // Logical curves: a full circle drawn as arcs counts once, as a circle.
      let n = 0;
      for (const sk of sketchesOf(s.ir)) {
        for (const c of logicalCurves(sk.sketch)) {
          if (t.kind !== undefined && c.kind !== t.kind) continue;
          if (t.diameter !== undefined && (c.diameter === undefined || !inRange(c.diameter, t.diameter))) continue;
          n++;
        }
      }
      return { ok: true, value: n };
    }
    case "feature_names": {
      const ir = anyIr(s);
      return ir ? { ok: true, value: featureNames(ir) } : { ok: false, reason: NO_IR };
    }
    case "changed_curves":
    case "changed_features": {
      const ir = anyIr(s);
      if (!ir) return { ok: false, reason: NO_IR };
      const base = ctx?.context ? anyIr(ctx.context) : null;
      if (!base) return { ok: false, reason: "no context model to compare with" };
      const changes = t.check === "changed_curves" ? curveChanges(base, ir) : featureChanges(base, ir);
      return { ok: true, value: changes.length };
    }
    case "hole_pattern":
    case "hole_positions":
      return { ok: false, reason: `${t.check} is a predicate` };
  }
  return { ok: false, reason: `unknown check "${t.check}"` };
}

/** The variant a `param` test measures, from the context. */
function variantOf(t: HiddenTest | NestedTest, ctx: CheckContext | undefined): { ok: true; subject: Subject } | { ok: false; reason: string } {
  if (!t.set) return { ok: false, reason: "param without set" };
  const v = ctx?.variants?.get(variantKey(t.set));
  if (!v) return { ok: false, reason: `the model was not re-evaluated with ${fmtSet(t.set)}` };
  return v;
}

function fmtSet(set: Readonly<Record<string, number | boolean>>): string {
  return Object.entries(set)
    .map(([k, v]) => `${k} = ${typeof v === "number" ? fmtNum(v) : String(v)}`)
    .join(", ");
}

// ─── Comparators ───────────────────────────────────────────────────────────────────────────

type Expected = { ok: true; value: unknown } | { ok: false; reason: string };

/** The expected value of a test, resolving `"$context"`. */
function expectedOf(t: HiddenTest | BodyCondition, s: Subject, ctx: CheckContext | undefined): Expected {
  const raw = t.eq ?? t.approx ?? t.between ?? t.gte ?? t.lte;
  if (raw !== CONTEXT_REF) return { ok: true, value: raw };
  if (!ctx?.context) return { ok: false, reason: `"$context" used without a context model` };
  if (s === ctx.context) return { ok: false, reason: `"$context" inside the context model` };
  const m = measure(t, ctx.context, ctx);
  return m.ok ? { ok: true, value: m.value } : { ok: false, reason: `on the context model: ${m.reason}` };
}

export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  const digits = a >= 1000 ? 1 : a >= 10 ? 3 : 4;
  return String(Number(x.toFixed(digits)));
}

export function fmtValue(v: unknown): string {
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(fmtValue).join(", ")}]`;
  return String(v);
}

function fmtTolerance(t: { abs?: number | undefined; rel?: number | undefined }): string {
  const parts: string[] = [];
  if (t.abs !== undefined) parts.push(fmtNum(t.abs));
  if (t.rel !== undefined) parts.push(`${fmtNum(t.rel * 100)}%`);
  return parts.length === 2 ? `±max(${parts.join(", ")})` : `±${parts[0] ?? "0"}`;
}

/** The expectation as text, e.g. `≈ 30.44 ±1%`, `in [2, 30]`, `≥ 1`, `= $context (…)`. */
export function describeExpectation(t: HiddenTest | BodyCondition, resolved?: unknown): string {
  const ctx = (raw: unknown, text: string) => (raw === CONTEXT_REF ? `${text} (context)` : text);
  if (t.eq !== undefined) return ctx(t.eq, `= ${fmtValue(t.eq === CONTEXT_REF ? resolved : t.eq)}`);
  if (t.approx !== undefined) return ctx(t.approx, `≈ ${fmtValue(t.approx === CONTEXT_REF ? resolved : t.approx)} ${fmtTolerance(t)}`);
  if (t.between !== undefined) return `in ${fmtValue(t.between)}`;
  if (t.gte !== undefined) return `≥ ${fmtNum(t.gte)}`;
  if (t.lte !== undefined) return `≤ ${fmtNum(t.lte)}`;
  return "?";
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  return a === b;
}

function asNumbers(v: unknown): number[] | null {
  if (typeof v === "number") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "number")) return v as number[];
  return null;
}

/** Apply the test's comparator to a measured value. */
function compare(t: HiddenTest | BodyCondition, actual: Value, expected: Expected): { pass: boolean; message?: string } {
  if (!expected.ok) return { pass: false, message: expected.reason };
  const e = expected.value;
  if (t.eq !== undefined) return deepEqual(actual, e) ? { pass: true } : { pass: false };
  if (t.approx !== undefined) {
    const a = asNumbers(actual);
    const x = asNumbers(e);
    if (!a || !x || a.length !== x.length || Array.isArray(actual) !== Array.isArray(e)) {
      return { pass: false, message: `cannot compare ${fmtValue(actual)} with ${fmtValue(e)}` };
    }
    const bad = a.findIndex((ai, i) => Math.abs(ai - x[i]!) > Math.max(t.abs ?? 0, (t.rel ?? 0) * Math.abs(x[i]!)));
    if (bad < 0) return { pass: true };
    return a.length > 1 ? { pass: false, message: `element ${bad} is off by ${fmtNum(a[bad]! - x[bad]!)}` } : { pass: false };
  }
  if (t.between !== undefined) {
    const a = asNumbers(actual);
    const ranges = (Array.isArray(t.between[0]) ? t.between : [t.between]) as Range[];
    if (!a || a.length !== ranges.length) return { pass: false, message: `cannot compare ${fmtValue(actual)} with ${ranges.length} range(s)` };
    return a.every((ai, i) => ai >= ranges[i]![0] && ai <= ranges[i]![1]) ? { pass: true } : { pass: false };
  }
  if (typeof actual !== "number") return { pass: false, message: `${fmtValue(actual)} is not a number` };
  if (t.gte !== undefined) return { pass: actual >= t.gte };
  if (t.lte !== undefined) return { pass: actual <= t.lte };
  return { pass: false, message: "no comparator" };
}

// ─── Predicates ────────────────────────────────────────────────────────────────────────────

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, (a[2] ?? 0) - (b[2] ?? 0));
}

/** Distance from point `p` to the line through `o` with unit direction `d`. */
function distToAxis(p: readonly number[], o: V3, d: V3): number {
  const v = [p[0]! - o[0], p[1]! - o[1], (p[2] ?? 0) - o[2]];
  const t = v[0]! * d[0] + v[1]! * d[1] + v[2]! * d[2];
  return Math.hypot(v[0]! - t * d[0], v[1]! - t * d[1], v[2]! - t * d[2]);
}

function pairwise(points: readonly (readonly number[])[]): number[] {
  const d: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) d.push(dist(points[i]!, points[j]!));
  return d.sort((a, b) => a - b);
}

function predicateExpectation(t: HiddenTest): string {
  const tol = t.tol ?? DEFAULT_TOL;
  const range = t.diameter ?? [0, 0];
  const points = t.points ?? [];
  const holes = t.circles === "all" ? "circles (holes, bosses, pins)" : "holes";
  if (t.check === "hole_pattern") return `${points.length} ${holes} Ø${fmtValue(range)} with pairwise spacing ${fmtValue(pairwise(points))} ±${fmtNum(tol)}`;
  if (t.relative_to === "edges") return `${points.length} ${holes} Ø${fmtValue(range)} at ${fmtValue(points)} mm from the nearest edges ±${fmtNum(tol)}`;
  if (t.entry === true) return `${points.length} ${holes} Ø${fmtValue(range)} opening at ${fmtValue(points)} ±${fmtNum(tol)}`;
  return `${points.length} ${holes} Ø${fmtValue(range)} with axes through ${fmtValue(points)} ±${fmtNum(tol)}`;
}

const AXIS_NAMES = ["X", "Y", "Z"] as const;

/**
 * Where a hole sits on the part, independent of placement and orientation: the distances from
 * its axis to the nearest side of the bounding box along each of the two directions across the
 * hole, smallest first. The hole axis must be parallel to X, Y or Z (the box sides are then the
 * part's edges for a rectangular outline).
 */
/** What the hole predicates need of a hole: a sketch circle (v0, v1) or a hole instance (v1). */
type HoleLike = Pick<CircleInfo, "id" | "diameter" | "center3" | "axis">;

function edgeOffsets(c: HoleLike, box: { min: number[]; max: number[] }): [number, number] | string {
  const k = [0, 1, 2].find((i) => Math.abs(c.axis[i]!) >= 1 - 1e-9);
  if (k === undefined) return `hole ${c.id} has an axis that is not parallel to X, Y or Z`;
  const [a, b] = [0, 1, 2]
    .filter((i) => i !== k)
    .map((i) => Math.min(c.center3[i]! - box.min[i]!, box.max[i]! - c.center3[i]!)) as [number, number];
  return a <= b ? [a, b] : [b, a];
}

/** `hole_positions` with `relative_to: "edges"`: each expected [a, b] offset pair matches a distinct hole. */
function holeEdgePredicate(t: HiddenTest, s: Subject, found: HoleLike[], base: Pick<TestResult, "id" | "description" | "check">): TestResult {
  const tol = t.tol ?? DEFAULT_TOL;
  const expectedText = predicateExpectation(t);
  const sel = selectBodies(s.report, t.body);
  if (!sel.ok) return { ...base, pass: false, expected: expectedText, message: sel.reason };
  if (sel.bodies.length === 0) return { ...base, pass: false, expected: expectedText, message: "the model has no bodies" };
  const box = unionBox(sel.bodies);
  const offsets: [number, number][] = [];
  for (const c of found) {
    const o = edgeOffsets(c, box);
    if (typeof o === "string") return { ...base, pass: false, expected: expectedText, message: o };
    offsets.push(o);
  }
  const rounded = offsets.map((o) => o.map((x) => Number(x.toFixed(4))));
  const unused = new Set(offsets.map((_, i) => i));
  for (const p of t.points!) {
    const want = p[0]! <= p[1]! ? [p[0]!, p[1]!] : [p[1]!, p[0]!];
    let best = -1;
    let bestD = Infinity;
    for (const i of unused) {
      const d = Math.max(Math.abs(offsets[i]![0] - want[0]!), Math.abs(offsets[i]![1] - want[1]!));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0 || bestD > tol) {
      const along = AXIS_NAMES.filter((_, i) => Math.abs(found[0]?.axis[i] ?? 0) < 1 - 1e-9).join("/");
      return {
        ...base,
        pass: false,
        expected: expectedText,
        actual: rounded.flat(),
        message: `no hole ${fmtValue(want)} mm from the nearest edges (±${fmtNum(tol)}, measured along ${along}); found ${fmtValue(rounded)}`,
      };
    }
    unused.delete(best);
  }
  return { ...base, pass: true, expected: expectedText, actual: rounded.flat() };
}

/** The expectation of a test as text, without measuring anything (`"$context"` stays symbolic). */
export function describeTest(t: HiddenTest): string {
  if (t.check === "param" && t.test) return `with ${fmtSet(t.set ?? {})}: ${t.test.check} ${describeTest({ ...t.test, id: t.id, description: t.description })}`;
  if (t.check === "hole_pattern" || t.check === "hole_positions") return predicateExpectation(t);
  const e = describeExpectation(t, CONTEXT_REF);
  return t.check === "bodies_matching" ? `${e} bodies with ${(t.where ?? []).map((w) => `${w.check} ${describeExpectation(w)}`).join(", ")}` : e;
}

/** `; circles present: Ø3.74 ×4, Ø22 ×1` — a repair hint when a hole check finds the wrong count. */
function diameterCensus(circles: readonly { diameter: number }[]): string {
  if (circles.length === 0) return "; the model has no circles";
  const counts = new Map<number, number>();
  for (const c of circles) {
    const d = Number(c.diameter.toFixed(3));
    counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  const parts = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `Ø${fmtNum(d)} ×${n}`);
  return `; circles present: ${parts.join(", ")}`;
}

/**
 * The holes an IR v1 model's hole checks see (hole instances, the circles sweeps leave as holes,
 * pattern copies; with `circles: "all"` every swept circle), or the reason one with a diameter
 * in `range` has no position.
 */
function holesOfV1(v1: SubjectV1, range: Range, circles: HiddenTest["circles"]): { all: { diameter: number }[]; found: HoleLike[] } | string {
  const holes = circles === "all" ? circlesV1(v1) : holesV1(v1);
  const found: HoleLike[] = [];
  for (const h of holes) {
    if (!inRange(h.diameter, range)) continue;
    if (h.uncertain) return `hole ${h.id} (Ø${fmtNum(h.diameter)}) may or may not exist: ${h.uncertain}`;
    if (!h.center || !h.axis) return `hole ${h.id} (Ø${fmtNum(h.diameter)}) has no position: ${h.unplaced ?? "unknown"}`;
    found.push({ id: h.id, diameter: h.diameter, center3: h.center, axis: h.axis });
  }
  return { all: holes, found };
}

function holePredicate(t: HiddenTest, s: Subject): TestResult {
  const base = { id: t.id, description: t.description, check: t.check };
  const tol = t.tol ?? DEFAULT_TOL;
  const range = t.diameter!;
  const points = t.points!;
  const expectedText = predicateExpectation(t);
  let all: { diameter: number }[];
  let found: HoleLike[];
  if (s.v1) {
    if (!s.v1.doc) return { ...base, pass: false, expected: expectedText, message: NO_IR };
    const h = holesOfV1(s.v1, range, t.circles);
    if (typeof h === "string") return { ...base, pass: false, expected: expectedText, message: h };
    ({ all, found } = h);
  } else {
    if (!s.ir) return { ...base, pass: false, expected: expectedText, message: NO_IR };
    const circles = circlesOf(s.ir);
    all = circles;
    found = circles.filter((c) => inRange(c.diameter, range));
  }
  const centers: V3[] = found.map((c) => c.center3);
  const roundedCenters = centers.map((c) => c.map((x) => Number(x.toFixed(6))));
  if (found.length !== points.length) {
    return {
      ...base,
      pass: false,
      expected: expectedText,
      actual: found.length,
      message: `found ${found.length} circle(s) with a diameter in ${fmtValue(range)}, expected ${points.length}${diameterCensus(all)}`,
    };
  }
  if (t.check === "hole_positions" && t.relative_to === "edges") return holeEdgePredicate(t, s, found, base);
  if (t.check === "hole_pattern") {
    const want = pairwise(points);
    const got = pairwise(centers);
    const bad = got.findIndex((g, i) => Math.abs(g - want[i]!) > tol);
    return bad < 0
      ? { ...base, pass: true, expected: expectedText, actual: got }
      : { ...base, pass: false, expected: expectedText, actual: got, message: `hole spacing ${fmtNum(got[bad]!)} should be ${fmtNum(want[bad]!)}` };
  }
  // hole_positions: each expected point must lie on the axis of a distinct hole (greedy nearest).
  // The axis, not the sketched circle, is the hole: it may be sketched on either face of a plate.
  // With `entry`, the point is where the hole opens (its entry point), compared in 3D.
  const unused = new Set(centers.map((_, i) => i));
  for (const p of points) {
    let best = -1;
    let bestD = Infinity;
    for (const i of unused) {
      const d = t.entry === true ? dist(p, centers[i]!) : distToAxis(p, centers[i]!, found[i]!.axis);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best < 0 || bestD > tol) {
      return {
        ...base,
        pass: false,
        expected: expectedText,
        actual: roundedCenters.flat(),
        message: `no hole ${t.entry === true ? "opening" : "axis"} within ${fmtNum(tol)} mm of ${fmtValue(p)} (found ${t.entry === true ? "entry points" : "centres"} ${fmtValue(roundedCenters)})`,
      };
    }
    unused.delete(best);
  }
  return { ...base, pass: true, expected: expectedText, actual: roundedCenters.flat() };
}

// ─── Entry points ──────────────────────────────────────────────────────────────────────────

/**
 * `param`: the nested test on the candidate re-evaluated with `set`. The variant must evaluate
 * with status ok (a failed feature fails the test) unless the nested test measures `status`.
 */
function paramTest(t: HiddenTest, ctx: CheckContext): TestResult {
  const base = { id: t.id, description: t.description, check: t.check };
  const inner: HiddenTest = { ...t.test!, id: t.id, description: t.description };
  const expected = describeTest(t);
  const v = variantOf(t, ctx);
  if (!v.ok) return { ...base, pass: false, expected, message: v.reason };
  const r = v.subject.report;
  if (inner.check !== "status" && r.status !== "ok") {
    const failed = r.features.filter((f) => f.status !== "ok").map((f) => `${f.feature} ${f.error?.code ?? "error"}`);
    return { ...base, pass: false, expected, message: `with ${fmtSet(t.set ?? {})} the model evaluates with errors: ${failed.join(", ") || r.error?.code || "status error"}` };
  }
  const res = evaluateTest(inner, { candidate: v.subject });
  const out: TestResult = { ...base, pass: res.pass, expected };
  if (res.actual !== undefined) out.actual = res.actual;
  if (res.message !== undefined) out.message = `with ${fmtSet(t.set ?? {})}: ${res.message}`;
  return out;
}

/** Evaluate one hidden test on the candidate. Never throws. */
export function evaluateTest(t: HiddenTest, ctx: CheckContext): TestResult {
  const r = evaluateUntagged(t, ctx);
  return { ...r, scorability: testScorability(t) };
}

function evaluateUntagged(t: HiddenTest, ctx: CheckContext): TestResult {
  if (t.check === "param") return paramTest(t, ctx);
  if (t.check === "hole_pattern" || t.check === "hole_positions") return holePredicate(t, ctx.candidate);
  const base = { id: t.id, description: t.description, check: t.check };
  const expected = expectedOf(t, ctx.candidate, ctx);
  const expectedText = describeExpectation(t, expected.ok ? expected.value : undefined);
  const m = measure(t, ctx.candidate, ctx);
  if (!m.ok) return { ...base, pass: false, expected: expectedText, message: m.reason };
  const r = compare(t, m.value, expected);
  const out: TestResult = { ...base, pass: r.pass, expected: expectedText, actual: m.value };
  const message = [r.message, r.pass ? undefined : m.detail].filter((x) => x !== undefined).join("; ");
  if (message !== "") out.message = message;
  return out;
}

export function evaluateTests(tests: readonly HiddenTest[], ctx: CheckContext): TestResult[] {
  return tests.map((t) => evaluateTest(t, ctx));
}
