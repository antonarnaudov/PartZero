/**
 * Sketch mode in the app shell: the plane picker, then the sketch overlay over the viewport with
 * its tool palette, constraint bar, inspector (status, DOF, conflicts with one-click repairs,
 * constraints and dimensions), inline dimension editor, typed-value box, hint and notices.
 *
 * Mounted once inside the viewport column (ui/shell/AppShell.tsx). The ribbon's Sketch tool, the
 * integrator's `sketch.*` commands and the test hooks all drive the same `sketchMode`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { v1 } from "@aicad/ir-types";
import { applicableKinds, CONSTRAINT_KINDS, type SketchSel } from "../../sketch/constraints";
import { contextFromBodies } from "../../sketch/context";
import type { SketchMode, SketchModeState, SketchPlaneChoice } from "../../sketch/controller";
import { faceFrame, namedFrame, type NamedPlane } from "../../sketch/frames";
import { fmt } from "../../sketch/geom";
import { sketchMode } from "../../sketch/instance";
import { documentSource, exposeSketchTestHooks, faceSource, newSketchOptions, quickExtrudeSource } from "../../sketch/integration";
import { installCadScriptBridge } from "../../sketch/v0-app";
import { PlaneView } from "../../sketch/view";
import { SKETCH_TOOLS, type ToolId } from "../../tools/sketch";
import { useApp, useStore } from "../context";
import { SketchCanvas } from "./SketchCanvas";
import { ConstructionIcon, GridIcon, ToolIcon } from "./tool-icons";
import "./sketch.css";

const PLANES: Array<{ plane: NamedPlane; label: string; hint: string }> = [
  { plane: "XY", label: "XY", hint: "Top (looking down Z)" },
  { plane: "XZ", label: "XZ", hint: "Front (looking along Y)" },
  { plane: "YZ", label: "YZ", hint: "Right (looking along −X)" },
];

function useSketch<S>(select: (s: SketchModeState) => S): S {
  return useStore(sketchMode, select);
}

function PlanePicker({ onPick }: { onPick: (c: SketchPlaneChoice) => void }): ReactElement {
  const [face, setFace] = useState<{ choice: SketchPlaneChoice } | null>(null);
  useEffect(() => {
    let alive = true;
    void faceSource.current?.().then((f) => {
      if (!alive || !f) return;
      const frame = faceFrame(f.normal, f.point);
      if (frame) setFace({ choice: { ref: f.ref, frame, label: f.label } });
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="sk-plane-picker" role="dialog" aria-label="Choose a sketch plane" data-testid="sketch-plane-picker">
      <div className="sk-card">
        <div className="sk-card-title">Sketch on</div>
        <div className="sk-plane-row">
          {PLANES.map((p) => (
            <button
              key={p.plane}
              type="button"
              className="sk-plane-btn"
              data-testid={`sketch-plane-${p.plane}`}
              title={p.hint}
              onClick={() => onPick({ ref: p.plane, frame: namedFrame(p.plane), label: `${p.plane} plane` })}
            >
              <span className="sk-plane-name">{p.label}</span>
              <span className="sk-plane-hint">{p.hint}</span>
            </button>
          ))}
        </div>
        <button type="button" className="sk-plane-btn wide" disabled={!face} data-testid="sketch-plane-face" onClick={() => face && onPick(face.choice)} title={face ? face.choice.label : "Select a planar face in the viewport first"}>
          <span className="sk-plane-name">{face ? face.choice.label : "Selected face"}</span>
          <span className="sk-plane-hint">{face ? "Sketch on the selected planar face" : "Select a planar face in the viewport first"}</span>
        </button>
        <div className="sk-card-foot">
          <button type="button" className="ghost-btn" onClick={() => sketchMode.dismissPlanePicker()}>
            Cancel
          </button>
          <span className="sk-muted">Esc</span>
        </div>
      </div>
    </div>
  );
}

function Palette({ mode, state }: { mode: SketchMode; state: SketchModeState }): ReactElement {
  const groups: Array<{ id: string; tools: typeof SKETCH_TOOLS }> = [
    { id: "select", tools: SKETCH_TOOLS.filter((t) => t.group === "select") },
    { id: "draw", tools: SKETCH_TOOLS.filter((t) => t.group === "draw") },
    { id: "dimension", tools: SKETCH_TOOLS.filter((t) => t.group === "dimension") },
    { id: "modify", tools: SKETCH_TOOLS.filter((t) => t.group === "modify") },
  ];
  return (
    <div className="sk-palette" role="toolbar" aria-label="Sketch tools" data-testid="sketch-palette">
      {groups.map((g) => (
        <div key={g.id} className="sk-palette-group">
          {g.tools.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`sk-tool${state.tool === t.id ? " active" : ""}`}
              title={t.key ? `${t.label} (${t.key.toUpperCase()})` : t.label}
              aria-label={t.label}
              aria-pressed={state.tool === t.id}
              data-testid={`sketch-tool-${t.id}`}
              onClick={() => mode.setTool(t.id as ToolId)}
            >
              <ToolIcon id={t.id} />
            </button>
          ))}
        </div>
      ))}
      <div className="sk-palette-group">
        <button type="button" className={`sk-tool${state.construction ? " active" : ""}`} title="Construction (X)" aria-label="Construction" aria-pressed={state.construction} data-testid="sketch-construction" onClick={() => mode.toggleConstruction()}>
          <ConstructionIcon />
        </button>
        <button type="button" className={`sk-tool${state.gridSnap ? " active" : ""}`} title="Snap to grid (G)" aria-label="Snap to grid" aria-pressed={state.gridSnap} data-testid="sketch-grid-snap" onClick={() => mode.toggleGrid()}>
          <GridIcon />
        </button>
      </div>
    </div>
  );
}

function ConstraintBar({ mode, state }: { mode: SketchMode; state: SketchModeState }): ReactElement {
  const curves = state.live ?? state.snapshot?.curves ?? [];
  const ok = useMemo(() => new Set(applicableKinds(state.selection, curves)), [state.selection, curves]);
  return (
    <div className="sk-constraint-bar" role="toolbar" aria-label="Constraints" data-testid="sketch-constraints">
      {CONSTRAINT_KINDS.map((c) => (
        <button
          key={c.kind}
          type="button"
          className="sk-con"
          disabled={!ok.has(c.kind)}
          title={c.key ? `${c.label} (${c.key.toUpperCase()})` : c.label}
          aria-label={c.label}
          data-testid={`sketch-constrain-${c.kind}`}
          onClick={() => mode.constrain(c.kind)}
        >
          {c.glyph}
        </button>
      ))}
    </div>
  );
}

function statusOf(state: SketchModeState): { cls: string; text: string } {
  const s = state.snapshot;
  if (!s) return { cls: "", text: "" };
  if (s.curves.length === 0) return { cls: "", text: "Empty sketch" };
  if (!s.ok) {
    if (s.error?.code === "SKETCH_CONSTRAINT_CONFLICT") return { cls: "conflict", text: "Conflict" };
    return { cls: "conflict", text: s.error?.code === "SKETCH_SOLVE_FAILED" ? "Does not solve" : "Invalid" };
  }
  if (s.status === "fully_constrained") return { cls: "fixed", text: "Fully constrained" };
  if (s.status === "over_constrained_redundant") return { cls: "warn", text: `Redundant · ${s.dof ?? 0} DOF` };
  return { cls: "free", text: `${s.dof ?? 0} DOF left` };
}

const TYPE_LABEL: Record<string, string> = {
  coincident: "Coincident",
  horizontal: "Horizontal",
  vertical: "Vertical",
  parallel: "Parallel",
  perpendicular: "Perpendicular",
  tangent: "Tangent",
  equal: "Equal",
  distance: "Distance",
  angle: "Angle",
  radius: "Radius",
  diameter: "Diameter",
  point_on_line: "On line",
  point_on_circle: "On circle",
  midpoint: "Midpoint",
  symmetric: "Symmetric",
  fix: "Fix",
};

function argsText(c: v1.Constraint): string {
  return Object.entries(c)
    .filter(([k, v]) => k !== "id" && k !== "type" && k !== "value" && k !== "driving" && typeof v === "string")
    .map(([, v]) => String(v))
    .join(", ");
}

function Inspector({ mode, state }: { mode: SketchMode; state: SketchModeState }): ReactElement {
  const s = state.snapshot;
  const st = statusOf(state);
  const [open, setOpen] = useState(true);
  const isSel = (x: SketchSel): boolean => state.selection.some((y) => JSON.stringify(y) === JSON.stringify(x));
  const status = (
    <div className={`sk-status ${st.cls}`} data-testid="sketch-status" data-status={s?.status ?? ""} data-dof={s?.dof ?? ""}>
      <span className="sk-status-dot" />
      {st.text}
      <button type="button" className="sk-row-btn sk-collapse" title={open ? "Collapse" : "Expand"} aria-label={open ? "Collapse the sketch panel" : "Expand the sketch panel"} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"}
      </button>
    </div>
  );
  if (!open) {
    return (
      <aside className="sk-inspector collapsed" aria-label="Sketch" data-testid="sketch-inspector">
        {status}
      </aside>
    );
  }
  return (
    <aside className="sk-inspector" aria-label="Sketch" data-testid="sketch-inspector">
      {status}
      {s && s.conflicts.length > 0 && (
        <div className="sk-section" data-testid="sketch-conflicts">
          <div className="sk-section-title">Conflicts</div>
          {s.conflicts.map((c, i) => (
            <div key={i} className="sk-conflict">
              <div className="sk-conflict-text">{c.explanation}</div>
              <button type="button" className="ghost-btn tiny" data-testid={`sketch-remove-${c.suggestedRemoval}`} onClick={() => mode.removeConstraint(c.suggestedRemoval)}>
                Remove {c.suggestedRemoval}
              </button>
            </div>
          ))}
        </div>
      )}
      {s && !s.ok && s.error && s.error.code !== "SKETCH_CONSTRAINT_CONFLICT" && <div className="sk-section sk-error">{s.error.message}</div>}
      {s?.ok && s.profile.error && (
        <div className="sk-section sk-muted" data-testid="sketch-profile">
          Profile: {s.profile.error.code === "SKETCH_OPEN_LOOP" ? "open (close it to make a region)" : s.profile.error.message}
        </div>
      )}
      {s?.ok && !s.profile.error && (
        <div className="sk-section sk-muted" data-testid="sketch-profile">
          {s.profile.regions.length} closed region{s.profile.regions.length === 1 ? "" : "s"}
          {s.profile.regions.length > 0 && ` · ${s.profile.regions.map((r) => fmt(r.area, 1)).join(", ")} mm²`}
        </div>
      )}
      <div className="sk-section sk-list">
        <div className="sk-section-title">Constraints · {s?.constraints.length ?? 0}</div>
        {(state.feature?.constraints ?? []).map((c) => {
          const info = s?.constraints.find((x) => x.id === c.id);
          const dim = info?.driving !== undefined;
          return (
            <div
              key={c.id}
              className={`sk-row state-${info?.state ?? "none"}${isSel({ kind: "constraint", id: c.id }) ? " selected" : ""}`}
              data-testid={`sketch-constraint-${c.id}`}
              onClick={(e) => mode.select([{ kind: "constraint", id: c.id }], e.shiftKey)}
              onDoubleClick={() => dim && mode.editDimension(c.id)}
            >
              <span className="sk-row-type">{TYPE_LABEL[c.type] ?? c.type}</span>
              <span className="sk-row-args">{dim ? (info?.driving === false ? `(${fmt(info?.measured ?? NaN, 3)})` : `${info?.expr ? `${info.expr} = ` : ""}${fmt(info?.value ?? NaN, 3)}`) : argsText(c)}</span>
              {dim && (
                <button
                  type="button"
                  className="sk-row-btn"
                  title={info?.driving === false ? "Make driving" : "Make driven (reference)"}
                  onClick={(e) => {
                    e.stopPropagation();
                    mode.toggleDriving(c.id);
                  }}
                >
                  {info?.driving === false ? "ref" : "drv"}
                </button>
              )}
              <button
                type="button"
                className="sk-row-btn"
                title="Remove"
                aria-label={`Remove ${c.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  mode.removeConstraint(c.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function DimensionEditor({ mode, state }: { mode: SketchMode; state: SketchModeState }): ReactElement | null {
  const d = state.dimEdit;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [d?.mode, d?.id, d?.proposal]);
  if (!d) return null;
  const p = new PlaneView(state.view).toScreen(d.at);
  return (
    <div className="sk-dim-editor" style={{ left: p[0], top: p[1] }} data-testid="sketch-dim-editor" onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={input}
        className={`sk-dim-input${d.error ? " err" : ""}`}
        value={d.text}
        spellCheck={false}
        aria-label={d.field === "angle" ? "Angle (degrees)" : "Length (mm)"}
        data-testid="sketch-dim-input"
        onChange={(e) => mode.setDimText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            mode.commitDimension();
          } else if (e.key === "Escape") {
            e.preventDefault();
            mode.cancelDimension();
          }
        }}
      />
      <span className="sk-dim-unit">{d.field === "angle" ? "°" : "mm"}</span>
      {d.error && (
        <div className="sk-dim-error" data-testid="sketch-dim-error">
          {d.error}
          {d.conflict && (
            <button type="button" className="ghost-btn tiny" data-testid="sketch-make-driven" onClick={() => mode.makeDriven()}>
              Make driven
            </button>
          )}
        </div>
      )}
      <div className="sk-dim-help">number · expression (width*2) · name = value</div>
    </div>
  );
}

function TypedBox({ mode, state }: { mode: SketchMode; state: SketchModeState }): ReactElement | null {
  const t = state.typed;
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (t) {
      const el = input.current;
      el?.focus();
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [t?.label, t !== null]);
  if (!t) return null;
  return (
    <div className="sk-typed" data-testid="sketch-typed">
      <label>
        {t.label}
        <input
          ref={input}
          value={t.text}
          data-testid="sketch-typed-input"
          onChange={(e) => mode.setTypedText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              mode.commitTyped();
            } else if (e.key === "Escape") {
              e.preventDefault();
              mode.cancelTyped();
            }
          }}
        />
      </label>
      {t.error && <span className="sk-typed-error">{t.error}</span>}
    </div>
  );
}

type Direction = "normal" | "reverse" | "symmetric";

/**
 * After Finish: extrude the new sketch right away (the quick follow-up until the feature tools'
 * extrude exists; `quickExtrudeSource`).
 */
