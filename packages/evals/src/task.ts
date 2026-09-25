/**
 * MakerBench tasks: the on-disk format (`<id>.task.json`, see `schema/makerbench-task.schema.json`),
 * loading, and validation (JSON Schema + semantic checks the schema cannot express).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { schemaPath } from "./paths.js";

export type Tier = "T1" | "T2" | "T4" | "T5";
/** Tiers in report order. */
export const TIERS: readonly Tier[] = ["T1", "T2", "T4", "T5"];
export type Process = "fdm" | "cnc" | "laser" | "any";

export type Axis = "x" | "y" | "z";
export type Range = [number, number];

/** Checks on the whole model (report level). */
export const MODEL_CHECKS = ["status", "valid", "body_count", "feature_count", "region_count", "inner_loops"] as const;
/** Checks on bodies: all bodies together, or one body chosen with `body`. */
export const BODY_CHECKS = [
  "volume",
  "area",
  "centroid",
  "bbox_size",
  "bbox_sorted",
  "bbox_min",
  "bbox_max",
  "face_count",
  "edge_count",
] as const;
/** Checks on the candidate's compiled IR (not on the report). */
export const IR_CHECKS = [
  "curve_count",
  "hole_pattern",
  "hole_positions",
  "feature_names",
  "changed_curves",
  "changed_features",
] as const;
/** The IR v0 check vocabulary (every check that also measures `aicad.metrics/0` models). */
export const CHECKS = [...MODEL_CHECKS, ...BODY_CHECKS, "bodies_matching", ...IR_CHECKS] as const;
/**
 * Checks of IR v1 models only (tasks that require `ir/1`): hole instances with their preset
 * dimensions (`holes` of the report, pattern copies included), fillets and chamfers, shells,
 * parameters (value, count, and `param`: set parameters, re-evaluate, measure), reference
 * stability and warnings, and the parameter diff of a T4 edit.
 */
export const V1_CHECKS = [
  "hole_count",
  "blend_edges",
  "shell_thickness",
  "shell_open_faces",
  "param_value",
  "param_count",
  "param",
  "ref_stability",
  "warning_count",
  "changed_params",
] as const;
/** Every check name ({@link CHECKS} and {@link V1_CHECKS}). */
export const ALL_CHECKS = [...CHECKS, ...V1_CHECKS] as const;

/**
 * What a hidden test needs from a candidate, for the **STEP-scorable** MakerBench subset
 * (ARCHITECTURE "Public benchmarks": checks that depend on our IR or on seam conventions are
 * seam-normalized or dropped, and each normalization is published):
 * - `geometry`: measurable on any tool's exact geometry (volume, area, centroid, boxes, body
 *   counts and validity; hole axes and entry points, which a STEP scorer reads off cylinder
 *   faces);
 * - `seam`: face and edge counts, which depend on seam and face-splitting conventions;
 * - `ir`: needs our IR or `aicad.metrics` report — curve counts, feature history, parameters,
 *   and the IR v1 checks that read how the model was **built** (hole presets from hole features,
 *   blend sizes from fillet/chamfer features, shell thickness from the shell feature, references,
 *   warnings). A correct part built another way (a counterbore cut with extrudes, a box hollowed
 *   with a pocket) fails these; tasks pair them with `geometry` tests (tested in
 *   `v1-tasks.test.ts`).
 */
export type Scorability = "geometry" | "seam" | "ir";
export const SCORABILITIES: readonly Scorability[] = ["geometry", "seam", "ir"];

const GEOMETRY_CHECKS: readonly string[] = ["status", "valid", "body_count", ...BODY_CHECKS, "hole_pattern", "hole_positions"];
const SEAM_CHECKS: readonly string[] = ["face_count", "edge_count"];

