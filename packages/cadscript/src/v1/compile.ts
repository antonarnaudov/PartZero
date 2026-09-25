/**
 * The CadScript v1 compiler: source text → IR v1 (`aicad.ir/1`), SPEC-v1 §2.9, §4, §5.10, §6.
 *
 * The source is parsed with the TypeScript compiler API and lowered statement by statement; it is
 * never executed. Expressions become canonical IR expression strings, method chains become typed
 * queries, `param()` consts become document or part parameters. The assembled document is
 * canonicalized (§0.4) and checked with the TypeScript mirror of IR v1 validation
 * (`validate.ts`); every problem is a diagnostic at the span of the code that produced it —
 * sub-expressions for unit and type errors, the handle for a query's feature, the string for a
 * curve id.
 *
 * v0 sources are CadScript v1 too: they compile to their v1 migration (the IR equals
 * `migrate_v0_to_v1` of the v0 compile, SPEC-v1 §9.1 "the CadScript compiler always emits v1").
 *
 * Identity: part and feature ids come from `base` by name (`identity.ts`); curve, constraint and
 * hole-position ids are the object keys; parameters are named by their consts. A reference whose
 * query is unchanged since `base` keeps its capture (§5.6), and a parameter list with exactly the
 * base's parameters keeps the base's order (IR v1 may order parameters by dependency, §2.8). A
 * malformed `base` is ignored with `CS_BAD_BASE`.
 *
 * Query consts (`const topFace = slab.faces().planes().max("+Z").one()`, SPEC-v1 §5.11) are
 * aliases: they add nothing to the IR, and each use lowers the query in place (so the printer
 * writes it inline). An unused alias is checked at its declaration, as the target of a tag
 * there would be (the same front-end and static query checks, at the alias's code); `tag()`
 * names a reference in the IR.
 *
 * Limits: the parse uses CadScript v1's nesting limits (`LIMITS_V1`), which admit every
 * expression IR v1 accepts, printed.
 */
import ts from "typescript";
import { parseIrDocument as parseV0Document, v1, type IrDocument as V0Document } from "@aicad/ir-types";
import { isStackOverflow, LIMITS_V1, parseWithinLimits, stackOverflowProblem, tooComplexDiagnostic } from "../complexity.js";
import { compareSpans, type Span } from "../diagnostics.js";
import { assignIds, type IdentityInput } from "../identity.js";
import { closest } from "../syntax.js";
import { attachedComments } from "../trivia.js";
import {
  callArgs,
  calleeName,
  Ctx,
  mismatch,
  newSink,
  readLiteralBool,
  readLiteralInt,
  readObject,
  readString,
  readStringArray,
  shownText,
  type DiagnosticV1,
  type FixEdit,
  type NameEntry,
  type ParamUnitName,
  type Props,
  type Sink,
} from "./context.js";
import { hintFor, hintForError } from "./diagnostics.js";
import { checkAtField, typeOf, type Expr, type TypeEnv } from "./expr.js";
import { canonicalDocument, jsonNesting, MAX_JSON_NESTING } from "./json.js";
import { lowerBoolScalar, lowerExpr, lowerScalar, scalarOf } from "./lower-expr.js";
import { lowerAxis, lowerDir, lowerPlane, lowerPoint, lowerRef, lowerTargets, resolveHandle, vec } from "./lower-query.js";
import { isV0Document, migrateV0ToV1 } from "./migrate.js";
import { STD_MODULE_V1 } from "./std-module.js";
import {
  ALL_HANDLE_METHODS,
  BUILTINS_V1,
  CONSTRAINT_METHODS,
  CURVE_BUILTINS,
  FEATURE_BUILTINS,
  isBuiltinV1,
  isFeatureBuiltin,
  METADATA_KEYS,
  QUERY_FUNCTIONS,
  QUERY_METHODS,
  RESERVED_NAMES_V0,
  RESERVED_NAMES_V1,
  SNAKE_KEY_HINTS,
} from "./syntax.js";
import { precheckV1, validateV1 } from "./validate.js";

export interface CompileOptionsV1 {
  /**
   * The IR this source was printed from (or last compiled to), `aicad.ir/1` or `aicad.ir/0`
   * (migrated). Part and feature ids are carried over by name; captures of unchanged references
   * are kept.
   */
  base?: v1.IrDocument | V0Document | null | undefined;
  /** Used in messages only. */
  fileName?: string | undefined;
}

export interface CompileResultV1 {
  /** True when there are no error diagnostics. */
  ok: boolean;
  /** The compiled document (canonical, §0.4), or `null` when there are errors. */
  ir: v1.IrDocument | null;
  /** Errors, warnings and infos, sorted by position. Some carry a machine-applicable `fix`. */
  diagnostics: DiagnosticV1[];
  /** Feature id → span of its `const` statement. */
  spans: Record<string, Span>;
  /** Feature id → curve (or constraint) id → span of its `id: …` property. */
  curveSpans: Record<string, Record<string, Span>>;
  /** Part id → span of its `part("…")` statement. */
  partSpans: Record<string, Span>;
  /** Parameter name → span of its `const` statement. */
  paramSpans: Record<string, Span>;
  /** IR path (JSON pointer) → span of the code that produced it. See {@link spanForIrPathV1}. */
  pathSpans: Record<string, Span>;
  /** Feature id → raw text of the comments attached above its statement. */
  comments: Record<string, string>;
}

/** What a top-level statement is (for `applyIrEditV1`). */
export interface SourceStatementV1 {
  node: ts.Statement;
  kind: "import" | "doc" | "param" | "part" | "feature" | "query" | "other";
  /** part/feature/param: index into `ir.parts` (-1 for document parameters and others). */
  partIndex: number;
  /** feature: index into the part's features; param: index into the (doc or part) params. */
  index: number;
}

/** @internal */
export interface AnalysisV1 {
  result: CompileResultV1;
  doc: v1.IrDocument;
  statements: SourceStatementV1[];
  sf: ts.SourceFile | undefined;
  hasSyntaxErrors: boolean;
  /** Query alias name → its query lowered as a reference (for `applyIrEditV1`); valid aliases in a part only. */
  aliasRefs?: Map<string, v1.Ref>;
  /**
   * The source never got past the parser: it is beyond the nesting limits (or the call stack ran
   * out), and the result's only diagnostic is that `CS_TOO_COMPLEX`. (A `CS_TOO_COMPLEX` of a
   * later stage, the IR JSON nesting bound or query alias expansion, leaves this unset.)
   */
  unparsed?: true;
}

/** Compile CadScript v1 source to an `aicad.ir/1` document. */
export function compileV1(source: string, options: CompileOptionsV1 = {}): CompileResultV1 {
  return analyzeV1(source, options).result;
}

/** Look up the span for an IR path, falling back to the closest enclosing path that has one. */
export function spanForIrPathV1(result: Pick<CompileResultV1, "pathSpans">, path: string): Span | undefined {
  let p = path;
  for (;;) {
    if (Object.prototype.hasOwnProperty.call(result.pathSpans, p)) return result.pathSpans[p];
    if (p === "") return undefined;
    p = p.slice(0, p.lastIndexOf("/"));
  }
}

// ─── Internal model ──────────────────────────────────────────────────────────────────────────

interface LParam {
  name: string;
  stmt: ts.VariableStatement;
  nameNode: ts.Identifier;
  broken: boolean;
  part: number | undefined;
  ir: Record<string, unknown>;
  sink: Sink;
  comment: string | undefined;
}

interface LFeature {
  name: string;
  builtin: string;
  type: string;
  id: string;
  stmt: ts.VariableStatement;
  nameNode: ts.Identifier;
  broken: boolean;
  ir: Record<string, unknown>;
  /** The common options (suppressed, v, metadata), kept apart from the feature's own fields. */
  common: Record<string, unknown>;
  sink: Sink;
  curves: { id: string; node: ts.Node; keyNode: ts.Node }[];
  comment: string | undefined;
}

interface LPart {
  name: string;
  stmt: ts.Statement | undefined;
  nameNode: ts.Node | undefined;
  params: LParam[];
  features: LFeature[];
}

const EMPTY_DOC = (): v1.IrDocument => ({ schema: v1.IR_SCHEMA, parts: [] }) as v1.IrDocument;

function setOwn<T>(obj: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

function emptyResult(diagnostics: DiagnosticV1[]): CompileResultV1 {
  return {
    ok: !diagnostics.some((d) => d.severity === "error"),
    ir: null,
    diagnostics,
    spans: {},
    curveSpans: {},
    partSpans: {},
    paramSpans: {},
    pathSpans: {},
    comments: {},
  };
}

// ─── Driver ──────────────────────────────────────────────────────────────────────────────────

/** @internal Parse, lower, assign ids, validate. Never throws, for any source text and any `base`. */
export function analyzeV1(source: string, options: CompileOptionsV1 = {}): AnalysisV1 {
  let sf: ts.SourceFile | undefined;
  try {
    const parsed = parseWithinLimits(options.fileName ?? "main.cad.ts", source, ts.ScriptTarget.Latest, LIMITS_V1);
    sf = parsed.sf;
    if (parsed.problem) return { sf, result: emptyResult([tooComplexDiagnostic(source, parsed.problem)]), doc: EMPTY_DOC(), statements: [], hasSyntaxErrors: true, unparsed: true };
    return analyzeParsed(parsed.sf, options);
  } catch (e) {
    if (!isStackOverflow(e)) throw e;
    return { sf, result: emptyResult([tooComplexDiagnostic(source, stackOverflowProblem("compile"))]), doc: EMPTY_DOC(), statements: [], hasSyntaxErrors: true, unparsed: true };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why a (canonical) base cannot serve identity: parts, features and sketch curves must be well-formed. */
function baseShapeProblem(base: unknown): string | undefined {
  const badParams = (ps: unknown): boolean => ps !== undefined && (!Array.isArray(ps) || Array.from(ps).some((x) => !isRecord(x) || typeof x["name"] !== "string"));
  if (!isRecord(base)) return "it is not an object";
  if (!Array.isArray(base["parts"])) return "it has no parts array";
  if (badParams(base["params"])) return "its params are not { name, … } objects";
  for (const p of base["parts"] as unknown[]) {
    if (!isRecord(p) || typeof p["id"] !== "string" || typeof p["name"] !== "string" || !Array.isArray(p["features"])) return "a part is not { id, name, features }";
    if (badParams(p["params"])) return "a part's params are not { name, … } objects";
    for (const f of p["features"] as unknown[]) {
      if (!isRecord(f) || typeof f["type"] !== "string" || typeof f["id"] !== "string" || typeof f["name"] !== "string") return "a feature is not { type, id, name, … }";
      if (f["type"] === "sketch" && (!Array.isArray(f["curves"]) || Array.from(f["curves"] as unknown[]).some((c) => !isRecord(c) || typeof c["id"] !== "string"))) {
        return "a sketch's curves are not { id, … } objects";
      }
    }
  }
  return undefined;
}

/**
 * `options.base` as identity uses it (canonical v1; a v0 base migrated), or undefined with a
 * `CS_BAD_BASE` warning when it is not a well-formed IR document: ids are then assigned as if
 * there were no base. Never throws.
 */
function identityBase(ctx: Ctx, raw: unknown): v1.IrDocument | undefined {
  const problem = baseProblem(raw);
  if (problem.doc) return problem.doc;
  ctx.report("CS_BAD_BASE", ctx.sf, `the base IR is not a well-formed IR document (${problem.why}): it was ignored`, undefined, false);
  return undefined;
}

/**
 * The identity base of `raw`, or why there is none. Every reason is a fixed, user-facing text:
 * no exception message (they name JavaScript internals) ever reaches a diagnostic.
 */
function baseProblem(raw: unknown): { doc: v1.IrDocument; why?: undefined } | { doc?: undefined; why: string } {
  try {
    if (!isRecord(raw)) return { why: "it is not an object" };
    if (isV0Document(raw as { schema?: unknown })) {
      let parsed: V0Document;
      try {
        parsed = parseV0Document(raw);
      } catch {
        return { why: "it does not have the shape of an aicad.ir/0 document" };
      }
      const doc = migrateV0ToV1(parsed);
      const why = baseShapeProblem(doc);
      return why === undefined ? { doc } : { why };
    }
    const shape = baseShapeProblem(raw);
    if (shape !== undefined) return { why: shape };
    const doc = canonicalDocument(raw as unknown as v1.IrDocument);
    const why = baseShapeProblem(doc);
    return why === undefined ? { doc } : { why };
  } catch {
    // (A hostile value: a getter or proxy that throws, a cycle.)
    return { why: "reading it failed" };
  }
}

/** A `const name = <feature builtin>(…)` statement (the pre-pass and the lowering agree on this). */
function featureDecl(stmt: ts.Statement): { name: string; builtin: string } | undefined {
  if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Const)) return undefined;
  const decls = stmt.declarationList.declarations;
  if (decls.length !== 1 || !ts.isIdentifier(decls[0]!.name) || !decls[0]!.initializer) return undefined;
  const callee = calleeName(decls[0]!.initializer);
  return callee && isFeatureBuiltin(callee) ? { name: decls[0]!.name.text, builtin: callee } : undefined;
}

function partCall(stmt: ts.Statement): ts.CallExpression | undefined {
  return ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression) && calleeName(stmt.expression) === "part" ? stmt.expression : undefined;
}

