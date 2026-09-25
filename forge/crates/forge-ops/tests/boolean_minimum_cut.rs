//! The smallest overlap that counts, at the forge-ops level: SPEC-v1 [W0-41] (1)–(2) with
//! [W0-48] and [W0-53] (the conformance fixtures `corpus/v1/conformance/booleans/identity.json`
//! check the same cases through forge-regen).
//!
//! - [W0-41] (1): a target edge within *tol* of an **oblique** tool face lies on it: the
//!   sliver between them is a contact, not a cut (`BOOLEAN_NO_INTERSECTION` when that is all
//!   the cut has; a join tool touching so is detached as well). Beside a real cut Forge cannot
//!   realize it as coincident faces (it snaps aligned faces only): an explicit
//!   `FORGE_BOOLEAN_NEAR_COINCIDENT`, never a body with a sub-tolerance chamfer — whether the
//!   sliver is a separate component of the common part or joined to the real cut in one
//!   (review round 5: `thin::edge_sliver`).
//! - [W0-48]: a target corner farther than *tol* inside a tool face is cut although the
//!   common tetrahedron's inscribed ball is smaller than *tol*; a square through-pin whose
//!   walls are 1.2e-6 to 3e-6 mm apart cuts a hole.
//! - [W0-53]: a cut tool covering a fin of the target 1.2e-6 to 3e-6 mm thick on both sides
//!   removes the fin.
//!
//! Every result body passes `forge_check::validate` and matches its closed-form volume.

use forge_core::Severity;
use forge_core::topo::Body;
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyChange, BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

const TOL: f64 = 1e-6;

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

/// The prism over the polygon `pts` (counter-clockwise) in the plane of `frame`, extruded
/// by `h` (`symmetric`: `h/2` to each side).
fn prism(feature: &str, frame: Frame, pts: &[[f64; 2]], h: f64, symmetric: bool) -> Body {
    let n = pts.len();
    let curves = (0..n)
        .map(|k| line(&format!("e{k}"), pts[k], pts[(k + 1) % n]))
        .collect();
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(frame),
            curves,
        },
        sweep: Sweep::Extrude {
            distance: h,
            direction: if symmetric {
                SweepDirection::Symmetric
            } else {
                SweepDirection::Normal
            },
        },
    }
    .build()
    .expect("prism")
}

fn xy(z: f64) -> Frame {
    Frame {
        origin: [0.0, 0.0, z],
        normal: [0.0, 0.0, 1.0],
        x_dir: [1.0, 0.0, 0.0],
    }
}

/// The target of the fixtures: `[-5, 5]² × [0, 10]`.
fn target_box() -> Body {
    prism(
        "t",
        xy(0.0),
        &[[-5.0, -5.0], [5.0, -5.0], [5.0, 5.0], [-5.0, 5.0]],
        10.0,
        false,
    )
}

fn origin(feature: &str) -> Origin {
    Origin {
        feature: feature.into(),
        member: "m".into(),
        instance: None,
    }
}

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: origin(feature),
        timeline,
    }
}

fn run(op: BodyOp, target: Body, tool: Body) -> Result<BodyOpResult, BooleanError> {
    apply_body_op(op, &[ob(target, "t", 0)], &[ob(tool, "k", 1)], "g")
}

/// The one result body: valid, `modified`, with its volume and face count.
fn one_body(r: &BodyOpResult, what: &str) -> (f64, usize) {
    assert_eq!(r.bodies.len(), 1, "{what}: {} bodies", r.bodies.len());
    let b = &r.bodies[0];
    assert_eq!(b.change, BodyChange::Modified, "{what}");
    let errs: Vec<String> = forge_check::validate(&b.body)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .map(|i| format!("{i:?}"))
        .collect();
    assert!(errs.is_empty(), "{what}: invalid result {errs:#?}");
    let v = forge_check::mass_properties(&b.body).expect("mass").volume;
    (v, b.body.counts().faces)
}

/// The fixture's tool: the triangle `x + y ≥ 10 − c` (`x, y ≤ 10`) through the target's
/// height, whose oblique face passes `c / √2` from the target's vertical edge at `(5, 5)`.
fn oblique_tool(c: f64) -> Body {
    prism(
        "k",
        xy(0.0),
        &[[-c, 10.0], [10.0, -c], [10.0, 10.0]],
        30.0,
        true,
    )
}

