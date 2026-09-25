//! Thin verdicts on curved overlaps (review round 5): SPEC [W0-41] (1)–(2) with [W0-48] and
//! [W0-53] decide whether the common part of a cut is a contact (nowhere thicker than the
//! linear tolerance *tol*) or volume. Forge judges it on samples (`boolean::thin`): a
//! witness farther than *tol* proves it thick; a thin verdict is not certified. So a thin
//! verdict may decide an operation only where a wrong one cannot pass silently:
//!
//! - a single tool whose overlap is thin: `BOOLEAN_NO_INTERSECTION` (an explicit outcome);
//! - a tool judged a contact beside another tool that meets the target: the operation would
//!   succeed and silently skip it, so it fails with `FORGE_BOOLEAN_NEAR_COINCIDENT`.
//!
//! The overlaps here are curved and not snapped (SPEC [R-3]'s snap covers aligned faces and
//! the near-tangent pairs `near` lists; crossing cylinders are neither): a y-cylinder of
//! radius `R2` dipping `h` into the top of an x-cylinder of radius `R1`. The common part is
//! a lens whose thickness is exactly `h` (along the common normal through the crossing),
//! so the ruling is known in closed form: a contact iff `h ≤ tol`.

use forge_core::Severity;
use forge_core::topo::Body;
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchCurve, SketchFeature, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};
use proptest::prelude::*;

const TOL: f64 = 1e-6;

fn build(feature: &str, frame: Frame, curves: Vec<SketchCurve>, distance: f64) -> Body {
    Operand {
        feature: feature.into(),
        sketch: SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(frame),
            curves,
        },
        sweep: Sweep::Extrude {
            distance,
            direction: SweepDirection::Symmetric,
        },
    }
    .build()
    .expect("operand")
}

/// Cylinder of radius `r` whose axis is the line through `c` along `axis` (unit, ±X or ±Y),
/// `len` long, centred on `c`.
fn cylinder(feature: &str, c: [f64; 3], axis: [f64; 3], r: f64, len: f64) -> Body {
    let x_dir = if axis[0].abs() > 0.5 {
        [0.0, 1.0, 0.0]
    } else {
        [1.0, 0.0, 0.0]
    };
    build(
        feature,
        Frame {
            origin: c,
            normal: axis,
            x_dir,
        },
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: [0.0, 0.0],
            radius: r,
        }],
        len,
    )
}

/// Axis-aligned box centred on `c` with the given size.
fn cbox(feature: &str, c: [f64; 3], size: [f64; 3]) -> Body {
    let (hx, hy) = (0.5 * size[0], 0.5 * size[1]);
    let pts = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    build(
        feature,
        Frame {
            origin: c,
            normal: [0.0, 0.0, 1.0],
            x_dir: [1.0, 0.0, 0.0],
        },
        (0..4)
            .map(|k| SketchCurve::Line {
                id: format!("e{k}"),
                start: pts[k],
                end: pts[(k + 1) % 4],
            })
            .collect(),
        size[2],
    )
}

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    }
}

/// The target: the x-cylinder of radius `r1` about the X axis, 20 mm long.
fn target(r1: f64) -> Body {
    cylinder("t", [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], r1, 20.0)
}

/// The dipping tool: the y-cylinder of radius `r2` whose bottom lies `h` below the target's
/// top (its axis at height `r1 + r2 − h`, shifted `dx` along X), 20 mm long.
fn dipper(r1: f64, r2: f64, h: f64, dx: f64) -> Body {
    cylinder("k", [dx, 0.0, r1 + r2 - h], [0.0, 1.0, 0.0], r2, 20.0)
}

/// A box that cuts the target's far end (x ∈ [7, 13]) through: a tool that meets it.
fn end_cutter() -> Body {
    cbox("j", [10.0, 0.0, 0.0], [6.0, 30.0, 30.0])
}

fn valid(r: &BodyOpResult) -> bool {
    r.bodies.iter().all(|b| {
        forge_check::validate(&b.body)
            .iter()
            .all(|i| i.severity != Severity::Error)
    })
}

