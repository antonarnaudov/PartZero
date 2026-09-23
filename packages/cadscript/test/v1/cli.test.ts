import { describe, expect, it } from "vitest";
import { main, type CliIo } from "../../src/cli-main.js";
import { printV1 } from "../../src/v1/print.js";
import { join } from "node:path";
import { COMPILE_AS_V1 } from "../../src/syntax.js";
import { migrationPairs, readText, V1_CADSCRIPT, v1Programs } from "./helpers.js";

function run(argv: string[], files: Record<string, string>): { code: number; stdout: string; stderr: string; files: Record<string, string> } {
  let stdout = "";
  let stderr = "";
  const fs = { ...files };
  const io: CliIo = {
    readFile: (p) => {
      if (!(p in fs)) throw new Error(`ENOENT: no such file: ${p}`);
      return fs[p]!;
    },
    writeFile: (p, c) => {
      fs[p] = c;
    },
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
  };
  return { code: main(argv, io), stdout, stderr, files: fs };
}

const plate = v1Programs().find((p) => p.stem === "plate_features")!;
const plateSrc = printV1(plate.ir);

describe("cadscript CLI, v1", () => {
  it("print: an aicad.ir/1 document prints as CadScript v1", () => {
    const r = run(["print", "plate.json"], { "plate.json": plate.text });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(plateSrc);
  });

  it("compile --base v1.json: canonical JSON, byte-identical to the fixture", () => {
    const r = run(["compile", "plate.cad.ts", "--base", "plate.json"], { "plate.cad.ts": plateSrc, "plate.json": plate.text });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(plate.text);
  });

  it("compile --v1 without base assigns fresh ids and writes aicad.ir/1", () => {
    const r = run(["compile", "plate.cad.ts", "--v1", "-o", "out.json"], { "plate.cad.ts": plateSrc });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.files["out.json"]!) as { schema: string; parts: { id: string; features: { id: string }[] }[] };
    expect(doc.schema).toBe("aicad.ir/1");
    expect(doc.parts[0]!.features[0]!.id).toBe("f_base");
  });

  it("compile --v1 reports IR codes at their spans and exits 1", () => {
    const bad = plateSrc.replace("fillet(slab.sides().edges().parallel(Z), { r: 1 })", "fillet(slab.cap(\"end\"), { r: 1 })");
    const r = run(["compile", "bad.cad.ts", "--v1"], { "bad.cad.ts": bad });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/bad\.cad\.ts:\d+:\d+ - error REF_KIND_MISMATCH/);
  });

  it("check --v1: compile + typecheck against @aicad/std v1", () => {
    const ok = run(["check", "plate.cad.ts", "--v1"], { "plate.cad.ts": plateSrc });
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe("plate.cad.ts: ok\n");
    const bad = run(["check", "bad.cad.ts", "--v1", "--json"], { "bad.cad.ts": plateSrc.replace("r: 1 }", 'r: "1" }') });
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.stdout) as { code: string }[]).map((d) => d.code)).toContain("TS2322");
  });

  it("check: source beyond the nesting limits is reported once; a later-stage CS_TOO_COMPLEX still type-checks the file", () => {
    const HEAD = `import { part, sketch, extrude, tag, rect, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\n`;
    const codes = (r: { stdout: string }): string[] => (JSON.parse(r.stdout) as { code: string }[]).map((d) => d.code);
    // never parsed: compile's CS_TOO_COMPLEX alone (the type checker would repeat it)
    const deep = run(["check", "deep.cad.ts", "--json"], { "deep.cad.ts": `${HEAD}const t = extrude(s, { distance: ${"(".repeat(3000)}8${")".repeat(3000)} });\n` });
    expect(deep.code).toBe(1);
    expect(codes(deep)).toEqual(["CS_TOO_COMPLEX"]);
    // a type error elsewhere in the file (TS2322: "5" is not a Scalar)
    const typeError = `const u = extrude(s, { distance: "5" });\n`;
    // the IR JSON nesting bound (compile stage): the type checker still runs
    const chain = `e.cap("end")${Array.from({ length: 121 }, (_, i) => (i % 2 === 0 ? ".edges()" : ".faces()")).join("")}`;
    const nested = run(["check", "n.cad.ts", "--json"], { "n.cad.ts": `${HEAD}const t = tag(${chain});\n${typeError}` });
    expect(nested.code).toBe(1);
    expect(codes(nested)).toContain("CS_TOO_COMPLEX");
    expect(codes(nested)).toContain("TS2322");
    // query alias expansion beyond its bound (lowering stage): the type checker still runs
    const aliases = Array.from({ length: 10 }, (_, i) => (i === 0 ? `const a0 = e.cap("end");` : `const a${i} = a${i - 1}.and(a${i - 1});`)).join("\n");
    const expanded = run(["check", "a.cad.ts", "--json"], { "a.cad.ts": `${HEAD}${aliases}\nconst t = tag(a9);\n${typeError}` });
    expect(expanded.code).toBe(1);
    expect(codes(expanded)).toContain("CS_TOO_COMPLEX");
    expect(codes(expanded)).toContain("TS2322");
  });

  it("check --strict counts warnings as errors", () => {
    expect(run(["check", "p.cad.ts", "--strict"], { "p.cad.ts": plateSrc }).code).toBe(0); // no warnings: no change
    const tags = Array.from({ length: 2100 }, (_, i) => `const t${i} = tag(e.cap("end"));`).join("\n");
    const big = `import { part, sketch, extrude, tag, rect, XY } from "@aicad/std";\n\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: 10, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\n${tags}\n`;
    const lax = run(["check", "big.cad.ts"], { "big.cad.ts": big });
    expect(lax.code).toBe(0);
    expect(lax.stderr).toContain("warning CS_TOO_COMPLEX: not type-checked");
    const strict = run(["check", "big.cad.ts", "--strict"], { "big.cad.ts": big });
    expect(strict.code).toBe(1);
    expect(strict.stderr).toContain("error CS_TOO_COMPLEX: not type-checked");
    expect(strict.stderr).toContain("big.cad.ts: 1 error");
    const json = run(["check", "big.cad.ts", "--strict", "--json"], { "big.cad.ts": big });
    expect((JSON.parse(json.stdout) as { code: string; severity: string }[]).map((d) => [d.code, d.severity])).toEqual([["CS_TOO_COMPLEX", "error"]]);
    expect(run(["compile", "big.cad.ts", "--strict"], { "big.cad.ts": big }).code).toBe(2); // a check option only
  });

  it("print --v1 prints a v0 document's migration; migrate writes the fixture text", () => {
    for (const pair of migrationPairs().filter((p) => p.group !== "makerbench").slice(0, 6)) {
      const v0Path = `${pair.group}/${pair.stem}.v0.json`;
      const v0Text = readText(`${__dirname}/../../../../corpus/v1/conformance/migration/${v0Path}`);
      const printed = run(["print", "d.json", "--v1"], { "d.json": v0Text });
      expect(printed.code).toBe(0);
      expect(printed.stdout).toBe(printV1(pair.v1));
      const migrated = run(["migrate", "d.json"], { "d.json": v0Text });
      expect(migrated.code).toBe(0);
      expect(migrated.stdout).toBe(pair.v1Text);
      if (pair.group === "renames" && pair.stem !== "no-renames-needed") expect(migrated.stderr).toContain('"renames"');
    }
  });

  it("migrate reproduces serde_json's reading of v0 numbers (t2-cable-organizer)", () => {
    const pair = migrationPairs().find((p) => p.stem === "t2-cable-organizer")!;
    const v0Text = readText(`${__dirname}/../../../../corpus/v1/conformance/migration/makerbench/t2-cable-organizer.v0.json`);
    expect(run(["migrate", "d.json"], { "d.json": v0Text }).stdout).toBe(pair.v1Text);
  });

  const extrudeBoxV0 = (): string => readText(`${__dirname}/../../../../corpus/v1/conformance/migration/programs/extrude_box.v0.json`);

  it("migrate validates v0 first: an invalid v0 document is rejected with its v0 codes and paths, exit 1 (SPEC-v1 §9.1)", () => {
    const bad = extrudeBoxV0().replace('"sketch": "base"', '"sketch": "nosuch"').replace('"distance": 8', '"distance": -8');
    expect(bad).toContain('"nosuch"');
    const r = run(["migrate", "bad0.json"], { "bad0.json": bad });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^bad0\.json: error UNRESOLVED_SKETCH at \/parts\/0\/features\/1\/sketch: /m);
    expect(r.stderr).toMatch(/^bad0\.json: error INVALID_DISTANCE at \/parts\/0\/features\/1\/distance: /m);
    expect(r.stderr).toMatch(/rejected \(not a valid aicad\.ir\/0 document\)/);
    // print --v1 goes through the same pipeline
    expect(run(["print", "bad0.json", "--v1"], { "bad0.json": bad }).code).toBe(1);
  });

  it("v1 input is read as forge-ir reads it: a duplicate key is rejected, not silently resolved", () => {
    const dup = plate.text.replace(/"distance": ([0-9.]+)/, '"distance": -8.0, "distance": $1');
    for (const argv of [["migrate", "d.json"], ["print", "d.json"], ["compile", "p.cad.ts", "--base", "d.json"]]) {
      const r = run(argv, { "d.json": dup, "p.cad.ts": plateSrc });
      expect(r.code).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toMatch(/d\.json: JSON syntax error at byte \d+: duplicate key "distance"/);
    }
  });

  it("an invalid v1 document is rejected by print, migrate and a v1 --base", () => {
    const invalid = plate.text.replace(/"distance": ([0-9.]+)/, '"distance": -$1');
    expect(invalid).not.toBe(plate.text);
    for (const argv of [["migrate", "d.json"], ["print", "d.json"], ["compile", "p.cad.ts", "--base", "d.json"]]) {
      const r = run(argv, { "d.json": invalid, "p.cad.ts": plateSrc });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/d\.json: error INVALID_DISTANCE at \/parts\/0\/features\/\d+\/distance: /);
      expect(r.stderr).toContain("rejected (not a valid aicad.ir/1 document)");
    }
  });

  it("the v0 paths (--v0) keep v0's reading (no validation): print and compile --base", () => {
    const bad = extrudeBoxV0().replace('"distance": 8', '"distance": -8');
    expect(run(["print", "bad0.json", "--v0"], { "bad0.json": bad }).code).toBe(0);
    const v0Src = run(["print", "box.json", "--v0"], { "box.json": extrudeBoxV0() }).stdout;
    expect(run(["compile", "b.cad.ts", "--base", "bad0.json", "--v0"], { "bad0.json": bad, "b.cad.ts": v0Src }).code).toBe(0);
    // without --v0 the same document is loaded as forge-ir loads it, and rejected
    expect(run(["print", "bad0.json"], { "bad0.json": bad }).code).toBe(1);
  });
});

