/**
 * `typecheck(source)`: run the real TypeScript checker over a CadScript file, with the
 * `@aicad/std` declarations (`std/index.d.ts`) mounted as a virtual module. This gives agents and
 * editors tsc-level errors (wrong argument types, typos in builtin names, …) in addition to the
 * CadScript compiler's own diagnostics.
 *
 * Environment-independent: no file system access. Instead of the full ES lib it uses a minimal
 * built-in lib, which is all CadScript needs (it never calls into the JS runtime).
 */
import ts from "typescript";
import type { Diagnostic, Severity } from "./diagnostics.js";
import { STD_DTS } from "./generated/std-dts.js";
import { STD_MODULE } from "./syntax.js";

const MAIN_PATH = "/main.cad.ts";
const STD_PATH = "/node_modules/@aicad/std/index.d.ts";
const LIB_PATH = "/lib.cadscript.d.ts";

/** The global types the checker requires, and nothing else: CadScript code never touches the JS runtime. */
const MIN_LIB = `
interface Array<T> { length: number; [n: number]: T; }
interface ReadonlyArray<T> { readonly length: number; readonly [n: number]: T; }
interface Boolean {}
interface Function {}
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface IArguments {}
interface Number {}
interface Object {}
interface RegExp {}
interface String {}
interface Symbol {}
interface TemplateStringsArray extends ReadonlyArray<string> { readonly raw: readonly string[]; }
`;

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noLib: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  types: [],
};

let cached: { std: ts.SourceFile; lib: ts.SourceFile } | undefined;
function libs(): { std: ts.SourceFile; lib: ts.SourceFile } {
  cached ??= {
    std: ts.createSourceFile(STD_PATH, STD_DTS, ts.ScriptTarget.ES2022, true),
    lib: ts.createSourceFile(LIB_PATH, MIN_LIB, ts.ScriptTarget.ES2022, true),
  };
  return cached;
}

function createProgram(source: string): { program: ts.Program; main: ts.SourceFile } {
  const { std, lib } = libs();
  const main = ts.createSourceFile(MAIN_PATH, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const files = new Map<string, ts.SourceFile>([
    [MAIN_PATH, main],
    [STD_PATH, std],
    [LIB_PATH, lib],
  ]);
  const host: ts.CompilerHost = {
    getSourceFile: (fileName) => files.get(fileName),
    getDefaultLibFileName: () => LIB_PATH,
    writeFile: () => undefined,
    getCurrentDirectory: () => "/",
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (f) => files.has(f),
    readFile: (f) => files.get(f)?.text,
    resolveModuleNameLiterals: (literals) =>
      literals.map((lit) => ({
        resolvedModule:
          lit.text === STD_MODULE
            ? { resolvedFileName: STD_PATH, extension: ts.Extension.Dts, isExternalLibraryImport: false }
            : undefined,
      })),
  };
  const program = ts.createProgram({ rootNames: [MAIN_PATH, LIB_PATH], options: OPTIONS, host });
  return { program, main };
}

function severity(c: ts.DiagnosticCategory): Severity {
  return c === ts.DiagnosticCategory.Error ? "error" : c === ts.DiagnosticCategory.Warning ? "warning" : "info";
}

function convert(d: ts.Diagnostic, main: ts.SourceFile): Diagnostic {
  const inMain = d.file === main && d.start !== undefined;
  const start = inMain ? main.getLineAndCharacterOfPosition(d.start!) : { line: 0, character: 0 };
  const end = inMain ? main.getLineAndCharacterOfPosition(d.start! + (d.length ?? 0)) : start;
  const where = !inMain && d.file ? ` (in ${d.file.fileName})` : "";
  return {
    code: `TS${d.code}`,
    severity: severity(d.category),
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n") + where,
    span: { start: { line: start.line + 1, col: start.character + 1 }, end: { line: end.line + 1, col: end.character + 1 } },
  };
}

/**
 * Type-check CadScript source against `@aicad/std`. Returns TypeScript's diagnostics for the file
 * (code `TS####`), e.g. `TS2322` for `distance: "8"`. An empty array means the file type-checks.
 */
export function typecheck(source: string): Diagnostic[] {
  const { program, main } = createProgram(source);
  const diags = [
    ...program.getOptionsDiagnostics(),
    ...program.getGlobalDiagnostics(),
    ...program.getSyntacticDiagnostics(main),
    ...program.getSemanticDiagnostics(main),
  ];
  return diags.map((d) => convert(d, main));
}

/** @internal Diagnostics of the std declarations themselves (must be empty). */
export function stdLibDiagnostics(): Diagnostic[] {
  const { program, main } = createProgram(`import {} from "${STD_MODULE}";\n`);
  const std = program.getSourceFile(STD_PATH)!;
  return [...program.getSyntacticDiagnostics(std), ...program.getSemanticDiagnostics(std)].map((d) => convert(d, main));
}
