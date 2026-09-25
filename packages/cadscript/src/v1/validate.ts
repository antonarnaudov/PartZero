/**
 * IR v1 validation — a TypeScript mirror of forge-ir's rejection pipeline (SPEC-v1 §0.5 rule 4,
 * [W0-1]): raw pre-checks (`precheck.rs`), the typed parse (zod, from `@aicad/ir-types`),
 * structural validation (`validate.rs`, every **R** code) and the expression checks that W1 owns
 * in Rust (syntax, names, scope, arity, units, types, parameter cycles), here backed by the TS
 * port in `expr.ts`.
 *
 * Codes and JSON-pointer paths are identical to Rust's (checked against every case of
 * `corpus/v1/conformance/invalid/documents.json` and `queries/typing.json`), so an error from the
 * engine and one from CadScript map to the same span. Details follow SPEC-v1 §7.5 and never echo
 * a string that fails the id or expression grammar ([W0-12]).
 */
import { parseIrDocument as parseV0Document, v1, type IrDocument as V0Document } from "@aicad/ir-types";
import { validateIr as validateV0 } from "../validate.js";
import {
  checkAtField,
  MAX_EXPR_BYTES,
  namesOf,
  parseExpr,
  unitField,
  type Expr,
  type FieldType,
  type NameInfo,
  type ParamUnit,
  type TypeEnv,
} from "./expr.js";
import { byteLength, checkId, checkRef, isRef, MAX_ID_LEN, shown } from "./ids.js";
import { migrateV0ToV1Report, type MigrationReport } from "./migrate.js";
import { isFloatToken, JsonTextError, parseIrJsonText } from "./v0json.js";
import { formatF64 } from "./json.js";

// ─── Errors and options ──────────────────────────────────────────────────────────────────────

/** A coded rejection (SPEC-v1 §0.5, §7.4): the same code and path as forge-ir. */
export interface V1ValidationError {
  code: string;
  path: string;
  message: string;
  details: Record<string, unknown>;
  /** For expression problems: the offending sub-expression (a node of the checked AST). */
  exprNode?: Expr;
  /**
   * QUERY_UNKNOWN_CURVE only: what the reference could have named (every profile curve of the
   * consumed sketch, or every point of a hole's sketch), for the compile diagnostic's hint. Not
   * part of forge-ir's `details` (SPEC-v1 §7.5 fixes those to feature, curve, similar).
   */
  candidates?: { what: string; ids: string[] };
}

export interface V1ValidateOptions {
  /**
   * Pre-parsed ASTs by expression path (CadScript passes the ASTs it lowered, so that problems
   * point at AST nodes it can map back to source spans). Text is still re-parsed for the limits.
   */
  exprAst?: (path: string) => Expr | undefined;
  /** Optional feature types the engine lacks (`UNSUPPORTED_FEATURE`, e.g. `["draft"]`). */
  unsupportedFeatures?: readonly string[];
  /** Run the expression checks (W1's hook). Default true. */
  expressions?: boolean;
  /**
   * Receives the static kind (§5.4) of every Ref's query, by the Ref's path (`undefined` when the
   * query has an error): for tests and tools that inspect typing.
   */
  onRefKind?: (path: string, kind: string | undefined) => void;
}

const LINEAR_TOLERANCE = v1.LINEAR_TOLERANCE;
const MAX_COUNT_MAGNITUDE = v1.MAX_COUNT_MAGNITUDE;
const RESERVED_ALL: ReadonlySet<string> = new Set(v1.RESERVED_NAMES);
const RESERVED_V0: ReadonlySet<string> = new Set(v1.RESERVED_NAMES_V0);
const FEATURE_TYPES: readonly string[] = v1.FEATURE_TYPES;
const HOLE_SIZE_NAMES: readonly string[] = Object.keys(v1.HOLE_SIZES.sizes);
const PARAM_UNITS: readonly string[] = v1.PARAM_UNITS;
const CONSTRAINT_TYPES: readonly string[] = v1.CONSTRAINT_TYPES;
const DIMENSION_TYPES: readonly string[] = v1.DIMENSION_TYPES;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: unknown, k: string): boolean => isObj(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const lit = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
const tolText = `> ${fmt(LINEAR_TOLERANCE)}`;

/** Rust `{}` formatting of an f64, closely enough for messages. */
function fmt(x: number): string {
  if (Number.isInteger(x) && Math.abs(x) < 1e16) return String(x);
  return String(x);
}

function isCount(v: number): boolean {
  return Number.isFinite(v) && Number.isInteger(v) && Math.abs(v) <= MAX_COUNT_MAGNITUDE;
}

// ─── Raw pre-checks (precheck.rs) ────────────────────────────────────────────────────────────

/** JSON-pointer escaping of one path segment. */
function escapeSeg(k: string): string {
  return k.replace(/~/g, "~0").replace(/\//g, "~1");
}

function findNull(v: unknown, path: string): string | undefined {
  if (v === null) return path === "" ? "/" : path;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const p = findNull(v[i], `${path}/${i}`);
      if (p) return p;
    }
    return undefined;
  }
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      const p = findNull(x, `${path}/${escapeSeg(k)}`);
      if (p) return p;
    }
  }
  return undefined;
}

/** A raw JSON value as messages may show it ([W0-12]). */
/** {@link shownValue} of `o[k]`, a float token as forge-ir shows an `f64` (`1.0`). */
function shownToken(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) && isFloatToken(o, k) ? formatF64(v) : shownValue(v);
}

/**
 * The first `u32` field (document order) that holds a number forge-ir reads as an `f64`
 * ({@link isFloatToken}): an instance index, a pattern's `skip` entry, a capture's `neighbors`.
 * serde's typed parse rejects it ("invalid type: floating point"), so `loadIrDocument` does too.
 * (`v` and `card` are the raw pre-checks' codes.) Only values read from v1 text carry the marks.
 */
function floatInU32Field(raw: unknown): { path: string; value: number } | undefined {
  const stack: { v: unknown; path: string; key: string }[] = [{ v: raw, path: "", key: "" }];
  while (stack.length > 0) {
    const { v, path, key } = stack.pop()!;
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push({ v: v[i], path: `${path}/${i}`, key: String(i) });
      continue;
    }
    if (!isObj(v)) continue;
    const idx = (arr: unknown, at: string): { path: string; value: number } | undefined => {
      if (!Array.isArray(arr)) return undefined;
      const k = arr.findIndex((_, i) => isFloatToken(arr, i));
      return k < 0 ? undefined : { path: `${at}/${k}`, value: arr[k] as number };
    };
    if (v["op"] === "instance") {
      const hit = idx(v["index"], `${path}/index`);
      if (hit) return hit;
    }
    if (v["type"] === "pattern" && Array.isArray(v["skip"])) {
      for (let i = 0; i < v["skip"].length; i++) {
        const hit = idx(v["skip"][i], `${path}/skip/${i}`);
        if (hit) return hit;
      }
    }
    if (key === "geom" && isFloatToken(v, "neighbors")) return { path: `${path}/neighbors`, value: v["neighbors"] as number };
    const entries = Object.entries(v);
    for (let i = entries.length - 1; i >= 0; i--) stack.push({ v: entries[i]![1], path: `${path}/${escapeSeg(entries[i]![0])}`, key: entries[i]![0] });
  }
  return undefined;
}

function shownValue(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean" || v === null || v === undefined) return String(v ?? null);
  if (typeof v === "string" && isRef(v)) return JSON.stringify(v);
  return "<invalid value>";
}

export interface Precheck {
  /** A parse error (no code): a `null` anywhere. */
  parse?: { path: string; message: string };
  errors: V1ValidationError[];
}

/** The raw pre-checks of SPEC-v1 §0.5 rule 4 step 3, on the parsed JSON value. */
export function precheckV1(v: unknown): Precheck {
  const nul = findNull(v, "");
  if (nul !== undefined) return { parse: { path: nul, message: `null is not allowed at ${nul} (omit the field instead)` }, errors: [] };
  const errors: V1ValidationError[] = [];
  const err = (code: string, path: string, message: string, details: Obj): void => {
    errors.push({ code, path, message, details });
  };
  const param = (p: unknown, pp: string): void => {
    if (!isObj(p)) return;
    const name = shown(str(p["name"]));
    const invalid = (path: string, reason: string, message: string): void => err("PARAM_INVALID", path, message, { name, reason, allowed: PARAM_UNITS });
    if (!has(p, "unit")) invalid(pp, "bad-unit", "unit is required");
    else if (!(typeof p["unit"] === "string" && PARAM_UNITS.includes(p["unit"]))) {
      invalid(`${pp}/unit`, "bad-unit", `unit ${shownValue(p["unit"])} is not one of mm, deg, ratio, count, bool`);
    }
    if (has(p, "measure")) invalid(`${pp}/measure`, "measure-deferred", "measured parameters are deferred to IR v1.1 (ADR 0013 decision 5)");
    else if (!has(p, "value")) invalid(pp, "value-required", "value is required");
  };
  if (isObj(v)) {
    arr(v["params"]).forEach((p, i) => param(p, `/params/${i}`));
    arr(v["parts"]).forEach((part, pi) => {
      if (!isObj(part)) return;
      const pp = `/parts/${pi}`;
      arr(part["params"]).forEach((p, i) => param(p, `${pp}/params/${i}`));
      if (!Array.isArray(part["features"])) return;
      part["features"].forEach((f, fi) => {
        if (!isObj(f)) return;
        const fp = `${pp}/features/${fi}`;
        const ty = f["type"];
        if (!(typeof ty === "string" && FEATURE_TYPES.includes(ty))) {
          err("UNSUPPORTED_FEATURE", `${fp}/type`, `unknown feature type ${shownValue(ty)}`, { type: shownValue(ty), supported: FEATURE_TYPES });
          return;
        }
        if (has(f, "v")) {
          const vv = f["v"];
          // (`1.0` is an f64 for forge-ir: `as_u64()` is None, so it is no version.)
          if (!(typeof vv === "number" && Number.isInteger(vv) && vv === 1 && !isFloatToken(f, "v"))) {
            const shownV = shownToken(f, "v");
            err("UNSUPPORTED_FEATURE_VERSION", `${fp}/v`, `${ty} v${shownV} is not implemented (supported: [1])`, { type: ty, v: shownV, supported: [1] });
          }
        }
        if (ty === "hole" && has(f, "size") && !(typeof f["size"] === "string" && HOLE_SIZE_NAMES.includes(f["size"]))) {
          err("HOLE_SIZE_UNKNOWN", `${fp}/size`, `unknown hole size ${shownValue(f["size"])}; use one of ${HOLE_SIZE_NAMES.join(", ")}`, { field: "size", allowed: HOLE_SIZE_NAMES });
        }
        if (ty === "sketch") {
          arr(f["constraints"]).forEach((c, k) => {
            if (!isObj(c) || typeof c["type"] !== "string") return;
            const t = c["type"];
            if (!CONSTRAINT_TYPES.includes(t) || DIMENSION_TYPES.includes(t)) return;
            for (const key of ["driving", "value"]) {
              if (Object.prototype.hasOwnProperty.call(c, key)) {
                const id = shown(str(c["id"]));
                err("SKETCH_NOT_A_DIMENSION", `${fp}/constraints/${k}/${key}`, `\`${id}\`: only dimensions (distance, angle, radius, diameter) take ${key}`, { id });
              }
            }
          });
        }
      });
    });
  }
  refsCard(v, "", errors);
  return { errors };
}

function refsCard(v: unknown, path: string, errors: V1ValidationError[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => refsCard(x, `${path}/${i}`, errors));
    return;
  }
  if (!isObj(v)) return;
  if (has(v, "kind") && has(v, "q") && Object.prototype.hasOwnProperty.call(v, "card")) {
    const card = v["card"];
    const ok =
      typeof card === "string"
        ? ["one", "some", "any"].includes(card)
        : typeof card === "number" && Number.isInteger(card) && !isFloatToken(v, "card") && card >= 1 && card <= 4294967295;
    if (!ok) {
      errors.push({
        code: "INVALID_CARDINALITY",
        path: `${path}/card`,
        message: `card ${shownToken(v, "card")} is not one, some, any or an integer >= 1`,
        details: { field: path, allowed: ["one", "some", "any", ">= 1"] },
      });
    }
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === "capture") continue;
    refsCard(x, `${path}/${escapeSeg(k)}`, errors);
  }
}

// ─── Site walker (validate.rs `Walker`) ──────────────────────────────────────────────────────

export type ExprScope = { kind: "doc" } | { kind: "part"; index: number };
export type SiteOwner = { kind: "param"; part: number | undefined; name: string } | { kind: "feature"; part: number; index: number; id: string };

export interface ExprSite {
  path: string;
  text: string;
  field: FieldType;
  scope: ExprScope;
  owner: SiteOwner;
}

export interface LiteralSite {
  path: string;
  value: number;
  field: FieldType;
  owner: SiteOwner;
}

/** Every Scalar of a document with its path, field type, scope and owner (document order). */
export class Walker {
  readonly exprs: ExprSite[] = [];
  readonly literals: LiteralSite[] = [];
  private owner: SiteOwner = { kind: "param", part: undefined, name: "" };
  private scope: ExprScope = { kind: "doc" };

