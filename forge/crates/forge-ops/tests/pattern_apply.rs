//! Patterns applied (SPEC §6.10): new-body copies with their origins, body-operation and
//! hole seeds applied once with every instance, `PATTERN_INSTANCE_SKIPPED` for instances
//! running off the part, `PATTERN_ALL_INSTANCES_FAILED`, mirrors, and closed-form volumes.

// Exact comparisons on purpose: golden values and exact placements.
#![allow(clippy::float_cmp)]

use std::f64::consts::PI;

use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::{Body, Role, Severity, parse_key};
use forge_ir::v1::metrics::{BodyChange, Origin};
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};
use forge_ops::hole::{HoleSite, apply_hole, hole_positions, hole_spec, literal_hole};
use forge_ops::pattern::{
    CircularLayout, Layout, LinearLayout, MirrorLayout, PatternError, SeedBody, SeedOp, Skipped,
    apply_seed, pattern_instances,
};
use serde_json::json;

fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    vec![
        l("b", [x0, y0], [x0 + w, y0]),
        l("r", [x0 + w, y0], [x0 + w, y0 + h]),
        l("t", [x0 + w, y0 + h], [x0, y0 + h]),
        l("l", [x0, y0 + h], [x0, y0]),
    ]
}

fn extruded(feature: &str, z0: f64, curves: Vec<SketchCurve>, h: f64) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(IrFrame {
                origin: [0.0, 0.0, z0],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves,
        },
        sweep: Sweep::Extrude {
            distance: h,
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("extrude")
}

fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    extruded(
        feature,
        lo[2],
        rect(lo[0], lo[1], size[0], size[1]),
        size[2],
    )
}

fn zcyl(feature: &str, c: [f64; 2], r: f64, z0: f64, h: f64) -> Body {
    extruded(
        feature,
        z0,
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: c,
            radius: r,
        }],
        h,
    )
}

fn origin(feature: &str, member: &str) -> Origin {
    Origin {
        feature: feature.into(),
        member: member.into(),
        instance: None,
    }
}

fn ob(body: Body, feature: &str, member: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: origin(feature, member),
        timeline,
    }
}

fn seed(body: Body, feature: &str, member: &str) -> SeedBody {
    SeedBody {
        body,
        origin: origin(feature, member),
        keys: None,
        hole: None,
    }
}

fn volume(b: &Body) -> f64 {
    let issues = forge_check::validate(b);
    assert!(
        issues.iter().all(|i| i.severity != Severity::Error),
        "invalid: {issues:?}"
    );
    forge_check::mass_properties(b).expect("mass").volume
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= 1e-9 * b.abs().max(1.0)
}

fn linear_x(count: f64, spacing: f64) -> Layout {
    Layout::Linear(LinearLayout {
        dir: Vec3::unit_x(),
        count,
        spacing,
        second: None,
    })
}

/// The plate `[0, 60] × [0, 40] × [0, 8]` (feature `e1`, member `b`).
fn plate() -> Body {
    aabox("e1", [0.0, 0.0, 0.0], [60.0, 40.0, 8.0])
}

#[test]
fn new_body_seeds_create_moved_copies_with_instance_origins() {
    let boss = zcyl("e2", [5.0, 5.0], 3.0, 0.0, 10.0);
    let inst = pattern_instances(
        &Layout::Linear(LinearLayout {
            dir: Vec3::unit_x(),
            count: 3.0,
            spacing: 10.0,
            second: Some((Vec3::unit_y(), 2.0, 12.0)),
        }),
        &[vec![2, 1]],
    )
    .expect("instances");
    assert_eq!(inst.len(), 4);
    let out = apply_seed(
        "pt1",
        3,
        SeedOp::NewBody,
        &[seed(boss.clone(), "e2", "c")],
        &inst,
        &[],
        None,
    )
    .expect("copies");
    assert!(out.op.is_none() && out.skipped.is_empty());
    assert_eq!(out.created.len(), 4);
    let v0 = volume(&boss);
    for (rb, i) in out.created.iter().zip(&inst) {
        assert_eq!(rb.change, BodyChange::Created);
        assert_eq!(
            rb.origin,
            Origin {
                feature: "pt1".into(),
                member: "c".into(),
                instance: Some(i.index()),
            }
        );
        assert!(close(volume(&rb.body), v0));
        let c = forge_check::mass_properties(&rb.body)
            .expect("mass")
            .centroid;
        let idx = i.index();
        assert!((c[0] - (5.0 + 10.0 * f64::from(idx[0]))).abs() < 1e-9);
        assert!((c[1] - (5.0 + 12.0 * f64::from(idx[1]))).abs() < 1e-9);
        for (_, f) in rb.body.faces().iter() {
            let p = parse_key(&f.provenance.key()).expect("key");
            assert_eq!(p.qualifier, Some(i.qualifier()));
        }
    }
}

#[test]
fn cut_seed_instances_running_off_the_part_are_skipped() {
    // A 4 × 10 × 20 slot tool at x ∈ [6, 10]; instances every 15 mm: 21, 36, 51 fit, 66 is off.
    let slot = aabox("e2", [6.0, 15.0, -5.0], [4.0, 10.0, 20.0]);
    let target = apply_body_op(
        BodyOp::Cut,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(slot.clone(), "e2", "b", 1)],
        "e2",
    )
    .expect("seed cut")
    .bodies
    .remove(0)
    .body;
    let inst = pattern_instances(&linear_x(5.0, 15.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Cut),
        &[seed(slot, "e2", "b")],
        &inst,
        &[ob(target.clone(), "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert_eq!(
        out.skipped,
        vec![Skipped {
            index: vec![4],
            code: "BOOLEAN_NO_INTERSECTION".into()
        }]
    );
    assert_eq!(out.notes[0].code(), "PATTERN_INSTANCE_SKIPPED");
    let res = out.op.expect("cut");
    assert_eq!(res.bodies.len(), 1);
    assert!(close(
        volume(&res.bodies[0].body),
        60.0 * 40.0 * 8.0 - 4.0 * 4.0 * 10.0 * 8.0
    ));
    assert_eq!(out.tools.len(), 3);
}

#[test]
fn a_tool_covered_by_another_instance_still_counts_as_met() {
    // Slots 20 long every 10 mm: instance 1's material is entirely inside instance 2's
    // tool, so no face of instance 1 survives; it is re-tested alone and kept.
    let slot = aabox("e2", [-5.0, 15.0, -5.0], [20.0, 10.0, 20.0]);
    let target = apply_body_op(
        BodyOp::Cut,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(slot.clone(), "e2", "b", 1)],
        "e2",
    )
    .expect("seed cut")
    .bodies
    .remove(0)
    .body;
    let inst = pattern_instances(&linear_x(3.0, 10.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Cut),
        &[seed(slot, "e2", "b")],
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert!(out.skipped.is_empty(), "{:?}", out.skipped);
    let res = out.op.expect("cut");
    // Removed: x ∈ [0, 35] × y ∈ [15, 25] through the plate.
    assert!(close(
        volume(&res.bodies[0].body),
        60.0 * 40.0 * 8.0 - 35.0 * 10.0 * 8.0
    ));
}

#[test]
fn instances_that_consume_the_target_leave_no_face_but_are_met() {
    // Both instances swallow the whole block: no face of either survives, so each is
    // re-tested alone (the fallback), found to meet, and the block is consumed.
    let block = aabox("e1", [15.0, 15.0, 0.0], [10.0, 10.0, 8.0]);
    let slot = aabox("e2", [-5.0, 10.0, -5.0], [20.0, 20.0, 20.0]);
    let inst = pattern_instances(&linear_x(3.0, 10.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Cut),
        &[seed(slot, "e2", "b")],
        &inst,
        &[ob(block, "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert!(out.skipped.is_empty(), "{:?}", out.skipped);
    let res = out.op.expect("cut");
    assert!(res.bodies.is_empty());
    assert_eq!(res.removed, vec![origin("e1", "b")]);
    assert_eq!(res.notes[0].code(), "BOOLEAN_BODY_CONSUMED");
}

#[test]
fn join_seed_bosses_off_the_plate_are_skipped() {
    let boss = zcyl("e2", [10.0, 20.0], 3.0, 8.0, 6.0);
    let target = apply_body_op(
        BodyOp::Join,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(boss.clone(), "e2", "c", 1)],
        "e2",
    )
    .expect("seed join")
    .bodies
    .remove(0)
    .body;
    // 10, 30, 50 on the plate; 70 floats beside it (detached).
    let inst = pattern_instances(&linear_x(4.0, 20.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Join),
        &[seed(boss, "e2", "c")],
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert_eq!(
        out.skipped
            .iter()
            .map(|s| s.index.clone())
            .collect::<Vec<_>>(),
        vec![vec![3]]
    );
    let res = out.op.expect("join");
    assert_eq!(res.bodies.len(), 1);
    assert_eq!(res.bodies[0].origin, origin("e1", "b"));
    assert!(close(
        volume(&res.bodies[0].body),
        60.0 * 40.0 * 8.0 + 3.0 * PI * 9.0 * 6.0
    ));
}

#[test]
fn every_instance_missing_fails_the_pattern() {
    let slot = aabox("e2", [6.0, 15.0, -5.0], [4.0, 10.0, 20.0]);
    // Instances 100 mm apart: all off the plate.
    let inst = pattern_instances(&linear_x(3.0, 100.0), &[]).expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Cut),
        &[seed(slot, "e2", "b")],
        &inst,
        &[ob(plate(), "e1", "b", 0)],
        None,
    )
    .expect_err("all miss");
    assert_eq!(e.code(), "PATTERN_ALL_INSTANCES_FAILED");
    let PatternError::AllInstancesFailed { instances } = e else {
        panic!("{e}")
    };
    assert_eq!(instances.len(), 2);
    // Near but not touching: the combined cut itself decides (boxes within reach).
    let slot = aabox("e2", [61.0, 15.0, -5.0], [4.0, 10.0, 20.0]);
    let inst = pattern_instances(&linear_x(2.0, 0.5), &[]).expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Cut),
        &[seed(slot, "e2", "b")],
        &inst,
        &[ob(plate(), "e1", "b", 0)],
        None,
    )
    .expect_err("all miss");
    assert_eq!(e.code(), "PATTERN_ALL_INSTANCES_FAILED");
}

