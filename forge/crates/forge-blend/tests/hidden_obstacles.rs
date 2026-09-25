//! Obstacles that no edge or vertex of the input reveals (W6 review round 3, blockers): a
//! curved face crossing a **planar** bevel with its whole boundary outside the removed wedge
//! (an undercut cavity, a drill point), a **closed void** (a face without loops, a second
//! shell) partly inside a blend's material, and a shell whose offset sphere or cone passes
//! its **pole or apex** through an opening or the opposite wall. Each returned a
//! self-intersecting body before. A shell must now be `SHELL_THICKNESS_TOO_LARGE`, and a
//! blend `*_FAILED` naming the obstacle (W6 review round 6: another feature in a blend's way
//! is a capability gap, not a size limit — SPEC §6.6 defines the rolling ball there), with a
//! value — the feasible range, or the hint of the value that builds clear of the obstacle —
//! that is (a) the closed form of the obstacle's distance, rounded down, and (b) built and
//! verified — valid, the closed-form volume where one exists, and no self-intersection
//! ([`forge_blend::self_intersections`], itself fixed for faces holding a pole or apex).

mod common;

use common::*;
use forge_blend::{
    BlendError, BlendOptions, ChamferSpec, ShellDirection, ShellOptions, chamfer, fillet, shell,
};
use forge_core::math::PI;
use forge_core::topo::Body;
use forge_ir::{Frame, PlaneSpec, SketchCurve};
use forge_ops::boolean::corpus::{Operand, Sweep};
use std::f64::consts::SQRT_2;

fn opts() -> BlendOptions {
    BlendOptions::new("f1")
}

fn plane(origin: [f64; 3], normal: [f64; 3], x_dir: [f64; 3]) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin,
        normal,
        x_dir,
    })
}

/// A solid of revolution about the vertical line through `(x, y)`: `curves` is a closed
/// profile in the half plane (radius, z) with `radius >= 0`.
fn revolved(feature: &str, x: f64, y: f64, curves: Vec<SketchCurve>) -> Body {
    let mut op = prism_op(
        feature,
        plane([x, y, 0.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
        curves,
        1.0,
    );
    op.sweep = Sweep::Revolve {
        axis: forge_ir::SketchAxis {
            origin: [0.0, 0.0],
            direction: [0.0, 1.0],
        },
        angle: 360.0,
        direction: forge_ir::SweepDirection::Normal,
    };
    Operand::build(&op).expect("revolved solid")
}

/// A ball of radius `r` centred at `c`.
fn ball(feature: &str, c: [f64; 3], r: f64) -> Body {
    revolved(
        feature,
        c[0],
        c[1],
        vec![
            arc("a", [0.0, c[2] - r], [0.0, c[2] + r], [0.0, c[2]], true),
            line("x", [0.0, c[2] + r], [0.0, c[2] - r]),
        ],
    )
}

/// A drill of radius `rd` from `z0` up to `z1` with a conical point whose apex is at `apex`.
fn drill(x: f64, y: f64, rd: f64, z0: f64, z1: f64, apex: f64) -> Body {
    revolved(
        "drill",
        x,
        y,
        vec![
            line("b", [0.0, z0], [rd, z0]),
            line("s", [rd, z0], [rd, z1]),
            line("t", [rd, z1], [0.0, apex]),
            line("x", [0.0, apex], [0.0, z0]),
        ],
    )
}

fn box40() -> Body {
    aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 20.0])
}

/// The top-front edge (y = 0, z = 20).
fn top_front(b: &Body) -> forge_core::topo::EdgeId {
    edge_near(b, [20.0, 0.0, 20.0])
}

/// Asserts `err` is `*_TOO_LARGE` with its feasible value — or a blend's obstacle failure
/// with its hint — in `(sup − 0.0015, sup)` (the supremum rounded down to 0.001) and returns
/// it.
fn feasible(err: &BlendError, sup: f64) -> f64 {
    let max = match err {
        BlendError::Failed { .. } => obstacle_hint(err),
        BlendError::RadiusTooLarge { max_feasible_r, .. } => *max_feasible_r,
        BlendError::DistanceTooLarge { max_feasible_d, .. } => *max_feasible_d,
        BlendError::ThicknessTooLarge {
            max_feasible_thickness,
            ..
        } => max_feasible_thickness.unwrap_or_else(|| panic!("no feasible value: {err}")),
        other => panic!("expected *_TOO_LARGE, got {} ({other})", other.code()),
    };
    assert!(
        (sup - 0.0015..sup).contains(&max),
        "{} max {max}, expected just below {sup}: {err}",
        err.code()
    );
    max
}

/// The result is valid and does not pass through itself.
fn verified(b: &Body) {
    assert_valid(b);
    let si = forge_blend::self_intersections(b).expect("certified");
    assert!(si.is_empty(), "self-intersecting result: {si:?}");
}

// --- Blocker 1: curved faces crossing a planar bevel -------------------------------------

