/**
 * Sketch mode on the IR v1 model (docs/fm/sketcher.md, "Integrator wiring for the IR v1 model"):
 *
 * - **Finish** → one transaction of catalogue ops through the command layer (`ir.apply`, source
 *   `ui`: the user's): `addParam` for each parameter the session defined, then `addFeature` of the
 *   sketch (a new sketch, at the rollback marker or the end of its part) or `updateFeature` of its
 *   curves and constraints (an edited sketch). The sketch keeps everything: constraints, dimensions,
 *   construction geometry, parameters — the v1 model holds them (the CadScript bridge could not).
 * - **New sketches** see the model: its parameters in dimensions, a free id and name, and the part
 *   and insertion point (the rollback marker).
 * - **Timeline double-click** reopens a sketch with its constraints, on its plane.
 * - **The extrude offer** after Finish adds an extrude (`ir.addFeature`).
 *
 * On a CadScript (IR v0) document — hosts without the IR v1 engine — the CadScript bridge
 * (`v0-app.ts`) still does all four.
 */
import type { v1 } from "@aicad/ir-types";
import type { IrOp } from "@aicad/model-ops";
import type { AppCommandRegistry } from "../commands/commands";
import type { DocStore } from "../doc/doc-store";
import type { CommitOutcome, SketchCommitSink, SketchFinish } from "./commit";
import { contextFromBodies } from "./context";
import type { SketchMode, SketchPlaneChoice } from "./controller";
import { namedFrame, type NamedPlane } from "./frames";
import { documentSource, editSketchSource, quickExtrudeSource, type SketchDocContext } from "./integration";
import { appDocPort, installCadScriptBridge } from "./v0-app";
import { CadScriptSketchSink, planeFrame } from "./v0-bridge";

type Doc = v1.IrDocument;

function parse(doc: DocStore): Doc | null {
  const s = doc.getState();
  if (s.format !== "ir-v1") return null;
  try {
    return JSON.parse(s.source) as Doc;
  } catch {
    return null;
  }
}

/** Names the document's parameters already use (the session's new parameters are added, never re-added). */
function paramNames(d: Doc): Set<string> {
  return new Set([...(d.params ?? []), ...d.parts.flatMap((p) => p.params ?? [])].map((p) => p.name));
}

/** The catalogue ops of a finished sketch on the v1 model. */
export function sketchFinishOps(f: SketchFinish, d: Doc | null): IrOp[] {
  const known = d ? paramNames(d) : new Set<string>();
  const ops: IrOp[] = [];
  for (const p of f.params) {
    if (known.has(p.name)) continue;
    const q = p as v1.Parameter & { min?: number | string; max?: number | string };
    ops.push({
      op: "addParam",
      name: q.name,
      unit: q.unit,
      value: q.value,
      ...(q.min !== undefined ? { min: q.min } : {}),
      ...(q.max !== undefined ? { max: q.max } : {}),
    });
  }
  const feature = f.feature as unknown as { type: string } & Record<string, unknown>;
  if (f.mode === "new") {
    ops.push({ op: "addFeature", ...(f.part ? { part: f.part } : {}), ...(f.after ? { after: f.after } : {}), feature });
  } else {
    const set: Record<string, unknown> = { curves: f.feature.curves, constraints: f.feature.constraints && f.feature.constraints.length > 0 ? f.feature.constraints : null };
    ops.push({ op: "updateFeature", feature: f.feature.id, set });
  }
  return ops;
}

/** The sink behind Finish on the v1 model: the command layer, one undoable transaction. */
export class V1SketchSink implements SketchCommitSink {
  constructor(
    private readonly doc: DocStore,
    private readonly commands: AppCommandRegistry,
  ) {}

  async commit(f: SketchFinish): Promise<CommitOutcome> {
    const ops = sketchFinishOps(f, parse(this.doc));
    const label = `${f.mode === "new" ? "Sketch" : "Edit sketch"} ${f.feature.name}`;
    const r = await this.commands.execute({ id: "ir.apply", args: { ops, label } }, { source: "ui" });
    if (!r.ok) return { ok: false, message: r.error.message };
    await this.doc.idle();
    await this.commands.execute({ id: "selection.selectFeature", args: { feature: f.feature.id, origin: "command" } }, { source: "ui" });
    const withheld = (r.value as { ops: Array<{ op: IrOp; result: unknown }> }).ops.some((o) => o.op.op === "writeBackSolution" && ((o.result as { skipped?: Array<{ reason: string }> }).skipped ?? []).some((s) => s.reason === "would-fail"));
    return { ok: true, ...(withheld ? { warning: "Its solved geometry was not written back (it would fail): check the sketch's dimensions." } : {}) };
  }
}

