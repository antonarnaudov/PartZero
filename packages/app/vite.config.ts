import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { forgeWebPlugin } from "./vite-plugin-forge-web.ts";

/**
 * Cross-origin isolation (COOP + COEP) makes SharedArrayBuffer — and with it WASM threads for
 * Forge — available. The desktop shell sends the same headers from its `app://` protocol.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
} as const;

// ─── Third-party notices ──────────────────────────────────────────────────────────────────────
//
// The minifier drops the `@license` headers of the bundled packages, so the build writes the
// attribution next to the bundle instead:
// - `dist/web/THIRD_PARTY_NOTICES.txt`: every npm package that has code in the main bundle or a
//   worker bundle (Monaco and TypeScript with their own third-party notice files), with its license
//   files verbatim, plus the Rust crates compiled into Forge's WASM module
//   (`@aicad/forge-web/pkg/THIRD_PARTY_LICENSES.txt`) when that module is bundled.
// - `dist/web/LICENSE.txt`: the MPL-2.0 text that covers aicad itself.
// The About dialog shows both (About → Licenses). A package without a license, with a license
// outside the allowlist, or without a license text fails the build.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** SPDX ids a bundled npm package may use (LICENSING.md: no LGPL/GPL at runtime). Anything else needs a human review. */
export const WEB_ALLOWED_LICENSES = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "MPL-2.0", "Zlib", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0", "CC-BY-4.0"]);

const NOTICE_FILES = /^(licen[cs]e|copying|notice|copyright|third[-_]?party[-_]?notice)/i;

export interface BundledPackage {
  name: string;
  version: string;
  license: string;
  dir: string;
  repository: string | null;
  author: string | null;
  /** Under `node_modules` (not one of our workspace packages). */
  thirdParty: boolean;
  /** The package's files that are in the bundle (sorted). */
  files: string[];
}

function readPackage(dir: string): BundledPackage | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  // Nested package.json files (`{"type":"module"}` markers in dist folders) have no name/version.
  if (typeof json["name"] !== "string" || typeof json["version"] !== "string") return null;
  const legacy = Array.isArray(json["licenses"]) ? (json["licenses"] as Array<{ type?: unknown }>).map((l) => String(l.type)).join(" OR ") : "";
  const repo = json["repository"];
  const author = json["author"];
  return {
    name: json["name"],
    version: json["version"],
    license: typeof json["license"] === "string" ? json["license"] : legacy,
    dir,
    repository: typeof repo === "string" ? repo : typeof repo === "object" && repo !== null && typeof (repo as { url?: unknown }).url === "string" ? (repo as { url: string }).url : null,
    author: typeof author === "string" ? author : typeof author === "object" && author !== null && typeof (author as { name?: unknown }).name === "string" ? (author as { name: string }).name : null,
    thirdParty: dir.split(sep).includes("node_modules"),
    files: [],
  };
}

/** The packages that own the given module ids (files on disk; virtual ids are skipped). */
export function bundledPackages(moduleIds: Iterable<string>): BundledPackage[] {
  const byDir = new Map<string, BundledPackage | null>();
  const owner = (file: string): BundledPackage | null => {
    const visited: string[] = [];
    let dir = dirname(file);
    let found: BundledPackage | null = null;
    for (;;) {
      if (byDir.has(dir)) {
        found = byDir.get(dir) ?? null;
        break;
      }
      visited.push(dir);
      const pkg = readPackage(dir);
      if (pkg) {
        found = pkg;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const d of visited) byDir.set(d, found);
    return found;
  };
  const out = new Map<string, { pkg: BundledPackage; files: Set<string> }>();
  for (const raw of moduleIds) {
    if (raw.startsWith("\0")) continue;
    const file = raw.split("?")[0]!;
    if (!isAbsolute(file) || !existsSync(file)) continue;
    const pkg = owner(file);
    if (!pkg) continue;
    const key = `${pkg.name}@${pkg.version}`;
    const entry = out.get(key) ?? { pkg, files: new Set<string>() };
    entry.files.add(file);
    out.set(key, entry);
  }
  return [...out.values()]
    .map(({ pkg, files }) => ({ ...pkg, files: [...files].sort() }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
}

/**
 * License comments inside bundled files (`/*! … *\/`, `@license`, `@preserve`), which the minifier
 * drops: vendored code such as DOMPurify inside monaco-editor has its notice only there.
 * Deduplicated, in file order.
 */
export function legalComments(files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) {
      const c = m[0];
      if (!c.startsWith("/*!") && !/@license|@preserve/.test(c)) continue;
      // Comments quoted inside string literals (e.g. lib.d.ts texts) carry escaped newlines.
      const norm = c.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\r\n?/g, "\n").trim();
      if (!seen.has(norm)) {
        seen.add(norm);
        out.push(norm);
      }
    }
  }
  return out;
}

