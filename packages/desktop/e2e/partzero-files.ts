/**
 * Test helpers for `.partzero` files, independent of the app's own codec on purpose: a zip reader over Node's zlib
 * checks that what the app writes is an ordinary zip that other tools read, and a binary STL writer makes fixtures.
 */
import { inflateRawSync } from "node:zlib";

/** Every file entry of a zip archive, by name (stored and deflated entries). */
export function unzip(bytes: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive");
  const count = bytes.readUInt16LE(eocd + 10);
  let p = bytes.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (bytes.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = bytes.readUInt16LE(p + 10);
    const csize = bytes.readUInt32LE(p + 20);
    const nameLen = bytes.readUInt16LE(p + 28);
    const extra = bytes.readUInt16LE(p + 30);
    const comment = bytes.readUInt16LE(p + 32);
    const local = bytes.readUInt32LE(p + 42);
    const name = bytes.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extra + comment;
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
  }
  return out;
}

export interface PartZeroView {
  manifest: {
    format: string;
    formatVersion: number;
    code: { matchesDocument: boolean } | null;
    references: Array<{ id: string; name: string; format: string; visible: boolean; blob: string }>;
    entries: Record<string, { size: number; sha256: string }>;
    document: { path: string; irSchema: string; units: string };
    view: { rollbackMarker: string | null; hidden: string[]; camera: unknown };
  };
  document: { schema: string; parts: Array<{ name: string }> };
  code: string | null;
  files: Map<string, Buffer>;
}

/** The parts of a `.partzero` file a test looks at. */
export function readPartZero(bytes: Buffer): PartZeroView {
  const files = unzip(bytes);
  const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as PartZeroView["manifest"];
  return {
    manifest,
    document: JSON.parse(files.get("document.json")!.toString("utf8")) as PartZeroView["document"],
    code: files.get("cadscript/main.cad.ts")?.toString("utf8") ?? null,
    files,
  };
}

/** A binary STL of an axis-aligned box from the origin to (sx, sy, sz). */
export function boxStl(sx: number, sy: number, sz: number): Buffer {
  const v = [
    [0, 0, 0],
    [sx, 0, 0],
    [sx, sy, 0],
    [0, sy, 0],
    [0, 0, sz],
    [sx, 0, sz],
    [sx, sy, sz],
    [0, sy, sz],
  ];
  const tris = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7];
  const n = tris.length / 3;
  const out = Buffer.alloc(84 + n * 50);
  out.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const p = v[tris[t * 3 + k]!]!;
      for (let c = 0; c < 3; c++) out.writeFloatLE(p[c]!, 84 + t * 50 + 12 + (k * 3 + c) * 4);
    }
  }
  return out;
}
