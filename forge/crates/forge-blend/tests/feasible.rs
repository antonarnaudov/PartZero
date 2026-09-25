//! Structured failures with feasible ranges (SPEC §6.6–§6.7) and the feasible-range
//! property of the plan's W6 acceptance: blending with `max_feasible_*` succeeds, with
//! `1.01 ·` it fails with the same code.

mod common;

use common::*;
use forge_blend::{BlendError, BlendOptions, ChamferSpec, Limit, chamfer, fillet};

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

fn radius_limit(err: &BlendError) -> (f64, Vec<(String, f64, Limit)>) {
    match err {
        BlendError::RadiusTooLarge {
            max_feasible_r,
            edges,
            ..
        } => (
            *max_feasible_r,
            edges
                .iter()
                .map(|e| (e.key.clone(), e.max_r, e.limit))
                .collect(),
        ),
        other => panic!(
            "expected FILLET_RADIUS_TOO_LARGE, got {} ({other})",
            other.code()
        ),
    }
}

fn assert_property(b: &forge_core::topo::Body, edges: &[forge_core::topo::EdgeId], max: f64) {
    assert!(max > 0.0);
    fillet(b, &es(b, edges), max, &opts())
        .unwrap_or_else(|e| panic!("r = max {max} must succeed: {e}"));
    let e = fillet(b, &es(b, edges), 1.01 * max, &opts()).expect_err("1.01·max must fail");
    assert_eq!(e.code(), "FILLET_RADIUS_TOO_LARGE", "{e}");
}

#[test]
fn a_radius_above_the_plate_thickness_reports_the_face_width() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let e = edge_near(&b, [20.0, 0.0, 6.0]);
    let err = fillet(&b, &es(&b, &[e]), 7.0, &opts()).expect_err("too large");
    let (max, edges) = radius_limit(&err);
    assert!((5.99..=6.0).contains(&max), "{max}");
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].2, Limit::FaceWidth);
    let d = err.details();
    assert_eq!(d["r"], 7.0);
    assert!(d["edges"][0]["face"].is_string(), "{d:?}");
    assert_property(&b, &[e], max);
}

#[test]
fn two_fillets_on_one_face_share_its_width() {
    // A face 6.82 wide between two filleted edges: the width is shared (2r < 6.82),
    // computed analytically and reported as the face's width limit (SPEC §6.6).
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 6.82, 10.0]);
    let e1 = edge_near(&b, [20.0, 0.0, 10.0]);
    let e2 = edge_near(&b, [20.0, 6.82, 10.0]);
    let err = fillet(&b, &es(&b, &[e1, e2]), 4.0, &opts()).expect_err("too large");
    let (max, edges) = radius_limit(&err);
    // 3.41 itself would consume the face entirely (a full round, which Forge does not build:
    // see the contract issue on 3.41 vs 3.409).
    assert_eq!(max.to_bits(), 3.409f64.to_bits(), "{max}");
    assert!(edges.iter().all(|x| x.2 == Limit::FaceWidth), "{edges:?}");
    let top = forge_blend::KeyMap::derive(&b)
        .face(face_near(&b, [20.0, 3.41, 10.0]))
        .expect("key")
        .key;
    let d = err.details();
    for x in d["edges"].as_array().expect("edges") {
        assert_eq!(x["face"], top.as_str(), "{d:?}");
    }
    assert_property(&b, &[e1, e2], max);
}

