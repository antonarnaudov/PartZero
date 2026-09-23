/**
 * fast-check generation of random IR v1 documents for the CadScript v1 property tests.
 *
 * `genValidDoc(g)` builds a **valid** document (IR validation returns nothing) feature by
 * feature, so every construct of the language appears: document and part parameters with typed
 * expressions, explicit and constrained sketches with every curve and constraint kind, every
 * feature type, kind-directed queries over earlier features with every op and predicate, planes,
 * axes, directions, points, cards and captures. `mutate(g, doc)` then breaks it in ways that stay
 * printable (wrong kinds, wrong feature types, option conflicts, arbitrary cards), for the
 * bijection property on invalid documents.
 */
import fc from "fast-check";
import type { v1 } from "@aicad/ir-types";
import { parseExpr, printExpr, type Expr } from "../../src/v1/expr.js";
import { scalarOf } from "../../src/v1/lower-expr.js";
import { memberNames } from "../../src/v1/validate.js";
import { RESERVED_NAMES_V1 } from "../../src/v1/syntax.js";

type G = fc.GeneratorValue;
type Obj = Record<string, unknown>;
type Kind = "face" | "edge" | "vertex" | "body";
type FT = "length" | "angle" | "ratio" | "count" | "bool";

const int = (g: G, min: number, max: number): number => g(fc.integer, { min, max });
const chance = (g: G, p: number): boolean => g(fc.double, { min: 0, max: 1, noNaN: true }) < p;
const pick = <T>(g: G, xs: readonly T[]): T => xs[int(g, 0, xs.length - 1)]!;
const noNegZero = (v: number): number => (Object.is(v, -0) ? 0 : v);

/** A literal: small integers, decimals, awkward doubles; sometimes -0 where 0 is allowed. */
function num(g: G, min: number, max: number): number {
  const v = chance(g, 0.5)
    ? int(g, Math.ceil(min), Math.floor(max))
    : chance(g, 0.6)
      ? Math.round(g(fc.double, { min, max, noNaN: true }) * 100) / 100
      : g(fc.double, { min, max, noNaN: true });
  const out = noNegZero(Math.min(max, Math.max(min, v)));
  // -0 is a literal of its own (SPEC-v1 §2.9, JSON -0.0; solved write-back produces it).
  return out === 0 && chance(g, 0.3) ? -0 : out;
}

interface Env {
  length: string[];
  angle: string[];
  ratio: string[];
  count: string[];
  bool: string[];
}

const emptyEnv = (): Env => ({ length: [], angle: [], ratio: [], count: [], bool: [] });
const cloneEnv = (e: Env): Env => ({ length: [...e.length], angle: [...e.angle], ratio: [...e.ratio], count: [...e.count], bool: [...e.bool] });

/** A well-typed expression of field type `ft` (SPEC-v1 §2.5), depth-bounded. */
function genExpr(g: G, ft: FT, env: Env, depth = 0): Expr {
  const leaf = depth >= 2 || chance(g, 0.4);
  const name = (xs: string[]): Expr | undefined => (xs.length > 0 && chance(g, 0.6) ? { k: "name", name: pick(g, xs) } : undefined);
  const lit = (min: number, max: number): Expr => ({ k: "num", v: Math.abs(num(g, min, max)) });
  const d = depth + 1;
  switch (ft) {
    case "length": {
      if (leaf) return name(env.length) ?? (chance(g, 0.2) ? { k: "num", v: Math.abs(num(g, 1, 20)), unit: pick(g, ["mm", "cm", "in"] as const) } : lit(1, 100));
      switch (int(g, 0, 7)) {
        case 0:
          return { k: "bin", op: pick(g, ["+", "-"] as const), l: genExpr(g, "length", env, d), r: genExpr(g, "length", env, d) };
        case 1:
          return { k: "bin", op: "*", l: pick(g, [lit(1, 4), genExpr(g, "ratio", env, d)]), r: genExpr(g, "length", env, d) };
        case 2:
          return { k: "bin", op: "/", l: genExpr(g, "length", env, d), r: lit(1, 8) };
        case 3:
          return { k: "call", fn: pick(g, ["min", "max"]), args: [genExpr(g, "length", env, d), genExpr(g, "length", env, d)] };
        case 4:
          return { k: "call", fn: "abs", args: [genExpr(g, "length", env, d)] };
        case 5:
          return { k: "cond", c: genExpr(g, "bool", env, d), t: genExpr(g, "length", env, d), f: genExpr(g, "length", env, d) };
        case 6:
          return { k: "bin", op: "^", l: { k: "num", v: 2 }, r: lit(1, 3) };
        default:
          return { k: "bin", op: "*", l: genExpr(g, "length", env, d), r: { k: "call", fn: "cos", args: [genExpr(g, "angle", env, d)] } };
      }
    }
    case "angle": {
      if (leaf) return name(env.angle) ?? (chance(g, 0.3) ? { k: "num", v: Math.abs(num(g, 1, 80)), unit: "deg" } : lit(1, 80));
      switch (int(g, 0, 3)) {
        case 0:
          return { k: "bin", op: "+", l: genExpr(g, "angle", env, d), r: genExpr(g, "angle", env, d) };
        case 1:
          return { k: "call", fn: "atan2", args: [genExpr(g, "length", env, d), genExpr(g, "length", env, d)] };
        case 2:
          return { k: "call", fn: pick(g, ["asin", "acos", "atan"]), args: [lit(0, 1)] };
        default:
          return { k: "bin", op: "*", l: lit(1, 3), r: genExpr(g, "angle", env, d) };
      }
    }
    case "ratio": {
      if (leaf) return name([...env.ratio, ...env.count]) ?? lit(0, 2);
      switch (int(g, 0, 2)) {
        case 0:
          return { k: "call", fn: pick(g, ["sin", "cos"]), args: [genExpr(g, "angle", env, d)] };
        case 1: {
          // both operands of fixed length (a bare literal is Flex and would leave mm or 1/mm)
          const fixed = (): Expr => (env.length.length > 0 && chance(g, 0.5) ? { k: "name", name: pick(g, env.length) } : { k: "num", v: int(g, 1, 20), unit: pick(g, ["mm", "cm", "in"] as const) });
          return { k: "bin", op: "/", l: fixed(), r: fixed() };
        }
        default:
          return { k: "un", op: "-", e: genExpr(g, "ratio", env, d) };
      }
    }
    case "count": {
      if (leaf) return name(env.count) ?? { k: "num", v: int(g, 1, 6) };
      switch (int(g, 0, 2)) {
        case 0:
          return { k: "bin", op: "+", l: genExpr(g, "count", env, d), r: { k: "num", v: int(g, 0, 3) } };
        case 1:
          return { k: "call", fn: pick(g, ["floor", "ceil", "round"]), args: [genExpr(g, "ratio", env, d)] };
        default:
          return { k: "call", fn: "max", args: [genExpr(g, "count", env, d), { k: "num", v: 2 }] };
      }
    }
    default: {
      if (leaf) return name(env.bool) ?? { k: "bool", v: chance(g, 0.5) };
      switch (int(g, 0, 3)) {
        case 0:
          return { k: "un", op: "!", e: genExpr(g, "bool", env, d) };
        case 1:
          return { k: "bin", op: pick(g, ["&&", "||"] as const), l: genExpr(g, "bool", env, d), r: genExpr(g, "bool", env, d) };
        case 2:
          return { k: "bin", op: pick(g, ["<", "<=", ">", ">=", "==", "!="] as const), l: genExpr(g, "length", env, d), r: genExpr(g, "length", env, d) };
        default:
          return { k: "bin", op: "==", l: genExpr(g, "count", env, d), r: { k: "num", v: 2 } };
      }
    }
  }
}

