//! Face meshing in the face's `(u, v)` parameter domain.
//!
//! # Pipeline (per face)
//! 1. **Loops → lifted polylines.** Each loop becomes a closed polyline of edge samples
//!    in `(u, v)` (pcurve, or projection of the edge points when a coedge has no
//!    pcurve). Periodic coordinates are *unwrapped* so consecutive points are continuous;
//!    after one traversal the polyline ends at its start shifted by
//!    `(k_u·P_u, k_v·P_v)`: the **winding** `(k_u, k_v)` distinguishes contractible
//!    loops (0, 0) from loops that wrap around a periodic direction (±1). A loop passing
//!    through a **singular vertex** (a B-rep vertex at a pole/apex, where the incoming
//!    and outgoing parameters differ) gets a *jump chain* along the collapsed iso-line,
//!    in the direction that keeps the face on its left. Faces with `sense = false`
//!    have their loops reversed so the face always lies to the left in `(u, v)`.
//! 2. **Planar domain.** From the windings:
//!    - *disc with holes*: exactly one counter-clockwise contractible loop (holes are
//!      lifted by whole periods into it) — planes, B-splines, partial periodic faces;
//!    - *band* around a periodic direction: at most one `+1` loop (bottom), one `−1`
//!      loop (top), contractible clockwise holes. A missing bottom/top must be a
//!      surface singularity (sphere pole, cone apex): it becomes a **singular chain** of
//!      points along the collapsed iso-line that all map to one mesh vertex. The band is
//!      unwrapped by an internal, deterministic **cut** from a bottom vertex to a top
//!      vertex (validated with exact predicates against every boundary copy); the cut is
//!      pre-sampled and its two copies (`x` and `x + P`) share mesh vertices, so the
//!      wrap-around is stitched with no duplicated seam vertices. Torus faces bounded
//!      by loops winding in `v` use the same code on the rotated domain `(v, −u)`;
//!    - *full torus* (no loops, or only holes): the period rectangle with both cuts, all
//!      four sides sampled once and identified pairwise.
//! 3. **CDT** of the domain (boundary points, constrained segments, domain marked from
//!    the directed boundary) in working coordinates `(|S_u|·u, |S_v|·v)` so the
//!    Delaunay criterion sees roughly metric distances; on developable surfaces the
//!    generator direction is compressed ([`DEVELOPABLE_ASPECT`]) because deviation only
//!    depends on the step across generators.
//! 4. **Seeding** (curved faces): a staggered grid of interior points whose spacing
//!    comes from the surface curvature and the tolerances, kept only if inside the
//!    domain and away from the boundary.
//! 5. **Refinement** until every unconstrained edge meets the midpoint chordal test
//!    (`0.74·δ`), the normal-angle test and the length limit, every centroid is within
//!    `δ`, and every facet agrees in orientation with the surface normal. Edges ending
//!    at a singular vertex are evaluated along the iso-line into the singularity
//!    (meridian/generator), which gives correct fans and limit normals.
//! 6. **Output**: triangles whose corners collapse onto the same singular vertex are
//!    dropped (they are the degenerate part of a fan); any other repeated vertex is
//!    split during refinement, so the result is watertight across cuts.

use std::collections::BTreeMap;

use forge_core::geom::Surface;
use forge_core::predicates::orient2d;
use forge_core::topo::{Body, EdgeId, Face, Loop};
use forge_core::{Point2, Point3, math};

use crate::cdt::{Cdt, CdtError, SteinerOutcome};
use crate::error::MeshError;
use crate::surf::{MAX_ANGULAR_STEP, Sing, Surf, Tol, angle_between, mid2, virtual_pair};

/// Parameter-space distance (radians for analytic surfaces) below which two parameter
/// positions of the same singular vertex are considered equal (no jump chain).
pub(crate) const SINGULAR_JUMP_MIN: f64 = 1e-9;
/// Largest 3D gap (mm) between a loop's end and its start in parameter space before the
/// loop is reported as not closing (pcurve inconsistency or wrong winding).
pub(crate) const LOOP_CLOSURE_TOL: f64 = 1e-4;
/// Spacing of points along singular jump chains (radians).
const CHAIN_STEP: f64 = math::FRAC_PI_4 / 2.0;
/// Seeds closer than this fraction of the local spacing to the boundary are skipped.
const SEED_CLEARANCE: f64 = 0.5;
/// Seed grid spacing relative to the curvature-derived step: the staggered grid's
/// diagonals are ~1.12× the spacing, so seeding slightly denser than the step lets most
/// Delaunay edges pass the midpoint test without cascading refinement.
const SEED_SPACING: f64 = 0.85;
/// Compression of the Delaunay working metric along the straight generators of
/// developable surfaces (cylinder, cone). Their deviation depends only on the step across
/// generators, so long triangles along them are optimal; with an isotropic metric,
/// refinement around holes degenerates into an isotropic (≈20× denser) mesh. The gain
/// saturates around 16–32; 16 keeps slightly better minimum angles.
const DEVELOPABLE_ASPECT: f64 = 16.0;
/// Refinement budget per face.
const MAX_FACE_POINTS: usize = 2_000_000;
/// Bisection depth limit for cut and side sampling.
const MAX_SEGMENT_DEPTH: u32 = 40;

/// Samples of one edge: parameters and mesh vertex ids (`gids.len() == ts.len()`; for a
/// ring edge the last id equals the first).
#[derive(Clone, Debug)]
pub(crate) struct EdgeSamples {
    pub ts: Vec<f64>,
    pub gids: Vec<u32>,
}

/// Global vertex table under construction.
#[derive(Clone, Debug, Default)]
pub(crate) struct Global {
    pub pos: Vec<Point3>,
}

impl Global {
    pub fn add(&mut self, p: Point3) -> u32 {
        self.pos.push(p);
        (self.pos.len() - 1) as u32
    }
}

/// A point of a face's parametric triangulation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FPt {
    pub gid: u32,
    pub uv: [f64; 2],
    pub sing: Sing,
}

/// Result of meshing one face: the CDT vertices and triangles (local indices,
/// counter-clockwise in `(u, v)`, i.e. oriented along `S_u × S_v`).
#[derive(Clone, Debug)]
pub(crate) struct FaceOut {
    pub pts: Vec<FPt>,
    pub tris: Vec<[u32; 3]>,
}

struct LoopPoly {
    pts: Vec<FPt>,
    shift: [f64; 2],
    wind: [i32; 2],
}

/// Inputs for meshing one face.
pub(crate) struct FaceCtx<'a> {
    pub body: &'a Body,
    pub face: &'a Face,
    pub name: &'a str,
    pub samples: &'a BTreeMap<EdgeId, EdgeSamples>,
    pub tol: Tol,
}

impl FaceCtx<'_> {
    fn invalid(&self, what: &str) -> MeshError {
        MeshError::InvalidBody {
            detail: format!("face {}: {what}", self.name),
        }
    }
    fn loops_err(&self, reason: impl Into<String>) -> MeshError {
        MeshError::InvalidLoops {
            face: self.name.to_string(),
            reason: reason.into(),
        }
    }
    fn cdt_err(&self, e: CdtError) -> MeshError {
        MeshError::Triangulation {
            face: self.name.to_string(),
            source: e,
        }
    }
}

// ---------------------------------------------------------------------------------------
// Step 1: loops
// ---------------------------------------------------------------------------------------

/// Sign (±1) the `u` jump along a top/bottom singular line must have so the face stays
/// on the left (before orientation normalization, `sense` decides the side).
fn jump_sign(surf: &Surf, prev: Option<&FPt>, at: [f64; 2]) -> f64 {
    let top = prev.is_some_and(|p| p.uv[1] < at[1]);
    let s = if top { -1.0 } else { 1.0 };
    if surf.sense { s } else { -s }
}

