/**
 * The built-in panels of the two docks. Registration point (plan §3.3): a workstream adds its panel
 * (the Browser, Parameters v2, Measure results…) with one line in `registerBuiltinPanels`, or calls
 * `panels.register(...)` from its own module.
 */
import type { ReactElement } from "react";
import { CodeEditor } from "../CodeEditor";
import { useApp, useStore } from "../context";
import { useProblems } from "../doc-hooks";
import { BrowserPanel } from "../model/BrowserPanel";
import { ParametersPanel } from "../model/ParametersPanel";
import { ProposalView } from "../ProposalView";
import { useShellState } from "./context";
import type { PanelRegistry } from "./panels";
import { PropertyPanel } from "./PropertyPanel";

function PropertiesPanel(): ReactElement {
  const panel = useShellState((s) => s.panel);
  if (!panel) return <div className="empty">Pick a tool in the toolbar to see its properties here.</div>;
  return <PropertyPanel key={panel.id} session={panel} />;
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
  // The timeline itself is the strip under the viewport (ui/model/TimelineBar.tsx), as in Fusion.
  panels.register({ id: "browser", title: "Browser", icon: "Part", area: "left", order: 10, component: BrowserPanel });
  panels.register({
    id: "params",
    title: "Parameters",
    icon: "Params",
    area: "left",
    order: 20,
    component: ParametersPanel,
    badge: ({ services }) => {
      const s = services.doc.getState();
      if (s.format !== "ir-v1") return null;
      const n = (services.ir?.getState().params ?? []).length;
      return n > 0 ? String(n) : null;
    },
  });
  panels.register({
    id: "properties",
    title: "Properties",
    icon: "Params",
    area: "right",
    order: 5,
    component: PropertiesPanel,
    visibleWhen: ({ shell }) => shell.getState().panel !== null,
  });
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
