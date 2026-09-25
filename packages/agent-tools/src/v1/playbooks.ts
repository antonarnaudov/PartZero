/**
 * IR v1 operation playbooks (W10): every code of the SPEC-v1 §7.5 catalogue (`ERROR_CODES` in
 * `schema/ir-v1.constants.json`, generated into `@aicad/ir-types` as `v1.ERROR_CODES`), every
 * CadScript v1 front-end code and the engine plumbing codes map to an actionable repair hint.
 *
 * Hints are **computed from the report's structured `details`** (§7.4) — the feasible values the
 * engine found (`max_feasible_r`, `max_feasible_d`, `max_feasible_thickness`), reference candidates
 * with their display names, probes and synthesised queries (and the one-step
 * `accept_ref_candidate` call that applies one), the suggested constraint removal, distances,
 * units — plus the report (feature ids → names, the failed upstream feature or parameter) and the
 * compiled IR (reference fields, parameter declarations, literal sketch geometry). Nothing here
 * parses an engine `message`. A static hint is the fallback, never an empty string.
 */
import ts from "typescript";
import { v1 as cs } from "@aicad/cadscript";
import { v1 as ir, type metricsV1, type SketchCurve } from "@aicad/ir-types";
import { capList, ident, jsonQuote, num, numDown, numExact, numUp, oneLine, plural, quoteId, vec } from "../format.js";
import { staticHint as staticHintV0 } from "../playbooks.js";
import { distanceToCurve, endpointIssues, firstCrossing, nearestEnds, type CurveEnd } from "../sketch-geom.js";
import { parameterUsersV1 } from "./param-uses.js";
import {
  atPointer,
  displayName,
  featureName,
  irFeatureByName,
  list,
  numberOf,
  obj,
  originText,
  probeText,
  queryText,
  str,
  strings,
  valueText,
  type Details,
  type V1View,
} from "./render.js";

/** The v1 error-code catalogue: code → `{ stage, section, details, since }` (SPEC-v1 §7.5). */
export const ERROR_CODES_V1 = ir.ERROR_CODES as unknown as Readonly<Record<string, { stage: string; section: string; details: readonly string[]; since: string }>>;

/** Every catalogue code, sorted. */
export function catalogueCodesV1(): string[] {
  return Object.keys(ERROR_CODES_V1).sort();
}

/** Stage of a catalogue code: `R`, `E`, `R/E`, `W` (warning) or `I` (info); undefined for other codes. */
export function codeStageV1(code: string): string | undefined {
  return ERROR_CODES_V1[code]?.stage;
}

/** Engine plumbing (`@aicad/evals` / the v1 engines): not the model's fault. */
export const ENGINE_ERROR_CODES_V1 = ["ENGINE_UNAVAILABLE", "ENGINE_FAILED", "ENGINE_TIMEOUT", "ENGINE_BAD_OUTPUT", "FIXTURE_MISSING"] as const;

/**
 * Document-level failures outside the catalogue: reads that fail before validation (SPEC-v1 §0.5
 * rule 4), and the native `aicad` CLI's own — `IR_READ_ERROR` (the file could not be read) and
 * `IR_INVALID` (a rejection whose error list came back empty).
 */
export const DOCUMENT_ERROR_CODES_V1 = ["IR_PARSE_ERROR", "IR_SCHEMA_INVALID", "IR_READ_ERROR", "IR_INVALID"] as const;

/**
 * Codes the Forge v1 path emits that are not in the v1 catalogue, with the catalogue code whose
 * hint they get: forge-ops' `OpError::InvalidParameter` is v0's INVALID_PARAMETER, passed through
 * forge-regen with the INVALID_VALUE family's details `{ field, value, expected }` (reported for
 * Forge W3–W6: it should emit a catalogue code).
 */
export const FORGE_CODE_ALIASES_V1: Readonly<Record<string, string>> = { INVALID_PARAMETER: "INVALID_VALUE" };

/** Tool names the hints tell the agent to call (kept in one place so a rename cannot drift). */
export const HINT_TOOLS = {
  apply: "apply_cadscript",
  setParam: "set_param",
  acceptCandidate: "accept_ref_candidate",
  acceptProposal: "accept_ref_proposal",
  sketchEdit: "sketch_edit",
  query: "query",
  describe: "describe",
} as const;

/**
 * What Forge cannot evaluate yet, and how to model the same geometry with the operations it has
 * (`UNSUPPORTED_FEATURE` / `UNSUPPORTED_FEATURE_VERSION` with no supported versions).
 */
const WORKAROUNDS: Readonly<Record<string, string>> = {
  hole: "draw the holes as circles in a sketch on that face and cut them: extrude(sketch, { distance, op: \"cut\", targets: … }) (a blind hole is a cut of its depth; a counterbore is a second, wider and shallower cut)",
  fillet: "round the corners in the profile instead: rect({ …, r }) for a rounded rectangle, or arcs between the lines of the sketch",
  chamfer: "cut the bevel into the profile instead: a sloped line in the revolve half-profile or the extrude outline",
  shell: "cut the cavity: an inset profile (rect with w − 2·wall, h − 2·wall) extruded with op \"cut\" from the top, depth = height − floor",
  pattern: "write every instance out (one feature per copy, or the positions in one sketch / one hole placement)",
  draft: "leave the walls vertical and list the missing draft under known_issues",
};

const CURVE_RULES = "Every line/arc end must coincide (≤ 1e-6 mm) with exactly one other curve end; a circle is a loop by itself.";

/**
 * Static hints, one per code. Computed hints (below) replace or extend them where the details,
 * the report or the IR allow. Written for CadScript v1: `param(…)`, queries, `.one()`, tools.
 */
