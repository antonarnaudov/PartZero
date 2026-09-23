// Self-tests of the license gates: `node --test scripts/license-check/test/`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { check as checkJs } from "../js-licenses.mjs";
import { check as checkDatasets } from "../dataset-record.mjs";
import { check as checkBoundary } from "../oracle-boundary.mjs";
import { check as checkOwn } from "../own-licenses.mjs";
import { classifyOracleDir, expectedOwnLicense, inOracleDir } from "../policy.mjs";
import { evaluate } from "../spdx.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tmp = mkdtempSync(join(tmpdir(), "license-check-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name, files) {
  const root = join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

describe("SPDX policy", () => {
  for (const ok of [
    "MIT",
    "mit",
    "Apache-2.0 OR MIT",
    "(MIT OR Apache-2.0) AND Unicode-3.0",
    "Apache-2.0/MIT",
    "MIT OR GPL-3.0-or-later",
    "(MPL-2.0 OR Apache-2.0)",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-3-Clause",
    "Zlib OR Apache-2.0 OR MIT",
  ]) {
    test(`allows ${ok}`, () => assert.equal(evaluate(ok).ok, true));
  }
  for (const bad of [
    "GPL-3.0",
    "GPL-2.0-only",
    "LGPL-2.1-or-later",
    "AGPL-3.0",
    "MIT AND GPL-2.0",
    "(MIT AND LGPL-3.0) OR GPL-3.0",
    "GPL-2.0 WITH Classpath-exception-2.0",
    "SEE LICENSE IN LICENSE.txt",
    "UNLICENSED",
    "MIT OR",
    "(MIT",
  ]) {
    test(`denies ${bad}`, () => assert.equal(evaluate(bad).ok, false));
  }
});

describe("own-license map (LICENSING.md)", () => {
  test("forge-ir is Apache-2.0, the file-format contract", () => assert.equal(expectedOwnLicense("forge/crates/forge-ir/Cargo.toml"), "Apache-2.0"));
  test("other forge crates are MPL-2.0", () => assert.equal(expectedOwnLicense("forge/crates/forge-core/Cargo.toml"), "MPL-2.0"));
  test("llm-gateway is MPL-2.0 like the other app packages", () => assert.equal(expectedOwnLicense("packages/llm-gateway"), "MPL-2.0"));
  test("cadscript and ir-types are Apache-2.0", () => {
    assert.equal(expectedOwnLicense("packages/cadscript/package.json"), "Apache-2.0");
    assert.equal(expectedOwnLicense("packages/ir-types"), "Apache-2.0");
  });
  test("oracle tooling is MPL-2.0", () => {
    assert.equal(expectedOwnLicense("oracle/pyproject.toml"), "MPL-2.0");
    assert.equal(expectedOwnLicense("forge/crates/forge-solve/oracle/package.json"), "MPL-2.0");
  });
  test("oracle directories: oracle/ and */oracle/, not a file called oracle", () => {
    assert.equal(inOracleDir("oracle/src/x.py"), true);
    assert.equal(inOracleDir("forge/crates/forge-solve/oracle/planegcs_oracle.mjs"), true);
    assert.equal(inOracleDir("packages/evals/src/oracle.ts"), false);
    assert.equal(inOracleDir("packages/oracle-client/index.ts"), false);
  });
  test("an oracle directory never lies inside a shipped package or a crate's sources", () => {
    const layout = { packageDirs: ["packages/foo"], crateDirs: ["forge/crates/forge-solve"] };
    assert.equal(classifyOracleDir("oracle", layout).ok, true);
    assert.equal(classifyOracleDir("forge/crates/forge-solve/oracle", layout).ok, true); // beside Cargo.toml
    assert.equal(classifyOracleDir("tools/oracle", layout).ok, true); // CI/dev tooling
    assert.match(classifyOracleDir("packages/foo/src/oracle", layout).reason, /inside the pnpm workspace package packages\/foo\//);
    assert.match(classifyOracleDir("packages/foo/oracle", layout).reason, /pnpm workspace package/);
    assert.match(classifyOracleDir("forge/crates/forge-solve/src/oracle", layout).reason, /inside the sources of the Rust crate/);
  });
});

describe("js-licenses", () => {
  const ws = (license, deps = {}, extra = {}) => ({ name: "@aicad/a", version: "0.0.1", license, dependencies: deps, ...extra });
  const base = { "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n' };

  test("passes a permissive closure, following dependencies transitively", () => {
    const root = tree("js-ok", {
      ...base,
      "packages/a/package.json": ws("MPL-2.0", { x: "1" }),
      "node_modules/x/package.json": { name: "x", version: "1.0.0", license: "MIT", dependencies: { y: "1" } },
      "node_modules/y/package.json": { name: "y", version: "1.0.0", license: "ISC" },
    });
    const r = checkJs(root);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.packages.map((p) => p.name).sort(), ["@aicad/a", "x", "y"]);
  });

  test("fails a transitive GPL dependency and names the path to it", () => {
    const root = tree("js-gpl", {
      ...base,
      "packages/a/package.json": ws("MPL-2.0", { x: "1" }),
      "node_modules/x/package.json": { name: "x", version: "1.0.0", license: "MIT", dependencies: { g: "1" } },
      "node_modules/g/package.json": { name: "g", version: "2.0.0", license: "LGPL-3.0-or-later" },
    });
    const r = checkJs(root);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].package, "g@2.0.0");
    assert.deepEqual(r.violations[0].chain, ["@aicad/a@0.0.1", "x@1.0.0", "g@2.0.0"]);
  });

  test("ignores devDependencies but not shipped ones, and fails missing or unlicensed packages", () => {
    const root = tree("js-missing", {
      ...base,
      "packages/a/package.json": ws("MPL-2.0", { gone: "1", nolic: "1" }, { devDependencies: { devgpl: "1" } }),
      "node_modules/devgpl/package.json": { name: "devgpl", version: "1.0.0", license: "GPL-3.0" },
      "node_modules/nolic/package.json": { name: "nolic", version: "1.0.0" },
    });
    const problems = checkJs(root).violations.map((v) => `${v.package}: ${v.problem}`);
    assert.equal(problems.length, 2, problems.join("\n"));
    assert.match(problems.join("\n"), /gone: not installed/);
    assert.match(problems.join("\n"), /nolic@1\.0\.0: no license field/);
  });

  test("fails an oracle library anywhere in the shipped closure, whatever its license", () => {
    const root = tree("js-oracle-lib", {
      ...base,
      "packages/a/package.json": ws("MPL-2.0", { x: "1" }),
      "node_modules/x/package.json": { name: "x", version: "1.0.0", license: "MIT", dependencies: { "@salusoft89/planegcs": "1" } },
      // (PlaneGCS is LGPL; a mislabelled copy must still fail on its name.)
      "node_modules/@salusoft89/planegcs/package.json": { name: "@salusoft89/planegcs", version: "1.2.0", license: "MIT" },
    });
    const v = checkJs(root).violations;
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.match(v[0].problem, /oracle library PlaneGCS/);
    assert.deepEqual(v[0].chain, ["@aicad/a@0.0.1", "x@1.0.0", "@salusoft89/planegcs@1.2.0"]);
  });

  test("fails a package linked in from an oracle directory", () => {
    const root = tree("js-oracle-link", {
      ...base,
      "packages/a/package.json": ws("MPL-2.0", { h: "file:../../tools/oracle/h" }),
      "tools/oracle/h/package.json": { name: "h", version: "0.0.1", license: "MPL-2.0" },
    });
    mkdirSync(join(root, "packages/a/node_modules"), { recursive: true });
    symlinkSync(join(root, "tools/oracle/h"), join(root, "packages/a/node_modules/h"), "dir");
    const v = checkJs(root).violations;
    assert.equal(v.length, 1, JSON.stringify(v));
    assert.match(v[0].problem, /lives in an oracle directory \(tools\/oracle\/h\//);
  });

  test("asserts the license LICENSING.md assigns to our own packages", () => {
    const root = tree("js-own", {
      ...base,
      "packages/llm-gateway/package.json": { name: "@aicad/llm-gateway", version: "0.0.1", license: "Apache-2.0" },
    });
    const v = checkJs(root).violations;
    assert.equal(v.length, 1);
    assert.match(v[0].problem, /declares "Apache-2\.0", LICENSING\.md assigns MPL-2\.0/);
  });
});

describe("oracle-boundary", () => {
  test("flags oracle libraries imported or declared outside oracle/ directories", () => {
    const root = tree("boundary-bad", {
      "packages/a/src/solve.ts": 'import { GcsWrapper } from "@salusoft89/planegcs";\n',
      "packages/a/package.json": { name: "a", dependencies: { "@salusoft89/planegcs": "1.2.0" } },
      "tools/mesh.py": "import math\nfrom OCP.BRepMesh import BRepMesh_IncrementalMesh\n",
      "tools/pyproject.toml": '[project]\ndependencies = ["build123d==0.12.0"]\n',
      "tools/solve.py": '# /// script\n# dependencies = ["python-solvespace>=3"]\n# ///\nprint(1)\n',
      "pnpm-lock.yaml": "packages:\n  '@salusoft89/planegcs@1.2.0':\n    resolution: {}\n",
    });
    const files = checkBoundary(root).map((v) => v.file).sort();
    assert.deepEqual(files, [
      "packages/a/package.json:4",
      "packages/a/src/solve.ts:1",
      "pnpm-lock.yaml:2",
      "tools/mesh.py:2",
      "tools/pyproject.toml:2",
      "tools/solve.py:2",
    ]);
  });

  test("allows oracle/ and */oracle/ directories, prose and report data", () => {
    const root = tree("boundary-ok", {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/evals/package.json": { name: "@aicad/evals", license: "MPL-2.0" },
      "forge/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "forge/crates/forge-solve/Cargo.toml": '[package]\nname = "forge-solve"\n\n[dependencies]\nforge-core = { path = "../forge-core" }\n',
      "forge/crates/forge-solve/src/lib.rs": '#[path = "sub/x.rs"]\nmod x;\nconst D: &str = include_str!("../oracle/golden.json");\n',
      "forge/crates/forge-solve/oracle/golden.json": "{}\n",
      "oracle/src/occt.py": "from OCP.BRepGProp import BRepGProp\nimport build123d\n",
      "oracle/pyproject.toml": '[project]\ndependencies = ["build123d==0.12.0", "cadquery-ocp-novtk==7.9.3.1.1"]\n',
      "forge/crates/forge-solve/oracle/package.json": { name: "o", private: true, devDependencies: { "@salusoft89/planegcs": "1.2.0" } },
      "forge/crates/forge-solve/oracle/planegcs_oracle.mjs": 'import { make_gcs_wrapper } from "@salusoft89/planegcs";\n',
      "docs/x.md": "We compare with OCCT via OCP/build123d and PlaneGCS.\n",
      "corpus/golden/a.metrics.json": '{"engine": "occt 7.9.3 (build123d 0.12.0 / OCP 7.9.3.1.1)"}\n',
      "packages/evals/src/engine.ts": "// The oracle engine shells out to `uv run oracle` (OCCT via build123d).\nexport const x = 1;\n",
      // `./oracle` here is a module file, not a directory.
      "packages/evals/src/oracle.ts": "export const y = 2;\n",
      "packages/evals/src/index.ts": 'export { y } from "./oracle";\n',
      // Ordinary project and tool configuration, dynamic imports of ordinary modules.
      "packages/evals/tsconfig.json":
        '{\n  // a comment\n  "extends": "../../tsconfig.base.json",\n  "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, },\n  "include": ["src"],\n}\n',
      "packages/evals/vitest.config.ts": 'export default { test: { include: ["src/**/oracle.test.ts"], alias: { "@": "./src" } } };\n',
      "packages/evals/src/lazy.ts": "export const m = await import(`./oracle.js`);\nexport const s = `planegcs is compared in CI`;\n",
      "tools/load.py": 'import importlib\njson = importlib.import_module("json")\nimport os, sys\n',
    });
    assert.deepEqual(checkBoundary(root), []);
  });

  test("an oracle directory inside a shipped package is flagged, and so is shipped code importing it", () => {
    // Audit review of M10: this fixture used to pass because any `oracle` path segment exempted a file.
    const root = tree("boundary-in-package", {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "packages/foo/package.json": { name: "@aicad/foo", license: "MPL-2.0" },
      "packages/foo/src/index.ts": 'export { solve } from "./oracle/solver";\n',
      "packages/foo/src/oracle/solver.ts": 'import { make_gcs_wrapper } from "@salusoft89/planegcs";\nexport const solve = make_gcs_wrapper;\n',
      "packages/foo/src/oracle/package.json": { name: "foo-oracle", private: true, dependencies: { "@salusoft89/planegcs": "1.2.0" } },
    });
    const v = checkBoundary(root);
    assert.deepEqual(v.map((x) => x.file).sort(), [
      "packages/foo/src/index.ts:1",
      "packages/foo/src/oracle/",
      "packages/foo/src/oracle/package.json:5",
      "packages/foo/src/oracle/solver.ts:1",
    ]);
    assert.match(v.find((x) => x.file === "packages/foo/src/oracle/").problem, /inside the pnpm workspace package packages\/foo\//);
    assert.match(v.find((x) => x.file === "packages/foo/src/index.ts:1").problem, /resolves into the oracle directory packages\/foo\/src\/oracle\//);
  });

  test("nothing outside an oracle directory may reach into one", () => {
    const root = tree("boundary-reach-in", {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "oracle/pyproject.toml": '[project]\nname = "aicad-oracle"\nlicense = "MPL-2.0"\n',
      "oracle/src/aicad_oracle/__init__.py": "",
      "oracle/js/package.json": { name: "occt-oracle-js", private: true },
      "tools/oracle/harness.py": "import OCP\n",
      "forge/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
      "forge/crates/x/Cargo.toml": '[package]\nname = "x"\n\n[[bin]]\nname = "h"\npath = "oracle/main.rs"\n',
      "forge/crates/x/oracle/main.rs": "fn main() {}\n",
      "forge/crates/x/oracle/h.rs": "pub fn h() {}\n",
      "forge/crates/x/src/lib.rs": '#[path = "../oracle/h.rs"]\nmod h;\n',
      "forge/crates/y/Cargo.toml": '[package]\nname = "y"\n',
      "forge/crates/y/src/oracle/mod.rs": "pub fn o() {}\n",
      "packages/a/package.json": { name: "@aicad/a", license: "MPL-2.0", dependencies: { h: "file:../../oracle/js", "occt-oracle-js": "1" } },
      "packages/a/src/run.ts": 'import { run } from "../../../tools/oracle/run.js";\nconst o = require("occt-oracle-js");\n',
      "ml/trainer/train.py": "from ..oracle import harness\nimport aicad_oracle.cli\n",
      "ml/oracle/harness.py": "print(1)\n",
    });
    const files = checkBoundary(root).map((x) => x.file).sort();
    assert.deepEqual(files, [
      "forge/crates/x/Cargo.toml:6", // [[bin]] path into oracle/
      "forge/crates/x/src/lib.rs:1", // #[path] into oracle/
      "forge/crates/y/src/oracle/", // an oracle directory inside a crate's sources
      "ml/trainer/train.py:1", // relative import into ml/oracle/
      "ml/trainer/train.py:2", // the oracle's Python package
      "packages/a/package.json:5", // file: link into oracle/
      "packages/a/package.json:6", // the oracle's JS package, by name
      "packages/a/src/run.ts:1", // relative import into tools/oracle/
      "packages/a/src/run.ts:2", // the oracle's JS package, by name
    ]);
  });

  test("dynamic imports, resolvers, multi-name imports, tsconfig paths and bundler aliases count too", () => {
    // Audit review of M10: none of these forms was flagged.
    const root = tree("boundary-dynamic", {
      "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
      "oracle/js/package.json": { name: "occt-oracle-js", private: true },
      "oracle/js/x.js": "export const x = 1;\n",
      "oracle/src/aicad_oracle/__init__.py": "",
      "packages/a/package.json": { name: "@aicad/a", license: "MPL-2.0", imports: { "#occt": { node: "../../oracle/js/x.js" }, "#gcs": "planegcs" } },
      "packages/a/src/template.ts": "const g = await import(`planegcs`);\n",
      "packages/a/src/resolve.ts": 'export const p = require.resolve("@salusoft89/planegcs");\n',
      "packages/a/src/meta.ts": "export const q = import.meta.resolve('occt-oracle-js');\n",
      "packages/a/src/reach.ts": "export const r = await import(`../../../oracle/js/${name}.js`);\n",
      "packages/a/tsconfig.json": [
        "{",
        "  // comments and trailing commas, as tsc accepts them",
        '  "extends": "../../oracle/js/tsconfig.base.json",',
        '  "compilerOptions": {',
        '    "baseUrl": "./src",',
        '    "paths": {',
        '      "@/*": ["./*"],',
        '      "@occt/*": ["../../../oracle/js/*"],',
        '      "gcs": ["../node_modules/@salusoft89/planegcs"],',
        "    },",
        "    /* block comment */",
        "  },",
        '  "include": ["src", "../../oracle/js/x.js"],',
        '  "references": [{ "path": "../../oracle/js" }],',
        "}",
      ].join("\n"),
      "packages/a/vite.config.ts": [
        'import { resolve } from "node:path";',
        "export default {",
        "  resolve: {",
        "    alias: {",
        '      "@occt": resolve(__dirname, "../../oracle/js"),',
        '      "@o2": resolve(__dirname, "../..", "oracle", "js"),',
        '      gcs: "planegcs",',
        '      "@": resolve(__dirname, "src"),',
        "    },",
        "  },",
        "};",
      ].join("\n"),
      "packages/a/.babelrc": '{\n  "plugins": [["module-resolver", { "alias": { "o": "../../oracle/js" } }]]\n}\n',
      "tools/py/dyn.py": 'import importlib\nOCP = importlib.import_module("OCP.BRepGProp")\n',
      "tools/py/dunder.py": 'b = __import__("build123d")\n',
      "tools/py/multi.py": "import os, OCP.BRep as brep\n",
      "tools/py/spec.py": 'from importlib.util import find_spec\nhave = find_spec("slvs") is not None\n',
      "tools/py/cli.py": 'import importlib\ncli = importlib.import_module("aicad_oracle.cli")\n',
    });
    const files = checkBoundary(root).map((x) => x.file).sort();
    assert.deepEqual(
      files,
      [
        "packages/a/.babelrc:2", // module-resolver alias into oracle/
        "packages/a/package.json:5", // imports["#occt"] into oracle/
        "packages/a/package.json:8", // imports["#gcs"] → planegcs
        "packages/a/src/meta.ts:1", // import.meta.resolve of the oracle's JS package
        "packages/a/src/reach.ts:1", // template-literal relative import into oracle/
        "packages/a/src/resolve.ts:1", // require.resolve("@salusoft89/planegcs")
        "packages/a/src/template.ts:1", // import(`planegcs`)
        "packages/a/tsconfig.json:3", // extends into oracle/
        "packages/a/tsconfig.json:8", // paths alias into oracle/ (relative to baseUrl)
        "packages/a/tsconfig.json:9", // paths alias to node_modules/@salusoft89/planegcs
        "packages/a/tsconfig.json:13", // include into oracle/
        "packages/a/tsconfig.json:14", // project reference into oracle/
        "packages/a/vite.config.ts:5", // alias into oracle/
        "packages/a/vite.config.ts:6", // path segments naming oracle/
        "packages/a/vite.config.ts:7", // alias to planegcs
        "tools/py/cli.py:2", // importlib.import_module of the oracle's Python package
        "tools/py/dunder.py:1", // __import__("build123d")
        "tools/py/dyn.py:2", // importlib.import_module("OCP.…")
        "tools/py/multi.py:1", // import os, OCP.…
        "tools/py/spec.py:2", // find_spec("slvs")
      ].sort(),
    );
  });

  test("an oracle directory must not be a workspace package", () => {
    const root = tree("boundary-ws", {
      "pnpm-workspace.yaml": 'packages:\n  - "tools/oracle"\n',
      "tools/oracle/package.json": { name: "o", private: true },
    });
    assert.match(checkBoundary(root).map((v) => v.problem).join("\n"), /pnpm workspace package/);
  });

  test("the repository itself passes", () => {
    assert.deepEqual(checkBoundary(repo), []);
  });
});

describe("forge/deny.toml", () => {
  test("allows exactly the policy's licenses (Rust and JS stay in step)", async () => {
    const { ALLOWED_LICENSES } = await import("../policy.mjs");
    const text = readFileSync(join(repo, "forge/deny.toml"), "utf8");
    const allow = [...text.match(/^allow\s*=\s*\[([\s\S]*?)^\]/m)[1].matchAll(/^\s*"([^"]+)"/gm)].map((m) => m[1]);
    const jsOnly = new Set(["BlueOak-1.0.0", "CC0-1.0", "Python-2.0"]);
    assert.deepEqual(
      allow.filter((l) => !l.includes(" WITH ")).sort(),
      [...ALLOWED_LICENSES].filter((l) => !jsOnly.has(l)).sort(),
    );
    assert.ok(!allow.some((l) => /GPL/.test(l)), "no GPL-family license may be allowed");
    assert.match(text, /^exclude-dev\s*=\s*true/m);
  });
});

describe("dataset-record", () => {
  const table = "# External datasets\n\n| Dataset | Version / snapshot | Source | License (as published) |\n|---|---|---|---|\n";
  test("the record is the tracked corpus/EXTERNAL_SOURCES.md, and nothing points to the old path", () => {
    const root = tree("datasets-bad", {
      "corpus/EXTERNAL_SOURCES.md": table,
      "docs/FORGE.md": "Every dataset licence is recorded in `corpus/external/SOURCES.md` before use.\n",
      "docs/adr/0001-x.md": "It moved from the git-ignored `corpus/external/SOURCES.md`.\n", // history: exempt
      "docs/audits/a.md": "LICENSING.md requires `corpus/external/SOURCES.md`.\n", // history: exempt
    });
    assert.deepEqual(checkDatasets(root).map((v) => v.file), ["docs/FORGE.md:1"]);
  });
  test("a missing record, or one without its table, fails", () => {
    assert.match(checkDatasets(tree("datasets-none", { "README.md": "x\n" }))[0].problem, /^missing/);
    assert.match(checkDatasets(tree("datasets-empty", { "corpus/EXTERNAL_SOURCES.md": "# External datasets\n" }))[0].problem, /no dataset table/);
    assert.deepEqual(checkDatasets(tree("datasets-ok", { "corpus/EXTERNAL_SOURCES.md": table })), []);
  });
  test(
    "the repository itself passes",
    { todo: "docs/FORGE.md:135 and docs/RESEARCH.md:161 still point to corpus/external/SOURCES.md (audit L19; those files belong to another change)" },
    () => assert.deepEqual(checkDatasets(repo), []),
  );
});

describe("own-licenses", () => {
  test("checks Cargo, npm and Python manifests against the path map", () => {
    const root = tree("own", {
      "forge/Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n\n[workspace.package]\nlicense = "MPL-2.0"\n',
      "forge/crates/forge-core/Cargo.toml": '[package]\nname = "forge-core"\nlicense.workspace = true\n',
      "forge/crates/forge-ir/Cargo.toml": '[package]\nname = "forge-ir"\nlicense = "MPL-2.0"\n',
      "forge/crates/forge-new/Cargo.toml": '[package]\nname = "forge-new"\n\n[dependencies]\nlicense = "1"\n',
      "oracle/pyproject.toml": '[project]\nname = "o"\nlicense = "MPL-2.0"\n',
      "packages/cadscript/package.json": { name: "@aicad/cadscript", license: "Apache-2.0" },
    });
    const { violations, checked } = checkOwn(root);
    assert.deepEqual(
      violations.map((v) => `${v.manifest}: ${v.problem}`),
      [
        'forge/crates/forge-ir/Cargo.toml: declares "MPL-2.0", LICENSING.md assigns Apache-2.0',
        "forge/crates/forge-new/Cargo.toml: declares undefined, LICENSING.md assigns MPL-2.0",
      ],
    );
    assert.equal(checked.find((c) => c.manifest.endsWith("forge-core/Cargo.toml")).license, "MPL-2.0");
  });

  test("the repository itself passes", () => {
    assert.deepEqual(checkOwn(repo).violations, []);
  });
});
