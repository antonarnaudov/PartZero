//! Shells against closed forms (and the OCCT values of `BRepOffsetAPI_MakeThickSolid` with
//! intersection joins on the same bodies).

mod common;

use common::*;
use forge_blend::{BlendError, ShellDirection, ShellLimitReason, ShellOptions, shell};
use forge_core::math::PI;

fn opts() -> ShellOptions {
    ShellOptions::new("sh1")
}

#[test]
fn an_open_box_shells_inward_and_outward() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let top = face_near(&b, [5.0, 10.0, 30.0]);
    let out = shell(&b, &fs(&b, &[top]), 1.0, ShellDirection::Inward, &opts()).expect("inward");
    assert_valid(&out.body);
    assert!(
        rel(volume(&out.body), 1824.0) < 1e-11,
        "{}",
        volume(&out.body)
    );
    let m = forge_check::body_metrics(&out.body).unwrap();
    assert_eq!((m.faces, m.edges), (11, 24));
    assert_eq!(out.report.removed_faces.len(), 1);
    let out = shell(&b, &fs(&b, &[top]), 1.0, ShellDirection::Outward, &opts()).expect("outward");
    assert_valid(&out.body);
    assert!(
        rel(volume(&out.body), 2184.0) < 1e-11,
        "{}",
        volume(&out.body)
    );
    let keys: Vec<String> = out
        .body
        .faces()
        .iter()
        .map(|(_, f)| f.provenance.key())
        .collect();
    assert!(keys.iter().any(|k| k.starts_with("sh1/rim:{")), "{keys:?}");
    assert!(
        keys.iter().any(|k| k.starts_with("sh1/offset:{")),
        "{keys:?}"
    );
}

#[test]
fn a_closed_body_gets_an_internal_void() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let out = shell(&b, &fs(&b, &[]), 1.0, ShellDirection::Inward, &opts()).expect("void");
    assert_valid(&out.body);
    assert!(out.report.closed_void);
    assert_eq!(out.body.shell_ids().len(), 2);
    assert!(rel(volume(&out.body), 6000.0 - 8.0 * 18.0 * 28.0) < 1e-11);
}

#[test]
fn through_holes_become_tubes() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let hole = zcyl("e2", [20.0, 15.0], -1.0, 4.0, 8.0);
    let b = cut(plate, hole, "c1");
    let top = face_near(&b, [5.0, 5.0, 6.0]);
    let t = 1.0;
    let out = shell(&b, &fs(&b, &[top]), t, ShellDirection::Inward, &opts()).expect("shell");
    assert_valid(&out.body);
    // Cavity: (40−2t)×(30−2t)×(6−t) minus the tube of radius 4+t.
    let cavity =
        (40.0 - 2.0 * t) * (30.0 - 2.0 * t) * (6.0 - t) - PI * (4.0 + t) * (4.0 + t) * (6.0 - t);
    let expect = volume(&b) - cavity;
    assert!(
        rel(volume(&out.body), expect) < 1e-11,
        "{} vs {expect}",
        volume(&out.body)
    );
}

#[test]
fn a_boss_plate_opened_underneath_hollows_the_boss() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 5.0]);
    let boss = zcyl("e2", [20.0, 15.0], 5.0, 6.0, 10.0);
    let b = join(plate, boss, "j1");
    let bottom = face_near(&b, [5.0, 5.0, 0.0]);
    let t = 1.5;
    let out = shell(&b, &fs(&b, &[bottom]), t, ShellDirection::Inward, &opts()).expect("shell");
    assert_valid(&out.body);
    let cavity =
        (40.0 - 2.0 * t) * (30.0 - 2.0 * t) * (5.0 - t) + PI * (6.0 - t) * (6.0 - t) * 10.0;
    let expect = volume(&b) - cavity;
    assert!(
        rel(volume(&out.body), expect) < 1e-11,
        "{} vs {expect}",
        volume(&out.body)
    );
}