/// [W0-41] (1): a target edge up to *tol* inside an oblique tool face is a contact. The cut
/// has nothing else: `BOOLEAN_NO_INTERSECTION` at distance 0 (they touch). The same tool as
/// a join tool is detached as well (no volume, no shared face).
#[test]
fn a_target_edge_within_tolerance_of_an_oblique_face_is_a_contact() {
    for depth in [2e-7, 5e-7, 8e-7, 9.5e-7, 0.999e-6] {
        let c = depth * std::f64::consts::SQRT_2;
        for op in [BodyOp::Cut, BodyOp::Join] {
            match run(op, target_box(), oblique_tool(c)) {
                Err(BooleanError::NoIntersection { tool, min_distance }) => {
                    assert_eq!(tool, origin("k"));
                    assert!(
                        min_distance.abs() == 0.0,
                        "depth {depth:e} {op:?}: {min_distance}"
                    );
                }
                other => panic!("depth {depth:e} {op:?}: {other:?}"),
            }
        }
    }
}

/// Beyond *tol* the same oblique face cuts a chamfer off the edge: a valid body with one
/// more face and the volume of the box minus the triangular prism (legs `c`, height 10).
#[test]
fn a_target_edge_farther_than_tolerance_inside_an_oblique_face_is_cut() {
    for depth in [1.2e-6, 1.5e-6, 2e-6, 5e-6, 1e-3] {
        let c = depth * std::f64::consts::SQRT_2;
        let r = run(BodyOp::Cut, target_box(), oblique_tool(c))
            .unwrap_or_else(|e| panic!("depth {depth:e}: {e}"));
        let (v, faces) = one_body(&r, &format!("depth {depth:e}"));
        let want = 1000.0 - 0.5 * c * c * 10.0;
        assert!(
            (v - want).abs() <= 1e-12 * 1000.0,
            "depth {depth:e}: {v} vs {want}"
        );
        assert_eq!(faces, 7, "depth {depth:e}");
    }
}

/// [W0-41] (1) beside a real cut: an L-shaped target whose edge at `(5, 5)` lies 8e-7 mm
/// inside the tool's oblique face while the same face cuts deep into the target's arm. The
/// sliver would have to be realized as a contact (the edge on the face), which Forge does
/// for aligned faces only: an explicit `FORGE_BOOLEAN_NEAR_COINCIDENT` naming that part,
/// never a body with a face 1.6e-6 mm wide.
#[test]
fn a_contact_sliver_beside_a_real_cut_fails_explicitly() {
    let l_shape = prism(
        "t",
        xy(0.0),
        &[
            [-5.0, -5.0],
            [9.0, -5.0],
            [9.0, 4.0],
            [5.0, 4.0],
            [5.0, 5.0],
            [-5.0, 5.0],
        ],
        10.0,
        false,
    );
    let c = 8e-7 * std::f64::consts::SQRT_2;
    match run(BodyOp::Cut, l_shape, oblique_tool(c)) {
        Err(e @ BooleanError::NearCoincident { .. }) => {
            let BooleanError::NearCoincident { offset, point, .. } = &e else {
                unreachable!()
            };
            assert!(*offset <= TOL, "{e}");
            // A point of the sliver, near the edge at (5, 5).
            assert!(
                (point[0] - 5.0).abs() < 1e-5 && (point[1] - 5.0).abs() < 1e-5,
                "{e}"
            );
        }
        other => panic!("{other:?}"),
    }
}

