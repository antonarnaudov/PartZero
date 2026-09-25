/**
 * "Open in Bambu Studio" (ALPHA-0-PLAN W5): the built-in P2S and PLA profiles, the profile
 * library file, Bambu Studio detection, the launcher (with a fake `open`), and the whole handoff
 * through the real `aicad` binary when it is built.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findRepoRoot, forgeFailure, forgePrintCapability, locateForgeBinary } from "../src/forge-cli.js";
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
import { BAMBU_STUDIO, defaultSlicerSystem, detectSlicer, execFileCapped, isInside, openInSlicer, plistStrings, slicerRunning, type SlicerSystem } from "../src/slicer.js";
import { tempDirs } from "./temp-dirs.js";

const tmp = tempDirs("aicad-print-test-");
const posix = process.platform !== "win32";

/** A fake `.app` bundle with an XML Info.plist. */
function fakeApp(dir: string, name = "BambuStudio.app", bundleId: string = BAMBU_STUDIO.bundleId, version = "02.06.00.51", executable = "BambuStudio"): string {
  const app = join(dir, name);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>CFBundleExecutable</key>\n  <string>${executable}</string>\n  <key>CFBundleIdentifier</key>\n  <string>${bundleId}</string>\n  <key>CFBundleShortVersionString</key>\n  <string>${version}</string>\n</dict>\n</plist>\n`,
  );
  return app;
}

/** A fake `pgrep` that records its arguments and exits with `code` (0: running, 1: not). */
function fakePgrep(dir: string, code: number): { bin: string; args: () => string[] | null } {
  const log = join(dir, "pgrep-args.txt");
  const bin = join(dir, "fake-pgrep");
  writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > "${log}"\nexit ${code}\n`);
  chmodSync(bin, 0o755);
  return { bin, args: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : null) };
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
    expect(BUILTIN_P2S.printTessellation).toEqual({ deflection: 0.01, angular: Math.PI / 36 });
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
    // A test system never asks about the user's real Bambu Studio: whether it runs is unknown.
    expect(sys.pgrepBin).toBeNull();
    expect(await openInSlicer(sys, slicer, file, prints)).toEqual({ ok: true, alreadyRunning: null });
    expect(open.args()).toEqual(["-a", app, file]);
  });

  it("says whether Bambu Studio was already running (it may then open a new window)", async () => {
    const root = tmp();
    const prints = join(root, "Prints");
    mkdirSync(prints);
    const file = join(prints, "knob-1a2b3c4d.3mf");
    writeFileSync(file, "PK");
    const app = fakeApp(root);
    const open = fakeOpen(root);
    for (const [code, want] of [
      [0, true],
      [1, false],
      [3, null],
    ] as const) {
      mkdirSync(join(root, `pgrep-${code}`), { recursive: true });
      const p = fakePgrep(join(root, `pgrep-${code}`), code);
      const sys = system({ searchDirs: [root], openBin: open.bin, pgrepBin: p.bin, exec: execFileCapped });
      const slicer = await detectSlicer(sys, null);
      expect(await openInSlicer(sys, slicer, file, prints), `pgrep exit ${code}`).toEqual({ ok: true, alreadyRunning: want });
      // Only this user's processes, matched by the bundle's executable name.
      expect(p.args()).toEqual(["-x", "-U", String(process.getuid!()), "BambuStudio"]);
    }
    expect(open.args()).toEqual(["-a", app, file]);
    // No executable name in the Info.plist, or no pgrep: unknown, and the launch goes ahead.
    const bare = fakeApp(join(root, "bare"), "BambuStudio.app", BAMBU_STUDIO.bundleId, "02.06.00.51", "");
    const p = fakePgrep(join(root, "bare"), 0);
    expect(await slicerRunning(system({ searchDirs: [], pgrepBin: p.bin, exec: execFileCapped }), bare)).toBeNull();
    expect(p.args()).toBeNull();
    expect(await slicerRunning(system({ searchDirs: [], pgrepBin: null }), app)).toBeNull();
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

/** A 30 × 20 × 5 mm plate with one 5 mm through hole (IR v1, a `hole` feature on the top cap). */
const HOLE_PLATE = JSON.stringify({
  schema: "aicad.ir/1",
  meta: { name: "hole", description: "" },
  params: [],
  parts: [
    {
      id: "p1",
      name: "plate",
      features: [
        { type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: 30, h: 20 }] },
        { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 5 },
        { type: "hole", id: "h1", name: "hole5", on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } }, at: { grid: { nx: 1, ny: 1, dx: 0, dy: 0 } }, d: 5, depth: "through" },
      ],
    },
  ],
});

