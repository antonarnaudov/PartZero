//! Bit-level determinism guard.
//!
//! Hashes the exact bit patterns of a broad sample of forge-core results (libm wrappers,
//! quadrature nodes, curve/surface evaluation and projection, NURBS, predicates,
//! intervals) and compares them with a constant recorded on the reference platform.
//!
//! **If this test fails on a new platform or toolchain, results are not bit-identical
//! across targets.** Investigate (a platform intrinsic, FMA contraction, a HashMap
//! iteration, …) before touching the constant. Update the constant only for an
//! intentional algorithm change, and say so in the commit message.

use forge_core::geom::quadrature::gauss_legendre;
use forge_core::geom::{
    Circle3, Cone, Curve3, Cylinder, Ellipse3, Line3, NurbsCurve3, NurbsSurface, Plane, Sphere,
    Surface, Torus,
};
use forge_core::math;
use forge_core::predicates::{incircle, insphere, orient2d, orient3d};
use forge_core::scalar::{Interval, Scalar};
use forge_core::{Frame, Transform, Vec2, Vec3};

/// FNV-1a over `f64` bit patterns.
struct Hasher(u64);
impl Hasher {
    fn f(&mut self, x: f64) {
        for b in x.to_bits().to_le_bytes() {
            self.0 ^= u64::from(b);
            self.0 = self.0.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    fn v(&mut self, p: Vec3) {
        self.f(p.x);
        self.f(p.y);
        self.f(p.z);
    }
}

fn samples(n: usize, lo: f64, hi: f64) -> impl Iterator<Item = f64> {
    (0..n).map(move |i| lo + (hi - lo) * (i as f64 + 0.37) / n as f64)
}

fn fingerprint() -> u64 {
    let mut h = Hasher(0xcbf2_9ce4_8422_2325);
    for x in samples(97, -40.0, 40.0) {
        for y in [
            math::sin(x),
            math::cos(x),
            math::tan(x),
            math::atan(x),
            math::atan2(x, 1.3 - x),
            math::exp(x / 8.0),
            math::ln(x.abs() + 1e-3),
            math::powf(x.abs() + 0.5, 1.7),
            math::hypot(x, 2.0),
            math::cbrt(x),
            math::asin(x / 40.0),
            math::acos(x / 40.0),
            math::deg_to_rad(x * 9.0),
        ] {
            h.f(y);
        }
        let (s, c) = math::sin_cos_deg(x * 11.0);
        h.f(s);
        h.f(c);
    }
    for (x, w) in gauss_legendre(16) {
        h.f(x);
        h.f(w);
    }

    let f = Frame::from_normal_x(
        Vec3::new(0.3, -1.2, 2.0),
        Vec3::new(0.2, 0.9, 0.4),
        Vec3::new(1.0, 0.1, -0.3),
    )
    .expect("frame");
    let nurbs = NurbsCurve3::from_points(
        3,
        vec![0.0, 0.0, 0.0, 0.0, 0.4, 1.0, 1.0, 1.0, 1.0],
        &[
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 2.0, 0.0),
            Vec3::new(2.0, -1.0, 1.0),
            Vec3::new(3.0, 1.0, 0.5),
            Vec3::new(4.0, 0.0, 0.0),
        ],
        Some(vec![1.0, 0.5, 2.0, 1.0, 1.0]),
    )
    .expect("curve");
    let curves: Vec<Curve3> = vec![
        Line3::new(f.origin(), Vec3::new(1.0, 2.0, 3.0))
            .expect("line")
            .into(),
        Circle3::new(f, 2.5).expect("circle").into(),
        Ellipse3::new(f, 4.0, 1.5).expect("ellipse").into(),
        NurbsCurve3::circle_arc(&f, 3.0, 0.2, 5.9)
            .expect("arc")
            .into(),
        nurbs.into(),
    ];
    for c in &curves {
        let (a, b) = c.domain();
        let (a, b) = if a.is_finite() { (a, b) } else { (-3.0, 3.0) };
        for t in samples(23, a, b) {
            let [p, d1, d2] = c.derivs2(t);
            h.v(p);
            h.v(d1);
            h.v(d2);
        }
        for q in samples(11, -5.0, 5.0) {
            let (t, d) = c.project(Vec3::new(q, 0.7 * q - 1.0, 2.0 - q));
            h.f(t);
            h.f(d);
        }
        h.f(c.arc_length(a, b.min(a + 6.0)));
    }

    let mut pts = Vec::new();
    for i in 0..4 {
        for j in 0..3 {
            pts.push(Vec3::new(i as f64, j as f64, ((i * j) % 3) as f64 * 0.4));
        }
    }
    let bs = NurbsSurface::new(
        2,
        2,
        vec![0.0, 0.0, 0.0, 0.5, 1.0, 1.0, 1.0],
        vec![0.0, 0.0, 0.0, 1.0, 1.0, 1.0],
        4,
        3,
        pts,
        None,
    )
    .expect("surface");
    let surfaces: Vec<Surface> = vec![
        Plane::new(f).into(),
        Cylinder::new(f, 3.0).expect("cyl").into(),
        Cone::new(f, 2.0, 0.4).expect("cone").into(),
        Sphere::new(f, 4.0).expect("sphere").into(),
        Torus::new(f, 5.0, 1.5).expect("torus").into(),
        bs.into(),
    ];
    let t = Transform::rotation_about_axis_deg(
        Vec3::new(1.0, 0.0, 0.0),
        Vec3::new(0.0, 1.0, 1.0),
        37.0,
    )
    .expect("transform");
    for s in &surfaces {
        let st = s.transform(&t);
        for u in samples(7, 0.0, 1.0) {
            for v in samples(7, 0.0, 1.0) {
                let d = s.derivs2(u, v);
                h.v(d.p);
                h.v(d.du);
                h.v(d.dvv);
                h.v(s.normal(u, v).expect("normal"));
                h.v(st.eval(u, v));
            }
        }
        for q in samples(9, -6.0, 6.0) {
            let (u, v, d) = s.project(Vec3::new(q, 1.0 - q, 0.5 * q));
            h.f(u);
            h.f(v);
            h.f(d);
        }
    }

    for k in samples(25, -1.0, 1.0) {
        let e = k * 1e-15;
        h.f(orient2d(
            Vec2::new(0.1 + e, 0.1),
            Vec2::new(12.0, 12.0),
            Vec2::new(24.0, 24.0 + e),
        ));
        h.f(orient3d(
            Vec3::new(0.0, 0.0, e),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.3, 0.3, -e),
        ));
        h.f(incircle(
            Vec2::new(1.0, 0.0),
            Vec2::new(0.0, 1.0),
            Vec2::new(-1.0, 0.0),
            Vec2::new(e, -1.0),
        ));
        h.f(insphere(
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(0.0, 0.0, -1.0),
            Vec3::new(-1.0 + e, 0.0, 0.0),
        ));
        let i = Interval::new(k, k + 0.25);
        for r in [
            i.sin(),
            i.exp(),
            i.sqrt(),
            (i * i - i).atan2(Interval::point(0.5)),
        ] {
            h.f(r.lo());
            h.f(r.hi());
        }
    }
    h.0
}

/// Recorded on aarch64-apple-darwin (Rust 1.92). Must be identical on every target.
const GOLDEN: u64 = 0x8dc3_44c3_aa7e_8748;

#[test]
fn results_are_bit_identical_to_the_reference_platform() {
    let fp = fingerprint();
    assert_eq!(
        fp,
        fingerprint(),
        "not even deterministic within one process"
    );
    assert_eq!(
        fp, GOLDEN,
        "fingerprint {fp:#018x} differs from the reference {GOLDEN:#018x}"
    );
}
