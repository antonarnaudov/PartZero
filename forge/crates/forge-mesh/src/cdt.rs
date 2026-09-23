//! Constrained Delaunay triangulation (CDT) in the plane.
//!
//! Every combinatorial decision (point location, edge crossing, convexity, the Delaunay
//! test) uses forge-core's adaptive exact predicates [`orient2d`] and [`incircle`], so the
//! triangulation is correct for **any** finite `f64` input, including collinear,
//! cocircular and near-degenerate configurations. There is no epsilon anywhere in this
//! module.
//!
//! # Algorithm
//! - **Incremental insertion** into a triangulation of a large enclosing ("super")
//!   triangle: locate the point by a visibility walk from the last touched triangle
//!   (falling back to an exhaustive scan if the walk exceeds its step budget, which can
//!   only happen in non-Delaunay regions next to constraints), split the containing
//!   triangle 1→3 or the containing edge 2→4, then restore the Delaunay property by
//!   Lawson flips that never cross a constrained edge.
//! - **Constraint insertion** (Sloan 1993): trace the segment through the triangulation
//!   collecting the crossed edges (a vertex exactly on the segment splits the constraint
//!   there), then flip crossed edges whose quadrilateral is strictly convex until the
//!   segment is an edge. A crossed edge that is itself constrained is an error
//!   ([`CdtError::ConstraintsCross`]). After all constraints, a global Lawson pass makes
//!   every unconstrained edge locally Delaunay, which yields the CDT.
//! - **Domain marking** from *directed* boundary segments (the domain lies to their
//!   left): the triangle left of each segment seeds a flood fill that never crosses a
//!   constrained edge. A triangle reached from both sides of a segment, or one touching
//!   the super triangle, is reported ([`CdtError::DomainInconsistent`],
//!   [`CdtError::DomainLeak`]) instead of producing a wrong mesh.
//! - **Steiner points** ([`Cdt::insert_steiner`]) are accepted only strictly inside the
//!   marked domain (never on a constrained edge), so refinement cannot alter the
//!   boundary.
//!
//! # Determinism
//! Triangles are never deleted: splits and flips reuse slots and append new ones, so
//! indices and iteration order depend only on the input sequence. Walks start from
//! deterministic hints and check edges in a fixed order.
//!
//! # Indices
//! Vertex indices in this API are 0-based in insertion order (the three super-triangle
//! vertices are internal and never exposed).

use std::collections::VecDeque;

use forge_core::Point2;
use forge_core::predicates::{incircle, orient2d};
use thiserror::Error;

/// Marker for "no triangle" (hull side of a super-triangle edge).
const NONE: u32 = u32::MAX;
/// Number of internal super-triangle vertices preceding user vertices.
const SUPER: u32 = 3;

/// A CDT failure. Every variant has a stable [`CdtError::code`].
#[derive(Clone, Debug, PartialEq, Error)]
pub enum CdtError {
    /// A coordinate is NaN or infinite.
    #[error("non-finite point coordinate")]
    NonFinite,
    /// A point lies outside the bounds given to [`Cdt::new`].
    #[error("point ({x}, {y}) lies outside the triangulation bounds")]
    OutsideBounds {
        /// x coordinate.
        x: f64,
        /// y coordinate.
        y: f64,
    },
    /// A point coincides exactly with an existing vertex.
    #[error("point coincides with existing vertex {existing}")]
    DuplicatePoint {
        /// The existing vertex.
        existing: u32,
    },
    /// A vertex index is out of range.
    #[error("vertex index {index} out of range")]
    InvalidVertex {
        /// The offending index.
        index: u32,
    },
    /// A constraint has identical endpoints.
    #[error("degenerate constraint ({a}, {a})")]
    DegenerateConstraint {
        /// The endpoint.
        a: u32,
    },
    /// Two constraints cross (or a constraint overlaps another).
    #[error("constraint ({a}, {b}) crosses the constrained edge ({c}, {d})")]
    ConstraintsCross {
        /// New constraint start.
        a: u32,
        /// New constraint end.
        b: u32,
        /// Existing constrained edge start.
        c: u32,
        /// Existing constrained edge end.
        d: u32,
    },
    /// A directed boundary segment is not a constrained edge of the triangulation.
    #[error("boundary segment ({a}, {b}) is not a constrained edge")]
    BoundaryNotConstrained {
        /// Start.
        a: u32,
        /// End.
        b: u32,
    },
    /// The domain lies on both sides of a boundary segment (inconsistent orientation or
    /// overlapping loops).
    #[error("domain is on both sides of boundary segment ({a}, {b})")]
    DomainInconsistent {
        /// Start.
        a: u32,
        /// End.
        b: u32,
    },
    /// The flood fill escaped to the super triangle: the boundary is not closed.
    #[error("domain is not enclosed by the boundary segments")]
    DomainLeak,
    /// An internal step budget was exceeded (a bug; reported instead of looping).
    #[error("internal CDT step budget exceeded in {stage}")]
    Budget {
        /// Which stage.
        stage: &'static str,
    },
}

