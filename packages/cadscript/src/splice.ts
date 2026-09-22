/**
 * Edit splicing: apply an IR-level edit (old IR → new IR) to CadScript source *without*
 * re-printing the whole file. Only statements whose content changed are re-printed; they are
 * spliced into their original spans. Untouched statements keep their exact text, formatting and
 * comments. Added features/parts are inserted after their predecessor, removed ones are deleted
 * (with the comments attached above them), moved ones carry their text and comments along.
 */
import ts from "typescript";
import type { IrDocument } from "@aicad/ir-types";
import { analyze } from "./compile.js";
import type { Diagnostic } from "./diagnostics.js";
import {
  CadScriptPrintError,
  printabilityProblems,
  printDocStatement,
  printFeatureStatement,
  printImport,
  printPartStatement,
  usedBuiltins,
} from "./print.js";
import { STD_MODULE } from "./syntax.js";
import { attachedCommentStart, endOfStatementLine, lineStart, onlyWhitespaceBefore } from "./trivia.js";

/** Thrown when the source cannot be edited structurally (syntax errors, features outside a part). */
export class CadScriptEditError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = "CadScriptEditError";
    this.diagnostics = diagnostics;
  }
}

interface OldElem {
  key: string;
  kind: "doc" | "part" | "feature";
  stmt: ts.Statement;
  /** Canonical text of what the statement compiles to (undefined when it failed to lower). */
  content: string | undefined;
}

