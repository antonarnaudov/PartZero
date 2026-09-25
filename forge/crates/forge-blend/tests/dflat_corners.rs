//! A D-flat's top edges — a line on the flat and an arc on the shaft, meeting at the flat's
//! corners at an angle — blended together (W6 review round 4: the curved mitre, a capability
//! gap against OCCT on the F2 corpus's `dflat` rows). OCCT (`BRepFilletAPI_MakeFillet`,
//! `MakeChamfer`) on the same body gives the volumes below (its corner blends are
//! approximations): Forge agrees within 2e-8 relative. The union of the two rolling-ball tools
//! run on past the corners — the independent reference of the oracle script for planar
//! corners — is not the result here (it removes 1.6e-3 mm³ more at r = 1: the two tools
//! overlap beyond the curved mitre), so these rows are adjudicated by OCCT alone.

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::topo::{Body, EdgeId};

/// A shaft of radius 10 about (12, 12), 20 high, with a flat at x = 18.
fn dflat() -> Body {
    let shaft = zcyl("shaft", [12.0, 12.0], 0.0, 10.0, 20.0);
    let flat = aabox("flat", [18.0, 1.0, -1.0], [5.0, 22.0, 22.0]);
    cut(shaft, flat, "c1")
}

fn top_edges(b: &Body) -> Vec<EdgeId> {
    b.edges()
        .iter()
        .filter(|(_, e)| {
            (0..=4).all(|k| {
                let t = e.t_range.0 + (e.t_range.1 - e.t_range.0) * k as f64 / 4.0;
                (e.curve.eval(t).z - 20.0).abs() < 1e-9
            })
        })
        .map(|(id, _)| id)
        .collect()
}

#[test]
fn a_dflat_top_line_and_arc_meet_in_a_curved_mitre() {
    let b = dflat();
    assert!(rel(volume(&b), 5388.594871176) < 1e-9, "{}", volume(&b));
    let top = top_edges(&b);
    assert_eq!(top.len(), 2, "the flat's top line and the shaft's top arc");
    for (r, occt) in [(1.0, 5375.965776982), (2.0, 5339.314150622)] {
        let out = fillet(&b, &es(&b, &top), r, &BlendOptions::new("f1"))
            .unwrap_or_else(|e| panic!("r = {r}: {} {e}", e.code()));
        assert_valid(&out.body);
        assert!(
            rel(volume(&out.body), occt) < 1e-7,
            "r = {r}: {} vs OCCT {occt}",
            volume(&out.body)
        );
        let et = edge_types(&out.body);
        assert_eq!(et.get("bspline"), Some(&2), "the two mitres: {et:?}");
        assert!(
            forge_blend::self_intersections(&out.body)
                .expect("certified")
                .is_empty()
        );
    }
    let out = chamfer(
        &b,
        &es(&b, &top),
        &ChamferSpec::Equal { d: 1.0 },
        &BlendOptions::new("c1"),
    )
    .unwrap_or_else(|e| panic!("chamfer: {} {e}", e.code()));
    assert_valid(&out.body);
    assert!(
        rel(volume(&out.body), 5359.524435219) < 1e-7,
        "{} vs OCCT 5359.524435219",
        volume(&out.body)
    );
}
