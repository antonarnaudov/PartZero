/**
 * The CadScript v0 compiler: source text → Feature-Graph IR.
 *
 * The source is *parsed* with the TypeScript compiler API and lowered statement by statement; it
 * is never executed. Only literals are accepted in argument positions. After lowering, the IR is
 * checked with {@link validateIr} (a mirror of forge-ir's `validate.rs`) and every problem is
 * reported as a {@link Diagnostic} with a source span.
 */
import ts from "typescript";
import {
  IR_SCHEMA,
  type ExtrudeFeature,
  type Feature,
  type IrDocument,
  type Meta,
  type P2,
  type P3,
  type PlaneSpec,
  type RevolveFeature,
  type SketchCurve,
  type SketchFeature,
  type SweepDirection,
} from "@aicad/ir-types";
import { isStackOverflow, parseWithinLimits, stackOverflowProblem, tooComplexDiagnostic, type TooComplex } from "./complexity.js";
import { compareSpans, DIAGNOSTIC_CODES, type Diagnostic, type DiagnosticCode, type Span } from "./diagnostics.js";
import { assignIds } from "./identity.js";
import {
  BUILTINS,
  closest,
  COMPILE_AS_V1,
  CURVE_BUILTINS,
  FEATURE_BUILTINS,
  formatNumber,
  FUTURE_BUILTINS,
  isBuiltin,
  PLANE_CONSTANTS,
  RESERVED_WORDS,
  STD_MODULE,
  SWEEP_DIRECTIONS,
  type Builtin,
  type FeatureBuiltin,
} from "./syntax.js";
import { attachedComments } from "./trivia.js";
import { validateIr } from "./validate.js";

export interface CompileOptions {
  /**
   * The IR this source was printed from (or last compiled to). Part and feature ids are carried
   * over by name (see `identity.ts`); explicit default-valued fields present in `base` are kept.
   */
  base?: IrDocument | undefined;
  /** Used in messages only. */
  fileName?: string | undefined;
}

export interface CompileResult {
  /** True when there are no error diagnostics. */
  ok: boolean;
  /** The compiled document, or `null` when there are errors. */
  ir: IrDocument | null;
  /** Errors, warnings and infos, sorted by position. */
  diagnostics: Diagnostic[];
  /** Feature id → span of its `const` statement. (Ids are unique per document unless `base` reuses them across parts.) */
  spans: Record<string, Span>;
  /** Feature id → curve id → span of the `id: curve(…)` property. */
  curveSpans: Record<string, Record<string, Span>>;
  /** Part id → span of its `part("…")` statement. */
  partSpans: Record<string, Span>;
  /**
   * IR path (JSON-pointer-like, as in forge-ir `ValidationError.path`) → span of the code that
   * produced it, e.g. `/parts/0/features/1/distance`. Use {@link spanForIrPath} for lookups.
   */
  pathSpans: Record<string, Span>;
  /** Feature id → raw text of the comments attached above its statement (trivia; not stored in the IR). */
  comments: Record<string, string>;
}

/** What a top-level statement is, for tools that edit the source (see `applyIrEdit`). */
export interface SourceStatement {
  node: ts.Statement;
  kind: "import" | "doc" | "part" | "feature" | "other";
  /** Index into `ir.parts` for `part`/`feature` statements, else -1. */
  partIndex: number;
  /** Index into the part's `features` for `feature` statements, else -1. */
  featureIndex: number;
}

interface AnalysisBase {
  result: CompileResult;
  /** The lowered document even when there are errors (placeholders where lowering failed). */
  doc: IrDocument;
  statements: SourceStatement[];
}

/**
 * @internal The full analysis behind {@link compile}. `hasSyntaxErrors` is true when nothing was
 * lowered: the source has syntax errors (`CS_SYNTAX`) or is nested beyond the limits
 * (`CS_TOO_COMPLEX`; then `sf` may be missing).
 */
export type Analysis =
  | (AnalysisBase & { sf: ts.SourceFile; hasSyntaxErrors: false })
  | (AnalysisBase & { sf: ts.SourceFile | undefined; hasSyntaxErrors: true });

/** Compile CadScript source to an IR document. */
export function compile(source: string, options: CompileOptions = {}): CompileResult {
  return analyze(source, options).result;
}

/** Look up the span for an IR path, falling back to the closest enclosing path that has one. */
export function spanForIrPath(result: Pick<CompileResult, "pathSpans">, path: string): Span | undefined {
  let p = path;
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(result.pathSpans, p)) return result.pathSpans[p];
    if (p === "") return undefined;
    p = p.slice(0, p.lastIndexOf("/"));
  }
}

// ─── Internal model ──────────────────────────────────────────────────────────────────────────

interface SketchBody {
  type: "sketch";
  plane: PlaneSpec;
  curves: SketchCurve[];
  suppressed: boolean;
}
interface ExtrudeBody {
  type: "extrude";
  sketch: string;
  distance: number;
  direction: SweepDirection | undefined;
  suppressed: boolean;
}
interface RevolveBody {
  type: "revolve";
  sketch: string;
  axis: { origin: P2; direction: P2 };
  angle: number;
  direction: SweepDirection | undefined;
  suppressed: boolean;
}
type Body = SketchBody | ExtrudeBody | RevolveBody;

interface LFeature {
  name: string;
  type: FeatureBuiltin;
  stmt: ts.VariableStatement;
  nameNode: ts.Identifier;
  broken: boolean;
  body: Body;
  /** Path relative to the feature (`/distance`, `/curves/0/id`, …) → node. */
  paths: Map<string, ts.Node>;
  curves: { id: string; node: ts.Node }[];
  comment: string | undefined;
}

interface LPart {
  name: string;
  stmt: ts.Statement | undefined;
  nameNode: ts.Node | undefined;
  implicit: boolean;
  features: LFeature[];
}

interface NameEntry {
  type: FeatureBuiltin | "invalid";
  partIndex: number;
  node: ts.Node;
  sketch?: string;
  /** For `const w = 80 / 2;` (not a feature): the folded value, for hints. */
  value?: number;
}

const FEATURE_USAGE: Record<FeatureBuiltin, string> = {
  sketch: "const base = sketch(XY, { a: line([0, 0], [10, 0]), … })",
  extrude: "const plate = extrude(base, { distance: 8 })",
  revolve: "const body = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 })",
};

const V1_HINT = `expressions and param() are CadScript v1: ${COMPILE_AS_V1}`;

class Ctx {
  readonly diagnostics: Diagnostic[] = [];
  readonly imported = new Set<string>();
  readonly notImportedReported = new Set<string>();
  readonly names = new Map<string, NameEntry>();
  /** Every `const` name declared anywhere in the file (for forward-reference hints). */
  readonly declared = new Map<string, ts.Node>();
  /** Set when an error is reported that makes the current feature's IR unreliable. */
  broken = false;
  currentPart = -1;

  constructor(readonly sf: ts.SourceFile) {}

  span(node: ts.Node): Span {
    return this.spanOf(node.getStart(this.sf), node.getEnd());
  }

  spanOf(start: number, end: number): Span {
    const s = this.sf.getLineAndCharacterOfPosition(start);
    const e = this.sf.getLineAndCharacterOfPosition(end);
    return { start: { line: s.line + 1, col: s.character + 1 }, end: { line: e.line + 1, col: e.character + 1 } };
  }

