/**
 * Operation playbooks: every error code the agent can meet — CadScript front end (`CS_*`), IR
 * validation (mirrors of forge-ir `validate.rs`), kernel evaluation (SPEC.md §3–§4), engine
 * plumbing, and type checking (`TS####`) — maps to an actionable repair hint.
 *
 * Where the IR (or the source) allows it, the hint is computed: which curve end dangles and which
 * end is nearest, where two curves cross, which curves sit on the wrong side of a revolve axis,
 * where an arc's end should be. Generic hints are the fallback, never the only answer for the
 * codes a maker hits most (open loops, crossings, axis crossings).
 */
import ts from "typescript";
import { DIAGNOSTIC_CODES, type Span } from "@aicad/cadscript";
import type { Feature, IrDocument, RevolveFeature, SketchCurve, SketchFeature } from "@aicad/ir-types";
import { num, vec } from "./format.js";
import {
  arcRadius,
  describeAxis,
  distanceToCurve,
  endpointIssues,
  firstCrossing,
  firstEndpointIssue,
  nearestEnds,
  sideExtent,
  type CurveEnd,
  type P2,
} from "./sketch-geom.js";

/** Kernel (evaluation) error codes from forge-ir SPEC.md §3.1 and §4, shared by every engine. */
export const KERNEL_ERROR_CODES = [
  "SKETCH_OPEN_LOOP",
  "SKETCH_BRANCHING",
  "SKETCH_CURVES_CROSS",
  "SKETCH_DEGENERATE_LOOP",
  "SKETCH_NO_REGIONS",
  "SKETCH_SUPPRESSED",
  "DEPENDENCY_FAILED",
  "REVOLVE_CROSSES_AXIS",
  "INVALID_RESULT",
] as const;

/** Document-level rejections an engine may report instead of evaluating. */
export const DOCUMENT_ERROR_CODES = ["IR_SCHEMA_INVALID", "IR_PARSE_ERROR"] as const;

/** `@aicad/evals` engine plumbing errors: not the model's fault. */
export const ENGINE_ERROR_CODES = ["ENGINE_UNAVAILABLE", "ENGINE_FAILED", "ENGINE_TIMEOUT", "ENGINE_BAD_OUTPUT", "FIXTURE_MISSING"] as const;

/** Engine-prefixed internal failures (SPEC §4 [R-12]); matched by prefix. */
export const ENGINE_INTERNAL_PREFIXES = ["OCCT_", "FORGE_"] as const;

const CURVE_RULES = "Every line/arc end must coincide (≤ 1e-6 mm) with exactly one other curve end; a circle is a loop by itself.";

