//! The tangent-contact guard of holes and patterns (`forge_ops::hole::tool_contact`, module
//! `hole::contact`): a tool lying along a planar face of the result across that face's
//! interior makes the correct result touch itself (`BOOLEAN_NON_MANIFOLD`, SPEC §6.0.3); the
//! guard catches the contact lines W4's check misses (a line across an inner loop of the face,
//! W5 differential case `regression_909_59`).

use forge_core::geom::Surface;
use forge_core::linalg::{Frame, Point3, Transform, Vec3};
use forge_core::topo::{Body, FaceId};
use forge_ir::v1::EntityKind;
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};
use forge_ops::hole::{
    HoleSite, apply_hole, hole_positions, hole_spec, literal_hole, tool_contact,
};
use forge_ops::pattern::{
    Layout, LinearLayout, Motion, SeedBody, SeedOp, apply_seed, move_body, pattern_instances,
};
use serde_json::json;

const TOL: f64 = 1e-6;

fn extruded(
    feature: &str,
    origin: [f64; 3],
    normal: [f64; 3],
    x_dir: [f64; 3],
    curves: Vec<SketchCurve>,
    h: f64,
) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(IrFrame {
                origin,
                normal,
                x_dir,
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

fn circle(c: [f64; 2], r: f64) -> Vec<SketchCurve> {
    vec![SketchCurve::Circle {
        id: "c".into(),
        center: c,
        radius: r,
    }]
}

/// The plate [0, 66] × [0, 36] × [0, 7].
fn plate() -> Body {
    extruded(
        "e1",
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        rect(0.0, 0.0, 66.0, 36.0),
        7.0,
    )
}

/// A cylinder of radius `r` on the axis `(x, y, z)`, `y ∈ [y0, y1]` (along +Y).
fn ycyl(x: f64, z: f64, r: f64, y0: f64, y1: f64) -> Body {
    // Sketch x = world X, sketch y = normal × x = −Z.
    extruded(
        "t1",
        [0.0, y0, 0.0],
        [0.0, 1.0, 0.0],
        [1.0, 0.0, 0.0],
        circle([x, -z], r),
        y1 - y0,
    )
}

/// A cylinder of radius `r` on the axis `(x, y, z)`, `x ∈ [x0, x1]` (along +X).
fn xcyl(y: f64, z: f64, r: f64, x0: f64, x1: f64) -> Body {
    // Sketch x = world Y, sketch y = normal × x = +Z.
    extruded(
        "t1",
        [x0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        circle([y, z], r),
        x1 - x0,
    )
}

fn ob(body: Body, feature: &str, member: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: member.into(),
            instance: None,
        },
        timeline,
    }
}

/// The plate minus vertical through cuts of `curves` (at z from −1 to 8).
fn plate_minus(curves: Vec<SketchCurve>) -> Body {
    let tool = extruded(
        "e2",
        [0.0, 0.0, -1.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        curves,
        9.0,
    );
    let mut r = apply_body_op(
        BodyOp::Cut,
        &[ob(plate(), "e1", "b", 0)],
        &[ob(tool, "e2", "b", 1)],
        "e2",
    )
    .expect("opening");
    assert_eq!(r.bodies.len(), 1);
    r.bodies.remove(0).body
}

fn moved(b: &Body, m: &Motion) -> Body {
    move_body(b, m, |_, p| p.clone()).expect("move")
}

/// The planar face of `b` whose outward normal is `n`.
fn face_with_normal(b: &Body, n: Vec3) -> FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| match &f.surface {
            Surface::Plane(p) => {
                let m = if f.sense {
                    p.frame().z()
                } else {
                    -p.frame().z()
                };
                (m - n).norm() < 1e-12
            }
            _ => false,
        })
        .map(|(id, _)| id)
        .expect("face")
}

