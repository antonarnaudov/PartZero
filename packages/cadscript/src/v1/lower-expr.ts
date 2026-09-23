/**
 * Lowering TypeScript expressions to IR v1 expressions (SPEC-v1 §2.9): the AST of `expr.ts`,
 * stored in the IR as its canonical text (§2.4). A bare, optionally negated number literal is
 * stored as a JSON number; `true`/`false` as JSON booleans.
 *
 * Only the arithmetic, logic and math of §2.3 are accepted; everything else is
 * `CS_EXPR_UNSUPPORTED` with a hint. Names are not resolved here beyond the TypeScript view
 * (declared-before-use): unknown names, feature names, other parts' parameters, units and types
 * are checked by IR validation, whose problems point back at these nodes.
 */
import ts from "typescript";
import { calleeName, numericValue, shownText, type Ctx, type Sink } from "./context.js";
import { printExpr, type BinOp, type Expr } from "./expr.js";
import { AXIS_CONSTANTS, MATH_BUILTINS, PLANE_CONSTANTS, UNIT_BUILTINS } from "./syntax.js";

const IR_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const BIN_OPS: ReadonlyMap<ts.SyntaxKind, BinOp> = new Map<ts.SyntaxKind, BinOp>([
  [ts.SyntaxKind.PlusToken, "+"],
  [ts.SyntaxKind.MinusToken, "-"],
  [ts.SyntaxKind.AsteriskToken, "*"],
  [ts.SyntaxKind.SlashToken, "/"],
  [ts.SyntaxKind.PercentToken, "%"],
  [ts.SyntaxKind.AsteriskAsteriskToken, "^"],
  [ts.SyntaxKind.LessThanToken, "<"],
  [ts.SyntaxKind.LessThanEqualsToken, "<="],
  [ts.SyntaxKind.GreaterThanToken, ">"],
  [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, "=="],
  [ts.SyntaxKind.EqualsEqualsToken, "=="],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, "!="],
  [ts.SyntaxKind.ExclamationEqualsToken, "!="],
  [ts.SyntaxKind.AmpersandAmpersandToken, "&&"],
  [ts.SyntaxKind.BarBarToken, "||"],
]);

const BITWISE: ReadonlyMap<ts.SyntaxKind, string> = new Map([
  [ts.SyntaxKind.CaretToken, "^"],
  [ts.SyntaxKind.AmpersandToken, "&"],
  [ts.SyntaxKind.BarToken, "|"],
  [ts.SyntaxKind.LessThanLessThanToken, "<<"],
  [ts.SyntaxKind.GreaterThanGreaterThanToken, ">>"],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken, ">>>"],
]);

/** What a numeric field takes (for messages about values of the wrong form). */
export const TAKES_NUMBER = "a number or an expression";
/** What a boolean field (`suppressed`, `flip`, …) takes. */
export const TAKES_BOOLEAN = "true, false or a condition";

/**
 * Lower an expression. Returns undefined after reporting (the enclosing statement is broken).
 * `takes` describes the field's values for messages. Recursion depth is bounded by the parse
 * limits of `complexity.ts`.
 */