function ExtrudeOffer({ sketch, onClose }: { sketch: string; onClose: () => void }): ReactElement {
  const { services } = useApp();
  const [text, setText] = useState("10");
  const [direction, setDirection] = useState<Direction>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (): Promise<void> => {
    const extrude = quickExtrudeSource.current;
    const d = Number(text);
    if (!extrude) return;
    if (!(d > 0) || !Number.isFinite(d)) {
      setError("Type a distance greater than zero.");
      return;
    }
    setBusy(true);
    const r = await extrude(sketch, d, direction);
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    if (r.warning) services.ui.toast("error", r.warning);
    else if (r.note) services.ui.toast("success", r.note);
    onClose();
  };
  return (
    <div className="sk-extrude-offer" role="dialog" aria-label={`Extrude ${sketch}`} data-testid="sketch-extrude-offer">
      <span className="sk-extrude-title">
        Extrude <b>{sketch}</b>
      </span>
      <label className="sk-extrude-field">
        <input
          value={text}
          inputMode="decimal"
          aria-label="Distance (mm)"
          data-testid="sketch-extrude-distance"
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void run();
            else if (e.key === "Escape") onClose();
          }}
        />
        <span className="sk-muted">mm</span>
      </label>
      <select value={direction} aria-label="Direction" data-testid="sketch-extrude-direction" onChange={(e) => setDirection(e.target.value as Direction)}>
        <option value="normal">Along the normal</option>
        <option value="reverse">Reversed</option>
        <option value="symmetric">Symmetric</option>
      </select>
      <button type="button" className="primary-btn" disabled={busy} data-testid="sketch-extrude-run" onClick={() => void run()}>
        Extrude
      </button>
      <button type="button" className="ghost-btn" aria-label="Close" data-testid="sketch-extrude-close" onClick={onClose}>
        ×
      </button>
      {error && (
        <span className="sk-extrude-error" data-testid="sketch-extrude-error">
          {error}
        </span>
      )}
    </div>
  );
}

