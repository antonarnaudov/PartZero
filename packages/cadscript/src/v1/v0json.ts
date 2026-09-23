/**
 * Reading IR JSON **text** exactly as forge-ir does (SPEC-v1 §0.4, §0.5 step 1, [W0-11]).
 *
 * `forge_ir::VersionedDocument::from_json` reads text in two passes, and so does
 * {@link parseIrJsonText}:
 *
 * 1. serde_json into a `Value`, only to find `schema`: RFC 8259; at most 127 nested arrays and
 *    objects (serde_json's recursion limit); no lone surrogates (escaped or raw); numbers within
 *    the f64 range; a duplicate key is not an error there (the last one wins).
 * 2. By schema. `aicad.ir/0`: serde_json's typed parse ({@link parseV0JsonText}), which also
 *    rejects duplicate keys (every v0 object is a struct: "duplicate field") and reads numbers
 *    with serde_json's default algorithm, which is **not** correctly rounded: it converts the
 *    decimal significand to `f64` and multiplies or divides by one power of ten, so about one in
 *    eight 17-digit decimals lands one ulp away from `JSON.parse`'s value. The migration fixtures
 *    (e.g. MakerBench `t2-cable-organizer`) record Rust's values; {@link serdeJsonF64} is
 *    serde_json 1.0's algorithm (`de.rs`: `parse_integer` … `f64_from_parts`, without the
 *    `float_roundtrip` feature). `aicad.ir/1`: `forge_ir::v1::json::parse`
 *    ({@link parseV1JsonText}), a strict reader: duplicate keys are rejected (at the key's byte
 *    offset), values nest at most 128 deep, strings may not hold control characters or lone
 *    surrogates, numbers are correctly rounded and must be finite, and an integer token is read
 *    as `u64`/`i64` first (so `-0` reads as `0`, while `-0.0` stays `-0`).
 *
 * The readers never call `JSON.parse`, so the result does not depend on the host (older engines
 * do not pass a number's source text to revivers). Errors are {@link JsonTextError}s with the
 * UTF-8 byte offset, as Rust's `JsonError`. Objects get their keys as own data properties, as
 * `JSON.parse` gives them (`"__proto__"` is an ordinary key).
 */

import { byteLength, isId } from "./ids.js";

const U64_MAX = 18446744073709551615n;
const I32_MAX = 2147483647;

/** `overflow!(a * 10 + b, max)` of serde_json. */
function overflows(a: bigint, b: bigint, max: bigint): boolean {
  return a >= max / 10n && (a > max / 10n || b > max % 10n);
}

let POW10: number[] | undefined;
function pow10(i: number): number | undefined {
  POW10 ??= Array.from({ length: 309 }, (_, k) => Number(`1e${k}`));
  return POW10[i];
}

class NumberOutOfRange extends Error {}

/** serde_json's `f64_from_parts` (non-`float_roundtrip`). */
function f64FromParts(positive: boolean, significand: bigint, exponent: number): number {
  let f = Number(significand); // u64 → f64, round to nearest even (Rust `as`)
  for (;;) {
    const pow = Math.abs(exponent) <= 308 ? pow10(Math.abs(exponent)) : undefined;
    if (pow !== undefined) {
      if (exponent >= 0) {
        f *= pow;
        if (!Number.isFinite(f)) throw new NumberOutOfRange();
      } else {
        f /= pow;
      }
      break;
    }
    if (f === 0) break;
    if (exponent >= 0) throw new NumberOutOfRange();
    f /= 1e308;
    exponent += 308;
  }
  return positive ? f : -f;
}