#[test]
fn a_tool_along_the_bottom_face_across_its_interior_is_a_contact() {
    let p = plate();
    let tool = ycyl(32.0, 1.5, 1.5, 5.0, 30.0);
    let hit = tool_contact(BodyOp::Cut, &[&p], &[&tool])
        .expect("test")
        .expect("the wall lies along the bottom face inside it");
    assert_eq!(hit.kind, EntityKind::Edge);
    let hit = hit.point;
    assert!((hit.x - 32.0).abs() <= TOL && hit.z.abs() <= TOL, "{hit:?}");
    assert!((5.0..=30.0).contains(&hit.y), "{hit:?}");
}

#[test]
fn a_contact_line_across_an_opening_is_found_outside_the_opening() {
    // The 909#59 geometry: the line x = 32 crosses a through hole of radius 1.5 about
    // (31.5, 17) (an inner loop of the bottom face), with its midpoint in the opening.
    let p = plate_minus(circle([31.5, 17.5], 1.5));
    let tool = ycyl(32.0, 1.5, 1.5, 5.0, 30.0);
    let hit = tool_contact(BodyOp::Cut, &[&p], &[&tool])
        .expect("test")
        .expect("the line runs inside the face on both sides of the opening")
        .point;
    assert!((hit.x - 32.0).abs() <= TOL && hit.z.abs() <= TOL, "{hit:?}");
    assert!(
        (hit.x - 31.5).hypot(hit.y - 17.5) > 1.5 + TOL,
        "a point in the opening: {hit:?}"
    );
}

#[test]
fn a_contact_line_inside_an_opening_or_on_the_boundary_is_no_contact() {
    // A through slot x ∈ [30, 34] over the tool's whole axial range: the line is off the face.
    let slotted = plate_minus(rect(30.0, 3.0, 4.0, 30.0));
    let tool = ycyl(32.0, 1.5, 1.5, 5.0, 30.0);
    assert_eq!(
        tool_contact(BodyOp::Cut, &[&slotted], &[&tool]).expect("test"),
        None
    );
    // A tool along the bottom face's front edge y = 0: the line is the face's boundary.
    let p = plate();
    let edge = xcyl(0.0, 1.5, 1.5, 10.0, 50.0);
    assert_eq!(
        tool_contact(BodyOp::Cut, &[&p], &[&edge]).expect("test"),
        None
    );
}

#[test]
fn only_a_tool_on_the_conflicting_side_within_tol_is_a_contact() {
    let p = plate();
    let at = |z: f64| ycyl(32.0, z, 1.5, 5.0, 30.0);
    let contact = |op: BodyOp, z: f64| tool_contact(op, &[&p], &[&at(z)]).expect("test").is_some();
    // Inside the material, tangent (cut: the material's side).
    assert!(contact(BodyOp::Cut, 1.5));
    assert!(contact(BodyOp::Cut, 1.5 + 0.9e-6));
    assert!(contact(BodyOp::Cut, 1.5 - 0.9e-6));
    // A sliver of 2e-6 mm under the tool is real material; a tool 2e-6 into the face cuts a
    // real slot.
    assert!(!contact(BodyOp::Cut, 1.5 + 2e-6));
    assert!(!contact(BodyOp::Cut, 1.5 - 2e-6));
    // Below the plate, touching the bottom face from outside: a cut changes nothing there, a
    // join adds a boss that touches the plate along the line.
    assert!(!contact(BodyOp::Cut, -1.5));
    assert!(contact(BodyOp::Join, -1.5));
    assert!(!contact(BodyOp::Join, 1.5));
    // An intersect is not tested.
    assert!(!contact(BodyOp::Intersect, 1.5));
}

mod motions {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