impl CdtError {
    /// Stable machine-readable code.
    pub fn code(&self) -> &'static str {
        match self {
            CdtError::NonFinite => "CDT_NON_FINITE",
            CdtError::OutsideBounds { .. } => "CDT_OUTSIDE_BOUNDS",
            CdtError::DuplicatePoint { .. } => "CDT_DUPLICATE_POINT",
            CdtError::InvalidVertex { .. } => "CDT_INVALID_VERTEX",
            CdtError::DegenerateConstraint { .. } => "CDT_DEGENERATE_CONSTRAINT",
            CdtError::ConstraintsCross { .. } => "CDT_CONSTRAINTS_CROSS",
            CdtError::BoundaryNotConstrained { .. } => "CDT_BOUNDARY_NOT_CONSTRAINED",
            CdtError::DomainInconsistent { .. } => "CDT_DOMAIN_INCONSISTENT",
            CdtError::DomainLeak => "CDT_DOMAIN_LEAK",
            CdtError::Budget { .. } => "CDT_BUDGET",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Tri {
    /// Vertices, counter-clockwise.
    v: [u32; 3],
    /// `n[i]` is the neighbour across edge `i` = `(v[i+1], v[i+2])`, opposite `v[i]`.
    n: [u32; 3],
    /// `c[i]`: edge `i` is constrained.
    c: [bool; 3],
    /// Inside the marked domain.
    inside: bool,
}

enum Located {
    Inside(u32),
    OnEdge(u32, usize),
    OnVertex(u32),
}

/// Where a Steiner point would land.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SteinerOutcome {
    /// Inserted as this vertex.
    Inserted(u32),
    /// Rejected: outside the domain, on a constrained edge, or on an existing vertex.
    Rejected,
}

/// A constrained Delaunay triangulation under construction (see the module docs).
#[derive(Clone, Debug)]
pub struct Cdt {
    pts: Vec<Point2>,
    tris: Vec<Tri>,
    vtri: Vec<u32>,
    hint: u32,
    touched: Vec<u32>,
    domain_marked: bool,
}

#[inline]
fn nx(i: usize) -> usize {
    (i + 1) % 3
}
#[inline]
fn pv(i: usize) -> usize {
    (i + 2) % 3
}

impl Cdt {
    /// An empty triangulation able to hold points inside the axis-aligned box
    /// `[min, max]` (strictly: points must lie inside an enclosing triangle much larger
    /// than the box).
    pub fn new(min: Point2, max: Point2) -> Result<Self, CdtError> {
        if !(min.is_finite() && max.is_finite()) {
            return Err(CdtError::NonFinite);
        }
        let cx = 0.5 * (min.x + max.x);
        let cy = 0.5 * (min.y + max.y);
        let size = (max.x - min.x).abs().max((max.y - min.y).abs());
        let m = if size > 0.0 { 16.0 * size } else { 1.0 };
        let pts = vec![
            Point2::new(cx - 3.0 * m, cy - 2.0 * m),
            Point2::new(cx + 3.0 * m, cy - 2.0 * m),
            Point2::new(cx, cy + 3.0 * m),
        ];
        if !pts.iter().all(|p| p.is_finite()) {
            return Err(CdtError::NonFinite);
        }
        Ok(Self {
            pts,
            tris: vec![Tri {
                v: [0, 1, 2],
                n: [NONE; 3],
                c: [false; 3],
                inside: false,
            }],
            vtri: vec![0, 0, 0],
            hint: 0,
            touched: Vec::new(),
            domain_marked: false,
        })
    }

    /// Number of user vertices.
    pub fn vertex_count(&self) -> usize {
        self.pts.len() - SUPER as usize
    }

    /// Coordinates of user vertex `v`.
    pub fn point(&self, v: u32) -> Point2 {
        self.pts[(v + SUPER) as usize]
    }

    fn check_user(&self, v: u32) -> Result<u32, CdtError> {
        let i = v
            .checked_add(SUPER)
            .ok_or(CdtError::InvalidVertex { index: v })?;
        if (i as usize) < self.pts.len() {
            Ok(i)
        } else {
            Err(CdtError::InvalidVertex { index: v })
        }
    }

    // -----------------------------------------------------------------------------------
    // Low-level helpers
    // -----------------------------------------------------------------------------------

    fn touch(&mut self, t: u32) {
        let tri = self.tris[t as usize];
        for &v in &tri.v {
            self.vtri[v as usize] = t;
        }
        self.touched.push(t);
    }

    /// Index (0..3) of vertex `v` in triangle `t`.
    fn index_of(&self, t: u32, v: u32) -> Option<usize> {
        self.tris[t as usize].v.iter().position(|&x| x == v)
    }

    /// Replace the neighbour pointer `old` of triangle `t` by `new`.
    fn relink(&mut self, t: u32, old: u32, new: u32) {
        if t == NONE {
            return;
        }
        let tri = &mut self.tris[t as usize];
        for k in 0..3 {
            if tri.n[k] == old {
                tri.n[k] = new;
                return;
            }
        }
    }

    /// Index in `u` of the edge shared with `t`.
    fn shared_index(&self, u: u32, t: u32) -> usize {
        let tu = &self.tris[u as usize];
        (0..3).find(|&k| tu.n[k] == t).unwrap_or(0)
    }

    /// Triangles around vertex `v` (internal index), counter-clockwise where possible.
    fn star(&self, v: u32) -> Vec<u32> {
        let t0 = self.vtri[v as usize];
        let mut out = vec![t0];
        let mut t = t0;
        let mut closed = false;
        for _ in 0..self.tris.len() {
            let k = match self.index_of(t, v) {
                Some(k) => k,
                None => break,
            };
            let next = self.tris[t as usize].n[nx(k)];
            if next == NONE {
                break;
            }
            if next == t0 {
                closed = true;
                break;
            }
            out.push(next);
            t = next;
        }
        if !closed {
            let mut back = Vec::new();
            let mut t = t0;
            for _ in 0..self.tris.len() {
                let k = match self.index_of(t, v) {
                    Some(k) => k,
                    None => break,
                };
                let prev = self.tris[t as usize].n[pv(k)];
                if prev == NONE || prev == t0 {
                    break;
                }
                back.push(prev);
                t = prev;
            }
            back.reverse();
            back.extend(out);
            out = back;
        }
        out
    }

