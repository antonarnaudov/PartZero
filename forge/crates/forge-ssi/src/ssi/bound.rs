//! Certified distance bounds of a (rational) Bézier curve to an analytic surface.
//!
//! # Why this works
//! For a Bézier segment `C(t) = N(t)/W(t)` of degree `n` (homogeneous control points
//! `(wᵢPᵢ, wᵢ)`, all `wᵢ > 0`) and a surface with algebraic form `q` of degree `k`, the
//! homogenized form `Q = W^k·q(N/W)` is a **polynomial** of degree `n·k` in `t`. Its
//! Bernstein coefficients are computed exactly up to outward rounding (interval
//! arithmetic on the coefficient formulas), and by the convex-hull property of the
//! Bernstein basis
//!
//! ```text
//! |q(C(t))| = |Q(t)| / W(t)^k <= max |Qᵢ| / (min wᵢ)^k      for all t in the segment.
//! ```
//!
//! The algebraic residual converts to the geometric distance through the exact
//! factorizations of the quadrics and the torus, e.g. for a sphere
//! `q = (|p−c| − r)(|p−c| + r)` so `|d| = |q|/(|p−c| + r) <= |q|/r`; the cone and torus
//! factors are bounded below over the segment's control-point bounding box (the curve
//! lies in the convex hull of its control points). If a bound is not small enough the
//! segment is split by de Casteljau and bounded again; the coefficients converge to the
//! function values quadratically, so a curve that is within `fit` of the surface is
//! certified after a few splits.
//!
//! This certifies the **3D curve against both surfaces** for every representation SSI
//! returns: lines (degree 1), circles and ellipses (converted to exact rational
//! quadratics), exact conic arcs and fitted quintic B-splines.

use forge_core::geom::{Curve3, NurbsCurve3, SpindlePatch, Surface};
use forge_core::math;
use forge_core::scalar::{Interval, Scalar};
use forge_core::{Frame, Vec3};

/// Bernstein polynomial on `[0, 1]` with interval coefficients, stored in the *scaled*
/// basis `Fᵢ = fᵢ·C(n, i)`: products are then plain convolutions
/// (`H_k = Σ Fᵢ G_{k−i}`) and degree elevation is a convolution with a binomial row, so
/// no division occurs until the final bound.
#[derive(Clone, Debug)]
struct Bern(Vec<Interval>);

/// `C(n, k)` for `n <= 64` (exact in `f64` for the degrees used here, `n <= 20`).
fn binom(n: usize, k: usize) -> f64 {
    let mut r: u64 = 1;
    for i in 0..k as u64 {
        r = r * (n as u64 - i) / (i + 1);
    }
    r as f64
}

impl Bern {
    /// From ordinary Bernstein coefficients.
    fn from_coeffs(c: Vec<Interval>) -> Self {
        let n = c.len() - 1;
        Bern(
            c.into_iter()
                .enumerate()
                .map(|(i, x)| x * Interval::point(binom(n, i)))
                .collect(),
        )
    }
    fn deg(&self) -> usize {
        self.0.len() - 1
    }
    fn mul(&self, o: &Bern) -> Bern {
        let (m, n) = (self.deg(), o.deg());
        let mut out = vec![Interval::point(0.0); m + n + 1];
        for i in 0..=m {
            for j in 0..=n {
                out[i + j] += self.0[i] * o.0[j];
            }
        }
        Bern(out)
    }
    fn elevate_to(&self, d: usize) -> Bern {
        let m = self.deg();
        if d <= m {
            return self.clone();
        }
        let r = d - m;
        let row: Vec<Interval> = (0..=r).map(|j| Interval::point(binom(r, j))).collect();
        self.mul(&Bern(row))
    }
    fn add(&self, o: &Bern) -> Bern {
        let d = self.deg().max(o.deg());
        let (a, b) = (self.elevate_to(d), o.elevate_to(d));
        Bern(a.0.iter().zip(&b.0).map(|(x, y)| *x + *y).collect())
    }
    fn sub(&self, o: &Bern) -> Bern {
        let d = self.deg().max(o.deg());
        let (a, b) = (self.elevate_to(d), o.elevate_to(d));
        Bern(a.0.iter().zip(&b.0).map(|(x, y)| *x - *y).collect())
    }
    fn scale(&self, s: Interval) -> Bern {
        Bern(self.0.iter().map(|x| *x * s).collect())
    }
    fn sq(&self) -> Bern {
        self.mul(self)
    }
    /// `max |fᵢ|` over the ordinary Bernstein coefficients (the convex-hull bound).
    fn max_abs(&self) -> f64 {
        let n = self.deg();
        self.0.iter().enumerate().fold(0.0f64, |m, (i, c)| {
            m.max((*c / Interval::point(binom(n, i))).mag())
        })
    }
}

