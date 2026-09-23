//! Closed-form surface–surface intersections against known answers.

mod common;

use common::{check_contract, frame, natural, total_length};
use forge_core::geom::{Cone, Cylinder, Plane, Sphere, SpindlePatch, Surface, Torus};
use forge_core::math;
use forge_core::{Frame, Vec3};
use forge_ssi::{
    Contact, Method, Representation, SsiTolerance, UvBox, VertexKind, intersect_surfaces,
};

fn tol() -> SsiTolerance {
    SsiTolerance::default()
}

#[test]
fn plane_sphere_circle_has_radius_sqrt_r2_minus_d2() {
    let s: Surface = Sphere::new(
        frame([1.0, 2.0, 3.0], [0.2, 0.1, 1.0], [1.0, 0.0, 0.0]),
        5.0,
    )
    .expect("s")
    .into();
    let d = 3.0;
    let n = Vec3::new(0.3, -0.4, 0.8).normalize().expect("n");
    let pl: Surface = Plane::from_point_normal(Vec3::new(1.0, 2.0, 3.0) + n * d, n)
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 20.0), &s, natural(&s, 0.0), &tol()).expect("ok");
    assert_eq!(g.method, Method::CommonAxis);
    assert_eq!(g.branches.len(), 1, "{g:#?}");
    let b = &g.branches[0];
    assert!(b.closed && b.representation == Representation::Exact);
    let expect = (25.0f64 - 9.0).sqrt();
    assert!((total_length(&g) - math::TAU * expect).abs() < 1e-9);
    check_contract(&g, &pl, &s, 1e-7);
    // Plane pcurve is an exact ellipse (circle), sphere pcurve fitted or exact.
    assert_eq!(b.pcurve_a.kind_name(), "ellipse");
}

#[test]
fn plane_tangent_to_sphere_gives_one_tangent_point() {
    let s: Surface = Sphere::new(Frame::world(), 2.0).expect("s").into();
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.0, 0.0, 2.0), Vec3::new(0.0, 0.0, 1.0))
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 10.0), &s, natural(&s, 0.0), &tol()).expect("ok");
    assert!(g.branches.is_empty());
    assert_eq!(g.vertices.len(), 1, "{g:#?}");
    let v = &g.vertices[0];
    assert!(v.contact.is_tangent());
    assert!(v.point.distance(Vec3::new(0.0, 0.0, 2.0)) < 1e-12);
}

#[test]
fn plane_through_sphere_axis_is_split_at_the_poles() {
    let s: Surface = Sphere::new(Frame::world(), 2.0).expect("s").into();
    let pl: Surface = Plane::from_point_normal(Vec3::zero(), Vec3::new(1.0, 1.0, 0.0))
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 10.0), &s, natural(&s, 0.0), &tol()).expect("ok");
    assert_eq!(g.branches.len(), 2, "{g:#?}");
    assert!(g.branches.iter().all(|b| !b.closed));
    assert_eq!(
        g.vertices
            .iter()
            .filter(|v| v.kind == VertexKind::SurfaceSingularity)
            .count(),
        2
    );
    check_contract(&g, &pl, &s, 1e-7);
}