/**
 * Occasionally (4%) wrap an expression in a long spine of nesting (unary minus, calls, `?:`
 * branches and conditions, parenthesised right operands, `^`), up to IR v1's `MAX_EXPR_DEPTH`:
 * every depth IR v1 accepts must print and compile back.
 */
function deepen(g: G, ft: FT, e: Expr): Expr {
  if (ft === "count" || !chance(g, 0.04)) return e;
  const wrap = (x: Expr): Expr => {
    if (ft === "bool") {
      switch (int(g, 0, 2)) {
        case 0:
          return { k: "un", op: "!", e: x };
        case 1:
          return { k: "bin", op: "&&", l: { k: "bool", v: true }, r: x };
        default:
          return { k: "cond", c: x, t: { k: "bool", v: true }, f: { k: "bool", v: false } };
      }
    }
    switch (int(g, 0, 6)) {
      case 0:
        return { k: "un", op: "-", e: x };
      case 1:
        return { k: "call", fn: pick(g, ["min", "max"]), args: [x, { k: "num", v: int(g, 1, 9) }] };
      case 2:
        return { k: "call", fn: "abs", args: [x] };
      case 3:
        return { k: "cond", c: { k: "bool", v: chance(g, 0.5) }, t: x, f: { k: "num", v: 1 } };
      case 4:
        return { k: "cond", c: { k: "bool", v: true }, t: { k: "num", v: 1 }, f: x };
      case 5:
        return { k: "bin", op: "-", l: { k: "num", v: int(g, 1, 9) }, r: x };
      default:
        return { k: "bin", op: "*", l: x, r: { k: "bin", op: "^", l: { k: "num", v: 1 }, r: { k: "num", v: 1 } } };
    }
  };
  let out = e;
  const n = int(g, 8, 64);
  for (let i = 0; i < n; i++) {
    const next = wrap(out);
    if (!parseExpr(printExpr(next)).ok) break; // beyond MAX_EXPR_DEPTH: stop at the boundary
    out = next;
  }
  return out;
}

/** A Scalar of field type `ft`: a literal in [min, max] (range-checked fields), or an expression. */
function scalar(g: G, ft: FT, env: Env, min: number, max: number, exprChance = 0.35): number | string {
  if (!chance(g, exprChance)) return ft === "count" ? int(g, Math.ceil(min), Math.floor(max)) : num(g, min, max);
  const s = scalarOf(deepen(g, ft, genExpr(g, ft, env)));
  return s.kind === "num" ? (ft === "count" ? int(g, Math.ceil(min), Math.floor(max)) : num(g, min, max)) : s.text;
}

function boolScalar(g: G, env: Env): boolean | string {
  if (chance(g, 0.7)) return chance(g, 0.5);
  const e = deepen(g, "bool", genExpr(g, "bool", env));
  return e.k === "bool" ? e.v : printExpr(e);
}

// ─── Document model while generating ─────────────────────────────────────────────────────────

interface SketchInfo {
  id: string;
  profile: { id: string; cls: "line" | "arc" | "circle" }[];
  points: string[];
}
interface FeatInfo {
  id: string;
  name: string;
  type: string;
  /** extrude/revolve: the consumed sketch. */
  sketch?: SketchInfo;
  /** hole: position ids. */
  positions?: string[];
  /** tag: target kind. */
  tagKind?: Kind;
}

class PartState {
  readonly features: FeatInfo[] = [];
  readonly sketches: SketchInfo[] = [];
  constructor(readonly env: Env) {}
  ofType(...types: string[]): FeatInfo[] {
    return this.features.filter((f) => types.includes(f.type));
  }
}

const NAME_STEMS = ["plate", "base", "boss", "rim", "cut", "ring", "arm", "lid", "wall", "hub", "slot1", "grip", "tab", "web"];

class Names {
  private n = 0;
  readonly used = new Set<string>();
  next(g: G, prefix?: string): string {
    for (;;) {
      const stem = prefix ?? pick(g, NAME_STEMS);
      const name = `${stem}${this.n++}`;
      if (!this.used.has(name) && !RESERVED_NAMES_V1.has(name)) {
        this.used.add(name);
        return name;
      }
    }
  }
}

// ─── Queries (kind-directed) ─────────────────────────────────────────────────────────────────

const FACE_TYPES = ["plane", "cylinder", "cone", "sphere", "torus", "bspline"] as const;
const EDGE_TYPES = ["line", "circle", "ellipse", "bspline"] as const;

function dirValue(g: G, st: PartState, depth: number): unknown {
  switch (int(g, 0, 4)) {
    case 0:
      return pick(g, ["X", "Y", "Z"]);
    case 1:
      return pick(g, ["+X", "-X", "+Y", "-Y", "+Z", "-Z"]);
    case 2: {
      const v = [scalar(g, "ratio", st.env, -1, 1, 0.1), scalar(g, "ratio", st.env, -1, 1, 0.1), 1 + int(g, 0, 2)];
      return v;
    }
    case 3:
      return depth < 2 ? axisObject(g, st, depth + 1) : "Z";
    default:
      return pick(g, ["X", "Y", "Z"]);
  }
}

function axisObject(g: G, st: PartState, depth: number): Obj {
  const out: Obj = {};
  const axes = st.ofType("datum_axis");
  const sweeps = st.ofType("extrude", "revolve");
  const which = int(g, 0, 3);
  const edge = which === 1 && sweeps.length > 0 ? ref(g, st, "edge", "single", depth + 1) : null;
  const cyl = which === 2 && sweeps.length > 0 ? ref(g, st, "face", "single", depth + 1) : null;
  if (which === 0 && axes.length > 0) out["datum"] = pick(g, axes).id;
  else if (edge) out["edge"] = edge;
  else if (cyl) out["cylinder"] = cyl;
  else out["line"] = { origin: [num(g, -10, 10), num(g, -10, 10), num(g, -10, 10)], direction: [0, 0, 1 + int(g, 0, 3)] };
  if (chance(g, 0.3)) out["flip"] = chance(g, 0.5) ? true : boolScalar(g, st.env);
  if (out["flip"] === false) delete out["flip"];
  return out;
}

