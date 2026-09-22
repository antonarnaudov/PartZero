//! Exact-sign tests of the robust predicates against arbitrary-precision arithmetic, on
//! random, near-degenerate and exactly degenerate inputs.
//!
//! Oracle: every `f64` is a dyadic rational `m·2^e`. Scaling all coordinates of one
//! configuration by the same power of two maps them exactly onto integers and multiplies
//! each determinant by a positive factor, so the sign of the integer (`BigInt`)
//! determinant is the exact sign. This avoids `BigRational`'s gcd normalizations.

use std::cmp::Ordering;

use forge_core::predicates::{Sign, incircle, insphere, orient2d, orient3d};
use forge_core::{Point2, Point3, Vec2, Vec3};
use num_bigint::BigInt;
use num_rational::BigRational;
use num_traits::{Signed, Zero};
use proptest::prelude::*;

/// `x = m·2^e` exactly.
fn decode(x: f64) -> (BigInt, i32) {
    let bits = x.to_bits();
    let negative = bits >> 63 == 1;
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    let (m, e) = if biased == 0 {
        (frac, -1074)
    } else {
        (frac | (1u64 << 52), biased - 1075)
    };
    let m = BigInt::from(m);
    (if negative { -m } else { m }, e)
}

/// Exact integer images of all coordinates under one common power-of-two scaling.
fn to_ints(xs: &[f64]) -> Vec<BigInt> {
    let d: Vec<(BigInt, i32)> = xs.iter().map(|&x| decode(x)).collect();
    let emin = d.iter().map(|(_, e)| *e).min().expect("non-empty");
    d.into_iter()
        .map(|(m, e)| m << ((e - emin) as usize))
        .collect()
}

fn det(m: &[Vec<BigInt>]) -> BigInt {
    let n = m.len();
    if n == 1 {
        return m[0][0].clone();
    }
    let mut total = BigInt::zero();
    for col in 0..n {
        let minor: Vec<Vec<BigInt>> = m[1..]
            .iter()
            .map(|row| {
                row.iter()
                    .enumerate()
                    .filter(|(c, _)| *c != col)
                    .map(|(_, v)| v.clone())
                    .collect()
            })
            .collect();
        let term = &m[0][col] * det(&minor);
        if col % 2 == 0 {
            total += term;
        } else {
            total -= term;
        }
    }
    total
}

fn sign_of(x: &BigInt) -> Sign {
    match x.cmp(&BigInt::zero()) {
        Ordering::Less => Sign::Negative,
        Ordering::Equal => Sign::Zero,
        Ordering::Greater => Sign::Positive,
    }
}

/// Integer coordinates (common scaling) of 2D points, as `[x, y]` rows relative to the
/// last point.
fn rel2(pts: &[Point2]) -> Vec<[BigInt; 2]> {
    let flat: Vec<f64> = pts.iter().flat_map(|p| [p.x, p.y]).collect();
    let ints = to_ints(&flat);
    let n = pts.len();
    let (ox, oy) = (&ints[2 * (n - 1)], &ints[2 * (n - 1) + 1]);
    (0..n - 1)
        .map(|i| [&ints[2 * i] - ox, &ints[2 * i + 1] - oy])
        .collect()
}

/// Like [`rel2`] for 3D points.
fn rel3(pts: &[Point3]) -> Vec<[BigInt; 3]> {
    let flat: Vec<f64> = pts.iter().flat_map(|p| [p.x, p.y, p.z]).collect();
    let ints = to_ints(&flat);
    let n = pts.len();
    let o = &ints[3 * (n - 1)..];
    (0..n - 1)
        .map(|i| {
            [
                &ints[3 * i] - &o[0],
                &ints[3 * i + 1] - &o[1],
                &ints[3 * i + 2] - &o[2],
            ]
        })
        .collect()
}

fn exact_orient2d(a: Point2, b: Point2, c: Point2) -> Sign {
    let r = rel2(&[a, b, c]);
    sign_of(&det(&r
        .iter()
        .map(|[x, y]| vec![x.clone(), y.clone()])
        .collect::<Vec<_>>()))
}

