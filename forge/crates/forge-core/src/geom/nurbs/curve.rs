//! NURBS curves in `D` dimensions.

use super::basis::{
    basis_funs, binomial, ders_basis_funs, find_span, multiplicity, validate_knots,
};
use crate::geom::error::NurbsError;
use crate::geom::quadrature;
use crate::linalg::{Point2, Point3, Transform, Vec2, Vec3};
use crate::scalar::Scalar;

/// A (possibly rational) B-spline curve in `D` dimensions.
///
/// # Definition
/// `C(t) = Σ N_{i,p}(t)·w_i·P_i / Σ N_{i,p}(t)·w_i` for `t` in the domain
/// `[knots[p], knots[n]]`, where `n` is the number of control points and `p` the degree.
/// Without weights the curve is polynomial (all `w_i = 1`).
///
/// # Validity (checked by [`NurbsCurve::new`])
/// degree ≥ 1; at least `p + 1` control points; `n + p + 1` non-decreasing finite knots;
/// non-empty domain; interior knots of multiplicity ≤ `p`, end knots ≤ `p + 1`; weights
/// (if any) finite and strictly positive.
///
/// Knot vectors need not be clamped, but all constructors in Forge produce clamped
/// curves. B-spline curves are never *periodic* in Forge's sense (see
/// [`crate::geom::Curve3::is_periodic`]); a closed B-spline simply has equal end points.
///
/// Evaluation is generic over [`Scalar`] in the parameter; the knot span is chosen from
/// `t.to_f64()`.
#[derive(Clone, Debug, PartialEq)]
pub struct NurbsCurve<const D: usize> {
    degree: usize,
    knots: Vec<f64>,
    ctrl: Vec<[f64; D]>,
    weights: Option<Vec<f64>>,
}

/// A 2D NURBS curve (sketch curves and pcurves in a face's `(u, v)` space).
pub type NurbsCurve2 = NurbsCurve<2>;
/// A 3D NURBS curve.
pub type NurbsCurve3 = NurbsCurve<3>;

#[inline]
fn add<S: Scalar, const D: usize>(a: [S; D], b: [S; D]) -> [S; D] {
    core::array::from_fn(|i| a[i] + b[i])
}
#[inline]
fn sub<S: Scalar, const D: usize>(a: [S; D], b: [S; D]) -> [S; D] {
    core::array::from_fn(|i| a[i] - b[i])
}
#[inline]
fn scale<S: Scalar, const D: usize>(a: [S; D], s: S) -> [S; D] {
    core::array::from_fn(|i| a[i] * s)
}
#[inline]
fn dot<const D: usize>(a: [f64; D], b: [f64; D]) -> f64 {
    (0..D).map(|i| a[i] * b[i]).sum()
}

impl<const D: usize> NurbsCurve<D> {
    /// Build and validate a curve. `weights = None` means a polynomial B-spline.
    pub fn new(
        degree: usize,
        knots: Vec<f64>,
        control_points: Vec<[f64; D]>,
        weights: Option<Vec<f64>>,
    ) -> Result<Self, NurbsError> {
        validate_knots(&knots, degree, control_points.len())?;
        if control_points.iter().flatten().any(|c| !c.is_finite()) {
            return Err(NurbsError::NonFinite {
                what: "control points",
            });
        }
        if let Some(w) = &weights {
            if w.len() != control_points.len() {
                return Err(NurbsError::WeightCountMismatch {
                    expected: control_points.len(),
                    got: w.len(),
                });
            }
            if let Some((index, &value)) = w
                .iter()
                .enumerate()
                .find(|(_, w)| !(w.is_finite() && **w > 0.0))
            {
                return Err(NurbsError::InvalidWeight { index, value });
            }
        }
        Ok(Self {
            degree,
            knots,
            ctrl: control_points,
            weights,
        })
    }

