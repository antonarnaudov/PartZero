/**
 * The canonical CadScript v1 printer: IR v1 → source text (SPEC-v1 §2.9, §5.10).
 *
 * `compileV1(printV1(ir), { base: ir }).ir` deep-equals `canonicalDocument(ir)` (and so `ir` for
 * canonical documents), and the printer is a fixed point: `printV1(compileV1(src).ir) === src` for
 * printed sources. Expressions print from their canonical AST in TypeScript form (`^` → `**`,
 * `==` → `===`, `12 mm` → `mm(12)`, `--3` → `-(-3)`); queries print as the method chain of each
 * AST node; a count prints as the chain's last call. An `aicad.ir/0` document prints its
 * migration (§9.1).
 *
 * Imports: every v0 builtin (a stable header, as v0), then the v1 builtins the text uses.
 *
 * SPEC-v1 §2.9's `print(compile(src))` equals `src` for sources in this canonical form (the
 * fixed point above): the import header, one sketch curve per line and inline queries (a query
 * alias const is written out where it is used) are the printer's own; source in another layout
 * (e.g. §2.10's single-line sketch and minimal import) comes back canonical, statement by
 * statement the same up to layout. Edit splicing (`applyIrEditV1`) keeps untouched statements
 * verbatim, whatever their layout.
 *
 * Numbers print as their shortest literal; -0 prints as `-0` (§2.9: a bare literal is stored
 * as a number, so `-0` is JSON `-0.0`). IR v1 does not bound query nesting: a statement that
 * would nest beyond CadScript v1's limits (`LIMITS_V1`) is a printability problem.
 */
import ts from "typescript";
import type { IrDocument as V0Document } from "@aicad/ir-types";
import type { v1 } from "@aicad/ir-types";
import { LIMITS_V1, parseWithinLimits } from "../complexity.js";
import { formatNumber, formatString, isBareKey, isBindableName } from "../syntax.js";
import { inferDatumAxisMode, inferDatumPlaneMode, inferenceEnv, inferUnit } from "./compile.js";
import { formatExprNumber, namesOf, parseExpr, precOf, printExprWith, type Expr, type ExprStyle } from "./expr.js";
import { canonicalDocument, jsonNesting, MAX_JSON_NESTING } from "./json.js";
import { isV0Document, migrateV0ToV1 } from "./migrate.js";
import { STD_MODULE_V1 } from "./std-module.js";
import { BUILTINS_V1, CONSTRAINT_METHODS, HOLE_PARTS, TYPE_FILTERS } from "./syntax.js";
import { BUILTINS as V0_BUILTINS } from "../syntax.js";
import { shownText, type ParamUnitName } from "./context.js";

/**
 * Why (part of) an IR document cannot be written as CadScript v1, machine-readably (SPEC-v1
 * §9.3: the printer reports `CS_RESERVED_NAME` and the command layer offers `renameFeature`).
 *
 * - `CS_RESERVED_NAME`: a parameter or feature name is not usable as a const (a reserved word,
 *   not an identifier) or collides with a builtin the printed file imports (a feature migrated
 *   from v0 named `fillet` in a document with a fillet feature). Rename it (`renameFeature`;
 *   safe, references use ids).
 * - `CS_TOO_COMPLEX`: a statement would nest deeper than CadScript v1 accepts, or deeper than
 *   forge-ir reads IR JSON ({@link MAX_JSON_NESTING}); split the query with `tag()`.
 * - `CS_NOT_PRINTABLE`: the value is not a well-formed IR document, or is invalid in a way no
 *   source can express (an unknown feature type or query op, a dangling feature id, …).
 */
export interface PrintProblemV1 {
  code: "CS_RESERVED_NAME" | "CS_TOO_COMPLEX" | "CS_NOT_PRINTABLE";
  message: string;
  /** IR path (JSON pointer) of the parameter or feature at fault; `""` for the whole document. */
  path: string;
  /** The part of the feature at fault. */
  partId?: string;
  /** The feature at fault (the target of `renameFeature` for `CS_RESERVED_NAME`). */
  featureId?: string;
  /** The parameter at fault (its name). */
  param?: string;
}

/** Thrown when an IR document cannot be written as CadScript v1 at all. */
export class CadScriptV1PrintError extends Error {
  readonly problems: readonly PrintProblemV1[];
  constructor(problems: PrintProblemV1[]) {
    super(`IR cannot be printed as CadScript v1:\n  ${problems.map((p) => `${p.code}${p.path ? ` at ${p.path}` : ""}: ${p.message}`).join("\n  ")}`);
    this.name = "CadScriptV1PrintError";
    this.problems = problems;
  }
}

/** Where the printer is: the context of a problem found there. */
type PrintSite = Omit<PrintProblemV1, "code" | "message">;

export interface PrintOptionsV1 {
  /** Comment text to emit above feature statements, keyed by feature id (`CompileResultV1.comments`). */
  comments?: Readonly<Record<string, string>>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: unknown, k: string): boolean => isObj(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

class PrintFail extends Error {}

const UNIT_FN: Readonly<Record<string, string>> = { mm: "mm", cm: "cm", in: "inch", deg: "deg" };
const TYPE_SHORTHAND: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(TYPE_FILTERS).map(([m, t]) => [t, m]));
const HOLE_METHOD: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(HOLE_PARTS).map(([m, p]) => [p, m]));
const CONSTRAINT_BUILDER: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(CONSTRAINT_METHODS).map(([m, t]) => [t, m]));

/** Everything a statement printer needs: names by id, and the builtins used so far. */
export class Printer {
  readonly used = new Set<string>();
  /** Feature id → { const name, IR type }. */
  readonly features = new Map<string, { name: string; type: string }>();
  readonly problems: PrintProblemV1[] = [];
  /** The statement being printed (the context of its problems). */
  site: PrintSite = { path: "" };

