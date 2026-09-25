/**
 * Round holes (the owner's rule, 2026-09-25), on the real Forge engine (forge-web WASM in Node):
 *
 * - **Print.** A 5 mm through hole in a 30 × 20 × 5 mm plate, exported as STL and 3MF through the
 *   export dialog's formats (`PRINT_TESSELLATION`: 0.01 mm chordal, at most 5°), has at least 72
 *   segments around its rim, no gap wider than 5° and no chord more than 0.01 mm inside the circle.
 * - **Display.** The viewport's tessellation (`viewport/display-tessellation.ts`) gives the same
 *   hole at least 36 segments, where Forge's own default gives it about 18; the chordal step follows the
 *   part's size on screen, and the document store re-evaluates once when the step changes.
 */
import { blankDocument } from "@aicad/model-ops";
import { beforeAll, describe, expect, it } from "vitest";
import { InlineCadScriptService } from "../src/cadscript/inline-service";
import { DocStore } from "../src/doc/doc-store";
import { forgeWebCommandEngine, type ForgeWebCommandModule, type IrCommandEngine } from "../src/doc/v1/command-engine";
import { IrDocStore } from "../src/doc/v1/ir-doc-store";
import { PRINT_TESSELLATION, type EvalResult, type ForgeEngine, type MeshFormat, type RenderBody, type TessellationOptions } from "../src/engine/types";
import { exportFormat } from "../src/file/export-formats";
import { readZip } from "../src/file/partzero/zip";
import {
  DEFAULT_DISPLAY_TESSELLATION,
  DISPLAY_ANGULAR_DEFLECTION,
  DISPLAY_CHORDAL_STEPS,
  displayTessellation,
  minCircleSegments,
} from "../src/viewport/display-tessellation";

const nodeFs = "node:fs";
const fs = (await import(/* @vite-ignore */ nodeFs)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
const wasmUrl = new URL("../../forge-web/pkg/forge_wasm_bg.wasm", import.meta.url);
const hasWasm = fs.existsSync(wasmUrl);
const it_ = hasWasm ? it : it.skip;

type Mod = ForgeWebCommandModule & {
  init(input: unknown): Promise<void>;
  evaluate(ir: string, options?: object): { report: unknown; bodies: RenderBody[] };
  exportMesh(ir: string, format: MeshFormat, options?: object): Uint8Array;
};

let mod: Mod;
let commands: IrCommandEngine;

/** forge-web in Node as the app's engine; it records the tolerances each call asked for. */
class NodeForgeEngine implements ForgeEngine {
  readonly id = "forge-web" as const;
  readonly label = "forge-web (node)";
  readonly detail = "test";
  get commands(): IrCommandEngine {
    return commands;
  }
  evaluations: Array<TessellationOptions | undefined> = [];
  evaluate(irJson: string, tess?: TessellationOptions): Promise<EvalResult> {
    this.evaluations.push(tess);
    const r = mod.evaluate(irJson, tess ?? {});
    return Promise.resolve({ report: r.report as EvalResult["report"], bodies: r.bodies });
  }
  exportMesh(irJson: string, format: MeshFormat, tess?: TessellationOptions): Promise<Uint8Array> {
    return Promise.resolve(mod.exportMesh(irJson, format, tess ?? {}));
  }
  dispose(): void {}
}

beforeAll(async () => {
  if (!hasWasm) return;
  const entry = new URL("../../forge-web/src/engine.ts", import.meta.url).pathname;
  mod = (await import(/* @vite-ignore */ entry)) as Mod;
  await mod.init(fs.readFileSync(wasmUrl));
  commands = forgeWebCommandEngine(mod);
}, 60_000);

/** A 30 × 20 × 5 mm plate with one 5 mm through hole (a `hole` feature on the top cap). */
const HOLE_D = 5;
const PLATE = {
  schema: "aicad.ir/1",
  meta: { name: "hole5", description: "a 5 mm through hole" },
  params: [],
  parts: [
    {
      id: "p1",
      name: "plate",
      features: [
        { type: "sketch", id: "s1", name: "base", plane: "XY", curves: [{ kind: "rect", id: "outline", center: [0, 0], w: 30, h: 20 }] },
        { type: "extrude", id: "e1", name: "slab", sketch: "s1", distance: 5 },
        {
          type: "hole",
          id: "h1",
          name: "hole5",
          on: { face: { kind: "face", q: { op: "cap", feature: "e1", end: "end" } } },
          at: { grid: { nx: 1, ny: 1, dx: 0, dy: 0 } },
          d: HOLE_D,
          depth: "through",
        },
      ],
    },
  ],
};
const PLATE_JSON = JSON.stringify(PLATE);

/** The plate evaluated for display at `tess`. */
const renderBodies = (tess: TessellationOptions): RenderBody[] => (mod.evaluate(PLATE_JSON, tess) as unknown as { bodies: RenderBody[] }).bodies;

type P3 = [number, number, number];

/** The hole's axis (x, y), from its wall's vertices in a display evaluation. */
function holeAxis(body: RenderBody): [number, number] {
  const wall = body.faceRanges.find((f) => f.face === "h1/wall");
  if (!wall) throw new Error("no hole wall");
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let t = wall.start; t < wall.start + wall.count; t++) {
    for (let k = 0; k < 3; k++) {
      const i = body.indices[3 * t + k]!;
      sx += body.positions[3 * i]!;
      sy += body.positions[3 * i + 1]!;
      n++;
    }
  }
  return [sx / n, sy / n];
}