export const PLAYBOOK_V1: Readonly<Record<string, string>> = {
  // ── Document and ids (R) ──
  UNSUPPORTED_SCHEMA: 'The document must be "aicad.ir/1"; CadScript v1 writes it — write plain CadScript, not IR JSON.',
  NO_PARTS: 'A file needs at least one part("name") followed by its features.',
  DUPLICATE_ID: "Two curves, constraints, hole positions or features share an id: give each a distinct key.",
  DUPLICATE_NAME: "Parameter and feature consts share one namespace per file: rename one of them.",
  INVALID_NAME: "Names match [A-Za-z_][A-Za-z0-9_]* (at most 64 characters).",
  INVALID_ID: 'Ids match [A-Za-z_][A-Za-z0-9_]* (at most 64 characters); curve references are ids joined by "." (e.g. "outline.bottom").',
  RESERVED_NAME: "Rename the const: reserved words and @aicad/std builtins (part, sketch, hole, fillet, param, …) cannot name parameters or features.",
  UNSUPPORTED_FEATURE: "This engine does not implement that feature type: model the geometry with the operations it has.",
  UNSUPPORTED_FEATURE_VERSION: "This engine does not implement that feature (version) yet: model the geometry with the operations it has.",
  UNRESOLVED_SKETCH: "extrude/revolve take a sketch const declared above, in the same part.",
  UNRESOLVED_FEATURE: "Reference a feature declared above in the same part (a datumPlane/datumAxis where a datum is expected).",
  NON_FINITE: "Numbers must be finite.",
  EMPTY_SKETCH: "A sketch needs at least one curve: line(…), arc({…}), circle({…}), rect({…}), slot({…}), polygon({…}).",
  // ── Options (R) ──
  CURVE_OPTIONS_CONFLICT: "rect takes exactly one of center/corner; polygon exactly one of circumradius/inradius/acrossFlats/side.",
  CONSTRAINT_VALUE_REQUIRED: "Give the dimension a value, C.distance(a, b, 20), or make it a reference dimension: { driving: false }.",
  CONSTRAINT_VALUE_ON_REFERENCE: "A reference dimension ({ driving: false }) is measured: remove its value.",
  PATTERN_OPTIONS_CONFLICT: "op/targets are for body seeds only; dir2 and spacing2 come together, and count2 needs them.",
  DATUM_OPTIONS_CONFLICT: "Use exactly one form: { offset, distance }, { from, axis, angle }, { midplane }, { through } or { origin, normal, xDir } (datumAxis: edge, cylinder, planes or points).",
  CHAMFER_OPTIONS_CONFLICT: "A chamfer is { d }, { d, d2, side } or { d, angle, side }.",
  HOLE_SIZE_UNKNOWN: 'Sizes are "M2", "M2.5", "M3", "M4", "M5", "M6", "M8" — or give an explicit diameter d.',
  HOLE_SIZE_REQUIRED: 'Give a size ("M3", …) or an explicit diameter d.',
  HOLE_OPTIONS_CONFLICT: "At most one of cbore, csink, insert; presets need a size; thread excludes insert and close/loose fits; tip is for blind holes; depth is not allowed with insert.",
  HOLE_DEPTH_REQUIRED: 'Give a depth: "through", { blind: 6 } or { upTo: face } (inserts set their own).',
  BOOLEAN_TARGETS_REQUIRED: 'op "join"/"cut"/"intersect" needs targets: "all", a body query or a feature handle (targets: slab).',
  PATTERN_SEED_UNSUPPORTED: "Pattern seeds are extrude, revolve or hole features (or bodies).",
  // ── Expressions and parameters ──
  EXPR_SYNTAX: "Fix the expression: + - * / % ** comparisons && || ! ?: and the @aicad/std math functions; at most 4096 bytes and 64 levels (split long ones with param()).",
  EXPR_UNKNOWN_NAME: "Expressions read param() consts declared above (features are not values): declare the parameter first, or fix the spelling.",
  EXPR_UNKNOWN_FUNCTION: "Use the math functions of @aicad/std: min max abs sqrt floor ceil round clamp hypot sin cos tan asin acos atan atan2 (degrees).",
  EXPR_ARITY: "Check the argument count: min/max take ≥ 2, clamp 3, hypot and atan2 2, the others 1.",
  EXPR_UNIT_MISMATCH: "Make the units agree: a bare number takes its neighbour's unit, mm(…)/deg(…) make a literal explicit, counts and ratios multiply lengths, sqrt needs an even unit.",
  EXPR_TYPE_MISMATCH: "A condition (bool) is used as a number or the reverse: compare (x > 0) to make a condition, and use c ? a : b to turn one into a number.",
  EXPR_SCOPE: "A part sees document parameters and its own: move the parameter above the first part(…) to share it.",
  EXPR_DOMAIN: "The expression is undefined for these values (sqrt of a negative, division by zero, asin/acos outside [−1, 1], tan at 90°): change the parameter values (set_param) or guard with max/clamp.",
  EXPR_NOT_INTEGER: "A count must be a whole number: wrap the expression in round(…)/floor(…)/ceil(…), or change its inputs.",
  PARAM_INVALID: "param(value, { unit, min, max, note }): unit is mm/deg/ratio/count/bool; no bounds on a bool; exactly one value.",
  PARAM_CYCLE: "Parameters may not depend on themselves: make one parameter of the cycle a literal.",
  PARAM_OUT_OF_RANGE: "The parameter's value is outside its [min, max]: set a value inside the range (set_param) or change the bound.",
  PARAM_FAILED: "The feature uses a parameter that failed: fix that parameter's own error; the feature recovers by itself.",
  MEASURE_NOT_REFERENCE: "Measured parameters arrive with IR v1.1: use a param() value and a driving dimension instead.",
  MEASURE_UNIT_MISMATCH: "Measured parameters arrive with IR v1.1: use a param() value and a driving dimension instead.",
  MEASURE_FORWARD: "Measured parameters arrive with IR v1.1: use a param() value and a driving dimension instead.",
  // ── Range checks (R on literals, E on expressions) ──
  INVALID_DISTANCE: 'Distances are positive lengths (> 1e-6 mm); to go the other way use direction: "reverse", not a negative distance.',
  INVALID_ANGLE: "Angles are degrees with 0 < angle ≤ 360 (360 = full turn).",
  INVALID_AXIS: "The axis needs a finite origin and a non-zero direction in sketch [u, v] coordinates, e.g. { origin: [0, 0], direction: [0, 1] }.",
  INVALID_PLANE: "frame() needs non-zero, perpendicular normal and xDir (dot product 0), e.g. normal [0, 0, 1] with xDir [1, 0, 0].",
  INVALID_RADIUS: "The radius is a positive length in mm.",
  INVALID_COUNT: "The count is too small (pattern count ≥ 1, circular ≥ 2, polygon n ≥ 3, grid/bolt circle ≥ 1).",
  INVALID_VALUE: "The value is outside its valid range (see expected).",
  INVALID_PARAMETER: "The value is outside its valid range (see expected): change it, or the parameters its expression uses.",
  INVALID_CARDINALITY: "A single-entity argument takes .one() (or no count); counts are .one(), .some(), .any() or .exactly(n ≥ 1).",
  // ── Sketches ──
  DEGENERATE_CURVE: "Lines need two distinct points; arcs and circles a radius > 1e-6 mm; an arc's start and end must differ (use circle() for a full turn).",
  INCONSISTENT_ARC: "An arc's start and end must be the same distance from its center (within 1e-6 mm).",
  SKETCH_MIXED_MODE: "A constrained sketch holds literal lines, arcs, circles and points: drop the constraints and drive the rect/slot/polygon with parameters, or draw lines and constrain them.",
  SKETCH_UNKNOWN_REFERENCE: 'Constraint arguments are entity ids of this sketch: "l", "l.start", "l.end", "a.center", "outline.bottom".',
  SKETCH_WRONG_ENTITY_TYPE: "The constraint takes a different entity type there (point, line, circle or arc).",
  SKETCH_NOT_A_DIMENSION: "Only distance, angle, radius and diameter take a value or { driving }.",
  SKETCH_UNSUPPORTED_COMBINATION: "tangent needs a line and a circle/arc or two circles/arcs; equal needs two lines or two circles/arcs.",
  SKETCH_SELF_REFERENCE: "The two arguments of a constraint must be different entities.",
  SKETCH_INVALID_DIMENSION: "distance, radius and diameter values must be > 0.",
  SKETCH_CONSTRAINT_CONFLICT: "The constraints contradict each other: remove the suggested one (sketch_edit { sketch, remove: [id] }) or change a dimension so they agree.",
  SKETCH_SOLVE_FAILED: "The solver did not converge: start the geometry closer to the intended shape, or remove the constraints of the listed cluster and add them back one at a time.",
  SKETCH_UNDER_CONSTRAINED: "Informational: the sketch can still move. Add constraints or dimensions only if the shape must not change when parameters do.",
  SKETCH_REDUNDANT_CONSTRAINTS: "Some constraints are implied by others: remove the redundant ones (sketch_edit { sketch, remove: [ids] }).",
  SKETCH_LOOP_FLIPPED: "The solver jumped to a mirrored shape: move the stored geometry closer to the intended solution or add a constraint that fixes the orientation (an angle, or fix one point).",
  SKETCH_OPEN_LOOP: `A curve end meets no other curve end. ${CURVE_RULES}`,
  SKETCH_BRANCHING: `Three or more curve ends meet at one point. ${CURVE_RULES} Remove the duplicate curve, or move one loop so the loops do not touch.`,
  SKETCH_CURVES_CROSS: "Two curves cross or touch away from a shared endpoint (curves are never split). Holes lie strictly inside their outline with a wall left; separate outlines must not touch.",
  SKETCH_DEGENERATE_LOOP: "A loop encloses (almost) zero area — usually a curve that doubles back over another: remove the doubled curve.",
  SKETCH_NO_REGIONS: "The sketch has no closed loop of non-construction curves: close the outline (lines/arcs end to end, or a circle/rect).",
  SKETCH_SUPPRESSED: "The feature consumes a suppressed sketch: remove `suppressed` from the sketch, or delete this feature.",
  REGION_NOT_FOUND: "regions lists curves of the outer loop of the regions to sweep: name a curve on a region's outer loop (inner-loop and construction curves select nothing).",
  REVOLVE_CROSSES_AXIS: "Every revolved region must stay on one side of the axis (touching it is fine): move the offending side onto the axis, or move the axis.",
  // ── Planes, axes, datums ──
  PLANE_NOT_PLANAR: "Sketches, holes and datums need a planar face: narrow the query to a plane (.planes(), .cap(\"end\"), .normal(\"+Z\")), or use a datumPlane.",
  PLANE_DEGENERATE: "The xDir of a face frame must not be parallel to the face normal: give an xDir in the face plane, or omit it.",
  AXIS_REF_UNSUPPORTED: "An axis comes from a line edge, a circular edge (its axis), a cylindrical or conical face, a datumAxis or { line: { origin, direction } }.",
  DATUM_DEGENERATE: "The datum is undefined for these inputs (non-parallel midplane faces, collinear points, an axis not in the plane): pick inputs that define it.",
  // ── References and queries ──
  REF_KIND_MISMATCH: "The query selects the wrong kind of entity for this argument: navigate with .faces(), .edges(), .vertices() or .owner().",
  QUERY_INVALID: "A query step does not apply here (see the expected and found kinds or feature types).",
  QUERY_UNKNOWN_CURVE: 'Name a profile curve of the sketch the feature consumed (compound members are "<id>.left", "<id>.cap_a", "<id>.e0", …).',
  REF_MISSING: "The reference matches nothing: re-aim the query (the query tool shows what a selector matches), or accept a candidate (accept_ref_candidate).",
  REF_AMBIGUOUS: "The reference matches several entities where one is needed: accept the right candidate (accept_ref_candidate) or narrow the query (.max(\"+Z\"), .normal(\"-Y\"), .radius(3), …).",
  REF_SPLIT: "The referenced entity was split into pieces: accept the piece you mean (accept_ref_candidate), or take every piece with .some().",
  REF_UNCERTAIN: "The reference only matched geometrically, not by name: confirm the candidate (accept_ref_candidate) or re-aim the query.",
  REF_CARDINALITY: "The query matches a different number of entities than .exactly(n) declares: narrow the query or fix the count.",
  REF_REPAIRED: "Informational: the reference was re-bound to geometry-identical entities; accept_ref_proposal makes the new query permanent.",
  REF_MERGED: "Informational: the referenced entity merged into another one; the reference follows it.",
  REF_SPLIT_ACCEPTED: "Informational: the referenced entity was split and the reference takes every piece.",
  REF_SET_CHANGED: "The query now selects a different set than when the reference was accepted: if intended, accept_ref_proposal; otherwise narrow the query.",
  REF_KIND_CHANGED: "A referenced entity changed type (e.g. a plane became a cylinder): check the feature still does what was meant.",
  REF_NEIGHBORHOOD_CHANGED: "A referenced entity has fewer same-carrier neighbours than when accepted (something merged): check the result.",
  DEPENDENCY_FAILED: "A feature this one uses failed: fix that feature's own error; this one recovers by itself.",
  DEPENDENCY_SUPPRESSED: "A datum, tag or seed this feature uses by id is suppressed: un-suppress it or stop referencing it.",
  // ── Booleans ──
  BOOLEAN_NO_INTERSECTION: "The tool does not meet any target: move it (sketch plane, direction \"reverse\", distance), or target the body it should touch.",
  BOOLEAN_EMPTY_RESULT: "The intersection is empty for every target: the tool and targets do not overlap.",
  BOOLEAN_NON_MANIFOLD: "The result would touch itself only along an edge or at a point: overlap the bodies by a positive amount, or keep a gap.",
  BOOLEAN_TOOL_IS_TARGET: "A body cannot be both a target and a tool: target the other body.",
  BOOLEAN_SPLIT: "Informational: the operation split a body into pieces; references to it see every piece.",
  BOOLEAN_BODY_CONSUMED: "The operation removed a whole target body: if that was not intended, the tool is larger than the target.",
  // ── Holes ──
  HOLE_POINT_OFF_FACE: "A hole position lies outside the face it is placed on: move it inside the face (positions are (u, v) in the face frame).",
  HOLE_DUPLICATE_POSITION: "Two hole positions coincide: remove or move one.",
  HOLE_UP_TO_MISSED: "The upTo face is not hit along the drilling direction: pick a face below the position, or flip the hole.",
  HOLE_MISSES_BODY: "The hole's tool does not meet any target body: place it over the body (or set targets).",
  HOLE_BREAKS_THROUGH: 'A blind hole breaks through the far side: use depth "through", or a blind depth less than the wall.',
  // ── Blends, shell, draft ──
  FILLET_RADIUS_TOO_LARGE: "The radius is larger than the geometry allows: use r ≤ the reported max feasible r, or fillet before the feature that narrowed the face.",
  FILLET_EDGE_UNSUPPORTED: "Fillets need edges between two faces of one body (plane, cylinder, cone, sphere, torus) that are not smooth: narrow the edge query (.convex(), .lines()).",
  FILLET_FAILED: "The fillet could not be built: try a smaller r, fewer edges per feature, or fillet in a different order.",
  CHAMFER_DISTANCE_TOO_LARGE: "The distance is larger than the geometry allows: use d ≤ the reported max feasible d.",
  CHAMFER_EDGE_UNSUPPORTED: "Chamfers need edges between two faces of one body that are not smooth: narrow the edge query.",
  CHAMFER_SIDE_NOT_ADJACENT: "side must be a face adjacent to every chamfered edge: pick that face, or split the chamfer into one feature per side.",
  CHAMFER_FAILED: "The chamfer could not be built: try a smaller d or fewer edges per feature.",
  SHELL_THICKNESS_TOO_LARGE: "The wall is thicker than the part allows (opposite walls collide or a curved face degenerates): reduce thickness below the reported maximum.",
  SHELL_FACE_NOT_ON_BODY: "Open faces must belong to the shelled body: pick faces of that body.",
  SHELL_FAILED: "The shell could not be built: try a thinner wall, or shell before adding small features.",
  SHELL_CLOSED_VOID: "Informational: with no open face the body is hollow inside (2 shells); give open faces to make a cup.",
  DRAFT_FACE_UNSUPPORTED: "Draft applies to planar faces only: narrow the face query to planes.",
  DRAFT_FAILED: "The draft could not be built: reduce the angle or draft fewer faces.",
  // ── Patterns ──
  PATTERN_ALL_INSTANCES_FAILED: "Every pattern instance failed: check spacing/direction/axis so the copies land on the body.",
  PATTERN_INSTANCE_SKIPPED: "One pattern instance was skipped (it missed the body or failed): adjust the count/spacing, or skip it explicitly with skip: [[i]].",
  // ── Engine results ──
  INVALID_RESULT: "The engine produced an invalid body: simplify the geometry near this feature (avoid near-tangent curves, slivers, walls thinner than 0.01 mm) and re-apply.",
  // ── Document reads ──
  IR_SCHEMA_INVALID: "The engine rejected the document structure; this should not happen for compiled CadScript — report it under known_issues.",
  IR_PARSE_ERROR: "The engine could not parse the document; report it under known_issues.",
  IR_READ_ERROR: "The engine could not read the document file (an environment problem, not your model): retry once; if it persists, report it under known_issues.",
  IR_INVALID: "The engine rejected the document without naming a rule; this should not happen for compiled CadScript — report it under known_issues.",
  // ── Engine plumbing ──
  ENGINE_UNAVAILABLE: "The geometry engine is not available. This is an environment problem, not your model: stop and report it.",
  ENGINE_FAILED: "The engine crashed on this document. Try a simpler variant of the last change; if it persists, report it under known_issues.",
  ENGINE_TIMEOUT: "The engine timed out. Try a simpler variant of the last change; if it persists, report it under known_issues.",
  ENGINE_BAD_OUTPUT: "The engine returned an unreadable report. Retry once; if it persists, report it under known_issues.",
  FIXTURE_MISSING: "Offline replay has no recorded report for this exact model. Re-record fixtures with a real engine.",
  // ── Forge's engine-prefixed codes whose details say what to change (not in the catalogue; the
  //    rest share the engine-internal playbook: FORGE_INTERNAL_CODES_V1) ──
  FORGE_PATTERN_HOLE_BREAKS_THROUGH:
    'A pattern copy of a blind hole breaks through the far side (the material under that copy is thinner than the hole is deep): give the seed hole depth "through" if through holes are meant, else a blind depth under the thinnest wall below every copy; or move the copies onto thicker material (dir/spacing/count), or leave that instance out (skip: [[i]]).',
  FORGE_PATTERN_HOLE_POSITION_MISSED:
    "A pattern copy of one hole position lands off the body (the instance's other positions hit it, so the instance is kept without that hole): change dir/spacing/count so every copy lands on the body, move that seed position, or leave the instance out (skip: [[i]]).",
  FORGE_PATTERN_HOLE_TOP_INSIDE:
    "A pattern copy of a hole starts inside the material, so the copied hole is closed at its top: the pattern moves the hole off the face it is drilled from (a dir or axis not in that face's plane, or a mirror). Pattern holes along their face only (dir in the face plane; a circular axis parallel to the drilling direction), or put a separate hole on the face that copy should open onto.",
  FORGE_PATTERN_THROUGH_COPY_TOO_SHORT:
    "A pattern copy of a through hole would end inside the material (the seed's through length is too short where the copy lands), and Forge does not cut that blind pocket: put the positions into the hole feature itself (grid, boltCircle or a position list), where each position drills through on its own.",
  FORGE_PATTERN_HOLE_SEED_MISMATCH:
    "Forge could not check the copies of a hole seed (an engine inconsistency, not your model): put the positions into the hole feature itself (grid, boltCircle or a position list) instead of patterning the hole; if it persists, report it under known_issues.",
  FORGE_PATTERN_TOO_MANY_INSTANCES: "The pattern defines more instances than Forge builds (details: max): lower count (and count2), or split it into several patterns.",
  FORGE_PATTERN_TOO_MANY_COPIES: "Instances × seed bodies is more copies than Forge builds (details: max): lower the count, or pattern fewer seeds (bodies or hole positions) per pattern.",
  FORGE_PATTERN_MIRROR_UNSUPPORTED: "Forge cannot represent this mirrored entity exactly: model the mirrored side directly (a second sketch and feature with mirrored coordinates) instead of mirror().",
  FORGE_HOLE_THREAD_DEEPER_THAN_HOLE: "The cosmetic thread is deeper than the hole: give thread: { depth } at most the hole's depth, leave depth out (the full hole depth), or make the hole deeper.",
  FORGE_HOLE_UP_TO_UNSUPPORTED: 'Forge drills upTo planar faces only: use a blind depth equal to the distance to that face (depth: { blind: d }), "through", or upTo a planar face.',
  FORGE_HOLE_TOO_MANY_POSITIONS: "More hole positions than Forge builds in one hole feature (details: max): use at most that many (fewer grid rows/columns, a smaller boltCircle n), or split them over several hole features.",
  FORGE_LIMIT_EXCEEDED: "The sketch is larger than Forge builds (a polygon with too many sides, or too many curves after expansion; details: limit): lower n (a circle for a round outline), or split the sketch.",
  FORGE_BOOLEAN_NEAR_COINCIDENT:
    "Two faces of the operands are almost, but not exactly, coincident (closer than Forge can separate): make them coincide exactly (the same value, from one parameter) or move one at least the reported limit away (0.01 mm is plenty).",
  FORGE_BOOLEAN_UNSUPPORTED: "Forge's boolean cannot intersect this kind of surface yet (details: what, entity): build that region from planes, cylinders, cones, spheres or tori, or order the features so this operation does not meet it; if it cannot be avoided, report it under known_issues.",
  FORGE_BOOLEAN_NO_CHANGE: "Informational: the operation left some target bodies as they were (a cut that misses them, a join whose tools lie inside them): if a target should have changed, move the tool onto it or narrow targets.",
  FORGE_BOOLEAN_UNCERTIFIED: "Informational: Forge could not certify an intersection complete, but the result passed its validity and volume checks; check the result's volume and faces.",
  FORGE_PROBE_FAILED:
    "Forge could not place a probe point on an entity, so it is left out of the report (not a modelling error): if the model is as intended, accept the warning; a reference that needs that entity fails with this code — re-aim it at a neighbouring face or edge.",
  FORGE_UNSUPPORTED_FEATURE: "Forge does not evaluate that feature type: model the geometry with the operations it has.",
  // ── The OCCT oracle's own codes (a test engine: its limitations, not spec errors; others: ORACLE_INTERNAL_HINT_V1) ──
  ORACLE_SOLVE_REQUIRES_REPLAY:
    "The OCCT oracle does not solve sketch constraints (SPEC-v1 §8.1): it evaluates a constrained sketch only when the stored geometry already satisfies them. Evaluate constrained sketches on Forge; on the oracle, draw the geometry at its solved sizes without constraints (rect/circle/slot driven by param(), or literal lines and arcs).",
  ORACLE_UNSUPPORTED_FEATURE: "The OCCT oracle does not evaluate this feature type: evaluate on Forge, or build the same geometry with the operations the oracle has.",
  ORACLE_RESOURCE_LIMIT: "That is an oracle resource limit, not a SPEC rule: stay below it, or evaluate on Forge.",
  ORACLE_COINCIDENCE_UNREALIZED: "Two tools touch, or overlap by less than the tolerance — a contact the oracle cannot build (SPEC-v1 §11.1 open issue 6): overlap them by a clear amount (≥ 0.01 mm) or leave a clear gap.",
  ORACLE_HOLE_PROFILE_FOLDED: "The hole's head (counterbore, countersink or insert) is deeper than the hole itself: make the hole deeper than its head, or the head shallower.",
  ORACLE_REF_FALLBACK_UNSUPPORTED: "A captured entity is gone and the oracle does not implement the geometric fallback (SPEC-v1 §5.7 step 4): re-aim the query at entities that exist now, or evaluate on Forge.",
  ORACLE_REPLAYED: "Informational: the oracle replayed this sketch's solved geometry from the reference report (it does not solve).",
  ORACLE_NORMALIZED: "Informational: the oracle normalized this result (see details); nothing to fix.",
};

/**
 * Forge's engine-prefixed codes that share the engine-internal playbook ("Engine-internal failure
 * … simplify the geometry"): a kernel bug, or a kernel limitation whose details name nothing the
 * model can change. Every other FORGE_ code the v1 path emits has its own hint. The coverage test
 * (`test/v1/playbooks-v1.test.ts`) reads the Rust sources: an unlisted FORGE_ code without its own
 * hint fails it, and so does a listed one that is a warning or info, or that documents
 * user-actionable details (a limit, a depth, a position, an instance).
 */
export const FORGE_INTERNAL_CODES_V1: Readonly<Record<string, string>> = {
  FORGE_BOOLEAN_INCONSISTENT: "the boolean's own consistency check failed (reported instead of a possibly wrong body)",
  FORGE_BOOLEAN_INVALID_RESULT: "the boolean's result failed Forge's validity checks",
  FORGE_BOOLEAN_NO_OPERANDS: "an operation reached the boolean with nothing to combine",
  FORGE_BOOLEAN_SSI: "the surface–surface intersection failed (details: its diagnostics)",
  FORGE_DATUM_NOT_EVALUATED: "the inner code of a DEPENDENCY_FAILED: a datum with no evaluated frame",
  FORGE_EXPR_UNAVAILABLE: "an expression the reference resolver could not read",
  FORGE_FACE_AREA_NOT_POSITIVE: "a validation issue inside a blend result",
  FORGE_HOLE_INTERNAL: "any other hole failure",
  FORGE_HOLE_TOOL: "a hole's tool body could not be built (details: the underlying reason)",
  FORGE_INTERNAL: "Forge's generic internal failure (a geometry, topology or bookkeeping error of an operation)",
  FORGE_INVALID_CURVE_ID: "a curve id that cannot be part of a provenance name (v1 validation rejects such ids first)",
  FORGE_NON_FINITE: "a non-finite measure of a result",
  FORGE_PATTERN_INTERNAL: "any other pattern failure",
  FORGE_PATTERN_INVALID_COPY: "a moved copy failed Forge's validity checks",
  FORGE_PATTERN_SEED_UNAVAILABLE: "a pattern seed kept no tools to copy",
  FORGE_STALE_ENTITY: "an entity missing from the reference resolver's scope",
};

/** The fallback for the OCCT oracle's other codes (report findings, replay checks, OCCT failures). */
export const ORACLE_INTERNAL_HINT_V1 =
  "The OCCT oracle (a test engine) could not evaluate this: its own limitation or failure, not a spec error. Evaluate on Forge; if the oracle is the only engine, simplify the geometry near this feature and report it under known_issues.";

/** The static hint of a code (v1 table, then CadScript v1's own hints, the oracle's fallback, then the v0 fallbacks for CS_/TS/engine prefixes). */
export function staticHintV1(code: string): string | undefined {
  const own = PLAYBOOK_V1[code];
  if (own !== undefined) return own;
  const compiler = cs.hintFor(code);
  if (compiler !== undefined) return `${compiler[0]!.toUpperCase()}${compiler.slice(1)}.`;
  if (code.startsWith("ORACLE_")) return ORACLE_INTERNAL_HINT_V1;
  return staticHintV0(code);
}

/** Every code with a static v1 hint (catalogue, CadScript v1 diagnostics, engine plumbing), sorted. */
export function coveredCodesV1(): string[] {
  return [...new Set([...Object.keys(PLAYBOOK_V1), ...Object.keys(cs.DIAGNOSTIC_CODES)])].sort();
}

// ─── Computed hints ─────────────────────────────────────────────────────────────────────────────

export interface V1HintContext extends V1View {
  /** The code's structured details (§7.4). */
  details?: Details | undefined;
  /** The feature report entry the error or warning belongs to. */
  feature?: metricsV1.FeatureReport | undefined;
  /** For parameter errors: the parameter's name. */
  param?: string | undefined;
}

