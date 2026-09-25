/**
 * The sketch overlay (plan §2.7 "Display"): an SVG drawn from the sketch view — grid, axes and
 * origin, the model's projected edges, shaded regions, curves coloured by their degrees of
 * freedom (blue free, solid fully constrained, red in conflict, dashed construction, grey when
 * the sketch does not solve), points, constraint glyphs, dimensions, the tool's rubber band,
 * snap marker and inference lines.
 */
import { useEffect, useMemo, useRef, type ReactElement, type PointerEvent as RPointerEvent } from "react";
import type { v1 } from "@aicad/ir-types";
import { findCurve, refPoint, splitRef, type SketchSel } from "../../sketch/constraints";
import type { SketchMode, SketchModeState } from "../../sketch/controller";
import { dimGraphic, dimText, measure, shapeOf, type DimShape } from "../../sketch/dimension";
import type { ConstraintInfo, EntityDof, SketchSnapshot } from "../../sketch/engine-types";
import { arcParams, curvePoint, mid, norm, perp, sub, type LiteralCurve, type P2 } from "../../sketch/geom";
import { gridStep, PlaneView } from "../../sketch/view";
import type { SnapKind } from "../../sketch/snap";
import type { PointerIn } from "../../tools/sketch/types";

type Cls = "free" | "fixed" | "conflict" | "failed";

function curveClass(c: LiteralCurve, snap: SketchSnapshot, conflictCurves: ReadonlySet<string>): Cls {
  if (!snap.ok) return conflictCurves.has(c.id) ? "conflict" : "failed";
  if (conflictCurves.has(c.id)) return "conflict";
  const e = snap.entities.find((x) => x.id === c.id);
  return e && e.dof === 0 ? "fixed" : "free";
}

function pointClass(e: EntityDof | undefined, which: string): Cls {
  const d = e?.points[which as "start"]?.dof;
  return d === 0 ? "fixed" : "free";
}

/** SVG path data of a curve in screen space. */
export function curvePath(c: LiteralCurve, v: PlaneView): string {
  const s = (p: P2): string => {
    const q = v.toScreen(p);
    return `${q[0].toFixed(2)} ${q[1].toFixed(2)}`;
  };
  switch (c.kind) {
    case "line":
      return `M ${s(c.start)} L ${s(c.end)}`;
    case "circle": {
      const r = c.radius * v.s.scale;
      const cx = v.toScreen(c.center);
      return `M ${(cx[0] - r).toFixed(2)} ${cx[1].toFixed(2)} a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(2 * r).toFixed(2)} 0 a ${r.toFixed(2)} ${r.toFixed(2)} 0 1 0 ${(-2 * r).toFixed(2)} 0`;
    }
    case "arc": {
      const ap = arcParams(c);
      const r = (ap.r * v.s.scale).toFixed(2);
      const from: P2 = [ap.center[0] + ap.r * Math.cos(ap.a0), ap.center[1] + ap.r * Math.sin(ap.a0)];
      const to: P2 = [ap.center[0] + ap.r * Math.cos(ap.a0 + ap.sweep), ap.center[1] + ap.r * Math.sin(ap.a0 + ap.sweep)];
      const large = ap.sweep > Math.PI ? 1 : 0;
      // Screen y points down: a ccw sweep in the sketch is clockwise on screen (sweep-flag 0).
      return `M ${s(from)} A ${r} ${r} 0 ${large} 0 ${s(to)}`;
    }
    case "point":
      return "";
  }
}

