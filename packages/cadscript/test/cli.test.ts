import { describe, expect, it } from "vitest";
import { main, type CliIo } from "../src/cli-main.js";
import { print } from "../src/index.js";
import { corpusPrograms } from "./helpers.js";

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
  const code = main(argv, io);
  return { code, stdout, stderr, files: fs };
}

const [box] = corpusPrograms();
const boxJson = JSON.stringify(box!.ir);
const boxSrc = print(box!.ir);

describe("cadscript CLI", () => {
  it("print: IR JSON → canonical CadScript", () => {
    const r = run(["print", "box.json"], { "box.json": boxJson });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(boxSrc);
  });

  it("compile: CadScript → IR JSON, keeping ids with --base", () => {
    const r = run(["compile", "box.cad.ts", "--base", "box.json"], { "box.cad.ts": boxSrc, "box.json": boxJson });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toStrictEqual(box!.ir);
    const noBase = run(["compile", "box.cad.ts", "-o", "out.json"], { "box.cad.ts": boxSrc });
    expect(noBase.code).toBe(0);
    expect(JSON.parse(noBase.files["out.json"]!).parts[0].id).toBe("p_part");
  });

  it("compile: reports diagnostics and exits 1 on errors", () => {
    const r = run(["compile", "bad.cad.ts"], { "bad.cad.ts": boxSrc.replace("distance: 8", "distance: -8") });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("bad.cad.ts:12:41 - error INVALID_DISTANCE");
  });

  it("check: compile + typecheck, human and JSON output", () => {
    const ok = run(["check", "box.cad.ts"], { "box.cad.ts": boxSrc });
    expect(ok.code).toBe(0);
    expect(ok.stderr).toBe("box.cad.ts: ok\n");
    const bad = run(["check", "bad.cad.ts", "--json"], { "bad.cad.ts": boxSrc.replace("distance: 8", 'distance: "8"') });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout).map((d: { code: string }) => d.code)).toEqual(["CS_BAD_ARGUMENT", "TS2322"]);
  });

  it("check: too deeply nested source is reported once (compile and typecheck agree), not thrown", () => {
    const deep = boxSrc.replace("distance: 8", `distance: ${"(".repeat(3000)}8${")".repeat(3000)}`);
    const r = run(["check", "deep.cad.ts", "--json"], { "deep.cad.ts": deep });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).map((d: { code: string }) => d.code)).toEqual(["CS_TOO_COMPLEX"]);
    const human = run(["compile", "deep.cad.ts"], { "deep.cad.ts": deep });
    expect(human.code).toBe(1);
    expect(human.stderr).toContain("error CS_TOO_COMPLEX: brackets are nested more than 32 levels deep");
  });

  it("usage errors exit 2; --help exits 0", () => {
    expect(run([], {}).code).toBe(2);
    expect(run(["frobnicate", "x"], {}).code).toBe(2);
    expect(run(["compile"], {}).code).toBe(2);
    expect(run(["compile", "a", "--bogus"], {}).code).toBe(2);
    expect(run(["--help"], {}).code).toBe(0);
  });

  it("reports unreadable or invalid input files", () => {
    const missing = run(["print", "nope.json"], {});
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
    const invalid = run(["print", "x.json"], { "x.json": '{"schema":"aicad.ir/0"}' });
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("invalid IR document");
  });
});
