/**
 * Raw DEFLATE (RFC 1951), our own, host-free and deterministic.
 *
 * - {@link deflateRaw}: LZ77 with hash chains, one block of the fixed Huffman code. The output depends only on the
 *   input bytes and the constants below, so a `.partzero` written on macOS, Windows, Linux or in the browser is the
 *   same file byte for byte (zlib's output may change between zlib versions; ours does not).
 * - {@link inflateRaw}: the full decoder (stored, fixed and dynamic blocks), with an output cap, so files written by
 *   other zip tools (a re-zipped `.partzero`, a 3MF from a slicer) open too, and a zip bomb stops at the cap.
 */

export class InflateError extends Error {
  readonly code: "INFLATE_CORRUPT" | "INFLATE_TOO_LARGE";
  constructor(code: InflateError["code"], message: string) {
    super(message);
    this.name = "InflateError";
    this.code = code;
  }
}

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
/** Order of the code-length code lengths in a dynamic block header. */
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// ─── Compressor ──────────────────────────────────────────────────────────────────────────────

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
/** How many earlier positions with the same 3-byte hash are tried; a fixed number keeps the output deterministic. */
const MAX_CHAIN = 48;
/** A match this long is good enough: stop searching. */
const NICE_MATCH = 128;

class BitWriter {
  private buf: Uint8Array;
  private pos = 0;
  private bits = 0;
  private count = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(Math.max(64, capacity));
  }

  /** Write `n` bits of `value`, least significant first. */
  write(value: number, n: number): void {
    this.bits |= value << this.count;
    this.count += n;
    while (this.count >= 8) {
      this.byte(this.bits & 0xff);
      this.bits >>>= 8;
      this.count -= 8;
    }
  }

  /** Write a Huffman code (stored most significant bit first). */
  code(code: number, n: number): void {
    let rev = 0;
    for (let i = 0; i < n; i++) rev |= ((code >>> i) & 1) << (n - 1 - i);
    this.write(rev, n);
  }

  private byte(b: number): void {
    if (this.pos === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.pos++] = b;
  }

  finish(): Uint8Array {
    if (this.count > 0) this.byte(this.bits & 0xff);
    this.bits = 0;
    this.count = 0;
    return this.buf.slice(0, this.pos);
  }
}

function writeLiteral(w: BitWriter, lit: number): void {
  if (lit < 144) w.code(0x30 + lit, 8);
  else w.code(0x190 + lit - 144, 9);
}

function writeLengthSymbol(w: BitWriter, sym: number): void {
  // sym in 256..285
  if (sym < 280) w.code(sym - 256, 7);
  else w.code(0xc0 + sym - 280, 8);
}

function lengthCode(len: number): number {
  let i = LEN_BASE.length - 1;
  while (LEN_BASE[i]! > len) i--;
  return i;
}

function distCode(dist: number): number {
  let i = DIST_BASE.length - 1;
  while (DIST_BASE[i]! > dist) i--;
  return i;
}

/** Compress `data` into a raw DEFLATE stream (one fixed-Huffman block). */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const n = data.length;
  const w = new BitWriter((n >>> 1) + 64);
  w.write(1, 1); // BFINAL
  w.write(1, 2); // BTYPE = 01, fixed Huffman
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);
  const hashAt = (i: number): number => ((data[i]! << 10) ^ (data[i + 1]! << 5) ^ data[i + 2]!) & (HASH_SIZE - 1);
  const insert = (i: number): void => {
    if (i + MIN_MATCH > n) return;
    const h = hashAt(i);
    prev[i & (WINDOW - 1)] = head[h]!;
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      let cand = head[hashAt(i)]!;
      const maxLen = Math.min(MAX_MATCH, n - i);
      for (let chain = 0; cand >= 0 && i - cand <= WINDOW && chain < MAX_CHAIN; chain++) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let len = 0;
          while (len < maxLen && data[cand + len] === data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = i - cand;
            if (len >= NICE_MATCH || len === maxLen) break;
          }
        }
        const next = prev[cand & (WINDOW - 1)]!;
        if (next >= cand) break; // the ring slot was reused by a newer position
        cand = next;
      }
    }
    if (bestLen >= MIN_MATCH) {
      const lc = lengthCode(bestLen);
      writeLengthSymbol(w, 257 + lc);
      if (LEN_EXTRA[lc]! > 0) w.write(bestLen - LEN_BASE[lc]!, LEN_EXTRA[lc]!);
      const dc = distCode(bestDist);
      w.code(dc, 5);
      if (DIST_EXTRA[dc]! > 0) w.write(bestDist - DIST_BASE[dc]!, DIST_EXTRA[dc]!);
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      writeLiteral(w, data[i]!);
      insert(i);
      i++;
    }
  }
  writeLengthSymbol(w, 256); // end of block
  return w.finish();
}

// ─── Decompressor ────────────────────────────────────────────────────────────────────────────

interface Huffman {
  count: Uint16Array;
  symbol: Uint16Array;
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]!]!++;
  count[0] = 0;
  // Over-subscribed code check: a complete or incomplete code is fine, an over-subscribed one is corrupt.
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left <<= 1;
    left -= count[len]!;
    if (left < 0) throw new InflateError("INFLATE_CORRUPT", "over-subscribed Huffman code");
  }
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len]! + count[len]!;
  const symbol = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbol[offs[lengths[i]!]!++] = i;
  return { count, symbol };
}

const FIXED: { lit: Huffman; dist: Huffman } = (() => {
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(30).fill(5);
  return { lit: buildHuffman(l, 288), dist: buildHuffman(d, 30) };
})();

