/**
 * Repair playbooks for the agent that operates the command layer's ops (the live agent, MCP
 * clients): one short, op-worded hint per refusal code — the `COMMAND_*` codes of `@aicad/model-ops`
 * and the app's store, ADR 0015's `unapproved_user_change`, and the IR v1 codes an op meets most —
 * plus what the refusal's structured `details` offer (feasible values, dependents, candidates).
 *
 * The CadScript playbooks (`v1/playbooks.ts`) speak CadScript (`param(…)`, `.one()`, patches);
 * these speak feature JSON and op tools, so the agent is never told to write code.
 */
import { num } from "./format.js";

/** Tool names the hints mention (one place, so a rename cannot drift). */
export const OPS_HINT_TOOLS = {
  find: "find_entities",
  list: "list_entities",
  model: "get_model",
  feature: "get_feature",
  measure: "measure",
  check: "check_model",
  approval: "request_approval",
  setField: "set_field",
  update: "update_feature",
  add: "add_feature",
  del: "delete_feature",
  dependents: "feature_dependents",
  paramUses: "param_uses",
} as const;

const T = OPS_HINT_TOOLS;

/**
 * Op-worded hints per code. Every `COMMAND_*` / `IR_*` code the command layer emits has one (a test
 * holds the list to the codes in `@aicad/model-ops` and the app's store); IR codes fall back to
 * {@link GENERIC_IR_HINT}.
 */
