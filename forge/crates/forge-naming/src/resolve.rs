//! Stored references and the layered resolver of ADR 0006.
//!
//! # Resolution chain
//! 1. **Exact provenance.** Look the name up among the bodies of the reference's
//!    feature. Several hits (the same cap name on several region bodies of one feature)
//!    are narrowed by the body's region (its IR name, SPEC §3.2). A unique hit is then
//!    *validated* against the fingerprint; it is reported [`Status::Exact`] only if
//!    - its surface/curve kind is unchanged,
//!    - it has not gained or lost neighbours on the same carrier (a split or merge), and
//!    - if it belongs to an `#index` family, the family size is unchanged and the named
//!      member is also the fingerprint's best match (indices are only as stable as the
//!      sketch-level keys that order them).
//! 2. **Fingerprint among name hits** (split pieces, index siblings, region bodies):
//!    [`Status::Disambiguated`] or, for a split, [`Status::Ambiguous`] with the pieces.
//! 3. *Query filters* — IR v0 has no queries; this layer is empty until IR v1.
//! 4. **Geometric match** within the feature's bodies when the name is gone:
//!    [`Status::GeometricMatch`] with a confidence and ranked candidates, or
//!    [`Status::Ambiguous`] (ties, or the pieces of a split). A geometry-identical
//!    candidate wins (a rename); otherwise an edge whose two faces still exist by name
//!    but no longer meet is reported missing rather than matched to nearby geometry.
//! 5. **Missing.**
//!
//! Every status other than [`Status::Exact`] is a *flag*: it must be surfaced to the
//! user or agent. Confidence reaches [`AUTO_ACCEPT_CONFIDENCE`] only for a geometric
//! match that is indistinguishable from the stored fingerprint (a pure rename);
//! disambiguation and approximate matches always stay below it, so they can never be
//! accepted without confirmation.

use crate::fingerprint::{
    Comparison, Fingerprint, compare, same_support_component_edges, same_support_component_faces,
};
use crate::view::{EntityId, EntityKind, Loc, ModelView};

/// Confidence at or above which a UI or agent may accept a non-exact resolution
/// without asking. Only geometry-identical matches reach it.
pub const AUTO_ACCEPT_CONFIDENCE: f64 = 0.95;
/// Confidence of a geometry-identical match (name gone, geometry unchanged).
pub const IDENTICAL_MATCH_CONFIDENCE: f64 = 0.99;
/// Candidates scoring below this are not offered: the result is [`Status::Missing`].
pub const MIN_PLAUSIBLE: f64 = 0.35;
/// Two candidates whose scores differ by less than this fraction of the best are a tie.
pub const TIE_MARGIN: f64 = 0.1;
/// Upper bound of a disambiguation's confidence (always below auto-accept).
pub const MAX_DISAMBIGUATION_CONFIDENCE: f64 = 0.9;
/// Maximum number of candidates listed in a flagged resolution.
pub const MAX_CANDIDATES: usize = 6;

/// A stored reference to one face or edge.
///
/// The provenance `name` is the primary key; `feature` scopes it and `region` names
/// the body among a feature's region bodies. The fingerprint is consulted only to
/// validate or replace the name (see the module docs). `cardinality` is the number of
/// entities the reference denotes (1 for every reference IR v0 can express); a result
/// that would need more entities (a split) is flagged.
#[derive(Clone, Debug, PartialEq)]
pub struct EntityRef {
    /// Face or edge.
    pub kind: EntityKind,
    /// Feature that created the entity.
    pub feature: String,
    /// The owning body's region (sorted outer-loop curve ids).
    pub region: Vec<String>,
    /// Canonical provenance name.
    pub name: String,
    /// For an edge between two faces: the names of those faces (its provenance
    /// sources). Lets the resolver tell "renamed" from "gone": when both faces still
    /// resolve by name but no longer meet, the edge no longer exists.
    pub between: Option<[String; 2]>,
    /// Geometry at capture time.
    pub fingerprint: Fingerprint,
    /// Number of entities denoted.
    pub cardinality: u32,
}