/** Static hints. Computed hints (below) replace or extend these where the IR allows. */
export const PLAYBOOK: Readonly<Record<string, string>> = {
  // ── CadScript front end ──
  CS_SYNTAX: "Fix the TypeScript syntax at the reported position (unbalanced brackets, missing comma between curves, stray text).",
  CS_BAD_IMPORT: 'Use exactly one `import { … } from "@aicad/std";` as the first statement.',
  CS_NOT_IMPORTED: 'Add the builtin to the `import { … } from "@aicad/std"` list.',
  CS_UNKNOWN_BUILTIN: "Only doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ exist in v0. Holes are circles inside the outline of the same sketch; there is no hole(), fillet(), rect() or boolean yet.",
  CS_STATEMENT_UNSUPPORTED: "Only `const name = sketch|extrude|revolve(…)`, `part(\"…\")` and `doc({…})` statements are allowed: no let/var, loops, if or functions. Write every curve out explicitly.",
  CS_EXPR_UNSUPPORTED: "Arguments must be literals. Compute the number yourself and write it (e.g. 16, not 8 * 2); variables and param() arrive in CadScript v1.",
  CS_BAD_ARGUMENT: "Match the builtin's signature: see the hint for the expected literal type, tuple length or property name.",
  CS_DOC_MISPLACED: "Put the single doc({…}) directly after the import.",
  CS_MISSING_PART: 'Add part("name"); before the first feature.',
  CS_DUPLICATE_NAME: "Feature const names are unique per file: rename one of them.",
  CS_RESERVED_NAME: "Rename the const (builtin and reserved names such as part, sketch, line cannot name features).",
  CS_UNRESOLVED_SKETCH: "extrude/revolve take the name of a sketch const declared earlier in the same part; declare the sketch first or fix the name.",
  CS_RENAME_DETECTED: "Informational: the feature was matched to its previous version as a rename; nothing to fix.",
  // ── IR validation (forge-ir validate.rs mirrors) ──
  UNSUPPORTED_SCHEMA: 'The IR schema must be "aicad.ir/0"; this comes from the compiler — write plain CadScript.',
  NO_PARTS: 'A file needs at least one part("name") with features.',
  DUPLICATE_ID: "Two parts, features or curves share an id: give every curve in a sketch a distinct key.",
  DUPLICATE_NAME: "Part names and feature names must be unique across the file.",
  INVALID_NAME: "Feature names match [A-Za-z_][A-Za-z0-9_]* and part names are non-empty.",
  UNRESOLVED_SKETCH: "The referenced sketch must be an earlier sketch in the same part.",
  INVALID_DISTANCE: 'Extrude distance is a positive length in mm (> 1e-6). To go the other way use direction: "reverse", not a negative distance.',
  INVALID_ANGLE: "Revolve angle is in degrees, 0 < angle ≤ 360 (360 = full turn).",
  INVALID_AXIS: "The revolve axis needs a finite origin and a non-zero direction, in sketch [u, v] coordinates (e.g. { origin: [0, 0], direction: [0, 1] }).",
  INVALID_PLANE: "frame() needs non-zero normal and xDir that are perpendicular (dot product 0), e.g. normal [0, 0, 1] with xDir [1, 0, 0].",
  EMPTY_SKETCH: "A sketch needs at least one curve.",
  NON_FINITE: "Coordinates and radii must be finite numbers.",
  RESERVED_NAME: "Rename the feature: reserved words and CadScript builtins cannot be feature names.",
  DEGENERATE_CURVE: "Lines need two distinct points; arcs and circles need a radius > 1e-6 mm; an arc's start and end must differ (use circle() for a full turn).",
  INCONSISTENT_ARC: "An arc's start and end must be the same distance from its center (within 1e-6 mm).",
  // ── Kernel (SPEC §3.1, §4) ──
  SKETCH_OPEN_LOOP: `A curve end meets no other curve end. ${CURVE_RULES}`,
  SKETCH_BRANCHING: `Three or more curve ends meet at one point. ${CURVE_RULES} Remove the duplicate curve, or split the shape into loops that do not touch.`,
  SKETCH_CURVES_CROSS: "Two curves cross or touch away from a shared endpoint (v0 never splits curves). Holes must lie strictly inside their outline, with a gap; separate outlines must not touch.",
  SKETCH_DEGENERATE_LOOP: "A loop encloses (almost) zero area — usually a line that doubles back over another. Remove the doubled curve.",
  SKETCH_NO_REGIONS: "The sketch produced no region: add closed loops (lines/arcs end-to-end, or circles).",
  SKETCH_SUPPRESSED: "The feature uses a suppressed sketch: remove `suppressed: true` from the sketch, or delete this feature.",
  DEPENDENCY_FAILED: "The sketch this feature consumes failed. Fix the sketch's own error; this feature recovers by itself.",
  REVOLVE_CROSSES_AXIS: "Every region of a revolved sketch must stay on one side of the axis line (touching it is fine).",
  INVALID_RESULT: "The engine produced an invalid body. Simplify the geometry near this feature (avoid near-tangent or sliver curves, very thin walls) and re-apply.",
  // ── Document-level rejections ──
  IR_SCHEMA_INVALID: "The engine rejected the document structure; this should not happen for compiled CadScript — report it under known_issues.",
  IR_PARSE_ERROR: "The engine could not parse the document; report it under known_issues.",
  // ── Engine plumbing ──
  ENGINE_UNAVAILABLE: "The geometry engine is not available. This is an environment problem, not your model: stop and report it.",
  ENGINE_FAILED: "The engine crashed on this document. Try a simpler variant of the last change; if it persists, report it under known_issues.",
  ENGINE_TIMEOUT: "The engine timed out. Try a simpler variant of the last change; if it persists, report it under known_issues.",
  ENGINE_BAD_OUTPUT: "The engine returned an unreadable report. Retry once; if it persists, report it under known_issues.",
  FIXTURE_MISSING: "Offline replay has no recorded report for this exact model (recorded engine). Re-record fixtures with a real engine.",
};

const TS_HINTS: Readonly<Record<string, string>> = {
  TS2304: "A name is not declared: import builtins from @aicad/std and declare a sketch const before extrude/revolve use it.",
  TS2305: "@aicad/std has no such export: only doc, part, sketch, line, arc, circle, extrude, revolve, frame, XY, XZ, YZ exist.",
  TS2322: "A value has the wrong type for @aicad/std (e.g. a string where a number is expected, or [x, y, z] where [u, v] is expected).",
  TS2345: "An argument has the wrong type: check the builtin's signature in the CadScript reference.",
  TS2353: "Unknown property for this builtin's options (e.g. `d` instead of `radius`, `depth` instead of `distance`).",
  TS2554: "Wrong number of arguments for this builtin.",
  TS2741: "A required property is missing (e.g. arc needs start, end, center and ccw).",
  TS2739: "Several required properties are missing.",
  TS2769: "No overload matches: check the builtin's signature.",
};

