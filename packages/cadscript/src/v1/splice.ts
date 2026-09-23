/**
 * Edit splicing for CadScript v1: apply an IR-level edit (old IR → new IR) to source without
 * re-printing the whole file. Statements (doc, parameters, parts, features) are matched by key —
 * `param:<name>`, `part:<id>`, `feat:<part id>:<feature id>` — and compared by their canonical
 * text; only changed statements are re-printed into their spans. Untouched statements keep their
 * exact text, formatting and comments; added ones go after their nearest kept predecessor,
 * removed ones leave with their attached comments, moved ones carry text and comments along.
 * Imports gain the builtins the new statements need.
 *
 * Renames: a kept statement whose only change is renamed features (`renameFeature`) keeps its
 * text, with the names rewritten in place — the renamed feature's own `const` too.
 *
 * Query aliases (`const top = slab.cap("end")`, SPEC-v1 §5.11) add nothing to the IR, so the
 * edit does not mention them; the splicer keeps them consistent with the statements around them:
 * - an alias whose names are renamed is rewritten in place;
 * - an alias that names a feature or parameter the edit deletes or moves, or whose own name the
 *   new IR gives to a feature or parameter, is **stale**: it is deleted and every kept statement
 *   that uses it is re-printed (the printer writes queries inline);
 * - a kept statement that used an alias and is re-printed (a field changed) gets the alias back
 *   where its query appears verbatim in the print (`substituteAliases`);
 * - an alias that was used and is no longer used (its users were deleted, or re-printed without
 *   it) is deleted; an alias the source never used stays, unless stale.
 *
 * Postcondition: when the source has no errors but its IR's, the result compiles, with
 * `{ base: newIr }`, to `newIr` (canonicalized) with no error the canonical print of `newIr` does
 * not have; it is checked on every splice. If it fails, the splice is redone without writing
 * aliases back, then with every alias inlined; if that fails too, `CadScriptV1EditError` is
 * thrown (never silently wrong source).
 */
import ts from "typescript";
import type { IrDocument as V0Document } from "@aicad/ir-types";
import type { v1 } from "@aicad/ir-types";
import { attachedCommentStart, endOfStatementLine, lineStart, onlyWhitespaceBefore } from "../trivia.js";
import { analyzeV1, type AnalysisV1 } from "./compile.js";
import type { DiagnosticV1 } from "./context.js";
import { CadScriptV1PrintError, printedV1, printElementsV1, printImportV1, Printer, printV1, type PrintedV1 } from "./print.js";
import { STD_MODULE_V1 } from "./std-module.js";

/** Thrown when the source cannot be edited structurally (syntax errors, too deep nesting, features outside a part), or the splice would not compile to the new IR. */
export class CadScriptV1EditError extends Error {
  readonly diagnostics: readonly DiagnosticV1[];
  constructor(message: string, diagnostics: DiagnosticV1[]) {
    super(message);
    this.name = "CadScriptV1EditError";
    this.diagnostics = diagnostics;
  }
}

type Kind = "doc" | "param" | "part" | "feature";

interface OldElem {
  key: string;
  kind: Kind;
  stmt: ts.Statement;
  content: string | undefined;
  /** The const it declares (features and parameters). */
  name?: string;
}

interface NewElem {
  key: string;
  kind: Kind;
  content: string;
}

interface Alias {
  name: string;
  stmt: ts.VariableStatement;
  init: ts.Expression;
  /** Const names its query uses. */
  deps: Set<string>;
}

