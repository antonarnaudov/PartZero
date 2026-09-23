/**
 * The proposal review (the "draft branch" of ARCHITECTURE §7), shown in the code panel:
 * - while the agent runs: the live draft as a diff against the document;
 * - at the end: the per-feature change list (tick/untick, dependency-aware warnings), the CadScript
 *   diff of the ticked variant (Monaco diff editor), the viewport preview toggle and
 *   Accept / Accept selected / Reject. Accepting is one undoable transaction.
 */
import type { editor as MonacoEditor } from "monaco-editor";
import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ProposalReview } from "../agent/agent-service";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";
import { setupMonaco } from "./monaco-setup";

let diffSeq = 0;

/** Read-only Monaco diff of two CadScript texts. */
export function ProposalDiff({ original, modified, sideBySide }: { original: string; modified: string; sideBySide: boolean }): ReactElement {
  const { services } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<{ diff: MonacoEditor.IStandaloneDiffEditor; original: MonacoEditor.ITextModel; modified: MonacoEditor.ITextModel } | null>(null);
  const [changes, setChanges] = useState<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const monaco = setupMonaco();
    const n = ++diffSeq;
    const o = monaco.editor.createModel(original, "typescript", monaco.Uri.parse(`file:///proposal/${n}/base.cad.ts`));
    const m = monaco.editor.createModel(modified, "typescript", monaco.Uri.parse(`file:///proposal/${n}/proposed.cad.ts`));
    const diff = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      automaticLayout: true,
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      renderSideBySideInlineBreakpoint: 560,
      minimap: { enabled: false },
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 12.5,
      lineHeight: 19,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
      stickyScroll: { enabled: false },
      // Collapse unchanged code around the edits (click to expand), like a code review.
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      theme: services.ui.getState().resolvedTheme === "light" ? "aicad-light" : "aicad-dark",
      ariaLabel: "Proposal diff",
    });
    diff.setModel({ original: o, modified: m });
    // Bring the first change into view whenever the diff is recomputed (new draft, other selection).
    const sub = diff.onDidUpdateDiff(() => {
      const lc = diff.getLineChanges() ?? [];
      setChanges(lc.length);
      const first = lc[0];
      if (first) diff.getModifiedEditor().revealLineInCenter(Math.max(1, first.modifiedStartLineNumber || first.modifiedEndLineNumber));
    });
    editorRef.current = { diff, original: o, modified: m };
    return () => {
      sub.dispose();
      editorRef.current = null;
      diff.dispose();
      o.dispose();
      m.dispose();
    };
    // Created once; texts and layout are pushed by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const e = editorRef.current;
    if (!e) return;
    if (e.original.getValue() !== original) e.original.setValue(original);
    if (e.modified.getValue() !== modified) e.modified.setValue(modified);
  }, [original, modified]);

  useEffect(() => {
    editorRef.current?.diff.updateOptions({ renderSideBySide: sideBySide });
  }, [sideBySide]);

  return <div ref={hostRef} className="proposal-diff" data-testid="proposal-diff" data-line-changes={changes ?? ""} />;
}

function KindBadge({ kind }: { kind: string }): ReactElement {
  return <span className={`kind-badge kind-${kind}`}>{kind === "added" ? "new" : kind === "removed" ? "removed" : "changed"}</span>;
}

function ChangeList({ review }: { review: ProposalReview }): ReactElement {
  const { run } = useApp();
  const accepted = new Set(review.accepted);
  const errorKeys = new Set(review.warnings.filter((w) => w.severity === "error").map((w) => w.key));
  const toggle = (key: string): void => {
    const next = accepted.has(key) ? review.accepted.filter((k) => k !== key) : [...review.accepted, key];
    run({ id: "agent.setAccepted", args: { features: next } });
  };
  return (
    <ul className="change-list" data-testid="proposal-changes">
      {review.changes.map((c) => (
        <li key={c.key} className={`change${accepted.has(c.key) ? "" : " rejected"}${errorKeys.has(c.key) ? " broken" : ""}`} data-change={c.key} data-kind={c.kind}>
          <label>
            <input
              type="checkbox"
              checked={accepted.has(c.key)}
              disabled={review.resolution !== null}
              onChange={() => toggle(c.key)}
              aria-label={`Accept ${c.feature || "document properties"}`}
            />
            <KindBadge kind={c.kind} />
            <code className="change-name">{c.feature || "document"}</code>
            <span className="change-type muted">{c.type}</span>
            <span className="change-summary">{c.summary}</span>
          </label>
        </li>
      ))}
    </ul>
  );
}