export function lowerExpr(ctx: Ctx, e: ts.Expression, what: string, takes: string = TAKES_NUMBER): Expr | undefined {
  const at = <T extends Expr>(x: T): T => ctx.mark(x, e);
  if (ts.isNumericLiteral(e)) {
    const v = numericValue(e);
    if (!Number.isFinite(v)) return ctx.report("NON_FINITE", e, `${ctx.text(e)} is not a finite number`, "numbers must be finite (|x| < 1.8e308)");
    return at({ k: "num", v });
  }
  if (e.kind === ts.SyntaxKind.TrueKeyword) return at({ k: "bool", v: true });
  if (e.kind === ts.SyntaxKind.FalseKeyword) return at({ k: "bool", v: false });
  if (ts.isParenthesizedExpression(e)) {
    const inner = lowerExpr(ctx, e.expression, what, takes);
    return inner;
  }
  if (ts.isPrefixUnaryExpression(e)) {
    switch (e.operator) {
      case ts.SyntaxKind.MinusToken:
      case ts.SyntaxKind.ExclamationToken: {
        const x = lowerExpr(ctx, e.operand, what, takes);
        return x ? at({ k: "un", op: e.operator === ts.SyntaxKind.MinusToken ? "-" : "!", e: x }) : undefined;
      }
      case ts.SyntaxKind.PlusToken:
        return ctx.report("CS_EXPR_UNSUPPORTED", e, `unary \`+\` is not supported in ${what}`, "remove the `+`");
      case ts.SyntaxKind.TildeToken:
        return ctx.report("CS_EXPR_UNSUPPORTED", e, `bitwise \`~\` is not supported in ${what}`, "CadScript numbers are reals: use arithmetic");
      default:
        return ctx.report("CS_EXPR_UNSUPPORTED", e, `\`++\`/\`--\` are not supported in ${what}`, "CadScript is declarative: write the value (use param() for named values)");
    }
  }
  if (ts.isPostfixUnaryExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `\`++\`/\`--\` are not supported in ${what}`, "CadScript is declarative: write the value");
  }
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    const op = BIN_OPS.get(k);
    if (op) {
      const l = lowerExpr(ctx, e.left, what, takes);
      const r = lowerExpr(ctx, e.right, what, takes);
      return l && r ? at({ k: "bin", op, l, r }) : undefined;
    }
    const bit = BITWISE.get(k);
    if (bit === "^") return ctx.report("CS_EXPR_UNSUPPORTED", e.operatorToken, "`^` is bitwise XOR in TypeScript", "use ** for powers: width ** 2");
    if (bit) return ctx.report("CS_EXPR_UNSUPPORTED", e.operatorToken, `bitwise \`${bit}\` is not supported in ${what}`, "use && and || for conditions, arithmetic for numbers");
    if (k === ts.SyntaxKind.QuestionQuestionToken) return ctx.report("CS_EXPR_UNSUPPORTED", e.operatorToken, "`??` is not supported", "CadScript values are never null: remove it");
    if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
      return ctx.report("CS_EXPR_UNSUPPORTED", e, "assignments are not supported", "CadScript is declarative: use param() for named values");
    }
    return ctx.report("CS_EXPR_UNSUPPORTED", e.operatorToken, `\`${ts.tokenToString(k) ?? "operator"}\` is not supported in ${what}`, undefined);
  }
  if (ts.isConditionalExpression(e)) {
    const c = lowerExpr(ctx, e.condition, what, takes);
    const t = lowerExpr(ctx, e.whenTrue, what, takes);
    const f = lowerExpr(ctx, e.whenFalse, what, takes);
    return c && t && f ? at({ k: "cond", c, t, f }) : undefined;
  }
  if (ts.isIdentifier(e)) return lowerName(ctx, e, what);
  if (ts.isCallExpression(e)) return lowerCall(ctx, e, what);
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const obj = ts.isPropertyAccessExpression(e) ? e.expression : e.expression;
    if (ts.isIdentifier(obj) && obj.text === "Math") {
      const member = ts.isPropertyAccessExpression(e) ? e.name.text : "";
      return ctx.report(
        "CS_EXPR_UNSUPPORTED",
        e,
        `Math.${member} is not supported`,
        member === "PI" ? "use PI from @aicad/std" : "use sin() (and friends) from @aicad/std, which take degrees",
      );
    }
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `member access is not supported in ${what}`, "expressions use param() consts and literals");
  }
  if (ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTaggedTemplateExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `template strings are not supported in ${what}`, "write a number or an expression");
  }
  if (ts.isStringLiteral(e)) {
    const t = e.text.trim();
    const bare = (t !== "" && Number.isFinite(Number(t)) && /^[-+0-9.eE]+$/.test(t)) || (takes !== TAKES_NUMBER && (t === "true" || t === "false"));
    return ctx.report("CS_BAD_ARGUMENT", e, `${what} takes ${takes}, not a string`, bare ? `remove the quotes: ${t}` : `write ${takes} (over parameters)`);
  }
  if (ts.isTypeOfExpression(e)) return ctx.report("CS_EXPR_UNSUPPORTED", e, "`typeof` is not supported", undefined);
  if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, "type assertions are not supported", "remove the assertion");
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return ctx.report("CS_EXPR_UNSUPPORTED", e, "functions are not supported", "CadScript is declarative");
  if (ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e)) {
    return ctx.report("CS_BAD_ARGUMENT", e, `${what} takes ${takes}, not ${ts.isArrayLiteralExpression(e) ? "an array" : "an object"}`, undefined);
  }
  if (e.kind === ts.SyntaxKind.NullKeyword) return ctx.report("CS_BAD_ARGUMENT", e, `${what} takes ${takes}, not null`, "omit an optional value instead of null");
  return ctx.report("CS_EXPR_UNSUPPORTED", e, `this expression is not supported in ${what}`, undefined);
}

function lowerName(ctx: Ctx, e: ts.Identifier, what: string): Expr | undefined {
  const name = e.text;
  if (name === "PI") {
    ctx.use("PI", e);
    return ctx.mark({ k: "name", name: "PI" }, e);
  }
  const entry = ctx.names.get(name);
  if (!entry) {
    if (ctx.declared.has(name)) {
      return ctx.report("CS_USED_BEFORE_DECLARED", e, `\`${name}\` is used before it is declared`, `move \`const ${name} = …\` above this statement: statements run in file order`);
    }
    if (name === "undefined" || name === "NaN" || name === "Infinity") return ctx.report("CS_EXPR_UNSUPPORTED", e, `\`${name}\` is not a CadScript value`, "write a finite number");
    if ([...PLANE_CONSTANTS, ...AXIS_CONSTANTS].includes(name)) {
      return ctx.report("CS_BAD_ARGUMENT", e, `\`${name}\` is not a number`, `${what} expects a number or an expression over parameters`);
    }
  }
  if (entry?.kind === "invalid") {
    ctx.broken = true; // reported at its declaration
    return undefined;
  }
  if (entry?.kind === "query") {
    return ctx.report("CS_BAD_ARGUMENT", e, `\`${name}\` is a query, not a value`, "expressions use param() consts and literals");
  }
  if (!IR_IDENT.test(name)) {
    return ctx.report("CS_BAD_ARGUMENT", e, `${shownText(name)} is not a valid parameter name`, "names match [A-Za-z_][A-Za-z0-9_]*");
  }
  // Parameters, and (for IR validation to report with EXPR_UNKNOWN_NAME / EXPR_SCOPE) features
  // and unknown names.
  return ctx.mark({ k: "name", name }, e);
}

