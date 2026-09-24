#!/usr/bin/env node
// The e2e suite on the packaging bundle (docs/ALPHA-0-PLAN.md G2a): bundle the app (default edition, so the suite's
// expectations about API keys and the app name hold), then run Playwright with AICAD_E2E_APP_DIR=bundle, so every
// test launches the bundled main process, worker and MCP shim with the development Electron. Extra arguments go to
// Playwright (e.g. a test file filter). The alpha edition's own checks are e2e/bundled-alpha.e2e.ts.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd: desktopRoot, stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(process.execPath, ["scripts/bundle.mjs", "--edition", "default", "--out", "bundle"]);
run("npx", ["playwright", "test", "-c", "e2e/playwright.config.ts", ...process.argv.slice(2)], { ...process.env, AICAD_E2E_APP_DIR: "bundle" });
