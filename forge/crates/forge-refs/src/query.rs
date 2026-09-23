//! The query evaluator (SPEC-v1 §5.3): the 23 operations over a [`Scope`], with per-member
//! **named/broad** tracking and alias lookup, and the result in canonical order (§5.4).
//!
//! | Group | Operations |
//! |---|---|
//! | named sources | `body`, `cap`, `endcap`, `side`, `edge_at`, `between` (if both sides are named), `hole_face`, `tagged` (as the tag's query) |
//! | broad sources | `bodies`, `sides`, `created`, `instance` |
//! | navigation (broad) | `faces`, `edges`, `vertices`, `owner` |
//! | set algebra (named-ness per member) | `union`, `intersect`, `minus` |
//! | filters and picks (named-ness per member) | `filter` (8 predicates), `extreme`, `largest`, `smallest` |
//!
//! A source naming a feature id (named or broad: `sides`, `created`, `instance` too) whose
//! feature **failed** fails the evaluation with `DEPENDENCY_FAILED` (§7.5: "any feature
//! referenced by id or named in a query failed"); one whose feature is **suppressed** yields
//! nothing and records the feature (reason `feature-suppressed`, §5.7 step 1). Every query is
//! type-checked first ([`crate::typing`]), so an unvalidated query is rejected with its static
//! code instead of being evaluated. Error paths are JSON pointers relative to the query
//! ([`crate::resolve_with`] reports them relative to the feature).
//!
//! `tagged` resolves the tag's reference (with the tag's capture) in the current scope: its
//! warnings and non-exact member statuses are passed up in the [`QuerySet`], and its failure
//! is passed through as [`RefError::TagFailed`] (the tag's code and unresolved candidates).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::Vec3;
use forge_core::math;
use forge_core::topo::{EdgeId, KeyRoleArg, parse_key};
use forge_ir::v1::metrics::{MemberStatus, Warning};
use forge_ir::v1::{
    End, EntityKind, GeomTypeName, HolePart, LINEAR_TOLERANCE, Predicate, QUERY_ANGLE_TOLERANCE,
    QUERY_SIZE_TIE_REL, Query, Via, Which,
};

use crate::error::RefError;
use crate::frames::direction;
use crate::geom::axis_angle;
use crate::keys::EntityId;
use crate::scope::{Entity, Scope};
use crate::table::FeatureStatus;
use crate::typing::static_kind;

/// One member of a query result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    /// The entity.
    pub entity: Entity,
    /// `named` (designated by identity) or `broad` (§5.3).
    pub via: Via,
    /// The alias key it was found through (merged faces, §5.2 rule 3), if any.
    pub alias: Option<String>,
}

/// A query result, in canonical order (§5.4).
#[derive(Clone, Debug, PartialEq)]
pub struct QuerySet {
    /// The static kind.
    pub kind: EntityKind,
    /// The members.
    pub members: Vec<Member>,
    /// Features of sources that were suppressed (they yielded nothing).
    pub suppressed: BTreeSet<String>,
    /// Warnings and infos of the resolutions of `tagged` sources (§6.12), in evaluation
    /// order: a tag repaired or re-bound in this scope is reported with the reference.
    pub warnings: Vec<Warning>,
    /// Non-exact statuses of members that came from `tagged` sources (e.g. `repaired`).
    pub statuses: BTreeMap<Entity, MemberStatus>,
}

impl QuerySet {
    /// The entities, in canonical order.
    pub fn entities(&self) -> Vec<Entity> {
        self.members.iter().map(|m| m.entity).collect()
    }
}

#[derive(Clone, Debug, Default)]
struct Info {
    named: bool,
    alias: Option<String>,
}

type Set = BTreeMap<Entity, Info>;

/// Evaluate a query in a scope (see the module docs).
pub fn eval_query(q: &Query, scope: &Scope<'_>) -> Result<QuerySet, RefError> {
    let kind = static_kind(q, scope.table()).map_err(|e| {
        e.into_iter()
            .next()
            .map_or_else(|| internal_invalid(q), RefError::from)
    })?;
    let mut ev = Eval {
        scope,
        suppressed: BTreeSet::new(),
        warnings: Vec::new(),
        statuses: BTreeMap::new(),
    };
    let set = ev.eval(q, "")?;
    let order = scope.canonical(set.keys().copied().collect());
    let members = order
        .into_iter()
        .map(|e| {
            let i = &set[&e];
            Member {
                entity: e,
                via: if i.named { Via::Named } else { Via::Broad },
                alias: i.alias.clone(),
            }
        })
        .collect();
    let statuses = ev
        .statuses
        .into_iter()
        .filter(|(e, _)| set.contains_key(e))
        .collect();
    Ok(QuerySet {
        kind,
        members,
        suppressed: ev.suppressed,
        warnings: ev.warnings,
        statuses,
    })
}