/// [W0-48]: the target's corner `(5, 5, 10)` at depth `d` inside a tool bounded by a plane
/// of normal `(1, 1, 1)`. Up to *tol* the common tetrahedron is a contact
/// (`BOOLEAN_NO_INTERSECTION`); beyond it the corner is cut — although for `d = 1.2e-6` the
/// tetrahedron's inscribed ball is only 8.8e-7 mm across — leaving a valid body with a
/// triangular face and the box's volume minus the tetrahedron (legs `d·√3`).
#[test]
fn a_target_corner_is_cut_iff_it_lies_farther_than_tolerance_inside_a_tool_face() {
    let s3 = 3f64.sqrt();
    for d in [5e-7, 9e-7, 1.2e-6, 1.5e-6, 3e-6, 1e-4] {
        // The plane through (5, 5, 10) − d·n, n = (1, 1, 1)/√3; the tool extends 10 mm
        // along +n from a 20 mm square around that point.
        let o = 5.0 - d / s3;
        let frame = Frame {
            origin: [o, o, 5.0 + o],
            normal: [1.0, 1.0, 1.0],
            x_dir: [1.0, -1.0, 0.0],
        };
        let tool = prism(
            "k",
            frame,
            &[[-10.0, -10.0], [10.0, -10.0], [10.0, 10.0], [-10.0, 10.0]],
            10.0,
            false,
        );
        let r = run(BodyOp::Cut, target_box(), tool);
        if d <= TOL {
            assert!(
                matches!(r, Err(BooleanError::NoIntersection { .. })),
                "d {d:e}: {r:?}"
            );
            continue;
        }
        let r = r.unwrap_or_else(|e| panic!("d {d:e}: {e}"));
        let (v, faces) = one_body(&r, &format!("d {d:e}"));
        let leg = d * s3;
        let want = 1000.0 - leg * leg * leg / 6.0;
        assert!((v - want).abs() <= 1e-12 * 1000.0, "d {d:e}: {v} vs {want}");
        assert_eq!(faces, 7, "d {d:e}");
    }
}

/// [W0-48]: a square pin of side `s` through the target cuts a through-hole whose opposite
/// walls are distinct faces (`s > tol`): four more faces, the box's volume minus the pin's.
#[test]
fn a_thin_square_through_pin_cuts_a_hole() {
    for s in [1.2e-6, 1.5e-6, 1.9e-6, 3e-6, 1e-4] {
        let h = 0.5 * s;
        let pin = prism(
            "k",
            xy(0.0),
            &[[-h, -h], [h, -h], [h, h], [-h, h]],
            30.0,
            true,
        );
        let r = run(BodyOp::Cut, target_box(), pin).unwrap_or_else(|e| panic!("s {s:e}: {e}"));
        let (v, faces) = one_body(&r, &format!("s {s:e}"));
        let want = 1000.0 - s * s * 10.0;
        assert!((v - want).abs() <= 1e-12 * 1000.0, "s {s:e}: {v} vs {want}");
        assert_eq!(faces, 10, "s {s:e}");
        assert!(r.notes.is_empty(), "s {s:e}: {:?}", r.notes);
    }
}

/// [W0-53]: a plate `[-5, 5] × [0, 10]` with a fin `[-t/2, t/2] × [10, 15]` (extruded 10),
/// cut by a tool that covers the fin exactly (both walls, its top and its ends coincide).
/// Every point of the fin is within *tol* of a target face and of a tool face, but the fin
/// contains a ball `t > tol` across: it is volume, and the cut removes it, leaving the plate
/// (six faces, 1000 mm³).
#[test]
fn a_cut_tool_covering_a_thin_fin_removes_it() {
    for t in [1.2e-6, 1.5e-6, 1.9e-6, 3e-6, 1e-4] {
        let h = 0.5 * t;
        let target = prism(
            "t",
            xy(0.0),
            &[
                [-5.0, 0.0],
                [5.0, 0.0],
                [5.0, 10.0],
                [h, 10.0],
                [h, 15.0],
                [-h, 15.0],
                [-h, 10.0],
                [-5.0, 10.0],
            ],
            10.0,
            false,
        );
        let tool = prism(
            "k",
            xy(0.0),
            &[[h, 10.0], [h, 15.0], [-h, 15.0], [-h, 10.0]],
            10.0,
            false,
        );
        let r = run(BodyOp::Cut, target, tool).unwrap_or_else(|e| panic!("t {t:e}: {e}"));
        let (v, faces) = one_body(&r, &format!("t {t:e}"));
        assert!((v - 1000.0).abs() <= 1e-12 * 1000.0, "t {t:e}: {v}");
        assert_eq!(faces, 6, "t {t:e}");
    }
}

