/**
 * The IR v1 expression language (SPEC-v1 §2.3–§2.6): lexer, parser, AST, canonical printer and
 * static type checker — a TypeScript port validated by the I9 conformance suite
 * (`corpus/v1/conformance/expressions/cases.json`). There is deliberately **no evaluator**:
 * Forge is the evaluator of record (§2.7); CadScript only compiles and checks.
 */
import { v1 } from "@aicad/ir-types";
import { byteLength } from "./ids.js";

export const MAX_EXPR_BYTES: number = v1.MAX_EXPR_BYTES;
export const MAX_EXPR_DEPTH: number = v1.MAX_EXPR_DEPTH;

// ─── AST ─────────────────────────────────────────────────────────────────────────────────────

export type Unit = "mm" | "cm" | "in" | "deg";
export const UNITS: readonly Unit[] = ["mm", "cm", "in", "deg"];

export type BinOp = "+" | "-" | "*" | "/" | "%" | "^" | "<" | "<=" | ">" | ">=" | "==" | "!=" | "&&" | "||";

/** An expression AST node. Parentheses are not nodes: the printer re-derives them. */
export type Expr =
  | { readonly k: "num"; readonly v: number; readonly unit?: Unit }
  | { readonly k: "bool"; readonly v: boolean }
  | { readonly k: "name"; readonly name: string }
  | { readonly k: "call"; readonly fn: string; readonly args: readonly Expr[] }
  | { readonly k: "un"; readonly op: "-" | "!"; readonly e: Expr }
  | { readonly k: "bin"; readonly op: BinOp; readonly l: Expr; readonly r: Expr }
  | { readonly k: "cond"; readonly c: Expr; readonly t: Expr; readonly f: Expr };

// ─── Lexer ───────────────────────────────────────────────────────────────────────────────────

type TokKind = "num" | "ident" | "op" | "eof";
interface Tok {
  kind: TokKind;
  text: string;
  /** UTF-16 offset into the text. */
  pos: number;
  value?: number;
}

/** An `EXPR_SYNTAX` problem: `offset` is a UTF-8 byte offset into the text. */
export interface SyntaxProblem {
  code: "EXPR_SYNTAX";
  message: string;
  offset: number;
  expected: string;
  /** Whether every character of the text is a valid token (only then may details echo it). */
  lexes: boolean;
}

class SyntaxFail extends Error {
  constructor(
    readonly pos: number,
    readonly expected: string,
    message: string,
  ) {
    super(message);
  }
}

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "(", ")", ",", "?", ":", "<", ">", "!"];

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isIdentStart(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z_]/.test(c);
}
function isIdentChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_]/.test(c);
}

function lex(text: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (isDigit(c)) {
      const start = i;
      while (isDigit(text[i])) i++;
      if (text[i] === "." && isDigit(text[i + 1])) {
        i++;
        while (isDigit(text[i])) i++;
      }
      if ((text[i] === "e" || text[i] === "E") && (isDigit(text[i + 1]) || ((text[i + 1] === "+" || text[i + 1] === "-") && isDigit(text[i + 2])))) {
        i += isDigit(text[i + 1]) ? 1 : 2;
        while (isDigit(text[i])) i++;
      }
      const t = text.slice(start, i);
      const value = Number(t);
      if (!Number.isFinite(value)) throw new SyntaxFail(start, "a finite number", `number literal out of range at offset ${start}`);
      toks.push({ kind: "num", text: t, pos: start, value });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (isIdentChar(text[i])) i++;
      toks.push({ kind: "ident", text: text.slice(start, i), pos: start });
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      toks.push({ kind: "op", text: op, pos: i });
      i += op.length;
      continue;
    }
    throw new SyntaxFail(i, "a token", `unexpected character at offset ${i}`);
  }
  toks.push({ kind: "eof", text: "", pos: text.length });
  return toks;
}

// ─── Parser ──────────────────────────────────────────────────────────────────────────────────

const CMP_OPS = new Set(["<", "<=", ">", ">=", "==", "!="]);

