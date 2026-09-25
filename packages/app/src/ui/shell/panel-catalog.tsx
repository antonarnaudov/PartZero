/**
 * The built-in panels of the two docks. Registration point (plan §3.3): a workstream adds its panel
 * (the Browser, Parameters v2, Measure results…) with one line in `registerBuiltinPanels`, or calls
 * `panels.register(...)` from its own module.
 */
import type { ReactElement } from "react";
import { CodeEditor } from "../CodeEditor";
import { useApp, useStore } from "../context";
import { useProblems, useTimeline } from "../doc-hooks";
import { ProposalView } from "../ProposalView";
import { ParametersPanel, Timeline } from "../Timeline";
import { BrowserPanel } from "./BrowserPanel";
import { useShellState } from "./context";
import type { PanelContext, PanelRegistry } from "./panels";
import { PropertyPanel } from "./PropertyPanel";

function TimelinePanel(): ReactElement {
  const problems = useProblems();
  const timeline = useTimeline(problems);
  return (
    <div className="dock-col">
      <Timeline timeline={timeline} />
    </div>
  );
}

function ParamsTab(): ReactElement {
  return (
    <div className="dock-col">
      <ParametersPanel docked />
    </div>
  );
}

/** The number of parameters of the open model (the Parameters tab's badge). */
function paramCount(services: PanelContext["services"]): string | null {
  const params = (services.doc.getState().report as { params?: unknown[] } | null)?.params;
  return Array.isArray(params) && params.length > 0 ? String(params.length) : null;
}

/**
 * The tool's property panel floats over the viewport's top left (plan §2.5 "Layout": as in Fusion
 * and Shapr3D), not in a dock: AppShell mounts it while a tool is open.
 */
export function FloatingPropertyPanel(): ReactElement | null {
  const panel = useShellState((s) => s.panel);
  if (!panel) return null;
  return (
    <div className="pz-float-panel" data-testid="floating-panel">
      <PropertyPanel key={panel.id} session={panel} />
    </div>
  );
}

function CodeHeader(): ReactElement {
  const { services } = useApp();
  const name = useStore(services.doc, (s) => s.name);
  const v1 = useStore(services.doc, (s) => s.format === "ir-v1");
  const problems = useProblems();
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <>
      <span className="panel-meta mono">{name}.cad.ts</span>
      {v1 ? (
        <span className="lang-pill" title="The model as CadScript v1, read-only: edit it with the tools, the timeline or the assistant">
          CadScript · read-only
        </span>
      ) : (
        <span className={`lang-pill${errors ? " err" : ""}`} title="CadScript: compiled, never executed">
          CadScript{errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}
        </span>
      )}
    </>
  );
}

export function registerBuiltinPanels(panels: PanelRegistry): void {
  panels.register({ id: "timeline", title: "Timeline", icon: "Timeline", area: "left", order: 10, component: TimelinePanel });
  panels.register({ id: "browser", title: "Browser", icon: "part", area: "left", order: 20, component: BrowserPanel });
  panels.register({ id: "params", title: "Parameters", icon: "parameters", area: "left", order: 30, component: ParamsTab, badge: ({ services }) => paramCount(services), tabTestId: "dock-tab-parameters" });
  // Hidden by default (the owner's rule: no code in the default UI); View ▸ Show Code (view.toggleCode).
  panels.register({
    id: "code",
    title: "Code",
    icon: "Code",
    area: "right",
    order: 10,
    component: CodeEditor,
    keepMounted: true,
    headerExtra: CodeHeader,
    visibleWhen: ({ services }) => services.ui.getState().panels.code,
  });
  panels.register({
    id: "proposal",
    title: "Proposal",
    icon: "Diff",
    area: "right",
    order: 20,
    component: ProposalView,
    tabTestId: "proposal-tab",
    visibleWhen: ({ services }) => services.agent.getState().review !== null,
    badge: ({ services }) => {
      const r = services.agent.getState().review;
      return r && !r.resolution && (r.status === "ready" || r.status === "draft") ? "" : null;
    },
  });
}
