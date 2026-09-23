import type { ReactElement } from "react";
import type { Problem } from "../doc/problems";
import { useApp } from "./context";
import { Icon } from "./icons";

const SOURCE_LABEL: Record<Problem["source"], string> = {
  cadscript: "CadScript",
  typescript: "TypeScript",
  forge: "Forge",
  engine: "Engine",
};

export function ProblemsPanel({ problems }: { problems: readonly Problem[] }): ReactElement {
  const { services, run } = useApp();
  const reveal = (p: Problem): void => {
    if (p.featureId) run({ id: "selection.selectFeature", args: { feature: p.featureId, origin: "command", reveal: false } });
    if (p.span) services.editor.reveal(p.span, { select: true, focus: true });
  };
  return (
    <section className="panel problems" aria-label="Problems">
      <header className="panel-header">
        <span className="panel-title">Problems</span>
        <span className={`count-pill${problems.length ? " has" : ""}`} data-testid="problems-count">
          {problems.length}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-btn" title="Hide problems (⌘J)" aria-label="Hide problems" onClick={() => run({ id: "view.togglePanel", args: { panel: "problems", visible: false } })}>
          <Icon.Close size={12} />
        </button>
      </header>
      <div className="panel-body problems-list" role="list">
        {problems.length === 0 ? (
          <div className="empty ok">
            <Icon.Check size={13} /> No problems
          </div>
        ) : (
          problems.map((p) => (
            <div key={p.key} className={`problem sev-${p.severity}`} role="listitem" data-testid="problem" onClick={() => reveal(p)} title={p.hint ?? p.message}>
              <span className="problem-icon">
                {p.severity === "error" ? <Icon.Error size={13} /> : p.severity === "warning" ? <Icon.Warning size={13} /> : <Icon.Info size={13} />}
              </span>
              <code className="problem-code">{p.code}</code>
              <span className="problem-msg">
                {p.message}
                {p.hint && <span className="problem-hint"> — {p.hint}</span>}
              </span>
              <span className="problem-loc">
                {p.featureName && <span className="problem-feature">{p.featureName}</span>}
                {SOURCE_LABEL[p.source]}
                {p.span ? ` ${p.span.start.line}:${p.span.start.col}` : ""}
              </span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
