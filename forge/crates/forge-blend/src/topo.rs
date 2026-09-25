//! Adjacency on a [`Plan`]: edge faces and uses, vertex stars (the corners of the faces
//! around a vertex), outward normals, the directions into a face across an edge, edge
//! convexity (SPEC §5.3) and tangent-chain expansion (SPEC §6.6).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::Surface;
use forge_core::linalg::{Point3, Vec3};
use forge_ir::v1::{QUERY_ANGLE_TOLERANCE, TANGENT_CHAIN_TOLERANCE};

use crate::plan::{PE, PF, Plan};

/// Where a face uses an edge: `(face, loop, index in loop)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct UseAt {
    pub face: usize,
    pub lp: usize,
    pub idx: usize,
}

/// The corner of a face at a vertex: the use arriving at the vertex and the use leaving it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Corner {
    pub face: usize,
    pub lp: usize,
    /// Index (in the loop) of the use ending at the vertex.
    pub arrive: usize,
    /// Index of the use starting at the vertex.
    pub leave: usize,
    pub e_in: usize,
    pub e_out: usize,
}

/// Adjacency tables of a plan (built once per operation).
#[derive(Clone, Debug, Default)]
pub(crate) struct Adj {
    /// Uses of each edge, in face order.
    pub uses: Vec<Vec<UseAt>>,
    /// Corners around each vertex.
    pub corners: Vec<Vec<Corner>>,
}

impl Adj {
    pub fn new(p: &Plan) -> Self {
        let mut uses = vec![Vec::new(); p.es.len()];
        let mut corners = vec![Vec::new(); p.vs.len()];
        for (fi, f) in p.fs.iter().enumerate() {
            let Some(f) = f else { continue };
            for (li, lp) in f.loops.iter().enumerate() {
                let n = lp.len();
                for (ui, u) in lp.iter().enumerate() {
                    uses[u.edge].push(UseAt {
                        face: fi,
                        lp: li,
                        idx: ui,
                    });
                    let next = (ui + 1) % n;
                    if let Some(v) = p.use_end(u)
                        && n > 1
                    {
                        corners[v].push(Corner {
                            face: fi,
                            lp: li,
                            arrive: ui,
                            leave: next,
                            e_in: u.edge,
                            e_out: lp[next].edge,
                        });
                    }
                }
            }
        }
        Self { uses, corners }
    }

    /// The distinct faces of an edge.
    pub fn edge_faces(&self, e: usize) -> Vec<usize> {
        let mut v: Vec<usize> = self.uses[e].iter().map(|u| u.face).collect();
        v.dedup();
        v
    }

    /// Distinct edges incident to a vertex.
    pub fn vertex_edges(&self, v: usize) -> Vec<usize> {
        let s: BTreeSet<usize> = self.corners[v]
            .iter()
            .flat_map(|c| [c.e_in, c.e_out])
            .collect();
        s.into_iter().collect()
    }
}

/// Outward unit normal of `f` at (the projection of) `p`.
pub(crate) fn outward_normal(f: &PF, p: Point3) -> Option<Vec3> {
    let (u, v, _) = f.surf.project(p);
    let n = f.surf.normal(u, v)?;
    Some(if f.sense { n } else { -n })
}

/// Unit tangent of an edge curve at `t` (curve direction).
pub(crate) fn tangent(e: &PE, t: f64) -> Option<Vec3> {
    e.curve.d1(t).normalize()
}

/// The unit direction pointing **into** face `f` across edge `e` at parameter `t`,
/// perpendicular to the edge and tangent to the face (`n × d`, `d` the direction the face's
/// loop runs along the edge: the face is on the left seen from outside).
pub(crate) fn into_face(e: &PE, fwd: bool, f: &PF, t: f64) -> Option<Vec3> {
    let p = e.curve.eval(t);
    let d = tangent(e, t)?;
    let d = if fwd { d } else { -d };
    let n = outward_normal(f, p)?;
    n.cross(d).normalize()
}

/// Local convexity of an edge (SPEC §5.3: the material angle at the parametric middle).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Convexity {
    /// Material angle < 180° − tol.
    Convex,
    /// Material angle > 180° + tol.
    Concave,
    /// Within tol of 180° (tangent faces).
    Smooth,
}

