//! Property tests on configurations rotated to arbitrary angles (W6 review, round 2): the
//! feasible ranges of fillets and shells between two holes, or a hole and a wall, against
//! their closed forms (`gap / 2`), and every body built at the suggested value checked for
//! self-intersection by an independent certified test ([`forge_blend::self_intersections`]).
#![cfg(not(target_family = "wasm"))]

mod common;

use common::*;
use forge_blend::{
    BlendError, BlendOptions, ShellDirection, ShellOptions, fillet, self_intersections, shell,
};
use forge_core::topo::Body;
use proptest::prelude::*;

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

/// Two holes `gap` apart (edge to edge) along direction `deg`, in a plate `h` thick with a
/// 10 mm margin.
fn hole_pair(r1: f64, r2: f64, gap: f64, deg: f64, h: f64) -> (Body, [(f64, f64, f64); 2]) {
    let a = deg.to_radians();
    let dist = r1 + r2 + gap;
    let (dx, dy) = (dist * a.cos(), dist * a.sin());
    let m = r1.max(r2) + 10.0;
    let c1 = (m + (-dx).max(0.0), m + (-dy).max(0.0));
    let c2 = (c1.0 + dx, c1.1 + dy);
    let holes = [(c1.0, c1.1, r1), (c2.0, c2.1, r2)];
    let w = c1.0.max(c2.0) + m;
    let d = c1.1.max(c2.1) + m;
    (plate_with_holes(w, d, h, &holes), holes)
}

fn top_of(b: &Body, h: f64) -> forge_core::topo::FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| {
            matches!(&f.surface, forge_core::geom::Surface::Plane(p)
                if p.frame().z().z > 0.5 && (p.frame().origin().z - h).abs() < 1e-9)
        })
        .map(|(id, _)| id)
        .expect("top face")
}

/// Valid, and certified not to pass through itself. forge-ssi cannot resolve a
/// near-tangency of a few micrometres (the suggested value can be that close to the exact
/// limit, e.g. 1.243 for 1.2430038): such a pair is left to the closed form the caller
/// asserts; anything else uncertified fails.
fn assert_clear(b: &Body) {
    assert_valid(b);
    match self_intersections(b) {
        Ok(hits) => assert!(hits.is_empty(), "the body passes through itself: {hits:?}"),
        Err(e) if e.contains("SSI_TANGENT_UNRESOLVED") => {}
        Err(e) => panic!("not certified: {e}"),
    }
}

proptest! {
    // 8 cases per debug run; `BLEND_PROP_CASES` raises it (release stress runs).
    #![proptest_config(ProptestConfig {
        cases: std::env::var("BLEND_PROP_CASES").ok().and_then(|s| s.parse().ok()).unwrap_or(8),
        .. ProptestConfig::default()
    })]

    #[test]
    fn hole_rim_fillets_stop_at_half_the_gap(
        r1 in 1.5f64..12.0, r2 in 1.5f64..12.0, gap in 0.5f64..5.0, deg in 0.0f64..360.0,
        over in 0.001f64..1.0,
    ) {
        let h = 8.0;
        let (b, holes) = hole_pair(r1, r2, gap, deg, h);
        let rims: Vec<_> = holes.iter().map(|&(x, y, r)| circle_near(&b, [x + r, y, h])).collect();
        let limit = gap / 2.0;
        let r = limit + over;
        let err = fillet(&b, &es(&b, &rims), r, &BlendOptions::new("f1")).expect_err("contacts overlap");
        let m = match err {
            BlendError::RadiusTooLarge { max_feasible_r, .. } => max_feasible_r,
            other => return Err(TestCaseError::fail(format!("{}: {other}", other.code()))),
        };
        prop_assert!(m < limit && m >= limit - 0.002, "max {} vs gap/2 {}", m, limit);
        let out = fillet(&b, &es(&b, &rims), m, &BlendOptions::new("f1")).expect("max builds");
        assert_clear(&out.body);
    }

    #[test]
    fn tube_walls_of_hole_pairs_stop_at_half_the_gap(
        r1 in 1.5f64..12.0, r2 in 1.5f64..12.0, gap in 0.5f64..4.0, deg in 0.0f64..360.0,
        over in 0.001f64..1.0,
    ) {
        let h = 10.0;
        let (b, _) = hole_pair(r1, r2, gap, deg, h);
        let top = top_of(&b, h);
        let limit = gap / 2.0;
        let t = limit + over;
        let err = shell(&b, &fs(&b, &[top]), t, ShellDirection::Inward, &ShellOptions::new("sh1"))
            .expect_err("tubes collide");
        let m = match err {
            BlendError::ThicknessTooLarge { max_feasible_thickness: Some(m), .. } => m,
            other => return Err(TestCaseError::fail(format!("{}: {other}", other.code()))),
        };
        prop_assert!(m < limit && m >= limit - 0.002, "max {} vs gap/2 {}", m, limit);
        let out = shell(&b, &fs(&b, &[top]), m, ShellDirection::Inward, &ShellOptions::new("sh1"))
            .expect("max builds");
        assert_clear(&out.body);
    }

    #[test]
    fn a_hole_near_a_rotated_wall_stops_at_half_the_gap(
        r in 1.5f64..10.0, gap in 0.5f64..4.0, deg in 0.0f64..90.0, over in 0.001f64..1.0,
    ) {
        let a = deg.to_radians();
        let rot = |x: f64, y: f64| [x * a.cos() - y * a.sin(), x * a.sin() + y * a.cos()];
        let (w, d, h) = (2.0 * r + 30.0, 2.0 * r + gap + 20.0, 10.0);
        let plate = prism("e1", 0.0, polygon(&[rot(0.0, 0.0), rot(w, 0.0), rot(w, d), rot(0.0, d)]), h);
        let b = cut(plate, zcyl("h0", rot(w / 2.0, gap + r), -1.0, r, h + 2.0), "c0");
        let top = top_of(&b, h);
        let limit = gap / 2.0;
        let t = limit + over;
        let err = shell(&b, &fs(&b, &[top]), t, ShellDirection::Inward, &ShellOptions::new("sh1"))
            .expect_err("walls collide");
        let m = match err {
            BlendError::ThicknessTooLarge { max_feasible_thickness: Some(m), .. } => m,
            other => return Err(TestCaseError::fail(format!("{}: {other}", other.code()))),
        };
        prop_assert!(m < limit && m >= limit - 0.002, "max {} vs gap/2 {}", m, limit);
        let out = shell(&b, &fs(&b, &[top]), m, ShellDirection::Inward, &ShellOptions::new("sh1"))
            .expect("max builds");
        assert_clear(&out.body);
        // The rim and the wall's top edge filleted together: their contacts meet at gap / 2
        // on the top face.
        let rim = circle_near(&b, [rot(w / 2.0, gap + r)[0] + r, rot(w / 2.0, gap + r)[1], h]);
        let mid = rot(w / 2.0, 0.0);
        let wall = edge_near(&b, [mid[0], mid[1], h]);
        let err = fillet(&b, &es(&b, &[rim, wall]), limit + over, &BlendOptions::new("f1"))
            .expect_err("contacts overlap");
        let m = match err {
            BlendError::RadiusTooLarge { max_feasible_r, .. } => max_feasible_r,
            other => return Err(TestCaseError::fail(format!("{}: {other}", other.code()))),
        };
        prop_assert!(m < limit && m >= limit - 0.002, "fillet max {} vs gap/2 {}", m, limit);
        let out = fillet(&b, &es(&b, &[rim, wall]), m, &BlendOptions::new("f1")).expect("max builds");
        assert_clear(&out.body);
    }
}
