/**
 * The engine entry points of the IR v1 command layer (SPEC-v1 §0.6, §5.9, §9.2; interface I7):
 * everything an op needs Forge for. Implemented over `@aicad/forge-web`
 * ({@link forgeWebCommandEngine}: the app runs it in a worker through `ForgeWebEngine.commands`;
 * Node hosts call the module directly).
 *
 * Every edit takes a document of either IR version and returns the edited document as canonical
 * `aicad.ir/1` text, **verified by evaluation** before it is returned (forge-wasm's `commands`
 * module): a write that fails its check is refused with `COMMAND_NOT_EXACT`, never returned.
 * Nothing is stored engine-side; the store records each edit and its exact inverse.
 *
 * `canonicalize` is also the verifier of the catalogue's structural ops (`addFeature`,
 * `deleteFeature`, `moveFeature`, …, `ops.ts`): they edit the JSON and the engine's full v1
 * rejection pipeline decides whether the result is a document, with every problem at its path.
 *
 * The types are structural (not imported from `@aicad/forge-web`), so hosts compile whether or not
 * that package is built; {@link missingCommandMembers} checks a loaded module at runtime.
 */
import type { metricsV1, v1 } from "@aicad/ir-types";

/** A value `setParam` stores: a literal, or an expression (stored canonically). */
export type ParamValueInput = number | boolean | string;

/** The result of an engine edit. */
export interface EditResult<R> {
  /** Canonical `aicad.ir/1` text. */
  document: string;
  /** `false` when the edit changed nothing. */
  changed: boolean;
  result: R;
}

export interface SetParamResult {
  param: string;
  previous: ParamValueInput;
  value: ParamValueInput;
  params: metricsV1.ParamReport[];
}

export interface RenameFeatureResult {
  feature: string;
  previous: string;
  name: string;
}

export interface UpgradeFeatureResult {
  feature: string;
  type: string;
  from: number;
  to: number;
  /** Feature entries (by `feature_id`) and parts (by `part_id`) whose report changes. */
  diff: Array<{ feature_id?: string; part_id?: string; before: unknown; after: unknown }>;
}

export interface CaptureRefResult {
  feature: string;
  field: string;
  capture: v1.Capture;
  previous: v1.Capture | null;
  members: metricsV1.RefMember[];
}

export interface AcceptRefProposalResult {
  feature: string;
  field: string;
  ref: v1.Ref;
  previous: v1.Ref;
  code: string | null;
}

export interface AcceptRefCandidateResult {
  feature: string;
  field: string;
  ref: v1.Ref;
  previous: v1.Ref;
  candidate: metricsV1.Candidate;
}

export interface RenameCurveResult {
  sketch: string;
  old: string;
  new: string;
  rewritten: Record<string, number>;
  /**
   * Rewritten captures the engine could not check: references it did not resolve (`failed`: their
   * feature fails before resolving them, `code`; `not-reported`: a Ref nested in a direction).
   */
  unverified: Array<{ feature: string; field: string; reason: "failed" | "not-reported"; code?: string }>;
}

export interface WriteBackResult {
  /** The fixed point: writing back again changes nothing (SPEC-v1 §4.4 rule 9 [W0-31]). */
  document: string;
  /** `false` when the document was already at its fixed point. */
  changed: boolean;
  /** Sketches written by any pass, in document order. */
  written: string[];
  /**
   * Selected sketches not written: `explicit`, `suppressed`, `failed` (its evaluation fails with
   * `code`) or `would-fail` (its written-back solution would fail it with `code`, [W0-31]: withheld,
   * its stored geometry kept).
   */
  skipped: Array<{ sketch: string; reason: "explicit" | "suppressed" | "failed" | "would-fail"; code?: string }>;
  /** Passes run, the confirming one included (1: nothing changed; 3: a solve welded ends). */
  passes: number;
}

export interface MigrateResult {
  document: string;
  renames: metricsV1.IdRename[];
}

