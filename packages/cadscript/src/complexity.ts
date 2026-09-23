/**
 * Nesting limits.
 *
 * The TypeScript parser and checker recurse once per level of syntactic nesting, so a deeply
 * nested input (`((((…))))`, `[[[[…]]]]`, `- - - … 1`) overflows the JS call stack and throws a
 * `RangeError`. Where that happens depends on the host's stack size (Node, a browser main thread,
 * a worker), so an unguarded compiler would give different answers on different hosts, and a
 * throw instead of a diagnostic fails a whole agent run.
 *
 * Instead, `compile()` and `typecheck()` reject input nested beyond fixed, host-independent
 * limits with a `CS_TOO_COMPLEX` diagnostic:
 *
 * 1. {@link bracketNestingProblem}: bracket depth, measured on tokens **before** parsing, so deep
 *    brackets never reach the parser.
 * 2. {@link syntaxNestingProblem}: syntax-tree depth after parsing, for nesting without brackets
 *    (unary chains, `a ? b : c ? …`, member/call chains, `**`, …).
 * 3. A caught stack overflow: the last line of defence for input that overflows the parser
 *    before check 2 can run (thousands of levels without brackets). Only this path depends on the
 *    host, and it still reports `CS_TOO_COMPLEX`, never a throw.
 *
 * Real CadScript nests about a dozen syntax levels and five brackets deep; the limits leave
 * a wide margin and are small enough that the deepest accepted input compiles and type-checks
 * within 40% of Node's default stack (the costliest, nested generic types, needs about a third;
 * see `test/robustness.test.ts`), so hosts with far smaller stacks agree too.
 *
 * Type-checker work limits.
 *
 * `compile()` takes linear time. The TypeScript checker (TS 5.9) takes time growing with the
 * **square** of the input along three dimensions, so a runaway input (one line or fragment
 * repeated thousands of times) would block `typecheck()` for minutes instead of throwing:
 *
 * - depth: checks of a node walk up to the root (e.g. for every numeric literal), costing
 *   nodes × depth. Left-associative chains (`1 + 1 + … + 1`) are that deep although check 2
 *   exempts them: a 50000-term sum took two minutes;
 * - overloads: each declaration of one name in one place is an overload of the same type, which
 *   tsc tries on every call and prints in full in every error about it: a thousand methods
 *   named `doc` in one object literal took 4 s to check, and 8000 would take minutes;
 * - control-flow steps: every reference to a variable or import walks back over each earlier
 *   declaration, assignment and statement, costing references × steps. Valid CadScript hits this
 *   one: 8000 `const` statements took 3–4 s, and 32000 would take about a minute.
 *
 * {@link checkerWorkProblem} measures all three in one linear pass. `typecheck()` does not run
 * the checker on input beyond {@link MAX_CHECKED_DEPTH}, {@link MAX_OVERLOADS} or
 * {@link MAX_FLOW_STEPS} and reports `CS_TOO_COMPLEX` instead ("not type-checked: …");
 * `compile()` is not limited by them. Real CadScript stays far below each: a few levels of
 * depth, no overloads, and at most a few hundred steps, so only runaway input gets there.
 */
import ts from "typescript";
import type { Diagnostic, Position } from "./diagnostics.js";

/** Deepest bracket nesting accepted: `(`, `[`, `{` and template `${`, counted on tokens. */
export const MAX_BRACKET_DEPTH = 32;

/**
 * Deepest syntax-tree nesting accepted. The left operand of a binary expression does not add a
 * level: the parser, binder and checker walk left-associative chains (`1 + 1 + … + 1`)
 * iteratively, and so does the compiler.
 */
export const MAX_SYNTAX_DEPTH = 128;

/** Deepest syntax tree that `typecheck()` type-checks, counting every level, left operands too. */
export const MAX_CHECKED_DEPTH = 512;

/**
 * Most declarations of one name in one scope, type or object literal that `typecheck()`
 * type-checks (functions, methods, interfaces, classes, namespaces; also call and construct
 * signatures and constructors).
 */
