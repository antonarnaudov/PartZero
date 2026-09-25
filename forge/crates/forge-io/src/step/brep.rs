//! Forge B-rep → STEP topology (ADR 0012 on export).
//!
//! Forge has no seam edges, no degenerate edges and allows ring edges without vertices;
//! STEP readers expect the opposite. This module computes the STEP-side topology of one
//! body without touching the body:
//!
//! 1. **Singular points.** An edge whose interior passes through a pole or apex of an
//!    adjacent face's surface is split there, so every loop reaches a singular point only
//!    at a vertex (readers add their degenerate edges there).
//! 2. **Seams.** Every face on a periodic surface (cylinder, cone, sphere, torus) is
//!    analysed in its parameter plane: each loop is sampled, projected and *unwrapped*
//!    (the `u` jump along a singular line follows the face orientation, so loops through
//!    poles are handled), giving winding numbers and signed areas. A face whose loops wind
//!    around the axis, or that contains a pole, is cut along one iso-parametric **seam**
//!    that joins its winding loops (or a loop and a pole, or the two poles); a whole torus
//!    gets two seam circles through one vertex. The seam line is chosen among
//!    deterministic candidates — preferably through existing vertices, never across a
//!    hole — and its crossing points become vertices. The seam is used twice by the face,
//!    in opposite directions, and the face's winding loops are merged with it into one
//!    outer loop.
//! 3. **Ring edges** get one vertex (where a seam crosses them, else at the start of
//!    their parameter range); an edge crossed at several points is split into pieces
//!    shared by both adjacent faces.
//! 4. **Shells.** A body's first shell is its outer shell; further shells are classified
//!    by the sign of their enclosed volume (from a tessellation) into voids
//!    (`BREP_WITH_VOIDS`) or further lumps (one solid each).
//!
//! Anything this cannot represent faithfully is a structured [`StepError`], never a guess.

use std::collections::BTreeMap;

use forge_core::geom::{Circle3, Cone, Curve3, Cylinder, Line3, Sphere, Surface, Torus};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::math;
use forge_core::topo::{Body, EdgeId, FaceId, LoopId, VertexId};

use super::StepError;

const TAU: f64 = math::TAU;
const PI: f64 = math::PI;
/// Uniform samples per coedge before adaptive refinement.
const SAMPLES_PER_COEDGE: usize = 16;
/// Largest parameter jump between neighbouring samples (radians) after refinement.
const MAX_PARAM_STEP: f64 = PI / 8.0;
/// Refinement depth limit (bisections of one sample interval).
const MAX_REFINE_DEPTH: u32 = 48;
/// Number of evenly spaced fallback seam positions tried after the preferred ones.
const GRID_CANDIDATES: usize = 48;

/// The STEP-side topology of one body.
pub(crate) struct Topo {
    /// Vertex positions (original vertices first, in arena order, then new ones).
    pub vertices: Vec<Point3>,
    /// Edges (pieces of Forge edges, then seams).
    pub edges: Vec<TEdge>,
    /// Seam curves, indexed by [`TCurve::Seam`].
    pub seam_curves: Vec<Curve3>,
    /// Faces, in shell order.
    pub faces: Vec<TFace>,
    /// Solids (one per lump).
    pub solids: Vec<TSolid>,
    /// Largest edge/vertex tolerance of the body (at least the IR's 1e-6 mm).
    pub tolerance: f64,
    /// What was synthesized.
    pub stats: TopoStats,
}

/// Counts of what the conversion added.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct TopoStats {
    /// Seam edges.
    pub seams: usize,
    /// Extra edge pieces from splitting Forge edges.
    pub split_pieces: usize,
    /// Vertices added (ring vertices, seam crossings, poles, splits).
    pub new_vertices: usize,
    /// Void shells.
    pub voids: usize,
}

/// A STEP edge: `EDGE_CURVE(start, end, curve, .T.)`.
#[derive(Clone, Copy, Debug)]
pub(crate) struct TEdge {
    pub start: usize,
    pub end: usize,
    pub curve: TCurve,
    /// Curve parameters at `start` and `end` for a piece of a Forge edge (increasing; a
    /// ring's last piece ends one period after the first point).
    pub t: (f64, f64),
}

/// The curve of a [`TEdge`].
#[derive(Clone, Copy, Debug)]
pub(crate) enum TCurve {
    /// The (piece of the) Forge edge's curve.
    Edge(EdgeId),
    /// A synthesized seam curve.
    Seam(usize),
}

/// A STEP face.
#[derive(Clone, Debug)]
pub(crate) struct TFace {
    pub face: FaceId,
    /// `ADVANCED_FACE.same_sense`.
    pub same_sense: bool,
    pub bounds: Vec<TBound>,
    /// For a face on a surface periodic in `u`: the `u` (in the Forge surface's
    /// parametrization) that the written surface's frame puts at `u = 0` — the seam, or the
    /// middle of the face's gap — so readers that project edges into `[0, 2π)` never see the
    /// face straddle the period boundary.
    pub u_origin: Option<f64>,
    /// For a face on a surface periodic in `v` (a ring torus): pcurves are placed in
    /// `[v_origin, v_origin + 2π)` (the seam, or the middle of the face's gap).
    pub v_origin: Option<f64>,
}

/// A face bound: oriented edges `(edge, forward)`.
#[derive(Clone, Debug)]
pub(crate) struct TBound {
    pub edges: Vec<(usize, bool)>,
    /// `FACE_OUTER_BOUND` rather than `FACE_BOUND`.
    pub outer: bool,
    /// `FACE_BOUND.orientation`.
    pub orientation: bool,
}

/// A solid: its outer shell and voids, as face indices.
#[derive(Clone, Debug)]
pub(crate) struct TSolid {
    pub outer: Vec<usize>,
    pub voids: Vec<Vec<usize>>,
}

fn wrap_pi(x: f64) -> f64 {
    // Into (−π, π].
    let r = math::rem_euclid(x + PI, TAU) - PI;
    if r <= -PI { r + TAU } else { r }
}

/// The unwrapped `u` step across a singular line (pole, apex): the loop runs along that
/// line with the face on its left, i.e. towards −u at an upper line and +u at a lower
/// one when the face follows the surface normal (and the reverse otherwise).
fn pole_delta(raw: f64, upper: bool, sense: bool) -> f64 {
    let r = math::rem_euclid(raw, TAU);
    if upper == sense {
        if r > 0.0 { r - TAU } else { 0.0 }
    } else {
        r
    }
}

fn e_r(f: &Frame, u: f64) -> Vec3 {
    let (s, c) = math::sin_cos(u);
    f.x() * c + f.y() * s
}

/// One end of a face's `v` range (non-periodic `v`).
#[derive(Clone, Copy, Debug)]
struct End {
    /// The singular point there, if the end is a pole/apex (else the end is open).
    point: Option<Point3>,
    v: f64,
}

/// A face's parameter chart for the seam analysis.
struct Chart<'a> {
    surface: &'a Surface,
    sense: bool,
    v_periodic: bool,
    /// Lower and upper `v` ends (bands only).
    ends: (End, End),
    /// Distance under which a point is at a singular point.
    sing_tol: f64,
}

impl Chart<'_> {
    fn uv(&self, p: Point3) -> (f64, f64) {
        let (u, v, _) = self.surface.project(p);
        (u, v)
    }
    /// `Some(upper)` when `p` is at the singular point of the upper/lower end.
    fn singular(&self, p: Point3) -> Option<bool> {
        let (lo, hi) = self.ends;
        if let Some(q) = lo.point
            && p.distance(q) <= self.sing_tol
        {
            return Some(false);
        }
        if let Some(q) = hi.point
            && p.distance(q) <= self.sing_tol
        {
            return Some(true);
        }
        None
    }
}

#[derive(Clone, Copy, Debug)]
struct Smp {
    /// Raw (projected) parameters.
    u: f64,
    v: f64,
    /// Unwrapped parameters.
    uu: f64,
    vv: f64,
    /// Coedge index in the loop.
    coedge: usize,
    /// Edge parameter.
    t: f64,
    /// Existing vertex at this sample.
    point: Option<usize>,
    /// `Some(upper)` at a singular point.
    sing: Option<bool>,
}

struct LoopInfo {
    /// Samples, closed: the last is the first again (shifted by the windings).
    smp: Vec<Smp>,
    /// Coedge traversal ranges `(t_start, t_end)`.
    ranges: Vec<(f64, f64)>,
    /// Coedge edges.
    edges: Vec<EdgeId>,
    wu: i64,
    wv: i64,
    /// Shoelace area of the unwrapped polygon (sense-adjusted: > 0 encloses the face).
    area: f64,
    extent_u: f64,
}