/** The {@link Scorability} of a hidden test (a `bodies_matching` test: the least scorable of its conditions). */
export function testScorability(t: Pick<HiddenTest, "check" | "where">): Scorability {
  if (t.check === "bodies_matching") {
    const ws = (t.where ?? []).map((w) => testScorability(w));
    return ws.includes("ir") ? "ir" : ws.includes("seam") ? "seam" : "geometry";
  }
  if (SEAM_CHECKS.includes(t.check)) return "seam";
  if (GEOMETRY_CHECKS.includes(t.check)) return "geometry";
  return "ir";
}
export type CheckName = (typeof ALL_CHECKS)[number];
export type V1CheckName = (typeof V1_CHECKS)[number];
export type BodyCheckName = (typeof BODY_CHECKS)[number] | "valid";

export const FACE_TYPES = ["plane", "cylinder", "cone", "sphere", "torus", "bspline", "other"] as const;
export const EDGE_TYPES = ["line", "circle", "ellipse", "bspline", "other"] as const;
export const FEATURE_TYPES = ["sketch", "extrude", "revolve"] as const;
/** IR v1 feature types (SPEC-v1 §6), for `feature_count` and `ref_stability` on v1 tasks. */
export const FEATURE_TYPES_V1 = [
  "sketch",
  "extrude",
  "revolve",
  "boolean",
  "hole",
  "fillet",
  "chamfer",
  "shell",
  "draft",
  "pattern",
  "datum_plane",
  "datum_axis",
  "tag",
] as const;
export const HOLE_KINDS = ["simple", "counterbore", "countersink", "insert"] as const;
export const HOLE_SIZES = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"] as const;
/** Drilling directions a {@link HoleFilter} can require (SPEC-v1 §6.5 `d`). */
export const HOLE_DIRS = ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] as const;
export const PARAM_UNITS = ["mm", "deg", "ratio", "count", "bool"] as const;
export const BLEND_TYPES = ["fillet", "chamfer"] as const;

/** The `"$context"` placeholder: the same measurement taken on the T4 context model. */
export const CONTEXT_REF = "$context";
export type ContextRef = typeof CONTEXT_REF;

/** Comparator fields shared by every test. Exactly one of eq / approx / between / gte / lte. */
export interface Comparator {
  eq?: number | string | boolean | unknown[] | ContextRef;
  approx?: number | number[] | ContextRef;
  abs?: number;
  rel?: number;
  between?: Range | Range[];
  gte?: number;
  lte?: number;
}

/**
 * `hole_count`: which hole instances count (all of them when absent). Every given field must
 * match; ranges are inclusive, mm or degrees.
 */
export interface HoleFilter {
  kind?: (typeof HOLE_KINDS)[number];
  size?: (typeof HOLE_SIZES)[number];
  /** Hole diameter. */
  d?: Range;
  /** `true`: through holes only; `false`: blind (and insert) holes only. */
  through?: boolean;
  /** Blind depth (to the shoulder). */
  depth?: Range;
  cbore_d?: Range;
  cbore_depth?: Range;
  csink_d?: Range;
  csink_angle?: Range;
  insert_d?: Range;
  insert_depth?: Range;
  /** `true`: holes with a cosmetic thread only; `false`: without. */
  threaded?: boolean;
  thread_pitch?: Range;
  /**
   * The drilling direction `d` (into the material from the entry face): `-Z` = drilled downward
   * from above, `+Z` = upward from below. Pattern copies carry their transformed direction.
   */
  dir?: (typeof HOLE_DIRS)[number];
}

/** `param`: the test measured on the model re-evaluated with the parameters set. */
export interface NestedTest extends Comparator, CheckParams {
  check: CheckName;
  where?: BodyCondition[];
}

