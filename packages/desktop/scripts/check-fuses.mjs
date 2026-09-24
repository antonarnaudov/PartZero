#!/usr/bin/env node
// Read the Electron fuses of a packaged app and compare them with a builder config's `electronFuses`
// (docs/ALPHA-0-PLAN.md G1 #1, G2b):
//
//   node scripts/check-fuses.mjs <path/to/PartZero.app> [--config electron-builder.alpha-local.cjs]
//
// Prints one JSON object (every fuse: expected, actual, match) and exits 1 when any configured fuse differs.
// Fuses the Electron binary has but the config does not name are listed as `unconfigured` (they keep Electron's
// default); they do not fail the check, but a new one should be reviewed and added to the config.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");
/** @electron/fuses `FuseState` (its constants module is not part of the package's exports). */
const FuseState = { DISABLE: 48, ENABLE: 49, REMOVED: 114, INHERIT: 144 };

const args = process.argv.slice(2);
const appPath = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--config");
const configFile = args.includes("--config") ? args[args.indexOf("--config") + 1] : "electron-builder.alpha-local.cjs";
if (!appPath) {
  console.error("usage: node scripts/check-fuses.mjs <path/to/App.app> [--config <builder config>]");
  process.exit(2);
}

/** electron-builder's `electronFuses` keys → @electron/fuses wire positions. */
const KEYS = {
  runAsNode: FuseV1Options.RunAsNode,
  enableCookieEncryption: FuseV1Options.EnableCookieEncryption,
  enableNodeOptionsEnvironmentVariable: FuseV1Options.EnableNodeOptionsEnvironmentVariable,
  enableNodeCliInspectArguments: FuseV1Options.EnableNodeCliInspectArguments,
  enableEmbeddedAsarIntegrityValidation: FuseV1Options.EnableEmbeddedAsarIntegrityValidation,
  onlyLoadAppFromAsar: FuseV1Options.OnlyLoadAppFromAsar,
  loadBrowserProcessSpecificV8Snapshot: FuseV1Options.LoadBrowserProcessSpecificV8Snapshot,
  grantFileProtocolExtraPrivileges: FuseV1Options.GrantFileProtocolExtraPrivileges,
};

const stateName = (s) => (s === FuseState.ENABLE ? "on" : s === FuseState.DISABLE ? "off" : s === FuseState.REMOVED ? "removed" : s === FuseState.INHERIT ? "inherit" : `unknown(${s})`);

const config = require(resolve(desktopRoot, configFile));
const expected = config.electronFuses ?? {};
const wire = await getCurrentFuseWire(resolve(appPath));
const fuses = {};
let ok = true;
for (const [key, position] of Object.entries(KEYS)) {
  if (!(key in expected)) continue;
  const actual = stateName(wire[position]);
  const want = expected[key] ? "on" : "off";
  fuses[key] = { expected: want, actual, match: actual === want };
  if (actual !== want) ok = false;
}
const named = new Set(Object.values(KEYS).map(String));
const unconfigured = Object.entries(wire)
  .filter(([k]) => /^\d+$/.test(k) && !named.has(k))
  .map(([k, v]) => ({ position: Number(k), state: stateName(v) }));
const unknownKeys = Object.keys(expected).filter((k) => !(k in KEYS) && k !== "resetAdHocDarwinSignature" && k !== "strictlyRequireAllFuses");
if (unknownKeys.length > 0) ok = false;

console.log(JSON.stringify({ app: resolve(appPath), config: configFile, fuseVersion: wire.version, ok, fuses, unconfigured, unknownKeys }, null, 2));
process.exit(ok ? 0 : 1);
