//! Regressions for the certified checks (W6 review, round 2): blends whose contact curves
//! overlap by less than a sampling chord's sagitta, at angles between sample directions,
//! must fail with a feasible range that is itself correct (below the closed-form limit and
//! within 0.002 mm of it), and the value suggested must build.

mod common;

use common::*;
use forge_blend::{BlendError, BlendOptions, fillet};
use forge_core::topo::{Body, EdgeId};

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

/// A plate `w × d × h` with through holes `(x, y, r)`.
fn plate_with_holes(w: f64, d: f64, h: f64, holes: &[(f64, f64, f64)]) -> Body {
    let mut b = aabox("e1", [0.0, 0.0, 0.0], [w, d, h]);
    for (i, &(x, y, r)) in holes.iter().enumerate() {
        b = cut(
            b,
            zcyl(&format!("h{i}"), [x, y], -1.0, r, h + 2.0),
            &format!("c{i}"),
        );
    }
    b
}

fn top_rims(b: &Body, h: f64, holes: &[(f64, f64, f64)]) -> Vec<EdgeId> {
    holes
        .iter()
        .map(|&(x, y, r)| circle_near(b, [x + r, y, h]))
        .collect()
}

fn max_r(err: &BlendError) -> f64 {
    match err {
        BlendError::RadiusTooLarge { max_feasible_r, .. } => *max_feasible_r,
        other => panic!(
            "expected FILLET_RADIUS_TOO_LARGE, got {} ({other})",
            other.code()
        ),
    }
}

/// Two holes of radii `r1`, `r2` with centres `dist` apart at `deg` to +x, both top rims
/// filleted at `r`: the contacts on the top face meet at `(dist − r1 − r2) / 2`.
fn hole_pair_case(
    r1: f64,
    r2: f64,
    dist: f64,
    deg: f64,
    r: f64,
    h: f64,
) -> (Body, Vec<EdgeId>, f64) {
    let a = deg.to_radians();
    let c1 = (r1 + 5.0, r1.max(r2) + 5.0);
    let c2 = (c1.0 + dist * a.cos(), c1.1 + dist * a.sin());
    let w = c2.0.max(c1.0) + r2.max(r1) + 5.0;
    let d = c2.1.max(c1.1) + r2.max(r1) + 5.0;
    let holes = [(c1.0, c1.1, r1), (c2.0, c2.1, r2)];
    let b = plate_with_holes(w, d, h, &holes);
    let rims = top_rims(&b, h, &holes);
    let _ = r;
    (b, rims, 0.5 * (dist - r1 - r2))
}

fn check_hole_pair(r1: f64, r2: f64, dist: f64, deg: f64, r: f64, h: f64) {
    let (b, rims, limit) = hole_pair_case(r1, r2, dist, deg, r, h);
    assert!(r > limit, "the case must be infeasible");
    let err = fillet(&b, &es(&b, &rims), r, &opts())
        .expect_err(&format!("r = {r} overlaps (limit {limit}) at {deg}°"));
    let m = max_r(&err);
    assert!(
        m < limit,
        "max_feasible_r {m} must be below the limit {limit} ({deg}°)"
    );
    assert!(
        m >= limit - 0.002,
        "max_feasible_r {m} too far below {limit} ({deg}°)"
    );
    let ok = fillet(&b, &es(&b, &rims), m, &opts())
        .unwrap_or_else(|e| panic!("the suggested {m} must build: {e}"));
    assert_valid(&ok.body);
}

#[test]
fn review_case_1_hole_rims_at_the_pappus_limit() {
    // Plate 59.5 × 39.5 × 4, holes R4.5 at (49, 22.5) and R3 at (48, 12.5): the contacts
    // meet at (√101 − 7.5)/2 = 1.274938.
    let holes = [(49.0, 22.5, 4.5), (48.0, 12.5, 3.0)];
    let b = plate_with_holes(59.5, 39.5, 4.0, &holes);
    let rims = top_rims(&b, 4.0, &holes);
    let limit = 0.5 * (101f64.sqrt() - 7.5);
    for r in [1.276, 1.278, 1.28, 1.282] {
        let err = fillet(&b, &es(&b, &rims), r, &opts()).expect_err("contacts overlap");
        let m = max_r(&err);
        assert!(
            m < limit && m >= limit - 0.002,
            "r {r}: max {m}, limit {limit}"
        );
        assert_eq!(m.to_bits(), 1.274f64.to_bits(), "{m}");
    }
    let ok = fillet(&b, &es(&b, &rims), 1.274, &opts()).expect("1.274 builds");
    assert_valid(&ok.body);
}

