/**
 * The viewport camera in TypeScript: a faithful port of `forge-render/src/camera.rs` (turntable,
 * Z up, reverse-Z), so DOM/SVG overlays (view cube, manipulators, measure labels, box select,
 * vertex markers) line up with the pixels forge-render draws. The placeholder renderer uses the
 * same camera, so every adapter shares one convention.
 *
 * Conventions (as in camera.rs):
 * - world: right-handed, Z up, millimetres;
 * - orientation `(yaw, pitch)`: the eye sits at `target + distance · back` with
 *   `back = (sin yaw · cos pitch, −cos yaw · cos pitch, sin pitch)`, screen-right
 *   `right = (cos yaw, sin yaw, 0)`, screen-up `up = back × right`;
 *   `yaw = 0, pitch = 0` is the front view (looking along +Y), `pitch = π/2` is top;
 * - pixels: origin top-left, x right, y down. The functions take a viewport size in whatever pixel
 *   unit the caller uses (the app uses CSS pixels; forge-render uses physical pixels: both give the
 *   same picture because only ratios matter);
 * - orthographic scale follows the perspective one at the target: half-height
 *   `distance · tan(fovY / 2)`.
 */

export type Vec3 = [number, number, number];
export type Projection = "perspective" | "orthographic";

/** Every standard view forge-render knows (`StandardView::parse`). */
export const STANDARD_VIEWS = ["iso", "top", "front", "right", "bottom", "back", "left"] as const;
export type StandardView = (typeof STANDARD_VIEWS)[number];

/** The camera as forge-web's `cameraState()` reports it. */
export interface CameraState {
  target: Vec3;
  distance: number;
  yaw: number;
  pitch: number;
  fovY: number;
  projection: Projection;
}

export interface Sphere {
  center: Vec3;
  radius: number;
}

/** Radians of orbit per pixel of pointer motion (camera.rs `ORBIT_RAD_PER_PX`). */
export const ORBIT_RAD_PER_PX = 0.008;
/** Smallest and largest camera distance (mm). */
export const DISTANCE_RANGE: readonly [number, number] = [1e-3, 1e7];
/** Margin applied by {@link fitSphere} (1 = touching the sphere). */
export const FIT_MARGIN = 1.08;
const HALF_PI = Math.PI / 2;

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const distance3 = (a: Vec3, b: Vec3): number => length(sub(a, b));
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

export function defaultCamera(): CameraState {
  const [yaw, pitch] = viewAngles("iso");
  return { target: [0, 0, 0], distance: 200, yaw, pitch, fovY: (35 * Math.PI) / 180, projection: "perspective" };
}

/** `(yaw, pitch)` of a standard view (camera.rs `StandardView::angles`). */
export function viewAngles(view: StandardView): [number, number] {
  switch (view) {
    case "iso":
      return [Math.PI / 4, Math.atan(1 / Math.sqrt(2))];
    case "top":
      return [0, HALF_PI];
    case "front":
      return [0, 0];
    case "right":
      return [HALF_PI, 0];
    case "bottom":
      return [0, -HALF_PI];
    case "back":
      return [Math.PI, 0];
    case "left":
      return [-HALF_PI, 0];
  }
}

export interface Basis {
  right: Vec3;
  up: Vec3;
  /** From the target towards the eye. */
  back: Vec3;
}

export function basis(c: Pick<CameraState, "yaw" | "pitch">): Basis {
  const sy = Math.sin(c.yaw);
  const cy = Math.cos(c.yaw);
  const sp = Math.sin(c.pitch);
  const cp = Math.cos(c.pitch);
  const right: Vec3 = [cy, sy, 0];
  const back: Vec3 = [sy * cp, -cy * cp, sp];
  return { right, up: cross(back, right), back };
}

export function eye(c: CameraState): Vec3 {
  return add(c.target, scale(basis(c).back, c.distance));
}

/** Half the visible height at the target plane (mm). */
export function halfHeightAtTarget(c: CameraState): number {
  return c.distance * Math.tan(c.fovY * 0.5);
}

/** World size (mm) of one pixel at the target plane for a viewport `heightPx` pixels tall. */
export function worldPerPixel(c: CameraState, heightPx: number): number {
  return (2 * halfHeightAtTarget(c)) / Math.max(1, heightPx);
}