/// A rational Bézier segment in homogeneous form: `(w·P, w)` control points.
#[derive(Clone, Debug)]
pub(crate) struct HomSeg {
    /// `(w·x, w·y, w·z, w)` per control point.
    pub pts: Vec<[f64; 4]>,
}

impl HomSeg {
    fn split(&self) -> (HomSeg, HomSeg) {
        // de Casteljau at 1/2 on homogeneous coordinates.
        let n = self.pts.len();
        let mut rows = vec![self.pts.clone()];
        for r in 1..n {
            let prev = &rows[r - 1];
            let next: Vec<[f64; 4]> = (0..n - r)
                .map(|i| core::array::from_fn(|c| 0.5 * prev[i][c] + 0.5 * prev[i + 1][c]))
                .collect();
            rows.push(next);
        }
        let left = (0..n).map(|r| rows[r][0]).collect();
        let right = (0..n).map(|r| rows[n - 1 - r][r]).collect();
        (HomSeg { pts: left }, HomSeg { pts: right })
    }
    fn min_weight(&self) -> f64 {
        self.pts.iter().fold(f64::INFINITY, |m, p| m.min(p[3]))
    }
}

/// Split a NURBS curve into its rational Bézier segments (knot insertion to full
/// multiplicity at every interior knot).
pub(crate) fn bezier_segments(c: &NurbsCurve3) -> Vec<HomSeg> {
    let p = c.degree();
    let mut cur = c.clone();
    let interior: Vec<f64> = {
        let (a, b) = cur.domain();
        let mut k: Vec<f64> = cur
            .knots()
            .iter()
            .copied()
            .filter(|&x| x > a && x < b)
            .collect();
        k.dedup();
        k
    };
    for u in interior {
        // Multiplicity is defined by exact knot equality.
        let mult = cur
            .knots()
            .iter()
            .filter(|&&x| crate::clip::same(x, u))
            .count();
        if mult < p
            && let Ok(n) = cur.insert_knot(u, p - mult)
        {
            cur = n;
        }
    }
    let ctrl = cur.control_points();
    let mut out = Vec::new();
    let mut i = 0;
    while i + p < ctrl.len() {
        let pts = (i..=i + p)
            .map(|j| {
                let w = cur.weight(j);
                [ctrl[j][0] * w, ctrl[j][1] * w, ctrl[j][2] * w, w]
            })
            .collect();
        out.push(HomSeg { pts });
        i += p;
    }
    out
}

/// Homogeneous Bézier segments of an exact or fitted 3D curve over `[t0, t1]`.
pub(crate) fn curve_segments(c: &Curve3, t0: f64, t1: f64) -> Vec<HomSeg> {
    match c {
        Curve3::Line(l) => {
            let (a, b) = (l.eval(t0), l.eval(t1));
            vec![HomSeg {
                pts: vec![[a.x, a.y, a.z, 1.0], [b.x, b.y, b.z, 1.0]],
            }]
        }
        Curve3::Circle(ci) => ci
            .to_nurbs(t0, t1)
            .map(|n| bezier_segments(&n))
            .unwrap_or_default(),
        Curve3::Ellipse(e) => e
            .to_nurbs(t0, t1)
            .map(|n| bezier_segments(&n))
            .unwrap_or_default(),
        Curve3::BSpline(n) => bezier_segments(n),
    }
}

