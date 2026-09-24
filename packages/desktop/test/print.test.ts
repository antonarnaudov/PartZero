/**
 * "Open in Bambu Studio" (ALPHA-0-PLAN W5): the built-in P2S and PLA profiles, the profile
 * library file, Bambu Studio detection, the launcher (with a fake `open`), and the whole handoff
 * through the real `aicad` binary when it is built.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findRepoRoot, locateForgeBinary } from "../src/forge-cli.js";
import { exportForPrinter, openPrintInSlicer, printFileStem, reportChecks, type PrintHandoffDeps } from "../src/print-handoff.js";
import {
  agentConventionsLine,
  BUILTIN_P2S,
  BUILTIN_PLA,
  checkSlicerPath,
  profileSummary,
  profileView,
  ProfileStore,
  writeFileAtomic,
} from "../src/profiles.js";
import { BAMBU_STUDIO, defaultSlicerSystem, detectSlicer, execFileCapped, isInside, openInSlicer, plistStrings, type SlicerSystem } from "../src/slicer.js";
import { tempDirs } from "./temp-dirs.js";

const tmp = tempDirs("aicad-print-test-");
const posix = process.platform !== "win32";

/** A fake `.app` bundle with an XML Info.plist. */
function fakeApp(dir: string, name = "BambuStudio.app", bundleId: string = BAMBU_STUDIO.bundleId, version = "02.06.00.51"): string {
  const app = join(dir, name);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleIdentifier</key>\n  <string>${bundleId}</string>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`,
  );
  return app;
}

/** A fake `open` that records its arguments (one per line) and exits with `code`. */
function fakeOpen(dir: string, code = 0, stderr = ""): { bin: string; args: () => string[] | null } {
  const log = join(dir, "open-args.txt");
  const bin = join(dir, "fake-open");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\n${stderr ? `echo "${stderr}" >&2\n` : ""}exit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, args: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : null) };
}

function system(o: Partial<SlicerSystem> & { searchDirs: string[] }): SlicerSystem {
  return { ...defaultSlicerSystem({ searchDirs: o.searchDirs }), platform: "darwin", useLaunchServices: false, ...o };
}

describe("built-in profiles", () => {
  it("describe the P2S from its public spec sheet and mark what is not checked on the machine", () => {
    expect(BUILTIN_P2S.id).toBe("builtin:bambu-p2s-0.4");
    expect(BUILTIN_P2S.bed).toEqual({ x: 256, y: 256, z: 256 });
    expect(BUILTIN_P2S.nozzle).toBe(0.4);
    expect(BUILTIN_P2S.bedMargin).toBe(10);
    expect(BUILTIN_P2S.printTessellation).toEqual({ deflection: 0.01, angular: 0.1 });
    expect(BUILTIN_P2S.unverified).toEqual(expect.arrayContaining(["bed", "nozzle", "exclusionZones"]));
    expect(BUILTIN_P2S.exclusionZones).toEqual([]);
  });

  it("give PLA the plan's default clearances, press on metal equal to press until the Fit Lab", () => {
    expect(BUILTIN_PLA.clearances).toEqual({ press: 0.05, slip: 0.2, running: 0.3, pressMetal: 0.05 });
    expect(BUILTIN_PLA.clearanceSource).toBe("default");
    expect(BUILTIN_PLA.minWall).toBe(0.8);
    expect(BUILTIN_PLA.maxOverhangDeg).toBe(45);
    expect(BUILTIN_PLA.unverified).toEqual(expect.arrayContaining(["clearances", "minWall", "maxOverhangDeg"]));
  });

  it("summarise for the welcome card and the agent", () => {
    expect(profileSummary(BUILTIN_P2S, BUILTIN_PLA)).toBe("Bambu Lab P2S · 0.4 mm · PLA");
    const line = agentConventionsLine(BUILTIN_P2S, BUILTIN_PLA);
    expect(line).toContain("every part must fit 236 × 236 mm in X and Y and 256 mm in Z");
    expect(line).toContain("press 0.05, slip 0.2, running 0.3, press on metal 0.05 mm");
    expect(line).toContain("walls at least 0.8 mm");
    expect(line).toContain("45° from vertical");
    const view = profileView(BUILTIN_P2S, BUILTIN_PLA, "/Users/me/PartZero/Prints");
    expect(view).toMatchObject({ summary: "Bambu Lab P2S · 0.4 mm · PLA", printsDir: "/Users/me/PartZero/Prints", printer: { bed: { x: 256 } }, material: { name: "PLA" } });
  });
});

describe("profile library file", () => {
  it("starts from the defaults and writes changes atomically, bumping the revision", () => {
    const dir = tmp();
    const file = join(dir, "machine-profiles.json");
    const store = new ProfileStore(file);
    expect(store.read()).toMatchObject({ revision: 0, printer: BUILTIN_P2S.id, material: BUILTIN_PLA.id, slicerPath: null });
    expect(existsSync(file)).toBe(false);
    store.update({ slicerPath: "/Volumes/Apps/BambuStudio.app/" });
    const again = new ProfileStore(file).read();
    expect(again).toMatchObject({ schema: "partzero.machine-profiles/1", revision: 1, slicerPath: "/Volumes/Apps/BambuStudio.app" });
    store.update({ slicerPath: null });
    expect(store.read()).toMatchObject({ revision: 2, slicerPath: null });
    expect(readdirSync(dir)).toEqual(["machine-profiles.json"]); // no temp files left
  });

  it("refuses slicer paths that are not an absolute .app", () => {
    for (const bad of ["BambuStudio.app", "/Applications/Calculator", "", "/x/\u0000.app", 42]) expect(() => checkSlicerPath(bad), String(bad)).toThrow();
    expect(checkSlicerPath(null)).toBeNull();
    expect(() => new ProfileStore(join(tmp(), "p.json")).update({ slicerPath: "relative.app" })).toThrow(/absolute/);
  });

  it("falls back to the defaults for a corrupt file or unknown ids", () => {
    const dir = tmp();
    const file = join(dir, "machine-profiles.json");
    const warnings: string[] = [];
    writeFileSync(file, "{ not json");
    expect(new ProfileStore(file, (m) => warnings.push(m)).read().printer).toBe(BUILTIN_P2S.id);
    expect(warnings[0]).toMatch(/not valid JSON/);
    writeFileSync(file, JSON.stringify({ printer: "someone-else", material: "unobtainium", revision: -3, slicerPath: "rel.app" }));
    const store = new ProfileStore(file);
    expect(store.read()).toMatchObject({ printer: BUILTIN_P2S.id, material: BUILTIN_PLA.id, revision: 0, slicerPath: null });
    expect(store.printer()).toBe(BUILTIN_P2S);
    expect(store.material()).toBe(BUILTIN_PLA);
  });

  it("replaces a file whole or not at all", () => {
    const dir = tmp();
    const file = join(dir, "a.json");
    writeFileAtomic(file, "one");
    writeFileAtomic(file, new Uint8Array([116, 119, 111]));
    expect(readFileSync(file, "utf8")).toBe("two");
    // A target that cannot be replaced (a directory) leaves no temp file behind.
    const target = join(dir, "is-a-dir");
    mkdirSync(join(target, "child"), { recursive: true });
    expect(() => writeFileAtomic(target, "x")).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["a.json", "is-a-dir"]);
  });
});

describe("Bambu Studio detection", () => {
  it("reads string keys from an XML Info.plist", () => {
    expect(plistStrings("<dict><key>CFBundleIdentifier</key>\n <string>com.a &amp; b</string><key>X</key><string></string></dict>")).toEqual({ CFBundleIdentifier: "com.a & b", X: "" });
  });

  it("finds it in /Applications first, then ~/Applications, with its version", async () => {
    const root = tmp();
    const apps = join(root, "Applications");
    const userApps = join(root, "UserApplications");
    fakeApp(userApps, "BambuStudio.app", BAMBU_STUDIO.bundleId, "02.05.00.00");
    let s = await detectSlicer(system({ searchDirs: [apps, userApps] }), null);
    expect(s).toMatchObject({ found: true, source: "user-applications", version: "02.05.00.00", path: join(userApps, "BambuStudio.app") });
    fakeApp(apps);
    s = await detectSlicer(system({ searchDirs: [apps, userApps] }), null);
    expect(s).toMatchObject({ found: true, source: "applications", version: "02.06.00.51", path: join(apps, "BambuStudio.app"), customPath: null });
  });

  it("skips an app with another bundle id and asks LaunchServices", async () => {
    const root = tmp();
    const apps = join(root, "Applications");
    fakeApp(apps, "BambuStudio.app", "com.example.impostor");
    const elsewhere = fakeApp(join(root, "Tools"));
    const calls: string[][] = [];
    const s = await detectSlicer(
      system({
        searchDirs: [apps],
        useLaunchServices: true,
        exec: (file, args) => {
          calls.push([file, ...args]);
          return Promise.resolve({ code: 0, stdout: `${join(root, "nope.app")}\n${elsewhere}\n`, stderr: "" });
        },
      }),
      null,
    );
    expect(calls).toEqual([["/usr/bin/mdfind", "kMDItemCFBundleIdentifier == 'com.bambulab.bambu-studio'"]]);
    expect(s).toMatchObject({ found: true, source: "launch-services", path: elsewhere });
  });

  it("uses only the path set in Settings, and says so when it is wrong", async () => {
    const root = tmp();
    const apps = join(root, "Applications");
    fakeApp(apps);
    const custom = fakeApp(join(root, "Custom"));
    const sys = system({ searchDirs: [apps] });
    expect(await detectSlicer(sys, custom)).toMatchObject({ found: true, source: "settings", path: custom, customPath: custom });
    // A missing path is "not found" even though /Applications has one (G2a a8).
    const missing = join(root, "Gone", "BambuStudio.app");
    const s = await detectSlicer(sys, missing);
    expect(s).toMatchObject({ found: false, path: missing, customPath: missing });
    expect(s.reason).toContain(missing);
    expect(s.fix).toMatch(/Settings/);
    // Another app is refused: a path set from the renderer can never launch something else.
    const other = fakeApp(join(root, "Other"), "Calculator.app", "com.apple.calculator");
    expect(await detectSlicer(sys, other)).toMatchObject({ found: false });
  });

  it("reports not found with a fix, and not supported off macOS", async () => {
    const s = await detectSlicer(system({ searchDirs: [join(tmp(), "empty")] }), null);
    expect(s).toMatchObject({ found: false, name: "Bambu Studio", bundleId: "com.bambulab.bambu-studio", path: null });
    expect(s.reason).toMatch(/isn't installed/);
    expect(s.fix).toMatch(/bambulab\.com/);
    const linux = await detectSlicer(system({ searchDirs: [], platform: "linux" }), null);
    expect(linux.found).toBe(false);
    expect(linux.reason).toMatch(/macOS only/);
  });

  it.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/plutil"))("converts a binary Info.plist with plutil", async () => {
    const app = fakeApp(tmp());
    const plist = join(app, "Contents", "Info.plist");
    const r = await execFileCapped("/usr/bin/plutil", ["-convert", "binary1", plist], 5000);
    expect(r.code).toBe(0);
    expect(readFileSync(plist).subarray(0, 6).toString()).toBe("bplist");
    expect(await detectSlicer(system({ searchDirs: [] }), app)).toMatchObject({ found: true, version: "02.06.00.51" });
  });
});

describe.skipIf(!posix)("launching Bambu Studio", () => {
  it("runs open -a <app> <file> for a 3MF in the prints folder", async () => {
    const root = tmp();
    const prints = join(root, "Prints");
    mkdirSync(prints);
    const file = join(prints, "knob-1a2b3c4d.3mf");
    writeFileSync(file, "PK");
    const app = fakeApp(root);
    const open = fakeOpen(root);
    const sys = system({ searchDirs: [root], openBin: open.bin, exec: execFileCapped });
    const slicer = await detectSlicer(sys, null);
    expect(await openInSlicer(sys, slicer, file, prints)).toEqual({ ok: true });
    expect(open.args()).toEqual(["-a", app, file]);
  });

  it("reports a failed launch with the reason", async () => {
    const root = tmp();
    const prints = join(root, "Prints");
    mkdirSync(prints);
    const file = join(prints, "a.3mf");
    writeFileSync(file, "PK");
    fakeApp(root);
    const open = fakeOpen(root, 1, "LSOpenURLsWithRole() failed with error -10810");
    const sys = system({ searchDirs: [root], openBin: open.bin, exec: execFileCapped });
    const r = await openInSlicer(sys, await detectSlicer(sys, null), file, prints);
    expect(r).toMatchObject({ ok: false, code: "SLICER_LAUNCH_FAILED" });
    expect(!r.ok && r.message).toContain("-10810");
  });

  it("opens nothing outside the prints folder, nothing but a 3MF, and nothing without a slicer", async () => {
    const root = tmp();
    const prints = join(root, "Prints");
    mkdirSync(prints);
    fakeApp(root);
    const open = fakeOpen(root);
    const sys = system({ searchDirs: [root], openBin: open.bin, exec: execFileCapped });
    const slicer = await detectSlicer(sys, null);
    const outside = join(root, "outside.3mf");
    writeFileSync(outside, "PK");
    const notMesh = join(prints, "notes.txt");
    writeFileSync(notMesh, "x");
    const sneaky = join(prints, "sneaky.3mf");
    symlinkSync(outside, sneaky);
    for (const f of [outside, notMesh, sneaky, join(prints, "missing.3mf"), join(prints, "..", "outside.3mf")]) {
      expect(await openInSlicer(sys, slicer, f, prints), f).toMatchObject({ ok: false, code: "PRINT_PATH_NOT_ALLOWED" });
    }
    const none = await detectSlicer(system({ searchDirs: [] }), null);
    expect(await openInSlicer(sys, none, outside, prints)).toMatchObject({ ok: false, code: "SLICER_NOT_FOUND" });
    expect(open.args()).toBeNull(); // never launched
    expect(isInside(prints, prints)).toBe(false);
  });

  it("times out a launcher that hangs", async () => {
    const dir = tmp();
    const hang = join(dir, "hang");
    writeFileSync(hang, "#!/bin/sh\nsleep 5\n");
    chmodSync(hang, 0o755);
    const r = await execFileCapped(hang, [], 200);
    expect(r.code).toBeNull();
    expect(r.error).toMatch(/timed out after 200 ms/);
  });
});

describe("print file names and Forge reports", () => {
  it("makes safe, short, non-empty file stems", () => {
    expect(printFileStem("knob")).toBe("knob");
    expect(printFileStem("T1 NEMA17 plate")).toBe("t1-nema17-plate");
    expect(printFileStem("../../etc/passwd")).toBe("etc-passwd");
    expect(printFileStem("Crème brûlée")).toBe("creme-brulee");
    expect(printFileStem("   ")).toBe("part");
    expect(printFileStem("x".repeat(100))).toHaveLength(48);
  });

  it("reads status and body validity from v0 and v1 reports", () => {
    expect(reportChecks(JSON.stringify({ schema: "aicad.metrics/0", status: "ok", features: [{ bodies: [{ valid: true }] }, { bodies: [] }] }))).toEqual({
      status: "ok",
      bodies: [{ valid: true }],
      firstError: null,
    });
    const v1 = reportChecks(JSON.stringify({ schema: "aicad.metrics/1", status: "error", features: [{ error: { code: "FILLET_TOO_LARGE", message: "radius 5 > 2" } }], parts: [{ bodies: [{ valid: false }] }] }));
    expect(v1).toEqual({ status: "error", bodies: [{ valid: false }], firstError: "FILLET_TOO_LARGE: radius 5 > 2" });
    expect(reportChecks("not json")).toBeNull();
    expect(reportChecks(null)).toBeNull();
  });
});

// ─── The whole handoff through the real `aicad` ─────────────────────────────────────────────

const repo = findRepoRoot(fileURLToPath(new URL(".", import.meta.url)));
const bin = locateForgeBinary({ env: {}, isPackaged: false, resourcesPath: "", appPath: fileURLToPath(new URL("..", import.meta.url)) });
const corpus = (name: string): string => readFileSync(join(repo ?? "", "corpus", "programs", `${name}.json`), "utf8");
const haveForge = !!repo && existsSync(bin) && existsSync(join(repo, "corpus", "programs", "extrude_two_regions.json"));

function handoff(root: string, o: { slicerDirs?: string[]; openBin?: string; forgeBin?: string } = {}): PrintHandoffDeps {
  return {
    forgeBin: o.forgeBin ?? bin,
    printsDir: join(root, "PartZero", "Prints"),
    appVersion: "0.0.1",
    profiles: new ProfileStore(join(root, "machine-profiles.json")),
    slicer: system({ searchDirs: o.slicerDirs ?? [], exec: execFileCapped, ...(o.openBin ? { openBin: o.openBin } : {}) }),
    now: () => new Date("2026-09-25T12:00:00Z"),
  };
}

describe.skipIf(!haveForge || !posix)("the handoff with the real aicad", () => {
  it("checks, exports centred on the P2S, writes the receipt and opens the file", async () => {
    const root = tmp();
    const app = fakeApp(join(root, "Applications"));
    const open = fakeOpen(root);
    const deps = handoff(root, { slicerDirs: [join(root, "Applications")], openBin: open.bin });
    const r = await openPrintInSlicer(deps, { irJson: corpus("extrude_two_regions"), docName: "Two Pucks" });
    expect(r.status).toBe("opened");
    if (r.status !== "opened") return;
    const bytes = readFileSync(r.file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(r.file).toBe(join(deps.printsDir, `two-pucks-${sha.slice(0, 8)}.3mf`));
    expect(r.receipt).toBe(join(deps.printsDir, `two-pucks-${sha.slice(0, 8)}.receipt.json`));
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(r).toMatchObject({ bodies: 2, bytes: bytes.length, slicer: { found: true, path: app } });
    expect(open.args()).toEqual(["-a", app, r.file]);
    const receipt = JSON.parse(readFileSync(r.receipt, "utf8"));
    expect(receipt).toMatchObject({
      schema: "partzero.receipt/1",
      file: `two-pucks-${sha.slice(0, 8)}.3mf`,
      sha256: sha,
      bytes: bytes.length,
      createdAt: "2026-09-25T12:00:00.000Z",
      app: { name: "PartZero", version: "0.0.1" },
      forge: { engine: expect.stringMatching(/^forge /) },
      document: { name: "Two Pucks" },
      printer: { id: "builtin:bambu-p2s-0.4", bed: { x: 256, y: 256, z: 256 }, bedMargin: 10, unverified: expect.arrayContaining(["bed"]) },
      material: { id: "builtin:pla", clearances: { press: 0.05, slip: 0.2, running: 0.3, pressMetal: 0.05 }, clearanceSource: "default" },
      checks: { report: "ok", valid: true, watertight: true, bodies: 2, bedFit: { ok: true, usable: [236, 236, 256] } },
      tessellation: { deflection: 0.01, angular: 0.1 },
    });
    // Centred on (128, 128) with z-min = 0.
    const onBed = receipt.bbox.onBed as { min: number[]; max: number[] };
    expect((onBed.min[0]! + onBed.max[0]!) / 2).toBeCloseTo(128, 9);
    expect((onBed.min[1]! + onBed.max[1]!) / 2).toBeCloseTo(128, 9);
    expect(onBed.min[2]).toBe(0);
    // Only what PartZero checked: no slicer output (ADR 0016 §2).
    expect(Object.keys(receipt).sort()).toEqual(
      ["app", "bbox", "bytes", "checks", "createdAt", "document", "file", "forge", "material", "note", "placement", "printer", "schema", "sha256", "tessellation"].sort(),
    );
    // The same design gets the same name (and bytes) again.
    const again = await exportForPrinter(deps, { irJson: corpus("extrude_two_regions"), docName: "Two Pucks" });
    expect("file" in again && again.file).toBe(r.file);
    expect(readdirSync(deps.printsDir).sort()).toEqual([`two-pucks-${sha.slice(0, 8)}.3mf`, `two-pucks-${sha.slice(0, 8)}.receipt.json`]);
  });

  it("still saves the file when Bambu Studio is missing, and says how to fix it", async () => {
    const root = tmp();
    const deps = handoff(root);
    const r = await openPrintInSlicer(deps, { irJson: corpus("extrude_box"), docName: "box" });
    expect(r.status).toBe("exported");
    if (r.status !== "exported") return;
    expect(existsSync(r.file)).toBe(true);
    expect(existsSync(r.receipt)).toBe(true);
    expect(r.message).toContain(deps.printsDir);
    expect(r.message).toMatch(/isn't installed/);
    expect(r.fix).toMatch(/Settings/);
  });

  it("keeps the export when the launch fails", async () => {
    const root = tmp();
    fakeApp(join(root, "Applications"));
    const open = fakeOpen(root, 1, "boom");
    const r = await openPrintInSlicer(handoff(root, { slicerDirs: [join(root, "Applications")], openBin: open.bin }), { irJson: corpus("extrude_box"), docName: "box" });
    expect(r).toMatchObject({ status: "exported", message: expect.stringContaining("boom") });
  });

  it("refuses a part larger than the bed with EXPORT_BED_FIT and writes nothing", async () => {
    const root = tmp();
    const big = JSON.parse(corpus("extrude_box")) as { parts: Array<{ features: Array<{ curves?: Array<{ start?: number[]; end?: number[] }> }> }> };
    // Scale the box's sketch by 10 (it becomes wider than 236 mm).
    for (const c of big.parts[0]!.features[0]!.curves ?? []) {
      if (c.start) c.start = c.start.map((v) => v * 10);
      if (c.end) c.end = c.end.map((v) => v * 10);
    }
    const deps = handoff(root);
    const r = await openPrintInSlicer(deps, { irJson: JSON.stringify(big), docName: "big" });
    expect(r).toMatchObject({ status: "refused", code: "EXPORT_BED_FIT" });
    if (r.status !== "refused") return;
    expect(r.message).toMatch(/doesn't fit the Bambu Lab P2S: the part is .* too large in X/);
    expect(r.details).toMatchObject({ usable: [236, 236, 256] });
    expect(existsSync(deps.printsDir)).toBe(false);
  });

  it("refuses a design Forge did not check as valid", async () => {
    const root = tmp();
    const openLoop = JSON.stringify({
      schema: "aicad.ir/0",
      parts: [
        {
          id: "p",
          name: "p",
          features: [
            { type: "sketch", id: "s", name: "s", plane: "XY", curves: [{ kind: "line", id: "a", start: [0, 0], end: [1, 0] }] },
            { type: "extrude", id: "e", name: "e", sketch: "s", distance: 1 },
          ],
        },
      ],
    });
    const deps = handoff(root);
    const r = await openPrintInSlicer(deps, { irJson: openLoop, docName: "broken" });
    expect(r).toMatchObject({ status: "refused", code: "EXPORT_NOT_VALID" });
    expect(existsSync(deps.printsDir)).toBe(false);
  });

  it("says so when the Forge CLI is missing", async () => {
    const r = await openPrintInSlicer(handoff(tmp(), { forgeBin: "/nonexistent/aicad" }), { irJson: corpus("extrude_box"), docName: "box" });
    expect(r).toMatchObject({ status: "refused", code: "FORGE_UNAVAILABLE" });
  });
});
