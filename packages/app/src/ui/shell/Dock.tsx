/**
 * A dock: the panels of one area as tabs (a single panel shows without a tab strip). Hidden panels
 * that ask for it stay mounted (the code editor keeps its Monaco state).
 */
import { useEffect, type ReactElement } from "react";
import { useApp, useStore } from "../context";
import { Icon } from "../icons";
import { useShell, useShellState, usePanels } from "./context";
import type { PanelArea, PanelContext, PanelDefinition } from "./panels";
import { ToolIcon } from "./tool-icons";

function PanelIcon({ name }: { name: string | undefined }): ReactElement | null {
  if (!name) return null;
  const App = (Icon as Record<string, ((p: { size?: number }) => ReactElement) | undefined>)[name];
  return App ? <App size={13} /> : <ToolIcon name={name} size={13} />;
}

/** Re-render when what `visibleWhen`/`badge` read changes. */
function useVisibilityDeps(): void {
  const { services } = useApp();
  useStore(services.agent, (s) => s.review);
  useStore(services.doc, (s) => s.revision);
  useShellState((s) => s.panel);
}

function useActiveTab(area: PanelArea, visible: readonly PanelDefinition[]): [string | null, (id: string) => void] {
  const { shell } = useShell();
  const { services } = useApp();
  const leftTab = useShellState((s) => s.leftTab);
  const rightTab = useShellState((s) => s.rightTab);
  const panel = useShellState((s) => s.panel);
  const codeTab = useStore(services.agent, (s) => s.codeTab);

  // The agent opens its proposal with `agent.showProposal` (the code tab of the agent service).
  useEffect(() => {
    if (area !== "right") return;
    const cur = shell.getState().rightTab;
    if (cur === "code" || cur === "proposal") {
      if (cur !== codeTab) shell.setRightTab(codeTab);
    } else if (cur === "properties" && !shell.getState().panel) {
      shell.setRightTab(codeTab);
    }
  }, [area, codeTab, shell]);

  const wanted = area === "left" ? leftTab : rightTab === "properties" && !panel ? codeTab : rightTab;
  const active = visible.find((p) => p.id === wanted)?.id ?? visible[0]?.id ?? null;
  const select = (id: string): void => {
    if (area === "left") shell.setLeftTab(id);
    else {
      shell.setRightTab(id);
      if (id === "code" || id === "proposal") services.agent.setCodeTab(id);
    }
  };
  return [active, select];
}

export function Dock({ area, label }: { area: PanelArea; label: string }): ReactElement {
  const { services } = useApp();
  const { shell } = useShell();
  const all = usePanels();
  useVisibilityDeps();
  const ctx: PanelContext = { services, shell };
  const panels = all.filter((p) => p.area === area);
  const visible = panels.filter((p) => !p.visibleWhen || p.visibleWhen(ctx));
  const [active, select] = useActiveTab(area, visible);
  const activePanel = visible.find((p) => p.id === active);
  const Extra = activePanel?.headerExtra;
  const strip = visible.length > 1 || !!Extra;

  return (
    <section className={`dock dock-${area}`} aria-label={label} data-testid={`dock-${area}`}>
      {strip && (
        <header className="panel-header dock-tabs" role="tablist" aria-label={`${label} tabs`}>
          {visible.map((p) => {
            const badge = p.badge?.(ctx) ?? null;
            return (
              <button
                key={p.id}
                type="button"
                role="tab"
                aria-selected={p.id === active}
                className={`dock-tab${p.id === active ? " active" : ""}`}
                onClick={() => select(p.id)}
                data-testid={p.tabTestId ?? `dock-tab-${p.id}`}
              >
                <PanelIcon name={p.icon} />
                <span className="panel-title">{p.title}</span>
                {badge !== null && <span className={`tab-badge${badge === "" ? " dot" : ""}`}>{badge}</span>}
              </button>
            );
          })}
          <span className="spacer" />
          {Extra && <Extra />}
        </header>
      )}
      <div className="dock-stack">
        {panels.map((p) => {
          const isVisible = visible.includes(p);
          const isActive = p.id === active;
          if (!isActive && !(p.keepMounted && isVisible)) return null;
          const C = p.component;
          return (
            <div key={p.id} className={`dock-layer${isActive ? "" : " hidden"}`} role="tabpanel" aria-label={p.title} data-panel={p.id}>
              <C />
            </div>
          );
        })}
      </div>
    </section>
  );
}
