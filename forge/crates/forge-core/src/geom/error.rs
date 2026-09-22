//! Geometry construction errors.

use thiserror::Error;

/// A curve or surface could not be constructed. Every variant has a stable
/// machine-readable [`GeomError::code`].
#[derive(Debug, Clone, PartialEq, Error)]
pub enum GeomError {
    /// A direction (axis, normal, x direction) is zero, non-finite, or parallel to
    /// another direction it must be independent of.
    #[error("degenerate direction: {what}")]
    DegenerateDirection {
        /// Which input was degenerate.
        what: &'static str,
    },
    /// A scalar parameter is outside its valid range.
    #[error("invalid {what} = {value}: must be {expected}")]
    InvalidParameter {
        /// Parameter name.
        what: &'static str,
        /// The rejected value.
        value: f64,
        /// Human-readable valid range, e.g. `"> 0"` or `"in (0, π/2)"`.
        expected: &'static str,
    },
    /// A point or vector input is not finite.
    #[error("non-finite {what}")]
    NonFinite {
        /// Which input was non-finite.
        what: &'static str,
    },
    /// Invalid B-spline data.
    #[error(transparent)]
    Nurbs(#[from] NurbsError),
}

impl GeomError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            GeomError::DegenerateDirection { .. } => "GEOM_DEGENERATE_DIRECTION",
            GeomError::InvalidParameter { .. } => "GEOM_INVALID_PARAMETER",
            GeomError::NonFinite { .. } => "GEOM_NON_FINITE",
            GeomError::Nurbs(e) => e.code(),
        }
    }
}

/// Invalid NURBS data. Every variant has a stable machine-readable
/// [`NurbsError::code`].
#[derive(Debug, Clone, PartialEq, Error)]
pub enum NurbsError {
    /// Degree must be at least 1.
    #[error("degree must be >= 1 (got {degree})")]
    InvalidDegree {
        /// The rejected degree.
        degree: usize,
    },
    /// Fewer than `degree + 1` control points.
    #[error("need at least {min} control points, got {got}")]
    TooFewControlPoints {
        /// `degree + 1`.
        min: usize,
        /// Actual count.
        got: usize,
    },
    /// The knot vector length is not `control points + degree + 1`.
    #[error("knot vector must have {expected} knots, got {got}")]
    KnotCountMismatch {
        /// Required count.
        expected: usize,
        /// Actual count.
        got: usize,
    },
    /// Knots decrease at `index`.
    #[error("knots must be non-decreasing (violated at index {index})")]
    KnotsDecreasing {
        /// First index `i` with `knots[i] < knots[i-1]`.
        index: usize,
    },
    /// A knot's multiplicity is too high (interior knots: at most `degree`; end knots: at
    /// most `degree + 1`).
    #[error("knot {value} has multiplicity {multiplicity} (max {max})")]
    KnotMultiplicity {
        /// Knot value.
        value: f64,
        /// Its multiplicity.
        multiplicity: usize,
        /// Maximum allowed.
        max: usize,
    },
    /// The parameter domain `[knots[p], knots[n+1]]` is empty.
    #[error("parameter domain is empty")]
    EmptyDomain,
    /// Weight count differs from control point count.
    #[error("expected {expected} weights, got {got}")]
    WeightCountMismatch {
        /// Required count.
        expected: usize,
        /// Actual count.
        got: usize,
    },
    /// A weight is not finite and strictly positive.
    #[error("weight {index} must be finite and > 0 (got {value})")]
    InvalidWeight {
        /// Index of the weight.
        index: usize,
        /// The rejected value.
        value: f64,
    },
    /// A knot, control point or weight is NaN or infinite.
    #[error("non-finite value in {what}")]
    NonFinite {
        /// Which array.
        what: &'static str,
    },
    /// The control net size of a surface does not match `n_u × n_v`.
    #[error("control net must have {expected} points, got {got}")]
    NetSizeMismatch {
        /// `n_u · n_v`.
        expected: usize,
        /// Actual count.
        got: usize,
    },
    /// Knot insertion outside the open parameter domain.
    #[error("knot {value} is outside the open domain ({min}, {max})")]
    KnotOutOfDomain {
        /// Requested knot.
        value: f64,
        /// Domain start.
        min: f64,
        /// Domain end.
        max: f64,
    },
    /// Knot insertion would raise the multiplicity above the degree.
    #[error("inserting knot {value} {times} time(s) would exceed multiplicity {max}")]
    InsertionExceedsDegree {
        /// Requested knot.
        value: f64,
        /// Requested insertion count.
        times: usize,
        /// Maximum multiplicity (the degree).
        max: usize,
    },
    /// An error in one parametric direction of a surface.
    #[error("{direction} direction: {inner}")]
    Direction {
        /// `"u"` or `"v"`.
        direction: &'static str,
        /// The underlying error.
        inner: Box<NurbsError>,
    },
}

impl NurbsError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            NurbsError::InvalidDegree { .. } => "NURBS_INVALID_DEGREE",
            NurbsError::TooFewControlPoints { .. } => "NURBS_TOO_FEW_CONTROL_POINTS",
            NurbsError::KnotCountMismatch { .. } => "NURBS_KNOT_COUNT_MISMATCH",
            NurbsError::KnotsDecreasing { .. } => "NURBS_KNOTS_DECREASING",
            NurbsError::KnotMultiplicity { .. } => "NURBS_KNOT_MULTIPLICITY",
            NurbsError::EmptyDomain => "NURBS_EMPTY_DOMAIN",
            NurbsError::WeightCountMismatch { .. } => "NURBS_WEIGHT_COUNT_MISMATCH",
            NurbsError::InvalidWeight { .. } => "NURBS_INVALID_WEIGHT",
            NurbsError::NonFinite { .. } => "NURBS_NON_FINITE",
            NurbsError::NetSizeMismatch { .. } => "NURBS_NET_SIZE_MISMATCH",
            NurbsError::KnotOutOfDomain { .. } => "NURBS_KNOT_OUT_OF_DOMAIN",
            NurbsError::InsertionExceedsDegree { .. } => "NURBS_INSERTION_EXCEEDS_DEGREE",
            NurbsError::Direction { inner, .. } => inner.code(),
        }
    }
}

/// Check a positive, finite length parameter.
pub(crate) fn check_positive(what: &'static str, value: f64) -> Result<f64, GeomError> {
    if value.is_finite() && value > 0.0 {
        Ok(value)
    } else {
        Err(GeomError::InvalidParameter {
            what,
            value,
            expected: "finite and > 0",
        })
    }
}
