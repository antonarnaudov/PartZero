//! Safe construction of bodies.

use smallvec::SmallVec;
use thiserror::Error;

use super::Provenance;
use super::entities::{
    Body, Coedge, CoedgeId, Edge, EdgeId, Face, FaceId, Loop, LoopId, Shell, ShellId, Vertex,
    VertexId,
};
use super::validate::{TopoIssue, has_errors, validate};
use crate::geom::{Curve2, Curve3, Surface};
use crate::linalg::Point3;
use crate::tolerance::{Tolerance, is_within};

/// A construction step was rejected. Every variant has a stable [`TopoError::code`] and
/// the ids involved (printed like `Edge#3v0`).
#[derive(Debug, Clone, PartialEq, Error)]
pub enum TopoError {
    /// An id does not refer to a live entity of this body.
    #[error("invalid {kind} id {id}")]
    InvalidId {
        /// Entity kind (`"vertex"`, `"edge"`, …).
        kind: &'static str,
        /// The id, formatted.
        id: String,
    },
    /// A point or parameter is NaN or infinite.
    #[error("non-finite {what}")]
    NonFinite {
        /// What was non-finite.
        what: &'static str,
    },
    /// An edge parameter range is empty or reversed.
    #[error("invalid edge parameter range ({t0}, {t1}): need t0 < t1")]
    InvalidRange {
        /// Range start.
        t0: f64,
        /// Range end.
        t1: f64,
    },
    /// A vertex is farther from the edge curve's end than the allowed tolerance.
    #[error("vertex {vertex} is {distance:e} from the curve end (tolerance {tolerance:e})")]
    VertexOffCurve {
        /// The vertex, formatted.
        vertex: String,
        /// Measured distance.
        distance: f64,
        /// Allowed distance.
        tolerance: f64,
    },
    /// A ring edge needs a closed curve (periodic, or a closed B-spline).
    #[error("ring edge curve ({kind}) is not closed within tolerance")]
    RingCurveNotClosed {
        /// Curve kind name.
        kind: &'static str,
    },
    /// A loop must have at least one coedge.
    #[error("empty loop")]
    EmptyLoop,
    /// A ring edge must be the only coedge of its loop.
    #[error("ring edge {edge} used in a loop with {count} coedges")]
    RingEdgeInMultiLoop {
        /// The ring edge, formatted.
        edge: String,
        /// Number of coedges in the loop.
        count: usize,
    },
    /// Consecutive coedges do not share a vertex.
    #[error("loop is not closed between coedge {at} and the next one")]
    LoopNotClosed {
        /// Index (in the loop) of the coedge whose end does not match the next start.
        at: usize,
    },
    /// A tolerance value is negative or non-finite.
    #[error("invalid tolerance {value}")]
    InvalidTolerance {
        /// The rejected value.
        value: f64,
    },
}

impl TopoError {
    /// Stable machine-readable error code.
    pub fn code(&self) -> &'static str {
        match self {
            TopoError::InvalidId { .. } => "TOPO_INVALID_ID",
            TopoError::NonFinite { .. } => "TOPO_NON_FINITE",
            TopoError::InvalidRange { .. } => "TOPO_INVALID_RANGE",
            TopoError::VertexOffCurve { .. } => "TOPO_VERTEX_OFF_CURVE",
            TopoError::RingCurveNotClosed { .. } => "TOPO_RING_CURVE_NOT_CLOSED",
            TopoError::EmptyLoop => "TOPO_EMPTY_LOOP",
            TopoError::RingEdgeInMultiLoop { .. } => "TOPO_RING_EDGE_IN_MULTI_LOOP",
            TopoError::LoopNotClosed { .. } => "TOPO_LOOP_NOT_CLOSED",
            TopoError::InvalidTolerance { .. } => "TOPO_INVALID_TOLERANCE",
        }
    }
}

fn invalid<T>(kind: &'static str, id: crate::arena::Id<T>) -> TopoError {
    TopoError::InvalidId {
        kind,
        id: format!("{id:?}"),
    }
}

/// Builds a [`Body`] entity by entity, checking every reference and local invariant as it
/// goes (ids exist, vertices lie on curve ends, loops close, ring edges are closed).
/// Global invariants (edge use counts, Euler–Poincaré, geometry on surfaces) are checked
/// by [`validate`]; [`BodyBuilder::finish_validated`] runs it.
///
/// ```
/// use forge_core::topo::{BodyBuilder, Provenance};
/// use forge_core::geom::{Circle3, Plane, Sphere, Surface};
/// use forge_core::linalg::Frame;
///
/// let mut b = BodyBuilder::new();
/// let shell = b.add_shell(true);
/// let sphere = Sphere::new(Frame::world(), 5.0).unwrap();
/// b.add_face(shell, Surface::Sphere(sphere), true, Provenance::side("ball", "arc")).unwrap();
/// let body = b.finish_validated().unwrap();
/// assert_eq!(body.counts().faces, 1);
/// ```
#[derive(Clone, Debug)]
pub struct BodyBuilder {
    body: Body,
    tolerance: Tolerance,
}