function lowerCall(ctx: Ctx, e: ts.CallExpression, what: string): Expr | undefined {
  if (ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === "Math") {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `Math.${e.expression.name.text}() is not supported`, "use sin() from @aicad/std, which takes degrees (and min, max, sqrt, … likewise)");
  }
  const callee = calleeName(e);
  if (callee && Object.prototype.hasOwnProperty.call(UNIT_BUILTINS, callee)) {
    ctx.use(callee, e.expression);
    const unit = UNIT_BUILTINS[callee]!;
    const arg = e.arguments[0];
    if (e.arguments.length !== 1 || !arg) return ctx.report("CS_BAD_ARGUMENT", e, `${callee}() takes one number literal`, `write ${callee}(12)`);
    if (ts.isNumericLiteral(arg)) return ctx.mark({ k: "num", v: numericValue(arg), unit }, e);
    if (ts.isPrefixUnaryExpression(arg) && arg.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(arg.operand)) {
      const inner = ctx.mark({ k: "num", v: numericValue(arg.operand), unit } as Expr, e);
      return ctx.mark({ k: "un", op: "-", e: inner }, e);
    }
    return ctx.report("CS_BAD_ARGUMENT", arg, `${callee}() takes a number literal`, `units apply to literals only: write ${callee}(12), or multiply a parameter: ${callee === "inch" ? "width * inch(1)" : `width * ${callee}(1)`}`);
  }
  if (callee && MATH_BUILTINS.includes(callee)) {
    ctx.use(callee, e.expression);
    if (e.questionDotToken) return ctx.report("CS_EXPR_UNSUPPORTED", e, "optional calls are not supported", undefined);
    const args: Expr[] = [];
    let ok = true;
    for (const a of e.arguments) {
      if (ts.isSpreadElement(a)) {
        ctx.report("CS_EXPR_UNSUPPORTED", a, "spreads are not supported", "list every argument");
        ok = false;
        continue;
      }
      const x = lowerExpr(ctx, a, what);
      if (x) args.push(x);
      else ok = false;
    }
    return ok ? ctx.mark({ k: "call", fn: callee, args }, e) : undefined;
  }
  if (callee === "param") {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, "param() declares a parameter; it cannot be nested in an expression", "declare it as its own const: const x = param(…), then use x");
  }
  return ctx.report(
    "CS_EXPR_UNSUPPORTED",
    e,
    `${callee ? `${callee}()` : "this call"} is not an expression function`,
    "expressions call only min, max, abs, sqrt, floor, ceil, round, clamp, hypot, sin, cos, tan, asin, acos, atan, atan2 (degrees) and mm/cm/inch/deg",
  );
}

/** A lowered Scalar: a JSON number, or an expression (canonical text + AST). */
export type LoweredScalar = { kind: "num"; value: number } | { kind: "expr"; text: string; ast: Expr };

/**
 * The IR form of an expression AST at a Scalar field (§2.9: a bare, optionally negated literal is
 * stored as a number, never folded further, so `-0` is the number -0, as JSON `-0.0`).
 */
export function scalarOf(ast: Expr): LoweredScalar {
  if (ast.k === "num" && ast.unit === undefined) return { kind: "num", value: ast.v };
  if (ast.k === "un" && ast.op === "-" && ast.e.k === "num" && ast.e.unit === undefined) return { kind: "num", value: -ast.e.v };
  return { kind: "expr", text: printExpr(ast), ast };
}

/** Lower a Scalar argument and record its source node for `path`. */
export function lowerScalar(ctx: Ctx, e: ts.Expression, what: string, path: string, sink: Sink): number | string | undefined {
  sink.paths.set(path, e);
  const ast = lowerExpr(ctx, e, what);
  if (!ast) return undefined;
  const s = scalarOf(ast);
  if (s.kind === "num") return s.value;
  sink.exprs.set(path, s.ast);
  return s.text;
}

/** Lower a boolean Scalar (`boolean | string`). */
export function lowerBoolScalar(ctx: Ctx, e: ts.Expression, what: string, path: string, sink: Sink): boolean | string | undefined {
  sink.paths.set(path, e);
  const ast = lowerExpr(ctx, e, what, TAKES_BOOLEAN);
  if (!ast) return undefined;
  if (ast.k === "bool") return ast.v;
  sink.exprs.set(path, ast);
  return printExpr(ast);
}