/** IR `round`: halves away from zero (SPEC-v1 §2.6), unlike `Math.round` (−2.5 → −2). */
export function roundHalfAway(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/**
 * A provenance key as a display name (SPEC-v1 §5.2): the feature ids in it (`f_e/side:o.left`,
 * `f_e/edge:{f_e/side:a|f_e/side:b}`) become the features' names (`e/side:o.left`) where the report
 * or the IR knows them; unknown ids stay as they are.
 */
export function entityName(view: V1View, key: string): string {
  return displayName(key.replace(/(^|[{|])([A-Za-z_][A-Za-z0-9_]*)\//g, (_m, pre: string, id: string) => `${pre}${featureName(view, id)}/`));
}

/** Upper-case the first letter (sentences that start with a generated phrase). */
function cap(text: string): string {
  return text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** A reference field (a JSON pointer the engine made, e.g. `/on/face`): shown bare when it is one. */
function fieldText(field: string): string {
  return /^(\/[A-Za-z0-9_~.-]*)+$/.test(field) ? field : jsonQuote(field.slice(0, 120));
}

/** Descriptive detail text (expected/found/reason written by the engine): one line, unquoted. */
function plain(v: unknown): string {
  if (typeof v === "string") return oneLine(v, 160);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.map((x) => oneLine(x as string, 60)).join(" or ");
  return valueText(v);
}

function fname(ctx: V1HintContext): string | undefined {
  return ctx.feature?.feature;
}

function literalCurves(ctx: V1HintContext, sketchName: string | undefined): SketchCurve[] | undefined {
  if (sketchName === undefined) return undefined;
  const f = irFeatureByName(ctx.ir, sketchName);
  if (!f || f.type !== "sketch") return undefined;
  const isNum = (v: unknown) => v === undefined || typeof v === "number" || (Array.isArray(v) && v.every((x) => typeof x === "number"));
  const out: SketchCurve[] = [];
  for (const c of f.curves as unknown as Record<string, unknown>[]) {
    if (c["construction"] === true || c["kind"] === "point") continue;
    // Compound curves and expressions: the engine's values are not known here (no evaluator in TS).
    if (c["kind"] !== "line" && c["kind"] !== "arc" && c["kind"] !== "circle") return undefined;
    if (!["start", "end", "center", "radius"].every((k) => isNum(c[k]))) return undefined;
    out.push(c as unknown as SketchCurve);
  }
  return out;
}

function pt(p: readonly number[]): string {
  return `(${p.map(num).join(", ")})`;
}

function endName(e: CurveEnd): string {
  return `${quoteId(e.curve)}.${e.which}`;
}

/** The sketch a failing sketch-stage code belongs to: the feature itself, or the sketch it consumes. */
function sketchNameOf(ctx: V1HintContext): string | undefined {
  const name = fname(ctx);
  if (name === undefined) return undefined;
  const f = irFeatureByName(ctx.ir, name);
  if (!f) return ctx.feature?.type === "sketch" ? name : undefined;
  if (f.type === "sketch") return f.name;
  if ((f.type === "extrude" || f.type === "revolve") && typeof f.sketch === "string") return featureName(ctx, f.sketch);
  return undefined;
}

function openLoopHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const curve = str(d, "curve");
  const end = str(d, "end");
  const point = list(d, "point").filter((x): x is number => typeof x === "number");
  if (curve === undefined) return undefined;
  const head = `The ${end ?? "end"} of curve ${quoteId(curve)}${point.length === 2 ? ` at ${pt(point)}` : ""} meets no other curve end.`;
  const curves = literalCurves(ctx, sketchNameOf(ctx));
  if (!curves) return `${head} Make it coincide exactly with the end it should join (copy the numbers), or add the missing curve. ${CURVE_RULES}`;
  const issue = endpointIssues(curves).find((i) => i.partners.length === 0 && i.end.curve === curve && (end === undefined || i.end.which === end)) ?? endpointIssues(curves).find((i) => i.partners.length === 0);
  if (!issue) return `${head} ${CURVE_RULES}`;
  const near = nearestEnds(curves, issue.end, 1)[0];
  if (!near) return `${head} The sketch has a single open curve: close the loop with more curves.`;
  const alsoOpen = endpointIssues(curves).some((i) => i.partners.length === 0 && i.end.index === near.end.index && i.end.which === near.end.which);
  return `${head} The nearest curve end is ${endName(near.end)} ${pt(near.end.p)}, ${num(near.distance)} mm away${alsoOpen ? " (also unmatched — these two are meant to meet)" : ""}: set ${endName(near.end)} to ${vec(issue.end.p)} or ${endName(issue.end)} to ${vec(near.end.p)}. ${CURVE_RULES}`;
}

function branchingHint(d: Details | undefined): string | undefined {
  const curve = str(d, "curve");
  if (curve === undefined) return undefined;
  const point = list(d, "point").filter((x): x is number => typeof x === "number");
  const partners = strings(d, "partners").map((p) => p.replace(/:(start|end)$/, ".$1"));
  return `The ${str(d, "end") ?? "end"} of ${quoteId(curve)}${point.length === 2 ? ` at ${pt(point)}` : ""} meets ${plural(partners.length, "other curve end")} (${partners.map((p) => ident(p)).join(", ")}); exactly one may meet it. Remove the duplicate or overlapping curve, or move one loop so the loops do not touch. ${CURVE_RULES}`;
}

function crossingHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const first = str(d, "first");
  const second = str(d, "second");
  if (first === undefined || second === undefined) return undefined;
  const point = list(d, "point").filter((x): x is number => typeof x === "number");
  if (point.length !== 2) return `Curves ${quoteId(first)} and ${quoteId(second)} overlap along a stretch: delete one, or make them meet only at shared endpoints.`;
  let extra = " Curves may only meet end to end: split the shape there into curves that share endpoints, or move one of them.";
  const curves = literalCurves(ctx, sketchNameOf(ctx));
  const a = curves?.find((c) => c.id === first);
  const b = curves?.find((c) => c.id === second);
  const circle = a?.kind === "circle" ? a : b?.kind === "circle" ? b : undefined;
  const other = circle === a ? b : a;
  if (circle && other) {
    const dd = distanceToCurve(circle.center, other);
    extra = ` The circle's center is ${num(dd)} mm from ${quoteId(other.id)} but its radius is ${num(circle.radius)}: move it so that distance exceeds the radius by a wall (e.g. ≥ ${num(circle.radius + 1)} mm), or reduce the radius.`;
  } else if (curves && !a && !b) {
    const x = firstCrossing(curves);
    if (x?.at) extra = ` (First crossing found in the literal geometry: ${quoteId(x.a.id)} × ${quoteId(x.b.id)} at ${pt(x.at)}.)${extra}`;
  } else if (/\./.test(first) || /\./.test(second)) {
    extra = " A compound curve (rect/slot/polygon member) is involved: move or shrink the inner curve so it stays inside the outline with a wall left, or grow the outline.";
  }
  return `Curves ${quoteId(first)} and ${quoteId(second)} meet at ${pt(point)}, not at a shared endpoint.${extra}`;
}

function revolveHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const min = numberOf(d, "min");
  const max = numberOf(d, "max");
  const outer = strings(d, "outer_curves");
  if (min === undefined || max === undefined) return undefined;
  const wrongIsNeg = -min <= max;
  const small = wrongIsNeg ? -min : max;
  const big = wrongIsNeg ? max : -min;
  const region = outer.length > 0 ? `The region [${capList(outer, 8, ident).join(", ")}]` : "A region";
  return (
    `${region} spans signed distances [${num(min)}, ${num(max)}] mm from the revolve axis: it lies mostly on the ${wrongIsNeg ? "positive" : "negative"} side (up to ${num(big)} mm) but reaches ${num(small)} mm onto the other side. ` +
    `Move the points on the ${wrongIsNeg ? "negative" : "positive"} side onto the axis (touching is fine), or shift the axis by at least ${numUp(small)} mm so the whole region is on one side${fname(ctx) ? ` (${ident(fname(ctx)!)}'s axis)` : ""}.`
  );
}

function inconsistentArcHint(d: Details | undefined): string | undefined {
  const curve = str(d, "curve");
  const rs = numberOf(d, "r_start");
  const re = numberOf(d, "r_end");
  if (curve === undefined || rs === undefined || re === undefined) return undefined;
  return `Arc ${quoteId(curve)}: |start − center| = ${num(rs)} but |end − center| = ${num(re)}. Keep start and center (r = ${num(rs)}) and move end onto that circle, or move the center onto the perpendicular bisector of start and end.`;
}

// ── Units ──

/** A type environment over every parameter of the IR (hints only: scope is the validator's job). */
export function paramTypeEnv(doc: ir.IrDocument | null | undefined): cs.TypeEnv {
  const params = doc ? [...(doc.params ?? []), ...doc.parts.flatMap((p) => p.params ?? [])] : [];
  const units = new Map(params.map((p) => [p.name, p.unit] as const));
  return {
    lookup: (name) => {
      const u = units.get(name);
      return u === undefined ? { kind: "unknown" } : { kind: "param", unit: u };
    },
    names: () => [...units.keys()],
  };
}

const UNIT_WORDS: Readonly<Record<string, string>> = { mm: "a length (mm)", deg: "an angle (deg)", "1": "a plain number (count or ratio)", bool: "a condition (bool)", "mm^2": "an area (mm^2)", "mm^3": "a volume (mm^3)" };

function unitWord(u: string): string {
  return UNIT_WORDS[u] ?? `unit ${u}`;
}

/**
 * The units of the two operands of a binary expression (`width + holes` → mm and 1), typed with
 * the IR's parameter units; undefined when the text is not a binary expression over known names.
 * `**` (CadScript) is read as the IR's `^`.
 */
export function operandUnits(text: string, doc: ir.IrDocument | null | undefined): { op: string; left: string; leftUnit: string; right: string; rightUnit: string } | undefined {
  const parsed = cs.parseExpr(text.replace(/\*\*/g, "^"));
  if (!parsed.ok) return undefined;
  const ast = parsed.ast as { k: string; op?: string; l?: cs.Expr; r?: cs.Expr };
  if (ast.k !== "bin" || !ast.l || !ast.r || !["+", "-", "<", "<=", ">", ">=", "==", "!="].includes(ast.op ?? "")) return undefined;
  const env = paramTypeEnv(doc);
  const l = cs.typeOf(ast.l, env);
  const r = cs.typeOf(ast.r, env);
  if (!l.ok || !r.ok) return undefined;
  return { op: ast.op!, left: cs.printExpr(ast.l), leftUnit: cs.formatType(l.type), right: cs.printExpr(ast.r), rightUnit: cs.formatType(r.type) };
}

/** Advice for two operands of different units (`+`, `-`, comparisons). */
function operandAdvice(o: NonNullable<ReturnType<typeof operandUnits>>): string {
  const L = `\`${oneLine(o.left, 80)}\``;
  const R = `\`${oneLine(o.right, 80)}\``;
  const head = `${L} is ${unitWord(o.leftUnit)} and ${R} is ${unitWord(o.rightUnit)}: the two sides of \`${o.op}\` must have the same unit.`;
  const lenCount = (a: string, b: string) => a === "mm" && b === "1";
  if (lenCount(o.leftUnit, o.rightUnit) || lenCount(o.rightUnit, o.leftUnit)) {
    const count = o.leftUnit === "1" ? L : R;
    return `${head} Turn the plain number into a length first (e.g. ${count} * pitch, with pitch a length parameter), or use the length you meant.`;
  }
  if ((o.leftUnit === "mm" && o.rightUnit === "deg") || (o.leftUnit === "deg" && o.rightUnit === "mm")) return `${head} A length and an angle never add: convert with trigonometry (r * sin(angle)) or use the parameter you meant.`;
  return `${head} Scale one side (multiply or divide by a parameter) so both units match.`;
}

function unitAdvice(expected: string, found: string, subexpr: string): string {
  const s = `\`${oneLine(subexpr, 120)}\``;
  if (expected === "mm" && found === "1") return `${s} is dimensionless where a length is needed: multiply it by a length parameter (e.g. ${s} * wall), write the literal as mm(…), or declare the parameter with unit "mm".`;
  if (expected === "1" && found === "mm") return `${s} is a length where a plain number is needed: divide it by a length (e.g. ${s} / pitch), or use a "count"/"ratio" parameter.`;
  if (expected === "deg" && found !== "deg") return `${s} is ${found} where an angle is needed: angles are degrees — write deg(…) for a literal, use a parameter with unit "deg", or atan2/asin/acos (which return degrees).`;
  if (expected !== "deg" && found === "deg") return `${s} is an angle where ${expected} is needed: take sin/cos/tan of it (degrees in, ratio out), or use a length parameter.`;
  if (found === "mm^2" && expected === "mm") return `${s} is an area where a length is needed: take sqrt(…) of it, or divide by a length.`;
  if (/\^/.test(found) || /\^/.test(expected)) return `${s} has unit ${found} but ${expected} is needed: balance the multiplications and divisions (e.g. divide by a length).`;
  return `${s} has unit ${found} but ${expected} is needed: make both sides of the operator the same unit.`;
}

// ── Parameters ──

function paramDecl(ctx: V1View, name: string): ir.Parameter | undefined {
  const d = ctx.ir;
  if (!d) return undefined;
  return [...(d.params ?? []), ...d.parts.flatMap((p) => p.params ?? [])].find((p) => p.name === name);
}

function paramRangeHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const name = str(d, "name") ?? ctx.param;
  const value = numberOf(d, "value");
  if (name === undefined || value === undefined) return undefined;
  const min = numberOf(d, "min");
  const max = numberOf(d, "max");
  // Bounds print on their safe side (min rounded up, max down), so a printed value is in range.
  const range = `[${min === undefined ? "−∞" : numUp(min)}, ${max === undefined ? "∞" : numDown(max)}]`;
  const suggestion = max !== undefined && value > max ? numDown(max) : min !== undefined && value < min ? numUp(min) : numExact(value);
  const decl = paramDecl(ctx, name);
  const derived = decl !== undefined && typeof decl.value === "string";
  const fix = derived
    ? `it is derived (${jsonQuote(oneLine(String(decl.value), 120))}): change the parameters it uses, or widen the bound`
    : `${HINT_TOOLS.setParam} { name: ${jsonQuote(name)}, value: ${suggestion} } (or any value in the range), or widen the bound`;
  return `Parameter ${ident(name)} = ${numExact(value)} is outside ${range}: ${fix}.`;
}

function paramFailedHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const p = str(d, "param");
  const code = str(d, "code");
  if (p === undefined) return undefined;
  const entry = ctx.report?.params?.find((x) => x.name === p && x.error);
  const inner = entry?.error ? repairHintV1(entry.error.code, { ...ctx, details: entry.error.details, param: p, feature: undefined }) : undefined;
  return `${fname(ctx) ? `${ident(fname(ctx)!)} uses` : "Uses"} parameter ${ident(p)}, which failed${code ? ` with ${code}` : ""}. Fix the parameter; this feature recovers by itself.${inner ? ` ${ident(p)}: ${inner}` : ""}`;
}

function dependencyHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const id = str(d, "feature");
  if (id === undefined) return undefined;
  const up = featureName(ctx, id);
  const code = str(d, "code");
  // Walk to the root cause: the upstream feature's own error (bounded, cycles impossible in a timeline).
  let root = ctx.report?.features.find((f) => f.feature_id === id);
  for (let i = 0; i < 16 && root?.error?.code === "DEPENDENCY_FAILED"; i++) {
    const next = str(root.error.details, "feature");
    const n = next === undefined ? undefined : ctx.report?.features.find((f) => f.feature_id === next);
    if (!n) break;
    root = n;
  }
  let rootText = root && root.feature !== up && root.error ? ` The root cause is ${ident(root.feature)} (${root.error.code}).` : "";
  if (root?.error?.code === "PARAM_FAILED") {
    const p = str(root.error.details, "param");
    const pe = p === undefined ? undefined : ctx.report?.params?.find((x) => x.name === p)?.error;
    if (p !== undefined) rootText = ` The root cause is parameter ${ident(p)}${pe ? ` (${pe.code})` : ""}, used by ${ident(root.feature)}.`;
  }
  return `${fname(ctx) ? ident(fname(ctx)!) : "This feature"} depends on ${ident(up)}, which failed${code ? ` with ${code}` : ""}.${rootText} Fix ${ident(root?.feature ?? up)} (see its own error and hint); ${fname(ctx) ? ident(fname(ctx)!) : "this feature"} recovers by itself.`;
}

// ── References ──

interface FlatCandidate {
  index: number;
  member: string;
  candidate: Details;
}

/** Candidates of a failed reference, numbered 1… in report order (the order accept_ref_candidate uses). */
export function refCandidates(unresolved: readonly unknown[]): FlatCandidate[] {
  const out: FlatCandidate[] = [];
  for (const u of unresolved) {
    const uo = obj(u);
    for (const c of list(uo, "candidates")) {
      const co = obj(c);
      if (co) out.push({ index: out.length + 1, member: str(uo, "name") ?? "", candidate: co });
    }
  }
  return out;
}

/**
 * SPEC-v1 §5.5 [W0-14]: the Ref fields whose default `card` is not `one`, by feature type and the
 * **full** JSON pointer of the Ref inside the feature (as Forge's validator checks them: body
 * `targets` of extrude/revolve/hole/boolean/pattern and boolean `tools` as BODY_SOME, fillet/chamfer
 * `edges`, draft `faces`, pattern `seed/bodies`, `tag.target`; shell `open` as FACE_ANY). Every
 * other Ref (plane faces, axis edges and faces, vertex points, `depth/up_to`, chamfer `side`, shell
 * `body`, datum-axis `edge`/`face`) designates one entity.
 */