        /// The verdict does not depend on where the part is: plate and tool moved together by
        /// a rigid motion (or a reflection) give the same verdict, decided by the tool's
        /// distance from the face alone, and the reported point lies on the moved line.
        #[test]
        fn the_verdict_is_invariant_under_motions_of_the_part(
            theta in 0.0f64..360.0,
            phi in 0.0f64..180.0,
            angle in -180.0f64..180.0,
            shift in prop::array::uniform3(-50.0f64..50.0),
            offset in prop_oneof![-0.6e-6f64..0.6e-6, 1.6e-6f64..5e-6, -5e-6f64..-1.6e-6],
            reflect in any::<bool>(),
            opening in any::<bool>(),
        ) {
            let (st, ct) = (theta.to_radians().sin(), theta.to_radians().cos());
            let (sp, cp) = (phi.to_radians().sin(), phi.to_radians().cos());
            let axis = Vec3::new(sp * ct, sp * st, cp);
            let rot = Transform::rotation_about_axis_deg(Point3::new(0.0, 0.0, 0.0), axis, angle)
                .expect("rotation");
            let m = if reflect {
                Motion::reflection(Point3::from(shift), axis).expect("mirror")
            } else {
                Motion::Rigid(rot.then(&Transform::translation(Vec3::from(shift))))
            };
            let base = if opening { plate_minus(circle([31.5, 17.5], 1.5)) } else { plate() };
            let p = moved(&base, &m);
            let tool = moved(&ycyl(32.0, 1.5 + offset, 1.5, 5.0, 30.0), &m);
            let hit = tool_contact(BodyOp::Cut, &[&p], &[&tool]).expect("test").map(|c| c.point);
            prop_assert_eq!(hit.is_some(), offset.abs() < TOL, "offset {:e}: {:?}", offset, hit);
            if let Some(h) = hit {
                // On the moved line x = 32, z = 0 (y ∈ [5, 30]).
                let a = m.point(Point3::new(32.0, 5.0, 0.0));
                let b = m.point(Point3::new(32.0, 30.0, 0.0));
                let u = (b - a) * (1.0 / 25.0);
                let t = (h - a).dot(u);
                prop_assert!((-TOL..=25.0 + TOL).contains(&t), "{:?}", h);
                prop_assert!((a + u * t).distance(h) <= 2.0 * TOL, "{:?}", h);
            }
        }

        /// The apex test is invariant too: an M3 drill point whose apex lies `above` the
        /// bottom face of a 40 × 40 × 10 plate (negative: under it), plate and tool moved
        /// together, touches the face (kind `vertex`, at the moved apex's foot) iff
        /// `|above| ≤ tol`.
        #[test]
        fn the_apex_verdict_is_invariant_under_motions_of_the_part(
            theta in 0.0f64..360.0,
            phi in 0.0f64..180.0,
            angle in -180.0f64..180.0,
            shift in prop::array::uniform3(-50.0f64..50.0),
            above in prop_oneof![-0.9e-6f64..0.9e-6, 1.6e-6f64..5e-6, -5e-6f64..-1.6e-6],
            reflect in any::<bool>(),
        ) {
            let (st, ct) = (theta.to_radians().sin(), theta.to_radians().cos());
            let (sp, cp) = (phi.to_radians().sin(), phi.to_radians().cos());
            let axis = Vec3::new(sp * ct, sp * st, cp);
            let rot = Transform::rotation_about_axis_deg(Point3::new(0.0, 0.0, 0.0), axis, angle)
                .expect("rotation");
            let m = if reflect {
                Motion::reflection(Point3::from(shift), axis).expect("mirror")
            } else {
                Motion::Rigid(rot.then(&Transform::translation(Vec3::from(shift))))
            };
            let plate = extruded(
                "e1",
                [0.0, 0.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
                rect(0.0, 0.0, 40.0, 40.0),
                10.0,
            );
            let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({
                "id": "h1", "name": "tip", "on": "XY",
                "at": { "list": [{ "id": "a", "at": [20.0, 20.0] }] },
                "size": "M3", "depth": { "blind": 5.0 }
            }))
            .expect("hole");
            let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
            let spec = hole_spec(&lit).expect("spec");
            let depth = 10.0 - 1.7 / 59f64.to_radians().tan() - above;
            let tool = forge_ops::hole::hole_tool(
                &spec,
                "a",
                Point3::new(20.0, 20.0, 10.0),
                -Vec3::unit_z(),
                Vec3::unit_x(),
                depth,
                false,
            )
            .expect("tool");
            let (p, t) = (moved(&plate, &m), moved(&tool, &m));
            let hit = tool_contact(BodyOp::Cut, &[&p], &[&t]).expect("test");
            prop_assert_eq!(hit.is_some(), above.abs() <= TOL, "above {:e}: {:?}", above, hit);
            if let Some(c) = hit {
                prop_assert_eq!(c.kind, EntityKind::Vertex);
                let foot = m.point(Point3::new(20.0, 20.0, 0.0));
                prop_assert!(c.point.distance(foot) <= 1e-9, "{:?} vs {:?}", c.point, foot);
            }
        }
    }
}

