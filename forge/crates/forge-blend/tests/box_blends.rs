//! Fillets and chamfers of box edges against closed forms (and the OCCT values they match:
//! BRepFilletAPI on the same box, `forge-blend/oracle/occt_blend_diff.py`).

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::math::PI;

/// Box [0,10]×[0,20]×[0,30]: an x edge on top at y = 0, a y edge on top at x = 0, the
/// vertical edge at x = y = 0 — the three edges of the corner (0, 0, 30).
fn corner_edges(b: &forge_core::topo::Body) -> [forge_core::topo::EdgeId; 3] {
    [
        edge_near(b, [5.0, 0.0, 30.0]),
        edge_near(b, [0.0, 10.0, 30.0]),
        edge_near(b, [0.0, 0.0, 15.0]),
    ]
}

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

#[test]
fn one_box_edge_fillet_is_a_quarter_cylinder_trimmed_by_the_end_faces() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let [ex, _, _] = corner_edges(&b);
    let out = fillet(&b, &es(&b, &[ex]), 2.0, &opts()).expect("fillet");
    assert_valid(&out.body);
    let v = volume(&out.body);
    let expect = 6000.0 - (4.0 - PI) * 10.0;
    assert!(rel(v, expect) < 1e-12, "{v} vs {expect}");
    assert_eq!(face_types(&out.body)["cylinder"], 1);
    assert_eq!(face_types(&out.body)["plane"], 6);
    let et = edge_types(&out.body);
    assert_eq!((et["line"], et["circle"]), (13, 2), "{et:?}");
    assert_eq!(out.report.faces_created.len(), 1);
    assert!(out.report.faces_created[0].starts_with("f1/blend:{e1/edge:{"));
}

#[test]
fn two_box_edges_at_a_corner_meet_in_an_elliptic_mitre() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let [ex, ey, _] = corner_edges(&b);
    let out = fillet(&b, &es(&b, &[ex, ey]), 2.0, &opts()).expect("fillet");
    assert_valid(&out.body);
    // OCCT: 5975.01474229.
    let v = volume(&out.body);
    assert!((v - 5975.01474229).abs() < 1e-6, "{v}");
    let et = edge_types(&out.body);
    assert_eq!(et.get("ellipse"), Some(&1), "{et:?}");
    assert_eq!(forge_check::body_metrics(&out.body).unwrap().edges, 17);
}

#[test]
fn three_box_edges_at_a_corner_close_with_the_normative_sphere() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let out = fillet(&b, &es(&b, &corner_edges(&b)), 2.0, &opts()).expect("fillet");
    assert_valid(&out.body);
    let r: f64 = 2.0;
    let quarter = (4.0 - PI) * r * r / 4.0 * 4.0 / 4.0;
    // Edges shortened by r at the corner; the corner cube r³ minus the ball's octant.
    let expect =
        6000.0 - (4.0 - PI) * (8.0 + 18.0 + 28.0) - (r * r * r - 4.0 / 3.0 * PI * r * r * r / 8.0);
    let _ = quarter;
    let v = volume(&out.body);
    assert!(rel(v, expect) < 1e-12, "{v} vs {expect}");
    let ft = face_types(&out.body);
    assert_eq!(
        (ft["plane"], ft["cylinder"], ft["sphere"]),
        (6, 3, 1),
        "{ft:?}"
    );
    assert_eq!(forge_check::body_metrics(&out.body).unwrap().edges, 21);
    assert!(
        out.report
            .faces_created
            .iter()
            .any(|k| k.starts_with("f1/corner:{"))
    );
}

#[test]
fn every_box_edge_filleted_is_the_rounded_box() {
    let (a, b_, c, r) = (10.0, 20.0, 30.0, 2.0);
    let b = aabox("e1", [0.0, 0.0, 0.0], [a, b_, c]);
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let out = fillet(&b, &es(&b, &all), r, &opts()).expect("fillet");
    assert_valid(&out.body);
    let expect = (a - 2.0 * r) * (b_ - 2.0 * r) * (c - 2.0 * r)
        + 2.0
            * r
            * ((a - 2.0 * r) * (b_ - 2.0 * r)
                + (b_ - 2.0 * r) * (c - 2.0 * r)
                + (a - 2.0 * r) * (c - 2.0 * r))
        + PI * r * r * ((a - 2.0 * r) + (b_ - 2.0 * r) + (c - 2.0 * r))
        + 4.0 / 3.0 * PI * r * r * r;
    let v = volume(&out.body);
    assert!(rel(v, expect) < 1e-12, "{v} vs {expect}");
    let m = forge_check::body_metrics(&out.body).unwrap();
    assert_eq!((m.faces, m.edges), (26, 48));
}

