/**
 * Diagnostic codes of CadScript v1: the front end's `CS_*` codes and, mirrored one-to-one with
 * the same code and IR path, every rejection (**R**, and **R/E** on literal values) of IR v1
 * validation (SPEC-v1 §7.5, `ERROR_CODES` in `ir-v1.constants.json`). Every code has a hint
 * written for both people and LLM agents.
 */
import { v1 } from "@aicad/ir-types";
import type { Severity } from "../diagnostics.js";

export interface CodeInfo {
  severity: Severity;
  summary: string;
  /** Default fix hint (an emitting site may give a more specific one). */
  hint: string;
}

/** The CadScript front-end codes of v1 (v0's, extended, plus the new ones). */
export const CS_CODES_V1 = {
  CS_SYNTAX: { severity: "error", summary: "TypeScript syntax error.", hint: "fix the syntax; CadScript is TypeScript" },
  CS_TOO_COMPLEX: {
    severity: "error",
    summary: "The code exceeds one of CadScript's fixed nesting or type-checker work limits.",
    hint: "write the statement flat; look for runaway brackets or a repeated fragment",
  },
  CS_BAD_IMPORT: { severity: "error", summary: 'Imports must be `import { … } from "@aicad/std"`, before any other statement.', hint: 'import { … } from "@aicad/std";' },
  CS_NOT_IMPORTED: { severity: "error", summary: "A builtin is used without being imported from @aicad/std.", hint: "add it to the import from @aicad/std" },
  CS_UNKNOWN_BUILTIN: { severity: "error", summary: "Call to (or import of) something that is not a CadScript v1 builtin, or a builtin in the wrong position.", hint: "see @aicad/std for the builtins" },
  CS_UNKNOWN_METHOD: {
    severity: "error",
    summary: "A method a feature handle or query does not have (e.g. `slab.caps()`).",
    hint: "feature handles have cap/endcap/side/sides/edgeAt/body/faces (sweeps), wall/tip/… (holes), instance (patterns); queries have faces/edges/…/one()",
  },
  CS_STATEMENT_UNSUPPORTED: { severity: "error", summary: "A statement form CadScript does not accept (let/var, loops, if, functions, …).", hint: "a file contains imports, doc(…), part(…) and `const name = …` statements" },
  CS_EXPR_UNSUPPORTED: {
    severity: "error",
    summary: "An expression form CadScript does not accept (Math.*, `^`, bitwise, template strings, spreads, member access on values, …).",
    hint: "use + - * / % ** comparisons && || ! ?: and the math functions of @aicad/std (degrees)",
  },
  CS_BAD_ARGUMENT: { severity: "error", summary: "Wrong argument count or kind, an unknown or missing property, or a value of the wrong kind.", hint: "see the builtin's signature in @aicad/std" },
  CS_DOC_MISPLACED: { severity: "error", summary: "doc() must be the first statement after the imports and appear at most once.", hint: "move doc({ … }) directly below the import" },
  CS_MISSING_PART: { severity: "error", summary: 'A feature appears before any part("…") statement.', hint: 'add `part("part");` above the first feature' },
  CS_DUPLICATE_NAME: { severity: "error", summary: "Two consts share a name (parameters and features are unique per file).", hint: "rename one of them" },
  CS_RESERVED_NAME: {
    severity: "error",
    summary: "A const is named like a @aicad/std builtin or a reserved word (a warning for v1 builtins on features that migrated from v0 and do not collide with an import).",
    hint: "rename it (the command layer's renameFeature is safe: references use ids)",
  },
  CS_UNRESOLVED_SKETCH: { severity: "error", summary: "extrude/revolve does not reference an earlier sketch const of the same part.", hint: "pass a sketch const declared above, in the same part" },
  CS_USED_BEFORE_DECLARED: { severity: "error", summary: "A parameter or feature const is used before its declaration.", hint: "move the declaration above its first use: statements run in file order" },
  CS_RENAME_DETECTED: {
    severity: "info",
    summary: "Matched to the base IR as a rename: a feature, part or sketch curve kept its id (curve renames come with a fix that rewrites the references).",
    hint: "apply the fix to rewrite the references to the renamed curve (what renameCurve does)",
  },
  CS_BAD_BASE: {
    severity: "warning",
    summary: "The `base` IR given to compile() is not a well-formed IR document, so it was ignored: ids were assigned as if there were no base.",
    hint: "pass the IR this source was printed from (or last compiled to), as loaded by loadIrDocument",
  },
  CS_NOT_PRINTABLE: {
    severity: "error",
    summary:
      "print(): the value is not a well-formed IR document, or is invalid in a way no CadScript can express (an unknown feature type or query op, a dangling feature id, …). A PrintProblem code, not a compile diagnostic.",
    hint: "load the document with loadIrDocument first: its rejection codes say what is wrong",
  },
  CS_CAPTURE_DROPPED: {
    severity: "info",
    summary: "A reference's query changed since the base IR, so its capture was not carried over.",
    hint: "the command layer re-captures edited references (captureRef); nothing to do in the source",
  },
} as const satisfies Record<string, CodeInfo>;

