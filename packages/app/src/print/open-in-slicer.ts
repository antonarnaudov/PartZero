/**
 * "Open in Bambu Studio" in the app (ALPHA-0-PLAN §1.1 step 8, W3 and W5): hand the current
 * design to the desktop shell, which checks it with Forge, exports it centred on the active
 * printer's bed into `~/PartZero/Prints` with a receipt, and opens it in the user's own Bambu
 * Studio (`slicer:open`, see `@aicad/desktop` print-handoff.ts).
 *
 * This is the body of the `file.openInSlicer` command. Until that command is registered in
 * `commands/commands.ts` (which IR v1 Phase C has open), the toolbar button calls it directly.
 *
 * **Which document is exported** ({@link printableIr}): the IR v1 document of record when the
 * host has an IR v1 store (`services.ir`, IR v1 Phase C) with a document loaded, since v1
 * parameter edits and write-backs land there; otherwise the CadScript document's compiled IR.
 * The v1 store is waited for, never read mid-transaction, so a parameter just changed is the one
 * exported (golden path a3/a4). Nothing here guesses between the two once the app has one document
 * store (ALPHA-0-PLAN W4c): the rule is to export what the user is editing.
 */
import type { OpenInSlicerResult, PrintBridge } from "../bridge";
import type { DocState } from "../doc/doc-store";
import type { Toast } from "../ui-store";

/** The part of the IR v1 document store (`IrDocStore`, Phase C) the handoff reads. */
export interface PrintableIrStore {
  getState(): { document: string | null; busy: boolean };
}

/** What `openInSlicer` needs from the app services. */
export interface OpenInSlicerContext {
  doc: { idle(): Promise<DocState> };
  /** The IR v1 document store, on hosts that have one. */
  ir?: PrintableIrStore | undefined;
  host: { print?: PrintBridge | null };
  ui: { toast(kind: Toast["kind"], message: string, ttlMs?: number, action?: Toast["action"]): void };
}

/** File name of a path. */
function fileName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

/** How long to wait for a running IR v1 transaction before giving up (an agent turn can be long). */
const IR_BUSY_WAIT_MS = 30_000;

async function settledIr(ir: PrintableIrStore, waitMs: number): Promise<string | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const s = ir.getState();
    if (!s.busy) return s.document;
    if (Date.now() >= until) throw new Error("Cannot open in Bambu Studio yet: the design is still being changed. Try again when it is done.");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The IR JSON to print and the document name (see the module docs). Throws when there is nothing
 * printable: code with errors, or an IR v1 store that stays busy.
 */
export async function printableIr(ctx: Pick<OpenInSlicerContext, "doc" | "ir">, busyWaitMs = IR_BUSY_WAIT_MS): Promise<{ irJson: string; docName: string }> {
  const state = await ctx.doc.idle();
  if (ctx.ir) {
    const v1 = await settledIr(ctx.ir, busyWaitMs);
    if (v1 !== null) return { irJson: v1, docName: state.name };
  }
  const c = state.compile;
  if (!c?.ok || !c.ir) {
    const n = c?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
    throw new Error(`Cannot open in Bambu Studio: the code has ${n} error${n === 1 ? "" : "s"}. Fix them first.`);
  }
  return { irJson: JSON.stringify(c.ir), docName: state.name };
}

/** " Note: …" for the layout warnings of an export (bodies the slicer drops onto the plate). */
function warningText(result: { warnings?: Array<{ message: string }> }): string {
  const w = result.warnings ?? [];
  return w.length === 0 ? "" : ` Note: ${w.map((x) => x.message).join("; ")}.`;
}

/**
 * Export the open document for the printer and open it in Bambu Studio. Resolves to the shell's
 * result (also shown as a toast); throws when there is nothing to hand over (no desktop shell, or
 * code with errors), like the other commands.
 */
export async function openInSlicer(ctx: OpenInSlicerContext): Promise<OpenInSlicerResult> {
  const print = ctx.host.print;
  if (!print) throw new Error("Open in Bambu Studio needs the desktop app. Export a 3MF and open it in Bambu Studio instead.");
  const result = await print.openInSlicer(await printableIr(ctx));
  const reveal = (path: string): Toast["action"] => ({ label: "Show in Finder", run: () => void print.reveal(path).catch(() => undefined) });
  switch (result.status) {
    case "opened": {
      // `open` handed the file over; whether Bambu Studio loaded it is not observable from here.
      // A running Bambu Studio with a part loaded opens the file in a new instance (SLICER-HANDOFF.md).
      const again = result.alreadyRunning ? ` ${result.slicer.name} was already open, so it may open this in a new window: close the previous one when you're done.` : "";
      const text = `Sent ${fileName(result.file)} to ${result.slicer.name}.${again}${warningText(result)}`;
      ctx.ui.toast(again || result.warnings?.length ? "info" : "success", text, again || result.warnings?.length ? 12_000 : 6000, reveal(result.file));
      break;
    }
    case "exported":
      ctx.ui.toast("info", `${result.message}${result.fix ? ` ${result.fix}` : ""}${warningText(result)}`, 12_000, reveal(result.file));
      break;
    case "refused":
      ctx.ui.toast("error", result.message, 12_000);
      break;
  }
  return result;
}
