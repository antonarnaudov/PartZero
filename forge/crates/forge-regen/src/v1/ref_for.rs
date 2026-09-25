//! `refFor` (FULL-MODELING-PLAN §2.2 "Queries"; SPEC-v1 §5.1, §5.6, §5.8): a v1 [`Ref`] for
//! entities a person or an agent picked, **verified to resolve to exactly the picked set**.
//!
//! A pick names an entity the way a view shows it: its provenance **name** (the render mesh's
//! face and edge names, `plate/edge:{plate/cap:end|plate/side:top}`, `#k` for split pieces),
//! or its provenance **key** (the report's `refs[].members[].key`), plus a point on it (where it
//! was picked) to tell apart entities that share the name. A body is picked by its origin
//! (`{ feature, member, instance? }`, the report's `parts[].bodies[].origin`). A vertex is
//! picked by its point.
//!
//! The scope is the input state of a feature inserted at timeline index `at` of the part
//! (§5.3): the features before it are evaluated, nothing after it. For every picked entity
//! forge-refs' [`synthesize_query`] finds a query that selects exactly it (named sources first,
//! then `between`, `edge_at`, `extreme` narrowing), the queries are joined with `union`, and
//! the reference is resolved in the scope as a feature would resolve it: it must give exactly
//! the picked set. It then gets a fresh capture (§5.6) and is resolved again, capture
//! included, with the same outcome — otherwise nothing is returned (`COMMAND_REF_NOT_EXACT`).
//!
//! Kind conversion: an **edge** reference from picked faces takes each face's boundary edges
//! (`{ "op": "edges", "of": <face> }`: a fillet of "this face's edges", a loop); a **body**
//! reference from picked faces or edges takes their owner body (`{ "op": "owner", … }`).
//!
//! Errors are command-layer refusals (`COMMAND_*`, not IR report codes) with structured
//! `details`: the index of the pick that failed and why.

use std::collections::BTreeSet;

use forge_ir::v1::metrics::{Origin, Probe};
use forge_ir::v1::{Cardinality, Document, EntityKind, Query, Ref};
use forge_refs::{
    Entity, EntityId, FieldSpec, Scope, capture, eval_query, resolve_with, synthesize_query,
};
use serde_json::{Value, json};

use super::part::PartEval;

/// One picked entity.
#[derive(Clone, Debug, PartialEq)]
pub struct Pick {
    /// What was picked (`face`, `edge`, `vertex`, `body`).
    pub kind: EntityKind,
    /// Its provenance name as a view shows it (render mesh names; `#k` for split pieces).
    pub name: Option<String>,
    /// Its provenance key (SPEC-v1 §5.2), as the report's members carry it.
    pub key: Option<String>,
    /// A point on it (where it was picked), in model units: tells apart entities that share a
    /// name or key, and locates a vertex.
    pub point: Option<[f64; 3]>,
    /// Its body's origin (bodies: required; others: restricts the candidates to that body).
    pub body: Option<Origin>,
}

/// A member of the reference `refFor` built, as the report shows members.
#[derive(Clone, Debug, PartialEq)]
pub struct RefForMember {
    /// Provenance key.
    pub key: String,
    /// Display name (§5.2 rule 2).
    pub name: String,
    /// Where it is.
    pub probe: Probe,
}

/// The result of [`ref_for`].
#[derive(Clone, Debug, PartialEq)]
pub struct RefFor {
    /// The reference: the synthesized query, the declared cardinality (when not the field
    /// default) and a fresh capture.
    pub r: Ref,
    /// What it resolves to, in canonical order.
    pub members: Vec<RefForMember>,
}

impl RefFor {
    /// `{ ref, members: [{ key, name, probe }] }`.
    pub fn to_json(&self) -> Value {
        json!({
            "ref": serde_json::to_value(&self.r).expect("a Ref serializes"),
            "members": self.members.iter().map(|m| json!({
                "key": m.key,
                "name": m.name,
                "probe": serde_json::to_value(&m.probe).expect("a probe serializes"),
            })).collect::<Vec<_>>(),
        })
    }
}