  private s(path: string, v: unknown, field: FieldType): void {
    if (typeof v === "number") this.literals.push({ path, value: v, field, owner: this.owner });
    else if (typeof v === "string") this.exprs.push({ path, text: v, field, scope: this.scope, owner: this.owner });
  }
  private b(path: string, v: unknown): void {
    if (typeof v === "string") this.exprs.push({ path, text: v, field: "bool", scope: this.scope, owner: this.owner });
  }
  private p2(path: string, v: unknown, field: FieldType): void {
    this.s(`${path}/0`, arr(v)[0], field);
    this.s(`${path}/1`, arr(v)[1], field);
  }
  private p3(path: string, v: unknown, field: FieldType): void {
    arr(v).forEach((x, i) => this.s(`${path}/${i}`, x, field));
  }
  private opt(path: string, o: unknown, k: string, field: FieldType): void {
    if (has(o, k)) this.s(path, (o as Obj)[k], field);
  }

  walkDocument(doc: Obj): this {
    arr(doc["params"]).forEach((p, i) => this.param(`/params/${i}`, p, undefined, { kind: "doc" }));
    arr(doc["parts"]).forEach((part, pi) => {
      if (!isObj(part)) return;
      arr(part["params"]).forEach((p, i) => this.param(`/parts/${pi}/params/${i}`, p, pi, { kind: "part", index: pi }));
      arr(part["features"]).forEach((f, fi) => this.walkFeature(pi, f, fi));
    });
    return this;
  }

  private param(pp: string, p: unknown, part: number | undefined, scope: ExprScope): void {
    if (!isObj(p)) return;
    this.owner = { kind: "param", part, name: str(p["name"]) };
    this.scope = scope;
    const unit = (PARAM_UNITS.includes(str(p["unit"])) ? p["unit"] : "mm") as ParamUnit;
    const ft = unitField(unit);
    const value = p["value"];
    if (typeof value === "number") this.literals.push({ path: `${pp}/value`, value, field: ft, owner: this.owner });
    else if (typeof value === "string") this.exprs.push({ path: `${pp}/value`, text: value, field: ft, scope, owner: this.owner });
    if (unit !== "bool") {
      this.opt(`${pp}/min`, p, "min", ft);
      this.opt(`${pp}/max`, p, "max", ft);
    }
  }

  walkFeature(pi: number, f: unknown, fi: number): void {
    if (!isObj(f)) return;
    const fp = `/parts/${pi}/features/${fi}`;
    this.owner = { kind: "feature", part: pi, index: fi, id: str(f["id"]) };
    this.scope = { kind: "part", index: pi };
    this.b(`${fp}/suppressed`, f["suppressed"]);
    switch (f["type"]) {
      case "sketch":
        this.plane(`${fp}/plane`, f["plane"]);
        arr(f["curves"]).forEach((c, ci) => this.curve(`${fp}/curves/${ci}`, c));
        arr(f["constraints"]).forEach((c, k) => {
          if (!isObj(c)) return;
          const kp = `${fp}/constraints/${k}`;
          switch (c["type"]) {
            case "distance":
            case "radius":
            case "diameter":
              this.opt(`${kp}/value`, c, "value", "length");
              break;
            case "angle":
              this.opt(`${kp}/value`, c, "value", "angle");
              break;
            case "fix":
              this.opt(`${kp}/x`, c, "x", "length");
              this.opt(`${kp}/y`, c, "y", "length");
              break;
            default:
              break;
          }
        });
        break;
      case "extrude":
        if (has(f, "distance")) this.s(`${fp}/distance`, f["distance"], "length");
        if (isObj(f["extent"]) && has(f["extent"], "up_to")) this.plane(`${fp}/extent/up_to`, (f["extent"] as Obj)["up_to"]);
        this.targets(`${fp}/targets`, f["targets"]);
        break;
      case "revolve": {
        const axis = isObj(f["axis"]) ? f["axis"] : {};
        this.p2(`${fp}/axis/origin`, axis["origin"], "length");
        this.p2(`${fp}/axis/direction`, axis["direction"], "ratio");
        this.s(`${fp}/angle`, f["angle"], "angle");
        this.targets(`${fp}/targets`, f["targets"]);
        break;
      }
      case "boolean":
        this.r(`${fp}/targets`, f["targets"]);
        this.r(`${fp}/tools`, f["tools"]);
        this.b(`${fp}/keep_tools`, f["keep_tools"]);
        break;
      case "transform":
        this.r(`${fp}/bodies`, f["bodies"]);
        if (has(f, "translate")) this.p3(`${fp}/translate`, f["translate"], "length");
        if (isObj(f["rotate"])) {
          this.axis(`${fp}/rotate/axis`, (f["rotate"] as Obj)["axis"]);
          this.s(`${fp}/rotate/angle`, (f["rotate"] as Obj)["angle"], "angle");
        }
        this.b(`${fp}/copy`, f["copy"]);
        break;
      case "hole": {
        this.plane(`${fp}/on`, f["on"]);
        this.b(`${fp}/flip`, f["flip"]);
        const at = f["at"];
        if (has(at, "list")) arr((at as Obj)["list"]).forEach((p, k) => this.p2(`${fp}/at/list/${k}/at`, isObj(p) ? p["at"] : undefined, "length"));
        else if (has(at, "grid")) {
          const g = (at as Obj)["grid"] as Obj;
          const gp = `${fp}/at/grid`;
          this.s(`${gp}/nx`, g["nx"], "count");
          this.s(`${gp}/ny`, g["ny"], "count");
          this.s(`${gp}/dx`, g["dx"], "length");
          this.s(`${gp}/dy`, g["dy"], "length");
          this.p2(`${gp}/center`, has(g, "center") ? g["center"] : [0, 0], "length");
        } else if (has(at, "circle")) {
          const c = (at as Obj)["circle"] as Obj;
          const cp = `${fp}/at/circle`;
          this.s(`${cp}/n`, c["n"], "count");
          this.s(`${cp}/d`, c["d"], "length");
          this.p2(`${cp}/center`, has(c, "center") ? c["center"] : [0, 0], "length");
          this.s(`${cp}/start`, has(c, "start") ? c["start"] : 0, "angle");
        }
        this.opt(`${fp}/d`, f, "d", "length");
        const depth = f["depth"];
        if (has(depth, "blind")) this.s(`${fp}/depth/blind`, (depth as Obj)["blind"], "length");
        else if (has(depth, "up_to")) this.r(`${fp}/depth/up_to`, (depth as Obj)["up_to"]);
        const tip = has(f, "tip") ? f["tip"] : 118;
        if (tip !== "flat") this.s(`${fp}/tip`, tip, "angle");
        if (isObj(f["cbore"])) {
          this.s(`${fp}/cbore/d`, f["cbore"]["d"], "length");
          this.s(`${fp}/cbore/depth`, f["cbore"]["depth"], "length");
        }
        if (isObj(f["csink"])) {
          this.s(`${fp}/csink/d`, f["csink"]["d"], "length");
          this.s(`${fp}/csink/angle`, has(f["csink"], "angle") ? f["csink"]["angle"] : 90, "angle");
        }
        if (isObj(f["insert"])) {
          this.s(`${fp}/insert/d`, f["insert"]["d"], "length");
          this.s(`${fp}/insert/depth`, f["insert"]["depth"], "length");
        }
        if (isObj(f["thread"])) {
          this.opt(`${fp}/thread/pitch`, f["thread"], "pitch", "length");
          this.opt(`${fp}/thread/depth`, f["thread"], "depth", "length");
        }
        this.targets(`${fp}/targets`, f["targets"]);
        break;
      }
      case "fillet":
        this.r(`${fp}/edges`, f["edges"]);
        this.s(`${fp}/r`, f["r"], "length");
        this.b(`${fp}/tangent_chain`, f["tangent_chain"]);
        break;
      case "chamfer":
        this.r(`${fp}/edges`, f["edges"]);
        this.s(`${fp}/d`, f["d"], "length");
        this.opt(`${fp}/d2`, f, "d2", "length");
        this.opt(`${fp}/angle`, f, "angle", "angle");
        if (has(f, "side")) this.r(`${fp}/side`, f["side"]);
        this.b(`${fp}/tangent_chain`, f["tangent_chain"]);
        break;
      case "shell":
        this.r(`${fp}/body`, f["body"]);
        if (has(f, "open")) this.r(`${fp}/open`, f["open"]);
        this.s(`${fp}/thickness`, f["thickness"], "length");
        break;
      case "draft":
        this.r(`${fp}/faces`, f["faces"]);
        this.plane(`${fp}/neutral`, f["neutral"]);
        this.s(`${fp}/angle`, f["angle"], "angle");
        break;
      case "pattern": {
        if (has(f["seed"], "bodies")) this.r(`${fp}/seed/bodies`, (f["seed"] as Obj)["bodies"]);
        const l = f["layout"];
        if (has(l, "linear")) {
          const x = (l as Obj)["linear"] as Obj;
          const lp = `${fp}/layout/linear`;
          this.dir(`${lp}/dir`, x["dir"]);
          this.s(`${lp}/count`, x["count"], "count");
          this.s(`${lp}/spacing`, x["spacing"], "length");
          if (has(x, "dir2")) this.dir(`${lp}/dir2`, x["dir2"]);
          this.opt(`${lp}/count2`, x, "count2", "count");
          this.opt(`${lp}/spacing2`, x, "spacing2", "length");
        } else if (has(l, "circular")) {
          const x = (l as Obj)["circular"] as Obj;
          const cp = `${fp}/layout/circular`;
          this.axis(`${cp}/axis`, x["axis"]);
          this.s(`${cp}/count`, x["count"], "count");
          this.s(`${cp}/angle`, has(x, "angle") ? x["angle"] : 360, "angle");
        } else if (has(l, "mirror")) {
          this.plane(`${fp}/layout/mirror/plane`, ((l as Obj)["mirror"] as Obj)["plane"]);
        }
        this.targets(`${fp}/targets`, f["targets"]);
        break;
      }
      case "datum_plane":
        if (has(f, "from")) this.plane(`${fp}/from`, f["from"]);
        this.opt(`${fp}/distance`, f, "distance", "length");
        if (has(f, "axis")) this.axis(`${fp}/axis`, f["axis"]);
        this.opt(`${fp}/angle`, f, "angle", "angle");
        if (has(f, "a")) this.plane(`${fp}/a`, f["a"]);
        if (has(f, "b")) this.plane(`${fp}/b`, f["b"]);
        arr(f["points"]).forEach((p, k) => this.point(`${fp}/points/${k}`, p));
        if (has(f, "origin")) this.p3(`${fp}/origin`, f["origin"], "length");
        if (has(f, "normal")) this.p3(`${fp}/normal`, f["normal"], "ratio");
        if (has(f, "x_dir")) this.p3(`${fp}/x_dir`, f["x_dir"], "ratio");
        break;
      case "datum_axis":
        if (has(f, "edge")) this.r(`${fp}/edge`, f["edge"]);
        if (has(f, "face")) this.r(`${fp}/face`, f["face"]);
        if (has(f, "a")) this.plane(`${fp}/a`, f["a"]);
        if (has(f, "b")) this.plane(`${fp}/b`, f["b"]);
        arr(f["points"]).forEach((p, k) => this.point(`${fp}/points/${k}`, p));
        this.b(`${fp}/flip`, f["flip"]);
        break;
      case "tag":
        this.r(`${fp}/target`, f["target"]);
        break;
      default:
        break;
    }
  }

  private curve(cp: string, c: unknown): void {
    if (!isObj(c)) return;
    switch (c["kind"]) {
      case "line":
        this.p2(`${cp}/start`, c["start"], "length");
        this.p2(`${cp}/end`, c["end"], "length");
        break;
      case "arc":
        this.p2(`${cp}/start`, c["start"], "length");
        this.p2(`${cp}/end`, c["end"], "length");
        this.p2(`${cp}/center`, c["center"], "length");
        break;
      case "circle":
        this.p2(`${cp}/center`, c["center"], "length");
        this.s(`${cp}/radius`, c["radius"], "length");
        break;
      case "point":
        this.p2(`${cp}/at`, c["at"], "length");
        break;
      case "rect":
        if (has(c, "center")) this.p2(`${cp}/center`, c["center"], "length");
        if (has(c, "corner")) this.p2(`${cp}/corner`, c["corner"], "length");
        this.s(`${cp}/w`, c["w"], "length");
        this.s(`${cp}/h`, c["h"], "length");
        this.s(`${cp}/r`, has(c, "r") ? c["r"] : 0, "length");
        break;
      case "slot":
        this.p2(`${cp}/a`, c["a"], "length");
        this.p2(`${cp}/b`, c["b"], "length");
        this.s(`${cp}/w`, c["w"], "length");
        break;
      case "polygon":
        this.p2(`${cp}/center`, c["center"], "length");
        this.s(`${cp}/n`, c["n"], "count");
        for (const k of ["circumradius", "inradius", "across_flats", "side"]) this.opt(`${cp}/${k}`, c, k, "length");
        this.s(`${cp}/rotation`, has(c, "rotation") ? c["rotation"] : 0, "angle");
        break;
      default:
        break;
    }
  }

  /** The Scalars of one curve (for SKETCH_MIXED_MODE). */
  curveSites(cp: string, c: unknown): ExprSite[] {
    const w = new Walker();
    w.owner = this.owner;
    w.scope = this.scope;
    w.curve(cp, c);
    return w.exprs;
  }