function regionPath(loop: Array<{ id: string; reversed: boolean }>, curves: readonly LiteralCurve[], v: PlaneView): string {
  const parts: string[] = [];
  let first = true;
  for (const e of loop) {
    const c = findCurve(curves, e.id);
    if (!c) return "";
    if (c.kind === "circle") {
      parts.push(curvePath(c, v));
      continue;
    }
    if (c.kind === "line") {
      const [a, b] = e.reversed ? [c.end, c.start] : [c.start, c.end];
      const pa = v.toScreen(a);
      const pb = v.toScreen(b);
      parts.push(`${first ? "M" : "L"} ${pa[0].toFixed(2)} ${pa[1].toFixed(2)} L ${pb[0].toFixed(2)} ${pb[1].toFixed(2)}`);
    } else if (c.kind === "arc") {
      const ap = arcParams(c);
      const r = (ap.r * v.s.scale).toFixed(2);
      const s0: P2 = [ap.center[0] + ap.r * Math.cos(ap.a0), ap.center[1] + ap.r * Math.sin(ap.a0)];
      const s1: P2 = [ap.center[0] + ap.r * Math.cos(ap.a0 + ap.sweep), ap.center[1] + ap.r * Math.sin(ap.a0 + ap.sweep)];
      // Traversal: IR start→end, reversed when the loop runs it backwards; ccw-ness decides the flag.
      const irStart = c.start;
      const forward = !e.reversed;
      const runsCcw = forward === c.ccw;
      const [from, to] = runsCcw ? [s0, s1] : [s1, s0];
      void irStart;
      const pf = v.toScreen(from);
      const pt = v.toScreen(to);
      parts.push(`${first ? "M" : "L"} ${pf[0].toFixed(2)} ${pf[1].toFixed(2)} A ${r} ${r} 0 ${ap.sweep > Math.PI ? 1 : 0} ${runsCcw ? 0 : 1} ${pt[0].toFixed(2)} ${pt[1].toFixed(2)}`);
    }
    first = false;
  }
  return parts.join(" ") + " Z";
}

const GLYPH: Record<string, string> = {
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  tangent: "T",
  equal: "=",
  coincident: "●",
  point_on_line: "⌒",
  point_on_circle: "⌒",
  midpoint: "M",
  symmetric: "⋈",
  fix: "⚓",
};

interface Glyph {
  id: string;
  text: string;
  at: P2;
  state: ConstraintInfo["state"];
}

/** Where each non-dimension constraint's glyph goes (screen space, stacked per anchor). */
function glyphs(feature: v1.SketchFeature | null, snap: SketchSnapshot, curves: readonly LiteralCurve[], v: PlaneView): Glyph[] {
  const out: Glyph[] = [];
  const stack = new Map<string, number>();
  const place = (id: string, text: string, anchor: P2, offset: P2, state: ConstraintInfo["state"]): void => {
    const s = v.toScreen(anchor);
    const key = `${Math.round(s[0] / 8)},${Math.round(s[1] / 8)}`;
    const k = stack.get(key) ?? 0;
    stack.set(key, k + 1);
    out.push({ id, text, at: [s[0] + offset[0] + k * 15, s[1] + offset[1]], state });
  };
  const curveMid = (id: string): P2 | null => {
    const c = findCurve(curves, id);
    if (!c) return null;
    if (c.kind === "line") return mid(c.start, c.end);
    if (c.kind === "arc") return curvePoint(c, "mid");
    if (c.kind === "circle") return [c.center[0], c.center[1] + c.radius];
    return c.at;
  };
  const lineOffset = (id: string): P2 => {
    const c = findCurve(curves, id);
    if (c?.kind !== "line") return [8, -14];
    const n = norm(perp(sub(c.end, c.start)));
    return [n[0] * 12 + 4, -n[1] * 12 - 6];
  };
  for (const con of feature?.constraints ?? []) {
    if (shapeOf(con)) continue;
    const info = snap.constraints.find((c) => c.id === con.id);
    const state = info?.state;
    let text = GLYPH[con.type] ?? "?";
    switch (con.type) {
      case "horizontal":
      case "vertical": {
        const m = curveMid(con.line);
        if (m) place(con.id, text, m, lineOffset(con.line), state);
        break;
      }
      case "parallel":
      case "perpendicular":
      case "tangent":
      case "equal":
        for (const c of [con.a, con.b]) {
          const m = curveMid(c);
          if (m) place(con.id, text, m, lineOffset(c), state);
        }
        break;
      case "coincident": {
        if (con.a.endsWith(".center") && con.b.endsWith(".center")) text = "◎";
        const p = refPoint(curves, con.a);
        if (p) place(con.id, text, p, [8, 10], state);
        break;
      }
      case "point_on_line":
      case "midpoint": {
        const p = refPoint(curves, con.point);
        if (p) place(con.id, text, p, [8, 10], state);
        break;
      }
      case "point_on_circle": {
        const p = refPoint(curves, con.point);
        if (p) place(con.id, text, p, [8, 10], state);
        break;
      }
      case "symmetric": {
        const a = refPoint(curves, con.a);
        const b = refPoint(curves, con.b);
        if (a && b) place(con.id, text, mid(a, b), [6, -10], state);
        break;
      }
      case "fix": {
        const p = refPoint(curves, con.entity) ?? curveMid(con.entity);
        if (p) place(con.id, text, p, [-18, 12], state);
        break;
      }
    }
  }
  return out;
}