export type CsCode = keyof typeof CS_CODES_V1;

/** Hints for the IR rejection codes (SPEC-v1 §7.5), by code. */
const IR_HINTS: Readonly<Record<string, string>> = {
  UNSUPPORTED_SCHEMA: 'CadScript v1 writes "aicad.ir/1"; v0 documents are migrated',
  NO_PARTS: 'add a part: part("part"); followed by its features',
  DUPLICATE_ID: "ids (curve and constraint keys, hole position keys, point ids) must be unique within their sketch or hole",
  DUPLICATE_NAME: "parameter and feature names share one namespace: rename one of them",
  INVALID_NAME: "names match [A-Za-z_][A-Za-z0-9_]* (ASCII letters, digits, underscore), at most 64 characters",
  RESERVED_NAME: "pick a name that is not a reserved word or @aicad/std builtin",
  INVALID_ID: "ids match [A-Za-z_][A-Za-z0-9_]*, at most 64 characters; references are ids joined by '.' (e.g. \"outline.bottom\")",
  UNSUPPORTED_FEATURE: "this engine does not implement the feature (draft is optional in v1)",
  UNSUPPORTED_FEATURE_VERSION: "remove `v`: this revision defines v: 1 for every feature",
  UNRESOLVED_SKETCH: "pass a sketch const declared above, in the same part",
  UNRESOLVED_FEATURE: "reference a feature declared above, in the same part (datum planes/axes where a datum is expected)",
  INVALID_DISTANCE: 'distance is a positive length in mm; to go the other way use direction: "reverse"',
  INVALID_ANGLE: "the angle is in degrees: 0 < angle ≤ 360",
  INVALID_AXIS: "the axis direction must be a non-zero vector, e.g. [0, 1]",
  INVALID_PLANE: "normal and xDir must be non-zero and perpendicular (dot product 0)",
  EMPTY_SKETCH: "add at least one curve: line(…), arc({ … }), circle({ … }), rect({ … }), …",
  NON_FINITE: "numbers must be finite",
  DEGENERATE_CURVE: "curves need a length/radius greater than 1e-6 mm",
  INCONSISTENT_ARC: "start and end must be the same distance from center (within 1e-6 mm)",
  CURVE_OPTIONS_CONFLICT: "a rect takes exactly one of center/corner; a polygon exactly one of circumradius/inradius/acrossFlats/side",
  CONSTRAINT_VALUE_REQUIRED: "give the dimension a value: C.distance(a, b, 20), or make it a reference: { driving: false }",
  CONSTRAINT_VALUE_ON_REFERENCE: "a reference dimension ({ driving: false }) is measured: remove its value",
  PATTERN_OPTIONS_CONFLICT: "op/targets are for body seeds only; dir2 and spacing2 come together (count2 needs them)",
  DATUM_OPTIONS_CONFLICT: "use exactly one form: offset+distance, from+axis+angle, midplane, through, or origin+normal+xDir (datum axes: edge, cylinder, planes or points)",
  EXPR_SYNTAX: "the expression is too long (4096 bytes) or too deeply nested (64 levels): split it with param()",
  EXPR_UNKNOWN_NAME: "expressions use param() consts declared above (features are not values)",
  EXPR_UNKNOWN_FUNCTION: "use the math functions of @aicad/std: min max abs sqrt floor ceil round clamp hypot sin cos tan asin acos atan atan2",
  EXPR_ARITY: "check the function's argument count (min/max take ≥ 2, clamp 3, hypot and atan2 2, the others 1)",
  EXPR_UNIT_MISMATCH: "make the units agree: a bare number adopts its neighbour's unit, mm(…)/deg(…) make it explicit, and counts/ratios multiply lengths",
  EXPR_TYPE_MISMATCH: "a condition (bool) is used as a number, or a number as a condition",
  EXPR_SCOPE: "a part can only use document parameters and its own; move the parameter above the first part(…) to share it",
  EXPR_NOT_INTEGER: "counts must be whole numbers (|n| ≤ 2^31)",
  PARAM_INVALID: "param(value, { unit, min, max, note }): unit is mm/deg/ratio/count/bool; no bounds on a bool; min ≤ max",
  PARAM_CYCLE: "parameters may not depend on themselves",
  PARAM_OUT_OF_RANGE: "the value is outside [min, max]",
  SKETCH_MIXED_MODE: "use lines and constraints, or drop the constraints and drive the rect with parameters",
  SKETCH_UNKNOWN_REFERENCE: 'constraint arguments are entity ids of this sketch: "l", "l.start", "l.end", "a.center", "outline.bottom"',
  SKETCH_WRONG_ENTITY_TYPE: "the constraint takes a different entity type here (point, line, circle or arc)",
  SKETCH_NOT_A_DIMENSION: "only distance, angle, radius and diameter take a value or { driving }",
  SKETCH_UNSUPPORTED_COMBINATION: "tangent needs a line and a circle/arc or two circles/arcs; equal needs two lines or two circles/arcs",
  SKETCH_SELF_REFERENCE: "the two arguments must be different entities",
  SKETCH_INVALID_DIMENSION: "distance, radius and diameter values must be > 0",
  REF_KIND_MISMATCH: "the query selects the wrong kind of entity for this argument: navigate with .faces(), .edges(), .vertices() or .owner()",
  QUERY_INVALID: "a query step does not apply here (see the expected/found kinds or feature types)",
  QUERY_UNKNOWN_CURVE: 'name a profile curve of the sketch the feature consumed (a compound\'s members are "<id>.left", "<id>.cap_a", "<id>.e0", …)',
  INVALID_CARDINALITY: "single-entity arguments take .one() (or nothing); counts are .one(), .some(), .any() or .exactly(n ≥ 1)",
  BOOLEAN_TARGETS_REQUIRED: 'join/cut/intersect need targets: "all", a body query or a feature handle',
  HOLE_SIZE_UNKNOWN: "sizes are M2, M2.5, M3, M4, M5, M6, M8 (or give an explicit diameter d)",
  HOLE_SIZE_REQUIRED: "give a size (\"M3\", …) or an explicit diameter d",
  HOLE_OPTIONS_CONFLICT: "at most one of cbore, csink, insert; presets need a size; thread excludes insert and close/loose fits; tip is for blind holes",
  HOLE_DEPTH_REQUIRED: 'give a depth: "through", { blind: 6 } or { upTo: face } (inserts set their own)',
  CHAMFER_OPTIONS_CONFLICT: "a chamfer is { d }, { d, d2, side } or { d, angle, side }",
  PATTERN_SEED_UNSUPPORTED: "pattern seeds are extrude, revolve or hole features",
  INVALID_RADIUS: "the radius is a positive length in mm",
  INVALID_COUNT: "the count is too small (pattern count ≥ 1, circular ≥ 2, polygon n ≥ 3, grid/bolt circle ≥ 1)",
  INVALID_VALUE: "the value is outside its valid range (see expected)",
};