/// Where a seam line crosses a loop.
#[derive(Clone, Copy, Debug)]
struct Cross {
    coedge: usize,
    t: f64,
    /// Existing vertex at the crossing.
    at: Option<usize>,
    /// The other (unwrapped) parameter at the crossing.
    other: f64,
}

/// The crossings of one seam line with every loop (`all[i]` for loop `i`, `other` the
/// parameter along the line): the segment inside the face that joins winding loops `a` and
/// `b`, as `[crossing on a, crossing on b]`. The line starts outside the face (a band is
/// bounded along it), so sorted by `other` its crossings alternate entering and leaving:
/// segments `(0, 1)`, `(2, 3)`, … are inside. The lowest such segment whose ends lie on `a`
/// and `b` (one each) is the seam: cutting a band along a segment that joins its two
/// boundary loops leaves one disc. `None` when no segment does, or when two crossings
/// coincide.
fn band_segment(all: &[Vec<Cross>], a: usize, b: usize) -> Option<[Cross; 2]> {
    let mut xs: Vec<(f64, usize, Cross)> = all
        .iter()
        .enumerate()
        .flat_map(|(i, cr)| cr.iter().map(move |x| (x.other, i, *x)))
        .collect();
    xs.sort_by(|p, q| p.0.total_cmp(&q.0).then(p.1.cmp(&q.1)));
    if xs.windows(2).any(|w| w[0].0.to_bits() == w[1].0.to_bits()) || !xs.len().is_multiple_of(2) {
        return None;
    }
    xs.chunks_exact(2).find_map(|w| match (w[0].1, w[1].1) {
        (i, j) if i == a && j == b => Some([w[0].2, w[1].2]),
        (i, j) if i == b && j == a => Some([w[1].2, w[0].2]),
        _ => None,
    })
}

/// A seam end.
#[derive(Clone, Copy, Debug)]
enum SeamEnd {
    /// On loop `lp` (index into the face's loops) at a crossing.
    Loop {
        lp: usize,
        coedge: usize,
        vertex: usize,
    },
    /// At a singular point.
    Pole { vertex: usize },
}

impl SeamEnd {
    fn vertex(&self) -> usize {
        match *self {
            SeamEnd::Loop { vertex, .. } | SeamEnd::Pole { vertex } => vertex,
        }
    }
}

enum FacePlan {
    /// One seam (index into `seam_curves`) from `lower` to `upper`.
    Seam {
        curve: usize,
        lower: SeamEnd,
        upper: SeamEnd,
    },
    /// A whole ring torus: iso-u and iso-v seam circles through one vertex.
    FullTorus {
        iso_u: usize,
        iso_v: usize,
        vertex: usize,
    },
}

struct Builder<'a> {
    body: &'a Body,
    ctx: &'a str,
    tol: f64,
    vertices: Vec<Point3>,
    vmap: BTreeMap<VertexId, usize>,
    /// Points added on edges: `(t, vertex)`.
    pts: BTreeMap<EdgeId, Vec<(f64, usize)>>,
    seam_curves: Vec<Curve3>,
    plans: BTreeMap<FaceId, FacePlan>,
    u_origin: BTreeMap<FaceId, f64>,
    v_origin: BTreeMap<FaceId, f64>,
    stats: TopoStats,
}

/// Build the STEP topology of `body` (`name` is used in messages).
pub(crate) fn build(body: &Body, name: &str) -> Result<Topo, StepError> {
    let mut b = Builder::new(body, name)?;
    b.split_at_singular_points()?;
    let faces: Vec<FaceId> = body.faces().ids().collect();
    for fid in faces {
        b.plan_face(fid)?;
    }
    b.ring_vertices()?;
    b.finish()
}

impl<'a> Builder<'a> {
    fn new(body: &'a Body, ctx: &'a str) -> Result<Self, StepError> {
        let mut tol = forge_core::tolerance::IR_LINEAR_TOLERANCE;
        let mut vertices = Vec::new();
        let mut vmap = BTreeMap::new();
        for (vid, v) in body.vertices().iter() {
            if !v.point.is_finite() {
                return Err(invalid(
                    ctx,
                    format!("vertex {} is not finite", v.provenance.name()),
                ));
            }
            tol = tol.max(v.tolerance);
            vmap.insert(vid, vertices.len());
            vertices.push(v.point);
        }
        for e in body.edges().values() {
            tol = tol.max(e.tolerance);
        }
        if !tol.is_finite() {
            return Err(invalid(ctx, "non-finite tolerance".into()));
        }
        Ok(Builder {
            body,
            ctx,
            tol,
            vertices,
            vmap,
            pts: BTreeMap::new(),
            seam_curves: Vec::new(),
            plans: BTreeMap::new(),
            u_origin: BTreeMap::new(),
            v_origin: BTreeMap::new(),
            stats: TopoStats::default(),
        })
    }

    fn face_name(&self, fid: FaceId) -> String {
        self.body
            .face(fid)
            .map_or_else(|| "a face".to_string(), |f| f.provenance.name())
    }

    fn seam_err(&self, fid: FaceId, detail: impl Into<String>) -> StepError {
        StepError::UnsupportedSeam {
            body: self.ctx.to_string(),
            face: self.face_name(fid),
            detail: detail.into(),
        }
    }

    fn new_vertex(&mut self, p: Point3) -> usize {
        self.vertices.push(p);
        self.stats.new_vertices += 1;
        self.vertices.len() - 1
    }

    /// Ensure a vertex on edge `eid` at parameter `t` (reusing an existing one within
    /// tolerance); returns its index.
    fn point_on_edge(&mut self, eid: EdgeId, t: f64) -> Result<usize, StepError> {
        let e = self
            .body
            .edge(eid)
            .ok_or_else(|| invalid(self.ctx, "stale edge id".into()))?;
        // Ring parameters live in [t0, t1); evaluate there (C(2π) is not exactly C(0)).
        let t = if e.is_ring() {
            let (t0, t1) = e.t_range;
            t0 + math::rem_euclid(t - t0, t1 - t0)
        } else {
            t
        };
        let p = e.curve.eval(t);
        let near = self.tol.max(e.tolerance);
        for v in [e.start, e.end].into_iter().flatten() {
            let vi = self.vmap[&v];
            if self.vertices[vi].distance(p) <= near {
                return Ok(vi);
            }
        }
        if let Some(list) = self.pts.get(&eid) {
            for &(_, vi) in list {
                if self.vertices[vi].distance(p) <= near {
                    return Ok(vi);
                }
            }
        }
        let vi = self.new_vertex(p);
        self.pts.entry(eid).or_default().push((t, vi));
        Ok(vi)
    }

    /// Existing vertex at parameter `t` of edge `eid`, if any (within tolerance).
    fn existing_point(&self, eid: EdgeId, p: Point3) -> Option<usize> {
        let e = self.body.edge(eid)?;
        let near = self.tol.max(e.tolerance);
        for v in [e.start, e.end].into_iter().flatten() {
            let vi = self.vmap[&v];
            if self.vertices[vi].distance(p) <= near {
                return Some(vi);
            }
        }
        self.pts
            .get(&eid)?
            .iter()
            .find(|&&(_, vi)| self.vertices[vi].distance(p) <= near)
            .map(|&(_, vi)| vi)
    }

    // -----------------------------------------------------------------------------------
    // 1. Singular points
    // -----------------------------------------------------------------------------------

