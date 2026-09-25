/**
 * The `file.exportStep` command ("Export STEP…"), ready to register in the command layer.
 *
 * The command layer (`src/commands/**`) belongs to the IR v1 Phase C work, so this module builds
 * the whole command — arguments, palette entries, enablement, the save dialog, the export through
 * {@link exportStepFile}, toasts with the failure code — and leaves only where the IR comes from
 * to the caller. Registering it is one entry in `commands.ts`:
 *
 * ```ts
 * import { makeExportStepCommand } from "../io/step-export-command";
 * // …in the command map, next to "file.exportMesh":
 * "file.exportStep": makeExportStepCommand<AppServices>({
 *   document: async (ctx, action) => {
 *     const { ir, state } = await currentIr(ctx, action); // the v1 document of record after Phase C
 *     return { irJson: JSON.stringify(ir), name: state.name };
 *   },
 *   host: (ctx) => ctx.host,
 *   toast: (ctx, kind, message) => ctx.ui.toast(kind, message),
 * }),
 * ```
 *
 * and one line in the desktop menu's File ▸ Export submenu: `cmd("STEP…", "file.exportStep")`.
 * `aicad export --format step` reads both `aicad.ir/0` and `aicad.ir/1` documents.
 */
import { z } from "zod";
import type { AppHost } from "../host/host";
import { baseName } from "../host/host";
import { defineCommand } from "../commands/registry";
import { exportStepFile, StepExportError, stepExportAvailable, type StepExportResult } from "./step-export";

/** The command's id. */
export const EXPORT_STEP_COMMAND = "file.exportStep";

export const ExportStepArgs = z.strictObject({
  /** `ap214` (default: what most CAD tools and slicers read) or `ap242`. */
  schema: z.enum(["ap214", "ap242"]).default("ap214"),
  /** Write here instead of asking with the save dialog (the agent, scripts, tests). */
  path: z.string().min(1).optional(),
  /** Export the bodies that evaluated even when some features failed. */
  allowPartial: z.boolean().default(false),
});

/** What the command needs from the app, so it runs against any command context. */
export interface ExportStepDeps<C> {
  /**
   * The document to export: its compiled IR as JSON and its name (the suggested file name and the
   * STEP product name). Throws (with a message for the user) when the document does not compile.
   */
  document(ctx: C, action: string): Promise<{ irJson: string; name: string }>;
  host(ctx: C): Pick<AppHost, "pickSavePath" | "writeFile" | "forgeCli">;
  toast(ctx: C, kind: "success" | "error", message: string): void;
}

/** The command's result: {@link StepExportResult} without the per-body details, plus the count. */
export type ExportStepCommandResult =
  | { exported: false }
  | { exported: true; path: string; bytes: number; schema: "ap214" | "ap242"; bodies: number };

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The user-facing message of a failed export: the reason, then its stable code. */
export function stepFailureMessage(e: unknown): string {
  if (e instanceof StepExportError) return `STEP export failed: ${e.message} (${e.code})`;
  return `STEP export failed: ${e instanceof Error ? e.message : String(e)}`;
}

/** Build the `file.exportStep` command for a command context `C` (see the module docs). */
export function makeExportStepCommand<C>(deps: ExportStepDeps<C>) {
  return defineCommand<C>()({
    id: EXPORT_STEP_COMMAND,
    title: "Export STEP",
    category: "File",
    description:
      "Export every body of the document as an exact B-rep STEP file (AP214 by default, or AP242), " +
      "written and verified by Forge.",
    args: ExportStepArgs,
    palette: [
      { title: "Export STEP…", args: {} },
      { title: "Export STEP (AP242)…", args: { schema: "ap242" } },
    ],
    enabled: (ctx: C) => stepExportAvailable(deps.host(ctx)),
    async run({ schema, path, allowPartial }, ctx): Promise<ExportStepCommandResult> {
      let r: StepExportResult;
      try {
        const doc = await deps.document(ctx, "export STEP");
        r = await exportStepFile(deps.host(ctx), {
          irJson: doc.irJson,
          docName: doc.name,
          schema,
          ...(path !== undefined ? { path } : {}),
          allowPartial,
        });
      } catch (e) {
        const message = stepFailureMessage(e);
        deps.toast(ctx, "error", message);
        // The registry reports it as FAILED with this message (code included) to every caller.
        throw new Error(message, { cause: e });
      }
      if (!r.exported) return { exported: false };
      const n = r.bodies.length;
      deps.toast(
        ctx,
        "success",
        `Exported ${baseName(r.path)} (${n} ${n === 1 ? "body" : "bodies"}, ${formatBytes(r.bytes)}, ${r.schema.toUpperCase()})`,
      );
      return { exported: true, path: r.path, bytes: r.bytes, schema: r.schema, bodies: n };
    },
  });
}
