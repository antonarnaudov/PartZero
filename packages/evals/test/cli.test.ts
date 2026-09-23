import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli-main.js";
import type { SuiteResult } from "../src/pipeline.js";
import { CORPUS_DIR, FIXTURES_DIR } from "./helpers.js";

const out = mkdtempSync(join(tmpdir(), "aicad-evals-cli-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd: out });
  return { code, stdout, stderr };
}

describe("aicad-evals", () => {
  it("run: writes results.json and report.md", async () => {
    const dest = join(out, "run1");
    const r = await cli("run", "--tasks", CORPUS_DIR, "--engine", "fixture", "--fixtures", FIXTURES_DIR, "--tier", "T4,T5", "--out", dest);
    expect(r.stderr).not.toMatch(/FAIL/);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pass@1 100\.0% \(7\/7\)/);
    const results = JSON.parse(readFileSync(join(dest, "results.json"), "utf8")) as SuiteResult;
    expect(results.schema).toBe("aicad.evals.results/0");
    expect(results.tasks.map((t) => t.tier)).toEqual(["T4", "T4", "T4", "T4", "T5", "T5", "T5"]);
    expect(readFileSync(join(dest, "report.md"), "utf8")).toContain("## By tier");
  });

  it("run: defaults the output to artifacts/evals/<solver>-<engine> under the cwd", async () => {
    const r = await cli("run", "--tasks", CORPUS_DIR, "--engine", "fixture", "--fixtures", FIXTURES_DIR, "--only", "t1-m3-washer");
    expect(r.code).toBe(0);
    expect(existsSync(join(out, "artifacts", "evals", "reference-fixture", "report.md"))).toBe(true);
  });

  it("run: --fail-under turns a low pass@1 into exit 1, and failures are listed in the report", async () => {
    const dest = join(out, "mutant");
    const r = await cli(
      "run", "--tasks", CORPUS_DIR, "--solver", "mutant:drop_hole", "--engine", "fixture", "--fixtures", FIXTURES_DIR,
      "--tier", "T1", "--out", dest, "--fail-under", "1",
    );
    expect(r.code).toBe(1);
    const md = readFileSync(join(dest, "report.md"), "utf8");
    expect(md).toMatch(/### t1-m3-washer \(T1\): M3 washer/);
    expect(md).toMatch(/- FAIL `volume`: Volume .* Expected ≈ 30\.44 ±1%; got/);
    expect(md).toContain("## Skipped");
  });

  it("run: exits 2 when the requested engine is not available", async () => {
    const r = await cli("run", "--tasks", CORPUS_DIR, "--engine", "forge", "--forge-bin", join(out, "nope"), "--out", join(out, "x"));
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/engine forge is not available: Forge CLI not found/);
  });

  it("run: skips tasks that need capabilities the engine lacks", async () => {
    const dest = join(out, "caps");
    const r = await cli(
      "run", "--tasks", CORPUS_DIR, "--engine", "fixture", "--fixtures", FIXTURES_DIR, "--tier", "T1", "--out", dest,
      "--capabilities", "ir/0,feature/extrude",
    );
    expect(r.code).toBe(0);
    const results = JSON.parse(readFileSync(join(dest, "results.json"), "utf8")) as SuiteResult;
    expect(results.skipped.some((s) => s.id === "t1-knob" && /feature\/revolve/.test(s.reason))).toBe(true);
    expect(results.tasks.some((t) => t.id === "t1-knob")).toBe(false);
  });

  it("validate: reports 40 tasks and no problems", async () => {
    const r = await cli("validate", "--tasks", CORPUS_DIR);
    expect(r.stdout).toContain("40 tasks, 0 problems");
    expect(r.code).toBe(0);
  });

  it("usage errors exit 2 with the usage text", async () => {
    expect((await cli()).code).toBe(2);
    expect((await cli("frobnicate")).stderr).toMatch(/unknown command/);
    expect((await cli("run", "--tasks", CORPUS_DIR, "--solver", "oracle-of-delphi")).code).toBe(2);
    expect((await cli("run")).stderr).toMatch(/--tasks <dir> is required/);
    expect((await cli("--help")).stdout).toMatch(/^Usage:/);
  });
});