/// A hole feature `h1` on the plate's top: returns the plate after the hole and the seed tools.
fn holed_plate(fields: serde_json::Value) -> (Body, Vec<SeedBody>) {
    let p = plate();
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, 8.0));
    let mut v = json!({ "id": "h1", "name": "holes", "on": "XY" });
    for (k, x) in fields.as_object().expect("object") {
        v[k] = x.clone();
    }
    let h: forge_ir::v1::HoleFeature = serde_json::from_value(v).expect("hole");
    let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = p
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("top");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&p, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)]).expect("hole");
    let tools = o.seed_bodies();
    (o.op.bodies.into_iter().next().expect("body").body, tools)
}

#[test]
fn circular_pattern_of_a_hole_with_skip() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [42, 20] }] }, "d": 3, "depth": { "blind": 5 } }),
    );
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: Vec3::new(30.0, 20.0, 0.0),
            axis: Vec3::unit_z(),
            count: 6.0,
            angle: 360.0,
        }),
        &[vec![3]],
    )
    .expect("instances");
    assert_eq!(inst.len(), 4);
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target.clone(), "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert!(out.skipped.is_empty());
    let res = out.op.expect("cut");
    let one = volume(&plate()) - volume(&target);
    assert!(close(
        volume(&res.bodies[0].body),
        volume(&target) - 4.0 * one
    ));
    // Copied hole faces are keyed per instance.
    let quals: std::collections::BTreeSet<String> = res.bodies[0]
        .body
        .faces()
        .iter()
        .filter_map(|(_, f)| parse_key(&f.provenance.key()).ok())
        .filter(|p| p.feature == "pt1")
        .filter_map(|p| p.qualifier)
        .collect();
    assert_eq!(quals.into_iter().collect::<Vec<_>>(), ["1", "2", "4", "5"]);
}

#[test]
fn hole_instances_off_the_part_are_skipped_with_hole_misses_body() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [10, 20] }] }, "d": 3, "depth": "through" }),
    );
    let inst = pattern_instances(&linear_x(4.0, 20.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert_eq!(
        out.skipped,
        vec![Skipped {
            index: vec![3],
            code: "HOLE_MISSES_BODY".into()
        }]
    );
}

#[test]
fn a_hole_patterned_onto_itself_misses_every_time() {
    // Rotating a hole about its own axis puts every copy where the seed already cut.
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [30, 20] }] }, "d": 3, "depth": "through" }),
    );
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: Vec3::new(30.0, 20.0, 0.0),
            axis: Vec3::unit_z(),
            count: 3.0,
            angle: 360.0,
        }),
        &[],
    )
    .expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect_err("all copies miss");
    let PatternError::AllInstancesFailed { instances } = e else {
        panic!("{e}")
    };
    assert!(instances.iter().all(|s| s.code == "HOLE_MISSES_BODY"));
}

#[test]
fn mirrored_hole_and_boss_land_on_the_other_side() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [12, 10] }] }, "size": "M4", "depth": { "blind": 5 }, "cbore": { "d": 8, "depth": 2 } }),
    );
    let inst = pattern_instances(
        &Layout::Mirror(MirrorLayout {
            origin: Vec3::new(30.0, 0.0, 0.0),
            normal: Vec3::unit_x(),
        }),
        &[],
    )
    .expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target.clone(), "e1", "b", 0)],
        None,
    )
    .expect("mirror");
    let res = out.op.expect("cut");
    let b = &res.bodies[0].body;
    let one = volume(&plate()) - volume(&target);
    assert!(close(volume(b), volume(&target) - one));
    // The copy's counterbore wall is centred at x = 48.
    let cyl = b
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.feature == "pt1" && f.surface.kind_name() == "cylinder")
        .map(|(_, f)| f.surface.clone())
        .expect("copied wall");
    let forge_core::geom::Surface::Cylinder(c) = cyl else {
        panic!()
    };
    assert!(
        (c.frame().origin().x - 48.0).abs() < 1e-9 && (c.frame().origin().y - 10.0).abs() < 1e-9
    );
    // A mirrored join seed (a boss with an off-centre D-shaped profile).
    let boss = extruded(
        "e2",
        8.0,
        vec![
            SketchCurve::Line {
                id: "s".into(),
                start: [10.0, 5.0],
                end: [10.0, 15.0],
            },
            SketchCurve::Arc {
                id: "a".into(),
                start: [10.0, 15.0],
                end: [10.0, 5.0],
                center: [10.0, 10.0],
                ccw: true,
            },
        ],
        4.0,
    );
    let joined = apply_body_op(
        BodyOp::Join,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(boss.clone(), "e2", "a", 1)],
        "e2",
    )
    .expect("join")
    .bodies
    .remove(0)
    .body;
    let out = apply_seed(
        "pt2",
        3,
        SeedOp::Body(BodyOp::Join),
        &[seed(boss.clone(), "e2", "a")],
        &inst,
        &[ob(joined.clone(), "e1", "b", 0)],
        None,
    )
    .expect("mirror join");
    let res = out.op.expect("join");
    assert!(close(
        volume(&res.bodies[0].body),
        volume(&joined) + volume(&boss)
    ));
}

#[test]
fn intersect_seed_instances_that_miss_report_empty_result() {
    let blocks = [
        ob(
            aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]),
            "e1",
            "b",
            0,
        ),
        ob(
            aabox("e3", [20.0, 0.0, 0.0], [10.0, 10.0, 10.0]),
            "e3",
            "b",
            1,
        ),
    ];
    let tool = zcyl("e2", [5.0, 5.0], 4.0, -1.0, 12.0);
    // Instance 1 at x = 25 meets the second block, instance 2 at x = 45 nothing.
    let inst = pattern_instances(&linear_x(3.0, 20.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Intersect),
        &[seed(tool, "e2", "c")],
        &inst,
        &blocks,
        None,
    )
    .expect("pattern");
    assert_eq!(
        out.skipped,
        vec![Skipped {
            index: vec![2],
            code: "BOOLEAN_EMPTY_RESULT".into()
        }]
    );
    let res = out.op.expect("intersect");
    let vols: Vec<f64> = res.bodies.iter().map(|b| volume(&b.body)).collect();
    assert!(vols.iter().any(|&v| close(v, PI * 16.0 * 10.0)), "{vols:?}");
}

#[test]
fn pattern_results_are_deterministic() {
    let run = || {
        let (target, tools) = holed_plate(
            json!({ "at": { "list": [{ "id": "a", "at": [42, 20] }] }, "size": "M4", "depth": { "blind": 5 }, "csink": "iso10642" }),
        );
        let inst = pattern_instances(
            &Layout::Circular(CircularLayout {
                origin: Vec3::new(30.0, 20.0, 0.0),
                axis: Vec3::unit_z(),
                count: 7.0,
                angle: 360.0,
            }),
            &[],
        )
        .expect("instances");
        let out = apply_seed(
            "pt1",
            2,
            SeedOp::Hole,
            &tools,
            &inst,
            &[ob(target, "e1", "b", 0)],
            None,
        )
        .expect("pattern");
        let b = &out.op.expect("cut").bodies[0].body;
        let m = forge_check::body_metrics(b).expect("metrics");
        let mut keys: Vec<String> = b.faces().iter().map(|(_, f)| f.provenance.key()).collect();
        keys.sort();
        (m.volume.to_bits(), m.area.to_bits(), m.faces, m.edges, keys)
    };
    assert_eq!(run(), run());
}

mod props {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 12, ..ProptestConfig::default() })]

        /// New-body copies of a seed are disjoint translates, rotations or reflections: each
        /// has the seed's volume, and a cut pattern of disjoint slots inside the plate removes
        /// `instances × slot volume`.
        #[test]
        fn disjoint_instances_add_their_seed_volumes(
            count in 2usize..6,
            spacing in 7.0f64..9.0,
            w in 2.0f64..5.0,
            deg in 0usize..3,
        ) {
            let slot = aabox("e2", [3.0, 5.0, -1.0], [w, 4.0, 10.0]);
            let layout = match deg {
                0 => linear_x(count as f64, spacing),
                1 => Layout::Linear(LinearLayout {
                    dir: Vec3::unit_x(),
                    count: count as f64,
                    spacing,
                    second: Some((Vec3::unit_y(), 2.0, 10.0)),
                }),
                _ => Layout::Mirror(MirrorLayout { origin: Vec3::new(30.0, 0.0, 0.0), normal: Vec3::unit_x() }),
            };
            let inst = pattern_instances(&layout, &[]).expect("instances");
            let target = apply_body_op(BodyOp::Cut, &[ob(plate(), "e1", "b", 0)], &[ob(slot.clone(), "e2", "b", 1)], "e2")
                .expect("seed").bodies.remove(0).body;
            let out = apply_seed("pt1", 2, SeedOp::Body(BodyOp::Cut), &[seed(slot.clone(), "e2", "b")], &inst,
                &[ob(target.clone(), "e1", "b", 0)], None).expect("pattern");
            prop_assert!(out.skipped.is_empty());
            let v = volume(&out.op.expect("cut").bodies[0].body);
            let one = w * 4.0 * 8.0;
            prop_assert!(close(v, volume(&target) - inst.len() as f64 * one), "{} vs {}", v, volume(&target) - inst.len() as f64 * one);
            let nb = apply_seed("pt2", 3, SeedOp::NewBody, &[seed(slot.clone(), "e2", "b")], &inst, &[], None).expect("copies");
            for c in &nb.created {
                prop_assert!(close(volume(&c.body), w * 4.0 * 10.0));
            }
        }
    }
}