#[test]
fn slots_through_the_open_face_get_walls() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]);
    let tool = prism("e2", -1.0, slot([20.0, 15.0], 10.0, 3.0), 8.0);
    let b = cut(plate, tool, "c1");
    let top = face_near(&b, [5.0, 5.0, 6.0]);
    let t = 1.0;
    let out = shell(&b, &fs(&b, &[top]), t, ShellDirection::Inward, &opts()).expect("shell");
    assert_valid(&out.body);
    let slot_area = |r: f64| 10.0 * 2.0 * r + PI * r * r;
    let cavity = ((40.0 - 2.0 * t) * (30.0 - 2.0 * t) - slot_area(3.0 + t)) * (6.0 - t);
    let expect = volume(&b) - cavity;
    assert!(
        rel(volume(&out.body), expect) < 1e-11,
        "{} vs {expect}",
        volume(&out.body)
    );
}

#[test]
fn a_thickness_above_half_the_width_reports_the_feasible_range() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let top = face_near(&b, [5.0, 10.0, 30.0]);
    let err =
        shell(&b, &fs(&b, &[top]), 6.0, ShellDirection::Inward, &opts()).expect_err("too thick");
    let BlendError::ThicknessTooLarge {
        max_feasible_thickness,
        limits,
        ..
    } = &err
    else {
        panic!("{} {err}", err.code());
    };
    let max = max_feasible_thickness.expect("found");
    assert!((4.99..5.0).contains(&max), "{max}");
    assert!(limits.iter().all(|l| l.reason == ShellLimitReason::Gap));
    shell(&b, &fs(&b, &[top]), max, ShellDirection::Inward, &opts()).expect("max works");
    let e = shell(
        &b,
        &fs(&b, &[top]),
        1.01 * max,
        ShellDirection::Inward,
        &opts(),
    )
    .expect_err("above");
    assert_eq!(e.code(), "SHELL_THICKNESS_TOO_LARGE");
}

#[test]
fn a_tube_wall_is_limited_by_curvature() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 5.0]);
    let boss = zcyl("e2", [20.0, 15.0], 5.0, 2.0, 10.0);
    let b = join(plate, boss, "j1");
    let bottom = face_near(&b, [5.0, 5.0, 0.0]);
    let err =
        shell(&b, &fs(&b, &[bottom]), 2.5, ShellDirection::Inward, &opts()).expect_err("too thick");
    assert_eq!(err.code(), "SHELL_THICKNESS_TOO_LARGE", "{err}");
    let d = err.details();
    assert!(d["max_feasible_thickness"].as_f64().unwrap() < 2.0);
}

/// W6 review round 3: a planar face used up by its neighbours' offsets (a 1 mm chamfer's
/// 1.414 mm bevel between a box's top and front, gone at t = 1.707) is neither an offset
/// surface degenerating nor opposite walls colliding (SPEC §6.8): `SHELL_FAILED` naming the
/// bevel, not `SHELL_THICKNESS_TOO_LARGE` naming walls 40 mm apart. Below that thickness the
/// shell builds (OCCT's `MakeThickSolidByJoin` agrees on the volume at t = 1 and fails at
/// t = 2 too).
#[test]
fn a_face_used_up_by_the_offset_is_named_as_a_shell_failure() {
    use forge_blend::{BlendOptions, ChamferSpec, chamfer};
    let b0 = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 20.0]);
    let e = edge_near(&b0, [20.0, 0.0, 20.0]);
    let b = chamfer(
        &b0,
        &es(&b0, &[e]),
        &ChamferSpec::Equal { d: 1.0 },
        &BlendOptions::new("c1"),
    )
    .expect("chamfer")
    .body;
    let bottom = face_near(&b, [20.0, 15.0, 0.0]);
    let err = shell(&b, &fs(&b, &[bottom]), 2.0, ShellDirection::Inward, &opts())
        .expect_err("the bevel vanishes");
    assert_eq!(err.code(), "SHELL_FAILED", "{err}");
    let BlendError::ShellFailed { reason } = &err else {
        unreachable!()
    };
    assert!(reason.contains("c1/bevel:"), "names the bevel: {reason}");
    assert!(
        reason.contains("1.707"),
        "the thickness it vanishes at: {reason}"
    );
    let out = shell(&b, &fs(&b, &[bottom]), 1.0, ShellDirection::Inward, &opts()).expect("t = 1");
    assert_valid(&out.body);
    assert!(
        rel(volume(&out.body), 3767.2598846) < 1e-9,
        "{} (OCCT: 3767.2598846)",
        volume(&out.body)
    );
}

