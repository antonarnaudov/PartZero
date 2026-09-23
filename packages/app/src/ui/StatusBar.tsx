import type { ReactElement } from "react";
import { countBySeverity, type Problem } from "../doc/problems";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

export function StatusBar({ problems }: { problems: readonly Problem[] }): ReactElement {
  const { services, run } = useApp();
  const engine = useStore(services.engines, (s) => s.active);
  const initializing = useStore(services.engines, (s) => s.initializing);
  const phase = useStore(services.doc, (s) => s.phase);
  const timings = useStore(services.doc, (s) => s.timings);
  const bodies = useStore(services.doc, (s) => s.bodies.length);
  const dirty = useStore(services.doc, (s) => s.dirty);
  const report = useStore(services.doc, (s) => s.report);
  const viewport = useStore(services.ui, (s) => s.viewport);
  const counts = countBySeverity(problems);

  let docStatus: { label: string; kind: "ok" | "busy" | "warn" | "error" };
  if (phase === "compiling") docStatus = { label: "Compiling…", kind: "busy" };
  else if (phase === "evaluating") docStatus = { label: "Evaluating…", kind: "busy" };
  else if (phase === "pending") docStatus = { label: "Editing…", kind: "busy" };
  else if (counts.error > 0) docStatus = { label: "Errors", kind: "error" };
  else if (report?.status === "ok") docStatus = { label: "Up to date", kind: "ok" };
  else docStatus = { label: "Ready", kind: "warn" };

  return (
    <footer className="statusbar" data-testid="statusbar">
      <button type="button" className="sb-item" title={`${engine.detail}\n\nClick to choose the engine`} onClick={() => run({ id: "view.commandPalette" })}>
        <Icon.Cube size={12} />
        <span data-testid="engine-label">{initializing ? "Starting engine…" : engine.label}</span>
      </button>
      <span className="sb-item" title="Viewport renderer">
        {viewport.kind === "none" ? "—" : `${viewport.kind === "placeholder" ? "Placeholder" : "forge-render"} · ${viewport.backend}`}
      </span>
      <span className="sb-item" title="CadScript compile + type-check time">
        compile {fmtMs(timings.compileMs)}
      </span>
      <span className="sb-item" data-testid="eval-time" title="Forge evaluation time (including tessellation)">
        eval {fmtMs(timings.evalMs)}
      </span>
      <span className="sb-item" data-testid="body-count">
        {bodies} {bodies === 1 ? "body" : "bodies"}
      </span>
      <span className="spacer" />
      <button type="button" className="sb-item" onClick={() => run({ id: "view.togglePanel", args: { panel: "problems" } })} title="Toggle problems (⌘J)">
        <span className={`sb-count err${counts.error ? " on" : ""}`}>
          <Icon.Error size={12} /> {counts.error}
        </span>
        <span className={`sb-count warn${counts.warning ? " on" : ""}`}>
          <Icon.Warning size={12} /> {counts.warning}
        </span>
      </button>
      <span className={`sb-item doc-status ${docStatus.kind}`} data-testid="doc-status">
        {docStatus.kind === "busy" ? <Icon.Spinner size={11} /> : <span className="dot" />}
        {docStatus.label}
        {dirty ? " · Modified" : ""}
      </span>
    </footer>
  );
}
