//! Keys and display names of the input body's entities (SPEC-v1 §5.2), and the provenance
//! of the entities fillet, chamfer and shell create.
//!
//! The caller (forge-regen, with forge-refs' keys) may supply the keys and display names of
//! every entity ([`KeyMap::set_face`] …). Otherwise they are derived from the provenance as
//! forge-ops' booleans do: a face's key is `Provenance::key()`, and an edge or vertex whose
//! sources are face **names** (the v0 convention) gets those faces' keys as sources.
//!
//! New entities (§5.2 rule 3):
//! - fillet `F`: blend face of edge `E` → `F/blend:{E}`, corner patch at vertex `V` →
//!   `F/corner:{V}`; chamfer `F`: `F/bevel:{E}` and `F/corner:{V}`;
//! - shell `S`: offset of face `X` → `S/offset:{X}`, rim left where `X` was opened →
//!   `S/rim:{X}`;
//! - new edges and vertices → `F/edge:{A|B}` and `F/vertex:{…}` keyed by the faces around
//!   them (as booleans name theirs); entities an operation only modifies keep their keys.

use std::collections::BTreeMap;

use forge_core::topo::{Body, EdgeId, FaceId, Provenance, Role, VertexId};

use crate::error::Named;

/// Keys and display names of a body's faces, edges and vertices.
#[derive(Clone, Debug, Default)]
pub struct KeyMap {
    faces: BTreeMap<FaceId, Named>,
    edges: BTreeMap<EdgeId, Named>,
    vertices: BTreeMap<VertexId, Named>,
}

fn names_sources(role: &Role) -> bool {
    matches!(role, Role::EdgeBetween | Role::VertexAt)
}

impl KeyMap {
    /// Keys derived from the body's provenance (see the module docs); display names are the
    /// v0 names (`Provenance::name`).
    pub fn derive(body: &Body) -> Self {
        // Face display name → key, where the name designates one key.
        let mut by_name: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut faces = BTreeMap::new();
        for (fid, f) in body.faces().iter() {
            let k = f.provenance.key();
            match by_name.get_mut(&f.provenance.name()) {
                Some(slot) => {
                    if slot.as_ref() != Some(&k) {
                        *slot = None;
                    }
                }
                None => {
                    by_name.insert(f.provenance.name(), Some(k.clone()));
                }
            }
            faces.insert(
                fid,
                Named {
                    key: k,
                    name: f.provenance.name(),
                },
            );
        }
        let key_of = |p: &Provenance| -> String {
            if names_sources(&p.role) {
                let s: Vec<String> = p
                    .sources
                    .iter()
                    .map(|s| match by_name.get(s) {
                        Some(Some(k)) => k.clone(),
                        _ => s.clone(),
                    })
                    .collect();
                p.key_with_sources(&s)
            } else {
                p.key()
            }
        };
        let edges = body
            .edges()
            .iter()
            .map(|(id, e)| {
                (
                    id,
                    Named {
                        key: key_of(&e.provenance),
                        name: e.provenance.name(),
                    },
                )
            })
            .collect();
        let vertices = body
            .vertices()
            .iter()
            .map(|(id, v)| {
                (
                    id,
                    Named {
                        key: key_of(&v.provenance),
                        name: v.provenance.name(),
                    },
                )
            })
            .collect();
        Self {
            faces,
            edges,
            vertices,
        }
    }

    /// Override a face's key and display name.
    pub fn set_face(&mut self, id: FaceId, key: impl Into<String>, name: impl Into<String>) {
        self.faces.insert(
            id,
            Named {
                key: key.into(),
                name: name.into(),
            },
        );
    }
    /// Override an edge's key and display name.
    pub fn set_edge(&mut self, id: EdgeId, key: impl Into<String>, name: impl Into<String>) {
        self.edges.insert(
            id,
            Named {
                key: key.into(),
                name: name.into(),
            },
        );
    }
    /// Override a vertex's key and display name.
    pub fn set_vertex(&mut self, id: VertexId, key: impl Into<String>, name: impl Into<String>) {
        self.vertices.insert(
            id,
            Named {
                key: key.into(),
                name: name.into(),
            },
        );
    }

