//! Certified isolation of the real roots of a scalar function on an interval.
//!
//! # Algorithm
//! Branch and bound over `[lo, hi]` with interval arithmetic:
//! 1. **Exclusion.** Over a piece `I`, the value enclosure (natural extension ∩
//!    mean-value form, [`enclose1`]) not containing 0 proves `I` root-free.
//! 2. **Monotonicity.** If the derivative enclosure excludes 0, `f` is strictly monotone
//!    on `I`: certified endpoint signs decide whether `I` holds exactly one root (then it
//!    is refined by safeguarded Newton–bisection and certified by **interval Newton**:
//!    `N(T) = t − f(t)/f'(T) ⊆ T` proves a unique root in `T`) or none.
//! 3. Otherwise `I` is bisected until its width reaches `min_width`; the remaining pieces
//!    are merged into **clusters** around near-critical points (double roots,
//!    tangencies). A cluster is a root (non-unique, "tangent") if `|f| <= zero_tol`
//!    somewhere in it or `f` changes sign across it; otherwise it is re-examined on a
//!    finer grid and must be certified root-free.
//!
//! Every returned root therefore has a certified enclosure whose residual contains 0,
//! and everything outside the enclosures is certified root-free: the output is
//! **complete**. Clusters wider than `flat_width` over which `|f| <= zero_tol` are
//! reported as flat ranges (the function vanishes identically within tolerance).

use forge_core::scalar::{Interval, Scalar};

use crate::error::SsiError;
use crate::func::{Fn1, enclose1, val_der1};

/// Non-dyadic split ratio: bisecting exactly at the midpoint makes symmetric problems
/// put roots exactly on piece boundaries.
const SPLIT: f64 = 0.4990234375;

/// Options of [`find_roots`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct RootOpts {
    /// `|f|` at or below this counts as zero (tangential contact).
    pub zero_tol: f64,
    /// Smallest piece width.
    pub min_width: f64,
    /// Clusters wider than this with `|f| <= zero_tol` throughout are flat ranges.
    pub flat_width: f64,
    /// Piece budget.
    pub max_pieces: usize,
}

/// A certified root.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Root1 {
    /// Best estimate.
    pub t: f64,
    /// Enclosure.
    pub lo: f64,
    /// Enclosure.
    pub hi: f64,
    /// Proven unique in `[lo, hi]` (simple root).
    pub unique: bool,
    /// `f` over the enclosure (contains 0 for unique roots; for clusters, the enclosure
    /// of `f` over the cluster).
    pub residual: Interval,
    /// `f` changes sign across the enclosure (certain).
    pub sign_change: bool,
    /// `|f(t)|` in `f64`.
    pub abs_value: f64,
}

/// Result of [`find_roots`].
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Roots1 {
    /// Isolated roots, sorted.
    pub roots: Vec<Root1>,
    /// Flat ranges (`|f| <= zero_tol` throughout), sorted.
    pub flats: Vec<(f64, f64)>,
    /// Pieces examined.
    pub pieces: usize,
}

fn sign_of(i: Interval) -> i8 {
    if i.lo() > 0.0 {
        1
    } else if i.hi() < 0.0 {
        -1
    } else {
        0
    }
}

