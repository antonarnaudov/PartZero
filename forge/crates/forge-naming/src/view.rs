//! A read-only view of an evaluated IR document: every body with the feature and
//! sketch region it came from, the provenance name of each face and edge, and their
//! fingerprints.
//!
//! [`Loc`] addresses an entity inside one view. Like arena ids it is **process-local**
//! and never persisted; persistent references are [`crate::EntityRef`]s.

use std::collections::BTreeMap;

use forge_core::topo::{Body, EdgeId, FaceId, Provenance, Role};
use forge_ir::{Document, Feature};
use forge_regen::{Evaluation, FeatureOutput, evaluate};

use crate::fingerprint::{BodyFingerprints, Fingerprint, body_fingerprints};

/// Face or edge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityKind {
    /// A face.
    Face,
    /// An edge.
    Edge,
}

impl EntityKind {
    /// `"face"` or `"edge"`.
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Face => "face",
            EntityKind::Edge => "edge",
        }
    }
}

/// A face or edge id within one body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityId {
    /// A face.
    Face(FaceId),
    /// An edge.
    Edge(EdgeId),
}

impl EntityId {
    /// The entity kind.
    pub fn kind(self) -> EntityKind {
        match self {
            EntityId::Face(_) => EntityKind::Face,
            EntityId::Edge(_) => EntityKind::Edge,
        }
    }
}

/// An entity of a [`ModelView`]: body index (in evaluation order) and entity id.
/// Process-local, like arena ids.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Loc {
    /// Index into [`ModelView::bodies`].
    pub body: usize,
    /// The face or edge.
    pub entity: EntityId,
}

/// Name, name without `#index`, and fingerprint of one entity.
#[derive(Clone, Debug)]
pub struct EntityInfo {
    /// Canonical provenance name.
    pub name: String,
    /// The name with its `#index` removed (the index family key).
    pub base: String,
    /// Geometric fingerprint (with `family` filled in).
    pub fingerprint: Fingerprint,
    /// For an edge between two faces: the names of those faces (provenance sources).
    pub between: Option<[String; 2]>,
}

/// One body of the evaluation.
#[derive(Clone, Debug)]
pub struct BodyEntry {
    /// Part studio name.
    pub part: String,
    /// Name of the feature that produced the body.
    pub feature: String,
    /// Feature type (`extrude`, `revolve`).
    pub feature_type: &'static str,
    /// The IR name of the sketch region the body was swept from: its sorted outer-loop
    /// curve ids (SPEC §3.2). Empty if unknown.
    pub region: Vec<String>,
    /// The body.
    pub body: Body,
    pub(crate) entities: BTreeMap<EntityId, EntityInfo>,
}

/// A feature that failed in the evaluation (it has no bodies).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailedFeature {
    /// Feature name.
    pub feature: String,
    /// Error code.
    pub code: String,
}

/// Every body of an evaluated document, with names and fingerprints (see module docs).
#[derive(Clone, Debug, Default)]
pub struct ModelView {
    /// Bodies in evaluation order (timeline order, then canonical region order).
    pub bodies: Vec<BodyEntry>,
    /// Features that failed.
    pub failed: Vec<FailedFeature>,
    by_name: BTreeMap<(String, String), Vec<Loc>>,
    by_base: BTreeMap<(usize, String), Vec<Loc>>,
}

/// The name without its `#index` suffix.
fn base_name(p: &Provenance) -> String {
    let mut q = p.clone();
    q.index = 0;
    q.name()
}

impl ModelView {
    /// Evaluate `doc` with forge-regen and build the view.
    pub fn build(doc: &Document) -> ModelView {
        Self::from_evaluation(doc, &evaluate(doc))
    }

    /// Build the view of an existing evaluation of `doc`.
    pub fn from_evaluation(doc: &Document, eval: &Evaluation) -> ModelView {
        // Sketch of each body feature, and the regions of each sketch.
        let mut sketch_of: BTreeMap<&str, &str> = BTreeMap::new();
        for part in &doc.parts {
            for f in &part.features {
                match f {
                    Feature::Extrude(e) => {
                        sketch_of.insert(e.name.as_str(), e.sketch.as_str());
                    }
                    Feature::Revolve(r) => {
                        sketch_of.insert(r.name.as_str(), r.sketch.as_str());
                    }
                    Feature::Sketch(_) => {}
                }
            }
        }
        let mut regions_of: BTreeMap<&str, Vec<Vec<String>>> = BTreeMap::new();
        for fe in &eval.features {
            if let Ok(FeatureOutput::Regions(regs)) = &fe.outcome {
                regions_of.insert(
                    fe.feature.as_str(),
                    regs.iter().map(|r| r.outer_curves.clone()).collect(),
                );
            }
        }

        let mut view = ModelView::default();
        for fe in &eval.features {
            match &fe.outcome {
                Err(e) => view.failed.push(FailedFeature {
                    feature: fe.feature.clone(),
                    code: e.code().to_string(),
                }),
                Ok(FeatureOutput::Regions(_)) => {}
                Ok(FeatureOutput::Bodies(bodies)) => {
                    let regions = sketch_of
                        .get(fe.feature.as_str())
                        .and_then(|s| regions_of.get(s));
                    for (k, body) in bodies.iter().enumerate() {
                        let region = regions.and_then(|r| r.get(k)).cloned().unwrap_or_default();
                        view.push_body(&fe.part, &fe.feature, fe.feature_type, region, body);
                    }
                }
            }
        }
        view
    }