const DEFAULT_CARDS_V1: readonly { types: readonly string[] | "any"; field: string; card: "some" | "any" }[] = [
  { types: "any", field: "/targets", card: "some" },
  { types: "any", field: "/tools", card: "some" },
  { types: ["fillet", "chamfer"], field: "/edges", card: "some" },
  { types: ["draft"], field: "/faces", card: "some" },
  { types: ["pattern"], field: "/seed/bodies", card: "some" },
  { types: ["tag"], field: "/target", card: "some" },
  { types: ["shell"], field: "/open", card: "any" },
];

/** SPEC-v1 §5.5 [W0-14]: the default `card` of the Ref at `field` (a JSON pointer into the feature). */
export function defaultCardV1(featureType: string | undefined, field: string): "one" | "some" | "any" {
  const hit = DEFAULT_CARDS_V1.find((d) => d.field === field && (d.types === "any" || (featureType !== undefined && d.types.includes(featureType))));
  return hit?.card ?? "one";
}

/**
 * Whether `acceptRefCandidate` can replace the whole query of a reference by one candidate's
 * single-entity query without dropping anything: the reference designates one entity (`card`
 * `one` or `1`), exactly one member failed, and every entity it still resolves is one of that
 * member's candidates. `ok: true` when the IR or the report entry is not known (the tool re-checks
 * against the session). SPEC-v1 §5.9 replaces "the reference's query"; with several members that
 * would silently drop the others (a fillet on 1 edge instead of 4).
 */
export function candidateReplacementSafety(
  ref: Record<string, unknown> | undefined,
  featureType: string | undefined,
  field: string,
  entry: { members?: readonly { key: string }[] } | undefined,
  unresolved: readonly unknown[],
): { ok: true } | { ok: false; reason: string } {
  const card = ref === undefined ? undefined : (ref["card"] ?? defaultCardV1(featureType, field));
  if (card !== undefined && card !== "one" && card !== 1) {
    return { ok: false, reason: `the reference selects ${typeof card === "number" ? `exactly ${card}` : card === "some" ? "one or more (.some())" : "any number (.any())"} entities, and a candidate's query selects one` };
  }
  const failed = unresolved.map(obj).filter((u): u is Details => u !== undefined);
  if (failed.length > 1) return { ok: false, reason: `${failed.length} members failed, and one candidate's query would replace all of them` };
  const keys = new Set(refCandidates(unresolved).map((c) => str(c.candidate, "key")).filter((k): k is string => k !== undefined));
  const others = (entry?.members ?? []).filter((m) => !keys.has(m.key));
  if (others.length > 0) return { ok: false, reason: `it still resolves ${plural(others.length, "other entity", "other entities")} (${capList(others, 3, (m) => displayName(m.key)).join(", ")}) that the candidate's query would drop` };
  return { ok: true };
}

/** JSON with object keys sorted (engines serialise the same query with keys in different orders). */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** Identity of a candidate for comparing two lists: member, key, display name and query (keys in any order). */
function candidateIdentity(c: FlatCandidate): string {
  return canonicalJson([c.member, str(c.candidate, "key") ?? null, str(c.candidate, "name") ?? null, c.candidate["query"] ?? null]);
}

/**
 * The unresolved members (with their candidates) of a failed reference, read from **one** source by
 * both the repair hint and `accept_ref_candidate`, so "candidate N" means the same entity in both:
 * the feature's `refs` entry when it lists unresolved members, else the error's `details`. When both
 * list candidates and the two lists differ (order or content), a number would be ambiguous:
 * `conflict` says why, the hint offers no numbered one-step fix and the tool refuses.
 */
export function refUnresolvedV1(detailsUnresolved: readonly unknown[], refUnresolved: readonly unknown[] | undefined): { unresolved: readonly unknown[]; conflict?: string } {
  const fromRef = refUnresolved ?? [];
  if (fromRef.length === 0) return { unresolved: detailsUnresolved };
  if (detailsUnresolved.length === 0) return { unresolved: fromRef };
  const a = refCandidates(fromRef).map(candidateIdentity);
  const b = refCandidates(detailsUnresolved).map(candidateIdentity);
  if (a.length === b.length && a.every((x, i) => x === b[i])) return { unresolved: fromRef };
  return {
    unresolved: fromRef,
    conflict: `the error's details list ${plural(b.length, "candidate")} and the reference's report entry ${plural(a.length, "candidate")}, not in the same order with the same queries, so a candidate number is ambiguous`,
  };
}

function refKind(ctx: V1HintContext, field: string | undefined): string {
  const f = fname(ctx) === undefined ? undefined : irFeatureByName(ctx.ir, fname(ctx)!);
  const ref = f && field !== undefined ? obj(atPointer(f, field)) : undefined;
  return str(ref, "kind") ?? "face";
}

function refHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  const field = str(d, "field");
  const entry = field === undefined ? undefined : ctx.feature?.refs?.find((r) => r.field === field);
  // The same list accept_ref_candidate numbers (refs entry first, then details).
  const source = refUnresolvedV1(list(d, "unresolved"), entry?.unresolved);
  const unresolved = source.unresolved;
  const feature = fname(ctx);
  const where = `${feature ? `${ident(feature)}'s reference` : "The reference"}${field ? ` ${fieldText(field)}` : ""}`;
  const f = feature === undefined ? undefined : irFeatureByName(ctx.ir, feature);
  const ref = f && field !== undefined ? obj(atPointer(f, field)) : undefined;
  const current = ref ? queryText(ctx, ref["q"], str(ref, "kind") ?? "face") : undefined;
  const reasons = [...new Set(unresolved.map((u) => str(obj(u), "reason")).filter((x): x is string => x !== undefined))];
  const what: Record<string, string> = {
    REF_MISSING: "matches nothing",
    REF_AMBIGUOUS: "matches several entities where one is needed",
    REF_SPLIT: "names an entity that was split into pieces",
    REF_UNCERTAIN: "matched only geometrically (no exact name match)",
  };
  const lines = [`${where}${current ? ` (${current})` : ""} ${what[code] ?? "did not resolve"}${reasons.length > 0 ? ` [${reasons.join(", ")}]` : ""}.`];
  const cands = refCandidates(unresolved);
  if (cands.length > 0) {
    lines.push("Candidates:");
    for (const c of cands.slice(0, 6)) {
      const q = c.candidate["query"];
      const conf = numberOf(c.candidate, "confidence");
      lines.push(
        `  ${c.index}. ${displayName(str(c.candidate, "name") ?? "?")} — ${probeText(c.candidate["probe"])}${conf !== undefined && conf > 0 ? `, confidence ${num(conf)}` : ""}${str(c.candidate, "reason") ? `, ${str(c.candidate, "reason")}` : ""}` +
          (q !== undefined ? ` → ${queryText(ctx, q, refKind(ctx, field))}` : " (no query: narrow the query yourself)"),
      );
    }
    if (cands.length > 6) lines.push(`  … ${cands.length - 6} more`);
    const firstWithQuery = cands.find((c) => c.candidate["query"] !== undefined);
    const safety =
      source.conflict !== undefined ? { ok: false as const, reason: source.conflict } : field === undefined ? { ok: true as const } : candidateReplacementSafety(ref, f?.type, field, entry, unresolved);
    if (firstWithQuery && feature !== undefined && field !== undefined && safety.ok) {
      lines.push(
        `Fix in one step: ${HINT_TOOLS.acceptCandidate} { feature: ${jsonQuote(feature)}, field: ${jsonQuote(field)}, candidate: <number> } rewrites the reference to that candidate's query (pick by the probe: position and facing). Or narrow the query yourself so exactly the intended entity matches.`,
      );
    } else if (!safety.ok) {
      lines.push(
        `No one-step fix: ${safety.reason}. Rewrite the query yourself (a patch): keep what it should still select and use the candidate's query above for the member you mean, or narrow it (.max("+Z"), .normal("-Y"), …); the ${HINT_TOOLS.query} tool shows what a selector matches.`,
      );
    } else {
      lines.push("Narrow or re-aim the query yourself; the query tool shows what a selector matches in the current model.");
    }
  } else if (code === "REF_SPLIT") {
    lines.push(`No candidates in the report: take every piece with .some(), or narrow the query to the piece you mean (the ${HINT_TOOLS.query} tool lists them with their probes).`);
  } else if (code === "REF_MISSING") {
    lines.push(
      `No candidates: the entity is gone or the query never matched. Check the selector with the ${HINT_TOOLS.query} tool (drop the last filter to see what is there), then patch the feature; .any() accepts an empty set where that is intended.`,
    );
  }
  return lines.join("\n");
}

function refInfoHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  const field = str(d, "field");
  const feature = fname(ctx);
  const key = str(d, "key");
  const where = `${feature ? `${ident(feature)}'s reference` : "The reference"}${field ? ` ${fieldText(field)}` : ""}`;
  // The proposal (§5.8) rides in the details or on the feature's refs entry; without one the tool has nothing to apply.
  const hasProposal = obj(d?.["proposal"]) !== undefined || obj(ctx.feature?.refs?.find((r) => r.field === field)?.proposal) !== undefined || ctx.feature === undefined;
  const accept = !hasProposal
    ? "patch the query so it selects exactly the set you mean (the report carries no proposal to accept)"
    : feature !== undefined && field !== undefined
      ? `${HINT_TOOLS.acceptProposal} { feature: ${jsonQuote(feature)}, field: ${jsonQuote(field)} }`
      : HINT_TOOLS.acceptProposal;
  switch (code) {
    case "REF_REPAIRED": {
      const into = str(d, "into");
      return `${where}: ${key ? entityName(ctx, key) : "a member"} was re-bound to the geometry-identical ${into ? entityName(ctx, into) : "entity"}. Nothing is broken; ${accept} writes the repaired query into the file so it resolves exactly next time.`;
    }
    case "REF_SET_CHANGED": {
      const added = strings(d, "added");
      const removed = strings(d, "removed");
      const names = (keys: string[]) => capList(keys, 4, (k) => entityName(ctx, k)).join(", ");
      return `${where} now selects ${added.length > 0 ? `+${added.length} (${names(added)})` : "+0"} / ${removed.length > 0 ? `−${removed.length} (${names(removed)})` : "−0"} compared with when it was accepted. If the new set is intended (the query is the intent), ${accept}; otherwise narrow the query.`;
    }
    case "REF_MERGED":
      return `${where}: ${key ? entityName(ctx, key) : "a member"} merged into ${str(d, "into") ? entityName(ctx, str(d, "into")!) : "another entity"}; the reference follows it. Nothing to do unless the merge was unintended.`;
    case "REF_SPLIT_ACCEPTED": {
      // `pieces` is the pieces (names or keys) or their count (SPEC-v1 §5.7 lists `{ key, pieces }`).
      const raw = d?.["pieces"];
      const pieces = Array.isArray(raw) ? raw : [];
      const names = pieces.map((p) => (typeof p === "string" ? p : str(obj(p), "name") ?? str(obj(p), "key"))).filter((x): x is string => x !== undefined);
      const n = typeof raw === "number" ? raw : pieces.length === 1 && typeof pieces[0] === "number" ? (pieces[0] as number) : pieces.length;
      return `${where}: ${key ? entityName(ctx, key) : "a member"} was split into ${n} pieces${names.length > 0 ? ` (${capList(names, 4, (x) => entityName(ctx, x)).join(", ")})` : ""} and the reference takes all of them (its count allows it). If only one was meant, either narrow the query to that piece (the ${HINT_TOOLS.query} tool shows each piece's name and probe; e.g. .max("+X")), or declare .one() and apply: the reference then fails with REF_SPLIT, whose candidates are the pieces — then ${HINT_TOOLS.acceptCandidate} the one you mean (this report carries no candidates, so it cannot be accepted directly).`;
    }
    case "REF_KIND_CHANGED":
      return `${where}: ${key ? entityName(ctx, key) : "a member"} changed type from ${valueText(d?.["was"])} to ${valueText(d?.["now"])}. Check that the feature still does what was meant; re-aim the query if the new type is wrong.`;
    case "REF_NEIGHBORHOOD_CHANGED":
      return `${where}: ${key ? entityName(ctx, key) : "a member"} now has ${valueText(d?.["now"])} same-carrier neighbours (was ${valueText(d?.["was"])}): an upstream change merged faces or edges around it. Check the result.`;
    default:
      return undefined;
  }
}

// ── Booleans ──

/** The failing feature's IR type: the report entry's, else the compiled IR's. */
function featureType(ctx: V1HintContext): string | undefined {
  const name = fname(ctx);
  return ctx.feature?.type ?? (name === undefined ? undefined : irFeatureByName(ctx.ir, name)?.type);
}

/**
 * BOOLEAN_NO_INTERSECTION (SPEC-v1 §6.0.3) is raised by every feature that carries a body
 * operation — extrude and revolve with an `op`, boolean, a pattern with body seeds and `op: join`,
 * and later holes — so the repair names only the fields that feature has (`direction` and
 * `distance` are extrude's, §6.2).
 */
function noIntersectionHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const dist = numberOf(d, "min_distance");
  const tool = d?.["tool"];
  const toolText = tool === undefined ? "The tool" : cap(originText(ctx, tool).replace(/^the body of/, "the tool body of"));
  if (dist === undefined) return undefined;
  const type = featureType(ctx);
  const at = fname(ctx) ? ` (${ident(fname(ctx)!)})` : "";
  if (dist === 0) {
    const overlap: Record<string, string> = {
      extrude: "extend the distance by 1 mm or move the sketch into the target",
      revolve: "move the profile or the axis so the swept profile enters the target, or sweep a larger angle",
      boolean: "move the tool body into the target: edit the feature that built it",
      pattern: "change the layout's spacing, direction or count so the copies enter the targets",
      hole: "move the hole position onto the body",
    };
    const separate: Record<string, string> = {
      extrude: 'keep it a separate body (op "new_body")',
      revolve: 'keep it a separate body (op "new_body")',
      boolean: "keep the bodies separate (delete the boolean)",
      pattern: 'keep the copies separate bodies (op "new_body", no targets)',
    };
    return `${toolText} only touches the targets (minimum distance 0: along a face edge or at a point, with no shared volume or face area). Overlap it by a positive amount${at} (e.g. ${overlap[type ?? ""] ?? "move it into the target"})${separate[type ?? ""] ? `, or ${separate[type ?? ""]}` : ""}.`;
  }
  const away = `${toolText} is ${num(dist)} mm away from every target.`;
  const target = "or target the body it should touch.";
  switch (type) {
    case "extrude":
      return (
        `${away} Move it to meet the target: check the sketch plane and position, flip it with direction: "reverse", or lengthen it by more than ${numUp(dist)} mm (e.g. ${numUp(dist + 0.5)} mm: exactly ${numUp(dist)} only makes them touch)` +
        `${at}; ${target}`
      );
    case "revolve":
      return `${away} Move it to meet the target${at}: check the sketch plane, the profile's position and the axis (it stays in sketch coordinates), or sweep a larger angle so the profile reaches the target; ${target}`;
    case "boolean":
      return `${away} Move the tool body into the target${at}: edit the feature that built it (its sketch position or size) so it overlaps by a positive amount — it must move more than ${numUp(dist)} mm; or pick tool and target bodies that overlap.`;
    case "pattern":
      return `${away} The copies${at} miss the targets: change the layout (spacing, direction, count, axis) so they overlap them; ${target}`;
    case "hole":
      return `${away} Move the hole${at} over the body it should drill (more than ${numUp(dist)} mm), or give it that body as targets.`;
    default:
      return `${away} Move it${at} more than ${numUp(dist)} mm toward the target so they overlap (edit the feature that places it); ${target}`;
  }
}

// ── Holes ──

function holeFeature(ctx: V1HintContext): Record<string, unknown> | undefined {
  const f = fname(ctx) === undefined ? undefined : irFeatureByName(ctx.ir, fname(ctx)!);
  return f && f.type === "hole" ? (f as unknown as Record<string, unknown>) : undefined;
}

function holePosition(ctx: V1HintContext, at: string): string | undefined {
  const h = holeFeature(ctx);
  const placement = obj(h?.["at"]);
  const entries = list(placement, "list");
  for (const e of entries) {
    const eo = obj(e);
    if (str(eo, "id") === at) return valueText(eo?.["at"]);
  }
  return undefined;
}

/** A finite numeric 3-vector, or undefined (absent, an expression, or malformed). */
function literalVec3(v: unknown): [number, number, number] | undefined {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as [number, number, number]) : undefined;
}

/**
 * The face frame's (u, v) extent of the body under the face (SPEC-v1 §3.1), from the `on` probe,
 * the placement's own `origin`/`x_dir` and the body's bbox. Omitted (undefined) whenever the frame
 * cannot be reproduced exactly: no probe normal, an `origin`/`x_dir` that is an expression, a
 * degenerate `x`, or not exactly one body whose bbox holds the probe. The extent is the body's
 * bounds in that frame, an outer limit for the face.
 */
