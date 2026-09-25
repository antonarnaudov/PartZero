//! Resolving a hole feature's fields to numbers (SPEC §6.5, [W0-10]).
//!
//! [`literal_hole`] replaces every numeric field of a hole by its value (the caller's
//! evaluator decides literals and expressions, W1), and [`hole_spec`] turns the literal
//! feature into the resolved [`HoleSpec`]: the diameter and preset dimensions come from
//! `forge_ir::v1::holes::tool_dims` (the frozen contract function, `HOLE_SIZES`), the depth
//! and tip from the fields, and every range rule of §6.5 is checked (`INVALID_VALUE`: an
//! evaluation error when an expression produced the value; validation rejects literals).

use forge_ir::v1::holes::{self, Preset, tool_dims};
use forge_ir::v1::metrics::{HoleKind, ThreadOut};
use forge_ir::v1::{
    CirclePlacement, Counterbore, Countersink, CustomCounterbore, CustomCountersink, CustomInsert,
    FieldType, GridPlacement, HoleDepth, HoleFeature, HoleFit, HolePlacement, HolePosition,
    HoleSize, HoleTip, Insert, LINEAR_TOLERANCE, Scalar, Thread, ThreadSpec,
};

use super::error::HoleError;

/// How deep a hole goes (SPEC §6.5), resolved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Depth {
    /// Through every target.
    Through,
    /// To the shoulder at depth `h` (mm) below the placement point.
    Blind(f64),
    /// To the first point of a face along the axis (flat floor); per position.
    UpTo,
}

/// The bottom of a blind hole.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tip {
    /// A drill point of this included angle (degrees, in `(0, 180)`).
    Angle(f64),
    /// A flat floor.
    Flat,
}

/// A hole feature resolved to numbers (placement excluded).
#[derive(Clone, Debug, PartialEq)]
pub struct HoleSpec {
    /// The hole feature id (the `H` of the keys `H/wall@p`, …).
    pub feature: String,
    /// `simple`, `counterbore`, `countersink` or `insert`.
    pub kind: HoleKind,
    /// Hole diameter `D` (mm).
    pub d: f64,
    /// The depth (an insert's preset depth is `Blind`).
    pub depth: Depth,
    /// The bottom of a blind hole (`Flat` for inserts and `up_to`).
    pub tip: Tip,
    /// Counterbore `(Dc, hc)`.
    pub cbore: Option<(f64, f64)>,
    /// Countersink `(Dk, β)` (β the included angle, degrees).
    pub csink: Option<(f64, f64)>,
    /// Insert bore and depth `(d, depth)`.
    pub insert: Option<(f64, f64)>,
    /// The standard size, when given.
    pub size: Option<HoleSize>,
    /// Thread: pitch and explicit depth (`None`: the full hole depth).
    pub thread: Option<(f64, Option<f64>)>,
    /// The thread's form beyond its pitch (standard, major diameter, starts, hand), and
    /// whether it is modelled (`modeled` is a Bool field: the caller sets it after evaluating
    /// it; [`hole_spec`] leaves it `false`).
    pub thread_form: Option<HoleThreadForm>,
    /// The field a head that does not end above the hole's floor is reported at
    /// (`INVALID_VALUE`, SPEC §6.5): `/cbore/depth` (custom) or `/cbore` (preset), with the
    /// counterbore depth as the value; `/csink/d` (custom) or `/csink` (preset), with the
    /// countersink diameter. `None` without a counterbore or countersink. Blind holes are
    /// checked by [`hole_spec`], `up_to` holes per position by `apply_hole` (the shallowest
    /// position decides).
    pub head_field: Option<&'static str>,
}

/// The form of a hole's thread beyond its pitch.
#[derive(Clone, Debug, PartialEq)]
pub struct HoleThreadForm {
    /// The `THREAD_STANDARDS` designation, when given.
    pub standard: Option<String>,
    /// Basic major diameter (a standard's, or the size's nominal diameter).
    pub major: Option<f64>,
    /// Number of starts.
    pub starts: u32,
    /// Right-hand thread.
    pub right_hand: bool,
    /// The groove is modelled (set by the caller).
    pub modeled: bool,
}