/**
 * Recursive descent over the §2.3 grammar. Nesting depth counts every recursive re-entry: a
 * parenthesised expression, a call argument, a `?:` branch, a unary operand and a `^` exponent;
 * beyond {@link MAX_EXPR_DEPTH} the text is `EXPR_SYNTAX`. Binary chains are loops, not depth.
 */
class Parser {
  private i = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly text: string,
  ) {}

  private peek(): Tok {
    return this.toks[this.i]!;
  }
  private next(): Tok {
    return this.toks[this.i++]!;
  }
  private isOp(t: string): boolean {
    const k = this.peek();
    return k.kind === "op" && k.text === t;
  }
  private expect(t: string, what: string): void {
    if (!this.isOp(t)) this.fail(what);
    this.i++;
  }
  private fail(expected: string): never {
    const t = this.peek();
    const found = t.kind === "eof" ? "end of expression" : `\`${t.text}\``;
    throw new SyntaxFail(t.pos, expected, `expected ${expected}, found ${found} at offset ${t.pos}`);
  }
  private deeper(depth: number): number {
    if (depth + 1 > MAX_EXPR_DEPTH) {
      throw new SyntaxFail(this.peek().pos, `at most ${MAX_EXPR_DEPTH} nesting levels`, `expression nested more than ${MAX_EXPR_DEPTH} levels deep`);
    }
    return depth + 1;
  }

  parseTop(): Expr {
    const e = this.expr(0);
    if (this.peek().kind !== "eof") this.fail("an operator or the end of the expression");
    return e;
  }

  private expr(depth: number): Expr {
    const c = this.or(depth);
    if (!this.isOp("?")) return c;
    this.next();
    const t = this.expr(this.deeper(depth));
    this.expect(":", "`:`");
    const f = this.expr(this.deeper(depth));
    return { k: "cond", c, t, f };
  }

  private or(depth: number): Expr {
    let l = this.and(depth);
    while (this.isOp("||")) {
      this.next();
      l = { k: "bin", op: "||", l, r: this.and(depth) };
    }
    return l;
  }

  private and(depth: number): Expr {
    let l = this.cmp(depth);
    while (this.isOp("&&")) {
      this.next();
      l = { k: "bin", op: "&&", l, r: this.cmp(depth) };
    }
    return l;
  }

  private cmp(depth: number): Expr {
    const l = this.add(depth);
    const t = this.peek();
    if (t.kind === "op" && CMP_OPS.has(t.text)) {
      this.next();
      return { k: "bin", op: t.text as BinOp, l, r: this.add(depth) };
    }
    return l;
  }

  private add(depth: number): Expr {
    let l = this.mul(depth);
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.text !== "+" && t.text !== "-")) return l;
      this.next();
      l = { k: "bin", op: t.text, l, r: this.mul(depth) };
    }
  }

  private mul(depth: number): Expr {
    let l = this.unary(depth);
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.text !== "*" && t.text !== "/" && t.text !== "%")) return l;
      this.next();
      l = { k: "bin", op: t.text, l, r: this.unary(depth) };
    }
  }

  private unary(depth: number): Expr {
    const t = this.peek();
    if (t.kind === "op" && (t.text === "-" || t.text === "!")) {
      this.next();
      return { k: "un", op: t.text, e: this.unary(this.deeper(depth)) };
    }
    return this.power(depth);
  }

  private power(depth: number): Expr {
    const base = this.atom(depth);
    if (!this.isOp("^")) return base;
    this.next();
    return { k: "bin", op: "^", l: base, r: this.unary(this.deeper(depth)) };
  }

  private atom(depth: number): Expr {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      const u = this.peek();
      if (u.kind === "ident" && (UNITS as readonly string[]).includes(u.text)) {
        this.next();
        return { k: "num", v: t.value!, unit: u.text as Unit };
      }
      return { k: "num", v: t.value! };
    }
    if (t.kind === "ident") {
      this.next();
      if (t.text === "true" || t.text === "false") return { k: "bool", v: t.text === "true" };
      if (this.isOp("(")) {
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(")")) {
          const d = this.deeper(depth);
          args.push(this.expr(d));
          while (this.isOp(",")) {
            this.next();
            args.push(this.expr(d));
          }
        }
        this.expect(")", "`,` or `)`");
        return { k: "call", fn: t.text, args };
      }
      return { k: "name", name: t.text };
    }
    if (this.isOp("(")) {
      this.next();
      const e = this.expr(this.deeper(depth));
      this.expect(")", "`)`");
      return e;
    }
    return this.fail("a number, a name, `(`, `-` or `!`");
  }

  byteOffset(pos: number): number {
    return byteLength(this.text.slice(0, pos));
  }
}

