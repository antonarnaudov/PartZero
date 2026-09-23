/**
 * Third-party notices and license files that ship with the app (phase 0 audit M11, L15, L17, L18):
 * - the Rust crate notices generator (packages/forge-web/scripts/build.mjs) used for
 *   `forge_wasm_bg.wasm` and for the `aicad` binary this app bundles;
 * - the web bundle's notices (packages/app/vite.config.ts), which the app shows in About → Licenses;
 * - LICENSE files of the publishable workspace packages.
 * The desktop suite owns these checks because the packaged app redistributes all three.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tempDirs } from "./temp-dirs.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const forgeDir = join(repoRoot, "forge");
const tmp = tempDirs("aicad-notices-test-");

interface CargoPackage {
  id: string;
  name: string;
  version: string;
  license: string | null;
  license_file?: string | null;
  source: string | null;
  manifest_path: string;
  authors?: string[];
}
interface CargoMetadata {
  packages: CargoPackage[];
  resolve: { nodes: Array<{ id: string; deps: Array<{ pkg: string; dep_kinds: Array<{ kind: string | null }> }> }> };
}
interface CargoNoticesModule {
  WASM_TARGET: string;
  electLicenses(expression: string): string[];
  cargoMetadata(o: { forgeDir: string; target: string }): CargoMetadata;
  hostTarget(forgeDir: string): string;
  cargoNotices(o: { metadata: CargoMetadata; rootPackage: string; artifact: string; target: string; repoRoot: string }): string;
  thirdPartyCrates(metadata: CargoMetadata, rootPackage: string): CargoPackage[];
}
interface BundledPackage {
  name: string;
  version: string;
  license: string;
  thirdParty: boolean;
  files: string[];
}
interface WebNoticesModule {
  bundledPackages(ids: Iterable<string>): BundledPackage[];
  renderWebNotices(packages: readonly BundledPackage[]): string;
  licenseAllowed(expression: string): boolean;
  legalComments(files: readonly string[]): string[];
}

// Build tooling of sibling packages, loaded by path (not part of their public API or type graph).
const cargo = (): Promise<CargoNoticesModule> => import(join(repoRoot, "packages", "forge-web", "scripts", "build.mjs")) as Promise<CargoNoticesModule>;
const web = (): Promise<WebNoticesModule> => import(join(repoRoot, "packages", "app", "vite.config.ts")) as Promise<WebNoticesModule>;

/** A fake crate on disk plus the metadata entry for it. */
function crate(root: string, name: string, license: string | null, files: Record<string, string>, authors: string[] = []): CargoPackage {
  const dir = join(root, `${name}-1.0.0`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "Cargo.toml"), `[package]\nname = "${name}"\n`);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return { id: `${name} 1.0.0`, name, version: "1.0.0", license, source: "registry+https://github.com/rust-lang/crates.io-index", manifest_path: join(dir, "Cargo.toml"), authors };
}

function metadataFor(deps: CargoPackage[], devOnly: CargoPackage[] = []): CargoMetadata {
  const root: CargoPackage = { id: "root 0.1.0", name: "root", version: "0.1.0", license: "MPL-2.0", source: null, manifest_path: "/nonexistent/Cargo.toml" };
  return {
    packages: [root, ...deps, ...devOnly],
    resolve: {
      nodes: [
        { id: root.id, deps: [...deps.map((d) => ({ pkg: d.id, dep_kinds: [{ kind: null }] })), ...devOnly.map((d) => ({ pkg: d.id, dep_kinds: [{ kind: "dev" }] }))] },
        ...[...deps, ...devOnly].map((d) => ({ id: d.id, deps: [] })),
      ],
    },
  };
}

const MIT = "MIT License\n\nCopyright (c) 2020 Someone\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software…";