#[test]
fn the_spec_example_names_the_narrow_face() {
    // SPEC §6.6: a slab 6.82 × 40 × 10, its four vertical edges filleted with r = 4.
    let b = aabox("e1", [0.0, 0.0, 0.0], [6.82, 40.0, 10.0]);
    let keys = forge_blend::KeyMap::derive(&b);
    let vertical: Vec<_> = b
        .edges()
        .iter()
        .map(|(id, _)| id)
        .filter(|&e| {
            matches!(&b.edge(e).expect("edge").curve,
                forge_core::geom::Curve3::Line(l) if l.dir().z.abs() > 0.5)
        })
        .collect();
    assert_eq!(vertical.len(), 4);
    let err = fillet(&b, &es(&b, &vertical), 4.0, &opts()).expect_err("too large");
    let (max, edges) = radius_limit(&err);
    assert_eq!(max.to_bits(), 3.409f64.to_bits(), "{err}");
    assert_eq!(edges.len(), 4);
    assert!(
        edges.iter().all(|e| e.1.to_bits() == max.to_bits()),
        "{err}"
    );
    // Each edge is limited by its 6.82-wide face (y = 0 or y = 40), not by the cap.
    let narrow = [
        keys.face(face_near(&b, [3.41, 0.0, 5.0])).expect("key").key,
        keys.face(face_near(&b, [3.41, 40.0, 5.0]))
            .expect("key")
            .key,
    ];
    for x in err.details()["edges"].as_array().expect("edges") {
        assert_eq!(x["limit"], "face-width");
        assert!(narrow.iter().any(|k| x["face"] == k.as_str()), "{x}");
    }
    // SPEC §6.6's diagnostic: the face by display name, with its width (W6 review round 6).
    let msg = err.to_string();
    assert!(
        narrow
            .iter()
            .any(|k| msg.contains(&format!("(face width 6.82 at {k}, edge "))),
        "{msg}"
    );
    assert_property(&b, &vertical, max);
}

#[test]
fn a_huge_radius_still_gets_the_feasible_range() {
    // The search starts from an absolute floor, whatever the requested value; far above the
    // body's size the analytic limit is computed at, and the descent starts from, a thousand
    // times its size (W6 review round 6: r = 1e300 spent the search budget and failed).
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let e = edge_near(&b, [20.0, 0.0, 6.0]);
    for r in [50.0, 1e4, 1e9, 1e300, f64::MAX] {
        let err = fillet(&b, &es(&b, &[e]), r, &opts()).expect_err("too large");
        let (max, _) = radius_limit(&err);
        assert_eq!(max.to_bits(), 5.999f64.to_bits(), "r {r}: {err}");
        assert!(err.to_string().len() < 400, "{err}");
    }
    // The chamfer likewise.
    let err = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 1e300 }, &opts())
        .expect_err("too large");
    assert_eq!(err.code(), "CHAMFER_DISTANCE_TOO_LARGE", "{err}");
    assert_eq!(err.details()["max_feasible_d"], 5.999, "{err}");
}

#[test]
fn max_feasible_r_is_the_minimum_of_the_edges_and_is_built() {
    // The top and bottom edges of a 12 mm front face share its width: 2r < 12. The limit
    // 6.0 itself does not build (the face would vanish), so the suggestion steps down to
    // 5.999 — and every edge's `max_r` with it (never above `max_feasible_r`).
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 12.0]);
    let top = edge_near(&b, [20.0, 0.0, 12.0]);
    let bottom = edge_near(&b, [20.0, 0.0, 0.0]);
    let err = fillet(&b, &es(&b, &[top, bottom]), 8.0, &opts()).expect_err("too large");
    let (max, edges) = radius_limit(&err);
    assert_eq!(max.to_bits(), 5.999f64.to_bits(), "{err}");
    let min = edges.iter().map(|e| e.1).fold(f64::INFINITY, f64::min);
    assert_eq!(min.to_bits(), max.to_bits(), "{err}");
    assert!(
        edges.iter().all(|e| e.1.to_bits() == max.to_bits()),
        "{err}"
    );
    assert_property(&b, &[top, bottom], max);
}

#[test]
fn a_boss_rim_is_limited_by_its_radius() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 5.0]);
    let boss = zcyl("e2", [20.0, 15.0], 5.0, 6.0, 10.0);
    let b = join(plate, boss, "j1");
    let top = circle_near(&b, [26.0, 15.0, 15.0]);
    let err = fillet(&b, &es(&b, &[top]), 6.5, &opts()).expect_err("too large");
    let (max, edges) = radius_limit(&err);
    assert!((5.99..6.0).contains(&max), "{max}");
    assert_eq!(edges[0].2, Limit::Curvature, "{edges:?}");
    assert_property(&b, &[top], max);
}