export type ParseResult = { ok: true; ast: Expr } | { ok: false; problem: SyntaxProblem };

/**
 * Parse an expression. Empty or blank text, text longer than {@link MAX_EXPR_BYTES}, a newline,
 * an unknown character, a number that rounds to ±∞ and nesting beyond {@link MAX_EXPR_DEPTH} are
 * `EXPR_SYNTAX`, as is anything the grammar rejects.
 */
export function parseExpr(text: string): ParseResult {
  const problem = (pos: number, expected: string, message: string, lexes: boolean): ParseResult => ({
    ok: false,
    problem: { code: "EXPR_SYNTAX", message, offset: byteLength(text.slice(0, pos)), expected, lexes },
  });
  if (text.trim().length === 0 || !/[^ \t]/.test(text)) return problem(0, "an expression", "empty expression", false);
  if (byteLength(text) > MAX_EXPR_BYTES) return problem(0, `at most ${MAX_EXPR_BYTES} bytes`, `expression longer than ${MAX_EXPR_BYTES} bytes`, false);
  let toks: Tok[];
  try {
    toks = lex(text);
  } catch (e) {
    if (e instanceof SyntaxFail) return problem(e.pos, e.expected, e.message, false);
    throw e;
  }
  try {
    return { ok: true, ast: new Parser(toks, text).parseTop() };
  } catch (e) {
    if (e instanceof SyntaxFail) return problem(e.pos, e.expected, e.message, true);
    throw e;
  }
}

// ─── Canonical printer (§2.4) ────────────────────────────────────────────────────────────────

/** ECMAScript `Number::toString`, with `-0` printed as `0` (§2.4 rule 1). */
export function formatExprNumber(v: number): string {
  return Object.is(v, -0) ? "0" : String(v);
}

/** Precedence levels, lowest first (§2.4 rule 3). */
const PREC = { cond: 0, or: 1, and: 2, cmp: 3, add: 4, mul: 5, unary: 6, power: 7, atom: 8 } as const;

function binPrec(op: BinOp): number {
  switch (op) {
    case "||":
      return PREC.or;
    case "&&":
      return PREC.and;
    case "+":
    case "-":
      return PREC.add;
    case "*":
    case "/":
    case "%":
      return PREC.mul;
    case "^":
      return PREC.power;
    default:
      return PREC.cmp;
  }
}

/** The precedence level of a node as printed without parentheses. */
export function precOf(e: Expr): number {
  switch (e.k) {
    case "cond":
      return PREC.cond;
    case "bin":
      return binPrec(e.op);
    case "un":
      return PREC.unary;
    default:
      return PREC.atom;
  }
}

/** Printing hooks: the canonical IR form, or CadScript's TypeScript form (`print.ts`). */
export interface ExprStyle {
  num(v: number, unit: Unit | undefined): string;
  binOp(op: BinOp): string;
  /** Whether the operand of a unary operator needs parentheses (beyond precedence). */
  unaryParens(op: "-" | "!", operand: Expr): boolean;
}

export const CANONICAL_STYLE: ExprStyle = {
  num: (v, unit) => (unit ? `${formatExprNumber(v)} ${unit}` : formatExprNumber(v)),
  binOp: (op) => op,
  unaryParens: (_op, operand) => operand.k === "bin" && operand.op === "^",
};

/**
 * Print an AST. Parentheses appear only where §2.3's precedence and associativity need them,
 * plus around a `^` operand of a unary operator. Iterative over left-associative chains is not
 * needed: depth is bounded by the parser and by CadScript's nesting limits.
 */
