#!/usr/bin/env node
// Licence files for a packaged build (run by `pnpm --filter @aicad/desktop package` before
// electron-builder; see electron-builder.config.cjs):
//
// - build/generated/aicad-THIRD_PARTY_LICENSES.txt: the third-party Rust crates compiled into the
//   `aicad` binary (forge-cli, for the host target: the binary electron-builder copies from
//   forge/target/release), shipped as resources/bin/THIRD_PARTY_LICENSES.txt.
// - checks that the web app build produced dist/web/THIRD_PARTY_NOTICES.txt and LICENSE.txt
//   (packages/app/vite.config.ts), shipped inside app.asar and as resources/THIRD_PARTY_NOTICES.txt.
//
// Fails (exit 1) rather than packaging an app without its notices.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostTarget, writeCargoNotices } from "../../forge-web/scripts/build.mjs";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "..", "..");
const forgeDir = process.env.FORGE_DIR ?? join(repoRoot, "forge");

try {
  const out = join(desktopRoot, "build", "generated", "aicad-THIRD_PARTY_LICENSES.txt");
  const target = hostTarget(forgeDir);
  const n = writeCargoNotices({ forgeDir, rootPackage: "forge-cli", target, artifact: "aicad (Forge CLI)", out });
  console.log(`[aicad] ${out}: ${n} third-party crates (${target})`);
  for (const f of ["THIRD_PARTY_NOTICES.txt", "LICENSE.txt"]) {
    const p = join(repoRoot, "packages", "app", "dist", "web", f);
    if (!existsSync(p)) throw new Error(`${p} is missing: build @aicad/app first (its vite build writes it)`);
  }
} catch (e) {
  console.error(`[aicad] package-notices: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
