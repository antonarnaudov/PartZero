/**
 * Token-level rewriting of SPEC-v1 §2.3 expressions: replace every use of one parameter name.
 * `renameParam` and `deleteParam { uses: "inline" }` rewrite the sites the engine reports
 * (`EXPR_UNKNOWN_NAME` at their paths), and the engine canonicalizes and re-checks the result, so
 * this only has to find identifier tokens correctly:
 *
 * - an identifier is `[A-Za-z_][A-Za-z0-9_]*`;
 * - a unit (`mm`, `cm`, `in`, `deg`) directly after a number is not an identifier;
 * - an identifier followed by `(` (after optional spaces) is a function call, not a name;
 * - digits inside a number (`1e5`) never start an identifier.
 */

const UNITS = new Set(["mm", "cm", "in", "deg"]);

/** Replace every use of the name `from` in `text` by `to` (verbatim text). */
export function replaceName(text: string, from: string, to: string): string {
  let out = "";
  let i = 0;
  let afterNumber = false;
  while (i < text.length) {
    const c = text[i]!;
    if (/[0-9.]/.test(c)) {
      // A number: digits, fraction, exponent.
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j]!)) j++;
      if (j < text.length && /[eE]/.test(text[j]!) && /[0-9+-]/.test(text[j + 1] ?? "")) {
        j += 2;
        while (j < text.length && /[0-9]/.test(text[j]!)) j++;
      }
      out += text.slice(i, j);
      i = j;
      afterNumber = true;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
      const word = text.slice(i, j);
      let k = j;
      while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
      const isCall = text[k] === "(";
      const isUnit = afterNumber && UNITS.has(word);
      out += word === from && !isCall && !isUnit ? to : word;
      i = j;
      afterNumber = false;
      continue;
    }
    if (c !== " " && c !== "\t") afterNumber = false;
    out += c;
    i++;
  }
  return out;
}

/** Whether `text` uses the name (as a name, not a call or unit). */
export function usesName(text: string, name: string): boolean {
  return replaceName(text, name, "\u0000") !== text;
}

/**
 * The literal that stands in for a parameter when its uses are inlined: its evaluated value with
 * its unit (`(12.5 mm)`, `(30 deg)`, `(0.5)`, `true`).
 */
export function inlineLiteral(unit: string, value: number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  const n = Object.is(value, -0) ? 0 : value;
  const text = String(n);
  if (unit === "mm") return `(${text} mm)`;
  if (unit === "deg") return `(${text} deg)`;
  return `(${text})`;
}