#[test]
fn review_case_2_large_holes_rotated_between_sample_angles() {
    // R40 holes with a 2 mm gap: the true limit is 1.0.
    for deg in [3.75, 11.0, 22.5] {
        check_hole_pair(40.0, 40.0, 82.0, deg, 1.08, 4.0);
    }
}

#[test]
fn review_case_3_hole_pairs_at_oblique_angles() {
    // Plate 10 thick, two R5 holes 13.9 apart: limit 1.95.
    for deg in [11.25, 26.25] {
        check_hole_pair(5.0, 5.0, 13.9, deg, 2.0, 10.0);
        check_hole_pair(5.0, 5.0, 13.9, deg, 1.951, 10.0);
    }
    // Sub-sagitta overlaps: 0.002 mm and 0.01 mm past the limit.
    for (dist, deg) in [(13.996, 3.75), (13.98, 17.0), (13.996, 41.0)] {
        let limit = 0.5 * (dist - 10.0);
        check_hole_pair(5.0, 5.0, dist, deg, limit + 0.002, 10.0);
    }
}

#[test]
fn feasible_hole_pairs_just_below_the_limit_build() {
    // 5 µm below the limit at an oblique angle: valid, and the volume is the plate's minus two
    // independent rim rings (Pappus).
    let (r1, dist, deg, h) = (5.0, 13.9, 26.25, 10.0);
    let (b, rims, limit) = hole_pair_case(r1, r1, dist, deg, 0.0, h);
    let r = limit - 0.005;
    let out = fillet(&b, &es(&b, &rims), r, &opts()).expect("feasible");
    assert_valid(&out.body);
    // The section a convex rim fillet removes, with x measured from the edge along the top
    // face: the square [0, r]² minus the quarter disc about (r, r).
    let pi = std::f64::consts::PI;
    let area = r * r * (1.0 - pi / 4.0);
    let moment = 0.5 * r * r * r - (pi * r * r / 4.0) * (r - 4.0 * r / (3.0 * pi));
    let ring = 2.0 * pi * (r1 * area + moment);
    let expect = volume(&b) - 2.0 * ring;
    assert!(
        rel(volume(&out.body), expect) < 1e-9,
        "{} vs {expect}",
        volume(&out.body)
    );
}

// ---------------------------------------------------------------------------------------
// Shells: walls colliding between samples, a wall pushed through an opening.

use forge_blend::{ShellDirection, ShellLimitReason, ShellOptions, shell};

fn sopts() -> ShellOptions {
    ShellOptions::new("sh1")
}

fn thickness_limit(err: &BlendError) -> (Option<f64>, Vec<(String, ShellLimitReason)>) {
    match err {
        BlendError::ThicknessTooLarge {
            max_feasible_thickness,
            limits,
            ..
        } => (
            *max_feasible_thickness,
            limits.iter().map(|l| (l.name.clone(), l.reason)).collect(),
        ),
        other => panic!(
            "expected SHELL_THICKNESS_TOO_LARGE, got {} ({other})",
            other.code()
        ),
    }
}

/// A 10 mm plate: the rectangle `[0, w] × [0, d]` rotated by `deg` about the origin, with a
/// through hole of radius `r` at `(cx, cy)` (before the rotation).
fn rotated_plate_with_hole(w: f64, d: f64, deg: f64, hole: (f64, f64, f64)) -> Body {
    let a = deg.to_radians();
    let rot = |x: f64, y: f64| [x * a.cos() - y * a.sin(), x * a.sin() + y * a.cos()];
    let plate = prism(
        "e1",
        0.0,
        polygon(&[rot(0.0, 0.0), rot(w, 0.0), rot(w, d), rot(0.0, d)]),
        10.0,
    );
    let c = rot(hole.0, hole.1);
    cut(plate, zcyl("h0", c, -1.0, hole.2, 12.0), "c0")
}

fn open_top_inward(b: &Body, t: f64) -> Result<forge_blend::ShellOutput, BlendError> {
    let top = b
        .faces()
        .iter()
        .find(|(_, f)| {
            matches!(&f.surface, forge_core::geom::Surface::Plane(p)
                if p.frame().z().z > 0.5 && (p.frame().origin().z - 10.0).abs() < 1e-9)
        })
        .map(|(id, _)| id)
        .expect("top face");
    shell(b, &fs(b, &[top]), t, ShellDirection::Inward, &sopts())
}