#[test]
fn a_hole_rim_is_limited_by_the_plate_thickness() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 4.0]);
    let hole = zcyl("e2", [20.0, 15.0], -1.0, 5.0, 8.0);
    let b = cut(plate, hole, "c1");
    let top = circle_near(&b, [25.0, 15.0, 4.0]);
    let bottom = circle_near(&b, [25.0, 15.0, 0.0]);
    let err = fillet(&b, &es(&b, &[top, bottom]), 2.5, &opts()).expect_err("too large");
    let (max, _) = radius_limit(&err);
    assert!((1.99..2.0).contains(&max), "{max}");
    assert_property(&b, &[top, bottom], max);
}

#[test]
fn chamfer_distances_report_max_feasible_d() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let e = edge_near(&b, [20.0, 0.0, 6.0]);
    let err =
        chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 8.0 }, &opts()).expect_err("too large");
    assert_eq!(err.code(), "CHAMFER_DISTANCE_TOO_LARGE");
    let BlendError::DistanceTooLarge { max_feasible_d, .. } = err else {
        unreachable!()
    };
    assert!((5.99..6.0).contains(&max_feasible_d), "{max_feasible_d}");
    chamfer(
        &b,
        &es(&b, &[e]),
        &ChamferSpec::Equal { d: max_feasible_d },
        &opts(),
    )
    .expect("max works");
}

#[test]
fn unsupported_edges_are_listed_with_their_reason() {
    // The vertical edges of a slot wall are smooth (tangent faces).
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let tool = prism("e2", -1.0, slot([20.0, 15.0], 10.0, 3.0), 8.0);
    let b = cut(plate, tool, "c1");
    let smooth = edge_near(&b, [25.0, 12.0, 3.0]);
    let err = fillet(&b, &es(&b, &[smooth]), 1.0, &opts()).expect_err("smooth");
    assert_eq!(err.code(), "FILLET_EDGE_UNSUPPORTED");
    assert_eq!(err.details()["edges"][0]["reason"], "smooth");
}

#[test]
fn invalid_values_are_rejected() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let e = edge_near(&b, [2.0, 0.0, 4.0]);
    for r in [0.0, -1.0, 1e-7, f64::NAN] {
        let err = fillet(&b, &es(&b, &[e]), r, &opts()).expect_err("invalid");
        assert_eq!(err.code(), "INVALID_RADIUS");
    }
    let err = chamfer(
        &b,
        &es(&b, &[e]),
        &ChamferSpec::DistanceAngle {
            d: 1.0,
            angle_deg: 95.0,
            side: f1(&b, face_near(&b, [2.0, 2.0, 4.0])),
        },
        &opts(),
    )
    .expect_err("angle");
    assert_eq!(err.code(), "INVALID_VALUE");
}

#[test]
fn a_chamfer_side_must_bound_every_edge() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let e = edge_near(&b, [2.0, 0.0, 4.0]);
    let bottom = face_near(&b, [2.0, 2.0, 0.0]);
    let err = chamfer(
        &b,
        &es(&b, &[e]),
        &ChamferSpec::TwoDistances {
            d: 1.0,
            d2: 0.5,
            side: f1(&b, bottom),
        },
        &opts(),
    )
    .expect_err("side");
    assert_eq!(err.code(), "CHAMFER_SIDE_NOT_ADJACENT");
}

