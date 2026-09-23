//! Provenance keys inside the boolean (SPEC §5.2).
//!
//! The boolean compares and records identities by **key** (`Provenance::key`: feature id,
//! role, the `@qualifier`, never `#index`), not by the v0 display name, which drops the
//! qualifier and cannot tell the caps of two regions of one sweep apart.
//!
//! - **Normalized operands** ([`normalize`], at `apply_body_op`'s entry): every cap and end
//!   cap of the operand's origin feature that carries no qualifier gets the body member
//!   `@m` of the operand's origin (§5.2 rules 1 and 4: forge-ops stamps it once the cap may
//!   end up in another feature's body, W4); the sources of edge and vertex provenances (the
//!   v0 convention stores the adjacent faces' names) are replaced by those faces' keys.
//!   Inside the boolean every entity's key is then simply `Provenance::key()`.
//! - **Keys of new entities** are rendered from the keys of the result faces around them
//!   (`G/edge:{A|B}`, `G/vertex:{…}`), and same-domain merges move the sources of the
//!   operation's own new edges and vertices to the surviving face key (the result's faces),
//!   while every other entity keeps its key (§5.2 rule 3: it was not modified), even when a
//!   source face was merged away: that source is then an alias of a face of the body.
//! - **Denormalized results** ([`denormalize`], at the exit): a source key is written back
//!   as the face's display name when that face is in the body and no other face shares its
//!   name (the v0 convention readers of `Provenance::name` rely on); a key stays a key
//!   where a name would be ambiguous (caps `@a` and `@b` of one sweep in one body) or the
//!   face is gone (merged away: the key is an alias). forge-refs reads both forms.

use std::collections::BTreeMap;

use forge_core::topo::{Body, Provenance, Role};
use forge_ir::v1::metrics::Origin;

use super::error::BooleanError;
use super::unify::{ProvOf, map_provenance};

/// `true` for cap and end-cap roles (the faces that carry the body member, §5.2 rule 1).
pub(crate) fn is_cap(role: &Role) -> bool {
    matches!(
        role,
        Role::CapStart | Role::CapEnd | Role::EndCapStart | Role::EndCapEnd
    )
}

/// `true` for roles whose sources are entity names or keys (edges and vertices between
/// faces).
fn names_sources(role: &Role) -> bool {
    matches!(role, Role::EdgeBetween | Role::VertexAt)
}

/// Face display name → key, for names that designate one key in the body (`None` for a
/// name several faces with different keys share).
fn face_name_keys(body: &Body) -> BTreeMap<String, Option<String>> {
    let mut m: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (_, f) in body.faces().iter() {
        let k = f.provenance.key();
        match m.get_mut(&f.provenance.name()) {
            Some(slot) => {
                if slot.as_ref() != Some(&k) {
                    *slot = None;
                }
            }
            None => {
                m.insert(f.provenance.name(), Some(k));
            }
        }
    }
    m
}

/// The operand as the boolean works on it: caps of its origin feature stamped with the
/// origin's member, edge and vertex sources as face keys (see the module docs). `origin`
/// `None` only converts sources (a body without a known origin).
pub(crate) fn normalize(body: &Body, origin: Option<&Origin>) -> Result<Body, BooleanError> {
    // Face keys after stamping, by display name.
    let stamp = |p: &Provenance| -> Option<Provenance> {
        let o = origin?;
        (is_cap(&p.role) && p.qualifier.is_none() && p.feature == o.feature)
            .then(|| p.clone().with_qualifier(o.member.clone()))
    };
    let mut names: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (_, f) in body.faces().iter() {
        let p = stamp(&f.provenance).unwrap_or_else(|| f.provenance.clone());
        let k = p.key();
        match names.get_mut(&p.name()) {
            Some(slot) => {
                if slot.as_ref() != Some(&k) {
                    *slot = None;
                }
            }
            None => {
                names.insert(p.name(), Some(k));
            }
        }
    }
    map_provenance(body, |of, p| match of {
        ProvOf::Face => stamp(p),
        ProvOf::Edge | ProvOf::Vertex if names_sources(&p.role) => {
            let sources: Vec<String> = p
                .sources
                .iter()
                .map(|s| match names.get(s) {
                    Some(Some(k)) => k.clone(),
                    // Already a key, or an ambiguous name (left for forge-refs to report).
                    _ => s.clone(),
                })
                .collect();
            let changed = sources.iter().zip(&p.sources).any(|(a, b)| a != b);
            changed.then(|| {
                let mut q = p.clone();
                q.sources = sources.into_iter().collect();
                q
            })
        }
        _ => None,
    })
}

/// Write source keys back as face names where that is unambiguous (see the module docs).
pub(crate) fn denormalize(body: &Body) -> Result<Body, BooleanError> {
    let names = face_name_keys(body);
    // Key → name for faces whose name designates exactly that key.
    let back: BTreeMap<String, String> = names
        .into_iter()
        .filter_map(|(n, k)| k.map(|k| (k, n)))
        .collect();
    map_provenance(body, |of, p| match of {
        ProvOf::Edge | ProvOf::Vertex if names_sources(&p.role) => {
            let sources: Vec<String> = p
                .sources
                .iter()
                .map(|s| back.get(s).cloned().unwrap_or_else(|| s.clone()))
                .collect();
            let changed = sources.iter().zip(&p.sources).any(|(a, b)| a != b);
            changed.then(|| {
                let mut q = p.clone();
                q.sources = sources.into_iter().collect();
                q
            })
        }
        _ => None,
    })
}

/// Keys of every face and edge of a (normalized) body.
pub(crate) fn entity_keys(b: &Body) -> impl Iterator<Item = String> + '_ {
    b.faces()
        .iter()
        .map(|(_, f)| f.provenance.key())
        .chain(b.edges().iter().map(|(_, e)| e.provenance.key()))
}