export const MAX_OVERLOADS = 32;

/**
 * Most control-flow steps in a file that `typecheck()` type-checks: variable declarations,
 * assignments (`=`, `+=`, …, `++`, `--`) and statements other than blocks and `const`/`let`
 * statements (their declarations count instead).
 */
export const MAX_FLOW_STEPS = 2048;

/** Why a source is rejected as too complex, and where (UTF-16 offsets into the source). */
export interface TooComplex {
  start: number;
  end: number;
  message: string;
  /** How to fix it, if not the nesting hint. */
  hint?: string;
}

const HINT =
  "CadScript nests only a few levels deep, e.g. sketch(XY, { a: line([0, 0], [10, 0]) }); " +
  "look for runaway or unbalanced brackets and write the statement flat, with literal values";

const CHECKER_WORK_HINT =
  "the TypeScript checker's time grows with the square of such input, so typecheck() did not run it (compile() has no such limit). " +
  "Real CadScript stays far below it: look for a line or fragment repeated by mistake";

/** Tokens after which a `/` is a division; after anything else it starts a regular expression. */
function endsExpression(kind: ts.SyntaxKind): boolean {
  switch (kind) {
    case ts.SyntaxKind.Identifier:
    case ts.SyntaxKind.PrivateIdentifier:
    case ts.SyntaxKind.NumericLiteral:
    case ts.SyntaxKind.BigIntLiteral:
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
    case ts.SyntaxKind.TemplateTail:
    case ts.SyntaxKind.RegularExpressionLiteral:
    case ts.SyntaxKind.CloseParenToken:
    case ts.SyntaxKind.CloseBracketToken:
    case ts.SyntaxKind.CloseBraceToken:
    case ts.SyntaxKind.PlusPlusToken:
    case ts.SyntaxKind.MinusMinusToken:
    case ts.SyntaxKind.ThisKeyword:
    case ts.SyntaxKind.SuperKeyword:
    case ts.SyntaxKind.TrueKeyword:
    case ts.SyntaxKind.FalseKeyword:
    case ts.SyntaxKind.NullKeyword:
      return true;
    default:
      // Contextual keywords (`of`, `as`, `type`, …) are usually identifiers.
      return kind > ts.SyntaxKind.LastReservedWord && kind <= ts.SyntaxKind.LastKeyword;
  }
}

/**
 * Check 1: the first opening bracket nested deeper than {@link MAX_BRACKET_DEPTH}, found by
 * scanning tokens (iteratively; comments and strings are skipped). Unclosed brackets count too:
 * the parser recurses into them all the same.
 */
export function bracketNestingProblem(source: string): TooComplex | undefined {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const open: ts.SyntaxKind[] = [];
  let prev = ts.SyntaxKind.Unknown;
  for (let t = scanner.scan(); t !== ts.SyntaxKind.EndOfFileToken; t = scanner.scan()) {
    switch (t) {
      case ts.SyntaxKind.OpenParenToken:
      case ts.SyntaxKind.OpenBracketToken:
      case ts.SyntaxKind.OpenBraceToken:
      case ts.SyntaxKind.TemplateHead:
        open.push(t);
        if (open.length > MAX_BRACKET_DEPTH) {
          return {
            start: scanner.getTokenStart(),
            end: scanner.getTokenEnd(),
            message: `brackets are nested more than ${MAX_BRACKET_DEPTH} levels deep`,
          };
        }
        break;
      case ts.SyntaxKind.CloseParenToken:
      case ts.SyntaxKind.CloseBracketToken:
        open.pop();
        break;
      case ts.SyntaxKind.CloseBraceToken:
        // Inside `${…}` the closing brace continues the template literal.
        if (open[open.length - 1] === ts.SyntaxKind.TemplateHead) {
          t = scanner.reScanTemplateToken(false);
          if (t === ts.SyntaxKind.TemplateTail) open.pop();
        } else {
          open.pop();
        }
        break;
      case ts.SyntaxKind.SlashToken:
      case ts.SyntaxKind.SlashEqualsToken:
        if (!endsExpression(prev)) t = scanner.reScanSlashToken();
        break;
      default:
        break;
    }
    prev = t;
  }
  return undefined;
}

