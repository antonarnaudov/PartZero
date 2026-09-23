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
export const CHECKS = [...MODEL_CHECKS, ...BODY_CHECKS, "bodies_matching", ...IR_CHECKS] as const;
export type CheckName = (typeof CHECKS)[number];
export type BodyCheckName = (typeof BODY_CHECKS)[number] | "valid";

export const FACE_TYPES = ["plane", "cylinder", "cone", "sphere", "torus", "bspline", "other"] as const;
export const EDGE_TYPES = ["line", "circle", "ellipse", "bspline", "other"] as const;
export const FEATURE_TYPES = ["sketch", "extrude", "revolve"] as const;

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

export interface CheckParams {
  type?: string;
  axis?: Axis;
  body?: number;
  kind?: "line" | "arc" | "circle";
  diameter?: Range;
  points?: number[][];
  tol?: number;
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
 * the same DSL (the spec writer). Problems are prefixed with `tests[i] (id)`; empty = valid.
 */
export function testProblems(tests: readonly unknown[], options: { hasContext?: boolean } = {}): string[] {
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
    out.push(...checkProblems(t as HiddenTest, at, options.hasContext ?? false, false));
  });
  return out;
}

// ─── Semantic validation ───────────────────────────────────────────────────────────────────

const COMPARATOR_KEYS = ["eq", "approx", "between", "gte", "lte"] as const;
const PREDICATE_CHECKS: readonly CheckName[] = ["hole_pattern", "hole_positions"];
const AXIS_CHECKS: readonly string[] = ["centroid", "bbox_size", "bbox_min", "bbox_max"];
const VECTOR_CHECKS: readonly string[] = ["centroid", "bbox_size", "bbox_sorted", "bbox_min", "bbox_max"];
const CONTEXT_CHECKS: readonly CheckName[] = ["changed_curves", "changed_features"];

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
  hole_pattern: ["diameter", "points", "tol"],
  hole_positions: ["diameter", "points", "tol"],
  feature_names: [],
  changed_curves: [],
  changed_features: [],
};
const ALL_PARAMS = ["type", "axis", "body", "kind", "diameter", "points", "tol", "where"] as const;

/** Problems with one check (a hidden test or a `where` condition), prefixed with `at`. */
function checkProblems(t: HiddenTest | BodyCondition, at: string, hasContext: boolean, nested: boolean): string[] {
  const out: string[] = [];
  const allowed = ALLOWED_PARAMS[t.check];
  if (!allowed) return [`${at}: unknown check "${t.check}"`];
  const rec = t as unknown as Record<string, unknown>;
  for (const p of ALL_PARAMS) {
    if (rec[p] !== undefined && !allowed.includes(p)) out.push(`${at}: "${p}" is not a parameter of ${t.check}`);
  }
  if (nested && t.body !== undefined) out.push(`${at}: "body" is not allowed inside bodies_matching (each body is tested)`);
  const comparators = COMPARATOR_KEYS.filter((k) => rec[k] !== undefined);
  if (PREDICATE_CHECKS.includes(t.check as CheckName)) {
    if (comparators.length > 0) out.push(`${at}: ${t.check} is a predicate and takes no comparator`);
    const pts = t.points ?? [];
    const dims = new Set(pts.map((p) => p.length));
    if (dims.size > 1) out.push(`${at}: points mix 2D and 3D coordinates`);
    if (t.check === "hole_positions" && pts.some((p) => p.length !== 3)) out.push(`${at}: hole_positions needs 3D points`);
    if (t.check === "hole_pattern" && pts.length < 2) out.push(`${at}: hole_pattern needs at least 2 points`);
  } else if (comparators.length !== 1) {
    out.push(`${at}: needs exactly one comparator (eq, approx, between, gte or lte); found ${comparators.length}`);
  }
  if ((t.approx === CONTEXT_REF || t.eq === CONTEXT_REF) && nested) {
    out.push(`${at}: "$context" is not allowed inside bodies_matching`);
  } else if ((t.approx === CONTEXT_REF || t.eq === CONTEXT_REF) && !hasContext) {
    out.push(`${at}: "$context" is only available in tasks with a context file`);
  }
  if (CONTEXT_CHECKS.includes(t.check as CheckName) && !hasContext) out.push(`${at}: ${t.check} needs a context file`);
  if (t.axis !== undefined && !AXIS_CHECKS.includes(t.check)) out.push(`${at}: axis is not supported by ${t.check}`);
  if (t.type !== undefined) {
    const vocab: readonly string[] =
      t.check === "face_count" ? FACE_TYPES : t.check === "edge_count" ? EDGE_TYPES : t.check === "feature_count" ? FEATURE_TYPES : [];
    if (!vocab.includes(t.type)) out.push(`${at}: type "${t.type}" is not one of ${vocab.join(", ")}`);
  }
  if (t.diameter && t.diameter[0] > t.diameter[1]) out.push(`${at}: diameter range is reversed`);
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
    (t as HiddenTest).where?.forEach((w, i) => out.push(...checkProblems(w, `${at}.where[${i}]`, hasContext, true)));
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
    out.push(...checkProblems(t, `hidden_tests[${i}] (${t.id})`, task.context !== undefined, false));
  });
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
