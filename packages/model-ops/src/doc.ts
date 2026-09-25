/**
 * Plain-JSON helpers over an `aicad.ir/1` document, for the catalogue's structural ops. They never
 * decide validity: the engine's rejection pipeline does (`canonicalize`, see `ops.ts`). They only
 * locate things (features, parameters, JSON pointers) and pick free ids.
 */
import { CommandEngineError } from "./engine.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = Record<string, unknown>;

export interface DocJson extends JsonObject {
  schema: string;
  params?: JsonObject[];
  parts: PartJson[];
}

export interface PartJson extends JsonObject {
  id: string;
  name: string;
  params?: JsonObject[];
  features: FeatureJson[];
}

export interface FeatureJson extends JsonObject {
  id: string;
  name: string;
  type: string;
}

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a document's JSON text (the store's text is canonical, so this never fails on it). */
export function parseDoc(text: string): DocJson {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new CommandEngineError("IR_PARSE_ERROR", `the document is not JSON: ${(e as Error).message}`);
  }
  if (!isObject(v) || !Array.isArray(v["parts"])) throw new CommandEngineError("IR_PARSE_ERROR", "the document has no parts list");
  return v as DocJson;
}

export interface FeatureLocation {
  partIndex: number;
  index: number;
  part: PartJson;
  feature: FeatureJson;
}

/** A feature by id (preferred) or name. */
export function locateFeature(doc: DocJson, idOrName: string): FeatureLocation | null {
  for (const byName of [false, true]) {
    for (let partIndex = 0; partIndex < doc.parts.length; partIndex++) {
      const part = doc.parts[partIndex]!;
      const index = part.features.findIndex((f) => (byName ? f.name : f.id) === idOrName);
      if (index >= 0) return { partIndex, index, part, feature: part.features[index]! };
    }
  }
  return null;
}

/** A feature by id or name, or `COMMAND_UNKNOWN_FEATURE` naming the features there are. */
export function requireFeature(doc: DocJson, idOrName: string): FeatureLocation {
  const loc = locateFeature(doc, idOrName);
  if (loc) return loc;
  const all = allFeatures(doc).map((f) => f.id);
  throw new CommandEngineError(
    "COMMAND_UNKNOWN_FEATURE",
    `there is no feature ${safeId(idOrName)}${all.length ? ` (features: ${all.slice(0, 30).join(", ")}${all.length > 30 ? ", …" : ""})` : " (the document has no features)"}`,
    [],
    { feature: safeId(idOrName), features: all },
  );
}

/** A part by id or name; `undefined` picks the first part. */
export function requirePart(doc: DocJson, idOrName: string | undefined): { part: PartJson; partIndex: number } {
  if (doc.parts.length === 0) throw new CommandEngineError("COMMAND_UNKNOWN_PART", "the document has no parts");
  if (idOrName === undefined) return { part: doc.parts[0]!, partIndex: 0 };
  let i = doc.parts.findIndex((p) => p.id === idOrName);
  if (i < 0) i = doc.parts.findIndex((p) => p.name === idOrName);
  if (i < 0) {
    throw new CommandEngineError("COMMAND_UNKNOWN_PART", `there is no part ${safeId(idOrName)} (parts: ${doc.parts.map((p) => p.id).join(", ")})`, [], {
      part: safeId(idOrName),
      parts: doc.parts.map((p) => p.id),
    });
  }
  return { part: doc.parts[i]!, partIndex: i };
}

export function allFeatures(doc: DocJson): FeatureJson[] {
  return doc.parts.flatMap((p) => p.features);
}

export interface ParamLocation {
  /** `undefined`: a document-level parameter. */
  partIndex: number | undefined;
  index: number;
  list: JsonObject[];
  param: JsonObject;
}

export function allParams(doc: DocJson): ParamLocation[] {
  const out: ParamLocation[] = [];
  (doc.params ?? []).forEach((param, index) => out.push({ partIndex: undefined, index, list: doc.params!, param }));
  doc.parts.forEach((p, partIndex) => (p.params ?? []).forEach((param, index) => out.push({ partIndex, index, list: p.params!, param })));
  return out;
}

export function locateParam(doc: DocJson, name: string): ParamLocation | null {
  return allParams(doc).find((l) => l.param["name"] === name) ?? null;
}

export function requireParam(doc: DocJson, name: string): ParamLocation {
  const loc = locateParam(doc, name);
  if (loc) return loc;
  const names = allParams(doc).map((l) => String(l.param["name"]));
  throw new CommandEngineError(
    "COMMAND_UNKNOWN_PARAM",
    `there is no parameter ${safeId(name)}${names.length ? ` (parameters: ${names.join(", ")})` : " (the document has no parameters)"}`,
    [],
    { param: safeId(name), params: names },
  );
}

/** Every id and name the document uses (features, parts, parameters): a new id or name avoids them. */
export function takenNames(doc: DocJson): Set<string> {
  const out = new Set<string>();
  for (const p of doc.parts) {
    out.add(p.id);
    out.add(p.name);
    for (const f of p.features) {
      out.add(f.id);
      out.add(f.name);
    }
  }
  for (const l of allParams(doc)) out.add(String(l.param["name"]));
  return out;
}

