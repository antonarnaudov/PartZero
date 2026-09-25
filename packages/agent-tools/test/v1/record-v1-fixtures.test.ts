/**
 * Re-record the engine reports the v1 offline tests replay:
 *
 *   AICAD_RECORD_FIXTURES=forge-v1 pnpm --filter @aicad/agent-tools exec vitest run test/v1/record-v1-fixtures.test.ts
 *   AICAD_RECORD_FIXTURES=oracle-v1 pnpm --filter @aicad/agent-tools exec vitest run test/v1/record-v1-fixtures.test.ts
 *   AICAD_RECORD_FIXTURES=check-forge-v1 …   (compare with the current Forge binary; writes nothing)
 *   AICAD_RECORD_FIXTURES=check-oracle-v1 …  (compare with the current oracle; writes nothing)
 *
 * `check-forge-v1` also checks the tool and agent fixtures (`v1-tools.json`, the agent's
 * `v1-agent.json`), which store IR hashes and not the IR: run their test files in that mode and
 * they evaluate on Forge, failing where a recorded report no longer matches (`FixtureCheckEngineV1`):
 *
 *   AICAD_RECORD_FIXTURES=check-forge-v1 pnpm --filter @aicad/agent-tools exec vitest run test/v1
 *   AICAD_RECORD_FIXTURES=check-forge-v1 pnpm --filter @aicad/agent exec vitest run test/v1-agent.test.ts
 *
 * Forge (needs `forge/target/debug/aicad`: `cargo build -p forge-cli` in forge/), five sources:
 * - `scenarios`: the CadScript v1 scenarios of `scenarios.ts`, compiled and evaluated;
 * - `programs`: the oracle programs of `oracle-programs.ts` (holes, blends, shells, drafts,
 *   patterns, captures), the same documents the oracle evaluates — with `roundtrips` for the
 *   feasible-value codes, as for the oracle;
 * - `invalid`: the first conformance document (`corpus/v1/conformance/invalid/documents.json`) per
 *   rejection code, evaluated raw (Forge's rejection report carries every rejection's `details`);
 * - `refs_golden`: the forge-refs golden reports (`forge/crates/forge-refs/tests/golden/refs_reports.json`),
 *   copied as they are;
 * - `capabilities`: what the capability probe (`probeEngineCapabilitiesV1`) learns from Forge.
 * Other workstreams keep teaching Forge operations: re-record after they land (the offline suite
 * never runs Forge, so it cannot notice by itself).
 *
 * The OCCT oracle (`oracle/.venv/bin/oracle` when it exists, else `uv run oracle`; set
 * AICAD_ORACLE_BIN to override), three sources and one derived set:
 * - `programs`: `oracle-programs.ts`, for the codes Forge does not raise (holes, blends, shells,
 *   drafts, patterns, captures);
 * - `scenarios`: the same Forge scenarios (cross-engine detail shapes);
 * - `invalid`: the first conformance document per rejection code the oracle raises;
 * - `roundtrips`: for each program of a feasible-value code (too-large fillet, chamfer, shell), the
 *   value the hint proposes applied to the program and evaluated again — the offline tests require
 *   it to evaluate ok, so an engine that stops keeping SPEC §6.6's safe-to-apply promise fails a
 *   test on the next recording instead of being locked into the expectations.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { v1 as cs } from "@aicad/cadscript";
import { probeEngineCapabilitiesV1 } from "../../src/v1/capabilities.js";
import { canonicalJson, EngineError, runProcess } from "@aicad/evals";
import { comparableReportV1, FixtureCheckEngineV1, ForgeCliEngineV1, forgeCliEnvV1, irHashV1, OracleCliEngineV1, reportFromProcessV1, ScriptedEngineV1, type EngineV1, type FixtureEntryV1, type IrDocumentV1, type ReportV1 } from "../../src/v1/engine.js";
import { FEASIBLE_REPAIR_CODES_V1, feasibleRepairV1 } from "../../src/v1/playbooks.js";
import { applyFeasibleRepair, feasibleContext, V1_FIXTURE_FILE, V1_FIXTURE_SCHEMA, V1_ORACLE_FIXTURE_FILE, V1_ORACLE_FIXTURE_SCHEMA, type RoundTripEntry, type V1FixtureFile, type V1OracleFixtureFile } from "./fixtures.js";
import { FORGE_PROBES, forgeProbeSource } from "./forge-probes.js";
import { ORACLE_PROGRAMS, oracleProgramSource } from "./oracle-programs.js";
import { V1_SCENARIOS } from "./scenarios.js";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/**
 * Every oracle program on `engine` (labels `<prefix>:<label>`), with the feasible-value round trip of
 * each program whose target is such a code: the value the hint proposes, applied and evaluated again.
 */
