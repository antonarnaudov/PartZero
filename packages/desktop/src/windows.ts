/**
 * One document per window, several windows (FULL-MODELING-PLAN DOC-7): the window list, which window a document
 * opens in, where menu commands go, the unsaved-changes prompt (Save / Don't Save / Cancel) on close and quit, and
 * what each window does when it starts (a document to open, a command to run, documents to recover).
 *
 * Electron-free: it drives windows through {@link WindowLike} (a `BrowserWindow` fits), so the policy is unit-tested
 * with fakes; main.ts creates the real windows.
 */
import type { DocumentStateMessage, MenuCommandMessage, OpenPlacement, RecoveryEntry, WindowDocInfo, WindowStartup } from "@aicad/app/bridge";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the manager needs of a window (a `BrowserWindow` implements it). */
export interface WindowLike {
  readonly id: number;
  readonly webContents: { readonly id: number; send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean };
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  focus(): void;
  close(): void;
  setTitle(title: string): void;
  getNormalBounds(): Rect;
}

export type CloseAnswer = "save" | "discard" | "cancel";

export interface DocumentWindowsDeps<W extends WindowLike> {
  /** Create and load a window (main.ts wires its events to {@link DocumentWindows.attach}). */
  create(options: { bounds: Rect | null; hidden: boolean }): W;
  productName: string;
  platform: NodeJS.Platform;
  /** The unsaved-changes prompt. */
  askToSave(win: W, title: string): Promise<CloseAnswer>;
  /** `AICAD_SKIP_CLOSE_PROMPT` (tests): close without asking. */
  skipClosePrompt: boolean;
  /** Remove a window's autosave (its document was saved, or closed without saving). */
  discardRecovery(id: string): Promise<void>;
  /** Canonical form of a path, to recognise the same file under another spelling. */
  canonicalPath(path: string): string;
  /** macOS: the file shown in the title bar (only a granted path; null otherwise). */
  setRepresented?(win: W, path: string | null, dirty: boolean): void;
  /** Quit again after a prompt answered "Save" or "Don't Save" during a quit. */
  requestQuit(): void;
  /** The work area of the display a window is on (cascading new windows). */
  workArea?(bounds: Rect): Rect | null;
  log?(message: string): void;
}

interface Record<W extends WindowLike> {
  win: W;
  hidden: boolean;
  doc: DocumentStateMessage;
  info: WindowDocInfo | null;
  startup: WindowStartup;
  startupTaken: boolean;
  allowClose: boolean;
  prompting: boolean;
  pendingSaves: Map<string, (saved: boolean) => void>;
  focusSeq: number;
}

/** Commands that make sense with no window open: they open one. */
const WINDOWLESS_COMMANDS = new Set(["file.new", "file.newFromTemplate", "file.open", "file.openRecent", "file.showRecent", "file.recover", "settings.open", "help.about"]);

/** Where a new window goes: offset from the last one, back to the top left of the work area when it would leave it. */
export function cascadeBounds(from: Rect, workArea: Rect | null, step = 26): Rect {
  const next = { ...from, x: from.x + step, y: from.y + step };
  if (!workArea) return next;
  if (next.x + next.width > workArea.x + workArea.width || next.y + next.height > workArea.y + workArea.height) {
    return { ...from, x: workArea.x + step, y: workArea.y + step };
  }
  return next;
}

export class DocumentWindows<W extends WindowLike> {
  private readonly deps: DocumentWindowsDeps<W>;
  private readonly records = new Map<number, Record<W>>();
  private focusCounter = 0;
  private saveSeq = 0;
  /** A quit is in progress (set on `before-quit`; cleared when a prompt is cancelled). */
  quitting = false;

  constructor(deps: DocumentWindowsDeps<W>) {
    this.deps = deps;
  }

