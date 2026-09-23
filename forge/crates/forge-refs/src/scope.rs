//! The scope of a query (SPEC-v1 §5.3): the bodies of the feature's part in the feature's
//! input state, the earlier features, and the aliases of merged keys.
//!
//! A [`Scope`] indexes every face, edge, vertex and body by provenance key once, when it is
//! built, and computes exact geometry (sizes, centroids, boxes), fingerprints and probes
//! lazily, once per entity. It never persists anything: [`Entity`] handles are
//! process-local, like arena ids.

use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet};

use forge_core::linalg::Vec3;
use forge_core::topo::{Body, EdgeId, FaceId, VertexId};
use forge_ir::v1::metrics::{Origin, Probe};
use forge_ir::v1::{
    BoolScalar, Carrier, EntityKind, Fingerprint, FingerprintType, LINEAR_TOLERANCE, Scalar,
};

use crate::error::RefError;
use crate::exact::{Box3, edge_props, face_props};
use crate::geom::{clean, clean3, edge_carrier, face_carrier, same_support};
use crate::keys::{EntityId, KeyCtx, KeyProblem, body_key, body_keys, display_key, key_problems};
use crate::probe::{edge_probe, face_probe, vertex_probe};
use crate::table::FeatureTable;

/// A face, edge, vertex or body of a [`Scope`] (process-local).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Entity {
    /// Index of the body in the scope.
    pub body: usize,
    /// The entity within the body.
    pub id: EntityId,
}

impl Entity {
    /// The entity kind.
    pub fn kind(&self) -> EntityKind {
        match self.id {
            EntityId::Face(_) => EntityKind::Face,
            EntityId::Edge(_) => EntityKind::Edge,
            EntityId::Vertex(_) => EntityKind::Vertex,
            EntityId::Body => EntityKind::Body,
        }
    }
}

/// A body of the scope with its identity (§5.2 rule 4).
#[derive(Clone, Debug)]
pub struct ScopeBody<'a> {
    /// The body.
    pub body: &'a Body,
    /// Its origin: creating feature id, member, pattern instance.
    pub origin: Origin,
}

/// Exact geometry of an entity (§5.6 fingerprint fields that do not depend on neighbours).
#[derive(Clone, Debug, PartialEq)]
pub struct Props {
    /// Canonical type.
    pub geom_type: FingerprintType,
    /// Exact carrier.
    pub carrier: Carrier,
    /// Area, length, 0 (vertex) or volume (body).
    pub size: f64,
    /// World centroid (a vertex: its position).
    pub centroid: [f64; 3],
    /// Tight box.
    pub bbox: Box3,
}

/// Evaluates an expression string of a Scalar field to a number (the W1 evaluator, with the
/// document's parameter values); `None` when it cannot.
pub type ScalarHook<'a> = dyn Fn(&str) -> Option<f64> + 'a;
/// Evaluates a Bool expression string.
pub type BoolHook<'a> = dyn Fn(&str) -> Option<bool> + 'a;

pub(crate) struct BodyData<'a> {
    pub body: &'a Body,
    pub origin: Origin,
    pub bbox: Option<Box3>,
    pub keys: BTreeMap<EntityId, String>,
    pub problems: Vec<KeyProblem>,
    pub vertex_edges: BTreeMap<VertexId, Vec<EdgeId>>,
    props: BTreeMap<EntityId, OnceCell<Result<Props, RefError>>>,
    probes: BTreeMap<EntityId, OnceCell<Result<Probe, RefError>>>,
}

/// Builds a [`Scope`].
pub struct ScopeBuilder<'a> {
    table: FeatureTable,
    bodies: Vec<ScopeBody<'a>>,
    aliases: BTreeMap<String, String>,
    prov_feature: BTreeMap<String, String>,
    scalars: Option<&'a ScalarHook<'a>>,
    bools: Option<&'a BoolHook<'a>>,
}

