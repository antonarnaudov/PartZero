//! Scene input and its CPU-side packing into GPU-ready buffers.
//!
//! A scene is a list of [`SceneBody`]s — typically `forge_mesh::tessellate_render`
//! output — each with per-face triangle ranges and per-edge polylines named by
//! provenance. [`SceneData::build`] validates them and produces:
//! - one interleaved vertex buffer (position, exact normal, scene-global face index,
//!   sRGB colour) and one index buffer for all bodies (indices rebased, so no
//!   `base_vertex` is needed — WebGL2 lacks it);
//! - one line-segment instance per consecutive pair of edge-polyline points;
//! - silhouette candidates: every interior mesh edge of a face whose two triangles are
//!   not coplanar, with both facet normals, so the GPU can keep exactly the edges where
//!   the facing flips for the current view;
//! - name tables mapping scene-global face/edge indices back to `(body, provenance
//!   name)` for picking, and names back to indices for hover/selection.
//!
//! Packing is deterministic: bodies, faces and edges keep their input order; silhouette
//! candidates are sorted by vertex pair.

use std::collections::BTreeMap;

use glam::DVec3;

use crate::pick::MAX_INDEX;

/// Default body colour (sRGB).
pub const DEFAULT_BODY_COLOR: [f32; 3] = [0.74, 0.77, 0.81];
/// Edge colour (sRGB).
pub const EDGE_COLOR: [f32; 3] = [0.10, 0.11, 0.13];

/// Bytes per face vertex: position (3×f32), normal (3×f32), face (u32), colour (4×u8).
pub const FACE_VERTEX_STRIDE: u64 = 32;
/// Bytes per line instance: p0 (3×f32), p1 (3×f32), id (u32), colour (4×u8).
pub const LINE_INSTANCE_STRIDE: u64 = 32;
/// Bytes per silhouette candidate: p0, p1, normal A, normal B (4×3×f32), face (u32).
pub const SILHOUETTE_INSTANCE_STRIDE: u64 = 52;

/// One named face: a range of the body's triangles.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneFace {
    /// Provenance name.
    pub name: String,
    /// First triangle.
    pub tri_start: u32,
    /// Triangle count.
    pub tri_count: u32,
}

/// One named edge: its polyline.
#[derive(Clone, Debug, PartialEq)]
pub struct SceneEdge {
    /// Provenance name.
    pub name: String,
    /// Points (mm), at least 2 to be drawn.
    pub points: Vec<[f32; 3]>,
}

/// One body to render.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SceneBody {
    /// Body name (e.g. `part/feature` or `part/feature#1`).
    pub name: String,
    /// Positions (mm).
    pub positions: Vec<[f32; 3]>,
    /// Unit normals, one per position.
    pub normals: Vec<[f32; 3]>,
    /// Triangles, counter-clockwise from outside.
    pub triangles: Vec<[u32; 3]>,
    /// Named faces (triangle ranges).
    pub faces: Vec<SceneFace>,
    /// Named edges (polylines).
    pub edges: Vec<SceneEdge>,
    /// Colour (sRGB, 0..1); `None` for the default.
    pub color: Option<[f32; 3]>,
}

impl SceneBody {
    /// A body from a render mesh, taking ownership (no copies of the vertex data).
    pub fn from_owned_render_mesh(name: impl Into<String>, mesh: forge_mesh::RenderMesh) -> Self {
        let edges = mesh
            .edge_polylines
            .into_iter()
            .map(|e| SceneEdge {
                name: e.edge_name,
                points: e
                    .points
                    .iter()
                    .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
                    .collect(),
            })
            .collect();
        SceneBody {
            name: name.into(),
            positions: mesh.positions,
            normals: mesh.normals,
            triangles: mesh.triangles,
            faces: mesh
                .face_ranges
                .into_iter()
                .map(|f| SceneFace {
                    name: f.face_name,
                    tri_start: f.tri_start,
                    tri_count: f.tri_count,
                })
                .collect(),
            edges,
            color: None,
        }
    }