export interface CheckParams {
  type?: string;
  axis?: Axis;
  body?: number;
  kind?: "line" | "arc" | "circle";
  diameter?: Range;
  points?: number[][];
  tol?: number;
  /** hole_positions: `"model"` (default) = 3D model points on the hole axes; `"edges"` = [a, b] offsets from the part's edges. */
  relative_to?: "model" | "edges";
  /**
   * hole_positions with model points: each point is where a distinct hole **opens** (its entry
   * point, compared in 3D), not just a point on its axis — so the side it is drilled from counts.
   */
  entry?: boolean;
  /**
   * hole_positions / hole_pattern on IR v1 models: `"holes"` (default) = hole feature instances
   * and the circles sweeps leave as holes; `"all"` = every full circle that makes geometry (bosses,
   * pins and beads too) and every hole instance. IR v0 checks see every sketch circle either way.
   */
  circles?: "holes" | "all";
  /** hole_count: which holes count. */
  hole?: HoleFilter;
  /** blend_edges: the fillet radius or chamfer distance range, mm. */
  size?: Range;
  /** param_value: the parameter's name. */
  name?: string;
  /** param: parameter values to set (literals) before re-evaluating. */
  set?: Record<string, number | boolean>;
  /** param: the test to run on the re-evaluated model. */
  test?: NestedTest;
  /** warning_count: only warnings with this code. */
  code?: string;
}

/** A per-body condition inside `bodies_matching.where`. */
export interface BodyCondition extends Comparator, CheckParams {
  check: BodyCheckName;
}

export interface HiddenTest extends Comparator, CheckParams {
  id: string;
  /** Plain-words meaning of the test, shown in reports. */
  description: string;
  check: CheckName;
  where?: BodyCondition[];
}

export interface Clarify {
  questions: string[];
  assumptions: string;
}

/** A task file as stored on disk. */
export interface TaskFile {
  $schema?: string;
  id: string;
  tier: Tier;
  title: string;
  prompt: string;
  context?: string;
  process: Process;
  tags: string[];
  requires: string[];
  reference: string;
  hidden_tests: HiddenTest[];
  clarify?: Clarify;
  notes?: string;
}

/** A task with its files read. */
export interface LoadedTask extends TaskFile {
  /** Absolute path of the `.task.json` file. */
  file: string;
  referenceSource: string;
  contextSource?: string;
}

/** What a solver may see: no reference, no hidden tests. */
export interface PublicTask {
  id: string;
  tier: Tier;
  title: string;
  prompt: string;
  process: Process;
  tags: string[];
  /** T4: the CadScript source to edit. */
  context?: string;
}

export function publicTask(task: LoadedTask): PublicTask {
  const p: PublicTask = {
    id: task.id,
    tier: task.tier,
    title: task.title,
    prompt: task.prompt,
    process: task.process,
    tags: [...task.tags],
  };
  if (task.contextSource !== undefined) p.context = task.contextSource;
  return p;
}

export const TASK_FILE_SUFFIX = ".task.json";

/** Capabilities of an IR v0 engine (Forge F0 / the oracle today). */
export const IR0_CAPABILITIES: readonly string[] = [
  "ir/0",
  "feature/sketch",
  "feature/extrude",
  "feature/revolve",
  "sketch/line",
  "sketch/arc",
  "sketch/circle",
  "plane/frame",
  "multi-part",
];

/**
 * Capabilities of an IR v1 engine (Forge's v1 pipeline, the oracle's v1 pipeline): IR v0's plus
 * `ir/1` and the Phase C operations. `op/draft` is optional in v1 (SPEC-v1 §6.9) and Forge
 * rejects it, so it is not listed.
 */
export const IR1_CAPABILITIES: readonly string[] = [
  ...IR0_CAPABILITIES,
  "ir/1",
  "op/boolean",
  "op/hole",
  "op/fillet",
  "op/chamfer",
  "op/shell",
  "op/pattern",
  "sketch/constraints",
  "plane/datum",
];

/**
 * The IR v1 capability tokens a compiled document uses (a task's `requires` must list them, so
 * capability filtering never schedules its reference on an engine that cannot evaluate it):
 * `ir/1`; `op/hole`, `op/fillet`, `op/chamfer`, `op/shell`, `op/pattern`, `op/draft` for those
 * features; `op/boolean` for a `boolean` feature, an extrude or revolve whose `op` is not
 * `new_body`, and a `join` pattern; `sketch/constraints` for a sketch with constraints;
 * `plane/datum` for datum features; `multi-part` for more than one part.
 */
