/**
 * The CadScript language service as the app sees it. `@aicad/cadscript` runs on the TypeScript
 * compiler, so in the app it lives in a worker ({@link WorkerCadScriptService}); tests and
 * worker-less environments use {@link InlineCadScriptService}. Both share {@link compileAndCheck}.
 */
import type { Diagnostic, Span } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";

export interface CompileOutput {
  /** No error diagnostics from the compiler (type-check errors are reported but do not block the IR). */
  ok: boolean;
  ir: IrDocument | null;
  /** Compiler + type-checker diagnostics, sorted by position. */
  diagnostics: Diagnostic[];
  /** Feature id → span of its `const` statement. */
  spans: Record<string, Span>;
  /** Part id → span of its `part("…")` statement. */
  partSpans: Record<string, Span>;
  /** Wall time of compile + type-check, ms. */
  ms: number;
}

/** A CadScript v1 compile: the IR v1 document (canonical) or the first errors. */
export interface CompileV1Output {
  ok: boolean;
  /** `aicad.ir/1` JSON text, or null when there are errors. */
  irJson: string | null;
  /** The first error diagnostics (code, message, 1-based line). */
  errors: Array<{ code: string; message: string; line: number }>;
}

export interface CadScriptService {
  compile(source: string, base?: IrDocument | null): Promise<CompileOutput>;
  /** CadScript v1 (`aicad.ir/1`) → IR v1: starters, `.cad.ts` files written for v1. */
  compileV1(source: string): Promise<CompileV1Output>;
  /** IR v1 JSON text → canonical CadScript v1 (the read-only code view), or null when it cannot be printed. */
  printV1(irJson: string): Promise<string | null>;
  /** IR → canonical CadScript. */
  print(ir: IrDocument): Promise<string>;
  /** Splice an IR edit into existing source, keeping untouched text (and comments) intact. */
  applyIrEdit(source: string, oldIr: IrDocument, newIr: IrDocument): Promise<string>;
  dispose(): void;
}