#[test]
fn box_chamfers_match_the_occt_corner_shapes() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let [ex, ey, ez] = corner_edges(&b);
    let c = |ids: &[forge_core::topo::EdgeId]| {
        let out =
            chamfer(&b, &es(&b, ids), &ChamferSpec::Equal { d: 2.0 }, &opts()).expect("chamfer");
        assert_valid(&out.body);
        (
            volume(&out.body),
            forge_check::body_metrics(&out.body).unwrap(),
        )
    };
    let (v1, m1) = c(&[ex]);
    assert!((v1 - 5980.0).abs() < 1e-9, "{v1}");
    assert_eq!((m1.faces, m1.edges), (7, 15));
    let (v2, m2) = c(&[ex, ey]);
    assert!((v2 - 5942.666666666667).abs() < 1e-9, "{v2}");
    assert_eq!((m2.faces, m2.edges), (8, 17));
    let (v3, m3) = c(&[ex, ey, ez]);
    assert!((v3 - 5885.333333333333).abs() < 1e-9, "{v3}");
    assert_eq!((m3.faces, m3.edges), (10, 21));
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let (va, ma) = c(&all);
    assert!((va - 5562.666666666667).abs() < 1e-9, "{va}");
    assert_eq!((ma.faces, ma.edges), (26, 48));
}

#[test]
fn new_entities_follow_the_key_grammar() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let out = fillet(&b, &es(&b, &all), 2.0, &opts()).expect("fillet");
    let mut labels = std::collections::BTreeSet::new();
    for (_, f) in out.body.faces().iter() {
        let k = f.provenance.key();
        let p = forge_core::topo::parse_key(&k).unwrap_or_else(|e| panic!("{k}: {e}"));
        assert!(f.provenance.problems().is_empty(), "{k}");
        if p.feature == "f1" {
            labels.insert(p.label.clone());
            // `F/blend:{E}` names an input edge key; `F/corner:{V}` an input vertex key.
            let forge_core::topo::KeyRoleArg::Keys(ks) = &p.arg else {
                panic!("{k} has no nested key")
            };
            assert_eq!(ks.len(), 1, "{k}");
            let inner = forge_core::topo::parse_key(&ks[0]).expect("nested key parses");
            assert_eq!(inner.feature, "e1", "{k}");
        }
    }
    assert_eq!(labels.into_iter().collect::<Vec<_>>(), ["blend", "corner"]);
    for (_, e) in out.body.edges().iter() {
        assert!(
            e.provenance.problems().is_empty(),
            "{}",
            e.provenance.name()
        );
        forge_core::topo::parse_key(&e.provenance.key()).expect("edge key parses");
    }
    for (_, v) in out.body.vertices().iter() {
        assert!(
            v.provenance.problems().is_empty(),
            "{}",
            v.provenance.name()
        );
    }
    // 12 blends + 8 corners, all reported.
    assert_eq!(out.report.faces_created.len(), 20);
}

/// A prism over the triangle (0,0), (20,0), (5,15): its vertical and horizontal faces meet at
/// right angles, the vertical ones at 45°, 71.6° and 63.4°.
fn triangular_prism() -> forge_core::topo::Body {
    prism(
        "e1",
        0.0,
        polygon(&[[0.0, 0.0], [20.0, 0.0], [5.0, 15.0]]),
        10.0,
    )
}

#[test]
fn chamfer_corners_at_oblique_vertices_are_refused_until_the_contract_defines_them() {
    // W6 review round 6: SPEC §6.7 defines no chamfer corner, and OCCT's corner at these
    // vertices differs from the corner triangle (8.9e-5 of the volume here, up to 2.35e-3 on
    // the F2 corpus) — beyond §8.3 rule 5's 1e-5, a potential silent-wrong row. Chamfering
    // every edge meets three chamfers at each vertex: an explicit failure naming one.
    let b = triangular_prism();
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let err = chamfer(&b, &es(&b, &all), &ChamferSpec::Equal { d: 1.0 }, &opts())
        .expect_err("oblique chamfer corners");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    let m = err.to_string();
    assert!(
        m.contains("not mutually perpendicular") && m.contains("/vertex:"),
        "{m}"
    );
    // The top loop alone (two chamfers per vertex, meeting in a mitre) still builds.
    let top: Vec<_> = [[10.0, 0.0, 10.0], [12.5, 7.5, 10.0], [2.5, 7.5, 10.0]]
        .iter()
        .map(|p| edge_near(&b, *p))
        .collect();
    let out = chamfer(&b, &es(&b, &top), &ChamferSpec::Equal { d: 1.0 }, &opts())
        .expect("mitres at oblique vertices");
    assert_valid(&out.body);
    assert!(volume(&out.body) < volume(&b));
}

#[test]
fn fillet_corners_at_oblique_vertices_close_with_the_ball() {
    // The rolling-ball corner is the sphere at every vertex (equal to OCCT's).
    let b = triangular_prism();
    let v0 = volume(&b);
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let out = fillet(&b, &es(&b, &all), 1.0, &opts()).expect("fillet");
    assert_valid(&out.body);
    assert_eq!(face_types(&out.body).get("sphere"), Some(&6));
    assert!(volume(&out.body) < v0);
}
