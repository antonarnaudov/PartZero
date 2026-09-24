// License policy shared by the license gates (CLAUDE.md principle 5, LICENSING.md,
// ADR 0000 and ADR 0001). The Rust side of the same policy is forge/deny.toml; keep the two
// allow lists in step.

/**
 * SPDX identifiers a shipped dependency may be used under. Anything else is denied, in
 * particular every GPL, LGPL and AGPL version. An OR expression passes when one side is
 * allowed (we take that side); an AND expression needs every side.
 */
export const ALLOWED_LICENSES = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Zlib",
  "0BSD",
  "Unlicense",
  "Unicode-3.0",
  "MPL-2.0",
  // Permissive licenses that occur in the JavaScript ecosystem only:
  "BlueOak-1.0.0", // permissive, patent grant (isaacs' packages)
  "CC0-1.0", // public-domain dedication
  "Python-2.0", // PSF license, permissive (argparse's port)
]);

/** Allowed `<license> WITH <exception>` pairs. */
export const ALLOWED_WITH = new Set(["Apache-2.0 WITH LLVM-exception"]);

/** Never allowed in a shipped artifact, whatever else the expression says (for messages). */
export const DENIED_FAMILIES = [/^A?GPL-/, /^LGPL-/];

/**
 * The license each of our own manifests must declare (LICENSING.md, ADR 0001). The first
 * matching rule wins; `path` is repo-relative with forward slashes.
 */
export const OWN_LICENSES = [
  // The file-format and language contract: Apache-2.0 so third-party tools can adopt it.
  { path: "forge/crates/forge-ir", license: "Apache-2.0" },
  { path: "packages/cadscript", license: "Apache-2.0" },
  { path: "packages/ir-types", license: "Apache-2.0" },
  { path: "packages/sdk", license: "Apache-2.0" },
  { path: "packages/mcp-schema", license: "Apache-2.0" },
  { path: "skills", license: "Apache-2.0" },
  { path: "corpus", license: "Apache-2.0" },
  // Everything else we write: the engine, the app and engine packages, and the oracle and
  // ML tooling.
  { path: "forge", license: "MPL-2.0" },
  { path: "packages", license: "MPL-2.0" },
  { path: "oracle", license: "MPL-2.0" },
  { path: "ml", license: "MPL-2.0" },
  { path: "", license: "MPL-2.0" }, // the monorepo root manifest
];

export function expectedOwnLicense(relPath) {
  const p = relPath.replace(/\\/g, "/").replace(/\/?(package\.json|Cargo\.toml|pyproject\.toml)$/, "");
  for (const r of OWN_LICENSES) {
    if (r.path === "" || p === r.path || p.startsWith(r.path + "/")) return r.license;
  }
  return undefined;
}

/**
 * Development dependencies that are nevertheless shipped inside a package's artifact.
 * `leaf: true` means only the package itself ships (its own dependencies are install-time
 * tooling): Electron's runtime is downloaded by `@electron/get`, which does not ship.
 */
const INLINED = "inlined into bundle/ by packages/desktop/scripts/bundle.mjs (main process, agent worker, MCP shim)";

export const SHIPPED_DEV_DEPENDENCIES = {
  // Every workspace package the desktop app depends on ships: the web UI as app-web, the rest inlined into the bundle
  // (test: license-check.test.mjs checks that each `workspace:` devDependency is listed here).
  "@aicad/desktop": [
    { name: "@aicad/app", reason: "the web UI ships as the app-web extra resource" },
    { name: "@aicad/agent", reason: INLINED },
    { name: "@aicad/agent-tools", reason: INLINED },
    { name: "@aicad/cadscript", reason: INLINED },
    { name: "@aicad/evals", reason: `${INLINED}: the agent's Forge CLI engine` },
    { name: "@aicad/forge-web", reason: `${INLINED}, and its WASM next to the worker` },
    { name: "@aicad/ir-types", reason: INLINED },
    { name: "@aicad/llm-gateway", reason: INLINED },
    { name: "@aicad/mcp-server", reason: INLINED },
    { name: "electron", leaf: true, reason: "the Electron runtime ships with the desktop app" },
  ],
};

