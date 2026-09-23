/**
 * electron-builder configuration (`pnpm --filter @aicad/desktop package[:mac|:win|:linux]`).
 * The main process has no runtime npm dependencies; the web app and the Forge CLI are shipped as
 * extra resources (`resources/app-web`, `resources/bin/aicad[.exe]`).
 * @type {import("electron-builder").Configuration}
 */
module.exports = {
  appId: "dev.aicad.desktop",
  productName: "aicad",
  copyright: "aicad contributors (MPL-2.0)",
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**/*", "package.json"],
  extraResources: [
    { from: "../app/dist/web", to: "app-web" },
    // Build it first: `cargo build --release -p forge-cli` (optional; without it the app runs compile-only).
    { from: "../../forge/target/release", to: "bin", filter: ["aicad", "aicad.exe"] },
  ],
  asar: true,
  npmRebuild: false,
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.graphics-design",
    hardenedRuntime: true,
  },
  dmg: { title: "aicad ${version}" },
  win: { target: [{ target: "nsis", arch: ["x64", "arm64"] }] },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true },
  linux: { target: [{ target: "AppImage", arch: ["x64", "arm64"] }], category: "Graphics" },
};
