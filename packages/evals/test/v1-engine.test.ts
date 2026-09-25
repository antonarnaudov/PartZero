import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { metricsV1 } from "@aicad/ir-types";
import {
  EngineError,
  FIXTURE_SCHEMA_V1,
  FixtureEngine,
  ForgeCliEngine,
  irHashV1,
  killedByOs,
  ORACLE_SOLVE_REQUIRES_REPLAY,
  OracleEngine,
  type Engine,
  type FixtureFileV1,
} from "../src/engine.js";
import { writeFixture } from "../src/fixtures.js";
import { paramVariants, runSuite, runTask } from "../src/pipeline.js";
import { ReferenceSolver, solverFromFunction } from "../src/solver.js";
import { bodyV1, compileV1Ok, corpusTasksV1, featureV1, reportV1 } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "aicad-evals-v1-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeBin(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const posix = process.platform !== "win32";
const tasks = corpusTasksV1();
const knob = tasks.find((t) => t.id === "t1-knob-v1")!;
const knobDoc = compileV1Ok(knob.referenceSource);
const okReport = (engine: string): metricsV1.EvalReport => {
  const r = reportV1([featureV1({ type: "extrude", feature: "knob", feature_id: "f_knob" })], { bodies: [bodyV1()] });
  r.engine = engine;
  return r;
};

describe("ForgeCliEngine.evaluateV1", () => {
  it.skipIf(!posix)("writes canonical v1 JSON, runs `<bin> eval <file> --format json` and parses the aicad.metrics/1 report (exit 0, 1 or 2)", async () => {
    const report = okReport("forge test");
    const bin = fakeBin(
      "aicad-v1",
      `const [cmd, file, fmt, json] = process.argv.slice(2);
       const fs = require("node:fs");
       if (cmd !== "eval" || fmt !== "--format" || json !== "json") process.exit(3);
       const doc = JSON.parse(fs.readFileSync(file, "utf8"));
       if (doc.schema !== "aicad.ir/1") process.exit(3);
       const r = ${JSON.stringify(report)};
       r.document = doc.meta.name;
       process.stdout.write(JSON.stringify(r));
       process.exit(doc.meta.name === "knob" ? 2 : 0);`,
    );
    const r = await new ForgeCliEngine({ bin }).evaluateV1(knobDoc);
    expect(r).toMatchObject({ schema: "aicad.metrics/1", document: "knob" });
  });

  it.skipIf(!posix)("rejects a v0 report or garbage as ENGINE_BAD_OUTPUT", async () => {
    const v0 = fakeBin("aicad-v0", `console.log(JSON.stringify({ schema: "aicad.metrics/0", engine: "x", document: "d", status: "ok", features: [] }));`);
    await expect(new ForgeCliEngine({ bin: v0 }).evaluateV1(knobDoc)).rejects.toMatchObject({ code: "ENGINE_BAD_OUTPUT", message: expect.stringMatching(/aicad.metrics\/1/) });
    const garbage = fakeBin("aicad-garbage", `console.log("nope"); process.exit(2);`);
    await expect(new ForgeCliEngine({ bin: garbage }).evaluateV1(knobDoc)).rejects.toMatchObject({ code: "ENGINE_BAD_OUTPUT" });
  });

  it.skipIf(!posix)("runs a document killed by a signal once more and lists it; a second kill fails with the signal", async () => {
    // The first run kills itself (as the OS does under memory pressure); the second prints the report.
    const marker = join(dir, "killed-once");
    const flaky = fakeBin(
      "aicad-flaky",
      `const fs = require("node:fs");
       if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); process.kill(process.pid, "SIGKILL"); }
       process.stdout.write(${JSON.stringify(JSON.stringify(okReport("forge test")))});`,
    );
    const engine = new ForgeCliEngine({ bin: flaky });
    await expect(engine.evaluateV1(knobDoc, { name: "knob" })).resolves.toMatchObject({ schema: "aicad.metrics/1" });
    expect(engine.retried).toEqual(["knob: SIGKILL"]);
    const dead = new ForgeCliEngine({ bin: fakeBin("aicad-dead", `process.kill(process.pid, "SIGKILL");`) });
    await expect(dead.evaluateV1(knobDoc, { name: "knob" })).rejects.toMatchObject({ code: "ENGINE_FAILED", message: expect.stringMatching(/killed by SIGKILL, stdout is not a JSON report/) });
    expect(dead.retried).toEqual(["knob: SIGKILL"]);
    // A non-zero exit is an answer, not a kill: no retry.
    const crash = new ForgeCliEngine({ bin: fakeBin("aicad-exit", `process.exit(101);`) });
    await expect(crash.evaluateV1(knobDoc)).rejects.toMatchObject({ code: "ENGINE_FAILED", message: expect.stringMatching(/exit code 101/) });
    expect(crash.retried).toEqual([]);
  });

  it.skipIf(!posix)("never retries a crash: any signal but SIGKILL fails at once, even one that would not repeat", async () => {
    for (const signal of ["SIGSEGV", "SIGABRT", "SIGBUS"]) {
      // Crashes on the first run only: a retry would hide it behind a good second report.
      const marker = join(dir, `crashed-once-${signal}`);
      const flaky = fakeBin(
        `aicad-${signal}`,
        `const fs = require("node:fs");
         if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, ""); process.kill(process.pid, ${JSON.stringify(signal)}); }
         process.stdout.write(${JSON.stringify(JSON.stringify(okReport("forge test")))});`,
      );
      const engine = new ForgeCliEngine({ bin: flaky });
      await expect(engine.evaluateV1(knobDoc, { name: "knob" }), signal).rejects.toMatchObject({ code: "ENGINE_FAILED", message: expect.stringContaining(`killed by ${signal}`) });
      expect(engine.retried, signal).toEqual([]);
    }
  });

  it("retries only what the OS killed: SIGKILL that is not our timeout and not a failed spawn", () => {
    const base = { code: null, stdout: "", stderr: "", timedOut: false };
    expect(killedByOs({ ...base, signal: "SIGKILL" })).toBe(true);
    expect(killedByOs({ ...base, signal: "SIGKILL", timedOut: true })).toBe(false);
    expect(killedByOs({ ...base, signal: "SIGKILL", error: new Error("spawn failed") })).toBe(false);
    for (const signal of ["SIGSEGV", "SIGABRT", "SIGBUS", "SIGTERM", "SIGILL"] as const) expect(killedByOs({ ...base, signal }), signal).toBe(false);
    expect(killedByOs({ ...base, code: 0 })).toBe(false);
  });
});

