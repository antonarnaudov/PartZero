//! Naming harness **v1 mode**: the spike-2 models and mutations, with every reference an IR v1
//! [`Ref`] resolved by `forge-refs` (SPEC-v1 §5.7) instead of the spike's `EntityRef`.
//!
//! For every model and every accepted mutation (the same generators and rejection rules as the
//! spike harness, [`super::mutate`]):
//! 1. evaluate base and mutated documents; per part, build a [`forge_refs::Scope`] over the
//!    part's bodies (provenance feature names mapped to feature ids, the sweeps' regions and
//!    junctions recorded, failed and suppressed features marked);
//! 2. reference **every face and edge** of the base with a v1 query, as the plan asks: named
//!    sources for faces (`side`, `cap`/`endcap` with the body member), `edge_at` for side–side
//!    junction edges, `between` of the two faces' named sources for the other edges; resolve it
//!    on the base (it must be exact: the identity check) and capture it;
//! 3. apply the command layer's rewrite where the mutation is one (`renameCurve`, §5.9);
//! 4. resolve on the mutated model and score against the geometry-only ground truth
//!    ([`super::truth`]).
//!
//! # Scoring (v1 semantics)
//! A reference is **used** when it resolves `exact` or `accepted`; used and right is `CORRECT`
//! (`exact`) or `FLAGGED_CORRECTLY` (`accepted`: a warning or info was raised); used and wrong
//! is **`SILENT_WRONG`** whatever the warnings (the model proceeds with it). A **failed**
//! reference is `FLAGGED_CORRECTLY` when its best candidate is the ground-truth entity (or a
//! piece of it), or when the entity is gone (or its source renamed) and it failed with
//! `REF_MISSING` or a static rejection (a query naming a curve the sketch no longer has is
//! `QUERY_UNKNOWN_CURVE` in v1); otherwise `WRONG_BUT_FLAGGED`.
//!
//! New families: **rename curve** (the `renameCurve` op: must be 100 % exact), **rename
//! feature** (names change, ids do not: must be 100 % exact) and **parameter edits**
//! (must be 100 % exact): the model's parameterized variant — every extrude distance
//! (`d_<id>`), revolve angle (`a_<id>`) and sketch circle radius (`r_<sketch>_<curve>`) a
//! parameter — with one parameter changed. Until W1 evaluates expressions, the scopes' scalar
//! hook reads the parameter values off each document, and every cylinder face of a
//! parameterized circle gets a second reference whose query depends on the parameter
//! (`filter { of: side, where: { radius: { eq: "r_…" } } }`), so a stale parameter value would
//! fail the reference instead of passing unnoticed.
//!
//! Reference shapes beyond one entity per reference (no gates of their own; they count
//! towards the global 0 `SILENT_WRONG`):
//! - **(g) two edits, stale capture**: §0.6 does not refresh captures on exact commits, so a
//!   capture routinely predates several edits. Per model, a few topology-preserving first
//!   edits (distance, move by the junction gap, scale, offset) are each followed by a second
//!   edit of the edited model (reversals, reorders, renames, distance, moves, splits,
//!   suppressions); every face and edge reference is captured on the **original** model and
//!   resolved after both edits, against the composition of the two ground truths.
//! - **(h) multi-member**: per body feature, the union of its named sides (`card: some`),
//!   scored as a set: used is right only if it is exactly the ground truth of every captured
//!   member (split pieces included, gone members excluded).
//! - **(i) picks over named sources**: per body feature, `extreme +X`, `largest` and
//!   `filter { type: plane }` of that union. The query is the intent (§5.7 step 5), so the
//!   truth is the pick evaluated over the ground-truth images of the union's members, every
//!   piece of a source the edit split included (the pick chooses among the pieces).

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write as _;

use forge_core::linalg::Vec3;
use forge_core::topo::{FaceId, KeyRoleArg, parse_key};
use forge_ir::v1::metrics::RefStatus;
use forge_ir::v1::{self, AUTO_ACCEPT_CONFIDENCE, Cardinality, End, EntityKind, Query, Ref};
use forge_ir::{Document, Feature};
use forge_ops::{Region, sketch_frame};
use forge_refs::scope::ScalarHook;
use forge_refs::{
    CurveRename, Entity, EntityId, FeatureStatus, FeatureTable, Junction, Origin, Resolution,
    Scope, ScopeBuilder, SweepRegion, capture, eval_query, resolve, synthesize_query,
};
use forge_regen::{Evaluation, FeatureOutput, evaluate};

use super::models::{Model, models};
use super::mutate::{Family, Mutation, mutations};
use super::truth::{Expected, Intent, Truth, expected, label};
use super::{Outcome, Skipped, rejection, same_doc, topology_signature};
use crate::view::{EntityId as ViewId, Loc, ModelView};

/// Mutation families of the v1 harness.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum V1Family {
    /// (a) topology-preserving dimension edits.
    Dimension,
    /// (b) suppress / unsuppress.
    Suppress,
    /// (c) topology-changing edits.
    Topology,
    /// `renameCurve` ops (curve renames, with the command layer's rewrite).
    RenameCurve,
    /// Feature renames (names change, ids do not).
    RenameFeature,
    /// Parameter edits (one parameter of the parameterized variant changed).
    Parameter,
    /// Two edits in a row against the capture of the original model (§0.6).
    TwoStep,
    /// Multi-member references (`card: some`): the union of a feature's named sides.
    MultiMember,
    /// Picks and filters over named sources (`extreme`, `largest`, `filter`).
    Pick,
    /// Phase C, IR v1 models ([`super::ops`]): booleans (a cut that splits a body, a join that
    /// merges two, a moved tool, a deeper or removed cut).
    Boolean,
    /// Phase C: holes (add, move, resize, remove a position, change the kind).
    Hole,
    /// Phase C: fillets (add, remove, change the radius).
    Fillet,
    /// Phase C: patterns (count up and down, spacing, skip, circular count).
    Pattern,
}

impl V1Family {
    /// Report label.
    pub fn as_str(self) -> &'static str {
        match self {
            V1Family::Dimension => "(a) dimension",
            V1Family::Suppress => "(b) suppress",
            V1Family::Topology => "(c) topology",
            V1Family::RenameCurve => "(d) renameCurve",
            V1Family::RenameFeature => "(e) feature rename",
            V1Family::Parameter => "(f) parameter edit",
            V1Family::TwoStep => "(g) two edits, stale capture",
            V1Family::MultiMember => "(h) multi-member",
            V1Family::Pick => "(i) picks over named sources",
            V1Family::Boolean => "(j) booleans",
            V1Family::Hole => "(k) holes",
            V1Family::Fillet => "(l) fillets",
            V1Family::Pattern => "(m) patterns",
        }
    }
}

/// One scored reference.
#[derive(Clone, Debug)]
pub struct V1Record {
    /// Model.
    pub model: String,
    /// Mutation id.
    pub mutation: String,
    /// Family.
    pub family: V1Family,
    /// Face or edge.
    pub entity: EntityKind,
    /// The captured key.
    pub key: String,
    /// The reference's query (compact JSON).
    pub query: String,
    /// Ground truth, in words.
    pub expected: String,
    /// Resolution status: `exact`, `accepted` or `failed`.
    pub status: RefStatus,
    /// The failing code, if failed.
    pub code: Option<String>,
    /// Resolution in words.
    pub resolution: String,
    /// Score.
    pub outcome: Outcome,
}

/// Everything a v1 harness run produced.
#[derive(Clone, Debug, Default)]
pub struct V1Report {
    /// Models run.
    pub models: usize,
    /// Accepted mutations (by family).
    pub mutations: BTreeMap<V1Family, usize>,
    /// Scored references.
    pub refs: Vec<V1Record>,
    /// Rejected mutations.
    pub skipped: Vec<Skipped>,
    /// Base references that did not resolve exactly to their own entity (must be empty).
    pub identity_failures: Vec<String>,
    /// Key invariant problems on base and mutated models (must be empty).
    pub key_problems: Vec<String>,
    /// Captured keys containing a display index `#` (must be 0).
    pub captures_with_index: usize,
    /// Used, non-exact resolutions whose only justification is a geometric match below
    /// `IDENTICAL_MATCH_CONFIDENCE`, and candidates at or above `AUTO_ACCEPT_CONFIDENCE`
    /// (must be 0: only geometry-identical matches reach 0.95).
    pub auto_accept_violations: usize,
    /// The Phase C families' own counts ([`super::ops`]; empty when they were not run).
    pub ops: super::ops::OpsCounts,
}

// ---- scopes ------------------------------------------------------------------------------

/// A part's scope, with the map from its body indices to the view's.
struct PartScope<'v> {
    scope: Scope<'v>,
    view_bodies: Vec<usize>,
    table: FeatureTable,
}

fn sweep_region(r: &Region, frame: &forge_core::linalg::Frame) -> SweepRegion {
    SweepRegion {
        outer_curves: r.outer_curves.clone(),
        inner_curves: {
            let mut v: Vec<String> = r.holes.iter().flat_map(|l| l.sorted_ids()).collect();
            v.sort();
            v
        },
        junctions: r
            .loops()
            .flat_map(|l| l.junctions.iter())
            .map(|j| Junction {
                key: j.key.clone(),
                point: frame
                    .to_world_point(Vec3::new(j.point.x, j.point.y, 0.0))
                    .to_array(),
            })
            .collect(),
    }
}

