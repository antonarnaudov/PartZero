//! Fillets (SPEC §6.6) and chamfers (§6.7) by **direct B-rep construction**.
//!
//! # Algorithm
//! 1. **Selection**: the edges (plus the tangent chain, §6.6) — every pick an edge of the
//!    body operated on (never an id of another body read as this one's) — each checked to
//!    lie between two faces of the body (`boundary`), on supported surfaces
//!    (`surface-type`) and not `smooth`; otherwise `*_EDGE_UNSUPPORTED` with every offending
//!    edge. An empty set is `*_FAILED` saying so.
//! 2. **Cross-sections** ([`edge`]): each edge's blend surface (cylinder / torus / plane /
//!    cone) and contact curves, exact.
//! 3. **Vertices** ([`vertex`]): at each vertex of the blended edges, the blend ends on the
//!    third face, continues into its tangent neighbour, meets another blend in a mitre, or
//!    closes with a corner patch (sphere / plane); edges of the vertex that are not blended
//!    are trimmed or extended along their own carriers. Chamfer corners of three edges other
//!    than the planar one at three mutually perpendicular faces are engine-defined and fail
//!    explicitly until the Contract stage rules on them (W6 review round 6).
//! 4. **Assembly**: the faces around each blended edge get the contact curve in place of the
//!    edge; end curves are inserted into the faces the blends end on; the blend faces and
//!    corner patches are added. Everything else is copied unchanged (keys kept).
//! 5. **Checks** before building (each a *violation* attributed to the blended edges that
//!    cause it): new and trimmed edges keep a length above `10·tol` and their direction;
//!    no face boundary meets itself in its parameter domain — certified: exact rational
//!    Bézier forms, convex-hull bounds and subdivision ([`crate::check`], `cert2d`), so two
//!    blends' contacts overlapping by less than any sampling resolution are caught; nothing
//!    of the input lies in the material a blend removes (convex) or fills (concave) —
//!    exact region tests against every vertex, edge and curved face ([`region`]). Then the
//!    body is built and must pass `forge_check::validate` with a positive volume, and a
//!    convex-only (concave-only) blend must lose (gain) volume. A check that cannot be
//!    decided either way (the crossing certificate out of budget or depth, an intersection
//!    forge-ssi cannot certify, a free-form face near a blend's region) is **undecided**
//!    ([`Fail::Unverified`], W6 review round 5): not a violation, not a pass.
//!
//! # Errors and feasible ranges
//! A structural limitation is `*_FAILED` naming the entity; so is an undecided check (W6
//! review round 5: a size limit is only ever a proven violation), a blend that runs into
//! another feature of the body where the maximum is found (W6 review round 6: an
//! **obstacle**, [`Violation::obstacle`] — SPEC §6.6 defines the rolling ball there and gives
//! no size limit for it, so it is a capability gap; the reason names the obstacle's face and
//! the largest value that builds clear of it), and a built body that fails
//! validation, unless the validator proves a face used up (its domain inverted: the contacts
//! of its blends passed each other, a `face-width` limit). When the requested value is
//! **proven** infeasible ([`finish`]): the smallest **analytic** limit ([`limits`]: the width
//! of the face the contact runs across, shared with a parallel blended edge on it; two blended
//! rim circles, or a rim circle and a blended line edge, whose contacts on one plane meet) is
//! taken when the construction confirms it; otherwise the largest feasible value is searched
//! from the requested value down to an absolute floor and bisected to 1e-4 mm (SPEC §6.6:
//! "otherwise by bisection"), within a fixed budget of constructions ([`FINISH_RUNS`]); every
//! verdict is three-way — built, proven infeasible, undecided — and only a proven one
//! brackets the range (an undecided one stops the descent; in a bisection it caps the search
//! for the largest built value without bounding the range). The
//! suggestion is rounded **down** to 0.001 mm, is always a value that was built, and is
//! confirmed: `max + 0.001` and `1.01·max` (below 0.1 mm only the former) fail with a proven
//! violation, or the range above is searched again; otherwise `*_FAILED` says how far the
//! search got. Each failing edge gets its own limit (`max_r` / `max_d`, never below the global
//! one, which is their minimum), classified by the analytic limit whenever its value is the
//! one found, so that one configuration gets one `limit` at every requested value; no
//! attributable violation is `*_FAILED`, never an invented limit (W6 review round 4). A
//! two-distance chamfer scales both distances together. If no positive value works the error
//! is `*_FAILED`.

pub(crate) mod edge;
pub(crate) mod limits;
pub(crate) mod region;
pub(crate) mod section;
pub(crate) mod vertex;

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::Curve3;
use forge_core::linalg::Point3;
use forge_core::math;
use forge_core::topo::{Body, EdgeId, FaceId, Provenance};
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ir::v1::metrics::BlendReport;

use crate::error::{
    BlendError, BlendOp, EdgeDistanceLimit, EdgeRadiusLimit, Limit, Named, UnsupportedEdge,
    UnsupportedReason, round_down_mm,
};
use crate::geom::arc_between;
use crate::keys::{KeyMap, Pick};
use crate::plan::{PE, PF, PU, Plan};
use crate::topo::{Adj, Convexity, edge_convexity, supported_surface, tangent_chain};
use edge::{EgFail, Prof, edge_blend};
use vertex::CornerPatch;

/// Options shared by fillet and chamfer.
#[derive(Clone, Debug)]
pub struct BlendOptions {
    /// The feature id (provenance of new entities: `F/blend:{E}`, …).
    pub feature: String,
    /// Expand the set along tangent chains (SPEC §6.6, default `true`).
    pub tangent_chain: bool,
    /// Keys and display names of the input's entities (derived from provenance for the
    /// entities it does not name).
    pub keys: Option<KeyMap>,
    /// Index of the body operated on, in the numbering of the picks' [`Pick::body`]
    /// (default 0). Every pick must belong to it.
    pub body: usize,
}

impl BlendOptions {
    /// Options with the default `tangent_chain: true`, derived keys and body index 0.
    pub fn new(feature: impl Into<String>) -> Self {
        Self {
            feature: feature.into(),
            tangent_chain: true,
            keys: None,
            body: 0,
        }
    }
}

/// A chamfer's form (SPEC §6.7).
#[derive(Clone, Debug, PartialEq)]
pub enum ChamferSpec {
    /// `{ d }`: distance `d` on both faces.
    Equal {
        /// Distance (mm).
        d: f64,
    },
    /// `{ d, d2, side }`: `d` on `side`, `d2` on the other face.
    TwoDistances {
        /// Distance on `side` (mm).
        d: f64,
        /// Distance on the other face (mm).
        d2: f64,
        /// The face `d` is measured on (a face of the chamfered body).
        side: Pick<FaceId>,
    },
    /// `{ d, angle, side }`: `d` on `side`, the bevel at `angle_deg` to `side`.
    DistanceAngle {
        /// Distance on `side` (mm).
        d: f64,
        /// Angle between the bevel and `side`, in (0, 90) degrees.
        angle_deg: f64,
        /// The face `d` is measured on (a face of the chamfered body).
        side: Pick<FaceId>,
    },
}

/// A fillet or chamfer result.
#[derive(Clone, Debug)]
pub struct BlendOutput {
    /// The new body (validated).
    pub body: Body,
    /// The report block (`fillet` / `chamfer`, SPEC §7.2): blended edge keys (the given
    /// edges, then the chain), the chain's keys, the created faces' keys.
    pub report: BlendReport,
    /// Edges added by tangent-chain expansion (ids of the input body).
    pub chain_added: Vec<EdgeId>,
}

/// A violated check at some value, attributed to blended (plan) edges.
#[derive(Clone, Debug)]
pub(crate) struct Violation {
    pub edges: BTreeSet<usize>,
    pub limit: Limit,
    pub face: Option<usize>,
    pub what: String,
    /// The blend runs into **another feature** of the body (W6 review round 6): an entity
    /// that is not on the outer boundary of a face the blend touches or ends on — a hole's or
    /// a boss's rim inside a face, a tunnel, a drill point — rather than using up a face's own
    /// width. SPEC §6.6 defines the rolling ball there (OCCT trims it around the feature), so
    /// this is not a size limit: when it binds, the error is `*_FAILED` naming the obstacle
    /// (`face`), a capability gap, never `*_TOO_LARGE`.
    pub obstacle: bool,
}

/// Why an attempt at one value failed.
#[derive(Clone, Debug)]
pub(crate) enum Fail {
    /// A structural limitation, whatever the value.
    Failed { edges: Vec<usize>, reason: String },
    /// Checks failed at this value: **proven** violations.
    Infeasible(Vec<Violation>),
    /// A check that could not be decided either way at this value (W6 review round 5): the
    /// crossing certificate out of budget or depth, a pcurve it cannot convert, an
    /// intersection forge-ssi cannot certify, a face near a blend's region that cannot be
    /// bounded or is free-form. Not a size limit: `*_FAILED` naming the entities, and never
    /// a bracket of the feasible-range search.
    Unverified { edges: Vec<usize>, reason: String },
    /// The built body is invalid (not attributable).
    Invalid(String),
}

/// Fixed context of one operation.
pub(crate) struct Cx<'a> {
    pub plan0: &'a Plan,
    pub adj: &'a Adj,
    pub feature: &'a str,
    /// `blend` (fillet) or `bevel` (chamfer).
    pub label: &'static str,
    pub fkey: Vec<String>,
    pub fname: Vec<String>,
    pub ekey: Vec<String>,
    pub ename: Vec<String>,
    pub vkey: Vec<String>,
    pub vname: Vec<String>,
    pub set: Vec<usize>,
    /// Chamfer side face per blended edge (two-distance and distance–angle forms).
    pub sides: BTreeMap<usize, usize>,
    pub scale: f64,
}

/// Mutable state of one attempt.
pub(crate) struct St<'a> {
    pub cx: &'a Cx<'a>,
    pub plan: Plan,
    pub egs: BTreeMap<usize, edge::Eg>,
    /// `(vertex, face, blended edge)` → the new vertex where that face's contact ends.
    pub ends: BTreeMap<(usize, usize, usize), usize>,
    /// `(vertex, edge)` → the new vertex replacing `vertex` on a trimmed edge.
    pub moved: BTreeMap<(usize, usize), usize>,
    /// `(vertex, face)` → edges inserted into the face's loop at the vertex.
    pub inserts: BTreeMap<(usize, usize), Vec<usize>>,
    /// `(vertex, blended edge)` → the edges closing the blend face there, a chain from one
    /// contact end to the other (one edge, or a mitre and the curve on the face the blend
    /// then ends on).
    pub closers: BTreeMap<(usize, usize), Vec<usize>>,
    pub corners: Vec<CornerPatch>,
    /// `(vertex, blended edge)` → how the material the blend removes or fills ends there
    /// (for the obstacle checks of [`region`]).
    pub endk: BTreeMap<(usize, usize), region::EndKind>,
    /// Corner cells (the material a corner patch removes or fills).
    pub cells: Vec<region::Cell>,
    /// New or trimmed plan edge → blended edges it depends on.
    pub attr: BTreeMap<usize, BTreeSet<usize>>,
    pub viol: Vec<Violation>,
    /// Checks that could not be decided (see [`Fail::Unverified`]): the blended edges
    /// concerned and what could not be decided.
    pub unverified: Vec<(BTreeSet<usize>, String)>,
}