    /// A body from a render mesh (`forge_mesh::tessellate_render`).
    pub fn from_render_mesh(name: impl Into<String>, mesh: &forge_mesh::RenderMesh) -> Self {
        SceneBody {
            name: name.into(),
            positions: mesh.positions.clone(),
            normals: mesh.normals.clone(),
            triangles: mesh.triangles.clone(),
            faces: mesh
                .face_ranges
                .iter()
                .map(|f| SceneFace {
                    name: f.face_name.clone(),
                    tri_start: f.tri_start,
                    tri_count: f.tri_count,
                })
                .collect(),
            edges: mesh
                .edge_polylines
                .iter()
                .map(|e| SceneEdge {
                    name: e.edge_name.clone(),
                    points: e
                        .points
                        .iter()
                        .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
                        .collect(),
                })
                .collect(),
            color: None,
        }
    }
}

/// Why a scene cannot be built. Every variant has a stable [`SceneError::code`].
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum SceneError {
    /// `positions` and `normals` differ in length.
    #[error("body {body}: {positions} positions but {normals} normals")]
    NormalCount {
        /// Body name.
        body: String,
        /// Number of positions.
        positions: usize,
        /// Number of normals.
        normals: usize,
    },
    /// A triangle references a missing vertex.
    #[error("body {body}: triangle {triangle} references vertex {vertex} of {count}")]
    IndexOutOfRange {
        /// Body name.
        body: String,
        /// Triangle index.
        triangle: usize,
        /// The bad vertex index.
        vertex: u32,
        /// Vertex count.
        count: usize,
    },
    /// A face range is outside the triangle list or overlaps another face.
    #[error("body {body}: face {face} has an invalid triangle range")]
    BadFaceRange {
        /// Body name.
        body: String,
        /// Face name.
        face: String,
    },
    /// A position, normal or edge point is not finite.
    #[error("body {body}: non-finite {what}")]
    NonFinite {
        /// Body name.
        body: String,
        /// What.
        what: &'static str,
    },
    /// Too many faces or edges to encode in a pick id.
    #[error("the scene has more than 2^30 faces or edges")]
    TooLarge,
}

impl SceneError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            SceneError::NormalCount { .. } => "RENDER_NORMAL_COUNT",
            SceneError::IndexOutOfRange { .. } => "RENDER_INDEX_OUT_OF_RANGE",
            SceneError::BadFaceRange { .. } => "RENDER_BAD_FACE_RANGE",
            SceneError::NonFinite { .. } => "RENDER_NON_FINITE",
            SceneError::TooLarge => "RENDER_SCENE_TOO_LARGE",
        }
    }
}

/// Per-body entry of the name tables.
#[derive(Clone, Debug, PartialEq)]
pub struct BodyInfo {
    /// Body name.
    pub name: String,
    /// First scene-global face index.
    pub face_base: u32,
    /// Face names, in input order (plus `"(unassigned)"` if some triangles had no face).
    pub faces: Vec<String>,
    /// First scene-global edge index.
    pub edge_base: u32,
    /// Edge names, in input order.
    pub edges: Vec<String>,
    /// Triangles.
    pub triangles: u32,
    /// Vertices after per-face splitting.
    pub vertices: u32,
}

/// Name for triangles not covered by any face range.
pub const UNASSIGNED_FACE: &str = "(unassigned)";

/// Maps between scene-global indices and `(body, name)`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SceneTables {
    /// Bodies in input order.
    pub bodies: Vec<BodyInfo>,
    /// Scene-global face index → body index.
    pub face_body: Vec<u32>,
    /// Scene-global edge index → body index.
    pub edge_body: Vec<u32>,
    by_name: BTreeMap<String, usize>,
}

/// A reference to one face or edge of the scene.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityRef {
    /// Scene-global face index.
    Face(u32),
    /// Scene-global edge index.
    Edge(u32),
}

impl SceneTables {
    /// Total faces.
    pub fn face_count(&self) -> u32 {
        self.face_body.len() as u32
    }

    /// Total edges.
    pub fn edge_count(&self) -> u32 {
        self.edge_body.len() as u32
    }

    /// `(body index, local face index, face name)` of a global face index.
    pub fn face(&self, global: u32) -> Option<(u32, u32, &str)> {
        let b = *self.face_body.get(global as usize)?;
        let info = &self.bodies[b as usize];
        let local = global - info.face_base;
        Some((b, local, info.faces[local as usize].as_str()))
    }

