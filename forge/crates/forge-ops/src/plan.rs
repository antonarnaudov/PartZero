//! A two-pass body construction: operations first *plan* vertices, edges and faces with
//! their geometry, then [`Plan::build`] derives every edge's and vertex's provenance from
//! the faces that use it, assigns canonical instance indices, splits the faces into
//! connected shells, and builds the body through [`BodyBuilder`] (which validates it).
//!
//! # Naming
//! - A face carries the provenance its operation gives it (`side:<curve>`, caps, …).
//! - An edge is `edge:{<face a>|<face b>}` for the two faces that use it.
//! - A vertex is `vertex:{…}` for the faces around it.
//! - When several edges (or vertices) get the same name — e.g. the two vertical edges
//!   between the sides of a line+arc "D" profile — they are numbered by sorting their
//!   planning **keys** (stable sketch-level identities such as `"a:end|b:start"`), so the
//!   index does not depend on construction order.

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::geom::{Curve2, Curve3, Surface};
use forge_core::linalg::Point3;
use forge_core::topo::{Body, BodyBuilder, Provenance, RESERVED_NAME_CHARS, Severity};

use crate::error::OpError;

/// Index of a planned vertex.
pub(crate) type VIdx = usize;
/// Index of a planned edge.
pub(crate) type EIdx = usize;

pub(crate) struct PVertex {
    point: Point3,
    tolerance: f64,
    key: String,
}

pub(crate) enum PEnds {
    Ring,
    Open(VIdx, VIdx),
}

pub(crate) struct PEdge {
    curve: Curve3,
    range: (f64, f64),
    ends: PEnds,
    tolerance: f64,
    key: String,
}

/// One coedge: an edge used in a direction, with its pcurve on the face.
pub(crate) struct PUse {
    pub edge: EIdx,
    pub forward: bool,
    pub pcurve: Curve2,
}

pub(crate) struct PFace {
    surface: Surface,
    sense: bool,
    provenance: Provenance,
    loops: Vec<Vec<PUse>>,
}

pub(crate) struct Plan {
    feature: String,
    tolerance: Tolerance,
    vertices: Vec<PVertex>,
    edges: Vec<PEdge>,
    faces: Vec<PFace>,
}

impl Plan {
    pub fn new(feature: &str, tolerance: Tolerance) -> Self {
        Self {
            feature: feature.to_string(),
            tolerance,
            vertices: Vec::new(),
            edges: Vec::new(),
            faces: Vec::new(),
        }
    }

    pub fn vertex(&mut self, point: Point3, tolerance: f64, key: String) -> VIdx {
        self.vertices.push(PVertex {
            point,
            tolerance: tolerance.max(self.tolerance.linear),
            key,
        });
        self.vertices.len() - 1
    }

    pub fn edge(
        &mut self,
        curve: impl Into<Curve3>,
        range: (f64, f64),
        start: VIdx,
        end: VIdx,
        tolerance: f64,
        key: String,
    ) -> EIdx {
        self.edges.push(PEdge {
            curve: curve.into(),
            range,
            ends: PEnds::Open(start, end),
            tolerance: tolerance.max(self.tolerance.linear),
            key,
        });
        self.edges.len() - 1
    }

    pub fn ring(
        &mut self,
        curve: impl Into<Curve3>,
        range: (f64, f64),
        tolerance: f64,
        key: String,
    ) -> EIdx {
        self.edges.push(PEdge {
            curve: curve.into(),
            range,
            ends: PEnds::Ring,
            tolerance: tolerance.max(self.tolerance.linear),
            key,
        });
        self.edges.len() - 1
    }

    pub fn face(
        &mut self,
        surface: impl Into<Surface>,
        sense: bool,
        provenance: Provenance,
        loops: Vec<Vec<PUse>>,
    ) -> usize {
        self.faces.push(PFace {
            surface: surface.into(),
            sense,
            provenance,
            loops,
        });
        self.faces.len() - 1
    }

