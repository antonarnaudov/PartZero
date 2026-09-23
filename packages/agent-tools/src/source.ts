/**
 * Statement-level view of a CadScript file, independent of whether it compiles: the agent patches
 * features by their `const` name even when the file currently has errors. Parsing uses the
 * TypeScript scanner/parser only (no type checking, nothing is executed).
 */
import ts from "typescript";

export type StatementKind = "import" | "doc" | "part" | "feature" | "other";

export interface SourceStatement {
  kind: StatementKind;
  /** Feature: the const name. Part: the part name. */
  name?: string;
  /** Feature: the called builtin (`sketch`, `extrude`, `revolve`, or whatever was written). */
  callee?: string;
  /** Start of the comments attached directly above the statement (or `start` when there are none). */
  attachedStart: number;
  /** Start of the statement itself. */
  start: number;
  /** End of the statement (exclusive). */
  end: number;
  /** 1-based line of `start` / of the last character. */
  line: number;
  endLine: number;
  text: string;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Comments directly above `stmt` (no blank line in between) belong to it. */
function attachedStart(source: string, stmt: ts.Statement, sf: ts.SourceFile): number {
  const start = stmt.getStart(sf);
  const ranges = ts.getLeadingCommentRanges(source, stmt.pos) ?? [];
  let at = start;
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i]!;
    const gap = source.slice(r.end, at);
    if (/\n\s*\n/.test(gap)) break;
    at = r.pos;
  }
  return at;
}

function calleeName(e: ts.Expression | undefined): string | undefined {
  if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression)) return e.expression.text;
  return undefined;
}

export interface LocatedSource {
  statements: SourceStatement[];
  /** Syntax errors as `line:col message` (the compiler reports them properly; this is for patch safety). */
  syntaxErrors: string[];
}