/** The static hint for a code (prefix-aware for engine-internal and TS codes); undefined for unknown codes. */
export function staticHint(code: string): string | undefined {
  const h = PLAYBOOK[code];
  if (h !== undefined) return h;
  if (ENGINE_INTERNAL_PREFIXES.some((p) => code.startsWith(p))) {
    return "Engine-internal failure (not a spec error). Simplify the geometry near this feature (avoid near-tangent curves, slivers, tiny edges) and re-apply; if it persists, report it under known_issues.";
  }
  if (/^TS\d+$/.test(code)) return TS_HINTS[code] ?? "TypeScript type error against @aicad/std: make the value match the declared type.";
  return undefined;
}

/** Every code the playbook covers (static table + CadScript diagnostic codes). */
export function coveredCodes(): string[] {
  return [...new Set([...Object.keys(PLAYBOOK), ...Object.keys(DIAGNOSTIC_CODES)])].sort();
}

// ─── Computed hints ──────────────────────────────────────────────────────────────────────────

export interface HintContext {
  /** The compiled IR (kernel errors) — absent for compile errors. */
  ir?: IrDocument | null | undefined;
  /** The CadScript source (compile errors: to read literal values at the span). */
  source?: string | undefined;
  /** Name of the failing feature. */
  feature?: string | undefined;
  /** The engine's or compiler's message. */
  message?: string | undefined;
  /** Compile diagnostics: where the error is. */
  span?: Span | undefined;
}

function pt(p: readonly number[]): string {
  return `(${p.map(num).join(", ")})`;
}

function endName(e: CurveEnd): string {
  return `'${e.curve}'.${e.which}`;
}

function describeCurve(c: SketchCurve): string {
  if (c.kind === "line") return `line '${c.id}' ${pt(c.start)}→${pt(c.end)}`;
  if (c.kind === "circle") return `circle '${c.id}' c=${pt(c.center)} r=${num(c.radius)}`;
  return `arc '${c.id}' ${pt(c.start)}→${pt(c.end)} c=${pt(c.center)} r=${num(arcRadius(c))}`;
}

function findFeatureIn(ir: IrDocument | null | undefined, name: string | undefined): Feature | undefined {
  if (!ir || name === undefined) return undefined;
  for (const p of ir.parts) for (const f of p.features) if (f.name === name) return f;
  return undefined;
}

function sketchOf(ir: IrDocument | null | undefined, name: string | undefined): SketchFeature | undefined {
  const f = findFeatureIn(ir, name);
  if (!f) return undefined;
  if (f.type === "sketch") return f;
  const s = findFeatureIn(ir, f.sketch);
  return s?.type === "sketch" ? s : undefined;
}

function openLoopHint(sk: SketchFeature): string | undefined {
  const issues = endpointIssues(sk.curves).filter((i) => i.partners.length === 0);
  const first = issues[0];
  if (!first) return undefined;
  const near = nearestEnds(sk.curves, first.end, 1)[0];
  const lines: string[] = [];
  if (near) {
    const nearAlsoOpen = issues.some((i) => i.end.index === near.end.index && i.end.which === near.end.which);
    lines.push(
      `${endName(first.end)} ${pt(first.end.p)} has no partner; the nearest curve end is ${endName(near.end)} ${pt(near.end.p)}, ${num(near.distance)} mm away` +
        `${nearAlsoOpen ? " (also unmatched — these two are meant to meet)" : ""}. Make them identical, e.g. set ${endName(near.end)} to ${vec(first.end.p)} or ${endName(first.end)} to ${vec(near.end.p)}.`,
    );
  } else {
    lines.push(`${endName(first.end)} ${pt(first.end.p)} has no partner: the sketch has a single open curve; close the loop with more curves.`);
  }
  if (issues.length > 1) lines.push(`Unmatched ends in total: ${issues.slice(0, 6).map((i) => `${endName(i.end)} ${pt(i.end.p)}`).join(", ")}${issues.length > 6 ? ", …" : ""}.`);
  return lines.join(" ");
}

function branchingHint(sk: SketchFeature): string | undefined {
  const issue = endpointIssues(sk.curves).find((i) => i.partners.length >= 2);
  if (!issue) return undefined;
  const others = issue.partners.map(endName).join(", ");
  return `${endName(issue.end)} ${pt(issue.end.p)} coincides with ${issue.partners.length} other ends (${others}); exactly one may meet it. Remove the duplicate/overlapping curve, or move one loop so the loops do not touch.`;
}