/// `apply_hole`: a hole drilled from the plate's front face whose wall is tangent to the
/// bottom face fails with `BOOLEAN_NON_MANIFOLD`, whether or not the contact line crosses an
/// opening of the bottom face (with the opening, W4's check alone misses it: the midpoint of
/// the contact line, y = 15, lies in the opening); 0.1 mm higher it leaves a real wall.
#[test]
fn a_hole_whose_wall_is_tangent_to_another_face_fails_as_non_manifold() {
    // The front face y = 0 (outward normal −Y): frame x = X, y = n × x = +Z.
    let frame = Frame::from_normal_x(Point3::new(0.0, 0.0, 0.0), -Vec3::unit_y(), Vec3::unit_x())
        .expect("frame");
    let run = |target: &Body, height: f64| {
        let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({
            "id": "h1", "name": "side", "on": "XY",
            "at": { "list": [{ "id": "a", "at": [32.0, height] }] },
            "d": 3.0, "depth": { "blind": 30.0 }
        }))
        .expect("hole");
        let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
        let spec = hole_spec(&lit).expect("spec");
        let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
        let front = face_with_normal(target, -Vec3::unit_y());
        let site = HoleSite {
            frame: &frame,
            flip: false,
            on_face: Some((target, front)),
            up_to: None,
            timeline: 2,
            scope_scale: None,
        };
        apply_hole(&spec, &pos, &site, &[ob(target.clone(), "e1", "b", 0)])
    };
    for target in [plate(), plate_minus(circle([31.5, 15.0], 1.5))] {
        let e = run(&target, 1.5).expect_err("a wall tangent to the bottom face");
        assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{e}");
        let ok = run(&target, 1.6).expect("a 0.1 mm wall under the hole");
        assert_eq!(ok.op.bodies.len(), 1);
    }
}

/// Review 6 (SPEC §6.0.3 [W0-41](1)): a through hole (d = 3) drilled from the top of the
/// plate `[0, 40] × [0, 40] × [0, 8]` at `(1.5 − δ, 20)`, whose wall crosses the side face
/// x = 0 by `δ` < tol across that face's interior. The part of the tool beyond the face is an
/// overlap nowhere thicker than tol — a contact, not volume — so the result touches itself
/// along the line x = 0, y = 20 (as for a wall exactly tangent to the face, and for one that
/// stays `δ` inside it): `BOOLEAN_NON_MANIFOLD` with a probe on that line, never a body with a
/// sub-tol slot in the side face.
#[test]
fn a_hole_wall_piercing_a_side_face_within_tol_is_non_manifold() {
    let p = extruded(
        "e1",
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        rect(0.0, 0.0, 40.0, 40.0),
        8.0,
    );
    let frame = Frame::from_normal_x(Point3::new(0.0, 0.0, 8.0), Vec3::unit_z(), Vec3::unit_x())
        .expect("frame");
    let top = face_with_normal(&p, Vec3::unit_z());
    for delta in [0.5e-6, 0.9e-6, 0.0, -0.5e-6, -0.9e-6] {
        let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({
            "id": "h1", "name": "edge", "on": "XY",
            "at": { "list": [{ "id": "a", "at": [1.5 - delta, 20.0] }] },
            "d": 3.0, "depth": "through"
        }))
        .expect("hole");
        let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
        let spec = hole_spec(&lit).expect("spec");
        let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
        let site = HoleSite {
            frame: &frame,
            flip: false,
            on_face: Some((&p, top)),
            up_to: None,
            timeline: 2,
            scope_scale: None,
        };
        let e = apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)])
            .expect_err("a wall within tol of the side face");
        assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "δ = {delta:e}: {e}");
        let d = serde_json::to_value(e.details()).expect("details");
        let q = &d["probe"]["point"];
        let q = [0, 1, 2].map(|k| q[k].as_f64().expect("probe point"));
        assert!(
            q[0].abs() <= 2.0 * TOL && (q[1] - 20.0).abs() <= 2.0 * TOL,
            "δ = {delta:e}: probe {q:?} off the line x = 0, y = 20"
        );
        assert!((-TOL..=8.0 + TOL).contains(&q[2]), "δ = {delta:e}: {q:?}");
    }
}

