// Make sure the Electron binary is downloaded. pnpm 10 does not run dependency install scripts by
// default, and `electron` fetches its binary on first `require` — do that up front, visibly.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronPath = require("electron");
if (typeof electronPath !== "string" || !existsSync(electronPath)) {
  console.error(`Electron binary missing (${String(electronPath)}). Run: node node_modules/electron/install.js`);
  process.exit(1);
}