const SNAP_MARK: Partial<Record<SnapKind, string>> = {
  endpoint: "square",
  point: "square",
  center: "circle",
  origin: "circle",
  midpoint: "triangle",
  quadrant: "diamond",
  intersection: "x",
  onCurve: "dot",
  model: "square",
  axis: "dot",
  grid: "dot",
};

function SnapMarker({ at, kind }: { at: P2; kind: SnapKind }): ReactElement | null {
  const shape = SNAP_MARK[kind];
  if (!shape) return null;
  const [x, y] = at;
  const cls = `sk-snap sk-snap-${kind}`;
  switch (shape) {
    case "square":
      return <rect className={cls} x={x - 5} y={y - 5} width={10} height={10} />;
    case "circle":
      return <circle className={cls} cx={x} cy={y} r={6} />;
    case "triangle":
      return <path className={cls} d={`M ${x} ${y - 6} L ${x + 6} ${y + 5} L ${x - 6} ${y + 5} Z`} />;
    case "diamond":
      return <path className={cls} d={`M ${x} ${y - 6} L ${x + 6} ${y} L ${x} ${y + 6} L ${x - 6} ${y} Z`} />;
    case "x":
      return <path className={cls} d={`M ${x - 5} ${y - 5} L ${x + 5} ${y + 5} M ${x - 5} ${y + 5} L ${x + 5} ${y - 5}`} />;
    default:
      return <circle className={`${cls} sk-snap-dot`} cx={x} cy={y} r={3} />;
  }
}

function Arrow({ at, dir, v }: { at: P2; dir: P2; v: PlaneView }): ReactElement {
  const p = v.toScreen(at);
  // Screen direction (y flipped).
  const d: P2 = norm([dir[0], -dir[1]]);
  const n: P2 = [-d[1], d[0]];
  const b: P2 = [p[0] - d[0] * 8, p[1] - d[1] * 8];
  return <path className="sk-dim-arrow" d={`M ${p[0]} ${p[1]} L ${b[0] + n[0] * 3} ${b[1] + n[1] * 3} L ${b[0] - n[0] * 3} ${b[1] - n[1] * 3} Z`} />;
}

interface DimRender {
  id: string;
  shape: DimShape;
  info: ConstraintInfo | undefined;
}

function Dimension({
  d,
  curves,
  v,
  labelAt,
  selected,
  onLabelDown,
  onLabelDouble,
  pending,
}: {
  d: DimRender;
  curves: readonly LiteralCurve[];
  v: PlaneView;
  labelAt: P2 | null;
  selected: boolean;
  onLabelDown?: (e: RPointerEvent) => void;
  onLabelDouble?: () => void;
  pending?: boolean;
}): ReactElement | null {
  const g = dimGraphic(d.shape, curves, labelAt, v.mmPerPx());
  if (!g) return null;
  const text = dimText(d.shape, d.info, measure(d.shape, curves));
  const state = d.info?.state;
  const cls = `sk-dim${d.info?.driving === false ? " driven" : ""}${state === "conflicting" || state === "unsatisfied" ? " conflict" : ""}${selected ? " selected" : ""}${pending ? " pending" : ""}`;
  const L = v.toScreen(g.label);
  const w = Math.max(28, text.length * 7 + 10);
  let arcPath = "";
  if (g.arc) {
    const { center, r, a0, a1 } = g.arc;
    const from = v.toScreen([center[0] + r * Math.cos(a0), center[1] + r * Math.sin(a0)]);
    const to = v.toScreen([center[0] + r * Math.cos(a1), center[1] + r * Math.sin(a1)]);
    const rs = r * v.s.scale;
    arcPath = `M ${from[0]} ${from[1]} A ${rs} ${rs} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${to[0]} ${to[1]}`;
  }
  return (
    <g className={cls} data-testid={pending ? "sketch-pending-dimension" : `sketch-dim-${d.id}`}>
      {g.lines.map(([a, b], i) => {
        const p = v.toScreen(a);
        const q = v.toScreen(b);
        return <line key={i} className="sk-dim-line" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
      })}
      {arcPath && <path className="sk-dim-line" d={arcPath} />}
      {g.arrows.map((a, i) => (
        <Arrow key={i} at={a.at} dir={a.dir} v={v} />
      ))}
      <g
        className="sk-dim-label"
        transform={`translate(${L[0]} ${L[1]})`}
        onPointerDown={onLabelDown}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onLabelDouble?.();
        }}
      >
        <rect x={-w / 2} y={-9} width={w} height={18} rx={4} />
        <text textAnchor="middle" dy={4}>
          {text}
        </text>
      </g>
    </g>
  );
}