describe("L15: Rust crate notices (forge_wasm_bg.wasm, aicad)", () => {
  it("elects one license per choice, deterministically, and refuses copyleft-only crates", async () => {
    const { electLicenses } = await cargo();
    expect(electLicenses("MIT OR Apache-2.0")).toEqual(["MIT"]);
    expect(electLicenses("Apache-2.0/MIT")).toEqual(["MIT"]);
    expect(electLicenses("Zlib OR Apache-2.0 OR MIT")).toEqual(["MIT"]);
    expect(electLicenses("(MIT OR Apache-2.0) AND Unicode-3.0")).toEqual(["MIT", "Unicode-3.0"]);
    expect(electLicenses("Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT")).toEqual(["MIT"]);
    expect(electLicenses("Apache-2.0")).toEqual(["Apache-2.0"]);
    expect(electLicenses("MIT OR LGPL-2.1-or-later")).toEqual(["MIT"]);
    expect(() => electLicenses("GPL-3.0-only")).toThrow(/no alternative in the allowed list/);
    expect(() => electLicenses("MIT AND GPL-2.0")).toThrow(/no alternative/);
    expect(() => electLicenses("MIT OR")).toThrow(/cannot parse/);
  });

  it("lists each crate with the elected license, includes each text once, and skips dev-only crates", async () => {
    const { cargoNotices } = await cargo();
    const root = tmp();
    const a = crate(root, "alpha", "MIT OR Apache-2.0", { "LICENSE-MIT": MIT, "LICENSE-APACHE": "Apache License\nVersion 2.0, January 2004\n…" });
    const b = crate(root, "beta", "Zlib", { LICENSE: "This software is provided 'as-is', without any express or implied\nwarranty. … altered source versions must be plainly marked" });
    const c = crate(root, "gamma", "MIT", {}, ["Grace Hopper <grace@example.com>"]);
    const d = crate(root, "delta", "Apache-2.0", { NOTICE: "Delta notice text" });
    const dev = crate(root, "devonly", "GPL-3.0-only", {});
    const text = cargoNotices({ metadata: metadataFor([a, b, c, d], [dev]), rootPackage: "root", artifact: "test.wasm", target: "wasm32-unknown-unknown", repoRoot });
    expect(text).toMatch(/^alpha +1\.0\.0 +MIT OR Apache-2\.0 +MIT$/m);
    expect(text).toMatch(/^beta +1\.0\.0 +Zlib +Zlib$/m);
    expect(text).toMatch(/^Rust standard library \(std, core, alloc\) +MIT OR Apache-2\.0 +MIT$/m);
    expect(text).toContain("Copyright (c) 2020 Someone"); // the crate's own MIT file…
    expect(text).not.toContain("Version 2.0, January 2004\n…"); // …not the text of the license it was not used under
    expect(text).toContain("Copyright (c) Grace Hopper"); // canonical MIT text with the crate's authors
    expect(text).toContain("gamma 1.0.0 (canonical MIT text; the crate ships none)");
    expect(text).toContain("Delta notice text"); // Apache-2.0 §4(d) NOTICE files are carried along
    expect(text).toContain("delta 1.0.0 (canonical Apache-2.0 text; the crate ships none)"); // from the repo's LICENSE-APACHE-2.0
    expect(text).not.toContain("devonly");
    expect(cargoNotices({ metadata: metadataFor([d, c, b, a], [dev]), rootPackage: "root", artifact: "test.wasm", target: "wasm32-unknown-unknown", repoRoot })).toBe(text);
  });

  it("fails instead of shipping a crate without a usable license or text", async () => {
    const { cargoNotices } = await cargo();
    const root = tmp();
    const opts = (deps: CargoPackage[]) => ({ metadata: metadataFor(deps), rootPackage: "root", artifact: "x", target: "t", repoRoot });
    expect(() => cargoNotices(opts([crate(root, "gpl", "GPL-3.0-only", { LICENSE: "GNU GENERAL PUBLIC LICENSE" })]))).toThrow(/gpl 1\.0\.0: license "GPL-3\.0-only" has no alternative/);
    expect(() => cargoNotices(opts([crate(root, "nolicense", null, {})]))).toThrow(/nolicense 1\.0\.0 declares no SPDX license/);
    expect(() => cargoNotices(opts([crate(root, "zlibnotext", "Zlib", {})]))).toThrow(/zlibnotext 1\.0\.0 is used under Zlib but ships no Zlib text/);
  });

  it.skipIf(!existsSync(join(forgeDir, "Cargo.lock")))("covers the real forge-wasm and forge-cli dependency trees", async () => {
    const m = await cargo();
    for (const [rootPackage, target, mustInclude] of [
      ["forge-wasm", m.WASM_TARGET, ["wgpu", "naga", "libm", "slotmap", "foldhash", "codespan-reporting", "wasm-bindgen"]],
      ["forge-cli", m.hostTarget(forgeDir), ["clap", "strsim", "serde_json", "miniz_oxide"]],
    ] as const) {
      const metadata = m.cargoMetadata({ forgeDir, target });
      const crates = m.thirdPartyCrates(metadata, rootPackage);
      const text = m.cargoNotices({ metadata, rootPackage, artifact: rootPackage, target, repoRoot });
      for (const name of mustInclude) expect(crates.map((c) => c.name), `${rootPackage}: ${name}`).toContain(name);
      for (const c of crates) expect(text, `${rootPackage}: ${c.name}`).toMatch(new RegExp(`^${c.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} +${c.version.replace(/[.+]/g, "\\$&")} `, "m"));
      expect(text).not.toMatch(/^forge-(core|ir|regen|mesh|io) /m); // our own crates are not third-party
    }
  });

  it.skipIf(process.platform === "win32")("build.mjs runs when invoked through a symlinked path (no silent no-op)", () => {
    const scripts = join(repoRoot, "packages", "forge-web", "scripts");
    const dir = tmp();
    const noTools = join(dir, "no-tools");
    mkdirSync(noTools);
    symlinkSync(join(scripts, "build.mjs"), join(dir, "build.mjs")); // a symlinked file
    symlinkSync(scripts, join(dir, "scripts")); // a symlinked directory (checkout, /tmp → /private/tmp)
    for (const entry of [join(dir, "build.mjs"), join(dir, "scripts", "build.mjs")]) {
      const r = spawnSync(process.execPath, [entry], { env: { PATH: noTools, FORGE_DIR: join(dir, "no-forge") }, encoding: "utf8", timeout: 60_000 });
      // The build ran and stopped at its first tool check, instead of exiting 0 having done nothing.
      expect(r.stderr, entry).toMatch(/forge-web: wasm-bindgen not found/);
      expect(r.status, entry).toBe(1);
    }
  });

  it("forge-web ships the wasm notices in its npm files", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "packages", "forge-web", "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("pkg/THIRD_PARTY_LICENSES.txt");
  });
});