export function printExprWith(e: Expr, style: ExprStyle): string {
  const wrap = (s: string, need: boolean): string => (need ? `(${s})` : s);
  const at = (x: Expr, minPrec: number): string => wrap(printExprWith(x, style), precOf(x) < minPrec);
  switch (e.k) {
    case "num":
      return style.num(e.v, e.unit);
    case "bool":
      return e.v ? "true" : "false";
    case "name":
      return e.name;
    case "call":
      return `${e.fn}(${e.args.map((a) => printExprWith(a, style)).join(", ")})`;
    case "un":
      return `${e.op}${wrap(printExprWith(e.e, style), precOf(e.e) < PREC.unary || style.unaryParens(e.op, e.e))}`;
    case "cond":
      return `${at(e.c, PREC.or)} ? ${printExprWith(e.t, style)} : ${printExprWith(e.f, style)}`;
    case "bin": {
      const p = binPrec(e.op);
      const op = style.binOp(e.op);
      if (e.op === "^") return `${at(e.l, PREC.atom)} ${op} ${at(e.r, PREC.unary)}`;
      if (p === PREC.cmp) return `${at(e.l, PREC.add)} ${op} ${at(e.r, PREC.add)}`;
      return `${at(e.l, p)} ${op} ${at(e.r, p + 1)}`;
    }
  }
}

/** The canonical text of an AST (§2.4). `parseExpr(printExpr(ast))` gives `ast` back. */
export function printExpr(e: Expr): string {
  return printExprWith(e, CANONICAL_STYLE);
}

/** The canonical form of an expression text, or the syntax problem. */
export function canonicalize(text: string): { ok: true; text: string; ast: Expr } | { ok: false; problem: SyntaxProblem } {
  const r = parseExpr(text);
  return r.ok ? { ok: true, text: printExpr(r.ast), ast: r.ast } : r;
}

/** Structural equality of ASTs (numbers by value, `-0` equal to `0` never arises from parsing). */
export function exprEquals(a: Expr, b: Expr): boolean {
  if (a.k !== b.k) return false;
  switch (a.k) {
    case "num":
      return b.k === "num" && Object.is(a.v, b.v) && a.unit === b.unit;
    case "bool":
      return b.k === "bool" && a.v === b.v;
    case "name":
      return b.k === "name" && a.name === b.name;
    case "call":
      return b.k === "call" && a.fn === b.fn && a.args.length === b.args.length && a.args.every((x, i) => exprEquals(x, b.args[i]!));
    case "un":
      return b.k === "un" && a.op === b.op && exprEquals(a.e, b.e);
    case "bin":
      return b.k === "bin" && a.op === b.op && exprEquals(a.l, b.l) && exprEquals(a.r, b.r);
    case "cond":
      return b.k === "cond" && exprEquals(a.c, b.c) && exprEquals(a.t, b.t) && exprEquals(a.f, b.f);
  }
}

/** Every parameter name an expression uses (`PI` excluded), in first-use order. */
export function namesOf(e: Expr, out: string[] = []): string[] {
  const stack: Expr[] = [e];
  while (stack.length > 0) {
    const x = stack.pop()!;
    switch (x.k) {
      case "name":
        if (x.name !== "PI" && !out.includes(x.name)) out.push(x.name);
        break;
      case "call":
        for (let i = x.args.length - 1; i >= 0; i--) stack.push(x.args[i]!);
        break;
      case "un":
        stack.push(x.e);
        break;
      case "bin":
        stack.push(x.r, x.l);
        break;
      case "cond":
        stack.push(x.f, x.t, x.c);
        break;
      default:
        break;
    }
  }
  return out;
}

// ─── Types (§2.5) ────────────────────────────────────────────────────────────────────────────

export type Ty = { readonly t: "bool" } | { readonly t: "flex" } | { readonly t: "real"; readonly L: number; readonly A: number };

