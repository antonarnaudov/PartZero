//! Torus fillets and cone chamfers of circular edges (holes, bosses), tangent chains around
//! slots, with closed-form (Pappus) volumes.

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::math::PI;

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

/// Volume of the ring removed by a fillet of radius `r` on a convex circular edge of radius
/// `big` whose material lies **outside** the circle (a hole's rim) — also the volume a
/// concave fillet adds at a boss root of radius `big`.
fn ring_outside(big: f64, r: f64) -> f64 {
    2.0 * PI
        * (r * r * big + r * r * r / 2.0 - PI * r * r * big / 4.0 - PI * r * r * r / 4.0
            + r * r * r / 3.0)
}

/// … whose material lies **inside** the circle (a boss's top rim).
fn ring_inside(big: f64, r: f64) -> f64 {
    2.0 * PI * (r * r * (big - r / 2.0) - PI * r * r / 4.0 * (big - r + 4.0 * r / (3.0 * PI)))
}

fn plate_with_hole() -> forge_core::topo::Body {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let hole = zcyl("e2", [20.0, 15.0], -1.0, 5.0, 8.0);
    cut(plate, hole, "c1")
}

#[test]
fn a_hole_rim_fillet_is_a_torus_and_removes_the_pappus_ring() {
    let b = plate_with_hole();
    let v0 = volume(&b);
    let rim = circle_near(&b, [25.0, 15.0, 6.0]);
    for r in [0.5, 1.0, 2.5] {
        let out = fillet(&b, &es(&b, &[rim]), r, &opts()).expect("fillet");
        assert_valid(&out.body);
        let v = volume(&out.body);
        let expect = v0 - ring_outside(5.0, r);
        assert!(rel(v, expect) < 1e-11, "r {r}: {v} vs {expect}");
        assert_eq!(face_types(&out.body).get("torus"), Some(&1));
    }
}

#[test]
fn a_hole_rim_chamfer_is_a_cone() {
    let b = plate_with_hole();
    let v0 = volume(&b);
    let rim = circle_near(&b, [25.0, 15.0, 6.0]);
    let d = 1.5;
    let out = chamfer(&b, &es(&b, &[rim]), &ChamferSpec::Equal { d }, &opts()).expect("chamfer");
    assert_valid(&out.body);
    let expect = v0 - 2.0 * PI * (5.0 + d / 3.0) * d * d / 2.0;
    let v = volume(&out.body);
    assert!(rel(v, expect) < 1e-11, "{v} vs {expect}");
    assert_eq!(face_types(&out.body).get("cone"), Some(&1));
}

#[test]
fn boss_rims_fillet_inside_and_the_root_adds_material() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 5.0]);
    let boss = zcyl("e2", [20.0, 15.0], 5.0, 6.0, 10.0);
    let b = join(plate, boss, "j1");
    let v0 = volume(&b);
    let top = circle_near(&b, [26.0, 15.0, 15.0]);
    let root = circle_near(&b, [26.0, 15.0, 5.0]);
    // Top rim (convex, material inside the circle); spindle torus for r > R/2.
    for r in [1.0, 4.0] {
        let out = fillet(&b, &es(&b, &[top]), r, &opts()).expect("top fillet");
        assert_valid(&out.body);
        let expect = v0 - ring_inside(6.0, r);
        let v = volume(&out.body);
        assert!(rel(v, expect) < 1e-11, "r {r}: {v} vs {expect}");
    }
    // Root (concave): material added.
    let out = fillet(&b, &es(&b, &[root]), 1.5, &opts()).expect("root fillet");
    assert_valid(&out.body);
    let expect = v0 + ring_outside(6.0, 1.5);
    let v = volume(&out.body);
    assert!(rel(v, expect) < 1e-11, "{v} vs {expect}");
    // Both at once.
    let out = fillet(&b, &es(&b, &[top, root]), 1.0, &opts()).expect("both");
    assert_valid(&out.body);
    let expect = v0 - ring_inside(6.0, 1.0) + ring_outside(6.0, 1.0);
    assert!(rel(volume(&out.body), expect) < 1e-11);
}