/** A query of static kind `kind` over the part's earlier features (null when none can be made). */
function query(g: G, st: PartState, kind: Kind, depth = 0): Obj | null {
  const sweeps = st.ofType("extrude", "revolve");
  const opts: (() => Obj | null)[] = [];
  const deeper = depth < 3;
  const profileOf = (f: FeatInfo): SketchInfo["profile"] => f.sketch?.profile ?? [];
  if (kind === "face") {
    const ex = st.ofType("extrude").filter((f) => profileOf(f).length > 0);
    if (ex.length > 0) {
      opts.push(() => {
        const f = pick(g, ex);
        const q: Obj = { op: "cap", feature: f.id, end: pick(g, ["start", "end"]) };
        if (chance(g, 0.3)) q["member"] = pick(g, profileOf(f)).id;
        return q;
      });
    }
    const rev = st.ofType("revolve").filter((f) => profileOf(f).length > 0);
    if (rev.length > 0) {
      opts.push(() => {
        const f = pick(g, rev);
        const q: Obj = { op: "endcap", feature: f.id, end: pick(g, ["start", "end"]) };
        if (chance(g, 0.3)) q["member"] = pick(g, profileOf(f)).id;
        return q;
      });
    }
    const withProfile = sweeps.filter((f) => profileOf(f).length > 0);
    if (withProfile.length > 0) {
      opts.push(() => {
        const f = pick(g, withProfile);
        return { op: "side", feature: f.id, curve: pick(g, profileOf(f)).id };
      });
      opts.push(() => {
        const f = pick(g, withProfile);
        const q: Obj = { op: "sides", feature: f.id };
        if (chance(g, 0.3)) q["member"] = pick(g, profileOf(f)).id;
        return q;
      });
    }
    const holes = st.ofType("hole").filter((h) => (h.positions ?? []).length > 0);
    if (holes.length > 0) {
      opts.push(() => {
        const h = pick(g, holes);
        return { op: "hole_face", feature: h.id, at: pick(g, h.positions!), part: pick(g, ["wall", "tip", "floor", "cbore_wall", "cbore_floor", "csink"]) };
      });
    }
    const creators = st.ofType("extrude", "revolve", "boolean", "hole", "fillet", "chamfer", "shell", "draft", "pattern");
    if (creators.length > 0) {
      opts.push(() => {
        const q: Obj = { op: "created", feature: pick(g, creators).id };
        if (chance(g, 0.3)) q["role"] = pick(g, ["tip", "wall", "blend", "offset"]);
        return q;
      });
    }
    const patterns = st.ofType("pattern");
    if (patterns.length > 0) opts.push(() => ({ op: "instance", feature: pick(g, patterns).id, index: chance(g, 0.5) ? [int(g, 1, 3)] : [int(g, 0, 2), int(g, 1, 2)] }));
  }
  if (kind === "edge") {
    const withEnds = sweeps.filter((f) => profileOf(f).some((c) => c.cls !== "circle"));
    if (withEnds.length > 0) {
      opts.push(() => {
        const f = pick(g, withEnds);
        return { op: "edge_at", feature: f.id, curve: pick(g, profileOf(f).filter((c) => c.cls !== "circle")).id, end: pick(g, ["start", "end"]) };
      });
    }
    if (deeper) {
      opts.push(() => {
        const a = query(g, st, "face", depth + 1);
        const b = query(g, st, "face", depth + 1);
        return a && b ? { op: "between", a, b } : null;
      });
    }
  }
  if (kind === "body") {
    const origins = st.ofType("extrude", "revolve", "pattern");
    if (origins.length > 0) {
      opts.push(() => {
        const f = pick(g, origins);
        const q: Obj = { op: "body", feature: f.id };
        if (f.type !== "pattern" && profileOf(f).length > 0 && chance(g, 0.3)) q["member"] = pick(g, profileOf(f)).id;
        return q;
      });
    }
    opts.push(() => ({ op: "bodies" }));
  }
  const tags = st.features.filter((f) => f.type === "tag" && f.tagKind === kind);
  if (tags.length > 0) opts.push(() => ({ op: "tagged", feature: pick(g, tags).id }));
  if (deeper) {
    const nav: Record<Kind, [string, Kind[]]> = {
      face: ["faces", ["body", "edge", "vertex"]],
      edge: ["edges", ["body", "face", "vertex"]],
      vertex: ["vertices", ["body", "face", "edge"]],
      body: ["owner", ["face", "edge", "vertex"]],
    };
    const [op, from] = nav[kind];
    opts.push(() => {
      const of = query(g, st, pick(g, from), depth + 1);
      return of ? { op, of } : null;
    });
    opts.push(() => {
      const of = query(g, st, kind, depth + 1);
      if (!of) return null;
      const s = int(g, 0, 3);
      if (s === 0) {
        const others = Array.from({ length: int(g, 0, 2) }, () => query(g, st, kind, depth + 1)).filter((x): x is Obj => x !== null);
        return { op: pick(g, ["union", "intersect"]), of: [of, ...others] };
      }
      if (s === 1) {
        const b = query(g, st, kind, depth + 1);
        return b ? { op: "minus", a: of, b } : null;
      }
      if (s === 2) return { op: "extreme", of, dir: dirValue(g, st, depth), which: pick(g, ["max", "min"]) };
      if (kind === "vertex") return { op: "extreme", of, dir: pick(g, ["+Z", "X"]), which: "max" };
      return { op: pick(g, ["largest", "smallest"]), of };
    });
    if (kind === "face" || kind === "edge") {
      opts.push(() => {
        const of = query(g, st, kind, depth + 1);
        if (!of) return null;
        return { op: "filter", of, where: predicate(g, st, kind, depth) };
      });
    }
  }
  for (let attempt = 0; attempt < 4 && opts.length > 0; attempt++) {
    const q = pick(g, opts)();
    if (q) return q;
  }
  return null;
}

function predicate(g: G, st: PartState, kind: "face" | "edge", depth: number): Obj {
  const choices = kind === "face" ? ["type", "normal", "parallel", "perpendicular", "radius"] : ["type", "parallel", "perpendicular", "convex", "concave", "smooth", "radius"];
  const c = pick(g, choices);
  switch (c) {
    case "type":
      return { type: pick(g, kind === "face" ? FACE_TYPES : EDGE_TYPES) };
    case "normal":
    case "parallel":
    case "perpendicular":
      return { [c]: dirValue(g, st, depth + 1) };
    case "radius": {
      if (chance(g, 0.5)) return { radius: { eq: scalar(g, "length", st.env, 0, 20) } };
      const r: Obj = {};
      if (chance(g, 0.7)) r["min"] = scalar(g, "length", st.env, 0, 5);
      if (!("min" in r) || chance(g, 0.5)) r["max"] = scalar(g, "length", st.env, 5, 30);
      return { radius: r };
    }
    default:
      return { [c]: true };
  }
}

