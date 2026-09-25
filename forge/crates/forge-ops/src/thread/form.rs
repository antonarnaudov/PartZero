//! The thread form: the ISO 68-1 / ASME B1.1 basic profile (60°) as numbers.
//!
//! ```text
//!   H = P·√3/2                   fundamental triangle height
//!   D1 = D − 2·(5/8)·H           basic minor diameter (D − 1.082532·P)
//!   internal (nut):  root at D/2,  root flat P/8, groove width w(r) = P/8 + 2·(D/2 − r)·tan 30°
//!   external (bolt): root at D1/2, root flat P/4, groove width w(r) = P/4 + 2·(r − D1/2)·tan 30°
//! ```
//! The crest is the threaded cylinder itself (the bore of a nut, the boss of a bolt): at the
//! basic diameters (D1 for a nut, D for a bolt) the crest flat is P/4 (nut) or P/8 (bolt),
//! exactly the basic profile; other crest diameters truncate or extend the same flanks (a tap
//! drill larger than D1 leaves a wider crest). The crest flat must stay positive and the
//! groove must have depth: [`ThreadForm::crest_range`].
//!
//! Nominal geometry only: fits, tolerance classes and FDM compensation are not in the form
//! (ADR 0013 decision 1, like `HOLE_SIZES`).

use forge_core::math;

use super::error::ThreadError;

/// Which side of the cylinder the material is on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadKind {
    /// A nut thread: the groove is cut outwards from a bore.
    Internal,
    /// A bolt thread: the groove is cut inwards from a boss.
    External,
}

impl ThreadKind {
    /// `"internal"` / `"external"`.
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadKind::Internal => "internal",
            ThreadKind::External => "external",
        }
    }
}

/// A single-profile thread form (60° basic profile).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ThreadForm {
    /// Nut or bolt.
    pub kind: ThreadKind,
    /// Basic major diameter `D` (mm).
    pub major: f64,
    /// Pitch `P` (mm): the axial distance between adjacent grooves.
    pub pitch: f64,
    /// Number of starts (the lead is `starts·P`).
    pub starts: u32,
    /// Right-hand thread (advances along the axis turning counter-clockwise about it).
    pub right_hand: bool,
}

/// Smallest crest flat, as a fraction of the pitch, a thread may keep (below it the crest is
/// a knife edge a printer cannot hold and the B-rep a sliver).
pub const MIN_CREST_FLAT: f64 = 0.02;