/// A result body has a face from the dipping tool `k` (the dent it cut).
fn dented(r: &BodyOpResult) -> bool {
    r.bodies.iter().any(|b| {
        b.body
            .faces()
            .iter()
            .any(|(_, f)| f.provenance.name().starts_with("k/"))
    })
}

fn cut(tools: Vec<(Body, &str)>, r1: f64) -> Result<BodyOpResult, BooleanError> {
    let tools: Vec<OpBody> = tools
        .into_iter()
        .enumerate()
        .map(|(i, (b, f))| ob(b, f, i + 1))
        .collect();
    apply_body_op(BodyOp::Cut, &[ob(target(r1), "t", 0)], &tools, "g")
}

/// The outcome of the cuts for a lens `h` thick: `None` when it is acceptable, else what is
/// wrong.
fn check(r1: f64, r2: f64, h: f64, dx: f64) -> Option<String> {
    // One tool.
    let one = cut(vec![(dipper(r1, r2, h, dx), "k")], r1);
    match (&one, h > TOL) {
        (Ok(r), true) if valid(r) && dented(r) => {}
        (Err(BooleanError::NearCoincident { .. }), true) => {}
        (Err(BooleanError::NoIntersection { .. }), false) => {}
        (Err(BooleanError::NearCoincident { .. }), false) => {}
        _ => {
            return Some(format!(
                "one tool, h {h:e}: {:?}",
                one.as_ref().map(|r| (r.bodies.len(), valid(r), dented(r)))
            ));
        }
    }
    // Beside a tool that meets the target: a contact must never be skipped silently.
    let two = cut(vec![(dipper(r1, r2, h, dx), "k"), (end_cutter(), "j")], r1);
    match (&two, h > TOL) {
        (Ok(r), true) if valid(r) && dented(r) => None,
        (Err(BooleanError::NearCoincident { .. }), _) => None,
        _ => Some(format!(
            "beside a meeting tool, h {h:e}: {:?}",
            two.as_ref().map(|r| (r.bodies.len(), valid(r), dented(r)))
        )),
    }
}

/// The closed-form cases: lenses from 0.2·tol to 2·tol, and the review's band just above
/// tol.
#[test]
fn crossing_cylinder_lenses_follow_the_ruling_or_fail_explicitly() {
    let mut bad = Vec::new();
    for h in [2e-7, 8e-7, 9.9e-7, 1.01e-6, 1.2e-6, 1.5e-6, 1.9e-6, 2e-6] {
        for (r1, r2) in [(5.0, 5.0), (5.0, 2.0), (20.0, 3.0)] {
            if let Some(e) = check(r1, r2, h, 0.0) {
                bad.push(format!("r1 {r1} r2 {r2}: {e}"));
            }
        }
    }
    assert!(bad.is_empty(), "{bad:#?}");
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 16,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    /// Curved lenses between tol and 2·tol (review round 5): a single cut dents the target
    /// or fails with `FORGE_BOOLEAN_NEAR_COINCIDENT`, never `BOOLEAN_NO_INTERSECTION`; beside
    /// a tool that meets the target the dent is cut or the operation fails explicitly, never
    /// silently skipped.
    #[test]
    fn curved_lenses_thicker_than_tolerance_are_never_skipped_silently(
        h in 1.0005e-6f64..2e-6,
        r1 in 2.0f64..30.0,
        r2 in 1.0f64..30.0,
        dx in -3.0f64..3.0,
    ) {
        prop_assert_eq!(check(r1, r2, h, dx), None);
    }

    /// Curved lenses up to tol: a contact (`BOOLEAN_NO_INTERSECTION` alone, never a cut),
    /// and beside a meeting tool `FORGE_BOOLEAN_NEAR_COINCIDENT` (the verdict is sampled).
    #[test]
    fn curved_lenses_within_tolerance_are_contacts_or_explicit(
        h in 5e-8f64..0.9995e-6,
        r1 in 2.0f64..30.0,
        r2 in 1.0f64..30.0,
        dx in -3.0f64..3.0,
    ) {
        prop_assert_eq!(check(r1, r2, h, dx), None);
    }
}