    fn push_body(
        &mut self,
        part: &str,
        feature: &str,
        feature_type: &'static str,
        region: Vec<String>,
        body: &Body,
    ) {
        let bi = self.bodies.len();
        let BodyFingerprints { faces, edges } = body_fingerprints(body);
        let mut entities = BTreeMap::new();
        for (fid, f) in body.faces().iter() {
            entities.insert(
                EntityId::Face(fid),
                EntityInfo {
                    name: f.provenance.name(),
                    base: base_name(&f.provenance),
                    fingerprint: faces[&fid].clone(),
                    between: None,
                },
            );
        }
        for (eid, e) in body.edges().iter() {
            entities.insert(
                EntityId::Edge(eid),
                EntityInfo {
                    name: e.provenance.name(),
                    base: base_name(&e.provenance),
                    fingerprint: edges[&eid].clone(),
                    between: match (&e.provenance.role, e.provenance.sources.as_slice()) {
                        (Role::EdgeBetween, [a, b]) => Some([a.clone(), b.clone()]),
                        _ => None,
                    },
                },
            );
        }
        // Index families (per body and kind) and the name index (per feature).
        let mut fam: BTreeMap<(EntityKind, String), u32> = BTreeMap::new();
        for (id, info) in &entities {
            *fam.entry((id.kind(), info.base.clone())).or_default() += 1;
        }
        for (id, info) in entities.iter_mut() {
            info.fingerprint.family = fam[&(id.kind(), info.base.clone())];
            let loc = Loc {
                body: bi,
                entity: *id,
            };
            self.by_name
                .entry((feature.to_string(), info.name.clone()))
                .or_default()
                .push(loc);
            self.by_base
                .entry((bi, info.base.clone()))
                .or_default()
                .push(loc);
        }
        self.bodies.push(BodyEntry {
            part: part.to_string(),
            feature: feature.to_string(),
            feature_type,
            region,
            body: body.clone(),
            entities,
        });
    }

    /// Every entity, in a deterministic order (bodies, then faces and edges in arena
    /// order).
    pub fn entities(&self) -> Vec<Loc> {
        self.bodies
            .iter()
            .enumerate()
            .flat_map(|(bi, b)| {
                b.entities
                    .keys()
                    .map(move |&entity| Loc { body: bi, entity })
            })
            .collect()
    }

    /// Name, base name and fingerprint of an entity.
    pub fn info(&self, loc: Loc) -> Option<&EntityInfo> {
        self.bodies.get(loc.body)?.entities.get(&loc.entity)
    }

    /// The canonical provenance name of an entity (`"?"` for a stale location).
    pub fn name(&self, loc: Loc) -> &str {
        self.info(loc).map_or("?", |i| i.name.as_str())
    }

    /// Entities of `feature` carrying exactly `name` (any body of the feature).
    pub fn lookup(&self, feature: &str, name: &str) -> &[Loc] {
        self.by_name
            .get(&(feature.to_string(), name.to_string()))
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    /// Entities of the body of `loc` sharing its name up to `#index` (including `loc`).
    pub fn family(&self, loc: Loc) -> Vec<Loc> {
        let Some(info) = self.info(loc) else {
            return Vec::new();
        };
        self.by_base
            .get(&(loc.body, info.base.clone()))
            .map(|v| {
                v.iter()
                    .copied()
                    .filter(|l| l.entity.kind() == loc.entity.kind())
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `true` if some face of body `body` named `a` and some face named `b` share an
    /// edge.
    pub fn faces_meet(&self, body: usize, a: &str, b: &str) -> bool {
        let Some(entry) = self.bodies.get(body) else {
            return false;
        };
        let named = |n: &str| -> Vec<FaceId> {
            entry
                .entities
                .iter()
                .filter_map(|(id, info)| match id {
                    EntityId::Face(f) if info.name == n => Some(*f),
                    _ => None,
                })
                .collect()
        };
        let (fa, fb) = (named(a), named(b));
        fa.iter().any(|f| {
            entry
                .body
                .face_edges(*f)
                .into_iter()
                .any(|e| entry.body.edge_faces(e).iter().any(|g| fb.contains(g)))
        })
    }

    /// Indices of the bodies produced by `feature`.
    pub fn bodies_of(&self, feature: &str) -> Vec<usize> {
        self.bodies
            .iter()
            .enumerate()
            .filter(|(_, b)| b.feature == feature)
            .map(|(i, _)| i)
            .collect()
    }
}