/** What the v1 command layer asks of an engine. */
export interface IrCommandEngine {
  /** `migrate_v0_to_v1` (§9.1): canonical `aicad.ir/1` text of either version. */
  migrate(ir: string): Promise<MigrateResult>;
  /**
   * The document of record (§0.4, §2.4): {@link IrCommandEngine.migrate} with every expression
   * stored canonically; refused (the rejection's code and `errors`) when the canonical form would
   * be rejected ([W0-20]).
   */
  canonicalize(ir: string): Promise<MigrateResult>;
  /** The report's `params` block (no feature evaluated). */
  params(ir: string): Promise<metricsV1.ParamReport[]>;
  /** The `aicad.metrics/1` report (references with members, probes, candidates, proposals). */
  report(ir: string): Promise<metricsV1.EvalReport>;
  /** `writeBackSolution` (§0.6, §4.4 rule 9), to its fixed point (idempotent). */
  writeBack(ir: string, sketches?: string[]): Promise<WriteBackResult>;
  setParam(ir: string, name: string, value: ParamValueInput): Promise<EditResult<SetParamResult>>;
  renameFeature(ir: string, featureId: string, name: string): Promise<EditResult<RenameFeatureResult>>;
  upgradeFeature(ir: string, featureId: string, to?: number): Promise<EditResult<UpgradeFeatureResult>>;
  captureRef(ir: string, featureId: string, field: string): Promise<EditResult<CaptureRefResult>>;
  acceptRefProposal(ir: string, featureId: string, field: string): Promise<EditResult<AcceptRefProposalResult>>;
  /**
   * `candidateIndex` picks one of several candidates sharing the key; `probe` (the candidate's
   * probe as read from the report) must still locate the chosen candidate, else
   * `COMMAND_CANDIDATE_CHANGED` — pass it whenever the document may differ from the one whose
   * report was read.
   */
  acceptRefCandidate(
    ir: string,
    featureId: string,
    field: string,
    memberKey: string,
    candidateKey: string,
    candidateIndex?: number,
    probe?: metricsV1.Probe,
  ): Promise<EditResult<AcceptRefCandidateResult>>;
  renameCurve(ir: string, sketchId: string, oldId: string, newId: string): Promise<EditResult<RenameCurveResult>>;
  /**
   * `refFor` (FULL-MODELING-PLAN §2.2 "Queries"): a Ref to picked entities, verified by Forge to
   * resolve to exactly them in the scope of a feature inserted into `part` after `after` (`null`:
   * at the end of the part), with a fresh capture. Nothing is written. Refusals:
   * `COMMAND_PICK_NOT_FOUND`, `COMMAND_PICK_AMBIGUOUS`, `COMMAND_REF_NO_QUERY`,
   * `COMMAND_REF_NOT_EXACT`, `COMMAND_UNKNOWN_PART`, `COMMAND_UNKNOWN_FEATURE`,
   * `COMMAND_INVALID_ARGUMENT` (`details.pick`: the failing pick), or `ENGINE_UNSUPPORTED` on a
   * forge-web build without it.
   */
  refFor(ir: string, part: string, after: string | null, request: RefForRequest): Promise<RefForResult>;
}

/** One picked entity (a face, edge or vertex by its render name or report key, a body by its origin). */
export interface RefPick {
  kind: "face" | "edge" | "vertex" | "body";
  /** Its provenance name as the render mesh has it (`e1/edge:{e1/cap:end|e1/side:r.top}`; `#k` for split pieces). */
  name?: string;
  /** Its provenance key as the report's members carry it. */
  key?: string;
  /** Where it was picked (mm): tells apart entities that share a name, and locates a vertex. */
  point?: [number, number, number];
  /** Its body's origin (the report's `parts[].bodies[].origin`): required to pick a body. */
  body?: { feature: string; member: string; instance?: number[] };
}

/** What `refFor` makes a Ref for: its kind (an `edge` Ref from faces takes their edges; a `body` Ref from faces or edges, their owner). */
export interface RefForRequest {
  kind: "face" | "edge" | "vertex" | "body";
  picks: RefPick[];
  /** The declared cardinality to write (default: the field's). */
  card?: "one" | "some" | "any" | number;
}

export interface RefForResult {
  /** The Ref: synthesized query and fresh capture. */
  ref: v1.Ref;
  /** What it resolves to, in canonical order. */
  members: Array<{ key: string; name: string; probe: metricsV1.Probe }>;
}

/** One problem of a rejected document (`{ code, path, message, details }`, SPEC-v1 §7.2). */
export interface RejectionProblem {
  code: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * A refused edit: the engine's `code` — an IR rejection code with every problem in `errors`
 * (e.g. `EXPR_UNIT_MISMATCH` at `/params/0/value`), or a `COMMAND_*` refusal with its context in
 * `details` — or `ENGINE_UNSUPPORTED` when the engine has no command layer.
 */
export class CommandEngineError extends Error {
  readonly code: string;
  readonly errors: RejectionProblem[];
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, errors: RejectionProblem[] = [], details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommandEngineError";
    this.code = code;
    this.errors = errors;
    this.details = details;
  }

  /** The error's machine-readable fields, for command results and the agent. */
  toJSON(): { code: string; message: string; errors: RejectionProblem[]; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, errors: this.errors, details: this.details };
  }
}

/** Convert anything thrown by an engine call (a forge-web `ForgeError`, a worker reply) into a {@link CommandEngineError}. */
export function toCommandEngineError(e: unknown): CommandEngineError {
  if (e instanceof CommandEngineError) return e;
  const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
  const message = e instanceof Error ? e.message : typeof o["message"] === "string" ? o["message"] : String(e);
  const code = typeof o["code"] === "string" ? o["code"] : "ENGINE_FAILED";
  const errors = Array.isArray(o["errors"]) ? (o["errors"] as RejectionProblem[]) : [];
  const details = typeof o["details"] === "object" && o["details"] !== null ? (o["details"] as Record<string, unknown>) : {};
  return new CommandEngineError(code, message, errors, details);
}