function analyzeParsed(sf: ts.SourceFile, options: CompileOptionsV1): AnalysisV1 {
  const ctx = new Ctx(sf);
  const statements: SourceStatementV1[] = [];
  const syntax = (sf as unknown as { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
  if (syntax.length > 0) {
    for (const d of syntax) {
      ctx.diagnostics.push({
        code: "CS_SYNTAX",
        severity: "error",
        message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        span: ctx.spanOf(d.start, d.start + d.length),
        hint: hintFor("CS_SYNTAX")!,
      });
    }
    return { sf, result: emptyResult(ctx.diagnostics), doc: EMPTY_DOC(), statements, hasSyntaxErrors: true };
  }

  // (`null`, like `undefined`, means no base.)
  const base = options.base === undefined || options.base === null ? undefined : identityBase(ctx, options.base);

  // ── Pre-pass: the parts and features, for identity (ids are known before lowering) ──
  const identityParts: IdentityInput[] = [];
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && !ctx.declared.has(d.name.text)) ctx.declared.set(d.name.text, d.name);
    }
    const pc = partCall(stmt);
    if (pc) {
      const a = pc.arguments[0];
      identityParts.push({ name: a && ts.isStringLiteral(a) ? a.text : "", features: [] });
      continue;
    }
    const fd = featureDecl(stmt);
    if (fd) {
      if (identityParts.length === 0) identityParts.push({ name: "part", features: [] });
      identityParts[identityParts.length - 1]!.features.push({ name: fd.name, type: FEATURE_BUILTINS[fd.builtin]! });
    }
  }
  const ids = assignIds(identityParts, base, { maxIdLength: v1.MAX_ID_LEN });

  // ── Lowering ──
  const parts: LPart[] = [];
  const docParams: LParam[] = [];
  let meta: v1.Meta | undefined;
  let docNode: ts.Node | undefined;
  let seenBody = false;
  let docSeen = false;
  let imports = 0;
  const aliasDecls: { entry: AliasEntry; part: number; at: number }[] = [];
  const ensurePart = (node: ts.Node): void => {
    if (ctx.currentPart >= 0) return;
    ctx.report("CS_MISSING_PART", node, 'features must follow a part("…") statement', 'add `part("part");` above the first feature', false);
    parts.push({ name: "part", stmt: undefined, nameNode: undefined, params: [], features: [] });
    ctx.currentPart = parts.length - 1;
  };

  for (const stmt of sf.statements) {
    const info: SourceStatementV1 = { node: stmt, kind: "other", partIndex: -1, index: -1 };
    statements.push(info);
    if (ts.isImportDeclaration(stmt)) {
      info.kind = "import";
      imports++;
      lowerImport(ctx, stmt, seenBody);
      continue;
    }
    seenBody = true;
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      const callee = calleeName(call);
      if (callee === "doc") {
        info.kind = "doc";
        ctx.use("doc", call.expression);
        const first = statements.length - imports === 1;
        let misplaced = false;
        if (docSeen) {
          ctx.report("CS_DOC_MISPLACED", call, "doc() may appear only once", "merge the metadata into the first doc({ … })", false);
          misplaced = true;
        } else if (!first) {
          ctx.report("CS_DOC_MISPLACED", call, "doc() must be the first statement after the imports", "move it directly below the import", false);
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
        parts.push({ name: name ?? "", stmt, nameNode: args?.[0], params: [], features: [] });
        ctx.currentPart = parts.length - 1;
        info.partIndex = ctx.currentPart;
        continue;
      }
      if (callee && (isFeatureBuiltin(callee) || callee === "param")) {
        ctx.report("CS_STATEMENT_UNSUPPORTED", stmt, `${callee}() must be assigned to a const: its name is the ${callee === "param" ? "parameter" : "feature"} name`, `write const name = ${callee}(…)`);
        continue;
      }
      if (callee && !isBuiltinV1(callee)) {
        ctx.report("CS_UNKNOWN_BUILTIN", call.expression, `${callee}() is not a CadScript v1 builtin`, "statements are doc(…), part(…) and `const name = …`");
        continue;
      }
    }
    if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Using)) {
      const decl = constDecl(ctx, stmt);
      if (!decl) continue;
      const callee = calleeName(decl.init);
      if (callee === "param" || callee === "measure") {
        const lp = lowerParam(ctx, stmt, decl.nameNode, decl.init as ts.CallExpression, callee, parts);
        if (lp) {
          info.kind = "param";
          if (ctx.currentPart < 0) {
            info.index = docParams.length;
            docParams.push(lp);
          } else {
            info.partIndex = ctx.currentPart;
            info.index = parts[ctx.currentPart]!.params.length;
            parts[ctx.currentPart]!.params.push(lp);
          }
        }
        continue;
      }
      if (callee && isFeatureBuiltin(callee)) {
        ensurePart(stmt);
        const pi = ctx.currentPart;
        const fi = parts[pi]!.features.length;
        const lf = lowerFeature(ctx, stmt, decl.nameNode, decl.init as ts.CallExpression, callee, ids.featureIds[pi]?.[fi] ?? `f_${decl.nameNode.text}`);
        info.kind = "feature";
        info.partIndex = pi;
        info.index = fi;
        parts[pi]!.features.push(lf);
        continue;
      }
      if (queryAlias(ctx, decl.nameNode, decl.init)) {
        info.kind = "query";
        const entry = ctx.names.get(decl.nameNode.text);
        if (entry?.kind === "query" && entry.node === decl.nameNode && ctx.currentPart >= 0) {
          aliasDecls.push({ entry, part: ctx.currentPart, at: parts[ctx.currentPart]!.features.length });
        }
        continue;
      }
      nonFeatureConst(ctx, decl.nameNode, decl.init);
      continue;
    }
    if (ts.isVariableStatement(stmt)) {
      // SPEC-v1 §2.9: `let`/`var` bindings are an unsupported *expression* form (derived values are param(expr)).
      for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name)) ctx.names.set(d.name.text, { kind: "invalid", node: d.name });
      const keyword = stmt.declarationList.flags & ts.NodeFlags.Let ? "let" : "var";
      ctx.report("CS_EXPR_UNSUPPORTED", stmt.declarationList, `\`${keyword}\` bindings are not supported`, "declare parameters and features with `const`; derived values are param(expression)");
      continue;
    }
    const { message, hint } = statementHint(stmt);
    ctx.report("CS_STATEMENT_UNSUPPORTED", stmt, message, hint);
  }

  // ── Unused query aliases: lowered at their declaration, as a tag of their query would be ──
  // (A used alias is lowered, and checked, at each use. Latest first: an alias that only an
  // unused later alias uses is checked through that one.)
  const aliasChecks: AliasCheck[] = [];
  for (const a of [...aliasDecls].reverse()) {
    if (a.entry.used) continue;
    ctx.broken = false;
    ctx.aliasExpansions = 0;
    const sink = newSink();
    const saved = ctx.currentPart;
    ctx.currentPart = a.part;
    const target = ctx.withNames(a.entry.names, () => lowerRef(ctx, a.entry.init, sink, "/target", { fallback: "face" }));
    ctx.currentPart = saved;
    if (target && !ctx.broken) aliasChecks.push({ name: (a.entry.node as ts.Identifier).text, part: a.part, at: a.at, target, sink, init: a.entry.init });
  }
  // Every alias's query as a reference, for the edit splicer; the used ones lowered silently
  // (their problems are reported at their uses).
  const aliasRefs = new Map<string, v1.Ref>();
  for (const c of aliasChecks) aliasRefs.set(c.name, c.target);
  {
    const reported = ctx.diagnostics.length;
    const notImported = new Set(ctx.notImportedReported);
    for (const a of aliasDecls) {
      const name = (a.entry.node as ts.Identifier).text;
      if (aliasRefs.has(name) || !a.entry.used) continue;
      ctx.broken = false;
      ctx.aliasExpansions = 0;
      const saved = ctx.currentPart;
      ctx.currentPart = a.part;
      const target = ctx.withNames(a.entry.names, () => lowerRef(ctx, a.entry.init, newSink(), "/target", { fallback: "face" }));
      ctx.currentPart = saved;
      if (target && !ctx.broken) aliasRefs.set(name, target);
    }
    ctx.diagnostics.length = reported;
    ctx.notImportedReported.clear();
    for (const n of notImported) ctx.notImportedReported.add(n);
  }

  // ── Renames of parts and features (identity) ──
  for (const r of ids.renames) {
    const part = parts[r.partIndex];
    if (!part) continue;
    const node = r.kind === "part" ? (part.nameNode ?? part.stmt) : part.features[r.featureIndex]?.nameNode;
    if (!node) continue;
    const what = r.kind === "part" ? "part" : part.features[r.featureIndex]!.builtin;
    ctx.report(
      "CS_RENAME_DETECTED",
      node,
      `${what} ${shownText(r.to, '"')} is treated as a rename of ${shownText(r.from, '"')} (same ${r.kind === "part" ? "" : "type and "}position); keeping id ${shownText(r.id, '"')}`,
      "references use ids, so nothing else needs to change",
      false,
    );
  }

  // ── Parameter order (identity) ──
  // IR v1 orders parameters by dependency (§2.8), so a parameter may use one declared after it;
  // CadScript declares before use, so the printer writes such lists in dependency order. When
  // the parameters of a list are exactly the base's, the base's order is kept: compiling a
  // printed document with its base gives it back exactly.
  if (base) {
    keepBaseOrder(docParams, base.params);
    parts.forEach((p, pi) => keepBaseOrder(p.params, base.parts.find((bp) => bp.id === ids.partIds[pi])?.params));
    for (const info of statements) {
      if (info.kind !== "param") continue;
      const list = info.partIndex < 0 ? docParams : parts[info.partIndex]!.params;
      info.index = list.findIndex((p) => p.stmt === info.node);
    }
  }

  // ── Assembly ──
  const raw: Record<string, unknown> = { schema: v1.IR_SCHEMA };
  if (meta && (meta.name || meta.description)) raw["meta"] = meta;
  if (docParams.length > 0) raw["params"] = docParams.map((p) => p.ir);
  raw["parts"] = parts.map((p, pi) => {
    const po: Record<string, unknown> = { id: ids.partIds[pi] ?? `p_${p.name}`, name: p.name };
    if (p.params.length > 0) po["params"] = p.params.map((x) => x.ir);
    po["features"] = p.features.map((f) => ({ type: f.type, id: f.id, name: f.name, ...f.common, ...f.ir }));
    return po;
  });
  const doc = canonicalDocument(raw as unknown as v1.IrDocument);

  // ── Source maps ──
  const result = emptyResult(ctx.diagnostics);
  const pathSpans = result.pathSpans;
  setOwn(pathSpans, "", ctx.spanOf(0, sf.text.length));
  if (docNode) setOwn(pathSpans, "/meta", ctx.span(docNode));
  const exprAsts = new Map<string, Expr>();
  const brokenPaths = new Set<string>();
  const mapSink = (prefix: string, sink: Sink): void => {
    for (const [rel, node] of sink.paths) setOwn(pathSpans, `${prefix}${rel}`, ctx.span(node));
    for (const [rel, ast] of sink.exprs) exprAsts.set(`${prefix}${rel}`, ast);
  };
  const mapParam = (pp: string, p: LParam): void => {
    setOwn(pathSpans, pp, ctx.span(p.stmt));
    setOwn(pathSpans, `${pp}/name`, ctx.span(p.nameNode));
    setOwn(result.paramSpans, p.name, ctx.span(p.stmt));
    mapSink(pp, p.sink);
    if (p.broken) brokenPaths.add(pp);
  };
  docParams.forEach((p, i) => mapParam(`/params/${i}`, p));
  parts.forEach((p, pi) => {
    const pid = ids.partIds[pi] ?? `p_${p.name}`;
    const pp = `/parts/${pi}`;
    const anchor = p.stmt ?? p.features[0]?.stmt ?? p.params[0]?.stmt;
    if (anchor) {
      setOwn(pathSpans, pp, ctx.span(anchor));
      setOwn(pathSpans, `${pp}/id`, ctx.span(anchor));
      if (p.stmt) setOwn(result.partSpans, pid, ctx.span(p.stmt));
    }
    if (p.nameNode) setOwn(pathSpans, `${pp}/name`, ctx.span(p.nameNode));
    p.params.forEach((x, i) => mapParam(`${pp}/params/${i}`, x));
    p.features.forEach((f, fi) => {
      const fp = `${pp}/features/${fi}`;
      setOwn(result.spans, f.id, ctx.span(f.stmt));
      setOwn(pathSpans, fp, ctx.span(f.stmt));
      setOwn(pathSpans, `${fp}/id`, ctx.span(f.nameNode));
      setOwn(pathSpans, `${fp}/name`, ctx.span(f.nameNode));
      mapSink(fp, f.sink);
      const cs: Record<string, Span> = {};
      for (const c of f.curves) if (!Object.prototype.hasOwnProperty.call(cs, c.id)) setOwn(cs, c.id, ctx.span(c.node));
      setOwn(result.curveSpans, f.id, cs);
      if (f.comment) setOwn(result.comments, f.id, f.comment);
      if (f.broken) brokenPaths.add(fp);
    });
  });

  // ── Identity: captures and curve renames against base ──
  if (base) {
    carryCaptures(ctx, doc, base, parts);
    detectCurveRenames(ctx, doc, base, parts);
  }

  // ── IR JSON nesting: forge-ir reads text at most MAX_JSON_NESTING deep (IR v1 has no bound) ──
  // (document, parts, part, features: a feature's own nesting starts at level 5; captures count.)
  doc.parts.forEach((part, pi) =>
    part.features.forEach((f, fi) => {
      const { depth, path } = jsonNesting(f);
      if (4 + depth <= MAX_JSON_NESTING) return;
      const lf = parts[pi]?.features[fi];
      const fp = `/parts/${pi}/features/${fi}`;
      // (at the field that holds the deep value, e.g. the whole query of `target`)
      const field = path.split("/").slice(0, 2).join("/");
      const span = spanForIrPathV1(result, `${fp}${field}`) ?? (lf ? ctx.span(lf.stmt) : ctx.spanOf(0, 0));
      ctx.diagnostics.push({
        code: "CS_TOO_COMPLEX",
        severity: "error",
        message: `this feature's IR nests ${4 + depth} arrays and objects deep; forge-ir reads IR JSON at most ${MAX_JSON_NESTING} deep`,
        hint: "split the query: name a part of it with tag() (const t = tag(…)) and continue from t",
        span,
        irPath: `${fp}${path}`,
      });
      if (lf) brokenPaths.add(fp);
    }),
  );

  // ── IR validation (mirror of forge-ir) ──
  const pre = precheckV1(doc);
  const errors = pre.errors.length > 0 ? pre.errors : validateV1(doc, { exprAst: (p) => exprAsts.get(p) });
  for (const e of errors) {
    // (A reserved name is a fact about the name alone: reported even when its statement is broken.)
    if (e.code !== "RESERVED_NAME" && [...brokenPaths].some((b) => e.path === b || e.path.startsWith(`${b}/`))) continue;
    const node = e.exprNode ? ctx.exprNodes.get(e.exprNode) : undefined;
    const d: DiagnosticV1 = {
      code: e.code,
      severity: "error",
      message: e.message,
      span: node ? ctx.span(node) : (spanForIrPathV1(result, e.path) ?? ctx.spanOf(0, 0)),
      irPath: e.path,
    };
    const hint = hintForError(e.code, e.details, e.candidates);
    if (hint) d.hint = hint;
    ctx.diagnostics.push(d);
  }

  if (aliasChecks.length > 0 && pre.errors.length === 0) checkUnusedAliases(ctx, doc, aliasChecks);

  ctx.diagnostics.sort((a, b) => compareSpans(a.span, b.span));
  // A query alias is lowered at each use: its own problems are reported once.
  const seen = new Set<string>();
  result.diagnostics = ctx.diagnostics.filter((d) => {
    const k = JSON.stringify([d.code, d.severity, d.message, d.span]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  result.ok = !result.diagnostics.some((d) => d.severity === "error");
  result.ir = result.ok ? doc : null;
  return { sf, result, doc, statements, hasSyntaxErrors: false, aliasRefs };
}

type AliasEntry = Extract<NameEntry, { kind: "query" }>;

/** An unused query alias, lowered as the target of a tag at its position. */
interface AliasCheck {
  name: string;
  part: number;
  /** Features of the part declared before the alias. */
  at: number;
  target: v1.Ref;
  sink: Sink;
  init: ts.Expression;
}

/**
 * IR validation of unused query aliases (the static query checks of a used one run at its
 * uses): each alias becomes a tag feature at its position in a copy of the document, and only
 * those tags' errors are reported, at the alias's code. The compiled document is unchanged.
 */
function checkUnusedAliases(ctx: Ctx, doc: v1.IrDocument, checks: AliasCheck[]): void {
  const taken = new Set(doc.parts.flatMap((p) => p.features.flatMap((f) => [f.id, f.name])));
  let n = 0;
  const fresh = (): string => {
    let id: string;
    do id = `__cs_alias_${n++}`;
    while (taken.has(id));
    return id;
  };
  const raw = structuredClone(doc) as unknown as { parts: { features: Record<string, unknown>[] }[] };
  const byId = new Map<string, AliasCheck>();
  // From the back, so that the positions of the earlier ones stay valid.
  for (const c of [...checks].sort((x, y) => y.part - x.part || y.at - x.at)) {
    const id = fresh();
    byId.set(id, c);
    raw.parts[c.part]!.features.splice(c.at, 0, { type: "tag", id, name: id, target: c.target });
  }
  const checkDoc = canonicalDocument(raw as unknown as v1.IrDocument);
  const pre = precheckV1(checkDoc);
  const errors = pre.errors.length > 0 ? pre.errors : validateV1(checkDoc);
  const at = new Map<string, AliasCheck>();
  checkDoc.parts.forEach((p, pi) =>
    p.features.forEach((f, fi) => {
      const c = byId.get(f.id);
      if (c) at.set(`/parts/${pi}/features/${fi}`, c);
    }),
  );
  for (const e of errors) {
    const m = /^\/parts\/\d+\/features\/\d+/.exec(e.path);
    const c = m ? at.get(m[0]) : undefined;
    if (!m || !c) continue;
    let node: ts.Node | undefined;
    for (let p = e.path.slice(m[0].length); ; p = p.slice(0, p.lastIndexOf("/"))) {
      node = c.sink.paths.get(p);
      if (node || p === "") break;
    }
    const d: DiagnosticV1 = { code: e.code, severity: "error", message: e.message, span: ctx.span(node ?? c.init) };
    const hint = hintForError(e.code, e.details, e.candidates);
    if (hint) d.hint = hint;
    ctx.diagnostics.push(d);
  }
}

/** Reorder `list` (in place) to the base's order when it declares exactly the base's parameters. */
function keepBaseOrder(list: LParam[], baseList: readonly v1.Parameter[] | undefined): void {
  if (!baseList || baseList.length !== list.length || list.length < 2) return;
  const pos = new Map(baseList.map((p, i) => [p.name, i]));
  if (pos.size !== baseList.length || new Set(list.map((p) => p.name)).size !== list.length || list.some((p) => !pos.has(p.name))) return;
  list.sort((a, b) => pos.get(a.name)! - pos.get(b.name)!);
}

function statementHint(stmt: ts.Statement): { message: string; hint: string } {
  if (ts.isIfStatement(stmt) || ts.isSwitchStatement(stmt)) {
    return { message: "conditionals are not supported in CadScript", hint: "use `suppressed: <bool expression>` or a `cond ? a : b` expression" };
  }
  if (ts.isIterationStatement(stmt, false)) return { message: "loops are not supported in CadScript", hint: "use linearPattern / circularPattern, or write each feature explicitly" };
  if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) return { message: "functions and classes are not supported in CadScript", hint: "CadScript is declarative: one `const` per parameter or feature" };
  if (ts.isExportDeclaration(stmt) || ts.isExportAssignment(stmt)) return { message: "exports are not supported", hint: "one file is one document; nothing needs exporting" };
  if (ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) {
    return { message: "type declarations are not supported", hint: "remove it; @aicad/std provides the types" };
  }
  if (ts.isEmptyStatement(stmt)) return { message: "stray `;`", hint: "remove it" };
  if (ts.isBlock(stmt)) return { message: "blocks are not supported", hint: "write statements at the top level" };
  return { message: "this statement is not supported in CadScript", hint: "a file contains imports, doc(…), part(…) and `const name = …` statements" };
}

function lowerImport(ctx: Ctx, stmt: ts.ImportDeclaration, seenBody: boolean): void {
  const usage = `import { … } from "${STD_MODULE_V1}";`;
  if (seenBody) ctx.report("CS_BAD_IMPORT", stmt, "imports must come before every other statement", "move the import to the top of the file", false);
  const spec = stmt.moduleSpecifier;
  if (!ts.isStringLiteral(spec) || spec.text !== STD_MODULE_V1) {
    ctx.report("CS_BAD_IMPORT", spec, `CadScript files can only import from "${STD_MODULE_V1}"`, usage, false);
    return;
  }
  const clause = stmt.importClause;
  if (!clause) {
    ctx.report("CS_BAD_IMPORT", stmt, "side-effect imports are not supported", usage, false);
    return;
  }
  if (clause.isTypeOnly) ctx.report("CS_BAD_IMPORT", clause, "type-only imports are not needed", usage, false);
  if (clause.name) ctx.report("CS_BAD_IMPORT", clause.name, `"${STD_MODULE_V1}" has no default export`, usage, false);
  const bindings = clause.namedBindings;
  if (!bindings) return;
  if (ts.isNamespaceImport(bindings)) {
    ctx.report("CS_BAD_IMPORT", bindings, "namespace imports are not supported", `import the builtins by name: ${usage}`, false);
    return;
  }
  for (const el of bindings.elements) {
    const exported = (el.propertyName ?? el.name).text;
    if (el.isTypeOnly) {
      ctx.report("CS_BAD_IMPORT", el, "type imports are not needed in CadScript", "remove it", false);
      continue;
    }
    if (el.propertyName && el.propertyName.text !== el.name.text) {
      ctx.report("CS_BAD_IMPORT", el, "renaming imports is not supported", `import \`${exported}\` under its own name`, false);
      continue;
    }
    if (!isBuiltinV1(exported)) {
      const near = closest(exported, BUILTINS_V1);
      ctx.report("CS_UNKNOWN_BUILTIN", el, `"${STD_MODULE_V1}" has no export \`${exported}\``, near ? `did you mean \`${near}\`?` : "see @aicad/std for the builtins", false);
      continue;
    }
    ctx.imported.add(exported);
  }
}

function lowerDoc(ctx: Ctx, call: ts.CallExpression): v1.Meta | undefined {
  const args = callArgs(ctx, call, "doc", 1, 1, 'doc({ name: "my_part", description: "…" })');
  const props = args ? readObject(ctx, args[0]!, "doc()", [], ["name", "description"], { title: "use `name`", units: "units are fixed: mm and degrees" }) : undefined;
  if (!props) return undefined;
  const out: v1.Meta = {};
  const n = props.get("name");
  const d = props.get("description");
  const name = n ? readString(ctx, n.value, "doc name") : undefined;
  const description = d ? readString(ctx, d.value, "doc description") : undefined;
  if (name) out.name = name;
  if (description) out.description = description;
  return out;
}

/** The single `const name = init` of a statement (reports every other form). */
function constDecl(ctx: Ctx, stmt: ts.VariableStatement): { nameNode: ts.Identifier; init: ts.Expression } | undefined {
  const list = stmt.declarationList;
  if (stmt.modifiers?.length) ctx.report("CS_STATEMENT_UNSUPPORTED", stmt.modifiers[0]!, `\`${ctx.text(stmt.modifiers[0]!)}\` is not supported here`, "remove it: `const name = …`");
  const scope = list.flags & ts.NodeFlags.BlockScoped;
  if (scope === ts.NodeFlags.Using || scope === ts.NodeFlags.AwaitUsing) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", list, "`using` declarations are not supported", "declare with `const`");
    return undefined;
  }
  if (list.declarations.length !== 1) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", list, "declare one parameter or feature per `const` statement", "split it into separate `const` statements");
    return undefined;
  }
  const decl = list.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) {
    ctx.report("CS_STATEMENT_UNSUPPORTED", decl.name, "destructuring is not supported", "write `const name = …`");
    return undefined;
  }
  if (decl.type) ctx.report("CS_STATEMENT_UNSUPPORTED", decl.type, "type annotations are not supported", "remove the `: Type` annotation");
  if (!decl.initializer) {
    ctx.names.set(decl.name.text, { kind: "invalid", node: decl.name });
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) return undefined;
    ctx.report("CS_SYNTAX", decl, `\`const ${decl.name.text}\` has no value: 'const' declarations must be initialized`, `write const ${decl.name.text} = param(…) or a feature, or delete it`);
    return undefined;
  }
  return { nameNode: decl.name, init: decl.initializer };
}

