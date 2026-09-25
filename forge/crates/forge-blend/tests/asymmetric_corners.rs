//! Two blended edges meeting asymmetrically at a vertex (their dihedral angles differ): the
//! rolling-ball result as OCCT builds it — the mitre runs to the side face it reaches first
//! and the other blend ends on that face, no corner patch. Checked against the **exact**
//! result (the base minus the union of the two blends' tools — each edge's cross-section
//! swept along it and clipped by the face it ends on — as OCCT booleans) and OCCT's own
//! BRepFilletAPI_MakeFillet / MakeChamfer (VolumePropertiesGK): OCCT's fillets are 1e-8
//! off the exact value (its mitre is approximated), its chamfers exact.

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};

/// A triangular prism `(0,0), (10,0), p` × 6; its vertical edge at the origin and its bottom
/// edge along x, blended together.
fn corner(
    p: [f64; 2],
) -> (
    forge_core::topo::Body,
    Vec<forge_blend::Pick<forge_core::topo::EdgeId>>,
) {
    let b = prism("base", 0.0, polygon(&[[0.0, 0.0], [10.0, 0.0], p]), 6.0);
    let vert = edge_near(&b, [0.0, 0.0, 3.0]);
    let bot = edge_near(&b, [5.0, 0.0, 0.0]);
    let picks = es(&b, &[vert, bot]);
    (b, picks)
}

fn check(body: &forge_core::topo::Body, exact: f64, occt: f64) {
    assert_valid(body);
    let v = volume(body);
    assert!(rel(v, exact) < 1e-10, "{v} vs exact {exact}");
    assert!(rel(v, occt) < 1e-6, "{v} vs OCCT {occt}: MATCH needs 1e-6");
    let m = forge_check::body_metrics(body).unwrap();
    assert_eq!(m.faces, 7, "OCCT has 7 faces: no corner patch");
    let hits = forge_blend::self_intersections(body).expect("certified");
    assert!(hits.is_empty(), "{hits:?}");
}

#[test]
fn an_acute_prism_corner_ends_the_vertical_blend_on_the_bottom() {
    // The mitre reaches the bottom face first: the vertical blend continues to it.
    let (b, e) = corner([3.0, 8.0]);
    let out = fillet(&b, &e, 1.0, &BlendOptions::new("f1")).expect("fillet");
    check(&out.body, 235.21756214256015, 235.21756433469488);
    assert_eq!(
        forge_check::body_metrics(&out.body)
            .unwrap()
            .face_types
            .get("cylinder"),
        Some(&2)
    );
    let out = chamfer(
        &b,
        &e,
        &ChamferSpec::Equal { d: 1.0 },
        &BlendOptions::new("c1"),
    )
    .expect("chamfer");
    check(&out.body, 232.72139166794946, 232.72139166794943);
}

#[test]
fn an_obtuse_prism_corner_ends_the_bottom_blend_on_the_side() {
    let (b, e) = corner([-3.0, 8.0]);
    let out = fillet(&b, &e, 1.0, &BlendOptions::new("f1")).expect("fillet");
    check(&out.body, 237.4398865081288, 237.43989060070018);
    let out = chamfer(
        &b,
        &e,
        &ChamferSpec::Equal { d: 1.0 },
        &BlendOptions::new("c1"),
    )
    .expect("chamfer");
    check(&out.body, 232.7213916679495, 232.72139166794946);
}