/// The chamfer form's feasible-range property: the suggested value (and, for two
/// distances, the `d2` that goes with it) builds; `1.01 ×` both fails with the same code.
fn assert_chamfer_property(
    b: &forge_core::topo::Body,
    e: forge_core::topo::EdgeId,
    spec: ChamferSpec,
) {
    let err = chamfer(b, &es(b, &[e]), &spec, &opts()).expect_err("too large");
    assert_eq!(err.code(), "CHAMFER_DISTANCE_TOO_LARGE", "{err}");
    let BlendError::DistanceTooLarge {
        d,
        max_feasible_d,
        edges,
        d2,
        ..
    } = &err
    else {
        unreachable!()
    };
    assert!(*max_feasible_d > 0.0 && max_feasible_d < d, "{err}");
    let min = edges.iter().map(|x| x.max_d).fold(f64::INFINITY, f64::min);
    assert_eq!(min.to_bits(), max_feasible_d.to_bits(), "{err}");
    let at = |scale: f64| -> ChamferSpec {
        match &spec {
            ChamferSpec::Equal { .. } => ChamferSpec::Equal {
                d: max_feasible_d * scale,
            },
            ChamferSpec::TwoDistances { side, .. } => ChamferSpec::TwoDistances {
                d: max_feasible_d * scale,
                d2: d2.expect("the d2 that goes with the suggestion").1 * scale,
                side: side.clone(),
            },
            ChamferSpec::DistanceAngle {
                angle_deg, side, ..
            } => ChamferSpec::DistanceAngle {
                d: max_feasible_d * scale,
                angle_deg: *angle_deg,
                side: side.clone(),
            },
        }
    };
    chamfer(b, &es(b, &[e]), &at(1.0), &opts())
        .unwrap_or_else(|x| panic!("the suggestion must build: {x} ({err})"));
    let above = chamfer(b, &es(b, &[e]), &at(1.01), &opts()).expect_err("1.01·max must fail");
    assert_eq!(above.code(), "CHAMFER_DISTANCE_TOO_LARGE", "{above}");
}

#[test]
fn every_chamfer_form_has_the_feasible_range_property() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let e = edge_near(&b, [20.0, 0.0, 6.0]);
    let top = f1(&b, face_near(&b, [20.0, 15.0, 6.0]));
    assert_chamfer_property(&b, e, ChamferSpec::Equal { d: 8.0 });
    // `d2` alone too large (on the 6 mm side face): both distances scale together.
    for d2 in [6.0, 6.5, 10.0, 50.0] {
        assert_chamfer_property(
            &b,
            e,
            ChamferSpec::TwoDistances {
                d: 1.0,
                d2,
                side: top.clone(),
            },
        );
    }
    // The bevel at 89° to the top face reaches far down the side face.
    assert_chamfer_property(
        &b,
        e,
        ChamferSpec::DistanceAngle {
            d: 1.0,
            angle_deg: 89.0,
            side: top.clone(),
        },
    );
}

#[test]
fn a_two_distance_limit_names_d2_and_lists_each_edge_once() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let e = edge_near(&b, [20.0, 0.0, 6.0]);
    let top = f1(&b, face_near(&b, [20.0, 15.0, 6.0]));
    let err = chamfer(
        &b,
        &es(&b, &[e]),
        &ChamferSpec::TwoDistances {
            d: 1.0,
            d2: 6.5,
            side: top,
        },
        &opts(),
    )
    .expect_err("d2 too large");
    assert_eq!(err.code(), "CHAMFER_DISTANCE_TOO_LARGE");
    assert!(err.to_string().contains("with d2 = "), "{err}");
    let d = err.details();
    let mut keys: Vec<String> = d["edges"]
        .as_array()
        .expect("edges")
        .iter()
        .map(|x| x["key"].as_str().expect("key").to_string())
        .collect();
    let n = keys.len();
    keys.dedup();
    assert_eq!(keys.len(), n, "{d:?}");
    // The catalogue's keys only (SPEC §6.7).
    let mut k: Vec<&str> = d.keys().map(String::as_str).collect();
    k.sort_unstable();
    assert_eq!(k, ["d", "edges", "max_feasible_d"]);
}