  /** Open a window that starts with `startup` (a document, a command, documents to recover). */
  open(startup: Partial<Omit<WindowStartup, "windowId">> = {}, options: { hidden?: boolean; bounds?: Rect | null } = {}): W {
    const last = this.lastFocused();
    let bounds = options.bounds ?? null;
    if (!bounds && last && !last.hidden) {
      const b = last.win.getNormalBounds();
      bounds = cascadeBounds(b, this.deps.workArea?.(b) ?? null);
    }
    const win = this.deps.create({ bounds, hidden: options.hidden === true });
    const rec: Record<W> = {
      win,
      hidden: options.hidden === true,
      doc: { title: "untitled", path: null, dirty: false },
      info: null,
      startup: {
        windowId: win.id,
        open: startup.open ?? null,
        command: startup.command ?? null,
        recovery: startup.recovery ?? [],
        uncleanExit: startup.uncleanExit ?? false,
      },
      startupTaken: false,
      allowClose: false,
      prompting: false,
      pendingSaves: new Map(),
      focusSeq: ++this.focusCounter,
    };
    this.records.set(win.id, rec);
    return win;
  }

  /** Every live window (hidden ones included), most recently focused first. */
  all(): W[] {
    return this.live().map((r) => r.win);
  }

  count(): number {
    return this.live().filter((r) => !r.hidden).length;
  }

  private live(): Array<Record<W>> {
    return [...this.records.values()].filter((r) => !r.win.isDestroyed()).sort((a, b) => b.focusSeq - a.focusSeq);
  }

  private lastFocused(): Record<W> | null {
    return this.live().find((r) => !r.hidden) ?? null;
  }

  /** The window that menu commands and dialogs belong to: the most recently focused visible one. */
  current(): W | null {
    return this.lastFocused()?.win ?? null;
  }

  private byContents(webContentsId: number): Record<W> | null {
    for (const r of this.records.values()) if (!r.win.isDestroyed() && r.win.webContents.id === webContentsId) return r;
    return null;
  }

  windowOf(webContentsId: number): W | null {
    return this.byContents(webContentsId)?.win ?? null;
  }

  /** A window got the focus. */
  focused(win: W): void {
    const r = this.records.get(win.id);
    if (r) r.focusSeq = ++this.focusCounter;
  }

  /** A window closed: forget it; its autosave goes unless it closed with unsaved changes that were not discarded. */
  closed(win: W): void {
    const r = this.records.get(win.id);
    this.records.delete(win.id);
    if (!r) return;
    for (const resolve of r.pendingSaves.values()) resolve(false);
    if (r.info && (r.allowClose || !r.doc.dirty || this.deps.skipClosePrompt)) void this.deps.discardRecovery(r.info.recoveryId);
  }

  /** What the window asks for once, when its app has started. */
  takeStartup(webContentsId: number): WindowStartup {
    const r = this.byContents(webContentsId);
    if (!r) throw new Error("unknown window");
    if (r.startupTaken) return { windowId: r.win.id, open: null, command: null, recovery: [], uncleanExit: false };
    r.startupTaken = true;
    return r.startup;
  }

  /** `doc:state`: the title, the dirty flag and the window's file. */
  setDocState(webContentsId: number, state: DocumentStateMessage): void {
    const r = this.byContents(webContentsId);
    if (!r) return;
    r.doc = state;
    r.win.setTitle(`${state.title}${state.dirty ? " •" : ""} — ${this.deps.productName}`);
    this.deps.setRepresented?.(r.win, state.path, state.dirty);
  }

  setDocInfo(webContentsId: number, info: WindowDocInfo): void {
    const r = this.byContents(webContentsId);
    if (r) r.info = info;
  }

  docState(win: W): DocumentStateMessage | null {
    return this.records.get(win.id)?.doc ?? null;
  }

  /** Recovery ids of live windows (their own autosaves are not offered for recovery). */
  liveRecoveryIds(): Set<string> {
    return new Set(this.live().flatMap((r) => (r.info ? [r.info.recoveryId] : [])));
  }

  /** The window that has `path` open. */
  findByPath(path: string): W | null {
    const want = this.deps.canonicalPath(path);
    return this.live().find((r) => r.doc.path !== null && this.deps.canonicalPath(r.doc.path) === want)?.win ?? null;
  }

  private reveal(win: W): void {
    if (win.isMinimized()) win.restore();
    win.focus();
  }

