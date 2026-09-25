/** The real Forge engine (forge-web WASM in Node) for the live operator's tests; skipped when the WASM is not built. */
import { existsSync, readFileSync } from "node:fs";
import { blankDocument, forgeWebCommandEngine, MemoryOpsHost, type ForgeWebCommandModule, type IrCommandEngine, type MemoryOpsHostOptions } from "@aicad/model-ops";

const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
export const HAS_WASM = existsSync(wasmUrl);
if (!HAS_WASM && process.env["CI"]) throw new Error("agent: packages/forge-web/pkg is not built");

let engine: Promise<IrCommandEngine> | null = null;

export function forgeEngine(): Promise<IrCommandEngine> {
  engine ??= (async () => {
    const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
    const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
    await mod.init(readFileSync(wasmUrl));
    return forgeWebCommandEngine(mod);
  })();
  return engine;
}

/** An in-memory document operated as `agent` (blank unless `document` is given). */
export async function memoryHost(options: Partial<MemoryOpsHostOptions> = {}): Promise<MemoryOpsHost> {
  return MemoryOpsHost.open({ engine: await forgeEngine(), document: blankDocument("part"), origin: "agent", ...options });
}