    /// Degree `p`.
    pub fn degree(&self) -> usize {
        self.degree
    }
    /// Knot vector.
    pub fn knots(&self) -> &[f64] {
        &self.knots
    }
    /// Control points.
    pub fn control_points(&self) -> &[[f64; D]] {
        &self.ctrl
    }
    /// Weights, `None` for a polynomial curve.
    pub fn weights(&self) -> Option<&[f64]> {
        self.weights.as_deref()
    }
    /// `true` if the curve has weights.
    pub fn is_rational(&self) -> bool {
        self.weights.is_some()
    }
    /// Weight of control point `i` (1 for polynomial curves).
    pub fn weight(&self, i: usize) -> f64 {
        self.weights.as_ref().map_or(1.0, |w| w[i])
    }
    /// Parameter domain `(knots[p], knots[n])`.
    pub fn domain(&self) -> (f64, f64) {
        (self.knots[self.degree], self.knots[self.ctrl.len()])
    }

    /// Point at `t` (clamped to the domain for the span search).
    pub fn eval_array<S: Scalar>(&self, t: S) -> [S; D] {
        let p = self.degree;
        let span = find_span(&self.knots, p, self.ctrl.len(), t.to_f64());
        let n = basis_funs(&self.knots, span, t, p);
        let mut a = [S::zero(); D];
        let mut w = S::zero();
        for (j, &nj) in n.iter().enumerate() {
            let i = span - p + j;
            let nw = nj * S::from_f64(self.weight(i));
            let pi: [S; D] = core::array::from_fn(|c| S::from_f64(self.ctrl[i][c]));
            a = add(a, scale(pi, nw));
            w += nw;
        }
        if self.weights.is_some() {
            scale(a, S::one() / w)
        } else {
            a
        }
    }

    /// Point at `t` by **de Boor's algorithm** (repeated convex combinations of the
    /// homogeneous control points `(w·P, w)` of the active span, then projection).
    ///
    /// Equivalent to [`NurbsCurve::eval_array`] (which sums Cox–de Boor basis functions)
    /// up to rounding; kept as an independent reference implementation and for callers
    /// that want the maximally stable convex-combination form.
    pub fn eval_de_boor(&self, t: f64) -> [f64; D] {
        let p = self.degree;
        let (a, b) = self.domain();
        let t = t.clamp(a, b);
        let k = find_span(&self.knots, p, self.ctrl.len(), t);
        let mut d: Vec<(Vec<f64>, f64)> = (0..=p)
            .map(|j| {
                let i = j + k - p;
                let w = self.weight(i);
                (self.ctrl[i].iter().map(|c| c * w).collect(), w)
            })
            .collect();
        for r in 1..=p {
            for j in (r..=p).rev() {
                let lo = self.knots[j + k - p];
                let hi = self.knots[j + 1 + k - r];
                let alpha = (t - lo) / (hi - lo);
                let (prev_p, prev_w) = d[j - 1].clone();
                let (cur_p, cur_w) = &mut d[j];
                for (c, pc) in cur_p.iter_mut().zip(&prev_p) {
                    *c = (1.0 - alpha) * pc + alpha * *c;
                }
                *cur_w = (1.0 - alpha) * prev_w + alpha * *cur_w;
            }
        }
        let (pw, w) = &d[p];
        core::array::from_fn(|c| pw[c] / w)
    }

    /// The point and derivatives `C^(k)(t)` for `k = 0..=n` (A3.2 + A4.2 for rational
    /// curves).
    pub fn derivs_array<S: Scalar>(&self, t: S, n: usize) -> Vec<[S; D]> {
        let p = self.degree;
        let span = find_span(&self.knots, p, self.ctrl.len(), t.to_f64());
        let nd = ders_basis_funs(&self.knots, span, t, p, n);
        let zero = [S::zero(); D];
        let mut a = vec![zero; n + 1]; // derivatives of Σ N w P
        let mut w = vec![S::zero(); n + 1]; // derivatives of Σ N w
        for k in 0..=n.min(p) {
            for (j, &nkj) in nd[k].iter().enumerate() {
                let i = span - p + j;
                let wi = S::from_f64(self.weight(i));
                let nw = nkj * wi;
                let pi: [S; D] = core::array::from_fn(|c| S::from_f64(self.ctrl[i][c]));
                a[k] = add(a[k], scale(pi, nw));
                w[k] += nw;
            }
        }
        if self.weights.is_none() {
            return a;
        }
        let mut ck = vec![zero; n + 1];
        for k in 0..=n {
            let mut v = a[k];
            for i in 1..=k {
                let c = S::from_f64(binomial(k, i)) * w[i];
                v = sub(v, scale(ck[k - i], c));
            }
            ck[k] = scale(v, S::one() / w[0]);
        }
        ck
    }

