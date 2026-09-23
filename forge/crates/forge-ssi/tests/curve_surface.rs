//! Curve–surface intersection: closed forms, certificates, tangency, overlap, domains.

mod common;

use common::{dist, frame};
use forge_core::geom::{
    Circle3, Cone, Curve3, Cylinder, Ellipse3, Line3, NurbsCurve3, Plane, Sphere, Surface, Torus,
};
use forge_core::math;
use forge_core::{Frame, Vec3};
use forge_ssi::{Contact, SsiTolerance, UvBox, intersect_curve_surface};
use proptest::prelude::*;

fn tol() -> SsiTolerance {
    SsiTolerance::default()
}

fn full(s: &Surface) -> UvBox {
    UvBox::natural(s, 100.0)
}

#[test]
fn line_sphere_two_points_with_certificates() {
    let s: Surface = Sphere::new(Frame::world(), 2.0).expect("s").into();
    let l: Curve3 = Line3::new(Vec3::new(-5.0, 1.0, 0.0), Vec3::unit_x())
        .expect("l")
        .into();
    let h = intersect_curve_surface(&l, (0.0, 10.0), &s, full(&s), &tol()).expect("ok");
    assert_eq!(h.points.len(), 2);
    assert!(h.certified_complete);
    let x = (4.0f64 - 1.0).sqrt();
    for (hit, ex) in h.points.iter().zip([-x, x]) {
        assert!((hit.point.x - ex).abs() < 1e-14);
        assert_eq!(hit.contact, Contact::Transversal);
        assert_eq!(hit.multiplicity, 1);
        let c = hit.certificate;
        assert!(c.unique);
        assert!(c.t_enclosure.0 <= hit.t && hit.t <= c.t_enclosure.1);
        assert!(c.t_enclosure.1 - c.t_enclosure.0 < 1e-12);
        assert!(c.residual.0 <= 0.0 && 0.0 <= c.residual.1);
        assert!(c.distance_bound < 1e-14);
        assert!(s.eval(hit.uv.x, hit.uv.y).distance(hit.point) < 1e-13);
    }
}

#[test]
fn line_tangent_to_sphere_is_a_double_root() {
    let s: Surface = Sphere::new(Frame::world(), 2.0).expect("s").into();
    let l: Curve3 = Line3::new(Vec3::new(-5.0, 2.0, 0.0), Vec3::unit_x())
        .expect("l")
        .into();
    let h = intersect_curve_surface(&l, (0.0, 10.0), &s, full(&s), &tol()).expect("ok");
    assert_eq!(h.points.len(), 1, "{h:#?}");
    let p = h.points[0];
    assert!(p.contact.is_tangent());
    assert_eq!(p.multiplicity, 2);
    assert!(p.point.distance(Vec3::new(0.0, 2.0, 0.0)) < 1e-6);
    // Grazing by less than fit: still one tangent contact.
    let l: Curve3 = Line3::new(Vec3::new(-5.0, 2.0 - 5e-8, 0.0), Vec3::unit_x())
        .expect("l")
        .into();
    let h = intersect_curve_surface(&l, (0.0, 10.0), &s, full(&s), &tol()).expect("ok");
    assert_eq!(h.points.len(), 1);
    assert!(h.points[0].contact.is_tangent());
    // Missing by more than fit: nothing.
    let l: Curve3 = Line3::new(Vec3::new(-5.0, 2.0 + 1e-6, 0.0), Vec3::unit_x())
        .expect("l")
        .into();
    let h = intersect_curve_surface(&l, (0.0, 10.0), &s, full(&s), &tol()).expect("ok");
    assert!(h.points.is_empty());
}

#[test]
fn line_torus_quartic_four_roots() {
    let t: Surface = Torus::new(Frame::world(), 5.0, 1.0).expect("t").into();
    let l: Curve3 = Line3::new(Vec3::new(-10.0, 0.0, 0.3), Vec3::unit_x())
        .expect("l")
        .into();
    let h = intersect_curve_surface(&l, (0.0, 20.0), &t, full(&t), &tol()).expect("ok");
    assert_eq!(h.points.len(), 4);
    let dz = (1.0f64 - 0.09).sqrt();
    let mut xs: Vec<f64> = vec![-5.0 - dz, -5.0 + dz, 5.0 - dz, 5.0 + dz];
    xs.sort_by(f64::total_cmp);
    for (hit, ex) in h.points.iter().zip(xs) {
        assert!((hit.point.x - ex).abs() < 1e-12, "{} vs {ex}", hit.point.x);
        assert!(hit.certificate.unique);
    }
    // Through the hole along the axis: no hit.
    let l: Curve3 = Line3::new(Vec3::new(0.0, 0.0, -5.0), Vec3::unit_z())
        .expect("l")
        .into();
    let h = intersect_curve_surface(&l, (0.0, 10.0), &t, full(&t), &tol()).expect("ok");
    assert!(h.points.is_empty());
}

