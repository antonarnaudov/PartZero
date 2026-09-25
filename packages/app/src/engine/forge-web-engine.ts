/**
 * `ForgeWebEngine`: `@aicad/forge-web` (Forge compiled to WASM) running in a dedicated worker.
 * {@link ForgeWebEngine.create} rejects when the package is missing, fails its contract check
 * or fails to initialise — the engine manager then falls back to the CLI engine.
 */
import { available, source } from "virtual:aicad/forge-web";
import { FORGE_WEB_COMMANDS, toCommandEngineError, type ForgeWebCommandName, type IrCommandEngine } from "../doc/v1/command-engine";
import { WorkerRpc } from "../worker-rpc";
import type { EvalResult, ForgeEngine, MeshFormat, TessellationOptions } from "./types";
import { EngineError } from "./types";

export type ForgeWebRequest =
  | { type: "init" }
  | { type: "evaluate"; irJson: string; tess?: TessellationOptions }
  | { type: "export"; irJson: string; format: MeshFormat; tess?: TessellationOptions }
  | { type: "command"; name: ForgeWebCommandName; args: unknown[] };

/** The command layer over the worker: each method is one RPC; refusals keep their code, errors and details. */
function workerCommands(rpc: WorkerRpc<ForgeWebRequest>): IrCommandEngine {
  const call =
    (name: ForgeWebCommandName) =>
    async (...args: unknown[]): Promise<never> => {
      try {
        return await rpc.call<never>({ type: "command", name, args });
      } catch (e) {
        throw toCommandEngineError(e);
      }
    };
  return Object.fromEntries(FORGE_WEB_COMMANDS.map((n) => [n, call(n)])) as unknown as IrCommandEngine;
}

/** Whether forge-web was bundled at all (a build-time fact; init can still fail at runtime). */
export const forgeWebBundled: boolean = available;
export const forgeWebSource: string = source;

export class ForgeWebEngine implements ForgeEngine {
  readonly id = "forge-web" as const;
  readonly label = "forge-web · wasm";
  readonly detail: string;
  private readonly rpc: WorkerRpc<ForgeWebRequest>;
  /** The IR v1 command layer (SPEC-v1 §0.6, §5.9), run in the worker. */
  readonly commands: IrCommandEngine;

  private constructor(rpc: WorkerRpc<ForgeWebRequest>, detail: string) {
    this.rpc = rpc;
    this.detail = detail;
    this.commands = workerCommands(rpc);
  }

  static async create(): Promise<ForgeWebEngine> {
    if (!available) throw new EngineError("ENGINE_UNAVAILABLE", `@aicad/forge-web unavailable: ${source}`);
    if (typeof Worker === "undefined") throw new EngineError("ENGINE_UNAVAILABLE", "Web Workers are not available");
    const worker = new Worker(new URL("./forge-web.worker.ts", import.meta.url), { type: "module", name: "forge-web" });
    const rpc = new WorkerRpc<ForgeWebRequest>(worker);
    try {
      const r = await rpc.call<{ source: string }>({ type: "init" });
      return new ForgeWebEngine(rpc, `WASM in a worker (${r.source})`);
    } catch (e) {
      rpc.terminate();
      throw new EngineError("ENGINE_UNAVAILABLE", (e as Error).message);
    }
  }

  async evaluate(irJson: string, tessellation?: TessellationOptions): Promise<EvalResult> {
    try {
      return await this.rpc.call<EvalResult>({ type: "evaluate", irJson, ...(tessellation ? { tess: tessellation } : {}) });
    } catch (e) {
      throw new EngineError("ENGINE_FAILED", `forge-web evaluate: ${(e as Error).message}`);
    }
  }

  async exportMesh(irJson: string, format: MeshFormat, tessellation?: TessellationOptions): Promise<Uint8Array> {
    try {
      return await this.rpc.call<Uint8Array>({ type: "export", irJson, format, ...(tessellation ? { tess: tessellation } : {}) });
    } catch (e) {
      throw new EngineError("EXPORT_FAILED", `forge-web export: ${(e as Error).message}`);
    }
  }

  dispose(): void {
    this.rpc.terminate();
  }
}