/** Every IR code the compiler can report (stage R, and R/E on literals), with severity and hint. */
export const IR_CODES_V1: Readonly<Record<string, CodeInfo>> = Object.fromEntries(
  Object.entries(v1.ERROR_CODES as Record<string, { stage: string; section: string }>)
    .filter(([, c]) => c.stage === "R" || c.stage === "R/E")
    .map(([code, c]) => [code, { severity: "error" as Severity, summary: `IR v1 rejection (SPEC-v1 ${c.section}).`, hint: IR_HINTS[code] ?? "see SPEC-v1 §7.5" }]),
);

/** All diagnostic codes of CadScript v1. */
export const DIAGNOSTIC_CODES_V1: Readonly<Record<string, CodeInfo>> = { ...IR_CODES_V1, ...CS_CODES_V1 };

export function hintFor(code: string): string | undefined {
  return DIAGNOSTIC_CODES_V1[code]?.hint;
}

/** At most this many valid ids are listed in a QUERY_UNKNOWN_CURVE hint. */
export const MAX_LISTED_IDS = 12;

/** Levenshtein distance (UTF-16 units; ids are ASCII), for ranking "did you mean" candidates. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The closest id to `wanted` among `pool` (edit distance; ties keep `pool`'s order), when it is
 * close enough to be a likely typo: at most max(2, ⌊|wanted| / 3⌋) edits. Pattern entries
 * ("hex.e<k>") are never suggested.
 */
