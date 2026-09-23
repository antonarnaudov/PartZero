//! Intersection phase: every place where the operands meet becomes shared vertices and
//! edge pieces, each piece knowing every face it lies on (with a pcurve there).
//!
//! 1. **Edge–face.** Every edge of one operand is intersected with every face of the other
//!    whose box it meets (`intersect_curve_surface` on the face's parameter box). Hits
//!    inside the face or on its boundary become vertex candidates that split the edge;
//!    overlaps (the edge lies in the face's surface) are kept to imprint the edge.
//! 2. **Face–face.** `intersect_surfaces` on every pair of faces whose boxes meet. A
//!    coincidence is recorded (2D region boolean through the imprinted edges). Each branch
//!    is split at the vertex candidates that lie on it (the hits of either face's edges on
//!    the other face: exactly where the branch crosses a face boundary) and at the SSI's
//!    own vertices; the pieces whose middle lies in (or on the boundary of) both faces are
//!    kept. Isolated tangent points inside both faces are recorded for the non-manifold
//!    check.
//! 3. **Vertices.** Candidates within [`VTOL`] are merged (an operand vertex keeps its
//!    position; two vertices of one operand never merge).
//! 4. **Pieces.** Operand edges are split at their merged hit vertices; branch pieces get
//!    their end vertices. Pieces with the same end vertices whose middles lie on each
//!    other are one edge: the first (operand A, then B, then sections) is kept with its
//!    curve, and every face of the others is re-attached with a pcurve fitted to it.

use std::collections::BTreeMap;

use forge_core::geom::{Curve2, Curve3};
use forge_core::linalg::{Point2, Point3};
use forge_ir::v1::EntityKind;
use forge_ssi::{SsiTolerance, VertexKind, intersect_curve_surface, intersect_surfaces};

use super::error::BooleanError;
use super::geom::{fit_pcurve, param_on, singular_offset, singular_v_at, uv_near};
use super::model::Model;

/// Vertex merge distance and point-on-curve / point-on-boundary tolerance (mm): the IR's
/// frozen `LINEAR_TOLERANCE` (SPEC §1), so a change of the constant propagates.
pub(crate) const VTOL: f64 = forge_ir::v1::LINEAR_TOLERANCE;

/// Where a point lies relative to a face.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Loc {
    In,
    On,
    Out,
}

/// A face a piece lies on.
#[derive(Clone, Debug)]
pub(crate) struct OnFace {
    pub face: usize,
    pub pcurve: Curve2,
    /// `Some(forward)` if the piece is part of the face's original boundary.
    pub boundary: Option<bool>,
}

/// Where a piece came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PieceSrc {
    /// A piece of operand edge `edge`.
    Edge(usize),
    /// A piece of the intersection of faces `f` (operand A) and `g` (operand B).
    Section { f: usize, g: usize, tangent: bool },
}

/// A merged edge piece.
#[derive(Clone, Debug)]
pub(crate) struct Piece {
    pub curve: Curve3,
    pub range: (f64, f64),
    pub start: Option<usize>,
    pub end: Option<usize>,
    pub tol: f64,
    pub src: PieceSrc,
    pub on: Vec<OnFace>,
}

/// A merged vertex.
#[derive(Clone, Debug)]
pub(crate) struct Vert {
    pub p: Point3,
    pub tol: f64,
    /// The operand vertex it is (operand A preferred), if any.
    pub orig: Option<usize>,
}

/// Result of the intersection phase.
pub(crate) struct Imprint {
    pub verts: Vec<Vert>,
    pub pieces: Vec<Piece>,
    /// Coincident face pairs `(f in A, g in B, same orientation of outward normals)`.
    pub coincident: Vec<(usize, usize, bool)>,
    /// Isolated contact points inside (or on the boundary of) both faces `(point, f, g)`:
    /// SSI tangent points, and isolated surface singularities (a cone apex or sphere pole
    /// touching the other face).
    pub tangent_points: Vec<(Point3, usize, usize)>,
    /// A point where the operands' boundaries meet, if they do: along a curve (`Edge`: an
    /// edge lying in the other's face, a section piece) if any, else at a point (`Vertex`:
    /// an edge–face hit, an isolated contact). The first in a deterministic order.
    pub contact: Option<(Point3, EntityKind)>,
    /// `true` if some SSI result was not certified complete (a warning).
    pub uncertified: bool,
}

/// Location of a 3D point `p` (with parameters `uv` on the face's surface) relative to
/// face `fi`: on its boundary (within [`VTOL`] of a boundary edge), inside or outside.
pub(crate) fn locate(m: &Model, fi: usize, p: Point3, uv: Point2) -> Loc {
    let f = &m.faces[fi];
    for ei in f.edges() {
        let e = &m.edges[ei];
        if !(e
            .bbox
            .grown(VTOL)
            .overlaps(&super::geom::Aabb { lo: p, hi: p }))
        {
            continue;
        }
        if param_on(&e.curve, e.range, p).1 <= VTOL {
            return Loc::On;
        }
    }
    for v in f
        .edges()
        .flat_map(|ei| [m.edges[ei].start, m.edges[ei].end])
        .flatten()
    {
        if m.verts[v].p.distance(p) <= VTOL {
            return Loc::On;
        }
    }
    // At a singular point of the surface (cone apex, sphere pole) the parameters are a
    // whole line, outside the chart's open window: decide from points just off it.
    if let Some(vs) = singular_v_at(&f.surface, p, VTOL)
        && let Some(around) = f
            .chart
            .around_singular(vs, singular_offset(&f.surface, vs, 10.0 * VTOL))
    {
        let inside = around.iter().filter(|x| matches!(x, Some(Some(_)))).count();
        let outside = around.iter().filter(|x| matches!(x, Some(None))).count();
        return if inside == around.len() {
            Loc::In
        } else if outside == around.len() {
            Loc::Out
        } else {
            Loc::On
        };
    }
    match f.chart.contains(uv) {
        Some(true) => Loc::In,
        Some(false) => Loc::Out,
        None => Loc::On,
    }
}