  private targets(path: string, t: unknown): void {
    if (isObj(t)) this.r(path, t);
  }
  private plane(path: string, p: unknown): void {
    if (!isObj(p)) return;
    if (has(p, "face")) {
      this.r(`${path}/face`, p["face"]);
      if (has(p, "origin")) this.p3(`${path}/origin`, p["origin"], "length");
      if (has(p, "x_dir")) this.p3(`${path}/x_dir`, p["x_dir"], "ratio");
    } else if (has(p, "datum")) {
      // no scalars
    } else {
      this.p3(`${path}/origin`, p["origin"], "length");
      this.p3(`${path}/normal`, p["normal"], "ratio");
      this.p3(`${path}/x_dir`, p["x_dir"], "ratio");
    }
  }
  private axis(path: string, a: unknown): void {
    if (isObj(a)) this.axisObject(path, a);
  }
  private axisObject(path: string, o: Obj): void {
    if (has(o, "edge")) this.r(`${path}/edge`, o["edge"]);
    else if (has(o, "cylinder")) this.r(`${path}/cylinder`, o["cylinder"]);
    else if (has(o, "line")) {
      const l = isObj(o["line"]) ? o["line"] : {};
      this.p3(`${path}/line/origin`, l["origin"], "length");
      this.p3(`${path}/line/direction`, l["direction"], "ratio");
    }
    this.b(`${path}/flip`, o["flip"]);
  }
  private point(path: string, p: unknown): void {
    if (Array.isArray(p)) this.p3(path, p, "length");
    else if (has(p, "vertex")) this.r(`${path}/vertex`, (p as Obj)["vertex"]);
  }
  private dir(path: string, d: unknown): void {
    if (Array.isArray(d)) this.p3(path, d, "ratio");
    else if (isObj(d)) this.axisObject(path, d);
  }
  private r(path: string, r: unknown): void {
    if (isObj(r)) this.q(`${path}/q`, r["q"]);
  }
  private q(path: string, q: unknown): void {
    if (!isObj(q)) return;
    switch (q["op"]) {
      case "between":
      case "minus":
        this.q(`${path}/a`, q["a"]);
        this.q(`${path}/b`, q["b"]);
        break;
      case "faces":
      case "edges":
      case "vertices":
      case "owner":
      case "largest":
      case "smallest":
        this.q(`${path}/of`, q["of"]);
        break;
      case "union":
      case "intersect":
        arr(q["of"]).forEach((sub, i) => this.q(`${path}/of/${i}`, sub));
        break;
      case "filter": {
        this.q(`${path}/of`, q["of"]);
        const wp = `${path}/where`;
        const pred = q["where"];
        if (!isObj(pred)) break;
        for (const k of ["normal", "parallel", "perpendicular"]) if (has(pred, k)) this.dir(`${wp}/${k}`, pred[k]);
        if (isObj(pred["radius"])) for (const k of ["eq", "min", "max"]) this.opt(`${wp}/radius/${k}`, pred["radius"], k, "length");
        break;
      }
      case "extreme":
        this.q(`${path}/of`, q["of"]);
        this.dir(`${path}/dir`, q["dir"]);
        break;
      default:
        break;
    }
  }
}

// ─── Structural validation (validate.rs) ─────────────────────────────────────────────────────

type CurveClass = "line" | "arc" | "circle";
type Ent = "point" | "line" | "circle" | "arc";

interface SketchInfo {
  profile: Map<string, CurveClass>;
  wildPolygons: string[];
  points: Set<string>;
}

function curveClass(info: SketchInfo, id: string): CurveClass | undefined {
  const c = info.profile.get(id);
  if (c) return c;
  for (const p of info.wildPolygons) {
    if (id.startsWith(`${p}.e`)) {
      const rest = id.slice(p.length + 2);
      if (rest.length > 0 && /^[0-9]+$/.test(rest)) return "line";
    }
  }
  return undefined;
}

interface FeatInfo {
  ty: string;
  sketch: string | undefined;
  tagKind: string | undefined;
}

interface PartCtx {
  earlier: Map<string, FeatInfo>;
  sketches: Map<string, SketchInfo>;
}

function consumedSketch(ctx: PartCtx, feature: string): SketchInfo | undefined {
  const f = ctx.earlier.get(feature);
  return f?.sketch !== undefined ? ctx.sketches.get(f.sketch) : undefined;
}

type Card = "one" | "some" | "any";
interface RefField {
  kinds: readonly string[];
  card: Card;
}
const FACE_ONE: RefField = { kinds: ["face"], card: "one" };
const FACE_SOME: RefField = { kinds: ["face"], card: "some" };
const FACE_ANY: RefField = { kinds: ["face"], card: "any" };
const EDGE_ONE: RefField = { kinds: ["edge"], card: "one" };
const EDGE_SOME: RefField = { kinds: ["edge"], card: "some" };
const VERTEX_ONE: RefField = { kinds: ["vertex"], card: "one" };
const BODY_ONE: RefField = { kinds: ["body"], card: "one" };
const BODY_SOME: RefField = { kinds: ["body"], card: "some" };
const ANY_SOME: RefField = { kinds: [], card: "some" };

/** Every member suffix a compound kind can produce (`compound::member_names`). */
export function memberNames(kind: string, n: number | undefined): string[] {
  switch (kind) {
    case "rect":
      return ["bottom", "c_br", "right", "c_tr", "top", "c_tl", "left", "c_bl"];
    case "slot":
      return ["right", "cap_b", "left", "cap_a"];
    case "polygon":
      return Array.from({ length: n ?? 0 }, (_, k) => `e${k}`);
    default:
      return [];
  }
}

/** The ids a curve puts in the sketch namespace with their solver entity type (§4.3). */
export function solverEntities(c: Obj): [string, Ent | undefined][] {
  const id = str(c["id"]);
  const line = (x: string): [string, Ent][] => [
    [x, "line"],
    [`${x}.start`, "point"],
    [`${x}.end`, "point"],
  ];
  const arc = (x: string): [string, Ent][] => [
    [x, "arc"],
    [`${x}.start`, "point"],
    [`${x}.end`, "point"],
    [`${x}.center`, "point"],
  ];
  switch (c["kind"]) {
    case "point":
      return [[id, "point"]];
    case "line":
      return line(id);
    case "arc":
      return arc(id);
    case "circle":
      return [
        [id, "circle"],
        [`${id}.center`, "point"],
      ];
    case "rect":
    case "slot":
    case "polygon": {
      let n: number | undefined;
      if (c["kind"] === "polygon") {
        const nv = lit(c["n"]);
        n = nv !== undefined && isCount(nv) && nv <= 4096 ? nv : undefined;
        if (n !== undefined && n < 0) n = undefined;
      }
      const out: [string, Ent | undefined][] = [[id, undefined]];
      for (const m of memberNames(str(c["kind"]), n)) {
        const mid = `${id}.${m}`;
        out.push(...(m.startsWith("c_") || m.startsWith("cap_") ? arc(mid) : line(mid)));
      }
      return out;
    }
    default:
      return [[id, undefined]];
  }
}

function sketchInfo(s: Obj): SketchInfo {
  const info: SketchInfo = { profile: new Map(), wildPolygons: [], points: new Set() };
  for (const c of arr(s["curves"])) {
    if (!isObj(c)) continue;
    const id = str(c["id"]);
    const construction = c["construction"] === true;
    switch (c["kind"]) {
      case "point":
        info.points.add(id);
        break;
      case "circle":
        info.points.add(`${id}.center`);
        if (!construction) info.profile.set(id, "circle");
        break;
      default:
        if (construction) break;
        if (c["kind"] === "line") info.profile.set(id, "line");
        else if (c["kind"] === "arc") info.profile.set(id, "arc");
        else if (c["kind"] === "polygon" && lit(c["n"]) === undefined) info.wildPolygons.push(id);
        else {
          for (const [eid, ent] of solverEntities(c)) {
            if (ent === "line") info.profile.set(eid, "line");
            else if (ent === "arc") info.profile.set(eid, "arc");
          }
        }
        break;
    }
  }
  return info;
}

/** A cheap "did you mean" (shared prefix of 3+ bytes), as forge-ir's `similar`. */
function similarId(candidate: string, wanted: string): boolean {
  let common = 0;
  while (common < candidate.length && common < wanted.length && candidate[common] === wanted[common]) common++;
  return common >= Math.max(1, Math.min(3, wanted.length)) && candidate !== wanted;
}

