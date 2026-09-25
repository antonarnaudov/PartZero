/**
 * Loading the Forge WASM module, and the stateless engine functions.
 */
import initWasm, * as raw from "../pkg/forge_wasm.js";
import type {
  AcceptRefCandidateOptions,
  AnyEvalReport,
  AcceptRefCandidateResult,
  AcceptRefProposalResult,
  CaptureRefResult,
  EditResult,
  EvaluateOptions,
  EvaluateResult,
  ExportOptions,
  ForgeError,
  InitInput,
  IrInput,
  MeshFormat,
  MigrateResult,
  ParamReport,
  ParamValueInput,
  RenameCurveResult,
  RenameFeatureResult,
  SetParamResult,
  StepExportOptions,
  UpgradeFeatureResult,
  WriteBackOptions,
  WriteBackResult,
} from "./types.js";

let ready: Promise<WebAssembly.Module> | null = null;
let compiled: WebAssembly.Module | null = null;

async function compile(input: InitInput | undefined): Promise<WebAssembly.Module> {
  if (input instanceof WebAssembly.Module) return input;
  let source: InitInput = input ?? new URL("../pkg/forge_wasm_bg.wasm", import.meta.url);
  if (typeof source === "string" || source instanceof URL) {
    source = await fetch(source);
  } else if (typeof Request !== "undefined" && source instanceof Request) {
    source = await fetch(source);
  }
  if (typeof Response !== "undefined" && source instanceof Response) {
    if (!source.ok) {
      throw forgeError("FORGE_WASM_FETCH", `cannot fetch the Forge wasm: ${source.status} ${source.statusText} (${source.url})`);
    }
    const type = source.headers.get("Content-Type") ?? "";
    if (typeof WebAssembly.compileStreaming === "function" && type.startsWith("application/wasm")) {
      return WebAssembly.compileStreaming(source);
    }
    return WebAssembly.compile(await source.arrayBuffer());
  }
  return WebAssembly.compile(source as BufferSource);
}

/**
 * Load and instantiate the Forge WASM module (idempotent; later calls return the same
 * promise). By default the `.wasm` next to the JS glue is fetched; pass a URL, bytes or a
 * compiled `WebAssembly.Module` to override (e.g. in Node, or to share one compilation
 * with a worker — see {@link wasmModule}).
 */
export function init(input?: InitInput): Promise<void> {
  ready ??= (async () => {
    const module = await compile(input);
    await initWasm({ module_or_path: module });
    compiled = module;
    return module;
  })();
  return ready.then(() => undefined);
}

/** The compiled module once {@link init} resolved (post it to workers to skip recompiling). */
export function wasmModule(): WebAssembly.Module | null {
  return compiled;
}

function assertReady(): void {
  if (!compiled) throw forgeError("FORGE_NOT_INITIALIZED", "call `await init()` before using @aicad/forge-web");
}

export function forgeError(code: string, message: string, details?: Record<string, unknown>): ForgeError {
  const e = new Error(message) as ForgeError;
  e.code = code;
  if (details) e.details = details;
  return e;
}

/**
 * An optional integer argument of a command-layer edit, checked before it reaches the WASM
 * export (which also checks it): `undefined` or a safe integer in `[min, 2^32 − 1]`; anything
 * else (1.5, -1, 2^32 + 1, NaN, a string) is `COMMAND_INVALID_ARGUMENT` with
 * `{ argument, reason }`, never silently truncated.
 */
function intArgument(value: unknown, argument: string, min: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= 0xffff_ffff) return value;
  const reason = `an integer from ${min} to ${0xffff_ffff}`;
  throw forgeError("COMMAND_INVALID_ARGUMENT", `invalid argument ${argument}: ${reason}`, { argument, reason });
}

export function irText(ir: IrInput): string {
  return typeof ir === "string" ? ir : JSON.stringify(ir);
}

/**
 * Evaluate an IR document (forge-regen) and tessellate every body for rendering
 * (`forge_mesh::tessellate_render`: per-face vertices, exact normals, face ranges and edge
 * polylines named by provenance). Synchronous; use {@link createEvaluator} to run it in a
 * worker. Throws a {@link ForgeError} only for invalid options (`MESH_INVALID_PARAMS`,
 * `REPORT_VERSION`). `reportVersion: "v1"` gives a v0 document the `aicad.metrics/1` report.
 */
export function evaluate(ir: IrInput, options: EvaluateOptions = {}): EvaluateResult {
  assertReady();
  return raw.evaluate(
    irText(ir),
    options.chordalDeflection,
    options.angularDeflection,
    options.reportVersion,
  ) as EvaluateResult;
}

/**
 * The metrics report of {@link evaluate} without tessellating anything — cheaper when only the
 * report is needed (the command layer reads references, their probes and repair candidates from
 * it, SPEC-v1 §5.8). Same `reportVersion` rules; throws only `REPORT_VERSION`.
 */
