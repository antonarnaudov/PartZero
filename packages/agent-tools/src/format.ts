/**
 * Compact, deterministic text formatting for tool results. Every result an agent sees must stay
 * under ~2k tokens (ARCHITECTURE §6 "Tools"), so numbers are short and lists are capped.
 */

/** Roughly 3.5 characters per token for code-and-numbers text (conservative for budgeting). */
export const CHARS_PER_TOKEN = 3.5;
/** Hard cap for one tool result: ≈ 2k tokens. */
export const MAX_RESULT_TOKENS = 2000;
export const MAX_RESULT_CHARS = Math.floor(MAX_RESULT_TOKENS * CHARS_PER_TOKEN);

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** A short number: integers as-is, otherwise ≤ 4 decimals (fewer for large magnitudes); `-0` → `0`. */
export function num(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Object.is(x, -0) || Math.abs(x) < 5e-10) return "0";
  if (Number.isInteger(x)) return String(x);
  const a = Math.abs(x);
  const digits = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : 4;
  const s = String(Number(x.toFixed(digits)));
  return s === "-0" ? "0" : s;
}

export function vec(v: readonly number[]): string {
  return `[${v.map(num).join(", ")}]`;
}

/** `80×50×8` */
export function dims(v: readonly number[]): string {
  return v.map(num).join("×");
}

export function pct(x: number): string {
  return `${num(x * 100)}%`;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** `{plane: 6, cylinder: 2}` → `plane 6, cylinder 2` (sorted by name, zeros dropped). */
export function histogram(h: Readonly<Record<string, number>>): string {
  return Object.entries(h)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
}

/** Keep at most `max` items, appending a "… N more" marker. */
export function capList<T>(items: readonly T[], max: number, render: (t: T) => string, more = (n: number) => `… ${n} more`): string[] {
  const out = items.slice(0, max).map(render);
  if (items.length > max) out.push(more(items.length - max));
  return out;
}

/**
 * Clip a result to the token cap. Cuts at a line boundary and says how much was dropped and how
 * to get it (so the model never mistakes a clipped result for the whole thing).
 */
export function clip(text: string, maxChars = MAX_RESULT_CHARS, how = "narrow the request (e.g. one feature)"): string {
  if (text.length <= maxChars) return text;
  const budget = maxChars - 120;
  let cut = text.lastIndexOf("\n", budget);
  if (cut < budget / 2) cut = budget;
  const dropped = text.length - cut;
  return `${text.slice(0, cut)}\n… [clipped ${dropped} chars to stay under ~${MAX_RESULT_TOKENS} tokens; ${how}]`;
}

// ─── Untrusted text ──────────────────────────────────────────────────────────────────────────
//
// Names, ids, doc text and engine/compiler messages come from the user's file (or are derived
// from it). Placed raw into a prompt they could start a new line that imitates an orchestrator
// note, or close a tag or fence. Every tool and prompt string routes them through these helpers.

/** Plain ids (`h1`, `outer_top`, `R2.a`) are shown as-is; anything else is JSON-quoted. */
const PLAIN_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

/** Clip `text` to `max` characters with an ellipsis marker. */
export function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** An identifier from the file: as-is when it is a plain id, else a JSON string (escaped, ≤ 80 chars). */
export function ident(id: string): string {
  return PLAIN_ID.test(id) ? id : jsonQuote(clipText(id, 80));
}

/** Like {@link ident}, but plain ids are single-quoted (`'h1'`) as hints name curves. */
export function quoteId(id: string): string {
  return PLAIN_ID.test(id) ? `'${id}'` : jsonQuote(clipText(id, 80));
}

/** Free text from the file (doc name/description, part names): always a JSON string, clipped. */
export function quoteText(text: string, max = 300): string {
  return jsonQuote(clipText(text, max));
}

/** `JSON.stringify` of a string, also escaping U+2028/U+2029 (which JSON leaves raw). */
export function jsonQuote(text: string): string {
  return JSON.stringify(text).replace(/[\u2028\u2029]/g, escapeControl);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/g;

function escapeControl(c: string): string {
  if (c === "\n") return "\\n";
  if (c === "\r") return "\\r";
  if (c === "\t") return "\\t";
  return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * One line of untrusted text (engine or compiler messages): control characters, line and
 * paragraph separators are escaped (a newline becomes the two characters `\n`), so the text can
 * never start a new line of the prompt.
 */
export function oneLine(text: string, max = 600): string {
  return clipText(text.replace(CONTROL_CHARS, escapeControl), max);
}

/** Indent every line. */
export function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? by + l : l))
    .join("\n");
}
