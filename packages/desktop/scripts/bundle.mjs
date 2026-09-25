#!/usr/bin/env node
// Bundle the desktop app's own code for packaging (docs/ALPHA-0-PLAN.md W1):
//
//   node scripts/bundle.mjs [--edition default|alpha-local] [--out bundle]
//
// A packaged app has no node_modules: the main process, the preload, the agent worker and the CAD MCP shim are
// bundled with esbuild (ESM for Electron's Node; `electron` stays external; every @aicad/* workspace package, the
// provider SDKs and the TypeScript compiler are inlined). The output (`packages/desktop/bundle/`) is what
// electron-builder puts into app.asar, and what the bundled e2e runs launch with the development Electron:
//
//   bundle/package.json             so `electron bundle/` starts it (type module, main.js, the edition's name)
//   bundle/main.js                  src/main.ts
//   bundle/preload.cjs              src/preload.cts (CommonJS: a sandboxed preload)
//   bundle/agent/worker.js          src/agent/worker.ts
//   bundle/agent/forge_wasm_bg.wasm @aicad/forge-web's module, read by the worker's engine (src/agent/engine.ts)
//   bundle/prompts/*.md             @aicad/agent's role prompts (the runner passes them as promptsDir)
//   bundle/mcp/stdio.mjs            @aicad/mcp-server's stdio shim, bridge mode only (asar-unpacked when packaged)
//   bundle/build-info.json          edition, product name, app id, version, commit, flags (src/build-info.ts)
//   bundle/THIRD_PARTY_NOTICES.txt  every npm package with code in the bundles, plus Forge's crates
//
// The web app (packages/app/dist/web) is built by Vite and packaged next to this as app-web/.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "..", "..");
const require = createRequire(import.meta.url);
const editions = require("../editions.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const editionId = arg("--edition", "default");
const edition = editions[editionId];
if (!edition) {
  console.error(`[bundle] unknown edition ${editionId}; one of ${Object.keys(editions).join(", ")}`);
  process.exit(2);
}
const out = resolve(desktopRoot, arg("--out", "bundle"));
const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));

/**
 * ESM output that inlines CommonJS packages (the TypeScript compiler, parts of the SDKs): they call `require` for Node
 * built-ins and read `__filename` / `__dirname`, which an ES module does not have.
 */
const ESM_BANNER = [
  'import { createRequire as __pzCreateRequire } from "node:module";',
  'import { fileURLToPath as __pzFileURLToPath } from "node:url";',
  'import { dirname as __pzDirname } from "node:path";',
  "const require = __pzCreateRequire(import.meta.url);",
  "const __filename = __pzFileURLToPath(import.meta.url);",
  "const __dirname = __pzDirname(__filename);",
].join("\n");

const common = {
  absWorkingDir: desktopRoot,
  bundle: true,
  platform: "node",
  target: "node22",
  logLevel: "warning",
  metafile: true,
  legalComments: "inline",
  // Readable stack traces in main.log / agent.log; the asar is local, size is not the constraint.
  minify: false,
  sourcemap: false,
  // Workspace packages resolve through their package.json "exports" (the built dist/ files).
  conditions: ["node", "import"],
};

/** The MCP shim's headless mode (an in-process design host for external agents) is not part of the app. */
const noHeadlessShim = {
  name: "partzero-no-headless-mcp",
  setup(b) {
    b.onResolve({ filter: /(^|[\\/])host[\\/]headless\.js$/ }, () => ({ path: "headless", namespace: "partzero-stub" }));
    b.onLoad({ filter: /.*/, namespace: "partzero-stub" }, () => ({
      contents: 'export async function runHeadless() { process.stderr.write("aicad-mcp: headless mode is not part of the PartZero app bundle\\n"); return 2; }\n',
      loader: "js",
    }));
  },
};

