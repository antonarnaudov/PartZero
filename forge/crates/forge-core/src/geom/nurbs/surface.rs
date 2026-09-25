//! NURBS surfaces.

use super::basis::{
    basis_funs, binomial, ders_basis_funs, find_span, multiplicity, validate_knots,
};
use super::curve::insert_knot_once;
use crate::geom::error::NurbsError;
use crate::linalg::{Point3, Transform, Vec3};
use crate::scalar::Scalar;

/// A (possibly rational) tensor-product B-spline surface.
///
/// # Definition
/// `S(u, v) = Σ_i Σ_j N_{i,p}(u) N_{j,q}(v) w_ij P_ij / Σ_i Σ_j N_{i,p}(u) N_{j,q}(v) w_ij`
/// over the domain `[knots_u[p], knots_u[n_u]] × [knots_v[q], knots_v[n_v]]`.
///
/// Control points are stored **row-major with `u` as the row index**: `P_ij` is at
/// `i * n_v + j` (`i` along `u`, `j` along `v`). Validity rules per direction are those of
/// [`super::NurbsCurve`]. The surface normal is `normalize(S_u × S_v)`.
#[derive(Clone, Debug, PartialEq)]
pub struct NurbsSurface {
    degree_u: usize,
    degree_v: usize,
    knots_u: Vec<f64>,
    knots_v: Vec<f64>,
    n_u: usize,
    n_v: usize,
    ctrl: Vec<Point3>,
    weights: Option<Vec<f64>>,
}

/// Partial derivatives `S_{k,l} = ∂^{k+l} S / ∂u^k ∂v^l` for `k + l <= order`, indexed
/// `[k][l]`.
pub type SurfaceDerivTable<S> = Vec<Vec<Vec3<S>>>;

fn wrap_dir(direction: &'static str) -> impl Fn(NurbsError) -> NurbsError {
    move |e| NurbsError::Direction {
        direction,
        inner: Box::new(e),
    }
}