impl EntityRef {
    /// Capture a reference to the entity at `loc`.
    pub fn capture(view: &ModelView, loc: Loc) -> Option<EntityRef> {
        let body = view.bodies.get(loc.body)?;
        let info = view.info(loc)?;
        Some(EntityRef {
            kind: loc.entity.kind(),
            feature: body.feature.clone(),
            region: body.region.clone(),
            name: info.name.clone(),
            between: info.between.clone(),
            fingerprint: info.fingerprint.clone(),
            cardinality: 1,
        })
    }

    /// References to every face and edge of the view, in [`ModelView::entities`] order.
    pub fn capture_all(view: &ModelView) -> Vec<(Loc, EntityRef)> {
        view.entities()
            .into_iter()
            .filter_map(|l| EntityRef::capture(view, l).map(|r| (l, r)))
            .collect()
    }
}

/// A ranked candidate.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    /// The entity.
    pub loc: Loc,
    /// Fingerprint similarity in `[0, 1]` (see [`crate::fingerprint::compare`]).
    pub score: f64,
}

/// Outcome of resolving a reference.
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    /// The name resolved to one entity whose geometry is consistent with the
    /// fingerprint. The only unflagged outcome.
    Exact(Loc),
    /// The name matched, but it had to be disambiguated or validated with the
    /// fingerprint (index siblings, several region bodies, changed kind).
    Disambiguated {
        /// The chosen entity.
        entity: Loc,
        /// Confidence in `[0, MAX_DISAMBIGUATION_CONFIDENCE]`.
        confidence: f64,
        /// Other candidates, ranked.
        alternatives: Vec<Candidate>,
    },
    /// The name is gone; these entities match the fingerprint.
    GeometricMatch {
        /// Confidence of the first candidate.
        confidence: f64,
        /// Ranked candidates (the first is the proposal).
        candidates: Vec<Candidate>,
    },
    /// The entity no longer exists (no plausible candidate).
    Missing,
    /// Several entities are equally plausible, or the entity was split into these
    /// pieces (listed name-anchored piece first, then by size).
    Ambiguous {
        /// Candidates.
        candidates: Vec<Candidate>,
    },
}

/// Why a resolution is (or is not) flagged.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Reason {
    /// Exact name match, fingerprint consistent.
    Exact,
    /// The name exists on several region bodies of the feature and the reference's
    /// region no longer names one of them.
    RegionChanged,
    /// The named entity changed surface/curve type.
    KindChanged,
    /// The named entity gained neighbours on its own carrier: it was split.
    Split,
    /// The named entity lost neighbours on its own carrier (a merge or a neighbour
    /// change).
    NeighborhoodChanged,
    /// The `#index` family changed size, or the named member is not the fingerprint's
    /// best match.
    IndexFamily,
    /// The name no longer exists in the feature; the result comes from geometry.
    NameNotFound,
    /// An edge's two faces still exist by name but no longer meet: the edge is gone
    /// (e.g. a corner replaced by a fillet), whatever geometry lies nearby.
    FacesNoLongerMeet,
    /// The feature has no bodies (suppressed, failed, removed).
    FeatureAbsent,
    /// The name is gone and nothing plausible matches the fingerprint.
    NoPlausibleMatch,
}

impl Reason {
    /// Stable lower-case label.
    pub fn as_str(self) -> &'static str {
        match self {
            Reason::Exact => "exact",
            Reason::RegionChanged => "region-changed",
            Reason::KindChanged => "kind-changed",
            Reason::Split => "split",
            Reason::NeighborhoodChanged => "neighborhood-changed",
            Reason::IndexFamily => "index-family",
            Reason::NameNotFound => "name-not-found",
            Reason::FacesNoLongerMeet => "faces-no-longer-meet",
            Reason::FeatureAbsent => "feature-absent",
            Reason::NoPlausibleMatch => "no-plausible-match",
        }
    }
}

