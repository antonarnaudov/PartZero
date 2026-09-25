/**
 * Read and write `.partzero` documents (FULL-MODELING-PLAN §2.9): a zip written by our own deterministic writer.
 *
 * | Entry | Holds |
 * |---|---|
 * | `manifest.json` | format version, generator, IR schema, SHA-256 and size of every other entry, view state, references |
 * | `document.json` | the canonical IR: the only normative content |
 * | `cadscript/main.cad.ts` | the code view (kept for its comments) |
 * | `thumbnail.png` | a small picture for the recent-files grid (optional, not normative) |
 * | `annotations/<name>.json` | e.g. authorship marks |
 * | `blobs/<sha256>.<ext>` | imported files (reference meshes) |
 * | `cache/<forgeBuild>/…` | results a Forge build can recompute (optional; dropped when damaged) |
 * | `checkpoints/…` | kept as they are (FD5) |
 *
 * Reading validates everything before anything is loaded: the zip itself (see zip.ts), the manifest's schema and
 * version, that every listed entry exists with the recorded size and SHA-256, that the document is JSON and passes the
 * caller's IR validation. Every failure is a {@link PartZeroError} with a machine-readable code. Damage in what is not
 * normative (a thumbnail, a cache entry, a stray unlisted file) is dropped with a warning instead.
 */
import { sha256Hex } from "./checksum";
import {
  DIRS,
  EMPTY_VIEW_STATE,
  ENTRY,
  ManifestSchema,
  MIGRATIONS,
  PARTZERO_FORMAT,
  PARTZERO_FORMAT_VERSION,
  type EntryInfo,
  type Manifest,
  type ReferenceEntry,
  type ViewState,
} from "./manifest";
import { looksLikeZip, readZip, writeZip, ZipError, type ZipEntryInput, type ZipLimits } from "./zip";

export type PartZeroErrorCode =
  /** Not a zip archive at all (e.g. a CadScript file renamed to `.partzero`). */
  | "PZ_NOT_A_ZIP"
  /** A zip, but not a PartZero document (no manifest, or another format). */
  | "PZ_NOT_PARTZERO"
  /** The zip uses something we do not read (encryption, ZIP64, another compression method). */
  | "PZ_UNSUPPORTED"
  /** The zip is damaged (truncated, a checksum mismatch). */
  | "PZ_CORRUPT"
  /** An entry name is unsafe (absolute, `..`, …) or duplicated. */
  | "PZ_UNSAFE"
  /** Larger than the limits. */
  | "PZ_TOO_LARGE"
  /** `manifest.json` is not valid JSON or does not match the schema. */
  | "PZ_MANIFEST_INVALID"
  /** Written by a newer PartZero (a newer format version). */
  | "PZ_FORMAT_TOO_NEW"
  /** An entry the manifest lists is missing. */
  | "PZ_ENTRY_MISSING"
  /** An entry's size or SHA-256 differs from the manifest. */
  | "PZ_ENTRY_CORRUPT"
  /** `document.json` is not valid JSON, or not a valid IR document. */
  | "PZ_DOCUMENT_INVALID";

export class PartZeroError extends Error {
  readonly code: PartZeroErrorCode;
  /** The entry concerned, when there is one. */
  readonly entry: string | null;
  constructor(code: PartZeroErrorCode, message: string, entry: string | null = null) {
    super(message);
    this.name = "PartZeroError";
    this.code = code;
    this.entry = entry;
  }
}

export interface Generator {
  app: string;
  version: string;
  forgeBuild: string | null;
}

/** Everything a `.partzero` document holds, decoded. */
export interface PartZeroContents {
  generator: Generator;
  /** The canonical IR as JSON text, and its schema id (e.g. `aicad.ir/0`). */
  document: { json: string; irSchema: string };
  /** The code view; `matchesDocument` says whether it compiled to `document.json` when saved. */
  code: { source: string; matchesDocument: boolean } | null;
  thumbnail: { png: Uint8Array; width: number; height: number } | null;
  /** `annotations/<name>.json` by name, as JSON text. */
  annotations: Record<string, string>;
  /** `blobs/<name>` by name (e.g. `<sha256>.stl`). */
  blobs: Record<string, Uint8Array>;
  /** `cache/…` by path below `cache/` (e.g. `<forgeBuild>/meshes.bin`). */
  cache: Record<string, Uint8Array>;
  /** `checkpoints/…` by path below `checkpoints/`, carried through unchanged. */
  checkpoints: Record<string, Uint8Array>;
  view: ViewState;
  references: ReferenceEntry[];
}

