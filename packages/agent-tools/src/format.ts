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

/** Indent every line. */
export function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? by + l : l))
    .join("\n");
}