impl<'a> St<'a> {
    fn new(cx: &'a Cx<'a>) -> Self {
        Self {
            cx,
            plan: cx.plan0.clone(),
            egs: BTreeMap::new(),
            ends: BTreeMap::new(),
            moved: BTreeMap::new(),
            inserts: BTreeMap::new(),
            closers: BTreeMap::new(),
            corners: Vec::new(),
            endk: BTreeMap::new(),
            cells: Vec::new(),
            attr: BTreeMap::new(),
            viol: Vec::new(),
            unverified: Vec::new(),
        }
    }

    pub fn failed(&self, edges: &[usize], reason: String) -> Fail {
        Fail::Failed {
            edges: edges.to_vec(),
            reason,
        }
    }

    /// Key of the blend face of edge `e`.
    pub fn blend_key(&self, e: usize) -> String {
        crate::keys::derived(self.cx.feature, self.cx.label, &self.cx.ekey[e]).key()
    }

    pub fn new_vertex(&mut self, p: Point3, faces: Vec<String>) -> usize {
        let prov = crate::keys::vertex_at(self.cx.feature, &faces);
        self.plan.add_v(p, prov)
    }

    /// A new edge on `curve` between vertices `va` and `vb` (the arc through `mid` for
    /// closed curves), attributed to `edges`; `face` names the face for a violation.
    #[allow(clippy::too_many_arguments)]
    pub fn new_edge(
        &mut self,
        curve: Curve3,
        va: usize,
        vb: usize,
        mid: Point3,
        prov: Provenance,
        edges: &[usize],
        face: usize,
    ) -> Result<usize, Fail> {
        let (pa, pb) = (self.plan.vs[va].p, self.plan.vs[vb].p);
        let face = (face != usize::MAX).then_some(face);
        let Some((range, fwd)) = arc_between(&curve, pa, pb, mid) else {
            self.viol.push(Violation {
                obstacle: false,
                edges: edges.iter().copied().collect(),
                limit: Limit::FaceWidth,
                face,
                what: "a new edge collapses to a point".into(),
            });
            return Err(Fail::Infeasible(std::mem::take(&mut self.viol)));
        };
        let len = crate::geom::length(&curve, range);
        if len.is_nan() || len <= 10.0 * LINEAR_TOLERANCE {
            self.viol.push(Violation {
                obstacle: false,
                edges: edges.iter().copied().collect(),
                limit: Limit::FaceWidth,
                face,
                what: format!("a new edge is {len:.3e} mm long"),
            });
        }
        let (start, end) = if fwd { (va, vb) } else { (vb, va) };
        let idx = self.plan.add_e(PE {
            curve,
            range,
            start: Some(start),
            end: Some(end),
            tol: LINEAR_TOLERANCE,
            prov,
        });
        self.attr.insert(idx, edges.iter().copied().collect());
        Ok(idx)
    }

    pub fn note_moved(&mut self, e: usize, by: &[usize]) {
        self.attr.entry(e).or_default().extend(by.iter().copied());
    }
}

fn limit_of(st: &St<'_>, a: usize, b: usize) -> (BTreeSet<usize>, Limit) {
    let ga = st.attr.get(&a).cloned().unwrap_or_default();
    let gb = st.attr.get(&b).cloned().unwrap_or_default();
    let mut all = ga.clone();
    all.extend(gb.iter().copied());
    let adjacent = !ga.is_empty() && !gb.is_empty() && ga != gb;
    (
        all,
        if adjacent {
            Limit::AdjacentBlend
        } else {
            Limit::FaceWidth
        },
    )
}