/// Choose the whole-period shift of `start` (per coordinate) that continues from `from`;
/// at a singular `U` point the `u` shift follows the jump-direction rule.
fn continuation_shift(
    surf: &Surf,
    from: [f64; 2],
    start: [f64; 2],
    sing: Sing,
    sign: f64,
) -> [f64; 2] {
    let mut shift = [0.0; 2];
    for d in 0..2 {
        if let Some(p) = surf.per[d] {
            shift[d] = ((from[d] - start[d]) / p).round() * p;
        }
    }
    if sing == Sing::U
        && let Some(p) = surf.per[0]
    {
        let mut du = start[0] + shift[0] - from[0];
        if du.abs() > SINGULAR_JUMP_MIN {
            // Bring the jump into (0, P] (sign +) or [−P, 0) (sign −).
            if sign > 0.0 {
                while du <= 0.0 {
                    du += p;
                    shift[0] += p;
                }
                while du > p {
                    du -= p;
                    shift[0] -= p;
                }
            } else {
                while du >= 0.0 {
                    du -= p;
                    shift[0] -= p;
                }
                while du < -p {
                    du += p;
                    shift[0] += p;
                }
            }
        }
    }
    shift
}

/// Push a jump chain from `from` towards `to` (both parameter positions of the singular
/// vertex `gid`): `from` itself and the interior chain points (not `to`).
fn push_jump(pts: &mut Vec<FPt>, gid: u32, from: [f64; 2], to: [f64; 2], sing: Sing) {
    let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
    let d = (dx * dx + dy * dy).sqrt();
    if d <= SINGULAR_JUMP_MIN {
        return;
    }
    pts.push(FPt {
        gid,
        uv: from,
        sing,
    });
    let m = ((d / CHAIN_STEP).ceil() as usize).max(1);
    for k in 1..m {
        let s = k as f64 / m as f64;
        pts.push(FPt {
            gid,
            uv: [
                from[0] + (to[0] - from[0]) * s,
                from[1] + (to[1] - from[1]) * s,
            ],
            sing,
        });
    }
}

fn build_loop(ctx: &FaceCtx, surf: &Surf, li: usize, lp: &Loop) -> Result<LoopPoly, MeshError> {
    let body = ctx.body;
    let mut pts: Vec<FPt> = Vec::new();
    let mut prev_end: Option<(u32, [f64; 2])> = None;
    for &cid in &lp.coedges {
        let c = body
            .coedge(cid)
            .ok_or_else(|| ctx.invalid("stale coedge id"))?;
        let e = body
            .edge(c.edge)
            .ok_or_else(|| ctx.invalid("stale edge id"))?;
        let s = ctx
            .samples
            .get(&c.edge)
            .ok_or_else(|| ctx.invalid("edge without samples"))?;
        let n = s.ts.len();
        if n < 2 {
            return Err(ctx.invalid("edge with fewer than two samples"));
        }
        let order: Vec<usize> = if c.forward {
            (0..n).collect()
        } else {
            (0..n).rev().collect()
        };
        let mut uvs: Vec<[f64; 2]> = Vec::with_capacity(n);
        for &k in &order {
            let near = uvs.last().copied();
            uvs.push(surf.coedge_uv(c.pcurve.as_ref(), &e.curve, s.ts[k], near));
        }
        if c.pcurve.is_none() {
            // The first sample has no predecessor: take its irrelevant coordinate at a
            // singular point from the next sample (the limit along the curve).
            match surf.sing(uvs[0]) {
                Sing::U => uvs[0][0] = uvs[1][0],
                Sing::V => uvs[0][1] = uvs[1][1],
                Sing::No => {}
            }
        }
        if let Some((pg, puv)) = prev_end {
            let sing = match surf.sing(puv) {
                Sing::No => surf.sing(uvs[0]),
                s => s,
            };
            let sign = jump_sign(surf, pts.last(), puv);
            let shift = continuation_shift(surf, puv, uvs[0], sing, sign);
            for uv in &mut uvs {
                uv[0] += shift[0];
                uv[1] += shift[1];
            }
            if sing != Sing::No {
                push_jump(&mut pts, pg, puv, uvs[0], sing);
            }
        }
        for j in 0..n - 1 {
            pts.push(FPt {
                gid: s.gids[order[j]],
                uv: uvs[j],
                sing: surf.sing(uvs[j]),
            });
        }
        prev_end = Some((s.gids[order[n - 1]], uvs[n - 1]));
    }
    let (eg, euv) = prev_end.ok_or_else(|| ctx.loops_err("empty loop"))?;
    let first = *pts.first().ok_or_else(|| ctx.loops_err("empty loop"))?;
    if eg != first.gid {
        return Err(ctx.invalid("loop does not close on a vertex"));
    }
    let sing = match surf.sing(euv) {
        Sing::No => first.sing,
        s => s,
    };
    let sign = jump_sign(surf, pts.last(), euv);
    // The lifted polyline closes onto its start shifted by whole periods (`cont`): that
    // shift is the loop's winding.
    let cont = continuation_shift(surf, euv, first.uv, sing, sign);
    let closing = [first.uv[0] + cont[0], first.uv[1] + cont[1]];
    if sing != Sing::No {
        push_jump(&mut pts, eg, euv, closing, sing);
    } else {
        let gap = surf.eval(euv).distance(surf.eval(closing));
        if gap.is_nan() || gap > LOOP_CLOSURE_TOL {
            return Err(MeshError::LoopNotClosed {
                face: ctx.name.to_string(),
                loop_index: li,
                gap,
            });
        }
    }
    let mut wind = [0i32; 2];
    for d in 0..2 {
        if let Some(p) = surf.per[d] {
            wind[d] = (cont[d] / p).round() as i32;
        }
    }
    Ok(LoopPoly {
        pts,
        shift: cont,
        wind,
    })
}

/// Reverse a loop's traversal (winding and closing shift negate).
fn reverse_loop(l: &mut LoopPoly) {
    l.pts.reverse();
    l.shift = [-l.shift[0], -l.shift[1]];
    l.wind = [-l.wind[0], -l.wind[1]];
}

fn p2(uv: [f64; 2]) -> Point2 {
    Point2::new(uv[0], uv[1])
}

/// Orientation of a closed (winding-0) polyline: +1 counter-clockwise, −1 clockwise,
/// 0 degenerate. Exact at the lexicographically smallest vertex (always convex for a
/// simple polygon), shoelace sign as a fallback for collinear neighbours.
fn ring_orientation(pts: &[[f64; 2]]) -> i32 {
    let n = pts.len();
    if n < 3 {
        return 0;
    }
    let mut k = 0;
    for i in 1..n {
        let (a, b) = (pts[i], pts[k]);
        if a[0].total_cmp(&b[0]).then(a[1].total_cmp(&b[1])) == std::cmp::Ordering::Less {
            k = i;
        }
    }
    let o = orient2d(p2(pts[(k + n - 1) % n]), p2(pts[k]), p2(pts[(k + 1) % n]));
    if o > 0.0 {
        return 1;
    }
    if o < 0.0 {
        return -1;
    }
    let mut a = 0.0;
    for i in 0..n {
        let (p, q) = (pts[i], pts[(i + 1) % n]);
        a += p[0] * q[1] - p[1] * q[0];
    }
    if a > 0.0 {
        1
    } else if a < 0.0 {
        -1
    } else {
        0
    }
}

/// Exact winding-number point-in-polygon (points on the boundary count as outside).
fn point_in_ring(ring: &[[f64; 2]], q: [f64; 2]) -> bool {
    let n = ring.len();
    let mut wn = 0i32;
    let qp = p2(q);
    for i in 0..n {
        let (a, b) = (ring[i], ring[(i + 1) % n]);
        let o = orient2d(p2(a), p2(b), qp);
        if o == 0.0
            && q[0] >= a[0].min(b[0])
            && q[0] <= a[0].max(b[0])
            && q[1] >= a[1].min(b[1])
            && q[1] <= a[1].max(b[1])
        {
            return false;
        }
        if a[1] <= q[1] {
            if b[1] > q[1] && o > 0.0 {
                wn += 1;
            }
        } else if b[1] <= q[1] && o < 0.0 {
            wn -= 1;
        }
    }
    wn != 0
}