/// Per part (document order): the scope of a feature appended at the end of the part, with
/// the document's parameter values behind the scalar hook.
fn part_scopes<'v>(
    doc: &Document,
    eval: &Evaluation,
    view: &'v ModelView,
    hook: &'v ScalarHook<'v>,
) -> Vec<PartScope<'v>> {
    let v1doc = v1::migrate_v0_to_v1(doc);
    let mut out = Vec::new();
    for (pi, part) in doc.parts.iter().enumerate() {
        let vpart = &v1doc.parts[pi];
        let mut table = FeatureTable::from_part(vpart, vpart.features.len());
        let id_of: BTreeMap<&str, &str> =
            part.features.iter().map(|f| (f.name(), f.id())).collect();
        for fe in eval.features.iter().filter(|fe| fe.part == part.name) {
            if let (Err(e), Some(id)) = (&fe.outcome, id_of.get(fe.feature.as_str()))
                && let Some(t) = table.get_mut(id)
            {
                t.status = FeatureStatus::Failed {
                    code: e.code().to_string(),
                    message: e.to_string(),
                };
            }
        }
        // Regions of each sketch, with its frame.
        let mut regions: BTreeMap<&str, (forge_core::linalg::Frame, &Vec<Region>)> =
            BTreeMap::new();
        for fe in eval.features.iter().filter(|fe| fe.part == part.name) {
            if let Ok(FeatureOutput::Regions(regs)) = &fe.outcome
                && let Some(Feature::Sketch(s)) =
                    part.features.iter().find(|f| f.name() == fe.feature)
                && let Ok(frame) = sketch_frame(&s.plane)
            {
                regions.insert(s.name.as_str(), (frame, regs));
            }
        }
        for f in &part.features {
            let sketch = match f {
                Feature::Extrude(e) => &e.sketch,
                Feature::Revolve(r) => &r.sketch,
                Feature::Sketch(_) => continue,
            };
            if let (Some((frame, regs)), Some(t)) =
                (regions.get(sketch.as_str()), table.get_mut(f.id()))
            {
                t.regions = regs.iter().map(|r| sweep_region(r, frame)).collect();
            }
        }
        let mut b = ScopeBuilder::new(table.clone()).scalars(hook);
        for f in &part.features {
            b = b.provenance_feature(f.name(), f.id());
        }
        let mut view_bodies = Vec::new();
        for (vi, be) in view.bodies.iter().enumerate() {
            if be.part != part.name {
                continue;
            }
            let Some(id) = id_of.get(be.feature.as_str()) else {
                continue;
            };
            let member = be.region.iter().min().cloned().unwrap_or_default();
            b = b.body(
                &be.body,
                Origin {
                    feature: id.to_string(),
                    member,
                    instance: None,
                },
            );
            view_bodies.push(vi);
        }
        out.push(PartScope {
            scope: b.build(),
            view_bodies,
            table,
        });
    }
    out
}

fn to_loc(ps: &PartScope<'_>, e: Entity) -> Option<Loc> {
    let body = *ps.view_bodies.get(e.body)?;
    let entity = match e.id {
        EntityId::Face(f) => ViewId::Face(f),
        EntityId::Edge(x) => ViewId::Edge(x),
        _ => return None,
    };
    Some(Loc { body, entity })
}

// ---- the v1 reference of an entity -----------------------------------------------------------

/// The named source of a face (plan W3): `side`, or `cap`/`endcap` — with the body member
/// only when the feature made several bodies (as CadScript writes `slab.cap("end")` and
/// `slab.cap("end", { body })`).
fn face_source(s: &Scope<'_>, e: Entity) -> Option<Query> {
    let p = parse_key(s.key(e)).ok()?;
    let end = |l: &str| match l {
        "start" => Some(End::Start),
        "end" => Some(End::End),
        _ => None,
    };
    let several = s
        .table()
        .get(&p.feature)
        .is_some_and(|f| f.regions.len() > 1);
    let member = if several { p.qualifier.clone() } else { None };
    match (p.label.as_str(), &p.arg) {
        ("side", KeyRoleArg::Leaf(c)) => Some(Query::Side {
            feature: p.feature,
            curve: c.clone(),
        }),
        ("cap", KeyRoleArg::Leaf(l)) => Some(Query::Cap {
            feature: p.feature,
            end: end(l)?,
            member,
        }),
        ("endcap", KeyRoleArg::Leaf(l)) => Some(Query::Endcap {
            feature: p.feature,
            end: end(l)?,
            member,
        }),
        _ => None,
    }
}

/// The v1 query referencing `e`: named face sources for faces; for edges `between` the named
/// sources of their two faces, or `edge_at` for the junction edges `between` cannot tell apart
/// (the two edges of a "D", recommendation 1); a synthesized query if none selects exactly `e`.
fn query_for(s: &Scope<'_>, e: Entity) -> Option<Query> {
    let selects = |q: &Query| {
        eval_query(q, s).is_ok_and(|r| r.members.len() == 1 && r.members[0].entity == e)
    };
    let mut tries: Vec<Query> = Vec::new();
    match e.id {
        EntityId::Face(_) => tries.extend(face_source(s, e)),
        EntityId::Edge(x) => {
            let faces: Vec<FaceId> = s.body(e).edge_faces(x);
            if let [a, b] = faces.as_slice()
                && let Some(fa) = face_source(
                    s,
                    Entity {
                        body: e.body,
                        id: EntityId::Face(*a),
                    },
                )
                && let Some(fb) = face_source(
                    s,
                    Entity {
                        body: e.body,
                        id: EntityId::Face(*b),
                    },
                )
            {
                tries.push(Query::Between {
                    a: Box::new(fa),
                    b: Box::new(fb),
                });
            }
            let p = parse_key(s.key(e)).ok()?;
            if let Some((c, end)) = p.qualifier.as_ref().and_then(|q| q.rsplit_once('.')) {
                let end = match end {
                    "start" => Some(End::Start),
                    "end" => Some(End::End),
                    _ => None,
                };
                if let Some(end) = end {
                    tries.push(Query::EdgeAt {
                        feature: p.feature.clone(),
                        curve: c.to_string(),
                        end,
                    });
                }
            }
        }
        _ => {}
    }
    tries
        .into_iter()
        .find(|q| selects(q))
        .or_else(|| synthesize_query(e, s, None))
}

// ---- scoring --------------------------------------------------------------------------------

/// The entity a candidate designates (by key and probe).
fn candidate_entity(
    s: &Scope<'_>,
    key: &str,
    probe: &forge_ir::v1::metrics::Probe,
) -> Option<Entity> {
    s.with_key(key)
        .iter()
        .copied()
        .find(|e| s.probe(*e).is_ok_and(|p| p == *probe))
}

fn score(exp: &Expected, res: &Resolution, ps: &PartScope<'_>) -> Outcome {
    let used: Vec<Loc> = res
        .members
        .iter()
        .filter_map(|m| to_loc(ps, m.entity))
        .collect();
    let top: Option<Loc> = res
        .report
        .unresolved
        .first()
        .and_then(|u| u.candidates.first())
        .and_then(|c| candidate_entity(&ps.scope, &c.key, &c.probe))
        .and_then(|e| to_loc(ps, e));
    // "Reported missing": nothing resolves, and no candidate is proposed — `REF_MISSING`, the
    // feature that made it failed (`DEPENDENCY_FAILED`), or a static rejection of a curve
    // that no longer exists, with no capture candidate.
    let missing = top.is_none()
        && res.code().is_some_and(|c| {
            matches!(
                c,
                "REF_MISSING" | "DEPENDENCY_FAILED" | "QUERY_UNKNOWN_CURVE"
            )
        });
    match exp {
        Expected::Inconclusive(_) => Outcome::Excluded,
        Expected::Same(e) | Expected::Renamed(e) => {
            if res.is_used() {
                if used == [*e] {
                    if res.status == RefStatus::Exact {
                        Outcome::Correct
                    } else {
                        Outcome::FlaggedCorrectly
                    }
                } else {
                    Outcome::SilentWrong
                }
            } else if top == Some(*e) || (missing && matches!(exp, Expected::Renamed(_))) {
                Outcome::FlaggedCorrectly
            } else {
                Outcome::WrongButFlagged
            }
        }
        Expected::Split(pieces) => {
            if res.is_used() {
                Outcome::SilentWrong
            } else if top.is_some_and(|t| pieces.contains(&t)) {
                Outcome::FlaggedCorrectly
            } else {
                Outcome::WrongButFlagged
            }
        }
        Expected::Gone => {
            if res.is_used() {
                Outcome::SilentWrong
            } else if missing {
                Outcome::FlaggedCorrectly
            } else {
                Outcome::WrongButFlagged
            }
        }
    }
}

fn describe(res: &Resolution, s: &Scope<'_>) -> String {
    match &res.error {
        None => {
            let names: Vec<String> = res
                .members
                .iter()
                .map(|m| s.display_name(m.entity))
                .collect();
            format!("{:?} → [{}]", res.status, names.join(", "))
        }
        Some(e) => {
            let cands: Vec<String> = res
                .report
                .unresolved
                .first()
                .map(|u| {
                    u.candidates
                        .iter()
                        .take(3)
                        .map(|c| format!("{} ({:.2})", c.name, c.confidence))
                        .collect()
                })
                .unwrap_or_default();
            format!("{} [{}]", e.code, cands.join(", "))
        }
    }
}

