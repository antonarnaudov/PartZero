/**
 * The viewport host: owns the adapter (forge-web or placeholder), feeds it bodies, selection and
 * hover, forwards clicks as `selection.selectEntity`, and shows view controls and a hover readout.
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import { facesOfFeature, findFeature } from "../doc/provenance";
import type { Projection, ViewName } from "../engine/forge-web-contract";
import type { PickResult } from "../engine/types";
import { createViewportAdapter, type ViewportAdapter, type ViewportColors } from "../viewport/adapter";
import { useApp, useStore } from "./context";
import { Icon } from "./icons";

function readColors(el: HTMLElement): ViewportColors {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    background: v("--vp-bg", "#23262c"),
    backgroundBottom: v("--vp-bg-bottom", "#1a1c20"),
    grid: v("--vp-grid", "rgba(255,255,255,0.05)"),
    gridMajor: v("--vp-grid-major", "rgba(255,255,255,0.1)"),
    body: v("--vp-body", "#9aa3ad"),
    edge: v("--vp-edge", "#1b1e23"),
    accent: v("--accent", "#4c8dff"),
    hover: v("--vp-hover", "#f0b35a"),
    text: v("--text", "#d7dae0"),
  };
}

const VIEWS: Array<{ view: ViewName; label: string; title: string }> = [
  { view: "iso", label: "Iso", title: "Isometric" },
  { view: "top", label: "Top", title: "Top (looking down −Z)" },
  { view: "front", label: "Front", title: "Front (looking along +Y)" },
  { view: "right", label: "Right", title: "Right (looking along −X)" },
];

export function Viewport(): ReactElement {
  const { services, run } = useApp();
  const { doc, ui } = services;
  const containerRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<ViewportAdapter | null>(null);
  const bodies = useStore(doc, (s) => s.bodies);
  const docId = useStore(doc, (s) => s.docId);
  const selection = useStore(doc, (s) => s.selection);
  const model = useStore(doc, (s) => s.model);
  const hover = useStore(ui, (s) => s.hover);
  const theme = useStore(ui, (s) => s.resolvedTheme);
  const vpStatus = useStore(ui, (s) => s.viewport);
  const phase = useStore(doc, (s) => s.phase);
  const engineError = useStore(doc, (s) => s.engineError);
  const hasReport = useStore(doc, (s) => s.report !== null);

  // Create the adapter once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let created: ViewportAdapter | null = null;
    void createViewportAdapter(container, {
      onFallback: (reason) => console.info(`[viewport] ${reason}`),
    }).then((a) => {
      if (disposed) {
        a.dispose();
        return;
      }
      created = a;
      a.setColors(readColors(container));
      const r = container.getBoundingClientRect();
      a.resize(r.width, r.height, window.devicePixelRatio || 1);
      ui.setViewport({ kind: a.kind, backend: a.backend() });
      setAdapter(a);
    });
    return () => {
      disposed = true;
      created?.dispose();
      ui.setViewport({ kind: "none", backend: "" });
    };
  }, [ui]);

  // Commands reach the adapter through the viewport controller.
  useEffect(() => {
    if (!adapter) return;
    return services.viewport.attach({
      fitView: () => adapter.fitView(),
      setView: (v) => adapter.setView(v),
      setProjection: (p) => adapter.setProjection(p),
    });
  }, [adapter, services.viewport]);

  // Size.
  useEffect(() => {
    const container = containerRef.current;
    if (!adapter || !container) return;
    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      adapter.resize(r.width, r.height, window.devicePixelRatio || 1);
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [adapter]);

  // Theme colors (after the CSS variables switched).
  useEffect(() => {
    const container = containerRef.current;
    if (adapter && container) requestAnimationFrame(() => adapter.setColors(readColors(container)));
  }, [adapter, theme]);

  // Bodies; refit when another document was loaded.
  const lastFitDoc = useRef(0);
  useEffect(() => {
    if (!adapter) return;
    adapter.setBodies(bodies);
    if (bodies.length > 0 && lastFitDoc.current !== docId) {
      lastFitDoc.current = docId;
      adapter.fitView();
    }
  }, [adapter, bodies, docId]);

  // Selection: a picked entity, or every face of the selected feature.
  useEffect(() => {
    if (!adapter) return;
    if (selection.entity) {
      adapter.setSelection([selection.entity]);
    } else if (selection.featureId) {
      const loc = findFeature(model?.ir, selection.featureId);
      adapter.setSelection(loc ? facesOfFeature(bodies, loc.feature.name) : []);
    } else {
      adapter.setSelection([]);
    }
  }, [adapter, selection, model, bodies]);

  useEffect(() => {
    adapter?.setHover(hover);
  }, [adapter, hover]);

  // Pointer: hover picking and click-to-select (a click is a press without drag).
  useEffect(() => {
    if (!adapter) return;
    const canvas = adapter.canvas;
    let press: { x: number; y: number; button: number } | null = null;
    let pending = false;
    let last: { x: number; y: number } | null = null;
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent): void => {
      if (press) return;
      last = local(e);
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!last) return;
        void adapter.pick(last.x, last.y).then((p) => ui.setHover(p));
      });
    };
    const onLeave = (): void => {
      last = null;
      ui.setHover(null);
    };
    const onDown = (e: PointerEvent): void => {
      press = { ...local(e), button: e.button };
    };
    const onUp = (e: PointerEvent): void => {
      const p = press;
      press = null;
      if (!p || p.button !== 0) return;
      const q = local(e);
      if (Math.hypot(q.x - p.x, q.y - p.y) > 4) return;
      void adapter.pick(q.x, q.y).then((hit: PickResult | null) => {
        if (hit) run({ id: "selection.selectEntity", args: { ...hit } });
        else run({ id: "selection.clear" });
      });
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
    };
  }, [adapter, run, ui]);

  const busy = phase === "compiling" || phase === "evaluating" || phase === "pending";
  let empty: string | null = null;
  if (bodies.length === 0) {
    if (engineError) empty = engineError;
    else if (busy && !hasReport) empty = "Evaluating…";
    else if (hasReport) empty = "No solid bodies — the document has sketches only, or every body-creating feature failed.";
    else if (!busy) empty = "Nothing to show yet.";
  }

  const setProjection = (projection: Projection): void => run({ id: "view.setProjection", args: { projection } });

  return (
    <div className="viewport" data-testid="viewport">
      <div ref={containerRef} className="viewport-surface" />
      <div className="vp-toolbar" role="toolbar" aria-label="View">
        {VIEWS.map((v) => (
          <button key={v.view} type="button" className={`vp-btn${vpStatus.view === v.view ? " active" : ""}`} title={v.title} onClick={() => run({ id: "view.setView", args: { view: v.view } })}>
            {v.label}
          </button>
        ))}
        <span className="vp-sep" />
        <button type="button" className="vp-btn icon" title="Zoom to fit (F)" aria-label="Zoom to fit" onClick={() => run({ id: "view.fit" })}>
          <Icon.Fit size={14} />
        </button>
        <button
          type="button"
          className="vp-btn"
          title="Toggle perspective / orthographic"
          onClick={() => setProjection(vpStatus.projection === "perspective" ? "orthographic" : "perspective")}
        >
          {vpStatus.projection === "perspective" ? "Persp" : "Ortho"}
        </button>
      </div>
      {vpStatus.kind !== "none" && (
        <div className="vp-chip" title={vpStatus.kind === "placeholder" ? "Placeholder renderer until @aicad/forge-web is available" : "forge-render"}>
          {vpStatus.kind === "placeholder" ? "Placeholder" : "forge-render"} · {vpStatus.backend}
        </div>
      )}
      {hover && (
        <div className="vp-hover" data-testid="viewport-hover">
          {hover.face ?? hover.edge ?? hover.body}
        </div>
      )}
      {busy && bodies.length > 0 && (
        <div className="vp-busy" aria-live="polite">
          <Icon.Spinner size={12} /> Evaluating
        </div>
      )}
      {empty && <div className="vp-empty">{empty}</div>}
    </div>
  );
}