export function capabilitiesUsedV1(doc: { parts: readonly { features: readonly unknown[] }[] }): string[] {
  const out = new Set<string>(["ir/1"]);
  if (doc.parts.length > 1) out.add("multi-part");
  for (const part of doc.parts) {
    for (const raw of part.features) {
      const f = raw as Record<string, unknown>;
      const type = String(f["type"]);
      if (["hole", "fillet", "chamfer", "shell", "pattern", "draft"].includes(type)) out.add(`op/${type}`);
      if (type === "boolean") out.add("op/boolean");
      if ((type === "extrude" || type === "revolve") && f["op"] !== undefined && f["op"] !== "new_body") out.add("op/boolean");
      if (type === "pattern" && f["op"] === "join") out.add("op/boolean");
      if (type === "sketch" && Array.isArray(f["constraints"]) && f["constraints"].length > 0) out.add("sketch/constraints");
      if (type === "datum_plane" || type === "datum_axis") out.add("plane/datum");
    }
  }
  return [...out].sort();
}

/** True for tasks written in CadScript v1 (they require `ir/1`): compiled and evaluated with the IR v1 pipeline. */
export function isV1Task(task: Pick<TaskFile, "requires">): boolean {
  return task.requires.includes("ir/1");
}

/** True when every requirement of the task is in `capabilities`. */
export function isSupported(task: Pick<TaskFile, "requires">, capabilities: readonly string[]): boolean {
  return task.requires.every((r) => capabilities.includes(r));
}

// ─── Schema validation ─────────────────────────────────────────────────────────────────────

let validator: ValidateFunction | undefined;

function schemaValidator(): ValidateFunction {
  if (!validator) {
    const schema = JSON.parse(readFileSync(schemaPath(), "utf8")) as object;
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    validator = ajv.compile(schema);
  }
  return validator;
}

function formatAjvError(e: ErrorObject): string {
  const where = e.instancePath || "/";
  const extra =
    e.keyword === "unevaluatedProperties" || e.keyword === "additionalProperties"
      ? ` (${JSON.stringify(e.params)})`
      : e.keyword === "enum"
        ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
        : "";
  return `${where}: ${e.message ?? e.keyword}${extra}`;
}

/** Validate a parsed task value against `makerbench-task.schema.json`. Returns problems (empty = valid). */
export function schemaProblems(value: unknown): string[] {
  const v = schemaValidator();
  if (v(value)) return [];
  return (v.errors ?? []).map(formatAjvError);
}

let hiddenTestValidator: ValidateFunction | undefined;

/** The schema's `#/$defs/hiddenTest` on its own (same Ajv settings as the task validator). */
function hiddenTestSchemaValidator(): ValidateFunction {
  if (!hiddenTestValidator) {
    const schema = JSON.parse(readFileSync(schemaPath(), "utf8")) as { $id: string };
    const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true });
    ajv.addSchema(schema);
    const v = ajv.getSchema(`${schema.$id}#/$defs/hiddenTest`);
    if (!v) throw new Error("makerbench-task.schema.json has no #/$defs/hiddenTest");
    hiddenTestValidator = v;
  }
  return hiddenTestValidator;
}

/**
 * Validate hidden tests on their own, outside a task file: the JSON Schema for one test plus the
 * semantic checks of {@link semanticProblems} (one comparator, allowed parameters, vector/scalar,
 * `$context` only with a context model) and unique ids. For agents that write executable tests in
 * the same DSL (the spec writer). The v1-only checks ({@link V1_CHECKS}) are accepted with
 * `v1: true` (tests of an IR v1 model). Problems are prefixed with `tests[i] (id)`; empty = valid.
 */
