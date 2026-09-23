//! Mesh validation helpers: watertightness, deviation from the exact geometry, volume.

use forge_core::Vec3;
use forge_core::topo::Body;

use crate::error::MeshError;
use crate::mesh::BodyMesh;

/// What [`check_watertight`] found wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WatertightIssue {
    /// A triangle references a vertex index out of range.
    IndexOutOfRange,
    /// A triangle repeats a vertex.
    DegenerateTriangle,
    /// An undirected edge is used by only one triangle (a hole or crack).
    BoundaryEdge,
    /// An undirected edge is used by more than two triangles.
    NonManifoldEdge,
    /// The two triangles of an edge traverse it in the same direction.
    InconsistentOrientation,
}

impl WatertightIssue {
    /// Stable machine-readable code.
    pub fn code(self) -> &'static str {
        match self {
            WatertightIssue::IndexOutOfRange => "MESH_INDEX_OUT_OF_RANGE",
            WatertightIssue::DegenerateTriangle => "MESH_DEGENERATE_TRIANGLE",
            WatertightIssue::BoundaryEdge => "MESH_BOUNDARY_EDGE",
            WatertightIssue::NonManifoldEdge => "MESH_NON_MANIFOLD_EDGE",
            WatertightIssue::InconsistentOrientation => "MESH_INCONSISTENT_ORIENTATION",
        }
    }
}

/// A failed watertightness check: the first offending element plus totals.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WatertightError {
    /// The first issue found (in sorted edge order).
    pub issue: WatertightIssue,
    /// The offending edge's vertices (or the triangle's first two vertices).
    pub edge: [u32; 2],
    /// Number of triangles using that edge.
    pub uses: usize,
    /// Total edges used once.
    pub boundary_edges: usize,
    /// Total edges used more than twice.
    pub nonmanifold_edges: usize,
    /// Total edges used twice in the same direction.
    pub misoriented_edges: usize,
}

impl core::fmt::Display for WatertightError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "[{}] edge {:?} used {} times ({} boundary, {} non-manifold, {} misoriented edges)",
            self.issue.code(),
            self.edge,
            self.uses,
            self.boundary_edges,
            self.nonmanifold_edges,
            self.misoriented_edges
        )
    }
}

impl std::error::Error for WatertightError {}

/// Topological summary of a watertight mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WatertightStats {
    /// Vertices referenced by triangles.
    pub vertices: usize,
    /// Undirected edges.
    pub edges: usize,
    /// Triangles.
    pub triangles: usize,
    /// Euler characteristic `V − E + F` (2 per sphere-like closed component, 0 for a
    /// torus, …).
    pub euler_characteristic: i64,
}

/// Check that the mesh is a closed, consistently oriented 2-manifold at its edges: every
/// undirected edge is used by exactly two triangles, in opposite directions, and no
/// triangle is degenerate (repeated index).
pub fn check_watertight(mesh: &BodyMesh) -> Result<WatertightStats, WatertightError> {
    let nv = mesh.positions.len() as u64;
    let mut dir_edges: Vec<(u32, u32, bool)> = Vec::with_capacity(mesh.triangles.len() * 3);
    let mut used = vec![false; mesh.positions.len()];
    for t in &mesh.triangles {
        if t.iter().any(|&i| u64::from(i) >= nv) {
            return Err(WatertightError {
                issue: WatertightIssue::IndexOutOfRange,
                edge: [t[0], t[1]],
                uses: 0,
                boundary_edges: 0,
                nonmanifold_edges: 0,
                misoriented_edges: 0,
            });
        }
        if t[0] == t[1] || t[1] == t[2] || t[0] == t[2] {
            return Err(WatertightError {
                issue: WatertightIssue::DegenerateTriangle,
                edge: [t[0], t[1]],
                uses: 0,
                boundary_edges: 0,
                nonmanifold_edges: 0,
                misoriented_edges: 0,
            });
        }
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            used[a as usize] = true;
            dir_edges.push((a.min(b), a.max(b), a < b));
        }
    }
    dir_edges.sort_unstable();
    let (mut boundary, mut nonmanifold, mut misoriented) = (0usize, 0usize, 0usize);
    let mut first: Option<(WatertightIssue, [u32; 2], usize)> = None;
    let mut edges = 0usize;
    let mut i = 0;
    while i < dir_edges.len() {
        let (a, b, _) = dir_edges[i];
        let mut j = i;
        while j < dir_edges.len() && dir_edges[j].0 == a && dir_edges[j].1 == b {
            j += 1;
        }
        edges += 1;
        let uses = j - i;
        let issue = match uses {
            1 => {
                boundary += 1;
                Some(WatertightIssue::BoundaryEdge)
            }
            2 if dir_edges[i].2 == dir_edges[i + 1].2 => {
                misoriented += 1;
                Some(WatertightIssue::InconsistentOrientation)
            }
            2 => None,
            _ => {
                nonmanifold += 1;
                Some(WatertightIssue::NonManifoldEdge)
            }
        };
        if let Some(is) = issue
            && first.is_none()
        {
            first = Some((is, [a, b], uses));
        }
        i = j;
    }
    if let Some((issue, edge, uses)) = first {
        return Err(WatertightError {
            issue,
            edge,
            uses,
            boundary_edges: boundary,
            nonmanifold_edges: nonmanifold,
            misoriented_edges: misoriented,
        });
    }
    let vertices = used.iter().filter(|u| **u).count();
    Ok(WatertightStats {
        vertices,
        edges,
        triangles: mesh.triangles.len(),
        euler_characteristic: vertices as i64 - edges as i64 + mesh.triangles.len() as i64,
    })
}

