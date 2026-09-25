/**
 * The app's commands. Every state change the UI makes goes through here — and the same commands
 * are what the in-app agent and the MCP server will call (ARCHITECTURE §2 "one command API").
 *
 * Conventions:
 * - ids are `<area>.<verb>`; arguments are a zod object (validated by the registry);
 * - commands return small JSON-able results the agent can read (`{ saved: true, path }`);
 * - failures throw, and the registry turns them into `{ ok: false, error: { code: "FAILED" } }`.
 */
import { IrDocumentSchema, safeParseIrDocument, type IrDocument } from "@aicad/ir-types";
import { z } from "zod";
import type { MeshFormat } from "../bridge";
import type { DocFormat, DocState } from "../doc/doc-store";
import { featureNameOfPick, findFeature } from "../doc/provenance";
import type { EnginePreference } from "../engine/engine-manager";
import { PRINT_TESSELLATION } from "../engine/types";
import { baseName, docNameFromPath } from "../host/host";
import { BLANK_SOURCE, findTemplate } from "../host/templates";
import { makeExportStepCommand } from "../io/step-export-command";
import type { AppServices } from "../services";
import { selectionChips } from "../selection/chips";
import type { SelectionChip } from "../ui-store";
import { VIEWPORT_COMMANDS } from "../viewport/registry";
import { viewportRuntime } from "../viewport/runtime";
import { IR_COMMANDS, originOf as irOriginOf, runOps } from "./ir-commands";
import { CommandRegistry, defineCommand, type ExecuteMeta, type Invocation } from "./registry";

const command = defineCommand<AppServices>();

const NoArgs = z.strictObject({});
const MeshFormatSchema = z.enum(["3mf", "stl", "obj"]);
const ThemeSchema = z.enum(["dark", "light", "system"]);
const PanelSchema = z.enum(["left", "right", "chat", "problems"]);
const EngineSchema = z.enum(["auto", "forge-web", "forge-cli"]);
/** API-key providers (keys are optional since ADR 0014). */
const ProviderSchema = z.enum(["anthropic", "openai", "google", "openai-compat"]);
const CliProviderSchema = z.enum(["claude-cli", "gemini-cli", "codex-cli", "opencode", "cursor-agent"]);
const AnyProviderSchema = z.enum(["anthropic", "openai", "google", "openai-compat", "claude-cli", "gemini-cli", "codex-cli", "opencode", "cursor-agent", "ollama"]);
const RoleSchema = z.enum(["designer", "judge", "triage", "spec_writer"]);
const CliModeSchema = z.enum(["auto", "completion", "runtime"]);

const OPEN_FILTERS = [
  { name: "CAD documents (CadScript, IR JSON)", extensions: ["ts", "json"] },
  { name: "CadScript", extensions: ["ts"] },
  { name: "IR JSON", extensions: ["json"] },
];
const SAVE_FILTERS = [
  { name: "CadScript", extensions: ["ts"] },
  { name: "IR JSON", extensions: ["json"] },
];
const MESH_LABEL: Record<MeshFormat, string> = { "3mf": "3MF", stl: "STL", obj: "OBJ" };

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function originOf(meta: ExecuteMeta): "agent" | "command" {
  return meta.source === "agent" || meta.source === "mcp" ? "agent" : "command";
}

async function confirmDiscard(ctx: AppServices): Promise<boolean> {
  const s = ctx.doc.getState();
  if (!s.dirty) return true;
  return ctx.confirm(`Discard unsaved changes to “${s.name}”?`);
}

async function refreshRecent(ctx: AppServices): Promise<void> {
  try {
    ctx.ui.setRecentFiles(await ctx.host.recentFiles());
  } catch {
    // Recent files are a convenience.
  }
}

/** The compiled IR of the current source, after the pipeline settled. Throws when the code has errors. */
async function currentIr(ctx: AppServices, action: string): Promise<{ ir: IrDocument; state: DocState }> {
  const state = await ctx.doc.idle();
  const c = state.compile;
  if (!c?.ok || !c.ir) {
    const n = c?.diagnostics.filter((d) => d.severity === "error").length ?? 0;
    throw new Error(`Cannot ${action}: the code has ${n} error${n === 1 ? "" : "s"}. Fix them first.`);
  }
  return { ir: c.ir, state };
}

