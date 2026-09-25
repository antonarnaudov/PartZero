/**
 * The viewport host: owns the renderer adapter (forge-web or the placeholder) and wires it to the
 * viewport runtime (`viewport/runtime.ts`): bodies, highlights, camera navigation for mouse and
 * trackpad (FD3), hover pre-highlight, click / Shift-click / box selection with the kind filter,
 * and the overlays: view cube, origin display, vertex markers, measure dimensions, manipulator
 * handles, section and measure panels.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { PREVIEW_TINT } from "../agent/agent-service";
import type { RenderBody } from "../engine/types";
import { measureSelection } from "../measure/measure";
import { MeasurePanel } from "../measure/MeasurePanel";
import type { Rect } from "../selection/box-select";
import { boxModeOf } from "../selection/box-select";
import { labelOf } from "../selection/labels";
import type { OriginId } from "../selection/types";
import { createViewportAdapter, type ViewportAdapter, type ViewportColors } from "../viewport/adapter";
import { installViewportKeyboard } from "../viewport/keyboard";
import { ManipulatorLayer } from "../viewport/manipulators/ManipulatorLayer";
import { CLICK_SLOP_PX, classifyWheel, dragRole, newWheelMemory } from "../viewport/navigation";
import { Overlay } from "../viewport/Overlay";
import { routedExecute, viewportCommands } from "../viewport/registry";
import { viewportRuntime } from "../viewport/runtime";
import { SectionPanel } from "../viewport/SectionPanel";
import { sketchPolylines } from "../viewport/sketches";
import { installViewTestHook } from "../viewport/test-hook";
import type { CameraFrame } from "../viewport/view-camera";
import { ViewCube } from "../viewport/ViewCube";
import { SelectionBar, ViewToolbar } from "../viewport/ViewToolbar";
import "../viewport/viewport.css";
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

type Cmd = { id: string; args?: Record<string, unknown> };

export function Viewport(): ReactElement {
  const { services, commands, isMac } = useApp();
  const { doc, ui } = services;
  const runtime = useMemo(() => viewportRuntime(services), [services]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [adapter, setAdapter] = useState<ViewportAdapter | null>(null);
  const [frame, setFrame] = useState<CameraFrame | null>(null);
  const [box, setBox] = useState<(Rect & { mode: "window" | "crossing" }) | null>(null);
  const bodies = useStore(doc, (s) => s.bodies);
  const docId = useStore(doc, (s) => s.docId);
  const theme = useStore(ui, (s) => s.resolvedTheme);
  const vpStatus = useStore(ui, (s) => s.viewport);
  const phase = useStore(doc, (s) => s.phase);
  const engineError = useStore(doc, (s) => s.engineError);
  const hasReport = useStore(doc, (s) => s.report !== null);
  const report = useStore(doc, (s) => s.report);
  const review = useStore(services.agent, (s) => s.review);
  const sel = useSyncExternalStore(runtime.selection.subscribe, runtime.selection.getState);
  const view = useSyncExternalStore(runtime.view.subscribe, runtime.view.getState);
  const measureOpen = useSyncExternalStore(runtime.measure.subscribe, () => runtime.measure.getState().open);
  const reviewOpen = !!review && review.status === "ready" && review.resolution === null;
  const showPreview = reviewOpen && review.previewEnabled && review.preview.status === "ready";
  const shown = showPreview ? review.preview.bodies : bodies;
  const extent = useMemo(() => zExtent(shown), [shown]);

  const run = useCallback((cmd: Cmd) => void routedExecute(services, commands, cmd, "ui"), [services, commands]);

  // UI-originated app commands from the runtime (mirroring the primary item into the document selection).
  useEffect(() => {
    runtime.setCommandRunner((cmd) => void commands.executeUnknown(cmd, { source: "ui" }));
    return () => runtime.setCommandRunner(null);
  }, [runtime, commands]);

  // Viewport shortcuts and the test hook (only where `window.__aicad` is installed).
  useEffect(() => installViewportKeyboard(viewportCommands(services), commands, isMac, () => ui.getState().dialog !== null), [services, commands, isMac, ui]);
  useEffect(() => {
    if (!window.__aicad) return;
    return installViewTestHook(services, commands);
  }, [services, commands]);

  // Create the adapter once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let created: ViewportAdapter | null = null;
    let detach: (() => void) | null = null;
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
      detach = runtime.attach(a);
      ui.setViewport({ kind: a.kind, backend: a.backend() });
      setAdapter(a);
    });
    return () => {
      disposed = true;
      detach?.();
      created?.dispose();
      ui.setViewport({ kind: "none", backend: "" });
    };
  }, [ui, runtime]);

  // The app's `view.fit` / `view.setView` / `view.setProjection` reach the runtime through the controller.
  useEffect(() => {
    if (!adapter) return;
    return services.viewport.attach({
      fitView: () => void runtime.fit(),
      setView: (v) => void runtime.setStandardView(v),
      setProjection: (p) => runtime.setProjection(p),
    });
  }, [adapter, runtime, services.viewport]);

  // Overlays follow the camera: one frame snapshot per rendered frame.
  useEffect(() => {
    if (!adapter) return;
    let raf = 0;
    const update = (): void => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setFrame(runtime.frame());
      });
    };
    update();
    const off = runtime.onFrame(update);
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [adapter, runtime]);

  // Size.
  useEffect(() => {
    const container = containerRef.current;
    if (!adapter || !container) return;
    const ro = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      adapter.resize(r.width, r.height, window.devicePixelRatio || 1);
      setFrame(runtime.frame());
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [adapter, runtime]);

  // Theme colours. The proposal preview tints the bodies (the placeholder has one body colour;
  // forge-render takes the per-body colour of the preview bodies).
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
    runtime.setSceneBodies(shown);
    if (!adapter) return;
    if (shown.length > 0 && lastFitDoc.current !== docId) {
      lastFitDoc.current = docId;
      adapter.fitView();
    }
  }, [adapter, runtime, shown, docId]);

  // Pointer input on the canvas: navigation (FD3), hover, click, box select.
  useEffect(() => {
    if (!adapter) return;
    const canvas = adapter.canvas;
    const wheelMem = newWheelMemory();
    type Press = { id: number; x: number; y: number; lastX: number; lastY: number; role: "orbit" | "pan" | "select"; moved: boolean; button: number; additive: boolean };
    let press: Press | null = null;
    let hoverBusy = false;
    let hoverNext: { x: number; y: number } | null = null;
    const local = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hover = (x: number, y: number): void => {
      hoverNext = { x, y };
      if (hoverBusy) return;
      hoverBusy = true;
      void (async () => {
        while (hoverNext) {
          const q = hoverNext;
          hoverNext = null;
          if (press || runtime.manipulators.dragging) break;
          await runtime.hoverAt(q.x, q.y);
        }
        hoverBusy = false;
      })();
    };
    const onDown = (e: PointerEvent): void => {
      const role = dragRole(e.button, e);
      if (!role) return;
      const q = local(e);
      press = { id: e.pointerId, x: q.x, y: q.y, lastX: q.x, lastY: q.y, role, moved: false, button: e.button, additive: e.shiftKey || e.metaKey || e.ctrlKey };
      canvas.setPointerCapture(e.pointerId);
      canvas.focus({ preventScroll: true });
    };
    const onMove = (e: PointerEvent): void => {
      const q = local(e);
      const p = press;
      if (!p || p.id !== e.pointerId) {
        hover(q.x, q.y);
        return;
      }
      if (!p.moved && Math.hypot(q.x - p.x, q.y - p.y) < CLICK_SLOP_PX) return;
      p.moved = true;
      const dx = q.x - p.lastX;
      const dy = q.y - p.lastY;
      p.lastX = q.x;
      p.lastY = q.y;
      if (p.role === "orbit") {
        adapter.orbit(dx, dy);
        runtime.noteOrbit();
      } else if (p.role === "pan") adapter.pan(dx, dy);
      else setBox({ x0: p.x, y0: p.y, x1: q.x, y1: q.y, mode: boxModeOf(p.x, q.x) });
    };
    const onUp = (e: PointerEvent): void => {
      const p = press;
      if (!p || p.id !== e.pointerId) return;
      press = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (p.role !== "select") return;
      const q = local(e);
      if (p.moved) {
        setBox(null);
        runtime.boxSelect({ x0: p.x, y0: p.y, x1: q.x, y1: q.y }, { additive: p.additive });
      } else {
        void runtime.clickAt(q.x, q.y, p.additive);
      }
    };
    const onCancel = (e: PointerEvent): void => {
      if (press?.id === e.pointerId) press = null;
      setBox(null);
    };
    const onLeave = (): void => {
      hoverNext = null;
      if (!press) runtime.selection.setHover(null);
    };
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const a = classifyWheel(e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number }, wheelMem, runtime.view.getState().navigation);
      if (!a) return;
      const q = local(e);
      if (a.type === "zoom") adapter.zoomAt(q.x, q.y, a.factor);
      else if (a.type === "orbit") {
        adapter.orbit(a.dx, a.dy);
        runtime.noteOrbit();
      } else adapter.pan(a.dx, a.dy);
    };
    const onDbl = (e: MouseEvent): void => {
      const q = local(e);
      void runtime.pickAt(q.x, q.y).then((it) => {
        if (!it) void runtime.fit();
      });
    };
    const onMenu = (e: Event): void => e.preventDefault();
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("contextmenu", onMenu);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("contextmenu", onMenu);
    };
  }, [adapter, runtime]);

  const measurement = useMemo(
    () => (measureOpen ? measureSelection(sel.items, runtime.topo, report) : null),
    // The topology changes with the bodies; the selection revision covers re-resolution.
    [measureOpen, sel, runtime.topo, report],
  );

  const onOriginClick = useCallback(
    (id: OriginId, additive: boolean) => {
      if (!runtime.selection.getState().filter.origin) return;
      const it = { kind: "origin" as const, id };
      if (additive) runtime.selection.toggle(it);
      else runtime.selectItems([it]);
    },
    [runtime],
  );
  const onOriginHover = useCallback((id: OriginId | null) => runtime.selection.setHover(id ? { kind: "origin", id } : null), [runtime]);

  // Sketches: all of them with "Sketches" on (or only sketches selectable); otherwise the selected ones.
  const model = useStore(doc, (s) => s.model);
  const allSketches = useMemo(() => sketchPolylines(model?.ir), [model]);
  const onlySketches = sel.filter.sketch && !sel.filter.face && !sel.filter.edge && !sel.filter.vertex && !sel.filter.body;
  const shownSketches = useMemo(() => {
    // With only sketches selectable (key 5), every sketch is shown so there is something to pick.
    if (view.sketches || onlySketches) return allSketches;
    const keep = new Set(sel.items.flatMap((it) => (it.kind === "sketch" ? [it.feature] : [])));
    return keep.size ? allSketches.filter((s) => keep.has(s.sketch)) : [];
  }, [allSketches, view.sketches, onlySketches, sel.items]);
  const onSketchClick = useCallback(
    (sketch: string, additive: boolean) => {
      const it = { kind: "sketch" as const, feature: sketch };
      if (additive) {
        runtime.selection.toggle(it);
        runtime.syncDocSelection();
      } else runtime.selectItems([it]);
    },
    [runtime],
  );
  const onSketchHover = useCallback((s: string | null) => runtime.selection.setHover(s ? { kind: "sketch", feature: s } : null), [runtime]);

  const busy = phase === "compiling" || phase === "evaluating" || phase === "pending";
  let empty: string | null = null;
  if (bodies.length === 0) {
    if (engineError) empty = engineError;
    else if (busy && !hasReport) empty = "Evaluating…";
    else if (hasReport) empty = "No solid bodies — the document has sketches only, or every body-creating feature failed.";
    else if (!busy) empty = "Nothing to show yet.";
  }
  const ir = doc.getState().model?.ir;
  const originSize = runtime.topo.bbox ? Math.max(10, Math.max(...runtime.topo.bbox.max.map((v, i) => Math.abs(v - runtime.topo.bbox!.min[i]!))) * 0.6) : 40;

  return (
    <div className="viewport" data-testid="viewport" data-shown={showPreview ? "proposal" : "current"} data-extent-z={extent} data-display={view.display} data-renderer={vpStatus.kind}>
      <div ref={containerRef} className="viewport-surface" />
      {frame && (
        <Overlay
          frame={frame}
          origin={view.origin}
          originSize={originSize}
          items={sel.items}
          hover={sel.hover}
          measurements={measurement?.rows ?? []}
          box={box}
          onOriginClick={onOriginClick}
          onOriginHover={onOriginHover}
          sketches={shownSketches}
          // Overlay curves are not depth-tested: they take clicks only when nothing else is selectable
          // (key 5), so they never steal a click meant for a face in front of them.
          sketchPickable={onlySketches}
          onSketchClick={onSketchClick}
          onSketchHover={onSketchHover}
        />
      )}
      {frame && <ManipulatorLayer host={runtime.manipulators} frame={frame} />}
      <ViewToolbar runtime={runtime} run={run} measureOpen={measureOpen} />
      {frame && view.viewCube && (
        <ViewCube
          basis={frame.basis}
          onView={(v) => run({ id: "view.setView", args: { view: v } })}
          onDirection={(dir) => run({ id: "view.lookAlong", args: { dir } })}
          onHome={() => run({ id: "view.home" })}
        />
      )}
      <SelectionBar runtime={runtime} run={run} />
      <div className="vp-side">
        <SectionPanel runtime={runtime} run={run} />
        {measureOpen && <MeasurePanel result={measurement} count={sel.items.length} onClose={() => run({ id: "measure.toggle", args: { open: false } })} />}
      </div>
      {vpStatus.kind !== "none" && (
        <div className="vp-chip" title={vpStatus.kind === "placeholder" ? "Placeholder renderer until @aicad/forge-web is available" : "forge-render"}>
          {vpStatus.kind === "placeholder" ? "Placeholder" : "forge-render"} · {vpStatus.backend}
        </div>
      )}
      {sel.hover && (
        <div className="vp-hover" data-testid="viewport-hover">
          {labelOf(sel.hover, ir)}
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