#[test]
fn a_distance_with_no_representable_feasible_value_fails_explicitly() {
    // At 89.9999° the other distance is 5.7e5 × d: only d < 1.1e-5 mm fits the 6 mm face.
    let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let e = edge_near(&b, [20.0, 0.0, 6.0]);
    let top = f1(&b, face_near(&b, [20.0, 15.0, 6.0]));
    let err = chamfer(
        &b,
        &es(&b, &[e]),
        &ChamferSpec::DistanceAngle {
            d: 1.0,
            angle_deg: 89.9999,
            side: top,
        },
        &opts(),
    )
    .expect_err("infeasible");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    assert!(err.to_string().contains("feasible"), "{err}");
    let d = err.details();
    assert_eq!(d["edges"].as_array().expect("edges").len(), 1, "{d:?}");
}

#[test]
fn an_empty_edge_set_is_named_as_such() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let err = fillet(&b, &[], 1.0, &opts()).expect_err("empty");
    assert_eq!(err.code(), "FILLET_FAILED");
    assert!(err.to_string().contains("empty"), "{err}");
    let err = chamfer(&b, &[], &ChamferSpec::Equal { d: 1.0 }, &opts()).expect_err("empty");
    assert_eq!(err.code(), "CHAMFER_FAILED");
}

/// W6 review round 4: one configuration, one classification. Two blended edges sharing a
/// 6.82 mm face are limited by that face's width whether the requested radius is far above
/// the limit (the analytic path) or at it (the search's bracket): `face-width` at the same
/// face both times (it was `adjacent-blend` at r = 3.41).
#[test]
fn the_limit_of_two_edges_on_one_face_is_classified_the_same_at_every_radius() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [6.82, 40.0, 10.0]);
    let e1 = edge_near(&b, [0.0, 20.0, 10.0]);
    let e2 = edge_near(&b, [6.82, 20.0, 10.0]);
    let mut seen = Vec::new();
    for r in [4.0, 3.41, 3.4101] {
        let err = fillet(&b, &es(&b, &[e1, e2]), r, &opts()).expect_err("too large");
        let (max, edges) = radius_limit(&err);
        assert_eq!(max.to_bits(), 3.409f64.to_bits(), "r {r}: {err}");
        let d = err.details();
        let got: Vec<(String, String)> = d["edges"]
            .as_array()
            .expect("edges")
            .iter()
            .map(|x| (x["limit"].to_string(), x["face"].to_string()))
            .collect();
        assert!(
            edges.iter().all(|x| x.2 == Limit::FaceWidth),
            "r {r}: {err}"
        );
        seen.push(got);
    }
    assert!(seen.windows(2).all(|w| w[0] == w[1]), "{seen:?}");
}

/// W6 review round 4: the feasible-range property is confirmed, not assumed. From 0.1 mm up
/// `1.01·max` fails; below it 1 % is less than the SPEC's 0.001 mm rounding step, so the
/// property is that the next multiple of 0.001 mm fails (`1.01·max` may lie below the true
/// limit, which is between `max` and `max + 0.001`).
#[test]
fn the_feasible_range_property_holds_for_small_values() {
    for (h, r) in [
        (0.15, 0.2),
        (0.101, 0.2),
        (0.05, 0.08),
        (0.02, 0.05),
        (0.012, 0.03),
    ] {
        let b = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, h]);
        let e = edge_near(&b, [20.0, 0.0, h]);
        let err = fillet(&b, &es(&b, &[e]), r, &opts()).expect_err("too large");
        let (max, _) = radius_limit(&err);
        assert!(max < h && max > h - 0.003, "h {h}: {max}");
        fillet(&b, &es(&b, &[e]), max, &opts()).expect("max builds");
        let next = ((max * 1000.0).round() + 1.0) / 1000.0;
        let above = if max >= 0.1 { 1.01 * max } else { next };
        let e1 = fillet(&b, &es(&b, &[e]), above, &opts()).expect_err("above fails");
        assert_eq!(e1.code(), "FILLET_RADIUS_TOO_LARGE", "h {h}: {e1}");
        let e2 = fillet(&b, &es(&b, &[e]), next, &opts()).expect_err("next fails");
        assert_eq!(e2.code(), "FILLET_RADIUS_TOO_LARGE", "h {h}: {e2}");
        let e2 = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: r }, &opts())
            .expect_err("too large");
        let BlendError::DistanceTooLarge { max_feasible_d, .. } = &e2 else {
            panic!("{} {e2}", e2.code());
        };
        chamfer(
            &b,
            &es(&b, &[e]),
            &ChamferSpec::Equal { d: *max_feasible_d },
            &opts(),
        )
        .expect("max works");
        let m = *max_feasible_d;
        let next = ((m * 1000.0).round() + 1.0) / 1000.0;
        let above = if m >= 0.1 { 1.01 * m } else { next };
        let e3 = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: above }, &opts())
            .expect_err("above fails");
        assert_eq!(e3.code(), "CHAMFER_DISTANCE_TOO_LARGE", "{e3}");
    }
}