/// Local homogeneous Bernstein coordinates `(X, Y, Z, W)` of a segment in `frame`.
fn local_bern(seg: &HomSeg, frame: &Frame) -> [Bern; 4] {
    let o: Vec3<Interval> = frame.origin().lift();
    let axes: [Vec3<Interval>; 3] = [frame.x().lift(), frame.y().lift(), frame.z().lift()];
    let mut cols: [Vec<Interval>; 4] = Default::default();
    for p in &seg.pts {
        let w = Interval::point(p[3]);
        let hp = Vec3::new(
            Interval::point(p[0]),
            Interval::point(p[1]),
            Interval::point(p[2]),
        );
        let rel = hp - o * w;
        for (k, a) in axes.iter().enumerate() {
            cols[k].push(rel.dot(*a));
        }
        cols[3].push(w);
    }
    cols.map(Bern::from_coeffs)
}

/// Interval bounding box (local coordinates) of a segment's control points.
fn local_box(seg: &HomSeg, frame: &Frame) -> Vec3<Interval> {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in &seg.pts {
        let q = Vec3::new(p[0] / p[3], p[1] / p[3], p[2] / p[3]);
        let l = frame.to_local_point(q);
        for (k, v) in [l.x, l.y, l.z].into_iter().enumerate() {
            lo[k] = lo[k].min(v);
            hi[k] = hi[k].max(v);
        }
    }
    // Pad by the rounding of the division and the frame transform.
    let pad = |k: usize| 1e-12 * (1.0 + lo[k].abs().max(hi[k].abs()));
    Vec3::new(
        Interval::new(lo[0] - pad(0), hi[0] + pad(0)),
        Interval::new(lo[1] - pad(1), hi[1] + pad(1)),
        Interval::new(lo[2] - pad(2), hi[2] + pad(2)),
    )
}

/// A certified bound of `max_t dist(C(t), S)` over one segment, or `None` if the
/// denominators of the factorization cannot be bounded away from 0 on the segment
/// (the segment touches a singular point of the form: apex, axis, tube centre).
fn seg_bound(seg: &HomSeg, surf: &Surface) -> Option<f64> {
    let wmin = seg.min_weight();
    if wmin.is_nan() || wmin <= 0.0 {
        return None;
    }
    let w = Interval::point(wmin);
    match surf {
        Surface::Plane(p) => {
            let [_, _, z, _] = local_bern(seg, p.frame());
            Some((Interval::point(z.max_abs()) / w).hi())
        }
        Surface::Cylinder(c) => {
            let [x, y, _, wb] = local_bern(seg, c.frame());
            let r = c.radius();
            let q = x
                .sq()
                .add(&y.sq())
                .sub(&wb.sq().scale(Interval::point(r * r)));
            // |d| = |q| / (ρ + r), with ρ bounded below over the segment's hull.
            let b = local_box(seg, c.frame());
            let den = (b.x.square() + b.y.square()).sqrt().lo().max(0.0) + r;
            Some((Interval::point(q.max_abs()) / w.square() / Interval::point(den)).hi())
        }
        Surface::Sphere(s) => {
            let [x, y, z, wb] = local_bern(seg, s.frame());
            let r = s.radius();
            let q = x
                .sq()
                .add(&y.sq())
                .add(&z.sq())
                .sub(&wb.sq().scale(Interval::point(r * r)));
            // |d| = |q| / (|p − c| + r).
            let b = local_box(seg, s.frame());
            let den = (b.x.square() + b.y.square() + b.z.square())
                .sqrt()
                .lo()
                .max(0.0)
                + r;
            Some((Interval::point(q.max_abs()) / w.square() / Interval::point(den)).hi())
        }
        Surface::Cone(k) => {
            let [x, y, z, wb] = local_bern(seg, k.frame());
            let (sa, ca) = math::sin_cos(k.half_angle());
            let ta = Interval::point(sa) / Interval::point(ca);
            let rh = wb.scale(Interval::point(k.radius())).add(&z.scale(ta));
            let q = x.sq().add(&y.sq()).sub(&rh.sq());
            let b = local_box(seg, k.frame());
            let rho = (b.x.square() + b.y.square()).sqrt();
            let rhb = (Interval::point(k.radius()) + b.z * ta).abs();
            let den = rho + rhb;
            if den.lo().is_nan() || den.lo() <= 0.0 {
                return None;
            }
            Some(
                (Interval::point(q.max_abs()) / w.square() * Interval::point(ca)
                    / Interval::point(den.lo()))
                .hi(),
            )
        }
        Surface::Torus(t) => {
            let [x, y, z, wb] = local_bern(seg, t.frame());
            let (big, small) = (t.major(), t.minor());
            let s2 = x.sq().add(&y.sq());
            let q = s2
                .add(&z.sq())
                .add(&wb.sq().scale(Interval::point(big * big - small * small)))
                .sq()
                .sub(&wb.sq().mul(&s2).scale(Interval::point(4.0 * big * big)));
            // |q| = |s − r|·(s + r)·|F| with s the tube distance of the form's own
            // sheet and F the other sheet's factor (ρ ∓ R)² + z² − r².
            let b = local_box(seg, t.frame());
            let rho = (b.x.square() + b.y.square()).sqrt();
            let other_offset = if t.spindle_patch() == Some(SpindlePatch::Inner) {
                -big
            } else {
                big
            };
            let f = (rho + Interval::point(other_offset)).square() + b.z.square()
                - Interval::point(small * small);
            let fmin = if f.lo() > 0.0 {
                f.lo()
            } else if f.hi() < 0.0 {
                -f.hi()
            } else {
                return None;
            };
            // s + r with s the tube distance of the form's own sheet, bounded below.
            let own = if t.spindle_patch() == Some(SpindlePatch::Inner) {
                big
            } else {
                -big
            };
            let s = ((rho + Interval::point(own)).square() + b.z.square()).sqrt();
            let den = s.lo().max(0.0) + small;
            Some(
                (Interval::point(q.max_abs())
                    / w.square().square()
                    / Interval::point(den)
                    / Interval::point(fmin))
                .hi(),
            )
        }
        Surface::BSpline(_) => None,
    }
}

