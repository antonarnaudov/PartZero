/**
 * Glyphs of the model panels (timeline, browser, parameters, problems) that the app and tool icon
 * sets lack. Same grid as `ui/icons.tsx`: 16 px, 1.5 px strokes, `currentColor`.
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

export const ModelIcon = {
  /** Roll the marker to the start. */
  First: (p: P) => (
    <Svg {...p}>
      <path d="M4 3.5v9" />
      <path d="M12 3.8 6.6 8 12 12.2z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Prev: (p: P) => (
    <Svg {...p}>
      <path d="M10.5 3.8 5 8l5.5 4.2z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Next: (p: P) => (
    <Svg {...p}>
      <path d="M5.5 3.8 11 8l-5.5 4.2z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Last: (p: P) => (
    <Svg {...p}>
      <path d="M12 3.5v9" />
      <path d="M4 3.8 9.4 8 4 12.2z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Eye: (p: P) => (
    <Svg {...p}>
      <path d="M1.8 8S4.2 3.8 8 3.8 14.2 8 14.2 8 11.8 12.2 8 12.2 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </Svg>
  ),
  EyeOff: (p: P) => (
    <Svg {...p}>
      <path d="M6.3 4.1A6 6 0 0 1 8 3.8C11.8 3.8 14.2 8 14.2 8a11 11 0 0 1-1.7 2.2M9.9 11.9a6 6 0 0 1-1.9.3C4.2 12.2 1.8 8 1.8 8a11 11 0 0 1 2.4-2.9" />
      <path d="M2.5 2.5l11 11" />
    </Svg>
  ),
  /** Isolate: show only this. */
  Isolate: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2" />
    </Svg>
  ),
  Body: (p: P) => (
    <Svg {...p}>
      <path d="M8 1.9 13.4 5v6L8 14.1 2.6 11V5z" />
      <path d="M2.6 5 8 8.1 13.4 5M8 8.1v6" opacity={0.55} />
    </Svg>
  ),
  Origin: (p: P) => (
    <Svg {...p}>
      <path d="M8 8V2.5M8 8l4.8 2.8M8 8l-4.8 2.8" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Plane: (p: P) => (
    <Svg {...p}>
      <path d="M2 10.5 6 4.5h8l-4 6z" />
    </Svg>
  ),
  Axis: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 13.5 13.5 2.5" strokeDasharray="2.2 1.8" />
    </Svg>
  ),
  Point: (p: P) => (
    <Svg {...p}>
      <circle cx="8" cy="8" r="2" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Folder: (p: P) => (
    <Svg {...p}>
      <path d="M2 4.5c0-.6.4-1 1-1h3l1.4 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z" />
    </Svg>
  ),
  Document: (p: P) => (
    <Svg {...p}>
      <path d="M8 1.9 13.4 5v6L8 14.1 2.6 11V5z" opacity={0.55} />
      <path d="M8 8.1 13.4 5M8 8.1 2.6 5M8 8.1v6" />
    </Svg>
  ),
  Construction: (p: P) => (
    <Svg {...p}>
      <path d="M2 11.5 5.5 5h8.5l-3.5 6.5z" strokeDasharray="2 1.6" />
    </Svg>
  ),
  More: (p: P) => (
    <Svg {...p}>
      <circle cx="3.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Plus: (p: P) => (
    <Svg {...p}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  ),
  /** Promote a value to a parameter. */
  Promote: (p: P) => (
    <Svg {...p}>
      <path d="M8 13V4M4.5 7.5 8 4l3.5 3.5" />
      <path d="M3 13.5h10" opacity={0.55} />
    </Svg>
  ),
  Fx: (p: P) => (
    <Svg {...p}>
      <path d="M7.5 3.2c-1.6-.4-2.4.4-2.6 1.8L3.8 12.6c-.2 1.3-1 1.9-2.3 1.6" />
      <path d="M3.4 7h4" />
      <path d="m9.5 7.5 4 5M13.5 7.5l-4 5" />
    </Svg>
  ),
  Filter: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 3.5h11L9.2 8.6v4.2l-2.4-1.2v-3z" />
    </Svg>
  ),
  Marker: (p: P) => (
    <Svg {...p}>
      <path d="M8 2.5v11" />
      <path d="M5.5 2.5h5L8 5.5z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  Rename: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 11.5h6M10.5 4.5l1.8-1.8a1.2 1.2 0 0 1 1.7 1.7l-6.2 6.2-2.4.6.6-2.4z" />
    </Svg>
  ),
  Trash: (p: P) => (
    <Svg {...p}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" />
    </Svg>
  ),
  History: (p: P) => (
    <Svg {...p}>
      <path d="M2.8 8a5.2 5.2 0 1 0 1.6-3.8L2.5 6" />
      <path d="M2.5 3v3h3M8 5.2V8l2 1.3" />
    </Svg>
  ),
};