/// The first `tagged` source of `q` (depth first, operands in order) naming a tag that is not
/// earlier than timeline index `at` in `table` (or not in it), with its JSON pointer under
/// `path`.
fn later_tag(
    q: &Query,
    table: &crate::table::FeatureTable,
    at: usize,
    path: &str,
) -> Option<(String, String)> {
    let sub = |x: &Query, p: &str| later_tag(x, table, at, &format!("{path}{p}"));
    match q {
        Query::Tagged { feature } => table
            .index(feature)
            .is_none_or(|i| i >= at)
            .then(|| (feature.clone(), format!("{path}/feature"))),
        Query::Between { a, b } | Query::Minus { a, b } => sub(a, "/a").or_else(|| sub(b, "/b")),
        Query::Faces { of }
        | Query::Edges { of }
        | Query::Vertices { of }
        | Query::Owner { of }
        | Query::Filter { of, .. }
        | Query::Extreme { of, .. }
        | Query::Largest { of }
        | Query::Smallest { of } => sub(of, "/of"),
        Query::Union { of } | Query::Intersect { of } => of
            .iter()
            .enumerate()
            .find_map(|(i, x)| sub(x, &format!("/of/{i}"))),
        Query::Body { .. }
        | Query::Bodies {}
        | Query::Cap { .. }
        | Query::Endcap { .. }
        | Query::Side { .. }
        | Query::Sides { .. }
        | Query::EdgeAt { .. }
        | Query::HoleFace { .. }
        | Query::Created { .. }
        | Query::Instance { .. } => None,
    }
}

/// A query the static checker returned no kind for without saying why (defence in depth: it
/// always records an error).
fn internal_invalid(q: &Query) -> RefError {
    RefError::QueryInvalid {
        path: String::new(),
        expected: "a statically typed query".into(),
        found: q.op().to_string(),
    }
}

struct Eval<'s, 'a> {
    scope: &'s Scope<'a>,
    suppressed: BTreeSet<String>,
    warnings: Vec<Warning>,
    statuses: BTreeMap<Entity, MemberStatus>,
}

fn end_str(e: End) -> &'static str {
    match e {
        End::Start => "start",
        End::End => "end",
    }
}

fn hole_part(p: HolePart) -> &'static str {
    match p {
        HolePart::Wall => "wall",
        HolePart::Tip => "tip",
        HolePart::Floor => "floor",
        HolePart::CboreWall => "cbore_wall",
        HolePart::CboreFloor => "cbore_floor",
        HolePart::Csink => "csink",
    }
}

impl Eval<'_, '_> {
    /// Status gate of a source naming a feature id: `Ok(true)` evaluate, `Ok(false)`
    /// suppressed (yields nothing), `Err` failed.
    fn gate(&mut self, feature: &str, path: &str) -> Result<bool, RefError> {
        match self.scope.table().get(feature).map(|f| &f.status) {
            None => Err(RefError::UnresolvedFeature {
                id: feature.to_string(),
                field: format!("{path}/feature"),
                expected: "an earlier feature of this part".into(),
            }),
            Some(FeatureStatus::Ok) => Ok(true),
            Some(FeatureStatus::Suppressed) => {
                self.suppressed.insert(feature.to_string());
                Ok(false)
            }
            Some(FeatureStatus::Failed { code, message }) => Err(RefError::DependencyFailed {
                feature: feature.to_string(),
                code: code.clone(),
                message: message.clone(),
            }),
        }
    }

    /// Entities of `kind` whose key satisfies `pred`, plus those designated through an alias
    /// whose key satisfies it; all named.
    fn named_by(&self, kind: EntityKind, pred: impl Fn(&str) -> bool) -> Set {
        let mut out = Set::new();
        for (k, ents) in &self.scope.by_key {
            if pred(k) {
                for e in ents.iter().filter(|e| e.kind() == kind) {
                    out.insert(
                        *e,
                        Info {
                            named: true,
                            alias: None,
                        },
                    );
                }
            }
        }
        for (alias, target) in &self.scope.aliases {
            if pred(alias) {
                for e in self
                    .scope
                    .with_key(target)
                    .iter()
                    .filter(|e| e.kind() == kind)
                {
                    out.entry(*e).or_insert(Info {
                        named: true,
                        alias: Some(alias.clone()),
                    });
                }
            }
        }
        out
    }