type CardMode = "single" | "set";

function card(g: G, mode: CardMode): unknown {
  if (chance(g, 0.5)) return undefined;
  if (mode === "single") return pick(g, ["one", 1]);
  return pick(g, ["one", "some", "any", int(g, 1, 6)]);
}

function capture(g: G): Obj {
  const members = Array.from({ length: int(g, 1, 2) }, (_, i) => {
    const m: Obj = {
      key: `e1/side:c${i}`,
      via: pick(g, ["named", "broad"]),
      geom: {
        type: "plane",
        carrier: chance(g, 0.5) ? "free" : { plane: { normal: [0, -1, 0], offset: num(g, 0, 50) } },
        bbox: [
          [-40, -25, 0],
          [40, -25, 8],
        ],
        size: num(g, 0, 1000),
        centroid: [0, -25, 4],
        local: [0.5, 0, 0.5],
        body_center: [0, 0, 4],
        neighbors: int(g, 0, 2),
      },
    };
    if (chance(g, 0.3)) m["faces"] = ["e1/cap:end@a", "e1/side:b"];
    return m;
  });
  return { members };
}

/**
 * Occasionally (3%) wrap a query in a long spine of filters, unions (nested in the argument) and
 * minus chains: IR v1 does not bound query nesting, and CadScript prints and compiles back this
 * much (its limits are tested in limits.test.ts).
 */
function deepenQuery(g: G, kind: Kind, q: Obj): Obj {
  if (!chance(g, 0.03)) return q;
  let out = q;
  const n = int(g, 5, 30);
  for (let i = 0; i < n; i++) {
    const s = int(g, 0, 2);
    if (s === 0 && (kind === "face" || kind === "edge")) out = { op: "filter", of: out, where: { type: kind === "face" ? "plane" : "line" } };
    else if (s === 1) out = { op: "union", of: [structuredClone(q), out] };
    else out = { op: "minus", a: out, b: structuredClone(q) };
  }
  return out;
}

/** A Ref of `kind` (null when no query can be made). */
function ref(g: G, st: PartState, kind: Kind, mode: CardMode, depth = 0): Obj | null {
  const found = query(g, st, kind, depth);
  if (!found) return null;
  const q = depth === 0 ? deepenQuery(g, kind, found) : found;
  const r: Obj = { kind, q };
  const c = card(g, mode);
  if (c !== undefined) r["card"] = c;
  if (chance(g, 0.15)) r["capture"] = capture(g);
  return r;
}

function planeRef(g: G, st: PartState): unknown {
  const s = int(g, 0, 5);
  if (s === 1) return frame(g, st.env);
  if (s === 2) {
    const face = ref(g, st, "face", "single");
    if (face) {
      const p: Obj = { face };
      if (chance(g, 0.2)) p["origin"] = [num(g, -5, 5), num(g, -5, 5), num(g, -5, 5)];
      if (chance(g, 0.2)) p["x_dir"] = [1, 0, 0];
      return p;
    }
  }
  if (s === 3) {
    const dps = st.ofType("datum_plane");
    if (dps.length > 0) return { datum: pick(g, dps).id };
  }
  return pick(g, ["XY", "XZ", "YZ"]);
}

function frame(g: G, env: Env): Obj {
  const [normal, x] = pick(g, [
    [
      [0, 0, 1],
      [1, 0, 0],
    ],
    [
      [0, -1, 0],
      [1, 0, 0],
    ],
    [
      [1, 0, 0],
      [0, 1, 0],
    ],
    [
      [0, 0, -2],
      [0, 3, 0],
    ],
  ] as const);
  return { origin: [scalar(g, "length", env, -20, 20), num(g, -20, 20), num(g, -20, 20)], normal: [...normal], x_dir: [...x] };
}

function axisRef(g: G, st: PartState): unknown {
  return chance(g, 0.4) ? pick(g, ["X", "Y", "Z"]) : axisObject(g, st, 1);
}

function pointRef(g: G, st: PartState): unknown {
  if (chance(g, 0.3)) {
    const v = ref(g, st, "vertex", "single");
    if (v) return { vertex: v };
  }
  return [num(g, -20, 20), num(g, -20, 20), scalar(g, "length", st.env, -20, 20)];
}

function targets(g: G, st: PartState): unknown {
  if (chance(g, 0.3)) return "all";
  return ref(g, st, "body", "set") ?? "all";
}

// ─── Sketches ────────────────────────────────────────────────────────────────────────────────

function p2(g: G, env: Env, exprs: boolean): (number | string)[] {
  return [exprs ? scalar(g, "length", env, -50, 50, 0.2) : num(g, -50, 50), exprs ? scalar(g, "length", env, -50, 50, 0.2) : num(g, -50, 50)];
}

function lineCurve(g: G, id: string, env: Env, exprs: boolean): Obj {
  const a = [num(g, -50, 50), num(g, -50, 50)];
  const b = [a[0]! + num(g, 1, 30), a[1]! + num(g, -30, 30)];
  const start = exprs && chance(g, 0.3) ? [scalar(g, "length", env, -50, 50, 1), a[1]!] : a;
  return { kind: "line", id, start, end: b };
}

function arcCurve(g: G, id: string): Obj {
  const c = [int(g, -40, 40), int(g, -40, 40)];
  const r = num(g, 1, 20);
  const a0 = num(g, 0, 6);
  const da = num(g, 0.3, 5.5);
  const at = (a: number): number[] => [noNegZero(c[0]! + r * Math.cos(a)), noNegZero(c[1]! + r * Math.sin(a))];
  return { kind: "arc", id, start: at(a0), end: at(a0 + da), center: c, ccw: chance(g, 0.5) };
}