// ---------------------------------------------------------------------------------------
// Step 2: planar domain
// ---------------------------------------------------------------------------------------

/// A planar domain: rings of points, the first counter-clockwise (outer), the others
/// clockwise (holes); the face lies to the left of every ring.
struct Domain {
    rings: Vec<Vec<FPt>>,
    /// `true` if working coordinates use the rotated domain `(v, −u)`.
    swap: bool,
}

fn dom(swap: bool, uv: [f64; 2]) -> [f64; 2] {
    if swap { [uv[1], -uv[0]] } else { uv }
}

fn shifted(p: FPt, s: [f64; 2]) -> FPt {
    FPt {
        uv: [p.uv[0] + s[0], p.uv[1] + s[1]],
        ..p
    }
}

/// Lift a hole by whole periods so its first point lies inside `outer` (in domain
/// coordinates).
fn lift_hole(
    ctx: &FaceCtx,
    surf: &Surf,
    swap: bool,
    outer: &[FPt],
    hole: &[FPt],
    extra: &[[f64; 2]],
) -> Result<Vec<FPt>, MeshError> {
    let ring: Vec<[f64; 2]> = outer.iter().map(|p| dom(swap, p.uv)).collect();
    let mut cands: Vec<[f64; 2]> = vec![[0.0, 0.0]];
    let pu = surf.per[0].unwrap_or(0.0);
    let pv = surf.per[1].unwrap_or(0.0);
    for r in 1..=2i32 {
        for a in -r..=r {
            for b in -r..=r {
                if a.abs().max(b.abs()) != r {
                    continue;
                }
                if (a != 0 && pu == 0.0) || (b != 0 && pv == 0.0) {
                    continue;
                }
                cands.push([f64::from(a) * pu, f64::from(b) * pv]);
            }
        }
    }
    cands.extend_from_slice(extra);
    // Test a point of the hole that is not a singular chain point.
    let probe = hole
        .iter()
        .find(|p| p.sing == Sing::No)
        .copied()
        .unwrap_or(hole[0]);
    for s in cands {
        let q = dom(swap, [probe.uv[0] + s[0], probe.uv[1] + s[1]]);
        if point_in_ring(&ring, q) {
            return Ok(hole.iter().map(|p| shifted(*p, s)).collect());
        }
    }
    Err(ctx.loops_err("a hole loop lies outside the outer loop"))
}

/// Geometric singular end of a u-periodic surface (sphere pole, cone apex, spindle-torus
/// axis point): `(v, position)`.
fn singular_end(surf: &Surf, top: bool, other_v: Option<(f64, f64)>) -> Option<(f64, Point3)> {
    match surf.s {
        Surface::Sphere(s) => {
            let v = if top {
                math::FRAC_PI_2
            } else {
                -math::FRAC_PI_2
            };
            let z = s.frame().z() * s.radius();
            let pos = if top {
                s.frame().origin() + z
            } else {
                s.frame().origin() - z
            };
            Some((v, pos))
        }
        Surface::Cone(c) => {
            let va = c.apex_v();
            let (lo, hi) = other_v?;
            let ok = if top { hi < va } else { lo > va };
            ok.then(|| (va, c.apex()))
        }
        // A spindle-torus patch ends at its two axis points (like sphere poles).
        Surface::Torus(t) => {
            let (v0, v1) = t.spindle_v_range()?;
            let v = if top { v1 } else { v0 };
            let pos = t.frame().origin() + t.frame().z() * (t.minor() * math::sin(v));
            Some((v, pos))
        }
        _ => None,
    }
}

/// Adaptive samples (interior parameter points) along the straight parameter segment
/// `a → b` meeting the midpoint, angle and length tests.
fn sample_segment(
    surf: &Surf,
    tol: &Tol,
    a: (FPt, Point3),
    b: (FPt, Point3),
    max_step: Option<f64>,
) -> Option<Vec<[f64; 2]>> {
    let (fa, pa) = a;
    let (fb, pb) = b;
    let at = |s: f64| -> [f64; 2] {
        [
            fa.uv[0] + (fb.uv[0] - fa.uv[0]) * s,
            fa.uv[1] + (fb.uv[1] - fa.uv[1]) * s,
        ]
    };
    // Parameters 0 and 1 are exact endpoints (bisection only produces interior values).
    let pos = |s: f64| -> Point3 {
        if s <= 0.0 {
            pa
        } else if s >= 1.0 {
            pb
        } else {
            surf.eval(at(s))
        }
    };
    let sing = |s: f64| -> Sing {
        if s <= 0.0 {
            fa.sing
        } else if s >= 1.0 {
            fb.sing
        } else {
            Sing::No
        }
    };
    let ok = |s0: f64, s1: f64| -> bool {
        let (u0, u1) = (at(s0), at(s1));
        let (dx, dy) = (u1[0] - u0[0], u1[1] - u0[1]);
        if let Some(m) = max_step
            && (dx * dx + dy * dy).sqrt() > m
        {
            return false;
        }
        let (p0, p1) = (pos(s0), pos(s1));
        let (v0, v1) = virtual_pair(u0, sing(s0), u1, sing(s1));
        let dev = surf.eval(mid2(v0, v1)).distance((p0 + p1) * 0.5);
        let ang = match (surf.normal_param(v0), surf.normal_param(v1)) {
            (Some(n0), Some(n1)) => angle_between(n0, n1),
            _ => 0.0,
        };
        tol.badness(dev, ang, p0.distance(p1)) <= 1.0
    };
    fn rec(
        ok: &dyn Fn(f64, f64) -> bool,
        s0: f64,
        s1: f64,
        depth: u32,
        out: &mut Vec<f64>,
    ) -> bool {
        if ok(s0, s1) {
            out.push(s1);
            return true;
        }
        let m = 0.5 * (s0 + s1);
        if depth >= MAX_SEGMENT_DEPTH || !(m > s0 && m < s1) {
            return false;
        }
        rec(ok, s0, m, depth + 1, out) && rec(ok, m, s1, depth + 1, out)
    }
    let mut out = Vec::new();
    if !rec(&ok, 0.0, 1.0, 0, &mut out) {
        return None;
    }
    out.pop(); // s = 1
    Some(out.into_iter().map(at).collect())
}

/// Does segment `ab` meet segment `cd` anywhere other than at `a` or `b`?
fn seg_conflict(a: Point2, b: Point2, c: Point2, d: Point2) -> bool {
    let o1 = orient2d(a, b, c);
    let o2 = orient2d(a, b, d);
    let o3 = orient2d(c, d, a);
    let o4 = orient2d(c, d, b);
    let proper = ((o1 > 0.0 && o2 < 0.0) || (o1 < 0.0 && o2 > 0.0))
        && ((o3 > 0.0 && o4 < 0.0) || (o3 < 0.0 && o4 > 0.0));
    if proper {
        return true;
    }
    let within = |p: Point2, q: Point2, r: Point2| {
        r.x >= p.x.min(q.x) && r.x <= p.x.max(q.x) && r.y >= p.y.min(q.y) && r.y <= p.y.max(q.y)
    };
    let is_end = |r: Point2| r == a || r == b;
    (o1 == 0.0 && within(a, b, c) && !is_end(c))
        || (o2 == 0.0 && within(a, b, d) && !is_end(d))
        || (o3 == 0.0 && within(c, d, a) && !is_end(a) && a != c && a != d)
        || (o4 == 0.0 && within(c, d, b) && !is_end(b) && b != c && b != d)
}

/// `true` if the direction from `v` to `q` points into the face at boundary vertex `v`
/// (face on the left of `prev → v → next`).
fn in_wedge(prev: Point2, v: Point2, next: Point2, q: Point2) -> bool {
    let turn = orient2d(prev, v, next);
    let l0 = orient2d(prev, v, q) > 0.0;
    let l1 = orient2d(v, next, q) > 0.0;
    if turn > 0.0 {
        l0 && l1
    } else if turn < 0.0 {
        l0 || l1
    } else {
        l1
    }
}

/// A point of a loop: (loop index, point index, lift applied).
type LoopRef = (usize, usize, [f64; 2]);

