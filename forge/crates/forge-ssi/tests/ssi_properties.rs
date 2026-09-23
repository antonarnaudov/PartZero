//! Property tests for surface–surface intersection with random frames and radii.
//!
//! For every case family:
//! - **contract**: every output point is within `fit` of both surfaces (checked against
//!   the exact distance forms at 401 samples per branch) and both pcurves map onto the
//!   3D curve within `fit`; every certified error bound is `<= fit`;
//! - **closed forms**: exact answers where known (circle radii, line counts, lengths);
//! - **completeness** ("missed branch" detector): a dense grid over each surface's box
//!   finds sign changes of the other surface's distance form; each must lie near the
//!   returned intersection;
//! - **tangency**: tangent configurations return one tangent point / line / circle,
//!   flagged tangent; coincident surfaces are flagged coincident.

mod common;

use common::{check_contract, missed_samples, total_length};
use forge_core::geom::{Cone, Cylinder, Plane, Sphere, Surface, Torus};
use forge_core::math;
use forge_core::{Frame, Point3, Vec3};
use forge_ssi::{Method, SsiTolerance, UvBox, VertexKind, intersect_surfaces};
use proptest::prelude::*;

fn tol() -> SsiTolerance {
    SsiTolerance::default()
}

/// Case count: `PROPTEST_CASES` overrides the per-block default (for soak runs).
fn cases(default: u32) -> u32 {
    std::env::var("PROPTEST_CASES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(default)
}

fn arb_unit() -> impl Strategy<Value = Vec3> {
    prop::array::uniform3(-1.0f64..1.0).prop_filter_map("unit", |a| {
        let v = Vec3::from(a);
        (v.norm() > 0.2).then(|| v / v.norm())
    })
}

fn arb_point(r: f64) -> impl Strategy<Value = Point3> {
    prop::array::uniform3(-r..r).prop_map(Vec3::from)
}

fn arb_frame() -> impl Strategy<Value = Frame> {
    (arb_point(2.0), arb_unit(), arb_unit())
        .prop_filter_map("frame", |(o, z, x)| Frame::from_normal_x(o, z, x))
}

fn frame_z(o: Point3, z: Vec3, x: Vec3) -> Frame {
    Frame::from_normal_x(o, z, x)
        .or_else(|| Frame::from_normal(o, z))
        .expect("frame")
}

fn nat(s: &Surface) -> UvBox {
    UvBox::natural(s, 12.0)
}

fn cone_box(c: &Cone) -> UvBox {
    UvBox::new(0.0, math::TAU, c.apex_v() + 0.05, c.apex_v() + 16.0)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases(48)))]

    #[test]
    fn plane_sphere_matches_closed_form(f in arb_frame(), r in 0.5f64..4.0, d in -1.2f64..1.2, n in arb_unit()) {
        let s: Surface = Sphere::new(f, r).expect("s").into();
        let pl: Surface = Plane::from_point_normal(f.origin() + n * (d * r), n).expect("p").into();
        let g = intersect_surfaces(&pl, nat(&pl), &s, nat(&s), &tol()).expect("ok");
        check_contract(&g, &pl, &s, 1e-7);
        if d.abs() < 1.0 {
            let rho = r * (1.0 - d * d).sqrt();
            prop_assert!((total_length(&g) - math::TAU * rho).abs() < 1e-8 * r.max(1.0));
        } else {
            prop_assert!(g.branches.is_empty() && g.vertices.is_empty());
        }
    }

    #[test]
    fn plane_tangent_to_sphere_cylinder_torus_is_one_tangent_entity(
        f in arb_frame(), r in 0.5f64..3.0, which in 0usize..3, a in 0.0f64..6.2, b in -1.2f64..1.2,
    ) {
        let (s, count_points, count_lines): (Surface, usize, usize) = match which {
            0 => (Sphere::new(f, r).expect("s").into(), 1, 0),
            1 => (Cylinder::new(f, r).expect("c").into(), 0, 1),
            _ => (Torus::new(f, r + 2.0, r * 0.5).expect("t").into(), 1, 0),
        };
        let dom = match which { 1 => UvBox::new(0.0, math::TAU, -6.0, 6.0), _ => nat(&s) };
        // Tangent plane at a point of the outer equator (torus: v = 0 is convex there).
        let v = if which == 2 { 0.0 } else if which == 0 { b } else { 0.3 };
        let p = s.eval(a, v);
        let nrm = s.normal(a, v).expect("n");
        let pl: Surface = Plane::from_point_normal(p, nrm).expect("p").into();
        let g = intersect_surfaces(&pl, nat(&pl), &s, dom, &tol()).expect("ok");
        prop_assert_eq!(g.branches.len(), count_lines, "{:#?}", g);
        prop_assert_eq!(g.tangent_points().count(), count_points);
        for b in &g.branches {
            prop_assert!(b.contact.is_tangent());
        }
        for v in g.tangent_points() {
            prop_assert!(v.point.distance(p) < 1e-5, "{:?} vs {:?}", v.point, p);
        }
    }

    #[test]
    fn sphere_sphere_circle_point_or_nothing(
        f in arb_frame(), r1 in 0.5f64..3.0, r2 in 0.5f64..3.0, dir in arb_unit(), k in 0usize..4,
    ) {
        let d = match k {
            0 => r1 + r2,               // external tangency
            1 => (r1 - r2).abs(),       // internal tangency (or concentric if equal)
            2 => 0.5 * (r1 + r2 + (r1 - r2).abs()),
            _ => r1 + r2 + 0.3,
        };
        let a: Surface = Sphere::new(f, r1).expect("a").into();
        let fb = frame_z(f.origin() + dir * d, dir, f.x());
        let b: Surface = Sphere::new(fb, r2).expect("b").into();
        let g = intersect_surfaces(&a, nat(&a), &b, nat(&b), &tol()).expect("ok");
        check_contract(&g, &a, &b, 1e-7);
        match k {
            0 | 1 if d > 1e-9 => {
                prop_assert!(g.branches.is_empty());
                prop_assert_eq!(g.tangent_points().count(), 1);
            }
            1 => prop_assert!(g.coincidence.is_some() || g.is_empty()),
            2 => {
                // Radical plane: x = (d² + r1² − r2²) / (2d), ρ = √(r1² − x²).
                let x = (d * d + r1 * r1 - r2 * r2) / (2.0 * d);
                let rho = (r1 * r1 - x * x).max(0.0).sqrt();
                if rho > 1e-3 {
                    prop_assert!((total_length(&g) - math::TAU * rho).abs() < 1e-8 * r1);
                }
            }
            _ => prop_assert!(g.is_empty()),
        }
    }

    #[test]
    fn coaxial_revolution_pairs_are_circles(
        f in arb_frame(), which in 0usize..6, r in 0.5f64..3.0, h in -2.0f64..2.0, flip in any::<bool>(),
    ) {
        let z = if flip { -f.z() } else { f.z() };
        let fb = frame_z(f.origin() + f.z() * h, z, f.y());
        let (a, da, b, db): (Surface, UvBox, Surface, UvBox) = match which {
            0 => {
                let c = Cylinder::new(f, r).expect("c");
                let s = Sphere::new(fb, r + 0.7).expect("s");
                (c.into(), UvBox::new(0.0, math::TAU, -8.0, 8.0), s.into(), UvBox::natural(&s.into(), 0.0))
            }
            1 => {
                let k = Cone::new(f, r, 0.6).expect("k");
                let c = Cylinder::new(fb, r + 1.0).expect("c");
                (k.into(), cone_box(&k), c.into(), UvBox::new(0.0, math::TAU, -12.0, 12.0))
            }
            2 => {
                let t = Torus::new(f, r + 2.0, 1.0).expect("t");
                let s = Sphere::new(fb, r + 2.2).expect("s");
                (t.into(), UvBox::natural(&t.into(), 0.0), s.into(), UvBox::natural(&s.into(), 0.0))
            }
            3 => {
                let t = Torus::new(f, r + 2.0, 1.0).expect("t");
                let c = Cylinder::new(fb, r + 2.3).expect("c");
                (t.into(), UvBox::natural(&t.into(), 0.0), c.into(), UvBox::new(0.0, math::TAU, -5.0, 5.0))
            }
            4 => {
                let k1 = Cone::new(f, r, 0.5).expect("k1");
                let k2 = Cone::new(fb, r * 0.5, 0.9).expect("k2");
                (k1.into(), cone_box(&k1), k2.into(), cone_box(&k2))
            }
            _ => {
                let t1 = Torus::new(f, r + 2.0, 1.0).expect("t1");
                let t2 = Torus::new(fb, r + 2.5, 1.2).expect("t2");
                (t1.into(), UvBox::natural(&t1.into(), 0.0), t2.into(), UvBox::natural(&t2.into(), 0.0))
            }
        };
        let g = intersect_surfaces(&a, da, &b, db, &tol()).expect("ok");
        prop_assert!(g.coincidence.is_some() || g.method == Method::CommonAxis, "{:?}", g.method);
        for br in &g.branches {
            prop_assert_eq!(br.curve.kind_name(), "circle");
        }
        check_contract(&g, &a, &b, 1e-7);
        prop_assert_eq!(missed_samples(&g, &a, &da, &b, &db, 160, 0.05), 0);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(cases(48)))]

    /// The same surface described in another frame (shifted along its axis or in its
    /// plane, rotated about the axis, axis flipped) is reported as a coincidence, with
    /// the orientation flag of the actual normals and — for affine cases — a uv map that
    /// sends every point of `a` to the same 3D point of `b`.
    #[test]
    fn coincident_descriptions_are_flagged_with_a_valid_uv_map(
        f in arb_frame(), which in 0usize..5, x2 in arb_unit(), shift in -2.0f64..2.0,
        flip in any::<bool>(), r in 0.5f64..3.0, samples in prop::collection::vec((0.0f64..1.0, 0.0f64..1.0), 8),
    ) {
        let z2 = if flip && which != 2 { -f.z() } else { f.z() };
        let (a, da, b, db): (Surface, UvBox, Surface, UvBox) = match which {
            0 => {
                let o2 = f.origin() + f.x() * shift + f.y() * (0.5 * shift);
                let a: Surface = Plane::new(f).into();
                let b: Surface = Plane::new(frame_z(o2, z2, x2)).into();
                let (da, db) = (UvBox::natural(&a, 4.0), UvBox::natural(&b, 8.0));
                (a, da, b, db)
            }
            1 => {
                let a: Surface = Cylinder::new(f, r).expect("a").into();
                let b: Surface = Cylinder::new(frame_z(f.origin() + f.z() * shift, z2, x2), r)
                    .expect("b")
                    .into();
                (a, UvBox::new(0.0, math::TAU, -3.0, 3.0), b, UvBox::new(0.0, math::TAU, -6.0, 6.0))
            }
            2 => {
                // Same apex and opening, frame rotated about the axis.
                let k = Cone::new(f, r, 0.6).expect("a");
                let k2 = Cone::new(frame_z(f.origin(), f.z(), x2), r, 0.6).expect("b");
                (k.into(), cone_box(&k), k2.into(), cone_box(&k2))
            }
            3 => {
                let a: Surface = Sphere::new(f, r).expect("a").into();
                let b: Surface = Sphere::new(frame_z(f.origin(), x2, f.x()), r).expect("b").into();
                let (da, db) = (UvBox::natural(&a, 0.0), UvBox::natural(&b, 0.0));
                (a, da, b, db)
            }
            _ => {
                let a: Surface = Torus::new(f, r + 1.5, 0.8).expect("a").into();
                let b: Surface = Torus::new(frame_z(f.origin(), z2, x2), r + 1.5, 0.8).expect("b").into();
                let (da, db) = (UvBox::natural(&a, 0.0), UvBox::natural(&b, 0.0));
                (a, da, b, db)
            }
        };
        let g = intersect_surfaces(&a, da, &b, db, &tol()).expect("ok");
        let co = g.coincidence.expect("coincidence");
        prop_assert!(g.branches.is_empty());
        let (um, vm) = (0.5 * (da.u.0 + da.u.1), 0.5 * (da.v.0 + da.v.1));
        let p = a.eval(um, vm);
        let na = a.normal(um, vm).expect("na");
        let (ub, vb, _) = b.project(p);
        let nb = b.normal(ub, vb).expect("nb");
        prop_assert_eq!(co.same_orientation, na.dot(nb) > 0.0);
        if which != 3 {
            let map = co.uv_map.expect("affine map");
            for (s, t) in samples {
                let uv = forge_core::Point2::new(
                    da.u.0 + (da.u.1 - da.u.0) * s,
                    da.v.0 + (da.v.1 - da.v.0) * t,
                );
                let q = map.apply(uv);
                let d = a.eval(uv.x, uv.y).distance(b.eval(q.x, q.y));
                prop_assert!(d < 1e-9, "{d:e} at {uv:?} -> {q:?}");
            }
        }
    }
}

