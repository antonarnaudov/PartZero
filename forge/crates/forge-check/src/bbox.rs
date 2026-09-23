//! Tight axis-aligned bounding box of the exact geometry (not enlarged by tolerances).
//!
//! A coordinate's extreme over a face is attained on the face boundary or at an interior
//! critical point of the coordinate function, where the surface normal is parallel to
//! that axis, or at a singular point of the surface. The box is therefore the union of:
//! - all vertices;
//! - every edge's analytic extremes (lines: end points; circles and ellipses:
//!   `t* = atan2(r_y·Y_i, r_x·X_i)` and `t* + π` when inside the edge range; B-splines:
//!   roots of `C'_i` bracketed on a fine grid and refined by bisection);
//! - per face, the analytic critical points of spheres and tori (normal ∥ axis) that
//!   lie inside the trimmed domain, and the singular points the face reaches (cone
//!   apex, sphere poles, spindle-torus axis points, horn-torus centre). Planes,
//!   cylinders and cones have no interior extremes besides the apex.

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::math;
use forge_core::topo::Body;

use crate::CheckError;
use crate::domain::{FaceDomain, contains, face_domain, singular_v, touches_singular};

/// Axis-aligned box accumulator.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Aabb {
    pub min: Point3,
    pub max: Point3,
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            min: Vec3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
            max: Vec3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY),
        }
    }
    pub fn add(&mut self, p: Point3) {
        self.min = self.min.min_components(p);
        self.max = self.max.max_components(p);
    }
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }
    pub fn center(&self) -> Point3 {
        (self.min + self.max) * 0.5
    }
}

fn axis(i: usize) -> Vec3 {
    match i {
        0 => Vec3::unit_x(),
        1 => Vec3::unit_y(),
        _ => Vec3::unit_z(),
    }
}

/// `true` if angle `t` lies in `[t0, t1]` modulo 2π.
fn in_range(t: f64, t0: f64, t1: f64) -> bool {
    let d = math::wrap_angle(t - t0, 0.0);
    d <= t1 - t0 + 1e-15 * (1.0 + t1.abs())
}

fn add_edge(b: &mut Aabb, curve: &Curve3, t0: f64, t1: f64) {
    b.add(curve.eval(t0));
    b.add(curve.eval(t1));
    let conic = |b: &mut Aabb, f: &Frame, rx: f64, ry: f64| {
        for i in 0..3 {
            let (xi, yi) = (f.x().dot(axis(i)), f.y().dot(axis(i)));
            if xi == 0.0 && yi == 0.0 {
                continue;
            }
            let t = math::atan2(ry * yi, rx * xi);
            for tt in [t, t + math::PI] {
                if in_range(tt, t0, t1) {
                    b.add(curve.eval(tt));
                }
            }
        }
    };
    match curve {
        Curve3::Line(_) => {}
        Curve3::Circle(c) => conic(b, c.frame(), c.radius(), c.radius()),
        Curve3::Ellipse(e) => conic(b, e.frame(), e.rx(), e.ry()),
        Curve3::BSpline(_) => {
            // Roots of each derivative component, bracketed on a fine grid.
            let n = 256;
            for i in 0..3 {
                let comp = |t: f64| curve.d1(t).dot(axis(i));
                let mut ta = t0;
                let mut fa = comp(ta);
                for k in 1..=n {
                    let tb = if k == n {
                        t1
                    } else {
                        t0 + (t1 - t0) * k as f64 / n as f64
                    };
                    let fb = comp(tb);
                    if (fa < 0.0) != (fb < 0.0) {
                        let (mut lo, mut hi, mut flo) = (ta, tb, fa);
                        for _ in 0..80 {
                            let mid = 0.5 * (lo + hi);
                            let fm = comp(mid);
                            if (fm < 0.0) == (flo < 0.0) {
                                lo = mid;
                                flo = fm;
                            } else {
                                hi = mid;
                            }
                        }
                        b.add(curve.eval(0.5 * (lo + hi)));
                    }
                    ta = tb;
                    fa = fb;
                }
            }
        }
    }
}