function crossingHint(sk: SketchFeature): string | undefined {
  const x = firstCrossing(sk.curves);
  if (!x) return undefined;
  if (x.overlap) return `${describeCurve(x.a)} and ${describeCurve(x.b)} overlap along a stretch. Delete one, or make them meet only at shared endpoints.`;
  const where = x.at ? ` at ${pt(x.at)}` : "";
  let extra = "";
  const circle = x.a.kind === "circle" ? x.a : x.b.kind === "circle" ? x.b : undefined;
  const other = circle === x.a ? x.b : x.a;
  if (circle) {
    const d = distanceToCurve(circle.center, other);
    extra = ` The circle's center is ${num(d)} mm from '${other.id}' but its radius is ${num(circle.radius)}: move it so the distance exceeds the radius by at least a wall thickness (e.g. ≥ ${num(circle.radius + 1)} mm), or reduce the radius.`;
  } else {
    extra = " Curves may only meet end-to-end: split the shape at that point into curves that share endpoints, or move one curve.";
  }
  return `${describeCurve(x.a)} and ${describeCurve(x.b)} meet${where}, not at a shared endpoint.${extra}`;
}

/** Curve ids from an engine message like `region ['a', 'b'] of sketch 's' …`. */
function regionIdsFromMessage(message: string | undefined): string[] | undefined {
  const m = message?.match(/region \[([^\]]*)\]/);
  if (!m) return undefined;
  const ids = [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!);
  return ids.length > 0 ? ids : undefined;
}

function revolveHint(ir: IrDocument | null | undefined, feature: string | undefined, message: string | undefined): string | undefined {
  const f = findFeatureIn(ir, feature);
  if (!f || f.type !== "revolve") return undefined;
  const rev = f as RevolveFeature;
  const sk = sketchOf(ir, rev.sketch);
  if (!sk) return undefined;
  const ids = regionIdsFromMessage(message);
  const curves = ids ? sk.curves.filter((c) => ids.includes(c.id)) : sk.curves;
  const axis = { origin: rev.axis.origin as P2, direction: rev.axis.direction as P2 };
  const ext = curves.map((c) => ({ c, e: sideExtent(c, axis) }));
  const pos = Math.max(0, ...ext.map((x) => x.e.max));
  const neg = Math.max(0, ...ext.map((x) => -x.e.min));
  const tol = 1e-6;
  if (pos <= tol || neg <= tol) return undefined;
  const ax = describeAxis(axis);
  // The smaller excursion is most likely the mistake.
  const wrongIsNeg = neg <= pos;
  const wrongSide = wrongIsNeg ? ax.negativeSide : ax.positiveSide;
  const rightSide = wrongIsNeg ? ax.positiveSide : ax.negativeSide;
  const offenders = ext
    .filter((x) => (wrongIsNeg ? x.e.min < -tol : x.e.max > tol))
    .map((x) => `'${x.c.id}' (reaches ${pt(wrongIsNeg ? x.e.argmin : x.e.argmax)}, ${num(wrongIsNeg ? -x.e.min : x.e.max)} mm across)`);
  return (
    `Axis = ${ax.line} in sketch '${sk.name}' coordinates. The profile${ids ? ` region [${ids.join(", ")}]` : ""} lies mostly on the ${rightSide} side (up to ${num(wrongIsNeg ? pos : neg)} mm) but ${offenders.slice(0, 4).join(", ")}${offenders.length > 4 ? ", …" : ""} ` +
    `cross${offenders.length === 1 ? "es" : ""} to the ${wrongSide} side. Move those points onto the axis or to the ${rightSide} side (touching the axis is fine), or move the axis so the whole region is on one side.`
  );
}

function dependencyHint(ir: IrDocument | null | undefined, feature: string | undefined, message: string | undefined): string | undefined {
  const f = findFeatureIn(ir, feature);
  if (!f || f.type === "sketch") return undefined;
  const code = message?.match(/failed with ([A-Z_]+)/)?.[1];
  return `'${f.name}' consumes sketch '${f.sketch}', which failed${code ? ` with ${code}` : ""}. Fix '${f.sketch}' (see its own error and hint); '${f.name}' recovers automatically.`;
}

// ── Compile-diagnostic helpers: read literal values at a span ──

function literalNumber(e: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(e)) return Number(e.text);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return -Number(e.operand.text);
  if (ts.isParenthesizedExpression(e)) return literalNumber(e.expression);
  return undefined;
}

