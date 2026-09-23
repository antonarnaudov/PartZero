/**
 * CadScript v1 (`aicad.ir/1`): the compiler, printer, edit splicer, type checker and IR v1
 * helpers. Exported from the package root as the namespace `v1` and from `@aicad/cadscript/v1`.
 *
 * - {@link compile}: source → IR v1 (canonical), with diagnostics (IR codes mirrored with spans,
 *   `CS_*` codes for the front end) and source maps. v0 sources compile to their migration.
 * - {@link print}: IR (v1, or v0 through its migration) → canonical source; a document that cannot
 *   be printed throws {@link CadScriptPrintError} with machine-readable {@link PrintProblem}s
 *   (`CS_RESERVED_NAME`: offer renameFeature; `CS_TOO_COMPLEX`; `CS_NOT_PRINTABLE`).
 * - {@link applyIrEdit}: splice an IR edit into existing source (query aliases kept consistent;
 *   the result is checked to compile to the new IR).
 * - {@link typecheck}: tsc diagnostics against the `@aicad/std` v1 declarations ({@link STD_DTS}).
 * - {@link loadIrText}, {@link loadIrDocument}, {@link validate}, {@link precheck}: the IR v1 rejection
 *   pipeline, from JSON text (read as forge-ir reads it: {@link parseIrJsonText}) or a parsed value.
 * - {@link migrateV0ToV1}, {@link toJson}: migration and canonical JSON text, byte-identical to forge-ir;
 *   {@link MAX_JSON_NESTING}: the deepest IR JSON forge-ir reads (compile and print respect it).
 * - {@link parseExpr}, {@link printExpr}, {@link checkAtField}: the expression language (no evaluator).
 */
export {
  analyzeV1 as analyze,
  compileV1 as compile,
  spanForIrPathV1 as spanForIrPath,
  type CompileOptionsV1 as CompileOptions,
  type CompileResultV1 as CompileResult,
  type SourceStatementV1 as SourceStatement,
} from "./compile.js";
export type { DiagnosticV1 as Diagnostic, FixEdit } from "./context.js";
export { CS_CODES_V1, DIAGNOSTIC_CODES_V1 as DIAGNOSTIC_CODES, IR_CODES_V1, hintFor, type CodeInfo } from "./diagnostics.js";
export {
  canonicalize as canonicalizeExpr,
  checkAtField,
  formatType,
  parseExpr,
  printExpr,
  typeOf,
  type Expr,
  type FieldType,
  type ParamUnit,
  type Ty,
  type TypeEnv,
} from "./expr.js";
export { checkId, checkRef, isId, isRef, sanitize } from "./ids.js";
export { canonicalDocument, formatF64, jsonNesting, MAX_JSON_NESTING, toJson } from "./json.js";
export { isV0Document, migrateV0ToV1, migrateV0ToV1Report, type IdRename, type MigrationReport } from "./migrate.js";
export {
  asV1,
  CadScriptV1PrintError as CadScriptPrintError,
  printabilityProblemsV1 as printabilityProblems,
  printImportV1 as printImport,
  printV1 as print,
  type PrintOptionsV1 as PrintOptions,
  type PrintProblemV1 as PrintProblem,
} from "./print.js";
export {
  applyIrEditV1 as applyIrEdit,
  applyIrEditCheckedV1 as applyIrEditChecked,
  CadScriptV1EditError as CadScriptEditError,
  type SpliceResultV1 as SpliceResult,
} from "./splice.js";
export { BUILTINS_V1 as BUILTINS, RESERVED_NAMES_V1 as RESERVED_NAMES } from "./syntax.js";
export { typecheckV1 as typecheck } from "./typecheck.js";
export { loadIrDocument, loadIrText, precheckV1 as precheck, validateV1 as validate, type LoadResult, type V1ValidationError as ValidationError } from "./validate.js";
export { JsonTextError, parseIrJsonText, parseV0JsonText, parseV1JsonText } from "./v0json.js";
export { STD_V1_DTS as STD_DTS } from "../generated/std-v1-dts.js";
/** CadScript v1's nesting limits (pass `LIMITS` to the root `parseWithinLimits` to parse v1 source as `compile` does). */
export { LIMITS_V1 as LIMITS, MAX_BRACKET_DEPTH_V1 as MAX_BRACKET_DEPTH, MAX_SYNTAX_DEPTH_V1 as MAX_SYNTAX_DEPTH } from "../complexity.js";