/// The review-round-5 tool: the L-shaped prism `{s ≥ s0, z ≤ 9} ∪ {z ≥ 9}` (`s = (x + y)/√2`,
/// extruded 60 mm along `(1, −1, 0)`), whose oblique face `s = s0` passes `depth` inside the
/// target's vertical edge at `(5, 5)` while its upper arm removes the target's top 1 mm:
/// one connected common part, thick in the arm.
fn l_tool(depth: f64) -> Body {
    let s2 = std::f64::consts::SQRT_2;
    let s0 = (10.0 - depth * s2) / s2;
    prism(
        "k",
        Frame {
            origin: [0.0, 0.0, 0.0],
            normal: [1.0, -1.0, 0.0],
            x_dir: [1.0, 1.0, 0.0],
        },
        &[
            [s0, -5.0],
            [30.0, -5.0],
            [30.0, 20.0],
            [-20.0, 20.0],
            [-20.0, 9.0],
            [s0, 9.0],
        ],
        60.0,
        true,
    )
}

/// [W0-41] (1) inside a connected common part (review round 5): the edge at `(5, 5)` within
/// *tol* of the L tool's oblique face lies on it, so the ruling's result is the box cut
/// down to `z = 9` (six faces, 900 mm³). Forge gives that result where the intersection's
/// vertex merging already puts the edge on the face (depths up to 7e-7 mm: the section
/// curves 1.4·depth from the edge merge with it) and fails explicitly with
/// `FORGE_BOOLEAN_NEAR_COINCIDENT` naming the edge and the face elsewhere up to *tol*
/// (`thin::edge_sliver`): never the exact body with a chamfer narrower than 2·*tol* (seven
/// faces), which it returned before. Beyond *tol* the edge is chamfered: seven faces and
/// `900 − 9·depth²`.
#[test]
fn a_contact_sliver_connected_to_a_real_cut_is_a_contact_or_fails_explicitly() {
    for depth in [5e-7, 7e-7, 7.1e-7, 8e-7, 9.5e-7, 9.9e-7, 0.999e-6] {
        match run(BodyOp::Cut, target_box(), l_tool(depth)) {
            Ok(r) => {
                let (v, faces) = one_body(&r, &format!("depth {depth:e}"));
                assert_eq!(faces, 6, "depth {depth:e}: a sub-tolerance chamfer");
                // SPEC §8.2 volume tolerance (the merged vertices move edges by < tol).
                assert!((v - 900.0).abs() <= 1e-6 * 900.0, "depth {depth:e}: {v}");
            }
            Err(e @ BooleanError::NearCoincident { .. }) => {
                let BooleanError::NearCoincident {
                    offset,
                    point,
                    entities,
                    ..
                } = &e
                else {
                    unreachable!()
                };
                assert!(*offset <= TOL, "depth {depth:e}: {e}");
                assert!(
                    (point[0] - 5.0).abs() < 1e-5 && (point[1] - 5.0).abs() < 1e-5,
                    "depth {depth:e}: {e}"
                );
                assert!(entities.contains("t/edge:"), "depth {depth:e}: {e}");
            }
            Err(e) => panic!("depth {depth:e}: {e}"),
        }
    }
    // The review's reproductions fail explicitly (they returned a seven-face body).
    for depth in [8e-7, 9.9e-7] {
        assert!(
            matches!(
                run(BodyOp::Cut, target_box(), l_tool(depth)),
                Err(BooleanError::NearCoincident { .. })
            ),
            "depth {depth:e}"
        );
    }
    for depth in [1.2e-6, 1.5e-6, 2e-6, 1e-4] {
        let r = run(BodyOp::Cut, target_box(), l_tool(depth))
            .unwrap_or_else(|e| panic!("depth {depth:e}: {e}"));
        let (v, faces) = one_body(&r, &format!("depth {depth:e}"));
        let want = 900.0 - 9.0 * depth * depth;
        assert!(
            (v - want).abs() <= 1e-12 * 1000.0,
            "depth {depth:e}: {v} vs {want}"
        );
        assert_eq!(faces, 7, "depth {depth:e}");
    }
}