function git(args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const t0 = Date.now();
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "agent"), { recursive: true });

  const esm = { ...common, format: "esm", banner: { js: ESM_BANNER }, external: ["electron"] };
  const results = await Promise.all([
    build({ ...esm, entryPoints: { main: "src/main.ts" }, outdir: out }),
    build({ ...esm, entryPoints: { worker: "src/agent/worker.ts" }, outdir: join(out, "agent") }),
    build({ ...common, format: "cjs", external: ["electron"], entryPoints: { preload: "src/preload.cts" }, outdir: out, outExtension: { ".js": ".cjs" } }),
    build({
      ...esm,
      external: [],
      entryPoints: { stdio: fileURLToPath(import.meta.resolve("@aicad/mcp-server/stdio")) },
      outdir: join(out, "mcp"),
      outExtension: { ".js": ".mjs" },
      plugins: [noHeadlessShim],
    }),
  ]);

  // The worker's engine reads Forge's WASM from next to it (src/bundle-paths.ts).
  copyFileSync(fileURLToPath(import.meta.resolve("@aicad/forge-web/forge_wasm_bg.wasm")), join(out, "agent", "forge_wasm_bg.wasm"));
  // The agent's role prompts: `@aicad/agent` resolves to <pkg>/dist/index.js; the prompts are <pkg>/prompts.
  const agentPrompts = join(dirname(dirname(fileURLToPath(import.meta.resolve("@aicad/agent")))), "prompts");
  cpSync(agentPrompts, join(out, "prompts"), { recursive: true, filter: (src) => !src.endsWith(".DS_Store") });

  const commit = git(["rev-parse", "--short=12", "HEAD"]);
  const status = git(["status", "--porcelain"]);
  const builtAt = process.env["SOURCE_DATE_EPOCH"] ? new Date(Number(process.env["SOURCE_DATE_EPOCH"]) * 1000).toISOString() : new Date().toISOString();
  const buildInfo = {
    edition: editionId,
    productName: edition.productName,
    appId: edition.appId,
    version: pkg.version,
    commit: commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null,
    dirty: status !== null && status.length > 0,
    builtAt,
    flags: edition.flags,
  };
  writeFileSync(join(out, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
  writeFileSync(
    join(out, "package.json"),
    `${JSON.stringify({ name: "partzero-bundle", productName: edition.productName, version: pkg.version, private: true, type: "module", main: "main.js", license: pkg.license }, null, 2)}\n`,
  );

  // Third-party notices for everything the bundles inline (the web app's renderer has its own).
  const inputs = new Set();
  for (const r of results) for (const file of Object.keys(r.metafile.inputs)) if (!file.includes(":")) inputs.add(isAbsolute(file) ? file : resolve(desktopRoot, file));
  const { runnerImport } = await import("vite");
  const { module: web } = await runnerImport(join(repoRoot, "packages", "app", "vite.config.ts"));
  const packages = web.bundledPackages(inputs);
  const notices = web.renderWebNotices(packages, {
    artifact: `${edition.productName} desktop bundle`,
    generator: "packages/desktop/scripts/bundle.mjs",
  });
  writeFileSync(join(out, "THIRD_PARTY_NOTICES.txt"), notices);

  const size = (f) => {
    try {
      return `${(readFileSync(f).length / 1024 / 1024).toFixed(1)} MB`;
    } catch {
      return "?";
    }
  };
  const thirdParty = packages.filter((p) => p.thirdParty).length;
  console.log(
    `[bundle] ${edition.productName} (${editionId}) → ${relative(repoRoot, out)} in ${((Date.now() - t0) / 1000).toFixed(1)} s: main.js ${size(join(out, "main.js"))}, agent/worker.js ${size(join(out, "agent", "worker.js"))}, mcp/stdio.mjs ${size(join(out, "mcp", "stdio.mjs"))}; ${thirdParty} third-party packages; commit ${buildInfo.commit ?? "none"}${buildInfo.dirty ? " (dirty)" : ""}`,
  );
}

main().catch((e) => {
  console.error(`[bundle] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