  report(code: DiagnosticCode, node: ts.Node, message: string, hint?: string, breaks = true): undefined {
    const d: Diagnostic = { code, severity: DIAGNOSTIC_CODES[code].severity, message, span: this.span(node) };
    if (hint) d.hint = hint;
    this.diagnostics.push(d);
    if (breaks && d.severity === "error") this.broken = true;
    return undefined;
  }

  text(node: ts.Node): string {
    return node.getText(this.sf);
  }

  /** Report CS_NOT_IMPORTED once per builtin. */
  use(name: Builtin, node: ts.Node): void {
    if (this.imported.has(name) || this.notImportedReported.has(name)) return;
    this.notImportedReported.add(name);
    this.report(
      "CS_NOT_IMPORTED",
      node,
      `\`${name}\` is used but not imported`,
      `add it to the import: import { ${[...this.imported, name].join(", ")} } from "${STD_MODULE}";`,
      false,
    );
  }
}

// ─── Literal readers ─────────────────────────────────────────────────────────────────────────

const ARITHMETIC = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AsteriskAsteriskToken,
]);

function numericValue(lit: ts.NumericLiteral): number {
  // The scanner normalises hex/octal/binary literals and strips numeric separators in `.text`.
  return Number(lit.text.replace(/_/g, ""));
}

function arithmetic(op: ts.SyntaxKind, a: number, b: number): number {
  switch (op) {
    case ts.SyntaxKind.PlusToken:
      return a + b;
    case ts.SyntaxKind.MinusToken:
      return a - b;
    case ts.SyntaxKind.AsteriskToken:
      return a * b;
    case ts.SyntaxKind.SlashToken:
      return a / b;
    case ts.SyntaxKind.PercentToken:
      return a % b;
    default:
      return a ** b;
  }
}

/**
 * Constant-fold literal arithmetic (for hints only; the value is never used).
 *
 * Iterative (explicit stacks, post-order): a left-associative chain `1 + 1 + … + 1` is a tree
 * as deep as it is long, which the nesting limits deliberately allow (see `complexity.ts`).
 */
function fold(root: ts.Expression): number | undefined {
  /** `expanded`: the operands are already on `values`; apply the operator. */
  const work: { e: ts.Expression; expanded: boolean }[] = [{ e: root, expanded: false }];
  const values: number[] = [];
  while (work.length > 0) {
    const { e, expanded } = work.pop()!;
    if (ts.isNumericLiteral(e)) {
      values.push(numericValue(e));
    } else if (ts.isParenthesizedExpression(e)) {
      work.push({ e: e.expression, expanded: false });
    } else if (ts.isPrefixUnaryExpression(e) && (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken)) {
      if (!expanded) work.push({ e, expanded: true }, { e: e.operand, expanded: false });
      else if (e.operator === ts.SyntaxKind.MinusToken) values.push(-values.pop()!);
    } else if (ts.isBinaryExpression(e) && ARITHMETIC.has(e.operatorToken.kind)) {
      if (!expanded) {
        // Popped in reverse: the left operand is evaluated first.
        work.push({ e, expanded: true }, { e: e.right, expanded: false }, { e: e.left, expanded: false });
      } else {
        const b = values.pop()!;
        const a = values.pop()!;
        values.push(arithmetic(e.operatorToken.kind, a, b));
      }
    } else {
      return undefined;
    }
  }
  return values[0];
}

/**
 * The hint for literal arithmetic / parentheses / a unary sign in v0: the constant-folded value
 * first (the concrete repair an agent in a v0 session can apply right away), then the v1 pointer.
 * Falls back to the v1 pointer alone when the expression does not fold to a finite number.
 */
function literalHint(e: ts.Expression): string {
  const v = fold(e);
  return v !== undefined && Number.isFinite(v)
    ? `use a numeric literal: ${formatNumber(v)}; or keep the expression and ${COMPILE_AS_V1}`
    : V1_HINT;
}

/** A non-literal expression where a literal was expected. */
function unsupported(ctx: Ctx, e: ts.Node, expected: string, what: string): undefined {
  const where = `in ${what}`;
  if (ts.isBinaryExpression(e)) {
    if (ARITHMETIC.has(e.operatorToken.kind)) {
      return ctx.report("CS_EXPR_UNSUPPORTED", e, `arithmetic is not supported ${where}`, literalHint(e));
    }
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `\`${ts.tokenToString(e.operatorToken.kind) ?? "operator"}\` expressions are not supported ${where}`, `write ${expected} as a literal`);
  }
  if (ts.isParenthesizedExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `parenthesised expressions are not supported ${where}`, literalHint(e));
  }
  if (ts.isPrefixUnaryExpression(e) || ts.isPostfixUnaryExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `only a leading \`-\` on a number literal is supported ${where}`, literalHint(e as ts.Expression));
  }
  if (ts.isIdentifier(e)) {
    const entry = ctx.names.get(e.text);
    if (entry && entry.type !== "invalid") {
      return ctx.report("CS_EXPR_UNSUPPORTED", e, `\`${e.text}\` is a ${entry.type} feature, not ${expected}`, `${what} expects ${expected}`);
    }
    if (isBuiltin(e.text)) {
      return ctx.report("CS_BAD_ARGUMENT", e, `\`${e.text}\` is not ${expected}`, `${what} expects ${expected}`);
    }
    // The folded value of `const t = 8 * 2;` first (the concrete repair in a v0 session), then v1.
    const v = entry?.value;
    return ctx.report(
      "CS_EXPR_UNSUPPORTED",
      e,
      `\`${e.text}\` is a variable reference; CadScript v0 arguments must be literals`,
      v !== undefined && Number.isFinite(v)
        ? `inline the literal ${formatNumber(v)}; or keep \`${e.text}\` as a param() const and ${COMPILE_AS_V1}`
        : `named values are param() consts of CadScript v1: ${COMPILE_AS_V1}`,
    );
  }
  if (ts.isCallExpression(e)) {
    const callee = ts.isIdentifier(e.expression) ? e.expression.text : undefined;
    if (callee && isBuiltin(callee)) {
      return ctx.report("CS_BAD_ARGUMENT", e, `${callee}() is not ${expected}`, `${what} expects ${expected}`);
    }
    const future = callee ? FUTURE_BUILTINS[callee] : undefined;
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `function calls are not supported ${where}`, future ?? V1_HINT);
  }
  if (ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTaggedTemplateExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `template strings are not supported ${where}`, 'use a plain "double-quoted" string literal');
  }
  if (ts.isSpreadElement(e) || ts.isSpreadAssignment(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `spreads are not supported ${where}`, "list every element explicitly");
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `property access is not supported ${where}`, `queries and param() are CadScript v1: ${COMPILE_AS_V1}`);
  }
  if (ts.isConditionalExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `conditional expressions are not supported ${where}`, "write the chosen value as a literal");
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isClassExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `functions are not supported ${where}`, "CadScript v0 is declarative: write literals");
  }
  if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `type assertions are not supported ${where}`, "remove the assertion; the literal is typed already");
  }
  return ctx.report("CS_EXPR_UNSUPPORTED", e, `this expression is not supported ${where}; expected ${expected}`, V1_HINT);
}

/** A literal of the wrong kind (or a non-literal) where `expected` was wanted. */
function mismatch(ctx: Ctx, e: ts.Expression, expected: string, what: string): undefined {
  const got = (kind: string, hint?: string): undefined =>
    ctx.report("CS_BAD_ARGUMENT", e, `${what} must be ${expected}, got ${kind}`, hint);
  if (ts.isStringLiteral(e)) {
    const asNumber = Number(e.text);
    if (expected.startsWith("a number") && e.text.trim() !== "" && Number.isFinite(asNumber)) {
      return got("a string", `remove the quotes: ${e.text.trim()}`);
    }
    return got("a string");
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return got("a boolean");
  if (e.kind === ts.SyntaxKind.NullKeyword) return got("null");
  if (ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand))) {
    return got("a number");
  }
  if (ts.isArrayLiteralExpression(e)) return got(`an array of ${e.elements.length}`);
  if (ts.isObjectLiteralExpression(e)) return got("an object");
  return unsupported(ctx, e, expected, what);
}