export function report(ir: IrInput, options: Pick<EvaluateOptions, "reportVersion"> = {}): AnyEvalReport {
  assertReady();
  return raw.report(irText(ir), options.reportVersion) as AnyEvalReport;
}

/**
 * `migrate_v0_to_v1` (SPEC-v1 §9.1): the canonical `aicad.ir/1` text of a v0 document and the
 * ids it rewrote; a v1 document is returned unchanged, in canonical form. Throws a
 * {@link ForgeError} with `errors` for a rejected document (v0 documents keep their v0 codes).
 */
export function migrate(ir: IrInput): MigrateResult {
  assertReady();
  return raw.migrate(irText(ir)) as MigrateResult;
}

/**
 * The document of record a DocStore stores (SPEC-v1 §0.4, §2.4): {@link migrate}, then every
 * expression in its canonical form (`"8"` → `8`, `"width/10"` → `"width / 10"`). Throws a
 * {@link ForgeError} with `errors` for a rejected document — also when only its canonical form
 * would be rejected ([W0-20], each problem at its site's path); it never returns non-canonical
 * text instead.
 */
export function canonicalize(ir: IrInput): MigrateResult {
  assertReady();
  return raw.canonicalize(irText(ir)) as MigrateResult;
}

/**
 * The `params` block of the document's `aicad.metrics/1` report — every parameter's value or
 * failure — without evaluating any feature (cheap enough for parameter chips on every edit).
 * Throws a {@link ForgeError} with `errors` for a rejected document.
 */
export function params(ir: IrInput): ParamReport[] {
  assertReady();
  return raw.params(irText(ir)) as ParamReport[];
}

/**
 * `writeBackSolution` (SPEC-v1 §0.6, §4.4 rule 9): the document with the solved geometry of each
 * constrained sketch (or of `options.sketches`) stored, as canonical `aicad.ir/1` text, repeated
 * to its fixed point (a solve that welds ends moves the geometry again on the next pass,
 * [W0-31]). The command layer applies it as an ordinary undoable edit; it is idempotent. It never
 * makes the model fail: a sketch whose written-back solution would fail it is withheld (`skipped`,
 * reason `would-fail`). Throws a {@link ForgeError} for a rejected document, an unknown sketch id
 * (`WRITE_BACK_UNKNOWN_SKETCH`) or a write-back without a fixed point or that would fail a feature
 * (`COMMAND_NOT_EXACT`).
 */
export function writeBack(ir: IrInput, options: WriteBackOptions = {}): WriteBackResult {
  assertReady();
  return raw.writeBack(irText(ir), options.sketches) as WriteBackResult;
}

// ─── Command layer (SPEC-v1 §0.6, §5.9, §9.2; interface I7) ──────────────────────────────────
//
// Each edit takes a document of either version and returns the edited document as canonical
// `aicad.ir/1` text, verified by evaluation (a write that fails its check throws
// `COMMAND_NOT_EXACT` and is never returned). Nothing is stored: the command layer records the
// edit and its inverse as one undoable transaction. Errors are {@link ForgeError}s: the
// document's rejection (`code` and `errors`, e.g. `EXPR_UNIT_MISMATCH` at its path) or a
// `COMMAND_*` refusal with `details` (see forge-wasm's `commands` module for the table).

/**
 * `setParam` (SPEC-v1 §2.1): set a parameter's value to a literal or an expression, stored in
 * canonical form (§2.4: `"8"` → `8`, `"w/2"` → `"w / 2"`). Refused with the document's
 * rejection when the edit (or its canonical form) would not load.
 */
export function setParam(ir: IrInput, name: string, value: ParamValueInput): EditResult<SetParamResult> {
  assertReady();
  return raw.setParam(irText(ir), name, JSON.stringify(value)) as EditResult<SetParamResult>;
}

/** `renameFeature` (SPEC-v1 §5.9): the feature's name only (references use ids). */
export function renameFeature(ir: IrInput, featureId: string, name: string): EditResult<RenameFeatureResult> {
  assertReady();
  return raw.renameFeature(irText(ir), featureId, name) as EditResult<RenameFeatureResult>;
}

/**
 * `upgradeFeature` (SPEC-v1 §9.2): set the feature's behavior version `v` (default: the newest
 * the contract defines) and return the report diff it causes, for review before it is applied.
 */
export function upgradeFeature(ir: IrInput, featureId: string, to?: number): EditResult<UpgradeFeatureResult> {
  assertReady();
  return raw.upgradeFeature(irText(ir), featureId, intArgument(to, "to", 1)) as EditResult<UpgradeFeatureResult>;
}