/// A status and the reason for it.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolution {
    /// The outcome.
    pub status: Status,
    /// Why.
    pub reason: Reason,
}

impl Resolution {
    fn new(status: Status, reason: Reason) -> Self {
        Self { status, reason }
    }
    /// `true` only for [`Status::Exact`].
    pub fn is_exact(&self) -> bool {
        matches!(self.status, Status::Exact(_))
    }
    /// Anything but [`Status::Exact`] must be surfaced as a warning.
    pub fn is_flagged(&self) -> bool {
        !self.is_exact()
    }
    /// 1 for exact, the stated confidence for disambiguated and geometric matches, 0
    /// for missing and ambiguous.
    pub fn confidence(&self) -> f64 {
        match &self.status {
            Status::Exact(_) => 1.0,
            Status::Disambiguated { confidence, .. }
            | Status::GeometricMatch { confidence, .. } => *confidence,
            Status::Missing | Status::Ambiguous { .. } => 0.0,
        }
    }
    /// Proposed entities, best first (empty when missing).
    pub fn ranked(&self) -> Vec<Loc> {
        match &self.status {
            Status::Exact(l) => vec![*l],
            Status::Disambiguated {
                entity,
                alternatives,
                ..
            } => std::iter::once(*entity)
                .chain(alternatives.iter().map(|c| c.loc))
                .collect(),
            Status::GeometricMatch { candidates, .. } | Status::Ambiguous { candidates } => {
                candidates.iter().map(|c| c.loc).collect()
            }
            Status::Missing => Vec::new(),
        }
    }
    /// The proposal (first ranked entity).
    pub fn top(&self) -> Option<Loc> {
        self.ranked().first().copied()
    }
    /// Short status label: `exact`, `disambiguated`, `geometric`, `missing`, `ambiguous`.
    pub fn status_str(&self) -> &'static str {
        match self.status {
            Status::Exact(_) => "exact",
            Status::Disambiguated { .. } => "disambiguated",
            Status::GeometricMatch { .. } => "geometric",
            Status::Missing => "missing",
            Status::Ambiguous { .. } => "ambiguous",
        }
    }
    /// Human-readable summary, e.g. `geometric(0.99, name-not-found) → [plate/side:x]`.
    pub fn describe(&self, view: &ModelView) -> String {
        let names: Vec<String> = self
            .ranked()
            .iter()
            .take(3)
            .map(|l| {
                // Qualify with the region when the feature has several bodies.
                let b = &view.bodies[l.body];
                if view.bodies_of(&b.feature).len() > 1 {
                    format!("{} @{}", view.name(*l), b.region.join("+"))
                } else {
                    view.name(*l).to_string()
                }
            })
            .collect();
        match self.status {
            Status::Exact(_) => format!("exact → {}", names.join(", ")),
            Status::Missing => format!("missing ({})", self.reason.as_str()),
            _ => format!(
                "{}({:.2}, {}) → [{}]",
                self.status_str(),
                self.confidence(),
                self.reason.as_str(),
                names.join(", ")
            ),
        }
    }
}

fn fingerprint_of(view: &ModelView, loc: Loc) -> Option<&Fingerprint> {
    view.info(loc).map(|i| &i.fingerprint)
}

/// Rank `locs` by fingerprint similarity to the reference (stable for ties: view order).
fn rank(r: &EntityRef, view: &ModelView, locs: &[Loc]) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = locs
        .iter()
        .filter_map(|&l| {
            fingerprint_of(view, l).map(|fp| Candidate {
                loc: l,
                score: compare(&r.fingerprint, fp).score,
            })
        })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.loc.cmp(&b.loc)));
    out
}

