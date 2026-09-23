//! Provenance keys of a body's entities (SPEC-v1 §5.2) and display names.
//!
//! Keys are rendered by [`forge_core::topo::Provenance::key_with_sources`] with:
//! - the **feature id**: the provenance `feature` segment, mapped through the scope's
//!   provenance-feature map (the v0 pipeline stamps feature *names*; v1 evaluation stamps
//!   ids and needs no map);
//! - the **qualifier**: the provenance's own [`Provenance::qualifier`] when the operation set
//!   one, otherwise derived here for the two cases v0-era operations do not record:
//!   - a cap or end cap gets the body member `@m` (rule 4): the member of the body's origin
//!     when its feature created the body, else the member of its feature's only region (a
//!     single-region sweep joined into another body); a multi-region sweep joined into another
//!     body leaves it unqualified, which [`key_problems`] reports (forge-ops must stamp it);
//!   - a side–side junction edge of a sweep gets `@c.end`, the smallest curve end of the sketch
//!     vertex it was swept from: the junction of the sweep's regions whose two curves are the
//!     edge's two side curves and whose point lies on the edge's carrier. The junction vertices
//!     at its ends get the same qualifier (see the crate docs: SPEC §5.2 names no vertex
//!     qualifier, but without one the two vertices of a "D" junction would share a key);
//! - the sources of edges and vertices: v0-era operations store the adjacent faces' **names**;
//!   they are replaced by those faces' keys (looked up in the same body).
//!
//! [`key_problems`] is the invariant check of the plan (W3 scope): every key complete (no
//! missing cap member or junction qualifier, every source resolved) and unique within its
//! body except split pieces (§5.2 rule 3: faces or edges sharing a key on one carrier).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::Curve3;
use forge_core::linalg::Vec3;
use forge_core::topo::{Body, EdgeId, FaceId, KeyRoleArg, Provenance, Role, VertexId, parse_key};
use forge_ir::v1::metrics::Origin;

use crate::table::FeatureTable;

/// A face, edge or vertex of one body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityId {
    /// A face.
    Face(FaceId),
    /// An edge.
    Edge(EdgeId),
    /// A vertex.
    Vertex(VertexId),
    /// The body itself.
    Body,
}

/// A problem found by [`key_problems`] (or while deriving keys).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct KeyProblem {
    /// The entity's key as rendered.
    pub key: String,
    /// What is wrong.
    pub problem: String,
}

/// The key of a body: `F/body:m` for origin `(F, m)`, with `@i` / `@i.j` for a pattern
/// instance (SPEC §5.6 captures bodies but §5.2 gives them no key grammar; see the crate
/// docs).
pub fn body_key(origin: &Origin) -> String {
    let mut p = Provenance::new(origin.feature.clone(), Role::Other("body".into()))
        .with_sources([origin.member.clone()]);
    if let Some(inst) = &origin.instance {
        let q: Vec<String> = inst.iter().map(u32::to_string).collect();
        p = p.with_qualifier(q.join("."));
    }
    p.key()
}

pub(crate) struct KeyCtx<'a> {
    pub table: &'a FeatureTable,
    pub prov_feature: &'a BTreeMap<String, String>,
    /// Linear tolerance for junction-point tests (mm, already scaled).
    pub tol: f64,
}

impl KeyCtx<'_> {
    fn feature(&self, f: &str) -> String {
        self.prov_feature
            .get(f)
            .cloned()
            .unwrap_or_else(|| f.to_string())
    }
}

