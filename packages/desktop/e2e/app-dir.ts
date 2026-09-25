/**
 * The app folder the e2e suite launches with the development Electron: the desktop package itself (`dist/`, from
 * tsc) by default, or the folder `AICAD_E2E_APP_DIR` names, e.g. `packages/desktop/bundle` (scripts/bundle.mjs):
 * `pnpm --filter @aicad/desktop test:e2e:bundle` runs the same suite on the bundled main process, worker and MCP shim
 * a packaged app runs (docs/ALPHA-0-PLAN.md G2a: Playwright cannot attach to the packaged app itself).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const override = process.env["AICAD_E2E_APP_DIR"];
export const appDir = override ? resolve(desktopRoot, override) : desktopRoot;
