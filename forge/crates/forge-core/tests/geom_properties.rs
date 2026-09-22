//! Property tests for curves and surfaces: derivatives vs finite differences and dual
//! numbers, projection round trips, normals, NURBS conics, interval enclosures.

use forge_core::geom::{
    Circle3, Cone, Curve3, Cylinder, Ellipse3, Line3, NurbsCurve2, NurbsCurve3, NurbsSurface,
    Plane, Sphere, Surface, Torus,
};
use forge_core::math::{self, PI, TAU};
use forge_core::scalar::{Dual, Interval};
use forge_core::{Frame, Transform, Vec2, Vec3};
use proptest::prelude::*;

// ---- helpers --------------------------------------------------------------------------

fn angle_diff(a: f64, b: f64) -> f64 {
    (math::wrap_angle(a - b + PI, 0.0) - PI).abs()
}

fn vclose(a: Vec3, b: Vec3, tol: f64) -> bool {
    (a - b).norm() <= tol * (1.0 + a.norm().max(b.norm()))
}

fn dual_d(p: Vec3<Dual>) -> Vec3 {
    Vec3::new(p.x.d, p.y.d, p.z.d)
}

fn vec3_strategy(r: f64) -> impl Strategy<Value = Vec3> {
    prop::array::uniform3(-r..r).prop_map(Vec3::from)
}

fn frame_strategy() -> impl Strategy<Value = Frame> {
    (vec3_strategy(10.0), vec3_strategy(1.0), vec3_strategy(1.0)).prop_filter_map(
        "degenerate frame",
        |(o, n, x)| {
            if n.norm() < 0.1 || n.cross(x).norm() < 0.1 * n.norm() * x.norm() {
                return None;
            }
            Frame::from_normal_x(o, n, x)
        },
    )
}

fn sample_nurbs_curve(frame: &Frame) -> NurbsCurve3 {
    let pts = [
        Vec3::new(0.0, 0.0, 0.0),
        Vec3::new(1.0, 2.0, 0.5),
        Vec3::new(2.5, -1.0, 1.0),
        Vec3::new(3.0, 1.5, -0.5),
        Vec3::new(4.5, 0.5, 0.0),
        Vec3::new(5.0, -0.5, 1.0),
    ];
    let world: Vec<Vec3> = pts.iter().map(|p| frame.to_world_point(*p)).collect();
    NurbsCurve3::from_points(
        3,
        vec![0.0, 0.0, 0.0, 0.0, 0.3, 0.7, 1.0, 1.0, 1.0, 1.0],
        &world,
        Some(vec![1.0, 0.7, 1.4, 0.9, 1.2, 1.0]),
    )
    .expect("valid curve")
}