    fn singular_points(s: &Surface) -> Vec<Point3> {
        match s {
            Surface::Cone(c) => vec![c.apex()],
            Surface::Sphere(sp) => {
                let f = sp.frame();
                vec![
                    f.origin() - f.z() * sp.radius(),
                    f.origin() + f.z() * sp.radius(),
                ]
            }
            Surface::Torus(t) => match t.spindle_v_range() {
                Some((v0, v1)) => vec![t.eval(0.0, v0), t.eval(0.0, v1)],
                None => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    fn split_at_singular_points(&mut self) -> Result<(), StepError> {
        let body = self.body;
        for (fid, face) in body.faces().iter() {
            let sing = Self::singular_points(&face.surface);
            if sing.is_empty() {
                continue;
            }
            for eid in body.face_edges(fid) {
                let Some(e) = body.edge(eid) else { continue };
                for &q in &sing {
                    let (t, d) = e.curve.project(q);
                    if d > self.tol.max(e.tolerance) {
                        continue;
                    }
                    let (t0, t1) = e.t_range;
                    let t = match e.curve.period() {
                        Some(per) => t0 + math::rem_euclid(t - t0, per),
                        None => t,
                    };
                    if !(e.is_ring() || t > t0 && t < t1) {
                        continue;
                    }
                    // Not at an end vertex already.
                    let at_end = [e.start, e.end].into_iter().flatten().any(|v| {
                        self.vertices[self.vmap[&v]].distance(q) <= self.tol.max(e.tolerance)
                    });
                    if at_end {
                        continue;
                    }
                    self.point_on_edge(eid, t)?;
                }
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------------------
    // 2. Seams
    // -----------------------------------------------------------------------------------

    fn chart<'s>(
        &self,
        fid: FaceId,
        s: &'s Surface,
        sense: bool,
    ) -> Result<Option<Chart<'s>>, StepError> {
        let open_lo = End {
            point: None,
            v: f64::NEG_INFINITY,
        };
        let open_hi = End {
            point: None,
            v: f64::INFINITY,
        };
        let sing_tol = 4.0 * self.tol;
        let (v_periodic, ends) = match s {
            Surface::Plane(_) | Surface::Helicoid(_) | Surface::BSpline(_) => return Ok(None),
            Surface::Cylinder(_) => (false, (open_lo, open_hi)),
            Surface::Cone(c) => {
                let apex = End {
                    point: Some(c.apex()),
                    v: c.apex_v(),
                };
                // Which nappe the face uses: from a point of its boundary away from the apex.
                let v = self.face_sample_v(fid, s, c.apex());
                match v {
                    Some(v) if v < c.apex_v() => (false, (open_lo, apex)),
                    _ => (false, (apex, open_hi)),
                }
            }
            Surface::Sphere(sp) => {
                let f = sp.frame();
                (
                    false,
                    (
                        End {
                            point: Some(f.origin() - f.z() * sp.radius()),
                            v: -math::FRAC_PI_2,
                        },
                        End {
                            point: Some(f.origin() + f.z() * sp.radius()),
                            v: math::FRAC_PI_2,
                        },
                    ),
                )
            }
            Surface::Torus(t) => match t.spindle_v_range() {
                Some((v0, v1)) => (
                    false,
                    (
                        End {
                            point: Some(t.eval(0.0, v0)),
                            v: v0,
                        },
                        End {
                            point: Some(t.eval(0.0, v1)),
                            v: v1,
                        },
                    ),
                ),
                None => (true, (open_lo, open_hi)),
            },
        };
        Ok(Some(Chart {
            surface: s,
            sense,
            v_periodic,
            ends,
            sing_tol,
        }))
    }

    /// `v` of some boundary point of a face that is away from `avoid` (for the cone's
    /// nappe).
    fn face_sample_v(&self, fid: FaceId, s: &Surface, avoid: Point3) -> Option<f64> {
        for eid in self.body.face_edges(fid) {
            let e = self.body.edge(eid)?;
            let (t0, t1) = e.t_range;
            for k in 1..8 {
                let p = e.curve.eval(t0 + (t1 - t0) * f64::from(k) / 8.0);
                if p.distance(avoid) > 16.0 * self.tol {
                    return Some(s.project(p).1);
                }
            }
        }
        None
    }

    fn make_smp(
        &self,
        ch: &Chart<'_>,
        p: Point3,
        coedge: usize,
        t: f64,
        point: Option<usize>,
    ) -> Smp {
        let sing = ch.singular(p);
        let (u, v) = if sing.is_some() { (0.0, 0.0) } else { ch.uv(p) };
        Smp {
            u,
            v,
            uu: 0.0,
            vv: 0.0,
            coedge,
            t,
            point,
            sing,
        }
    }

    fn big_step(ch: &Chart<'_>, a: &Smp, b: &Smp) -> bool {
        if a.sing.is_some() || b.sing.is_some() {
            return false;
        }
        wrap_pi(b.u - a.u).abs() > MAX_PARAM_STEP
            || (ch.v_periodic && wrap_pi(b.v - a.v).abs() > MAX_PARAM_STEP)
    }

    #[allow(clippy::too_many_arguments)]
    fn refine(
        &self,
        ch: &Chart<'_>,
        curve: &Curve3,
        a: Smp,
        b: Smp,
        depth: u32,
        out: &mut Vec<Smp>,
        fid: FaceId,
    ) -> Result<(), StepError> {
        if !Self::big_step(ch, &a, &b) {
            return Ok(());
        }
        if depth >= MAX_REFINE_DEPTH {
            return Err(self.seam_err(
                fid,
                "a boundary curve passes too close to a singular point of the surface",
            ));
        }
        let tm = 0.5 * (a.t + b.t);
        let m = self.make_smp(ch, curve.eval(tm), a.coedge, tm, None);
        self.refine(ch, curve, a, m, depth + 1, out, fid)?;
        out.push(m);
        self.refine(ch, curve, m, b, depth + 1, out, fid)
    }

    fn sample_loop(&self, fid: FaceId, ch: &Chart<'_>, lid: LoopId) -> Result<LoopInfo, StepError> {
        let body = self.body;
        let lp = body
            .loop_(lid)
            .ok_or_else(|| invalid(self.ctx, "stale loop id".into()))?;
        let mut smp: Vec<Smp> = Vec::new();
        let mut ranges = Vec::new();
        let mut edges = Vec::new();
        for (k, &cid) in lp.coedges.iter().enumerate() {
            let c = body
                .coedge(cid)
                .ok_or_else(|| invalid(self.ctx, "stale coedge id".into()))?;
            let e = body
                .edge(c.edge)
                .ok_or_else(|| invalid(self.ctx, "stale edge id".into()))?;
            let (t0, t1) = e.t_range;
            let (ts, te) = if c.forward { (t0, t1) } else { (t1, t0) };
            ranges.push((ts, te));
            edges.push(c.edge);
            let start_v = if c.forward { e.start } else { e.end };
            let end_v = if c.forward { e.end } else { e.start };
            // Parameters in traversal order, with the points already on the edge.
            let mut ps: Vec<(f64, Option<usize>)> = Vec::with_capacity(SAMPLES_PER_COEDGE + 4);
            ps.push((ts, start_v.map(|v| self.vmap[&v])));
            for i in 1..SAMPLES_PER_COEDGE {
                ps.push((
                    ts + (te - ts) * (i as f64) / (SAMPLES_PER_COEDGE as f64),
                    None,
                ));
            }
            if let Some(list) = self.pts.get(&c.edge) {
                for &(t, vi) in list {
                    if e.is_ring() {
                        // Ring points are stored in [t0, t1); place them on this traversal.
                        let off = math::rem_euclid(t - t0, t1 - t0);
                        if off == 0.0 {
                            ps[0].1 = Some(vi);
                        } else {
                            ps.push((t0 + off, Some(vi)));
                        }
                    } else if (t - ts) * (te - t) > 0.0 {
                        ps.push((t, Some(vi)));
                    }
                }
            }
            let dir = if te >= ts { 1.0 } else { -1.0 };
            ps.sort_by(|a, b| (dir * a.0).total_cmp(&(dir * b.0)).then(b.1.cmp(&a.1)));
            ps.dedup_by(|b, a| a.0.to_bits() == b.0.to_bits());
            let mut coedge_smp: Vec<Smp> = Vec::with_capacity(ps.len() * 2);
            for &(t, pt) in &ps {
                let p = pt.map_or_else(|| e.curve.eval(t), |vi| self.vertices[vi]);
                coedge_smp.push(self.make_smp(ch, p, k, t, pt));
            }
            // The end (the next coedge's start) bounds the last refinement interval.
            let end_p = end_v.map_or_else(|| e.curve.eval(te), |v| self.vertices[self.vmap[&v]]);
            let end_s = self.make_smp(ch, end_p, k, te, None);
            for i in 0..coedge_smp.len() {
                let a = coedge_smp[i];
                let b = if i + 1 < coedge_smp.len() {
                    coedge_smp[i + 1]
                } else {
                    end_s
                };
                smp.push(a);
                if a.sing.is_some() {
                    // Singular runs always have two entries: arrival and departure.
                    smp.push(a);
                }
                self.refine(ch, &e.curve, a, b, 0, &mut smp, fid)?;
            }
        }
        self.unwrap_loop(fid, ch, smp, ranges, edges)
    }

    fn unwrap_loop(
        &self,
        fid: FaceId,
        ch: &Chart<'_>,
        mut smp: Vec<Smp>,
        ranges: Vec<(f64, f64)>,
        edges: Vec<EdgeId>,
    ) -> Result<LoopInfo, StepError> {
        let Some(i0) = smp.iter().position(|s| s.sing.is_none()) else {
            return Err(self.seam_err(fid, "a boundary loop lies entirely at a singular point"));
        };
        smp.rotate_left(i0);
        let first = smp[0];
        smp.push(first);
        let n = smp.len() - 1;
        smp[0].uu = first.u;
        smp[0].vv = first.v;
        let mut last = 0usize;
        for i in 1..=n {
            if smp[i].sing.is_some() {
                continue;
            }
            let a = smp[last];
            let raw = smp[i].u - a.u;
            let du = match smp[last + 1..i].iter().find_map(|s| s.sing) {
                Some(upper) => pole_delta(raw, upper, ch.sense),
                None => wrap_pi(raw),
            };
            smp[i].uu = a.uu + du;
            smp[i].vv = if ch.v_periodic {
                a.vv + wrap_pi(smp[i].v - a.v)
            } else {
                smp[i].v
            };
            // Singular samples: arrival at the previous `u`, departure at the next.
            let (lo, hi) = ch.ends;
            for j in last + 1..i {
                let upper = smp[j].sing.unwrap_or(false);
                smp[j].vv = if upper { hi.v } else { lo.v };
                smp[j].uu = if j + 1 == i { smp[i].uu } else { a.uu };
            }
            last = i;
        }
        let du = smp[n].uu - smp[0].uu;
        let dv = smp[n].vv - smp[0].vv;
        let wu = (du / TAU).round();
        let wv = if ch.v_periodic {
            (dv / TAU).round()
        } else {
            0.0
        };
        if (du - wu * TAU).abs() > 1e-6 || (ch.v_periodic && (dv - wv * TAU).abs() > 1e-6) {
            return Err(self.seam_err(fid, "the winding of a boundary loop is ambiguous"));
        }
        smp[n].uu = smp[0].uu + wu * TAU;
        if ch.v_periodic {
            smp[n].vv = smp[0].vv + wv * TAU;
        }
        let mut area = 0.0;
        let (mut umin, mut umax) = (f64::MAX, f64::MIN);
        for w in smp.windows(2) {
            area += w[0].uu * w[1].vv - w[1].uu * w[0].vv;
        }
        for s in &smp {
            umin = umin.min(s.uu);
            umax = umax.max(s.uu);
        }
        let area = 0.5 * area * if ch.sense { 1.0 } else { -1.0 };
        Ok(LoopInfo {
            smp,
            ranges,
            edges,
            wu: wu as i64,
            wv: wv as i64,
            area,
            extent_u: umax - umin,
        })
    }

    /// Crossings of loop `li` with the lines `coord = c + 2πk`, or `None` if the loop
    /// touches a line in a way a seam cannot pass (along an edge, at a singular point).
    fn crossings(
        &self,
        ch: &Chart<'_>,
        li: &LoopInfo,
        c: f64,
        along_u: bool,
    ) -> Option<Vec<Cross>> {
        let coord = |s: &Smp| if along_u { s.uu } else { s.vv };
        let q = |x: f64| {
            let q = (x - c) / TAU;
            let r = q.round();
            if (q - r).abs() <= 1e-12 * (1.0 + q.abs()) {
                r
            } else {
                q
            }
        };
        let on_line = |x: f64| {
            let qq = q(x);
            qq.fract() == 0.0
        };
        let mut out = Vec::new();
        let n = li.smp.len() - 1;
        // Samples exactly on a line that a crossing accounts for (the closing sample is
        // the first one again).
        let mut consumed: Vec<usize> = Vec::new();
        for i in 0..n {
            let (a, b) = (li.smp[i], li.smp[i + 1]);
            let (qa, qb) = (q(coord(&a)), q(coord(&b)));
            if on_line(coord(&a)) && on_line(coord(&b)) && qa.to_bits() == qb.to_bits() {
                if a.sing.is_some() && b.sing.is_some() {
                    continue;
                }
                return None;
            }
            let (la, lb) = (qa.floor(), qb.floor());
            if la.to_bits() == lb.to_bits() {
                continue;
            }
            if (la - lb).abs() > 1.0 || a.sing.is_some() || b.sing.is_some() {
                return None;
            }
            let up = lb > la;
            let line = c + TAU * la.max(lb);
            let other = |s: &Smp| if along_u { s.vv } else { s.uu };
            if up && qb.to_bits() == lb.to_bits() {
                consumed.push((i + 1) % n);
                out.push(self.cross_at_sample(li, &b, other(&b)));
            } else if !up && qa.to_bits() == la.to_bits() {
                consumed.push(i);
                out.push(self.cross_at_sample(li, &a, other(&a)));
            } else {
                out.push(self.cross_between(ch, li, &a, &b, line, along_u)?);
            }
        }
        // A loop that touches a line without crossing it (at a vertex where it turns back)
        // would put that vertex on the seam: not a valid seam position.
        let touches = (0..n).any(|i| {
            let s = &li.smp[i];
            s.sing.is_none() && on_line(coord(s)) && !consumed.contains(&i)
        });
        if touches {
            return None;
        }
        Some(out)
    }

    fn cross_at_sample(&self, li: &LoopInfo, s: &Smp, other: f64) -> Cross {
        let eid = li.edges[s.coedge];
        let p = s.point.map_or_else(
            || {
                self.body
                    .edge(eid)
                    .map_or(Vec3::zero(), |e| e.curve.eval(s.t))
            },
            |vi| self.vertices[vi],
        );
        Cross {
            coedge: s.coedge,
            t: s.t,
            at: s.point.or_else(|| self.existing_point(eid, p)),
            other,
        }
    }

    fn cross_between(
        &self,
        ch: &Chart<'_>,
        li: &LoopInfo,
        a: &Smp,
        b: &Smp,
        line: f64,
        along_u: bool,
    ) -> Option<Cross> {
        let k = a.coedge;
        let eid = li.edges[k];
        let e = self.body.edge(eid)?;
        let ta = a.t;
        let (ts, te) = li.ranges[k];
        // `b` bounds the interval only if it follows `a` on the same coedge (the closing
        // sample of a one-coedge loop is the coedge's start again).
        let tb = if b.coedge == k && (b.t - ta) * (te - ts) > 0.0 {
            b.t
        } else {
            te
        };
        let (ra, ca) = if along_u { (a.u, a.uu) } else { (a.v, a.vv) };
        let f = |t: f64| {
            let (u, v) = ch.uv(e.curve.eval(t));
            let raw = if along_u { u } else { v };
            ca + wrap_pi(raw - ra) - line
        };
        let (mut lo, mut hi) = (ta, tb);
        let flo = f(lo);
        for _ in 0..80 {
            let mid = 0.5 * (lo + hi);
            if mid.to_bits() == lo.to_bits() || mid.to_bits() == hi.to_bits() {
                break;
            }
            if (f(mid) < 0.0) == (flo < 0.0) {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        let t = 0.5 * (lo + hi);
        let p = e.curve.eval(t);
        let (u, v) = ch.uv(p);
        let other = if along_u {
            if ch.v_periodic {
                a.vv + wrap_pi(v - a.v)
            } else {
                v
            }
        } else {
            a.uu + wrap_pi(u - a.u)
        };
        Some(Cross {
            coedge: k,
            t,
            at: self.existing_point(eid, p),
            other,
        })
    }

    /// Candidate seam positions for lines of `coord` through the winding loops `wind`.
    fn candidates(&self, loops: &[LoopInfo], wind: &[usize], along_u: bool) -> Vec<f64> {
        let mut out: Vec<f64> = Vec::new();
        let mut push = |x: f64| {
            let x = math::rem_euclid(x, TAU);
            if !out.iter().any(|y| y.to_bits() == x.to_bits()) {
                out.push(x);
            }
        };
        let raw = |s: &Smp| if along_u { s.u } else { s.v };
        for &w in wind {
            for s in &loops[w].smp {
                if s.point.is_some() && s.sing.is_none() {
                    push(raw(s));
                }
            }
        }
        for &w in wind {
            let li = &loops[w];
            for (k, eid) in li.edges.iter().enumerate() {
                let ring_without_points = self
                    .body
                    .edge(*eid)
                    .is_some_and(|e| e.is_ring() && self.pts.get(eid).is_none_or(Vec::is_empty));
                if ring_without_points
                    && let Some(s) = li.smp.iter().find(|s| s.coedge == k && s.sing.is_none())
                {
                    push(raw(s));
                }
            }
        }
        push(0.0);
        for k in 0..GRID_CANDIDATES {
            push(TAU * (k as f64 + 0.5) / GRID_CANDIDATES as f64);
        }
        out
    }

    /// The best seam position: every winding loop crossed exactly once, no other loop
    /// crossed; fewest edge splits, then the earliest candidate. With `segment` (a band
    /// between two winding loops), a line that crosses the loops more often is accepted when
    /// one of its segments inside the face joins the two winding loops ([`band_segment`]):
    /// the seam is that segment (a modelled thread's crest winds between its grooves, so no
    /// line across it meets each loop once).
    fn choose(
        &self,
        ch: &Chart<'_>,
        loops: &[LoopInfo],
        wind: &[usize],
        along_u: bool,
        segment: bool,
    ) -> Option<(f64, Vec<Cross>)> {
        let mut best: Option<(usize, f64, Vec<Cross>)> = None;
        'cand: for c in self.candidates(loops, wind, along_u) {
            let mut all: Vec<Vec<Cross>> = Vec::with_capacity(loops.len());
            for li in loops {
                let Some(cr) = self.crossings(ch, li, c, along_u) else {
                    continue 'cand;
                };
                all.push(cr);
            }
            let simple = (0..loops.len()).all(|i| all[i].len() == usize::from(wind.contains(&i)));
            let chosen: Vec<Cross> = if simple {
                wind.iter().map(|&i| all[i][0]).collect()
            } else if segment && wind.len() == 2 {
                match band_segment(&all, wind[0], wind[1]) {
                    Some(x) => x.to_vec(),
                    None => continue 'cand,
                }
            } else {
                continue 'cand;
            };
            let mut crosses = Vec::with_capacity(wind.len());
            let mut cost = 0usize;
            for (&i, x) in wind.iter().zip(chosen) {
                if x.at.is_none() {
                    let eid = loops[i].edges[x.coedge];
                    let ring_free = self.body.edge(eid).is_some_and(|e| {
                        e.is_ring() && self.pts.get(&eid).is_none_or(Vec::is_empty)
                    });
                    if !ring_free {
                        cost += 1;
                    }
                }
                crosses.push(x);
            }
            if best.as_ref().is_none_or(|(bc, _, _)| cost < *bc) {
                let done = cost == 0;
                best = Some((cost, c, crosses));
                if done {
                    break;
                }
            }
        }
        best.map(|(_, c, x)| (c, x))
    }

    fn resolve(&mut self, li: &LoopInfo, x: &Cross) -> Result<usize, StepError> {
        match x.at {
            Some(v) => Ok(v),
            None => self.point_on_edge(li.edges[x.coedge], x.t),
        }
    }

    fn plan_face(&mut self, fid: FaceId) -> Result<(), StepError> {
        let body = self.body;
        let face = body
            .face(fid)
            .ok_or_else(|| invalid(self.ctx, "stale face id".into()))?;
        let surface = &face.surface;
        if let Surface::BSpline(n) = surface {
            return self.check_bspline_face(fid, n);
        }
        let Some(ch) = self.chart(fid, surface, face.sense)? else {
            return Ok(());
        };
        let mut loops = Vec::with_capacity(face.loops.len());
        for &lid in &face.loops {
            loops.push(self.sample_loop(fid, &ch, lid)?);
        }
        let sign = if face.sense { 1 } else { -1 };
        for li in &loops {
            if li.wu.abs() > 1 || li.wv.abs() > 1 {
                return Err(self.seam_err(
                    fid,
                    "a boundary loop winds more than once around the surface",
                ));
            }
            // A non-winding loop may span a turn or more of the parameter plane (a band
            // pinched at a vertex, a face that reaches around its axis at different heights):
            // it needs no seam, and readers place its pcurves in one continuous range. Forge
            // bodies never overlap themselves, so this is not a helix wrapping onto itself.
        }
        let wind_u: Vec<usize> = (0..loops.len()).filter(|&i| loops[i].wu != 0).collect();
        let wind_v: Vec<usize> = (0..loops.len()).filter(|&i| loops[i].wv != 0).collect();
        let all_holes = loops.iter().all(|l| l.area < 0.0);

        if ch.v_periodic {
            if matches!(surface, Surface::Torus(t) if t.major() <= t.minor())
                && (!wind_u.is_empty() || !wind_v.is_empty() || loops.is_empty())
            {
                return Err(self.seam_err(fid, "seams on horn-torus faces are not supported"));
            }
            if loops.iter().any(|l| l.wu != 0 && l.wv != 0)
                || (!wind_u.is_empty() && !wind_v.is_empty())
            {
                return Err(self.seam_err(
                    fid,
                    "a boundary loop winds around both directions of the torus",
                ));
            }
            if loops.is_empty() {
                return self.plan_full_torus(fid, surface);
            }
            let (wind, along_u) = if !wind_u.is_empty() {
                (wind_u, true)
            } else if !wind_v.is_empty() {
                (wind_v, false)
            } else {
                if all_holes {
                    return Err(self.seam_err(
                        fid,
                        "a torus face with only holes needs two seams (not supported)",
                    ));
                }
                self.u_origin.insert(fid, mid_gap(&loops));
                self.v_origin.insert(fid, mid_gap_v(&loops));
                return Ok(());
            };
            if wind.len() != 2 {
                return Err(self.seam_err(fid, "a torus face needs exactly two winding loops"));
            }
            let (c, xs) = self
                .choose(&ch, &loops, &wind, along_u, false)
                .ok_or_else(|| self.seam_err(fid, "no seam position avoids the face's holes"))?;
            // Lower = the loop the face lies after, going along the seam direction.
            let w_of = |i: usize| (if along_u { loops[i].wu } else { -loops[i].wv }) * sign;
            let (ia, ib) = (wind[0], wind[1]);
            if w_of(ia) == w_of(ib) {
                return Err(self.seam_err(fid, "the winding loops do not bound a band"));
            }
            let (lo, hi, xl, xh) = if w_of(ia) > 0 {
                (ia, ib, xs[0], xs[1])
            } else {
                (ib, ia, xs[1], xs[0])
            };
            let vl = self.resolve(&loops[lo], &xl)?;
            let vh = self.resolve(&loops[hi], &xh)?;
            let curve = self.torus_seam(fid, surface, c, along_u)?;
            if along_u {
                self.u_origin.insert(fid, c);
                self.v_origin.insert(fid, mid_gap_v(&loops));
            } else {
                self.u_origin.insert(fid, mid_gap(&loops));
                self.v_origin.insert(fid, c);
            }
            let lower = SeamEnd::Loop {
                lp: lo,
                coedge: xl.coedge,
                vertex: vl,
            };
            let upper = SeamEnd::Loop {
                lp: hi,
                coedge: xh.coedge,
                vertex: vh,
            };
            return self.add_seam(fid, curve, lower, upper);
        }

        // Bands: cylinder, cone, sphere, spindle-torus patch.
        let (lo_end, hi_end) = ch.ends;
        let needs = match wind_u.len() {
            0 => lo_end.point.is_some() && hi_end.point.is_some() && all_holes,
            1 | 2 => true,
            _ => {
                return Err(self.seam_err(fid, "more than two boundary loops wind around the axis"));
            }
        };
        if !needs {
            self.u_origin.insert(fid, mid_gap(&loops));
            return Ok(());
        }
        let (c, xs) = self
            .choose(&ch, &loops, &wind_u, true, true)
            .ok_or_else(|| self.seam_err(fid, "no seam position avoids the face's holes"))?;
        let curve = self.band_seam(fid, surface, c)?;
        self.u_origin.insert(fid, c);
        let w_of = |i: usize| loops[i].wu * sign;
        let (lower, upper) = match wind_u.len() {
            0 => {
                let (Some(pl), Some(ph)) = (lo_end.point, hi_end.point) else {
                    return Err(self.seam_err(fid, "internal: pole-to-pole seam without poles"));
                };
                let vl = self.pole_vertex(fid, pl)?;
                let vh = self.pole_vertex(fid, ph)?;
                (SeamEnd::Pole { vertex: vl }, SeamEnd::Pole { vertex: vh })
            }
            1 => {
                let i = wind_u[0];
                let x = xs[0];
                let vx = self.resolve(&loops[i], &x)?;
                let at = SeamEnd::Loop {
                    lp: i,
                    coedge: x.coedge,
                    vertex: vx,
                };
                if w_of(i) > 0 {
                    let Some(ph) = hi_end.point else {
                        return Err(
                            self.seam_err(fid, "the face is unbounded above its only winding loop")
                        );
                    };
                    (
                        at,
                        SeamEnd::Pole {
                            vertex: self.pole_vertex(fid, ph)?,
                        },
                    )
                } else {
                    let Some(pl) = lo_end.point else {
                        return Err(
                            self.seam_err(fid, "the face is unbounded below its only winding loop")
                        );
                    };
                    (
                        SeamEnd::Pole {
                            vertex: self.pole_vertex(fid, pl)?,
                        },
                        at,
                    )
                }
            }
            _ => {
                let (ia, ib) = (wind_u[0], wind_u[1]);
                let (lo, hi, xl, xh) = if xs[0].other <= xs[1].other {
                    (ia, ib, xs[0], xs[1])
                } else {
                    (ib, ia, xs[1], xs[0])
                };
                if w_of(lo) <= 0 || w_of(hi) >= 0 {
                    return Err(self.seam_err(fid, "the winding loops do not bound a band"));
                }
                let vl = self.resolve(&loops[lo], &xl)?;
                let vh = self.resolve(&loops[hi], &xh)?;
                (
                    SeamEnd::Loop {
                        lp: lo,
                        coedge: xl.coedge,
                        vertex: vl,
                    },
                    SeamEnd::Loop {
                        lp: hi,
                        coedge: xh.coedge,
                        vertex: vh,
                    },
                )
            }
        };
        self.add_seam(fid, curve, lower, upper)
    }

    /// A new vertex at a pole or apex the seam ends at. The face contains that point in its
    /// interior, so no vertex of the face may already be there (a loop touching the pole
    /// would put two vertices at one point).
    fn pole_vertex(&mut self, fid: FaceId, p: Point3) -> Result<usize, StepError> {
        let body = self.body;
        let touches = body.face_edges(fid).into_iter().any(|eid| {
            let Some(e) = body.edge(eid) else {
                return false;
            };
            let near = self.tol.max(e.tolerance);
            [e.start, e.end]
                .into_iter()
                .flatten()
                .any(|v| self.vertices[self.vmap[&v]].distance(p) <= near)
                || self.pts.get(&eid).is_some_and(|l| {
                    l.iter()
                        .any(|&(_, vi)| self.vertices[vi].distance(p) <= near)
                })
        });
        if touches {
            return Err(self.seam_err(fid, "a boundary loop touches the pole the seam must reach"));
        }
        Ok(self.new_vertex(p))
    }

    fn add_seam(
        &mut self,
        fid: FaceId,
        curve: Curve3,
        lower: SeamEnd,
        upper: SeamEnd,
    ) -> Result<(), StepError> {
        if lower.vertex() == upper.vertex() {
            return Err(self.seam_err(fid, "the seam would have zero length"));
        }
        self.seam_curves.push(curve);
        self.stats.seams += 1;
        self.plans.insert(
            fid,
            FacePlan::Seam {
                curve: self.seam_curves.len() - 1,
                lower,
                upper,
            },
        );
        Ok(())
    }

    fn plan_full_torus(&mut self, fid: FaceId, s: &Surface) -> Result<(), StepError> {
        let iso_u = self.torus_seam(fid, s, 0.0, true)?;
        let iso_v = self.torus_seam(fid, s, 0.0, false)?;
        let vertex = self.new_vertex(s.eval(0.0, 0.0));
        self.u_origin.insert(fid, 0.0);
        self.v_origin.insert(fid, 0.0);
        self.seam_curves.push(iso_u);
        self.seam_curves.push(iso_v);
        self.stats.seams += 2;
        let n = self.seam_curves.len();
        self.plans.insert(
            fid,
            FacePlan::FullTorus {
                iso_u: n - 2,
                iso_v: n - 1,
                vertex,
            },
        );
        Ok(())
    }

    /// The iso-`u` seam curve at `u = c` of a band surface, parametrized along `+v`.
    fn band_seam(&self, fid: FaceId, s: &Surface, c: f64) -> Result<Curve3, StepError> {
        let bad = |_| self.seam_err(fid, "degenerate seam geometry");
        Ok(match s {
            Surface::Cylinder(cy) => {
                Curve3::Line(Line3::new(cy.eval(c, 0.0), cy.frame().z()).map_err(bad)?)
            }
            Surface::Cone(co) => {
                let d = co.derivs2(c, 0.0).dv;
                Curve3::Line(Line3::new(co.eval(c, 0.0), d).map_err(bad)?)
            }
            Surface::Sphere(sp) => {
                let f = sp.frame();
                let er = e_r(f, c);
                let frame = Frame::from_normal_x(f.origin(), er.cross(f.z()), er)
                    .ok_or_else(|| self.seam_err(fid, "degenerate seam frame"))?;
                Curve3::Circle(Circle3::new(frame, sp.radius()).map_err(bad)?)
            }
            Surface::Torus(_) => return self.torus_seam(fid, s, c, true),
            _ => return Err(self.seam_err(fid, "internal: seam on a non-periodic surface")),
        })
    }

    /// A torus seam: the tube circle at `u = c` (`along_u`, parametrized along `+v`) or
    /// the circle about the axis at `v = c` (parametrized along `+u`).
    fn torus_seam(
        &self,
        fid: FaceId,
        s: &Surface,
        c: f64,
        along_u: bool,
    ) -> Result<Curve3, StepError> {
        let Surface::Torus(t) = s else {
            return Err(self.seam_err(fid, "internal: torus seam on another surface"));
        };
        let bad = |_| self.seam_err(fid, "degenerate seam geometry");
        let f = t.frame();
        if along_u {
            let er = e_r(f, c);
            let centre = f.origin() + er * t.major();
            let frame = Frame::from_normal_x(centre, er.cross(f.z()), er)
                .ok_or_else(|| self.seam_err(fid, "degenerate seam frame"))?;
            Ok(Curve3::Circle(Circle3::new(frame, t.minor()).map_err(bad)?))
        } else {
            let (sv, cv) = math::sin_cos(c);
            let rho = t.major() + t.minor() * cv;
            if rho <= 0.0 {
                return Err(self.seam_err(fid, "the seam circle about the axis degenerates"));
            }
            let frame = f.with_origin(f.origin() + f.z() * (t.minor() * sv));
            Ok(Curve3::Circle(Circle3::new(frame, rho).map_err(bad)?))
        }
    }

    /// B-spline surfaces are never periodic in Forge; refuse a face whose boundary wraps
    /// across a closed B-spline surface's parameter boundary (it would need a seam there).
    fn check_bspline_face(
        &self,
        fid: FaceId,
        n: &forge_core::geom::NurbsSurface,
    ) -> Result<(), StepError> {
        let ((u0, u1), (v0, v1)) = n.domain();
        let (nu, nv) = n.net_size();
        let closed_u =
            (0..nv).all(|j| n.control_point(0, j).distance(n.control_point(nu - 1, j)) <= self.tol);
        let closed_v =
            (0..nu).all(|i| n.control_point(i, 0).distance(n.control_point(i, nv - 1)) <= self.tol);
        if !closed_u && !closed_v {
            return Ok(());
        }
        let face = self
            .body
            .face(fid)
            .ok_or_else(|| invalid(self.ctx, "stale face id".into()))?;
        let surf = Surface::BSpline(n.clone());
        for &lid in &face.loops {
            let Some(lp) = self.body.loop_(lid) else {
                continue;
            };
            let mut prev: Option<(f64, f64)> = None;
            for &cid in &lp.coedges {
                let Some(c) = self.body.coedge(cid) else {
                    continue;
                };
                let Some(e) = self.body.edge(c.edge) else {
                    continue;
                };
                let (t0, t1) = e.t_range;
                for k in 0..=32 {
                    let t = t0 + (t1 - t0) * f64::from(k) / 32.0;
                    let (u, v, _) = surf.project(e.curve.eval(t));
                    if let Some((pu, pv)) = prev
                        && ((closed_u && (u - pu).abs() > 0.5 * (u1 - u0))
                            || (closed_v && (v - pv).abs() > 0.5 * (v1 - v0)))
                    {
                        return Err(self.seam_err(
                            fid,
                            "a boundary loop crosses the closing line of a closed B-spline surface",
                        ));
                    }
                    prev = Some((u, v));
                }
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------------------
    // 3. Ring vertices, pieces, loops
    // -----------------------------------------------------------------------------------

    fn ring_vertices(&mut self) -> Result<(), StepError> {
        let rings: Vec<(EdgeId, f64)> = self
            .body
            .edges()
            .iter()
            .filter(|(id, e)| {
                e.is_ring()
                    && (e.curve.period().is_none() || self.pts.get(id).is_none_or(Vec::is_empty))
            })
            .map(|(id, e)| (id, e.t_range.0))
            .collect();
        for (eid, t0) in rings {
            self.point_on_edge(eid, t0)?;
        }
        Ok(())
    }

    fn finish(mut self) -> Result<Topo, StepError> {
        let body = self.body;
        let mut edges: Vec<TEdge> = Vec::new();
        // Pieces of each Forge edge in curve order: (piece index).
        let mut pieces: BTreeMap<EdgeId, Vec<usize>> = BTreeMap::new();
        for (eid, e) in body.edges().iter() {
            let mut pts = self.pts.get(&eid).cloned().unwrap_or_default();
            pts.sort_by(|a, b| a.0.total_cmp(&b.0));
            pts.dedup_by(|b, a| a.1 == b.1);
            let mut list = Vec::new();
            if e.is_ring() {
                if pts.is_empty() {
                    return Err(invalid(
                        self.ctx,
                        "internal: ring edge without a vertex".into(),
                    ));
                }
                let period = e.t_range.1 - e.t_range.0;
                for i in 0..pts.len() {
                    let t_end = if i + 1 < pts.len() {
                        pts[i + 1].0
                    } else {
                        pts[0].0 + period
                    };
                    edges.push(TEdge {
                        start: pts[i].1,
                        end: pts[(i + 1) % pts.len()].1,
                        curve: TCurve::Edge(eid),
                        t: (pts[i].0, t_end),
                    });
                    list.push(edges.len() - 1);
                }
            } else {
                let (Some(vs), Some(ve)) = (e.start, e.end) else {
                    return Err(invalid(
                        self.ctx,
                        format!("edge {} has only one vertex", e.provenance.name()),
                    ));
                };
                let mut chain = vec![(e.t_range.0, self.vmap[&vs])];
                chain.extend(pts.iter().copied());
                chain.push((e.t_range.1, self.vmap[&ve]));
                for w in chain.windows(2) {
                    let (w, t) = ([w[0].1, w[1].1], (w[0].0, w[1].0));
                    if w[0] == w[1] && chain.len() > 2 {
                        return Err(invalid(
                            self.ctx,
                            format!("edge {} would get a zero-length piece", e.provenance.name()),
                        ));
                    }
                    edges.push(TEdge {
                        start: w[0],
                        end: w[1],
                        curve: TCurve::Edge(eid),
                        t,
                    });
                    list.push(edges.len() - 1);
                }
            }
            self.stats.split_pieces += list.len() - 1;
            pieces.insert(eid, list);
        }

        // Faces, shell by shell.
        let classes = self.classify_shells()?;
        let mut faces: Vec<TFace> = Vec::new();
        let mut shell_faces: Vec<Vec<usize>> = Vec::new();
        for (si, &sid) in body.shell_ids().iter().enumerate() {
            let shell = body
                .shell(sid)
                .ok_or_else(|| invalid(self.ctx, "stale shell id".into()))?;
            let void = classes[si] == ShellClass::Void;
            let mut list = Vec::new();
            for &fid in &shell.faces {
                let tf = self.face_bounds(fid, &pieces, &mut edges, void)?;
                faces.push(tf);
                list.push(faces.len() - 1);
            }
            shell_faces.push(list);
        }
        let mut solids: Vec<TSolid> = Vec::new();
        let lumps: Vec<usize> = (0..classes.len())
            .filter(|&i| classes[i] == ShellClass::Lump)
            .collect();
        let voids: Vec<usize> = (0..classes.len())
            .filter(|&i| classes[i] == ShellClass::Void)
            .collect();
        self.stats.voids = voids.len();
        if lumps.len() == 1 {
            solids.push(TSolid {
                outer: shell_faces[lumps[0]].clone(),
                voids: voids.iter().map(|&i| shell_faces[i].clone()).collect(),
            });
        } else if voids.is_empty() {
            for &i in &lumps {
                solids.push(TSolid {
                    outer: shell_faces[i].clone(),
                    voids: Vec::new(),
                });
            }
        } else {
            return Err(StepError::UnsupportedTopology {
                body: self.ctx.to_string(),
                detail: "a body with several lumps and voids".into(),
            });
        }
        Ok(Topo {
            vertices: self.vertices,
            edges,
            seam_curves: self.seam_curves,
            faces,
            solids,
            tolerance: self.tol,
            stats: self.stats,
        })
    }

    /// Oriented edges of a Forge loop, with each entry's coedge index and start vertex.
    fn expand(
        &self,
        lid: LoopId,
        pieces: &BTreeMap<EdgeId, Vec<usize>>,
        edges: &[TEdge],
    ) -> Result<Vec<(usize, bool, usize, usize)>, StepError> {
        let lp = self
            .body
            .loop_(lid)
            .ok_or_else(|| invalid(self.ctx, "stale loop id".into()))?;
        let mut out = Vec::new();
        for (k, &cid) in lp.coedges.iter().enumerate() {
            let c = self
                .body
                .coedge(cid)
                .ok_or_else(|| invalid(self.ctx, "stale coedge id".into()))?;
            let list = &pieces[&c.edge];
            if c.forward {
                for &p in list {
                    out.push((p, true, k, edges[p].start));
                }
            } else {
                for &p in list.iter().rev() {
                    out.push((p, false, k, edges[p].end));
                }
            }
        }
        Ok(out)
    }

    fn face_bounds(
        &self,
        fid: FaceId,
        pieces: &BTreeMap<EdgeId, Vec<usize>>,
        edges: &mut Vec<TEdge>,
        void: bool,
    ) -> Result<TFace, StepError> {
        let face = self
            .body
            .face(fid)
            .ok_or_else(|| invalid(self.ctx, "stale face id".into()))?;
        let mut loops = Vec::with_capacity(face.loops.len());
        for &lid in &face.loops {
            loops.push(self.expand(lid, pieces, edges)?);
        }
        let orientation = !void;
        let strip = |l: &[(usize, bool, usize, usize)]| {
            l.iter().map(|&(p, f, _, _)| (p, f)).collect::<Vec<_>>()
        };
        let rotated = |l: &[(usize, bool, usize, usize)],
                       coedge: usize,
                       vertex: usize|
         -> Option<Vec<(usize, bool)>> {
            let n = l.len();
            let k_next = (coedge + 1) % l.iter().map(|x| x.2 + 1).max().unwrap_or(1);
            let i = l
                .iter()
                .position(|x| x.2 == coedge && x.3 == vertex)
                .or_else(|| l.iter().position(|x| x.2 == k_next && x.3 == vertex))?;
            Some(
                (0..n)
                    .map(|j| (l[(i + j) % n].0, l[(i + j) % n].1))
                    .collect(),
            )
        };
        let mut bounds = Vec::new();
        match self.plans.get(&fid) {
            None => {
                for (i, l) in loops.iter().enumerate() {
                    bounds.push(TBound {
                        edges: strip(l),
                        outer: i == 0,
                        orientation,
                    });
                }
            }
            Some(FacePlan::Seam {
                curve,
                lower,
                upper,
            }) => {
                edges.push(TEdge {
                    start: lower.vertex(),
                    end: upper.vertex(),
                    curve: TCurve::Seam(*curve),
                    t: (0.0, 0.0),
                });
                let s = edges.len() - 1;
                let piece = |end: &SeamEnd| -> Result<Option<Vec<(usize, bool)>>, StepError> {
                    match *end {
                        SeamEnd::Pole { .. } => Ok(None),
                        SeamEnd::Loop { lp, coedge, vertex } => rotated(&loops[lp], coedge, vertex)
                            .map(Some)
                            .ok_or_else(|| {
                                self.seam_err(fid, "internal: seam crossing not found on its loop")
                            }),
                    }
                };
                let a = piece(lower)?;
                let b = piece(upper)?;
                let mut merged = Vec::new();
                match (a, b) {
                    (Some(a), Some(b)) => {
                        merged.extend(a);
                        merged.push((s, true));
                        merged.extend(b);
                        merged.push((s, false));
                    }
                    (Some(a), None) => {
                        merged.extend(a);
                        merged.push((s, true));
                        merged.push((s, false));
                    }
                    (None, Some(b)) => {
                        merged.extend(b);
                        merged.push((s, false));
                        merged.push((s, true));
                    }
                    (None, None) => {
                        merged.push((s, true));
                        merged.push((s, false));
                    }
                }
                bounds.push(TBound {
                    edges: merged,
                    outer: true,
                    orientation,
                });
                let used: Vec<usize> = [lower, upper]
                    .iter()
                    .filter_map(|e| match e {
                        SeamEnd::Loop { lp, .. } => Some(*lp),
                        SeamEnd::Pole { .. } => None,
                    })
                    .collect();
                for (i, l) in loops.iter().enumerate() {
                    if !used.contains(&i) {
                        bounds.push(TBound {
                            edges: strip(l),
                            outer: false,
                            orientation,
                        });
                    }
                }
            }
            Some(FacePlan::FullTorus {
                iso_u,
                iso_v,
                vertex,
            }) => {
                edges.push(TEdge {
                    start: *vertex,
                    end: *vertex,
                    curve: TCurve::Seam(*iso_u),
                    t: (0.0, 0.0),
                });
                let eu = edges.len() - 1;
                edges.push(TEdge {
                    start: *vertex,
                    end: *vertex,
                    curve: TCurve::Seam(*iso_v),
                    t: (0.0, 0.0),
                });
                let ev = edges.len() - 1;
                let order = if face.sense {
                    vec![(ev, true), (eu, true), (ev, false), (eu, false)]
                } else {
                    vec![(eu, true), (ev, true), (eu, false), (ev, false)]
                };
                bounds.push(TBound {
                    edges: order,
                    outer: true,
                    orientation,
                });
            }
        }
        Ok(TFace {
            face: fid,
            same_sense: face.sense != void,
            bounds,
            u_origin: self.u_origin.get(&fid).copied(),
            v_origin: self.v_origin.get(&fid).copied(),
        })
    }

    // -----------------------------------------------------------------------------------
    // 4. Shells
    // -----------------------------------------------------------------------------------

    fn classify_shells(&self) -> Result<Vec<ShellClass>, StepError> {
        let body = self.body;
        let ids = body.shell_ids();
        if ids.is_empty() {
            return Err(invalid(self.ctx, "the body has no shell".into()));
        }
        for &sid in ids {
            let s = body
                .shell(sid)
                .ok_or_else(|| invalid(self.ctx, "stale shell id".into()))?;
            if !s.closed {
                return Err(StepError::UnsupportedTopology {
                    body: self.ctx.to_string(),
                    detail: "open (sheet) shells are not exported yet".into(),
                });
            }
        }
        if ids.len() == 1 {
            return Ok(vec![ShellClass::Lump]);
        }
        let volumes = shell_volumes(body).map_err(|detail| StepError::UnsupportedTopology {
            body: self.ctx.to_string(),
            detail,
        })?;
        Ok(volumes
            .iter()
            .map(|&v| {
                if v > 0.0 {
                    ShellClass::Lump
                } else {
                    ShellClass::Void
                }
            })
            .collect())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShellClass {
    Lump,
    Void,
}

/// Signed volume enclosed by each shell (from a tessellation of the body; only the sign
/// is used).
fn shell_volumes(body: &Body) -> Result<Vec<f64>, String> {
    let mut lo = Vec3::new(f64::MAX, f64::MAX, f64::MAX);
    let mut hi = Vec3::new(f64::MIN, f64::MIN, f64::MIN);
    for v in body.vertices().values() {
        lo = lo.min_components(v.point);
        hi = hi.max_components(v.point);
    }
    for e in body.edges().values() {
        let (t0, t1) = e.t_range;
        for k in 0..=8 {
            let p = e.curve.eval(t0 + (t1 - t0) * f64::from(k) / 8.0);
            lo = lo.min_components(p);
            hi = hi.max_components(p);
        }
    }
    let diag = if lo.x <= hi.x { lo.distance(hi) } else { 1.0 };
    let params = forge_mesh::TessParams::new((diag * 1e-3).max(1e-4), 0.5);
    let mesh = forge_mesh::tessellate(body, &params)
        .map_err(|e| format!("cannot classify shells: {e}"))?;
    let faces: Vec<(FaceId, String)> = body
        .faces()
        .iter()
        .map(|(id, f)| (id, f.provenance.name()))
        .collect();
    if mesh.face_ranges.len() != faces.len()
        || mesh
            .face_ranges
            .iter()
            .zip(&faces)
            .any(|(r, (_, n))| &r.face_name != n)
    {
        return Err("cannot classify shells: tessellation faces do not match".into());
    }
    let mut shell_of: BTreeMap<FaceId, usize> = BTreeMap::new();
    for (si, &sid) in body.shell_ids().iter().enumerate() {
        if let Some(s) = body.shell(sid) {
            for &f in &s.faces {
                shell_of.insert(f, si);
            }
        }
    }
    let mut vol = vec![0.0; body.shell_ids().len()];
    for (r, (fid, _)) in mesh.face_ranges.iter().zip(&faces) {
        let Some(&si) = shell_of.get(fid) else {
            continue;
        };
        let start = r.tri_start as usize;
        for tri in &mesh.triangles[start..start + r.tri_count as usize] {
            let p = |i: u32| {
                let a = mesh.positions[i as usize];
                Vec3::new(a[0], a[1], a[2])
            };
            vol[si] += p(tri[0]).dot(p(tri[1]).cross(p(tri[2]))) / 6.0;
        }
    }
    if vol.iter().any(|v| !v.is_finite() || *v == 0.0) {
        return Err("cannot classify shells: a shell encloses no volume".into());
    }
    Ok(vol)
}

/// The middle of the `u` gap the face leaves (from its widest loop), as a `u` origin.
fn mid_gap(loops: &[LoopInfo]) -> f64 {
    let Some(widest) = loops
        .iter()
        .max_by(|a, b| a.extent_u.total_cmp(&b.extent_u))
    else {
        return 0.0;
    };
    let (lo, hi) = widest.smp.iter().fold((f64::MAX, f64::MIN), |(lo, hi), s| {
        (lo.min(s.uu), hi.max(s.uu))
    });
    math::rem_euclid(0.5 * (lo + hi) + PI, TAU)
}

/// The middle of the `v` gap the face leaves (from its loop with the widest `v` range).
fn mid_gap_v(loops: &[LoopInfo]) -> f64 {
    let range = |l: &LoopInfo| {
        l.smp.iter().fold((f64::MAX, f64::MIN), |(lo, hi), s| {
            (lo.min(s.vv), hi.max(s.vv))
        })
    };
    let Some((lo, hi)) = loops
        .iter()
        .map(range)
        .max_by(|a, b| (a.1 - a.0).total_cmp(&(b.1 - b.0)))
    else {
        return 0.0;
    };
    0.5 * (lo + hi) + PI
}

/// `s` with its frame turned about its axis so that the Forge parameter `u = a` becomes
/// `u = 0` (the same point set and orientation; only the `u` origin moves).
pub(crate) fn rotate_u(s: &Surface, a: f64) -> Surface {
    let turned = |f: &Frame| Frame::from_normal_x(f.origin(), f.z(), e_r(f, a)).unwrap_or(*f);
    match s {
        Surface::Cylinder(c) => Cylinder::new(turned(c.frame()), c.radius())
            .map_or_else(|_| s.clone(), Surface::Cylinder),
        Surface::Cone(c) => Cone::new(turned(c.frame()), c.radius(), c.half_angle())
            .map_or_else(|_| s.clone(), Surface::Cone),
        Surface::Sphere(sp) => {
            Sphere::new(turned(sp.frame()), sp.radius()).map_or_else(|_| s.clone(), Surface::Sphere)
        }
        Surface::Torus(t) => match t.spindle_patch() {
            None => Torus::new(turned(t.frame()), t.major(), t.minor()),
            Some(p) => Torus::spindle(turned(t.frame()), t.major(), t.minor(), p),
        }
        .map_or_else(|_| s.clone(), Surface::Torus),
        Surface::Plane(_) | Surface::Helicoid(_) | Surface::BSpline(_) => s.clone(),
    }
}

fn invalid(ctx: &str, detail: String) -> StepError {
    StepError::InvalidBody {
        body: ctx.to_string(),
        detail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pole_steps_follow_the_face_orientation() {
        // Upper singular line, face on the left in (u, v): towards −u.
        assert!((pole_delta(PI / 2.0, true, true) - (PI / 2.0 - TAU)).abs() < 1e-15);
        assert!((pole_delta(-PI / 2.0, true, true) - (-PI / 2.0)).abs() < 1e-15);
        // Lower singular line: towards +u.
        assert!((pole_delta(-PI / 2.0, false, true) - 1.5 * PI).abs() < 1e-15);
        // Reversed faces go the other way.
        assert!((pole_delta(PI / 2.0, true, false) - PI / 2.0).abs() < 1e-15);
        assert!(pole_delta(0.0, true, true).abs() < 1e-300);
    }

    #[test]
    fn wrap_pi_maps_into_the_half_open_interval() {
        for x in [-10.0, -PI, -1.0, 0.0, 1.0, PI, 3.5, 10.0] {
            let w = wrap_pi(x);
            assert!(w > -PI - 1e-15 && w <= PI + 1e-15, "{x} -> {w}");
            assert!((math::rem_euclid(w - x, TAU)).min(TAU - math::rem_euclid(w - x, TAU)) < 1e-12);
        }
    }
}
