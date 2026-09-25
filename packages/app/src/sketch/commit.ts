/**
 * Where a finished sketch goes: the seam to the command layer (plan §2.1–§2.3).
 *
 * The sketcher produces an IR v1 sketch feature ({@link SketchFinish}); a {@link SketchCommitSink}
 * turns it into domain ops on the document store.
 *
 * - **Today:** the CadScript bridge (`v0-bridge.ts`) writes it into the open IR v0 document through
 *   the command layer's `doc.applyIr`.
 * - **The IR v1 model** needs contract C1 part 1 (`addParam`, `addFeature`, `setField`): Phase C's
 *   `IrDocStore` (`doc/v1/ir-doc-store.ts`) has `apply(op)` / `transaction(label, fn)`, but its
 *   `IrOpSchema` has none of those ops yet. Once they exist (docs/fm/sketcher.md, wiring 1):
 *
 * ```ts
 * sketchMode.setSink({
 *   async commit(f) {
 *     try {
 *       await services.ir.transaction(`Sketch ${f.feature.name}`, async (tx) => {
 *         for (const op of sketchFinishToOps(f)) await tx.apply(op as IrOp);
 *       }, { origin: "user" });
 *       return { ok: true };
 *     } catch (e) {
 *       // The first refused op rejects the transaction (CommandEngineError: code, message, details).
 *       return { ok: false, message: e instanceof Error ? e.message : String(e) };
 *     }
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
  /**
   * The edited sketch was explicit and loading converted it (`convertSketch`): its compound
   * members became curves (`[member id, curve id]`); later features that name the members
   * (`regions`, queries on `side:<member>`) must be rewritten in the same transaction.
   */
  conversion: { renames: Array<[string, string]>; notes: string[] } | null;
  /**
   * The evaluation of record and IR validation of the feature, plus the regions' areas (the
   * sink compares them with the document's own evaluation of what it stored).
   */
  check: Pick<FinishResult, "ok" | "error" | "regions" | "status" | "dof" | "warnings" | "validation"> & { areas?: number[] };
}

/**
 * The sink's answer. `note`: what the model now holds, for the Finish toast; `warning`: the
 * sketch is in the model but something needs a look (e.g. the document evaluates it differently).
 */
export type CommitOutcome = { ok: true; note?: string; warning?: string } | { ok: false; message: string };

export interface SketchCommitSink {
  commit(f: SketchFinish): Promise<CommitOutcome>;
}

/**
 * The domain ops for a finished sketch, in the op catalogue v2 shape (plan §2.2, C1 part 1, not in
 * Phase C's `IrOpSchema` yet): `addParam` for each new parameter, then `addFeature` (new) or
 * `setField` of the curves and constraints (edit: exact, and needs no `sketchEdit`, C1 part 2).
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