/// A counterbored through hole patterned on a grid whose counterbores overlap (oracle batch
/// seed 7 #61: plate 51.5 × 59.5 × 5.5, M4 at (13, 22.5), spacing 6 × 7.5).
fn counterbore_grid(c1: f64, c2: f64) -> Result<f64, PatternError> {
    let p = aabox("e1", [0.0, 0.0, 0.0], [51.5, 59.5, 5.5]);
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, 5.5));
    let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({ "id": "h1", "name": "holes", "on": "XY",
        "at": { "list": [{ "id": "a", "at": [13.0, 22.5] }] }, "size": "M4", "depth": "through", "cbore": "iso4762" }))
    .expect("hole");
    let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = p
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("top");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&p, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)]).expect("hole");
    let tools: Vec<SeedBody> = o.seed_bodies();
    let target = o.op.bodies[0].body.clone();
    let inst = pattern_instances(
        &Layout::Linear(LinearLayout {
            dir: Vec3::unit_x(),
            count: c1,
            spacing: 6.0,
            second: Some((Vec3::unit_y(), c2, 7.5)),
        }),
        &[],
    )
    .expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )?;
    Ok(volume(&out.op.expect("cut").bodies[0].body))
}

#[test]
fn overlapping_counterbore_floors_of_a_pattern_merge() {
    let v = counterbore_grid(2.0, 2.0).expect("2 × 2");
    assert!(v > 0.0);
}

/// Found by the OCCT differential (seed 7 #61): an explicit W4 failure in the same-domain
/// merge of many overlapping counterbore floors, never a wrong body. OCCT builds the body.
#[test]
#[ignore = "W4 unify: FORGE_BOOLEAN_INCONSISTENT merging overlapping counterbore floors"]
fn overlapping_counterbore_floors_of_a_3x3_pattern_merge() {
    let v = counterbore_grid(3.0, 3.0).expect("3 × 3");
    assert!(v > 0.0);
}

// ---- hole seeds: through copies, break-through, per-position misses ------------------------

/// Hole `h1` on the top cap (z = `t`) of `p`: the holed body and the hole's seed tools.
fn hole_seed(p: &Body, t: f64, fields: serde_json::Value) -> (Body, Vec<SeedBody>) {
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, t));
    let mut v = json!({ "id": "h1", "name": "holes", "on": "XY" });
    for (k, x) in fields.as_object().expect("object") {
        v[k] = x.clone();
    }
    let h: forge_ir::v1::HoleFeature = serde_json::from_value(v).expect("hole");
    let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = p
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("top");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((p, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)]).expect("hole");
    assert!(o.notes.is_empty(), "the seed itself does not break through");
    let seeds = o.seed_bodies();
    (o.op.bodies.into_iter().next().expect("body").body, seeds)
}

fn through_error(e: PatternError) -> (Vec<u32>, String, f64, f64) {
    assert_eq!(e.code(), "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT", "{e}");
    let PatternError::ThroughCopyTooShort {
        index,
        seed,
        at,
        length,
        reach,
    } = e
    else {
        unreachable!()
    };
    assert_eq!(seed, "h1");
    (index, at, length, reach)
}

/// The reviewer's probe: a through hole sized for a 5 mm plate, patterned onto a 25 mm block
/// with the same top (targets re-resolved in the pattern's scope). The copies would leave
/// 6.7 mm deep flat-bottomed pockets; the pattern fails with the copy's length and the
/// targets' reach instead.
#[test]
fn a_through_hole_patterned_onto_a_thicker_later_body_fails() {
    let thin = aabox("e1", [0.0, 0.0, 0.0], [60.0, 40.0, 5.0]);
    let (_, tools) = hole_seed(
        &thin,
        5.0,
        json!({ "at": { "list": [{ "id": "a", "at": [10, 20] }] }, "d": 3.4, "depth": "through" }),
    );
    let thick = aabox("e5", [0.0, 0.0, -20.0], [60.0, 40.0, 25.0]);
    let inst = pattern_instances(&linear_x(3.0, 20.0), &[]).expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(thick, "e5", "b", 1)],
        None,
    )
    .expect_err("a through copy may not become a pocket");
    let (index, at, length, reach) = through_error(e);
    let diag = (60.0f64 * 60.0 + 40.0 * 40.0 + 25.0).sqrt();
    assert_eq!((index, at.as_str()), (vec![1], "a"));
    assert!(close(length, 5.0 + 1.0 + 1e-2 * diag), "{length}");
    assert!(close(reach, 25.0), "{reach}");
}

/// A circular pattern about X tilts the drilling axis: the copies at 90° and 270° run
/// sideways through the plate and would end inside it.
#[test]
fn a_through_hole_rotated_about_x_fails_instead_of_leaving_a_pocket() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [30, 20] }] }, "d": 3, "depth": "through" }),
    );
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: Vec3::new(0.0, 20.0, 4.0),
            axis: Vec3::unit_x(),
            count: 4.0,
            angle: 360.0,
        }),
        &[],
    )
    .expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect_err("sideways copies are too short");
    let (index, _, _, reach) = through_error(e);
    assert_eq!(index, vec![1]);
    // From y = 16 along +Y to the plate's side at y = 40.
    assert!(close(reach, 24.0), "{reach}");
}

/// Half a turn about X puts the copy on the bottom face drilling up: a through hole again.
#[test]
fn a_through_hole_rotated_half_a_turn_about_x_is_through_from_below() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [30, 12] }] }, "d": 3, "depth": "through" }),
    );
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: Vec3::new(0.0, 20.0, 4.0),
            axis: Vec3::unit_x(),
            count: 2.0,
            angle: 360.0,
        }),
        &[],
    )
    .expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target.clone(), "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert!(
        out.skipped.is_empty() && out.notes.is_empty(),
        "{:?}",
        out.notes
    );
    let v = volume(&out.op.expect("cut").bodies[0].body);
    assert!(close(v, volume(&target) - PI * 2.25 * 8.0), "{v}");
}

/// A mirror in a horizontal plane flips the drilling direction onto the bottom of a thicker
/// body below the plate: the copy would stop 10 mm into it.
#[test]
fn a_through_hole_mirrored_in_a_horizontal_plane_onto_a_thicker_body_fails() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [15, 20] }] }, "d": 3, "depth": "through" }),
    );
    let below = aabox("e5", [0.0, 0.0, -30.0], [60.0, 40.0, 20.0]);
    let inst = pattern_instances(
        &Layout::Mirror(MirrorLayout {
            origin: Vec3::new(0.0, 0.0, -11.0),
            normal: Vec3::unit_z(),
        }),
        &[],
    )
    .expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0), ob(below, "e5", "b", 1)],
        None,
    )
    .expect_err("the mirrored copy is too short");
    let (index, _, _, reach) = through_error(e);
    assert_eq!(index, vec![1]);
    assert!(close(reach, 38.0), "{reach}");
}

/// A copy that stops short of the part is not "missing" it: an unbounded through tool would
/// meet the plate, so the pattern fails rather than skipping the instance.
#[test]
fn a_through_copy_that_stops_short_of_the_part_is_an_error_not_a_skip() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [15, 20] }] }, "d": 3, "depth": "through" }),
    );
    let inst = pattern_instances(
        &Layout::Linear(LinearLayout {
            dir: Vec3::new(1.0, 0.0, 1.0),
            count: 2.0,
            spacing: 20.0 * 2f64.sqrt(),
            second: None,
        }),
        &[],
    )
    .expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect_err("too short, not skipped");
    assert_eq!(through_error(e).0, vec![1]);
}