/// Confidence of a choice among ranked candidates: `0.5 + 0.4 · (1 − second/best)`,
/// capped at [`MAX_DISAMBIGUATION_CONFIDENCE`].
fn margin_confidence(ranked: &[Candidate]) -> f64 {
    let best = ranked.first().map_or(0.0, |c| c.score);
    let second = ranked.get(1).map_or(0.0, |c| c.score);
    let m = if best > 0.0 { 1.0 - second / best } else { 0.0 };
    (0.5 + 0.4 * m.clamp(0.0, 1.0)).min(MAX_DISAMBIGUATION_CONFIDENCE)
}

fn disambiguated(entity: Loc, confidence: f64, mut alternatives: Vec<Candidate>) -> Status {
    alternatives.retain(|c| c.loc != entity);
    alternatives.truncate(MAX_CANDIDATES);
    Status::Disambiguated {
        entity,
        confidence,
        alternatives,
    }
}

/// Resolve a stored reference against a (re-evaluated) model.
pub fn resolve(r: &EntityRef, view: &ModelView) -> Resolution {
    let scope = view.bodies_of(&r.feature);
    if scope.is_empty() {
        return Resolution::new(Status::Missing, Reason::FeatureAbsent);
    }
    let hits: Vec<Loc> = view
        .lookup(&r.feature, &r.name)
        .iter()
        .copied()
        .filter(|l| l.entity.kind() == r.kind)
        .collect();
    match hits.as_slice() {
        [] => geometric(r, view, &scope),
        [h] => validate(r, view, *h),
        _ => {
            let same_region: Vec<Loc> = hits
                .iter()
                .copied()
                .filter(|l| view.bodies[l.body].region == r.region)
                .collect();
            if let [h] = same_region.as_slice() {
                return validate(r, view, *h);
            }
            // The region's IR name changed (its outer loop was edited): prefer the body
            // whose region shares the most curves with the stored one.
            let overlap = |l: &Loc| {
                view.bodies[l.body]
                    .region
                    .iter()
                    .filter(|c| r.region.contains(c))
                    .count()
            };
            let best = hits.iter().map(overlap).max().unwrap_or(0);
            let top: Vec<Loc> = hits
                .iter()
                .copied()
                .filter(|l| overlap(l) == best)
                .collect();
            let ranked = rank(r, view, &hits);
            if best > 0
                && let [h] = top.as_slice()
            {
                return Resolution::new(
                    disambiguated(*h, MAX_DISAMBIGUATION_CONFIDENCE, ranked),
                    Reason::RegionChanged,
                );
            }
            let conf = margin_confidence(&ranked);
            Resolution::new(
                disambiguated(ranked[0].loc, conf, ranked),
                Reason::RegionChanged,
            )
        }
    }
}

/// The **names-only baseline**: exact provenance lookup (narrowed by region when the
/// name is on several bodies) with no fingerprint validation and no fallback. Used by
/// the harness to measure how far raw names go and what the other layers add; not a
/// resolver to ship.
pub fn resolve_name_only(r: &EntityRef, view: &ModelView) -> Resolution {
    if view.bodies_of(&r.feature).is_empty() {
        return Resolution::new(Status::Missing, Reason::FeatureAbsent);
    }
    let hits: Vec<Loc> = view
        .lookup(&r.feature, &r.name)
        .iter()
        .copied()
        .filter(|l| l.entity.kind() == r.kind)
        .collect();
    let pick: Vec<Loc> = if hits.len() > 1 {
        hits.iter()
            .copied()
            .filter(|l| view.bodies[l.body].region == r.region)
            .collect()
    } else {
        hits.clone()
    };
    match (pick.as_slice(), hits.is_empty()) {
        ([h], _) => Resolution::new(Status::Exact(*h), Reason::Exact),
        (_, true) => Resolution::new(Status::Missing, Reason::NameNotFound),
        _ => Resolution::new(
            Status::Ambiguous {
                candidates: hits
                    .iter()
                    .map(|&loc| Candidate { loc, score: 0.0 })
                    .collect(),
            },
            Reason::RegionChanged,
        ),
    }
}