/**
 * `captureRef` (SPEC-v1 §0.6, §5.6): store the capture of a reference's current resolution.
 * `field` is the Ref's JSON pointer relative to the feature (the report's `refs[].field`, e.g.
 * `/target`, `/plane/face`). Idempotent. The capture records exactly the members the reference
 * resolves now. Refused for a failing reference (`COMMAND_REF_FAILED`, whose `details` are the
 * reference's report entry: `code`, `members`, `unresolved` with candidates — the arguments of
 * {@link acceptRefCandidate}), for a member found only by the geometric fallback
 * (`COMMAND_REF_REPAIRED`: use {@link acceptRefProposal}), and when the capture would change the
 * members (`COMMAND_NOT_EXACT`).
 */
export function captureRef(ir: IrInput, featureId: string, field: string): EditResult<CaptureRefResult> {
  assertReady();
  return raw.captureRef(irText(ir), featureId, field) as EditResult<CaptureRefResult>;
}

/** `acceptRefProposal` (SPEC-v1 §5.8–§5.9): apply the reference's `proposal` (query and fresh capture). */
export function acceptRefProposal(ir: IrInput, featureId: string, field: string): EditResult<AcceptRefProposalResult> {
  assertReady();
  return raw.acceptRefProposal(irText(ir), featureId, field) as EditResult<AcceptRefProposalResult>;
}

/**
 * `acceptRefCandidate` (SPEC-v1 §5.9): replace the reference's query by a candidate's `query`
 * (from the reference's `unresolved[memberKey].candidates`) and refresh its capture. Pass
 * `candidateIndex` or `probe` when several candidates share the key (split pieces), and `probe`
 * whenever the document may have changed since the report was read (a candidate that is no
 * longer that entity is refused with `COMMAND_CANDIDATE_CHANGED`).
 */
export function acceptRefCandidate(
  ir: IrInput,
  featureId: string,
  field: string,
  memberKey: string,
  candidateKey: string,
  options: AcceptRefCandidateOptions = {},
): EditResult<AcceptRefCandidateResult> {
  assertReady();
  const index = intArgument(options.candidateIndex, "candidateIndex", 0);
  return raw.acceptRefCandidate(
    irText(ir),
    featureId,
    field,
    memberKey,
    candidateKey,
    index,
    options.probe === undefined ? undefined : JSON.stringify(options.probe),
  ) as EditResult<AcceptRefCandidateResult>;
}

/**
 * `renameCurve` (SPEC-v1 §5.9): rename a sketch curve and, in the same edit, every query,
 * region, hole point, constraint argument and capture key naming it. Verified: the report is the
 * same up to the rename — every resolved reference as before, exactly (renames resolve exactly,
 * never through a geometric match), float metrics within SPEC-v1 §8.2's tolerances. Rewritten
 * captures of references the engine does not resolve are listed in `result.unverified`.
 */
export function renameCurve(ir: IrInput, sketchId: string, oldId: string, newId: string): EditResult<RenameCurveResult> {
  assertReady();
  return raw.renameCurve(irText(ir), sketchId, oldId, newId) as EditResult<RenameCurveResult>;
}

/**
 * Evaluate, tessellate (watertight) and encode all bodies as 3MF, binary STL or OBJ
 * (forge-io), like `aicad export`. Throws a {@link ForgeError} (e.g. a feature error unless
 * `allowPartial`, `EXPORT_NO_BODIES`, `EXPORT_FORMAT`).
 */
export function exportMesh(ir: IrInput, format: MeshFormat, options: ExportOptions = {}): Uint8Array {
  assertReady();
  return raw.exportMesh(
    irText(ir),
    format,
    options.chordalDeflection,
    options.angularDeflection,
    options.allowPartial ?? false,
  );
}

/**
 * Evaluate and write every final body as STEP with forge-io's own AP214/AP242 B-rep writer,
 * exactly as `aicad export --format step` (same body names, same bytes). Throws a
 * {@link ForgeError} (a feature error unless `allowPartial`, `EXPORT_NO_BODIES`, the writer's
 * `STEP_*` refusals, `STEP_INVALID_OPTIONS`).
 */
export function exportStep(ir: IrInput, options: StepExportOptions = {}): Uint8Array {
  assertReady();
  return raw.exportStep(irText(ir), JSON.stringify(options));
}

/** The engine identifier (`forge <version>`), as written into reports. */
export function engineVersion(): string {
  assertReady();
  return raw.engineVersion();
}

/** Typed arrays of a result, for zero-copy `postMessage` transfer. */
export function transferables(result: EvaluateResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of result.bodies) {
    out.push(b.positions.buffer as ArrayBuffer, b.normals.buffer as ArrayBuffer, b.indices.buffer as ArrayBuffer);
    for (const e of b.edges) out.push(e.points.buffer as ArrayBuffer);
  }
  return out;
}
