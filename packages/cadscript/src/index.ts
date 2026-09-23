/**
 * @aicad/cadscript — CadScript v0: a statically compiled subset of TypeScript that compiles to the
 * Feature-Graph IR (`aicad.ir/0`) and prints back from it losslessly.
 *
 * - {@link compile}: source → IR, with diagnostics and source maps. Never executes the source.
 * - {@link print}: IR → canonical source.
 * - {@link applyIrEdit}: splice an IR edit into existing source, keeping untouched text intact.
 * - {@link typecheck}: tsc diagnostics against the `@aicad/std` declarations ({@link STD_DTS}),
 *   within fixed work limits (`CS_TOO_COMPLEX` beyond them).
 * - {@link validateIr}: TS mirror of forge-ir's structural validation.
 * - {@link parseWithinLimits}: the nesting-limited TypeScript parse behind compile() and
 *   typecheck(), for tools that parse CadScript themselves (`CS_TOO_COMPLEX` instead of a
 *   stack overflow).
 */
export { compile, spanForIrPath, type CompileOptions, type CompileResult } from "./compile.js";
export {
  MAX_BRACKET_DEPTH,
  MAX_CHECKED_DEPTH,
  MAX_FLOW_STEPS,
  MAX_OVERLOADS,
  MAX_SYNTAX_DEPTH,
  parseWithinLimits,
  tooComplexDiagnostic,
  type GuardedParse,
  type TooComplex,
} from "./complexity.js";
export {
  compareSpans,
  DIAGNOSTIC_CODES,
  formatDiagnostic,
  hasErrors,
  type Diagnostic,
  type DiagnosticCode,
  type Position,
  type Severity,
  type Span,
} from "./diagnostics.js";
export { STD_DTS } from "./generated/std-dts.js";
export {
  CadScriptPrintError,
  print,
  printabilityProblems,
  printCurve,
  printFeatureStatement,
  printImport,
  type PrintOptions,
} from "./print.js";
export { applyIrEdit, CadScriptEditError } from "./splice.js";
export { BUILTINS, formatNumber, STD_MODULE, type Builtin } from "./syntax.js";
export { typecheck } from "./typecheck.js";
export { validateIr, type IrValidationError } from "./validate.js";
