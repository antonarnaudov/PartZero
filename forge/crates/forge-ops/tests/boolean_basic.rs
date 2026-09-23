//! Booleans on closed-form configurations: exact volumes, areas and counts, identity,
//! errors. Every result is checked with forge-check (validity, exact mass properties).

use forge_core::topo::Body;
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

fn plane_z(z: f64) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin: [0.0, 0.0, z],
        normal: [0.0, 0.0, 1.0],
        x_dir: [1.0, 0.0, 0.0],
    })
}

fn plane_x(x: f64) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin: [x, 0.0, 0.0],
        normal: [1.0, 0.0, 0.0],
        x_dir: [0.0, 1.0, 0.0],
    })
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    vec![
        line("b", [x0, y0], [x0 + w, y0]),
        line("r", [x0 + w, y0], [x0 + w, y0 + h]),
        line("t", [x0 + w, y0 + h], [x0, y0 + h]),
        line("l", [x0, y0 + h], [x0, y0]),
    ]
}

fn operand(feature: &str, plane: PlaneSpec, curves: Vec<SketchCurve>, d: f64) -> Operand {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane,
            curves,
        },
        sweep: Sweep::Extrude {
            distance: d,
            direction: SweepDirection::Normal,
        },
    }
}

fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    operand(
        feature,
        plane_z(lo[2]),
        rect(lo[0], lo[1], size[0], size[1]),
        size[2],
    )
    .build()
    .expect("box")
}

fn zcyl(feature: &str, c: [f64; 2], r: f64, z0: f64, h: f64) -> Body {
    operand(
        feature,
        plane_z(z0),
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: c,
            radius: r,
        }],
        h,
    )
    .build()
    .expect("cylinder")
}

fn xcyl(feature: &str, c: [f64; 2], r: f64, x0: f64, h: f64) -> Body {
    operand(
        feature,
        plane_x(x0),
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: c,
            radius: r,
        }],
        h,
    )
    .build()
    .expect("cylinder")
}

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "b".into(),
            instance: None,
        },
        timeline,
    }
}

fn run(op: BodyOp, a: Body, b: Body) -> BodyOpResult {
    apply_body_op(op, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g").unwrap_or_else(|e| {
        panic!("{op:?}: {} {e}", e.code());
    })
}

/// Volume, area, faces, edges of every result body, after checking validity.
fn metrics(r: &BodyOpResult) -> Vec<(f64, f64, usize, usize)> {
    r.bodies
        .iter()
        .map(|b| {
            let issues = forge_check::validate(&b.body);
            assert!(
                issues
                    .iter()
                    .all(|i| i.severity != forge_core::topo::Severity::Error),
                "invalid result: {issues:?}"
            );
            let mp = forge_check::mass_properties(&b.body).expect("mass");
            let c = b.body.counts();
            (mp.volume, mp.area, c.faces, c.edges)
        })
        .collect()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * (1.0 + a.abs().max(b.abs()))
}

#[test]
fn overlapping_boxes_join_cut_intersect() {
    let a = || aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let b = || aabox("b", [2.0, 1.0, 1.0], [4.0, 2.0, 2.0]);
    let j = metrics(&run(BodyOp::Join, a(), b()));
    assert_eq!(j.len(), 1);
    assert!(close(j[0].0, 64.0 + 16.0 - 8.0), "{j:?}");
    let c = metrics(&run(BodyOp::Cut, a(), b()));
    assert_eq!(c.len(), 1);
    assert!(close(c[0].0, 64.0 - 8.0), "{c:?}");
    let i = metrics(&run(BodyOp::Intersect, a(), b()));
    assert_eq!(i.len(), 1);
    assert!(close(i[0].0, 8.0), "{i:?}");
    assert_eq!(i[0].2, 6);
    assert_eq!(i[0].3, 12);
}

#[test]
fn union_of_overlapping_boxes_has_exact_counts_after_unify() {
    let r = run(
        BodyOp::Join,
        aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
        aabox("b", [2.0, 1.0, 1.0], [4.0, 2.0, 2.0]),
    );
    let m = metrics(&r);
    assert_eq!(m.len(), 1);
    assert!(close(m[0].0, 72.0));
    assert!(close(m[0].1, 96.0 - 4.0 + 16.0 + 4.0), "area {}", m[0].1);
    assert_eq!((m[0].2, m[0].3), (11, 24), "{m:?}");
    // Identity: the result keeps the target's origin.
    assert_eq!(r.bodies[0].origin.feature, "a");
    assert!(r.merged_into.is_empty() && r.removed.is_empty() && r.splits.is_empty());
}

