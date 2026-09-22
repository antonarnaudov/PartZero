//! Structural and geometric validation of bodies.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use super::Provenance;
use super::entities::{
    Body, CoedgeId, Edge, EdgeId, Face, FaceId, Loop, LoopId, ShellId, VertexId,
};
use crate::geom::Surface;
use crate::linalg::Vec2;
use crate::tolerance::is_within;

/// How bad an issue is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Severity {
    /// Suspicious but not invalid (e.g. an unreachable entity).
    Warning,
    /// The body is invalid.
    Error,
}

/// The entity an issue is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityRef {
    /// The body as a whole.
    Body,
    /// A shell.
    Shell(ShellId),
    /// A face.
    Face(FaceId),
    /// A loop.
    Loop(LoopId),
    /// A coedge.
    Coedge(CoedgeId),
    /// An edge.
    Edge(EdgeId),
    /// A vertex.
    Vertex(VertexId),
}

/// Machine-readable issue codes (see [`IssueCode::as_str`] for the stable strings).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum IssueCode {
    /// The body has no shells.
    BodyEmpty,
    /// A shell has no faces.
    ShellEmpty,
    /// An id does not refer to a live entity.
    DanglingReference,
    /// A back-reference (face→shell, loop→face, coedge→loop, edge→coedges) disagrees
    /// with the forward reference.
    BackReferenceMismatch,
    /// An entity is referenced from two places where it must be unique (a face in two
    /// shells, a loop in two faces, a coedge in two loops).
    DuplicateReference,
    /// An entity is not reachable from the body's shells.
    OrphanEntity,
    /// A tolerance is negative or not finite.
    InvalidTolerance,
    /// A point is not finite.
    NonFiniteGeometry,
    /// An edge's parameter range is empty, reversed, or outside the curve's domain.
    InvalidEdgeRange,
    /// An edge has exactly one vertex.
    EdgeHalfRing,
    /// A ring edge's curve is not closed over its range.
    RingEdgeNotClosed,
    /// A vertex is not at the end of an incident edge curve within tolerance.
    VertexOffEdge,
    /// A loop has no coedges.
    LoopEmpty,
    /// Consecutive coedges of a loop do not share a vertex.
    LoopNotClosed,
    /// A ring edge shares its loop with other coedges.
    RingLoopInvalid,
    /// An edge of a closed shell is not used exactly twice (or more than twice in an
    /// open shell).
    EdgeUseCount,
    /// The two uses of an edge have the same direction (inconsistent orientation).
    EdgeOrientation,
    /// An edge is used by faces of different shells.
    EdgeInMultipleShells,
    /// A face has no loops but its surface is not closed and bounded.
    FaceUnbounded,
    /// Samples of an edge curve are farther from an adjacent face's surface than the edge
    /// tolerance.
    EdgeNotOnSurface,
    /// A pcurve mapped through the surface deviates from the edge curve.
    PcurveDeviation,
    /// A loop of a planar face winds the wrong way for its role (outer/inner) and the
    /// face sense.
    LoopOrientation,
    /// A loop of a planar face encloses zero area.
    LoopDegenerate,
    /// The Euler–Poincaré characteristic of a closed shell is impossible.
    EulerCharacteristic,
    /// A face, edge or vertex has no provenance (empty feature name).
    ProvenanceMissing,
    /// Provenance that cannot produce an unambiguous name.
    ProvenanceMalformed,
}