/**
 * Check 2: the first node (in source order) nested deeper than {@link MAX_SYNTAX_DEPTH}, found
 * with an explicit stack (never recursion).
 */
export function syntaxNestingProblem(sf: ts.SourceFile): TooComplex | undefined {
  const nodes: ts.Node[] = [sf];
  const depths: number[] = [0];
  const children: ts.Node[] = [];
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    const depth = depths.pop()!;
    if (depth > MAX_SYNTAX_DEPTH) {
      return { start: node.getStart(sf), end: node.getEnd(), message: `code is nested more than ${MAX_SYNTAX_DEPTH} levels deep` };
    }
    children.length = 0;
    ts.forEachChild(node, (child) => {
      children.push(child); // (no return value: a truthy one would stop forEachChild)
    });
    const binary = ts.isBinaryExpression(node);
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i]!;
      nodes.push(child);
      depths.push(binary && child === node.left ? depth : depth + 1);
    }
  }
  return undefined;
}

/** Whether `node` is a control-flow step (see {@link MAX_FLOW_STEPS}). */
function isFlowStep(node: ts.Node): boolean {
  switch (node.kind) {
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.DefaultClause:
      return true;
    case ts.SyntaxKind.VariableStatement:
      return false;
    case ts.SyntaxKind.BinaryExpression: {
      const op = (node as ts.BinaryExpression).operatorToken.kind;
      return op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
    }
    case ts.SyntaxKind.PrefixUnaryExpression:
    case ts.SyntaxKind.PostfixUnaryExpression: {
      const op = (node as ts.PrefixUnaryExpression | ts.PostfixUnaryExpression).operator;
      return op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken;
    }
    default:
      return node.kind >= ts.SyntaxKind.FirstStatement && node.kind <= ts.SyntaxKind.LastStatement;
  }
}

/** What `node` adds an overload to, within its parent (see {@link MAX_OVERLOADS}), if anything. */
function overloadOf(node: ts.Node): string | undefined {
  switch (node.kind) {
    case ts.SyntaxKind.CallSignature:
      return "call signatures";
    case ts.SyntaxKind.ConstructSignature:
      return "construct signatures";
    case ts.SyntaxKind.Constructor:
      return "constructors";
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.ModuleDeclaration: {
      const name = (node as ts.NamedDeclaration).name;
      const named = name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name));
      return named ? `declarations of \`${name.text}\`` : undefined; // (a computed name is not known before checking)
    }
    default:
      return undefined;
  }
}

/**
 * The first node (in source order) beyond a type-checker work limit: {@link MAX_CHECKED_DEPTH},
 * {@link MAX_OVERLOADS} or {@link MAX_FLOW_STEPS}. One pass with an explicit stack; expects a
 * source that passed {@link parseWithinLimits}.
 */
export function checkerWorkProblem(sf: ts.SourceFile): TooComplex | undefined {
  const at = (node: ts.Node, message: string): TooComplex => ({
    start: node.getStart(sf),
    end: node.getEnd(),
    message: `not type-checked: ${message}`,
    hint: CHECKER_WORK_HINT,
  });
  const nodes: ts.Node[] = [sf];
  const depths: number[] = [0];
  const children: ts.Node[] = [];
  const overloads = new Map<ts.Node, Map<string, number>>();
  let steps = 0;
  while (nodes.length > 0) {
    const node = nodes.pop()!;
    const depth = depths.pop()!;
    if (depth > MAX_CHECKED_DEPTH) {
      return at(node, `code is nested more than ${MAX_CHECKED_DEPTH} levels deep, counting each operator of a chain like 1 + 2 + 3`);
    }
    if (isFlowStep(node) && ++steps > MAX_FLOW_STEPS) {
      return at(node, `the file has more than ${MAX_FLOW_STEPS} declarations, assignments and statements`);
    }
    const overload = overloadOf(node);
    if (overload !== undefined) {
      let counts = overloads.get(node.parent);
      if (!counts) overloads.set(node.parent, (counts = new Map()));
      const n = (counts.get(overload) ?? 0) + 1;
      counts.set(overload, n);
      if (n > MAX_OVERLOADS) return at(node, `more than ${MAX_OVERLOADS} ${overload} in one scope, type or object literal`);
    }
    children.length = 0;
    ts.forEachChild(node, (child) => {
      children.push(child); // (no return value: a truthy one would stop forEachChild)
    });
    for (let i = children.length - 1; i >= 0; i--) {
      nodes.push(children[i]!);
      depths.push(depth + 1);
    }
  }
  return undefined;
}