    /// The triangle containing the edge `(a, b)` (either direction) and the index of the
    /// edge in it, if the edge exists (internal indices).
    fn find_edge(&self, a: u32, b: u32) -> Option<(u32, usize)> {
        for t in self.star(a) {
            let tri = &self.tris[t as usize];
            if let Some(k) = tri.v.iter().position(|&x| x == a) {
                if tri.v[nx(k)] == b {
                    return Some((t, pv(k)));
                }
                if tri.v[pv(k)] == b {
                    return Some((t, nx(k)));
                }
            }
        }
        None
    }

    fn p(&self, v: u32) -> Point2 {
        self.pts[v as usize]
    }

    // -----------------------------------------------------------------------------------
    // Point location
    // -----------------------------------------------------------------------------------

    fn classify_in(&self, t: u32, p: Point2) -> Option<Located> {
        let tri = &self.tris[t as usize];
        let mut zeros = [false; 3];
        for (i, z) in zeros.iter_mut().enumerate() {
            let o = orient2d(self.p(tri.v[nx(i)]), self.p(tri.v[pv(i)]), p);
            if o < 0.0 {
                return None;
            }
            *z = o == 0.0;
        }
        let nz = zeros.iter().filter(|z| **z).count();
        Some(match nz {
            0 => Located::Inside(t),
            1 => Located::OnEdge(t, zeros.iter().position(|z| *z).unwrap_or(0)),
            _ => {
                let k = zeros.iter().position(|z| !*z).unwrap_or(0);
                Located::OnVertex(tri.v[k])
            }
        })
    }

    fn locate(&self, p: Point2) -> Result<Located, CdtError> {
        let mut t = if (self.hint as usize) < self.tris.len() {
            self.hint
        } else {
            0
        };
        let budget = 64 + 4 * self.tris.len();
        'walk: for _ in 0..budget {
            let tri = &self.tris[t as usize];
            for i in 0..3 {
                let o = orient2d(self.p(tri.v[nx(i)]), self.p(tri.v[pv(i)]), p);
                if o < 0.0 {
                    let nt = tri.n[i];
                    if nt == NONE {
                        return Err(CdtError::OutsideBounds { x: p.x, y: p.y });
                    }
                    t = nt;
                    continue 'walk;
                }
            }
            if let Some(l) = self.classify_in(t, p) {
                return Ok(l);
            }
        }
        // Exhaustive fallback (only reachable through a cycling walk in a non-Delaunay
        // region); deterministic scan order.
        for t in 0..self.tris.len() as u32 {
            if let Some(l) = self.classify_in(t, p) {
                return Ok(l);
            }
        }
        Err(CdtError::OutsideBounds { x: p.x, y: p.y })
    }

    // -----------------------------------------------------------------------------------
    // Topological operations
    // -----------------------------------------------------------------------------------

    fn push_tri(&mut self, tri: Tri) -> u32 {
        self.tris.push(tri);
        (self.tris.len() - 1) as u32
    }

    /// Split triangle `t` at the new vertex `p` (1 → 3). Returns the three triangles.
    fn split_tri(&mut self, t: u32, p: u32) -> [u32; 3] {
        let old = self.tris[t as usize];
        let [a, b, c] = old.v;
        let [na, nb, nc] = old.n;
        let [ca, cb, cc] = old.c;
        let t1 = self.push_tri(old);
        let t2 = self.push_tri(old);
        let t0 = t;
        self.tris[t0 as usize] = Tri {
            v: [a, b, p],
            n: [t1, t2, nc],
            c: [false, false, cc],
            inside: old.inside,
        };
        self.tris[t1 as usize] = Tri {
            v: [b, c, p],
            n: [t2, t0, na],
            c: [false, false, ca],
            inside: old.inside,
        };
        self.tris[t2 as usize] = Tri {
            v: [c, a, p],
            n: [t0, t1, nb],
            c: [false, false, cb],
            inside: old.inside,
        };
        self.relink(na, t, t1);
        self.relink(nb, t, t2);
        for x in [t0, t1, t2] {
            self.touch(x);
        }
        [t0, t1, t2]
    }

    /// Split edge `i` of triangle `t` at the new vertex `p` (2 → 4). Returns the four
    /// triangles (each has `p` as its vertex 2... see the body for layouts).
    fn split_edge(&mut self, t: u32, i: usize, p: u32) -> Result<Vec<(u32, usize)>, CdtError> {
        let tt = self.tris[t as usize];
        let (c, a, b) = (tt.v[i], tt.v[nx(i)], tt.v[pv(i)]);
        let u = tt.n[i];
        if u == NONE {
            let q = self.p(p);
            return Err(CdtError::OutsideBounds { x: q.x, y: q.y });
        }
        let n_bc = tt.n[nx(i)];
        let n_ca = tt.n[pv(i)];
        let (c_ab, c_bc, c_ca) = (tt.c[i], tt.c[nx(i)], tt.c[pv(i)]);
        let tu = self.tris[u as usize];
        let j = self.shared_index(u, t);
        let d = tu.v[j];
        let u_ad = tu.n[nx(j)];
        let u_db = tu.n[pv(j)];
        let (c_ad, c_db) = (tu.c[nx(j)], tu.c[pv(j)]);
        let t1 = t;
        let u1 = u;
        let t2 = self.push_tri(tt);
        let u2 = self.push_tri(tu);
        self.tris[t1 as usize] = Tri {
            v: [c, a, p],
            n: [u1, t2, n_ca],
            c: [c_ab, false, c_ca],
            inside: tt.inside,
        };
        self.tris[t2 as usize] = Tri {
            v: [c, p, b],
            n: [u2, n_bc, t1],
            c: [c_ab, c_bc, false],
            inside: tt.inside,
        };
        self.tris[u1 as usize] = Tri {
            v: [d, p, a],
            n: [t1, u_ad, u2],
            c: [c_ab, c_ad, false],
            inside: tu.inside,
        };
        self.tris[u2 as usize] = Tri {
            v: [d, b, p],
            n: [t2, u1, u_db],
            c: [c_ab, false, c_db],
            inside: tu.inside,
        };
        self.relink(n_bc, t, t2);
        self.relink(u_db, u, u2);
        for x in [t1, t2, u1, u2] {
            self.touch(x);
        }
        // Edges opposite p.
        Ok(vec![(t1, 2), (t2, 1), (u1, 1), (u2, 2)])
    }

