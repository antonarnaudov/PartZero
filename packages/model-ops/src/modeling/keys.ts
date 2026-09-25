/**
 * Provenance keys (SPEC-v1 §5.2) as the viewport, the selection and the agent see them, turned
 * into IR v1 references (§5.1, §5.3). This is the host-free half of C1's `refFor`: a picked face,
 * edge, vertex or body becomes a **named** query over the entity's provenance (`cap`, `side`,
 * `endcap`, `hole_face`, `between`, `body`), never coordinates or engine ids, so the reference
 * follows upstream edits. The engine then checks that it resolves (a tool's preview evaluates the
 * candidate document: an ambiguous or dangling reference fails there with its `REF_*` code).
 *
 * Names the render mesh carries drop the qualifiers (`e1/cap:end`, `h1/wall`), and a display index
 * `#k` marks split pieces; both forms are accepted. Keys may also name features by their name
 * (`slab/cap:end`, the report's display names): {@link featureIdOf} maps names back to ids.
 */
import type { DocJson, FeatureJson } from "../doc.js";
import { CommandEngineError } from "../engine.js";

/** The characters a key escapes as `%XX` (forge-core `KEY_ESCAPED_CHARS`). */
const ESCAPED = new Set(["/", ":", "{", "}", "|", "+", "#", "@", "%"]);

export interface KeyParts {
  /** The feature id (or name, as written; unescaped). */
  feature: string;
  /** The role label: `cap`, `side`, `endcap`, `edge`, `vertex`, `wall`, `blend`, `body`, … */
  label: string;
  /** `:leaf` (one), `:leaf+leaf` (several). */
  leaves: string[];
  /** `:{k|k…}` nested keys, verbatim. */
  keys: string[];
  /** The qualifier after `@` (unescaped), when present. */
  qualifier: string | null;
}

function unescape(s: string): string {
  if (!s.includes("%")) return s;
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%" && /^[0-9A-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      for (const b of new TextEncoder().encode(s[i]!)) bytes.push(b);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Escape an id for a key (SPEC-v1 §5.2 rule 5). */
export function escapeKeyId(id: string): string {
  let out = "";
  for (const c of id) {
    if (ESCAPED.has(c) || /\s/.test(c)) for (const b of new TextEncoder().encode(c)) out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    else out += c;
  }
  return out;
}

/** Drop a display index (`#2`) from a render name. */
export function stripIndex(name: string): string {
  return name.replace(/#\d+$/, "");
}

/**
 * Parse a key or a render name: `fid "/" label [ ":" ( leaf | "{" key ( "|" key )* "}" ) ] [ "@" qual ]`.
 * Returns null when it is not one.
 */
export function parseKey(raw: string): KeyParts | null {
  const key = stripIndex(raw.trim());
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  const feature = unescape(key.slice(0, slash));
  const rest = key.slice(slash + 1);
  let labelEnd = rest.length;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === ":" || rest[i] === "@") {
      labelEnd = i;
      break;
    }
  }
  const label = unescape(rest.slice(0, labelEnd));
  if (!label) return null;
  let i = labelEnd;
  const leaves: string[] = [];
  const keys: string[] = [];
  if (rest[i] === ":") {
    i++;
    if (rest[i] === "{") {
      let depth = 0;
      let start = i + 1;
      let end = -1;
      for (let j = i; j < rest.length; j++) {
        const c = rest[j];
        if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            keys.push(rest.slice(start, j));
            end = j + 1;
            break;
          }
        } else if (c === "|" && depth === 1) {
          keys.push(rest.slice(start, j));
          start = j + 1;
        }
      }
      if (end < 0 || keys.some((k) => k === "")) return null;
      i = end;
    } else {
      const at = rest.indexOf("@", i);
      const leafEnd = at < 0 ? rest.length : at;
      for (const part of rest.slice(i, leafEnd).split("+")) {
        if (!part) return null;
        leaves.push(unescape(part));
      }
      i = leafEnd;
    }
  }
  let qualifier: string | null = null;
  if (rest[i] === "@") {
    qualifier = unescape(rest.slice(i + 1));
    if (!qualifier) return null;
  } else if (i !== rest.length) return null;
  return { feature, label, leaves, keys, qualifier };
}

