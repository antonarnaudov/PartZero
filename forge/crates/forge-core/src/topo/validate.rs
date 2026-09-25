//! Structural and geometric validation of bodies.

use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use super::entities::{
    Body, CoedgeId, Edge, EdgeId, Face, FaceId, Loop, LoopId, ShellId, VertexId,
};
use super::{Provenance, Role};
use crate::geom::{Curve3, Plane, Surface};
use crate::linalg::Vec2;
use crate::math;
use crate::predicates::orient2d;
use crate::tolerance::is_within;

/// Error of one plane coordinate of a vertex as this check computes it, in ulps
/// (`f64::EPSILON`) of `|p|∞ + |o|∞` (vertex and plane origin). `(p − o)·x` rounds once
/// per difference and three times in the dot product, each by half an ulp of a term of at
/// most `|p|∞ + |o|∞` (`|x_k| ≤ 1`, three terms): at most `2·3 = 6` ulps; 8 with margin.
const PROJECTION_ROUNDOFF_ULPS: f64 = 8.0;

/// Error of one plane coordinate of a vertex of a **sketch-region loop** (see
/// [`is_sketch_region_loop`]) relative to the sketch's exact 2D data, in ulps of the
/// body's coordinate scale `M` (the largest |coordinate| of its vertices, surface frame
/// origins and circle centres, see `Validator::coordinate_scale`).
///
/// The vertex was lifted from 2D to 3D (`o + x·u + y·v + z·w`: 4-term sums whose terms
/// are at most `‖(u, v, w)‖₂ ≤ 2√3·M`, ≤ 11 ulps of `M` in the plane), maybe moved
/// rigidly (an extrude lifts its far cap directly; a revolve rotates its end cap about an
/// axis through circle centres of the body, ≤ 12 more), and is projected back here (≤ 7);
/// the frame axes are unit and orthogonal to within ~3 ulps, which moves
/// `(x·u + y·v + z·w)·x` off `u` by ≤ 6·3 = 18 ulps of `M`. Worst cases added: 48; 64
/// with margin. The round trips of forge-ops' extrude and revolve caps measure below one
/// ulp (0.63 at most over 2 000 random planes, regions and sweeps: forge-check
/// `tests/degenerate_loop.rs`, `sketch_region_round_trip_is_within_the_allowance`, which
/// fails above 16). Only used to leave sketch-region loops within round-off of the tol²
/// limit to the sketch stage (SPEC §3.1 [R-5]).
const SKETCH_LOOP_ROUNDOFF_ULPS: f64 = 64.0;

/// Largest parameter step (radians) between the samples of an angle-parametrized edge in a
/// planar loop's polygon (the orientation and sampled-area checks): a chord of a circle of
/// radius `r` then stays within `r·(1 − cos(π/128)) ≈ 3·10⁻⁴·r` of it.
const ORIENTATION_ANGLE_STEP: f64 = math::PI / 64.0;