function sketchFeature(g: G, st: PartState, id: string, name: string): { f: Obj; info: SketchInfo } {
  const env = st.env;
  const info: SketchInfo = { id, profile: [], points: [] };
  const curves: Obj[] = [];
  const constrained = chance(g, 0.25);
  const n = int(g, 1, 4);
  const ents: { id: string; ent: "point" | "line" | "arc" | "circle" }[] = [];
  for (let i = 0; i < n; i++) {
    const cid = `c${i}`;
    const kinds = constrained ? ["line", "arc", "circle", "point"] : ["line", "arc", "circle", "point", "rect", "slot", "polygon"];
    const kind = pick(g, kinds);
    const construction = chance(g, 0.15);
    let c: Obj;
    switch (kind) {
      case "line":
        c = lineCurve(g, cid, env, !constrained);
        ents.push({ id: cid, ent: "line" }, { id: `${cid}.start`, ent: "point" }, { id: `${cid}.end`, ent: "point" });
        break;
      case "arc":
        c = arcCurve(g, cid);
        ents.push({ id: cid, ent: "arc" }, { id: `${cid}.start`, ent: "point" }, { id: `${cid}.end`, ent: "point" }, { id: `${cid}.center`, ent: "point" });
        break;
      case "circle":
        c = { kind: "circle", id: cid, center: p2(g, env, !constrained), radius: constrained ? num(g, 0.5, 20) : scalar(g, "length", env, 0.5, 20) };
        ents.push({ id: cid, ent: "circle" }, { id: `${cid}.center`, ent: "point" });
        info.points.push(`${cid}.center`);
        break;
      case "point":
        c = { kind: "point", id: cid, at: p2(g, env, !constrained) };
        ents.push({ id: cid, ent: "point" });
        info.points.push(cid);
        break;
      case "rect": {
        const w = num(g, 2, 80);
        const h = num(g, 2, 80);
        c = { kind: "rect", id: cid, w: chance(g, 0.3) ? scalar(g, "length", env, 2, 80, 1) : w, h };
        c[chance(g, 0.6) ? "center" : "corner"] = p2(g, env, true);
        const wv = typeof c["w"] === "number" ? (c["w"] as number) : h;
        if (chance(g, 0.5)) c["r"] = num(g, 0, Math.min(wv, h) / 2);
        break;
      }
      case "slot":
        c = { kind: "slot", id: cid, a: [0, 0], b: [num(g, 1, 30), num(g, -5, 5)], w: scalar(g, "length", env, 0.5, 10) };
        break;
      default: {
        c = { kind: "polygon", id: cid, center: chance(g, 0.5) ? [0, 0] : p2(g, env, true), n: chance(g, 0.8) ? int(g, 3, 8) : scalar(g, "count", env, 3, 8, 1) };
        c[pick(g, ["circumradius", "inradius", "across_flats", "side"])] = scalar(g, "length", env, 1, 20);
        if (chance(g, 0.3)) c["rotation"] = scalar(g, "angle", env, -90, 90);
        break;
      }
    }
    if (construction) c["construction"] = true;
    curves.push(c);
    if (!construction) {
      if (kind === "line" || kind === "arc" || kind === "circle") info.profile.push({ id: cid, cls: kind });
      else if (kind !== "point") {
        const nn = kind === "polygon" && typeof c["n"] === "number" ? (c["n"] as number) : kind === "polygon" ? undefined : undefined;
        if (kind === "polygon" && nn === undefined) info.profile.push({ id: `${cid}.e0`, cls: "line" });
        for (const m of memberNames(kind, nn)) info.profile.push({ id: `${cid}.${m}`, cls: m.startsWith("c_") || m.startsWith("cap_") ? "arc" : "line" });
      }
    }
  }
  const f: Obj = { type: "sketch", id, name, plane: planeRef(g, st), curves };
  if (constrained) {
    const constraints: Obj[] = [];
    const of = (t: string): string[] => ents.filter((e) => e.ent === t).map((e) => e.id);
    const points = of("point");
    const lines = of("line");
    const curvesC = [...of("arc"), ...of("circle")];
    const two = (xs: string[]): [string, string] | null => {
      if (xs.length < 2) return null;
      const a = pick(g, xs);
      const b = pick(g, xs.filter((x) => x !== a));
      return [a, b];
    };
    const k = int(g, 1, 5);
    for (let i = 0; i < k; i++) {
      const cid = `k${i}`;
      const t = pick(g, ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "tangent", "equal", "distance", "angle", "radius", "diameter", "point_on_line", "point_on_circle", "midpoint", "symmetric", "fix"]);
      let c: Obj | null = null;
      const dimValue = (ft: FT, min: number, max: number): Obj => (chance(g, 0.2) ? { driving: false } : { value: scalar(g, ft, env, min, max) });
      switch (t) {
        case "coincident": {
          const ab = two(points);
          if (ab) c = { type: t, id: cid, a: ab[0], b: ab[1] };
          break;
        }
        case "horizontal":
        case "vertical":
          if (lines.length > 0) c = { type: t, id: cid, line: pick(g, lines) };
          break;
        case "parallel":
        case "perpendicular": {
          const ab = two(lines);
          if (ab) c = { type: t, id: cid, a: ab[0], b: ab[1] };
          break;
        }
        case "angle": {
          const ab = two(lines);
          if (ab) c = { type: t, id: cid, a: ab[0], b: ab[1], ...dimValue("angle", -170, 170) };
          break;
        }
        case "tangent": {
          if (lines.length > 0 && curvesC.length > 0) c = { type: t, id: cid, a: pick(g, lines), b: pick(g, curvesC) };
          else {
            const ab = two(curvesC);
            if (ab) c = { type: t, id: cid, a: ab[0], b: ab[1] };
          }
          if (c && chance(g, 0.3)) c["internal"] = chance(g, 0.5);
          break;
        }
        case "equal": {
          const ab = two(chance(g, 0.5) ? lines : curvesC) ?? two(lines);
          if (ab) c = { type: t, id: cid, a: ab[0], b: ab[1] };
          break;
        }
        case "distance": {
          if (points.length >= 1 && (points.length >= 2 || lines.length >= 1)) {
            const a = pick(g, points);
            const bs = [...points.filter((p) => p !== a), ...lines];
            c = { type: t, id: cid, a, b: pick(g, bs), ...dimValue("length", 0.5, 50) };
          }
          break;
        }
        case "radius":
        case "diameter":
          if (curvesC.length > 0) c = { type: t, id: cid, curve: pick(g, curvesC), ...dimValue("length", 0.5, 30) };
          break;
        case "point_on_line":
        case "midpoint":
          if (points.length > 0 && lines.length > 0) c = { type: t, id: cid, point: pick(g, points), line: pick(g, lines) };
          break;
        case "point_on_circle":
          if (points.length > 0 && curvesC.length > 0) c = { type: t, id: cid, point: pick(g, points), curve: pick(g, curvesC) };
          break;
        case "symmetric": {
          const ab = two(points);
          if (ab && lines.length > 0) c = { type: t, id: cid, a: ab[0], b: ab[1], line: pick(g, lines) };
          break;
        }
        default: {
          const fixable = [...points, ...lines, ...of("circle")];
          if (fixable.length > 0) {
            const e = pick(g, fixable);
            c = { type: "fix", id: cid, entity: e };
            if (points.includes(e) && chance(g, 0.4)) {
              c["x"] = num(g, -10, 10);
              if (chance(g, 0.5)) c["y"] = num(g, -10, 10);
            }
          }
        }
      }
      if (c) constraints.push(c);
    }
    if (constraints.length > 0) f["constraints"] = constraints;
    else if (curves.some((c) => ["rect", "slot", "polygon"].includes(String(c["kind"])))) {
      // (cannot happen: constrained sketches have no compound curves)
    }
  }
  return { f, info };
}