/// Convexity of an edge between the faces of two uses, at `t`: the material angle is the
/// angle between the two into-face directions when the edge is convex and its complement
/// to 360° otherwise.
pub(crate) fn convexity_at(
    e: &PE,
    fa: &PF,
    fwd_a: bool,
    fb: &PF,
    fwd_b: bool,
    t: f64,
) -> Option<(Convexity, f64)> {
    let ia = into_face(e, fwd_a, fa, t)?;
    let ib = into_face(e, fwd_b, fb, t)?;
    let nb = outward_normal(fb, e.curve.eval(t))?;
    let phi = ia.dot(ib).clamp(-1.0, 1.0);
    let phi = forge_core::math::acos(phi);
    // The faces are tangent when the into-face directions are opposite.
    if forge_core::math::PI - phi <= QUERY_ANGLE_TOLERANCE {
        return Some((Convexity::Smooth, phi));
    }
    Some(if ia.dot(nb) < 0.0 {
        (Convexity::Convex, phi)
    } else {
        (Convexity::Concave, phi)
    })
}

/// Convexity of plan edge `e` at its parametric middle (`None` if it does not have exactly
/// two distinct faces).
pub(crate) fn edge_convexity(p: &Plan, adj: &Adj, e: usize) -> Option<Convexity> {
    let us = &adj.uses[e];
    if us.len() != 2 || us[0].face == us[1].face {
        return None;
    }
    let pe = &p.es[e];
    let fa = p.fs[us[0].face].as_ref()?;
    let fb = p.fs[us[1].face].as_ref()?;
    let ua = &fa.loops[us[0].lp][us[0].idx];
    let ub = &fb.loops[us[1].lp][us[1].idx];
    let t = 0.5 * (pe.range.0 + pe.range.1);
    convexity_at(pe, fa, ua.fwd, fb, ub.fwd, t).map(|c| c.0)
}

/// `true` for faces fillets and chamfers accept (SPEC §6.6 "supported edges").
pub(crate) fn supported_surface(s: &Surface) -> bool {
    !matches!(s, Surface::BSpline(_))
}

/// Unit tangent of edge `e` at vertex `v`, pointing **away** from `v` along the edge.
pub(crate) fn tangent_away(p: &Plan, e: usize, v: usize) -> Option<Vec3> {
    let pe = &p.es[e];
    let (t, sgn) = if pe.start == Some(v) {
        (pe.range.0, 1.0)
    } else if pe.end == Some(v) {
        (pe.range.1, -1.0)
    } else {
        return None;
    };
    tangent(pe, t).map(|d| d * sgn)
}

/// Tangent-chain expansion (SPEC §6.6): repeatedly add every edge sharing a vertex with an
/// edge of the set whose tangent there continues the set edge's tangent within
/// `TANGENT_CHAIN_TOLERANCE` and whose convexity is the same. Returns the added edges in
/// the order found (deterministic: sets are walked in index order).
pub(crate) fn tangent_chain(p: &Plan, adj: &Adj, set: &[usize]) -> Vec<usize> {
    let mut have: BTreeSet<usize> = set.iter().copied().collect();
    let mut conv: BTreeMap<usize, Option<Convexity>> = BTreeMap::new();
    let mut conv_of = |e: usize| -> Option<Convexity> {
        *conv.entry(e).or_insert_with(|| edge_convexity(p, adj, e))
    };
    let mut added = Vec::new();
    let mut queue: Vec<usize> = set.to_vec();
    while let Some(e) = queue.first().copied() {
        queue.remove(0);
        let pe = &p.es[e];
        let ce = conv_of(e);
        for v in [pe.start, pe.end].into_iter().flatten() {
            let Some(te) = tangent_away(p, e, v) else {
                continue;
            };
            for o in adj.vertex_edges(v) {
                if have.contains(&o) {
                    continue;
                }
                let Some(to) = tangent_away(p, o, v) else {
                    continue;
                };
                // A smooth continuation: the tangents leaving the vertex are opposite.
                let ang = forge_core::math::acos((-te.dot(to)).clamp(-1.0, 1.0));
                if ang <= TANGENT_CHAIN_TOLERANCE && conv_of(o) == ce && ce.is_some() {
                    have.insert(o);
                    added.push(o);
                    queue.push(o);
                }
            }
        }
    }
    added
}