/// Cap on those samples per edge (a helix edge of many turns).
const ORIENTATION_MAX_SAMPLES: usize = 4096;

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
    /// face sense (decided with an exact orientation predicate).
    LoopOrientation,
    /// A loop of a planar face does not enclose more than `tolerance²` (the largest
    /// tolerance of its edges), the sketch's degeneracy rule (SPEC §3.1). The area is
    /// exact for loops of lines and circular arcs (sampled otherwise) and must exceed the
    /// limit by more than its round-off. Only a loop the sketch stage decided (a cap of a
    /// swept sketch region whose edges are all the sweep's own) that may enclose more
    /// than `tolerance²` (the least tolerance of its edges) and clearly encloses
    /// something is left to the sketch, which decided it on exact 2D data ([R-5]).
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
///   (`g_f = 1`, `χ = 0`), except on a spindle-torus patch, which is a sphere whose two
///   axis points are singular (`g_f = 0`).
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
        // A loop-less face on a whole ring/horn torus is a torus (genus 1); a whole
        // spindle-torus patch is a sphere (its v-range ends are singular points).
        let g = usize::from(
            b == 0 && matches!(&f.surface, Surface::Torus(t) if t.spindle_patch().is_none()),
        );
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
        scale: None,
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
    /// The body's coordinate scale, computed on first use (see `coordinate_scale`).
    scale: Option<f64>,
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

    /// Samples of an edge for the planar loop polygon: [`Self::sample_params`], refined for
    /// curves parametrized by an angle (circles, ellipses, helices and spirals) to a step of
    /// at most [`ORIENTATION_ANGLE_STEP`], so that the polygon's chords stay close to the
    /// curve. With 9 samples a long arc's chords cut deep into a thin region (the section of
    /// a thread's groove, bounded by a 315° arc) and the polygon crosses itself.
    fn orientation_params(&self, e: &Edge) -> Vec<f64> {
        let (t0, t1) = e.t_range;
        let angular = matches!(
            e.curve,
            Curve3::Circle(_) | Curve3::Ellipse(_) | Curve3::Helix(_)
        );
        let by_angle = if angular && (t1 - t0).is_finite() {
            ((t1 - t0).abs() / ORIENTATION_ANGLE_STEP).ceil() as usize + 1
        } else {
            0
        };
        let n = self
            .opts
            .samples_per_edge
            .max(2)
            .max(by_angle.min(ORIENTATION_MAX_SAMPLES));
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
        // Linear tolerance of the loop: the largest tolerance recorded on its edges. The
        // smallest is the one closest to the tolerance the sketch used (operations only
        // ever raise an edge's tolerance above the document's: see below).
        let mut tol = 0.0f64;
        let mut tol_least = f64::INFINITY;
        for &cid in &lp.coedges {
            let (Some(c), Some(e)) = (
                body.coedge(cid),
                body.coedge(cid).and_then(|c| body.edge(c.edge)),
            ) else {
                return;
            };
            tol = math::max(tol, e.tolerance);
            tol_least = math::min(tol_least, e.tolerance);
            let mut ts = self.orientation_params(e);
            if !c.forward {
                ts.reverse();
            }
            ts.pop(); // the next coedge starts here
            for t in ts {
                let (u, v, _) = plane.project(e.curve.eval(t));
                pts.push(Vec2::new(u, v));
            }
        }
        let lent = EntityRef::Loop(lid);
        if !pts.iter().all(|p| p.is_finite()) {
            self.error(
                IssueCode::NonFiniteGeometry,
                lent,
                vec![EntityRef::Face(fid)],
                "loop samples are not finite in plane coordinates".into(),
            );
            return;
        }
        // SPEC §3.1 (the sketch's rule): a loop must enclose more than tol².
        //
        // The enclosed area is exact for loops of lines and circular arcs (the polygon of
        // their vertices plus each arc's circular segment: the sketch stage's own formula)
        // and otherwise that of the sampled polygon (which cuts the chords of the other
        // curves). A loop must provably enclose more than tol²: its exact area must exceed
        // the limit by more than the round-off of computing it (`err`). This is stricter
        // than `area ≤ tol²` by that round-off (≲ 1e-5·tol² for µm loops): a loop within
        // round-off of the limit that no sketch decided is rejected (loudly), never
        // guessed valid.
        //
        // One exception: a loop the sketch stage decided ([R-5], `is_sketch_region_loop`).
        // The sketch decided it on exact 2D data, the body only holds it after a 3D round
        // trip, so its area is known only to within the round-off of that trip (`err_s`):
        // a hole of area 1.000000001·tol² passes the sketch and must not fail here. Such a
        // loop is left to the sketch when it may enclose more than tol² (`a + err_s > tol²`)
        // and provably encloses something (`a > err_s`); together these imply `a > tol²/2`,
        // so a loop collapsed or shrunk by a construction bug is still caught. Its tol is
        // the least of its edges' tolerances, the closest to the document tolerance the
        // sketch used (a boolean may have raised some of them). Every other loop
        // (body-op and boolean section loops, imports, any face no sketch produced) gets
        // the strict rule.
        let area = 0.5 * polygon_twice_signed_area(&pts);
        let min_area = tol * tol;
        let exact = self.exact_loop_area(plane, lp);
        let (enclosed, err, limit, degenerate) = match &exact {
            Some(x) => {
                let a = x.area.abs();
                let err = x.error(x.projection_delta, false);
                // Written so that a NaN bound leaves the loop degenerate.
                if a > min_area + err {
                    (a, err, min_area, false)
                } else if is_sketch_region_loop(body, face, lp) {
                    let delta = SKETCH_LOOP_ROUNDOFF_ULPS * f64::EPSILON * self.coordinate_scale();
                    let err_s = x.error(delta, true);
                    let limit = tol_least * tol_least;
                    // A NaN bound fails both comparisons: the loop stays degenerate.
                    (a, err_s, limit, !(a > err_s && a + err_s > limit))
                } else {
                    (a, err, min_area, true)
                }
            }
            None => (area.abs(), 0.0, min_area, is_within(area.abs(), min_area)),
        };
        if pts.len() < 3 || degenerate {
            self.push(
                IssueCode::LoopDegenerate,
                Severity::Error,
                lent,
                vec![EntityRef::Face(fid)],
                Some(enclosed),
                Some(limit),
                format!(
                    "loop encloses area {enclosed:e} (± {err:e}), not provably more than \
                     tolerance² = {limit:e}"
                ),
            );
            return;
        }
        let expected = if (index == 0) == face.sense { 1 } else { -1 };
        if polygon_orientation(&pts, area) != expected {
            let role = if index == 0 { "outer" } else { "inner" };
            self.push(
                IssueCode::LoopOrientation,
                Severity::Error,
                lent,
                vec![EntityRef::Face(fid)],
                Some(area),
                None,
                format!("{role} loop winds the wrong way (signed area {area} in plane coordinates, face sense {})", face.sense),
            );
        }
    }

    /// The exact area of loop `lp` in `plane` coordinates when all its edges are lines or
    /// circular arcs (`None` otherwise, or if it is not finite): the shoelace polygon of
    /// its vertices plus, for every arc, the circular segment between the arc and its
    /// chord, `±½·r²·(θ − sin θ)·cos φ` (`θ = t1 − t0` the arc's sweep, `φ` the angle
    /// between its axis and the plane normal: the projection scales every area by
    /// `cos φ`; the sign is the arc's turning direction in the plane). A ring edge is a
    /// whole circle, `π·r²·cos φ`. This is the sketch stage's formula
    /// (forge-ops `sketch::signed_area`), so a loop the sketch built is measured the same.
    fn exact_loop_area(&self, plane: &Plane, lp: &Loop) -> Option<LoopArea> {
        let body = self.body();
        let eps = f64::EPSILON;
        let normal = plane.frame().z();
        let origin_scale = plane.frame().origin().max_abs_component();
        let mut verts: Vec<Vec2> = Vec::with_capacity(lp.coedges.len());
        let mut reach = 0.0f64;
        let (mut segments, mut eval_err, mut arc_sensitivity) = (0.0, 0.0, 0.0);
        for &cid in &lp.coedges {
            let c = body.coedge(cid)?;
            let e = body.edge(c.edge)?;
            match &e.curve {
                Curve3::Line(_) => {}
                Curve3::Circle(circle) => {
                    let (t0, t1) = e.t_range;
                    let theta = t1 - t0;
                    let r = circle.radius();
                    let cos_phi = circle.frame().z().dot(normal);
                    let dir = if c.forward { 1.0 } else { -1.0 };
                    let (s, co) = math::sin_cos(theta);
                    let half_r2 = 0.5 * r * r;
                    let segment = half_r2 * (theta - s);
                    segments += dir * cos_phi * segment;
                    // Evaluation: `sin` within an ulp, `θ` within an ulp of its ends each
                    // (moves the segment by ½r²·(1 − cos θ) per radian), products and
                    // `cos φ` within a few ulps of the segment.
                    eval_err += half_r2 * eps * (s.abs() + (1.0 - co) * (t0.abs() + t1.abs()))
                        + 8.0 * eps * segment.abs();
                    // Sensitivity to a history round-off `δ` per plane coordinate (points
                    // off by ≤ √2·δ): a radius taken from rounded points (off by ≤ 3δ)
                    // moves the segment by `r·(θ − sin θ)` per unit, a sweep taken from
                    // rounded endpoints (off by ≤ 3δ/r) by `½r²·(1 − cos θ)` per radian.
                    arc_sensitivity += 3.0 * r * ((theta - s).abs() + 0.5 * (1.0 - co));
                }
                _ => return None,
            }
            if e.is_ring() {
                continue;
            }
            let v = if c.forward { e.start } else { e.end };
            let p = body.vertex(v?)?.point;
            reach = math::max(reach, p.max_abs_component());
            let (u, w, _) = plane.project(p);
            verts.push(Vec2::new(u, w));
        }
        let n = verts.len();
        // Σ ‖p_{i+1} − p_{i−1}‖₁ (first-order sensitivity of the shoelace area to vertex
        // moves) and Σ |a_x·b_y| + |a_y·b_x| (its evaluation round-off).
        let (mut spread, mut terms) = (0.0, 0.0);
        if let Some(&p0) = verts.first() {
            for i in 0..n {
                let d = verts[(i + 1) % n] - verts[(i + n - 1) % n];
                spread += d.x.abs() + d.y.abs();
                let (a, b) = (verts[i] - p0, verts[(i + 1) % n] - p0);
                terms += (a.x * b.y).abs() + (a.y * b.x).abs();
            }
        }
        let area = 0.5 * polygon_twice_signed_area(&verts) + segments;
        let nf = n as f64;
        // The shoelace sum relative to `p0` rounds at most `n + 4` times per term.
        eval_err += 0.5 * (nf + 4.0) * eps * terms;
        area.is_finite().then_some(LoopArea {
            area,
            vertices: n,
            spread,
            eval_err,
            arc_sensitivity,
            projection_delta: PROJECTION_ROUNDOFF_ULPS * eps * (origin_scale + reach),
        })
    }

    /// The body's coordinate scale `M`: the largest |coordinate| of its vertices, surface
    /// frame origins and circle and ellipse centres (computed once). Every coordinate an
    /// operation rounded while building the body is at most a small multiple of it.
    fn coordinate_scale(&mut self) -> f64 {
        if let Some(m) = self.scale {
            return m;
        }
        let body = self.body();
        let mut m = 0.0f64;
        for (_, v) in body.vertices.iter() {
            m = math::max(m, v.point.max_abs_component());
        }
        for (_, f) in body.faces.iter() {
            let origin = match &f.surface {
                Surface::Plane(s) => Some(s.frame().origin()),
                Surface::Cylinder(s) => Some(s.frame().origin()),
                Surface::Cone(s) => Some(s.frame().origin()),
                Surface::Sphere(s) => Some(s.frame().origin()),
                Surface::Torus(s) => Some(s.frame().origin()),
                Surface::Helicoid(s) => Some(s.frame().origin()),
                Surface::BSpline(_) => None,
            };
            if let Some(o) = origin {
                m = math::max(m, o.max_abs_component());
            }
        }
        for (_, e) in body.edges.iter() {
            let centre = match &e.curve {
                Curve3::Circle(c) => Some(c.frame().origin()),
                Curve3::Ellipse(c) => Some(c.frame().origin()),
                Curve3::Helix(c) => Some(c.frame().origin()),
                Curve3::Line(_) | Curve3::BSpline(_) => None,
            };
            if let Some(o) = centre {
                m = math::max(m, o.max_abs_component());
            }
        }
        self.scale = Some(m);
        m
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

/// The exact area of a planar loop of lines and circular arcs (see
/// `Validator::exact_loop_area`) with what its error bound needs.
struct LoopArea {
    /// Signed area in plane coordinates (positive counter-clockwise).
    area: f64,
    /// Number of vertices of the chord polygon.
    vertices: usize,
    /// `Σ ‖p_{i+1} − p_{i−1}‖₁` over the chord polygon: moving every vertex by at most `δ`
    /// per coordinate moves its area by at most `½·δ·spread + n·δ²`.
    spread: f64,
    /// Round-off of evaluating the formula itself (shoelace sum, circular segments).
    eval_err: f64,
    /// How much the arcs' segments move per unit of history round-off `δ` (radius and
    /// sweep taken from rounded points).
    arc_sensitivity: f64,
    /// Error of the plane coordinates as projected here, per coordinate
    /// ([`PROJECTION_ROUNDOFF_ULPS`]).
    projection_delta: f64,
}

impl LoopArea {
    /// An upper bound on `|area − A|`, where `A` is the area of the loop whose vertices
    /// are each within `delta` per plane coordinate of the ones used here; `history`
    /// adds the arcs' sensitivity to radii and sweeps derived from such points.
    fn error(&self, delta: f64, history: bool) -> f64 {
        let n = self.vertices as f64;
        let arcs = if history {
            self.arc_sensitivity * delta
        } else {
            0.0
        };
        0.5 * delta * self.spread + n * delta * delta + self.eval_err + arcs
    }
}

/// `true` if loop `lp` of `face` is a loop the **sketch stage decided** (SPEC §3.1
/// [R-5]): `face` is a cap of a swept sketch region (an extrude's caps, a revolve's end
/// caps: congruent copies of the region) and every edge of the loop is an edge the sweep
/// itself made on that cap's boundary: `F/edge:{A|B}` of the cap's own feature `F`
/// whose two faces are the cap and **another face of `F`'s sweep** (a side `F/side…` or,
/// for a revolve's profile line on the axis, the other end cap). So the loop is the
/// image of a loop of the region's sketch curves.
///
/// Not sketch-decided, so they get the strict rule:
/// - section edges of a body op (SPEC §5.2: `G/edge:{A|B}`, `G` the operation's feature
///   id). A standalone `boolean`, a hole or a pattern has its own id `G ≠ F`; an extrude
///   or revolve with `op: join/cut/intersect` **is** `F`, but its section edges join the
///   cap to a face of a target (`F/edge:{F/cap:end|T/side:x}`), never to another face of
///   `F`'s sweep, so one such edge makes the loop non-sketch;
/// - edges of later operations on the cap (fillet, chamfer, shell: their own ids);
/// - imported faces and any face or loop no sketch produced.
///
/// Pieces of the sweep's own edges keep their provenance through booleans (split pieces
/// share the key); a loop made only of them is one of the region's loops (the region's
/// loops are disjoint simple closed curves), never a smaller one.
///
/// **Assumption:** a cap loop keeps the geometry the sweep gave it as long as its keys
/// are unchanged. An operation that moves a cap loop's edges while keeping their keys —
/// SPEC §5.2 `draft` keeps the keys of the faces it tilts (not implemented; optional in
/// v1) — must not reach this relaxation: it has to re-establish the loop's area itself
/// or give its edges new keys.
fn is_sketch_region_loop(body: &Body, face: &Face, lp: &Loop) -> bool {
    let fp = &face.provenance;
    if !is_sweep_cap_role(&fp.role) {
        return false;
    }
    let name = fp.name();
    lp.coedges.iter().all(|&cid| {
        body.coedge(cid)
            .and_then(|c| body.edge(c.edge))
            .is_some_and(|e| {
                let p = &e.provenance;
                let other = match p.sources.as_slice() {
                    [a, b] if *a == name => b,
                    [a, b] if *b == name => a,
                    _ => return false,
                };
                p.role == Role::EdgeBetween
                    && p.feature == fp.feature
                    && *other != name
                    && is_sweep_face_name(&fp.feature, other)
            })
    })
}

/// The cap roles of a sweep: an extrude's caps, a revolve's end caps.
fn is_sweep_cap_role(role: &Role) -> bool {
    matches!(
        role,
        Role::CapStart | Role::CapEnd | Role::EndCapStart | Role::EndCapEnd
    )
}

/// `true` if `name` (a rendered [`Provenance::name`]) names a face of the sweep
/// `feature`: `feature/side[:leaves]` or one of its caps, maybe with an instance index
/// `#k`. Feature names and leaves contain no reserved character, so the name parses
/// uniquely (`polyx/side:a` is not a face of `poly`, `poly/blend:{…}` is no sweep face).
fn is_sweep_face_name(feature: &str, name: &str) -> bool {
    let Some(rest) = name.strip_prefix(feature).and_then(|r| r.strip_prefix('/')) else {
        return false;
    };
    let role = match rest.split_once('#') {
        Some((role, k)) if !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()) => role,
        Some(_) => return false,
        None => rest,
    };
    match role {
        "side" | "cap:start" | "cap:end" | "endcap:start" | "endcap:end" => true,
        _ => role
            .strip_prefix("side:")
            .is_some_and(|leaves| !leaves.is_empty() && !leaves.contains(RESERVED_LEAF_CHARS)),
    }
}

