//! Other features of the body in the material a blend removes or fills (review of W6,
//! blocker): a hole, a boss, a channel or a void closer to the edge than the blend reaches.
//! Forge cannot trim a blend by such a feature, so it must never return a body there.
//!
//! W6 review round 6: SPEC §6.6 defines the rolling ball there (OCCT builds it, trimmed
//! around the feature) and gives no size limit for it, so the failure is `*_FAILED` naming
//! the obstacle's face — a capability gap, never `*_TOO_LARGE` with an obstacle distance
//! presented as the feasible maximum. The reason carries the largest value that builds clear
//! of the feature (confirmed: it was built), and that value builds the closed-form body (the
//! blend then misses the obstacle).
//!
//! Cases 1–7 are the reviewer's adversarial cases (each checked by the reviewer against an
//! OCCT boolean with the exact rolling-ball tool, which Forge's old result missed by up to
//! 2 mm³); the rest cover the region's other pieces (the end faces, a closed void, a curved
//! face that pierces the blend surface without its boundary entering the region).

mod common;

use common::*;
use forge_blend::{BlendError, BlendOptions, ChamferSpec, chamfer, fillet};
use forge_core::math::PI;
use forge_core::topo::{Body, EdgeId};
use forge_ir::{Frame, PlaneSpec, SketchCurve};
use forge_ops::boolean::corpus::{Operand, Sweep};

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

/// A prism of `curves` sketched on `pl`, extruded by `h` along its normal.
fn prism_on(feature: &str, pl: PlaneSpec, curves: Vec<SketchCurve>, h: f64) -> Body {
    prism_op(feature, pl, curves, h).build().expect("prism")
}