    /// Flip edge `i` of `t` (must be flippable). Returns the two triangles; in both, the
    /// vertex formerly at `t.v[i]` is vertex 0 and the new edge is `(v0, v_other)`.
    fn flip(&mut self, t: u32, i: usize) -> (u32, u32) {
        let tt = self.tris[t as usize];
        let (p, a, b) = (tt.v[i], tt.v[nx(i)], tt.v[pv(i)]);
        let u = tt.n[i];
        let tu = self.tris[u as usize];
        let j = self.shared_index(u, t);
        let d = tu.v[j];
        let n_bp = tt.n[nx(i)];
        let n_pa = tt.n[pv(i)];
        let (c_bp, c_pa) = (tt.c[nx(i)], tt.c[pv(i)]);
        let n_ad = tu.n[nx(j)];
        let n_db = tu.n[pv(j)];
        let (c_ad, c_db) = (tu.c[nx(j)], tu.c[pv(j)]);
        let inside = tt.inside;
        self.tris[t as usize] = Tri {
            v: [p, a, d],
            n: [n_ad, u, n_pa],
            c: [c_ad, false, c_pa],
            inside,
        };
        self.tris[u as usize] = Tri {
            v: [p, d, b],
            n: [n_db, n_bp, t],
            c: [c_db, c_bp, false],
            inside,
        };
        self.relink(n_ad, u, t);
        self.relink(n_bp, t, u);
        self.touch(t);
        self.touch(u);
        (t, u)
    }

    /// Lawson flips from a stack of `(triangle, edge)` pairs whose edge is opposite a
    /// freshly inserted vertex.
    fn legalize(&mut self, mut stack: Vec<(u32, usize)>) -> Result<(), CdtError> {
        let mut budget = 64 + 32 * self.tris.len();
        while let Some((t, i)) = stack.pop() {
            if budget == 0 {
                return Err(CdtError::Budget { stage: "legalize" });
            }
            budget -= 1;
            let tt = self.tris[t as usize];
            if tt.c[i] || tt.n[i] == NONE {
                continue;
            }
            let u = tt.n[i];
            let j = self.shared_index(u, t);
            let d = self.tris[u as usize].v[j];
            let [a, b, c] = tt.v;
            if incircle(self.p(a), self.p(b), self.p(c), self.p(d)) > 0.0 {
                let (t1, u1) = self.flip(t, i);
                // New outer edges (opposite the vertex formerly at t.v[i]).
                stack.push((t1, 0));
                stack.push((u1, 0));
            }
        }
        Ok(())
    }

    // -----------------------------------------------------------------------------------
    // Public operations
    // -----------------------------------------------------------------------------------

    /// Insert a point; returns its vertex index. Fails on a duplicate (exactly
    /// coincident) point or a point outside the bounds.
    pub fn insert_point(&mut self, p: Point2) -> Result<u32, CdtError> {
        if !p.is_finite() {
            return Err(CdtError::NonFinite);
        }
        let loc = self.locate(p)?;
        if let Located::OnVertex(v) = loc {
            if v < SUPER {
                return Err(CdtError::OutsideBounds { x: p.x, y: p.y });
            }
            return Err(CdtError::DuplicatePoint {
                existing: v - SUPER,
            });
        }
        let idx = self.pts.len() as u32;
        self.pts.push(p);
        self.vtri.push(0);
        let stack = match loc {
            Located::Inside(t) => {
                let ts = self.split_tri(t, idx);
                ts.iter().map(|&t| (t, 2usize)).collect()
            }
            Located::OnEdge(t, i) => self.split_edge(t, i, idx)?,
            Located::OnVertex(_) => unreachable!("handled above"),
        };
        self.legalize(stack)?;
        self.hint = self.vtri[idx as usize];
        Ok(idx - SUPER)
    }

    /// `true` if user vertices `a` and `b` are joined by an edge.
    pub fn has_edge(&self, a: u32, b: u32) -> bool {
        match (self.check_user(a), self.check_user(b)) {
            (Ok(a), Ok(b)) => self.find_edge(a, b).is_some(),
            _ => false,
        }
    }

    /// `true` if user vertices `a` and `b` are joined by a constrained edge.
    pub fn is_constrained(&self, a: u32, b: u32) -> bool {
        match (self.check_user(a), self.check_user(b)) {
            (Ok(a), Ok(b)) => self
                .find_edge(a, b)
                .is_some_and(|(t, i)| self.tris[t as usize].c[i]),
            _ => false,
        }
    }