#[test]
fn a_cylinder_through_a_box_cuts_a_hole() {
    let a = aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let b = zcyl("b", [2.0, 2.0], 1.0, -1.0, 6.0);
    let m = metrics(&run(BodyOp::Cut, a, b));
    assert_eq!(m.len(), 1);
    let pi = std::f64::consts::PI;
    assert!(close(m[0].0, 64.0 - 4.0 * pi), "{m:?}");
    assert!(close(m[0].1, 96.0 - 2.0 * pi + 8.0 * pi), "{m:?}");
    assert_eq!((m[0].2, m[0].3), (7, 14), "{m:?}");
}

/// `∫∫∫` of two perpendicular cylinders `x² + y² ≤ R²`, `y² + z² ≤ r²` (r ≤ R), crossing
/// through each other: `∫ 4 √(R² − r² sin²θ) r² cos²θ dθ` over `[−π/2, π/2]`.
fn crossed_cylinders_volume(big: f64, r: f64) -> f64 {
    let n = 2000;
    let (a, b) = (-std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2);
    let h = (b - a) / n as f64;
    // Composite Simpson.
    let f = |t: f64| 4.0 * (big * big - r * r * t.sin().powi(2)).sqrt() * r * r * t.cos().powi(2);
    let mut s = f(a) + f(b);
    for i in 1..n {
        let t = a + h * i as f64;
        s += if i % 2 == 1 { 4.0 } else { 2.0 } * f(t);
    }
    s * h / 3.0
}

#[test]
fn crossed_cylinders_match_the_closed_form() {
    for (big, r) in [(2.0, 1.0), (2.0, 1.5), (1.5, 1.5)] {
        let a = || zcyl("a", [0.0, 0.0], big, -4.0, 8.0);
        let b = || xcyl("b", [0.0, 0.0], r, -4.0, 8.0);
        let v_int = crossed_cylinders_volume(big, r);
        let (va, vb) = (
            std::f64::consts::PI * big * big * 8.0,
            std::f64::consts::PI * r * r * 8.0,
        );
        let i = metrics(&run(BodyOp::Intersect, a(), b()));
        assert_eq!(i.len(), 1, "R={big} r={r}");
        assert!(
            (i[0].0 - v_int).abs() <= 1e-7 * v_int,
            "R={big} r={r}: {} vs {v_int}",
            i[0].0
        );
        let j = metrics(&run(BodyOp::Join, a(), b()));
        assert!(
            (j[0].0 - (va + vb - v_int)).abs() <= 1e-7 * va,
            "join R={big} r={r}"
        );
        if (big - r).abs() == 0.0 {
            // Equal radii: the cut touches itself at the two tangency points.
            let e = apply_body_op(BodyOp::Cut, &[ob(a(), "a", 0)], &[ob(b(), "b", 1)], "g")
                .expect_err("non-manifold");
            assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD");
            continue;
        }
        let c = metrics(&run(BodyOp::Cut, a(), b()));
        let total: f64 = c.iter().map(|x| x.0).sum();
        assert!(
            (total - (va - v_int)).abs() <= 1e-7 * va,
            "cut R={big} r={r}"
        );
    }
}

#[test]
fn coplanar_boxes_merge_their_shared_planes() {
    let r = run(
        BodyOp::Join,
        aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 2.0]),
        aabox("b", [2.0, 1.0, 0.0], [4.0, 2.0, 2.0]),
    );
    let m = metrics(&r);
    assert_eq!(m.len(), 1);
    assert!(close(m[0].0, 40.0) && close(m[0].1, 80.0), "{m:?}");
    assert_eq!((m[0].2, m[0].3), (10, 24), "{m:?}");
    // The merged top and bottom keep the target's keys; the tool's become aliases (SPEC
    // §5.2 keys: caps carry their body member `@b`).
    assert!(
        r.aliases
            .iter()
            .any(|(from, to)| from == "b/cap:end@b" && to == "a/cap:end@b"),
        "{:?}",
        r.aliases
    );
}

#[test]
fn touching_boxes_join_into_one_body_but_do_not_cut() {
    let a = || aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let b = || aabox("b", [1.0, 1.0, 4.0], [2.0, 2.0, 2.0]);
    let m = metrics(&run(BodyOp::Join, a(), b()));
    assert_eq!(m.len(), 1);
    assert!(close(m[0].0, 72.0));
    assert_eq!((m[0].2, m[0].3), (11, 24), "{m:?}");
    let e = apply_body_op(BodyOp::Cut, &[ob(a(), "a", 0)], &[ob(b(), "b", 1)], "g")
        .expect_err("touching tool does not cut");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION");
    let e = apply_body_op(
        BodyOp::Intersect,
        &[ob(a(), "a", 0)],
        &[ob(b(), "b", 1)],
        "g",
    )
    .expect_err("touching tool has an empty intersection");
    assert_eq!(e.code(), "BOOLEAN_EMPTY_RESULT");
}