#[test]
fn sphere_sphere_circle_point_and_coincidence() {
    let a: Surface = Sphere::new(Frame::world(), 3.0).expect("a").into();
    let b: Surface = Sphere::new(
        frame([4.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        2.0,
    )
    .expect("b")
    .into();
    let g = intersect_surfaces(&a, natural(&a, 0.0), &b, natural(&b, 0.0), &tol()).expect("ok");
    assert_eq!(g.branches.len(), 1);
    // x = (d² + r1² − r2²)/(2d) = (16 + 9 − 4)/8 = 2.625, ρ = √(9 − x²)
    let rho = (9.0f64 - 2.625 * 2.625).sqrt();
    assert!((total_length(&g) - math::TAU * rho).abs() < 1e-9);
    check_contract(&g, &a, &b, 1e-7);

    // External tangency.
    let c: Surface = Sphere::new(
        frame([5.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        2.0,
    )
    .expect("c")
    .into();
    let g = intersect_surfaces(&a, natural(&a, 0.0), &c, natural(&c, 0.0), &tol()).expect("ok");
    assert!(g.branches.is_empty());
    assert_eq!(g.tangent_points().count(), 1);

    // Coincident spheres with different frames.
    let d: Surface = Sphere::new(
        frame([0.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
        3.0,
    )
    .expect("d")
    .into();
    let g = intersect_surfaces(&a, natural(&a, 0.0), &d, natural(&d, 0.0), &tol()).expect("ok");
    assert!(g.coincidence.is_some());
}

#[test]
fn plane_cylinder_lines_tangent_line_and_ellipse() {
    let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
    let dom = UvBox::new(0.0, math::TAU, -5.0, 5.0);
    // Parallel to the axis at distance 1: two lines.
    let pl: Surface = Plane::from_point_normal(Vec3::new(1.0, 0.0, 0.0), Vec3::unit_x())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 10.0), &cyl, dom, &tol()).expect("ok");
    assert_eq!(g.method, Method::CommonExtrusion);
    assert_eq!(g.branches.len(), 2);
    for b in &g.branches {
        assert!((b.range.1 - b.range.0 - 10.0).abs() < 1e-9, "{:?}", b.range);
    }
    check_contract(&g, &pl, &cyl, 1e-7);
    // Tangent plane: one tangent line.
    let pl: Surface = Plane::from_point_normal(Vec3::new(2.0, 0.0, 0.0), Vec3::unit_x())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 10.0), &cyl, dom, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 1);
    assert!(g.branches[0].contact.is_tangent());
    // Oblique plane: ellipse with ry = r / cos θ.
    let n = Vec3::new(0.0, 0.6, 0.8);
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.0, 0.0, 0.5), n)
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 10.0), &cyl, dom, &tol()).expect("ok");
    assert_eq!(g.method, Method::PlaneCylinder);
    assert_eq!(g.branches.len(), 1);
    assert!(g.branches[0].closed);
    match &g.branches[0].curve {
        forge_core::geom::Curve3::Ellipse(e) => {
            assert!((e.rx() - 2.0).abs() < 1e-12 && (e.ry() - 2.0 / 0.8).abs() < 1e-12);
        }
        c => panic!("expected an ellipse, got {}", c.kind_name()),
    }
    check_contract(&g, &pl, &cyl, 1e-7);
}

#[test]
fn plane_cone_conics_and_line_pairs() {
    let cone: Surface = Cone::new(Frame::world(), 1.0, 0.5).expect("k").into();
    let apex_v = -1.0 / math::tan(0.5);
    let dom = UvBox::new(0.0, math::TAU, apex_v + 0.01, 6.0);
    let dom_both = UvBox::new(0.0, math::TAU, apex_v - 6.0, 6.0);
    // Ellipse.
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.0, 0.0, 2.0), Vec3::new(0.2, 0.0, 1.0))
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 30.0), &cone, dom, &tol()).expect("ok");
    assert_eq!(g.method, Method::PlaneCone);
    assert_eq!(g.branches.len(), 1);
    assert_eq!(g.branches[0].curve.kind_name(), "ellipse");
    check_contract(&g, &pl, &cone, 1e-7);
    // Hyperbola: plane parallel to the axis, both nappes.
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.5, 0.0, 0.0), Vec3::unit_x())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 30.0), &cone, dom_both, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 2, "{g:#?}");
    assert!(g.branches.iter().all(|b| b.curve.kind_name() == "bspline"));
    check_contract(&g, &pl, &cone, 1e-7);
    // Parabola: plane parallel to a generator.
    let a = 0.5f64;
    let n = Vec3::new(math::cos(a), 0.0, -math::sin(a));
    let pl: Surface = Plane::from_point_normal(Vec3::new(1.5, 0.0, 0.0), n)
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 30.0), &cone, dom_both, &tol()).expect("ok");
    assert!(!g.branches.is_empty());
    check_contract(&g, &pl, &cone, 1e-7);
    // Plane through the apex containing the axis: two generator lines, split at the apex.
    let apex = Vec3::new(0.0, 0.0, apex_v);
    let pl: Surface = Plane::from_point_normal(apex, Vec3::unit_y())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 30.0), &cone, dom_both, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 4, "{g:#?}");
    assert!(
        g.vertices
            .iter()
            .any(|v| v.kind == VertexKind::SurfaceSingularity && v.point.distance(apex) < 1e-9)
    );
    check_contract(&g, &pl, &cone, 1e-7);
    // Plane through the apex missing the cone elsewhere: the apex alone.
    let pl: Surface = Plane::from_point_normal(apex, Vec3::new(0.1, 0.0, 1.0))
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 30.0), &cone, dom_both, &tol()).expect("ok");
    assert!(g.branches.is_empty());
    assert_eq!(g.vertices.len(), 1);
}