/// One construction at `prof`. `Ok` is a plan that passed every pre-build check.
fn attempt(cx: &Cx<'_>, prof: Prof) -> Result<(Plan, Vec<String>, i8), Fail> {
    let mut st = St::new(cx);
    // Cross-sections.
    for &e in &cx.set {
        match edge_blend(cx.plan0, cx.adj, e, prof, cx.sides.get(&e).copied()) {
            Ok(g) => {
                st.egs.insert(e, g);
            }
            Err(EgFail::Failed(m)) => {
                return Err(Fail::Failed {
                    edges: vec![e],
                    reason: format!("edge {}: {m}", cx.ename[e]),
                });
            }
            Err(EgFail::Infeasible { limit, face, what }) => st.viol.push(Violation {
                obstacle: false,
                edges: [e].into_iter().collect(),
                limit,
                face: Some(face),
                what,
            }),
        }
    }
    if !st.viol.is_empty() {
        return Err(Fail::Infeasible(st.viol));
    }
    // Vertices.
    let verts: BTreeSet<usize> = cx
        .set
        .iter()
        .flat_map(|&e| [cx.plan0.es[e].start, cx.plan0.es[e].end])
        .flatten()
        .collect();
    for &v in &verts {
        vertex::vertex(&mut st, v)?;
    }
    // Contact edges.
    let mut contacts: BTreeMap<(usize, usize), usize> = BTreeMap::new();
    let egs: Vec<edge::Eg> = st.egs.values().cloned().collect();
    for g in &egs {
        let pe = cx.plan0.es[g.e].clone();
        for (k, f) in [(0usize, g.a), (1usize, g.b)] {
            let bk = st.blend_key(g.e);
            let prov = crate::keys::edge_between(cx.feature, &cx.fkey[f], &bk);
            let curve = g.contact[k].clone();
            let ce = if pe.is_ring() {
                let per = curve.period().unwrap_or(math::TAU);
                let idx = st.plan.add_e(PE {
                    curve,
                    range: (0.0, per),
                    start: None,
                    end: None,
                    tol: LINEAR_TOLERANCE,
                    prov,
                });
                st.attr.insert(idx, [g.e].into_iter().collect());
                idx
            } else {
                let (v0, v1) = (pe.start.expect("open"), pe.end.expect("open"));
                let (Some(&x0), Some(&x1)) =
                    (st.ends.get(&(v0, f, g.e)), st.ends.get(&(v1, f, g.e)))
                else {
                    return Err(Fail::Failed {
                        edges: vec![g.e],
                        reason: format!("internal: no contact end for edge {}", cx.ename[g.e]),
                    });
                };
                let tm = 0.5 * (pe.range.0 + pe.range.1);
                let sm = g.station(pe.curve.eval(tm));
                let mid = g.contact_at(k, sm);
                // The contact must run the edge's way (the blends at its ends must not
                // overlap).
                let (p0, p1) = (st.plan.vs[x0].p, st.plan.vs[x1].p);
                // A blend ending on a face oblique to its meridians ends its contacts beyond
                // or short of the edge's own end angles.
                let oblique_end = [v0, v1].iter().any(|&v| {
                    matches!(st.endk.get(&(v, g.e)), Some(region::EndKind::OnFace { .. }))
                });
                let span_ok = match g.st_range {
                    Some((s0, s1)) => {
                        let (a0, a1) = (g.station(p0), g.station(p1));
                        if g.fam.is_line() {
                            a1 - a0 > 10.0 * LINEAR_TOLERANCE
                        } else {
                            // Angles along the contact circle: its arc must be longer than
                            // 10·tol and not longer (by more than tol) than the edge's span
                            // (unless an end is oblique: then less than a full turn).
                            let d = crate::geom::wrap(a1 - a0);
                            let de = if oblique_end { math::TAU } else { s1 - s0 };
                            let at = crate::geom::param_tol(&curve);
                            d > 10.0 * at && d <= de + at
                        }
                    }
                    None => true,
                };
                if !span_ok {
                    let mut es: BTreeSet<usize> = [g.e].into_iter().collect();
                    let mut adjb = false;
                    for v in [v0, v1] {
                        for x in cx.adj.vertex_edges(v) {
                            if x != g.e && st.egs.contains_key(&x) {
                                es.insert(x);
                                adjb = true;
                            }
                        }
                    }
                    st.viol.push(Violation {
                        obstacle: false,
                        edges: es,
                        limit: if adjb {
                            Limit::AdjacentBlend
                        } else {
                            Limit::FaceWidth
                        },
                        face: Some(f),
                        what: format!("the blend of {} is longer than the edge", cx.ename[g.e]),
                    });
                    continue;
                }
                st.new_edge(curve, x0, x1, mid, prov, &[g.e], f)?
            };
            contacts.insert((g.e, f), ce);
        }
    }
    if !st.viol.is_empty() {
        return Err(Fail::Infeasible(st.viol));
    }
    // Trimmed edges.
    let mut by_edge: BTreeMap<usize, Vec<(usize, usize)>> = BTreeMap::new();
    for (&(v, e), &nv) in &st.moved {
        by_edge.entry(e).or_default().push((v, nv));
    }
    for (e, reps) in by_edge {
        let mut pe = st.plan.es[e].clone();
        let (mut t0, mut t1) = pe.range;
        for (v, nv) in reps {
            let x = st.plan.vs[nv].p;
            if pe.start == Some(v) {
                t0 = param_near(&pe.curve, x, t0);
                pe.start = Some(nv);
            }
            if pe.end == Some(v) {
                t1 = param_near(&pe.curve, x, t1);
                pe.end = Some(nv);
            }
        }
        let len = if t1 > t0 {
            crate::geom::length(&pe.curve, (t0, t1))
        } else {
            -1.0
        };
        if len.is_nan() || len <= 10.0 * LINEAR_TOLERANCE {
            let by = st.attr.get(&e).cloned().unwrap_or_default();
            let adjb = by.len() > 1;
            // The face whose width ran out is the one of the trimmed edge's two faces that a
            // blend's contact runs along (a face of a blended edge of `by`), not the face the
            // blend ends on (W6 review round 6: it named the end cap).
            let faces = cx.adj.edge_faces(e);
            let face = faces
                .iter()
                .copied()
                .find(|&f| {
                    by.iter()
                        .any(|g| st.egs.get(g).is_some_and(|x| x.a == f || x.b == f))
                })
                .or_else(|| faces.first().copied());
            let left = if len >= 0.0 {
                format!("{len:.1e} mm left")
            } else {
                "trimmed past its other end".to_string()
            };
            st.viol.push(Violation {
                obstacle: false,
                edges: by,
                limit: if adjb {
                    Limit::AdjacentBlend
                } else {
                    Limit::FaceWidth
                },
                face,
                what: format!(
                    "edge {} is used up by the blends ({left}; an edge must keep 10·tol = {:.0e} mm)",
                    cx.ename[e],
                    10.0 * LINEAR_TOLERANCE
                ),
            });
            continue;
        }
        pe.range = (t0, t1);
        st.plan.es[e] = pe;
    }
    if !st.viol.is_empty() {
        return Err(Fail::Infeasible(st.viol));
    }
    // Loops of the existing faces.
    let mut face_use: BTreeMap<(usize, usize), bool> = BTreeMap::new();
    let mut insert_use: BTreeMap<usize, bool> = BTreeMap::new();
    let mut touched: BTreeSet<usize> = BTreeSet::new();
    for &e in st.egs.keys() {
        touched.extend(cx.adj.edge_faces(e));
    }
    for &(_, e) in st.moved.keys() {
        touched.extend(cx.adj.edge_faces(e));
    }
    for &(_, f) in st.inserts.keys() {
        touched.insert(f);
    }
    for &f in &touched {
        let old = cx.plan0.fs[f].as_ref().expect("face").loops.clone();
        let mut loops = Vec::with_capacity(old.len());
        for lp in &old {
            let mut out: Vec<PU> = Vec::with_capacity(lp.len() + 2);
            for u in lp {
                if let Some(g) = st.egs.get(&u.edge) {
                    let ce = contacts[&(u.edge, f)];
                    let fwd = if cx.plan0.es[u.edge].is_ring() {
                        let same =
                            ring_same_direction(&cx.plan0.es[u.edge].curve, &st.plan.es[ce].curve);
                        u.fwd == same
                    } else {
                        let from = st.ends[&(cx.plan0.use_start(u).expect("open"), f, u.edge)];
                        st.plan.es[ce].start == Some(from)
                    };
                    let _ = g;
                    face_use.insert((f, ce), fwd);
                    out.push(PU {
                        edge: ce,
                        fwd,
                        pc: None,
                    });
                } else {
                    out.push(u.clone());
                }
                if let Some(vend) = cx.plan0.use_end(u)
                    && let Some(ins) = st.inserts.get(&(vend, f))
                {
                    for &ie in ins {
                        let cur = st.plan.use_end(out.last().expect("use")).expect("open");
                        let fwd = st.plan.es[ie].start == Some(cur);
                        insert_use.insert(ie, fwd);
                        out.push(PU {
                            edge: ie,
                            fwd,
                            pc: None,
                        });
                    }
                }
            }
            check_closed(&st.plan, &out).map_err(|m| Fail::Failed {
                edges: cx.set.clone(),
                reason: format!("internal: a loop of {} does not close ({m})", cx.fname[f]),
            })?;
            loops.push(out);
        }
        st.plan.fs[f].as_mut().expect("face").loops = loops;
    }
    // Blend faces.
    let mut created: Vec<String> = Vec::new();
    let mut new_faces: Vec<usize> = Vec::new();
    let mut closer_use: BTreeMap<usize, bool> = BTreeMap::new();
    for g in &egs {
        let (ca, cb) = (contacts[&(g.e, g.a)], contacts[&(g.e, g.b)]);
        let (da, db) = (face_use[&(g.a, ca)], face_use[&(g.b, cb)]);
        let pe = &cx.plan0.es[g.e];
        let loops = if pe.is_ring() {
            vec![
                vec![PU {
                    edge: ca,
                    fwd: !da,
                    pc: None,
                }],
                vec![PU {
                    edge: cb,
                    fwd: !db,
                    pc: None,
                }],
            ]
        } else {
            let mut lp = vec![PU {
                edge: ca,
                fwd: !da,
                pc: None,
            }];
            for (next, dir) in [(cb, !db), (ca, !da)] {
                let cur = st.plan.use_end(lp.last().expect("use")).expect("open");
                // The original vertex this contact end came from.
                let v = [pe.start, pe.end]
                    .into_iter()
                    .flatten()
                    .find(|&v| {
                        st.ends.get(&(v, g.a, g.e)) == Some(&cur)
                            || st.ends.get(&(v, g.b, g.e)) == Some(&cur)
                    })
                    .expect("end vertex");
                // Walk the closing chain from this contact end.
                let mut chain = st.closers[&(v, g.e)].clone();
                let mut at = cur;
                while let Some(i) = chain
                    .iter()
                    .position(|&x| st.plan.es[x].start == Some(at) || st.plan.es[x].end == Some(at))
                {
                    let cl = chain.remove(i);
                    let fwd = st.plan.es[cl].start == Some(at);
                    closer_use.insert(cl, fwd);
                    lp.push(PU {
                        edge: cl,
                        fwd,
                        pc: None,
                    });
                    at = st.plan.use_end(lp.last().expect("use")).expect("open");
                }
                if !chain.is_empty() {
                    return Err(Fail::Failed {
                        edges: vec![g.e],
                        reason: format!(
                            "internal: the closing curves of the blend of {} do not chain",
                            cx.ename[g.e]
                        ),
                    });
                }
                if next != ca {
                    lp.push(PU {
                        edge: next,
                        fwd: dir,
                        pc: None,
                    });
                }
            }
            check_closed(&st.plan, &lp).map_err(|m| Fail::Failed {
                edges: vec![g.e],
                reason: format!(
                    "internal: the blend face of {} does not close ({m})",
                    cx.ename[g.e]
                ),
            })?;
            vec![lp]
        };
        let prov = crate::keys::derived(cx.feature, cx.label, &cx.ekey[g.e]);
        created.push(prov.key());
        let shell = cx.plan0.fs[g.a].as_ref().expect("face").shell;
        // The middle of the profile, so that ring pcurves on a torus bound the right band.
        let hint = {
            let tm = 0.5 * (pe.range.0 + pe.range.1);
            let q = g.mid_profile(g.station(pe.curve.eval(tm)));
            let (u, v, _) = g.surf.project(q);
            Some(forge_core::linalg::Point2::new(u, v))
        };
        let fi = st.plan.add_f(PF {
            surf: g.surf.clone(),
            sense: g.sense,
            prov,
            loops,
            shell,
            hint,
        });
        new_faces.push(fi);
    }
    // Corner patches.
    for cp in std::mem::take(&mut st.corners) {
        // Each boundary edge the other way round from the face that already uses it.
        let mut uses: Vec<PU> = cp
            .arcs
            .iter()
            .map(|&a| (a, closer_use.get(&a)))
            .chain(cp.extra.iter().map(|&a| (a, insert_use.get(&a))))
            .map(|(a, used)| PU {
                edge: a,
                fwd: !used.copied().unwrap_or(true),
                pc: None,
            })
            .collect();
        let mut lp = vec![uses.remove(0)];
        while !uses.is_empty() {
            let cur = st.plan.use_end(lp.last().expect("use"));
            let Some(i) = uses.iter().position(|u| st.plan.use_start(u) == cur) else {
                return Err(Fail::Failed {
                    edges: cp.edges.clone(),
                    reason: format!("internal: the corner at {} does not close", cx.vname[cp.v]),
                });
            };
            lp.push(uses.remove(i));
        }
        check_closed(&st.plan, &lp).map_err(|m| Fail::Failed {
            edges: cp.edges.clone(),
            reason: format!(
                "internal: the corner at {} does not close ({m})",
                cx.vname[cp.v]
            ),
        })?;
        let prov = crate::keys::derived(cx.feature, "corner", &cx.vkey[cp.v]);
        created.push(prov.key());
        // A planar patch's sense follows from its loop: counter-clockwise about the outward
        // normal.
        let sense = match (cp.sense, &cp.surf) {
            (Some(s), _) => s,
            (None, forge_core::geom::Surface::Plane(pl)) => {
                let pts: Vec<forge_core::linalg::Point2> = lp
                    .iter()
                    .map(|u| {
                        let v = st.plan.use_start(u).expect("open");
                        pl.frame().to_local_point(st.plan.vs[v].p).truncate()
                    })
                    .collect();
                let n = pts.len();
                let area: f64 = (0..n).map(|i| pts[i].perp_dot(pts[(i + 1) % n])).sum();
                area > 0.0
            }
            (None, _) => true,
        };
        let fi = st.plan.add_f(PF {
            surf: cp.surf,
            sense,
            prov,
            loops: vec![lp],
            shell: cp.shell,
            hint: None,
        });
        new_faces.push(fi);
    }
    // Pcurves (needed by the crossing check and the build).
    let dev = st.plan.fill_pcurves().map_err(|m| Fail::Failed {
        edges: cx.set.clone(),
        reason: format!("internal: {m}"),
    })?;
    for (e, d) in dev {
        st.plan.es[e].tol = st.plan.es[e].tol.max(2.0 * d);
    }
    // Crossings on every modified or new face.
    let mut check_faces: Vec<usize> = touched.iter().copied().collect();
    check_faces.extend(new_faces.iter().copied());
    for &f in &check_faces {
        // Pairs found to meet are proven violations; pairs the certificate leaves unresolved
        // (its budget or depth, or a pcurve it cannot convert) are undecided — never a size
        // limit (W6 review round 5).
        let (found, open) = crate::check::face_crossings_ex(&st.plan, f);
        let attributed = |st: &St<'_>, a: usize, b: usize| {
            let (edges, limit) = limit_of(st, a, b);
            let edges = if edges.is_empty() {
                // Only unmodified edges cross: attribute to the blends of this face.
                st.egs
                    .values()
                    .filter(|g| g.a == f || g.b == f)
                    .map(|g| g.e)
                    .collect()
            } else {
                edges
            };
            (edges, limit)
        };
        for (a, b) in found {
            let (edges, limit) = attributed(&st, a, b);
            let face = if f < cx.plan0.fs.len() { Some(f) } else { None };
            // A contact crossing an unmodified edge of a loop that bounds a hole in the
            // face's domain (a hole's or a boss's rim) runs into another feature (W6 review
            // round 6): an obstacle, named by the feature's face beyond that rim.
            let rim = [a, b].into_iter().find(|&x| {
                x < cx.plan0.es.len()
                    && st.attr.get(&x).is_none_or(|s| s.is_empty())
                    && face.is_some()
                    && limits::on_hole_loop(cx.plan0, f, x) == Some(true)
            });
            let v = match rim {
                Some(x) => {
                    let beyond = cx.adj.edge_faces(x).into_iter().find(|&o| o != f);
                    Violation {
                        obstacle: true,
                        what: format!(
                            "the blend of {} runs into the rim of {} on face {}: another feature of the body lies in its way",
                            edges
                                .iter()
                                .map(|&e| cx.ename[e].clone())
                                .collect::<Vec<_>>()
                                .join(", "),
                            beyond.map_or_else(|| cx.ename[x].clone(), |o| cx.fname[o].clone()),
                            face_name(cx, &st.plan, f)
                        ),
                        edges,
                        limit,
                        face: beyond.or(face),
                    }
                }
                None => Violation {
                    obstacle: false,
                    edges,
                    limit,
                    face,
                    what: format!("edges cross on face {}", face_name(cx, &st.plan, f)),
                },
            };
            st.viol.push(v);
        }
        for (a, b) in open {
            let (edges, _) = attributed(&st, a, b);
            let what = if a == b {
                format!(
                    "the boundary of face {} could not be checked (a pcurve of it could not be converted)",
                    face_name(cx, &st.plan, f)
                )
            } else {
                format!(
                    "whether two edges of face {} cross could not be certified (the crossing test ran out of its budget or depth)",
                    face_name(cx, &st.plan, f)
                )
            };
            st.unverified.push((edges, what));
        }
    }
    // Nothing of the input in the material the blends remove or fill ([`region`]).
    region::check_obstacles(&mut st, prof);
    if !st.viol.is_empty() {
        return Err(Fail::Infeasible(st.viol));
    }
    if let Some((edges, reason)) = st.unverified.first().cloned() {
        let edges: Vec<usize> = if edges.is_empty() {
            cx.set.clone()
        } else {
            edges.into_iter().collect()
        };
        return Err(Fail::Unverified { edges, reason });
    }
    let all_convex = st.egs.values().all(|g| g.convex);
    let all_concave = st.egs.values().all(|g| !g.convex);
    let sign: i8 = if all_convex {
        -1
    } else if all_concave {
        1
    } else {
        0
    };
    Ok((st.plan, created, sign))
}

