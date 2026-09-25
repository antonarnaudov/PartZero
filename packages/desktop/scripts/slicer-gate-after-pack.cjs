/**
 * electron-builder `afterPack` hook: the slicer licence gate over the packed app, before it is
 * signed or put in a DMG (ADR 0016 §3 and its follow-up, docs/SLICER-HANDOFF.md "Licence gate").
 *
 * PartZero launches the Bambu Studio the user installed and never ships a slicer, libslic3r or a
 * slicer's profile library. CI runs `scripts/license-check/slicer-boundary.mjs` on the repository;
 * this hook runs the same scan on every build tree electron-builder produces (`context.appOutDir`,
 * e.g. `release/mac-arm64`, including `--dir` builds), so a slicer that slips in through
 * `extraResources`, a dependency or a build script fails the build rather than shipping.
 *
 * Any packaging config must keep this hook (the Alpha 0 build script's config included).
 */
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const GATE = join(__dirname, "..", "..", "..", "scripts", "license-check", "slicer-boundary.mjs");

/** @param {{ appOutDir: string }} context */
async function slicerGateAfterPack(context) {
  const { scan } = await import(pathToFileURL(GATE).href);
  const found = scan(context.appOutDir, { git: false });
  if (found.length > 0) {
    const list = found.map((v) => `${v.file} (${v.reason})`).join("; ");
    throw new Error(`slicer-boundary: ${found.length} violation(s) in ${context.appOutDir}: ${list}. PartZero launches the user's own slicer and never ships one or its profiles (ADR 0016 §3).`);
  }
  console.log(`  • slicer-boundary: no slicer binary, engine or profile library in ${context.appOutDir}`);
}

module.exports = slicerGateAfterPack;
module.exports.default = slicerGateAfterPack;