/** `const x = <not a param or feature>`: explain. */
function nonFeatureConst(ctx: Ctx, nameNode: ts.Identifier, init: ts.Expression): void {
  const name = nameNode.text;
  ctx.names.set(name, { kind: "invalid", node: nameNode });
  const callee = calleeName(init);
  if (callee && isBuiltinV1(callee)) {
    const hint = CURVE_BUILTINS.includes(callee)
      ? `curves go inside a sketch: const s = sketch(XY, { ${name}: ${callee}(…) })`
      : callee === "frame" || callee === "grid" || callee === "boltCircle"
        ? `pass ${callee}(…) directly where it is used`
        : `${callee}() is not a feature or parameter`;
    ctx.report("CS_UNKNOWN_BUILTIN", (init as ts.CallExpression).expression, `${callee}() does not create a parameter or feature`, hint);
    return;
  }
  if (callee) {
    const near = closest(callee, [...Object.keys(FEATURE_BUILTINS), "param"]);
    ctx.report("CS_UNKNOWN_BUILTIN", (init as ts.CallExpression).expression, `${callee}() is not a CadScript v1 builtin`, near ? `did you mean ${near}()?` : "consts are param(…) or features: sketch, extrude, revolve, hole, fillet, …");
    return;
  }
  ctx.report(
    "CS_EXPR_UNSUPPORTED",
    init,
    `\`const ${name}\` must be a parameter, a feature or a query`,
    `named values are parameters: const ${name} = param(${ts.isNumericLiteral(init) ? ctx.text(init) : "…"}); named queries start at a feature: const ${name} = slab.cap("end")`,
  );
}