/** The plane a stored sketch lies on, when sketch mode can place it (a named or explicit plane). */
function planeOf(feature: v1.SketchFeature): SketchPlaneChoice | null {
  const p = feature.plane as unknown;
  if (typeof p === "string" && (p === "XY" || p === "XZ" || p === "YZ")) return { ref: p, frame: namedFrame(p as NamedPlane), label: `${p} plane` };
  if (p && typeof p === "object" && "origin" in p && "normal" in p && "x_dir" in p) {
    const f = p as { origin: unknown[]; normal: unknown[]; x_dir: unknown[] };
    if ([f.origin, f.normal, f.x_dir].every((v) => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number"))) {
      return { ref: feature.plane, frame: planeFrame(p as Parameters<typeof planeFrame>[0]), label: "frame" };
    }
  }
  return null;
}

export function v1DocContext(doc: DocStore): SketchDocContext | null {
  const d = parse(doc);
  if (!d) return null;
  const s = doc.getState();
  const marker = s.v1?.host.rollback ?? null;
  const part = (marker ? d.parts.find((p) => p.features.some((f) => f.id === marker)) : null) ?? d.parts[0];
  // `after: null`: at the rollback marker (or the end), and the marker moves past the new sketch.
  return { document: d, part: part?.id ?? null, after: null, taken: [] };
}

/**
 * Route sketch mode through the v1 model while the document is IR v1, and through the CadScript
 * bridge otherwise; returns the uninstaller.
 */
export function installSketchWiring(mode: SketchMode, doc: DocStore, commands: AppCommandRegistry): () => void {
  // The CadScript bridge first (IR v0 documents); its hooks stay the fallbacks below.
  const v0Sink = new CadScriptSketchSink(appDocPort(doc, commands));
  const uninstallV0 = installCadScriptBridge(mode, doc, commands, v0Sink);
  const v0 = {
    documentSource: documentSource.current,
    editSketchSource: editSketchSource.current,
    quickExtrudeSource: quickExtrudeSource.current,
  };
  const v1Sink = new V1SketchSink(doc, commands);
  mode.setSink({
    commit: (f) => (doc.isV1 ? v1Sink.commit(f) : v0Sink.commit(f)),
  });
  documentSource.current = () => (doc.isV1 ? v1DocContext(doc) : (v0.documentSource?.() ?? null));
  editSketchSource.current = (idOrName) => {
    if (!doc.isV1) return v0.editSketchSource?.(idOrName) ?? false;
    if (mode.getState().phase !== "off") return false;
    const d = parse(doc);
    if (!d) return false;
    for (const part of d.parts) {
      const i = part.features.findIndex((f) => f.id === idOrName || f.name === idOrName);
      if (i < 0) continue;
      const feature = part.features[i]!;
      if (feature.type !== "sketch") return false;
      const plane = planeOf(feature as v1.SketchFeature);
      if (!plane) return false;
      void mode.begin({
        plane,
        sketch: feature as v1.SketchFeature,
        document: d,
        part: part.id,
        after: i > 0 ? part.features[i - 1]!.id : null,
        context: contextFromBodies(doc.getState().bodies, plane.frame),
      });
      return true;
    }
    return false;
  };
  quickExtrudeSource.current = async (sketch, distance, direction) => {
    if (!doc.isV1) return v0.quickExtrudeSource ? v0.quickExtrudeSource(sketch, distance, direction) : { ok: false, message: "no document" };
    if (!(distance > 0) || !Number.isFinite(distance)) return { ok: false, message: "The distance must be greater than zero." };
    const d = parse(doc);
    const f = d?.parts.flatMap((p) => p.features).find((x) => x.id === sketch || x.name === sketch);
    if (!f) return { ok: false, message: `there is no sketch ${sketch}` };
    const r = await commands.execute(
      { id: "ir.addFeature", args: { feature: { type: "extrude", sketch: f.id, distance, ...(direction !== "normal" ? { direction } : {}) } } },
      { source: "ui" },
    );
    if (!r.ok) return { ok: false, message: r.error.message };
    await doc.idle();
    return { ok: true };
  };
  return () => {
    uninstallV0();
    documentSource.current = null;
    editSketchSource.current = null;
    quickExtrudeSource.current = null;
  };
}
