//! `THREAD_STANDARDS`: screw-thread designations → basic major diameter and pitch, every row
//! with its sources (researched 2026-09-25; the modelled-thread stretch, docs/fm/threads.md).
//!
//! - **ISO metric** (ISO 261 / ISO 262): coarse `M<d>` and fine `M<d>x<P>`. Only pitches listed
//!   by two independent published tables are included.
//! - **Unified** (ASME B1.1): `<size>-<tpi> UNC` / `UNF`, sizes `#2`–`#10` and `1/4`–`1`. The
//!   basic major diameter of a numbered size is `0.060 + 0.013·N` in (ASME B1.1), of a
//!   fractional size the fraction itself; the pitch is `1/tpi` in. Both are converted exactly
//!   with 25.4 mm/in.
//!
//! Both families share the 60° basic profile (ISO 68-1; ASME B1.1 states the same profile):
//! `H = P·√3/2`, basic minor `D1 = D − (5/4)·H`, pitch diameter `D2 = D − (3/4)·H`. The IR keeps
//! these **nominal** diameters; tolerance classes (6H/6g, 2B/2A) and FDM compensation are not
//! part of the model (ADR 0013 decision 1, as for `HOLE_SIZES`).

/// Thread family.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadFamily {
    MetricCoarse,
    MetricFine,
    Unc,
    Unf,
}

impl ThreadFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            ThreadFamily::MetricCoarse => "metric_coarse",
            ThreadFamily::MetricFine => "metric_fine",
            ThreadFamily::Unc => "unc",
            ThreadFamily::Unf => "unf",
        }
    }
}

/// One row of `THREAD_STANDARDS`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThreadStandard {
    /// Canonical designation: `M8`, `M14x1`, `1/2-20 UNF`, `#10-32 UNF`.
    pub designation: &'static str,
    pub family: ThreadFamily,
    /// Basic major diameter (mm).
    pub major: f64,
    /// Pitch (mm).
    pub pitch: f64,
    /// Source ids (keys of [`THREAD_SOURCES`]).
    pub sources: &'static [&'static str],
    /// Remarks (use restrictions, where the row matters).
    pub note: Option<&'static str>,
}

impl ThreadStandard {
    /// Fundamental triangle height `H = P·√3/2`.
    pub fn fundamental_height(&self) -> f64 {
        self.pitch * 3f64.sqrt() * 0.5
    }
    /// Basic minor diameter `D1 = D − (5/4)·H` (the bore of a modelled nut thread).
    pub fn basic_minor(&self) -> f64 {
        self.major - 1.25 * self.fundamental_height()
    }
    /// Basic pitch diameter `D2 = D − (3/4)·H`.
    pub fn pitch_diameter(&self) -> f64 {
        self.major - 0.75 * self.fundamental_height()
    }
}

/// Source id → citation (the page actually checked).
#[rustfmt::skip]
pub const THREAD_SOURCES: &[(&str, &str)] = &[
    ("wiki-iso-thread", "Wikipedia, ISO metric screw thread: preferred sizes (ISO 262) and the basic profile formulas: https://en.wikipedia.org/wiki/ISO_metric_screw_thread"),
    ("modulus-iso261", "Modulus Metal, Metric thread size table M1-M300 (ISO 261, coarse and fine): https://www.modulusmetal.com/standard-metric-thread-size-table/"),
    ("fuller-metric", "Fuller Fasteners, Basic metric thread chart M1-M100: https://fullerfasteners.com/tech/basic-metric-thread-chart-m1-m100-2/"),
    ("wiki-uts", "Wikipedia, Unified Thread Standard (UNC/UNF table; the UTS basic profile is the ISO basic profile): https://en.wikipedia.org/wiki/Unified_Thread_Standard"),
    ("amesweb-unc", "AMESWeb, UNC thread chart per ASME B1.1: https://amesweb.info/Screws/unc-thread-chart.aspx"),
    ("amesweb-unf", "AMESWeb, UNF thread chart per ASME B1.1 (1/2-20 UNF internal minor 0.4460-0.4570 in): https://amesweb.info/Screws/unf-thread-chart.aspx"),
];

const MET3: &[&str] = &["wiki-iso-thread", "modulus-iso261", "fuller-metric"];
const MET2: &[&str] = &["modulus-iso261", "fuller-metric"];
const UNC: &[&str] = &["wiki-uts", "amesweb-unc"];
const UNF: &[&str] = &["wiki-uts", "amesweb-unf"];

