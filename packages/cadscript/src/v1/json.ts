/**
 * Canonical JSON text of IR v1 documents (SPEC-v1 §0.4 [D-3], [W0-11]): byte for byte what
 * `forge_ir::v1::to_json` prints.
 *
 * - Object keys in the Rust struct declaration order (the order serde serializes), which is not
 *   the (alphabetical) order of the JSON Schema file; the tables below mirror
 *   `forge_ir::v1::{features, sketch, planes, refs, params}` and are checked against every
 *   canonical fixture in `corpus/v1` by the tests.
 * - Every stated default omitted, including a Ref's `card` equal to its field's default (§5.5).
 * - serde_json's pretty printer (2-space indent, `": "`), numbers as zmij/Ryū prints f64:
 *   decimal for `1e-5 ≤ |x| < 1e16` with integral values ending in `.0`, otherwise
 *   `<digits>e<sign><exp>` with an explicit `+` (`1e-7`, `1.5e+16`); `u32` fields (`v`, an
 *   integer `card`, instance indices, `skip` entries, `neighbors`) as integers.
 *
 * Expression strings are printed as stored (canonicalizing them is the writer's job, §2.4).
 */
import type { v1 } from "@aicad/ir-types";

type J = null | boolean | number | bigint | string | J[] | { [k: string]: J };
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: Obj, k: string): boolean => isObj(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/**
 * The deepest nesting of arrays and objects forge-ir reads from IR JSON text: its first pass is
 * serde_json's `Value` parse, whose recursion limit (128) rejects the 128th nested container
 * (the strict v1 reader alone would accept values 128 deep). IR v1 itself does not bound query
 * nesting, so a document deeper than this exists only in memory: it has no loadable text.
 */
export const MAX_JSON_NESTING = 127;

/**
 * How deep arrays and objects nest in `v` (a scalar is 0, `{}` is 1), and the JSON pointer of one
 * deepest container (the first in document order). Iterative: any input depth, no recursion.
 */
export function jsonNesting(v: unknown): { depth: number; path: string } {
  let best = { depth: 0, path: "" };
  const stack: { v: unknown; depth: number; path: string }[] = [{ v, depth: 0, path: "" }];
  while (stack.length > 0) {
    const top = stack.pop()!;
    if (typeof top.v !== "object" || top.v === null) continue;
    const depth = top.depth + 1;
    if (depth > best.depth) best = { depth, path: top.path };
    const entries: [string, unknown][] = Array.isArray(top.v) ? top.v.map((x, i) => [String(i), x]) : Object.entries(top.v as Obj);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [k, x] = entries[i]!;
      if (typeof x === "object" && x !== null) stack.push({ v: x, depth, path: `${top.path}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}` });
    }
  }
  return best;
}

/** A JSON number exactly as zmij (serde_json ≥ 1.0.141) prints an `f64`. */
export function formatF64(x: number): string {
  if (!Number.isFinite(x)) throw new RangeError(`non-finite number ${x} has no JSON form`);
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const sign = x < 0 ? "-" : "";
  // Shortest round-trip digits (ECMAScript picks the closest shortest, as Ryū does).
  const [mant, expText] = Math.abs(x).toExponential().split("e") as [string, string];
  const digits = mant.replace(".", "");
  const length = digits.length;
  const kk = Number(expText) + 1; // 10^(kk-1) <= |x| < 10^kk
  const k = kk - length;
  if (k >= 0 && kk <= 16) return `${sign}${digits}${"0".repeat(k)}.0`;
  if (kk > 0 && kk <= 16) return `${sign}${digits.slice(0, kk)}.${digits.slice(kk)}`;
  if (kk > -5 && kk <= 0) return `${sign}0.${"0".repeat(-kk)}${digits}`;
  const e = kk - 1;
  const exp = `e${e < 0 ? "-" : "+"}${Math.abs(e)}`;
  return length === 1 ? `${sign}${digits}${exp}` : `${sign}${digits[0]}.${digits.slice(1)}${exp}`;
}

