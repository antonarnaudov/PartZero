//! Blends at **reflex** vertices of prisms (W6 review round 4: the star and notch rows of the
//! adversarial families) against closed forms and OCCT: two blended top edges meeting at a
//! reflex polygon vertex (the vertical edge there is concave) meet in their plane of symmetry.
//!
//! Closed form: a blend's removed material is its cross-section — `(1 − π/4)·r²` for a fillet
//! between perpendicular faces, `d²/2` for an equal chamfer — swept along the edge; a prism of
//! uniform section cut by two planes has the volume of the section times the length of its
//! **centroid line** between them. The centroid of the fillet's section is `δ = r(10 − 3π)/(12 −
//! 3π)` in from both faces (`d/3` for the chamfer's triangle); the end planes are the far end
//! face and the mitre (the vertical plane of symmetry through the reflex vertex).

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::linalg::Vec3;
use forge_core::math::PI;

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

/// The length of the centroid line of the blend along the top edge from `far` to the reflex
/// vertex `v` (at height `h`), offset `delta` into the top face and down: from the far end
/// face (outward normal `m`) to the plane of symmetry through `v` (normal `n`).
fn centroid_length(far: [f64; 2], v: [f64; 2], m: Vec3, n: Vec3, delta: f64) -> f64 {
    let p = Vec3::new(far[0], far[1], 0.0);
    let q = Vec3::new(v[0], v[1], 0.0);
    let t = (q - p).normalize().expect("edge");
    // Horizontal, perpendicular to the edge, into the material: the tests' polygons are
    // counter-clockwise and their notch edges run from `far` to `v` in that order, so the
    // interior is on the left.
    let w = Vec3::new(-t.y, t.x, 0.0);
    let s0 = -(w * delta).dot(m) / t.dot(m);
    let s1 = ((q - p).dot(n) - (w * delta).dot(n)) / t.dot(n);
    s1 - s0
}

/// A pentagon (the square with a 90° notch at the top): its two notch edges filleted meet in
/// the plane x = 10. Each centroid line is exactly the edge length (10√2): the 45° end faces
/// and the mitre shift it by the same δ.
#[test]
fn two_blends_at_a_reflex_vertex_meet_in_their_plane_of_symmetry() {
    let pts = [
        [0.0, 0.0],
        [20.0, 0.0],
        [20.0, 20.0],
        [10.0, 10.0],
        [0.0, 20.0],
    ];
    let b = prism("e1", 0.0, polygon(&pts), 5.0);
    let edges = [
        edge_near(&b, [15.0, 15.0, 5.0]),
        edge_near(&b, [5.0, 15.0, 5.0]),
    ];
    let out = fillet(&b, &es(&b, &edges), 1.0, &opts()).expect("fillet");
    assert_valid(&out.body);
    let want = 1500.0 - 2.0 * (1.0 - PI / 4.0) * 200f64.sqrt();
    assert!(
        rel(volume(&out.body), want) < 1e-12,
        "{} vs {want}",
        volume(&out.body)
    );
    // OCCT: 1493.930144384 (within 1e-8 relative).
    assert!(rel(volume(&out.body), 1493.930144384) < 1e-8);
    let out =
        chamfer(&b, &es(&b, &edges), &ChamferSpec::Equal { d: 1.0 }, &opts()).expect("chamfer");
    assert_valid(&out.body);
    let want = 1500.0 - 2.0 * 0.5 * 200f64.sqrt();
    assert!(
        rel(volume(&out.body), want) < 1e-12,
        "{} vs {want}",
        volume(&out.body)
    );
    // OCCT: 1485.857864376 (equal).
    assert!((volume(&out.body) - 1485.857864376).abs() < 1e-8);
}

/// A 240° reflex vertex (a 120° notch): the centroid lines are shifted differently at the
/// oblique end faces and at the mitre — the closed form with the general centroid length.
#[test]
fn a_mitre_at_a_reflex_vertex_of_any_angle_matches_the_closed_form() {
    let apex = [10.0, 20.0 - 10.0 / 3f64.sqrt()];
    let pts = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], apex, [0.0, 20.0]];
    let b = prism("e1", 0.0, polygon(&pts), 5.0);
    let e1 = edge_near(&b, [15.0, 0.5 * (20.0 + apex[1]), 5.0]);
    let e2 = edge_near(&b, [5.0, 0.5 * (20.0 + apex[1]), 5.0]);
    let r = 1.0;
    let out = fillet(&b, &es(&b, &[e1, e2]), r, &opts()).expect("fillet");
    assert_valid(&out.body);
    let area = 20.0 * 20.0 - 0.5 * 20.0 * (20.0 - apex[1]);
    let delta = r * (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI);
    let x = Vec3::new(1.0, 0.0, 0.0);
    let l1 = centroid_length([20.0, 20.0], apex, x, -x, delta);
    let l2 = centroid_length([0.0, 20.0], apex, -x, x, delta);
    let want = area * 5.0 - (1.0 - PI / 4.0) * r * r * (l1 + l2);
    assert!(
        rel(volume(&out.body), want) < 1e-12,
        "{} vs {want}",
        volume(&out.body)
    );
    // OCCT: 1706.368850605 (its fillet's approximation, within 1e-8 relative).
    assert!(
        rel(volume(&out.body), 1706.368850605) < 1e-8,
        "{}",
        volume(&out.body)
    );
}