    /// The body members (region members) of a sweep's bodies whose outer loop contains
    /// `curve`; the curve itself when the evaluator gave no region data.
    fn members_with(&self, feature: &str, curve: &str) -> BTreeSet<String> {
        let regions = self
            .scope
            .table()
            .get(feature)
            .map(|f| f.regions.clone())
            .unwrap_or_default();
        if regions.is_empty() {
            return BTreeSet::from([curve.to_string()]);
        }
        regions
            .iter()
            .filter(|r| r.outer_curves.iter().any(|c| c == curve))
            .filter_map(|r| r.member().map(str::to_string))
            .collect()
    }

    fn cap_like(
        &mut self,
        label: &str,
        feature: &str,
        end: End,
        member: &Option<String>,
        path: &str,
    ) -> Result<Set, RefError> {
        if !self.gate(feature, path)? {
            return Ok(Set::new());
        }
        let members = member.as_ref().map(|m| self.members_with(feature, m));
        let (feature, end) = (feature.to_string(), end_str(end));
        Ok(self.named_by(EntityKind::Face, |k| {
            let Ok(p) = parse_key(k) else { return false };
            p.feature == feature
                && p.label == label
                && p.arg == KeyRoleArg::Leaf(end.to_string())
                && members
                    .as_ref()
                    .is_none_or(|ms| p.qualifier.as_ref().is_some_and(|q| ms.contains(q)))
        }))
    }

