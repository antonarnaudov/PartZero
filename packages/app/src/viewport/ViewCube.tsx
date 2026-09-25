/**
 * The view cube (top right of the viewport): turns with the camera; click a face for its standard
 * view, an edge or a corner for the view between; the house button is Home (isometric, fitted).
 */
import { useMemo, useState, type ReactElement } from "react";
import { cubeCells, imageOf, visibleFaces } from "./view-cube-geometry";
import type { Basis, StandardView, Vec3 } from "./view-camera";

const SIZE = 104;
const HALF = SIZE / 2;
/** Cube half-size in px (its diagonal, √3 × this, stays inside the box). */
const S = 27;

export interface ViewCubeProps {
  basis: Basis;
  onView: (view: StandardView) => void;
  /** Called with the direction to look along (into the scene) for an edge or corner cell. */
  onDirection: (dir: Vec3) => void;
  onHome: () => void;
}

export function ViewCube({ basis, onView, onDirection, onHome }: ViewCubeProps): ReactElement {
  const cells = useMemo(cubeCells, []);
  const [hover, setHover] = useState<string | null>(null);
  const faces = visibleFaces(basis);
  const pt = (p: Vec3): string => {
    const [x, y] = imageOf(basis, p, S);
    return `${(HALF + x).toFixed(2)},${(HALF + y).toFixed(2)}`;
  };
  return (
    <div className="vp-cube" data-testid="view-cube">
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} role="group" aria-label="View cube">
        {faces.map((face) => {
          const faceCells = cells.filter((c) => c.face === face);
          const [ux, uy] = imageOf(basis, face.u, S);
          const [vx, vy] = imageOf(basis, face.v, S);
          const [cx, cy] = imageOf(basis, face.normal, S);
          // Text in face coordinates: local x → u, local y (down) → −v; font sized in face units.
          const m = `matrix(${ux.toFixed(4)},${uy.toFixed(4)},${(-vx).toFixed(4)},${(-vy).toFixed(4)},${(HALF + cx).toFixed(2)},${(HALF + cy).toFixed(2)})`;
          return (
            <g key={face.view} className="vp-cube-face" data-face={face.view}>
              {faceCells.map((c) => (
                <polygon
                  key={`${c.i},${c.j}`}
                  points={c.corners.map(pt).join(" ")}
                  className={`vp-cube-cell${c.view ? " center" : ""}${hover === c.key ? " hover" : ""}`}
                  data-cube={c.view ?? undefined}
                  data-dir={c.key}
                  onPointerEnter={() => setHover(c.key)}
                  onPointerLeave={() => setHover((h) => (h === c.key ? null : h))}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (c.view) onView(c.view);
                    // The cell's direction points out of the cube (where the eye goes): look back along −dir.
                    else onDirection([-c.dir[0], -c.dir[1], -c.dir[2]]);
                  }}
                >
                  <title>{c.view ? `${face.label.charAt(0)}${face.label.slice(1).toLowerCase()} view` : "Orient to this edge or corner"}</title>
                </polygon>
              ))}
              <text className="vp-cube-label" transform={m} textAnchor="middle" dominantBaseline="central" fontSize={0.36}>
                {face.label}
              </text>
            </g>
          );
        })}
      </svg>
      <button type="button" className="vp-cube-home" data-testid="view-cube-home" title="Home view (isometric, fitted)" aria-label="Home view" onClick={onHome}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3v-3.5h2V13h3V6.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