export const BOOL: Ty = { t: "bool" };
export const FLEX: Ty = { t: "flex" };
export const real = (L: number, A: number): Ty => ({ t: "real", L: L + 0, A: A + 0 });
export const LENGTH: Ty = real(1, 0);
export const ANGLE: Ty = real(0, 1);
export const DIMENSIONLESS: Ty = real(0, 0);

/** The field types of SPEC-v1 §2.2 (`forge_ir::v1::FieldType`). */
export type FieldType = "length" | "angle" | "ratio" | "count" | "bool";
/** Parameter units (§2.1). */
export type ParamUnit = "mm" | "deg" | "ratio" | "count" | "bool";

export function unitType(u: ParamUnit): Ty {
  switch (u) {
    case "mm":
      return LENGTH;
    case "deg":
      return ANGLE;
    case "bool":
      return BOOL;
    default:
      return DIMENSIONLESS;
  }
}

export function unitField(u: ParamUnit): FieldType {
  return u === "mm" ? "length" : u === "deg" ? "angle" : u;
}

/** The §2.5 type notation: `flex`, `bool`, `1`, `mm`, `mm^2`, `mm^-1`, `deg`, `mm*deg`, … */
export function formatType(t: Ty): string {
  if (t.t !== "real") return t.t;
  const f: string[] = [];
  if (t.L !== 0) f.push(t.L === 1 ? "mm" : `mm^${t.L}`);
  if (t.A !== 0) f.push(t.A === 1 ? "deg" : `deg^${t.A}`);
  return f.length === 0 ? "1" : f.join("*");
}

/** The type notation of what a field accepts (`EXPR_UNIT_MISMATCH` details `expected`). */
export function fieldTypeName(f: FieldType): string {
  return f === "length" ? "mm" : f === "angle" ? "deg" : f === "bool" ? "bool" : "1";
}

const isZeroDim = (t: Ty): boolean => t.t === "real" && t.L === 0 && t.A === 0;

// ─── Functions (§2.6) ────────────────────────────────────────────────────────────────────────

interface FnSpec {
  min: number;
  max: number;
  expected: string;
}
export const FUNCTIONS: Readonly<Record<string, FnSpec>> = {
  min: { min: 2, max: Infinity, expected: ">= 2" },
  max: { min: 2, max: Infinity, expected: ">= 2" },
  abs: { min: 1, max: 1, expected: "1" },
  sqrt: { min: 1, max: 1, expected: "1" },
  floor: { min: 1, max: 1, expected: "1" },
  ceil: { min: 1, max: 1, expected: "1" },
  round: { min: 1, max: 1, expected: "1" },
  clamp: { min: 3, max: 3, expected: "3" },
  hypot: { min: 2, max: 2, expected: "2" },
  sin: { min: 1, max: 1, expected: "1" },
  cos: { min: 1, max: 1, expected: "1" },
  tan: { min: 1, max: 1, expected: "1" },
  asin: { min: 1, max: 1, expected: "1" },
  acos: { min: 1, max: 1, expected: "1" },
  atan: { min: 1, max: 1, expected: "1" },
  atan2: { min: 2, max: 2, expected: "2" },
};
export const FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS);

// ─── Type checker ────────────────────────────────────────────────────────────────────────────

export type ExprCode =
  | "EXPR_UNKNOWN_NAME"
  | "EXPR_UNKNOWN_FUNCTION"
  | "EXPR_ARITY"
  | "EXPR_UNIT_MISMATCH"
  | "EXPR_TYPE_MISMATCH"
  | "EXPR_SCOPE";

/** A rejection found by the type checker, located at an AST node. */
export interface TypeProblem {
  code: ExprCode;
  message: string;
  /** The offending sub-expression (identity: the node of the checked AST). */
  node: Expr;
  details: Record<string, unknown>;
}

/** How a name resolves in the checked expression's scope (§2.8). */
export type NameInfo =
  | { kind: "param"; unit: ParamUnit }
  | { kind: "other-part"; part: string }
  | { kind: "feature" }
  | { kind: "unknown" };

export interface TypeEnv {
  lookup(name: string): NameInfo;
  /** Names in scope, for "did you mean" (details `similar`). */
  names(): readonly string[];
}