  constructor(doc: v1.IrDocument) {
    for (const p of doc.parts) for (const f of p.features) if (!this.features.has(f.id)) this.features.set(f.id, { name: f.name, type: f.type });
  }

  problem(code: PrintProblemV1["code"], message: string, site: PrintSite = this.site): void {
    this.problems.push({ code, message, ...site });
  }

  fail(message: string): never {
    this.problem("CS_NOT_PRINTABLE", message);
    throw new PrintFail(message);
  }

  use(name: string): string {
    this.used.add(name);
    return name;
  }

  handle(id: string): { name: string; type: string } {
    const f = this.features.get(id);
    if (!f) return this.fail(`the feature id ${shownText(id, '"')} names no feature of the document`);
    return f;
  }

  // ── expressions ──

  readonly tsStyle: ExprStyle = {
    num: (v, unit) => (unit ? `${this.use(UNIT_FN[unit]!)}(${formatExprNumber(v)})` : formatExprNumber(v)),
    binOp: (op) => (op === "^" ? "**" : op === "==" ? "===" : op === "!=" ? "!==" : op),
    unaryParens: (op, operand) => (operand.k === "bin" && operand.op === "^") || (op === "-" && operand.k === "un" && operand.op === "-"),
  };

  expr(ast: Expr): string {
    const walk = (e: Expr): void => {
      if (e.k === "call") this.use(e.fn);
      if (e.k === "name" && e.name === "PI") this.use("PI");
      if (e.k === "call") e.args.forEach(walk);
      else if (e.k === "un") walk(e.e);
      else if (e.k === "bin") {
        walk(e.l);
        walk(e.r);
      } else if (e.k === "cond") {
        walk(e.c);
        walk(e.t);
        walk(e.f);
      }
    };
    walk(ast);
    return printExprWith(ast, this.tsStyle);
  }

  parse(text: string): Expr {
    const r = parseExpr(text);
    if (!r.ok) return this.fail(`the expression at hand does not parse (${r.problem.message})`);
    return r.ast;
  }

