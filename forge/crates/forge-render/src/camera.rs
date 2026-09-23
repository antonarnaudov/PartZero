//! Turntable CAD camera (Z up): orbit, pan, zoom-to-cursor, fit, standard views, and
//! perspective / orthographic projections with **reverse-Z** depth.
//!
//! Pure `f64` math with no GPU dependency, so it is unit-tested natively. Transcendentals
//! go through `forge_core::math` (portable libm), so the same inputs give the same
//! matrices on every target.
//!
//! ## Conventions
//! - World: right-handed, **Z up**, millimetres.
//! - Orientation is `(yaw, pitch)`: the camera sits at
//!   `target + distance · back`, `back = (sin yaw · cos pitch, −cos yaw · cos pitch, sin pitch)`,
//!   with screen-right `right = (cos yaw, sin yaw, 0)` and screen-up `up = back × right`.
//!   `yaw = 0, pitch = 0` is the **front** view (looking along +Y at the XZ plane);
//!   `pitch = π/2` is **top** (screen-up = +Y); `yaw = π/2` is **right** (looking along −X).
//!   The basis is built directly from the angles, so the poles have no singularity.
//! - Pixels: origin at the top-left, x right, y down, in *physical* pixels.
//! - Depth: reverse-Z in `[0, 1]` — `1` at the near plane, `0` at infinity (perspective)
//!   or at the far plane (orthographic). Compare with `GreaterEqual`, clear to `0`.
//! - Orthographic scale follows the perspective one at the target: the visible
//!   half-height is `distance · tan(fov_y / 2)`, so toggling the projection keeps the
//!   model the same size at the target plane, and zoom (which scales `distance`) works
//!   identically in both.

use forge_core::math;
use glam::{DMat4, DVec2, DVec3, DVec4};

/// Projection kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Projection {
    /// Perspective with an infinite far plane.
    Perspective,
    /// Orthographic (parallel).
    Orthographic,
}

/// Named standard views.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StandardView {
    /// Isometric from (+X, −Y, +Z): front-right-top.
    Iso,
    /// Looking down −Z; screen-up is +Y.
    Top,
    /// Looking along +Y at the XZ plane; screen-up is +Z.
    Front,
    /// Looking along −X at the YZ plane; screen-up is +Z.
    Right,
    /// Looking up +Z; screen-up is −Y.
    Bottom,
    /// Looking along −Y; screen-up is +Z.
    Back,
    /// Looking along +X; screen-up is +Z.
    Left,
}

impl StandardView {
    /// `(yaw, pitch)` in radians.
    pub fn angles(self) -> (f64, f64) {
        use math::{FRAC_PI_2, FRAC_PI_4, PI};
        match self {
            // pitch = atan(1/√2): the direction (1, −1, 1) / √3.
            StandardView::Iso => (FRAC_PI_4, math::atan(1.0 / math::sqrt(2.0))),
            StandardView::Top => (0.0, FRAC_PI_2),
            StandardView::Front => (0.0, 0.0),
            StandardView::Right => (FRAC_PI_2, 0.0),
            StandardView::Bottom => (0.0, -FRAC_PI_2),
            StandardView::Back => (PI, 0.0),
            StandardView::Left => (-FRAC_PI_2, 0.0),
        }
    }

    /// Parse `iso | top | front | right | bottom | back | left`.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "iso" | "isometric" => StandardView::Iso,
            "top" => StandardView::Top,
            "front" => StandardView::Front,
            "right" => StandardView::Right,
            "bottom" => StandardView::Bottom,
            "back" => StandardView::Back,
            "left" => StandardView::Left,
            _ => return None,
        })
    }
}

/// A bounding sphere (for fitting and near/far planes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sphere {
    /// Centre (mm).
    pub center: DVec3,
    /// Radius (mm), > 0.
    pub radius: f64,
}

impl Sphere {
    /// The sphere around an axis-aligned box (radius at least `min_radius`).
    pub fn from_box(min: DVec3, max: DVec3, min_radius: f64) -> Self {
        let center = (min + max) * 0.5;
        let radius = ((max - min) * 0.5).length().max(min_radius);
        Sphere { center, radius }
    }
}

