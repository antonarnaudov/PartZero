//! The earlier features of a part, as queries and references see them: ids, names and types
//! (static checks, §5.3 [W0-14]), evaluation status (§5.7 step 1), the profile curves of each
//! sweep's consumed sketch (`QUERY_UNKNOWN_CURVE`), the regions each sweep created (body
//! members and junctions, §5.2 rules 3–4), tag targets (§6.12) and evaluated datums (§3.3).

use std::collections::BTreeMap;

use forge_ir::v1::{EntityKind, Feature, PartStudio, Ref, SketchCurve, SketchFeature, compound};

/// What a profile-curve id names (§4.5): the class decides whether it has ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CurveClass {
    /// A line (or a compound member that is a line).
    Line,
    /// An arc (or a compound member that is an arc).
    Arc,
    /// A full circle (no ends: no junction edges).
    Circle,
}

/// The profile curves of a sketch (non-construction lines, arcs, circles and compound
/// members), as validation computes them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Profile {
    /// Curve id → class.
    pub curves: BTreeMap<String, CurveClass>,
    /// Polygons whose `n` is an expression: any `<id>.e<k>` is a profile line.
    pub wild_polygons: Vec<String>,
}

impl Profile {
    /// The profile of a v1 sketch feature.
    pub fn of_sketch(s: &SketchFeature) -> Profile {
        let mut p = Profile::default();
        for c in &s.curves {
            let id = c.id().to_string();
            match c {
                SketchCurve::Point { .. } => {}
                _ if c.construction() => {}
                SketchCurve::Circle { .. } => {
                    p.curves.insert(id, CurveClass::Circle);
                }
                SketchCurve::Line { .. } => {
                    p.curves.insert(id, CurveClass::Line);
                }
                SketchCurve::Arc { .. } => {
                    p.curves.insert(id, CurveClass::Arc);
                }
                SketchCurve::Polygon { n, .. } if n.literal().is_none() => p.wild_polygons.push(id),
                SketchCurve::Rect { .. }
                | SketchCurve::Slot { .. }
                | SketchCurve::Polygon { .. } => {
                    let n = match c {
                        SketchCurve::Polygon { n, .. } => n
                            .literal()
                            // The same filter as validation's `solver_entities`.
                            .filter(|v| {
                                v.is_finite()
                                    && v.fract() == 0.0
                                    && v.abs() <= forge_ir::v1::MAX_COUNT_MAGNITUDE
                                    && *v <= 4096.0
                            })
                            .map(|v| v as u32),
                        _ => None,
                    };
                    for m in compound::member_names(c.kind(), n) {
                        let class = if m.starts_with("c_") || m.starts_with("cap_") {
                            CurveClass::Arc
                        } else {
                            CurveClass::Line
                        };
                        p.curves.insert(format!("{id}.{m}"), class);
                    }
                }
            }
        }
        p
    }

    /// The class of a profile-curve id, if it is one.
    pub fn class(&self, id: &str) -> Option<CurveClass> {
        if let Some(c) = self.curves.get(id) {
            return Some(*c);
        }
        for p in &self.wild_polygons {
            if let Some(rest) = id
                .strip_prefix(p.as_str())
                .and_then(|r| r.strip_prefix(".e"))
                && !rest.is_empty()
                && rest.bytes().all(|b| b.is_ascii_digit())
            {
                return Some(CurveClass::Line);
            }
        }
        None
    }
}

/// A sketch vertex that joins two consecutive curves of a region loop (forge-ops'
/// `Junction`): its planning key `a:end|b:start` (the two curve ends, sorted, `:` between id
/// and end) and its position in world coordinates, on the sketch plane.
#[derive(Clone, Debug, PartialEq)]
pub struct Junction {
    /// `"<id>:<start|end>|<id>:<start|end>"`, sorted.
    pub key: String,
    /// World position.
    pub point: [f64; 3],
}

impl Junction {
    /// The two curve ends, as `(curve id, "start" | "end")`.
    pub fn ends(&self) -> Vec<(&str, &str)> {
        self.key
            .split('|')
            .filter_map(|l| l.rsplit_once(':'))
            .collect()
    }

    /// The SPEC-v1 §5.2 junction qualifier: the byte-wise smallest `c.start` / `c.end` of the
    /// ends meeting at this vertex.
    pub fn qualifier(&self) -> Option<String> {
        self.ends()
            .into_iter()
            .map(|(c, e)| format!("{c}.{e}"))
            .min()
    }
}

/// A region a sweep feature created a body from (§5.2 rule 4).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SweepRegion {
    /// The curve ids of the region's outer loop, sorted (the body member is the first).
    pub outer_curves: Vec<String>,
    /// The curve ids of the region's inner loops (holes), sorted.
    pub inner_curves: Vec<String>,
    /// Every junction of the region's loops.
    pub junctions: Vec<Junction>,
}

impl SweepRegion {
    /// The body member: the byte-wise smallest outer-loop curve id.
    pub fn member(&self) -> Option<&str> {
        self.outer_curves.iter().map(String::as_str).min()
    }