async function openPath(ctx: AppServices, path: string): Promise<{ opened: true; path: string; format: DocFormat }> {
  const text = await ctx.host.readTextFile(path);
  const name = docNameFromPath(path);
  if (/\.json$/i.test(path)) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`${baseName(path)} is not valid JSON: ${(e as Error).message}`);
    }
    const parsed = safeParseIrDocument(json);
    if (!parsed.success) throw new Error(`${baseName(path)} is not an aicad.ir/0 document: ${parsed.error.message}`);
    const source = await ctx.cadscript.print(parsed.data);
    ctx.doc.load({ path, name, format: "ir-json", source, baseIr: parsed.data });
  } else {
    ctx.doc.load({ path, name, format: "cadscript", source: text });
  }
  await refreshRecent(ctx);
  return { opened: true, path, format: /\.json$/i.test(path) ? "ir-json" : "cadscript" };
}

async function saveTo(ctx: AppServices, path: string): Promise<{ saved: true; path: string; format: DocFormat }> {
  const format: DocFormat = /\.json$/i.test(path) ? "ir-json" : "cadscript";
  let data: string;
  if (format === "ir-json") {
    const { ir } = await currentIr(ctx, "save as IR JSON");
    data = `${JSON.stringify(ir, null, 2)}\n`;
  } else {
    data = ctx.doc.getState().source;
  }
  await ctx.host.writeFile(path, data);
  ctx.doc.markSaved({ path, name: docNameFromPath(path), format });
  await refreshRecent(ctx);
  ctx.ui.toast("success", `Saved ${baseName(path)}`);
  return { saved: true, path, format };
}

async function saveAs(ctx: AppServices, path?: string): Promise<{ saved: boolean; path?: string; format?: DocFormat }> {
  const s = ctx.doc.getState();
  const suggested = s.path ? baseName(s.path) : `${s.name}${s.format === "ir-json" ? ".json" : ".cad.ts"}`;
  const target = path ?? (await ctx.host.pickSavePath({ title: "Save As", defaultPath: suggested, filters: SAVE_FILTERS }));
  if (!target) return { saved: false };
  return saveTo(ctx, target);
}

function chipsFromSelection(ctx: AppServices): SelectionChip[] {
  const s = ctx.doc.getState();
  return selectionChips(viewportRuntime(ctx).selection.items, s.selection, s.model?.ir);
}

const ChipSchema = z.strictObject({
  kind: z.enum(["feature", "face", "edge", "body"]),
  ref: z.string(),
  label: z.string(),
});

