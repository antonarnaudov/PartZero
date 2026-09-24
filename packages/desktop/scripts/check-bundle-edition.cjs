/**
 * electron-builder `beforePack` guard (both builder configs): the bundle being packaged must be the edition the config
 * is for. `bundle/` is shared: `scripts/bundle.mjs --edition <id>` rewrites it, and so does `test:e2e:bundle` (the
 * `default` edition). Packaging whatever is there with the alpha config would make a PartZero.app that runs as
 * "aicad" with API keys on (and with them the keychain), yet passes codesign, the fuse check and `--self-test`.
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const editions = require("../editions.cjs");

/** Why `bundleDir` is not the `expected` edition's bundle, or null. */
function bundleEditionProblem(bundleDir, expected) {
  const edition = editions[expected];
  if (!edition) return `unknown edition "${expected}"`;
  const file = join(bundleDir, "build-info.json");
  const fix = `run \`node scripts/bundle.mjs --edition ${expected}\` first`;
  let info;
  try {
    info = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `cannot read ${file} (${e && e.code ? e.code : "not JSON"}): ${fix}`;
  }
  if (info.edition !== expected) return `the bundle is the "${info.edition}" edition, but this config packages "${expected}": ${fix}`;
  if (info.productName !== edition.productName || info.appId !== edition.appId) {
    return `the bundle names the app ${info.productName} (${info.appId}), but the "${expected}" edition is ${edition.productName} (${edition.appId}): ${fix}`;
  }
  return null;
}

/** Throws (stopping electron-builder) when {@link bundleEditionProblem} finds one. */
function assertBundleEdition(bundleDir, expected) {
  const problem = bundleEditionProblem(bundleDir, expected);
  if (problem !== null) throw new Error(`[package] ${problem}`);
}

module.exports = { bundleEditionProblem, assertBundleEdition };
