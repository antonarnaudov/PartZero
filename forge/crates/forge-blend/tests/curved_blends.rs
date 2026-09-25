//! Blends of edges between a plane and a curved face whose cross-section is a circle (W6
//! review round 3, SPEC §6.6's supported set): a D-flat's line edge between the flat and the
//! shaft (the blend is a cylinder, the bevel a plane) and a dimple's or a dome's rim between
//! the top face and the sphere (a torus, a cone). The values are checked against closed forms
//! of the cross-section (the D-flat: removed volume = cross-section area × length, from the
//! rolling ball's centre at `r` from the flat and `R ∓ r` from the axis) and against OCCT's
//! `BRepFilletAPI` on the same bodies (numbers from the oracle's OCP, recorded here).

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::topo::Body;
use forge_ir::{Frame, PlaneSpec, SketchCurve};
use forge_ops::boolean::corpus::{Operand, Sweep};

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

/// A shaft of radius 10 about the z axis, 20 high, with a flat 3 deep at x = 7.
fn dflat() -> Body {
    let shaft = zcyl("shaft", [0.0, 0.0], 0.0, 10.0, 20.0);
    let flat = aabox("flat", [7.0, -11.0, -1.0], [14.0, 22.0, 22.0]);
    cut(shaft, flat, "c1")
}

/// Area of the circular segment of a circle of radius `r` cut by a chord of length `c`.
fn segment(r: f64, c: f64) -> f64 {
    let th = 2.0 * (c / (2.0 * r)).asin();
    0.5 * r * r * (th - th.sin())
}

fn tri(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])).abs()
}

fn dist(a: [f64; 2], b: [f64; 2]) -> f64 {
    (a[0] - b[0]).hypot(a[1] - b[1])
}

#[test]
fn a_d_flat_edge_fillets_to_a_cylinder() {
    let b = dflat();
    let v0 = volume(&b);
    let y0 = 51f64.sqrt();
    let e = edge_near(&b, [7.0, y0, 10.0]);
    let r = 2.0;
    let out = fillet(&b, &es(&b, &[e]), r, &opts()).expect("D-flat fillet");
    assert_valid(&out.body);
    assert!(
        forge_blend::self_intersections(&out.body)
            .expect("certified")
            .is_empty()
    );
    // The ball: at r from the flat (x = 5) and 10 − r from the axis.
    let c2 = [5.0, (64.0f64 - 25.0).sqrt()];
    let pa = [7.0, c2[1]];
    let pb = [c2[0] * 10.0 / 8.0, c2[1] * 10.0 / 8.0];
    let ee = [7.0, y0];
    let area = tri(ee, pa, pb) - segment(r, dist(pa, pb)) + segment(10.0, dist(pb, ee));
    let removed = v0 - volume(&out.body);
    assert!(
        rel(removed, area * 20.0) < 1e-9,
        "{removed} vs {}",
        area * 20.0
    );
    // OCCT's BRepFilletAPI_MakeFillet on the same body: 2.2895420615523108 removed.
    assert!(rel(removed, 2.2895420615523108) < 1e-8, "{removed}");
    let ft = face_types(&out.body);
    assert_eq!(ft.get("cylinder"), Some(&2), "{ft:?}");
}

#[test]
fn a_d_flat_edge_chamfers_at_chord_distance() {
    let b = dflat();
    let v0 = volume(&b);
    let y0 = 51f64.sqrt();
    let e = edge_near(&b, [7.0, y0, 10.0]);
    let d = 2.0;
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d }, &opts()).expect("chamfer");
    assert_valid(&out.body);
    let ee = [7.0, y0];
    let pa = [7.0, y0 - d];
    let th = (51f64.sqrt()).atan2(7.0) + 2.0 * (d / 20.0).asin();
    let pb = [10.0 * th.cos(), 10.0 * th.sin()];
    let area = tri(ee, pa, pb) + segment(10.0, d);
    let removed = v0 - volume(&out.body);
    assert!(
        rel(removed, area * 20.0) < 1e-9,
        "{removed} vs {}",
        area * 20.0
    );
    // OCCT's BRepFilletAPI_MakeChamfer: 32.55988117937977 removed.
    assert!(rel(removed, 32.55988117937977) < 1e-8, "{removed}");
    // Too large: the flat is 2·√51 wide, the shaft's arc reaches a quarter turn first.
    let err = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 30.0 }, &opts())
        .expect_err("too large");
    assert_eq!(err.code(), "CHAMFER_DISTANCE_TOO_LARGE", "{err}");
}