/// A vertex candidate.
#[derive(Clone, Copy, Debug)]
struct Cand {
    p: Point3,
    tol: f64,
    orig: Option<usize>,
    operand: Option<usize>,
}

/// A split of operand edge `edge` at parameter `t` by candidate `cand`.
#[derive(Clone, Copy, Debug)]
struct Split {
    edge: usize,
    t: f64,
    cand: usize,
}

/// A kept piece of a branch before vertex merging.
struct RawSection {
    curve: Curve3,
    range: (f64, f64),
    start: Option<usize>,
    end: Option<usize>,
    f: usize,
    g: usize,
    pc_f: Curve2,
    pc_g: Curve2,
    tol: f64,
    tangent: bool,
}

fn ssi_err(e: &forge_ssi::SsiError, m: &Model, a: usize, b: usize, edge: bool) -> BooleanError {
    let what = if edge {
        format!(
            "edge {} × face {}",
            m.edges[a].prov.name(),
            m.faces[b].prov.name()
        )
    } else {
        format!(
            "face {} × face {}",
            m.faces[a].prov.name(),
            m.faces[b].prov.name()
        )
    };
    BooleanError::ssi(e, what)
}

/// Run the intersection phase on both operands.
/// `sections`: fit the pcurves of fitted, transversal section pieces onto the true
/// intersection of their two faces (`geom::fit_section_pcurve`); else keep the SSI's.
pub(crate) fn imprint(m: &Model, sections: bool) -> Result<Imprint, BooleanError> {
    let tol = SsiTolerance::default();
    let mut cands: Vec<Cand> = m
        .verts
        .iter()
        .enumerate()
        .map(|(i, v)| Cand {
            p: v.p,
            tol: v.tol,
            orig: Some(i),
            operand: None,
        })
        .collect();
    // Operand of each operand vertex.
    for e in &m.edges {
        for v in [e.start, e.end].into_iter().flatten() {
            cands[v].operand = Some(e.operand);
        }
    }
    let mut splits: Vec<Split> = Vec::new();
    // (edge, face, overlap range)
    let mut overlaps: Vec<(usize, usize, (f64, f64))> = Vec::new();
    let mut uncertified = false;
    // First point contact and first curve contact.
    let mut contact: Option<Point3> = None;
    let mut contact_curve: Option<Point3> = None;
    // Hits recorded per (edge, face) pair, to split branches of faces using that edge.
    let mut hit_cands: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
    // ---- 1. edge–face --------------------------------------------------------------
    for (ei, e) in m.edges.iter().enumerate() {
        let other = 1 - e.operand;
        for gi in m.faces_of(other) {
            let g = &m.faces[gi];
            if !e.bbox.overlaps(&g.bbox) {
                continue;
            }
            let hits = intersect_curve_surface(&e.curve, e.range, &g.surface, g.uvbox, &tol)
                .map_err(|x| ssi_err(&x, m, ei, gi, true))?;
            uncertified |= !hits.certified_complete;
            for h in &hits.points {
                let loc = locate(m, gi, h.point, h.uv);
                if loc == Loc::Out {
                    continue;
                }
                contact.get_or_insert(h.point);
                cands.push(Cand {
                    p: h.point,
                    tol: VTOL.max(h.certificate.distance_bound),
                    orig: None,
                    operand: None,
                });
                let ci = cands.len() - 1;
                splits.push(Split {
                    edge: ei,
                    t: h.t,
                    cand: ci,
                });
                hit_cands.entry((ei, gi)).or_default().push(ci);
            }
            for o in &hits.overlaps {
                if std::env::var_os("FORGE_BOOLEAN_DEBUG_SSI").is_some() {
                    eprintln!(
                        "overlap {} {} range {:?} of {:?} on {} {}",
                        e.curve.kind_name(),
                        e.prov.name(),
                        o.t_range,
                        e.range,
                        g.surface.kind_name(),
                        g.prov.name()
                    );
                }
                if contact_curve.is_none() {
                    let pm = e.curve.eval(0.5 * (o.t_range.0 + o.t_range.1));
                    if locate(m, gi, pm, uv_near(&g.surface, pm, None)) != Loc::Out {
                        contact_curve = Some(pm);
                    }
                }
                overlaps.push((ei, gi, o.t_range));
                // The ends of an overlap inside the edge are where it leaves the surface's
                // box, not features; the face boundary splits come from other hits.
            }
        }
    }
    // ---- 2. face–face ----------------------------------------------------------------
    let mut coincident = Vec::new();
    let mut tangent_points = Vec::new();
    let mut raw_sections: Vec<RawSection> = Vec::new();
    for fi in m.faces_of(0) {
        let f = &m.faces[fi];
        for gi in m.faces_of(1) {
            let g = &m.faces[gi];
            if !f.bbox.overlaps(&g.bbox) {
                continue;
            }
            if std::env::var_os("FORGE_BOOLEAN_DEBUG_SSI_PRE").is_some() {
                eprintln!(
                    "ssi pre {} x {}:\n  {:?} {:?}\n  {:?} {:?}",
                    f.prov.name(),
                    g.prov.name(),
                    f.surface,
                    f.uvbox,
                    g.surface,
                    g.uvbox
                );
            }
            let graph = intersect_surfaces(&f.surface, f.uvbox, &g.surface, g.uvbox, &tol)
                .map_err(|x| ssi_err(&x, m, fi, gi, false))?;
            uncertified |= !graph.certified_complete;
            if std::env::var_os("FORGE_BOOLEAN_DEBUG_SSI").is_some() {
                eprintln!(
                    "ssi {} x {}: {} branches, coincidence {} boxes {:?} {:?}",
                    f.prov.name(),
                    g.prov.name(),
                    graph.branches.len(),
                    graph.coincidence.is_some(),
                    f.uvbox,
                    g.uvbox
                );
                for br in &graph.branches {
                    let tm = 0.5 * (br.range.0 + br.range.1);
                    eprintln!(
                        "  closed {} range {:?} mid {:?} ends {:?} {:?}",
                        br.closed,
                        br.range,
                        br.curve.eval(tm),
                        br.start,
                        br.end
                    );
                }
            }
            if let Some(c) = graph.coincidence {
                // Orientation of the outward normals.
                let same = c.same_orientation == (f.sense == g.sense);
                coincident.push((fi, gi, same));
                continue;
            }
            for (vi, v) in graph.vertices.iter().enumerate() {
                // Isolated contacts: tangent points, and surface singularities (an apex or a
                // pole) or branching points no branch passes through (a cone apex resting
                // on a plane).
                let isolated = !graph
                    .branches
                    .iter()
                    .any(|b| b.start == Some(vi) || b.end == Some(vi));
                let contact_point = v.kind == VertexKind::TangentPoint
                    || (isolated
                        && matches!(
                            v.kind,
                            VertexKind::SurfaceSingularity | VertexKind::Singular
                        ));
                if contact_point
                    && locate(m, fi, v.point, v.uv_a) != Loc::Out
                    && locate(m, gi, v.point, v.uv_b) != Loc::Out
                {
                    contact.get_or_insert(v.point);
                    tangent_points.push((v.point, fi, gi));
                }
            }
            // Split candidates for branches of this pair.
            let mut pair_cands: Vec<usize> = Vec::new();
            for ei in f.edges() {
                if let Some(cs) = hit_cands.get(&(ei, gi)) {
                    pair_cands.extend(cs);
                }
            }
            for ei in g.edges() {
                if let Some(cs) = hit_cands.get(&(ei, fi)) {
                    pair_cands.extend(cs);
                }
            }
            // Operand vertices of either face lying on the other face.
            for ei in f.edges().chain(g.edges()) {
                for v in [m.edges[ei].start, m.edges[ei].end].into_iter().flatten() {
                    pair_cands.push(v);
                }
            }
            pair_cands.sort_unstable();
            pair_cands.dedup();
            for br in &graph.branches {
                let (t0, t1) = br.range;
                // SSI vertices on the branch (crossings, apexes) inside both faces.
                let mut cuts: Vec<(f64, usize)> = Vec::new();
                for (end, t) in [(br.start, t0), (br.end, t1)] {
                    if let Some(vi) = end {
                        let v = graph.vertices[vi];
                        if matches!(
                            v.kind,
                            VertexKind::Singular | VertexKind::SurfaceSingularity
                        ) {
                            cands.push(Cand {
                                p: v.point,
                                tol: VTOL,
                                orig: None,
                                operand: None,
                            });
                            cuts.push((t, cands.len() - 1));
                        }
                    }
                }
                // A singular point of either surface (a sphere pole, a cone apex) the branch
                // passes through inside its range (a pole lying on the other surface): a
                // vertex there. No pcurve is continuous through it (its `u` jumps; a fitted
                // one slides along the singular line, which adds area to the face's domain
                // integral), so a piece must end there (review round 3: a sphere whose pole
                // lies on a cylinder hole's wall gave areas off by ~2e-5 mm²).
                for face in [f, g] {
                    for vs in super::geom::singular_vs(&face.surface) {
                        let sp = face.surface.eval(0.0, vs);
                        let (t, d) = param_on(&br.curve, br.range, sp);
                        let inner = t - t0 > 1e-9 * (t1 - t0) && t1 - t > 1e-9 * (t1 - t0);
                        if d <= VTOL && (inner || br.closed) {
                            cands.push(Cand {
                                p: sp,
                                tol: VTOL,
                                orig: None,
                                operand: None,
                            });
                            cuts.push((t, cands.len() - 1));
                        }
                    }
                }
                for &ci in &pair_cands {
                    let p = cands[ci].p;
                    let (t, d) = param_on(&br.curve, br.range, p);
                    let reach = VTOL.max(cands[ci].tol);
                    if d <= reach {
                        cuts.push((t, ci));
                    }
                }
                // A closed branch that is not periodic in its parameter needs a vertex at
                // its parameter start to be split.
                let periodic = br.curve.period().is_some();
                if br.closed && !cuts.is_empty() && !periodic {
                    cands.push(Cand {
                        p: br.curve.eval(t0),
                        tol: VTOL,
                        orig: None,
                        operand: None,
                    });
                    cuts.push((t0, cands.len() - 1));
                }
                cuts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                // Pieces: (ta, tb, cand at ta, cand at tb).
                let mut segs: Vec<(f64, f64, Option<usize>, Option<usize>)> = Vec::new();
                if br.closed && cuts.is_empty() {
                    segs.push((t0, t1, None, None));
                } else if br.closed && periodic {
                    for k in 0..cuts.len() {
                        let (ta, ca) = cuts[k];
                        let (tb, cb) = if k + 1 < cuts.len() {
                            cuts[k + 1]
                        } else {
                            (cuts[0].0 + (t1 - t0), cuts[0].1)
                        };
                        segs.push((ta, tb, Some(ca), Some(cb)));
                    }
                } else {
                    // Open branch (or closed non-periodic, cut at its start): the ends
                    // are split points too.
                    let mut pts: Vec<(f64, Option<usize>)> = Vec::new();
                    if cuts.first().is_none_or(|c| c.0 > t0) {
                        pts.push((t0, None));
                    }
                    pts.extend(cuts.iter().map(|&(t, c)| (t, Some(c))));
                    if cuts.last().is_none_or(|c| c.0 < t1) || br.closed {
                        pts.push((t1, if br.closed { Some(cuts[0].1) } else { None }));
                    }
                    for w in pts.windows(2) {
                        segs.push((w[0].0, w[1].0, w[0].1, w[1].1));
                    }
                }
                for (ta, tb, ca, cb) in segs {
                    if tb - ta <= 1e-12 * (1.0 + ta.abs()) {
                        continue;
                    }
                    let tm = 0.5 * (ta + tb);
                    let pm = br.curve.eval(tm);
                    let lf = locate(m, fi, pm, br.pcurve_a.eval(tm));
                    if std::env::var_os("FORGE_BOOLEAN_DEBUG_SSI").is_some() {
                        let lg = locate(m, gi, pm, br.pcurve_b.eval(tm));
                        eprintln!(
                            "  seg {ta}..{tb} at {pm:?}: {lf:?} {lg:?} (uv {:?} {:?})",
                            br.pcurve_a.eval(tm),
                            br.pcurve_b.eval(tm)
                        );
                    }
                    if lf == Loc::Out {
                        continue;
                    }
                    let lg = locate(m, gi, pm, br.pcurve_b.eval(tm));
                    if lg == Loc::Out {
                        continue;
                    }
                    // A piece ending at a branch end that no boundary hit explains reaches
                    // the (padded) parameter box, beyond both faces: it can only be kept
                    // when it lies strictly inside both faces (a crossing or an apex inside).
                    let open_end = !br.closed && (ca.is_none() || cb.is_none());
                    if open_end && (lf != Loc::In || lg != Loc::In) {
                        continue;
                    }
                    // Open ends without a split candidate: a branch end inside both faces
                    // (it can only be a surface singularity or a crossing, already cut).
                    let end_cand = |c: Option<usize>, t: f64, cands: &mut Vec<Cand>| -> usize {
                        match c {
                            Some(x) => x,
                            None => {
                                cands.push(Cand {
                                    p: br.curve.eval(t),
                                    tol: VTOL,
                                    orig: None,
                                    operand: None,
                                });
                                cands.len() - 1
                            }
                        }
                    };
                    contact_curve.get_or_insert(pm);
                    let (s, e) = if ca.is_none() && cb.is_none() && br.closed {
                        (None, None)
                    } else {
                        (
                            Some(end_cand(ca, ta, &mut cands)),
                            Some(end_cand(cb, tb, &mut cands)),
                        )
                    };
                    raw_sections.push(RawSection {
                        curve: br.curve.clone(),
                        range: (ta, tb),
                        start: s,
                        end: e,
                        f: fi,
                        g: gi,
                        pc_f: br.pcurve_a.clone(),
                        pc_g: br.pcurve_b.clone(),
                        tol: br.error_bound,
                        tangent: br.contact.is_tangent(),
                    });
                }
            }
        }
    }
    // Section ends on a boundary edge of either face that no edge–face hit split there (the
    // edge only touches the other surface, e.g. along its tangent plane at a double point of
    // the section): split the edge at them.
    let mut extra: Vec<Split> = Vec::new();
    for rs in &raw_sections {
        for c in [rs.start, rs.end].into_iter().flatten() {
            if cands[c].orig.is_some() {
                continue;
            }
            let p = cands[c].p;
            let reach = VTOL.max(cands[c].tol);
            let pbox = super::geom::Aabb { lo: p, hi: p };
            for fi in [rs.f, rs.g] {
                for ei in m.faces[fi].edges() {
                    let e = &m.edges[ei];
                    if !e.bbox.grown(reach).overlaps(&pbox) {
                        continue;
                    }
                    let (t, d) = param_on(&e.curve, e.range, p);
                    if d > reach
                        || [e.start, e.end]
                            .into_iter()
                            .flatten()
                            .any(|v| m.verts[v].p.distance(p) <= reach)
                        || splits
                            .iter()
                            .chain(&extra)
                            .any(|s| s.edge == ei && cands[s.cand].p.distance(p) <= reach)
                    {
                        continue;
                    }
                    extra.push(Split {
                        edge: ei,
                        t,
                        cand: c,
                    });
                }
            }
        }
    }
    splits.extend(extra);
    // Closed non-periodic operand ring edges with splits need a vertex at their start.
    let mut split_by_edge: BTreeMap<usize, Vec<(f64, usize)>> = BTreeMap::new();
    for s in &splits {
        split_by_edge.entry(s.edge).or_default().push((s.t, s.cand));
    }
    for (&ei, v) in split_by_edge.iter_mut() {
        let e = &m.edges[ei];
        if e.start.is_none() && e.end.is_none() && e.curve.period().is_none() {
            cands.push(Cand {
                p: e.curve.eval(e.range.0),
                tol: e.tol,
                orig: None,
                operand: None,
            });
            v.push((e.range.0, cands.len() - 1));
        }
    }
    // ---- 3. vertices -------------------------------------------------------------------
    let (vid, verts) = merge_vertices(m, &cands)?;
    if std::env::var_os("FORGE_BOOLEAN_DEBUG_VERTS").is_some() {
        for (i, v) in verts.iter().enumerate() {
            eprintln!("vert {i}: {:?} tol {} orig {:?}", v.p, v.tol, v.orig);
        }
        for (i, c) in cands.iter().enumerate() {
            eprintln!("cand {i}: {:?} -> {}", c.p, vid[i]);
        }
    }
    // ---- 4. pieces ---------------------------------------------------------------------
    let mut pieces: Vec<Piece> = Vec::new();
    // Faces using each operand edge.
    let mut edge_uses: Vec<Vec<(usize, bool, Curve2)>> = vec![Vec::new(); m.edges.len()];
    for (fi, f) in m.faces.iter().enumerate() {
        for u in f.loops.iter().flatten() {
            edge_uses[u.edge].push((fi, u.forward, u.pcurve.clone()));
        }
    }
    for (ei, e) in m.edges.iter().enumerate() {
        let (t0, t1) = e.range;
        let mut cuts: Vec<(f64, usize)> = split_by_edge
            .get(&ei)
            .map(|v| v.iter().map(|&(t, c)| (t, vid[c])).collect())
            .unwrap_or_default();
        let ring = e.start.is_none() && e.end.is_none();
        if !ring {
            cuts.push((t0, vid[e.start.expect("open")]));
            cuts.push((t1, vid[e.end.expect("open")]));
        }
        cuts.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
        // Consecutive splits at the same merged vertex are one split, unless the curve goes
        // around between them: a closed edge whose two ends are one vertex (a circle
        // touching another face's edge at a point, a loop through that vertex twice) keeps
        // both ends (collapsing them used to drop the edge from every face, leaving e.g. a
        // loopless, closed sphere face).
        cuts.dedup_by(|b, a| a.1 == b.1 && e.curve.arc_length(a.0, b.0) <= 10.0 * VTOL);
        let mut segs: Vec<(f64, f64, Option<usize>, Option<usize>)> = Vec::new();
        if ring && cuts.is_empty() {
            segs.push((t0, t1, None, None));
        } else if ring {
            match e.curve.period() {
                Some(per) => {
                    // Wrap-around: a first and last split at the same vertex are one.
                    if cuts.len() >= 2 && cuts[0].1 == cuts[cuts.len() - 1].1 {
                        cuts.pop();
                    }
                    for k in 0..cuts.len() {
                        let (ta, ca) = cuts[k];
                        let (tb, cb) = if k + 1 < cuts.len() {
                            cuts[k + 1]
                        } else {
                            (cuts[0].0 + per, cuts[0].1)
                        };
                        segs.push((ta, tb, Some(ca), Some(cb)));
                    }
                }
                None => {
                    // Closed non-periodic curve: a vertex was added at its range start.
                    for w in cuts.windows(2) {
                        segs.push((w[0].0, w[1].0, Some(w[0].1), Some(w[1].1)));
                    }
                    let (tl, cl) = *cuts.last().expect("cuts");
                    if tl < t1 {
                        segs.push((tl, t1, Some(cl), Some(cuts[0].1)));
                    }
                }
            }
        } else {
            for w in cuts.windows(2) {
                segs.push((w[0].0, w[1].0, Some(w[0].1), Some(w[1].1)));
            }
        }
        for (ta, tb, s, en) in segs {
            if tb - ta <= 1e-12 * (1.0 + ta.abs()) {
                continue;
            }
            if s.is_some() && s == en && e.curve.eval(ta).distance(e.curve.eval(tb)) <= VTOL {
                // Collapsed between two merged hits: a closed piece only when the curve
                // actually goes around (length well above the tolerance).
                if e.curve.arc_length(ta, tb) <= 10.0 * VTOL {
                    continue;
                }
            }
            let mut on: Vec<OnFace> = Vec::with_capacity(edge_uses[ei].len());
            for (fi, fwd, pc) in &edge_uses[ei] {
                // A piece of a closed periodic edge split at its hits runs past the end of
                // the edge's range (it wraps through the old start, where no vertex is left):
                // a non-periodic pcurve (fitted B-spline) would be extrapolated there, far off
                // the surface. Refit it over the piece.
                let (d0, d1) = pc.domain();
                let eps = 1e-12 * (1.0 + d0.abs().max(d1.abs()));
                let pcurve = if pc.period().is_none() && (ta < d0 - eps || tb > d1 + eps) {
                    let per = e.curve.period().unwrap_or(d1 - d0);
                    let t_in = if ta < d0 { ta + per } else { ta };
                    let near = Some(pc.eval(t_in.clamp(d0, d1)));
                    let surf = &m.faces[*fi].surface;
                    fit_pcurve(surf, &e.curve, (ta, tb), near)?.0
                } else {
                    pc.clone()
                };
                on.push(OnFace {
                    face: *fi,
                    pcurve,
                    boundary: Some(*fwd),
                });
            }
            let tm = 0.5 * (ta + tb);
            let pm = e.curve.eval(tm);
            for &(oe, gi, (oa, ob)) in &overlaps {
                if oe != ei || tm < oa - 1e-12 || tm > ob + 1e-12 {
                    continue;
                }
                let uv = uv_near(&m.faces[gi].surface, pm, None);
                if locate(m, gi, pm, uv) == Loc::Out {
                    continue;
                }
                let near = Some(uv_near(&m.faces[gi].surface, e.curve.eval(ta), Some(uv)));
                let (pc, _) = fit_pcurve(&m.faces[gi].surface, &e.curve, (ta, tb), near)?;
                on.push(OnFace {
                    face: gi,
                    pcurve: pc,
                    boundary: None,
                });
            }
            pieces.push(Piece {
                curve: e.curve.clone(),
                range: (ta, tb),
                start: s,
                end: en,
                tol: e.tol,
                src: PieceSrc::Edge(ei),
                on,
            });
        }
    }
    for mut rs in raw_sections {
        let (s, e) = (rs.start.map(|c| vid[c]), rs.end.map(|c| vid[c]));
        if s.is_some() && s == e {
            let len = rs.curve.arc_length(rs.range.0, rs.range.1);
            if len <= 10.0 * VTOL {
                continue;
            }
        }
        // A piece of a closed periodic branch can run past the end of the branch's (non-
        // periodic) pcurves, which would extrapolate there: refit them over the piece.
        for (face, pc) in [(rs.f, &mut rs.pc_f), (rs.g, &mut rs.pc_g)] {
            if pc.period().is_some() {
                continue;
            }
            let (d0, d1) = pc.domain();
            let eps = 1e-12 * (1.0 + d0.abs().max(d1.abs()));
            if rs.range.0 >= d0 - eps && rs.range.1 <= d1 + eps {
                continue;
            }
            let surf = &m.faces[face].surface;
            let per = rs.curve.period().unwrap_or(d1 - d0);
            let t_in = |t: f64| {
                if t > d1 {
                    t - per
                } else if t < d0 {
                    t + per
                } else {
                    t
                }
            };
            let near = Some(pc.eval(t_in(rs.range.0).clamp(d0, d1)));
            let (npc, err) = fit_pcurve(surf, &rs.curve, rs.range, near)?;
            rs.tol = rs.tol.max(err);
            *pc = npc;
        }
        // At a singular point of a face's surface (cone apex, sphere pole) the SSI pcurve's
        // `u` is arbitrary: refit it there, with `u` the limit along the curve.
        for (face, pc) in [(rs.f, &mut rs.pc_f), (rs.g, &mut rs.pc_g)] {
            let surf = &m.faces[face].surface;
            let sing = super::geom::singular_vs(surf);
            if sing.is_empty() {
                continue;
            }
            // An end within `SINGULAR_SNAP` of the singular point (a fitted section passes a
            // pole only within its fit tolerance) must end exactly on the singular line.
            let at_singular = |t: f64| {
                let p = rs.curve.eval(t);
                let v = uv_near(surf, p, None).y;
                sing.iter()
                    .any(|&vs| (v - vs).abs() <= 1e-9 * (1.0 + vs.abs()))
                    || singular_v_at(surf, p, super::geom::SINGULAR_SNAP).is_some()
            };
            if at_singular(rs.range.0) || at_singular(rs.range.1) {
                let near = Some(pc.eval(0.5 * (rs.range.0 + rs.range.1)));
                let mid = uv_near(surf, rs.curve.eval(0.5 * (rs.range.0 + rs.range.1)), near);
                // `near` for the start: continue from the middle's period copy backwards.
                let st = uv_near(
                    surf,
                    rs.curve.eval(rs.range.0 + 1e-3 * (rs.range.1 - rs.range.0)),
                    Some(mid),
                );
                let (npc, err) = fit_pcurve(surf, &rs.curve, rs.range, Some(st))?;
                rs.tol = rs.tol.max(err);
                *pc = npc;
            }
        }
        // Both faces' boundaries on the true intersection (`fit_section_pcurve`), not on
        // each surface's own projection of the fitted curve: the two faces then close up to
        // the pcurve fit (1e-10 mm) however far the fitted curve lies from them (review
        // round 4: 1e-8 mm apart, the volumes depended on forge-check's reference point).
        // Tangent sections keep their pcurves (no transversal meet); analytic sections
        // (lines, circles, ellipses) lie on both surfaces already.
        if sections && !rs.tangent && matches!(rs.curve, Curve3::BSpline(_)) {
            let (sf, sg) = (&m.faces[rs.f].surface, &m.faces[rs.g].surface);
            let t0 = rs.range.0;
            if let Some(Ok((pc, err))) =
                super::geom::fit_section_pcurve(sf, sg, &rs.curve, rs.range, Some(rs.pc_f.eval(t0)))
            {
                rs.tol = rs.tol.max(err);
                rs.pc_f = pc;
            }
            if let Some(Ok((pc, err))) =
                super::geom::fit_section_pcurve(sg, sf, &rs.curve, rs.range, Some(rs.pc_g.eval(t0)))
            {
                if std::env::var_os("FORGE_BOOLEAN_DEBUG_SECTION").is_some() {
                    let tm = 0.5 * (t0 + rs.range.1);
                    eprintln!(
                        "section refit on {}: range {:?} old {:?} {:?} {:?} new {:?} {:?} {:?}",
                        m.faces[rs.g].prov.name(),
                        rs.range,
                        rs.pc_g.eval(t0),
                        rs.pc_g.eval(tm),
                        rs.pc_g.eval(rs.range.1),
                        pc.eval(t0),
                        pc.eval(tm),
                        pc.eval(rs.range.1)
                    );
                }
                rs.tol = rs.tol.max(err);
                rs.pc_g = pc;
            }
        }
        pieces.push(Piece {
            curve: rs.curve,
            range: rs.range,
            start: s,
            end: e,
            tol: rs.tol.max(VTOL),
            src: PieceSrc::Section {
                f: rs.f,
                g: rs.g,
                tangent: rs.tangent,
            },
            on: vec![
                OnFace {
                    face: rs.f,
                    pcurve: rs.pc_f,
                    boundary: None,
                },
                OnFace {
                    face: rs.g,
                    pcurve: rs.pc_g,
                    boundary: None,
                },
            ],
        });
    }
    let pieces = dedup(m, pieces)?;
    Ok(Imprint {
        verts,
        pieces,
        coincident,
        tangent_points,
        contact: contact_curve
            .map(|p| (p, EntityKind::Edge))
            .or(contact.map(|p| (p, EntityKind::Vertex))),
        uncertified,
    })
}

