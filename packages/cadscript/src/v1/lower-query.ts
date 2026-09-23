/**
 * Lowering references (SPEC-v1 §5.10): query method chains → the query AST, with a bijection
 * between calls and AST nodes, plus the planes, axes, directions, points and targets that wrap
 * them (§3). Static typing (kinds, feature types, curve ids) is IR validation's; its problems
 * point back at the nodes recorded here (`<field>/q/of/feature` → the handle identifier, …).
 */
import ts from "typescript";
import type { v1 } from "@aicad/ir-types";
import {
  callArgs,
  calleeName,
  MAX_ALIAS_EXPANSIONS,
  mismatch,
  readLiteralBool,
  readLiteralInt,
  readObject,
  readString,
  shownText,
  type Ctx,
  type NameEntry,
  type Sink,
} from "./context.js";
import { lowerBoolScalar, lowerScalar } from "./lower-expr.js";
import { ALL_HANDLE_METHODS, AXIS_CONSTANTS, HOLE_PARTS, PLANE_CONSTANTS, QUERY_METHODS, SIGNED_DIRS, TYPE_FILTERS } from "./syntax.js";

type Query = v1.Query;
type Ref = v1.Ref;
type Kind = "face" | "edge" | "vertex" | "body";
type FeatureEntry = Extract<NameEntry, { kind: "feature" }>;
type AliasEntry = Extract<NameEntry, { kind: "query" }>;

const CARD_METHODS = ["one", "some", "any", "exactly"];

/** The static kind of a query (§5.4), without reporting; undefined when unknown. */
export function queryKind(q: Query | undefined, tagKinds: ReadonlyMap<string, string>): Kind | undefined {
  if (!q) return undefined;
  switch (q.op) {
    case "body":
    case "bodies":
    case "owner":
      return "body";
    case "cap":
    case "endcap":
    case "side":
    case "sides":
    case "hole_face":
    case "created":
    case "instance":
    case "faces":
      return "face";
    case "edge_at":
    case "between":
    case "edges":
      return "edge";
    case "vertices":
      return "vertex";
    case "tagged":
      return tagKinds.get(q.feature) as Kind | undefined;
    case "union":
    case "intersect":
      for (const sub of q.of) {
        const k = queryKind(sub, tagKinds);
        if (k) return k;
      }
      return undefined;
    case "minus":
      return queryKind(q.a, tagKinds);
    default:
      return queryKind((q as { of: Query }).of, tagKinds);
  }
}

/** Resolve an identifier used as a feature handle (reports when it is not one). */
export function resolveHandle(ctx: Ctx, e: ts.Identifier, what: string): FeatureEntry | undefined {
  const entry = ctx.names.get(e.text);
  if (entry?.kind === "feature") return entry;
  if (entry?.kind === "invalid") {
    ctx.broken = true;
    return undefined;
  }
  if (entry?.kind === "param") {
    return ctx.report("CS_BAD_ARGUMENT", e, `\`${e.text}\` is a parameter, not a feature`, `${what} expects a feature or a query, e.g. slab.cap("end")`);
  }
  if (entry?.kind === "query") {
    return ctx.report("CS_BAD_ARGUMENT", e, `\`${e.text}\` is a query, not a feature`, `${what} needs the feature itself: use the handle the query starts at`);
  }
  if (ctx.declared.has(e.text)) {
    return ctx.report("CS_USED_BEFORE_DECLARED", e, `\`${e.text}\` is used before it is declared`, `move \`const ${e.text} = …\` above this statement: features run in file order`);
  }
  if ([...PLANE_CONSTANTS, ...AXIS_CONSTANTS].includes(e.text)) {
    return ctx.report("CS_BAD_ARGUMENT", e, `\`${e.text}\` is not a feature`, `${what} expects a feature or a query here`);
  }
  return ctx.report("UNRESOLVED_FEATURE", e, `\`${e.text}\` is not a feature declared above`, "reference a feature const declared earlier in this part");
}

function isCardCall(e: ts.Expression): e is ts.CallExpression & { expression: ts.PropertyAccessExpression } {
  return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && CARD_METHODS.includes(e.expression.name.text);
}

function stripParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** The query alias an identifier names, if it does. */
function aliasOf(ctx: Ctx, e: ts.Expression): AliasEntry | undefined {
  if (!ts.isIdentifier(e)) return undefined;
  const entry = ctx.names.get(e.text);
  return entry?.kind === "query" ? entry : undefined;
}

/** Count an alias expansion of the current statement; reports (once) beyond the bound. */
function expandOk(ctx: Ctx, use: ts.Identifier): boolean {
  if (++ctx.aliasExpansions <= MAX_ALIAS_EXPANSIONS) return true;
  if (ctx.aliasExpansions === MAX_ALIAS_EXPANSIONS + 1) {
    ctx.report(
      "CS_TOO_COMPLEX",
      use,
      `query aliases expand to more than ${MAX_ALIAS_EXPANSIONS} queries in this statement`,
      "aliases are written out at every use: use tag() for a named, reusable reference",
    );
  }
  ctx.broken = true;
  return false;
}

