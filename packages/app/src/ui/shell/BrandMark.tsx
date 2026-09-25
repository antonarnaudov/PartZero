/**
 * The PartZero mark: an isometric block with a round hole through its top face, on a dark tile.
 * The part is the block; the hole is the zero. The same geometry (64-unit grid, same colours) is
 * rasterized into the app icon by `packages/desktop/scripts/make-icon.mjs`; keep them in step.
 */
import { useId, type ReactElement } from "react";

export const BRAND_NAME = "PartZero";

/** The mark's geometry on a 64 × 64 grid (see make-icon.mjs, which uses the same numbers). */
export const MARK = {
  tile: { x: 4, y: 4, size: 56, r: 13, top: "#232B3D", bottom: "#121620" },
  cube: {
    top: [
      [32, 16],
      [48.454, 25.5],
      [32, 35],
      [15.546, 25.5],
    ],
    left: [
      [15.546, 25.5],
      [32, 35],
      [32, 54],
      [15.546, 44.5],
    ],
    right: [
      [32, 35],
      [48.454, 25.5],
      [48.454, 44.5],
      [32, 54],
    ],
    colors: { top: "#9CC0FF", left: "#4C8DFF", right: "#2A5BD0" },
  },
  hole: { cx: 32, cy: 25.5, rx: 7, ry: 4.041, wallDrop: 2.6, depth: "#0D1426", wall: "#3F74E0" },
} as const;

const pts = (p: ReadonlyArray<readonly [number, number]>): string => p.map(([x, y]) => `${x},${y}`).join(" ");

/** The mark as an inline SVG. `tile: false` draws the block alone (on a coloured surface). */
export function BrandMark({ size = 22, tile = true, title }: { size?: number; tile?: boolean; title?: string }): ReactElement {
  const id = useId().replace(/:/g, "");
  const { cube, hole } = MARK;
  const t = MARK.tile;
  return (
    <svg
      width={size}
      height={size}
      viewBox={tile ? "0 0 64 64" : "12 13 40 44"}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      className="brand-svg"
    >
      <defs>
        <linearGradient id={`pz-tile-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={t.top} />
          <stop offset="1" stopColor={t.bottom} />
        </linearGradient>
        <clipPath id={`pz-hole-${id}`}>
          <ellipse cx={hole.cx} cy={hole.cy} rx={hole.rx} ry={hole.ry} />
        </clipPath>
      </defs>
      {tile && <rect x={t.x} y={t.y} width={t.size} height={t.size} rx={t.r} fill={`url(#pz-tile-${id})`} />}
      <polygon points={pts(cube.top)} fill={cube.colors.top} />
      <polygon points={pts(cube.left)} fill={cube.colors.left} />
      <polygon points={pts(cube.right)} fill={cube.colors.right} />
      <ellipse cx={hole.cx} cy={hole.cy} rx={hole.rx} ry={hole.ry} fill={hole.depth} />
      <g clipPath={`url(#pz-hole-${id})`}>
        {/* The far wall of the hole: the ellipse minus itself moved down by the visible wall depth. */}
        <path
          fillRule="evenodd"
          fill={hole.wall}
          d={`M${hole.cx - hole.rx},${hole.cy} a${hole.rx},${hole.ry} 0 1,0 ${2 * hole.rx},0 a${hole.rx},${hole.ry} 0 1,0 ${-2 * hole.rx},0 Z M${hole.cx - hole.rx},${hole.cy + hole.wallDrop} a${hole.rx},${hole.ry} 0 1,0 ${2 * hole.rx},0 a${hole.rx},${hole.ry} 0 1,0 ${-2 * hole.rx},0 Z`}
        />
      </g>
    </svg>
  );
}

/** The mark and the name, as in the toolbar and the welcome screen. */
export function BrandLockup({ size = 22 }: { size?: number }): ReactElement {
  return (
    <span className="brand-lockup" data-testid="brand">
      <BrandMark size={size} />
      <span className="brand-word">{BRAND_NAME}</span>
    </span>
  );
}