export interface DecodeResult {
  contents: PartZeroContents;
  /** Non-fatal problems: dropped cache entries or thumbnail, ignored unlisted entries, a migrated manifest. */
  warnings: string[];
  /** The format version the file was written with (before migration). */
  formatVersion: number;
}

export type DocumentValidator = (json: unknown, irSchema: string) => { ok: true } | { ok: false; message: string };

export interface DecodeOptions {
  /** Validate the parsed `document.json` (the app passes its IR parser). Default: any JSON object. */
  validateDocument?: DocumentValidator;
  limits?: Partial<ZipLimits>;
  /** Manifest migrations (tests inject some; the default is {@link MIGRATIONS}). */
  migrations?: Readonly<Record<number, (m: Record<string, unknown>) => Record<string, unknown>>>;
  /** The newest version this reader understands (tests; default {@link PARTZERO_FORMAT_VERSION}). */
  maxFormatVersion?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function utf8(bytes: Uint8Array, entry: string, code: PartZeroErrorCode): string {
  try {
    return dec.decode(bytes);
  } catch {
    throw new PartZeroError(code, `${entry} is not valid UTF-8 text`, entry);
  }
}

/** Entries that are compressed well by DEFLATE (text); images and archives are stored as they are. */
function compressible(name: string): boolean {
  return !/\.(png|jpe?g|3mf|zip|gz)$/i.test(name);
}

function subEntries(prefix: string, map: Record<string, Uint8Array>): Array<[string, Uint8Array]> {
  return Object.keys(map)
    .sort()
    .map((k) => [`${prefix}${k}`, map[k]!]);
}

/** SHA-256 of large blobs by identity (the same imported mesh is hashed once across saves and autosaves). */
const digests = new WeakMap<Uint8Array, string>();

function digest(data: Uint8Array): string {
  if (data.length < 64 * 1024) return sha256Hex(data);
  let d = digests.get(data);
  if (d === undefined) {
    d = sha256Hex(data);
    digests.set(data, d);
  }
  return d;
}

/** JSON with sorted keys and 2-space indentation: the manifest's canonical form. */
export function canonicalJson(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = sortKeys(o[k]);
      return out;
    }
    return v;
  };
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/** Encode `contents` as a `.partzero` file (deterministic: the same contents give the same bytes). */
export function encodePartZero(contents: PartZeroContents): Uint8Array {
  const files: Array<[string, Uint8Array]> = [[ENTRY.document, enc.encode(contents.document.json)]];
  if (contents.code) files.push([ENTRY.code, enc.encode(contents.code.source)]);
  if (contents.thumbnail) files.push([ENTRY.thumbnail, contents.thumbnail.png]);
  for (const name of Object.keys(contents.annotations).sort()) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new PartZeroError("PZ_UNSAFE", `invalid annotation name: ${name}`);
    files.push([`${DIRS.annotations}${name}.json`, enc.encode(contents.annotations[name]!)]);
  }
  files.push(...subEntries(DIRS.blobs, contents.blobs), ...subEntries(DIRS.cache, contents.cache), ...subEntries(DIRS.checkpoints, contents.checkpoints));
  for (const r of contents.references) {
    if (!files.some(([n]) => n === r.blob)) throw new PartZeroError("PZ_ENTRY_MISSING", `reference ${r.id} points at ${r.blob}, which is not in the document`, r.blob);
  }
  const entries: Record<string, EntryInfo> = {};
  for (const [name, data] of files) entries[name] = { size: data.length, sha256: digest(data) };
  const manifest: Manifest = {
    format: PARTZERO_FORMAT,
    formatVersion: PARTZERO_FORMAT_VERSION,
    generator: contents.generator,
    document: { path: ENTRY.document, irSchema: contents.document.irSchema, units: "mm" },
    code: contents.code ? { path: ENTRY.code, language: "cadscript", matchesDocument: contents.code.matchesDocument } : null,
    thumbnail: contents.thumbnail ? { path: ENTRY.thumbnail, width: contents.thumbnail.width, height: contents.thumbnail.height } : null,
    entries,
    view: contents.view,
    references: contents.references,
  };
  const parsed = ManifestSchema.safeParse(manifest);
  if (!parsed.success) throw new PartZeroError("PZ_MANIFEST_INVALID", `cannot write this document: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const zipEntries: ZipEntryInput[] = [
    { name: ENTRY.manifest, data: enc.encode(canonicalJson(manifest)) },
    ...files.map(([name, data]) => ({ name, data, compress: compressible(name) })),
  ];
  return writeZip(zipEntries);
}

function zipFailure(e: ZipError): PartZeroError {
  const map: Record<ZipError["code"], PartZeroErrorCode> = {
    ZIP_NOT_A_ZIP: "PZ_NOT_A_ZIP",
    ZIP_UNSUPPORTED: "PZ_UNSUPPORTED",
    ZIP_CORRUPT: "PZ_CORRUPT",
    ZIP_UNSAFE_NAME: "PZ_UNSAFE",
    ZIP_DUPLICATE: "PZ_UNSAFE",
    ZIP_TOO_LARGE: "PZ_TOO_LARGE",
  };
  return new PartZeroError(map[e.code], e.message, e.entry);
}

function isNonNormative(name: string): boolean {
  return name === ENTRY.thumbnail || name.startsWith(DIRS.cache);
}

/** Decode and validate a `.partzero` file (see the module comment for what is checked). */
export function decodePartZero(bytes: Uint8Array, options: DecodeOptions = {}): DecodeResult {
  if (!looksLikeZip(bytes)) throw new PartZeroError("PZ_NOT_A_ZIP", "this is not a PartZero document (not a zip archive)");
  let zip;
  try {
    zip = readZip(bytes, options.limits);
  } catch (e) {
    if (e instanceof ZipError) throw zipFailure(e);
    throw e;
  }
  const byName = new Map(zip.map((e) => [e.name, e.data]));
  const warnings: string[] = [];
  const rawManifest = byName.get(ENTRY.manifest);
  if (!rawManifest) throw new PartZeroError("PZ_NOT_PARTZERO", "this zip is not a PartZero document (no manifest.json)", ENTRY.manifest);
  let json: unknown;
  try {
    json = JSON.parse(utf8(rawManifest, ENTRY.manifest, "PZ_MANIFEST_INVALID"));
  } catch (e) {
    if (e instanceof PartZeroError) throw e;
    throw new PartZeroError("PZ_MANIFEST_INVALID", `manifest.json is not valid JSON: ${(e as Error).message}`, ENTRY.manifest);
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new PartZeroError("PZ_MANIFEST_INVALID", "manifest.json is not a JSON object", ENTRY.manifest);
  let m = json as Record<string, unknown>;
  if (m["format"] !== PARTZERO_FORMAT) throw new PartZeroError("PZ_NOT_PARTZERO", `this zip is not a PartZero document (format ${JSON.stringify(m["format"])})`, ENTRY.manifest);
  const version = m["formatVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new PartZeroError("PZ_MANIFEST_INVALID", "manifest.json has no valid formatVersion", ENTRY.manifest);
  const newest = options.maxFormatVersion ?? PARTZERO_FORMAT_VERSION;
  if (version > newest) {
    throw new PartZeroError("PZ_FORMAT_TOO_NEW", `this document was saved by a newer PartZero (format ${version}; this version reads up to ${newest}). Update PartZero to open it.`, ENTRY.manifest);
  }
  const migrations = options.migrations ?? MIGRATIONS;
  for (let v = version; v < newest; v++) {
    const step = migrations[v];
    if (!step) throw new PartZeroError("PZ_MANIFEST_INVALID", `no migration from format ${v} to ${v + 1}`, ENTRY.manifest);
    m = { ...step(m), formatVersion: v + 1 };
  }
  if (version < newest) warnings.push(`Upgraded from PartZero format ${version} to ${newest}; saving writes the new format.`);
  const parsed = ManifestSchema.safeParse(m);
  if (!parsed.success) {
    throw new PartZeroError("PZ_MANIFEST_INVALID", `manifest.json is invalid: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, ENTRY.manifest);
  }
  const manifest = parsed.data;

  // Every listed entry exists and matches; damaged non-normative entries are dropped.
  const good = new Map<string, Uint8Array>();
  for (const name of Object.keys(manifest.entries).sort()) {
    const info = manifest.entries[name]!;
    const data = byName.get(name);
    if (!data) {
      if (isNonNormative(name)) {
        warnings.push(`${name} is missing; it will be recomputed.`);
        continue;
      }
      throw new PartZeroError("PZ_ENTRY_MISSING", `the document is incomplete: ${name} is missing`, name);
    }
    if (data.length !== info.size || sha256Hex(data) !== info.sha256) {
      if (isNonNormative(name)) {
        warnings.push(`${name} is damaged and was dropped; it will be recomputed.`);
        continue;
      }
      throw new PartZeroError("PZ_ENTRY_CORRUPT", `the document is damaged: ${name} does not match its checksum`, name);
    }
    good.set(name, data);
  }
  for (const name of byName.keys()) {
    if (name !== ENTRY.manifest && !(name in manifest.entries)) warnings.push(`Ignored ${name}: it is not listed in the manifest.`);
  }

  const docBytes = good.get(ENTRY.document);
  if (!docBytes) throw new PartZeroError("PZ_ENTRY_MISSING", "the document has no document.json", ENTRY.document);
  const docJson = utf8(docBytes, ENTRY.document, "PZ_DOCUMENT_INVALID");
  let doc: unknown;
  try {
    doc = JSON.parse(docJson);
  } catch (e) {
    throw new PartZeroError("PZ_DOCUMENT_INVALID", `document.json is not valid JSON: ${(e as Error).message}`, ENTRY.document);
  }
  const validate: DocumentValidator = options.validateDocument ?? ((v) => (v && typeof v === "object" && !Array.isArray(v) ? { ok: true } : { ok: false, message: "not a JSON object" }));
  const verdict = validate(doc, manifest.document.irSchema);
  if (!verdict.ok) throw new PartZeroError("PZ_DOCUMENT_INVALID", `document.json is not a valid ${manifest.document.irSchema} document: ${verdict.message}`, ENTRY.document);

  let code: PartZeroContents["code"] = null;
  if (manifest.code) {
    const bytesCode = good.get(ENTRY.code);
    if (!bytesCode) throw new PartZeroError("PZ_ENTRY_MISSING", `the document is incomplete: ${ENTRY.code} is not listed`, ENTRY.code);
    code = { source: utf8(bytesCode, ENTRY.code, "PZ_ENTRY_CORRUPT"), matchesDocument: manifest.code.matchesDocument };
  }
  let thumbnail: PartZeroContents["thumbnail"] = null;
  const png = manifest.thumbnail ? good.get(ENTRY.thumbnail) : undefined;
  if (manifest.thumbnail && png) thumbnail = { png, width: manifest.thumbnail.width, height: manifest.thumbnail.height };

  const annotations: Record<string, string> = {};
  const blobs: Record<string, Uint8Array> = {};
  const cache: Record<string, Uint8Array> = {};
  const checkpoints: Record<string, Uint8Array> = {};
  for (const [name, data] of good) {
    if (name.startsWith(DIRS.annotations)) {
      const m2 = /^annotations\/([A-Za-z0-9_-]{1,64})\.json$/.exec(name);
      if (!m2) {
        warnings.push(`Ignored ${name}: not an annotation file.`);
        continue;
      }
      annotations[m2[1]!] = utf8(data, name, "PZ_ENTRY_CORRUPT");
    } else if (name.startsWith(DIRS.blobs)) {
      blobs[name.slice(DIRS.blobs.length)] = data;
    } else if (name.startsWith(DIRS.cache)) {
      cache[name.slice(DIRS.cache.length)] = data;
    } else if (name.startsWith(DIRS.checkpoints)) {
      checkpoints[name.slice(DIRS.checkpoints.length)] = data;
    } else if (name !== ENTRY.document && name !== ENTRY.code && name !== ENTRY.thumbnail) {
      warnings.push(`Ignored ${name}: not a known part of a PartZero document.`);
    }
  }
  const ids = new Set<string>();
  for (const r of manifest.references) {
    if (ids.has(r.id)) throw new PartZeroError("PZ_MANIFEST_INVALID", `two references share the id ${r.id}`, ENTRY.manifest);
    ids.add(r.id);
    if (!good.has(r.blob)) throw new PartZeroError("PZ_ENTRY_MISSING", `reference ${r.name} points at ${r.blob}, which is missing`, r.blob);
  }

  return {
    contents: {
      generator: manifest.generator,
      document: { json: docJson, irSchema: manifest.document.irSchema },
      code,
      thumbnail,
      annotations,
      blobs,
      cache,
      checkpoints,
      view: manifest.view ?? EMPTY_VIEW_STATE,
      references: manifest.references,
    },
    warnings,
    formatVersion: version,
  };
}

/** Whether a file name is a `.partzero` document. */
export function isPartZeroPath(path: string): boolean {
  return /\.partzero$/i.test(path);
}