/** The count at the end of a reference (`.one()`, `.exactly(4)`, …), and the query before it. */
function takeCard(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): { card: v1.Cardinality | undefined; qe: ts.Expression } | undefined {
  const qe = stripParens(e);
  if (!isCardCall(qe)) return { card: undefined, qe };
  const m = qe.expression.name.text;
  sink.paths.set(`${path}/card`, qe.expression.name);
  if (m === "exactly") {
    const a = callArgs(ctx, qe, ".exactly", 1, 1, ".exactly(4)");
    const n = a ? readLiteralInt(ctx, a[0]!, ".exactly()") : undefined;
    if (n === undefined) return undefined;
    return { card: n, qe: stripParens(qe.expression.expression) };
  }
  if (!callArgs(ctx, qe, `.${m}`, 0, 0, `.${m}()`)) return undefined;
  return { card: m as v1.CardWord, qe: stripParens(qe.expression.expression) };
}

function readEnd(ctx: Ctx, e: ts.Expression | undefined, call: ts.Node, what: string): "start" | "end" | undefined {
  if (!e) return ctx.report("CS_BAD_ARGUMENT", call, `${what} needs "start" or "end"`, `write ${what}("end")`);
  return readString(ctx, e, `${what} end`, ["start", "end"]) as "start" | "end" | undefined;
}

/** `{ body: "curve" }` of cap/endcap/sides. */
function readMember(ctx: Ctx, e: ts.Expression | undefined, what: string, sink: Sink, path: string, sketch: string | undefined): string | undefined | null {
  if (!e) return undefined;
  const props = readObject(ctx, e, `${what} options`, [], ["body"], { member: "the option is `body`: the body whose region contains that curve" });
  const b = props?.get("body");
  if (!b) return props ? undefined : null;
  sink.paths.set(`${path}/member`, b.value);
  const s = readString(ctx, b.value, `${what} body`);
  if (s !== undefined && sketch && ts.isStringLiteral(b.value)) sink.curveRefs.push({ sketch, id: s, node: b.value });
  return s ?? null;
}

function curveArg(ctx: Ctx, e: ts.Expression | undefined, call: ts.Node, what: string, sink: Sink, path: string, handle: FeatureEntry): string | undefined {
  if (!e) return ctx.report("CS_BAD_ARGUMENT", call, `${what} needs a curve id`, `write ${what}("bottom")`);
  sink.paths.set(path, e);
  if (ts.isIdentifier(e)) return ctx.report("CS_BAD_ARGUMENT", e, `${what} takes the curve id as a string`, `write "${e.text}"`);
  const s = readString(ctx, e, `${what} curve id`);
  if (s !== undefined && handle.sketch && ts.isStringLiteral(e)) sink.curveRefs.push({ sketch: handle.sketch, id: s, node: e });
  return s;
}