export const OPS_PLAYBOOK: Readonly<Record<string, string>> = {
  // ── The command layer ──
  COMMAND_FEATURE_FAILS: "The feature you added or edited would not build, so nothing was changed. Fix its JSON for the inner code below (the details carry the engine's numbers, e.g. the largest radius that fits).",
  COMMAND_PARAM_FAILS: "The parameter would not evaluate (its inner code is below): fix the expression or the value, or add the parameters it reads first.",
  COMMAND_NEW_FAILURES: `The edit builds, but makes the listed later features fail. Change the edit so they still build; only when every listed feature is your own (agent-made) and failing is intended, repeat the same call with ack listing exactly those ids.`,
  COMMAND_HAS_DEPENDENTS: `Other features reference it (listed). Re-point them first (${T.setField}), or delete with dependents "cascade" only when they should go too.`,
  COMMAND_PARAM_IN_USE: `Expressions use this parameter (listed; ${T.paramUses} shows them): change them first, or delete with uses "inline" to keep their current values.`,
  COMMAND_PARAM_FAILED: "The parameter's current value does not evaluate: set a literal value or fix the expression.",
  COMMAND_ILLEGAL_ORDER: "A feature may reference only earlier features: move it after everything it references (or move those earlier).",
  COMMAND_UNKNOWN_FEATURE: `There is no such feature: ${T.model} lists the ids and names.`,
  COMMAND_UNKNOWN_PARAM: `There is no such parameter: ${T.model} lists them (add it with add_param first).`,
  COMMAND_UNKNOWN_PART: `There is no such part: ${T.model} lists the parts (omit part to use the first).`,
  COMMAND_WRONG_PART: "after must be a feature of the same part.",
  COMMAND_BAD_PATH: `The JSON pointer does not name a field of that feature: ${T.feature} shows its fields (use "/-" to append to an array).`,
  COMMAND_BAD_VALUE: "The value has the wrong shape for that field: give JSON of the field's type, or {\"expr\": \"…\"} for an expression.",
  COMMAND_BAD_JSON: "The *_json argument is not valid JSON: send the object as JSON text (double quotes, no comments, no trailing commas).",
  COMMAND_FIXED_FIELD: "id, type and author cannot change: add a new feature of the right type instead, and delete the old one.",
  COMMAND_HOST_ONLY: "That is the user's to do (ADR 0015): tell them in your summary instead.",
  COMMAND_AUTHOR_HOST_ONLY: "Authorship is written by the app, never by the agent: leave author out of the feature JSON.",
  COMMAND_NOT_EXACT: "The engine could not verify the edit as exact: try a simpler edit (one field at a time).",
  COMMAND_CANDIDATE_CHANGED: "The model changed since the candidate was read: read the report again and pick the candidate anew.",
  COMMAND_UPGRADE_UNCONFIRMED: "An upgrade that changes the model needs the confirm token of the diff in the details.",
  unapproved_user_change: `This would change the user's own work (listed with how). Call ${T.approval} with exactly those features/parameters and one line on why; when the user allows it, repeat the same call. If they decline, reach the goal without touching their work (add your own feature instead).`,
  IR_GROUP_OPEN: "The user or another tool is editing the model right now: the task ends here; say what is left in your summary.",
  IR_GROUP_CLOSED: "The task has ended (stopped or finished): make no more changes.",
  IR_TRANSACTION_CLOSED: "Internal: the transaction was already closed; repeat the call once.",
  IR_DOCUMENT_CHANGED: "The model changed while the edit was prepared: read it again (get_model) and repeat.",
  IR_NO_DOCUMENT: "No model is open.",
  IR_UNAVAILABLE: "No model is open in the app.",
  IR_PARSE_ERROR: "The model is not valid JSON (internal).",
  ENGINE_UNSUPPORTED: "The geometry engine has no command layer here: the task cannot continue.",
  // ── IR codes an op meets most (feature JSON) ──
  UNRESOLVED_SKETCH: `"sketch" must be the id of an earlier sketch of the same part (${T.model} lists ids).`,
  UNRESOLVED_FEATURE: "A feature id in this feature (a query's feature, a datum, a seed) must name an earlier feature of the same part.",
  DUPLICATE_ID: "Ids must be unique: give the feature, curve, constraint or hole position a new id (or leave the feature id out: the app picks one).",
  DUPLICATE_NAME: "Feature and parameter names share one namespace: pick another name.",
  INVALID_ID: 'Ids match [A-Za-z_][A-Za-z0-9_]* (curve members are joined with ".", e.g. "outline.left").',
  INVALID_NAME: "Names match [A-Za-z_][A-Za-z0-9_]* (at most 64 characters).",
  RESERVED_NAME: "That name is reserved: pick another.",
  EMPTY_SKETCH: "A sketch needs at least one curve.",
  EXPR_UNKNOWN_NAME: "An expression names a parameter that does not exist: add it with add_param first, or fix the spelling.",
  EXPR_SYNTAX: "Fix the expression syntax: + - * / % ** comparisons ?: and min max abs sqrt floor ceil round clamp hypot sin cos tan asin acos atan atan2 (degrees).",
  EXPR_UNIT_MISMATCH: "The units do not agree: a length field needs an mm expression, an angle a deg one; counts and ratios multiply lengths.",
  EXPR_NOT_INTEGER: "A count must be a whole number: round(…) the expression or change its inputs.",
  PARAM_OUT_OF_RANGE: "The value is outside the parameter's [min, max]: pick a value inside it, or change the bound.",
  INVALID_VALUE: "A value is out of its valid range (see details: field, value, expected).",
  INVALID_DISTANCE: "Extrude distance must be > 0 (use direction \"reverse\" to go the other way).",
  INVALID_RADIUS: "A radius must be > 0.",
  INVALID_COUNT: "Counts: linear ≥ 1, circular ≥ 2, polygon n ≥ 3.",
  CURVE_OPTIONS_CONFLICT: "rect takes exactly one of center/corner; polygon exactly one of circumradius/inradius/across_flats/side.",
  DEGENERATE_CURVE: "A curve has zero length or radius: fix its points or size.",
  INCONSISTENT_ARC: "The arc's start and end must be at the same distance from its center.",
  SKETCH_OPEN_LOOP: "The profile is not closed: every line/arc end must meet exactly one other curve end (a circle or rect is closed by itself).",
  SKETCH_CURVES_CROSS: "Curves of the profile cross: they may touch only at shared ends.",
  SKETCH_BRANCHING: "More than two curve ends meet at one point: a profile is a chain of curves, end to end.",
  SKETCH_NO_REGIONS: "The sketch has no closed region to extrude: close the loop.",
  REGION_NOT_FOUND: "regions names a curve that bounds no region: use \"all\", or the id of a curve of the region's outer loop.",
  SKETCH_MIXED_MODE: "A sketch with constraints takes literal lines, arcs, circles and points only: drop rect/slot/polygon (or drop the constraints and drive the rect with parameters).",
  SKETCH_UNKNOWN_REFERENCE: 'A constraint names an entity that does not exist: use curve ids and their points ("l.start", "l.end", "a.center", "c.center").',
  SKETCH_CONSTRAINT_CONFLICT: "The constraints contradict each other: remove the one the details name (or change a dimension).",
  SKETCH_SOLVE_FAILED: "The sketch did not solve: start from geometry closer to the intended shape, or remove a constraint.",
  SKETCH_REDUNDANT_CONSTRAINTS: "Some constraints are redundant (details name them): remove them.",
  BOOLEAN_TARGETS_REQUIRED: 'op "join" / "cut" / "intersect" needs targets: "all", or {"kind":"body","q":{"op":"body","feature":"<extrude id>"}}.',
  BOOLEAN_NO_INTERSECTION: "The tool does not touch the target: check its position (plane, direction, distance).",
  BOOLEAN_EMPTY_RESULT: "The boolean leaves nothing: check the op and the placement.",
  REVOLVE_CROSSES_AXIS: "The revolve profile crosses its axis: keep the profile on one side of the axis.",
  DEPENDENCY_FAILED: "An earlier feature this one needs failed: fix that one first.",
  BOOLEAN_BODY_CONSUMED: "The cut removes the whole body: make the cut smaller or check its placement.",
  PLANE_NOT_PLANAR: "A sketch or hole plane must be a planar face: pick a flat face (find_entities with a normal filter).",
  REF_MISSING: `The reference matches nothing: aim it with ${T.find} (shows what a query matches) or ${T.list} (named entities with ready-made queries).`,
  REF_AMBIGUOUS: `The reference matches several entities where one is needed: narrow the query (a named source like cap/side/between, or filter by normal/parallel/radius, or extreme) — ${T.find} shows the matches.`,
  REF_CARDINALITY: `The reference matches a different number of entities than declared (details: expected, found): fix the query or the card — ${T.find} shows the matches.`,
  REF_SPLIT: "The referenced entity was split into pieces: take every piece (card \"some\") or narrow the query to one piece.",
  REF_KIND_MISMATCH: 'The Ref\'s "kind" must equal what its query returns (faces → "face", edges → "edge", bodies → "body").',
  QUERY_INVALID: "The query is not well-formed at the path (details: expected / found): e.g. normal applies to faces only, parallel to edges and faces; cap needs an extrude, endcap a revolve.",
  QUERY_UNKNOWN_CURVE: "A query names a curve that is not in the sketch the feature consumed: use the curve ids of that sketch (rect members are <id>.bottom/.right/.top/.left).",
  HOLE_SIZE_UNKNOWN: 'Sizes are "M2", "M2.5", "M3", "M4", "M5", "M6", "M8" — or give an explicit diameter d.',
  HOLE_SIZE_REQUIRED: 'Give size ("M3", …) or an explicit diameter d.',
  HOLE_DEPTH_REQUIRED: 'Give depth: "through", {"blind": 6} or {"up_to": <face Ref>}.',
  HOLE_OPTIONS_CONFLICT: "At most one of cbore, csink, insert; presets need a size; thread excludes insert; tip is for blind holes.",
  HOLE_POINT_OFF_FACE: "A hole position lies outside the face: positions are (u, v) in the face's frame (for a top cap of an XY sketch that is the same x, y).",
  HOLE_MISSES_BODY: "The hole meets no body: check the face, the position and flip.",
  HOLE_BREAKS_THROUGH: "The blind hole goes through: make it shallower, or use depth \"through\" if that is intended.",
  FILLET_RADIUS_TOO_LARGE: "The radius is too large for these edges: use a value ≤ max_feasible_r (details).",
  FILLET_EDGE_UNSUPPORTED: "Some edges cannot be filleted (details: reason): leave them out of the query.",
  FILLET_FAILED: "The fillet failed on these edges: try a smaller radius or fewer edges at once (fillet before holes and pockets that meet the edges).",
  CHAMFER_DISTANCE_TOO_LARGE: "The distance is too large: use a value ≤ max_feasible_d (details).",
  CHAMFER_OPTIONS_CONFLICT: 'A chamfer is {"d"}, {"d","d2","side"} or {"d","angle","side"}.',
  CHAMFER_FAILED: "The chamfer failed: try a smaller distance or fewer edges.",
  SHELL_THICKNESS_TOO_LARGE: "The wall is too thick for this body: use a value ≤ max_feasible_thickness (details).",
  SHELL_FACE_NOT_ON_BODY: "open faces must belong to the shelled body.",
  SHELL_FAILED: "The shell failed: try a thinner wall, or shell before adding small details.",
  PATTERN_SEED_UNSUPPORTED: "Pattern seeds are extrude, revolve or hole features (or bodies).",
  PATTERN_OPTIONS_CONFLICT: "op/targets are for body seeds only; dir2 and spacing2 come together, and count2 needs them.",
  PATTERN_ALL_INSTANCES_FAILED: "No copy meets a target: check the direction, spacing and count.",
  UNSUPPORTED_FEATURE: "This engine does not implement that feature type: build the geometry with sketches, extrudes and cuts instead.",
  DATUM_OPTIONS_CONFLICT: "A datum takes exactly the fields of its mode (offset: from, distance; midplane: a, b; …).",
  DATUM_DEGENERATE: "The datum is degenerate (parallel planes, collinear points): pick other references.",
};