/// Merge vertex candidates closer than [`VTOL`] (single linkage, deterministic).
fn merge_vertices(m: &Model, cands: &[Cand]) -> Result<(Vec<usize>, Vec<Vert>), BooleanError> {
    let n = cands.len();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| cands[a].p.x.total_cmp(&cands[b].p.x).then(a.cmp(&b)));
    let mut uf: Vec<usize> = (0..n).collect();
    fn find(uf: &mut [usize], mut x: usize) -> usize {
        while uf[x] != x {
            uf[x] = uf[uf[x]];
            x = uf[x];
        }
        x
    }
    for i in 0..n {
        let a = order[i];
        for &b in &order[i + 1..] {
            if cands[b].p.x - cands[a].p.x > VTOL {
                break;
            }
            if cands[a].p.distance(cands[b].p) <= VTOL {
                let (ra, rb) = (find(&mut uf, a), find(&mut uf, b));
                if ra != rb {
                    let (lo, hi) = (ra.min(rb), ra.max(rb));
                    uf[hi] = lo;
                }
            }
        }
    }
    let mut root_to_vid: BTreeMap<usize, usize> = BTreeMap::new();
    let mut vid = vec![0usize; n];
    let mut members: Vec<Vec<usize>> = Vec::new();
    for (i, vi) in vid.iter_mut().enumerate() {
        let r = find(&mut uf, i);
        let k = members.len();
        let v = *root_to_vid.entry(r).or_insert(k);
        if v == members.len() {
            members.push(Vec::new());
        }
        members[v].push(i);
        *vi = v;
    }
    let mut verts = Vec::with_capacity(members.len());
    for mem in &members {
        // Operand vertices in the cluster: at most one per operand.
        let origs: Vec<usize> = mem.iter().filter_map(|&c| cands[c].orig).collect();
        for k in 0..2 {
            let of_k = origs
                .iter()
                .filter(|&&o| cands[o].operand == Some(k))
                .count();
            if of_k > 1 {
                let p = cands[mem[0]].p;
                return Err(BooleanError::inconsistent(
                    "two vertices of one operand closer than the tolerance",
                    format!("({}, {}, {})", p.x, p.y, p.z),
                ));
            }
        }
        let rep = origs.first().copied();
        let p = match rep {
            Some(o) => m.verts[o].p,
            None => cands[mem[0]].p,
        };
        let mut tol: f64 = VTOL;
        for &c in mem {
            tol = tol.max(cands[c].tol).max(cands[c].p.distance(p));
        }
        verts.push(Vert { p, tol, orig: rep });
    }
    Ok((vid, verts))
}

