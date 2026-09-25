import { applyIrEdit, compareSpans, compile, print, typecheck, v1 } from "@aicad/cadscript";
import type { IrDocument } from "@aicad/ir-types";
import type { CadScriptService, CompileOutput, CompileV1Output } from "./service";

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

/** CadScript v1 → IR v1 JSON text (canonical, byte-identical to forge-ir), or its first errors. */
export function compileV1Text(source: string): CompileV1Output {
  const r = v1.compile(source, { fileName: "main.cad.ts" });
  if (r.ok && r.ir) return { ok: true, irJson: v1.toJson(r.ir), errors: [] };
  const errors = r.diagnostics
    .filter((d) => d.severity === "error")
    .slice(0, 5)
    .map((d) => ({ code: d.code, message: d.message, line: d.span.start.line }));
  return { ok: false, irJson: null, errors };
}

/** IR v1 JSON text → CadScript v1, or null when the document cannot be printed. */
export function printV1Text(irJson: string): string | null {
  try {
    return v1.print(JSON.parse(irJson) as Parameters<typeof v1.print>[0]);
  } catch {
    return null;
  }
}

export class InlineCadScriptService implements CadScriptService {
  compileV1(source: string): Promise<CompileV1Output> {
    return Promise.resolve(compileV1Text(source));
  }

  printV1(irJson: string): Promise<string | null> {
    return Promise.resolve(printV1Text(irJson));
  }

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
