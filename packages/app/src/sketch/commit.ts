/**
 * Where a finished sketch goes: the seam to the command layer (plan §2.1–§2.3).
 *
 * The sketcher produces an IR v1 sketch feature ({@link SketchFinish}); a {@link SketchCommitSink}
 * turns it into domain ops on the document store. The integrator installs the real sink once
 * Phase C's `IrDocStore` and op catalogue are merged (see `docs/fm/sketcher.md`):
 *
 * ```ts
 * sketchMode.setSink({
 *   async commit(f) {
 *     const ops = sketchFinishToOps(f);            // addParam…, then addFeature | setField
 *     const r = await services.ir.transact(ops, { origin: "user", label: `Sketch ${f.feature.name}` });
 *     return r.ok ? { ok: true } : { ok: false, message: r.error.message };
 *   },
 * });
 * ```
 */
import type { v1 } from "@aicad/ir-types";
import type { FinishResult, SketchEdit } from "./engine-types";

export interface SketchFinish {
  /** `new`: add the feature; `edit`: replace the existing sketch with the same id. */
  mode: "new" | "edit";
  /** The IR v1 sketch feature (canonical JSON, literal geometry written back). */
  feature: v1.SketchFeature;
  /** Insert after this feature id (new sketches; null = the rollback marker / end). */
  after: string | null;
  /** The part (id) it belongs to, when known. */
  part: string | null;
  /** Parameters defined in the session: add them first. */
  params: v1.Parameter[];
  /** The session's committed edits (for a `sketchEdit` op on an existing sketch). */
  edits: SketchEdit[];
  /** The evaluation of record and IR validation of the feature. */
  check: Pick<FinishResult, "ok" | "error" | "regions" | "status" | "dof" | "warnings" | "validation">;
}

export type CommitOutcome = { ok: true } | { ok: false; message: string };

export interface SketchCommitSink {
  commit(f: SketchFinish): Promise<CommitOutcome>;
}

/**
 * The domain ops for a finished sketch, in the op catalogue v2 shape (plan §2.2): `addParam` for
 * each new parameter, then `addFeature` (new) or `setField` of the curves and constraints (edit).
 * Plain objects: `@aicad/model-ops` owns their zod schemas (C1), and validates them on apply.
 */
export function sketchFinishToOps(f: SketchFinish): Array<Record<string, unknown>> {
  // The session defines document-level parameters (SPEC-v1 §2.1).
  const params = f.params.map((p) => ({ op: "addParam", name: p.name, unit: p.unit, value: p.value }));
  if (f.mode === "new") {
    return [...params, { op: "addFeature", ...(f.part ? { part: f.part } : {}), after: f.after, feature: f.feature }];
  }
  return [
    ...params,
    { op: "setField", feature: f.feature.id, path: "/curves", value: f.feature.curves },
    { op: "setField", feature: f.feature.id, path: "/constraints", value: f.feature.constraints ?? [] },
  ];
}

/** The default sink until the command layer is wired: keeps the results (the harness reads them). */
export class MemorySink implements SketchCommitSink {
  readonly results: SketchFinish[] = [];

  async commit(f: SketchFinish): Promise<CommitOutcome> {
    this.results.push(f);
    return { ok: true };
  }
}
