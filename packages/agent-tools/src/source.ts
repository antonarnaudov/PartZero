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

function endOfLine(source: string, pos: number): number {
  const nl = source.indexOf("\n", pos);
  return nl === -1 ? source.length : nl + 1;
}

/**
 * Apply patches in order. Each patch sees the result of the previous one. Returns the new source
 * and one line per patch saying what happened.
 */
export function patchSource(source: string, patches: readonly SourcePatch[]): { source: string; notes: string[] } {
  let text = source;
  const notes: string[] = [];
  for (const p of patches) {
    const code = p.code.trim();
    const target = findFeature(text, p.feature);
    if (target) {
      if (p.after !== undefined) notes.push(`${p.feature}: "after" ignored (the feature exists; it is replaced in place)`);
      if (code === "") {
        const end = endOfLine(text, target.end);
        const lineStart = text.lastIndexOf("\n", target.attachedStart - 1) + 1;
        const from = text.slice(lineStart, target.attachedStart).trim() === "" ? lineStart : target.attachedStart;
        text = text.slice(0, from) + text.slice(end);
        notes.push(`${p.feature}: deleted`);
      } else {
        text = text.slice(0, target.start) + code + text.slice(target.end);
        notes.push(`${p.feature}: replaced (lines ${target.line}–${target.endLine})`);
      }
      continue;
    }
    if (code === "") throw new PatchError(`cannot delete "${p.feature}": no such feature const (features: ${featureConstNames(text).join(", ") || "none"})`);
    if (p.after !== undefined) {
      const anchor = findFeature(text, p.after);
      if (!anchor) throw new PatchError(`cannot insert "${p.feature}" after "${p.after}": no such feature const (features: ${featureConstNames(text).join(", ") || "none"})`);
      const at = endOfLine(text, anchor.end);
      const prefix = at === text.length && !text.endsWith("\n") ? "\n" : "";
      text = text.slice(0, at) + prefix + code + "\n" + text.slice(at);
      notes.push(`${p.feature}: inserted after ${p.after}`);
    } else {
      const sep = text.length === 0 || text.endsWith("\n") ? "" : "\n";
      text = `${text}${sep}${code}\n`;
      notes.push(`${p.feature}: appended at the end of the file`);
    }
  }
  return { source: text, notes };
}

/** Numbered source lines `[from, to]` (1-based, inclusive), for showing a feature with context. */
export function sourceLines(source: string, from: number, to: number): string {
  const lines = source.split("\n");
  const out: string[] = [];
  for (let i = Math.max(1, from); i <= Math.min(lines.length, to); i++) out.push(lines[i - 1]!);
  return out.join("\n");
}
