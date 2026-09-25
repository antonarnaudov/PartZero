//! Blends meeting at a nearly straight vertex (W6 review round 6): the top loop of a prism
//! over (0,0), (10,0), (20,0.001), (20,10), (0,10) turns by 1e-4 rad at (10, 0) — above
//! `TANGENT_CHAIN_TOLERANCE`, so not a tangent chain, but its mitre is nearly flat. Forge
//! failed it as an "inconsistent mitre": the two contact lines' meeting point lost 1e-6 mm to
//! cancellation in the closest-points formula. The results are checked against closed forms:
//! the blends of the top loop of a convex prism whose sides are perpendicular to its top meet
//! in vertical mitre planes, so the removed volume is the cross-section's area times the
//! length of its centroid's path (Pappus): the polygon offset inward by the centroid's
//! distance `c` from the side faces, of perimeter `P − 2c·Σ tan(θᵢ/2)` (`θᵢ` the polygon's
//! turning angles).

mod common;

use common::*;
use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::math::PI;

const PTS: [[f64; 2]; 5] = [
    [0.0, 0.0],
    [10.0, 0.0],
    [20.0, 0.001],
    [20.0, 10.0],
    [0.0, 10.0],
];
const H: f64 = 6.0;

fn body_and_top() -> (forge_core::topo::Body, Vec<forge_core::topo::EdgeId>) {
    let b = prism("q", 0.0, polygon(&PTS), H);
    let top = (0..PTS.len())
        .map(|i| {
            let (p, q) = (PTS[i], PTS[(i + 1) % PTS.len()]);
            edge_near(&b, [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, H])
        })
        .collect();
    (b, top)
}

/// Perimeter of the polygon offset inward by `c` (convex, counter-clockwise).
fn inner_perimeter(c: f64) -> f64 {
    let n = PTS.len();
    let mut per = 0.0;
    let mut tans = 0.0;
    for i in 0..n {
        let (p, q, r) = (PTS[i], PTS[(i + 1) % n], PTS[(i + 2) % n]);
        per += ((q[0] - p[0]).powi(2) + (q[1] - p[1]).powi(2)).sqrt();
        let a1 = (q[1] - p[1]).atan2(q[0] - p[0]);
        let a2 = (r[1] - q[1]).atan2(r[0] - q[0]);
        let mut th = a2 - a1;
        while th < 0.0 {
            th += 2.0 * PI;
        }
        tans += (0.5 * th).tan();
    }
    per - 2.0 * c * tans
}

#[test]
fn the_turn_is_not_a_tangent_chain() {
    let (b, top) = body_and_top();
    // Filleting one of the two edges at the nearly straight vertex adds nothing.
    assert!(forge_blend::tangent_chain(&b, &top[..1]).is_empty());
}

#[test]
fn a_chamfer_of_the_top_loop_is_the_closed_form() {
    let (b, top) = body_and_top();
    let v0 = volume(&b);
    for d in [0.3, 1.0, 2.5] {
        let out = chamfer(
            &b,
            &es(&b, &top),
            &ChamferSpec::Equal { d },
            &BlendOptions::new("c1"),
        )
        .unwrap_or_else(|e| panic!("d = {d}: {} {e}", e.code()));
        assert_valid(&out.body);
        // A right triangle of legs d: area d²/2, centroid d/3 in from the side.
        let removed = 0.5 * d * d * inner_perimeter(d / 3.0);
        let v = volume(&out.body);
        assert!(
            rel(v, v0 - removed) < 1e-10,
            "d = {d}: {v} vs {}",
            v0 - removed
        );
    }
}

#[test]
fn a_fillet_of_the_top_loop_is_the_closed_form() {
    let (b, top) = body_and_top();
    let v0 = volume(&b);
    for r in [0.3, 1.0, 2.5] {
        let out = fillet(&b, &es(&b, &top), r, &BlendOptions::new("f1"))
            .unwrap_or_else(|e| panic!("r = {r}: {} {e}", e.code()));
        assert_valid(&out.body);
        assert!(
            forge_blend::self_intersections(&out.body)
                .expect("certified")
                .is_empty()
        );
        // The spandrel between a right angle and its quarter circle: area (1 − π/4)·r²,
        // centroid r·(10 − 3π)/(12 − 3π) in from the side.
        let area = (1.0 - PI / 4.0) * r * r;
        let c = r * (10.0 - 3.0 * PI) / (12.0 - 3.0 * PI);
        let removed = area * inner_perimeter(c);
        let v = volume(&out.body);
        assert!(
            rel(v, v0 - removed) < 1e-9,
            "r = {r}: {v} vs {}",
            v0 - removed
        );
    }
}
