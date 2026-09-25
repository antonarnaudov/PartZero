/**
 * The recorded v1 reports (see `record-v1-fixtures.test.ts`) and lookups over them: which report
 * raises a code, and in which feature, parameter or rejection entry.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { v1 as ir, metricsV1 } from "@aicad/ir-types";
import { setParamEdit } from "../../src/v1/edits.js";
import type { EngineCapabilitiesV1 } from "../../src/v1/capabilities.js";
import { FixtureEngineV1, type FixtureEntryV1 } from "../../src/v1/engine.js";
import type { FeasibleRepairV1, V1HintContext } from "../../src/v1/playbooks.js";

export const V1_FIXTURE_FILE = fileURLToPath(new URL("../fixtures/v1-forge-reports.json", import.meta.url));
export const V1_FIXTURE_SCHEMA = "aicad.agent-tools.v1-fixtures/0";

export interface RefsGoldenCase {
  name: string;
  report: metricsV1.RefReport;
  error: { code: string; message: string; details: Record<string, unknown> } | null;
  warnings: metricsV1.Warning[];
}

export interface V1FixtureFile {
  schema: typeof V1_FIXTURE_SCHEMA;
  /** The recording engines' identifiers. */
  engine: string;
  scenarios: (FixtureEntryV1 & { ir: ir.IrDocument })[];
  /**
   * `forge:<label>`: the programs of `oracle-programs.ts` on Forge — the same documents the oracle
   * evaluated (`oracle:<label>`), so the two engines' details for the hole, blend, shell, pattern
   * and capture codes are compared input by input.
   */
  programs: (FixtureEntryV1 & { ir: ir.IrDocument; target: string })[];
  /** `roundtrip:forge:<label>`: Forge's feasible-value round trips (see {@link V1OracleFixtureFile.roundtrips}). */
  roundtrips: RoundTripEntry[];
  /** `invalid:<conformance case id>` (the document is in corpus/v1/conformance/invalid/documents.json). */
  invalid: { label: string; report: metricsV1.EvalReport }[];
  refs_golden: RefsGoldenCase[];
  /** What the capability probe learned from Forge (`probeEngineCapabilitiesV1`). */
  capabilities?: EngineCapabilitiesV1;
}

export const V1_ORACLE_FIXTURE_FILE = fileURLToPath(new URL("../fixtures/v1-oracle-reports.json", import.meta.url));
export const V1_ORACLE_FIXTURE_SCHEMA = "aicad.agent-tools.v1-oracle-fixtures/1";

/** The OCCT oracle's reports of the same inputs (plus programs for the codes Forge does not raise). */
export interface V1OracleFixtureFile {
  schema: typeof V1_ORACLE_FIXTURE_SCHEMA;
  engine: string;
  /** The Forge scenarios (`scenarios.ts`), by label. */
  scenarios: (FixtureEntryV1 & { ir: ir.IrDocument })[];
  /** `oracle:<label>`: the programs of `oracle-programs.ts`, compiled (and patched). */
  programs: (FixtureEntryV1 & { ir: ir.IrDocument; target: string })[];
  /** `invalid:<conformance case id>`: the first conformance document per rejection code the oracle raises. */
  invalid: { label: string; report: metricsV1.EvalReport }[];
  /**
   * `roundtrip:<program label>`: for every program whose target is a feasible-value code
   * (FILLET_RADIUS_TOO_LARGE, CHAMFER_DISTANCE_TOO_LARGE, SHELL_THICKNESS_TOO_LARGE), the repair
   * the hint proposes on the recorded report ({@link feasibleRepairV1}), applied to the program
   * ({@link applyFeasibleRepair}) and evaluated by the same engine: SPEC-v1 §6.6's "rounded down …
   * so that a suggested value is safe to apply", checked on the engine that reported it.
   */
  roundtrips: RoundTripEntry[];
}

export interface RoundTripEntry {
  label: string;
  /** The program the repair was computed from (`oracle:<label>`). */
  from: string;
  code: string;
  repair: FeasibleRepairV1;
  ir_sha256: string;
  ir: ir.IrDocument;
  report: metricsV1.EvalReport;
}

/** The feature error of `code` in a report, as a hint context. */
export function feasibleContext(report: metricsV1.EvalReport, doc: ir.IrDocument, code: string): V1HintContext | undefined {
  const fe = report.features.find((f) => f.error?.code === code);
  return fe ? { details: fe.error!.details, feature: fe, report, ir: doc } : undefined;
}

/** A feasible-value repair applied as the agent would: `set_param` on the parameter, else the number written into the feature. */
export function applyFeasibleRepair(doc: ir.IrDocument, r: FeasibleRepairV1): ir.IrDocument {
  if (r.param !== undefined) return setParamEdit(doc, r.param, Number(r.value));
  const next = structuredClone(doc);
  const f = next.parts.flatMap((p) => p.features).find((x) => x.name === r.feature);
  if (!f) throw new Error(`no feature ${String(r.feature)}`);
  (f as unknown as Record<string, unknown>)[r.field] = Number(r.value);
  return next;
}

let cached: V1FixtureFile | undefined;
let cachedOracle: V1OracleFixtureFile | undefined;