const IN: f64 = 25.4;

const fn m(
    designation: &'static str,
    major: f64,
    pitch: f64,
    sources: &'static [&'static str],
) -> ThreadStandard {
    ThreadStandard {
        designation,
        family: ThreadFamily::MetricCoarse,
        major,
        pitch,
        sources,
        note: None,
    }
}

const fn mf(
    designation: &'static str,
    major: f64,
    pitch: f64,
    sources: &'static [&'static str],
) -> ThreadStandard {
    ThreadStandard {
        designation,
        family: ThreadFamily::MetricFine,
        major,
        pitch,
        sources,
        note: None,
    }
}

const fn un(
    designation: &'static str,
    family: ThreadFamily,
    major_in: f64,
    tpi: f64,
    sources: &'static [&'static str],
) -> ThreadStandard {
    ThreadStandard {
        designation,
        family,
        major: major_in * IN,
        pitch: IN / tpi,
        sources,
        note: None,
    }
}

/// Numbered Unified size `#n`: `0.060 + 0.013·n` in.
const fn num(n: f64) -> f64 {
    0.060 + 0.013 * n
}

/// The table, by family then size.
#[rustfmt::skip]
pub const THREAD_STANDARDS: &[ThreadStandard] = &[
    // ISO metric coarse (ISO 261/262).
    m("M1.6", 1.6, 0.35, MET3), m("M2", 2.0, 0.4, MET3), m("M2.5", 2.5, 0.45, MET3),
    m("M3", 3.0, 0.5, MET3), m("M4", 4.0, 0.7, MET3), m("M5", 5.0, 0.8, MET3),
    m("M6", 6.0, 1.0, MET3), m("M8", 8.0, 1.25, MET3), m("M10", 10.0, 1.5, MET3),
    m("M12", 12.0, 1.75, MET3), m("M14", 14.0, 2.0, MET2), m("M16", 16.0, 2.0, MET3),
    m("M18", 18.0, 2.5, MET2), m("M20", 20.0, 2.5, MET3), m("M22", 22.0, 2.5, MET2),
    m("M24", 24.0, 3.0, MET3), m("M27", 27.0, 3.0, MET2), m("M30", 30.0, 3.5, MET3),
    // ISO metric fine (ISO 261): pitches both tables list.
    mf("M1.6x0.2", 1.6, 0.2, MET3), mf("M2x0.25", 2.0, 0.25, MET3), mf("M2.5x0.35", 2.5, 0.35, MET3),
    mf("M3x0.35", 3.0, 0.35, MET3), mf("M4x0.5", 4.0, 0.5, MET3), mf("M5x0.5", 5.0, 0.5, MET3),
    mf("M6x0.75", 6.0, 0.75, MET3),
    mf("M8x1", 8.0, 1.0, MET3), mf("M8x0.75", 8.0, 0.75, MET3),
    mf("M10x1.25", 10.0, 1.25, MET3), mf("M10x1", 10.0, 1.0, MET3), mf("M10x0.75", 10.0, 0.75, MET2),
    mf("M12x1.5", 12.0, 1.5, MET3), mf("M12x1.25", 12.0, 1.25, MET3), mf("M12x1", 12.0, 1.0, MET2),
    mf("M14x1.5", 14.0, 1.5, MET2), mf("M14x1.25", 14.0, 1.25, MET2), mf("M14x1", 14.0, 1.0, MET2),
    mf("M16x1.5", 16.0, 1.5, MET3), mf("M16x1", 16.0, 1.0, MET2),
    mf("M18x2", 18.0, 2.0, MET2), mf("M18x1.5", 18.0, 1.5, MET2), mf("M18x1", 18.0, 1.0, MET2),
    mf("M20x2", 20.0, 2.0, MET3), mf("M20x1.5", 20.0, 1.5, MET3), mf("M20x1", 20.0, 1.0, MET2),
    mf("M22x2", 22.0, 2.0, MET2), mf("M22x1.5", 22.0, 1.5, MET2), mf("M22x1", 22.0, 1.0, MET2),
    mf("M24x2", 24.0, 2.0, MET3), mf("M24x1.5", 24.0, 1.5, MET2), mf("M24x1", 24.0, 1.0, MET2),
    mf("M27x2", 27.0, 2.0, MET2), mf("M27x1.5", 27.0, 1.5, MET2), mf("M27x1", 27.0, 1.0, MET2),
    mf("M30x3", 30.0, 3.0, MET2), mf("M30x2", 30.0, 2.0, MET3), mf("M30x1.5", 30.0, 1.5, MET2),
    // Unified coarse (ASME B1.1).
    un("#2-56 UNC", ThreadFamily::Unc, num(2.0), 56.0, UNC), un("#4-40 UNC", ThreadFamily::Unc, num(4.0), 40.0, UNC),
    un("#6-32 UNC", ThreadFamily::Unc, num(6.0), 32.0, UNC), un("#8-32 UNC", ThreadFamily::Unc, num(8.0), 32.0, UNC),
    un("#10-24 UNC", ThreadFamily::Unc, num(10.0), 24.0, UNC),
    un("1/4-20 UNC", ThreadFamily::Unc, 0.25, 20.0, UNC), un("5/16-18 UNC", ThreadFamily::Unc, 0.3125, 18.0, UNC),
    un("3/8-16 UNC", ThreadFamily::Unc, 0.375, 16.0, UNC), un("7/16-14 UNC", ThreadFamily::Unc, 0.4375, 14.0, UNC),
    un("1/2-13 UNC", ThreadFamily::Unc, 0.5, 13.0, UNC), un("9/16-12 UNC", ThreadFamily::Unc, 0.5625, 12.0, UNC),
    un("5/8-11 UNC", ThreadFamily::Unc, 0.625, 11.0, UNC), un("3/4-10 UNC", ThreadFamily::Unc, 0.75, 10.0, UNC),
    un("7/8-9 UNC", ThreadFamily::Unc, 0.875, 9.0, UNC), un("1-8 UNC", ThreadFamily::Unc, 1.0, 8.0, UNC),
    // Unified fine (ASME B1.1).
    un("#2-64 UNF", ThreadFamily::Unf, num(2.0), 64.0, UNF), un("#4-48 UNF", ThreadFamily::Unf, num(4.0), 48.0, UNF),
    un("#6-40 UNF", ThreadFamily::Unf, num(6.0), 40.0, UNF), un("#8-36 UNF", ThreadFamily::Unf, num(8.0), 36.0, UNF),
    un("#10-32 UNF", ThreadFamily::Unf, num(10.0), 32.0, UNF),
    un("1/4-28 UNF", ThreadFamily::Unf, 0.25, 28.0, UNF), un("5/16-24 UNF", ThreadFamily::Unf, 0.3125, 24.0, UNF),
    un("3/8-24 UNF", ThreadFamily::Unf, 0.375, 24.0, UNF), un("7/16-20 UNF", ThreadFamily::Unf, 0.4375, 20.0, UNF),
    un("1/2-20 UNF", ThreadFamily::Unf, 0.5, 20.0, UNF), un("9/16-18 UNF", ThreadFamily::Unf, 0.5625, 18.0, UNF),
    un("5/8-18 UNF", ThreadFamily::Unf, 0.625, 18.0, UNF), un("3/4-16 UNF", ThreadFamily::Unf, 0.75, 16.0, UNF),
    un("7/8-14 UNF", ThreadFamily::Unf, 0.875, 14.0, UNF), un("1-12 UNF", ThreadFamily::Unf, 1.0, 12.0, UNF),
];