export function testProblems(tests: readonly unknown[], options: { hasContext?: boolean; v1?: boolean } = {}): string[] {
  const out: string[] = [];
  const v = hiddenTestSchemaValidator();
  const ids = new Set<string>();
  tests.forEach((t, i) => {
    const id = typeof t === "object" && t !== null && typeof (t as { id?: unknown }).id === "string" ? (t as { id: string }).id : "?";
    const at = `tests[${i}] (${id})`;
    if (!v(t)) {
      for (const e of v.errors ?? []) out.push(`${at}${e.instancePath}: ${formatAjvError(e).replace(/^[^:]*: /, "")}`);
      return;
    }
    if (ids.has(id)) out.push(`${at}: duplicate id "${id}"`);
    ids.add(id);
    out.push(...checkProblems(t as HiddenTest, at, { hasContext: options.hasContext ?? false, nested: false, v1: options.v1 ?? false }));
  });
  return out;
}

// ─── Semantic validation ───────────────────────────────────────────────────────────────────

const COMPARATOR_KEYS = ["eq", "approx", "between", "gte", "lte"] as const;
/** Checks without a comparator: predicates, and `param` (its nested test has the comparator). */
const PREDICATE_CHECKS: readonly CheckName[] = ["hole_pattern", "hole_positions"];
const AXIS_CHECKS: readonly string[] = ["centroid", "bbox_size", "bbox_min", "bbox_max"];
const VECTOR_CHECKS: readonly string[] = ["centroid", "bbox_size", "bbox_sorted", "bbox_min", "bbox_max"];
const CONTEXT_CHECKS: readonly CheckName[] = ["changed_curves", "changed_features", "changed_params"];

const ALLOWED_PARAMS: Record<string, readonly (keyof CheckParams | "where")[]> = {
  status: [],
  valid: ["body"],
  body_count: [],
  feature_count: ["type"],
  region_count: [],
  inner_loops: [],
  volume: ["body"],
  area: ["body"],
  centroid: ["body", "axis"],
  bbox_size: ["body", "axis"],
  bbox_sorted: ["body"],
  bbox_min: ["body", "axis"],
  bbox_max: ["body", "axis"],
  face_count: ["body", "type"],
  edge_count: ["body", "type"],
  bodies_matching: ["where"],
  curve_count: ["kind", "diameter"],
  hole_pattern: ["diameter", "points", "tol", "circles"],
  hole_positions: ["diameter", "points", "tol", "relative_to", "body", "entry", "circles"],
  feature_names: [],
  changed_curves: [],
  changed_features: [],
  hole_count: ["hole"],
  blend_edges: ["type", "size"],
  shell_thickness: [],
  shell_open_faces: [],
  param_value: ["name"],
  param_count: ["type"],
  param: ["set", "test"],
  ref_stability: ["type"],
  warning_count: ["code"],
  changed_params: [],
};
const ALL_PARAMS = ["type", "axis", "body", "kind", "diameter", "points", "tol", "relative_to", "entry", "circles", "where", "hole", "size", "name", "set", "test", "code"] as const;
const HOLE_FILTER_RANGES = ["d", "depth", "cbore_d", "cbore_depth", "csink_d", "csink_angle", "insert_d", "insert_depth", "thread_pitch"] as const;

interface CheckScope {
  /** The task has a T4 context model (`$context`, `changed_*`). */
  hasContext: boolean;
  /** Inside `bodies_matching.where`. */
  nested: boolean;
  /** The task is an IR v1 task (the v1 checks are allowed). */
  v1: boolean;
  /** Inside a `param` test's `test`. */
  inParam?: boolean;
}

function typeVocabulary(check: string, v1: boolean): readonly string[] {
  switch (check) {
    case "face_count":
      return FACE_TYPES;
    case "edge_count":
      return EDGE_TYPES;
    case "feature_count":
    case "ref_stability":
      return v1 ? FEATURE_TYPES_V1 : FEATURE_TYPES;
    case "blend_edges":
      return BLEND_TYPES;
    case "param_count":
      return PARAM_UNITS;
    default:
      return [];
  }
}

