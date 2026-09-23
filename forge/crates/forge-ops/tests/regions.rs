//! SPEC §3: loop assembly, the staged sketch errors, nesting, region areas and the
//! canonical region order.

use forge_core::Tolerance;
use forge_core::math::PI;
use forge_ir::{NamedPlane, PlaneSpec, SketchCurve, SketchFeature};
use forge_ops::{OpError, Region, regions};
use proptest::prelude::*;

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn arc(id: &str, start: [f64; 2], end: [f64; 2], center: [f64; 2], ccw: bool) -> SketchCurve {
    SketchCurve::Arc {
        id: id.into(),
        start,
        end,
        center,
        ccw,
    }
}

fn circle(id: &str, center: [f64; 2], radius: f64) -> SketchCurve {
    SketchCurve::Circle {
        id: id.into(),
        center,
        radius,
    }
}

fn sketch(curves: Vec<SketchCurve>) -> SketchFeature {
    SketchFeature {
        id: "s".into(),
        name: "s".into(),
        suppressed: false,
        plane: PlaneSpec::Named(NamedPlane::XY),
        curves,
    }
}

fn run(curves: Vec<SketchCurve>) -> Result<Vec<Region>, OpError> {
    regions(&sketch(curves), &Tolerance::IR_DEFAULT)
}

fn code(curves: Vec<SketchCurve>) -> &'static str {
    match run(curves) {
        Ok(_) => "OK",
        Err(e) => e.code(),
    }
}

/// Closed polygon of lines `p0 → p1 → … → p0` with ids `{prefix}{k}`.
fn polygon(prefix: &str, pts: &[[f64; 2]]) -> Vec<SketchCurve> {
    (0..pts.len())
        .map(|k| line(&format!("{prefix}{k}"), pts[k], pts[(k + 1) % pts.len()]))
        .collect()
}

fn square(prefix: &str, x0: f64, y0: f64, s: f64) -> Vec<SketchCurve> {
    polygon(
        prefix,
        &[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]],
    )
}

#[test]
fn open_chain_reports_the_first_free_end() {
    let e = run(vec![
        line("a", [0.0, 0.0], [1.0, 0.0]),
        line("b", [1.0, 0.0], [1.0, 1.0]),
    ])
    .unwrap_err();
    assert_eq!(e.code(), "SKETCH_OPEN_LOOP");
    let OpError::SketchOpenLoop { curve, end, point } = e else {
        unreachable!()
    };
    assert_eq!(
        (curve.as_str(), end.as_str(), point),
        ("a", "start", [0.0, 0.0])
    );
}

#[test]
fn three_ends_at_one_point_branch() {
    let mut c = square("s", 0.0, 0.0, 1.0);
    c.push(line("x", [0.0, 0.0], [-1.0, -1.0]));
    let e = run(c).unwrap_err();
    assert_eq!(e.code(), "SKETCH_BRANCHING");
    let OpError::SketchBranching {
        curve, partners, ..
    } = e
    else {
        unreachable!()
    };
    assert_eq!(curve, "s0");
    assert_eq!(partners.len(), 2);
}

#[test]
fn coincidence_is_inclusive_at_the_tolerance() {
    // Ends exactly 1e-6 apart coincide [R-3]; 2e-6 apart do not.
    let mut c = square("s", 0.0, 0.0, 10.0);
    c[1] = line("s1", [10.0 + 1e-6, 0.0], [10.0, 10.0]);
    assert_eq!(code(c.clone()), "OK");
    c[1] = line("s1", [10.0 + 2e-6, 0.0], [10.0, 10.0]);
    assert_eq!(code(c), "SKETCH_OPEN_LOOP");
}

#[test]
fn endpoint_errors_come_before_crossings() {
    let mut c = polygon("b", &[[0.0, 0.0], [2.0, 2.0], [2.0, 0.0], [0.0, 2.0]]); // bow tie
    assert_eq!(code(c.clone()), "SKETCH_CURVES_CROSS");
    c.push(line("z", [5.0, 5.0], [6.0, 6.0]));
    assert_eq!(code(c), "SKETCH_OPEN_LOOP");
}

