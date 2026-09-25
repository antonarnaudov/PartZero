/**
 * The shell's part of the status bar: the active tool and what it waits for (with its keys), or the
 * mode and the selection. Renders nothing outside the shell.
 */
import { useContext, useSyncExternalStore, type ReactElement } from "react";
import type { PanelSession } from "../../tools/framework/session";
import type { Shell } from "../../tools/shell";
import { useApp, useStore } from "../context";
import { ShellContext } from "./context";

const HINT: Record<string, string> = {
  collecting: "fill in the highlighted fields",
  previewing: "checking…",
  ready: "⏎ OK · Esc cancel",
  invalid: "won't build: see the panel",
  committing: "applying…",
};

function ToolStatus({ panel }: { panel: PanelSession }): ReactElement {
  const s = useSyncExternalStore(panel.subscribe, panel.getState);
  return (
    <span className={`sb-item sb-tool st-${s.state}`} data-testid="status-tool">
      <strong>{s.title}</strong>
      <span className="muted">{s.readOnly ? "⏎ or Esc to close" : (HINT[s.state] ?? "")}</span>
    </span>
  );
}

function Inner({ shell }: { shell: Shell }): ReactElement {
  const { services } = useApp();
  const st = useSyncExternalStore(shell.subscribe, shell.getState);
  const selection = useStore(services.doc, (s) => s.selection);
  const count = selection.entity || selection.featureId ? 1 : 0;
  return (
    <>
      <span className="sb-item" data-testid="status-mode" title="Mode">
        {st.mode === "sketch" ? "Sketch" : "Model"}
      </span>
      {st.panel ? (
        <ToolStatus panel={st.panel} />
      ) : (
        <span className="sb-item muted" data-testid="status-selection">
          {count ? "1 selected" : "Nothing selected"}
        </span>
      )}
      <span className="sb-item muted" title="Lengths in millimetres, angles in degrees">
        mm · deg
      </span>
    </>
  );
}

export function ShellStatus(): ReactElement | null {
  const ctx = useContext(ShellContext);
  return ctx ? <Inner shell={ctx.shell} /> : null;
}