fn plane(origin: [f64; 3], normal: [f64; 3], x_dir: [f64; 3]) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin,
        normal,
        x_dir,
    })
}

fn ball(c: [f64; 3], r: f64) -> Body {
    let curves: Vec<SketchCurve> = vec![
        arc("a", [0.0, c[2] - r], [0.0, c[2] + r], [0.0, c[2]], true),
        line("x", [0.0, c[2] + r], [0.0, c[2] - r]),
    ];
    let mut op = prism_op(
        "ball",
        plane([c[0], c[1], 0.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
        curves,
        1.0,
    );
    op.sweep = Sweep::Revolve {
        axis: forge_ir::SketchAxis {
            origin: [0.0, 0.0],
            direction: [0.0, 1.0],
        },
        angle: 360.0,
        direction: forge_ir::SweepDirection::Normal,
    };
    Operand::build(&op).expect("ball")
}

/// Pappus: the volume swept about the axis by the cross-section bounded by the closed path
/// `pieces` in the meridian half-plane `(ρ, ζ)`, `2π·|∮ ρ²/2 dζ|` (Green), each piece a
/// segment or an arc `(centre, radius, from angle, to angle)`, integrated by Simpson's rule
/// (error far below 1e-12 relative here).
enum Piece {
    Seg([f64; 2], [f64; 2]),
    Arc([f64; 2], f64, f64, f64),
}

fn pappus(pieces: &[Piece]) -> f64 {
    let n = 20_000;
    let mut total = 0.0;
    for p in pieces {
        // ρ(s), ζ'(s) on s ∈ [0, 1].
        let f = |s: f64| -> f64 {
            match *p {
                Piece::Seg(a, b) => {
                    let rho = a[0] + (b[0] - a[0]) * s;
                    0.5 * rho * rho * (b[1] - a[1])
                }
                Piece::Arc(c, r, a0, a1) => {
                    let th = a0 + (a1 - a0) * s;
                    let rho = c[0] + r * th.cos();
                    0.5 * rho * rho * r * th.cos() * (a1 - a0)
                }
            }
        };
        let h = 1.0 / n as f64;
        let mut acc = f(0.0) + f(1.0);
        for k in 1..n {
            acc += f(k as f64 * h) * if k % 2 == 1 { 4.0 } else { 2.0 };
        }
        total += acc * h / 3.0;
    }
    2.0 * std::f64::consts::PI * total.abs()
}

fn ang(c: [f64; 2], p: [f64; 2]) -> f64 {
    (p[1] - c[1]).atan2(p[0] - c[0])
}

/// The torus fillet's volume at a rim between the plane ζ = 6 and the sphere `(0, zc)`,
/// radius `rs`: the ball of radius `r` is `σ = −1` below the plane and outside the sphere
/// (a dimple's convex rim) or `σ = +1` above it and outside the sphere (a dome's concave
/// foot).
fn rim_fillet_volume(zc: f64, rs: f64, r: f64, sigma: f64) -> f64 {
    let e = [(rs * rs - (6.0 - zc).powi(2)).sqrt(), 6.0];
    let cz = 6.0 + sigma * r;
    let c2 = [((rs + r).powi(2) - (cz - zc).powi(2)).sqrt(), cz];
    let pa = [c2[0], 6.0];
    let k = rs / (rs + r);
    let pb = [c2[0] * k, zc + (cz - zc) * k];
    let s = [0.0, zc];
    pappus(&[
        Piece::Seg(e, pa),
        Piece::Arc(c2, r, ang(c2, pa), ang(c2, pb)),
        Piece::Arc(s, rs, ang(s, pb), ang(s, e)),
    ])
}

/// The cone bevel's volume at the same rims: the contacts at chord distance `d` on the plane
/// (outwards) and on the sphere (`into = −1`: down into a dimple, `+1`: up a dome).
fn rim_chamfer_volume(zc: f64, rs: f64, d: f64, into: f64) -> f64 {
    let s = [0.0, zc];
    let e = [(rs * rs - (6.0 - zc).powi(2)).sqrt(), 6.0];
    let pa = [e[0] + d, 6.0];
    let th = ang(s, e) + into * 2.0 * (d / (2.0 * rs)).asin();
    let pb = [rs * th.cos(), zc + rs * th.sin()];
    pappus(&[
        Piece::Seg(e, pa),
        Piece::Seg(pa, pb),
        Piece::Arc(s, rs, ang(s, pb), ang(s, e)),
    ])
}

fn rim(b: &Body) -> forge_core::topo::EdgeId {
    // The rim circle on the top face (z = 6) around (20, 15).
    b.edges()
        .iter()
        .find(|(_, e)| {
            matches!(&e.curve, forge_core::geom::Curve3::Circle(c)
                if (c.frame().origin().z - 6.0).abs() < 1e-9)
        })
        .map(|(id, _)| id)
        .expect("rim")
}

#[test]
fn a_dimple_rim_fillets_to_a_torus_and_chamfers_to_a_cone() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let b = cut(plate, ball([20.0, 15.0, 7.0], 5.0), "c1");
    let v0 = volume(&b);
    let e = rim(&b);
    let out = fillet(&b, &es(&b, &[e]), 1.0, &opts()).expect("rim fillet");
    assert_valid(&out.body);
    assert!(
        forge_blend::self_intersections(&out.body)
            .expect("certified")
            .is_empty()
    );
    let removed = v0 - volume(&out.body);
    let exact = rim_fillet_volume(7.0, 5.0, 1.0, -1.0);
    assert!(rel(removed, exact) < 1e-10, "{removed} vs Pappus {exact}");
    // OCCT: 3.256701855508254 removed — its blend face is a B-spline approximation of the
    // torus (§8.3 rule 4), 1.5e-6 off the exact volume.
    assert!(rel(removed, 3.256701855508254) < 2e-6, "{removed}");
    assert_eq!(face_types(&out.body).get("torus"), Some(&1));
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 1.0 }, &opts()).expect("chamfer");
    assert_valid(&out.body);
    let removed = v0 - volume(&out.body);
    let exact = rim_chamfer_volume(7.0, 5.0, 1.0, -1.0);
    assert!(rel(removed, exact) < 1e-10, "{removed} vs Pappus {exact}");
    // OCCT: 14.899252201696072 removed — its bevel meets the sphere at chord distance 1 (the
    // contact circle agrees to 1e-9), its B-spline bevel face is 4.2e-7 off in volume.
    assert!(rel(removed, 14.899252201696072) < 1e-6, "{removed}");
    assert_eq!(face_types(&out.body).get("cone"), Some(&1));
}