impl Default for BodyBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl BodyBuilder {
    /// A builder for an empty body with [`Tolerance::IR_DEFAULT`].
    pub fn new() -> Self {
        Self::with_tolerance(Tolerance::IR_DEFAULT)
    }
    /// A builder whose new vertices and edges get `tolerance.linear`.
    pub fn with_tolerance(tolerance: Tolerance) -> Self {
        Self {
            body: Body::default(),
            tolerance,
        }
    }
    /// Continue editing an existing body.
    pub fn from_body(body: Body, tolerance: Tolerance) -> Self {
        Self { body, tolerance }
    }
    /// The body built so far.
    pub fn body(&self) -> &Body {
        &self.body
    }

    /// Add a vertex with the default linear tolerance.
    pub fn add_vertex(
        &mut self,
        point: Point3,
        provenance: Provenance,
    ) -> Result<VertexId, TopoError> {
        if !point.is_finite() {
            return Err(TopoError::NonFinite {
                what: "vertex point",
            });
        }
        Ok(self.body.vertices.insert(Vertex {
            point,
            tolerance: self.tolerance.linear,
            provenance,
        }))
    }

    fn check_range(t_range: (f64, f64)) -> Result<(), TopoError> {
        let (t0, t1) = t_range;
        if !(t0.is_finite() && t1.is_finite()) {
            return Err(TopoError::NonFinite {
                what: "edge parameter range",
            });
        }
        if t0 >= t1 {
            return Err(TopoError::InvalidRange { t0, t1 });
        }
        Ok(())
    }

    /// Add an open edge on `curve` over `t_range`, from vertex `start` (at `t0`) to `end`
    /// (at `t1`). The vertices must lie on the curve ends within
    /// `max(vertex tolerance, edge tolerance)`.
    pub fn add_edge(
        &mut self,
        curve: Curve3,
        t_range: (f64, f64),
        start: VertexId,
        end: VertexId,
        provenance: Provenance,
    ) -> Result<EdgeId, TopoError> {
        Self::check_range(t_range)?;
        for (vid, t) in [(start, t_range.0), (end, t_range.1)] {
            let v = self
                .body
                .vertices
                .get(vid)
                .ok_or_else(|| invalid("vertex", vid))?;
            let d = curve.eval(t).distance(v.point);
            let tol = v.tolerance.max(self.tolerance.linear);
            if !is_within(d, tol) {
                return Err(TopoError::VertexOffCurve {
                    vertex: format!("{vid:?}"),
                    distance: d,
                    tolerance: tol,
                });
            }
        }
        Ok(self.body.edges.insert(Edge {
            curve,
            t_range,
            start: Some(start),
            end: Some(end),
            tolerance: self.tolerance.linear,
            coedges: SmallVec::new(),
            provenance,
        }))
    }

    /// Add a ring edge (no vertices) using the whole of a periodic curve, `t ∈ [0, 2π]`.
    pub fn add_ring_edge(
        &mut self,
        curve: Curve3,
        provenance: Provenance,
    ) -> Result<EdgeId, TopoError> {
        let range = match curve.period() {
            Some(p) => (0.0, p),
            None => {
                return Err(TopoError::RingCurveNotClosed {
                    kind: curve.kind_name(),
                });
            }
        };
        self.add_ring_edge_with_range(curve, range, provenance)
    }

    /// Add a ring edge over an explicit range; the curve must be closed over it
    /// (`|C(t0) − C(t1)| <= tolerance`), e.g. a closed B-spline over its domain.
    pub fn add_ring_edge_with_range(
        &mut self,
        curve: Curve3,
        t_range: (f64, f64),
        provenance: Provenance,
    ) -> Result<EdgeId, TopoError> {
        Self::check_range(t_range)?;
        let gap = curve.eval(t_range.0).distance(curve.eval(t_range.1));
        if !is_within(gap, self.tolerance.linear) {
            return Err(TopoError::RingCurveNotClosed {
                kind: curve.kind_name(),
            });
        }
        Ok(self.body.edges.insert(Edge {
            curve,
            t_range,
            start: None,
            end: None,
            tolerance: self.tolerance.linear,
            coedges: SmallVec::new(),
            provenance,
        }))
    }

