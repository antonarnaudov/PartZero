//! B-rep entities and the [`Body`] that owns them.

use smallvec::SmallVec;

use super::Provenance;
use crate::arena::{Arena, Id};
use crate::geom::{Curve2, Curve3, Surface};
use crate::linalg::Point3;

/// Id of a [`Shell`] within its [`Body`].
pub type ShellId = Id<Shell>;
/// Id of a [`Face`] within its [`Body`].
pub type FaceId = Id<Face>;
/// Id of a [`Loop`] within its [`Body`].
pub type LoopId = Id<Loop>;
/// Id of a [`Coedge`] within its [`Body`].
pub type CoedgeId = Id<Coedge>;
/// Id of an [`Edge`] within its [`Body`].
pub type EdgeId = Id<Edge>;
/// Id of a [`Vertex`] within its [`Body`].
pub type VertexId = Id<Vertex>;

/// A connected set of faces. A **closed** shell bounds a volume: every edge is used by
/// exactly two coedges, in opposite directions.
#[derive(Clone, Debug, PartialEq)]
pub struct Shell {
    /// Faces, in creation order.
    pub faces: Vec<FaceId>,
    /// Whether the shell is declared closed (a solid boundary) rather than a sheet.
    pub closed: bool,
}

/// A bounded region of a surface.
///
/// The face's **outward normal** is the surface normal when `sense` is true, and its
/// negation otherwise. Loops are oriented so that, walking along a loop and looking
/// against the outward normal, the face is on the left: the outer loop runs
/// counter-clockwise, inner loops (holes) clockwise.
///
/// A face with **no loops** covers its whole surface, which must then be closed and
/// bounded (sphere, torus).
#[derive(Clone, Debug, PartialEq)]
pub struct Face {
    /// Carried surface (owned; see the `topo` module docs).
    pub surface: Surface,
    /// `true` if the outward normal equals the surface normal.
    pub sense: bool,
    /// Boundary loops; the first is the outer loop. Periodic faces bounded by two rings
    /// (e.g. a cylinder side) list both; the first is by convention the "outer" one.
    pub loops: Vec<LoopId>,
    /// Owning shell.
    pub shell: ShellId,
    /// Where the face came from.
    pub provenance: Provenance,
}

/// A closed, ordered cycle of coedges bounding a face.
///
/// Consecutive coedges share a vertex (the end of one is the start of the next,
/// cyclically). A **ring loop** consists of exactly one coedge on a ring edge.
#[derive(Clone, Debug, PartialEq)]
pub struct Loop {
    /// Coedges in traversal order.
    pub coedges: Vec<CoedgeId>,
    /// Owning face.
    pub face: FaceId,
}

/// The use of an edge by a loop (a half-edge).
///
/// A forward coedge traverses its edge's curve from `t_range.0` to `t_range.1`; a
/// reversed one from `t_range.1` to `t_range.0`.
#[derive(Clone, Debug, PartialEq)]
pub struct Coedge {
    /// The edge being used.
    pub edge: EdgeId,
    /// `true` if the coedge follows the edge's curve direction.
    pub forward: bool,
    /// Optional image of the edge in the face's `(u, v)` space, parametrized by the
    /// **same parameter** as the edge curve (`S(pcurve(t)) ≈ C(t)` over `t_range`).
    /// Values may lie outside the canonical period of a periodic surface.
    pub pcurve: Option<Curve2>,
    /// Owning loop.
    pub loop_id: LoopId,
}

/// A bounded piece of a curve where faces meet.
///
/// Either both vertices are set (an open edge from `start` to `end`, possibly the same
/// vertex for a closed curve), or neither is (a **ring edge**: a closed curve used over
/// its full period, such as the circles of an extruded cylinder).
#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    /// Carried curve (owned).
    pub curve: Curve3,
    /// Parameter range `(t0, t1)`, `t0 < t1`, in the curve's parametrization.
    pub t_range: (f64, f64),
    /// Vertex at `t0` (`None` for ring edges).
    pub start: Option<VertexId>,
    /// Vertex at `t1` (`None` for ring edges).
    pub end: Option<VertexId>,
    /// Geometric tolerance (mm): the curve lies within this distance of every adjacent
    /// face surface.
    pub tolerance: f64,
    /// Coedges using this edge (maintained by the builder).
    pub coedges: SmallVec<[CoedgeId; 2]>,
    /// Where the edge came from.
    pub provenance: Provenance,
}

impl Edge {
    /// `true` for a ring edge (no vertices).
    pub fn is_ring(&self) -> bool {
        self.start.is_none() && self.end.is_none()
    }
}

/// A point where edges meet.
#[derive(Clone, Debug, PartialEq)]
pub struct Vertex {
    /// Position.
    pub point: Point3,
    /// Geometric tolerance (mm): the ends of incident edge curves lie within this
    /// distance of `point`.
    pub tolerance: f64,
    /// Where the vertex came from.
    pub provenance: Provenance,
}

