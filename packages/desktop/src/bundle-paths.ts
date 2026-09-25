/**
 * Files a bundled build ships next to its code (`scripts/bundle.mjs`; electron-free, unit-tested). The layout inside
 * `app.asar` (and in `packages/desktop/bundle/`, which development and the bundled e2e runs launch directly):
 *
 *   bundle/main.js                  the main process (this module's caller)
 *   bundle/preload.cjs
 *   bundle/build-info.json          edition, product name, commit, flags (`build-info.ts`)
 *   bundle/agent/worker.js          the agent utility process, every workspace package and SDK inlined
 *   bundle/agent/forge_wasm_bg.wasm Forge for the worker's engine (`agent/engine.ts`)
 *   bundle/prompts/*.md             the agent's role prompts (`agent/runner.ts` passes them as `promptsDir`)
 *   bundle/mcp/stdio.mjs            the CAD MCP shim CLI agents launch; asar-unpacked, because it runs as
 *                                   `ELECTRON_RUN_AS_NODE=1 <app> <shim>`, a plain Node process
 *
 * An unbundled development run (`dist/`, from `tsc`) has none of these files: every function returns null and the
 * callers fall back to the workspace packages.
 */
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

/** `…/app.asar/…` → `…/app.asar.unpacked/…` (a file electron-builder's `asarUnpack` put next to the archive). */
export function unpackedPath(path: string): string {
  const marker = `${sep}app.asar${sep}`;
  const i = path.indexOf(marker);
  return i < 0 ? path : `${path.slice(0, i)}${sep}app.asar.unpacked${sep}${path.slice(i + marker.length)}`;
}

/** The bundled MCP shim for `mainDir` (the directory of the main bundle), as a separate Node process must open it. */
export function bundledMcpShimPath(mainDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const shim = unpackedPath(join(mainDir, "mcp", "stdio.mjs"));
  return exists(shim) ? shim : null;
}

/** The role prompts of a bundled worker (`workerDir` = `bundle/agent`), or null (unbundled: the agent package's own). */
export function bundledPromptsDir(workerDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const dir = join(workerDir, "..", "prompts");
  return exists(dir) ? dir : null;
}

/** The Forge WASM module of a bundled worker, or null (unbundled: resolved from `@aicad/forge-web`). */
export function bundledWasmPath(workerDir: string, exists: (p: string) => boolean = existsSync): string | null {
  const wasm = join(workerDir, "forge_wasm_bg.wasm");
  return exists(wasm) ? wasm : null;
}