describe("cadscript CLI: CadScript v1 is the default (SPEC-v1 §9.1)", () => {
  const twin = (stem: string): string => readText(join(V1_CADSCRIPT, `${stem}.cad.ts`));

  it("compile, check and print take v1 without flags; --v1 changes nothing", () => {
    for (const p of v1Programs()) {
      const src = twin(p.stem);
      const compiled = run(["compile", "p.cad.ts", "--base", "p.json"], { "p.cad.ts": src, "p.json": p.text });
      expect(compiled.stderr).not.toContain("error");
      expect(compiled.code).toBe(0);
      expect(compiled.stdout).toBe(p.text);
      expect(run(["compile", "p.cad.ts", "--base", "p.json", "--v1"], { "p.cad.ts": src, "p.json": p.text }).stdout).toBe(p.text);
      const fresh = run(["compile", "p.cad.ts"], { "p.cad.ts": src });
      expect(fresh.code).toBe(0);
      expect((JSON.parse(fresh.stdout) as { schema: string }).schema).toBe("aicad.ir/1");
      const checked = run(["check", "p.cad.ts"], { "p.cad.ts": src });
      expect(checked.stderr).toMatch(/p\.cad\.ts: ok\n$/);
      expect(checked.code).toBe(0);
      expect(run(["print", "p.json"], { "p.json": p.text }).stdout).toBe(src);
    }
  });

  it("params_plate.cad.ts (param() and expressions) compiles without flags", () => {
    const r = run(["compile", "params_plate.cad.ts"], { "params_plate.cad.ts": twin("params_plate") });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
  });

  it("a v0 source compiles to its migration, a v0 document prints as its migration", () => {
    for (const pair of migrationPairs().filter((p) => p.group === "programs").slice(0, 4)) {
      const v0Text = readText(`${__dirname}/../../../../corpus/v1/conformance/migration/programs/${pair.stem}.v0.json`);
      const printed = run(["print", "d.json"], { "d.json": v0Text });
      expect(printed.code).toBe(0);
      expect(printed.stdout).toBe(printV1(pair.v1));
      // the v0 printer's source, compiled without flags against the v0 base, is the v1 migration
      const v0Src = run(["print", "d.json", "--v0"], { "d.json": v0Text }).stdout;
      const compiled = run(["compile", "s.cad.ts", "--base", "d.json"], { "s.cad.ts": v0Src, "d.json": v0Text });
      expect(compiled.code).toBe(0);
      expect(compiled.stdout).toBe(pair.v1Text);
      expect(run(["check", "s.cad.ts"], { "s.cad.ts": v0Src }).code).toBe(0);
    }
  });

  it("--v0 on v1 input explains itself; v0 hints for v1 features point at v1", () => {
    const plateJson = run(["print", "p.json", "--v0"], { "p.json": plate.text });
    expect(plateJson.code).toBe(1);
    expect(plateJson.stderr).toContain("cannot be printed as CadScript v0 (drop --v0)");
    const based = run(["compile", "p.cad.ts", "--base", "p.json", "--v0"], { "p.cad.ts": plateSrc, "p.json": plate.text });
    expect(based.code).toBe(1);
    expect(based.stderr).toContain("drop --v0");
    const legacy = run(["compile", "p.cad.ts", "--v0"], { "p.cad.ts": twin("params_plate") });
    expect(legacy.code).toBe(1);
    expect(legacy.stderr).toContain(COMPILE_AS_V1);
    expect(legacy.stderr).not.toMatch(/numeric literal|inline the literal|for now/);
  });
});