/// Case B2: an undercut spherical cavity whose rim on the top face lies outside the strip
/// the chamfer removes (y < 6), while the sphere crosses the bevel plane below it.
#[test]
fn an_undercut_cavity_crossing_a_chamfer_bevel_limits_it() {
    let b = cut(box40(), ball("b1", [20.0, 7.045, 15.1], 5.0), "c1");
    let v0 = volume(&b);
    let e = top_front(&b);
    // The bevel plane y + (20 − z) = d first touches the ball at d = 11.945 − 5√2.
    let sup = 7.045 + 20.0 - 15.1 - 5.0 * SQRT_2;
    let err = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 6.0 }, &opts())
        .expect_err("the cavity crosses the bevel");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    assert!(err.to_string().contains("b1/"), "names the cavity: {err}");
    let max = feasible(&err, sup);
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: max }, &opts())
        .unwrap_or_else(|e| panic!("the suggested {max} must build: {e}"));
    verified(&out.body);
    assert!(rel(volume(&out.body), v0 - max * max / 2.0 * 40.0) < 1e-10);
    // The distance–angle form at 45° is the same bevel.
    let front = face_near(&b, [20.0, 0.0, 10.0]);
    let spec = ChamferSpec::DistanceAngle {
        d: 6.0,
        angle_deg: 45.0,
        side: f1(&b, front),
    };
    let err = chamfer(&b, &es(&b, &[e]), &spec, &opts()).expect_err("same bevel");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    feasible(&err, sup);
    // A fillet of the same edge was already limited by the sphere (a curved profile).
    let err = fillet(&b, &es(&b, &[e]), 8.0, &opts()).expect_err("fillet limited");
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
}

/// Case D: a blind drill from below whose conical point (apex at z = 19) lies inside the
/// chamfer's wedge while its rim circle (z = 16) stays outside it.
#[test]
fn a_drill_point_inside_a_chamfer_wedge_limits_it() {
    let b = cut(box40(), drill(20.0, 2.0, 1.0, -1.0, 16.0, 19.0), "c1");
    let v0 = volume(&b);
    let e = top_front(&b);
    // The drill is convex and the apex its extreme point towards the edge: d < 2 + 1.
    let err = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 4.5 }, &opts())
        .expect_err("the drill point is inside the wedge");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    assert!(err.to_string().contains("drill/"), "names the drill: {err}");
    let max = feasible(&err, 3.0);
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: max }, &opts())
        .unwrap_or_else(|e| panic!("the suggested {max} must build: {e}"));
    verified(&out.body);
    assert!(rel(volume(&out.body), v0 - max * max / 2.0 * 40.0) < 1e-10);
    // The fillet of the same edge: the apex (y = 2, z = 19) leaves the rolling ball, centred
    // at (r, 20 − r), when (r − 2)² + (r − 1)² > r², i.e. r² − 6r + 5 > 0: r > 5 (the drill
    // point's cross-section is a triangle whose apex is the first point out).
    let err = fillet(&b, &es(&b, &[e]), 6.0, &opts()).expect_err("fillet limited");
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
    let r = feasible(&err, 5.0);
    let out = fillet(&b, &es(&b, &[e]), r, &opts()).expect("max builds");
    verified(&out.body);
}

// --- Blocker 2: closed voids (faces without loops) -----------------------------------------

/// Case A (chamfer): a spherical void wholly inside the box, partly inside the wedge.
#[test]
fn a_closed_void_inside_a_chamfer_wedge_limits_it() {
    let b = cut(box40(), ball("b1", [20.0, 4.0, 17.0], 2.0), "c1");
    assert_eq!(b.shell_ids().len(), 2, "a void");
    let v0 = volume(&b);
    let e = top_front(&b);
    // min over the ball of y + 20 − z = 7 − 2√2.
    let sup = 7.0 - 2.0 * SQRT_2;
    let err = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 6.0 }, &opts())
        .expect_err("the void is in the wedge");
    assert_eq!(err.code(), "CHAMFER_FAILED", "{err}");
    assert!(err.to_string().contains("b1/"), "names the void: {err}");
    let max = feasible(&err, sup);
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: max }, &opts())
        .unwrap_or_else(|e| panic!("the suggested {max} must build: {e}"));
    verified(&out.body);
    assert_eq!(out.body.shell_ids().len(), 2);
    assert!(rel(volume(&out.body), v0 - max * max / 2.0 * 40.0) < 1e-10);
}

/// Case A (fillet): a void on the diagonal of the edge's cross-section.
#[test]
fn a_closed_void_inside_a_fillet_limits_it() {
    let (cy, cz, rv) = (2.11, 17.89, 1.0);
    let b = cut(box40(), ball("b1", [20.0, cy, cz], rv), "c1");
    assert_eq!(b.shell_ids().len(), 2, "a void");
    let v0 = volume(&b);
    let e = top_front(&b);
    // The void leaves the rolling ball when √2·(r − 2.11) + 1 > r.
    let sup = (cy * SQRT_2 - rv) / (SQRT_2 - 1.0);
    let err = fillet(&b, &es(&b, &[e]), 6.0, &opts()).expect_err("the void is in the fillet");
    assert_eq!(err.code(), "FILLET_FAILED", "{err}");
    let max = feasible(&err, sup);
    let out = fillet(&b, &es(&b, &[e]), max, &opts())
        .unwrap_or_else(|e| panic!("the suggested {max} must build: {e}"));
    verified(&out.body);
    assert!(rel(volume(&out.body), v0 - (1.0 - PI / 4.0) * max * max * 40.0) < 1e-10);
}