impl NurbsSurface {
    /// Build and validate a surface. `control_points` is row-major (`i * n_v + j`).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        degree_u: usize,
        degree_v: usize,
        knots_u: Vec<f64>,
        knots_v: Vec<f64>,
        n_u: usize,
        n_v: usize,
        control_points: Vec<Point3>,
        weights: Option<Vec<f64>>,
    ) -> Result<Self, NurbsError> {
        validate_knots(&knots_u, degree_u, n_u).map_err(wrap_dir("u"))?;
        validate_knots(&knots_v, degree_v, n_v).map_err(wrap_dir("v"))?;
        if control_points.len() != n_u * n_v {
            return Err(NurbsError::NetSizeMismatch {
                expected: n_u * n_v,
                got: control_points.len(),
            });
        }
        if control_points.iter().any(|p| !p.is_finite()) {
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
            degree_u,
            degree_v,
            knots_u,
            knots_v,
            n_u,
            n_v,
            ctrl: control_points,
            weights,
        })
    }

    /// Degrees `(p, q)`.
    pub fn degrees(&self) -> (usize, usize) {
        (self.degree_u, self.degree_v)
    }
    /// Knot vector in `u`.
    pub fn knots_u(&self) -> &[f64] {
        &self.knots_u
    }
    /// Knot vector in `v`.
    pub fn knots_v(&self) -> &[f64] {
        &self.knots_v
    }
    /// Control net size `(n_u, n_v)`.
    pub fn net_size(&self) -> (usize, usize) {
        (self.n_u, self.n_v)
    }
    /// Control points, row-major (`i * n_v + j`).
    pub fn control_points(&self) -> &[Point3] {
        &self.ctrl
    }
    /// Weights, `None` for a polynomial surface.
    pub fn weights(&self) -> Option<&[f64]> {
        self.weights.as_deref()
    }
    /// `true` if the surface has weights.
    pub fn is_rational(&self) -> bool {
        self.weights.is_some()
    }
    /// Control point `P_ij`.
    pub fn control_point(&self, i: usize, j: usize) -> Point3 {
        self.ctrl[i * self.n_v + j]
    }
    /// Weight `w_ij` (1 for polynomial surfaces).
    pub fn weight(&self, i: usize, j: usize) -> f64 {
        self.weights.as_ref().map_or(1.0, |w| w[i * self.n_v + j])
    }
    /// Parameter domain `((u0, u1), (v0, v1))`.
    pub fn domain(&self) -> ((f64, f64), (f64, f64)) {
        (
            (self.knots_u[self.degree_u], self.knots_u[self.n_u]),
            (self.knots_v[self.degree_v], self.knots_v[self.n_v]),
        )
    }

    /// Point at `(u, v)`.
    pub fn eval<S: Scalar>(&self, u: S, v: S) -> Vec3<S> {
        let (p, q) = (self.degree_u, self.degree_v);
        let su = find_span(&self.knots_u, p, self.n_u, u.to_f64());
        let sv = find_span(&self.knots_v, q, self.n_v, v.to_f64());
        let nu = basis_funs(&self.knots_u, su, u, p);
        let nv = basis_funs(&self.knots_v, sv, v, q);
        let mut a = Vec3::<S>::zero();
        let mut w = S::zero();
        for (r, &nr) in nu.iter().enumerate() {
            for (s, &ns) in nv.iter().enumerate() {
                let (i, j) = (su - p + r, sv - q + s);
                let c = nr * ns * S::from_f64(self.weight(i, j));
                a += self.control_point(i, j).lift::<S>() * c;
                w += c;
            }
        }
        if self.weights.is_some() { a / w } else { a }
    }

    /// All partial derivatives up to total order `d` (A3.6 in homogeneous coordinates,
    /// then A4.4 for the rational correction).
    pub fn derivs<S: Scalar>(&self, u: S, v: S, d: usize) -> SurfaceDerivTable<S> {
        let (p, q) = (self.degree_u, self.degree_v);
        let su = find_span(&self.knots_u, p, self.n_u, u.to_f64());
        let sv = find_span(&self.knots_v, q, self.n_v, v.to_f64());
        let nu = ders_basis_funs(&self.knots_u, su, u, p, d);
        let nv = ders_basis_funs(&self.knots_v, sv, v, q, d);
        let zero = Vec3::<S>::zero();
        let mut a = vec![vec![zero; d + 1]; d + 1];
        let mut w = vec![vec![S::zero(); d + 1]; d + 1];
        for k in 0..=d.min(p) {
            let mut temp = vec![(zero, S::zero()); q + 1];
            for (s, t) in temp.iter_mut().enumerate() {
                for (r, &nkr) in nu[k].iter().enumerate() {
                    let (i, j) = (su - p + r, sv - q + s);
                    let wij = S::from_f64(self.weight(i, j));
                    let c = nkr * wij;
                    t.0 += self.control_point(i, j).lift::<S>() * c;
                    t.1 += c;
                }
            }
            for l in 0..=(d - k).min(q) {
                for (s, t) in temp.iter().enumerate() {
                    a[k][l] += t.0 * nv[l][s];
                    w[k][l] += t.1 * nv[l][s];
                }
            }
        }
        if self.weights.is_none() {
            return a;
        }
        let mut skl = vec![vec![zero; d + 1]; d + 1];
        for k in 0..=d {
            for l in 0..=(d - k) {
                let mut val = a[k][l];
                for j in 1..=l {
                    val -= skl[k][l - j] * (S::from_f64(binomial(l, j)) * w[0][j]);
                }
                for i in 1..=k {
                    val -= skl[k - i][l] * (S::from_f64(binomial(k, i)) * w[i][0]);
                    let mut v2 = zero;
                    for j in 1..=l {
                        v2 += skl[k - i][l - j] * (S::from_f64(binomial(l, j)) * w[i][j]);
                    }
                    val -= v2 * S::from_f64(binomial(k, i));
                }
                skl[k][l] = val / w[0][0];
            }
        }
        skl
    }

    /// Insert the knot `value` `times` times in the `u` direction.
    pub fn insert_knot_u(&self, value: f64, times: usize) -> Result<Self, NurbsError> {
        self.insert_knot(value, times, true).map_err(wrap_dir("u"))
    }
    /// Insert the knot `value` `times` times in the `v` direction.
    pub fn insert_knot_v(&self, value: f64, times: usize) -> Result<Self, NurbsError> {
        self.insert_knot(value, times, false).map_err(wrap_dir("v"))
    }

    fn insert_knot(&self, value: f64, times: usize, in_u: bool) -> Result<Self, NurbsError> {
        let (knots, degree) = if in_u {
            (&self.knots_u, self.degree_u)
        } else {
            (&self.knots_v, self.degree_v)
        };
        let (n_along, n_across) = if in_u {
            (self.n_u, self.n_v)
        } else {
            (self.n_v, self.n_u)
        };
        let (a, b) = (knots[degree], knots[n_along]);
        if !(value > a && value < b) {
            return Err(NurbsError::KnotOutOfDomain {
                value,
                min: a,
                max: b,
            });
        }
        if multiplicity(knots, value) + times > degree {
            return Err(NurbsError::InsertionExceedsDegree {
                value,
                times,
                max: degree,
            });
        }
        // Homogeneous point of the net at (along, across).
        let hom = |along: usize, across: usize| -> Vec<f64> {
            let (i, j) = if in_u {
                (along, across)
            } else {
                (across, along)
            };
            let w = self.weight(i, j);
            let p = self.control_point(i, j);
            vec![p.x * w, p.y * w, p.z * w, w]
        };
        let mut new_knots = knots.clone();
        let mut lines: Vec<Vec<Vec<f64>>> = (0..n_across)
            .map(|c| (0..n_along).map(|a| hom(a, c)).collect())
            .collect();
        for _ in 0..times {
            let mut next_knots = Vec::new();
            for line in lines.iter_mut() {
                let (k2, q) = insert_knot_once(&new_knots, degree, line, value);
                *line = q;
                next_knots = k2;
            }
            new_knots = next_knots;
        }
        let new_along = n_along + times;
        let (n_u, n_v) = if in_u {
            (new_along, self.n_v)
        } else {
            (self.n_u, new_along)
        };
        let mut ctrl = vec![Vec3::zero(); n_u * n_v];
        let mut weights = vec![0.0; n_u * n_v];
        for (c, line) in lines.iter().enumerate() {
            for (a, h) in line.iter().enumerate() {
                let (i, j) = if in_u { (a, c) } else { (c, a) };
                ctrl[i * n_v + j] = Vec3::new(h[0] / h[3], h[1] / h[3], h[2] / h[3]);
                weights[i * n_v + j] = h[3];
            }
        }
        let (ku, kv) = if in_u {
            (new_knots, self.knots_v.clone())
        } else {
            (self.knots_u.clone(), new_knots)
        };
        let weights = self.weights.as_ref().map(|_| weights);
        Self::new(
            self.degree_u,
            self.degree_v,
            ku,
            kv,
            n_u,
            n_v,
            ctrl,
            weights,
        )
    }

    /// Closest point `(u, v, distance)` over the whole domain.
    ///
    /// Method: sample every knot-span cell on a `(p + 3) × (q + 3)` grid, take every
    /// grid-local minimum of the distance as a seed, refine each with a damped Newton
    /// iteration on the gradient of the squared distance, and keep the best
    /// (ties → smaller `(u, v)`).
    pub fn project(&self, p: Point3) -> (f64, f64, f64) {
        let ((u0, u1), (v0, v1)) = self.domain();
        let us = sample_params(&self.knots_u, self.degree_u, self.n_u, self.degree_u + 3);
        let vs = sample_params(&self.knots_v, self.degree_v, self.n_v, self.degree_v + 3);
        let d2 = |u: f64, v: f64| self.eval(u, v).distance_squared(p);
        let grid: Vec<Vec<f64>> = us
            .iter()
            .map(|&u| vs.iter().map(|&v| d2(u, v)).collect())
            .collect();
        let mut best = (us[0], vs[0], grid[0][0]);
        for i in 0..us.len() {
            for j in 0..vs.len() {
                let g = grid[i][j];
                let is_min = (i.saturating_sub(1)..=(i + 1).min(us.len() - 1)).all(|a| {
                    (j.saturating_sub(1)..=(j + 1).min(vs.len() - 1)).all(|b| grid[a][b] >= g)
                });
                if !is_min {
                    continue;
                }
                let bu = (
                    if i == 0 { u0 } else { us[i - 1] },
                    if i + 1 == us.len() { u1 } else { us[i + 1] },
                );
                let bv = (
                    if j == 0 { v0 } else { vs[j - 1] },
                    if j + 1 == vs.len() { v1 } else { vs[j + 1] },
                );
                let (u, v, d) = self.newton_refine(p, (us[i], vs[j], g), bu, bv);
                if d < best.2 || (d <= best.2 && (u, v) < (best.0, best.1)) {
                    best = (u, v, d);
                }
            }
        }
        (best.0, best.1, best.2.sqrt())
    }

    /// The local foot of `p` from the parameters `near` (damped Newton within the domain):
    /// `(u, v, distance)`. A local search: a caller that walks along a curve on the surface
    /// passes the previous foot and falls back to [`Self::project`] when the distance is not
    /// small (Newton may stop at a local minimum of a far sheet).
    pub fn project_near(&self, p: Point3, near: (f64, f64)) -> (f64, f64, f64) {
        let ((u0, u1), (v0, v1)) = self.domain();
        let (u, v) = (near.0.clamp(u0, u1), near.1.clamp(v0, v1));
        let d = self.eval(u, v).distance_squared(p);
        let (u, v, d) = self.newton_refine(p, (u, v, d), (u0, u1), (v0, v1));
        (u, v, d.sqrt())
    }

    fn newton_refine(
        &self,
        p: Point3,
        start: (f64, f64, f64),
        bu: (f64, f64),
        bv: (f64, f64),
    ) -> (f64, f64, f64) {
        let (mut u, mut v, mut d) = start;
        for _ in 0..64 {
            let s = self.derivs(u, v, 2);
            let r = s[0][0] - p;
            let (su, sv) = (s[1][0], s[0][1]);
            let fu = su.dot(r);
            let fv = sv.dot(r);
            let a = su.dot(su) + s[2][0].dot(r);
            let b = su.dot(sv) + s[1][1].dot(r);
            let c = sv.dot(sv) + s[0][2].dot(r);
            let det = a * c - b * b;
            let (du, dv) = if a > 0.0 && det > 0.0 {
                ((-fu * c + fv * b) / det, (fu * b - fv * a) / det)
            } else {
                // Not locally convex: steepest descent with a bounded step.
                let g = (fu * fu + fv * fv).sqrt();
                if g == 0.0 {
                    break;
                }
                let h = 0.25 * (bu.1 - bu.0).max(bv.1 - bv.0);
                (-fu / g * h, -fv / g * h)
            };
            let mut un = (u + du).clamp(bu.0, bu.1);
            let mut vn = (v + dv).clamp(bv.0, bv.1);
            let mut dn = self.eval(un, vn).distance_squared(p);
            let mut halvings = 0;
            while dn > d && halvings < 40 {
                un = u + 0.5 * (un - u);
                vn = v + 0.5 * (vn - v);
                dn = self.eval(un, vn).distance_squared(p);
                halvings += 1;
            }
            if dn > d {
                break;
            }
            let converged = (un - u).abs() <= 4.0 * f64::EPSILON * (1.0 + u.abs())
                && (vn - v).abs() <= 4.0 * f64::EPSILON * (1.0 + v.abs());
            u = un;
            v = vn;
            d = dn;
            if converged {
                break;
            }
        }
        (u, v, d)
    }

    /// The surface moved by a rigid transform.
    pub fn transformed(&self, t: &Transform) -> Self {
        let mut s = self.clone();
        for c in &mut s.ctrl {
            *c = t.transform_point(*c);
        }
        s
    }
}