    /// Insert the knot `u` `times` times (Boehm's algorithm, applied in homogeneous
    /// coordinates). The curve's shape and parametrization are unchanged.
    ///
    /// Errors if `u` is not strictly inside the domain or the resulting multiplicity
    /// would exceed the degree.
    pub fn insert_knot(&self, u: f64, times: usize) -> Result<Self, NurbsError> {
        let (a, b) = self.domain();
        if !(u > a && u < b) {
            return Err(NurbsError::KnotOutOfDomain {
                value: u,
                min: a,
                max: b,
            });
        }
        let s = multiplicity(&self.knots, u);
        if s + times > self.degree {
            return Err(NurbsError::InsertionExceedsDegree {
                value: u,
                times,
                max: self.degree,
            });
        }
        let mut pw: Vec<Vec<f64>> = self
            .ctrl
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let w = self.weight(i);
                let mut v: Vec<f64> = c.iter().map(|x| x * w).collect();
                v.push(w);
                v
            })
            .collect();
        let mut knots = self.knots.clone();
        for _ in 0..times {
            let (k2, p2) = insert_knot_once(&knots, self.degree, &pw, u);
            knots = k2;
            pw = p2;
        }
        let ctrl: Vec<[f64; D]> = pw
            .iter()
            .map(|v| core::array::from_fn(|c| v[c] / v[D]))
            .collect();
        let weights = self
            .weights
            .as_ref()
            .map(|_| pw.iter().map(|v| v[D]).collect());
        Self::new(self.degree, knots, ctrl, weights)
    }

    /// `true` if the end points coincide within `tol`.
    pub fn is_closed(&self, tol: f64) -> bool {
        let (a, b) = self.domain();
        let pa: [f64; D] = self.eval_array(a);
        let pb: [f64; D] = self.eval_array(b);
        let d = sub(pa, pb);
        dot(d, d).sqrt() <= tol
    }

    /// Arc length between parameters `t0` and `t1` (order-insensitive), by composite
    /// Gauss–Legendre quadrature on each knot span.
    pub fn arc_length(&self, t0: f64, t1: f64) -> f64 {
        let (lo, hi) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
        let mut total = 0.0;
        let mut breaks: Vec<f64> = vec![lo];
        breaks.extend(self.knots.iter().copied().filter(|&k| k > lo && k < hi));
        breaks.push(hi);
        breaks.dedup_by(|x, y| *x <= *y);
        for w in breaks.windows(2) {
            total += quadrature::integrate(
                |t| {
                    let d = self.derivs_array(t, 1)[1];
                    dot(d, d).sqrt()
                },
                w[0],
                w[1],
                4,
            );
        }
        total
    }

    /// Closest point: `(t, distance)` over the whole domain.
    ///
    /// Method: dense sampling of every knot span (`2p + 3` samples each) to find all local
    /// minima of the distance, then a damped Newton iteration on
    /// `f(t) = C'(t)·(C(t) − P)` from each, keeping the best result (ties → smaller `t`).
    pub fn project_array(&self, p: [f64; D]) -> (f64, f64) {
        let (a, b) = self.domain();
        let per_span = 2 * self.degree + 3;
        let mut ts: Vec<f64> = Vec::new();
        for i in self.degree..self.ctrl.len() {
            let (k0, k1) = (self.knots[i], self.knots[i + 1]);
            if k1 <= k0 {
                continue;
            }
            for s in 0..per_span {
                let t = k0 + (k1 - k0) * (s as f64 / per_span as f64);
                if ts.last().is_none_or(|&l| t > l) {
                    ts.push(t);
                }
            }
        }
        ts.push(b);
        let d2 = |t: f64| {
            let c: [f64; D] = self.eval_array(t);
            let r = sub(c, p);
            dot(r, r)
        };
        let ds: Vec<f64> = ts.iter().map(|&t| d2(t)).collect();
        let mut best = (ts[0], ds[0]);
        for i in 0..ts.len() {
            let left_ok = i == 0 || ds[i] <= ds[i - 1];
            let right_ok = i + 1 == ts.len() || ds[i] <= ds[i + 1];
            if !(left_ok && right_ok) {
                continue;
            }
            let lo = if i == 0 { a } else { ts[i - 1] };
            let hi = if i + 1 == ts.len() { b } else { ts[i + 1] };
            let (t, d) = self.newton_refine(p, ts[i], ds[i], lo, hi);
            if d < best.1 || (d <= best.1 && t < best.0) {
                best = (t, d);
            }
        }
        (best.0, best.1.sqrt())
    }

    fn newton_refine(&self, p: [f64; D], t0: f64, d0: f64, lo: f64, hi: f64) -> (f64, f64) {
        let (mut t, mut d) = (t0, d0);
        for _ in 0..64 {
            let ders = self.derivs_array(t, 2);
            let r = sub(ders[0], p);
            let f = dot(ders[1], r);
            let fp = dot(ders[2], r) + dot(ders[1], ders[1]);
            let step = if fp > 0.0 {
                -f / fp
            } else {
                -f.signum() * 0.25 * (hi - lo)
            };
            let mut tn = (t + step).clamp(lo, hi);
            let mut dn = {
                let c: [f64; D] = self.eval_array(tn);
                let rr = sub(c, p);
                dot(rr, rr)
            };
            let mut halvings = 0;
            while dn > d && halvings < 40 {
                tn = t + 0.5 * (tn - t);
                let c: [f64; D] = self.eval_array(tn);
                let rr = sub(c, p);
                dn = dot(rr, rr);
                halvings += 1;
            }
            if dn > d {
                break;
            }
            let converged = (tn - t).abs() <= 4.0 * f64::EPSILON * (1.0 + t.abs());
            t = tn;
            d = dn;
            if converged {
                break;
            }
        }
        (t, d)
    }

    /// The same curve with its control points mapped by `f` (weights unchanged). Valid
    /// for affine maps, under which NURBS are invariant.
    pub fn map_control_points(&self, f: impl Fn([f64; D]) -> [f64; D]) -> Self {
        Self {
            degree: self.degree,
            knots: self.knots.clone(),
            ctrl: self.ctrl.iter().map(|&c| f(c)).collect(),
            weights: self.weights.clone(),
        }
    }
}

