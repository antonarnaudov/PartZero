/**
 * The viewport host: owns the adapter (forge-web or placeholder), feeds it bodies, selection and
 * hover, forwards clicks as `selection.selectEntity`, and shows view controls and a hover readout.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { PREVIEW_TINT } from "../agent/agent-service";
import { facesOfFeature, findFeature } from "../doc/provenance";
import type { Projection, ViewName } from "../engine/forge-web-contract";
import type { PickResult, RenderBody } from "../engine/types";
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

const TINT_CSS = `rgb(${PREVIEW_TINT.map((c) => Math.round(c * 255)).join(", ")})`;

/** Z extent of the displayed triangles (e2e and debugging: shows which geometry is on screen). */
function zExtent(bodies: readonly RenderBody[]): string {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bodies) {
    for (let i = 2; i < b.positions.length; i += 3) {
      const z = b.positions[i]!;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  return hi >= lo ? (hi - lo).toFixed(2) : "";
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
  const review = useStore(services.agent, (s) => s.review);
  const reviewOpen = !!review && review.status === "ready" && review.resolution === null;
  const showPreview = reviewOpen && review.previewEnabled && review.preview.status === "ready";
  const shown = showPreview ? review.preview.bodies : bodies;
  const extent = useMemo(() => zExtent(shown), [shown]);

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

  // Theme colors (after the CSS variables switched). The proposal preview tints the bodies (the
  // placeholder has one body colour; forge-render takes the per-body colour of the preview bodies).
  useEffect(() => {
    const container = containerRef.current;
    if (!adapter || !container) return;
    requestAnimationFrame(() => {
      const colors = readColors(container);
      adapter.setColors(showPreview ? { ...colors, body: TINT_CSS } : colors);
    });
  }, [adapter, theme, showPreview]);

  // Bodies (the document's, or the proposal preview's); refit when another document was loaded.
  const lastFitDoc = useRef(0);
  useEffect(() => {
    if (!adapter) return;
    adapter.setBodies(shown);
    if (shown.length > 0 && lastFitDoc.current !== docId) {
      lastFitDoc.current = docId;
      adapter.fitView();
    }
  }, [adapter, shown, docId]);

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
    <div className="viewport" data-testid="viewport" data-shown={showPreview ? "proposal" : "current"} data-extent-z={extent}>
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
      {empty && !showPreview && <div className="vp-empty">{empty}</div>}
      {reviewOpen && (
        <div className={`vp-proposal${showPreview ? "" : " off"}`} data-testid="proposal-preview-chip">
          {showPreview ? (
            <>
              <span className="swatch" /> Proposal preview (not applied)
              <button type="button" className="ghost-btn tiny" onClick={() => run({ id: "agent.setPreview", args: { enabled: false } })}>
                Show current
              </button>
            </>
          ) : (
            <>
              Current document
              <button type="button" className="ghost-btn tiny" onClick={() => run({ id: "agent.setPreview", args: { enabled: true } })} disabled={review.preview.status !== "ready"}>
                {review.preview.status === "evaluating" ? "Evaluating…" : review.preview.status === "error" ? "Preview failed" : "Preview proposal"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
