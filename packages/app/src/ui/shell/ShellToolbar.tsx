/**
 * The top of the window: a title row (brand, file and edit commands, the document, command search,
 * theme, settings) and the tool ribbon (Sketch, Create, Modify, Pattern, Inspect, Construct: every
 * group built from the tool registry) with the print handoff at its right end.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import type { AppInvocation } from "../../commands/commands";
import { formatKey } from "../../commands/registry";
import { useFilesState } from "../../file/ui/hooks";
import { TOOL_GROUPS, type ToolDefinition, type ToolGroupInfo } from "../../tools/framework/types";
import { undoScopes } from "../../doc/undo-scope";
import { UndoHistoryButton } from "../model/UndoHistory";
import { useApp, useStore } from "../context";
import { Icon } from "../icons";
import { OpenInSlicerButton } from "../Toolbar";
import { BrandLockup } from "./BrandMark";
import { useShell, useShellState } from "./context";
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
      <ToolIcon name={tool.icon} size={18} />
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

export function ToolRibbon(): ReactElement {
  const tools = useTools();
  const mode = useShellState((s) => s.mode);
  const groups = TOOL_GROUPS.map((g) => ({ group: g, tools: tools.filter((t) => t.group === g.id && (t.modes ?? ["model"]).includes(mode)) })).filter((g) => g.tools.length > 0);
  return (
    <div className="ribbon" role="toolbar" aria-label="Tools" data-testid="ribbon" data-mode={mode}>
      {mode === "sketch" && (
        <span className="rb-mode" data-testid="mode-badge">
          <ToolIcon name="sketch" size={14} /> Sketch
        </span>
      )}
      {groups.map(({ group, tools: ts }) => (
        <ToolGroup key={group.id} group={group} tools={ts} />
      ))}
      {groups.length === 0 && <span className="rb-empty">No tools in {mode === "sketch" ? "sketch" : "model"} mode yet.</span>}
      <span className="spacer" />
      <div className="rb-print">
        <CommandButton cmd={{ id: "file.exportMesh", args: { format: "3mf" } }} title="Export 3MF" keyHint="Mod+E" testId="export-3mf">
          <Icon.Export />
        </CommandButton>
        <OpenInSlicerButton />
      </div>
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
  // Undo goes to an open editing session's own history (sketch mode) first, then the document's.
  const scope = useStore(undoScopes, (s) => s.scope);
  const docCanUndo = useStore(services.doc, (s) => s.history.canUndo);
  const docCanRedo = useStore(services.doc, (s) => s.history.canRedo);
  const docUndoLabel = useStore(services.doc, (s) => s.history.undoLabel);
  const docRedoLabel = useStore(services.doc, (s) => s.history.redoLabel);
  const canUndo = scope ? scope.canUndo : docCanUndo;
  const canRedo = scope ? scope.canRedo : docCanRedo;
  const undoLabel = scope ? `in ${scope.label}` : docUndoLabel;
  const redoLabel = scope ? `in ${scope.label}` : docRedoLabel;
  const theme = useStore(services.ui, (s) => s.resolvedTheme);
  const platform = services.host.platform;
  return (
    <header className={`toolbar titlebar platform-${platform}`} data-testid="toolbar">
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
        <UndoHistoryButton />
      </div>
      <div className="doc-title" data-testid="doc-title" title={format === "ir-v1" ? "PartZero model (IR v1)" : format === "ir-json" ? "IR JSON document (edited as CadScript)" : "CadScript document"}>
        <span className="doc-name">{name}</span>
        <span className="doc-ext">{isPartZero ? ".partzero" : format === "ir-v1" ? (isJson ? ".json" : isCadScript ? ".cad.ts" : ".partzero") : format === "ir-json" ? ".json" : ".cad.ts"}</span>
        {(dirty || refsDirty) && <span className="dirty-dot" aria-label="Unsaved changes" />}
      </div>
      <button type="button" className="palette-btn" onClick={() => run({ id: "view.commandPalette" })} title="Search commands and tools" data-testid="palette-button">
        <Icon.Search size={13} />
        <span>Search commands and tools</span>
        <kbd>{formatKey("Mod+K", isMac)}</kbd>
      </button>
      <CommandButton cmd={{ id: "view.toggleTheme" }} title={theme === "dark" ? "Light theme" : "Dark theme"} keyHint="Mod+Shift+L">
        {theme === "dark" ? <Icon.Sun /> : <Icon.Moon />}
      </CommandButton>
      <CommandButton cmd={{ id: "settings.open" }} title="Settings" keyHint="Mod+,">
        <Icon.Gear />
      </CommandButton>
    </header>
  );
}