    /// `(body index, local edge index, edge name)` of a global edge index.
    pub fn edge(&self, global: u32) -> Option<(u32, u32, &str)> {
        let b = *self.edge_body.get(global as usize)?;
        let info = &self.bodies[b as usize];
        let local = global - info.edge_base;
        Some((b, local, info.edges[local as usize].as_str()))
    }

    /// Index of a body by name (the first one if names repeat).
    pub fn body_index(&self, name: &str) -> Option<usize> {
        self.by_name.get(name).copied()
    }

    /// Resolve `(body name, face name)`.
    pub fn face_by_name(&self, body: &str, face: &str) -> Option<EntityRef> {
        let info = &self.bodies[self.body_index(body)?];
        let local = info.faces.iter().position(|f| f == face)?;
        Some(EntityRef::Face(info.face_base + local as u32))
    }

    /// Resolve `(body name, edge name)`.
    pub fn edge_by_name(&self, body: &str, edge: &str) -> Option<EntityRef> {
        let info = &self.bodies[self.body_index(body)?];
        let local = info.edges.iter().position(|e| e == edge)?;
        Some(EntityRef::Edge(info.edge_base + local as u32))
    }

    /// Resolve `(body index, local face index)`.
    pub fn face_by_index(&self, body: usize, local: usize) -> Option<EntityRef> {
        let info = self.bodies.get(body)?;
        (local < info.faces.len()).then(|| EntityRef::Face(info.face_base + local as u32))
    }

    /// Resolve `(body index, local edge index)`.
    pub fn edge_by_index(&self, body: usize, local: usize) -> Option<EntityRef> {
        let info = self.bodies.get(body)?;
        (local < info.edges.len()).then(|| EntityRef::Edge(info.edge_base + local as u32))
    }
}

/// GPU-ready packed scene (see the module docs).
#[derive(Clone, Debug, Default)]
pub struct SceneData {
    /// Interleaved face vertices ([`FACE_VERTEX_STRIDE`] bytes each).
    pub vertices: Vec<u8>,
    /// Number of vertices.
    pub vertex_count: u32,
    /// Triangle indices into the vertex buffer (rebased per body).
    pub indices: Vec<u32>,
    /// Edge segment instances ([`LINE_INSTANCE_STRIDE`] bytes each).
    pub edge_segments: Vec<u8>,
    /// Number of edge segments.
    pub edge_segment_count: u32,
    /// Silhouette candidate instances ([`SILHOUETTE_INSTANCE_STRIDE`] bytes each).
    pub silhouettes: Vec<u8>,
    /// Number of silhouette candidates.
    pub silhouette_count: u32,
    /// Name tables.
    pub tables: SceneTables,
    /// Axis-aligned bounds of all positions, if any.
    pub bounds: Option<(DVec3, DVec3)>,
}

/// Little-endian byte packing (no `unsafe` casts of structs).
#[derive(Default)]
struct Packer(Vec<u8>);