impl ThreadForm {
    /// `tan 30°`, the flank slope.
    pub fn tan_half_angle() -> f64 {
        1.0 / math::sqrt(3.0)
    }
    /// Fundamental triangle height `H = P·√3/2`.
    pub fn fundamental_height(&self) -> f64 {
        self.pitch * math::sqrt(3.0) * 0.5
    }
    /// Basic minor diameter `D1 = D − (5/4)·H`.
    pub fn basic_minor(&self) -> f64 {
        self.major - 1.25 * self.fundamental_height()
    }
    /// Basic pitch diameter `D2 = D − (3/4)·H`.
    pub fn pitch_diameter(&self) -> f64 {
        self.major - 0.75 * self.fundamental_height()
    }
    /// Radius of the groove's root flat: `D/2` (nut) or `D1/2` (bolt).
    pub fn root_radius(&self) -> f64 {
        match self.kind {
            ThreadKind::Internal => 0.5 * self.major,
            ThreadKind::External => 0.5 * self.basic_minor(),
        }
    }
    /// Axial width of the root flat: `P/8` (nut) or `P/4` (bolt).
    pub fn root_flat(&self) -> f64 {
        match self.kind {
            ThreadKind::Internal => 0.125 * self.pitch,
            ThreadKind::External => 0.25 * self.pitch,
        }
    }
    /// The lead `starts·P`.
    pub fn lead(&self) -> f64 {
        self.starts as f64 * self.pitch
    }
    /// Axial advance per radian, signed: positive for a right-hand thread.
    pub fn rise(&self) -> f64 {
        let r = self.lead() / math::TAU;
        if self.right_hand { r } else { -r }
    }
    /// Axial width of the groove at radius `r`.
    pub fn groove_width(&self, r: f64) -> f64 {
        self.root_flat() + 2.0 * (self.root_radius() - r).abs() * Self::tan_half_angle()
    }
    /// `+1` for a nut (the root is outside the crest), `−1` for a bolt.
    pub fn sigma(&self) -> f64 {
        match self.kind {
            ThreadKind::Internal => 1.0,
            ThreadKind::External => -1.0,
        }
    }
    /// The feasible crest diameters `[min, max]`: the crest flat is at least
    /// [`MIN_CREST_FLAT`]·P and the groove at least as deep as the root flat is wide.
    pub fn crest_range(&self) -> (f64, f64) {
        let t = Self::tan_half_angle();
        // Crest flat P − w(r) ≥ ε·P  ⇔  |R_r − r| ≤ (P(1 − ε) − root_flat) / (2 tan α).
        let reach = (self.pitch * (1.0 - MIN_CREST_FLAT) - self.root_flat()) / (2.0 * t);
        let depth = self.root_flat();
        let rr = self.root_radius();
        match self.kind {
            ThreadKind::Internal => (2.0 * (rr - reach), 2.0 * (rr - depth)),
            ThreadKind::External => (2.0 * (rr + depth), 2.0 * (rr + reach)),
        }
    }
    /// A short designation for messages, e.g. `D 12.7 × P 1.27`.
    pub fn designation(&self) -> String {
        let mut s = format!("D {} × P {}", self.major, self.pitch);
        if self.starts > 1 {
            s.push_str(&format!(" ({} starts)", self.starts));
        }
        if !self.right_hand {
            s.push_str(" LH");
        }
        s
    }
    /// Check the numbers (`THREAD_INVALID_VALUE`).
    pub fn validate(&self) -> Result<(), ThreadError> {
        let bad = |field: &str, value: f64, expected: &str| ThreadError::InvalidValue {
            field: field.into(),
            value,
            expected: expected.into(),
        };
        if !(self.pitch.is_finite() && self.pitch > 1e-3) {
            return Err(bad("pitch", self.pitch, "> 0.001 mm"));
        }
        if !(self.major.is_finite() && self.major > 2.0 * self.pitch) {
            return Err(bad("major", self.major, "> 2 × pitch"));
        }
        if self.starts == 0 || self.starts > 8 {
            return Err(bad("starts", self.starts as f64, "an integer in [1, 8]"));
        }
        Ok(())
    }
    /// Check a crest diameter against [`ThreadForm::crest_range`]
    /// (`THREAD_DIAMETER_MISMATCH`).
    pub fn check_crest(&self, d: f64) -> Result<(), ThreadError> {
        let (lo, hi) = self.crest_range();
        if d >= lo && d <= hi {
            Ok(())
        } else {
            Err(ThreadError::DiameterMismatch {
                kind: self.kind.as_str(),
                designation: self.designation(),
                d,
                min_d: lo,
                max_d: hi,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m8(kind: ThreadKind) -> ThreadForm {
        ThreadForm {
            kind,
            major: 8.0,
            pitch: 1.25,
            starts: 1,
            right_hand: true,
        }
    }

    #[test]
    fn basic_profile_numbers_match_iso_68_1() {
        let f = m8(ThreadKind::Internal);
        // ISO 724: M8 D1 = 6.647, D2 = 7.188.
        assert!((f.basic_minor() - 6.647).abs() < 5e-4);
        assert!((f.pitch_diameter() - 7.188).abs() < 5e-4);
        // Internal: crest flat P/4 at D1, root flat P/8 at D.
        assert!((f.groove_width(0.5 * f.basic_minor()) - 0.75 * 1.25).abs() < 1e-12);
        assert!((f.groove_width(4.0) - 0.125 * 1.25).abs() < 1e-12);
        // The groove is half the pitch at the pitch diameter.
        assert!((f.groove_width(0.5 * f.pitch_diameter()) - 0.625).abs() < 1e-12);
        let e = m8(ThreadKind::External);
        assert!((e.groove_width(4.0) - 0.875 * 1.25).abs() < 1e-12);
        assert!((e.groove_width(0.5 * e.basic_minor()) - 0.25 * 1.25).abs() < 1e-12);
        assert!((e.groove_width(0.5 * e.pitch_diameter()) - 0.625).abs() < 1e-12);
    }

    #[test]
    fn crest_range_admits_the_basic_and_tap_drill_diameters() {
        let f = m8(ThreadKind::Internal);
        f.check_crest(f.basic_minor()).unwrap();
        f.check_crest(6.8).unwrap(); // ISO 2306 tap drill
        assert!(f.check_crest(8.0).is_err());
        assert!(f.check_crest(5.0).is_err());
        let e = m8(ThreadKind::External);
        e.check_crest(8.0).unwrap();
        e.check_crest(7.8).unwrap();
        assert!(e.check_crest(e.basic_minor()).is_err());
    }

    #[test]
    fn handedness_signs_the_rise() {
        let mut f = m8(ThreadKind::Internal);
        assert!(f.rise() > 0.0);
        f.right_hand = false;
        assert!(f.rise() < 0.0);
        f.starts = 2;
        assert!((f.rise().abs() * math::TAU - 2.5).abs() < 1e-12);
    }
}