/** The feature (or query function call) a method chain starts at. */
function chainRoot(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e)) e = e.expression;
    else if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) e = e.expression.expression;
    else return e;
  }
}

/**
 * `const top = slab.faces().planes().max("+Z").one()` (SPEC-v1 §5.11): a query alias, declared
 * when the value is a method chain on a feature, a tag or another alias, or a query function
 * call (`edgesBetween`, `faceOf`, `body`, `bodies`). It adds nothing to the IR: every use lowers
 * the chain in place (so the printer writes the query inline) and is checked there; an unused
 * alias is checked at its declaration (`checkUnusedAliases`). A chain on a name that is not a
 * feature (`zz.cap("end")`, a parameter) is reported at that name, as in a feature statement.
 * Returns false when `init` is not a query.
 */
function queryAlias(ctx: Ctx, nameNode: ts.Identifier, init: ts.Expression): boolean {
  let e = init;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isCallExpression(e)) return false;
  const root = chainRoot(e);
  const fn = calleeName(root);
  let valid = true;
  if (!(fn !== undefined && QUERY_FUNCTIONS.includes(fn))) {
    if (!ts.isIdentifier(root) || !ts.isPropertyAccessExpression(e.expression)) return false;
    const entry = ctx.names.get(root.text);
    if (entry?.kind === "invalid") valid = false; // reported at its declaration
    else if (entry === undefined && ctx.declared.has(root.text)) {
      ctx.report("CS_USED_BEFORE_DECLARED", root, `\`${root.text}\` is used before it is declared`, `move \`const ${root.text} = …\` above this statement: statements run in file order`);
      valid = false;
    } else if (entry?.kind !== "feature" && entry?.kind !== "query") {
      // A query chain on something that is not a feature (`zz.cap("end")`, a parameter, a plane):
      // the same report as in a feature statement, at the name (UNRESOLVED_FEATURE, …).
      const link = firstLink(e);
      if (!link || !(ALL_HANDLE_METHODS.has(link) || QUERY_METHODS.has(link))) return false;
      resolveHandle(ctx, root, `${link}()`);
      valid = false;
    }
  }
  if (declareName(ctx, nameNode, "query")) return true; // a duplicate: the first declaration stands
  ctx.names.set(nameNode.text, valid ? { kind: "query", node: nameNode, init, names: new Map(ctx.names), used: false } : { kind: "invalid", node: nameNode });
  return true;
}

/** The method a chain calls on its root identifier (`cap` in `zz.cap("end").edges()`). */
function firstLink(e: ts.Expression): string | undefined {
  for (;;) {
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression)) return undefined;
    let recv: ts.Expression = e.expression.expression;
    while (ts.isParenthesizedExpression(recv)) recv = recv.expression;
    if (ts.isIdentifier(recv)) return e.expression.name.text;
    e = recv;
  }
}

// ─── Names ───────────────────────────────────────────────────────────────────────────────────

/**
 * Common checks of a declared name; returns whether it is a duplicate. A parameter named in the
 * full `RESERVED_NAMES`, or a feature in `RESERVED_NAMES_V0`, is IR validation's
 * `RESERVED_NAME` (reported at the name, even when the statement has other errors); a feature
 * named like a v1 builtin is `CS_RESERVED_NAME` (SPEC-v1 §0.3 rule 3, §9.3), and so is a query
 * alias named like any builtin or reserved word.
 */
function declareName(ctx: Ctx, nameNode: ts.Identifier, kind: "param" | "feature" | "query"): boolean {
  const name = nameNode.text;
  if (kind === "query" && RESERVED_NAMES_V1.has(name)) {
    ctx.report("CS_RESERVED_NAME", nameNode, `\`${name}\` is a reserved word or @aicad/std builtin and cannot name a query`, `pick another name, e.g. \`${name}_1\``, false);
  } else if (kind === "feature" && !RESERVED_NAMES_V0.has(name) && isBuiltinV1(name)) {
    const imported = ctx.imported.has(name);
    ctx.report(
      "CS_RESERVED_NAME",
      nameNode,
      `\`${name}\` is a @aicad/std v1 builtin${imported ? " imported by this file" : ""}`,
      imported ? `rename the feature: it collides with the import of ${name}` : "rename the feature (safe: references use ids); allowed for features migrated from v0",
      false,
      imported ? "error" : "warning",
    );
  }
  const prev = ctx.names.get(name);
  if (prev) {
    const line = ctx.span(prev.node).start.line;
    ctx.report("CS_DUPLICATE_NAME", nameNode, `\`${name}\` is already declared on line ${line}`, "parameter, feature and query names are unique across the whole file: rename one of them", false);
    ctx.broken = true;
    return true;
  }
  return false;
}

// ─── Parameters ──────────────────────────────────────────────────────────────────────────────

const PARAM_UNITS = ["mm", "deg", "ratio", "count", "bool"];

/** The environment of a parameter or feature expression for unit inference (declared params). */
export function inferenceEnv(names: ReadonlyMap<string, { kind: string; unit?: ParamUnitName }>): TypeEnv {
  return {
    lookup: (n) => {
      const e = names.get(n);
      return e?.kind === "param" && e.unit ? { kind: "param", unit: e.unit } : { kind: "unknown" };
    },
    names: () => [],
  };
}

/** Unit inference for `param(expr)` (§2.9): fixed type → its unit, Flex → mm, bool → bool. */
export function inferUnit(ast: Expr, env: TypeEnv): ParamUnitName {
  const r = typeOf(ast, env);
  if (!r.ok) return "mm";
  const t = r.type;
  if (t.t === "bool") return "bool";
  if (t.t === "flex") return "mm";
  if (t.L === 0 && t.A === 1) return "deg";
  if (t.L === 0 && t.A === 0) return "ratio";
  return "mm";
}

function lowerParam(ctx: Ctx, stmt: ts.VariableStatement, nameNode: ts.Identifier, call: ts.CallExpression, callee: string, parts: LPart[]): LParam | undefined {
  ctx.broken = false;
  ctx.aliasExpansions = 0;
  const sink = newSink();
  const name = nameNode.text;
  const duplicate = declareName(ctx, nameNode, "param");
  ctx.use(callee, call.expression);
  const lp: LParam = { name, stmt, nameNode, broken: false, part: ctx.currentPart < 0 ? undefined : ctx.currentPart, ir: { name, unit: "mm", value: 0 }, sink, comment: attachedComments(ctx.sf, stmt) };
  const register = (unit: ParamUnitName): void => {
    if (!duplicate) ctx.names.set(name, { kind: "param", node: nameNode, unit, part: lp.part, index: 0 });
  };
  if (callee === "measure") {
    ctx.report(
      "PARAM_INVALID",
      call,
      "measured parameters are deferred to IR v1.1 (ADR 0013 decision 5)",
      "use a driving dimension bound to a parameter instead: C.distance(a, b, width)",
    );
    lp.broken = true;
    register("mm");
    return lp;
  }
  void parts;
  const args = callArgs(ctx, call, "param", 1, 2, "param(80, { min: 20, max: 300, note: \"…\" })");
  if (!args) {
    lp.broken = true;
    register("mm");
    return lp;
  }
  const props = args[1]
    ? readObject(ctx, args[1], "param options", [], ["unit", "min", "max", "note"], { measure: "measured parameters arrive with IR v1.1", default: "the value is the first argument" })
    : new Map() as Props;
  const unitProp = props?.get("unit");
  let explicitUnit: string | undefined;
  if (unitProp) {
    sink.paths.set("/unit", unitProp.value);
    explicitUnit = readString(ctx, unitProp.value, "param unit");
  }
  // value
  const valueNode = args[0]!;
  sink.paths.set("/value", valueNode);
  const ast = lowerExpr(ctx, valueNode, "the parameter value", "a number, true, false or an expression");
  let value: number | string | boolean | undefined;
  let unit: string = explicitUnit ?? "mm";
  if (ast) {
    if (ast.k === "bool") {
      value = ast.v;
      if (!explicitUnit) unit = "bool";
    } else {
      const s = scalarOf(ast);
      if (s.kind === "num") value = s.value;
      else {
        value = s.text;
        sink.exprs.set("/value", s.ast);
        if (!explicitUnit) unit = inferUnit(s.ast, inferenceEnv(ctx.names as ReadonlyMap<string, { kind: string; unit?: ParamUnitName }>));
      }
    }
  }
  const ir: Record<string, unknown> = { name, unit, value: value ?? 0 };
  for (const k of ["min", "max"]) {
    const p = props?.get(k);
    if (!p) continue;
    const v = lowerScalar(ctx, p.value, `param ${k}`, `/${k}`, sink);
    if (v !== undefined) ir[k] = v;
  }
  const note = props?.get("note");
  if (note) {
    sink.paths.set("/note", note.value);
    const s = readString(ctx, note.value, "param note");
    if (s) ir["note"] = s;
  }
  lp.ir = ir;
  lp.broken = ctx.broken || duplicate;
  register((PARAM_UNITS.includes(unit) ? unit : "mm") as ParamUnitName);
  return lp;
}

// ─── Features ────────────────────────────────────────────────────────────────────────────────

function lowerFeature(ctx: Ctx, stmt: ts.VariableStatement, nameNode: ts.Identifier, call: ts.CallExpression, builtin: string, id: string): LFeature {
  ctx.broken = false;
  ctx.aliasExpansions = 0;
  const name = nameNode.text;
  const duplicate = declareName(ctx, nameNode, "feature");
  ctx.use(builtin, call.expression);
  const type = FEATURE_BUILTINS[builtin]!;
  const lf: LFeature = {
    name,
    builtin,
    type,
    id,
    stmt,
    nameNode,
    broken: false,
    ir: {},
    common: {},
    sink: newSink(),
    curves: [],
    comment: attachedComments(ctx.sf, stmt),
  };
  const entry: NameEntry = { kind: "feature", node: nameNode, type, builtin, part: ctx.currentPart, id };
  switch (builtin) {
    case "sketch":
      lf.ir = lowerSketch(ctx, call, lf);
      break;
    case "extrude":
    case "revolve":
      lf.ir = lowerSweep(ctx, call, lf, entry);
      break;
    case "boolean":
      lf.ir = lowerBoolean(ctx, call, lf);
      break;
    case "transform":
      lf.ir = lowerTransform(ctx, call, lf);
      break;
    case "hole":
      lf.ir = lowerHole(ctx, call, lf);
      break;
    case "fillet":
    case "chamfer":
      lf.ir = lowerBlend(ctx, call, lf, builtin);
      break;
    case "shell":
      lf.ir = lowerShell(ctx, call, lf);
      break;
    case "draft":
      lf.ir = lowerDraft(ctx, call, lf);
      break;
    case "linearPattern":
    case "circularPattern":
    case "mirror":
      lf.ir = lowerPattern(ctx, call, lf, builtin);
      break;
    case "datumPlane":
      lf.ir = lowerDatumPlane(ctx, call, lf);
      break;
    case "datumAxis":
      lf.ir = lowerDatumAxis(ctx, call, lf);
      break;
    default: {
      const tag = lowerTag(ctx, call, lf);
      lf.ir = tag.ir;
      if (tag.kind) entry.tagKind = tag.kind;
    }
  }
  lf.broken = ctx.broken || duplicate;
  if (!duplicate) ctx.names.set(name, entry);
  return lf;
}

/** Read an options object with the feature's keys plus the common ones; applies the common ones. */
function featureOptions(
  ctx: Ctx,
  e: ts.Expression | undefined,
  what: string,
  lf: LFeature,
  required: readonly string[],
  optional: readonly string[],
  hints: Readonly<Record<string, string>> = {},
): Props | undefined {
  if (!e) {
    if (required.length > 0) ctx.report("CS_BAD_ARGUMENT", lf.stmt, `${what} needs its options { ${required.join(", ")}, … }`, undefined);
    return required.length > 0 ? undefined : new Map();
  }
  const common = ["suppressed", "v", ...METADATA_KEYS.map(([, cs]) => cs)];
  const props = readObject(ctx, e, what, required, [...optional, ...common], { ...SNAKE_KEY_HINTS, ...hints });
  if (!props) return undefined;
  applyCommon(ctx, props, lf);
  return props;
}

function applyCommon(ctx: Ctx, props: Props, lf: LFeature): void {
  const s = props.get("suppressed");
  if (s) {
    const v = lowerBoolScalar(ctx, s.value, "suppressed", "/suppressed", lf.sink);
    if (v !== undefined) lf.common["suppressed"] = v;
  }
  const v = props.get("v");
  if (v) {
    lf.sink.paths.set("/v", v.value);
    const n = readLiteralInt(ctx, v.value, "v");
    if (n !== undefined) lf.common["v"] = n;
  }
  for (const [ir, cs] of METADATA_KEYS) {
    const p = props.get(cs);
    if (!p) continue;
    lf.sink.paths.set(`/${ir}`, p.value);
    const val = ir === "assumptions" || ir === "decision_ids" ? readStringArray(ctx, p.value, cs) : readString(ctx, p.value, cs);
    if (val !== undefined) lf.common[ir] = val;
  }
}

