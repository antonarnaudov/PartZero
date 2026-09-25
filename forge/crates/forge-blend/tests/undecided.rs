//! W6 review round 5: a check that cannot be decided is `*_FAILED` naming what it could not
//! decide — never a `*_TOO_LARGE` limit, never a bracket of the feasible-range search — and a
//! shell vertex whose faces' offsets are not found to meet is not a proven gap.

mod common;

use common::*;
use forge_blend::{
    BlendError, BlendOptions, ChamferSpec, ShellDirection, ShellOptions, chamfer, fillet, shell,
};
use forge_ir::{Frame, PlaneSpec};

fn fopts() -> BlendOptions {
    BlendOptions::new("f1")
}

fn failed_reason(e: &BlendError) -> &str {
    match e {
        BlendError::Failed { reason, .. } => reason,
        other => panic!("expected *_FAILED, got {} ({other})", other.code()),
    }
}

#[test]
fn a_crossing_check_out_of_budget_fails_a_fillet_instead_of_limiting_it() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let e = edge_near(&b, [10.0, 20.0, 15.0]);
    // With the budget, r = 1 builds.
    fillet(&b, &es(&b, &[e]), 1.0, &fopts()).expect("r = 1 builds");
    // Without it the crossing test cannot resolve any pair it has to examine: undecided,
    // so FILLET_FAILED saying so, at a feasible radius and at an infeasible one alike.
    for r in [1.0, 25.0] {
        let err = forge_blend::testing::with_crossings_budget(0, || {
            fillet(&b, &es(&b, &[e]), r, &fopts()).expect_err("undecided")
        });
        assert_eq!(err.code(), "FILLET_FAILED", "r = {r}: {err}");
        let why = failed_reason(&err);
        assert!(
            why.contains("could not be") || why.contains("not a size limit"),
            "r = {r}: {why}"
        );
    }
}

/// A D-shaped prism (radius 5, the flat at x = 3), 10 mm tall.
fn d_flat() -> forge_core::topo::Body {
    prism(
        "e1",
        0.0,
        vec![
            line("l", [3.0, -4.0], [3.0, 4.0]),
            arc("a", [3.0, 4.0], [3.0, -4.0], [0.0, 0.0], true),
        ],
        10.0,
    )
}

#[test]
fn a_crossing_check_out_of_budget_fails_a_chamfer_instead_of_limiting_it() {
    // The edge between the flat and the cylinder: its bevel's ends meet the cylinder's arcs
    // on the end faces, which the certificate has to subdivide (lines against lines it
    // decides exactly, without the budget).
    let b = d_flat();
    let e = edge_near(&b, [3.0, 4.0, 5.0]);
    let spec = |d: f64| ChamferSpec::Equal { d };
    chamfer(&b, &es(&b, &[e]), &spec(0.5), &fopts()).expect("d = 0.5 builds");
    for d in [0.5, 25.0] {
        let err = forge_blend::testing::with_crossings_budget(0, || {
            chamfer(&b, &es(&b, &[e]), &spec(d), &fopts()).expect_err("undecided")
        });
        assert_eq!(err.code(), "CHAMFER_FAILED", "d = {d}: {err}");
        assert!(!failed_reason(&err).is_empty());
    }
}

#[test]
fn an_undecided_check_in_the_search_is_never_a_suggested_maximum() {
    // r = 12 on a 10 mm wide face is proven infeasible at the requested value; every smaller
    // radius the search tries is undecided without the crossing budget: no maximum is
    // claimed (with the budget, the face width is the confirmed limit).
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let top = [
        edge_near(&b, [0.0, 10.0, 30.0]),
        edge_near(&b, [10.0, 10.0, 30.0]),
    ];
    match fillet(&b, &es(&b, &top), 12.0, &fopts()) {
        Err(BlendError::RadiusTooLarge { max_feasible_r, .. }) => {
            assert!(
                max_feasible_r < 10.0 && max_feasible_r > 4.9,
                "{max_feasible_r}"
            );
        }
        other => panic!("expected FILLET_RADIUS_TOO_LARGE, got {other:?}"),
    }
    let err = forge_blend::testing::with_crossings_budget(0, || {
        fillet(&b, &es(&b, &top), 12.0, &fopts()).expect_err("undecided")
    });
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
}

/// A 10 mm cube with the corner `x + y + z > 20` cut off: the cut passes through three of
/// its vertices, each of which then has four faces (the reviewer's input).
fn cube_corner_cut() -> forge_core::topo::Body {
    let cube = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let s = 1.0 / 3.0f64.sqrt();
    let o = 20.0 / 3.0;
    let x = 1.0 / 2.0f64.sqrt();
    let tool = prism_op(
        "e2",
        PlaneSpec::Frame(Frame {
            origin: [o, o, o],
            normal: [s, s, s],
            x_dir: [x, -x, 0.0],
        }),
        rect(-30.0, -30.0, 60.0, 60.0),
        20.0,
    )
    .build()
    .expect("tool");
    cut(cube, tool, "c1")
}

#[test]
fn a_vertex_of_four_faces_whose_offsets_do_not_meet_is_a_shell_failure_not_a_limit() {
    let b = cube_corner_cut();
    assert_valid(&b);
    assert!(
        rel(volume(&b), 1000.0 - 1000.0 / 6.0) < 1e-9,
        "{}",
        volume(&b)
    );
    let bottom = face_near(&b, [5.0, 5.0, 0.0]);
    let cases: [(&[forge_core::topo::FaceId], f64, ShellDirection); 5] = [
        (&[], 0.1, ShellDirection::Inward),
        (&[], 0.1, ShellDirection::Outward),
        (&[], 1.0, ShellDirection::Inward),
        (&[bottom], 0.5, ShellDirection::Inward),
        (&[bottom], 0.5, ShellDirection::Outward),
    ];
    for (open, t, dir) in cases {
        let err = shell(&b, &fs(&b, open), t, dir, &ShellOptions::new("sh1"))
            .expect_err("a vertex of four faces");
        assert_eq!(err.code(), "SHELL_FAILED", "t = {t} {dir:?}: {err}");
        let msg = err.to_string();
        assert!(
            msg.contains("more than three faces") && msg.contains("4 faces around the vertex"),
            "{msg}"
        );
    }
}

#[test]
fn a_crossing_check_out_of_budget_fails_a_shell_instead_of_limiting_it() {
    // An open cylinder: the rim is an annulus between two concentric circles, which the
    // certificate has to subdivide.
    let b = zcyl("e1", [0.0, 0.0], 0.0, 5.0, 10.0);
    let top = face_near(&b, [0.0, 0.0, 10.0]);
    shell(
        &b,
        &fs(&b, &[top]),
        1.0,
        ShellDirection::Inward,
        &ShellOptions::new("sh1"),
    )
    .expect("t = 1 builds");
    let run = |t: f64| {
        forge_blend::testing::with_crossings_budget(0, || {
            shell(
                &b,
                &fs(&b, &[top]),
                t,
                ShellDirection::Inward,
                &ShellOptions::new("sh1"),
            )
            .expect_err("undecided")
        })
    };
    let err = run(1.0);
    assert_eq!(err.code(), "SHELL_FAILED", "{err}");
    // t = 6 is proven too large (the wall's offset radius 5 − 6 < 0): the limit stands, but
    // no maximum is suggested, since every thinner shell the search tries is undecided.
    match run(6.0) {
        BlendError::ThicknessTooLarge {
            max_feasible_thickness,
            ..
        } => assert_eq!(max_feasible_thickness, None),
        other => panic!("expected SHELL_THICKNESS_TOO_LARGE, got {other}"),
    }
}