impl IssueCode {
    /// Stable SCREAMING_SNAKE_CASE code.
    pub fn as_str(self) -> &'static str {
        match self {
            IssueCode::BodyEmpty => "BODY_EMPTY",
            IssueCode::ShellEmpty => "SHELL_EMPTY",
            IssueCode::DanglingReference => "DANGLING_REFERENCE",
            IssueCode::BackReferenceMismatch => "BACK_REFERENCE_MISMATCH",
            IssueCode::DuplicateReference => "DUPLICATE_REFERENCE",
            IssueCode::OrphanEntity => "ORPHAN_ENTITY",
            IssueCode::InvalidTolerance => "INVALID_TOLERANCE",
            IssueCode::NonFiniteGeometry => "NON_FINITE_GEOMETRY",
            IssueCode::InvalidEdgeRange => "INVALID_EDGE_RANGE",
            IssueCode::EdgeHalfRing => "EDGE_HALF_RING",
            IssueCode::RingEdgeNotClosed => "RING_EDGE_NOT_CLOSED",
            IssueCode::VertexOffEdge => "VERTEX_OFF_EDGE",
            IssueCode::LoopEmpty => "LOOP_EMPTY",
            IssueCode::LoopNotClosed => "LOOP_NOT_CLOSED",
            IssueCode::RingLoopInvalid => "RING_LOOP_INVALID",
            IssueCode::EdgeUseCount => "EDGE_USE_COUNT",
            IssueCode::EdgeOrientation => "EDGE_ORIENTATION",
            IssueCode::EdgeInMultipleShells => "EDGE_IN_MULTIPLE_SHELLS",
            IssueCode::FaceUnbounded => "FACE_UNBOUNDED",
            IssueCode::EdgeNotOnSurface => "EDGE_NOT_ON_SURFACE",
            IssueCode::PcurveDeviation => "PCURVE_DEVIATION",
            IssueCode::LoopOrientation => "LOOP_ORIENTATION",
            IssueCode::LoopDegenerate => "LOOP_DEGENERATE",
            IssueCode::EulerCharacteristic => "EULER_CHARACTERISTIC",
            IssueCode::ProvenanceMissing => "PROVENANCE_MISSING",
            IssueCode::ProvenanceMalformed => "PROVENANCE_MALFORMED",
        }
    }
}

/// One validation finding, with structured context for repair hints.
#[derive(Clone, Debug, PartialEq)]
pub struct TopoIssue {
    /// What is wrong.
    pub code: IssueCode,
    /// How bad it is.
    pub severity: Severity,
    /// The entity the issue is about.
    pub entity: EntityRef,
    /// Other entities involved (e.g. the face an edge fails to lie on).
    pub related: Vec<EntityRef>,
    /// A measured quantity (distance, Euler characteristic, use count), if any.
    pub measured: Option<f64>,
    /// The allowed value or bound for `measured`, if any.
    pub allowed: Option<f64>,
    /// Human-readable explanation.
    pub message: String,
}

impl fmt::Display for TopoIssue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "[{}] {:?}: {}",
            self.code.as_str(),
            self.entity,
            self.message
        )
    }
}

/// `true` if any issue has [`Severity::Error`].
pub fn has_errors(issues: &[TopoIssue]) -> bool {
    issues.iter().any(|i| i.severity == Severity::Error)
}

/// Validation settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ValidateOptions {
    /// Number of parameter samples (including both ends) per edge for the geometric
    /// checks. At least 2.
    pub samples_per_edge: usize,
}

impl Default for ValidateOptions {
    fn default() -> Self {
        Self {
            samples_per_edge: 9,
        }
    }
}

/// Euler–Poincaré data of one shell (see [`euler_summary`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EulerSummary {
    /// Distinct vertices used by the shell's edges.
    pub vertices: usize,
    /// Distinct edges used by the shell's loops.
    pub edges: usize,
    /// How many of those edges are ring edges.
    pub ring_edges: usize,
    /// Faces.
    pub faces: usize,
    /// Loops (over all faces).
    pub loops: usize,
    /// Sum of the intrinsic genus of the faces (1 for each loop-less torus face).
    pub face_genus: usize,
    /// Euler characteristic `χ = (V + R) − E + Σ_f (2 − 2·g_f − b_f)`.
    pub chi: i64,
}

