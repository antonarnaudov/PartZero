/**
 * Our own zip container, host-free.
 *
 * {@link writeZip} is deterministic: entries sorted by name, a fixed timestamp (1980-01-01 00:00, the zip epoch), no
 * extra fields, no comments, no OS attributes, UTF-8 names, and our own DEFLATE ({@link deflateRaw}). The same entries
 * always give the same bytes, on every platform.
 *
 * {@link readZip} reads what we write and what ordinary zip tools write (stored and deflated entries, data
 * descriptors), and refuses what a document never needs and an attacker might use: encryption, ZIP64, multi-disk
 * archives, unsafe names (absolute, `..`, backslashes, drive letters, control characters), duplicate names, and
 * entries or totals above the limits (a zip bomb stops at the cap, see {@link inflateRaw}).
 */
import { crc32 } from "./checksum";
import { deflateRaw, inflateRaw, InflateError } from "./deflate";

export type ZipErrorCode = "ZIP_NOT_A_ZIP" | "ZIP_UNSUPPORTED" | "ZIP_CORRUPT" | "ZIP_UNSAFE_NAME" | "ZIP_TOO_LARGE" | "ZIP_DUPLICATE";

export class ZipError extends Error {
  readonly code: ZipErrorCode;
  readonly entry: string | null;
  constructor(code: ZipErrorCode, message: string, entry: string | null = null) {
    super(message);
    this.name = "ZipError";
    this.code = code;
    this.entry = entry;
  }
}

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
  /** Compress this entry (kept stored when compression does not make it smaller). Default true. */
  compress?: boolean;
}

export interface ZipLimits {
  /** Most entries (default 10 000). */
  maxEntries: number;
  /** Largest uncompressed entry (default 1 GiB). */
  maxEntryBytes: number;
  /** Largest uncompressed total (default 2 GiB). */
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 10_000, maxEntryBytes: 1024 ** 3, maxTotalBytes: 2 * 1024 ** 3 };

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800;
/** 1980-01-01: day 1, month 1, year 0 (1980) in MS-DOS date format. */
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DOS_TIME = 0;
const MAX_NAME = 512;

const utf8 = new TextEncoder();

/**
 * Compressed forms of large inputs, by identity: a document's imported meshes are the same `Uint8Array` objects from
 * one save (or autosave) to the next, so they are compressed once. The output is a pure function of the bytes, so the
 * cache never changes a file. (A caller that mutates an array after writing it must not rely on this cache: nothing in
 * the document layer does; blobs are immutable.)
 */
const deflated = new WeakMap<Uint8Array, { crc: number; body: Uint8Array | null }>();
const CACHE_FROM_BYTES = 64 * 1024;

function compressEntry(data: Uint8Array): { crc: number; body: Uint8Array | null } {
  const hit = data.length >= CACHE_FROM_BYTES ? deflated.get(data) : undefined;
  if (hit) return hit;
  const z = deflateRaw(data);
  const r = { crc: crc32(data), body: z.length < data.length ? z : null };
  if (data.length >= CACHE_FROM_BYTES) deflated.set(data, r);
  return r;
}

/** Whether `name` is a safe, relative, forward-slash entry name (the only kind we write or read). */
export function isSafeEntryName(name: string): boolean {
  if (name.length === 0 || name.length > MAX_NAME) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(name)) return false;
  if (name.startsWith("/")) return false;
  const parts = name.replace(/\/$/, "").split("/");
  return parts.every((p) => p.length > 0 && p !== "." && p !== "..");
}

/** Build a zip archive from `entries` (deterministic; see the module comment). */
export function writeZip(entries: readonly ZipEntryInput[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set<string>();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of sorted) {
    if (!isSafeEntryName(e.name) || e.name.endsWith("/")) throw new ZipError("ZIP_UNSAFE_NAME", `invalid entry name: ${JSON.stringify(e.name)}`, e.name);
    if (seen.has(e.name)) throw new ZipError("ZIP_DUPLICATE", `duplicate entry: ${e.name}`, e.name);
    seen.add(e.name);
    const name = utf8.encode(e.name);
    let crc: number;
    let method = 0;
    let body = e.data;
    if (e.compress !== false && e.data.length > 0) {
      const c = compressEntry(e.data);
      crc = c.crc;
      if (c.body) {
        method = 8;
        body = c.body;
      }
    } else {
      crc = crc32(e.data);
    }
    if (body.length > 0xfffffffe || e.data.length > 0xfffffffe) throw new ZipError("ZIP_TOO_LARGE", `entry too large for a zip without ZIP64: ${e.name}`, e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, SIG_LOCAL, true);
    lv.setUint16(4, 20, true); // version needed: 2.0
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    locals.push(local, body);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, SIG_CENTRAL, true);
    cv.setUint16(4, 20, true); // made by: MS-DOS, 2.0 (no Unix attributes)
    cv.setUint16(6, 20, true);
    cv.setUint16(8, FLAG_UTF8, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes: 0
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);
    offset += local.length + body.length;
    if (offset > 0xfffffffe) throw new ZipError("ZIP_TOO_LARGE", "archive too large for a zip without ZIP64");
  }
  if (sorted.length > 0xfffe) throw new ZipError("ZIP_TOO_LARGE", "too many entries for a zip without ZIP64");
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, SIG_EOCD, true);
  ev.setUint16(8, sorted.length, true);
  ev.setUint16(10, sorted.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + eocd.length);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