class TypeFail extends Error {
  constructor(readonly problem: TypeProblem) {
    super(problem.message);
  }
}

function similar(name: string, candidates: readonly string[]): string[] {
  const lower = name.toLowerCase();
  const scored = candidates
    .filter((c) => c !== name)
    .map((c) => ({ c, d: editDistance(lower, c.toLowerCase()) }))
    .filter(({ d }) => d <= Math.max(1, Math.floor(name.length / 3)));
  scored.sort((a, b) => a.d - b.d || (a.c < b.c ? -1 : a.c > b.c ? 1 : 0));
  return scored.slice(0, 5).map((s) => s.c);
}

function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

/**
 * Static typing of one expression (§2.5), bottom-up; the first problem (in evaluation order,
 * left to right) ends the check. `root` is the whole expression (for `expr` in details).
 */
class Checker {
  private readonly rootText: string;
  constructor(
    private readonly env: TypeEnv,
    root: Expr,
  ) {
    this.rootText = printExpr(root);
  }

  private fail(code: ExprCode, node: Expr, message: string, details: Record<string, unknown>): never {
    throw new TypeFail({ code, node, message, details });
  }

  private mismatch(node: Expr, expected: string, found: string, what: string): never {
    const code: ExprCode = expected === "bool" || found === "bool" ? "EXPR_TYPE_MISMATCH" : "EXPR_UNIT_MISMATCH";
    return this.fail(code, node, `${what}: expected ${expected}, found ${found}`, {
      expr: this.rootText,
      subexpr: printExpr(node),
      expected,
      found,
    });
  }

  private num(e: Expr, what: string): Ty {
    const t = this.type(e);
    if (t.t === "bool") this.mismatch(e, "a number", "bool", what);
    return t;
  }

  private boolean(e: Expr, what: string): void {
    const t = this.type(e);
    if (t.t !== "bool") this.mismatch(e, "bool", formatType(t), what);
  }

  /** Unify numeric types (§2.5): fixed dimensions must agree; Flex adopts the other. */
  private unify(a: Ty, b: Ty, bNode: Expr, what: string): Ty {
    if (a.t === "flex") return b;
    if (b.t === "flex") return a;
    if (a.t === "real" && b.t === "real" && a.L === b.L && a.A === b.A) return a;
    return this.mismatch(bNode, formatType(a), formatType(b), what);
  }

  type(e: Expr): Ty {
    switch (e.k) {
      case "num":
        return e.unit === undefined ? FLEX : e.unit === "deg" ? ANGLE : LENGTH;
      case "bool":
        return BOOL;
      case "name":
        return this.name(e);
      case "call":
        return this.call(e);
      case "un": {
        if (e.op === "!") {
          this.boolean(e.e, "`!` needs a bool");
          return BOOL;
        }
        return this.num(e.e, "unary `-` needs a number");
      }
      case "cond": {
        this.boolean(e.c, "the condition of `?:` must be a bool");
        const t = this.type(e.t);
        const f = this.type(e.f);
        if (t.t === "bool" || f.t === "bool") {
          if (t.t === "bool" && f.t === "bool") return BOOL;
          return this.mismatch(e.f, formatType(t), formatType(f), "the branches of `?:` must have one type");
        }
        return this.unify(t, f, e.f, "the branches of `?:` must have one type");
      }
      case "bin":
        return this.bin(e);
    }
  }

  private name(e: Extract<Expr, { k: "name" }>): Ty {
    if (e.name === "PI") return FLEX;
    const info = this.env.lookup(e.name);
    switch (info.kind) {
      case "param":
        return unitType(info.unit);
      case "other-part":
        return this.fail("EXPR_SCOPE", e, `\`${e.name}\` is a parameter of part ${JSON.stringify(info.part)}, not visible here`, {
          name: e.name,
          part: info.part,
        });
      case "feature":
        return this.fail("EXPR_UNKNOWN_NAME", e, `\`${e.name}\` is a feature, not a parameter`, {
          name: e.name,
          is_feature: true,
          similar: similar(e.name, this.env.names()),
        });
      default:
        return this.fail("EXPR_UNKNOWN_NAME", e, `unknown parameter \`${e.name}\``, {
          name: e.name,
          is_feature: false,
          similar: similar(e.name, this.env.names()),
        });
    }
  }

