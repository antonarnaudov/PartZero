/**
 * The shell: which tool is active and its property panel, the mode (model / sketch), the dock tabs,
 * the welcome screen and the shortcuts map. It is UI state, never document state and never undoable
 * (like `UiStore`); documents change only through the command layer.
 *
 * One shell per window. `attachShell(services, shell)` makes it reachable from commands
 * (`shellOf(ctx)`) without widening `AppServices`.
 */
import type { AppCommandRegistry, AppInvocation } from "../commands/commands";
import type { CommandRegistry, CommandResult, CommandSource, PaletteItem } from "../commands/registry";
import type { RenderBody } from "../engine/types";
import { BLANK_SOURCE } from "../host/templates";
import type { AppServices } from "../services";
import { Store } from "../store";
import { docDocumentPort, docParamsPort, docSelectionPort } from "./framework/ports";
import { PanelSession, type CloseReason } from "./framework/session";
import type { DocumentPort, Enablement, HandlesPort, OpsPort, PanelSpec, ParamsPort, SelectionPort, ShellMode, ToolContext, ToolDefinition } from "./framework/types";
import { PanelHandles } from "./framework/handles";
import { featurePropertiesPanel } from "./builtin/features";
import { appOpsPort } from "./framework/v1-ops";
import { ToolRegistry } from "./registry";

export type RightTab = "properties" | "code" | "proposal" | (string & {});

export interface ShellState {
  mode: ShellMode;
  /** The open property panel (null: none). */
  panel: PanelSession | null;
  /** The tool that opened it (null: a panel opened by a command, or none). */
  activeToolId: string | null;
  /** The last tool started (for "repeat last tool"). */
  lastToolId: string | null;
  /** A tool whose `activate` is still running. */
  startingToolId: string | null;
  leftTab: string;
  rightTab: RightTab;
  /**
   * Welcome screen: `auto` shows it while the document is a pristine blank document; `open` shows it
   * regardless (Help → Welcome); `dismissed` hides it until the next blank document.
   */
  welcome: "auto" | "open" | "dismissed";
  dialog: "shortcuts" | null;
  /** Bumped to ask the property panel to focus its first field. */
  focusTick: number;
  /**
   * Bodies the open panel's last passing preview shows in the viewport instead of the document's
   * (null: none). Only the open panel's current preview sets them; closing it clears them.
   */
  previewBodies: readonly RenderBody[] | null;
  /** A newer check of the panel is running: the preview bodies may not match its fields any more. */
  previewStale: boolean;
}

export interface ShellPorts {
  selection: SelectionPort;
  params: ParamsPort;
  /** The document's revision and features (the IR v1 store's once bound). */
  document: DocumentPort;
  /** Where tools' ops are applied as one transaction (the IR v1 store's transaction once bound). */
  ops: OpsPort;
  /** Where panels' manipulator handles are drawn (the viewport's; null: no handles, e.g. headless). */
  handles: HandlesPort | null;
}

/** What starting a tool did. */
export interface StartResult {
  started: boolean;
  panel: boolean;
  reason?: string;
}

/** Any command registry over the app services (the app's, or the shell's own until they merge). */
export type AnyCommandRegistry = CommandRegistry<any, AppServices>;

export interface ShellOptions {
  services: AppServices;
  commands: AppCommandRegistry;
  /**
   * The shell's own commands (`tools/commands.ts`) while they are not yet part of the app's
   * registry. Omit once `SHELL_COMMANDS` is spread into `COMMANDS`.
   */
  shellCommands?: AnyCommandRegistry;
  tools?: ToolRegistry;
  ports?: Partial<ShellPorts>;
}

const shells = new WeakMap<AppServices, Shell>();

export function attachShell(services: AppServices, shell: Shell): void {
  shells.set(services, shell);
}

/** The shell attached to a command context. Throws when there is none (a headless harness). */
export function shellOf(services: AppServices): Shell {
  const s = shells.get(services);
  if (!s) throw new Error("the app shell is not running (no window)");
  return s;
}

/** The document is a new, unsaved, untouched document with no features. */
export function isBlankDocument(services: AppServices): boolean {
  const s = services.doc.getState();
  if (s.path !== null || s.dirty) return false;
  const ir = s.model?.ir ?? s.compile?.ir ?? null;
  // Before the first compile: the starter document (no flash of the workspace at startup).
  if (!ir) return s.source.trim() === "" || s.source === BLANK_SOURCE;
  return ir.parts.every((p) => p.features.length === 0);
}