fn face_name(cx: &Cx<'_>, plan: &Plan, f: usize) -> String {
    if f < cx.fname.len() {
        cx.fname[f].clone()
    } else {
        plan.fs[f]
            .as_ref()
            .map(|x| x.prov.name())
            .unwrap_or_default()
    }
}

/// The parameter of `x` on `curve` nearest `near` (whole periods for closed curves).
fn param_near(curve: &Curve3, x: Point3, near: f64) -> f64 {
    let (t, _) = curve.project(x);
    match curve.period() {
        Some(p) => t + ((near - t) / p).round() * p,
        None => t,
    }
}

fn ring_same_direction(a: &Curve3, b: &Curve3) -> bool {
    let z = |c: &Curve3| match c {
        Curve3::Circle(k) => Some(k.frame().z()),
        Curve3::Ellipse(k) => Some(k.frame().z()),
        _ => None,
    };
    match (z(a), z(b)) {
        (Some(x), Some(y)) => x.dot(y) > 0.0,
        _ => true,
    }
}

fn check_closed(plan: &Plan, lp: &[PU]) -> Result<(), String> {
    if lp.len() == 1 && plan.es[lp[0].edge].is_ring() {
        return Ok(());
    }
    for i in 0..lp.len() {
        let a = plan.use_end(&lp[i]);
        let b = plan.use_start(&lp[(i + 1) % lp.len()]);
        if a.is_none() || a != b {
            return Err(format!("use {i}"));
        }
    }
    Ok(())
}

/// The operation's input, resolved.
#[derive(Clone)]
struct Prepared {
    plan: Plan,
    adj: Adj,
    keys: KeyMap,
    /// Plan edges: the given ones (in the given order, deduplicated), then the chain.
    given: Vec<usize>,
    chain: Vec<usize>,
    inv_e: BTreeMap<usize, EdgeId>,
    inv_f: BTreeMap<usize, FaceId>,
    inv_v: BTreeMap<usize, forge_core::topo::VertexId>,
    /// Chamfer side face per edge (see [`chain_sides`]).
    sides: BTreeMap<usize, usize>,
}

fn prepare(
    body: &Body,
    edges: &[Pick<EdgeId>],
    opts: &BlendOptions,
    op: BlendOp,
) -> Result<Prepared, BlendError> {
    if edges.is_empty() {
        return Err(BlendError::Failed {
            op,
            edges: vec![],
            reason: format!("no edges to {}: the edge set is empty", op.noun()),
        });
    }
    let keys = KeyMap::complete(body, opts.keys.as_ref());
    let plan = Plan::from_body(body).map_err(|m| BlendError::Failed {
        op,
        edges: vec![],
        reason: format!("the input body cannot be read: {m}"),
    })?;
    // Membership: a pick of another body, or an id this body does not have, is never read
    // as the entity of this body with the same arena index.
    let mut foreign: Vec<Named> = Vec::new();
    let mut why: Option<String> = None;
    for p in edges {
        let reason = if p.body != opts.body {
            Some(format!(
                "edge {} belongs to body #{}, not to body #{} being {}ed",
                p.key,
                p.body,
                opts.body,
                op.noun()
            ))
        } else if !plan.emap.contains_key(&p.id) {
            Some(format!("edge {} is not an edge of the body", p.key))
        } else {
            None
        };
        if let Some(r) = reason {
            let n = Named {
                key: p.key.clone(),
                name: p.key.clone(),
            };
            if !foreign.contains(&n) {
                foreign.push(n);
            }
            why.get_or_insert(r);
        }
    }
    if !foreign.is_empty() {
        return Err(BlendError::Failed {
            op,
            edges: foreign,
            reason: why.unwrap_or_default(),
        });
    }
    let adj = Adj::new(&plan);
    let mut given = Vec::new();
    let mut bad: Vec<UnsupportedEdge> = Vec::new();
    for p in edges {
        let i = plan.emap[&p.id];
        if !given.contains(&i) {
            given.push(i);
        }
    }
    let inv_e: BTreeMap<usize, EdgeId> = plan.emap.iter().map(|(k, v)| (*v, *k)).collect();
    let inv_f: BTreeMap<usize, FaceId> = plan.fmap.iter().map(|(k, v)| (*v, *k)).collect();
    let inv_v = plan.vmap.iter().map(|(k, v)| (*v, *k)).collect();
    let named = |i: usize| edge_named(&keys, &plan, &inv_e, i);
    let check = |i: usize, bad: &mut Vec<UnsupportedEdge>| {
        let n = named(i);
        let faces = adj.edge_faces(i);
        let reason = if adj.uses[i].len() != 2 || faces.len() != 2 {
            Some(UnsupportedReason::Boundary)
        } else if !faces
            .iter()
            .all(|&f| supported_surface(&plan.fs[f].as_ref().expect("face").surf))
        {
            Some(UnsupportedReason::SurfaceType)
        } else {
            match edge_convexity(&plan, &adj, i) {
                Some(Convexity::Smooth) | None => Some(UnsupportedReason::Smooth),
                _ => None,
            }
        };
        if let Some(reason) = reason {
            bad.push(UnsupportedEdge {
                key: n.key,
                name: n.name,
                reason,
            });
        }
    };
    for &i in &given {
        check(i, &mut bad);
    }
    if !bad.is_empty() {
        return Err(BlendError::EdgeUnsupported { op, edges: bad });
    }
    let chain = if opts.tangent_chain {
        tangent_chain(&plan, &adj, &given)
    } else {
        Vec::new()
    };
    for &i in &chain {
        check(i, &mut bad);
    }
    if !bad.is_empty() {
        return Err(BlendError::EdgeUnsupported { op, edges: bad });
    }
    Ok(Prepared {
        plan,
        adj,
        keys,
        given,
        chain,
        inv_e,
        inv_f,
        inv_v,
        sides: BTreeMap::new(),
    })
}

/// The chamfer side of every edge of the set: the `side` face for the given edges (which
/// it must bound), and along the tangent chain the face **on the same side**: at a vertex
/// where a chain edge continues an edge whose side is known, the chain edge's side is the
/// face they share if that was the side, and its other face otherwise (OCCT's propagation
/// of `Add(d1, d2, E, F)` along a tangent chain). `Err` lists the edges without a side.
fn chain_sides(p: &Prepared, side: usize) -> Result<BTreeMap<usize, usize>, Vec<usize>> {
    let mut out: BTreeMap<usize, usize> = BTreeMap::new();
    let mut bad = Vec::new();
    for &e in &p.given {
        if p.adj.edge_faces(e).contains(&side) {
            out.insert(e, side);
        } else {
            bad.push(e);
        }
    }
    if !bad.is_empty() {
        return Err(bad);
    }
    let mut pending: Vec<usize> = p.chain.clone();
    loop {
        let before = pending.len();
        pending.retain(|&c| {
            let fc = p.adj.edge_faces(c);
            let pc = &p.plan.es[c];
            for v in [pc.start, pc.end].into_iter().flatten() {
                for x in p.adj.vertex_edges(v) {
                    let Some(&sx) = out.get(&x) else { continue };
                    let fx = p.adj.edge_faces(x);
                    let shared: Vec<usize> =
                        fc.iter().copied().filter(|f| fx.contains(f)).collect();
                    let s = if fc.contains(&sx) {
                        sx
                    } else if let [sh] = shared.as_slice() {
                        match fc.iter().copied().find(|f| f != sh) {
                            Some(o) if sx != *sh => o,
                            _ => *sh,
                        }
                    } else {
                        continue;
                    };
                    out.insert(c, s);
                    return false;
                }
            }
            true
        });
        if pending.is_empty() || pending.len() == before {
            break;
        }
    }
    if pending.is_empty() {
        Ok(out)
    } else {
        Err(pending)
    }
}

fn context<'a>(p: &'a Prepared, feature: &'a str, op: BlendOp) -> Cx<'a> {
    let nf = p.plan.fs.len();
    let fkey: Vec<Named> = (0..nf)
        .map(|i| face_named(&p.keys, &p.plan, &p.inv_f, i))
        .collect();
    let ekey: Vec<Named> = (0..p.plan.es.len())
        .map(|i| edge_named(&p.keys, &p.plan, &p.inv_e, i))
        .collect();
    let vkey: Vec<Named> = (0..p.plan.vs.len())
        .map(|i| vertex_named(&p.keys, &p.plan, &p.inv_v, i))
        .collect();
    let mut set: Vec<usize> = p.given.iter().chain(&p.chain).copied().collect();
    set.sort_unstable();
    set.dedup();
    let mut scale: f64 = 1.0;
    for v in &p.plan.vs {
        scale = scale.max(v.p.norm());
    }
    Cx {
        plan0: &p.plan,
        adj: &p.adj,
        feature,
        label: match op {
            BlendOp::Fillet => "blend",
            BlendOp::Chamfer => "bevel",
        },
        fname: fkey.iter().map(|n| n.name.clone()).collect(),
        fkey: fkey.into_iter().map(|n| n.key).collect(),
        ename: ekey.iter().map(|n| n.name.clone()).collect(),
        ekey: ekey.into_iter().map(|n| n.key).collect(),
        vname: vkey.iter().map(|n| n.name.clone()).collect(),
        vkey: vkey.into_iter().map(|n| n.key).collect(),
        set,
        sides: p.sides.clone(),
        scale,
    }
}

/// Build and validate one attempt.
fn run(cx: &Cx<'_>, prof: Prof, v0: f64) -> Result<(Body, Vec<String>), Fail> {
    let (plan, created, sign) = attempt(cx, prof)?;
    let body = plan.build().map_err(Fail::Invalid)?;
    // A face of the input whose domain the blends turned inside out (their contacts on it
    // passed each other: two rims of a hole in a thin plate) is used up: the face-width
    // limit, proven by the validator's area — not an unexplained invalid body.
    if let Some(i) = forge_check::validate(&body)
        .into_iter()
        .find(|i| i.severity == forge_core::topo::Severity::Error)
    {
        if i.code == "FORGE_FACE_AREA_NOT_POSITIVE"
            && let Some(name) = &i.entity
            && let Some(f) = (0..cx.plan0.fs.len()).find(|&f| {
                cx.plan0.fs[f]
                    .as_ref()
                    .is_some_and(|x| x.prov.name() == *name)
            })
        {
            let edges: BTreeSet<usize> = cx
                .set
                .iter()
                .copied()
                .filter(|&e| cx.adj.edge_faces(e).contains(&f))
                .collect();
            if !edges.is_empty() {
                return Err(Fail::Infeasible(vec![Violation {
                    obstacle: false,
                    edges,
                    limit: Limit::FaceWidth,
                    face: Some(f),
                    what: format!(
                        "face {} is used up: the contacts of its blends pass each other ({i})",
                        cx.fname[f]
                    ),
                }]));
            }
        }
        return Err(Fail::Invalid(i.to_string()));
    }
    let vol = forge_check::mass_properties(&body)
        .map(|m| m.volume)
        .map_err(|e| Fail::Invalid(e.to_string()))?;
    if !(vol.is_finite() && vol > 0.0) {
        return Err(Fail::Invalid(format!("non-positive volume {vol}")));
    }
    // Removing material must lose volume, adding must gain it.
    if sign < 0 && vol >= v0 {
        return Err(Fail::Invalid(format!(
            "a convex blend did not remove material ({vol} ≥ {v0})"
        )));
    }
    if sign > 0 && vol <= v0 {
        return Err(Fail::Invalid(format!(
            "a concave blend did not add material ({vol} ≤ {v0})"
        )));
    }
    Ok((body, created))
}