function findEocd(bytes: Uint8Array, view: DataView): number {
  // The EOCD record is 22 bytes plus a comment of up to 65535 bytes, at the very end.
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD && i + 22 + view.getUint16(i + 20, true) === bytes.length) return i;
  }
  return -1;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const latin1Decoder = new TextDecoder("latin1");

/** Read every file entry of a zip archive (directory entries are skipped), checking CRCs and the limits. */
export function readZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): ZipEntry[] {
  const lim = { ...DEFAULT_ZIP_LIMITS, ...limits };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw new ZipError("ZIP_NOT_A_ZIP", "not a zip archive (too short)");
  const eocd = findEocd(bytes, view);
  if (eocd < 0) throw new ZipError("ZIP_NOT_A_ZIP", "not a zip archive (no end-of-central-directory record)");
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0 || view.getUint16(eocd + 8, true) !== count) throw new ZipError("ZIP_UNSUPPORTED", "multi-disk zip archives are not supported");
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("ZIP_UNSUPPORTED", "ZIP64 archives are not supported");
  if (cdOffset + cdSize > eocd) throw new ZipError("ZIP_CORRUPT", "the central directory lies outside the archive");
  if (count > lim.maxEntries) throw new ZipError("ZIP_TOO_LARGE", `too many entries (${count} > ${lim.maxEntries})`);
  const out: ZipEntry[] = [];
  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cdOffset + cdSize || view.getUint32(p, true) !== SIG_CENTRAL) throw new ZipError("ZIP_CORRUPT", "damaged central directory");
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const csize = view.getUint32(p + 20, true);
    const usize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    let name: string;
    try {
      name = flags & FLAG_UTF8 ? utf8Decoder.decode(nameBytes) : latin1Decoder.decode(nameBytes);
    } catch {
      throw new ZipError("ZIP_UNSAFE_NAME", "an entry name is not valid UTF-8");
    }
    if (!isSafeEntryName(name)) throw new ZipError("ZIP_UNSAFE_NAME", `unsafe entry name: ${JSON.stringify(name.slice(0, 200))}`, name);
    if (flags & 0x0001) throw new ZipError("ZIP_UNSUPPORTED", `encrypted entries are not supported (${name})`, name);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) throw new ZipError("ZIP_UNSUPPORTED", "ZIP64 entries are not supported", name);
    if (names.has(name)) throw new ZipError("ZIP_DUPLICATE", `duplicate entry: ${name}`, name);
    names.add(name);
    if (name.endsWith("/")) continue; // a directory
    if (method !== 0 && method !== 8) throw new ZipError("ZIP_UNSUPPORTED", `compression method ${method} is not supported (${name})`, name);
    if (usize > lim.maxEntryBytes) throw new ZipError("ZIP_TOO_LARGE", `${name} is too large (${usize} bytes)`, name);
    total += usize;
    if (total > lim.maxTotalBytes) throw new ZipError("ZIP_TOO_LARGE", "the archive's contents are too large");
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== SIG_LOCAL) throw new ZipError("ZIP_CORRUPT", `damaged local header (${name})`, name);
    const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (start + csize > bytes.length) throw new ZipError("ZIP_CORRUPT", `${name} is truncated`, name);
    const raw = bytes.subarray(start, start + csize);
    let data: Uint8Array;
    if (method === 0) {
      if (csize !== usize) throw new ZipError("ZIP_CORRUPT", `${name}: stored size mismatch`, name);
      data = raw.slice();
    } else {
      try {
        data = inflateRaw(raw, { expectedSize: usize, maxSize: Math.min(lim.maxEntryBytes, usize) });
      } catch (e) {
        if (e instanceof InflateError && e.code === "INFLATE_TOO_LARGE") throw new ZipError("ZIP_CORRUPT", `${name} inflates beyond its recorded size`, name);
        throw new ZipError("ZIP_CORRUPT", `${name}: ${e instanceof Error ? e.message : String(e)}`, name);
      }
    }
    if (data.length !== usize) throw new ZipError("ZIP_CORRUPT", `${name}: size mismatch`, name);
    if (crc32(data) !== crc) throw new ZipError("ZIP_CORRUPT", `${name}: checksum mismatch`, name);
    out.push({ name, data });
  }
  return out;
}

/** Whether `bytes` starts like a zip archive (`PK\x03\x04`, or an empty archive's `PK\x05\x06`). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6));
}