/// Everything the renderer needs from the camera for one frame.
#[derive(Clone, Copy, Debug)]
pub struct CameraFrame {
    /// World → view.
    pub view: DMat4,
    /// View → clip (reverse-Z).
    pub proj: DMat4,
    /// World → clip.
    pub view_proj: DMat4,
    /// Clip → world.
    pub inv_view_proj: DMat4,
    /// Eye position (perspective) or a point on the camera plane (orthographic).
    pub eye: DVec3,
    /// Viewing direction (from the camera into the scene), unit.
    pub forward: DVec3,
    /// Screen-right, unit.
    pub right: DVec3,
    /// Screen-up, unit.
    pub up: DVec3,
    /// World size of one pixel: at unit distance from the eye (perspective), or
    /// everywhere (orthographic).
    pub px_scale: f64,
    /// Near plane distance (perspective clip-space `w` of the near plane).
    pub near: f64,
    /// Far plane distance (orthographic only; `f64::INFINITY` for perspective).
    pub far: f64,
    /// Perspective?
    pub perspective: bool,
    /// Viewport size in pixels.
    pub size: DVec2,
}

impl CameraFrame {
    /// Project a world point to `(x_px, y_px, depth)`; `None` behind the eye.
    pub fn project(&self, p: DVec3) -> Option<DVec3> {
        let c = self.view_proj * DVec4::new(p.x, p.y, p.z, 1.0);
        if c.w <= 0.0 {
            return None;
        }
        let ndc = c.truncate() / c.w;
        Some(DVec3::new(
            (ndc.x + 1.0) * 0.5 * self.size.x,
            (1.0 - ndc.y) * 0.5 * self.size.y,
            ndc.z,
        ))
    }

    /// World point of pixel `(x_px, y_px)` at reverse-Z depth `depth`.
    pub fn unproject(&self, x_px: f64, y_px: f64, depth: f64) -> DVec3 {
        let ndc = pixel_to_ndc(x_px, y_px, self.size);
        let c = self.inv_view_proj * DVec4::new(ndc.x, ndc.y, depth, 1.0);
        c.truncate() / c.w
    }
}

/// Pixel coordinates (top-left origin, y down) → NDC (y up).
pub fn pixel_to_ndc(x_px: f64, y_px: f64, size: DVec2) -> DVec2 {
    DVec2::new(2.0 * x_px / size.x - 1.0, 1.0 - 2.0 * y_px / size.y)
}

/// Radians of orbit per (CSS) pixel of pointer motion.
pub const ORBIT_RAD_PER_PX: f64 = 0.008;
/// Smallest and largest camera distance (mm).
pub const DISTANCE_RANGE: (f64, f64) = (1e-3, 1e7);
/// Margin applied by [`Camera::fit`] (1 = touching the sphere).
pub const FIT_MARGIN: f64 = 1.08;

/// The turntable camera (see the module docs).
#[derive(Clone, Debug, PartialEq)]
pub struct Camera {
    /// Orbit / zoom centre.
    pub target: DVec3,
    /// Distance from the target to the eye (mm).
    pub distance: f64,
    /// Rotation about +Z (radians).
    pub yaw: f64,
    /// Elevation above the XY plane (radians, clamped to `[−π/2, π/2]`).
    pub pitch: f64,
    /// Vertical field of view (radians), also sets the orthographic scale.
    pub fov_y: f64,
    /// Projection kind.
    pub projection: Projection,
    /// Scene bounds used for the near/far planes.
    pub scene: Sphere,
}

impl Default for Camera {
    fn default() -> Self {
        let (yaw, pitch) = StandardView::Iso.angles();
        let mut c = Camera {
            target: DVec3::ZERO,
            distance: 200.0,
            yaw,
            pitch,
            fov_y: math::deg_to_rad(35.0),
            projection: Projection::Perspective,
            scene: Sphere {
                center: DVec3::ZERO,
                radius: 50.0,
            },
        };
        c.fit(c.scene, 1.0);
        c
    }
}

