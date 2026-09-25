/**
 * The PartZero window (plan §2.5 "Layout"):
 *
 * ```
 * ┌ title bar: brand · file · undo · document · search · theme · settings ────────────────┐
 * ├ tool ribbon: Sketch · Create · Modify · Pattern · Inspect · Construct ··· Print ─────┤
 * │ left dock       │ viewport (+ welcome over an empty document)  │ right dock           │
 * │ Timeline, …     │                                              │ Properties·Code·Prop.│
 * │                 │                                              ├──────────────────────┤
 * │                 │                                              │ Assistant (chat)     │
 * ├ Problems ──────────────────────────────────────────────────────────────────────────────┤
 * └ status bar ────────────────────────────────────────────────────────────────────────────┘
 * ```
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { FileLayer } from "../../file/ui/FileLayer";
import { sketchMode } from "../../sketch/instance";
import { useProblems } from "../doc-hooks";
import { ChatPanel } from "../ChatPanel";
import { CommandPalette } from "../CommandPalette";
import { useApp, useStore } from "../context";
import { AboutDialog, TemplateDialog, Toasts } from "../Dialogs";
import { ProblemsPanel } from "../ProblemsPanel";
import { SettingsDialog } from "../SettingsDialog";
import { SketchModeHost } from "../sketch/SketchModeHost";
import { StatusBar } from "../StatusBar";
import { Viewport } from "../Viewport";
import { useShell, useShellState } from "./context";
import { Dock } from "./Dock";
import { ShortcutsDialog } from "./ShortcutsDialog";
import { TitleBar, ToolRibbon } from "./ShellToolbar";
import { Welcome } from "./Welcome";

type Sizes = { left: number; right: number; chat: number; problems: number };
const SIZES_KEY = "aicad.layout";
const DEFAULT_SIZES: Sizes = { left: 264, right: 420, chat: 280, problems: 112 };
const LIMITS: Record<keyof Sizes, [number, number]> = { left: [180, 520], right: [320, 900], chat: [140, 700], problems: [60, 480] };

function loadSizes(): Sizes {
  try {
    const s = JSON.parse(localStorage.getItem(SIZES_KEY) ?? "null") as Partial<Sizes> | null;
    const out = { ...DEFAULT_SIZES, ...(s ?? {}) };
    for (const k of Object.keys(LIMITS) as (keyof Sizes)[]) out[k] = Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], Number(out[k]) || DEFAULT_SIZES[k]));
    return out;
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

/** Whether the welcome screen shows (re-evaluated when the document, the agent or the shell change). */
function useWelcomeVisible(): boolean {
  const { services } = useApp();
  const { shell } = useShell();
  useStore(services.doc, (s) => `${s.docId}:${s.path ?? ""}:${s.dirty}:${s.revision}:${s.model !== null}`);
  useStore(services.agent, (s) => `${s.activeRunId ?? ""}:${s.review ? 1 : 0}`);
  useShellState((s) => s.welcome);
  // Sketch mode (the plane picker, then the sketcher) draws over the viewport: the welcome makes way.
  const sketching = useStore(sketchMode, (s) => s.phase !== "off");
  return !sketching && shell.welcomeVisible();
}

export function AppShell(): ReactElement {
  const { services } = useApp();
  const theme = useStore(services.ui, (s) => s.resolvedTheme);
  const panels = useStore(services.ui, (s) => s.panels);
  const dialog = useStore(services.ui, (s) => s.dialog);
  const shellDialog = useShellState((s) => s.dialog);
  const problems = useProblems();
  const welcome = useWelcomeVisible();
  const [sizes, setSizes] = useState<Sizes>(loadSizes);

  useEffect(() => {
    document.documentElement.dataset["theme"] = theme;
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(SIZES_KEY, JSON.stringify(sizes));
    } catch {
      // Storage unavailable: sizes are per-session.
    }
  }, [sizes]);

  const resize = useCallback((key: keyof Sizes, delta: number) => {
    setSizes((s) => {
      const [lo, hi] = LIMITS[key];
      return { ...s, [key]: Math.max(lo, Math.min(hi, s[key] + delta)) };
    });
  }, []);

  const columns = [panels.left ? `${sizes.left}px 1px` : null, "minmax(260px, 1fr)", panels.right ? `1px ${sizes.right}px` : null].filter(Boolean).join(" ");
  const workspaceStyle: CSSProperties = { gridTemplateColumns: columns };
  const rightStyle: CSSProperties = { gridTemplateRows: panels.chat ? `minmax(160px, 1fr) 1px ${sizes.chat}px` : "1fr" };

  return (
    <div className="app pz-shell" data-testid="app-shell">
      <TitleBar />
      <ToolRibbon />
      <div className="workspace" style={workspaceStyle}>
        {panels.left && (
          <aside className="col-left" aria-label="Model">
            <Dock area="left" label="Model" />
          </aside>
        )}
        {panels.left && <Splitter axis="x" label="Resize the model panel" onDrag={(d) => resize("left", d)} />}
        <main className="col-center">
          <Viewport />
          <SketchModeHost />
          {welcome && (
            <div className="welcome-layer">
              <Welcome />
            </div>
          )}
        </main>
        {panels.right && <Splitter axis="x" label="Resize the side panel" onDrag={(d) => resize("right", -d)} />}
        {panels.right && (
          <aside className="col-right" style={rightStyle} aria-label="Properties, code and assistant">
            <Dock area="right" label="Properties and code" />
            {panels.chat && <Splitter axis="y" label="Resize the assistant" onDrag={(d) => resize("chat", -d)} />}
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
      {shellDialog === "shortcuts" && <ShortcutsDialog />}
      <FileLayer />
      <Toasts />
    </div>
  );
}