fn check_shell_limit(b: &Body, t: f64, limit: f64) {
    let err = open_top_inward(b, t).expect_err(&format!("t = {t} collides (limit {limit})"));
    let (m, limits) = thickness_limit(&err);
    let m = m.expect("a feasible thickness");
    assert!(
        m < limit,
        "max_feasible_thickness {m} must be below {limit}"
    );
    assert!(
        m >= limit - 0.002,
        "max_feasible_thickness {m} too far below {limit}"
    );
    assert!(
        limits.iter().all(|l| l.1 == ShellLimitReason::Gap),
        "{limits:?}"
    );
    let ok = open_top_inward(b, m).unwrap_or_else(|e| panic!("the suggested {m} must build: {e}"));
    assert_valid(&ok.body);
}

#[test]
fn review_case_2_shell_tubes_of_large_holes_collide_at_half_the_gap() {
    let (b, _, _) = hole_pair_case(40.0, 40.0, 82.0, 3.75, 0.0, 10.0);
    check_shell_limit(&b, 1.05, 1.0);
}

#[test]
fn review_case_3_a_hole_near_a_rotated_wall() {
    // Hole R10, 1.9 mm from the (rotated) bottom wall: the walls meet at t = 0.95.
    for deg in [11.0, 41.0] {
        let b = rotated_plate_with_hole(60.0, 40.0, deg, (30.0, 11.9, 10.0));
        check_shell_limit(&b, 0.96, 0.95);
        check_shell_limit(&b, 0.995, 0.95);
    }
}

#[test]
fn a_hole_near_an_oblique_wall_between_sample_angles() {
    // Hole R3, 2 mm from the wall: the walls meet at t = 1.
    for deg in [11.25, 18.75, 26.25] {
        let b = rotated_plate_with_hole(50.0, 30.0, deg, (25.0, 5.0, 3.0));
        for t in [1.001, 1.0025, 1.004] {
            check_shell_limit(&b, t, 1.0);
        }
    }
}

#[test]
fn a_wall_pushed_through_the_opening_is_reported() {
    // Box 100 × 100 × 10 with a pocket [25, 75]² × [−1, 9] cut from below: a 1 mm membrane
    // under the opened top. The pocket's ceiling offset rises by t; above t = 1 it would
    // stick out of the input.
    let base = aabox("e1", [0.0, 0.0, 0.0], [100.0, 100.0, 10.0]);
    let b = cut(
        base,
        aabox("p1", [25.0, 25.0, -1.0], [50.0, 50.0, 10.0]),
        "c1",
    );
    let ok = open_top_inward(&b, 0.5).expect("t = 0.5 is feasible");
    assert_valid(&ok.body);
    assert!(rel(volume(&ok.body), 7799.5) < 1e-9, "{}", volume(&ok.body));
    for t in [1.5, 2.0, 3.0] {
        let err = open_top_inward(&b, t).expect_err("the ceiling would leave the part");
        let (m, limits) = thickness_limit(&err);
        let m = m.expect("feasible");
        assert!((0.997..1.0).contains(&m), "t {t}: max {m}");
        assert!(
            limits.iter().all(|l| l.1 == ShellLimitReason::Gap),
            "{limits:?}"
        );
        let r = open_top_inward(&b, m).expect("max builds");
        let bb = forge_check::mass_properties(&r.body).expect("mass");
        let _ = bb;
        // Never above the input.
        let hi = r
            .body
            .vertices()
            .iter()
            .map(|(_, v)| v.point.z)
            .fold(f64::NEG_INFINITY, f64::max);
        assert!(hi <= 10.0 + 1e-9, "{hi}");
    }
}

#[test]
fn colliding_tube_walls_name_the_holes() {
    // Two holes 3.062 mm apart edge to edge: at t = 2 their tubes collide; the limits name
    // the two hole walls.
    let holes = [(15.0, 15.0, 5.0), (28.062, 15.0, 5.0)];
    let b = plate_with_holes(45.0, 30.0, 10.0, &holes);
    let err = open_top_inward(&b, 2.0).expect_err("tubes collide");
    let (m, limits) = thickness_limit(&err);
    assert!((1.529..1.531).contains(&m.expect("max")), "{m:?}");
    let names: Vec<&str> = limits.iter().map(|l| l.0.as_str()).collect();
    assert!(names.iter().any(|n| n.contains("h0")), "{names:?}");
    assert!(names.iter().any(|n| n.contains("h1")), "{names:?}");
}

// ---------------------------------------------------------------------------------------
// Values: derived lengths and the details wording shared with forge-ir.

use forge_blend::{ChamferSpec, chamfer};

