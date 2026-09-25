/**
 * The top of the window: a title row (brand, file and edit commands, the Solid / Sketch workspace
 * tabs, the document, command search, the assistant toggle, theme, settings) and the tool ribbon.
 * The Solid ribbon is every group of the tool registry (Sketch, Create, Pattern, Modify, Construct,
 * Inspect, Print) with Export and Open in Bambu Studio at its right end; the Sketch ribbon holds the
 * sketcher's tools, constraints and Finish (`ribbon.tsx`).
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import type { AppInvocation } from "../../commands/commands";
import { formatKey } from "../../commands/registry";
import { useFilesState } from "../../file/ui/hooks";
import { sketchMode } from "../../sketch/instance";
import { TOOL_GROUPS, type ToolDefinition, type ToolGroupInfo } from "../../tools/framework/types";
import { SKETCH_TOOLS, type ToolId } from "../../tools/sketch";
import { useApp, useStore } from "../context";
import { Icon } from "../icons";
import { ToolIcon as SketchToolIcon } from "../sketch/tool-icons";
import { BrandLockup } from "./BrandMark";
import { useShell, useShellState } from "./context";
import { slotRef, useSketching, useWorkspace, workspaceTab, type Workspace } from "./ribbon";
import { OpenInSlicerButton } from "./SlicerButton";
import { ToolIcon } from "./tool-icons";

function CommandButton({ cmd, title, keyHint, children, disabled, testId }: { cmd: AppInvocation; title: string; keyHint?: string; children: ReactElement; disabled?: boolean; testId?: string }): ReactElement {
  const { run, isMac } = useApp();
  const label = keyHint ? `${title} (${formatKey(keyHint, isMac)})` : title;
  return (
    <button type="button" className="tb-btn" title={label} aria-label={title} disabled={disabled} onClick={() => run(cmd)} data-testid={testId}>
      {children}
    </button>
  );
}

function useTools(): readonly ToolDefinition[] {
  const { shell } = useShell();
  return useSyncExternalStore(shell.tools.subscribe, () => shell.tools.getState().tools);
}

/** Re-render when anything a tool's `enabledWhen` may read changes (document, selection, agent, shell). */
function useEnablementDeps(): void {
  const { services } = useApp();
  useStore(services.doc, (s) => `${s.docId}:${s.revision}:${s.phase}:${s.selection.featureId ?? ""}:${s.selection.entity?.face ?? s.selection.entity?.edge ?? s.selection.entity?.body ?? ""}`);
  useStore(services.doc, (s) => s.report);
  useStore(services.agent, (s) => s.activeRunId);
  useShellState((s) => `${s.mode}:${s.activeToolId ?? ""}`);
}

function ToolButton({ tool }: { tool: ToolDefinition }): ReactElement {
  const { shell } = useShell();
  const { isMac } = useApp();
  const active = useShellState((s) => s.activeToolId === tool.id || s.startingToolId === tool.id);
  useEnablementDeps();
  const en = shell.enablement(tool);
  const key = tool.shortcut ? ` (${formatKey(tool.shortcut, isMac)})` : "";
  const title = en === true ? `${tool.label}${key}${tool.description ? `\n${tool.description}` : ""}` : `${tool.label}${key}\n${en.reason}`;
  return (
    <button
      type="button"
      className={`rb-tool${active ? " active" : ""}`}
      title={title}
      aria-label={tool.label}
      aria-pressed={active}
      aria-disabled={en !== true}
      data-testid={`tool-${tool.id}`}
      onClick={() => {
        if (en !== true) {
          shell.services.ui.toast("info", en.reason);
          return;
        }
        void shell.startTool(tool.id);
      }}
    >
      <ToolIcon name={tool.icon} size={22} />
      <span className="rb-tool-label">{tool.label}</span>
    </button>
  );
}