/** The centre of the circle through points (x, y) (Kåsa's least-squares fit: exact for points on a circle). */
function circleCentre(ps: ReadonlyArray<readonly [number, number, number]>): [number, number] {
  // Minimise Σ (x² + y² + D x + E y + F)²: the normal equations, solved by Cramer's rule.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const [x, y] of ps) {
    const zz = x * x + y * y;
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; sxz += x * zz; syz += y * zz; sz += zz;
  }
  const n = ps.length;
  const m = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const b = [-sxz, -syz, -sz];
  const det = (a: number[][]): number =>
    a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const d = det(m);
  const col = (k: number): number[][] => m.map((row, i) => row.map((v, j) => (j === k ? b[i]! : v)));
  return [-det(col(0)) / d / 2, -det(col(1)) / d / 2];
}

/** The object vertices of a 3MF (its build transform aside), from the zip's central directory. */
function threeMfVertices(zip: Buffer): Array<[number, number, number]> {
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    if (!/3dmodel\.model$/i.test(name)) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const xml = (method === 8 ? inflateRawSync(raw) : raw).toString("utf8");
    return [...xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
  }
  throw new Error("no 3D model in the 3MF");
}

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
    expect(r).toMatchObject({ bodies: 2, bytes: bytes.length, slicer: { found: true, path: app }, alreadyRunning: null, warnings: [] });
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
      checks: { report: "ok", valid: true, watertight: true, bodies: 2, bedFit: { ok: true, usable: [236, 236, 256] }, layoutWarnings: [] },
      tessellation: { deflection: 0.01, angular: Math.PI / 36 },
      geometryHash: expect.stringMatching(/^fnv1a64:[0-9a-f]{16}$/),
    });
    // Centred on (128, 128) with z-min = 0.
    const onBed = receipt.bbox.onBed as { min: number[]; max: number[] };
    expect((onBed.min[0]! + onBed.max[0]!) / 2).toBeCloseTo(128, 9);
    expect((onBed.min[1]! + onBed.max[1]!) / 2).toBeCloseTo(128, 9);
    expect(onBed.min[2]).toBe(0);
    // Only what PartZero checked: no slicer output (ADR 0016 §2).
    expect(Object.keys(receipt).sort()).toEqual(
      ["app", "bbox", "bytes", "checks", "createdAt", "document", "file", "format", "forge", "geometryHash", "material", "note", "placement", "printer", "schema", "sha256", "tessellation"].sort(),
    );
    // The same design gets the same name (and bytes) again.
    const again = await exportForPrinter(deps, { irJson: corpus("extrude_two_regions"), docName: "Two Pucks" });
    expect("file" in again && again.file).toBe(r.file);
    expect(readdirSync(deps.printsDir).sort()).toEqual([`two-pucks-${sha.slice(0, 8)}.3mf`, `two-pucks-${sha.slice(0, 8)}.receipt.json`]);
    // Another app version changes the file (its Application metadata) but not the geometry hash.
    const upgraded = await exportForPrinter({ ...deps, appVersion: "0.0.2" }, { irJson: corpus("extrude_two_regions"), docName: "Two Pucks" });
    if (!("file" in upgraded)) throw new Error(upgraded.message);
    expect(upgraded.file).not.toBe(r.file);
    expect(JSON.parse(readFileSync(upgraded.receipt, "utf8")).geometryHash).toBe(receipt.geometryHash);
  });

  it("creates ~/PartZero/Prints on first export, and refuses a Prints folder that is a symlink (user-folders.ts)", async () => {
    const root = tmp();
    const deps = handoff(root);
    expect(existsSync(join(root, "PartZero"))).toBe(false);
    const first = await exportForPrinter(deps, { irJson: corpus("extrude_box"), docName: "box" });
    expect("file" in first).toBe(true);
    expect(readdirSync(deps.printsDir)).toHaveLength(2);
    // A Prints that points elsewhere is not written through.
    const other = tmp();
    const linked = { ...deps, printsDir: join(other, "PartZero", "Prints") };
    mkdirSync(join(other, "PartZero"));
    symlinkSync(root, linked.printsDir);
    const refused = await exportForPrinter(linked, { irJson: corpus("extrude_box"), docName: "box" });
    expect(refused).toMatchObject({ status: "refused", code: "EXPORT_FAILED", message: expect.stringContaining("is not a folder") });
  });

  it("hands over a 5 mm hole with at least 72 segments (the P2S print tessellation, 0.01 mm and 5°)", async () => {
    const root = tmp();
    const deps = handoff(root);
    const r = await exportForPrinter(deps, { irJson: HOLE_PLATE, docName: "hole" });
    if (!("file" in r)) throw new Error(r.message);
    expect(r.format).toBe("3mf");
    const points = threeMfVertices(readFileSync(r.file));
    // The top cap's own vertices, away from the plate's outline, are the rim of the hole.
    for (const z of [0, 5]) {
      const rim = points.filter((p) => Math.abs(p[2] - z) < 1e-6 && Math.abs(p[0]) < 14.9 && Math.abs(p[1]) < 9.9);
      const [cx, cy] = circleCentre(rim);
      const angles = [...new Set(rim.map((p) => Math.round(((Math.atan2(p[1] - cy, p[0] - cx) + 2 * Math.PI) % (2 * Math.PI)) * 1e4)))].sort((a, b) => a - b);
      expect(angles.length, `rim at z = ${z}`).toBeGreaterThanOrEqual(72);
      for (const p of rim) expect(Math.hypot(p[0] - cx, p[1] - cy)).toBeCloseTo(2.5, 4);
      let widest = 0;
      for (let i = 0; i < angles.length; i++) widest = Math.max(widest, ((i + 1 < angles.length ? angles[i + 1]! : angles[0]! + 2 * Math.PI * 1e4) - angles[i]!) / 1e4);
      expect(widest).toBeLessThanOrEqual((5 * Math.PI) / 180 + 1e-3);
    }
    expect(JSON.parse(readFileSync(r.receipt, "utf8"))).toMatchObject({ format: "3mf", tessellation: { deflection: 0.01, angular: Math.PI / 36 } });
  });

  it("offers STEP instead: the same checks, then the exact B-rep as <doc>-<hash8>.step, opened in Bambu Studio", async () => {
    const root = tmp();
    const app = fakeApp(join(root, "Applications"));
    const open = fakeOpen(root);
    const deps = handoff(root, { slicerDirs: [join(root, "Applications")], openBin: open.bin });
    const r = await openPrintInSlicer(deps, { irJson: HOLE_PLATE, docName: "Hole Plate", format: "step" });
    expect(r.status).toBe("opened");
    if (r.status !== "opened") return;
    const bytes = readFileSync(r.file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(r.file).toBe(join(deps.printsDir, `hole-plate-${sha.slice(0, 8)}.step`));
    expect(r).toMatchObject({ format: "step", bodies: 1, bytes: bytes.length, warnings: [] });
    expect(bytes.subarray(0, 13).toString()).toBe("ISO-10303-21;");
    const text = bytes.toString("utf8");
    expect(text).toMatch(/AUTOMOTIVE_DESIGN/);
    expect(text).toMatch(/CYLINDRICAL_SURFACE\([^)]*2\.5/);
    expect(open.args()).toEqual(["-a", app, r.file]);
    const receipt = JSON.parse(readFileSync(r.receipt, "utf8"));
    expect(receipt).toMatchObject({
      schema: "partzero.receipt/1",
      format: "step",
      file: `hole-plate-${sha.slice(0, 8)}.step`,
      sha256: sha,
      bytes: bytes.length,
      checks: { report: "ok", valid: true, watertight: true, bodies: 1, bedFit: { ok: true } },
      tessellation: null,
      placement: { translation: null },
      bbox: { onBed: null },
    });
    expect(receipt.note).toMatch(/Bambu Studio tessellates it/);
    // The checks still refuse what would not print: too big for the bed is refused before any STEP is saved.
    const big = JSON.parse(HOLE_PLATE) as { parts: Array<{ features: Array<{ curves?: Array<{ w?: number; h?: number }> }> }> };
    big.parts[0]!.features[0]!.curves![0]!.w = 400;
    const refused = await openPrintInSlicer(handoff(tmp()), { irJson: JSON.stringify(big), docName: "big", format: "step" });
    expect(refused).toMatchObject({ status: "refused", code: "EXPORT_BED_FIT" });
    await expect(exportForPrinter(deps, { irJson: HOLE_PLATE, docName: "x", format: "obj" as never })).rejects.toThrow(/invalid slicer format/);
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

  it("refuses bodies stacked above each other and writes nothing", async () => {
    const root = tmp();
    const deps = handoff(root);
    const r = await openPrintInSlicer(deps, { irJson: bars([-10, 10, 0, 5], [-10, 10, 10, 15]), docName: "box and lid" });
    expect(r).toMatchObject({ status: "refused", code: "EXPORT_BODIES_OVERLAP" });
    if (r.status !== "refused") return;
    expect(r.message).toMatch(/stacked.*print inside each other.*side by side/);
    expect(existsSync(deps.printsDir)).toBe(false);
  });

  it("saves a floating body with a warning in the result and the receipt", async () => {
    const root = tmp();
    fakeApp(join(root, "Applications"));
    const open = fakeOpen(root);
    const deps = handoff(root, { slicerDirs: [join(root, "Applications")], openBin: open.bin });
    const r = await openPrintInSlicer(deps, { irJson: bars([-30, -10, 0, 5], [10, 30, 10, 15]), docName: "two bars" });
    expect(r.status).toBe("opened");
    if (r.status !== "opened") return;
    expect(r.warnings).toEqual([expect.objectContaining({ code: "EXPORT_BODY_FLOATING", message: expect.stringMatching(/starts 10 mm above the bed/) })]);
    const receipt = JSON.parse(readFileSync(r.receipt, "utf8"));
    expect(receipt.checks.layoutWarnings).toEqual(r.warnings);
  });
});

/** Two bars on the XZ plane, `[x0, x1, z0, z1]` each, extruded 10 mm symmetrically along Y. */
function bars(a: number[], b: number[]): string {
  const rect = (id: string, [x0, x1, z0, z1]: number[]) => [
    { kind: "line", id: `${id}1`, start: [x0, z0], end: [x1, z0] },
    { kind: "line", id: `${id}2`, start: [x1, z0], end: [x1, z1] },
    { kind: "line", id: `${id}3`, start: [x1, z1], end: [x0, z1] },
    { kind: "line", id: `${id}4`, start: [x0, z1], end: [x0, z0] },
  ];
  return JSON.stringify({
    schema: "aicad.ir/0",
    parts: [
      {
        id: "p",
        name: "p",
        features: [
          { type: "sketch", id: "s", name: "bars", plane: "XZ", curves: [...rect("a", a!), ...rect("b", b!)] },
          { type: "extrude", id: "e", name: "stack", sketch: "bars", distance: 10, direction: "symmetric" },
        ],
      },
    ],
  });
}

// ─── Forge's answers the handoff must not take on trust ─────────────────────────────────────

describe("Forge CLI failures", () => {
  it("names an aicad older than the app, with the rebuild command", () => {
    // What the pre-W5 aicad prints for `export --bed=…` (clap), last line included.
    const stderr = "error: unexpected argument '--bed' found\n\n  tip: to pass '--bed' as a value, use '-- --bed'\n\nUsage: aicad export [OPTIONS] --out <OUT> <FILE>\n\nFor more information, try '--help'.\n";
    const f = forgeFailure({ exitCode: 2, stderr }, "/repo/forge/target/release/aicad");
    expect(f.code).toBe("FORGE_OUTDATED");
    expect(f.message).toContain("/repo/forge/target/release/aicad is older than this app");
    expect(f.message).toContain("--bed");
    expect(f.message).toContain("cargo build -p forge-cli");
    expect(f.message).not.toContain("For more information");
  });

  it("shows the first error line, not the last line of stderr", () => {
    expect(forgeFailure({ exitCode: 3, stderr: "aicad: cannot write /x/print.3mf: disk full\nsome trailing note\n" }, "aicad")).toEqual({
      code: "EXPORT_FAILED",
      message: "aicad: cannot write /x/print.3mf: disk full",
    });
    expect(forgeFailure({ exitCode: 1, stderr: "just one line" }, "aicad").message).toBe("just one line");
    expect(forgeFailure({ exitCode: 9, stderr: "" }, "aicad").message).toBe("exit code 9");
    expect(forgeFailure({ exitCode: null, stderr: "x", error: "aicad timed out after 5 ms" }, "aicad").message).toBe("aicad timed out after 5 ms");
  });
});

/**
 * A fake `aicad`: `eval` prints `report`, `export` writes a stub 3MF and `summary` (or none), or
 * behaves like an aicad that predates `--bed`.
 */
function fakeAicad(dir: string, o: { report: unknown; summary?: unknown; old?: boolean }): string {
  mkdirSync(dir, { recursive: true });
  const report = join(dir, "report.json");
  const summary = join(dir, "summary.json");
  writeFileSync(report, JSON.stringify(o.report));
  if (o.summary !== undefined) writeFileSync(summary, JSON.stringify(o.summary));
  const bin = join(dir, "aicad");
  const exportPart = o.old
    ? `printf "error: unexpected argument '--bed' found\\n\\nFor more information, try '--help'.\\n" >&2; exit 2`
    : `out=""; sum=""
while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2;; --summary=*) sum="\${1#--summary=}"; shift;; *) shift;; esac; done
printf 'PK stub' > "$out"
${o.summary !== undefined ? `cp "${summary}" "$sum"` : ":"}
exit 0`;
  writeFileSync(
    bin,
    `#!/bin/sh
cmd="$1"; shift
if [ "$cmd" = eval ]; then cat "${report}"; exit 0; fi
if [ "$cmd" = export ] && [ "$1" = --help ]; then printf '%s\\n' ${o.old ? "'  --out <OUT>'" : "'  --out <OUT>' '  --bed <X,Y,Z>' '  --bed-margin <MM>' '  --bed-exclude <X0,Y0,X1,Y1>' '  --title <TITLE>' '  --application <APP>' '  --summary <PATH>'"}; exit 0; fi
${exportPart}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const OK_REPORT = { schema: "aicad.metrics/0", status: "ok", features: [{ bodies: [{ valid: true }] }] };
const GOOD_SUMMARY = {
  schema: "aicad.export/1",
  status: "ok",
  bodies: [{ name: "p/e", watertight: true }],
  watertight: true,
  placement: { translation: [128, 128, 0], bbox: { min: [118, 118, 0], max: [138, 138, 5] } },
  geometryHash: "fnv1a64:0123456789abcdef",
  warnings: [],
};

describe.skipIf(!posix)("the handoff checks Forge's export summary", () => {
  const run = (o: { report?: unknown; summary?: unknown; old?: boolean }) => {
    const root = tmp();
    const deps = handoff(root, { forgeBin: fakeAicad(join(root, "bin"), { report: OK_REPORT, ...o }) });
    return { deps, result: openPrintInSlicer(deps, { irJson: "{}", docName: "part" }) };
  };

  it("saves what the summary confirms", async () => {
    const { deps, result } = run({ summary: GOOD_SUMMARY });
    const r = await result;
    expect(r).toMatchObject({ status: "exported", bodies: 1, warnings: [] });
    expect(existsSync(deps.printsDir)).toBe(true);
  });

  it("refuses an aicad that predates the print export, and says how to rebuild it", async () => {
    const { deps, result } = run({ old: true });
    const r = await result;
    expect(r).toMatchObject({ status: "refused", code: "FORGE_OUTDATED" });
    expect(r.status === "refused" && r.message).toMatch(/older than this app: it does not know --bed\. Rebuild it with `cargo build -p forge-cli`/);
    expect(existsSync(deps.printsDir)).toBe(false);
    expect(await forgePrintCapability(deps.forgeBin)).toMatchObject({ ok: false, missing: ["--bed", "--bed-margin", "--bed-exclude", "--title", "--application", "--summary"] });
  });

  it("refuses when the summary is missing, disagrees on the body count, or has no placement", async () => {
    for (const [summary, why] of [
      [undefined, /no readable export summary/],
      [{ ...GOOD_SUMMARY, bodies: [...GOOD_SUMMARY.bodies, { name: "p/e#1", watertight: true }] }, /checked 1 body but exported 2/],
      [{ ...GOOD_SUMMARY, placement: null }, /did not record where it placed/],
    ] as const) {
      const { deps, result } = run({ summary });
      const r = await result;
      expect(r, String(why)).toMatchObject({ status: "refused", code: "EXPORT_FAILED" });
      expect(r.status === "refused" && r.message).toMatch(why);
      expect(existsSync(deps.printsDir)).toBe(false);
    }
  });

  it("refuses a mesh that is not watertight, naming the body", async () => {
    const { deps, result } = run({ summary: { ...GOOD_SUMMARY, watertight: false, bodies: [{ name: "p/e", watertight: false }] } });
    const r = await result;
    expect(r).toMatchObject({ status: "refused", code: "EXPORT_NOT_WATERTIGHT", details: { bodies: ["p/e"] } });
    expect(r.status === "refused" && r.message).toContain('"p/e" is not watertight');
    expect(existsSync(deps.printsDir)).toBe(false);
  });
});

describe.skipIf(!haveForge)("the real aicad", () => {
  it("has every flag the print export needs", async () => {
    expect(await forgePrintCapability(bin)).toMatchObject({ ok: true, missing: [] });
  });
});