  scalar(v: unknown): string {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return this.fail(`non-finite number ${v} has no CadScript literal`);
      return Object.is(v, -0) ? "-0" : formatNumber(v); // -0 is a literal of its own (§2.9)
    }
    if (typeof v === "string") return this.expr(this.parse(v));
    return this.fail("a numeric field holds neither a number nor an expression");
  }

  bool(v: unknown): string {
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") return this.expr(this.parse(v));
    return this.fail("a boolean field holds neither a boolean nor an expression");
  }

  vec(v: unknown): string {
    if (!Array.isArray(v)) return this.fail("a vector is not an array");
    return `[${v.map((x) => this.scalar(x)).join(", ")}]`;
  }

  // ── references ──

  query(q: unknown): string {
    if (!isObj(q)) return this.fail("a query is not an object");
    const h = (): string => this.handle(String(q["feature"])).name;
    const str = (k: string): string => formatString(String(q[k]));
    switch (q["op"]) {
      case "body":
        return has(q, "member") ? `${h()}.body(${str("member")})` : `${h()}.body()`;
      case "bodies":
        return `${this.use("bodies")}()`;
      case "cap":
      case "endcap":
        return has(q, "member") ? `${h()}.${q["op"]}(${str("end")}, { body: ${str("member")} })` : `${h()}.${q["op"]}(${str("end")})`;
      case "side":
        return `${h()}.side(${str("curve")})`;
      case "sides":
        return has(q, "member") ? `${h()}.sides({ body: ${str("member")} })` : `${h()}.sides()`;
      case "edge_at":
        return `${h()}.edgeAt(${str("curve")}, ${str("end")})`;
      case "between":
        return `${this.use("edgesBetween")}(${this.query(q["a"])}, ${this.query(q["b"])})`;
      case "hole_face": {
        const m = HOLE_METHOD[String(q["part"])];
        if (!m) return this.fail(`unknown hole face part ${shownText(String(q["part"]), '"')}`);
        return `${h()}.${m}(${str("at")})`;
      }
      case "created":
        return has(q, "role") ? `${h()}.faces({ role: ${str("role")} })` : `${h()}.faces()`;
      case "instance":
        return `${h()}.instance(${(q["index"] as number[]).map((i) => formatNumber(i)).join(", ")})`;
      case "tagged": {
        const t = this.handle(String(q["feature"]));
        if (t.type !== "tag") return this.fail(`a tagged query names ${shownText(t.name, '"')}, which is not a tag`);
        return t.name;
      }
      case "faces":
      case "edges":
      case "vertices":
      case "owner":
      case "largest":
      case "smallest":
        return `${this.query(q["of"])}.${q["op"]}()`;
      case "union":
      case "intersect": {
        const of = q["of"] as unknown[];
        if (!Array.isArray(of) || of.length === 0) return this.fail(`a ${q["op"]} with no operands cannot be written as a method chain`);
        return `${this.query(of[0])}.${q["op"] === "union" ? "and" : "common"}(${of.slice(1).map((x) => this.query(x)).join(", ")})`;
      }
      case "minus":
        return `${this.query(q["a"])}.minus(${this.query(q["b"])})`;
      case "extreme":
        return `${this.query(q["of"])}.${q["which"]}(${this.dir(q["dir"])})`;
      case "filter":
        return `${this.query(q["of"])}.${this.predicate(q["where"])}`;
      default:
        return this.fail(`unknown query op ${shownText(String(q["op"]), '"')}`);
    }
  }

  predicate(p: unknown): string {
    if (!isObj(p)) return this.fail("a predicate is not an object");
    const [k, v] = Object.entries(p)[0] ?? ["", undefined];
    switch (k) {
      case "type": {
        const short = TYPE_SHORTHAND[String(v)];
        return short ? `${short}()` : `ofType(${formatString(String(v))})`;
      }
      case "normal":
      case "parallel":
      case "perpendicular":
        return `${k}(${this.dir(v)})`;
      case "convex":
      case "concave":
      case "smooth":
        return v === true ? `${k}()` : `${k}(${String(v)})`;
      case "radius": {
        const r = v as Obj;
        const keys = ["eq", "min", "max"].filter((x) => has(r, x));
        if (keys.length === 1 && keys[0] === "eq") return `radius(${this.scalar(r["eq"])})`;
        return `radius({ ${keys.map((x) => `${x}: ${this.scalar(r[x])}`).join(", ")} })`;
      }
      default:
        return this.fail(`unknown predicate ${shownText(k, '"')}`);
    }
  }

  card(c: unknown): string {
    if (c === undefined) return "";
    if (typeof c === "number") return `.exactly(${formatNumber(c)})`;
    return `.${String(c)}()`;
  }

  /** A Ref; `bodyHandle`: `{ op: body, feature }` prints as the bare handle (`targets: slab`). */
  ref(r: unknown, bodyHandle = false): string {
    if (!isObj(r)) return this.fail("a reference is not an object");
    const q = r["q"];
    let text: string;
    // (Not with a count: a handle has no .one(); `slab.body().one()` type-checks.)
    if (bodyHandle && isObj(q) && q["op"] === "body" && !has(q, "member") && r["card"] === undefined) {
      const h = this.handle(String(q["feature"]));
      text = h.type === "tag" ? this.query(q) : h.name;
    } else text = this.query(q);
    return `${text}${this.card(r["card"])}`;
  }

  plane(p: unknown): string {
    if (typeof p === "string") return this.use(p);
    if (!isObj(p)) return this.fail("a plane is not a string or an object");
    if (has(p, "datum")) {
      const d = this.handle(String(p["datum"]));
      return d.name;
    }
    if (has(p, "face")) {
      if (!has(p, "origin") && !has(p, "x_dir")) {
        const r = p["face"] as Obj;
        // A bare identifier would read as a feature handle; only tags are queries on their own.
        return this.ref(r);
      }
      const parts = [`face: ${this.ref(p["face"])}`];
      if (has(p, "origin")) parts.push(`origin: ${this.vec(p["origin"])}`);
      if (has(p, "x_dir")) parts.push(`xDir: ${this.vec(p["x_dir"])}`);
      return `{ ${parts.join(", ")} }`;
    }
    return `${this.use("frame")}({ origin: ${this.vec(p["origin"])}, normal: ${this.vec(p["normal"])}, xDir: ${this.vec(p["x_dir"])} })`;
  }

  axisObject(o: Obj, allowBareDatum: boolean): string {
    const flip = has(o, "flip") && o["flip"] !== false ? `, flip: ${this.bool(o["flip"])}` : "";
    if (has(o, "datum")) {
      const d = this.handle(String(o["datum"]));
      return flip === "" && allowBareDatum ? d.name : `{ datum: ${d.name}${flip} }`;
    }
    if (has(o, "edge")) return `{ edge: ${this.ref(o["edge"])}${flip} }`;
    if (has(o, "cylinder")) return `{ cylinder: ${this.ref(o["cylinder"])}${flip} }`;
    if (has(o, "line")) {
      const l = o["line"] as Obj;
      return `{ line: { origin: ${this.vec(l["origin"])}, direction: ${this.vec(l["direction"])} }${flip} }`;
    }
    return this.fail("an axis object has none of edge, cylinder, datum, line");
  }

  axis(a: unknown): string {
    if (typeof a === "string") return this.use(a);
    if (!isObj(a)) return this.fail("an axis is not a string or an object");
    return this.axisObject(a, true);
  }

  dir(d: unknown): string {
    if (typeof d === "string") return ["X", "Y", "Z"].includes(d) ? this.use(d) : formatString(d);
    if (Array.isArray(d)) return this.vec(d);
    if (!isObj(d)) return this.fail("a direction is not a string, vector or axis");
    return this.axisObject(d, true);
  }

  point(p: unknown): string {
    if (Array.isArray(p)) return this.vec(p);
    if (isObj(p) && has(p, "vertex")) return this.ref(p["vertex"]);
    return this.fail("a point is not a vector or a vertex");
  }

  targets(t: unknown): string {
    return t === "all" ? '"all"' : this.ref(t, true);
  }

  // ── statements ──

  commonOptions(f: Obj): string[] {
    const out: string[] = [];
    if (has(f, "suppressed") && f["suppressed"] !== false) out.push(`suppressed: ${this.bool(f["suppressed"])}`);
    if (has(f, "v") && f["v"] !== 1) out.push(`v: ${formatNumber(f["v"] as number)}`);
    for (const [ir, cs] of [
      ["note", "note"],
      ["intent", "intent"],
      ["author", "author"],
    ] as const) {
      if (has(f, ir) && f[ir] !== "") out.push(`${cs}: ${formatString(String(f[ir]))}`);
    }
    for (const [ir, cs] of [
      ["assumptions", "assumptions"],
      ["decision_ids", "decisionIds"],
    ] as const) {
      if (has(f, ir) && (f[ir] as unknown[]).length > 0) out.push(`${cs}: [${(f[ir] as string[]).map(formatString).join(", ")}]`);
    }
    return out;
  }

  curve(c: Obj): string {
    const cons = c["construction"] === true;
    const inObj = (fields: string[]): string => `{ ${[...fields, ...(cons ? ["construction: true"] : [])].join(", ")} }`;
    switch (c["kind"]) {
      case "line":
        return `${this.use("line")}(${this.vec(c["start"])}, ${this.vec(c["end"])}${cons ? ", { construction: true }" : ""})`;
      case "point":
        return `${this.use("point")}(${this.vec(c["at"])}${cons ? ", { construction: true }" : ""})`;
      case "arc":
        return `${this.use("arc")}(${inObj([`start: ${this.vec(c["start"])}`, `end: ${this.vec(c["end"])}`, `center: ${this.vec(c["center"])}`, `ccw: ${String(c["ccw"])}`])})`;
      case "circle":
        return `${this.use("circle")}(${inObj([`center: ${this.vec(c["center"])}`, `radius: ${this.scalar(c["radius"])}`])})`;
      case "rect": {
        const fields: string[] = [];
        if (has(c, "center")) fields.push(`center: ${this.vec(c["center"])}`);
        if (has(c, "corner")) fields.push(`corner: ${this.vec(c["corner"])}`);
        fields.push(`w: ${this.scalar(c["w"])}`, `h: ${this.scalar(c["h"])}`);
        if (has(c, "r")) fields.push(`r: ${this.scalar(c["r"])}`);
        return `${this.use("rect")}(${inObj(fields)})`;
      }
      case "slot":
        return `${this.use("slot")}(${inObj([`a: ${this.vec(c["a"])}`, `b: ${this.vec(c["b"])}`, `w: ${this.scalar(c["w"])}`])})`;
      case "polygon": {
        const fields: string[] = [];
        const center = c["center"] as unknown[];
        // The compiler's default centre is [0, 0] exactly ([-0, 0] is printed).
        if (!(Array.isArray(center) && Object.is(center[0], 0) && Object.is(center[1], 0))) fields.push(`center: ${this.vec(center)}`);
        fields.push(`n: ${this.scalar(c["n"])}`);
        for (const [irk, cs] of [
          ["circumradius", "circumradius"],
          ["inradius", "inradius"],
          ["across_flats", "acrossFlats"],
          ["side", "side"],
        ] as const) {
          if (has(c, irk)) fields.push(`${cs}: ${this.scalar(c[irk])}`);
        }
        if (has(c, "rotation")) fields.push(`rotation: ${this.scalar(c["rotation"])}`);
        return `${this.use("polygon")}(${inObj(fields)})`;
      }
      default:
        return this.fail(`unknown curve kind ${shownText(String(c["kind"]), '"')}`);
    }
  }

  constraint(c: Obj): string {
    const type = String(c["type"]);
    const m = CONSTRAINT_BUILDER[type];
    if (!m) return this.fail(`unknown constraint type ${shownText(type, '"')}`);
    this.use("C");
    const argNames: Record<string, string[]> = {
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
    const args = argNames[type]!.map((a) => formatString(String(c[a])));
    if (type === "distance" || type === "angle" || type === "radius" || type === "diameter") {
      if (has(c, "value")) args.push(this.scalar(c["value"]));
      if (c["driving"] === false) args.push("{ driving: false }");
    } else if (type === "tangent" && has(c, "internal")) {
      args.push(`{ internal: ${String(c["internal"])} }`);
    } else if (type === "fix" && (has(c, "x") || has(c, "y"))) {
      const xy = ["x", "y"].filter((k) => has(c, k)).map((k) => `${k}: ${this.scalar(c[k])}`);
      args.push(`{ ${xy.join(", ")} }`);
    }
    return `C.${m}(${args.join(", ")})`;
  }

  /** One feature as a complete `const name = …;` statement (no trailing newline). */
  feature(f: v1.Feature): string {
    const o = f as unknown as Obj;
    const common = this.commonOptions(o);
    const opts = (fields: string[]): string => `{ ${[...fields, ...common].join(", ")} }`;
    const call = (builtin: string, args: string[]): string => `const ${f.name} = ${this.use(builtin)}(${args.join(", ")});`;
    switch (f.type) {
      case "sketch": {
        const curves = f.curves.length === 0 ? "{}" : `{\n${f.curves.map((c) => `  ${key(c.id)}: ${this.curve(c as unknown as Obj)},`).join("\n")}\n}`;
        const cons = f.constraints ?? [];
        const extra: string[] = [];
        if (cons.length > 0) extra.push(`constraints: {\n${cons.map((c) => `    ${key(c.id)}: ${this.constraint(c as unknown as Obj)},`).join("\n")}\n  }`);
        extra.push(...common);
        let options = "";
        if (cons.length > 0) options = `, {\n${extra.map((x) => `  ${x},`).join("\n")}\n}`;
        else if (extra.length > 0) options = `, { ${extra.join(", ")} }`;
        return `const ${f.name} = ${this.use("sketch")}(${this.plane(f.plane)}, ${curves}${options});`;
      }
      case "extrude":
      case "revolve": {
        const sk = this.handle(f.sketch);
        const fields: string[] = [];
        if (f.type === "extrude") fields.push(`distance: ${this.scalar(f.distance)}`);
        else fields.push(`axis: { origin: ${this.vec(f.axis.origin)}, direction: ${this.vec(f.axis.direction)} }`, `angle: ${this.scalar(f.angle)}`);
        if (f.direction !== undefined && f.direction !== "normal") fields.push(`direction: ${formatString(f.direction)}`);
        if (f.regions !== undefined && f.regions !== "all") fields.push(`regions: [${f.regions.map(formatString).join(", ")}]`);
        if (f.op !== undefined && f.op !== "new_body") fields.push(`op: ${formatString(f.op)}`);
        if (f.targets !== undefined) fields.push(`targets: ${this.targets(f.targets)}`);
        return call(f.type, [sk.name, opts(fields)]);
      }
      case "boolean": {
        const fields = [`targets: ${this.ref(f.targets, true)}`, `tools: ${this.ref(f.tools, true)}`];
        if (f.keep_tools !== undefined && f.keep_tools !== false) fields.push(`keepTools: ${this.bool(f.keep_tools)}`);
        return call("boolean", [formatString(f.op), opts(fields)]);
      }
      case "hole":
        return call("hole", [this.plane(f.on), opts(this.holeFields(f))]);
      case "fillet": {
        const fields = [`r: ${this.scalar(f.r)}`];
        if (f.tangent_chain !== undefined && f.tangent_chain !== true) fields.push(`tangentChain: ${this.bool(f.tangent_chain)}`);
        return call("fillet", [this.ref(f.edges), opts(fields)]);
      }
      case "chamfer": {
        const fields = [`d: ${this.scalar(f.d)}`];
        if (f.d2 !== undefined) fields.push(`d2: ${this.scalar(f.d2)}`);
        if (f.angle !== undefined) fields.push(`angle: ${this.scalar(f.angle)}`);
        if (f.side !== undefined) fields.push(`side: ${this.ref(f.side)}`);
        if (f.tangent_chain !== undefined && f.tangent_chain !== true) fields.push(`tangentChain: ${this.bool(f.tangent_chain)}`);
        return call("chamfer", [this.ref(f.edges), opts(fields)]);
      }
      case "shell": {
        const fields: string[] = [];
        if (f.open !== undefined) fields.push(`open: ${this.ref(f.open)}`);
        fields.push(`thickness: ${this.scalar(f.thickness)}`);
        if (f.direction !== undefined && f.direction !== "inward") fields.push(`direction: ${formatString(f.direction)}`);
        return call("shell", [this.ref(f.body, true), opts(fields)]);
      }
      case "draft": {
        const fields = [`neutral: ${this.plane(f.neutral)}`, `angle: ${this.scalar(f.angle)}`];
        if (f.pull !== undefined && f.pull !== "normal") fields.push(`pull: ${formatString(f.pull)}`);
        return call("draft", [this.ref(f.faces), opts(fields)]);
      }
      case "pattern":
        return this.pattern(f, common);
      case "datum_plane":
        return call("datumPlane", [opts(this.datumPlaneFields(f))]);
      case "datum_axis":
        return call("datumAxis", [opts(this.datumAxisFields(f))]);
      case "tag":
        return call("tag", common.length > 0 ? [this.ref(f.target), `{ ${common.join(", ")} }`] : [this.ref(f.target)]);
      default:
        return this.fail(`unknown feature type ${shownText(String((f as { type: string }).type), '"')}`);
    }
  }

  holeFields(f: v1.HoleFeature): string[] {
    const fields: string[] = [];
    const at = f.at as Obj;
    if (has(at, "grid")) {
      const g = at["grid"] as Obj;
      const gf = ["nx", "ny", "dx", "dy"].map((k) => `${k}: ${this.scalar(g[k])}`);
      if (has(g, "center")) gf.push(`center: ${this.vec(g["center"])}`);
      fields.push(`at: ${this.use("grid")}({ ${gf.join(", ")} })`);
    } else if (has(at, "circle")) {
      const c = at["circle"] as Obj;
      const cf = ["n", "d"].map((k) => `${k}: ${this.scalar(c[k])}`);
      if (has(c, "center")) cf.push(`center: ${this.vec(c["center"])}`);
      if (has(c, "start")) cf.push(`start: ${this.scalar(c["start"])}`);
      fields.push(`at: ${this.use("boltCircle")}({ ${cf.join(", ")} })`);
    } else if (has(at, "points")) {
      const p = at["points"] as Obj;
      const sk = this.handle(String(p["sketch"]));
      const ids = p["ids"];
      if (Array.isArray(ids) && ids.length === 0) return this.fail("a hole's point list is empty (it cannot be told from `all`)");
      fields.push(`at: ${sk.name}.points(${ids === "all" ? "" : (ids as string[]).map(formatString).join(", ")})`);
    } else if (has(at, "list")) {
      const list = at["list"] as Obj[];
      fields.push(`at: ${list.length === 0 ? "{}" : `{ ${list.map((p) => `${key(String(p["id"]))}: ${this.vec(p["at"])}`).join(", ")} }`}`);
    } else return this.fail("a hole placement has none of grid, circle, points, list");
    if (f.size !== undefined) fields.push(`size: ${formatString(f.size)}`);
    if (f.fit !== undefined && f.fit !== "normal") fields.push(`fit: ${formatString(f.fit)}`);
    if (f.d !== undefined) fields.push(`d: ${this.scalar(f.d)}`);
    if (f.depth !== undefined) {
      const d = f.depth as unknown;
      if (typeof d === "string") fields.push(`depth: ${formatString(d)}`);
      else if (has(d, "blind")) fields.push(`depth: { blind: ${this.scalar((d as Obj)["blind"])} }`);
      else fields.push(`depth: { upTo: ${this.ref((d as Obj)["up_to"])} }`);
    }
    if (f.tip !== undefined && f.tip !== 118) fields.push(`tip: ${f.tip === "flat" ? '"flat"' : this.scalar(f.tip)}`);
    const head = (k: "cbore" | "csink" | "insert", inner: string[]): void => {
      const v = f[k] as unknown;
      if (v === undefined) return;
      if (typeof v === "string") fields.push(`${k}: ${formatString(v)}`);
      else fields.push(`${k}: { ${inner.filter((x) => has(v, x)).map((x) => `${x}: ${this.scalar((v as Obj)[x])}`).join(", ")} }`);
    };
    head("cbore", ["d", "depth"]);
    head("csink", ["d", "angle"]);
    head("insert", ["d", "depth"]);
    if (f.thread !== undefined && f.thread !== false) {
      const t = f.thread as unknown;
      if (t === true) fields.push("thread: true");
      else fields.push(`thread: { ${["pitch", "depth"].filter((x) => has(t, x)).map((x) => `${x}: ${this.scalar((t as Obj)[x])}`).join(", ")} }`);
    }
    if (f.flip !== undefined && f.flip !== false) fields.push(`flip: ${this.bool(f.flip)}`);
    if (f.targets !== undefined) fields.push(`targets: ${this.targets(f.targets)}`);
    return fields;
  }

  pattern(f: v1.PatternFeature, common: string[]): string {
    const seed = f.seed as Obj;
    const seedText = has(seed, "features") ? `[${(seed["features"] as string[]).map((id) => this.handle(id).name).join(", ")}]` : this.ref(seed["bodies"], true);
    const layout = f.layout as Obj;
    let builtin: string;
    const fields: string[] = [];
    if (has(layout, "linear")) {
      builtin = "linearPattern";
      const l = layout["linear"] as Obj;
      fields.push(`dir: ${this.dir(l["dir"])}`, `count: ${this.scalar(l["count"])}`, `spacing: ${this.scalar(l["spacing"])}`);
      if (has(l, "dir2")) fields.push(`dir2: ${this.dir(l["dir2"])}`);
      if (has(l, "count2")) fields.push(`count2: ${this.scalar(l["count2"])}`);
      if (has(l, "spacing2")) fields.push(`spacing2: ${this.scalar(l["spacing2"])}`);
    } else if (has(layout, "circular")) {
      builtin = "circularPattern";
      const c = layout["circular"] as Obj;
      fields.push(`axis: ${this.axis(c["axis"])}`, `count: ${this.scalar(c["count"])}`);
      if (has(c, "angle")) fields.push(`angle: ${this.scalar(c["angle"])}`);
    } else if (has(layout, "mirror")) {
      builtin = "mirror";
      fields.push(`plane: ${this.plane((layout["mirror"] as Obj)["plane"])}`);
    } else return this.fail("a pattern layout has none of linear, circular, mirror");
    if (f.skip !== undefined && f.skip.length > 0) fields.push(`skip: [${f.skip.map((ix) => `[${ix.map((i) => formatNumber(i)).join(", ")}]`).join(", ")}]`);
    if (f.op !== undefined && f.op !== "new_body") fields.push(`op: ${formatString(f.op)}`);
    if (f.targets !== undefined) fields.push(`targets: ${this.targets(f.targets)}`);
    return `const ${f.name} = ${this.use(builtin)}(${seedText}, { ${[...fields, ...common].join(", ")} });`;
  }

  datumPlaneFields(f: v1.DatumPlaneFeature): string[] {
    const fields: [string, string][] = [];
    const mode = f.mode;
    if (f.from !== undefined) fields.push([mode === "offset" ? "offset" : "from", this.plane(f.from)]);
    if (f.distance !== undefined) fields.push(["distance", this.scalar(f.distance)]);
    if (f.axis !== undefined) fields.push(["axis", this.axis(f.axis)]);
    if (f.angle !== undefined) fields.push(["angle", this.scalar(f.angle)]);
    if (mode === "midplane" && f.a !== undefined && f.b !== undefined) fields.push(["midplane", `[${this.plane(f.a)}, ${this.plane(f.b)}]`]);
    else {
      if (f.a !== undefined) fields.push(["a", this.plane(f.a)]);
      if (f.b !== undefined) fields.push(["b", this.plane(f.b)]);
    }
    if (f.points !== undefined && f.points !== null) fields.push(["through", `[${f.points.map((p) => this.point(p)).join(", ")}]`]);
    if (f.origin !== undefined) fields.push(["origin", this.vec(f.origin)]);
    if (f.normal !== undefined) fields.push(["normal", this.vec(f.normal)]);
    if (f.x_dir !== undefined) fields.push(["xDir", this.vec(f.x_dir)]);
    if (inferDatumPlaneMode(new Set(fields.map(([k]) => k))) !== mode) fields.push(["mode", formatString(mode)]);
    return fields.map(([k, v]) => `${k}: ${v}`);
  }

  datumAxisFields(f: v1.DatumAxisFeature): string[] {
    const fields: [string, string][] = [];
    const mode = f.mode;
    if (f.edge !== undefined) fields.push(["edge", this.ref(f.edge)]);
    if (f.face !== undefined) fields.push(["cylinder", this.ref(f.face)]);
    if (mode === "planes" && f.a !== undefined && f.b !== undefined) fields.push(["planes", `[${this.plane(f.a)}, ${this.plane(f.b)}]`]);
    else {
      if (f.a !== undefined) fields.push(["a", this.plane(f.a)]);
      if (f.b !== undefined) fields.push(["b", this.plane(f.b)]);
    }
    if (f.points !== undefined && f.points !== null) fields.push(["points", `[${f.points.map((p) => this.point(p)).join(", ")}]`]);
    if (f.flip !== undefined && f.flip !== false) fields.push(["flip", this.bool(f.flip)]);
    if (inferDatumAxisMode(new Set(fields.map(([k]) => k))) !== mode) fields.push(["mode", formatString(mode)]);
    return fields.map(([k, v]) => `${k}: ${v}`);
  }

  /** A parameter statement; `units` holds the units of the parameters printed before it. */
  param(p: v1.Parameter, units: Map<string, { kind: string; unit?: ParamUnitName }>): string {
    let value: string;
    let inferred: string;
    if (typeof p.value === "boolean") {
      value = String(p.value);
      inferred = "bool";
    } else if (typeof p.value === "number") {
      value = this.scalar(p.value);
      inferred = "mm";
    } else {
      const ast = this.parse(p.value);
      value = this.expr(ast);
      inferred = inferUnit(ast, inferenceEnv(units));
    }
    const opts: string[] = [];
    if (p.unit !== inferred) opts.push(`unit: ${formatString(p.unit)}`);
    if (p.min !== undefined) opts.push(`min: ${this.scalar(p.min)}`);
    if (p.max !== undefined) opts.push(`max: ${this.scalar(p.max)}`);
    if (p.note !== undefined && p.note !== "") opts.push(`note: ${formatString(p.note)}`);
    units.set(p.name, { kind: "param", unit: (["mm", "deg", "ratio", "count", "bool"].includes(p.unit) ? p.unit : "mm") as ParamUnitName });
    return `const ${p.name} = ${this.use("param")}(${value}${opts.length > 0 ? `, { ${opts.join(", ")} }` : ""});`;
  }
}