  /**
   * Open `path` for the window `requester`: focus the window that already has it; else use the requester when it
   * allows it (its document is untitled and unchanged); else open a new window.
   */
  openDocument(requesterContentsId: number | null, path: string, allowHere: boolean): OpenPlacement {
    const existing = this.findByPath(path);
    if (existing) {
      this.reveal(existing);
      return "existing";
    }
    const r = requesterContentsId === null ? null : this.byContents(requesterContentsId);
    if (r && allowHere) return "here";
    this.open({ open: path });
    return "new";
  }

  /** A document the OS asked us to open (Finder double-click, `open-file`, a second instance's argv). */
  openFromOs(path: string): void {
    const existing = this.findByPath(path);
    if (existing) {
      this.reveal(existing);
      return;
    }
    // An untitled, unchanged window is reused (the most recently focused one), as a new window would be empty anyway.
    const empty = this.live().find((r) => !r.hidden && r.info?.pristine === true && r.startupTaken && !r.win.webContents.isDestroyed());
    if (empty) {
      empty.win.webContents.send("files:event", { type: "open", path });
      this.reveal(empty.win);
      return;
    }
    this.open({ open: path });
  }

  /** A native menu command: to the current window; with none, commands that open something open a window. */
  sendCommand(message: MenuCommandMessage): void {
    const cur = this.lastFocused();
    if (cur && !cur.win.webContents.isDestroyed()) {
      cur.win.webContents.send("menu:command", message);
      return;
    }
    if (!WINDOWLESS_COMMANDS.has(message.id)) return;
    this.open(message.id === "file.new" ? {} : { command: message });
  }

  /** Ask a window to save (the close prompt's "Save"); resolves with whether it saved. */
  requestSave(win: W): Promise<boolean> {
    const r = this.records.get(win.id);
    if (!r || win.webContents.isDestroyed()) return Promise.resolve(false);
    const requestId = `save-${++this.saveSeq}`;
    return new Promise((resolve) => {
      r.pendingSaves.set(requestId, resolve);
      win.webContents.send("files:event", { type: "saveBeforeClose", requestId });
    });
  }

  saveFinished(webContentsId: number, requestId: string, saved: boolean): void {
    const r = this.byContents(webContentsId);
    const resolve = r?.pendingSaves.get(requestId);
    if (!r || !resolve) return;
    r.pendingSaves.delete(requestId);
    resolve(saved);
  }

  /**
   * A window's `close` event. Returns whether the close may proceed now; when it returns false the caller must
   * `preventDefault()` (the prompt runs, and the window closes itself afterwards if the user agrees).
   */
  onClose(win: W): boolean {
    const r = this.records.get(win.id);
    if (!r || r.allowClose || r.hidden) return true;
    if (!r.doc.dirty || this.deps.skipClosePrompt) return true;
    if (r.prompting) return false;
    r.prompting = true;
    void this.deps
      .askToSave(win, r.doc.title)
      .then(async (answer) => {
        if (answer === "cancel") return false;
        if (answer === "save") return this.requestSave(win);
        return true;
      })
      .then(
        (proceed) => {
          r.prompting = false;
          if (!proceed) {
            this.quitting = false;
            return;
          }
          r.allowClose = true;
          if (!win.isDestroyed()) win.close();
          if (this.quitting) this.deps.requestQuit();
        },
        (e: unknown) => {
          r.prompting = false;
          this.quitting = false;
          this.deps.log?.(`close prompt failed: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
    return false;
  }

  /** The renderer of `win` crashed: reload it and offer its last autosave. */
  rendererGone(win: W, recovery: RecoveryEntry | null): boolean {
    const r = this.records.get(win.id);
    if (!r || r.hidden || !recovery) return false;
    r.startup = { windowId: win.id, open: null, command: null, recovery: [recovery], uncleanExit: true };
    r.startupTaken = false;
    r.info = null;
    r.doc = { ...r.doc, dirty: false };
    return true;
  }

  recoveryIdOf(win: W): string | null {
    return this.records.get(win.id)?.info?.recoveryId ?? null;
  }
}