/// A designation reduced to a comparison key: upper case, no spaces, `×`/`X` → `X`, and a
/// metric coarse designation with its own pitch (`M8x1.25`) reduced to `M8`.
fn key(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| {
            if c == '×' {
                'X'
            } else {
                c.to_ascii_uppercase()
            }
        })
        .collect()
}

/// The row of a designation (`M8`, `M8x1.25`, `m14 x 1`, `1/2-20 UNF`, `1/2-20UNF`), if the
/// table has it.
pub fn thread_standard(designation: &str) -> Option<&'static ThreadStandard> {
    let k = key(designation);
    THREAD_STANDARDS.iter().find(|r| {
        let rk = key(r.designation);
        rk == k
            || (r.family == ThreadFamily::MetricCoarse
                && k == format!("{rk}X{}", fmt_pitch(r.pitch)))
    })
}

/// `x` rounded to 1e-12 (a decimal of at most 14 significant digits for the table's sizes).
fn published(x: f64) -> f64 {
    (x * 1e12).round() / 1e12
}

/// Every designation of [`THREAD_STANDARDS`], sorted by bytes: the order of the `threads`
/// object in `ir-v1.constants.json` (the `allowed` list of `THREAD_STANDARD_UNKNOWN`).
pub fn thread_designations() -> Vec<&'static str> {
    let mut v: Vec<&'static str> = THREAD_STANDARDS.iter().map(|r| r.designation).collect();
    v.sort_unstable();
    v
}

