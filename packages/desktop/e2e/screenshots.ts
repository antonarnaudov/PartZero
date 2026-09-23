/**
 * Where the e2e suite writes its screenshots.
 *
 * The committed documentation screenshots (`docs/spikes/assets/*.png`) are only rewritten on
 * request: a normal run writes to the git-ignored `packages/desktop/test-results/`, so running the
 * suite never dirties the working tree. Precedence:
 *   1. an explicit per-screenshot override variable (e.g. `AICAD_E2E_SCREENSHOT`), used as is;
 *   2. `AICAD_UPDATE_DOC_SCREENSHOTS=1`: the committed file under `docs/spikes/assets/`;
 *   3. otherwise `packages/desktop/test-results/<file>`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const UPDATE_DOC_SCREENSHOTS_ENV = "AICAD_UPDATE_DOC_SCREENSHOTS";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Git-ignored Playwright output directory (see playwright.config.ts `outputDir`). */
export const testResultsDir = join(desktopRoot, "test-results");
/** Committed documentation screenshots. */
export const docScreenshotsDir = join(desktopRoot, "..", "..", "docs", "spikes", "assets");

/** `true` only for the explicit opt-in value `1`. */
export function updateDocScreenshots(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UPDATE_DOC_SCREENSHOTS_ENV] === "1";
}

/**
 * The path for the screenshot `file` (a bare file name such as `app-shell.png`), honouring the
 * per-screenshot override variable `overrideVar`.
 */
export function screenshotPath(file: string, overrideVar: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[overrideVar];
  if (explicit) return explicit;
  return join(updateDocScreenshots(env) ? docScreenshotsDir : testResultsDir, file);
}