/// Review 5 (a false `BOOLEAN_NON_MANIFOLD` of the guard): a rod (radius 2, axis `y = 15`,
/// `z = 12`, `x ∈ [15, 55]`) whose bottom a notch removed over `x ∈ [15, 40]` (notch floor at
/// `z = 11`, 1 mm above the plate), with a leg joined into the notch that reaches into the
/// plate `[0, 30]² × [0, 10]`. The rod's cylinder face spans `x ∈ [15, 55]`, and its full
/// bottom ruling (at `z = 10`, on the plate's top plane) exists only over `x ∈ [40, 55]`,
/// beyond the plate. A body-seed pattern joining a copy (`y = 20`) to the plate must give the
/// plain boolean's valid body; the guard once took the whole ruling for the tool's and
/// reported the plate's top at `x ≈ 17.5` (where the notch removed the rod). With the notch
/// beyond the plate (`x ∈ [35, 60]`), the same rod does touch the plate's top along a line.
#[test]
fn a_notched_rod_joined_beside_the_plate_is_not_a_contact() {
    let plate30 = || {
        extruded(
            "e1",
            [0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            rect(0.0, 0.0, 30.0, 30.0),
            10.0,
        )
    };
    let boxed = |f: &str, lo: [f64; 3], size: [f64; 3]| {
        extruded(
            f,
            [0.0, 0.0, lo[2]],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 0.0],
            rect(lo[0], lo[1], size[0], size[1]),
            size[2],
        )
    };
    let op = |op: BodyOp, a: Body, b: Body| {
        let mut r =
            apply_body_op(op, &[ob(a, "t1", "b", 1)], &[ob(b, "n", "b", 2)], "n").expect("rod op");
        assert_eq!(r.bodies.len(), 1);
        r.bodies.remove(0).body
    };
    let rod = |notch_x0: f64| {
        let rod = xcyl(15.0, 12.0, 2.0, 15.0, 55.0);
        let notched = op(
            BodyOp::Cut,
            rod,
            boxed("n", [notch_x0, 12.0, 9.0], [25.0, 6.0, 2.0]),
        );
        op(
            BodyOp::Join,
            notched,
            boxed("n", [20.0, 14.0, 5.0], [5.0, 2.0, 6.5]),
        )
    };
    let run = |seed_body: Body| {
        let inst = pattern_instances(
            &Layout::Linear(LinearLayout {
                dir: Vec3::unit_y(),
                count: 2.0,
                spacing: 5.0,
                second: None,
            }),
            &[],
        )
        .expect("instances");
        apply_seed(
            "pt1",
            3,
            SeedOp::Body(BodyOp::Join),
            &[SeedBody {
                body: seed_body,
                origin: Origin {
                    feature: "t1".into(),
                    member: "b".into(),
                    instance: None,
                },
                keys: None,
                hole: None,
            }],
            &inst,
            &[ob(plate30(), "e1", "b", 0)],
            None,
        )
    };
    let volume = |b: &Body| forge_check::mass_properties(b).expect("mass").volume;
    // The notch over x ∈ [15, 40]: the copy joins (the leg's 5 × 2 × 5 mm³ inside the plate).
    let notched = rod(15.0);
    let out = run(notched.clone()).expect("a valid join: the notch removed the rod's bottom");
    let res = out.op.expect("join");
    assert_eq!(res.bodies.len(), 1);
    let issues = forge_check::validate(&res.bodies[0].body);
    assert!(
        issues
            .iter()
            .all(|i| i.severity != forge_core::topo::Severity::Error),
        "{issues:?}"
    );
    let expected = 9000.0 + volume(&notched) - 50.0;
    let v = volume(&res.bodies[0].body);
    assert!((v - expected).abs() <= 1e-9 * expected, "{v} vs {expected}");
    // The plain boolean agrees (no guard there).
    let moved_copy = moved(
        &notched,
        &Motion::Rigid(Transform::translation(Vec3::new(0.0, 5.0, 0.0))),
    );
    let plain = apply_body_op(
        BodyOp::Join,
        &[ob(plate30(), "e1", "b", 0)],
        &[ob(moved_copy, "pt1", "b", 3)],
        "pt1",
    )
    .expect("plain join");
    assert!((volume(&plain.bodies[0].body) - expected).abs() <= 1e-9 * expected);
    // The notch beyond the plate (x ∈ [35, 60]): the full rod's bottom lies along the plate's
    // top over x ∈ [15, 30] — a contact line.
    let e = run(rod(35.0)).expect_err("the rod touches the plate's top along a line");
    assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{e}");
    let d = serde_json::to_value(e.details()).expect("details");
    assert_eq!(d["probe"]["kind"], "edge", "{d}");
}