/// Insert `u` once into the homogeneous control polygon `pw` (Boehm).
pub(crate) fn insert_knot_once(
    knots: &[f64],
    p: usize,
    pw: &[Vec<f64>],
    u: f64,
) -> (Vec<f64>, Vec<Vec<f64>>) {
    let n_ctrl = pw.len();
    let k = find_span(knots, p, n_ctrl, u);
    let s = multiplicity(knots, u);
    let mut q: Vec<Vec<f64>> = Vec::with_capacity(n_ctrl + 1);
    for i in 0..=n_ctrl {
        if i + p <= k {
            q.push(pw[i].clone());
        } else if i + s > k {
            q.push(pw[i - 1].clone());
        } else {
            let alpha = (u - knots[i]) / (knots[i + p] - knots[i]);
            q.push(
                pw[i]
                    .iter()
                    .zip(&pw[i - 1])
                    .map(|(a, b)| alpha * a + (1.0 - alpha) * b)
                    .collect(),
            );
        }
    }
    let mut new_knots = Vec::with_capacity(knots.len() + 1);
    new_knots.extend_from_slice(&knots[..=k]);
    new_knots.push(u);
    new_knots.extend_from_slice(&knots[k + 1..]);
    (new_knots, q)
}

// ---- typed front-ends -------------------------------------------------------------

impl NurbsCurve<2> {
    /// Build from [`Point2`] control points.
    pub fn from_points(
        degree: usize,
        knots: Vec<f64>,
        points: &[Point2],
        weights: Option<Vec<f64>>,
    ) -> Result<Self, NurbsError> {
        Self::new(
            degree,
            knots,
            points.iter().map(|p| p.to_array()).collect(),
            weights,
        )
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec2<S> {
        let a = self.eval_array(t);
        Vec2::new(a[0], a[1])
    }
    /// Point, first and second derivative at `t`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec2<S>; 3] {
        let d = self.derivs_array(t, 2);
        core::array::from_fn(|k| Vec2::new(d[k][0], d[k][1]))
    }
    /// Closest point `(t, distance)`.
    pub fn project(&self, p: Point2) -> (f64, f64) {
        self.project_array(p.to_array())
    }
}