/// Layer 1 validation of a unique name hit (see the module docs).
fn validate(r: &EntityRef, view: &ModelView, h: Loc) -> Resolution {
    let Some(fp) = fingerprint_of(view, h) else {
        return Resolution::new(Status::Missing, Reason::NoPlausibleMatch);
    };
    let then = &r.fingerprint;
    if fp.kind != then.kind {
        return Resolution::new(disambiguated(h, 0.6, Vec::new()), Reason::KindChanged);
    }
    if fp.same_support_neighbors > then.same_support_neighbors {
        let body = &view.bodies[h.body].body;
        let pieces: Vec<Loc> = match h.entity {
            EntityId::Face(f) => {
                let fps = face_fps(view, h.body);
                same_support_component_faces(body, &fps, f)
                    .into_iter()
                    .map(|f| Loc {
                        body: h.body,
                        entity: EntityId::Face(f),
                    })
                    .collect()
            }
            EntityId::Edge(e) => {
                let fps = edge_fps(view, h.body);
                same_support_component_edges(body, &fps, e)
                    .into_iter()
                    .map(|e| Loc {
                        body: h.body,
                        entity: EntityId::Edge(e),
                    })
                    .collect()
            }
        };
        let mut cands = rank(r, view, &pieces);
        // Name-anchored piece first, then by size.
        cands.sort_by(|a, b| {
            (b.loc == h)
                .cmp(&(a.loc == h))
                .then_with(|| size_of(view, b.loc).total_cmp(&size_of(view, a.loc)))
                .then(a.loc.cmp(&b.loc))
        });
        cands.truncate(MAX_CANDIDATES);
        return Resolution::new(Status::Ambiguous { candidates: cands }, Reason::Split);
    }
    if fp.same_support_neighbors < then.same_support_neighbors {
        return Resolution::new(
            disambiguated(h, 0.7, Vec::new()),
            Reason::NeighborhoodChanged,
        );
    }
    if fp.family != then.family || fp.family > 1 {
        let fam = view.family(h);
        let ranked = rank(r, view, &fam);
        let h_score = ranked.iter().find(|c| c.loc == h).map_or(0.0, |c| c.score);
        let best = ranked[0];
        if fp.family == then.family && h_score >= best.score {
            return Resolution::new(Status::Exact(h), Reason::Exact);
        }
        let conf = margin_confidence(&ranked);
        return Resolution::new(disambiguated(best.loc, conf, ranked), Reason::IndexFamily);
    }
    Resolution::new(Status::Exact(h), Reason::Exact)
}

fn size_of(view: &ModelView, l: Loc) -> f64 {
    fingerprint_of(view, l).map_or(0.0, |f| f.size)
}

fn face_fps(
    view: &ModelView,
    body: usize,
) -> std::collections::BTreeMap<forge_core::topo::FaceId, Fingerprint> {
    view.bodies[body]
        .entities
        .iter()
        .filter_map(|(id, info)| match id {
            EntityId::Face(f) => Some((*f, info.fingerprint.clone())),
            EntityId::Edge(_) => None,
        })
        .collect()
}

fn edge_fps(
    view: &ModelView,
    body: usize,
) -> std::collections::BTreeMap<forge_core::topo::EdgeId, Fingerprint> {
    view.bodies[body]
        .entities
        .iter()
        .filter_map(|(id, info)| match id {
            EntityId::Edge(e) => Some((*e, info.fingerprint.clone())),
            EntityId::Face(_) => None,
        })
        .collect()
}