/** The sketch mode overlay (mounted inside the viewport column). */
export function SketchModeHost(): ReactElement | null {
  const { services, commands } = useApp();
  const state = useSketch((s) => s);
  const bodies = useStore(services.doc, (s) => s.bodies);
  const [offer, setOffer] = useState<string | null>(null);

  useEffect(() => exposeSketchTestHooks(sketchMode), []);
  // Finished sketches go into the open CadScript document (the interim sink, docs/fm/sketcher.md).
  useEffect(() => installCadScriptBridge(sketchMode, services.doc, commands), [services.doc, commands]);

  const beginOn = useCallback(
    (plane: SketchPlaneChoice) => {
      const context = contextFromBodies(bodies, plane.frame);
      void sketchMode.begin(newSketchOptions(plane, context, documentSource.current?.() ?? null));
    },
    [bodies],
  );

  // A load error (no WASM in this build) surfaces as a toast.
  useEffect(() => {
    if (state.error) services.ui.toast("error", state.error);
  }, [state.error, services.ui]);

  // Say what Finish produced, and offer to extrude it.
  const finished = state.finished;
  const finishedNote = state.finishedNote;
  useEffect(() => {
    if (!finished) return;
    const c = finished.check;
    const how = c.status === "fully_constrained" ? "fully constrained" : c.dof !== undefined ? `${c.dof} DOF left` : "explicit";
    const where = sketchMode.usingMemorySink ? " It joins the model once the IR v1 command layer is merged." : finishedNote?.note ? ` ${finishedNote.note}` : "";
    services.ui.toast(c.ok ? "success" : "error", `Sketch ${finished.feature.name}: ${c.regions} region${c.regions === 1 ? "" : "s"}, ${how}.${where}`);
    if (finishedNote?.warning) services.ui.toast("error", finishedNote.warning);
    setOffer(c.ok && c.regions > 0 && quickExtrudeSource.current ? finished.feature.name : null);
  }, [finished, finishedNote, services.ui]);
  useEffect(() => {
    if (state.phase !== "off") setOffer(null);
  }, [state.phase]);

  if (state.phase === "off") return offer ? <ExtrudeOffer sketch={offer} onClose={() => setOffer(null)} /> : null;
  if (state.phase === "choosePlane") return <PlanePicker onPick={beginOn} />;
  if (state.phase === "loading") {
    return (
      <div className="sk-overlay loading" data-testid="sketch-loading">
        <div className="sk-loading">Opening the sketch…</div>
      </div>
    );
  }
  return (
    <div className="sk-overlay" data-testid="sketch-mode" data-phase={state.phase}>
      <SketchCanvas mode={sketchMode} state={state} />
      <div className="sk-header">
        <span className="sk-title">
          Sketch <b>{state.sketchName}</b> on {state.plane?.label ?? ""}
        </span>
        <button type="button" className="ghost-btn" data-testid="sketch-undo" title="Undo in sketch (⌘Z)" disabled={!state.snapshot?.canUndo} onClick={() => sketchMode.undo()}>
          Undo
        </button>
        <button type="button" className="ghost-btn" data-testid="sketch-redo" title="Redo in sketch (⌘⇧Z)" disabled={!state.snapshot?.canRedo} onClick={() => sketchMode.redo()}>
          Redo
        </button>
        <button type="button" className="ghost-btn" title="Fit (F)" onClick={() => sketchMode.fit()}>
          Fit
        </button>
        <button type="button" className="ghost-btn" data-testid="sketch-cancel" onClick={() => sketchMode.cancel()}>
          Cancel
        </button>
        <button type="button" className="primary-btn" data-testid="sketch-finish" onClick={() => void sketchMode.finish()}>
          Finish sketch
        </button>
      </div>
      <Palette mode={sketchMode} state={state} />
      <ConstraintBar mode={sketchMode} state={state} />
      <Inspector mode={sketchMode} state={state} />
      <DimensionEditor mode={sketchMode} state={state} />
      <TypedBox mode={sketchMode} state={state} />
      <div className="sk-footer">
        <span className="sk-hint" data-testid="sketch-hint">
          {state.hint}
        </span>
        {state.notice && (
          <span className={`sk-notice ${state.notice.kind}`} data-testid="sketch-notice">
            {state.notice.text}
            {state.notice.kind === "error" && state.notice.text.includes("Finish anyway") && (
              <button type="button" className="ghost-btn tiny" data-testid="sketch-finish-anyway" onClick={() => void sketchMode.finish({ force: true })}>
                Finish anyway
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** The toolbar's Sketch button (one element in Toolbar.tsx). */
export function SketchButton(): ReactElement {
  const phase = useSketch((s) => s.phase);
  return (
    <div className="tb-group">
      <button
        type="button"
        className={`tb-btn sk-tb-btn${phase !== "off" ? " active" : ""}`}
        title="New sketch (on a plane or a planar face)"
        aria-label="New sketch"
        data-testid="toolbar-sketch"
        onClick={() => (phase === "off" ? sketchMode.requestNew() : undefined)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 13.5 L2.5 6.5 L9.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="10.5" cy="10.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11 2 L14 5 L8.5 10.5 L6 11 L6.5 8.5 Z" fill="none" stroke="currentColor" strokeWidth="1.1" />
        </svg>
        <span className="sk-tb-label">Sketch</span>
      </button>
    </div>
  );
}