#[test]
fn crossing_touching_and_overlapping_curves_fail() {
    // Bow tie: a proper crossing inside one loop.
    let e = run(polygon(
        "b",
        &[[0.0, 0.0], [2.0, 2.0], [2.0, 0.0], [0.0, 2.0]],
    ))
    .unwrap_err();
    let OpError::SketchCurvesCross {
        first,
        second,
        point,
    } = e
    else {
        panic!("{e}")
    };
    assert_eq!((first.as_str(), second.as_str()), ("b0", "b2"));
    let p = point.expect("crossing point");
    assert!((p[0] - 1.0).abs() < 1e-12 && (p[1] - 1.0).abs() < 1e-12);
    // A circle touching a square's edge from inside.
    let mut c = square("s", 0.0, 0.0, 10.0);
    c.push(circle("c", [5.0, 3.0], 3.0));
    assert_eq!(code(c), "SKETCH_CURVES_CROSS");
    // Two disjoint squares sharing an edge segment (overlap).
    let mut c = square("a", 0.0, 0.0, 1.0);
    c.extend(square("b", 1.0, 0.25, 0.5));
    assert_eq!(code(c), "SKETCH_CURVES_CROSS");
    // Externally tangent circles.
    assert_eq!(
        code(vec![
            circle("c1", [0.0, 0.0], 1.0),
            circle("c2", [2.0, 0.0], 1.0)
        ]),
        "SKETCH_CURVES_CROSS"
    );
    // A near touch 5e-7 away is a touch; 5e-6 away is fine.
    let mut c = square("s", 0.0, 0.0, 10.0);
    c.push(circle("c", [5.0, 3.0 + 5e-7], 3.0));
    assert_eq!(code(c), "SKETCH_CURVES_CROSS");
    let mut c = square("s", 0.0, 0.0, 10.0);
    c.push(circle("c", [5.0, 3.0 + 5e-6], 3.0));
    assert_eq!(code(c), "OK");
}

#[test]
fn tangent_and_collinear_joins_are_allowed() {
    // Obround slot: lines tangent to the arcs at their shared ends.
    let slot = vec![
        line("lo", [-20.0, -6.0], [20.0, -6.0]),
        arc("r", [20.0, -6.0], [20.0, 6.0], [20.0, 0.0], true),
        line("up", [20.0, 6.0], [-20.0, 6.0]),
        arc("l", [-20.0, 6.0], [-20.0, -6.0], [-20.0, 0.0], true),
    ];
    let r = run(slot).expect("slot");
    assert!((r[0].area - (40.0 * 12.0 + PI * 36.0)).abs() < 1e-10);
    // Collinear consecutive lines.
    let r = run(polygon(
        "p",
        &[[0.0, 0.0], [1.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]],
    ))
    .expect("collinear");
    assert!((r[0].area - 2.0).abs() < 1e-15);
    // A line-and-arc "D" loop.
    let d = vec![
        line("chord", [-1.0, 0.0], [1.0, 0.0]),
        arc("bow", [1.0, 0.0], [-1.0, 0.0], [0.0, 0.0], true),
    ];
    let r = run(d).expect("D");
    assert!((r[0].area - PI / 2.0).abs() < 1e-15);
}

#[test]
fn sliver_loop_is_caught_as_a_tangency_before_the_area_stage() {
    // A chord and an arc whose sagitta is ~1e-12 mm: the chord is within tol of the arc
    // at its foot point (a tangency contact, [R-4]), so stage 2 fails first ([R-2]).
    let c = vec![
        line("chord", [0.0, 0.0], [1e-4, 0.0]),
        arc("bow", [1e-4, 0.0], [0.0, 0.0], [5e-5, -1e3], true),
    ];
    assert_eq!(code(c), "SKETCH_CURVES_CROSS");
    assert_eq!(code(vec![]), "SKETCH_NO_REGIONS");
}

