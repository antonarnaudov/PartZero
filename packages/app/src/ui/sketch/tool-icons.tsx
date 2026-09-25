/** 16 px line icons for the sketch palette (stroke = currentColor). */
import type { ReactElement } from "react";
import type { ToolId } from "../../tools/sketch";

const P = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const;
const dot = (x: number, y: number): ReactElement => <circle cx={x} cy={y} r={1.3} fill="currentColor" stroke="none" />;

const ICONS: Record<ToolId, ReactElement> = {
  select: <path {...P} d="M4 2.5 L4 12.5 L6.8 9.8 L8.7 13.8 L10.2 13.1 L8.3 9.2 L12 9.2 Z" />,
  line: (
    <g>
      <path {...P} d="M3 13 L13 3" />
      {dot(3, 13)}
      {dot(13, 3)}
    </g>
  ),
  rect2: (
    <g>
      <rect {...P} x={2.5} y={4} width={11} height={8} />
      {dot(2.5, 12)}
      {dot(13.5, 4)}
    </g>
  ),
  rectCenter: (
    <g>
      <rect {...P} x={2.5} y={4} width={11} height={8} />
      {dot(8, 8)}
      <path {...P} strokeDasharray="1.5 1.5" d="M8 8 L13.5 4" />
    </g>
  ),
  circleCenter: (
    <g>
      <circle {...P} cx={8} cy={8} r={5.5} />
      {dot(8, 8)}
    </g>
  ),
  circle2: (
    <g>
      <circle {...P} cx={8} cy={8} r={5.5} />
      <path {...P} strokeDasharray="1.5 1.5" d="M2.5 8 L13.5 8" />
      {dot(2.5, 8)}
      {dot(13.5, 8)}
    </g>
  ),
  circle3: (
    <g>
      <circle {...P} cx={8} cy={8} r={5.5} />
      {dot(2.5, 8)}
      {dot(8, 2.5)}
      {dot(13.1, 10)}
    </g>
  ),
  arc3: (
    <g>
      <path {...P} d="M2.5 12 A6 6 0 0 1 13.5 12" />
      {dot(2.5, 12)}
      {dot(8, 5.2)}
      {dot(13.5, 12)}
    </g>
  ),
  arcTangent: (
    <g>
      <path {...P} d="M1.5 12.5 L7 12.5 A4.5 4.5 0 0 0 11.5 8 L11.5 3" />
      {dot(7, 12.5)}
    </g>
  ),
  arcCenter: (
    <g>
      <path {...P} d="M13 8 A5 5 0 0 0 8 3" />
      <path {...P} strokeDasharray="1.5 1.5" d="M8 8 L13 8 M8 8 L8 3" />
      {dot(8, 8)}
    </g>
  ),
  slot: <path {...P} d="M5 5 L11 5 A3 3 0 0 1 11 11 L5 11 A3 3 0 0 1 5 5 Z" />,
  polygon: <path {...P} d="M8 2.5 L12.8 5.25 L12.8 10.75 L8 13.5 L3.2 10.75 L3.2 5.25 Z" />,
  point: (
    <g>
      <circle cx={8} cy={8} r={2} fill="currentColor" />
      <path {...P} strokeWidth={1} d="M8 3 L8 5 M8 11 L8 13 M3 8 L5 8 M11 8 L13 8" />
    </g>
  ),
  dimension: (
    <g>
      <path {...P} d="M2.5 4 L2.5 12 M13.5 4 L13.5 12 M3 8 L13 8" />
      <path {...P} d="M5 6.3 L3 8 L5 9.7 M11 6.3 L13 8 L11 9.7" />
    </g>
  ),
  trim: (
    <g>
      <path {...P} d="M2.5 8 L7 8" />
      <path {...P} strokeDasharray="1.3 1.6" d="M9 8 L13.5 8" />
      <path {...P} d="M8 2.5 L8 13.5" />
    </g>
  ),
  extend: (
    <g>
      <path {...P} d="M2.5 8 L8 8" />
      <path {...P} strokeDasharray="1.3 1.6" d="M8 8 L12 8" />
      <path {...P} d="M13 2.5 L13 13.5" />
    </g>
  ),
  offset: (
    <g>
      <path {...P} d="M3 12 L3 5 A2 2 0 0 1 5 3 L12 3" />
      <path {...P} strokeDasharray="1.5 1.5" d="M6 13 L6 8 A2 2 0 0 1 8 6 L13 6" />
    </g>
  ),
  mirror: (
    <g>
      <path {...P} strokeDasharray="1.5 1.5" d="M8 2 L8 14" />
      <path {...P} d="M6 4 L2.5 11 L6 11 Z M10 4 L13.5 11 L10 11 Z" />
    </g>
  ),
  fillet: <path {...P} d="M3 3 L3 8 A5 5 0 0 0 8 13 L13 13" />,
  chamfer: <path {...P} d="M3 3 L3 9 L7 13 L13 13" />,
};

export function ToolIcon({ id }: { id: ToolId }): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {ICONS[id]}
    </svg>
  );
}

export function ConstructionIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path {...P} strokeDasharray="2 2" d="M2.5 13.5 L13.5 2.5" />
    </svg>
  );
}

export function GridIcon(): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path {...P} strokeWidth={1} d="M2.5 5.5 L13.5 5.5 M2.5 10.5 L13.5 10.5 M5.5 2.5 L5.5 13.5 M10.5 2.5 L10.5 13.5" />
      {dot(10.5, 10.5)}
    </svg>
  );
}