/// Review 5: an M3 (Ø3.4) blind hole whose drill-point apex lands `off` above the far face of a
/// 40 × 40 × 10 plate (depth `10 − 1.7 / tan 59° − off`). Exactly on the face the result
/// touches itself at the apex (W4: `BOOLEAN_NON_MANIFOLD`, vertex); by [R-3] an apex within
/// tol of the face lies on it, so 0.5e-6 mm above it is the same failure (the guard's apex
/// test), never a body without a warning; 1.5e-6 mm above it is a real web: a body, no
/// warning. (Below the face by 0.5e-6 mm W4 fails explicitly, `FORGE_BOOLEAN_INCONSISTENT`:
/// `w4_a_drill_point_just_through_the_far_face` in `hole_apply.rs`.)
#[test]
fn a_drill_point_within_tol_of_the_far_face_touches_it() {
    let p = extruded(
        "e1",
        [0.0, 0.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 0.0],
        rect(0.0, 0.0, 40.0, 40.0),
        10.0,
    );
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, 10.0));
    let top = face_with_normal(&p, Vec3::unit_z());
    let run = |above: f64| {
        let depth = 10.0 - 1.7 / 59f64.to_radians().tan() - above;
        let h: forge_ir::v1::HoleFeature = serde_json::from_value(json!({
            "id": "h1", "name": "tip",  "on": "XY",
            "at": { "list": [{ "id": "a", "at": [20.0, 20.0] }] },
            "size": "M3", "depth": { "blind": depth }
        }))
        .expect("hole");
        let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
        let spec = hole_spec(&lit).expect("spec");
        let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
        let site = HoleSite {
            frame: &frame,
            flip: false,
            on_face: Some((&p, top)),
            up_to: None,
            timeline: 1,
            scope_scale: None,
        };
        apply_hole(&spec, &pos, &site, &[ob(p.clone(), "e1", "b", 0)])
    };
    for above in [0.0, 0.5e-6, 0.9e-6] {
        let e = run(above).expect_err("the apex touches the far face");
        assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{above:e}: {e}");
        let d = serde_json::to_value(e.details()).expect("details");
        assert_eq!(d["probe"]["kind"], "vertex", "{above:e}: {d}");
        let q: Vec<f64> = serde_json::from_value(d["probe"]["point"].clone()).expect("point");
        assert!(
            (q[0] - 20.0).abs() <= 2.0 * TOL
                && (q[1] - 20.0).abs() <= 2.0 * TOL
                && q[2].abs() <= TOL,
            "{above:e}: {q:?}"
        );
    }
    let ok = run(1.5e-6).expect("a 1.5e-6 mm web under the apex");
    assert_eq!(ok.op.bodies.len(), 1);
    assert!(ok.notes.is_empty(), "{:?}", ok.notes);
}