interface NewElem {
  key: string;
  kind: "doc" | "part" | "feature";
  content: string;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

function tryPrint(f: () => string | undefined): string | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function uniqueKeys<T extends { key: string }>(items: T[]): T[] {
  const seen = new Map<string, number>();
  for (const it of items) {
    const n = seen.get(it.key) ?? 0;
    seen.set(it.key, n + 1);
    if (n > 0) it.key = `${it.key}#${n}`;
  }
  return items;
}

/** Longest common subsequence of keys; returns matched index pairs in order. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/**
 * Apply the difference between `oldIr` and `newIr` to `source` (which should compile to `oldIr`).
 *
 * Statements are identified by compiling `source` against `oldIr` (so ids line up), and compared
 * with `newIr` by their canonical text. The result compiles, with `{ base: newIr }`, to `newIr`.
 *
 * @throws {CadScriptEditError} if the source has syntax errors or features outside any part.
 * @throws {CadScriptPrintError} if `newIr` cannot be written as CadScript.
 */
export function applyIrEdit(source: string, oldIr: IrDocument, newIr: IrDocument): string {
  const problems = printabilityProblems(newIr);
  if (problems.length > 0) throw new CadScriptPrintError(problems);
  const a = analyze(source, { base: oldIr });
  if (a.hasSyntaxErrors) throw new CadScriptEditError("cannot splice an edit into source with syntax errors", a.result.diagnostics);
  const orphan = a.result.diagnostics.filter((d) => d.code === "CS_MISSING_PART");
  if (orphan.length > 0) throw new CadScriptEditError("cannot splice an edit into source with features outside a part", orphan);

  const { sf } = a;
  const text = sf.text;

  // ── The old (source) and new (IR) statement sequences ──
  const oldElems: OldElem[] = [];
  let docTaken = false;
  for (const s of a.statements) {
    if (s.kind === "doc" && !docTaken) {
      docTaken = true;
      oldElems.push({ key: "doc", kind: "doc", stmt: s.node, content: printDocStatement(a.doc.meta) ?? "" });
    } else if (s.kind === "part") {
      const part = a.doc.parts[s.partIndex]!;
      oldElems.push({ key: `part:${part.id}`, kind: "part", stmt: s.node, content: printPartStatement(part) });
    } else if (s.kind === "feature") {
      const part = a.doc.parts[s.partIndex]!;
      const f = part.features[s.featureIndex]!;
      oldElems.push({ key: `feat:${part.id}:${f.id}`, kind: "feature", stmt: s.node, content: tryPrint(() => printFeatureStatement(f)) });
    }
  }
  const newElems: NewElem[] = [];
  const docStmt = printDocStatement(newIr.meta);
  if (docStmt !== undefined) newElems.push({ key: "doc", kind: "doc", content: docStmt });
  for (const part of newIr.parts) {
    newElems.push({ key: `part:${part.id}`, kind: "part", content: printPartStatement(part) });
    for (const f of part.features) newElems.push({ key: `feat:${part.id}:${f.id}`, kind: "feature", content: printFeatureStatement(f) });
  }
  uniqueKeys(oldElems);
  uniqueKeys(newElems);

  const pairs = lcs(
    oldElems.map((e) => e.key),
    newElems.map((e) => e.key),
  );
  const keptOld = new Map<number, number>(pairs.map(([i, j]) => [i, j]));
  const keptNew = new Map<number, number>(pairs.map(([i, j]) => [j, i]));
  const oldByKey = new Map(oldElems.map((e) => [e.key, e]));
  const edits: Edit[] = [];

  // ── Kept statements: re-print in place only when their content changed ──
  for (const [i, j] of pairs) {
    const o = oldElems[i]!;
    const n = newElems[j]!;
    if (o.content !== n.content) edits.push({ start: o.stmt.getStart(sf), end: o.stmt.end, text: n.content });
  }

  // ── Removed (or moved away) statements ──
  oldElems.forEach((o, i) => {
    if (keptOld.has(i)) return;
    edits.push(deletionRange(sf, o));
  });

  // ── Added (or moved here) statements, after their nearest kept predecessor ──
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const lastImport = imports[imports.length - 1];
  const afterImports = lastImport ? endOfStatementLine(text, lastImport.end) : 0;
  let anchor = afterImports;
  let anchorIsTop = true;
  const inserts = new Map<number, string[]>();
  newElems.forEach((n, j) => {
    const i = keptNew.get(j);
    if (i !== undefined) {
      anchor = endOfStatementLine(text, oldElems[i]!.stmt.end);
      anchorIsTop = false;
      return;
    }
    const moved = oldByKey.get(n.key);
    let body: string;
    if (moved) {
      const commentStart = attachedCommentStart(sf, moved.stmt);
      const comments = text.slice(commentStart, moved.stmt.getStart(sf));
      body = comments + (moved.content === n.content ? text.slice(moved.stmt.getStart(sf), moved.stmt.end) : n.content);
    } else {
      body = n.content;
    }
    let chunk: string;
    if (n.kind === "feature") chunk = `${body}\n`;
    else if (anchorIsTop && !lastImport) chunk = `${body}\n\n`;
    else chunk = `\n${body}\n`;
    const list = inserts.get(anchor) ?? [];
    list.push(chunk);
    inserts.set(anchor, list);
  });
  for (const [pos, chunks] of inserts) {
    let t = chunks.join("");
    if (pos === text.length && text.length > 0 && !text.endsWith("\n")) t = `\n${t}`;
    edits.push({ start: pos, end: pos, text: t });
  }

  // ── Imports: add builtins the new statements need ──
  const importEdit = importUpdate(sf, newIr);
  if (importEdit) edits.push(importEdit);

  return applyEdits(text, edits);
}

function deletionRange(sf: ts.SourceFile, o: OldElem): Edit {
  const text = sf.text;
  let start = attachedCommentStart(sf, o.stmt);
  const end = endOfStatementLine(text, o.stmt.end);
  if (onlyWhitespaceBefore(text, start) && (end === text.length || text[end - 1] === "\n")) {
    start = lineStart(text, start);
    // A part()/doc() statement is preceded by a blank separator line: take it along.
    if (o.kind !== "feature" && start > 0) {
      const prev = lineStart(text, start - 1);
      if (!/\S/.test(text.slice(prev, start))) start = prev;
    }
  } else {
    start = o.stmt.getStart(sf);
  }
  return { start, end: Math.max(end, o.stmt.end), text: "" };
}

function importUpdate(sf: ts.SourceFile, newIr: IrDocument): Edit | undefined {
  const needed = usedBuiltins(newIr);
  const have = new Set<string>();
  let target: ts.ImportDeclaration | undefined;
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== STD_MODULE) continue;
    const b = s.importClause?.namedBindings;
    if (!b || !ts.isNamedImports(b)) continue;
    target ??= s;
    for (const el of b.elements) if (!el.propertyName) have.add(el.name.text);
  }
  const missing = [...needed].filter((n) => !have.has(n));
  if (missing.length === 0) return undefined;
  if (!target) return { start: 0, end: 0, text: `${printImport()}\n\n` };
  const names = new Set<string>();
  const b = target.importClause!.namedBindings as ts.NamedImports;
  for (const el of b.elements) if (!el.propertyName) names.add(el.name.text);
  for (const m of missing) names.add(m);
  return { start: target.getStart(sf), end: target.end, text: printImport(names) };
}

function applyEdits(text: string, edits: Edit[]): string {
  // Stable: by start; at equal starts insertions (empty ranges) come before replacements/deletions.
  const sorted = edits
    .map((e, i) => ({ ...e, i }))
    .sort((x, y) => x.start - y.start || (x.end === x.start ? 0 : 1) - (y.end === y.start ? 0 : 1) || x.i - y.i);
  let out = "";
  let cursor = 0;
  for (const e of sorted) {
    if (e.start < cursor) throw new Error(`internal error: overlapping edits at ${e.start}`);
    out += text.slice(cursor, e.start) + e.text;
    cursor = e.end;
  }
  return out + text.slice(cursor);
}