impl EulerSummary {
    /// Genus of the closed shell, `(2 − χ) / 2`, or `None` if `χ` is odd or > 2 (impossible
    /// for a closed orientable surface).
    pub fn genus(&self) -> Option<i64> {
        (self.chi <= 2 && self.chi % 2 == 0).then_some((2 - self.chi) / 2)
    }
}

/// Euler–Poincaré summary of a shell, adapted to Forge's topology.
///
/// # Adaptation to ring edges and loop-less faces
/// For a closed orientable surface decomposed into vertices, edges and faces,
/// `χ = V − E + Σ_f χ(open face)`. Classical B-rep formulas assume every face is a disc
/// with holes (`χ = 2 − b_f`, `b_f` = loop count) and every edge has two vertices. Forge
/// relaxes both:
/// - A **ring edge** is a closed curve with no vertex. As a 1-cell complex a circle has
///   `χ = 0`, but `V − E` counts it as `−1`; each ring edge therefore contributes one
///   *virtual vertex*: `V' = V + R`.
/// - A face's own genus `g_f` enters as `χ_f = 2 − 2·g_f − b_f`. Faces on plane,
///   cylinder, cone, sphere and B-spline surfaces are planar domains (`g_f = 0`): a
///   cylinder side between two rings is an annulus (`b = 2, χ = 0`), a full cone face with
///   only its base ring is a disc (the apex is an interior singular point), a loop-less
///   sphere face is a sphere (`χ = 2`). A loop-less torus face is a whole torus
///   (`g_f = 1`, `χ = 0`).
///
/// Limitation: faces on a torus *with* loops are assumed planar (`g_f = 0`); a torus
/// with a contractible hole would be mis-counted. Deciding this needs the pcurves'
/// winding numbers and is left for when such faces are produced.
///
/// Returns `None` if the shell id is invalid.
pub fn euler_summary(body: &Body, shell: ShellId) -> Option<EulerSummary> {
    let sh = body.shell(shell)?;
    let mut vertices = BTreeSet::new();
    let mut edges = BTreeSet::new();
    let (mut loops, mut face_genus, mut sum_face_chi) = (0usize, 0usize, 0i64);
    for f in sh.faces.iter().filter_map(|f| body.face(*f)) {
        let b = f.loops.len();
        let g = usize::from(b == 0 && matches!(f.surface, Surface::Torus(_)));
        loops += b;
        face_genus += g;
        sum_face_chi += 2 - 2 * g as i64 - b as i64;
        for c in f
            .loops
            .iter()
            .filter_map(|l| body.loop_(*l))
            .flat_map(|l| l.coedges.iter())
        {
            if let Some(c) = body.coedge(*c) {
                edges.insert(c.edge);
            }
        }
    }
    let mut ring_edges = 0;
    for e in edges.iter().filter_map(|e| body.edge(*e)) {
        if e.is_ring() {
            ring_edges += 1;
        }
        vertices.extend(e.start);
        vertices.extend(e.end);
    }
    let chi = (vertices.len() + ring_edges) as i64 - edges.len() as i64 + sum_face_chi;
    Some(EulerSummary {
        vertices: vertices.len(),
        edges: edges.len(),
        ring_edges,
        faces: sh.faces.len(),
        loops,
        face_genus,
        chi,
    })
}

/// Validate a body with default options. Issues are reported in a deterministic order.
pub fn validate(body: &Body) -> Vec<TopoIssue> {
    validate_with(body, &ValidateOptions::default())
}