function key(id: string): string {
  return isBareKey(id) ? id : formatString(id);
}

/**
 * Why a printed statement would not compile back: nested beyond CadScript v1's limits
 * (`LIMITS_V1`). Every expression IR v1 accepts fits (`MAX_EXPR_DEPTH`), but IR v1 does not bound
 * query nesting. A statement of at most 100 characters cannot reach either limit (every printed
 * nesting level takes a character), so only longer ones are parsed.
 */
export function statementNestingProblem(text: string): string | undefined {
  if (text.length <= 100) return undefined;
  const parsed = parseWithinLimits("statement.cad.ts", text, ts.ScriptTarget.Latest, LIMITS_V1);
  return parsed.problem?.message;
}

/**
 * Order parameters so that each comes after the parameters of the same list it uses (stable).
 * IR v1 allows a parameter to use one declared later (§2.8 orders by dependency); CadScript
 * declares before use, so such a list prints in dependency order, and compiling the print with
 * the document as `base` restores the document's order (`compileV1` keeps a base's order for a
 * list of the same parameters). Without that base the order is the printed one: equivalent, since
 * only dependencies order evaluation.
 */
export function orderParams(params: readonly v1.Parameter[]): v1.Parameter[] {
  const names = new Map(params.map((p, i) => [p.name, i]));
  const deps = params.map((p) => {
    const out = new Set<number>();
    for (const v of [p.value, p.min, p.max]) {
      if (typeof v !== "string") continue;
      const r = parseExpr(v);
      if (!r.ok) continue;
      for (const n of namesOf(r.ast)) {
        const j = names.get(n);
        if (j !== undefined && j !== params.indexOf(p)) out.add(j);
      }
    }
    return out;
  });
  const done = new Set<number>();
  const order: number[] = [];
  while (order.length < params.length) {
    let pick = -1;
    for (let i = 0; i < params.length; i++) {
      if (done.has(i)) continue;
      if ([...deps[i]!].every((j) => done.has(j))) {
        pick = i;
        break;
      }
    }
    if (pick < 0) pick = [...Array(params.length).keys()].find((i) => !done.has(i))!; // a cycle: keep order
    done.add(pick);
    order.push(pick);
  }
  return order.map((i) => params[i]!);
}

