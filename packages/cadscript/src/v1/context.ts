/** The lowering context of the v1 compiler: diagnostics, names, source maps, generic readers. */
import ts from "typescript";
import type { Diagnostic, Span } from "../diagnostics.js";
import { closest } from "../syntax.js";
import { CS_CODES_V1, DIAGNOSTIC_CODES_V1, type CsCode } from "./diagnostics.js";
import type { Expr } from "./expr.js";
import { STD_MODULE_V1 } from "./std-module.js";
import { BUILTINS_V1, isBuiltinV1 } from "./syntax.js";

/** A text edit of a fix (`Diagnostic.fix`). */
export interface FixEdit {
  span: Span;
  newText: string;
}

/** A diagnostic with an optional machine-applicable fix (v1 extension of {@link Diagnostic}). */
export interface DiagnosticV1 extends Diagnostic {
  fix?: { title: string; edits: FixEdit[] };
}

/** Where lowering records IR paths (relative to a feature or parameter) → source nodes and ASTs. */
export interface Sink {
  paths: Map<string, ts.Node>;
  exprs: Map<string, Expr>;
  /** Curve-reference string literals: (consumed sketch const name, referenced id, node). */
  curveRefs: { sketch: string; id: string; node: ts.StringLiteral }[];
}

export function newSink(): Sink {
  return { paths: new Map(), exprs: new Map(), curveRefs: [] };
}

export type ParamUnitName = "mm" | "deg" | "ratio" | "count" | "bool";

/** What a const name denotes. */
export type NameEntry =
  | { kind: "param"; node: ts.Node; unit: ParamUnitName; part: number | undefined; index: number }
  | {
      kind: "feature";
      node: ts.Node;
      /** The IR feature type. */
      type: string;
      builtin: string;
      part: number;
      id: string;
      /** extrude/revolve: the const name of the sketch it consumed. */
      sketch?: string;
      /** tag: the kind of its target. */
      tagKind?: string;
    }
  | {
      /**
       * `const top = slab.faces().planes().max("+Z").one()` (SPEC-v1 §5.11): a query alias. It
       * adds nothing to the IR; each use lowers `init` in place, resolving names as they were
       * at the alias (`names`).
       */
      kind: "query";
      node: ts.Node;
      init: ts.Expression;
      names: ReadonlyMap<string, NameEntry>;
      /** Set when a statement expands it (an unused alias is checked at its declaration). */
      used: boolean;
    }
  | { kind: "invalid"; node: ts.Node };

export class Ctx {
  readonly diagnostics: DiagnosticV1[] = [];
  readonly imported = new Set<string>();
  readonly notImportedReported = new Set<string>();
  /** Consts declared so far (in statement order); an alias's own view while it is lowered. */
  names = new Map<string, NameEntry>();
  /** Query aliases expanded in the current statement (bounded: {@link MAX_ALIAS_EXPANSIONS}). */
  aliasExpansions = 0;
  /** Every const name declared anywhere in the file (for "used before declared" hints). */
  readonly declared = new Map<string, ts.Node>();
  /** Set when an error makes the current statement's IR unreliable. */
  broken = false;
  currentPart = -1;
  /** AST node → source node (for sub-expression spans). */
  readonly exprNodes = new WeakMap<Expr, ts.Node>();

  constructor(readonly sf: ts.SourceFile) {}

  span(node: ts.Node): Span {
    return this.spanOf(node.getStart(this.sf), node.getEnd());
  }

  spanOf(start: number, end: number): Span {
    const s = this.sf.getLineAndCharacterOfPosition(start);
    const e = this.sf.getLineAndCharacterOfPosition(end);
    return { start: { line: s.line + 1, col: s.character + 1 }, end: { line: e.line + 1, col: e.character + 1 } };
  }

  report(code: CsCode | string, node: ts.Node, message: string, hint?: string, breaks = true, severity?: Diagnostic["severity"]): undefined {
    const info = DIAGNOSTIC_CODES_V1[code] ?? CS_CODES_V1.CS_BAD_ARGUMENT;
    const d: DiagnosticV1 = { code, severity: severity ?? info.severity, message, span: this.span(node) };
    const h = hint ?? info.hint;
    if (h) d.hint = h;
    this.diagnostics.push(d);
    if (breaks && d.severity === "error") this.broken = true;
    return undefined;
  }

  text(node: ts.Node): string {
    return node.getText(this.sf);
  }