impl Camera {
    /// `(right, up, back)`: the orthonormal camera basis.
    pub fn basis(&self) -> (DVec3, DVec3, DVec3) {
        let (sy, cy) = math::sin_cos(self.yaw);
        let (sp, cp) = math::sin_cos(self.pitch);
        let right = DVec3::new(cy, sy, 0.0);
        let back = DVec3::new(sy * cp, -cy * cp, sp);
        let up = back.cross(right);
        (right, up, back)
    }

    /// Eye position.
    pub fn eye(&self) -> DVec3 {
        let (_, _, back) = self.basis();
        self.target + back * self.distance
    }

    /// Half the visible height at the target plane (mm).
    pub fn half_height_at_target(&self) -> f64 {
        self.distance * math::tan(self.fov_y * 0.5)
    }

    /// World size of one pixel at the target plane.
    pub fn world_per_px(&self, height_px: f64) -> f64 {
        2.0 * self.half_height_at_target() / height_px.max(1.0)
    }

    /// Matrices and derived values for a `width × height` pixel viewport.
    pub fn frame(&self, width_px: f64, height_px: f64) -> CameraFrame {
        let w = width_px.max(1.0);
        let h = height_px.max(1.0);
        let aspect = w / h;
        let (right, up, back) = self.basis();
        let eye = self.target + back * self.distance;
        let view = DMat4::from_cols(
            DVec4::new(right.x, up.x, back.x, 0.0),
            DVec4::new(right.y, up.y, back.y, 0.0),
            DVec4::new(right.z, up.z, back.z, 0.0),
            DVec4::new(-right.dot(eye), -up.dot(eye), -back.dot(eye), 1.0),
        );
        // Signed distance of the scene centre in front of the eye.
        let s = (eye - self.scene.center).dot(back);
        let r = self.scene.radius * 1.05 + 1e-3;
        let tan_half = math::tan(self.fov_y * 0.5);
        let (proj, near, far, px_scale, perspective) = match self.projection {
            Projection::Perspective => {
                let near = (s - r).max(self.distance * 1e-3).max(1e-5);
                (
                    perspective_reverse_z(tan_half, aspect, near),
                    near,
                    f64::INFINITY,
                    2.0 * tan_half / h,
                    true,
                )
            }
            Projection::Orthographic => {
                let hh = self.distance * tan_half;
                let hw = hh * aspect;
                let near = s - r;
                let far = (s + r).max(near + 1e-3);
                (
                    orthographic_reverse_z(hw, hh, near, far),
                    near,
                    far,
                    2.0 * hh / h,
                    false,
                )
            }
        };
        let view_proj = proj * view;
        CameraFrame {
            view,
            proj,
            view_proj,
            inv_view_proj: view_proj.inverse(),
            eye,
            forward: -back,
            right,
            up,
            px_scale,
            near,
            far,
            perspective,
            size: DVec2::new(w, h),
        }
    }

    /// The pick ray through pixel `(x_px, y_px)`: `(origin, unit direction)`.
    pub fn ray(&self, x_px: f64, y_px: f64, width_px: f64, height_px: f64) -> (DVec3, DVec3) {
        let size = DVec2::new(width_px.max(1.0), height_px.max(1.0));
        let ndc = pixel_to_ndc(x_px, y_px, size);
        let (right, up, back) = self.basis();
        let hh = self.half_height_at_target();
        let hw = hh * size.x / size.y;
        let eye = self.target + back * self.distance;
        match self.projection {
            Projection::Perspective => {
                let d = -back * self.distance + right * (ndc.x * hw) + up * (ndc.y * hh);
                (eye, d.normalize())
            }
            Projection::Orthographic => (eye + right * (ndc.x * hw) + up * (ndc.y * hh), -back),
        }
    }

    /// Turntable orbit by a pointer motion of `(dx, dy)` CSS pixels: dragging right
    /// turns the model right, dragging down tilts its top towards the viewer.
    pub fn orbit(&mut self, dx_css: f64, dy_css: f64) {
        use math::{FRAC_PI_2, PI, TAU};
        self.yaw -= dx_css * ORBIT_RAD_PER_PX;
        // Keep yaw in (−π, π] so it never loses precision.
        if self.yaw > PI {
            self.yaw -= TAU;
        } else if self.yaw <= -PI {
            self.yaw += TAU;
        }
        self.pitch = (self.pitch + dy_css * ORBIT_RAD_PER_PX).clamp(-FRAC_PI_2, FRAC_PI_2);
    }