/** A method on a feature handle that starts a query. */
function handleMethod(ctx: Ctx, call: ts.CallExpression, recv: ts.Identifier, method: ts.Identifier, sink: Sink, qpath: string): Query | undefined {
  const name = method.text;
  if (name === "points") {
    return ctx.report("CS_BAD_ARGUMENT", call, "sketch.points(…) gives hole positions, not a query", "use it as a hole's `at`: hole(face, { at: sk.points(\"p1\"), … })");
  }
  if (!ALL_HANDLE_METHODS.has(name)) {
    const hint = QUERY_METHODS.has(name)
      ? `\`${recv.text}\` is a feature: start a query first, e.g. ${recv.text}.body().${name}(…) or ${recv.text}.sides().${name}(…)`
      : "handles have cap, endcap, side, sides, edgeAt, body, faces (sweeps), wall, tip, floor, cboreWall, cboreFloor, csink (holes), instance (patterns)";
    return ctx.report("CS_UNKNOWN_METHOD", method, `\`${name}\` is not a method of a feature handle`, hint);
  }
  const h = resolveHandle(ctx, recv, `${name}()`);
  if (!h) return undefined;
  if (h.type === "tag") {
    return ctx.report("CS_UNKNOWN_METHOD", method, `\`${recv.text}\` is a tag, which is a query: it has no \`${name}()\``, `use the tag as a query: ${recv.text}.faces(), .edges(), …`);
  }
  sink.paths.set(qpath, call);
  sink.paths.set(`${qpath}/feature`, recv);
  const feature = h.id;
  const args = call.arguments;
  if (args.some(ts.isSpreadElement)) return ctx.report("CS_EXPR_UNSUPPORTED", call, "spreads are not supported", undefined);
  const what = `${recv.text}.${name}`;
  switch (name) {
    case "cap":
    case "endcap": {
      if (!callArgs(ctx, call, what, 1, 2, `${what}("end")`)) return undefined;
      sink.paths.set(`${qpath}/end`, args[0]!);
      const end = readEnd(ctx, args[0], call, what);
      const member = readMember(ctx, args[1], what, sink, qpath, h.sketch);
      if (end === undefined || member === null) return undefined;
      const q: Record<string, unknown> = { op: name, feature, end };
      if (member !== undefined) q["member"] = member;
      return q as unknown as Query;
    }
    case "side": {
      if (!callArgs(ctx, call, what, 1, 1, `${what}("bottom")`)) return undefined;
      const curve = curveArg(ctx, args[0], call, what, sink, `${qpath}/curve`, h);
      return curve === undefined ? undefined : { op: "side", feature, curve };
    }
    case "sides": {
      if (!callArgs(ctx, call, what, 0, 1, `${what}()`)) return undefined;
      const member = readMember(ctx, args[0], what, sink, qpath, h.sketch);
      if (member === null) return undefined;
      return (member !== undefined ? { op: "sides", feature, member } : { op: "sides", feature }) as Query;
    }
    case "edgeAt": {
      if (!callArgs(ctx, call, what, 2, 2, `${what}("bottom", "end")`)) return undefined;
      const curve = curveArg(ctx, args[0], call, what, sink, `${qpath}/curve`, h);
      sink.paths.set(`${qpath}/end`, args[1]!);
      const end = readEnd(ctx, args[1], call, what);
      return curve === undefined || end === undefined ? undefined : { op: "edge_at", feature, curve, end };
    }
    case "body": {
      if (!callArgs(ctx, call, what, 0, 1, `${what}()`)) return undefined;
      if (!args[0]) return { op: "body", feature };
      sink.paths.set(`${qpath}/member`, args[0]);
      const member = readString(ctx, args[0], `${what} member`);
      if (member !== undefined && h.sketch && ts.isStringLiteral(args[0])) sink.curveRefs.push({ sketch: h.sketch, id: member, node: args[0] });
      return member === undefined ? undefined : { op: "body", feature, member };
    }
    case "faces": {
      if (!callArgs(ctx, call, what, 0, 1, `${what}()`)) return undefined;
      if (!args[0]) return { op: "created", feature };
      const props = readObject(ctx, args[0], `${what} options`, [], ["role"]);
      const r = props?.get("role");
      if (!props) return undefined;
      if (!r) return { op: "created", feature };
      sink.paths.set(`${qpath}/role`, r.value);
      const role = readString(ctx, r.value, `${what} role`);
      return role === undefined ? undefined : { op: "created", feature, role };
    }
    case "instance": {
      if (!callArgs(ctx, call, what, 0, Infinity, `${what}(1)`)) return undefined;
      sink.paths.set(`${qpath}/index`, call);
      const index: number[] = [];
      for (const a of args) {
        const i = readLiteralInt(ctx, a, `${what} index`);
        if (i === undefined) return undefined;
        index.push(i);
      }
      return { op: "instance", feature, index };
    }
    default: {
      // hole faces
      if (!callArgs(ctx, call, what, 1, 1, `${what}("a")`)) return undefined;
      sink.paths.set(`${qpath}/at`, args[0]!);
      const at = readString(ctx, args[0]!, `${what} position id`);
      return at === undefined ? undefined : { op: "hole_face", feature, at, part: HOLE_PARTS[name] as v1.HolePart };
    }
  }
}

/** Lower a query expression (no trailing count) at IR path `qpath`. */
export function lowerQuery(ctx: Ctx, e: ts.Expression, sink: Sink, qpath: string): Query | undefined {
  sink.paths.set(qpath, e);
  if (ts.isParenthesizedExpression(e)) return lowerQuery(ctx, e.expression, sink, qpath);
  const alias = aliasOf(ctx, e);
  if (alias) {
    // A query alias in a chain (`top.edges()`) or an argument (`edgesBetween(a, top)`).
    const use = e as ts.Identifier;
    const init = stripParens(alias.init);
    if (isCardCall(init)) {
      return ctx.report(
        "CS_BAD_ARGUMENT",
        use,
        `\`${use.text}\` ends with a count (.${init.expression.name.text}()), so it is a whole reference`,
        `use it where a reference is expected, or drop the count from its declaration to build on it`,
      );
    }
    alias.used = true;
    if (!expandOk(ctx, use)) return undefined;
    return ctx.withNames(alias.names, () => lowerQuery(ctx, init, sink, qpath));
  }
  if (ts.isIdentifier(e)) {
    const h = resolveHandle(ctx, e, "a query");
    if (!h) return undefined;
    if (h.type === "tag") {
      sink.paths.set(`${qpath}/feature`, e);
      return { op: "tagged", feature: h.id };
    }
    return ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `\`${e.text}\` is ${h.builtin === "extrude" ? "an" : "a"} ${h.builtin} handle, not a query`,
      `select some of its entities, e.g. ${e.text}.body(), ${e.text}.faces()${h.type === "extrude" ? `, ${e.text}.cap("end")` : ""}`,
    );
  }
  if (!ts.isCallExpression(e)) return mismatch(ctx, e, 'a query (e.g. slab.cap("end"), slab.sides().edges())', "this argument");
  const callee = calleeName(e);
  if (callee) return queryFunction(ctx, e, callee, sink, qpath);
  if (!ts.isPropertyAccessExpression(e.expression)) return mismatch(ctx, e, "a query", "this argument");
  const recv = e.expression.expression;
  const method = e.expression.name;
  if (ts.isIdentifier(method) === false) return mismatch(ctx, e, "a query", "this argument");
  if (e.questionDotToken || e.expression.questionDotToken) return ctx.report("CS_EXPR_UNSUPPORTED", e, "optional chaining is not supported", undefined);
  // A method on a feature handle (not a tag: a tag is a query) starts a query.
  if (ts.isIdentifier(recv)) {
    const entry = ctx.names.get(recv.text);
    if (entry?.kind === "feature" && entry.type !== "tag") return handleMethod(ctx, e, recv, method, sink, qpath);
    if (entry?.kind !== "feature" && entry?.kind !== "query") {
      // Not a feature: report the name (resolveHandle explains what it is).
      resolveHandle(ctx, recv, `${method.text}()`);
      return undefined;
    }
  }
  return queryMethod(ctx, e, recv, method, sink, qpath);
}