  /** Report `CS_NOT_IMPORTED` once per builtin. */
  use(name: string, node: ts.Node): void {
    if (this.imported.has(name) || this.notImportedReported.has(name)) return;
    this.notImportedReported.add(name);
    const names = [...this.imported, name].sort((a, b) => BUILTINS_V1.indexOf(a) - BUILTINS_V1.indexOf(b));
    this.report("CS_NOT_IMPORTED", node, `\`${name}\` is used but not imported`, `add it to the import: import { ${names.join(", ")} } from "${STD_MODULE_V1}";`, false);
  }

  /** Map an AST node to its source node (for sub-expression spans). */
  mark<T extends Expr>(e: T, node: ts.Node): T {
    if (!this.exprNodes.has(e)) this.exprNodes.set(e, node);
    return e;
  }

  /** Run `f` with the names an alias saw at its declaration. */
  withNames<T>(names: ReadonlyMap<string, NameEntry>, f: () => T): T {
    const saved = this.names;
    this.names = names as Map<string, NameEntry>;
    try {
      return f();
    } finally {
      this.names = saved;
    }
  }
}

/** Most query-alias expansions in one statement (aliases of aliases could otherwise grow exponentially). */
export const MAX_ALIAS_EXPANSIONS = 256;

const SHOWN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A string from the source as a message may show it ([W0-12], SPEC-v1 §11: diagnostics reach
 * LLM prompts, so rejected strings are not echoed): an id verbatim (quoted with `quote`),
 * anything else by its length only.
 */
export function shownText(s: string, quote: "`" | '"' = "`"): string {
  if (SHOWN_ID.test(s) && s.length <= 64) return quote === "`" ? `\`${s}\`` : JSON.stringify(s);
  return `<a string of ${s.length} character${s.length === 1 ? "" : "s"}>`;
}

// ─── Generic readers ─────────────────────────────────────────────────────────────────────────

export type Props = Map<string, { key: ts.Node; value: ts.Expression; prop: ts.Node }>;

export function calleeName(e: ts.Expression): string | undefined {
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) ? e.expression.text : undefined;
}

export function numericValue(lit: ts.NumericLiteral): number {
  return Number(lit.text.replace(/_/g, ""));
}

/** A description of an expression's form for messages ("a string", "an array of 2", …). */
export function describe(ctx: Ctx, e: ts.Expression): string {
  if (ts.isStringLiteral(e)) return "a string";
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return "a boolean";
  if (e.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (ts.isNumericLiteral(e)) return "a number";
  if (ts.isArrayLiteralExpression(e)) return `an array of ${e.elements.length}`;
  if (ts.isObjectLiteralExpression(e)) return "an object";
  if (ts.isIdentifier(e)) {
    const entry = ctx.names.get(e.text);
    if (entry?.kind === "param") return `the parameter \`${e.text}\``;
    if (entry?.kind === "feature") return `the ${entry.builtin} \`${e.text}\``;
    if (entry?.kind === "query") return `the query \`${e.text}\``;
    return shownText(e.text);
  }
  if (ts.isCallExpression(e)) {
    const c = calleeName(e);
    return c ? `${c}(…)` : "a call";
  }
  return "an expression";
}

/** Report a value of the wrong form where `expected` was wanted. */
export function mismatch(ctx: Ctx, e: ts.Node, expected: string, what: string, hint?: string): undefined {
  const found = ts.isExpression(e) ? describe(ctx, e) : "this";
  return ctx.report("CS_BAD_ARGUMENT", e, `${what} must be ${expected}, got ${found}`, hint ?? `write ${expected}`);
}

export function propertyKey(ctx: Ctx, name: ts.PropertyName, what: string): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    ctx.report("CS_EXPR_UNSUPPORTED", name, `computed property names are not supported in ${what}`, "write the key literally");
    return undefined;
  }
  ctx.report("CS_BAD_ARGUMENT", name, `property names in ${what} must be identifiers or "strings"`, "write the key as an identifier or a quoted string");
  return undefined;
}

/**
 * Read an object literal with a fixed set of keys. Unknown, duplicate and missing keys are
 * reported; the returned map holds every well-formed allowed property (in source order).
 */