/** Every SPDX id in `expression` is allowed (parentheses, AND, OR and WITH aside). */
export function licenseAllowed(expression: string): boolean {
  const ids = expression.replace(/[()]/g, " ").split(/\s+/).filter((t) => t && t !== "AND" && t !== "OR");
  let afterWith = false;
  for (const id of ids) {
    if (id === "WITH") {
      afterWith = true;
      continue;
    }
    if (afterWith) {
      afterWith = false; // an exception only adds permissions
      continue;
    }
    if (!WEB_ALLOWED_LICENSES.has(id)) return false;
  }
  return ids.length > 0;
}

function licenseFiles(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir)
    .filter((f) => NOTICE_FILES.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").replace(/\r\n?/g, "\n").trim() }));
}

/**
 * THIRD_PARTY_NOTICES.txt for the given bundled packages (throws on a missing or disallowed license). `artifact` and
 * `generator` name the bundle and what wrote the file (the desktop app's own bundle reuses this: packages/desktop/scripts/bundle.mjs).
 */
export function renderWebNotices(
  packages: readonly BundledPackage[],
  options: { artifact?: string; generator?: string } = {},
): string {
  const artifact = options.artifact ?? "aicad web app";
  const generator = options.generator ?? "packages/app/vite.config.ts at build time";
  const rule = "=".repeat(100);
  const thirdParty = packages.filter((p) => p.thirdParty);
  const firstParty = packages.filter((p) => !p.thirdParty);
  const problems: string[] = [];
  const sections: string[] = [];
  for (const p of thirdParty) {
    if (!p.license) problems.push(`${p.name}@${p.version} declares no license`);
    else if (!licenseAllowed(p.license)) problems.push(`${p.name}@${p.version} is ${p.license}, outside the allowed licenses (${[...WEB_ALLOWED_LICENSES].join(", ")})`);
    let files = licenseFiles(p.dir);
    if (files.length === 0 && p.license === "MIT") {
      files = [{ file: "(canonical MIT text; the package ships no license file)", text: mitText(p.author ?? `the ${p.name} authors`) }];
    }
    if (files.length === 0) problems.push(`${p.name}@${p.version} (${p.license}) ships no license file`);
    const comments = legalComments(p.files);
    sections.push(
      [
        rule,
        `${p.name} ${p.version} — ${p.license}`,
        ...(p.repository ? [`Repository: ${p.repository.replace(/^git\+/, "")}`] : []),
        `Files: ${files.map((f) => f.file).join(", ")}`,
        rule,
        "",
        ...files.flatMap((f) => [f.text, ""]),
        ...(comments.length > 0 ? [`License comments in the bundled files of ${p.name}:`, "", ...comments.flatMap((c) => [c, ""])] : []),
      ].join("\n"),
    );
  }
  if (problems.length > 0) throw new Error(`third-party notices:\n  - ${problems.join("\n  - ")}`);

  const apache = firstParty.filter((p) => p.license === "Apache-2.0");
  if (apache.length > 0) {
    const own = apache.map((p) => join(p.dir, "LICENSE")).find((f) => existsSync(f));
    const text = readFileSync(own ?? join(repoRoot, "LICENSE-APACHE-2.0"), "utf8").trim();
    sections.push([rule, `Apache License 2.0 — ${apache.map((p) => `${p.name} ${p.version}`).join(", ")} (aicad, first-party)`, rule, "", text, ""].join("\n"));
  }

  const forgeWeb = firstParty.find((p) => p.name === "@aicad/forge-web");
  if (forgeWeb) {
    const crates = join(forgeWeb.dir, "pkg", "THIRD_PARTY_LICENSES.txt");
    if (!existsSync(crates)) {
      throw new Error(`${crates} is missing: the bundled Forge WASM module needs its crate notices (rebuild with \`pnpm --filter @aicad/forge-web build\`)`);
    }
    sections.push(readFileSync(crates, "utf8").trim() + "\n");
  }

  const w = Math.max(7, ...thirdParty.map((p) => p.name.length));
  const pad = (s: string, n: number): string => s + " ".repeat(Math.max(0, n - s.length));
  return [
    `THIRD-PARTY SOFTWARE NOTICES: ${artifact}`,
    rule,
    "",
    `The ${artifact} is licensed under the Mozilla Public License 2.0 (LICENSE.txt next to this`,
    "file). It bundles the third-party npm packages listed below, whose license texts and notices",
    "follow, and Forge compiled to WebAssembly, whose third-party Rust crates are listed at the end.",
    "",
    `First-party packages bundled: ${firstParty.map((p) => `${p.name} (${p.license || "unlicensed"})`).join(", ") || "none"}.`,
    "",
    `Generated by ${generator} from the modules in the bundle. Do not edit.`,
    "",
    `${pad("Package", w)}  ${pad("Version", 10)}  License`,
    `${"-".repeat(w)}  ${"-".repeat(10)}  ${"-".repeat(20)}`,
    ...thirdParty.map((p) => `${pad(p.name, w)}  ${pad(p.version, 10)}  ${p.license}`),
    "",
    ...sections,
  ]
    .join("\n")
    .trimEnd()
    .concat("\n");
}