function readNumber(ctx: Ctx, e: ts.Expression, what: string, unit = "mm"): number | undefined {
  if (ts.isNumericLiteral(e)) return numericValue(e);
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) {
    const v = -numericValue(e.operand);
    return v === 0 ? 0 : v; // canonical: no -0
  }
  return mismatch(ctx, e, `a number (${unit})`, what);
}

function readVec(ctx: Ctx, e: ts.Expression, n: 2 | 3, what: string): number[] | undefined {
  const shape = n === 2 ? "[u, v]" : "[x, y, z]";
  if (!ts.isArrayLiteralExpression(e)) return mismatch(ctx, e, `a point ${shape}`, what);
  const out: number[] = [];
  let ok = true;
  for (const el of e.elements) {
    if (ts.isSpreadElement(el)) {
      unsupported(ctx, el, "a number", what);
      ok = false;
      continue;
    }
    if (ts.isOmittedExpression(el)) {
      ctx.report("CS_BAD_ARGUMENT", e, `${what} has an empty slot`, `write ${shape} with ${n} numbers`);
      ok = false;
      continue;
    }
    const v = readNumber(ctx, el, what);
    if (v === undefined) ok = false;
    else out.push(v);
  }
  if (ok && e.elements.length !== n) {
    ctx.report("CS_BAD_ARGUMENT", e, `${what} must have ${n} numbers ${shape}, got ${e.elements.length}`, `write ${shape}`);
    return undefined;
  }
  return ok ? out : undefined;
}

function readBool(ctx: Ctx, e: ts.Expression, what: string): boolean | undefined {
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  return mismatch(ctx, e, "`true` or `false`", what);
}

function readString(ctx: Ctx, e: ts.Expression, what: string): string | undefined {
  if (ts.isStringLiteral(e)) return e.text;
  return mismatch(ctx, e, "a string", what);
}

type Props = Map<string, { key: ts.Node; value: ts.Expression; prop: ts.Node }>;

/**
 * Read an object literal with a fixed set of keys. Unknown, duplicate and missing keys are
 * reported; the returned map holds every well-formed property that is allowed.
 */
function readObject(
  ctx: Ctx,
  e: ts.Expression,
  what: string,
  required: readonly string[],
  optional: readonly string[],
  keyHints: Readonly<Record<string, string>> = {},
): Props | undefined {
  if (!ts.isObjectLiteralExpression(e)) {
    return mismatch(ctx, e, `an object { ${[...required, ...optional.map((o) => `${o}?`)].join(", ")} }`, what);
  }
  const allowed = [...required, ...optional];
  const props: Props = new Map();
  for (const p of e.properties) {
    if (ts.isSpreadAssignment(p)) {
      unsupported(ctx, p, "a property", what);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      ctx.report("CS_EXPR_UNSUPPORTED", p, `shorthand property \`${p.name.text}\` refers to a variable`, `write \`${p.name.text}: <literal>\``);
      continue;
    }
    if (!ts.isPropertyAssignment(p)) {
      ctx.report("CS_EXPR_UNSUPPORTED", p, `methods and accessors are not supported in ${what}`, "write `key: <literal>`");
      continue;
    }
    const key = propertyKey(ctx, p.name, what);
    if (key === undefined) continue;
    if (!allowed.includes(key)) {
      const near = closest(key, allowed);
      const hint = keyHints[key] ?? (near ? `did you mean \`${near}\`?` : `allowed: ${allowed.join(", ")}`);
      ctx.report("CS_BAD_ARGUMENT", p.name, `unknown property \`${key}\` in ${what}`, hint);
      continue;
    }
    if (props.has(key)) {
      ctx.report("CS_BAD_ARGUMENT", p.name, `duplicate property \`${key}\` in ${what}`, "remove one of them");
      continue;
    }
    props.set(key, { key: p.name, value: p.initializer, prop: p });
  }
  const missing = required.filter((k) => !props.has(k));
  if (missing.length > 0) {
    ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `${what} is missing ${missing.map((m) => `\`${m}\``).join(", ")}`,
      `required: ${required.join(", ")}${optional.length ? `; optional: ${optional.join(", ")}` : ""}`,
    );
  }
  return props;
}

function propertyKey(ctx: Ctx, name: ts.PropertyName, what: string): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    ctx.report("CS_EXPR_UNSUPPORTED", name, `computed property names are not supported in ${what}`, "write the key literally");
    return undefined;
  }
  ctx.report("CS_BAD_ARGUMENT", name, `property names in ${what} must be identifiers or "strings"`, `write "${ctx.text(name)}" as a quoted key`);
  return undefined;
}

/** Check a builtin call's argument list; returns the arguments when the count is right. */
function callArgs(ctx: Ctx, call: ts.CallExpression, name: string, min: number, max: number, usage: string): readonly ts.Expression[] | undefined {
  if (call.questionDotToken) ctx.report("CS_EXPR_UNSUPPORTED", call, "optional calls (`?.()`) are not supported", `write ${usage}`);
  if (call.typeArguments) ctx.report("CS_BAD_ARGUMENT", call, `type arguments are not supported on ${name}()`, `write ${usage}`);
  const spread = call.arguments.find(ts.isSpreadElement);
  if (spread) return unsupported(ctx, spread, "an argument", `${name}()`);
  const n = call.arguments.length;
  if (n < min || n > max) {
    const count = min === max ? `${min}` : `${min}–${max}`;
    return ctx.report("CS_BAD_ARGUMENT", call, `${name}() takes ${count} argument${max === 1 ? "" : "s"}, got ${n}`, `usage: ${usage}`);
  }
  return call.arguments;
}

// ─── Statement lowering ──────────────────────────────────────────────────────────────────────

function calleeOf(e: ts.Expression): string | undefined {
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : undefined;
}

function readPlane(ctx: Ctx, e: ts.Expression, lf: LFeature): PlaneSpec | undefined {
  lf.paths.set("/plane", e);
  const expected = "a plane: XY, XZ, YZ or frame({ origin, normal, xDir })";
  if (ts.isIdentifier(e)) {
    if ((PLANE_CONSTANTS as readonly string[]).includes(e.text)) {
      ctx.use(e.text as Builtin, e);
      return e.text as "XY" | "XZ" | "YZ";
    }
    const entry = ctx.names.get(e.text);
    if (entry && entry.type !== "invalid") {
      return ctx.report("CS_BAD_ARGUMENT", e, `\`${e.text}\` is a ${entry.type} feature, not a plane`, `sketching on faces is CadScript v1: ${COMPILE_AS_V1}`);
    }
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `\`${e.text}\` is not a plane constant`, "use XY, XZ, YZ or an inline frame({ origin, normal, xDir })");
  }
  if (ts.isStringLiteral(e) && (PLANE_CONSTANTS as readonly string[]).includes(e.text)) {
    return ctx.report("CS_BAD_ARGUMENT", e, "planes are constants, not strings", `write ${e.text} without quotes`);
  }
  const callee = calleeOf(e);
  if (callee === "frame") {
    const call = e as ts.CallExpression;
    ctx.use("frame", call.expression);
    const args = callArgs(ctx, call, "frame", 1, 1, "frame({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] })");
    if (!args) return undefined;
    const props = readObject(ctx, args[0]!, "frame()", ["origin", "normal", "xDir"], [], {
      x_dir: "CadScript spells it `xDir`",
      x: "the frame's u axis is `xDir`",
      y: "the v axis is derived: normal × xDir",
      yDir: "the v axis is derived: normal × xDir",
    });
    if (!props) return undefined;
    const get = (k: string): P3 | undefined => {
      const p = props.get(k);
      return p ? (readVec(ctx, p.value, 3, `frame ${k}`) as P3 | undefined) : undefined;
    };
    const origin = get("origin");
    const normal = get("normal");
    const xDir = get("xDir");
    if (!origin || !normal || !xDir) return undefined;
    return { origin, normal, x_dir: xDir };
  }
  if (callee && !isBuiltin(callee)) {
    return ctx.report("CS_UNKNOWN_BUILTIN", e, `${callee}() is not a CadScript v0 builtin`, FUTURE_BUILTINS[callee] ?? "use XY, XZ, YZ or frame({ … })");
  }
  return mismatch(ctx, e, expected, "the sketch plane");
}

