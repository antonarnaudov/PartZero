/**
 * Installs the CadScript bridge (`v0-bridge.ts`) in the app: the sink behind Finish, the document
 * context of new sketches, the timeline's "edit sketch" and the quick extrude, all over the v0
 * DocStore and the command layer (`doc.applyIr`, `selection.selectFeature`).
 *
 * One call site: `SketchModeHost` (an effect). When the IR v1 command layer (C1) lands, the
 * integrator replaces that call with the v1 wiring (docs/fm/sketcher.md).
 */
import type { AppCommandRegistry } from "../commands/commands";
import type { DocStore } from "../doc/doc-store";
import { contextFromBodies } from "./context";
import type { SketchMode } from "./controller";
import { documentSource, editSketchSource, quickExtrudeSource } from "./integration";
import { CadScriptSketchSink, v0DocContext, type CadScriptDocPort } from "./v0-bridge";

/** The bridge's port over the app's DocStore and command registry. */
export function appDocPort(doc: DocStore, commands: AppCommandRegistry): CadScriptDocPort {
  return {
    model: () => doc.getState().model?.ir ?? null,
    async settled() {
      const s = await doc.idle();
      if (!s.compile?.ok || !s.compile.ir) {
        const n = s.compile?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
        return { ir: null, report: s.report, error: `the code has ${n} error${n === 1 ? "" : "s"}: fix them first` };
      }
      return { ir: s.compile.ir, report: s.report };
    },
    async applyIr(ir, label) {
      const r = await commands.execute({ id: "doc.applyIr", args: { ir, label } }, { source: "ui" });
      return r.ok ? { ok: true } : { ok: false, message: r.error.message };
    },
    async selectFeature(nameOrId) {
      await commands.execute({ id: "selection.selectFeature", args: { feature: nameOrId, origin: "command" } }, { source: "ui" });
    },
  };
}

/** Route sketch mode through the CadScript document; returns the uninstaller. */
export function installCadScriptBridge(mode: SketchMode, doc: DocStore, commands: AppCommandRegistry, bridgeSink?: CadScriptSketchSink): () => void {
  const sink = bridgeSink ?? new CadScriptSketchSink(appDocPort(doc, commands));
  mode.setSink(sink);
  documentSource.current = () => v0DocContext(doc.getState().model?.ir ?? null);
  editSketchSource.current = (idOrName) => {
    if (mode.getState().phase !== "off") return false;
    const bodies = doc.getState().bodies;
    const probe = sink.editOptions(idOrName, undefined);
    if (!probe) return false;
    void mode.begin({ ...probe, context: contextFromBodies(bodies, probe.plane.frame) });
    return true;
  };
  quickExtrudeSource.current = (sketch, distance, direction) => sink.extrude(sketch, distance, direction);
  return () => {
    mode.setSink(mode.memory);
    documentSource.current = null;
    editSketchSource.current = null;
    quickExtrudeSource.current = null;
  };
}