/// A void far from the blend does not limit it.
#[test]
fn a_closed_void_clear_of_the_blend_does_not_limit_it() {
    let b = cut(box40(), ball("b1", [20.0, 15.0, 10.0], 2.0), "c1");
    let v0 = volume(&b);
    let e = top_front(&b);
    let out = fillet(&b, &es(&b, &[e]), 6.0, &opts()).expect("clear");
    verified(&out.body);
    assert!(rel(volume(&out.body), v0 - (1.0 - PI / 4.0) * 36.0 * 40.0) < 1e-10);
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 6.0 }, &opts()).expect("clear");
    verified(&out.body);
}

// --- Blocker 3: poles and apexes in the interference test ----------------------------------

/// Case C: a plate with a spherical dimple (centre z = 7, r = 5, bottom at z = 2).
fn dimpled_plate() -> Body {
    cut(
        aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]),
        ball("b1", [20.0, 15.0, 7.0], 5.0),
        "c1",
    )
}

#[test]
fn a_dimple_offset_through_the_opening_limits_the_shell() {
    let b = dimpled_plate();
    let bottom = face_near(&b, [5.0, 5.0, 0.0]);
    // The offset sphere (radius 5 + t) reaches the open bottom z = 0 at t = 2.
    for t in [2.5, 3.5] {
        let err = shell(&b, &fs(&b, &[bottom]), t, ShellDirection::Inward, &sopts())
            .expect_err("the offset dimple passes through the opening");
        assert_eq!(err.code(), "SHELL_THICKNESS_TOO_LARGE", "t = {t}: {err}");
        let max = feasible(&err, 2.0);
        let out = shell(
            &b,
            &fs(&b, &[bottom]),
            max,
            ShellDirection::Inward,
            &sopts(),
        )
        .unwrap_or_else(|e| panic!("the suggested {max} must build: {e}"));
        verified(&out.body);
    }
}

#[test]
fn a_dimple_offset_into_the_floor_limits_a_closed_shell() {
    let b = dimpled_plate();
    // The offset sphere's bottom (2 − t) meets the offset floor (t) at t = 1.
    for t in [1.5, 2.2] {
        let err = shell(&b, &fs(&b, &[]), t, ShellDirection::Inward, &sopts())
            .expect_err("the offset dimple crosses the offset floor");
        assert_eq!(err.code(), "SHELL_THICKNESS_TOO_LARGE", "t = {t}: {err}");
        let max = feasible(&err, 1.0);
        let out = shell(&b, &fs(&b, &[]), max, ShellDirection::Inward, &sopts())
            .unwrap_or_else(|e| panic!("the suggested {max} must build: {e}"));
        verified(&out.body);
    }
}

#[test]
fn a_thin_closed_dimple_shell_is_the_closed_form() {
    let b = dimpled_plate();
    let t = 0.9;
    let out = shell(&b, &fs(&b, &[]), t, ShellDirection::Inward, &sopts()).expect("builds");
    verified(&out.body);
    // The void: the box 38.2 × 28.2 × 4.2 (z from 0.9 to 5.1) minus the cap of the sphere of
    // radius 5.9 (centre z = 7) below z = 5.1: height h = 5.9 − 1.9 = 4.0.
    let (rr, h) = (5.0 + t, 4.0);
    let cap = PI * h * h * (3.0 * rr - h) / 3.0;
    let void = (40.0 - 2.0 * t) * (30.0 - 2.0 * t) * (6.0 - 2.0 * t) - cap;
    assert!(
        rel(volume(&out.body), volume(&b) - void) < 1e-10,
        "{} vs {}",
        volume(&out.body),
        volume(&b) - void
    );
}

/// Bounding faces down to their poles and apexes adds no false contact on clean bodies
/// (the helper's detection of a face crossing a pole or an apex is unit-tested in
/// `interfere`, on two shells of one plan).
#[test]
fn self_intersections_stays_clear_on_clean_caps_and_drill_points() {
    let b = cut(box40(), drill(20.0, 15.0, 1.0, -1.0, 16.0, 19.0), "c1");
    assert!(
        forge_blend::self_intersections(&b)
            .expect("certified")
            .is_empty()
    );
    let b = dimpled_plate();
    assert!(
        forge_blend::self_intersections(&b)
            .expect("certified")
            .is_empty()
    );
    let b = cut(box40(), ball("b1", [20.0, 15.0, 10.0], 2.0), "c1");
    assert!(
        forge_blend::self_intersections(&b)
            .expect("certified")
            .is_empty()
    );
}

fn sopts() -> ShellOptions {
    ShellOptions::new("sh1")
}
