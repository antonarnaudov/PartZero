// E2E of the fallback configuration: the app built without @aicad/forge-web (AICAD_FORGE_WEB=off),
// so the Forge CLI engine and the placeholder viewport are exercised even when forge-web exists.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

process.env.AICAD_FORGE_WEB = "off";
const require = createRequire(import.meta.url);
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = dirname(require.resolve("@aicad/app/package.json"));
const outDir = join(appRoot, "dist", "web-fallback");

await build({ root: appRoot, configFile: join(appRoot, "vite.config.ts"), logLevel: "warn", build: { outDir, emptyOutDir: true } });
const r = spawnSync("pnpm", ["exec", "playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    AICAD_APP_DIST: outDir,
    AICAD_E2E_EXPECT: "fallback",
    AICAD_E2E_SCREENSHOT: process.env.AICAD_E2E_SCREENSHOT ?? join(desktopRoot, "test-results", "app-shell-fallback.png"),
  },
  shell: process.platform === "win32",
});
process.exit(r.status ?? 1);