/** serde_json's pretty printer over the canonical tree. */
function pretty(v: J, indent: string): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return formatF64(v);
  if (typeof v === "string") return JSON.stringify(v);
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => inner + pretty(x, inner)).join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(v);
  if (keys.length === 0) return "{}";
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${pretty(v[k]!, inner)}`).join(",\n")}\n${indent}}`;
}

// ─── Canonical tree builders ─────────────────────────────────────────────────────────────────

type Card = "one" | "some" | "any";

function scalar(v: unknown): J {
  return v as J; // number (f64) or string
}
function scalars(v: unknown): J {
  return Array.isArray(v) ? v.map(scalar) : ((v ?? null) as J);
}

// The builders are total: a malformed value (not what the typed parse accepts) is passed through
// unchanged instead of throwing, so that compile({ base }) and print() report it instead of crashing.

/** A `u32` field (printed as an integer); any other value unchanged. */
function u32(v: unknown): J {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4294967295 ? BigInt(v) : (v as J);
}
/** `f` over an array; any other value unchanged. */
function each(v: unknown, f: (x: unknown) => J): J {
  return Array.isArray(v) ? Array.from(v, f) : ((v ?? null) as J);
}
/** Rust `Scalar::is_literal`: a literal equal to `x` (`-0 == 0`), for default omission. */
function isLiteral(v: unknown, x: number): boolean {
  return typeof v === "number" && v === x;
}

function refJ(r: Obj, dflt: Card): J {
  if (!isObj(r)) return (r ?? null) as J;
  const out: Obj = { kind: r["kind"], q: query(r["q"] as Obj) };
  if (has(r, "card") && r["card"] !== dflt) out["card"] = typeof r["card"] === "number" ? u32(r["card"]) : (r["card"] as J);
  if (has(r, "capture")) out["capture"] = capture(r["capture"] as Obj);
  return out as J;
}

function capture(c: Obj): J {
  if (!isObj(c) || !Array.isArray(c["members"])) return (c ?? null) as J;
  return {
    members: (c["members"] as unknown[]).map((m) => {
      if (!isObj(m)) return (m ?? null) as J;
      const o: Obj = { key: m["key"], via: m["via"] };
      if (has(m, "faces")) o["faces"] = m["faces"];
      const g = m["geom"];
      if (!isObj(g)) {
        if (g !== undefined) o["geom"] = g;
        return o as J;
      }
      o["geom"] = {
        type: g["type"],
        carrier: carrier(g["carrier"]),
        bbox: g["bbox"],
        size: g["size"],
        centroid: g["centroid"],
        local: g["local"],
        body_center: g["body_center"],
        neighbors: u32(g["neighbors"]),
      };
      return o as J;
    }),
  };
}

const CARRIER_KEYS: Record<string, string[]> = {
  plane: ["normal", "offset"],
  cylinder: ["axis", "point", "radius"],
  cone: ["axis", "apex", "half_angle"],
  sphere: ["center", "radius"],
  torus: ["axis", "center", "major", "minor"],
  line: ["direction", "point"],
  circle: ["normal", "center", "radius"],
};

function carrier(c: unknown): J {
  if (!isObj(c)) return (c ?? null) as J;
  const entry = Object.entries(c)[0];
  if (!entry || !isObj(entry[1])) return c as J;
  const [tag, body] = entry as [string, Obj];
  return { [tag]: pick(body, CARRIER_KEYS[tag] ?? Object.keys(body)) } as J;
}

function pick(o: Obj, keys: readonly string[]): J {
  if (!isObj(o)) return (o ?? null) as J;
  const out: Obj = {};
  for (const k of keys) if (has(o, k)) out[k] = o[k];
  return out as J;
}