/// Increasing sample parameters: `per_span` samples per non-empty knot span plus the end.
fn sample_params(knots: &[f64], p: usize, n: usize, per_span: usize) -> Vec<f64> {
    let mut ts = Vec::new();
    for i in p..n {
        let (k0, k1) = (knots[i], knots[i + 1]);
        if k1 <= k0 {
            continue;
        }
        for s in 0..per_span {
            ts.push(k0 + (k1 - k0) * (s as f64 / per_span as f64));
        }
    }
    ts.push(knots[n]);
    ts
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bicubic-by-quadratic bumpy patch over [0, 1]².
    fn bumpy() -> NurbsSurface {
        let (nu, nv) = (5, 4);
        let mut pts = Vec::new();
        let mut w = Vec::new();
        for i in 0..nu {
            for j in 0..nv {
                let z = ((i * 7 + j * 3) % 5) as f64 * 0.3 - 0.5;
                pts.push(Vec3::new(i as f64, j as f64 * 1.3, z));
                w.push(1.0 + ((i + 2 * j) % 3) as f64 * 0.25);
            }
        }
        NurbsSurface::new(
            3,
            2,
            vec![0.0, 0.0, 0.0, 0.0, 0.4, 1.0, 1.0, 1.0, 1.0],
            vec![0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0],
            nu,
            nv,
            pts,
            Some(w),
        )
        .expect("valid surface")
    }

    #[test]
    fn corners_interpolate_control_points() {
        let s = bumpy();
        assert!(s.eval(0.0, 0.0).distance(s.control_point(0, 0)) < 1e-15);
        assert!(s.eval(1.0, 1.0).distance(s.control_point(4, 3)) < 1e-14);
    }

    #[test]
    fn knot_insertion_preserves_surface() {
        let s = bumpy();
        let s2 = s
            .insert_knot_u(0.7, 2)
            .expect("u")
            .insert_knot_v(0.25, 1)
            .expect("v");
        for i in 0..=6 {
            for j in 0..=6 {
                let (u, v) = (i as f64 / 6.0, j as f64 / 6.0);
                assert!(s.eval(u, v).distance(s2.eval(u, v)) < 1e-13);
            }
        }
        assert_eq!(
            s.insert_knot_v(0.5, 2).unwrap_err().code(),
            "NURBS_INSERTION_EXCEEDS_DEGREE"
        );
    }

    #[test]
    fn mixed_derivative_matches_finite_difference() {
        let s = bumpy();
        let (u, v, h) = (0.33, 0.61, 1e-5);
        let d = s.derivs(u, v, 2);
        let fd = (s.eval(u + h, v + h) - s.eval(u + h, v - h) - s.eval(u - h, v + h)
            + s.eval(u - h, v - h))
            * (1.0 / (4.0 * h * h));
        assert!((d[1][1] - fd).norm() < 1e-4 * (1.0 + fd.norm()));
    }

    #[test]
    fn net_size_mismatch_is_reported() {
        let e = NurbsSurface::new(
            1,
            1,
            vec![0.0, 0.0, 1.0, 1.0],
            vec![0.0, 0.0, 1.0, 1.0],
            2,
            2,
            vec![Vec3::zero(); 3],
            None,
        );
        assert_eq!(e.unwrap_err().code(), "NURBS_NET_SIZE_MISMATCH");
    }
}