/** A projected point: pixel coordinates and the view depth (distance along the view direction). */
export interface ScreenPoint {
  x: number;
  y: number;
  /** Distance in front of the eye along the view direction (mm); larger = farther. */
  depth: number;
}

/** Everything overlays need for one frame (pure data, cheap to build per frame). */
export interface CameraFrame {
  readonly state: CameraState;
  readonly width: number;
  readonly height: number;
  readonly basis: Basis;
  readonly eye: Vec3;
  /** Viewing direction (into the scene), unit. */
  readonly forward: Vec3;
  /** World units per pixel at the target plane. */
  readonly worldPerPixel: number;
  /** Project a world point; `null` behind a perspective eye. */
  project(p: Vec3): ScreenPoint | null;
  /** The pick ray through pixel `(x, y)`: origin and unit direction. */
  ray(x: number, y: number): { origin: Vec3; dir: Vec3 };
  /** World size of one pixel at world point `p` (perspective grows with distance). */
  pixelSizeAt(p: Vec3): number;
}

export function cameraFrame(c: CameraState, width: number, height: number): CameraFrame {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const b = basis(c);
  const e = add(c.target, scale(b.back, c.distance));
  const forward = scale(b.back, -1);
  const tanHalf = Math.tan(c.fovY * 0.5);
  const hh = c.distance * tanHalf;
  const hw = (hh * w) / h;
  const perspective = c.projection === "perspective";
  const [rx, ry, rz] = b.right;
  const [ux, uy, uz] = b.up;
  const [fx, fy, fz] = forward;
  // Perspective: pixels per unit of (view x / view depth); ortho: pixels per mm.
  const focal = h / 2 / tanHalf;
  const orthoScale = h / 2 / hh;
  return {
    state: c,
    width: w,
    height: h,
    basis: b,
    eye: e,
    forward,
    worldPerPixel: (2 * hh) / h,
    project(p) {
      const dx = p[0] - e[0];
      const dy = p[1] - e[1];
      const dz = p[2] - e[2];
      const vx = dx * rx + dy * ry + dz * rz;
      const vy = dx * ux + dy * uy + dz * uz;
      const depth = dx * fx + dy * fy + dz * fz;
      if (perspective) {
        if (depth <= 0) return null;
        return { x: w / 2 + (vx / depth) * focal, y: h / 2 - (vy / depth) * focal, depth };
      }
      return { x: w / 2 + vx * orthoScale, y: h / 2 - vy * orthoScale, depth };
    },
    ray(x, y) {
      const nx = (2 * x) / w - 1;
      const ny = 1 - (2 * y) / h;
      if (perspective) {
        const d = add(add(scale(b.back, -c.distance), scale(b.right, nx * hw)), scale(b.up, ny * hh));
        return { origin: e, dir: normalize(d) };
      }
      return { origin: add(add(e, scale(b.right, nx * hw)), scale(b.up, ny * hh)), dir: forward };
    },
    pixelSizeAt(p) {
      if (!perspective) return (2 * hh) / h;
      const depth = Math.max(1e-9, dot(sub(p, e), forward));
      return (2 * tanHalf * depth) / h;
    },
  };
}

/** Turntable orbit by `(dx, dy)` pixels (camera.rs `Camera::orbit`). */
export function orbit(c: CameraState, dx: number, dy: number): CameraState {
  let yaw = c.yaw - dx * ORBIT_RAD_PER_PX;
  if (yaw > Math.PI) yaw -= 2 * Math.PI;
  else if (yaw <= -Math.PI) yaw += 2 * Math.PI;
  const pitch = Math.max(-HALF_PI, Math.min(HALF_PI, c.pitch + dy * ORBIT_RAD_PER_PX));
  return { ...c, yaw, pitch };
}

/** Pan by `(dx, dy)` pixels: the scene follows the pointer at the target plane. */
export function pan(c: CameraState, dx: number, dy: number, heightPx: number): CameraState {
  const b = basis(c);
  const s = worldPerPixel(c, heightPx);
  return { ...c, target: add(c.target, add(scale(b.right, -dx * s), scale(b.up, dy * s))) };
}

