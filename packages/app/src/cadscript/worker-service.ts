import type { IrDocument } from "@aicad/ir-types";
import { WorkerRpc } from "../worker-rpc";
import type { CadScriptService, CompileOutput, CompileV1Output } from "./service";

export type CadScriptRequest =
  | { type: "compile"; source: string; base: IrDocument | null }
  | { type: "compileV1"; source: string }
  | { type: "printV1"; irJson: string }
  | { type: "print"; ir: IrDocument }
  | { type: "applyIrEdit"; source: string; oldIr: IrDocument; newIr: IrDocument };

/** The CadScript compiler + type-checker in a module worker (keeps the TypeScript compiler off the UI thread). */
export class WorkerCadScriptService implements CadScriptService {
  private readonly rpc: WorkerRpc<CadScriptRequest>;

  constructor() {
    const worker = new Worker(new URL("./cadscript.worker.ts", import.meta.url), { type: "module", name: "cadscript" });
    this.rpc = new WorkerRpc<CadScriptRequest>(worker);
  }

  compile(source: string, base?: IrDocument | null): Promise<CompileOutput> {
    return this.rpc.call<CompileOutput>({ type: "compile", source, base: base ?? null });
  }

  compileV1(source: string): Promise<CompileV1Output> {
    return this.rpc.call<CompileV1Output>({ type: "compileV1", source });
  }

  printV1(irJson: string): Promise<string | null> {
    return this.rpc.call<string | null>({ type: "printV1", irJson });
  }

  print(ir: IrDocument): Promise<string> {
    return this.rpc.call<string>({ type: "print", ir });
  }

  applyIrEdit(source: string, oldIr: IrDocument, newIr: IrDocument): Promise<string> {
    return this.rpc.call<string>({ type: "applyIrEdit", source, oldIr, newIr });
  }

  dispose(): void {
    this.rpc.terminate();
  }
}