/// A pin of radius `rp` along +z at `(x, y)` from `z0`, straight up to `z1`, ending in a
/// hemisphere (a ball-end drill).
fn ball_pin(x: f64, y: f64, rp: f64, z0: f64, z1: f64) -> Body {
    let curves = vec![
        line("b", [0.0, z0], [rp, z0]),
        line("r", [rp, z0], [rp, z1]),
        arc("a", [rp, z1], [0.0, z1 + rp], [0.0, z1], true),
        line("x", [0.0, z1 + rp], [0.0, z0]),
    ];
    let mut op = prism_op(
        "pin",
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
    Operand::build(&op).expect("pin")
}

fn box20() -> Body {
    aabox("e1", [0.0, 0.0, 0.0], [20.0, 20.0, 10.0])
}

/// The L-block of cases 5 and 7: a 20×20×5 base with a 5 mm wall along x = 0 rising to
/// z = 20; the inside corner edge runs along y at x = z = 5.
fn lblock() -> Body {
    let base = aabox("e1", [0.0, 0.0, 0.0], [20.0, 20.0, 5.0]);
    let wall = aabox("e2", [0.0, 0.0, 5.0], [5.0, 20.0, 15.0]);
    join(base, wall, "j1")
}

/// A quarter-round's cross-section area (removed or added by a 90° fillet of radius r).
fn quarter(r: f64) -> f64 {
    (1.0 - PI / 4.0) * r * r
}

/// An obstacle limits the value near `expect`: `*_FAILED` naming `obstacle` (a substring of
/// its face's name), the hinted value builds a valid body of volume `v_at(hint)`, and
/// `1.01·hint` fails the same way.
fn assert_obstacle(
    b: &Body,
    e: EdgeId,
    value: f64,
    chamfer_d: bool,
    expect: f64,
    obstacle: &str,
    v_at: impl Fn(f64) -> f64,
) {
    let run = |x: f64| {
        if chamfer_d {
            chamfer(b, &es(b, &[e]), &ChamferSpec::Equal { d: x }, &opts())
        } else {
            fillet(b, &es(b, &[e]), x, &opts())
        }
    };
    let err = run(value).expect_err("an obstacle lies in the blended material");
    let max = obstacle_hint(&err);
    assert!(
        err.to_string().contains(obstacle),
        "names {obstacle}: {err}"
    );
    assert!(
        (expect - 0.0015..=expect + 1e-9).contains(&max),
        "hint {max}, expected about {expect}: {err}"
    );
    let out = run(max).unwrap_or_else(|e| panic!("the hinted {max} must build: {e}"));
    assert_valid(&out.body);
    let v = volume(&out.body);
    assert!(rel(v, v_at(max)) < 1e-10, "{v} vs {}", v_at(max));
    let again = run(1.01 * max).expect_err("the obstacle again");
    assert_eq!(again.code(), err.code(), "{again}");
}

#[test]
fn case_1_a_through_hole_under_a_top_edge_fillet() {
    let b = cut(box20(), zcyl("h1", [10.0, 1.5], -1.0, 0.5, 12.0), "c1");
    let v0 = volume(&b);
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    // The contact on the top face reaches the hole (y = 1) at r = 1.
    assert_obstacle(&b, e, 4.0, false, 0.999, "h1/side:c", |r| {
        v0 - quarter(r) * 20.0
    });
}

#[test]
fn case_2_the_same_hole_under_a_chamfer() {
    let b = cut(box20(), zcyl("h1", [10.0, 1.5], -1.0, 0.5, 12.0), "c1");
    let v0 = volume(&b);
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    assert_obstacle(&b, e, 4.0, true, 0.999, "h1/side:c", |d| {
        v0 - d * d / 2.0 * 20.0
    });
}

/// A hole along x through the box at y = 1.2, z = 5.
fn box_with_x_hole() -> Body {
    let hole = prism_on(
        "h1",
        plane([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        vec![circle("c", [1.2, 5.0], 0.5)],
        22.0,
    );
    cut(box20(), hole, "c1")
}

#[test]
fn case_3_a_cross_hole_beside_a_vertical_edge_fillet() {
    let b = box_with_x_hole();
    let v0 = volume(&b);
    let e = edge_near(&b, [0.0, 0.0, 5.0]);
    // The contact on the face x = 0 reaches the hole (y = 0.7) at r = 0.7.
    assert_obstacle(&b, e, 3.0, false, 0.699, "h1/side:c", |r| {
        v0 - quarter(r) * 10.0
    });
}

#[test]
fn case_4_the_same_cross_hole_under_a_chamfer() {
    let b = box_with_x_hole();
    let v0 = volume(&b);
    let e = edge_near(&b, [0.0, 0.0, 5.0]);
    assert_obstacle(&b, e, 3.0, true, 0.699, "h1/side:c", |d| {
        v0 - d * d / 2.0 * 10.0
    });
}

#[test]
fn case_5_a_boss_in_the_fill_of_an_inside_corner() {
    let b = join(lblock(), zcyl("p1", [6.2, 10.0], 5.0, 0.5, 2.0), "j2");
    let v0 = volume(&b);
    let e = edge_near(&b, [5.0, 10.0, 5.0]);
    assert_eq!(
        forge_blend::edge_convexity(&b, e),
        Some(forge_blend::Convexity::Concave)
    );
    assert_obstacle(&b, e, 3.0, false, 0.699, "p1/side:c", |r| {
        v0 + quarter(r) * 20.0
    });
}

#[test]
fn case_6_a_channel_crossing_under_a_top_edge_fillet() {
    // A 1 × 0.3 tunnel along y just under the top face.
    let tunnel = aabox("t1", [10.0, -1.0, 9.0], [1.0, 22.0, 0.3]);
    let b = cut(box20(), tunnel, "c1");
    let v0 = volume(&b);
    let e = edge_near(&b, [5.0, 0.0, 10.0]);
    // The contact on the side face y = 0 reaches the tunnel's roof (z = 9.3) at r = 0.7.
    assert_obstacle(&b, e, 4.0, false, 0.699, "t1/", |r| v0 - quarter(r) * 20.0);
}

#[test]
fn case_7_holes_in_the_floor_and_the_wall_under_an_inside_corner_fillet() {
    let floor = cut(lblock(), zcyl("h1", [6.2, 10.0], -1.0, 0.5, 7.0), "c1");
    let v0 = volume(&floor);
    let e = edge_near(&floor, [5.0, 10.0, 5.0]);
    assert_eq!(
        forge_blend::edge_convexity(&floor, e),
        Some(forge_blend::Convexity::Concave)
    );
    assert_obstacle(&floor, e, 3.0, false, 0.699, "h1/side:c", |r| {
        v0 + quarter(r) * 20.0
    });
    let hole = prism_on(
        "h2",
        plane([-1.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
        vec![circle("c", [10.0, 6.2], 0.5)],
        7.0,
    );
    let wall = cut(lblock(), hole, "c1");
    let v0 = volume(&wall);
    let e = edge_near(&wall, [5.0, 10.0, 5.0]);
    assert_eq!(
        forge_blend::edge_convexity(&wall, e),
        Some(forge_blend::Convexity::Concave)
    );
    assert_obstacle(&wall, e, 3.0, false, 0.699, "h2/side:c", |r| {
        v0 + quarter(r) * 20.0
    });
}

#[test]
fn a_tunnel_along_the_edge_is_found_on_the_end_faces() {
    // Inside the fillet's material over its whole length: only its ends, on the faces the
    // blend ends on, touch the region's boundary.
    let tunnel = aabox("t1", [-1.0, 1.0, 9.0], [22.0, 1.0, 0.3]);
    let b = cut(box20(), tunnel, "c1");
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    let err = fillet(&b, &es(&b, &[e]), 4.0, &opts()).expect_err("tunnel in the fillet");
    let max_feasible_r = obstacle_hint(&err);
    assert!(err.to_string().contains("t1/"), "names the tunnel: {err}");
    // The tunnel's corner (y = 1, z = 9.3) nearest the edge enters the removed material when
    // it leaves the ball: at the larger root of (1 − r)² + (r − 0.7)² = r².
    let root = 1.7 + (1.7f64 * 1.7 - 1.49).sqrt();
    assert!(
        (root - 0.0015..=root).contains(&max_feasible_r),
        "{max_feasible_r} vs {root}"
    );
    let out = fillet(&b, &es(&b, &[e]), max_feasible_r, &opts()).expect("max builds");
    assert_valid(&out.body);
}

#[test]
fn a_ball_end_hole_piercing_the_fillet_is_found() {
    // A blind ball-end hole from below: its rim circles stay below the fillet's material,
    // only the spherical tip pierces the blend surface (a closed intersection curve).
    let pin = ball_pin(10.0, 2.5, 0.9, -1.0, 9.0);
    let b = cut(box20(), pin, "c1");
    let v0 = volume(&b);
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    let err = fillet(&b, &es(&b, &[e]), 4.0, &opts()).expect_err("tip in the fillet");
    let max_feasible_r = obstacle_hint(&err);
    assert!(err.to_string().contains("pin/"), "names the pin: {err}");
    // The tip's top (y = 2.5, z = 9.9) is inside for r > 3.307; the cap is reached before.
    assert!(
        max_feasible_r > 1.9 && max_feasible_r < 3.307,
        "{max_feasible_r}"
    );
    let out = fillet(&b, &es(&b, &[e]), max_feasible_r, &opts()).expect("hint builds");
    assert_valid(&out.body);
    assert!(rel(volume(&out.body), v0 - quarter(max_feasible_r) * 20.0) < 1e-10);
}

#[test]
fn features_clear_of_the_blend_do_not_limit_it() {
    // The same hole, farther than r from the edge: the fillet builds the closed form.
    let b = cut(box20(), zcyl("h1", [10.0, 6.0], -1.0, 0.5, 12.0), "c1");
    let v0 = volume(&b);
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    let out = fillet(&b, &es(&b, &[e]), 4.0, &opts()).expect("clear of the hole");
    assert_valid(&out.body);
    assert!(rel(volume(&out.body), v0 - quarter(4.0) * 20.0) < 1e-10);
    let out = chamfer(&b, &es(&b, &[e]), &ChamferSpec::Equal { d: 4.0 }, &opts()).expect("chamfer");
    assert!(rel(volume(&out.body), v0 - 8.0 * 20.0) < 1e-10);
}

/// The key of the face of `b` whose surface is a cylinder (the one hole of the test bodies).
fn cylinder_key(b: &Body) -> String {
    let keys = forge_blend::KeyMap::derive(b);
    let (id, _) = b
        .faces()
        .iter()
        .find(|(_, f)| matches!(f.surface, forge_core::geom::Surface::Cylinder(_)))
        .expect("a cylindrical face");
    keys.face(id).expect("key").key
}

#[test]
fn the_obstacle_face_is_named_not_the_face_that_holds_it() {
    // W6 review round 3: a fillet limited by a hole in its top face named the top face
    // ("face width at base/cap:end", tens of mm wide). The limit is met at the hole: its wall
    // is the face named.
    let b = cut(box20(), zcyl("h1", [10.0, 1.5], -1.0, 0.5, 12.0), "c1");
    let e = edge_near(&b, [10.0, 0.0, 10.0]);
    let err = fillet(&b, &es(&b, &[e]), 4.0, &opts()).expect_err("hole in the fillet");
    obstacle_hint(&err);
    // The hole's wall, by its display name (the derived key map names it by its key).
    assert!(
        err.to_string().contains(&cylinder_key(&b)),
        "the reason names the hole's wall: {err}"
    );
    // A plain face width still names the face itself (SPEC §6.6's example).
    let slab = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.82]);
    let top = edge_near(&slab, [20.0, 0.0, 6.82]);
    let bottom = edge_near(&slab, [20.0, 0.0, 0.0]);
    let err = fillet(&slab, &es(&slab, &[top, bottom]), 4.0, &opts()).expect_err("too wide");
    let BlendError::RadiusTooLarge { edges, .. } = &err else {
        panic!("{} {err}", err.code());
    };
    let front = face_near(&slab, [20.0, 0.0, 3.0]);
    let fk = forge_blend::KeyMap::derive(&slab)
        .face(front)
        .expect("key")
        .key;
    assert!(
        edges.iter().all(|x| x.face.as_deref() == Some(fk.as_str())),
        "{err}"
    );
}
