/**
 * The app icon: `build/icon.icns` (what electron-builder puts in PartZero.app), `build/icon.png` and
 * `build/icon.svg` are exactly what `scripts/make-icon.mjs` makes, every ICNS entry is a PNG of its
 * declared size, and the builder configs take the icon from `build/`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { applyDevDockIcon, devIconPath } from "../src/app-icon.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(root, "build");

interface IconModule {
  ICNS_TYPES: Array<[string, number]>;
  makeAll(): { icns: Buffer; png: Buffer; svg: Buffer };
}

function pngSize(png: Buffer): [number, number] {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

describe("the PartZero app icon", () => {
  it("is an ICNS of PNG entries, each the size its type declares", async () => {
    const { ICNS_TYPES } = (await import(pathToFileURL(join(root, "scripts/make-icon.mjs")).href)) as IconModule;
    const icns = readFileSync(join(build, "icon.icns"));
    expect(icns.subarray(0, 4).toString("latin1")).toBe("icns");
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    const seen: Array<[string, number]> = [];
    for (let off = 8; off < icns.length; ) {
      const type = icns.subarray(off, off + 4).toString("latin1");
      const len = icns.readUInt32BE(off + 4);
      const [w, h] = pngSize(icns.subarray(off + 8, off + len));
      expect(w).toBe(h);
      seen.push([type, w]);
      off += len;
    }
    expect(seen).toEqual(ICNS_TYPES);
    expect(pngSize(readFileSync(join(build, "icon.png")))).toEqual([1024, 1024]);
    expect(readFileSync(join(build, "icon.svg"), "utf8")).toContain("<title>PartZero</title>");
  });

  it("is exactly what scripts/make-icon.mjs makes (regenerate after changing the mark)", async () => {
    const mod = (await import(pathToFileURL(join(root, "scripts/make-icon.mjs")).href)) as IconModule;
    const made = mod.makeAll();
    expect(Buffer.compare(made.icns, readFileSync(join(build, "icon.icns")))).toBe(0);
    expect(Buffer.compare(made.png, readFileSync(join(build, "icon.png")))).toBe(0);
    expect(Buffer.compare(made.svg, readFileSync(join(build, "icon.svg")))).toBe(0);
  }, 120_000);

  it("is where electron-builder looks for it, in both configs", () => {
    const require = createRequire(import.meta.url);
    const base = require(join(root, "electron-builder.config.cjs")) as { directories: { buildResources: string }; mac: { icon?: string } };
    const alpha = require(join(root, "electron-builder.alpha-local.cjs")) as { directories: { buildResources: string }; mac: { icon?: string } };
    for (const c of [base, alpha]) {
      expect(c.directories.buildResources).toBe("build");
      // No override: electron-builder uses <buildResources>/icon.icns.
      expect(c.mac.icon).toBeUndefined();
    }
    expect(existsSync(join(root, base.directories.buildResources, "icon.icns"))).toBe(true);
  });

  it("is the Dock icon of unpackaged macOS runs only", () => {
    const set: string[] = [];
    const dock = { setIcon: (p: string) => void set.push(p) };
    expect(devIconPath(join(root, "dist"))).toBe(join(build, "icon.png"));
    expect(applyDevDockIcon({ isPackaged: false, dock }, join(root, "dist"), "darwin")).toBe(join(build, "icon.png"));
    expect(applyDevDockIcon({ isPackaged: true, dock }, join(root, "dist"), "darwin")).toBeNull();
    expect(applyDevDockIcon({ isPackaged: false, dock }, join(root, "dist"), "linux")).toBeNull();
    const empty = mkdtempSync(join(tmpdir(), "pz-icon-"));
    try {
      expect(applyDevDockIcon({ isPackaged: false, dock }, join(empty, "dist"), "darwin")).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(set).toEqual([join(build, "icon.png")]);
  });
});
