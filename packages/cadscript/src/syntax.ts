/** Shared lexical facts about CadScript v0. */

/** The module every CadScript file imports its builtins from. */
export const STD_MODULE = "@aicad/std";

/** Every export of `@aicad/std`, in canonical import order. */
export const BUILTINS = ["doc", "part", "sketch", "line", "arc", "circle", "extrude", "revolve", "frame", "XY", "XZ", "YZ"] as const;
export type Builtin = (typeof BUILTINS)[number];

export const FEATURE_BUILTINS = ["sketch", "extrude", "revolve"] as const;
export type FeatureBuiltin = (typeof FEATURE_BUILTINS)[number];
export const CURVE_BUILTINS = ["line", "arc", "circle"] as const;
export const PLANE_CONSTANTS = ["XY", "XZ", "YZ"] as const;
export const SWEEP_DIRECTIONS = ["normal", "reverse", "symmetric"] as const;

export function isBuiltin(name: string): name is Builtin {
  return (BUILTINS as readonly string[]).includes(name);
}

/**
 * How to get the v1 language from a v0 compile: CadScript v1 is the `cadscript` CLI's default and
 * the `v1` namespace (`@aicad/cadscript/v1`); v0 sources are v1 sources, so nothing else changes.
 */
export const COMPILE_AS_V1 = "compile the file as CadScript v1 (the cadscript CLI's default; compile() of @aicad/cadscript/v1)";

/** Builtins of later CadScript versions (v1, or after it), with a pointer for the hint text. */
export const FUTURE_BUILTINS: Readonly<Record<string, string>> = {
  param: `param() is CadScript v1: ${COMPILE_AS_V1}`,
  rect: `rect() is CadScript v1: ${COMPILE_AS_V1}`,
  polygon: `polygon() is CadScript v1: ${COMPILE_AS_V1}`,
  hole: `hole() is CadScript v1: ${COMPILE_AS_V1}`,
  fillet: `fillet() is CadScript v1: ${COMPILE_AS_V1}`,
  chamfer: `chamfer() is CadScript v1: ${COMPILE_AS_V1}`,
  shell: `shell() is CadScript v1: ${COMPILE_AS_V1}`,
  pattern: `patterns are CadScript v1 (linearPattern, circularPattern, mirror): ${COMPILE_AS_V1}`,
  mirror: `mirror() is CadScript v1: ${COMPILE_AS_V1}`,
  boolean: `boolean() is CadScript v1: ${COMPILE_AS_V1}`,
  union: `booleans are CadScript v1 (boolean(), or op on extrude/revolve): ${COMPILE_AS_V1}`,
  cut: `booleans are CadScript v1 (boolean(), or op on extrude/revolve): ${COMPILE_AS_V1}`,
  customFeature: "customFeature() (sandboxed loops) arrives after v1",
};

/** JavaScript/TypeScript words that cannot be a `const` name, plus globals we refuse to shadow. */
export const RESERVED_WORDS: ReadonlySet<string> = new Set([
  // ECMAScript reserved words
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do", "else",
  "enum", "export", "extends", "false", "finally", "for", "function", "if", "import", "in", "instanceof",
  "new", "null", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void",
  "while", "with",
  // strict mode / module code
  "implements", "interface", "let", "package", "private", "protected", "public", "static", "yield", "await",
  "arguments", "eval",
  // globals that must not be shadowed
  "undefined", "NaN", "Infinity", "globalThis",
]);

/**
 * forge-ir's `RESERVED_NAMES` (reserved words + v0 builtins). Kept identical to
 * `forge/crates/forge-ir/schema/ir-v0.constants.json`; a test enforces it.
 */
export const IR_RESERVED_NAMES: ReadonlySet<string> = new Set([...RESERVED_WORDS, ...BUILTINS]);

const IDENTIFIER_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** forge-ir's `is_identifier`: `[A-Za-z_][A-Za-z0-9_]*`. */
export const IR_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Can `name` be written as the name of a `const` (in the ASCII subset the printer emits)? */
export function isBindableName(name: string): boolean {
  return IDENTIFIER_NAME.test(name) && !RESERVED_WORDS.has(name);
}

/** Can `key` be written unquoted as an object-literal property name? */
export function isBareKey(key: string): boolean {
  return IDENTIFIER_NAME.test(key);
}

/**
 * Canonical number text: JS shortest round-trip (`String(n)`), except that `-0` prints as `0`.
 * @throws when `n` is not finite (CadScript has no literal for NaN/Infinity).
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new RangeError(`cannot print non-finite number ${n}`);
  return Object.is(n, -0) ? "0" : String(n);
}

/** A JSON-compatible string literal (always double-quoted). */
export function formatString(s: string): string {
  return JSON.stringify(s);
}

/** Optimal-string-alignment edit distance (Levenshtein + adjacent transpositions), for "did you mean …?" hints. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** The closest candidate within a small edit distance, if any. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best !== undefined && bestD <= Math.max(1, Math.floor(name.length / 3)) ? best : undefined;
}