fn priority(src: PieceSrc, m: &Model) -> (u8, usize) {
    match src {
        PieceSrc::Edge(e) => (m.edges[e].operand as u8, e),
        PieceSrc::Section { f, g, .. } => (2, f * m.faces.len() + g),
    }
}

/// `Some((distance, point))` if pieces `a` and `b` (same end vertices) are the same curve
/// piece within `10·VTOL`: the largest distance of their quarter points and middles from
/// each other, and where it was measured. `None` if they are different curves.
fn same_piece(a: &Piece, b: &Piece) -> Option<(f64, Point3)> {
    let mid = |p: &Piece| p.curve.eval(0.5 * (p.range.0 + p.range.1));
    let q = |p: &Piece, t: f64| p.curve.eval(p.range.0 + (p.range.1 - p.range.0) * t);
    // Middles and quarter points on each other.
    let mut worst = (0.0, mid(a));
    for (x, y) in [(a, b), (b, a)] {
        for (i, t) in [0.25, 0.5, 0.75].into_iter().enumerate() {
            let pt = if i == 1 { mid(x) } else { q(x, t) };
            let d = param_on(&y.curve, y.range, pt).1;
            if d > 10.0 * VTOL {
                return None;
            }
            if d > worst.0 {
                worst = (d, pt);
            }
        }
    }
    Some(worst)
}