describe("M11: web bundle notices (THIRD_PARTY_NOTICES.txt)", () => {
  /** A fake npm package under node_modules with one bundled module. */
  function npmPackage(name: string, license: string | undefined, files: Record<string, string>, moduleText = "export {};\n"): string {
    const dir = join(tmp(), "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.2.3", ...(license === undefined ? {} : { license }) }));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "package.json"), JSON.stringify({ type: "module" })); // nested marker: not the package root
    const mod = join(dir, "dist", "index.js");
    writeFileSync(mod, moduleText);
    return mod;
  }

  it("attributes modules to their packages, with license files and the license comments the minifier drops", async () => {
    const { bundledPackages, renderWebNotices } = await web();
    const vendored = "/*! @license Vendored 1.0 | (c) Someone | MIT */\nexport const x = 1;\n/* plain comment */\n";
    const mod = npmPackage("widget", "MIT", { LICENSE: "MIT License\n\nCopyright (c) Widget Authors", "ThirdPartyNotices.txt": "widget bundles foo (BSD)" }, vendored);
    const pkgs = bundledPackages([mod, `${mod}?worker`, "\0virtual:x", "rolldown:runtime"]);
    expect(pkgs.map((p) => `${p.name}@${p.version}:${p.thirdParty}`)).toEqual(["widget@1.2.3:true"]);
    const text = renderWebNotices(pkgs);
    expect(text).toMatch(/^widget +1\.2\.3 +MIT$/m);
    expect(text).toContain("Copyright (c) Widget Authors");
    expect(text).toContain("widget bundles foo (BSD)");
    expect(text).toContain("/*! @license Vendored 1.0 | (c) Someone | MIT */");
    expect(text).not.toContain("plain comment");
  });

  it("fails the build for a missing or disallowed license, or a license without text", async () => {
    const { bundledPackages, renderWebNotices, licenseAllowed } = await web();
    expect(licenseAllowed("(MPL-2.0 OR Apache-2.0)")).toBe(true);
    expect(licenseAllowed("Apache-2.0 WITH LLVM-exception")).toBe(true);
    expect(licenseAllowed("GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("MIT OR GPL-3.0-only")).toBe(false); // needs a human decision
    expect(licenseAllowed("")).toBe(false);
    const render = (name: string, license: string | undefined, files: Record<string, string>) => () => renderWebNotices(bundledPackages([npmPackage(name, license, files)]));
    expect(render("copyleft", "AGPL-3.0-only", { LICENSE: "x" })).toThrow(/copyleft@1\.2\.3 is AGPL-3\.0-only, outside the allowed licenses/);
    expect(render("unlicensed", undefined, { LICENSE: "x" })).toThrow(/unlicensed@1\.2\.3 declares no license/);
    expect(render("textless", "BSD-3-Clause", {})).toThrow(/textless@1\.2\.3 \(BSD-3-Clause\) ships no license file/);
    expect(render("mit-textless", "MIT", {})()).toContain("canonical MIT text");
  });

  const built = join(repoRoot, "packages", "app", "dist", "web");
  it.skipIf(!existsSync(join(built, "index.html")))("the built web app ships THIRD_PARTY_NOTICES.txt and LICENSE.txt", () => {
    const notices = readFileSync(join(built, "THIRD_PARTY_NOTICES.txt"), "utf8");
    for (const s of ["monaco-editor", "react-dom", "typescript", "zod", "@license DOMPurify", "@license React"]) expect(notices).toContain(s);
    expect(readFileSync(join(built, "LICENSE.txt"), "utf8")).toBe(readFileSync(join(repoRoot, "LICENSE-MPL-2.0"), "utf8"));
  });
});