    /// Pan by `(dx, dy)` physical pixels: the scene follows the pointer at the target plane.
    pub fn pan(&mut self, dx_px: f64, dy_px: f64, height_px: f64) {
        let (right, up, _) = self.basis();
        let s = self.world_per_px(height_px);
        self.target += -right * (dx_px * s) + up * (dy_px * s);
    }

    /// Zoom by `factor` (< 1 zooms in) keeping the point under pixel `(x_px, y_px)` on the
    /// target plane fixed on screen. Works identically in both projections.
    pub fn zoom_at(&mut self, x_px: f64, y_px: f64, width_px: f64, height_px: f64, factor: f64) {
        if !(factor.is_finite() && factor > 0.0) {
            return;
        }
        let (lo, hi) = DISTANCE_RANGE;
        let factor = (self.distance * factor).clamp(lo, hi) / self.distance;
        let (origin, dir) = self.ray(x_px, y_px, width_px, height_px);
        let (_, _, back) = self.basis();
        let denom = dir.dot(back);
        let p = if denom.abs() > 1e-12 {
            origin + dir * ((self.target - origin).dot(back) / denom)
        } else {
            self.target
        };
        self.target = p + (self.target - p) * factor;
        self.distance *= factor;
    }

    /// Frame a bounding sphere for a viewport of aspect `width / height`, keeping the
    /// orientation.
    pub fn fit(&mut self, sphere: Sphere, aspect: f64) {
        self.scene = sphere;
        let half_v = self.fov_y * 0.5;
        let tan_v = math::tan(half_v);
        let half_h = math::atan(tan_v * aspect.max(1e-6));
        let half = half_v.min(half_h);
        let (lo, hi) = DISTANCE_RANGE;
        self.target = sphere.center;
        self.distance = (sphere.radius / math::sin(half) * FIT_MARGIN).clamp(lo, hi);
    }

    /// Switch to a standard view and fit the scene.
    pub fn set_view(&mut self, view: StandardView, aspect: f64) {
        let (yaw, pitch) = view.angles();
        self.yaw = yaw;
        self.pitch = pitch;
        self.fit(self.scene, aspect);
    }
}

/// Reverse-Z infinite perspective (right-handed view space, depth 1 at `near`, 0 at ∞).
fn perspective_reverse_z(tan_half_fov_y: f64, aspect: f64, near: f64) -> DMat4 {
    let f = 1.0 / tan_half_fov_y;
    DMat4::from_cols(
        DVec4::new(f / aspect, 0.0, 0.0, 0.0),
        DVec4::new(0.0, f, 0.0, 0.0),
        DVec4::new(0.0, 0.0, 0.0, -1.0),
        DVec4::new(0.0, 0.0, near, 0.0),
    )
}