function queryFunction(ctx: Ctx, call: ts.CallExpression, callee: string, sink: Sink, qpath: string): Query | undefined {
  switch (callee) {
    case "bodies":
      ctx.use("bodies", call.expression);
      if (!callArgs(ctx, call, "bodies", 0, 0, "bodies()")) return undefined;
      return { op: "bodies" };
    case "edgesBetween": {
      ctx.use("edgesBetween", call.expression);
      const args = callArgs(ctx, call, "edgesBetween", 2, 2, 'edgesBetween(boss.side("ring"), slab.cap("end"))');
      if (!args) return undefined;
      const a = lowerQuery(ctx, args[0]!, sink, `${qpath}/a`);
      const b = lowerQuery(ctx, args[1]!, sink, `${qpath}/b`);
      return a && b ? { op: "between", a, b } : undefined;
    }
    case "faceOf":
    case "body": {
      ctx.use(callee, call.expression);
      const usage = callee === "faceOf" ? 'faceOf(slab, "bottom")' : 'body(slab, "outline.bottom")';
      const args = callArgs(ctx, call, callee, callee === "faceOf" ? 2 : 1, 2, usage);
      if (!args) return undefined;
      if (!ts.isIdentifier(args[0]!)) return mismatch(ctx, args[0]!, "a feature const", `${callee}()`);
      const h = resolveHandle(ctx, args[0], `${callee}()`);
      if (!h) return undefined;
      sink.paths.set(`${qpath}/feature`, args[0]!);
      if (callee === "faceOf") {
        const curve = curveArg(ctx, args[1], call, "faceOf", sink, `${qpath}/curve`, h);
        return curve === undefined ? undefined : { op: "side", feature: h.id, curve };
      }
      if (!args[1]) return { op: "body", feature: h.id };
      sink.paths.set(`${qpath}/member`, args[1]);
      const member = readString(ctx, args[1], "body() member");
      if (member !== undefined && h.sketch && ts.isStringLiteral(args[1])) sink.curveRefs.push({ sketch: h.sketch, id: member, node: args[1] });
      return member === undefined ? undefined : { op: "body", feature: h.id, member };
    }
    default:
      return ctx.report("CS_BAD_ARGUMENT", call, `${callee}() is not a query`, 'queries start at a feature (slab.cap("end")), a tag, bodies(), edgesBetween(a, b), faceOf(…) or body(…)');
  }
}