impl HoleSpec {
    /// The report's `thread` entry for a hole of depth `depth` (`None` for through).
    pub fn thread_out(&self, depth: Option<f64>) -> Option<ThreadOut> {
        self.thread.map(|(pitch, d)| ThreadOut {
            size: self.size,
            pitch,
            depth: d.or(depth),
            standard: self.thread_form.as_ref().and_then(|f| f.standard.clone()),
            // Only a modelled thread or one with a standard reports its major diameter: a plain
            // cosmetic thread's report is unchanged from before modelled threads.
            major: self
                .thread_form
                .as_ref()
                .filter(|f| f.modeled || f.standard.is_some())
                .and_then(|f| f.major),
            modeled: self.thread_form.as_ref().is_some_and(|f| f.modeled),
        })
    }
}

/// The sizes whose `HOLE_SIZES` row has the preset's values.
fn sizes_with(preset: Preset) -> Vec<String> {
    HoleSize::ALL
        .into_iter()
        .filter(|&s| holes::preset_dims(s, preset).is_some())
        .map(|s| s.as_str().to_string())
        .collect()
}

fn all_sizes() -> Vec<String> {
    HoleSize::ALL
        .into_iter()
        .map(|s| s.as_str().to_string())
        .collect()
}

/// A copy of `h` whose numeric fields are literals: `eval` receives each Scalar, its field
/// type and its path relative to the feature (`/d`, `/at/grid/nx`, …) and returns its value
/// (the caller's evaluator: literals as they are, expressions evaluated). `on`, `flip` and
/// `targets` are left as they are (the caller resolves them).
pub fn literal_hole<E>(
    h: &HoleFeature,
    mut eval: impl FnMut(&Scalar, FieldType, &str) -> Result<f64, E>,
) -> Result<HoleFeature, E> {
    let mut lit = |s: &Scalar, t: FieldType, path: &str| -> Result<Scalar, E> {
        Ok(Scalar::Num(eval(s, t, path)?))
    };
    let mut out = h.clone();
    use FieldType::{Angle, Count, Length};
    if let Some(d) = &h.d {
        out.d = Some(lit(d, Length, "/d")?);
    }
    if let Some(HoleDepth::Blind(b)) = &h.depth {
        out.depth = Some(HoleDepth::Blind(lit(b, Length, "/depth/blind")?));
    }
    if let HoleTip::Angle(a) = &h.tip {
        out.tip = HoleTip::Angle(lit(a, Angle, "/tip")?);
    }
    if let Some(Counterbore::Custom(c)) = &h.cbore {
        out.cbore = Some(Counterbore::Custom(CustomCounterbore {
            d: lit(&c.d, Length, "/cbore/d")?,
            depth: lit(&c.depth, Length, "/cbore/depth")?,
        }));
    }
    if let Some(Countersink::Custom(c)) = &h.csink {
        out.csink = Some(Countersink::Custom(CustomCountersink {
            d: lit(&c.d, Length, "/csink/d")?,
            angle: lit(&c.angle, Angle, "/csink/angle")?,
        }));
    }
    if let Some(Insert::Custom(c)) = &h.insert {
        out.insert = Some(Insert::Custom(CustomInsert {
            d: lit(&c.d, Length, "/insert/d")?,
            depth: lit(&c.depth, Length, "/insert/depth")?,
        }));
    }
    if let Some(Thread::Spec(t)) = &h.thread {
        out.thread = Some(Thread::Spec(ThreadSpec {
            pitch: match &t.pitch {
                Some(p) => Some(lit(p, Length, "/thread/pitch")?),
                None => None,
            },
            depth: match &t.depth {
                Some(p) => Some(lit(p, Length, "/thread/depth")?),
                None => None,
            },
            starts: match &t.starts {
                Some(p) => Some(lit(p, Count, "/thread/starts")?),
                None => None,
            },
            // A Bool field: the caller evaluates it.
            modeled: t.modeled.clone(),
            standard: t.standard.clone(),
            hand: t.hand,
        }));
    }
    out.at = match &h.at {
        HolePlacement::Points(p) => HolePlacement::Points(p.clone()),
        HolePlacement::List(list) => {
            let mut v = Vec::with_capacity(list.len());
            for (k, p) in list.iter().enumerate() {
                v.push(HolePosition {
                    id: p.id.clone(),
                    at: [
                        lit(&p.at[0], Length, &format!("/at/list/{k}/at/0"))?,
                        lit(&p.at[1], Length, &format!("/at/list/{k}/at/1"))?,
                    ],
                });
            }
            HolePlacement::List(v)
        }
        HolePlacement::Grid(g) => HolePlacement::Grid(GridPlacement {
            nx: lit(&g.nx, Count, "/at/grid/nx")?,
            ny: lit(&g.ny, Count, "/at/grid/ny")?,
            dx: lit(&g.dx, Length, "/at/grid/dx")?,
            dy: lit(&g.dy, Length, "/at/grid/dy")?,
            center: [
                lit(&g.center[0], Length, "/at/grid/center/0")?,
                lit(&g.center[1], Length, "/at/grid/center/1")?,
            ],
        }),
        HolePlacement::Circle(c) => HolePlacement::Circle(CirclePlacement {
            n: lit(&c.n, Count, "/at/circle/n")?,
            d: lit(&c.d, Length, "/at/circle/d")?,
            center: [
                lit(&c.center[0], Length, "/at/circle/center/0")?,
                lit(&c.center[1], Length, "/at/circle/center/1")?,
            ],
            start: lit(&c.start, Angle, "/at/circle/start")?,
        }),
    };
    Ok(out)
}

