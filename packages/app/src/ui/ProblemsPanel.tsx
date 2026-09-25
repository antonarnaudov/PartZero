/**
 * Problems: every error, warning and note of the model in one list — features that failed (with
 * the kernel's code, message and repair hint), warnings worth a look, parameters that do not
 * evaluate, and compile diagnostics of code documents.
 *
 * - Filter by severity (the counts are the chips).
 * - Click a problem to select its feature (the timeline and browser follow), or its parameter
 *   (Parameters opens); **Edit** opens the feature's panel or sketch.
 */
import { useMemo, useState, type ReactElement } from "react";
import type { Problem } from "../doc/problems";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";
import { editFeature, selectFeature } from "./model/actions";
import { featureIcon } from "./model/feature-types";
import { useShell } from "./shell/context";
import { ToolIcon } from "./shell/tool-icons";
import "./model/panels.css";

const SOURCE_LABEL: Record<Problem["source"], string> = {
  cadscript: "CadScript",
  typescript: "TypeScript",
  forge: "Forge",
  engine: "Engine",
};

type Sev = Problem["severity"];

export function ProblemsPanel({ problems }: { problems: readonly Problem[] }): ReactElement {
  const { services, run } = useApp();
  const { shell } = useShell();
  const ctx = useMemo(() => ({ services, shell }), [services, shell]);
  const ir = useStore(services.doc, (s) => s.model?.ir ?? null);
  const [hidden, setHidden] = useState<Record<Sev, boolean>>({ error: false, warning: false, info: false });
  const counts = useMemo(() => {
    const c: Record<Sev, number> = { error: 0, warning: 0, info: 0 };
    for (const p of problems) c[p.severity]++;
    return c;
  }, [problems]);
  const typeOf = (id: string | undefined): string | null => {
    if (!id) return null;
    for (const p of (ir as { parts?: Array<{ features?: Array<{ id?: string; type?: string }> }> } | null)?.parts ?? []) {
      const f = p.features?.find((x) => x.id === id);
      if (f?.type) return f.type;
    }
    return null;
  };
  const reveal = (p: Problem): void => {
    if (p.featureId) selectFeature(ctx, p.featureId);
    if (p.param) shell.setLeftTab("params");
    if (p.span) services.editor.reveal(p.span, { select: true, focus: services.ui.getState().panels.code });
  };
  const shown = problems.filter((p) => !hidden[p.severity]);
  return (
    <section className="panel problems" aria-label="Problems">
      <header className="panel-header">
        <span className="panel-title">Problems</span>
        <span className={`count-pill${problems.length ? " has" : ""}`} data-testid="problems-count">
          {problems.length}
        </span>
        {problems.length > 0 && (
          <span className="pzq-filters" role="group" aria-label="Show">
            {(["error", "warning", "info"] as const).map((s) =>
              counts[s] > 0 ? (
                <button
                  key={s}
                  type="button"
                  className="pzq-filter"
                  aria-pressed={!hidden[s]}
                  onClick={() => setHidden((h) => ({ ...h, [s]: !h[s] }))}
                  title={`${hidden[s] ? "Show" : "Hide"} ${s === "info" ? "notes" : `${s}s`}`}
                  data-testid={`problems-filter-${s}`}
                >
                  <span className={`dot ${s}`} />
                  {counts[s]} {s === "error" ? (counts[s] === 1 ? "error" : "errors") : s === "warning" ? (counts[s] === 1 ? "warning" : "warnings") : counts[s] === 1 ? "note" : "notes"}
                </button>
              ) : null,
            )}
          </span>
        )}
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
          shown.map((p) => {
            const type = typeOf(p.featureId);
            return (
              <div key={p.key} className={`problem sev-${p.severity}`} role="listitem" data-testid="problem" data-code={p.code} data-feature={p.featureName ?? ""} onClick={() => reveal(p)} title={p.hint ?? p.message}>
                <span className="problem-icon">{p.severity === "error" ? <Icon.Error size={13} /> : p.severity === "warning" ? <Icon.Warning size={13} /> : <Icon.Info size={13} />}</span>
                <code className="problem-code">{p.code}</code>
                <span className="problem-msg">
                  {p.message}
                  {p.hint && <span className="problem-hint"> — {p.hint}</span>}
                </span>
                <span className="problem-loc">
                  {p.featureName && p.featureId ? (
                    <button
                      type="button"
                      className="problem-feature-btn problem-feature"
                      onClick={(e) => {
                        e.stopPropagation();
                        reveal(p);
                      }}
                      title={`Select ${p.featureName}`}
                    >
                      {type && <ToolIcon name={featureIcon(type)} size={12} />}
                      {p.featureName}
                    </button>
                  ) : p.featureName ? (
                    <span className="problem-feature">{p.featureName}</span>
                  ) : p.param ? (
                    <span className="problem-feature mono">{p.param}</span>
                  ) : null}
                  {SOURCE_LABEL[p.source]}
                  {p.span ? ` ${p.span.start.line}:${p.span.start.col}` : ""}
                  {p.featureId && type && (
                    <button
                      type="button"
                      className="link-button problem-fix"
                      onClick={(e) => {
                        e.stopPropagation();
                        editFeature(ctx, { id: p.featureId!, type });
                      }}
                      data-testid="problem-edit"
                    >
                      Edit
                    </button>
                  )}
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