function faceExtent(ctx: V1HintContext): string | undefined {
  const refs = ctx.feature?.refs ?? [];
  const on = refs.find((r) => r.field === "/on/face");
  const probe = on?.members.length === 1 ? on.members[0]?.probe : undefined;
  if (!probe || !probe.normal) return undefined;
  const n = probe.normal;
  const placement = obj(holeFeature(ctx)?.["on"]);
  const givenOrigin = placement?.["origin"];
  const givenX = placement?.["x_dir"];
  const origin = givenOrigin === undefined ? [0, 0, 0] : literalVec3(givenOrigin);
  const xIn = givenX === undefined ? undefined : literalVec3(givenX);
  if (!origin || (givenX !== undefined && !xIn)) return undefined;
  let a: readonly number[];
  if (xIn) {
    a = xIn;
  } else {
    // §3.1 step 3 [W0-32]: the world axis with the smallest |n · axis|; values within ANGULAR_TOLERANCE of it tie, X before Y before Z.
    const m = Math.min(...[0, 1, 2].map((i) => Math.abs(n[i]!)));
    const best = [0, 1, 2].find((i) => Math.abs(n[i]!) <= m + ir.ANGULAR_TOLERANCE)!;
    a = [0, 1, 2].map((i) => (i === best ? 1 : 0));
  }
  const dot = a[0]! * n[0] + a[1]! * n[1] + a[2]! * n[2];
  const xr = [a[0]! - dot * n[0], a[1]! - dot * n[1], a[2]! - dot * n[2]];
  const xl = Math.hypot(xr[0]!, xr[1]!, xr[2]!);
  if (!(xl > 1e-9)) return undefined;
  const x = xr.map((c) => c / xl);
  const y = [n[1] * x[2]! - n[2] * x[1]!, n[2] * x[0]! - n[0] * x[2]!, n[0] * x[1]! - n[1] * x[0]!];
  const bodies = ctx.report?.parts?.flatMap((p) => p.bodies) ?? [];
  const within = (b: metricsV1.BodyReport) => [0, 1, 2].every((i) => probe.point[i]! >= b.bbox_min[i]! - 1e-6 && probe.point[i]! <= b.bbox_max[i]! + 1e-6);
  const candidates = bodies.filter(within);
  if (candidates.length !== 1) return undefined;
  const body = candidates[0]!;
  // §3.1 step 2: the frame origin is the given origin (else the world origin) projected onto the face plane.
  const off = (probe.point[0] - origin[0]!) * n[0] + (probe.point[1] - origin[1]!) * n[1] + (probe.point[2] - origin[2]!) * n[2];
  const o = [origin[0]! + off * n[0], origin[1]! + off * n[1], origin[2]! + off * n[2]];
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const cx of [body.bbox_min[0], body.bbox_max[0]])
    for (const cy of [body.bbox_min[1], body.bbox_max[1]])
      for (const cz of [body.bbox_min[2], body.bbox_max[2]]) {
        const r = [cx - o[0]!, cy - o[1]!, cz - o[2]!];
        const u = r[0]! * x[0]! + r[1]! * x[1]! + r[2]! * x[2]!;
        const v = r[0]! * y[0]! + r[1]! * y[1]! + r[2]! * y[2]!;
        umin = Math.min(umin, u);
        umax = Math.max(umax, u);
        vmin = Math.min(vmin, v);
        vmax = Math.max(vmax, v);
      }
  return `the face (${probeText(probe)}) lies within u ∈ [${num(umin)}, ${num(umax)}], v ∈ [${num(vmin)}, ${num(vmax)}] of its frame (u along ${vec(x)}, v along ${vec(y)}; the body's bounds)`;
}

function holeHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  const at = str(d, "at");
  if (at === undefined) return undefined;
  const pos = holePosition(ctx, at);
  const posText = `position ${ident(at)}${pos ? ` ${pos}` : ""}`;
  switch (code) {
    case "HOLE_POINT_OFF_FACE": {
      const distance = numberOf(d, "distance");
      const extent = faceExtent(ctx);
      return `Hole ${posText} is ${distance === undefined ? "outside" : `${numUp(distance)} mm outside`} the face it is placed on${extent ? `; ${extent}` : ""}. Move the position inward by at least ${distance === undefined ? "that distance" : `${numUp(distance)} mm`} plus the hole radius and a wall, or place the hole on the face that is there.`;
    }
    case "HOLE_DUPLICATE_POSITION":
      return `Hole ${posText} coincides with another position: remove it or move it (grid/boltCircle positions can overlap explicit ones).`;
    case "HOLE_UP_TO_MISSED":
      return `Hole ${posText}: the upTo face is not hit along the drilling direction. Pick a face the hole reaches, flip the hole (flip: true), or use a blind depth.`;
    case "HOLE_MISSES_BODY":
      return `Hole ${posText} does not meet any target body: move it over the body, or set targets to the body it should drill.`;
    case "HOLE_BREAKS_THROUGH":
      return `The blind hole at ${posText} breaks through the far side: if a through hole is intended use depth: "through"; otherwise make the blind depth smaller than the material under it (measure the wall).`;
    default:
      return undefined;
  }
}

// ── Blends and shell ──

/** A display name or key from the details, or undefined when absent or empty (engines may leave them blank). */
function nameOf(d: Details | undefined, ctx?: V1View): string | undefined {
  const name = str(d, "name")?.trim();
  if (name) return name;
  const key = str(d, "key")?.trim();
  return key ? entityName(ctx ?? {}, key) : undefined;
}

function edgeLimits(d: Details | undefined, maxKey: string, ctx: V1View = {}): string {
  const edges = list(d, "edges").map(obj).filter((x): x is Details => x !== undefined);
  return capList(
    edges,
    4,
    (e) =>
      // Per-edge maxima are feasible values too: printed rounded down, never above the engine's.
      `${displayName(nameOf(e, ctx) ?? "?")}${numberOf(e, maxKey) !== undefined ? ` ≤ ${numDown(numberOf(e, maxKey)!)}` : ""}${str(e, "limit") ? ` (${str(e, "limit")}${str(e, "face") ? ` at ${entityName(ctx, str(e, "face")!)}` : ""})` : ""}${str(e, "reason") ? ` (${str(e, "reason")})` : ""}`,
  ).join(", ");
}

/** The parameter a feature field is bound to (`r: fr` compiles to the expression "fr"), if it is exactly one parameter. */
function boundParam(ctx: V1HintContext, field: string): string | undefined {
  const feature = fname(ctx);
  const f = feature === undefined ? undefined : irFeatureByName(ctx.ir, feature);
  const expr = f ? (f as unknown as Record<string, unknown>)[field] : undefined;
  return typeof expr === "string" && paramDecl(ctx, expr) !== undefined ? expr : undefined;
}

/** The grid of feasible values (SPEC-v1 §6.6 rounds them down to multiples of 0.001 mm). */
const FEASIBLE_STEP_MM = 0.001;

/**
 * Above this (1000 km) the 0.001 mm grid is not stepped: past 2^53 · 0.001 ≈ 9e12 mm the grid is
 * finer than the float spacing, so stepping on it never ends. A maximum this large comes only from
 * an absurd model or a corrupt report; the suggestion is then an integer at least 1 mm below it.
 */
const FEASIBLE_GRID_MAX_MM = 1e9;

/**
 * The value a hint may tell the agent to set for an engine's feasible maximum, or `undefined` when
 * no usable positive value fits (the field must be > LINEAR_TOLERANCE, and a value below the
 * 0.001 mm grid of feasible values is no value a maker means). Constant time: `max` comes from an
 * engine report, so nothing here loops over its magnitude.
 * - `"at-max"`: the engine rounded its maximum down so that the maximum itself is safe to apply
 *   (SPEC-v1 §6.6 for fillet `r` / chamfer `d`): the maximum, printed exactly or rounded down.
 *   The recorded round trips (`test/v1/playbooks-v1.test.ts`) check that the engine keeps that promise.
 * - `"below-max"`: nothing guarantees the maximum itself is feasible (SPEC-v1 §6.8 does not round
 *   `max_feasible_thickness` down; at a gap limit the opposite walls just touch): at least
 *   0.001 mm below it, on the 0.001 grid.
 */
export function feasibleSuggestionV1(max: number, mode: "at-max" | "below-max"): string | undefined {
  if (!Number.isFinite(max) || max <= ir.LINEAR_TOLERANCE) return undefined;
  let text: string;
  if (mode === "at-max") {
    text = numDown(max);
  } else if (max > FEASIBLE_GRID_MAX_MM) {
    // At least 1 mm and 2^-30 relative below (exact for every finite max: the float spacing is 2^-52 relative).
    text = String(Math.floor(max * (1 - 2 ** -30)));
  } else {
    // The largest multiple of 0.001 at or below max, one step lower. max·1000 rounds, so floor() can
    // be one off either way: start one above and step down at most three times (bounded).
    let k = Math.floor(max * 1000) + 1;
    for (let i = 0; i < 3 && k / 1000 > max; i++) k -= 1;
    text = String((k - 1) / 1000);
  }
  const v = Number(text);
  return Number.isFinite(v) && v > ir.LINEAR_TOLERANCE && v >= FEASIBLE_STEP_MM && v <= max ? text : undefined;
}

/**
 * The one-step repair a too-large fillet, chamfer or shell hint proposes (the hint prints it; the
 * recorded round trips apply it and re-evaluate): set `field` of `feature` to `value`, through
 * `set_param` on `param` when the field reads exactly that driving parameter and nothing else reads
 * it, else as a number written into the feature (`literal`).
 */
export interface FeasibleRepairV1 {
  code: string;
  feature: string | undefined;
  field: "r" | "d" | "thickness";
  /** The engine's maximum. */
  max: number;
  mode: "at-max" | "below-max";
  /** The value to set, as printed (on the 0.001 grid, never above `max`). */
  value: string;
  /** set_param target: the field is exactly this driving parameter and nothing else reads it. */
  param?: string;
  /** The field reads a parameter other features or parameters also read: they would change with it. */
  sharedParam?: { name: string; derived: boolean; users: string[] };
}

const FEASIBLE_FIELDS: Readonly<Record<string, { field: "r" | "d" | "thickness"; max: string; mode: "at-max" | "below-max" }>> = {
  FILLET_RADIUS_TOO_LARGE: { field: "r", max: "max_feasible_r", mode: "at-max" },
  CHAMFER_DISTANCE_TOO_LARGE: { field: "d", max: "max_feasible_d", mode: "at-max" },
  SHELL_THICKNESS_TOO_LARGE: { field: "thickness", max: "max_feasible_thickness", mode: "below-max" },
};

/** The codes whose hint proposes a feasible value (and how the engine's maximum is to be read). */
export const FEASIBLE_REPAIR_CODES_V1: readonly string[] = Object.keys(FEASIBLE_FIELDS);

/** The repair {@link repairHintV1} proposes for a too-large blend or shell value, or undefined (no maximum, or none usable). */
export function feasibleRepairV1(code: string, ctx: V1HintContext): FeasibleRepairV1 | undefined {
  const spec = FEASIBLE_FIELDS[code];
  if (!spec) return undefined;
  const max = numberOf(ctx.details, spec.max);
  if (max === undefined) return undefined;
  const value = feasibleSuggestionV1(max, spec.mode);
  if (value === undefined) return undefined;
  const feature = fname(ctx);
  const out: FeasibleRepairV1 = { code, feature, field: spec.field, max, mode: spec.mode, value };
  const p = boundParam(ctx, spec.field);
  if (p === undefined) return out;
  const decl = paramDecl(ctx, p);
  const uses = parameterUsersV1(ctx.ir, p);
  const users = [...uses.features.filter((f) => f !== feature), ...uses.params];
  const derived = decl !== undefined && typeof decl.value === "string";
  if (!derived && users.length === 0) return { ...out, param: p };
  return { ...out, sharedParam: { name: p, derived, users } };
}

/** The one-step way to apply a feasible repair: `set_param` when a parameter only this field reads drives it, else the number to write. */
function repairText(r: FeasibleRepairV1): string {
  const where = r.feature ? ` in ${ident(r.feature)}` : "";
  if (r.param !== undefined) return `${HINT_TOOLS.setParam} { name: ${jsonQuote(r.param)}, value: ${r.value} }`;
  const shared = r.sharedParam;
  if (shared?.derived) return `set ${r.field}: ${r.value}${where} (it reads parameter ${ident(shared.name)}, which is derived: change its inputs or bound it)`;
  if (shared) {
    const others = capList(shared.users, 4, ident).join(", ");
    return `set ${r.field}: ${r.value}${where} as a number (parameter ${ident(shared.name)} also drives ${others}: ${HINT_TOOLS.setParam} { name: ${jsonQuote(shared.name)}, value: ${r.value} } would change ${shared.users.length === 1 ? "it" : "them"} too)`;
  }
  return `set ${r.field}: ${r.value}${where}`;
}

function blendTooLargeHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  const isFillet = code === "FILLET_RADIUS_TOO_LARGE";
  const key = isFillet ? "r" : "d";
  const verb = isFillet ? "fillet" : "chamfer";
  const value = numberOf(d, key);
  const max = numberOf(d, isFillet ? "max_feasible_r" : "max_feasible_d");
  if (max === undefined) return undefined;
  const edges = edgeLimits(d, isFillet ? "max_r" : "max_d", ctx);
  // SPEC-v1 §6.6 rounds the feasible values down to 0.001 mm; the text must not round them back up
  // (num() rounds to nearest: 123.456 → 123.46), so the maximum prints exactly or rounded down.
  const head = `${isFillet ? "Radius" : "Distance"} ${key} = ${value === undefined ? "?" : numExact(value)} is too large: max feasible ${key} = ${numDown(max)}${edges ? ` (limiting edges: ${edges})` : ""}. `;
  const repair = feasibleRepairV1(code, ctx);
  if (repair === undefined) {
    // A face narrower than the 0.001 mm grid: no r / d fits, and 0 is itself invalid (INVALID_RADIUS / INVALID_DISTANCE).
    return (
      head +
      `No ${key} of at least 0.001 mm fits these edges: remove the ${verb}${fname(ctx) ? ` (${ident(fname(ctx)!)})` : ""}, ${verb} fewer or other edges (leave out the limiting ones), or ${verb} before the feature that narrowed the face.`
    );
  }
  return head + `Use ${key} ≤ ${repair.value} — ${repairText(repair)} — or ${verb} before the feature that narrowed the face, or blend fewer edges.`;
}

function edgesReasonHint(code: string, d: Details | undefined, ctx: V1View): string | undefined {
  const edges = edgeLimits(d, "max_r", ctx);
  if (!edges) return undefined;
  const base = staticHintV1(code) ?? "";
  const reason = str(d, "reason");
  return `Edges: ${edges}${reason ? `; reason: ${oneLine(reason, 200)}` : ""}. ${base}`;
}

function shellHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const t = numberOf(d, "thickness");
  const max = numberOf(d, "max_feasible_thickness");
  const limits = list(d, "limits").map(obj).filter((x): x is Details => x !== undefined);
  if (t === undefined && max === undefined && limits.length === 0) return undefined;
  // Limits without a name (an engine may leave key and name empty) still say why.
  const named = capList(limits.filter((l) => nameOf(l, ctx) !== undefined), 4, (l) => `${displayName(nameOf(l, ctx)!)} (${str(l, "reason") ?? "limit"})`);
  const reasons = [...new Set(limits.filter((l) => nameOf(l, ctx) === undefined).map((l) => str(l, "reason")).filter((r): r is string => r !== undefined))];
  const lim = [...named, ...reasons.map((r) => `a ${r}`)].join(", ");
  // SPEC-v1 §6.8 does not round max_feasible_thickness down: print it exactly or rounded down, never
  // up, and suggest a value strictly below it (at a gap limit the maximum itself makes the walls touch).
  const shown = max === undefined ? undefined : numDown(max);
  const repair = feasibleRepairV1("SHELL_THICKNESS_TOO_LARGE", ctx);
  const head = `Wall thickness ${t === undefined ? "" : `${numExact(t)} mm `}is too large${shown !== undefined ? `: max feasible thickness = ${shown} mm` : ""}${lim ? ` (limited by ${lim}: "curvature" = a curved face's radius, "gap" = opposite walls meet)` : ""}. `;
  if (max !== undefined && repair === undefined) {
    return head + `No thickness of at least 0.001 mm fits below that maximum: remove the shell${fname(ctx) ? ` (${ident(fname(ctx)!)})` : ""}, or make the part larger / the curved faces rounder first.`;
  }
  return head + `${repair !== undefined ? `Use a thickness below ${shown} mm — ${repairText(repair)} —` : "Reduce the thickness,"} or make the part larger / the curved faces rounder.`;
}

// ── Sketch solving ──

function conflictHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const conflicts = list(d, "conflicts").map(obj).filter((x): x is Details => x !== undefined);
  if (conflicts.length === 0) return undefined;
  const sketch = sketchNameOf(ctx) ?? fname(ctx);
  const removals = [...new Set(conflicts.map((c) => str(c, "suggested_removal")).filter((x): x is string => x !== undefined))];
  const sets = conflicts.map((c) => `{${strings(c, "constraints").map(ident).join(", ")}}${c["verified_minimal"] === true ? "" : " (not verified minimal)"}`);
  const call = removals.length > 0 && sketch !== undefined ? `${HINT_TOOLS.sketchEdit} { sketch: ${jsonQuote(sketch)}, remove: [${removals.map((r) => jsonQuote(r)).join(", ")}] }` : undefined;
  return `Conflicting constraints: ${sets.join("; ")}.${removals.length > 0 ? ` Suggested removal: ${removals.map(ident).join(", ")}${call ? ` — ${call}` : ""}.` : ""} Or change one dimension's value so the set agrees.`;
}

function solveFailedHint(d: Details | undefined): string | undefined {
  const r = numberOf(d, "max_residual");
  const clusters = list(d, "clusters").map(obj).filter((x): x is Details => x !== undefined);
  if (r === undefined && clusters.length === 0) return undefined;
  const cl = capList(clusters, 3, (c) => `constraints {${capList(strings(c, "constraints"), 8, ident).join(", ")}} on ${capList(strings(c, "entities"), 6, ident).join(", ")}`).join("; ");
  return `The solver stopped with residual ${r === undefined ? "?" : num(r)}${cl ? ` in ${cl}` : ""}. Move the stored geometry close to the intended shape (the solver starts from it), or remove that cluster's constraints and add them back one at a time.`;
}

function underConstrainedHint(d: Details | undefined): string | undefined {
  const dof = numberOf(d, "dof");
  if (dof === undefined) return undefined;
  const ents = list(d, "entities").map(obj).filter((x): x is Details => x !== undefined);
  return `Informational: ${plural(dof, "degree")} of freedom left${ents.length > 0 ? ` (${capList(ents, 6, (e) => `${ident(str(e, "id") ?? "?")} ${valueText(e["dof"])}`).join(", ")})` : ""}. It evaluates fine; add dimensions or fix points only if the shape must hold when parameters change.`;
}

function redundantHint(ctx: V1HintContext, d: Details | undefined): string | undefined {
  const red = list(d, "redundant").map(obj).filter((x): x is Details => x !== undefined);
  if (red.length === 0) return undefined;
  const ids = red.map((r) => str(r, "constraint")).filter((x): x is string => x !== undefined);
  const sketch = sketchNameOf(ctx) ?? fname(ctx);
  const text = red.map((r) => `${ident(str(r, "constraint") ?? "?")} (implied by ${strings(r, "implied_by").map(ident).join(", ") || "others"})`).join(", ");
  return `Redundant: ${text}. Remove ${ids.length === 1 ? "it" : "them"}${sketch !== undefined && ids.length > 0 ? ` — ${HINT_TOOLS.sketchEdit} { sketch: ${jsonQuote(sketch)}, remove: [${ids.map((i) => jsonQuote(i)).join(", ")}] }` : ""}; the geometry does not change.`;
}

// ── Patterns ──

function patternHint(code: string, d: Details | undefined, feature?: metricsV1.FeatureReport): string | undefined {
  if (code === "PATTERN_INSTANCE_SKIPPED") {
    const index = list(d, "index").filter((x): x is number => typeof x === "number");
    const inner = str(d, "code");
    if (index.length === 0 && inner === undefined) return undefined;
    return `Instance ${vec(index)} was skipped${inner ? ` (${inner}${staticHintV1(inner) ? `: ${staticHintV1(inner)!.replace(/\.$/, "")}` : ""})` : ""}. Adjust count/spacing so every copy lands on the body, or skip it on purpose with skip: [${vec(index)}].`;
  }
  // SPEC-v1 §6.10 names `instances` without pinning its shape: an engine lists index arrays
  // ([[1], [2]], the oracle) or entries { index, code }. The inner codes then come from the
  // feature's PATTERN_INSTANCE_SKIPPED warnings.
  const raw = list(d, "instances");
  if (raw.length === 0) return undefined;
  const indexOf = (x: unknown): number[] | undefined => {
    const v = Array.isArray(x) ? x : list(obj(x), "index");
    const nums = v.filter((n): n is number => typeof n === "number");
    return nums.length > 0 && nums.length === v.length ? nums : undefined;
  };
  const skipped = (feature?.warnings ?? []).filter((w) => w.code === "PATTERN_INSTANCE_SKIPPED");
  const codes = new Set<string>();
  for (const x of raw) {
    const own = str(obj(x), "code");
    if (own !== undefined) {
      codes.add(own);
      continue;
    }
    const idx = indexOf(x);
    const w = idx === undefined ? undefined : skipped.find((s) => JSON.stringify(list(s.details, "index")) === JSON.stringify(idx));
    const c = str(w?.details, "code");
    if (c !== undefined) codes.add(c);
  }
  const shown = capList(raw, 4, (x) => (indexOf(x) ? vec(indexOf(x)!) : valueText(x))).join(", ");
  return `All ${plural(raw.length, "instance")} (${shown}) failed (${[...codes].sort().join(", ") || "see the PATTERN_INSTANCE_SKIPPED warnings"}). Check dir/axis and spacing: the copies must land on the target body; test with count: 2 first.`;
}

// ── Forge's engine-prefixed codes (details that say what to change) ──

/** Instance indices as `[i]` / `[i, j]`, or undefined when absent or malformed. */
function instanceIndex(d: Details | undefined): number[] | undefined {
  const v = list(d, "index");
  const nums = v.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0);
  return nums.length > 0 && nums.length === v.length ? nums : undefined;
}

/** The literal or expression text of a hole feature's blind depth (`{ blind: … }`), or undefined. */
function blindDepthText(hole: Record<string, unknown> | undefined): string | undefined {
  const b = obj(hole?.["depth"])?.["blind"];
  return typeof b === "number" ? `${num(b)} mm` : typeof b === "string" ? jsonQuote(oneLine(b, 80)) : undefined;
}

/**
 * FORGE_PATTERN_HOLE_* and FORGE_PATTERN_THROUGH_COPY_TOO_SHORT (`{ index?, seed, at, … }`, forge-ops
 * `pattern/error.rs`): one copied hole position of one instance. `seed` is the hole seed's feature id.
 */
function patternHoleHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  const at = str(d, "at");
  const seedId = str(d, "seed");
  if (at === undefined || seedId === undefined) return undefined;
  const seed = featureName(ctx, seedId);
  const pattern = fname(ctx);
  const index = instanceIndex(d);
  const skip = index ? ` leave instance ${vec(index)} out with skip: [${vec(index)}]` : "";
  const lead = [...(pattern ? [`Pattern ${ident(pattern)}`] : []), ...(index ? [`instance ${vec(index)}`] : [])].join(", ");
  const copy = `${lead ? `${cap(lead)}: the` : "The"} copy of hole ${ident(seed)} position ${ident(at)}`;
  const seedHole = irFeatureByName(ctx.ir, seed);
  const hole = seedHole?.type === "hole" ? (seedHole as unknown as Record<string, unknown>) : undefined;
  const intoSeed = `put the positions into ${ident(seed)} itself (grid, boltCircle or a position list), where each position drills on its own`;
  switch (code) {
    case "FORGE_PATTERN_HOLE_BREAKS_THROUGH": {
      const blind = blindDepthText(hole);
      return `${copy} breaks through the far side: the material under this copy is thinner than the hole is deep${blind ? ` (blind ${blind})` : ""}. If through holes are meant, give ${ident(seed)} depth: "through"; otherwise make its blind depth smaller than the thinnest wall under every copy${skip ? `, move the copies onto thicker material (dir/spacing/count), or${skip}` : ", or move the copies onto thicker material (dir/spacing/count)"}.`;
    }
    case "FORGE_PATTERN_HOLE_POSITION_MISSED":
      return `${copy} meets no target body (the instance's other positions do, so the instance is kept without this hole). Change dir/spacing/count so every copy lands on the body${skip ? `, move position ${ident(at)} of ${ident(seed)}, or${skip}` : `, or move position ${ident(at)} of ${ident(seed)}`}.`;
    case "FORGE_PATTERN_HOLE_TOP_INSIDE":
      return `${copy} starts inside the material, so the copied hole is closed at its top: the pattern moves the hole off the face it is drilled from (a dir or axis not in that face's plane, or a mirror). Pattern holes along their face only (dir in the face plane; a circular axis parallel to the drilling direction), put a separate hole on the face this copy should open onto, or ${intoSeed}${skip ? `; or${skip}` : ""}.`;
    case "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT": {
      const length = numberOf(d, "length");
      const reach = numberOf(d, "reach");
      return `${copy} is a through hole ${length !== undefined ? `${num(length)} mm long (its length at the seed)` : "as long as at the seed"}, but the targets extend ${reach !== undefined ? `${numUp(reach)} mm` : "further"} along its axis, so it would end inside the material; Forge does not cut that blind pocket. ${cap(intoSeed)} (a through hole then leaves the part at every position)${skip ? `, or${skip}` : ""}.`;
    }
    case "FORGE_PATTERN_HOLE_SEED_MISMATCH": {
      const what = str(d, "what");
      return `Forge could not check the copies of hole ${ident(seed)} position ${ident(at)}${what ? ` (${oneLine(what, 160)})` : ""} — an engine inconsistency, not your model. Instead of patterning the hole, ${intoSeed}; if it persists, report it under known_issues.`;
    }
    default:
      return undefined;
  }
}

/** Forge's size limits: `{ field, value, max }` (holes, patterns), `{ instances, seed_bodies, copies, max }`, `{ curve, field, value, limit }` (sketches). */
function forgeLimitHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  const max = numberOf(d, code === "FORGE_LIMIT_EXCEEDED" ? "limit" : "max");
  if (max === undefined) return undefined;
  const most = numDown(max);
  const value = numberOf(d, "value");
  const field = str(d, "field");
  const feature = fname(ctx);
  const where = field ? ` (${fieldText(field)})` : "";
  switch (code) {
    case "FORGE_HOLE_TOO_MANY_POSITIONS":
      return `${feature ? ident(feature) : "The hole"} asks for ${value !== undefined ? num(value) : "more"} positions${where}; Forge builds at most ${most} per hole feature: use at most ${most} (fewer grid rows/columns, a smaller boltCircle n), or split them over several hole features.`;
    case "FORGE_PATTERN_TOO_MANY_INSTANCES":
      return `${feature ? ident(feature) : "The pattern"} defines ${value !== undefined ? num(value) : "more"} instances besides the seed${where}; Forge builds at most ${most}: lower count (and count2) so there are at most ${most}, or split the pattern.`;
    case "FORGE_PATTERN_TOO_MANY_COPIES": {
      const instances = numberOf(d, "instances");
      const bodies = numberOf(d, "seed_bodies");
      const copies = numberOf(d, "copies");
      return `${instances !== undefined ? num(instances) : "The"} instances × ${bodies !== undefined ? num(bodies) : "the"} seed bodies${copies !== undefined ? ` = ${num(copies)} copies` : ""}; Forge builds at most ${most}: lower the count, or pattern fewer seeds (bodies or hole positions) per pattern.`;
    }
    case "FORGE_LIMIT_EXCEEDED": {
      const curve = str(d, "curve");
      if (field === "n") return `Polygon${curve ? ` ${quoteId(curve)}` : ""} has n = ${value !== undefined ? num(value) : "too many"} sides; Forge expands at most ${most}: use n ≤ ${most} (a circle() for a round outline).`;
      return `The sketch has more than ${most} curves after expanding rect/slot/polygon${curve ? ` (the limit is crossed at ${quoteId(curve)})` : ""}: split it into several sketches, or draw fewer compound curves.`;
    }
    default:
      return undefined;
  }
}