#[test]
fn nesting_makes_holes_and_islands_in_canonical_order() {
    let mut c = square("z", 0.0, 0.0, 10.0); // outer
    c.extend(square("m", 2.0, 2.0, 6.0)); // hole
    c.extend(square("a", 4.0, 4.0, 2.0)); // island inside the hole
    c.push(circle("q", [20.0, 5.0], 2.0)); // separate disc
    c.push(circle("h", [5.0, 1.0], 0.5)); // second hole of the outer region
    let r = run(c).expect("regions");
    let names: Vec<Vec<String>> = r.iter().map(|g| g.outer_curves.clone()).collect();
    assert_eq!(
        names,
        vec![
            vec!["a0", "a1", "a2", "a3"],
            vec!["q"],
            vec!["z0", "z1", "z2", "z3"],
        ]
        .into_iter()
        .map(|v| v.into_iter().map(String::from).collect::<Vec<_>>())
        .collect::<Vec<_>>()
    );
    assert_eq!(
        r.iter().map(Region::loop_count).collect::<Vec<_>>(),
        [1, 1, 3]
    );
    assert!((r[0].area - 4.0).abs() < 1e-14);
    assert!((r[1].area - PI * 4.0).abs() < 1e-13);
    assert!((r[2].area - (100.0 - 36.0 - PI * 0.25)).abs() < 1e-12);
    // Orientation: outer loops counter-clockwise, holes clockwise.
    for g in &r {
        assert!(g.outer.signed_area > 0.0);
        assert!(g.holes.iter().all(|h| h.signed_area < 0.0));
    }
}

#[test]
fn arc_bulging_into_the_region_is_handled() {
    // Square with its top edge replaced by an arc dipping inwards (concave).
    let c = vec![
        line("b", [0.0, 0.0], [4.0, 0.0]),
        line("r", [4.0, 0.0], [4.0, 4.0]),
        arc("t", [4.0, 4.0], [0.0, 4.0], [2.0, 5.0], false),
        line("l", [0.0, 4.0], [0.0, 0.0]),
    ];
    let r = run(c).expect("region");
    // The arc (radius √5, centre above) bows down by √5 − 1 at the middle.
    let rr = 5f64.sqrt();
    let theta = 2.0 * (2.0 / rr).asin();
    let segment = 0.5 * rr * rr * (theta - theta.sin());
    assert!(
        (r[0].area - (16.0 - segment)).abs() < 1e-12,
        "{}",
        r[0].area
    );
}

fn star(n: usize, radii: &[f64], cx: f64, cy: f64) -> Vec<[f64; 2]> {
    (0..n)
        .map(|k| {
            let a = 2.0 * PI * k as f64 / n as f64;
            let r = radii[k % radii.len()];
            [cx + r * a.cos(), cy + r * a.sin()]
        })
        .collect()
}

fn shoelace(p: &[[f64; 2]]) -> f64 {
    let n = p.len();
    0.5 * (0..n)
        .map(|i| p[i][0] * p[(i + 1) % n][1] - p[(i + 1) % n][0] * p[i][1])
        .sum::<f64>()
}

proptest! {
    #[test]
    fn star_polygon_area_matches_shoelace_in_either_orientation(
        n in 3usize..12,
        radii in prop::collection::vec(1.0..10.0f64, 1..4),
        cx in -50.0..50.0f64,
        cy in -50.0..50.0f64,
        reverse in any::<bool>(),
    ) {
        let mut pts = star(n, &radii, cx, cy);
        if reverse {
            pts.reverse();
        }
        let r = run(polygon("p", &pts)).expect("simple star polygon");
        prop_assert_eq!(r.len(), 1);
        let want = shoelace(&pts).abs();
        prop_assert!((r[0].area - want).abs() <= 1e-12 * want.max(1.0), "{} vs {}", r[0].area, want);
        prop_assert!(r[0].outer.signed_area > 0.0);
    }

    #[test]
    fn circles_with_holes_nest(
        r0 in 5.0..20.0f64,
        k in 0.1..0.8f64,
        dx in -0.5..0.5f64,
        dy in -0.5..0.5f64,
    ) {
        let r1 = r0 * k;
        let room = r0 - r1;
        let (hx, hy) = (dx * room, dy * room);
        let r = run(vec![circle("o", [0.0, 0.0], r0), circle("i", [hx, hy], r1)]).expect("annulus");
        prop_assert_eq!(r.len(), 1);
        prop_assert_eq!(r[0].loop_count(), 2);
        let want = PI * (r0 * r0 - r1 * r1);
        prop_assert!((r[0].area - want).abs() <= 1e-12 * want);
    }
}