/// Characters a rendered `leaves` part never contains (`+` joins the leaves).
const RESERVED_LEAF_CHARS: &[char] = &['/', ':', '{', '}', '|', '#'];

/// Twice the signed area of a closed polygon (shoelace; positive if counter-clockwise),
/// summed relative to the first point: a small loop far from the plane origin keeps its
/// accuracy (the differences of nearby coordinates are exact). Used for the sampled
/// polygon of a planar loop and the chord polygon of its exact area.
fn polygon_twice_signed_area(pts: &[Vec2]) -> f64 {
    let n = pts.len();
    let Some(&o) = pts.first() else {
        return 0.0;
    };
    (0..n)
        .map(|i| (pts[i] - o).perp_dot(pts[(i + 1) % n] - o))
        .sum()
}

/// Orientation of a closed sampled polygon: `1` counter-clockwise, `-1` clockwise.
///
/// Decided exactly with [`orient2d`] at the lexicographically smallest vertex, which is
/// convex for a simple polygon (the same rule as forge-mesh's ring orientation). Only
/// when that corner is flat (collinear neighbours) does the sign of `area` (the
/// conditioned shoelace area, non-zero after the degeneracy check) decide. Returns `0`
/// for fewer than 3 points or when both are zero.
fn polygon_orientation(pts: &[Vec2], area: f64) -> i32 {
    let n = pts.len();
    if n < 3 {
        return 0;
    }
    let mut k = 0;
    for i in 1..n {
        let (a, b) = (pts[i], pts[k]);
        if a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)) == Ordering::Less {
            k = i;
        }
    }
    let o = orient2d(pts[(k + n - 1) % n], pts[k], pts[(k + 1) % n]);
    let s = if o != 0.0 { o } else { area };
    if s > 0.0 {
        1
    } else if s < 0.0 {
        -1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geom::{Curve3, Line3, Plane};
    use crate::linalg::{Frame, Vec3};
    use crate::topo::BodyBuilder;

    /// One planar face (open shell) bounded by the polygon `corners` (plane z = 0, world
    /// frame, so plane coordinates are the x, y of the corners).
    fn polygon_face(corners: &[[f64; 2]], sense: bool) -> Body {
        const F: &str = "poly";
        let n = corners.len();
        let p = |i: usize| Vec3::new(corners[i % n][0], corners[i % n][1], 0.0);
        let side = |i: usize| Provenance::side(F, format!("s{}", i % n)).name();
        let mut b = BodyBuilder::new();
        let vs: Vec<_> = (0..n)
            .map(|i| {
                b.add_vertex(p(i), Provenance::vertex_at(F, [side(i + n - 1), side(i)]))
                    .expect("vertex")
            })
            .collect();
        let es: Vec<_> = (0..n)
            .map(|i| {
                let line = Line3::through(p(i), p(i + 1)).expect("distinct corners");
                let len = p(i).distance(p(i + 1));
                let prov = Provenance::edge_between(F, Provenance::cap_end(F).name(), side(i));
                b.add_edge(Curve3::Line(line), (0.0, len), vs[i], vs[(i + 1) % n], prov)
                    .expect("edge")
            })
            .collect();
        let shell = b.add_shell(false);
        let face = b
            .add_face(
                shell,
                Surface::Plane(Plane::new(Frame::world())),
                sense,
                Provenance::cap_end(F),
            )
            .expect("face");
        let uses: Vec<_> = es.iter().map(|&e| (e, true)).collect();
        b.add_loop(face, &uses).expect("closed loop");
        b.finish()
    }

    fn loop_codes(body: &Body) -> Vec<IssueCode> {
        validate(body)
            .into_iter()
            .map(|i| i.code)
            .filter(|c| matches!(c, IssueCode::LoopOrientation | IssueCode::LoopDegenerate))
            .collect()
    }

    /// Deterministic placements about 1e5 mm from the plane origin, with "random"
    /// fractional parts (a fixed LCG), so the absolute coordinates carry ~1e-11 ulps.
    fn far_offsets(count: usize) -> Vec<[f64; 2]> {
        let mut s = 0x2545_f491_4f6c_dd1du64;
        let mut next = || {
            s = s
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (s >> 11) as f64 / (1u64 << 53) as f64
        };
        (0..count)
            .map(|_| [1e5 * (1.0 + next()), -1e5 * (1.0 + next())])
            .collect()
    }

    /// Audit finding L1: a 1e-3 mm square far from the plane origin. A plain shoelace in
    /// absolute plane coordinates cancels catastrophically (terms ~1e10, area 1e-6) and
    /// gets the orientation wrong or zero for most placements.
    #[test]
    fn tiny_square_far_from_the_plane_origin_has_the_right_orientation() {
        let h = 1e-3;
        for [x, y] in far_offsets(400) {
            let ccw = [[x, y], [x + h, y], [x + h, y + h], [x, y + h]];
            // Outer loop counter-clockwise on a face with sense = true: valid.
            let ok = polygon_face(&ccw, true);
            assert_eq!(loop_codes(&ok), [], "square at ({x}, {y})");
            // The same loop on the flipped face: exactly one orientation error.
            let flipped = polygon_face(&ccw, false);
            assert_eq!(
                loop_codes(&flipped),
                [IssueCode::LoopOrientation],
                "square at ({x}, {y})"
            );
        }
    }

    #[test]
    fn well_formed_polygon_face_validates_cleanly() {
        let body = polygon_face(&[[0.0, 0.0], [4.0, 0.0], [4.0, 3.0], [0.0, 3.0]], true);
        let issues = validate(&body);
        assert!(issues.is_empty(), "{issues:#?}");
    }

    /// A sliver whose area is non-zero but at most tolerance² is degenerate, as in the
    /// sketch stage (SPEC §3.1); the old `== 0.0` test let it through.
    #[test]
    fn loop_with_area_at_most_tolerance_squared_is_degenerate() {
        // Area = ½ · 4e-6 · 2.5e-7 = 5e-13 ≤ (1e-6)².
        let sliver = polygon_face(&[[0.0, 0.0], [4e-6, 0.0], [2e-6, 2.5e-7]], true);
        let issues = validate(&sliver);
        let deg: Vec<_> = issues
            .iter()
            .filter(|i| i.code == IssueCode::LoopDegenerate)
            .collect();
        assert_eq!(deg.len(), 1, "{issues:#?}");
        let tol = crate::Tolerance::IR_DEFAULT.linear;
        assert_eq!(deg[0].allowed, Some(tol * tol));
        assert!(deg[0].measured.is_some_and(|a| a > 0.0 && a <= tol * tol));
        // Well above tol²: not degenerate (and correctly oriented).
        let thin = polygon_face(&[[0.0, 0.0], [4e-6, 0.0], [2e-6, 1e-6]], true);
        assert_eq!(loop_codes(&thin), []);
    }

    #[test]
    fn orientation_is_exact_at_the_lexicographic_minimum() {
        // A clockwise L-shape far from the origin with a reflex corner.
        let (x, y) = (123_456.789, -98_765.432_1);
        let cw = [
            [x, y],
            [x, y + 2e-3],
            [x + 1e-3, y + 2e-3],
            [x + 1e-3, y + 1e-3],
            [x + 2e-3, y + 1e-3],
            [x + 2e-3, y],
        ];
        let pts: Vec<Vec2> = cw.iter().map(|p| Vec2::new(p[0], p[1])).collect();
        let area = 0.5 * polygon_twice_signed_area(&pts);
        assert!(area < 0.0 && (area + 3e-6).abs() < 1e-12, "{area}");
        assert_eq!(polygon_orientation(&pts, area), -1);
        let ccw: Vec<Vec2> = pts.iter().rev().copied().collect();
        assert_eq!(polygon_orientation(&ccw, -area), 1);
        // A flat corner at the minimum (both neighbours on one ray: a spike) falls back
        // to the sign of the area.
        let spike = [
            Vec2::new(0.0, 0.0),
            Vec2::new(2.0, 0.0),
            Vec2::new(2.0, 1.0),
            Vec2::new(1.0, 0.0),
        ];
        let a = 0.5 * polygon_twice_signed_area(&spike);
        assert!((a - 0.5).abs() < 1e-15, "{a}");
        assert_eq!(polygon_orientation(&spike, a), 1);
        assert_eq!(polygon_orientation(&spike, -a), -1);
    }

    /// The sweep-face names of `is_sketch_region_loop` (review finding: a body op's
    /// section edge on its own cap names a target's face, never one of the sweep's).
    #[test]
    fn sweep_face_names_parse_exactly() {
        let f = "poly";
        let own = [
            Provenance::cap_start(f),
            Provenance::cap_end(f),
            Provenance::end_cap_start(f),
            Provenance::end_cap_end(f),
            Provenance::new(f, Role::Side),
            Provenance::side(f, "s0"),
            Provenance::side(f, "outline.bottom"),
            Provenance::new(f, Role::Side).with_sources(["b", "a"]),
            Provenance::side(f, "s1").with_index(3),
            Provenance::cap_end(f).with_index(12).with_qualifier("m"),
        ];
        for p in &own {
            assert!(is_sweep_face_name(f, &p.name()), "{}", p.name());
        }
        let not_own = [
            // Another feature, also one whose id starts with `poly`.
            Provenance::side("target", "c0"),
            Provenance::side("polyx", "s0"),
            Provenance::cap_end("po"),
            // A face of `poly` no sweep makes, and non-face names.
            Provenance::new(f, Role::Other("wall".into())).with_sources(["s0"]),
            Provenance::new(f, Role::Other("sidewall".into())),
            Provenance::new(f, Role::Imported).with_sources(["f1"]),
            Provenance::edge_between(f, "poly/cap:end", "poly/side:s0"),
            Provenance::vertex_at(f, ["poly/cap:end"]),
        ];
        for p in &not_own {
            assert!(!is_sweep_face_name(f, &p.name()), "{}", p.name());
        }
        for bad in [
            "",
            "poly",
            "poly/",
            "poly/side:",
            "poly/side:a/b",
            "poly/side:{a}",
            "poly/cap:end#",
            "poly/cap:end#x",
            "poly/cap:end#1#2",
            "poly/side:a:b",
            "poly/cap:ends",
            "poly/sides",
            "xpoly/side:a",
            "poly//side:a",
        ] {
            assert!(!is_sweep_face_name(f, bad), "{bad:?}");
        }
    }
}