    /// A face's key and name (`None` for an id the map does not know).
    pub fn face(&self, id: FaceId) -> Option<Named> {
        self.faces.get(&id).cloned()
    }
    /// An edge's key and name.
    pub fn edge(&self, id: EdgeId) -> Option<Named> {
        self.edges.get(&id).cloned()
    }
    /// A vertex's key and name.
    pub fn vertex(&self, id: VertexId) -> Option<Named> {
        self.vertices.get(&id).cloned()
    }

    /// The keys of **every** entity of `body`: those of `given` where it has them, derived
    /// from provenance ([`KeyMap::derive`]) otherwise. Entities of `given` that are not in
    /// `body` are dropped.
    pub fn complete(body: &Body, given: Option<&KeyMap>) -> Self {
        let mut out = Self::derive(body);
        if let Some(g) = given {
            for (id, n) in &g.faces {
                if let Some(slot) = out.faces.get_mut(id) {
                    *slot = n.clone();
                }
            }
            for (id, n) in &g.edges {
                if let Some(slot) = out.edges.get_mut(id) {
                    *slot = n.clone();
                }
            }
            for (id, n) in &g.vertices {
                if let Some(slot) = out.vertices.get_mut(id) {
                    *slot = n.clone();
                }
            }
        }
        out
    }
}

/// A face or edge as the caller resolved it — for example from a forge-refs
/// `ResolvedMember`: `body` is the index of the body it was resolved on in the caller's
/// numbering (forge-refs' `Entity::body`), `id` its id **in that body**, `key` its key (used
/// in reports).
///
/// Face and edge ids are per-body arena indices: an id of another body would silently name
/// whichever entity of this body has the same index. Every operation therefore checks that
/// each pick belongs to the body it runs on (`BlendOptions::body`, `ShellOptions::body`, in
/// the same numbering) and is an entity of it, and fails explicitly otherwise
/// (`SHELL_FACE_NOT_ON_BODY`, `CHAMFER_SIDE_NOT_ADJACENT`, `FILLET_FAILED` /
/// `CHAMFER_FAILED` naming the pick by its key).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pick<T> {
    /// Index of the body the entity belongs to (the caller's numbering).
    pub body: usize,
    /// The entity's id in that body.
    pub id: T,
    /// The entity's key.
    pub key: String,
}

impl<T> Pick<T> {
    /// A pick.
    pub fn new(body: usize, id: T, key: impl Into<String>) -> Self {
        Self {
            body,
            id,
            key: key.into(),
        }
    }
}

/// Picks for edges of `body` (its index `body_index`), keyed from its provenance
/// ([`KeyMap::derive`]); ids that are not edges of `body` are skipped.
pub fn pick_edges(body: &Body, body_index: usize, ids: &[EdgeId]) -> Vec<Pick<EdgeId>> {
    let k = KeyMap::derive(body);
    ids.iter()
        .filter_map(|&id| k.edge(id).map(|n| Pick::new(body_index, id, n.key)))
        .collect()
}

/// Picks for faces of `body` (see [`pick_edges`]).
pub fn pick_faces(body: &Body, body_index: usize, ids: &[FaceId]) -> Vec<Pick<FaceId>> {
    let k = KeyMap::derive(body);
    ids.iter()
        .filter_map(|&id| k.face(id).map(|n| Pick::new(body_index, id, n.key)))
        .collect()
}

/// `F/<label>:{K}` (a [`Role::Derived`] provenance).
pub(crate) fn derived(feature: &str, label: &str, source_key: &str) -> Provenance {
    Provenance::new(feature, Role::Derived(label.into())).with_sources([source_key])
}

/// `F/edge:{A|B}` from the two face keys.
pub(crate) fn edge_between(feature: &str, a: &str, b: &str) -> Provenance {
    Provenance::edge_between(feature, a, b)
}

/// `F/vertex:{…}` from the keys of the faces around it (deduplicated).
pub(crate) fn vertex_at(feature: &str, faces: &[String]) -> Provenance {
    let mut s: Vec<String> = faces.to_vec();
    s.sort();
    s.dedup();
    Provenance::vertex_at(feature, s)
}