fn bumpy_surface(frame: &Frame) -> NurbsSurface {
    let (nu, nv) = (5, 4);
    let mut pts = Vec::new();
    let mut w = Vec::new();
    for i in 0..nu {
        for j in 0..nv {
            let z = ((i * 7 + j * 3) % 5) as f64 * 0.3 - 0.5;
            pts.push(frame.to_world_point(Vec3::new(i as f64, j as f64 * 1.3, z)));
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

/// An exact NURBS sphere of radius `r` about the origin (poles are collapsed rows).
fn nurbs_sphere(r: f64) -> NurbsSurface {
    let circle = NurbsCurve2::circle_arc(Vec2::zero(), 1.0, 0.0, TAU).expect("circle");
    let meridian = NurbsCurve2::circle_arc(Vec2::zero(), r, -math::FRAC_PI_2, math::FRAC_PI_2)
        .expect("meridian");
    let (cu, cv) = (circle.control_points(), meridian.control_points());
    let mut pts = Vec::new();
    let mut w = Vec::new();
    for (i, c) in cu.iter().enumerate() {
        for (j, m) in cv.iter().enumerate() {
            // Meridian control point (radius, z) swept around the axis.
            pts.push(Vec3::new(c[0] * m[0], c[1] * m[0], m[1]));
            w.push(circle.weight(i) * meridian.weight(j));
        }
    }
    NurbsSurface::new(
        2,
        2,
        circle.knots().to_vec(),
        meridian.knots().to_vec(),
        cu.len(),
        cv.len(),
        pts,
        Some(w),
    )
    .expect("valid NURBS sphere")
}

fn curves(frame: &Frame) -> Vec<Curve3> {
    vec![
        Line3::new(frame.origin(), frame.x() + frame.z() * 0.5)
            .expect("line")
            .into(),
        Circle3::new(*frame, 2.5).expect("circle").into(),
        Ellipse3::new(*frame, 4.0, 1.5).expect("ellipse").into(),
        Ellipse3::new(*frame, 1.0, 3.0).expect("ellipse").into(),
        sample_nurbs_curve(frame).into(),
    ]
}

fn surfaces(frame: &Frame) -> Vec<Surface> {
    vec![
        Plane::new(*frame).into(),
        Cylinder::new(*frame, 3.0).expect("cyl").into(),
        Cone::new(*frame, 2.0, 0.4).expect("cone").into(),
        Cone::new(*frame, 0.0, 1.2).expect("cone at apex").into(),
        Sphere::new(*frame, 4.0).expect("sphere").into(),
        Torus::new(*frame, 5.0, 1.5).expect("torus").into(),
        Torus::new(*frame, 2.0, 2.0).expect("horn torus").into(),
        bumpy_surface(frame).into(),
    ]
}

/// Map a unit-square sample to a sensible parameter for each curve.
fn curve_param(c: &Curve3, s: f64) -> f64 {
    let (a, b) = c.domain();
    if a.is_finite() && b.is_finite() {
        a + (b - a) * s
    } else {
        -5.0 + 10.0 * s
    }
}

/// Map unit-square samples to parameters inside each surface's natural domain.
fn surface_params(s: &Surface, a: f64, b: f64) -> (f64, f64) {
    let ((u0, u1), (v0, v1)) = s.domain();
    let map = |lo: f64, hi: f64, t: f64| {
        if lo.is_finite() && hi.is_finite() {
            lo + (hi - lo) * t
        } else {
            -4.0 + 8.0 * t
        }
    };
    (map(u0, u1, a), map(v0, v1, b))
}

// ---- curves ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn curve_derivatives_match_finite_differences_and_duals(f in frame_strategy(), s in 0.02..0.98f64) {
        for c in curves(&f) {
            let t = curve_param(&c, s);
            let [p, d1, d2] = c.derivs2(t);
            prop_assert!(vclose(p, c.eval(t), 1e-15));
            let h = 1e-6;
            let fd1 = (c.eval(t + h) - c.eval(t - h)) * (0.5 / h);
            prop_assert!(vclose(d1, fd1, 1e-6), "{}: d1 {d1:?} vs {fd1:?}", c.kind_name());
            let fd2 = (c.d1(t + h) - c.d1(t - h)) * (0.5 / h);
            prop_assert!(vclose(d2, fd2, 1e-5), "{}: d2 {d2:?} vs {fd2:?}", c.kind_name());
            let dual = dual_d(c.eval(Dual::variable(t)));
            prop_assert!(vclose(d1, dual, 1e-12), "{}: dual {dual:?} vs {d1:?}", c.kind_name());
        }
    }

    #[test]
    fn curve_projection_round_trips(f in frame_strategy(), s in 0.0..1.0f64) {
        for c in curves(&f) {
            let t = curve_param(&c, s);
            let p = c.eval(t);
            let (tp, d) = c.project(p);
            prop_assert!(d < 1e-9, "{}: distance {d}", c.kind_name());
            prop_assert!(c.eval(tp).distance(p) < 1e-8, "{}", c.kind_name());
            match c.period() {
                Some(_) => prop_assert!(angle_diff(tp, t) < 1e-8, "{}: {tp} vs {t}", c.kind_name()),
                None => prop_assert!((tp - t).abs() < 1e-6, "{}: {tp} vs {t}", c.kind_name()),
            }
        }
    }

    #[test]
    fn curve_projection_is_globally_minimal(f in frame_strategy(), q in vec3_strategy(12.0)) {
        for c in curves(&f) {
            let (tp, d) = c.project(q);
            prop_assert!((c.eval(tp).distance(q) - d).abs() < 1e-9);
            let (a, b) = c.domain();
            let (a, b) = if a.is_finite() { (a, b) } else { (tp - 50.0, tp + 50.0) };
            let n = 4000;
            let best = (0..=n).map(|i| c.eval(a + (b - a) * i as f64 / n as f64).distance(q)).fold(f64::INFINITY, f64::min);
            prop_assert!(d <= best + 1e-9, "{}: {d} vs sampled {best}", c.kind_name());
        }
    }

    #[test]
    fn nurbs_circle_arcs_lie_on_their_circle(f in frame_strategy(), r in 0.01..100.0f64, a0 in -7.0..7.0f64,
                                             sweep in 0.01..TAU, s in 0.0..=1.0f64) {
        let arc = NurbsCurve3::circle_arc(&f, r, a0, a0 + sweep).expect("arc");
        let circle = Circle3::new(f, r).expect("circle");
        let t = a0 + sweep * s;
        let p = arc.eval(t);
        let l = f.to_local_point(p);
        prop_assert!((math::hypot(l.x, l.y) - r).abs() <= 1e-12 * r.max(1.0) + 1e-12);
        prop_assert!(l.z.abs() <= 1e-12 * (1.0 + f.origin().norm()));
        // End points coincide with the circle at the arc's angles.
        prop_assert!(arc.eval(a0).distance(circle.eval(a0)) < 1e-12 * (1.0 + r));
        prop_assert!(arc.eval(a0 + sweep).distance(circle.eval(a0 + sweep)) < 1e-12 * (1.0 + r));
        let c3: Curve3 = arc.into();
        prop_assert!((c3.arc_length(a0, a0 + sweep) - r * sweep).abs() < 1e-9 * (1.0 + r));
    }

    #[test]
    fn nurbs_de_boor_matches_basis_evaluation(f in frame_strategy(), s in 0.0..=1.0f64) {
        let c = sample_nurbs_curve(&f);
        prop_assert!(Vec3::from(c.eval_de_boor(s)).distance(c.eval(s)) < 1e-13 * (1.0 + f.origin().norm()));
    }

    #[test]
    fn nurbs_knot_insertion_preserves_the_curve(f in frame_strategy(), k in 0.01..0.99f64, times in 1usize..=2, s in 0.0..=1.0f64) {
        let c = sample_nurbs_curve(&f);
        let refined = c.insert_knot(k, times).expect("insertion");
        prop_assert!(c.eval(s).distance(refined.eval(s)) < 1e-12);
        let [_, d1, d2] = c.derivs2(s);
        let [_, r1, r2] = refined.derivs2(s);
        prop_assert!(vclose(d1, r1, 1e-9) && vclose(d2, r2, 1e-7));
    }
}

// ---- surfaces -------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn surface_derivatives_match_finite_differences_and_duals(f in frame_strategy(), a in 0.05..0.95f64, b in 0.05..0.95f64) {
        for s in surfaces(&f) {
            let (u, v) = surface_params(&s, a, b);
            let d = s.derivs2(u, v);
            prop_assert!(vclose(d.p, s.eval(u, v), 1e-14));
            let h = 1e-6;
            let fu = (s.eval(u + h, v) - s.eval(u - h, v)) * (0.5 / h);
            let fv = (s.eval(u, v + h) - s.eval(u, v - h)) * (0.5 / h);
            prop_assert!(vclose(d.du, fu, 1e-6), "{} du", s.kind_name());
            prop_assert!(vclose(d.dv, fv, 1e-6), "{} dv", s.kind_name());
            let fuu = (s.du(u + h, v) - s.du(u - h, v)) * (0.5 / h);
            let fuv = (s.du(u, v + h) - s.du(u, v - h)) * (0.5 / h);
            let fvv = (s.dv(u, v + h) - s.dv(u, v - h)) * (0.5 / h);
            prop_assert!(vclose(d.duu, fuu, 1e-5), "{} duu", s.kind_name());
            prop_assert!(vclose(d.duv, fuv, 1e-5), "{} duv", s.kind_name());
            prop_assert!(vclose(d.dvv, fvv, 1e-5), "{} dvv", s.kind_name());
            let du = dual_d(s.eval(Dual::variable(u), Dual::constant(v)));
            let dv = dual_d(s.eval(Dual::constant(u), Dual::variable(v)));
            prop_assert!(vclose(d.du, du, 1e-12) && vclose(d.dv, dv, 1e-12), "{} dual", s.kind_name());
        }
    }

    #[test]
    fn surface_normals_are_unit_and_orthogonal(f in frame_strategy(), a in 0.0..=1.0f64, b in 0.0..=1.0f64) {
        for s in surfaces(&f) {
            let (u, v) = surface_params(&s, a, b);
            let n = s.normal(u, v).expect("normal");
            prop_assert!((n.norm() - 1.0).abs() < 1e-14, "{}", s.kind_name());
            let [_, du, dv] = s.derivs1(u, v);
            prop_assert!(n.dot(du).abs() <= 1e-12 * (1.0 + du.norm()), "{} n·du", s.kind_name());
            prop_assert!(n.dot(dv).abs() <= 1e-12 * (1.0 + dv.norm()), "{} n·dv", s.kind_name());
            // At regular points the normal is normalize(S_u × S_v).
            let cr = du.cross(dv);
            if cr.norm() > 1e-6 * du.norm() * dv.norm() {
                prop_assert!(vclose(n, cr.normalize().expect("regular"), 1e-12), "{} orientation", s.kind_name());
            }
        }
    }

    #[test]
    fn surface_projection_round_trips(f in frame_strategy(), a in 0.0..1.0f64, b in 0.0..1.0f64) {
        for s in surfaces(&f) {
            let (u, v) = surface_params(&s, a, b);
            let p = s.eval(u, v);
            let (up, vp, d) = s.project(p);
            prop_assert!(d < 1e-9 * (1.0 + p.norm()), "{}: d = {d}", s.kind_name());
            prop_assert!(s.eval(up, vp).distance(p) < 1e-8 * (1.0 + p.norm()), "{}", s.kind_name());
            // Parameters agree (modulo periods) away from singular points.
            let singular = match &s {
                Surface::Cone(c) => c.radius_at(v).abs() < 1e-6,
                Surface::Sphere(_) => (v.abs() - math::FRAC_PI_2).abs() < 1e-6,
                Surface::Torus(t) => (t.major() + t.minor() * math::cos(v)).abs() < 1e-6,
                _ => false,
            };
            if !singular {
                let (pu, pv) = s.periodicity();
                let du = if pu.is_some() { angle_diff(up, u) } else { (up - u).abs() };
                let dv = if pv.is_some() { angle_diff(vp, v) } else { (vp - v).abs() };
                prop_assert!(du < 1e-7 && dv < 1e-7, "{}: ({up}, {vp}) vs ({u}, {v})", s.kind_name());
            }
        }
    }

    #[test]
    fn analytic_projection_is_globally_minimal(f in frame_strategy(), q in vec3_strategy(15.0)) {
        for s in surfaces(&f).into_iter().filter(|s| !matches!(s, Surface::BSpline(_) | Surface::Plane(_))) {
            let (up, vp, d) = s.project(q);
            prop_assert!((s.eval(up, vp).distance(q) - d).abs() < 1e-9 * (1.0 + q.norm()), "{}", s.kind_name());
            let ((u0, u1), (v0, v1)) = s.domain();
            let (v0, v1) = if v0.is_finite() { (v0, v1) } else { (vp - 30.0, vp + 30.0) };
            let n = 120;
            let mut best = f64::INFINITY;
            for i in 0..=n {
                for j in 0..=n {
                    let (uu, vv) = (u0 + (u1 - u0) * i as f64 / n as f64, v0 + (v1 - v0) * j as f64 / n as f64);
                    best = best.min(s.eval(uu, vv).distance(q));
                }
            }
            prop_assert!(d <= best + 1e-9, "{}: {d} vs sampled {best}", s.kind_name());
        }
    }

    #[test]
    fn transformed_surfaces_move_their_points(f in frame_strategy(), axis in vec3_strategy(1.0), ang in -3.0..3.0f64,
                                              shift in vec3_strategy(5.0), a in 0.0..1.0f64, b in 0.0..1.0f64) {
        prop_assume!(axis.norm() > 0.1);
        let t = Transform::rotation_about_axis(shift, axis, ang).expect("axis").then(&Transform::translation(shift));
        for s in surfaces(&f) {
            let (u, v) = surface_params(&s, a, b);
            let st = s.transform(&t);
            prop_assert!(st.eval(u, v).distance(t.transform_point(s.eval(u, v))) < 1e-12 * (1.0 + s.eval(u, v).norm()));
        }
    }

    #[test]
    fn interval_evaluation_encloses_f64_evaluation(f in frame_strategy(), a in 0.0..1.0f64, b in 0.0..1.0f64) {
        for s in surfaces(&f) {
            let (u, v) = surface_params(&s, a, b);
            let p = s.eval(u, v);
            let pi = s.eval(Interval::point(u), Interval::point(v));
            prop_assert!(pi.x.contains(p.x) && pi.y.contains(p.y) && pi.z.contains(p.z), "{}", s.kind_name());
        }
        for c in curves(&f) {
            let t = curve_param(&c, a);
            let p = c.eval(t);
            let pi = c.eval(Interval::point(t));
            prop_assert!(pi.x.contains(p.x) && pi.y.contains(p.y) && pi.z.contains(p.z), "{}", c.kind_name());
        }
    }
}