function query(q: Obj): J {
  if (!isObj(q)) return (q ?? null) as J;
  const op = q["op"] as string;
  const out: Obj = { op };
  const put = (k: string, f: (v: unknown) => J = (v) => v as J): void => {
    if (has(q, k)) out[k] = f(q[k]);
  };
  switch (op) {
    case "body":
    case "sides":
      put("feature");
      put("member");
      break;
    case "bodies":
      break;
    case "cap":
    case "endcap":
      put("feature");
      put("end");
      put("member");
      break;
    case "side":
      put("feature");
      put("curve");
      break;
    case "edge_at":
      put("feature");
      put("curve");
      put("end");
      break;
    case "between":
    case "minus":
      put("a", (v) => query(v as Obj));
      put("b", (v) => query(v as Obj));
      break;
    case "hole_face":
      put("feature");
      put("at");
      put("part");
      break;
    case "created":
      put("feature");
      put("role");
      break;
    case "instance":
      put("feature");
      put("index", (v) => each(v, u32));
      break;
    case "tagged":
      put("feature");
      break;
    case "union":
    case "intersect":
      put("of", (v) => each(v, (x) => query(x as Obj)));
      break;
    case "filter":
      put("of", (v) => query(v as Obj));
      put("where", (v) => predicate(v as Obj));
      break;
    case "extreme":
      put("of", (v) => query(v as Obj));
      put("dir", dir);
      put("which");
      break;
    default:
      // faces, edges, vertices, owner, largest, smallest
      put("of", (v) => query(v as Obj));
      break;
  }
  return out as J;
}

function predicate(p: Obj): J {
  if (!isObj(p) || Object.keys(p).length === 0) return (p ?? null) as J;
  const [k, v] = Object.entries(p)[0]!;
  if (k === "normal" || k === "parallel" || k === "perpendicular") return { [k]: dir(v) } as J;
  if (k === "radius") return { radius: pick(v as Obj, ["eq", "min", "max"]) } as J;
  return { [k]: v } as J;
}

function dir(d: unknown): J {
  if (typeof d === "string") return d;
  if (Array.isArray(d)) return scalars(d);
  return axisObject(d as Obj);
}

function axisObject(o: Obj): J {
  if (!isObj(o)) return (o ?? null) as J;
  const out: Obj = {};
  if (has(o, "edge")) out["edge"] = refJ(o["edge"] as Obj, "one");
  else if (has(o, "cylinder")) out["cylinder"] = refJ(o["cylinder"] as Obj, "one");
  else if (has(o, "datum")) out["datum"] = o["datum"];
  else if (has(o, "line")) {
    const l = o["line"] as Obj;
    out["line"] = { origin: scalars(l["origin"]), direction: scalars(l["direction"]) };
  }
  if (has(o, "flip") && o["flip"] !== false) out["flip"] = o["flip"];
  return out as J;
}

function axisRef(a: unknown): J {
  return typeof a === "string" ? a : axisObject(a as Obj);
}

function plane(p: unknown): J {
  if (typeof p === "string") return p;
  if (!isObj(p)) return (p ?? null) as J;
  const o = p as Obj;
  if (has(o, "face")) {
    const out: Obj = { face: refJ(o["face"] as Obj, "one") };
    if (has(o, "origin")) out["origin"] = scalars(o["origin"]);
    if (has(o, "x_dir")) out["x_dir"] = scalars(o["x_dir"]);
    return out as J;
  }
  if (has(o, "datum")) return { datum: o["datum"] } as J;
  return { origin: scalars(o["origin"]), normal: scalars(o["normal"]), x_dir: scalars(o["x_dir"]) };
}

function pointRef(p: unknown): J {
  if (Array.isArray(p)) return scalars(p);
  if (!isObj(p)) return (p ?? null) as J;
  return { vertex: refJ((p as Obj)["vertex"] as Obj, "one") } as J;
}

function targets(t: unknown): J {
  return t === "all" ? "all" : refJ(t as Obj, "some");
}

const CURVE_KEYS: Record<string, string[]> = {
  line: ["kind", "id", "start", "end", "construction"],
  arc: ["kind", "id", "start", "end", "center", "ccw", "construction"],
  circle: ["kind", "id", "center", "radius", "construction"],
  point: ["kind", "id", "at", "construction"],
  rect: ["kind", "id", "center", "corner", "w", "h", "r", "construction"],
  slot: ["kind", "id", "a", "b", "w", "construction"],
  polygon: ["kind", "id", "center", "n", "circumradius", "inradius", "across_flats", "side", "rotation", "construction"],
};