/**
 * The rim of the hole at height `z`: the sorted angles (radians, [0, 2π)) of the mesh vertices on
 * the circle of radius `r` around `c`, each counted once.
 */
function rim(points: readonly P3[], c: [number, number], r: number, z: number): number[] {
  const seen = new Set<number>();
  for (const [x, y, pz] of points) {
    if (Math.abs(pz - z) > 1e-4) continue;
    if (Math.abs(Math.hypot(x - c[0], y - c[1]) - r) > 1e-4) continue;
    let a = Math.atan2(y - c[1], x - c[0]);
    if (a < 0) a += 2 * Math.PI;
    const q = Math.round(a * 1e4) / 1e4;
    seen.add(q >= Math.round(2 * Math.PI * 1e4) / 1e4 ? 0 : q);
  }
  return [...seen].sort((a, b) => a - b);
}

/** The widest angular gap between neighbouring rim vertices (radians), wrapping around. */
function widestGap(angles: readonly number[]): number {
  let widest = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = i + 1 < angles.length ? angles[i + 1]! : angles[0]! + 2 * Math.PI;
    widest = Math.max(widest, next - angles[i]!);
  }
  return widest;
}

function stlPoints(bytes: Uint8Array): P3[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = v.getUint32(80, true);
  const out: P3[] = [];
  for (let t = 0; t < n; t++) {
    const o = 84 + 50 * t + 12;
    for (let k = 0; k < 3; k++) out.push([v.getFloat32(o + 12 * k, true), v.getFloat32(o + 12 * k + 4, true), v.getFloat32(o + 12 * k + 8, true)]);
  }
  return out;
}

function threeMfPoints(bytes: Uint8Array): P3[] {
  const model = readZip(bytes).find((e) => /3dmodel\.model$/i.test(e.name));
  if (!model) throw new Error("no 3D model in the 3MF");
  const xml = new TextDecoder().decode(model.data);
  const out: P3[] = [];
  for (const m of xml.matchAll(/<vertex\s+x="([^"]+)"\s+y="([^"]+)"\s+z="([^"]+)"/g)) out.push([Number(m[1]), Number(m[2]), Number(m[3])]);
  return out;
}

function bodyPoints(b: RenderBody): P3[] {
  const out: P3[] = [];
  for (let i = 0; i < b.positions.length; i += 3) out.push([b.positions[i]!, b.positions[i + 1]!, b.positions[i + 2]!]);
  return out;
}

describe("display tessellation (pure)", () => {
  it("keeps every full circle at 36 segments or more", () => {
    expect(DISPLAY_ANGULAR_DEFLECTION).toBeCloseTo(Math.PI / 18, 12);
    expect(minCircleSegments(DISPLAY_ANGULAR_DEFLECTION)).toBe(36);
    expect(minCircleSegments(PRINT_TESSELLATION.angularDeflection)).toBe(72);
    expect(displayTessellation(1000, 400, 1).angularDeflection).toBe(DISPLAY_ANGULAR_DEFLECTION);
  });

  it("asks for half a device pixel at 2× the fitted zoom, in fixed steps between 0.01 and 0.05 mm", () => {
    // A 60 mm box in an 800 px viewport on a Retina screen: 0.0094 mm wanted → the finest step.
    expect(displayTessellation(60, 800, 2).chordalDeflection).toBe(0.01);
    // A 300 mm part on a 1x screen: 0.094 mm wanted → capped at 0.05 mm.
    expect(displayTessellation(300, 800, 1).chordalDeflection).toBe(0.05);
    // 150 mm in 800 px at 1x: 0.047 → 0.035.
    expect(displayTessellation(150, 800, 1).chordalDeflection).toBe(0.035);
    for (const size of [1, 5, 20, 80, 200, 600, 2000]) {
      for (const px of [300, 800, 1600]) {
        const c = displayTessellation(size, px, 2).chordalDeflection;
        expect(DISPLAY_CHORDAL_STEPS).toContain(c);
      }
    }
    expect(displayTessellation(0, 800)).toEqual({ ...DEFAULT_DISPLAY_TESSELLATION });
    expect(displayTessellation(Number.NaN, 800)).toEqual({ ...DEFAULT_DISPLAY_TESSELLATION });
  });

  it("keeps the current step while the size only jitters around a step boundary", () => {
    // 170 mm at 800 px, 1x: target 0.053 → 0.05 on its own, but a current 0.035 (bounds 0.035 to
    // 0.05) is kept: the target is within 15% of its upper bound.
    expect(displayTessellation(170, 800, 1).chordalDeflection).toBe(0.05);
    expect(displayTessellation(170, 800, 1, 0.035).chordalDeflection).toBe(0.035);
    expect(displayTessellation(200, 800, 1, 0.035).chordalDeflection).toBe(0.05);
    // Far outside: the step moves.
    expect(displayTessellation(40, 800, 1, 0.035).chordalDeflection).toBe(0.0125);
  });
});

