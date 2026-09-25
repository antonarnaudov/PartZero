//! Draft (SPEC-v1 §6.9) against closed forms: a wall drafted by `a` about a neutral plane moves
//! by `(z − z_N)·tan(a)` at height `z`, so a prism of cross-section `A`, perimeter `P` whose `c`
//! convex and `r` reflex corners are all right angles, drafted all round about its base, has the
//! cross-section `A − P·d + (c − r)·d²` at offset `d = z·tan(a)` (mitred corners) and the volume
//! `A·h − P·k·h²/2 + (c − r)·k²·h³/3` with `k = tan(a)`. Plus the drafted normals
//! (`cos(a)·n + sin(a)·p`), kept keys, the refusals, and a property over random boxes.

mod common;

use common::*;
use forge_blend::{BlendError, DraftFaceReason, DraftOptions, DraftSpec, draft};
use forge_core::linalg::Vec3;
use forge_core::topo::Body;

fn up(z: f64, a: f64) -> DraftSpec {
    DraftSpec {
        neutral_origin: Vec3::new(0.0, 0.0, z),
        neutral_normal: Vec3::new(0.0, 0.0, 1.0),
        pull: Vec3::new(0.0, 0.0, 1.0),
        angle_deg: a,
    }
}

fn opts() -> DraftOptions {
    DraftOptions::new("dr1")
}

fn tan_deg(a: f64) -> f64 {
    let (s, c) = forge_core::math::sin_cos_deg(a);
    s / c
}

/// The side faces of a body (normal ⟂ Z), by probing points on them.
fn sides(b: &Body, pts: &[[f64; 3]]) -> Vec<forge_blend::Pick<forge_core::topo::FaceId>> {
    let ids: Vec<_> = pts.iter().map(|p| face_near(b, *p)).collect();
    fs(b, &ids)
}

fn keys(b: &Body) -> Vec<String> {
    let mut k: Vec<String> = b.faces().iter().map(|(_, f)| f.provenance.key()).collect();
    k.sort();
    k
}

fn box_sides(a: f64, bb: f64, h: f64) -> Vec<[f64; 3]> {
    vec![
        [a / 2.0, 0.0, h / 2.0],
        [a, bb / 2.0, h / 2.0],
        [a / 2.0, bb, h / 2.0],
        [0.0, bb / 2.0, h / 2.0],
    ]
}

#[test]
fn a_box_drafted_all_round_about_its_base_tapers_to_the_closed_form() {
    let (a, bb, h, ang) = (40.0, 20.0, 10.0, 3.0);
    let body = aabox("e1", [0.0, 0.0, 0.0], [a, bb, h]);
    let out = draft(
        &body,
        &sides(&body, &box_sides(a, bb, h)),
        &up(0.0, ang),
        &opts(),
    )
    .expect("drafted");
    assert_valid(&out);
    let k = tan_deg(ang);
    let want = a * bb * h - (a + bb) * k * h * h + 4.0 / 3.0 * k * k * h * h * h;
    assert!(
        rel(volume(&out), want) < 1e-11,
        "{} vs {want}",
        volume(&out)
    );
    let m = forge_check::body_metrics(&out).unwrap();
    assert_eq!((m.faces, m.edges), (6, 12));
    // Every face keeps its key (drafted faces are modified, not created).
    assert_eq!(keys(&out), keys(&body));
    // The drafted normal of the +X wall is cos(a)·(+X) + sin(a)·(+Z).
    let f = face_near(&out, [a - k * h / 2.0, bb / 2.0, h / 2.0]);
    let face = out.face(f).unwrap();
    let n = match &face.surface {
        forge_core::geom::Surface::Plane(p) => {
            if face.sense {
                p.frame().z()
            } else {
                -p.frame().z()
            }
        }
        _ => panic!("still planar"),
    };
    let (s, c) = forge_core::math::sin_cos_deg(ang);
    assert!(
        (n.x - c).abs() < 1e-12 && n.y.abs() < 1e-12 && (n.z - s).abs() < 1e-12,
        "{n:?}"
    );
}