#[test]
fn a_distance_angle_chamfer_with_a_null_second_distance_is_refused() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [20.0, 20.0, 10.0]);
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    let side = face_near(&b, [10.0, 10.0, 10.0]);
    let spec = ChamferSpec::DistanceAngle {
        d: 2.0,
        angle_deg: 1e-9,
        side: f1(&b, side),
    };
    let err = chamfer(&b, &es(&b, &[e]), &spec, &BlendOptions::new("c1"))
        .expect_err("a 3.5e-11 mm bevel is not a length");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    assert!(err.to_string().contains("not a length"), "{err}");
    // A small but real angle still works.
    let spec = ChamferSpec::DistanceAngle {
        d: 2.0,
        angle_deg: 0.01,
        side: f1(&b, side),
    };
    let out = chamfer(&b, &es(&b, &[e]), &spec, &BlendOptions::new("c1")).expect("0.01°");
    assert_valid(&out.body);
}

#[test]
fn invalid_values_are_worded_as_forge_ir_words_them() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [20.0, 20.0, 10.0]);
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    let err = fillet(&b, &es(&b, &[e]), 0.0, &opts()).expect_err("r = 0");
    assert_eq!(err.code(), "INVALID_RADIUS");
    assert_eq!(err.details()["expected"], "> 0.000001");
    let err = chamfer(
        &b,
        &es(&b, &[e]),
        &ChamferSpec::Equal { d: -1.0 },
        &BlendOptions::new("c1"),
    )
    .expect_err("d < 0");
    assert_eq!(err.details()["expected"], "> 0.000001");
    let top = face_near(&b, [10.0, 10.0, 10.0]);
    let err = shell(&b, &fs(&b, &[top]), 0.0, ShellDirection::Inward, &sopts()).expect_err("t = 0");
    assert_eq!(err.code(), "INVALID_VALUE");
    assert_eq!(err.details()["expected"], "> 0.000001");
}

#[test]
fn a_closed_shell_of_a_slotted_block_is_not_refused_by_a_ray_through_a_vertex() {
    // s71-0021: the offset slot's arcs start a few 1e-15 off the ends of its lines; a ray
    // through such a vertex once slipped between the pieces, and the point-in-face test put
    // a point of the (grown) slot inside the offset face: a false collision at t > 0.802.
    let base = aabox("base", [0.0, 0.0, 0.0], [27.0, 23.0, 9.0]);
    let b = cut(
        base,
        prism("slot", -1.0, slot([13.5, 11.5], 8.0, 5.0), 11.0),
        "c1",
    );
    let pi = std::f64::consts::PI;
    for t in [0.9, 1.27] {
        let out = shell(&b, &fs(&b, &[]), t, ShellDirection::Inward, &sopts()).expect("feasible");
        assert_valid(&out.body);
        let stadium = |r: f64| 16.0 * r + pi * r * r;
        let v_in = 27.0 * 23.0 * 9.0 - stadium(5.0) * 9.0;
        let void = (27.0 - 2.0 * t) * (23.0 - 2.0 * t) * (9.0 - 2.0 * t)
            - stadium(5.0 + t) * (9.0 - 2.0 * t);
        assert!(
            rel(volume(&out.body), v_in - void) < 1e-10,
            "t {t}: {}",
            volume(&out.body)
        );
    }
}

#[test]
#[cfg_attr(
    debug_assertions,
    ignore = "slow in debug builds: cargo test --release -p forge-blend --test certified"
)]
fn the_verification_helper_certifies_rounded_bodies_clear() {
    // Blends tangent to their neighbours along shared edges (corner spheres, tangent chains):
    // certified clear outside a tolerance-level band around those edges.
    let b = aabox("e1", [0.0, 0.0, 0.0], [20.0, 14.0, 9.0]);
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let out = fillet(&b, &es(&b, &all), 2.0, &opts()).expect("rounded box");
    let hits = forge_blend::self_intersections(&out.body).expect("certified");
    assert!(hits.is_empty(), "{hits:?}");
    let base = aabox("base", [0.0, 0.0, 0.0], [27.0, 23.0, 9.0]);
    let s = cut(
        base,
        prism("slot", 4.0, slot([13.5, 11.5], 8.0, 5.0), 6.0),
        "c1",
    );
    let rim = edge_near(&s, [13.5, 6.5, 9.0]);
    let out = fillet(&s, &es(&s, &[rim]), 1.5, &opts()).expect("slot rim");
    assert!(out.chain_added.len() >= 3, "the tangent chain goes round");
    let hits = forge_blend::self_intersections(&out.body).expect("certified");
    assert!(hits.is_empty(), "{hits:?}");
}