/// A refusal of [`ref_for`] (nothing is returned).
#[derive(Clone, Debug, PartialEq)]
pub struct RefForError {
    /// `COMMAND_INVALID_ARGUMENT`, `COMMAND_PICK_NOT_FOUND`, `COMMAND_PICK_AMBIGUOUS`,
    /// `COMMAND_REF_NO_QUERY` or `COMMAND_REF_NOT_EXACT`.
    pub code: &'static str,
    /// Human-readable message (names entities by display name, never by arena id).
    pub message: String,
    /// Structured context: `{ pick }` (the index of the failing pick) and more per code.
    pub details: Value,
}

impl std::fmt::Display for RefForError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RefForError {}

fn refuse(code: &'static str, message: impl Into<String>, details: Value) -> RefForError {
    RefForError {
        code,
        message: message.into(),
        details,
    }
}

/// Build a reference of `kind` to the picked entities in the scope of a feature inserted at
/// timeline index `at` of part `part` (see the module docs). `card` is the declared
/// cardinality to write (`None`: the field's default, `some` for several picks and `one` for
/// one when checking).
pub fn ref_for(
    doc: &Document,
    part: usize,
    at: usize,
    kind: EntityKind,
    picks: &[Pick],
    card: Option<Cardinality>,
) -> Result<RefFor, RefForError> {
    if part >= doc.parts.len() {
        return Err(refuse(
            "COMMAND_INVALID_ARGUMENT",
            format!(
                "the document has {} part(s); part index {part} does not exist",
                doc.parts.len()
            ),
            json!({ "argument": "part", "reason": "unknown" }),
        ));
    }
    if picks.is_empty() {
        return Err(refuse(
            "COMMAND_INVALID_ARGUMENT",
            "pick at least one entity",
            json!({ "argument": "picks", "reason": "empty" }),
        ));
    }
    let pv = forge_params::evaluate(doc);
    PartEval::new(doc, part, &pv).scope_at(at, |scope| build(scope, kind, picks, card))
}

fn build(
    scope: &Scope<'_>,
    kind: EntityKind,
    picks: &[Pick],
    card: Option<Cardinality>,
) -> Result<RefFor, RefForError> {
    // 1. Every pick to one entity of the scope, and a query that selects exactly it.
    let mut picked: Vec<Entity> = Vec::with_capacity(picks.len());
    let mut queries: Vec<Query> = Vec::with_capacity(picks.len());
    for (i, p) in picks.iter().enumerate() {
        let e = locate(scope, i, p)?;
        if picked.contains(&e) {
            continue;
        }
        let q = synthesize_query(e, scope, None).ok_or_else(|| {
            refuse(
                "COMMAND_REF_NO_QUERY",
                format!(
                    "no query selects exactly {} in this state of the part",
                    scope.display_name(e)
                ),
                json!({ "pick": i, "name": scope.display_name(e) }),
            )
        })?;
        picked.push(e);
        queries.push(convert(q, e.kind(), kind, i)?);
    }
    let q = if queries.len() == 1 {
        queries.pop().expect("one query")
    } else {
        Query::Union { of: queries }
    };
    // 2. The set it must resolve to.
    let expected: BTreeSet<Entity> = eval_query(&q, scope)
        .map_err(|e| {
            refuse(
                "COMMAND_REF_NOT_EXACT",
                format!("the synthesized query does not evaluate: {e}"),
                json!({ "reason": "query" }),
            )
        })?
        .members
        .iter()
        .map(|m| m.entity)
        .collect();
    let direct: BTreeSet<Entity> = picked
        .iter()
        .copied()
        .filter(|e| e.kind() == kind)
        .collect();
    if !direct.is_subset(&expected) || expected.is_empty() {
        return Err(refuse(
            "COMMAND_REF_NOT_EXACT",
            "the synthesized query does not select every picked entity",
            json!({ "reason": "picked" }),
        ));
    }
    // 3. Resolved as a feature resolves it (without, then with its capture): the same set.
    let default_card = if expected.len() == 1 {
        Cardinality::ONE
    } else {
        Cardinality::SOME
    };
    let spec = FieldSpec {
        field: "/ref".to_string(),
        card: card.unwrap_or(default_card),
    };
    let mut r = Ref {
        kind,
        q,
        card,
        capture: None,
    };
    let first = resolve_with(&r, scope, &spec);
    let got: BTreeSet<Entity> = first.members.iter().map(|m| m.entity).collect();
    if let Some(err) = &first.error {
        return Err(refuse(
            "COMMAND_REF_NOT_EXACT",
            format!("the reference does not resolve: {}", err.message),
            json!({ "reason": "resolve", "code": err.code }),
        ));
    }
    if got != expected {
        return Err(refuse(
            "COMMAND_REF_NOT_EXACT",
            format!(
                "the reference resolves to {} entities, not the {} picked",
                got.len(),
                expected.len()
            ),
            json!({ "reason": "resolve", "found": got.len(), "expected": expected.len() }),
        ));
    }
    r.capture = Some(capture(&first.members, scope).map_err(|e| {
        refuse(
            "COMMAND_REF_NOT_EXACT",
            format!("no capture of the picked set: {e}"),
            json!({ "reason": "capture" }),
        )
    })?);
    let second = resolve_with(&r, scope, &spec);
    let again: BTreeSet<Entity> = second.members.iter().map(|m| m.entity).collect();
    if second.error.is_some() || again != expected {
        return Err(refuse(
            "COMMAND_REF_NOT_EXACT",
            "the captured reference does not resolve to the picked set",
            json!({ "reason": "capture" }),
        ));
    }
    let mut members = Vec::with_capacity(second.members.len());
    for m in &second.members {
        let probe = scope.probe(m.entity).map_err(|e| {
            refuse(
                "COMMAND_REF_NOT_EXACT",
                format!("no probe for {}: {e}", scope.display_name(m.entity)),
                json!({ "reason": "probe" }),
            )
        })?;
        members.push(RefForMember {
            key: m.key.clone(),
            name: scope.display_name(m.entity),
            probe,
        });
    }
    Ok(RefFor { r, members })
}