/// One side of a band: a wrapping loop or a singular line.
#[derive(Clone, Copy)]
enum Side {
    Loop(usize),
    Sing { v: f64, gid: u32 },
}

/// Build the band domain (see the module docs).
#[allow(clippy::too_many_arguments)]
fn band_domain(
    ctx: &FaceCtx,
    surf: &Surf,
    loops: &[LoopPoly],
    axis: usize,
    bottom: Option<usize>,
    top: Option<usize>,
    holes: &[usize],
    global: &mut Global,
) -> Result<Domain, MeshError> {
    let swap = axis == 1;
    let p_x = surf.per[axis].ok_or_else(|| ctx.loops_err("band on a non-periodic direction"))?;
    let sx: [f64; 2] = if swap { [0.0, p_x] } else { [p_x, 0.0] };
    let y_per: Option<[f64; 2]> =
        surf.per[1 - axis].map(|q| if swap { [-q, 0.0] } else { [0.0, q] });
    let d = |uv: [f64; 2]| -> Point2 { p2(dom(swap, uv)) };
    let v_range = |li: usize| -> (f64, f64) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for p in &loops[li].pts {
            lo = lo.min(p.uv[1]);
            hi = hi.max(p.uv[1]);
        }
        (lo, hi)
    };

    // Resolve the sides (singular ends only for u-periodic bands).
    let mut side =
        |is_top: bool, lp: Option<usize>, other: Option<usize>| -> Result<Side, MeshError> {
            if let Some(li) = lp {
                return Ok(Side::Loop(li));
            }
            if swap {
                return Err(MeshError::UnboundedFace {
                    face: ctx.name.to_string(),
                    surface: surf.s.kind_name(),
                });
            }
            match singular_end(surf, is_top, other.map(v_range)) {
                Some((v, pos)) => Ok(Side::Sing {
                    v,
                    gid: global.add(pos),
                }),
                None => Err(MeshError::UnboundedFace {
                    face: ctx.name.to_string(),
                    surface: surf.s.kind_name(),
                }),
            }
        };
    let bside = side(false, bottom, top)?;
    let tside = side(true, top, bottom)?;
    if let (Some(b), Some(t)) = (bottom, top) {
        let mean = |li: usize| {
            let l = &loops[li];
            l.pts.iter().map(|p| dom(swap, p.uv)[1]).sum::<f64>() / l.pts.len() as f64
        };
        if mean(b) >= mean(t) {
            return Err(ctx.loops_err("bottom and top loops of a periodic band are out of order"));
        }
    }

    // Constraint segments that a cut must avoid (domain coordinates).
    let mut obstacles: Vec<(Point2, Point2)> = Vec::new();
    let mut add_ring = |pts: &[FPt], closing: [f64; 2], shifts: &[[f64; 2]]| {
        let n = pts.len();
        for s in shifts {
            for k in 0..n {
                let a = shifted(pts[k], *s).uv;
                let b = if k + 1 < n {
                    shifted(pts[k + 1], *s).uv
                } else {
                    [
                        pts[0].uv[0] + closing[0] + s[0],
                        pts[0].uv[1] + closing[1] + s[1],
                    ]
                };
                obstacles.push((d(a), d(b)));
            }
        }
    };
    let xs: Vec<[f64; 2]> = (-2..=2)
        .map(|k| [sx[0] * f64::from(k), sx[1] * f64::from(k)])
        .collect();
    let mut all_shifts = xs.clone();
    if let Some(ys) = y_per {
        for k in [-1.0, 1.0] {
            for s in &xs {
                all_shifts.push([s[0] + ys[0] * k, s[1] + ys[1] * k]);
            }
        }
    }
    for side in [bside, tside] {
        if let Side::Loop(li) = side {
            add_ring(&loops[li].pts, loops[li].shift, &xs);
        }
    }
    for &h in holes {
        add_ring(&loops[h].pts, [0.0, 0.0], &all_shifts);
    }

    // Candidate cuts.
    let loop_pt = |li: usize, i: usize, lift: [f64; 2]| -> FPt { shifted(loops[li].pts[i], lift) };
    let neighbours = |li: usize, i: usize, lift: [f64; 2]| -> (Point2, Point2) {
        let l = &loops[li];
        let n = l.pts.len();
        let prev = if i == 0 {
            shifted(l.pts[n - 1], [lift[0] - l.shift[0], lift[1] - l.shift[1]])
        } else {
            shifted(l.pts[i - 1], lift)
        };
        let next = if i + 1 == n {
            shifted(l.pts[0], [lift[0] + l.shift[0], lift[1] + l.shift[1]])
        } else {
            shifted(l.pts[i + 1], lift)
        };
        (d(prev.uv), d(next.uv))
    };
    // Nearest lift (multiple of sx) bringing `uv` next to x = `x`.
    let lift_to = |uv: [f64; 2], x: f64| -> [f64; 2] {
        let k = ((x - dom(swap, uv)[0]) / p_x).round();
        [sx[0] * k, sx[1] * k]
    };
    let sing_pt = |v: f64, x: f64, gid: u32| -> FPt {
        // Only u-periodic bands have singular sides (no swap): uv = (x, v).
        FPt {
            gid,
            uv: [x, v],
            sing: Sing::U,
        }
    };
    let valid =
        |b: &FPt, bn: Option<(Point2, Point2)>, t: &FPt, tn: Option<(Point2, Point2)>| -> bool {
            let (pb, pt) = (d(b.uv), d(t.uv));
            if pt.y.is_nan() || pt.y <= pb.y {
                return false;
            }
            if let Some((prev, next)) = bn
                && !in_wedge(prev, pb, next, pt)
            {
                return false;
            }
            if let Some((prev, next)) = tn
                && !in_wedge(prev, pt, next, pb)
            {
                return false;
            }
            !obstacles.iter().any(|&(c, e)| seg_conflict(pb, pt, c, e))
        };

    // (b, t, bottom loop ref, top loop ref); a loop ref is (loop, index, lift).
    let mut chosen: Option<(FPt, FPt, Option<LoopRef>, Option<LoopRef>)> = None;
    match (bside, tside) {
        (Side::Loop(bl), tside) => {
            'outer: for i in 0..loops[bl].pts.len() {
                let b = loop_pt(bl, i, [0.0, 0.0]);
                let bn = Some(neighbours(bl, i, [0.0, 0.0]));
                let bx = dom(swap, b.uv)[0];
                match tside {
                    Side::Loop(tl) => {
                        let mut c: Vec<(f64, usize, [f64; 2])> = (0..loops[tl].pts.len())
                            .map(|j| {
                                let lift = lift_to(loops[tl].pts[j].uv, bx);
                                let t = loop_pt(tl, j, lift);
                                ((dom(swap, t.uv)[0] - bx).abs(), j, lift)
                            })
                            .collect();
                        c.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
                        for &(_, j, lift) in c.iter().take(4) {
                            let t = loop_pt(tl, j, lift);
                            let tn = Some(neighbours(tl, j, lift));
                            if valid(&b, bn, &t, tn) {
                                chosen =
                                    Some((b, t, Some((bl, i, [0.0, 0.0])), Some((tl, j, lift))));
                                break 'outer;
                            }
                        }
                    }
                    Side::Sing { v, gid } => {
                        let t = sing_pt(v, b.uv[0], gid);
                        if valid(&b, bn, &t, None) {
                            chosen = Some((b, t, Some((bl, i, [0.0, 0.0])), None));
                            break 'outer;
                        }
                    }
                }
            }
        }
        (Side::Sing { v, gid }, Side::Loop(tl)) => {
            for j in 0..loops[tl].pts.len() {
                let t = loop_pt(tl, j, [0.0, 0.0]);
                let tn = Some(neighbours(tl, j, [0.0, 0.0]));
                let b = sing_pt(v, t.uv[0], gid);
                if valid(&b, None, &t, tn) {
                    chosen = Some((b, t, None, Some((tl, j, [0.0, 0.0]))));
                    break;
                }
            }
        }
        (Side::Sing { v: vb, gid: gb }, Side::Sing { v: vt, gid: gt }) => {
            for k in [0u32, 8, 4, 12, 2, 6, 10, 14, 1, 3, 5, 7, 9, 11, 13, 15] {
                let x = p_x * f64::from(k) / 16.0;
                let b = sing_pt(vb, x, gb);
                let t = sing_pt(vt, x, gt);
                if valid(&b, None, &t, None) {
                    chosen = Some((b, t, None, None));
                    break;
                }
            }
        }
    }
    let (b, t, bref, tref) = chosen.ok_or_else(|| MeshError::PeriodicCutNotFound {
        face: ctx.name.to_string(),
    })?;

    // Sample the cut; its interior points are new mesh vertices shared by both copies.
    let pos_of = |f: &FPt, global: &Global| global.pos[f.gid as usize];
    let cut_uv = sample_segment(
        surf,
        &ctx.tol,
        (b, pos_of(&b, global)),
        (t, pos_of(&t, global)),
        None,
    )
    .ok_or_else(|| MeshError::RefinementLimit {
        face: ctx.name.to_string(),
        points: 0,
        deviation: f64::NAN,
        requested: ctx.tol.dev,
    })?;
    let cut: Vec<FPt> = cut_uv
        .into_iter()
        .map(|uv| FPt {
            gid: global.add(surf.eval(uv)),
            uv,
            sing: Sing::No,
        })
        .collect();

    // Singular chain abscissae: aligned with the opposite loop when there is one.
    let chain_xs = |x0: f64, other: Option<LoopRef>| -> Vec<f64> {
        let mut xs: Vec<f64> = match other {
            Some((li, _, lift)) => loops[li]
                .pts
                .iter()
                .map(|p| {
                    let x = dom(swap, shifted(*p, lift).uv)[0];
                    let k = ((x - x0) / p_x).floor();
                    x - k * p_x
                })
                .filter(|&x| x > x0 && x < x0 + p_x)
                .collect(),
            None => {
                let n = ((p_x / CHAIN_STEP).ceil() as usize).max(4);
                (1..n).map(|k| x0 + p_x * (k as f64 / n as f64)).collect()
            }
        };
        xs.sort_by(f64::total_cmp);
        xs.dedup();
        xs
    };

    let mut ring: Vec<FPt> = Vec::new();
    // Bottom, one period from b.
    match bside {
        Side::Loop(li) => {
            let (_, i, lift) = bref.ok_or_else(|| ctx.loops_err("cut bookkeeping"))?;
            let l = &loops[li];
            let m = l.pts.len();
            for k in 0..m {
                let idx = (i + k) % m;
                let wrap = ((i + k) / m) as f64;
                ring.push(shifted(
                    l.pts[idx],
                    [lift[0] + wrap * l.shift[0], lift[1] + wrap * l.shift[1]],
                ));
            }
        }
        Side::Sing { v, gid } => {
            ring.push(b);
            for x in chain_xs(b.uv[0], tref) {
                ring.push(sing_pt(v, x, gid));
            }
        }
    }
    // Right copy of the cut.
    ring.push(shifted(b, sx));
    for c in &cut {
        ring.push(shifted(*c, sx));
    }
    // Top, one period from t + sx (running towards −x).
    match tside {
        Side::Loop(li) => {
            let (_, j, lift) = tref.ok_or_else(|| ctx.loops_err("cut bookkeeping"))?;
            let l = &loops[li];
            let m = l.pts.len();
            for k in 0..m {
                let idx = (j + k) % m;
                let wrap = ((j + k) / m) as f64;
                ring.push(shifted(
                    l.pts[idx],
                    [
                        lift[0] + sx[0] + wrap * l.shift[0],
                        lift[1] + sx[1] + wrap * l.shift[1],
                    ],
                ));
            }
        }
        Side::Sing { v, gid } => {
            ring.push(shifted(t, sx));
            let mut xs = chain_xs(t.uv[0], bref);
            xs.reverse();
            for x in xs {
                ring.push(sing_pt(v, x, gid));
            }
        }
    }
    // Left copy of the cut, downwards.
    ring.push(t);
    for c in cut.iter().rev() {
        ring.push(*c);
    }

    let mut rings = vec![ring];
    let extra: Vec<[f64; 2]> = all_shifts.clone();
    for &h in holes {
        let lifted = lift_hole(ctx, surf, swap, &rings[0], &loops[h].pts, &extra)?;
        rings.push(lifted);
    }
    Ok(Domain { rings, swap })
}