fn exact_orient3d(a: Point3, b: Point3, c: Point3, d: Point3) -> Sign {
    let r = rel3(&[a, b, c, d]);
    sign_of(&det(&r
        .iter()
        .map(|[x, y, z]| vec![x.clone(), y.clone(), z.clone()])
        .collect::<Vec<_>>()))
}

fn exact_incircle(a: Point2, b: Point2, c: Point2, d: Point2) -> Sign {
    let r = rel2(&[a, b, c, d]);
    let m: Vec<Vec<BigInt>> = r
        .iter()
        .map(|[x, y]| vec![x.clone(), y.clone(), x * x + y * y])
        .collect();
    sign_of(&det(&m))
}

fn exact_insphere(a: Point3, b: Point3, c: Point3, d: Point3, e: Point3) -> Sign {
    let r = rel3(&[a, b, c, d, e]);
    let m: Vec<Vec<BigInt>> = r
        .iter()
        .map(|[x, y, z]| vec![x.clone(), y.clone(), z.clone(), x * x + y * y + z * z])
        .collect();
    sign_of(&det(&m))
}

fn q(x: f64) -> BigRational {
    BigRational::from_float(x).expect("finite")
}

#[test]
fn integer_oracle_decodes_floats_exactly() {
    for x in [
        0.0,
        -0.0,
        1.0,
        -2.5,
        0.1,
        1e-300,
        5e-324,
        f64::MAX,
        -123456.789,
    ] {
        let (m, e) = decode(x);
        let pow = BigInt::from(1) << (e.unsigned_abs() as usize);
        let value = if e >= 0 {
            BigRational::from_integer(m * pow)
        } else {
            BigRational::new(m, pow)
        };
        assert_eq!(value, q(x), "{x}");
    }
}

/// Move `x` by `k` ulps.
fn ulps(x: f64, k: i32) -> f64 {
    let mut y = x;
    for _ in 0..k.unsigned_abs() {
        y = if k > 0 { y.next_up() } else { y.next_down() };
    }
    y
}

fn p2(a: [f64; 2]) -> Point2 {
    Vec2::new(a[0], a[1])
}
fn p3(a: [f64; 3]) -> Point3 {
    Vec3::new(a[0], a[1], a[2])
}

fn coord() -> impl Strategy<Value = f64> {
    prop_oneof![
        -1.0..1.0f64,
        -1e6..1e6f64,
        (-1e3..1e3f64).prop_map(|x| x.round())
    ]
}

// ---- deterministic stress tests -------------------------------------------------------

#[test]
fn orient2d_grid_near_line_y_eq_x_matches_exact() {
    // Shewchuk's classic example: points 0.5 + k·2^-53 near the line through (12,12) and
    // (24,24). Naive evaluation gets a large fraction of these wrong.
    let eps = f64::EPSILON / 2.0;
    let (b, c) = (Vec2::new(12.0, 12.0), Vec2::new(24.0, 24.0));
    let mut nonzero = 0;
    for i in 0..128 {
        for j in 0..128 {
            let a = Vec2::new(0.5 + i as f64 * eps, 0.5 + j as f64 * eps);
            let s = Sign::of(orient2d(a, b, c));
            assert_eq!(s, exact_orient2d(a, b, c), "a = {a:?}");
            nonzero += usize::from(s != Sign::Zero);
        }
    }
    assert!(nonzero > 0);
}