/**
 * Third-party packages whose manifest has no usable `license` field, with the license
 * checked by hand. Keyed by `name@version`; every entry needs a reason.
 */
export const LICENSE_OVERRIDES = {};

/**
 * Oracle libraries (ADR 0000): they may be referenced only from an oracle directory (see
 * classifyOracleDir), never from code or manifests that can ship.
 */
export const ORACLE_LIBRARIES = [
  { lib: "OCCT via OCP", python: ["OCP"], dist: ["cadquery-ocp", "cadquery-ocp-novtk", "ocp"], js: [] },
  { lib: "build123d", python: ["build123d"], dist: ["build123d"], js: ["build123d"] },
  { lib: "PlaneGCS", python: ["planegcs"], dist: ["planegcs"], js: ["@salusoft89/planegcs", "planegcs"] },
  { lib: "SolveSpace", python: ["slvs", "python_solvespace"], dist: ["python-solvespace", "slvs", "solvespace"], js: ["slvs", "solvespace"] },
  { lib: "OCCT (JavaScript/WASM builds)", python: [], dist: [], js: ["opencascade.js", "replicad-opencascadejs", "occt-import-js"] },
];

/** True when a repo-relative file path lies inside a directory named `oracle` (allowed or not). */
export function inOracleDir(relPath) {
  return outermostOracleDir(relPath) !== undefined;
}

/**
 * The outermost directory named `oracle` that contains the repo-relative *file* path
 * `relPath` (e.g. `forge/crates/forge-solve/oracle` for
 * `forge/crates/forge-solve/oracle/planegcs_oracle.mjs`), or undefined.
 */
export function outermostOracleDir(relPath) {
  const parts = relPath.replace(/\\/g, "/").split("/");
  parts.pop(); // the file name itself does not count
  const i = parts.indexOf("oracle");
  return i < 0 ? undefined : parts.slice(0, i + 1).join("/");
}

const within = (path, dir) => dir === "" || path === dir || path.startsWith(dir + "/");

/**
 * Whether the directory `dir` (repo-relative, its last component `oracle`) is an oracle
 * directory in the sense of ADR 0000's amendment, i.e. a place where oracle libraries may be
 * used because nothing in it can ship:
 *   * the repository's `oracle/`;
 *   * `<crate>/oracle/` right beside the Cargo.toml of a Rust crate, e.g.
 *     `forge/crates/forge-solve/oracle/`: Cargo compiles only `src/`, `tests/`, `benches/`,
 *     `examples/`, `build.rs` and the paths the manifest names, never this directory;
 *   * any other `*\/oracle/` directory outside every pnpm workspace package and every Rust
 *     crate (CI and dev tooling).
 * It is *not* one when it lies strictly inside a pnpm workspace package (its files can ship
 * through `files` or the bundler) or anywhere else inside a Rust crate (e.g. `src/oracle/`,
 * which a `mod oracle;` compiles). `packageDirs` and `crateDirs` are repo-relative. An oracle
 * directory that *is* a workspace package or crate is reported by the membership checks.
 * Returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function classifyOracleDir(dir, { packageDirs = [], crateDirs = [] } = {}) {
  if (dir === "oracle") return { ok: true };
  const pkg = packageDirs.find((p) => p !== "" && dir !== p && within(dir, p));
  if (pkg) {
    return { ok: false, reason: `an oracle directory inside the pnpm workspace package ${pkg}/ (its files can ship through \`files\` or the bundler); oracle tooling goes in oracle/ or beside a crate, never inside a shipped package` };
  }
  const crate = crateDirs.find((c) => dir !== c && within(dir, c));
  if (crate && dir !== `${crate === "" ? "" : crate + "/"}oracle`) {
    return { ok: false, reason: `an oracle directory inside the sources of the Rust crate ${crate || "."}/ (only ${crate ? crate + "/" : ""}oracle/, beside its Cargo.toml, is never compiled)` };
  }
  return { ok: true };
}
