/**
 * `virtual:aicad/forge-web` — resolves `@aicad/forge-web` when it exists, a stub otherwise.
 *
 * `@aicad/forge-web` (Forge compiled to WASM + the forge-render viewport) is being built in
 * parallel with the app shell. A plain `import("@aicad/forge-web")` would fail the Vite build
 * while the package does not exist, so the app imports this virtual module instead:
 *
 * - `available`: whether the package was found when the bundle was built;
 * - `source`: where it was found (or why not), for the About dialog and logs;
 * - `load()`: dynamically imports the real module (a separate chunk), or rejects.
 *
 * Resolution order: a normal dependency resolution of `@aicad/forge-web` from this package (works
 * once it is added to `dependencies`), then the sibling workspace directory `packages/forge-web`.
 * The app still guards `load()` + `init()` with try/catch and falls back to the Forge CLI engine and
 * the placeholder viewport, so a present-but-broken forge-web never takes the shell down.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const VIRTUAL_ID = "virtual:aicad/forge-web";
const RESOLVED_ID = "\0virtual:aicad/forge-web";
const PACKAGE = "@aicad/forge-web";

const here = dirname(fileURLToPath(import.meta.url));

export interface ForgeWebPluginOptions {
  /** Force the stub (e.g. `AICAD_FORGE_WEB=off`) to test the fallback path. */
  disabled?: boolean;
}

export function forgeWebPlugin(options: ForgeWebPluginOptions = {}): Plugin {
  const disabled = options.disabled ?? process.env["AICAD_FORGE_WEB"] === "off";
  return {
    name: "aicad:forge-web",
    enforce: "pre",
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return null;
      if (disabled) return stub("disabled with AICAD_FORGE_WEB=off");
      // 1. As a regular dependency.
      const asDep = await this.resolve(PACKAGE, resolve(here, "src/main.tsx"), { skipSelf: true });
      if (asDep && !asDep.external) return real(PACKAGE, asDep.id);
      // 2. As the sibling workspace package (not yet listed in dependencies).
      const sibling = resolve(here, "../forge-web");
      if (existsSync(resolve(sibling, "package.json"))) {
        const bySibling = await this.resolve(sibling, resolve(here, "src/main.tsx"), { skipSelf: true });
        if (bySibling && !bySibling.external) return real(bySibling.id, bySibling.id);
        return stub(`${sibling} exists but has no resolvable entry point (is it built?)`);
      }
      return stub(`${PACKAGE} is not installed (packages/forge-web not found)`);
    },
  };
}

function real(specifier: string, resolvedPath: string): string {
  return [
    "export const available = true;",
    `export const source = ${JSON.stringify(resolvedPath)};`,
    `export function load() { return import(${JSON.stringify(specifier)}); }`,
  ].join("\n");
}

function stub(reason: string): string {
  return [
    "export const available = false;",
    `export const source = ${JSON.stringify(reason)};`,
    `export function load() { return Promise.reject(new Error(${JSON.stringify(`@aicad/forge-web unavailable: ${reason}`)})); }`,
  ].join("\n");
}
