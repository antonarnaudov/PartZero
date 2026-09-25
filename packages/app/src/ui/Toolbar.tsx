import { useState, type ReactElement } from "react";
import type { AppInvocation } from "../commands/commands";
import { formatKey } from "../commands/registry";
import { openInSlicer } from "../print/open-in-slicer";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

/**
 * The primary handoff button (ALPHA-0-PLAN W3/W5): check, export for the printer and open in the
 * user's Bambu Studio. Desktop only. It calls `openInSlicer` directly until `file.openInSlicer`
 * (with ⌘P) is registered in the command layer; failures surface as toasts like other commands.
 */
export function OpenInSlicerButton(): ReactElement | null {
  const { services } = useApp();
  const [busy, setBusy] = useState(false);
  if (!services.host.print) return null;
  const run = (): void => {
    setBusy(true);
    openInSlicer(services)
      .catch((e: unknown) => services.ui.toast("error", e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="tb-group">
      <button
        type="button"
        className="tb-primary"
        title="Check the part, save it to ~/PartZero/Prints centred on the printer bed, and open it in Bambu Studio"
        disabled={busy}
        aria-busy={busy}
        onClick={run}
        data-testid="open-in-slicer"
      >
        {busy ? <Icon.Spinner size={14} /> : <Icon.Printer size={14} />}
        <span>Open in Bambu Studio</span>
      </button>
    </div>
  );
}

function ToolButton({ cmd, title, keyHint, children, disabled }: { cmd: AppInvocation; title: string; keyHint?: string; children: ReactElement; disabled?: boolean }): ReactElement {
  const { run, isMac } = useApp();
  const label = keyHint ? `${title} (${formatKey(keyHint, isMac)})` : title;
  return (
    <button type="button" className="tb-btn" title={label} aria-label={title} disabled={disabled} onClick={() => run(cmd)}>
      {children}
    </button>
  );
}

export function Toolbar(): ReactElement {
  const { services, run, isMac } = useApp();
  const name = useStore(services.doc, (s) => s.name);
  const dirty = useStore(services.doc, (s) => s.dirty);
  const format = useStore(services.doc, (s) => s.format);
  const canUndo = useStore(services.doc, (s) => s.history.canUndo);
  const canRedo = useStore(services.doc, (s) => s.history.canRedo);
  const theme = useStore(services.ui, (s) => s.resolvedTheme);
  const platform = services.host.platform;

  return (
    <header className={`toolbar platform-${platform}`} data-testid="toolbar">
      <div className="brand" aria-label="PartZero">
        <span className="brand-mark" aria-hidden="true">
          <Icon.Cube size={14} />
        </span>
        <span className="brand-name">PartZero</span>
      </div>
      <div className="tb-group">
        <ToolButton cmd={{ id: "file.new" }} title="New" keyHint="Mod+N">
          <Icon.File />
        </ToolButton>
        <ToolButton cmd={{ id: "file.newFromTemplate" }} title="New from template" keyHint="Mod+Shift+N">
          <Icon.Template />
        </ToolButton>
        <ToolButton cmd={{ id: "file.open" }} title="Open" keyHint="Mod+O">
          <Icon.FolderOpen />
        </ToolButton>
        <ToolButton cmd={{ id: "file.save" }} title="Save" keyHint="Mod+S">
          <Icon.Save />
        </ToolButton>
      </div>
      <div className="tb-group">
        <ToolButton cmd={{ id: "edit.undo" }} title="Undo" keyHint="Mod+Z" disabled={!canUndo}>
          <Icon.Undo />
        </ToolButton>
        <ToolButton cmd={{ id: "edit.redo" }} title="Redo" keyHint="Mod+Shift+Z" disabled={!canRedo}>
          <Icon.Redo />
        </ToolButton>
      </div>
      <div className="tb-group">
        <ToolButton cmd={{ id: "file.exportMesh", args: { format: "3mf" } }} title="Export 3MF" keyHint="Mod+E">
          <Icon.Export />
        </ToolButton>
      </div>
      <OpenInSlicerButton />
      <div className="doc-title" data-testid="doc-title" title={format === "ir-json" ? "IR JSON document (edited as CadScript)" : "CadScript document"}>
        <span className="doc-name">{name}</span>
        <span className="doc-ext">{format === "ir-json" ? ".json" : ".cad.ts"}</span>
        {dirty && <span className="dirty-dot" aria-label="Unsaved changes" />}
      </div>
      <button type="button" className="palette-btn" onClick={() => run({ id: "view.commandPalette" })} title="Command palette">
        <Icon.Search size={13} />
        <span>Search commands</span>
        <kbd>{formatKey("Mod+K", isMac)}</kbd>
      </button>
      <ToolButton cmd={{ id: "view.toggleTheme" }} title={theme === "dark" ? "Light theme" : "Dark theme"} keyHint="Mod+Shift+L">
        {theme === "dark" ? <Icon.Sun /> : <Icon.Moon />}
      </ToolButton>
      <ToolButton cmd={{ id: "settings.open" }} title="Settings" keyHint="Mod+,">
        <Icon.Gear />
      </ToolButton>
    </header>
  );
}