/** Provenance names in free text (`f_a/side:x and f_b/cap:end`) with their feature ids as names. */
function namesIn(view: V1View, text: string): string {
  return text.replace(/(^|[\s{|,(])([A-Za-z_][A-Za-z0-9_]*)\//g, (_m, pre: string, id: string) => `${pre}${featureName(view, id)}/`);
}

function forgeHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  switch (code) {
    case "FORGE_PATTERN_HOLE_BREAKS_THROUGH":
    case "FORGE_PATTERN_HOLE_POSITION_MISSED":
    case "FORGE_PATTERN_HOLE_TOP_INSIDE":
    case "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT":
    case "FORGE_PATTERN_HOLE_SEED_MISMATCH":
      return patternHoleHint(code, ctx, d);
    case "FORGE_HOLE_TOO_MANY_POSITIONS":
    case "FORGE_PATTERN_TOO_MANY_INSTANCES":
    case "FORGE_PATTERN_TOO_MANY_COPIES":
    case "FORGE_LIMIT_EXCEEDED":
      return forgeLimitHint(code, ctx, d);
    case "FORGE_HOLE_THREAD_DEEPER_THAN_HOLE": {
      const at = str(d, "at");
      const depth = numberOf(d, "depth");
      const holeDepth = numberOf(d, "hole_depth");
      if (at === undefined || holeDepth === undefined) return undefined;
      const hole = fname(ctx);
      return `The thread of ${hole ? `${ident(hole)} ` : ""}position ${ident(at)} is ${depth !== undefined ? `${num(depth)} mm` : "deeper than the hole"} deep, but the hole is ${num(holeDepth)} mm deep (to the shoulder): give thread: { depth } at most ${numDown(holeDepth)}, leave depth out (the full hole depth), or make the hole deeper.`;
    }
    case "FORGE_HOLE_UP_TO_UNSUPPORTED": {
      const surface = str(d, "surface");
      return surface ? `The upTo face is a ${ident(surface)}; Forge drills upTo planar faces only: use depth: { blind: d } with the distance to that face, "through", or upTo a planar face.` : undefined;
    }
    case "FORGE_BOOLEAN_NEAR_COINCIDENT": {
      const limit = numberOf(d, "limit");
      const entities = str(d, "entities");
      if (limit === undefined && entities === undefined) return undefined;
      const offset = numberOf(d, "offset");
      const point = list(d, "point").filter((x): x is number => typeof x === "number");
      const reason = str(d, "reason");
      // Separations are micrometres or less: three significant digits, not num()'s fixed decimals.
      return `Faces ${entities ? oneLine(namesIn(ctx, entities), 200) : "of the operands"} are near-coincident${reason ? ` (${oneLine(reason, 120)})` : ""}${offset !== undefined ? `, up to ${String(Number(offset.toPrecision(3)))} mm apart` : ""}${point.length === 3 ? ` near ${vec(point)}` : ""}: make them coincide exactly (the same value, from one parameter), or move one ${limit !== undefined ? `at least ${numUp(limit)} mm` : "clearly"} away (0.01 mm is plenty).`;
    }
    case "FORGE_BOOLEAN_UNSUPPORTED": {
      const what = str(d, "what");
      const entity = str(d, "entity");
      return what ? `Forge's boolean does not support ${oneLine(what, 120)} yet${entity ? ` (${oneLine(namesIn(ctx, entity), 120)})` : ""}: build that region from planes, cylinders, cones, spheres or tori, or order the features so this operation does not meet it; if it cannot be avoided, report it under known_issues.` : undefined;
    }
    case "FORGE_BOOLEAN_NO_CHANGE": {
      const targets = list(d, "targets");
      if (targets.length === 0) return undefined;
      return `Informational: the ${str(d, "op") ? ident(str(d, "op")!) : "operation"} left ${capList(targets, 4, (t) => originText(ctx, t)).join(", ")} as ${targets.length === 1 ? "it was" : "they were"}. If a target should have changed, move the tool onto it or narrow targets.`;
    }
    case "FORGE_PROBE_FAILED": {
      const key = str(d, "key");
      if (key === undefined) return undefined;
      const field = str(d, "field");
      return `Forge could not place a probe point on ${entityName(ctx, key)}${field ? ` (reference ${fieldText(field)})` : ""}, so it is left out of the report — not a modelling error. If the model is as intended, accept the warning; a reference that needs that entity fails with this code: re-aim it at a neighbouring face or edge.`;
    }
    case "FORGE_UNSUPPORTED_FEATURE":
      return unsupportedHint("UNSUPPORTED_FEATURE", d);
    default:
      return undefined;
  }
}

// ── The OCCT oracle's own codes ──

function oracleHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  switch (code) {
    case "ORACLE_SOLVE_REQUIRES_REPLAY": {
      const r = numberOf(d, "max_residual");
      return r === undefined ? undefined : `The stored sketch geometry misses its constraints by up to ${num(r)} mm, and the OCCT oracle does not solve (SPEC-v1 §8.1). Evaluate constrained sketches on Forge; on the oracle, draw the geometry at its solved sizes without constraints (rect/circle/slot driven by param(), or literal lines and arcs).`;
    }
    case "ORACLE_UNSUPPORTED_FEATURE": {
      const type = str(d, "type");
      if (type === undefined) return undefined;
      const work = WORKAROUNDS[type];
      return `The OCCT oracle does not evaluate ${ident(type)} features: evaluate on Forge${work ? `, or build the same geometry another way: ${work}` : ""}.`;
    }
    case "ORACLE_RESOURCE_LIMIT":
      return rangeHint(code, d, ctx);
    default:
      return undefined;
  }
}

// ── Engine support ──

function unsupportedHint(code: string, d: Details | undefined): string | undefined {
  const type = str(d, "type");
  if (type === undefined) return undefined;
  const supported = list(d, "supported");
  const none = code === "UNSUPPORTED_FEATURE" || supported.length === 0;
  const work = WORKAROUNDS[type];
  if (!none) return `${ident(type)} version ${valueText(d?.["v"])} is not implemented (supported: ${supported.map(valueText).join(", ")}): remove the explicit v.`;
  const note = work?.includes("known_issues") ? "" : " Say so under known_issues if the result differs from the request.";
  return `This engine cannot evaluate ${ident(type)} features yet.${work ? ` Build the same geometry another way: ${work}.` : " Model the geometry with the operations it has."}${note}`;
}

/** The feature field a range code is about when `field` is absent: the one the code names for this feature type. */
const RANGE_FIELDS: Readonly<Record<string, readonly string[]>> = { INVALID_DISTANCE: ["distance", "depth"], INVALID_ANGLE: ["angle"], INVALID_AXIS: ["axis"], INVALID_RADIUS: ["r", "radius"], INVALID_COUNT: ["count", "n"] };

function rangeHint(code: string, d: Details | undefined, ctx: V1HintContext): string | undefined {
  const value = d?.["value"];
  const expected = str(d, "expected");
  const feature = fname(ctx);
  const f = feature === undefined ? undefined : irFeatureByName(ctx.ir, feature);
  // `field` is in the catalogue; when an engine omits it, the feature's own field of that kind stands in.
  const field = str(d, "field") ?? (f ? RANGE_FIELDS[code]?.find((k) => k in (f as unknown as Record<string, unknown>)) : undefined);
  if (field === undefined && (value === undefined || expected === undefined)) return undefined;
  const raw = f && field !== undefined ? atPointer(f, field.startsWith("/") ? field : `/${field}`) : undefined;
  const viaExpr = typeof raw === "string" ? ` (from the expression ${jsonQuote(oneLine(raw, 120))}: change the parameters it uses)` : "";
  const subject = `${feature ? ident(feature) : ""}${feature && field !== undefined ? "." : ""}${field !== undefined ? ident(field) : feature ? "" : "The value"}`;
  return `${subject} = ${valueText(value)}${expected ? `, expected ${oneLine(expected, 120)}` : ""}${viaExpr}. ${staticHintV1(code) ?? ""}`.trim();
}

/**
 * The repair hint for a v1 code: computed from `details` (and the report and IR) where possible,
 * else the static playbook hint, else a generic fallback. Never empty; never throws.
 */
export function repairHintV1(code: string, ctx: V1HintContext = {}): string {
  let computed: string | undefined;
  const d = ctx.details;
  try {
    computed = computeHint(code, ctx, d);
  } catch {
    computed = undefined; // A hint must never break a tool result.
  }
  if (computed !== undefined) return computed;
  const fallback = staticHintV1(code) ?? "Unknown error code: read the message, make the smallest change that addresses it, and re-apply.";
  // An engine-prefixed code without a playbook of its own: its details are the only specifics.
  const keys = Object.keys(d ?? {}).filter((k) => d?.[k] !== undefined && d?.[k] !== null);
  if (PLAYBOOK_V1[code] === undefined && /^(?:FORGE|ORACLE|OCCT)_/.test(code) && keys.length > 0) {
    return `${fallback} Details: ${capList(keys, 5, (k) => `${k} = ${typeof d![k] === "object" ? oneLine(JSON.stringify(d![k]), 80) : typeof d![k] === "string" ? oneLine(d![k] as string, 80) : valueText(d![k])}`).join("; ")}.`;
  }
  return fallback;
}

function computeHint(code: string, ctx: V1HintContext, d: Details | undefined): string | undefined {
  switch (code) {
    // Expressions and parameters.
    case "EXPR_UNIT_MISMATCH": {
      const expected = str(d, "expected");
      const found = str(d, "found");
      const sub = str(d, "subexpr") ?? str(d, "expr");
      const ops = sub === undefined ? undefined : operandUnits(sub, ctx.ir);
      if (ops && ops.leftUnit !== ops.rightUnit) return operandAdvice(ops);
      return expected && found && sub ? `${unitAdvice(expected, found, sub)}${str(d, "expr") && str(d, "expr") !== sub ? ` (in ${jsonQuote(oneLine(str(d, "expr")!, 160))})` : ""}` : undefined;
    }
    case "EXPR_TYPE_MISMATCH": {
      const expected = str(d, "expected");
      const found = str(d, "found");
      const sub = str(d, "subexpr");
      if (!expected || !found) return undefined;
      return `${sub ? `\`${oneLine(sub, 120)}\`` : "The value"} is ${found} where ${expected} is needed: ${expected === "bool" ? "compare it (x > 0, x == 1) to make a condition" : "use c ? a : b to turn the condition into a number"}.`;
    }
    case "EXPR_UNKNOWN_NAME": {
      const name = str(d, "name");
      if (!name) return undefined;
      const similar = strings(d, "similar");
      if (d?.["is_feature"] === true) return `${ident(name)} is a feature, not a value: expressions read parameters only. Declare the number as const x = param(…) and use x in both places.`;
      return `${ident(name)} is not a parameter visible here.${similar.length > 0 ? ` Did you mean ${similar.slice(0, 3).map(ident).join(" or ")}?` : ""} If it is a new value, declare const ${ident(name)} = param(…) above its first use.`;
    }
    case "EXPR_UNKNOWN_FUNCTION": {
      const name = str(d, "name");
      if (!name) return undefined;
      const similar = strings(d, "similar");
      return `${ident(name)}() is not a CadScript function${similar.length > 0 ? `; did you mean ${similar.slice(0, 3).map(ident).join(" or ")}?` : "."} ${PLAYBOOK_V1["EXPR_UNKNOWN_FUNCTION"]}`;
    }
    case "EXPR_ARITY": {
      const name = str(d, "name");
      return name ? `${ident(name)}() takes ${plain(d?.["expected"])} argument(s), found ${plain(d?.["found"])}. ${PLAYBOOK_V1["EXPR_ARITY"]}` : undefined;
    }
    case "EXPR_SCOPE": {
      const name = str(d, "name");
      const part = str(d, "part");
      return name ? `${ident(name)} belongs to part ${part ? jsonQuote(part) : "another part"}: move its param() above the first part(…) to make it a document parameter, or declare a copy in this part.` : undefined;
    }
    case "EXPR_DOMAIN": {
      const sub = str(d, "subexpr");
      const ops = list(d, "operands");
      return sub ? `\`${oneLine(sub, 120)}\` is undefined for ${ops.length > 0 ? `operand(s) ${ops.map(valueText).join(", ")}` : "these values"} (sqrt of a negative, division by zero, asin/acos outside [−1, 1], tan at ±90°). Change the parameter values (${HINT_TOOLS.setParam}) or guard it: max(0, …), clamp(…).` : undefined;
    }
    case "EXPR_NOT_INTEGER": {
      const v = numberOf(d, "value");
      const e = str(d, "expr");
      if (v === undefined) return undefined;
      return `${e ? `\`${oneLine(e, 120)}\`` : "The count"} = ${numExact(v)}, but a count must be a whole number: write round(${e ?? "…"}) (= ${num(roundHalfAway(v))}), floor(…) (= ${num(Math.floor(v))}) or ceil(…) (= ${num(Math.ceil(v))}), or change its inputs.`;
    }
    case "EXPR_SYNTAX": {
      const off = numberOf(d, "offset");
      const exp = d?.["expected"];
      const e = str(d, "expr");
      if (off === undefined && exp === undefined) return undefined;
      return `Syntax error${off !== undefined ? ` at offset ${off}` : ""}${e ? ` of ${jsonQuote(oneLine(e, 160))}` : ""}${exp !== undefined ? `: expected ${plain(exp)}` : ""}. ${PLAYBOOK_V1["EXPR_SYNTAX"]}`;
    }
    case "PARAM_OUT_OF_RANGE":
      return paramRangeHint(ctx, d);
    case "PARAM_CYCLE": {
      const cycle = strings(d, "cycle");
      return cycle.length > 0 ? `Parameters depend on each other in a cycle: ${cycle.map(ident).join(" → ")}. Make one of them a literal (${HINT_TOOLS.setParam} { name: ${jsonQuote(cycle[0]!)}, value: <number> }).` : undefined;
    }
    case "PARAM_INVALID": {
      const name = str(d, "name");
      const reason = str(d, "reason");
      if (!name && !reason) return undefined;
      const allowed = list(d, "allowed");
      return `Parameter ${name ? ident(name) : ""} is invalid${reason ? ` (${oneLine(reason, 120)})` : ""}${allowed.length > 0 ? `; allowed: ${allowed.map(valueText).join(", ")}` : ""}. ${PLAYBOOK_V1["PARAM_INVALID"]}`;
    }
    case "PARAM_FAILED":
      return paramFailedHint(ctx, d);
    case "DEPENDENCY_FAILED":
      return dependencyHint(ctx, d);
    case "DEPENDENCY_SUPPRESSED": {
      const id = str(d, "feature");
      return id ? `${ident(featureName(ctx, id))} is suppressed but ${fname(ctx) ? ident(fname(ctx)!) : "this feature"} uses it: remove suppressed from ${ident(featureName(ctx, id))}, or stop referencing it.` : undefined;
    }
    case "SKETCH_SUPPRESSED": {
      const id = str(d, "sketch");
      return id ? `Sketch ${ident(featureName(ctx, id))} is suppressed: remove suppressed from it, or delete ${fname(ctx) ? ident(fname(ctx)!) : "this feature"}.` : undefined;
    }
    // Sketch geometry.
    case "SKETCH_OPEN_LOOP":
      return openLoopHint(ctx, d);
    case "SKETCH_BRANCHING":
      return branchingHint(d);
    case "SKETCH_CURVES_CROSS":
      return crossingHint(ctx, d);
    case "SKETCH_DEGENERATE_LOOP": {
      const curves = strings(d, "curves");
      const area = numberOf(d, "area");
      // A loop must enclose more than tolerance² (SPEC §3.1 [R-5]): 1e-12 mm² printed as 0 would hide why.
      const tiny = (x: number) => (x === 0 || Math.abs(x) >= 1e-3 ? num(x) : x.toPrecision(3).replace(/\.?0+e/, "e"));
      const limit = tiny(ir.LINEAR_TOLERANCE * ir.LINEAR_TOLERANCE);
      return curves.length > 0
        ? `The loop [${capList(curves, 8, ident).join(", ")}] encloses ${area !== undefined ? `only ${tiny(area)} mm² (a loop must enclose more than ${limit} mm²)` : "(almost) no area"}: a curve doubles back over another, or the loop is a sliver. Remove the doubled curve, or widen the loop.`
        : undefined;
    }
    case "SKETCH_NO_REGIONS": {
      // The catalogue lists no details: the sketch is the feature itself (raised on the sketch) or
      // the sketch it consumes (raised on the extrude/revolve); Forge adds `sketch`.
      const id = str(d, "sketch");
      const onSketch = ctx.feature?.type === "sketch";
      const sketch = id !== undefined ? featureName(ctx, id) : onSketch ? fname(ctx) : sketchNameOf(ctx);
      if (sketch === undefined) return undefined;
      const consumer = onSketch ? undefined : fname(ctx);
      return `Sketch ${ident(sketch)} has no closed loop of non-construction curves, so ${consumer ? ident(consumer) : "a feature that sweeps it"} has nothing to sweep: close the outline (lines/arcs end to end, or a circle/rect); construction curves and points never form regions.`;
    }
    case "REGION_NOT_FOUND": {
      const curve = str(d, "curve");
      if (!curve) return undefined;
      const f = fname(ctx) === undefined ? undefined : irFeatureByName(ctx.ir, fname(ctx)!);
      const sk = f && "sketch" in f && typeof f.sketch === "string" ? featureName(ctx, f.sketch) : undefined;
      const regions = sk ? ctx.report?.features.find((x) => x.feature === sk)?.regions : undefined;
      const outer = regions?.map((r) => `[${capList(r.outer_curves, 6, ident).join(", ")}]`);
      return `No region of ${sk ? ident(sk) : "the sketch"} has ${quoteId(curve)} on its outer loop (an inner-loop or construction curve selects nothing).${outer && outer.length > 0 ? ` Outer loops: ${capList(outer, 6, (x) => x).join("; ")} — list one curve of the region you mean.` : ""}`;
    }
    case "REVOLVE_CROSSES_AXIS":
      return revolveHint(ctx, d);
    case "INCONSISTENT_ARC":
      return inconsistentArcHint(d);
    case "DEGENERATE_CURVE": {
      const curve = str(d, "curve");
      return curve ? `Curve ${quoteId(curve)} is degenerate${str(d, "reason") ? `: ${oneLine(str(d, "reason")!, 160)}` : ""}. ${PLAYBOOK_V1["DEGENERATE_CURVE"]}` : undefined;
    }
    // Sketch solving.
    case "SKETCH_CONSTRAINT_CONFLICT":
      return conflictHint(ctx, d);
    case "SKETCH_SOLVE_FAILED":
      return solveFailedHint(d);
    case "SKETCH_UNDER_CONSTRAINED":
      return underConstrainedHint(d);
    case "SKETCH_REDUNDANT_CONSTRAINTS":
      return redundantHint(ctx, d);
    case "SKETCH_LOOP_FLIPPED": {
      const curves = strings(d, "curves");
      return curves.length > 0 ? `The loop [${capList(curves, 8, ident).join(", ")}] came out mirrored: the solver jumped to the flipped configuration. Move the stored points close to the intended shape, or add an angle or a fix that pins the orientation.` : undefined;
    }
    case "SKETCH_INVALID_DIMENSION": {
      const c = str(d, "constraint");
      return c ? `Dimension ${ident(c)} evaluates to ${valueText(d?.["value"])}, but distances, radii and diameters must be > 0: change its value or the parameters it uses.` : undefined;
    }
    case "SKETCH_MIXED_MODE": {
      const sk = str(d, "sketch");
      return sk ? `Sketch ${ident(featureName(ctx, sk))} mixes constraints with compound curves or expressions${str(d, "path") ? ` (at ${ident(str(d, "path")!)})` : ""}. ${PLAYBOOK_V1["SKETCH_MIXED_MODE"]}` : undefined;
    }
    case "SKETCH_UNKNOWN_REFERENCE":
    case "SKETCH_WRONG_ENTITY_TYPE": {
      const owner = str(d, "owner");
      const reference = str(d, "reference");
      if (!owner && !reference) return undefined;
      const types = code === "SKETCH_WRONG_ENTITY_TYPE" ? ` (expected ${valueText(d?.["expected"])}, found ${valueText(d?.["found"])})` : "";
      return `Constraint ${owner ? ident(owner) : ""} refers to ${reference ? jsonQuote(reference) : "an entity"}${types}. ${PLAYBOOK_V1[code]}`;
    }
    case "SKETCH_NOT_A_DIMENSION":
    case "SKETCH_SELF_REFERENCE":
    case "SKETCH_UNSUPPORTED_COMBINATION": {
      const id = str(d, "id");
      return id ? `Constraint ${ident(id)}${code === "SKETCH_UNSUPPORTED_COMBINATION" ? ` (${valueText(d?.["kind"])} of ${valueText(d?.["a"])} and ${valueText(d?.["b"])})` : ""}: ${PLAYBOOK_V1[code]}` : undefined;
    }
    case "CONSTRAINT_VALUE_REQUIRED":
    case "CONSTRAINT_VALUE_ON_REFERENCE": {
      const c = str(d, "constraint");
      return c ? `Constraint ${ident(c)}: ${PLAYBOOK_V1[code]}` : undefined;
    }
    // Planes and datums.
    case "PLANE_NOT_PLANAR": {
      const s = str(d, "surface");
      return s ? `The face the plane reference picked is a ${ident(s)}, not a plane. ${PLAYBOOK_V1["PLANE_NOT_PLANAR"]}` : undefined;
    }
    case "PLANE_DEGENERATE": {
      const x = list(d, "x_dir");
      return x.length > 0 ? `xDir ${valueText(x)} is (almost) parallel to the face normal. ${PLAYBOOK_V1["PLANE_DEGENERATE"]}` : undefined;
    }
    case "AXIS_REF_UNSUPPORTED": {
      const t = str(d, "type");
      return t ? `An axis cannot be taken from a ${ident(t)}. ${PLAYBOOK_V1["AXIS_REF_UNSUPPORTED"]}` : undefined;
    }
    case "DATUM_DEGENERATE": {
      const r = str(d, "reason");
      const a = numberOf(d, "angle_deg");
      return r ? `Degenerate datum: ${oneLine(r, 160)}${a !== undefined ? ` (angle ${num(a)}°)` : ""}. ${PLAYBOOK_V1["DATUM_DEGENERATE"]}` : undefined;
    }
    case "DATUM_OPTIONS_CONFLICT": {
      const fields = strings(d, "fields");
      const missing = strings(d, "missing");
      const unexpected = strings(d, "unexpected");
      if (fields.length === 0 && missing.length === 0 && unexpected.length === 0) return undefined;
      return `Datum form ${str(d, "mode") ? ident(str(d, "mode")!) : ""}: ${missing.length > 0 ? `missing ${missing.map(ident).join(", ")}; ` : ""}${unexpected.length > 0 ? `unexpected ${unexpected.map(ident).join(", ")}; ` : ""}${fields.length > 0 && missing.length === 0 && unexpected.length === 0 ? `fields ${fields.map(ident).join(", ")}; ` : ""}${PLAYBOOK_V1["DATUM_OPTIONS_CONFLICT"]}`;
    }
    // References.
    case "REF_MISSING":
    case "REF_AMBIGUOUS":
    case "REF_SPLIT":
    case "REF_UNCERTAIN":
      return refHint(code, ctx, d);
    case "REF_CARDINALITY": {
      const expected = d?.["expected"];
      const found = numberOf(d, "found");
      if (found === undefined) return undefined;
      return `${fname(ctx) ? `${ident(fname(ctx)!)}'s reference` : "The reference"}${str(d, "field") ? ` ${fieldText(str(d, "field")!)}` : ""} matches ${plural(found, "entity", "entities")} but declares ${valueText(expected)}. Narrow the query to the ${valueText(expected)} you mean, or change the count to .exactly(${found})${found > 0 ? " / .some()" : ""} if all of them are intended.`;
    }
    case "REF_REPAIRED":
    case "REF_SET_CHANGED":
    case "REF_MERGED":
    case "REF_SPLIT_ACCEPTED":
    case "REF_KIND_CHANGED":
    case "REF_NEIGHBORHOOD_CHANGED":
      return refInfoHint(code, ctx, d);
    case "REF_KIND_MISMATCH": {
      const e = d?.["expected"];
      const f = d?.["found"];
      if (e === undefined || f === undefined) return undefined;
      const nav: Record<string, string> = { face: ".faces()", edge: ".edges()", vertex: ".vertices()", body: ".owner()" };
      const target = typeof e === "string" ? nav[e] : Array.isArray(e) && typeof e[0] === "string" ? nav[e[0]] : undefined;
      return `${str(d, "field") ? `The argument at ${fieldText(str(d, "field")!)}` : "The argument"} needs ${plain(e)} but the query selects ${plain(f)}${target ? `: append ${target} to navigate` : ""}.`;
    }
    case "QUERY_INVALID": {
      const p = str(d, "path");
      return p ? `Query step at ${fieldText(p)}: expected ${plain(d?.["expected"])}, found ${plain(d?.["found"])}. ${PLAYBOOK_V1["QUERY_INVALID"]}` : undefined;
    }
    case "QUERY_UNKNOWN_CURVE": {
      const curve = str(d, "curve");
      if (!curve) return undefined;
      const similar = strings(d, "similar");
      const feat = str(d, "feature");
      return `${feat ? `${ident(featureName(ctx, feat))} has no profile curve` : "No profile curve"} ${jsonQuote(curve)}${similar.length > 0 ? `; did you mean ${similar.slice(0, 4).map((s) => jsonQuote(s)).join(" or ")}?` : "."} ${PLAYBOOK_V1["QUERY_UNKNOWN_CURVE"]}`;
    }
    case "INVALID_CARDINALITY": {
      const allowed = list(d, "allowed");
      return allowed.length > 0 ? `${str(d, "field") ? `The argument at ${fieldText(str(d, "field")!)}` : "This argument"} allows the counts ${allowed.map(plain).join(", ")}. ${allowed.some((a) => a === ">= 1") ? "A count is .one(), .some(), .any() or .exactly(n) with n ≥ 1: .exactly(0) selects nothing." : "This argument designates exactly one entity: end the query with .one() (or no count), and narrow it until one entity matches."}` : undefined;
    }
    // Booleans.
    case "BOOLEAN_NO_INTERSECTION":
      return noIntersectionHint(ctx, d);
    case "BOOLEAN_EMPTY_RESULT": {
      const t = list(d, "targets");
      return t.length > 0 ? `Intersecting with ${capList(t, 3, (x) => originText(ctx, x)).join(", ")} leaves nothing: the tool and the targets do not overlap. Move the tool into the target, or use op "cut"/"join" if that was the intent.` : undefined;
    }
    case "BOOLEAN_NON_MANIFOLD": {
      const p = d?.["probe"];
      return p !== undefined ? `The result would touch itself only along an edge or at a point, near the ${probeText(p)}: overlap the bodies there by a positive amount (e.g. 0.5 mm), or leave a gap.` : undefined;
    }
    case "BOOLEAN_TOOL_IS_TARGET": {
      const o = d?.["origin"];
      return o !== undefined ? `${cap(originText(ctx, o))} is both a target and a tool. ${PLAYBOOK_V1["BOOLEAN_TOOL_IS_TARGET"]}` : undefined;
    }
    case "BOOLEAN_SPLIT": {
      const o = d?.["origin"];
      return o !== undefined ? `Informational: ${originText(ctx, o)} was split into ${valueText(d?.["pieces"])} pieces. Later references to that body see every piece; if one solid was intended, the cut goes all the way across — shorten or narrow it.` : undefined;
    }
    case "BOOLEAN_BODY_CONSUMED": {
      const o = d?.["origin"];
      return o !== undefined ? `${cap(originText(ctx, o))} was removed entirely by ${fname(ctx) ? ident(fname(ctx)!) : "this feature"}. If that was not intended the tool is larger than the body (check its size, position and op).` : undefined;
    }
    case "BOOLEAN_TARGETS_REQUIRED": {
      const f = str(d, "feature");
      if (!f) return undefined;
      return `${f.startsWith("/") ? `The feature at ${fieldText(f)}` : ident(featureName(ctx, f))} has no targets: ${PLAYBOOK_V1["BOOLEAN_TARGETS_REQUIRED"]}`;
    }
    // Holes.
    case "HOLE_POINT_OFF_FACE":
    case "HOLE_DUPLICATE_POSITION":
    case "HOLE_UP_TO_MISSED":
    case "HOLE_MISSES_BODY":
    case "HOLE_BREAKS_THROUGH":
      return holeHint(code, ctx, d);
    case "HOLE_SIZE_UNKNOWN":
    case "HOLE_SIZE_REQUIRED":
    case "HOLE_OPTIONS_CONFLICT":
    case "HOLE_DEPTH_REQUIRED": {
      const field = str(d, "field");
      const allowed = list(d, "allowed");
      return field || allowed.length > 0 ? `${field ? `${ident(field)}: ` : ""}${allowed.length > 0 ? `allowed ${allowed.map(valueText).join(", ")}. ` : ""}${PLAYBOOK_V1[code]}` : undefined;
    }
    // Blends and shell.
    case "FILLET_RADIUS_TOO_LARGE":
    case "CHAMFER_DISTANCE_TOO_LARGE":
      return blendTooLargeHint(code, ctx, d);
    case "FILLET_EDGE_UNSUPPORTED":
    case "FILLET_FAILED":
    case "CHAMFER_EDGE_UNSUPPORTED":
    case "CHAMFER_SIDE_NOT_ADJACENT":
    case "CHAMFER_FAILED":
      return edgesReasonHint(code, d, ctx);
    case "CHAMFER_OPTIONS_CONFLICT":
    case "PATTERN_OPTIONS_CONFLICT": {
      const fields = strings(d, "fields");
      return fields.length > 0 ? `Conflicting options ${fields.map(ident).join(", ")}. ${PLAYBOOK_V1[code]}` : undefined;
    }
    case "SHELL_THICKNESS_TOO_LARGE":
      return shellHint(ctx, d);
    case "SHELL_FACE_NOT_ON_BODY":
    case "DRAFT_FACE_UNSUPPORTED":
    case "DRAFT_FAILED": {
      const faces = list(d, "faces");
      return faces.length > 0 ? `Faces ${capList(faces, 4, (x) => (typeof x === "string" ? entityName(ctx, x) : valueText(x))).join(", ")}: ${PLAYBOOK_V1[code]}` : undefined;
    }
    case "SHELL_FAILED": {
      const r = str(d, "reason");
      return r ? `Shell failed: ${oneLine(r, 200)}. ${PLAYBOOK_V1["SHELL_FAILED"]}` : undefined;
    }
    // Patterns.
    case "PATTERN_ALL_INSTANCES_FAILED":
    case "PATTERN_INSTANCE_SKIPPED":
      return patternHint(code, d, ctx.feature);
    case "PATTERN_SEED_UNSUPPORTED": {
      const seed = str(d, "seed");
      return seed ? `Seed ${ident(featureName(ctx, seed))} is a ${valueText(d?.["type"])}. ${PLAYBOOK_V1["PATTERN_SEED_UNSUPPORTED"]}` : undefined;
    }
    // Range checks.
    case "INVALID_DISTANCE":
    case "INVALID_ANGLE":
    case "INVALID_AXIS":
    case "INVALID_RADIUS":
    case "INVALID_COUNT":
    case "INVALID_VALUE":
    case "INVALID_PARAMETER": // Forge's v0 name for INVALID_VALUE (FORGE_CODE_ALIASES_V1)
      return rangeHint(code, d, ctx);
    case "INVALID_PLANE": {
      const r = str(d, "reason");
      return r ? `Invalid plane${str(d, "field") ? ` at ${ident(str(d, "field")!)}` : ""}: ${oneLine(r, 160)}. ${PLAYBOOK_V1["INVALID_PLANE"]}` : undefined;
    }
    // Document and ids.
    case "UNSUPPORTED_FEATURE":
    case "UNSUPPORTED_FEATURE_VERSION":
      return unsupportedHint(code, d);
    case "UNRESOLVED_FEATURE": {
      const id = str(d, "id");
      return id ? `${ident(id)} (at ${str(d, "field") ? fieldText(str(d, "field")!) : "?"}) is not ${plain(d?.["expected"])} declared above in this part. ${PLAYBOOK_V1["UNRESOLVED_FEATURE"]}` : undefined;
    }
    case "UNRESOLVED_SKETCH": {
      const s = str(d, "sketch");
      return s ? `${ident(s)} is not a sketch declared above in this part. ${PLAYBOOK_V1["UNRESOLVED_SKETCH"]}` : undefined;
    }
    case "DUPLICATE_ID":
    case "DUPLICATE_NAME":
    case "RESERVED_NAME": {
      const v = str(d, code === "DUPLICATE_ID" ? "id" : "name");
      return v ? `${ident(v)}: ${PLAYBOOK_V1[code]}` : undefined;
    }
    case "INVALID_ID":
    case "INVALID_NAME": {
      const p = str(d, "path");
      const r = str(d, "reason");
      return p || r ? `${p ? `At ${ident(p)}: ` : ""}${r ? `${oneLine(r, 120)}. ` : ""}${PLAYBOOK_V1[code]}` : undefined;
    }
    case "CURVE_OPTIONS_CONFLICT": {
      const c = str(d, "curve");
      return c ? `Curve ${quoteId(c)} sets ${strings(d, "fields").map(ident).join(" and ")}: ${PLAYBOOK_V1["CURVE_OPTIONS_CONFLICT"]}` : undefined;
    }
    case "EMPTY_SKETCH": {
      const s = str(d, "sketch");
      return s ? `Sketch ${ident(featureName(ctx, s))} has no curves. ${PLAYBOOK_V1["EMPTY_SKETCH"]}` : undefined;
    }
    case "NON_FINITE": {
      const f = str(d, "field");
      return f ? `${ident(f)} is not a finite number. ${PLAYBOOK_V1["NON_FINITE"]}` : undefined;
    }
    case "UNSUPPORTED_SCHEMA": {
      const found = d?.["found"];
      return found !== undefined ? `The document says ${valueText(found)}. ${PLAYBOOK_V1["UNSUPPORTED_SCHEMA"]}` : undefined;
    }
    case "MEASURE_NOT_REFERENCE":
    case "MEASURE_UNIT_MISMATCH":
    case "MEASURE_FORWARD": {
      const n = str(d, "name");
      return n ? `${ident(n)} = measure(…): ${PLAYBOOK_V1[code]}` : undefined;
    }
    case "INVALID_RESULT": {
      const issues = list(d, "issues");
      return issues.length > 0 ? `The engine's validity check failed (${capList(issues, 3, (i) => oneLine(typeof i === "string" ? i : JSON.stringify(i), 120)).join("; ")}). ${PLAYBOOK_V1["INVALID_RESULT"]}` : undefined;
    }
    default:
      return code.startsWith("FORGE_") ? forgeHint(code, ctx, d) : code.startsWith("ORACLE_") ? oracleHint(code, ctx, d) : undefined;
  }
}

