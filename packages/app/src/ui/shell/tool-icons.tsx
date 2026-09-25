/**
 * PartZero's tool icons (our own set, drawn for this app), by name (`ToolDefinition.icon`).
 *
 * - **Grid.** 20 × 20 view box, drawn at 16–24 px. Strokes are `currentColor`, 1.5 px on screen at
 *   every size (`vector-effect: non-scaling-stroke`, see `.pz-icon` in `styles/design.css`), so they
 *   stay crisp in the ribbon (22 px), menus (16 px) and the timeline (15 px).
 * - **Two tones.** What the tool makes or changes is in the accent (`.a` stroke, `.af` translucent
 *   fill), the context is faint (`.f`); both are themed tokens (`--icon-accent`, `--icon-fill`).
 * - **Coverage.** Every tool the op catalogue has a UI for, the sketcher's tools and constraints,
 *   and the browser's entities. A name that is not here renders {@link GENERIC}, so a tool never
 *   breaks the toolbar; add an icon here (one entry) when a tool needs a new glyph.
 */
import type { ReactElement, ReactNode } from "react";

type P = { size?: number };

function Svg({ size = 16, children }: P & { children: ReactNode }): ReactElement {
  return (
    <svg
      className="pz-icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A filled dot (end points, centres). */
const Dot = ({ x, y, r = 1.5, a = false }: { x: number; y: number; r?: number; a?: boolean }): ReactElement => (
  <circle cx={x} cy={y} r={r} className={a ? "dot a" : "dot"} />
);

/** An isometric block: top, left and right faces (the top can be accent). */
function Block({ top = "", left = "", right = "" }: { top?: string; left?: string; right?: string }): ReactElement {
  return (
    <>
      <path className={left} d="M3.5 6.75v6.5L10 16.5V10z" />
      <path className={right} d="M16.5 6.75v6.5L10 16.5V10z" />
      <path className={top} d="M10 3.5l6.5 3.25L10 10 3.5 6.75z" />
    </>
  );
}

const ICONS: Record<string, (p: P) => ReactElement> = {
  // ─── Sketch: create ──────────────────────────────────────────────────────────────────────
  sketch: (p) => (
    <Svg {...p}>
      <path className="af" d="M2.5 16l3.8-4.5h11.2L13.7 16z" />
      <path d="M7.8 14.3l.9-2.7 6.6-6.6a1.5 1.5 0 0 1 2.1 2.1l-6.6 6.6z" />
      <path className="f" d="M13.9 6.4l2.1 2.1" />
    </Svg>
  ),
  select: (p) => (
    <Svg {...p}>
      <path d="M5 3.5v12l3.3-3.2 2.4 4.9 2-1-2.4-4.8H15z" />
    </Svg>
  ),
  line: (p) => (
    <Svg {...p}>
      <path className="a" d="M4.5 15.5l11-11" />
      <Dot x={4.5} y={15.5} />
      <Dot x={15.5} y={4.5} />
    </Svg>
  ),
  rectangle: (p) => (
    <Svg {...p}>
      <rect className="a" x={3.5} y={5.5} width={13} height={9} rx={0.5} />
      <Dot x={3.5} y={14.5} />
      <Dot x={16.5} y={5.5} />
    </Svg>
  ),
  rectCenter: (p) => (
    <Svg {...p}>
      <rect className="a" x={3.5} y={5.5} width={13} height={9} rx={0.5} />
      <path className="f" d="M10 10l6.5-4.5" strokeDasharray="1.6 1.8" />
      <Dot x={10} y={10} />
    </Svg>
  ),
  circle: (p) => (
    <Svg {...p}>
      <circle className="a" cx={10} cy={10} r={6.5} />
      <Dot x={10} y={10} r={1.3} />
    </Svg>
  ),
  circle2: (p) => (
    <Svg {...p}>
      <circle className="a" cx={10} cy={10} r={6.5} />
      <path className="f" d="M3.5 10h13" strokeDasharray="1.6 1.8" />
      <Dot x={3.5} y={10} />
      <Dot x={16.5} y={10} />
    </Svg>
  ),
  circle3: (p) => (
    <Svg {...p}>
      <circle className="a" cx={10} cy={10} r={6.5} />
      <Dot x={10} y={3.5} />
      <Dot x={4.4} y={13.3} />
      <Dot x={15.6} y={13.3} />
    </Svg>
  ),
  arc: (p) => (
    <Svg {...p}>
      <path className="a" d="M3.5 15A7.5 7.5 0 0 1 16.5 15" />
      <Dot x={3.5} y={15} />
      <Dot x={10} y={7.6} />
      <Dot x={16.5} y={15} />
    </Svg>
  ),
  arcTangent: (p) => (
    <Svg {...p}>
      <path className="f" d="M2.5 15.5H9" />
      <path className="a" d="M9 15.5a6.5 6.5 0 0 0 6.5-6.5" />
      <Dot x={9} y={15.5} />
      <Dot x={15.5} y={9} />
    </Svg>
  ),
  arcCenter: (p) => (
    <Svg {...p}>
      <path className="f" d="M6 14h9M6 14V5" strokeDasharray="1.6 1.8" />
      <path className="a" d="M15 14a9 9 0 0 0-9-9" />
      <Dot x={6} y={14} />
    </Svg>
  ),
  slot: (p) => (
    <Svg {...p}>
      <path className="a" d="M6.5 6.5h7a3.5 3.5 0 0 1 0 7h-7a3.5 3.5 0 0 1 0-7z" />
      <path className="f" d="M6.5 10h7" strokeDasharray="1.6 1.8" />
      <Dot x={6.5} y={10} r={1.2} />
      <Dot x={13.5} y={10} r={1.2} />
    </Svg>
  ),
  polygon: (p) => (
    <Svg {...p}>
      <path className="a" d="M10 3l6.1 3.5v7L10 17l-6.1-3.5v-7z" />
      <Dot x={10} y={10} r={1.2} />
    </Svg>
  ),
  point: (p) => (
    <Svg {...p}>
      <path className="f" d="M10 3.5v3M10 13.5v3M3.5 10h3M13.5 10h3" />
      <Dot x={10} y={10} r={2} a />
    </Svg>
  ),
  construction: (p) => (
    <Svg {...p}>
      <path className="a" d="M3.5 16.5l13-13" strokeDasharray="2.2 2.2" />
      <Dot x={3.5} y={16.5} />
      <Dot x={16.5} y={3.5} />
    </Svg>
  ),
  gridSnap: (p) => (
    <Svg {...p}>
      <path className="f" d="M3 7.5h14M3 12.5h14M7.5 3v14M12.5 3v14" />
      <Dot x={12.5} y={7.5} r={2} a />
    </Svg>
  ),
  dimension: (p) => (
    <Svg {...p}>
      <path className="f" d="M3.5 5v9M16.5 5v9" />
      <path className="a" d="M3.5 9.5h13M6 7.5l-2.5 2 2.5 2M14 7.5l2.5 2-2.5 2" />
      <path className="f" d="M7.5 14.5h5" />
    </Svg>
  ),
  constraint: (p) => (
    <Svg {...p}>
      <path d="M4.5 3.5v12h12" />
      <path className="a" d="M4.5 12h3.5v3.5" />
    </Svg>
  ),
  // ─── Sketch: modify ──────────────────────────────────────────────────────────────────────
  trim: (p) => (
    <Svg {...p}>
      <circle cx={6} cy={14.5} r={2.3} />
      <circle cx={14} cy={14.5} r={2.3} />
      <path className="a" d="M7.6 12.8L14.5 3.5M12.4 12.8L5.5 3.5" />
    </Svg>
  ),
  extend: (p) => (
    <Svg {...p}>
      <path d="M3 10h8.5" />
      <path className="a" d="M11.5 10h3M12.5 7.5L15 10l-2.5 2.5" />
      <path className="f" d="M17 3.5v13" />
    </Svg>
  ),
  offset: (p) => (
    <Svg {...p}>
      <path d="M3.5 16.5V10a5.5 5.5 0 0 1 5.5-5.5h7.5" />
      <path className="a" d="M7 16.5V10A2 2 0 0 1 9 8h7.5" />
    </Svg>
  ),
  mirror: (p) => (
    <Svg {...p}>
      <path className="f" d="M10 2.5v15" strokeDasharray="1.6 1.8" />
      <path d="M8 5L3 14.5h5z" />
      <path className="a af" d="M12 5l5 9.5h-5z" />
    </Svg>
  ),
  sketchFillet: (p) => (
    <Svg {...p}>
      <path d="M4 3.5v6M10.5 16H16.5" />
      <path className="a" d="M4 9.5A6.5 6.5 0 0 0 10.5 16" />
    </Svg>
  ),
  sketchChamfer: (p) => (
    <Svg {...p}>
      <path d="M4 3.5V11M9 16h7.5" />
      <path className="a" d="M4 11l5 5" />
    </Svg>
  ),
  finishSketch: (p) => (
    <Svg {...p}>
      <rect className="f" x={3} y={3.5} width={14} height={13} rx={2.5} />
      <path className="a" d="M6.5 10.2l2.4 2.4 4.6-5" />
    </Svg>
  ),
  // ─── Sketch: constraints ─────────────────────────────────────────────────────────────────
  "c-coincident": (p) => (
    <Svg {...p}>
      <path d="M3.5 15.5L10 10M10 10l6.5 3" />
      <Dot x={10} y={10} r={2.1} a />
    </Svg>
  ),
  "c-horizontal": (p) => (
    <Svg {...p}>
      <path className="a" d="M3.5 10h13" />
      <Dot x={3.5} y={10} />
      <Dot x={16.5} y={10} />
      <path className="f" d="M6 14h8" />
    </Svg>
  ),
  "c-vertical": (p) => (
    <Svg {...p}>
      <path className="a" d="M10 3.5v13" />
      <Dot x={10} y={3.5} />
      <Dot x={10} y={16.5} />
      <path className="f" d="M14 6v8" />
    </Svg>
  ),
  "c-parallel": (p) => (
    <Svg {...p}>
      <path d="M3.5 12.5l7-9" />
      <path className="a" d="M9.5 16.5l7-9" />
    </Svg>
  ),
  "c-perpendicular": (p) => (
    <Svg {...p}>
      <path d="M3.5 16h13" />
      <path className="a" d="M10 16V3.5" />
      <path className="f" d="M10 12.5h3.5V16" />
    </Svg>
  ),
  "c-tangent": (p) => (
    <Svg {...p}>
      <circle cx={10} cy={11} r={5.5} />
      <path className="a" d="M2.5 5.5h15" />
      <Dot x={10} y={5.5} a />
    </Svg>
  ),
  "c-equal": (p) => (
    <Svg {...p}>
      <path className="a" d="M4.5 7.5h11M4.5 12.5h11" />
    </Svg>
  ),
  "c-concentric": (p) => (
    <Svg {...p}>
      <circle cx={10} cy={10} r={6.5} />
      <circle className="a" cx={10} cy={10} r={3.2} />
      <Dot x={10} y={10} r={1} />
    </Svg>
  ),
  "c-midpoint": (p) => (
    <Svg {...p}>
      <path d="M3.5 15.5l13-11" />
      <path className="a af" d="M10 6.8l2.6 4.6H7.4z" />
    </Svg>
  ),
  "c-symmetric": (p) => (
    <Svg {...p}>
      <path className="f" d="M10 2.5v15" strokeDasharray="1.6 1.8" />
      <Dot x={4.5} y={10} r={1.8} a />
      <Dot x={15.5} y={10} r={1.8} a />
      <path className="f" d="M6.8 10h1.2M12 10h1.2" />
    </Svg>
  ),
  "c-fix": (p) => (
    <Svg {...p}>
      <rect x={4.5} y={9} width={11} height={8} rx={1.5} />
      <path className="a" d="M7 9V6.5a3 3 0 0 1 6 0V9" />
      <Dot x={10} y={13} r={1.1} />
    </Svg>
  ),
  "c-onCurve": (p) => (
    <Svg {...p}>
      <path d="M3 15a9 9 0 0 1 14-7" />
      <Dot x={10.4} y={8.6} r={2.1} a />
    </Svg>
  ),
  // ─── Solid: create ───────────────────────────────────────────────────────────────────────
  extrude: (p) => (
    <Svg {...p}>
      <path className="af" stroke="none" d="M2.5 13l6 3 6-3-6-3z" />
      <path d="M2.5 6.5v6.5l6 3 6-3V6.5M8.5 9.5V16" />
      <path d="M8.5 3.5l6 3-6 3-6-3z" />
      <path className="a" d="M17.5 15V4.5M15.8 6.3l1.7-1.8 1.7 1.8" />
    </Svg>
  ),
  revolve: (p) => (
    <Svg {...p}>
      <path className="a" d="M4.5 2v16" strokeDasharray="1.8 1.8" />
      <path className="af" d="M4.5 4H9c1.6 1.4 1.6 3.6 0 5l2.5 6.5h-7z" />
      <path className="a" d="M13.5 3.8a6.5 6.5 0 0 1 2.3 9.4M13.5 10.9l2.3 2.3 2.4-1.9" />
    </Svg>
  ),
  hole: (p) => (
    <Svg {...p}>
      <path d="M10 3.5l7.5 3.75L10 11 2.5 7.25z" />
      <path d="M2.5 7.25v3.5L10 14.5l7.5-3.75v-3.5M10 11v3.5" />
      <ellipse className="a af" cx={10} cy={7.25} rx={2.8} ry={1.4} />
      <path className="a" d="M10 1v3.2" strokeDasharray="1.2 1.4" />
    </Svg>
  ),
  box: (p) => (
    <Svg {...p}>
      <Block />
    </Svg>
  ),
  cylinder: (p) => (
    <Svg {...p}>
      <ellipse cx={10} cy={5} rx={6} ry={2.3} />
      <path d="M4 5v10c0 1.3 2.7 2.3 6 2.3s6-1 6-2.3V5" />
    </Svg>
  ),
  sphere: (p) => (
    <Svg {...p}>
      <circle cx={10} cy={10} r={6.8} />
      <path className="f" d="M3.2 10c0 1.5 3 2.7 6.8 2.7s6.8-1.2 6.8-2.7" />
    </Svg>
  ),
  // ─── Solid: modify ───────────────────────────────────────────────────────────────────────
  fillet: (p) => (
    <Svg {...p}>
      <path className="f" d="M3 17h14V4H8.5" />
      <path d="M3 17V9.5" />
      <path className="a" d="M3 9.5A5.5 5.5 0 0 1 8.5 4" />
      <path className="af" stroke="none" d="M3 9.5A5.5 5.5 0 0 1 8.5 4H3z" />
    </Svg>
  ),
  chamfer: (p) => (
    <Svg {...p}>
      <path className="f" d="M3 17h14V4H8.5" />
      <path d="M3 17V9.5" />
      <path className="a" d="M3 9.5L8.5 4" />
      <path className="af" stroke="none" d="M3 9.5L8.5 4H3z" />
    </Svg>
  ),
  shell: (p) => (
    <Svg {...p}>
      <path d="M3.5 7v6.5L10 17l6.5-3.5V7M10 10.5V17" />
      <path d="M10 3.5L16.5 7 10 10.5 3.5 7z" />
      <path className="a af" d="M10 5.4L13.1 7 10 8.6 6.9 7z" />
    </Svg>
  ),
  draft: (p) => (
    <Svg {...p}>
      <path className="f" d="M3.5 16.5v-13" strokeDasharray="1.6 1.8" />
      <path d="M6 3.5h8l2.5 13h-13" />
      <path className="a" d="M3.5 16.5L6 3.5" />
      <path className="a" d="M3.5 11.5a5 5 0 0 1 1-.1" />
    </Svg>
  ),
  combine: (p) => (
    <Svg {...p}>
      <path className="a af" d="M3 3.5h9v4.5h5v8.5H8V12H3z" />
      <path className="f" d="M8 12V8h4" strokeDasharray="1.4 1.6" />
    </Svg>
  ),
  subtract: (p) => (
    <Svg {...p}>
      <path className="a af" d="M3 3.5h9V8H8v4H3z" />
      <path className="f" d="M8 8h9v8.5H8z" strokeDasharray="1.4 1.6" />
    </Svg>
  ),
  intersect: (p) => (
    <Svg {...p}>
      <path className="f" d="M3 3.5h9V12H3zM8 8h9v8.5H8z" />
      <path className="a af" d="M8 8h4v4H8z" />
    </Svg>
  ),
  pushPull: (p) => (
    <Svg {...p}>
      <path className="f" d="M2.5 13.5v3h11.5l3.5-3v-3" />
      <path className="a af" d="M2.5 13.5l3.5-3h11.5l-3.5 3z" />
      <path d="M10 11.8V3M7.5 5.5L10 3l2.5 2.5" />
    </Svg>
  ),
  move: (p) => (
    <Svg {...p}>
      <path d="M10 2.5v15M2.5 10h15" />
      <path className="a" d="M7.8 4.7L10 2.5l2.2 2.2M7.8 15.3l2.2 2.2 2.2-2.2M4.7 7.8L2.5 10l2.2 2.2M15.3 7.8l2.2 2.2-2.2 2.2" />
    </Svg>
  ),
  split: (p) => (
    <Svg {...p}>
      <Block top="f" left="f" right="f" />
      <path className="a af" d="M1.5 11.5l4-3.3h13l-4 3.3z" />
    </Svg>
  ),
  // ─── Pattern ─────────────────────────────────────────────────────────────────────────────
  linearPattern: (p) => (
    <Svg {...p}>
      <rect className="a af" x={2} y={6.5} width={4.5} height={7} rx={1} />
      <rect className="f" x={7.75} y={6.5} width={4.5} height={7} rx={1} />
      <rect className="f" x={13.5} y={6.5} width={4.5} height={7} rx={1} />
    </Svg>
  ),
  circularPattern: (p) => (
    <Svg {...p}>
      <circle className="f" cx={10} cy={10} r={6.5} strokeDasharray="1.4 2" />
      <circle className="a af" cx={10} cy={3.5} r={1.9} />
      <circle cx={16.2} cy={8} r={1.6} />
      <circle cx={13.8} cy={15.3} r={1.6} />
      <circle cx={6.2} cy={15.3} r={1.6} />
      <circle cx={3.8} cy={8} r={1.6} />
    </Svg>
  ),
  // ─── Construct ───────────────────────────────────────────────────────────────────────────
  plane: (p) => (
    <Svg {...p}>
      <path className="a af" d="M2 15l4.5-9H18l-4.5 9z" />
    </Svg>
  ),
  offsetPlane: (p) => (
    <Svg {...p}>
      <path className="f" d="M2 17l3-5.5h12l-3 5.5z" />
      <path className="a af" d="M2 9l3-5.5h12L14 9z" />
      <path d="M9.5 15v-4" strokeDasharray="1.3 1.5" />
    </Svg>
  ),
  axis: (p) => (
    <Svg {...p}>
      <path className="f" d="M2 15l4.5-9H18l-4.5 9z" />
      <path className="a" d="M3.5 17.5l13-15" />
      <Dot x={10} y={10} r={1.3} a />
    </Svg>
  ),
  origin: (p) => (
    <Svg {...p}>
      <path className="f" d="M10 10V3M10 10l6 3.5M10 10l-6 3.5" />
      <Dot x={10} y={10} r={2} a />
    </Svg>
  ),
  // ─── Inspect ─────────────────────────────────────────────────────────────────────────────
  measure: (p) => (
    <Svg {...p}>
      <path d="M2.5 13.2L13.2 2.5l4.3 4.3L6.8 17.5z" />
      <path className="a" d="M6.2 9.5l1.6 1.6M8.6 7.1l1.1 1.1M11 4.7l1.6 1.6" />
    </Svg>
  ),
  properties: (p) => (
    <Svg {...p}>
      <Block top="f" left="f" right="f" />
      <path className="a" d="M12.5 17.5h5M12.5 14.5h5" />
    </Svg>
  ),
  bedFit: (p) => (
    <Svg {...p}>
      <path className="f" d="M3 16.5V3.5h14v13" strokeDasharray="1.6 1.8" />
      <path d="M1.5 16.5h17" />
      <rect className="a af" x={7} y={9} width={6} height={7.5} rx={0.8} />
    </Svg>
  ),
  section: (p) => (
    <Svg {...p}>
      <path className="f" d="M3.5 6.75v6.5L10 16.5V10z" />
      <path className="f" d="M10 3.5l6.5 3.25L10 10 3.5 6.75z" />
      <path className="a af" d="M16.5 6.75v6.5L10 16.5V10z" />
      <path className="a" d="M11.6 13.9l3.2-3.9M11.6 11.1l1.6-2" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M10 2.5l6.5 2.7v5c0 3.6-2.8 6-6.5 7.3-3.7-1.3-6.5-3.7-6.5-7.3v-5z" />
      <path className="a" d="M7 10l2.2 2.2 4-4.4" />
    </Svg>
  ),
  // ─── Browser entities ────────────────────────────────────────────────────────────────────
  body: (p) => (
    <Svg {...p}>
      <Block top="af" />
    </Svg>
  ),
  part: (p) => (
    <Svg {...p}>
      <Block />
    </Svg>
  ),
  parameters: (p) => (
    <Svg {...p}>
      <path d="M3.5 6h13M3.5 14h13" />
      <circle className="a af" cx={7.5} cy={6} r={2} />
      <circle className="a af" cx={12.5} cy={14} r={2} />
    </Svg>
  ),
};

const GENERIC = (p: P): ReactElement => (
  <Svg {...p}>
    <rect x={3.5} y={3.5} width={13} height={13} rx={3} />
    <path className="f" d="M7 10h6M10 7v6" />
  </Svg>
);

/** Aliases: the sketcher's tool ids and older names map onto the set above. */
const ALIASES: Record<string, string> = {
  rect2: "rectangle",
  circleCenter: "circle",
  arc3: "arc",
  fillet2d: "sketchFillet",
  chamfer2d: "sketchChamfer",
  datum_plane: "plane",
  datum_axis: "axis",
  boolean: "combine",
  pattern: "linearPattern",
};

/** The names the toolbar knows (tests and the tool registry's docs list them). */
export const TOOL_ICON_NAMES: readonly string[] = [...Object.keys(ICONS), ...Object.keys(ALIASES)];

export function hasToolIcon(name: string | null | undefined): boolean {
  return !!name && (name in ICONS || name in ALIASES);
}

export function ToolIcon({ name, size = 16 }: { name: string | null | undefined; size?: number }): ReactElement {
  const C = (name && (ICONS[name] ?? ICONS[ALIASES[name] ?? ""])) || GENERIC;
  return <C size={size} />;
}