/// Outcome of [`certify_curve`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct CurveBound {
    /// Certified bound (mm) over the certified part.
    pub bound: f64,
    /// `true` if every part was certified; `false` if some tiny segments (at singular
    /// points of a surface form) were only checked by sampling.
    pub complete: bool,
}

/// Depth beyond which a segment whose bound already meets `limit` is not split further.
const TIGHTEN_DEPTH: u32 = 4;
/// Maximum split depth per input segment.
const MAX_DEPTH: u32 = 14;

/// Certify `max dist(C(t), S)` over a curve given as Bézier segments. Segments are split
/// while their bound exceeds the preferred `target`; below depth [`TIGHTEN_DEPTH`] a
/// segment whose bound already meets the contractual `limit` (`>= target`) is accepted.
/// (The Bernstein bound converges to the true maximum only quadratically, so insisting
/// on `target` for a segment whose true error is just below it would cost up to
/// `2^MAX_DEPTH` sub-segments.) Segments whose factor bounds fail (touching a surface
/// singularity) are sampled instead and reported as not certified.
///
/// A segment whose bound exceeds `limit` is also sampled: if a sample is farther than
/// `limit` from the surface the curve cannot be certified, and the function returns at
/// once with that witnessed distance (then a *lower* bound of the true maximum). Either
/// way `bound > limit` means the curve fails the contract.
pub(crate) fn certify_curve(
    segs: &[HomSeg],
    surf: &Surface,
    target: f64,
    limit: f64,
) -> CurveBound {
    let mut worst: f64 = 0.0;
    let mut complete = true;
    let mut stack: Vec<(HomSeg, u32)> = segs.iter().rev().map(|s| (s.clone(), 0)).collect();
    while let Some((seg, depth)) = stack.pop() {
        match seg_bound(&seg, surf) {
            Some(b)
                if b <= target || (b <= limit && depth >= TIGHTEN_DEPTH) || depth >= MAX_DEPTH =>
            {
                worst = worst.max(b);
            }
            Some(b) if b > limit && depth < MAX_DEPTH => {
                let witnessed = sampled_seg(&seg, surf);
                if witnessed > limit {
                    return CurveBound {
                        bound: witnessed,
                        complete,
                    };
                }
                let (l, r) = seg.split();
                stack.push((r, depth + 1));
                stack.push((l, depth + 1));
            }
            Some(_) | None if depth < MAX_DEPTH => {
                let (l, r) = seg.split();
                stack.push((r, depth + 1));
                stack.push((l, depth + 1));
            }
            _ => {
                complete = false;
                worst = worst.max(sampled_seg(&seg, surf));
            }
        }
    }
    CurveBound {
        bound: worst,
        complete,
    }
}

