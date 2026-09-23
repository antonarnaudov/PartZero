//! Mesh data produced by tessellation.

/// Tessellation tolerances.
///
/// - `chordal_deflection` (mm): maximum distance between the mesh and the exact surface
///   (and between each boundary chord and its edge curve). Must be at least
///   [`TessParams::MIN_CHORDAL_DEFLECTION`], ten times the IR's linear modelling
///   tolerance: the geometry itself is only accurate to that tolerance.
/// - `angular_deflection_rad`: maximum angle between the surface normals at the two
///   ends of any mesh edge (and between the tangents at the ends of an edge chord), in
///   `(0, π]`.
/// - `max_edge_length` (mm): optional upper bound on every mesh edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TessParams {
    /// Maximum chordal deviation (mm).
    pub chordal_deflection: f64,
    /// Maximum normal deviation along a mesh edge (radians).
    pub angular_deflection_rad: f64,
    /// Optional maximum mesh edge length (mm).
    pub max_edge_length: Option<f64>,
}

impl TessParams {
    /// Smallest accepted chordal deflection (mm).
    pub const MIN_CHORDAL_DEFLECTION: f64 = 1e-5;

    /// Parameters with the given chordal and angular deflection and no length limit.
    pub fn new(chordal_deflection: f64, angular_deflection_rad: f64) -> Self {
        Self {
            chordal_deflection,
            angular_deflection_rad,
            max_edge_length: None,
        }
    }

    /// The same parameters with a maximum edge length.
    pub fn with_max_edge_length(mut self, max_edge_length: f64) -> Self {
        self.max_edge_length = Some(max_edge_length);
        self
    }

    /// Check the ranges documented on the type.
    pub fn validate(&self) -> Result<(), crate::MeshError> {
        use crate::MeshError::InvalidParams;
        let d = self.chordal_deflection;
        if !(d.is_finite() && d >= Self::MIN_CHORDAL_DEFLECTION) {
            return Err(InvalidParams {
                what: "chordal_deflection",
                value: d,
                expected: "finite and >= 1e-5 mm",
            });
        }
        let a = self.angular_deflection_rad;
        if !(a > 0.0 && a <= forge_core::math::PI) {
            return Err(InvalidParams {
                what: "angular_deflection_rad",
                value: a,
                expected: "in (0, π]",
            });
        }
        if let Some(l) = self.max_edge_length
            && !(l.is_finite() && l > 0.0)
        {
            return Err(InvalidParams {
                what: "max_edge_length",
                value: l,
                expected: "finite and > 0",
            });
        }
        Ok(())
    }
}

impl Default for TessParams {
    /// 0.05 mm chordal, 0.35 rad (≈ 20°) angular, no length limit.
    fn default() -> Self {
        Self::new(0.05, 0.35)
    }
}

/// The triangles of one B-rep face within [`BodyMesh::triangles`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaceRange {
    /// The face's canonical provenance name.
    pub face_name: String,
    /// Index of the face's first triangle.
    pub tri_start: u32,
    /// Number of triangles of the face.
    pub tri_count: u32,
}

/// The discretization of one B-rep edge (the exact vertices the faces use).
#[derive(Clone, Debug, PartialEq)]
pub struct EdgePolyline {
    /// The edge's canonical provenance name.
    pub edge_name: String,
    /// Points from the edge's start to its end (for a ring edge the first point is
    /// repeated at the end, so the polyline is closed).
    pub points: Vec<[f64; 3]>,
}

/// A watertight triangle mesh of a body.
///
/// - **Shared vertices.** Every B-rep vertex and every edge sample appears exactly once
///   in `positions` and is referenced by the triangles of *all* adjacent faces, so each
///   mesh edge of a closed body is used by exactly two triangles
///   ([`crate::check_watertight`]). No seam vertices are duplicated.
/// - **Orientation.** Triangles are counter-clockwise seen from outside (right-hand
///   normal = the face's outward normal).
/// - **Normals** (one per position, unit, `f32`): for vertices inside a face, the exact
///   outward surface normal; at singular points the limit normal (sphere pole: the axis;
///   cone apex: the mean of the limit normals around it, i.e. the axis direction); for
///   vertices on edges, the normalized sum of the adjacent faces' outward normals there.
///   Use [`crate::tessellate_render`] for per-face (creased) normals.
/// - **Order.** Positions: B-rep vertices (arena order), edge samples (edge order), then
///   per face its interior/cut/singular points. Triangles are grouped by face in face
///   order ([`BodyMesh::face_ranges`]). The whole structure is deterministic.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BodyMesh {
    /// Vertex positions (mm).
    pub positions: Vec<[f64; 3]>,
    /// Unit vertex normals (see the type docs).
    pub normals: Vec<[f32; 3]>,
    /// Triangles (indices into `positions`), counter-clockwise from outside.
    pub triangles: Vec<[u32; 3]>,
    /// Per-face triangle ranges, in face order.
    pub face_ranges: Vec<FaceRange>,
    /// Per-edge polylines, in edge order.
    pub edge_polylines: Vec<EdgePolyline>,
}

impl BodyMesh {
    /// Positions converted to `f32` (for GPU upload).
    pub fn to_f32_positions(&self) -> Vec<[f32; 3]> {
        self.positions
            .iter()
            .map(|p| [p[0] as f32, p[1] as f32, p[2] as f32])
            .collect()
    }

    /// The triangles of face range `i`.
    pub fn face_triangles(&self, i: usize) -> &[[u32; 3]] {
        let r = &self.face_ranges[i];
        let s = r.tri_start as usize;
        &self.triangles[s..s + r.tri_count as usize]
    }

    /// Number of triangles.
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }

    /// Number of vertices.
    pub fn vertex_count(&self) -> usize {
        self.positions.len()
    }
}

/// A render-ready mesh: vertices are split per face (each face has its own copies of its
/// boundary vertices) so every vertex carries its face's exact outward normal — creases
/// stay sharp and cone apexes get per-triangle limit normals. Positions are
/// bit-identical to the corresponding [`BodyMesh`] positions (converted to `f32`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RenderMesh {
    /// Positions (`f32`).
    pub positions: Vec<[f32; 3]>,
    /// Unit outward normals (`f32`).
    pub normals: Vec<[f32; 3]>,
    /// Triangles, counter-clockwise from outside.
    pub triangles: Vec<[u32; 3]>,
    /// Per-face triangle ranges, in face order.
    pub face_ranges: Vec<FaceRange>,
    /// Per-edge polylines, in edge order — the same discretization as
    /// [`BodyMesh::edge_polylines`], so every polyline point coincides (after conversion to
    /// `f32`) with a boundary vertex of each adjacent face.
    pub edge_polylines: Vec<EdgePolyline>,
}