function queryMethod(ctx: Ctx, call: ts.CallExpression, recv: ts.Expression, method: ts.Identifier, sink: Sink, qpath: string): Query | undefined {
  const name = method.text;
  if (isCardCall(recv as ts.Expression)) {
    return ctx.report("CS_BAD_ARGUMENT", method, `\`${name}()\` after a count`, "the count (.one(), .some(), .any(), .exactly(n)) must be the last call of the chain");
  }
  if (CARD_METHODS.includes(name)) {
    return ctx.report("CS_BAD_ARGUMENT", method, `.${name}() is only allowed at the end of a reference`, "remove it here; counts end a field's query");
  }
  if (!QUERY_METHODS.has(name)) {
    return ctx.report(
      "CS_UNKNOWN_METHOD",
      method,
      `\`${name}\` is not a query method`,
      "queries have faces, edges, vertices, owner, and, common, minus, planes, cylinders, …, normal, parallel, perpendicular, convex, concave, smooth, radius, max, min, largest, smallest and a final count",
    );
  }
  const args = call.arguments;
  if (args.some(ts.isSpreadElement)) return ctx.report("CS_EXPR_UNSUPPORTED", call, "spreads are not supported", undefined);
  const noArgs = (): boolean => !!callArgs(ctx, call, `.${name}`, 0, 0, `.${name}()`);
  const of = (): Query | undefined => lowerQuery(ctx, recv, sink, `${qpath}/of`);
  switch (name) {
    case "faces":
    case "edges":
    case "vertices":
    case "owner":
    case "largest":
    case "smallest": {
      const inner = of();
      if (!noArgs() || !inner) return undefined;
      return { op: name, of: inner } as Query;
    }
    case "and":
    case "common": {
      const first = lowerQuery(ctx, recv, sink, `${qpath}/of/0`);
      const rest = args.map((a, i) => lowerQuery(ctx, a, sink, `${qpath}/of/${i + 1}`));
      if (!first || rest.some((r) => !r)) return undefined;
      return { op: name === "and" ? "union" : "intersect", of: [first, ...(rest as Query[])] };
    }
    case "minus": {
      const a = lowerQuery(ctx, recv, sink, `${qpath}/a`);
      if (!callArgs(ctx, call, ".minus", 1, 1, ".minus(other)")) return undefined;
      const b = lowerQuery(ctx, args[0]!, sink, `${qpath}/b`);
      return a && b ? { op: "minus", a, b } : undefined;
    }
    case "max":
    case "min": {
      const inner = of();
      if (!callArgs(ctx, call, `.${name}`, 1, 1, `.${name}("+Z")`)) return undefined;
      const dir = lowerDir(ctx, args[0]!, sink, `${qpath}/dir`);
      return inner && dir !== undefined ? { op: "extreme", of: inner, dir, which: name } : undefined;
    }
    default:
      break;
  }
  // Filters.
  const inner = of();
  sink.paths.set(`${qpath}/where`, call.expression);
  let where: v1.Predicate | undefined;
  if (Object.prototype.hasOwnProperty.call(TYPE_FILTERS, name)) {
    if (!noArgs()) return undefined;
    where = { type: TYPE_FILTERS[name] as v1.GeomTypeName };
  } else if (name === "ofType") {
    const a = callArgs(ctx, call, ".ofType", 1, 1, '.ofType("bspline")');
    const t = a ? readString(ctx, a[0]!, "ofType", ["plane", "cylinder", "cone", "sphere", "torus", "bspline", "line", "circle", "ellipse"]) : undefined;
    if (t === undefined) return undefined;
    where = { type: t as v1.GeomTypeName };
  } else if (name === "normal" || name === "parallel" || name === "perpendicular") {
    const a = callArgs(ctx, call, `.${name}`, 1, 1, `.${name}(Z)`);
    const dir = a ? lowerDir(ctx, a[0]!, sink, `${qpath}/where/${name}`) : undefined;
    if (dir === undefined) return undefined;
    where = { [name]: dir } as v1.Predicate;
  } else if (name === "convex" || name === "concave" || name === "smooth") {
    const a = callArgs(ctx, call, `.${name}`, 0, 1, `.${name}()`);
    if (!a) return undefined;
    const flag = a[0] ? readLiteralBool(ctx, a[0], `.${name}()`) : true;
    if (flag === undefined) return undefined;
    where = { [name]: flag } as v1.Predicate;
  } else {
    // radius
    const a = callArgs(ctx, call, ".radius", 1, 1, ".radius(2) or .radius({ min: 1, max: 3 })");
    if (!a) return undefined;
    const rp = `${qpath}/where/radius`;
    if (ts.isObjectLiteralExpression(a[0]!)) {
      const props = readObject(ctx, a[0]!, ".radius()", [], ["eq", "min", "max"]);
      if (!props) return undefined;
      const bound: Record<string, number | string> = {};
      for (const k of ["eq", "min", "max"]) {
        const p = props.get(k);
        if (!p) continue;
        const v = lowerScalar(ctx, p.value, `radius ${k}`, `${rp}/${k}`, sink);
        if (v === undefined) return undefined;
        bound[k] = v;
      }
      where = { radius: bound } as v1.Predicate;
    } else {
      const v = lowerScalar(ctx, a[0]!, "radius", `${rp}/eq`, sink);
      if (v === undefined) return undefined;
      where = { radius: { eq: v } };
    }
  }
  return inner ? { op: "filter", of: inner, where } : undefined;
}

/** How a Ref-valued field lowers. */
export interface RefSpec {
  /** Kind used when the query's kind cannot be computed (an invalid query). */
  fallback: Kind;
  /** A bare feature handle means `handle.body()` (body positions, §5.10). */
  bodyHandle?: boolean;
}

