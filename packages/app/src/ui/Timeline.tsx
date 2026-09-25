/**
 * Feature timeline: parts → features with type icons, status badges, suppressed state and error
 * tooltips (code, message, hint). Clicking selects the feature and reveals it in the code view.
 */
import { useState, type ReactElement } from "react";
import type { Problem } from "../doc/problems";
import type { FeatureStatus, TimelineFeature, TimelineModel } from "../doc/timeline";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";
import { editSketchFeature } from "../sketch/integration";

const TYPE_ICON: Record<TimelineFeature["type"], (p: { size?: number }) => ReactElement> = {
  sketch: Icon.Sketch,
  extrude: Icon.Extrude,
  revolve: Icon.Revolve,
};

const STATUS_LABEL: Record<FeatureStatus, string> = {
  ok: "OK",
  warning: "Warning",
  error: "Error",
  suppressed: "Suppressed",
  pending: "Not evaluated",
};

function StatusBadge({ status }: { status: FeatureStatus }): ReactElement {
  return (
    <span className={`status-badge status-${status}`} aria-label={STATUS_LABEL[status]}>
      {status === "ok" && <Icon.Check size={12} />}
      {status === "error" && <Icon.Error size={12} />}
      {status === "warning" && <Icon.Warning size={12} />}
      {status === "suppressed" && <Icon.EyeOff size={12} />}
      {status === "pending" && <span className="status-dot" />}
    </span>
  );
}

function IssueTooltip({ issues }: { issues: readonly Problem[] }): ReactElement {
  return (
    <div className="issue-tooltip" role="tooltip">
      {issues.slice(0, 4).map((p) => (
        <div key={p.key} className="issue">
          <div className="issue-head">
            <span className={`sev sev-${p.severity}`}>{p.severity}</span>
            <code>{p.code}</code>
          </div>
          <div className="issue-msg">{p.message}</div>
          {p.hint && <div className="issue-hint">{p.hint}</div>}
        </div>
      ))}
      {issues.length > 4 && <div className="issue-more">+{issues.length - 4} more in Problems</div>}
    </div>
  );
}

function FeatureRow({ f, selected, focused, draft }: { f: TimelineFeature; selected: boolean; focused: boolean; draft?: string | undefined }): ReactElement {
  const { run } = useApp();
  const [hover, setHover] = useState(false);
  const TypeIcon = TYPE_ICON[f.type];
  const firstIssue = f.issues[0];
  return (
    <li
      className={`tl-feature${selected ? " selected" : ""}${focused ? " focused" : ""}${f.suppressed ? " suppressed" : ""} st-${f.status}`}
      data-testid="timeline-feature"
      data-feature={f.name}
      data-status={f.status}
      data-draft={draft ?? ""}
      aria-selected={selected}
      role="treeitem"
      tabIndex={-1}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => run({ id: "selection.selectFeature", args: { feature: f.id, origin: "timeline" } })}
      onDoubleClick={f.type === "sketch" ? () => editSketchFeature(f.id) : undefined}
    >
      <span className={`tl-type type-${f.type}`} title={f.type}>
        <TypeIcon size={15} />
      </span>
      <span className="tl-text">
        <span className="tl-name">{f.name}</span>
        <span className="tl-summary">{firstIssue && f.status === "error" ? firstIssue.code : f.summary}</span>
      </span>
      {draft && (
        <span className={`kind-badge tl-draft kind-${draft}`} title={`The agent's proposal ${draft === "removed" ? "removes" : "changes"} this feature`} aria-label={draft === "removed" ? "removed by the proposal" : "changed by the proposal"}>
          {draft === "removed" ? "−" : "Δ"}
        </span>
      )}
      <button
        type="button"
        className="tl-action"
        title={f.suppressed ? "Unsuppress" : "Suppress"}
        aria-label={f.suppressed ? `Unsuppress ${f.name}` : `Suppress ${f.name}`}
        onClick={(e) => {
          e.stopPropagation();
          run({ id: "feature.setSuppressed", args: { feature: f.id, suppressed: !f.suppressed } });
        }}
      >
        {f.suppressed ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />}
      </button>
      <StatusBadge status={f.status} />
      {hover && f.issues.length > 0 && <IssueTooltip issues={f.issues} />}
    </li>
  );
}

export function Timeline({ timeline }: { timeline: TimelineModel }): ReactElement {
  const { services } = useApp();
  const selectedId = useStore(services.doc, (s) => s.selection.featureId);
  const focusId = useStore(services.ui, (s) => s.codeFocusFeatureId);
  const phase = useStore(services.doc, (s) => s.phase);
  const hasCompile = useStore(services.doc, (s) => s.compile !== null);
  const review = useStore(services.agent, (s) => (s.review && s.review.status === "ready" && s.review.resolution === null ? s.review : null));
  const draftKinds = new Map((review?.changes ?? []).map((c) => [`${c.part}/${c.feature}`, c.kind]));

  return (
    <section className="panel timeline" aria-label="Feature timeline">
      <header className="panel-header">
        <Icon.Timeline size={14} />
        <span className="panel-title">Timeline</span>
        <span className="panel-meta">{timeline.featureCount > 0 ? `${timeline.featureCount} features` : ""}</span>
      </header>
      {timeline.stale && (
        <div className="panel-banner warn" data-testid="timeline-stale">
          <Icon.Warning size={13} /> Code has errors — showing the last valid model
        </div>
      )}
      <div className="panel-body">
        {timeline.parts.length === 0 ? (
          <div className="empty">{!hasCompile || phase === "compiling" ? "Compiling…" : "No features yet."}</div>
        ) : (
          <ul className="tl-tree" role="tree">
            {timeline.parts.map((part) => (
              <li key={part.id} className="tl-part" role="treeitem" aria-expanded="true">
                <div className="tl-part-head" data-testid="timeline-part">
                  <Icon.Part size={14} />
                  <span>{part.name}</span>
                  <span className="tl-count">{part.features.length}</span>
                </div>
                <ul role="group">
                  {part.features.map((f) => (
                    <FeatureRow key={f.id} f={f} selected={f.id === selectedId} focused={f.id === focusId} draft={draftKinds.get(`${part.name}/${f.name}`)} />
                  ))}
                  {(review?.changes ?? [])
                    .filter((c) => c.kind === "added" && c.part === part.name)
                    .map((c) => (
                      <li key={c.key} className="tl-proposed" data-testid="timeline-proposed">
                        <span className="kind-badge kind-added">new</span> {c.feature} <span className="muted">· proposed</span>
                      </li>
                    ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ParametersPanel(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <section className={`panel params${open ? " open" : ""}`} aria-label="Parameters">
      <header className="panel-header clickable" onClick={() => setOpen(!open)}>
        <span className={`chev${open ? " open" : ""}`}>
          <Icon.Chevron size={12} />
        </span>
        <Icon.Params size={14} />
        <span className="panel-title">Parameters</span>
        <span className="panel-meta">IR v1</span>
      </header>
      {open && (
        <div className="panel-body params-body">
          <p className="muted">
            Parameters and expressions arrive with <strong>IR v1</strong> (<code>param()</code> in CadScript). IR v0 documents
            are all literals, so there is nothing to drive yet.
          </p>
          <p className="muted small">Editing a parameter here will regenerate without an LLM call, like assumption chips in chat.</p>
        </div>
      )}
    </section>
  );
}
