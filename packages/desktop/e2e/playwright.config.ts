import { defineConfig } from "@playwright/test";

/** Electron smoke tests: `pnpm --filter @aicad/desktop test:e2e` (builds the app and the shell first). */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.e2e\.ts$/,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../test-results",
});