// ---- deterministic geometry checks ----------------------------------------------------

#[test]
fn nurbs_sphere_is_exact_and_has_limit_normals_at_its_poles() {
    let r = 3.0;
    let s: Surface = nurbs_sphere(r).into();
    let ((u0, u1), (v0, v1)) = s.domain();
    for i in 0..=20 {
        for j in 0..=20 {
            let (u, v) = (
                u0 + (u1 - u0) * i as f64 / 20.0,
                v0 + (v1 - v0) * j as f64 / 20.0,
            );
            let p = s.eval(u, v);
            assert!(
                (p.norm() - r).abs() < 1e-12,
                "({u}, {v}): |p| = {}",
                p.norm()
            );
            let n = s
                .normal(u, v)
                .expect("normal defined everywhere, including the poles");
            assert!(
                (n - p * (1.0 / r)).norm() < 1e-9,
                "({u}, {v}): n = {n:?}, p = {p:?}"
            );
        }
    }
}

#[test]
fn cone_projection_handles_both_nappes_and_the_apex() {
    let c = Cone::new(Frame::world(), 1.0, 0.5).expect("cone");
    let apex = c.apex();
    let (_, v, d) = c.project(apex);
    assert!(d < 1e-15 && (v - c.apex_v()).abs() < 1e-15);
    // A point on the opposite nappe (below the apex) projects onto it.
    let p = c.eval(0.3, c.apex_v() - 2.0);
    let (u, v, d) = c.project(p);
    assert!(d < 1e-12 && (u - 0.3).abs() < 1e-12 && (v - (c.apex_v() - 2.0)).abs() < 1e-12);
    // The normal flips on the opposite nappe and is continuous up to the apex.
    let n_apex = c.normal(0.3, c.apex_v());
    let n_near = c.normal(0.3, c.apex_v() + 1e-9);
    assert!((n_apex - n_near).norm() < 1e-15);
    assert!((c.normal(0.3, c.apex_v() - 1.0) + n_near).norm() < 1e-15);
}

