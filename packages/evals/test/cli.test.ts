import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    expect(r.stdout).toMatch(/pass@1 100\.0% \(13\/13\)/);
    const results = JSON.parse(readFileSync(join(dest, "results.json"), "utf8")) as SuiteResult;
    expect(results.schema).toBe("aicad.evals.results/0");
    expect(results.tasks.map((t) => t.tier)).toEqual([...Array<string>(8).fill("T4"), ...Array<string>(5).fill("T5")]);
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

  it.skipIf(process.platform === "win32")("run: an aicad run the OS killed and ran again fails the run unless --allow-retry, and is listed", async () => {
    // A fake aicad that is SIGKILLed on its first run of each document, then prints a report.
    const bin = join(out, "aicad-killed-once");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const marker = process.argv[3] + ".killed";
if (!fs.existsSync(marker)) { fs.writeFileSync(marker, ""); process.kill(process.pid, "SIGKILL"); }
process.stdout.write(JSON.stringify({ schema: "aicad.metrics/0", engine: "fake", document: "d", status: "ok", features: [] }));
`,
    );
    chmodSync(bin, 0o755);
    const args = (dest: string) => ["run", "--tasks", CORPUS_DIR, "--engine", "forge", "--forge-bin", bin, "--only", "t1-m3-washer", "--out", dest];
    const failing = await cli(...args(join(out, "retried")));
    expect(failing.code).toBe(1);
    expect(failing.stderr).toMatch(/killed by the OS \(SIGKILL\) and run again:\n {2}t1-m3-washer: SIGKILL/);
    const results = JSON.parse(readFileSync(join(out, "retried", "results.json"), "utf8")) as SuiteResult;
    expect(results.engine_retries).toEqual(["t1-m3-washer: SIGKILL"]);
    expect(readFileSync(join(out, "retried", "report.md"), "utf8")).toContain("## Engine runs retried");
    const allowed = await cli(...args(join(out, "allowed")), "--allow-retry");
    expect(allowed.code).toBe(0);
    expect(allowed.stderr).toMatch(/allowed \(--allow-retry\)/);
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

  it("validate: reports 61 tasks and no problems", async () => {
    const r = await cli("validate", "--tasks", CORPUS_DIR);
    expect(r.stdout).toContain("61 tasks, 0 problems");
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