/** The canonical import statement for a set of used builtins (v0 builtins always, then v1 ones). */
export function printImportV1(used: Iterable<string>): string {
  const set = new Set(used);
  for (const b of V0_BUILTINS) set.add(b);
  const ordered = BUILTINS_V1.filter((b) => set.has(b));
  return `import { ${ordered.join(", ")} } from ${formatString(STD_MODULE_V1)};`;
}

export function printDocStatementV1(meta: v1.Meta | undefined): string | undefined {
  const fields: string[] = [];
  if (meta?.name) fields.push(`name: ${formatString(meta.name)}`);
  if (meta?.description) fields.push(`description: ${formatString(meta.description)}`);
  return fields.length > 0 ? `doc({ ${fields.join(", ")} });` : undefined;
}

export function printPartStatementV1(part: { name: string }): string {
  return `part(${formatString(part.name)});`;
}

/** A normalized v1 view of any IR (v0 documents are migrated; defaults are dropped). */
export function asV1(ir: v1.IrDocument | V0Document): v1.IrDocument {
  return isV0Document(ir as { schema?: unknown }) ? migrateV0ToV1(ir as V0Document) : canonicalDocument(ir as v1.IrDocument);
}

export interface PrintedV1 {
  /** Statement texts in document order, with their keys (for splicing). */
  elements: { key: string; kind: "doc" | "param" | "part" | "feature"; text: string }[];
  used: Set<string>;
  problems: PrintProblemV1[];
}