#[test]
fn a_dome_foot_fillets_and_chamfers_by_adding_material() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let b = join(plate, ball([20.0, 15.0, 3.0], 5.0), "j1");
    let v0 = volume(&b);
    let e = rim(&b);
    assert_eq!(
        forge_blend::edge_convexity(&b, e),
        Some(forge_blend::Convexity::Concave)
    );
    let out = fillet(&b, &es(&b, &[e]), 1.0, &opts()).expect("foot fillet");
    assert_valid(&out.body);
    assert!(
        forge_blend::self_intersections(&out.body)
            .expect("certified")
            .is_empty()
    );
    let exact = rim_fillet_volume(3.0, 5.0, 1.0, 1.0);
    assert!(
        rel(volume(&out.body) - v0, exact) < 1e-10,
        "{} vs Pappus {exact}",
        volume(&out.body) - v0
    );
    // OCCT: 0.7496688661649387 added (a B-spline approximation of the torus, 1.9e-6 off).
    assert!(
        rel(volume(&out.body) - v0, 0.7496688661649387) < 3e-6,
        "{}",
        volume(&out.body) - v0
    );
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 1.0 }, &opts()).expect("chamfer");
    assert_valid(&out.body);
    let exact = rim_chamfer_volume(3.0, 5.0, 1.0, 1.0);
    assert!(
        rel(volume(&out.body) - v0, exact) < 1e-10,
        "{} vs Pappus {exact}",
        volume(&out.body) - v0
    );
    // OCCT: 9.112309527118668 added (a B-spline bevel, 1.1e-8 off).
    assert!(
        rel(volume(&out.body) - v0, 9.112309527118668) < 1e-7,
        "{}",
        volume(&out.body) - v0
    );
}