export class Shell extends Store<ShellState> {
  readonly services: AppServices;
  readonly commands: AppCommandRegistry;
  /** The registries commands are looked up in, in order: the app's first. */
  readonly registries: readonly AnyCommandRegistry[];
  readonly tools: ToolRegistry;
  private ports: ShellPorts;
  private panelSeq = 1;
  private lastDocId: number;
  /** The open panel's handles (null: none). */
  panelHandles: PanelHandles | null = null;

  constructor(options: ShellOptions) {
    super({
      mode: "model",
      panel: null,
      activeToolId: null,
      lastToolId: null,
      startingToolId: null,
      leftTab: "timeline",
      rightTab: "code",
      welcome: "auto",
      dialog: null,
      focusTick: 0,
      previewBodies: null,
      previewStale: false,
    });
    this.services = options.services;
    this.commands = options.commands;
    this.registries = options.shellCommands ? [options.commands, options.shellCommands] : [options.commands];
    this.tools = options.tools ?? new ToolRegistry();
    this.ports = {
      selection: options.ports?.selection ?? docSelectionPort(options.services.doc),
      params: options.ports?.params ?? docParamsPort(options.services.doc),
      document: options.ports?.document ?? docDocumentPort(options.services.doc),
      ops: options.ports?.ops ?? appOpsPort(options.services, (cmd, source) => this.commands.executeUnknown(cmd, { source })),
      handles: options.ports?.handles ?? null,
    };
    this.tools.reserveKeys(this.commandKeymap());
    this.lastDocId = options.services.doc.getState().docId;
    // A newly loaded blank document brings the welcome screen back (File → New).
    options.services.doc.subscribe(() => {
      const d = options.services.doc.getState();
      if (d.docId === this.lastDocId) return;
      this.lastDocId = d.docId;
      if (this.getState().welcome === "dismissed") this.setState({ welcome: "auto" });
      this.setPreview(null, false);
      // A tool never outlives its document.
      this.getState().panel?.replace();
    });
  }

  // ─── Commands ─────────────────────────────────────────────────────────────────────────────

  /** The registry that has a command id (the app's wins). */
  registryFor(id: string): AnyCommandRegistry | undefined {
    return this.registries.find((r) => r.has(id));
  }

  /** Run a command from any registry (menus, palette, keyboard, tests). */
  execute(cmd: { id: string; args?: unknown }, source: CommandSource = "ui"): Promise<CommandResult<unknown>> {
    const r = this.registryFor(cmd.id) ?? this.commands;
    return r.executeUnknown({ id: cmd.id, args: cmd.args ?? {} }, { source });
  }

  isCommandEnabled(id: string): boolean {
    return this.registryFor(id)?.isEnabled(id) ?? false;
  }

  /** Normalized key → command id over every registry (first registration wins). */
  commandKeymap(): Map<string, string> {
    const m = new Map<string, string>();
    for (const r of this.registries) for (const [k, id] of r.keymap()) if (!m.has(k)) m.set(k, id);
    return m;
  }

  /** Palette items of every registry. */
  paletteItems(): PaletteItem[] {
    return this.registries.flatMap((r) => r.paletteItems());
  }

  /**
   * Replace the selection, parameter, document or ops source (the selection workstream, the IR v1
   * store). Panels opened afterwards use the new ones.
   */
  bindPorts(ports: Partial<ShellPorts>): void {
    this.ports = { ...this.ports, ...ports };
  }

  get selection(): SelectionPort {
    return this.ports.selection;
  }

  get params(): ParamsPort {
    return this.ports.params;
  }

  get document(): DocumentPort {
    return this.ports.document;
  }

  // ─── Tools ────────────────────────────────────────────────────────────────────────────────

  private context(toolId: string | null, args: Readonly<Record<string, unknown>> = {}): ToolContext {
    return {
      services: this.services,
      run: (cmd: AppInvocation): Promise<CommandResult<unknown>> => this.commands.executeUnknown(cmd, { source: "ui" }),
      selection: this.ports.selection,
      params: this.ports.params,
      document: this.ports.document,
      mode: this.getState().mode,
      args,
      openPanel: (spec) => this.openPanel(spec, toolId, args),
      notify: (kind, message) => this.services.ui.toast(kind, message),
    };
  }

