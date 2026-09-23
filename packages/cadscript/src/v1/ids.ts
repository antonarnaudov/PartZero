/**
 * The IR v1 id grammar (SPEC-v1 §0.3, [W0-12]) — a port of `forge_ir::v1::ids`.
 *
 * Every author-chosen id and name matches `[A-Za-z_][A-Za-z0-9_]*`, 1 to {@link MAX_ID_LEN}
 * bytes. Strings that *refer* to ids may join up to {@link MAX_REF_SEGMENTS} ids with `.`
 * (`l.start`, `outline.bottom`, `outline.c_br.start`). Validation never echoes a string that
 * fails this grammar.
 */
import { v1 } from "@aicad/ir-types";

export const MAX_ID_LEN: number = v1.MAX_ID_LEN;
export const MAX_REF_SEGMENTS: number = v1.MAX_REF_SEGMENTS;

export type IdProblem = "empty" | "charset" | "too-long";

const ID_CHARS = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** UTF-8 byte length (the grammar's length unit). */
export function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** Check one id or name (Rust `check_id`): charset before length, as in forge-ir. */
export function checkId(s: string): IdProblem | undefined {
  if (s.length === 0) return "empty";
  if (!ID_CHARS.test(s)) return "charset";
  if (s.length > MAX_ID_LEN) return "too-long";
  return undefined;
}

export function isId(s: string): boolean {
  return checkId(s) === undefined;
}

/** Check a reference: 1 to {@link MAX_REF_SEGMENTS} ids joined by `.`. */
export function checkRef(s: string): IdProblem | undefined {
  if (s.length === 0) return "empty";
  const segs = s.split(".");
  if (segs.length > MAX_REF_SEGMENTS) return "charset";
  for (const seg of segs) {
    const p = checkId(seg);
    if (p) return p;
  }
  return undefined;
}

export function isRef(s: string): boolean {
  return checkRef(s) === undefined;
}

/** `s` when it is a valid reference, else a placeholder: what messages and details may show. */
export function shown(s: string): string {
  return isRef(s) ? s : "<invalid id>";
}

/**
 * The deterministic rewrite of a string into an id (migration, [W0-12]): every character outside
 * `[A-Za-z0-9_]` becomes `_`; a leading digit or an empty result gets a `_` prefix; the result is
 * cut to {@link MAX_ID_LEN} bytes (all ASCII by then).
 */
export function sanitize(s: string): string {
  // Rust iterates `chars()` (code points): a surrogate pair is one character.
  let t = "";
  for (const ch of s) t += /^[A-Za-z0-9_]$/.test(ch) ? ch : "_";
  if (t.length === 0 || /^[0-9]/.test(t)) t = `_${t}`;
  return t.slice(0, MAX_ID_LEN);
}

/** `base` if not taken, else `base` (cut to fit) + `_2`, `_3`, … — the first free one. */
export function unique(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const suffix = `_${k}`;
    const candidate = base.slice(0, MAX_ID_LEN - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}