describe("L17: publishable packages ship their LICENSE", () => {
  const TEXTS: Record<string, string> = { "Apache-2.0": "LICENSE-APACHE-2.0", "MPL-2.0": "LICENSE-MPL-2.0" };

  const packagesDir = join(repoRoot, "packages");
  const manifests = readdirSync(packagesDir)
    .filter((d) => existsSync(join(packagesDir, d, "package.json")))
    .map((d) => ({ dir: join(packagesDir, d), pkg: JSON.parse(readFileSync(join(packagesDir, d, "package.json"), "utf8")) as { name: string; license?: string; private?: boolean } }));

  it("every non-private package has a LICENSE whose text matches its manifest license (LICENSING.md)", () => {
    const publishable = manifests.filter((m) => m.pkg.private !== true);
    expect(publishable.map((m) => m.pkg.name).sort()).toEqual(["@aicad/cadscript", "@aicad/forge-web", "@aicad/ir-types", "@aicad/llm-gateway"]);
    for (const { dir, pkg } of publishable) {
      const file = join(dir, "LICENSE");
      expect(existsSync(file), `${pkg.name} has no LICENSE`).toBe(true);
      expect(TEXTS[pkg.license ?? ""], `${pkg.name}: license ${pkg.license}`).toBeDefined();
      expect(readFileSync(file, "utf8"), pkg.name).toBe(readFileSync(join(repoRoot, TEXTS[pkg.license!]!), "utf8"));
    }
  });

  it("follows the licensing decision: CadScript and the IR types Apache-2.0, everything else MPL-2.0", () => {
    const license = (name: string) => manifests.find((m) => m.pkg.name === name)?.pkg.license;
    expect(license("@aicad/cadscript")).toBe("Apache-2.0");
    expect(license("@aicad/ir-types")).toBe("Apache-2.0");
    expect(license("@aicad/llm-gateway")).toBe("MPL-2.0");
    expect(license("@aicad/forge-web")).toBe("MPL-2.0");
  });
});