#[test]
fn plane_torus_parallels_meridians_and_tangent_circle() {
    let t: Surface = Torus::new(Frame::world(), 5.0, 1.5).expect("t").into();
    let dom = natural(&t, 0.0);
    // Perpendicular to the axis at h = 1: two circles radii R ± √(r² − h²).
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.0, 0.0, 1.0), Vec3::unit_z())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 20.0), &t, dom, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 2);
    let s = (1.5f64 * 1.5 - 1.0).sqrt();
    assert!((total_length(&g) - math::TAU * (5.0 + s + 5.0 - s)).abs() < 1e-8);
    check_contract(&g, &pl, &t, 1e-7);
    // Tangent to the top: one tangent circle of radius R.
    let pl: Surface = Plane::from_point_normal(Vec3::new(0.0, 0.0, 1.5), Vec3::unit_z())
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 20.0), &t, dom, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 1);
    assert!(g.branches[0].contact.is_tangent());
    // Containing the axis: two meridian circles of radius r.
    let pl: Surface = Plane::from_point_normal(Vec3::zero(), Vec3::new(1.0, 2.0, 0.0))
        .expect("p")
        .into();
    let g = intersect_surfaces(&pl, natural(&pl, 20.0), &t, dom, &tol()).expect("ok");
    assert_eq!(g.method, Method::PlaneTorusMeridian);
    assert_eq!(g.branches.len(), 2);
    assert!((total_length(&g) - 2.0 * math::TAU * 1.5).abs() < 1e-9);
    check_contract(&g, &pl, &t, 1e-7);
}

#[test]
fn coaxial_quadric_pairs_give_circles() {
    let z = Frame::world();
    let cyl: Surface = Cylinder::new(z, 2.0).expect("c").into();
    let sph: Surface = Sphere::new(z, 3.0).expect("s").into();
    let g = intersect_surfaces(
        &cyl,
        UvBox::new(0.0, math::TAU, -5.0, 5.0),
        &sph,
        natural(&sph, 0.0),
        &tol(),
    )
    .expect("ok");
    assert_eq!(g.method, Method::CommonAxis);
    assert_eq!(g.branches.len(), 2);
    assert!((total_length(&g) - 2.0 * math::TAU * 2.0).abs() < 1e-9);
    check_contract(&g, &cyl, &sph, 1e-7);
    // Cone–sphere coaxial.
    let cone: Surface = Cone::new(z, 0.0, 0.7).expect("k").into();
    let g = intersect_surfaces(
        &cone,
        UvBox::new(0.0, math::TAU, 0.0, 5.0),
        &sph,
        natural(&sph, 0.0),
        &tol(),
    )
    .expect("ok");
    assert_eq!(g.branches.len(), 1, "{g:#?}");
    check_contract(&g, &cone, &sph, 1e-7);
    // Torus–cylinder coaxial, tangent to the inner equator.
    let tor: Surface = Torus::new(z, 5.0, 1.0).expect("t").into();
    let cyl4: Surface = Cylinder::new(z, 4.0).expect("c").into();
    let g = intersect_surfaces(
        &tor,
        natural(&tor, 0.0),
        &cyl4,
        UvBox::new(0.0, math::TAU, -3.0, 3.0),
        &tol(),
    )
    .expect("ok");
    assert_eq!(g.branches.len(), 1);
    assert!(g.branches[0].contact.is_tangent());
    // Spindle outer patch vs its inner patch: they meet at the two axis points.
    let so: Surface = Torus::spindle(z, 1.0, 2.0, SpindlePatch::Outer)
        .expect("so")
        .into();
    let si: Surface = Torus::spindle(z, 1.0, 2.0, SpindlePatch::Inner)
        .expect("si")
        .into();
    let g = intersect_surfaces(&so, natural(&so, 0.0), &si, natural(&si, 0.0), &tol()).expect("ok");
    assert!(g.branches.is_empty());
    assert_eq!(g.vertices.len(), 2, "{g:#?}");
}