function mitText(holder: string): string {
  return [
    "MIT License",
    "",
    `Copyright (c) ${holder}`,
    "",
    "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and",
    'associated documentation files (the "Software"), to deal in the Software without restriction,',
    "including without limitation the rights to use, copy, modify, merge, publish, distribute,",
    "sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is",
    "furnished to do so, subject to the following conditions:",
    "",
    "The above copyright notice and this permission notice shall be included in all copies or",
    "substantial portions of the Software.",
    "",
    'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT',
    "NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND",
    "NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,",
    "DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT",
    "OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
  ].join("\n");
}

/**
 * Collects the module ids of every chunk (worker bundles through `worker()`, which Vite builds
 * before the main bundle's `generateBundle`) and emits the notices and the MPL text with the main
 * bundle.
 */
export function thirdPartyNoticesPlugin(): { main: Plugin; worker: () => Plugin } {
  const ids = new Set<string>();
  const collect = (bundle: Record<string, { type: string; moduleIds?: readonly string[] }>): void => {
    for (const out of Object.values(bundle)) if (out.type === "chunk") for (const id of out.moduleIds ?? []) ids.add(id);
  };
  return {
    worker: () => ({
      name: "aicad:third-party-notices:worker",
      apply: "build",
      generateBundle(_options, bundle) {
        collect(bundle);
      },
    }),
    main: {
      name: "aicad:third-party-notices",
      apply: "build",
      generateBundle(_options, bundle) {
        collect(bundle);
        let notices: string;
        try {
          notices = renderWebNotices(bundledPackages(ids));
        } catch (e) {
          this.error(e instanceof Error ? e.message : String(e));
        }
        this.emitFile({ type: "asset", fileName: "THIRD_PARTY_NOTICES.txt", source: notices });
        this.emitFile({ type: "asset", fileName: "LICENSE.txt", source: readFileSync(join(repoRoot, "LICENSE-MPL-2.0"), "utf8") });
      },
    },
  };
}

const notices = thirdPartyNoticesPlugin();

export default defineConfig({
  // Relative asset URLs: the bundle is served from app://aicad/ by the desktop shell (and can be
  // hosted under any path on the web).
  base: "./",
  plugins: [react(), forgeWebPlugin(), notices.main],
  worker: {
    format: "es",
    plugins: () => [forgeWebPlugin(), notices.worker()],
  },
  server: {
    port: 5173,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  preview: {
    port: 4173,
    strictPort: true,
    headers: CROSS_ORIGIN_ISOLATION_HEADERS,
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    target: "es2023",
    sourcemap: true,
    // Monaco and the TypeScript compiler (CadScript runs on it) are large by nature.
    chunkSizeWarningLimit: 12_000,
  },
});