/// Find all roots of `f` on `[lo, hi]` (see the module docs for the guarantees).
pub(crate) fn find_roots<F: Fn1>(
    f: &F,
    lo: f64,
    hi: f64,
    opts: &RootOpts,
) -> Result<Roots1, SsiError> {
    let mut out = Roots1::default();
    if !(lo.is_finite() && hi.is_finite() && lo <= hi) {
        return Ok(out);
    }
    if crate::clip::same(lo, hi) {
        let v = f.eval(Interval::point(lo));
        if v.contains_zero() || v.mag() <= opts.zero_tol {
            out.roots.push(Root1 {
                t: lo,
                lo,
                hi,
                unique: false,
                residual: v,
                sign_change: false,
                abs_value: f.eval(lo).abs(),
            });
        }
        return Ok(out);
    }
    let mut stack = vec![(lo, hi)];
    let mut monotone: Vec<(f64, f64, i8)> = Vec::new();
    let mut small: Vec<(f64, f64)> = Vec::new();
    while let Some((a, b)) = stack.pop() {
        out.pieces += 1;
        if out.pieces > opts.max_pieces {
            return Err(SsiError::BudgetExceeded {
                what: "1d root pieces",
                limit: opts.max_pieces,
            });
        }
        let (v, d) = enclose1(f, a, b);
        if !v.contains_zero() {
            continue;
        }
        if !d.contains_zero() && d.is_finite() {
            let fa = f.eval(Interval::point(a));
            let fb = f.eval(Interval::point(b));
            let (sa, sb) = (sign_of(fa), sign_of(fb));
            if sa != 0 && sb != 0 {
                if sa != sb {
                    monotone.push((a, b, sa));
                }
                continue;
            }
        }
        // |f| <= zero_tol on the whole piece: a zero within tolerance (tangency or
        // flat range); subdividing further only chases rounding noise.
        if v.lo() >= -opts.zero_tol && v.hi() <= opts.zero_tol {
            small.push((a, b));
            continue;
        }
        if b - a <= opts.min_width {
            small.push((a, b));
            continue;
        }
        let m = a + (b - a) * SPLIT;
        if !(m > a && m < b) {
            small.push((a, b));
            continue;
        }
        stack.push((m, b));
        stack.push((a, m));
    }

    for &(a, b, sa) in &monotone {
        out.roots.push(certify_monotone(f, a, b, sa));
    }
    for (ga, gb) in merge_pieces(&small) {
        resolve_cluster(f, ga, gb, opts, &mut out)?;
    }
    out.roots
        .sort_by(|x, y| x.t.total_cmp(&y.t).then(x.lo.total_cmp(&y.lo)));
    // Adjacent clusters/roots describing the same point: keep the first.
    out.roots
        .dedup_by(|b, a| b.lo <= a.hi && b.t - a.t <= opts.min_width);
    Ok(out)
}

/// Merge touching pieces (sorted by start) into maximal groups.
fn merge_pieces(pieces: &[(f64, f64)]) -> Vec<(f64, f64)> {
    let mut p = pieces.to_vec();
    p.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (a, b) in p {
        if let Some(last) = out.last_mut()
            && a <= last.1
        {
            last.1 = last.1.max(b);
            continue;
        }
        out.push((a, b));
    }
    out
}

/// Refine the unique root of a strictly monotone `f` on `[a, b]` (sign `sa` at `a`) and
/// certify it with interval Newton.
fn certify_monotone<F: Fn1>(f: &F, a: f64, b: f64, sa: i8) -> Root1 {
    let t = refine_bracketed(f, a, b, sa);
    let fallback = Root1 {
        t,
        lo: a,
        hi: b,
        unique: true,
        residual: f.eval(Interval::new(a, b)),
        sign_change: true,
        abs_value: f.eval(t).abs(),
    };
    match interval_newton(f, t, a, b) {
        Some((lo, hi, res)) => Root1 {
            lo,
            hi,
            residual: res,
            ..fallback
        },
        // Monotonicity plus a certain sign change already proves a unique root in [a, b].
        None => fallback,
    }
}

/// Safeguarded Newton–bisection on a bracket with a sign change (`sa` = sign at `a`).
pub(crate) fn refine_bracketed<F: Fn1>(f: &F, a: f64, b: f64, sa: i8) -> f64 {
    let (mut lo, mut hi) = (a, b);
    let mut t = 0.5 * a + 0.5 * b;
    for _ in 0..200 {
        let (fv, dv) = val_der1(f, t);
        if fv == 0.0 {
            return t;
        }
        let s = if fv > 0.0 { 1 } else { -1 };
        if s == sa {
            lo = t;
        } else {
            hi = t;
        }
        let newton = t - fv / dv;
        let next = if dv != 0.0 && newton > lo && newton < hi && newton.is_finite() {
            newton
        } else {
            0.5 * lo + 0.5 * hi
        };
        if crate::clip::same(next, t)
            || hi - lo <= 2.0 * f64::EPSILON * t.abs().max(f64::MIN_POSITIVE)
        {
            return next;
        }
        t = next;
    }
    t
}