function lit2(p: unknown): [number, number] | undefined {
  const a = arr(p);
  const x = lit(a[0]);
  const y = lit(a[1]);
  return x !== undefined && y !== undefined ? [x, y] : undefined;
}
function lit3(p: unknown): [number, number, number] | undefined {
  const a = arr(p);
  const x = lit(a[0]);
  const y = lit(a[1]);
  const z = lit(a[2]);
  return x !== undefined && y !== undefined && z !== undefined ? [x, y, z] : undefined;
}
function dist2(a: [number, number], b: [number, number]): number {
  const du = a[0] - b[0];
  const dv = a[1] - b[1];
  return Math.sqrt(du * du + dv * dv);
}
function len3(v: [number, number, number]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

class Validator {
  readonly errs: V1ValidationError[] = [];
  private readonly names = new Set<string>();
  private readonly featureIds = new Set<string>();
  private readonly partIds = new Set<string>();
  private readonly partNames = new Set<string>();

  constructor(
    private readonly doc: Obj,
    private readonly opts: V1ValidateOptions,
  ) {}

  private err(code: string, path: string, message: string, details: Obj): void {
    this.errs.push({ code, path, message, details });
  }

  document(): void {
    const doc = this.doc;
    if (doc["schema"] !== v1.IR_SCHEMA) {
      this.err("UNSUPPORTED_SCHEMA", "/schema", `expected ${JSON.stringify(v1.IR_SCHEMA)}, got ${shownValue(doc["schema"])}`, {
        found: shownValue(doc["schema"]),
        supported: ["aicad.ir/0", v1.IR_SCHEMA],
      });
    }
    if (arr(doc["parts"]).length === 0) this.err("NO_PARTS", "/parts", "a document needs at least one part studio", {});
    arr(doc["params"]).forEach((p, i) => this.param(p, `/params/${i}`));
    arr(doc["parts"]).forEach((part, pi) => this.part(pi, part));
  }

  private name(name: string, path: string, reserved: ReadonlySet<string>): void {
    const p = checkId(name);
    if (p) {
      this.err("INVALID_NAME", path, `names must match [A-Za-z_][A-Za-z0-9_]* with at most ${MAX_ID_LEN} bytes (${p})`, {
        path,
        reason: p,
        length: byteLength(name),
      });
    } else if (reserved.has(name)) {
      this.err("RESERVED_NAME", path, `${JSON.stringify(name)} is a reserved word or CadScript builtin; pick another name`, { name });
    }
    if (this.names.has(name)) this.err("DUPLICATE_NAME", path, `${JSON.stringify(shown(name))} is already a feature or parameter name`, { name: shown(name) });
    this.names.add(name);
  }

  private id(id: string, path: string): boolean {
    const p = checkId(id);
    if (!p) return true;
    this.err("INVALID_ID", path, `ids must match [A-Za-z_][A-Za-z0-9_]* with at most ${MAX_ID_LEN} bytes (${p})`, { path, reason: p, length: byteLength(id) });
    return false;
  }

  private reference(s: string, path: string): boolean {
    const p = checkRef(s);
    if (!p) return true;
    this.err("INVALID_ID", path, `references must be ids joined by '.' (${p})`, { path, reason: p, length: byteLength(s) });
    return false;
  }

  private param(p: unknown, pp: string): void {
    if (!isObj(p)) return;
    this.name(str(p["name"]), `${pp}/name`, RESERVED_ALL);
    const name = str(p["name"]);
    const unit = str(p["unit"]);
    if (unit === "bool") {
      for (const field of ["min", "max"]) {
        if (has(p, field)) this.err("PARAM_INVALID", `${pp}/${field}`, "bounds are not allowed on a bool parameter", { name, reason: "bounds-on-bool" });
      }
    }
    const vp = `${pp}/value`;
    const value = p["value"];
    if (typeof value === "boolean" && unit !== "bool") {
      this.err("EXPR_TYPE_MISMATCH", vp, "a boolean literal for a numeric parameter", {
        expr: value,
        subexpr: value,
        expected: unit === "mm" ? "mm" : unit === "deg" ? "deg" : "1",
        found: "bool",
      });
    } else if (typeof value === "number" && unit === "bool") {
      this.err("EXPR_TYPE_MISMATCH", vp, "a number literal for a bool parameter", { expr: value, subexpr: value, expected: "bool", found: "number" });
    }
    const lo = lit(p["min"]);
    const hi = lit(p["max"]);
    if (lo !== undefined && hi !== undefined && lo > hi) {
      this.err("PARAM_INVALID", `${pp}/max`, `min ${fmt(lo)} > max ${fmt(hi)}`, { name, reason: "min-greater-than-max" });
    }
    if (typeof value === "number" && ((lo !== undefined && value < lo) || (hi !== undefined && value > hi))) {
      this.err("PARAM_OUT_OF_RANGE", vp, `${fmt(value)} is outside [${lo ?? "-inf"}, ${hi ?? "inf"}]`, { name, value, min: lo ?? null, max: hi ?? null });
    }
  }

  private part(pi: number, part: unknown): void {
    if (!isObj(part)) return;
    const pp = `/parts/${pi}`;
    const pid = str(part["id"]);
    if (this.id(pid, `${pp}/id`) && this.partIds.has(pid)) this.err("DUPLICATE_ID", `${pp}/id`, `part id ${JSON.stringify(pid)}`, { id: pid });
    if (checkId(pid) === undefined) this.partIds.add(pid);
    const pname = str(part["name"]);
    const pn = checkId(pname);
    if (pn) {
      const path = `${pp}/name`;
      this.err("INVALID_NAME", path, `part names must match [A-Za-z_][A-Za-z0-9_]* with at most ${MAX_ID_LEN} bytes (${pn})`, { path, reason: pn, length: byteLength(pname) });
    } else if (this.partNames.has(pname)) {
      this.err("DUPLICATE_NAME", `${pp}/name`, `part ${JSON.stringify(pname)}`, { name: pname });
    } else this.partNames.add(pname);
    arr(part["params"]).forEach((p, i) => this.param(p, `${pp}/params/${i}`));
    const ctx: PartCtx = { earlier: new Map(), sketches: new Map() };
    arr(part["features"]).forEach((f, fi) => {
      if (!isObj(f)) return;
      const fp = `${pp}/features/${fi}`;
      this.feature(f, fp, ctx);
      const ty = str(f["type"]);
      const info: FeatInfo = {
        ty,
        sketch: ty === "extrude" || ty === "revolve" ? str(f["sketch"]) : undefined,
        tagKind: ty === "tag" && isObj(f["target"]) ? str(f["target"]["kind"]) : undefined,
      };
      if (ty === "sketch") ctx.sketches.set(str(f["id"]), sketchInfo(f));
      if (!ctx.earlier.has(str(f["id"]))) ctx.earlier.set(str(f["id"]), info);
    });
  }

  private feature(f: Obj, fp: string, ctx: PartCtx): void {
    const fid = str(f["id"]);
    if (this.id(fid, `${fp}/id`) && this.featureIds.has(fid)) this.err("DUPLICATE_ID", `${fp}/id`, `feature id ${JSON.stringify(fid)}`, { id: fid });
    if (checkId(fid) === undefined) this.featureIds.add(fid);
    this.name(str(f["name"]), `${fp}/name`, RESERVED_V0);
    const ty = str(f["type"]);
    const v = has(f, "v") ? f["v"] : 1;
    if (v !== 1) {
      this.err("UNSUPPORTED_FEATURE_VERSION", `${fp}/v`, `${ty} v${shownValue(v)} is not implemented`, { type: ty, v, supported: [1] });
    }
    if (this.opts.unsupportedFeatures?.includes(ty)) this.err("UNSUPPORTED_FEATURE", `${fp}/type`, `this engine does not implement ${JSON.stringify(ty)}`, { type: ty });
    switch (ty) {
      case "sketch":
        this.sketch(f, fp, ctx);
        break;
      case "extrude": {
        this.sketchRef(str(f["sketch"]), `${fp}/sketch`, ctx);
        this.regions(f["regions"], str(f["sketch"]), fp, ctx);
        const d = lit(f["distance"]);
        if (d !== undefined && d <= LINEAR_TOLERANCE) this.range("INVALID_DISTANCE", fp, "distance", d, tolText);
        // Amendment set F (§6.2): exactly one of distance and extent; through_all cuts or
        // intersects; up_to is one-sided.
        const ext = f["extent"];
        const conflict = (why: string, fields: string[]): void => this.err("EXTRUDE_EXTENT_CONFLICT", `${fp}/extent`, why, { field: "extent", fields });
        if (ext === undefined && !has(f, "distance")) conflict("an extrude needs a distance or an extent", ["distance", "extent"]);
        else if (ext !== undefined && has(f, "distance")) conflict("an extrude has a distance or an extent, not both", ["distance", "extent"]);
        else if (ext === "through_all" && !["cut", "intersect"].includes(str(f["op"]) || "new_body")) conflict("through_all cuts or intersects (op cut or intersect)", ["extent", "op"]);
        else if (isObj(ext) && has(ext, "up_to")) {
          if (f["direction"] === "symmetric") conflict("up_to goes one way: not with direction symmetric", ["extent", "direction"]);
          this.plane((ext as Obj)["up_to"], `${fp}/extent/up_to`, ctx);
        }
        this.bodyOp(str(f["op"]) || "new_body", f["targets"], fp, ctx);
        break;
      }
      case "revolve": {
        this.sketchRef(str(f["sketch"]), `${fp}/sketch`, ctx);
        this.regions(f["regions"], str(f["sketch"]), fp, ctx);
        const a = lit(f["angle"]);
        if (a !== undefined && !(a > 0 && a <= 360)) this.range("INVALID_ANGLE", fp, "angle", a, "in (0, 360]");
        const axis = isObj(f["axis"]) ? f["axis"] : {};
        const dir = arr(axis["direction"]);
        const dx = lit(dir[0]);
        const dy = lit(dir[1]);
        if (dx !== undefined && dy !== undefined && Math.sqrt(dx * dx + dy * dy) <= LINEAR_TOLERANCE) {
          this.err("INVALID_AXIS", `${fp}/axis`, "axis direction must be non-zero", { field: "axis", value: [dx, dy], expected: "a non-zero direction" });
        }
        this.bodyOp(str(f["op"]) || "new_body", f["targets"], fp, ctx);
        break;
      }
      case "boolean":
        this.checkRef(f["targets"], `${fp}/targets`, BODY_SOME, ctx);
        this.checkRef(f["tools"], `${fp}/tools`, BODY_SOME, ctx);
        break;
      case "transform": {
        this.checkRef(f["bodies"], `${fp}/bodies`, BODY_SOME, ctx);
        if (isObj(f["rotate"])) {
          const r = f["rotate"] as Obj;
          this.axis(r["axis"], `${fp}/rotate/axis`, ctx);
          const a = lit(r["angle"]);
          if (a !== undefined && !(Number.isFinite(a) && Math.abs(a) <= 360)) this.range("INVALID_ANGLE", fp, "rotate/angle", a, "in [-360, 360]");
        }
        break;
      }
      case "hole":
        this.hole(f, fp, ctx);
        break;
      case "fillet": {
        this.checkRef(f["edges"], `${fp}/edges`, EDGE_SOME, ctx);
        const r = lit(f["r"]);
        if (r !== undefined && r <= LINEAR_TOLERANCE) this.range("INVALID_RADIUS", fp, "r", r, tolText);
        break;
      }
      case "chamfer":
        this.chamfer(f, fp, ctx);
        break;
      case "shell": {
        this.checkRef(f["body"], `${fp}/body`, BODY_ONE, ctx);
        if (has(f, "open")) this.checkRef(f["open"], `${fp}/open`, FACE_ANY, ctx);
        const t = lit(f["thickness"]);
        if (t !== undefined && t <= LINEAR_TOLERANCE) this.range("INVALID_VALUE", fp, "thickness", t, tolText);
        break;
      }
      case "draft": {
        this.checkRef(f["faces"], `${fp}/faces`, FACE_SOME, ctx);
        this.plane(f["neutral"], `${fp}/neutral`, ctx);
        const a = lit(f["angle"]);
        if (a !== undefined && !(a > 0 && a < 45)) this.range("INVALID_VALUE", fp, "angle", a, "in (0, 45)");
        break;
      }
      case "pattern":
        this.pattern(f, fp, ctx);
        break;
      case "datum_plane":
        this.datumPlane(f, fp, ctx);
        break;
      case "datum_axis":
        this.datumAxis(f, fp, ctx);
        break;
      case "tag":
        this.checkRef(f["target"], `${fp}/target`, ANY_SOME, ctx);
        break;
      default:
        break;
    }
  }

  private range(code: string, fp: string, field: string, value: number, expected: string): void {
    this.err(code, `${fp}/${field}`, `${field} = ${fmt(value)}: must be ${expected}`, { field, value, expected });
  }

  private rangeJson(code: string, path: string, field: string, value: unknown, expected: string): void {
    this.err(code, path, `${field}: must be ${expected}`, { field, value, expected });
  }

  // ── sketches ──

  private sketch(s: Obj, fp: string, ctx: PartCtx): void {
    this.plane(s["plane"], `${fp}/plane`, ctx);
    const curves = arr(s["curves"]);
    if (curves.length === 0) this.err("EMPTY_SKETCH", `${fp}/curves`, "a sketch needs at least one curve", { sketch: str(s["id"]) });
    const constraints = arr(s["constraints"]);
    const constrained = constraints.length > 0;
    const ns = new Set<string>();
    const ents = new Map<string, Ent>();
    curves.forEach((c, ci) => {
      if (!isObj(c)) return;
      const cp = `${fp}/curves/${ci}`;
      if (!this.id(str(c["id"]), `${cp}/id`)) return;
      let clashed = false;
      for (const [eid, ent] of solverEntities(c)) {
        if (ns.has(eid)) {
          if (!clashed) {
            this.err("DUPLICATE_ID", `${cp}/id`, `id ${JSON.stringify(eid)} (of curve ${JSON.stringify(str(c["id"]))}) is already used in this sketch`, { id: eid });
          }
          clashed = true;
        } else {
          ns.add(eid);
          if (ent) ents.set(eid, ent);
        }
      }
      this.curve(s, c, cp, constrained);
    });
    constraints.forEach((con, k) => {
      if (!isObj(con)) return;
      const kp = `${fp}/constraints/${k}`;
      const cid = str(con["id"]);
      if (this.id(cid, `${kp}/id`)) {
        if (ns.has(cid)) this.err("DUPLICATE_ID", `${kp}/id`, `constraint id ${JSON.stringify(cid)} is already used in this sketch`, { id: cid });
        else ns.add(cid);
      }
      this.constraint(con, kp, ents);
    });
  }

  private curve(s: Obj, c: Obj, cp: string, constrained: boolean): void {
    const kind = str(c["kind"]);
    const compound = kind === "rect" || kind === "slot" || kind === "polygon";
    if (constrained) {
      if (compound) {
        this.err(
          "SKETCH_MIXED_MODE",
          cp,
          `compound curve ${JSON.stringify(str(c["id"]))} in a constrained sketch: use lines and constraints, or drop the constraints and drive the ${kind} with parameters`,
          { sketch: str(s["id"]), path: cp },
        );
      } else {
        for (const site of new Walker().curveSites(cp, c)) {
          this.err(
            "SKETCH_MIXED_MODE",
            site.path,
            "a constrained sketch stores literal geometry only (the last solution); bind the value with a dimension constraint instead",
            { sketch: str(s["id"]), path: site.path },
          );
        }
      }
    }
    const degenerate = (reason: string): void => this.err("DEGENERATE_CURVE", cp, reason, { curve: str(c["id"]), reason });
    switch (kind) {
      case "line": {
        const a = lit2(c["start"]);
        const b = lit2(c["end"]);
        if (a && b && dist2(a, b) <= LINEAR_TOLERANCE) degenerate("zero-length line");
        break;
      }
      case "arc": {
        const a = lit2(c["start"]);
        const b = lit2(c["end"]);
        const m = lit2(c["center"]);
        if (a && b && m) {
          const r0 = dist2(a, m);
          const r1 = dist2(b, m);
          if (r0 <= LINEAR_TOLERANCE || r1 <= LINEAR_TOLERANCE) degenerate("zero-radius arc");
          else if (!constrained && Math.abs(r0 - r1) > LINEAR_TOLERANCE) {
            this.err("INCONSISTENT_ARC", cp, `|start−center| = ${r0} but |end−center| = ${r1}`, { curve: str(c["id"]), r_start: r0, r_end: r1 });
          } else if (dist2(a, b) <= LINEAR_TOLERANCE) degenerate("arc start == end; use a circle for a full turn");
        }
        break;
      }
      case "circle": {
        const r = lit(c["radius"]);
        if (r !== undefined && r <= LINEAR_TOLERANCE) degenerate("circle radius must be > 0");
        break;
      }
      case "rect": {
        if (has(c, "center") === has(c, "corner")) {
          this.err("CURVE_OPTIONS_CONFLICT", cp, "a rect needs exactly one of center / corner", { curve: str(c["id"]), fields: ["center", "corner"] });
        }
        this.positiveLen(cp, "w", c["w"]);
        this.positiveLen(cp, "h", c["h"]);
        const r = has(c, "r") ? c["r"] : 0;
        const rv = lit(r);
        const wv = lit(c["w"]);
        const hv = lit(c["h"]);
        if (rv !== undefined && rv < 0) this.range("INVALID_VALUE", cp, "r", rv, ">= 0");
        else if (wv !== undefined && hv !== undefined && rv !== undefined && wv > LINEAR_TOLERANCE && hv > LINEAR_TOLERANCE && rv > Math.min(wv, hv) / 2) {
          this.range("INVALID_VALUE", cp, "r", rv, `<= min(w, h)/2 = ${fmt(Math.min(wv, hv) / 2)}`);
        }
        break;
      }
      case "slot": {
        this.positiveLen(cp, "w", c["w"]);
        const a = lit2(c["a"]);
        const b = lit2(c["b"]);
        if (a && b && dist2(a, b) <= LINEAR_TOLERANCE) this.range("INVALID_VALUE", cp, "b", dist2(a, b), `|b − a| ${tolText}`);
        break;
      }
      case "polygon": {
        const sizes = ["circumradius", "inradius", "across_flats", "side"];
        const given = sizes.filter((k) => has(c, k));
        if (given.length !== 1) {
          this.err("CURVE_OPTIONS_CONFLICT", cp, "a polygon needs exactly one of circumradius / inradius / across_flats / side", {
            curve: str(c["id"]),
            fields: sizes,
          });
        }
        for (const k of given) this.positiveLen(cp, k, c[k]);
        const nv = lit(c["n"]);
        if (nv !== undefined && isCount(nv) && nv < 3) this.range("INVALID_COUNT", cp, "n", nv, ">= 3");
        break;
      }
      default:
        break;
    }
  }

  private positiveLen(cp: string, field: string, v: unknown): void {
    const x = lit(v);
    if (x !== undefined && x <= LINEAR_TOLERANCE) this.range("INVALID_VALUE", cp, field, x, tolText);
  }

  private constraint(con: Obj, kp: string, ents: Map<string, Ent>): void {
    const id = shown(str(con["id"]));
    const type = str(con["type"]);
    if (DIMENSION_TYPES.includes(type)) {
      const hasValue = has(con, "value");
      const driving = con["driving"] !== false;
      if (!hasValue && driving) this.err("CONSTRAINT_VALUE_REQUIRED", kp, `driving dimension ${JSON.stringify(id)} needs a value`, { constraint: id });
      else if (hasValue && !driving) {
        this.err("CONSTRAINT_VALUE_ON_REFERENCE", `${kp}/value`, `reference dimension ${JSON.stringify(id)} must not have a value (it is measured)`, { constraint: id });
      } else if (hasValue && driving) {
        const x = lit(con["value"]);
        if (x !== undefined && type !== "angle" && x <= 0) {
          this.err("SKETCH_INVALID_DIMENSION", `${kp}/value`, `${type} must be > 0, got ${fmt(x)}`, { constraint: id, value: x });
        }
      }
    }
    let refsOk = true;
    for (const [arg, ref] of constraintArguments(con)) refsOk = this.reference(ref, `${kp}/${arg}`) && refsOk;
    if (!refsOk) return;
    const e = checkConstraintRefs(con, ents);
    if (!e) return;
    switch (e.kind) {
      case "unknown":
        this.err("SKETCH_UNKNOWN_REFERENCE", `${kp}/${e.arg}`, `\`${id}\` references unknown entity \`${e.reference}\``, { owner: id, reference: e.reference });
        break;
      case "wrong":
        this.err("SKETCH_WRONG_ENTITY_TYPE", `${kp}/${e.arg}`, `\`${id}\` expects ${e.expected} for \`${e.reference}\`, found ${e.found}`, {
          owner: id,
          reference: e.reference,
          expected: e.expected,
          found: e.found,
        });
        break;
      case "combination":
        this.err("SKETCH_UNSUPPORTED_COMBINATION", kp, `\`${id}\`: unsupported ${e.what} between ${e.a} and ${e.b}`, { id, kind: e.what, a: e.a, b: e.b });
        break;
      default:
        this.err("SKETCH_SELF_REFERENCE", `${kp}/${e.arg}`, `\`${id}\` references \`${e.reference}\` twice`, { id, reference: e.reference });
        break;
    }
  }

  private sketchRef(sketch: string, path: string, ctx: PartCtx): void {
    if (!this.reference(sketch, path)) return;
    if (ctx.earlier.get(sketch)?.ty !== "sketch") {
      this.err("UNRESOLVED_SKETCH", path, `${JSON.stringify(sketch)} is not the id of an earlier sketch feature in this part studio`, { sketch });
    }
  }

  private regions(regions: unknown, sketch: string, fp: string, ctx: PartCtx): void {
    if (!Array.isArray(regions)) return;
    if (regions.length === 0) {
      this.err("INVALID_VALUE", `${fp}/regions`, 'regions must be "all" or a non-empty list of curve ids', { field: "regions", value: [], expected: '"all" or a non-empty list' });
    }
    regions.forEach((id, k) => {
      const rp = `${fp}/regions/${k}`;
      const s = str(id);
      if (!this.reference(s, rp) || !isRef(sketch)) return;
      const info = ctx.sketches.get(sketch);
      if (info && curveClass(info, s) === undefined) this.unknownCurve(rp, sketch, s, info);
    });
  }

  private unknownCurve(path: string, feature: string, curve: string, info: SketchInfo): void {
    const similar = [...info.profile.keys()].sort().filter((k) => similarId(k, curve)).slice(0, 5);
    this.err("QUERY_UNKNOWN_CURVE", path, `${JSON.stringify(curve)} is not a profile curve of the sketch consumed by ${JSON.stringify(feature)}`, { feature, curve, similar });
    const ids = [...info.profile.keys(), ...info.wildPolygons.map((p) => `${p}.e<k>`)].sort();
    this.errs[this.errs.length - 1]!.candidates = { what: "profile curves", ids };
  }

  private bodyOp(op: string, targets: unknown, fp: string, ctx: PartCtx): void {
    if (op === "new_body") {
      if (targets !== undefined) {
        this.err("INVALID_VALUE", `${fp}/targets`, "targets are only used when op is join, cut or intersect", {
          field: "targets",
          value: null,
          expected: "absent when op is new_body",
        });
      }
    } else if (targets === undefined) {
      this.err("BOOLEAN_TARGETS_REQUIRED", `${fp}/targets`, 'join/cut/intersect need explicit targets ("all" or a body reference)', { feature: fp });
    } else this.targets(targets, `${fp}/targets`, ctx);
  }

  private targets(t: unknown, path: string, ctx: PartCtx): void {
    if (isObj(t)) this.checkRef(t, path, BODY_SOME, ctx);
  }

  // ── planes, axes, points, directions ──

  private plane(p: unknown, path: string, ctx: PartCtx): void {
    if (!isObj(p)) return;
    if (has(p, "face")) {
      this.checkRef(p["face"], `${path}/face`, FACE_ONE, ctx);
      if (has(p, "x_dir")) this.nonzero(p["x_dir"], `${path}/x_dir`, "INVALID_VALUE");
    } else if (has(p, "datum")) {
      this.datumRef(str(p["datum"]), `${path}/datum`, "datum_plane", ctx);
    } else this.frame(p["normal"], p["x_dir"], path);
  }

  private frame(normal: unknown, xDir: unknown, path: string): void {
    const n = lit3(normal);
    const x = lit3(xDir);
    if (!n || !x) return;
    const ln = len3(n);
    const lx = len3(x);
    if (ln <= LINEAR_TOLERANCE || lx <= LINEAR_TOLERANCE) {
      this.err("INVALID_PLANE", path, "degenerate frame", { field: path, reason: "zero-length normal or x_dir" });
    } else {
      const dot = (n[0] * x[0] + n[1] * x[1] + n[2] * x[2]) / (ln * lx);
      if (Math.abs(dot) > 1e-9) {
        this.err("INVALID_PLANE", path, `normal and x_dir must be perpendicular (cos = ${dot.toExponential()})`, {
          field: path,
          reason: "normal and x_dir are not perpendicular",
        });
      }
    }
  }

  private nonzero(v: unknown, path: string, code: string): void {
    const x = lit3(v);
    if (x && len3(x) <= LINEAR_TOLERANCE) this.err(code, path, "direction must be non-zero", { field: path, value: x, expected: "a non-zero vector" });
  }

  private datumRef(id: string, path: string, expected: string, ctx: PartCtx): void {
    if (!this.reference(id, path)) return;
    if (ctx.earlier.get(id)?.ty !== expected) {
      this.err("UNRESOLVED_FEATURE", path, `${JSON.stringify(id)} is not an earlier ${expected} feature of this part studio`, { id, field: path, expected });
    }
  }

  private axis(a: unknown, path: string, ctx: PartCtx): void {
    if (isObj(a)) this.axisObject(a, path, ctx);
  }

  private axisObject(o: Obj, path: string, ctx: PartCtx): void {
    if (has(o, "edge")) this.checkRef(o["edge"], `${path}/edge`, EDGE_ONE, ctx);
    else if (has(o, "cylinder")) this.checkRef(o["cylinder"], `${path}/cylinder`, FACE_ONE, ctx);
    else if (has(o, "datum")) this.datumRef(str(o["datum"]), `${path}/datum`, "datum_axis", ctx);
    else if (has(o, "line")) this.nonzero(isObj(o["line"]) ? o["line"]["direction"] : undefined, `${path}/line/direction`, "INVALID_AXIS");
  }

  private point(p: unknown, path: string, ctx: PartCtx): void {
    if (has(p, "vertex")) this.checkRef((p as Obj)["vertex"], `${path}/vertex`, VERTEX_ONE, ctx);
  }

  private dir(d: unknown, path: string, ctx: PartCtx): void {
    if (Array.isArray(d)) this.nonzero(d, path, "INVALID_VALUE");
    else if (isObj(d)) this.axisObject(d, path, ctx);
  }

  // ── references and queries ──

  private checkRef(r: unknown, path: string, field: RefField, ctx: PartCtx): void {
    if (!isObj(r)) return;
    const kind = str(r["kind"]);
    const qkind = this.query(r["q"], `${path}/q`, ctx);
    this.opts.onRefKind?.(path, qkind);
    if (qkind !== undefined && qkind !== kind) {
      this.err("REF_KIND_MISMATCH", `${path}/kind`, `kind is ${JSON.stringify(kind)} but the query selects ${qkind}s`, { field: path, expected: qkind, found: kind });
    }
    if (field.kinds.length > 0 && !field.kinds.includes(kind)) {
      this.err("REF_KIND_MISMATCH", `${path}/kind`, `this field takes ${field.kinds.join(" or ")} references, not ${kind}`, { field: path, expected: field.kinds, found: kind });
    }
    const card = r["card"];
    if (field.card === "one" && card !== undefined && card !== "one" && card !== 1) {
      this.err("INVALID_CARDINALITY", `${path}/card`, 'this field designates exactly one entity; card must be "one"', { field: path, allowed: ["one", 1] });
    }
    if (card === 0) {
      this.err("INVALID_CARDINALITY", `${path}/card`, "card must be one, some, any or an integer >= 1", { field: path, allowed: ["one", "some", "any", ">= 1"] });
    }
  }

  private featureOf(feature: string, path: string, allowed: readonly string[], ctx: PartCtx, qpath: string): string | undefined {
    const fpath = `${path}/feature`;
    if (!this.reference(feature, fpath)) return undefined;
    const f = ctx.earlier.get(feature);
    if (!f) {
      this.err("UNRESOLVED_FEATURE", fpath, `${JSON.stringify(feature)} is not the id of an earlier feature of this part studio`, { id: feature, field: fpath, expected: allowed });
      return undefined;
    }
    if (allowed.length > 0 && !allowed.includes(f.ty)) {
      this.err("QUERY_INVALID", fpath, `this query needs a ${allowed.join(" or ")} feature, ${JSON.stringify(feature)} is a ${f.ty}`, { path: qpath, expected: allowed, found: f.ty });
      return undefined;
    }
    return f.ty;
  }

  private curveOf(feature: string, curve: string, path: string, ctx: PartCtx): CurveClass | undefined {
    if (!this.reference(curve, path)) return undefined;
    const info = consumedSketch(ctx, feature);
    if (!info) return undefined;
    const cls = curveClass(info, curve);
    if (cls === undefined) this.unknownCurve(path, feature, curve, info);
    return cls;
  }

  private queryInvalid(path: string, expected: string, found: string, message: string): void {
    this.err("QUERY_INVALID", path, message, { path, expected, found });
  }

  /** The static kind of a query (§5.4), or undefined after reporting an error. */
  private query(q: unknown, path: string, ctx: PartCtx): string | undefined {
    if (!isObj(q)) return undefined;
    const SWEEPS = ["extrude", "revolve"];
    const BODY_ORIGINS = ["extrude", "revolve", "pattern", "transform"];
    const CREATORS = ["extrude", "revolve", "boolean", "hole", "fillet", "chamfer", "shell", "draft", "pattern", "transform"];
    const feature = str(q["feature"]);
    const op = str(q["op"]);
    switch (op) {
      case "body": {
        const ty = this.featureOf(feature, path, BODY_ORIGINS, ctx, path);
        if ((ty === "extrude" || ty === "revolve") && has(q, "member")) this.curveOf(feature, str(q["member"]), `${path}/member`, ctx);
        return "body";
      }
      case "bodies":
        return "body";
      case "cap":
      case "endcap":
        if (this.featureOf(feature, path, [op === "cap" ? "extrude" : "revolve"], ctx, path) !== undefined && has(q, "member")) {
          this.curveOf(feature, str(q["member"]), `${path}/member`, ctx);
        }
        return "face";
      case "side":
        if (this.featureOf(feature, path, SWEEPS, ctx, path) !== undefined) this.curveOf(feature, str(q["curve"]), `${path}/curve`, ctx);
        return "face";
      case "sides":
        if (this.featureOf(feature, path, SWEEPS, ctx, path) !== undefined && has(q, "member")) this.curveOf(feature, str(q["member"]), `${path}/member`, ctx);
        return "face";
      case "edge_at":
        if (this.featureOf(feature, path, SWEEPS, ctx, path) !== undefined && this.curveOf(feature, str(q["curve"]), `${path}/curve`, ctx) === "circle") {
          this.queryInvalid(`${path}/curve`, "a line or arc (a curve with ends)", "circle", `${JSON.stringify(str(q["curve"]))} is a circle: it has no ends`);
        }
        return "edge";
      case "between":
        for (const side of ["a", "b"]) {
          const sp = `${path}/${side}`;
          const k = this.query(q[side], sp, ctx);
          if (k !== undefined && k !== "face") this.queryInvalid(sp, "face", k, `between takes two face queries, ${side} selects ${k}s`);
        }
        return "edge";
      case "hole_face":
        this.featureOf(feature, path, ["hole"], ctx, path);
        this.id(str(q["at"]), `${path}/at`);
        return "face";
      case "created":
        this.featureOf(feature, path, CREATORS, ctx, path);
        if (has(q, "role")) this.id(str(q["role"]), `${path}/role`);
        return "face";
      case "instance": {
        this.featureOf(feature, path, ["pattern"], ctx, path);
        const index = arr(q["index"]);
        if (index.length === 0 || index.length > 2) {
          this.queryInvalid(`${path}/index`, "[i] or [i, j]", `${index.length} indices`, "an instance index is [i] or [i, j]");
        }
        return "face";
      }
      case "tagged":
        if (this.featureOf(feature, path, ["tag"], ctx, path) === undefined) return undefined;
        return ctx.earlier.get(feature)?.tagKind;
      case "faces":
        return this.nav(q["of"], path, ["body", "edge", "vertex"], "face", ctx);
      case "edges":
        return this.nav(q["of"], path, ["body", "face", "vertex"], "edge", ctx);
      case "vertices":
        return this.nav(q["of"], path, ["body", "face", "edge"], "vertex", ctx);
      case "owner":
        return this.nav(q["of"], path, ["face", "edge", "vertex"], "body", ctx);
      case "union":
      case "intersect": {
        const of = arr(q["of"]);
        if (of.length === 0) {
          this.queryInvalid(`${path}/of`, "at least one query", "none", `${op} needs at least one operand`);
          return undefined;
        }
        let kind: string | undefined;
        of.forEach((sub, i) => {
          const sp = `${path}/of/${i}`;
          const k = this.query(sub, sp, ctx);
          if (k === undefined) return;
          if (kind === undefined) kind = k;
          else if (kind !== k) this.queryInvalid(sp, kind, k, `set operands must have one kind: ${kind} vs ${k}`);
        });
        return kind;
      }
      case "minus": {
        const ka = this.query(q["a"], `${path}/a`, ctx);
        const kb = this.query(q["b"], `${path}/b`, ctx);
        if (ka !== undefined && kb !== undefined && ka !== kb) this.queryInvalid(`${path}/b`, ka, kb, "minus operands must have one kind");
        return ka;
      }
      case "filter": {
        const k = this.query(q["of"], `${path}/of`, ctx);
        if (k === undefined) return undefined;
        this.predicate(q["where"], k, `${path}/where`, ctx);
        return k;
      }
      case "extreme":
        this.dir(q["dir"], `${path}/dir`, ctx);
        return this.query(q["of"], `${path}/of`, ctx);
      case "largest":
      case "smallest": {
        const k = this.query(q["of"], `${path}/of`, ctx);
        if (k === undefined) return undefined;
        if (k === "vertex") this.queryInvalid(`${path}/of`, "faces, edges or bodies", "vertex", `${op} needs a size; vertices have none`);
        return k;
      }
      default:
        return undefined;
    }
  }

  private nav(of: unknown, path: string, from: readonly string[], to: string, ctx: PartCtx): string {
    const sp = `${path}/of`;
    const k = this.query(of, sp, ctx);
    if (k !== undefined && !from.includes(k)) this.queryInvalid(sp, from.join(" or "), k, `cannot navigate from ${k}s to ${to}s`);
    return to;
  }

  private predicate(p: unknown, k: string, path: string, ctx: PartCtx): void {
    if (!isObj(p)) return;
    const [name, value] = Object.entries(p)[0] ?? ["", undefined];
    const FACE_TYPES = ["plane", "cylinder", "cone", "sphere", "torus", "bspline"];
    const EDGE_TYPES = ["line", "circle", "ellipse", "bspline"];
    let ok: boolean;
    let expected: string;
    switch (name) {
      case "type": {
        const t = str(value);
        ok = k === "face" ? FACE_TYPES.includes(t) : k === "edge" ? EDGE_TYPES.includes(t) : false;
        expected = FACE_TYPES.includes(t) ? "faces" : "edges";
        break;
      }
      case "normal":
        ok = k === "face";
        expected = "faces";
        break;
      case "parallel":
      case "perpendicular":
      case "radius":
        ok = k === "face" || k === "edge";
        expected = "faces or edges";
        break;
      default:
        ok = k === "edge";
        expected = "edges";
        break;
    }
    if (!ok) this.queryInvalid(path, expected, k, `predicate ${JSON.stringify(name)} does not apply to ${k}s`);
    if (name === "normal" || name === "parallel" || name === "perpendicular") this.dir(value, `${path}/${name}`, ctx);
    else if ((name === "convex" || name === "concave" || name === "smooth") && value === false) {
      this.queryInvalid(`${path}/${name}`, "true", "false", `{ ${JSON.stringify(name)}: false } is not a predicate; use minus`);
    } else if (name === "radius" && isObj(value)) {
      const eq = has(value, "eq");
      const lo = has(value, "min");
      const hi = has(value, "max");
      if (!((eq && !lo && !hi) || (!eq && (lo || hi)))) {
        this.queryInvalid(`${path}/radius`, "{ eq } or { min?, max? }", "other fields", "radius takes eq, or min and/or max");
      }
      for (const f of ["eq", "min", "max"]) {
        const x = lit(value[f]);
        if (x !== undefined && x < 0) this.range("INVALID_VALUE", `${path}/radius`, f, x, ">= 0");
      }
    }
  }

  // ── holes ──

  private hole(h: Obj, fp: string, ctx: PartCtx): void {
    this.plane(h["on"], `${fp}/on`, ctx);
    const conflict = (field: string, allowed: unknown, message: string): void => this.err("HOLE_OPTIONS_CONFLICT", `${fp}/${field}`, message, { field, allowed });
    const size = typeof h["size"] === "string" && HOLE_SIZE_NAMES.includes(h["size"]) ? h["size"] : undefined;
    if (!has(h, "size") && !has(h, "d")) {
      this.err("HOLE_SIZE_REQUIRED", fp, 'a hole needs a standard size ("M3", …) or an explicit diameter d', { field: "size", allowed: HOLE_SIZE_NAMES });
    }
    const presets: [string, boolean, (s: string) => boolean][] = [
      ["cbore", typeof h["cbore"] === "string", (s) => holeRow(s, "cbore_d") !== null && holeRow(s, "cbore_depth") !== null],
      ["csink", typeof h["csink"] === "string", (s) => holeRow(s, "csink_d") !== null],
      ["insert", typeof h["insert"] === "string", (s) => holeRow(s, "insert_d") !== null && holeRow(s, "insert_depth") !== null],
    ];
    for (const [field, isPreset, available] of presets) {
      if (!isPreset) continue;
      if (size === undefined) conflict(field, HOLE_SIZE_NAMES, `the ${field} preset needs a standard size`);
      else if (!available(size)) {
        conflict(field, HOLE_SIZE_NAMES.filter(available), `the ${field} preset has no table value for ${size}`);
      }
    }
    const heads = ["cbore", "csink", "insert"].filter((k) => has(h, k));
    if (heads.length > 1) conflict(heads[1]!, ["cbore", "csink", "insert"], `at most one of cbore, csink, insert (got ${heads.join(", ")})`);
    const thread = h["thread"];
    const threaded = thread !== undefined && thread !== false;
    if (threaded && has(h, "insert")) conflict("thread", ["thread", "insert"], "thread excludes insert");
    if (threaded && (h["fit"] === "close" || h["fit"] === "loose")) conflict("fit", ["normal", "tap"], "a threaded hole uses the tap drill; fit close/loose contradicts it");
    if (threaded && !has(h, "size") && !(isObj(thread) && has(thread, "pitch"))) {
      conflict("thread", { pitch: "required without size" }, "a thread without a standard size needs a pitch");
    }
    if (!has(h, "depth") && !has(h, "insert")) {
      this.err("HOLE_DEPTH_REQUIRED", `${fp}/depth`, 'depth is required: "through", { "blind": h } or { "up_to": face }', { field: "depth", allowed: ["through", "blind", "up_to"] });
    } else if (has(h, "depth") && has(h, "insert")) conflict("depth", ["insert"], "an insert sets its own blind depth");
    const tip = has(h, "tip") ? h["tip"] : 118;
    const tipDefault = tip === 118;
    if (!tipDefault && !has(h["depth"], "blind")) conflict("tip", ["blind"], "tip applies to blind holes only");
    const tipv = lit(tip);
    if (tipv !== undefined && !(tipv > 0 && tipv < 180)) this.range("INVALID_VALUE", fp, "tip", tipv, "in (0, 180)");
    if (has(h, "d")) this.positiveLen(fp, "d", h["d"]);
    const depth = h["depth"];
    if (has(depth, "blind")) this.positiveLen(`${fp}/depth`, "blind", (depth as Obj)["blind"]);
    else if (has(depth, "up_to")) this.checkRef((depth as Obj)["up_to"], `${fp}/depth/up_to`, FACE_ONE, ctx);
    if (isObj(h["cbore"])) {
      this.positiveLen(`${fp}/cbore`, "d", h["cbore"]["d"]);
      this.positiveLen(`${fp}/cbore`, "depth", h["cbore"]["depth"]);
    }
    if (isObj(h["csink"])) {
      this.positiveLen(`${fp}/csink`, "d", h["csink"]["d"]);
      const a = lit(has(h["csink"], "angle") ? h["csink"]["angle"] : 90);
      if (a !== undefined && !(a > 0 && a < 180)) this.range("INVALID_VALUE", `${fp}/csink`, "angle", a, "in (0, 180)");
    }
    if (isObj(h["insert"])) {
      this.positiveLen(`${fp}/insert`, "d", h["insert"]["d"]);
      this.positiveLen(`${fp}/insert`, "depth", h["insert"]["depth"]);
    }
    if (isObj(thread)) {
      for (const f of ["pitch", "depth"]) if (has(thread, f)) this.positiveLen(`${fp}/thread`, f, thread[f]);
    }
    this.placement(h["at"], `${fp}/at`, ctx);
    const onFace = has(h["on"], "face");
    if (has(h, "targets")) this.targets(h["targets"], `${fp}/targets`, ctx);
    else if (!onFace) this.err("BOOLEAN_TARGETS_REQUIRED", `${fp}/targets`, "a hole placed on a plane that is not a face needs explicit targets", { feature: fp });
  }

  private placement(at: unknown, ap: string, ctx: PartCtx): void {
    if (!isObj(at)) return;
    if (has(at, "points")) {
      const p = at["points"] as Obj;
      const sp = `${ap}/points`;
      const sketch = str(p["sketch"]);
      this.sketchRef(sketch, `${sp}/sketch`, ctx);
      if (Array.isArray(p["ids"])) {
        const ids = p["ids"];
        if (ids.length === 0) this.rangeJson("INVALID_VALUE", `${sp}/ids`, "ids", [], '"all" or a non-empty list');
        const info = ctx.sketches.get(sketch);
        const seen = new Set<string>();
        ids.forEach((raw, k) => {
          const ip = `${sp}/ids/${k}`;
          const id = str(raw);
          if (!this.reference(id, ip)) return;
          if (seen.has(id)) this.err("DUPLICATE_ID", ip, `position ${JSON.stringify(id)} listed twice`, { id });
          seen.add(id);
          if (info && !info.points.has(id)) {
            const similar = [...info.points].sort().filter((x) => similarId(x, id)).slice(0, 5);
            this.err("QUERY_UNKNOWN_CURVE", ip, `${JSON.stringify(id)} is not a point (or circle center) of sketch ${JSON.stringify(sketch)}`, {
              feature: sketch,
              curve: id,
              similar,
            });
            this.errs[this.errs.length - 1]!.candidates = { what: "points of the sketch", ids: [...info.points].sort() };
          }
        });
      }
    } else if (has(at, "list")) {
      const list = arr(at["list"]);
      if (list.length === 0) this.rangeJson("INVALID_VALUE", `${ap}/list`, "list", [], "a non-empty list");
      const seen = new Set<string>();
      list.forEach((p, k) => {
        const ip = `${ap}/list/${k}/id`;
        const id = isObj(p) ? str(p["id"]) : "";
        if (this.id(id, ip) && seen.has(id)) this.err("DUPLICATE_ID", ip, `position id ${JSON.stringify(id)}`, { id });
        seen.add(id);
      });
    } else if (has(at, "grid")) {
      const g = at["grid"] as Obj;
      const gp = `${ap}/grid`;
      this.countMin(gp, "nx", g["nx"], 1);
      this.countMin(gp, "ny", g["ny"], 1);
    } else if (has(at, "circle")) {
      const c = at["circle"] as Obj;
      const cp = `${ap}/circle`;
      this.countMin(cp, "n", c["n"], 1);
      this.positiveLen(cp, "d", c["d"]);
    }
  }

  private countMin(base: string, field: string, v: unknown, min: number): void {
    const x = lit(v);
    if (x !== undefined && isCount(x) && x < min) this.range("INVALID_COUNT", base, field, x, `>= ${min}`);
  }

  // ── chamfer, pattern, datums ──

  private chamfer(c: Obj, fp: string, ctx: PartCtx): void {
    this.checkRef(c["edges"], `${fp}/edges`, EDGE_SOME, ctx);
    const d2 = has(c, "d2");
    const angle = has(c, "angle");
    const side = has(c, "side");
    if (!((!d2 && !angle && !side) || (d2 && !angle && side) || (!d2 && angle && side))) {
      this.err("CHAMFER_OPTIONS_CONFLICT", fp, "a chamfer is { d }, { d, d2, side } or { d, angle, side }", { fields: ["d", "d2", "angle", "side"] });
    }
    this.positiveLen(fp, "d", c["d"]);
    if (d2) this.positiveLen(fp, "d2", c["d2"]);
    const a = lit(c["angle"]);
    if (a !== undefined && !(a > 0 && a < 90)) this.range("INVALID_VALUE", fp, "angle", a, "in (0, 90)");
    if (side) this.checkRef(c["side"], `${fp}/side`, FACE_ONE, ctx);
  }

  private pattern(p: Obj, fp: string, ctx: PartCtx): void {
    const seed = isObj(p["seed"]) ? p["seed"] : {};
    const featureSeeds = has(seed, "features");
    if (featureSeeds) {
      const seeds = arr(seed["features"]);
      if (seeds.length === 0) this.rangeJson("INVALID_VALUE", `${fp}/seed/features`, "features", [], "a non-empty list");
      seeds.forEach((raw, k) => {
        const sp = `${fp}/seed/features/${k}`;
        const id = str(raw);
        if (!this.reference(id, sp)) return;
        const f = ctx.earlier.get(id);
        if (!f) {
          this.err("UNRESOLVED_FEATURE", sp, `${JSON.stringify(id)} is not the id of an earlier feature of this part studio`, {
            id,
            field: sp,
            expected: ["extrude", "revolve", "hole"],
          });
        } else if (!["extrude", "revolve", "hole"].includes(f.ty)) {
          this.err("PATTERN_SEED_UNSUPPORTED", sp, `a ${f.ty} cannot be a pattern seed (extrude, revolve or hole)`, { seed: id, type: f.ty });
        }
      });
    } else if (has(seed, "bodies")) this.checkRef(seed["bodies"], `${fp}/seed/bodies`, BODY_SOME, ctx);
    const lp = `${fp}/layout`;
    const layout = isObj(p["layout"]) ? p["layout"] : {};
    let twoD = false;
    let counts: [number | undefined, number | undefined] = [undefined, undefined];
    if (has(layout, "linear")) {
      const l = layout["linear"] as Obj;
      const ll = `${lp}/linear`;
      this.dir(l["dir"], `${ll}/dir`, ctx);
      this.countMin(ll, "count", l["count"], 1);
      const s = lit(l["spacing"]);
      if (s !== undefined && Math.abs(s) <= LINEAR_TOLERANCE) this.range("INVALID_VALUE", ll, "spacing", s, `|spacing| ${tolText}`);
      if (has(l, "dir2") !== has(l, "spacing2") || (has(l, "count2") && !has(l, "dir2"))) {
        this.err("PATTERN_OPTIONS_CONFLICT", ll, "a second direction needs dir2 and spacing2 (count2 defaults to 1)", { fields: ["dir2", "count2", "spacing2"] });
      }
      if (has(l, "dir2")) {
        twoD = true;
        this.dir(l["dir2"], `${ll}/dir2`, ctx);
      }
      if (has(l, "count2")) this.countMin(ll, "count2", l["count2"], 1);
      const s2 = lit(l["spacing2"]);
      if (s2 !== undefined && Math.abs(s2) <= LINEAR_TOLERANCE) this.range("INVALID_VALUE", ll, "spacing2", s2, `|spacing2| ${tolText}`);
      counts = [lit(l["count"]), has(l, "count2") ? lit(l["count2"]) : 1];
    } else if (has(layout, "circular")) {
      const c = layout["circular"] as Obj;
      const cp = `${lp}/circular`;
      this.axis(c["axis"], `${cp}/axis`, ctx);
      this.countMin(cp, "count", c["count"], 2);
      const a = lit(has(c, "angle") ? c["angle"] : 360);
      if (a !== undefined && !(a > 0 && a <= 360)) this.range("INVALID_ANGLE", cp, "angle", a, "in (0, 360]");
      counts = [lit(c["count"]), undefined];
    } else if (has(layout, "mirror")) {
      this.plane((layout["mirror"] as Obj)["plane"], `${lp}/mirror/plane`, ctx);
      counts = [2, undefined];
    }
    arr(p["skip"]).forEach((raw, k) => {
      const idx = arr(raw) as number[];
      const sp = `${fp}/skip/${k}`;
      const want = twoD ? 2 : 1;
      const seedIdx = idx.every((i) => i === 0);
      const outOfRange =
        (idx[0] !== undefined && counts[0] !== undefined && idx[0] >= counts[0]) || (twoD && idx[1] !== undefined && counts[1] !== undefined && idx[1] >= counts[1]);
      if (idx.length !== want || seedIdx || outOfRange) {
        this.rangeJson("INVALID_VALUE", sp, "skip", idx, twoD ? "[i, j] of an existing non-seed instance" : "[i] of an existing non-seed instance");
      }
    });
    const op = str(p["op"]) || "new_body";
    const targets = p["targets"];
    if (featureSeeds) {
      if (op !== "new_body" || targets !== undefined) {
        this.err("PATTERN_OPTIONS_CONFLICT", fp, "op and targets apply to body seeds only; feature seeds re-apply their own operation", { fields: ["op", "targets"] });
      }
    } else if (op === "join" && targets === undefined) {
      this.err("BOOLEAN_TARGETS_REQUIRED", `${fp}/targets`, "a body pattern with op join needs targets", { feature: fp });
    } else if (op === "new_body" && targets !== undefined) {
      this.err("PATTERN_OPTIONS_CONFLICT", `${fp}/targets`, "targets are only used with op join", { fields: ["op", "targets"] });
    } else if (targets !== undefined) this.targets(targets, `${fp}/targets`, ctx);
  }

  private modeFields(fp: string, mode: string, present: [string, boolean][], required: readonly string[]): void {
    const missing = required.filter((r) => !present.some(([n, p]) => n === r && p));
    const unexpected = present.filter(([n, p]) => p && !required.includes(n)).map(([n]) => n);
    if (missing.length > 0 || unexpected.length > 0) {
      this.err(
        "DATUM_OPTIONS_CONFLICT",
        fp,
        `mode ${JSON.stringify(mode)} takes ${required.join(", ")}; missing [${missing.join(", ")}], not allowed [${unexpected.join(", ")}]`,
        { mode, fields: required, missing, unexpected },
      );
    }
  }

  private datumPlane(d: Obj, fp: string, ctx: PartCtx): void {
    const keys = ["from", "distance", "axis", "angle", "a", "b", "points", "origin", "normal", "x_dir"];
    const present: [string, boolean][] = keys.map((k) => [k, has(d, k)]);
    const mode = str(d["mode"]);
    const required: Record<string, string[]> = {
      offset: ["from", "distance"],
      angle: ["from", "axis", "angle"],
      midplane: ["a", "b"],
      through: ["points"],
      frame: ["origin", "normal", "x_dir"],
    };
    if (required[mode]) this.modeFields(fp, mode, present, required[mode]!);
    for (const field of ["from", "a", "b"]) if (has(d, field)) this.plane(d[field], `${fp}/${field}`, ctx);
    if (has(d, "axis")) this.axis(d["axis"], `${fp}/axis`, ctx);
    arr(d["points"]).forEach((p, k) => this.point(p, `${fp}/points/${k}`, ctx));
    if (has(d, "origin") && has(d, "normal") && has(d, "x_dir")) this.frame(d["normal"], d["x_dir"], fp);
  }

  private datumAxis(d: Obj, fp: string, ctx: PartCtx): void {
    const keys = ["edge", "face", "a", "b", "points"];
    const present: [string, boolean][] = keys.map((k) => [k, has(d, k)]);
    const mode = str(d["mode"]);
    const required: Record<string, string[]> = { edge: ["edge"], cylinder: ["face"], planes: ["a", "b"], points: ["points"] };
    if (required[mode]) this.modeFields(fp, mode, present, required[mode]!);
    if (has(d, "edge")) this.checkRef(d["edge"], `${fp}/edge`, EDGE_ONE, ctx);
    if (has(d, "face")) this.checkRef(d["face"], `${fp}/face`, FACE_ONE, ctx);
    for (const field of ["a", "b"]) if (has(d, field)) this.plane(d[field], `${fp}/${field}`, ctx);
    arr(d["points"]).forEach((p, k) => this.point(p, `${fp}/points/${k}`, ctx));
  }
}

function holeRow(size: string, field: string): number | null {
  const row = (v1.HOLE_SIZES.sizes as Record<string, Record<string, { value: number } | null>>)[size];
  const cell = row?.[field];
  return cell ? cell.value : null;
}

/** The entity arguments of a constraint, `(argument, id)` in argument order. */
export function constraintArguments(c: Obj): [string, string][] {
  const args: Record<string, string[]> = {
    coincident: ["a", "b"],
    parallel: ["a", "b"],
    perpendicular: ["a", "b"],
    tangent: ["a", "b"],
    equal: ["a", "b"],
    distance: ["a", "b"],
    angle: ["a", "b"],
    horizontal: ["line"],
    vertical: ["line"],
    radius: ["curve"],
    diameter: ["curve"],
    point_on_line: ["point", "line"],
    midpoint: ["point", "line"],
    point_on_circle: ["point", "curve"],
    symmetric: ["a", "b", "line"],
    fix: ["entity"],
  };
  return (args[str(c["type"])] ?? []).map((a) => [a, str(c[a])]);
}

type SolveErr =
  | { kind: "unknown"; arg: string; reference: string }
  | { kind: "wrong"; arg: string; reference: string; expected: string; found: string }
  | { kind: "combination"; what: string; a: string; b: string }
  | { kind: "self"; arg: string; reference: string };

/** forge-solve's reference checks (`system.rs::compile_constraint`), in its order ([W0-9]). */
function checkConstraintRefs(con: Obj, ents: Map<string, Ent>): SolveErr | undefined {
  class Stop extends Error {
    constructor(readonly e: SolveErr) {
      super("stop");
    }
  }
  const ent = (arg: string, id: string): Ent => {
    const e = ents.get(id);
    if (!e) throw new Stop({ kind: "unknown", arg, reference: id });
    return e;
  };
  const want = (arg: string, id: string, ok: Ent[], expected: string): Ent => {
    const e = ent(arg, id);
    if (!ok.includes(e)) throw new Stop({ kind: "wrong", arg, reference: id, expected, found: e });
    return e;
  };
  const point = (arg: string, id: string): Ent => want(arg, id, ["point"], "point");
  const line = (arg: string, id: string): Ent => want(arg, id, ["line"], "line");
  const curve = (arg: string, id: string): Ent => want(arg, id, ["circle", "arc"], "circle or arc");
  const distinct = (a: string, b: string): void => {
    if (a === b) throw new Stop({ kind: "self", arg: "b", reference: b });
  };
  const isCurve = (e: Ent): boolean => e === "circle" || e === "arc";
  const a = str(con["a"]);
  const b = str(con["b"]);
  try {
    switch (con["type"]) {
      case "coincident":
        distinct(a, b);
        point("a", a);
        point("b", b);
        break;
      case "horizontal":
      case "vertical":
        line("line", str(con["line"]));
        break;
      case "parallel":
      case "perpendicular":
      case "angle":
        distinct(a, b);
        line("a", a);
        line("b", b);
        break;
      case "tangent": {
        distinct(a, b);
        const ea = ent("a", a);
        const eb = ent("b", b);
        if (!((ea === "line" && isCurve(eb)) || (isCurve(ea) && eb === "line") || (isCurve(ea) && isCurve(eb)))) {
          return { kind: "combination", what: "tangent", a: ea, b: eb };
        }
        break;
      }
      case "equal": {
        distinct(a, b);
        const ea = ent("a", a);
        const eb = ent("b", b);
        if (!((ea === "line" && eb === "line") || (isCurve(ea) && isCurve(eb)))) return { kind: "combination", what: "equal", a: ea, b: eb };
        break;
      }
      case "distance":
        distinct(a, b);
        point("a", a);
        want("b", b, ["point", "line"], "point or line");
        break;
      case "radius":
      case "diameter":
        curve("curve", str(con["curve"]));
        break;
      case "point_on_line":
      case "midpoint":
        point("point", str(con["point"]));
        line("line", str(con["line"]));
        break;
      case "point_on_circle":
        point("point", str(con["point"]));
        curve("curve", str(con["curve"]));
        break;
      case "symmetric":
        distinct(a, b);
        point("a", a);
        point("b", b);
        line("line", str(con["line"]));
        break;
      case "fix": {
        const entity = str(con["entity"]);
        const e = ent("entity", entity);
        if ((e === "line" || e === "circle") && (has(con, "x") || has(con, "y"))) {
          return { kind: "wrong", arg: "entity", reference: entity, expected: "point (x/y targets)", found: e };
        }
        if (e === "arc") return { kind: "wrong", arg: "entity", reference: entity, expected: "point, line or circle (fix an arc's points)", found: "arc" };
        break;
      }
      default:
        break;
    }
  } catch (e) {
    if (e instanceof Stop) return e.e;
    throw e;
  }
  return undefined;
}

// ─── Expression checks (W1's hook in Rust) ───────────────────────────────────────────────────

interface ParamDecl {
  name: string;
  unit: ParamUnit;
  /** undefined = document parameter. */
  part: number | undefined;
  path: string;
  exprs: { path: string; text: string }[];
}

function collectParams(doc: Obj): ParamDecl[] {
  const out: ParamDecl[] = [];
  const add = (p: unknown, pp: string, part: number | undefined): void => {
    if (!isObj(p)) return;
    const unit = (PARAM_UNITS.includes(str(p["unit"])) ? p["unit"] : "mm") as ParamUnit;
    const exprs: { path: string; text: string }[] = [];
    for (const k of ["value", "min", "max"]) if (typeof p[k] === "string") exprs.push({ path: `${pp}/${k}`, text: p[k] as string });
    out.push({ name: str(p["name"]), unit, part, path: pp, exprs });
  };
  arr(doc["params"]).forEach((p, i) => add(p, `/params/${i}`, undefined));
  arr(doc["parts"]).forEach((part, pi) => {
    if (isObj(part)) arr(part["params"]).forEach((p, i) => add(p, `/parts/${pi}/params/${i}`, pi));
  });
  return out;
}

/** The environment of a scope (§2.8). */
function scopeEnv(doc: Obj, params: ParamDecl[], scope: ExprScope, featureNames: ReadonlySet<string>): TypeEnv {
  const partName = (i: number): string => {
    const p = arr(doc["parts"])[i];
    return isObj(p) ? str(p["name"]) : "";
  };
  const visible = params.filter((p) => p.part === undefined || (scope.kind === "part" && p.part === scope.index));
  return {
    lookup: (name): NameInfo => {
      const own = scope.kind === "part" ? params.find((p) => p.name === name && p.part === scope.index) : undefined;
      if (own) return { kind: "param", unit: own.unit };
      const docParam = params.find((p) => p.name === name && p.part === undefined);
      if (docParam) return { kind: "param", unit: docParam.unit };
      if (scope.kind === "part") {
        const other = params.find((p) => p.name === name && p.part !== undefined);
        if (other) return { kind: "other-part", part: partName(other.part!) };
      }
      if (featureNames.has(name)) return { kind: "feature" };
      return { kind: "unknown" };
    },
    names: () => visible.map((p) => p.name),
  };
}

function checkExpressions(doc: Obj, sites: ExprSite[], opts: V1ValidateOptions): V1ValidationError[] {
  const errs: V1ValidationError[] = [];
  const params = collectParams(doc);
  const featureNames = new Set<string>();
  for (const part of arr(doc["parts"])) if (isObj(part)) for (const f of arr(part["features"])) if (isObj(f)) featureNames.add(str(f["name"]));
  const envs = new Map<string, TypeEnv>();
  const envFor = (scope: ExprScope): TypeEnv => {
    const key = scope.kind === "doc" ? "doc" : `part:${scope.index}`;
    let e = envs.get(key);
    if (!e) envs.set(key, (e = scopeEnv(doc, params, scope, featureNames)));
    return e;
  };
  const asts = new Map<string, Expr>();
  for (const site of sites) {
    // Empty and over-long texts are W0's EXPR_SYNTAX (reported structurally).
    if (site.text.trim().length === 0 || byteLength(site.text) > MAX_EXPR_BYTES) continue;
    const parsed = parseExpr(site.text);
    if (!parsed.ok) {
      const details: Obj = { offset: parsed.problem.offset, expected: parsed.problem.expected };
      if (parsed.problem.lexes) details["expr"] = site.text;
      errs.push({ code: "EXPR_SYNTAX", path: site.path, message: parsed.problem.message, details });
      continue;
    }
    const ast = opts.exprAst?.(site.path) ?? parsed.ast;
    asts.set(site.path, ast);
    const r = checkAtField(ast, site.field, envFor(site.scope));
    if (!r.ok) errs.push({ code: r.problem.code, path: site.path, message: r.problem.message, details: r.problem.details, exprNode: r.problem.node });
  }
  errs.push(...paramCycles(params, asts));
  return errs;
}

/** `PARAM_CYCLE` (§2.8 rule 3): one error per cycle, at its first parameter in declaration order. */
function paramCycles(params: ParamDecl[], asts: Map<string, Expr>): V1ValidationError[] {
  const index = new Map<string, number>();
  params.forEach((p, i) => {
    // A name resolves to the part's own parameter first, then the document's (§2.8).
    const key = `${p.part ?? "doc"}:${p.name}`;
    if (!index.has(key)) index.set(key, i);
  });
  const resolve = (from: ParamDecl, name: string): number | undefined =>
    (from.part !== undefined ? index.get(`${from.part}:${name}`) : undefined) ?? index.get(`doc:${name}`);
  const edges: number[][] = params.map((p) => {
    const out: number[] = [];
    for (const e of p.exprs) {
      const ast = asts.get(e.path);
      if (!ast) continue;
      for (const n of namesOf(ast)) {
        const j = resolve(p, n);
        if (j !== undefined && !out.includes(j)) out.push(j);
      }
    }
    return out;
  });
  // Tarjan's strongly connected components (iterative), then report cyclic ones.
  const n = params.length;
  const idx = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stack: number[] = [];
  const comps: number[][] = [];
  let counter = 0;
  for (let s = 0; s < n; s++) {
    if (idx[s] !== -1) continue;
    const work: [number, number][] = [[s, 0]];
    while (work.length > 0) {
      const top = work[work.length - 1]!;
      const [v, ei] = top;
      if (ei === 0 && idx[v] === -1) {
        idx[v] = low[v] = counter++;
        stack.push(v);
        onStack[v] = true;
      }
      if (ei < edges[v]!.length) {
        top[1]++;
        const w = edges[v]![ei]!;
        if (idx[w] === -1) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v]!, idx[w]!);
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]![0];
        low[parent] = Math.min(low[parent]!, low[v]!);
      }
      if (low[v] === idx[v]) {
        const comp: number[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack[w] = false;
          comp.push(w);
          if (w === v) break;
        }
        comps.push(comp);
      }
    }
  }
  const out: V1ValidationError[] = [];
  for (const comp of comps) {
    const cyclic = comp.length > 1 || edges[comp[0]!]!.includes(comp[0]!);
    if (!cyclic) continue;
    const first = Math.min(...comp);
    // The cycle's names in dependency order, starting from its first parameter.
    const cycle: string[] = [params[first]!.name];
    let at = first;
    const inComp = new Set(comp);
    for (let guard = 0; guard < comp.length; guard++) {
      const next = edges[at]!.filter((j) => inComp.has(j)).sort((a, b) => a - b)[0];
      if (next === undefined || next === first) break;
      if (cycle.includes(params[next]!.name)) break;
      cycle.push(params[next]!.name);
      at = next;
    }
    const p = params[first]!;
    const path = p.exprs.find((e) => e.path.endsWith("/value"))?.path ?? p.exprs[0]?.path ?? `${p.path}/value`;
    out.push({ code: "PARAM_CYCLE", path, message: `parameter cycle: ${[...cycle, cycle[0]].join(" → ")}`, details: { cycle } });
  }
  return out;
}