function scalar(ctx: Ctx, props: Props, key: string, irPath: string, lf: LFeature, what = key): number | string | undefined {
  const p = props.get(key);
  return p ? lowerScalar(ctx, p.value, what, irPath, lf.sink) : undefined;
}

function put(o: Record<string, unknown>, k: string, v: unknown): void {
  if (v !== undefined) o[k] = v;
}

function enumProp(ctx: Ctx, props: Props, key: string, allowed: readonly string[], lf: LFeature, irPath = `/${key}`): string | undefined {
  const p = props.get(key);
  if (!p) return undefined;
  lf.sink.paths.set(irPath, p.value);
  return readString(ctx, p.value, key, allowed);
}

// ── sketch ──

function lowerSketch(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = { plane: "XY", curves: [] };
  const args = callArgs(ctx, call, "sketch", 2, 3, "const base = sketch(XY, { a: line([0, 0], [10, 0]), … })");
  if (!args) return ir;
  const plane = lowerPlane(ctx, args[0]!, lf.sink, "/plane");
  if (plane !== undefined) ir["plane"] = plane;
  ir["curves"] = lowerCurves(ctx, args[1]!, lf);
  if (args[2]) {
    const props = featureOptions(ctx, args[2], "sketch options", lf, [], ["constraints"]);
    const c = props?.get("constraints");
    if (c) ir["constraints"] = lowerConstraints(ctx, c.value, lf);
  }
  return ir;
}

function lowerCurves(ctx: Ctx, e: ts.Expression, lf: LFeature): unknown[] {
  lf.sink.paths.set("/curves", e);
  if (!ts.isObjectLiteralExpression(e)) {
    mismatch(ctx, e, "an object of curves { id: line(…), … }", "the sketch curves");
    return [];
  }
  const curves: unknown[] = [];
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p)) {
      ctx.report(ts.isSpreadAssignment(p) ? "CS_EXPR_UNSUPPORTED" : "CS_BAD_ARGUMENT", p, "sketch curves are `id: curve(…)` properties", "write `id: line(…)`");
      continue;
    }
    const id = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (id === undefined) {
      ctx.report("CS_BAD_ARGUMENT", p.name, "curve ids must be identifiers or \"strings\"", "write the id literally");
      continue;
    }
    const i = curves.length;
    const cp = `/curves/${i}`;
    const curve = lowerCurve(ctx, id, p.initializer, lf, cp);
    if (!curve) continue;
    curves.push(curve);
    lf.curves.push({ id, node: p, keyNode: p.name });
    lf.sink.paths.set(cp, p);
    lf.sink.paths.set(`${cp}/id`, p.name);
  }
  return curves;
}

function construction(ctx: Ctx, props: Props | undefined, out: Record<string, unknown>, lf: LFeature, cp: string): void {
  const c = props?.get("construction");
  if (!c) return;
  lf.sink.paths.set(`${cp}/construction`, c.value);
  const b = readLiteralBool(ctx, c.value, "construction");
  if (b !== undefined) out["construction"] = b;
}

function lowerCurve(ctx: Ctx, id: string, e: ts.Expression, lf: LFeature, cp: string): Record<string, unknown> | undefined {
  const callee = calleeName(e);
  if (!callee || !CURVE_BUILTINS.includes(callee)) {
    if (callee && !isBuiltinV1(callee)) {
      const near = closest(callee, CURVE_BUILTINS);
      return ctx.report("CS_UNKNOWN_BUILTIN", (e as ts.CallExpression).expression, `${callee}() is not a sketch curve`, near ? `did you mean ${near}()?` : `curves are ${CURVE_BUILTINS.join(", ")}`);
    }
    return mismatch(ctx, e, `a curve: ${CURVE_BUILTINS.map((c) => `${c}(…)`).join(", ")}`, `curve ${shownText(id)}`);
  }
  const call = e as ts.CallExpression;
  ctx.use(callee, call.expression);
  const what = `${callee} ${shownText(id)}`;
  const s = lf.sink;
  switch (callee) {
    case "line": {
      const args = callArgs(ctx, call, "line", 2, 3, "line([u1, v1], [u2, v2])");
      if (!args) return undefined;
      const start = vec(ctx, args[0], 2, `${what} start`, `${cp}/start`, s);
      const end = vec(ctx, args[1], 2, `${what} end`, `${cp}/end`, s);
      const out: Record<string, unknown> = { kind: "line", id, start, end };
      if (args[2]) construction(ctx, readObject(ctx, args[2], `${what} options`, [], ["construction"]), out, lf, cp);
      return start && end ? out : undefined;
    }
    case "point": {
      const args = callArgs(ctx, call, "point", 1, 2, "point([u, v])");
      if (!args) return undefined;
      const at = vec(ctx, args[0], 2, `${what}`, `${cp}/at`, s);
      const out: Record<string, unknown> = { kind: "point", id, at };
      if (args[1]) construction(ctx, readObject(ctx, args[1], `${what} options`, [], ["construction"]), out, lf, cp);
      return at ? out : undefined;
    }
    case "arc": {
      const args = callArgs(ctx, call, "arc", 1, 1, "arc({ start: [u, v], end: [u, v], center: [u, v], ccw: true })");
      const props = args ? readObject(ctx, args[0]!, what, ["start", "end", "center", "ccw"], ["construction"], { radius: "an arc's radius is implied: |start − center|", cw: "use `ccw: false`" }) : undefined;
      if (!props) return undefined;
      const start = vec(ctx, props.get("start")?.value, 2, `${what} start`, `${cp}/start`, s);
      const end = vec(ctx, props.get("end")?.value, 2, `${what} end`, `${cp}/end`, s);
      const center = vec(ctx, props.get("center")?.value, 2, `${what} center`, `${cp}/center`, s);
      const ccwP = props.get("ccw");
      const ccw = ccwP ? readLiteralBool(ctx, ccwP.value, `${what} ccw`) : undefined;
      const out: Record<string, unknown> = { kind: "arc", id, start, end, center, ccw };
      construction(ctx, props, out, lf, cp);
      return start && end && center && ccw !== undefined ? out : undefined;
    }
    case "circle": {
      const args = callArgs(ctx, call, "circle", 1, 1, "circle({ center: [u, v], radius: r })");
      const props = args ? readObject(ctx, args[0]!, what, ["center", "radius"], ["construction"], { r: "spell it `radius`", diameter: "use `radius` (diameter / 2)", d: "use `radius` (diameter / 2)" }) : undefined;
      if (!props) return undefined;
      const center = vec(ctx, props.get("center")?.value, 2, `${what} center`, `${cp}/center`, s);
      const radius = scalarAt(ctx, props, "radius", `${cp}/radius`, s, `${what} radius`);
      const out: Record<string, unknown> = { kind: "circle", id, center, radius };
      construction(ctx, props, out, lf, cp);
      return center && radius !== undefined ? out : undefined;
    }
    case "rect": {
      const args = callArgs(ctx, call, "rect", 1, 1, "rect({ center: [0, 0], w: 80, h: 50, r: 4 })");
      const props = args ? readObject(ctx, args[0]!, what, ["w", "h"], ["center", "corner", "r", "construction"], { width: "use `w`", height: "use `h`", radius: "the corner radius is `r`" }) : undefined;
      if (!props) return undefined;
      const out: Record<string, unknown> = { kind: "rect", id };
      if (props.has("center")) out["center"] = vec(ctx, props.get("center")!.value, 2, `${what} center`, `${cp}/center`, s);
      if (props.has("corner")) out["corner"] = vec(ctx, props.get("corner")!.value, 2, `${what} corner`, `${cp}/corner`, s);
      out["w"] = scalarAt(ctx, props, "w", `${cp}/w`, s, `${what} w`);
      out["h"] = scalarAt(ctx, props, "h", `${cp}/h`, s, `${what} h`);
      if (props.has("r")) out["r"] = scalarAt(ctx, props, "r", `${cp}/r`, s, `${what} r`);
      construction(ctx, props, out, lf, cp);
      return out;
    }
    case "slot": {
      const args = callArgs(ctx, call, "slot", 1, 1, "slot({ a: [0, 0], b: [20, 0], w: 5 })");
      const props = args ? readObject(ctx, args[0]!, what, ["a", "b", "w"], ["construction"], { width: "use `w`" }) : undefined;
      if (!props) return undefined;
      const out: Record<string, unknown> = {
        kind: "slot",
        id,
        a: vec(ctx, props.get("a")?.value, 2, `${what} a`, `${cp}/a`, s),
        b: vec(ctx, props.get("b")?.value, 2, `${what} b`, `${cp}/b`, s),
        w: scalarAt(ctx, props, "w", `${cp}/w`, s, `${what} w`),
      };
      construction(ctx, props, out, lf, cp);
      return out;
    }
    default: {
      const args = callArgs(ctx, call, "polygon", 1, 1, "polygon({ n: 6, acrossFlats: 5.5 })");
      const props = args
        ? readObject(ctx, args[0]!, what, ["n"], ["center", "circumradius", "inradius", "acrossFlats", "across_flats", "side", "rotation", "construction"], { sides: "the count is `n`", radius: "use `circumradius` or `inradius`" })
        : undefined;
      if (!props) return undefined;
      // `across_flats` is SPEC-v1 §4.1's spelling of `acrossFlats` (the printer writes `acrossFlats`).
      if (props.has("acrossFlats") && props.has("across_flats")) {
        return ctx.report("CS_BAD_ARGUMENT", props.get("across_flats")!.key, "`across_flats` and `acrossFlats` are the same option", "give it once: acrossFlats: 5.5");
      }
      const out: Record<string, unknown> = { kind: "polygon", id };
      out["center"] = props.has("center") ? vec(ctx, props.get("center")!.value, 2, `${what} center`, `${cp}/center`, s) : [0, 0];
      out["n"] = scalarAt(ctx, props, "n", `${cp}/n`, s, `${what} n`);
      for (const [cs, irk] of [
        ["circumradius", "circumradius"],
        ["inradius", "inradius"],
        ["acrossFlats", "across_flats"],
        ["across_flats", "across_flats"],
        ["side", "side"],
      ] as const) {
        if (props.has(cs)) out[irk] = scalarAt(ctx, props, cs, `${cp}/${irk}`, s, `${what} ${cs}`);
      }
      if (props.has("rotation")) out["rotation"] = scalarAt(ctx, props, "rotation", `${cp}/rotation`, s, `${what} rotation`);
      construction(ctx, props, out, lf, cp);
      return out;
    }
  }
}

function scalarAt(ctx: Ctx, props: Props, key: string, path: string, sink: Sink, what: string): number | string | undefined {
  const p = props.get(key);
  return p ? lowerScalar(ctx, p.value, what, path, sink) : undefined;
}

function lowerConstraints(ctx: Ctx, e: ts.Expression, lf: LFeature): unknown[] {
  lf.sink.paths.set("/constraints", e);
  if (!ts.isObjectLiteralExpression(e)) {
    mismatch(ctx, e, "an object of constraints { id: C.horizontal(\"l\"), … }", "constraints");
    return [];
  }
  const out: unknown[] = [];
  for (const p of e.properties) {
    if (!ts.isPropertyAssignment(p)) {
      ctx.report("CS_BAD_ARGUMENT", p, "constraints are `id: C.<kind>(…)` properties", "write `h1: C.horizontal(\"bottom\")`");
      continue;
    }
    const id = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
    if (id === undefined) {
      ctx.report("CS_BAD_ARGUMENT", p.name, "constraint ids must be identifiers or \"strings\"", undefined);
      continue;
    }
    const kp = `/constraints/${out.length}`;
    const c = lowerConstraint(ctx, id, p.initializer, lf, kp);
    if (!c) continue;
    lf.sink.paths.set(kp, p);
    lf.sink.paths.set(`${kp}/id`, p.name);
    lf.curves.push({ id, node: p, keyNode: p.name });
    out.push(c);
  }
  return out;
}

const CONSTRAINT_ARGS: Readonly<Record<string, readonly string[]>> = {
  coincident: ["a", "b"],
  horizontal: ["line"],
  vertical: ["line"],
  parallel: ["a", "b"],
  perpendicular: ["a", "b"],
  tangent: ["a", "b"],
  equal: ["a", "b"],
  distance: ["a", "b"],
  angle: ["a", "b"],
  radius: ["curve"],
  diameter: ["curve"],
  point_on_line: ["point", "line"],
  point_on_circle: ["point", "curve"],
  midpoint: ["point", "line"],
  symmetric: ["a", "b", "line"],
  fix: ["entity"],
};