export function closestId(wanted: string, pool: readonly string[]): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const id of pool) {
    if (id.includes("<")) continue;
    const d = editDistance(id, wanted);
    if (!best || d < best.d) best = { id, d };
  }
  return best && best.d <= Math.max(2, Math.floor(wanted.length / 3)) ? best.id : undefined;
}

/**
 * The QUERY_UNKNOWN_CURVE hint: "did you mean" the closest valid id (among `candidates`, else
 * forge-ir's `similar`), then the ids the reference could name (`candidates`, capped at
 * {@link MAX_LISTED_IDS}), or else `similar`. Deterministic.
 */
function unknownCurveHint(details: Readonly<Record<string, unknown>>, candidates: { what: string; ids: readonly string[] } | undefined): string | undefined {
  const curve = typeof details["curve"] === "string" ? details["curve"] : "";
  const similar = Array.isArray(details["similar"]) ? details["similar"].filter((x): x is string => typeof x === "string") : [];
  const listed = candidates && candidates.ids.length > 0 ? candidates : similar.length > 0 ? { what: "similar ids", ids: similar } : undefined;
  const guess = closestId(curve, listed?.ids ?? []);
  const parts: string[] = [];
  if (guess !== undefined) parts.push(`did you mean ${JSON.stringify(guess)}?`);
  if (listed) {
    const shown = listed.ids.slice(0, MAX_LISTED_IDS).map((id) => JSON.stringify(id)).join(", ");
    const more = listed.ids.length > MAX_LISTED_IDS ? `, … (${listed.ids.length - MAX_LISTED_IDS} more)` : "";
    parts.push(`${listed.what}: ${shown}${more}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * The hint for one IR validation error: by code, refined by the violation where one code covers
 * several (and, for QUERY_UNKNOWN_CURVE, by the ids the reference could have named).
 */
export function hintForError(
  code: string,
  details: Readonly<Record<string, unknown>>,
  candidates?: { what: string; ids: readonly string[] },
): string | undefined {
  if (code === "QUERY_UNKNOWN_CURVE") return unknownCurveHint(details, candidates) ?? hintFor(code);
  if (code === "INVALID_CARDINALITY") {
    const allowed = details["allowed"];
    if (Array.isArray(allowed) && allowed.includes(">= 1")) return "a count is .one(), .some(), .any() or .exactly(n) with n ≥ 1: .exactly(0) selects nothing";
    return "this argument designates exactly one entity: end the query with .one() (or no count), and narrow it until one entity matches";
  }
  return hintFor(code);
}