// ─── Features ────────────────────────────────────────────────────────────────────────────────

function common(g: G, f: Obj, env: Env): void {
  if (chance(g, 0.1)) f["suppressed"] = boolScalar(g, env);
  if (f["suppressed"] === false) delete f["suppressed"];
  if (chance(g, 0.05)) f["note"] = pick(g, ["a note", "why: “quotes” and \\ backslash", "line1\nline2"]);
  if (chance(g, 0.03)) f["assumptions"] = ["m3 screws"];
  if (chance(g, 0.03)) f["decision_ids"] = ["adr-1"];
  if (chance(g, 0.03)) f["intent"] = "mount";
  if (chance(g, 0.03)) f["author"] = "agent";
}

function holeFeature(g: G, st: PartState, f: Obj): string[] | null {
  const env = st.env;
  const face = ref(g, st, "face", "single");
  const onFace = face !== null && chance(g, 0.8);
  f["on"] = onFace ? { face } : planeRef(g, st);
  if (onFace && chance(g, 0.2)) f["flip"] = boolScalar(g, env);
  if (f["flip"] === false) delete f["flip"];
  // placement
  let positions: string[] = [];
  const pointSketches = st.sketches.filter((s) => s.points.length > 0);
  const s = int(g, 0, 3);
  if (s === 0) {
    f["at"] = { grid: { nx: scalar(g, "count", env, 1, 3), ny: scalar(g, "count", env, 1, 3), dx: scalar(g, "length", env, 1, 40), dy: scalar(g, "length", env, 1, 40), ...(chance(g, 0.3) ? { center: [num(g, -5, 5), 3] } : {}) } };
    positions = ["g0_0"];
  } else if (s === 1) {
    const c: Obj = { n: scalar(g, "count", env, 1, 6), d: scalar(g, "length", env, 5, 60) };
    if (chance(g, 0.3)) c["center"] = [num(g, -5, 5), num(g, -5, 5)];
    if (chance(g, 0.3)) c["start"] = scalar(g, "angle", env, 1, 90);
    f["at"] = { circle: c };
    positions = ["c0"];
  } else if (s === 2 && pointSketches.length > 0) {
    const sk = pick(g, pointSketches);
    const ids = chance(g, 0.3) ? "all" : sk.points.slice(0, int(g, 1, sk.points.length));
    f["at"] = { points: { sketch: sk.id, ids } };
    positions = (ids === "all" ? sk.points : ids).filter((p) => !p.includes("."));
  } else {
    const list = Array.from({ length: int(g, 1, 3) }, (_, i) => ({ id: `h${i}`, at: p2(g, env, true) }));
    f["at"] = { list };
    positions = list.map((p) => p.id);
  }
  const sizes = ["M2", "M2.5", "M3", "M4", "M5", "M6", "M8"];
  const sized = chance(g, 0.6);
  const size = sized ? pick(g, sizes) : undefined;
  if (size) f["size"] = size;
  else f["d"] = scalar(g, "length", env, 1, 12);
  const has = (sz: string | undefined, field: "cbore" | "csink" | "insert"): boolean => {
    if (!sz) return false;
    if (field === "cbore") return sz !== "M2";
    if (field === "csink") return sz !== "M2" && sz !== "M2.5";
    return true;
  };
  const head = pick(g, ["none", "none", "cbore", "csink", "insert"]);
  if (head === "cbore") f["cbore"] = has(size, "cbore") && chance(g, 0.6) ? "iso4762" : { d: scalar(g, "length", env, 5, 20), depth: scalar(g, "length", env, 1, 6) };
  if (head === "csink") {
    f["csink"] = has(size, "csink") && chance(g, 0.6) ? "iso10642" : { d: scalar(g, "length", env, 5, 20), ...(chance(g, 0.5) ? { angle: scalar(g, "angle", env, 60, 120) } : {}) };
  }
  if (head === "insert") f["insert"] = has(size, "insert") && chance(g, 0.6) ? "std" : { d: scalar(g, "length", env, 3, 9), depth: scalar(g, "length", env, 3, 12) };
  if (head !== "insert") {
    const depthKind = int(g, 0, 2);
    if (depthKind === 0) f["depth"] = "through";
    else if (depthKind === 1) {
      f["depth"] = { blind: scalar(g, "length", env, 1, 20) };
      if (chance(g, 0.3)) f["tip"] = chance(g, 0.5) ? "flat" : scalar(g, "angle", env, 60, 150);
    } else {
      const up = ref(g, st, "face", "single");
      f["depth"] = up ? { up_to: up } : "through";
    }
    if (chance(g, 0.2)) {
      f["thread"] = size && chance(g, 0.5) ? true : { pitch: scalar(g, "length", env, 0.3, 1.5), ...(chance(g, 0.5) ? { depth: scalar(g, "length", env, 1, 8) } : {}) };
    }
  }
  const threaded = f["thread"] !== undefined;
  const fit = pick(g, threaded ? ["normal", "tap"] : ["close", "normal", "loose", "tap"]);
  if (sized && chance(g, 0.4)) f["fit"] = fit;
  if (!onFace) f["targets"] = targets(g, st);
  else if (chance(g, 0.2)) f["targets"] = targets(g, st);
  return positions;
}

function patternFeature(g: G, st: PartState, f: Obj): boolean {
  const env = st.env;
  const seeds = st.ofType("extrude", "revolve", "hole");
  const featureSeeds = seeds.length > 0 && chance(g, 0.6);
  if (featureSeeds) {
    const n = int(g, 1, Math.min(2, seeds.length));
    const chosen = new Set<string>();
    while (chosen.size < n) chosen.add(pick(g, seeds).id);
    f["seed"] = { features: [...chosen] };
  } else {
    const b = ref(g, st, "body", "set");
    if (!b) return false;
    f["seed"] = { bodies: b };
  }
  let counts: [number | undefined, number | undefined] = [undefined, undefined];
  let twoD = false;
  const layout = int(g, 0, 2);
  if (layout === 0) {
    const count = scalar(g, "count", env, 1, 5);
    const l: Obj = { dir: dirValue(g, st, 0), count, spacing: chance(g, 0.5) ? num(g, 1, 30) : -num(g, 1, 30) };
    if (chance(g, 0.3)) {
      l["dir2"] = dirValue(g, st, 0);
      l["spacing2"] = scalar(g, "length", env, 1, 30);
      if (chance(g, 0.6)) l["count2"] = scalar(g, "count", env, 1, 4);
      twoD = true;
    }
    f["layout"] = { linear: l };
    counts = [typeof count === "number" ? count : undefined, twoD ? (typeof l["count2"] === "number" ? (l["count2"] as number) : l["count2"] === undefined ? 1 : undefined) : undefined];
  } else if (layout === 1) {
    const count = scalar(g, "count", env, 2, 8);
    const c: Obj = { axis: axisRef(g, st), count };
    if (chance(g, 0.3)) c["angle"] = scalar(g, "angle", env, 10, 360);
    f["layout"] = { circular: c };
    counts = [typeof count === "number" ? count : undefined, undefined];
  } else {
    f["layout"] = { mirror: { plane: planeRef(g, st) } };
    counts = [2, undefined];
  }
  if (chance(g, 0.3) && (counts[0] ?? 0) >= 2 && (!twoD || (counts[1] ?? 0) >= 1)) {
    f["skip"] = [twoD ? [int(g, 1, counts[0]! - 1), counts[1] !== undefined ? int(g, 0, counts[1] - 1) : 0] : [int(g, 1, counts[0]! - 1)]];
  }
  if (!featureSeeds && chance(g, 0.3)) {
    f["op"] = "join";
    f["targets"] = targets(g, st);
  }
  return true;
}