impl Packer {
    fn f32(&mut self, v: f32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn vec3(&mut self, v: [f32; 3]) {
        for c in v {
            self.f32(c);
        }
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn rgba8(&mut self, c: [f32; 3]) {
        for x in c {
            self.0.push((x.clamp(0.0, 1.0) * 255.0).round() as u8);
        }
        self.0.push(255);
    }
}

fn finite3(p: &[f32; 3]) -> bool {
    p.iter().all(|c| c.is_finite())
}

fn facet_normal(a: [f32; 3], b: [f32; 3], c: [f32; 3]) -> Option<[f64; 3]> {
    let a = DVec3::from(a.map(f64::from));
    let b = DVec3::from(b.map(f64::from));
    let c = DVec3::from(c.map(f64::from));
    let n = (b - a).cross(c - a);
    let l = n.length();
    (l > 0.0 && l.is_finite()).then(|| (n / l).to_array())
}

/// Two facet normals closer than this (1 − cos) are treated as coplanar: such an edge
/// can never be a silhouette.
const COPLANAR_EPS: f64 = 1e-9;

impl SceneData {
    /// Validate and pack `bodies`.
    pub fn build(bodies: &[SceneBody]) -> Result<SceneData, SceneError> {
        let mut out = SceneData::default();
        let mut verts = Packer::default();
        let mut edges = Packer::default();
        let mut sils = Packer::default();
        let mut lo = DVec3::splat(f64::INFINITY);
        let mut hi = DVec3::splat(f64::NEG_INFINITY);
        for (bi, body) in bodies.iter().enumerate() {
            let err_body = || body.name.clone();
            let nv = body.positions.len();
            if body.normals.len() != nv {
                return Err(SceneError::NormalCount {
                    body: err_body(),
                    positions: nv,
                    normals: body.normals.len(),
                });
            }
            if !body.positions.iter().all(finite3) {
                return Err(SceneError::NonFinite {
                    body: err_body(),
                    what: "position",
                });
            }
            if !body.normals.iter().all(finite3) {
                return Err(SceneError::NonFinite {
                    body: err_body(),
                    what: "normal",
                });
            }
            for (ti, t) in body.triangles.iter().enumerate() {
                for &v in t {
                    if v as usize >= nv {
                        return Err(SceneError::IndexOutOfRange {
                            body: err_body(),
                            triangle: ti,
                            vertex: v,
                            count: nv,
                        });
                    }
                }
            }
            // Triangle → local face (input order; later ranges may not overlap earlier ones).
            let nt = body.triangles.len();
            let mut tri_face = vec![u32::MAX; nt];
            for (fi, f) in body.faces.iter().enumerate() {
                let s = f.tri_start as usize;
                let e = s.checked_add(f.tri_count as usize);
                let bad = || SceneError::BadFaceRange {
                    body: err_body(),
                    face: f.name.clone(),
                };
                let e = e.filter(|&e| e <= nt).ok_or_else(bad)?;
                for tf in &mut tri_face[s..e] {
                    if *tf != u32::MAX {
                        return Err(bad());
                    }
                    *tf = fi as u32;
                }
            }
            let mut face_names: Vec<String> = body.faces.iter().map(|f| f.name.clone()).collect();
            if tri_face.contains(&u32::MAX) {
                let extra = face_names.len() as u32;
                face_names.push(UNASSIGNED_FACE.to_string());
                for tf in &mut tri_face {
                    if *tf == u32::MAX {
                        *tf = extra;
                    }
                }
            }
            let face_base = out.tables.face_body.len() as u32;
            let edge_base = out.tables.edge_body.len() as u32;
            let total_faces = face_base as u64 + face_names.len() as u64;
            let total_edges = edge_base as u64 + body.edges.len() as u64;
            if total_faces > u64::from(MAX_INDEX) || total_edges > u64::from(MAX_INDEX) {
                return Err(SceneError::TooLarge);
            }
            let color = body.color.unwrap_or(DEFAULT_BODY_COLOR);

            // Vertices, split so that each carries exactly one face. A vertex keeps its
            // slot for the first face that uses it; other faces get copies (rare: render
            // meshes are already split per face). Allocation follows triangle order, so
            // the packing is deterministic.
            let vbase = out.vertex_count;
            let mut first: Vec<(u32, u32)> = vec![(u32::MAX, 0); nv];
            let mut extra: BTreeMap<(u32, u32), u32> = BTreeMap::new();
            let mut local_count = 0u32;
            let mut emit = |v: u32, f: u32, verts: &mut Packer| -> u32 {
                let (ff, o) = first[v as usize];
                if ff == f {
                    return o;
                }
                if ff != u32::MAX
                    && let Some(&o) = extra.get(&(v, f))
                {
                    return o;
                }
                let o = local_count;
                local_count += 1;
                if ff == u32::MAX {
                    first[v as usize] = (f, o);
                } else {
                    extra.insert((v, f), o);
                }
                verts.vec3(body.positions[v as usize]);
                verts.vec3(body.normals[v as usize]);
                verts.u32(face_base + f);
                verts.rgba8(color);
                o
            };
            for (ti, t) in body.triangles.iter().enumerate() {
                let f = tri_face[ti];
                let lt = [
                    emit(t[0], f, &mut verts),
                    emit(t[1], f, &mut verts),
                    emit(t[2], f, &mut verts),
                ];
                out.indices.extend(lt.map(|k| vbase + k));
            }
            for p in &body.positions {
                let p = DVec3::from(p.map(f64::from));
                lo = lo.min(p);
                hi = hi.max(p);
            }

            // Silhouette candidates: interior mesh edges within one face (vertex pairs used
            // by exactly two triangles of that face) whose facets are not coplanar.
            let mut half: Vec<(u32, u32, u32, u32)> = Vec::with_capacity(nt * 3);
            for (ti, t) in body.triangles.iter().enumerate() {
                for k in 0..3 {
                    let (a, b) = (t[k], t[(k + 1) % 3]);
                    let (a, b) = if a < b { (a, b) } else { (b, a) };
                    half.push((tri_face[ti], a, b, ti as u32));
                }
            }
            half.sort_unstable();
            let mut i = 0;
            while i < half.len() {
                let mut j = i + 1;
                while j < half.len()
                    && half[j].0 == half[i].0
                    && half[j].1 == half[i].1
                    && half[j].2 == half[i].2
                {
                    j += 1;
                }
                if j - i == 2 {
                    let (f, a, b, t0) = half[i];
                    let t1 = half[i + 1].3;
                    let tri = |t: u32| {
                        let t = body.triangles[t as usize];
                        facet_normal(
                            body.positions[t[0] as usize],
                            body.positions[t[1] as usize],
                            body.positions[t[2] as usize],
                        )
                    };
                    if let (Some(na), Some(nb)) = (tri(t0), tri(t1)) {
                        let d = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
                        if 1.0 - d > COPLANAR_EPS {
                            sils.vec3(body.positions[a as usize]);
                            sils.vec3(body.positions[b as usize]);
                            sils.vec3(na.map(|x| x as f32));
                            sils.vec3(nb.map(|x| x as f32));
                            sils.u32(face_base + f);
                            out.silhouette_count += 1;
                        }
                    }
                }
                i = j;
            }

            // Edge segments.
            for (ei, e) in body.edges.iter().enumerate() {
                if !e.points.iter().all(finite3) {
                    return Err(SceneError::NonFinite {
                        body: err_body(),
                        what: "edge point",
                    });
                }
                let gid = edge_base + ei as u32;
                for w in e.points.windows(2) {
                    // Exact duplicates only (bit patterns): nothing to draw.
                    if w[0].map(f32::to_bits) == w[1].map(f32::to_bits) {
                        continue;
                    }
                    edges.vec3(w[0]);
                    edges.vec3(w[1]);
                    edges.u32(gid);
                    edges.rgba8(EDGE_COLOR);
                    out.edge_segment_count += 1;
                }
                if e.points.len() == 1 {
                    // A lone point: draw it as a dot.
                    edges.vec3(e.points[0]);
                    edges.vec3(e.points[0]);
                    edges.u32(gid);
                    edges.rgba8(EDGE_COLOR);
                    out.edge_segment_count += 1;
                }
            }

            out.vertex_count += local_count;
            out.tables
                .face_body
                .extend(std::iter::repeat_n(bi as u32, face_names.len()));
            out.tables
                .edge_body
                .extend(std::iter::repeat_n(bi as u32, body.edges.len()));
            out.tables.by_name.entry(body.name.clone()).or_insert(bi);
            out.tables.bodies.push(BodyInfo {
                name: body.name.clone(),
                face_base,
                faces: face_names,
                edge_base,
                edges: body.edges.iter().map(|e| e.name.clone()).collect(),
                triangles: nt as u32,
                vertices: local_count,
            });
        }
        out.vertices = verts.0;
        out.edge_segments = edges.0;
        out.silhouettes = sils.0;
        out.bounds = (lo.x <= hi.x).then_some((lo, hi));
        Ok(out)
    }

    /// Number of triangles.
    pub fn triangle_count(&self) -> u32 {
        (self.indices.len() / 3) as u32
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unit cube with 6 named faces (per-face vertices) and 12 edges.
    pub(crate) fn cube(name: &str, size: f32) -> SceneBody {
        let s = size;
        type Quad<'a> = ([f32; 3], [[f32; 3]; 4], &'a str);
        let faces: [Quad<'_>; 6] = [
            (
                [0.0, 0.0, -1.0],
                [[0., 0., 0.], [0., s, 0.], [s, s, 0.], [s, 0., 0.]],
                "bottom",
            ),
            (
                [0.0, 0.0, 1.0],
                [[0., 0., s], [s, 0., s], [s, s, s], [0., s, s]],
                "top",
            ),
            (
                [0.0, -1.0, 0.0],
                [[0., 0., 0.], [s, 0., 0.], [s, 0., s], [0., 0., s]],
                "front",
            ),
            (
                [0.0, 1.0, 0.0],
                [[0., s, 0.], [0., s, s], [s, s, s], [s, s, 0.]],
                "back",
            ),
            (
                [-1.0, 0.0, 0.0],
                [[0., 0., 0.], [0., 0., s], [0., s, s], [0., s, 0.]],
                "left",
            ),
            (
                [1.0, 0.0, 0.0],
                [[s, 0., 0.], [s, s, 0.], [s, s, s], [s, 0., s]],
                "right",
            ),
        ];
        let mut b = SceneBody {
            name: name.to_string(),
            ..Default::default()
        };
        for (n, quad, fname) in faces {
            let base = b.positions.len() as u32;
            b.positions.extend(quad);
            b.normals.extend([n; 4]);
            let start = b.triangles.len() as u32;
            b.triangles.push([base, base + 1, base + 2]);
            b.triangles.push([base, base + 2, base + 3]);
            b.faces.push(SceneFace {
                name: fname.to_string(),
                tri_start: start,
                tri_count: 2,
            });
        }
        b.edges.push(SceneEdge {
            name: "e0".into(),
            points: vec![[0., 0., 0.], [s, 0., 0.]],
        });
        b.edges.push(SceneEdge {
            name: "ring".into(),
            points: vec![[0., 0., s], [s, 0., s], [s, s, s], [0., 0., s]],
        });
        b
    }

    #[test]
    fn packs_vertices_indices_and_tables() {
        let a = cube("a", 10.0);
        let b = cube("b", 5.0);
        let d = SceneData::build(&[a, b]).expect("valid");
        assert_eq!(d.vertex_count, 48);
        assert_eq!(d.vertices.len() as u64, 48 * FACE_VERTEX_STRIDE);
        assert_eq!(d.triangle_count(), 24);
        // Second body's indices are rebased.
        assert!(d.indices[36..].iter().all(|&i| (24..48).contains(&i)));
        assert_eq!(d.tables.face_count(), 12);
        assert_eq!(d.tables.edge_count(), 4);
        assert_eq!(d.tables.face(7), Some((1, 1, "top")));
        assert_eq!(d.tables.edge(3), Some((1, 1, "ring")));
        assert_eq!(d.tables.face_by_name("b", "top"), Some(EntityRef::Face(7)));
        assert_eq!(d.tables.edge_by_name("a", "ring"), Some(EntityRef::Edge(1)));
        assert_eq!(d.tables.face_by_name("c", "top"), None);
        assert_eq!(d.tables.face_by_index(1, 5), Some(EntityRef::Face(11)));
        assert_eq!(d.tables.face_by_index(1, 6), None);
        // e0: 1 segment; ring: 3 segments; ×2 bodies.
        assert_eq!(d.edge_segment_count, 8);
        assert_eq!(d.edge_segments.len() as u64, 8 * LINE_INSTANCE_STRIDE);
        // A planar-faced cube has no silhouette candidates.
        assert_eq!(d.silhouette_count, 0);
        let (lo, hi) = d.bounds.expect("bounds");
        assert_eq!(lo, DVec3::ZERO);
        assert_eq!(hi, DVec3::splat(10.0));
        // Face ids in the vertex stream: bytes 24..28 of vertex k.
        let face_of = |k: usize| {
            let o = k * FACE_VERTEX_STRIDE as usize + 24;
            u32::from_le_bytes(d.vertices[o..o + 4].try_into().expect("4 bytes"))
        };
        assert_eq!(face_of(0), 0);
        assert_eq!(face_of(47), 11);
    }

    #[test]
    fn shared_vertices_are_split_per_face() {
        // Two triangles sharing an edge but belonging to two faces.
        let b = SceneBody {
            name: "x".into(),
            positions: vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [1., 1., 1.]],
            normals: vec![[0., 0., 1.]; 4],
            triangles: vec![[0, 1, 2], [1, 3, 2]],
            faces: vec![
                SceneFace {
                    name: "f0".into(),
                    tri_start: 0,
                    tri_count: 1,
                },
                SceneFace {
                    name: "f1".into(),
                    tri_start: 1,
                    tri_count: 1,
                },
            ],
            ..Default::default()
        };
        let d = SceneData::build(&[b]).expect("valid");
        assert_eq!(
            d.vertex_count, 6,
            "f1 gets copies of vertices 1 and 2 plus vertex 3"
        );
    }

    #[test]
    fn silhouette_candidates_are_interior_non_coplanar_edges() {
        // A "roof" face: two triangles meeting at a ridge, inside one face.
        let b = SceneBody {
            name: "roof".into(),
            positions: vec![
                [0., 0., 0.],
                [1., 0., 0.],
                [0.5, 0.5, 0.5],
                [0.5, -0.5, 0.5],
            ],
            normals: vec![[0., 0., 1.]; 4],
            triangles: vec![[0, 1, 2], [1, 0, 3]],
            faces: vec![SceneFace {
                name: "f".into(),
                tri_start: 0,
                tri_count: 2,
            }],
            ..Default::default()
        };
        let d = SceneData::build(&[b]).expect("valid");
        assert_eq!(d.silhouette_count, 1);
        assert_eq!(d.silhouettes.len() as u64, SILHOUETTE_INSTANCE_STRIDE);
    }

    #[test]
    fn uncovered_triangles_get_an_unassigned_face() {
        let mut b = cube("a", 1.0);
        b.faces.pop();
        let d = SceneData::build(&[b]).expect("valid");
        assert_eq!(
            d.tables.bodies[0].faces.last().map(String::as_str),
            Some(UNASSIGNED_FACE)
        );
        assert_eq!(d.tables.face_count(), 6);
    }

    #[test]
    fn invalid_input_is_rejected_with_codes() {
        let mut b = cube("a", 1.0);
        b.triangles[3][1] = 99;
        assert_eq!(
            SceneData::build(&[b]).unwrap_err().code(),
            "RENDER_INDEX_OUT_OF_RANGE"
        );
        let mut b = cube("a", 1.0);
        b.normals.pop();
        assert_eq!(
            SceneData::build(&[b]).unwrap_err().code(),
            "RENDER_NORMAL_COUNT"
        );
        let mut b = cube("a", 1.0);
        b.faces[1].tri_start = 0;
        assert_eq!(
            SceneData::build(&[b]).unwrap_err().code(),
            "RENDER_BAD_FACE_RANGE"
        );
        let mut b = cube("a", 1.0);
        b.faces[5].tri_count = 3;
        assert_eq!(
            SceneData::build(&[b]).unwrap_err().code(),
            "RENDER_BAD_FACE_RANGE"
        );
        let mut b = cube("a", 1.0);
        b.positions[0][0] = f32::NAN;
        assert_eq!(
            SceneData::build(&[b]).unwrap_err().code(),
            "RENDER_NON_FINITE"
        );
    }

    #[test]
    fn packing_is_deterministic() {
        let a = SceneData::build(&[cube("a", 3.0), cube("b", 2.0)]).expect("valid");
        let b = SceneData::build(&[cube("a", 3.0), cube("b", 2.0)]).expect("valid");
        assert_eq!(a.vertices, b.vertices);
        assert_eq!(a.indices, b.indices);
        assert_eq!(a.edge_segments, b.edge_segments);
    }

    #[test]
    fn empty_scene_has_no_bounds() {
        let d = SceneData::build(&[]).expect("valid");
        assert!(d.bounds.is_none());
        assert_eq!(d.vertex_count, 0);
    }
}
