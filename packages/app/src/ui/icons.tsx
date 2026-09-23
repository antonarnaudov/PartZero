/** A small, consistent icon set (16px grid, 1.5px strokes, currentColor). */
import type { ReactElement, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Sketch: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.5 13.5h11" opacity={0.5} />
      <path d="M3.5 11 10.8 3.7a1.4 1.4 0 0 1 2 2L5.5 13H3.5z" />
    </Svg>
  ),
  Extrude: (p: IconProps) => (
    <Svg {...p}>
      <path d="M3 10.5 8 13l5-2.5" opacity={0.55} />
      <path d="M3 6 8 8.5 13 6 8 3.5z" />
      <path d="M3 6v4.5M13 6v4.5M8 8.5V13" />
    </Svg>
  ),
  Revolve: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 2v12" strokeDasharray="1.5 1.8" opacity={0.6} />
      <path d="M12.8 6.2A5 2.2 0 1 1 8 5.8" />
      <path d="m11 4.6 1.9 1.6-2.1 1" />
    </Svg>
  ),
  Part: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z" />
      <path d="M2.5 5 8 8.2 13.5 5M8 8.2v6" opacity={0.6} />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Svg>
  ),
  Error: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={8} cy={8} r={5.8} />
      <path d="M8 4.8v3.8M8 11v.2" />
    </Svg>
  ),
  Warning: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 2.2 14.2 13H1.8z" />
      <path d="M8 6.5v3M8 11.2v.1" />
    </Svg>
  ),
  Info: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={8} cy={8} r={5.8} />
      <path d="M8 7.3v3.9M8 5v.1" />
    </Svg>
  ),
  EyeOff: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 2l12 12" />
      <path d="M6.2 4.2A6.6 6.6 0 0 1 8 4c3.6 0 6 4 6 4a10 10 0 0 1-1.8 2.2M9.9 11.6A5.6 5.6 0 0 1 8 12c-3.6 0-6-4-6-4a10.5 10.5 0 0 1 2.2-2.6" />
    </Svg>
  ),
  Eye: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4z" />
      <circle cx={8} cy={8} r={1.8} />
    </Svg>
  ),
  File: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 1.8h5.2L12.5 5v9.2H4z" />
      <path d="M9 1.8V5.2h3.5" />
    </Svg>
  ),
  FolderOpen: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 12.8V3.5h4l1.4 1.5H13v1.8" />
      <path d="M2 12.8 4 7h10.5l-2 5.8z" />
    </Svg>
  ),
  Save: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.5 2.5h8.8l2.2 2.2v8.8h-11z" />
      <path d="M5 2.5v3.3h5V2.5M5 13.5V9.5h6v4" />
    </Svg>
  ),
  Template: (p: IconProps) => (
    <Svg {...p}>
      <rect x={2} y={2} width={5} height={5} rx={1} />
      <rect x={9} y={2} width={5} height={5} rx={1} />
      <rect x={2} y={9} width={5} height={5} rx={1} />
      <path d="M11.5 9.3v4.4M9.3 11.5h4.4" />
    </Svg>
  ),
  Undo: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 3.5 2.5 6 5 8.5" />
      <path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6" />
    </Svg>
  ),
  Redo: (p: IconProps) => (
    <Svg {...p}>
      <path d="m11 3.5 2.5 2.5L11 8.5" />
      <path d="M13.5 6H6a3.5 3.5 0 0 0 0 7h4" />
    </Svg>
  ),
  Export: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 10V2M5 4.8 8 1.8l3 3" />
      <path d="M3 8.5v5h10v-5" />
    </Svg>
  ),
  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={7} cy={7} r={4.2} />
      <path d="m10.2 10.2 3.3 3.3" />
    </Svg>
  ),
  Sun: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={8} cy={8} r={2.8} />
      <path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9" />
    </Svg>
  ),
  Moon: (p: IconProps) => (
    <Svg {...p}>
      <path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z" />
    </Svg>
  ),
  Fit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />
      <rect x={5.5} y={5.5} width={5} height={5} rx={0.6} opacity={0.7} />
    </Svg>
  ),
  Cube: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 2 13.5 5v6L8 14 2.5 11V5z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </Svg>
  ),
  Send: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.5 8 13.5 2.5 11 13.5 8 9z" />
      <path d="M8 9l5.5-6.5" />
    </Svg>
  ),
  Close: (p: IconProps) => (
    <Svg {...p}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  ),
  Sparkle: (p: IconProps) => (
    <Svg {...p}>
      <path d="M8 2.2 9.3 6.7 13.8 8l-4.5 1.3L8 13.8 6.7 9.3 2.2 8l4.5-1.3z" />
    </Svg>
  ),
  Code: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />
    </Svg>
  ),
  Timeline: (p: IconProps) => (
    <Svg {...p}>
      <circle cx={4} cy={4} r={1.5} />
      <circle cx={4} cy={12} r={1.5} />
      <path d="M4 5.5v5M7.5 4h6M7.5 12h6M7.5 8h4" opacity={0.8} />
    </Svg>
  ),
  Params: (p: IconProps) => (
    <Svg {...p}>
      <path d="M2.5 4.5h11M2.5 11.5h11" opacity={0.6} />
      <circle cx={5.5} cy={4.5} r={1.6} />
      <circle cx={10.5} cy={11.5} r={1.6} />
    </Svg>
  ),
  Chevron: (p: IconProps) => (
    <Svg {...p}>
      <path d="m6 4 4 4-4 4" />
    </Svg>
  ),
  Spinner: (p: IconProps) => (
    <Svg {...p} className={`spin ${p.className ?? ""}`}>
      <path d="M8 2a6 6 0 1 1-6 6" />
    </Svg>
  ),
};