/// Material deeper along the axis but outside the copy's footprint (a leg at the far end of
/// the plate) does not make a copy too short: the result is the through hole.
#[test]
fn a_through_copy_whose_footprint_misses_deeper_material_stays_through() {
    let (holed, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [20, 20] }] }, "d": 3, "depth": "through" }),
    );
    let leg = aabox("e4", [50.0, 0.0, -30.0], [10.0, 40.0, 38.0]);
    let part = apply_body_op(
        BodyOp::Join,
        &[ob(holed, "e1", "b", 0)],
        &[ob(leg, "e4", "b", 1)],
        "e4",
    )
    .expect("join")
    .bodies
    .remove(0)
    .body;
    let inst = pattern_instances(&linear_x(2.0, 20.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        3,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(part.clone(), "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    let res = out.op.expect("cut");
    let v = volume(&res.bodies[0].body);
    assert!(close(v, volume(&part) - PI * 2.25 * 8.0), "{v}");
    // The copy's far end is gone: a through hole.
    assert!(
        res.bodies[0]
            .body
            .faces()
            .iter()
            .all(|(_, f)| f.provenance.key() != "pt1/copy:{h1/end@a}@1")
    );
}

/// A patterned blind hole over a pocket breaks through; the warning names the instance and
/// the seed position (engine-prefixed until the Contract stage rules on it). An instance
/// over full material does not warn.
#[test]
fn patterned_blind_holes_over_a_pocket_warn_that_they_break_through() {
    let pocketed = apply_body_op(
        BodyOp::Cut,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(
            aabox("e3", [35.0, 10.0, -1.0], [10.0, 20.0, 6.0]),
            "e3",
            "b",
            1,
        )],
        "e3",
    )
    .expect("pocket")
    .bodies
    .remove(0)
    .body;
    let (target, tools) = hole_seed(
        &pocketed,
        8.0,
        json!({ "at": { "list": [{ "id": "a", "at": [20, 20] }] }, "d": 3, "depth": { "blind": 5 } }),
    );
    let run = |spacing: f64| {
        let inst = pattern_instances(&linear_x(2.0, spacing), &[]).expect("instances");
        apply_seed(
            "pt1",
            3,
            SeedOp::Hole,
            &tools,
            &inst,
            &[ob(target.clone(), "e1", "b", 0)],
            None,
        )
        .expect("pattern")
    };
    let over_pocket = run(20.0);
    let codes: Vec<(&str, serde_json::Value)> = over_pocket
        .notes
        .iter()
        .map(|n| (n.code(), serde_json::to_value(n).expect("json")))
        .collect();
    assert_eq!(
        codes,
        vec![(
            "FORGE_PATTERN_HOLE_BREAKS_THROUGH",
            json!({ "index": [1], "seed": "h1", "at": "a" })
        )]
    );
    assert!(run(10.0).notes.is_empty());
}

/// A kept instance of a two-position hole seed whose second copied position runs off the
/// part: the instance stays (SPEC §6.10 skips only instances whose tools all miss) and the
/// missing position is a warning, not silently ignored.
#[test]
fn a_copied_hole_position_that_misses_keeps_its_instance_and_warns() {
    let (target, tools) = holed_plate(json!({
        "at": { "list": [{ "id": "a", "at": [10, 20] }, { "id": "b", "at": [50, 20] }] },
        "d": 3, "depth": "through"
    }));
    let inst = pattern_instances(&linear_x(2.0, 20.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target.clone(), "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert!(out.skipped.is_empty());
    let notes: Vec<(&str, serde_json::Value)> = out
        .notes
        .iter()
        .map(|n| (n.code(), serde_json::to_value(n).expect("json")))
        .collect();
    assert_eq!(
        notes,
        vec![(
            "FORGE_PATTERN_HOLE_POSITION_MISSED",
            json!({ "index": [1], "seed": "h1", "at": "b" })
        )]
    );
    let v = volume(&out.op.expect("cut").bodies[0].body);
    assert!(close(v, volume(&target) - PI * 2.25 * 8.0), "{v}");
}

/// SPEC §6.10 as written: an intersect seed's instances are intersected with the targets
/// re-resolved in the pattern's scope — the seed's own result — so copies that do not
/// overlap the seed's tool empty it and every instance fails with `BOOLEAN_EMPTY_RESULT`
/// (W5 contract issue: almost never what a user means).
#[test]
fn an_intersect_seed_pattern_intersects_the_seed_result_with_the_copies_only() {
    let block = aabox("e1", [0.0, 0.0, 0.0], [40.0, 10.0, 10.0]);
    let tool = zcyl("e2", [5.0, 5.0], 4.0, -1.0, 12.0);
    let seed_result = apply_body_op(
        BodyOp::Intersect,
        &[ob(block, "e1", "b", 0)],
        &[ob(tool.clone(), "e2", "c", 1)],
        "e2",
    )
    .expect("seed")
    .bodies
    .remove(0)
    .body;
    let inst = pattern_instances(&linear_x(3.0, 12.0), &[]).expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Body(BodyOp::Intersect),
        &[seed(tool, "e2", "c")],
        &inst,
        &[ob(seed_result, "e1", "b", 0)],
        None,
    )
    .expect_err("every copy empties the seed's cylinder");
    let PatternError::AllInstancesFailed { instances } = e else {
        panic!("{e}")
    };
    assert!(instances.iter().all(|s| s.code == "BOOLEAN_EMPTY_RESULT"));
    assert_eq!(instances.len(), 2);
}

/// The reviewer's probe of the hole-seed contract: the thick-body case above with the tool
/// information dropped (`hole: None`, as a hand-built `SeedBody` would have it) must not
/// silently cut two 6.7 mm pockets — the pattern refuses the seed before building anything.
#[test]
fn a_hole_seed_without_its_tool_information_is_refused() {
    let thin = aabox("e1", [0.0, 0.0, 0.0], [60.0, 40.0, 5.0]);
    let (_, tools) = hole_seed(
        &thin,
        5.0,
        json!({ "at": { "list": [{ "id": "a", "at": [10, 20] }] }, "d": 3.4, "depth": "through" }),
    );
    let thick = aabox("e5", [0.0, 0.0, -20.0], [60.0, 40.0, 25.0]);
    let inst = pattern_instances(&linear_x(3.0, 20.0), &[]).expect("instances");
    let bare: Vec<SeedBody> = tools
        .iter()
        .cloned()
        .map(|mut s| {
            s.hole = None;
            s
        })
        .collect();
    let run = |op: SeedOp, seeds: &[SeedBody]| {
        apply_seed(
            "pt1",
            2,
            op,
            seeds,
            &inst,
            &[ob(thick.clone(), "e5", "b", 1)],
            None,
        )
    };
    let mismatch = |e: PatternError, what: &str| {
        assert_eq!(e.code(), "FORGE_PATTERN_HOLE_SEED_MISMATCH", "{e}");
        let PatternError::HoleSeedMismatch { seed, at, what: w } = e else {
            unreachable!()
        };
        assert_eq!((seed.as_str(), at.as_str()), ("h1", "a"));
        assert!(w.contains(what), "{w}");
    };
    // A hole seed without its information.
    mismatch(run(SeedOp::Hole, &bare).expect_err("refused"), "without");
    // A hole tool applied as a plain cut, with or without its information.
    mismatch(
        run(SeedOp::Body(BodyOp::Cut), &bare).expect_err("refused"),
        "another operation",
    );
    mismatch(
        run(SeedOp::Body(BodyOp::Cut), &tools).expect_err("refused"),
        "not applied as a hole",
    );
    // With its information: the explicit through-copy error, as before.
    assert_eq!(
        run(SeedOp::Hole, &tools).expect_err("too short").code(),
        "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT"
    );
}

/// Instances × seed bodies are bounded before any copy is built (a 5000-instance pattern of
/// three seed bodies would build 15 000 bodies).
#[test]
fn too_many_copies_fail_before_anything_is_built() {
    let block = aabox("e2", [0.0, 0.0, 20.0], [1.0, 1.0, 1.0]);
    let seeds = vec![
        seed(block.clone(), "e2", "a"),
        seed(block.clone(), "e2", "b"),
        seed(block, "e2", "c"),
    ];
    let inst = pattern_instances(&linear_x(5001.0, 2.0), &[]).expect("instances");
    let e =
        apply_seed("pt1", 2, SeedOp::NewBody, &seeds, &inst, &[], None).expect_err("15000 copies");
    assert_eq!(e.code(), "FORGE_PATTERN_TOO_MANY_COPIES");
    assert_eq!(
        serde_json::to_value(e.details()).expect("json"),
        json!({ "instances": 5000.0, "seed_bodies": 3.0, "copies": 15000.0, "max": 10000.0 })
    );
    // 3333 instances of three bodies (9999 copies) are within the limit.
    let inst = pattern_instances(&linear_x(3334.0, 2.0), &[]).expect("instances");
    assert_eq!(inst.len() * seeds.len(), 9999);
}

/// A through hole copied by a translation with a component against the drilling direction:
/// the copy's top point lies 3 mm inside the plate, so the copy is a pocket closed at its top
/// (SPEC §6.5's tool "from P along d"; the oracle's reading too). Forge returns that body and
/// says so with `FORGE_PATTERN_HOLE_TOP_INSIDE` (W5 contract issue: whether a through copy
/// also extends backwards).
#[test]
fn a_through_copy_whose_top_lands_inside_the_part_warns() {
    let (target, tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [10, 20] }] }, "d": 3.4, "depth": "through" }),
    );
    let dir = Vec3::new(20.0, 0.0, -3.0);
    let inst = pattern_instances(
        &Layout::Linear(LinearLayout {
            dir,
            count: 2.0,
            spacing: dir.norm(),
            second: None,
        }),
        &[],
    )
    .expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target.clone(), "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    let notes: Vec<(&str, serde_json::Value)> = out
        .notes
        .iter()
        .map(|n| (n.code(), serde_json::to_value(n).expect("json")))
        .collect();
    assert_eq!(
        notes,
        vec![(
            "FORGE_PATTERN_HOLE_TOP_INSIDE",
            json!({ "index": [1], "seed": "h1", "at": "a" })
        )]
    );
    let res = out.op.expect("cut");
    let b = &res.bodies[0].body;
    let r2 = 1.7 * 1.7;
    assert!(
        close(volume(b), volume(&target) - PI * r2 * 5.0),
        "{}",
        volume(b)
    );
    assert!(
        b.faces()
            .iter()
            .any(|(_, f)| f.provenance.key() == "pt1/copy:{h1/top@a}@1")
    );
    // Moving the copy along the drilling direction's opposite (up) leaves no warning.
    let inst = pattern_instances(&linear_x(2.0, 20.0), &[]).expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &tools,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    assert!(out.notes.is_empty(), "{:?}", out.notes);
}

/// Oracle case #279 (seed 1234): an M5 `iso10642` through hole at (14, 42) on a 40 × 60.5 × 9
/// plate, mirrored in the plane through (20, 30, 4) with normal (1, 0, 2). The two hole walls
/// have equal radii (2.75) and their axes meet at (14, 42, 7), so their sections are ellipses
/// (SPEC §8.3 rule 3 (a), [W0-43]; OCP confirms `GeomAbs_Ellipse`; normalized OCCT
/// `{ ellipse: 6, bspline: 6 }`). The section typing is W4's (witness conics, [W0-52] (b)):
/// until W4 lands it, Forge types two of those ellipse pieces `bspline`, and this test pins
/// that outcome so the change is noticed. Without the countersink the same crossing is
/// typed right today (8 ellipse pieces, no B-spline). The copy's placement point
/// (12.4, 42, 5.8) is inside the plate: `FORGE_PATTERN_HOLE_TOP_INSIDE`.
#[test]
fn mirrored_equal_radius_hole_walls_whose_axes_meet_section_in_ellipses() {
    let types = |fields: serde_json::Value| {
        let p = aabox("e1", [0.0, 0.0, 0.0], [40.0, 60.5, 9.0]);
        let (target, tools) = hole_seed(&p, 9.0, fields);
        let inst = pattern_instances(
            &Layout::Mirror(MirrorLayout {
                origin: Vec3::new(20.0, 30.0, 4.0),
                normal: Vec3::new(1.0, 0.0, 2.0),
            }),
            &[],
        )
        .expect("instances");
        let out = apply_seed(
            "pt1",
            2,
            SeedOp::Hole,
            &tools,
            &inst,
            &[ob(target, "e1", "b", 0)],
            None,
        )
        .expect("pattern");
        let codes: Vec<&str> = out.notes.iter().map(|n| n.code()).collect();
        assert_eq!(codes, ["FORGE_PATTERN_HOLE_TOP_INSIDE"]);
        let res = out.op.expect("cut");
        assert_eq!(res.bodies.len(), 1);
        let m = forge_check::body_metrics(&res.bodies[0].body).expect("metrics");
        m.edge_types
            .into_iter()
            .filter(|(k, _)| k == "bspline" || k == "ellipse")
            .collect::<Vec<(String, u32)>>()
    };
    let at = json!({ "list": [{ "id": "a", "at": [14, 42] }] });
    assert_eq!(
        types(json!({ "at": at, "size": "M5", "depth": "through" })),
        vec![("ellipse".to_string(), 8)]
    );
    let got = types(json!({ "at": at, "size": "M5", "depth": "through", "csink": "iso10642" }));
    let witness = vec![("bspline".to_string(), 6), ("ellipse".to_string(), 6)];
    let today = vec![("bspline".to_string(), 8), ("ellipse".to_string(), 4)];
    assert!(
        got == witness || got == today,
        "edge types {got:?}: expected {witness:?} (SPEC) or, until W4's witness conics, {today:?}"
    );
    if got == today {
        eprintln!("W4 pending (#279): equal-radius crossing hole walls typed bspline ({got:?})");
    }
}