/// Validate a body.
///
/// Checks, in order: shells and reference integrity (forward and back references, no
/// duplicates); per face: provenance, bounded-ness, loop closure (consecutive coedges
/// share vertices; ring loops are a single ring coedge), edge curves on the face surface
/// (sampled, via `Surface::project`), pcurve consistency, loop orientation on planar
/// faces; per shell: edge use counts and opposite directions (exactly two uses in a
/// closed shell), Euler–Poincaré ([`euler_summary`]); per edge: provenance, tolerance,
/// parameter range, ring closure, vertices at curve ends; per vertex: provenance,
/// tolerance; finally unreachable entities (warnings).
pub fn validate_with(body: &Body, opts: &ValidateOptions) -> Vec<TopoIssue> {
    let mut v = Validator {
        body,
        opts: *opts,
        out: Vec::new(),
        seen_faces: BTreeSet::new(),
        seen_loops: BTreeSet::new(),
        seen_coedges: BTreeSet::new(),
        shell_of_edge: BTreeMap::new(),
        seen_vertices: BTreeSet::new(),
    };
    v.run();
    v.out
}

struct Validator<'a> {
    body: &'a Body,
    opts: ValidateOptions,
    out: Vec<TopoIssue>,
    seen_faces: BTreeSet<FaceId>,
    seen_loops: BTreeSet<LoopId>,
    seen_coedges: BTreeSet<CoedgeId>,
    shell_of_edge: BTreeMap<EdgeId, ShellId>,
    seen_vertices: BTreeSet<VertexId>,
}