/// The profile `prof` with its searched value set to `x`: the radius of a fillet, the
/// distance `d` of a chamfer — whose second distance `d2` (two-distance form) scales with it,
/// so that a value that is too large because of either distance has a feasible range (the
/// SPEC's `CHAMFER_DISTANCE_TOO_LARGE` has no key for `d2`: see the contract issue in the
/// crate's report). The distance–angle form's other distance follows `d` by construction.
pub(crate) fn scaled(prof: Prof, x: f64) -> Prof {
    match prof {
        Prof::Fillet(_) => Prof::Fillet(x),
        Prof::Chamfer { d, d2, angle } => Prof::Chamfer {
            d: x,
            // `x / d` is exactly 1 at the requested value: `d2` is then unchanged.
            d2: d2.map(|v| v * (x / d)),
            angle,
        },
    }
}

/// The profile suggested for the value `x` (a multiple of 0.001 mm): as [`scaled`], with a
/// two-distance chamfer's `d2` rounded down to 0.001 mm too (`None` when it rounds to 0).
fn suggest(prof: Prof, x: f64) -> Option<Prof> {
    match scaled(prof, x) {
        Prof::Chamfer {
            d,
            d2: Some(v),
            angle,
        } => {
            let v = round_down_mm(v);
            (v > 0.0).then_some(Prof::Chamfer {
                d,
                d2: Some(v),
                angle,
            })
        }
        p => Some(p),
    }
}

pub(crate) fn value_of(prof: Prof) -> f64 {
    match prof {
        Prof::Fillet(r) => r,
        Prof::Chamfer { d, .. } => d,
    }
}

/// The smallest value the searches try (mm): below it nothing is reported as feasible.
const SEARCH_FLOOR: f64 = 20.0 * LINEAR_TOLERANCE;

/// Where the feasible-range searches start descending when the requested value is far
/// larger, and the value analytic limits are computed at (see [`search`]): a thousand times
/// the body's size (`scale`: the largest distance of a vertex from the origin). A feasible
/// value above it would need contacts a thousandth of the value from the edge — faces
/// within 0.1° of tangent — and is then reported as not found, never wrongly.
fn search_top(scale: f64) -> f64 {
    1e3 * scale.max(1.0)
}
/// The largest number of constructions [`finish`] runs for the global feasible range after
/// the requested value (deterministic; W6 review round 4).
const FINISH_RUNS: usize = 48;
/// The largest number of pre-build checks [`finish`] runs for the failing edges' own limits,
/// all edges together.
const EDGE_CHECKS: usize = 96;
/// [`SEARCH_FLOOR`] for messages.
const SEARCH_FLOOR_TEXT: &str = "0.00002";

/// One construction's verdict for the feasible-range search (W6 review round 5).
enum Verdict {
    Built,
    /// Proven infeasible: a violation of the checks at this value.
    Proven,
    /// Not decided: a check that could not be certified, a structural failure, an invalid
    /// body.
    Unknown(String),
}

/// The verdict of `eng` at `prof`.
fn verdict(eng: &dyn Engine, prof: Prof) -> Verdict {
    match eng.run_prof(prof) {
        Ok(_) => Verdict::Built,
        Err(EFail::Infeasible(_)) => Verdict::Proven,
        Err(EFail::Failed { reason, .. } | EFail::Unverified { reason, .. }) => {
            Verdict::Unknown(reason)
        }
        Err(EFail::Invalid(m)) => Verdict::Unknown(format!("the result is invalid: {m}")),
    }
}

/// Why [`search`] found no bracket.
enum SearchStop {
    /// Even the absolute floor is proven infeasible.
    Floor,
    /// The budget of constructions ran out (the verdict function returned `None`).
    Spent,
    /// A value whose check could not be decided, and what.
    Undecided(f64, String),
}

/// A feasible bracket `(lo, hi)` below `value` (`lo` built, `hi` proven infeasible,
/// `hi − lo ≤ 1e-4` mm unless the bisection met an undecided value or the budget):
/// descending by factors of 4 from `value` to the first feasible value — down to the absolute
/// floor [`SEARCH_FLOOR`], whatever `value` is — then bisecting (the construction is assumed
/// monotone; every value finally suggested is re-run and confirmed). An undecided verdict
/// never brackets the range (W6 review round 5): in the descent it stops the search
/// ([`SearchStop::Undecided`]); in the bisection the largest built value **below** it is
/// still sought (the undecided value caps that search, `hi` stays the proven bound), and the
/// suggestion is confirmed above it by a proven violation or not made.
fn search(
    value: f64,
    top: f64,
    mut at: impl FnMut(f64) -> Option<Verdict>,
) -> Result<(f64, f64), SearchStop> {
    let (mut lo, mut hi) = (value, value);
    let mut built = false;
    // A value far above the body's size (W6 review round 6: r = 1e300 spent the whole budget
    // descending): the descent starts at `top`.
    if top < 0.25 * value {
        match at(top) {
            Some(Verdict::Built) => built = true,
            Some(Verdict::Proven) => hi = top,
            Some(Verdict::Unknown(m)) => return Err(SearchStop::Undecided(top, m)),
            None => return Err(SearchStop::Spent),
        }
        lo = top;
    }
    while !built {
        if lo <= SEARCH_FLOOR {
            return Err(SearchStop::Floor);
        }
        lo = (lo * 0.25).max(SEARCH_FLOOR);
        match at(lo) {
            Some(Verdict::Built) => built = true,
            Some(Verdict::Proven) => hi = lo,
            Some(Verdict::Unknown(m)) => return Err(SearchStop::Undecided(lo, m)),
            None => return Err(SearchStop::Spent),
        }
    }
    // `cap`: the smallest value above `lo` known not to build (proven or undecided).
    let mut cap = hi;
    for _ in 0..64 {
        if cap - lo <= 1e-4 {
            break;
        }
        let mid = 0.5 * (lo + cap);
        match at(mid) {
            Some(Verdict::Built) => lo = mid,
            Some(Verdict::Proven) => {
                hi = mid;
                cap = mid;
            }
            Some(Verdict::Unknown(_)) => cap = mid,
            None => break,
        }
    }
    Ok((lo, hi))
}

/// Multiples of 0.001 mm at or below `x`, descending (at most `n`, all positive).
fn mm_steps_below(x: f64, n: usize) -> Vec<f64> {
    let top = round_down_mm(x);
    let k0 = (top * 1000.0).round() as i64;
    (0..n as i64)
        .map(|i| k0 - i)
        .take_while(|&k| k > 0)
        .map(|k| k as f64 / 1000.0)
        .filter(|&v| v <= x)
        .collect()
}

/// Key and name of plan edge `i` (the key map covers every entity of the body; the
/// provenance is only a fallback, never a placeholder).
fn edge_named(keys: &KeyMap, plan: &Plan, inv: &BTreeMap<usize, EdgeId>, i: usize) -> Named {
    inv.get(&i)
        .and_then(|id| keys.edge(*id))
        .unwrap_or_else(|| Named {
            key: plan.es[i].prov.key(),
            name: plan.es[i].prov.name(),
        })
}

/// Key and name of plan face `i` (see [`edge_named`]).
fn face_named(keys: &KeyMap, plan: &Plan, inv: &BTreeMap<usize, FaceId>, i: usize) -> Named {
    inv.get(&i)
        .and_then(|id| keys.face(*id))
        .unwrap_or_else(|| {
            plan.fs[i]
                .as_ref()
                .map(|f| Named {
                    key: f.prov.key(),
                    name: f.prov.name(),
                })
                .unwrap_or_else(|| Named {
                    key: String::new(),
                    name: String::new(),
                })
        })
}

/// Key and name of plan vertex `i` (see [`edge_named`]).
fn vertex_named(
    keys: &KeyMap,
    plan: &Plan,
    inv: &BTreeMap<usize, forge_core::topo::VertexId>,
    i: usize,
) -> Named {
    inv.get(&i)
        .and_then(|id| keys.vertex(*id))
        .unwrap_or_else(|| Named {
            key: plan.vs[i].prov.key(),
            name: plan.vs[i].prov.name(),
        })
}

fn names(cx: &Cx<'_>, es: &[usize]) -> Vec<Named> {
    es.iter()
        .map(|&e| Named {
            key: cx.ekey[e].clone(),
            name: cx.ename[e].clone(),
        })
        .collect()
}

/// A violation with entities named by key (valid across the passes of a two-pass blend).
#[derive(Clone, Debug)]
struct NViol {
    edges: Vec<Named>,
    limit: Limit,
    face: Option<String>,
    /// Display name of `face`.
    face_name: Option<String>,
    what: String,
    /// See [`Violation::obstacle`].
    obstacle: bool,
}

/// A failed run, entities named by key.
#[derive(Clone, Debug)]
enum EFail {
    Failed { edges: Vec<Named>, reason: String },
    Infeasible(Vec<NViol>),
    Unverified { edges: Vec<Named>, reason: String },
    Invalid(String),
}

fn named_fail(cx: &Cx<'_>, f: Fail) -> EFail {
    match f {
        Fail::Failed { edges, reason } => EFail::Failed {
            edges: names(cx, &edges),
            reason,
        },
        Fail::Infeasible(v) => EFail::Infeasible(
            v.into_iter()
                .map(|x| NViol {
                    edges: names(cx, &x.edges.into_iter().collect::<Vec<_>>()),
                    limit: x.limit,
                    face: x.face.map(|f| cx.fkey[f].clone()),
                    face_name: x.face.map(|f| cx.fname[f].clone()),
                    what: x.what,
                    obstacle: x.obstacle,
                })
                .collect(),
        ),
        Fail::Unverified { edges, reason } => EFail::Unverified {
            edges: names(cx, &edges),
            reason,
        },
        Fail::Invalid(m) => EFail::Invalid(m),
    }
}

/// Builds the blend at a profile (one pass, or the two passes of a mixed corner).
trait Engine {
    /// The requested profile.
    fn prof(&self) -> Prof;
    /// Build and validate at `prof`.
    fn run_prof(&self, prof: Prof) -> Result<(Body, Vec<String>), EFail>;
    /// The **proven** pre-build violations at `prof` (empty when its checks pass); `None`
    /// when a check could not be decided or the construction fails otherwise (W6 review
    /// round 5: never read as "no violation").
    fn violations_prof(&self, prof: Prof) -> Option<Vec<NViol>>;
    /// Every blended edge (for unattributed failures).
    fn all_edges(&self) -> Vec<Named>;
    /// Analytic limits of the edges ([`limits`]), named.
    fn analytic(&self) -> Vec<NLimit>;
    /// The body's size (the largest distance of a vertex from the origin, at least 1 mm).
    fn scale(&self) -> f64;
}

