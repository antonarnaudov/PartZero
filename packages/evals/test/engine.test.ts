import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { EvalReport, IrDocument } from "@aicad/ir-types";
import { EngineError, FixtureEngine, ForgeCliEngine, OracleEngine, type Engine } from "../src/engine.js";
import { runTask } from "../src/pipeline.js";
import { ReferenceSolver, solverFromFunction } from "../src/solver.js";
import { body, compileOk, corpusTasks, fixtureEngine, simpleReport } from "./helpers.js";

const tasks = corpusTasks();
const washer = tasks.find((t) => t.id === "t1-m3-washer")!;
const washerIr = compileOk(washer.referenceSource);

const dir = mkdtempSync(join(tmpdir(), "aicad-evals-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A fake engine executable: a node script (POSIX shebang). */
function fakeBin(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const posix = process.platform !== "win32";

describe("ForgeCliEngine", () => {
  it("reports absence of the aicad binary instead of failing mid-run", async () => {
    const e = new ForgeCliEngine({ bin: join(dir, "no-such-aicad") });
    const a = await e.availability();
    expect(a.available).toBe(false);
    expect(a.detail).toMatch(/Forge CLI not found at .*no-such-aicad/);
    await expect(e.evaluate(washerIr)).rejects.toMatchObject({ code: "ENGINE_UNAVAILABLE" });
  });

  it("defaults to forge/target/debug/aicad", () => {
    expect(new ForgeCliEngine().bin).toMatch(/forge[/\\]target[/\\]debug[/\\]aicad(\.exe)?$/);
  });

  it.skipIf(!posix)("runs `<bin> eval <file> --format json` and parses the report", async () => {
    const canned: EvalReport = simpleReport([body()]);
    const bin = fakeBin(
      "aicad",
      `const [cmd, file, fmt, json] = process.argv.slice(2);
       const fs = require("node:fs");
       if (cmd !== "eval" || fmt !== "--format" || json !== "json") { console.error("bad args " + process.argv.slice(2)); process.exit(2); }
       const ir = JSON.parse(fs.readFileSync(file, "utf8"));
       const report = ${JSON.stringify(canned)};
       report.document = ir.meta.name;
       process.stdout.write(JSON.stringify(report));`,
    );
    const e = new ForgeCliEngine({ bin });
    expect((await e.availability()).available).toBe(true);
    const r = await e.evaluate(washerIr, { name: "washer" });
    expect(r.document).toBe("m3_washer");
    expect(r.features).toHaveLength(2);
  });

  it.skipIf(!posix)("classifies crashes, garbage output and timeouts", async () => {
    const crash = new ForgeCliEngine({ bin: fakeBin("crash", `console.error("panicked at forge-ops"); process.exit(101);`) });
    await expect(crash.evaluate(washerIr)).rejects.toMatchObject({ code: "ENGINE_FAILED", message: expect.stringMatching(/panicked/) });
    const garbage = new ForgeCliEngine({ bin: fakeBin("garbage", `console.log("not json");`) });
    await expect(garbage.evaluate(washerIr)).rejects.toMatchObject({ code: "ENGINE_BAD_OUTPUT" });
    const wrong = new ForgeCliEngine({ bin: fakeBin("wrong", `console.log(JSON.stringify({ schema: "x" }));`) });
    await expect(wrong.evaluate(washerIr)).rejects.toMatchObject({ code: "ENGINE_BAD_OUTPUT", message: expect.stringMatching(/aicad.metrics/) });
    const slow = new ForgeCliEngine({ bin: fakeBin("slow", `setTimeout(() => {}, 10000);`), timeoutMs: 200 });
    await expect(slow.evaluate(washerIr)).rejects.toMatchObject({ code: "ENGINE_TIMEOUT" });
  });
});

describe("OracleEngine", () => {
  it("reports a missing oracle project", async () => {
    const e = new OracleEngine({ oracleDir: join(dir, "no-oracle") });
    expect(await e.availability()).toMatchObject({ available: false, detail: expect.stringMatching(/no oracle project/) });
    await expect(e.evaluate(washerIr)).rejects.toBeInstanceOf(EngineError);
  });

  it("reports a missing uv", async () => {
    const oracleDir = mkdtempSync(join(dir, "oracle-"));
    writeFileSync(join(oracleDir, "pyproject.toml"), "");
    const e = new OracleEngine({ oracleDir, uv: join(dir, "no-such-uv") });
    expect(await e.availability()).toMatchObject({ available: false, detail: expect.stringMatching(/not runnable/) });
  });

  it.skipIf(!posix)("runs `uv run oracle eval <file>` in the oracle project and accepts exit 1 (status error)", async () => {
    const oracleDir = mkdtempSync(join(dir, "oracle-"));
    writeFileSync(join(oracleDir, "pyproject.toml"), "");
    const errorReport: EvalReport = { ...simpleReport([]), status: "error" };
    const uv = fakeBin(
      "uv",
      `const a = process.argv.slice(2);
       const fs = require("node:fs");
       if (fs.realpathSync(process.cwd()) !== fs.realpathSync(${JSON.stringify(oracleDir)})) { console.error("wrong cwd " + process.cwd()); process.exit(9); }
       if (a.join(" ") === "run oracle --help") { console.log("usage: oracle {eval,diff,golden,gen}"); process.exit(0); }
       if (a[0] === "run" && a[1] === "oracle" && a[2] === "eval") { process.stdout.write(${JSON.stringify(JSON.stringify(errorReport))}); process.exit(1); }
       process.exit(2);`,
    );
    const e = new OracleEngine({ oracleDir, uv });
    expect((await e.availability()).available).toBe(true);
    expect((await e.evaluate(washerIr)).status).toBe("error");
  });
});

describe("FixtureEngine", () => {
  it("replays recorded reports by IR content and rejects unknown documents", async () => {
    const r = await fixtureEngine().evaluate(washerIr);
    expect(r.status).toBe("ok");
    const other: IrDocument = { ...washerIr, meta: { name: "something else" } };
    await expect(fixtureEngine().evaluate(other)).rejects.toMatchObject({ code: "FIXTURE_MISSING" });
  });

  it("ignores part and feature ids (they never reach a report) but not curve ids", async () => {
    const renamed = structuredClone(washerIr);
    renamed.parts[0]!.id = "p1";
    for (const [i, f] of renamed.parts[0]!.features.entries()) f.id = `feature${i}`;
    expect((await fixtureEngine().evaluate(renamed)).status).toBe("ok");
    const curveRenamed = structuredClone(washerIr);
    const sketch = curveRenamed.parts[0]!.features[0]!;
    if (sketch.type === "sketch") sketch.curves[0]!.id = "outer";
    await expect(fixtureEngine().evaluate(curveRenamed)).rejects.toMatchObject({ code: "FIXTURE_MISSING" });
  });

  it("is unavailable without fixtures", async () => {
    expect((await new FixtureEngine(join(dir, "empty")).availability()).available).toBe(false);
    expect((await new FixtureEngine([]).availability()).available).toBe(false);
  });

  it("hands out copies, so callers cannot corrupt the fixtures", async () => {
    const a = await fixtureEngine().evaluate(washerIr);
    a.features.length = 0;
    expect((await fixtureEngine().evaluate(washerIr)).features.length).toBeGreaterThan(0);
  });
});

describe("pipeline failure categories", () => {
  const stub = (evaluate: Engine["evaluate"]): Engine => ({
    kind: "stub",
    availability: () => Promise.resolve({ available: true, detail: "stub" }),
    evaluate,
  });
  const ok = stub(() => fixtureEngine().evaluate(washerIr));

  it("solver: the solver throws", async () => {
    const r = await runTask(washer, solverFromFunction("boom", () => Promise.reject(new Error("rate limited"))), ok);
    expect(r).toMatchObject({ pass: false, category: "solver", error: { message: "rate limited" }, score: 0 });
    expect(r.tests).toHaveLength(washer.hidden_tests.length);
    expect(r.tests.every((t) => !t.pass && t.message === "not run: the solver stage failed")).toBe(true);
  });

  it("compile: the CadScript does not compile (diagnostics are kept)", async () => {
    const src = washer.referenceSource.replace("radius: 1.6", "radius: 1.6 * 2");
    const r = await runTask(washer, solverFromFunction("bad", () => Promise.resolve({ cadscript: src, costUsd: 0.12, latencyMs: 900 })), ok);
    expect(r).toMatchObject({ category: "compile", cost_usd: 0.12, latency_ms: 900, valid: false });
    expect(r.compile_diagnostics?.[0]).toMatchObject({ code: "CS_EXPR_UNSUPPORTED", line: expect.any(Number) });
  });

  it("kernel: the engine fails, or reports status error", async () => {
    const crash = stub(() => Promise.reject(new EngineError("ENGINE_FAILED", "segfault")));
    const r1 = await runTask(washer, new ReferenceSolver(tasks), crash);
    expect(r1).toMatchObject({ category: "kernel", error: { code: "ENGINE_FAILED" } });
    const failing = stub(() =>
      Promise.resolve({
        ...simpleReport([]),
        status: "error" as const,
        features: [{ part: "washer", feature: "outline", type: "sketch", status: "error" as const, error: { code: "SKETCH_CURVES_CROSS", message: "x" } }],
      }),
    );
    const r2 = await runTask(washer, new ReferenceSolver(tasks), failing);
    expect(r2).toMatchObject({ category: "kernel", report_status: "error", feature_errors: [{ code: "SKETCH_CURVES_CROSS" }] });
    expect(r2.tests.length).toBe(washer.hidden_tests.length);
  });

  it("tests: evaluates fine but a hidden test fails", async () => {
    const r = await runTask(washer, new ReferenceSolver(tasks), stub(() => Promise.resolve(simpleReport([body()]))));
    expect(r.category).toBe("tests");
    expect(r.valid).toBe(true);
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(1);
  });

  it("harness: the T4 context cannot be evaluated", async () => {
    const t4 = tasks.find((t) => t.id === "t4-plate-thicker")!;
    let calls = 0;
    const flaky = stub(async (ir, o) => {
      calls++;
      if (o?.name?.endsWith(".context")) throw new EngineError("ENGINE_FAILED", "context crashed");
      return fixtureEngine().evaluate(ir);
    });
    const r = await runTask(t4, new ReferenceSolver(tasks), flaky);
    expect(r).toMatchObject({ category: "harness", error: { message: "context crashed" } });
    expect(calls).toBe(2);
  });
});