    fn eval(&mut self, q: &Query, path: &str) -> Result<Set, RefError> {
        let scope = self.scope;
        Ok(match q {
            Query::Body { feature, member } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                let members = member.as_ref().map(|m| self.members_with(feature, m));
                let mut out = Set::new();
                for b in 0..scope.body_count() {
                    let o = scope.origin(b);
                    if o.feature == *feature
                        && members.as_ref().is_none_or(|ms| ms.contains(&o.member))
                    {
                        out.insert(
                            Scope::body_entity(b),
                            Info {
                                named: true,
                                alias: None,
                            },
                        );
                    }
                }
                out
            }
            Query::Bodies {} => (0..scope.body_count())
                .map(|b| (Scope::body_entity(b), Info::default()))
                .collect(),
            Query::Cap {
                feature,
                end,
                member,
            } => self.cap_like("cap", feature, *end, member, path)?,
            Query::Endcap {
                feature,
                end,
                member,
            } => self.cap_like("endcap", feature, *end, member, path)?,
            Query::Side { feature, curve } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                self.named_by(EntityKind::Face, |k| {
                    parse_key(k).is_ok_and(|p| {
                        p.feature == *feature
                            && p.label == "side"
                            && p.arg == KeyRoleArg::Leaf(curve.clone())
                            && p.qualifier.is_none()
                    })
                })
            }
            Query::Sides { feature, member } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                let members = member.as_ref().map(|m| self.members_with(feature, m));
                let regions = scope
                    .table()
                    .get(feature)
                    .map(|f| f.regions.clone())
                    .unwrap_or_default();
                let mut out = Set::new();
                for e in scope.entities(EntityKind::Face) {
                    let Ok(p) = parse_key(scope.key(e)) else {
                        continue;
                    };
                    if p.feature != *feature || p.label != "side" {
                        continue;
                    }
                    if let Some(ms) = &members
                        && !side_of_member(scope, e, &p.arg, feature, &regions, ms)
                    {
                        continue;
                    }
                    out.insert(e, Info::default());
                }
                out
            }
            Query::EdgeAt {
                feature,
                curve,
                end,
            } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                // The junction at `curve.end` and its qualifier (the smallest end there).
                let want = (curve.as_str(), end_str(*end));
                let quals: BTreeSet<String> = scope
                    .table()
                    .get(feature)
                    .map(|f| f.regions.clone())
                    .unwrap_or_default()
                    .iter()
                    .flat_map(|r| r.junctions.iter())
                    .filter(|j| j.ends().contains(&want))
                    .filter_map(|j| j.qualifier())
                    .collect();
                let fid = feature.clone();
                self.named_by(EntityKind::Edge, |k| {
                    let Ok(p) = parse_key(k) else { return false };
                    let sides = match &p.arg {
                        KeyRoleArg::Keys(ks) => ks.iter().all(|x| {
                            parse_key(x).is_ok_and(|s| s.feature == fid && s.label == "side")
                        }),
                        _ => false,
                    };
                    p.feature == fid
                        && p.label == "edge"
                        && sides
                        && p.qualifier.as_ref().is_some_and(|q| quals.contains(q))
                })
            }
            Query::Between { a, b } => {
                let sa = self.eval(a, &format!("{path}/a"))?;
                let sb = self.eval(b, &format!("{path}/b"))?;
                let mut out = Set::new();
                for (fa, ia) in &sa {
                    let EntityId::Face(f) = fa.id else { continue };
                    let body = scope.body(*fa);
                    for e in body.face_edges(f) {
                        for g in body.edge_faces(e) {
                            if g == f {
                                continue;
                            }
                            let other = Entity {
                                body: fa.body,
                                id: EntityId::Face(g),
                            };
                            if let Some(ib) = sb.get(&other) {
                                let ent = Entity {
                                    body: fa.body,
                                    id: EntityId::Edge(e),
                                };
                                let named = ia.named && ib.named;
                                let slot = out.entry(ent).or_insert(Info { named, alias: None });
                                slot.named |= named;
                            }
                        }
                    }
                }
                out
            }
            Query::HoleFace { feature, at, part } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                let label = hole_part(*part);
                self.named_by(EntityKind::Face, |k| {
                    parse_key(k).is_ok_and(|p| {
                        p.feature == *feature
                            && p.label == label
                            && p.arg == KeyRoleArg::None
                            && p.qualifier.as_deref() == Some(at.as_str())
                    })
                })
            }
            Query::Created { feature, role } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                let mut out = Set::new();
                for e in scope.entities(EntityKind::Face) {
                    if parse_key(scope.key(e)).is_ok_and(|p| {
                        p.feature == *feature && role.as_ref().is_none_or(|r| p.label == *r)
                    }) {
                        out.insert(e, Info::default());
                    }
                }
                out
            }
            Query::Instance { feature, index } => {
                if !self.gate(feature, path)? {
                    return Ok(Set::new());
                }
                let want: Vec<String> = index.iter().map(u32::to_string).collect();
                let want = want.join(".");
                let mut out = Set::new();
                for e in scope.entities(EntityKind::Face) {
                    if parse_key(scope.key(e)).is_ok_and(|p| {
                        p.feature == *feature && p.qualifier.as_deref() == Some(want.as_str())
                    }) {
                        out.insert(e, Info::default());
                    }
                }
                out
            }
            Query::Tagged { feature } => {
                let info =
                    scope
                        .table()
                        .get(feature)
                        .ok_or_else(|| RefError::UnresolvedFeature {
                            id: feature.clone(),
                            field: format!("{path}/feature"),
                            expected: "tag".into(),
                        })?;
                match &info.status {
                    FeatureStatus::Ok => {}
                    FeatureStatus::Suppressed => {
                        return Err(RefError::DependencySuppressed {
                            feature: feature.clone(),
                        });
                    }
                    FeatureStatus::Failed { code, message } => {
                        return Err(RefError::DependencyFailed {
                            feature: feature.clone(),
                            code: code.clone(),
                            message: message.clone(),
                        });
                    }
                }
                let target = info
                    .tag
                    .clone()
                    .ok_or_else(|| RefError::UnresolvedFeature {
                        id: feature.clone(),
                        field: format!("{path}/feature"),
                        expected: "tag".into(),
                    })?;
                // A tag's own query may only name tags earlier than the tag (§6.12: it
                // resolves at its own position). Checked on the target itself, whatever the
                // evaluation context, so every nested `tagged` names a strictly earlier tag and
                // resolution always terminates (a cycle t1 → t2 → t1 of tags that are both
                // before the consumer would otherwise recurse without end).
                if let Some(at) = scope.table().index(feature)
                    && let Some((bad, bad_path)) = later_tag(&target.q, scope.table(), at, "/q")
                {
                    let mut details = serde_json::Map::new();
                    details.insert("id".into(), bad.clone().into());
                    details.insert("field".into(), format!("/target{bad_path}").into());
                    details.insert("expected".into(), "tag".into());
                    return Err(RefError::TagFailed {
                        feature: feature.clone(),
                        code: "UNRESOLVED_FEATURE".into(),
                        message: format!(
                            "tag {feature:?} names tag {bad:?}, which is not an earlier feature"
                        ),
                        details,
                        unresolved: Vec::new(),
                    });
                }
                // The tag's query, with the tag's capture, in this scope (§6.12).
                let res = crate::resolve::resolve_with(
                    &target,
                    scope,
                    &crate::resolve::FieldSpec {
                        field: format!("{path}/feature"),
                        card: crate::typing::RefField::ANY_SOME.card,
                    },
                );
                if let Some(err) = &res.error {
                    // The tag's own outcome (its code, unresolved members and candidates),
                    // not a failure of the tag feature.
                    return Err(RefError::TagFailed {
                        feature: feature.clone(),
                        code: err.code.clone(),
                        message: err.message.clone(),
                        details: err.details.clone(),
                        unresolved: res.report.unresolved.clone(),
                    });
                }
                self.warnings.extend(res.warnings.iter().cloned());
                for m in &res.members {
                    if m.status != MemberStatus::Exact {
                        self.statuses.entry(m.entity).or_insert(m.status);
                    }
                }
                res.members
                    .iter()
                    .map(|m| {
                        (
                            m.entity,
                            Info {
                                named: m.via == Via::Named,
                                alias: None,
                            },
                        )
                    })
                    .collect()
            }
            Query::Faces { of } => {
                let s = self.eval(of, &format!("{path}/of"))?;
                let mut out = Set::new();
                for e in s.keys() {
                    for f in faces_of(scope, *e) {
                        out.insert(f, Info::default());
                    }
                }
                out
            }
            Query::Edges { of } => {
                let s = self.eval(of, &format!("{path}/of"))?;
                let mut out = Set::new();
                for e in s.keys() {
                    for x in edges_of(scope, *e) {
                        out.insert(x, Info::default());
                    }
                }
                out
            }
            Query::Vertices { of } => {
                let s = self.eval(of, &format!("{path}/of"))?;
                let mut out = Set::new();
                for e in s.keys() {
                    for x in vertices_of(scope, *e) {
                        out.insert(x, Info::default());
                    }
                }
                out
            }
            Query::Owner { of } => {
                let s = self.eval(of, &format!("{path}/of"))?;
                s.keys()
                    .map(|e| (Scope::body_entity(e.body), Info::default()))
                    .collect()
            }
            Query::Union { of } => {
                let mut out = Set::new();
                for (i, sub) in of.iter().enumerate() {
                    for (e, info) in self.eval(sub, &format!("{path}/of/{i}"))? {
                        merge(&mut out, e, info);
                    }
                }
                out
            }
            Query::Intersect { of } => {
                let mut sets = Vec::with_capacity(of.len());
                for (i, sub) in of.iter().enumerate() {
                    sets.push(self.eval(sub, &format!("{path}/of/{i}"))?);
                }
                let mut out = Set::new();
                if let Some((first, rest)) = sets.split_first() {
                    for (e, info) in first {
                        if rest.iter().all(|s| s.contains_key(e)) {
                            let mut info = info.clone();
                            for s in rest {
                                let o = &s[e];
                                info.named |= o.named;
                                if info.alias.is_none() {
                                    info.alias = o.alias.clone();
                                }
                            }
                            out.insert(*e, info);
                        }
                    }
                }
                out
            }
            Query::Minus { a, b } => {
                let sa = self.eval(a, &format!("{path}/a"))?;
                let sb = self.eval(b, &format!("{path}/b"))?;
                sa.into_iter()
                    .filter(|(e, _)| !sb.contains_key(e))
                    .collect()
            }
            Query::Filter { of, pred } => {
                let s = self.eval(of, &format!("{path}/of"))?;
                let mut out = Set::new();
                for (e, info) in s {
                    if predicate(scope, e, pred, &format!("{path}/where"))? {
                        out.insert(e, info);
                    }
                }
                out
            }
            Query::Extreme { of, dir, which } => {
                let d = direction(dir, scope, &format!("{path}/dir"))?;
                let s = self.eval(of, &format!("{path}/of"))?;
                let mut vals = Vec::with_capacity(s.len());
                for e in s.keys() {
                    let c = Vec3::from(scope.props(*e)?.centroid);
                    vals.push((*e, c.dot(d)));
                }
                let best = match which {
                    Which::Max => vals.iter().map(|x| x.1).fold(f64::NEG_INFINITY, f64::max),
                    Which::Min => vals.iter().map(|x| x.1).fold(f64::INFINITY, f64::min),
                };
                let tol = LINEAR_TOLERANCE * scope.scale();
                s.into_iter()
                    .filter(|(e, _)| vals.iter().any(|(x, v)| x == e && (v - best).abs() <= tol))
                    .collect()
            }
            Query::Largest { of } | Query::Smallest { of } => {
                let largest = matches!(q, Query::Largest { .. });
                let s = self.eval(of, &format!("{path}/of"))?;
                let mut sizes = BTreeMap::new();
                for e in s.keys() {
                    sizes.insert(*e, scope.props(*e)?.size);
                }
                let best = if largest {
                    sizes.values().copied().fold(f64::NEG_INFINITY, f64::max)
                } else {
                    sizes.values().copied().fold(f64::INFINITY, f64::min)
                };
                s.into_iter()
                    .filter(|(e, _)| {
                        let v = sizes[e];
                        (v - best).abs() <= QUERY_SIZE_TIE_REL * v.abs().max(best.abs())
                    })
                    .collect()
            }
        })
    }
}