/// An analytic limit with its entities named by key.
#[derive(Clone, Debug)]
struct NLimit {
    edge: Named,
    x: f64,
    limit: Limit,
    face: String,
    /// Display name of `face` (for the message).
    face_name: String,
    /// See [`limits::AnaLimit::obstacle`].
    obstacle: bool,
    /// See [`limits::AnaLimit::width`].
    width: Option<f64>,
}

struct OnePass<'a> {
    cx: Cx<'a>,
    prof: Prof,
    v0: f64,
}

impl Engine for OnePass<'_> {
    fn prof(&self) -> Prof {
        self.prof
    }
    fn run_prof(&self, prof: Prof) -> Result<(Body, Vec<String>), EFail> {
        run(&self.cx, prof, self.v0).map_err(|f| named_fail(&self.cx, f))
    }
    fn violations_prof(&self, prof: Prof) -> Option<Vec<NViol>> {
        match attempt(&self.cx, prof) {
            Ok(_) => Some(Vec::new()),
            Err(f @ Fail::Infeasible(_)) => match named_fail(&self.cx, f) {
                EFail::Infeasible(v) => Some(v),
                _ => None,
            },
            Err(_) => None,
        }
    }
    fn all_edges(&self) -> Vec<Named> {
        names(&self.cx, &self.cx.set)
    }
    fn analytic(&self) -> Vec<NLimit> {
        // The setbacks are linear in the value: computed at a value of the body's size when
        // the requested one is far larger (W6 review round 6: at r = 1e300 the cross-section
        // overflowed and the analytic candidate was lost).
        let top = search_top(self.cx.scale);
        let prof = if value_of(self.prof) > top {
            scaled(self.prof, top)
        } else {
            self.prof
        };
        limits::analytic_limits(&self.cx, prof, value_of(prof))
            .into_iter()
            .map(|a| NLimit {
                edge: Named {
                    key: self.cx.ekey[a.e].clone(),
                    name: self.cx.ename[a.e].clone(),
                },
                x: a.x,
                limit: a.limit,
                face: self.cx.fkey[a.face].clone(),
                face_name: self.cx.fname[a.face].clone(),
                obstacle: a.obstacle,
                width: a.width,
            })
            .collect()
    }
    fn scale(&self) -> f64 {
        self.cx.scale
    }
}

/// A mixed-convexity corner (two convex and one concave blended edge at a vertex, or the
/// reverse) is built in two passes that give the rolling-ball result: first every blended
/// edge of the corners' minority convexity (the concave edge closes with a cylinder whose
/// top arc continues the others' tangent chain), then the rest together with the arcs the
/// first pass created (a torus rounds each corner). This is exactly what OCCT's
/// simultaneous fillet builds at such corners (checked on L-blocks and ribs).
struct TwoPass<'a> {
    body: &'a Body,
    p: &'a Prepared,
    opts: &'a BlendOptions,
    op: BlendOp,
    prof: Prof,
    first: Vec<usize>,
    second: Vec<usize>,
    v0: f64,
}

impl TwoPass<'_> {
    fn sub(&self, edges: &[usize]) -> Prepared {
        Prepared {
            plan: self.p.plan.clone(),
            adj: self.p.adj.clone(),
            keys: self.p.keys.clone(),
            given: edges.to_vec(),
            chain: Vec::new(),
            inv_e: self.p.inv_e.clone(),
            inv_f: self.p.inv_f.clone(),
            inv_v: self.p.inv_v.clone(),
            sides: BTreeMap::new(),
        }
    }

    /// The second pass prepared on the first pass's result.
    fn second_on(&self, b1: &Body) -> Result<Prepared, EFail> {
        let named = |e: usize| edge_named(&self.p.keys, &self.p.plan, &self.p.inv_e, e);
        let fail = |reason: String| EFail::Failed {
            edges: self.second.iter().map(|&e| named(e)).collect(),
            reason,
        };
        let plan1 = Plan::from_body(b1).map_err(|m| fail(format!("internal: {m}")))?;
        let adj1 = Adj::new(&plan1);
        // Keys of the intermediate body: derived, with the input's keys for everything that
        // kept its provenance (and, for vertices, its position).
        let mut keys = KeyMap::derive(b1);
        let inv1_e: BTreeMap<usize, EdgeId> = plan1.emap.iter().map(|(k, v)| (*v, *k)).collect();
        let inv1_f: BTreeMap<usize, FaceId> = plan1.fmap.iter().map(|(k, v)| (*v, *k)).collect();
        let inv1_v: BTreeMap<usize, forge_core::topo::VertexId> =
            plan1.vmap.iter().map(|(k, v)| (*v, *k)).collect();
        let p0 = &self.p.plan;
        for (fi, f) in plan1.fs.iter().enumerate() {
            let Some(f) = f else { continue };
            let same: Vec<usize> = (0..p0.fs.len())
                .filter(|&g| p0.fs[g].as_ref().is_some_and(|x| x.prov == f.prov))
                .collect();
            if let [g] = same.as_slice() {
                let n = face_named(&self.p.keys, p0, &self.p.inv_f, *g);
                keys.set_face(inv1_f[&fi], n.key, n.name);
            }
        }
        for (vi, v) in plan1.vs.iter().enumerate() {
            if let Some(g) = (0..p0.vs.len())
                .find(|&g| p0.vs[g].prov == v.prov && p0.vs[g].p.distance(v.p) <= LINEAR_TOLERANCE)
            {
                let n = vertex_named(&self.p.keys, p0, &self.p.inv_v, g);
                keys.set_vertex(inv1_v[&vi], n.key, n.name);
            }
        }
        // The second pass's edges in the intermediate body: same provenance, lying on the
        // input edge.
        let mut given = Vec::with_capacity(self.second.len());
        for &e in &self.second {
            let pe = &p0.es[e];
            let hit = (0..plan1.es.len()).find(|&i| {
                let x = &plan1.es[i];
                if x.prov != pe.prov || adj1.uses[i].len() != 2 {
                    return false;
                }
                let m = x.curve.eval(0.5 * (x.range.0 + x.range.1));
                let (t, d) = pe.curve.project(m);
                let t = match pe.curve.period() {
                    Some(per) => pe.range.0 + math::rem_euclid(t - pe.range.0, per),
                    None => t,
                };
                let slack = crate::geom::param_tol(&pe.curve);
                d <= LINEAR_TOLERANCE && t >= pe.range.0 - slack && t <= pe.range.1 + slack
            });
            let Some(i) = hit else {
                return Err(fail(format!(
                    "internal: edge {} not found after the first pass",
                    named(e).name
                )));
            };
            let n = named(e);
            keys.set_edge(inv1_e[&i], n.key, n.name);
            given.push(i);
        }
        // The arcs the first pass created that continue the second pass's edges (always),
        // and the rest of the tangent chain (when asked for).
        let chain_all = tangent_chain(&plan1, &adj1, &given);
        let chain: Vec<usize> = chain_all
            .into_iter()
            .filter(|&i| self.opts.tangent_chain || plan1.es[i].prov.feature == self.opts.feature)
            .collect();
        Ok(Prepared {
            plan: plan1,
            adj: adj1,
            keys,
            given,
            chain,
            inv_e: inv1_e,
            inv_f: inv1_f,
            inv_v: inv1_v,
            sides: BTreeMap::new(),
        })
    }
}

impl Engine for TwoPass<'_> {
    fn prof(&self) -> Prof {
        self.prof
    }
    fn run_prof(&self, prof: Prof) -> Result<(Body, Vec<String>), EFail> {
        let p1 = self.sub(&self.first);
        let cx1 = context(&p1, &self.opts.feature, self.op);
        let (b1, c1) = run(&cx1, prof, self.v0).map_err(|f| named_fail(&cx1, f))?;
        let v1 = forge_check::mass_properties(&b1)
            .map(|m| m.volume)
            .map_err(|e| EFail::Invalid(e.to_string()))?;
        let p2 = self.second_on(&b1)?;
        let cx2 = context(&p2, &self.opts.feature, self.op);
        let (b2, c2) = run(&cx2, prof, v1).map_err(|f| named_fail(&cx2, f))?;
        let _ = self.body;
        Ok((b2, c1.into_iter().chain(c2).collect()))
    }
    fn violations_prof(&self, prof: Prof) -> Option<Vec<NViol>> {
        let p1 = self.sub(&self.first);
        let cx1 = context(&p1, &self.opts.feature, self.op);
        match run(&cx1, prof, self.v0) {
            Err(f @ Fail::Infeasible(_)) => match named_fail(&cx1, f) {
                EFail::Infeasible(v) => Some(v),
                _ => None,
            },
            Err(_) => None,
            Ok((b1, _)) => {
                let p2 = self.second_on(&b1).ok()?;
                let cx2 = context(&p2, &self.opts.feature, self.op);
                match attempt(&cx2, prof) {
                    Ok(_) => Some(Vec::new()),
                    Err(f @ Fail::Infeasible(_)) => match named_fail(&cx2, f) {
                        EFail::Infeasible(v) => Some(v),
                        _ => None,
                    },
                    Err(_) => None,
                }
            }
        }
    }
    fn all_edges(&self) -> Vec<Named> {
        self.first
            .iter()
            .chain(&self.second)
            .map(|&e| edge_named(&self.p.keys, &self.p.plan, &self.p.inv_e, e))
            .collect()
    }
    fn analytic(&self) -> Vec<NLimit> {
        Vec::new()
    }
    fn scale(&self) -> f64 {
        let mut scale: f64 = 1.0;
        for v in &self.p.plan.vs {
            scale = scale.max(v.p.norm());
        }
        scale
    }
}

fn blend(
    body: &Body,
    edges: &[Pick<EdgeId>],
    prof: Prof,
    opts: &BlendOptions,
    op: BlendOp,
) -> Result<BlendOutput, BlendError> {
    let p = prepare(body, edges, opts, op)?;
    blend_prepared(body, &p, prof, opts, op)
}

/// The two passes of a set with mixed-convexity corners (see [`TwoPass`]); `None` when no
/// vertex has three blended edges of mixed convexity. `Err` when the corners disagree on
/// which convexity goes first.
/// The edges of the first and of the second pass.
type Passes = (Vec<usize>, Vec<usize>);

fn two_pass_split(p: &Prepared) -> Result<Option<Passes>, String> {
    let set: BTreeSet<usize> = p.given.iter().chain(&p.chain).copied().collect();
    let conv = |e: usize| edge_convexity(&p.plan, &p.adj, e);
    let mut first_class: Option<Convexity> = None;
    for v in 0..p.plan.vs.len() {
        let inc = p.adj.vertex_edges(v);
        let bl: Vec<usize> = inc.iter().copied().filter(|e| set.contains(e)).collect();
        if bl.len() != 3 || inc.len() != 3 {
            continue;
        }
        let cs: Vec<Option<Convexity>> = bl.iter().map(|&e| conv(e)).collect();
        let convex = cs.iter().filter(|c| **c == Some(Convexity::Convex)).count();
        let minority = match convex {
            1 => Convexity::Convex,
            2 => Convexity::Concave,
            _ => continue,
        };
        match first_class {
            None => first_class = Some(minority),
            Some(c) if c != minority => {
                return Err("corners of both kinds (two convex and one concave edge, and two concave and one convex) in one set".into());
            }
            _ => {}
        }
    }
    let Some(fc) = first_class else {
        return Ok(None);
    };
    let (first, second): (Vec<usize>, Vec<usize>) = set.iter().partition(|&&e| conv(e) == Some(fc));
    Ok(Some((first, second)))
}