#[test]
fn exactly_degenerate_integer_configurations_are_zero() {
    for k in 1..50 {
        let k = k as f64;
        let (a, b, c) = (
            Vec2::new(-k, 2.0 * k),
            Vec2::new(0.0, 0.0),
            Vec2::new(3.0 * k, -6.0 * k),
        );
        assert_eq!(Sign::of(orient2d(a, b, c)), Sign::Zero);
        let (a3, b3, c3, d3) = (
            Vec3::new(k, 0.0, 1.0),
            Vec3::new(0.0, k, 1.0),
            Vec3::new(-k, -k, 1.0),
            Vec3::new(7.0, -3.0, 1.0),
        );
        assert_eq!(Sign::of(orient3d(a3, b3, c3, d3)), Sign::Zero);
        // Cocircular: points on a circle of radius 5k (Pythagorean triple).
        let r = |x: f64, y: f64| Vec2::new(x * k, y * k);
        assert_eq!(
            Sign::of(incircle(
                r(5.0, 0.0),
                r(3.0, 4.0),
                r(-4.0, 3.0),
                r(0.0, -5.0)
            )),
            Sign::Zero
        );
        let s = |x: f64, y: f64, z: f64| Vec3::new(x * k, y * k, z * k);
        let (sa, sb, sc, sd, se) = (
            s(3.0, 4.0, 0.0),
            s(0.0, 3.0, 4.0),
            s(4.0, 0.0, 3.0),
            s(0.0, 0.0, -5.0),
            s(-5.0, 0.0, 0.0),
        );
        assert_eq!(Sign::of(insphere(sa, sb, sc, sd, se)), Sign::Zero);
    }
}

// ---- property tests -------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(10_000))]

    #[test]
    fn orient2d_random(a in prop::array::uniform2(coord()), b in prop::array::uniform2(coord()), c in prop::array::uniform2(coord())) {
        prop_assert_eq!(Sign::of(orient2d(p2(a), p2(b), p2(c))), exact_orient2d(p2(a), p2(b), p2(c)));
    }

    #[test]
    fn orient2d_near_collinear(a in prop::array::uniform2(coord()), b in prop::array::uniform2(coord()),
                               t in -2.0..3.0f64, kx in -3i32..=3, ky in -3i32..=3) {
        let (a, b) = (p2(a), p2(b));
        let c = a + (b - a) * t; // nearly collinear after rounding
        let c = Vec2::new(ulps(c.x, kx), ulps(c.y, ky));
        prop_assert_eq!(Sign::of(orient2d(a, b, c)), exact_orient2d(a, b, c));
    }

    #[test]
    fn orient3d_random(a in prop::array::uniform3(coord()), b in prop::array::uniform3(coord()),
                       c in prop::array::uniform3(coord()), d in prop::array::uniform3(coord())) {
        let (a, b, c, d) = (p3(a), p3(b), p3(c), p3(d));
        prop_assert_eq!(Sign::of(orient3d(a, b, c, d)), exact_orient3d(a, b, c, d));
    }

    #[test]
    fn orient3d_near_coplanar(a in prop::array::uniform3(coord()), b in prop::array::uniform3(coord()),
                              c in prop::array::uniform3(coord()), s in -1.0..2.0f64, t in -1.0..2.0f64,
                              k in prop::array::uniform3(-2i32..=2)) {
        let (a, b, c) = (p3(a), p3(b), p3(c));
        let d = a + (b - a) * s + (c - a) * t;
        let d = Vec3::new(ulps(d.x, k[0]), ulps(d.y, k[1]), ulps(d.z, k[2]));
        prop_assert_eq!(Sign::of(orient3d(a, b, c, d)), exact_orient3d(a, b, c, d));
    }

    #[test]
    fn incircle_random(a in prop::array::uniform2(coord()), b in prop::array::uniform2(coord()),
                       c in prop::array::uniform2(coord()), d in prop::array::uniform2(coord())) {
        let (a, b, c, d) = (p2(a), p2(b), p2(c), p2(d));
        prop_assert_eq!(Sign::of(incircle(a, b, c, d)), exact_incircle(a, b, c, d));
    }

    #[test]
    fn incircle_near_cocircular(center in prop::array::uniform2(coord()), r in 1e-3..1e3f64,
                                th in prop::array::uniform4(0.0..forge_core::math::TAU), k in prop::array::uniform2(-2i32..=2)) {
        let o = p2(center);
        let on = |t: f64| o + Vec2::new(forge_core::math::cos(t), forge_core::math::sin(t)) * r;
        let (a, b, c, d) = (on(th[0]), on(th[1]), on(th[2]), on(th[3]));
        let d = Vec2::new(ulps(d.x, k[0]), ulps(d.y, k[1]));
        prop_assert_eq!(Sign::of(incircle(a, b, c, d)), exact_incircle(a, b, c, d));
    }

    #[test]
    fn insphere_random(a in prop::array::uniform3(coord()), b in prop::array::uniform3(coord()),
                       c in prop::array::uniform3(coord()), d in prop::array::uniform3(coord()),
                       e in prop::array::uniform3(coord())) {
        let (a, b, c, d, e) = (p3(a), p3(b), p3(c), p3(d), p3(e));
        prop_assert_eq!(Sign::of(insphere(a, b, c, d, e)), exact_insphere(a, b, c, d, e));
    }

    #[test]
    fn insphere_near_cospherical(center in prop::array::uniform3(-10.0..10.0f64), r in 1e-2..1e2f64,
                                 ang in prop::array::uniform10(0.0..forge_core::math::TAU), k in prop::array::uniform3(-2i32..=2)) {
        let o = p3(center);
        let on = |u: f64, v: f64| {
            let (su, cu) = forge_core::math::sin_cos(u);
            let (sv, cv) = forge_core::math::sin_cos(v);
            o + Vec3::new(cv * cu, cv * su, sv) * r
        };
        let (a, b, c, d) = (on(ang[0], ang[1]), on(ang[2], ang[3]), on(ang[4], ang[5]), on(ang[6], ang[7]));
        let e = on(ang[8], ang[9]);
        let e = Vec3::new(ulps(e.x, k[0]), ulps(e.y, k[1]), ulps(e.z, k[2]));
        prop_assert_eq!(Sign::of(insphere(a, b, c, d, e)), exact_insphere(a, b, c, d, e));
    }

    #[test]
    fn predicates_are_antisymmetric_under_swaps(a in prop::array::uniform2(coord()), b in prop::array::uniform2(coord()),
                                                c in prop::array::uniform2(coord())) {
        let (a, b, c) = (p2(a), p2(b), p2(c));
        let s1 = Sign::of(orient2d(a, b, c));
        let s2 = Sign::of(orient2d(b, a, c));
        let flipped = match s2 { Sign::Positive => Sign::Negative, Sign::Negative => Sign::Positive, Sign::Zero => Sign::Zero };
        prop_assert_eq!(s1, flipped);
    }
}