/// Whether the side face `e` (key arg `arg`) of sweep `feature` belongs to a body member in
/// `ms` (`sides { feature, member }`): its curve bounds a region with that member (outer or
/// inner loop). The body's origin is not used when region data exists: after a join the body
/// inherits the target's origin (§6.0.3) while the faces keep their side keys. A curve shared
/// by regions of other members too (a line between two regions) is decided by the body's
/// origin when the body is the sweep's own; otherwise it is left out. Without region data
/// (an evaluator that recorded none), the body's origin decides.
fn side_of_member(
    scope: &Scope<'_>,
    e: Entity,
    arg: &KeyRoleArg,
    feature: &str,
    regions: &[crate::table::SweepRegion],
    ms: &BTreeSet<String>,
) -> bool {
    let o = scope.origin(e.body);
    let by_origin = o.feature == feature && ms.contains(&o.member);
    if regions.is_empty() {
        return by_origin;
    }
    let KeyRoleArg::Leaf(curve) = arg else {
        return false;
    };
    let owners: Vec<&str> = regions
        .iter()
        .filter(|r| r.has_curve(curve))
        .filter_map(|r| r.member())
        .collect();
    let mine = owners.iter().filter(|m| ms.contains(**m)).count();
    if mine == 0 {
        false
    } else if mine == owners.len() {
        true
    } else {
        by_origin
    }
}