fn blend_prepared(
    body: &Body,
    p: &Prepared,
    prof: Prof,
    opts: &BlendOptions,
    op: BlendOp,
) -> Result<BlendOutput, BlendError> {
    let cx = context(p, &opts.feature, op);
    let v0 = forge_check::mass_properties(body)
        .map(|m| m.volume)
        .map_err(|e| BlendError::Failed {
            op,
            edges: names(&cx, &cx.set),
            reason: format!("the input body cannot be measured: {e}"),
        })?;
    let rep_edges: Vec<String> = p
        .given
        .iter()
        .chain(&p.chain)
        .map(|&e| cx.ekey[e].clone())
        .collect();
    let rep_chain: Vec<String> = p.chain.iter().map(|&e| cx.ekey[e].clone()).collect();
    let report = move |created: Vec<String>| BlendReport {
        edges: rep_edges,
        chain_added: rep_chain,
        faces_created: created,
    };
    let chain_added: Vec<EdgeId> = p.chain.iter().map(|e| p.inv_e[e]).collect();
    let split = if matches!(prof, Prof::Fillet(_)) {
        two_pass_split(p).map_err(|reason| BlendError::Failed {
            op,
            edges: names(&cx, &cx.set),
            reason,
        })?
    } else {
        None
    };
    let result = match split {
        None => {
            let eng = OnePass { cx, prof, v0 };
            finish(&eng, op)
        }
        Some((first, second)) => {
            let eng = TwoPass {
                body,
                p,
                opts,
                op,
                prof,
                first,
                second,
                v0,
            };
            finish(&eng, op)
        }
    };
    result.map(|(body, created)| BlendOutput {
        body,
        report: report(created),
        chain_added,
    })
}