/// Interval Newton around `t` within `[a, b]`: returns `(lo, hi, f([lo, hi]))` with a
/// proven unique root in `[lo, hi]`, or `None`.
pub(crate) fn interval_newton<F: Fn1>(
    f: &F,
    t: f64,
    a: f64,
    b: f64,
) -> Option<(f64, f64, Interval)> {
    let ft = f.eval(Interval::point(t));
    let mut delta = 8.0 * f64::EPSILON * t.abs().max(1e-300) + 4.0 * f64::MIN_POSITIVE;
    let (_, d0) = val_der1(f, t);
    if d0 != 0.0 && d0.is_finite() {
        delta = delta.max(4.0 * ft.mag() / d0.abs());
    }
    for _ in 0..40 {
        let lo = (t - delta).max(a);
        let hi = (t + delta).min(b);
        if lo < hi {
            let big = Interval::new(lo, hi);
            let (_, d) = enclose1(f, lo, hi);
            if !d.contains_zero() {
                let n = Interval::point(t) - ft / d;
                if big.contains_interval(n) {
                    return Some((lo, hi, f.eval(big)));
                }
            }
        }
        delta *= 4.0;
        if delta > (b - a) {
            break;
        }
    }
    None
}

/// Classify a cluster `[ga, gb]` of pieces where neither exclusion nor monotonicity
/// could be certified at the minimum width.
fn resolve_cluster<F: Fn1>(
    f: &F,
    ga: f64,
    gb: f64,
    opts: &RootOpts,
    out: &mut Roots1,
) -> Result<(), SsiError> {
    // Locate the smallest |f| in the cluster: samples, then Newton on f' (a critical
    // point) kept inside the cluster.
    let n = 16;
    let mut best = (ga, f.eval(ga).abs());
    for i in 0..=n {
        let t = ga + (gb - ga) * i as f64 / n as f64;
        let v = f.eval(t).abs();
        if v < best.1 {
            best = (t, v);
        }
    }
    let t_c = polish_extremum(f, best.0, ga, gb);
    let v_c = f.eval(t_c).abs();
    let (t_c, v_c) = if v_c <= best.1 { (t_c, v_c) } else { best };
    let fa = f.eval(Interval::point(ga));
    let fb = f.eval(Interval::point(gb));
    let sign_change = sign_of(fa) * sign_of(fb) < 0;
    let width = gb - ga;

    if width > opts.flat_width {
        // A wide unresolved range: flat if |f| is within tolerance everywhere on it.
        let flat = (0..=64).all(|i| f.eval(ga + width * i as f64 / 64.0).abs() <= opts.zero_tol);
        if flat {
            out.flats.push((ga, gb));
            return Ok(());
        }
    }
    if v_c <= opts.zero_tol || sign_change {
        // A root. If it is actually simple (the cluster came from overestimation), try
        // to certify uniqueness around the best point.
        if let Some((lo, hi, res)) = interval_newton(f, t_c, ga, gb) {
            out.roots.push(Root1 {
                t: t_c,
                lo,
                hi,
                unique: true,
                residual: res,
                sign_change: true,
                abs_value: v_c,
            });
        } else {
            out.roots.push(Root1 {
                t: t_c,
                lo: ga,
                hi: gb,
                unique: false,
                residual: enclose1(f, ga, gb).0,
                sign_change,
                abs_value: v_c,
            });
        }
        return Ok(());
    }
    // |f| > zero_tol at the extremum and no sign change: certify the cluster root-free on
    // a finer grid (the mean-value form is quadratically tight near the extremum).
    let k = 256;
    for i in 0..k {
        let a = ga + width * i as f64 / k as f64;
        let b = if i + 1 == k {
            gb
        } else {
            ga + width * (i + 1) as f64 / k as f64
        };
        out.pieces += 1;
        let (v, _) = enclose1(f, a, b);
        if v.contains_zero() {
            // Cannot separate the extremum from zero, but it is above the tangency
            // tolerance at the best point found: report the near-contact as a
            // non-unique root only if within tolerance, otherwise it is an error.
            let fm = f.eval(0.5 * a + 0.5 * b).abs();
            if fm <= opts.zero_tol {
                out.roots.push(Root1 {
                    t: 0.5 * a + 0.5 * b,
                    lo: a,
                    hi: b,
                    unique: false,
                    residual: v,
                    sign_change: false,
                    abs_value: fm,
                });
                return Ok(());
            }
            return Err(SsiError::TangentUnresolved {
                point: [t_c, 0.0, 0.0],
                uv_a: [t_c, 0.0],
                uv_b: [0.0, 0.0],
                gap: v_c,
                extent: width,
                branch_ends: 0,
            });
        }
    }
    Ok(())
}

