//! `HOLE_SIZES` (SPEC-v1 §6.5): the normative standard-hole table, every value with a source.
//!
//! Values are nominal mm. FDM hole compensation is **not** here: it belongs to the process
//! profile (ADR 0013 decision 1), so the IR keeps nominal geometry. A value that could not be
//! verified against two independent published tables is absent (`None`); a preset that needs it
//! is rejected for that size with `HOLE_OPTIONS_CONFLICT`.

use super::features::{HoleFit, HoleSize};

/// A table value and where it comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sourced {
    pub value: f64,
    /// Source ids (keys of [`SOURCES`]).
    pub sources: &'static [&'static str],
    /// Why this value was chosen where sources disagree.
    pub note: Option<&'static str>,
}

const fn v(value: f64, sources: &'static [&'static str]) -> Option<Sourced> {
    Some(Sourced {
        value,
        sources,
        note: None,
    })
}

const fn vn(value: f64, sources: &'static [&'static str], note: &'static str) -> Option<Sourced> {
    Some(Sourced {
        value,
        sources,
        note: Some(note),
    })
}

/// One row of `HOLE_SIZES`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HoleRow {
    pub size: HoleSize,
    /// Coarse thread pitch (ISO 261/262).
    pub pitch: Option<Sourced>,
    /// Tap drill (ISO 2306 / common practice), `fit: "tap"` and the default of `thread`.
    pub tap: Option<Sourced>,
    /// ISO 273 fine series, `fit: "close"`.
    pub close: Option<Sourced>,
    /// ISO 273 medium series, `fit: "normal"`.
    pub normal: Option<Sourced>,
    /// ISO 273 coarse series, `fit: "loose"`.
    pub loose: Option<Sourced>,
    /// Counterbore diameter for ISO 4762 socket head cap screws (DIN 974-1), `cbore: "iso4762"`.
    pub cbore_d: Option<Sourced>,
    /// Counterbore depth for ISO 4762 heads.
    pub cbore_depth: Option<Sourced>,
    /// 90° countersink diameter for ISO 10642 heads, `csink: "iso10642"`.
    pub csink_d: Option<Sourced>,
    /// Heat-set insert bore diameter, `insert: "std"`.
    pub insert_d: Option<Sourced>,
    /// Heat-set insert hole depth, `insert: "std"`.
    pub insert_depth: Option<Sourced>,
}

include!("holes_table.rs");

/// The row of a size.
pub fn row(size: HoleSize) -> &'static HoleRow {
    HOLE_SIZES
        .iter()
        .find(|r| r.size == size)
        .expect("every HoleSize has a row")
}

/// The presets of §6.5.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Counterbore,
    Countersink,
    Insert,
}

/// `(d, depth)` of a counterbore or insert preset, `(d, 90°)` of a countersink preset; `None`
/// when the table has no verified value for the size.
pub fn preset_dims(size: HoleSize, preset: Preset) -> Option<(f64, f64)> {
    let r = row(size);
    match preset {
        Preset::Counterbore => Some((r.cbore_d?.value, r.cbore_depth?.value)),
        Preset::Countersink => Some((r.csink_d?.value, 90.0)),
        Preset::Insert => Some((r.insert_d?.value, r.insert_depth?.value)),
    }
}

/// The hole diameter `D` of a sized hole (§6.5): the tap drill for threaded holes and
/// `fit: "tap"`, otherwise the ISO 273 series of `fit`.
pub fn diameter(size: HoleSize, fit: HoleFit, threaded: bool) -> Option<f64> {
    let r = row(size);
    let v = if threaded {
        r.tap
    } else {
        match fit {
            HoleFit::Close => r.close,
            HoleFit::Normal => r.normal,
            HoleFit::Loose => r.loose,
            HoleFit::Tap => r.tap,
        }
    };
    v.map(|s| s.value)
}

/// The resolved tool dimensions of a hole whose size-related fields are literals (§6.5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ToolDims {
    pub kind: super::metrics::HoleKind,
    /// Hole diameter `D`.
    pub d: f64,
    /// Blind depth set by an insert preset (other depths come from the `depth` field).
    pub insert_depth: Option<f64>,
    /// `(Dc, hc)`.
    pub cbore: Option<(f64, f64)>,
    /// `(Dk, β)`.
    pub csink: Option<(f64, f64)>,
    /// Thread pitch (cosmetic or modelled).
    pub thread_pitch: Option<f64>,
    /// Basic major diameter of the thread: `thread.standard`'s, else the size's nominal
    /// diameter (`None` without either).
    pub thread_major: Option<f64>,
}