fn merge(out: &mut Set, e: Entity, info: Info) {
    let slot = out.entry(e).or_default();
    slot.named |= info.named;
    if slot.alias.is_none() {
        slot.alias = info.alias;
    }
}

// ---- navigation --------------------------------------------------------------------------------

fn ent(body: usize, id: EntityId) -> Entity {
    Entity { body, id }
}

/// B → faces; E → the two adjacent faces; V → incident faces.
pub(crate) fn faces_of(scope: &Scope<'_>, e: Entity) -> Vec<Entity> {
    let body = scope.body(e);
    match e.id {
        EntityId::Body => body
            .faces()
            .iter()
            .map(|(f, _)| ent(e.body, EntityId::Face(f)))
            .collect(),
        EntityId::Edge(x) => body
            .edge_faces(x)
            .into_iter()
            .map(|f| ent(e.body, EntityId::Face(f)))
            .collect(),
        EntityId::Vertex(_) => {
            let mut out: Vec<Entity> = Vec::new();
            for x in edges_of(scope, e) {
                for f in faces_of(scope, x) {
                    if !out.contains(&f) {
                        out.push(f);
                    }
                }
            }
            out
        }
        EntityId::Face(_) => Vec::new(),
    }
}

/// B → edges; F → boundary edges; V → incident edges.
pub(crate) fn edges_of(scope: &Scope<'_>, e: Entity) -> Vec<Entity> {
    let body = scope.body(e);
    match e.id {
        EntityId::Body => body
            .edges()
            .iter()
            .map(|(x, _)| ent(e.body, EntityId::Edge(x)))
            .collect(),
        EntityId::Face(f) => body
            .face_edges(f)
            .into_iter()
            .map(|x| ent(e.body, EntityId::Edge(x)))
            .collect(),
        EntityId::Vertex(v) => scope.bodies[e.body]
            .vertex_edges
            .get(&v)
            .into_iter()
            .flatten()
            .map(|x| ent(e.body, EntityId::Edge(*x)))
            .collect(),
        EntityId::Edge(_) => Vec::new(),
    }
}

