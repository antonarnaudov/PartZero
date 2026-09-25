/**
 * The packaging hook that runs the slicer licence gate over every packed app (ADR 0016 §3):
 * electron-builder's `afterPack` in `electron-builder.config.cjs`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDirs } from "./temp-dirs.js";

const require = createRequire(import.meta.url);
const tmp = tempDirs("aicad-slicer-gate-");
type Hook = (context: { appOutDir: string }) => Promise<void>;
const hook = require("../scripts/slicer-gate-after-pack.cjs") as Hook;

/** A packed app tree like electron-builder's `release/mac-arm64`. */
function packedApp(extra: Record<string, string> = {}): string {
  const out = tmp();
  const res = join(out, "aicad.app", "Contents", "Resources");
  mkdirSync(join(res, "bin"), { recursive: true });
  writeFileSync(join(res, "bin", "aicad"), "#!/bin/sh\n");
  writeFileSync(join(res, "app.asar"), "asar");
  for (const [rel, text] of Object.entries(extra)) {
    mkdirSync(join(out, rel, ".."), { recursive: true });
    writeFileSync(join(out, rel), text);
  }
  return out;
}

describe("the afterPack slicer gate", () => {
  it("is the packaging config's afterPack hook", () => {
    const config = require("../electron-builder.config.cjs") as { afterPack?: unknown };
    expect(config.afterPack).toBe(hook);
  });

  it("passes a packed app without a slicer", async () => {
    await expect(hook({ appOutDir: packedApp() })).resolves.toBeUndefined();
  });

  it("fails the build when a slicer, libslic3r or a slicer's profiles got in", async () => {
    const cases: Record<string, RegExp> = {
      "aicad.app/Contents/Resources/BambuStudio.app/Contents/MacOS/BambuStudio": /slicer application bundle/,
      "aicad.app/Contents/Resources/bin/libslic3r.dylib": /slic3r library/,
      "aicad.app/Contents/Resources/profiles/BBL/machine/Bambu Lab P2S 0.4 nozzle.json": /vendor profile library/,
    };
    for (const [rel, why] of Object.entries(cases)) {
      await expect(hook({ appOutDir: packedApp({ [rel]: "{}" }) }), rel).rejects.toThrow(why);
    }
  });
});
