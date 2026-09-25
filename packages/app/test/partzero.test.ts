import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  adler32,
  canonicalJson,
  crc32,
  decodePartZero,
  deflateRaw,
  encodePartZero,
  ENTRY,
  inflateRaw,
  isSafeEntryName,
  PartZeroError,
  readZip,
  sha256Hex,
  writeZip,
  ZipError,
  type PartZeroContents,
} from "../src/file/partzero";

const enc = new TextEncoder();

/** A deterministic pseudo-random byte stream (xorshift). */
function noise(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

function sample(): PartZeroContents {
  const stl = enc.encode("solid x\nendsolid x\n");
  const stlName = `${sha256Hex(stl)}.stl`;
  return {
    generator: { app: "PartZero", version: "0.1.0", forgeBuild: null },
    document: { json: '{\n  "schema": "aicad.ir/0",\n  "parts": []\n}\n', irSchema: "aicad.ir/0" },
    code: { source: 'import { doc } from "@aicad/std";\n// a comment that only the code keeps\n', matchesDocument: true },
    thumbnail: { png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]), width: 2, height: 1 },
    annotations: { authorship: '{"marks":[]}' },
    blobs: { [stlName]: stl },
    cache: { "forge-1/report.json": enc.encode("{}") },
    checkpoints: {},
    view: { rollbackMarker: null, hidden: ["ref1"], camera: { distance: 120 } },
    references: [{ id: "ref1", name: "bracket", blob: `blobs/${stlName}`, format: "stl", units: "mm", scale: 1, visible: false, sourceName: "bracket.stl" }],
  };
}

/** Rewrite one entry of a zip (keeping the others), e.g. to corrupt it or to change the manifest. */
function patchZip(bytes: Uint8Array, name: string, data: Uint8Array | null, extra: Array<{ name: string; data: Uint8Array }> = []): Uint8Array {
  const entries = readZip(bytes).filter((e) => e.name !== name);
  if (data) entries.push({ name, data });
  return writeZip([...entries, ...extra]);
}

describe("checksums", () => {
  it("match Node's CRC-32, SHA-256 and the Adler-32 reference values", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(adler32(enc.encode("Wikipedia"))).toBe(0x11e60398);
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
      const d = noise(n, n + 7);
      expect(sha256Hex(d)).toBe(createHash("sha256").update(d).digest("hex"));
    }
    expect(sha256Hex(enc.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("DEFLATE", () => {
  const inputs: Array<[string, Uint8Array]> = [
    ["empty", new Uint8Array(0)],
    ["one byte", new Uint8Array([42])],
    ["text", enc.encode(canonicalJson({ a: [1, 2, 3], b: "hello ".repeat(500), c: { nested: true } }))],
    ["noise", noise(70_000)],
    ["long runs", new Uint8Array(300_000).fill(7)],
    ["mixed", new Uint8Array([...noise(5000, 3), ...new Uint8Array(40_000).fill(1), ...enc.encode("abcabcabc".repeat(3000))])],
  ];

  it.each(inputs)("our compressor round-trips through zlib and our decoder (%s)", (_name, data) => {
    const z = deflateRaw(data);
    expect(new Uint8Array(inflateRawSync(z))).toEqual(data);
    expect(inflateRaw(z)).toEqual(data);
  });

  it("our decoder reads zlib's stored, fixed and dynamic blocks", () => {
    for (const [, data] of inputs) {
      for (const level of [0, 1, 6, 9]) {
        const z = new Uint8Array(deflateRawSync(data, { level }));
        expect(inflateRaw(z)).toEqual(data);
      }
    }
  });

  it("is deterministic and compresses text", () => {
    const text = enc.encode("the same line again\n".repeat(2000));
    const a = deflateRaw(text);
    expect(deflateRaw(text)).toEqual(a);
    expect(a.length).toBeLessThan(text.length / 20);
  });

  it("stops at the output cap and rejects garbage", () => {
    const bomb = new Uint8Array(deflateRawSync(new Uint8Array(5_000_000)));
    expect(() => inflateRaw(bomb, { maxSize: 1_000_000 })).toThrow(/beyond/);
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff]))).toThrow();
    expect(() => inflateRaw(new Uint8Array([]))).toThrow(/unexpected end/);
  });
});