#[test]
fn magnitudes_are_close_to_the_determinant_when_well_conditioned() {
    let (a, b, c) = (
        Vec2::new(0.0, 0.0),
        Vec2::new(2.0, 0.0),
        Vec2::new(0.0, 3.0),
    );
    assert!((orient2d(a, b, c) - 6.0).abs() < 1e-12);
    let val = orient3d(
        Vec3::new(1.0, 0.0, 0.0),
        Vec3::new(0.0, 1.0, 0.0),
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(0.0, 0.0, -2.0),
    );
    assert!((val.abs() - 2.0).abs() < 1e-12);
    let x = q(1.0) + q(2.0);
    assert!(x.is_positive());
}

// ---- hard-case sweeps: prove the exact paths are exercised --------------------------------

/// Deterministic xorshift64* generator in `[-1, 1)`.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        let v = self.0.wrapping_mul(0x2545_f491_4f6c_dd1d);
        (v >> 11) as f64 / (1u64 << 52) as f64 - 1.0
    }
    fn p3(&mut self) -> Point3 {
        Vec3::new(self.next(), self.next(), self.next())
    }
    fn k(&mut self) -> i32 {
        (self.next() * 1.5).round() as i32
    }
}

#[test]
fn near_degenerate_sweeps_defeat_naive_evaluation_but_not_the_predicates() {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let (mut naive_wrong_o3, mut naive_wrong_ic, mut naive_wrong_is) = (0, 0, 0);
    for _ in 0..20_000 {
        // orient3d: d nearly in the plane of a, b, c.
        let (a, b, c) = (rng.p3(), rng.p3(), rng.p3());
        let (s, t) = (rng.next(), rng.next());
        let d = a + (b - a) * s + (c - a) * t;
        let d = Vec3::new(ulps(d.x, rng.k()), ulps(d.y, rng.k()), ulps(d.z, rng.k()));
        let exact = exact_orient3d(a, b, c, d);
        assert_eq!(Sign::of(orient3d(a, b, c, d)), exact);
        let naive = (a - d).dot((b - d).cross(c - d));
        naive_wrong_o3 += usize::from(Sign::of(naive) != exact);

        // incircle: four points on a circle.
        let o = Vec2::new(rng.next(), rng.next());
        let r = 0.5 + rng.next().abs();
        let on = |t: f64| o + Vec2::new(forge_core::math::cos(t), forge_core::math::sin(t)) * r;
        let (p, q2, u, w) = (
            on(rng.next() * 3.0),
            on(rng.next() * 3.0),
            on(rng.next() * 3.0),
            on(rng.next() * 3.0),
        );
        let w = Vec2::new(ulps(w.x, rng.k()), ulps(w.y, rng.k()));
        let exact = exact_incircle(p, q2, u, w);
        assert_eq!(Sign::of(incircle(p, q2, u, w)), exact);
        let lift = |z: Point2| (z - w).norm_squared();
        let (pa, pb, pc) = (p - w, q2 - w, u - w);
        let naive =
            lift(p) * pb.perp_dot(pc) + lift(q2) * pc.perp_dot(pa) + lift(u) * pa.perp_dot(pb);
        naive_wrong_ic += usize::from(Sign::of(naive) != exact);

        // insphere: five points on a sphere.
        let c0 = rng.p3();
        let rad = 0.5 + rng.next().abs();
        let mut on_s = || {
            let (su, cu) = forge_core::math::sin_cos(rng.next() * 3.1);
            let (sv, cv) = forge_core::math::sin_cos(rng.next() * 1.5);
            c0 + Vec3::new(cv * cu, cv * su, sv) * rad
        };
        let (a, b, c, d, e) = (on_s(), on_s(), on_s(), on_s(), on_s());
        let exact = exact_insphere(a, b, c, d, e);
        assert_eq!(Sign::of(insphere(a, b, c, d, e)), exact);
        let m = |p: Point3| {
            let v = p - e;
            [v.x, v.y, v.z, v.norm_squared()]
        };
        let rows = [m(a), m(b), m(c), m(d)];
        let det3 = |r0: [f64; 3], r1: [f64; 3], r2: [f64; 3]| {
            Vec3::from(r0).dot(Vec3::from(r1).cross(Vec3::from(r2)))
        };
        let pick = |r: [f64; 4], skip: usize| -> [f64; 3] {
            let v: Vec<f64> = (0..4).filter(|&i| i != skip).map(|i| r[i]).collect();
            [v[0], v[1], v[2]]
        };
        let mut naive = 0.0;
        for col in 0..4 {
            let minor = det3(pick(rows[1], col), pick(rows[2], col), pick(rows[3], col));
            naive += if col % 2 == 0 {
                rows[0][col] * minor
            } else {
                -rows[0][col] * minor
            };
        }
        naive_wrong_is += usize::from(Sign::of(naive) != exact);
    }
    // The configurations are hard enough that naive floating point fails on some of them,
    // so the adaptive/exact paths were exercised and verified above.
    assert!(naive_wrong_o3 > 0, "orient3d sweep too easy");
    assert!(naive_wrong_ic > 0, "incircle sweep too easy");
    assert!(naive_wrong_is > 0, "insphere sweep too easy");
    // ...yet agrees most of the time (so the naive formulas use the same sign convention).
    for n in [naive_wrong_o3, naive_wrong_ic, naive_wrong_is] {
        assert!(
            n < 10_000,
            "naive evaluation disagrees too often ({n}): convention mismatch?"
        );
    }
}