/// Barycentric sample points used by [`max_deviation`] inside every triangle.
const DEVIATION_SAMPLES: [[f64; 3]; 13] = [
    [1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
    [0.5, 0.5, 0.0],
    [0.0, 0.5, 0.5],
    [0.5, 0.0, 0.5],
    [2.0 / 3.0, 1.0 / 6.0, 1.0 / 6.0],
    [1.0 / 6.0, 2.0 / 3.0, 1.0 / 6.0],
    [1.0 / 6.0, 1.0 / 6.0, 2.0 / 3.0],
    [0.25, 0.25, 0.5],
    [0.25, 0.5, 0.25],
    [0.5, 0.25, 0.25],
    [0.75, 0.25, 0.0],
    [0.0, 0.75, 0.25],
    [0.25, 0.0, 0.75],
];

/// Largest distance from sampled points of every triangle (13 barycentric samples:
/// centroid, edge midpoints and interior points) to the exact surface of the face the
/// triangle belongs to (via `Surface::project`).
///
/// Face ranges are matched to the body's faces in face order and checked by name.
pub fn max_deviation(body: &Body, mesh: &BodyMesh) -> Result<f64, MeshError> {
    let faces: Vec<_> = body.faces().values().collect();
    if faces.len() != mesh.face_ranges.len() {
        return Err(MeshError::InvalidBody {
            detail: format!(
                "mesh has {} face ranges, body has {} faces",
                mesh.face_ranges.len(),
                faces.len()
            ),
        });
    }
    let mut worst = 0.0f64;
    for (i, (face, range)) in faces.iter().zip(&mesh.face_ranges).enumerate() {
        if face.provenance.name() != range.face_name {
            return Err(MeshError::InvalidBody {
                detail: format!(
                    "face range {i} is {}, expected {}",
                    range.face_name,
                    face.provenance.name()
                ),
            });
        }
        for t in mesh.face_triangles(i) {
            let p = t.map(|k| Vec3::from(mesh.positions[k as usize]));
            for w in DEVIATION_SAMPLES {
                let q = p[0] * w[0] + p[1] * w[1] + p[2] * w[2];
                let (_, _, d) = face.surface.project(q);
                if !d.is_finite() {
                    return Err(MeshError::NonFinite {
                        entity: range.face_name.clone(),
                    });
                }
                worst = worst.max(d);
            }
        }
    }
    Ok(worst)
}

/// Signed enclosed volume (mm³) by the divergence theorem, summed in triangle order
/// (deterministic). Positive for a closed mesh oriented outward.
pub fn mesh_volume(mesh: &BodyMesh) -> f64 {
    let mut v = 0.0;
    for t in &mesh.triangles {
        let [a, b, c] = t.map(|k| Vec3::from(mesh.positions[k as usize]));
        v += a.dot(b.cross(c));
    }
    v / 6.0
}

/// Total triangle area (mm²), summed in triangle order.
pub fn mesh_area(mesh: &BodyMesh) -> f64 {
    let mut s = 0.0;
    for t in &mesh.triangles {
        let [a, b, c] = t.map(|k| Vec3::from(mesh.positions[k as usize]));
        s += (b - a).cross(c - a).norm();
    }
    0.5 * s
}