export function v1Fixtures(): V1FixtureFile {
  if (!cached) {
    if (!existsSync(V1_FIXTURE_FILE)) throw new Error(`missing ${V1_FIXTURE_FILE}: record it with AICAD_RECORD_FIXTURES=forge-v1`);
    cached = JSON.parse(readFileSync(V1_FIXTURE_FILE, "utf8")) as V1FixtureFile;
  }
  return cached;
}

export function v1OracleFixtures(): V1OracleFixtureFile {
  if (!cachedOracle) {
    if (!existsSync(V1_ORACLE_FIXTURE_FILE)) throw new Error(`missing ${V1_ORACLE_FIXTURE_FILE}: record it with AICAD_RECORD_FIXTURES=oracle-v1`);
    cachedOracle = JSON.parse(readFileSync(V1_ORACLE_FIXTURE_FILE, "utf8")) as V1OracleFixtureFile;
  }
  return cachedOracle;
}

/** An offline engine over the recorded scenarios. */
export function v1FixtureEngine(): FixtureEngineV1 {
  return new FixtureEngineV1(v1Fixtures().scenarios);
}

/**
 * The same input to both engines: an oracle program is recorded as `oracle:<label>` and on Forge as
 * `forge:<label>`; scenarios and conformance documents carry the same label in both files.
 */
export function sameInput(label: string): string {
  return label.replace(/^(forge|oracle):/, "program:");
}

export function scenario(label: string): V1FixtureFile["scenarios"][number] {
  const s = v1Fixtures().scenarios.find((x) => x.label === label);
  if (!s) throw new Error(`no recorded scenario ${label}`);
  return s;
}

/** Where a code was raised in a recorded report. */
export interface Occurrence {
  source: "forge" | "forge-rejection" | "forge-refs-golden" | "oracle" | "oracle-rejection" | "spec";
  label: string;
  report: metricsV1.EvalReport | null;
  ir: ir.IrDocument | null;
  feature?: metricsV1.FeatureReport;
  param?: string;
  details: Record<string, unknown> | undefined;
  severity: "error" | "warning" | "info";
}

type Add = (code: string, o: Occurrence) => void;

/** Every parameter error, feature error, warning and rejection of one report. */
function reportOccurrences(add: Add, engine: "forge" | "oracle", label: string, r: metricsV1.EvalReport, doc: ir.IrDocument | null): void {
  for (const p of r.params ?? []) if (p.error) add(p.error.code, { source: engine, label, report: r, ir: doc, param: p.name, details: p.error.details, severity: "error" });
  for (const fe of r.features) {
    if (fe.error) add(fe.error.code, { source: engine, label, report: r, ir: doc, feature: fe, details: fe.error.details, severity: "error" });
    for (const w of fe.warnings ?? []) add(w.code, { source: engine, label, report: r, ir: doc, feature: fe, details: w.details, severity: w.severity });
  }
  for (const e of ((r.error?.details ?? {})["errors"] as { code: string; details?: Record<string, unknown> }[] | undefined) ?? []) {
    add(e.code, { source: `${engine}-rejection`, label, report: r, ir: doc, details: e.details, severity: "error" });
  }
}

/** Every occurrence of every code in the recorded oracle reports (scenarios, programs, rejections). */
export function oracleOccurrences(): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  const add: Add = (code, o) => out.set(code, [...(out.get(code) ?? []), o]);
  const f = v1OracleFixtures();
  for (const p of f.programs) reportOccurrences(add, "oracle", p.label, p.report, p.ir);
  for (const s of f.scenarios) reportOccurrences(add, "oracle", s.label, s.report, s.ir);
  for (const inv of f.invalid) reportOccurrences(add, "oracle", inv.label, inv.report, null);
  return out;
}

/** Every occurrence of every code in the recorded Forge reports. */
export function occurrences(): Map<string, Occurrence[]> {
  const out = new Map<string, Occurrence[]>();
  const add: Add = (code, o) => out.set(code, [...(out.get(code) ?? []), o]);
  const f = v1Fixtures();
  for (const s of f.scenarios) reportOccurrences(add, "forge", s.label, s.report, s.ir);
  for (const p of f.programs ?? []) reportOccurrences(add, "forge", p.label, p.report, p.ir);
  for (const inv of f.invalid) reportOccurrences(add, "forge", inv.label, inv.report, null);
  for (const g of f.refs_golden) {
    const feature: metricsV1.FeatureReport = {
      part: "p",
      feature: "consumer",
      feature_id: "f_consumer",
      type: "tag",
      status: g.error ? "error" : "ok",
      refs: [{ ...g.report, field: "/target" }],
      warnings: g.warnings.map((w) => ({ ...w, details: { ...(w.details ?? {}), ...("field" in (w.details ?? {}) ? { field: "/target" } : {}) } })),
      ...(g.error ? { error: { code: g.error.code, message: g.error.message, details: { ...g.error.details, ...("field" in g.error.details ? { field: "/target" } : {}) } } } : {}),
    };
    if (feature.error) add(feature.error.code, { source: "forge-refs-golden", label: `refs:${g.name}`, report: null, ir: null, feature, details: feature.error.details, severity: "error" });
    for (const w of feature.warnings ?? []) add(w.code, { source: "forge-refs-golden", label: `refs:${g.name}`, report: null, ir: null, feature, details: w.details, severity: w.severity });
  }
  return out;
}