#[test]
fn cylinder_pairs_parallel_coaxial_and_equal_radius_cross() {
    let a: Surface = Cylinder::new(Frame::world(), 2.0).expect("a").into();
    let dom = UvBox::new(0.0, math::TAU, -5.0, 5.0);
    // Parallel axes 3 apart, radii 2 and 1.5: two lines.
    let b: Surface = Cylinder::new(
        frame([3.0, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        1.5,
    )
    .expect("b")
    .into();
    let g = intersect_surfaces(&a, dom, &b, dom, &tol()).expect("ok");
    assert_eq!(g.method, Method::CommonExtrusion);
    assert_eq!(g.branches.len(), 2);
    check_contract(&g, &a, &b, 1e-7);
    // Internally tangent.
    let c: Surface = Cylinder::new(
        frame([0.5, 0.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        1.5,
    )
    .expect("c")
    .into();
    let g = intersect_surfaces(&a, dom, &c, dom, &tol()).expect("ok");
    assert_eq!(g.branches.len(), 1);
    assert!(matches!(g.branches[0].contact, Contact::Tangent { .. }));
    // Coaxial, same radius: coincident.
    let d: Surface = Cylinder::new(
        frame([0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
        2.0,
    )
    .expect("d")
    .into();
    let g = intersect_surfaces(&a, dom, &d, dom, &tol()).expect("ok");
    let co = g.coincidence.expect("coincident");
    let map = co.uv_map.expect("affine");
    let p = forge_core::Point2::new(0.7, 1.3);
    let q = map.apply(p);
    assert!(a.eval(p.x, p.y).distance(d.eval(q.x, q.y)) < 1e-12);
    // Equal radii, perpendicular intersecting axes: two ellipses crossing at 2 points.
    let e: Surface = Cylinder::new(
        frame([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        2.0,
    )
    .expect("e")
    .into();
    let g = intersect_surfaces(&a, dom, &e, dom, &tol()).expect("ok");
    assert_eq!(g.method, Method::EqualCylinders);
    assert_eq!(g.branches.len(), 4, "{g:#?}");
    assert_eq!(
        g.vertices
            .iter()
            .filter(|v| v.kind == VertexKind::Singular)
            .count(),
        2
    );
    check_contract(&g, &a, &e, 1e-7);
}

#[test]
fn villarceau_plane_gives_two_exact_circles_of_radius_r_major() {
    // Ring torus (R, r) in a tilted frame; the bitangent planes through the centre (normal
    // at asin(r/R) to the axis, in any azimuth) cut two Villarceau circles of radius R,
    // centred at ±r along the plane's intersection with the equatorial plane, crossing
    // at the two points where the plane touches the torus.
    let (big, small) = (5.0f64, 3.0f64);
    let f = frame([0.5, -1.0, 2.0], [0.2, -0.3, 1.0], [1.0, 0.0, 0.0]);
    let t: Surface = Torus::new(f, big, small).expect("t").into();
    let th = math::asin(small / big);
    for azimuth in [0.0, 1.0, 2.5, 4.0] {
        let (sa, ca) = math::sin_cos(azimuth);
        let local = Vec3::new(math::sin(th) * ca, math::sin(th) * sa, math::cos(th));
        let n = f.x() * local.x + f.y() * local.y + f.z() * local.z;
        let pl: Surface = Plane::from_point_normal(f.origin(), n).expect("p").into();
        let g =
            intersect_surfaces(&pl, natural(&pl, 12.0), &t, natural(&t, 0.0), &tol()).expect("ok");
        assert_eq!(g.method, Method::PlaneTorusVillarceau);
        // Each circle is split at the two crossing points.
        assert_eq!(g.branches.len(), 4);
        assert!(
            g.branches
                .iter()
                .all(|b| b.representation == Representation::Exact && !b.closed)
        );
        assert!((total_length(&g) - 2.0 * math::TAU * big).abs() < 1e-9);
        let a = f.z().cross(n).normalize().expect("a");
        let centres = [f.origin() + a * small, f.origin() - a * small];
        for b in &g.branches {
            assert_eq!(b.curve.kind_name(), "circle");
            for (_, p) in common::samples(b, 64) {
                let d = centres.map(|c| (p.distance(c) - big).abs());
                assert!(d[0].min(d[1]) < 1e-12, "{p:?}");
            }
        }
        let sing: Vec<_> = g
            .vertices
            .iter()
            .filter(|v| v.kind == VertexKind::Singular)
            .collect();
        assert_eq!(sing.len(), 2, "{:#?}", g.vertices);
        for v in sing {
            assert!(v.contact.is_tangent());
            // Every singular vertex is the end of four branches.
            let ends = g
                .branches
                .iter()
                .filter(|b| {
                    b.start.is_some_and(|i| g.vertices[i].point == v.point)
                        || b.end.is_some_and(|i| g.vertices[i].point == v.point)
                })
                .count();
            assert_eq!(ends, 4);
        }
        check_contract(&g, &pl, &t, 1e-7);
    }
    // A partial torus box: the circles are clipped, and the pieces end on the boundary.
    let pl: Surface =
        Plane::from_point_normal(f.origin(), f.y() * -math::sin(th) + f.z() * math::cos(th))
            .expect("p")
            .into();
    let dt = UvBox::new(0.3, 2.0, 0.0, math::TAU);
    let g = intersect_surfaces(&pl, natural(&pl, 12.0), &t, dt, &tol()).expect("ok");
    assert_eq!(g.method, Method::PlaneTorusVillarceau);
    assert!(!g.branches.is_empty());
    assert!(
        g.vertices
            .iter()
            .any(|v| v.kind == VertexKind::DomainBoundary)
    );
    check_contract(&g, &pl, &t, 1e-7);
    assert_eq!(
        common::missed_samples(&g, &t, &dt, &pl, &natural(&pl, 12.0), 240, 0.05),
        0
    );
}

/// A cap plane against a side face whose (padded) parameter box ends exactly on their
/// intersection line (a pocket whose top lies 3e-6 under the cap, padded by 3e-6): the line
/// runs along the box edge up to rounding. It used to exhaust the clip's root budget
/// (`SSI_BUDGET_EXCEEDED`); now it is a certified answer either way.
#[test]
fn a_plane_pair_meeting_on_the_box_edge_does_not_exhaust_the_budget() {
    let cap: Surface = Plane::new(
        Frame::from_normal_x(
            Vec3::new(0.0, 0.0, 4.0),
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::new(1.0, 0.0, 0.0),
        )
        .expect("f"),
    )
    .into();
    let side: Surface = Plane::new(
        Frame::from_normal_x(
            Vec3::new(1.0, 1.0, 2.0),
            Vec3::new(0.0, -1.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
        )
        .expect("f"),
    )
    .into();
    for (e, pad) in [(3e-6, 3e-6), (1e-6, 1e-6), (5e-6, 5e-6), (3e-6, 0.0)] {
        let dom_cap = UvBox::new(-5e-6, 4.000005, -5e-6, 4.000005);
        let dom_side = UvBox::new(-pad, 2.0 + pad, -pad, 2.0 - e + pad);
        let g = intersect_surfaces(&cap, dom_cap, &side, dom_side, &tol())
            .unwrap_or_else(|x| panic!("e={e:e}: {} {x}", x.code()));
        for b in &g.branches {
            // Whatever is returned lies on the line y = 1, z = 4 inside both boxes.
            let p = b.curve.eval(0.5 * (b.range.0 + b.range.1));
            assert!(
                (p.y - 1.0).abs() < 1e-9 && (p.z - 4.0).abs() < 1e-9,
                "{p:?}"
            );
        }
    }
}

/// Review round 3 (chained booleans): a plane through a sphere's centre, containing its
/// axis, whose (padded) parameter box ends where the great circle only touches the box's
/// edge from inside (the circle's rightmost point on the line `x = 1`): no contact of the
/// patches, an empty result or the touching point, never `SSI_TANGENT_UNRESOLVED`.
#[test]
fn a_great_circle_touching_the_plane_box_edge_is_resolved() {
    let s: Surface = Sphere::new(
        Frame::try_from_axes(
            Vec3::new(-0.25, 3.25, 0.25),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, -1.0, 0.0),
            Vec3::new(0.0, 0.0, -1.0),
            1e-12,
        )
        .expect("frame"),
        1.25,
    )
    .expect("s")
    .into();
    let pl: Surface = Plane::new(
        Frame::try_from_axes(
            Vec3::new(0.0, 3.25, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 0.0, -1.0),
            Vec3::new(0.0, 1.0, 0.0),
            1e-12,
        )
        .expect("frame"),
    )
    .into();
    let bs = UvBox::new(
        4.776722501223364,
        7.935147792613412,
        -math::FRAC_PI_2,
        0.24219315263113578,
    );
    let bp = UvBox::new(
        0.9999969999999997,
        3.0000030000000004,
        -2.2500030000000004,
        -0.24999699999999975,
    );
    let g = intersect_surfaces(&s, bs, &pl, bp, &tol()).expect("resolved");
    check_contract(&g, &s, &pl, 1e-7);
}