impl<'a> Validator<'a> {
    fn body(&self) -> &'a Body {
        self.body
    }

    #[allow(clippy::too_many_arguments)]
    fn push(
        &mut self,
        code: IssueCode,
        severity: Severity,
        entity: EntityRef,
        related: Vec<EntityRef>,
        measured: Option<f64>,
        allowed: Option<f64>,
        message: String,
    ) {
        self.out.push(TopoIssue {
            code,
            severity,
            entity,
            related,
            measured,
            allowed,
            message,
        });
    }

    fn error(
        &mut self,
        code: IssueCode,
        entity: EntityRef,
        related: Vec<EntityRef>,
        message: String,
    ) {
        self.push(code, Severity::Error, entity, related, None, None, message);
    }

    fn run(&mut self) {
        let body = self.body();
        if body.shells.is_empty() {
            self.error(
                IssueCode::BodyEmpty,
                EntityRef::Body,
                vec![],
                "body has no shells".into(),
            );
        }
        for &sid in &body.shells {
            self.check_shell(sid);
        }
        for (eid, e) in body.edges.iter() {
            self.check_edge(eid, e);
        }
        for (vid, vx) in body.vertices.iter() {
            let ent = EntityRef::Vertex(vid);
            if !self.seen_vertices.contains(&vid) {
                self.orphan(ent);
            }
            self.check_provenance(ent, &vx.provenance);
            if !(vx.tolerance.is_finite() && vx.tolerance >= 0.0) {
                self.error(
                    IssueCode::InvalidTolerance,
                    ent,
                    vec![],
                    format!("tolerance {}", vx.tolerance),
                );
            }
            if !vx.point.is_finite() {
                self.error(
                    IssueCode::NonFiniteGeometry,
                    ent,
                    vec![],
                    "vertex point is not finite".into(),
                );
            }
        }
        for fid in body.faces.ids() {
            if !self.seen_faces.contains(&fid) {
                self.orphan(EntityRef::Face(fid));
            }
        }
        for lid in body.loops.ids() {
            if !self.seen_loops.contains(&lid) {
                self.orphan(EntityRef::Loop(lid));
            }
        }
        for cid in body.coedges.ids() {
            if !self.seen_coedges.contains(&cid) {
                self.orphan(EntityRef::Coedge(cid));
            }
        }
    }

    fn orphan(&mut self, ent: EntityRef) {
        self.push(
            IssueCode::OrphanEntity,
            Severity::Warning,
            ent,
            vec![],
            None,
            None,
            "entity is not reachable from the body's shells".into(),
        );
    }

    fn dangling(&mut self, from: EntityRef, to: String) {
        self.error(
            IssueCode::DanglingReference,
            from,
            vec![],
            format!("references missing entity {to}"),
        );
    }

    fn check_provenance(&mut self, ent: EntityRef, p: &Provenance) {
        if p.feature.is_empty() {
            self.error(
                IssueCode::ProvenanceMissing,
                ent,
                vec![],
                "entity has no provenance (empty feature)".into(),
            );
            return;
        }
        let problems = p.problems();
        if !problems.is_empty() {
            self.error(
                IssueCode::ProvenanceMalformed,
                ent,
                vec![],
                problems.join("; "),
            );
        }
    }

    fn check_shell(&mut self, sid: ShellId) {
        let body = self.body();
        let Some(shell) = body.shell(sid) else {
            self.dangling(EntityRef::Body, format!("{sid:?}"));
            return;
        };
        let sent = EntityRef::Shell(sid);
        if shell.faces.is_empty() {
            self.error(
                IssueCode::ShellEmpty,
                sent,
                vec![],
                "shell has no faces".into(),
            );
        }
        let mut uses: BTreeMap<EdgeId, Vec<CoedgeId>> = BTreeMap::new();
        for &fid in &shell.faces {
            let Some(face) = body.face(fid) else {
                self.dangling(sent, format!("{fid:?}"));
                continue;
            };
            if !self.seen_faces.insert(fid) {
                self.error(
                    IssueCode::DuplicateReference,
                    EntityRef::Face(fid),
                    vec![sent],
                    "face listed twice".into(),
                );
                continue;
            }
            if face.shell != sid {
                self.error(
                    IssueCode::BackReferenceMismatch,
                    EntityRef::Face(fid),
                    vec![sent],
                    format!("face.shell is {:?}", face.shell),
                );
            }
            self.check_face(sid, fid, face, &mut uses);
        }
        for (eid, cs) in &uses {
            self.check_edge_uses(sid, shell.closed, *eid, cs);
        }
        if shell.closed
            && let Some(eu) = euler_summary(body, sid)
            && eu.genus().is_none()
        {
            self.push(
                IssueCode::EulerCharacteristic,
                Severity::Error,
                sent,
                vec![],
                Some(eu.chi as f64),
                Some(2.0),
                format!(
                    "Euler characteristic {} (V={} R={} E={} F={} L={}) is odd or > 2",
                    eu.chi, eu.vertices, eu.ring_edges, eu.edges, eu.faces, eu.loops
                ),
            );
        }
    }

    fn check_face(
        &mut self,
        sid: ShellId,
        fid: FaceId,
        face: &Face,
        uses: &mut BTreeMap<EdgeId, Vec<CoedgeId>>,
    ) {
        let body = self.body();
        let fent = EntityRef::Face(fid);
        self.check_provenance(fent, &face.provenance);
        if face.loops.is_empty() && !face.surface.is_closed_without_boundary() {
            self.error(
                IssueCode::FaceUnbounded,
                fent,
                vec![],
                format!(
                    "face on an unbounded {} surface has no loops",
                    face.surface.kind_name()
                ),
            );
        }
        for (li, &lid) in face.loops.iter().enumerate() {
            let Some(lp) = body.loop_(lid) else {
                self.dangling(fent, format!("{lid:?}"));
                continue;
            };
            let lent = EntityRef::Loop(lid);
            if !self.seen_loops.insert(lid) {
                self.error(
                    IssueCode::DuplicateReference,
                    lent,
                    vec![fent],
                    "loop used twice".into(),
                );
                continue;
            }
            if lp.face != fid {
                self.error(
                    IssueCode::BackReferenceMismatch,
                    lent,
                    vec![fent],
                    format!("loop.face is {:?}", lp.face),
                );
            }
            if lp.coedges.is_empty() {
                self.error(
                    IssueCode::LoopEmpty,
                    lent,
                    vec![fent],
                    "loop has no coedges".into(),
                );
                continue;
            }
            let mut refs_ok = true;
            for &cid in &lp.coedges {
                let cent = EntityRef::Coedge(cid);
                let Some(c) = body.coedge(cid) else {
                    self.dangling(lent, format!("{cid:?}"));
                    refs_ok = false;
                    continue;
                };
                if !self.seen_coedges.insert(cid) {
                    self.error(
                        IssueCode::DuplicateReference,
                        cent,
                        vec![lent],
                        "coedge used twice".into(),
                    );
                    refs_ok = false;
                    continue;
                }
                if c.loop_id != lid {
                    self.error(
                        IssueCode::BackReferenceMismatch,
                        cent,
                        vec![lent],
                        format!("coedge.loop is {:?}", c.loop_id),
                    );
                }
                let Some(e) = body.edge(c.edge) else {
                    self.dangling(cent, format!("{:?}", c.edge));
                    refs_ok = false;
                    continue;
                };
                if !e.coedges.contains(&cid) {
                    self.error(
                        IssueCode::BackReferenceMismatch,
                        EntityRef::Edge(c.edge),
                        vec![cent],
                        "edge does not list this coedge".into(),
                    );
                }
                uses.entry(c.edge).or_default().push(cid);
                match self.shell_of_edge.get(&c.edge) {
                    Some(&other) if other != sid => self.error(
                        IssueCode::EdgeInMultipleShells,
                        EntityRef::Edge(c.edge),
                        vec![EntityRef::Shell(other), EntityRef::Shell(sid)],
                        "edge is used by faces of two shells".into(),
                    ),
                    Some(_) => {}
                    None => {
                        self.shell_of_edge.insert(c.edge, sid);
                    }
                }
                self.check_coedge_geometry(fid, face, cid, e);
            }
            if refs_ok {
                self.check_loop_closure(lid, lp);
                if let Surface::Plane(_) = face.surface {
                    self.check_planar_loop_orientation(fid, face, li, lid, lp);
                }
            }
        }
    }

    fn check_loop_closure(&mut self, lid: LoopId, lp: &Loop) {
        let body = self.body();
        let lent = EntityRef::Loop(lid);
        let n = lp.coedges.len();
        let rings: Vec<CoedgeId> = lp
            .coedges
            .iter()
            .copied()
            .filter(|c| {
                body.coedge(*c)
                    .and_then(|c| body.edge(c.edge))
                    .is_some_and(Edge::is_ring)
            })
            .collect();
        if !rings.is_empty() {
            if n != 1 {
                self.error(
                    IssueCode::RingLoopInvalid,
                    lent,
                    rings.iter().map(|c| EntityRef::Coedge(*c)).collect(),
                    format!("ring edge in a loop of {n} coedges"),
                );
            }
            return;
        }
        for i in 0..n {
            let (a, b) = (lp.coedges[i], lp.coedges[(i + 1) % n]);
            let end = body.coedge_end(a);
            let start = body.coedge_start(b);
            if end.is_none() || end != start {
                self.error(
                    IssueCode::LoopNotClosed,
                    lent,
                    vec![EntityRef::Coedge(a), EntityRef::Coedge(b)],
                    format!("coedge {a:?} ends at {end:?} but {b:?} starts at {start:?}"),
                );
            }
        }
    }

    fn sample_params(&self, e: &Edge) -> Vec<f64> {
        let n = self.opts.samples_per_edge.max(2);
        let (t0, t1) = e.t_range;
        (0..n)
            .map(|i| {
                if i + 1 == n {
                    t1
                } else {
                    t0 + (t1 - t0) * (i as f64 / (n - 1) as f64)
                }
            })
            .collect()
    }

    fn check_coedge_geometry(&mut self, fid: FaceId, face: &Face, cid: CoedgeId, e: &Edge) {
        let body = self.body();
        let Some(c) = body.coedge(cid) else { return };
        if e.t_range.0.partial_cmp(&e.t_range.1) != Some(std::cmp::Ordering::Less) {
            return; // reported by check_edge
        }
        let ts = self.sample_params(e);
        let mut worst = 0.0f64;
        let mut worst_pc = 0.0f64;
        for &t in &ts {
            let p = e.curve.eval(t);
            let (_, _, d) = face.surface.project(p);
            worst = worst.max(d);
            if let Some(pc) = &c.pcurve {
                let uv = pc.eval(t);
                worst_pc = worst_pc.max(face.surface.eval(uv.x, uv.y).distance(p));
            }
        }
        let ent = EntityRef::Edge(c.edge);
        if !is_within(worst, e.tolerance) {
            self.push(
                IssueCode::EdgeNotOnSurface,
                Severity::Error,
                ent,
                vec![EntityRef::Face(fid), EntityRef::Coedge(cid)],
                Some(worst),
                Some(e.tolerance),
                format!(
                    "edge curve is {worst:e} from the {} surface (tolerance {:e})",
                    face.surface.kind_name(),
                    e.tolerance
                ),
            );
        }
        if c.pcurve.is_some() && !is_within(worst_pc, e.tolerance) {
            self.push(
                IssueCode::PcurveDeviation,
                Severity::Error,
                EntityRef::Coedge(cid),
                vec![EntityRef::Face(fid), ent],
                Some(worst_pc),
                Some(e.tolerance),
                format!(
                    "pcurve deviates {worst_pc:e} from the edge curve (tolerance {:e})",
                    e.tolerance
                ),
            );
        }
    }

    fn check_planar_loop_orientation(
        &mut self,
        fid: FaceId,
        face: &Face,
        index: usize,
        lid: LoopId,
        lp: &Loop,
    ) {
        let body = self.body();
        let Surface::Plane(plane) = &face.surface else {
            return;
        };
        let mut pts: Vec<Vec2> = Vec::new();
        for &cid in &lp.coedges {
            let (Some(c), Some(e)) = (
                body.coedge(cid),
                body.coedge(cid).and_then(|c| body.edge(c.edge)),
            ) else {
                return;
            };
            let mut ts = self.sample_params(e);
            if !c.forward {
                ts.reverse();
            }
            ts.pop(); // the next coedge starts here
            for t in ts {
                let (u, v, _) = plane.project(e.curve.eval(t));
                pts.push(Vec2::new(u, v));
            }
        }
        let twice_area = polygon_twice_signed_area(&pts);
        let lent = EntityRef::Loop(lid);
        if twice_area == 0.0 {
            self.error(
                IssueCode::LoopDegenerate,
                lent,
                vec![EntityRef::Face(fid)],
                "loop encloses zero area".into(),
            );
            return;
        }
        let expected = if (index == 0) == face.sense {
            1.0
        } else {
            -1.0
        };
        if twice_area * expected < 0.0 {
            let role = if index == 0 { "outer" } else { "inner" };
            self.push(
                IssueCode::LoopOrientation,
                Severity::Error,
                lent,
                vec![EntityRef::Face(fid)],
                Some(0.5 * twice_area),
                None,
                format!("{role} loop winds the wrong way (signed area {} in plane coordinates, face sense {})", 0.5 * twice_area, face.sense),
            );
        }
    }

    fn check_edge_uses(&mut self, sid: ShellId, closed: bool, eid: EdgeId, cs: &[CoedgeId]) {
        let body = self.body();
        let ent = EntityRef::Edge(eid);
        let related: Vec<EntityRef> = cs.iter().map(|c| EntityRef::Coedge(*c)).collect();
        let bad_count = if closed { cs.len() != 2 } else { cs.len() > 2 };
        if bad_count {
            let want = if closed { "exactly 2" } else { "at most 2" };
            self.push(
                IssueCode::EdgeUseCount,
                Severity::Error,
                ent,
                related,
                Some(cs.len() as f64),
                Some(2.0),
                format!(
                    "edge is used {} times in {} shell {sid:?}; need {want}",
                    cs.len(),
                    if closed { "closed" } else { "open" }
                ),
            );
            return;
        }
        if cs.len() == 2 {
            let f: Vec<bool> = cs
                .iter()
                .filter_map(|c| body.coedge(*c))
                .map(|c| c.forward)
                .collect();
            if f.len() == 2 && f[0] == f[1] {
                self.error(
                    IssueCode::EdgeOrientation,
                    ent,
                    related,
                    "both coedges traverse the edge in the same direction".into(),
                );
            }
        }
    }

    fn check_edge(&mut self, eid: EdgeId, e: &Edge) {
        let body = self.body();
        let ent = EntityRef::Edge(eid);
        if !self.shell_of_edge.contains_key(&eid) {
            self.orphan(ent);
        }
        self.check_provenance(ent, &e.provenance);
        if !(e.tolerance.is_finite() && e.tolerance >= 0.0) {
            self.error(
                IssueCode::InvalidTolerance,
                ent,
                vec![],
                format!("tolerance {}", e.tolerance),
            );
        }
        for &cid in &e.coedges {
            match body.coedge(cid) {
                None => self.dangling(ent, format!("{cid:?}")),
                Some(c) if c.edge != eid => self.error(
                    IssueCode::BackReferenceMismatch,
                    ent,
                    vec![EntityRef::Coedge(cid)],
                    format!("listed coedge belongs to {:?}", c.edge),
                ),
                Some(_) => {}
            }
        }
        let (t0, t1) = e.t_range;
        let (d0, d1) = e.curve.domain();
        let within_domain = match e.curve.period() {
            // Periodic curves: any start, at most one period.
            Some(p) => t1 - t0 <= p * (1.0 + 4.0 * f64::EPSILON),
            None => t0 >= d0 && t1 <= d1,
        };
        if !(t0.is_finite() && t1.is_finite() && t0 < t1 && within_domain) {
            self.error(
                IssueCode::InvalidEdgeRange,
                ent,
                vec![],
                format!(
                    "range ({t0}, {t1}) is empty, reversed or outside the {} domain",
                    e.curve.kind_name()
                ),
            );
            return;
        }
        match (e.start, e.end) {
            (None, None) => {
                let gap = e.curve.eval(t0).distance(e.curve.eval(t1));
                if !is_within(gap, e.tolerance) {
                    self.push(
                        IssueCode::RingEdgeNotClosed,
                        Severity::Error,
                        ent,
                        vec![],
                        Some(gap),
                        Some(e.tolerance),
                        format!("ring edge curve has a gap of {gap:e}"),
                    );
                }
            }
            (Some(_), None) | (None, Some(_)) => {
                self.error(
                    IssueCode::EdgeHalfRing,
                    ent,
                    vec![],
                    "edge has exactly one vertex".into(),
                );
            }
            (Some(a), Some(b)) => {
                for (vid, t) in [(a, t0), (b, t1)] {
                    self.seen_vertices.insert(vid);
                    let Some(vx) = body.vertex(vid) else {
                        self.dangling(ent, format!("{vid:?}"));
                        continue;
                    };
                    let d = e.curve.eval(t).distance(vx.point);
                    let tol = vx.tolerance.max(e.tolerance);
                    if !is_within(d, tol) {
                        self.push(
                            IssueCode::VertexOffEdge,
                            Severity::Error,
                            EntityRef::Vertex(vid),
                            vec![ent],
                            Some(d),
                            Some(tol),
                            format!("vertex is {d:e} from the edge curve end at t = {t}"),
                        );
                    }
                }
            }
        }
    }
}

/// Twice the signed area of a closed polygon (shoelace; positive if counter-clockwise).
/// Used for the orientation check of planar loops, which samples curved edges.
fn polygon_twice_signed_area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    (0..n).map(|i| pts[i].perp_dot(pts[(i + 1) % n])).sum()
}
