/**
 * Build editions: the one table `scripts/bundle.mjs --edition <id>` bakes into `bundle/build-info.json`
 * (src/build-info.ts) and the matching electron-builder config names the app from. Kept in one place so the name in
 * the app bundle, the profile folder the app picks at run time and the flags cannot drift apart
 * (test/packaging.test.ts checks every config against it).
 *
 * - `default`: the tested base config (electron-builder.config.cjs): signed builds, every fuse off, API keys on.
 * - `alpha-local`: PartZero.app for the owner's own Mac (docs/ALPHA-0-PLAN.md W1): the name and provisional bundle id
 *   of decision D2, no API keys (it runs on Claude Code only, so it never needs the keychain: as10), and the MCP shim
 *   run through the app executable (decision D1, which keeps the runAsNode fuse on in this build only).
 */
module.exports = {
  default: {
    productName: "aicad",
    appId: "dev.aicad.desktop",
    flags: { apiKeys: true, mcpShim: false },
  },
  "alpha-local": {
    productName: "PartZero",
    appId: "ai.partzero.desktop",
    flags: { apiKeys: false, mcpShim: true },
  },
};