function lowerCurve(ctx: Ctx, id: string, e: ts.Expression): SketchCurve | undefined {
  const callee = calleeOf(e);
  const expected = "a curve: line(…), arc({ … }) or circle({ … })";
  if (!callee) return mismatch(ctx, e, expected, `curve \`${id}\``);
  const call = e as ts.CallExpression;
  if (!isBuiltin(callee)) {
    const near = closest(callee, CURVE_BUILTINS);
    return ctx.report(
      "CS_UNKNOWN_BUILTIN",
      call.expression,
      `${callee}() is not a CadScript v0 builtin`,
      FUTURE_BUILTINS[callee] ?? (near ? `did you mean ${near}()?` : "sketch curves are line(), arc() and circle()"),
    );
  }
  if (!(CURVE_BUILTINS as readonly string[]).includes(callee)) {
    return ctx.report("CS_BAD_ARGUMENT", call.expression, `${callee}() is not a sketch curve`, "sketch curves are line(), arc() and circle()");
  }
  ctx.use(callee as Builtin, call.expression);
  const what = `${callee} \`${id}\``;
  switch (callee) {
    case "line": {
      const args = callArgs(ctx, call, "line", 2, 2, "line([u1, v1], [u2, v2])");
      if (!args) return undefined;
      const start = readVec(ctx, args[0]!, 2, `${what} start`);
      const end = readVec(ctx, args[1]!, 2, `${what} end`);
      return start && end ? { kind: "line", id, start: start as P2, end: end as P2 } : undefined;
    }
    case "arc": {
      const args = callArgs(ctx, call, "arc", 1, 1, "arc({ start: [u, v], end: [u, v], center: [u, v], ccw: true })");
      if (!args) return undefined;
      const props = readObject(ctx, args[0]!, what, ["start", "end", "center", "ccw"], [], {
        radius: "an arc's radius is implied: |start − center|",
        cw: "use `ccw: false` for a clockwise arc",
        mid: "v0 arcs are start/end/center; three-point arcs arrive later",
      });
      if (!props) return undefined;
      const v = (k: string): P2 | undefined => {
        const p = props.get(k);
        return p ? (readVec(ctx, p.value, 2, `${what} ${k}`) as P2 | undefined) : undefined;
      };
      const start = v("start");
      const end = v("end");
      const center = v("center");
      const ccwProp = props.get("ccw");
      const ccw = ccwProp ? readBool(ctx, ccwProp.value, `${what} ccw`) : undefined;
      return start && end && center && ccw !== undefined ? { kind: "arc", id, start, end, center, ccw } : undefined;
    }
    default: {
      const args = callArgs(ctx, call, "circle", 1, 1, "circle({ center: [u, v], radius: r })");
      if (!args) return undefined;
      const props = readObject(ctx, args[0]!, what, ["center", "radius"], [], {
        diameter: "use `radius` (diameter / 2)",
        d: "use `radius` (diameter / 2)",
        r: "spell it `radius`",
      });
      if (!props) return undefined;
      const c = props.get("center");
      const r = props.get("radius");
      const center = c ? (readVec(ctx, c.value, 2, `${what} center`) as P2 | undefined) : undefined;
      const radius = r ? readNumber(ctx, r.value, `${what} radius`) : undefined;
      return center && radius !== undefined ? { kind: "circle", id, center, radius } : undefined;
    }
  }
}

function lowerCurves(ctx: Ctx, e: ts.Expression, lf: LFeature): SketchCurve[] {
  lf.paths.set("/curves", e);
  if (!ts.isObjectLiteralExpression(e)) {
    mismatch(ctx, e, "an object of curves { id: line(…), … }", "the sketch curves");
    return [];
  }
  const curves: SketchCurve[] = [];
  for (const p of e.properties) {
    if (ts.isSpreadAssignment(p)) {
      unsupported(ctx, p, "a curve", "the sketch curves");
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      ctx.report("CS_EXPR_UNSUPPORTED", p, `shorthand \`${p.name.text}\` refers to a variable`, `write \`${p.name.text}: line(…)\``);
      continue;
    }
    if (!ts.isPropertyAssignment(p)) {
      ctx.report("CS_EXPR_UNSUPPORTED", p, "methods and accessors are not supported in a sketch", "write `id: line(…)`");
      continue;
    }
    const id = propertyKey(ctx, p.name, "the sketch curves");
    if (id === undefined) continue;
    const curve = lowerCurve(ctx, id, p.initializer);
    if (!curve) continue;
    const i = curves.length;
    curves.push(curve);
    lf.curves.push({ id, node: p });
    lf.paths.set(`/curves/${i}`, p);
    lf.paths.set(`/curves/${i}/id`, p.name);
  }
  return curves;
}

function readSketchRef(ctx: Ctx, e: ts.Expression, lf: LFeature): string {
  lf.paths.set("/sketch", e);
  const usage = FEATURE_USAGE[lf.type];
  if (ts.isIdentifier(e)) {
    const n = e.text;
    const entry = ctx.names.get(n);
    if (!entry) {
      if (ctx.declared.has(n)) {
        ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is used before it is declared`, `features run in file order: move \`const ${n} = sketch(…)\` above \`${lf.name}\``);
      } else if ((PLANE_CONSTANTS as readonly string[]).includes(n)) {
        ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is a plane, not a sketch`, `declare a sketch on it first: const profile = sketch(${n}, { … }), then pass \`profile\``);
      } else {
        const sketches = [...ctx.names].filter(([, v]) => v.type === "sketch").map(([k]) => k);
        const near = closest(n, sketches);
        ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is not declared`, near ? `did you mean \`${near}\`?` : `declare it first: const ${n} = sketch(XY, { … })`);
      }
      return n;
    }
    if (entry.type === "invalid") {
      ctx.broken = true; // already reported at its declaration
      return n;
    }
    if (entry.type !== "sketch") {
      const hint = entry.sketch ? `pass the sketch it was made from: \`${entry.sketch}\`` : "pass a sketch const";
      ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is ${entry.type === "extrude" ? "an" : "a"} ${entry.type}, not a sketch`, hint);
      return n;
    }
    if (entry.partIndex !== ctx.currentPart) {
      ctx.report(
        "CS_UNRESOLVED_SKETCH",
        e,
        `\`${n}\` belongs to another part`,
        "features can only use sketches of their own part; copy the sketch into this part under a new name",
      );
      return n;
    }
    return n;
  }
  if (ts.isStringLiteral(e)) {
    ctx.report("CS_BAD_ARGUMENT", e, "pass the sketch const, not a string", `write ${e.text} without quotes`);
    return "";
  }
  if (calleeOf(e) === "sketch") {
    ctx.report("CS_EXPR_UNSUPPORTED", e, "inline sketches are not supported", `declare the sketch as its own const, then pass its name: ${usage}`);
    return "";
  }
  mismatch(ctx, e, "a sketch const", `${lf.type}()`);
  return "";
}