/// The value of a literal Scalar (a hole passed through [`literal_hole`]).
pub(crate) fn num(s: &Scalar, field: &str) -> Result<f64, HoleError> {
    s.literal().ok_or_else(|| {
        HoleError::internal(format!(
            "{field} is an expression; evaluate it first (literal_hole)"
        ))
    })
}

fn positive(field: &str, v: f64) -> Result<f64, HoleError> {
    if v.is_finite() && v > LINEAR_TOLERANCE {
        Ok(v)
    } else {
        Err(HoleError::InvalidValue {
            field: field.into(),
            value: v,
            expected: "> 1e-6 mm".into(),
        })
    }
}

fn open_angle(field: &str, v: f64) -> Result<f64, HoleError> {
    if v.is_finite() && v > 0.0 && v < 180.0 {
        Ok(v)
    } else {
        Err(HoleError::InvalidValue {
            field: field.into(),
            value: v,
            expected: "in (0, 180) degrees".into(),
        })
    }
}

/// `"> x mm (wider than the hole diameter …)"`: the bound of a counterbore or countersink
/// diameter over a hole of diameter `d`.
fn wider_than(d: f64) -> String {
    format!(
        "> {} mm (wider than the hole diameter {} mm by more than 2e-6 mm)",
        bound(d + 2.0 * LINEAR_TOLERANCE),
        bound(d)
    )
}