/// Reverse-Z orthographic (depth 1 at `near`, 0 at `far`, both measured along −Z view).
fn orthographic_reverse_z(half_w: f64, half_h: f64, near: f64, far: f64) -> DMat4 {
    let k = 1.0 / (far - near);
    DMat4::from_cols(
        DVec4::new(1.0 / half_w, 0.0, 0.0, 0.0),
        DVec4::new(0.0, 1.0 / half_h, 0.0, 0.0),
        DVec4::new(0.0, 0.0, k, 0.0),
        DVec4::new(0.0, 0.0, far * k, 1.0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: f64 = 800.0;
    const H: f64 = 600.0;

    fn with(projection: Projection) -> Camera {
        Camera {
            projection,
            ..Camera::default()
        }
    }

    fn close(a: DVec3, b: DVec3, tol: f64) -> bool {
        (a - b).length() <= tol
    }

    #[test]
    fn basis_is_orthonormal_and_right_handed_everywhere() {
        let mut c = Camera::default();
        for i in 0..=20 {
            for j in 0..=12 {
                c.yaw = -3.1 + 0.31 * f64::from(i);
                c.pitch = -math::FRAC_PI_2 + math::PI * f64::from(j) / 12.0;
                let (r, u, b) = c.basis();
                for v in [r, u, b] {
                    assert!((v.length() - 1.0).abs() < 1e-12);
                }
                assert!(r.dot(u).abs() < 1e-12 && r.dot(b).abs() < 1e-12 && u.dot(b).abs() < 1e-12);
                // right × up = back (right-handed, looking along −back).
                assert!(close(r.cross(u), b, 1e-12));
            }
        }
    }

    #[test]
    fn standard_views_look_along_the_documented_axes() {
        let mut c = Camera::default();
        let cases = [
            (StandardView::Front, DVec3::Y, DVec3::X, DVec3::Z),
            (StandardView::Top, -DVec3::Z, DVec3::X, DVec3::Y),
            (StandardView::Right, -DVec3::X, DVec3::Y, DVec3::Z),
            (StandardView::Bottom, DVec3::Z, DVec3::X, -DVec3::Y),
            (StandardView::Back, -DVec3::Y, -DVec3::X, DVec3::Z),
            (StandardView::Left, DVec3::X, -DVec3::Y, DVec3::Z),
        ];
        for (view, forward, right, up) in cases {
            c.set_view(view, W / H);
            let f = c.frame(W, H);
            assert!(
                close(f.forward, forward, 1e-12),
                "{view:?} forward {:?}",
                f.forward
            );
            assert!(close(f.right, right, 1e-12), "{view:?} right {:?}", f.right);
            assert!(close(f.up, up, 1e-12), "{view:?} up {:?}", f.up);
        }
        c.set_view(StandardView::Iso, W / H);
        let f = c.frame(W, H);
        assert!(close(
            f.forward,
            DVec3::new(-1.0, 1.0, -1.0).normalize(),
            1e-12
        ));
    }

    #[test]
    fn view_matrix_maps_eye_to_origin_and_target_down_negative_z() {
        let mut c = Camera {
            target: DVec3::new(10.0, -5.0, 3.0),
            distance: 120.0,
            ..Camera::default()
        };
        c.orbit(37.0, -11.0);
        let f = c.frame(W, H);
        let e = f.view.transform_point3(f.eye);
        assert!(e.length() < 1e-9);
        let t = f.view.transform_point3(c.target);
        assert!(close(t, DVec3::new(0.0, 0.0, -120.0), 1e-9));
    }

    #[test]
    fn target_projects_to_viewport_centre_in_both_projections() {
        for projection in [Projection::Perspective, Projection::Orthographic] {
            let c = Camera {
                target: DVec3::new(3.0, 4.0, 5.0),
                ..with(projection)
            };
            let f = c.frame(W, H);
            let p = f.project(c.target).expect("in front");
            assert!((p.x - W / 2.0).abs() < 1e-9 && (p.y - H / 2.0).abs() < 1e-9);
            assert!(p.z > 0.0 && p.z < 1.0, "{projection:?} depth {}", p.z);
        }
    }

    #[test]
    fn reverse_z_puts_near_at_one_and_far_towards_zero() {
        let c = Camera::default();
        let f = c.frame(W, H);
        let near_pt = f.eye + f.forward * f.near;
        assert!((f.project(near_pt).expect("front").z - 1.0).abs() < 1e-9);
        let a = f.project(f.eye + f.forward * 100.0).expect("front").z;
        let b = f.project(f.eye + f.forward * 1000.0).expect("front").z;
        assert!(a > b && b > 0.0);

        let o = with(Projection::Orthographic);
        let f = o.frame(W, H);
        let near_pt = f.eye + f.forward * f.near;
        let far_pt = f.eye + f.forward * f.far;
        assert!((f.project(near_pt).expect("front").z - 1.0).abs() < 1e-9);
        assert!(f.project(far_pt).expect("front").z.abs() < 1e-9);
    }

    #[test]
    fn unproject_inverts_project() {
        for projection in [Projection::Perspective, Projection::Orthographic] {
            let c = with(projection);
            let f = c.frame(W, H);
            let p = DVec3::new(12.0, -7.0, 20.0);
            let s = f.project(p).expect("front");
            let q = f.unproject(s.x, s.y, s.z);
            assert!(close(p, q, 1e-6), "{projection:?}: {q:?}");
        }
    }

    #[test]
    fn scene_is_inside_near_far_after_fit() {
        for projection in [Projection::Perspective, Projection::Orthographic] {
            for view in [StandardView::Iso, StandardView::Top, StandardView::Front] {
                let mut c = with(projection);
                let s = Sphere::from_box(
                    DVec3::new(-40.0, -25.0, 0.0),
                    DVec3::new(40.0, 25.0, 8.0),
                    1.0,
                );
                c.fit(s, W / H);
                c.set_view(view, W / H);
                let f = c.frame(W, H);
                for sx in [-1.0, 1.0] {
                    for sy in [-1.0, 1.0] {
                        for sz in [0.0, 1.0] {
                            let p = DVec3::new(40.0 * sx, 25.0 * sy, 8.0 * sz);
                            let q = f.project(p).expect("front");
                            assert!(
                                q.z > 0.0 && q.z <= 1.0,
                                "{projection:?} {view:?} depth {}",
                                q.z
                            );
                            assert!(
                                q.x >= 0.0 && q.x <= W && q.y >= 0.0 && q.y <= H,
                                "{projection:?} {view:?} {q:?}"
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn zoom_at_keeps_the_point_under_the_cursor_fixed() {
        for projection in [Projection::Perspective, Projection::Orthographic] {
            let mut c = with(projection);
            let (x, y) = (610.0, 145.0);
            let (o, d) = c.ray(x, y, W, H);
            let (_, _, back) = c.basis();
            let p = o + d * ((c.target - o).dot(back) / d.dot(back));
            let before = c.distance;
            c.zoom_at(x, y, W, H, 0.5);
            assert!((c.distance - before * 0.5).abs() < 1e-9);
            let s = c.frame(W, H).project(p).expect("front");
            assert!(
                (s.x - x).abs() < 1e-6 && (s.y - y).abs() < 1e-6,
                "{projection:?} {s:?}"
            );
        }
    }

    #[test]
    fn pan_moves_the_target_plane_with_the_pointer() {
        for projection in [Projection::Perspective, Projection::Orthographic] {
            let mut c = with(projection);
            let p = c.target;
            let a = c.frame(W, H).project(p).expect("front");
            c.pan(30.0, -12.0, H);
            let b = c.frame(W, H).project(p).expect("front");
            assert!(
                (b.x - a.x - 30.0).abs() < 1e-6 && (b.y - a.y + 12.0).abs() < 1e-6,
                "{projection:?} {a:?} {b:?}"
            );
        }
    }

    #[test]
    fn orbit_turns_right_and_clamps_at_the_poles() {
        let mut c = Camera::default();
        c.set_view(StandardView::Front, W / H);
        c.orbit(10.0, 0.0);
        // Camera moved towards −X: the model turns right.
        assert!(c.eye().x < 0.0);
        c.orbit(0.0, 1e6);
        assert_eq!(c.pitch.to_bits(), math::FRAC_PI_2.to_bits());
        c.orbit(0.0, -1e6);
        assert_eq!(c.pitch.to_bits(), (-math::FRAC_PI_2).to_bits());
        for _ in 0..1000 {
            c.orbit(97.0, 0.0);
            assert!(c.yaw > -math::PI && c.yaw <= math::PI);
        }
    }

    #[test]
    fn projection_toggle_keeps_the_target_plane_scale() {
        let mut c = Camera::default();
        let probe = c.target + c.basis().0 * 10.0;
        let a = c.frame(W, H).project(probe).expect("front");
        c.projection = Projection::Orthographic;
        let b = c.frame(W, H).project(probe).expect("front");
        assert!((a.x - b.x).abs() < 1e-6 && (a.y - b.y).abs() < 1e-6);
    }

    #[test]
    fn camera_math_is_deterministic() {
        let run = || {
            let mut c = Camera::default();
            c.orbit(13.0, 7.0);
            c.zoom_at(100.0, 200.0, W, H, 0.9);
            c.pan(5.0, 5.0, H);
            let f = c.frame(W, H);
            f.view_proj.to_cols_array().map(f64::to_bits)
        };
        assert_eq!(run(), run());
    }
}