/// The full-torus domain: the period rectangle with both internal cuts.
fn torus_domain(
    ctx: &FaceCtx,
    surf: &Surf,
    loops: &[LoopPoly],
    holes: &[usize],
    global: &mut Global,
) -> Result<Domain, MeshError> {
    let (pu, pv) = match surf.per {
        [Some(a), Some(b)] => (a, b),
        _ => return Err(ctx.loops_err("full-period domain on a non-torus")),
    };
    // Cut positions avoiding every hole's parameter extent (holes are small, contractible).
    let extents = |d: usize, p: f64| -> Vec<(f64, f64)> {
        holes
            .iter()
            .map(|&h| {
                let mut lo = f64::INFINITY;
                let mut hi = f64::NEG_INFINITY;
                for q in &loops[h].pts {
                    lo = lo.min(q.uv[d]);
                    hi = hi.max(q.uv[d]);
                }
                let k = (lo / p).floor();
                (lo - k * p, hi - k * p)
            })
            .collect()
    };
    let pick = |p: f64, ext: &[(f64, f64)], base: f64| -> Option<f64> {
        (0..32u32)
            .map(|k| {
                // Deterministic bisection-order candidates.
                let r = k.reverse_bits() as f64 / 4_294_967_296.0;
                base + p * r
            })
            .find(|&c| {
                ext.iter().all(|&(lo, hi)| {
                    let cc = c - (c / p).floor() * p;
                    let inside = |x: f64| x >= lo && x <= hi;
                    !(inside(cc) || inside(cc + p))
                })
            })
    };
    let uc = pick(pu, &extents(0, pu), 0.0).ok_or_else(|| MeshError::PeriodicCutNotFound {
        face: ctx.name.to_string(),
    })?;
    let vc = pick(pv, &extents(1, pv), math::PI).ok_or_else(|| MeshError::PeriodicCutNotFound {
        face: ctx.name.to_string(),
    })?;
    let corner_uv = [uc, vc];
    let corner_sing = surf.sing(corner_uv);
    let corner = FPt {
        gid: global.add(surf.eval(corner_uv)),
        uv: corner_uv,
        sing: corner_sing,
    };
    let side = |to: [f64; 2], global: &mut Global| -> Result<Vec<FPt>, MeshError> {
        let end = FPt {
            gid: corner.gid,
            uv: to,
            sing: corner_sing,
        };
        let p = global.pos[corner.gid as usize];
        let uvs = sample_segment(
            surf,
            &ctx.tol,
            (corner, p),
            (end, p),
            Some(MAX_ANGULAR_STEP),
        )
        .ok_or_else(|| MeshError::RefinementLimit {
            face: ctx.name.to_string(),
            points: 0,
            deviation: f64::NAN,
            requested: ctx.tol.dev,
        })?;
        // A collapsed side (horn torus inner equator) maps to one vertex.
        let collapsed = uvs.iter().all(|&uv| surf.sing(uv) != Sing::No);
        let shared = if collapsed { Some(corner.gid) } else { None };
        Ok(uvs
            .into_iter()
            .map(|uv| FPt {
                gid: shared.unwrap_or_else(|| global.add(surf.eval(uv))),
                uv,
                sing: surf.sing(uv),
            })
            .collect())
    };
    let bottom = side([uc + pu, vc], global)?;
    let left = side([uc, vc + pv], global)?;
    let mut ring = vec![corner];
    ring.extend(bottom.iter().copied());
    ring.push(shifted(corner, [pu, 0.0]));
    ring.extend(left.iter().map(|p| shifted(*p, [pu, 0.0])));
    ring.push(shifted(corner, [pu, pv]));
    ring.extend(bottom.iter().rev().map(|p| shifted(*p, [0.0, pv])));
    ring.push(shifted(corner, [0.0, pv]));
    ring.extend(left.iter().rev().copied());
    let mut rings = vec![ring];
    for &h in holes {
        let lifted = lift_hole(ctx, surf, false, &rings[0], &loops[h].pts, &[])?;
        rings.push(lifted);
    }
    Ok(Domain { rings, swap: false })
}