    /// Derive names, split shells and build the (validated) body.
    pub fn build(self) -> Result<Body, OpError> {
        let face_names: Vec<String> = self.faces.iter().map(|f| f.provenance.name()).collect();

        // Faces using each edge.
        let mut edge_faces: Vec<Vec<usize>> = vec![Vec::new(); self.edges.len()];
        for (fi, f) in self.faces.iter().enumerate() {
            for u in f.loops.iter().flatten() {
                edge_faces[u.edge].push(fi);
            }
        }
        let mut edge_prov: Vec<Provenance> = Vec::with_capacity(self.edges.len());
        for (ei, fs) in edge_faces.iter().enumerate() {
            let [a, b] = fs.as_slice() else {
                return Err(OpError::Internal(format!(
                    "planned edge {} is used {} times",
                    self.edges[ei].key,
                    fs.len()
                )));
            };
            if a == b {
                return Err(OpError::Internal(format!(
                    "planned edge {} is used twice by one face",
                    self.edges[ei].key
                )));
            }
            edge_prov.push(Provenance::edge_between(
                self.feature.as_str(),
                face_names[*a].clone(),
                face_names[*b].clone(),
            ));
        }
        assign_indices(&mut edge_prov, |i| self.edges[i].key.as_str());

        // Faces around each vertex.
        let mut vertex_faces: Vec<Vec<usize>> = vec![Vec::new(); self.vertices.len()];
        for (ei, e) in self.edges.iter().enumerate() {
            if let PEnds::Open(s, t) = e.ends {
                for v in [s, t] {
                    for &f in &edge_faces[ei] {
                        if !vertex_faces[v].contains(&f) {
                            vertex_faces[v].push(f);
                        }
                    }
                }
            }
        }
        let mut vertex_prov: Vec<Provenance> = Vec::with_capacity(self.vertices.len());
        for (vi, fs) in vertex_faces.iter().enumerate() {
            if fs.is_empty() {
                return Err(OpError::Internal(format!(
                    "planned vertex {} is not used by any edge",
                    self.vertices[vi].key
                )));
            }
            vertex_prov.push(Provenance::vertex_at(
                self.feature.as_str(),
                fs.iter().map(|&f| face_names[f].clone()),
            ));
        }
        assign_indices(&mut vertex_prov, |i| self.vertices[i].key.as_str());

        // Shells: connected components of faces sharing edges, ordered by first face.
        let mut parent: Vec<usize> = (0..self.faces.len()).collect();
        fn find(p: &mut [usize], mut x: usize) -> usize {
            while p[x] != x {
                p[x] = p[p[x]];
                x = p[x];
            }
            x
        }
        for fs in &edge_faces {
            let (a, b) = (find(&mut parent, fs[0]), find(&mut parent, fs[1]));
            if a != b {
                let (lo, hi) = (a.min(b), a.max(b));
                parent[hi] = lo;
            }
        }

        let mut bb = BodyBuilder::with_tolerance(self.tolerance);
        let mut vids = Vec::with_capacity(self.vertices.len());
        for (v, prov) in self.vertices.iter().zip(vertex_prov) {
            let id = bb.add_vertex(v.point, prov)?;
            if v.tolerance > self.tolerance.linear {
                bb.set_vertex_tolerance(id, v.tolerance)?;
            }
            vids.push(id);
        }
        let mut eids = Vec::with_capacity(self.edges.len());
        for (e, prov) in self.edges.iter().zip(edge_prov) {
            let id = match e.ends {
                PEnds::Ring => bb.add_ring_edge_with_range(e.curve.clone(), e.range, prov)?,
                PEnds::Open(s, t) => {
                    bb.add_edge(e.curve.clone(), e.range, vids[s], vids[t], prov)?
                }
            };
            if e.tolerance > self.tolerance.linear {
                bb.set_edge_tolerance(id, e.tolerance)?;
            }
            eids.push(id);
        }
        let mut shells = BTreeMap::new();
        for fi in 0..self.faces.len() {
            let root = find(&mut parent, fi);
            shells.entry(root).or_insert_with(|| None);
        }
        for sh in shells.values_mut() {
            *sh = Some(bb.add_shell(true));
        }
        for (fi, f) in self.faces.into_iter().enumerate() {
            let root = find(&mut parent, fi);
            let shell = shells[&root].expect("shell created");
            let fid = bb.add_face(shell, f.surface, f.sense, f.provenance)?;
            for lp in f.loops {
                let uses: Vec<_> = lp.iter().map(|u| (eids[u.edge], u.forward)).collect();
                let lid = bb.add_loop(fid, &uses)?;
                let coedges = bb
                    .body()
                    .loop_(lid)
                    .ok_or_else(|| OpError::Internal("loop vanished".into()))?
                    .coedges
                    .clone();
                for (cid, u) in coedges.into_iter().zip(lp) {
                    bb.set_pcurve(cid, u.pcurve)?;
                }
            }
        }
        bb.finish_validated()
            .map_err(|issues| OpError::InvalidResult {
                issues: issues
                    .iter()
                    .filter(|i| i.severity == Severity::Error)
                    .map(ToString::to_string)
                    .collect(),
            })
    }
}

/// Give entities that share a provenance name distinct indices, ordered by their keys.
fn assign_indices<'a>(provs: &mut [Provenance], key: impl Fn(usize) -> &'a str) {
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, p) in provs.iter().enumerate() {
        groups.entry(p.name()).or_default().push(i);
    }
    for members in groups.values_mut() {
        if members.len() < 2 {
            continue;
        }
        members.sort_by(|&a, &b| key(a).cmp(key(b)).then(a.cmp(&b)));
        for (idx, &m) in members.iter().enumerate() {
            provs[m].index = idx as u32;
        }
    }
}

/// Reject curve ids that cannot appear in provenance names.
pub(crate) fn check_curve_ids<'a>(ids: impl IntoIterator<Item = &'a str>) -> Result<(), OpError> {
    for id in ids {
        if id.is_empty() || id.contains(RESERVED_NAME_CHARS) {
            return Err(OpError::InvalidCurveId {
                curve: id.to_string(),
            });
        }
    }
    Ok(())
}