function lowerConstraint(ctx: Ctx, id: string, e: ts.Expression, lf: LFeature, kp: string): Record<string, unknown> | undefined {
  if (!ts.isCallExpression(e) || !ts.isPropertyAccessExpression(e.expression) || !ts.isIdentifier(e.expression.expression) || e.expression.expression.text !== "C") {
    return mismatch(ctx, e, "a constraint: C.horizontal(…), C.distance(…), …", `constraint ${shownText(id)}`);
  }
  ctx.use("C", e.expression.expression);
  const method = e.expression.name.text;
  const type = Object.prototype.hasOwnProperty.call(CONSTRAINT_METHODS, method) ? CONSTRAINT_METHODS[method]! : undefined;
  if (!type) {
    const near = closest(method, Object.keys(CONSTRAINT_METHODS));
    return ctx.report("CS_UNKNOWN_METHOD", e.expression.name, `C.${method} is not a constraint`, near ? `did you mean C.${near}?` : `constraints: ${Object.keys(CONSTRAINT_METHODS).map((m) => `C.${m}`).join(", ")}`);
  }
  const argNames = CONSTRAINT_ARGS[type]!;
  const dimension = type === "distance" || type === "angle" || type === "radius" || type === "diameter";
  const extra = dimension ? 2 : type === "tangent" || type === "fix" ? 1 : 0;
  const args = callArgs(ctx, e, `C.${method}`, argNames.length, argNames.length + extra, `C.${method}(${argNames.map((a) => `"${a}"`).join(", ")}${dimension ? ", value" : ""})`);
  if (!args) return undefined;
  const out: Record<string, unknown> = { type, id };
  let ok = true;
  argNames.forEach((a, i) => {
    const node = args[i]!;
    lf.sink.paths.set(`${kp}/${a}`, node);
    const s = readString(ctx, node, `C.${method} ${a}`);
    if (s === undefined) ok = false;
    else {
      out[a] = s;
      if (ts.isStringLiteral(node)) lf.sink.curveRefs.push({ sketch: lf.name, id: s, node });
    }
  });
  const rest = args.slice(argNames.length);
  if (dimension) {
    let opts: ts.Expression | undefined;
    if (rest[0] && ts.isObjectLiteralExpression(rest[0])) {
      opts = rest[0];
      if (rest[1]) ctx.report("CS_BAD_ARGUMENT", rest[1], "the options object comes last", `C.${method}(…, value, { driving: false })`);
    } else {
      if (rest[0]) {
        const v = lowerScalar(ctx, rest[0], `C.${method} value`, `${kp}/value`, lf.sink);
        if (v === undefined) ok = false;
        else out["value"] = v;
      }
      opts = rest[1];
    }
    if (opts) {
      const props = readObject(ctx, opts, `C.${method} options`, [], ["driving"]);
      const d = props?.get("driving");
      if (d) {
        lf.sink.paths.set(`${kp}/driving`, d.value);
        const b = readLiteralBool(ctx, d.value, "driving");
        if (b !== undefined) out["driving"] = b;
      }
    }
  } else if (type === "tangent" && rest[0]) {
    const props = readObject(ctx, rest[0], "C.tangent options", [], ["internal"]);
    const i = props?.get("internal");
    if (i) {
      lf.sink.paths.set(`${kp}/internal`, i.value);
      const b = readLiteralBool(ctx, i.value, "internal");
      if (b !== undefined) out["internal"] = b;
    }
  } else if (type === "fix" && rest[0]) {
    const props = readObject(ctx, rest[0], "C.fix position", [], ["x", "y"]);
    for (const k of ["x", "y"]) {
      const p = props?.get(k);
      if (!p) continue;
      const v = lowerScalar(ctx, p.value, `C.fix ${k}`, `${kp}/${k}`, lf.sink);
      if (v !== undefined) out[k] = v;
    }
  }
  return ok ? out : undefined;
}

// ── extrude / revolve ──

function readSketchRef(ctx: Ctx, e: ts.Expression, lf: LFeature, entry: NameEntry & { kind: "feature" }): string {
  lf.sink.paths.set("/sketch", e);
  if (ts.isIdentifier(e)) {
    const n = e.text;
    const ref = ctx.names.get(n);
    if (!ref) {
      if (ctx.declared.has(n)) {
        ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is used before it is declared`, `features run in file order: move \`const ${n} = sketch(…)\` above \`${lf.name}\``);
      } else {
        const sketches = [...ctx.names].filter(([, v]) => v.kind === "feature" && v.type === "sketch").map(([k]) => k);
        const near = closest(n, sketches);
        ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is not declared`, near ? `did you mean \`${near}\`?` : `declare it first: const ${n} = sketch(XY, { … })`);
      }
      return n;
    }
    if (ref.kind === "invalid") {
      ctx.broken = true;
      return n;
    }
    if (ref.kind !== "feature" || ref.type !== "sketch") {
      const is = ref.kind === "param" ? "a parameter" : ref.kind === "query" ? "a query" : `a ${ref.builtin}`;
      ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` is ${is}, not a sketch`, ref.kind === "feature" && ref.sketch ? `pass the sketch it was made from: \`${ref.sketch}\`` : "pass a sketch const");
      return n;
    }
    if (ref.part !== ctx.currentPart) {
      ctx.report("CS_UNRESOLVED_SKETCH", e, `\`${n}\` belongs to another part`, "features can only use sketches of their own part");
      return n;
    }
    entry.sketch = n;
    return ref.id;
  }
  if (calleeName(e) === "sketch") {
    ctx.report("CS_EXPR_UNSUPPORTED", e, "inline sketches are not supported", "declare the sketch as its own const, then pass its name");
    return "";
  }
  mismatch(ctx, e, "a sketch const", `${lf.builtin}()`);
  return "";
}

const SWEEP_HINTS: Readonly<Record<string, string>> = {
  depth: "use `distance` (mm)",
  height: "use `distance` (mm)",
  length: "use `distance` (mm)",
  reverse: 'use direction: "reverse"',
  symmetric: 'use direction: "symmetric"',
  flip: 'use direction: "reverse"',
  target: "spell it `targets`",
};

function lowerSweep(ctx: Ctx, call: ts.CallExpression, lf: LFeature, entry: NameEntry & { kind: "feature" }): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const isExtrude = lf.builtin === "extrude";
  const usage = isExtrude ? "const plate = extrude(base, { distance: 8 })" : "const body = revolve(profile, { axis: { origin: [0, 0], direction: [0, 1] }, angle: 360 })";
  const args = callArgs(ctx, call, lf.builtin, 2, 2, usage);
  if (!args) return ir;
  ir["sketch"] = readSketchRef(ctx, args[0]!, lf, entry);
  // Amendment set F: an extrude takes `distance`, or `throughAll: true`, or `upTo: plane`.
  const props = featureOptions(
    ctx,
    args[1],
    `${lf.builtin} options`,
    lf,
    isExtrude ? [] : ["axis", "angle"],
    isExtrude ? ["distance", "throughAll", "upTo", "direction", "regions", "op", "targets"] : ["direction", "regions", "op", "targets"],
    SWEEP_HINTS,
  );
  if (!props) return ir;
  const reg = props.get("regions");
  if (reg) {
    lf.sink.paths.set("/regions", reg.value);
    if (ts.isStringLiteral(reg.value)) {
      const s = readString(ctx, reg.value, "regions", ["all"]);
      if (s) ir["regions"] = s;
    } else if (ts.isArrayLiteralExpression(reg.value)) {
      const ids: string[] = [];
      reg.value.elements.forEach((el, k) => {
        lf.sink.paths.set(`/regions/${k}`, el);
        const s = ts.isExpression(el) ? readString(ctx, el, "a region curve id") : undefined;
        if (s !== undefined) {
          ids.push(s);
          if (ts.isStringLiteral(el) && entry.sketch) lf.sink.curveRefs.push({ sketch: entry.sketch, id: s, node: el });
        }
      });
      ir["regions"] = ids;
    } else mismatch(ctx, reg.value, '"all" or an array of curve ids', "regions");
  }
  if (isExtrude) {
    put(ir, "distance", scalar(ctx, props, "distance", "/distance", lf));
    const all = props.get("throughAll");
    const upTo = props.get("upTo");
    if (all) {
      lf.sink.paths.set("/extent", all.value);
      if (readLiteralBool(ctx, all.value, "throughAll") === true) ir["extent"] = "through_all";
    }
    if (upTo) {
      lf.sink.paths.set("/extent", upTo.value);
      const plane = lowerPlane(ctx, upTo.value, lf.sink, "/extent/up_to");
      if (plane !== undefined) ir["extent"] = { up_to: plane };
    }
    if (!props.has("distance") && !all && !upTo) {
      ctx.report("CS_BAD_ARGUMENT", args[1]!, "extrude needs a distance, throughAll: true or upTo: a plane", "{ distance: 8 }, { throughAll: true, op: \"cut\", targets: \"all\" } or { upTo: roof }");
    }
  } else {
    const axis = props.get("axis");
    if (axis) {
      lf.sink.paths.set("/axis", axis.value);
      const ap = readObject(ctx, axis.value, "axis", ["origin", "direction"], [], { dir: "spell it `direction`" });
      const origin = ap ? vec(ctx, ap.get("origin")?.value, 2, "axis origin", "/axis/origin", lf.sink) : undefined;
      const direction = ap ? vec(ctx, ap.get("direction")?.value, 2, "axis direction", "/axis/direction", lf.sink, "ratio") : undefined;
      if (origin && direction) ir["axis"] = { origin, direction };
    }
    put(ir, "angle", scalar(ctx, props, "angle", "/angle", lf));
  }
  put(ir, "direction", enumProp(ctx, props, "direction", ["normal", "reverse", "symmetric"], lf));
  put(ir, "op", enumProp(ctx, props, "op", ["new_body", "join", "cut", "intersect"], lf));
  const t = props.get("targets");
  if (t) put(ir, "targets", lowerTargets(ctx, t.value, lf.sink, "/targets"));
  return ir;
}

function lowerBoolean(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "boolean", 2, 2, 'const merged = boolean("join", { targets: floor, tools: walls })');
  if (!args) return ir;
  lf.sink.paths.set("/op", args[0]!);
  put(ir, "op", readString(ctx, args[0]!, "the boolean op", ["join", "cut", "intersect"]));
  const props = featureOptions(ctx, args[1], "boolean options", lf, ["targets", "tools"], ["keepTools"], { tool: "spell it `tools`", target: "spell it `targets`" });
  if (!props) return ir;
  for (const k of ["targets", "tools"]) {
    const p = props.get(k)!;
    if (ts.isStringLiteral(p.value)) {
      ctx.report("CS_BAD_ARGUMENT", p.value, `boolean ${k} must be bodies, not a string`, "use a body query or a feature, e.g. slab");
      continue;
    }
    put(ir, k, lowerRef(ctx, p.value, lf.sink, `/${k}`, { fallback: "body", bodyHandle: true }));
  }
  const kt = props.get("keepTools");
  if (kt) put(ir, "keep_tools", lowerBoolScalar(ctx, kt.value, "keepTools", "/keep_tools", lf.sink));
  return ir;
}

// ── transform (amendment set F) ──

function lowerTransform(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const usage = "const moved = transform(slab, { translate: [30, 0, 0], rotate: { axis: Z, angle: 90 }, copy: true })";
  const args = callArgs(ctx, call, "transform", 2, 2, usage);
  if (!args) return ir;
  if (ts.isStringLiteral(args[0]!)) {
    ctx.report("CS_BAD_ARGUMENT", args[0]!, "transform moves bodies, not a string", "use a body query or a feature, e.g. slab");
    return ir;
  }
  put(ir, "bodies", lowerRef(ctx, args[0]!, lf.sink, "/bodies", { fallback: "body", bodyHandle: true }));
  const props = featureOptions(ctx, args[1], "transform options", lf, [], ["translate", "rotate", "copy"]);
  if (!props) return ir;
  const t = props.get("translate");
  if (t) put(ir, "translate", vec(ctx, t.value, 3, "translate", "/translate", lf.sink, "length"));
  const r = props.get("rotate");
  if (r) {
    lf.sink.paths.set("/rotate", r.value);
    const rp = readObject(ctx, r.value, "rotate", ["axis", "angle"], []);
    if (rp) {
      put(ir, "rotate", {
        axis: lowerAxis(ctx, rp.get("axis")!.value, lf.sink, "/rotate/axis"),
        angle: lowerScalar(ctx, rp.get("angle")!.value, "rotate angle", "/rotate/angle", lf.sink),
      });
    }
  }
  const c = props.get("copy");
  if (c) put(ir, "copy", lowerBoolScalar(ctx, c.value, "copy", "/copy", lf.sink));
  return ir;
}

// ── hole ──

