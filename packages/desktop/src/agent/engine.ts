/**
 * The geometry engine the agent verifies with (L1 kernel), inside the agent utility process:
 *
 * 1. `@aicad/forge-web` — Forge compiled to WASM, run in Node (no GPU needed; `evaluate` only), the
 *    same build the renderer uses, so the agent and the viewport see identical results;
 * 2. else the native Forge CLI (`@aicad/evals` `ForgeCliEngine`, the binary the main process found).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ForgeCliEngine, type Engine, type EngineAvailability } from "@aicad/evals";
import type { EvalReport, IrDocument } from "@aicad/ir-types";

interface ForgeWebModule {
  init(input?: unknown): Promise<void>;
  evaluate(ir: string | object): { report: EvalReport };
  engineVersion(): string;
}

export class ForgeWebNodeEngine implements Engine {
  readonly kind = "forge-web";
  #mod: Promise<ForgeWebModule> | null = null;

  #load(): Promise<ForgeWebModule> {
    this.#mod ??= (async () => {
      const mod = (await import("@aicad/forge-web")) as unknown as ForgeWebModule;
      const wasm = fileURLToPath(import.meta.resolve("@aicad/forge-web/forge_wasm_bg.wasm"));
      await mod.init(await readFile(wasm));
      return mod;
    })();
    this.#mod.catch(() => {
      this.#mod = null;
    });
    return this.#mod;
  }

  async availability(): Promise<EngineAvailability> {
    try {
      const m = await this.#load();
      return { available: true, detail: `forge-web ${m.engineVersion()} (wasm, node)` };
    } catch (e) {
      return { available: false, detail: `forge-web unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async evaluate(ir: IrDocument): Promise<EvalReport> {
    const m = await this.#load();
    return m.evaluate(JSON.stringify(ir)).report;
  }
}

export interface AgentEngine {
  engine: Engine;
  label: string;
}

/** forge-web in Node, else the Forge CLI; when neither is available the agent stops with `engine_unavailable`. */
export async function createAgentEngine(forgeBin: string): Promise<AgentEngine> {
  const web = new ForgeWebNodeEngine();
  const a = await web.availability();
  if (a.available) return { engine: web, label: a.detail };
  const cli = new ForgeCliEngine({ bin: forgeBin });
  const b = await cli.availability();
  if (b.available) return { engine: cli, label: `forge CLI (native)` };
  return { engine: web, label: `no engine (${a.detail}; ${b.detail})` };
}
