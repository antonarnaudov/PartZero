//! Restricting a parametrized curve to the parameter boxes of one or two surfaces.
//!
//! The curve leaves a box where one of the box constraints `u − u0`, `u1 − u`, `v − v0`,
//! `v1 − v` changes sign along it (computed through the closed-form inverse
//! parametrization, [`uv_of`]). All sign changes are found with the certified root
//! finder, so no excursion out of (or into) a box is missed; the curve is split there and
//! each piece is classified inside/outside at its midpoint. Periodic directions covering a
//! whole period impose no constraint. Tangential touches of a box edge produce split
//! points with "inside" on both sides, which are merged again.

use forge_core::Vec3;
use forge_core::geom::{Curve3, Surface};
use forge_core::scalar::Scalar;

use crate::error::SsiError;
use crate::func::{Fn1, mid, uv_of};
use crate::roots1d::{RootOpts, find_roots};
use crate::types::UvBox;

/// A curve evaluable over any scalar type.
pub(crate) trait ParamCurve {
    fn point<S: Scalar>(&self, t: S) -> Vec3<S>;
    /// Parameters in `(a, b)` where the evaluation formula changes (B-spline knots).
    /// Interval evaluation is only valid on pieces between consecutive breaks.
    fn breaks(&self, _a: f64, _b: f64) -> Vec<f64> {
        Vec::new()
    }
}

impl ParamCurve for Curve3 {
    fn point<S: Scalar>(&self, t: S) -> Vec3<S> {
        self.eval(t)
    }
    fn breaks(&self, a: f64, b: f64) -> Vec<f64> {
        knot_breaks(self, a, b)
    }
}

/// Interior knots of a B-spline curve in `(a, b)` (empty for other curves). An
/// interval evaluation of a B-spline picks the knot span from the midpoint, so certified
/// computations must split their ranges here.
pub(crate) fn knot_breaks(c: &Curve3, a: f64, b: f64) -> Vec<f64> {
    match c {
        Curve3::BSpline(n) => {
            let mut k: Vec<f64> = n
                .knots()
                .iter()
                .copied()
                .filter(|&x| x > a && x < b)
                .collect();
            k.dedup();
            k
        }
        _ => Vec::new(),
    }
}

/// Exact equality of two parameters that were copied from the same value (split points,
/// range ends): bit-level, never a tolerance test.
#[inline]
pub(crate) fn same(a: f64, b: f64) -> bool {
    a.total_cmp(&b).is_eq()
}

/// Split `[a, b]` at `breaks` (sorted, inside).
pub(crate) fn split_range(a: f64, b: f64, breaks: &[f64]) -> Vec<(f64, f64)> {
    let mut out = Vec::with_capacity(breaks.len() + 1);
    let mut s = a;
    for &k in breaks {
        if k > s && k < b {
            out.push((s, k));
            s = k;
        }
    }
    out.push((s, b));
    out
}

/// One box constraint along a curve.
struct Constraint<'a, C: ParamCurve> {
    curve: &'a C,
    surf: &'a Surface,
    refs: (f64, f64),
    /// 0: u − bound, 1: bound − u, 2: v − bound, 3: bound − v.
    which: u8,
    bound: f64,
}

impl<C: ParamCurve> Fn1 for Constraint<'_, C> {
    fn eval<S: Scalar>(&self, t: S) -> S {
        let (u, v) = uv_of(self.surf, self.curve.point(t), self.refs.0, self.refs.1);
        let b = S::from_f64(self.bound);
        match self.which {
            0 => u - b,
            1 => b - u,
            2 => v - b,
            _ => b - v,
        }
    }
}

/// A surface with its parameter box.
#[derive(Clone, Copy)]
pub(crate) struct Patch<'a> {
    pub surf: &'a Surface,
    pub dom: UvBox,
}

impl Patch<'_> {
    /// Reference values for periodic parameters (the box centre).
    pub fn refs(&self) -> (f64, f64) {
        (mid(self.dom.u), mid(self.dom.v))
    }
    /// The active constraints `(which, bound)`.
    fn constraints(&self) -> Vec<(u8, f64)> {
        let mut out = Vec::with_capacity(4);
        if !self.dom.full_u(self.surf) {
            out.push((0, self.dom.u.0));
            out.push((1, self.dom.u.1));
        }
        if !self.dom.full_v(self.surf) {
            let ((_, _), (nv0, nv1)) = self.surf.domain();
            // The natural ends of a bounded non-periodic v (sphere poles, spindle-patch
            // ends) cannot be crossed: skip them.
            let natural = self.surf.periodicity().1.is_none();
            if !(natural && nv0.is_finite() && self.dom.v.0 <= nv0) {
                out.push((2, self.dom.v.0));
            }
            if !(natural && nv1.is_finite() && self.dom.v.1 >= nv1) {
                out.push((3, self.dom.v.1));
            }
        }
        out
    }
    /// `true` if the curve point at `t` is inside the box (slack in parameter units).
    pub fn contains_point<C: ParamCurve>(&self, c: &C, t: f64, slack: f64) -> bool {
        let (ur, vr) = self.refs();
        let (u, v) = uv_of(self.surf, c.point(t), ur, vr);
        self.dom
            .contains(self.surf, forge_core::Point2::new(u, v), [slack, slack])
    }
}