function lowerHole(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "hole", 2, 2, 'hole(slab.cap("end"), { at: grid({ nx: 2, ny: 2, dx: 60, dy: 30 }), size: "M4", depth: "through" })');
  if (!args) return ir;
  put(ir, "on", lowerPlane(ctx, args[0]!, lf.sink, "/on"));
  const props = featureOptions(
    ctx,
    args[1],
    "hole options",
    lf,
    ["at"],
    ["size", "fit", "d", "depth", "tip", "cbore", "csink", "insert", "thread", "flip", "targets"],
    { diameter: "use `d` (mm) or a standard `size`", positions: "use `at`", counterbore: "use `cbore`", countersink: "use `csink`" },
  );
  if (!props) return ir;
  const flip = props.get("flip");
  if (flip) put(ir, "flip", lowerBoolScalar(ctx, flip.value, "flip", "/flip", lf.sink));
  put(ir, "at", lowerPlacement(ctx, props.get("at")!.value, lf));
  const size = props.get("size");
  if (size) {
    lf.sink.paths.set("/size", size.value);
    put(ir, "size", readString(ctx, size.value, "size"));
  }
  put(ir, "fit", enumProp(ctx, props, "fit", ["close", "normal", "loose", "tap"], lf));
  put(ir, "d", scalar(ctx, props, "d", "/d", lf, "hole d"));
  const depth = props.get("depth");
  if (depth) {
    lf.sink.paths.set("/depth", depth.value);
    const v = depth.value;
    if (ts.isStringLiteral(v)) put(ir, "depth", readString(ctx, v, "depth", ["through"]));
    else {
      const dp = readObject(ctx, v, "depth", [], ["blind", "upTo"], { up_to: "CadScript spells it `upTo`", through: 'write depth: "through"' });
      if (dp) {
        if (dp.size !== 1) ctx.report("CS_BAD_ARGUMENT", v, "depth is exactly one of \"through\", { blind: h } or { upTo: face }", undefined);
        else if (dp.has("blind")) put(ir, "depth", optionalObj({ blind: lowerScalar(ctx, dp.get("blind")!.value, "blind depth", "/depth/blind", lf.sink) }));
        else put(ir, "depth", optionalObj({ up_to: lowerRef(ctx, dp.get("upTo")!.value, lf.sink, "/depth/up_to", { fallback: "face" }) }));
      }
    }
  }
  const tip = props.get("tip");
  if (tip) {
    if (ts.isStringLiteral(tip.value)) {
      lf.sink.paths.set("/tip", tip.value);
      put(ir, "tip", readString(ctx, tip.value, "tip", ["flat"]));
    } else put(ir, "tip", lowerScalar(ctx, tip.value, "tip angle", "/tip", lf.sink));
  }
  const head = (key: string, preset: string, fields: readonly string[], required: readonly string[]): void => {
    const p = props.get(key);
    if (!p) return;
    lf.sink.paths.set(`/${key}`, p.value);
    if (ts.isStringLiteral(p.value)) {
      put(ir, key, readString(ctx, p.value, key, [preset]));
      return;
    }
    const o = readObject(ctx, p.value, key, required, fields.filter((f) => !required.includes(f)));
    if (!o) return;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const fp = o.get(f);
      if (fp) put(out, f, lowerScalar(ctx, fp.value, `${key} ${f}`, `/${key}/${f}`, lf.sink));
    }
    ir[key] = out;
  };
  head("cbore", "iso4762", ["d", "depth"], ["d", "depth"]);
  head("csink", "iso10642", ["d", "angle"], ["d"]);
  head("insert", "std", ["d", "depth"], ["d", "depth"]);
  const thread = props.get("thread");
  if (thread) {
    lf.sink.paths.set("/thread", thread.value);
    if (thread.value.kind === ts.SyntaxKind.TrueKeyword || thread.value.kind === ts.SyntaxKind.FalseKeyword) ir["thread"] = thread.value.kind === ts.SyntaxKind.TrueKeyword;
    else {
      const o = readObject(ctx, thread.value, "thread", [], ["pitch", "depth"]);
      if (o) {
        const out: Record<string, unknown> = {};
        for (const f of ["pitch", "depth"]) {
          const fp = o.get(f);
          if (fp) put(out, f, lowerScalar(ctx, fp.value, `thread ${f}`, `/thread/${f}`, lf.sink));
        }
        ir["thread"] = out;
      }
    }
  }
  const t = props.get("targets");
  if (t) put(ir, "targets", lowerTargets(ctx, t.value, lf.sink, "/targets"));
  return ir;
}

function optionalObj(o: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.values(o).every((v) => v !== undefined) ? o : undefined;
}

function lowerPlacement(ctx: Ctx, e: ts.Expression, lf: LFeature): Record<string, unknown> | undefined {
  lf.sink.paths.set("/at", e);
  const callee = calleeName(e);
  if (callee === "grid" || callee === "boltCircle") {
    const call = e as ts.CallExpression;
    ctx.use(callee, call.expression);
    const isGrid = callee === "grid";
    const args = callArgs(ctx, call, callee, 1, 1, isGrid ? "grid({ nx: 2, ny: 2, dx: 60, dy: 30 })" : "boltCircle({ n: 4, d: 50 })");
    const props = args ? readObject(ctx, args[0]!, `${callee}()`, isGrid ? ["nx", "ny", "dx", "dy"] : ["n", "d"], isGrid ? ["center"] : ["center", "start"], { diameter: "the bolt-circle diameter is `d`", r: "give the diameter `d`" }) : undefined;
    if (!props) return undefined;
    const base = isGrid ? "/at/grid" : "/at/circle";
    const out: Record<string, unknown> = {};
    for (const k of isGrid ? ["nx", "ny", "dx", "dy"] : ["n", "d"]) put(out, k, lowerScalar(ctx, props.get(k)!.value, `${callee} ${k}`, `${base}/${k}`, lf.sink));
    const c = props.get("center");
    if (c) put(out, "center", vec(ctx, c.value, 2, `${callee} center`, `${base}/center`, lf.sink));
    const st = props.get("start");
    if (st) put(out, "start", lowerScalar(ctx, st.value, "boltCircle start", `${base}/start`, lf.sink));
    return { [isGrid ? "grid" : "circle"]: out };
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "points") {
    const recv = e.expression.expression;
    if (!ts.isIdentifier(recv)) return mismatch(ctx, recv, "a sketch const", "points()");
    const h = resolveHandle(ctx, recv, "points()");
    if (!h) return undefined;
    lf.sink.paths.set("/at/points/sketch", recv);
    const ids: string[] = [];
    let ok = true;
    e.arguments.forEach((a, k) => {
      lf.sink.paths.set(`/at/points/ids/${k}`, a);
      const s = readString(ctx, a, "a point id");
      if (s === undefined) ok = false;
      else {
        ids.push(s);
        if (ts.isStringLiteral(a)) lf.sink.curveRefs.push({ sketch: recv.text, id: s, node: a });
      }
    });
    if (!ok) return undefined;
    return { points: { sketch: h.id, ids: ids.length === 0 ? "all" : ids } };
  }
  if (ts.isObjectLiteralExpression(e)) {
    const list: Record<string, unknown>[] = [];
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) {
        ctx.report("CS_BAD_ARGUMENT", p, "positions are `id: [u, v]` properties", "write `a: [10, 10]`");
        continue;
      }
      const id = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : undefined;
      if (id === undefined) {
        ctx.report("CS_BAD_ARGUMENT", p.name, "position ids must be identifiers", undefined);
        continue;
      }
      const k = list.length;
      lf.sink.paths.set(`/at/list/${k}`, p);
      lf.sink.paths.set(`/at/list/${k}/id`, p.name);
      const at = vec(ctx, p.initializer, 2, `position ${shownText(id)}`, `/at/list/${k}/at`, lf.sink);
      if (at) list.push({ id, at });
    }
    return { list };
  }
  return mismatch(ctx, e, "grid({ … }), boltCircle({ … }), sketch.points(…) or { id: [u, v], … }", "the hole positions `at`");
}

// ── fillet, chamfer, shell, draft ──

function lowerBlend(ctx: Ctx, call: ts.CallExpression, lf: LFeature, builtin: "fillet" | "chamfer"): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const usage = builtin === "fillet" ? "fillet(slab.sides().edges().parallel(Z), { r: 2 })" : 'chamfer(slab.cap("end").edges(), { d: 1 })';
  const args = callArgs(ctx, call, builtin, 2, 2, usage);
  if (!args) return ir;
  put(ir, "edges", lowerRef(ctx, args[0]!, lf.sink, "/edges", { fallback: "edge" }));
  const isFillet = builtin === "fillet";
  const props = featureOptions(ctx, args[1], `${builtin} options`, lf, isFillet ? ["r"] : ["d"], isFillet ? ["tangentChain"] : ["d2", "angle", "side", "tangentChain"], {
    radius: "use `r`",
    distance: "use `d`",
  });
  if (!props) return ir;
  if (isFillet) put(ir, "r", scalar(ctx, props, "r", "/r", lf, "fillet r"));
  else {
    put(ir, "d", scalar(ctx, props, "d", "/d", lf, "chamfer d"));
    put(ir, "d2", scalar(ctx, props, "d2", "/d2", lf, "chamfer d2"));
    put(ir, "angle", scalar(ctx, props, "angle", "/angle", lf, "chamfer angle"));
    const side = props.get("side");
    if (side) put(ir, "side", lowerRef(ctx, side.value, lf.sink, "/side", { fallback: "face" }));
  }
  const tc = props.get("tangentChain");
  if (tc) put(ir, "tangent_chain", lowerBoolScalar(ctx, tc.value, "tangentChain", "/tangent_chain", lf.sink));
  return ir;
}

function lowerShell(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "shell", 2, 2, 'shell(box, { open: box.cap("end"), thickness: 2 })');
  if (!args) return ir;
  put(ir, "body", lowerRef(ctx, args[0]!, lf.sink, "/body", { fallback: "body", bodyHandle: true }));
  const props = featureOptions(ctx, args[1], "shell options", lf, ["thickness"], ["open", "direction"], { wall: "use `thickness`" });
  if (!props) return ir;
  const open = props.get("open");
  if (open) put(ir, "open", lowerRef(ctx, open.value, lf.sink, "/open", { fallback: "face" }));
  put(ir, "thickness", scalar(ctx, props, "thickness", "/thickness", lf));
  put(ir, "direction", enumProp(ctx, props, "direction", ["inward", "outward"], lf));
  return ir;
}

function lowerDraft(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "draft", 2, 2, "draft(cup.sides(), { neutral: XY, angle: 2 })");
  if (!args) return ir;
  put(ir, "faces", lowerRef(ctx, args[0]!, lf.sink, "/faces", { fallback: "face" }));
  const props = featureOptions(ctx, args[1], "draft options", lf, ["neutral", "angle"], ["pull"]);
  if (!props) return ir;
  put(ir, "neutral", lowerPlane(ctx, props.get("neutral")!.value, lf.sink, "/neutral"));
  put(ir, "angle", scalar(ctx, props, "angle", "/angle", lf, "draft angle"));
  put(ir, "pull", enumProp(ctx, props, "pull", ["normal", "reverse"], lf));
  return ir;
}

// ── patterns ──

function lowerPattern(ctx: Ctx, call: ts.CallExpression, lf: LFeature, builtin: "linearPattern" | "circularPattern" | "mirror"): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const usage =
    builtin === "linearPattern" ? "linearPattern([boss], { dir: X, count: 4, spacing: 20 })" : builtin === "circularPattern" ? "circularPattern([slotCut], { axis: Z, count: 6 })" : "mirror([arm], { plane: YZ })";
  const args = callArgs(ctx, call, builtin, 2, 2, usage);
  if (!args) return ir;
  const seed = args[0]!;
  lf.sink.paths.set("/seed", seed);
  if (ts.isArrayLiteralExpression(seed)) {
    const ids: string[] = [];
    seed.elements.forEach((el, k) => {
      lf.sink.paths.set(`/seed/features/${k}`, el);
      if (!ts.isIdentifier(el)) {
        mismatch(ctx, el, "a feature const (extrude, revolve or hole)", "a pattern seed");
        return;
      }
      const h = resolveHandle(ctx, el, "a pattern seed");
      if (h) ids.push(h.id);
    });
    ir["seed"] = { features: ids };
  } else {
    const r = lowerRef(ctx, seed, lf.sink, "/seed/bodies", { fallback: "body", bodyHandle: true });
    if (r) ir["seed"] = { bodies: r };
  }
  const specific =
    builtin === "linearPattern" ? ["dir", "count", "spacing", "dir2", "count2", "spacing2"] : builtin === "circularPattern" ? ["axis", "count", "angle"] : ["plane"];
  const required = builtin === "linearPattern" ? ["dir", "count", "spacing"] : builtin === "circularPattern" ? ["axis", "count"] : ["plane"];
  const props = featureOptions(ctx, args[1], `${builtin} options`, lf, required, [...specific.filter((k) => !required.includes(k)), "skip", "op", "targets"], {
    direction: "use `dir`",
    n: "use `count`",
    instances: "use `count`",
  });
  if (!props) return ir;
  if (builtin === "linearPattern") {
    const lp = "/layout/linear";
    const out: Record<string, unknown> = {};
    put(out, "dir", lowerDir(ctx, props.get("dir")!.value, lf.sink, `${lp}/dir`));
    put(out, "count", scalar(ctx, props, "count", `${lp}/count`, lf));
    put(out, "spacing", scalar(ctx, props, "spacing", `${lp}/spacing`, lf));
    const d2 = props.get("dir2");
    if (d2) put(out, "dir2", lowerDir(ctx, d2.value, lf.sink, `${lp}/dir2`));
    put(out, "count2", scalar(ctx, props, "count2", `${lp}/count2`, lf));
    put(out, "spacing2", scalar(ctx, props, "spacing2", `${lp}/spacing2`, lf));
    ir["layout"] = { linear: out };
  } else if (builtin === "circularPattern") {
    const cp = "/layout/circular";
    const out: Record<string, unknown> = {};
    put(out, "axis", lowerAxis(ctx, props.get("axis")!.value, lf.sink, `${cp}/axis`));
    put(out, "count", scalar(ctx, props, "count", `${cp}/count`, lf));
    put(out, "angle", scalar(ctx, props, "angle", `${cp}/angle`, lf));
    ir["layout"] = { circular: out };
  } else {
    ir["layout"] = { mirror: { plane: lowerPlane(ctx, props.get("plane")!.value, lf.sink, "/layout/mirror/plane") } };
  }
  const skip = props.get("skip");
  if (skip) {
    lf.sink.paths.set("/skip", skip.value);
    if (!ts.isArrayLiteralExpression(skip.value)) mismatch(ctx, skip.value, "an array of instance indices [[i], …]", "skip");
    else {
      const out: number[][] = [];
      skip.value.elements.forEach((el, k) => {
        lf.sink.paths.set(`/skip/${k}`, el);
        if (!ts.isArrayLiteralExpression(el)) {
          mismatch(ctx, el, "an instance index [i] or [i, j]", "skip entry");
          return;
        }
        const idx: number[] = [];
        for (const x of el.elements) {
          const n = ts.isExpression(x) ? readLiteralInt(ctx, x, "skip index") : undefined;
          if (n !== undefined) idx.push(n);
        }
        out.push(idx);
      });
      ir["skip"] = out;
    }
  }
  put(ir, "op", enumProp(ctx, props, "op", ["new_body", "join"], lf));
  const t = props.get("targets");
  if (t) put(ir, "targets", lowerTargets(ctx, t.value, lf.sink, "/targets"));
  return ir;
}