/// A computed bound for an `expected` text: at most nine decimals, trailing zeros trimmed
/// (`6.4 + 1e-6` reads `6.400001`, not `6.4000010000000005`).
pub(crate) fn bound(x: f64) -> String {
    let s = format!("{x:.9}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s == "-0" { "0".into() } else { s.into() }
}

/// The largest included angle (degrees) of a cone that narrows by `w` in diameter and is
/// taller than tol: `2·atan(w / (2·tol))` (informative: the bound quoted in `expected`).
fn max_cone_angle(w: f64) -> f64 {
    2.0 * forge_core::math::rad_to_deg(forge_core::math::atan(0.5 * w / LINEAR_TOLERANCE))
}

/// `tan(a/2)` for an angle `a` in degrees, with the normative degree trigonometry.
pub(crate) fn tan_half_deg(a: f64) -> f64 {
    let (s, c) = forge_ir::v1::degtrig::sin_cos_deg(0.5 * a).unwrap_or((f64::NAN, f64::NAN));
    s / c
}

/// Resolve a literal hole feature (see [`literal_hole`]) to a [`HoleSpec`] (SPEC §6.5,
/// [W0-10]).
///
/// Errors: `INVALID_VALUE` (a length ≤ tol, an angle outside `(0, 180)`, a counterbore or
/// countersink not wider than the hole, a countersink cone or drill point no taller than tol,
/// a counterbore or countersink not shallower than a blind hole by more than tol; `expected`
/// quotes the numeric bound), and — for documents that bypassed validation, every
/// rejection of §6.5 and [W0-10], so that no conflicting input is silently reinterpreted —
/// `HOLE_SIZE_REQUIRED`, `HOLE_DEPTH_REQUIRED` and `HOLE_OPTIONS_CONFLICT` (more than one of
/// `cbore`, `csink`, `insert`; a preset without `size` or without a table value for it;
/// `thread` with `insert`, with `fit` `close` or `loose`, or without `size` and `pitch`;
/// `depth` with `insert`; a `tip` other than 118 on a hole that is not `blind`). The first
/// violation in that order is returned; `field` is its path relative to the feature.
pub fn hole_spec(h: &HoleFeature) -> Result<HoleSpec, HoleError> {
    // The rejections validation owns, re-checked for callers that bypass it.
    let thread_standard = match &h.thread {
        Some(Thread::Spec(t)) => t.standard.as_deref(),
        _ => None,
    };
    if let Some(s) = thread_standard
        && forge_ir::v1::threads::thread_standard(s).is_none()
    {
        return Err(HoleError::OptionsConflict {
            field: "/thread/standard".into(),
            allowed: forge_ir::v1::threads::thread_designations()
                .into_iter()
                .map(str::to_string)
                .collect(),
        });
    }
    if h.d.is_none() && h.size.is_none() && thread_standard.is_none() {
        return Err(HoleError::SizeRequired {
            field: "/size".into(),
            allowed: all_sizes(),
        });
    }
    let heads: Vec<&str> = [
        ("cbore", h.cbore.is_some()),
        ("csink", h.csink.is_some()),
        ("insert", h.insert.is_some()),
    ]
    .into_iter()
    .filter(|(_, used)| *used)
    .map(|(n, _)| n)
    .collect();
    if let [_, second, ..] = heads.as_slice() {
        return Err(HoleError::OptionsConflict {
            field: format!("/{second}"),
            allowed: vec!["cbore".into(), "csink".into(), "insert".into()],
        });
    }
    let presets = [
        (
            matches!(h.cbore, Some(Counterbore::Preset(_))),
            Preset::Counterbore,
            "/cbore",
        ),
        (
            matches!(h.csink, Some(Countersink::Preset(_))),
            Preset::Countersink,
            "/csink",
        ),
        (
            matches!(h.insert, Some(Insert::Preset(_))),
            Preset::Insert,
            "/insert",
        ),
    ];
    for (used, preset, field) in presets {
        let missing = match h.size {
            None => true,
            Some(s) => holes::preset_dims(s, preset).is_none(),
        };
        if used && missing {
            return Err(HoleError::OptionsConflict {
                field: field.into(),
                allowed: sizes_with(preset),
            });
        }
    }
    let threaded = !matches!(h.thread, None | Some(Thread::Flag(false)));
    if threaded && h.insert.is_some() {
        return Err(HoleError::OptionsConflict {
            field: "/thread".into(),
            allowed: vec!["thread".into(), "insert".into()],
        });
    }
    if threaded && matches!(h.fit, HoleFit::Close | HoleFit::Loose) {
        // A threaded hole uses the tap drill.
        return Err(HoleError::OptionsConflict {
            field: "/fit".into(),
            allowed: vec!["normal".into(), "tap".into()],
        });
    }
    let explicit_pitch = matches!(&h.thread, Some(Thread::Spec(t)) if t.pitch.is_some());
    if threaded && h.size.is_none() && !explicit_pitch && thread_standard.is_none() {
        return Err(HoleError::OptionsConflict {
            field: "/thread".into(),
            allowed: vec!["pitch".into(), "size".into()],
        });
    }
    if h.insert.is_some() && h.depth.is_some() {
        // The insert sets its own blind depth.
        return Err(HoleError::OptionsConflict {
            field: "/depth".into(),
            allowed: vec!["insert".into()],
        });
    }
    // Exact comparison on purpose: the default is the literal 118.
    #[allow(clippy::float_cmp)]
    let default_tip = match &h.tip {
        HoleTip::Angle(a) => num(a, "/tip")? == 118.0,
        HoleTip::Flat(_) => false,
    };
    if !default_tip && !matches!(h.depth, Some(HoleDepth::Blind(_))) {
        // `tip` is meaningless for through, up_to and insert holes.
        return Err(HoleError::OptionsConflict {
            field: "/tip".into(),
            allowed: vec!["blind".into()],
        });
    }
    let dims = tool_dims(h).ok_or_else(|| {
        HoleError::internal("tool_dims found an expression or a missing table value")
    })?;
    let d = positive("/d", dims.d)?;
    let insert = match (&h.insert, dims.insert_depth) {
        (Some(_), Some(depth)) => {
            let field = |f: &str| match &h.insert {
                Some(Insert::Custom(_)) => format!("/insert/{f}"),
                _ => "/insert".into(),
            };
            Some((positive(&field("d"), d)?, positive(&field("depth"), depth)?))
        }
        _ => None,
    };
    let depth = match (&h.depth, insert) {
        (_, Some((_, depth))) => Depth::Blind(depth),
        (Some(HoleDepth::Through), None) => Depth::Through,
        (Some(HoleDepth::Blind(b)), None) => {
            Depth::Blind(positive("/depth/blind", num(b, "/depth/blind")?)?)
        }
        (Some(HoleDepth::UpTo(_)), None) => Depth::UpTo,
        (None, None) => {
            return Err(HoleError::DepthRequired {
                field: "/depth".into(),
                allowed: vec!["through".into(), "blind".into(), "up_to".into()],
            });
        }
    };
    let tip = match (&h.tip, depth, insert) {
        (HoleTip::Angle(a), Depth::Blind(_), None) => {
            let a = open_angle("/tip", num(a, "/tip")?)?;
            // The drill-point cone must be taller than tol (a flatter one is a sub-tolerance
            // face, not a floor): (D/2)/tan(tip/2) > tol.
            if 0.5 * d / tan_half_deg(a) <= LINEAR_TOLERANCE {
                return Err(HoleError::InvalidValue {
                    field: "/tip".into(),
                    value: a,
                    expected: format!(
                        "< {}° (a drill point deeper than 1e-6 mm for D = {} mm), or \"flat\"",
                        bound(max_cone_angle(d)),
                        bound(d)
                    ),
                });
            }
            Tip::Angle(a)
        }
        _ => Tip::Flat,
    };
    let cbore = match dims.cbore {
        None => None,
        Some((dc, hc)) => {
            let custom = matches!(h.cbore, Some(Counterbore::Custom(_)));
            let (fd, fh) = if custom {
                ("/cbore/d", "/cbore/depth")
            } else {
                ("/cbore", "/cbore")
            };
            let dc = positive(fd, dc)?;
            let hc = positive(fh, hc)?;
            if dc - d <= 2.0 * LINEAR_TOLERANCE {
                return Err(HoleError::InvalidValue {
                    field: fd.into(),
                    value: dc,
                    expected: wider_than(d),
                });
            }
            if let Depth::Blind(hb) = depth
                && hb - hc <= LINEAR_TOLERANCE
            {
                return Err(HoleError::InvalidValue {
                    field: fh.into(),
                    value: hc,
                    expected: format!(
                        "< {} mm (shallower than the hole depth {} mm by more than 1e-6 mm)",
                        bound(hb - LINEAR_TOLERANCE),
                        bound(hb)
                    ),
                });
            }
            Some((dc, hc))
        }
    };
    let csink = match dims.csink {
        None => None,
        Some((dk, beta)) => {
            let custom = matches!(h.csink, Some(Countersink::Custom(_)));
            let (fd, fa) = if custom {
                ("/csink/d", "/csink/angle")
            } else {
                ("/csink", "/csink")
            };
            let dk = positive(fd, dk)?;
            let beta = open_angle(fa, beta)?;
            if dk - d <= 2.0 * LINEAR_TOLERANCE {
                return Err(HoleError::InvalidValue {
                    field: fd.into(),
                    value: dk,
                    expected: wider_than(d),
                });
            }
            let hk = 0.5 * (dk - d) / tan_half_deg(beta);
            if hk <= LINEAR_TOLERANCE {
                // A cone flatter than tol is a sub-tolerance face; its profile edge would
                // lie within tol of the top disc's (SKETCH_CURVES_CROSS in the tool).
                return Err(HoleError::InvalidValue {
                    field: fa.into(),
                    value: beta,
                    expected: format!(
                        "< {}° (a countersink deeper than 1e-6 mm for Dk − D = {} mm)",
                        bound(max_cone_angle(dk - d)),
                        bound(dk - d)
                    ),
                });
            }
            if let Depth::Blind(hb) = depth
                && hb - hk <= LINEAR_TOLERANCE
            {
                return Err(HoleError::InvalidValue {
                    field: fd.into(),
                    value: dk,
                    expected: format!(
                        "< {} mm (a countersink shallower than the hole depth {} mm by more \
                         than 1e-6 mm at {}°)",
                        bound(d + 2.0 * (hb - LINEAR_TOLERANCE) * tan_half_deg(beta)),
                        bound(hb),
                        bound(beta)
                    ),
                });
            }
            Some((dk, beta))
        }
    };
    let thread = match dims.thread_pitch {
        None => None,
        Some(p) => {
            let pitch = positive("/thread/pitch", p)?;
            let depth = match &h.thread {
                Some(Thread::Spec(ThreadSpec { depth: Some(t), .. })) => {
                    Some(positive("/thread/depth", num(t, "/thread/depth")?)?)
                }
                _ => None,
            };
            Some((pitch, depth))
        }
    };
    let thread_form = match (&thread, &h.thread) {
        (Some(_), Some(Thread::Spec(t))) => {
            let starts = match &t.starts {
                Some(s) => {
                    let n = num(s, "/thread/starts")?;
                    // Exact comparison on purpose: counts are exact integers.
                    #[allow(clippy::float_cmp)]
                    let integral = n == n.trunc();
                    if !(integral && (1.0..=8.0).contains(&n)) {
                        return Err(HoleError::InvalidCount {
                            field: "/thread/starts".into(),
                            value: n,
                            expected: "an integer in [1, 8]".into(),
                        });
                    }
                    n as u32
                }
                None => 1,
            };
            Some(HoleThreadForm {
                standard: t.standard.clone(),
                major: dims.thread_major,
                starts,
                right_hand: t.hand == forge_ir::v1::ThreadHand::Right,
                modeled: false,
            })
        }
        (Some(_), _) => Some(HoleThreadForm {
            standard: None,
            major: dims.thread_major,
            starts: 1,
            right_hand: true,
            modeled: false,
        }),
        _ => None,
    };
    let head_field = match (&h.cbore, &h.csink) {
        (Some(Counterbore::Custom(_)), _) => Some("/cbore/depth"),
        (Some(_), _) => Some("/cbore"),
        (None, Some(Countersink::Custom(_))) => Some("/csink/d"),
        (None, Some(_)) => Some("/csink"),
        (None, None) => None,
    };
    Ok(HoleSpec {
        feature: h.id.clone(),
        kind: dims.kind,
        d,
        depth,
        tip,
        cbore,
        csink,
        insert,
        size: h.size,
        thread,
        thread_form,
        head_field,
    })
}