    fn set_constrained(&mut self, a: u32, b: u32) {
        if let Some((t, i)) = self.find_edge(a, b) {
            self.tris[t as usize].c[i] = true;
            let u = self.tris[t as usize].n[i];
            if u != NONE {
                let j = self.shared_index(u, t);
                self.tris[u as usize].c[j] = true;
            }
        }
    }

    /// Insert the constraint segment between user vertices `a` and `b`. A vertex lying
    /// exactly on the open segment splits it into two constraints (check with
    /// [`Cdt::is_constrained`] if that matters to the caller).
    pub fn insert_constraint(&mut self, a: u32, b: u32) -> Result<(), CdtError> {
        let (ua, ub) = (a, b);
        let a = self.check_user(a)?;
        let b = self.check_user(b)?;
        if a == b {
            return Err(CdtError::DegenerateConstraint { a: ua });
        }
        let mut start = a;
        let mut guard = self.pts.len() + 4;
        loop {
            if guard == 0 {
                return Err(CdtError::Budget {
                    stage: "constraint split",
                });
            }
            guard -= 1;
            let (end, crossed) = self.trace(start, b, (ua, ub))?;
            if !crossed.is_empty() {
                self.sloan(start, end, crossed)?;
            }
            self.set_constrained(start, end);
            if end == b {
                break;
            }
            start = end;
        }
        Ok(())
    }

    /// Walk from `a` towards `b`: returns the first vertex reached on the segment (`b`
    /// or a vertex exactly on it) and the edges crossed on the way.
    fn trace(
        &mut self,
        a: u32,
        b: u32,
        user: (u32, u32),
    ) -> Result<(u32, Vec<(u32, u32)>), CdtError> {
        if self.find_edge(a, b).is_some() {
            return Ok((b, Vec::new()));
        }
        let (pa, pb) = (self.p(a), self.p(b));
        let on_ray = |q: Point2| {
            let d = pb - pa;
            (q - pa).dot(d) > 0.0
        };
        // Find the triangle around `a` through which the segment leaves.
        let mut start: Option<(u32, u32, u32)> = None;
        for t in self.star(a) {
            let k = match self.index_of(t, a) {
                Some(k) => k,
                None => continue,
            };
            let tri = self.tris[t as usize];
            let (p, q) = (tri.v[nx(k)], tri.v[pv(k)]);
            let op = orient2d(pa, pb, self.p(p));
            let oq = orient2d(pa, pb, self.p(q));
            if op == 0.0 && on_ray(self.p(p)) {
                return Ok((p, Vec::new()));
            }
            if oq == 0.0 && on_ray(self.p(q)) {
                return Ok((q, Vec::new()));
            }
            if op < 0.0 && oq > 0.0 {
                start = Some((t, p, q));
                break;
            }
        }
        let (mut t, mut p, mut q) = start.ok_or(CdtError::Budget {
            stage: "constraint trace start",
        })?;
        let mut crossed = Vec::new();
        for _ in 0..self.tris.len() + 4 {
            // Edge (p, q) of t is crossed; check it is not constrained.
            let k = match self.index_of(t, p).zip(self.index_of(t, q)) {
                Some((kp, kq)) => 3 - kp - kq,
                None => {
                    return Err(CdtError::Budget {
                        stage: "constraint trace",
                    });
                }
            };
            let tri = self.tris[t as usize];
            if tri.c[k] {
                return Err(CdtError::ConstraintsCross {
                    a: user.0,
                    b: user.1,
                    c: p.saturating_sub(SUPER),
                    d: q.saturating_sub(SUPER),
                });
            }
            crossed.push((p, q));
            let u = tri.n[k];
            if u == NONE {
                return Err(CdtError::Budget {
                    stage: "constraint trace hull",
                });
            }
            let j = self.shared_index(u, t);
            let r = self.tris[u as usize].v[j];
            if r == b {
                return Ok((b, crossed));
            }
            let or = orient2d(pa, pb, self.p(r));
            if or == 0.0 {
                return Ok((r, crossed));
            }
            if or < 0.0 {
                p = r;
            } else {
                q = r;
            }
            t = u;
        }
        Err(CdtError::Budget {
            stage: "constraint trace walk",
        })
    }

    /// `true` if the open segments `(p, q)` and `(a, b)` cross properly.
    fn crosses(&self, p: u32, q: u32, a: u32, b: u32) -> bool {
        let (pp, pq, pa, pb) = (self.p(p), self.p(q), self.p(a), self.p(b));
        let o1 = orient2d(pa, pb, pp);
        let o2 = orient2d(pa, pb, pq);
        let o3 = orient2d(pp, pq, pa);
        let o4 = orient2d(pp, pq, pb);
        ((o1 > 0.0 && o2 < 0.0) || (o1 < 0.0 && o2 > 0.0))
            && ((o3 > 0.0 && o4 < 0.0) || (o3 < 0.0 && o4 > 0.0))
    }