/// Keys of every face, edge and vertex of a body, and the problems met.
pub(crate) fn body_keys(
    body: &Body,
    origin: &Origin,
    ctx: &KeyCtx<'_>,
) -> (BTreeMap<EntityId, String>, Vec<KeyProblem>) {
    let mut keys = BTreeMap::new();
    let mut problems = Vec::new();
    // Faces.
    let mut name_to_key: BTreeMap<String, String> = BTreeMap::new();
    let mut dup_names: BTreeSet<String> = BTreeSet::new();
    for (fid, f) in body.faces().iter() {
        let p = &f.provenance;
        let feature = ctx.feature(&p.feature);
        let mut q = p.qualifier.clone();
        let cap = matches!(
            p.role,
            Role::CapStart | Role::CapEnd | Role::EndCapStart | Role::EndCapEnd
        );
        if q.is_none() && cap {
            q = cap_member(&feature, origin, ctx);
        }
        let mut pk = p.clone();
        pk.feature = feature;
        pk.qualifier = q;
        let key = pk.key();
        if cap && pk.qualifier.is_none() {
            problems.push(KeyProblem {
                key: key.clone(),
                problem: "cap without a body member qualifier".into(),
            });
        }
        // Faces sharing a name are ambiguous edge sources only when their keys differ (split
        // pieces share both).
        let name = p.name();
        if let Some(prev) = name_to_key.insert(name.clone(), key.clone())
            && prev != key
        {
            dup_names.insert(name);
        }
        keys.insert(EntityId::Face(fid), key);
    }
    for n in &dup_names {
        problems.push(KeyProblem {
            key: n.clone(),
            problem: "several faces of the body carry this name; edge sources are ambiguous".into(),
        });
    }
    let source_keys = |p: &Provenance, problems: &mut Vec<KeyProblem>| -> Vec<String> {
        p.sources
            .iter()
            .map(|s| match name_to_key.get(s) {
                Some(k) if !dup_names.contains(s) => k.clone(),
                _ if parse_key(s).is_ok() && !s.contains('#') && is_key_like(s, &name_to_key) => {
                    s.clone()
                }
                _ => {
                    problems.push(KeyProblem {
                        key: p.name(),
                        problem: format!("source {s:?} is not a face of the body"),
                    });
                    s.clone()
                }
            })
            .collect()
    };
    // Edges.
    let mut junction_q: BTreeMap<EdgeId, String> = BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        let p = &e.provenance;
        let feature = ctx.feature(&p.feature);
        let sources: Vec<String> = match p.role {
            Role::EdgeBetween | Role::VertexAt => source_keys(p, &mut problems),
            _ => p.sources.iter().cloned().collect(),
        };
        let mut q = p.qualifier.clone();
        if q.is_none()
            && p.role == Role::EdgeBetween
            && let Some(jq) = junction_qualifier(&feature, &sources, &e.curve, ctx)
        {
            q = Some(jq.clone());
            junction_q.insert(eid, jq);
        }
        let mut pk = p.clone();
        pk.feature = feature;
        pk.qualifier = q;
        let key = pk.key_with_sources(&sources);
        // A side–side junction edge of a sweep (§5.2 rule 3) must be qualified: without its
        // `@c.end` the two junction edges of a "D" share the key.
        if pk.qualifier.is_none() && p.role == Role::EdgeBetween && side_side(&pk.feature, &sources)
        {
            problems.push(KeyProblem {
                key: key.clone(),
                problem: "side–side junction edge without a junction qualifier".into(),
            });
        }
        keys.insert(EntityId::Edge(eid), key);
    }
    // Vertices: the junction qualifier of an incident junction edge of the same feature.
    let mut incident: BTreeMap<VertexId, Vec<EdgeId>> = BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        for v in [e.start, e.end].into_iter().flatten() {
            let l = incident.entry(v).or_default();
            if !l.contains(&eid) {
                l.push(eid);
            }
        }
    }
    for (vid, v) in body.vertices().iter() {
        let p = &v.provenance;
        let feature = ctx.feature(&p.feature);
        let sources: Vec<String> = match p.role {
            Role::EdgeBetween | Role::VertexAt => source_keys(p, &mut problems),
            _ => p.sources.iter().cloned().collect(),
        };
        let mut q = p.qualifier.clone();
        if q.is_none() {
            q = incident
                .get(&vid)
                .into_iter()
                .flatten()
                .filter(|e| {
                    body.edge(**e)
                        .is_some_and(|x| ctx.feature(&x.provenance.feature) == feature)
                })
                .filter_map(|e| junction_q.get(e))
                .min()
                .cloned();
        }
        let mut pk = p.clone();
        pk.feature = feature;
        pk.qualifier = q;
        keys.insert(EntityId::Vertex(vid), pk.key_with_sources(&sources));
    }
    (keys, problems)
}