#[test]
fn a_blind_hole_floor_fillet_bounds_the_right_torus_band() {
    // The floor edge is concave; the blend's band crosses the torus's v = 0 circle.
    let plate = aabox("e1", [0.0, 0.0, 0.0], [31.0, 20.5, 10.5]);
    let hole = zcyl("h0", [10.0, 10.5], 1.5, 5.5, 10.0);
    let b = cut(plate, hole, "c1");
    let v0 = volume(&b);
    let floor = circle_near(&b, [4.5, 10.5, 1.5]);
    for r in [1.95, 3.5] {
        let out = fillet(&b, &es(&b, &[floor]), r, &opts()).expect("fillet");
        assert_valid(&out.body);
        let expect = v0 + ring_inside(5.5, r);
        let v = volume(&out.body);
        assert!(rel(v, expect) < 1e-11, "r {r}: {v} vs {expect}");
    }
}

#[test]
fn concave_pocket_corners_close_with_a_sphere_or_a_triangle() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 10.0]);
    let pocket = prism("p1", 6.0, rect(10.0, 8.0, 20.0, 14.0), 5.0);
    let b = cut(plate, pocket, "c1");
    let v0 = volume(&b);
    let concave: Vec<_> = b
        .edges()
        .iter()
        .map(|(id, _)| id)
        .filter(|&e| forge_blend::edge_convexity(&b, e) == Some(forge_blend::Convexity::Concave))
        .collect();
    assert_eq!(concave.len(), 8);
    let (a, bb, c) = (20.0, 14.0, 4.0);
    let r = 1.5;
    let out = fillet(&b, &es(&b, &concave), r, &opts()).expect("fillet");
    assert_valid(&out.body);
    let k = (1.0 - PI / 4.0) * r * r;
    let expect = v0
        + 4.0 * k * (c - r)
        + k * (2.0 * (a - 2.0 * r) + 2.0 * (bb - 2.0 * r))
        + 4.0 * (r * r * r - PI * r * r * r / 6.0);
    assert!(
        rel(volume(&out.body), expect) < 1e-11,
        "{} vs {expect}",
        volume(&out.body)
    );
    assert_eq!(face_types(&out.body).get("sphere"), Some(&4));
    let d = 1.2;
    let out = chamfer(&b, &es(&b, &concave), &ChamferSpec::Equal { d }, &opts()).expect("chamfer");
    assert_valid(&out.body);
    let expect = v0
        + d * d / 2.0 * (4.0 * (c - d) + 2.0 * (a - 2.0 * d) + 2.0 * (bb - 2.0 * d))
        + 4.0 * 5.0 / 6.0 * d * d * d;
    assert!(
        rel(volume(&out.body), expect) < 1e-11,
        "{} vs {expect}",
        volume(&out.body)
    );
}

#[test]
fn a_slot_rim_fillet_follows_the_tangent_chain() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let tool = prism("e2", -1.0, slot([20.0, 15.0], 10.0, 3.0), 8.0);
    let b = cut(plate, tool, "c1");
    let v0 = volume(&b);
    // One straight rim edge on top; the chain adds the other three.
    let e = edge_near(&b, [20.0, 12.0, 6.0]);
    let r = 1.0;
    let out = fillet(&b, &es(&b, &[e]), r, &opts()).expect("fillet");
    assert_valid(&out.body);
    assert_eq!(out.chain_added.len(), 3, "{:?}", out.report);
    let expect = v0 - 2.0 * 10.0 * (1.0 - PI / 4.0) * r * r - ring_outside(3.0, r);
    let v = volume(&out.body);
    assert!(rel(v, expect) < 1e-11, "{v} vs {expect}");
    // Without the chain, the blend would end on a cylinder: an explicit failure.
    let mut o = opts();
    o.tangent_chain = false;
    let err = fillet(&b, &es(&b, &[e]), r, &o).expect_err("unsupported end");
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
}