export const GENERIC_IR_HINT = "Read the code, message and path above and fix the feature JSON there (the reference in your instructions lists the fields).";

const FEASIBLE_KEYS = ["max_feasible_r", "max_feasible_d", "max_feasible_thickness", "max_feasible"] as const;

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** The numbers a refusal's details offer: feasible maxima, expected vs found. */
function detailFacts(details: Record<string, unknown> | undefined): string[] {
  if (!details) return [];
  const out: string[] = [];
  for (const k of FEASIBLE_KEYS) {
    const v = details[k];
    if (typeof v === "number" && Number.isFinite(v)) out.push(`largest value that builds: ${k} = ${num(v)}`);
  }
  if (details["expected"] !== undefined && details["found"] !== undefined && typeof details["found"] !== "object") {
    out.push(`expected ${JSON.stringify(details["expected"]).slice(0, 80)}, found ${JSON.stringify(details["found"]).slice(0, 80)}`);
  }
  return out;
}

export interface OpsRefusal {
  code: string;
  details?: Record<string, unknown>;
  errors?: ReadonlyArray<{ code: string; path?: string }>;
}

/**
 * The hint lines for a refusal: the code's playbook entry, then — for `COMMAND_FEATURE_FAILS` and
 * `COMMAND_PARAM_FAILS` — the inner code's, then the rejection problems' codes (at most three), and
 * the numbers the details offer. Never empty.
 */
export function opsRepairHint(r: OpsRefusal): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (code: string | undefined): void => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    const h = OPS_PLAYBOOK[code];
    if (h) lines.push(h);
  };
  add(r.code);
  const inner = typeof r.details?.["code"] === "string" ? (r.details["code"] as string) : undefined;
  add(inner);
  for (const e of (r.errors ?? []).slice(0, 3)) add(e.code);
  lines.push(...detailFacts(obj(r.details?.["details"]) ?? r.details));
  if (lines.length === 0) lines.push(GENERIC_IR_HINT);
  return lines;
}