/// Layer 4: the name is gone; match the fingerprint within the feature's bodies.
fn geometric(r: &EntityRef, view: &ModelView, scope: &[usize]) -> Resolution {
    let mut comps: Vec<(Loc, Comparison, f64)> = Vec::new();
    for &bi in scope {
        for (id, info) in &view.bodies[bi].entities {
            if id.kind() != r.kind || info.fingerprint.kind != r.fingerprint.kind {
                continue;
            }
            let c = compare(&r.fingerprint, &info.fingerprint);
            comps.push((
                Loc {
                    body: bi,
                    entity: *id,
                },
                c,
                info.fingerprint.size,
            ));
        }
    }
    let cand = |l: Loc, c: &Comparison| Candidate {
        loc: l,
        score: c.score,
    };
    let mut ranked: Vec<Candidate> = comps.iter().map(|(l, c, _)| cand(*l, c)).collect();
    ranked.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.loc.cmp(&b.loc)));

    // Geometry unchanged (a pure rename).
    let identical: Vec<Candidate> = comps
        .iter()
        .filter(|(_, c, _)| c.identical)
        .map(|(l, c, _)| cand(*l, c))
        .collect();
    match identical.as_slice() {
        [one] => {
            let mut cands = vec![*one];
            cands.extend(
                ranked
                    .iter()
                    .filter(|c| c.loc != one.loc)
                    .take(MAX_CANDIDATES - 1),
            );
            return Resolution::new(
                Status::GeometricMatch {
                    confidence: IDENTICAL_MATCH_CONFIDENCE,
                    candidates: cands,
                },
                Reason::NameNotFound,
            );
        }
        [_, _, ..] => {
            return Resolution::new(
                Status::Ambiguous {
                    candidates: identical.into_iter().take(MAX_CANDIDATES).collect(),
                },
                Reason::NameNotFound,
            );
        }
        [] => {}
    }

    // An edge whose two faces both still exist by name but no longer meet is gone:
    // nearby edges are other entities (a fillet's tangent edges, say).
    if let Some([a, b]) = &r.between {
        let exists = |n: &str| {
            view.lookup(&r.feature, n)
                .iter()
                .any(|l| l.entity.kind() == EntityKind::Face)
        };
        if exists(a) && exists(b) && !scope.iter().any(|&bi| view.faces_meet(bi, a, b)) {
            return Resolution::new(Status::Missing, Reason::FacesNoLongerMeet);
        }
    }

    // Pieces: on the stored carrier and inside the stored box (a split with new names).
    let mut pieces: Vec<(Loc, Comparison, f64)> = comps
        .iter()
        .filter(|(_, c, _)| c.same_support && c.contained)
        .cloned()
        .collect();
    pieces.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
    if pieces.len() >= 2 {
        return Resolution::new(
            Status::Ambiguous {
                candidates: pieces
                    .iter()
                    .take(MAX_CANDIDATES)
                    .map(|(l, c, _)| cand(*l, c))
                    .collect(),
            },
            Reason::Split,
        );
    }
    if let [(l, c, _)] = pieces.as_slice() {
        let mut cands = vec![cand(*l, c)];
        cands.extend(
            ranked
                .iter()
                .filter(|x| x.loc != *l)
                .take(MAX_CANDIDATES - 1),
        );
        return Resolution::new(
            Status::GeometricMatch {
                confidence: 0.7,
                candidates: cands,
            },
            Reason::NameNotFound,
        );
    }

    let Some(best) = ranked.first().copied() else {
        return Resolution::new(Status::Missing, Reason::NoPlausibleMatch);
    };
    if best.score < MIN_PLAUSIBLE {
        return Resolution::new(Status::Missing, Reason::NoPlausibleMatch);
    }
    let tied: Vec<Candidate> = ranked
        .iter()
        .copied()
        .filter(|c| c.score >= best.score * (1.0 - TIE_MARGIN))
        .collect();
    if tied.len() > 1 {
        return Resolution::new(
            Status::Ambiguous {
                candidates: tied.into_iter().take(MAX_CANDIDATES).collect(),
            },
            Reason::NameNotFound,
        );
    }
    ranked.truncate(MAX_CANDIDATES);
    Resolution::new(
        Status::GeometricMatch {
            confidence: best.score.min(MAX_DISAMBIGUATION_CONFIDENCE),
            candidates: ranked,
        },
        Reason::NameNotFound,
    )
}