proptest! {
    // Marching families are slower: fewer cases, dense completeness checks.
    #![proptest_config(ProptestConfig::with_cases(cases(24)))]

    #[test]
    fn general_quadric_and_torus_pairs_are_complete_and_accurate(
        fa in arb_frame(), fb in arb_frame(), ka in 0usize..5, kb in 1usize..5,
        ra in 0.6f64..2.5, rb in 0.6f64..2.5,
    ) {
        let make = |k: usize, f: Frame, r: f64| -> (Surface, UvBox) {
            match k {
                0 => {
                    let p: Surface = Plane::new(f).into();
                    let d = UvBox::natural(&p, 8.0);
                    (p, d)
                }
                1 => (Cylinder::new(f, r).expect("c").into(), UvBox::new(0.0, math::TAU, -6.0, 6.0)),
                2 => {
                    let k = Cone::new(f, r * 0.5, 0.5).expect("k");
                    let d = cone_box(&k);
                    (k.into(), d)
                }
                3 => {
                    let s: Surface = Sphere::new(f, r + 0.5).expect("s").into();
                    let d = UvBox::natural(&s, 0.0);
                    (s, d)
                }
                _ => {
                    let t: Surface = Torus::new(f, r + 1.5, 0.3 + 0.4 * r).expect("t").into();
                    let d = UvBox::natural(&t, 0.0);
                    (t, d)
                }
            }
        };
        let (a, da) = make(ka, fa, ra);
        let (b, db) = make(kb, fb, rb);
        let g = match intersect_surfaces(&a, da, &b, db, &tol()) {
            Ok(g) => g,
            // Structured errors are allowed (never a silent wrong answer), but must carry
            // a stable code.
            Err(e) => {
                prop_assert!(e.code().starts_with("SSI_"));
                return Ok(());
            }
        };
        if g.coincidence.is_some() {
            return Ok(());
        }
        check_contract(&g, &a, &b, 1e-7);
        prop_assert_eq!(missed_samples(&g, &a, &da, &b, &db, 200, 0.05), 0);
        prop_assert_eq!(missed_samples(&g, &b, &db, &a, &da, 200, 0.05), 0);
        for v in &g.vertices {
            if v.kind == VertexKind::DomainBoundary {
                prop_assert!(v.on_boundary_a || v.on_boundary_b, "{:?}", v);
            }
        }
    }

    #[test]
    fn tangent_sphere_on_curved_surfaces_gives_one_tangent_point(
        f in arb_frame(), which in 0usize..3, u in 0.0f64..6.2, v in -0.8f64..0.8, rs in 0.3f64..1.2,
    ) {
        let (s, d): (Surface, UvBox) = match which {
            0 => (Cylinder::new(f, 2.0).expect("c").into(), UvBox::new(0.0, math::TAU, -5.0, 5.0)),
            1 => {
                let t: Surface = Torus::new(f, 4.0, 1.0).expect("t").into();
                let dd = UvBox::natural(&t, 0.0);
                (t, dd)
            }
            _ => {
                let k = Cone::new(f, 1.0, 0.5).expect("k");
                let dd = cone_box(&k);
                (k.into(), dd)
            }
        };
        // Only convex-outward points (sphere outside, touching once).
        let v = if which == 1 { v.abs() * 0.5 } else { v + 1.5 };
        let p = s.eval(u, v);
        let n = s.normal(u, v).expect("n");
        let sp: Surface = Sphere::new(frame_z(p + n * rs, n, f.x()), rs).expect("sp").into();
        let g = intersect_surfaces(&s, d, &sp, UvBox::natural(&sp, 0.0), &tol()).expect("ok");
        prop_assert!(g.branches.is_empty(), "{:#?}", g);
        prop_assert_eq!(g.tangent_points().count(), 1, "{:#?}", g);
        let t = g.tangent_points().next().expect("t");
        prop_assert!(t.point.distance(p) < 1e-4, "{:?} vs {:?}", t.point, p);
        prop_assert!(t.contact.is_tangent());
    }
}