/** The hint for one engine rejection entry of `report.error.details.errors` (`{ code, path, message, details }`). */
export function rejectionHintV1(entry: unknown, view: V1View = {}): string {
  const e = obj(entry);
  const code = str(e, "code") ?? "UNKNOWN";
  return repairHintV1(code, { ...view, details: obj(e?.["details"]) });
}

// ─── Compile diagnostics (CadScript v1 front end) ───────────────────────────────────────────────
//
// The compiler rejects R-stage codes before any engine sees the document, with a span but no
// `details`. Where the source says more than the compiler's generic hint, the hint is computed
// from the source around the span and the (partial) IR the analysis produced — still no message
// parsing.

/** What a numeric argument of a builtin takes, by option name (for unit hints). */
const FIELD_UNITS: Readonly<Record<string, string>> = {
  distance: "mm", depth: "mm", w: "mm", h: "mm", r: "mm", radius: "mm", d: "mm", d2: "mm", thickness: "mm", spacing: "mm", spacing2: "mm", dx: "mm", dy: "mm",
  circumradius: "mm", inradius: "mm", acrossFlats: "mm", across_flats: "mm", side: "mm", blind: "mm", pitch: "mm",
  angle: "deg", rotation: "deg", start: "deg", tip: "deg",
  n: "1", nx: "1", ny: "1", count: "1", count2: "1",
};

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

/** Parameter names within typo distance of `name`, closest first (at most 3). */
export function similarParams(name: string, doc: ir.IrDocument | null | undefined): string[] {
  const names = doc ? [...(doc.params ?? []), ...doc.parts.flatMap((p) => p.params ?? [])].map((p) => p.name) : [];
  const limit = Math.max(2, Math.floor(name.length / 3));
  return names
    .map((n) => ({ n, d: levenshtein(name.toLowerCase(), n.toLowerCase()) }))
    .filter((x) => x.d <= limit && x.n !== name)
    .sort((a, b) => a.d - b.d || (a.n < b.n ? -1 : 1))
    .slice(0, 3)
    .map((x) => x.n);
}

function nodeAt(sf: ts.SourceFile, pos: number, end: number): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || end > n.end) return;
    found = n;
    n.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return found;
}

/**
 * A computed hint for a CadScript v1 compile diagnostic, or undefined (then the compiler's own hint
 * or the static playbook applies). `doc` is the analysis' partial IR (parameters and their units).
 */
export function compileHintV1(code: string, source: string, span: { start: { line: number; col: number }; end: { line: number; col: number } }, doc: ir.IrDocument | null | undefined): string | undefined {
  try {
    if (code !== "EXPR_UNIT_MISMATCH" && code !== "EXPR_UNKNOWN_NAME") return undefined;
    const sf = ts.createSourceFile("main.cad.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const pos = sf.getPositionOfLineAndCharacter(span.start.line - 1, span.start.col - 1);
    const end = sf.getPositionOfLineAndCharacter(span.end.line - 1, span.end.col - 1);
    const node = nodeAt(sf, pos, Math.max(pos, end));
    if (!node) return undefined;
    const text = source.slice(pos, end);
    if (code === "EXPR_UNKNOWN_NAME") {
      const similar = similarParams(text, doc);
      return `${ident(text)} is not a parameter declared above.${similar.length > 0 ? ` Did you mean ${similar.map(ident).join(" or ")}?` : ""} Expressions read param() consts (features are not values); declare const ${ident(text)} = param(…) above its first use if it is new.`;
    }
    // EXPR_UNIT_MISMATCH: the span is the offending operand or the whole argument.
    let expr: ts.Node = node;
    while (ts.isParenthesizedExpression(expr.parent)) expr = expr.parent;
    const parent = expr.parent;
    if (parent && ts.isBinaryExpression(parent)) {
      const ops = operandUnits(parent.getText(sf), doc);
      if (ops && ops.leftUnit !== ops.rightUnit) return operandAdvice(ops);
    }
    const own = operandUnits(`0 + ${text}`, doc);
    const unit = own ? own.rightUnit : undefined;
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
      const field = parent.name.text;
      const want = FIELD_UNITS[field];
      if (want !== undefined && unit !== undefined && unit !== want) {
        return `${field} takes ${unitWord(want)} but \`${oneLine(text, 80)}\` is ${unitWord(unit)}. ${unitAdvice(want, unit, text)}`;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