/// `q` (selecting one entity of kind `from`) as a query of kind `to`.
fn convert(q: Query, from: EntityKind, to: EntityKind, pick: usize) -> Result<Query, RefForError> {
    use EntityKind as K;
    match (from, to) {
        (a, b) if a == b => Ok(q),
        (K::Face, K::Edge) => Ok(Query::Edges { of: Box::new(q) }),
        (K::Face | K::Edge | K::Vertex, K::Body) => Ok(Query::Owner { of: Box::new(q) }),
        _ => Err(refuse(
            "COMMAND_INVALID_ARGUMENT",
            format!(
                "a {} reference cannot be made from a picked {}",
                to.as_str(),
                from.as_str()
            ),
            json!({ "argument": "picks", "reason": "kind", "pick": pick }),
        )),
    }
}

/// The scope entity a pick designates.
fn locate(scope: &Scope<'_>, i: usize, p: &Pick) -> Result<Entity, RefForError> {
    let not_found = |why: &str| {
        refuse(
            "COMMAND_PICK_NOT_FOUND",
            format!(
                "pick {i}: {why} in this state of the part (was it made after the insertion point, or did the model change?)"
            ),
            json!({ "pick": i, "reason": why }),
        )
    };
    let in_body = |b: usize| {
        p.body
            .as_ref()
            .is_none_or(|o| same_origin(scope.origin(b), o))
    };
    if p.kind == EntityKind::Body {
        let Some(o) = &p.body else {
            return Err(refuse(
                "COMMAND_INVALID_ARGUMENT",
                format!("pick {i}: a body is picked by its origin {{ feature, member }}"),
                json!({ "argument": "picks", "reason": "body-origin", "pick": i }),
            ));
        };
        let found: Vec<Entity> = (0..scope.body_count())
            .filter(|b| same_origin(scope.origin(*b), o))
            .map(Scope::body_entity)
            .collect();
        return choose(scope, i, found, p.point).map_err(|e| match e {
            None => not_found("no body with that origin"),
            Some(err) => err,
        });
    }
    let candidates: Vec<Entity> = scope
        .entities(p.kind)
        .into_iter()
        .filter(|e| in_body(e.body))
        .filter(|e| {
            let by_name = p
                .name
                .as_deref()
                .is_none_or(|n| entity_name(scope, *e).as_deref() == Some(n));
            let by_key = p.key.as_deref().is_none_or(|k| scope.key(*e) == k);
            by_name && by_key
        })
        .collect();
    if p.name.is_none() && p.key.is_none() {
        // A vertex (or anything) picked by its point alone: the nearest within tolerance.
        let Some(at) = p.point else {
            return Err(refuse(
                "COMMAND_INVALID_ARGUMENT",
                format!("pick {i}: give a name, a key or a point"),
                json!({ "argument": "picks", "reason": "empty-pick", "pick": i }),
            ));
        };
        let tol = pick_tolerance(scope);
        let near: Vec<Entity> = candidates
            .into_iter()
            .filter(|e| distance_to(scope, *e, at).is_some_and(|d| d <= tol))
            .collect();
        return choose(scope, i, near, Some(at))
            .map_err(|e| e.unwrap_or_else(|| not_found("nothing at that point")));
    }
    choose(scope, i, candidates, p.point)
        .map_err(|e| e.unwrap_or_else(|| not_found("no entity with that name or key")))
}