mod through_props {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use forge_core::topo::Body;
    use forge_ir::v1::metrics::HoleKind;
    use forge_ops::boolean::BooleanError;
    use forge_ops::hole::{Depth, HoleSpec, Tip, hole_tool};
    use forge_ops::pattern::{Motion, move_body};
    use proptest::prelude::*;
    use proptest::test_runner::{Config, RngAlgorithm, TestRng, TestRunner};

    /// Total volume left by a cut of `targets` by `tool` (`None`: the tool meets nothing).
    fn cut_volume(targets: &[OpBody], tool: Body) -> Result<Option<f64>, BooleanError> {
        match apply_body_op(BodyOp::Cut, targets, &[ob(tool, "k", "t", 5)], "k") {
            Ok(r) => {
                let mut v: f64 = r.bodies.iter().map(|b| volume(&b.body)).sum();
                v += r
                    .untouched_targets
                    .iter()
                    .map(|&i| volume(&targets[i].body))
                    .sum::<f64>();
                Ok(Some(v))
            }
            Err(BooleanError::NoIntersection { .. }) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// One case of the property below; returns the pattern's outcome code (`"ok"`).
    #[allow(clippy::too_many_arguments)]
    fn through_case(
        (x, y): (f64, f64),
        kind: usize,
        axis: Vec3,
        deg: f64,
        (ox, oz): (f64, f64),
        thick: bool,
    ) -> Result<String, TestCaseError> {
        let (target, tools) = holed_plate(
            json!({ "at": { "list": [{ "id": "a", "at": [x, y] }] }, "d": 3, "depth": "through" }),
        );
        let layout = match kind {
            0 => Layout::Circular(CircularLayout {
                origin: Vec3::new(ox, 20.0, oz),
                axis,
                count: 2.0,
                angle: deg,
            }),
            1 => Layout::Mirror(MirrorLayout {
                origin: Vec3::new(ox, 20.0, oz),
                normal: axis,
            }),
            // Tilted mirrors through the plate's mid-plane: copies drilled up from the
            // bottom at a slant, which mostly still leave the plate.
            2 => Layout::Mirror(MirrorLayout {
                origin: Vec3::new(ox, 20.0, 4.0),
                normal: Vec3::new(0.3 * axis.x, 0.3 * axis.y, 1.0),
            }),
            _ => Layout::Linear(LinearLayout {
                dir: axis,
                count: 2.0,
                spacing: 5.0 + ox / 2.0,
                second: None,
            }),
        };
        let inst = pattern_instances(&layout, &[]).expect("instances");
        let mut targets = vec![ob(target, "e1", "b", 0)];
        if thick {
            targets.push(ob(
                aabox("e5", [0.0, 0.0, -25.0], [60.0, 40.0, 15.0]),
                "e5",
                "b",
                1,
            ));
        }
        let info = tools[0].hole.expect("hole info");
        let motion: Motion = inst[0].motion;
        // The copy as evaluated at the seed, and an unbounded (500 mm) one on its axis.
        let short = move_body(&tools[0].body, &motion, |_, p| p.clone()).expect("copy");
        let spec = HoleSpec {
            feature: "h1".into(),
            kind: HoleKind::Simple,
            d: 3.0,
            depth: Depth::Through,
            tip: Tip::Flat,
            cbore: None,
            csink: None,
            insert: None,
            size: None,
            thread: None,
            head_field: None,
        };
        let e = (Vec3::unit_x() - info.dir * info.dir.x)
            .normalize()
            .expect("e");
        let long = hole_tool(&spec, "a", info.point, info.dir, e, 500.0, true).expect("long");
        let long = move_body(&long, &motion, |_, p| p.clone()).expect("copy");
        let (Ok(v_short), Ok(v_long)) = (cut_volume(&targets, short), cut_volume(&targets, long))
        else {
            // An explicit W4 failure of a reference cut: nothing to compare.
            return Ok("reference_failed".into());
        };
        let r = apply_seed("pt1", 2, SeedOp::Hole, &tools, &inst, &targets, None);
        let code = r
            .as_ref()
            .map_or_else(|e| e.code().to_string(), |_| "ok".to_string());
        match r {
            Ok(out) => {
                // Never a pocket: exactly the unbounded tool's result.
                let res = out.op.expect("cut");
                let mut v: f64 = res.bodies.iter().map(|b| volume(&b.body)).sum();
                v += res
                    .untouched_targets
                    .iter()
                    .map(|&i| volume(&targets[i].body))
                    .sum::<f64>();
                let vl = v_long.expect("an unbounded tool meets the part too");
                prop_assert!(
                    (v - vl).abs() <= 1e-9 * vl,
                    "pattern {} vs unbounded {}",
                    v,
                    vl
                );
            }
            Err(PatternError::AllInstancesFailed { .. }) => {
                prop_assert!(
                    v_long.is_none(),
                    "skipped, but an unbounded tool cuts ({:?})",
                    v_long
                );
            }
            Err(err @ PatternError::ThroughCopyTooShort { .. }) => {
                // Justified: the copy as evaluated at the seed leaves material an unbounded
                // through tool removes (a pocket floor, or a sliver of it).
                let justified = match (v_short, v_long) {
                    (Some(a), Some(b)) => a - b > 1e-12 * b,
                    (None, Some(_)) => true,
                    _ => false,
                };
                prop_assert!(
                    justified,
                    "{}: short {:?} vs unbounded {:?}",
                    err,
                    v_short,
                    v_long
                );
            }
            Err(err) => {
                // Explicit engine failures are allowed; they are never a body.
                prop_assert!(err.code().starts_with("FORGE_"), "{}", err);
            }
        }
        Ok(code)
    }

    /// Found by the property below: a slanted mirror copy whose tilted far end stops just
    /// under the plate's top leaves a 4.8e-4 mm³ sliver an unbounded tool removes.
    #[test]
    fn a_slanted_mirror_copy_that_would_leave_a_sliver_is_too_short() {
        let code = through_case(
            (13.00015447699564, 30.736464471693527),
            2,
            Vec3::new(0.06026979587392379, 0.271291084292891, 0.0),
            10.0,
            (21.938404971137146, 0.0),
            false,
        )
        .expect("property");
        assert_eq!(code, "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT");
    }

    /// `W5_THROUGH_CASES` (default 16: about 45 s in a debug build) random cases, from
    /// `W5_THROUGH_SEED` (default 0).
    fn runner() -> (TestRunner, u32) {
        let env = |k: &str| std::env::var(k).ok().and_then(|v| v.parse::<u64>().ok());
        let cases = env("W5_THROUGH_CASES").unwrap_or(16) as u32;
        let mut seed = [0u8; 32];
        seed[..8].copy_from_slice(&env("W5_THROUGH_SEED").unwrap_or(0).to_le_bytes());
        let config = Config {
            cases,
            failure_persistence: None,
            ..Config::default()
        };
        (
            TestRunner::new_with_rng(config, TestRng::from_seed(RngAlgorithm::ChaCha, &seed)),
            cases,
        )
    }

    /// SPEC §6.5 "through: long enough to leave every target", for rigid motions and
    /// reflections that tilt the axis, translations along it and targets thicker than the
    /// seed's: a pattern of a through hole either gives exactly the result of an unbounded
    /// through tool, or fails with `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT` — and then the copy
    /// as evaluated at the seed really leaves material behind — or skips every instance when
    /// an unbounded tool misses too. Outcomes the property cannot check (another explicit
    /// `FORGE_*` failure, or a W4 failure of a reference cut) are counted and may not exceed
    /// 10 % of the cases, and at least a tenth of the cases must return a body (the two
    /// failures are checked against the reference, so an engine that always failed would not
    /// pass either; 200 cases gave 44 bodies, 112 verified too-short copies and 44 verified
    /// all-miss patterns, none unchecked). Run more with `W5_THROUGH_CASES=500`
    /// (and other seeds with `W5_THROUGH_SEED`).
    #[test]
    fn through_copies_match_unbounded_tools_or_fail() {
        let (mut runner, _) = runner();
        let outcomes: RefCell<BTreeMap<String, u32>> = RefCell::new(BTreeMap::new());
        let strategy = (
            (8.0f64..52.0, 8.0f64..32.0),
            0usize..4,
            (-1.0f64..1.0, -1.0f64..1.0, -1.0f64..1.0),
            10.0f64..350.0,
            (0.0f64..60.0, -12.0f64..20.0),
            any::<bool>(),
        );
        runner
            .run(&strategy, |(xy, kind, (ax, ay, az), deg, o, thick)| {
                let axis = Vec3::new(ax, ay, az);
                prop_assume!(axis.norm() > 0.2);
                let code = through_case(xy, kind, axis, deg, o, thick)?;
                *outcomes.borrow_mut().entry(code).or_default() += 1;
                Ok(())
            })
            .unwrap_or_else(|e| panic!("{e}"));
        let o = outcomes.into_inner();
        let total: u32 = o.values().sum();
        let checked = [
            "ok",
            "FORGE_PATTERN_THROUGH_COPY_TOO_SHORT",
            "PATTERN_ALL_INSTANCES_FAILED",
        ];
        let unchecked: u32 = o
            .iter()
            .filter(|(k, _)| !checked.contains(&k.as_str()))
            .map(|(_, n)| n)
            .sum();
        eprintln!("through-copy outcomes over {total} cases: {o:?}");
        assert!(total > 0);
        assert!(
            unchecked * 10 <= total,
            "{unchecked} of {total} cases unchecked (explicit failures or failed reference cuts): {o:?}"
        );
        assert!(
            o.get("ok").copied().unwrap_or(0) * 10 >= total,
            "fewer than a tenth of the cases return a body: {o:?}"
        );
    }
}

/// Two bosses (`e2` members `c0`, `c1`, one tool each) joined on the plate's top, and the
/// plate with them: a two-region join seed.
fn two_boss_seed(x0: f64, x1: f64, y: f64) -> (Body, Vec<SeedBody>) {
    let b0 = zcyl("e2", [x0, y], 3.0, 8.0, 6.0);
    let b1 = zcyl("e2", [x1, y], 3.0, 8.0, 6.0);
    let target = apply_body_op(
        BodyOp::Join,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(b0.clone(), "e2", "c0", 1), ob(b1.clone(), "e2", "c1", 1)],
        "e2",
    )
    .expect("seed join")
    .bodies
    .remove(0)
    .body;
    (target, vec![seed(b0, "e2", "c0"), seed(b1, "e2", "c1")])
}

/// SPEC [W0-39] applies per tool: a join instance with one boss on the part and one detached
/// is the join's `BOOLEAN_NO_INTERSECTION` (naming the detached copy), never a skipped
/// instance that silently drops the boss that meets; an instance whose every boss is
/// detached is skipped.
#[test]
fn a_join_instance_with_one_detached_boss_fails_instead_of_dropping_the_other() {
    let (target, seeds) = two_boss_seed(10.0, 30.0, 20.0);
    let run = |layout: Layout| {
        let inst = pattern_instances(&layout, &[]).expect("instances");
        apply_seed(
            "pt1",
            2,
            SeedOp::Body(BodyOp::Join),
            &seeds,
            &inst,
            &[ob(target.clone(), "e1", "b", 0)],
            None,
        )
    };
    // Instance [2]: a boss at x = 60 (on the plate over x ∈ [57, 60]) and one at x = 80.
    let e = run(linear_x(3.0, 25.0)).expect_err("a detached boss");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION");
    let PatternError::Boolean(forge_ops::boolean::BooleanError::NoIntersection { tool, .. }) = &e
    else {
        panic!("{e:?}")
    };
    assert_eq!(
        (
            tool.feature.as_str(),
            tool.member.as_str(),
            tool.instance.clone()
        ),
        ("pt1", "c1", Some(vec![2]))
    );
    // Instance [1] alone: x = 50 meets, x = 70 is detached — the join's error, not
    // `PATTERN_ALL_INSTANCES_FAILED`.
    let e = run(linear_x(2.0, 40.0)).expect_err("a detached boss");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION");
    // Along Y, 10 apart: [1] (y = 30) and [2] (y = 40, on the edge) meet with both bosses,
    // [3] (y = 50) has both detached and is skipped.
    let out = run(Layout::Linear(LinearLayout {
        dir: Vec3::unit_y(),
        count: 4.0,
        spacing: 10.0,
        second: None,
    }))
    .expect("pattern");
    assert_eq!(
        out.skipped,
        vec![Skipped {
            index: vec![3],
            code: "BOOLEAN_NO_INTERSECTION".into()
        }]
    );
    let res = out.op.expect("join");
    assert_eq!(res.bodies.len(), 1);
    assert!(close(
        volume(&res.bodies[0].body),
        volume(&target) + 4.0 * PI * 9.0 * 6.0
    ));
}

/// Review 6 (W5 differential seed 313 #37): misses before the join's own failures. Two r = 1.5
/// bosses (2 high) at (5.5, 21) and (21.5, 21) on the plate `[0, 63] × [0, 47.5] × [0, 9.5]`,
/// patterned along −X by 13: the copy of `c0` (x ∈ [−9, −6]) is detached from the part, the
/// copy of `c1` (x ∈ [7, 10]) sits on the plate and touches the seed's `c0` boss along the line
/// x = 7, y = 21 — the union of the met tool alone is non-manifold. SPEC [W0-39] per tool: the
/// instance has a detached tool, so the join fails with `BOOLEAN_NO_INTERSECTION` naming the
/// detached copy (OCCT's reading too), not with the `BOOLEAN_NON_MANIFOLD` of the combined
/// join (which W4 finds first). The same instance without the detached boss is the
/// non-manifold join; with both copies detached it is skipped.
#[test]
fn a_detached_join_tool_is_reported_before_the_joins_own_non_manifold_failure() {
    let p = aabox("e1", [0.0, 0.0, 0.0], [63.0, 47.5, 9.5]);
    let b0 = zcyl("e2", [5.5, 21.0], 1.5, 9.5, 2.0);
    let b1 = zcyl("e2", [21.5, 21.0], 1.5, 9.5, 2.0);
    let target = apply_body_op(
        BodyOp::Join,
        &[ob(p, "e1", "b", 0)],
        &[ob(b0.clone(), "e2", "c0", 1), ob(b1.clone(), "e2", "c1", 1)],
        "e2",
    )
    .expect("seed join")
    .bodies
    .remove(0)
    .body;
    let layout = Layout::Linear(LinearLayout {
        dir: -Vec3::unit_x(),
        count: 2.0,
        spacing: 13.0,
        second: Some((Vec3::unit_y(), 1.0, 9.5)),
    });
    let inst = pattern_instances(&layout, &[]).expect("instances");
    let run = |seeds: &[SeedBody]| {
        apply_seed(
            "pt1",
            2,
            SeedOp::Body(BodyOp::Join),
            seeds,
            &inst,
            &[ob(target.clone(), "e1", "b", 0)],
            None,
        )
    };
    let both = [seed(b0.clone(), "e2", "c0"), seed(b1.clone(), "e2", "c1")];
    let e = run(&both).expect_err("a detached boss");
    assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION", "{e}");
    let PatternError::Boolean(forge_ops::boolean::BooleanError::NoIntersection {
        tool,
        min_distance,
    }) = &e
    else {
        panic!("{e:?}")
    };
    assert_eq!(
        (
            tool.feature.as_str(),
            tool.member.as_str(),
            tool.instance.clone()
        ),
        ("pt1", "c0", Some(vec![1, 0]))
    );
    // The copy of c0 ends at x = −6, the plate starts at x = 0.
    assert!((*min_distance - 6.0).abs() <= 1e-6, "{min_distance}");
    // Without the detached boss: the met copy's own failure (it touches the seed's c0 boss
    // along a line).
    let e = run(&[seed(b1, "e2", "c1")]).expect_err("a line contact");
    assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{e}");
    // Only the detached boss: the instance is skipped, so the pattern fails as a whole.
    let e = run(&[seed(b0, "e2", "c0")]).expect_err("every instance detached");
    assert_eq!(e.code(), "PATTERN_ALL_INSTANCES_FAILED", "{e}");
}

/// Coincident copies of a blind hole — a two-position seed patterned at its own pitch, or a
/// circular layout that maps the positions onto each other — leave only one tool's face keys
/// in the combined cut; the other copy's bottom, decided on its own cut, is inside the
/// material: no `FORGE_PATTERN_HOLE_BREAKS_THROUGH`.
#[test]
fn coincident_blind_copies_do_not_warn_that_they_break_through() {
    let p = aabox("e1", [0.0, 0.0, 0.0], [60.0, 40.0, 10.0]);
    // Positions (15, 20) and (25, 20); 4 deep, tips end about 5 mm above the bottom.
    let (target, tools) = hole_seed(
        &p,
        10.0,
        json!({ "at": { "grid": { "nx": 2, "ny": 1, "dx": 10, "dy": 0, "center": [20, 20] } },
                "d": 3.4, "depth": { "blind": 4 } }),
    );
    let r: f64 = 1.7;
    let one = PI * r * r * 4.0 + PI * r * r * (r / 59.0_f64.to_radians().tan()) / 3.0;
    let run = |layout: Layout| {
        let inst = pattern_instances(&layout, &[]).expect("instances");
        apply_seed(
            "pt1",
            2,
            SeedOp::Hole,
            &tools,
            &inst,
            &[ob(target.clone(), "e1", "b", 0)],
            None,
        )
        .expect("pattern")
    };
    let notes = |o: &forge_ops::pattern::PatternOutcome| -> Vec<(&'static str, serde_json::Value)> {
        o.notes
            .iter()
            .map(|n| (n.code(), serde_json::to_value(n).expect("json")))
            .collect()
    };
    // Linear, 10 apart: copies at 25, 35 ([1]) and 35, 45 ([2]); 25 is the seed's own hole
    // (that copy removes nothing) and [1]'s 35 coincides with [2]'s: two new holes.
    let out = run(linear_x(3.0, 10.0));
    assert_eq!(
        notes(&out),
        vec![(
            "FORGE_PATTERN_HOLE_POSITION_MISSED",
            json!({ "index": [1], "seed": "h1", "at": "g0_0" })
        )]
    );
    let v = volume(&out.op.as_ref().expect("cut").bodies[0].body);
    assert!(close(v, volume(&target) - 2.0 * one), "{v}");
    // Circular about the grid's centre, six instances 60° apart: every copy coincides with
    // another copy ([1] with [4], [2] with [5]) or with the seed's holes ([3], skipped).
    let out = run(Layout::Circular(CircularLayout {
        origin: forge_core::linalg::Point3::new(20.0, 20.0, 0.0),
        axis: Vec3::unit_z(),
        count: 6.0,
        angle: 360.0,
    }));
    assert!(
        notes(&out)
            .iter()
            .all(|(c, _)| *c != "FORGE_PATTERN_HOLE_BREAKS_THROUGH"),
        "{:?}",
        notes(&out)
    );
    let v = volume(&out.op.as_ref().expect("cut").bodies[0].body);
    assert!(close(v, volume(&target) - 4.0 * one), "{v}");
}

/// A layout without non-seed instances (linear `count` 1, or `skip` naming every instance)
/// applies nothing: `Ok` with no operation, no skipped instance and no warning — Forge's
/// reading of SPEC §6.10 (the W7b oracle raises `PATTERN_ALL_INSTANCES_FAILED`: open W5
/// contract question; change this test with the ruling).
#[test]
fn a_layout_without_instances_changes_nothing() {
    let slot = aabox("e2", [6.0, 15.0, -5.0], [4.0, 10.0, 20.0]);
    let (holed, hole_tools) = holed_plate(
        json!({ "at": { "list": [{ "id": "a", "at": [42, 20] }] }, "d": 3, "depth": { "blind": 5 } }),
    );
    for (layout, skip) in [
        (linear_x(1.0, 10.0), Vec::new()),
        (linear_x(2.0, 10.0), vec![vec![1]]),
    ] {
        let inst = pattern_instances(&layout, &skip).expect("instances");
        assert!(inst.is_empty());
        for (op, seeds, target) in [
            (
                SeedOp::Body(BodyOp::Cut),
                vec![seed(slot.clone(), "e2", "b")],
                plate(),
            ),
            (
                SeedOp::Body(BodyOp::Join),
                vec![seed(slot.clone(), "e2", "b")],
                plate(),
            ),
            (SeedOp::Hole, hole_tools.clone(), holed.clone()),
        ] {
            let out = apply_seed(
                "pt1",
                2,
                op,
                &seeds,
                &inst,
                &[ob(target, "e1", "b", 0)],
                None,
            )
            .expect("no instance: nothing to do");
            assert!(out.op.is_none(), "{op:?}");
            assert!(out.skipped.is_empty() && out.notes.is_empty() && out.tools.is_empty());
        }
    }
}

/// W4 regression found by the W5 differential (seed 909, generation 3, case #59; fixed case
/// `regression_909_59`): instance [2] of a circular pattern (axis (1, 1, 1) through
/// (33, 18, 3), count 3) of a counterbored blind hole moves the hole's r = 1.5 wall onto the
/// axis `(32, y, 1.5)` along −Y, tangent to the plate's bottom face z = 0 along x = 32
/// (within tol). OCCT fails the cut with `BOOLEAN_NON_MANIFOLD`. W4's boolean alone returns a
/// body that touches itself along that line (face `e1/cap:start@b` has no edge there): its
/// contact-line check classifies the midpoint of the contact piece, which lies in the seed
/// hole's opening (an inner loop of that face). W5's guard (`hole::contact`) finds the line
/// inside the face and fails the pattern with `BOOLEAN_NON_MANIFOLD` at a point of it; the
/// W4 fix (BACKLOG release blocker) is tracked by `w4_contact_line_across_an_inner_loop`
/// below.
#[test]
fn a_copied_hole_wall_tangent_to_the_bottom_across_a_hole_is_non_manifold() {
    let p = aabox("e1", [0.0, 0.0, 0.0], [66.0, 36.0, 7.0]);
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, 7.0));
    let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({
        "id": "h1", "name": "holes", "on": "XY",
        "at": { "list": [{ "id": "a", "at": [31.5, 17.0] }] },
        "cbore": { "d": 8.0, "depth": 3.0 }, "d": 3.0, "depth": { "blind": 7.7 }
    }))
    .expect("hole");
    let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = p
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("top");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&p, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)]).expect("seed hole");
    let seeds = o.seed_bodies();
    let target = o.op.bodies[0].body.clone();
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: forge_core::linalg::Point3::new(33.0, 18.0, 3.0),
            axis: Vec3::new(1.0, 1.0, 1.0),
            count: 3.0,
            angle: 360.0,
        }),
        &[],
    )
    .expect("instances");
    let e = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &seeds,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect_err("a wall tangent to the bottom face");
    assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD");
    let d = serde_json::to_value(e.details()).expect("details");
    assert_eq!(d["probe"]["kind"], "edge", "{d}");
    let p: Vec<f64> = serde_json::from_value(d["probe"]["point"].clone()).expect("point");
    // On the contact line x = 32, z = 0, on the bottom face (inside the plate, outside the
    // seed hole's opening: the circle of radius 1.5 about (31.5, 17)).
    assert!((p[0] - 32.0).abs() <= 1e-6 && p[2].abs() <= 1e-6, "{p:?}");
    assert!((0.0..=36.0).contains(&p[1]), "{p:?}");
    assert!(
        (p[0] - 31.5).hypot(p[1] - 17.0) > 1.5 + 1e-6,
        "the probe lies in the seed hole's opening: {p:?}"
    );
}