/// The body member of a cap whose operation stamped no qualifier (§5.2 rule 4): the member
/// of the body's origin when the cap's feature created the body, otherwise the member of the
/// feature's only region (a single-region sweep joined into another body). A cap of a
/// multi-region sweep inside another feature's body gets none (a key problem): only the
/// operation knows which region it came from, so forge-ops must stamp it (W4).
fn cap_member(feature: &str, origin: &Origin, ctx: &KeyCtx<'_>) -> Option<String> {
    if feature == origin.feature {
        return Some(origin.member.clone());
    }
    match ctx.table.get(feature).map(|f| f.regions.as_slice()) {
        Some([only]) => only.member().map(str::to_string),
        _ => None,
    }
}

/// A source that is already a key of a face of this body (operations that store keys).
fn is_key_like(s: &str, name_to_key: &BTreeMap<String, String>) -> bool {
    name_to_key.values().any(|k| k == s)
}

/// The curve of an unqualified side face key `feature/side:c`.
fn side_curve(k: &str, feature: &str) -> Option<String> {
    let p = parse_key(k).ok()?;
    match (p.label.as_str(), p.arg, p.qualifier) {
        ("side", KeyRoleArg::Leaf(c), None) if p.feature == feature => Some(c),
        _ => None,
    }
}

/// `true` for the two face keys of a side–side junction edge of sweep `feature`: two side faces
/// of `feature` of different curves (an edge between two faces of one curve is a seam, or lies
/// between split pieces, and has no junction).
fn side_side(feature: &str, face_keys: &[String]) -> bool {
    match face_keys {
        [a, b] => matches!(
            (side_curve(a, feature), side_curve(b, feature)),
            (Some(ca), Some(cb)) if ca != cb
        ),
        _ => false,
    }
}

/// The `@c.end` qualifier of a side–side junction edge of a sweep (see the module docs).
fn junction_qualifier(
    feature: &str,
    face_keys: &[String],
    curve: &Curve3,
    ctx: &KeyCtx<'_>,
) -> Option<String> {
    let [a, b] = face_keys else { return None };
    let (ca, cb) = (side_curve(a, feature)?, side_curve(b, feature)?);
    if ca == cb {
        // Two ends of one curve meet only on a closed curve, which has no junctions: a seam,
        // or an edge between pieces of one side face.
        return None;
    }
    let mut want = [ca.as_str(), cb.as_str()];
    want.sort_unstable();
    let info = ctx.table.get(feature)?;
    let mut hits: Vec<String> = Vec::new();
    for j in info.regions.iter().flat_map(|r| &r.junctions) {
        let mut got: Vec<&str> = j.ends().iter().map(|(c, _)| *c).collect();
        got.sort_unstable();
        if got != want || !on_carrier(curve, Vec3::from(j.point), ctx.tol) {
            continue;
        }
        if let Some(q) = j.qualifier()
            && !hits.contains(&q)
        {
            hits.push(q);
        }
    }
    match hits.as_slice() {
        [one] => Some(one.clone()),
        _ => None,
    }
}

/// `true` if `p` lies on the (infinite) carrier of an edge curve within `tol`.
fn on_carrier(curve: &Curve3, p: Vec3, tol: f64) -> bool {
    match curve {
        Curve3::Line(l) => {
            let w = p - l.origin();
            (w - l.dir() * w.dot(l.dir())).norm() <= tol
        }
        Curve3::Circle(c) => {
            let f = c.frame();
            let w = p - f.origin();
            let h = w.dot(f.z());
            let rho = (w - f.z() * h).norm();
            h.abs() <= tol && (rho - c.radius()).abs() <= tol
        }
        _ => curve.project(p).1 <= tol,
    }
}