// ── datums and tags ──

/** The datum-plane form implied by the CadScript keys (§3.3); the printer uses the same rule. */
export function inferDatumPlaneMode(keys: ReadonlySet<string>): string | undefined {
  if (keys.has("offset")) return "offset";
  if (keys.has("midplane")) return "midplane";
  if (keys.has("through")) return "through";
  if (keys.has("from") || keys.has("axis") || keys.has("angle")) return "angle";
  if (keys.has("distance")) return "offset";
  if (keys.has("origin") || keys.has("normal") || keys.has("xDir")) return "frame";
  if (keys.has("a") || keys.has("b")) return "midplane";
  if (keys.has("points")) return "through";
  return undefined;
}

/** The datum-axis form implied by the CadScript keys (§3.4). */
export function inferDatumAxisMode(keys: ReadonlySet<string>): string | undefined {
  if (keys.has("edge")) return "edge";
  if (keys.has("cylinder") || keys.has("face")) return "cylinder";
  if (keys.has("planes") || keys.has("a") || keys.has("b")) return "planes";
  if (keys.has("points")) return "points";
  return undefined;
}

function pair(ctx: Ctx, e: ts.Expression, n: number, what: string): readonly ts.Expression[] | undefined {
  if (!ts.isArrayLiteralExpression(e) || e.elements.length !== n || e.elements.some((x) => !ts.isExpression(x) || ts.isSpreadElement(x) || ts.isOmittedExpression(x))) {
    return mismatch(ctx, e, `an array of ${n}`, what);
  }
  return e.elements as readonly ts.Expression[];
}

function lowerDatumPlane(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "datumPlane", 1, 1, "datumPlane({ offset: XY, distance: 10 })");
  if (!args) return ir;
  const keys = ["offset", "from", "distance", "axis", "angle", "midplane", "a", "b", "through", "points", "origin", "normal", "xDir", "mode"];
  const props = featureOptions(ctx, args[0], "datumPlane options", lf, [], keys);
  if (!props) return ir;
  const modeProp = props.get("mode");
  let mode: string | undefined;
  if (modeProp) {
    lf.sink.paths.set("/mode", modeProp.value);
    mode = readString(ctx, modeProp.value, "mode", ["offset", "angle", "midplane", "through", "frame"]);
  } else {
    mode = inferDatumPlaneMode(new Set(props.keys()));
    if (!mode) ctx.report("CS_BAD_ARGUMENT", args[0]!, "datumPlane needs a form", "{ offset: XY, distance: 10 }, { from, axis, angle }, { midplane: [a, b] }, { through: [p0, p1, p2] } or { origin, normal, xDir }");
  }
  if (mode) ir["mode"] = mode;
  if (props.has("offset") && props.has("from")) ctx.report("CS_BAD_ARGUMENT", props.get("offset")!.key, "`offset` and `from` both give the base plane", "keep one of them");
  const from = props.get("offset") ?? props.get("from");
  if (from) put(ir, "from", lowerPlane(ctx, from.value, lf.sink, "/from"));
  put(ir, "distance", scalar(ctx, props, "distance", "/distance", lf));
  const axis = props.get("axis");
  if (axis) put(ir, "axis", lowerAxis(ctx, axis.value, lf.sink, "/axis"));
  put(ir, "angle", scalar(ctx, props, "angle", "/angle", lf));
  const mid = props.get("midplane");
  if (mid) {
    lf.sink.paths.set("/midplane", mid.value);
    const ab = pair(ctx, mid.value, 2, "midplane");
    if (ab) {
      put(ir, "a", lowerPlane(ctx, ab[0]!, lf.sink, "/a"));
      put(ir, "b", lowerPlane(ctx, ab[1]!, lf.sink, "/b"));
    }
  }
  for (const k of ["a", "b"]) {
    const p = props.get(k);
    if (p) put(ir, k, lowerPlane(ctx, p.value, lf.sink, `/${k}`));
  }
  const pts = props.get("through") ?? props.get("points");
  if (pts) {
    lf.sink.paths.set("/points", pts.value);
    const three = pair(ctx, pts.value, 3, "through");
    const lowered = three?.map((p, k) => lowerPoint(ctx, p, lf.sink, `/points/${k}`));
    if (lowered && lowered.every((p) => p !== undefined)) ir["points"] = lowered;
  }
  for (const [cs, irk, field] of [
    ["origin", "origin", "length"],
    ["normal", "normal", "ratio"],
    ["xDir", "x_dir", "ratio"],
  ] as const) {
    const p = props.get(cs);
    if (p) put(ir, irk, vec(ctx, p.value, 3, cs, `/${irk}`, lf.sink, field));
  }
  return ir;
}

function lowerDatumAxis(ctx: Ctx, call: ts.CallExpression, lf: LFeature): Record<string, unknown> {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "datumAxis", 1, 1, 'datumAxis({ cylinder: boss.side("ring") })');
  if (!args) return ir;
  const props = featureOptions(ctx, args[0], "datumAxis options", lf, [], ["edge", "cylinder", "face", "planes", "a", "b", "points", "flip", "mode"]);
  if (!props) return ir;
  const modeProp = props.get("mode");
  let mode: string | undefined;
  if (modeProp) {
    lf.sink.paths.set("/mode", modeProp.value);
    mode = readString(ctx, modeProp.value, "mode", ["edge", "cylinder", "planes", "points"]);
  } else {
    mode = inferDatumAxisMode(new Set(props.keys()));
    if (!mode) ctx.report("CS_BAD_ARGUMENT", args[0]!, "datumAxis needs a form", "{ edge }, { cylinder }, { planes: [a, b] } or { points: [a, b] }");
  }
  if (mode) ir["mode"] = mode;
  const edge = props.get("edge");
  if (edge) put(ir, "edge", lowerRef(ctx, edge.value, lf.sink, "/edge", { fallback: "edge" }));
  const face = props.get("cylinder") ?? props.get("face");
  if (face) put(ir, "face", lowerRef(ctx, face.value, lf.sink, "/face", { fallback: "face" }));
  const planes = props.get("planes");
  if (planes) {
    lf.sink.paths.set("/planes", planes.value);
    const ab = pair(ctx, planes.value, 2, "planes");
    if (ab) {
      put(ir, "a", lowerPlane(ctx, ab[0]!, lf.sink, "/a"));
      put(ir, "b", lowerPlane(ctx, ab[1]!, lf.sink, "/b"));
    }
  }
  for (const k of ["a", "b"]) {
    const p = props.get(k);
    if (p) put(ir, k, lowerPlane(ctx, p.value, lf.sink, `/${k}`));
  }
  const pts = props.get("points");
  if (pts) {
    lf.sink.paths.set("/points", pts.value);
    const two = pair(ctx, pts.value, 2, "points");
    const lowered = two?.map((p, k) => lowerPoint(ctx, p, lf.sink, `/points/${k}`));
    if (lowered && lowered.every((p) => p !== undefined)) ir["points"] = lowered;
  }
  const flip = props.get("flip");
  if (flip) put(ir, "flip", lowerBoolScalar(ctx, flip.value, "flip", "/flip", lf.sink));
  return ir;
}

function lowerTag(ctx: Ctx, call: ts.CallExpression, lf: LFeature): { ir: Record<string, unknown>; kind: string | undefined } {
  const ir: Record<string, unknown> = {};
  const args = callArgs(ctx, call, "tag", 1, 2, 'const top = tag(slab.cap("end"))');
  if (!args) return { ir, kind: undefined };
  const r = lowerRef(ctx, args[0]!, lf.sink, "/target", { fallback: "face" });
  if (r) ir["target"] = r;
  if (args[1]) featureOptions(ctx, args[1], "tag options", lf, [], []);
  return { ir, kind: r?.kind };
}

// ─── Identity against base: captures and curve renames ───────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Every Ref (an object with `kind` and `q`) of a feature, by path relative to the feature. */
function refsOf(v: unknown, path: string, out: Map<string, Obj>): Map<string, Obj> {
  if (Array.isArray(v)) v.forEach((x, i) => refsOf(x, `${path}/${i}`, out));
  else if (isObj(v)) {
    if ("kind" in v && "q" in v) out.set(path, v);
    for (const [k, x] of Object.entries(v)) if (k !== "capture") refsOf(x, `${path}/${k}`, out);
  }
  return out;
}

/** Query equality ignoring the captures of Refs nested in it (axis objects of directions). */
function sameQuery(a: unknown, b: unknown): boolean {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (isObj(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "capture").map(([k, x]) => [k, strip(x)]));
    return v;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function carryCaptures(ctx: Ctx, doc: v1.IrDocument, base: v1.IrDocument, parts: LPart[]): void {
  const baseById = new Map<string, Obj>();
  for (const p of base.parts) for (const f of p.features) baseById.set(f.id, f as unknown as Obj);
  doc.parts.forEach((p, pi) => {
    p.features.forEach((f, fi) => {
      const b = baseById.get(f.id);
      if (!b || b["type"] !== f.type) return;
      const baseRefs = refsOf(b, "", new Map());
      for (const [path, ref] of refsOf(f, "", new Map())) {
        const old = baseRefs.get(path);
        if (!old || !("capture" in old)) continue;
        if (old["kind"] === ref["kind"] && sameQuery(old["q"], ref["q"])) {
          ref["capture"] = old["capture"];
        } else {
          const lf = parts[pi]?.features[fi];
          const node = lf?.sink.paths.get(path) ?? lf?.stmt;
          if (node) ctx.report("CS_CAPTURE_DROPPED", node, `the reference at ${path} changed since the base IR: its capture was not carried over`, undefined, false);
        }
      }
    });
  });
}

function detectCurveRenames(ctx: Ctx, doc: v1.IrDocument, base: v1.IrDocument, parts: LPart[]): void {
  const baseById = new Map<string, v1.Feature>();
  for (const p of base.parts) for (const f of p.features) baseById.set(f.id, f);
  const strip = (c: Obj): string => {
    const { id: _id, ...rest } = c;
    return JSON.stringify(rest);
  };
  doc.parts.forEach((p, pi) => {
    p.features.forEach((f, fi) => {
      if (f.type !== "sketch") return;
      const b = baseById.get(f.id);
      if (!b || b.type !== "sketch") return;
      const newIds = new Set(f.curves.map((c) => c.id));
      const oldIds = new Set(b.curves.map((c) => c.id));
      const added = f.curves.filter((c) => !oldIds.has(c.id));
      const removed = b.curves.filter((c) => !newIds.has(c.id));
      if (added.length !== 1 || removed.length !== 1) return;
      const nc = added[0]!;
      const oc = removed[0]!;
      if (strip(nc as unknown as Obj) !== strip(oc as unknown as Obj)) return;
      const lf = parts[pi]?.features[fi];
      if (!lf) return;
      const keyNode = lf.curves.find((c) => c.id === nc.id)?.keyNode;
      if (!keyNode) return;
      // Every curve reference to the old id in this part: queries of the sketch's consumers,
      // regions, hole point ids, and the sketch's own constraint arguments.
      const edits: FixEdit[] = [];
      const edited = new Set<ts.Node>(); // (a query alias used by several features holds one literal)
      for (const other of parts[pi]!.features) {
        for (const ref of other.sink.curveRefs) {
          if (ref.sketch !== lf.name || edited.has(ref.node)) continue;
          if (ref.id === oc.id || ref.id.startsWith(`${oc.id}.`)) {
            edited.add(ref.node);
            edits.push({ span: ctx.span(ref.node), newText: JSON.stringify(nc.id + ref.id.slice(oc.id.length)) });
          }
        }
      }
      const d: DiagnosticV1 = {
        code: "CS_RENAME_DETECTED",
        severity: "info",
        message: `curve ${shownText(nc.id, '"')} of \`${lf.name}\` has the same geometry as the removed ${shownText(oc.id, '"')}: treated as a rename`,
        hint:
          edits.length > 0
            ? `apply the fix to rewrite the ${edits.length} reference${edits.length === 1 ? "" : "s"} to "${oc.id}" (renames resolve exactly, never through a geometric match)`
            : "no reference uses the old id",
        span: ctx.span(keyNode),
      };
      if (edits.length > 0) d.fix = { title: `rename references "${oc.id}" → "${nc.id}"`, edits };
      ctx.diagnostics.push(d);
    });
  });
}

export { checkAtField };