fn describe_expected(exp: &Expected, view: &ModelView) -> String {
    match exp {
        Expected::Same(l) => format!("same: {}", view.name(*l)),
        Expected::Renamed(l) => format!("renamed: {}", view.name(*l)),
        Expected::Split(ls) => format!(
            "split into [{}]",
            ls.iter()
                .map(|l| view.name(*l).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expected::Gone => "gone".to_string(),
        Expected::Inconclusive(why) => format!("inconclusive: {why}"),
    }
}

// ---- mutations ----------------------------------------------------------------------------

/// The v1 family of a spike mutation: pure curve renames are `renameCurve` ops.
fn family_of(m: &Mutation) -> V1Family {
    match m.family {
        Family::Dimension => V1Family::Dimension,
        Family::Suppress => V1Family::Suppress,
        Family::Topology if !m.intent.renamed.is_empty() => V1Family::RenameCurve,
        Family::Topology => V1Family::Topology,
    }
}

/// The feature-rename mutation: every extrude and revolve gets a new name (ids unchanged).
fn rename_features(doc: &Document) -> Option<Mutation> {
    let mut d = doc.clone();
    let mut any = false;
    for p in &mut d.parts {
        for f in &mut p.features {
            match f {
                Feature::Extrude(e) if !e.suppressed => {
                    e.name = format!("{}_rn", e.name);
                    any = true;
                }
                Feature::Revolve(r) if !r.suppressed => {
                    r.name = format!("{}_rn", r.name);
                    any = true;
                }
                _ => {}
            }
        }
    }
    any.then(|| Mutation {
        id: "rename_features:all".into(),
        family: Family::Topology,
        kind: "rename_features",
        description: "rename every body feature (ids unchanged)".into(),
        base: doc.clone(),
        mutated: d,
        intent: super::truth::Intent::identity(),
    })
}

// ---- parameter edits ----------------------------------------------------------------------

/// A parameter name from its parts (non-identifier bytes become `_`).
fn param_name(parts: &[&str]) -> String {
    parts
        .join("_")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

/// One parameter of a model's parameterized variant: where it sits and its value.
#[derive(Clone, Debug, PartialEq)]
enum Param {
    /// An extrude's distance (`d_<id>`).
    Distance { part: usize, feature: usize },
    /// A revolve's angle below 360° (`a_<id>`).
    Angle { part: usize, feature: usize },
    /// A sketch circle's radius (`r_<sketch>_<curve>`).
    Radius {
        part: usize,
        feature: usize,
        curve: usize,
    },
}

/// The parameters of `doc`'s parameterized variant, by name, with their values (unsuppressed
/// features only).
fn params_of(doc: &Document) -> BTreeMap<String, (Param, f64)> {
    let mut out = BTreeMap::new();
    for (pi, part) in doc.parts.iter().enumerate() {
        for (fi, f) in part.features.iter().enumerate() {
            match f {
                Feature::Extrude(e) if !e.suppressed => {
                    out.insert(
                        param_name(&["d", &e.id]),
                        (
                            Param::Distance {
                                part: pi,
                                feature: fi,
                            },
                            e.distance,
                        ),
                    );
                }
                Feature::Revolve(r) if !r.suppressed && r.angle < 360.0 => {
                    out.insert(
                        param_name(&["a", &r.id]),
                        (
                            Param::Angle {
                                part: pi,
                                feature: fi,
                            },
                            r.angle,
                        ),
                    );
                }
                Feature::Sketch(s) => {
                    for (ci, c) in s.curves.iter().enumerate() {
                        if let forge_ir::SketchCurve::Circle { id, radius, .. } = c {
                            out.insert(
                                param_name(&["r", &s.name, id]),
                                (
                                    Param::Radius {
                                        part: pi,
                                        feature: fi,
                                        curve: ci,
                                    },
                                    *radius,
                                ),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// `doc` with parameter `p` set to `v`.
fn with_param(doc: &Document, p: &Param, v: f64) -> Document {
    let mut d = doc.clone();
    match *p {
        Param::Distance { part, feature } => {
            if let Feature::Extrude(e) = &mut d.parts[part].features[feature] {
                e.distance = v;
            }
        }
        Param::Angle { part, feature } => {
            if let Feature::Revolve(r) = &mut d.parts[part].features[feature] {
                r.angle = v;
            }
        }
        Param::Radius {
            part,
            feature,
            curve,
        } => {
            if let Feature::Sketch(s) = &mut d.parts[part].features[feature]
                && let forge_ir::SketchCurve::Circle { radius, .. } = &mut s.curves[curve]
            {
                *radius = v;
            }
        }
    }
    d
}

/// Parameter edits (plan W3 "parameter edits → 100 % exact"): one mutation per parameter of
/// the parameterized variant — distances × 1.25, angles and radii × 0.8 — in name order.
/// Edits that change the topology are moved to the topology family by the run (like dimension
/// edits), so the family holds exactly the topology-preserving parameter edits.
fn parameter_edits(doc: &Document) -> Vec<Mutation> {
    params_of(doc)
        .into_iter()
        .map(|(name, (p, v))| {
            let factor = match p {
                Param::Distance { .. } => 1.25,
                Param::Angle { .. } | Param::Radius { .. } => 0.8,
            };
            let nv = v * factor;
            Mutation {
                id: format!("param:{name}"),
                family: Family::Dimension,
                kind: "parameter_edit",
                description: format!("parameter `{name}` = {v} → {nv}"),
                base: doc.clone(),
                mutated: with_param(doc, &p, nv),
                intent: super::truth::Intent::identity(),
            }
        })
        .collect()
}

/// The scalar hook of a document's parameterized variant: parameter name → its value there.
fn param_values(doc: &Document) -> BTreeMap<String, f64> {
    params_of(doc)
        .into_iter()
        .map(|(k, (_, v))| (k, v))
        .collect()
}

/// For a side face of a parameterized circle: a reference whose query depends on the
/// parameter, `filter { of: side, where: { radius: { eq: "r_…" } } }`.
fn param_query(
    s: &Scope<'_>,
    e: Entity,
    doc: &Document,
    params: &BTreeMap<String, f64>,
) -> Option<Query> {
    let p = parse_key(s.key(e)).ok()?;
    let KeyRoleArg::Leaf(curve) = &p.arg else {
        return None;
    };
    if p.label != "side" || p.qualifier.is_some() {
        return None;
    }
    let sketch = doc
        .parts
        .iter()
        .flat_map(|x| &x.features)
        .find_map(|f| match f {
            Feature::Extrude(x) if x.id == p.feature => Some(x.sketch.clone()),
            Feature::Revolve(x) if x.id == p.feature => Some(x.sketch.clone()),
            _ => None,
        })?;
    let name = param_name(&["r", &sketch, curve]);
    params.contains_key(&name).then(|| {
        serde_json::from_value(serde_json::json!({ "op": "filter",
            "of": { "op": "side", "feature": p.feature, "curve": curve },
            "where": { "radius": { "eq": name } } }))
        .ok()
    })?
}

/// The ground truth labels entities by feature *name*; after a feature rename, translate the
/// new model's labels back to the old names (the entities are the same design entities).
fn unrename_truth(t: &Truth, back: &BTreeMap<String, String>) -> Truth {
    use super::truth::{EdgeLabel, FaceLabel, Label};
    let f = |s: &String| back.get(s).cloned().unwrap_or_else(|| s.clone());
    let face = |l: &FaceLabel| match l {
        FaceLabel::Cap { feature, body, end } => FaceLabel::Cap {
            feature: f(feature),
            body: body.clone(),
            end: *end,
        },
        FaceLabel::Side { feature, curve } => FaceLabel::Side {
            feature: f(feature),
            curve: curve.clone(),
        },
    };
    let label = |l: &Label| match l {
        Label::Face(x) => Label::Face(face(x)),
        Label::Edge(e) => {
            let mut faces = [face(&e.faces[0]), face(&e.faces[1])];
            faces.sort();
            Label::Edge(EdgeLabel {
                faces,
                at: e.at.clone(),
            })
        }
    };
    let labels: BTreeMap<Loc, Label> = t.labels.iter().map(|(k, v)| (*k, label(v))).collect();
    let mut by_label: BTreeMap<Label, Vec<Loc>> = BTreeMap::new();
    for (l, lab) in &labels {
        by_label.entry(lab.clone()).or_default().push(*l);
    }
    Truth {
        labels,
        by_label,
        problems: t.problems.clone(),
        feature_sketch: t
            .feature_sketch
            .iter()
            .map(|(k, v)| (f(k), v.clone()))
            .collect(),
    }
}

/// New name → old name of every feature renamed between two documents (matched by id).
fn renamed_features(base: &Document, mutated: &Document) -> BTreeMap<String, String> {
    let old: BTreeMap<&str, &str> = base
        .parts
        .iter()
        .flat_map(|p| &p.features)
        .map(|f| (f.id(), f.name()))
        .collect();
    mutated
        .parts
        .iter()
        .flat_map(|p| &p.features)
        .filter_map(|f| {
            let o = old.get(f.id())?;
            (*o != f.name()).then(|| (f.name().to_string(), o.to_string()))
        })
        .collect()
}

/// The command layer's `renameCurve` rewrite for a mutation that renames curves.
fn renames(m: &Mutation, base: &Document, ps: &PartScope<'_>) -> Vec<CurveRename> {
    let Some(sketch) = &m.intent.sketch else {
        return Vec::new();
    };
    let consumers: Vec<String> = base
        .parts
        .iter()
        .flat_map(|p| &p.features)
        .filter_map(|f| match f {
            Feature::Extrude(e) if e.sketch == *sketch => Some(e.id.clone()),
            Feature::Revolve(r) if r.sketch == *sketch => Some(r.id.clone()),
            _ => None,
        })
        .collect();
    m.intent
        .renamed
        .iter()
        .filter_map(|old| {
            let new = m.intent.curve_map.get(old)?.first()?;
            Some(CurveRename::new(
                &ps.table,
                consumers.clone(),
                old.clone(),
                new.clone(),
            ))
        })
        .collect()
}

// ---- the run ----------------------------------------------------------------------------------

struct Evaluated {
    eval: Evaluation,
    view: ModelView,
}

fn evaluated(doc: &Document) -> Evaluated {
    let eval = evaluate(doc);
    let view = ModelView::from_evaluation(doc, &eval);
    Evaluated { eval, view }
}

/// Run the v1 harness over `models`.
pub fn run_v1_models(models: &[Model]) -> V1Report {
    let mut rep = V1Report {
        models: models.len(),
        ..V1Report::default()
    };
    for model in models {
        let base_ev = evaluated(&model.doc);
        let base_truth = label(&model.doc, &base_ev.view);
        let mut muts = mutations(&model.doc);
        muts.extend(rename_features(&model.doc));
        muts.extend(parameter_edits(&model.doc));
        for mut m in muts {
            let own;
            let (bev, btruth): (&Evaluated, &Truth) = if same_doc(&m.base, &model.doc) {
                (&base_ev, &base_truth)
            } else {
                let e = evaluated(&m.base);
                let t = label(&m.base, &e.view);
                own = (e, t);
                (&own.0, &own.1)
            };
            let new_ev = evaluated(&m.mutated);
            if m.family == Family::Dimension
                && new_ev.view.failed.is_empty()
                && topology_signature(&bev.view) != topology_signature(&new_ev.view)
            {
                m.family = Family::Topology;
                m.kind = "dimension_edit_changing_topology";
            }
            if let Some(reason) = rejection(&m, &bev.view, &new_ev.view) {
                rep.skipped.push(Skipped {
                    model: model.name.to_string(),
                    id: m.id.clone(),
                    family: m.family,
                    reason,
                });
                continue;
            }
            let family = match m.kind {
                "rename_features" => V1Family::RenameFeature,
                "parameter_edit" => V1Family::Parameter,
                _ => family_of(&m),
            };
            *rep.mutations.entry(family).or_default() += 1;
            let mut new_truth = label(&m.mutated, &new_ev.view);
            let back = renamed_features(&m.base, &m.mutated);
            if !back.is_empty() {
                new_truth = unrename_truth(&new_truth, &back);
            }
            // Each document's parameter values behind its scopes' scalar hook.
            let (base_params, new_params) = (param_values(&m.base), param_values(&m.mutated));
            let base_hook = |t: &str| base_params.get(t).copied();
            let new_hook = |t: &str| new_params.get(t).copied();
            let base_scopes = part_scopes(&m.base, &bev.eval, &bev.view, &base_hook);
            let new_scopes = part_scopes(&m.mutated, &new_ev.eval, &new_ev.view, &new_hook);
            for ps in base_scopes.iter().chain(&new_scopes) {
                for p in ps.scope.key_problems() {
                    rep.key_problems.push(format!(
                        "{} {}: {} ({})",
                        model.name, m.id, p.key, p.problem
                    ));
                }
            }
            for (pi, bps) in base_scopes.iter().enumerate() {
                // The same part in the mutated document (parts may be reordered).
                let pid = &m.base.parts[pi].id;
                let Some(npi) = m.mutated.parts.iter().position(|p| p.id == *pid) else {
                    continue;
                };
                let nps = &new_scopes[npi];
                let rewrites = renames(&m, &m.base, bps);
                for kind in [EntityKind::Face, EntityKind::Edge] {
                    for e in bps.scope.canonical(bps.scope.entities(kind)) {
                        let Some(loc) = to_loc(bps, e) else { continue };
                        let Some(q) = query_for(&bps.scope, e) else {
                            rep.identity_failures.push(format!(
                                "{} {}: no query selects {}",
                                model.name,
                                m.id,
                                bps.scope.key(e)
                            ));
                            continue;
                        };
                        let mut queries = vec![q];
                        if family == V1Family::Parameter
                            && let Some(pq) = param_query(&bps.scope, e, &m.base, &base_params)
                        {
                            queries.push(pq);
                        }
                        for q in queries {
                            let ctx = RefCtx {
                                model: model.name,
                                m: &m,
                                family,
                                btruth,
                                new_truth: &new_truth,
                                new_view: &new_ev.view,
                                bps,
                                nps,
                                rewrites: &rewrites,
                            };
                            score_ref(&mut rep, &ctx, kind, e, loc, q);
                        }
                    }
                }
                // (h) and (i): the set references of the part.
                let ctx = RefCtx {
                    model: model.name,
                    m: &m,
                    family,
                    btruth,
                    new_truth: &new_truth,
                    new_view: &new_ev.view,
                    bps,
                    nps,
                    rewrites: &rewrites,
                };
                score_set_refs(&mut rep, &ctx);
            }
            for f in [V1Family::MultiMember, V1Family::Pick] {
                *rep.mutations.entry(f).or_default() += 1;
            }
        }
        // (g): two edits against the original capture.
        two_step(&mut rep, model, &base_ev, &base_truth);
    }
    rep
}

/// What one reference of a mutation is scored against.
struct RefCtx<'c, 'v> {
    model: &'c str,
    m: &'c Mutation,
    family: V1Family,
    btruth: &'c Truth,
    new_truth: &'c Truth,
    new_view: &'c ModelView,
    bps: &'c PartScope<'v>,
    nps: &'c PartScope<'v>,
    rewrites: &'c [CurveRename],
}

/// Resolve `q` (referencing base entity `e`) on the base (the identity check) and capture it,
/// apply the command layer's rewrites, resolve on the mutated model and score it.
fn score_ref(
    rep: &mut V1Report,
    c: &RefCtx<'_, '_>,
    kind: EntityKind,
    e: Entity,
    loc: Loc,
    q: Query,
) {
    let (bps, nps) = (c.bps, c.nps);
    let fresh = Ref {
        kind,
        q,
        card: None,
        capture: None,
    };
    let base_res = resolve(&fresh, &bps.scope);
    if base_res.status != RefStatus::Exact || base_res.entities() != [e] {
        rep.identity_failures.push(format!(
            "{} {}: {} → {}",
            c.model,
            c.m.id,
            bps.scope.key(e),
            describe(&base_res, &bps.scope)
        ));
        return;
    }
    let Ok(cap) = capture(&base_res.members, &bps.scope) else {
        rep.identity_failures.push(format!(
            "{} {}: cannot capture {}",
            c.model,
            c.m.id,
            bps.scope.key(e)
        ));
        return;
    };
    rep.captures_with_index += cap.members.iter().filter(|x| x.key.contains('#')).count();
    let mut rf = Ref {
        capture: Some(cap),
        ..fresh
    };
    let key = bps.scope.key(e).to_string();
    for rn in c.rewrites {
        rf = rn.apply(&rf);
    }
    let mut exp = expected(c.btruth, c.new_truth, &c.m.intent, loc);
    if exp == Expected::Gone && !c.new_truth.problems.is_empty() {
        exp = Expected::Inconclusive("mutated model has unlabelled entities".into());
    }
    let res = resolve(&rf, &nps.scope);
    let outcome = score(&exp, &res, nps);
    count_auto_accept(rep, &res);
    rep.refs.push(V1Record {
        model: c.model.to_string(),
        mutation: c.m.id.clone(),
        family: c.family,
        entity: kind,
        key,
        query: serde_json::to_string(&rf.q).unwrap_or_default(),
        expected: describe_expected(&exp, c.new_view),
        status: res.status,
        code: res.code().map(str::to_string),
        resolution: describe(&res, &nps.scope),
        outcome,
    });
}

// ---- (h), (i): set references ----------------------------------------------------------------

/// The named `side` sources of a feature in a scope, one per side curve (sorted).
fn side_sources(s: &Scope<'_>, feature: &str) -> Vec<Query> {
    let mut curves: BTreeSet<String> = BTreeSet::new();
    for e in s.entities(EntityKind::Face) {
        if let Ok(p) = parse_key(s.key(e))
            && p.feature == feature
            && p.label == "side"
            && p.qualifier.is_none()
            && let KeyRoleArg::Leaf(c) = &p.arg
        {
            curves.insert(c.clone());
        }
    }
    curves
        .into_iter()
        .map(|curve| Query::Side {
            feature: feature.to_string(),
            curve,
        })
        .collect()
}

/// A set reference of a base part.
struct SetRef {
    family: V1Family,
    /// E.g. `e1 extreme +X`.
    label: String,
    /// The union of named sides the pick runs over.
    source: Query,
    q: Query,
}

/// Per body feature with two or more named sides: the union of its sides (h), and `extreme
/// +X`, `largest` and `filter { type: plane }` of it (i).
fn set_refs(bps: &PartScope<'_>) -> Vec<SetRef> {
    let mut out = Vec::new();
    for f in bps.table.iter() {
        if !matches!(f.ty.as_str(), "extrude" | "revolve") || !matches!(f.status, FeatureStatus::Ok)
        {
            continue;
        }
        let srcs = side_sources(&bps.scope, &f.id);
        if srcs.len() < 2 {
            continue;
        }
        let source = Query::Union { of: srcs };
        let Ok(sj) = serde_json::to_value(&source) else {
            continue;
        };
        out.push(SetRef {
            family: V1Family::MultiMember,
            label: format!("{} sides", f.id),
            source: source.clone(),
            q: source.clone(),
        });
        for (label, v) in [
            (
                "extreme +X",
                serde_json::json!({ "op": "extreme", "of": sj, "dir": "+X", "which": "max" }),
            ),
            ("largest", serde_json::json!({ "op": "largest", "of": sj })),
            (
                "filter plane",
                serde_json::json!({ "op": "filter", "of": sj, "where": { "type": "plane" } }),
            ),
        ] {
            if let Ok(q) = serde_json::from_value::<Query>(v) {
                out.push(SetRef {
                    family: V1Family::Pick,
                    label: format!("{} {label}", f.id),
                    source: source.clone(),
                    q,
                });
            }
        }
    }
    out
}

/// The ground truth of a base entity after the context's mutation.
fn truth_of(c: &RefCtx<'_, '_>, e: Entity) -> Expected {
    let Some(loc) = to_loc(c.bps, e) else {
        return Expected::Inconclusive("no view entity".into());
    };
    let exp = expected(c.btruth, c.new_truth, &c.m.intent, loc);
    if exp == Expected::Gone && !c.new_truth.problems.is_empty() {
        return Expected::Inconclusive("mutated model has unlabelled entities".into());
    }
    exp
}

/// The truth of a multi-member reference: the images of every captured member (split pieces
/// included, gone members excluded).
fn set_truth(members: &[(String, Expected)]) -> Result<BTreeSet<Loc>, String> {
    let mut want = BTreeSet::new();
    for (_, e) in members {
        match e {
            Expected::Same(l) | Expected::Renamed(l) => {
                want.insert(*l);
            }
            Expected::Split(ls) => want.extend(ls.iter().copied()),
            Expected::Gone => {}
            Expected::Inconclusive(w) => return Err(w.clone()),
        }
    }
    Ok(want)
}

/// The truth of a pick: the pick evaluated (in the mutated scope) over the ground-truth images
/// of the members of its source on the base, every piece of a split source included.
fn pick_truth(c: &RefCtx<'_, '_>, sr: &SetRef) -> Result<BTreeSet<Loc>, String> {
    let base = eval_query(&sr.source, &c.bps.scope).map_err(|e| e.to_string())?;
    let nps = c.nps;
    let by_loc: BTreeMap<Loc, Entity> = nps
        .scope
        .entities(EntityKind::Face)
        .into_iter()
        .filter_map(|e| Some((to_loc(nps, e)?, e)))
        .collect();
    let mut images: Vec<Entity> = Vec::new();
    for e in base.entities() {
        match truth_of(c, e) {
            Expected::Same(l) | Expected::Renamed(l) => {
                images.push(*by_loc.get(&l).ok_or("an image outside the scope")?);
            }
            Expected::Gone => {}
            Expected::Split(ls) => {
                for l in ls {
                    images.push(*by_loc.get(&l).ok_or("a piece outside the scope")?);
                }
            }
            Expected::Inconclusive(w) => return Err(w),
        }
    }
    if images.is_empty() {
        return Ok(BTreeSet::new());
    }
    let mut of = Vec::with_capacity(images.len());
    for e in &images {
        of.push(synthesize_query(*e, &nps.scope, None).ok_or("no query selects an image")?);
    }
    let mut v = serde_json::to_value(&sr.q).map_err(|e| e.to_string())?;
    v["of"] = serde_json::to_value(Query::Union { of }).map_err(|e| e.to_string())?;
    let q: Query = serde_json::from_value(v).map_err(|e| e.to_string())?;
    let set = eval_query(&q, &nps.scope).map_err(|e| e.to_string())?;
    set.entities()
        .into_iter()
        .map(|e| to_loc(nps, e).ok_or_else(|| "a picked image outside the view".to_string()))
        .collect()
}

/// Score a set reference: used is right only if it is exactly `want`; a failure is flagged
/// correctly when its first unresolved member's top candidate is in `want` or is that
/// member's own truth (or the member is gone and reported missing), or when a set-level
/// failure (cardinality, a rejection) follows a real change or the truth breaks the card
/// (`card: None` is the default `one`).
fn score_set(
    want: &BTreeSet<Loc>,
    members: &[(String, Expected)],
    card: Option<Cardinality>,
    res: &Resolution,
    ps: &PartScope<'_>,
) -> Outcome {
    if members
        .iter()
        .any(|(_, e)| matches!(e, Expected::Inconclusive(_)))
    {
        return Outcome::Excluded;
    }
    if res.is_used() {
        let used: BTreeSet<Loc> = res
            .members
            .iter()
            .filter_map(|m| to_loc(ps, m.entity))
            .collect();
        return if used != *want {
            Outcome::SilentWrong
        } else if res.status == RefStatus::Exact {
            Outcome::Correct
        } else {
            Outcome::FlaggedCorrectly
        };
    }
    let first = res.report.unresolved.first();
    let top: Option<Loc> = first
        .and_then(|u| u.candidates.first())
        .and_then(|c| candidate_entity(&ps.scope, &c.key, &c.probe))
        .and_then(|e| to_loc(ps, e));
    let missing = top.is_none()
        && res.code().is_some_and(|c| {
            matches!(
                c,
                "REF_MISSING" | "DEPENDENCY_FAILED" | "QUERY_UNKNOWN_CURVE"
            )
        });
    let flagged = match first {
        Some(u) if !u.key.is_empty() => {
            top.is_some_and(|t| want.contains(&t))
                || members
                    .iter()
                    .filter(|(k, _)| *k == u.key)
                    .any(|(_, e)| match e {
                        Expected::Same(l) => top == Some(*l),
                        Expected::Renamed(l) => top == Some(*l) || missing,
                        Expected::Split(ls) => top.is_some_and(|t| ls.contains(&t)),
                        Expected::Gone => missing,
                        Expected::Inconclusive(_) => false,
                    })
        }
        _ => {
            // A set-level failure: right when the truth itself breaks the card (a pick that
            // now ties), or follows a real change of a member.
            let card_breaks = match card {
                None => want.len() != 1,
                Some(_) => want.is_empty(),
            };
            card_breaks
                || members.iter().any(|(_, e)| !matches!(e, Expected::Same(_)))
                || (want.is_empty() && missing)
        }
    };
    if flagged {
        Outcome::FlaggedCorrectly
    } else {
        Outcome::WrongButFlagged
    }
}

/// The set references (h), (i) of one part of one mutation.
fn score_set_refs(rep: &mut V1Report, c: &RefCtx<'_, '_>) {
    let (bps, nps) = (c.bps, c.nps);
    for sr in set_refs(bps) {
        let Ok(base_set) = eval_query(&sr.q, &bps.scope) else {
            continue;
        };
        if base_set.members.is_empty() {
            continue;
        }
        // A pick with one answer is a single-entity reference (default card `one`).
        let card = (sr.family == V1Family::MultiMember || base_set.members.len() > 1)
            .then_some(Cardinality::SOME);
        let fresh = Ref {
            kind: EntityKind::Face,
            q: sr.q.clone(),
            card,
            capture: None,
        };
        let base_res = resolve(&fresh, &bps.scope);
        if base_res.status != RefStatus::Exact || base_res.entities() != base_set.entities() {
            rep.identity_failures.push(format!(
                "{} {}: {} → {}",
                c.model,
                c.m.id,
                sr.label,
                describe(&base_res, &bps.scope)
            ));
            continue;
        }
        let Ok(cap) = capture(&base_res.members, &bps.scope) else {
            rep.identity_failures.push(format!(
                "{} {}: cannot capture {}",
                c.model, c.m.id, sr.label
            ));
            continue;
        };
        rep.captures_with_index += cap.members.iter().filter(|x| x.key.contains('#')).count();
        let mut rf = Ref {
            capture: Some(cap),
            ..fresh
        };
        for rn in c.rewrites {
            rf = rn.apply(&rf);
        }
        // Each captured member (keys as rewritten) with its truth.
        let members: Vec<(String, Expected)> = rf
            .capture
            .iter()
            .flat_map(|cap| &cap.members)
            .zip(&base_res.members)
            .map(|(cm, m)| (cm.key.clone(), truth_of(c, m.entity)))
            .collect();
        let want = if sr.family == V1Family::Pick {
            pick_truth(c, &sr)
        } else {
            set_truth(&members)
        };
        let res = resolve(&rf, &nps.scope);
        let (outcome, expected) = match &want {
            Err(why) => (Outcome::Excluded, format!("inconclusive: {why}")),
            Ok(w) => (
                score_set(w, &members, card, &res, nps),
                format!(
                    "[{}]",
                    w.iter()
                        .map(|l| c.new_view.name(*l).to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ),
        };
        count_auto_accept(rep, &res);
        rep.refs.push(V1Record {
            model: c.model.to_string(),
            mutation: c.m.id.clone(),
            family: sr.family,
            entity: EntityKind::Face,
            key: sr.label.clone(),
            query: serde_json::to_string(&rf.q).unwrap_or_default(),
            expected,
            status: res.status,
            code: res.code().map(str::to_string),
            resolution: describe(&res, &nps.scope),
            outcome,
        });
    }
}

/// Candidates at or above the auto-accept confidence that are not geometry-identical.
fn count_auto_accept(rep: &mut V1Report, res: &Resolution) {
    rep.auto_accept_violations += res
        .report
        .unresolved
        .iter()
        .flat_map(|u| &u.candidates)
        .filter(|x| {
            x.confidence >= AUTO_ACCEPT_CONFIDENCE
                && x.reason != forge_ir::v1::metrics::CandidateReason::Identical
        })
        .count();
}

// ---- (g): two edits against one capture ----------------------------------------------------

/// First edits of (g): topology-preserving (exact commits, which never refresh a capture),
/// at most one per kind and model.
const FIRST_KINDS: [&str; 3] = [
    "extrude_distance",
    "move_loop_by_junction_gap",
    "scale_sketch",
];

/// Second edits of (g), on the first edit's result, at most [`SECOND_PER_KIND`] per kind.
const SECOND_KINDS: [&str; 7] = [
    "reverse_curve",
    "reorder_curves",
    "rename_curve",
    "extrude_distance",
    "move_loop_by_junction_gap",
    "split_line_keep_id",
    "suppress_feature",
];

const SECOND_PER_KIND: usize = 2;

/// The truth of a two-edit sequence: the composition of the two ground truths (a split by
/// the first edit is inconclusive; the first edits of (g) preserve topology).
fn compose(t0: &Truth, t1: &Truth, i1: &Intent, t2: &Truth, i2: &Intent, loc: Loc) -> Expected {
    let gone = |t: &Truth| {
        if t.problems.is_empty() {
            Expected::Gone
        } else {
            Expected::Inconclusive("edited model has unlabelled entities".into())
        }
    };
    let (mid, renamed) = match expected(t0, t1, i1, loc) {
        Expected::Same(l) => (l, false),
        Expected::Renamed(l) => (l, true),
        Expected::Split(_) => return Expected::Inconclusive("split by the first edit".into()),
        Expected::Gone => return gone(t1),
        other => return other,
    };
    match expected(t1, t2, i2, mid) {
        Expected::Same(l) if renamed => Expected::Renamed(l),
        Expected::Gone => gone(t2),
        other => other,
    }
}

/// (g) for one model: every face and edge reference captured on the original model, resolved
/// after a first and a second edit.
fn two_step(rep: &mut V1Report, model: &Model, base_ev: &Evaluated, base_truth: &Truth) {
    let doc = &model.doc;
    if !base_ev.view.failed.is_empty() {
        return;
    }
    let base_params = param_values(doc);
    let base_hook = |t: &str| base_params.get(t).copied();
    let base_scopes = part_scopes(doc, &base_ev.eval, &base_ev.view, &base_hook);
    // The references of the original model, captured once: (part, kind, loc, key, ref).
    let mut refs: Vec<(usize, EntityKind, Loc, String, Ref)> = Vec::new();
    for (pi, bps) in base_scopes.iter().enumerate() {
        for kind in [EntityKind::Face, EntityKind::Edge] {
            for e in bps.scope.canonical(bps.scope.entities(kind)) {
                let (Some(loc), Some(q)) = (to_loc(bps, e), query_for(&bps.scope, e)) else {
                    continue;
                };
                let fresh = Ref {
                    kind,
                    q,
                    card: None,
                    capture: None,
                };
                // Identity failures are reported by the single-edit families.
                let res = resolve(&fresh, &bps.scope);
                if res.status != RefStatus::Exact || res.entities() != [e] {
                    continue;
                }
                let Ok(cap) = capture(&res.members, &bps.scope) else {
                    continue;
                };
                let key = bps.scope.key(e).to_string();
                refs.push((
                    pi,
                    kind,
                    loc,
                    key,
                    Ref {
                        capture: Some(cap),
                        ..fresh
                    },
                ));
            }
        }
    }
    let mut firsts: BTreeSet<&str> = BTreeSet::new();
    for a in mutations(doc) {
        if !FIRST_KINDS.contains(&a.kind)
            || firsts.contains(a.kind)
            || a.family != Family::Dimension
            || !a.intent.renamed.is_empty()
            || !same_doc(&a.base, doc)
        {
            continue;
        }
        let a_ev = evaluated(&a.mutated);
        if rejection(&a, &base_ev.view, &a_ev.view).is_some() {
            continue;
        }
        firsts.insert(a.kind);
        let a_truth = label(&a.mutated, &a_ev.view);
        let a_params = param_values(&a.mutated);
        let a_hook = |t: &str| a_params.get(t).copied();
        let a_scopes = part_scopes(&a.mutated, &a_ev.eval, &a_ev.view, &a_hook);
        let mut per_kind: BTreeMap<&str, usize> = BTreeMap::new();
        for mut b in mutations(&a.mutated) {
            if !SECOND_KINDS.contains(&b.kind)
                || per_kind.get(b.kind).copied().unwrap_or(0) >= SECOND_PER_KIND
                || !same_doc(&b.base, &a.mutated)
            {
                continue;
            }
            let ab_ev = evaluated(&b.mutated);
            if b.family == Family::Dimension
                && ab_ev.view.failed.is_empty()
                && topology_signature(&a_ev.view) != topology_signature(&ab_ev.view)
            {
                b.family = Family::Topology;
            }
            let id = format!("{} + {}", a.id, b.id);
            if let Some(reason) = rejection(&b, &a_ev.view, &ab_ev.view) {
                rep.skipped.push(Skipped {
                    model: model.name.to_string(),
                    id,
                    family: b.family,
                    reason,
                });
                continue;
            }
            *per_kind.entry(b.kind).or_default() += 1;
            *rep.mutations.entry(V1Family::TwoStep).or_default() += 1;
            let ab_truth = label(&b.mutated, &ab_ev.view);
            let ab_params = param_values(&b.mutated);
            let ab_hook = |t: &str| ab_params.get(t).copied();
            let ab_scopes = part_scopes(&b.mutated, &ab_ev.eval, &ab_ev.view, &ab_hook);
            for ps in &ab_scopes {
                for p in ps.scope.key_problems() {
                    rep.key_problems
                        .push(format!("{} {id}: {} ({})", model.name, p.key, p.problem));
                }
            }
            // Per base part: its index in both edited documents and the second edit's
            // renameCurve rewrites (made on the first edit's result).
            let parts: Vec<Option<(usize, Vec<CurveRename>)>> = doc
                .parts
                .iter()
                .map(|p| {
                    let api = a.mutated.parts.iter().position(|x| x.id == p.id)?;
                    let npi = b.mutated.parts.iter().position(|x| x.id == p.id)?;
                    Some((npi, renames(&b, &a.mutated, &a_scopes[api])))
                })
                .collect();
            for (pi, kind, loc, key, rf0) in &refs {
                let Some((npi, rewrites)) = &parts[*pi] else {
                    continue;
                };
                let mut rf = rf0.clone();
                for rn in rewrites {
                    rf = rn.apply(&rf);
                }
                let exp = compose(base_truth, &a_truth, &a.intent, &ab_truth, &b.intent, *loc);
                let nps = &ab_scopes[*npi];
                let res = resolve(&rf, &nps.scope);
                let outcome = score(&exp, &res, nps);
                count_auto_accept(rep, &res);
                rep.refs.push(V1Record {
                    model: model.name.to_string(),
                    mutation: id.clone(),
                    family: V1Family::TwoStep,
                    entity: *kind,
                    key: key.clone(),
                    query: serde_json::to_string(&rf.q).unwrap_or_default(),
                    expected: describe_expected(&exp, &ab_ev.view),
                    status: res.status,
                    code: res.code().map(str::to_string),
                    resolution: describe(&res, &nps.scope),
                    outcome,
                });
            }
        }
    }
}

/// Run the v1 harness over all spike models, then the Phase C operation families on their
/// IR v1 models ([`super::ops::run_ops`]).
pub fn run_v1() -> V1Report {
    let mut rep = run_v1_models(&models());
    rep.ops = super::ops::run_ops(&mut rep);
    rep
}

/// A base reference's resolution on its own model must be exact and point at itself.
pub fn v1_identity_failures(doc: &Document) -> Vec<String> {
    let ev = evaluated(doc);
    let params = param_values(doc);
    let hook = |t: &str| params.get(t).copied();
    let mut out = Vec::new();
    for ps in part_scopes(doc, &ev.eval, &ev.view, &hook) {
        for kind in [EntityKind::Face, EntityKind::Edge, EntityKind::Vertex] {
            for e in ps.scope.canonical(ps.scope.entities(kind)) {
                let q = match kind {
                    EntityKind::Vertex => synthesize_query(e, &ps.scope, None),
                    _ => query_for(&ps.scope, e),
                };
                let Some(q) = q else {
                    out.push(format!("no query selects {}", ps.scope.key(e)));
                    continue;
                };
                let r = Ref {
                    kind,
                    q,
                    card: None,
                    capture: None,
                };
                let res = resolve(&r, &ps.scope);
                if res.status != RefStatus::Exact || res.entities() != [e] {
                    out.push(format!(
                        "{} → {}",
                        ps.scope.key(e),
                        describe(&res, &ps.scope)
                    ));
                    continue;
                }
                // With its capture, on the same model: still exact.
                let mut rc = r.clone();
                rc.capture = capture(&res.members, &ps.scope).ok();
                let again = resolve(&rc, &ps.scope);
                if again.status != RefStatus::Exact || again.entities() != [e] {
                    out.push(format!(
                        "{} (captured) → {}",
                        ps.scope.key(e),
                        describe(&again, &ps.scope)
                    ));
                }
            }
        }
    }
    out
}

// ---- criteria and report ------------------------------------------------------------------

/// Counts of outcomes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct V1Tally {
    /// All.
    pub total: usize,
    /// `CORRECT`.
    pub correct: usize,
    /// `FLAGGED_CORRECTLY`.
    pub flagged_correctly: usize,
    /// `WRONG_BUT_FLAGGED`.
    pub wrong_but_flagged: usize,
    /// `SILENT_WRONG`.
    pub silent_wrong: usize,
    /// Excluded.
    pub excluded: usize,
}

impl V1Tally {
    fn add(&mut self, o: Outcome) {
        self.total += 1;
        match o {
            Outcome::Correct => self.correct += 1,
            Outcome::FlaggedCorrectly => self.flagged_correctly += 1,
            Outcome::WrongButFlagged => self.wrong_but_flagged += 1,
            Outcome::SilentWrong => self.silent_wrong += 1,
            Outcome::Excluded => self.excluded += 1,
        }
    }
    /// Scored.
    pub fn scored(&self) -> usize {
        self.total - self.excluded
    }
    /// `(CORRECT + FLAGGED_CORRECTLY) / scored`.
    pub fn correct_rate(&self) -> f64 {
        ratio(self.correct + self.flagged_correctly, self.scored())
    }
    /// `CORRECT / scored`.
    pub fn exact_rate(&self) -> f64 {
        ratio(self.correct, self.scored())
    }
}

/// `a / b`, or NaN when nothing was scored: an empty family never passes a rate gate
/// (`NaN >= x` is false) and renders as `n/a`.
fn ratio(a: usize, b: usize) -> f64 {
    if b == 0 {
        f64::NAN
    } else {
        a as f64 / b as f64
    }
}

/// Tallies per family.
pub fn tallies(rep: &V1Report) -> BTreeMap<V1Family, V1Tally> {
    let mut m: BTreeMap<V1Family, V1Tally> = BTreeMap::new();
    for r in &rep.refs {
        m.entry(r.family).or_default().add(r.outcome);
    }
    m
}

/// The v1 gates of the plan (W3 acceptance, naming harness v1).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct V1Criteria {
    /// (a) correct rate.
    pub dimension: f64,
    /// (b) correct rate.
    pub suppress: f64,
    /// (c) correct rate.
    pub topology: f64,
    /// renameCurve exact rate.
    pub rename_curve_exact: f64,
    /// Feature rename exact rate.
    pub rename_feature_exact: f64,
    /// Parameter edit exact rate.
    pub parameter_exact: f64,
    /// (g) two edits, stale capture: correct rate (informational, no gate of its own).
    pub two_step: f64,
    /// (h) multi-member: correct rate (informational).
    pub multi_member: f64,
    /// (i) picks over named sources: correct rate (informational).
    pub pick: f64,
    /// (j) booleans: correct rate (W4/F1 gate: ≥ 90 %).
    pub boolean: f64,
    /// (k) holes: correct rate (≥ 90 %).
    pub hole: f64,
    /// (l) fillets: correct rate (≥ 90 %).
    pub fillet: f64,
    /// (m) patterns: correct rate (≥ 90 %).
    pub pattern: f64,
    /// SILENT_WRONG over all families.
    pub silent_wrong: usize,
    /// Identity failures, key problems, `#` in captures, candidates at auto-accept.
    pub invariant_failures: usize,
    /// The spike families (a)–(i) ran (`false` for `--ops-only`): their gates apply.
    pub spike_ran: bool,
    /// Coverage problems ([`coverage_problems`]): a skipped Phase C mutation, a family below its
    /// minimum mutations or scored references, too few scored blend references, a spike family
    /// that scored nothing.
    pub coverage_failures: usize,
}

impl V1Criteria {
    /// GO: (a) ≥ 99.9 %, (b) 100 %, (c) ≥ 99 %, renames and parameter edits 100 % exact (when
    /// the spike families ran), the Phase C families (j)–(m) ≥ 90 % correct (the plan's W4
    /// boolean-family gate, applied to holes, fillets and patterns too), 0 SILENT_WRONG, every
    /// invariant holds, and nothing passes vacuously: every gated family scored references
    /// (an empty family's rate is NaN, which fails), no Phase C mutation was skipped, and each
    /// Phase C family meets its coverage minimums ([`coverage_problems`]).
    pub fn go(&self) -> bool {
        let spike = !self.spike_ran
            || (self.dimension >= 0.999
                && self.suppress >= 1.0
                && self.topology >= 0.99
                && self.rename_curve_exact >= 1.0
                && self.rename_feature_exact >= 1.0
                && self.parameter_exact >= 1.0);
        spike
            && self.boolean >= 0.9
            && self.hole >= 0.9
            && self.fillet >= 0.9
            && self.pattern >= 0.9
            && self.silent_wrong == 0
            && self.invariant_failures == 0
            && self.coverage_failures == 0
    }
}

/// Why a run's gates would pass vacuously or on too little evidence (must be empty for GO):
/// - a Phase C mutation skipped because its mutated document was rejected;
/// - a Phase C family (j)–(m) with fewer than [`super::ops::min_family_mutations`] accepted
///   mutations or [`super::ops::min_family_scored`] scored references;
/// - family (l) with fewer than [`super::ops::MIN_BLEND_SCORED`] scored references to blend
///   entities (fillet and chamfer faces and their edges);
/// - more than [`super::ops::MAX_DROPPED`] synthesized queries that did not resolve to their own
///   entity, or [`super::ops::MAX_BROAD`] picks over broad sources (both left unscored);
/// - when the spike families ran (`rep.models > 0`), a gated spike family (a)–(f) that scored
///   nothing;
/// - more than [`super::ops::MAX_UNREFERENCED`] base entities of the Phase C models without a
///   synthesized query (left unscored: growth would shrink the evidence silently).
pub fn coverage_problems(rep: &V1Report) -> Vec<String> {
    use super::ops::{
        MAX_BROAD, MAX_DROPPED, MAX_UNREFERENCED, MIN_BLEND_SCORED, is_blend_key,
        min_family_mutations, min_family_scored,
    };
    let mut out: Vec<String> = rep
        .ops
        .skipped
        .iter()
        .map(|s| format!("skipped Phase C mutation {s}"))
        .collect();
    let t = tallies(rep);
    let scored = |f: V1Family| t.get(&f).map_or(0, V1Tally::scored);
    for f in [
        V1Family::Boolean,
        V1Family::Hole,
        V1Family::Fillet,
        V1Family::Pattern,
    ] {
        let n = rep.mutations.get(&f).copied().unwrap_or(0);
        if n < min_family_mutations(f) {
            out.push(format!(
                "{}: {n} accepted mutations (minimum {})",
                f.as_str(),
                min_family_mutations(f)
            ));
        }
        if scored(f) < min_family_scored(f) {
            out.push(format!(
                "{}: {} scored references (minimum {})",
                f.as_str(),
                scored(f),
                min_family_scored(f)
            ));
        }
    }
    let blend = rep
        .refs
        .iter()
        .filter(|r| {
            r.family == V1Family::Fillet && r.outcome != Outcome::Excluded && is_blend_key(&r.key)
        })
        .count();
    if blend < MIN_BLEND_SCORED {
        out.push(format!(
            "{}: {blend} scored references to blend entities (minimum {MIN_BLEND_SCORED})",
            V1Family::Fillet.as_str()
        ));
    }
    if rep.ops.dropped > MAX_DROPPED {
        out.push(format!(
            "{} synthesized queries did not resolve to their own entity (maximum {MAX_DROPPED})",
            rep.ops.dropped
        ));
    }
    if rep.ops.broad > MAX_BROAD {
        out.push(format!(
            "{} synthesized queries pick over broad sources, not scored (maximum {MAX_BROAD})",
            rep.ops.broad
        ));
    }
    if rep.ops.unreferenced.len() > MAX_UNREFERENCED {
        out.push(format!(
            "{} base entities without a synthesized query (maximum {MAX_UNREFERENCED}): {}",
            rep.ops.unreferenced.len(),
            rep.ops.unreferenced.join("; ")
        ));
    }
    if rep.models > 0 {
        for f in [
            V1Family::Dimension,
            V1Family::Suppress,
            V1Family::Topology,
            V1Family::RenameCurve,
            V1Family::RenameFeature,
            V1Family::Parameter,
        ] {
            if scored(f) == 0 {
                out.push(format!("{}: no scored references", f.as_str()));
            }
        }
    }
    out
}

/// The criteria of a run.
pub fn criteria_v1(rep: &V1Report) -> V1Criteria {
    let t = tallies(rep);
    let get = |f: V1Family| t.get(&f).copied().unwrap_or_default();
    V1Criteria {
        spike_ran: rep.models > 0,
        coverage_failures: coverage_problems(rep).len(),
        dimension: get(V1Family::Dimension).correct_rate(),
        suppress: get(V1Family::Suppress).correct_rate(),
        topology: get(V1Family::Topology).correct_rate(),
        rename_curve_exact: get(V1Family::RenameCurve).exact_rate(),
        rename_feature_exact: get(V1Family::RenameFeature).exact_rate(),
        parameter_exact: get(V1Family::Parameter).exact_rate(),
        two_step: get(V1Family::TwoStep).correct_rate(),
        multi_member: get(V1Family::MultiMember).correct_rate(),
        pick: get(V1Family::Pick).correct_rate(),
        boolean: get(V1Family::Boolean).correct_rate(),
        hole: get(V1Family::Hole).correct_rate(),
        fillet: get(V1Family::Fillet).correct_rate(),
        pattern: get(V1Family::Pattern).correct_rate(),
        silent_wrong: t.values().map(|x| x.silent_wrong).sum(),
        invariant_failures: rep.identity_failures.len()
            + rep.key_problems.len()
            + rep.captures_with_index
            + rep.auto_accept_violations,
    }
}

fn pct(x: f64) -> String {
    if x.is_nan() {
        "n/a".into()
    } else {
        format!("{:.2} %", 100.0 * x)
    }
}

/// The v1 report as Markdown.
pub fn render_v1(rep: &V1Report) -> String {
    let mut out = String::new();
    let c = criteria_v1(rep);
    let _ = writeln!(out, "# Naming harness v1 report (forge-refs resolution)\n");
    let n_mut: usize = rep.mutations.values().sum();
    let _ = writeln!(
        out,
        "{} models, {} accepted mutations ({} rejected), {} references.\n",
        rep.models,
        n_mut,
        rep.skipped.len(),
        rep.refs.len()
    );
    let _ = writeln!(
        out,
        "**Verdict: {}**\n",
        if c.go() { "GO" } else { "NO-GO" }
    );
    let _ = writeln!(out, "| Criterion | Value | Gate |");
    let _ = writeln!(out, "|---|---:|---|");
    let _ = writeln!(
        out,
        "| (a) dimension correct | {} | ≥ 99.9 % |",
        pct(c.dimension)
    );
    let _ = writeln!(
        out,
        "| (b) suppress correct | {} | 100 % |",
        pct(c.suppress)
    );
    let _ = writeln!(
        out,
        "| (c) topology correct | {} | ≥ 99 % |",
        pct(c.topology)
    );
    let _ = writeln!(
        out,
        "| renameCurve exact | {} | 100 % |",
        pct(c.rename_curve_exact)
    );
    let _ = writeln!(
        out,
        "| feature rename exact | {} | 100 % |",
        pct(c.rename_feature_exact)
    );
    let _ = writeln!(
        out,
        "| parameter edit exact | {} | 100 % |",
        pct(c.parameter_exact)
    );
    for (label, v) in [
        ("(g) two edits, stale capture correct", c.two_step),
        ("(h) multi-member correct", c.multi_member),
        ("(i) picks over named sources correct", c.pick),
    ] {
        let _ = writeln!(out, "| {label} | {} | (no gate) |", pct(v));
    }
    for (label, v) in [
        ("(j) booleans correct", c.boolean),
        ("(k) holes correct", c.hole),
        ("(l) fillets correct", c.fillet),
        ("(m) patterns correct", c.pattern),
    ] {
        let _ = writeln!(out, "| {label} | {} | ≥ 90 % |", pct(v));
    }
    let _ = writeln!(
        out,
        "| SILENT_WRONG (all families) | {} | 0 |",
        c.silent_wrong
    );
    let _ = writeln!(
        out,
        "| invariants (identity {}, keys {}, `#` in captures {}, candidates ≥ 0.95 {}) | {} | 0 |",
        rep.identity_failures.len(),
        rep.key_problems.len(),
        rep.captures_with_index,
        rep.auto_accept_violations,
        c.invariant_failures
    );
    let blend_scored = rep
        .refs
        .iter()
        .filter(|r| {
            r.family == V1Family::Fillet
                && r.outcome != Outcome::Excluded
                && super::ops::is_blend_key(&r.key)
        })
        .count();
    let families = [
        V1Family::Boolean,
        V1Family::Hole,
        V1Family::Fillet,
        V1Family::Pattern,
    ];
    let _ = writeln!(
        out,
        "| coverage (no skipped Phase C mutation; (j)–(m) ≥ {} mutations and ≥ {} scored refs; (l) ≥ {} scored blend refs, now {blend_scored}; ≤ {} dropped and ≤ {} broad queries{}) | {} problems | 0 |\n",
        families
            .iter()
            .map(|f| super::ops::min_family_mutations(*f).to_string())
            .collect::<Vec<_>>()
            .join("/"),
        families
            .iter()
            .map(|f| super::ops::min_family_scored(*f).to_string())
            .collect::<Vec<_>>()
            .join("/"),
        super::ops::MIN_BLEND_SCORED,
        super::ops::MAX_DROPPED,
        super::ops::MAX_BROAD,
        if c.spike_ran {
            "; every gated spike family scored"
        } else {
            "; spike families not run"
        },
        c.coverage_failures
    );
    let problems = coverage_problems(rep);
    if !problems.is_empty() {
        let _ = writeln!(out, "Coverage problems:\n");
        for p in &problems {
            let _ = writeln!(out, "- {p}");
        }
        let _ = writeln!(out);
    }
    if rep.ops.models > 0 {
        let _ = writeln!(
            out,
            "Phase C families (j)–(m): {} IR v1 models; references are `tag` features resolved by forge-regen; family (l) covers blend entities through {} authored references (fillet and chamfer faces and their edges, scored); not scored: {} entities without a query (maximum {}, listed below), {} queries that did not resolve to their own entity (maximum {}), {} picks over broad sources (family (i) semantics; maximum {}); {} references rejected statically by a mutated document{}.\n",
            rep.ops.models,
            rep.ops.blend,
            rep.ops.unreferenced.len(),
            super::ops::MAX_UNREFERENCED,
            rep.ops.dropped,
            super::ops::MAX_DROPPED,
            rep.ops.broad,
            super::ops::MAX_BROAD,
            rep.ops.rejected,
            if rep.ops.skipped.is_empty() {
                String::new()
            } else {
                format!("; skipped mutations: {}", rep.ops.skipped.join("; "))
            }
        );
        if !rep.ops.unreferenced.is_empty() {
            let _ = writeln!(out, "Entities without a synthesized query (not scored):\n");
            for k in &rep.ops.unreferenced {
                let _ = writeln!(out, "- `{k}`");
            }
            let _ = writeln!(out);
        }
    }
    let _ = writeln!(
        out,
        "| Family | Mutations | Refs | CORRECT | FLAGGED_CORRECTLY | WRONG_BUT_FLAGGED | SILENT_WRONG | Excluded | Correct | Exact |"
    );
    let _ = writeln!(out, "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (f, t) in tallies(rep) {
        let _ = writeln!(
            out,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            f.as_str(),
            rep.mutations.get(&f).copied().unwrap_or(0),
            t.total,
            t.correct,
            t.flagged_correctly,
            t.wrong_but_flagged,
            t.silent_wrong,
            t.excluded,
            pct(t.correct_rate()),
            pct(t.exact_rate())
        );
    }
    let mut codes: BTreeMap<(V1Family, String), usize> = BTreeMap::new();
    for r in &rep.refs {
        let k = r
            .code
            .clone()
            .unwrap_or_else(|| format!("{:?}", r.status).to_lowercase());
        *codes.entry((r.family, k)).or_default() += 1;
    }
    let _ = writeln!(
        out,
        "\n## Outcomes by code\n\n| Family | Status / code | Refs |\n|---|---|---:|"
    );
    for ((f, k), n) in codes {
        let _ = writeln!(out, "| {} | {k} | {n} |", f.as_str());
    }
    let bad: Vec<&V1Record> = rep
        .refs
        .iter()
        .filter(|r| matches!(r.outcome, Outcome::SilentWrong | Outcome::WrongButFlagged))
        .collect();
    if !bad.is_empty() {
        let _ = writeln!(out, "\n## Wrong or silent-wrong references (first 60)\n");
        for r in bad.iter().take(60) {
            let _ = writeln!(
                out,
                "- {} `{}` {}: {} — expected {}; got {}",
                r.outcome.as_str(),
                r.model,
                r.mutation,
                r.key,
                r.expected,
                r.resolution
            );
        }
    }
    for (title, list) in [
        ("Identity failures", &rep.identity_failures),
        ("Key problems", &rep.key_problems),
    ] {
        if !list.is_empty() {
            let _ = writeln!(out, "\n## {title}\n");
            for x in list.iter().take(40) {
                let _ = writeln!(out, "- {x}");
            }
        }
    }
    out
}