/// Resolve `d`, the preset dimensions and the thread pitch of a hole from its fields and
/// `HOLE_SIZES`. `None` when a needed field is an expression (W1 evaluates it first) or the
/// table has no verified value (validation rejects that case with `HOLE_OPTIONS_CONFLICT`).
pub fn tool_dims(h: &super::features::HoleFeature) -> Option<ToolDims> {
    use super::features::{Counterbore, Countersink, Insert, Thread};
    use super::metrics::HoleKind;
    let threaded = !matches!(h.thread, None | Some(Thread::Flag(false)));
    let standard = match &h.thread {
        Some(Thread::Spec(t)) => match &t.standard {
            Some(s) => Some(super::threads::thread_standard(s)?),
            None => None,
        },
        _ => None,
    };
    let insert = match &h.insert {
        None => None,
        Some(Insert::Preset(_)) => preset_dims(h.size?, Preset::Insert),
        Some(Insert::Custom(c)) => Some((c.d.literal()?, c.depth.literal()?)),
    };
    let d = match (&h.d, insert) {
        (Some(d), _) => d.literal()?,
        (None, Some((bore, _))) => bore,
        // Without a size, a thread standard gives the bore: its basic minor diameter.
        (None, None) => match (h.size, standard) {
            (Some(size), _) => diameter(size, h.fit, threaded)?,
            (None, Some(st)) => st.basic_minor(),
            (None, None) => return None,
        },
    };
    let cbore = match &h.cbore {
        None => None,
        Some(Counterbore::Preset(_)) => Some(preset_dims(h.size?, Preset::Counterbore)?),
        Some(Counterbore::Custom(c)) => Some((c.d.literal()?, c.depth.literal()?)),
    };
    let csink = match &h.csink {
        None => None,
        Some(Countersink::Preset(_)) => Some(preset_dims(h.size?, Preset::Countersink)?),
        Some(Countersink::Custom(c)) => Some((c.d.literal()?, c.angle.literal()?)),
    };
    let thread_pitch = match &h.thread {
        Some(Thread::Spec(t)) if t.pitch.is_some() => Some(t.pitch.as_ref()?.literal()?),
        _ if threaded => match standard {
            Some(st) => Some(st.pitch),
            None => Some(row(h.size?).pitch?.value),
        },
        _ => None,
    };
    let thread_major = if threaded {
        match (standard, h.size) {
            (Some(st), _) => Some(st.major),
            (None, Some(size)) => super::threads::thread_standard(size.as_str()).map(|r| r.major),
            (None, None) => None,
        }
    } else {
        None
    };
    let kind = if insert.is_some() {
        HoleKind::Insert
    } else if cbore.is_some() {
        HoleKind::Counterbore
    } else if csink.is_some() {
        HoleKind::Countersink
    } else {
        HoleKind::Simple
    };
    Some(ToolDims {
        kind,
        d,
        insert_depth: insert.map(|(_, depth)| depth),
        cbore,
        csink,
        thread_pitch,
        thread_major,
    })
}

fn sourced_json(s: &Option<Sourced>) -> serde_json::Value {
    match s {
        None => serde_json::Value::Null,
        Some(s) => {
            let mut o = serde_json::json!({ "value": s.value, "sources": s.sources });
            if let Some(n) = s.note {
                o["note"] = n.into();
            }
            o
        }
    }
}