function rangeProblem(r: Range | undefined, what: string, at: string): string[] {
  return r !== undefined && r[0] > r[1] ? [`${at}: ${what} range is reversed`] : [];
}

/** Problems with one check (a hidden test, a `where` condition or a `param` test), prefixed with `at`. */
function checkProblems(t: HiddenTest | BodyCondition | NestedTest, at: string, scope: CheckScope): string[] {
  const out: string[] = [];
  const allowed = ALLOWED_PARAMS[t.check];
  if (!allowed) return [`${at}: unknown check "${t.check}"`];
  if (!scope.v1 && (V1_CHECKS as readonly string[]).includes(t.check)) out.push(`${at}: ${t.check} measures IR v1 models only (the task must require "ir/1")`);
  const rec = t as unknown as Record<string, unknown>;
  for (const p of ALL_PARAMS) {
    if (rec[p] !== undefined && !allowed.includes(p)) out.push(`${at}: "${p}" is not a parameter of ${t.check}`);
  }
  if (scope.nested && t.body !== undefined) out.push(`${at}: "body" is not allowed inside bodies_matching (each body is tested)`);
  const comparators = COMPARATOR_KEYS.filter((k) => rec[k] !== undefined);
  if (t.check === "param") {
    if (comparators.length > 0) out.push(`${at}: param takes no comparator (its test has one)`);
    if (scope.inParam) out.push(`${at}: a param test cannot contain another param test`);
    if (t.set === undefined || Object.keys(t.set).length === 0) out.push(`${at}: param needs "set" (at least one parameter)`);
    for (const [k, v] of Object.entries(t.set ?? {})) {
      if (typeof v !== "number" && typeof v !== "boolean") out.push(`${at}: set.${k} must be a number or a boolean`);
      else if (typeof v === "number" && !Number.isFinite(v)) out.push(`${at}: set.${k} must be finite`);
    }
    if (t.test === undefined) out.push(`${at}: param needs "test" (the check run on the re-evaluated model)`);
    else {
      if (CONTEXT_CHECKS.includes(t.test.check)) out.push(`${at}.test: ${t.test.check} compares with the context model, not with a parameter variant`);
      if (t.test.eq === CONTEXT_REF || t.test.approx === CONTEXT_REF) out.push(`${at}.test: "$context" is not allowed in a param test`);
      out.push(...checkProblems(t.test, `${at}.test`, { ...scope, inParam: true }));
    }
  } else if (PREDICATE_CHECKS.includes(t.check as CheckName)) {
    if (comparators.length > 0) out.push(`${at}: ${t.check} is a predicate and takes no comparator`);
    const pts = t.points ?? [];
    const dims = new Set(pts.map((p) => p.length));
    if (dims.size > 1) out.push(`${at}: points mix 2D and 3D coordinates`);
    if (t.check === "hole_positions") {
      const edges = t.relative_to === "edges";
      if (edges && pts.some((p) => p.length !== 2)) out.push(`${at}: hole_positions relative_to edges needs [a, b] offset pairs`);
      if (!edges && pts.some((p) => p.length !== 3)) out.push(`${at}: hole_positions needs 3D points`);
      if (!edges && t.body !== undefined) out.push(`${at}: "body" is only used by hole_positions with relative_to "edges"`);
      if (edges && pts.some((p) => p.some((x) => x < 0))) out.push(`${at}: edge offsets cannot be negative`);
      if (edges && t.entry !== undefined) out.push(`${at}: entry compares 3D entry points; it does not apply to relative_to "edges"`);
    }
    if (t.check === "hole_pattern" && pts.length < 2) out.push(`${at}: hole_pattern needs at least 2 points`);
    if (t.circles !== undefined && !scope.v1) out.push(`${at}: circles selects IR v1 circles (IR v0 checks see every sketch circle)`);
  } else if (comparators.length !== 1) {
    out.push(`${at}: needs exactly one comparator (eq, approx, between, gte or lte); found ${comparators.length}`);
  }
  if ((t.approx === CONTEXT_REF || t.eq === CONTEXT_REF) && scope.nested) {
    out.push(`${at}: "$context" is not allowed inside bodies_matching`);
  } else if ((t.approx === CONTEXT_REF || t.eq === CONTEXT_REF) && !scope.hasContext && !scope.inParam) {
    out.push(`${at}: "$context" is only available in tasks with a context file`);
  }
  if (CONTEXT_CHECKS.includes(t.check as CheckName) && !scope.hasContext && !scope.inParam) out.push(`${at}: ${t.check} needs a context file`);
  if (t.axis !== undefined && !AXIS_CHECKS.includes(t.check)) out.push(`${at}: axis is not supported by ${t.check}`);
  if (t.type !== undefined) {
    const vocab = typeVocabulary(t.check, scope.v1);
    if (!vocab.includes(t.type)) out.push(`${at}: type "${t.type}" is not one of ${vocab.join(", ")}`);
  }
  if (t.check === "blend_edges" && t.type === undefined) out.push(`${at}: blend_edges needs type "fillet" or "chamfer"`);
  if (t.check === "param_value" && (t.name === undefined || t.name.length === 0)) out.push(`${at}: param_value needs "name"`);
  if (t.check === "warning_count" && t.code === undefined) out.push(`${at}: warning_count needs "code" (an unfiltered count includes engine-internal notes)`);
  out.push(...rangeProblem(t.diameter, "diameter", at), ...rangeProblem(t.size, "size", at));
  for (const k of HOLE_FILTER_RANGES) out.push(...rangeProblem(t.hole?.[k], `hole.${k}`, at));
  if (t.hole?.through === true && t.hole.depth !== undefined) out.push(`${at}: hole.depth selects blind holes; it contradicts through: true`);
  const vector = VECTOR_CHECKS.includes(t.check) && t.axis === undefined;
  if (Array.isArray(t.approx) && !vector) out.push(`${at}: approx with a list needs a vector measure`);
  if (typeof t.approx === "number" && vector) out.push(`${at}: ${t.check} is a vector; give approx a list or pick an axis`);
  if (t.between !== undefined) {
    const nestedRanges = Array.isArray(t.between[0]);
    if (nestedRanges !== vector) out.push(`${at}: between must be ${vector ? "a list of [min, max] per element" : "[min, max]"}`);
    const ranges = (nestedRanges ? t.between : [t.between]) as Range[];
    if (ranges.some(([lo, hi]) => lo > hi)) out.push(`${at}: between range is reversed`);
  }
  if ((t.gte !== undefined || t.lte !== undefined) && vector) out.push(`${at}: gte/lte need a scalar measure`);
  if (t.check === "bodies_matching") {
    (t as HiddenTest).where?.forEach((w, i) => out.push(...checkProblems(w, `${at}.where[${i}]`, { ...scope, nested: true })));
  }
  return out;
}

