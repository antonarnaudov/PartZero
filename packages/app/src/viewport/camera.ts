/**
 * Orbit camera for the placeholder viewport (Z-up, like the IR's model space). Pure math, so the
 * standard views and projection are unit-testable.
 */
import type { Projection, ViewName } from "../engine/forge-web-contract";

export type Vec3 = [number, number, number];

export interface OrbitCamera {
  target: Vec3;
  distance: number;
  /** Azimuth about +Z, radians (0 = looking from +X). */
  yaw: number;
  /** Elevation, radians (π/2 = looking straight down). */
  pitch: number;
  projection: Projection;
  /** Vertical field of view, radians. */
  fov: number;
}

export interface CameraBasis {
  eye: Vec3;
  /** Unit vectors: right, up, forward (into the screen). */
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

const DEG = Math.PI / 180;
export const MAX_PITCH = 89.9 * DEG;

export const STANDARD_VIEWS: Record<ViewName, { yaw: number; pitch: number }> = {
  // From front-right-top: +X to the right-front, +Y to the back, +Z up.
  iso: { yaw: -45 * DEG, pitch: Math.atan(1 / Math.SQRT2) },
  top: { yaw: -90 * DEG, pitch: MAX_PITCH },
  front: { yaw: -90 * DEG, pitch: 0 },
  right: { yaw: 0, pitch: 0 },
};

export function defaultCamera(): OrbitCamera {
  return { target: [0, 0, 0], distance: 200, ...STANDARD_VIEWS.iso, projection: "perspective", fov: 35 * DEG };
}

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function basis(c: OrbitCamera): CameraBasis {
  const cp = Math.cos(c.pitch);
  const dir: Vec3 = [cp * Math.cos(c.yaw), cp * Math.sin(c.yaw), Math.sin(c.pitch)];
  const eye = add(c.target, scale(dir, c.distance));
  const forward = scale(dir, -1);
  // Right stays horizontal (turntable orbit), which also keeps it defined when looking straight down.
  const right: Vec3 = [-Math.sin(c.yaw), Math.cos(c.yaw), 0];
  const up = cross(right, forward);
  return { eye, right, up, forward };
}

export interface Projector {
  basis: CameraBasis;
  /** Screen position (CSS px) and view depth of a world point. */
  project(p: Vec3, out: { x: number; y: number; z: number }): void;
  /** World units per CSS pixel at the target distance. */
  worldPerPixel: number;
}

export function projector(c: OrbitCamera, width: number, height: number): Projector {
  const b = basis(c);
  const halfH = height / 2;
  const tanHalf = Math.tan(c.fov / 2);
  const focal = halfH / tanHalf;
  const orthoScale = halfH / (c.distance * tanHalf);
  const cx = width / 2;
  const cy = height / 2;
  const near = c.distance * 1e-3;
  const [ex, ey, ez] = b.eye;
  const [rx, ry, rz] = b.right;
  const [ux, uy, uz] = b.up;
  const [fx, fy, fz] = b.forward;
  return {
    basis: b,
    worldPerPixel: 1 / orthoScale,
    project(p, out) {
      const dx = p[0] - ex, dy = p[1] - ey, dz = p[2] - ez;
      const x = dx * rx + dy * ry + dz * rz;
      const y = dx * ux + dy * uy + dz * uz;
      const z = dx * fx + dy * fy + dz * fz;
      if (c.projection === "perspective") {
        const zz = Math.max(z, near);
        out.x = cx + (x / zz) * focal;
        out.y = cy - (y / zz) * focal;
      } else {
        out.x = cx + x * orthoScale;
        out.y = cy - y * orthoScale;
      }
      out.z = z;
    },
  };
}

/** Camera distance that fits a bounding sphere in view (both projections). */
export function fitDistance(radius: number, fov: number, aspect: number): number {
  const half = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * Math.max(aspect, 1e-3)));
  return (Math.max(radius, 1e-3) / Math.sin(half)) * 1.15;
}