/// `HOLE_SIZES` as written into `schema/ir-v1.constants.json`: `sources` (id → citation),
/// `sizes` (size → field → `{ value, sources, note? }`, `null` = not verified) and
/// `unverified` (the omitted values and why).
pub fn hole_sizes_json() -> serde_json::Value {
    let sources: serde_json::Map<String, serde_json::Value> = SOURCES
        .iter()
        .map(|(id, cite)| (id.to_string(), serde_json::Value::from(*cite)))
        .collect();
    let sizes: serde_json::Map<String, serde_json::Value> = HOLE_SIZES
        .iter()
        .map(|r| {
            (
                r.size.as_str().to_string(),
                serde_json::json!({
                    "pitch": sourced_json(&r.pitch),
                    "tap": sourced_json(&r.tap),
                    "close": sourced_json(&r.close),
                    "normal": sourced_json(&r.normal),
                    "loose": sourced_json(&r.loose),
                    "cbore_d": sourced_json(&r.cbore_d),
                    "cbore_depth": sourced_json(&r.cbore_depth),
                    "csink_d": sourced_json(&r.csink_d),
                    "insert_d": sourced_json(&r.insert_d),
                    "insert_depth": sourced_json(&r.insert_depth),
                }),
            )
        })
        .collect();
    let unverified: Vec<serde_json::Value> = UNVERIFIED
        .iter()
        .map(
            |(size, field, why)| serde_json::json!({ "size": size, "field": field, "reason": why }),
        )
        .collect();
    serde_json::json!({
        "units": "mm",
        "note": "Nominal values. FDM compensation is a process-profile setting, not part of the IR (ADR 0013 decision 1).",
        "sources": sources,
        "sizes": sizes,
        "unverified": unverified,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nominal diameter of each size.
    fn nominal(s: HoleSize) -> f64 {
        match s {
            HoleSize::M2 => 2.0,
            HoleSize::M2_5 => 2.5,
            HoleSize::M3 => 3.0,
            HoleSize::M4 => 4.0,
            HoleSize::M5 => 5.0,
            HoleSize::M6 => 6.0,
            HoleSize::M8 => 8.0,
        }
    }

    #[test]
    fn every_value_cites_known_sources() {
        let ids: Vec<&str> = SOURCES.iter().map(|(id, _)| *id).collect();
        for r in &HOLE_SIZES {
            for s in [
                r.pitch,
                r.tap,
                r.close,
                r.normal,
                r.loose,
                r.cbore_d,
                r.cbore_depth,
                r.csink_d,
                r.insert_d,
                r.insert_depth,
            ]
            .into_iter()
            .flatten()
            {
                assert!(
                    !s.sources.is_empty(),
                    "{:?}: value {} has no source",
                    r.size,
                    s.value
                );
                for id in s.sources {
                    assert!(ids.contains(id), "{:?}: unknown source {id}", r.size);
                }
                // A single-source value must explain itself.
                assert!(
                    s.sources.len() >= 2 || s.note.is_some(),
                    "{:?}: {} has one source and no note",
                    r.size,
                    s.value
                );
            }
        }
        for (size, field, _) in UNVERIFIED {
            let r = row(HoleSize::parse(size).unwrap());
            let v = match *field {
                "cbore_depth" => r.cbore_depth,
                "csink_d" => r.csink_d,
                other => panic!("unexpected unverified field {other}"),
            };
            assert!(
                v.is_none(),
                "{size} {field} is listed as unverified but has a value"
            );
        }
    }

    #[test]
    fn table_is_physically_consistent() {
        // ISO 4762 head: height k and head diameter dk max (plain head), from the iso4762 source.
        let head = |s: HoleSize| match s {
            HoleSize::M2 => (2.0, 3.8),
            HoleSize::M2_5 => (2.5, 4.5),
            HoleSize::M3 => (3.0, 5.5),
            HoleSize::M4 => (4.0, 7.0),
            HoleSize::M5 => (5.0, 8.5),
            HoleSize::M6 => (6.0, 10.0),
            HoleSize::M8 => (8.0, 13.0),
        };
        // ISO 10642:2019 head diameter dk theoretical max (the flushness gauge diameter).
        let csk_head = |s: HoleSize| match s {
            HoleSize::M2 => 4.70,
            HoleSize::M2_5 => 5.88,
            HoleSize::M3 => 6.72,
            HoleSize::M4 => 8.96,
            HoleSize::M5 => 11.20,
            HoleSize::M6 => 13.44,
            HoleSize::M8 => 17.92,
        };
        for r in &HOLE_SIZES {
            let d = nominal(r.size);
            let g = |s: Option<Sourced>| s.map(|s| s.value);
            let (tap, close, normal, loose) = (
                g(r.tap).unwrap(),
                g(r.close).unwrap(),
                g(r.normal).unwrap(),
                g(r.loose).unwrap(),
            );
            assert!(
                tap < d && d < close && close < normal && normal < loose,
                "{:?}",
                r.size
            );
            assert!(
                (d - g(r.pitch).unwrap() - tap).abs() <= 0.06,
                "{:?}: tap drill ≈ d − P",
                r.size
            );
            let (k, dk) = head(r.size);
            assert!(
                g(r.cbore_d).unwrap() > dk,
                "{:?}: counterbore narrower than the head",
                r.size
            );
            if let Some(t) = g(r.cbore_depth) {
                assert!(t > k, "{:?}: counterbore shallower than the head", r.size);
            }
            if let Some(c) = g(r.csink_d) {
                assert!(
                    c > csk_head(r.size),
                    "{:?}: countersink smaller than the ISO 10642 head",
                    r.size
                );
            }
            let (id, idp) = (g(r.insert_d).unwrap(), g(r.insert_depth).unwrap());
            assert!(id > d && idp > id, "{:?}: insert hole", r.size);
        }
    }

    #[test]
    fn presets_and_fits_look_up_the_table() {
        assert_eq!(diameter(HoleSize::M3, HoleFit::Normal, false), Some(3.4));
        assert_eq!(diameter(HoleSize::M3, HoleFit::Close, false), Some(3.2));
        assert_eq!(diameter(HoleSize::M3, HoleFit::Loose, false), Some(3.6));
        assert_eq!(diameter(HoleSize::M3, HoleFit::Tap, false), Some(2.5));
        assert_eq!(diameter(HoleSize::M3, HoleFit::Normal, true), Some(2.5));
        assert_eq!(
            preset_dims(HoleSize::M5, Preset::Counterbore),
            Some((10.0, 5.4))
        );
        assert_eq!(preset_dims(HoleSize::M2, Preset::Counterbore), None);
        assert_eq!(preset_dims(HoleSize::M2, Preset::Countersink), None);
        assert_eq!(
            preset_dims(HoleSize::M4, Preset::Countersink),
            Some((9.18, 90.0))
        );
        assert_eq!(preset_dims(HoleSize::M3, Preset::Insert), Some((4.0, 6.7)));
    }
}