/** Lower a reference (query + optional count) at IR path `path`. */
export function lowerRef(ctx: Ctx, e: ts.Expression, sink: Sink, path: string, spec: RefSpec): Ref | undefined {
  sink.paths.set(path, e);
  const taken = takeCard(ctx, e, sink, path);
  if (!taken) return undefined;
  const { card, qe } = taken;
  sink.paths.set(`${path}/kind`, qe);
  const alias = aliasOf(ctx, qe);
  if (alias) {
    // A query alias used as a whole reference: its query, and its count unless the use gives one.
    const use = qe as ts.Identifier;
    alias.used = true;
    if (!expandOk(ctx, use)) return undefined;
    return ctx.withNames(alias.names, () => {
      const inner = takeCard(ctx, alias.init, sink, path);
      if (!inner) return undefined;
      if (card !== undefined && inner.card !== undefined) {
        return ctx.report("CS_BAD_ARGUMENT", use, `\`${use.text}\` already ends with a count`, "give the count once: in the alias or at this use");
      }
      const q = lowerQuery(ctx, inner.qe, sink, `${path}/q`);
      if (!q) return undefined;
      const ref: Ref = { kind: queryKind(q, tagKinds(ctx)) ?? spec.fallback, q };
      const c = card ?? inner.card;
      if (c !== undefined) ref.card = c;
      return ref;
    });
  }
  let q: Query | undefined;
  if (spec.bodyHandle && ts.isIdentifier(qe) && ctx.names.get(qe.text)?.kind === "feature" && (ctx.names.get(qe.text) as FeatureEntry).type !== "tag") {
    const h = ctx.names.get(qe.text) as FeatureEntry;
    sink.paths.set(`${path}/q`, qe);
    sink.paths.set(`${path}/q/feature`, qe);
    q = { op: "body", feature: h.id };
  } else q = lowerQuery(ctx, qe, sink, `${path}/q`);
  if (!q) return undefined;
  const ref: Ref = { kind: queryKind(q, tagKinds(ctx)) ?? spec.fallback, q };
  if (card !== undefined) ref.card = card;
  return ref;
}

/** Tag feature id → the kind of its target. */
export function tagKinds(ctx: Ctx): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of ctx.names.values()) if (entry.kind === "feature" && entry.type === "tag" && entry.tagKind) out.set(entry.id, entry.tagKind);
  return out;
}

function isHandle(ctx: Ctx, e: ts.Expression, type: string): FeatureEntry | undefined {
  if (!ts.isIdentifier(e)) return undefined;
  const entry = ctx.names.get(e.text);
  return entry?.kind === "feature" && entry.type === type ? entry : undefined;
}

/** A PlaneRef (§3.1). */
export function lowerPlane(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): v1.PlaneRef | undefined {
  sink.paths.set(path, e);
  if (ts.isIdentifier(e) && PLANE_CONSTANTS.includes(e.text) && !ctx.names.has(e.text)) {
    ctx.use(e.text, e);
    return e.text as v1.NamedPlane;
  }
  if (ts.isStringLiteral(e) && PLANE_CONSTANTS.includes(e.text)) return ctx.report("CS_BAD_ARGUMENT", e, "planes are constants, not strings", `write ${e.text} without quotes`);
  const datum = isHandle(ctx, e, "datum_plane");
  if (datum) {
    sink.paths.set(`${path}/datum`, e);
    return { datum: datum.id };
  }
  if (calleeName(e) === "frame") {
    const call = e as ts.CallExpression;
    ctx.use("frame", call.expression);
    const args = callArgs(ctx, call, "frame", 1, 1, "frame({ origin: [0, 0, 0], normal: [0, 0, 1], xDir: [1, 0, 0] })");
    const props = args ? readObject(ctx, args[0]!, "frame()", ["origin", "normal", "xDir"], [], { x_dir: "CadScript spells it `xDir`" }) : undefined;
    if (!props) return undefined;
    const origin = vec(ctx, props.get("origin")?.value, 3, "frame origin", `${path}/origin`, sink);
    const normal = vec(ctx, props.get("normal")?.value, 3, "frame normal", `${path}/normal`, sink);
    const xDir = vec(ctx, props.get("xDir")?.value, 3, "frame xDir", `${path}/x_dir`, sink);
    if (!origin || !normal || !xDir) return undefined;
    return { origin, normal, x_dir: xDir } as v1.FramePlane;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const props = readObject(ctx, e, "a face plane", ["face"], ["origin", "xDir"], { x_dir: "CadScript spells it `xDir`" });
    if (!props) return undefined;
    const face = lowerRef(ctx, props.get("face")!.value, sink, `${path}/face`, { fallback: "face" });
    if (!face) return undefined;
    const out: Record<string, unknown> = { face };
    const o = props.get("origin");
    if (o) {
      const v = vec(ctx, o.value, 3, "plane origin", `${path}/origin`, sink);
      if (!v) return undefined;
      out["origin"] = v;
    }
    const x = props.get("xDir");
    if (x) {
      const v = vec(ctx, x.value, 3, "plane xDir", `${path}/x_dir`, sink);
      if (!v) return undefined;
      out["x_dir"] = v;
    }
    return out as unknown as v1.FacePlane;
  }
  if (ts.isIdentifier(e) && ctx.names.get(e.text)?.kind === "feature" && (ctx.names.get(e.text) as FeatureEntry).type !== "tag") {
    const h = ctx.names.get(e.text) as FeatureEntry;
    return ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `\`${e.text}\` is ${h.builtin === "extrude" ? "an" : "a"} ${h.builtin}, not a plane`,
      h.type === "extrude" ? `use one of its faces, e.g. ${e.text}.cap("end")` : "use XY, XZ, YZ, frame({ … }), a face query or a datumPlane",
    );
  }
  const face = lowerRef(ctx, e, sink, `${path}/face`, { fallback: "face" });
  return face ? { face } : undefined;
}