/// The mixed corner at a reflex vertex of any angle (W6 review round 4: the reviewer's
/// adv7-0120 rows, unadjudicated at non-270° angles): the concave vertical edge and the two
/// convex top edges at the apex of a notch of opening `φ`, all filleted by `r`. Closed form of
/// the two passes: the vertical fill `r²cot(φ/2) − r²(π − φ)/2` over the height; the top
/// edges' wedges up to the tangent points `T_i` of the fill's arc (planes perpendicular to
/// the edges there); the torus around the arc — the wedge `(1 − π/4)r²` at `r + δ` from the
/// fill's axis over the angle `π − φ` (Pappus).
#[test]
fn a_mixed_corner_at_a_reflex_vertex_of_any_angle_matches_the_closed_form() {
    for (half_open_deg, r, occt) in [(60.0, 1.0, 1706.665831316), (70.0, 0.8, 1815.143391173)] {
        // The notch's edges rise from the apex at `90° − half_open` to the horizontal.
        let k = 10.0 / forge_core::math::tan(forge_core::math::deg_to_rad(half_open_deg));
        let apex = [10.0, 20.0 - k];
        let pts = [[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], apex, [0.0, 20.0]];
        let h = 5.0;
        let b = prism("e1", 0.0, polygon(&pts), h);
        let e1 = edge_near(&b, [15.0, 0.5 * (20.0 + apex[1]), h]);
        let e2 = edge_near(&b, [5.0, 0.5 * (20.0 + apex[1]), h]);
        let ev = edge_near(&b, [apex[0], apex[1], 0.5 * h]);
        let out = fillet(&b, &es(&b, &[e1, e2, ev]), r, &opts()).expect("mixed corner");
        assert_valid(&out.body);
        let phi = 2.0 * forge_core::math::deg_to_rad(half_open_deg);
        let wedge = (1.0 - PI / 4.0) * r * r;
        let delta = r * (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI);
        let fill = r * r / forge_core::math::tan(0.5 * phi) - r * r * (PI - phi) / 2.0;
        // The tangent points lie r·cot(φ/2) from the apex along each edge.
        let edge_len = (100.0 + k * k).sqrt();
        let to_t = edge_len - r / forge_core::math::tan(0.5 * phi);
        // The centroid line's start at the far end face x = 20 (x = 0), as in the tests above.
        let x = Vec3::new(1.0, 0.0, 0.0);
        let t = Vec3::new(-10.0, -k, 0.0) * (1.0 / edge_len);
        let w = Vec3::new(-t.y, t.x, 0.0);
        let s0 = -(w * delta).dot(x) / t.dot(x);
        let len = to_t - s0;
        let area = 400.0 - 0.5 * 20.0 * k;
        let want = area * h + fill * h - 2.0 * wedge * len - wedge * (r + delta) * (PI - phi);
        assert!(
            rel(volume(&out.body), want) < 1e-12,
            "φ/2 = {half_open_deg}: {} vs {want}",
            volume(&out.body)
        );
        // OCCT's simultaneous fillet agrees within its approximation here.
        assert!(
            rel(volume(&out.body), occt) < 1e-8,
            "φ/2 = {half_open_deg}: {} vs OCCT {occt}",
            volume(&out.body)
        );
    }
}

/// The mixed chamfer corner at a reflex vertex (two convex top edges and the concave vertical
/// edge, all chamfered) is exactly OCCT's (`BRepFilletAPI_MakeChamfer`) at 90° and 120°
/// notches — the adversarial star rows' differences come from their acute tips, where the
/// corner triangle (the oracle's reference) and OCCT's corner differ (a contract issue on
/// engine-defined chamfer corners).
#[test]
fn mixed_chamfer_corners_at_reflex_vertices_equal_occt() {
    let k = 10.0 / 3f64.sqrt();
    let ap = [10.0, 20.0 - k];
    for (pts, targets, occt) in [
        (
            vec![[0.0, 0.0], [20.0, 0.0], [20.0, 20.0], ap, [0.0, 20.0]],
            vec![
                [15.0, 0.5 * (20.0 + ap[1]), 5.0],
                [5.0, 0.5 * (20.0 + ap[1]), 5.0],
                [ap[0], ap[1], 2.5],
            ],
            1706.829966482,
        ),
        (
            vec![
                [0.0, 0.0],
                [20.0, 0.0],
                [20.0, 20.0],
                [10.0, 10.0],
                [0.0, 20.0],
            ],
            vec![[15.0, 15.0, 5.0], [5.0, 15.0, 5.0], [10.0, 10.0, 2.5]],
            1494.524020211,
        ),
    ] {
        let b = prism("e1", 0.0, polygon(&pts), 5.0);
        let edges: Vec<_> = targets.iter().map(|p| edge_near(&b, *p)).collect();
        let out = chamfer(&b, &es(&b, &edges), &ChamferSpec::Equal { d: 0.7 }, &opts())
            .expect("mixed chamfer corner");
        assert_valid(&out.body);
        assert!(
            rel(volume(&out.body), occt) < 1e-11,
            "{} vs OCCT {occt}",
            volume(&out.body)
        );
    }
}