function datumPlaneFeature(g: G, st: PartState, f: Obj): void {
  const env = st.env;
  switch (int(g, 0, 4)) {
    case 0:
      Object.assign(f, { mode: "offset", from: planeRef(g, st), distance: scalar(g, "length", env, -20, 20) });
      break;
    case 1:
      Object.assign(f, { mode: "angle", from: pick(g, ["XY", "XZ", "YZ"]), axis: pick(g, ["X", "Y", "Z"]), angle: scalar(g, "angle", env, -80, 80) });
      break;
    case 2:
      Object.assign(f, { mode: "midplane", a: planeRef(g, st), b: planeRef(g, st) });
      break;
    case 3:
      Object.assign(f, { mode: "through", points: [pointRef(g, st), pointRef(g, st), pointRef(g, st)] });
      break;
    default: {
      const fr = frame(g, env);
      Object.assign(f, { mode: "frame", origin: fr["origin"], normal: fr["normal"], x_dir: fr["x_dir"] });
    }
  }
}

function datumAxisFeature(g: G, st: PartState, f: Obj): boolean {
  switch (int(g, 0, 3)) {
    case 0: {
      const e = ref(g, st, "edge", "single");
      if (!e) return false;
      Object.assign(f, { mode: "edge", edge: e });
      break;
    }
    case 1: {
      const c = ref(g, st, "face", "single");
      if (!c) return false;
      Object.assign(f, { mode: "cylinder", face: c });
      break;
    }
    case 2:
      Object.assign(f, { mode: "planes", a: planeRef(g, st), b: planeRef(g, st) });
      break;
    default:
      Object.assign(f, { mode: "points", points: [pointRef(g, st), [num(g, 30, 40), 1, 2]] });
  }
  if (chance(g, 0.2)) f["flip"] = boolScalar(g, st.env);
  if (f["flip"] === false) delete f["flip"];
  return true;
}

/** One feature of `type` (null when its preconditions do not hold). */
function feature(g: G, st: PartState, type: string, id: string, name: string): { f: Obj; info: FeatInfo } | null {
  const env = st.env;
  const f: Obj = { type, id, name };
  const info: FeatInfo = { id, name, type };
  switch (type) {
    case "sketch": {
      const s = sketchFeature(g, st, id, name);
      st.sketches.push(s.info);
      Object.assign(f, s.f);
      break;
    }
    case "extrude":
    case "revolve": {
      if (st.sketches.length === 0) return null;
      const sk = pick(g, st.sketches);
      info.sketch = sk;
      f["sketch"] = sk.id;
      if (chance(g, 0.2) && sk.profile.length > 0) f["regions"] = [pick(g, sk.profile).id];
      if (type === "extrude") f["distance"] = scalar(g, "length", env, 0.5, 50);
      else {
        f["axis"] = { origin: p2(g, env, true), direction: [0, 1 + int(g, 0, 2)] };
        f["angle"] = scalar(g, "angle", env, 10, 360);
      }
      if (chance(g, 0.3)) f["direction"] = pick(g, ["normal", "reverse", "symmetric"]);
      if (st.ofType("extrude", "revolve", "pattern").length > 0 && chance(g, 0.3)) {
        f["op"] = pick(g, ["join", "cut", "intersect"]);
        f["targets"] = targets(g, st);
      }
      break;
    }
    case "boolean": {
      const t = ref(g, st, "body", "set");
      const tl = ref(g, st, "body", "set");
      if (!t || !tl) return null;
      Object.assign(f, { op: pick(g, ["join", "cut", "intersect"]), targets: t, tools: tl });
      if (chance(g, 0.2)) f["keep_tools"] = boolScalar(g, env);
      if (f["keep_tools"] === false) delete f["keep_tools"];
      break;
    }
    case "hole": {
      const positions = holeFeature(g, st, f);
      if (!positions) return null;
      info.positions = positions;
      break;
    }
    case "fillet": {
      const e = ref(g, st, "edge", "set");
      if (!e) return null;
      Object.assign(f, { edges: e, r: scalar(g, "length", env, 0.1, 5) });
      if (chance(g, 0.2)) f["tangent_chain"] = chance(g, 0.5) ? false : boolScalar(g, env);
      if (f["tangent_chain"] === true) delete f["tangent_chain"];
      break;
    }
    case "chamfer": {
      const e = ref(g, st, "edge", "set");
      if (!e) return null;
      Object.assign(f, { edges: e, d: scalar(g, "length", env, 0.1, 5) });
      const form = int(g, 0, 2);
      if (form > 0) {
        const side = ref(g, st, "face", "single");
        if (side) {
          if (form === 1) f["d2"] = scalar(g, "length", env, 0.1, 5);
          else f["angle"] = scalar(g, "angle", env, 10, 80);
          f["side"] = side;
        }
      }
      break;
    }
    case "shell": {
      const b = ref(g, st, "body", "single");
      if (!b) return null;
      f["body"] = b;
      if (chance(g, 0.6)) {
        const o = ref(g, st, "face", "set");
        if (o) f["open"] = o;
      }
      f["thickness"] = scalar(g, "length", env, 0.5, 4);
      if (chance(g, 0.2)) f["direction"] = "outward";
      break;
    }
    case "draft": {
      const fs = ref(g, st, "face", "set");
      if (!fs) return null;
      Object.assign(f, { faces: fs, neutral: planeRef(g, st), angle: scalar(g, "angle", env, 0.5, 40) });
      if (chance(g, 0.2)) f["pull"] = "reverse";
      break;
    }
    case "pattern":
      if (!patternFeature(g, st, f)) return null;
      break;
    case "datum_plane":
      datumPlaneFeature(g, st, f);
      break;
    case "datum_axis":
      if (!datumAxisFeature(g, st, f)) return null;
      break;
    default: {
      const kind = pick(g, ["face", "edge", "vertex", "body"] as const);
      const t = ref(g, st, kind, "set");
      if (!t) return null;
      f["target"] = t;
      info.tagKind = kind;
    }
  }
  common(g, f, env);
  return { f, info };
}