/** Whether `e` is the engine's stack-overflow error (V8 and JavaScriptCore: RangeError; SpiderMonkey: InternalError). */
export function isStackOverflow(e: unknown): boolean {
  if (e instanceof RangeError) return /call stack/i.test(e.message);
  return e instanceof Error && e.name === "InternalError" && /recursion/i.test(e.message);
}

/** Check 3's report: the host's call stack ran out (no position is known). */
export function stackOverflowProblem(what: "parse" | "compile" | "type-check"): TooComplex {
  return { start: 0, end: 0, message: `code is nested too deeply to ${what} (the call stack ran out)` };
}

/**
 * The TypeScript parser is a singleton. A parse that throws midway (a stack overflow, here or in
 * any other code that parses with TypeScript) skips its state reset and leaves caches behind,
 * e.g. the positions it ruled out as arrow functions, which the next parse would read. A
 * complete parse of an empty file resets that state (well under a microsecond), so it runs
 * before every guarded parse and after one that overflowed.
 */
function resetParser(): void {
  try {
    ts.createSourceFile("reset.ts", "", ts.ScriptTarget.Latest);
  } catch {
    // No stack left even for that: the next guarded parse resets first anyway.
  }
}

export type GuardedParse = { sf: ts.SourceFile; problem?: undefined } | { sf: ts.SourceFile | undefined; problem: TooComplex };

/**
 * Parse `source` as TypeScript, applying checks 1–3: the parse `compile()` and `typecheck()` use.
 * Tools that parse CadScript themselves should use it too, so that deep input cannot overflow
 * their parse either.
 */
export function parseWithinLimits(fileName: string, source: string, target: ts.ScriptTarget): GuardedParse {
  const brackets = bracketNestingProblem(source);
  if (brackets) return { sf: undefined, problem: brackets };
  let sf: ts.SourceFile;
  try {
    resetParser();
    sf = ts.createSourceFile(fileName, source, target, true, ts.ScriptKind.TS);
  } catch (e) {
    resetParser();
    if (!isStackOverflow(e)) throw e;
    return { sf: undefined, problem: stackOverflowProblem("parse") };
  }
  const deep = syntaxNestingProblem(sf);
  return deep ? { sf, problem: deep } : { sf };
}

/**
 * 1-based line/column of `offset`, with TypeScript's line breaks (LF, CR, CRLF, U+2028, U+2029)
 * so positions agree with the ones the compiler reports from a parsed `SourceFile`.
 */
function positionOf(text: string, offset: number): Position {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; ) {
    const ch = text.charCodeAt(i++);
    if (ch === 13 && text.charCodeAt(i) === 10) i++; // CRLF is one break
    if (ch === 10 || ch === 13 || ch === 0x2028 || ch === 0x2029) {
      if (i > offset) break; // `offset` is inside a CRLF: still on this line
      line++;
      lineStart = i;
    }
  }
  return { line, col: offset - lineStart + 1 };
}

/** The `CS_TOO_COMPLEX` diagnostic for `problem`. */
export function tooComplexDiagnostic(source: string, problem: TooComplex): Diagnostic {
  return {
    code: "CS_TOO_COMPLEX",
    severity: "error",
    message: problem.message,
    hint: problem.hint ?? HINT,
    span: { start: positionOf(source, problem.start), end: positionOf(source, problem.end) },
  };
}
