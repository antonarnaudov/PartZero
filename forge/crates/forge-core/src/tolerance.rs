//! Named, explicit modelling tolerances.
//!
//! Forge never hides a magic epsilon inside a topological decision. Combinatorial
//! decisions use exact predicates ([`crate::predicates`]); where a *modelling* tolerance
//! is genuinely needed (are two points "the same vertex"? is an edge degenerate?), it
//! comes from a [`Tolerance`] value that is passed explicitly and recorded on the
//! entities it applies to (`Vertex::tolerance`, `Edge::tolerance`).

use crate::linalg::{Point3, Vec3};

/// Modelling tolerances.
///
/// - `linear` (mm): two points closer than this are the same point; a length at or below
///   it is degenerate; a point within it of a curve or surface lies on it.
/// - `angular` (radians): two directions whose angle is at most this are parallel; a
///   sweep angle at or below it is degenerate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tolerance {
    /// Linear tolerance in millimetres.
    pub linear: f64,
    /// Angular tolerance in radians.
    pub angular: f64,
}

/// The IR's normative linear tolerance in mm (`forge_ir::LINEAR_TOLERANCE`, SPEC §1).
///
/// Duplicated here so `forge-core` does not depend on the IR crate; a test asserts that
/// the two constants are identical.
pub const IR_LINEAR_TOLERANCE: f64 = 1e-6;

/// Default angular tolerance in radians.
pub const DEFAULT_ANGULAR_TOLERANCE: f64 = 1e-9;

impl Tolerance {
    /// The tolerances implied by the IR v0 semantics: linear `1e-6` mm (identical to
    /// `forge_ir::LINEAR_TOLERANCE`) and angular `1e-9` rad.
    pub const IR_DEFAULT: Tolerance = Tolerance {
        linear: IR_LINEAR_TOLERANCE,
        angular: DEFAULT_ANGULAR_TOLERANCE,
    };

    /// Build a tolerance; both values must be finite and positive.
    pub fn new(linear: f64, angular: f64) -> Option<Self> {
        let ok = |x: f64| x.is_finite() && x > 0.0;
        (ok(linear) && ok(angular)).then_some(Self { linear, angular })
    }
    /// `true` if `a` and `b` are the same point (`|a − b| <= linear`).
    pub fn points_coincide(&self, a: Point3, b: Point3) -> bool {
        a.distance(b) <= self.linear
    }
    /// `true` if a length is degenerate (`len <= linear`).
    pub fn is_degenerate_length(&self, len: f64) -> bool {
        len <= self.linear
    }
    /// `true` if the (non-zero) directions `a` and `b` are parallel or anti-parallel
    /// within `angular`. Zero vectors are never parallel to anything.
    pub fn directions_parallel(&self, a: Vec3, b: Vec3) -> bool {
        match (a.normalize(), b.normalize()) {
            (Some(a), Some(b)) => a.cross(b).norm() <= crate::math::sin(self.angular),
            _ => false,
        }
    }
    /// `true` if the (non-zero) directions are perpendicular within `angular`.
    pub fn directions_perpendicular(&self, a: Vec3, b: Vec3) -> bool {
        match (a.normalize(), b.normalize()) {
            (Some(a), Some(b)) => a.dot(b).abs() <= crate::math::sin(self.angular),
            _ => false,
        }
    }
}

/// `true` iff `value <= bound`. NaN is never within any bound, so a failed computation
/// can never pass a tolerance check.
#[inline]
pub fn is_within(value: f64, bound: f64) -> bool {
    value <= bound
}

impl Default for Tolerance {
    fn default() -> Self {
        Self::IR_DEFAULT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ir_default_values() {
        assert_eq!(Tolerance::IR_DEFAULT.linear.to_bits(), 1e-6f64.to_bits());
        assert_eq!(Tolerance::IR_DEFAULT.angular.to_bits(), 1e-9f64.to_bits());
    }

    #[test]
    fn coincidence_and_parallelism() {
        let t = Tolerance::IR_DEFAULT;
        assert!(t.points_coincide(Vec3::new(1.0, 2.0, 3.0), Vec3::new(1.0, 2.0, 3.0 + 5e-7)));
        assert!(!t.points_coincide(Vec3::new(1.0, 2.0, 3.0), Vec3::new(1.0, 2.0, 3.0 + 2e-6)));
        assert!(t.directions_parallel(Vec3::unit_z(), Vec3::new(0.0, 0.0, -3.0)));
        assert!(!t.directions_parallel(Vec3::unit_z(), Vec3::new(1e-6, 0.0, 1.0)));
        assert!(!t.directions_parallel(Vec3::zero(), Vec3::unit_x()));
        assert!(t.directions_perpendicular(Vec3::unit_z(), Vec3::unit_x()));
        assert!(Tolerance::new(0.0, 1.0).is_none() && Tolerance::new(1e-3, 1e-6).is_some());
    }
}