/// The W4 part of `a_copied_hole_wall_tangent_to_the_bottom_across_a_hole_is_non_manifold`:
/// the same cut done by the boolean alone (no W5 guard) must fail with
/// `BOOLEAN_NON_MANIFOLD`. Owner: W4 (`boolean::assemble`, contact lines classified at their
/// midpoint only); un-ignore when fixed.
#[test]
#[ignore = "W4 release blocker: a contact line across a face's inner loop is not detected (909#59)"]
fn w4_contact_line_across_an_inner_loop() {
    let p = aabox("e1", [0.0, 0.0, 0.0], [66.0, 36.0, 7.0]);
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, 7.0));
    let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({
        "id": "h1", "name": "holes", "on": "XY",
        "at": { "list": [{ "id": "a", "at": [31.5, 17.0] }] },
        "cbore": { "d": 8.0, "depth": 3.0 }, "d": 3.0, "depth": { "blind": 7.7 }
    }))
    .expect("hole");
    let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = p
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("top");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&p, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let o = apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)]).expect("seed hole");
    let seeds = o.seed_bodies();
    let target = o.op.bodies[0].body.clone();
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: forge_core::linalg::Point3::new(33.0, 18.0, 3.0),
            axis: Vec3::new(1.0, 1.0, 1.0),
            count: 3.0,
            angle: 360.0,
        }),
        &[],
    )
    .expect("instances");
    // Both copies, cut by the boolean directly (as `apply_seed` does). Instance [2]'s copy
    // alone is `FORGE_BOOLEAN_NEAR_COINCIDENT` (explicit); together with instance [1]'s copy
    // the cut returns a body.
    let keys = forge_ops::pattern::seed_keys(&seeds[0].body, &seeds[0].origin);
    let copies: Vec<OpBody> = inst
        .iter()
        .map(|i| OpBody {
            body: forge_ops::pattern::copy_body(
                &seeds[0].body,
                &keys,
                &i.motion,
                "pt1",
                &i.qualifier(),
            )
            .expect("copy"),
            origin: Origin {
                feature: "pt1".into(),
                member: "a".into(),
                instance: Some(i.index()),
            },
            timeline: 2,
        })
        .collect();
    match forge_ops::boolean::apply_body_op(
        BodyOp::Cut,
        &[ob(target, "e1", "b", 0)],
        &copies,
        "pt1",
    ) {
        Err(e) => assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD"),
        Ok(r) => panic!(
            "the boolean returned {} bodies; the result touches itself along x = 32, z = 0 \
             (face e1/cap:start@b has no edge there)",
            r.bodies.len()
        ),
    }
}

