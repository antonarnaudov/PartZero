/**
 * The viewport's SVG overlay, drawn from the camera (the plan's DOM/SVG overlay): origin planes,
 * axes and point (selectable), vertex markers for the selected and hovered vertices, measurement
 * dimension lines, and the box-select rectangle. Handles live in `ManipulatorLayer`.
 */
import type { ReactElement } from "react";
import type { Measurement } from "../measure/measure";
import { formatMeasurement } from "../measure/measure";
import type { Rect } from "../selection/box-select";
import { itemId, type OriginId, type SelectionItem } from "../selection/types";
import type { CameraFrame, Vec3 } from "./view-camera";

export interface OverlayProps {
  frame: CameraFrame;
  /** Show the origin planes/axes/point. */
  origin: boolean;
  /** Half-size of the origin planes (mm). */
  originSize: number;
  items: readonly SelectionItem[];
  hover: SelectionItem | null;
  measurements: readonly Measurement[];
  box: (Rect & { mode: "window" | "crossing" }) | null;
  onOriginClick: (id: OriginId, additive: boolean) => void;
  onOriginHover: (id: OriginId | null) => void;
}

const PLANES: Array<{ id: OriginId; u: Vec3; v: Vec3; cls: string }> = [
  { id: "XY", u: [1, 0, 0], v: [0, 1, 0], cls: "xy" },
  { id: "XZ", u: [1, 0, 0], v: [0, 0, 1], cls: "xz" },
  { id: "YZ", u: [0, 1, 0], v: [0, 0, 1], cls: "yz" },
];

const AXES: Array<{ id: OriginId; d: Vec3; cls: string }> = [
  { id: "X", d: [1, 0, 0], cls: "x" },
  { id: "Y", d: [0, 1, 0], cls: "y" },
  { id: "Z", d: [0, 0, 1], cls: "z" },
];

function isOrigin(it: SelectionItem | null, id: OriginId): boolean {
  return !!it && it.kind === "origin" && it.id === id;
}

export function Overlay(p: OverlayProps): ReactElement {
  const f = p.frame;
  const pts = (ps: Vec3[]): string | null => {
    const out: string[] = [];
    for (const q of ps) {
      const s = f.project(q);
      if (!s) return null;
      out.push(`${s.x.toFixed(1)},${s.y.toFixed(1)}`);
    }
    return out.join(" ");
  };
  const R = p.originSize;
  const vertexMarks: Array<{ key: string; x: number; y: number; state: "selected" | "hover" }> = [];
  for (const it of p.items) {
    if (it.kind !== "vertex" || !it.point) continue;
    const s = f.project(it.point);
    if (s) vertexMarks.push({ key: itemId(it), x: s.x, y: s.y, state: "selected" });
  }
  if (p.hover?.kind === "vertex" && p.hover.point) {
    const s = f.project(p.hover.point);
    if (s) vertexMarks.push({ key: `h:${itemId(p.hover)}`, x: s.x, y: s.y, state: "hover" });
  }
  const origin = f.project([0, 0, 0]);
  return (
    <svg className="vp-overlay" width={f.width} height={f.height} data-testid="viewport-overlay">
      {p.origin && (
        <g className="vp-origin" data-testid="origin-display">
          {PLANES.map((pl) => {
            const corners: Vec3[] = [
              [-R * pl.u[0] - R * pl.v[0], -R * pl.u[1] - R * pl.v[1], -R * pl.u[2] - R * pl.v[2]],
              [R * pl.u[0] - R * pl.v[0], R * pl.u[1] - R * pl.v[1], R * pl.u[2] - R * pl.v[2]],
              [R * pl.u[0] + R * pl.v[0], R * pl.u[1] + R * pl.v[1], R * pl.u[2] + R * pl.v[2]],
              [-R * pl.u[0] + R * pl.v[0], -R * pl.u[1] + R * pl.v[1], -R * pl.u[2] + R * pl.v[2]],
            ];
            const poly = pts(corners);
            const label = f.project(corners[2]!);
            if (!poly) return null;
            const sel = p.items.some((it) => isOrigin(it, pl.id));
            const hov = isOrigin(p.hover, pl.id);
            return (
              <g key={pl.id}>
                <polygon points={poly} className={`vp-plane ${pl.cls}${sel ? " selected" : ""}${hov ? " hover" : ""}`} />
                {label && (
                  <text
                    x={label.x}
                    y={label.y}
                    className={`vp-origin-label${sel ? " selected" : ""}`}
                    data-origin={pl.id}
                    onPointerEnter={() => p.onOriginHover(pl.id)}
                    onPointerLeave={() => p.onOriginHover(null)}
                    onClick={(e) => p.onOriginClick(pl.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                  >
                    {pl.id}
                  </text>
                )}
              </g>
            );
          })}
          {AXES.map((ax) => {
            const a = f.project([0, 0, 0]);
            const b = f.project([ax.d[0] * R * 1.25, ax.d[1] * R * 1.25, ax.d[2] * R * 1.25]);
            if (!a || !b) return null;
            const sel = p.items.some((it) => isOrigin(it, ax.id));
            return (
              <g key={ax.id}>
                <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`vp-axis ${ax.cls}${sel ? " selected" : ""}`} />
                <line
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  className="vp-axis-hit"
                  data-origin={ax.id}
                  onPointerEnter={() => p.onOriginHover(ax.id)}
                  onPointerLeave={() => p.onOriginHover(null)}
                  onClick={(e) => p.onOriginClick(ax.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                />
                <text x={b.x} y={b.y} className={`vp-axis-label ${ax.cls}`}>
                  {ax.id}
                </text>
              </g>
            );
          })}
          {origin && (
            <circle
              cx={origin.x}
              cy={origin.y}
              r={4}
              className={`vp-origin-point${p.items.some((it) => isOrigin(it, "O")) ? " selected" : ""}`}
              data-origin="O"
              onPointerEnter={() => p.onOriginHover("O")}
              onPointerLeave={() => p.onOriginHover(null)}
              onClick={(e) => p.onOriginClick("O", e.shiftKey || e.metaKey || e.ctrlKey)}
            />
          )}
        </g>
      )}
      {p.measurements.map((m) => {
        if (!m.from || !m.to) return null;
        const a = f.project(m.from);
        const b = f.project(m.to);
        if (!a || !b) return null;
        return (
          <g key={m.id} className="vp-dim" data-testid="measure-dimension">
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <circle cx={a.x} cy={a.y} r={2.5} />
            <circle cx={b.x} cy={b.y} r={2.5} />
            <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6}>
              {formatMeasurement(m)}
            </text>
          </g>
        );
      })}
      {vertexMarks.map((v) => (
        <circle key={v.key} cx={v.x} cy={v.y} r={v.state === "hover" ? 5 : 4.5} className={`vp-vertex ${v.state}`} data-testid={v.state === "hover" ? "vertex-hover" : "vertex-selected"} />
      ))}
      {p.box && (
        <rect
          x={Math.min(p.box.x0, p.box.x1)}
          y={Math.min(p.box.y0, p.box.y1)}
          width={Math.abs(p.box.x1 - p.box.x0)}
          height={Math.abs(p.box.y1 - p.box.y0)}
          className={`vp-box ${p.box.mode}`}
          data-testid="box-select"
        />
      )}
    </svg>
  );
}