function readDirection(ctx: Ctx, e: ts.Expression): SweepDirection | undefined {
  if (ts.isIdentifier(e) && (SWEEP_DIRECTIONS as readonly string[]).includes(e.text)) {
    return ctx.report("CS_BAD_ARGUMENT", e, "direction is a string", `write "${e.text}"`);
  }
  const s = readString(ctx, e, "direction");
  if (s === undefined) return undefined;
  if (!(SWEEP_DIRECTIONS as readonly string[]).includes(s)) {
    const near = closest(s, SWEEP_DIRECTIONS);
    return ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `direction must be "normal", "reverse" or "symmetric", got ${JSON.stringify(s)}`,
      near ? `did you mean "${near}"?` : 'use "normal" (default), "reverse" or "symmetric"',
    );
  }
  return s as SweepDirection;
}

const SWEEP_KEY_HINTS: Record<string, string> = {
  op: `v0 features always create new bodies; \`op\` is CadScript v1: ${COMPILE_AS_V1}`,
  regions: "v0 features always use every region of the sketch",
  reverse: 'use direction: "reverse"',
  symmetric: 'use direction: "symmetric"',
  flip: 'use direction: "reverse"',
};

function lowerSketch(ctx: Ctx, call: ts.CallExpression, lf: LFeature): SketchBody {
  const body: SketchBody = { type: "sketch", plane: "XY", curves: [], suppressed: false };
  const args = callArgs(ctx, call, "sketch", 2, 3, FEATURE_USAGE.sketch);
  if (!args) return body;
  const plane = readPlane(ctx, args[0]!, lf);
  if (plane !== undefined) body.plane = plane;
  body.curves = lowerCurves(ctx, args[1]!, lf);
  if (args[2]) {
    const props = readObject(ctx, args[2], "sketch options", [], ["suppressed"]);
    const s = props?.get("suppressed");
    if (s) {
      lf.paths.set("/suppressed", s.value);
      body.suppressed = readBool(ctx, s.value, "suppressed") ?? false;
    }
  }
  return body;
}

function lowerExtrude(ctx: Ctx, call: ts.CallExpression, lf: LFeature): ExtrudeBody {
  const body: ExtrudeBody = { type: "extrude", sketch: "", distance: Number.NaN, direction: undefined, suppressed: false };
  const args = callArgs(ctx, call, "extrude", 2, 2, FEATURE_USAGE.extrude);
  if (!args) return body;
  body.sketch = readSketchRef(ctx, args[0]!, lf);
  const props = readObject(ctx, args[1]!, "extrude options", ["distance"], ["direction", "suppressed"], {
    ...SWEEP_KEY_HINTS,
    depth: "use `distance` (mm)",
    height: "use `distance` (mm)",
    length: "use `distance` (mm)",
  });
  if (!props) return body;
  const d = props.get("distance");
  if (d) {
    lf.paths.set("/distance", d.value);
    body.distance = readNumber(ctx, d.value, "distance") ?? Number.NaN;
  }
  readSweepCommon(ctx, props, body, lf);
  return body;
}

function lowerRevolve(ctx: Ctx, call: ts.CallExpression, lf: LFeature): RevolveBody {
  const body: RevolveBody = {
    type: "revolve",
    sketch: "",
    axis: { origin: [0, 0], direction: [0, 1] },
    angle: Number.NaN,
    direction: undefined,
    suppressed: false,
  };
  const args = callArgs(ctx, call, "revolve", 2, 2, FEATURE_USAGE.revolve);
  if (!args) return body;
  body.sketch = readSketchRef(ctx, args[0]!, lf);
  const props = readObject(ctx, args[1]!, "revolve options", ["axis", "angle"], ["direction", "suppressed"], {
    ...SWEEP_KEY_HINTS,
    degrees: "use `angle` (degrees)",
    sweep: "use `angle` (degrees)",
  });
  if (!props) return body;
  const axis = props.get("axis");
  if (axis) {
    lf.paths.set("/axis", axis.value);
    const ap = readObject(ctx, axis.value, "axis", ["origin", "direction"], [], { dir: "spell it `direction`" });
    const o = ap?.get("origin");
    const dd = ap?.get("direction");
    const origin = o ? (readVec(ctx, o.value, 2, "axis origin") as P2 | undefined) : undefined;
    const direction = dd ? (readVec(ctx, dd.value, 2, "axis direction") as P2 | undefined) : undefined;
    if (origin && direction) body.axis = { origin, direction };
  }
  const a = props.get("angle");
  if (a) {
    lf.paths.set("/angle", a.value);
    body.angle = readNumber(ctx, a.value, "angle", "degrees") ?? Number.NaN;
  }
  readSweepCommon(ctx, props, body, lf);
  return body;
}

function readSweepCommon(ctx: Ctx, props: Props, body: ExtrudeBody | RevolveBody, lf: LFeature): void {
  const dir = props.get("direction");
  if (dir) {
    lf.paths.set("/direction", dir.value);
    body.direction = readDirection(ctx, dir.value);
  }
  const s = props.get("suppressed");
  if (s) {
    lf.paths.set("/suppressed", s.value);
    body.suppressed = readBool(ctx, s.value, "suppressed") ?? false;
  }
}

function statementHint(stmt: ts.Statement): { message: string; hint: string } {
  if (ts.isVariableStatement(stmt)) {
    return { message: "`let`/`var` are not supported", hint: "declare features with `const`" };
  }
  if (ts.isIfStatement(stmt) || ts.isSwitchStatement(stmt)) {
    return { message: "conditionals are not supported in CadScript v0", hint: "write the features you want directly; use `suppressed: true` to switch one off" };
  }
  if (ts.isIterationStatement(stmt, false)) {
    return { message: "loops are not supported in CadScript v0", hint: "write each feature or curve explicitly; loops arrive in the sandboxed customFeature() after v1" };
  }
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
    return { message: "functions and classes are not supported in CadScript v0", hint: "CadScript is declarative: one `const` per feature" };
  }
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) {
    return { message: "exports are not supported", hint: "one file is one document; nothing needs exporting" };
  }
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) {
    return { message: "type declarations are not supported", hint: "remove it; @aicad/std provides the types" };
  }
  if (ts.isEmptyStatement(stmt)) return { message: "stray `;`", hint: "remove it" };
  if (ts.isBlock(stmt)) return { message: "blocks are not supported", hint: "write statements at the top level" };
  return { message: "this statement is not supported in CadScript v0", hint: "a file contains imports, doc(…), part(…) and `const name = feature(…)` statements" };
}