impl<'a> ScopeBuilder<'a> {
    /// A scope over the given earlier features.
    pub fn new(table: FeatureTable) -> Self {
        ScopeBuilder {
            table,
            bodies: Vec::new(),
            aliases: BTreeMap::new(),
            prov_feature: BTreeMap::new(),
            scalars: None,
            bools: None,
        }
    }
    /// Add a body of the part's current state.
    pub fn body(mut self, body: &'a Body, origin: Origin) -> Self {
        self.bodies.push(ScopeBody { body, origin });
        self
    }
    /// Add several bodies.
    pub fn bodies(mut self, bodies: impl IntoIterator<Item = ScopeBody<'a>>) -> Self {
        self.bodies.extend(bodies);
        self
    }
    /// Record that `alias` (a key merged away by the same-domain rule, §5.2 rule 3) now
    /// designates the face keyed `key`. Chains (`A → B` from one merge, `B → C` from a later
    /// one) are closed when the scope is built: `A` then designates `C`.
    pub fn alias(mut self, alias: impl Into<String>, key: impl Into<String>) -> Self {
        self.aliases.insert(alias.into(), key.into());
        self
    }
    /// Map a provenance `feature` segment (e.g. a v0 feature *name*) to a feature id.
    pub fn provenance_feature(mut self, stamped: impl Into<String>, id: impl Into<String>) -> Self {
        self.prov_feature.insert(stamped.into(), id.into());
        self
    }
    /// The evaluator of Scalar expressions.
    pub fn scalars(mut self, hook: &'a ScalarHook<'a>) -> Self {
        self.scalars = Some(hook);
        self
    }
    /// The evaluator of Bool expressions.
    pub fn bools(mut self, hook: &'a BoolHook<'a>) -> Self {
        self.bools = Some(hook);
        self
    }
    /// Index the scope: keys of every entity, the scale `s`.
    pub fn build(self) -> Scope<'a> {
        let boxes: Vec<Option<Box3>> = self
            .bodies
            .iter()
            .map(|b| {
                forge_check::bbox(b.body)
                    .ok()
                    .map(|(min, max)| Box3 { min, max })
            })
            .collect();
        let all = boxes.iter().flatten().copied().reduce(|a, b| a.union(&b));
        let scale = all.map_or(1.0, |b| b.diagonal()).max(1.0);
        let ctx = KeyCtx {
            table: &self.table,
            prov_feature: &self.prov_feature,
            tol: LINEAR_TOLERANCE * scale,
        };
        let mut bodies = Vec::with_capacity(self.bodies.len());
        for (sb, bbox) in self.bodies.iter().zip(boxes) {
            let (mut keys, problems) = body_keys(sb.body, &sb.origin, &ctx);
            keys.insert(EntityId::Body, body_key(&sb.origin));
            let mut vertex_edges: BTreeMap<VertexId, Vec<EdgeId>> = BTreeMap::new();
            for (eid, e) in sb.body.edges().iter() {
                for v in [e.start, e.end].into_iter().flatten() {
                    let l = vertex_edges.entry(v).or_default();
                    if !l.contains(&eid) {
                        l.push(eid);
                    }
                }
            }
            let props = keys.keys().map(|k| (*k, OnceCell::new())).collect();
            let probes = keys.keys().map(|k| (*k, OnceCell::new())).collect();
            bodies.push(BodyData {
                body: sb.body,
                origin: sb.origin.clone(),
                bbox,
                keys,
                problems,
                vertex_edges,
                props,
                probes,
            });
        }
        let mut by_key: BTreeMap<String, Vec<Entity>> = BTreeMap::new();
        for (bi, b) in bodies.iter().enumerate() {
            for (id, k) in &b.keys {
                by_key
                    .entry(k.clone())
                    .or_default()
                    .push(Entity { body: bi, id: *id });
            }
        }
        // Display names: a name without qualifiers is used when no other key of the kind
        // shares it (§5.2 rule 2).
        let mut short_keys: BTreeMap<(EntityKind, String), BTreeSet<String>> = BTreeMap::new();
        for (k, ents) in &by_key {
            if let Some(e) = ents.first() {
                short_keys
                    .entry((e.kind(), display_key(k, &self.table, false)))
                    .or_default()
                    .insert(k.clone());
            }
        }
        Scope {
            table: self.table,
            bodies,
            aliases: close_aliases(self.aliases),
            by_key,
            short_keys,
            scale,
            scalars: self.scalars,
            bools: self.bools,
        }
    }
}