// ─── Entry points ────────────────────────────────────────────────────────────────────────────

/**
 * Validate a (typed) v1 document: structural checks, W0's generic Scalar checks and, unless
 * disabled, the expression checks. Returns every problem found (empty when valid).
 */
export function validateV1(doc: v1.IrDocument, opts: V1ValidateOptions = {}): V1ValidationError[] {
  const raw = doc as unknown as Obj;
  const v = new Validator(raw, opts);
  v.document();
  const w = new Walker().walkDocument(raw);
  for (const s of w.exprs) {
    if (s.text.trim().length === 0) {
      v.errs.push({ code: "EXPR_SYNTAX", path: s.path, message: "empty expression", details: { offset: 0, expected: "an expression", length: byteLength(s.text) } });
    } else if (byteLength(s.text) > MAX_EXPR_BYTES) {
      v.errs.push({
        code: "EXPR_SYNTAX",
        path: s.path,
        message: `expression longer than ${MAX_EXPR_BYTES} bytes`,
        details: { offset: MAX_EXPR_BYTES, expected: "at most 4096 bytes", length: byteLength(s.text) },
      });
    }
  }
  for (const l of w.literals) {
    if (!Number.isFinite(l.value)) v.errs.push({ code: "NON_FINITE", path: l.path, message: "literal values must be finite", details: { field: l.path } });
    else if (l.field === "count" && !isCount(l.value)) {
      v.errs.push({
        code: "EXPR_NOT_INTEGER",
        path: l.path,
        message: `a count must be an exact integer with |v| <= 2^31, got ${fmt(l.value)}`,
        details: { expr: l.value, value: l.value },
      });
    }
  }
  if (opts.expressions !== false) v.errs.push(...checkExpressions(raw, w.exprs, opts));
  return v.errs;
}