/// Max of `|d_S|` at 17 samples of a segment (fallback near singular points).
fn sampled_seg(seg: &HomSeg, surf: &Surface) -> f64 {
    let n = seg.pts.len() - 1;
    let mut worst: f64 = 0.0;
    for s in 0..=16 {
        let t = s as f64 / 16.0;
        let mut acc = [0.0; 4];
        for (i, p) in seg.pts.iter().enumerate() {
            let b = binom(n, i) * math::powi(t, i as i32) * math::powi(1.0 - t, (n - i) as i32);
            for c in 0..4 {
                acc[c] += b * p[c];
            }
        }
        let q = Vec3::new(acc[0] / acc[3], acc[1] / acc[3], acc[2] / acc[3]);
        let d = surf.distance_form(q).unwrap_or(f64::INFINITY).abs();
        worst = worst.max(d);
    }
    worst
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Circle3, Cone, Cylinder, Line3, Plane, Sphere, Torus};

    #[test]
    fn exact_circle_on_sphere_is_certified_at_rounding_level() {
        let s: Surface = Sphere::new(Frame::world(), 5.0).expect("s").into();
        let f = Frame::from_normal(Vec3::new(0.0, 0.0, 3.0), Vec3::unit_z()).expect("f");
        let c: Curve3 = Circle3::new(f, 4.0).expect("c").into();
        let b = certify_curve(&curve_segments(&c, 0.0, math::TAU), &s, 1e-9, 1e-9);
        assert!(b.complete && b.bound < 1e-12, "{b:?}");
    }

    #[test]
    fn offset_curve_bound_is_at_least_the_offset() {
        let s: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
        let f = Frame::from_normal(Vec3::new(0.0, 0.0, 1.0), Vec3::unit_z()).expect("f");
        let c: Curve3 = Circle3::new(f, 2.001).expect("c").into();
        let b = certify_curve(&curve_segments(&c, 0.0, math::TAU), &s, 1e-7, 1e-7);
        assert!(b.bound >= 1e-3 * 0.999 && b.bound < 2e-3, "{b:?}");
    }

    #[test]
    fn generator_line_on_cone_and_torus_parallel_are_certified() {
        let k = Cone::new(Frame::world(), 1.0, 0.5).expect("k");
        let ks: Surface = k.into();
        let p0 = ks.eval(0.3, 0.5);
        let p1 = ks.eval(0.3, 2.5);
        let l: Curve3 = Line3::through(p0, p1).expect("l").into();
        let b = certify_curve(&curve_segments(&l, 0.0, p0.distance(p1)), &ks, 1e-9, 1e-9);
        assert!(b.complete && b.bound < 1e-12, "{b:?}");

        let t: Surface = Torus::new(Frame::world(), 5.0, 1.0).expect("t").into();
        let f = Frame::from_normal(Vec3::new(0.0, 0.0, 1.0), Vec3::unit_z()).expect("f");
        let c: Curve3 = Circle3::new(f, 5.0).expect("c").into();
        let b = certify_curve(&curve_segments(&c, 0.0, math::TAU), &t, 1e-9, 1e-9);
        assert!(b.complete && b.bound < 1e-11, "{b:?}");
        let pl: Surface = Plane::new(f).into();
        let b = certify_curve(&curve_segments(&c, 0.0, math::TAU), &pl, 1e-9, 1e-9);
        assert!(b.bound < 1e-13, "{b:?}");
    }
}