/** The `f64` serde_json (default features) reads for a JSON number token. */
export function serdeJsonF64(token: string): number {
  let i = 0;
  const positive = token[0] !== "-";
  if (!positive) i++;
  const peek = (): string | undefined => token[i];
  const digit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

  const parseExponent = (significand: bigint, startingExp: number): number => {
    i++; // e / E
    let positiveExp = true;
    if (peek() === "+") i++;
    else if (peek() === "-") {
      positiveExp = false;
      i++;
    }
    let exp = Number(token[i++]);
    while (digit(peek())) {
      const d = Number(token[i++]);
      if (exp >= Math.floor(I32_MAX / 10) && (exp > Math.floor(I32_MAX / 10) || d > I32_MAX % 10)) {
        if (significand !== 0n && positiveExp) throw new NumberOutOfRange();
        while (digit(peek())) i++;
        return positive ? 0 : -0;
      }
      exp = exp * 10 + d;
    }
    const clamp = (x: number): number => Math.max(-2147483648, Math.min(I32_MAX, x));
    return f64FromParts(positive, significand, clamp(positiveExp ? startingExp + exp : startingExp - exp));
  };

  const parseDecimal = (significand: bigint, before: number): number => {
    i++; // .
    let after = 0;
    while (digit(peek())) {
      const d = BigInt(token[i]!);
      if (overflows(significand, d, U64_MAX)) {
        while (digit(peek())) i++;
        return peek() === "e" || peek() === "E" ? parseExponent(significand, before + after) : f64FromParts(positive, significand, before + after);
      }
      i++;
      significand = significand * 10n + d;
      after -= 1;
    }
    const exponent = before + after;
    return peek() === "e" || peek() === "E" ? parseExponent(significand, exponent) : f64FromParts(positive, significand, exponent);
  };

  const parseNumber = (significand: bigint): number => {
    const c = peek();
    if (c === ".") return parseDecimal(significand, 0);
    if (c === "e" || c === "E") return parseExponent(significand, 0);
    // U64 / I64 / F64 → f64 all round the magnitude the same way.
    const f = Number(significand);
    return positive ? f : -f;
  };

  if (token[i] === "0") {
    i++;
    return parseNumber(0n);
  }
  let significand = BigInt(token[i++]!);
  while (digit(peek())) {
    const d = BigInt(token[i]!);
    if (overflows(significand, d, U64_MAX)) {
      // parse_long_integer: the remaining integer digits only raise the exponent.
      let exponent = 0;
      while (digit(peek())) {
        i++;
        exponent++;
      }
      const c = peek();
      if (c === ".") return parseDecimal(significand, exponent);
      if (c === "e" || c === "E") return parseExponent(significand, exponent);
      return f64FromParts(positive, significand, exponent);
    }
    i++;
    significand = significand * 10n + d;
  }
  return parseNumber(significand);
}


/** A JSON syntax error at a UTF-8 byte offset (Rust `forge_ir::v1::json::JsonError`). */
export class JsonTextError extends SyntaxError {
  readonly offset: number;
  readonly reason: string;
  constructor(offset: number, reason: string) {
    super(`JSON syntax error at byte ${offset}: ${reason}`);
    this.name = "JsonTextError";
    this.offset = offset;
    this.reason = reason;
  }
}

interface ReadMode {
  /** A second occurrence of a key: an error, or the last one wins (serde_json's `Value`). */
  duplicates: "reject" | "last";
  /** Rust v1: a value nested deeper than this (the top level is 0) is an error. */
  maxValueDepth: number;
  /** serde_json: this many nested arrays/objects is an error (its recursion limit, 128). */
  maxContainers: number;
  /** Rust v1 `u32::from_str_radix` accepts a `+` before the hex digits of `\u`. */
  plusInHex: boolean;
  /** A number token's value; `undefined` when it is out of the f64 range. */
  number: (token: string, integer: boolean) => number | undefined;  /**
   * Rust v1: remember the integer-valued numbers read as `f64` (see {@link isFloatToken}), which
   * forge-ir's `u32` fields reject although JavaScript cannot tell `3.0` from `3`.
   */
  floats: boolean;
}

const I64_MIN = -9223372036854775808n;

/** `forge_ir::v1::json` numbers: `u64`, then `i64`, then a correctly rounded `f64`. */
function v1Number(token: string, integer: boolean): number | undefined {
  if (integer) {
    const n = BigInt(token); // exact
    // `t.parse::<u64>()` (no sign), then `t.parse::<i64>()`: `-0` is the integer 0. The integer
    // becomes an f64 by rounding to nearest (Rust `as`, ECMAScript `Number`), as the decimal would.
    if (token.startsWith("-") ? n >= I64_MIN : n <= U64_MAX) return Number(n);
  }
  const f = Number(token);
  return Number.isFinite(f) ? f : undefined;
}

/** serde_json numbers (default features). */
function serdeNumber(token: string): number | undefined {
  try {
    return serdeJsonF64(token);
  } catch (e) {
    if (e instanceof NumberOutOfRange) return undefined;
    throw e;
  }
}

const SERDE_VALUE: ReadMode = { duplicates: "last", maxValueDepth: Infinity, maxContainers: 128, plusInHex: false, number: serdeNumber, floats: false };
const SERDE_TYPED: ReadMode = { ...SERDE_VALUE, duplicates: "reject" };
const FORGE_V1: ReadMode = { duplicates: "reject", maxValueDepth: 128, maxContainers: Infinity, plusInHex: true, number: v1Number, floats: true };

/** Container → the keys (object) or indices (array) whose value is an integer read as an `f64`. */
const FLOAT_TOKENS = new WeakMap<object, Set<string>>();

