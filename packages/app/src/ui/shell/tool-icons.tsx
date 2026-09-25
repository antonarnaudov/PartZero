/**
 * Tool icons, by name (`ToolDefinition.icon`). Same grid as `ui/icons.tsx`: 16 px, 1.5 px strokes,
 * `currentColor`. A name that is not here renders {@link GENERIC}, so a tool never breaks the
 * toolbar; add an icon here (one entry) when a tool needs a new glyph.
 */
import type { ReactElement, ReactNode, SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P & { children: ReactNode }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

const faint = { opacity: 0.5 };

const ICONS: Record<string, (p: P) => ReactElement> = {
  // ─── Sketch ────────────────────────────────────────────────────────────────────────────
  sketch: (p) => (
    <Svg {...p}>
      <path d="M2 13.5h12" {...faint} />
      <path d="M3.5 11 10.8 3.7a1.4 1.4 0 0 1 2 2L5.5 13H3.5z" />
    </Svg>
  ),
  line: (p) => (
    <Svg {...p}>
      <path d="M3.5 12.5 12.5 3.5" />
      <circle cx={3.5} cy={12.5} r={1.3} fill="currentColor" stroke="none" />
      <circle cx={12.5} cy={3.5} r={1.3} fill="currentColor" stroke="none" />
    </Svg>
  ),
  rectangle: (p) => (
    <Svg {...p}>
      <rect x={2.5} y={4} width={11} height={8} rx={0.5} />
    </Svg>
  ),
  circle: (p) => (
    <Svg {...p}>
      <circle cx={8} cy={8} r={5.5} />
      <circle cx={8} cy={8} r={0.9} fill="currentColor" stroke="none" />
    </Svg>
  ),
  arc: (p) => (
    <Svg {...p}>
      <path d="M2.5 12.5A7.5 7.5 0 0 1 12.5 3" />
      <circle cx={2.5} cy={12.5} r={1.2} fill="currentColor" stroke="none" />
      <circle cx={12.5} cy={3} r={1.2} fill="currentColor" stroke="none" />
    </Svg>
  ),
  slot: (p) => (
    <Svg {...p}>
      <rect x={1.8} y={5} width={12.4} height={6} rx={3} />
    </Svg>
  ),
  polygon: (p) => (
    <Svg {...p}>
      <path d="M8 2.2 13.2 5.2v5.6L8 13.8 2.8 10.8V5.2z" />
    </Svg>
  ),
  point: (p) => (
    <Svg {...p}>
      <path d="M8 3v3M8 10v3M3 8h3M10 8h3" {...faint} />
      <circle cx={8} cy={8} r={1.6} fill="currentColor" stroke="none" />
    </Svg>
  ),
  construction: (p) => (
    <Svg {...p}>
      <path d="M2.5 13.5 13.5 2.5" strokeDasharray="2 2" />
    </Svg>
  ),
  dimension: (p) => (
    <Svg {...p}>
      <path d="M2.5 4v5M13.5 4v5" {...faint} />
      <path d="M2.5 6.5h11M4.5 4.8 2.5 6.5l2 1.7M11.5 4.8l2 1.7-2 1.7" />
      <path d="M5 12.5h6" {...faint} />
    </Svg>
  ),
  constraint: (p) => (
    <Svg {...p}>
      <path d="M5.5 10.5 3.8 12.2a2 2 0 0 1-2.8-2.8l2.6-2.6a2 2 0 0 1 2.8 0" />
      <path d="M10.5 5.5l1.7-1.7a2 2 0 0 1 2.8 2.8l-2.6 2.6a2 2 0 0 1-2.8 0" />
      <path d="M6 10 10 6" />
    </Svg>
  ),
  trim: (p) => (
    <Svg {...p}>
      <path d="M2 8h5" />
      <path d="M9 8h5" strokeDasharray="1.5 1.5" {...faint} />
      <path d="M8 2.5v11" />
    </Svg>
  ),
  offset: (p) => (
    <Svg {...p}>
      <path d="M3 12V6.5a3.5 3.5 0 0 1 3.5-3.5H13" />
      <path d="M6 12V8a2 2 0 0 1 2-2h5" {...faint} />
    </Svg>
  ),
  finishSketch: (p) => (
    <Svg {...p}>
      <path d="M2 13.5h7" {...faint} />
      <path d="m8.5 9 2.5 2.5 4-5" />
      <path d="M2.8 10.5 8.5 4.8a1.2 1.2 0 0 1 1.7 1.7L5 11.7H3.2z" />
    </Svg>
  ),
  // ─── Create ────────────────────────────────────────────────────────────────────────────
  extrude: (p) => (
    <Svg {...p}>
      <path d="M3 10.5 8 13l5-2.5" {...faint} />
      <path d="M3 6 8 8.5 13 6 8 3.5z" />
      <path d="M3 6v4.5M13 6v4.5M8 8.5V13" />
    </Svg>
  ),
  revolve: (p) => (
    <Svg {...p}>
      <path d="M8 2v12" strokeDasharray="1.5 1.8" opacity={0.6} />
      <path d="M12.8 6.2A5 2.2 0 1 1 8 5.8" />
      <path d="m11 4.6 1.9 1.6-2.1 1" />
    </Svg>
  ),
  hole: (p) => (
    <Svg {...p}>
      <path d="M1.8 6.2 8 3l6.2 3.2L8 9.4z" />
      <ellipse cx={8} cy={6.2} rx={2.2} ry={1.1} />
      <path d="M5.8 6.2v5.3M10.2 6.2v5.3" {...faint} />
      <path d="M5.8 11.5a2.2 1.1 0 0 0 4.4 0" {...faint} />
    </Svg>
  ),
  box: (p) => (
    <Svg {...p}>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </Svg>
  ),
  cylinder: (p) => (
    <Svg {...p}>
      <ellipse cx={8} cy={4} rx={5} ry={2} />
      <path d="M3 4v8a5 2 0 0 0 10 0V4" />
    </Svg>
  ),
  // ─── Modify ────────────────────────────────────────────────────────────────────────────
  fillet: (p) => (
    <Svg {...p}>
      <path d="M2.5 13.5V8a5.5 5.5 0 0 1 5.5-5.5h5.5" />
      <path d="M2.5 2.5v4M2.5 2.5h4" strokeDasharray="1.4 1.6" {...faint} />
    </Svg>
  ),
  chamfer: (p) => (
    <Svg {...p}>
      <path d="M2.5 13.5V7.5l5-5h6" />
      <path d="M2.5 2.5v5M2.5 2.5h5" strokeDasharray="1.4 1.6" {...faint} />
    </Svg>
  ),
  shell: (p) => (
    <Svg {...p}>
      <path d="M2.5 4.5v8h11v-8" />
      <path d="M4.8 4.5v5.7h6.4V4.5" {...faint} />
      <path d="M2.5 4.5h2.3M11.2 4.5h2.3" />
    </Svg>
  ),
  draft: (p) => (
    <Svg {...p}>
      <path d="M3 13.5 5 3h6l2 10.5z" />
      <path d="M5 3 3 13.5" strokeDasharray="1.4 1.6" {...faint} />
    </Svg>
  ),
  combine: (p) => (
    <Svg {...p}>
      <rect x={2} y={2} width={8} height={8} rx={1} />
      <rect x={6} y={6} width={8} height={8} rx={1} {...faint} />
    </Svg>
  ),
  subtract: (p) => (
    <Svg {...p}>
      <path d="M2 2h8v4H7a1 1 0 0 0-1 1v3H2z" />
      <rect x={6} y={6} width={8} height={8} rx={1} strokeDasharray="1.5 1.5" {...faint} />
    </Svg>
  ),
  intersect: (p) => (
    <Svg {...p}>
      <rect x={2} y={2} width={8} height={8} rx={1} {...faint} />
      <rect x={6} y={6} width={8} height={8} rx={1} {...faint} />
      <rect x={6} y={6} width={4} height={4} fill="currentColor" stroke="none" />
    </Svg>
  ),
  pushPull: (p) => (
    <Svg {...p}>
      <path d="M3 9 8 11.5 13 9 8 6.5z" />
      <path d="M8 6.5V1.8M6.2 3.6 8 1.8l1.8 1.8" />
      <path d="M3 9v2.5L8 14l5-2.5V9" {...faint} />
    </Svg>
  ),
  move: (p) => (
    <Svg {...p}>
      <path d="M8 1.8v12.4M1.8 8h12.4" />
      <path d="M6.3 3.5 8 1.8l1.7 1.7M6.3 12.5 8 14.2l1.7-1.7M3.5 6.3 1.8 8l1.7 1.7M12.5 6.3 14.2 8l-1.7 1.7" />
    </Svg>
  ),
  split: (p) => (
    <Svg {...p}>
      <path d="M2.5 6 8 3.2 13.5 6v4.5L8 13.3 2.5 10.5z" {...faint} />
      <path d="M1.5 8.5 14.5 7" />
    </Svg>
  ),
  // ─── Pattern ───────────────────────────────────────────────────────────────────────────
  linearPattern: (p) => (
    <Svg {...p}>
      <rect x={1.8} y={5.5} width={3.4} height={5} rx={0.6} />
      <rect x={6.3} y={5.5} width={3.4} height={5} rx={0.6} {...faint} />
      <rect x={10.8} y={5.5} width={3.4} height={5} rx={0.6} {...faint} />
    </Svg>
  ),
  circularPattern: (p) => (
    <Svg {...p}>
      <circle cx={8} cy={8} r={5.2} strokeDasharray="1.4 1.8" {...faint} />
      <circle cx={8} cy={2.8} r={1.4} fill="currentColor" stroke="none" />
      <circle cx={12.5} cy={10.6} r={1.4} {...faint} />
      <circle cx={3.5} cy={10.6} r={1.4} {...faint} />
    </Svg>
  ),
  mirror: (p) => (
    <Svg {...p}>
      <path d="M8 1.8v12.4" strokeDasharray="1.5 1.5" />
      <path d="M6 4 2.5 12H6z" />
      <path d="M10 4l3.5 8H10z" {...faint} />
    </Svg>
  ),
  // ─── Construct ─────────────────────────────────────────────────────────────────────────
  plane: (p) => (
    <Svg {...p}>
      <path d="M1.8 10.5 5 4.5h9.2L11 10.5z" />
    </Svg>
  ),
  offsetPlane: (p) => (
    <Svg {...p}>
      <path d="M1.8 12.5 4.5 8h9.7l-2.7 4.5z" {...faint} />
      <path d="M1.8 7.5 4.5 3h9.7l-2.7 4.5z" />
    </Svg>
  ),
  axis: (p) => (
    <Svg {...p}>
      <path d="M3 13 13 3" />
      <path d="M1.8 11.5 6 7.2" {...faint} />
      <circle cx={8} cy={8} r={1.3} fill="currentColor" stroke="none" />
    </Svg>
  ),
  // ─── Inspect ───────────────────────────────────────────────────────────────────────────
  measure: (p) => (
    <Svg {...p}>
      <path d="M1.8 10.2 10.2 1.8l4 4-8.4 8.4z" />
      <path d="M5 7l1.3 1.3M7 5l1.3 1.3M9 3l1.3 1.3" />
    </Svg>
  ),
  properties: (p) => (
    <Svg {...p}>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5z" {...faint} />
      <path d="M5.5 7.2h5M5.5 9.6h3.5" />
    </Svg>
  ),
  bedFit: (p) => (
    <Svg {...p}>
      <path d="M1.8 12.5h12.4" />
      <path d="M2.5 14.2v-1.7M13.5 14.2v-1.7" {...faint} />
      <rect x={5} y={5.5} width={6} height={7} rx={0.6} />
      <path d="M3 3h10" strokeDasharray="1.4 1.6" {...faint} />
    </Svg>
  ),
  section: (p) => (
    <Svg {...p}>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5z" {...faint} />
      <path d="M2 9.5 14 6.5" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M8 1.8 13.5 4v4.2c0 3-2.4 5-5.5 6-3.1-1-5.5-3-5.5-6V4z" />
      <path d="m5.5 8 1.8 1.8 3.3-3.6" />
    </Svg>
  ),
};

const GENERIC = (p: P): ReactElement => (
  <Svg {...p}>
    <rect x={2.5} y={2.5} width={11} height={11} rx={2.5} />
    <path d="M5.5 8h5M8 5.5v5" {...faint} />
  </Svg>
);

/** The names the toolbar knows (tests and the tool registry's docs list them). */
export const TOOL_ICON_NAMES: readonly string[] = Object.keys(ICONS);

export function ToolIcon({ name, size = 16 }: { name: string | null | undefined; size?: number }): ReactElement {
  const C = (name && ICONS[name]) || GENERIC;
  return <C size={size} />;
}
