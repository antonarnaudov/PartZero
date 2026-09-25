import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { ChatPanel } from "./ChatPanel";
import { CodeEditor } from "./CodeEditor";
import { CommandPalette } from "./CommandPalette";
import { useApp, useStore } from "./context";
import { AboutDialog, TemplateDialog, Toasts } from "./Dialogs";
import { useProblems, useTimeline } from "./doc-hooks";
import { Icon } from "./icons";
import { ProblemsPanel } from "./ProblemsPanel";
import { ProposalView } from "./ProposalView";
import { SettingsDialog } from "./SettingsDialog";
import { SketchModeHost } from "./sketch/SketchModeHost";
import { StatusBar } from "./StatusBar";
import { ParametersPanel, Timeline } from "./Timeline";
import { Toolbar } from "./Toolbar";
import { Viewport } from "./Viewport";

type Sizes = { left: number; right: number; chat: number; problems: number };
const SIZES_KEY = "aicad.layout";
const DEFAULT_SIZES: Sizes = { left: 264, right: 460, chat: 260, problems: 112 };
const LIMITS: Record<keyof Sizes, [number, number]> = { left: [180, 520], right: [300, 900], chat: [120, 700], problems: [60, 480] };

function loadSizes(): Sizes {
  try {
    const s = JSON.parse(localStorage.getItem(SIZES_KEY) ?? "null") as Partial<Sizes> | null;
    return { ...DEFAULT_SIZES, ...(s ?? {}) };
  } catch {
    return DEFAULT_SIZES;
  }
}

function Splitter({ axis, onDrag, label }: { axis: "x" | "y"; onDrag: (delta: number) => void; label: string }): ReactElement {
  const last = useRef<number | null>(null);
  return (
    <div
      className={`splitter splitter-${axis}`}
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-label={label}
      onPointerDown={(e) => {
        last.current = axis === "x" ? e.clientX : e.clientY;
        e.currentTarget.setPointerCapture(e.pointerId);
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const p = axis === "x" ? e.clientX : e.clientY;
        onDrag(p - last.current);
        last.current = p;
      }}
      onPointerUp={(e) => {
        last.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing-x", "resizing-y");
      }}
    />
  );
}

export function App(): ReactElement {
  const { services } = useApp();
  const theme = useStore(services.ui, (s) => s.resolvedTheme);
  const panels = useStore(services.ui, (s) => s.panels);
  const dialog = useStore(services.ui, (s) => s.dialog);
  const docName = useStore(services.doc, (s) => s.name);
  const codeTab = useStore(services.agent, (s) => s.codeTab);
  const reviewStatus = useStore(services.agent, (s) => (s.review ? (s.review.resolution ? "resolved" : s.review.status) : null));
  const problems = useProblems();
  const timeline = useTimeline(problems);
  const [sizes, setSizes] = useState<Sizes>(loadSizes);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {
      // ignore
    }
  }, [sizes]);

  const resize = useCallback((key: keyof Sizes, delta: number) => {
    setSizes((s) => {
      const [lo, hi] = LIMITS[key];
      return { ...s, [key]: Math.max(lo, Math.min(hi, s[key] + delta)) };
    });
  }, []);

  const columns = [panels.left ? `${sizes.left}px 1px` : null, "minmax(240px, 1fr)", panels.right ? `1px ${sizes.right}px` : null]
    .filter(Boolean)
    .join(" ");
  const workspaceStyle: CSSProperties = { gridTemplateColumns: columns };
  const rightStyle: CSSProperties = { gridTemplateRows: panels.chat ? `minmax(120px, 1fr) 1px ${sizes.chat}px` : "1fr" };
  const errorCount = problems.filter((p) => p.severity === "error").length;

  return (
    <div className="app" data-testid="app-shell">
      <Toolbar />
      <div className="workspace" style={workspaceStyle}>
        {panels.left && (
          <aside className="col-left" aria-label="Model">
            <Timeline timeline={timeline} />
            <ParametersPanel />
          </aside>
        )}
        {panels.left && <Splitter axis="x" label="Resize timeline" onDrag={(d) => resize("left", d)} />}
        <main className="col-center">
          <Viewport />
          <SketchModeHost />
        </main>
        {panels.right && <Splitter axis="x" label="Resize code panel" onDrag={(d) => resize("right", -d)} />}
        {panels.right && (
          <aside className="col-right" style={rightStyle} aria-label="Code and chat">
            <section className="panel code-panel" aria-label="Code">
              <header className="panel-header code-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={codeTab === "code"}
                  className={`code-tab${codeTab === "code" ? " active" : ""}`}
                  onClick={() => services.agent.setCodeTab("code")}
                >
                  <Icon.Code size={14} />
                  <span className="panel-title">Code</span>
                </button>
                {reviewStatus && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={codeTab === "proposal"}
                    data-testid="proposal-tab"
                    className={`code-tab proposal-tab st-${reviewStatus}${codeTab === "proposal" ? " active" : ""}`}
                    onClick={() => services.agent.setCodeTab("proposal")}
                  >
                    <Icon.Diff size={13} />
                    <span className="panel-title">{reviewStatus === "draft" ? "Draft" : "Proposal"}</span>
                    {(reviewStatus === "ready" || reviewStatus === "draft") && <span className="tab-dot" />}
                  </button>
                )}
                {codeTab === "code" && <span className="panel-meta mono">{docName}.cad.ts</span>}
                <span className="spacer" />
                <span className={`lang-pill${errorCount ? " err" : ""}`} title="CadScript v0 — compiled, never executed">
                  CadScript{errorCount ? ` · ${errorCount} error${errorCount === 1 ? "" : "s"}` : ""}
                </span>
              </header>
              <div className="code-stack">
                <div className={`code-layer${codeTab === "code" ? "" : " hidden"}`}>
                  <CodeEditor />
                </div>
                {codeTab === "proposal" && reviewStatus && (
                  <div className="code-layer">
                    <ProposalView />
                  </div>
                )}
              </div>
            </section>
            {panels.chat && <Splitter axis="y" label="Resize chat" onDrag={(d) => resize("chat", -d)} />}
            {panels.chat && <ChatPanel />}
          </aside>
        )}
      </div>
      {panels.problems && <Splitter axis="y" label="Resize problems" onDrag={(d) => resize("problems", -d)} />}
      {panels.problems && (
        <div className="bottom" style={{ height: sizes.problems }}>
          <ProblemsPanel problems={problems} />
        </div>
      )}
      <StatusBar problems={problems} />
      {dialog === "palette" && <CommandPalette />}
      {dialog === "templates" && <TemplateDialog />}
      {dialog === "about" && <AboutDialog />}
      {dialog === "settings" && <SettingsDialog />}
      <Toasts />
    </div>
  );
}
