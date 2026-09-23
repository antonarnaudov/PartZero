//! Structured intersection errors.
//!
//! Every error carries a stable machine-readable [`SsiError::code`] and the context an
//! agent (or the boolean that called SSI) needs to explain or repair the failure: where
//! it happened (3D point and parameters on both operands), the measured quantity (gap,
//! residual, achieved error) and the limit it was compared against.

use thiserror::Error;

/// Which input an error refers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Operand {
    /// The first surface (`a`).
    A,
    /// The second surface (`b`).
    B,
    /// The curve of a curve–surface intersection.
    Curve,
    /// The surface of a curve–surface intersection.
    Surface,
}

/// An intersection could not be computed within its contract.
///
/// SSI never returns a silently incomplete or inaccurate result: when a branch cannot be
/// traced, a tangential region cannot be resolved or a fit cannot meet
/// [`SsiTolerance::fit`](crate::SsiTolerance::fit), one of these errors is returned
/// instead.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum SsiError {
    /// A parameter range is empty, inverted, non-finite, or wider than the period of a
    /// periodic parameter.
    #[error("invalid {param} range [{lo}, {hi}] for {operand:?}: {reason}")]
    InvalidDomain {
        /// Which input.
        operand: Operand,
        /// `"u"`, `"v"` or `"t"`.
        param: &'static str,
        /// Lower bound given.
        lo: f64,
        /// Upper bound given.
        hi: f64,
        /// What is wrong.
        reason: &'static str,
    },
    /// A tolerance is not finite and positive, or the tolerances are inconsistent.
    #[error("invalid tolerance {what} = {value}: {expected}")]
    InvalidTolerance {
        /// Field name.
        what: &'static str,
        /// Value given.
        value: f64,
        /// Valid range.
        expected: &'static str,
    },
    /// The geometry type is not supported yet (e.g. B-spline surfaces).
    #[error("unsupported {operand:?}: {what}")]
    Unsupported {
        /// Which input.
        operand: Operand,
        /// What is unsupported.
        what: &'static str,
    },
    /// A tangential or near-tangential contact region could not be classified as an
    /// isolated contact point, a branch crossing, or a certified miss (for example the
    /// two surfaces are tangent along a whole curve that no closed form covers).
    #[error(
        "tangential contact near {point:?} unresolved (gap {gap:e} mm over a region of {extent:e} mm, {branch_ends} branch ends)"
    )]
    TangentUnresolved {
        /// Representative 3D point of the region.
        point: [f64; 3],
        /// Its parameters on surface `a` (or the curve parameter and 0).
        uv_a: [f64; 2],
        /// Its parameters on surface `b`.
        uv_b: [f64; 2],
        /// Smallest separation of the surfaces found in the region (mm).
        gap: f64,
        /// Diameter of the unresolved region (mm).
        extent: f64,
        /// Number of traced branches ending in the region.
        branch_ends: usize,
    },
    /// An iterative stage (Newton projection, marching step, root refinement) did not
    /// converge.
    #[error(
        "{stage} did not converge near {point:?} (residual {residual:e} after {iterations} iterations)"
    )]
    NotConverged {
        /// Which stage (`"march"`, `"corrector"`, `"root refinement"`, …).
        stage: &'static str,
        /// Where (3D).
        point: [f64; 3],
        /// Last residual (mm).
        residual: f64,
        /// Iterations spent.
        iterations: u32,
    },
    /// A branch could not be represented by a B-spline within the fit tolerance.
    #[error(
        "B-spline fit of a {what} reached {achieved:e} mm (> {required:e} mm) with {spans} spans"
    )]
    FitFailed {
        /// `"3d curve"`, `"pcurve a"` or `"pcurve b"`.
        what: &'static str,
        /// Best certified error bound reached (mm).
        achieved: f64,
        /// Required bound (mm).
        required: f64,
        /// Spans used when giving up.
        spans: usize,
    },
    /// A work budget (subdivision cells, marching steps) was exhausted.
    #[error("{what} budget of {limit} exhausted")]
    BudgetExceeded {
        /// Which budget.
        what: &'static str,
        /// The limit.
        limit: usize,
    },
    /// Internal bookkeeping found an inconsistency (a traced branch did not match the
    /// certified cell crossings). Always a bug or an extreme configuration; reported
    /// rather than guessed around.
    #[error("inconsistent intersection topology: {detail} near {point:?}")]
    Inconsistent {
        /// What went wrong.
        detail: &'static str,
        /// Where (3D).
        point: [f64; 3],
    },
}

impl SsiError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            SsiError::InvalidDomain { .. } => "SSI_INVALID_DOMAIN",
            SsiError::InvalidTolerance { .. } => "SSI_INVALID_TOLERANCE",
            SsiError::Unsupported { .. } => "SSI_UNSUPPORTED",
            SsiError::TangentUnresolved { .. } => "SSI_TANGENT_UNRESOLVED",
            SsiError::NotConverged { .. } => "SSI_NOT_CONVERGED",
            SsiError::FitFailed { .. } => "SSI_FIT_FAILED",
            SsiError::BudgetExceeded { .. } => "SSI_BUDGET_EXCEEDED",
            SsiError::Inconsistent { .. } => "SSI_INCONSISTENT",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_stable_and_distinct() {
        let errs = [
            SsiError::InvalidDomain {
                operand: Operand::A,
                param: "u",
                lo: 1.0,
                hi: 0.0,
                reason: "inverted",
            },
            SsiError::InvalidTolerance {
                what: "fit",
                value: -1.0,
                expected: "> 0",
            },
            SsiError::Unsupported {
                operand: Operand::B,
                what: "b-spline surface",
            },
            SsiError::TangentUnresolved {
                point: [0.0; 3],
                uv_a: [0.0; 2],
                uv_b: [0.0; 2],
                gap: 0.0,
                extent: 1.0,
                branch_ends: 0,
            },
            SsiError::NotConverged {
                stage: "march",
                point: [0.0; 3],
                residual: 1.0,
                iterations: 3,
            },
            SsiError::FitFailed {
                what: "3d curve",
                achieved: 1.0,
                required: 1e-7,
                spans: 4,
            },
            SsiError::BudgetExceeded {
                what: "cells",
                limit: 10,
            },
            SsiError::Inconsistent {
                detail: "x",
                point: [0.0; 3],
            },
        ];
        let codes: Vec<_> = errs.iter().map(SsiError::code).collect();
        let mut sorted = codes.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), codes.len());
        assert!(codes.iter().all(|c| c.starts_with("SSI_")));
        assert!(errs[3].to_string().contains("unresolved"));
    }
}