#[test]
fn the_neutral_plane_and_the_pull_direction_decide_where_the_walls_stay() {
    let (a, bb, h, ang) = (30.0, 30.0, 12.0, 2.0);
    let k = tan_deg(ang);
    let body = aabox("e1", [0.0, 0.0, 0.0], [a, bb, h]);
    let picks = sides(&body, &box_sides(a, bb, h));
    // Neutral at the top: the walls keep the top outline and grow outward below it.
    let top = draft(&body, &picks, &up(h, ang), &opts()).expect("drafted");
    assert_valid(&top);
    let want = a * bb * h + (a + bb) * k * h * h + 4.0 / 3.0 * k * k * h * h * h;
    assert!(
        rel(volume(&top), want) < 1e-11,
        "{} vs {want}",
        volume(&top)
    );
    // Pull reversed about the base: the part tapers inward downward, so it grows upward.
    let rev = DraftSpec {
        pull: Vec3::new(0.0, 0.0, -1.0),
        ..up(0.0, ang)
    };
    let down = draft(&body, &picks, &rev, &opts()).expect("drafted");
    assert_valid(&down);
    assert!(
        rel(volume(&down), want) < 1e-11,
        "{} vs {want}",
        volume(&down)
    );
}

#[test]
fn one_wall_drafted_alone_leans_by_its_angle() {
    let (a, bb, h, ang) = (40.0, 20.0, 10.0, 5.0);
    let body = aabox("e1", [0.0, 0.0, 0.0], [a, bb, h]);
    let one = sides(&body, &[[a, bb / 2.0, h / 2.0]]);
    let out = draft(&body, &one, &up(0.0, ang), &opts()).expect("drafted");
    assert_valid(&out);
    let want = a * bb * h - bb * tan_deg(ang) * h * h / 2.0;
    assert!(
        rel(volume(&out), want) < 1e-11,
        "{} vs {want}",
        volume(&out)
    );
}

#[test]
fn an_l_shaped_prism_with_a_reflex_corner_follows_the_mitred_closed_form() {
    // L: 30 × 20 with a 15 × 10 notch; 5 convex and 1 reflex right corners.
    let pts = [
        [0.0, 0.0],
        [30.0, 0.0],
        [30.0, 10.0],
        [15.0, 10.0],
        [15.0, 20.0],
        [0.0, 20.0],
    ];
    let (h, ang) = (8.0, 4.0);
    let body = prism("e1", 0.0, polygon(&pts), h);
    let mid = |p: [f64; 2], q: [f64; 2]| [(p[0] + q[0]) / 2.0, (p[1] + q[1]) / 2.0, h / 2.0];
    let walls: Vec<[f64; 3]> = (0..pts.len())
        .map(|i| mid(pts[i], pts[(i + 1) % pts.len()]))
        .collect();
    let out = draft(&body, &sides(&body, &walls), &up(0.0, ang), &opts()).expect("drafted");
    assert_valid(&out);
    let (area, perim) = (30.0 * 20.0 - 15.0 * 10.0, 2.0 * (30.0 + 20.0));
    let k = tan_deg(ang);
    let want = area * h - perim * k * h * h / 2.0 + (5.0 - 1.0) * k * k * h * h * h / 3.0;
    assert!(
        rel(volume(&out), want) < 1e-11,
        "{} vs {want}",
        volume(&out)
    );
}