/// The removed cross-section of the D-flat fillet of radius `r` (see
/// `a_d_flat_edge_fillets_to_a_cylinder`).
fn dflat_fillet_area(r: f64) -> f64 {
    let y0 = 51f64.sqrt();
    let c2 = [7.0 - r, ((10.0 - r).powi(2) - (7.0 - r).powi(2)).sqrt()];
    let pa = [7.0, c2[1]];
    let k = 10.0 / (10.0 - r);
    let pb = [c2[0] * k, c2[1] * k];
    let ee = [7.0, y0];
    tri(ee, pa, pb) - segment(r, dist(pa, pb)) + segment(10.0, dist(pb, ee))
}

#[test]
fn a_pin_hole_inside_a_d_flat_fillet_limits_it() {
    // A Ø0.1 hole along the shaft just inside the corner the fillet removes: no edge of the
    // hole crosses the flat or the shaft, it lies in the curved cross-section.
    let b = cut(dflat(), zcyl("h1", [6.9, 7.1], -1.0, 0.05, 22.0), "c2");
    let v0 = volume(&b);
    let e = edge_near(&b, [7.0, 51f64.sqrt(), 10.0]);
    let err = fillet(&b, &es(&b, &[e]), 2.0, &opts()).expect_err("the hole is in the fillet");
    // Another feature in the fillet's way (W6 review round 6): `FILLET_FAILED` naming it.
    let max_feasible_r = obstacle_hint(&err);
    assert!(err.to_string().contains("h1/"), "names the hole: {err}");
    assert!(
        max_feasible_r > 0.0 && max_feasible_r < 2.0,
        "{max_feasible_r}"
    );
    let out = fillet(&b, &es(&b, &[e]), max_feasible_r, &opts()).expect("max builds");
    assert_valid(&out.body);
    assert!(
        forge_blend::self_intersections(&out.body)
            .expect("certified")
            .is_empty()
    );
    let removed = v0 - volume(&out.body);
    let exact = dflat_fillet_area(max_feasible_r) * 20.0;
    assert!(rel(removed, exact) < 1e-9, "{removed} vs {exact}");
}

#[test]
fn a_hole_beside_a_dimple_rim_limits_its_fillet() {
    // A Ø0.2 hole through the plate 0.3 mm outside the rim (ρ = 5.2): the fillet's contact on
    // the top face reaches it at r ≈ 0.2 (the contact runs at ρ = √((5 + r)² − (1 + r)²)).
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let b = cut(plate, ball([20.0, 15.0, 7.0], 5.0), "c1");
    let rho0 = 24f64.sqrt();
    let b = cut(
        b,
        zcyl("h1", [20.0 + rho0 + 0.3, 15.0], -1.0, 0.1, 8.0),
        "c2",
    );
    let v0 = volume(&b);
    let e = rim(&b);
    let err = fillet(&b, &es(&b, &[e]), 1.0, &opts()).expect_err("the hole is in the strip");
    // Another feature in the fillet's way (W6 review round 6): `FILLET_FAILED` naming it.
    let max_feasible_r = &obstacle_hint(&err);
    // The contact reaches the hole's near side (ρ = ρ0 + 0.2) when √((5 + r)² − (1 + r)²) = ρ0 + 0.2.
    let target = rho0 + 0.2;
    let (mut lo, mut hi) = (0.0f64, 1.0f64);
    for _ in 0..100 {
        let m = 0.5 * (lo + hi);
        if ((5.0 + m).powi(2) - (1.0 + m).powi(2)).sqrt() < target {
            lo = m;
        } else {
            hi = m;
        }
    }
    assert!(
        (lo - 0.0015..lo).contains(max_feasible_r),
        "{max_feasible_r} vs the contact reaching the hole at {lo}: {err}"
    );
    assert!(err.to_string().contains("h1/"), "names the hole: {err}");
    let out = fillet(&b, &es(&b, &[e]), *max_feasible_r, &opts()).expect("max builds");
    assert_valid(&out.body);
    let exact = rim_fillet_volume(7.0, 5.0, *max_feasible_r, -1.0);
    assert!(rel(v0 - volume(&out.body), exact) < 1e-9);
}

