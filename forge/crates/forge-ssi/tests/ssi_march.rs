//! Marched (general-position) surface–surface intersections.

mod common;

use common::{check_contract, frame, missed_samples, natural, total_length};
use forge_core::geom::{Cone, Cylinder, Plane, Sphere, Surface, Torus};
use forge_core::math;
use forge_core::{Frame, Vec3};
use forge_ssi::{Method, Representation, SsiTolerance, UvBox, VertexKind, intersect_surfaces};

fn tol() -> SsiTolerance {
    SsiTolerance::default()
}

#[test]
fn skew_cylinders_give_two_closed_loops_or_one() {
    let a: Surface = Cylinder::new(Frame::world(), 2.0).expect("a").into();
    // Axis along x, offset 0.5 in y: the small cylinder pierces the big one twice.
    let b: Surface = Cylinder::new(
        frame([0.0, 0.5, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        1.0,
    )
    .expect("b")
    .into();
    let da = UvBox::new(0.0, math::TAU, -6.0, 6.0);
    let g = intersect_surfaces(&a, da, &b, da, &tol()).expect("ok");
    assert_eq!(g.method, Method::Marching);
    assert_eq!(g.branches.len(), 2, "{:#?}", g.stats);
    assert!(
        g.branches
            .iter()
            .all(|b| b.closed && b.representation == Representation::Fitted)
    );
    assert!(g.certified_complete);
    check_contract(&g, &a, &b, 1e-7);
    assert_eq!(missed_samples(&g, &a, &da, &b, &da, 200, 0.05), 0);
    // The two loops are mirror images: equal lengths.
    let l0 = common::samples(&g.branches[0], 4000)
        .windows(2)
        .map(|w| w[0].1.distance(w[1].1))
        .sum::<f64>();
    let l1 = common::samples(&g.branches[1], 4000)
        .windows(2)
        .map(|w| w[0].1.distance(w[1].1))
        .sum::<f64>();
    assert!((l0 - l1).abs() < 1e-5, "{l0} vs {l1}");
}

/// Length of the section of the torus `(R, r)` (world frame) by the plane through the
/// origin with normal `n`, computed independently of forge-ssi: for each torus angle `u`
/// the meridian circle meets the plane where `a·cos v + b·sin v = c` (two closed-form
/// solutions); chord sums over a dense `u` grid on both solution branches, closed by the
/// chord between the branches at each turning point.
fn torus_section_length(big: f64, small: f64, n: Vec3, samples: usize) -> f64 {
    let point = |u: f64, v: f64| {
        let (su, cu) = math::sin_cos(u);
        let (sv, cv) = math::sin_cos(v);
        Vec3::new((big + small * cv) * cu, (big + small * cv) * su, small * sv)
    };
    let sol = |u: f64| {
        let (su, cu) = math::sin_cos(u);
        let ne = n.x * cu + n.y * su;
        let (a, b, c) = (small * ne, small * n.z, -big * ne);
        let rho = a.hypot(b);
        let q = c / rho;
        (q.abs() <= 1.0).then(|| {
            let phi = math::atan2(b, a);
            let w = math::acos(q);
            [point(u, phi + w), point(u, phi - w)]
        })
    };
    let mut total = 0.0;
    let mut prev: Option<[Vec3; 2]> = None;
    for i in 0..=samples {
        let u = math::TAU * i as f64 / samples as f64;
        let cur = sol(u);
        match (prev, cur) {
            (Some(p), Some(c)) => total += p[0].distance(c[0]) + p[1].distance(c[1]),
            (Some(p), None) => total += p[0].distance(p[1]),
            (None, Some(c)) if i > 0 => total += c[0].distance(c[1]),
            _ => {}
        }
        prev = cur;
    }
    total
}

#[test]
fn near_villarceau_plane_is_marched_without_missing_or_merging_branches() {
    // Ring torus R = 5, r = 3, plane through the centre tilted 1e-3 rad off the
    // bitangent angle asin(r/R): no longer tangent anywhere, the section is two separate
    // closed loops that pass within ~1e-2 of each other near the former tangency points
    // (steeper: two symmetric loops; shallower: two nested loops).
    let (big, small) = (5.0f64, 3.0f64);
    let t: Surface = Torus::new(Frame::world(), big, small).expect("t").into();
    for dth in [1e-3, -1e-3] {
        let th = math::asin(small / big) + dth;
        let n = Vec3::new(0.0, -math::sin(th), math::cos(th));
        let pl: Surface = Plane::from_point_normal(Vec3::zero(), n).expect("p").into();
        let dp = natural(&pl, 12.0);
        let dt = natural(&t, 0.0);
        let g = intersect_surfaces(&pl, dp, &t, dt, &tol()).expect("ok");
        assert_eq!(g.method, Method::Marching);
        assert!(g.certified_complete);
        check_contract(&g, &pl, &t, 1e-7);
        assert_eq!(g.branches.len(), 2, "{:#?}", g.vertices);
        assert!(g.branches.iter().all(|b| b.closed));
        assert!(g.vertices.is_empty(), "{:#?}", g.vertices);
        let len = total_length(&g);
        let reference = torus_section_length(big, small, n, 400_000);
        assert!(
            (len - reference).abs() < 1e-4,
            "length {len} vs {reference}"
        );
        assert_eq!(missed_samples(&g, &pl, &dp, &t, &dt, 240, 0.05), 0);
        assert_eq!(missed_samples(&g, &t, &dt, &pl, &dp, 240, 0.05), 0);
    }
}

#[test]
fn sphere_off_axis_cylinder_single_loop() {
    let c: Surface = Cylinder::new(Frame::world(), 1.0).expect("c").into();
    let s: Surface = Sphere::new(
        frame([1.2, 0.0, 0.3], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        1.5,
    )
    .expect("s")
    .into();
    let dc = UvBox::new(0.0, math::TAU, -4.0, 4.0);
    let ds = natural(&s, 0.0);
    let g = intersect_surfaces(&c, dc, &s, ds, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 1, "{g:#?}");
    assert!(g.branches[0].closed);
    check_contract(&g, &c, &s, 1e-7);
    assert_eq!(missed_samples(&g, &c, &dc, &s, &ds, 200, 0.05), 0);
}

#[test]
fn plane_tangent_to_torus_side_gives_tangent_point() {
    let t: Surface = Torus::new(Frame::world(), 5.0, 1.0).expect("t").into();
    // Tangent to the outer equator at (6, 0, 0), plane x = 6.
    let pl: Surface = Plane::from_point_normal(Vec3::new(6.0, 0.0, 0.0), Vec3::unit_x())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 10.0), &t, natural(&t, 0.0), &tol()).expect("ok");
    assert!(g.branches.is_empty(), "{g:#?}");
    assert_eq!(g.tangent_points().count(), 1);
    let v = g.tangent_points().next().expect("v");
    assert!(v.point.distance(Vec3::new(6.0, 0.0, 0.0)) < 1e-6, "{v:?}");
}

#[test]
fn torus_sphere_general_position() {
    let t: Surface = Torus::new(
        frame([0.0, 0.0, 0.0], [0.1, 0.2, 1.0], [1.0, 0.0, 0.0]),
        4.0,
        1.0,
    )
    .expect("t")
    .into();
    let s: Surface = Sphere::new(
        frame([3.5, 1.0, 0.5], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        1.4,
    )
    .expect("s")
    .into();
    let dt = natural(&t, 0.0);
    let ds = natural(&s, 0.0);
    let g = intersect_surfaces(&t, dt, &s, ds, &tol()).expect("ok");
    assert!(!g.branches.is_empty());
    check_contract(&g, &t, &s, 1e-7);
    assert_eq!(missed_samples(&g, &t, &dt, &s, &ds, 240, 0.05), 0);
    assert_eq!(missed_samples(&g, &s, &ds, &t, &dt, 240, 0.05), 0);
}

#[test]
fn cone_cone_general_position() {
    let a: Surface = Cone::new(Frame::world(), 1.0, 0.4).expect("a").into();
    let b: Surface = Cone::new(
        frame([0.5, 0.2, 1.0], [1.0, 0.3, 0.2], [0.0, 1.0, 0.0]),
        0.8,
        0.3,
    )
    .expect("b")
    .into();
    let da = UvBox::new(0.0, math::TAU, -1.0, 5.0);
    let db = UvBox::new(0.0, math::TAU, -1.5, 5.0);
    let g = intersect_surfaces(&a, da, &b, db, &tol()).expect("ok");
    assert!(!g.branches.is_empty());
    check_contract(&g, &a, &b, 1e-7);
    assert_eq!(missed_samples(&g, &a, &da, &b, &db, 240, 0.05), 0);
}

#[test]
fn partial_domains_clip_branches_with_boundary_vertices() {
    let a: Surface = Cylinder::new(Frame::world(), 2.0).expect("a").into();
    let b: Surface = Cylinder::new(
        frame([0.0, 0.3, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        1.0,
    )
    .expect("b")
    .into();
    // Half of a's circumference only.
    let da = UvBox::new(0.0, math::PI, -6.0, 6.0);
    let db = UvBox::new(0.0, math::TAU, -6.0, 6.0);
    let g = intersect_surfaces(&a, da, &b, db, &tol()).expect("ok");
    assert!(!g.branches.is_empty());
    assert!(g.branches.iter().all(|b| !b.closed));
    assert!(
        g.vertices
            .iter()
            .all(|v| v.kind == VertexKind::DomainBoundary && v.on_boundary_a)
    );
    check_contract(&g, &a, &b, 1e-7);
    assert_eq!(missed_samples(&g, &a, &da, &b, &db, 200, 0.05), 0);
}

/// Near-degenerate configurations just outside the closed-form snap distance (`0.1·fit`
/// over the problem size): the result is either correct and complete (contract +
/// missed-branch detector both ways) or a structured error — never silently wrong.
///
/// Known limitation (docs/spikes/03-ssi.md, open issues): two equal cylinders whose
/// axes miss by `fit < δ < ~1e-4` form a near-crossing whose four branch ends are
/// resolved as one singular vertex instead of two pass-throughs, and the sphere-in-
/// cylinder lens at `δ = 1e-6` has tips too sharp for the fitter; both return
/// `SSI_NOT_CONVERGED`. Every other configuration here must succeed.
#[test]
fn near_degenerate_configurations_are_correct_or_explicit() {
    let cases = |delta: f64| -> Vec<(&'static str, Surface, UvBox, Surface, UvBox)> {
        let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
        let dc = UvBox::new(0.0, math::TAU, -4.0, 4.0);
        // Sphere of the cylinder's radius, centre `delta` off the axis: pokes out by delta.
        let sph: Surface = Sphere::new(
            frame([delta, 0.0, 0.3], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            2.0,
        )
        .expect("s")
        .into();
        // Equal cylinders whose axes miss each other by delta.
        let cyl2: Surface = Cylinder::new(
            frame([0.0, delta, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            2.0,
        )
        .expect("c2")
        .into();
        // Sphere touching a torus from outside, pushed in by delta.
        let tor: Surface = Torus::new(Frame::world(), 4.0, 1.0).expect("t").into();
        let st: Surface = Sphere::new(
            frame([6.5 - delta, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            1.5,
        )
        .expect("st")
        .into();
        vec![
            (
                "sphere in cylinder, off axis",
                cyl.clone(),
                dc,
                sph.clone(),
                natural(&sph, 0.0),
            ),
            ("equal cylinders, skew axes", cyl.clone(), dc, cyl2, dc),
            (
                "sphere pushed into torus",
                tor.clone(),
                natural(&tor, 0.0),
                st.clone(),
                natural(&st, 0.0),
            ),
        ]
    };
    // Near-crossings (equal cylinders) are resolved by orientation-locked tracing and
    // pass-through pairing (open issue 1, closed): every δ must succeed. The sphere in the
    // cylinder is a thin lens whose hairpin tips (radius δ) are traced down to δ = 1e-6;
    // below that the tips fall under the rounding of the distance form and the lens is a
    // tangent band within a few times the fit tolerance (open issue 2: ridge tracer).
    let known_hard = |name: &str, delta: f64| {
        name.starts_with("sphere in cylinder") && (1e-8..1e-6).contains(&delta)
    };
    // The δ = 1e-7 lens takes seconds (open issue: tangent bands); debug builds run a
    // subset.
    let deltas: &[f64] = if cfg!(debug_assertions) {
        &[1e-9, 1e-5, 1e-3]
    } else {
        &[1e-9, 2e-8, 1e-7, 1e-6, 1e-5, 3e-5, 1e-4, 1e-3]
    };
    for &delta in deltas {
        for (name, a, da, b, db) in cases(delta) {
            match intersect_surfaces(&a, da, &b, db, &tol()) {
                Ok(g) => {
                    check_contract(&g, &a, &b, 1e-7);
                    let m1 = missed_samples(&g, &a, &da, &b, &db, 200, 0.05);
                    let m2 = missed_samples(&g, &b, &db, &a, &da, 200, 0.05);
                    eprintln!(
                        "{name} δ={delta:e}: {:?}, {} branches, {} vertices ({} tangent), certified {}, missed {m1}/{m2}",
                        g.method,
                        g.branches.len(),
                        g.vertices.len(),
                        g.tangent_points().count(),
                        g.certified_complete
                    );
                    assert_eq!((m1, m2), (0, 0), "{name} δ={delta:e}");
                }
                Err(e) => {
                    eprintln!("{name} δ={delta:e}: error {} ({e})", e.code());
                    assert!(e.code().starts_with("SSI_"));
                    assert!(known_hard(name, delta), "{name} δ={delta:e}: {e}");
                }
            }
        }
    }
}

/// A closed curve that touches the domain's periodic edge `u = π` and the line `u = 0`
/// tangentially (a hole's cylinder under a wide cylinder whose lowest line passes through the
/// hole's axis) is traced exactly once (it was traced twice around, one closed branch of
/// double length).
#[test]
fn oval_touching_the_window_edge_is_traced_once() {
    let hole: Surface = Cylinder::new(
        frame([-2.5, -0.75, -1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        0.5,
    )
    .expect("hole")
    .into();
    let wide: Surface = Cylinder::new(
        frame([3.25, 0.0, 3.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
        4.0,
    )
    .expect("wide")
    .into();
    let da = UvBox::new(math::PI, 3.0 * math::PI, -1.05e-5, 9.500_010_5);
    let db = UvBox::new(math::PI, 3.0 * math::PI, -8e-6, 7.000_008);
    let g = intersect_surfaces(&hole, da, &wide, db, &tol()).expect("ssi");
    check_contract(&g, &hole, &wide, 1e-7);
    assert_eq!(g.branches.len(), 1, "{g:?}");
    let br = &g.branches[0];
    assert!(br.closed);
    // The oval x = 3.25 ± sqrt(4 sin u − sin²u / 4) on the hole (u ∈ [0, π]), by quadrature.
    let n = 20_000;
    let mut exact = 0.0;
    for side in [-1.0, 1.0] {
        let mut prev: Option<Vec3> = None;
        for i in 0..=n {
            let u = math::PI * i as f64 / n as f64;
            let (s, c) = math::sin_cos(u);
            let w = math::sqrt((4.0 * s - 0.25 * s * s).max(0.0));
            let p = Vec3::new(3.25 + side * w, -0.75 + 0.5 * c, -1.0 + 0.5 * s);
            if let Some(q) = prev {
                exact += (p - q).norm();
            }
            prev = Some(p);
        }
    }
    let len = br.curve.arc_length(br.range.0, br.range.1);
    assert!(
        (len - exact).abs() <= 1e-3 * exact,
        "length {len} vs {exact}"
    );
}

/// A cone whose apex lies on a cylinder, the cone's domain starting at the apex (a revolved
/// triangle against a tube's inner wall): the curve through the apex is traced and fitted
/// without non-finite values.
#[test]
fn cone_apex_on_a_cylinder_is_finite() {
    let cyl: Surface = Cylinder::new(
        frame([0.5, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]),
        0.5,
    )
    .expect("c")
    .into();
    let cone: Surface = Cone::new(
        frame([1.0, 0.0, -3.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        3.5,
        1.165_904_540_509_813_2,
    )
    .expect("k")
    .into();
    let dc = UvBox::new(
        math::PI,
        3.0 * math::PI,
        -3.500_007_283_185_307_7,
        -0.999_992_716_814_692_7,
    );
    let dk = UvBox::new(math::PI, 3.0 * math::PI, -1.5, 7.283_185_307_179_585_6e-6);
    let g = intersect_surfaces(&cyl, dc, &cone, dk, &tol()).expect("ssi");
    check_contract(&g, &cyl, &cone, 1e-7);
    assert!(!g.branches.is_empty());
    for br in &g.branches {
        let (t0, t1) = br.range;
        for i in 0..=64 {
            let t = t0 + (t1 - t0) * i as f64 / 64.0;
            assert!(br.curve.eval(t).is_finite(), "{br:?}");
        }
    }
}

/// A plane parallel to a sphere's axis (the section circle is no latitude): the sphere's
/// pcurve of the circle must follow the circle (it was a straight segment in (u, v) far
/// outside the sphere's parameter range).
#[test]
fn plane_parallel_to_sphere_axis_has_exact_pcurves() {
    let pl: Surface = Plane::new(frame([0.0, -1.5, 0.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0])).into();
    let sp: Surface = Sphere::new(
        frame([0.0, 0.5, 3.5], [0.0, 0.0, 1.0], [-1.0, 0.0, 0.0]),
        2.5,
    )
    .expect("s")
    .into();
    let dp = UvBox::new(-2.000_009, 2.000_009, -2.000_009, 6.000_009);
    let ds = UvBox::new(0.0, math::TAU, -math::FRAC_PI_2, math::FRAC_PI_2);
    let g = intersect_surfaces(&pl, dp, &sp, ds, &tol()).expect("ssi");
    check_contract(&g, &pl, &sp, 1e-7);
    assert!(!g.branches.is_empty());
    for br in &g.branches {
        let (t0, t1) = br.range;
        for i in 0..=256 {
            let t = t0 + (t1 - t0) * i as f64 / 256.0;
            let p = br.curve.eval(t);
            let a = br.pcurve_a.eval(t);
            let b = br.pcurve_b.eval(t);
            assert!(pl.eval(a.x, a.y).distance(p) <= 1e-7, "pcurve a at {t}");
            assert!(
                sp.eval(b.x, b.y).distance(p) <= 1e-7,
                "pcurve b at {t}: {b:?}"
            );
            assert!(
                b.y.abs() <= math::FRAC_PI_2 + 1e-9,
                "v out of range at {t}: {b:?}"
            );
        }
    }
}