/**
 * Whether `container[key]` was read by {@link parseV1JsonText} from a number token that
 * forge-ir's reader keeps as an `f64` although its value is an integer: a token with a fraction
 * or an exponent (`3.0`, `3e0`, `-0.0`), or an integer beyond `u64`/`i64`. serde_json's `as_u64`
 * is `None` for such a number and its typed parse rejects it in a `u32` field, so the v1
 * pre-checks and typed parse (`v`, `card`, instance indices, `skip`, `neighbors`) must reject it
 * too, while JavaScript reads `3.0` as `3`. Values not read from v1 text: always false.
 */
export function isFloatToken(container: object, key: string | number): boolean {
  return FLOAT_TOKENS.get(container)?.has(String(key)) ?? false;
}

function markFloat(container: object, key: string): void {
  let keys = FLOAT_TOKENS.get(container);
  if (!keys) FLOAT_TOKENS.set(container, (keys = new Set()));
  keys.add(key);
}

/** Whether an integer token is within `u64` (unsigned) or `i64` (signed): `forge_ir::v1::json` reads it as an integer. */
function fitsInteger(token: string): boolean {
  if (token.length < 19) return true;
  const n = BigInt(token);
  return token.startsWith("-") ? n >= I64_MIN : n <= U64_MAX;
}

const isHex = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const isDigit = (c: number | undefined): boolean => c !== undefined && c >= 48 && c <= 57;

class Reader {
  private i = 0;
  private containers = 0;
  /** The last number token was read as an `f64` (see {@link isFloatToken}). */
  private lastFloat = false;
  constructor(
    private readonly s: string,
    private readonly mode: ReadMode,
  ) {}

  private fail(reason: string, at = this.i): never {
    throw new JsonTextError(byteLength(this.s.slice(0, at)), reason);
  }

  private code(): number | undefined {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : undefined;
  }

  private ws(): void {
    for (;;) {
      const c = this.code();
      if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return;
      this.i++;
    }
  }

  read(): unknown {
    this.ws();
    const v = this.value(0);
    this.ws();
    if (this.i !== this.s.length) this.fail("trailing characters");
    return v;
  }

  private value(depth: number): unknown {
    if (depth > this.mode.maxValueDepth) this.fail("nesting too deep");
    const c = this.code();
    switch (c) {
      case undefined:
        return this.fail("unexpected end of input");
      case 0x7b: // {
        return this.container(() => this.object(depth));
      case 0x5b: // [
        return this.container(() => this.array(depth));
      case 0x22: // "
        return this.string();
      case 0x74: // t
        return this.literal("true", true);
      case 0x66: // f
        return this.literal("false", false);
      case 0x6e: // n
        return this.literal("null", null);
      default:
        if (c === 0x2d || isDigit(c)) return this.number();
        return this.fail("unexpected character");
    }
  }

  private container(f: () => unknown): unknown {
    if (++this.containers >= this.mode.maxContainers) this.fail("recursion limit exceeded");
    const v = f();
    this.containers--;
    return v;
  }

  private literal(word: string, v: unknown): unknown {
    if (!this.s.startsWith(word, this.i)) this.fail("invalid literal");
    this.i += word.length;
    return v;
  }