/// The scope of a query or reference (see the module docs).
pub struct Scope<'a> {
    pub(crate) table: FeatureTable,
    pub(crate) bodies: Vec<BodyData<'a>>,
    pub(crate) aliases: BTreeMap<String, String>,
    pub(crate) by_key: BTreeMap<String, Vec<Entity>>,
    short_keys: BTreeMap<(EntityKind, String), BTreeSet<String>>,
    scale: f64,
    scalars: Option<&'a ScalarHook<'a>>,
    bools: Option<&'a BoolHook<'a>>,
}

impl<'a> Scope<'a> {
    /// A scope with no bodies and no features.
    pub fn empty() -> Scope<'static> {
        ScopeBuilder::new(FeatureTable::new()).build()
    }

    /// The earlier features.
    pub fn table(&self) -> &FeatureTable {
        &self.table
    }

    /// `s`: the diagonal of the scope's bounding box, at least 1 (v0 §6).
    pub fn scale(&self) -> f64 {
        self.scale
    }

    /// Number of bodies.
    pub fn body_count(&self) -> usize {
        self.bodies.len()
    }

    /// The body of an entity.
    pub fn body(&self, e: Entity) -> &'a Body {
        self.bodies[e.body].body
    }

    /// The origin of body `b`.
    pub fn origin(&self, b: usize) -> &Origin {
        &self.bodies[b].origin
    }

    /// The body entity of body `b`.
    pub fn body_entity(b: usize) -> Entity {
        Entity {
            body: b,
            id: EntityId::Body,
        }
    }

    /// Every entity of a kind, in arena order per body (use [`Scope::canonical`] to order).
    pub fn entities(&self, kind: EntityKind) -> Vec<Entity> {
        let mut out = Vec::new();
        for (bi, b) in self.bodies.iter().enumerate() {
            match kind {
                EntityKind::Body => out.push(Self::body_entity(bi)),
                EntityKind::Face => out.extend(b.body.faces().iter().map(|(f, _)| Entity {
                    body: bi,
                    id: EntityId::Face(f),
                })),
                EntityKind::Edge => out.extend(b.body.edges().iter().map(|(x, _)| Entity {
                    body: bi,
                    id: EntityId::Edge(x),
                })),
                EntityKind::Vertex => out.extend(b.body.vertices().iter().map(|(x, _)| Entity {
                    body: bi,
                    id: EntityId::Vertex(x),
                })),
            }
        }
        out
    }

    /// The provenance key of an entity (bodies: `F/body:m`).
    pub fn key(&self, e: Entity) -> &str {
        self.bodies[e.body]
            .keys
            .get(&e.id)
            .map_or("?", String::as_str)
    }

    /// Entities carrying exactly this key.
    pub fn with_key(&self, key: &str) -> &[Entity] {
        self.by_key.get(key).map_or(&[], Vec::as_slice)
    }

    /// The key an alias designates now, if `key` was merged away (chains closed).
    pub fn alias_target(&self, key: &str) -> Option<&str> {
        self.aliases.get(key).map(String::as_str)
    }

    /// A key rewritten through the aliases of merged faces (§5.2 rule 3): its alias target
    /// if it was merged away, otherwise the key with every **nested** key (the faces of
    /// `edge:{A|B}`, `vertex:{…}`, `blend:{E}`, …) rewritten the same way, recursively, and
    /// the nested keys of edges and vertices re-sorted. An edge between a merged-away face `A`
    /// and `C` is then found as `G/edge:{B|C}`. A key without aliased parts is returned
    /// unchanged.
    pub fn normalize_key(&self, key: &str) -> String {
        if let Some(t) = self.alias_target(key) {
            return t.to_string();
        }
        if self.aliases.is_empty() {
            return key.to_string();
        }
        let Ok(mut p) = forge_core::topo::parse_key(key) else {
            return key.to_string();
        };
        let forge_core::topo::KeyRoleArg::Keys(ks) = &p.arg else {
            return key.to_string();
        };
        let mut nk: Vec<String> = ks.iter().map(|k| self.normalize_key(k)).collect();
        if nk == *ks {
            return key.to_string();
        }
        if matches!(p.label.as_str(), "edge" | "vertex") {
            nk.sort();
        }
        p.arg = forge_core::topo::KeyRoleArg::Keys(nk);
        p.render()
    }

    /// Every alias key that designates `key` now.
    pub fn aliases_of(&self, key: &str) -> Vec<&str> {
        self.aliases
            .iter()
            .filter(|(_, v)| v.as_str() == key)
            .map(|(k, _)| k.as_str())
            .collect()
    }

    /// Key problems of every body (incomplete keys, keys shared within a body by anything
    /// but split pieces on one carrier): the key invariant of SPEC §5.2 rule 3, see
    /// [`key_problems`]. Empty for a well-named model, split pieces
    /// included.
    pub fn key_problems(&self) -> Vec<KeyProblem> {
        let mut out = Vec::new();
        for (bi, b) in self.bodies.iter().enumerate() {
            let carrier = |id: EntityId| self.carrier(Entity { body: bi, id }).1;
            let same = |a: EntityId, x: EntityId| {
                let (ca, cx) = (carrier(a), carrier(x));
                if matches!((&ca, &cx), (Carrier::Free, Carrier::Free)) {
                    // Nothing to compare: pieces of a split keep the split entity's geometry.
                    same_geometry(b.body, a, x)
                } else {
                    same_support(&ca, &cx, self.scale)
                }
            };
            out.extend(key_problems(&b.keys, &b.problems, same));
        }
        out
    }

    /// The display name of an entity (§5.2 rule 2): feature names instead of ids, qualifiers
    /// only where needed to tell entities apart, and a `#k` display index among entities
    /// that share the key (split pieces), in canonical order.
    pub fn display_name(&self, e: Entity) -> String {
        let key = self.key(e);
        let short = display_key(key, &self.table, false);
        let unique = self
            .short_keys
            .get(&(e.kind(), short.clone()))
            .is_none_or(|s| s.len() <= 1);
        let base = if unique {
            short
        } else {
            display_key(key, &self.table, true)
        };
        let same: Vec<Entity> = self
            .with_key(key)
            .iter()
            .copied()
            .filter(|x| x.kind() == e.kind())
            .collect();
        if same.len() <= 1 {
            return base;
        }
        let ordered = self.canonical(same);
        let k = ordered.iter().position(|x| *x == e).unwrap_or(0);
        format!("{base}#{k}")
    }

    /// The display name of a key that designates no entity here (e.g. a captured key).
    pub fn display_of_key(&self, key: &str) -> String {
        display_key(key, &self.table, true)
    }

    // ---- geometry ----------------------------------------------------------------------------

    /// Type and carrier of an entity (cheap: no integrals).
    pub fn carrier(&self, e: Entity) -> (FingerprintType, Carrier) {
        let body = self.body(e);
        match e.id {
            EntityId::Face(f) => body
                .face(f)
                .map_or((FingerprintType::Other, Carrier::Free), |x| {
                    face_carrier(&x.surface, x.sense)
                }),
            EntityId::Edge(x) => body
                .edge(x)
                .map_or((FingerprintType::Other, Carrier::Free), |x| {
                    edge_carrier(&x.curve)
                }),
            EntityId::Vertex(_) => (FingerprintType::Vertex, Carrier::Free),
            EntityId::Body => (FingerprintType::Body, Carrier::Free),
        }
    }

    /// Exact size, centroid and box of an entity (cached).
    pub fn props(&self, e: Entity) -> Result<&Props, RefError> {
        let b = &self.bodies[e.body];
        let cell = b.props.get(&e.id).ok_or_else(|| RefError::Geometry {
            code: "FORGE_STALE_ENTITY".into(),
            message: "entity not in scope".into(),
        })?;
        cell.get_or_init(|| self.compute_props(e))
            .as_ref()
            .map_err(Clone::clone)
    }

    fn compute_props(&self, e: Entity) -> Result<Props, RefError> {
        let b = &self.bodies[e.body];
        let (geom_type, carrier) = self.carrier(e);
        let body = b.body;
        let named = |err: forge_check::CheckError| -> RefError {
            RefError::Geometry {
                code: err.code().to_string(),
                message: format!("{} ({})", err, self.key(e)),
            }
        };
        match e.id {
            EntityId::Face(f) => {
                let p = face_props(body, f).map_err(named)?;
                Ok(Props {
                    geom_type,
                    carrier,
                    size: clean(p.area),
                    centroid: p.centroid.map(clean),
                    bbox: clean_box(p.bbox),
                })
            }
            EntityId::Edge(x) => {
                let p = edge_props(body, x).map_err(named)?;
                Ok(Props {
                    geom_type,
                    carrier,
                    size: clean(p.length),
                    centroid: p.centroid.map(clean),
                    bbox: clean_box(p.bbox),
                })
            }
            EntityId::Vertex(v) => {
                let pt = body.vertex(v).map(|v| v.point).unwrap_or(Vec3::zero());
                let c = clean3(pt);
                Ok(Props {
                    geom_type,
                    carrier,
                    size: 0.0,
                    centroid: c,
                    bbox: Box3 { min: c, max: c },
                })
            }
            EntityId::Body => {
                let mp = forge_check::mass_properties(body).map_err(named)?;
                let bbox = b
                    .bbox
                    .ok_or_else(|| named(forge_check::CheckError::Empty))?;
                Ok(Props {
                    geom_type,
                    carrier,
                    size: clean(mp.volume),
                    centroid: mp.centroid.map(clean),
                    bbox: clean_box(bbox),
                })
            }
        }
    }

    /// Adjacent entities on the same carrier (the split signature, §5.6): faces across an
    /// edge, edges through a vertex; 0 for vertices and bodies.
    pub fn neighbors(&self, e: Entity) -> u32 {
        let (_, c) = self.carrier(e);
        let s = self.scale;
        let same = |o: Entity| same_support(&c, &self.carrier(o).1, s);
        match e.id {
            EntityId::Face(f) => {
                let body = self.body(e);
                let mut seen: Vec<FaceId> = Vec::new();
                for ed in body.face_edges(f) {
                    for g in body.edge_faces(ed) {
                        if g != f && !seen.contains(&g) {
                            seen.push(g);
                        }
                    }
                }
                seen.into_iter()
                    .filter(|g| {
                        same(Entity {
                            body: e.body,
                            id: EntityId::Face(*g),
                        })
                    })
                    .count() as u32
            }
            EntityId::Edge(x) => self
                .edge_neighbors(e.body, x)
                .into_iter()
                .filter(|g| {
                    same(Entity {
                        body: e.body,
                        id: EntityId::Edge(*g),
                    })
                })
                .count() as u32,
            _ => 0,
        }
    }

    pub(crate) fn edge_neighbors(&self, b: usize, x: EdgeId) -> Vec<EdgeId> {
        let data = &self.bodies[b];
        let mut out = Vec::new();
        if let Some(edge) = data.body.edge(x) {
            for v in [edge.start, edge.end].into_iter().flatten() {
                for &g in data.vertex_edges.get(&v).map_or(&[][..], Vec::as_slice) {
                    if g != x && !out.contains(&g) {
                        out.push(g);
                    }
                }
            }
        }
        out
    }

    /// The fingerprint of an entity (§5.6): exact props, body-local centroid, body centre and
    /// the same-carrier neighbour count.
    pub fn fingerprint(&self, e: Entity) -> Result<Fingerprint, RefError> {
        let p = self.props(e)?.clone();
        let bb = self.bodies[e.body].bbox;
        let (local, body_center) = match bb {
            Some(b) => {
                let n = |x: f64, lo: f64, hi: f64| {
                    let ext = hi - lo;
                    if ext > 1e-9 { (x - lo) / ext } else { 0.5 }
                };
                (
                    [0, 1, 2].map(|i| clean(n(p.centroid[i], b.min[i], b.max[i]))),
                    b.center().map(clean),
                )
            }
            None => ([0.5; 3], p.centroid),
        };
        Ok(Fingerprint {
            geom_type: p.geom_type,
            carrier: p.carrier,
            bbox: [p.bbox.min, p.bbox.max],
            size: p.size,
            centroid: p.centroid,
            local,
            body_center,
            neighbors: self.neighbors(e),
        })
    }

    /// The probe of an entity (§7.6; cached).
    pub fn probe(&self, e: Entity) -> Result<Probe, RefError> {
        let b = &self.bodies[e.body];
        let cell = b.probes.get(&e.id).ok_or_else(|| RefError::Geometry {
            code: "FORGE_STALE_ENTITY".into(),
            message: "entity not in scope".into(),
        })?;
        cell.get_or_init(|| self.compute_probe(e)).clone()
    }

    fn compute_probe(&self, e: Entity) -> Result<Probe, RefError> {
        let body = self.body(e);
        let stale = || RefError::Geometry {
            code: "FORGE_STALE_ENTITY".into(),
            message: "entity not in scope".into(),
        };
        match e.id {
            EntityId::Face(f) => {
                let c = self.props(e)?.centroid;
                face_probe(body, f, c, self.scale)
            }
            EntityId::Edge(x) => edge_probe(body, x).ok_or_else(stale),
            EntityId::Vertex(v) => vertex_probe(body, v).ok_or_else(stale),
            EntityId::Body => {
                // The probe of its face with the smallest key; among split pieces sharing
                // that key, the first in canonical order (by probe point, §5.4).
                let faces: Vec<Entity> = body
                    .faces()
                    .iter()
                    .map(|(f, _)| Entity {
                        body: e.body,
                        id: EntityId::Face(f),
                    })
                    .collect();
                let min_key = faces.iter().map(|f| self.key(*f)).min().ok_or_else(stale)?;
                let smallest: Vec<Entity> = faces
                    .iter()
                    .copied()
                    .filter(|f| self.key(*f) == min_key)
                    .collect();
                let first = *self.canonical(smallest).first().ok_or_else(stale)?;
                let mut p = self.probe(first)?;
                p.kind = EntityKind::Body;
                Ok(p)
            }
        }
    }

    // ---- canonical order (§5.4) --------------------------------------------------------------

    /// Order a set canonically: faces, edges and vertices by key, then pieces of one key by
    /// their probe points (lexicographic, tolerance `LINEAR_TOLERANCE·s`); bodies by origin
    /// (timeline index of the origin feature, member, instance), then by centroid. Duplicates
    /// are removed.
    pub fn canonical(&self, mut v: Vec<Entity>) -> Vec<Entity> {
        v.sort();
        v.dedup();
        let body_rank = |e: &Entity| {
            let o = &self.bodies[e.body].origin;
            (
                self.table.index(&o.feature).unwrap_or(usize::MAX),
                o.member.clone(),
                o.instance.clone(),
            )
        };
        v.sort_by(|a, b| {
            a.kind()
                .cmp(&b.kind())
                .then_with(|| {
                    if a.kind() == EntityKind::Body {
                        body_rank(a).cmp(&body_rank(b))
                    } else {
                        self.key(*a).cmp(self.key(*b))
                    }
                })
                .then(a.cmp(b))
        });
        // Within runs of one key (one origin for bodies): tolerant lexicographic order of
        // probe points (body centroids), by insertion sort (the tolerant comparison is not a
        // total order, so no library sort). The point only orders: an entity whose probe
        // fails is ordered by its centroid (then its first vertex, then the origin); it is
        // never reported with that point (see `resolve`).
        let tol = LINEAR_TOLERANCE * self.scale;
        let point = |e: &Entity| -> [f64; 3] {
            let centroid = || {
                self.props(*e).map_or_else(
                    |_| {
                        crate::query::vertices_of(self, *e)
                            .first()
                            .and_then(|v| self.props(*v).ok())
                            .map_or([0.0; 3], |p| p.centroid)
                    },
                    |p| p.centroid,
                )
            };
            if e.kind() == EntityKind::Body {
                centroid()
            } else {
                self.probe(*e).map_or_else(|_| centroid(), |p| p.point)
            }
        };
        let same_run = |a: &Entity, b: &Entity| {
            a.kind() == b.kind()
                && if a.kind() == EntityKind::Body {
                    body_rank(a) == body_rank(b)
                } else {
                    self.key(*a) == self.key(*b)
                }
        };
        let mut i = 0;
        while i < v.len() {
            let mut j = i + 1;
            while j < v.len() && same_run(&v[i], &v[j]) {
                j += 1;
            }
            if j - i > 1 {
                let mut run: Vec<(Entity, [f64; 3])> =
                    v[i..j].iter().map(|e| (*e, point(e))).collect();
                // Exact lexicographic order first, so that points within the tolerance of
                // each other keep a geometric order (arena order only for identical points,
                // i.e. coincident duplicates).
                run.sort_by(|a, b| {
                    (0..3)
                        .map(|k| a.1[k].total_cmp(&b.1[k]))
                        .find(|o| o.is_ne())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let mut sorted: Vec<(Entity, [f64; 3])> = Vec::with_capacity(run.len());
                for item in run {
                    let pos = sorted
                        .iter()
                        .position(|(_, p)| lex_less(&item.1, p, tol))
                        .unwrap_or(sorted.len());
                    sorted.insert(pos, item);
                }
                for (k, (e, _)) in sorted.into_iter().enumerate() {
                    v[i + k] = e;
                }
            }
            i = j;
        }
        v
    }

    // ---- scalars -----------------------------------------------------------------------------

    /// The value of a Scalar field (literal, or through the expression hook).
    pub fn scalar(&self, s: &Scalar, path: &str) -> Result<f64, RefError> {
        match s {
            Scalar::Num(x) => Ok(*x),
            Scalar::Expr(t) => self
                .scalars
                .and_then(|h| h(t))
                .filter(|x| x.is_finite())
                .ok_or_else(|| RefError::ExprUnavailable {
                    path: path.to_string(),
                }),
        }
    }

    /// The value of a Bool field.
    pub fn boolean(&self, b: &BoolScalar, path: &str) -> Result<bool, RefError> {
        match b {
            BoolScalar::Bool(x) => Ok(*x),
            BoolScalar::Expr(t) => {
                self.bools
                    .and_then(|h| h(t))
                    .ok_or_else(|| RefError::ExprUnavailable {
                        path: path.to_string(),
                    })
            }
        }
    }
}

/// Close alias chains: `A → B`, `B → C` becomes `A → C`, `B → C`. A cycle (which a correct
/// evaluator never records) leaves the keys on it mapped as given.
/// `true` for two faces with equal surfaces and senses, or two edges with equal curves.
fn same_geometry(body: &Body, a: EntityId, x: EntityId) -> bool {
    match (a, x) {
        (EntityId::Face(a), EntityId::Face(x)) => match (body.face(a), body.face(x)) {
            (Some(fa), Some(fx)) => fa.surface == fx.surface && fa.sense == fx.sense,
            _ => false,
        },
        (EntityId::Edge(a), EntityId::Edge(x)) => match (body.edge(a), body.edge(x)) {
            (Some(ea), Some(ex)) => ea.curve == ex.curve,
            _ => false,
        },
        _ => false,
    }
}

fn close_aliases(aliases: BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (a, first) in &aliases {
        let mut t = first;
        let mut seen: BTreeSet<&str> = BTreeSet::from([a.as_str()]);
        while let Some(next) = aliases.get(t) {
            if !seen.insert(t.as_str()) {
                t = first;
                break;
            }
            t = next;
        }
        if t == a {
            t = first;
        }
        out.insert(a.clone(), t.clone());
    }
    out
}

fn clean_box(b: Box3) -> Box3 {
    Box3 {
        min: b.min.map(clean),
        max: b.max.map(clean),
    }
}

/// `a < b` lexicographically, coordinates within `tol` counting as equal.
fn lex_less(a: &[f64; 3], b: &[f64; 3], tol: f64) -> bool {
    for i in 0..3 {
        if (a[i] - b[i]).abs() > tol {
            return a[i] < b[i];
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pieces of a split keep the split entity's geometry: equal surfaces (and senses) or
    /// curves compare equal, different ones do not (the key invariant's test for `free`
    /// carriers).
    #[test]
    fn same_geometry_compares_the_surfaces_and_curves() {
        let cube = forge_core::topo::samples::unit_cube();
        let faces: Vec<FaceId> = cube.faces().iter().map(|(id, _)| id).collect();
        let edges: Vec<EdgeId> = cube.edges().iter().map(|(id, _)| id).collect();
        let (f0, f1) = (EntityId::Face(faces[0]), EntityId::Face(faces[1]));
        let (e0, e1) = (EntityId::Edge(edges[0]), EntityId::Edge(edges[1]));
        assert!(same_geometry(&cube, f0, f0));
        assert!(!same_geometry(&cube, f0, f1));
        assert!(same_geometry(&cube, e0, e0));
        assert!(!same_geometry(&cube, e0, e1));
        assert!(!same_geometry(&cube, f0, e0), "kinds never match");
    }
}
