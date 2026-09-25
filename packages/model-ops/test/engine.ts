/**
 * The real Forge engine for tests: `@aicad/forge-web` (WASM) loaded from `packages/forge-web/pkg`
 * in Node. `pkg` is gitignored and built by `pnpm -r build`; a CI run without it fails, a local
 * run says the engine tests are skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { forgeWebCommandEngine, missingCommandMembers, type ForgeWebCommandModule, type IrCommandEngine } from "../src/engine.js";

const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
export const hasWasm = existsSync(wasmUrl);

if (!hasWasm) {
  const why = "packages/forge-web/pkg is not built (run pnpm --filter @aicad/forge-web build:wasm)";
  if (process.env["CI"]) throw new Error(`model-ops: ${why}; the op tests need the Forge WASM engine on CI`);
  console.warn(`model-ops: ${why}: every engine test is SKIPPED`);
}

let cached: Promise<IrCommandEngine> | null = null;

/** The engine over the forge-web sources (not the built dist), initialised once. */
export function loadEngine(): Promise<IrCommandEngine> {
  cached ??= (async () => {
    const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
    const mod = (await import(/* @vite-ignore */ entry)) as ForgeWebCommandModule & { init(input: unknown): Promise<void> };
    await mod.init(readFileSync(wasmUrl));
    const missing = missingCommandMembers(mod);
    if (missing.length) throw new Error(`packages/forge-web/pkg is stale (missing ${missing.join(", ")})`);
    return forgeWebCommandEngine(mod);
  })();
  return cached;
}

/** A plate: document parameter `t`, sketch `s1` (a 40 × 20 rectangle on XY), extrude `e1` by `t`. */
export function plate(extra: { features?: unknown[]; params?: unknown[] } = {}): string {
  return JSON.stringify({
    schema: "aicad.ir/1",
    meta: { name: "plate" },
    params: [{ name: "t", unit: "mm", value: 5, min: 1 }, ...(extra.params ?? [])],
    parts: [
      {
        id: "p1",
        name: "part",
        features: [
          { type: "sketch", id: "s1", name: "outline", plane: "XY", curves: [{ kind: "rect", id: "r", center: [0, 0], w: 40, h: 20 }] },
          { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: "t" },
          ...(extra.features ?? []),
        ],
      },
    ],
  });
}
