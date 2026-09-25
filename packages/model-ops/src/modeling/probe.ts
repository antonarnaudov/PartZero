/**
 * Geometry the report does not list, measured by the engine itself: a probe feature is inserted
 * where a new feature would go (at the rollback marker, or at the end of the part), the document is
 * evaluated, and the probe's report entry is read. Nothing is stored.
 *
 * - {@link probePlaneFrame}: a PlaneRef's evaluated frame, through a `datum_plane` offset by 0 from
 *   it (SPEC-v1 §3.3: the frame of `from` translated by 0), so a face's frame is exactly the face
 *   frame of §3.1 as the engine computes it.
 */
import type { HostState } from "../apply.js";
import { parseDoc, type DocJson } from "../doc.js";
import { CommandEngineError, type IrCommandEngine } from "../engine.js";
import type { Frame } from "./frames.js";
import type { ModelingContext } from "./tool.js";

const PROBE_ID = "pz_probe_frame";

/** Insert `feature` where a new feature of `part` goes (after the marker when it is in that part). */
export function insertAtMarker(doc: DocJson, part: string, host: HostState, feature: Record<string, unknown>): DocJson {
  const p = doc.parts.find((x) => x.id === part) ?? doc.parts[0];
  if (!p) return doc;
  const m = host.rollback === null ? -1 : p.features.findIndex((f) => f.id === host.rollback);
  const at = m >= 0 ? m + 1 : p.features.length;
  p.features.splice(at, 0, feature as never);
  return doc;
}

function requireEngine(ctx: ModelingContext): IrCommandEngine {
  if (!ctx.engine) throw new CommandEngineError("ENGINE_UNSUPPORTED", "this host has no Forge engine to measure the model with");
  return ctx.engine;
}

/**
 * The evaluated frame of `plane` (a PlaneRef) as seen by a new feature of `part`. Refused with the
 * reference's own error (`REF_UNRESOLVED`, `PLANE_NOT_PLANAR`, …) when it does not resolve there.
 */
export async function probePlaneFrame(ctx: ModelingContext, part: string, plane: unknown, field: string): Promise<Frame> {
  const e = requireEngine(ctx);
  const doc = insertAtMarker(parseDoc(ctx.document), part, ctx.host, { type: "datum_plane", id: PROBE_ID, name: PROBE_ID, mode: "offset", from: plane, distance: 0 });
  const report = await e.report(JSON.stringify(doc));
  const topError = (report as { error?: { code: string; message: string } }).error;
  const entry = report.features.find((f) => f.feature_id === PROBE_ID);
  if (!entry) {
    throw new CommandEngineError(topError?.code ?? "MODEL_PROBE_FAILED", topError?.message ?? "the plane could not be measured", [], { field });
  }
  if (entry.status === "error" || !entry.datum) {
    const err = entry.error;
    throw new CommandEngineError(err?.code ?? "MODEL_PROBE_FAILED", err?.message ?? "the plane could not be measured", [], { field, ...(err?.details ?? {}) });
  }
  const d = entry.datum as unknown as { origin: Frame["origin"]; x: Frame["x"]; y: Frame["y"]; normal: Frame["normal"] };
  return { origin: d.origin, x: d.x, y: d.y, normal: d.normal };
}
