// Self-tests of the slicer boundary gate (ADR 0016 §3): `node --test scripts/license-check/test/`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { check, scan } from "../slicer-boundary.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const tmp = mkdtempSync(join(tmpdir(), "slicer-boundary-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function tree(name, files) {
  const root = join(tmp, name);
  mkdirSync(root, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

const reasons = (root) => scan(root, { git: false }).map((v) => `${v.file}: ${v.reason}`);

describe("slicer boundary", () => {
  test("the repository has no slicer, slicer engine or slicer profile", () => {
    assert.deepEqual(check(repo), []);
  });

  test("prose, our own launcher and our own profiles are fine", () => {
    const root = tree("clean", {
      "docs/SLICER-HANDOFF.md": "We launch /Applications/BambuStudio.app with open -a; libslic3r is never linked.",
      "packages/desktop/src/slicer.ts": 'export const APP = "BambuStudio.app";',
      "packages/desktop/src/profiles.ts": "export const P2S = { bed: { x: 256 } };",
      "corpus/printer.json": { id: "builtin:bambu-p2s-0.4", bed: { x: 256, y: 256, z: 256 }, source: { kind: "builtin" } },
      "receipt.json": { schema: "partzero.receipt/1", note: "The slicer's own results are not part of this receipt." },
      "src/curate.ts": "export {};",
    });
    assert.deepEqual(reasons(root), []);
  });

  test("a bundled slicer app, executable or AppImage fails", () => {
    const root = tree("apps", {
      "release/BambuStudio.app/Contents/MacOS/BambuStudio": "\x7fELF",
      "release/BambuStudio.app/Contents/Info.plist": "<plist/>",
      "bin/orca-slicer": "#!/bin/sh",
      "bin/PrusaSlicer-2.9.0+linux-x64.AppImage": "x",
      "bin/bambu-studio.exe": "MZ",
    });
    assert.deepEqual(reasons(root), [
      "bin/PrusaSlicer-2.9.0+linux-x64.AppImage: a slicer executable (or a file named after one)",
      "bin/bambu-studio.exe: a slicer executable (or a file named after one)",
      "bin/orca-slicer: a slicer executable (or a file named after one)",
      "release/BambuStudio.app: a slicer application bundle",
    ]);
  });

  test("libslic3r sources, libraries and WASM builds fail", () => {
    const root = tree("engine", {
      "vendor/libslic3r/GCode.cpp": "// slicing",
      "lib/libslic3r.dylib": "x",
      "web/slic3r_bg.wasm": "x",
      "lib/libslic3r_cgal.a": "x",
    });
    assert.deepEqual(reasons(root), [
      "lib/libslic3r.dylib: a slic3r library or module",
      "lib/libslic3r_cgal.a: a slic3r library or module",
      "vendor/libslic3r/GCode.cpp: libslic3r source (a slicer engine)",
      "web/slic3r_bg.wasm: a slic3r library or module",
    ]);
  });

  test("a slicer's profile library or a copied system preset fails", () => {
    const root = tree("profiles", {
      "resources/profiles/BBL/machine/Some Printer.json": { name: "Some Printer" },
      "data/PrusaResearch.ini": "[vendor]",
      "copied/p2s-machine.json": { type: "machine", name: "Some Printer 0.4 nozzle", from: "system", inherits: "fdm_base", setting_id: "GM000" },
      "copied/not-a-preset.json": { from: "system", note: "a word, not a preset" },
    });
    assert.deepEqual(reasons(root), [
      "copied/p2s-machine.json: a slicer system preset (copied profile data)",
      "data/PrusaResearch.ini: a PrusaSlicer vendor profile bundle",
      "resources/profiles/BBL/machine/Some Printer.json: a slicer's vendor profile library",
    ]);
  });

  test("build trees are walked in full, node_modules included", () => {
    const repoLike = tree("repo-like", { "README.md": "PartZero" });
    const build = tree("build", { "node_modules/some-dep/bin/prusa-slicer": "x", "app-web/index.html": "<html>" });
    const found = check(repoLike, [build]);
    assert.equal(found.length, 1);
    assert.equal(found[0].tree, build);
    assert.equal(found[0].file, "node_modules/some-dep/bin/prusa-slicer");
  });
});
