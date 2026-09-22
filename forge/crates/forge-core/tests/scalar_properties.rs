//! Property tests for the scalar types: dual-number derivatives against analytic
//! derivatives and finite differences; interval results always contain the point result.

use forge_core::math;
use forge_core::scalar::{Dual, Interval, Scalar};
use num_rational::BigRational;
use proptest::prelude::*;

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * (1.0 + a.abs().max(b.abs()))
}

/// A generic expression exercising most operations.
fn expr<S: Scalar>(x: S) -> S {
    let two = S::from_f64(2.0);
    let a = x.sin() * (x / S::from_f64(3.0)).exp() / (S::one() + x.square());
    let b = (x.square() + two).sqrt() * x.cos().atan2(two + x.sin());
    let c =
        (x.square() + S::one()).ln() - x.powi(3) * S::from_f64(0.01) + (x * S::from_f64(0.1)).tan();
    a + b + c + x.hypot(two).powf(S::from_f64(1.5))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    #[test]
    fn dual_derivative_matches_finite_difference(x in -3.0..3.0f64) {
        let d = expr(Dual::variable(x));
        prop_assert!(close(d.v, expr(x), 1e-15));
        let h = 1e-6;
        let fd = (expr(x + h) - expr(x - h)) / (2.0 * h);
        prop_assert!(close(d.d, fd, 1e-6), "x = {x}: dual {} vs fd {fd}", d.d);
    }

    #[test]
    fn dual_elementary_derivatives_are_analytic(x in 0.05..0.95f64) {
        let v = Dual::variable(x);
        let checks = [
            (v.sin().d, math::cos(x)),
            (v.cos().d, -math::sin(x)),
            (v.tan().d, 1.0 / (math::cos(x) * math::cos(x))),
            (v.asin().d, 1.0 / (1.0 - x * x).sqrt()),
            (v.acos().d, -1.0 / (1.0 - x * x).sqrt()),
            (v.atan().d, 1.0 / (1.0 + x * x)),
            (v.exp().d, math::exp(x)),
            (v.ln().d, 1.0 / x),
            (v.sqrt().d, 0.5 / x.sqrt()),
            (v.powf(Dual::constant(2.5)).d, 2.5 * math::powf(x, 1.5)),
            (v.powi(-3).d, -3.0 / math::powi(x, 4)),
            (v.recip().d, -1.0 / (x * x)),
            (v.abs().d, 1.0),
            (Dual::constant(0.7).atan2(v).d, -0.7 / (0.49 + x * x)),
            (v.atan2(Dual::constant(0.7)).d, 0.7 / (0.49 + x * x)),
            (v.hypot(Dual::constant(2.0)).d, x / (x * x + 4.0).sqrt()),
        ];
        for (i, (got, want)) in checks.iter().enumerate() {
            prop_assert!(close(*got, *want, 1e-13), "check {i}: {got} vs {want}");
        }
    }

    #[test]
    fn interval_arithmetic_contains_exact_results(
        a in -1e6..1e6f64, wa in 0.0..10.0f64, b in -1e6..1e6f64, wb in 0.0..10.0f64,
        fa in 0.0..=1.0f64, fb in 0.0..=1.0f64,
    ) {
        let (ia, ib) = (Interval::new(a, a + wa), Interval::new(b, b + wb));
        let (x, y) = ((a + wa * fa).min(ia.hi()), (b + wb * fb).min(ib.hi()));
        prop_assert!(ia.contains(x) && ib.contains(y));
        let q = |v: f64| BigRational::from_float(v).expect("finite");
        let contains_q = |i: Interval, v: &BigRational| q(i.lo()) <= *v && *v <= q(i.hi());
        prop_assert!(contains_q(ia + ib, &(q(x) + q(y))));
        prop_assert!(contains_q(ia - ib, &(q(x) - q(y))));
        prop_assert!(contains_q(ia * ib, &(q(x) * q(y))));
        if !ib.contains_zero() {
            prop_assert!(contains_q(ia / ib, &(q(x) / q(y))));
        } else {
            prop_assert!((ia / ib).lo().is_infinite() && (ia / ib).hi().is_infinite());
        }
        prop_assert!(contains_q(ia.square(), &(q(x) * q(x))));
    }

    #[test]
    fn interval_functions_contain_point_results(lo in -20.0..20.0f64, w in 0.0..4.0f64, f in 0.0..=1.0f64) {
        let i = Interval::new(lo, lo + w);
        let x = (lo + w * f).min(i.hi());
        prop_assert!(i.sin().contains(math::sin(x)));
        prop_assert!(i.cos().contains(math::cos(x)));
        prop_assert!(i.tan().contains(math::tan(x)) || math::tan(x).abs() > 1e15);
        prop_assert!(i.exp().contains(math::exp(x)));
        prop_assert!(i.atan().contains(math::atan(x)));
        prop_assert!(i.abs().contains(x.abs()));
        let pos = Interval::new(lo.abs() + 1e-3, lo.abs() + 1e-3 + w);
        let xp = (pos.lo() + w * f).min(pos.hi());
        prop_assert!(pos.sqrt().contains(xp.sqrt()));
        prop_assert!(pos.ln().contains(math::ln(xp)));
        prop_assert!(pos.powf(Interval::point(1.7)).contains(math::powf(xp, 1.7)));
        let unit = Interval::new((lo / 20.0).clamp(-1.0, 1.0), ((lo + w) / 20.0).clamp(-1.0, 1.0));
        let xu = (unit.lo() + (unit.hi() - unit.lo()) * f).min(unit.hi());
        prop_assert!(unit.asin().contains(math::asin(xu)));
        prop_assert!(unit.acos().contains(math::acos(xu)));
    }

    #[test]
    fn interval_atan2_contains_point_results(ylo in -5.0..5.0f64, yw in 0.0..2.0f64, xlo in -5.0..5.0f64, xw in 0.0..2.0f64,
                                             fy in 0.0..=1.0f64, fx in 0.0..=1.0f64) {
        let (iy, ix) = (Interval::new(ylo, ylo + yw), Interval::new(xlo, xlo + xw));
        let (y, x) = ((ylo + yw * fy).min(iy.hi()), (xlo + xw * fx).min(ix.hi()));
        prop_assert!(iy.atan2(ix).contains(math::atan2(y, x)));
    }

    #[test]
    fn generic_expression_enclosure_contains_f64_evaluation(x in -3.0..3.0f64, w in 0.0..1e-3f64) {
        // A point interval contains the f64 evaluation; a wider one contains every sample.
        prop_assert!(expr(Interval::point(x)).contains(expr(x)));
        let i = Interval::new(x, x + w);
        for k in 0..=4 {
            let s = (x + w * k as f64 / 4.0).min(i.hi());
            prop_assert!(expr(i).contains(expr(s)), "x = {s}");
        }
    }
}

#[test]
fn interval_pi_constants_enclose_true_values() {
    // π to 30 digits; compare exactly with rationals.
    let pi = BigRational::new(
        "314159265358979323846264338327950".parse().expect("int"),
        "100000000000000000000000000000000".parse().expect("int"),
    );
    let q = |v: f64| BigRational::from_float(v).expect("finite");
    let p = Interval::pi();
    assert!(q(p.lo()) < pi && pi < q(p.hi()));
    let two = BigRational::from_float(2.0).expect("2");
    let t = Interval::tau();
    assert!(q(t.lo()) < &pi * &two && &pi * &two < q(t.hi()));
}