/** Every feature of the document with its part. */
export function allFeatureEntries(doc: DocJson): Array<{ part: string; partName: string; feature: FeatureJson }> {
  return doc.parts.flatMap((p) => p.features.map((f) => ({ part: p.id, partName: p.name, feature: f })));
}

/** A feature's id from its id or name; null when there is none. */
export function featureIdOf(doc: DocJson, idOrName: string): string | null {
  const all = allFeatureEntries(doc);
  return all.find((e) => e.feature.id === idOrName)?.feature.id ?? all.find((e) => e.feature.name === idOrName)?.feature.id ?? null;
}

export function featureOf(doc: DocJson, idOrName: string): FeatureJson | null {
  const id = featureIdOf(doc, idOrName);
  return id === null ? null : (allFeatureEntries(doc).find((e) => e.feature.id === id)?.feature ?? null);
}

/** A structured refusal of a modeling tool's argument (`field` names the input). */
export function argError(field: string, message: string, code = "MODEL_INVALID_ARG", details: Record<string, unknown> = {}): CommandEngineError {
  return new CommandEngineError(code, message, [], { field, ...details });
}

export type QueryJson = Record<string, unknown>;

/**
 * The named face query of a face key (SPEC-v1 §5.3 sources): `cap`, `endcap`, `side`,
 * `hole_face`. `hole` supplies the position id a render name dropped (see {@link HoleInstanceHint}).
 * Null when the face has no named source (a blend, an offset, a copy): such faces are not
 * references a tool can write yet.
 */
export function faceQuery(doc: DocJson, key: string, hole?: (feature: string) => string | null): QueryJson | null {
  const k = parseKey(key);
  if (!k) return null;
  const f = featureOf(doc, k.feature);
  if (!f) return null;
  const leaf = k.leaves[0];
  switch (k.label) {
    case "cap":
      if (f.type !== "extrude" || (leaf !== "start" && leaf !== "end")) return null;
      return { op: "cap", feature: f.id, end: leaf, ...(k.qualifier ? { member: k.qualifier } : {}) };
    case "endcap":
      if (f.type !== "revolve" || (leaf !== "start" && leaf !== "end")) return null;
      return { op: "endcap", feature: f.id, end: leaf, ...(k.qualifier ? { member: k.qualifier } : {}) };
    case "side":
      if ((f.type !== "extrude" && f.type !== "revolve") || !leaf) return null;
      return { op: "side", feature: f.id, curve: leaf };
    case "wall":
    case "tip":
    case "floor":
    case "cbore_wall":
    case "cbore_floor":
    case "csink": {
      if (f.type !== "hole") return null;
      const at = k.qualifier ?? hole?.(f.id) ?? null;
      if (!at) return null;
      return { op: "hole_face", feature: f.id, at, part: k.label };
    }
    default:
      return null;
  }
}

/** The face reference `{ kind: "face", q, card: "one" }` of a face key, or a refusal naming `field`. */
export function faceRef(doc: DocJson, key: string, field: string, hole?: (feature: string) => string | null): QueryJson {
  const q = faceQuery(doc, key, hole);
  if (!q) throw argError(field, `${key} is not a face a tool can reference yet (use a cap, a side face or a hole face)`, "MODEL_UNSUPPORTED_FACE", { key });
  return { kind: "face", q, card: "one" };
}

/** An edge key `F/edge:{A|B}` (any `F`) as `between(a, b)` of its two faces. */
export function edgeQuery(doc: DocJson, key: string, hole?: (feature: string) => string | null): QueryJson | null {
  const k = parseKey(key);
  if (!k || k.label !== "edge" || k.keys.length !== 2) return null;
  const a = faceQuery(doc, k.keys[0]!, hole);
  const b = faceQuery(doc, k.keys[1]!, hole);
  if (!a || !b) return null;
  return { op: "between", a, b };
}