async function recordPrograms(engine: EngineV1, prefix: "forge" | "oracle"): Promise<{ programs: (V1FixtureFile["programs"][number])[]; roundtrips: RoundTripEntry[]; engines: Set<string> }> {
  const programs: V1FixtureFile["programs"] = [];
  const roundtrips: RoundTripEntry[] = [];
  const engines = new Set<string>();
  for (const [label, program] of Object.entries(ORACLE_PROGRAMS)) {
    const r = cs.compile(oracleProgramSource(label));
    if (!r.ok || !r.ir) throw new Error(`${label} does not compile: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
    const doc: IrDocumentV1 = structuredClone(r.ir);
    program.patch?.(doc);
    const report = await engine.evaluate(doc, { name: label });
    engines.add(report.engine);
    programs.push({ label: `${prefix}:${label}`, target: program.target, ir_sha256: irHashV1(doc), ir: doc, report });
    if (FEASIBLE_REPAIR_CODES_V1.includes(program.target)) {
      const ctx = feasibleContext(report, doc, program.target);
      const repair = ctx && feasibleRepairV1(program.target, ctx);
      if (repair) {
        const fixed = applyFeasibleRepair(doc, repair);
        const after = await engine.evaluate(fixed, { name: `${label}-roundtrip` });
        roundtrips.push({ label: `roundtrip:${prefix}:${label}`, from: `${prefix}:${label}`, code: program.target, repair, ir_sha256: irHashV1(fixed), ir: fixed, report: after });
      }
    }
  }
  return { programs, roundtrips, engines };
}

/** Everything the Forge fixture file holds, evaluated now by `engine`. */
async function forgeRecording(engine: ForgeCliEngineV1): Promise<V1FixtureFile> {
  const out: V1FixtureFile = { schema: V1_FIXTURE_SCHEMA, engine: "", scenarios: [], programs: [], roundtrips: [], invalid: [], refs_golden: [] };
  const recorded = await recordPrograms(engine, "forge");
  out.programs = recorded.programs;
  out.roundtrips = recorded.roundtrips;
  const engines = new Set<string>(recorded.engines);
  for (const [label, source] of Object.entries(V1_SCENARIOS)) {
    const r = cs.compile(source);
    if (!r.ok || !r.ir) throw new Error(`${label} does not compile: ${r.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ")}`);
    const report = await engine.evaluate(r.ir, { name: label });
    engines.add(report.engine);
    out.scenarios.push({ label, ir_sha256: irHashV1(r.ir), ir: r.ir, report });
  }
  // Rejections: evaluate the raw JSON exactly as written (it is invalid on purpose).
  const invalid = JSON.parse(readFileSync(join(REPO, "corpus/v1/conformance/invalid/documents.json"), "utf8")) as { cases: { id: string; document: unknown; expected?: { code: string }[] }[] };
  const seen = new Set<string>();
  const dir = mkdtempSync(join(tmpdir(), "aicad-v1-invalid-"));
  try {
    for (const c of invalid.cases) {
      const codes = (c.expected ?? []).map((e) => e.code).filter((code) => !seen.has(code));
      if (codes.length === 0) continue;
      const path = join(dir, "doc.json");
      writeFileSync(path, JSON.stringify(c.document));
      const p = await runProcess(engine.bin, ["eval", path, "--format", "json"], { timeoutMs: 60_000, env: forgeCliEnvV1() });
      const report = reportFromProcessV1("aicad eval", p, 60_000);
      const errors = ((report.error?.details ?? {})["errors"] as { code: string }[] | undefined) ?? [];
      for (const code of codes) if (errors.some((e) => e.code === code)) seen.add(code);
      out.invalid.push({ label: `invalid:${c.id}`, report });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  out.refs_golden = JSON.parse(readFileSync(join(REPO, "forge/crates/forge-refs/tests/golden/refs_reports.json"), "utf8")) as V1FixtureFile["refs_golden"];
  const capabilities = await probeEngineCapabilitiesV1(engine);
  if (capabilities) out.capabilities = capabilities;
  out.engine = [...engines].sort().join("; ");
  return out;
}

describe.skipIf(process.env["AICAD_RECORD_FIXTURES"] !== "forge-v1")("record v1 fixtures (Forge)", () => {
  it("records every scenario and oracle program (with round trips), one invalid document per rejection code, the forge-refs goldens and the capability probe", { timeout: 600_000 }, async () => {
    const engine = new ForgeCliEngineV1();
    expect((await engine.availability()).available).toBe(true);
    writeFileSync(V1_FIXTURE_FILE, JSON.stringify(await forgeRecording(engine), null, 1) + "\n");
  });
});

/**
 * `AICAD_RECORD_FIXTURES=check-forge-v1`: evaluate everything again on the current Forge binary and
 * list what no longer matches the recording, without writing it — the offline suite replays reports
 * and cannot notice that Forge moved on (a review found hole, fillet and shell recorded as
 * UNSUPPORTED_FEATURE_VERSION after Forge learned them). Run it in CI after `cargo build -p forge-cli`.
 */
describe.skipIf(process.env["AICAD_RECORD_FIXTURES"] !== "check-forge-v1")("check v1 fixtures (Forge)", () => {
  it("the recorded Forge reports are what the current Forge binary answers", { timeout: 600_000 }, async () => {
    const engine = new ForgeCliEngineV1();
    expect((await engine.availability()).available).toBe(true);
    const now = await forgeRecording(engine);
    const was = JSON.parse(readFileSync(V1_FIXTURE_FILE, "utf8")) as V1FixtureFile;
    const stale = [
      ...staleEntries("scenario", now.scenarios, was.scenarios),
      ...staleEntries("program", now.programs, was.programs ?? []),
      ...staleEntries("roundtrip", now.roundtrips, was.roundtrips ?? []),
      ...staleEntries("invalid", now.invalid, was.invalid),
    ];
    if (comparableReportV1(now.refs_golden) !== comparableReportV1(was.refs_golden)) stale.push("refs_golden");
    if (JSON.stringify(now.capabilities) !== JSON.stringify(was.capabilities)) stale.push("capabilities");
    stale.push(...(await forgeProbeDrift(engine)));
    expect(stale, "re-record with AICAD_RECORD_FIXTURES=forge-v1 and update the pinned expectations (forge-probes.ts by hand)").toEqual([]);
  });
});

/** The OCCT oracle engine: `oracle/.venv/bin/oracle` when it exists, else `uv run oracle` (AICAD_ORACLE_BIN overrides). */
function oracleEngine(): OracleCliEngineV1 {
  const venv = join(REPO, "oracle", ".venv", "bin", "oracle");
  const bin = process.env["AICAD_ORACLE_BIN"] ?? (existsSync(venv) ? venv : undefined);
  return new OracleCliEngineV1(bin ? { bin } : {});
}

/** Everything the oracle fixture file holds, evaluated now by `engine`. */
async function oracleRecording(engine: OracleCliEngineV1): Promise<V1OracleFixtureFile> {
  const recorded = await recordPrograms(engine, "oracle");
  const out: V1OracleFixtureFile = { schema: V1_ORACLE_FIXTURE_SCHEMA, engine: "", scenarios: [], programs: recorded.programs, invalid: [], roundtrips: recorded.roundtrips };
  const engines = new Set<string>(recorded.engines);
  for (const [label, source] of Object.entries(V1_SCENARIOS)) {
    const r = cs.compile(source);
    if (!r.ok || !r.ir) throw new Error(`${label} does not compile`);
    const report = await engine.evaluate(r.ir, { name: label });
    engines.add(report.engine);
    out.scenarios.push({ label, ir_sha256: irHashV1(r.ir), ir: r.ir, report });
  }
  const invalid = JSON.parse(readFileSync(join(REPO, "corpus/v1/conformance/invalid/documents.json"), "utf8")) as { cases: { id: string; document: unknown; expected?: { code: string }[] }[] };
  const seen = new Set<string>();
  for (const c of invalid.cases) {
    const codes = (c.expected ?? []).map((e) => e.code).filter((code) => !seen.has(code));
    if (codes.length === 0) continue;
    const report = await engine.evaluateText(JSON.stringify(c.document), { name: "doc" });
    const errors = ((report.error?.details ?? {})["errors"] as { code: string }[] | undefined) ?? [];
    const raised = codes.filter((code) => errors.some((e) => e.code === code) || report.features.some((f) => f.error?.code === code) || (report.params ?? []).some((p) => p.error?.code === code));
    for (const code of raised) seen.add(code);
    if (raised.length > 0) out.invalid.push({ label: `invalid:${c.id}`, report });
  }
  out.engine = [...engines].sort().join("; ");
  return out;
}

/**
 * Labels whose recorded report differs from `now`'s (and labels one side lacks). Messages are not
 * compared ({@link comparableReportV1}); a report that only rewords one is listed on stdout.
 */
function staleEntries(kind: string, now: readonly { label: string; report: unknown }[], was: readonly { label: string; report: unknown }[]): string[] {
  const out: string[] = [];
  const before = new Map(was.map((x) => [x.label, x.report] as const));
  const reworded: string[] = [];
  for (const x of now) {
    if (!before.has(x.label)) out.push(`${kind} ${x.label} (not recorded)`);
    else if (comparableReportV1(before.get(x.label)) !== comparableReportV1(x.report)) out.push(`${kind} ${x.label}`);
    else if (JSON.stringify(before.get(x.label)) !== JSON.stringify(x.report)) reworded.push(`${kind} ${x.label}`);
  }
  for (const label of before.keys()) if (!now.some((x) => x.label === label)) out.push(`${kind} ${label} (no longer recorded)`);
  if (reworded.length > 0) console.info(`messages reworded (not stale: hints never read them): ${reworded.join(", ")}`);
  return out;
}

/** The Forge probes (`forge-probes.ts`) whose codes or details differ from what Forge reports now. */
async function forgeProbeDrift(engine: EngineV1): Promise<string[]> {
  const out: string[] = [];
  for (const [label, probe] of Object.entries(FORGE_PROBES)) {
    const r = cs.compile(forgeProbeSource(label));
    if (!r.ok || !r.ir) {
      out.push(`probe ${label} (does not compile)`);
      continue;
    }
    const report = await engine.evaluate(r.ir, { name: label });
    const listed = new Set(probe.findings.map((f) => f.feature));
    const found = report.features
      .filter((f) => listed.has(f.feature))
      .flatMap((f) => [
        ...(f.error ? [{ feature: f.feature, code: f.error.code, severity: "error", details: f.error.details ?? {} }] : []),
        ...(f.warnings ?? []).map((w) => ({ feature: f.feature, code: w.code, severity: w.severity, details: w.details ?? {} })),
      ]);
    if (canonicalJson(found) !== canonicalJson(probe.findings)) out.push(`probe ${label}: Forge now reports ${oneLineJson(found)}`);
  }
  return out;
}

function oneLineJson(v: unknown): string {
  const t = JSON.stringify(v);
  return t.length > 400 ? `${t.slice(0, 400)}…` : t;
}

describe.skipIf(process.env["AICAD_RECORD_FIXTURES"] !== "oracle-v1")("record v1 fixtures (OCCT oracle)", () => {
  it("records every oracle program and scenario, and one invalid document per rejection code", { timeout: 1_800_000 }, async () => {
    const engine = oracleEngine();
    expect((await engine.availability()).available).toBe(true);
    writeFileSync(V1_ORACLE_FIXTURE_FILE, JSON.stringify(await oracleRecording(engine), null, 1) + "\n");
  });
});

/**
 * `AICAD_RECORD_FIXTURES=check-oracle-v1`: evaluate everything again on the current oracle and list
 * what no longer matches the recording, without writing it — the offline tests pin the Forge-vs-
 * oracle differences of that recording (SAME_INPUT_CODE_DIFFS, ORACLE_EXTRA_DETAILS,
 * ORACLE_MISSING_DETAILS, ORACLE_PENDING), and a review found them describing an oracle that had
 * moved on. Run it after oracle changes; re-record with `oracle-v1` and update those lists.
 */
describe.skipIf(process.env["AICAD_RECORD_FIXTURES"] !== "check-oracle-v1")("check v1 fixtures (OCCT oracle)", () => {
  it("the recorded oracle reports are what the current oracle answers", { timeout: 1_800_000 }, async () => {
    const engine = oracleEngine();
    expect((await engine.availability()).available).toBe(true);
    const now = await oracleRecording(engine);
    const was = JSON.parse(readFileSync(V1_ORACLE_FIXTURE_FILE, "utf8")) as V1OracleFixtureFile;
    const stale = [
      ...staleEntries("scenario", now.scenarios, was.scenarios),
      ...staleEntries("program", now.programs, was.programs),
      ...staleEntries("roundtrip", now.roundtrips, was.roundtrips),
      ...staleEntries("invalid", now.invalid, was.invalid),
    ];
    expect(stale, "re-record with AICAD_RECORD_FIXTURES=oracle-v1 and update the pinned oracle expectations in playbooks-v1.test.ts").toEqual([]);
  });
});

describe("FixtureCheckEngineV1 (the check modes' engine)", () => {
  it("returns the live report and lists unrecorded documents, changed reports, engine failures and unused entries", async () => {
    const doc = (w: number): IrDocumentV1 => cs.compile(`import { part, sketch, rect, extrude, XY } from "@aicad/std";\npart("p");\nconst s = sketch(XY, { o: rect({ center: [0, 0], w: ${w}, h: 10 }) });\nconst e = extrude(s, { distance: 5 });\n`).ir!;
    const live = (d: IrDocumentV1, name = "live"): ReportV1 => ({ schema: "aicad.metrics/1", engine: "live", document: name, status: "ok", features: d.parts[0]!.features.map((f) => ({ part: "p", feature: f.name, feature_id: f.id, type: f.type, status: "ok" as const })) });
    const inner = new ScriptedEngineV1((d, o) => {
      if ((d.parts[0]!.features[0] as unknown as { curves: { w: number }[] }).curves[0]!.w === 40) throw new EngineError("ENGINE_FAILED", "boom");
      return live(d, o.name);
    });
    const same = doc(10);
    const changed = doc(20);
    const failing = doc(40);
    const recorded: FixtureEntryV1[] = [
      { label: "same", ir_sha256: irHashV1(same), report: live(same, "other-name") },
      { label: "changed", ir_sha256: irHashV1(changed), report: { ...live(changed), status: "error" } },
      { label: "failing", ir_sha256: irHashV1(failing), report: live(failing) },
      { label: "unused", ir_sha256: "0".repeat(64), report: live(same) },
    ];
    const check = new FixtureCheckEngineV1(inner, recorded);
    expect((await check.evaluate(same, { name: "same" })).engine).toBe("live");
    expect((await check.evaluate(same, { name: "same" })).engine).toBe("live");
    await check.evaluate(changed, { name: "changed" });
    await expect(check.evaluate(failing, { name: "failing" })).rejects.toThrow("boom");
    await check.evaluate(doc(30), { name: "new" });
    expect(check.problems()).toEqual([
      `changed: the engine's report differs from the recording (${irHashV1(changed).slice(0, 12)})`,
      "failing: recorded, but the engine now fails on it (boom)",
      `new: not recorded (${irHashV1(doc(30)).slice(0, 12)})`,
      "unused: recorded, but nothing evaluates it now (000000000000)",
    ]);
  });

  it("a report that only rewords a message is not stale; one whose details change is (review: messages never feed a hint)", () => {
    const report = (message: string, max: number): ReportV1 => ({
      schema: "aicad.metrics/1",
      engine: "e",
      document: "a",
      status: "error",
      features: [{ part: "p", feature: "sh", feature_id: "f_sh", type: "shell", status: "error", error: { code: "SHELL_THICKNESS_TOO_LARGE", message, details: { thickness: 6, max_feasible_thickness: max, message: "nested" } }, warnings: [{ code: "W", severity: "warning", message, details: {} }] }],
    });
    expect(comparableReportV1(report("the wall collides", 4.999))).toBe(comparableReportV1({ ...report("… = 4.999 (an offset edge collapses or turns over)", 4.999), document: "b" }));
    expect(comparableReportV1(report("x", 4.999))).not.toBe(comparableReportV1(report("x", 4.998)));
    expect(comparableReportV1(report("x", 4.999))).not.toContain("the wall");
  });
});