/// Entity counts of a body.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TopoCounts {
    /// Shells.
    pub shells: usize,
    /// Faces.
    pub faces: usize,
    /// Loops.
    pub loops: usize,
    /// Coedges.
    pub coedges: usize,
    /// Edges (Forge has no seam or degenerate edges, so all are counted).
    pub edges: usize,
    /// Vertices.
    pub vertices: usize,
}

/// A solid or sheet body: a self-contained B-rep that owns all of its entities in
/// arenas.
///
/// Ids are scoped to one body. Bodies are immutable once built; create and edit them with
/// [`super::BodyBuilder`] (use [`super::BodyBuilder::from_body`] to continue editing).
#[derive(Clone, Debug, Default)]
pub struct Body {
    pub(crate) shells: Vec<ShellId>,
    pub(crate) shell_arena: Arena<Shell>,
    pub(crate) faces: Arena<Face>,
    pub(crate) loops: Arena<Loop>,
    pub(crate) coedges: Arena<Coedge>,
    pub(crate) edges: Arena<Edge>,
    pub(crate) vertices: Arena<Vertex>,
}

impl Body {
    /// The body's shells, in creation order.
    pub fn shell_ids(&self) -> &[ShellId] {
        &self.shells
    }
    /// Shell arena.
    pub fn shells(&self) -> &Arena<Shell> {
        &self.shell_arena
    }
    /// Face arena.
    pub fn faces(&self) -> &Arena<Face> {
        &self.faces
    }
    /// Loop arena.
    pub fn loops(&self) -> &Arena<Loop> {
        &self.loops
    }
    /// Coedge arena.
    pub fn coedges(&self) -> &Arena<Coedge> {
        &self.coedges
    }
    /// Edge arena.
    pub fn edges(&self) -> &Arena<Edge> {
        &self.edges
    }
    /// Vertex arena.
    pub fn vertices(&self) -> &Arena<Vertex> {
        &self.vertices
    }
    /// A shell, if the id is live.
    pub fn shell(&self, id: ShellId) -> Option<&Shell> {
        self.shell_arena.get(id)
    }
    /// A face, if the id is live.
    pub fn face(&self, id: FaceId) -> Option<&Face> {
        self.faces.get(id)
    }
    /// A loop, if the id is live (named `loop_` because `loop` is a keyword).
    pub fn loop_(&self, id: LoopId) -> Option<&Loop> {
        self.loops.get(id)
    }
    /// A coedge, if the id is live.
    pub fn coedge(&self, id: CoedgeId) -> Option<&Coedge> {
        self.coedges.get(id)
    }
    /// An edge, if the id is live.
    pub fn edge(&self, id: EdgeId) -> Option<&Edge> {
        self.edges.get(id)
    }
    /// A vertex, if the id is live.
    pub fn vertex(&self, id: VertexId) -> Option<&Vertex> {
        self.vertices.get(id)
    }
    /// Entity counts.
    pub fn counts(&self) -> TopoCounts {
        TopoCounts {
            shells: self.shell_arena.len(),
            faces: self.faces.len(),
            loops: self.loops.len(),
            coedges: self.coedges.len(),
            edges: self.edges.len(),
            vertices: self.vertices.len(),
        }
    }
    /// The vertex where a coedge starts (in its traversal direction); `None` for ring
    /// coedges or stale ids.
    pub fn coedge_start(&self, id: CoedgeId) -> Option<VertexId> {
        let c = self.coedges.get(id)?;
        let e = self.edges.get(c.edge)?;
        if c.forward { e.start } else { e.end }
    }
    /// The vertex where a coedge ends (in its traversal direction); `None` for ring
    /// coedges or stale ids.
    pub fn coedge_end(&self, id: CoedgeId) -> Option<VertexId> {
        let c = self.coedges.get(id)?;
        let e = self.edges.get(c.edge)?;
        if c.forward { e.end } else { e.start }
    }
    /// The distinct edges bounding a face, in loop order of first use.
    pub fn face_edges(&self, id: FaceId) -> Vec<EdgeId> {
        let mut out: Vec<EdgeId> = Vec::new();
        if let Some(f) = self.faces.get(id) {
            for c in f
                .loops
                .iter()
                .filter_map(|l| self.loops.get(*l))
                .flat_map(|l| l.coedges.iter())
            {
                if let Some(c) = self.coedges.get(*c)
                    && !out.contains(&c.edge)
                {
                    out.push(c.edge);
                }
            }
        }
        out
    }
    /// The faces adjacent to an edge (through its coedges), in coedge order.
    pub fn edge_faces(&self, id: EdgeId) -> Vec<FaceId> {
        let mut out = Vec::new();
        if let Some(e) = self.edges.get(id) {
            for c in &e.coedges {
                if let Some(f) = self
                    .coedges
                    .get(*c)
                    .and_then(|c| self.loops.get(c.loop_id))
                    .map(|l| l.face)
                    && !out.contains(&f)
                {
                    out.push(f);
                }
            }
        }
        out
    }
}
