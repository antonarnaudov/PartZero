import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecordingTransport } from "@aicad/llm-gateway";
import { cliMain, ScriptedTransport, scriptedGateway, type CliDeps, type Scripts } from "../src/index.js";
import { fixtureEngine } from "./helpers.js";
import { CORPUS_DIR, GASKET, GASKET_OPEN, GASKET_OUTLINE_FIX, PLATE_OK, PLATE_THICK, SLAB_10, WASHER } from "./scenarios.js";
import { apply, GASKET_REQS, GASKET_TESTS, propose, specTurns, triage, WASHER_REQS, WASHER_TESTS } from "./scripts.js";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t), cwd: process.cwd() }, out, err };
}

function deps(scripts: Scripts): CliDeps {
  const transport = new ScriptedTransport(scripts);
  return { makeGateway: () => scriptedGateway(transport), makeEngine: () => fixtureEngine() };
}

describe("aicad-agent run", () => {
  it("prints the final CadScript and a trace summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aicad-agent-cli-"));
    const { io: cio, out, err } = io();
    const code = await cliMain(
      ["run", "--prompt", "Gasket 90 x 70 x 1.5 mm, 8 mm band, M3 holes in the corners.", "--engine", "fixture", "--process", "laser", "--out", join(dir, "gasket.cad.ts"), "--trace", join(dir, "trace.json")],
      cio,
      deps({
        triage: [triage("design")],
        spec_writer: specTurns(GASKET_TESTS, GASKET_REQS),
        designer: [apply({ source: GASKET_OPEN }), apply({ patches: [GASKET_OUTLINE_FIX] }), propose("Gasket.", ["1.5 mm sheet"])],
      }),
    );
    expect(code).toBe(0);
    expect(out.join("")).toBe(GASKET);
    const e = err.join("");
    expect(e).toContain("status: proposed (proposed)");
    expect(e).toContain("states: TRIAGE → SPEC → BUILD → REPAIR → BUILD → PROPOSE → DONE");
    expect(e).toContain("spec tests: 5/5");
    expect(e).toContain("  assumption: 1.5 mm sheet");
    expect(e).toMatch(/\[\d+\.\ds REPAIR\] state: REPAIR: 1\/2/);
    expect(readFileSync(join(dir, "gasket.cad.ts"), "utf8")).toBe(GASKET);
    expect(JSON.parse(readFileSync(join(dir, "trace.json"), "utf8"))).toMatchObject({ status: "proposed", trace: { applies: 2 } });
  });

  it("edits a context file and exits 1 when the run stops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aicad-agent-cli-"));
    writeFileSync(join(dir, "plate.cad.ts"), PLATE_OK);
    const ok = io();
    expect(
      await cliMain(["run", "--prompt", "10 mm thick", "--context", join(dir, "plate.cad.ts"), "--kind", "quick_edit", "--engine", "fixture"], ok.io, deps({ designer: [apply({ patches: [SLAB_10] }), propose("Thicker.")] })),
    ).toBe(0);
    expect(ok.out.join("")).toBe(PLATE_THICK);
    const stopped = io();
    const code = await cliMain(
      ["run", "--prompt", "10 mm thick", "--context", join(dir, "plate.cad.ts"), "--kind", "quick_edit", "--engine", "fixture"],
      stopped.io,
      deps({ designer: [{ stop: "refusal" }] }),
    );
    expect(code).toBe(1);
    expect(stopped.err.join("")).toContain("status: stopped (refusal)");
  });

  it("replays a recorded trajectory offline (no keys, no scripts)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aicad-agent-cli-"));
    const recorder = new RecordingTransport(
      new ScriptedTransport({ triage: [triage("design")], spec_writer: specTurns(WASHER_TESTS, WASHER_REQS), designer: [apply({ source: WASHER }), propose("Washer.")] }),
    );
    const first = io();
    const args = ["run", "--prompt", "M3 washer, 7 mm OD, 1 mm thick.", "--engine", "fixture"];
    expect(await cliMain(args, first.io, { makeGateway: () => scriptedGateway(recorder), makeEngine: () => fixtureEngine() })).toBe(0);
    writeFileSync(join(dir, "trajectory.json"), JSON.stringify(recorder.fixtures));
    expect(recorder.fixtures).toHaveLength(5);
    const again = io();
    expect(await cliMain([...args, "--replay", join(dir, "trajectory.json")], again.io, { makeEngine: () => fixtureEngine() })).toBe(0);
    expect(again.out.join("")).toBe(WASHER);
    expect(again.err.join("")).toContain("status: proposed");
  });

  it("reports usage errors with exit code 2", async () => {
    const a = io();
    expect(await cliMain(["run"], a.io)).toBe(2);
    expect(a.err.join("")).toContain("--prompt is required");
    const b = io();
    expect(await cliMain(["frobnicate"], b.io)).toBe(2);
    const c = io();
    expect(await cliMain([], c.io)).toBe(2);
    const d = io();
    expect(await cliMain(["run", "--prompt", "x", "--designer-model", "gpt-7"], d.io, { makeEngine: () => fixtureEngine() })).toBe(2);
    expect(d.err.join("")).toContain("No model profile 'gpt-7'");
    expect(c.out.join("")).toContain("aicad-agent bench --tasks <dir> --models");
  });
});

describe("aicad-agent bench", () => {
  it("runs the bake-off and writes comparison.md", async () => {
    const out = mkdtempSync(join(tmpdir(), "aicad-bench-cli-"));
    const { io: cio, out: stdout } = io();
    const code = await cliMain(
      ["bench", "--tasks", CORPUS_DIR, "--only", "t1-m3-washer", "--models", "claude-opus-5-5", "--engine", "fixture", "--out", out, "--concurrency", "1"],
      cio,
      deps({ triage: [triage("design")], spec_writer: specTurns(WASHER_TESTS, WASHER_REQS), designer: [apply({ source: WASHER }), propose("Washer.")] }),
    );
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("| `claude-opus-5-5` | 100.0% (1/1) | 1/1 |");
    expect(readFileSync(join(out, "comparison.md"), "utf8")).toContain("| Designer model | pass@1 |");
  });

  it("refuses to start without the provider key when using real transports", async () => {
    const { io: cio, err } = io();
    const code = await cliMain(["bench", "--tasks", CORPUS_DIR, "--only", "t1-m3-washer", "--models", "gpt-6-astra"], cio, { makeEngine: () => fixtureEngine(), env: {} });
    expect(code).toBe(2);
    expect(err.join("")).toContain("gpt-6-astra needs OPENAI_API_KEY");
    const unknown = io();
    expect(await cliMain(["bench", "--tasks", CORPUS_DIR, "--only", "t1-m3-washer", "--models", "gpt-7"], unknown.io, { makeEngine: () => fixtureEngine(), env: {} })).toBe(2);
    expect(unknown.err.join("")).toContain("unknown model gpt-7 (known: claude-opus-5-5");
  });
});