describe("OracleEngine.evaluateV1", () => {
  /** A fake `uv`: standalone fails a constrained sketch with ORACLE_SOLVE_REQUIRES_REPLAY; with --replay it succeeds. */
  function fakeOracle(): { oracleDir: string; uv: string; calls: string } {
    const oracleDir = join(dir, "oracle");
    mkdirSync(oracleDir, { recursive: true });
    writeFileSync(join(oracleDir, "pyproject.toml"), "");
    const calls = join(dir, "oracle-calls.log");
    writeFileSync(calls, "");
    const standalone = reportV1([featureV1({ type: "sketch", feature: "s", feature_id: "f_s", status: "error", error: { code: ORACLE_SOLVE_REQUIRES_REPLAY, message: "replay" } })]);
    standalone.engine = "occt standalone";
    const replayed = okReport("occt replayed");
    const uv = fakeBin(
      "uv",
      `const args = process.argv.slice(2);
       const fs = require("node:fs");
       if (args[2] === "--help") { console.log("usage: oracle {eval,diff}"); process.exit(0); }
       const i = args.indexOf("--replay");
       fs.appendFileSync(${JSON.stringify(calls)}, (i >= 0 ? "replay:" + JSON.parse(fs.readFileSync(args[i + 1], "utf8")).engine : "standalone") + "\\n");
       const r = i >= 0 ? ${JSON.stringify(replayed)} : ${JSON.stringify(standalone)};
       process.stdout.write(JSON.stringify(r));
       process.exit(r.status === "ok" ? 0 : 1);`,
    );
    return { oracleDir, uv, calls };
  }

  it.skipIf(!posix)("replays the reference engine's report only when the oracle cannot solve a sketch alone", async () => {
    const { oracleDir, uv, calls } = fakeOracle();
    const reference: Engine = { kind: "stub", availability: () => Promise.resolve({ available: true, detail: "" }), evaluate: () => Promise.reject(new Error("v0")), evaluateV1: () => Promise.resolve(okReport("forge stub")) };
    const r = await new OracleEngine({ oracleDir, uv, replay: reference }).evaluateV1(knobDoc);
    expect(r.engine).toBe("occt replayed");
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["standalone", "replay:forge stub"]);
  });

  it.skipIf(!posix)("returns the standalone report when there is no replay engine", async () => {
    const { oracleDir, uv, calls } = fakeOracle();
    const r = await new OracleEngine({ oracleDir, uv }).evaluateV1(knobDoc);
    expect(r.features[0]!.error!.code).toBe(ORACLE_SOLVE_REQUIRES_REPLAY);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["standalone"]);
  });
});

