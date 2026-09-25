/**
 * The `file.*` commands (FULL-MODELING-PLAN §3.3: `commands/file.ts`, DOC). Same conventions as the rest of the
 * command layer: zod arguments, small JSON results, failures thrown. Menu, keyboard, palette, agent and MCP all run
 * these.
 *
 * `makeFileCommands(filesOf)` takes how to reach the window's {@link DocumentFiles} from the command context: once
 * `AppServices` has a `files` member the integrator registers `makeFileCommands((ctx) => ctx.files)`; until then
 * install.ts registers them with a closure over the instance.
 */
import { z } from "zod";
import { defineCommand } from "../commands/registry";
import { findTemplate } from "../host/templates";
import type { AppServices } from "../services";
import type { DocumentFiles } from "./document-files";
import { exportFormats } from "./export-formats";

const command = defineCommand<AppServices>();
const NoArgs = z.strictObject({});
const MeshFormat = z.enum(["3mf", "stl", "obj"]);
const Path = z.string().min(1).max(4096);

export function makeFileCommands(filesOf: (ctx: AppServices) => DocumentFiles) {
  return {
    "file.new": command({
      id: "file.new",
      title: "New Document",
      category: "File",
      description: "Create a new untitled document (in a new window unless this window's document is untitled and unchanged).",
      args: NoArgs,
      keys: ["Mod+N"],
      run: (_a, ctx) => filesOf(ctx).newDocument(),
    }),

    "file.newFromTemplate": command({
      id: "file.newFromTemplate",
      title: "New from Template…",
      category: "File",
      description: "Create a new document from a MakerBench reference model. Without a templateId, opens the template picker.",
      args: z.strictObject({ templateId: z.string().optional() }),
      keys: ["Mod+Shift+N"],
      palette: [{ title: "New from Template…", args: {} }],
      async run({ templateId }, ctx) {
        if (templateId === undefined) {
          ctx.ui.openDialog("templates");
          return { created: false, picker: true };
        }
        const t = findTemplate(templateId) ?? ctx.templates.find((x) => x.id === templateId);
        if (!t) throw new Error(`unknown template: ${templateId}`);
        ctx.ui.closeDialog();
        const r = await filesOf(ctx).newFromCode(t.id, t.source, { id: "file.newFromTemplate", args: { templateId: t.id } });
        return { ...r, picker: false, templateId: t.id };
      },
    }),

    "file.open": command({
      id: "file.open",
      title: "Open…",
      category: "File",
      description:
        "Open a PartZero (.partzero), CadScript (.cad.ts) or IR JSON (.json) document. Without a path, shows the open dialog. It opens in the window that already has it, here when this window is untitled and unchanged, else in a new window.",
      args: z.strictObject({ path: Path.optional() }),
      keys: ["Mod+O"],
      palette: [{ title: "Open…", args: {} }],
      run: ({ path }, ctx) => filesOf(ctx).open(path),
    }),

    "file.openRecent": command({
      id: "file.openRecent",
      title: "Open Recent",
      category: "File",
      args: z.strictObject({ path: Path }),
      palette: false,
      run: ({ path }, ctx) => filesOf(ctx).openPath(path),
    }),

    "file.showRecent": command({
      id: "file.showRecent",
      title: "Open Recent…",
      category: "File",
      description: "Show the recent documents with their thumbnails.",
      args: NoArgs,
      run: (_a, ctx) => filesOf(ctx).showRecent(),
    }),

    "file.clearRecent": command({
      id: "file.clearRecent",
      title: "Clear Recent Files",
      category: "File",
      args: NoArgs,
      async run(_a, ctx) {
        const r = await filesOf(ctx).clearRecent();
        try {
          ctx.ui.setRecentFiles(await ctx.host.recentFiles());
        } catch {
          // a convenience
        }
        return r;
      },
    }),

    "file.save": command({
      id: "file.save",
      title: "Save",
      category: "File",
      description: "Save the document to its file (asks for a path the first time; new documents are saved as .partzero).",
      args: NoArgs,
      keys: ["Mod+S"],
      run: (_a, ctx) => filesOf(ctx).save(),
    }),

    "file.saveAs": command({
      id: "file.saveAs",
      title: "Save As…",
      category: "File",
      description: "Save to a new path: .partzero (the model, its code, reference meshes and view state), .cad.ts (the code) or .json (the compiled IR).",
      args: z.strictObject({ path: Path.optional() }),
      keys: ["Mod+Shift+S"],
      palette: [{ title: "Save As…", args: {} }],
      run: ({ path }, ctx) => filesOf(ctx).saveAs(path),
    }),

    "file.revert": command({
      id: "file.revert",
      title: "Revert to Saved",
      category: "File",
      description: "Reload the document from its file, dropping unsaved changes.",
      args: NoArgs,
      run: (_a, ctx) => filesOf(ctx).revert(),
    }),

    "file.close": command({
      id: "file.close",
      title: "Close Window",
      category: "File",
      description: "Close this window (asks to save unsaved changes).",
      args: NoArgs,
      keys: ["Mod+W"],
      run: (_a, ctx) => filesOf(ctx).close(),
    }),

    "file.exportMesh": command({
      id: "file.exportMesh",
      title: "Export Mesh",
      category: "File",
      description: "Evaluate the document and export every body as a mesh (3MF, STL or OBJ).",
      args: z.strictObject({ format: MeshFormat.default("3mf"), path: Path.optional() }),
      palette: [
        { title: "Export 3MF…", args: { format: "3mf" } },
        { title: "Export STL…", args: { format: "stl" } },
        { title: "Export OBJ…", args: { format: "obj" } },
      ],
      run: ({ format, path }, ctx) => filesOf(ctx).export(format, path),
    }),

    "file.export": command({
      id: "file.export",
      title: "Export…",
      category: "File",
      description: `Export the document. Without a format, opens the export dialog. Formats: ${exportFormats()
        .map((f) => f.id)
        .join(", ")} (STEP arrives with Forge's STEP writer).`,
      args: z.strictObject({ format: z.string().min(1).max(20).optional(), path: Path.optional() }),
      keys: ["Mod+E"],
      palette: [{ title: "Export…", args: {} }],
      async run({ format, path }, ctx) {
        const files = filesOf(ctx);
        if (format === undefined) {
          files.openExportDialog();
          return { exported: false, dialog: true };
        }
        return files.export(format, path);
      },
    }),

    "file.importReference": command({
      id: "file.importReference",
      title: "Import Mesh as Reference…",
      category: "File",
      description: "Import an STL, 3MF or OBJ file as a reference mesh: shown and measured, not editable, saved inside the .partzero.",
      args: z.strictObject({ path: Path.optional() }),
      palette: [{ title: "Import Mesh as Reference…", args: {} }],
      run: ({ path }, ctx) => filesOf(ctx).importReference(path),
    }),

    "file.removeReference": command({
      id: "file.removeReference",
      title: "Remove Reference Mesh",
      category: "File",
      args: z.strictObject({ id: z.string().min(1).max(64) }),
      palette: false,
      run: ({ id }, ctx) => filesOf(ctx).removeReference(id),
    }),

    "file.setReferenceVisible": command({
      id: "file.setReferenceVisible",
      title: "Show or Hide a Reference Mesh",
      category: "File",
      args: z.strictObject({ id: z.string().min(1).max(64), visible: z.boolean() }),
      palette: false,
      run: ({ id, visible }, ctx) => filesOf(ctx).setReferenceVisible(id, visible),
    }),

    "file.recover": command({
      id: "file.recover",
      title: "Recover Unsaved Documents…",
      category: "File",
      description: "List documents a crash or a force quit left unsaved, to restore or discard them.",
      args: NoArgs,
      run: (_a, ctx) => filesOf(ctx).showRecovery(),
    }),

    "file.restoreRecovery": command({
      id: "file.restoreRecovery",
      title: "Restore a Recovered Document",
      category: "File",
      args: z.strictObject({ id: z.string().regex(/^[a-z0-9-]{8,64}$/) }),
      palette: false,
      run: ({ id }, ctx) => filesOf(ctx).restoreRecovery(id),
    }),

    "file.discardRecovery": command({
      id: "file.discardRecovery",
      title: "Discard a Recovered Document",
      category: "File",
      args: z.strictObject({ id: z.string().regex(/^[a-z0-9-]{8,64}$/) }),
      palette: false,
      run: ({ id }, ctx) => filesOf(ctx).discardRecovery(id),
    }),

    "file.flushRecovery": command({
      id: "file.flushRecovery",
      title: "Autosave Now",
      category: "File",
      description: "Write this window's recovery snapshot now (it is written automatically a few seconds after each change).",
      args: NoArgs,
      palette: false,
      run: (_a, ctx) => filesOf(ctx).flushRecovery(),
    }),

    "file.status": command({
      id: "file.status",
      title: "Document Status",
      category: "File",
      description: "The document's file, whether it has unsaved changes, and its reference meshes with their measures.",
      args: NoArgs,
      palette: false,
      run: (_a, ctx) => filesOf(ctx).status(),
    }),
  };
}

export type FileCommands = ReturnType<typeof makeFileCommands>;