  private call(e: Extract<Expr, { k: "call" }>): Ty {
    const spec = FUNCTIONS[e.fn];
    if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, e.fn) || !spec) {
      return this.fail("EXPR_UNKNOWN_FUNCTION", e, `unknown function \`${e.fn}\``, { name: e.fn, similar: similar(e.fn, FUNCTION_NAMES) });
    }
    const n = e.args.length;
    if (n < spec.min || n > spec.max) {
      return this.fail("EXPR_ARITY", e, `${e.fn}() takes ${spec.expected} argument${spec.expected === "1" ? "" : "s"}, got ${n}`, {
        name: e.fn,
        expected: spec.expected,
        found: n,
      });
    }
    const a0 = e.args[0]!;
    switch (e.fn) {
      case "min":
      case "max":
      case "clamp":
      case "hypot": {
        let t = this.num(a0, `${e.fn}() takes numbers`);
        for (const a of e.args.slice(1)) t = this.unify(t, this.num(a, `${e.fn}() takes numbers`), a, `the arguments of ${e.fn}() must have one unit`);
        return t;
      }
      case "abs":
      case "floor":
      case "ceil":
      case "round":
        return this.num(a0, `${e.fn}() takes a number`);
      case "sqrt": {
        const t = this.num(a0, "sqrt() takes a number");
        if (t.t === "flex") return FLEX;
        if (t.t === "real" && t.L % 2 === 0 && t.A % 2 === 0) return real(t.L / 2, t.A / 2);
        return this.mismatch(a0, "a square (even exponents)", formatType(t), "sqrt() of an odd dimension");
      }
      case "sin":
      case "cos":
      case "tan": {
        const t = this.num(a0, `${e.fn}() takes an angle`);
        if (t.t === "flex") return FLEX;
        if (t.t === "real" && t.L === 0 && t.A === 1) return DIMENSIONLESS;
        return this.mismatch(a0, "deg", formatType(t), `${e.fn}() takes an angle in degrees`);
      }
      case "asin":
      case "acos":
      case "atan": {
        const t = this.num(a0, `${e.fn}() takes a ratio`);
        if (t.t === "flex" || isZeroDim(t)) return ANGLE;
        return this.mismatch(a0, "1", formatType(t), `${e.fn}() takes a dimensionless ratio`);
      }
      default: {
        // atan2(y, x)
        const y = this.num(a0, "atan2() takes numbers");
        const x = e.args[1]!;
        this.unify(y, this.num(x, "atan2() takes numbers"), x, "the arguments of atan2() must have one unit");
        return ANGLE;
      }
    }
  }

  private bin(e: Extract<Expr, { k: "bin" }>): Ty {
    switch (e.op) {
      case "&&":
      case "||":
        this.boolean(e.l, `\`${e.op}\` needs bools`);
        this.boolean(e.r, `\`${e.op}\` needs bools`);
        return BOOL;
      case "==":
      case "!=": {
        const l = this.type(e.l);
        const r = this.type(e.r);
        if (l.t === "bool" || r.t === "bool") {
          if (l.t === "bool" && r.t === "bool") return BOOL;
          return this.mismatch(e.r, formatType(l), formatType(r), `\`${e.op}\` compares two bools or two numbers`);
        }
        this.unify(l, r, e.r, `\`${e.op}\` compares values of one unit`);
        return BOOL;
      }
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const l = this.num(e.l, `\`${e.op}\` compares numbers`);
        const r = this.num(e.r, `\`${e.op}\` compares numbers`);
        this.unify(l, r, e.r, `\`${e.op}\` compares values of one unit`);
        return BOOL;
      }
      case "+":
      case "-":
      case "%": {
        const l = this.num(e.l, `\`${e.op}\` needs numbers`);
        const r = this.num(e.r, `\`${e.op}\` needs numbers`);
        return this.unify(l, r, e.r, `the operands of \`${e.op}\` must have one unit`);
      }
      case "*": {
        const l = this.num(e.l, "`*` needs numbers");
        const r = this.num(e.r, "`*` needs numbers");
        if (l.t === "flex" && r.t === "flex") return FLEX;
        if (l.t === "flex") return isZeroDim(r) ? FLEX : r;
        if (r.t === "flex") return isZeroDim(l) ? FLEX : l;
        return real((l as { L: number }).L + (r as { L: number }).L, (l as { A: number }).A + (r as { A: number }).A);
      }
      case "/": {
        const l = this.num(e.l, "`/` needs numbers");
        const r = this.num(e.r, "`/` needs numbers");
        if (l.t === "flex" && r.t === "flex") return FLEX;
        if (l.t === "flex") return isZeroDim(r) ? FLEX : real(-(r as { L: number }).L, -(r as { A: number }).A);
        if (r.t === "flex") return isZeroDim(l) ? FLEX : l;
        return real((l as { L: number }).L - (r as { L: number }).L, (l as { A: number }).A - (r as { A: number }).A);
      }
      default: {
        // `^`
        const b = this.num(e.l, "`^` needs numbers");
        const x = this.num(e.r, "`^` needs numbers");
        if (b.t === "flex" || isZeroDim(b)) {
          if (x.t === "flex" || isZeroDim(x)) return b;
          return this.mismatch(e.r, "1", formatType(x), "an exponent must be dimensionless");
        }
        const n = integerLiteral(e.r);
        if (n === undefined) return this.mismatch(e.r, "an integer literal", formatType(x), `the exponent of a ${formatType(b)} base must be an integer literal`);
        const bb = b as { L: number; A: number };
        return real(n * bb.L, n * bb.A);
      }
    }
  }
}