fn build_domain(ctx: &FaceCtx, surf: &Surf, global: &mut Global) -> Result<Domain, MeshError> {
    let mut loops = Vec::with_capacity(ctx.face.loops.len());
    for (li, &lid) in ctx.face.loops.iter().enumerate() {
        let lp = ctx
            .body
            .loop_(lid)
            .ok_or_else(|| ctx.invalid("stale loop id"))?;
        loops.push(build_loop(ctx, surf, li, lp)?);
    }
    if !ctx.face.sense {
        for l in &mut loops {
            reverse_loop(l);
        }
    }
    let wrapping: Vec<usize> = (0..loops.len())
        .filter(|&i| loops[i].wind != [0, 0])
        .collect();
    let contractible: Vec<usize> = (0..loops.len())
        .filter(|&i| loops[i].wind == [0, 0])
        .collect();
    let orient: Vec<i32> = contractible
        .iter()
        .map(|&i| ring_orientation(&loops[i].pts.iter().map(|p| p.uv).collect::<Vec<_>>()))
        .collect();
    if orient.contains(&0) {
        return Err(ctx.loops_err("a loop encloses zero area in parameter space"));
    }
    let ccw: Vec<usize> = contractible
        .iter()
        .zip(&orient)
        .filter(|(_, o)| **o > 0)
        .map(|(i, _)| *i)
        .collect();
    let cw: Vec<usize> = contractible
        .iter()
        .zip(&orient)
        .filter(|(_, o)| **o < 0)
        .map(|(i, _)| *i)
        .collect();

    if wrapping.is_empty() {
        return match ccw.len() {
            1 => {
                let outer = loops[ccw[0]].pts.clone();
                let mut rings = vec![outer];
                for &h in &cw {
                    let lifted = lift_hole(ctx, surf, false, &rings[0], &loops[h].pts, &[])?;
                    rings.push(lifted);
                }
                Ok(Domain { rings, swap: false })
            }
            0 => match surf.per {
                [Some(_), None] => band_domain(ctx, surf, &loops, 0, None, None, &cw, global),
                [Some(_), Some(_)] => torus_domain(ctx, surf, &loops, &cw, global),
                _ => {
                    if loops.is_empty() {
                        Err(MeshError::UnboundedFace {
                            face: ctx.name.to_string(),
                            surface: surf.s.kind_name(),
                        })
                    } else {
                        Err(ctx.loops_err("no counter-clockwise outer loop"))
                    }
                }
            },
            n => Err(ctx.loops_err(format!("{n} outer loops (expected one)"))),
        };
    }
    for &i in &wrapping {
        let w = loops[i].wind;
        if w[0].abs() > 1 || w[1].abs() > 1 || (w[0] != 0 && w[1] != 0) {
            return Err(ctx.loops_err(format!(
                "a loop winds ({}, {}) times around the periodic directions",
                w[0], w[1]
            )));
        }
    }
    let axis = if wrapping.iter().all(|&i| loops[i].wind[1] == 0) {
        0
    } else if wrapping.iter().all(|&i| loops[i].wind[0] == 0) {
        1
    } else {
        return Err(ctx.loops_err("loops wrap around different periodic directions"));
    };
    if !ccw.is_empty() {
        return Err(ctx.loops_err("a contractible outer loop together with wrapping loops"));
    }
    let plus: Vec<usize> = wrapping
        .iter()
        .copied()
        .filter(|&i| loops[i].wind[axis] > 0)
        .collect();
    let minus: Vec<usize> = wrapping
        .iter()
        .copied()
        .filter(|&i| loops[i].wind[axis] < 0)
        .collect();
    if plus.len() > 1 || minus.len() > 1 {
        return Err(ctx.loops_err("more than one wrapping loop on the same side of a band"));
    }
    band_domain(
        ctx,
        surf,
        &loops,
        axis,
        plus.first().copied(),
        minus.first().copied(),
        &cw,
        global,
    )
}

// ---------------------------------------------------------------------------------------
// Step 3-5: CDT, seeding, refinement
// ---------------------------------------------------------------------------------------

/// Seed lattice spacing in parameter units: uniform columns `du` and rows `dv` (`None`:
/// no interior rows needed, e.g. a cylinder band is fully described by its boundary).
///
/// Columns are uniform even where a surface of revolution narrows (towards poles or the
/// inner equator of a torus): the CDT runs in a *linear* working metric, and a lattice
/// that is regular in that metric gives well-connected Delaunay triangles, whereas
/// latitude-dependent column counts produce long 3D edges that refinement must then fix.
struct Steps {
    du: f64,
    dv: Option<f64>,
}

impl Steps {
    fn new(surf: &Surf, tol: &Tol, uv_box: ([f64; 2], [f64; 2])) -> Self {
        let (lo, hi) = uv_box;
        let len_rows = |slope: f64| tol.len.map(|l| 0.9 * l * slope);
        match surf.s {
            Surface::Plane(_) => Steps {
                du: tol.len.map_or(f64::INFINITY, |l| 0.9 * l),
                dv: len_rows(1.0),
            },
            Surface::Cylinder(c) => Steps {
                du: tol.circle_step(c.radius()),
                dv: len_rows(1.0),
            },
            Surface::Cone(c) => {
                let rmax = c.radius_at(lo[1]).abs().max(c.radius_at(hi[1]).abs());
                Steps {
                    du: tol.circle_step(rmax),
                    dv: len_rows(math::cos(c.half_angle())),
                }
            }
            Surface::Sphere(s) => {
                let d = tol.circle_step(s.radius());
                Steps { du: d, dv: Some(d) }
            }
            Surface::Torus(t) => Steps {
                du: tol.circle_step(t.major() + t.minor()),
                dv: Some(tol.circle_step(t.minor())),
            },
            // u is the angle about the axis at radius v (the rulings are straight): the
            // circle step of the largest radius in the box, rows only for the length limit
            // (a ruling is `√(1 + k²)` long per unit of v).
            Surface::Helicoid(h) => Steps {
                du: tol.circle_step(lo[1].abs().max(hi[1].abs())),
                dv: len_rows(1.0 / math::hypot(1.0, h.slope())),
            },
            Surface::BSpline(_) => {
                let (mut muu, mut mvv, mut mu, mut mv) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
                for i in 0..7 {
                    for j in 0..7 {
                        let u = lo[0] + (hi[0] - lo[0]) * (i as f64 / 6.0);
                        let v = lo[1] + (hi[1] - lo[1]) * (j as f64 / 6.0);
                        let d = surf.s.derivs2(u, v);
                        muu = muu.max(d.duu.norm());
                        mvv = mvv.max(d.dvv.norm());
                        mu = mu.max(d.du.norm());
                        mv = mv.max(d.dv.norm());
                    }
                }
                // Second-order chord deviation |S''|·h²/8 ≤ dev_mid, plus the length limit.
                let step = |m2: f64, m1: f64, range: f64| {
                    let mut s = if m2 > 0.0 {
                        (8.0 * tol.dev_mid / m2).sqrt()
                    } else {
                        range
                    };
                    if let Some(l) = tol.len
                        && m1 > 0.0
                    {
                        s = s.min(0.9 * l / m1);
                    }
                    s.min(range.max(f64::MIN_POSITIVE))
                };
                Steps {
                    du: step(muu, mu, hi[0] - lo[0]),
                    dv: Some(step(mvv, mv, hi[1] - lo[1])),
                }
            }
        }
    }
}