/// Provenance names of the entities a piece comes from (for error details).
fn piece_name(m: &Model, p: &Piece) -> String {
    match p.src {
        PieceSrc::Edge(e) => m.edges[e].prov.name(),
        PieceSrc::Section { f, g, .. } => {
            format!("{} ∩ {}", m.faces[f].prov.name(), m.faces[g].prov.name())
        }
    }
}

/// Merge coincident pieces (see the module docs).
fn dedup(m: &Model, mut pieces: Vec<Piece>) -> Result<Vec<Piece>, BooleanError> {
    pieces.sort_by(|a, b| {
        priority(a.src, m)
            .cmp(&priority(b.src, m))
            .then(a.range.0.total_cmp(&b.range.0))
    });
    // Buckets by end vertices (rings by none).
    let mut buckets: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
    for (i, p) in pieces.iter().enumerate() {
        let key = match (p.start, p.end) {
            (Some(a), Some(b)) => (a.min(b), a.max(b)),
            _ => (usize::MAX, usize::MAX),
        };
        buckets.entry(key).or_default().push(i);
    }
    let mut merged_into: Vec<Option<usize>> = vec![None; pieces.len()];
    for idxs in buckets.values() {
        for (k, &i) in idxs.iter().enumerate() {
            if merged_into[i].is_some() {
                continue;
            }
            for &j in &idxs[k + 1..] {
                if merged_into[j].is_some() {
                    continue;
                }
                let (pi, pj) = (&pieces[i], &pieces[j]);
                if let Some((d, at)) = same_piece(pi, pj) {
                    // One curve within the tolerances, or two distinct curves closer than
                    // the boolean can separate (near-coincident faces): an explicit error,
                    // never an edge whose tolerance silently absorbs the offset.
                    if d > VTOL.max(pi.tol).max(pj.tol) {
                        return Err(BooleanError::NearCoincident {
                            entities: format!("{} × {}", piece_name(m, pi), piece_name(m, pj)),
                            offset: d,
                            limit: 10.0 * VTOL,
                            point: at.to_array(),
                            reason: "two edge pieces with the same ends lie closer than the boolean can separate".into(),
                        });
                    }
                    merged_into[j] = Some(i);
                }
            }
        }
    }
    // Move the faces of merged pieces onto their representative.
    let mut out: Vec<Piece> = Vec::new();
    let mut new_index: Vec<usize> = vec![usize::MAX; pieces.len()];
    for i in 0..pieces.len() {
        if merged_into[i].is_none() {
            new_index[i] = out.len();
            out.push(pieces[i].clone());
        }
    }
    for j in 0..pieces.len() {
        let Some(i) = merged_into[j] else { continue };
        let rep = new_index[i];
        let (rc, rr) = (out[rep].curve.clone(), out[rep].range);
        let src = &pieces[j];
        // Direction agreement at the middle.
        let tm = 0.5 * (rr.0 + rr.1);
        let d_rep = rc.d1(tm);
        let (tj, _) = param_on(&src.curve, src.range, rc.eval(tm));
        let same_dir = d_rep.dot(src.curve.d1(tj)) > 0.0;
        out[rep].tol = out[rep].tol.max(src.tol);
        for of in &src.on {
            let face = &m.faces[of.face];
            let near = Some(of.pcurve.eval(tj));
            let (pc, err) = fit_pcurve(&face.surface, &rc, rr, near)?;
            out[rep].tol = out[rep].tol.max(err);
            out[rep].on.push(OnFace {
                face: of.face,
                pcurve: pc,
                boundary: of.boundary.map(|f| if same_dir { f } else { !f }),
            });
        }
    }
    // Faces listed twice: boundary wins over interior; two boundary uses of one face are
    // a degenerate input.
    for p in &mut out {
        let mut by_face: BTreeMap<usize, Vec<OnFace>> = BTreeMap::new();
        for of in p.on.drain(..) {
            by_face.entry(of.face).or_default().push(of);
        }
        for (face, mut v) in by_face {
            let nb = v.iter().filter(|o| o.boundary.is_some()).count();
            if nb > 1 {
                return Err(BooleanError::inconsistent(
                    "an edge piece bounds one face twice",
                    m.faces[face].prov.name(),
                ));
            }
            v.sort_by_key(|o| o.boundary.is_none());
            p.on.push(v.swap_remove(0));
        }
        p.on.sort_by_key(|o| o.face);
    }
    Ok(out)
}