// ─── Driver ──────────────────────────────────────────────────────────────────────────────────

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function hasOwn(obj: object | undefined, key: string): boolean {
  return obj !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * @internal Parse, lower, assign ids, validate. Never throws for any source text: input nested
 * beyond the limits of `complexity.ts` gets a single `CS_TOO_COMPLEX` diagnostic.
 */
export function analyze(source: string, options: CompileOptions = {}): Analysis {
  let sf: ts.SourceFile | undefined;
  try {
    const parsed = parseWithinLimits(options.fileName ?? "main.cad.ts", source, ts.ScriptTarget.Latest);
    sf = parsed.sf;
    if (parsed.problem) return tooComplex(source, parsed.problem, sf);
    return analyzeParsed(parsed.sf, options);
  } catch (e) {
    // Within the limits lowering stays shallow (its recursion is bounded by the grammar, `fold`
    // is iterative); this catches a caller that left almost no stack, so that no input can
    // turn into a thrown RangeError.
    if (!isStackOverflow(e)) throw e;
    return tooComplex(source, stackOverflowProblem("compile"), sf);
  }
}

function tooComplex(source: string, problem: TooComplex, sf: ts.SourceFile | undefined): Analysis {
  const empty: IrDocument = { schema: IR_SCHEMA, parts: [] };
  return { sf, result: emptyResult([tooComplexDiagnostic(source, problem)]), doc: empty, statements: [], hasSyntaxErrors: true };
}

function analyzeParsed(sf: ts.SourceFile, options: CompileOptions): Analysis {
  const ctx = new Ctx(sf);
  const statements: SourceStatement[] = [];
  const parts: LPart[] = [];
  let meta: { name?: string; description?: string } | undefined;
  let docNode: ts.Node | undefined;

  const empty: IrDocument = { schema: IR_SCHEMA, parts: [] };
  const syntax = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (syntax.length > 0) {
    for (const d of syntax) {
      ctx.diagnostics.push({
        code: "CS_SYNTAX",
        severity: "error",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        span: ctx.spanOf(d.start, d.start + d.length),
      });
    }
    return { sf, result: emptyResult(ctx.diagnostics), doc: empty, statements, hasSyntaxErrors: true };
  }

  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && !ctx.declared.has(d.name.text)) ctx.declared.set(d.name.text, d.name);
      }
    }
  }

  let seenBody = false;
  let docSeen = false;
  let imports = 0;
  const ensurePart = (node: ts.Node): void => {
    if (ctx.currentPart >= 0) return;
    ctx.report("CS_MISSING_PART", node, "features must follow a part(\"…\") statement", 'add `part("part");` above the first feature', false);
    parts.push({ name: "part", stmt: undefined, nameNode: undefined, implicit: true, features: [] });
    ctx.currentPart = parts.length - 1;
  };

  for (const stmt of sf.statements) {
    const info: SourceStatement = { node: stmt, kind: "other", partIndex: -1, featureIndex: -1 };
    statements.push(info);

    // import { … } from "@aicad/std";
    if (ts.isImportDeclaration(stmt)) {
      info.kind = "import";
      imports++;
      lowerImport(ctx, stmt, seenBody);
      continue;
    }
    seenBody = true;

    // doc({ … });  part("…");
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      const callee = calleeOf(call);
      if (callee === "doc") {
        info.kind = "doc";
        ctx.use("doc", call.expression);
        const first = statements.length - imports === 1; // (a count: filtering here was quadratic)
        let misplaced = false;
        if (docSeen) {
          ctx.report("CS_DOC_MISPLACED", call, "doc() may appear only once", "merge the metadata into the first doc({ … })");
          misplaced = true;
        } else if (!first) {
          ctx.report("CS_DOC_MISPLACED", call, "doc() must be the first statement after the imports", "move it directly below the import");
          misplaced = true;
        }
        docSeen = true;
        const m = lowerDoc(ctx, call);
        if (!misplaced && m) {
          meta = m;
          docNode = call;
        }
        continue;
      }
      if (callee === "part") {
        info.kind = "part";
        ctx.use("part", call.expression);
        const args = callArgs(ctx, call, "part", 1, 1, 'part("part")');
        const name = args ? readString(ctx, args[0]!, "the part name") : undefined;
        parts.push({ name: name ?? "", stmt, nameNode: args?.[0], implicit: false, features: [] });
        ctx.currentPart = parts.length - 1;
        info.partIndex = ctx.currentPart;
        continue;
      }
      if (callee && (FEATURE_BUILTINS as readonly string[]).includes(callee)) {
        ctx.report("CS_STATEMENT_UNSUPPORTED", stmt, `${callee}() must be assigned to a const: its name is the feature name`, `write ${FEATURE_USAGE[callee as FeatureBuiltin]}`);
        continue;
      }
      if (callee && !isBuiltin(callee)) {
        ctx.report("CS_UNKNOWN_BUILTIN", call.expression, `${callee}() is not a CadScript v0 builtin`, FUTURE_BUILTINS[callee] ?? `statements are doc(…), part(…) and feature consts`);
        continue;
      }
    }

    // const name = feature(…);
    if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) {
      const lf = lowerFeatureStatement(ctx, stmt, ensurePart);
      if (lf) {
        info.kind = "feature";
        info.partIndex = ctx.currentPart;
        info.featureIndex = parts[ctx.currentPart]!.features.length;
        parts[ctx.currentPart]!.features.push(lf);
      }
      continue;
    }

    const { message, hint } = statementHint(stmt);
    ctx.report("CS_STATEMENT_UNSUPPORTED", ts.isVariableStatement(stmt) ? stmt.declarationList : stmt, message, hint);
  }

  // ── Identity ──
  const ids = assignIds(
    parts.map((p) => ({ name: p.name, features: p.features.map((f) => ({ name: f.name, type: f.type })) })),
    options.base,
  );
  for (const r of ids.renames) {
    const part = parts[r.partIndex]!;
    const node = r.kind === "part" ? (part.nameNode ?? part.stmt) : part.features[r.featureIndex]!.nameNode;
    if (!node) continue;
    const what = r.kind === "part" ? "part" : part.features[r.featureIndex]!.type;
    ctx.report(
      "CS_RENAME_DETECTED",
      node,
      `${what} ${JSON.stringify(r.to)} is treated as a rename of ${JSON.stringify(r.from)} (same ${r.kind === "part" ? "" : "type and "}position); keeping id ${JSON.stringify(r.id)}`,
      what === "sketch" ? `update every extrude/revolve that referenced \`${r.from}\`` : undefined,
      false,
    );
  }

  // ── Assembly ──
  const base = options.base;
  const doc = { schema: IR_SCHEMA } as IrDocument;
  const irMeta: Meta = {};
  const baseMeta = base?.meta;
  if (meta?.name) irMeta.name = meta.name;
  else if (hasOwn(baseMeta, "name") && baseMeta!.name === "") irMeta.name = "";
  if (meta?.description) irMeta.description = meta.description;
  else if (hasOwn(baseMeta, "description") && baseMeta!.description === "") irMeta.description = "";
  if (Object.keys(irMeta).length > 0 || hasOwn(base, "meta")) doc.meta = irMeta;
  if (base?.units && hasOwn(base, "units")) doc.units = { length: base.units.length, angle: base.units.angle };
  doc.parts = parts.map((p, pi) => ({
    id: ids.partIds[pi]!,
    name: p.name,
    features: p.features.map((lf, fi) => assembleFeature(lf, ids.featureIds[pi]![fi]!, ids.baseFeatures[pi]![fi])),
  }));

  // ── Source maps ──
  const result = emptyResult(ctx.diagnostics);
  const pathSpans: Record<string, Span> = result.pathSpans;
  setOwn(pathSpans, "", ctx.spanOf(0, sf.text.length));
  if (docNode) setOwn(pathSpans, "/meta", ctx.span(docNode));
  parts.forEach((p, pi) => {
    const pid = ids.partIds[pi]!;
    const pp = `/parts/${pi}`;
    const anchor = p.stmt ?? p.features[0]?.stmt;
    if (anchor) {
      setOwn(pathSpans, pp, ctx.span(anchor));
      setOwn(pathSpans, `${pp}/id`, ctx.span(anchor));
      if (p.stmt) setOwn(result.partSpans, pid, ctx.span(p.stmt));
    }
    if (p.nameNode) setOwn(pathSpans, `${pp}/name`, ctx.span(p.nameNode));
    p.features.forEach((lf, fi) => {
      const fid = ids.featureIds[pi]![fi]!;
      const fp = `${pp}/features/${fi}`;
      setOwn(result.spans, fid, ctx.span(lf.stmt));
      setOwn(pathSpans, fp, ctx.span(lf.stmt));
      setOwn(pathSpans, `${fp}/id`, ctx.span(lf.nameNode));
      setOwn(pathSpans, `${fp}/name`, ctx.span(lf.nameNode));
      for (const [rel, node] of lf.paths) setOwn(pathSpans, `${fp}${rel}`, ctx.span(node));
      const cs: Record<string, Span> = {};
      for (const c of lf.curves) if (!hasOwn(cs, c.id)) setOwn(cs, c.id, ctx.span(c.node));
      setOwn(result.curveSpans, fid, cs);
      if (lf.comment) setOwn(result.comments, fid, lf.comment);
    });
  });

  // ── IR validation (mirror of forge-ir validate.rs) ──
  const brokenPaths = new Set(parts.flatMap((p, pi) => p.features.flatMap((f, fi) => (f.broken ? [`/parts/${pi}/features/${fi}`] : []))));
  for (const e of validateIr(doc)) {
    const featurePath = /^\/parts\/\d+\/features\/\d+(?=\/|$)/.exec(e.path)?.[0];
    if (featurePath !== undefined && brokenPaths.has(featurePath)) continue;
    const code = e.code as DiagnosticCode;
    const d: Diagnostic = {
      code: e.code,
      severity: DIAGNOSTIC_CODES[code]?.severity ?? "error",
      message: e.message,
      span: spanForIrPath(result, e.path) ?? ctx.spanOf(0, 0),
      irPath: e.path,
    };
    const hint = VALIDATION_HINTS[e.code];
    if (hint) d.hint = hint;
    ctx.diagnostics.push(d);
  }

  ctx.diagnostics.sort((a, b) => compareSpans(a.span, b.span));
  result.diagnostics = ctx.diagnostics;
  result.ok = !ctx.diagnostics.some((d) => d.severity === "error");
  result.ir = result.ok ? doc : null;
  return { sf, result, doc, statements, hasSyntaxErrors: false };
}