/// W6 review round 3 (s71-0165-slot): a blind pocket opened only through the top face, which
/// also bounds the outer walls — without the top the pocket's walls and floor are a separate
/// piece of the surface, and the shell would be two solids. Forge built one shell of Euler
/// characteristic 4 and failed its validation; it now says why, before building.
#[test]
fn a_pocket_opened_through_the_top_would_split_the_shell() {
    let plate = aabox("e1", [0.0, 0.0, 0.0], [54.0, 26.0, 4.0]);
    let pocket = prism("e2", 2.0, slot([27.0, 13.0], 4.5, 3.5), 3.0);
    let b = cut(plate, pocket, "c1");
    let top = face_near(&b, [5.0, 5.0, 4.0]);
    for dir in [ShellDirection::Outward, ShellDirection::Inward] {
        let err = shell(&b, &fs(&b, &[top]), 0.75, dir, &opts()).expect_err("two solids");
        assert_eq!(err.code(), "SHELL_FAILED", "{err}");
        assert!(err.to_string().contains("falls apart"), "{err}");
    }
    // A box with its top open stays one piece.
    let bx = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let t = face_near(&bx, [5.0, 10.0, 30.0]);
    shell(&bx, &fs(&bx, &[t]), 1.0, ShellDirection::Inward, &opts()).expect("one piece");
}

/// W6 review round 6: two maker sequences that are documented deferrals fail explicitly and
/// say so. (1) A box whose top loop is filleted has an ellipse where each two fillets meet
/// (their mitre): shell does not offset ellipse edges. (2) A box chamfered on every edge has
/// four faces at each vertex of its corner triangles: their offsets need a topology change.
#[test]
fn shells_of_mitred_blends_and_chamfer_corners_are_named_deferrals() {
    use forge_blend::{BlendOptions, ChamferSpec, chamfer, fillet};
    let b = aabox("e1", [0.0, 0.0, 0.0], [20.0, 16.0, 12.0]);
    let tops: Vec<_> = [
        [10.0, 0.0, 12.0],
        [20.0, 8.0, 12.0],
        [10.0, 16.0, 12.0],
        [0.0, 8.0, 12.0],
    ]
    .iter()
    .map(|p| edge_near(&b, *p))
    .collect();
    let f = fillet(&b, &es(&b, &tops), 2.0, &BlendOptions::new("f1"))
        .expect("fillet")
        .body;
    let bottom = face_near(&f, [10.0, 8.0, 0.0]);
    let err = shell(&f, &fs(&f, &[bottom]), 1.0, ShellDirection::Inward, &opts())
        .expect_err("mitre ellipses");
    assert_eq!(err.code(), "SHELL_FAILED", "{err}");
    let m = err.to_string();
    assert!(
        m.contains("offsetting an ellipse edge") && m.contains("mitre") && m.contains("f1/blend:"),
        "{m}"
    );
    let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
    let c = chamfer(
        &b,
        &es(&b, &all),
        &ChamferSpec::Equal { d: 2.0 },
        &BlendOptions::new("c1"),
    )
    .expect("chamfer every edge")
    .body;
    let bottom = face_near(&c, [10.0, 8.0, 0.0]);
    let err = shell(&c, &fs(&c, &[bottom]), 0.5, ShellDirection::Inward, &opts())
        .expect_err("four faces at a vertex");
    assert_eq!(err.code(), "SHELL_FAILED", "{err}");
    assert!(err.to_string().contains("more than three faces"), "{err}");
}