interface Edit {
  start: number;
  end: number;
  text: string;
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

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
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
 * The identifiers of `node` that name a const — not property names, object keys or import
 * specifiers. With `decl`, the name a `const` declares is included. `shorthand` is set when one
 * of them is a shorthand property (`{ r }`: renaming it would change the key).
 */
function constNames(node: ts.Node, decl: boolean): { ids: ts.Identifier[]; shorthand: Set<string> } {
  const ids: ts.Identifier[] = [];
  const shorthand = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      if (p && ts.isPropertyAccessExpression(p) && p.name === n) return;
      if (p && (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p)) && p.name === n) return;
      if (p && (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p))) return;
      if (p && ts.isVariableDeclaration(p) && p.name === n && !decl) return;
      if (p && ts.isShorthandPropertyAssignment(p)) shorthand.add(n.text);
      ids.push(n);
      return;
    }
    if (ts.isTypeNode(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return { ids, shorthand };
}

/** `text` (statements) with the const names of `renames` rewritten, or undefined when it does not parse or a renamed name is a shorthand property. */
function renamedText(text: string, renames: ReadonlyMap<string, string>): string | undefined {
  const sf = ts.createSourceFile("statement.cad.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0) return undefined;
  const edits = renameEdits(sf, sf, renames);
  return edits ? applyEdits(text, edits) : undefined;
}

/** Edits that rewrite the renamed const names of `node` (undefined when one is a shorthand property). */
function renameEdits(sf: ts.SourceFile, node: ts.Node, renames: ReadonlyMap<string, string>): Edit[] | undefined {
  const { ids, shorthand } = constNames(node, true);
  if ([...shorthand].some((n) => renames.has(n))) return undefined;
  return ids.filter((id) => renames.has(id.text)).map((id) => ({ start: id.getStart(sf), end: id.end, text: renames.get(id.text)! }));
}

/**
 * Apply the difference between `oldIr` and `newIr` to `source` (which should compile to
 * `oldIr`). The result compiles, with `{ base: newIr }`, to `newIr` (canonicalized): checked
 * whenever the only errors of `source` are its IR's.
 *
 * @throws {CadScriptV1EditError} if the source has syntax errors, is nested too deeply or has
 *   features outside any part, or if no splice compiles to `newIr` (the diagnostics say why).
 * @throws {CadScriptV1PrintError} if `newIr` cannot be written as CadScript v1.
 */
export function applyIrEditV1(source: string, oldIr: v1.IrDocument | V0Document, newIr: v1.IrDocument | V0Document): string {
  return applyIrEditCheckedV1(source, oldIr, newIr).source;
}

/** The result of {@link applyIrEditCheckedV1}. */
export interface SpliceResultV1 {
  /** The edited source. */
  source: string;
  /**
   * Whether the postcondition was checked: `source` compiles, with `{ base: newIr }`, to `newIr`.
   * `false` only when the input source has errors of its own code (a front-end `CS_*` error with
   * no IR path, e.g. an unknown builtin or an unused alias that does not compile): then there is
   * no IR to compare with, the splice is best effort, and the result still has those errors (so
   * it never compiles cleanly into a wrong document). Callers that need a verified edit re-print.
   */
  verified: boolean;
}

/**
 * {@link applyIrEditV1}, saying whether the result was verified against `newIr`.
 *
 * @throws as {@link applyIrEditV1}.
 */
export function applyIrEditCheckedV1(source: string, oldIr: v1.IrDocument | V0Document, newIr: v1.IrDocument | V0Document): SpliceResultV1 {
  const printed = printedV1(newIr);
  if (printed.problems.length > 0 || !printed.doc) throw new CadScriptV1PrintError(printed.problems);
  const a = analyzeV1(source, { base: oldIr });
  if (a.hasSyntaxErrors || !a.sf) {
    const tooComplex = a.result.diagnostics.some((d) => d.code === "CS_TOO_COMPLEX");
    throw new CadScriptV1EditError(tooComplex ? "cannot splice an edit into source that is nested too deeply" : "cannot splice an edit into source with syntax errors", a.result.diagnostics);
  }
  const orphan = a.result.diagnostics.filter((d) => d.code === "CS_MISSING_PART");
  if (orphan.length > 0) throw new CadScriptV1EditError("cannot splice an edit into source with features outside a part", orphan);

  const out = splice(a, printed, "substitute");
  // Source with errors of its own code (front-end errors, a broken alias: no IR path) has no IR
  // to compare with: the splice is best effort there. Errors of its IR (an invalid document) are fine.
  if (a.result.diagnostics.some((d) => d.severity === "error" && d.irPath === undefined)) return { source: out, verified: false };
  const target = printed.doc;
  const first = compilesTo(out, newIr, target);
  if (first === true) return { source: out, verified: true };
  for (const mode of ["plain", "inline"] as const) {
    const retry = splice(a, printed, mode);
    if (compilesTo(retry, newIr, target) === true) return { source: retry, verified: true };
  }
  throw new CadScriptV1EditError("the edit cannot be spliced into this source: the result does not compile to the new IR", first);
}

/**
 * How aliases are treated: `substitute` writes a used alias back into the re-printed statements
 * that used it (where its query appears verbatim), `plain` re-prints them with the queries inline,
 * `inline` treats every alias as stale (the last resort before giving up).
 */
type SpliceMode = "substitute" | "plain" | "inline";

/** `content` (a printed statement) with the queries of `aliases` written as their names; the names used. */
function substituteAliases(content: string, aliases: readonly { name: string; texts: readonly string[] }[]): { text: string; used: Set<string> } {
  const used = new Set<string>();
  if (aliases.length === 0) return { text: content, used };
  const sf = ts.createSourceFile("statement.cad.ts", content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const t = n.getText(sf);
      const hit = aliases.find((x) => x.texts.includes(t));
      if (hit) {
        edits.push({ start: n.getStart(sf), end: n.end, text: hit.name });
        used.add(hit.name);
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { text: applyEdits(content, edits), used };
}

/**
 * Whether `source` compiles, with `base`, to `target` — the lowered document, so that an edit to
 * an invalid document splices too — with no diagnostic the canonical print of `target` does not
 * have (e.g. an unused alias that no longer compiles); otherwise the reasons.
 */
function compilesTo(source: string, base: v1.IrDocument | V0Document, target: v1.IrDocument): true | DiagnosticV1[] {
  const r = analyzeV1(source, { base });
  const errors = r.result.diagnostics.filter((d) => d.severity === "error");
  if (!r.hasSyntaxErrors && sameJson(r.doc, target)) {
    if (errors.length === 0) return true;
    if (!errors.some((d) => d.code.startsWith("CS_"))) {
      // The target's own (IR) errors are expected: compare with its canonical print's.
      const expected = new Map<string, number>();
      for (const d of analyzeV1(printV1(target), { base }).result.diagnostics) {
        if (d.severity === "error") expected.set(`${d.code} ${d.message}`, (expected.get(`${d.code} ${d.message}`) ?? 0) + 1);
      }
      const extra = errors.filter((d) => {
        const k = `${d.code} ${d.message}`;
        const n = expected.get(k) ?? 0;
        expected.set(k, n - 1);
        return n <= 0;
      });
      if (extra.length === 0) return true;
      return extra;
    }
  }
  if (r.hasSyntaxErrors || errors.length > 0) return r.result.diagnostics;
  return [
    {
      code: "CS_BAD_ARGUMENT",
      severity: "error",
      message: "internal: the spliced source compiles to a document other than the new IR",
      span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
    },
  ];
}

/** Structural equality of JSON-like values (`-0` ≠ `0`, undefined properties are absent). */
function sameJson(x: unknown, y: unknown): boolean {
  if (typeof x !== "object" || x === null || typeof y !== "object" || y === null) return Object.is(x, y);
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  if (Array.isArray(x)) return x.length === (y as unknown[]).length && x.every((v, i) => sameJson(v, (y as unknown[])[i]));
  const kx = Object.keys(x).filter((k) => (x as Record<string, unknown>)[k] !== undefined);
  const ky = Object.keys(y).filter((k) => (y as Record<string, unknown>)[k] !== undefined);
  if (kx.length !== ky.length) return false;
  return kx.every((k) => Object.prototype.hasOwnProperty.call(y, k) && sameJson((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]));
}

/** One splice of `printed` (the new IR) into the analysed source. */
function splice(a: AnalysisV1, printed: PrintedV1 & { doc: v1.IrDocument | undefined }, mode: SpliceMode): string {
  const sf = a.sf!;
  const text = sf.text;

  // ── The old (source) and new (IR) statement sequences ──
  const current = printElementsV1(a.doc);
  const currentByKey = new Map(current.elements.map((e) => [e.key, e.text]));
  const oldElems: OldElem[] = [];
  const aliases: Alias[] = [];
  let docTaken = false;
  for (const s of a.statements) {
    if (s.kind === "doc" && !docTaken) {
      docTaken = true;
      oldElems.push({ key: "doc", kind: "doc", stmt: s.node, content: currentByKey.get("doc") ?? "" });
    } else if (s.kind === "part") {
      const part = a.doc.parts[s.partIndex]!;
      const key = `part:${part.id}`;
      oldElems.push({ key, kind: "part", stmt: s.node, content: currentByKey.get(key) });
    } else if (s.kind === "feature") {
      const part = a.doc.parts[s.partIndex]!;
      const f = part.features[s.index]!;
      const key = `feat:${part.id}:${f.id}`;
      oldElems.push({ key, kind: "feature", stmt: s.node, content: currentByKey.get(key) || undefined, name: f.name });
    } else if (s.kind === "param") {
      const p = s.partIndex < 0 ? a.doc.params?.[s.index] : a.doc.parts[s.partIndex]?.params?.[s.index];
      if (!p) continue;
      const key = `param:${p.name}`;
      oldElems.push({ key, kind: "param", stmt: s.node, content: currentByKey.get(key) || undefined, name: p.name });
    } else if (s.kind === "query" && ts.isVariableStatement(s.node)) {
      const d = s.node.declarationList.declarations[0];
      if (!d || !ts.isIdentifier(d.name) || !d.initializer) continue;
      aliases.push({ name: d.name.text, stmt: s.node, init: d.initializer, deps: new Set(constNames(d.initializer, false).ids.map((id) => id.text)) });
    }
  }
  const newElems: NewElem[] = printed.elements.map((e) => ({ key: e.key, kind: e.kind, content: e.text }));
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

  // ── Names: renames of kept features, and what the new IR declares ──
  const newNames = new Set<string>();
  const newNameByKey = new Map<string, string>();
  if (printed.doc) {
    for (const p of printed.doc.params ?? []) newNames.add(p.name);
    for (const part of printed.doc.parts) {
      for (const p of part.params ?? []) newNames.add(p.name);
      for (const f of part.features) {
        newNames.add(f.name);
        newNameByKey.set(`feat:${part.id}:${f.id}`, f.name);
      }
    }
  }
  const renames = new Map<string, string>();
  const keptNames = new Set<string>(); // old consts whose statement stays in place
  oldElems.forEach((o, i) => {
    if (!o.name || !keptOld.has(i)) return;
    keptNames.add(o.name);
    const to = o.kind === "feature" ? newNameByKey.get(newElems[keptOld.get(i)!]!.key.replace(/#\d+$/, "")) : o.name;
    if (to !== undefined && to !== o.name) renames.set(o.name, to);
  });
  const oldNames = new Set(oldElems.flatMap((o) => (o.name ? [o.name] : [])));

  // ── Aliases: stale ones are deleted and their users re-printed ──
  const aliasByName = new Map(aliases.map((x) => [x.name, x]));
  const stale = new Set<Alias>();
  if (mode === "inline") aliases.forEach((x) => stale.add(x));
  for (let changed = true; changed; ) {
    changed = false;
    for (const x of aliases) {
      if (stale.has(x)) continue;
      const bad =
        newNames.has(x.name) ||
        [...x.deps].some((d) => {
          const dep = aliasByName.get(d);
          if (dep) return dep === x || stale.has(dep);
          return oldNames.has(d) && !keptNames.has(d); // a feature or parameter deleted or moved
        });
      if (bad) {
        stale.add(x);
        changed = true;
      }
    }
  }
  const usesOf = (node: ts.Node): Set<string> => new Set(constNames(node, false).ids.map((id) => id.text).filter((n) => aliasByName.has(n)));
  const usesStale = (node: ts.Node): boolean => [...usesOf(node)].some((n) => stale.has(aliasByName.get(n)!));

  // The query of each alias as the printer writes it with the new names (full reference, and
  // without its count), to write aliases back into re-printed statements.
  const aliasTexts = new Map<string, string[]>();
  if (mode === "substitute" && printed.doc && a.aliasRefs) {
    const pr = new Printer(printed.doc);
    for (const [name, ref] of a.aliasRefs) {
      const x = aliasByName.get(name);
      if (!x || stale.has(x)) continue;
      try {
        aliasTexts.set(name, [...new Set([pr.ref(ref), pr.query(ref.q)])]);
      } catch {
        // (a query over a feature the new IR lacks: the alias is stale anyway)
      }
    }
  }
  const substitutedUses = new Set<string>();

  // ── Kept statements: unchanged, renamed in place, or re-printed ──
  const keepsText: ts.Statement[] = []; // statements whose (possibly renamed) text stays
  for (const [i, j] of pairs) {
    const o = oldElems[i]!;
    const n = newElems[j]!;
    const replace = (): void => {
      const mine = [...usesOf(o.stmt)].flatMap((name) => (aliasTexts.has(name) ? [{ name, texts: aliasTexts.get(name)! }] : []));
      const { text: body, used } = substituteAliases(n.content, mine);
      for (const u of used) substitutedUses.add(u);
      edits.push({ start: o.stmt.getStart(sf), end: o.stmt.end, text: body });
    };
    if (o.content === n.content) {
      if (usesStale(o.stmt)) replace();
      else keepsText.push(o.stmt);
      continue;
    }
    if (renames.size > 0 && o.content !== undefined && !usesStale(o.stmt) && renamedText(o.content, renames) === n.content) {
      const inPlace = renameEdits(sf, o.stmt, renames);
      if (inPlace) {
        edits.push(...inPlace);
        keepsText.push(o.stmt);
        continue;
      }
    }
    replace();
  }
  oldElems.forEach((o, i) => {
    if (!keptOld.has(i)) edits.push(deletionRange(sf, o.stmt, o.kind));
  });

  // ── Aliases: kept (renamed in place) or deleted ──
  const usedBefore = new Set<string>();
  for (const s of a.statements) if (s.kind === "feature" || s.kind === "param" || s.kind === "query") for (const u of usesOf(s.node)) usedBefore.add(u);
  const usedAfter = new Set<string>(substitutedUses);
  for (const st of keepsText) for (const u of usesOf(st)) usedAfter.add(u);
  const keep = (x: Alias): boolean => !stale.has(x) && (usedAfter.has(x.name) || !usedBefore.has(x.name));
  for (let changed = true; changed; ) {
    changed = false;
    for (const x of aliases) {
      if (!keep(x)) continue;
      for (const d of x.deps) {
        if (aliasByName.has(d) && d !== x.name && !usedAfter.has(d)) {
          usedAfter.add(d);
          changed = true;
        }
      }
    }
  }
  for (const x of aliases) {
    if (!keep(x)) {
      edits.push(deletionRange(sf, x.stmt, "feature"));
      continue;
    }
    const inPlace = renames.size > 0 ? renameEdits(sf, x.init, renames) : [];
    if (inPlace) edits.push(...inPlace);
    else edits.push(deletionRange(sf, x.stmt, "feature")); // (a renamed shorthand: cannot be kept)
  }

  // ── Insertions (new and moved statements) ──
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const lastImport = imports[imports.length - 1];
  let anchor = lastImport ? endOfStatementLine(text, lastImport.end) : 0;
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
      // (A moved statement that uses an alias is re-printed: the alias may now come after it.)
      const carry = moved.content === n.content && usesOf(moved.stmt).size === 0;
      body = comments + (carry ? text.slice(moved.stmt.getStart(sf), moved.stmt.end) : n.content);
    } else body = n.content;
    let chunk: string;
    if (n.kind === "feature" || n.kind === "param") chunk = `${body}\n`;
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

  const importEdit = importUpdate(sf, printed.used);
  if (importEdit) edits.push(importEdit);
  return applyEdits(text, edits);
}

function deletionRange(sf: ts.SourceFile, stmt: ts.Statement, kind: Kind): Edit {
  const text = sf.text;
  let start = attachedCommentStart(sf, stmt);
  const end = endOfStatementLine(text, stmt.end);
  if (onlyWhitespaceBefore(text, start) && (end === text.length || text[end - 1] === "\n")) {
    start = lineStart(text, start);
    if (kind !== "feature" && kind !== "param" && start > 0) {
      const prev = lineStart(text, start - 1);
      if (!/\S/.test(text.slice(prev, start))) start = prev;
    }
  } else start = stmt.getStart(sf);
  return { start, end: Math.max(end, stmt.end), text: "" };
}

function importUpdate(sf: ts.SourceFile, used: ReadonlySet<string>): Edit | undefined {
  const have = new Set<string>();
  let target: ts.ImportDeclaration | undefined;
  for (const s of sf.statements) {
    if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier) || s.moduleSpecifier.text !== STD_MODULE_V1) continue;
    const b = s.importClause?.namedBindings;
    if (!b || !ts.isNamedImports(b)) continue;
    target ??= s;
    for (const el of b.elements) if (!el.propertyName) have.add(el.name.text);
  }
  const missing = [...used].filter((n) => !have.has(n));
  if (missing.length === 0) return undefined;
  if (!target) return { start: 0, end: 0, text: `${printImportV1(used)}\n\n` };
  return { start: target.getStart(sf), end: target.end, text: printImportV1([...have, ...missing]) };
}

function applyEdits(text: string, edits: Edit[]): string {
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