function literalVec2(e: ts.Expression | undefined): P2 | undefined {
  if (!e || !ts.isArrayLiteralExpression(e) || e.elements.length !== 2) return undefined;
  const a = literalNumber(e.elements[0]!);
  const b = literalNumber(e.elements[1]!);
  return a === undefined || b === undefined ? undefined : [a, b];
}

/** The innermost `name(...)` call whose range contains `pos`. */
function callAt(sf: ts.SourceFile, pos: number, name: string): ts.CallExpression | undefined {
  let found: ts.CallExpression | undefined;
  const visit = (n: ts.Node) => {
    if (pos < n.getStart(sf) || pos > n.end) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) found = n;
    n.forEachChild(visit);
  };
  sf.forEachChild(visit);
  return found;
}

function inconsistentArcHint(source: string | undefined, span: Span | undefined): string | undefined {
  if (source === undefined || span === undefined) return undefined;
  const sf = ts.createSourceFile("main.cad.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let pos: number;
  try {
    pos = sf.getPositionOfLineAndCharacter(span.start.line - 1, span.start.col - 1);
  } catch {
    return undefined;
  }
  // The span may start at the property key (`a: arc(…)`): look a little to the right as well.
  const call = callAt(sf, pos, "arc") ?? callAt(sf, Math.min(source.length, pos + 12), "arc");
  const obj = call?.arguments[0];
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  const prop = (k: string) => {
    const p = obj.properties.find((x) => ts.isPropertyAssignment(x) && ts.isIdentifier(x.name) && x.name.text === k);
    return p && ts.isPropertyAssignment(p) ? literalVec2(p.initializer) : undefined;
  };
  const s = prop("start");
  const e = prop("end");
  const c = prop("center");
  if (!s || !e || !c) return undefined;
  const rs = Math.hypot(s[0] - c[0], s[1] - c[1]);
  const re = Math.hypot(e[0] - c[0], e[1] - c[1]);
  if (re === 0) return undefined;
  const fixed: P2 = [c[0] + ((e[0] - c[0]) * rs) / re, c[1] + ((e[1] - c[1]) * rs) / re];
  return `|start−center| = ${num(rs)} but |end−center| = ${num(re)}. Keep start and center (r = ${num(rs)}) and set end to ${vec(fixed)} (same direction from the center), or move the center onto the perpendicular bisector of start and end.`;
}

/**
 * The repair hint for an error: computed from the IR/source when possible, else the playbook's
 * static hint, else a generic fallback. Never empty.
 */
export function repairHint(code: string, ctx: HintContext = {}): string {
  let computed: string | undefined;
  try {
    switch (code) {
      case "SKETCH_OPEN_LOOP": {
        const sk = sketchOf(ctx.ir, ctx.feature);
        computed = sk ? openLoopHint(sk) : undefined;
        break;
      }
      case "SKETCH_BRANCHING": {
        const sk = sketchOf(ctx.ir, ctx.feature);
        computed = sk ? branchingHint(sk) : undefined;
        break;
      }
      case "SKETCH_CURVES_CROSS": {
        const sk = sketchOf(ctx.ir, ctx.feature);
        computed = sk ? crossingHint(sk) : undefined;
        break;
      }
      case "REVOLVE_CROSSES_AXIS":
        computed = revolveHint(ctx.ir, ctx.feature, ctx.message);
        break;
      case "DEPENDENCY_FAILED":
        computed = dependencyHint(ctx.ir, ctx.feature, ctx.message);
        break;
      case "SKETCH_SUPPRESSED": {
        const f = findFeatureIn(ctx.ir, ctx.feature);
        if (f && f.type !== "sketch") computed = `Sketch '${f.sketch}' is suppressed: remove \`suppressed: true\` from '${f.sketch}', or delete '${f.name}'.`;
        break;
      }
      case "INCONSISTENT_ARC":
        computed = inconsistentArcHint(ctx.source, ctx.span);
        break;
    }
  } catch {
    computed = undefined; // A hint must never break the tool result.
  }
  const base = staticHint(code) ?? "Unknown error code: read the message, make the smallest change that addresses it, and re-apply.";
  if (computed === undefined) return base;
  // Keep the rule for the codes whose computed hint is purely local.
  return code === "SKETCH_OPEN_LOOP" || code === "SKETCH_BRANCHING" ? `${computed} (${CURVE_RULES})` : computed;
}

/** For tests and docs: does the first endpoint issue of this sketch explain an open loop? */
export function hasOpenEnd(sk: SketchFeature): boolean {
  const i = firstEndpointIssue(sk.curves);
  return i !== undefined && i.partners.length === 0;
}
