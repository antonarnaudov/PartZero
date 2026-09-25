import { describe, expect, it } from "vitest";
import {
  anglesLookingAlong,
  basis,
  cameraFrame,
  cross,
  defaultCamera,
  dot,
  easeInOut,
  fitSphere,
  length,
  lerpCamera,
  orbit,
  pan,
  STANDARD_VIEWS,
  standardViewOf,
  sub,
  viewAngles,
  zoomAt,
  type CameraState,
  type Vec3,
} from "../src/viewport/view-camera";

const W = 800;
const H = 600;
const close = (a: Vec3, b: Vec3, tol = 1e-9): boolean => length(sub(a, b)) <= tol;

function at(view: (typeof STANDARD_VIEWS)[number], projection: CameraState["projection"] = "perspective"): CameraState {
  const [yaw, pitch] = viewAngles(view);
  return { ...defaultCamera(), yaw, pitch, projection };
}

describe("viewport camera (port of forge-render camera.rs)", () => {
  it("has an orthonormal, right-handed basis everywhere, poles included", () => {
    for (let i = 0; i <= 20; i++) {
      for (let j = 0; j <= 12; j++) {
        const b = basis({ yaw: -3.1 + 0.31 * i, pitch: -Math.PI / 2 + (Math.PI * j) / 12 });
        for (const v of [b.right, b.up, b.back]) expect(Math.abs(length(v) - 1)).toBeLessThan(1e-12);
        expect(Math.abs(dot(b.right, b.up)) + Math.abs(dot(b.right, b.back)) + Math.abs(dot(b.up, b.back))).toBeLessThan(1e-12);
        expect(close(cross(b.right, b.up), b.back, 1e-12)).toBe(true);
      }
    }
  });

  it("standard views look along the documented axes (same table as camera.rs)", () => {
    const cases: Array<[(typeof STANDARD_VIEWS)[number], Vec3, Vec3, Vec3]> = [
      ["front", [0, 1, 0], [1, 0, 0], [0, 0, 1]],
      ["top", [0, 0, -1], [1, 0, 0], [0, 1, 0]],
      ["right", [-1, 0, 0], [0, 1, 0], [0, 0, 1]],
      ["bottom", [0, 0, 1], [1, 0, 0], [0, -1, 0]],
      ["back", [0, -1, 0], [-1, 0, 0], [0, 0, 1]],
      ["left", [1, 0, 0], [0, -1, 0], [0, 0, 1]],
    ];
    for (const [view, forward, right, up] of cases) {
      const f = cameraFrame(at(view), W, H);
      expect(close(f.forward, forward, 1e-12), `${view} forward ${f.forward}`).toBe(true);
      expect(close(f.basis.right, right, 1e-12), `${view} right`).toBe(true);
      expect(close(f.basis.up, up, 1e-12), `${view} up`).toBe(true);
    }
    const iso = cameraFrame(at("iso"), W, H);
    const d = Math.sqrt(3);
    expect(close(iso.forward, [-1 / d, 1 / d, -1 / d], 1e-12)).toBe(true);
  });

  it("projects the target to the centre, and the pick ray goes back through the projected point", () => {
    for (const projection of ["perspective", "orthographic"] as const) {
      const c: CameraState = { ...defaultCamera(), target: [3, 4, 5], projection };
      const f = cameraFrame(c, W, H);
      const s = f.project(c.target)!;
      expect(s.x).toBeCloseTo(W / 2, 9);
      expect(s.y).toBeCloseTo(H / 2, 9);
      const p: Vec3 = [12, -7, 20];
      const q = f.project(p)!;
      const { origin, dir } = f.ray(q.x, q.y);
      // p lies on the ray: |(p − o) × dir| = 0.
      expect(length(cross(sub(p, origin), dir))).toBeLessThan(1e-9);
    }
  });

  it("zooms about the cursor: the point under it on the target plane stays put", () => {
    for (const projection of ["perspective", "orthographic"] as const) {
      const c: CameraState = { ...defaultCamera(), projection };
      const [x, y] = [610, 145];
      const { origin, dir } = cameraFrame(c, W, H).ray(x, y);
      const back = basis(c).back;
      const p = [0, 1, 2].map((k) => origin[k]! + dir[k]! * (dot(sub(c.target, origin), back) / dot(dir, back))) as Vec3;
      const z = zoomAt(c, x, y, W, H, 0.5);
      expect(z.distance).toBeCloseTo(c.distance * 0.5, 9);
      const s = cameraFrame(z, W, H).project(p)!;
      expect(s.x).toBeCloseTo(x, 6);
      expect(s.y).toBeCloseTo(y, 6);
    }
  });

  it("pans so the target plane follows the pointer", () => {
    for (const projection of ["perspective", "orthographic"] as const) {
      const c: CameraState = { ...defaultCamera(), projection };
      const a = cameraFrame(c, W, H).project(c.target)!;
      const b = cameraFrame(pan(c, 30, -12, H), W, H).project(c.target)!;
      expect(b.x - a.x).toBeCloseTo(30, 6);
      expect(b.y - a.y).toBeCloseTo(-12, 6);
    }
  });

  it("orbits turning the model right, clamps pitch at the poles and keeps yaw in (−π, π]", () => {
    let c = at("front");
    c = orbit(c, 10, 0);
    expect(cameraFrame(c, W, H).eye[0]).toBeLessThan(0);
    expect(orbit(c, 0, 1e6).pitch).toBe(Math.PI / 2);
    expect(orbit(c, 0, -1e6).pitch).toBe(-Math.PI / 2);
    for (let i = 0; i < 1000; i++) {
      c = orbit(c, 97, 0);
      expect(c.yaw > -Math.PI && c.yaw <= Math.PI).toBe(true);
    }
  });

  it("fits a sphere so it stays inside the view in both projections", () => {
    for (const projection of ["perspective", "orthographic"] as const) {
      for (const view of ["iso", "top", "front"] as const) {
        const c = fitSphere(at(view, projection), { center: [0, 0, 4], radius: Math.hypot(40, 25, 4) }, W / H);
        const f = cameraFrame(c, W, H);
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [0, 1]) {
          const q = f.project([40 * sx, 25 * sy, 8 * sz])!;
          expect(q.x >= 0 && q.x <= W && q.y >= 0 && q.y <= H, `${projection} ${view}`).toBe(true);
        }
      }
    }
  });

  it("looking along a direction inverts the basis (view cube edges and corners)", () => {
    for (const dir of [
      [1, -1, 1],
      [-1, 0, -1],
      [0, 1, 0.3],
      [0.2, -0.9, 0],
    ] as Vec3[]) {
      const [yaw, pitch] = anglesLookingAlong(dir);
      const f = cameraFrame({ ...defaultCamera(), yaw, pitch }, W, H);
      const u = dir.map((v) => v / length(dir)) as Vec3;
      expect(close(f.forward, u, 1e-12), `${dir}`).toBe(true);
    }
    // At the poles the current yaw is kept (no spin).
    expect(anglesLookingAlong([0, 0, -1], 0.7)).toEqual([0.7, Math.PI / 2]);
    // The iso corner direction is the iso view.
    const [y, p] = anglesLookingAlong([-1, 1, -1]);
    expect(standardViewOf({ yaw: y, pitch: p }, 1e-9)).toBe("iso");
  });

  it("recognises standard views and interpolates the short way round", () => {
    for (const v of STANDARD_VIEWS) expect(standardViewOf(at(v))).toBe(v);
    expect(standardViewOf(orbit(at("front"), 5, 0))).toBeNull();
    const a = { ...defaultCamera(), yaw: 3.0 };
    const b = { ...defaultCamera(), yaw: -3.0 };
    const mid = lerpCamera(a, b, 0.5);
    // Across ±π, not through 0.
    expect(Math.abs(Math.abs(mid.yaw) - Math.PI)).toBeLessThan(0.3);
    expect(lerpCamera(a, b, 1).yaw).toBeCloseTo(3.0 + (2 * Math.PI - 6.0), 9);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
  });
});