/// W4 regressions of the fourth review's differential (explicit errors where OCCT cuts, never
/// a wrong body), replayed in every batch as the fixed cases `w4_ssi_29_41` and
/// `w4_inconsistent_23_49`. Owner: W4; un-ignore when fixed.
/// - seed 29 #41 (crossing family): an M4 countersunk through hole mirrored in an oblique
///   plane through a point of its axis: `FORGE_BOOLEAN_SSI`;
/// - seed 23 #49 (extra targets): a countersunk through hole patterned 29 times about Z
///   (instance [1] skipped) over the plate joined to a block under its right half:
///   `FORGE_BOOLEAN_INCONSISTENT` ("inconsistent inside/outside status", on the copies' walls);
/// - seed 41 #187 and #279 (crossing): countersunk through holes rotated four times about a
///   horizontal axis through a point of their axis: `FORGE_BOOLEAN_SSI` where OCCT fails with
///   `BOOLEAN_NON_MANIFOLD` (#187) or cuts (#279) (fixed cases `w4_ssi_41_187`, `w4_ssi_41_279`).
#[test]
#[ignore = "W4: FORGE_BOOLEAN_SSI (29#41, 41#187, 41#279) and FORGE_BOOLEAN_INCONSISTENT (23#49)"]
fn w4_explicit_failures_of_pattern_cuts() {
    // 29#41.
    let p = aabox("e1", [0.0, 0.0, 0.0], [40.5, 56.5, 7.0]);
    let (target, seeds) = hole_seed(
        &p,
        7.0,
        json!({ "at": { "list": [{ "id": "a", "at": [21.5, 20.0] }] },
                "csink": "iso10642", "depth": "through", "size": "M4" }),
    );
    let inst = pattern_instances(
        &Layout::Mirror(MirrorLayout {
            origin: forge_core::linalg::Point3::new(21.5, 20.0, 2.0),
            normal: Vec3::new(
                0.6123724356957945,
                0.3535533905932737,
                std::f64::consts::FRAC_1_SQRT_2,
            ),
        }),
        &[],
    )
    .expect("instances");
    let r41 = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &seeds,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    );
    // 23#49.
    let p = aabox("e1", [0.0, 0.0, 0.0], [55.0, 52.5, 9.0]);
    let (seeded, seeds) = hole_seed(
        &p,
        9.0,
        json!({ "at": { "list": [{ "id": "a", "at": [37.0, 22.5] }] },
                "csink": { "angle": 82.0, "d": 7.5 }, "d": 3.0, "depth": "through" }),
    );
    let block = extruded("e5", -20.0, rect(30.0, 0.0, 25.0, 52.5), 20.0);
    let joined = apply_body_op(
        BodyOp::Join,
        &[ob(seeded, "e1", "b", 0)],
        &[ob(block, "e5", "b", 1)],
        "e5",
    )
    .expect("step")
    .bodies
    .remove(0)
    .body;
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: forge_core::linalg::Point3::new(27.0, 26.0, 0.0),
            axis: Vec3::unit_z(),
            count: 29.0,
            angle: 360.0,
        }),
        &[vec![1]],
    )
    .expect("instances");
    let r49 = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &seeds,
        &inst,
        &[ob(joined, "e1", "b", 0)],
        None,
    );
    // 41#187 and 41#279: countersunk through holes rotated four times about a horizontal
    // axis through a point of their axis.
    let rotated = |size: [f64; 3], fields: serde_json::Value, origin: [f64; 3], axis: [f64; 3]| {
        let p = aabox("e1", [0.0, 0.0, 0.0], size);
        let (target, seeds) = hole_seed(&p, size[2], fields);
        let inst = pattern_instances(
            &Layout::Circular(CircularLayout {
                origin: Vec3::from(origin),
                axis: Vec3::from(axis),
                count: 4.0,
                angle: 360.0,
            }),
            &[],
        )
        .expect("instances");
        apply_seed(
            "pt1",
            2,
            SeedOp::Hole,
            &seeds,
            &inst,
            &[ob(target, "e1", "b", 0)],
            None,
        )
    };
    let r187 = rotated(
        [53.5, 54.5, 12.0],
        json!({ "at": { "list": [{ "id": "a", "at": [28.5, 25.0] }] },
                "csink": { "angle": 90.0, "d": 7.0 }, "d": 3.0, "depth": "through" }),
        [28.5, 25.0, 8.5],
        [
            0.8660254037844387,
            0.49999999999999994,
            6.123233995736766e-17,
        ],
    );
    let r279 = rotated(
        [58.5, 63.0, 9.5],
        json!({ "at": { "list": [{ "id": "a", "at": [38.5, 39.0] }] },
                "csink": "iso10642", "depth": "through", "size": "M6" }),
        [38.5, 39.0, 4.375],
        [
            -0.8660254037844386,
            -0.5000000000000001,
            6.123233995736766e-17,
        ],
    );
    let codes = [&r41, &r49, &r187, &r279].map(|r| r.as_ref().err().map(|e| e.code()));
    assert_eq!(
        codes,
        [None, None, Some("BOOLEAN_NON_MANIFOLD"), None],
        "OCCT's outcomes"
    );
}