/// The sub-ranges of `[t0, t1]` on which the curve lies inside every patch's box.
///
/// If `closed` (a periodic carrier with `t1 − t0` = its period) and the result wraps,
/// the last and first pieces are joined (the joined piece then ends beyond `t1`).
/// Returns `(pieces, whole)` where `whole` is true when no constraint ever becomes
/// active (the entire range is inside).
pub(crate) fn clip_to_patches<C: ParamCurve>(
    curve: &C,
    t0: f64,
    t1: f64,
    patches: &[Patch<'_>],
    closed: bool,
) -> Result<(Vec<(f64, f64)>, bool), SsiError> {
    let width = t1 - t0;
    let opts = RootOpts {
        zero_tol: 0.0,
        min_width: 1e-13 * width.abs().max(1e-300),
        flat_width: 0.05 * width.abs(),
        max_pieces: 200_000,
    };
    let mut splits: Vec<f64> = Vec::new();
    let pieces_in = split_range(t0, t1, &curve.breaks(t0, t1));
    for p in patches {
        for (which, bound) in p.constraints() {
            let f = Constraint {
                curve,
                surf: p.surf,
                refs: p.refs(),
                which,
                bound,
            };
            for &(a, b) in &pieces_in {
                let r = find_roots(&f, a, b, &opts)?;
                for root in &r.roots {
                    splits.push(root.t);
                }
                for &(fa, fb) in &r.flats {
                    splits.push(fa);
                    splits.push(fb);
                }
            }
        }
    }
    splits.retain(|&s| s > t0 && s < t1);
    splits.sort_by(f64::total_cmp);
    splits.dedup();
    let mut pts = Vec::with_capacity(splits.len() + 2);
    pts.push(t0);
    pts.extend(splits.iter().copied());
    pts.push(t1);
    // Inside test at piece midpoints with a slack of a few ulps of the parameters.
    let mut pieces: Vec<(f64, f64)> = Vec::new();
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b <= a {
            continue;
        }
        let m = 0.5 * a + 0.5 * b;
        if patches.iter().all(|p| p.contains_point(curve, m, 1e-12)) {
            // Consecutive pieces share their split parameter exactly.
            if let Some(last) = pieces.last_mut()
                && same(last.1, a)
            {
                last.1 = b;
                continue;
            }
            pieces.push((a, b));
        }
    }
    let whole = splits.is_empty() && pieces.len() == 1;
    if closed && pieces.len() >= 2 {
        let first = pieces[0];
        let last = *pieces.last().expect("non-empty");
        if same(first.0, t0) && same(last.1, t1) {
            pieces.pop();
            pieces[0] = (last.0, first.1 + width);
        }
    }
    Ok((pieces, whole))
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Circle3, Cylinder, Line3, Plane};
    use forge_core::math;
    use forge_core::{Frame, Vec3};

    #[test]
    fn line_is_clipped_to_a_plane_box() {
        let plane: Surface = Plane::new(Frame::world()).into();
        let line: Curve3 = Line3::new(Vec3::new(-10.0, 0.5, 0.0), Vec3::unit_x())
            .expect("l")
            .into();
        let patch = Patch {
            surf: &plane,
            dom: UvBox::new(-1.0, 2.0, 0.0, 1.0),
        };
        let (pieces, whole) = clip_to_patches(&line, 0.0, 20.0, &[patch], false).expect("ok");
        assert!(!whole);
        assert_eq!(pieces.len(), 1);
        assert!((pieces[0].0 - 9.0).abs() < 1e-12 && (pieces[0].1 - 12.0).abs() < 1e-12);
    }

    #[test]
    fn circle_across_a_partial_cylinder_domain_is_one_wrapped_arc() {
        let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
        let circle: Curve3 = Circle3::new(Frame::world(), 2.0).expect("c").into();
        // u in [-1, 1] (straddles the circle's t = 0).
        let patch = Patch {
            surf: &cyl,
            dom: UvBox::new(-1.0, 1.0, -1.0, 1.0),
        };
        let (pieces, _) = clip_to_patches(&circle, 0.0, math::TAU, &[patch], true).expect("ok");
        assert_eq!(pieces.len(), 1, "{pieces:?}");
        let (a, b) = pieces[0];
        assert!((a - (math::TAU - 1.0)).abs() < 1e-12 && (b - (math::TAU + 1.0)).abs() < 1e-12);
    }

    #[test]
    fn full_period_domains_do_not_clip() {
        let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
        let circle: Curve3 = Circle3::new(Frame::world(), 2.0).expect("c").into();
        let patch = Patch {
            surf: &cyl,
            dom: UvBox::new(0.3, 0.3 + math::TAU, -1.0, 1.0),
        };
        let (pieces, whole) = clip_to_patches(&circle, 0.0, math::TAU, &[patch], true).expect("ok");
        assert!(whole && pieces == vec![(0.0, math::TAU)]);
    }
}