/// Invariant check of a body's keys (SPEC §5.2 rule 3 and the W3 plan): the problems met
/// while deriving them (a cap without its member, a side–side junction edge without its
/// qualifier, an edge source that is no face of the body), plus every key several entities of
/// the body share, **except**:
/// - **split pieces**: §5.2 rule 3 makes the pieces of a face or edge that an operation splits
///   share its key, and those pieces lie on the split entity's carrier. Faces (or edges)
///   sharing a key are accepted when `same_carrier` holds between the first and each other
///   one (the scope passes `geom::same_support` of their carriers, or, for `free` carriers,
///   equal surfaces or curves: pieces keep the split entity's geometry);
/// - **intersection vertices**: a vertex key whose sources are faces of two or more features
///   is a `G/vertex:{…}` of a body operation, which §5.2 gives no qualifier — a tool crossing
///   an edge twice legitimately makes two of them share one key (a contract note of the crate
///   docs).
///
/// Faces or edges sharing a key on different carriers (the unqualified junction edges of a
/// "D", a cap key stamped on both ends) and vertices of one feature sharing a key (a sweep's
/// vertices are told apart by their junction qualifiers) are problems. A body has one body
/// key.
///
/// Not detectable here: two faces of one carrier that an operation wrongly stamped with one
/// key (e.g. two regions' caps of one sweep given the same member) look like split pieces;
/// the derivation reports unstamped caps, and operations must stamp distinct members (W4).
pub fn key_problems(
    keys: &BTreeMap<EntityId, String>,
    derived: &[KeyProblem],
    same_carrier: impl Fn(EntityId, EntityId) -> bool,
) -> Vec<KeyProblem> {
    let mut out: Vec<KeyProblem> = derived.to_vec();
    let mut groups: BTreeMap<(u8, &str), Vec<EntityId>> = BTreeMap::new();
    for (id, k) in keys {
        let kind = match id {
            EntityId::Face(_) => 0,
            EntityId::Edge(_) => 1,
            EntityId::Vertex(_) => 2,
            EntityId::Body => 3,
        };
        groups.entry((kind, k.as_str())).or_default().push(*id);
    }
    for ((kind, k), ids) in groups {
        let [first, rest @ ..] = ids.as_slice() else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let n = ids.len();
        let problem = match kind {
            0 | 1 if rest.iter().all(|x| same_carrier(*first, *x)) => continue,
            0 | 1 => format!(
                "{n} {} of one body share the key on different carriers (not split pieces)",
                if kind == 0 { "faces" } else { "edges" }
            ),
            2 if source_features(k) >= 2 => continue,
            2 => format!("{n} vertices of one body share the key"),
            _ => format!("{n} entities of one body share the key"),
        };
        out.push(KeyProblem {
            key: k.to_string(),
            problem,
        });
    }
    out.sort();
    out.dedup();
    out
}

/// The number of distinct features among the source keys of a `…:{k|k|…}` key (0 for any
/// other key).
fn source_features(key: &str) -> usize {
    match parse_key(key).map(|p| p.arg) {
        Ok(KeyRoleArg::Keys(ks)) => ks
            .iter()
            .filter_map(|k| parse_key(k).ok().map(|p| p.feature))
            .collect::<BTreeSet<String>>()
            .len(),
        _ => 0,
    }
}

/// A key for people (§5.2 rule 2): feature ids replaced by the features' current names,
/// qualifiers kept or dropped, ids unescaped. A key that does not parse is returned as is.
pub fn display_key(key: &str, table: &FeatureTable, keep_qualifiers: bool) -> String {
    let Ok(p) = parse_key(key) else {
        return key.to_string();
    };
    let mut out = format!("{}/{}", table.name_of(&p.feature), p.label);
    match &p.arg {
        KeyRoleArg::None => {}
        KeyRoleArg::Leaf(l) => {
            out.push(':');
            out.push_str(l);
        }
        KeyRoleArg::Leaves(ls) => {
            out.push(':');
            out.push_str(&ls.join("+"));
        }
        KeyRoleArg::Keys(ks) => {
            let inner: Vec<String> = ks
                .iter()
                .map(|k| display_key(k, table, keep_qualifiers))
                .collect();
            out.push_str(":{");
            out.push_str(&inner.join("|"));
            out.push('}');
        }
    }
    if keep_qualifiers && let Some(q) = &p.qualifier {
        out.push('@');
        out.push_str(q);
    }
    out
}