#[test]
fn faces_that_are_not_planar_walls_are_refused_with_the_reason() {
    let body = aabox("e1", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let top = sides(&body, &[[5.0, 5.0, 10.0]]);
    match draft(&body, &top, &up(0.0, 3.0), &opts()) {
        Err(BlendError::DraftFaceUnsupported { faces }) => {
            assert_eq!(faces.len(), 1);
            assert_eq!(faces[0].reason, DraftFaceReason::NotPerpendicular);
        }
        other => panic!("expected DRAFT_FACE_UNSUPPORTED, got {other:?}"),
    }
    let disc = zcyl("e2", [0.0, 0.0], 0.0, 5.0, 4.0);
    let wall = sides(&disc, &[[5.0, 0.0, 2.0]]);
    let e = draft(&disc, &wall, &up(0.0, 3.0), &opts()).unwrap_err();
    assert_eq!(e.code(), "DRAFT_FACE_UNSUPPORTED");
    assert!(
        matches!(&e, BlendError::DraftFaceUnsupported { faces } if faces[0].reason == DraftFaceReason::NotPlanar)
    );
    // Another body's face is never read as this body's face with the same index.
    let mut other = sides(&body, &[[10.0, 5.0, 5.0]]);
    other[0].body = 7;
    assert!(
        matches!(draft(&body, &other, &up(0.0, 3.0), &opts()), Err(BlendError::DraftFaceUnsupported { faces }) if faces[0].reason == DraftFaceReason::NotOnBody)
    );
    assert!(matches!(
        draft(&body, &wall_of(&body), &up(0.0, 50.0), &opts()),
        Err(BlendError::InvalidValue { .. })
    ));
}

fn wall_of(b: &Body) -> Vec<forge_blend::Pick<forge_core::topo::FaceId>> {
    sides(b, &[[10.0, 5.0, 5.0]])
}

#[test]
fn what_is_not_supported_or_would_turn_over_fails_explicitly() {
    // The flat walls of a slot meet its round ends: a curved neighbour.
    let s = prism("e1", 0.0, slot([0.0, 0.0], 20.0, 5.0), 6.0);
    let flat = sides(&s, &[[0.0, -5.0, 3.0]]);
    let e = draft(&s, &flat, &up(0.0, 3.0), &opts()).unwrap_err();
    assert_eq!(e.code(), "DRAFT_FAILED");
    assert!(e.to_string().contains("curved"), "{e}");
    // A thin tall rib drafted steeply: its top edges would cross (2 − 2·20·tan 10° < 0).
    let rib = aabox("e1", [0.0, 0.0, 0.0], [2.0, 30.0, 20.0]);
    let walls = sides(&rib, &[[0.0, 15.0, 10.0], [2.0, 15.0, 10.0]]);
    let e = draft(&rib, &walls, &up(0.0, 10.0), &opts()).unwrap_err();
    assert_eq!(e.code(), "DRAFT_FAILED");
    assert!(e.to_string().contains("collapses or turns over"), "{e}");
    // A wall with a round hole through it.
    let plate = cut(
        aabox("e1", [0.0, 0.0, 0.0], [40.0, 10.0, 20.0]),
        ycyl_tool(),
        "e2",
    );
    let holed = sides(&plate, &[[5.0, 0.0, 5.0]]);
    let e = draft(&plate, &holed, &up(0.0, 3.0), &opts()).unwrap_err();
    assert_eq!(e.code(), "DRAFT_FAILED");
}

/// A cylinder along Y through the middle of the 40 × 10 × 20 plate (a hole in its front wall).
fn ycyl_tool() -> Body {
    // Sketch plane: normal +Y, x along +X, so y_sketch = n × x = −Z (v = −z).
    let plane = forge_ir::PlaneSpec::Frame(forge_ir::Frame {
        origin: [0.0, -5.0, 0.0],
        normal: [0.0, 1.0, 0.0],
        x_dir: [1.0, 0.0, 0.0],
    });
    prism_op("e2", plane, vec![circle("c", [20.0, -10.0], 3.0)], 20.0)
        .build()
        .expect("a cylinder along Y")
}

mod props {
    use proptest::prelude::*;

    use super::*;

    proptest! {
        #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

        /// Any box drafted all round by an angle that keeps its top: valid, the closed-form
        /// volume, and the same keys.
        #[test]
        fn drafted_boxes_match_the_closed_form(
            a in 5.0f64..80.0, bb in 5.0f64..80.0, h in 1.0f64..30.0, frac in 0.02f64..0.9, neutral in 0.0f64..1.0,
        ) {
            // Keep the top (and the bottom, for a raised neutral plane) wider than zero.
            let limit = (a.min(bb) / 2.0) / h;
            let k = frac * limit;
            let ang = forge_core::math::rad_to_deg(forge_core::math::atan(k)).min(44.0);
            let k = tan_deg(ang);
            let zn = neutral * h;
            let body = aabox("e1", [0.0, 0.0, 0.0], [a, bb, h]);
            let out = draft(&body, &sides(&body, &box_sides(a, bb, h)), &up(zn, ang), &opts());
            let out = out.map_err(|e| TestCaseError::fail(format!("{e}")))?;
            assert_valid(&out);
            // ∫₀ʰ (a − 2k(z − zn))(bb − 2k(z − zn)) dz
            let f = |z: f64| {
                let u = z - zn;
                a * bb * z - (a + bb) * k * u * u + 4.0 / 3.0 * k * k * u * u * u
            };
            let want = f(h) - f(0.0);
            prop_assert!(rel(volume(&out), want) < 1e-9, "{} vs {}", volume(&out), want);
            prop_assert_eq!(keys(&out), keys(&body));
        }
    }
}