function GroupMenu({ group, tools, onClose }: { group: ToolGroupInfo; tools: readonly ToolDefinition[]; onClose: () => void }): ReactElement {
  const { shell } = useShell();
  const { isMac } = useApp();
  const ref = useRef<HTMLDivElement>(null);
  // Registered once: re-registering on every render would drop an Escape that arrives while another
  // window listener's update re-renders the menu (listeners added during a dispatch never run).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      // The group label toggles the menu itself; any other click outside the menu closes it.
      const t = e.target as Element | null;
      if (ref.current?.contains(t as Node)) return;
      if (t?.closest?.(".rb-group-label") && ref.current?.parentElement?.contains(t)) return;
      close.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    ref.current?.querySelector<HTMLButtonElement>("button:not([aria-disabled=true])")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);
  return (
    <div className="rb-menu" role="menu" aria-label={`${group.label} tools`} ref={ref} data-testid={`group-menu-${group.id}`}>
      <div className="rb-menu-head">{group.description}</div>
      {tools.map((t) => {
        const en = shell.enablement(t);
        return (
          <button
            key={t.id}
            type="button"
            role="menuitem"
            className="rb-menu-item"
            aria-disabled={en !== true}
            title={en === true ? (t.description ?? t.label) : en.reason}
            onClick={() => {
              onClose();
              if (en === true) void shell.startTool(t.id);
              else shell.services.ui.toast("info", en.reason);
            }}
          >
            <ToolIcon name={t.icon} size={15} />
            <span className="rb-menu-label">{t.label}</span>
            {t.shortcut && <kbd>{formatKey(t.shortcut, isMac)}</kbd>}
          </button>
        );
      })}
    </div>
  );
}