#[test]
fn circle_plane_and_circle_torus() {
    let c: Curve3 = Circle3::new(
        frame([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        2.0,
    )
    .expect("c")
    .into();
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.0, 0.0, 1.0), Vec3::unit_z())
        .expect("p")
        .into();
    let h = intersect_curve_surface(&c, (0.0, math::TAU), &pl, full(&pl), &tol()).expect("ok");
    assert_eq!(h.points.len(), 2);
    for p in &h.points {
        assert!((p.point.z - 1.0).abs() < 1e-14);
    }
    // A vertical circle through the torus tube: 4 hits (degree-8 trig polynomial).
    let t: Surface = Torus::new(Frame::world(), 5.0, 1.0).expect("t").into();
    let c: Curve3 = Circle3::new(
        frame([0.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        5.0,
    )
    .expect("c")
    .into();
    let h = intersect_curve_surface(&c, (0.0, math::TAU), &t, full(&t), &tol()).expect("ok");
    assert_eq!(h.points.len(), 4, "{h:#?}");
    for p in &h.points {
        assert!(dist(&t, p.point) < 1e-12);
    }
}

#[test]
fn overlaps_are_reported_and_clipped() {
    let pl: Surface = Plane::new(Frame::world()).into();
    let l: Curve3 = Line3::new(Vec3::new(-5.0, 0.5, 0.0), Vec3::unit_x())
        .expect("l")
        .into();
    let h = intersect_curve_surface(
        &l,
        (0.0, 10.0),
        &pl,
        UvBox::new(-1.0, 2.0, 0.0, 1.0),
        &tol(),
    )
    .expect("ok");
    assert!(h.points.is_empty());
    assert_eq!(h.overlaps.len(), 1);
    let o = h.overlaps[0];
    assert!((o.t_range.0 - 4.0).abs() < 1e-12 && (o.t_range.1 - 7.0).abs() < 1e-12);
    assert!(o.distance_bound <= 1e-7);
    // A circle lying on a cylinder.
    let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
    let c: Curve3 = Circle3::new(
        frame([0.0, 0.0, 1.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        2.0,
    )
    .expect("c")
    .into();
    let h = intersect_curve_surface(
        &c,
        (0.0, math::TAU),
        &cyl,
        UvBox::new(0.0, math::TAU, -3.0, 3.0),
        &tol(),
    )
    .expect("ok");
    assert_eq!(h.overlaps.len(), 1);
    assert!(h.points.is_empty());
}

#[test]
fn domain_filters_hits() {
    let s: Surface = Sphere::new(Frame::world(), 2.0).expect("s").into();
    let l: Curve3 = Line3::new(Vec3::new(-5.0, 0.0, 0.0), Vec3::unit_x())
        .expect("l")
        .into();
    // Only the hemisphere u in [-π/2, π/2] (x > 0).
    let d = UvBox::new(
        -math::FRAC_PI_2,
        math::FRAC_PI_2,
        -math::FRAC_PI_2,
        math::FRAC_PI_2,
    );
    let h = intersect_curve_surface(&l, (0.0, 10.0), &s, d, &tol()).expect("ok");
    assert_eq!(h.points.len(), 1);
    assert!((h.points[0].point.x - 2.0).abs() < 1e-14);
}

#[test]
fn bspline_curve_against_cone_uses_the_certified_search() {
    let k: Surface = Cone::new(Frame::world(), 1.0, 0.5).expect("k").into();
    let c = NurbsCurve3::from_points(
        3,
        vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0],
        &[
            Vec3::new(-4.0, 0.1, 1.0),
            Vec3::new(-1.0, 3.0, 1.2),
            Vec3::new(1.0, -3.0, 1.4),
            Vec3::new(4.0, 0.2, 1.6),
        ],
        None,
    )
    .expect("c");
    let cv: Curve3 = c.into();
    let h = intersect_curve_surface(
        &cv,
        (0.0, 1.0),
        &k,
        UvBox::new(0.0, math::TAU, -2.0, 5.0),
        &tol(),
    )
    .expect("ok");
    assert!(!h.points.is_empty());
    for p in &h.points {
        assert!(dist(&k, p.point) < 1e-12);
        assert!(p.certificate.unique);
    }
    // Completeness: dense sampling finds no sign change outside the reported roots.
    let n = 20_000;
    let mut changes = 0;
    let mut prev = k.distance_form(cv.eval(0.0)).expect("d");
    for i in 1..=n {
        let t = i as f64 / n as f64;
        let v = k.distance_form(cv.eval(t)).expect("d");
        if v.signum() != prev.signum() {
            changes += 1;
        }
        prev = v;
    }
    assert_eq!(changes, h.points.len());
}

#[test]
fn errors_have_codes() {
    let s: Surface = Sphere::new(Frame::world(), 2.0).expect("s").into();
    let l: Curve3 = Line3::new(Vec3::zero(), Vec3::unit_x()).expect("l").into();
    let e = intersect_curve_surface(&l, (1.0, 0.0), &s, full(&s), &tol()).unwrap_err();
    assert_eq!(e.code(), "SSI_INVALID_DOMAIN");
    let e = intersect_curve_surface(&l, (0.0, 1.0), &s, UvBox::new(0.0, 7.0, -1.0, 1.0), &tol())
        .unwrap_err();
    assert_eq!(e.code(), "SSI_INVALID_DOMAIN");
    let bad = SsiTolerance { fit: 0.0, ..tol() };
    let e = intersect_curve_surface(&l, (0.0, 1.0), &s, full(&s), &bad).unwrap_err();
    assert_eq!(e.code(), "SSI_INVALID_TOLERANCE");
}

fn arb_frame() -> impl Strategy<Value = Frame> {
    (
        prop::array::uniform3(-3.0f64..3.0),
        prop::array::uniform3(-1.0f64..1.0),
        prop::array::uniform3(-1.0f64..1.0),
    )
        .prop_filter_map("frame", |(o, n, x)| {
            Frame::from_normal_x(Vec3::from(o), Vec3::from(n), Vec3::from(x))
        })
}

fn arb_surface() -> impl Strategy<Value = Surface> {
    (arb_frame(), 0usize..5, 0.5f64..3.0, 0.2f64..1.2).prop_map(|(f, k, r, a)| match k {
        0 => Plane::new(f).into(),
        1 => Cylinder::new(f, r).expect("c").into(),
        2 => Cone::new(f, r * 0.5, a).expect("k").into(),
        3 => Sphere::new(f, r).expect("s").into(),
        _ => Torus::new(f, r + 1.5, r * 0.5).expect("t").into(),
    })
}

fn arb_curve() -> impl Strategy<Value = (Curve3, (f64, f64))> {
    (arb_frame(), 0usize..3, 0.5f64..4.0, 0.3f64..3.0).prop_map(|(f, k, r, e)| match k {
        0 => (
            Line3::new(f.origin() - f.z() * 8.0, f.z())
                .expect("l")
                .into(),
            (0.0, 16.0),
        ),
        1 => (Circle3::new(f, r).expect("c").into(), (0.0, math::TAU)),
        _ => (Ellipse3::new(f, r, e).expect("e").into(), (0.0, math::TAU)),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(
        std::env::var("PROPTEST_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(160)
    ))]

    /// Every hit lies on both the curve and the surface (certified), and dense sampling of
    /// the distance form finds no sign change that is not near a reported hit.
    #[test]
    fn hits_are_on_the_surface_and_complete((c, range) in arb_curve(), s in arb_surface()) {
        let dom = UvBox::natural(&s, 50.0);
        let h = intersect_curve_surface(&c, range, &s, dom, &tol()).expect("ok");
        for p in &h.points {
            prop_assert!(p.certificate.distance_bound <= 1e-7);
            prop_assert!(dist(&s, p.point) <= 1e-7);
            prop_assert!(s.eval(p.uv.x, p.uv.y).distance(p.point) <= 1e-7);
            prop_assert!(p.t >= range.0 - 1e-9 && p.t <= range.1 + 1e-9);
        }
        if !h.overlaps.is_empty() {
            return Ok(());
        }
        let n = 4000;
        let mut prev = (range.0, s.distance_form(c.eval(range.0)).expect("d"));
        for i in 1..=n {
            let t = range.0 + (range.1 - range.0) * i as f64 / n as f64;
            let v = s.distance_form(c.eval(t)).expect("d");
            if v.signum() != prev.1.signum() && v != 0.0 && prev.1 != 0.0 {
                let near = h.points.iter().any(|p| p.t >= prev.0 - 1e-9 && p.t <= t + 1e-9);
                prop_assert!(near, "missed sign change in [{}, {}]", prev.0, t);
            }
            prev = (t, v);
        }
    }
}