export function locateStatements(source: string): LocatedSource {
  const sf = ts.createSourceFile("main.cad.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const statements: SourceStatement[] = [];
  for (const stmt of sf.statements) {
    const start = stmt.getStart(sf);
    const base = {
      attachedStart: attachedStart(source, stmt, sf),
      start,
      end: stmt.end,
      line: lineOf(sf, start),
      endLine: lineOf(sf, Math.max(start, stmt.end - 1)),
      text: source.slice(start, stmt.end),
    };
    if (ts.isImportDeclaration(stmt)) {
      statements.push({ kind: "import", ...base });
    } else if (ts.isVariableStatement(stmt) && stmt.declarationList.declarations.length === 1) {
      const d = stmt.declarationList.declarations[0]!;
      const name = ts.isIdentifier(d.name) ? d.name.text : undefined;
      const callee = calleeName(d.initializer);
      statements.push({ kind: "feature", ...(name === undefined ? {} : { name }), ...(callee === undefined ? {} : { callee }), ...base });
    } else if (ts.isExpressionStatement(stmt)) {
      const callee = calleeName(stmt.expression);
      if (callee === "part") {
        const arg = (stmt.expression as ts.CallExpression).arguments[0];
        const name = arg && ts.isStringLiteral(arg) ? arg.text : undefined;
        statements.push({ kind: "part", ...(name === undefined ? {} : { name }), ...base });
      } else if (callee === "doc") {
        statements.push({ kind: "doc", ...base });
      } else {
        statements.push({ kind: "other", ...base });
      }
    } else {
      statements.push({ kind: "other", ...base });
    }
  }
  const diags = (sf as unknown as { parseDiagnostics?: ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  const syntaxErrors = diags.map((d) => {
    const p = sf.getLineAndCharacterOfPosition(d.start);
    return `${p.line + 1}:${p.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });
  return { statements, syntaxErrors };
}

/** The `const` statement of a feature, by name. */
export function findFeature(source: string, name: string): SourceStatement | undefined {
  return locateStatements(source).statements.find((s) => s.kind === "feature" && s.name === name);
}

/** Names of all feature consts, in file order. */
export function featureConstNames(source: string): string[] {
  return locateStatements(source).statements.flatMap((s) => (s.kind === "feature" && s.name !== undefined ? [s.name] : []));
}

/** One patch: replace, delete (empty `code`) or insert (unknown name) a feature statement. */
export interface SourcePatch {
  /** The feature const to replace or delete, or the name of a new feature to insert. */
  feature: string;
  /** New statement(s). Empty string deletes the feature (and the comments attached above it). */
  code: string;
  /** New features only: insert after this feature (default: end of file). */
  after?: string | undefined;
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

function lineStartOf(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

interface Trailing {
  /** Only whitespace and comments follow the statement on its last line. */
  atEol: boolean;
  /** atEol: just past the newline (or the end of the file); otherwise the start of the code that follows. */
  next: number;
  /** atEol: the offset of the newline itself (or the end of the file). */
  lineEnd: number;
}

/**
 * What follows a statement on its last line: only trivia (whitespace, a `//` comment, one-line block
 * comments) up to the newline, or more code. Same rule as the cadscript splicer's
 * `endOfStatementLine` (internal to @aicad/cadscript): a block comment that spans lines is not
 * treated as trailing trivia.
 */
function trailingTrivia(text: string, end: number): Trailing {
  let i = end;
  for (;;) {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i++;
    if (i >= text.length) return { atEol: true, next: text.length, lineEnd: text.length };
    if (text[i] === "\n") return { atEol: true, next: i + 1, lineEnd: i };
    if (text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      return nl === -1 ? { atEol: true, next: text.length, lineEnd: text.length } : { atEol: true, next: nl + 1, lineEnd: nl };
    }
    if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      // An unclosed or multi-line block comment is not this statement's trivia: keep it.
      if (close === -1 || text.slice(i, close + 2).includes("\n")) return { atEol: false, next: i, lineEnd: i };
      i = close + 2;
      continue;
    }
    return { atEol: false, next: i, lineEnd: i };
  }
}

/** Just past the spaces and tabs at `pos` (never past a newline). */
function skipSpaces(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  return i;
}

/**
 * The range a deletion removes: the statement with its attached comments, bounded to the statement
 * itself. Whole lines go (with trailing trivia and the newline) only when nothing else shares them.
 * Code before or after the statement on the same line is kept, and so are the comments in front of
 * a following statement on that line (they are attached to it, not to the deleted one).
 */
function deletionRange(text: string, target: SourceStatement): [number, number] {
  const lineBegin = lineStartOf(text, target.attachedStart);
  const before = text.slice(lineBegin, target.attachedStart);
  const tail = trailingTrivia(text, target.end);
  if (!tail.atEol) return [target.attachedStart, skipSpaces(text, target.end)];
  if (before.trim() === "") return [lineBegin, tail.next];
  return [lineBegin + before.trimEnd().length, tail.lineEnd];
}

/** An identifier or a keyword (contextual keywords such as `from`, `type` or `of` are valid names). */
function isNameToken(tok: ts.SyntaxKind): boolean {
  return tok === ts.SyntaxKind.Identifier || (tok >= ts.SyntaxKind.FirstKeyword && tok <= ts.SyntaxKind.LastKeyword);
}

const DECLARATION_KEYWORDS = new Set([ts.SyntaxKind.ConstKeyword, ts.SyntaxKind.LetKeyword, ts.SyntaxKind.VarKeyword]);

/** What may follow `import` in an import declaration: `{`, `*`, a default binding, `type`, or a module string. */
function startsImport(next: ts.SyntaxKind): boolean {
  return next === ts.SyntaxKind.OpenBraceToken || next === ts.SyntaxKind.AsteriskToken || next === ts.SyntaxKind.StringLiteral || isNameToken(next);
}

/** What may follow `export` in an export declaration: `{`, `*`, `=`, or a keyword/name (`const`, `default`, `function`, …). */
function startsExport(next: ts.SyntaxKind): boolean {
  return next === ts.SyntaxKind.OpenBraceToken || next === ts.SyntaxKind.AsteriskToken || next === ts.SyntaxKind.EqualsToken || isNameToken(next);
}

/**
 * Statements that start on a later line inside `stmt`'s span: after a syntax error the parser's
 * recovery can make one statement run on over the following ones (e.g. a missing `)`), and a
 * patch over that span would silently replace or delete them too. Returns their names.
 *
 * A keyword at the start of a line counts only when the next token makes it a statement: `const: …`,
 * `import: …` or `export: …` inside a sketch is an object key (a curve id), not a statement.
 */
function swallowedStatements(text: string, stmt: SourceStatement): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, true, ts.LanguageVariant.Standard, text.slice(stmt.start, stmt.end));
  const out: string[] = [];
  let first = true;
  for (let tok = scanner.scan(); tok !== ts.SyntaxKind.EndOfFileToken; tok = scanner.scan()) {
    const startsLine = !first && scanner.hasPrecedingLineBreak();
    first = false;
    if (!startsLine) continue;
    if (DECLARATION_KEYWORDS.has(tok)) {
      const next = scanner.scan();
      // `const name …` (the name may be a contextual keyword such as `from` or `type`), `const {…}`, `const […]`.
      if (isNameToken(next)) out.push(scanner.getTokenText());
      else if (next === ts.SyntaxKind.OpenBraceToken || next === ts.SyntaxKind.OpenBracketToken) out.push(`${ts.tokenToString(tok)} ${scanner.getTokenText()}…`);
    } else if (tok === ts.SyntaxKind.ImportKeyword) {
      if (startsImport(scanner.scan())) out.push("import");
    } else if (tok === ts.SyntaxKind.ExportKeyword) {
      if (startsExport(scanner.scan())) out.push("export");
    } else if (tok === ts.SyntaxKind.Identifier && (scanner.getTokenValue() === "part" || scanner.getTokenValue() === "doc")) {
      const name = scanner.getTokenValue();
      if (scanner.scan() === ts.SyntaxKind.OpenParenToken) out.push(`${name}(…)`);
    }
  }
  return out;
}

interface CommentSpan {
  pos: number;
  end: number;
  text: string;
}

/** Every comment in `text`, lexically (works on files with syntax errors). */
function commentsOf(text: string): CommentSpan[] {
  const scanner = ts.createScanner(ts.ScriptTarget.ES2022, false, ts.LanguageVariant.Standard, text);
  const out: CommentSpan[] = [];
  for (let tok = scanner.scan(); tok !== ts.SyntaxKind.EndOfFileToken; tok = scanner.scan()) {
    if (tok === ts.SyntaxKind.SingleLineCommentTrivia || tok === ts.SyntaxKind.MultiLineCommentTrivia) {
      out.push({ pos: scanner.getTokenStart(), end: scanner.getTokenEnd(), text: scanner.getTokenText() });
    }
  }
  return out;
}

function countNames(names: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
  return m;
}

/** Refuse to patch a statement whose span the parser stretched over other statements. */
function assertBounded(text: string, located: LocatedSource, stmt: SourceStatement, role: string): void {
  if (located.syntaxErrors.length === 0) return;
  const swallowed = swallowedStatements(text, stmt);
  if (swallowed.length === 0) return;
  throw new PatchError(
    `cannot ${role} safely: the file has a syntax error (${located.syntaxErrors[0]}) and the statement of "${stmt.name ?? "?"}" (lines ${stmt.line}–${stmt.endLine}) runs on over ${swallowed.join(", ")}. ` +
      "Send the whole corrected file with `source` instead",
  );
}

/**
 * The statements a patch must keep: features by name, `part(…)` by part name, `doc(…)` and imports.
 * Unnamed statements are left out (parse recovery around a broken target can split it into pieces
 * that legitimately disappear when the target is fixed).
 */
function statementKeys(statements: readonly SourceStatement[]): string[] {
  return statements.flatMap((s) => {
    if (s.kind === "feature") return s.name === undefined ? [] : [s.name];
    if (s.kind === "part") return [`part(${JSON.stringify(s.name ?? "")})`];
    if (s.kind === "doc") return ["doc(…)"];
    if (s.kind === "import") return ["the import"];
    return [];
  });
}

function featureList(text: string): string {
  return featureConstNames(text).join(", ") || "none";
}

/**
 * Apply patches in order. Each patch sees the result of the previous one. Returns the new source
 * and one line per patch saying what happened.
 *
 * Safety: a patch touches only its own statement (plus the comments attached above it). It is
 * refused with a {@link PatchError} when the file has syntax errors and the target's statement
 * swallowed later statements, when the patched file lost any feature the patch did not target
 * (e.g. a replacement with unbalanced brackets that would swallow the rest of the file), and when
 * it lost a comment outside the range the patch replaces or deletes (comments are design intent).
 */
export function patchSource(source: string, patches: readonly SourcePatch[]): { source: string; notes: string[] } {
  let text = source;
  const notes: string[] = [];
  for (const p of patches) {
    const code = p.code.trim();
    const located = locateStatements(text);
    const before = countNames(statementKeys(located.statements));
    const target = located.statements.find((s) => s.kind === "feature" && s.name === p.feature);
    let next: string;
    /** The range of `text` the patch removes or replaces (its comments may go). */
    let removed: [number, number] = [0, 0];
    if (target) {
      if (p.after !== undefined) notes.push(`${p.feature}: "after" ignored (the feature exists; it is replaced in place)`);
      if (code === "") {
        assertBounded(text, located, target, `delete "${p.feature}"`);
        removed = deletionRange(text, target);
        next = text.slice(0, removed[0]) + text.slice(removed[1]);
        notes.push(`${p.feature}: deleted`);
      } else {
        assertBounded(text, located, target, `replace "${p.feature}"`);
        removed = [target.start, target.end];
        next = text.slice(0, target.start) + code + text.slice(target.end);
        notes.push(`${p.feature}: replaced (lines ${target.line}–${target.endLine})`);
      }
    } else {
      if (code === "") throw new PatchError(`cannot delete "${p.feature}": no such feature const (features: ${featureList(text)})`);
      if (p.after !== undefined) {
        const anchor = located.statements.find((s) => s.kind === "feature" && s.name === p.after);
        if (!anchor) throw new PatchError(`cannot insert "${p.feature}" after "${p.after}": no such feature const (features: ${featureList(text)})`);
        assertBounded(text, located, anchor, `insert "${p.feature}" after "${p.after}"`);
        const tail = trailingTrivia(text, anchor.end);
        if (tail.atEol) {
          const prefix = tail.next === text.length && !text.endsWith("\n") ? "\n" : "";
          next = text.slice(0, tail.next) + prefix + code + "\n" + text.slice(tail.next);
        } else {
          // Another statement shares the anchor's line: put the new one between them, on its own line.
          // Comments in between belong to the following statement and move with it.
          next = text.slice(0, anchor.end) + "\n" + code + "\n" + text.slice(skipSpaces(text, anchor.end));
        }
        notes.push(`${p.feature}: inserted after ${p.after}`);
      } else {
        const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
        next = `${text}${sep}${code}\n`;
        notes.push(`${p.feature}: appended at the end of the file`);
      }
    }
    // Nothing the patch did not target may disappear.
    const after = countNames(statementKeys(locateStatements(next).statements));
    const lost = [...before].flatMap(([key, n]) => {
      const allowed = key === p.feature && target ? 1 : 0;
      return (after.get(key) ?? 0) < n - allowed ? [key] : [];
    });
    if (lost.length > 0) {
      throw new PatchError(
        `the patch for "${p.feature}" would also remove ${lost.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? `"${k}"` : k)).join(", ")}, which it does not target. ` +
          "Its code is probably incomplete (unbalanced brackets or a missing `;`): send the complete statement",
      );
    }
    const kept = countNames(commentsOf(text).flatMap((c) => (c.pos >= removed[0] && c.end <= removed[1] ? [] : [c.text])));
    const now = countNames(commentsOf(next).map((c) => c.text));
    const lostComments = [...kept].flatMap(([c, n]) => ((now.get(c) ?? 0) < n ? [c] : []));
    if (lostComments.length > 0) {
      throw new PatchError(
        `the patch for "${p.feature}" would also remove the comment ${JSON.stringify(oneLineClip(lostComments[0]!))}, which it does not target. ` +
          "Its code is probably incomplete (an unclosed string, comment or bracket): send the complete statement",
      );
    }
    text = next;
  }
  return { source: text, notes };
}

function oneLineClip(s: string, max = 60): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Numbered source lines `[from, to]` (1-based, inclusive), for showing a feature with context. */
export function sourceLines(source: string, from: number, to: number): string {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(lines[i - 1]!);
  return out.join("\n");
}