    /// `true` if `curve` bounds the region (outer or inner loop): its side faces are the
    /// region's.
    pub fn has_curve(&self, curve: &str) -> bool {
        self.outer_curves
            .iter()
            .chain(&self.inner_curves)
            .any(|c| c == curve)
    }
}

/// An evaluated datum plane frame (§3.3) or axis (§3.4).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DatumValue {
    /// A plane frame.
    Plane(crate::frames::PlaneFrame),
    /// An oriented line.
    Axis(crate::frames::AxisLine),
}

/// How a feature fared in this evaluation.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum FeatureStatus {
    /// Evaluated successfully (or not evaluated yet: static uses).
    #[default]
    Ok,
    /// Failed with this code and message.
    Failed {
        /// Error code.
        code: String,
        /// Message.
        message: String,
    },
    /// Suppressed (skipped).
    Suppressed,
}

/// One earlier feature of the part.
#[derive(Clone, Debug, PartialEq)]
pub struct FeatureInfo {
    /// Feature id (what queries and keys use).
    pub id: String,
    /// Feature name (what display names use).
    pub name: String,
    /// Feature type (`extrude`, `revolve`, `tag`, …).
    pub ty: String,
    /// Evaluation status.
    pub status: FeatureStatus,
    /// Sweeps: the profile of the consumed sketch.
    pub profile: Option<Profile>,
    /// Sweeps: the regions the feature created bodies from, at creation (empty until the
    /// evaluator fills them in).
    pub regions: Vec<SweepRegion>,
    /// Tags: the target reference.
    pub tag: Option<Ref>,
    /// Datums: the evaluated frame or axis.
    pub datum: Option<DatumValue>,
}

impl FeatureInfo {
    /// A feature with no sweep, tag or datum data, status ok.
    pub fn new(id: impl Into<String>, name: impl Into<String>, ty: impl Into<String>) -> Self {
        FeatureInfo {
            id: id.into(),
            name: name.into(),
            ty: ty.into(),
            status: FeatureStatus::Ok,
            profile: None,
            regions: Vec::new(),
            tag: None,
            datum: None,
        }
    }

    /// The static kind of a tag's target.
    pub fn tag_kind(&self) -> Option<EntityKind> {
        self.tag.as_ref().map(|r| r.kind)
    }
}

/// The earlier features of a part, in timeline order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FeatureTable {
    features: Vec<FeatureInfo>,
    by_id: BTreeMap<String, usize>,
}

impl FeatureTable {
    /// An empty table.
    pub fn new() -> Self {
        Self::default()
    }

    /// Append a feature (timeline order). A second feature with an existing id is ignored
    /// (validation rejects duplicate ids).
    pub fn push(&mut self, f: FeatureInfo) {
        if self.by_id.contains_key(&f.id) {
            return;
        }
        self.by_id.insert(f.id.clone(), self.features.len());
        self.features.push(f);
    }

    /// The features of `part` before index `before` (the scope of feature `before`), with
    /// types, names, sweep profiles and tag targets from the document. Statuses are `Ok`
    /// except literal `suppressed: true`; regions and datums are the evaluator's to fill in.
    pub fn from_part(part: &PartStudio, before: usize) -> FeatureTable {
        let mut t = FeatureTable::new();
        let mut sketches: BTreeMap<&str, &SketchFeature> = BTreeMap::new();
        for f in part.features.iter().take(before) {
            let mut info = FeatureInfo::new(f.id(), f.name(), f.type_name());
            if f.suppressed().literal() == Some(true) {
                info.status = FeatureStatus::Suppressed;
            }
            match f {
                Feature::Sketch(s) => {
                    sketches.insert(s.id.as_str(), s);
                }
                Feature::Extrude(e) => {
                    info.profile = sketches
                        .get(e.sketch.as_str())
                        .map(|s| Profile::of_sketch(s));
                }
                Feature::Revolve(r) => {
                    info.profile = sketches
                        .get(r.sketch.as_str())
                        .map(|s| Profile::of_sketch(s));
                }
                Feature::Tag(tg) => info.tag = Some(tg.target.clone()),
                _ => {}
            }
            t.push(info);
        }
        t
    }

    /// A feature by id.
    pub fn get(&self, id: &str) -> Option<&FeatureInfo> {
        self.by_id.get(id).map(|&i| &self.features[i])
    }

    /// A feature by id, mutably (to set statuses, regions and datums).
    pub fn get_mut(&mut self, id: &str) -> Option<&mut FeatureInfo> {
        self.by_id.get(id).map(|&i| &mut self.features[i])
    }

    /// Timeline index of a feature.
    pub fn index(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }

    /// Every feature, in timeline order.
    pub fn iter(&self) -> impl Iterator<Item = &FeatureInfo> {
        self.features.iter()
    }

    /// The display name of a feature id (the id itself when unknown).
    pub fn name_of<'a>(&'a self, id: &'a str) -> &'a str {
        self.get(id).map_or(id, |f| f.name.as_str())
    }
}