/// Simpson's rule on `[a, b]` (20 000 intervals).
fn simpson(f: impl Fn(f64) -> f64, a: f64, b: f64) -> f64 {
    let n = 20_000;
    let h = (b - a) / n as f64;
    let mut acc = f(a) + f(b);
    for k in 1..n {
        acc += f(a + k as f64 * h) * if k % 2 == 1 { 4.0 } else { 2.0 };
    }
    acc * h / 3.0
}

/// `∫ w(x)·h(x) dx` over the cross-section of a fillet (radius `s`) or chamfer (distance `s`)
/// of a right-angled edge whose corner is at `x = x1` (the region spans `[x1 − s, x1]`, of
/// height `h(x)` there). The fillet's `h = s − √(s² − u²)`, `u = x − x1 + s`, has an infinite
/// slope at `u = s`: it is integrated in `u = s·sin φ`, smooth.
fn corner_integral(w: impl Fn(f64) -> f64, x1: f64, fillet: bool, s: f64) -> f64 {
    if fillet {
        simpson(
            |phi| {
                let (sn, cs) = phi.sin_cos();
                w(x1 - s + s * sn) * (s - s * cs) * s * cs
            },
            0.0,
            std::f64::consts::FRAC_PI_2,
        )
    } else {
        simpson(|x| w(x) * (x - x1 + s), x1 - s, x1)
    }
}

#[test]
fn a_d_flat_top_edge_ends_on_the_shaft() {
    // The top edge of the flat (along y at x = 7, z = 20) ends at both vertices on the shaft
    // cylinder: each ruling (a line along y) runs inside the shaft for 2·√(100 − x²), so the
    // removed volume is ∫ 2·√(100 − x²)·h(x) dx over the region's cross-section.
    let b = dflat();
    let v0 = volume(&b);
    let e = edge_near(&b, [7.0, 0.0, 20.0]);
    for (fillet_it, s) in [(true, 2.0), (false, 2.0), (true, 0.7)] {
        let out = if fillet_it {
            fillet(&b, &es(&b, &[e]), s, &opts())
        } else {
            chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: s }, &opts())
        }
        .unwrap_or_else(|err| panic!("{} {err}", err.code()));
        assert_valid(&out.body);
        assert!(
            forge_blend::self_intersections(&out.body)
                .expect("certified")
                .is_empty()
        );
        let exact = corner_integral(|x| 2.0 * (100.0 - x * x).sqrt(), 7.0, fillet_it, s);
        if !fillet_it {
            // The bevel plane meets the shaft in two elliptic arcs (exact, as OCCT's).
            assert_eq!(
                edge_types(&out.body).get("ellipse"),
                Some(&2),
                "{:?}",
                edge_types(&out.body)
            );
        }
        let removed = v0 - volume(&out.body);
        assert!(
            rel(removed, exact) < 1e-9,
            "fillet {fillet_it} {s}: {removed} vs {exact}"
        );
    }
}

#[test]
fn a_d_flat_top_arc_ends_on_the_flat() {
    // The top arc (the cap on the shaft, around from the flat's one corner to the other) ends
    // on the flat x = 7, a plane oblique to its meridians: each ruling (a circle of radius ρ
    // about the axis) runs over the angle 2π − 2·acos(7/ρ) inside the flat, so the removed
    // volume is ∫ (2π − 2·acos(7/ρ))·ρ·h(ρ) dρ.
    let b = dflat();
    let v0 = volume(&b);
    let e = edge_near(&b, [-10.0, 0.0, 20.0]);
    for (fillet_it, s) in [(true, 2.0), (false, 1.5)] {
        let out = if fillet_it {
            fillet(&b, &es(&b, &[e]), s, &opts())
        } else {
            chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: s }, &opts())
        }
        .unwrap_or_else(|err| panic!("{} {err}", err.code()));
        assert_valid(&out.body);
        assert!(
            forge_blend::self_intersections(&out.body)
                .expect("certified")
                .is_empty()
        );
        let exact = corner_integral(
            |r| (2.0 * std::f64::consts::PI - 2.0 * (7.0 / r).acos()) * r,
            10.0,
            fillet_it,
            s,
        );
        let removed = v0 - volume(&out.body);
        assert!(
            rel(removed, exact) < 1e-9,
            "fillet {fillet_it} {s}: {removed} vs {exact}"
        );
    }
}