/** An integer literal exponent, optionally negated (§2.5): `2`, `2.0`, `-1`, `(-1)`. */
function integerLiteral(e: Expr): number | undefined {
  let sign = 1;
  let x = e;
  if (x.k === "un" && x.op === "-") {
    sign = -1;
    x = x.e;
  }
  if (x.k === "num" && x.unit === undefined && Number.isInteger(x.v)) return sign * x.v;
  return undefined;
}

export type CheckResult = { ok: true; type: Ty } | { ok: false; problem: TypeProblem };

/** The static type of an expression (before the use-site check), or its first problem. */
export function typeOf(e: Expr, env: TypeEnv): CheckResult {
  try {
    return { ok: true, type: new Checker(env, e).type(e) };
  } catch (err) {
    if (err instanceof TypeFail) return { ok: false, problem: err.problem };
    throw err;
  }
}

/** Does type `t` fit a field of type `field` (§2.5 "Use site")? */
export function fitsField(t: Ty, field: FieldType): boolean {
  switch (field) {
    case "bool":
      return t.t === "bool";
    case "length":
      return t.t === "flex" || (t.t === "real" && t.L === 1 && t.A === 0);
    case "angle":
      return t.t === "flex" || (t.t === "real" && t.L === 0 && t.A === 1);
    default:
      return t.t === "flex" || isZeroDim(t);
  }
}

/**
 * Type-check an expression at a use site: its static type (§2.5), then the field's type. Returns
 * the static type, or the first problem.
 */
export function checkAtField(e: Expr, field: FieldType, env: TypeEnv): CheckResult {
  const r = typeOf(e, env);
  if (!r.ok) return r;
  if (fitsField(r.type, field)) return r;
  const expected = fieldTypeName(field);
  const found = formatType(r.type);
  const code: ExprCode = field === "bool" || r.type.t === "bool" ? "EXPR_TYPE_MISMATCH" : "EXPR_UNIT_MISMATCH";
  const text = printExpr(e);
  return {
    ok: false,
    problem: {
      code,
      node: e,
      message: `this field takes ${expected === "1" ? "a dimensionless number" : expected}, the expression is ${found}`,
      details: { expr: text, subexpr: text, expected, found },
    },
  };
}
