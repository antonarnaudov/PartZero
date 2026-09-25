//! Corners where convex and concave blended edges meet (an L-block's inner corner, a rib on
//! a plate): the rolling-ball result, equal to OCCT's (values from BRepFilletAPI on the same
//! bodies).

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};

fn lblock() -> forge_core::topo::Body {
    let (w, d, a, b) = (30.0, 20.0, 12.0, 8.0);
    prism(
        "base",
        0.0,
        polygon(&[[0.0, 0.0], [w, 0.0], [w, b], [a, b], [a, d], [0.0, d]]),
        10.0,
    )
}

#[test]
fn an_l_block_inner_corner_is_a_torus_around_the_concave_fillet() {
    let b = lblock();
    let top1 = edge_near(&b, [21.0, 8.0, 10.0]);
    let top2 = edge_near(&b, [12.0, 14.0, 10.0]);
    let vert = edge_near(&b, [12.0, 8.0, 5.0]);
    let out = fillet(
        &b,
        &es(&b, &[top1, top2, vert]),
        2.0,
        &BlendOptions::new("f1"),
    )
    .expect("fillet");
    assert_valid(&out.body);
    // OCCT: V=3822.9663451333 A=1734.8453957563 F=12 E=28, cylinder 3 torus 1.
    assert!(
        (volume(&out.body) - 3822.9663451333).abs() < 1e-8,
        "{}",
        volume(&out.body)
    );
    assert!(
        (area(&out.body) - 1734.8453957563).abs() < 1e-8,
        "{}",
        area(&out.body)
    );
    let m = forge_check::body_metrics(&out.body).unwrap();
    assert_eq!((m.faces, m.edges), (12, 28));
    assert_eq!(m.face_types.get("torus"), Some(&1));
    // Without the tangent chain the corner still closes (the arcs belong to the corner).
    let mut o = BlendOptions::new("f1");
    o.tangent_chain = false;
    let out2 = fillet(&b, &es(&b, &[top1, top2, vert]), 2.0, &o).expect("fillet");
    assert!((volume(&out2.body) - volume(&out.body)).abs() < 1e-9);
}

#[test]
fn a_rib_root_corner_is_a_torus_around_the_convex_fillet() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 5.0]);
    let rib = aabox("e2", [10.0, 10.0, 5.0], [10.0, 8.0, 6.0]);
    let b = join(plate, rib, "j1");
    let root1 = edge_near(&b, [15.0, 10.0, 5.0]);
    let root2 = edge_near(&b, [10.0, 14.0, 5.0]);
    let vert = edge_near(&b, [10.0, 10.0, 8.0]);
    let out = fillet(
        &b,
        &es(&b, &[root1, root2, vert]),
        1.5,
        &BlendOptions::new("f1"),
    )
    .expect("fillet");
    assert_valid(&out.body);
    // OCCT after UnifySameDomain: V=6485.7375107498 A=3302.1790764365 F=15 E=34 (OCCT's raw
    // result keeps the end walls' root edges split where the root fillets extend them).
    assert!(
        (volume(&out.body) - 6485.7375107498).abs() < 1e-8,
        "{}",
        volume(&out.body)
    );
    assert!(
        (area(&out.body) - 3302.1790764365).abs() < 1e-8,
        "{}",
        area(&out.body)
    );
    let m = forge_check::body_metrics(&out.body).unwrap();
    assert_eq!((m.faces, m.edges), (15, 34));
    assert_eq!(m.face_types.get("torus"), Some(&1));
}

#[test]
fn a_mixed_chamfer_corner_is_occts_planar_quadrilateral() {
    // OCCT's chamfer corner there differs from both orders of a two-pass construction: a
    // planar quadrilateral through the contact-line corners.
    let b = lblock();
    let top1 = edge_near(&b, [21.0, 8.0, 10.0]);
    let top2 = edge_near(&b, [12.0, 14.0, 10.0]);
    let vert = edge_near(&b, [12.0, 8.0, 5.0]);
    let out = chamfer(
        &b,
        &es(&b, &[top1, top2, vert]),
        &ChamferSpec::Equal { d: 2.0 },
        &BlendOptions::new("c1"),
    )
    .expect("chamfer");
    assert_valid(&out.body);
    // OCCT: V=3802.6666666667 A=1724.5588270868 F=12 E=28 (all planes).
    assert!(
        (volume(&out.body) - 3802.6666666667).abs() < 1e-8,
        "{}",
        volume(&out.body)
    );
    assert!(
        (area(&out.body) - 1724.5588270868).abs() < 1e-8,
        "{}",
        area(&out.body)
    );
    let m = forge_check::body_metrics(&out.body).unwrap();
    assert_eq!((m.faces, m.edges), (12, 28));
    assert!(
        out.report
            .faces_created
            .iter()
            .any(|k| k.starts_with("c1/corner:{"))
    );
}