const VALIDATION_HINTS: Record<string, string> = {
  NO_PARTS: 'add a part: part("part"); followed by its features',
  DUPLICATE_NAME: "names must be unique: rename one of them",
  INVALID_NAME: "feature names must match [A-Za-z_][A-Za-z0-9_]* (ASCII letters, digits, underscore)",
  RESERVED_NAME: "pick a name that is not a reserved word or CadScript builtin",
  INVALID_DISTANCE: 'distance is a positive length in mm; to go the other way use direction: "reverse"',
  INVALID_ANGLE: "angle is in degrees: 0 < angle ≤ 360",
  INVALID_AXIS: "the axis direction must be a non-zero vector, e.g. [0, 1]",
  INVALID_PLANE: "normal and xDir must be non-zero and perpendicular (dot product 0)",
  EMPTY_SKETCH: "add at least one curve: line(…), arc({ … }) or circle({ … })",
  NON_FINITE: "coordinates must be finite numbers",
  DEGENERATE_CURVE: "curves need a length/radius greater than 1e-6 mm",
  INCONSISTENT_ARC: "start and end must be the same distance from center (within 1e-6 mm)",
  DUPLICATE_ID: "curve ids (object keys) must be unique within a sketch",
};

function emptyResult(diagnostics: Diagnostic[]): CompileResult {
  return {
    ok: !diagnostics.some((d) => d.severity === "error"),
    ir: null,
    diagnostics,
    spans: {},
    curveSpans: {},
    partSpans: {},
    pathSpans: {},
    comments: {},
  };
}

function lowerImport(ctx: Ctx, stmt: ts.ImportDeclaration, seenBody: boolean): void {
  const usage = `import { ${BUILTINS.join(", ")} } from "${STD_MODULE}";`;
  if (seenBody) ctx.report("CS_BAD_IMPORT", stmt, "imports must come before every other statement", "move the import to the top of the file");
  const spec = stmt.moduleSpecifier;
  if (!ts.isStringLiteral(spec) || spec.text !== STD_MODULE) {
    ctx.report("CS_BAD_IMPORT", spec, `CadScript files can only import from "${STD_MODULE}"`, usage);
    return;
  }
  const clause = stmt.importClause;
  if (!clause) {
    ctx.report("CS_BAD_IMPORT", stmt, "side-effect imports are not supported", usage);
    return;
  }
  if (clause.isTypeOnly) ctx.report("CS_BAD_IMPORT", clause, "type-only imports are not needed", usage);
  if (clause.name) ctx.report("CS_BAD_IMPORT", clause.name, `"${STD_MODULE}" has no default export`, usage);
  const bindings = clause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    ctx.report("CS_BAD_IMPORT", bindings, "namespace imports are not supported", `import the builtins by name: ${usage}`);
    return;
  }
  for (const el of bindings.elements) {
    const exported = (el.propertyName ?? el.name).text;
    if (el.isTypeOnly) {
      ctx.report("CS_BAD_IMPORT", el, "type imports are not needed in CadScript", "remove it");
      continue;
    }
    if (el.propertyName && el.propertyName.text !== el.name.text) {
      ctx.report("CS_BAD_IMPORT", el, "renaming imports is not supported", `import \`${exported}\` under its own name`);
      continue;
    }
    if (!isBuiltin(exported)) {
      const near = closest(exported, BUILTINS);
      ctx.report(
        "CS_UNKNOWN_BUILTIN",
        el,
        `"${STD_MODULE}" has no export \`${exported}\` in CadScript v0`,
        FUTURE_BUILTINS[exported] ?? (near ? `did you mean \`${near}\`?` : `available: ${BUILTINS.join(", ")}`),
      );
      continue;
    }
    ctx.imported.add(exported);
  }
}

function lowerDoc(ctx: Ctx, call: ts.CallExpression): { name?: string; description?: string } | undefined {
  const args = callArgs(ctx, call, "doc", 1, 1, 'doc({ name: "my_part", description: "…" })');
  if (!args) return undefined;
  const props = readObject(ctx, args[0]!, "doc()", [], ["name", "description"], {
    units: "units are implicit in CadScript v0: millimetres and degrees",
    title: "use `name`",
  });
  if (!props) return undefined;
  const out: { name?: string; description?: string } = {};
  const n = props.get("name");
  const d = props.get("description");
  const name = n ? readString(ctx, n.value, "doc name") : undefined;
  const description = d ? readString(ctx, d.value, "doc description") : undefined;
  if (name !== undefined) out.name = name;
  if (description !== undefined) out.description = description;
  return out;
}

