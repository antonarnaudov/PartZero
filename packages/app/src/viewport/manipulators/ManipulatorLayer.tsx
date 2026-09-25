/**
 * Draws the manipulator handles (SVG over the canvas, from the camera) and turns pointer drags on
 * their grips into `ManipulatorHost` calls. Shift = fine step, Alt = no snapping, Esc = cancel
 * (the handle snaps back), Tab = type a value.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { useSyncExternalStore } from "react";
import { add, cross, dot, normalize, scale, sub, type CameraFrame, type Vec3 } from "../view-camera";
import { gripPoint, perpendicular } from "./drag-math";
import type { ManipulatorHost } from "./host";
import { handleUnit, type HandleSpec } from "./types";

/** Screen length of a handle when the tool gives no size (CSS px). */
const DEFAULT_PX = 70;

function fmt(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return String(Object.is(r, -0) ? 0 : r);
}

function handleSize(h: HandleSpec, frame: CameraFrame): number {
  return h.size ?? DEFAULT_PX * frame.pixelSizeAt(h.origin);
}

export interface ManipulatorLayerProps {
  host: ManipulatorHost;
  frame: CameraFrame;
}

export function ManipulatorLayer({ host, frame }: ManipulatorLayerProps): ReactElement | null {
  const state = useSyncExternalStore(host.subscribe, host.getState);
  const [typing, setTyping] = useState<{ id: string; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!state.active) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        host.cancelDrag();
        setTyping(null);
      } else if (e.key === "Tab" && !typing) {
        e.preventDefault();
        const id = state.active!.id;
        setTyping({ id, text: fmt(state.active!.value) });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [host, state.active, typing]);

  if (state.handles.length === 0) return null;
  const local = (e: ReactPointerEvent): { x: number; y: number } => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const P = (p: Vec3): { x: number; y: number } | null => frame.project(p);

  return (
    <svg ref={svgRef} className="vp-handles" width={frame.width} height={frame.height} data-testid="manipulators">
      {state.handles.map((h) => {
        const size = handleSize(h, frame);
        const grip = gripPoint(h, size);
        const o = P(h.origin);
        const g = P(grip);
        if (!o || !g) return null;
        const active = state.active?.id === h.id;
        const hover = state.hover === h.id;
        const cls = `vp-handle ${h.kind}${active ? " active" : ""}${hover ? " hover" : ""}`;
        const gripEvents = {
          onPointerDown: (e: ReactPointerEvent<SVGElement>) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.preventDefault();
            const q = local(e);
            if (host.begin(h.id, frame, q.x, q.y)) (e.currentTarget as Element).setPointerCapture(e.pointerId);
          },
          onPointerMove: (e: ReactPointerEvent<SVGElement>) => {
            if (state.active?.id !== h.id || typing) return;
            const q = local(e);
            host.move(frame, q.x, q.y, { fine: e.shiftKey, snap: !e.altKey });
          },
          onPointerUp: (e: ReactPointerEvent<SVGElement>) => {
            if (state.active?.id !== h.id || typing) return;
            (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
            host.end();
          },
          onPointerEnter: () => host.setHover(h.id),
          onPointerLeave: () => host.setHover(null),
        };
        let body: ReactElement;
        if (h.kind === "rotate") {
          const a = normalize(h.axis);
          const r0 = h.ref ?? perpendicular(a);
          const r = normalize(sub(r0, scale(a, dot(r0, a))));
          const y = cross(a, r);
          const ring: string[] = [];
          for (let k = 0; k <= 64; k++) {
            const t = (k / 64) * Math.PI * 2;
            const q = P(add(h.origin, add(scale(r, Math.cos(t) * size), scale(y, Math.sin(t) * size))));
            if (q) ring.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
          }
          const zero = P(add(h.origin, scale(r, size)));
          body = (
            <>
              <polyline points={ring.join(" ")} className="vp-handle-ring" />
              {zero && <line x1={o.x} y1={o.y} x2={zero.x} y2={zero.y} className="vp-handle-ref" />}
              <line x1={o.x} y1={o.y} x2={g.x} y2={g.y} className="vp-handle-shaft" />
            </>
          );
        } else {
          // The arrow: from the anchor to the grip (the value), then a fixed-length arrow past the
          // grip along the projected axis, so a handle at value 0 still shows its direction.
          const ahead = P(add(grip, scale(normalize(h.axis), size * 0.6)));
          const dx = (ahead?.x ?? g.x) - g.x;
          const dy = (ahead?.y ?? g.y) - g.y;
          const len = Math.hypot(dx, dy);
          const ux = len > 1e-6 ? dx / len : 0;
          const uy = len > 1e-6 ? dy / len : -1;
          const w = h.kind === "pushPull" ? 8 : 6;
          const reach = Math.max(26, Math.min(56, len));
          const end = { x: g.x + ux * reach, y: g.y + uy * reach };
          const tip = { x: end.x + ux * 12, y: end.y + uy * 12 };
          body = (
            <>
              <line x1={o.x} y1={o.y} x2={g.x} y2={g.y} className="vp-handle-shaft" />
              {h.kind !== "radius" && (
                <>
                  <line x1={g.x} y1={g.y} x2={end.x} y2={end.y} className="vp-handle-shaft" />
                  <polygon points={`${tip.x},${tip.y} ${end.x - uy * w},${end.y + ux * w} ${end.x + uy * w},${end.y - ux * w}`} className="vp-handle-head" {...gripEvents} />
                </>
              )}
            </>
          );
        }
        const clamped = active && state.active?.clamped;
        return (
          <g key={h.id} className={cls} data-handle={h.id} data-kind={h.kind}>
            {body}
            <circle cx={g.x} cy={g.y} r={h.kind === "radius" ? 7 : 8} className="vp-handle-grip" data-testid={`handle-${h.id}`} {...gripEvents} />
            {(active || hover) && (
              <text x={g.x + 12} y={g.y - 12} className={`vp-handle-value${clamped ? " clamped" : ""}`} data-testid="handle-value">
                {h.label ? `${h.label} ` : ""}
                {fmt(h.value)} {handleUnit(h.kind)}
                {clamped ? ` — ${clamped === "max" ? "max" : "min"}${h.limitReason ? `: ${h.limitReason}` : ""}` : ""}
              </text>
            )}
            {typing?.id === h.id && (
              <foreignObject x={g.x + 10} y={g.y + 6} width={96} height={28}>
                <input
                  className="vp-handle-input"
                  data-testid="handle-input"
                  autoFocus
                  value={typing.text}
                  onChange={(e) => setTyping({ id: h.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      const v = Number(typing.text);
                      if (Number.isFinite(v)) host.typeValue(v);
                      host.end();
                      setTyping(null);
                    } else if (e.key === "Escape") {
                      host.cancelDrag();
                      setTyping(null);
                    }
                  }}
                />
              </foreignObject>
            )}
          </g>
        );
      })}
    </svg>
  );
}