#[test]
fn sphere_normals_at_poles_are_axis_directions() {
    let f = Frame::from_normal_x(
        Vec3::new(1.0, 2.0, 3.0),
        Vec3::new(0.0, 1.0, 1.0),
        Vec3::unit_x(),
    )
    .expect("frame");
    let s = Sphere::new(f, 2.0).expect("sphere");
    for u in [0.0, 1.0, 4.0] {
        assert!((s.normal(u, math::FRAC_PI_2) - f.z()).norm() < 1e-15);
        assert!((s.normal(u, -math::FRAC_PI_2) + f.z()).norm() < 1e-15);
    }
    let (u, v, d) = s.project(f.origin() + f.z() * 5.0);
    assert!(u.abs() == 0.0 && (v - math::FRAC_PI_2).abs() < 1e-15 && (d - 3.0).abs() < 1e-15);
}

#[test]
fn bspline_surface_projection_of_off_surface_points_is_minimal() {
    let s = bumpy_surface(&Frame::world());
    for q in [
        Vec3::new(1.5, 2.0, 3.0),
        Vec3::new(-1.0, -1.0, 0.0),
        Vec3::new(2.2, 1.1, -0.4),
        Vec3::new(5.0, 5.0, 5.0),
    ] {
        let (u, v, d) = s.project(q);
        assert!((s.eval(u, v).distance(q) - d).abs() < 1e-12);
        let mut best = f64::INFINITY;
        for i in 0..=300 {
            for j in 0..=300 {
                best = best.min(s.eval(i as f64 / 300.0, j as f64 / 300.0).distance(q));
            }
        }
        assert!(d <= best + 1e-9, "{q:?}: {d} vs sampled {best}");
    }
}

