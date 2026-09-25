/**
 * `virtual:aicad/forge-web-sketch` — `@aicad/forge-web/sketch` (the sketch-session WASM) when it
 * is built, a stub otherwise, exactly like `virtual:aicad/forge-web` (vite-plugin-forge-web.ts):
 * the app builds and runs without it, and sketch mode reports that the engine is missing.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:aicad/forge-web-sketch";
const RESOLVED_ID = "\0virtual:aicad/forge-web-sketch";
const SPECIFIER = "@aicad/forge-web/sketch";

const here = dirname(fileURLToPath(import.meta.url));

export function forgeWebSketchPlugin(options: { disabled?: boolean } = {}): Plugin {
  const disabled = options.disabled ?? (process.env["AICAD_FORGE_WEB"] === "off" || process.env["AICAD_SKETCH_WASM"] === "off");
  return {
    name: "aicad:forge-web-sketch",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      if (disabled) return stub("disabled with AICAD_FORGE_WEB=off / AICAD_SKETCH_WASM=off");
      if (!existsSync(resolve(here, "../forge-web/pkg-sketch/forge_sketch_wasm_bg.wasm"))) {
        return stub("packages/forge-web/pkg-sketch is not built (pnpm --filter @aicad/forge-web build:sketch)");
      }
      const r = await this.resolve(SPECIFIER, resolve(here, "src/main.tsx"), { skipSelf: true });
      if (!r || r.external) return stub(`${SPECIFIER} does not resolve (is @aicad/forge-web built?)`);
      return [
        "export const available = true;",
        `export const source = ${JSON.stringify(r.id)};`,
        `export function load() { return import(${JSON.stringify(SPECIFIER)}); }`,
      ].join("\n");
    },
  };
}

function stub(reason: string): string {
  return [
    "export const available = false;",
    `export const source = ${JSON.stringify(reason)};`,
    `export function load() { return Promise.reject(new Error(${JSON.stringify(`the sketch engine is unavailable: ${reason}`)})); }`,
  ].join("\n");
}