    /// Sloan's edge-flipping insertion of the segment `(a, b)` given the crossed edges.
    fn sloan(&mut self, a: u32, b: u32, crossed: Vec<(u32, u32)>) -> Result<(), CdtError> {
        let n = crossed.len();
        let mut queue: VecDeque<(u32, u32)> = crossed.into();
        let mut budget = 64 + 16 * (n + 1) * (n + 1);
        while let Some((p, q)) = queue.pop_front() {
            if budget == 0 {
                return Err(CdtError::Budget { stage: "sloan" });
            }
            budget -= 1;
            let (t, i) = self.find_edge(p, q).ok_or(CdtError::Budget {
                stage: "sloan edge lookup",
            })?;
            let u = self.tris[t as usize].n[i];
            if u == NONE {
                return Err(CdtError::Budget {
                    stage: "sloan hull",
                });
            }
            let r1 = self.tris[t as usize].v[i];
            let j = self.shared_index(u, t);
            let r2 = self.tris[u as usize].v[j];
            let o1 = orient2d(self.p(r1), self.p(r2), self.p(p));
            let o2 = orient2d(self.p(r1), self.p(r2), self.p(q));
            let convex = (o1 > 0.0 && o2 < 0.0) || (o1 < 0.0 && o2 > 0.0);
            if convex {
                self.flip(t, i);
                if self.crosses(r1, r2, a, b) {
                    queue.push_back((r1, r2));
                }
            } else {
                queue.push_back((p, q));
            }
        }
        Ok(())
    }

    /// Make every unconstrained edge locally Delaunay (global Lawson pass). Called by
    /// [`Cdt::mark_domain`]; may be called earlier.
    pub fn make_delaunay(&mut self) -> Result<(), CdtError> {
        let mut stack: Vec<(u32, usize)> = Vec::with_capacity(self.tris.len() * 3);
        for t in (0..self.tris.len() as u32).rev() {
            for i in (0..3).rev() {
                stack.push((t, i));
            }
        }
        let mut budget = 64 + 64 * self.tris.len() * 3;
        while let Some((t, i)) = stack.pop() {
            if budget == 0 {
                return Err(CdtError::Budget { stage: "delaunay" });
            }
            budget -= 1;
            let tt = self.tris[t as usize];
            if tt.c[i] || tt.n[i] == NONE {
                continue;
            }
            let u = tt.n[i];
            let j = self.shared_index(u, t);
            let d = self.tris[u as usize].v[j];
            let [a, b, c] = tt.v;
            if incircle(self.p(a), self.p(b), self.p(c), self.p(d)) > 0.0 {
                let (t1, u1) = self.flip(t, i);
                for (x, k) in [(t1, 0), (t1, 2), (u1, 0), (u1, 1)] {
                    stack.push((x, k));
                }
            }
        }
        Ok(())
    }

    /// Mark the domain: the region to the left of the directed boundary segments
    /// `(a, b)` (user indices), which must all be constrained edges. Runs
    /// [`Cdt::make_delaunay`] first.
    pub fn mark_domain(&mut self, boundary: &[(u32, u32)]) -> Result<(), CdtError> {
        self.make_delaunay()?;
        for t in &mut self.tris {
            t.inside = false;
        }
        let mut queue: Vec<u32> = Vec::new();
        let mut sides = Vec::with_capacity(boundary.len());
        for &(ua, ub) in boundary {
            let a = self.check_user(ua)?;
            let b = self.check_user(ub)?;
            let (t, i) = self
                .find_edge(a, b)
                .ok_or(CdtError::BoundaryNotConstrained { a: ua, b: ub })?;
            if !self.tris[t as usize].c[i] {
                return Err(CdtError::BoundaryNotConstrained { a: ua, b: ub });
            }
            // The triangle in which a→b runs counter-clockwise lies to its left.
            let tt = self.tris[t as usize];
            let left_is_t = tt.v[nx(i)] == a;
            let u = tt.n[i];
            let (left, right) = if left_is_t { (t, u) } else { (u, t) };
            if left == NONE {
                return Err(CdtError::DomainLeak);
            }
            sides.push((ua, ub, right));
            if !self.tris[left as usize].inside {
                self.tris[left as usize].inside = true;
                queue.push(left);
            }
        }
        while let Some(t) = queue.pop() {
            let tt = self.tris[t as usize];
            if tt.v.iter().any(|&v| v < SUPER) {
                return Err(CdtError::DomainLeak);
            }
            for i in 0..3 {
                if tt.c[i] {
                    continue;
                }
                let u = tt.n[i];
                if u == NONE {
                    return Err(CdtError::DomainLeak);
                }
                if !self.tris[u as usize].inside {
                    self.tris[u as usize].inside = true;
                    queue.push(u);
                }
            }
        }
        for (a, b, right) in sides {
            if right != NONE && self.tris[right as usize].inside {
                return Err(CdtError::DomainInconsistent { a, b });
            }
        }
        self.domain_marked = true;
        self.touched.clear();
        Ok(())
    }

    /// Insert a Steiner point strictly inside the marked domain (not on a constrained
    /// edge or an existing vertex); otherwise nothing changes.
    pub fn insert_steiner(&mut self, p: Point2) -> Result<SteinerOutcome, CdtError> {
        if !p.is_finite() {
            return Err(CdtError::NonFinite);
        }
        let loc = self.locate(p)?;
        let ok = match loc {
            Located::Inside(t) => self.tris[t as usize].inside,
            Located::OnEdge(t, i) => {
                let tt = self.tris[t as usize];
                !tt.c[i] && tt.inside && tt.n[i] != NONE && self.tris[tt.n[i] as usize].inside
            }
            Located::OnVertex(_) => false,
        };
        if !ok {
            return Ok(SteinerOutcome::Rejected);
        }
        let idx = self.pts.len() as u32;
        self.pts.push(p);
        self.vtri.push(0);
        let stack = match loc {
            Located::Inside(t) => self
                .split_tri(t, idx)
                .iter()
                .map(|&t| (t, 2usize))
                .collect(),
            Located::OnEdge(t, i) => self.split_edge(t, i, idx)?,
            Located::OnVertex(_) => unreachable!("rejected above"),
        };
        self.legalize(stack)?;
        self.hint = self.vtri[idx as usize];
        Ok(SteinerOutcome::Inserted(idx - SUPER))
    }