describe("zip", () => {
  it("writes the same bytes for the same entries in any order, and reads them back", () => {
    const entries = [
      { name: "b.txt", data: enc.encode("bee ".repeat(100)) },
      { name: "a/one.json", data: enc.encode("{}") },
      { name: "raw.bin", data: noise(1000), compress: false },
    ];
    const z1 = writeZip(entries);
    const z2 = writeZip([...entries].reverse());
    expect(z2).toEqual(z1);
    const back = readZip(z1);
    expect(back.map((e) => e.name)).toEqual(["a/one.json", "b.txt", "raw.bin"]);
    expect(back[1]!.data).toEqual(entries[0]!.data);
    expect(back[2]!.data).toEqual(entries[2]!.data);
  });

  it("is readable by standard tools' conventions (fixed 1980 timestamp, UTF-8 names)", () => {
    const z = writeZip([{ name: "ünïcode/файл.txt", data: enc.encode("x") }]);
    const view = new DataView(z.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(view.getUint16(12, true)).toBe(0x21); // 1980-01-01
    expect(readZip(z)[0]!.name).toBe("ünïcode/файл.txt");
  });

  it("refuses unsafe names, duplicates, damage and oversized contents", () => {
    for (const bad of ["/abs", "../up", "a/../b", "a\\b", "C:x", "a//b", "", "nul\u0000"]) expect(isSafeEntryName(bad)).toBe(false);
    expect(() => writeZip([{ name: "../evil", data: new Uint8Array(1) }])).toThrow(ZipError);
    expect(() => writeZip([{ name: "a", data: new Uint8Array(1) }, { name: "a", data: new Uint8Array(1) }])).toThrow(/duplicate/);
    const z = writeZip([{ name: "a.txt", data: enc.encode("hello hello hello hello") }]);
    const damaged = z.slice();
    damaged[40] = damaged[40]! ^ 0xff;
    expect(() => readZip(damaged)).toThrow(ZipError);
    expect(() => readZip(z.subarray(0, z.length - 5))).toThrow(/not a zip/);
    expect(() => readZip(z, { maxEntryBytes: 4 })).toThrow(/too large/);
    expect(() => readZip(enc.encode("definitely not a zip file at all"))).toThrow(/not a zip/);
  });
});

describe(".partzero codec", () => {
  it("round-trips every part of a document", () => {
    const c = sample();
    const bytes = encodePartZero(c);
    const { contents, warnings, formatVersion } = decodePartZero(bytes);
    expect(warnings).toEqual([]);
    expect(formatVersion).toBe(1);
    expect(contents).toEqual(c);
  });

  it("is deterministic: the same document gives the same bytes", () => {
    expect(encodePartZero(sample())).toEqual(encodePartZero(sample()));
  });

  it("lists every entry with its SHA-256 in a canonical manifest", () => {
    const bytes = encodePartZero(sample());
    const files = new Map(readZip(bytes).map((e) => [e.name, e.data]));
    const manifest = JSON.parse(new TextDecoder().decode(files.get(ENTRY.manifest))) as { entries: Record<string, { sha256: string; size: number }>; format: string; formatVersion: number };
    expect(manifest.format).toBe("partzero");
    expect(manifest.formatVersion).toBe(1);
    expect(Object.keys(manifest.entries).sort()).toEqual([...files.keys()].filter((n) => n !== ENTRY.manifest).sort());
    for (const [name, info] of Object.entries(manifest.entries)) expect(info.sha256).toBe(sha256Hex(files.get(name)!));
    expect(new TextDecoder().decode(files.get(ENTRY.manifest))).toBe(canonicalJson(manifest));
  });

  it("refuses what is not a PartZero document, with a code", () => {
    const code = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        return e instanceof PartZeroError ? e.code : `other: ${String(e)}`;
      }
      return "no error";
    };
    expect(code(() => decodePartZero(enc.encode("import { doc } from '@aicad/std';")))).toBe("PZ_NOT_A_ZIP");
    expect(code(() => decodePartZero(writeZip([{ name: "x.txt", data: enc.encode("x") }])))).toBe("PZ_NOT_PARTZERO");
    const good = encodePartZero(sample());
    expect(code(() => decodePartZero(patchZip(good, ENTRY.manifest, enc.encode("{ not json"))))).toBe("PZ_MANIFEST_INVALID");
    expect(code(() => decodePartZero(patchZip(good, ENTRY.manifest, enc.encode(JSON.stringify({ format: "partzero", formatVersion: 1 })))))).toBe("PZ_MANIFEST_INVALID");
    expect(code(() => decodePartZero(patchZip(good, ENTRY.document, enc.encode('{"schema":"aicad.ir/0","parts":[1]}'))))).toBe("PZ_ENTRY_CORRUPT");
    expect(code(() => decodePartZero(patchZip(good, ENTRY.document, null)))).toBe("PZ_ENTRY_MISSING");
    const truncated = good.slice(0, good.length - 30);
    expect(["PZ_NOT_A_ZIP", "PZ_CORRUPT"]).toContain(code(() => decodePartZero(truncated)));
  });

  it("refuses a newer format version and migrates older ones", () => {
    const good = encodePartZero(sample());
    const manifest = JSON.parse(new TextDecoder().decode(readZip(good).find((e) => e.name === ENTRY.manifest)!.data)) as Record<string, unknown>;
    const newer = patchZip(good, ENTRY.manifest, enc.encode(JSON.stringify({ ...manifest, formatVersion: 2 })));
    expect(() => decodePartZero(newer)).toThrow(/newer PartZero/);
    try {
      decodePartZero(newer);
    } catch (e) {
      expect((e as PartZeroError).code).toBe("PZ_FORMAT_TOO_NEW");
    }
    // Pretend this build reads format 2 and the file is a format 1 file with a renamed field.
    const { renamedView, ...rest } = { ...manifest, renamedView: manifest["view"] };
    const old = patchZip(good, ENTRY.manifest, enc.encode(JSON.stringify({ ...rest, view: undefined, oldView: renamedView })));
    const r = decodePartZero(old, { maxFormatVersion: 2, migrations: { 1: (m) => ({ ...m, view: m["oldView"], oldView: undefined }) } });
    expect(r.formatVersion).toBe(1);
    expect(r.contents.view.hidden).toEqual(["ref1"]);
    expect(r.warnings.join(" ")).toMatch(/Upgraded from PartZero format 1 to 2/);
  });

  it("drops a damaged thumbnail or cache entry with a warning, and ignores unlisted files", () => {
    const good = encodePartZero(sample());
    const damaged = patchZip(good, ENTRY.thumbnail, new Uint8Array([1, 2, 3]), [{ name: "__MACOSX/._x", data: new Uint8Array(4) }]);
    const r = decodePartZero(patchZip(damaged, "cache/forge-1/report.json", enc.encode("{broken")));
    expect(r.contents.thumbnail).toBeNull();
    expect(r.contents.cache).toEqual({});
    expect(r.warnings.length).toBe(3);
    expect(r.contents.document.json).toBe(sample().document.json);
  });

  it("runs the caller's document validation", () => {
    const good = encodePartZero(sample());
    expect(() => decodePartZero(good, { validateDocument: () => ({ ok: false, message: "parts[0] is wrong" }) })).toThrow(/not a valid aicad.ir\/0 document: parts\[0\] is wrong/);
  });

  it("refuses references whose blob is missing, when writing and when reading", () => {
    const c = sample();
    expect(() => encodePartZero({ ...c, blobs: {} })).toThrow(PartZeroError);
    const good = encodePartZero(c);
    const blob = c.references[0]!.blob;
    expect(() => decodePartZero(patchZip(good, blob, null))).toThrow(/missing/);
  });
});