function curve(c: Obj): J {
  if (!isObj(c)) return (c ?? null) as J;
  const out: Obj = {};
  for (const k of CURVE_KEYS[c["kind"] as string] ?? Object.keys(c)) {
    if (!has(c, k)) continue;
    const v = c[k];
    if (k === "construction" && v === false) continue;
    if ((k === "r" || k === "rotation") && isLiteral(v, 0)) continue;
    out[k] = v;
  }
  return out as J;
}

const CONSTRAINT_KEYS: Record<string, string[]> = {
  coincident: ["a", "b"],
  horizontal: ["line"],
  vertical: ["line"],
  parallel: ["a", "b"],
  perpendicular: ["a", "b"],
  tangent: ["a", "b", "internal"],
  equal: ["a", "b"],
  distance: ["a", "b", "value", "driving"],
  angle: ["a", "b", "value", "driving"],
  radius: ["curve", "value", "driving"],
  diameter: ["curve", "value", "driving"],
  point_on_line: ["point", "line"],
  point_on_circle: ["point", "curve"],
  midpoint: ["point", "line"],
  symmetric: ["a", "b", "line"],
  fix: ["entity", "x", "y"],
};

function constraint(c: Obj): J {
  if (!isObj(c)) return (c ?? null) as J;
  const out: Obj = { type: c["type"], id: c["id"] };
  for (const k of CONSTRAINT_KEYS[c["type"] as string] ?? []) {
    if (!has(c, k)) continue;
    if (k === "driving" && c[k] === true) continue;
    out[k] = c[k];
  }
  return out as J;
}

function placement(at: Obj): J {
  if (!isObj(at)) return (at ?? null) as J;
  if (has(at, "points")) {
    const p = at["points"];
    return (isObj(p) ? { points: { sketch: p["sketch"], ids: p["ids"] } } : at) as J;
  }
  if (has(at, "list")) return { list: each(at["list"], (p) => (isObj(p) ? { id: p["id"], at: p["at"] } : p) as J) } as J;
  if (has(at, "grid")) {
    const g = at["grid"];
    if (!isObj(g)) return at as J;
    const out: Obj = { nx: g["nx"], ny: g["ny"], dx: g["dx"], dy: g["dy"] };
    if (has(g, "center") && !zero2(g["center"])) out["center"] = g["center"];
    return { grid: out } as J;
  }
  const c = at["circle"] as Obj;
  if (!isObj(c)) return at as J;
  const out: Obj = { n: c["n"], d: c["d"] };
  if (has(c, "center") && !zero2(c["center"])) out["center"] = c["center"];
  if (has(c, "start") && !isLiteral(c["start"], 0)) out["start"] = c["start"];
  return { circle: out } as J;
}

function zero2(p: unknown): boolean {
  return Array.isArray(p) && isLiteral(p[0], 0) && isLiteral(p[1], 0);
}

function layout(l: Obj): J {
  if (!isObj(l)) return (l ?? null) as J;
  if (has(l, "linear")) {
    const x = l["linear"];
    if (!isObj(x)) return l as J;
    const out: Obj = { dir: dir(x["dir"]), count: x["count"], spacing: x["spacing"] };
    if (has(x, "dir2")) out["dir2"] = dir(x["dir2"]);
    if (has(x, "count2") && !isLiteral(x["count2"], 1)) out["count2"] = x["count2"];
    if (has(x, "spacing2")) out["spacing2"] = x["spacing2"];
    return { linear: out } as J;
  }
  if (has(l, "circular")) {
    const x = l["circular"];
    if (!isObj(x)) return l as J;
    const out: Obj = { axis: axisRef(x["axis"]), count: x["count"] };
    if (has(x, "angle") && !isLiteral(x["angle"], 360)) out["angle"] = x["angle"];
    return { circular: out } as J;
  }
  if (!isObj(l["mirror"])) return l as J;
  return { mirror: { plane: plane((l["mirror"] as Obj)["plane"]) } } as J;
}