    /// The containing triangle of `p` if it is inside the marked domain, as the user
    /// vertex triple (for callers that pre-filter candidate points).
    pub fn inside_triangle_at(&self, p: Point2) -> Result<Option<[u32; 3]>, CdtError> {
        Ok(match self.locate(p)? {
            Located::Inside(t) if self.tris[t as usize].inside => {
                Some(self.tris[t as usize].v.map(|v| v - SUPER))
            }
            _ => None,
        })
    }

    /// Triangle slots modified since the last call (deduplicated, ascending).
    pub fn take_touched(&mut self) -> Vec<u32> {
        let mut t = core::mem::take(&mut self.touched);
        t.sort_unstable();
        t.dedup();
        t
    }

    /// Number of triangle slots (inside or not).
    pub fn slot_count(&self) -> usize {
        self.tris.len()
    }

    /// The triangle in slot `t` if it is inside the marked domain: user vertex indices
    /// (counter-clockwise) and per-edge constrained flags (`c[i]` for the edge opposite
    /// vertex `i`).
    pub fn slot(&self, t: u32) -> Option<([u32; 3], [bool; 3])> {
        let tt = self.tris.get(t as usize)?;
        if !tt.inside {
            return None;
        }
        Some((tt.v.map(|v| v - SUPER), tt.c))
    }

    /// All triangles inside the marked domain, in slot order (user indices, CCW).
    pub fn triangles(&self) -> Vec<[u32; 3]> {
        self.tris
            .iter()
            .filter(|t| t.inside)
            .map(|t| t.v.map(|v| v - SUPER))
            .collect()
    }

    /// For every inside triangle and each of its unconstrained edges shared with another
    /// inside triangle: `(triangle, opposite vertex across that edge)` (user indices).
    /// Used by tests to check the Delaunay property.
    pub fn interior_edge_pairs(&self) -> Vec<([u32; 3], u32)> {
        let mut out = Vec::new();
        for (ti, t) in self.tris.iter().enumerate() {
            if !t.inside {
                continue;
            }
            for i in 0..3 {
                let u = t.n[i];
                if t.c[i] || u == NONE || !self.tris[u as usize].inside {
                    continue;
                }
                let j = self.shared_index(u, ti as u32);
                out.push((t.v.map(|v| v - SUPER), self.tris[u as usize].v[j] - SUPER));
            }
        }
        out
    }
}

/// The triangulation of a polygon with holes (see [`triangulate_polygon`]).
#[derive(Clone, Debug)]
pub struct PolygonTriangulation {
    /// All points: the outer ring, then each hole, in input order.
    pub points: Vec<Point2>,
    /// Triangles (counter-clockwise), indices into `points`.
    pub triangles: Vec<[u32; 3]>,
}