fn fmt_pitch(p: f64) -> String {
    let s = format!("{p}");
    s.trim_end_matches(".0").to_string()
}

/// `THREAD_STANDARDS` as written into `schema/ir-v1.constants.json`: `sources` (id →
/// citation) and `threads` (designation → `{ family, major, pitch, minor, pitch_diameter,
/// sources, note? }`, mm). The numbers are rounded to 1e-12 mm ([`published`]) so that every
/// JSON reader parses them back to the same `f64` (a 17-digit shortest form such as `25.4/13`
/// is not read back exactly by every parser); the kernel's own values differ by < 5e-13 mm.
pub fn thread_standards_json() -> serde_json::Value {
    let sources: serde_json::Map<String, serde_json::Value> = THREAD_SOURCES
        .iter()
        .map(|(id, cite)| (id.to_string(), serde_json::Value::from(*cite)))
        .collect();
    let threads: serde_json::Map<String, serde_json::Value> = THREAD_STANDARDS
        .iter()
        .map(|r| {
            let mut v = serde_json::json!({
                "family": r.family.as_str(),
                "major": published(r.major),
                "pitch": published(r.pitch),
                "minor": published(r.basic_minor()),
                "pitch_diameter": published(r.pitch_diameter()),
                "sources": r.sources,
            });
            if let Some(n) = r.note {
                v["note"] = n.into();
            }
            (r.designation.to_string(), v)
        })
        .collect();
    serde_json::json!({
        "units": "mm",
        "profile": "ISO 68-1 / ASME B1.1 basic profile: 60°, H = P·√3/2, D1 = D − 1.25·H, D2 = D − 0.75·H",
        "note": "Nominal (basic) diameters. Tolerance classes and FDM compensation are not part of the IR (ADR 0013 decision 1).",
        "sources": sources,
        "threads": threads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_row_cites_two_known_sources_and_designations_are_unique() {
        let ids: Vec<&str> = THREAD_SOURCES.iter().map(|(id, _)| *id).collect();
        let mut seen = std::collections::BTreeSet::new();
        for r in THREAD_STANDARDS {
            assert!(
                r.sources.len() >= 2,
                "{} has fewer than two sources",
                r.designation
            );
            for s in r.sources {
                assert!(ids.contains(s), "{}: unknown source {s}", r.designation);
            }
            assert!(seen.insert(key(r.designation)), "{} twice", r.designation);
            assert!(r.major > 2.0 * r.pitch, "{}", r.designation);
        }
    }

    #[test]
    fn lookups_accept_the_usual_spellings() {
        let r = thread_standard("1/2-20 UNF").unwrap();
        assert!((r.major - 12.7).abs() < 1e-12 && (r.pitch - 1.27).abs() < 1e-12);
        assert_eq!(
            thread_standard("1/2-20unf").unwrap().designation,
            "1/2-20 UNF"
        );
        assert!((thread_standard("M8").unwrap().pitch - 1.25).abs() < 1e-15);
        assert_eq!(thread_standard("M8x1.25").unwrap().designation, "M8");
        assert_eq!(thread_standard("m14 × 1").unwrap().designation, "M14x1");
        assert!((thread_standard("#10-32 UNF").unwrap().major - 0.19 * 25.4).abs() < 1e-12);
        assert!(thread_standard("M8x1.1").is_none());
        assert!(thread_standard("1/2-28 UNEF").is_none());
    }

    #[test]
    fn basic_diameters_match_the_published_tables() {
        // ISO 724: M8 D1 6.647, D2 7.188; M14x1 D1 12.917.
        let m8 = thread_standard("M8").unwrap();
        assert!((m8.basic_minor() - 6.647).abs() < 5e-4);
        assert!((m8.pitch_diameter() - 7.188).abs() < 5e-4);
        let m14 = thread_standard("M14x1").unwrap();
        assert!((m14.basic_minor() - 12.917).abs() < 5e-4);
        // ASME B1.1: the 1/2-20 UNF nut's minimum minor diameter is the basic minor, 0.4459 in
        // (published rounded up to 0.4460).
        let u = thread_standard("1/2-20 UNF").unwrap();
        assert!((u.basic_minor() / 25.4 - 0.4459).abs() < 1e-4);
    }
}