/// B, F, E → vertices.
pub(crate) fn vertices_of(scope: &Scope<'_>, e: Entity) -> Vec<Entity> {
    let body = scope.body(e);
    let of_edge = |x: EdgeId| -> Vec<Entity> {
        body.edge(x)
            .map(|ed| {
                [ed.start, ed.end]
                    .into_iter()
                    .flatten()
                    .map(|v| ent(e.body, EntityId::Vertex(v)))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut out: Vec<Entity> = Vec::new();
    let mut push = |v: Entity| {
        if !out.contains(&v) {
            out.push(v);
        }
    };
    match e.id {
        EntityId::Body => {
            for (v, _) in body.vertices().iter() {
                push(ent(e.body, EntityId::Vertex(v)));
            }
        }
        EntityId::Face(f) => {
            for x in body.face_edges(f) {
                for v in of_edge(x) {
                    push(v);
                }
            }
        }
        EntityId::Edge(x) => {
            for v in of_edge(x) {
                push(v);
            }
        }
        EntityId::Vertex(_) => {}
    }
    out
}

// ---- predicates --------------------------------------------------------------------------------

/// Outward unit normal of a face at the surface point closest to `p`.
pub(crate) fn outward_normal_at(scope: &Scope<'_>, f: Entity, p: Vec3) -> Option<Vec3> {
    let EntityId::Face(fid) = f.id else {
        return None;
    };
    let face = scope.body(f).face(fid)?;
    let (u, v, _) = face.surface.project(p);
    let n = face.surface.normal(u, v)?;
    Some(if face.sense { n } else { -n })
}

/// The material angle class of an edge at its parametric midpoint: `(θ, sign)` where `θ` is
/// the angle between the two outward normals and `sign > 0` for convex.
pub(crate) fn dihedral(scope: &Scope<'_>, e: Entity) -> Option<(f64, f64)> {
    let EntityId::Edge(x) = e.id else { return None };
    let body = scope.body(e);
    let edge = body.edge(x)?;
    let faces = body.edge_faces(x);
    let [f1, f2] = faces.as_slice() else {
        return None;
    };
    let t = 0.5 * (edge.t_range.0 + edge.t_range.1);
    let p = edge.curve.eval(t);
    let tangent = edge.curve.d1(t).normalize()?;
    // The tangent in the direction of f1's coedge (f1 on its left seen from outside).
    let forward = edge.coedges.iter().find_map(|c| {
        let co = body.coedge(*c)?;
        let lp = body.loop_(co.loop_id)?;
        (lp.face == *f1).then_some(co.forward)
    })?;
    let t1 = if forward { tangent } else { -tangent };
    let n1 = outward_normal_at(scope, ent(e.body, EntityId::Face(*f1)), p)?;
    let n2 = outward_normal_at(scope, ent(e.body, EntityId::Face(*f2)), p)?;
    let c = n1.cross(n2);
    let theta = math::atan2(c.norm(), n1.dot(n2));
    Some((theta, c.dot(t1)))
}

fn type_of(scope: &Scope<'_>, e: Entity) -> Option<GeomTypeName> {
    let body = scope.body(e);
    match e.id {
        EntityId::Face(f) => Some(match body.face(f)?.surface {
            Surface::Plane(_) => GeomTypeName::Plane,
            Surface::Cylinder(_) => GeomTypeName::Cylinder,
            Surface::Cone(_) => GeomTypeName::Cone,
            Surface::Sphere(_) => GeomTypeName::Sphere,
            Surface::Torus(_) => GeomTypeName::Torus,
            Surface::BSpline(_) => GeomTypeName::Bspline,
        }),
        EntityId::Edge(x) => Some(match body.edge(x)?.curve {
            Curve3::Line(_) => GeomTypeName::Line,
            Curve3::Circle(_) => GeomTypeName::Circle,
            Curve3::Ellipse(_) => GeomTypeName::Ellipse,
            Curve3::BSpline(_) => GeomTypeName::Bspline,
        }),
        _ => None,
    }
}

fn face_of<'a>(scope: &Scope<'a>, e: Entity) -> Option<(&'a Surface, bool)> {
    let EntityId::Face(f) = e.id else { return None };
    scope.body(e).face(f).map(|x| (&x.surface, x.sense))
}

fn edge_curve<'a>(scope: &Scope<'a>, e: Entity) -> Option<&'a Curve3> {
    let EntityId::Edge(x) = e.id else { return None };
    scope.body(e).edge(x).map(|x| &x.curve)
}

