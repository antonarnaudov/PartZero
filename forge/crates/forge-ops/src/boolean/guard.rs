//! Last-line checks on every result body of a two-solid boolean, independent of how the
//! body was built: a body that fails them is an error (`FORGE_BOOLEAN_INVALID_RESULT`),
//! never a returned body.
//!
//! 1. **Validity** (`forge_check::validate`): closed, oriented shells, Euler, geometry on
//!    surfaces, pcurves, every face domain of positive area, positive signed volume. The
//!    topological `forge_core::topo::validate` that assembly and unify already run does
//!    not see an inside-out face (a loop wound the wrong way on a sphere) or a negative
//!    volume.
//! 2. **Volume bounds** of the operation, from exact mass properties of the operands and
//!    the results: `max(vA, vB) ≤ vol(A ∪ B) ≤ vA + vB`, `vA − vB ≤ vol(A − B) ≤ vA`,
//!    `vol(A ∩ B) ≤ min(vA, vB)`, within `VOLUME_GUARD_REL · (vA + vB) +
//!    VOLUME_GUARD_AREA · (area A + area B)`. They catch gross failures (a cut that adds a
//!    closed copy of a tool surface, a result that lost a face) whatever their cause;
//!    fitted boundaries move volumes by far less than the slack. An operand forge-check
//!    cannot measure keeps the one-sided bounds of the measured operand, and the result is
//!    marked `uncertified` (never a silently skipped check).

use forge_core::topo::{Body, Severity};

use super::BodyOp;
use super::error::BooleanError;

/// Relative slack of the volume bounds (of `vA + vB`).
pub(crate) const VOLUME_GUARD_REL: f64 = 1e-7;
/// Slack of the volume bounds per unit of operand area (mm): ten times the SSI fit
/// tolerance, the largest distance a fitted boundary lies from the exact one.
pub(crate) const VOLUME_GUARD_AREA: f64 = 1e-6;

/// `forge_check` validity (one analysis pass, [`forge_check::body_metrics`]) and a positive,
/// finite volume. Returns the body's `(volume, area)`.
pub(crate) fn valid_result(body: &Body) -> Result<(f64, f64), BooleanError> {
    let bm = forge_check::body_metrics(body).map_err(|e| BooleanError::InvalidResult {
        issues: vec![format!(
            "mass properties of a result body: {} ({e})",
            e.code()
        )],
    })?;
    if !bm.valid {
        let issues: Vec<String> = forge_check::validate(body)
            .into_iter()
            .filter(|i| i.severity == Severity::Error)
            .map(|i| i.to_string())
            .collect();
        if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
            eprintln!("result guard: invalid body");
            super::debug_dump(body);
        }
        return Err(BooleanError::InvalidResult { issues });
    }
    if bm.volume.is_finite() && bm.volume > 0.0 {
        Ok((bm.volume, bm.area))
    } else {
        Err(BooleanError::InvalidResult {
            issues: vec![format!(
                "result body has a non-positive volume {:e} mm³",
                bm.volume
            )],
        })
    }
}

/// `(volume, area)` of an operand: `known`, or measured.
pub(crate) fn mass(b: &Body, known: Option<(f64, f64)>) -> Result<(f64, f64), BooleanError> {
    if let Some(m) = known {
        return Ok(m);
    }
    forge_check::mass_properties(b)
        .map(|mp| (mp.volume, mp.area))
        .map_err(|e| BooleanError::InvalidResult {
            issues: vec![format!("mass properties of an operand: {} ({e})", e.code())],
        })
}

/// The volume bounds of `A op B` (see the module docs), given the results' `(volume,
/// area)`. Returns `true` when both operands were measured and every bound was checked.
///
/// An operand forge-check cannot measure (a torus minus disks) does not switch the check
/// off: the bounds that involve only the measured operand are still enforced (a join is at
/// least as large as a measured operand, a cut at most the measured target, an
/// intersection at most either measured operand), with the results' area in the slack in
/// place of the unmeasured operand's; the caller marks the result `uncertified`.
pub(crate) fn volumes(
    op: BodyOp,
    (a, ma): (&Body, Option<(f64, f64)>),
    (b, mb): (&Body, Option<(f64, f64)>),
    results: &[Option<(f64, f64)>],
) -> Result<bool, BooleanError> {
    let (ra, rb) = (mass(a, ma).ok(), mass(b, mb).ok());
    let v: f64 = results.iter().flatten().map(|x| x.0).sum();
    let result_area: f64 = results.iter().flatten().map(|x| x.1).sum();
    let what = match op {
        BodyOp::Join => "join",
        BodyOp::Cut => "cut",
        BodyOp::Intersect => "intersect",
    };
    let out_of = |lo: f64, hi: f64, slack: f64| -> Result<(), BooleanError> {
        if v < lo - slack || v > hi + slack {
            return Err(BooleanError::InvalidResult {
                issues: vec![format!(
                    "{what} result volume {v:e} mm³ outside [{lo:e}, {hi:e}] (operands {}, {} mm³)",
                    ra.map_or("unmeasured".to_string(), |x| format!("{:e}", x.0)),
                    rb.map_or("unmeasured".to_string(), |x| format!("{:e}", x.0)),
                )],
            });
        }
        Ok(())
    };
    match (ra, rb) {
        (Some((va, aa)), Some((vb, ab))) => {
            let slack = VOLUME_GUARD_REL * (va.abs() + vb.abs()) + VOLUME_GUARD_AREA * (aa + ab);
            let (lo, hi) = match op {
                BodyOp::Join => (va.max(vb), va + vb),
                BodyOp::Cut => (va - vb, va),
                BodyOp::Intersect => (0.0, va.min(vb)),
            };
            out_of(lo, hi, slack)?;
            Ok(true)
        }
        (known_a, known_b) => {
            // One-sided bounds from what is measured.
            let slack_of = |known: (f64, f64)| {
                VOLUME_GUARD_REL * (known.0.abs() + v.abs())
                    + VOLUME_GUARD_AREA * (known.1 + result_area)
            };
            if let Some(ka) = known_a {
                let s = slack_of(ka);
                match op {
                    BodyOp::Join => out_of(ka.0, f64::INFINITY, s)?,
                    BodyOp::Cut | BodyOp::Intersect => out_of(0.0, ka.0, s)?,
                }
            }
            if let Some(kb) = known_b {
                let s = slack_of(kb);
                match op {
                    BodyOp::Join => out_of(kb.0, f64::INFINITY, s)?,
                    BodyOp::Intersect => out_of(0.0, kb.0, s)?,
                    BodyOp::Cut => {}
                }
            }
            Ok(false)
        }
    }
}