function lowerFeatureStatement(ctx: Ctx, stmt: ts.VariableStatement, ensurePart: (node: ts.Node) => void): LFeature | undefined {
  const list = stmt.declarationList;
  if (stmt.modifiers?.length) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", stmt.modifiers[0]!, `\`${ctx.text(stmt.modifiers[0]!)}\` is not supported on features`, "remove it: `const name = …`");
  }
  const scope = list.flags & ts.NodeFlags.BlockScoped;
  if (scope === ts.NodeFlags.Using || scope === ts.NodeFlags.AwaitUsing) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", list, "`using` declarations are not supported", "declare features with `const`");
    return undefined;
  }
  if (list.declarations.length !== 1) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", list, "declare one feature per `const` statement", "split it into separate `const` statements");
    return undefined;
  }
  const decl = list.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", decl.name, "destructuring is not supported", "write `const name = feature(…)`");
    return undefined;
  }
  const nameNode = decl.name;
  const name = nameNode.text;
  if (decl.type) ctx.report("CS_STATEMENT_UNSUPPORTED", decl.type, "type annotations are not supported on features", "remove the `: Type` annotation");
  const init = decl.initializer;
  if (!init) {
    // `const x;` parses without error: TypeScript reports it (TS1155) only in its checker, so the
    // compiler must, or the statement would silently vanish. (`declare const x: T;` is legal
    // TypeScript and already reported for its `declare` modifier.)
    ctx.names.set(name, { type: "invalid", partIndex: ctx.currentPart, node: nameNode });
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return undefined;
    return ctx.report(
      "CS_SYNTAX",
      decl,
      `\`const ${name}\` has no value: 'const' declarations must be initialized`,
      `a feature const needs a value, e.g. const ${name} = sketch(XY, { … }), extrude(…) or revolve(…); or delete the declaration`,
    );
  }
  const callee = calleeOf(init);
  if (!callee) {
    const v = fold(init);
    const entry: NameEntry = { type: "invalid", partIndex: ctx.currentPart, node: nameNode };
    if (v !== undefined) entry.value = v;
    const literal =
      v !== undefined ||
      ts.isStringLiteral(init) ||
      ts.isArrayLiteralExpression(init) ||
      ts.isObjectLiteralExpression(init) ||
      init.kind === ts.SyntaxKind.TrueKeyword ||
      init.kind === ts.SyntaxKind.FalseKeyword;
    if (literal) {
      const numeric = v !== undefined && Number.isFinite(v);
      const shown = numeric ? formatNumber(v) : ctx.text(init);
      // Parameters are numbers and booleans (SPEC-v1 §2): other literals are only inlined.
      const asParam = numeric || init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword;
      ctx.report(
        "CS_EXPR_UNSUPPORTED",
        init,
        `\`const ${name}\` must be a feature: sketch(…), extrude(…) or revolve(…)`,
        asParam
          ? `inline ${shown} where \`${name}\` is used; or make it a parameter (const ${name} = param(${shown})) and ${COMPILE_AS_V1}`
          : `inline ${shown} where \`${name}\` is used`,
      );
    } else {
      unsupported(ctx, init, "a feature: sketch(…), extrude(…) or revolve(…)", `\`const ${name}\``);
    }
    ctx.names.set(name, entry);
    return undefined;
  }
  const calleeNode = (init as ts.CallExpression).expression;
  if (!isBuiltin(callee) || !(FEATURE_BUILTINS as readonly string[]).includes(callee)) {
    ctx.names.set(name, { type: "invalid", partIndex: ctx.currentPart, node: nameNode });
    if (!isBuiltin(callee)) {
      const near = closest(callee, FEATURE_BUILTINS);
      ctx.report(
        "CS_UNKNOWN_BUILTIN",
        calleeNode,
        `${callee}() is not a CadScript v0 builtin`,
        FUTURE_BUILTINS[callee] ?? (near ? `did you mean ${near}()?` : "feature builtins are sketch(), extrude() and revolve()"),
      );
    } else {
      const hint = (CURVE_BUILTINS as readonly string[]).includes(callee)
        ? `curves go inside a sketch: const s = sketch(XY, { ${name}: ${callee}(…) })`
        : callee === "frame"
          ? "pass frame({ … }) directly as the first argument of sketch()"
          : `call it as a statement: ${callee}(…);`;
      ctx.report("CS_UNKNOWN_BUILTIN", calleeNode, `${callee}() does not create a feature`, hint);
    }
    return undefined;
  }
  const type = callee as FeatureBuiltin;
  ctx.broken = false;
  if (isBuiltin(name) || RESERVED_WORDS.has(name)) {
    ctx.report("CS_RESERVED_NAME", nameNode, `\`${name}\` is reserved and cannot name a feature`, `pick another name, e.g. \`${name}_1\``, false);
  }
  const prev = ctx.names.get(name);
  let duplicate = false;
  if (prev) {
    const line = ctx.span(prev.node).start.line;
    ctx.report("CS_DUPLICATE_NAME", nameNode, `\`${name}\` is already declared on line ${line}`, "feature names are unique across the whole file (all parts); rename one of them");
    duplicate = true;
  }
  ctx.use(type, calleeNode);
  ensurePart(stmt);
  const lf: LFeature = {
    name,
    type,
    stmt,
    nameNode,
    broken: false,
    body: { type: "sketch", plane: "XY", curves: [], suppressed: false },
    paths: new Map(),
    curves: [],
    comment: attachedComments(ctx.sf, stmt),
  };
  const call = init as ts.CallExpression;
  lf.body = type === "sketch" ? lowerSketch(ctx, call, lf) : type === "extrude" ? lowerExtrude(ctx, call, lf) : lowerRevolve(ctx, call, lf);
  lf.broken = ctx.broken || duplicate;
  if (!duplicate) {
    const entry: NameEntry = { type, partIndex: ctx.currentPart, node: nameNode };
    if (lf.body.type !== "sketch" && lf.body.sketch) entry.sketch = lf.body.sketch;
    ctx.names.set(name, entry);
  }
  return lf;
}

/** Build the IR feature in canonical key order, keeping explicit default fields that `base` had. */
function assembleFeature(lf: LFeature, id: string, base: Feature | undefined): Feature {
  const b = lf.body;
  const keep = (key: string, dflt: unknown): boolean => hasOwn(base, key) && (base as unknown as Record<string, unknown>)[key] === dflt;
  switch (b.type) {
    case "sketch": {
      const f: SketchFeature = { type: "sketch", id, name: lf.name } as SketchFeature;
      if (b.suppressed || keep("suppressed", false)) f.suppressed = b.suppressed;
      f.plane = b.plane;
      f.curves = b.curves;
      return f;
    }
    case "extrude": {
      const f = { type: "extrude", id, name: lf.name } as ExtrudeFeature;
      if (b.suppressed || keep("suppressed", false)) f.suppressed = b.suppressed;
      f.sketch = b.sketch;
      if (keep("regions", "all")) f.regions = "all";
      f.distance = b.distance;
      if (b.direction !== undefined && b.direction !== "normal") f.direction = b.direction;
      else if (keep("direction", "normal")) f.direction = "normal";
      if (keep("op", "new_body")) f.op = "new_body";
      return f;
    }
    case "revolve": {
      const f = { type: "revolve", id, name: lf.name } as RevolveFeature;
      if (b.suppressed || keep("suppressed", false)) f.suppressed = b.suppressed;
      f.sketch = b.sketch;
      if (keep("regions", "all")) f.regions = "all";
      f.axis = b.axis;
      f.angle = b.angle;
      if (b.direction !== undefined && b.direction !== "normal") f.direction = b.direction;
      else if (keep("direction", "normal")) f.direction = "normal";
      if (keep("op", "new_body")) f.op = "new_body";
      return f;
    }
  }
}