const METADATA = ["note", "intent", "author", "assumptions", "decision_ids"] as const;

function feature(f: Obj): J {
  if (!isObj(f)) return (f ?? null) as J;
  const out: Obj = { type: f["type"], id: f["id"], name: f["name"] };
  if (has(f, "v") && f["v"] !== 1) out["v"] = u32(f["v"]);
  if (has(f, "suppressed") && f["suppressed"] !== false) out["suppressed"] = f["suppressed"];
  const put = (k: string, conv: (v: unknown) => J = (v) => v as J, skip?: (v: unknown) => boolean): void => {
    if (has(f, k) && !(skip && skip(f[k]))) out[k] = conv(f[k]);
  };
  const eq = (d: unknown) => (v: unknown) => v === d;
  switch (f["type"]) {
    case "sketch":
      put("plane", plane);
      put("curves", (v) => each(v, (c) => curve(c as Obj)));
      put("constraints", (v) => each(v, (c) => constraint(c as Obj)), (v) => Array.isArray(v) && v.length === 0);
      break;
    case "extrude":
    case "revolve":
      put("sketch");
      put("regions", (v) => v as J, eq("all"));
      if (f["type"] === "extrude") put("distance");
      else {
        put("axis", (v) => (isObj(v) ? { origin: v["origin"], direction: v["direction"] } : v) as J);
        put("angle");
      }
      put("direction", (v) => v as J, eq("normal"));
      put("op", (v) => v as J, eq("new_body"));
      put("targets", targets);
      break;
    case "boolean":
      put("op");
      put("targets", (v) => refJ(v as Obj, "some"));
      put("tools", (v) => refJ(v as Obj, "some"));
      put("keep_tools", (v) => v as J, eq(false));
      break;
    case "hole":
      put("on", plane);
      put("flip", (v) => v as J, eq(false));
      put("at", (v) => placement(v as Obj));
      put("size");
      put("fit", (v) => v as J, eq("normal"));
      put("d");
      put("depth", (v) => (typeof v === "string" ? v : has(v as Obj, "up_to") ? ({ up_to: refJ((v as Obj)["up_to"] as Obj, "one") } as J) : (v as J)));
      put("tip", (v) => v as J, (v) => isLiteral(v, 118));
      put("cbore", (v) => (typeof v === "string" ? v : pick(v as Obj, ["d", "depth"])));
      put("csink", (v) => {
        if (typeof v === "string" || !isObj(v)) return (v ?? null) as J;
        const o = v;
        const r: Obj = { d: o["d"] };
        if (has(o, "angle") && !isLiteral(o["angle"], 90)) r["angle"] = o["angle"];
        return r as J;
      });
      put("insert", (v) => (typeof v === "string" ? v : pick(v as Obj, ["d", "depth"])));
      put("thread", (v) => (typeof v === "boolean" ? v : pick(v as Obj, ["pitch", "depth"])), eq(false));
      put("targets", targets);
      break;
    case "fillet":
      put("edges", (v) => refJ(v as Obj, "some"));
      put("r");
      put("tangent_chain", (v) => v as J, eq(true));
      break;
    case "chamfer":
      put("edges", (v) => refJ(v as Obj, "some"));
      put("d");
      put("d2");
      put("angle");
      put("side", (v) => refJ(v as Obj, "one"));
      put("tangent_chain", (v) => v as J, eq(true));
      break;
    case "shell":
      put("body", (v) => refJ(v as Obj, "one"));
      put("open", (v) => refJ(v as Obj, "any"));
      put("thickness");
      put("direction", (v) => v as J, eq("inward"));
      break;
    case "draft":
      put("faces", (v) => refJ(v as Obj, "some"));
      put("neutral", plane);
      put("angle");
      put("pull", (v) => v as J, eq("normal"));
      break;
    case "pattern":
      put("seed", (v) => {
        if (!isObj(v)) return (v ?? null) as J;
        return has(v, "features") ? ({ features: v["features"] } as J) : ({ bodies: refJ(v["bodies"] as Obj, "some") } as J);
      });
      put("layout", (v) => layout(v as Obj));
      put("skip", (v) => each(v, (ix) => each(ix, u32)), (v) => Array.isArray(v) && v.length === 0);
      put("op", (v) => v as J, eq("new_body"));
      put("targets", targets);
      break;
    case "datum_plane":
      put("mode");
      put("from", plane);
      put("distance");
      put("axis", axisRef);
      put("angle");
      put("a", plane);
      put("b", plane);
      put("points", (v) => each(v, pointRef));
      put("origin", scalars);
      put("normal", scalars);
      put("x_dir", scalars);
      break;
    case "datum_axis":
      put("mode");
      put("edge", (v) => refJ(v as Obj, "one"));
      put("face", (v) => refJ(v as Obj, "one"));
      put("a", plane);
      put("b", plane);
      put("points", (v) => each(v, pointRef));
      put("flip", (v) => v as J, eq(false));
      break;
    case "tag":
      put("target", (v) => refJ(v as Obj, "some"));
      break;
    default:
      break;
  }
  for (const k of METADATA) {
    const v = f[k];
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as J;
}

function param(p: Obj): J {
  if (!isObj(p)) return (p ?? null) as J;
  const out: Obj = { name: p["name"], unit: p["unit"], value: p["value"] };
  if (has(p, "min")) out["min"] = p["min"];
  if (has(p, "max")) out["max"] = p["max"];
  if (has(p, "note") && p["note"] !== "") out["note"] = p["note"];
  return out as J;
}

/** The canonical tree of a document (defaults omitted, keys in serialization order). */
export function canonicalTree(doc: v1.IrDocument): J {
  if (!isObj(doc)) return (doc ?? null) as unknown as J;
  const d = doc as unknown as Obj;
  const out: Obj = { schema: d["schema"] };
  const meta = d["meta"] as Obj | undefined;
  if (meta && ((meta["name"] ?? "") !== "" || (meta["description"] ?? "") !== "")) {
    const m: Obj = {};
    if ((meta["name"] ?? "") !== "") m["name"] = meta["name"];
    if ((meta["description"] ?? "") !== "") m["description"] = meta["description"];
    out["meta"] = m;
  }
  const units = d["units"] as Obj | undefined;
  if (units && (units["length"] !== "mm" || units["angle"] !== "deg")) out["units"] = { length: units["length"], angle: units["angle"] };
  const params = d["params"];
  if (params !== undefined && !(Array.isArray(params) && params.length === 0)) out["params"] = each(params, (p) => param(p as Obj));
  out["parts"] = each(d["parts"], (p) => {
    if (!isObj(p)) return (p ?? null) as J;
    const po: Obj = { id: p["id"], name: p["name"] };
    const pp = p["params"];
    if (pp !== undefined && !(Array.isArray(pp) && pp.length === 0)) po["params"] = each(pp, (x) => param(x as Obj));
    po["features"] = each(p["features"], (f) => feature(f as Obj));
    return po as J;
  });
  return out as J;
}

/**
 * The plain value of a canonical tree: `u32` fields as numbers, `undefined` members dropped (as
 * `JSON.stringify` would), and the sign of zero kept (`JSON.stringify` loses it: -0.0 is a
 * valid f64 literal of the IR, printed `-0.0` by {@link toJson}).
 */
function plain(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return Array.from(v, (x) => (x === undefined ? null : plain(x))); // (holes too, as JSON)
  if (isObj(v)) {
    const out: Obj = {};
    for (const k of Object.keys(v)) {
      if (v[k] === undefined) continue;
      Object.defineProperty(out, k, { value: plain(v[k]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/** A canonical JSON-compatible value (plain numbers, defaults omitted): what compile() emits. */
export function canonicalDocument(doc: v1.IrDocument): v1.IrDocument {
  return plain(canonicalTree(doc)) as v1.IrDocument;
}

/** `forge_ir::v1::to_json`: the canonical JSON text of a document (no trailing newline). */
export function toJson(doc: v1.IrDocument): string {
  return pretty(canonicalTree(doc), "");
}

export { isObj };