/** The synchronous `@aicad/forge-web` functions the adapter wraps (after `init()`). */
export interface ForgeWebCommandModule {
  migrate(ir: string): unknown;
  canonicalize(ir: string): unknown;
  params(ir: string): unknown;
  evaluate(ir: string, options?: { reportVersion?: "auto" | "v1" }): { report: unknown };
  writeBack(ir: string, options?: { sketches?: string[] }): unknown;
  setParam(ir: string, name: string, value: ParamValueInput): unknown;
  renameFeature(ir: string, featureId: string, name: string): unknown;
  upgradeFeature(ir: string, featureId: string, to?: number): unknown;
  captureRef(ir: string, featureId: string, field: string): unknown;
  acceptRefProposal(ir: string, featureId: string, field: string): unknown;
  acceptRefCandidate(
    ir: string,
    featureId: string,
    field: string,
    memberKey: string,
    candidateKey: string,
    options?: { candidateIndex?: number; probe?: metricsV1.Probe },
  ): unknown;
  renameCurve(ir: string, sketchId: string, oldId: string, newId: string): unknown;
  /** Optional (forge-web builds before it lack it): `refFor`, the Ref for picked entities. */
  refFor?(ir: string, part: string, after: string | null, request: RefForRequest): unknown;
  /** Optional: the report without tessellation. */
  report?(ir: string, options?: { reportVersion?: "auto" | "v1" }): unknown;
}

/** The command-layer calls a forge-web worker serves (the methods of {@link IrCommandEngine}). */
export const FORGE_WEB_COMMANDS = [
  "migrate",
  "canonicalize",
  "params",
  "report",
  "writeBack",
  "setParam",
  "renameFeature",
  "upgradeFeature",
  "captureRef",
  "acceptRefProposal",
  "acceptRefCandidate",
  "renameCurve",
  "refFor",
] as const satisfies ReadonlyArray<keyof IrCommandEngine>;

export type ForgeWebCommandName = (typeof FORGE_WEB_COMMANDS)[number];

/** The command functions a module must export (see {@link ForgeWebCommandModule}). */
export const COMMAND_MEMBERS = [
  "migrate",
  "canonicalize",
  "params",
  "evaluate",
  "writeBack",
  "setParam",
  "renameFeature",
  "upgradeFeature",
  "captureRef",
  "acceptRefProposal",
  "acceptRefCandidate",
  "renameCurve",
] as const;

/** Which command functions a loaded module lacks (an older forge-web build lacks the later ones). */
export function missingCommandMembers(m: unknown): string[] {
  if (typeof m !== "object" || m === null) return [...COMMAND_MEMBERS];
  const r = m as Record<string, unknown>;
  return COMMAND_MEMBERS.filter((k) => typeof r[k] !== "function");
}

function call<T>(f: () => unknown): Promise<T> {
  try {
    return Promise.resolve(f() as T);
  } catch (e) {
    return Promise.reject(toCommandEngineError(e));
  }
}

/** The command layer over an initialised `@aicad/forge-web` module (synchronous WASM calls). */
export function forgeWebCommandEngine(mod: ForgeWebCommandModule): IrCommandEngine {
  return {
    migrate: (ir) => call(() => mod.migrate(ir)),
    canonicalize: (ir) => call(() => mod.canonicalize(ir)),
    params: (ir) => call(() => mod.params(ir)),
    report: (ir) =>
      call(() => (mod.report ? mod.report(ir, { reportVersion: "v1" }) : mod.evaluate(ir, { reportVersion: "v1" }).report)),
    writeBack: (ir, sketches) => call(() => mod.writeBack(ir, sketches ? { sketches } : {})),
    setParam: (ir, name, value) => call(() => mod.setParam(ir, name, value)),
    renameFeature: (ir, featureId, name) => call(() => mod.renameFeature(ir, featureId, name)),
    upgradeFeature: (ir, featureId, to) => call(() => mod.upgradeFeature(ir, featureId, to)),
    captureRef: (ir, featureId, field) => call(() => mod.captureRef(ir, featureId, field)),
    acceptRefProposal: (ir, featureId, field) => call(() => mod.acceptRefProposal(ir, featureId, field)),
    acceptRefCandidate: (ir, featureId, field, memberKey, candidateKey, candidateIndex, probe) =>
      call(() =>
        mod.acceptRefCandidate(ir, featureId, field, memberKey, candidateKey, {
          ...(candidateIndex === undefined ? {} : { candidateIndex }),
          ...(probe === undefined ? {} : { probe }),
        }),
      ),
    renameCurve: (ir, sketchId, oldId, newId) => call(() => mod.renameCurve(ir, sketchId, oldId, newId)),
    refFor: (ir, part, after, request) =>
      call(() => {
        if (!mod.refFor) throw new CommandEngineError("ENGINE_UNSUPPORTED", "this @aicad/forge-web build has no refFor; rebuild it");
        return mod.refFor(ir, part, after, request);
      }),
  };
}

/** The engine's command layer, or a {@link CommandEngineError} `ENGINE_UNSUPPORTED` saying why there is none. */
export function requireCommandEngine(engine: IrCommandEngine | null | undefined, why = "the active engine has no IR v1 command layer"): IrCommandEngine {
  if (!engine) throw new CommandEngineError("ENGINE_UNSUPPORTED", `${why} (use the forge-web engine)`);
  return engine;
}