function params(g: G, names: Names, env: Env, n: number): Obj[] {
  const out: Obj[] = [];
  for (let i = 0; i < n; i++) {
    const unit = pick(g, ["mm", "mm", "deg", "ratio", "count", "bool"] as const);
    const name = names.next(g, pick(g, ["w", "h", "t", "n", "a", "k"]));
    const p: Obj = { name, unit };
    const ft: FT = unit === "mm" ? "length" : unit === "deg" ? "angle" : unit;
    if (unit === "bool") p["value"] = chance(g, 0.7) ? chance(g, 0.5) : (() => {
      const e = genExpr(g, "bool", env);
      return e.k === "bool" ? e.v : printExpr(e);
    })();
    else {
      const literal = chance(g, 0.6);
      if (literal) {
        const v = unit === "count" ? int(g, 1, 10) : num(g, 1, 100);
        p["value"] = v;
        if (chance(g, 0.3)) p["min"] = unit === "count" ? int(g, 0, v) : num(g, 0, v);
        if (chance(g, 0.3)) p["max"] = unit === "count" ? v + int(g, 0, 5) : v + num(g, 0, 50);
      } else {
        const s = scalarOf(genExpr(g, ft, env));
        p["value"] = s.kind === "num" ? (unit === "count" ? int(g, 1, 10) : s.value) : s.text;
        if (s.kind === "expr" && chance(g, 0.2)) p["min"] = scalar(g, ft, env, 0, 1);
      }
    }
    if (chance(g, 0.15)) p["note"] = "a note";
    out.push(p);
    env[ft].push(name);
  }
  return out;
}

const FEATURE_WEIGHTS: [string, number][] = [
  ["sketch", 4],
  ["extrude", 4],
  ["revolve", 2],
  ["boolean", 1],
  ["hole", 2],
  ["fillet", 2],
  ["chamfer", 1],
  ["shell", 1],
  ["draft", 1],
  ["pattern", 2],
  ["datum_plane", 1],
  ["datum_axis", 1],
  ["tag", 2],
];

/** A valid IR v1 document. */
export function genValidDoc(g: G): v1.IrDocument {
  const names = new Names();
  const docEnv = emptyEnv();
  const doc: Obj = { schema: "aicad.ir/1" };
  if (chance(g, 0.4)) doc["meta"] = chance(g, 0.5) ? { name: "random" } : { name: "random", description: "a “doc” with\nnewlines" };
  const dp = params(g, names, docEnv, int(g, 0, 3));
  if (dp.length > 0) doc["params"] = dp;
  const partCount = int(g, 1, 2);
  const parts: Obj[] = [];
  let fid = 0;
  for (let pi = 0; pi < partCount; pi++) {
    const env = cloneEnv(docEnv);
    const pp = params(g, names, env, int(g, 0, 2));
    const st = new PartState(env);
    const features: Obj[] = [];
    const n = int(g, 1, 9);
    for (let i = 0; i < n; i++) {
      const total = FEATURE_WEIGHTS.reduce((s, [, w]) => s + w, 0);
      let roll = int(g, 0, total - 1);
      let type = "sketch";
      for (const [t, w] of FEATURE_WEIGHTS) {
        if (roll < w) {
          type = t;
          break;
        }
        roll -= w;
      }
      const id = `f${fid++}`;
      const r = feature(g, st, type, id, names.next(g));
      if (!r) continue;
      features.push(r.f);
      st.features.push(r.info);
    }
    const part: Obj = { id: `p${pi}`, name: names.next(g, "part") };
    if (pp.length > 0) part["params"] = pp;
    part["features"] = features;
    parts.push(part);
  }
  doc["parts"] = parts;
  return doc as unknown as v1.IrDocument;
}

/**
 * Break a valid document in ways that stay printable: arbitrary cards, a query source pointing at
 * a feature of the wrong type, option conflicts, wrong-kind refs. The result is usually invalid.
 */
export function mutate(g: G, doc: v1.IrDocument): v1.IrDocument {
  const d = structuredClone(doc) as unknown as Obj;
  const parts = d["parts"] as Obj[];
  const allFeatures = parts.flatMap((p) => p["features"] as Obj[]);
  const refs: Obj[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Obj;
      if ("kind" in o && "q" in o) refs.push(o);
      for (const [k, x] of Object.entries(o)) if (k !== "capture") walk(x);
    }
  };
  walk(d);
  // Query sources (not `tagged`: its kind comes from the tag) with the features declared before
  // their owner (so the printed handle is declared above its use).
  const qs: { q: Obj; earlier: string[] }[] = [];
  allFeatures.forEach((f, i) => {
    const earlier = allFeatures.slice(0, i).filter((x) => x["type"] !== "tag").map((x) => String(x["id"]));
    const walkQ = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walkQ);
      else if (v && typeof v === "object") {
        const o = v as Obj;
        if ("op" in o && "feature" in o && o["op"] !== "tagged") qs.push({ q: o, earlier });
        for (const [k, x] of Object.entries(o)) if (k !== "capture") walkQ(x);
      }
    };
    walkQ(f);
  });
  const n = int(g, 1, 3);
  for (let i = 0; i < n; i++) {
    switch (int(g, 0, 5)) {
      case 0:
        if (refs.length > 0) pick(g, refs)["card"] = pick(g, ["one", "some", "any", 1, 7]);
        break;
      case 1:
      case 2: {
        const withEarlier = qs.filter((x) => x.earlier.length > 0);
        if (withEarlier.length > 0) {
          const x = pick(g, withEarlier);
          x.q["feature"] = pick(g, x.earlier);
        }
        break;
      }
      case 3: {
        const feats = allFeatures;
        const hole = feats.find((f) => f["type"] === "hole");
        if (hole) {
          hole["cbore"] = "iso4762";
          hole["csink"] = { d: 9 };
        }
        break;
      }
      case 4: {
        const feats = parts.flatMap((p) => p["features"] as Obj[]);
        const dp = feats.find((f) => f["type"] === "datum_plane" || f["type"] === "datum_axis");
        if (dp) dp["mode"] = dp["type"] === "datum_plane" ? pick(g, ["offset", "angle", "midplane", "through", "frame"]) : pick(g, ["edge", "cylinder", "planes", "points"]);
        break;
      }
      default: {
        const feats = parts.flatMap((p) => p["features"] as Obj[]);
        const ex = feats.find((f) => f["type"] === "extrude");
        if (ex) {
          ex["op"] = "join";
          delete ex["targets"];
        }
      }
    }
  }
  return d as unknown as v1.IrDocument;
}