/// Uniform bucket grid over constrained segments (working coordinates) for the seed
/// clearance filter. Floating-point distances are fine here: this only decides where
/// optional seed points go, never topology.
struct SegGrid {
    origin: Point2,
    cell: f64,
    nx: usize,
    ny: usize,
    cells: Vec<Vec<u32>>,
    segs: Vec<(Point2, Point2)>,
}

impl SegGrid {
    fn new(segs: Vec<(Point2, Point2)>, min: Point2, max: Point2, cell: f64) -> Self {
        let w = (max.x - min.x).max(0.0);
        let h = (max.y - min.y).max(0.0);
        let mut cell = cell.max(f64::MIN_POSITIVE);
        while (w / cell).ceil() * (h / cell).ceil() > 1.0e6 {
            cell *= 2.0;
        }
        let nx = ((w / cell).ceil() as usize).max(1);
        let ny = ((h / cell).ceil() as usize).max(1);
        let mut g = SegGrid {
            origin: min,
            cell,
            nx,
            ny,
            cells: vec![Vec::new(); nx * ny],
            segs,
        };
        for (k, &(a, b)) in g.segs.iter().enumerate() {
            let (i0, j0) = g.idx(Point2::new(a.x.min(b.x), a.y.min(b.y)));
            let (i1, j1) = g.idx(Point2::new(a.x.max(b.x), a.y.max(b.y)));
            for j in j0..=j1 {
                for i in i0..=i1 {
                    g.cells[j * nx + i].push(k as u32);
                }
            }
        }
        g
    }
    fn idx(&self, p: Point2) -> (usize, usize) {
        let i = ((p.x - self.origin.x) / self.cell).floor();
        let j = ((p.y - self.origin.y) / self.cell).floor();
        let cl = |v: f64, n: usize| -> usize {
            if v.is_nan() || v < 0.0 {
                0
            } else {
                (v as usize).min(n - 1)
            }
        };
        (cl(i, self.nx), cl(j, self.ny))
    }
    /// `true` if some segment is closer than `r` to `p`.
    fn near(&self, p: Point2, r: f64) -> bool {
        let (i0, j0) = self.idx(Point2::new(p.x - r, p.y - r));
        let (i1, j1) = self.idx(Point2::new(p.x + r, p.y + r));
        for j in j0..=j1 {
            for i in i0..=i1 {
                for &k in &self.cells[j * self.nx + i] {
                    let (a, b) = self.segs[k as usize];
                    let ab = b - a;
                    let l2 = ab.norm_squared();
                    let t = if l2 > 0.0 {
                        ((p - a).dot(ab) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    if (a + ab * t).distance(p) < r {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// Split request produced by the triangle assessment.
enum Assess {
    Good,
    /// Degenerate collapse onto a singular vertex (dropped at output).
    Collapsed,
    /// Split at these parameters; `badness` for error reporting.
    Split {
        uvs: Vec<[f64; 2]>,
        badness: f64,
    },
}

struct Mesher<'a, 'b> {
    ctx: &'a FaceCtx<'b>,
    surf: Surf<'a>,
    swap: bool,
    origin: [f64; 2],
    scale: [f64; 2],
    pts: Vec<FPt>,
}

impl Mesher<'_, '_> {
    fn work(&self, uv: [f64; 2]) -> Point2 {
        let d = dom(self.swap, uv);
        Point2::new(
            (d[0] - self.origin[0]) * self.scale[0],
            (d[1] - self.origin[1]) * self.scale[1],
        )
    }

    fn assess(&self, v: [u32; 3], c: [bool; 3], global: &Global) -> Assess {
        let tol = &self.ctx.tol;
        let f = v.map(|k| self.pts[k as usize]);
        let pos = f.map(|p| global.pos[p.gid as usize]);
        // Repeated mesh vertices: a legitimate collapse onto a singular vertex, or two
        // copies of a cut vertex joined across the domain (must be split).
        for i in 0..3 {
            let (a, b) = (f[(i + 1) % 3], f[(i + 2) % 3]);
            if a.gid == b.gid {
                if a.sing != Sing::No && b.sing != Sing::No {
                    return Assess::Collapsed;
                }
                if c[i] {
                    return Assess::Split {
                        uvs: vec![],
                        badness: f64::INFINITY,
                    };
                }
                return Assess::Split {
                    uvs: vec![mid2(a.uv, b.uv)],
                    badness: f64::INFINITY,
                };
            }
        }
        let mut worst: Option<(f64, usize)> = None;
        let mut longest: Option<(f64, usize)> = None;
        for (i, &ci) in c.iter().enumerate() {
            if ci {
                continue;
            }
            let (ia, ib) = ((i + 1) % 3, (i + 2) % 3);
            let (a, b) = (f[ia], f[ib]);
            let (va, vb) = virtual_pair(a.uv, a.sing, b.uv, b.sing);
            let dev = self
                .surf
                .eval(mid2(va, vb))
                .distance((pos[ia] + pos[ib]) * 0.5);
            let ang = if a.sing != Sing::No && b.sing != Sing::No {
                0.0
            } else {
                match (self.surf.normal_param(va), self.surf.normal_param(vb)) {
                    (Some(na), Some(nb)) => angle_between(na, nb),
                    _ => 0.0,
                }
            };
            let len = pos[ia].distance(pos[ib]);
            let bad = tol.badness(dev, ang, len);
            if bad > 1.0 && worst.is_none_or(|(w, _)| bad > w) {
                worst = Some((bad, i));
            }
            if longest.is_none_or(|(l, _)| len > l) {
                longest = Some((len, i));
            }
        }
        let edge_mid = |i: usize| mid2(f[(i + 1) % 3].uv, f[(i + 2) % 3].uv);
        // Centroid with singular substitution.
        let regular: Vec<[f64; 2]> = f
            .iter()
            .filter(|p| p.sing == Sing::No)
            .map(|p| p.uv)
            .collect();
        let mut cuv = [0.0; 2];
        for p in &f {
            let mut uv = p.uv;
            if !regular.is_empty() {
                let mean =
                    |d: usize| regular.iter().map(|q| q[d]).sum::<f64>() / regular.len() as f64;
                match p.sing {
                    Sing::U => uv[0] = mean(0),
                    Sing::V => uv[1] = mean(1),
                    Sing::No => {}
                }
            }
            cuv[0] += uv[0] / 3.0;
            cuv[1] += uv[1] / 3.0;
        }
        let centroid = (pos[0] + pos[1] + pos[2]) * (1.0 / 3.0);
        let centroid_mid = mid2(mid2(f[0].uv, f[1].uv), f[2].uv);
        let fallback = |mut v: Vec<[f64; 2]>| {
            v.push(centroid_mid);
            v
        };
        if let Some((bad, i)) = worst {
            return Assess::Split {
                uvs: fallback(vec![edge_mid(i)]),
                badness: bad,
            };
        }
        let dev_c = self.surf.eval(cuv).distance(centroid);
        if dev_c > tol.dev {
            return Assess::Split {
                uvs: fallback(vec![cuv]),
                badness: dev_c / tol.dev,
            };
        }
        let nf = (pos[1] - pos[0]).cross(pos[2] - pos[0]);
        let ok_orient = match self.surf.normal_param(cuv) {
            Some(n) => nf.dot(n) > 0.0,
            None => true,
        };
        if !ok_orient {
            let mut uvs = Vec::new();
            if let Some((_, i)) = longest {
                uvs.push(edge_mid(i));
            }
            return Assess::Split {
                uvs: fallback(uvs),
                badness: f64::INFINITY,
            };
        }
        Assess::Good
    }
}

/// Mesh one face.
pub(crate) fn mesh_face(ctx: &FaceCtx, global: &mut Global) -> Result<FaceOut, MeshError> {
    let surf = Surf::for_face(ctx.body, ctx.face);
    let domain = build_domain(ctx, &surf, global)?;
    let swap = domain.swap;

    // Parameter and domain boxes.
    let mut uv_lo = [f64::INFINITY; 2];
    let mut uv_hi = [f64::NEG_INFINITY; 2];
    let mut d_lo = [f64::INFINITY; 2];
    let mut d_hi = [f64::NEG_INFINITY; 2];
    for p in domain.rings.iter().flatten() {
        let dd = dom(swap, p.uv);
        for k in 0..2 {
            uv_lo[k] = uv_lo[k].min(p.uv[k]);
            uv_hi[k] = uv_hi[k].max(p.uv[k]);
            d_lo[k] = d_lo[k].min(dd[k]);
            d_hi[k] = d_hi[k].max(dd[k]);
        }
    }
    if !(uv_lo.iter().chain(&uv_hi).all(|x| x.is_finite())) {
        return Err(MeshError::NonFinite {
            entity: ctx.name.to_string(),
        });
    }
    // Metric scale: RMS of |S_u|, |S_v| over the parameter box (regular points only).
    let mut acc = [0.0f64; 2];
    let mut cnt = 0usize;
    for i in 0..5 {
        for j in 0..5 {
            let uv = [
                uv_lo[0] + (uv_hi[0] - uv_lo[0]) * (i as f64 + 0.5) / 5.0,
                uv_lo[1] + (uv_hi[1] - uv_lo[1]) * (j as f64 + 0.5) / 5.0,
            ];
            if surf.sing(uv) != Sing::No {
                continue;
            }
            let [_, su, sv] = surf.s.derivs1(uv[0], uv[1]);
            acc[0] += su.norm_squared();
            acc[1] += sv.norm_squared();
            cnt += 1;
        }
    }
    let mut suv = [1.0, 1.0];
    if cnt > 0 {
        for k in 0..2 {
            let s = (acc[k] / cnt as f64).sqrt();
            if s.is_finite() && s > 0.0 {
                suv[k] = s;
            }
        }
    }
    // Developable surfaces deviate only across their generators (v is straight), so
    // the Delaunay metric is compressed along v: triangles may be long along generators.
    if matches!(surf.s, Surface::Cylinder(_) | Surface::Cone(_)) {
        suv[1] /= DEVELOPABLE_ASPECT;
    }
    let scale = if swap { [suv[1], suv[0]] } else { suv };
    let origin = [0.5 * (d_lo[0] + d_hi[0]), 0.5 * (d_lo[1] + d_hi[1])];
    let mut m = Mesher {
        ctx,
        surf,
        swap,
        origin,
        scale,
        pts: Vec::new(),
    };

    // CDT of the boundary.
    let wlo = Point2::new(
        (d_lo[0] - origin[0]) * scale[0],
        (d_lo[1] - origin[1]) * scale[1],
    );
    let whi = Point2::new(
        (d_hi[0] - origin[0]) * scale[0],
        (d_hi[1] - origin[1]) * scale[1],
    );
    let mut cdt = Cdt::new(wlo, whi).map_err(|e| ctx.cdt_err(e))?;
    let mut segs: Vec<(u32, u32)> = Vec::new();
    for ring in &domain.rings {
        let base = m.pts.len() as u32;
        let n = ring.len() as u32;
        if n < 3 {
            return Err(ctx.loops_err("a boundary ring has fewer than three points"));
        }
        for p in ring {
            match cdt.insert_point(m.work(p.uv)) {
                Ok(_) => m.pts.push(*p),
                Err(CdtError::DuplicatePoint { .. }) => {
                    return Err(MeshError::BoundaryTouch {
                        face: ctx.name.to_string(),
                    });
                }
                Err(e) => return Err(ctx.cdt_err(e)),
            }
        }
        for k in 0..n {
            segs.push((base + k, base + (k + 1) % n));
        }
    }
    for &(a, b) in &segs {
        cdt.insert_constraint(a, b).map_err(|e| ctx.cdt_err(e))?;
    }
    for &(a, b) in &segs {
        if !cdt.is_constrained(a, b) {
            return Err(MeshError::BoundaryTouch {
                face: ctx.name.to_string(),
            });
        }
    }
    cdt.mark_domain(&segs).map_err(|e| ctx.cdt_err(e))?;

    // Seeds.
    let steps = Steps::new(&m.surf, &ctx.tol, (uv_lo, uv_hi));
    if let Some(dv) = steps.dv.map(|d| d * SEED_SPACING)
        && dv.is_finite()
        && dv > 0.0
    {
        let seg_w: Vec<(Point2, Point2)> = segs
            .iter()
            .map(|&(a, b)| (cdt.point(a), cdt.point(b)))
            .collect();
        let du = steps.du * SEED_SPACING;
        let cell = (dv * suv[1]).min(du * suv[0]).max(1e-12);
        let grid = SegGrid::new(seg_w, wlo, whi, cell);
        let nv = ((uv_hi[1] - uv_lo[1]) / dv).ceil().max(1.0) as usize;
        let dvv = (uv_hi[1] - uv_lo[1]) / nv as f64;
        for j in 1..nv {
            let v = uv_lo[1] + dvv * j as f64;
            if !(du.is_finite() && du > 0.0) {
                continue;
            }
            let nu = ((uv_hi[0] - uv_lo[0]) / du).ceil().max(1.0) as usize;
            if nu > 1_000_000 {
                continue;
            }
            let duu = (uv_hi[0] - uv_lo[0]) / nu as f64;
            let off = if j % 2 == 1 { 0.5 } else { 0.0 };
            let h = (duu * suv[0]).min(dvv * suv[1]);
            for i in 0..=nu {
                let u = uv_lo[0] + duu * (i as f64 + off);
                if !(u > uv_lo[0] && u < uv_hi[0]) {
                    continue;
                }
                let uv = [u, v];
                let w = m.work(uv);
                if grid.near(w, SEED_CLEARANCE * h) {
                    continue;
                }
                if cdt
                    .inside_triangle_at(w)
                    .map_err(|e| ctx.cdt_err(e))?
                    .is_none()
                {
                    continue;
                }
                if let SteinerOutcome::Inserted(_) =
                    cdt.insert_steiner(w).map_err(|e| ctx.cdt_err(e))?
                {
                    m.pts.push(FPt {
                        gid: global.add(m.surf.eval(uv)),
                        uv,
                        sing: Sing::No,
                    });
                }
            }
        }
    }
    let _ = cdt.take_touched();

    // Refinement.
    let mut queue: std::collections::VecDeque<u32> = (0..cdt.slot_count() as u32).collect();
    let mut queued = vec![true; cdt.slot_count()];
    let mut inserted = 0usize;
    while let Some(t) = queue.pop_front() {
        queued[t as usize] = false;
        let Some((v, c)) = cdt.slot(t) else { continue };
        let (uvs, badness) = match m.assess(v, c, global) {
            Assess::Good | Assess::Collapsed => continue,
            Assess::Split { uvs, badness } => (uvs, badness),
        };
        let mut done = false;
        for uv in uvs {
            let w = m.work(uv);
            if let SteinerOutcome::Inserted(_) =
                cdt.insert_steiner(w).map_err(|e| ctx.cdt_err(e))?
            {
                m.pts.push(FPt {
                    gid: global.add(m.surf.eval(uv)),
                    uv,
                    sing: m.surf.sing(uv),
                });
                done = true;
                break;
            }
        }
        if !done {
            return Err(MeshError::RefinementLimit {
                face: ctx.name.to_string(),
                points: inserted,
                deviation: badness * ctx.tol.dev_mid,
                requested: ctx.tol.dev,
            });
        }
        inserted += 1;
        if inserted > MAX_FACE_POINTS {
            return Err(MeshError::RefinementLimit {
                face: ctx.name.to_string(),
                points: inserted,
                deviation: badness * ctx.tol.dev_mid,
                requested: ctx.tol.dev,
            });
        }
        let touched = cdt.take_touched();
        if queued.len() < cdt.slot_count() {
            queued.resize(cdt.slot_count(), false);
        }
        let mut again = true;
        for x in touched {
            if x == t {
                again = false;
            }
            if !queued[x as usize] {
                queued[x as usize] = true;
                queue.push_back(x);
            }
        }
        if again && !queued[t as usize] {
            queued[t as usize] = true;
            queue.push_back(t);
        }
    }

    Ok(FaceOut {
        pts: m.pts,
        tris: cdt.triangles(),
    })
}