/// Newton on `f'` (via nested duals) from `t0`, clamped to `[a, b]`: a critical point of
/// `f` near `t0` (or `t0` itself if the iteration leaves the bracket).
pub(crate) fn polish_extremum<F: Fn1>(f: &F, t0: f64, a: f64, b: f64) -> f64 {
    use forge_core::scalar::Dual;
    let mut t = t0;
    for _ in 0..40 {
        let x = Dual::new(Dual::new(t, 1.0), Dual::new(1.0, 0.0));
        let r = f.eval(x);
        let (d1, d2) = (r.v.d, r.d.d);
        if !(d2.is_finite() && d2 != 0.0 && d1.is_finite()) {
            break;
        }
        let next = t - d1 / d2;
        if !(next >= a && next <= b) {
            break;
        }
        if (next - t).abs() <= 4.0 * f64::EPSILON * t.abs().max(1e-300) {
            return next;
        }
        t = next;
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::scalar::Scalar;

    struct Poly(Vec<f64>);
    impl Fn1 for Poly {
        fn eval<S: Scalar>(&self, t: S) -> S {
            let mut acc = S::zero();
            for &c in self.0.iter().rev() {
                acc = acc * t + S::from_f64(c);
            }
            acc
        }
    }

    fn opts() -> RootOpts {
        RootOpts {
            zero_tol: 1e-12,
            min_width: 1e-10,
            flat_width: 0.5,
            max_pieces: 100_000,
        }
    }

    #[test]
    fn simple_roots_are_certified_unique() {
        // (t − 0.3)(t + 1.2)(t − 2) = t³ − 1.1t² − 2.16t + 0.72
        let p = Poly(vec![0.72, -2.16, -1.1, 1.0]);
        let r = find_roots(&p, -3.0, 3.0, &opts()).expect("ok");
        let ts: Vec<f64> = r.roots.iter().map(|r| r.t).collect();
        assert_eq!(ts.len(), 3, "{ts:?}");
        for (t, e) in ts.iter().zip([-1.2, 0.3, 2.0]) {
            assert!((t - e).abs() < 1e-14);
        }
        for root in &r.roots {
            assert!(root.unique && root.residual.contains_zero());
            assert!(root.lo <= root.t && root.t <= root.hi && root.hi - root.lo < 1e-12);
        }
    }

    #[test]
    fn double_root_is_a_non_unique_tangent_root() {
        // (t − 1)²(t + 2)
        let p = Poly(vec![2.0, -3.0, 0.0, 1.0]);
        let r = find_roots(&p, -3.0, 3.0, &opts()).expect("ok");
        assert_eq!(r.roots.len(), 2, "{:?}", r.roots);
        assert!(r.roots[0].unique && (r.roots[0].t + 2.0).abs() < 1e-14);
        let d = r.roots[1];
        assert!(!d.unique && (d.t - 1.0).abs() < 1e-6 && d.abs_value < 1e-12);
    }

    #[test]
    fn near_miss_extremum_is_certified_empty() {
        // (t − 1)² + 1e-6 has no real root.
        let p = Poly(vec![1.0 + 1e-6, -2.0, 1.0]);
        let r = find_roots(&p, -3.0, 3.0, &opts()).expect("ok");
        assert!(r.roots.is_empty(), "{:?}", r.roots);
    }

    #[test]
    fn identically_zero_is_flat() {
        let p = Poly(vec![0.0]);
        let r = find_roots(&p, 0.0, 2.0, &opts()).expect("ok");
        assert_eq!(r.flats, vec![(0.0, 2.0)]);
        assert!(r.roots.is_empty());
    }

    #[test]
    fn root_at_range_end_is_found() {
        let p = Poly(vec![-1.0, 1.0]); // t = 1
        let r = find_roots(&p, 1.0, 2.0, &opts()).expect("ok");
        assert_eq!(r.roots.len(), 1);
        assert!((r.roots[0].t - 1.0).abs() < 1e-12);
    }
}