export type LoadResult =
  | { ok: true; doc: v1.IrDocument; version: 0 | 1; migration?: MigrationReport }
  | { ok: false; version: 0 | 1 | undefined; errors: V1ValidationError[]; parseError?: { path?: string; message: string } };

/**
 * The rejection pipeline of SPEC-v1 §0.5 rule 4 for a parsed JSON value of either version:
 * `aicad.ir/0` → v0 validation (v0 codes and paths), then migration; `aicad.ir/1` → raw
 * pre-checks, typed parse, structural and expression validation; anything else →
 * `UNSUPPORTED_SCHEMA`.
 */
export function loadIrDocument(raw: unknown, opts: V1ValidateOptions = {}): LoadResult {
  const schema = isObj(raw) ? raw["schema"] : undefined;
  if (schema === "aicad.ir/0") {
    let v0: V0Document;
    try {
      v0 = parseV0Document(raw);
    } catch (e) {
      return { ok: false, version: 0, errors: [], parseError: { message: (e as Error).message } };
    }
    const errors = validateV0(v0);
    if (errors.length > 0) return { ok: false, version: 0, errors: errors.map((e) => ({ ...e, details: {} })) };
    const { doc, report } = migrateV0ToV1Report(v0);
    return { ok: true, doc, version: 0, migration: report };
  }
  if (schema !== v1.IR_SCHEMA) {
    return {
      ok: false,
      version: undefined,
      errors: [{ code: "UNSUPPORTED_SCHEMA", path: "/schema", message: `unsupported schema ${shownValue(schema)}`, details: { found: shownValue(schema), supported: ["aicad.ir/0", v1.IR_SCHEMA] } }],
    };
  }
  const pre = precheckV1(raw);
  if (pre.parse) return { ok: false, version: 1, errors: [], parseError: pre.parse };
  if (pre.errors.length > 0) return { ok: false, version: 1, errors: pre.errors };
  const float = floatInU32Field(raw);
  if (float) {
    return {
      ok: false,
      version: 1,
      errors: [],
      parseError: { path: float.path, message: `invalid IR v1 document: ${float.path}: invalid type: floating point \`${formatF64(float.value)}\`, expected u32` },
    };
  }
  const parsed = v1.IrDocumentSchema.safeParse(raw);
  // The JSON Schema bounds an instance index to 1–2 entries, but forge-ir's serde parse does
  // not: Rust reports such an index as QUERY_INVALID at validation (queries/typing.json). Mirror
  // Rust: array-length issues of `instance.index` are not parse errors.
  const issues = parsed.success
    ? []
    : parsed.error.issues.filter((i) => !((i.code === "too_small" || i.code === "too_big") && i.path[i.path.length - 1] === "index"));
  if (issues.length > 0) {
    const message = issues.map((i) => `${i.path.map((p) => `/${String(p)}`).join("") || "/"}: ${i.message}`).join("; ");
    return { ok: false, version: 1, errors: [], parseError: { message: `invalid IR v1 document: ${message}` } };
  }
  const doc = raw as v1.IrDocument;
  const errors = validateV1(doc, opts);
  return errors.length > 0 ? { ok: false, version: 1, errors } : { ok: true, doc, version: 1 };
}

/**
 * {@link loadIrDocument} of JSON **text**, read as forge-ir reads it (`parseIrJsonText`: the
 * serde_json pass, then the strict v1 reader or serde_json's v0 typed parse): the whole of
 * `forge_ir::VersionedDocument::from_json` followed by the v1 migration. A text the readers reject
 * is a `parseError` whose message carries the byte offset.
 */
export function loadIrText(text: string, opts: V1ValidateOptions = {}): LoadResult {
  let raw: unknown;
  try {
    raw = parseIrJsonText(text);
  } catch (e) {
    if (!(e instanceof JsonTextError)) throw e;
    return { ok: false, version: undefined, errors: [], parseError: { message: e.message } };
  }
  return loadIrDocument(raw, opts);
}