  private object(depth: number): Record<string, unknown> {
    this.i++;
    const out: Record<string, unknown> = {};
    this.ws();
    if (this.code() === 0x7d) {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.code() !== 0x22) this.fail("expected a string key");
      const at = this.i;
      const k = this.string();
      this.ws();
      if (this.code() !== 0x3a) this.fail("expected ':'");
      this.i++;
      this.ws();
      const v = this.value(depth + 1);
      if (this.mode.floats && typeof v === "number" && this.lastFloat && Number.isInteger(v)) markFloat(out, k);
      if (Object.prototype.hasOwnProperty.call(out, k) && this.mode.duplicates === "reject") {
        // [W0-12]: a key is echoed only when it is an id.
        this.fail(isId(k) ? `duplicate key ${JSON.stringify(k)}` : "duplicate key", at);
      }
      Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
      this.ws();
      const c = this.code();
      if (c === 0x2c) this.i++;
      else if (c === 0x7d) {
        this.i++;
        return out;
      } else this.fail("expected ',' or '}'");
    }
  }

  private array(depth: number): unknown[] {
    this.i++;
    const out: unknown[] = [];
    this.ws();
    if (this.code() === 0x5d) {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const v = this.value(depth + 1);
      if (this.mode.floats && typeof v === "number" && this.lastFloat && Number.isInteger(v)) markFloat(out, String(out.length));
      out.push(v);
      this.ws();
      const c = this.code();
      if (c === 0x2c) this.i++;
      else if (c === 0x5d) {
        this.i++;
        return out;
      } else this.fail("expected ',' or ']'");
    }
  }

  private hex4(): number {
    let t = this.s.slice(this.i, this.i + 4);
    if (t.length < 4) this.fail("short \\u escape");
    if (this.mode.plusInHex && t[0] === "+") t = t.slice(1);
    for (let k = 0; k < t.length; k++) if (!isHex(t.charCodeAt(k))) this.fail("bad \\u escape");
    this.i += 4;
    return parseInt(t, 16);
  }

  private string(): string {
    this.i++;
    let out = "";
    for (;;) {
      const start = this.i;
      for (;;) {
        const c = this.code();
        if (c === undefined || c === 0x22 || c === 0x5c || c < 0x20) break;
        if (c >= 0xd800 && c <= 0xdfff) {
          // A raw surrogate must be half of a pair: the text is UTF-8 on the Rust side.
          const d = this.s.charCodeAt(this.i + 1);
          if (c > 0xdbff || !(d >= 0xdc00 && d <= 0xdfff)) this.fail("lone surrogate");
          this.i += 2;
          continue;
        }
        this.i++;
      }
      out += this.s.slice(start, this.i);
      const c = this.code();
      if (c === undefined) this.fail("unterminated string");
      if (c === 0x22) {
        this.i++;
        return out;
      }
      if (c !== 0x5c) this.fail("control character in string");
      this.i++;
      const e = this.code();
      if (e === undefined) this.fail("bad escape");
      this.i++;
      switch (e) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += "\\";
          break;
        case 0x2f:
          out += "/";
          break;
        case 0x62:
          out += "\b";
          break;
        case 0x66:
          out += "\f";
          break;
        case 0x6e:
          out += "\n";
          break;
        case 0x72:
          out += "\r";
          break;
        case 0x74:
          out += "\t";
          break;
        case 0x75: {
          const hi = this.hex4();
          if (hi >= 0xd800 && hi < 0xdc00) {
            if (!this.s.startsWith("\\u", this.i)) this.fail("lone surrogate");
            this.i += 2;
            const lo = this.hex4();
            if (!(lo >= 0xdc00 && lo < 0xe000)) this.fail("bad surrogate pair");
            out += String.fromCharCode(hi, lo);
          } else if (hi >= 0xdc00 && hi < 0xe000) {
            this.fail("lone surrogate");
          } else out += String.fromCharCode(hi);
          break;
        }
        default:
          this.fail("bad escape");
      }
    }
  }

  private number(): number {
    const start = this.i;
    const digits = (): number => {
      const s = this.i;
      while (isDigit(this.code())) this.i++;
      return this.i - s;
    };
    if (this.code() === 0x2d) this.i++;
    const first = this.code();
    if (first === 0x30) this.i++;
    else if (isDigit(first)) digits();
    else this.fail("invalid number");
    let integer = true;
    if (this.code() === 0x2e) {
      this.i++;
      integer = false;
      if (digits() === 0) this.fail("invalid number");
    }
    const e = this.code();
    if (e === 0x65 || e === 0x45) {
      this.i++;
      integer = false;
      const sign = this.code();
      if (sign === 0x2b || sign === 0x2d) this.i++;
      if (digits() === 0) this.fail("invalid number");
    }
    const token = this.s.slice(start, this.i);
    this.lastFloat = !integer || !fitsInteger(token);
    const v = this.mode.number(token, integer);
    if (v === undefined) this.fail(`number ${token} is out of the f64 range`, start);
    return v;
  }
}

/** serde_json's `from_str::<Value>`: the first pass of `VersionedDocument::from_json` (finds `schema`). */
export function parseSerdeJsonValue(text: string): unknown {
  return new Reader(text, SERDE_VALUE).read();
}

/**
 * `aicad.ir/0` text as forge-ir reads it: serde_json's typed parse (duplicate keys rejected,
 * numbers by {@link serdeJsonF64}).
 */
export function parseV0JsonText(text: string): unknown {
  return new Reader(text, SERDE_TYPED).read();
}

/** `aicad.ir/1` text as `forge_ir::v1::json::parse` reads it (strict; correctly rounded numbers). */
export function parseV1JsonText(text: string): unknown {
  return new Reader(text, FORGE_V1).read();
}

/**
 * IR JSON text of either version, read as forge-ir reads it (`VersionedDocument::from_json`,
 * before validation): the serde_json pass, then the reader of the document's `schema`. Text of
 * another schema returns the first pass's value (loading it is `UNSUPPORTED_SCHEMA`).
 *
 * @throws {JsonTextError} when either pass rejects the text.
 */
export function parseIrJsonText(text: string): unknown {
  const value = parseSerdeJsonValue(text);
  const schema = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { schema?: unknown }).schema : undefined;
  if (schema === "aicad.ir/0") return parseV0JsonText(text);
  if (schema === "aicad.ir/1") return parseV1JsonText(text);
  return value;
}