impl NurbsCurve<3> {
    /// Build from [`Point3`] control points.
    pub fn from_points(
        degree: usize,
        knots: Vec<f64>,
        points: &[Point3],
        weights: Option<Vec<f64>>,
    ) -> Result<Self, NurbsError> {
        Self::new(
            degree,
            knots,
            points.iter().map(|p| p.to_array()).collect(),
            weights,
        )
    }
    /// Point at `t`.
    pub fn eval<S: Scalar>(&self, t: S) -> Vec3<S> {
        let a = self.eval_array(t);
        Vec3::new(a[0], a[1], a[2])
    }
    /// Point, first and second derivative at `t`.
    pub fn derivs2<S: Scalar>(&self, t: S) -> [Vec3<S>; 3] {
        let d = self.derivs_array(t, 2);
        core::array::from_fn(|k| Vec3::new(d[k][0], d[k][1], d[k][2]))
    }
    /// Closest point `(t, distance)`.
    pub fn project(&self, p: Point3) -> (f64, f64) {
        self.project_array(p.to_array())
    }
    /// The curve moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        self.map_control_points(|c| t.transform_point(Vec3::from(c)).to_array())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_curve() -> NurbsCurve3 {
        NurbsCurve3::from_points(
            3,
            vec![0.0, 0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 1.0],
            &[
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 2.0, 0.0),
                Vec3::new(2.0, -1.0, 1.0),
                Vec3::new(3.0, 1.0, 0.5),
                Vec3::new(4.0, 0.0, 0.0),
            ],
            Some(vec![1.0, 0.5, 2.0, 1.0, 1.0]),
        )
        .expect("valid")
    }

    #[test]
    fn de_boor_matches_basis_function_evaluation() {
        let c = sample_curve();
        for i in 0..=40 {
            let t = i as f64 / 40.0;
            let a = Vec3::from(c.eval_de_boor(t));
            assert!(a.distance(c.eval(t)) < 1e-14, "t = {t}");
        }
    }

    #[test]
    fn clamped_curve_interpolates_end_points() {
        let c = sample_curve();
        assert!(c.eval(0.0).distance(Vec3::zero()) < 1e-15);
        assert!(c.eval(1.0).distance(Vec3::new(4.0, 0.0, 0.0)) < 1e-15);
    }

    #[test]
    fn knot_insertion_preserves_shape() {
        let c = sample_curve();
        let c2 = c
            .insert_knot(0.3, 2)
            .expect("insert")
            .insert_knot(0.5, 1)
            .expect("insert");
        assert_eq!(c2.control_points().len(), c.control_points().len() + 3);
        for i in 0..=20 {
            let t = i as f64 / 20.0;
            assert!(c.eval(t).distance(c2.eval(t)) < 1e-13, "t = {t}");
        }
        assert_eq!(
            c.insert_knot(0.5, 3).unwrap_err().code(),
            "NURBS_INSERTION_EXCEEDS_DEGREE"
        );
        assert_eq!(
            c.insert_knot(1.0, 1).unwrap_err().code(),
            "NURBS_KNOT_OUT_OF_DOMAIN"
        );
    }

    #[test]
    fn invalid_weights_are_rejected() {
        let e = NurbsCurve2::new(
            1,
            vec![0.0, 0.0, 1.0, 1.0],
            vec![[0.0, 0.0], [1.0, 0.0]],
            Some(vec![1.0, 0.0]),
        );
        assert_eq!(e.unwrap_err().code(), "NURBS_INVALID_WEIGHT");
    }

    #[test]
    fn projection_of_curve_points_round_trips() {
        let c = sample_curve();
        for i in 0..=10 {
            let t = i as f64 / 10.0;
            let (tp, d) = c.project(c.eval(t));
            assert!(d < 1e-9, "t = {t}: d = {d}");
            assert!(c.eval(tp).distance(c.eval(t)) < 1e-9);
        }
    }

    #[test]
    fn straight_line_arc_length() {
        let c = NurbsCurve3::from_points(
            1,
            vec![0.0, 0.0, 1.0, 1.0],
            &[Vec3::zero(), Vec3::new(3.0, 4.0, 0.0)],
            None,
        )
        .expect("valid");
        assert!((c.arc_length(0.0, 1.0) - 5.0).abs() < 1e-14);
    }
}
