//! Named, explicit tolerances of the intersection contract.

use crate::error::SsiError;
use forge_core::tolerance::IR_LINEAR_TOLERANCE;

/// Default [`SsiTolerance::fit`]: 1e-7 mm.
pub const DEFAULT_FIT_TOLERANCE: f64 = 1e-7;
/// Default [`SsiTolerance::resolution`]: cells of the certified subdivision are refined
/// down to `1e-5 ×` the problem size before a region is treated as a contact cluster.
pub const DEFAULT_RESOLUTION: f64 = 1e-5;
/// Default [`SsiTolerance::max_cells`].
pub const DEFAULT_MAX_CELLS: usize = 400_000;

/// Tolerances of an intersection query.
///
/// | Field | Meaning |
/// |---|---|
/// | `fit` | **Output contract.** Every returned 3D curve point lies within `fit` of both surfaces; every pcurve maps onto its 3D curve within `fit` (`|S(pcurve(t)) − C(t)| <= fit`); every returned point lies within `fit` of both operands. It is also the gap below which two surfaces (or a curve and a surface) are declared *tangent* rather than disjoint or crossing twice. |
/// | `linear` | Modelling tolerance (IR `LINEAR_TOLERANCE`, 1e-6 mm). Used only for reporting: contacts whose separation is below it are flagged as near-tangent for the boolean. It never changes the returned geometry. |
/// | `resolution` | Relative size (to the problem's bounding box) of the smallest cell of the certified subdivision. Regions that cannot be certified regular at this size are resolved as contact clusters. |
/// | `max_cells` | Work budget for the subdivision; exceeding it is an error, never a silent cut-off. |
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SsiTolerance {
    /// Output accuracy and tangency snap distance (mm). Default 1e-7.
    pub fit: f64,
    /// Modelling tolerance (mm), for near-tangency flags. Default 1e-6.
    pub linear: f64,
    /// Smallest subdivision cell relative to the problem size. Default 1e-5.
    pub resolution: f64,
    /// Maximum number of subdivision cells. Default 400 000.
    pub max_cells: usize,
}

impl Default for SsiTolerance {
    fn default() -> Self {
        Self {
            fit: DEFAULT_FIT_TOLERANCE,
            linear: IR_LINEAR_TOLERANCE,
            resolution: DEFAULT_RESOLUTION,
            max_cells: DEFAULT_MAX_CELLS,
        }
    }
}

impl SsiTolerance {
    /// Check that every field is finite and positive and `resolution < 0.01`.
    pub fn validate(&self) -> Result<(), SsiError> {
        let pos = |what: &'static str, value: f64| {
            if value.is_finite() && value > 0.0 {
                Ok(())
            } else {
                Err(SsiError::InvalidTolerance {
                    what,
                    value,
                    expected: "finite and > 0",
                })
            }
        };
        pos("fit", self.fit)?;
        pos("linear", self.linear)?;
        pos("resolution", self.resolution)?;
        if self.resolution >= 0.01 {
            return Err(SsiError::InvalidTolerance {
                what: "resolution",
                value: self.resolution,
                expected: "< 0.01",
            });
        }
        if self.max_cells < 64 {
            return Err(SsiError::InvalidTolerance {
                what: "max_cells",
                value: self.max_cells as f64,
                expected: ">= 64",
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_valid_and_match_the_ir() {
        let t = SsiTolerance::default();
        t.validate().expect("valid");
        assert_eq!(t.linear.to_bits(), 1e-6f64.to_bits());
        assert_eq!(t.fit.to_bits(), 1e-7f64.to_bits());
    }

    #[test]
    fn invalid_values_are_rejected_with_codes() {
        let mut t = SsiTolerance {
            fit: f64::NAN,
            ..SsiTolerance::default()
        };
        assert_eq!(t.validate().unwrap_err().code(), "SSI_INVALID_TOLERANCE");
        t.fit = 1e-7;
        t.resolution = 0.5;
        assert!(t.validate().is_err());
    }
}