#[test]
fn surface_kind_names_and_periodicity() {
    let f = Frame::world();
    let names: Vec<_> = surfaces(&f).iter().map(|s| s.kind_name()).collect();
    assert_eq!(
        names,
        [
            "plane", "cylinder", "cone", "cone", "sphere", "torus", "torus", "bspline"
        ]
    );
    assert_eq!(
        Surface::from(Torus::new(f, 3.0, 1.0).expect("torus")).periodicity(),
        (Some(TAU), Some(TAU))
    );
    assert_eq!(
        Surface::from(Sphere::new(f, 1.0).expect("sphere")).periodicity(),
        (Some(TAU), None)
    );
    let cnames: Vec<_> = curves(&f).iter().map(|c| c.kind_name()).collect();
    assert_eq!(cnames, ["line", "circle", "ellipse", "ellipse", "bspline"]);
}

#[test]
fn invalid_geometry_is_rejected_with_codes() {
    let f = Frame::world();
    assert_eq!(
        Cylinder::new(f, -1.0).unwrap_err().code(),
        "GEOM_INVALID_PARAMETER"
    );
    assert_eq!(
        Cone::new(f, 1.0, 0.0).unwrap_err().code(),
        "GEOM_INVALID_PARAMETER"
    );
    assert_eq!(
        Cone::new(f, 1.0, math::FRAC_PI_2).unwrap_err().code(),
        "GEOM_INVALID_PARAMETER"
    );
    assert_eq!(
        Torus::new(f, 1.0, 2.0).unwrap_err().code(),
        "GEOM_INVALID_PARAMETER"
    );
    assert_eq!(
        Line3::new(Vec3::zero(), Vec3::zero()).unwrap_err().code(),
        "GEOM_DEGENERATE_DIRECTION"
    );
    assert_eq!(
        Circle3::new(f, f64::NAN).unwrap_err().code(),
        "GEOM_INVALID_PARAMETER"
    );
    let bad = NurbsCurve3::from_points(
        2,
        vec![0.0, 0.0, 1.0, 1.0],
        &[Vec3::zero(), Vec3::unit_x()],
        None,
    );
    assert_eq!(bad.unwrap_err().code(), "NURBS_TOO_FEW_CONTROL_POINTS");
}
