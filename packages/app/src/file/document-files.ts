/**
 * The document layer of one window (FULL-MODELING-PLAN §2.9, DOC workstream): New / Open / Save / Save As / Revert
 * with `.partzero` files (plain `.cad.ts` and `.json` stay as the git and agent formats), the window title and dirty
 * marker, autosave into the recovery store and restoring after a crash, one document per window, reference meshes
 * (imported STL / 3MF / OBJ: displayed and measured, never edited), exports, and the recent-documents grid.
 *
 * It reaches the document store only through a {@link DocumentAdapter} and the platform only through a
 * {@link FileHost}, so it runs the same against the desktop shell, the browser and the tests' in-memory host.
 */
import type { DocumentStateMessage, RecentDocument, RecoveryEntry } from "../bridge";
import type { ForgeEngine, RenderBody } from "../engine/types";
import { Store } from "../store";
import type { DocumentAdapter, LoadRequest, SaveCapture } from "./adapter";
import { documentName } from "./adapter";
import { exportFormat } from "./export-formats";
import type { FileHost } from "./host";
import { measureMesh, meshFormatOf, meshToRenderBody, readMesh, type MeshFormat, type MeshMeasure } from "./mesh";
import {
  decodePartZero,
  EMPTY_VIEW_STATE,
  encodePartZero,
  isPartZeroPath,
  PartZeroError,
  sha256Hex,
  type PartZeroContents,
  type ReferenceEntry,
  type ViewState,
} from "./partzero";
import { renderThumbnail } from "./thumbnail";

/** Display colour of reference meshes (a cool grey-blue, distinct from modelled bodies). */
export const REFERENCE_TINT: [number, number, number] = [0.52, 0.62, 0.78];

export interface ReferenceMesh {
  entry: ReferenceEntry;
  /** The imported file, kept as it was (the `.partzero` stores it as a blob). */
  bytes: Uint8Array;
  measure: MeshMeasure;
  body: RenderBody;
}

export type FilesDialog =
  | { kind: "recovery"; entries: RecoveryEntry[]; uncleanExit: boolean }
  | { kind: "export"; format: string | null }
  | { kind: "recent"; items: RecentDocument[] }
  | null;

export interface FilesState {
  /** This window's autosave id in the recovery store. */
  recoveryId: string;
  references: ReferenceMesh[];
  /** References changed since the document was loaded or saved (they are not in the store's undo history). */
  extraDirty: boolean;
  dialog: FilesDialog;
  autosave: { at: number | null; error: string | null };
  /** Warnings from the last open or restore. */
  warnings: string[];
}

export interface DocumentFilesDeps {
  adapter: DocumentAdapter;
  host: FileHost;
  toast(kind: "info" | "success" | "error", message: string): void;
  confirm(message: string): Promise<boolean>;
  /** The window title, dirty marker and close prompt (the shell's `doc:state`). */
  setDocumentState(state: DocumentStateMessage): void;
  engine(): ForgeEngine;
  /** Run a command (a startup command sent by the shell, e.g. Open in a window that did not exist yet). */
  runCommand(command: { id: string; args?: unknown }): Promise<unknown>;
  generator: { app: string; version: string };
  fitView?(): void;
  /** Autosave this long after the last change (default 4 s), and at least every `autosaveMaxMs` while editing. */
  autosaveDelayMs?: number;
  autosaveMaxMs?: number;
  newRecoveryId?(): string;
  now?(): number;
}