const notWellFormed = (why: string): PrintedV1 => ({
  elements: [],
  used: new Set(),
  problems: [{ code: "CS_NOT_PRINTABLE", message: `the input is not a well-formed IR document (${why})`, path: "" }],
});

/** Print every statement of a document (the statements `printV1` joins). */
export function printElementsV1(doc: v1.IrDocument): PrintedV1 {
  if (!Array.isArray(doc.parts) || doc.parts.some((p) => typeof p !== "object" || p === null || !Array.isArray(p.features))) {
    return notWellFormed("parts must be objects with a features array");
  }
  if (doc.params !== undefined && !Array.isArray(doc.params)) return notWellFormed("params must be an array");
  const pr = new Printer(doc);
  const elements: PrintedV1["elements"] = [];
  const attempt = (fn: () => string): string => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof PrintFail) return "";
      // A malformed document (e.g. a partially lowered one): not printable.
      // (A fixed reason: exception texts name JavaScript internals.)
      pr.problem("CS_NOT_PRINTABLE", "the statement cannot be printed: its IR holds a value of the wrong shape");
      return "";
    }
  };
  const docStmt = printDocStatementV1(doc.meta);
  if (docStmt !== undefined) {
    pr.use("doc");
    elements.push({ key: "doc", kind: "doc", text: docStmt });
  }
  const units = new Map<string, { kind: string; unit?: ParamUnitName }>();
  const checked = (name: string, text: string): string => {
    const problem = text === "" ? undefined : statementNestingProblem(text);
    if (problem) {
      pr.problem(
        "CS_TOO_COMPLEX",
        `the statement of ${shownText(name, '"')} would nest deeper than CadScript v1 accepts (${problem}); IR v1 does not bound query nesting: split the query with tag()`,
      );
    }
    return text;
  };
  const paramSite = (list: readonly v1.Parameter[], prefix: string, p: v1.Parameter): PrintSite => ({ path: `${prefix}/params/${list.indexOf(p)}`, param: String(p.name) });
  for (const p of orderParams(doc.params ?? [])) {
    pr.site = paramSite(doc.params ?? [], "", p);
    elements.push({ key: `param:${p.name}`, kind: "param", text: checked(p.name, attempt(() => pr.param(p, units))) });
  }
  doc.parts.forEach((part, pi) => {
    pr.site = { path: `/parts/${pi}`, partId: String(part.id) };
    pr.use("part");
    elements.push({ key: `part:${part.id}`, kind: "part", text: printPartStatementV1(part) });
    for (const p of orderParams(part.params ?? [])) {
      pr.site = paramSite(part.params ?? [], `/parts/${pi}`, p);
      elements.push({ key: `param:${p.name}`, kind: "param", text: checked(p.name, attempt(() => pr.param(p, units))) });
    }
    part.features.forEach((f, fi) => {
      pr.site = { path: `/parts/${pi}/features/${fi}`, partId: String(part.id), featureId: String(f.id) };
      const text = attempt(() => pr.feature(f));
      // forge-ir reads IR JSON at most MAX_JSON_NESTING deep (document, parts, part, features: 4 levels above a feature)
      const depth = 4 + jsonNesting(f).depth;
      if (depth > MAX_JSON_NESTING) {
        pr.problem(
          "CS_TOO_COMPLEX",
          `the feature ${shownText(String(f.name), '"')} nests ${depth} arrays and objects deep in IR JSON, deeper than forge-ir reads (${MAX_JSON_NESTING}); IR v1 does not bound query nesting: split the query with tag()`,
        );
      } else checked(f.name, text);
      elements.push({ key: `feat:${part.id}:${f.id}`, kind: "feature", text });
    });
  });
  // Names that cannot be consts, or that collide with an imported builtin.
  const importNames = new Set([...V0_BUILTINS, ...pr.used]);
  const named: [{ name: unknown }, PrintSite][] = [
    ...(doc.params ?? []).map((p, i): [{ name: unknown }, PrintSite] => [p, { path: `/params/${i}`, param: String(p.name) }]),
    ...doc.parts.flatMap((part, pi) => [
      ...(part.params ?? []).map((p, i): [{ name: unknown }, PrintSite] => [p, { path: `/parts/${pi}/params/${i}`, param: String(p.name) }]),
      ...part.features.map((f, fi): [{ name: unknown }, PrintSite] => [f, { path: `/parts/${pi}/features/${fi}`, partId: String(part.id), featureId: String(f.id) }]),
    ]),
  ];
  for (const [x, site] of named) {
    const name = String(x.name);
    if (!isBindableName(name)) pr.problem("CS_RESERVED_NAME", `${shownText(name, '"')} is not usable as a const name (identifier, not a reserved word)`, site);
    else if (importNames.has(name)) {
      pr.problem("CS_RESERVED_NAME", `${JSON.stringify(name)} collides with the builtin ${name} that the printed file imports: rename it (renameFeature) first`, site);
    }
  }
  return { elements, used: pr.used, problems: pr.problems };
}