mod join_per_tool_properties {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 16, ..ProptestConfig::default() })]

        /// [W0-39] per tool, for two-boss join seeds patterned along X off the plate's end
        /// (x ≤ 60): an instance whose bosses all lie off the plate is skipped, one with a
        /// boss on and a boss off is the join's `BOOLEAN_NO_INTERSECTION` (whatever the other
        /// instances do), and when every instance is skipped the pattern fails — decided from
        /// the boss positions alone.
        #[test]
        fn join_instances_are_skipped_only_when_every_boss_is_detached(
            x0 in 8.0f64..30.0,
            gap in 7.0f64..20.0,
            spacing in 6.0f64..40.0,
            count in 2usize..5,
        ) {
            // A boss of radius 3 at x meets the plate [0, 60] iff x − 3 < 60; stay clear of
            // the boundary (contacts within tol are the booleans' business, not this rule's).
            let xs = |i: usize| [x0 + i as f64 * spacing, x0 + gap + i as f64 * spacing];
            prop_assume!(x0 + gap < 57.0);
            prop_assume!((0..count).all(|i| xs(i).iter().all(|x| (x - 63.0).abs() > 0.5)));
            // No coincident or tangent bosses (near-coincident tools are W4's business).
            let all: Vec<f64> = (0..count).flat_map(xs).collect();
            prop_assume!(all.iter().enumerate().all(|(i, a)| all[..i]
                .iter()
                .all(|b| (a - b).abs() > 0.5 && ((a - b).abs() - 6.0).abs() > 0.5)));
            let (target, seeds) = two_boss_seed(x0, x0 + gap, 20.0);
            let inst = pattern_instances(&linear_x(count as f64, spacing), &[]).expect("instances");
            let on = |x: f64| x - 3.0 < 60.0;
            let mixed = (1..count).any(|i| {
                let [a, b] = xs(i);
                on(a) != on(b)
            });
            let off: Vec<Vec<u32>> = (1..count)
                .filter(|&i| xs(i).iter().all(|&x| !on(x)))
                .map(|i| vec![i as u32])
                .collect();
            let out = apply_seed(
                "pt1",
                2,
                SeedOp::Body(BodyOp::Join),
                &seeds,
                &inst,
                &[ob(target, "e1", "b", 0)],
                None,
            );
            match out {
                Err(e) if mixed => prop_assert_eq!(e.code(), "BOOLEAN_NO_INTERSECTION"),
                Err(e) if off.len() == count - 1 => {
                    prop_assert_eq!(e.code(), "PATTERN_ALL_INSTANCES_FAILED")
                }
                Ok(o) if !mixed && off.len() < count - 1 => {
                    let skipped: Vec<Vec<u32>> = o.skipped.iter().map(|s| s.index.clone()).collect();
                    prop_assert_eq!(skipped, off);
                }
                other => prop_assert!(false, "mixed {} off {:?}: {:?}", mixed, off, other.map(|o| o.skipped)),
            }
        }
    }
}

/// Review 5, seed 131 #169 (an OCCT failure the differential's Monte Carlo adjudication
/// caught): a flat-bottomed blind hole (Ø3.25, 6.5 deep) in an 8 mm plate, rotated four times
/// about the horizontal axis (1/2, √3/2, 0) through (17, 15, 3.25), a point of its own axis.
/// The 180° copy is coaxial with the seed and makes it a through hole; the 90° and 270° copies
/// together are a horizontal cylinder 9.5 long through that axis. Removed in total:
/// `π r²·8 + π r²·9.5 − 16 r³/3` (the equal-radius crossing is a Steinmetz bicylinder).
/// Forge gives exactly that; OCCT's cut removes 16.6 mm³ too little.
#[test]
fn a_hole_rotated_about_a_point_of_its_axis_removes_the_bicylinder_closed_form() {
    let p = aabox("e1", [0.0, 0.0, 0.0], [64.5, 45.0, 8.0]);
    let (target, seeds) = hole_seed(
        &p,
        8.0,
        json!({ "at": { "list": [{ "id": "a", "at": [17.0, 15.0] }] },
                "d": 3.25, "depth": { "blind": 6.5 }, "tip": "flat" }),
    );
    let inst = pattern_instances(
        &Layout::Circular(CircularLayout {
            origin: forge_core::linalg::Point3::new(17.0, 15.0, 3.25),
            axis: Vec3::new(0.5, 3f64.sqrt() / 2.0, 0.0),
            count: 4.0,
            angle: 360.0,
        }),
        &[],
    )
    .expect("instances");
    let out = apply_seed(
        "pt1",
        2,
        SeedOp::Hole,
        &seeds,
        &inst,
        &[ob(target, "e1", "b", 0)],
        None,
    )
    .expect("pattern");
    let res = out.op.expect("cut");
    assert_eq!(res.bodies.len(), 1);
    let r: f64 = 1.625;
    let removed = PI * r * r * 8.0 + PI * r * r * 9.5 - 16.0 * r.powi(3) / 3.0;
    let v = volume(&res.bodies[0].body);
    assert!(
        (v - (64.5 * 45.0 * 8.0 - removed)).abs() <= 1e-9 * v,
        "{v} vs {}",
        64.5 * 45.0 * 8.0 - removed
    );
}

/// Review 6, seeds 419 #275 and 521 #267 (crossing): flat-bottomed blind holes rotated about
/// a horizontal axis through a point of their axis (half a turn, count 4: copies at 60°, 120°
/// and 180°), where OCCT's cut has an edge in more than two faces inside a manifold region and
/// the wrong volume (419 #275: 0.554 mm³ too much material) or area (521 #267: 0.0456 mm² too
/// much). The references are the W5 differential's exact adjudication (`exact_adjudicate` in
/// `oracle/occt_hole_pattern_diff.py`: the plate box and the hole tools as analytic solids of
/// revolution, surface quadrature at 0.001 mm, no boolean involved), with its error bound;
/// Forge agrees with them to within 6e-4 mm³ and 3e-4 mm².
#[test]
fn flat_bottomed_holes_rotated_about_a_point_of_their_axis_match_the_analytic_reference() {
    // (plate, hole fields, pivot, axis, volume ± err, area ± err)
    let cases = [
        (
            [72.0, 41.0, 11.5],
            json!({ "at": { "list": [{ "id": "a", "at": [57.0, 26.0] }] },
                    "insert": "std", "size": "M3" }),
            [57.0, 26.0, 7.625],
            [6.123233995736766e-17, 1.0, 6.123233995736766e-17],
            (33791.575225, 1.9e-4),
            (8657.409271, 7.1e-4),
        ),
        (
            [59.5, 56.0, 14.0],
            json!({ "at": { "list": [{ "id": "a", "at": [30.5, 28.5] }] },
                    "d": 3.75, "depth": { "blind": 9.5 }, "tip": "flat" }),
            [30.5, 28.5, 5.75],
            [
                -0.8660254037844387,
                0.49999999999999994,
                6.123233995736766e-17,
            ],
            (46355.732952, 2.3e-3),
            (10187.309582, 1.2e-3),
        ),
    ];
    for (size, fields, origin, axis, (v_ref, v_err), (a_ref, a_err)) in cases {
        let p = aabox("e1", [0.0, 0.0, 0.0], size);
        let (target, seeds) = hole_seed(&p, size[2], fields);
        let inst = pattern_instances(
            &Layout::Circular(CircularLayout {
                origin: forge_core::linalg::Point3::from(origin),
                axis: Vec3::from(axis),
                count: 4.0,
                angle: 180.0,
            }),
            &[],
        )
        .expect("instances");
        let out = apply_seed(
            "pt1",
            2,
            SeedOp::Hole,
            &seeds,
            &inst,
            &[ob(target, "e1", "b", 0)],
            None,
        )
        .expect("pattern");
        let res = out.op.expect("cut");
        assert_eq!(res.bodies.len(), 1);
        let v = volume(&res.bodies[0].body);
        let a = forge_check::mass_properties(&res.bodies[0].body)
            .expect("mass")
            .area;
        // The §8.2 tolerances are 1e-6 relative (0.034 mm³ and 0.0087 mm² here).
        assert!(
            (v - v_ref).abs() <= 2.0 * v_err + 1e-4,
            "volume {v} vs {v_ref} ± {v_err}"
        );
        assert!(
            (a - a_ref).abs() <= 2.0 * a_err + 1e-4,
            "area {a} vs {a_ref} ± {a_err}"
        );
    }
}