const OPEN_FILTERS = [
  { name: "Documents (PartZero, CadScript, IR JSON)", extensions: ["partzero", "ts", "json"] },
  { name: "PartZero", extensions: ["partzero"] },
  { name: "CadScript", extensions: ["ts"] },
  { name: "IR JSON", extensions: ["json"] },
];
const SAVE_FILTERS = [
  { name: "PartZero", extensions: ["partzero"] },
  { name: "CadScript", extensions: ["ts"] },
  { name: "IR JSON", extensions: ["json"] },
];
const MESH_FILTERS = [
  { name: "Meshes (STL, 3MF, OBJ)", extensions: ["stl", "3mf", "obj"] },
  { name: "STL", extensions: ["stl"] },
  { name: "3MF", extensions: ["3mf"] },
  { name: "OBJ", extensions: ["obj"] },
];

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `w${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** `x × y × z mm`, for toasts and the References panel. */
export function formatSize(m: MeshMeasure): string {
  return `${m.size.map((v) => (Math.round(v * 100) / 100).toString()).join(" × ")} mm`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type SaveFormat = "partzero" | "cadscript" | "ir-json";

export function saveFormatOf(path: string): SaveFormat {
  if (isPartZeroPath(path)) return "partzero";
  return /\.json$/i.test(path) ? "ir-json" : "cadscript";
}

/** What a `.partzero` carries that this layer does not edit, kept from open to save. */
interface Carry {
  annotations: Record<string, string>;
  checkpoints: Record<string, Uint8Array>;
  view: ViewState;
}

const EMPTY_CARRY: Carry = { annotations: {}, checkpoints: {}, view: EMPTY_VIEW_STATE };

export class DocumentFiles extends Store<FilesState> {
  private readonly deps: DocumentFilesDeps;
  private carry: Carry = EMPTY_CARRY;
  private lastDocId = -1;
  private loading = 0;
  private lastPushed = "";
  private lastInfo = "";
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  private autosaveFirstPending: number | null = null;
  /** What the last autosave captured: the store's revision and the references' version. */
  private snapshotKey: string | null = null;
  private hasSnapshot = false;
  private unsubscribers: Array<() => void> = [];
  private refSeq = 0;
  /** Saves run one after another, so they mark the document saved in the order their files were written. */
  private saving: Promise<unknown> = Promise.resolve();

  constructor(deps: DocumentFilesDeps) {
    super({ recoveryId: (deps.newRecoveryId ?? randomId)(), references: [], extraDirty: false, dialog: null, autosave: { at: null, error: null }, warnings: [] });
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** The store's revision plus the references (which are not in the store). */
  private changeKey(revision: number, references: readonly ReferenceMesh[] = this.getState().references): string {
    const refs = references.map((r) => `${r.entry.id}:${r.entry.visible ? 1 : 0}`).join(",");
    return `${revision}|${refs}`;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────────────────

  /** Start tracking the document (title, autosave), then do what the window was opened for. */
  async start(): Promise<void> {
    this.lastDocId = this.deps.adapter.info().docId;
    this.unsubscribers.push(this.deps.adapter.subscribe(() => this.onDocumentChange()));
    this.unsubscribers.push(this.subscribe(() => this.onDocumentChange()));
    this.unsubscribers.push(this.deps.host.onEvent((e) => void this.onHostEvent(e)));
    this.onDocumentChange();
    const w = this.deps.host.windows;
    if (!w) return;
    const s = await w.startup();
    if (s.open) await this.openPath(s.open).catch((e: unknown) => this.deps.toast("error", message(e)));
    if (s.command) await this.deps.runCommand(s.command);
    if (s.recovery.length > 0) this.setState({ dialog: { kind: "recovery", entries: s.recovery, uncleanExit: s.uncleanExit } });
  }

  dispose(): void {
    for (const u of this.unsubscribers.splice(0)) u();
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  private async onHostEvent(e: { type: "open"; path: string } | { type: "saveBeforeClose"; requestId: string }): Promise<void> {
    if (e.type === "open") {
      await this.openPath(e.path).catch((err: unknown) => this.deps.toast("error", message(err)));
      return;
    }
    let saved = false;
    try {
      saved = (await this.save()).saved;
    } catch (err) {
      this.deps.toast("error", message(err));
    }
    this.deps.host.windows?.saveFinished(e.requestId, saved);
  }

  /** Unsaved changes: the store's, or references added or removed. */
  isDirty(): boolean {
    return this.deps.adapter.info().dirty || this.getState().extraDirty;
  }

  /** Untitled and unchanged: another document may replace it without asking. */
  isPristine(): boolean {
    const i = this.deps.adapter.info();
    return i.path === null && !i.dirty && !this.getState().extraDirty && this.getState().references.length === 0;
  }

  private onDocumentChange(): void {
    const info = this.deps.adapter.info();
    if (info.docId !== this.lastDocId) {
      this.lastDocId = info.docId;
      // Another document was loaded by something other than this layer (e.g. a template): it has no references.
      if (this.loading === 0 && (this.getState().references.length > 0 || this.getState().extraDirty)) {
        this.carry = EMPTY_CARRY;
        this.setState({ references: [], extraDirty: false });
        return; // setState re-enters
      }
    }
    const dirty = info.dirty || this.getState().extraDirty;
    const state: DocumentStateMessage = { title: info.name, path: info.path, dirty };
    const key = `${state.title}\u0000${state.path ?? ""}\u0000${dirty}`;
    // Always re-sent after the store's own push (bootstrap), which does not know about references.
    if (key !== this.lastPushed || info.dirty !== dirty) {
      this.lastPushed = key;
      this.deps.setDocumentState(state);
    }
    const docInfo = { pristine: this.isPristine(), recoveryId: this.getState().recoveryId };
    const infoKey = `${docInfo.pristine}`;
    if (infoKey !== this.lastInfo) {
      this.lastInfo = infoKey;
      this.deps.host.windows?.setDocInfo(docInfo);
    }
    this.scheduleAutosave(dirty, info.revision);
  }

  // ─── Autosave and recovery ─────────────────────────────────────────────────────────────────

  private scheduleAutosave(dirty: boolean, revision: number): void {
    const rec = this.deps.host.recovery;
    if (!rec) return;
    if (!dirty) {
      if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
      this.autosaveFirstPending = null;
      this.snapshotKey = null;
      if (this.hasSnapshot) {
        this.hasSnapshot = false;
        void rec.discard(this.getState().recoveryId).catch(() => undefined);
      }
      return;
    }
    if (this.snapshotKey === this.changeKey(revision)) return;
    const delay = this.deps.autosaveDelayMs ?? 4000;
    const max = this.deps.autosaveMaxMs ?? 30_000;
    const now = this.now();
    this.autosaveFirstPending ??= now;
    const wait = Math.max(0, Math.min(delay, this.autosaveFirstPending + max - now));
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.flushRecovery().catch(() => undefined);
    }, wait);
  }

  /** Write this window's autosave now (the timer does it after edits; tests and quitting call it directly). */
  async flushRecovery(): Promise<{ written: boolean }> {
    const rec = this.deps.host.recovery;
    if (!rec || !this.isDirty()) return { written: false };
    const info = this.deps.adapter.info();
    this.autosaveFirstPending = null;
    try {
      const { bytes, capture, references } = await this.encode(false);
      const id = this.getState().recoveryId;
      await rec.write({ id, title: info.name, path: info.path, data: bytes });
      // The key of what was captured, not of what the store holds now: edits made while writing still get autosaved.
      this.snapshotKey = this.changeKey(capture.revision, references);
      if (!this.isDirty()) {
        // Saved while this snapshot was being written: it would only offer the saved file back after the next crash.
        this.hasSnapshot = false;
        this.snapshotKey = null;
        await rec.discard(id);
        return { written: false };
      }
      this.hasSnapshot = true;
      this.setState({ autosave: { at: this.now(), error: null } });
      return { written: true };
    } catch (e) {
      this.setState({ autosave: { at: this.getState().autosave.at, error: message(e) } });
      throw e;
    }
  }

  /** Documents a crash left behind (not this window's own autosave). */
  async showRecovery(): Promise<{ entries: number }> {
    const rec = this.deps.host.recovery;
    if (!rec) throw new Error("Recovering unsaved documents needs the desktop app.");
    const entries = await rec.list();
    if (entries.length === 0) {
      this.deps.toast("info", "There are no unsaved documents to recover.");
      this.setState({ dialog: null });
      return { entries: 0 };
    }
    this.setState({ dialog: { kind: "recovery", entries, uncleanExit: false } });
    return { entries: entries.length };
  }

  /**
   * Restore an autosave into this window (when it is pristine) or into a new one. The restored document has unsaved
   * changes: its own file (when it had one) is the saved state, so Undo goes back to it and Save writes it.
   */
  async restoreRecovery(id: string): Promise<{ restored: boolean; placement: "here" | "new" }> {
    const rec = this.deps.host.recovery;
    if (!rec) throw new Error("Recovering unsaved documents needs the desktop app.");
    if (!this.isPristine() && this.deps.host.windows) {
      await this.deps.host.windows.newWindow({ command: { id: "file.restoreRecovery", args: { id } } });
      this.dropRecoveryEntry(id);
      return { restored: true, placement: "new" };
    }
    const entries = await rec.list();
    const meta = entries.find((e) => e.id === id);
    const bytes = await rec.read(id);
    const decoded = decodePartZero(bytes, { validateDocument: this.deps.adapter.validateDocument });
    const path = meta?.path ?? null;
    let base: LoadRequest | null = null;
    let baseWarning: string | null = null;
    if (path) {
      try {
        base = await this.savedRequest(path);
      } catch (e) {
        baseWarning = `The saved file ${baseName(path)} could not be read (${message(e)}); the recovered document is shown as new changes.`;
      }
    }
    const name = path ? documentName(path) : (meta?.title ?? "recovered");
    const request = { ...this.requestFrom(path, name, decoded.contents), recoveredFrom: { base } };
    const warnings = await this.loadContents(request, decoded.contents, [...decoded.warnings, ...(baseWarning ? [baseWarning] : [])], true);
    await rec.discard(id);
    this.dropRecoveryEntry(id);
    this.deps.toast("success", `Recovered “${name}”${warnings.length ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})` : ""}`);
    return { restored: true, placement: "here" };
  }

  async discardRecovery(id: string): Promise<{ discarded: boolean }> {
    const rec = this.deps.host.recovery;
    if (!rec) return { discarded: false };
    await rec.discard(id);
    this.dropRecoveryEntry(id);
    return { discarded: true };
  }

  private dropRecoveryEntry(id: string): void {
    const d = this.getState().dialog;
    if (d?.kind !== "recovery") return;
    const entries = d.entries.filter((e) => e.id !== id);
    this.setState({ dialog: entries.length ? { ...d, entries } : null });
  }

  // ─── New, open, save ────────────────────────────────────────────────────────────────────────

  private async confirmDiscard(): Promise<boolean> {
    if (!this.isDirty()) return true;
    return this.deps.confirm(`Discard unsaved changes to “${this.deps.adapter.info().name}”?`);
  }

  /** A new untitled document: in a new window unless this one is pristine (desktop); here after a prompt (web). */
  async newDocument(): Promise<{ created: boolean; placement: "here" | "new" }> {
    const w = this.deps.host.windows;
    if (w && !this.isPristine()) {
      await w.newWindow();
      return { created: true, placement: "new" };
    }
    if (!(await this.confirmDiscard())) return { created: false, placement: "here" };
    this.loading++;
    try {
      this.resetExtras();
      this.deps.adapter.loadBlank();
    } finally {
      this.loading--;
    }
    return { created: true, placement: "here" };
  }

  /** A new document from code (a template): here when this window is pristine, else in a new window. */
  async newFromCode(name: string, source: string, command: { id: string; args?: unknown }): Promise<{ created: boolean; placement: "here" | "new" }> {
    const w = this.deps.host.windows;
    if (w && !this.isPristine()) {
      await w.newWindow({ command });
      return { created: true, placement: "new" };
    }
    if (!(await this.confirmDiscard())) return { created: false, placement: "here" };
    this.loading++;
    try {
      this.resetExtras();
      await this.deps.adapter.load({ path: null, name, documentJson: null, code: { source, matchesDocument: false } });
    } finally {
      this.loading--;
    }
    return { created: true, placement: "here" };
  }

  private resetExtras(): void {
    this.carry = EMPTY_CARRY;
    this.setState({ references: [], extraDirty: false, warnings: [] });
  }

  /** Open a document (asks for it without `path`): see {@link openPath} for which window it opens in. */
  async open(path?: string): Promise<{ opened: boolean; path?: string; placement?: "existing" | "here" | "new" }> {
    const target = path ?? (await this.deps.host.pickOpen({ title: "Open", filters: OPEN_FILTERS }));
    if (!target) return { opened: false };
    return this.openPath(target);
  }

  /**
   * Open `path`: the window that already has it comes to the front; else it opens here when this window is
   * pristine; else in a new window (desktop). The web build opens here after a prompt.
   */
  async openPath(path: string): Promise<{ opened: boolean; path: string; placement: "existing" | "here" | "new" }> {
    const w = this.deps.host.windows;
    if (w) {
      const { placement } = await w.openDocument(path, { allowHere: this.isPristine() });
      if (placement !== "here") return { opened: true, path, placement };
    } else if (!(await this.confirmDiscard())) {
      return { opened: false, path, placement: "here" };
    }
    await this.loadFile(path);
    return { opened: true, path, placement: "here" };
  }

  /** Load `path` into this window, replacing its document (no prompt: callers decide). */
  async loadFile(path: string): Promise<void> {
    const name = documentName(path);
    if (isPartZeroPath(path)) {
      const bytes = await this.deps.host.readBytes(path);
      let decoded;
      try {
        decoded = decodePartZero(bytes, { validateDocument: this.deps.adapter.validateDocument });
      } catch (e) {
        if (e instanceof PartZeroError) throw new Error(`Cannot open ${baseName(path)}: ${e.message} [${e.code}]`);
        throw e;
      }
      await this.loadContents(this.requestFrom(path, name, decoded.contents), decoded.contents, decoded.warnings, false);
    } else {
      const text = await this.deps.host.readText(path);
      this.loading++;
      try {
        this.resetExtras();
        await this.deps.adapter.loadText(path, name, text);
      } finally {
        this.loading--;
      }
    }
    this.deps.fitView?.();
  }

  private requestFrom(path: string | null, name: string, c: PartZeroContents): LoadRequest {
    return { path, name, documentJson: c.document.json, code: c.code };
  }

  /** The document as saved in `path` (any of the three formats), as a load request. */
  private async savedRequest(path: string): Promise<LoadRequest> {
    const name = documentName(path);
    if (isPartZeroPath(path)) {
      const c = decodePartZero(await this.deps.host.readBytes(path), { validateDocument: this.deps.adapter.validateDocument }).contents;
      return this.requestFrom(path, name, c);
    }
    const text = await this.deps.host.readText(path);
    return /\.json$/i.test(path) ? { path, name, documentJson: text, code: null } : { path, name, documentJson: null, code: { source: text, matchesDocument: false } };
  }

  private async loadContents(request: LoadRequest, contents: PartZeroContents, fileWarnings: string[], recovered: boolean): Promise<string[]> {
    const warnings = [...fileWarnings];
    const references: ReferenceMesh[] = [];
    for (const entry of contents.references) {
      const bytes = contents.blobs[entry.blob.slice("blobs/".length)];
      if (!bytes) continue;
      try {
        references.push(this.materialize(entry, bytes));
      } catch (e) {
        warnings.push(`The reference mesh “${entry.name}” could not be read and was left out: ${message(e)}`);
      }
    }
    this.loading++;
    try {
      warnings.push(...(await this.deps.adapter.load(request)));
      this.carry = { annotations: contents.annotations, checkpoints: contents.checkpoints, view: contents.view };
      this.refSeq = references.reduce((n, r) => Math.max(n, Number(/^ref(\d+)$/.exec(r.entry.id)?.[1] ?? 0)), 0);
      this.setState({ references, extraDirty: recovered && references.length > 0, warnings });
    } finally {
      this.loading--;
    }
    this.onDocumentChange();
    for (const w of warnings) this.deps.toast("info", w);
    return warnings;
  }

  private materialize(entry: ReferenceEntry, bytes: Uint8Array): ReferenceMesh {
    const mesh = readMesh(bytes, entry.format);
    if (entry.scale !== 1) for (let i = 0; i < mesh.positions.length; i++) mesh.positions[i] = mesh.positions[i]! * entry.scale;
    return { entry, bytes, measure: measureMesh(mesh), body: meshToRenderBody(mesh, `ref:${entry.id}`, REFERENCE_TINT) };
  }

  /** Save to the document's file, or ask for one (untitled, or not a format this build writes back). */
  async save(): Promise<{ saved: boolean; path?: string; format?: SaveFormat }> {
    const path = this.deps.adapter.info().path;
    if (path && !path.startsWith("download:") && !path.startsWith("browser:")) return this.saveTo(path);
    return this.saveAs();
  }

  async saveAs(path?: string): Promise<{ saved: boolean; path?: string; format?: SaveFormat }> {
    const info = this.deps.adapter.info();
    const suggested = `${info.path ? documentName(info.path) : info.name}.partzero`;
    const target = path ?? (await this.deps.host.pickSave({ title: "Save As", defaultPath: suggested, filters: SAVE_FILTERS }));
    if (!target) return { saved: false };
    return this.saveTo(target);
  }

  /**
   * Save to `path` in the format its extension names. Saves are queued one after another. What is written is what
   * the save captured when it started: edits (or reference changes) made while it runs stay unsaved, so the title,
   * close prompt and autosave keep protecting them (`upToDate: false`).
   */
  saveTo(path: string): Promise<{ saved: true; path: string; format: SaveFormat; bytes: number; upToDate: boolean }> {
    const run = this.saving.then(() => this.saveNow(path));
    this.saving = run.catch(() => undefined);
    return run;
  }

  private async saveNow(path: string): Promise<{ saved: true; path: string; format: SaveFormat; bytes: number; upToDate: boolean }> {
    const format = saveFormatOf(path);
    const name = documentName(path);
    let written: number;
    let capture: SaveCapture;
    let references: readonly ReferenceMesh[];
    if (format === "partzero") {
      const e = await this.encode(true);
      ({ capture, references } = e);
      const r = await this.deps.host.writeDocument(path, e.bytes, e.thumbnail);
      written = r.bytes;
    } else {
      references = this.getState().references;
      const t = await this.deps.adapter.textFor(format);
      capture = t.capture;
      const r = await this.deps.host.writeDocument(path, t.text, null);
      written = r.bytes;
      if (references.length > 0) this.deps.toast("info", `Reference meshes are kept only in .partzero files; ${baseName(path)} has the model and its code.`);
    }
    const result = this.deps.adapter.markSaved(path, name, capture);
    // References are immutable arrays: a different one means they changed while the file was being written.
    if (result !== "replaced") this.setState({ extraDirty: this.getState().references !== references });
    this.onDocumentChange();
    const upToDate = result === "clean" && !this.isDirty();
    this.deps.toast("success", `Saved ${baseName(path)} (${formatBytes(written)})${upToDate ? "" : "; changes made while saving are not in it yet"}`);
    return { saved: true, path, format, bytes: written, upToDate };
  }

  /** Reload the document from its file, dropping unsaved changes (after a prompt). */
  async revert(): Promise<{ reverted: boolean }> {
    const path = this.deps.adapter.info().path;
    if (!path) throw new Error("This document has never been saved, so there is nothing to revert to.");
    if (this.isDirty() && !(await this.deps.confirm(`Revert “${this.deps.adapter.info().name}” to the saved version? Your unsaved changes will be lost.`))) return { reverted: false };
    await this.loadFile(path);
    return { reverted: true };
  }

  /** Close this window (the shell asks about unsaved changes). */
  async close(): Promise<{ closing: boolean }> {
    const w = this.deps.host.windows;
    if (!w) throw new Error("Closing windows needs the desktop app.");
    await w.close();
    return { closing: true };
  }

  /** The document as a `.partzero` file, with a thumbnail when `withThumbnail`, and what it captured. */
  async encode(withThumbnail: boolean): Promise<{ bytes: Uint8Array; thumbnail: Uint8Array | null; capture: SaveCapture; references: readonly ReferenceMesh[] }> {
    const snap = await this.deps.adapter.snapshot();
    const refs = this.getState().references;
    const visibleRefs = refs.filter((r) => r.entry.visible).map((r) => r.body);
    const thumb = withThumbnail ? renderThumbnail([...snap.bodies, ...visibleRefs]) : null;
    const blobs: Record<string, Uint8Array> = {};
    for (const r of refs) blobs[r.entry.blob.slice("blobs/".length)] = r.bytes;
    const contents: PartZeroContents = {
      generator: { ...this.deps.generator, forgeBuild: null },
      document: { json: snap.documentJson, irSchema: snap.irSchema },
      code: snap.code,
      thumbnail: thumb,
      annotations: this.carry.annotations,
      blobs,
      cache: {},
      checkpoints: this.carry.checkpoints,
      view: this.carry.view,
      references: refs.map((r) => r.entry),
    };
    return { bytes: encodePartZero(contents), thumbnail: thumb?.png ?? null, capture: snap.capture, references: refs };
  }

  // ─── Reference meshes ──────────────────────────────────────────────────────────────────────

  /** Import an STL, 3MF or OBJ file as a reference mesh (asks for it without `path`). */
  async importReference(path?: string): Promise<{ imported: boolean; id?: string; measure?: MeshMeasure }> {
    const target = path ?? (await this.deps.host.pickOpen({ title: "Import Mesh as Reference", filters: MESH_FILTERS }));
    if (!target) return { imported: false };
    const format: MeshFormat | null = meshFormatOf(target);
    if (!format) throw new Error(`${baseName(target)} is not an STL, 3MF or OBJ file.`);
    const bytes = await this.deps.host.readBytes(target);
    const sha = sha256Hex(bytes);
    const id = `ref${++this.refSeq}`;
    const entry: ReferenceEntry = {
      id,
      name: documentName(target).replace(/\.(stl|3mf|obj)$/i, "").slice(0, 200) || id,
      blob: `blobs/${sha}.${format}`,
      format,
      units: "mm",
      scale: 1,
      visible: true,
      sourceName: baseName(target).slice(0, 500),
    };
    const ref = this.materialize(entry, bytes);
    this.setState((s) => ({ references: [...s.references, ref], extraDirty: true }));
    const m = ref.measure;
    this.deps.toast(
      "success",
      `Imported ${entry.sourceName} as a reference: ${formatSize(m)}, ${m.triangles.toLocaleString("en-US")} triangles${m.volume === null ? " (open mesh: no volume)" : ""}`,
    );
    setTimeout(() => this.deps.fitView?.(), 50);
    return { imported: true, id, measure: m };
  }

  removeReference(id: string): { removed: boolean } {
    const refs = this.getState().references;
    if (!refs.some((r) => r.entry.id === id)) throw new Error(`no reference mesh ${id}`);
    this.setState({ references: refs.filter((r) => r.entry.id !== id), extraDirty: true });
    return { removed: true };
  }

  setReferenceVisible(id: string, visible: boolean): { visible: boolean } {
    const refs = this.getState().references;
    const i = refs.findIndex((r) => r.entry.id === id);
    if (i < 0) throw new Error(`no reference mesh ${id}`);
    if (refs[i]!.entry.visible === visible) return { visible };
    const next = refs.map((r, k) => (k === i ? { ...r, entry: { ...r.entry, visible } } : r));
    this.setState({ references: next, extraDirty: true });
    return { visible };
  }

  /** Display bodies of the visible reference meshes. */
  referenceBodies(): RenderBody[] {
    return this.getState()
      .references.filter((r) => r.entry.visible)
      .map((r) => r.body);
  }

  // ─── Export ────────────────────────────────────────────────────────────────────────────────

  openExportDialog(format: string | null = null): void {
    this.setState({ dialog: { kind: "export", format } });
  }

  /** Export in `formatId` (asks where without `path`). */
  async export(formatId: string, path?: string): Promise<{ exported: boolean; path?: string; format?: string; bytes?: number }> {
    const f = exportFormat(formatId);
    if (!f) throw new Error(`unknown export format: ${formatId}`);
    const engine = this.deps.engine();
    const ok = f.available({ engine });
    if (!ok.ok) throw new Error(`${f.label} export is not available: ${ok.reason}`);
    const irJson = await this.deps.adapter.exportIrJson(`export ${f.label}`);
    const info = this.deps.adapter.info();
    const name = info.path ? documentName(info.path) : info.name;
    const target =
      path ?? (await this.deps.host.pickSave({ title: `Export ${f.label}`, defaultPath: `${name}.${f.extensions[0]}`, filters: [{ name: f.label, extensions: f.extensions }] }));
    if (!target) return { exported: false };
    const bytes = await f.run({ irJson, engine, name });
    await this.deps.host.writeExport(target, bytes);
    if (this.getState().dialog?.kind === "export") this.setState({ dialog: null });
    this.deps.toast("success", `Exported ${baseName(target)} (${formatBytes(bytes.length)})`);
    return { exported: true, path: target, format: f.id, bytes: bytes.length };
  }

  // ─── Recent documents ──────────────────────────────────────────────────────────────────────

  async showRecent(): Promise<{ count: number }> {
    const items = await this.deps.host.recent();
    this.setState({ dialog: { kind: "recent", items } });
    return { count: items.length };
  }

  /** The thumbnail saved with a recent document (PNG), or null. */
  thumbnail(path: string): Promise<Uint8Array | null> {
    return this.deps.host.thumbnail(path).catch(() => null);
  }

  async clearRecent(): Promise<{ cleared: boolean }> {
    await this.deps.host.clearRecent();
    if (this.getState().dialog?.kind === "recent") this.setState({ dialog: { kind: "recent", items: [] } });
    return { cleared: true };
  }

  closeDialog(): void {
    this.setState({ dialog: null });
  }

  /** A JSON summary for the agent, tests and the status bar. */
  status(): {
    path: string | null;
    name: string;
    dirty: boolean;
    pristine: boolean;
    recoveryId: string;
    autosavedAt: number | null;
    references: Array<{ id: string; name: string; format: string; visible: boolean; triangles: number; size: [number, number, number]; area: number; volume: number | null; closed: boolean }>;
  } {
    const info = this.deps.adapter.info();
    const s = this.getState();
    return {
      path: info.path,
      name: info.name,
      dirty: this.isDirty(),
      pristine: this.isPristine(),
      recoveryId: s.recoveryId,
      autosavedAt: s.autosave.at,
      references: s.references.map((r) => ({
        id: r.entry.id,
        name: r.entry.name,
        format: r.entry.format,
        visible: r.entry.visible,
        triangles: r.measure.triangles,
        size: r.measure.size,
        area: r.measure.area,
        volume: r.measure.volume,
        closed: r.measure.closed,
      })),
    };
  }
}