/** Zoom by `factor` (< 1 zooms in) keeping the point under pixel `(x, y)` on the target plane fixed. */
export function zoomAt(c: CameraState, x: number, y: number, width: number, height: number, factor: number): CameraState {
  if (!(Number.isFinite(factor) && factor > 0)) return c;
  const [lo, hi] = DISTANCE_RANGE;
  const f = Math.min(hi, Math.max(lo, c.distance * factor)) / c.distance;
  const { origin, dir } = cameraFrame(c, width, height).ray(x, y);
  const back = basis(c).back;
  const denom = dot(dir, back);
  const p = Math.abs(denom) > 1e-12 ? add(origin, scale(dir, dot(sub(c.target, origin), back) / denom)) : c.target;
  return { ...c, target: add(p, scale(sub(c.target, p), f)), distance: c.distance * f };
}

/** Frame a sphere for a viewport of aspect `width / height`, keeping the orientation. */
export function fitSphere(c: CameraState, sphere: Sphere, aspect: number): CameraState {
  const halfV = c.fovY * 0.5;
  const halfH = Math.atan(Math.tan(halfV) * Math.max(aspect, 1e-6));
  const half = Math.min(halfV, halfH);
  const [lo, hi] = DISTANCE_RANGE;
  const d = Math.min(hi, Math.max(lo, (Math.max(sphere.radius, 1e-6) / Math.sin(half)) * FIT_MARGIN));
  return { ...c, target: [...sphere.center], distance: d };
}

/** The bounding sphere of an axis-aligned box (radius at least `minRadius`). */
export function sphereFromBox(min: Vec3, max: Vec3, minRadius = 1e-3): Sphere {
  return { center: scale(add(min, max), 0.5), radius: Math.max(minRadius, length(scale(sub(max, min), 0.5))) };
}

/**
 * The `(yaw, pitch)` that looks **along** `dir` (from the eye into the scene). Pitch is clamped to
 * ±π/2 like the turntable; at the poles the yaw keeps `keepYaw` so the view does not spin.
 */
export function anglesLookingAlong(dir: Vec3, keepYaw = 0): [number, number] {
  const back = normalize(scale(dir, -1));
  const pitch = Math.asin(Math.max(-1, Math.min(1, back[2])));
  const horiz = Math.hypot(back[0], back[1]);
  if (horiz < 1e-9) return [keepYaw, pitch];
  // back = (sin yaw · cp, −cos yaw · cp, sp) ⇒ yaw = atan2(back.x, −back.y).
  return [Math.atan2(back[0], -back[1]), pitch];
}

/** Shortest signed angle from `a` to `b` (radians, in (−π, π]). */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Interpolate two camera states (`t` in [0, 1]); yaw takes the short way round. */
export function lerpCamera(a: CameraState, b: CameraState, t: number): CameraState {
  const k = Math.max(0, Math.min(1, t));
  const mix = (x: number, y: number): number => x + (y - x) * k;
  // Distance interpolates geometrically (zoom feels linear).
  const dist = Math.exp(mix(Math.log(Math.max(a.distance, 1e-9)), Math.log(Math.max(b.distance, 1e-9))));
  return {
    target: [mix(a.target[0], b.target[0]), mix(a.target[1], b.target[1]), mix(a.target[2], b.target[2])],
    distance: dist,
    yaw: a.yaw + angleDelta(a.yaw, b.yaw) * k,
    pitch: mix(a.pitch, b.pitch),
    fovY: mix(a.fovY, b.fovY),
    projection: k < 1 ? a.projection : b.projection,
  };
}

/** Smooth ease for view transitions. */
export function easeInOut(t: number): number {
  const k = Math.max(0, Math.min(1, t));
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
}

/** Which standard view (if any) a camera is at (within `tol` radians). */
export function standardViewOf(c: Pick<CameraState, "yaw" | "pitch">, tol = 1e-6): StandardView | null {
  for (const v of STANDARD_VIEWS) {
    const [yaw, pitch] = viewAngles(v);
    const polar = Math.abs(Math.abs(pitch) - HALF_PI) < tol;
    if (Math.abs(c.pitch - pitch) < tol && (polar ? Math.abs(angleDelta(c.yaw, yaw)) < tol : Math.abs(angleDelta(c.yaw, yaw)) < tol)) return v;
  }
  return null;
}