function ToolGroup({ group, tools }: { group: ToolGroupInfo; tools: readonly ToolDefinition[] }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="rb-group" role="group" aria-label={group.label} data-testid={`group-${group.id}`}>
      <div className="rb-tools">
        {tools.map((t) => (
          <ToolButton key={t.id} tool={t} />
        ))}
      </div>
      <button type="button" className={`rb-group-label${open ? " open" : ""}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`group-label-${group.id}`}>
        {group.label}
        <Icon.Chevron size={9} />
      </button>
      {open && <GroupMenu group={group} tools={tools} onClose={() => setOpen(false)} />}
    </div>
  );
}


/** The Solid workspace's group order (Fusion's SOLID tab: Create, Modify, Construct, Inspect). */
const SOLID_ORDER = ["sketch", "create", "pattern", "modify", "construct", "inspect", "print"] as const;

/** The sketcher's tools, shown (dimmed) on the Sketch tab before a sketch is open: a click starts one. */
function SketchStarter(): ReactElement {
  const { shell } = useShell();
  const start = (tool: ToolId | null): void => {
    const newSketch = shell.tools.getState().tools.find((t) => t.id === "sketch.new");
    void (newSketch ? shell.startTool("sketch.new") : Promise.resolve(sketchMode.requestNew()));
    if (!tool) return;
    // Pick the tool as soon as the sketch is open (after the plane or face is chosen).
    const off = sketchMode.subscribe(() => {
      const p = sketchMode.getState().phase;
      if (p === "active") {
        off();
        sketchMode.setTool(tool);
      } else if (p === "off") off();
    });
  };
  const draw = SKETCH_TOOLS.filter((t) => t.group === "draw");
  const modify = SKETCH_TOOLS.filter((t) => t.group !== "draw" && t.group !== "select");
  return (
    <>
      <div className="rb-group" role="group" aria-label="Sketch" data-testid="sketch-start-group">
        <div className="rb-tools">
          <button type="button" className="rb-tool rb-tool-hero" title="Create Sketch (⇧S)\nPick a plane or a planar face, then draw" onClick={() => start(null)} data-testid="ribbon-create-sketch">
            <ToolIcon name="sketch" size={22} />
            <span className="rb-tool-label">Create Sketch</span>
          </button>
        </div>
        <span className="rb-caption">Sketch</span>
      </div>
      {[
        { id: "draw", label: "Create", tools: draw },
        { id: "modify", label: "Modify", tools: modify },
      ].map((g) => (
        <div key={g.id} className="rb-group rb-preview" role="group" aria-label={`${g.label} (sketch)`}>
          <div className="rb-tools compact">
            {g.tools.map((t) => (
              <button key={t.id} type="button" className="rb-tool icon-only" title={`${t.label}${t.key ? ` (${t.key.toUpperCase()})` : ""}\nStarts a sketch first`} aria-label={t.label} onClick={() => start(t.id)}>
                <SketchToolIcon id={t.id} size={20} />
              </button>
            ))}
          </div>
          <span className="rb-caption">{g.label}</span>
        </div>
      ))}
      <span className="rb-hint">Pick a plane or a planar face to start a sketch.</span>
    </>
  );
}

/** Export: the document layer's dialog (3MF, STL, OBJ, STEP) when it is installed, else a 3MF straight away. */
function ExportButton(): ReactElement {
  const { shell } = useShell();
  const { isMac } = useApp();
  const dialog = shell.isCommandEnabled("file.export");
  return (
    <button
      type="button"
      className="tb-btn tb-labelled"
      title={`${dialog ? "Export: 3MF, STL, OBJ or STEP" : "Export 3MF"} (${formatKey("Mod+E", isMac)})`}
      aria-label="Export"
      onClick={() => void shell.execute(dialog ? { id: "file.export" } : { id: "file.exportMesh", args: { format: "3mf" } }, "ui")}
      data-testid="tb-export"
    >
      <Icon.Export />
      <span>Export</span>
    </button>
  );
}

export function ToolRibbon(): ReactElement {
  const tools = useTools();
  const mode = useShellState((s) => s.mode);
  const workspace = useWorkspace();
  const sketching = useSketching();
  const inMode = (t: ToolDefinition): boolean => (t.modes ?? ["model"]).includes(mode);
  const byId = new Map(TOOL_GROUPS.map((g) => [g.id, g]));
  const groups = SOLID_ORDER.map((id) => ({ group: byId.get(id)!, tools: tools.filter((t) => t.group === id && inMode(t)) })).filter((g) => g.group && g.tools.length > 0);

  if (workspace === "sketch") {
    return (
      <div className="ribbon" role="toolbar" aria-label="Sketch tools" data-testid="ribbon" data-mode={mode} data-workspace="sketch">
        {(sketching || mode === "sketch") && (
          <span className="rb-mode" data-testid="mode-badge" ref={slotRef("title")}>
            <ToolIcon name="sketch" size={16} />
            {!sketching && <span>Sketch</span>}
          </span>
        )}
        {mode === "sketch" && groups.map(({ group, tools: ts }) => <ToolGroup key={group.id} group={group} tools={ts} />)}
        {sketching ? <div className="rb-slot" ref={slotRef("tools")} data-testid="ribbon-sketch-tools" /> : mode !== "sketch" && <SketchStarter />}
        <span className="spacer" />
        {sketching && <div className="rb-slot rb-actions" ref={slotRef("actions")} data-testid="ribbon-sketch-actions" />}
      </div>
    );
  }
  return (
    <div className="ribbon" role="toolbar" aria-label="Tools" data-testid="ribbon" data-mode={mode} data-workspace="solid">
      {groups.map(({ group, tools: ts }) => (
        <ToolGroup key={group.id} group={group} tools={ts} />
      ))}
      {groups.length === 0 && <span className="rb-empty">No tools in model mode yet.</span>}
      <span className="spacer" />
      <div className="rb-print">
        <ExportButton />
        <OpenInSlicerButton />
      </div>
    </div>
  );
}

/** The title bar's workspace tabs (Fusion's SOLID / SKETCH): they switch the ribbon. */
function WorkspaceTabs(): ReactElement {
  const workspace = useWorkspace();
  const sketching = useSketching();
  const tab = (id: Workspace, label: string, disabled: string | null): ReactElement => (
    <button
      type="button"
      role="tab"
      className={`ws-tab${workspace === id ? " active" : ""}`}
      aria-selected={workspace === id}
      aria-disabled={disabled !== null}
      title={disabled ?? `${label} tools`}
      onClick={() => disabled === null && workspaceTab.set(id)}
      data-testid={`ws-tab-${id}`}
    >
      {label}
    </button>
  );
  return (
    <div className="ws-tabs" role="tablist" aria-label="Workspace">
      {tab("solid", "Solid", sketching ? "Finish or cancel the sketch first" : null)}
      {tab("sketch", "Sketch", null)}
    </div>
  );
}

export function TitleBar(): ReactElement {
  const { services, run, isMac } = useApp();
  const name = useStore(services.doc, (s) => s.name);
  const dirty = useStore(services.doc, (s) => s.dirty);
  const format = useStore(services.doc, (s) => s.format);
  const isPartZero = useStore(services.doc, (s) => /\.partzero$/i.test(s.path ?? ""));
  const isJson = useStore(services.doc, (s) => /\.json$/i.test(s.path ?? ""));
  const isCadScript = useStore(services.doc, (s) => /\.ts$/i.test(s.path ?? ""));
  // Reference meshes added or removed are unsaved changes too (they are not in the store).
  const refsDirty = useFilesState().extraDirty;
  const canUndo = useStore(services.doc, (s) => s.history.canUndo);
  const canRedo = useStore(services.doc, (s) => s.history.canRedo);
  const undoLabel = useStore(services.doc, (s) => s.history.undoLabel);
  const redoLabel = useStore(services.doc, (s) => s.history.redoLabel);
  const theme = useStore(services.ui, (s) => s.resolvedTheme);
  const assistant = useStore(services.ui, (s) => s.panels.right);
  const platform = services.host.platform;
  return (
    <header className={`toolbar titlebar platform-${platform}`} data-testid="toolbar">
      <div className="tb-left">
        <BrandLockup size={22} />
        <div className="tb-group">
          <CommandButton cmd={{ id: "file.new" }} title="New" keyHint="Mod+N" testId="tb-new">
            <Icon.File />
          </CommandButton>
          <CommandButton cmd={{ id: "file.newFromTemplate" }} title="New from template" keyHint="Mod+Shift+N" testId="tb-template">
            <Icon.Template />
          </CommandButton>
          <CommandButton cmd={{ id: "file.open" }} title="Open" keyHint="Mod+O" testId="tb-open">
            <Icon.FolderOpen />
          </CommandButton>
          <CommandButton cmd={{ id: "file.save" }} title="Save" keyHint="Mod+S" testId="tb-save">
            <Icon.Save />
          </CommandButton>
        </div>
        <div className="tb-group">
          <CommandButton cmd={{ id: "edit.undo" }} title={undoLabel ? `Undo ${undoLabel}` : "Undo"} keyHint="Mod+Z" disabled={!canUndo} testId="tb-undo">
            <Icon.Undo />
          </CommandButton>
          <CommandButton cmd={{ id: "edit.redo" }} title={redoLabel ? `Redo ${redoLabel}` : "Redo"} keyHint="Mod+Shift+Z" disabled={!canRedo} testId="tb-redo">
            <Icon.Redo />
          </CommandButton>
        </div>
        <WorkspaceTabs />
      </div>
      <div className="doc-title" data-testid="doc-title" title={format === "ir-v1" ? "PartZero model (IR v1)" : format === "ir-json" ? "IR JSON document (edited as CadScript)" : "CadScript document"}>
        <span className="doc-name">{name}</span>
        <span className="doc-ext">{isPartZero ? ".partzero" : format === "ir-v1" ? (isJson ? ".json" : isCadScript ? ".cad.ts" : ".partzero") : format === "ir-json" ? ".json" : ".cad.ts"}</span>
        {(dirty || refsDirty) && <span className="dirty-dot" aria-label="Unsaved changes" />}
      </div>
      <div className="tb-right">
        <button type="button" className="palette-btn" onClick={() => run({ id: "view.commandPalette" })} title="Search commands and tools" data-testid="palette-button">
          <Icon.Search size={13} />
          <span>Search commands and tools</span>
          <kbd>{formatKey("Mod+K", isMac)}</kbd>
        </button>
        <button
          type="button"
          className={`tb-btn tb-toggle${assistant ? " on" : ""}`}
          title={assistant ? "Hide the assistant" : "Show the assistant"}
          aria-label="Assistant"
          aria-pressed={assistant}
          onClick={() => run({ id: "view.togglePanel", args: { panel: "right" } })}
          data-testid="tb-assistant"
        >
          <Icon.Sparkle />
        </button>
        <CommandButton cmd={{ id: "view.toggleTheme" }} title={theme === "dark" ? "Light theme" : "Dark theme"} keyHint="Mod+Shift+L">
          {theme === "dark" ? <Icon.Sun /> : <Icon.Moon />}
        </CommandButton>
        <CommandButton cmd={{ id: "settings.open" }} title="Settings" keyHint="Mod+,">
          <Icon.Gear />
        </CommandButton>
      </div>
    </header>
  );
}