export const COMMANDS = {
  // ─── File ──────────────────────────────────────────────────────────────────────────────────
  "file.new": command({
    id: "file.new",
    title: "New Document",
    category: "File",
    description: "Create a new untitled CadScript document from the blank starter.",
    args: NoArgs,
    keys: ["Mod+N"],
    async run(_args, ctx) {
      if (!(await confirmDiscard(ctx))) return { created: false };
      ctx.doc.load({ path: null, name: "untitled", format: "cadscript", source: BLANK_SOURCE });
      return { created: true };
    },
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
      if (!(await confirmDiscard(ctx))) return { created: false, picker: false };
      ctx.ui.closeDialog();
      ctx.doc.load({ path: null, name: t.id, format: "cadscript", source: t.source });
      return { created: true, picker: false, templateId: t.id };
    },
  }),

  "file.open": command({
    id: "file.open",
    title: "Open…",
    category: "File",
    description: "Open a CadScript (.cad.ts) or IR JSON (.json) document. Without a path, shows the open dialog.",
    args: z.strictObject({ path: z.string().min(1).optional() }),
    keys: ["Mod+O"],
    palette: [{ title: "Open…", args: {} }],
    async run({ path }, ctx) {
      if (!(await confirmDiscard(ctx))) return { opened: false };
      const target = path ?? (await ctx.host.pickOpenPath({ title: "Open", filters: OPEN_FILTERS }));
      if (!target) return { opened: false };
      return openPath(ctx, target);
    },
  }),

  "file.openRecent": command({
    id: "file.openRecent",
    title: "Open Recent",
    category: "File",
    args: z.strictObject({ path: z.string().min(1) }),
    palette: false,
    async run({ path }, ctx) {
      if (!(await confirmDiscard(ctx))) return { opened: false };
      return openPath(ctx, path);
    },
  }),

  "file.clearRecent": command({
    id: "file.clearRecent",
    title: "Clear Recent Files",
    category: "File",
    args: NoArgs,
    async run(_args, ctx) {
      await ctx.host.clearRecentFiles();
      await refreshRecent(ctx);
      return { cleared: true };
    },
  }),

  "file.save": command({
    id: "file.save",
    title: "Save",
    category: "File",
    description: "Save the document to its file (asks for a path the first time).",
    args: NoArgs,
    keys: ["Mod+S"],
    async run(_args, ctx) {
      const s = ctx.doc.getState();
      return s.path && !s.path.startsWith("download:") ? saveTo(ctx, s.path) : saveAs(ctx);
    },
  }),

  "file.saveAs": command({
    id: "file.saveAs",
    title: "Save As…",
    category: "File",
    description: "Save to a new path. `.json` saves the compiled IR; anything else saves CadScript.",
    args: z.strictObject({ path: z.string().min(1).optional() }),
    keys: ["Mod+Shift+S"],
    palette: [{ title: "Save As…", args: {} }],
    run({ path }, ctx) {
      return saveAs(ctx, path);
    },
  }),

  "file.exportMesh": command({
    id: "file.exportMesh",
    title: "Export Mesh",
    category: "File",
    description: "Evaluate the document and export every body as a mesh (3MF, STL or OBJ).",
    args: z.strictObject({ format: MeshFormatSchema.default("3mf"), path: z.string().min(1).optional() }),
    keys: ["Mod+E"],
    palette: [
      { title: "Export 3MF…", args: { format: "3mf" } },
      { title: "Export STL…", args: { format: "stl" } },
      { title: "Export OBJ…", args: { format: "obj" } },
    ],
    async run({ format, path }, ctx) {
      const { ir, state } = await currentIr(ctx, `export ${MESH_LABEL[format]}`);
      const target =
        path ??
        (await ctx.host.pickSavePath({
          title: `Export ${MESH_LABEL[format]}`,
          defaultPath: `${state.name}.${format}`,
          filters: [{ name: MESH_LABEL[format], extensions: [format] }],
        }));
      if (!target) return { exported: false };
      const bytes = await ctx.engines.active.exportMesh(JSON.stringify(ir), format, PRINT_TESSELLATION);
      await ctx.host.writeFile(target, bytes);
      ctx.ui.toast("success", `Exported ${baseName(target)} (${formatBytes(bytes.length)})`);
      return { exported: true, path: target, format, bytes: bytes.length };
    },
  }),

  // STEP (forge-io's own AP214/AP242 writer through the desktop's Forge CLI). The document: the IR v1
  // document of record when the v1 store holds one (as the print handoff does), else the compiled CadScript.
  "file.exportStep": makeExportStepCommand<AppServices>({
    async document(ctx, action) {
      if (ctx.ir) {
        const v1 = await ctx.ir.waitFor((s) => !s.busy, 30_000);
        if (v1.document !== null) return { irJson: v1.document, name: ctx.doc.getState().name };
      }
      const { ir, state } = await currentIr(ctx, action);
      return { irJson: JSON.stringify(ir), name: state.name };
    },
    host: (ctx) => ctx.host,
    toast: (ctx, kind, message) => ctx.ui.toast(kind, message),
  }),

  // ─── Edit ──────────────────────────────────────────────────────────────────────────────────
  "edit.undo": command({
    id: "edit.undo",
    title: "Undo",
    category: "Edit",
    args: NoArgs,
    keys: ["Mod+Z"],
    run(_args, ctx) {
      const label = ctx.doc.getState().history.undoLabel;
      return { undone: ctx.doc.undo(), label };
    },
  }),

  "edit.redo": command({
    id: "edit.redo",
    title: "Redo",
    category: "Edit",
    args: NoArgs,
    keys: ["Mod+Shift+Z", "Mod+Y"],
    run(_args, ctx) {
      const label = ctx.doc.getState().history.redoLabel;
      return { redone: ctx.doc.redo(), label };
    },
  }),

  "doc.setSource": command({
    id: "doc.setSource",
    title: "Set Source",
    category: "Model",
    description:
      "Replace the CadScript source (one undoable transaction). `coalesceKey` merges rapid edits (typing). On an IR v1 model it is a code edit: the source (CadScript v1, or v0 which is migrated) compiles to the new model, applied as the `replaceDocument` op (authorship kept, the failure rule and the commit check applied).",
    args: z.strictObject({
      source: z.string().max(5_000_000),
      label: z.string().max(200).optional(),
      coalesceKey: z.string().max(100).optional(),
    }),
    palette: false,
    async run({ source, label, coalesceKey }, ctx, meta) {
      if (ctx.doc.isV1) {
        const changed = await ctx.doc.applyCode(source, { origin: irOriginOf(meta), ...(label !== undefined ? { label } : {}) });
        return { changed, revision: ctx.doc.getState().revision };
      }
      const origin = meta.source === "ui" || meta.source === "keyboard" ? "user" : originOf(meta);
      const changed = ctx.doc.setSource(source, {
        origin,
        ...(label !== undefined ? { label } : {}),
        ...(coalesceKey !== undefined ? { coalesceKey } : {}),
      });
      return { changed, revision: ctx.doc.getState().revision };
    },
  }),

  "doc.applyIr": command({
    id: "doc.applyIr",
    title: "Apply IR Edit",
    category: "Model",
    description:
      "Apply an edited IR document: the change is spliced into the CadScript source (untouched statements and comments are kept) as one undoable transaction.",
    args: z.strictObject({ ir: IrDocumentSchema, label: z.string().max(200).optional() }),
    palette: false,
    async run({ ir, label }, ctx, meta) {
      if (ctx.doc.isV1) {
        // An IR v1 model: the (v0) document replaces it, migrated, as the replaceDocument op.
        const r = await runOps(ctx, meta, [{ op: "replaceDocument", document: JSON.stringify(ir) }], { label: label ?? "Apply IR edit" });
        return { changed: r.changed };
      }
      const { ir: oldIr, state } = await currentIr(ctx, "apply an IR edit");
      const source = await ctx.cadscript.applyIrEdit(state.source, oldIr, ir);
      if (ctx.doc.getState().source !== state.source) throw new Error("the document changed while the edit was prepared; retry");
      const changed = ctx.doc.setSource(source, { label: label ?? "Apply IR edit", origin: originOf(meta) });
      return { changed };
    },
  }),

  "feature.setSuppressed": command({
    id: "feature.setSuppressed",
    title: "Suppress Feature",
    category: "Model",
    description: "Suppress or unsuppress a feature (by id or name): on an IR v1 model the `setSuppressed` op (ir.setSuppressed); on a CadScript document, a source edit.",
    args: z.strictObject({ feature: z.string().min(1), suppressed: z.boolean() }),
    palette: false,
    async run({ feature, suppressed }, ctx, meta) {
      if (ctx.doc.isV1) {
        const r = await runOps(ctx, meta, [{ op: "setSuppressed", feature, suppressed }]);
        return { changed: r.changed, feature, suppressed };
      }
      const { ir, state } = await currentIr(ctx, suppressed ? "suppress" : "unsuppress");
      const loc = findFeature(ir, feature);
      if (!loc) throw new Error(`no feature ${feature}`);
      const next = structuredClone(ir);
      const f = next.parts[loc.partIndex]!.features[loc.featureIndex]!;
      if (suppressed) f.suppressed = true;
      else delete f.suppressed;
      const source = await ctx.cadscript.applyIrEdit(state.source, ir, next);
      if (ctx.doc.getState().source !== state.source) throw new Error("the document changed while the edit was prepared; retry");
      const changed = ctx.doc.setSource(source, {
        label: `${suppressed ? "Suppress" : "Unsuppress"} ${loc.feature.name}`,
        origin: originOf(meta),
      });
      return { changed, feature: loc.feature.name, suppressed };
    },
  }),

  "doc.recompute": command({
    id: "doc.recompute",
    title: "Recompute",
    category: "Model",
    description: "Recompile and re-evaluate the document now.",
    args: NoArgs,
    keys: ["F5"],
    async run(_args, ctx) {
      ctx.doc.recompute();
      const s = await ctx.doc.idle();
      return { status: s.report?.status ?? null, bodies: s.bodies.length, evalMs: s.timings.evalMs };
    },
  }),

  // ─── Selection ─────────────────────────────────────────────────────────────────────────────
  "selection.selectFeature": command({
    id: "selection.selectFeature",
    title: "Select Feature",
    category: "Selection",
    description: "Select a feature by id or name and (by default) reveal its statement in the code view.",
    args: z.strictObject({
      feature: z.string().min(1),
      reveal: z.boolean().default(true),
      origin: z.enum(["timeline", "viewport", "code", "command", "agent"]).default("command"),
    }),
    palette: false,
    run({ feature, reveal, origin }, ctx) {
      const s = ctx.doc.getState();
      const loc = findFeature(s.model?.ir, feature);
      if (!loc) throw new Error(`no feature ${feature}`);
      ctx.doc.select({ featureId: loc.feature.id, origin });
      const span = s.model?.spans[loc.feature.id];
      if (reveal && span && origin !== "code") ctx.editor.reveal(span);
      return { featureId: loc.feature.id, name: loc.feature.name };
    },
  }),

  "selection.selectEntity": command({
    id: "selection.selectEntity",
    title: "Select Entity",
    category: "Selection",
    description: "Select a body/face/edge by provenance name (e.g. face `plate/cap:end`); highlights its feature and reveals it in code.",
    args: z.strictObject({
      body: z.string().min(1),
      face: z.string().min(1).optional(),
      edge: z.string().min(1).optional(),
      reveal: z.boolean().default(true),
    }),
    palette: false,
    run({ body, face, edge, reveal }, ctx) {
      const entity = { body, ...(face ? { face } : {}), ...(edge ? { edge } : {}) };
      const s = ctx.doc.getState();
      const name = featureNameOfPick(entity);
      const loc = findFeature(s.model?.ir, name);
      ctx.doc.select({ featureId: loc?.feature.id ?? null, entity, origin: "viewport" });
      const span = loc ? s.model?.spans[loc.feature.id] : undefined;
      if (reveal && span) ctx.editor.reveal(span);
      return { featureId: loc?.feature.id ?? null, feature: loc?.feature.name ?? null };
    },
  }),

  "selection.clear": command({
    id: "selection.clear",
    title: "Clear Selection",
    category: "Selection",
    args: NoArgs,
    keys: ["Escape"],
    run(_args, ctx) {
      ctx.doc.clearSelection();
      return { cleared: true };
    },
  }),

  // ─── View ──────────────────────────────────────────────────────────────────────────────────
  "view.setTheme": command({
    id: "view.setTheme",
    title: "Color Theme",
    category: "View",
    args: z.strictObject({ theme: ThemeSchema }),
    palette: [
      { title: "Theme: Dark", args: { theme: "dark" } },
      { title: "Theme: Light", args: { theme: "light" } },
      { title: "Theme: Follow System", args: { theme: "system" } },
    ],
    run({ theme }, ctx) {
      ctx.ui.setTheme(theme);
      return { theme };
    },
  }),

  "view.toggleTheme": command({
    id: "view.toggleTheme",
    title: "Toggle Light/Dark Theme",
    category: "View",
    args: NoArgs,
    keys: ["Mod+Shift+L"],
    run(_args, ctx) {
      const theme = ctx.ui.getState().resolvedTheme === "dark" ? "light" : "dark";
      ctx.ui.setTheme(theme);
      return { theme };
    },
  }),

  "view.togglePanel": command({
    id: "view.togglePanel",
    title: "Toggle Panel",
    category: "View",
    args: z.strictObject({ panel: PanelSchema, visible: z.boolean().optional() }),
    palette: [
      { title: "View: Toggle Timeline", args: { panel: "left" } },
      { title: "View: Toggle Side Panel & Assistant", args: { panel: "right" } },
      { title: "View: Toggle Chat", args: { panel: "chat" } },
      { title: "View: Toggle Problems", args: { panel: "problems" } },
    ],
    run({ panel, visible }, ctx) {
      const next = visible ?? !ctx.ui.getState().panels[panel];
      ctx.ui.setPanel(panel, next);
      return { panel, visible: next };
    },
  }),

  "view.toggleCode": command({
    id: "view.toggleCode",
    title: "Show Code",
    category: "View",
    description:
      "Show or hide the code view (off by default): the model as CadScript, read-only for IR v1 models. PartZero is edited with its tools, the timeline and the assistant; the code is for reading and for power users.",
    args: z.strictObject({ visible: z.boolean().optional() }),
    palette: [{ title: "View: Show / Hide Code", args: {} }],
    run({ visible }, ctx) {
      const next = visible ?? !ctx.ui.getState().panels.code;
      ctx.ui.setPanel("code", next);
      if (next) ctx.ui.setPanel("right", true);
      return { visible: next };
    },
  }),

  "view.toggleTimeline": command({
    id: "view.toggleTimeline",
    title: "Toggle Timeline",
    category: "View",
    args: NoArgs,
    keys: ["Mod+B"],
    palette: false,
    run(_args, ctx) {
      const visible = !ctx.ui.getState().panels.left;
      ctx.ui.setPanel("left", visible);
      return { visible };
    },
  }),

  "view.toggleProblems": command({
    id: "view.toggleProblems",
    title: "Toggle Problems",
    category: "View",
    args: NoArgs,
    keys: ["Mod+J"],
    palette: false,
    run(_args, ctx) {
      const visible = !ctx.ui.getState().panels.problems;
      ctx.ui.setPanel("problems", visible);
      return { visible };
    },
  }),

  "view.commandPalette": command({
    id: "view.commandPalette",
    title: "Command Palette…",
    category: "View",
    args: NoArgs,
    keys: ["Mod+K", "Mod+Shift+P"],
    palette: false,
    run(_args, ctx) {
      ctx.ui.openDialog(ctx.ui.getState().dialog === "palette" ? null : "palette");
      return { open: ctx.ui.getState().dialog === "palette" };
    },
  }),

  "view.focusCode": command({
    id: "view.focusCode",
    title: "Focus Code Editor",
    category: "View",
    args: NoArgs,
    keys: ["Mod+Shift+E"],
    run(_args, ctx) {
      ctx.ui.setPanel("right", true);
      ctx.editor.focus();
      return { focused: true };
    },
  }),

  // ─── Engine ────────────────────────────────────────────────────────────────────────────────
  "engine.select": command({
    id: "engine.select",
    title: "Select Engine",
    category: "Engine",
    description: "Choose the evaluation engine: auto (forge-web, then the Forge CLI), forge-web or forge-cli.",
    args: z.strictObject({ engine: EngineSchema }),
    palette: [
      { title: "Engine: Automatic", args: { engine: "auto" } },
      { title: "Engine: forge-web (WASM)", args: { engine: "forge-web" } },
      { title: "Engine: Forge CLI (native)", args: { engine: "forge-cli" } },
    ],
    async run({ engine }, ctx) {
      const active = await ctx.engines.select(engine satisfies EnginePreference);
      ctx.doc.recompute();
      return { engine: active.id, label: active.label };
    },
  }),

  // ─── Chat ──────────────────────────────────────────────────────────────────────────────────
  "chat.send": command({
    id: "chat.send",
    title: "Send Chat Message",
    category: "Chat",
    description: "Send a message to the design agent, with the current selection as context chips (starts an agent run).",
    args: z.strictObject({ text: z.string().trim().min(1).max(20_000), chips: z.array(ChipSchema).optional() }),
    palette: false,
    async run({ text, chips }, ctx) {
      const c = chips ?? chipsFromSelection(ctx);
      if (!ctx.agent.getState().available) {
        ctx.ui.addChatMessage("user", text, c);
        ctx.ui.addChatMessage("system", "The design agent runs in the desktop app; your message was not sent anywhere.");
        return { delivered: false as const, reason: "AGENT_UNAVAILABLE" as const };
      }
      const { runId } = await ctx.agent.start({ prompt: text, chips: c });
      return { delivered: true as const, runId };
    },
  }),

  // ─── Agent ─────────────────────────────────────────────────────────────────────────────────
  "agent.run": command({
    id: "agent.run",
    title: "Run the Design Agent",
    category: "Agent",
    description:
      "Start an agent run on the open document. `chips` (default: the current selection) are passed as semantic context. The agent works on a draft branch and ends with a proposal to review.",
    args: z.strictObject({ prompt: z.string().trim().min(1).max(20_000), chips: z.array(ChipSchema).optional() }),
    palette: false,
    run({ prompt, chips }, ctx) {
      return ctx.agent.start({ prompt, chips: chips ?? chipsFromSelection(ctx) });
    },
  }),

  "agent.stop": command({
    id: "agent.stop",
    title: "Stop the Agent",
    category: "Agent",
    description: "Stop the running agent. It hands back its best verified state as a proposal (if it changed anything).",
    args: NoArgs,
    keys: ["Mod+."],
    enabled: (ctx) => ctx.agent.activeRun !== undefined,
    run(_args, ctx) {
      return ctx.agent.stop();
    },
  }),

  "agent.answer": command({
    id: "agent.answer",
    title: "Answer the Agent",
    category: "Agent",
    description: "Answer the agent's open clarifying question(s), one answer per question; empty answers take the default.",
    args: z.strictObject({ answers: z.array(z.string().max(2000)).min(1).max(10) }),
    palette: false,
    run({ answers }, ctx) {
      return ctx.agent.answer(answers);
    },
  }),

  "agent.accept": command({
    id: "agent.accept",
    title: "Accept Proposal",
    category: "Agent",
    description: "Apply the whole proposal to the document as one undoable transaction.",
    args: z.strictObject({ force: z.boolean().optional() }),
    palette: [{ title: "Agent: Accept Proposal", args: {} }],
    enabled: (ctx) => ctx.agent.reviewPending,
    run({ force }, ctx) {
      return ctx.agent.accept(force ? { force } : {});
    },
  }),

  "agent.acceptFeatures": command({
    id: "agent.acceptFeatures",
    title: "Accept Selected Changes",
    category: "Agent",
    description:
      "Apply only some of the proposal's changes (feature names or part/feature keys) as one undoable transaction; the rest is rejected. Refuses selections that break dependencies unless `force`.",
    args: z.strictObject({ features: z.array(z.string().min(1)).min(1), force: z.boolean().optional() }),
    palette: false,
    enabled: (ctx) => ctx.agent.reviewPending,
    run({ features, force }, ctx) {
      return ctx.agent.accept({ features, ...(force ? { force } : {}) });
    },
  }),

  "agent.setAccepted": command({
    id: "agent.setAccepted",
    title: "Tick Proposal Changes",
    category: "Agent",
    description: "Choose which changes of the proposal are ticked (updates the diff, the warnings and the preview; changes nothing yet).",
    args: z.strictObject({ features: z.array(z.string().min(1)) }),
    palette: false,
    enabled: (ctx) => ctx.agent.reviewPending,
    run({ features }, ctx) {
      return ctx.agent.setAccepted(features);
    },
  }),

  "agent.reject": command({
    id: "agent.reject",
    title: "Reject Proposal",
    category: "Agent",
    description: "Discard the proposal; the document stays unchanged.",
    args: NoArgs,
    palette: [{ title: "Agent: Reject Proposal", args: {} }],
    enabled: (ctx) => ctx.agent.reviewPending,
    run(_args, ctx) {
      return ctx.agent.reject();
    },
  }),

  "agent.setPreview": command({
    id: "agent.setPreview",
    title: "Preview Proposal in Viewport",
    category: "Agent",
    description: "Show the proposal (tinted) in the viewport instead of the current document, or switch back.",
    args: z.strictObject({ enabled: z.boolean().optional() }),
    palette: [{ title: "Agent: Toggle Proposal Preview", args: {} }],
    enabled: (ctx) => ctx.agent.reviewPending,
    run({ enabled }, ctx) {
      const next = enabled ?? !ctx.agent.getState().review?.previewEnabled;
      return { preview: ctx.agent.setPreview(next) };
    },
  }),

  "agent.showProposal": command({
    id: "agent.showProposal",
    title: "Show Proposal Diff",
    category: "Agent",
    args: z.strictObject({ visible: z.boolean().optional() }),
    palette: [{ title: "Agent: Show Proposal Diff", args: { visible: true } }],
    run({ visible }, ctx) {
      const show = visible ?? ctx.agent.getState().codeTab !== "proposal";
      ctx.ui.setPanel("right", true);
      ctx.agent.setCodeTab(show ? "proposal" : "code");
      return { tab: ctx.agent.getState().codeTab };
    },
  }),

  // ─── Settings ──────────────────────────────────────────────────────────────────────────────
  "settings.open": command({
    id: "settings.open",
    title: "Settings…",
    category: "Settings",
    description: "Open the agent settings: models per role, CLI agents, local models, optional API keys, budget.",
    args: NoArgs,
    keys: ["Mod+,"],
    async run(_args, ctx) {
      ctx.ui.openDialog("settings");
      if (ctx.host.settings) await ctx.agent.refreshSettings().catch(() => undefined);
      return { open: true };
    },
  }),

  "settings.setApiKey": command({
    id: "settings.setApiKey",
    title: "Set API Key",
    category: "Settings",
    description: "Store an API key for a provider, encrypted with the OS keychain in the desktop app. The key is never shown again (only its last 4 characters).",
    args: z.strictObject({ provider: ProviderSchema, key: z.string().trim().min(8).max(512) }),
    palette: false,
    sensitiveArgs: true,
    async run({ provider, key }, ctx) {
      const view = await ctx.agent.setApiKey(provider, key);
      const p = view.providers.find((x) => x.id === provider);
      return { provider, configured: p?.configured ?? false, last4: p?.last4 ?? null };
    },
  }),

  "settings.clearApiKey": command({
    id: "settings.clearApiKey",
    title: "Remove API Key",
    category: "Settings",
    description: "Remove the stored API key of a provider (environment variables still apply in development).",
    args: z.strictObject({ provider: ProviderSchema }),
    palette: false,
    async run({ provider }, ctx) {
      const view = await ctx.agent.clearApiKey(provider);
      const p = view.providers.find((x) => x.id === provider);
      return { provider, configured: p?.configured ?? false, source: p?.source ?? null };
    },
  }),

  "settings.setModel": command({
    id: "settings.setModel",
    title: "Set Model for Role",
    category: "Settings",
    description: "Choose the model (gateway profile id) for an agent role; null restores the default routing.",
    args: z.strictObject({ role: RoleSchema, model: z.string().min(1).max(100).nullable() }),
    palette: false,
    async run({ role, model }, ctx) {
      const view = await ctx.agent.updateSettings({ models: { [role]: model } });
      return { role, model: view.models[role], warnings: view.warnings };
    },
  }),

  "settings.setBudget": command({
    id: "settings.setBudget",
    title: "Set Task Budget",
    category: "Settings",
    description: "Per-task budget in USD (a run stops at 80 % and asks before continuing to the cap).",
    args: z.strictObject({ usd: z.number().min(0.01).max(100) }),
    palette: false,
    async run({ usd }, ctx) {
      const view = await ctx.agent.updateSettings({ budgetUsd: usd });
      return { budgetUsd: view.budgetUsd };
    },
  }),

  "settings.setCompatBaseUrl": command({
    id: "settings.setCompatBaseUrl",
    title: "Set OpenAI-compatible Base URL",
    category: "Settings",
    description: "Base URL of an OpenAI-compatible endpoint (vLLM, Ollama, OpenRouter, …); null uses each profile's default.",
    args: z.strictObject({ url: z.string().url().max(500).nullable() }),
    palette: false,
    async run({ url }, ctx) {
      const view = await ctx.agent.updateSettings({ compatBaseUrl: url });
      return { compatBaseUrl: view.compatBaseUrl };
    },
  }),

  "settings.probeProviders": command({
    id: "settings.probeProviders",
    title: "Re-check Model Providers",
    category: "Settings",
    description: "Detect the CLI agents (version, lockdown, login) and local models again now. Makes no model call.",
    args: z.strictObject({ providers: z.array(AnyProviderSchema).max(10).optional() }),
    async run({ providers }, ctx) {
      const view = await ctx.agent.probeProviders(providers);
      return {
        cli: (view.cli ?? []).map((c) => ({ id: c.id, support: c.support, auth: c.auth, version: c.version })),
        local: (view.local ?? []).map((l) => ({ id: l.id, running: l.running, models: l.models.length })),
      };
    },
  }),

  "settings.setCliPath": command({
    id: "settings.setCliPath",
    title: "Set CLI Agent Path",
    category: "Settings",
    description: "Use this binary for a CLI agent (an absolute path to the CLI itself, e.g. /opt/homebrew/bin/claude); null restores automatic detection.",
    args: z.strictObject({ provider: CliProviderSchema, path: z.string().min(1).max(1024).nullable() }),
    palette: false,
    async run({ provider, path }, ctx) {
      const view = await ctx.agent.updateSettings({ cliPaths: { [provider]: path } });
      const s = view.cli?.find((c) => c.id === provider);
      return { provider, path: s?.path ?? null, pathSource: s?.pathSource ?? null, support: s?.support ?? null };
    },
  }),

  "settings.setCliMode": command({
    id: "settings.setCliMode",
    title: "Set Agent Mode for CLI Providers",
    category: "Settings",
    description: "auto (recommended): the CLI's own agent loop for tool loops when available, single calls otherwise; completion: single calls only; runtime: always the agent loop.",
    args: z.strictObject({ mode: CliModeSchema }),
    palette: false,
    async run({ mode }, ctx) {
      const view = await ctx.agent.updateSettings({ cliMode: mode });
      return { cliMode: view.cliMode ?? mode };
    },
  }),

  "settings.setOllamaUrl": command({
    id: "settings.setOllamaUrl",
    title: "Set Ollama URL",
    category: "Settings",
    description: "Base URL of the local Ollama server (https, or http on localhost); null restores http://127.0.0.1:11434.",
    args: z.strictObject({ url: z.string().url().max(500).nullable() }),
    palette: false,
    async run({ url }, ctx) {
      const view = await ctx.agent.updateSettings({ ollamaBaseUrl: url });
      return { ollamaBaseUrl: view.ollamaBaseUrl ?? null, running: view.local?.[0]?.running ?? false };
    },
  }),

  "chat.focus": command({
    id: "chat.focus",
    title: "Focus Chat",
    category: "Chat",
    args: NoArgs,
    keys: ["Mod+L"],
    run(_args, ctx) {
      ctx.ui.setPanel("right", true);
      ctx.ui.setPanel("chat", true);
      ctx.ui.focusChat();
      return { focused: true };
    },
  }),

  // ─── Help ──────────────────────────────────────────────────────────────────────────────────
  "help.about": command({
    id: "help.about",
    title: "About aicad",
    category: "Help",
    args: NoArgs,
    run(_args, ctx) {
      ctx.ui.openDialog("about");
      return { open: true };
    },
  }),

  // ─── IR v1 command layer (SPEC-v1 §0.6, §5.9, §9.2) ──────────────────────────────────────
  ...IR_COMMANDS,

  // The viewport stream (docs/fm/view-sel-followups.md step 2): last, so its view.setView (7
  // views, animated), view.fit and view.setProjection replace the ones above.
  ...VIEWPORT_COMMANDS,
};

export type AppCommands = typeof COMMANDS;
export type AppCommandId = keyof AppCommands;
export type AppInvocation = Invocation<AppCommands>;
export type AppCommandRegistry = CommandRegistry<AppCommands, AppServices>;

export function createCommandRegistry(services: () => AppServices): AppCommandRegistry {
  return new CommandRegistry<AppCommands, AppServices>(COMMANDS, services);
}
