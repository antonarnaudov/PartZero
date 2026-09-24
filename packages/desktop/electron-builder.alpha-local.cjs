/**
 * The local Alpha 0 build: PartZero.app for the owner's own Mac (docs/ALPHA-0-PLAN.md W1; built and installed by
 * `scripts/alpha0-mac.sh`). It spreads the tested base config (electron-builder.config.cjs, which stays as it is)
 * and changes only what a private, unsigned, single-Mac build needs:
 *
 * - Name and bundle id from decision D2 (`editions.cjs` `alpha-local`: "PartZero", `ai.partzero.desktop`, the
 *   provisional id until the first signed build). The profile folder follows: ~/Library/Application Support/PartZero.
 * - macOS arm64 only, as a plain `.app` folder (`dir` target): no DMG, no other platform.
 * - Ad-hoc signed (`identity: "-"`): no Apple certificate (decision D5). Hardened runtime off, so no entitlements are
 *   needed; `resetAdHocDarwinSignature` re-signs the Electron binary after the fuses are flipped, and electron-builder
 *   then ad-hoc signs the whole bundle, so `codesign --verify --deep --strict` passes.
 * - Two fuses differ from the base:
 *   - `runAsNode` stays ON (decision D1): the CAD MCP shim runs as `ELECTRON_RUN_AS_NODE=1 PartZero <shim>`, which is
 *     what Claude Code's agent-runtime mode needs. It weakens a protection meant for signed, shared builds; this build
 *     stores no API keys and never leaves this Mac. A native relay (`aicad mcp-shim`) replaces it before any signed
 *     build.
 *   - `enableCookieEncryption` OFF: with it on, Chromium reads the "PartZero Safe Storage" keychain item at every
 *     start, and an ad-hoc signature (new after every rebuild) turns that into a login-password prompt [as10].
 *   The app matches them at run time through `bundle/build-info.json` (`flags.mcpShim`, `flags.apiKeys`: no key entry,
 *   no keychain), written by `scripts/bundle.mjs --edition alpha-local`.
 * @type {import("electron-builder").Configuration}
 */
const base = require("./electron-builder.config.cjs");
const editions = require("./editions.cjs");

const edition = editions["alpha-local"];

module.exports = {
  ...base,
  appId: edition.appId,
  productName: edition.productName,
  copyright: "PartZero contributors (MPL-2.0)",
  directories: { ...base.directories, output: "release/alpha-local" },
  extraMetadata: { ...base.extraMetadata, productName: edition.productName },
  electronFuses: {
    ...base.electronFuses,
    runAsNode: true,
    enableCookieEncryption: false,
    resetAdHocDarwinSignature: true,
  },
  mac: {
    target: [{ target: "dir", arch: ["arm64"] }],
    category: base.mac.category,
    identity: "-",
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
};
