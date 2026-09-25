//! The ruled helicoid (screw surface): the flank of a modelled screw thread.

use super::SurfaceDerivs;
use crate::geom::error::GeomError;
use crate::linalg::{Frame, Point3, Transform, Vec3};
use crate::math;
use crate::scalar::{Interval, Scalar};

/// Newton iterations of [`Helicoid::project`] per candidate sheet.
const PROJECT_NEWTON_STEPS: usize = 40;

/// Sub-intervals [`Helicoid::line_hits`] may examine before giving up.
pub const LINE_HITS_BUDGET: usize = 200_000;

/// A crossing of a line with a helicoid patch (see [`Helicoid::line_hits`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HelicoidLineHit {
    /// Line parameter.
    pub t: f64,
    /// Surface parameters of the crossing (`u` unwrapped on its sheet).
    pub u: f64,
    /// Distance from the axis.
    pub v: f64,
    /// `false` for a certified transversal crossing (the line changes side); `true` when
    /// the crossing could not be isolated as transversal at the resolution limit (a
    /// tangency, or two crossings closer than it).
    pub tangent: bool,
}

/// [`Helicoid::line_hits`] could not certify the crossings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HelicoidLineHitsError {
    /// The patch's `v` window reaches the axis (`v ≤ 0`), where the crossing function is
    /// not smooth.
    PatchAtAxis,
    /// More than [`LINE_HITS_BUDGET`] sub-intervals were needed.
    Budget,
}

/// A ruled helicoid: `S(u, v) = o + v·e_r(u) + (p·u + k·v)·z` in `frame`, with
/// `e_r(u) = cos u·x + sin u·y`.
///
/// The straight line `z = k·ρ` of the meridian half-plane `u = 0` swept by the screw motion
/// that turns by `u` about `z` while advancing `p·u` along it. A thread flank of flank angle
/// `α` is a helicoid of slope `k = ±tan α` (the right helicoid, `k = 0`, is the flank of a
/// square thread).
///
/// # Parametrization
/// - `u`: the angle about `frame.z` from `frame.x` (radians). **Not periodic**: a face
///   winds as many turns as the thread; the sheet `u + 2π` lies one lead `2π·p` higher.
/// - `v`: the distance from the axis (mm). Faces use `v > 0`.
/// - `rise` `p = dz/du` (mm per radian, the lead is `2π·p`), non-zero; `p > 0` in a
///   right-handed frame is a **right-hand** thread.
/// - `slope` `k = dz/dv` along a ruling.
///
/// # Normal
/// `S_u × S_v = v·k·e_r(u) + p·e_u(u) − v·z` (`e_u = −sin u·x + cos u·y`): never zero
/// since `p ≠ 0`, so the surface has no singular points (the axis `v = 0` included).
/// Its `z` component `−v` is negative for `v > 0`: the parametric normal points to the side
/// of smaller `z` at a given `(u, v)` (towards the sheet below).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Helicoid {
    frame: Frame,
    rise: f64,
    slope: f64,
}