class Inflater {
  private readonly src: Uint8Array;
  private pos = 0;
  private bitBuf = 0;
  private bitCnt = 0;
  out: Uint8Array;
  outLen = 0;
  private readonly maxOut: number;

  constructor(src: Uint8Array, expected: number, maxOut: number) {
    this.src = src;
    this.maxOut = maxOut;
    this.out = new Uint8Array(Math.min(Math.max(expected, 1024), maxOut));
  }

  bits(n: number): number {
    let v = this.bitBuf;
    while (this.bitCnt < n) {
      if (this.pos >= this.src.length) throw new InflateError("INFLATE_CORRUPT", "unexpected end of the compressed data");
      v |= this.src[this.pos++]! << this.bitCnt;
      this.bitCnt += 8;
    }
    this.bitBuf = v >>> n;
    this.bitCnt -= n;
    return v & ((1 << n) - 1);
  }

  private ensure(extra: number): void {
    const need = this.outLen + extra;
    if (need > this.maxOut) throw new InflateError("INFLATE_TOO_LARGE", `the data inflates beyond ${this.maxOut} bytes`);
    if (need <= this.out.length) return;
    let size = this.out.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(Math.min(size, this.maxOut));
    next.set(this.out.subarray(0, this.outLen));
    this.out = next;
  }

  private decode(h: Huffman): number {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= this.bits(1);
      const count = h.count[len]!;
      if (code - count < first) return h.symbol[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("INFLATE_CORRUPT", "invalid Huffman code");
  }

  private stored(): void {
    this.bitBuf = 0;
    this.bitCnt = 0;
    if (this.pos + 4 > this.src.length) throw new InflateError("INFLATE_CORRUPT", "truncated stored block");
    const len = this.src[this.pos]! | (this.src[this.pos + 1]! << 8);
    const nlen = this.src[this.pos + 2]! | (this.src[this.pos + 3]! << 8);
    this.pos += 4;
    if (len !== (~nlen & 0xffff)) throw new InflateError("INFLATE_CORRUPT", "stored block length check failed");
    if (this.pos + len > this.src.length) throw new InflateError("INFLATE_CORRUPT", "truncated stored block");
    this.ensure(len);
    this.out.set(this.src.subarray(this.pos, this.pos + len), this.outLen);
    this.outLen += len;
    this.pos += len;
  }

  private codes(lit: Huffman, dist: Huffman): void {
    for (;;) {
      const sym = this.decode(lit);
      if (sym < 256) {
        this.ensure(1);
        this.out[this.outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        const li = sym - 257;
        if (li >= 29) throw new InflateError("INFLATE_CORRUPT", "invalid length symbol");
        const len = LEN_BASE[li]! + this.bits(LEN_EXTRA[li]!);
        const di = this.decode(dist);
        if (di >= 30) throw new InflateError("INFLATE_CORRUPT", "invalid distance symbol");
        const d = DIST_BASE[di]! + this.bits(DIST_EXTRA[di]!);
        if (d > this.outLen) throw new InflateError("INFLATE_CORRUPT", "distance reaches before the start of the data");
        this.ensure(len);
        const out = this.out;
        let o = this.outLen;
        for (let k = 0; k < len; k++, o++) out[o] = out[o - d]!;
        this.outLen = o;
      }
    }
  }

  private dynamic(): void {
    const nlen = this.bits(5) + 257;
    const ndist = this.bits(5) + 1;
    const ncode = this.bits(4) + 4;
    if (nlen > 286 || ndist > 30) throw new InflateError("INFLATE_CORRUPT", "bad dynamic block counts");
    const lengths = new Uint8Array(320);
    for (let i = 0; i < ncode; i++) lengths[CLEN_ORDER[i]!] = this.bits(3);
    const lencode = buildHuffman(lengths, 19);
    lengths.fill(0);
    let index = 0;
    while (index < nlen + ndist) {
      let sym = this.decode(lencode);
      if (sym < 16) {
        lengths[index++] = sym;
      } else {
        let len = 0;
        if (sym === 16) {
          if (index === 0) throw new InflateError("INFLATE_CORRUPT", "repeat with no previous length");
          len = lengths[index - 1]!;
          sym = 3 + this.bits(2);
        } else if (sym === 17) {
          sym = 3 + this.bits(3);
        } else {
          sym = 11 + this.bits(7);
        }
        if (index + sym > nlen + ndist) throw new InflateError("INFLATE_CORRUPT", "too many code lengths");
        while (sym--) lengths[index++] = len;
      }
    }
    if (lengths[256] === 0) throw new InflateError("INFLATE_CORRUPT", "no end-of-block code");
    const lit = buildHuffman(lengths.subarray(0, nlen), nlen);
    const dist = buildHuffman(lengths.subarray(nlen, nlen + ndist), ndist);
    this.codes(lit, dist);
  }

  run(): void {
    let last = 0;
    do {
      last = this.bits(1);
      const type = this.bits(2);
      if (type === 0) this.stored();
      else if (type === 1) this.codes(FIXED.lit, FIXED.dist);
      else if (type === 2) this.dynamic();
      else throw new InflateError("INFLATE_CORRUPT", "invalid block type");
    } while (!last);
  }
}

/**
 * Decompress a raw DEFLATE stream. `expectedSize` (e.g. a zip entry's recorded size) sizes the first buffer;
 * `maxSize` caps the output (throws `INFLATE_TOO_LARGE`).
 */
export function inflateRaw(data: Uint8Array, options: { expectedSize?: number; maxSize?: number } = {}): Uint8Array {
  const max = options.maxSize ?? 1024 * 1024 * 1024;
  const inf = new Inflater(data, options.expectedSize ?? data.length * 4, max);
  inf.run();
  return inf.out.slice(0, inf.outLen);
}