#[test]
fn a_nested_tool_cuts_a_void() {
    let r = run(
        BodyOp::Cut,
        aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
        aabox("b", [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]),
    );
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].body.shell_ids().len(), 2);
    let m = metrics(&r);
    assert!(close(m[0].0, 56.0), "{m:?}");
    // Join and intersect with a nested tool. The join leaves the target as it was: it is
    // reported untouched, not modified (the tool is consumed).
    let j = run(
        BodyOp::Join,
        aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
        aabox("b", [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]),
    );
    assert!(j.bodies.is_empty(), "{:?}", j.bodies.len());
    assert_eq!(j.untouched.len(), 1);
    assert_eq!(j.untouched[0].feature, "a");
    let i = metrics(&run(
        BodyOp::Intersect,
        aabox("a", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
        aabox("b", [1.0, 1.0, 1.0], [2.0, 2.0, 2.0]),
    ));
    assert!(close(i[0].0, 8.0) && i[0].2 == 6);
}

#[test]
fn a_through_cut_splits_the_target() {
    let r = run(
        BodyOp::Cut,
        aabox("a", [0.0, 0.0, 0.0], [6.0, 2.0, 2.0]),
        aabox("b", [2.0, -1.0, -1.0], [2.0, 4.0, 4.0]),
    );
    assert_eq!(r.bodies.len(), 2);
    assert!(r.bodies.iter().all(|b| b.origin.feature == "a"));
    assert_eq!(r.splits.len(), 1);
    assert_eq!(r.splits[0].1, 2);
    assert_eq!(r.notes[0].code(), "BOOLEAN_SPLIT");
    let m = metrics(&r);
    assert!(close(m[0].0, 8.0) && close(m[1].0, 8.0), "{m:?}");
}

#[test]
fn disjoint_tools_are_reported_with_their_distance() {
    let a = || aabox("a", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
    let b = || aabox("b", [3.5, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let e = apply_body_op(BodyOp::Join, &[ob(a(), "a", 0)], &[ob(b(), "b", 1)], "g")
        .expect_err("detached boss");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION");
    let d = serde_json::to_value(e.details()).expect("details");
    assert!(
        (d["min_distance"].as_f64().expect("number") - 1.5).abs() < 1e-9,
        "{d}"
    );
    assert_eq!(d["tool"]["feature"], "b");
    let e = apply_body_op(
        BodyOp::Intersect,
        &[ob(a(), "a", 0)],
        &[ob(b(), "b", 1)],
        "g",
    )
    .expect_err("empty");
    assert_eq!(e.code(), "BOOLEAN_EMPTY_RESULT");
}

#[test]
fn a_join_of_two_targets_merges_their_identities() {
    let t1 = ob(aabox("t1", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]), "t1", 0);
    let t2 = ob(aabox("t2", [3.0, 0.0, 0.0], [2.0, 2.0, 2.0]), "t2", 1);
    let k = ob(aabox("k", [1.0, 0.5, 0.5], [3.0, 1.0, 1.0]), "k", 2);
    let r = apply_body_op(BodyOp::Join, &[t1, t2], &[k], "g").expect("join");
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin.feature, "t1");
    assert_eq!(r.merged_into.len(), 1);
    assert_eq!(r.merged_into[0].0.feature, "t2");
    let m = metrics(&r);
    assert!(close(m[0].0, 8.0 + 8.0 + 1.0), "{m:?}");
}

#[test]
fn a_tool_that_is_also_a_target_is_rejected() {
    let a = ob(aabox("a", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]), "a", 0);
    let tools = [a.clone()];
    let e =
        apply_body_op(BodyOp::Join, std::slice::from_ref(&a), &tools, "g").expect_err("same body");
    assert_eq!(e.code(), "BOOLEAN_TOOL_IS_TARGET");
}

/// SPEC §6.0.3: a join tool must overlap a target or share a face of positive area with
/// it; boxes touching only along an edge are a detached tool (distance 0), not a
/// non-manifold union.
#[test]
fn edge_touching_join_is_no_intersection() {
    let a = aabox("a", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
    let b = aabox("b", [2.0, 2.0, 0.0], [2.0, 2.0, 2.0]);
    let e = apply_body_op(
        BodyOp::Join,
        &[ob(a.clone(), "a", 0)],
        &[ob(b.clone(), "b", 1)],
        "g",
    )
    .expect_err("edge contact");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION", "{e}");
    match e {
        BooleanError::NoIntersection { min_distance, .. } => assert!(min_distance.abs() <= 1e-9),
        other => panic!("{other}"),
    }
    // Nothing in common either way.
    let e = apply_body_op(
        BodyOp::Cut,
        &[ob(a.clone(), "a", 0)],
        &[ob(b.clone(), "b", 1)],
        "g",
    )
    .expect_err("cut");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION");
    let e = apply_body_op(BodyOp::Intersect, &[ob(a, "a", 0)], &[ob(b, "b", 1)], "g")
        .expect_err("intersect");
    assert_eq!(e.code(), "BOOLEAN_EMPTY_RESULT");
}
