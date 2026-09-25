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
import { useShellState } from "./context";
import type { PanelRegistry } from "./panels";
import { PropertyPanel } from "./PropertyPanel";

function TimelinePanel(): ReactElement {
  const problems = useProblems();
  const timeline = useTimeline(problems);
  return (
    <div className="dock-col">
      <Timeline timeline={timeline} />
      <ParametersPanel />
    </div>
  );
}

function PropertiesPanel(): ReactElement {
  const panel = useShellState((s) => s.panel);
  if (!panel) return <div className="empty">Pick a tool in the toolbar to see its properties here.</div>;
  return <PropertyPanel key={panel.id} session={panel} />;
}

function CodeHeader(): ReactElement {
  const { services } = useApp();
  const name = useStore(services.doc, (s) => s.name);
  const problems = useProblems();
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <>
      <span className="panel-meta mono">{name}.cad.ts</span>
      <span className={`lang-pill${errors ? " err" : ""}`} title="CadScript: compiled, never executed">
        CadScript{errors ? ` · ${errors} error${errors === 1 ? "" : "s"}` : ""}
      </span>
    </>
  );
}

export function registerBuiltinPanels(panels: PanelRegistry): void {
  panels.register({ id: "timeline", title: "Timeline", icon: "Timeline", area: "left", order: 10, component: TimelinePanel });
  panels.register({
    id: "properties",
    title: "Properties",
    icon: "Params",
    area: "right",
    order: 5,
    component: PropertiesPanel,
    visibleWhen: ({ shell }) => shell.getState().panel !== null,
  });
  panels.register({ id: "code", title: "Code", icon: "Code", area: "right", order: 10, component: CodeEditor, keepMounted: true, headerExtra: CodeHeader });
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