/// Interior critical points `(u, v)` of the coordinate functions of a sphere or torus
/// (where the normal is parallel to a world axis); `None` in the `v` slot stands for a
/// whole critical circle `v = ±π/2` (world axis parallel to the surface axis).
fn critical_uv(f: &Frame, torus: bool) -> Vec<(Option<f64>, f64)> {
    let mut out = Vec::new();
    for i in 0..3 {
        let e = axis(i);
        let (ex, ey, ez) = (e.dot(f.x()), e.dot(f.y()), e.dot(f.z()));
        let h = math::hypot(ex, ey);
        if h <= 1e-15 {
            out.push((None, math::FRAC_PI_2));
            out.push((None, -math::FRAC_PI_2));
            continue;
        }
        let u1 = math::atan2(ey, ex);
        if torus {
            let (va, vb) = (math::atan2(ez, h), math::atan2(ez, -h));
            out.extend([
                (Some(u1), va),
                (Some(u1), va + math::PI),
                (Some(u1 + math::PI), vb),
                (Some(u1 + math::PI), vb + math::PI),
            ]);
        } else {
            let va = math::atan2(ez, h);
            out.extend([(Some(u1), va), (Some(u1 + math::PI), -va)]);
        }
    }
    out
}

/// Candidate `v` representatives of `v` for the domain (periodic `v` → shift into the
/// face's lifted range).
fn v_candidates(dom: &FaceDomain<'_>, v: f64) -> Vec<f64> {
    match dom.surface.periodicity().1 {
        None => {
            // A spindle-torus patch is 2π-periodic as a formula but not as a domain:
            // bring the angle into the patch's representation, centred on its range.
            if let Surface::Torus(t) = dom.surface
                && let Some((v0, v1)) = t.spindle_v_range()
            {
                let mid = 0.5 * (v0 + v1);
                return vec![math::wrap_angle(v, mid - math::PI)];
            }
            vec![v]
        }
        Some(per) => {
            let (lo, hi) = if dom.is_loopless() {
                (0.0, per)
            } else {
                dom.v_extent()
            };
            let k0 = ((lo - v) / per).floor() as i64 - 1;
            let k1 = ((hi - v) / per).ceil() as i64 + 1;
            (k0..=k1).map(|k| v + k as f64 * per).collect()
        }
    }
}

fn add_face(b: &mut Aabb, dom: &FaceDomain<'_>) -> Result<(), CheckError> {
    let s = dom.surface;
    let frame = match s {
        Surface::Plane(_) | Surface::Cylinder(_) => None,
        Surface::Cone(_) => None,
        Surface::Sphere(sp) => Some((*sp.frame(), false)),
        Surface::Torus(t) => Some((*t.frame(), true)),
        Surface::BSpline(_) => {
            return Err(CheckError::Unsupported {
                what: "bounding box of B-spline faces",
            });
        }
    };
    // Singular points the face reaches.
    for vs in singular_v(s) {
        if touches_singular(dom, vs) {
            b.add(s.eval(0.0, vs));
        }
    }
    let Some((f, torus)) = frame else {
        return Ok(());
    };
    let (u_lo, u_hi) = if dom.is_loopless() {
        (0.0, math::TAU)
    } else {
        dom.u_extent()
    };
    for (u, v) in critical_uv(&f, torus) {
        let us: Vec<f64> = match u {
            Some(u) => vec![u],
            None => vec![0.5 * (u_lo + u_hi)],
        };
        for u in us {
            for vv in v_candidates(dom, v) {
                if contains(dom, u, vv) {
                    b.add(s.eval(u, vv));
                    break;
                }
            }
        }
    }
    Ok(())
}

/// The tight box of a body, and the per-face domains' consistency as a side effect.
pub(crate) fn body_box(body: &Body, gap_tol: f64) -> Result<Aabb, CheckError> {
    let mut b = Aabb::empty();
    for v in body.vertices().values() {
        b.add(v.point);
    }
    for e in body.edges().values() {
        add_edge(&mut b, &e.curve, e.t_range.0, e.t_range.1);
    }
    for f in body.faces().values() {
        let dom = face_domain(body, f, gap_tol)?;
        add_face(&mut b, &dom)?;
    }
    if b.is_empty() {
        return Err(CheckError::Empty);
    }
    Ok(b)
}