fn angle(a: Vec3, b: Vec3) -> f64 {
    math::atan2(a.cross(b).norm(), a.dot(b))
}

/// Whether an entity satisfies a predicate (§5.3; angles within `QUERY_ANGLE_TOLERANCE`).
pub(crate) fn predicate(
    scope: &Scope<'_>,
    e: Entity,
    p: &Predicate,
    path: &str,
) -> Result<bool, RefError> {
    let tol = QUERY_ANGLE_TOLERANCE;
    let right = math::FRAC_PI_2 - tol;
    Ok(match p {
        Predicate::Type(t) => type_of(scope, e) == Some(*t),
        Predicate::Normal(d) => {
            let d = direction(d, scope, &format!("{path}/normal"))?;
            match face_of(scope, e) {
                Some((Surface::Plane(pl), sense)) => {
                    let n = if sense {
                        pl.frame().z()
                    } else {
                        -pl.frame().z()
                    };
                    angle(n, d) <= tol
                }
                _ => false,
            }
        }
        Predicate::Parallel(d) => {
            let d = direction(d, scope, &format!("{path}/parallel"))?;
            match (face_of(scope, e), edge_curve(scope, e)) {
                (Some((Surface::Plane(pl), _)), _) => axis_angle(pl.frame().z(), d) >= right,
                (Some((Surface::Cylinder(c), _)), _) => axis_angle(c.frame().z(), d) <= tol,
                (Some((Surface::Cone(c), _)), _) => axis_angle(c.frame().z(), d) <= tol,
                (_, Some(Curve3::Line(l))) => axis_angle(l.dir(), d) <= tol,
                _ => false,
            }
        }
        Predicate::Perpendicular(d) => {
            let d = direction(d, scope, &format!("{path}/perpendicular"))?;
            match (face_of(scope, e), edge_curve(scope, e)) {
                (Some((Surface::Plane(pl), _)), _) => axis_angle(pl.frame().z(), d) <= tol,
                (_, Some(Curve3::Line(l))) => axis_angle(l.dir(), d) >= right,
                (_, Some(Curve3::Circle(c))) => axis_angle(c.frame().z(), d) <= tol,
                _ => false,
            }
        }
        Predicate::Convex(_) => dihedral(scope, e).is_some_and(|(th, s)| th > tol && s > 0.0),
        Predicate::Concave(_) => dihedral(scope, e).is_some_and(|(th, s)| th > tol && s < 0.0),
        Predicate::Smooth(_) => dihedral(scope, e).is_some_and(|(th, _)| th <= tol),
        Predicate::Radius(b) => {
            let r = match (face_of(scope, e), edge_curve(scope, e)) {
                (Some((Surface::Cylinder(c), _)), _) => Some(c.radius()),
                (Some((Surface::Sphere(s), _)), _) => Some(s.radius()),
                (Some((Surface::Torus(t), _)), _) => Some(t.minor()),
                (_, Some(Curve3::Circle(c))) => Some(c.radius()),
                _ => None,
            };
            let Some(r) = r else { return Ok(false) };
            let bound =
                |s: &Option<forge_ir::v1::Scalar>, name: &str| -> Result<Option<f64>, RefError> {
                    s.as_ref()
                        .map(|v| {
                            let x = scope.scalar(v, &format!("{path}/radius/{name}"))?;
                            if x < 0.0 {
                                return Err(RefError::InvalidValue {
                                    field: format!("{path}/radius/{name}"),
                                    value: serde_json::json!(x),
                                    expected: ">= 0".into(),
                                });
                            }
                            Ok(x)
                        })
                        .transpose()
                };
            match (
                bound(&b.eq, "eq")?,
                bound(&b.min, "min")?,
                bound(&b.max, "max")?,
            ) {
                (Some(eq), _, _) => (r - eq).abs() <= LINEAR_TOLERANCE,
                (None, lo, hi) => lo.is_none_or(|lo| r >= lo) && hi.is_none_or(|hi| r <= hi),
            }
        }
    })
}
