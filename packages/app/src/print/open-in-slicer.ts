/**
 * "Open in Bambu Studio" in the app (ALPHA-0-PLAN §1.1 step 8, W3 and W5): hand the current
 * design to the desktop shell, which checks it with Forge, exports it centred on the active
 * printer's bed into `~/PartZero/Prints` with a receipt, and opens it in the user's own Bambu
 * Studio (`slicer:open`, see `@aicad/desktop` print-handoff.ts).
 *
 * This is the body of the `file.openInSlicer` command. Until that command is registered in
 * `commands/commands.ts` (which IR v1 Phase C has open), the toolbar button calls it directly.
 */
import type { OpenInSlicerResult, PrintBridge } from "../bridge";
import type { DocState } from "../doc/doc-store";
import type { Toast } from "../ui-store";

/** What `openInSlicer` needs from the app services. */
export interface OpenInSlicerContext {
  doc: { idle(): Promise<DocState> };
  host: { print?: PrintBridge | null };
  ui: { toast(kind: Toast["kind"], message: string, ttlMs?: number, action?: Toast["action"]): void };
}

/** File name of a path. */
function fileName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/**
 * Export the open document for the printer and open it in Bambu Studio. Resolves to the shell's
 * result (also shown as a toast); throws when there is nothing to hand over (no desktop shell, or
 * code with errors), like the other commands.
 */
export async function openInSlicer(ctx: OpenInSlicerContext): Promise<OpenInSlicerResult> {
  const print = ctx.host.print;
  if (!print) throw new Error("Open in Bambu Studio needs the desktop app. Export a 3MF and open it in Bambu Studio instead.");
  const state = await ctx.doc.idle();
  const c = state.compile;
  if (!c?.ok || !c.ir) {
    const n = c?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
    throw new Error(`Cannot open in Bambu Studio: the code has ${n} error${n === 1 ? "" : "s"}. Fix them first.`);
  }
  const result = await print.openInSlicer({ irJson: JSON.stringify(c.ir), docName: state.name });
  const reveal = (path: string): Toast["action"] => ({ label: "Show in Finder", run: () => void print.reveal(path).catch(() => undefined) });
  switch (result.status) {
    case "opened":
      ctx.ui.toast("success", `Opened ${fileName(result.file)} in ${result.slicer.name}`, 6000, reveal(result.file));
      break;
    case "exported":
      ctx.ui.toast("info", `${result.message}${result.fix ? ` ${result.fix}` : ""}`, 12_000, reveal(result.file));
      break;
    case "refused":
      ctx.ui.toast("error", result.message, 12_000);
      break;
  }
  return result;
}