  /** Whether a tool can start now: `true`, or `{ reason }`. */
  enablement(tool: ToolDefinition): Enablement {
    const modes = tool.modes ?? ["model"];
    if (!modes.includes(this.getState().mode)) {
      return { reason: `${tool.label} is available in ${modes.map((m) => (m === "model" ? "model" : "sketch")).join(" and ")} mode` };
    }
    if (!tool.enabledWhen) return true;
    try {
      const r = tool.enabledWhen(this.context(tool.id));
      if (r === true) return true;
      if (r === false) return { reason: `${tool.label} is not available right now` };
      return r;
    } catch (e) {
      return { reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Start a tool: the toolbar, its shortcut, the palette and `tool.start` all come here. Replaces an
   * open panel (cancelling it). `args` prefill the panel's inputs by field key (`tool.start { id,
   * args }`). Resolves to what happened; never throws.
   */
  startTool(id: string, source: CommandSource = "ui", args: Readonly<Record<string, unknown>> = {}): Promise<StartResult> {
    const tool = this.tools.get(id);
    if (!tool) return Promise.resolve({ started: false, panel: false, reason: this.tools.isHidden(id) ? `${id} is not in this build yet (its flag is off)` : `unknown tool: ${id}` });
    return this.launch(tool, source, args, (ctx) => tool.activate(ctx));
  }

  /**
   * Re-edit a feature (`feature.edit`, the timeline's double-click): the tool whose `features` lists
   * its type opens its panel prefilled with `fromFeature`. Resolves to what happened; never throws.
   */
  editFeature(idOrName: string, source: CommandSource = "ui"): Promise<StartResult & { tool?: string }> {
    const feature = this.ports.document.feature(idOrName);
    if (!feature) return Promise.resolve({ started: false, panel: false, reason: `there is no feature ${idOrName}` });
    const tool = this.tools.list().find((t) => t.fromFeature && t.features?.includes(feature.type));
    if (!tool?.fromFeature) {
      // No dedicated tool yet: the feature's own property panel (name, numbers, choices).
      if (!this.services.doc.isV1) return Promise.resolve({ started: false, panel: false, reason: `no tool edits ${feature.type} features yet` });
      this.openPanel(featurePropertiesPanel(feature), null);
      return Promise.resolve({ started: true, panel: true, tool: "feature.properties" });
    }
    const fromFeature = tool.fromFeature.bind(tool);
    return this.launch(tool, source, {}, (ctx) => fromFeature(feature, ctx)).then((r) => ({ ...r, tool: tool.id }));
  }

  private async launch(tool: ToolDefinition, source: CommandSource, args: Readonly<Record<string, unknown>>, open: (ctx: ToolContext) => void | PanelSpec | Promise<void | PanelSpec>): Promise<StartResult> {
    const id = tool.id;
    const en = this.enablement(tool);
    if (en !== true) return { started: false, panel: false, reason: en.reason };
    this.getState().panel?.replace();
    this.setState({ startingToolId: id, lastToolId: id });
    const before = this.getState().panel;
    try {
      const spec = await open(this.context(id, args));
      if (spec && (!this.getState().panel || this.getState().panel === before)) this.openPanel(spec, id, args);
      else if (!spec && Object.keys(args).length > 0 && this.getState().panel === before) throw new Error(`${tool.label} has no inputs to set`);
    } catch (e) {
      // Nothing is left open: a panel the tool opened before failing is cancelled.
      const opened = this.getState().panel;
      if (opened && opened !== before && opened.getState().toolId === id) opened.cancel();
      const message = e instanceof Error ? e.message : String(e);
      if (source !== "agent" && source !== "mcp" && source !== "test") this.services.ui.toast("error", `${tool.label}: ${message}`);
      return { started: false, panel: false, reason: message };
    } finally {
      if (this.getState().startingToolId === id) this.setState({ startingToolId: null });
    }
    const panel = this.getState().panel;
    return { started: true, panel: panel !== null && !panel.closed && panel.getState().toolId === id };
  }

  /** Start the last tool again (Space in model mode, like Fusion's "repeat"). */
  repeatLastTool(): Promise<StartResult> {
    const last = this.getState().lastToolId;
    return last ? this.startTool(last) : Promise.resolve({ started: false, panel: false, reason: "no tool was used yet" });
  }

  /**
   * Open a property panel (replacing the current one) and show it. `args` override the spec's initial
   * values by field key; an unknown key or a value a field can't take throws (nothing opens).
   */
  openPanel(spec: PanelSpec, toolId: string | null = null, args: Readonly<Record<string, unknown>> = {}): PanelSession {
    this.getState().panel?.replace();
    const icon = spec.icon ?? (toolId ? this.tools.get(toolId)?.icon : undefined);
    const withArgs: PanelSpec = Object.keys(args).length > 0 ? { ...spec, initial: { ...spec.initial, ...(args as PanelSpec["initial"]) } } : spec;
    // Assigned once constructed: the session reports its first (empty) preview state from its constructor.
    let opened: PanelSession | null = null;
    const session: PanelSession = new PanelSession(icon && !spec.icon ? { ...withArgs, icon } : withArgs, {
      id: this.panelSeq++,
      toolId,
      params: this.ports.params,
      selection: this.ports.selection,
      document: this.ports.document,
      ops: this.ports.ops,
      onClose: (reason: CloseReason, s: PanelSession) => this.onPanelClosed(reason, s),
      // Only the open panel's current preview draws; a closed or replaced panel's late result is dropped.
      onPreviewBodies: (bodies, stale) => {
        if (opened !== null && this.getState().panel === opened && !opened.closed) this.setPreview(bodies, stale);
      },
    });
    opened = session;
    // Handles bound to the panel's number fields (plan §2.6); they go when the panel closes.
    if (spec.handles && this.ports.handles) this.panelHandles = new PanelHandles(session, spec, this.ports.handles, this.ports.document);
    else this.panelHandles = null;
    this.services.ui.setPanel("right", true);
    this.setState((s) => ({ panel: session, activeToolId: toolId, rightTab: "properties", focusTick: s.focusTick + 1 }));
    return session;
  }

  private setPreview(bodies: readonly RenderBody[] | null, stale: boolean): void {
    this.setState({ previewBodies: bodies, previewStale: bodies !== null && stale });
  }

  private onPanelClosed(_reason: CloseReason, session: PanelSession): void {
    if (this.getState().panel !== session) return;
    this.panelHandles?.dispose();
    this.panelHandles = null;
    this.setPreview(null, false);
    // Back to what the code dock showed before (the agent may have opened its proposal meanwhile).
    const codeTab = this.services.agent.getState().codeTab;
    this.setState((s) => ({ panel: null, activeToolId: null, rightTab: s.rightTab === "properties" ? codeTab : s.rightTab }));
  }

  /** OK on the open panel. */
  async commitPanel(source: CommandSource = "ui"): Promise<CommandResult<{ committed: boolean; message?: string }>> {
    const panel = this.getState().panel;
    if (!panel) return { ok: false, error: { code: "DISABLED", message: "No tool is active" } };
    const r = await panel.commit(source);
    if (r.ok) return { ok: true, value: { committed: true, ...(r.message ? { message: r.message } : {}) } };
    return { ok: false, error: { code: "FAILED", message: r.errors.map((e) => e.message).join(" ") || "The tool could not commit" } };
  }

  /** Cancel (Esc) the open panel; true when there was one. */
  cancelPanel(): boolean {
    const panel = this.getState().panel;
    if (!panel) return false;
    panel.cancel();
    return true;
  }

  // ─── Mode, docks, welcome, dialogs ────────────────────────────────────────────────────────

  setMode(mode: ShellMode): void {
    if (mode === this.getState().mode) return;
    this.getState().panel?.replace();
    this.setState({ mode });
  }

  setLeftTab(id: string): void {
    this.setState({ leftTab: id });
  }

  setRightTab(tab: RightTab): void {
    this.setState({ rightTab: tab });
  }

  showWelcome(): void {
    this.setState({ welcome: "open" });
  }

  dismissWelcome(): void {
    this.setState({ welcome: "dismissed" });
  }

  /** Whether the welcome screen shows now. */
  welcomeVisible(): boolean {
    const w = this.getState().welcome;
    if (w === "open") return true;
    if (w === "dismissed") return false;
    if (this.services.agent.getState().activeRunId !== null || this.services.agent.getState().review) return false;
    return isBlankDocument(this.services);
  }

  openDialog(dialog: ShellState["dialog"]): void {
    this.setState({ dialog });
  }

  closeDialog(): void {
    this.setState({ dialog: null });
  }
}