export function ProposalView(): ReactElement {
  const { services, run, isMac } = useApp();
  const review = useStore(services.agent, (s) => s.review);
  const activeRun = useStore(services.agent, (s) => (s.activeRunId ? s.runs.find((r) => r.runId === s.activeRunId) : undefined));
  const [sideBySide, setSideBySide] = useState(false);
  if (!review) return <div className="empty">No proposal.</div>;

  const total = review.changes.length;
  const ticked = review.accepted.length;
  const partial = review.status === "ready" && ticked < total;
  const errors = review.warnings.filter((w) => w.severity === "error");
  const pending = review.status === "ready" && review.resolution === null;
  const draft = review.status === "draft";

  return (
    <section className="proposal" data-testid="proposal-view" data-status={review.status} data-resolution={review.resolution?.kind ?? ""}>
      <div className="proposal-head">
        <div className="proposal-title">
          {draft ? (
            <>
              <Icon.Spinner size={12} /> Live draft{activeRun?.draft ? ` · apply #${activeRun.draft.applyIndex}${activeRun.draft.verified ? " (verified)" : " (not verified)"}` : ""}
            </>
          ) : review.status === "preparing" ? (
            <>
              <Icon.Spinner size={12} /> Preparing the proposal…
            </>
          ) : (
            <>
              <Icon.Diff size={13} /> Proposal
              <span className="muted"> · {total === 0 ? "code changes only" : `${ticked}/${total} change${total === 1 ? "" : "s"} selected`}</span>
            </>
          )}
          <span className="spacer" />
          <button type="button" className="ghost-btn tiny" onClick={() => setSideBySide(!sideBySide)} title="Toggle side-by-side / inline diff">
            {sideBySide ? "Inline" : "Side by side"}
          </button>
        </div>
        <div className="proposal-prompt muted" title={review.prompt}>
          “{review.prompt}”
        </div>
      </div>
      {review.resolution && (
        <div className={`panel-banner ${review.resolution.kind === "rejected" ? "" : "ok"}`} data-testid="proposal-resolution">
          {review.resolution.kind === "rejected" ? (
            "Rejected — the document is unchanged."
          ) : (
            <>
              <Icon.Check size={13} /> {review.resolution.kind === "partial" ? `Applied ${review.resolution.applied} of ${review.resolution.total} changes` : "Applied"} as one undo step ({isMac ? "⌘Z" : "Ctrl+Z"} reverts it).
            </>
          )}
        </div>
      )}
      {review.error && (
        <div className="panel-banner warn">
          <Icon.Warning size={13} /> {review.error}
        </div>
      )}
      {review.status === "ready" && total > 0 && <ChangeList review={review} />}
      {review.warnings.length > 0 && pending && (
        <div className="dep-warnings">
          {review.warnings.map((w) => (
            <div key={`${w.key}:${w.message}`} className={`dep-warning ${w.severity}`} data-testid="proposal-warning">
              {w.severity === "error" ? <Icon.Error size={12} /> : <Icon.Warning size={12} />} {w.message}
            </div>
          ))}
        </div>
      )}
      <ProposalDiff original={review.baseSource} modified={review.variantSource} sideBySide={sideBySide} />
      {pending && (
        <footer className="proposal-actions">
          <label className="preview-toggle" title="Show the proposal (tinted) in the viewport instead of the current document">
            <input type="checkbox" checked={review.previewEnabled} onChange={(e) => run({ id: "agent.setPreview", args: { enabled: e.target.checked } })} />
            Preview in viewport
            {review.preview.status === "evaluating" && <Icon.Spinner size={11} />}
          </label>
          <span className="spacer" />
          <button type="button" className="ghost-btn" data-testid="proposal-reject" onClick={() => run({ id: "agent.reject" })}>
            Reject
          </button>
          {partial ? (
            <button
              type="button"
              className={`primary-btn small${errors.length ? " danger" : ""}`}
              data-testid="proposal-accept-selected"
              disabled={ticked === 0}
              title={errors.length ? "This selection breaks dependencies; accepting it anyway leaves errors to fix" : "Apply only the ticked changes"}
              onClick={() => run({ id: "agent.acceptFeatures", args: { features: review.accepted, ...(errors.length ? { force: true } : {}) } })}
            >
              {errors.length ? "Accept anyway" : `Accept ${ticked} of ${total}`}
            </button>
          ) : (
            <button type="button" className="primary-btn small" data-testid="proposal-accept" onClick={() => run({ id: "agent.accept", args: {} })}>
              Accept
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
