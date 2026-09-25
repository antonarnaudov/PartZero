/**
 * What the model panels (timeline, browser, parameters, problems) do to a feature. Every action
 * is a command of the one command layer (`ir.*`, `feature.edit`, `selection.*`), the same the
 * assistant and MCP call; the panels add only the dialogs a person needs (the dependents of a
 * delete, a new name).
 */
import { Store } from "../../store";
import type { AppServices } from "../../services";
import type { Shell } from "../../tools/shell";
import { editSketchFeature } from "../../sketch/integration";

export interface Dependent {
  id: string;
  name: string;
  type: string;
}

export interface ModelDialogState {
  /** Delete a feature that others are built on: the dependents it takes with it. */
  delete: { feature: string; name: string; type: string; dependents: Dependent[] } | null;
  /** Rename a feature, a parameter: a small editor at `anchor` (viewport pixels). */
  rename: { kind: "feature" | "param"; id: string; name: string; anchor: { x: number; y: number; w: number } } | null;
}

class ModelDialogStore extends Store<ModelDialogState> {
  constructor() {
    super({ delete: null, rename: null });
  }
  set(patch: Partial<ModelDialogState>): void {
    this.setState({ delete: null, rename: null, ...patch });
  }
}

/** The model panels' dialogs (one at a time; the app's global keys wait while one is open). */
export const modelDialogs = new ModelDialogStore();

export interface ModelActionContext {
  services: AppServices;
  shell: Shell;
}

type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; detail?: { code: string; details?: Record<string, unknown> } } };

function exec(ctx: ModelActionContext, id: string, args: Record<string, unknown> = {}): Promise<Result> {
  return ctx.shell.execute({ id, args }, "ui") as Promise<Result>;
}

export function openModelDialog(ctx: ModelActionContext, patch: Partial<ModelDialogState>): void {
  modelDialogs.set(patch);
  if (ctx.services.ui.getState().dialog === null) ctx.services.ui.openDialog("model");
}

export function closeModelDialog(ctx: ModelActionContext): void {
  modelDialogs.set({});
  if (ctx.services.ui.getState().dialog === "model") ctx.services.ui.closeDialog();
}

/** Select a feature in the document (timeline, browser, code, chat chips). */
export function selectFeature(ctx: ModelActionContext, feature: string): void {
  void exec(ctx, "selection.selectFeature", { feature, origin: "timeline" });
}

/** Edit: a sketch opens in sketch mode, any other feature in its property panel. */
export function editFeature(ctx: ModelActionContext, f: { id: string; type: string }): void {
  if (f.type === "sketch" && editSketchFeature(f.id)) return;
  void exec(ctx, "feature.edit", { feature: f.id });
}

/**
 * Delete a feature. With nothing built on it, it goes at once (one undo step); otherwise the
 * dialog lists what it takes with it (the engine's own dependents: references are by id, so
 * dependents cannot stay behind).
 */
export async function requestDelete(ctx: ModelActionContext, f: { id: string; name: string; type: string }): Promise<void> {
  const r = await exec(ctx, "ir.dependents", { feature: f.id });
  const deps = r.ok ? ((r.value as { dependents?: Dependent[] }).dependents ?? []) : [];
  if (deps.length === 0) {
    const d = await exec(ctx, "ir.deleteFeature", { feature: f.id });
    if (d.ok) toastUndo(ctx, `Deleted ${f.name}`);
    return;
  }
  openModelDialog(ctx, { delete: { feature: f.id, name: f.name, type: f.type, dependents: deps } });
}

export async function confirmDelete(ctx: ModelActionContext): Promise<void> {
  const d = modelDialogs.getState().delete;
  closeModelDialog(ctx);
  if (!d) return;
  const r = await exec(ctx, "ir.deleteFeature", { feature: d.feature, dependents: "cascade" });
  if (r.ok) toastUndo(ctx, `Deleted ${d.name} and ${d.dependents.length} feature${d.dependents.length === 1 ? "" : "s"} built on it`);
}

function toastUndo(ctx: ModelActionContext, message: string): void {
  ctx.services.ui.toast("info", message, 5000, { label: "Undo", run: () => void exec(ctx, "edit.undo") });
}

export function startRename(ctx: ModelActionContext, target: { kind: "feature" | "param"; id: string; name: string }, el: Element | null): void {
  const r = el?.getBoundingClientRect();
  const anchor = r ? { x: r.left, y: r.top, w: r.width } : { x: window.innerWidth / 2 - 120, y: window.innerHeight / 2, w: 240 };
  openModelDialog(ctx, { rename: { ...target, anchor } });
}

export async function commitRename(ctx: ModelActionContext, name: string): Promise<void> {
  const r = modelDialogs.getState().rename;
  closeModelDialog(ctx);
  const next = name.trim();
  if (!r || next === "" || next === r.name) return;
  if (r.kind === "feature") await exec(ctx, "ir.renameFeature", { feature: r.id, name: next });
  else await exec(ctx, "ir.renameParam", { old: r.id, new: next });
}

export function setSuppressed(ctx: ModelActionContext, f: { id: string; suppressed: boolean }, v1: boolean): void {
  void exec(ctx, v1 ? "ir.setSuppressed" : "feature.setSuppressed", { feature: f.id, suppressed: !f.suppressed });
}

/** Roll back to just after `feature` (null: roll to the end, everything built). */
export function rollTo(ctx: ModelActionContext, feature: string | null): Promise<Result> {
  return exec(ctx, "ir.setRollback", { after: feature });
}

export function moveFeature(ctx: ModelActionContext, feature: string, after: string | null): Promise<Result> {
  return exec(ctx, "ir.moveFeature", { feature, after });
}

export function keepFeatures(ctx: ModelActionContext, features: readonly string[]): void {
  if (features.length > 0) void exec(ctx, "ir.setAuthor", { features: [...features], author: "user" });
}