/** Cross-field problems the JSON Schema cannot express. `file` is the task file path. */
export function semanticProblems(task: TaskFile, file: string): string[] {
  const out: string[] = [];
  const stem = basename(file).slice(0, -TASK_FILE_SUFFIX.length);
  if (stem !== task.id) out.push(`id "${task.id}" does not match the file name "${basename(file)}"`);
  if (!task.id.startsWith(task.tier.toLowerCase() + "-")) out.push(`id "${task.id}" should start with "${task.tier.toLowerCase()}-"`);
  const dir = dirname(file);
  if (!existsSync(join(dir, task.reference))) out.push(`reference file not found: ${task.reference}`);
  if (task.context !== undefined && !existsSync(join(dir, task.context))) out.push(`context file not found: ${task.context}`);
  if (task.context !== undefined && task.tier !== "T4") out.push(`context is only used by T4 edit tasks`);
  if (task.clarify !== undefined && task.tier !== "T5") out.push(`clarify is only used by T5 tasks`);
  const ids = new Set<string>();
  task.hidden_tests.forEach((t, i) => {
    if (ids.has(t.id)) out.push(`hidden_tests[${i}]: duplicate id "${t.id}"`);
    ids.add(t.id);
    out.push(...checkProblems(t, `hidden_tests[${i}] (${t.id})`, { hasContext: task.context !== undefined, nested: false, v1: isV1Task(task) }));
  });
  out.push(...holeChecksMeasureGeometry(task.hidden_tests));
  return out;
}