/** C9: the first free `<type><n>` (`extrude1`, `fillet2`, …; `datum_plane` → `datum_plane1`). */
export function nextFeatureId(doc: DocJson, type: string, extraTaken: Iterable<string> = []): string {
  const taken = takenNames(doc);
  for (const t of extraTaken) taken.add(t);
  const base = /^[A-Za-z_][A-Za-z0-9_]*$/.test(type) ? type : "feature";
  for (let n = 1; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
}

const ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** An id for messages: ids that fail the id grammar are never echoed (SPEC-v1 §0.3 rule 1, "no echo"). */
export function safeId(s: string): string {
  return ID.test(s) && s.length <= 64 ? s : `<an id of ${s.length} characters>`;
}

// ─── JSON pointers ────────────────────────────────────────────────────────────────────────────

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** `/a/b~1c` → `["a", "b/c"]` (RFC 6901). */
export function parsePointer(path: string): string[] {
  if (!path.startsWith("/") || path === "/") {
    throw new CommandEngineError("COMMAND_BAD_PATH", `"${path.slice(0, 80)}" is not a JSON pointer into the feature (like "/distance")`, [], { path: path.slice(0, 200) });
  }
  return path
    .slice(1)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => {
      if (RESERVED_KEYS.has(s)) throw new CommandEngineError("COMMAND_BAD_PATH", `"${path.slice(0, 80)}" names a reserved key`, [], { path: path.slice(0, 200) });
      return s;
    });
}

export function formatPointer(segments: readonly string[]): string {
  return segments.map((s) => `/${s.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/** The value at `segments` under `root`, or `undefined`. */
export function getAt(root: unknown, segments: readonly string[]): unknown {
  let node: unknown = root;
  for (const seg of segments) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(seg)) return undefined;
      node = node[Number(seg)];
    } else if (isObject(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) return undefined;
      node = node[seg];
    } else {
      return undefined;
    }
  }
  return node;
}

/**
 * Set (or with `value === undefined`, remove) the value at `segments` under `root`. The parent must
 * exist; an array index must be inside the array, or `-` / the length to append.
 */
export function setAt(root: JsonObject, segments: readonly string[], value: unknown, what: string): void {
  let node: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = getAt(node, [segments[i]!]);
    if (typeof next !== "object" || next === null) {
      throw new CommandEngineError("COMMAND_BAD_PATH", `${what} has nothing at ${formatPointer(segments.slice(0, i + 1))}`, [], { path: formatPointer(segments) });
    }
    node = next;
  }
  const last = segments[segments.length - 1]!;
  if (Array.isArray(node)) {
    const append = last === "-" || last === String(node.length);
    const i = append ? node.length : Number(last);
    if (!append && (!/^\d+$/.test(last) || i >= node.length)) {
      throw new CommandEngineError("COMMAND_BAD_PATH", `${what}: index ${last.slice(0, 20)} is outside ${formatPointer(segments.slice(0, -1))} (length ${node.length})`, [], {
        path: formatPointer(segments),
      });
    }
    if (value === undefined) {
      if (append) throw new CommandEngineError("COMMAND_BAD_PATH", `${what}: nothing to remove at ${formatPointer(segments)}`, [], { path: formatPointer(segments) });
      node.splice(i, 1);
    } else if (append) node.push(value);
    else node[i] = value;
    return;
  }
  const obj = node as JsonObject;
  if (value === undefined) delete obj[last];
  else obj[last] = value;
}

/** `/parts/2/features/5/distance` → `{ partIndex: 2, index: 5, rest: "/distance" }`. */
export function featureOfPath(path: string): { partIndex: number; index: number; rest: string } | null {
  const m = /^\/parts\/(\d+)\/features\/(\d+)(\/.*)?$/.exec(path);
  return m ? { partIndex: Number(m[1]), index: Number(m[2]), rest: m[3] ?? "" } : null;
}

/** `/params/1/value` or `/parts/0/params/2/min` → the parameter's location. */
export function paramOfPath(path: string): { partIndex: number | undefined; index: number; rest: string } | null {
  const d = /^\/params\/(\d+)(\/.*)?$/.exec(path);
  if (d) return { partIndex: undefined, index: Number(d[1]), rest: d[2] ?? "" };
  const p = /^\/parts\/(\d+)\/params\/(\d+)(\/.*)?$/.exec(path);
  return p ? { partIndex: Number(p[1]), index: Number(p[2]), rest: p[3] ?? "" } : null;
}

/** Deep equality of JSON values (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => jsonEqual(x, bb[i]));
  }
  const ao = a as JsonObject;
  const bo = b as JsonObject;
  const ka = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const kb = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && jsonEqual(ao[k], bo[k]));
}

/**
 * A new, empty document (the app's File ▸ New): one part and no features. Canonical up to the
 * engine's number formatting (it has no numbers), so the engine's canonical text is this text.
 */
export function blankDocument(name = "untitled", partName = "part"): string {
  const doc = { schema: "aicad.ir/1", meta: { name }, parts: [{ id: "p1", name: partName, features: [] }] };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