export function edgeRef(doc: DocJson, key: string, field: string, hole?: (feature: string) => string | null): QueryJson {
  const q = edgeQuery(doc, key, hole);
  if (!q) throw argError(field, `${key} is not an edge a tool can reference yet (an edge between two named faces)`, "MODEL_UNSUPPORTED_EDGE", { key });
  return { kind: "edge", q, card: "one" };
}

/**
 * A derived vertex key (`vertex:{e1|e2|…}`, the selection's name for a vertex: its incident edges)
 * as the vertex shared by two of its edges: `intersect(vertices(e1), vertices(e2))`.
 */
export function vertexQuery(doc: DocJson, key: string, hole?: (feature: string) => string | null): QueryJson | null {
  const m = /^vertex:\{(.*)\}$/.exec(key.trim());
  let edges: string[];
  if (m) {
    edges = splitTop(m[1]!);
  } else {
    const k = parseKey(key);
    if (!k || k.label !== "vertex") return null;
    edges = k.keys;
  }
  const qs = edges.map((e) => edgeQuery(doc, e, hole)).filter((q): q is QueryJson => q !== null);
  if (qs.length < 2) return null;
  return { op: "intersect", of: qs.slice(0, 2).map((q) => ({ op: "vertices", of: q })) };
}

/** Split `a|b|c` at top-level bars (keys nest braces). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "|" && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.filter((x) => x.length > 0);
}

/** Report bodies, as the render mesh names them (`part/feature[#k]`, canonical order). */
export interface ReportBodyLike {
  origin: { feature: string; member: string; instance?: readonly number[] | undefined };
}

export interface ReportLike {
  parts?: ReadonlyArray<{ part: string; part_id?: string; bodies: readonly ReportBodyLike[] }>;
  features?: ReadonlyArray<Record<string, unknown> & { feature_id: string; type: string; status: string }>;
}

/**
 * A body by its render name (`plate/slab`, `plate/slab#1`), its key (`e1/body:outline.bottom`), or a
 * feature id or name (every body that feature made): `{ op: "body", feature, member? }`.
 */