const HOLE_CHECKS: readonly string[] = ["hole_count", "hole_positions", "hole_pattern"];
/** What a filled or missing hole changes. */
const HOLE_GEOMETRY_CHECKS: readonly string[] = ["volume", "face_count"];

/** `set` as a key independent of property order. */
function setKey(set: Readonly<Record<string, unknown>> | undefined): string {
  return JSON.stringify(Object.entries(set ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The hole checks count the holes the timeline made, not the holes the final bodies still have
 * (a hole a later join fills still counts: the census is declarative, see `v1/subject.ts`), so a
 * task that checks holes must also measure the geometry a filled or missing hole changes: a
 * `volume` or `face_count` test on the model, and for a `param` hole check, a `param` volume or
 * face_count test with the same `set`.
 */
function holeChecksMeasureGeometry(tests: readonly HiddenTest[]): string[] {
  const out: string[] = [];
  const top = tests.filter((t) => t.check !== "param");
  if (top.some((t) => HOLE_CHECKS.includes(t.check)) && !top.some((t) => HOLE_GEOMETRY_CHECKS.includes(t.check))) {
    out.push(`hole checks need a volume or face_count test too (the hole census counts the holes the timeline made, not those the final bodies keep)`);
  }
  const measured = new Set(tests.filter((t) => t.check === "param" && t.test && HOLE_GEOMETRY_CHECKS.includes(t.test.check)).map((t) => setKey(t.set)));
  for (const t of tests) {
    if (t.check !== "param" || !t.test || !HOLE_CHECKS.includes(t.test.check) || measured.has(setKey(t.set))) continue;
    out.push(`${t.id}: a param hole check needs a param volume or face_count test with the same set ${JSON.stringify(t.set ?? {})}`);
  }
  return out;
}

export class TaskLoadError extends Error {
  readonly problems: readonly { file: string; problem: string }[];
  constructor(problems: { file: string; problem: string }[]) {
    super(`invalid MakerBench tasks:\n  ${problems.map((p) => `${p.file}: ${p.problem}`).join("\n  ")}`);
    this.name = "TaskLoadError";
    this.problems = problems;
  }
}

/** All `*.task.json` files in `dir`, sorted by name. */
export function taskFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(TASK_FILE_SUFFIX))
    .sort()
    .map((f) => resolve(dir, f));
}

/** Read one task file, validating it. Returns the task and its problems. */
export function readTask(file: string): { task: LoadedTask | null; problems: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { task: null, problems: [`not valid JSON: ${(e as Error).message}`] };
  }
  const problems = schemaProblems(value);
  if (problems.length > 0) return { task: null, problems };
  const t = value as TaskFile;
  problems.push(...semanticProblems(t, file));
  if (problems.length > 0) return { task: null, problems };
  const dir = dirname(file);
  const task: LoadedTask = { ...t, file, referenceSource: readFileSync(join(dir, t.reference), "utf8") };
  if (t.context !== undefined) task.contextSource = readFileSync(join(dir, t.context), "utf8");
  return { task, problems: [] };
}

/** Load and validate every task in `dir` (sorted by id). Throws {@link TaskLoadError} on any problem. */
export function loadTasks(dir: string): LoadedTask[] {
  const tasks: LoadedTask[] = [];
  const problems: { file: string; problem: string }[] = [];
  for (const file of taskFiles(dir)) {
    const r = readTask(file);
    if (r.task) tasks.push(r.task);
    for (const p of r.problems) problems.push({ file: basename(file), problem: p });
  }
  if (problems.length > 0) throw new TaskLoadError(problems);
  return tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