/** An AxisRef object form: `{ edge }`, `{ cylinder }`, `{ datum }`, `{ line }` (+ `flip`). */
function axisObject(ctx: Ctx, e: ts.ObjectLiteralExpression, sink: Sink, path: string): v1.AxisObject | undefined {
  const props = readObject(ctx, e, "an axis", [], ["edge", "cylinder", "datum", "line", "flip"]);
  if (!props) return undefined;
  const forms = ["edge", "cylinder", "datum", "line"].filter((k) => props.has(k));
  if (forms.length !== 1) {
    return ctx.report("CS_BAD_ARGUMENT", e, "an axis object needs exactly one of edge, cylinder, datum, line", "e.g. { edge: part.edgeAt(\"rim\", \"end\") } or { cylinder: boss.side(\"ring\") }");
  }
  const form = forms[0]!;
  const v = props.get(form)!.value;
  let out: Record<string, unknown>;
  if (form === "edge" || form === "cylinder") {
    const r = lowerRef(ctx, v, sink, `${path}/${form}`, { fallback: form === "edge" ? "edge" : "face" });
    if (!r) return undefined;
    out = { [form]: r };
  } else if (form === "datum") {
    const d = ts.isIdentifier(v) ? isHandle(ctx, v, "datum_axis") : undefined;
    if (!d) return mismatch(ctx, v, "a datumAxis const", "datum");
    sink.paths.set(`${path}/datum`, v);
    out = { datum: d.id };
  } else {
    const lp = readObject(ctx, v, "line", ["origin", "direction"], []);
    if (!lp) return undefined;
    const origin = vec(ctx, lp.get("origin")?.value, 3, "line origin", `${path}/line/origin`, sink);
    const direction = vec(ctx, lp.get("direction")?.value, 3, "line direction", `${path}/line/direction`, sink);
    if (!origin || !direction) return undefined;
    out = { line: { origin, direction } };
  }
  const f = props.get("flip");
  if (f) {
    const flip = lowerBoolScalar(ctx, f.value, "flip", `${path}/flip`, sink);
    if (flip === undefined) return undefined;
    out["flip"] = flip;
  }
  return out as unknown as v1.AxisObject;
}

/** A bare edge query is `{ edge }`, a bare face query `{ cylinder }`. */
function axisFromQuery(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): v1.AxisObject | undefined {
  // Decide the form from the query's kind; record the Ref under the form's path.
  const probe = { paths: new Map<string, ts.Node>(), exprs: new Map(), curveRefs: [] } as Sink;
  const r = lowerRef(ctx, e, probe, "", { fallback: "edge" });
  if (!r) return undefined;
  const form = r.kind === "face" ? "cylinder" : "edge";
  for (const [p, n] of probe.paths) sink.paths.set(`${path}/${form}${p}`, n);
  for (const [p, x] of probe.exprs) sink.exprs.set(`${path}/${form}${p}`, x);
  sink.curveRefs.push(...probe.curveRefs);
  return { [form]: r } as unknown as v1.AxisObject;
}

/** An AxisRef (§3.2). */
export function lowerAxis(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): v1.AxisRef | undefined {
  sink.paths.set(path, e);
  const signed = signedAxisConstant(ctx, e);
  if (signed) {
    const { sign, axis } = signed;
    const reversed = ["X", "Y", "Z"].map((a) => (a === axis ? -1 : 0)).join(", ");
    return ctx.report(
      "CS_BAD_ARGUMENT",
      e,
      `\`${sign}${axis}\` is not an axis: the axis constants have no sign`,
      sign === "+" ? `write ${axis}` : `write ${axis}, or { line: { origin: [0, 0, 0], direction: [${reversed}] } } for the reversed axis`,
    );
  }
  if (ts.isIdentifier(e) && AXIS_CONSTANTS.includes(e.text) && !ctx.names.has(e.text)) {
    ctx.use(e.text, e);
    return e.text as v1.AxisName;
  }
  if (ts.isStringLiteral(e)) return ctx.report("CS_BAD_ARGUMENT", e, "an axis is not a string", "use X, Y, Z, a datumAxis, { edge: … }, { cylinder: … } or { line: { origin, direction } }");
  const d = isHandle(ctx, e, "datum_axis");
  if (d) {
    sink.paths.set(`${path}/datum`, e);
    return { datum: d.id };
  }
  if (ts.isObjectLiteralExpression(e)) return axisObject(ctx, e, sink, path);
  return axisFromQuery(ctx, e, sink, path);
}