describe("FixtureEngine with IR v1 fixtures", () => {
  const file: FixtureFileV1 = { schema: FIXTURE_SCHEMA_V1, task: knob.id, engine: "occt test", entries: [{ label: "reference", ir_sha256: irHashV1(knobDoc), report: okReport("occt test") }] };

  it("loads v0 and v1 fixture files side by side and keys v1 reports by the whole document", async () => {
    const e = new FixtureEngine([structuredClone(file)]);
    expect(e.size).toBe(1);
    expect((await e.evaluateV1(knobDoc)).engine).toBe("occt test");
    const renamed = structuredClone(knobDoc);
    renamed.parts[0]!.features[0]!.id = "f_other";
    await expect(e.evaluateV1(renamed)).rejects.toMatchObject({ code: "FIXTURE_MISSING" });
  });

  it("writes one compact line per v1 entry and reads it back", async () => {
    const out = join(dir, "fixtures-v1");
    const path = writeFixture(out, structuredClone(file));
    const text = readFileSync(path, "utf8");
    expect(text.split("\n")).toHaveLength(4);
    expect(JSON.parse(text)).toEqual(file);
    expect((await new FixtureEngine(out).evaluateV1(knobDoc)).engine).toBe("occt test");
  });

  it("rejects an unknown fixture schema", () => {
    expect(() => new FixtureEngine([{ ...structuredClone(file), schema: "nope" } as never])).toThrow(/schema must be/);
  });
});

describe("the IR v1 pipeline", () => {
  const scripted = (fn: (doc: ReturnType<typeof compileV1Ok>) => metricsV1.EvalReport): Engine => ({
    kind: "scripted",
    availability: () => Promise.resolve({ available: true, detail: "" }),
    evaluate: () => Promise.reject(new EngineError("ENGINE_FAILED", "v0 not expected")),
    evaluateV1: (doc) => Promise.resolve(fn(doc)),
  });

  it("compiles v1 tasks with CadScript v1 (a compile error is the compile stage)", async () => {
    const r = await runTask(knob, solverFromFunction("broken", () => Promise.resolve({ cadscript: "part(1);" })), scripted(() => okReport("x")));
    expect(r).toMatchObject({ pass: false, category: "compile" });
    expect(r.compile_diagnostics!.length).toBeGreaterThan(0);
  });

  it("skips v1 tasks on engines that do not evaluate IR v1", async () => {
    const v0only: Engine = { kind: "v0", availability: () => Promise.resolve({ available: true, detail: "" }), evaluate: () => Promise.reject(new Error("no")) };
    const result = await runSuite([knob], { solver: new ReferenceSolver([knob]), engine: v0only });
    expect(result.skipped).toEqual([{ id: knob.id, reason: "engine v0 does not evaluate IR v1" }]);
  });

  it("reports feature and parameter errors of a v1 report", async () => {
    const failing = scripted(() => {
      const r = reportV1([featureV1({ type: "fillet", feature: "f", feature_id: "f_f", status: "error", error: { code: "FILLET_RADIUS_TOO_LARGE", message: "max 3.41" } })], {
        params: [{ name: "w", scope: "doc", unit: "mm", error: { code: "EXPR_DOMAIN", message: "division by zero" } }],
      });
      return r;
    });
    const r = await runTask(knob, new ReferenceSolver([knob]), failing);
    expect(r.category).toBe("kernel");
    expect(r.feature_errors).toEqual([
      { feature: "f", code: "FILLET_RADIUS_TOO_LARGE", message: "max 3.41" },
      { feature: "param w", code: "EXPR_DOMAIN", message: "division by zero" },
    ]);
  });

  it("evaluates each distinct param set once, and records a missing parameter as the variant's reason", async () => {
    const plate = tasks.find((t) => t.id === "t1-cbore-m4-plate")!;
    const doc = compileV1Ok(plate.referenceSource);
    const seen: unknown[] = [];
    const engine = scripted((d) => {
      seen.push(d.params!.find((p) => p.name === "thick")!.value);
      return okReport("x");
    });
    const tests = [
      ...plate.hidden_tests,
      { id: "again", description: "the same variant again", check: "param", set: { thick: 10 }, test: { check: "status", eq: "ok" } },
      { id: "nosuch", description: "a parameter the model lacks", check: "param", set: { nosuch: 1 }, test: { check: "status", eq: "ok" } },
    ] as typeof plate.hidden_tests;
    const variants = await paramVariants(doc, tests, engine, plate.id);
    expect(seen).toEqual([10]);
    expect([...variants.values()].map((v) => v.ok)).toEqual([true, false]);
    expect([...variants.values()][1]).toEqual({ ok: false, reason: "the model has no parameter named nosuch" });
  });
});