describe("round holes on the real engine", () => {
  it_("a 5 mm hole exports (STL and 3MF, print tolerances) with at least 72 segments", async () => {
    const engine = new NodeForgeEngine();
    const display = { bodies: renderBodies({}) };
    const plate = display.bodies.find((b) => b.name === "plate/slab");
    expect(plate, "the plate body").toBeTruthy();
    const axis = holeAxis(plate!);
    for (const id of ["stl", "3mf"] as const) {
      const bytes = await exportFormat(id)!.run({ irJson: PLATE_JSON, engine, name: "hole5" });
      const points = id === "stl" ? stlPoints(bytes) : threeMfPoints(bytes);
      for (const z of [0, 5]) {
        const angles = rim(points, axis, HOLE_D / 2, z);
        expect(angles.length, `${id} rim at z = ${z}`).toBeGreaterThanOrEqual(72);
        const gap = widestGap(angles);
        expect(gap, `${id}: widest gap ${((gap * 180) / Math.PI).toFixed(3)}°`).toBeLessThanOrEqual((5 * Math.PI) / 180 + 1e-3);
        // The chord's distance from the exact circle (its sagitta) is within the 0.01 mm tolerance.
        expect((HOLE_D / 2) * (1 - Math.cos(gap / 2))).toBeLessThanOrEqual(0.01 + 1e-6);
      }
    }
  });

  it_("the viewport's tolerances give the hole at least 36 segments; Forge's default about 18", async () => {
    const coarse = renderBodies({})[0]!;
    const axis = holeAxis(coarse);
    // 0.35 rad: 18 segments (plus one vertex where the cap's triangulation meets the rim).
    expect(rim(bodyPoints(coarse), axis, HOLE_D / 2, 5).length).toBeLessThanOrEqual(19);
    const fine = renderBodies({ ...DEFAULT_DISPLAY_TESSELLATION })[0]!;
    expect(rim(bodyPoints(fine), axis, HOLE_D / 2, 5).length).toBeGreaterThanOrEqual(36);
    const big = renderBodies({ chordalDeflection: 0.05, angularDeflection: DISPLAY_ANGULAR_DEFLECTION })[0]!;
    expect(rim(bodyPoints(big), axis, HOLE_D / 2, 5).length).toBeGreaterThanOrEqual(36);
  });

  it_("the document store evaluates with the display tolerances, and re-evaluates once when they change", async () => {
    const engine = new NodeForgeEngine();
    const ir = new IrDocStore({ engine: () => commands });
    const doc = new DocStore({ cadscript: new InlineCadScriptService(), engine: () => engine, ir, debounceMs: 0 });
    doc.load({ path: null, name: "hole5", format: "ir-v1", source: blankDocument("hole5") });
    await doc.idle();
    await ir.apply({ op: "addFeature", feature: { type: "sketch", plane: "XY", curves: [{ kind: "circle", id: "c", center: [0, 0], radius: 10 }] } });
    await ir.apply({ op: "addFeature", feature: { type: "extrude", sketch: "sketch1", distance: 2 } });
    await doc.idle();
    expect(engine.evaluations.at(-1)).toEqual(DEFAULT_DISPLAY_TESSELLATION);
    const before = engine.evaluations.length;
    expect(doc.setDisplayTessellation({ ...DEFAULT_DISPLAY_TESSELLATION })).toBe(false);
    await doc.idle();
    expect(engine.evaluations.length).toBe(before);
    const coarser = { chordalDeflection: 0.035, angularDeflection: DISPLAY_ANGULAR_DEFLECTION };
    expect(doc.setDisplayTessellation(coarser)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    await doc.idle();
    expect(engine.evaluations.length).toBe(before + 1);
    expect(engine.evaluations.at(-1)).toEqual(coarser);
    expect(doc.displayTessellation).toEqual(coarser);
    expect(doc.getState().bodies).toHaveLength(1);
  });
});