impl Helicoid {
    /// A helicoid; `rise` must be finite and non-zero, `slope` finite.
    pub fn new(frame: Frame, rise: f64, slope: f64) -> Result<Self, GeomError> {
        if !(rise.is_finite() && rise != 0.0) {
            return Err(GeomError::InvalidParameter {
                what: "helicoid rise",
                value: rise,
                expected: "finite and ≠ 0",
            });
        }
        if !slope.is_finite() {
            return Err(GeomError::NonFinite {
                what: "helicoid slope",
            });
        }
        Ok(Self { frame, rise, slope })
    }
    /// Frame (axis = `z`).
    pub fn frame(&self) -> &Frame {
        &self.frame
    }
    /// `dz/du` (mm per radian).
    pub fn rise(&self) -> f64 {
        self.rise
    }
    /// The lead `2π·rise` (signed).
    pub fn lead(&self) -> f64 {
        math::TAU * self.rise
    }
    /// `dz/dv` along a ruling.
    pub fn slope(&self) -> f64 {
        self.slope
    }
    /// Local height `p·u + k·v` of the point `(u, v)`.
    pub fn height<S: Scalar>(&self, u: S, v: S) -> S {
        S::from_f64(self.rise) * u + S::from_f64(self.slope) * v
    }
    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (s, c) = u.sin_cos();
        self.frame
            .eval_point(Vec3::new(v * c, v * s, self.height(u, v)))
    }
    /// Point and derivatives up to order 2.
    pub fn derivs2<S: Scalar>(&self, u: S, v: S) -> SurfaceDerivs<S> {
        let (s, c) = u.sin_cos();
        let z = S::zero();
        let p = S::from_f64(self.rise);
        let k = S::from_f64(self.slope);
        let f = &self.frame;
        SurfaceDerivs {
            p: f.eval_point(Vec3::new(v * c, v * s, self.height(u, v))),
            du: f.eval_vector(Vec3::new(-v * s, v * c, p)),
            dv: f.eval_vector(Vec3::new(c, s, k)),
            duu: f.eval_vector(Vec3::new(-v * c, -v * s, z)),
            duv: f.eval_vector(Vec3::new(-s, c, z)),
            dvv: Vec3::zero(),
        }
    }
    /// Unit normal `normalize(S_u × S_v)` (closed form, see the type docs).
    pub fn normal<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (s, c) = u.sin_cos();
        let p = S::from_f64(self.rise);
        let k = S::from_f64(self.slope);
        let vk = v * k;
        // v·k·e_r + p·e_u − v·z.
        let n = Vec3::new(vk * c - p * s, vk * s + p * c, -v);
        let len = n.norm();
        self.frame.eval_vector(n / len)
    }
    /// Closest point `(u, v, distance)`.
    ///
    /// The sheets through the meridian of `p` are one lead apart along the axis; the three
    /// nearest to `p` (by height at `p`'s radius) are searched by damped Newton on the
    /// squared distance from `(u, v) = (angle of p on that sheet, radius of p)`, and the
    /// closest result is returned (ties: the lower sheet). Exact for points within about
    /// half a lead of the surface, which covers every use on faces (edge and vertex checks,
    /// point location); `u` is the unwrapped angle of the sheet found.
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        let rho = math::hypot(l.x, l.y);
        let phi = if rho > 0.0 {
            math::atan2(l.y, l.x)
        } else {
            0.0
        };
        // Height of the sheet u = φ + 2πm at radius ρ: p·(φ + 2πm) + k·ρ.
        let base = self.rise * phi + self.slope * rho;
        let lead = self.lead();
        let m0 = ((l.z - base) / lead).round();
        let mut best = (0.0, 0.0, f64::INFINITY);
        for dm in [-1.0, 0.0, 1.0] {
            let u0 = phi + math::TAU * (m0 + dm);
            let (u, v, d) = self.newton_project(p, u0, rho);
            if d < best.2 {
                best = (u, v, d);
            }
        }
        best
    }

    /// Damped Newton on `½|S(u, v) − p|²` from `(u0, v0)`; returns the best iterate.
    fn newton_project(&self, p: Point3, u0: f64, v0: f64) -> (f64, f64, f64) {
        let (mut u, mut v) = (u0, v0);
        let mut best = (u, v, self.eval(u, v).distance(p));
        for _ in 0..PROJECT_NEWTON_STEPS {
            let d = self.derivs2(u, v);
            let e = d.p - p;
            let g = [e.dot(d.du), e.dot(d.dv)];
            let h = [
                [d.du.dot(d.du) + e.dot(d.duu), d.du.dot(d.dv) + e.dot(d.duv)],
                [d.du.dot(d.dv) + e.dot(d.duv), d.dv.dot(d.dv) + e.dot(d.dvv)],
            ];
            let det = h[0][0] * h[1][1] - h[0][1] * h[1][0];
            let (mut du, mut dv) = if det > 0.0 && h[0][0] > 0.0 {
                (
                    -(h[1][1] * g[0] - h[0][1] * g[1]) / det,
                    -(h[0][0] * g[1] - h[1][0] * g[0]) / det,
                )
            } else {
                // Gauss–Newton (first-order Hessian), always positive definite here.
                let a = d.du.dot(d.du);
                let b = d.du.dot(d.dv);
                let c = d.dv.dot(d.dv);
                let dt = a * c - b * b;
                (-(c * g[0] - b * g[1]) / dt, -(a * g[1] - b * g[0]) / dt)
            };
            // Damping: never jump more than half a turn or across the axis.
            let lim = math::FRAC_PI_2;
            if du.abs() > lim {
                let s = lim / du.abs();
                du *= s;
                dv *= s;
            }
            let (mut nu, mut nv) = (u + du, v + dv);
            let mut nd = self.eval(nu, nv).distance(p);
            let mut halvings = 0;
            while nd > best.2 && halvings < 30 {
                du *= 0.5;
                dv *= 0.5;
                nu = u + du;
                nv = v + dv;
                nd = self.eval(nu, nv).distance(p);
                halvings += 1;
            }
            if nd < best.2 {
                best = (nu, nv, nd);
            }
            if (nu.to_bits() == u.to_bits() && nv.to_bits() == v.to_bits()) || nd > best.2 {
                break;
            }
            u = nu;
            v = nv;
        }
        best
    }
    /// Every crossing of the line `o + t·d`, `t ∈ t_range`, with the patch
    /// `u ∈ u_range`, `v ∈ v_range` (`v_range.0 > 0`), in increasing `t`.
    ///
    /// # Method (certified)
    /// A point `(x, y, z)` (local) lies on the sheet through its meridian iff
    /// `F = x·sin w − y·cos w = 0` and `x·cos w + y·sin w > 0`, with
    /// `w = (z − k·ρ)/p`, `ρ = √(x² + y²)` (then `u = w`, `v = ρ`): no angle unwrapping, no
    /// branch cut. Along the line, `F(t)` is smooth where `ρ > 0`. Branch and bound over
    /// `t` with [`Interval`] enclosures: a piece is dropped when `ρ`, `w` or `F` miss the
    /// patch or zero; where `F'`'s enclosure excludes 0, `F` is monotone and the sign of
    /// its (point-interval) end values decides whether it holds exactly one root, found by
    /// bisection; other pieces are halved down to a relative width of `1e-13`, where a
    /// remaining candidate is reported with `tangent: true`. Hits are then filtered by the
    /// exact windows (padded by `1e-9` relative). Complete: no transversal crossing is
    /// missed, and every one is certified unique in its piece.
    pub fn line_hits(
        &self,
        o: Point3,
        d: Vec3,
        t_range: (f64, f64),
        u_range: (f64, f64),
        v_range: (f64, f64),
    ) -> Result<Vec<HelicoidLineHit>, HelicoidLineHitsError> {
        if v_range.0.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            return Err(HelicoidLineHitsError::PatchAtAxis);
        }
        let lo = self.frame.to_local_point(o);
        let ld = self.frame.to_local_vector(d);
        let (p, k) = (self.rise, self.slope);
        let pad = |r: (f64, f64)| {
            let e = 1e-9 * (1.0 + r.0.abs().max(r.1.abs()));
            (r.0 - e, r.1 + e)
        };
        let (uw, vw) = (pad(u_range), pad(v_range));
        let (t0, t1) = t_range;
        let min_width = 1e-13 * (1.0 + t0.abs().max(t1.abs()));
        let pt = Interval::point;
        // (x, y, ρ, w, F, C) over `t`.
        let eval = |t: Interval| {
            let x = pt(lo.x) + t * pt(ld.x);
            let y = pt(lo.y) + t * pt(ld.y);
            let z = pt(lo.z) + t * pt(ld.z);
            let rho = (x.square() + y.square()).sqrt();
            let w = (z - rho * pt(k)) / pt(p);
            let (sw, cw) = w.sin_cos();
            (x, y, rho, w, x * sw - y * cw, x * cw + y * sw)
        };
        let f64_f = |t: f64| -> f64 {
            let x = lo.x + t * ld.x;
            let y = lo.y + t * ld.y;
            let z = lo.z + t * ld.z;
            let rho = math::hypot(x, y);
            let w = (z - rho * k) / p;
            let (sw, cw) = math::sin_cos(w);
            x * sw - y * cw
        };
        let sign = |f: Interval| -> i32 {
            if f.lo() > 0.0 {
                1
            } else if f.hi() < 0.0 {
                -1
            } else {
                0
            }
        };
        let mut hits: Vec<HelicoidLineHit> = Vec::new();
        let mut push = |t: f64, tangent: bool| {
            let x = lo.x + t * ld.x;
            let y = lo.y + t * ld.y;
            let z = lo.z + t * ld.z;
            let rho = math::hypot(x, y);
            let w = (z - rho * k) / p;
            let (sw, cw) = math::sin_cos(w);
            if x * cw + y * sw <= 0.0 {
                return; // the opposite half of the meridian plane: not this surface
            }
            if w < uw.0 || w > uw.1 || rho < vw.0 || rho > vw.1 {
                return;
            }
            hits.push(HelicoidLineHit {
                t,
                u: w,
                v: rho,
                tangent,
            });
        };
        let mut stack = vec![(t0, t1)];
        let mut steps = 0usize;
        while let Some((a, b)) = stack.pop() {
            steps += 1;
            if steps > LINE_HITS_BUDGET {
                return Err(HelicoidLineHitsError::Budget);
            }
            let tt = Interval::new(a, b);
            let (x, y, rho, w, f, c) = eval(tt);
            if rho.hi() < vw.0 || rho.lo() > vw.1 {
                continue;
            }
            if w.hi() < uw.0 || w.lo() > uw.1 {
                continue;
            }
            if !f.contains_zero() || c.hi() < 0.0 {
                continue;
            }
            // F' = x'·sin w + x·cos w·w' − y'·cos w + y·sin w·w',
            // w' = (z' − k·ρ')/p, ρ' = (x·x' + y·y')/ρ.
            let fp = (rho.lo() > 0.0).then(|| {
                let (sw, cw) = w.sin_cos();
                let rp = (x * pt(ld.x) + y * pt(ld.y)) / rho;
                let wp = (pt(ld.z) - rp * pt(k)) / pt(p);
                pt(ld.x) * sw + x * cw * wp - pt(ld.y) * cw + y * sw * wp
            });
            if let Some(fp) = fp
                && !fp.contains_zero()
            {
                let sa = sign(eval(pt(a)).4);
                let sb = sign(eval(pt(b)).4);
                if sa != 0 && sb != 0 {
                    if sa != sb {
                        // Exactly one root: bisection to the last representable split.
                        let (mut l, mut h) = (a, b);
                        let neg_at_l = sa < 0;
                        for _ in 0..200 {
                            let m = 0.5 * (l + h);
                            if !(m > l && m < h) {
                                break;
                            }
                            if (f64_f(m) < 0.0) == neg_at_l {
                                l = m;
                            } else {
                                h = m;
                            }
                        }
                        push(0.5 * (l + h), false);
                    }
                    continue;
                }
                // A root at (or rounding-close to) an end: split further.
            }
            if b - a > min_width {
                let m = 0.5 * (a + b);
                if m > a && m < b {
                    // Upper half first so that the lower half is examined first.
                    stack.push((m, b));
                    stack.push((a, m));
                    continue;
                }
            }
            // Resolution limit: a tangency, or a crossing at a piece end.
            push(0.5 * (a + b), fp.is_none_or(|fp| fp.contains_zero()));
        }
        hits.sort_by(|x, y| x.t.total_cmp(&y.t));
        // A crossing found from both sides of a split point is one crossing.
        let mut out: Vec<HelicoidLineHit> = Vec::with_capacity(hits.len());
        for h in hits {
            match out.last_mut() {
                Some(last) if h.t - last.t <= 16.0 * min_width => {
                    last.tangent &= h.tangent;
                }
                _ => out.push(h),
            }
        }
        Ok(out)
    }

    /// A B-spline surface within `eps` (mm) of the helicoid over `u_range × v_range`, sharing
    /// its parametrization (`|B(u, v) − S(u, v)| ≤ eps`): degree 5 in `u`, 1 in `v`
    /// (`S` is linear in `v`). `S = o + v·E(u) + (p·u + k·v)·z` with `E(u) = (cos u, sin u)`
    /// approximated by quintic Hermite pieces within `eps / max|v|` (module `hermite`); the
    /// linear `p·u` is exact. For exchange formats without helicoids (STEP).
    pub fn to_nurbs(
        &self,
        u_range: (f64, f64),
        v_range: (f64, f64),
        eps: f64,
    ) -> Result<crate::geom::NurbsSurface, GeomError> {
        let vmax = v_range.0.abs().max(v_range.1.abs()).max(1e-300);
        // (cos, sin, u): the sixth derivative of (cos, sin) has norm 1, u is exact; √2 for
        // the component-wise Hermite bound.
        let breaks =
            crate::geom::hermite::hermite_breaks(u_range.0, u_range.1, math::sqrt(2.0), eps / vmax);
        let e = crate::geom::hermite::quintic_hermite::<3>(&breaks, |u| {
            let (s, c) = math::sin_cos(u);
            [[c, s, u], [-s, c, 1.0], [-c, -s, 0.0]]
        })?;
        let (v0, v1) = v_range;
        let mut pts = Vec::with_capacity(2 * e.control_points().len());
        for q in e.control_points() {
            for v in [v0, v1] {
                pts.push(self.frame.eval_point(Vec3::new(
                    v * q[0],
                    v * q[1],
                    self.rise * q[2] + self.slope * v,
                )));
            }
        }
        let n_u = e.control_points().len();
        Ok(crate::geom::NurbsSurface::new(
            5,
            1,
            e.knots().to_vec(),
            vec![v0, v0, v1, v1],
            n_u,
            2,
            pts,
            None,
        )?)
    }

    /// The surface moved by a rigid transform (parametrization preserved).
    pub fn transformed(&self, t: &Transform) -> Self {
        Self {
            frame: self.frame.transformed(t),
            ..*self
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tilted() -> Frame {
        Frame::from_normal_x(
            Vec3::new(1.0, 2.0, -1.0),
            Vec3::new(0.3, -0.2, 1.0),
            Vec3::new(1.0, 1.0, 0.0),
        )
        .expect("frame")
    }

    fn flank() -> Helicoid {
        // ISO flank: 30° half angle, pitch 1.25 mm.
        Helicoid::new(tilted(), 1.25 / math::TAU, -math::tan(math::PI / 6.0)).unwrap()
    }

    #[test]
    fn derivatives_match_finite_differences() {
        let h = flank();
        for &(u, v) in &[(0.0, 3.0), (7.3, 4.2), (-12.0, 3.4)] {
            let d = h.derivs2(u, v);
            let e = 1e-6;
            let fu = (h.eval(u + e, v) - h.eval(u - e, v)) * (0.5 / e);
            let fv = (h.eval(u, v + e) - h.eval(u, v - e)) * (0.5 / e);
            assert!(d.du.distance(fu) < 1e-8);
            assert!(d.dv.distance(fv) < 1e-8);
            let fuu = (h.derivs2(u + e, v).du - h.derivs2(u - e, v).du) * (0.5 / e);
            let fuv = (h.derivs2(u, v + e).du - h.derivs2(u, v - e).du) * (0.5 / e);
            assert!(d.duu.distance(fuu) < 1e-8);
            assert!(d.duv.distance(fuv) < 1e-8);
            let n = h.normal(u, v);
            let c = d.du.cross(d.dv).normalize().unwrap();
            assert!(n.distance(c) < 1e-14);
        }
    }

    #[test]
    fn normal_points_to_smaller_heights() {
        let h = Helicoid::new(Frame::world(), 0.2, 0.5).unwrap();
        for &(u, v) in &[(0.0, 1.0), (3.0, 2.0), (-5.0, 0.3)] {
            assert!(h.normal(u, v).z < 0.0);
        }
    }

    #[test]
    fn projection_recovers_parameters_across_many_turns() {
        let h = flank();
        for &(u, v) in &[(0.0, 3.0), (40.0, 3.6), (-25.0, 4.0), (1.0, 0.8)] {
            let p = h.eval(u, v);
            let (pu, pv, d) = h.project(p);
            assert!(d < 1e-12, "{d}");
            assert!(
                (pu - u).abs() < 1e-9 && (pv - v).abs() < 1e-9,
                "{u} {v}: {pu} {pv}"
            );
            // Off the surface along the normal.
            let q = p + h.normal(u, v) * 0.03;
            let (qu, qv, dq) = h.project(q);
            assert!((dq - 0.03).abs() < 1e-10, "{dq}");
            assert!((qu - u).abs() < 1e-8 && (qv - v).abs() < 1e-8);
        }
    }

    #[test]
    fn line_hits_find_every_sheet_crossed_by_a_ray() {
        let h = flank();
        // A ray parallel to the axis at radius 3.5 crosses one sheet per lead.
        let o = h.frame().to_world_point(Vec3::new(3.5, 0.0, -0.3));
        let d = h.frame().z();
        let hits = h
            .line_hits(o, d, (0.0, 10.0), (-100.0, 100.0), (3.0, 4.0))
            .unwrap();
        let lead = h.lead();
        // Sheets at local height k·3.5 + lead·m; the ray covers heights [−0.3, 9.7].
        let base = h.slope() * 3.5;
        let expected = (((9.7 - base) / lead).floor() - ((-0.3 - base) / lead).ceil()) as usize + 1;
        assert_eq!(hits.len(), expected, "{hits:?}");
        for w in hits.windows(2) {
            assert!((w[1].t - w[0].t - lead).abs() < 1e-9);
        }
        for x in &hits {
            assert!(!x.tangent);
            let p = o + d * x.t;
            assert!(h.eval(x.u, x.v).distance(p) < 1e-9);
        }
        // A generic oblique ray: every hit lies on the surface, and the crossings agree
        // with a dense sign scan of the height offset to the nearest sheet.
        let o = h.frame().to_world_point(Vec3::new(-6.0, 2.5, -1.0));
        let d = h.frame().to_world_vector(Vec3::new(1.0, 0.1, 0.35));
        let hits = h
            .line_hits(o, d, (0.0, 14.0), (-100.0, 100.0), (3.0, 4.5))
            .unwrap();
        for x in &hits {
            let p = o + d * x.t;
            assert!(h.eval(x.u, x.v).distance(p) < 1e-9, "{x:?}");
            assert!(x.v >= 3.0 - 1e-9 && x.v <= 4.5 + 1e-9);
        }
        let n = 200_000;
        let mut count = 0;
        let mut prev: Option<f64> = None;
        for i in 0..=n {
            let t = 14.0 * i as f64 / n as f64;
            let l = h.frame().to_local_point(o + d * t);
            let rho = math::hypot(l.x, l.y);
            if !(3.0..=4.5).contains(&rho) {
                prev = None;
                continue;
            }
            let phi = math::atan2(l.y, l.x);
            let off = l.z - h.rise() * phi - h.slope() * rho;
            let g = math::rem_euclid(off, h.lead());
            let g = if g > 0.5 * h.lead() { g - h.lead() } else { g };
            if let Some(q) = prev
                && (q < 0.0) != (g < 0.0)
                && (q - g).abs() < 0.5 * h.lead()
            {
                count += 1;
            }
            prev = Some(g);
        }
        assert_eq!(hits.len(), count);
        assert!(!hits.is_empty());
    }

    #[test]
    fn line_hits_respect_the_u_window() {
        let h = flank();
        let o = h.frame().to_world_point(Vec3::new(3.5, 0.0, -50.0));
        let d = h.frame().z();
        let all = h
            .line_hits(o, d, (0.0, 100.0), (-1000.0, 1000.0), (3.0, 4.0))
            .unwrap();
        let some = h
            .line_hits(o, d, (0.0, 100.0), (0.0, 20.0), (3.0, 4.0))
            .unwrap();
        assert!(some.len() < all.len());
        assert!(some.iter().all(|x| x.u >= -1e-9 && x.u <= 20.0 + 1e-9));
        assert_eq!(some.len(), 4, "{some:?}"); // sheets u = 0, 2π, 4π, 6π
    }

    #[test]
    fn to_nurbs_stays_within_the_bound_on_its_own_parametrization() {
        let eps = 1e-7;
        let h = flank();
        let (u, v) = ((-2.0, 5.0 * math::TAU + 1.0), (3.2, 4.0));
        let n = h.to_nurbs(u, v, eps).expect("nurbs");
        assert_eq!(n.domain(), (u, v));
        let mut worst: f64 = 0.0;
        for i in 0..=2000 {
            let uu = u.0 + (u.1 - u.0) * f64::from(i) / 2000.0;
            for j in 0..=4 {
                let vv = v.0 + (v.1 - v.0) * f64::from(j) / 4.0;
                worst = worst.max(n.eval(uu, vv).distance(h.eval(uu, vv)));
            }
        }
        assert!(worst <= eps && worst > eps * 1e-3, "{worst:e}");
    }

    #[test]
    fn rejects_a_zero_rise() {
        assert!(Helicoid::new(Frame::world(), 0.0, 0.3).is_err());
        assert!(Helicoid::new(Frame::world(), 0.1, f64::NAN).is_err());
    }
}