/// W6 review round 4: a convex blend ending at a reflex vertex (a pentagon prism's inner
/// corner, an L-block's inner corner: the next side face meets the blend on the material's
/// side) ends on that face's plane, the face taking the end cap and the top edge running on
/// along its carrier — OCCT's result — instead of failing after a search down to the floor
/// that blamed a face far away. Closed form: the wedge `(1 − π/4)·r²` swept along the edge,
/// its centroid line (`δ = r(10 − 3π)/(12 − 3π)` in from both faces) cut by the end planes.
#[test]
fn a_blend_ending_at_a_reflex_vertex_ends_on_the_face_plane() {
    use forge_core::math::PI;
    let wedge = 1.0 - PI / 4.0;
    let delta = (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI);
    let b = prism(
        "e1",
        0.0,
        polygon(&[
            [0.0, 0.0],
            [20.0, 0.0],
            [20.0, 20.0],
            [10.0, 10.0],
            [0.0, 20.0],
        ]),
        5.0,
    );
    let e = edge_near(&b, [15.0, 15.0, 5.0]);
    let out = fillet(&b, &es(&b, &[e]), 1.0, &opts()).expect("reflex end");
    assert_valid(&out.body);
    // The end at (10, 10) is perpendicular to the edge; the one at (20, 20) is at 45°, where
    // the centroid line starts δ further along.
    let want = 1500.0 - wedge * (200f64.sqrt() - delta);
    assert!(
        rel(volume(&out.body), want) < 1e-12,
        "{} vs {want}",
        volume(&out.body)
    );
    // OCCT (BRepFilletAPI_MakeFillet): 1497.013008.
    assert!((volume(&out.body) - 1497.013008).abs() < 1e-5);
    // An L-block's inner corner: both ends perpendicular (OCCT 1277.424778; chamfer 1274.0).
    let l = prism(
        "e1",
        0.0,
        polygon(&[
            [0.0, 0.0],
            [20.0, 0.0],
            [20.0, 8.0],
            [8.0, 8.0],
            [8.0, 20.0],
            [0.0, 20.0],
        ]),
        5.0,
    );
    let e = edge_near(&l, [8.0, 14.0, 5.0]);
    let out = fillet(&l, &es(&l, &[e]), 1.0, &opts()).expect("inner corner end");
    assert_valid(&out.body);
    assert!(
        rel(volume(&out.body), 1280.0 - wedge * 12.0) < 1e-12,
        "{}",
        volume(&out.body)
    );
    let out =
        chamfer(&l, &es(&l, &[e]), &ChamferSpec::Equal { d: 1.0 }, &opts()).expect("chamfer end");
    assert_valid(&out.body);
    assert!(
        rel(volume(&out.body), 1274.0) < 1e-12,
        "{}",
        volume(&out.body)
    );
    // The end cap joins the inner wall: no face is added.
    assert_eq!(forge_check::body_metrics(&out.body).unwrap().faces, 9);
}