/// One of `found`: the only one, or the one nearest `point`. `Err(None)`: none found.
fn choose(
    scope: &Scope<'_>,
    i: usize,
    found: Vec<Entity>,
    point: Option<[f64; 3]>,
) -> Result<Entity, Option<RefForError>> {
    match (found.as_slice(), point) {
        ([], _) => Err(None),
        ([one], _) => Ok(*one),
        (_, Some(at)) => {
            let mut best: Option<(f64, Entity)> = None;
            for e in &found {
                let Some(d) = distance_to(scope, *e, at) else {
                    continue;
                };
                if best.is_none_or(|(bd, _)| d < bd) {
                    best = Some((d, *e));
                }
            }
            best.map(|(_, e)| e).ok_or(None)
        }
        (_, None) => Err(Some(refuse(
            "COMMAND_PICK_AMBIGUOUS",
            format!(
                "pick {i}: {} entities share that name; give the point where it was picked",
                found.len()
            ),
            json!({ "pick": i, "count": found.len() }),
        ))),
    }
}

/// The provenance name of a face or edge (what a render mesh calls it); `None` otherwise.
fn entity_name(scope: &Scope<'_>, e: Entity) -> Option<String> {
    let body = scope.body(e);
    match e.id {
        EntityId::Face(f) => body.face(f).map(|x| x.provenance.name()),
        EntityId::Edge(x) => body.edge(x).map(|x| x.provenance.name()),
        EntityId::Vertex(_) | EntityId::Body => None,
    }
}

fn same_origin(a: &Origin, b: &Origin) -> bool {
    a.feature == b.feature && a.member == b.member && a.instance == b.instance
}

/// How far a picked point may be from a vertex it designates: 1e-3 of the scope's size, at
/// least 1e-4 mm.
fn pick_tolerance(scope: &Scope<'_>) -> f64 {
    (scope.scale() * 1e-3).max(1e-4)
}

/// An upper-bound distance from `p` to the entity, for choosing among candidates: the distance
/// to its exact box (0 inside), then to its centroid as a tie-break (scaled down).
fn distance_to(scope: &Scope<'_>, e: Entity, p: [f64; 3]) -> Option<f64> {
    let props = scope.props(e).ok()?;
    let b = &props.bbox;
    let mut out = 0.0_f64;
    for (k, x) in p.iter().enumerate() {
        let d = if *x < b.min[k] {
            b.min[k] - x
        } else if *x > b.max[k] {
            x - b.max[k]
        } else {
            0.0
        };
        out += d * d;
    }
    let c = props.centroid;
    let dc = ((p[0] - c[0]).powi(2) + (p[1] - c[1]).powi(2) + (p[2] - c[2]).powi(2)).sqrt();
    Some(out.sqrt() + 1e-6 * dc)
}

#[cfg(test)]
#[path = "ref_for_tests.rs"]
mod tests;
