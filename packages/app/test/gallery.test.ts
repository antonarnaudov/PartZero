/// <reference types="node" />
/**
 * The ready-made starter examples (`corpus/gallery/*.cad.ts`) build with Forge, as one valid body
 * per printed part, match their closed-form volumes and sizes, and fit the Bambu Lab P2S bed with
 * 10 mm kept free. Needs the Forge CLI: `AICAD_BIN`, or `forge/target/release/aicad`
 * (`cargo build --release -p forge-cli`); without it these tests are skipped and say so.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { v1 } from "@aicad/cadscript";
import { afterAll, describe, expect, it } from "vitest";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const gallery = join(repo, "corpus/gallery");
const bin = [process.env["AICAD_BIN"], join(repo, "forge/target/release/aicad"), join(repo, "forge/target/debug/aicad")].find((p): p is string => !!p && existsSync(p)) ?? null;
const work = mkdtempSync(join(tmpdir(), "pz-gallery-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Body {
  volume: number;
  area: number;
  bbox_min: [number, number, number];
  bbox_max: [number, number, number];
  valid: boolean;
  shells: number;
}
interface Report {
  status: string;
  params: Array<{ name: string; value: number | boolean }>;
  features: Array<{ part: string; feature: string; status: string; error?: unknown }>;
  parts: Array<{ part: string; bodies: Body[] }>;
}

function build(file: string): Report {
  const compiled = v1.compile(readFileSync(join(gallery, file), "utf8"));
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(compiled.ok).toBe(true);
  const irPath = join(work, `${file}.json`);
  writeFileSync(irPath, v1.toJson(compiled.ir!));
  const r = spawnSync(bin!, ["eval", irPath], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Report;
}

const size = (b: Body): number[] => [0, 1, 2].map((i) => b.bbox_max[i]! - b.bbox_min[i]!);
/** A w × h rectangle with corner radius r. */
const roundedRect = (w: number, h: number, r: number): number => w * h - (4 - Math.PI) * r * r;
/** Shoelace area of a polygon. */
const polygonArea = (p: ReadonlyArray<readonly [number, number]>): number => Math.abs(p.reduce((s, [x, y], i) => s + x * p[(i + 1) % p.length]![1] - p[(i + 1) % p.length]![0] * y, 0)) / 2;

/** Every body fits the P2S (256 mm cube) with 10 mm free at each side of the bed. */
function fitsP2S(bodies: Body[]): boolean {
  const min = [0, 1, 2].map((i) => Math.min(...bodies.map((b) => b.bbox_min[i]!)));
  const max = [0, 1, 2].map((i) => Math.max(...bodies.map((b) => b.bbox_max[i]!)));
  return max[0]! - min[0]! <= 236 && max[1]! - min[1]! <= 236 && max[2]! - min[2]! <= 256 && min[2] === 0;
}