    /// Add a shell; `closed` declares whether it bounds a volume.
    pub fn add_shell(&mut self, closed: bool) -> ShellId {
        let id = self.body.shell_arena.insert(Shell {
            faces: Vec::new(),
            closed,
        });
        self.body.shells.push(id);
        id
    }

    /// Add a face (initially without loops) to `shell`.
    pub fn add_face(
        &mut self,
        shell: ShellId,
        surface: Surface,
        sense: bool,
        provenance: Provenance,
    ) -> Result<FaceId, TopoError> {
        if !self.body.shell_arena.contains(shell) {
            return Err(invalid("shell", shell));
        }
        let id = self.body.faces.insert(Face {
            surface,
            sense,
            loops: Vec::new(),
            shell,
            provenance,
        });
        self.body.shell_arena[shell].faces.push(id);
        Ok(id)
    }

    /// Add a loop to `face` from `(edge, forward)` uses in traversal order, creating one
    /// coedge per use. The first loop added to a face is its outer loop.
    ///
    /// Checks: all edges exist; the loop is non-empty; a ring edge is alone in its loop;
    /// otherwise the end vertex of each use equals the start vertex of the next
    /// (cyclically).
    pub fn add_loop(&mut self, face: FaceId, uses: &[(EdgeId, bool)]) -> Result<LoopId, TopoError> {
        if !self.body.faces.contains(face) {
            return Err(invalid("face", face));
        }
        if uses.is_empty() {
            return Err(TopoError::EmptyLoop);
        }
        let mut ends = Vec::with_capacity(uses.len());
        for &(eid, fwd) in uses {
            let e = self
                .body
                .edges
                .get(eid)
                .ok_or_else(|| invalid("edge", eid))?;
            if e.is_ring() && uses.len() > 1 {
                return Err(TopoError::RingEdgeInMultiLoop {
                    edge: format!("{eid:?}"),
                    count: uses.len(),
                });
            }
            ends.push(if fwd {
                (e.start, e.end)
            } else {
                (e.end, e.start)
            });
        }
        if uses.len() > 1 || !self.body.edges[uses[0].0].is_ring() {
            for i in 0..ends.len() {
                let next = ends[(i + 1) % ends.len()];
                if ends[i].1.is_none() || ends[i].1 != next.0 {
                    return Err(TopoError::LoopNotClosed { at: i });
                }
            }
        }
        let lid = self.body.loops.insert(Loop {
            coedges: Vec::with_capacity(uses.len()),
            face,
        });
        for &(eid, fwd) in uses {
            let cid = self.body.coedges.insert(Coedge {
                edge: eid,
                forward: fwd,
                pcurve: None,
                loop_id: lid,
            });
            self.body.loops[lid].coedges.push(cid);
            self.body.edges[eid].coedges.push(cid);
        }
        self.body.faces[face].loops.push(lid);
        Ok(lid)
    }

    /// Attach a pcurve (same parameter as the edge curve) to a coedge.
    pub fn set_pcurve(&mut self, coedge: CoedgeId, pcurve: Curve2) -> Result<(), TopoError> {
        let c = self
            .body
            .coedges
            .get_mut(coedge)
            .ok_or_else(|| invalid("coedge", coedge))?;
        c.pcurve = Some(pcurve);
        Ok(())
    }

    /// Override an edge's tolerance.
    pub fn set_edge_tolerance(&mut self, edge: EdgeId, tolerance: f64) -> Result<(), TopoError> {
        if !(tolerance.is_finite() && tolerance >= 0.0) {
            return Err(TopoError::InvalidTolerance { value: tolerance });
        }
        self.body
            .edges
            .get_mut(edge)
            .ok_or_else(|| invalid("edge", edge))?
            .tolerance = tolerance;
        Ok(())
    }

    /// Override a vertex's tolerance.
    pub fn set_vertex_tolerance(
        &mut self,
        vertex: VertexId,
        tolerance: f64,
    ) -> Result<(), TopoError> {
        if !(tolerance.is_finite() && tolerance >= 0.0) {
            return Err(TopoError::InvalidTolerance { value: tolerance });
        }
        self.body
            .vertices
            .get_mut(vertex)
            .ok_or_else(|| invalid("vertex", vertex))?
            .tolerance = tolerance;
        Ok(())
    }

    /// Finish without validation.
    pub fn finish(self) -> Body {
        self.body
    }

    /// Finish and run [`validate`]; fails if any issue has error severity (warnings are
    /// allowed).
    pub fn finish_validated(self) -> Result<Body, Vec<TopoIssue>> {
        let issues = validate(&self.body);
        if has_errors(&issues) {
            Err(issues)
        } else {
            Ok(self.body)
        }
    }
}