/**
 * {@link asV1} and {@link printElementsV1} of any input: a value that is not a well-formed IR
 * document (a malformed shape the typed parse would reject) is a printability problem, never a
 * crash.
 */
export function printedV1(ir: v1.IrDocument | V0Document): PrintedV1 & { doc: v1.IrDocument | undefined } {
  try {
    const doc = asV1(ir);
    return { ...printElementsV1(doc), doc };
  } catch {
    const v0 = typeof ir === "object" && ir !== null && (ir as { schema?: unknown }).schema === "aicad.ir/0";
    return { ...notWellFormed(v0 ? "its aicad.ir/0 document cannot be migrated" : "reading it failed"), doc: undefined };
  }
}

/** Everything that makes `ir` impossible to write as CadScript v1 (empty when printable). */
export function printabilityProblemsV1(ir: v1.IrDocument | V0Document): PrintProblemV1[] {
  return printedV1(ir).problems;
}

/** Print a whole IR document (v1, or v0 through its migration) as a CadScript v1 file. */
export function printV1(ir: v1.IrDocument | V0Document, options: PrintOptionsV1 = {}): string {
  const { elements, used, problems, doc } = printedV1(ir);
  if (problems.length > 0 || !doc) throw new CadScriptV1PrintError(problems);
  const blocks: string[] = [printImportV1(used)];
  let current: string[] | undefined;
  const flush = (): void => {
    if (current && current.length > 0) blocks.push(current.join("\n"));
    current = undefined;
  };
  const featureIds = new Map<string, string>();
  for (const part of doc.parts) for (const f of part.features) featureIds.set(`feat:${part.id}:${f.id}`, f.id);
  for (const e of elements) {
    if (e.kind === "doc") {
      flush();
      blocks.push(e.text);
    } else if (e.kind === "part") {
      flush();
      current = [e.text];
    } else {
      current ??= [];
      if (e.kind === "feature") {
        const id = featureIds.get(e.key)!;
        const comment = options.comments && Object.prototype.hasOwnProperty.call(options.comments, id) ? options.comments[id] : undefined;
        if (comment) current.push(comment);
      }
      current.push(e.text);
    }
  }
  flush();
  return `${blocks.join("\n\n")}\n`;
}

export { precOf };
