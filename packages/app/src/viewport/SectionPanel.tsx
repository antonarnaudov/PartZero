/**
 * Section view panel: base plane (XY, XZ, YZ, or the face it came from), offset slider and field,
 * flip, remove. The plane also gets a drag handle (a `linear` manipulator along its normal).
 */
import { useEffect, useSyncExternalStore, type ReactElement } from "react";
import type { ViewportRuntime } from "./runtime";
import { dot, scale, sub, add } from "./view-camera";

export interface SectionPanelProps {
  runtime: ViewportRuntime;
  run: (cmd: { id: string; args?: Record<string, unknown> }) => void;
}

function fmt(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(Object.is(r, -0) ? 0 : r);
}

export function SectionPanel({ runtime, run }: SectionPanelProps): ReactElement | null {
  const view = useSyncExternalStore(runtime.view.subscribe, runtime.view.getState);
  const s = view.section;
  const base = s?.base ?? null;
  const origin = s?.origin;
  const normal = s?.normal;

  // The plane's drag handle, anchored on the base plane next to the model's centre.
  useEffect(() => {
    if (!s || !origin || !normal) return;
    const topo = runtime.topo;
    let c: [number, number, number] = [0, 0, 0];
    if (topo.bbox) c = scale(add(topo.bbox.min, topo.bbox.max), 0.5);
    const anchor = sub(c, scale(normal, dot(sub(c, origin), normal)));
    const range = runtime.sectionRange();
    const off = runtime.manipulators.show(
      [{ id: "section", kind: "linear", origin: anchor, axis: normal, value: runtime.view.getState().section?.offset ?? 0, min: range.min, max: range.max, step: 1, fineStep: 0.1, label: "Offset" }],
      (ch) => {
        if (ch.phase === "drag" || ch.phase === "end" || ch.phase === "cancel") runtime.view.patchSection({ offset: ch.value });
      },
    );
    return off;
    // Re-anchor only when the plane's base changes (offset drags must not re-create the handle).
  }, [runtime, base, origin, normal]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the handle on the plane when the offset changes elsewhere (slider, field, command).
  useEffect(() => {
    if (s && !runtime.manipulators.dragging && runtime.manipulators.handle("section")) runtime.manipulators.update("section", { value: s.offset });
  }, [runtime, s]);

  if (!s) return null;
  const range = runtime.sectionRange();
  const step = Math.max(0.01, (range.max - range.min) / 400);
  return (
    <div className="vp-panel vp-section" data-testid="section-panel" role="group" aria-label="Section view">
      <div className="vp-panel-head">
        <span className="vp-panel-title">Section</span>
        <span className="spacer" />
        <button type="button" className="vp-btn icon" title="Remove section" aria-label="Remove section" data-testid="section-close" onClick={() => run({ id: "view.clearSection" })}>
          ✕
        </button>
      </div>
      <div className="vp-seg" role="radiogroup" aria-label="Section plane">
        {(["XY", "XZ", "YZ"] as const).map((b) => (
          <button key={b} type="button" role="radio" aria-checked={s.base === b} className={`vp-btn${s.base === b ? " on" : ""}`} data-section-base={b} onClick={() => run({ id: "view.section", args: { base: b } })}>
            {b}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={s.base === "face"} className={`vp-btn${s.base === "face" ? " on" : ""}`} data-section-base="face" title="Section from the selected planar face" onClick={() => run({ id: "view.section", args: { base: "face" } })}>
          Face
        </button>
      </div>
      <label className="vp-field">
        <span>Offset</span>
        <input
          type="range"
          min={range.min}
          max={range.max}
          step={step}
          value={s.offset}
          data-testid="section-slider"
          onChange={(e) => run({ id: "view.setSectionOffset", args: { offset: Number(e.target.value) } })}
        />
        <input
          type="number"
          className="vp-num"
          step={0.1}
          value={fmt(s.offset)}
          data-testid="section-offset"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v)) run({ id: "view.setSectionOffset", args: { offset: v } });
          }}
        />
        <span className="vp-unit">mm</span>
      </label>
      <button type="button" className="vp-btn wide" data-testid="section-flip" onClick={() => run({ id: "view.flipSection" })}>
        Flip side
      </button>
    </div>
  );
}