/// Unique entries, first occurrence first.
fn dedup_named(v: impl IntoIterator<Item = Named>) -> Vec<Named> {
    let mut out: Vec<Named> = Vec::new();
    for n in v {
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

fn efail_error(f: &EFail, op: BlendOp, all: Vec<Named>, note: Option<&str>) -> BlendError {
    let with = |r: String| match note {
        Some(n) => format!("{r}; {n}"),
        None => r,
    };
    match f {
        EFail::Failed { edges, reason } => BlendError::Failed {
            op,
            edges: dedup_named(edges.iter().cloned()),
            reason: with(reason.clone()),
        },
        EFail::Unverified { edges, reason } => BlendError::Failed {
            op,
            edges: dedup_named(edges.iter().cloned()),
            reason: with(format!(
                "{reason}; not a size limit: a check could not be decided"
            )),
        },
        EFail::Infeasible(v) => BlendError::Failed {
            op,
            edges: dedup_named(v.iter().flat_map(|x| x.edges.iter().cloned())),
            reason: with(v.first().map(|x| x.what.clone()).unwrap_or_default()),
        },
        EFail::Invalid(m) => BlendError::Failed {
            op,
            edges: dedup_named(all),
            reason: with(format!("the result is invalid: {m}")),
        },
    }
}

/// The largest multiple of 0.001 mm at or below `x` whose suggested profile builds
/// (trying at most 8 steps down); `None` when none of them does — a value is never
/// suggested without having been built.
fn verified_below(eng: &dyn Engine, x: f64) -> Option<f64> {
    let base = eng.prof();
    mm_steps_below(x, 8)
        .into_iter()
        .find(|&b| suggest(base, b).is_some_and(|p| eng.run_prof(p).is_ok()))
}

/// Run at the requested value; on an infeasible value, the feasible range (see the module
/// docs):
/// 1. the smallest **analytic** limit ([`limits`]) when the construction confirms it: the
///    largest multiple of 0.001 mm below it builds and the next one does not;
/// 2. otherwise a search from the requested value down to an absolute floor, then
///    bisection;
/// 3. the suggested value (rounded down to 0.001 mm) is always one that was built.
///
/// Per failing edge: the edges still violated just above the global limit get
/// `max_feasible_*` itself (so it is the minimum over the edges); the others their own
/// limit (analytic when confirmed, else bisection on the violations attributed to them).
fn finish(eng: &dyn Engine, op: BlendOp) -> Result<(Body, Vec<String>), BlendError> {
    let base = eng.prof();
    let value = value_of(base);
    let first = match eng.run_prof(base) {
        Ok(r) => return Ok(r),
        Err(f) => f,
    };
    // A value astronomically above the body's size (r = f64::MAX) can fail structurally —
    // its cross-section overflows — before any check runs: it is then judged at
    // [`search_top`], a thousand times the body's size, where a proven violation stands for
    // it (the searches assume the construction monotone above the maximum, and the
    // suggestion is confirmed either way; W6 review round 6).
    let first = match first {
        EFail::Failed { .. } | EFail::Unverified { .. } | EFail::Invalid(_)
            if value > search_top(eng.scale()) =>
        {
            match eng.run_prof(scaled(base, search_top(eng.scale()))) {
                Err(f @ EFail::Infeasible(_)) => f,
                _ => first,
            }
        }
        f => f,
    };
    // Only a **proven** violation at the requested value is a SPEC size limit (W6 review
    // round 4): a structural failure, or a built body that fails validation, is `*_FAILED`
    // (no search, no invented limit).
    if let EFail::Failed { .. } | EFail::Unverified { .. } | EFail::Invalid(_) = first {
        return Err(efail_error(&first, op, eng.all_edges(), None));
    }
    // A deterministic budget of constructions for the search (W6 review round 4). Every
    // verdict is three-way (W6 review round 5): only a **proven** violation brackets the
    // range from above; an undecided check stops the search, never counts as a limit.
    let runs = std::cell::Cell::new(0usize);
    let spent = || runs.get() >= FINISH_RUNS;
    let at = |x: f64| -> Option<Verdict> {
        if spent() {
            return None;
        }
        runs.set(runs.get() + 1);
        Some(verdict(eng, scaled(base, x)))
    };
    let ana = eng.analytic();
    // 1. The analytic limit, when it is the binding one.
    let mut bracket: Option<(f64, f64, f64, bool)> = None;
    let xa = ana.iter().map(|a| a.x).fold(f64::INFINITY, f64::min);
    if xa.is_finite()
        && xa < value
        && let Some(b) = verified_below(eng, xa)
    {
        let above = (b + 0.001).min(value);
        if above > b && matches!(at(above), Some(Verdict::Proven)) {
            bracket = Some((xa, b, above, true));
        }
    }
    // 2. Otherwise search.
    let (global, best, above, analytic) = match bracket {
        Some(t) => t,
        None => {
            let (lo, hi) = match search(value, search_top(eng.scale()), at) {
                Ok(b) => b,
                Err(stop) => {
                    let n = match stop {
                        SearchStop::Spent => format!(
                            "the search for the largest feasible {} stopped after {FINISH_RUNS} constructions",
                            value_name(base)
                        ),
                        SearchStop::Floor => format!(
                            "no {} of {} mm or more is feasible",
                            value_name(base),
                            SEARCH_FLOOR_TEXT
                        ),
                        SearchStop::Undecided(x, m) => format!(
                            "the search for the largest feasible {} stopped at {x:.4} mm, where a check could not be decided ({m})",
                            value_name(base)
                        ),
                    };
                    return Err(efail_error(&first, op, eng.all_edges(), Some(&n)));
                }
            };
            let Some(b) = verified_below(eng, lo) else {
                let n = if lo < 0.001 {
                    format!(
                        "only {} below 0.001 mm are feasible (e.g. {lo:.3e} mm)",
                        value_name(base)
                    )
                } else {
                    format!(
                        "the largest feasible {} (about {lo:.4} mm) could not be confirmed at a multiple of 0.001 mm",
                        value_name(base)
                    )
                };
                return Err(efail_error(&first, op, eng.all_edges(), Some(&n)));
            };
            (lo, b, hi, false)
        }
    };
    // The feasible-range property (the plan's acceptance, W6 review rounds 4 and 5):
    // `max + 0.001` and `1.01·max` must both fail with a **proven** violation (below 0.1 mm,
    // where 1 % is less than the SPEC's 0.001 mm rounding step, `1.01·max` lies below the
    // next multiple and only that one is checked: the property holds from 0.1 mm up). Where
    // the construction is not monotone and such a value builds, the range above it is
    // searched again (bounded); where it fails otherwise (an undecided check), no maximum is
    // claimed.
    let (mut global, mut best, mut above, analytic) = (global, best, above, analytic);
    for round in 0..4 {
        // `max + 0.001`, then `1.01·max` where that is larger: both must be proven
        // infeasible (the requested value itself is).
        let next = ((best * 1000.0).round() + 1.0) / 1000.0;
        let mut cands = vec![(next, true)];
        if 1.01 * best > next {
            cands.push((1.01 * best, false));
        }
        let mut moved = false;
        for (x, at_next) in cands {
            if x >= value {
                continue;
            }
            if spent() || round == 3 {
                let n = format!(
                    "the search for the largest feasible {} stopped ({} {best} mm builds)",
                    value_name(base),
                    value_name(base)
                );
                return Err(efail_error(&first, op, eng.all_edges(), Some(&n)));
            }
            runs.set(runs.get() + 1);
            match verdict(eng, scaled(base, x)) {
                Verdict::Proven => continue,
                Verdict::Built if at_next => {
                    // The next multiple of 0.001 mm builds: it is the better suggestion.
                    best = next;
                    global = next;
                    above = above.max(next);
                }
                Verdict::Built => {
                    // Bisect above `x` (built) up to the requested value (proven
                    // infeasible), below any undecided value (see [`search`]).
                    let (mut lo, mut hi) = (x, value);
                    let mut cap = hi;
                    while cap - lo > 1e-4 {
                        let mid = 0.5 * (lo + cap);
                        match at(mid) {
                            Some(Verdict::Built) => lo = mid,
                            Some(Verdict::Proven) => {
                                hi = mid;
                                cap = mid;
                            }
                            Some(Verdict::Unknown(_)) => cap = mid,
                            None => break,
                        }
                    }
                    match verified_below(eng, lo) {
                        Some(b) if b > best => {
                            best = b;
                            global = lo;
                            above = hi;
                        }
                        _ => {
                            let n = format!(
                                "{} {x:.4} mm builds above the largest confirmed value {best} mm",
                                value_name(base)
                            );
                            return Err(efail_error(&first, op, eng.all_edges(), Some(&n)));
                        }
                    }
                }
                Verdict::Unknown(m) => {
                    let n = format!(
                        "{} {best} mm builds, but at {x:.4} mm a check could not be decided ({m}): no proven limit",
                        value_name(base)
                    );
                    return Err(efail_error(&first, op, eng.all_edges(), Some(&n)));
                }
            }
            moved = true;
            break;
        }
        if !moved {
            break;
        }
    }
    // The edges limited at the requested value, and just above the global maximum.
    let at_value = eng.violations_prof(base).unwrap_or_default();
    let at_above = eng.violations_prof(scaled(base, above)).unwrap_or_default();
    // A blend that runs into another feature of the body where the maximum was found (W6
    // review round 6): SPEC §6.6 defines the rolling ball there — OCCT builds it, trimmed
    // around the feature — and gives no size limit for it, so the maximum found is Forge's
    // capability, not the geometry's: `*_FAILED` naming the obstacle, with the value that
    // was built as a hint in the reason, never `*_TOO_LARGE`.
    let binding: &[NViol] = if at_above.is_empty() {
        &at_value
    } else {
        &at_above
    };
    let ana_obstacle: Vec<&NLimit> = if analytic {
        ana.iter()
            .filter(|a| a.obstacle && a.x <= global * (1.0 + 1e-9))
            .collect()
    } else {
        Vec::new()
    };
    if binding.iter().any(|v| v.obstacle) || !ana_obstacle.is_empty() {
        return Err(obstacle_error(op, base, best, binding, &ana_obstacle));
    }
    let mut failing: BTreeMap<Named, (Limit, Option<String>, Option<String>)> = BTreeMap::new();
    for v in at_value.iter().chain(&at_above) {
        for e in &v.edges {
            failing
                .entry(e.clone())
                .or_insert((v.limit, v.face.clone(), v.face_name.clone()));
        }
    }
    let tight: BTreeSet<Named> = at_above
        .iter()
        .flat_map(|v| v.edges.iter().cloned())
        .collect();
    let own_analytic = |e: &Named| {
        ana.iter()
            .filter(|a| &a.edge == e)
            .min_by(|a, b| a.x.total_cmp(&b.x))
            .cloned()
    };
    // (edge, max, limit, face key, face display name, face width).
    type PerEdge = (
        Named,
        f64,
        Limit,
        Option<String>,
        Option<String>,
        Option<f64>,
    );
    let mut per_edge: Vec<PerEdge> = Vec::new();
    // Pre-build checks for the edges' own limits, within their own budget.
    let checks = std::cell::Cell::new(0usize);
    for (e, (limit, face, face_name)) in &failing {
        let an = own_analytic(e);
        if tight.contains(e) || tight.is_empty() {
            // Limited at the global maximum: the analytic limit classifies it (and names the
            // face) whenever its value is the one found — confirmed, or inside the final
            // bracket `[best, above]` of the search — so that one configuration gets one
            // classification whatever the requested value (W6 review round 4: a 6.82 mm face
            // between two blended edges was `face-width` at r = 4 and `adjacent-blend` at
            // r = 3.41).
            let (limit, face, fname, width) = match &an {
                Some(a)
                    if (analytic && a.x <= global * (1.0 + 1e-9))
                        || (a.x >= best - 1e-9 && a.x <= above + 1e-9) =>
                {
                    (
                        a.limit,
                        Some(a.face.clone()),
                        Some(a.face_name.clone()),
                        a.width,
                    )
                }
                _ => (*limit, face.clone(), face_name.clone(), None),
            };
            per_edge.push((e.clone(), best, limit, face, fname, width));
            continue;
        }
        // The edge's own limit: no violation attributed to it (other failures are the
        // global limit's business): `Built` when the pre-build checks attribute nothing to
        // it, `Proven` when they attribute a violation, `Unknown` when a check could not be
        // decided (W6 review round 5: which stops the search, never brackets it). Out of
        // budget or undecided, the edge gets the global value (a value it is known to accept).
        let ok_e = |x: f64| -> Option<Verdict> {
            if checks.get() >= EDGE_CHECKS {
                return None;
            }
            checks.set(checks.get() + 1);
            Some(match eng.violations_prof(scaled(base, x)) {
                Some(v) if v.iter().any(|w| w.edges.contains(e)) => Verdict::Proven,
                Some(_) => Verdict::Built,
                None => Verdict::Unknown("undecided".into()),
            })
        };
        let confirmed = an.as_ref().filter(|a| {
            let eta = (1e-6 * a.x).max(1e-4);
            a.x > best
                && a.x - eta > 0.0
                && matches!(ok_e(a.x - eta), Some(Verdict::Built))
                && matches!(ok_e((a.x + eta).min(value)), Some(Verdict::Proven))
        });
        let (m, limit, face, fname, width) = match confirmed {
            Some(a) => (
                a.x,
                a.limit,
                Some(a.face.clone()),
                Some(a.face_name.clone()),
                a.width,
            ),
            None => (
                search(value, search_top(eng.scale()), ok_e).map_or(0.0, |(lo, _)| lo),
                *limit,
                face.clone(),
                face_name.clone(),
                None,
            ),
        };
        per_edge.push((
            e.clone(),
            round_down_mm(m).max(best),
            limit,
            face,
            fname,
            width,
        ));
    }
    if per_edge.is_empty() {
        // No violation could be attributed (W6 review round 4: never an invented
        // `face-width`): not a SPEC size limit.
        let n = format!(
            "no edge could be named as the limit; {} {best} mm builds",
            value_name(base)
        );
        return Err(efail_error(&first, op, eng.all_edges(), Some(&n)));
    }
    let total = eng.all_edges().len();
    Err(match (op, base) {
        (BlendOp::Fillet, _) => BlendError::RadiusTooLarge {
            r: value,
            max_feasible_r: best,
            edges: per_edge
                .into_iter()
                .map(|(e, m, limit, face, face_name, width)| EdgeRadiusLimit {
                    key: e.key,
                    name: e.name,
                    max_r: m,
                    limit,
                    face,
                    face_name,
                    width,
                })
                .collect(),
            total,
        },
        (BlendOp::Chamfer, _) => BlendError::DistanceTooLarge {
            d: value,
            max_feasible_d: best,
            edges: per_edge
                .into_iter()
                .map(|(e, m, _, _, _, _)| EdgeDistanceLimit {
                    key: e.key,
                    name: e.name,
                    max_d: m,
                })
                .collect(),
            total,
            d2: match (base, suggest(base, best)) {
                (Prof::Chamfer { d2: Some(v), .. }, Some(Prof::Chamfer { d2: Some(s), .. })) => {
                    Some((v, s))
                }
                _ => None,
            },
        },
    })
}

/// `*_FAILED` for a blend that runs into another feature of the body (see [`finish`]): the
/// edges concerned, the obstacle, and the largest value that was built (a hint, not a SPEC
/// `max_feasible_*`: a blend trimmed around the feature is not implemented).
fn obstacle_error(
    op: BlendOp,
    base: Prof,
    best: f64,
    binding: &[NViol],
    ana: &[&NLimit],
) -> BlendError {
    let hits: Vec<&NViol> = binding.iter().filter(|v| v.obstacle).collect();
    let edges = dedup_named(
        hits.iter()
            .flat_map(|v| v.edges.iter().cloned())
            .chain(ana.iter().map(|a| a.edge.clone())),
    );
    let what = match (hits.first(), ana.first()) {
        (Some(v), _) => v.what.clone(),
        (None, Some(a)) => format!(
            "the blend of {} runs into the rim of {}: another feature of the body lies in its way",
            a.edge.name, a.face_name
        ),
        (None, None) => "the blend runs into another feature of the body".to_string(),
    };
    BlendError::Failed {
        op,
        edges,
        reason: format!(
            "{what}; a blend trimmed around another feature is not implemented (SPEC §6.6 defines the rolling ball there: not a size limit, a Forge capability gap); {} {best} mm builds clear of it",
            value_name(base)
        ),
    }
}

/// The searched value's name, for messages.
fn value_name(prof: Prof) -> &'static str {
    match prof {
        Prof::Fillet(_) => "radius",
        Prof::Chamfer { .. } => "distance",
    }
}

/// The range text of a length field, as forge-ir's R-stage validation words it (one code,
/// one `details` shape).
pub(crate) fn length_range() -> String {
    format!("> {LINEAR_TOLERANCE}")
}

fn check_value(code: &'static str, field: &'static str, x: f64) -> Result<(), BlendError> {
    if x.is_finite() && x > LINEAR_TOLERANCE {
        Ok(())
    } else {
        Err(BlendError::InvalidValue {
            code,
            field,
            value: x,
            expected: length_range(),
        })
    }
}

/// Fillet `edges` of `body` with radius `r` (SPEC §6.6). Atomic: any edge that cannot be
/// blended fails the whole operation with a structured error (see the module docs). Every
/// pick must be an edge of `body`, whose index is `opts.body`.
pub fn fillet(
    body: &Body,
    edges: &[Pick<EdgeId>],
    r: f64,
    opts: &BlendOptions,
) -> Result<BlendOutput, BlendError> {
    check_value("INVALID_RADIUS", "r", r)?;
    blend(body, edges, Prof::Fillet(r), opts, BlendOp::Fillet)
}

/// Chamfer `edges` of `body` (SPEC §6.7), same contract as [`fillet`]; the `side` face of
/// the two-distance and distance–angle forms must be a face of `body` too.
pub fn chamfer(
    body: &Body,
    edges: &[Pick<EdgeId>],
    spec: &ChamferSpec,
    opts: &BlendOptions,
) -> Result<BlendOutput, BlendError> {
    let op = BlendOp::Chamfer;
    let (d, d2, angle, side) = match spec {
        ChamferSpec::Equal { d } => (*d, None, None, None),
        ChamferSpec::TwoDistances { d, d2, side } => {
            check_value("INVALID_VALUE", "d2", *d2)?;
            (*d, Some(*d2), None, Some(side))
        }
        ChamferSpec::DistanceAngle { d, angle_deg, side } => {
            let angle_deg = *angle_deg;
            if !(angle_deg.is_finite() && angle_deg > 0.0 && angle_deg < 90.0) {
                return Err(BlendError::InvalidValue {
                    code: "INVALID_VALUE",
                    field: "angle",
                    value: angle_deg,
                    expected: "in (0, 90)".into(),
                });
            }
            (*d, None, Some(math::deg_to_rad(angle_deg)), Some(side))
        }
    };
    check_value("INVALID_VALUE", "d", d)?;
    let mut p = prepare(body, edges, opts, op)?;
    if let Some(side) = side {
        let given_names = |p: &Prepared| -> Vec<Named> {
            p.given
                .iter()
                .map(|&e| edge_named(&p.keys, &p.plan, &p.inv_e, e))
                .collect()
        };
        // A side of another body (or an id this body does not have) bounds none of the edges.
        let si = if side.body == opts.body {
            p.plan.fmap.get(&side.id).copied()
        } else {
            None
        };
        let Some(si) = si else {
            return Err(BlendError::SideNotAdjacent {
                edges: given_names(&p),
            });
        };
        match chain_sides(&p, si) {
            Ok(s) => p.sides = s,
            Err(bad) => {
                return Err(BlendError::SideNotAdjacent {
                    edges: bad
                        .iter()
                        .map(|&e| edge_named(&p.keys, &p.plan, &p.inv_e, e))
                        .collect(),
                });
            }
        }
    }
    blend_prepared(body, &p, Prof::Chamfer { d, d2, angle }, opts, op)
}