export function bodyQuery(doc: DocJson, name: string, report: ReportLike | null): QueryJson | null {
  const k = parseKey(name);
  if (k && k.label === "body") {
    const id = featureIdOf(doc, k.feature);
    if (!id) return null;
    return { op: "body", feature: id, ...(k.leaves[0] ? { member: k.leaves[0] } : {}) };
  }
  const direct = featureIdOf(doc, name);
  if (direct) return { op: "body", feature: direct };
  const m = /^(.*)\/([^/#]+)(?:#(\d+))?$/.exec(name.trim());
  if (!m) return null;
  const [, partName, featureName, index] = m;
  const part = doc.parts.find((p) => p.name === partName || p.id === partName);
  const f = part?.features.find((x) => x.name === featureName || x.id === featureName);
  if (!part || !f) return null;
  if (index === undefined) return { op: "body", feature: f.id };
  const rp = report?.parts?.find((p) => p.part === part.name || p.part_id === part.id);
  const same = (rp?.bodies ?? []).filter((b) => b.origin.feature === f.id);
  const b = same[Number(index)];
  if (!b || b.origin.instance?.length) return { op: "body", feature: f.id };
  return { op: "body", feature: f.id, member: b.origin.member };
}

/** A body reference (card `some`) over several bodies: one `body` query, or their union. */
export function bodiesRef(doc: DocJson, names: readonly string[], report: ReportLike | null, field: string): QueryJson {
  const qs: QueryJson[] = [];
  const seen = new Set<string>();
  for (const n of names) {
    const q = bodyQuery(doc, n, report);
    if (!q) throw argError(field, `there is no body ${JSON.stringify(n)} (name a body as the viewport shows it, e.g. part/extrude1, or the feature that made it)`, "MODEL_UNKNOWN_BODY", { body: n });
    const s = JSON.stringify(q);
    if (!seen.has(s)) {
      seen.add(s);
      qs.push(q);
    }
  }
  if (qs.length === 0) throw argError(field, "pick at least one body", "MODEL_MISSING_ARG");
  return { kind: "body", q: qs.length === 1 ? qs[0]! : { op: "union", of: qs } };
}

/**
 * The provenance name a named face query designates (the inverse of {@link faceQuery}), for showing
 * an existing feature's face reference as a pick: `cap` → `F/cap:end`, `side` → `F/side:c`,
 * `endcap`, `hole_face` → `H/wall@p`. Null for any other query.
 */
export function keyOfFaceQuery(q: unknown): string | null {
  if (typeof q !== "object" || q === null) return null;
  const o = q as Record<string, unknown>;
  const f = typeof o["feature"] === "string" ? escapeKeyId(o["feature"]) : null;
  if (!f) return null;
  switch (o["op"]) {
    case "cap":
    case "endcap":
      return typeof o["end"] === "string" ? `${f}/${o["op"]}:${o["end"]}${typeof o["member"] === "string" ? `@${escapeKeyId(o["member"])}` : ""}` : null;
    case "side":
      return typeof o["curve"] === "string" ? `${f}/side:${escapeKeyId(o["curve"])}` : null;
    case "hole_face":
      return typeof o["part"] === "string" && typeof o["at"] === "string" ? `${f}/${o["part"]}@${escapeKeyId(o["at"])}` : null;
    default:
      return null;
  }
}

/** The pick a PlaneRef designates: `XY`, a datum's id, or a face's name (null when it has no simple pick). */
export function pickOfPlaneRef(plane: unknown): string | null {
  if (plane === "XY" || plane === "XZ" || plane === "YZ") return plane;
  if (typeof plane !== "object" || plane === null) return null;
  const p = plane as Record<string, unknown>;
  if (typeof p["datum"] === "string") return p["datum"];
  const face = p["face"] as { q?: unknown } | undefined;
  return face ? keyOfFaceQuery(face.q) : null;
}

/** Named origin planes and axes. */
export const ORIGIN_PLANES = ["XY", "XZ", "YZ"] as const;
export const ORIGIN_AXES = ["X", "Y", "Z"] as const;

/**
 * A PlaneRef (SPEC-v1 §3.1) from a plane-like pick: an origin plane (`XY`), a datum plane (its id or
 * name, or `datum:<id>`), or a planar face key.
 */
export function planeRef(doc: DocJson, pick: string, field: string, hole?: (feature: string) => string | null): unknown {
  const p = pick.trim();
  if ((ORIGIN_PLANES as readonly string[]).includes(p.toUpperCase())) return p.toUpperCase();
  const datum = p.startsWith("datum:") ? p.slice(6) : p;
  const f = featureOf(doc, datum);
  if (f && f.type === "datum_plane") return { datum: f.id };
  if (f && !p.includes("/")) throw argError(field, `${f.name} is a ${f.type}, not a plane`, "MODEL_NOT_A_PLANE", { pick: p });
  return { face: faceRef(doc, p, field, hole) };
}

/**
 * An AxisRef (SPEC-v1 §3.2) from an axis-like pick: an origin axis (`X`), a datum axis, a line or
 * circle edge key, or a cylindrical face key.
 */
export function axisRef(doc: DocJson, pick: string, field: string, hole?: (feature: string) => string | null): unknown {
  const p = pick.trim();
  if ((ORIGIN_AXES as readonly string[]).includes(p.toUpperCase())) return p.toUpperCase();
  const datum = p.startsWith("datum:") ? p.slice(6) : p;
  const f = featureOf(doc, datum);
  if (f && f.type === "datum_axis") return { datum: f.id };
  const k = parseKey(p);
  if (k?.label === "edge") return { edge: edgeRef(doc, p, field, hole) };
  if (k) return { cylinder: faceRef(doc, p, field, hole) };
  throw argError(field, `${p} is not an axis (an origin axis X/Y/Z, a datum axis, a straight or circular edge, or a cylindrical face)`, "MODEL_NOT_AN_AXIS", { pick: p });
}
