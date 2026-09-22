/** A position in a source file. `line` and `col` are **1-based**; `col` counts UTF-16 code units (as Monaco does). */
export interface Position {
  line: number;
  col: number;
}

/** A source range; `end` is exclusive. */
export interface Span {
  start: Position;
  end: Position;
}

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  /** Stable machine-readable code (see {@link DIAGNOSTIC_CODES}); `TS####` for type-checker diagnostics. */
  code: string;
  severity: Severity;
  message: string;
  /** How to fix it — written for both people and LLM agents. */
  hint?: string;
  span: Span;
  /** For IR validation diagnostics: the JSON-pointer-like IR path (same as forge-ir's `ValidationError.path`). */
  irPath?: string;
}

/**
 * Every diagnostic code produced by the CadScript compiler.
 *
 * `CS_*` codes come from the CadScript front end. The unprefixed codes mirror forge-ir's
 * `validate.rs` one-to-one (same code, same IR path), so a structural error reported by the Rust
 * engine maps directly onto the code that caused it.
 */
export const DIAGNOSTIC_CODES = {
  // Front end.
  CS_SYNTAX: { severity: "error", summary: "TypeScript syntax error." },
  CS_BAD_IMPORT: { severity: "error", summary: "Imports must be `import { … } from \"@aicad/std\"`, before any other statement." },
  CS_NOT_IMPORTED: { severity: "error", summary: "A builtin is used without being imported from @aicad/std." },
  CS_UNKNOWN_BUILTIN: { severity: "error", summary: "Call to (or import of) something that is not a CadScript v0 builtin, or the wrong builtin in this position." },
  CS_STATEMENT_UNSUPPORTED: { severity: "error", summary: "A statement form that CadScript v0 does not accept (let/var, loops, if, functions, …)." },
  CS_EXPR_UNSUPPORTED: { severity: "error", summary: "A non-literal expression (arithmetic, variables, calls, template strings, spreads, …)." },
  CS_BAD_ARGUMENT: { severity: "error", summary: "Wrong argument count, literal type, tuple length, or an unknown/missing property." },
  CS_DOC_MISPLACED: { severity: "error", summary: "doc() must be the first statement after the imports and appear at most once." },
  CS_MISSING_PART: { severity: "error", summary: "A feature appears before any part(\"…\") statement." },
  CS_DUPLICATE_NAME: { severity: "error", summary: "Two feature consts share a name (names are unique per file)." },
  CS_RESERVED_NAME: { severity: "error", summary: "A feature const is named like a @aicad/std builtin or a reserved global." },
  CS_UNRESOLVED_SKETCH: { severity: "error", summary: "extrude/revolve does not reference an earlier sketch const of the same part." },
  CS_RENAME_DETECTED: { severity: "info", summary: "A feature (or part) was matched to the base IR as a rename; its id was kept." },
  // Mirrors of forge-ir validate.rs.
  UNSUPPORTED_SCHEMA: { severity: "error", summary: "`schema` is not \"aicad.ir/0\"." },
  NO_PARTS: { severity: "error", summary: "A document needs at least one part studio." },
  DUPLICATE_ID: { severity: "error", summary: "Duplicate part, feature or curve id." },
  DUPLICATE_NAME: { severity: "error", summary: "Duplicate part name, or duplicate feature name anywhere in the document." },
  INVALID_NAME: { severity: "error", summary: "Feature name does not match [A-Za-z_][A-Za-z0-9_]*." },
  UNRESOLVED_SKETCH: { severity: "error", summary: "Feature references a sketch that is not an earlier sketch of the same part." },
  INVALID_DISTANCE: { severity: "error", summary: "Extrude distance must be finite and > 1e-6 mm." },
  INVALID_ANGLE: { severity: "error", summary: "Revolve angle must be in (0, 360] degrees." },
  INVALID_AXIS: { severity: "error", summary: "Revolve axis must be finite with a non-zero direction." },
  INVALID_PLANE: { severity: "error", summary: "Degenerate frame, or normal not perpendicular to xDir." },
  EMPTY_SKETCH: { severity: "error", summary: "A sketch needs at least one curve." },
  NON_FINITE: { severity: "error", summary: "A curve coordinate or radius is not finite." },
  RESERVED_NAME: { severity: "error", summary: "Feature name is a reserved word or CadScript builtin." },
  DEGENERATE_CURVE: { severity: "error", summary: "Zero-length line, zero-radius arc/circle, or arc with start == end." },
  INCONSISTENT_ARC: { severity: "error", summary: "|start − center| ≠ |end − center| for an arc." },
} as const satisfies Record<string, { severity: Severity; summary: string }>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/** Human-readable one-line rendering: `file:line:col - error CODE: message (hint: …)`. */
export function formatDiagnostic(d: Diagnostic, fileName = "<input>"): string {
  const head = `${fileName}:${d.span.start.line}:${d.span.start.col} - ${d.severity} ${d.code}: ${d.message}`;
  return d.hint ? `${head}\n    hint: ${d.hint}` : head;
}

export function compareSpans(a: Span, b: Span): number {
  return a.start.line - b.start.line || a.start.col - b.start.col || a.end.line - b.end.line || a.end.col - b.end.col;
}

export function hasErrors(diags: readonly Diagnostic[]): boolean {
  return diags.some((d) => d.severity === "error");
}
