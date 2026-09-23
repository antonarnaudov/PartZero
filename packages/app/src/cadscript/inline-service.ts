import { applyIrEdit, compareSpans, compile, print, typecheck } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import type { CadScriptService, CompileOutput } from "./service";

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Compile + type-check one CadScript source. Pure; used by both service implementations. */
export function compileAndCheck(source: string, base?: IrDocument | null): CompileOutput {
  const t0 = now();
  const r = compile(source, { base: base ?? undefined, fileName: "main.cad.ts" });
  const hasSyntaxErrors = r.diagnostics.some((d) => d.code === "CS_SYNTAX");
  // CS_SYNTAX already mirrors TypeScript's parse errors (TS1xxx); do not report them twice.
  const tsDiags = typecheck(source).filter((d) => !(hasSyntaxErrors && /^TS1\d{3}$/.test(d.code)));
  const diagnostics = [...r.diagnostics, ...tsDiags].sort((a, b) => compareSpans(a.span, b.span));
  return { ok: r.ok, ir: r.ir, diagnostics, spans: r.spans, partSpans: r.partSpans, ms: now() - t0 };
}

export class InlineCadScriptService implements CadScriptService {
  compile(source: string, base?: IrDocument | null): Promise<CompileOutput> {
    return Promise.resolve(compileAndCheck(source, base));
  }

  print(ir: IrDocument): Promise<string> {
    return Promise.resolve(print(ir));
  }

  applyIrEdit(source: string, oldIr: IrDocument, newIr: IrDocument): Promise<string> {
    return Promise.resolve(applyIrEdit(source, oldIr, newIr));
  }

  dispose(): void {}
}