/**
 * `+Z` / `-Z` (a sign on an axis constant, not shadowed by a const): the sign and axis name.
 * SPEC-v1 §5.10 does not use this form (TypeScript types unary plus on an object as a number).
 */
function signedAxisConstant(ctx: Ctx, e: ts.Expression): { sign: "+" | "-"; axis: string } | undefined {
  if (!ts.isPrefixUnaryExpression(e)) return undefined;
  if (e.operator !== ts.SyntaxKind.PlusToken && e.operator !== ts.SyntaxKind.MinusToken) return undefined;
  const operand = stripParens(e.operand);
  if (!ts.isIdentifier(operand) || !AXIS_CONSTANTS.includes(operand.text) || ctx.names.has(operand.text)) return undefined;
  return { sign: e.operator === ts.SyntaxKind.PlusToken ? "+" : "-", axis: operand.text };
}

/** A Dir (§3.2): X/Y/Z, "+X"…, a vector, or an AxisRef object. */
export function lowerDir(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): v1.Dir | undefined {
  sink.paths.set(path, e);
  if (ts.isIdentifier(e) && AXIS_CONSTANTS.includes(e.text) && !ctx.names.has(e.text)) {
    ctx.use(e.text, e);
    return e.text as v1.DirName;
  }
  const signed = signedAxisConstant(ctx, e);
  if (signed) {
    const { sign, axis } = signed;
    return ctx.report("CS_BAD_ARGUMENT", e, `\`${sign}${axis}\` is not a direction: signed directions are strings`, `write "${sign}${axis}" (a string), or ${axis} for the unsigned axis`);
  }
  if (ts.isStringLiteral(e)) {
    if (SIGNED_DIRS.includes(e.text)) return e.text as v1.DirName;
    if (AXIS_CONSTANTS.includes(e.text)) return ctx.report("CS_BAD_ARGUMENT", e, "unsigned axes are constants", `write ${e.text} without quotes (or "+${e.text}" for the signed direction)`);
    return ctx.report("CS_BAD_ARGUMENT", e, `${shownText(e.text, '"')} is not a direction`, 'directions are X, Y, Z, "+X" … "-Z", [x, y, z] or an axis');
  }
  if (ts.isArrayLiteralExpression(e)) return vec(ctx, e, 3, "direction", path, sink, "ratio") as v1.Dir | undefined;
  const d = isHandle(ctx, e, "datum_axis");
  if (d) {
    sink.paths.set(`${path}/datum`, e);
    return { datum: d.id };
  }
  if (ts.isObjectLiteralExpression(e)) return axisObject(ctx, e, sink, path);
  return axisFromQuery(ctx, e, sink, path);
}

/** A PointRef: `[x, y, z]` or a vertex query. */
export function lowerPoint(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): v1.PointRef | undefined {
  sink.paths.set(path, e);
  if (ts.isArrayLiteralExpression(e)) return vec(ctx, e, 3, "point", path, sink) as v1.PointRef | undefined;
  const r = lowerRef(ctx, e, sink, `${path}/vertex`, { fallback: "vertex" });
  return r ? { vertex: r } : undefined;
}

/** `targets`: `"all"`, a body query or a feature handle. */
export function lowerTargets(ctx: Ctx, e: ts.Expression, sink: Sink, path: string): v1.Targets | undefined {
  sink.paths.set(path, e);
  if (ts.isStringLiteral(e)) {
    if (e.text === "all") return "all";
    return ctx.report("CS_BAD_ARGUMENT", e, `targets must be "all", a body query or a feature, got ${shownText(e.text, '"')}`, 'write "all" or e.g. slab');
  }
  return lowerRef(ctx, e, sink, path, { fallback: "body", bodyHandle: true });
}

/** A vector of Scalars (`[u, v]` or `[x, y, z]`). */
export function vec(ctx: Ctx, e: ts.Expression | undefined, n: 2 | 3, what: string, path: string, sink: Sink, _field: "length" | "ratio" = "length"): (number | string)[] | undefined {
  if (!e) return undefined;
  sink.paths.set(path, e);
  const shape = n === 2 ? "[u, v]" : "[x, y, z]";
  if (!ts.isArrayLiteralExpression(e)) return mismatch(ctx, e, `a vector ${shape}`, what);
  if (e.elements.length !== n) return ctx.report("CS_BAD_ARGUMENT", e, `${what} must have ${n} components ${shape}, got ${e.elements.length}`, `write ${shape}`);
  const out: (number | string)[] = [];
  let ok = true;
  e.elements.forEach((el, i) => {
    if (ts.isSpreadElement(el) || ts.isOmittedExpression(el)) {
      ctx.report("CS_BAD_ARGUMENT", el, `${what} needs ${n} values`, `write ${shape}`);
      ok = false;
      return;
    }
    const v = lowerScalar(ctx, el, what, `${path}/${i}`, sink);
    if (v === undefined) ok = false;
    else out.push(v);
  });
  return ok ? out : undefined;
}
