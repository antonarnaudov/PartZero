//! SPEC-v1 identity rulings of the Contract stage, at the forge-ops level (the conformance
//! fixtures `corpus/v1/conformance/booleans/identity.json` check them through forge-regen):
//! - [W0-39] (§6.0.5) *modified* means acted on: a join target whose component holds a tool
//!   is `modified` even when the union is the target itself (a tool equal to it, inside it,
//!   or embedded 1.5e-6 mm thin); a target no tool reaches is untouched;
//! - [W0-40] `removed` lists, once each, the origins no body carries after the operation: a
//!   consumed piece whose sibling piece survives (beside the tool, or untouched) removes
//!   nothing, although its `BOOLEAN_BODY_CONSUMED` note stays; a piece merged into another
//!   origin's join component likewise removes nothing while a sibling piece is untouched or
//!   a result body (`merged_into` still maps it), and `removed` is the complete list
//!   (consumed and merged origins), in canonical order.

use forge_core::Severity;
use forge_core::topo::Body;
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyChange, BodyOp, BodyOpResult, OpBody, apply_body_op};
use proptest::prelude::*;

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

/// The axis-aligned box `lo + [0, size]`.
fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    let (x0, y0, w, h) = (lo[0], lo[1], size[0], size[1]);
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(Frame {
                origin: [0.0, 0.0, lo[2]],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves: vec![
                line("b", [x0, y0], [x0 + w, y0]),
                line("r", [x0 + w, y0], [x0 + w, y0 + h]),
                line("t", [x0 + w, y0 + h], [x0, y0 + h]),
                line("l", [x0, y0 + h], [x0, y0]),
            ],
        },
        sweep: Sweep::Extrude {
            distance: size[2],
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("box")
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

fn volume(b: &Body) -> f64 {
    forge_check::mass_properties(b).expect("mass").volume
}

fn valid(r: &BodyOpResult) {
    for x in &r.bodies {
        let errs: Vec<_> = forge_check::validate(&x.body)
            .into_iter()
            .filter(|i| i.severity == Severity::Error)
            .collect();
        assert!(errs.is_empty(), "invalid result: {errs:?}");
    }
}

fn notes(r: &BodyOpResult) -> Vec<&'static str> {
    r.notes.iter().map(|n| n.code()).collect()
}

/// A join tool equal to its target, one inside it, and one embedded 1.5e-6 mm thin (thicker
/// than *tol*, [W0-48]) all act on the target: `modified`, its geometry and volume
/// unchanged, nothing untouched or removed.
#[test]
fn join_tools_that_leave_the_target_unchanged_modify_it() {
    let tools = [
        ("identical", aabox("k", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0])),
        ("inside", aabox("k", [2.0, 3.0, 4.0], [2.0, 2.0, 2.0])),
        ("thin", aabox("k", [2.0, 2.0, 2.0], [6.0, 6.0, 1.5e-6])),
    ];
    for (what, tool) in tools {
        let r = apply_body_op(
            BodyOp::Join,
            &[ob(aabox("t", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "t", 0)],
            &[ob(tool, "k", 1)],
            "g",
        )
        .unwrap_or_else(|e| panic!("{what}: {e}"));
        valid(&r);
        assert_eq!(r.bodies.len(), 1, "{what}");
        assert_eq!(r.bodies[0].origin, origin("t"), "{what}");
        assert_eq!(r.bodies[0].change, BodyChange::Modified, "{what}");
        assert!(
            r.untouched.is_empty() && r.untouched_targets.is_empty(),
            "{what}"
        );
        assert!(r.removed.is_empty() && r.merged_into.is_empty(), "{what}");
        let v = volume(&r.bodies[0].body);
        assert!((v - 1000.0).abs() <= 1e-9 * 1000.0, "{what}: volume {v}");
        let c = r.bodies[0].body.counts();
        assert_eq!((c.faces, c.edges, c.vertices), (6, 12, 8), "{what}");
    }
}

/// Two targets, a tool inside the first only: the first is modified, the second untouched
/// (its component holds no tool).
#[test]
fn a_join_target_no_tool_reaches_stays_untouched() {
    let r = apply_body_op(
        BodyOp::Join,
        &[
            ob(aabox("t", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "t", 0),
            ob(aabox("u", [20.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "u", 1),
        ],
        &[ob(aabox("k", [2.0, 2.0, 2.0], [3.0, 3.0, 3.0]), "k", 2)],
        "g",
    )
    .expect("join");
    valid(&r);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("t"));
    assert_eq!(r.bodies[0].change, BodyChange::Modified);
    assert_eq!(r.untouched, vec![origin("u")]);
    assert_eq!(r.untouched_targets, vec![1]);
    assert!(r.removed.is_empty());
}

/// Two pieces of one body (one origin) as targets. A cut that consumes one piece and misses
/// the other removes nothing (the other still carries the origin) but notes the consumed
/// piece; a cut that consumes both removes the origin once.
#[test]
fn a_consumed_piece_removes_its_origin_only_when_no_sibling_survives() {
    let pieces = || {
        [
            ob(aabox("t", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "t", 0),
            ob(aabox("t", [20.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "t", 0),
        ]
    };
    let r = apply_body_op(
        BodyOp::Cut,
        &pieces(),
        &[ob(
            aabox("k", [-1.0, -1.0, -1.0], [12.0, 12.0, 12.0]),
            "k",
            1,
        )],
        "g",
    )
    .expect("cut");
    assert!(r.bodies.is_empty());
    assert_eq!(r.untouched, vec![origin("t")]);
    assert!(r.removed.is_empty(), "{:?}", r.removed);
    assert_eq!(notes(&r), vec!["BOOLEAN_BODY_CONSUMED"]);

    // The same with the sibling cut by a second tool (a modified body carries the origin).
    let r = apply_body_op(
        BodyOp::Cut,
        &pieces(),
        &[
            ob(aabox("k", [-1.0, -1.0, -1.0], [12.0, 12.0, 12.0]), "k", 1),
            ob(aabox("n", [25.0, 2.0, 2.0], [2.0, 2.0, 2.0]), "n", 2),
        ],
        "g",
    )
    .expect("cut");
    valid(&r);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("t"));
    assert!(r.untouched.is_empty());
    assert!(r.removed.is_empty(), "{:?}", r.removed);
    assert!(notes(&r).contains(&"BOOLEAN_BODY_CONSUMED"));

    // Both pieces consumed: the origin is removed, once; one note per consumed piece.
    let r = apply_body_op(
        BodyOp::Cut,
        &pieces(),
        &[ob(
            aabox("k", [-1.0, -1.0, -1.0], [32.0, 12.0, 12.0]),
            "k",
            1,
        )],
        "g",
    )
    .expect("cut");
    assert!(r.bodies.is_empty() && r.untouched.is_empty());
    assert_eq!(r.removed, vec![origin("t")]);
    assert_eq!(
        notes(&r),
        vec!["BOOLEAN_BODY_CONSUMED", "BOOLEAN_BODY_CONSUMED"]
    );
}

/// Targets `b` (timeline `tb`) and two pieces of origin `a` (timeline `ta`, the pieces of a
/// split: `[20, 30]` and `[40, 50]` in x), all 10 mm cubes; tool `k` bridges `b` and the
/// first piece of `a`; `extra` tools follow.
fn bridge_join(ta: usize, tb: usize, extra: Vec<OpBody>) -> BodyOpResult {
    let mut tools = vec![ob(aabox("k", [5.0, 2.0, 2.0], [20.0, 6.0, 6.0]), "k", 3)];
    tools.extend(extra);
    let r = apply_body_op(
        BodyOp::Join,
        &[
            ob(aabox("b", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "b", tb),
            ob(aabox("a", [20.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "a", ta),
            ob(aabox("a", [40.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "a", ta),
        ],
        &tools,
        "g",
    )
    .expect("join");
    valid(&r);
    r
}

/// [W0-40] for merges (review finding: forge-regen added every `merged_into` key to
/// `removed`): a piece of `a` merged into `b`'s component while its sibling piece stays
/// untouched. `merged_into` maps `a` to `b` (§6.0.3: every other target origin of the
/// component), but `a` is still carried, so nothing is removed; `removed` is the complete
/// list (consumed and merged origins no operand body carries), the caller adds no
/// `merged_into` key back.
#[test]
fn a_merged_piece_whose_sibling_stays_untouched_removes_nothing() {
    let r = bridge_join(1, 0, Vec::new());
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("b"));
    assert_eq!(r.bodies[0].change, BodyChange::Modified);
    // b ∪ first a piece ∪ the bridge between them (10 × 6 × 6).
    let v = volume(&r.bodies[0].body);
    assert!((v - 2360.0).abs() <= 1e-9 * 2360.0, "volume {v}");
    assert_eq!(r.untouched, vec![origin("a")]);
    assert_eq!(r.untouched_targets, vec![2]);
    assert_eq!(r.merged_into, vec![(origin("a"), origin("b"))]);
    assert!(r.removed.is_empty(), "{:?}", r.removed);
    // Removed ∩ (origins of bodies ∪ untouched) = ∅ ([W0-40]).
    let carried: Vec<&Origin> = r
        .bodies
        .iter()
        .map(|b| &b.origin)
        .chain(&r.untouched)
        .collect();
    assert!(r.removed.iter().all(|o| !carried.contains(&o)));
}

/// The same with the sibling piece joined by a second tool: it is a result body of its own
/// component (`modified`), so `a` is in `bodies` and must not be in `removed`.
#[test]
fn a_merged_piece_whose_sibling_is_a_result_body_removes_nothing() {
    let r = bridge_join(
        1,
        0,
        vec![ob(aabox("n", [42.0, 2.0, 8.0], [6.0, 6.0, 4.0]), "n", 4)],
    );
    let got: Vec<(Origin, BodyChange)> = r
        .bodies
        .iter()
        .map(|b| (b.origin.clone(), b.change))
        .collect();
    assert_eq!(
        got,
        vec![
            (origin("b"), BodyChange::Modified),
            (origin("a"), BodyChange::Modified)
        ]
    );
    let v: Vec<f64> = r.bodies.iter().map(|b| volume(&b.body)).collect();
    assert!((v[0] - 2360.0).abs() <= 1e-9 * 2360.0, "{v:?}");
    // The second piece and the part of `n` above it (6 × 6 × 2).
    assert!((v[1] - 1072.0).abs() <= 1e-9 * 1072.0, "{v:?}");
    assert!(r.untouched.is_empty() && r.untouched_targets.is_empty());
    assert_eq!(r.merged_into, vec![(origin("a"), origin("b"))]);
    assert!(r.removed.is_empty(), "{:?}", r.removed);
}

/// When the component keeps the piece's origin (`a` sorts first) the merged origin `b`
/// vanishes: it is removed, once, while `a` (kept, and carried by the untouched sibling)
/// is not.
#[test]
fn a_merged_origin_no_body_carries_is_removed() {
    let r = bridge_join(0, 1, Vec::new());
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("a"));
    assert_eq!(r.untouched, vec![origin("a")]);
    assert_eq!(r.merged_into, vec![(origin("b"), origin("a"))]);
    assert_eq!(r.removed, vec![origin("b")]);
}

/// Two pieces of one origin merged into another origin's component (review finding: the
/// pair was listed once per piece, `[(a, b), (a, b)]`): `merged_into` maps each other target
/// origin of the component **once** (§6.0.3, [W0-40]), and `a` vanishes: removed once.
#[test]
fn two_pieces_of_one_origin_merged_into_another_are_mapped_once() {
    let r = apply_body_op(
        BodyOp::Join,
        &[
            ob(aabox("b", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "b", 0),
            ob(aabox("a", [20.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "a", 1),
            ob(aabox("a", [35.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "a", 1),
        ],
        &[ob(aabox("k", [5.0, 2.0, 2.0], [40.0, 6.0, 6.0]), "k", 3)],
        "g",
    )
    .expect("join");
    valid(&r);
    assert_eq!(r.bodies.len(), 1);
    assert_eq!(r.bodies[0].origin, origin("b"));
    assert_eq!(r.bodies[0].change, BodyChange::Modified);
    // Three cubes and the tool's parts in the gaps between them (10 + 5 mm of 6 × 6).
    let v = volume(&r.bodies[0].body);
    assert!((v - 3540.0).abs() <= 1e-9 * 3540.0, "volume {v}");
    assert_eq!(r.merged_into, vec![(origin("a"), origin("b"))]);
    assert_eq!(r.removed, vec![origin("a")]);
    assert!(r.untouched.is_empty());
}

/// Three targets joined by one tool: the first in timeline order is kept, the two others are
/// removed once each, in canonical origin order whatever the operand order.
#[test]
fn merged_origins_are_removed_in_canonical_order() {
    let cube = |f: &str, x: f64, t: usize| ob(aabox(f, [x, 0.0, 0.0], [10.0, 10.0, 10.0]), f, t);
    let tool = || vec![ob(aabox("k", [5.0, 2.0, 2.0], [40.0, 6.0, 6.0]), "k", 3)];
    for targets in [
        vec![cube("c", 0.0, 2), cube("a", 20.0, 0), cube("b", 40.0, 1)],
        vec![cube("b", 40.0, 1), cube("c", 0.0, 2), cube("a", 20.0, 0)],
    ] {
        let r = apply_body_op(BodyOp::Join, &targets, &tool(), "g").expect("join");
        valid(&r);
        assert_eq!(r.bodies.len(), 1);
        assert_eq!(r.bodies[0].origin, origin("a"));
        assert_eq!(r.removed, vec![origin("b"), origin("c")]);
        let mut m = r.merged_into.clone();
        m.sort_by(|x, y| x.0.feature.cmp(&y.0.feature));
        assert_eq!(
            m,
            vec![(origin("b"), origin("a")), (origin("c"), origin("a"))]
        );
    }
}

/// CONTRACT QUESTION (review finding; not ruled yet): targets `p` and `q` overlap each other
/// and no tool reaches them, while tool `k` joins target `s`. §6.0.3 (the result bodies are
/// the connected components of T ∪ K) merges `p` and `q`; [W0-39] (a join target is
/// `modified` iff its component contains a tool) would leave both untouched. This pins
/// Forge's reading — merged: `p` modified, `q` merged into it and removed — until the
/// Contract stage rules; flip it (and add an `identity.json` fixture) with the ruling.
#[test]
fn overlapping_targets_without_a_tool_are_merged_pending_a_ruling() {
    let r = apply_body_op(
        BodyOp::Join,
        &[
            ob(aabox("p", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "p", 0),
            ob(aabox("q", [5.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "q", 1),
            ob(aabox("s", [40.0, 0.0, 0.0], [10.0, 10.0, 10.0]), "s", 2),
        ],
        &[ob(aabox("k", [42.0, 2.0, 8.0], [6.0, 6.0, 4.0]), "k", 3)],
        "g",
    )
    .expect("join");
    valid(&r);
    let got: Vec<(Origin, BodyChange)> = r
        .bodies
        .iter()
        .map(|b| (b.origin.clone(), b.change))
        .collect();
    assert_eq!(
        got,
        vec![
            (origin("p"), BodyChange::Modified),
            (origin("s"), BodyChange::Modified)
        ]
    );
    let v = volume(&r.bodies[0].body);
    assert!((v - 1500.0).abs() <= 1e-9 * 1500.0, "volume {v}");
    assert!(r.untouched.is_empty());
    assert_eq!(r.merged_into, vec![(origin("q"), origin("p"))]);
    assert_eq!(r.removed, vec![origin("q")]);
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    /// Any join tool strictly inside its target: the target is `modified`, valid, and keeps
    /// its volume exactly (the union is the target).
    #[test]
    fn nested_join_tools_modify_their_target_and_keep_its_volume(
        size in (2.0f64..20.0, 2.0f64..20.0, 2.0f64..20.0),
        lo in (0.05f64..0.45, 0.05f64..0.45, 0.05f64..0.45),
        frac in (0.1f64..0.5, 0.1f64..0.5, 0.1f64..0.5),
    ) {
        let (sx, sy, sz) = size;
        let target = aabox("t", [0.0, 0.0, 0.0], [sx, sy, sz]);
        let tool = aabox(
            "k",
            [lo.0 * sx, lo.1 * sy, lo.2 * sz],
            [frac.0 * sx, frac.1 * sy, frac.2 * sz],
        );
        let r = apply_body_op(BodyOp::Join, &[ob(target, "t", 0)], &[ob(tool, "k", 1)], "g");
        prop_assert!(r.is_ok(), "{:?}", r.err());
        let r = r.expect("checked");
        valid(&r);
        prop_assert_eq!(r.bodies.len(), 1);
        prop_assert_eq!(r.bodies[0].change, BodyChange::Modified);
        prop_assert!(r.untouched.is_empty() && r.removed.is_empty());
        let v = volume(&r.bodies[0].body);
        let want = sx * sy * sz;
        prop_assert!((v - want).abs() <= 1e-9 * want, "volume {} vs {}", v, want);
    }
}
