/**
 * @aicad/cadscript — CadScript: a statically compiled subset of TypeScript that compiles to the
 * Feature-Graph IR and prints back from it losslessly.
 *
 * The root exports are CadScript **v0** (`aicad.ir/0`), unchanged while the consumers migrate.
 * **CadScript v1** (`aicad.ir/1`: parameters, expressions, compound curves, constraints,
 * references, holes, blends, patterns, datums) is the namespace {@link v1} (also
 * `@aicad/cadscript/v1`); v0 sources are valid v1 sources and compile to their migration.
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
  type NestingLimits,
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
/** CadScript v1 (`aicad.ir/1`): `v1.compile`, `v1.print`, `v1.applyIrEdit`, `v1.typecheck`, … */
export * as v1 from "./v1/index.js";