describe.skipIf(!bin)(`starter examples build with Forge (${bin ?? "no Forge CLI: skipped"})`, () => {
  it("P5 electronics box: a box and a lid, both valid, printed flat, 8 mm apart, exact volumes", () => {
    const rep = build("p5-electronics-box.cad.ts");
    expect(rep.status).toBe("ok");
    expect(rep.features.every((f) => f.status === "ok")).toBe(true);
    const [box, lid] = rep.parts;
    expect(box!.part).toBe("box");
    expect(lid!.part).toBe("lid");
    expect(box!.bodies).toHaveLength(1);
    expect(lid!.bodies).toHaveLength(1);
    const b = box!.bodies[0]!;
    const l = lid!.bodies[0]!;
    expect(b.valid && l.valid).toBe(true);
    expect(size(b).map((x) => +x.toFixed(6))).toEqual([64, 36, 24]);
    expect(size(l).map((x) => +x.toFixed(6))).toEqual([64, 36, 5]);
    // Box: outer shell 64 × 36 × 24 (r 3) less the 60 × 32 × 22 cavity (r 1) less the 12 × 7 USB slot through the 2 mm wall.
    const boxVolume = roundedRect(64, 36, 3) * 24 - roundedRect(60, 32, 1) * 22 - 12 * 7 * 2;
    // Lid: 2 mm plate plus a 3 mm lip of (60 − c) × (32 − c) with corner radius 1 − c/2, c = 0.2.
    const lidVolume = roundedRect(64, 36, 3) * 2 + roundedRect(59.8, 31.8, 0.9) * 3;
    expect(b.volume).toBeCloseTo(boxVolume, 6);
    expect(l.volume).toBeCloseTo(lidVolume, 6);
    // Side by side on the bed: the lid is ≥ 5 mm from the box, both on z = 0.
    expect(b.bbox_min[1] - l.bbox_max[1]).toBeCloseTo(8, 9);
    expect(b.bbox_min[2]).toBe(0);
    expect(l.bbox_min[2]).toBe(0);
    expect(fitsP2S([b, l])).toBe(true);
    const params = Object.fromEntries(rep.params.map((p) => [p.name, p.value]));
    expect(params).toMatchObject({ inner_x: 60, inner_y: 32, inner_z: 22, wall: 2, clearance_slip: 0.2 });
  });

  it("P2 phone stand: one valid body at 65°, a 12 mm slot and a 14 mm cable notch, exact volume", () => {
    const rep = build("p2-phone-stand.cad.ts");
    expect(rep.status).toBe("ok");
    expect(rep.parts).toHaveLength(1);
    const bodies = rep.parts[0]!.bodies;
    expect(bodies).toHaveLength(1);
    const s = bodies[0]!;
    expect(s.valid).toBe(true);
    expect(s.shells).toBe(1);
    const p = Object.fromEntries(rep.params.map((x) => [x.name, x.value as number]));
    expect(p).toMatchObject({ angle: 65, phone_slot: 12, width: 70, wall: 6, notch_w: 14 });
    const { wall: w, phone_slot: slot, width, lip_h, lip_r: r, support, post_at } = p as Record<string, number>;
    const ca = Math.cos((65 * Math.PI) / 180);
    const sa = Math.sin((65 * Math.PI) / 180);
    const bx = w! + slot!;
    const tx = bx + support! * ca;
    const ty = w! + support! * sa;
    const qx = bx + w! * sa + post_at! * support! * ca;
    const qy = w! - w! * ca + post_at! * support! * sa;
    const w1x = bx + w! / sa;
    const w3y = w! - w! * ca + (post_at! * support! - w! / ca) * sa;
    const outer = polygonArea([
      [0, 0],
      [qx, 0],
      [qx, qy],
      [tx + w! * sa, ty - w! * ca],
      [tx, ty],
      [bx, w!],
      [w!, w!],
      [w!, lip_h!],
      [0, lip_h!],
    ]);
    const lipRounding = 2 * (r! * r! - (Math.PI * r! * r!) / 4);
    const window = polygonArea([
      [w1x, w!],
      [qx - w!, w!],
      [qx - w!, w3y],
    ]);
    const profile = outer - lipRounding - window;
    // The notch (14 wide, from y = 3 up through the lip, to x = wall + slot/2) removes the lip above y = 3 and the foot under the groove front.
    const notch = 14 * (w! * (lip_h! - 3) - lipRounding + (slot! / 2) * (w! - 3));
    expect(s.volume).toBeCloseTo(profile * width! - notch, 5);
    // ALPHA-0-PLAN §2.4 P2 model pass: depth ≥ 70 (X), height 70–140 (Y), width ≥ 60 (Z).
    const [dx, dy, dz] = size(s);
    expect(dx).toBeGreaterThanOrEqual(70);
    expect(dy).toBeGreaterThanOrEqual(70);
    expect(dy).toBeLessThanOrEqual(140);
    expect(dz).toBeGreaterThanOrEqual(60);
    expect(fitsP2S(bodies)).toBe(true);
  });

  it("every example named in starters.json exists and builds", () => {
    const index = JSON.parse(readFileSync(join(gallery, "starters.json"), "utf8")) as { starters: Array<{ example: string | null }> };
    const examples = index.starters.map((s) => s.example).filter((e): e is string => e !== null);
    expect(examples.length).toBeGreaterThan(0);
    for (const e of examples) {
      expect(existsSync(join(gallery, e))).toBe(true);
      expect(build(e).status).toBe("ok");
    }
  });
});