export function readObject(
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
      ctx.report("CS_EXPR_UNSUPPORTED", p, `spreads are not supported in ${what}`, "list every property explicitly");
      continue;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      if (allowed.includes(p.name.text)) {
        ctx.report("CS_EXPR_UNSUPPORTED", p, `shorthand property \`${p.name.text}\` is not supported`, `write \`${p.name.text}: ${p.name.text}\``);
      } else ctx.report("CS_BAD_ARGUMENT", p, `unknown property ${shownText(p.name.text)} in ${what}`, `allowed: ${allowed.join(", ")}`);
      continue;
    }
    if (!ts.isPropertyAssignment(p)) {
      ctx.report("CS_EXPR_UNSUPPORTED", p, `methods and accessors are not supported in ${what}`, "write `key: value`");
      continue;
    }
    const key = propertyKey(ctx, p.name, what);
    if (key === undefined) continue;
    if (!allowed.includes(key)) {
      const near = closest(key, allowed);
      // (`keyHints` is a plain object: `constructor`, `toString`, … are not hints.)
      const hint = Object.prototype.hasOwnProperty.call(keyHints, key) ? keyHints[key] : undefined;
      ctx.report("CS_BAD_ARGUMENT", p.name, `unknown property ${shownText(key)} in ${what}`, hint ?? (near ? `did you mean \`${near}\`?` : `allowed: ${allowed.join(", ")}`));
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
    // Callers rely on every required key being present: report and give up on this object.
    return ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `${what} is missing ${missing.map((m) => `\`${m}\``).join(", ")}`,
      `required: ${required.join(", ")}${optional.length ? `; optional: ${optional.join(", ")}` : ""}`,
    );
  }
  return props;
}

/** Check a call's argument list; returns the arguments when the count is right. */
export function callArgs(ctx: Ctx, call: ts.CallExpression, name: string, min: number, max: number, usage: string): readonly ts.Expression[] | undefined {
  if (call.questionDotToken) ctx.report("CS_EXPR_UNSUPPORTED", call, "optional calls (`?.()`) are not supported", `write ${usage}`);
  if (call.typeArguments) ctx.report("CS_BAD_ARGUMENT", call, `type arguments are not supported on ${name}()`, `write ${usage}`);
  const spread = call.arguments.find(ts.isSpreadElement);
  if (spread) return ctx.report("CS_EXPR_UNSUPPORTED", spread, `spreads are not supported in ${name}()`, `write ${usage}`);
  const n = call.arguments.length;
  if (n < min || n > max) {
    const count = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min}–${max}`;
    return ctx.report("CS_BAD_ARGUMENT", call, `${name}() takes ${count} argument${max === 1 ? "" : "s"}, got ${n}`, `usage: ${usage}`);
  }
  return call.arguments;
}

export function readString(ctx: Ctx, e: ts.Expression, what: string, allowed?: readonly string[]): string | undefined {
  if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) {
    if (ts.isIdentifier(e) && allowed?.includes(e.text)) return ctx.report("CS_BAD_ARGUMENT", e, `${what} is a string`, `write "${e.text}"`);
    return mismatch(ctx, e, allowed ? allowed.map((a) => JSON.stringify(a)).join(" | ") : "a string", what);
  }
  if (ts.isNoSubstitutionTemplateLiteral(e)) {
    return ctx.report("CS_EXPR_UNSUPPORTED", e, `template strings are not supported in ${what}`, 'use a plain "double-quoted" string');
  }
  if (allowed && !allowed.includes(e.text)) {
    const near = closest(e.text, allowed);
    return ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `${what} must be ${allowed.map((a) => JSON.stringify(a)).join(", ")}, got ${shownText(e.text, '"')}`,
      near ? `did you mean "${near}"?` : `one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}`,
    );
  }
  return e.text;
}

export function readLiteralBool(ctx: Ctx, e: ts.Expression, what: string): boolean | undefined {
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  return mismatch(ctx, e, "`true` or `false`", what);
}

/** A non-negative integer literal (instance indices, skip entries, `exactly(n)`, `v`). */
export function readLiteralInt(ctx: Ctx, e: ts.Expression, what: string): number | undefined {
  if (ts.isNumericLiteral(e)) {
    const v = numericValue(e);
    if (Number.isInteger(v) && v >= 0 && v <= 4294967295) return v;
  }
  return mismatch(ctx, e, "a whole-number literal", what);
}

/** A string literal array (`regions`, `assumptions`, …). */
export function readStringArray(ctx: Ctx, e: ts.Expression, what: string): string[] | undefined {
  if (!ts.isArrayLiteralExpression(e)) return mismatch(ctx, e, "an array of strings", what);
  const out: string[] = [];
  let ok = true;
  for (const el of e.elements) {
    const s = ts.isExpression(el) ? readString(ctx, el, `${what} entries`) : undefined;
    if (s === undefined) ok = false;
    else out.push(s);
  }
  return ok ? out : undefined;
}

export function builtinHint(name: string): string {
  return isBuiltinV1(name) ? `${name} is a @aicad/std builtin` : "see @aicad/std";
}