function sameSel(a: SketchSel, b: SketchSel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function SketchCanvas({ mode, state }: { mode: SketchMode; state: SketchModeState }): ReactElement {
  const ref = useRef<SVGSVGElement>(null);
  const v = useMemo(() => new PlaneView(state.view), [state.view]);
  const snap = state.snapshot;
  const curves = state.live ?? snap?.curves ?? [];
  const lastDown = useRef<{ t: number; px: P2 } | null>(null);
  const labelDrag = useRef<{ id: string } | null>(null);

  // Size.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      mode.setViewport(r.width, r.height);
    });
    ro.observe(el);
    const r = el.getBoundingClientRect();
    mode.setViewport(r.width, r.height);
    return () => ro.disconnect();
  }, [mode]);

  // Wheel (non-passive: trackpad pans and pinches must not scroll the page).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      mode.wheel({ px: [e.clientX - r.left, e.clientY - r.top], deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [mode]);

  const toIn = (e: RPointerEvent, clicks = 1): PointerIn => {
    const r = ref.current!.getBoundingClientRect();
    return { px: [e.clientX - r.left, e.clientY - r.top], button: e.button, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, clicks };
  };

  const conflictCurves = useMemo(() => {
    const out = new Set<string>();
    if (!snap || !state.feature) return out;
    const bad = new Set(snap.conflicts.flatMap((c) => c.constraints));
    for (const con of state.feature.constraints ?? []) {
      if (!bad.has(con.id)) continue;
      for (const [k, val] of Object.entries(con)) {
        if (k === "id" || k === "type" || typeof val !== "string") continue;
        out.add(splitRef(val)[0]);
      }
    }
    return out;
  }, [snap, state.feature]);

  const dims: DimRender[] = useMemo(
    () =>
      (state.feature?.constraints ?? [])
        .map((c) => ({ id: c.id, shape: shapeOf(c), info: snap?.constraints.find((x) => x.id === c.id) }))
        .filter((d): d is DimRender => d.shape !== null),
    [state.feature, snap],
  );

  const sel = state.selection;
  const isSel = (s: SketchSel): boolean => sel.some((x) => sameSel(x, s));
  const hover = state.hover;
  const highlight = new Set(state.preview.highlight);

  // Grid.
  const step = gridStep(state.view.scale, 14);
  const major = step * 5;
  const tl = v.toSketch([0, 0]);
  const br = v.toSketch([state.view.width, state.view.height]);
  const gridLines: ReactElement[] = [];
  if (state.view.width > 0) {
    const x0 = Math.floor(tl[0] / step) * step;
    const y0 = Math.floor(br[1] / step) * step;
    let n = 0;
    for (let x = x0; x <= br[0] && n < 400; x += step, n++) {
      const sx = v.toScreen([x, 0])[0];
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      gridLines.push(<line key={`gx${n}`} className={isMajor ? "sk-grid major" : "sk-grid"} x1={sx} y1={0} x2={sx} y2={state.view.height} />);
    }
    n = 0;
    for (let y = y0; y <= tl[1] && n < 400; y += step, n++) {
      const sy = v.toScreen([0, y])[1];
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
      gridLines.push(<line key={`gy${n}`} className={isMajor ? "sk-grid major" : "sk-grid"} x1={0} y1={sy} x2={state.view.width} y2={sy} />);
    }
  }
  const o = v.toScreen([0, 0]);
  const g = snap && state.feature ? glyphs(state.feature, snap, curves, v) : [];

  return (
    <svg
      ref={ref}
      className={`sketch-canvas tool-${state.tool}`}
      data-testid="sketch-canvas"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (labelDrag.current) return;
        (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
        const now = performance.now();
        const input = toIn(e);
        const prev = lastDown.current;
        const clicks = prev && now - prev.t < 350 && Math.hypot(prev.px[0] - input.px[0], prev.px[1] - input.px[1]) < 5 ? 2 : 1;
        lastDown.current = { t: now, px: input.px };
        mode.pointerDown({ ...input, clicks });
      }}
      onPointerMove={(e) => {
        if (labelDrag.current) {
          const r = ref.current!.getBoundingClientRect();
          mode.moveLabel(labelDrag.current.id, v.toSketch([e.clientX - r.left, e.clientY - r.top]));
          return;
        }
        mode.pointerMove(toIn(e));
      }}
      onPointerUp={(e) => {
        if (labelDrag.current) {
          labelDrag.current = null;
          return;
        }
        mode.pointerUp(toIn(e));
      }}
    >
      <g className="sk-grid-layer">{gridLines}</g>
      <line className="sk-axis u" x1={0} y1={o[1]} x2={state.view.width} y2={o[1]} />
      <line className="sk-axis v" x1={o[0]} y1={0} x2={o[0]} y2={state.view.height} />
      <circle className="sk-origin" cx={o[0]} cy={o[1]} r={4} data-testid="sketch-origin" />

      <g className="sk-context">
        {state.context.lines.map(([a, b], i) => {
          const p = v.toScreen(a);
          const q = v.toScreen(b);
          return <line key={`c${i}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
        })}
        {state.context.onPlane.map(([a, b], i) => {
          const p = v.toScreen(a);
          const q = v.toScreen(b);
          return <line key={`o${i}`} className="on-plane" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
        })}
      </g>

      {snap?.ok && !state.live && (
        <g className="sk-regions">
          {snap.profile.regions.map((r, i) => (
            <path key={i} className="sk-region" data-testid="sketch-region" fillRule="evenodd" d={[regionPath(r.outer, curves, v), ...r.holes.map((h) => regionPath(h, curves, v))].join(" ")} />
          ))}
        </g>
      )}

      <g className="sk-curves">
        {curves
          .filter((c) => c.kind !== "point")
          .map((c) => {
            const cls = snap ? curveClass(c, snap, conflictCurves) : "free";
            const selected = isSel({ kind: "curve", id: c.id });
            const hovered = (hover && sameSel(hover, { kind: "curve", id: c.id })) || highlight.has(c.id);
            return (
              <path
                key={c.id}
                d={curvePath(c, v)}
                data-testid={`sketch-curve-${c.id}`}
                data-dof={cls}
                className={`sk-curve ${cls}${c.construction ? " construction" : ""}${selected ? " selected" : ""}${hovered ? " hovered" : ""}`}
              />
            );
          })}
      </g>

      <g className="sk-points">
        {curves.flatMap((c) => {
          const e = snap?.entities.find((x) => x.id === c.id);
          const pts: Array<[string, string, P2]> =
            c.kind === "point" ? [[c.id, "at", c.at]] : c.kind === "line" ? [[`${c.id}.start`, "start", c.start], [`${c.id}.end`, "end", c.end]] : c.kind === "arc" ? [[`${c.id}.start`, "start", c.start], [`${c.id}.end`, "end", c.end], [`${c.id}.center`, "center", c.center]] : [[`${c.id}.center`, "center", c.center]];
          return pts.map(([ref, which, p]) => {
            const s = v.toScreen(p);
            const cls = snap && !snap.ok ? "failed" : pointClass(e, which);
            const selected = isSel({ kind: "point", ref }) || (c.kind === "point" && isSel({ kind: "curve", id: c.id }));
            const hovered = hover && sameSel(hover, { kind: "point", ref });
            const center = which === "center";
            return center ? (
              <path key={ref} className={`sk-point center ${cls}${selected ? " selected" : ""}${hovered ? " hovered" : ""}`} d={`M ${s[0] - 3} ${s[1]} L ${s[0] + 3} ${s[1]} M ${s[0]} ${s[1] - 3} L ${s[0]} ${s[1] + 3}`} />
            ) : (
              <circle key={ref} className={`sk-point ${cls}${c.construction ? " construction" : ""}${selected ? " selected" : ""}${hovered ? " hovered" : ""}`} cx={s[0]} cy={s[1]} r={c.kind === "point" ? 3.5 : 2.5} />
            );
          });
        })}
      </g>

      <g className="sk-glyphs">
        {g.map((x, i) => {
          const selected = isSel({ kind: "constraint", id: x.id });
          return (
            <g
              key={`${x.id}-${i}`}
              className={`sk-glyph state-${x.state ?? "none"}${selected ? " selected" : ""}`}
              transform={`translate(${x.at[0]} ${x.at[1]})`}
              data-testid={`sketch-glyph-${x.id}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                mode.select([{ kind: "constraint", id: x.id }], e.shiftKey);
              }}
            >
              <rect x={-7} y={-7} width={14} height={14} rx={3} />
              <text textAnchor="middle" dy={4}>
                {x.text}
              </text>
            </g>
          );
        })}
      </g>

      <g className="sk-dims">
        {dims.map((d) => (
          <Dimension
            key={d.id}
            d={d}
            curves={curves}
            v={v}
            labelAt={state.labels[d.id] ?? null}
            selected={isSel({ kind: "constraint", id: d.id })}
            onLabelDown={(e) => {
              e.stopPropagation();
              labelDrag.current = { id: d.id };
              (ref.current as Element | null)?.setPointerCapture?.(e.pointerId);
              mode.select([{ kind: "constraint", id: d.id }], e.shiftKey);
            }}
            onLabelDouble={() => {
              labelDrag.current = null;
              const g0 = dimGraphic(d.shape, curves, state.labels[d.id] ?? null, v.mmPerPx());
              mode.editDimension(d.id, g0?.label);
            }}
          />
        ))}
        {state.pendingDim && (
          <Dimension d={{ id: "__pending", shape: state.pendingDim.proposal.shape, info: undefined }} curves={curves} v={v} labelAt={state.pendingDim.at} selected={false} pending />
        )}
      </g>

      <g className="sk-preview">
        {state.preview.curves.map((c, i) => (
          <path key={i} className={`sk-rubber${c.construction ? " construction" : ""}`} d={curvePath(c, v)} />
        ))}
        {state.preview.curves
          .filter((c): c is Extract<LiteralCurve, { kind: "point" }> => c.kind === "point")
          .map((c, i) => {
            const s = v.toScreen(c.at);
            return <circle key={`pp${i}`} className="sk-rubber-point" cx={s[0]} cy={s[1]} r={3} />;
          })}
        {state.preview.guides.map((gd, i) => {
          const p = v.toScreen(gd.from);
          const q = v.toScreen(gd.to);
          return <line key={`g${i}`} className={`sk-guide ${gd.kind}`} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />;
        })}
        {state.preview.marks.map((m, i) => {
          const s = v.toScreen(m);
          return <circle key={`m${i}`} className="sk-mark" cx={s[0]} cy={s[1]} r={4} />;
        })}
        {state.preview.labels.map((l, i) => {
          const s = v.toScreen(l.at);
          return (
            <text key={`l${i}`} className="sk-live-label" x={s[0] + 10} y={s[1] - 10}>
              {l.text}
            </text>
          );
        })}
        {state.preview.snap && <SnapMarker at={v.toScreen(state.preview.snap.point)} kind={state.preview.snap.kind} />}
        {state.preview.box &&
          (() => {
            const a = v.toScreen(state.preview.box.from);
            const b = v.toScreen(state.preview.box.to);
            return <rect className={`sk-box${state.preview.box.crossing ? " crossing" : ""}`} x={Math.min(a[0], b[0])} y={Math.min(a[1], b[1])} width={Math.abs(b[0] - a[0])} height={Math.abs(b[1] - a[1])} />;
          })()}
      </g>
    </svg>
  );
}