/// Constrained Delaunay triangulation of a polygon with holes.
///
/// `outer` is a simple polygon in counter-clockwise order; each hole a simple polygon in
/// clockwise order strictly inside it (rings are implicitly closed; do not repeat the
/// first point). Rings may not touch or cross each other; points may not repeat.
pub fn triangulate_polygon(
    outer: &[Point2],
    holes: &[Vec<Point2>],
) -> Result<PolygonTriangulation, CdtError> {
    let mut points: Vec<Point2> = outer.to_vec();
    for h in holes {
        points.extend_from_slice(h);
    }
    if points.is_empty() {
        return Ok(PolygonTriangulation {
            points,
            triangles: Vec::new(),
        });
    }
    let mut min = points[0];
    let mut max = points[0];
    for p in &points {
        min = Point2::new(min.x.min(p.x), min.y.min(p.y));
        max = Point2::new(max.x.max(p.x), max.y.max(p.y));
    }
    let mut cdt = Cdt::new(min, max)?;
    for p in &points {
        cdt.insert_point(*p)?;
    }
    let mut segs = Vec::new();
    let mut base = 0u32;
    for ring_len in std::iter::once(outer.len()).chain(holes.iter().map(Vec::len)) {
        let n = ring_len as u32;
        for k in 0..n {
            segs.push((base + k, base + (k + 1) % n));
        }
        base += n;
    }
    for &(a, b) in &segs {
        cdt.insert_constraint(a, b)?;
    }
    for &(a, b) in &segs {
        if !cdt.is_constrained(a, b) {
            return Err(CdtError::BoundaryNotConstrained { a, b });
        }
    }
    cdt.mark_domain(&segs)?;
    Ok(PolygonTriangulation {
        points,
        triangles: cdt.triangles(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point2 {
        Point2::new(x, y)
    }

    fn area(pts: &[Point2], tris: &[[u32; 3]]) -> f64 {
        tris.iter()
            .map(|t| {
                let (a, b, c) = (pts[t[0] as usize], pts[t[1] as usize], pts[t[2] as usize]);
                0.5 * (b - a).perp_dot(c - a)
            })
            .sum()
    }

    #[test]
    fn square_is_two_ccw_triangles() {
        let sq = [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0), p(0.0, 1.0)];
        let t = triangulate_polygon(&sq, &[]).expect("cdt");
        assert_eq!(t.triangles.len(), 2);
        assert!((area(&t.points, &t.triangles) - 1.0).abs() < 1e-15);
        for tri in &t.triangles {
            let [a, b, c] = tri.map(|i| t.points[i as usize]);
            assert!(orient2d(a, b, c) > 0.0);
        }
    }

    #[test]
    fn square_with_hole_has_expected_area_and_constraints() {
        let outer = [p(0.0, 0.0), p(4.0, 0.0), p(4.0, 4.0), p(0.0, 4.0)];
        let hole = vec![p(1.0, 1.0), p(1.0, 3.0), p(3.0, 3.0), p(3.0, 1.0)];
        let t = triangulate_polygon(&outer, &[hole]).expect("cdt");
        assert!((area(&t.points, &t.triangles) - 12.0).abs() < 1e-12);
        assert_eq!(t.triangles.len(), 8);
    }

    #[test]
    fn collinear_boundary_points_and_nonconvex_polygon() {
        // A comb-shaped polygon with many collinear points on the base.
        let mut outer = Vec::new();
        for i in 0..=10 {
            outer.push(p(i as f64, 0.0));
        }
        outer.extend([p(10.0, 3.0), p(8.0, 3.0), p(8.0, 1.0), p(6.0, 1.0)]);
        outer.extend([p(6.0, 3.0), p(0.0, 3.0)]);
        let t = triangulate_polygon(&outer, &[]).expect("cdt");
        let expected = 10.0 * 3.0 - 2.0 * 2.0;
        assert!((area(&t.points, &t.triangles) - expected).abs() < 1e-12);
    }

    #[test]
    fn crossing_constraints_are_reported() {
        let mut cdt = Cdt::new(p(0.0, 0.0), p(1.0, 1.0)).expect("cdt");
        let a = cdt.insert_point(p(0.0, 0.0)).expect("a");
        let b = cdt.insert_point(p(1.0, 1.0)).expect("b");
        let c = cdt.insert_point(p(0.0, 1.0)).expect("c");
        let d = cdt.insert_point(p(1.0, 0.0)).expect("d");
        cdt.insert_constraint(a, b).expect("first");
        let e = cdt.insert_constraint(c, d).unwrap_err();
        assert_eq!(e.code(), "CDT_CONSTRAINTS_CROSS");
    }

    #[test]
    fn duplicate_points_are_reported() {
        let mut cdt = Cdt::new(p(0.0, 0.0), p(1.0, 1.0)).expect("cdt");
        cdt.insert_point(p(0.5, 0.5)).expect("a");
        let e = cdt.insert_point(p(0.5, 0.5)).unwrap_err();
        assert_eq!(e, CdtError::DuplicatePoint { existing: 0 });
    }

    #[test]
    fn open_boundary_leaks() {
        let mut cdt = Cdt::new(p(0.0, 0.0), p(1.0, 1.0)).expect("cdt");
        for q in [p(0.0, 0.0), p(1.0, 0.0), p(1.0, 1.0)] {
            cdt.insert_point(q).expect("pt");
        }
        cdt.insert_constraint(0, 1).expect("c");
        cdt.insert_constraint(1, 2).expect("c");
        let e = cdt.mark_domain(&[(0, 1), (1, 2)]).unwrap_err();
        assert_eq!(e, CdtError::DomainLeak);
    }

    #[test]
    fn steiner_points_stay_inside() {
        let sq = [p(0.0, 0.0), p(2.0, 0.0), p(2.0, 2.0), p(0.0, 2.0)];
        let mut cdt = Cdt::new(p(0.0, 0.0), p(2.0, 2.0)).expect("cdt");
        for q in sq {
            cdt.insert_point(q).expect("pt");
        }
        let segs = [(0, 1), (1, 2), (2, 3), (3, 0)];
        for (a, b) in segs {
            cdt.insert_constraint(a, b).expect("c");
        }
        cdt.mark_domain(&segs).expect("domain");
        assert_eq!(
            cdt.insert_steiner(p(3.0, 1.0)).expect("ok"),
            SteinerOutcome::Rejected
        );
        assert_eq!(
            cdt.insert_steiner(p(1.0, 0.0)).expect("ok"),
            SteinerOutcome::Rejected
        );
        assert!(matches!(
            cdt.insert_steiner(p(1.0, 1.0)).expect("ok"),
            SteinerOutcome::Inserted(4)
        ));
        let tris = cdt.triangles();
        assert_eq!(tris.len(), 4);
    }

    #[test]
    fn cocircular_grid_is_triangulated_consistently() {
        // A regular grid: every quad is cocircular (incircle == 0 ties).
        let mut outer = Vec::new();
        for i in 0..5 {
            outer.push(p(i as f64, 0.0));
        }
        for j in 1..5 {
            outer.push(p(4.0, j as f64));
        }
        for i in (0..4).rev() {
            outer.push(p(i as f64, 4.0));
        }
        for j in (1..4).rev() {
            outer.push(p(0.0, j as f64));
        }
        let mut cdt = Cdt::new(p(0.0, 0.0), p(4.0, 4.0)).expect("cdt");
        for q in &outer {
            cdt.insert_point(*q).expect("pt");
        }
        let n = outer.len() as u32;
        let segs: Vec<_> = (0..n).map(|k| (k, (k + 1) % n)).collect();
        for &(a, b) in &segs {
            cdt.insert_constraint(a, b).expect("c");
        }
        cdt.mark_domain(&segs).expect("domain");
        for i in 1..4 {
            for j in 1..4 {
                cdt.insert_steiner(p(i as f64, j as f64)).expect("steiner");
            }
        }
        let tris = cdt.triangles();
        assert_eq!(tris.len(), 32);
        let pts: Vec<Point2> = (0..cdt.vertex_count() as u32)
            .map(|v| cdt.point(v))
            .collect();
        assert!((area(&pts, &tris) - 16.0).abs() < 1e-12);
    }
}
