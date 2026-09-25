//! Predictor–corrector tracing, cluster resolution and fitting of marched branches.

use forge_core::geom::Curve3;
use forge_core::math;
use forge_core::{Point2, Point3, Vec2, Vec3};

use crate::error::SsiError;
use crate::func::{Fn2, dist, uv_near};
use crate::ssi::bound::{bezier_segments, certify_curve};
use crate::ssi::carrier::uv_derivative;
use crate::ssi::fit::{
    FitOptions, HermiteRef, Node, NodeSource, densify_periodic, hermite2, nurbs2, nurbs3,
    pcurve_box_crossings, periodic_flags, refine, uv_second, verify_pcurves,
};
use crate::ssi::march::{Class, March};
use crate::ssi::{PreBranch, PreVertex, angle_and_sense, singular_param};
use crate::types::{Branch, Contact, Representation, SsiStats, VertexKind};

/// A traced point: parameters on `P` (unwrapped, continuous) and the 3D point.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Tp {
    pub uv: Point2,
    pub p: Point3,
}

/// How a traced direction ended.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum RawEnd {
    /// Left `P`'s box.
    Domain,
    /// Entered the irregular leaf.
    Cluster(usize),
    /// Could not continue (singular point).
    Stuck,
}

/// A traced branch before cluster resolution.
#[derive(Clone, Debug)]
pub(crate) struct RawBranch {
    pub pts: Vec<Tp>,
    pub ends: [RawEnd; 2],
    pub closed: bool,
}

/// What a resolved branch end is.
#[derive(Clone, Copy, Debug)]
pub(crate) enum EndInfo {
    /// A domain-boundary vertex at the end point.
    Domain,
    /// A resolved vertex (singular, special).
    Vertex(PreVertex),
}

/// A branch after cluster resolution.
#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    pub pts: Vec<Tp>,
    pub closed: bool,
    pub ends: [EndInfo; 2],
}

/// A pass-through join: `(branch, end)` ↔ `(branch, end)` and the path between them.
type Join = ((usize, usize), (usize, usize), Vec<Tp>);
/// The partner of a branch end: `(branch, end, path)`.
type Partner = (usize, usize, Vec<Tp>);

/// Output of cluster resolution.
pub(crate) struct Assembled {
    pub branches: Vec<Resolved>,
    pub points: Vec<PreVertex>,
}

fn not_converged(stage: &'static str, p: Point3, residual: f64, iterations: u32) -> SsiError {
    SsiError::NotConverged {
        stage,
        point: p.to_array(),
        residual,
        iterations,
    }
}

impl March<'_> {
    /// Newton projection onto `G = 0` along the gradient.
    pub(crate) fn correct(&self, uv: Point2) -> Option<Point2> {
        let goal = 1e-12 * self.len.max(1e-300);
        let mut x = uv;
        for _ in 0..16 {
            let (g, gr) = self.g.grad(x);
            let n2 = gr.norm_squared();
            if !(n2 > 0.0 && n2.is_finite() && g.is_finite()) {
                return None;
            }
            let step = gr * (g / n2);
            x -= step;
            if g.abs() <= goal {
                return Some(x);
            }
        }
        let g = self.g.eval(x.x, x.y);
        (g.abs() <= 1e3 * goal).then_some(x)
    }

    /// [`Self::correct`] that only accepts points whose distance to the curve, estimated
    /// as `|G| / |∇G|` in 3D, is below `max(1e-12·len, min(h / 20, 1e-9·len))` for a step
    /// of length `h` (what rounding allows where `∇G` is tiny):
    /// near a hairpin tip `∇G` is tiny, and a small `|G|` alone lets the trace wander off
    /// along the tolerance band past the tip.
    fn correct_strict(&self, uv: Point2, h: f64) -> Option<Point2> {
        let x = self.correct(uv)?;
        let (g, gr) = self.g.grad(x);
        let [_, su, sv] = self.p.surf.derivs1(x.x, x.y);
        // Parameter-space step to the curve, measured in 3D.
        let n2 = gr.norm_squared();
        let st = gr * (g / n2.max(1e-300));
        let d3 = (su * st.x + sv * st.y).norm();
        let len = self.len.max(1e-300);
        (d3 <= (1e-12 * len).max((0.05 * h).min(1e-9 * len))).then_some(x)
    }

    /// Tangent direction in `P`'s parameters (unit 3D speed) and the 3D speed of
    /// `perp(∇G)`.
    fn tangent(&self, uv: Point2) -> Option<(Vec2, Vec3)> {
        let (_, gr) = self.g.grad(uv);
        let tau = Vec2::new(-gr.y, gr.x);
        let [_, su, sv] = self.p.surf.derivs1(uv.x, uv.y);
        let t3 = su * tau.x + sv * tau.y;
        let speed = t3.norm();
        if !speed.is_finite() || speed <= 1e-14 * self.len.max(1e-300) * gr.norm().max(1e-300) {
            return None;
        }
        Some((tau / speed, t3 / speed))
    }

    /// Mark crossings within the match distance of `p` as visited; return them.
    fn mark_near(&mut self, p: Point3) -> Vec<usize> {
        let d = self.match_dist();
        let mut out = Vec::new();
        for (i, c) in self.crossings.iter_mut().enumerate() {
            if c.p.distance(p) <= d {
                c.visited = true;
                out.push(i);
            }
        }
        out
    }

    /// Outside `P`'s box in a direction that is a real boundary.
    fn outside(&self, uv: Point2) -> bool {
        let (u, v) = (self.p.dom.u, self.p.dom.v);
        (!self.full_u && (uv.x < u.0 || uv.x > u.1)) || (!self.full_v && (uv.y < v.0 || uv.y > v.1))
    }

    /// The exact curve point where the chord `a → b` leaves the cell `(u, v)` (or the
    /// box): the root of `G` on the crossed boundary line nearest the chord.
    fn boundary_point(&self, a: Point2, b: Point2, u: (f64, f64), v: (f64, f64)) -> Option<Point2> {
        // Parameter along the chord where it leaves the rectangle.
        let mut best: Option<(f64, bool, f64)> = None; // (s, fixed is u, value)
        let d = b - a;
        for (fixed_u, lo_hi) in [(true, u), (false, v)] {
            for (is_lower, bound) in [(true, lo_hi.0), (false, lo_hi.1)] {
                let (a0, d0) = if fixed_u { (a.x, d.x) } else { (a.y, d.y) };
                if d0 == 0.0 {
                    continue;
                }
                let s = (bound - a0) / d0;
                let exits = if is_lower { d0 < 0.0 } else { d0 > 0.0 };
                if exits && (-1e-9..=1.0 + 1e-9).contains(&s) && best.is_none_or(|x| s < x.0) {
                    best = Some((s, fixed_u, bound));
                }
            }
        }
        let (s, fixed_u, bound) = best?;
        let guess = a + d * s;
        // 1D Newton on the boundary line.
        let mut x = if fixed_u { guess.y } else { guess.x };
        let at = |x: f64| {
            if fixed_u {
                Point2::new(bound, x)
            } else {
                Point2::new(x, bound)
            }
        };
        for _ in 0..30 {
            let (g, gr) = self.g.grad(at(x));
            let dg = if fixed_u { gr.y } else { gr.x };
            if dg == 0.0 || !dg.is_finite() {
                break;
            }
            let step = g / dg;
            x -= step;
            if step.abs() <= 1e-15 * (1.0 + x.abs()) {
                break;
            }
        }
        let q = at(x);
        // The root must lie on the crossed edge segment of the rectangle (a curve that
        // crosses the same grid line twice within one step would otherwise be matched to
        // the wrong crossing); the caller then retries with a shorter step.
        let (lo, hi) = if fixed_u { v } else { u };
        let slack = 1e-9 * (hi - lo).abs().max(1e-300);
        let on_edge = !lo.is_finite() || (x >= lo - slack && x <= hi + slack);
        (on_edge
            && self.g.eval(q.x, q.y).abs() <= 1e-9 * self.len
            && q.distance(guess) <= 4.0 * d.norm() + 1e-12)
            .then_some(q)
    }

    /// Cell of a leaf in canonical coordinates shifted next to `uv` (periodic `u`).
    fn cell_near(&self, leaf: usize, uv: Point2) -> ((f64, f64), (f64, f64)) {
        let c = self.cells[leaf];
        let cu = self.canonical(uv);
        let du = uv.x - cu.x;
        let dv = uv.y - cu.y;
        ((c.u.0 + du, c.u.1 + du), (c.v.0 + dv, c.v.1 + dv))
    }
}

/// Trace one direction from `start` (a point on the curve).
fn trace_dir(
    m: &mut March<'_>,
    start: Point2,
    sign: f64,
    start_marks: &[usize],
) -> Result<(Vec<Tp>, RawEnd, bool), SsiError> {
    let mut pts = vec![Tp {
        uv: start,
        p: m.p.surf.eval(start.x, start.y),
    }];
    let mut uv = start;
    let Some((t0, t3_start)) = m.tangent(uv) else {
        return Ok((pts, RawEnd::Stuck, false));
    };
    let mut dir = t0 * sign;
    let start_p = pts[0].p;
    let start_t3 = t3_start * sign;
    // Geometric closure: the step `a → b` passes through the start point (which lies on
    // the curve) in the traced direction.
    let closes = |m: &March<'_>, a: Point3, b: Point3, uv_a: Point2, uv_b: Point2| -> Option<Tp> {
        // A step turns by at most ~14°, so the arc through the start point exceeds the
        // chord by at most ~2(s/c)² ≈ 0.4 %; allow 2 %. The same must hold in `P`'s
        // parameters (3D proximity alone is fooled by thin surfaces).
        let chord = a.distance(b);
        let via = a.distance(start_p) + start_p.distance(b);
        if !(chord > 0.0 && via <= chord * 1.02 + 1e-9 * m.len && start_t3.dot(b - a) > 0.0) {
            return None;
        }
        // The period copy of the start nearest the step (canonical windows cannot decide
        // it: a start on the window's edge and a step just across it wrap apart).
        let near = |x: f64, full: bool, y: f64| {
            if full {
                x + ((y - x) / math::TAU).round() * math::TAU
            } else {
                x
            }
        };
        let s = Point2::new(
            near(start.x, m.full_u, uv_b.x),
            near(start.y, m.full_v, uv_b.y),
        );
        let uv_chord = uv_a.distance(uv_b);
        let uv_via = uv_a.distance(s) + s.distance(uv_b);
        (uv_via <= uv_chord * 1.1 + 1e-9 * (1.0 + s.norm())).then_some(Tp { uv: s, p: start_p })
    };
    let step_cap = m.len / 24.0;
    // The leaf we are moving into.
    let probe = uv + dir * (1e-6 * m.len);
    let mut leaf = m.locate(probe);
    let mut h = (m.len / 64.0).min(leaf.map_or(step_cap, |l| 0.25 * m.cells[l].size));
    let mut travelled = 0.0;
    let max_steps = 400_000usize;
    let mut stall = 0u32;
    loop {
        if let Some(l) = leaf {
            match m.cells[l].class {
                Class::Irregular => return Ok((pts, RawEnd::Cluster(l), false)),
                Class::Excluded | Class::Regular => {}
            }
        }
        m.stats.steps += 1;
        if m.stats.steps > max_steps {
            return Err(SsiError::BudgetExceeded {
                what: "marching steps",
                limit: max_steps,
            });
        }
        // Keep the current leaf consistent with the current point.
        if let Some(l) = leaf {
            let cell = m.cells[l];
            let q = m.canonical(uv);
            let su = 1e-6 * (cell.u.1 - cell.u.0);
            let sv = 1e-6 * (cell.v.1 - cell.v.0);
            let inside = q.x >= cell.u.0 - su
                && q.x <= cell.u.1 + su
                && q.y >= cell.v.0 - sv
                && q.y <= cell.v.1 + sv;
            if !inside {
                let dim = (cell.u.1 - cell.u.0).min(cell.v.1 - cell.v.0);
                leaf = dir
                    .normalize()
                    .and_then(|d| m.correct(uv + d * (1e-4 * dim)))
                    .and_then(|q| m.locate(q))
                    .or_else(|| m.locate(uv));
                if let Some(nl) = leaf
                    && m.cells[nl].class == Class::Irregular
                {
                    return Ok((pts, RawEnd::Cluster(nl), false));
                }
            }
        }
        let cap = leaf.map_or(step_cap, |l| (0.5 * m.cells[l].size).max(m.h_min));
        h = h.min(cap).min(step_cap);
        let p0 = m.p.surf.eval(uv.x, uv.y);
        let mut accepted = None;
        let mut tries = 0;
        while tries < 60 {
            tries += 1;
            let pred = uv + dir * h;
            let Some(c) = m.correct(pred) else {
                h *= 0.5;
                continue;
            };
            let pc = m.p.surf.eval(c.x, c.y);
            let Some((tn, _)) = m.tangent(c) else {
                h *= 0.5;
                continue;
            };
            // Orientation lock (open issue 1): along one regular piece of the zero set the
            // raw tangent `perp(∇G)` keeps its orientation, and the trace only runs through
            // certified-regular cells. A corrected point whose raw tangent points backwards
            // lies on another piece — the other branch of a near-crossing that passes a
            // saddle of `G` — and the step is rejected (`cos_turn` < 0), never re-oriented.
            let tn = tn * sign;
            let moved = pc.distance(p0);
            let drift = pc.distance(m.p.surf.eval(pred.x, pred.y));
            let cos_turn = {
                let (a, b) = (dir.normalize(), tn.normalize());
                match (a, b) {
                    (Some(a), Some(b)) => a.dot(b),
                    _ => -1.0,
                }
            };
            if moved > 0.2 * h && drift <= 0.25 * h + 1e-12 * m.len && cos_turn >= 0.97 {
                accepted = Some((c, tn, moved));
                break;
            }
            h *= 0.5;
            if h < 1e-9 * m.h_min {
                break;
            }
        }
        let Some((c, tn, moved)) = accepted else {
            return Ok((pts, RawEnd::Stuck, false));
        };
        // Leaving the box?
        if m.outside(c) {
            let (u, v) = (m.p.dom.u, m.p.dom.v);
            let bu = if m.full_u {
                (f64::NEG_INFINITY, f64::INFINITY)
            } else {
                u
            };
            let bv = if m.full_v {
                (f64::NEG_INFINITY, f64::INFINITY)
            } else {
                v
            };
            let x = m.boundary_point(uv, c, bu, bv).ok_or_else(|| {
                not_converged("domain exit", m.p.surf.eval(c.x, c.y), f64::NAN, 30)
            })?;
            let px = m.p.surf.eval(x.x, x.y);
            m.mark_near(px);
            pts.push(Tp { uv: x, p: px });
            return Ok((pts, RawEnd::Domain, false));
        }
        let new_leaf = m.locate(c);
        // The step ends at `c`, or — when it leaves the current cell — at the exact exit
        // point of the cell, so no cell is ever skipped and every transition is
        // bookkept against the certified crossings.
        let (next_uv, next_p, next_dir, next_leaf, marks) = match leaf {
            Some(l) if new_leaf != leaf => {
                let (cu, cv) = m.cell_near(l, uv);
                let cell = m.cells[l];
                let dim = (cell.u.1 - cell.u.0).min(cell.v.1 - cell.v.0).max(1e-300);
                match m.boundary_point(uv, c, cu, cv) {
                    // The current point already sits on the exit edge: the curve heads
                    // straight into the landing cell. Adopt it and redo the step.
                    Some(x) if x.distance(uv) <= 1e-9 * dim => {
                        // Enter the cell the chord goes into (robust when the curve runs
                        // almost along the edge), else the one a short curve step reaches.
                        let by_chord = m.locate(uv + (c - uv) * 1e-6);
                        let entering = if by_chord.is_some() && by_chord != leaf {
                            by_chord
                        } else {
                            dir.normalize()
                                .and_then(|d| m.correct(uv + d * (1e-4 * dim)))
                                .and_then(|q| m.locate(q))
                        };
                        // `stall` bounds re-adoptions without progress (a point exactly
                        // on a cell corner can alternate between neighbours).
                        if entering.is_some() && entering != leaf && stall < 6 {
                            stall += 1;
                            leaf = entering;
                            if let Some(nl) = leaf
                                && m.cells[nl].class == Class::Irregular
                            {
                                return Ok((pts, RawEnd::Cluster(nl), false));
                            }
                            continue;
                        }
                        // No clean entry cell: accept the step as is.
                        (c, m.p.surf.eval(c.x, c.y), tn, new_leaf, Vec::new())
                    }
                    Some(x) => {
                        let px = m.p.surf.eval(x.x, x.y);
                        let tx = match m.tangent(x) {
                            Some((t, _)) if t.dot(dir) < 0.0 => -t,
                            Some((t, _)) => t,
                            None => tn,
                        };
                        // The cell the curve enters: a short corrected step along it
                        // (robust when the curve is nearly tangent to the cell edge).
                        let beyond = match tx.normalize() {
                            Some(d) => m
                                .correct(x + d * (1e-4 * dim))
                                .map_or(new_leaf, |q| m.locate(q)),
                            None => new_leaf,
                        };
                        let marks = m.mark_near(px);
                        (x, px, tx, beyond, marks)
                    }
                    None if h > 1e-6 * dim => {
                        // Could not locate the exit point: retry with a shorter step.
                        h *= 0.5;
                        continue;
                    }
                    None => {
                        // A step far below the cell size still leaves the cell without a
                        // clean exit point (the curve grazes a cell corner): accept it.
                        // A crossing missed here is either visited later or re-traced
                        // and recognised as a duplicate.
                        (c, m.p.surf.eval(c.x, c.y), tn, new_leaf, Vec::new())
                    }
                }
            }
            _ => (c, m.p.surf.eval(c.x, c.y), tn, new_leaf, Vec::new()),
        };
        let step_len = next_p.distance(p0);
        // Geometric closure through the start point.
        if travelled > 2.0 * step_len.max(m.match_dist())
            && let Some(tp) = closes(m, p0, next_p, uv, next_uv)
        {
            pts.push(tp);
            return Ok((pts, RawEnd::Domain, true));
        }
        pts.push(Tp {
            uv: next_uv,
            p: next_p,
        });
        stall = 0;
        travelled += step_len;
        if travelled > 4.0 * m.match_dist() && marks.iter().any(|k| start_marks.contains(k)) {
            return Ok((pts, RawEnd::Domain, true));
        }
        if let Some(nl) = next_leaf
            && m.cells[nl].class == Class::Irregular
        {
            return Ok((pts, RawEnd::Cluster(nl), false));
        }
        uv = next_uv;
        dir = next_dir;
        leaf = next_leaf;
        h *= 1.6;
        // Safety net: a closed curve whose start crossing was not recognised brings the
        // (deterministic) tracer back onto its own earlier points. Close the loop there.
        if pts.len().is_multiple_of(32) && pts.len() > 64 {
            let n = pts.len();
            let last = pts[n - 1];
            // A regular curve cannot pass through one 3D point twice.
            // The most recent earlier visit (one lap back, not the first of several).
            let hit = (0..n - 16)
                .rev()
                .find(|&j| pts[j].p.distance(last.p) <= m.match_dist());
            if let Some(j) = hit {
                let mut lp: Vec<Tp> = pts[j..].to_vec();
                if let Some(e) = lp.last_mut() {
                    // Keep the closing point's parameters continuous with the loop.
                    e.p = pts[j].p;
                }
                m.uncertified = true;
                return Ok((lp, RawEnd::Domain, true));
            }
        }
        if travelled > 2000.0 * m.len {
            return Err(SsiError::Inconsistent {
                detail: "runaway trace (no closure found)",
                point: next_p.to_array(),
            });
        }
        let _ = moved;
    }
}

/// Distance from `p` to the true curve near a traced branch (Newton refined).
fn distance_to_branch(m: &March<'_>, rb: &RawBranch, p: Point3, crossing_leaf: &[bool]) -> f64 {
    let mut best = (f64::INFINITY, 0usize, 0.0);
    for i in 0..rb.pts.len().saturating_sub(1) {
        let (a, b) = (rb.pts[i].p, rb.pts[i + 1].p);
        let ab = b - a;
        let l2 = ab.norm_squared();
        let s = if l2 > 0.0 {
            ((p - a).dot(ab) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let d = (a + ab * s).distance(p);
        if d < best.0 {
            best = (d, i, s);
        }
    }
    if rb.pts.len() == 1 {
        return rb.pts[0].p.distance(p);
    }
    if best.0 > 0.05 * m.len {
        return best.0;
    }
    let (_, i, s) = best;
    // The refinement slides along `G = 0` from the nearest chord point to the foot of `p`,
    // correcting the chord's sagitta. Past the end of a branch that stops at a cluster
    // holding a crossing of the zero set (`crossing_leaf`), the slide can pass the crossing
    // and continue onto another arm, find `p` there and report that arm's crossing seeds as
    // already traced, so the arm is never traced (two cylinders touching on the seam of the
    // box: `SSI_TANGENT_UNRESOLVED` with 3 branch ends). There the foot may only reach into
    // the cluster (twice its leaf's size from the end), not through it. Elsewhere — a
    // hairpin tip, where the curve does come back — the refinement is unchanged.
    let n = rb.pts.len();
    let cluster_end = if rb.closed {
        None
    } else if i + 2 == n && s >= 1.0 {
        Some(1)
    } else if i == 0 && s <= 0.0 {
        Some(0)
    } else {
        None
    }
    .and_then(|e| match rb.ends[e] {
        RawEnd::Cluster(l) if crossing_leaf.get(l).copied().unwrap_or(false) => {
            Some((if e == 0 { rb.pts[0].p } else { rb.pts[n - 1].p }, l))
        }
        _ => None,
    });
    let on_this_branch = |q: Point3| -> bool {
        cluster_end.is_none_or(|(end, l)| q.distance(end) <= 2.0 * m.cells[l].size + m.match_dist())
    };
    let mut uv = rb.pts[i].uv.lerp(rb.pts[i + 1].uv, s);
    for _ in 0..6 {
        let Some(c) = m.correct(uv) else {
            return best.0;
        };
        let Some((tu, t3)) = m.tangent(c) else {
            let q = m.p.surf.eval(c.x, c.y);
            return if on_this_branch(q) {
                q.distance(p)
            } else {
                best.0
            };
        };
        let q = m.p.surf.eval(c.x, c.y);
        let along = (p - q).dot(t3);
        uv = c + tu * along;
        if along.abs() <= 1e-14 * m.len {
            break;
        }
    }
    match m.correct(uv) {
        Some(c) => {
            let q = m.p.surf.eval(c.x, c.y);
            if on_this_branch(q) {
                q.distance(p)
            } else {
                best.0
            }
        }
        None => best.0,
    }
}

/// Trace every branch from the certified crossings.
pub(crate) fn trace_all(m: &mut March<'_>) -> Result<Vec<RawBranch>, SsiError> {
    let mut raws: Vec<RawBranch> = Vec::new();
    // Leaves of clusters around a crossing of the zero set (a saddle of `G` on both surfaces
    // within `fit / 4`, the test of `resolve_clusters`), for `distance_to_branch`.
    let mut crossing_leaf = vec![false; m.cells.len()];
    for cells in m.clusters() {
        let info = m.cluster_info(&cells);
        if m.cluster_saddle(&info)
            .is_some_and(|(_, g)| g <= 0.25 * m.ctx.tol.fit)
        {
            for c in cells {
                crossing_leaf[c] = true;
            }
        }
    }
    for ci in 0..m.crossings.len() {
        if m.crossings[ci].visited {
            continue;
        }
        let (uv, p) = (m.crossings[ci].uv, m.crossings[ci].p);
        if raws
            .iter()
            .any(|rb| distance_to_branch(m, rb, p, &crossing_leaf) <= m.match_dist())
        {
            m.mark_near(p);
            continue;
        }
        let marks = m.mark_near(p);
        let (fwd, end_f, closed) = trace_dir(m, uv, 1.0, &marks)?;
        if closed {
            raws.push(RawBranch {
                pts: fwd,
                ends: [RawEnd::Domain, RawEnd::Domain],
                closed: true,
            });
            continue;
        }
        let (bwd, end_b, bwd_closed) = trace_dir(m, uv, -1.0, &marks)?;
        if bwd_closed {
            // The loop closed going backwards (the forward trace stopped early, e.g. at a
            // domain exit of a partially periodic box): keep the loop.
            raws.push(RawBranch {
                pts: bwd.into_iter().rev().collect(),
                ends: [RawEnd::Domain, RawEnd::Domain],
                closed: true,
            });
            continue;
        }
        let mut pts: Vec<Tp> = bwd.into_iter().rev().collect();
        pts.pop();
        pts.extend(fwd);
        if pts.len() < 2 {
            continue;
        }
        raws.push(RawBranch {
            pts,
            ends: [end_b, end_f],
            closed: false,
        });
    }
    Ok(raws)
}

// ---------------------------------------------------------------------------------------
// Clusters

/// Geometry of a cluster.
struct ClusterInfo {
    cells: Vec<usize>,
    /// 3D diameter.
    extent: f64,
}

impl March<'_> {
    fn cluster_info(&self, cells: &[usize]) -> ClusterInfo {
        let mut lo = Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
        let mut hi = -lo;
        for &c in cells {
            let cell = self.cells[c];
            for (u, v) in [
                (cell.u.0, cell.v.0),
                (cell.u.1, cell.v.0),
                (cell.u.0, cell.v.1),
                (cell.u.1, cell.v.1),
            ] {
                let p = self.p.surf.eval(u, v);
                lo = lo.min_components(p);
                hi = hi.max_components(p);
            }
        }
        let extent = hi.distance(lo)
            + cells
                .iter()
                .map(|&c| self.cells[c].size)
                .fold(0.0, f64::max);
        ClusterInfo {
            cells: cells.to_vec(),
            extent,
        }
    }

    /// Singular point of `G` in the cluster (Newton on ∇G = 0 from the best centre).
    fn cluster_core(&self, info: &ClusterInfo) -> (Point2, f64) {
        let mut best = (info.cells[0], f64::INFINITY);
        for &c in &info.cells {
            let x = self.cells[c].centre();
            let g = self.g.eval(x.x, x.y).abs();
            if g < best.1 {
                best = (c, g);
            }
        }
        let mut x = self.cells[best.0].centre();
        let start = x;
        let mut radius: f64 = 0.0;
        for &c in &info.cells {
            let cell = self.cells[c];
            radius = radius.max((cell.u.1 - cell.u.0).max(cell.v.1 - cell.v.0));
        }
        let radius = 4.0 * radius * (info.cells.len() as f64).sqrt();
        for _ in 0..50 {
            let (_, gr) = self.g.grad(x);
            let h = self.g.hessian(x);
            let det = h[0][0] * h[1][1] - h[0][1] * h[1][0];
            if det == 0.0 || !det.is_finite() {
                break;
            }
            let dx = Vec2::new(
                -(h[1][1] * gr.x - h[0][1] * gr.y) / det,
                -(-h[1][0] * gr.x + h[0][0] * gr.y) / det,
            );
            let nx = x + dx;
            if nx.distance(start) > radius || !nx.is_finite() {
                break;
            }
            x = nx;
            if dx.norm() <= 1e-15 * (1.0 + x.norm()) {
                break;
            }
        }
        let gx = self.g.eval(x.x, x.y).abs();
        if gx <= best.1 {
            (x, gx)
        } else {
            (self.cells[best.0].centre(), best.1)
        }
    }

    /// Certify a cluster free of zeros on a finer grid.
    fn certify_empty(&self, info: &ClusterInfo) -> bool {
        use forge_core::scalar::{Dual, Interval};
        let n = 16;
        for &c in &info.cells {
            let cell = self.cells[c];
            for i in 0..n {
                for j in 0..n {
                    let u0 = cell.u.0 + (cell.u.1 - cell.u.0) * i as f64 / n as f64;
                    let u1 = cell.u.0 + (cell.u.1 - cell.u.0) * (i + 1) as f64 / n as f64;
                    let v0 = cell.v.0 + (cell.v.1 - cell.v.0) * j as f64 / n as f64;
                    let v1 = cell.v.0 + (cell.v.1 - cell.v.0) * (j + 1) as f64 / n as f64;
                    let (ui, vi) = (Interval::new(u0, u1), Interval::new(v0, v1));
                    let gu = self.g.eval(Dual::variable(ui), Dual::constant(vi));
                    let gv = self.g.eval(Dual::constant(ui), Dual::variable(vi));
                    let (cu, cv) = (0.5 * u0 + 0.5 * u1, 0.5 * v0 + 0.5 * v1);
                    let gc = self.g.eval(Interval::point(cu), Interval::point(cv));
                    let mv =
                        gc + gu.d * (ui - Interval::point(cu)) + gv.d * (vi - Interval::point(cv));
                    let x = gu.v.intersect(mv);
                    let val = if x.is_empty() { gu.v } else { x };
                    if val.contains_zero() {
                        return false;
                    }
                }
            }
        }
        true
    }

    /// The point of the curve at 3D distance `s` from `core`, near `guess` (2D Newton on
    /// `G = 0`, `|S − core|² = s²`).
    fn point_at_distance(&self, core: Point3, s: f64, guess: Point2) -> Option<Point2> {
        let mut x = guess;
        for _ in 0..30 {
            let (g, gr) = self.g.grad(x);
            let [p, su, sv] = self.p.surf.derivs1(x.x, x.y);
            let r = p - core;
            let f2 = r.norm_squared() - s * s;
            let j2 = Vec2::new(2.0 * r.dot(su), 2.0 * r.dot(sv));
            let det = gr.x * j2.y - gr.y * j2.x;
            if det == 0.0 || !det.is_finite() {
                return None;
            }
            let dx = Vec2::new(
                -(j2.y * g - gr.y * f2) / det,
                -(-j2.x * g + gr.x * f2) / det,
            );
            x += dx;
            if dx.norm() <= 1e-14 * (1.0 + x.norm()) {
                break;
            }
        }
        let p = self.p.surf.eval(x.x, x.y);
        (self.g.eval(x.x, x.y).abs() <= 1e-9 * self.len
            && (p.distance(core) - s).abs() <= 1e-6 * s.max(1e-300))
        .then_some(x)
    }

    /// Points from a branch end towards `core` (ordered away from the end).
    fn approach(&self, end: Tp, core: Point3, core_uv: Point2) -> Vec<Tp> {
        let s0 = end.p.distance(core);
        let mut out = Vec::new();
        let mut guess = end.uv;
        for j in 1..=10 {
            let s = s0 * math::powi(0.5, j);
            if s <= 1e-6 * s0 {
                break;
            }
            let g = guess.lerp(core_uv, 0.5);
            match self.point_at_distance(core, s, g) {
                Some(x) => {
                    out.push(Tp {
                        uv: x,
                        p: self.p.surf.eval(x.x, x.y),
                    });
                    guess = x;
                }
                None => break,
            }
        }
        out
    }

    /// Trace through a cluster from `from` in direction `dir` until leaving the
    /// cluster's cells; returns the path (excluding `from`).
    ///
    /// With `lock = Some(s)` the step direction is the **raw** tangent `perp(∇G)` times
    /// `s`, never re-oriented by continuity: along one regular piece of the zero set the
    /// raw tangent keeps its orientation, so a corrected point whose raw tangent points
    /// backwards lies on another piece (the other branch of a near-crossing, the far
    /// side of a thin lens) and the step is rejected as a jump. Without a lock the
    /// orientation follows the previous direction.
    fn pass_through(
        &self,
        from: Tp,
        dir: Vec2,
        info: &ClusterInfo,
        lock: Option<f64>,
    ) -> Option<Vec<Tp>> {
        let mut uv = from.uv;
        let mut d = match lock {
            Some(s) => self.tangent(uv)?.0 * s,
            None => dir,
        };
        let mut out = Vec::new();
        let h0 = (info.extent / 32.0).max(1e-3 * self.h_min);
        let mut h = h0;
        let floor = if lock.is_some() { 1e-9 } else { 1e-6 };
        let inside =
            |m: &March<'_>, x: Point2| m.locate(x).is_some_and(|l| info.cells.contains(&l));
        let mut steps = 0;
        let mut left = false;
        let mut entered = false;
        while steps < 20_000 {
            steps += 1;
            let pred = uv + d * h;
            let Some(c) = self.correct(pred) else {
                h *= 0.5;
                if h < floor * h0 {
                    return None;
                }
                continue;
            };
            let (tn, _) = self.tangent(c)?;
            let tn = match lock {
                Some(s) => tn * s,
                None if tn.dot(d) < 0.0 => -tn,
                None => tn,
            };
            let turn = d.normalize()?.dot(tn.normalize()?);
            // A corrected point far from the predictor jumped to another piece (the
            // locked direction has unit 3D speed, so the step is `h` in 3D).
            let jumped = lock.is_some()
                && self
                    .p
                    .surf
                    .eval(c.x, c.y)
                    .distance(self.p.surf.eval(pred.x, pred.y))
                    > 0.2 * h;
            if turn < 0.97 || jumped {
                h *= 0.5;
                if h < floor * h0 {
                    return None;
                }
                continue;
            }
            out.push(Tp {
                uv: c,
                p: self.p.surf.eval(c.x, c.y),
            });
            uv = c;
            d = tn;
            let is_in = inside(self, c);
            entered |= is_in;
            // Unlocked: legacy rule (any point outside after the first step). Locked: the
            // path must have entered the cluster before it counts as leaving it.
            if !is_in && steps > 1 && (lock.is_none() || entered) {
                left = true;
                break;
            }
            h = (h * 1.5).min(h0 * 4.0);
        }
        left.then_some(out)
    }

    /// Newton on `∇G = 0` inside a cluster: the saddle (or extremum) of `G` a
    /// near-crossing or a tangency passes by. `Some((uv, |G|))` when it converged within
    /// the cluster's reach.
    fn cluster_saddle(&self, info: &ClusterInfo) -> Option<(Point2, f64)> {
        // Start at the cell centre with the smallest gradient.
        let mut best = (info.cells[0], f64::INFINITY);
        for &c in &info.cells {
            let x = self.cells[c].centre();
            let (_, gr) = self.g.grad(x);
            if gr.norm() < best.1 {
                best = (c, gr.norm());
            }
        }
        let start = self.cells[best.0].centre();
        let mut radius: f64 = 0.0;
        for &c in &info.cells {
            let cell = self.cells[c];
            radius = radius.max((cell.u.1 - cell.u.0).max(cell.v.1 - cell.v.0));
        }
        let radius = 4.0 * radius * (info.cells.len() as f64).sqrt();
        let mut x = start;
        let g0 = best.1.max(1e-300);
        for _ in 0..50 {
            let (_, gr) = self.g.grad(x);
            let h = self.g.hessian(x);
            let det = h[0][0] * h[1][1] - h[0][1] * h[1][0];
            if det == 0.0 || !det.is_finite() {
                return None;
            }
            let dx = Vec2::new(
                -(h[1][1] * gr.x - h[0][1] * gr.y) / det,
                -(-h[1][0] * gr.x + h[0][0] * gr.y) / det,
            );
            let nx = x + dx;
            if nx.distance(start) > radius || !nx.is_finite() {
                return None;
            }
            x = nx;
            if dx.norm() <= 1e-15 * (1.0 + x.norm()) {
                break;
            }
        }
        let (g, gr) = self.g.grad(x);
        (gr.norm() <= 1e-6 * g0 || gr.norm() <= 1e-12).then_some((x, g.abs()))
    }

    /// Pair the branch ends of a near-crossing (or a lens tip) by orientation-locked
    /// pass-throughs (docs/spikes/03-ssi.md, open issue 1). Every end is classified by
    /// the raw tangent `perp(∇G)`: an **in** end enters the cluster along it, an **out**
    /// end against it. Along one regular piece of the zero set the raw orientation is
    /// preserved, so each in end is traced with the orientation locked until it leaves
    /// the cluster, and joined to the out end it arrives at. `None` (fall back to a
    /// singular vertex) unless every end is paired, one-to-one.
    fn pair_locked(
        &self,
        raws: &[RawBranch],
        ends: &[(usize, usize)],
        info: &ClusterInfo,
    ) -> Option<Vec<Join>> {
        let mut ins: Vec<(usize, usize)> = Vec::new();
        let mut outs: Vec<(usize, usize)> = Vec::new();
        for &(b, e) in ends {
            if raws[b].pts.len() < 2 {
                return None;
            }
            let tp = end_tp(&raws[b], e);
            let dir = end_dir(&raws[b], e);
            let (tau, _) = self.tangent(tp.uv)?;
            let c = tau.normalize()?.dot(dir);
            if c.abs() < 0.5 {
                return None;
            }
            if c > 0.0 {
                ins.push((b, e));
            } else {
                outs.push((b, e));
            }
        }
        if ins.len() != outs.len() || ins.is_empty() {
            return None;
        }
        let reach = 4.0 * info.extent.max(self.match_dist());
        let mut used = vec![false; outs.len()];
        let mut joins = Vec::new();
        for (b, e) in ins {
            let from = end_tp(&raws[b], e);
            let mut path = self.pass_through(from, end_dir(&raws[b], e), info, Some(1.0))?;
            let last = *path.last()?;
            let mut cand: Vec<(f64, usize)> = outs
                .iter()
                .enumerate()
                .filter(|(j, _)| !used[*j])
                .map(|(j, &(ob, oe))| (end_tp(&raws[ob], oe).p.distance(last.p), j))
                .collect();
            cand.sort_by(|x, y| x.0.total_cmp(&y.0).then(x.1.cmp(&y.1)));
            let &(d, j) = cand.first()?;
            // The arrival must be unambiguous: clearly nearer one out end than any other.
            if d > reach || cand.get(1).is_some_and(|c2| c2.0 <= 2.0 * d) {
                return None;
            }
            used[j] = true;
            path.pop();
            joins.push(((b, e), outs[j], path));
        }
        Some(joins)
    }

    /// Pair branch ends of odd clusters across clusters (open issue 2: the hairpin tips
    /// of thin lenses at near-tangential contacts, whose radius ≈ the surfaces'
    /// separation lies far below the subdivision resolution). Each **in** end (see
    /// [`March::pair_locked`]) is traced with the raw orientation locked and no cell
    /// bounds, with steps down to `1e-10·len`, until it arrives at an **out** end,
    /// travelling into that branch. `None` unless every end is paired, one-to-one.
    fn pair_across(&self, raws: &[RawBranch], ends: &[(usize, usize)]) -> Option<Vec<Join>> {
        let mut ins: Vec<(usize, usize)> = Vec::new();
        let mut outs: Vec<(usize, usize)> = Vec::new();
        for &(b, e) in ends {
            if raws[b].pts.len() < 2 {
                return None;
            }
            let tp = end_tp(&raws[b], e);
            let (tau, _) = self.tangent(tp.uv)?;
            let c = tau.normalize()?.dot(end_dir(&raws[b], e));
            if c.abs() < 0.5 {
                return None;
            }
            if c > 0.0 {
                ins.push((b, e));
            } else {
                outs.push((b, e));
            }
        }
        if ins.len() != outs.len() || ins.is_empty() {
            return None;
        }
        // Travel budget: a few times the spread of the ends.
        let mut spread: f64 = 0.0;
        for &(b1, e1) in ends {
            for &(b2, e2) in ends {
                spread = spread.max(end_tp(&raws[b1], e1).p.distance(end_tp(&raws[b2], e2).p));
            }
        }
        let budget = (8.0 * spread + 1e3 * self.match_dist()).min(0.5 * self.len);
        let targets: Vec<(Tp, Vec2)> = outs
            .iter()
            .map(|&(b, e)| (end_tp(&raws[b], e), end_dir(&raws[b], e)))
            .collect();
        let mut used = vec![false; outs.len()];
        let mut joins = Vec::new();
        for (b, e) in ins {
            let (j, mut path) = self.hairpin(end_tp(&raws[b], e), &targets, budget)?;
            if used[j] {
                return None;
            }
            used[j] = true;
            path.pop();
            joins.push(((b, e), outs[j], path));
        }
        Some(joins)
    }

    /// Orientation-locked trace (raw tangent `perp(∇G)`, sign +1) from `from` until it
    /// arrives at one of `targets` (`(end point, direction into its cluster)`), within
    /// `budget` of travel. Returns the target index and the path (ending at the target).
    fn hairpin(&self, from: Tp, targets: &[(Tp, Vec2)], budget: f64) -> Option<(usize, Vec<Tp>)> {
        let mut uv = from.uv;
        let mut d = self.tangent(uv)?.0;
        let floor = 1e-10 * self.len.max(1e-300);
        let h_max = (budget / 64.0).max(floor);
        let mut h = (1e-2 * budget).clamp(floor, h_max);
        let mut p = from.p;
        let mut out: Vec<Tp> = Vec::new();
        let mut travelled = 0.0;
        for _ in 0..400_000 {
            // Arrival: the target is within one step ahead and we travel into its branch.
            for (j, (tp, into_cluster)) in targets.iter().enumerate() {
                let to = tp.p - p;
                let near = to.norm() <= (1.5 * h).max(self.match_dist());
                if near && d.dot(*into_cluster) < 0.0 {
                    out.push(*tp);
                    return Some((j, out));
                }
            }
            if travelled > budget {
                return None;
            }
            let pred = uv + d * h;
            let accepted = self.correct_strict(pred, h).and_then(|c| {
                let q = self.p.surf.eval(c.x, c.y);
                let (tn, _) = self.tangent(c)?;
                let turn = d.normalize()?.dot(tn.normalize()?);
                let jumped = q.distance(self.p.surf.eval(pred.x, pred.y)) > 0.2 * h
                    || q.distance(p) > 1.5 * h;
                (turn >= 0.97 && !jumped).then_some((c, q, tn))
            });
            let Some((c, q, tn)) = accepted else {
                h *= 0.5;
                if h < floor {
                    return None;
                }
                continue;
            };
            travelled += q.distance(p);
            uv = c;
            p = q;
            d = tn;
            out.push(Tp { uv: c, p: q });
            h = (h * 1.5).min(h_max);
        }
        None
    }
}

/// Resolve every cluster: isolated contacts, singular vertices, pass-throughs.
pub(crate) fn resolve_clusters(
    m: &mut March<'_>,
    raws: Vec<RawBranch>,
    clusters: &[Vec<usize>],
) -> Result<Assembled, SsiError> {
    let fit = m.ctx.tol.fit;
    let mut leaf_cluster = vec![usize::MAX; m.cells.len()];
    for (ci, cells) in clusters.iter().enumerate() {
        for &c in cells {
            leaf_cluster[c] = ci;
        }
    }
    let raws = split_at_crossings(m, raws, clusters, fit);
    // Ends per cluster: (branch, end index).
    let mut ends: Vec<Vec<(usize, usize)>> = vec![Vec::new(); clusters.len()];
    for (bi, rb) in raws.iter().enumerate() {
        if rb.closed {
            continue;
        }
        for e in 0..2 {
            let cl = match rb.ends[e] {
                RawEnd::Cluster(l) => Some(leaf_cluster[l]),
                RawEnd::Stuck => {
                    let tp = if e == 0 {
                        rb.pts[0]
                    } else {
                        *rb.pts.last().expect("pts")
                    };
                    nearest_cluster(m, clusters, tp.uv)
                }
                RawEnd::Domain => None,
            };
            match (rb.ends[e], cl) {
                (RawEnd::Domain, _) => {}
                (_, Some(c)) if c != usize::MAX => ends[c].push((bi, e)),
                (_, _) => {
                    let tp = if e == 0 {
                        rb.pts[0]
                    } else {
                        *rb.pts.last().expect("pts")
                    };
                    return Err(not_converged(
                        "march",
                        tp.p,
                        m.g.eval(tp.uv.x, tp.uv.y).abs(),
                        0,
                    ));
                }
            }
        }
    }
    let mut raws = raws;
    let mut end_info: Vec<[EndInfo; 2]> = vec![[EndInfo::Domain, EndInfo::Domain]; raws.len()];
    // Joins between branch ends: (b1, e1) <-> (b2, e2) with the connecting path.
    let mut joins: Vec<Join> = Vec::new();
    let mut points = Vec::new();
    // Branch ends of odd clusters, paired across clusters at the end.
    let mut deferred: Vec<(usize, usize)> = Vec::new();
    for (ci, cells) in clusters.iter().enumerate() {
        let info = m.cluster_info(cells);
        let special = m
            .specials
            .iter()
            .find(|s| cells.iter().any(|&c| special_in_cell(m, s, c)))
            .copied();
        let k = ends[ci].len();
        if std::env::var_os("FORGE_SSI_DEBUG").is_some() {
            eprintln!(
                "cluster {ci}: {} cells, extent {:e}, k {k}, special {}, saddle {:?}",
                cells.len(),
                info.extent,
                special.is_some(),
                m.cluster_saddle(&info)
            );
            for &(b, e) in &ends[ci] {
                let tp = end_tp(&raws[b], e);
                let dir = end_dir(&raws[b], e);
                let t = m
                    .tangent(tp.uv)
                    .map(|x| x.0.normalize().map(|y| y.dot(dir)));
                eprintln!("   end ({b},{e}) p {:?} cos {:?}", tp.p, t);
            }
        }
        let (core_uv, gap) = match special {
            Some(s) => {
                let uv = if s.row.is_some() {
                    m.cells[cells[0]].centre()
                } else {
                    s.uv
                };
                (uv, dist(m.q.surf, s.p).abs())
            }
            None => m.cluster_core(&info),
        };
        let core_p = special.map_or_else(|| m.p.surf.eval(core_uv.x, core_uv.y), |s| s.p);
        // A contact region clearly outside Q's box does not matter: its branch ends stay
        // domain ends (the branches are clipped to the box).
        if k == 0 && outside_q(m, core_p) {
            continue;
        }
        if k == 0 {
            if gap <= fit {
                if info.extent > 1e3 * m.h_min.max(1e-12) {
                    return Err(unresolved(m, core_p, core_uv, gap, info.extent, 0));
                }
                points.push(pre_vertex(
                    m,
                    core_p,
                    core_uv,
                    if special.is_some() {
                        VertexKind::SurfaceSingularity
                    } else {
                        VertexKind::TangentPoint
                    },
                    gap,
                ));
            } else if !m.certify_empty(&info) {
                return Err(unresolved(m, core_p, core_uv, gap, info.extent, 0));
            }
            continue;
        }
        // Two ends at a true crossing (a saddle of `G` on both surfaces) that meet at an
        // angle are two arms of the crossing whose other arms leave the box right there
        // (a crossing on the box edge): they end at a vertex, not joined through a kink.
        let kinked_crossing = k == 2 && special.is_none() && {
            let (b1, e1) = ends[ci][0];
            let (b2, e2) = ends[ci][1];
            let (d1, d2) = (end_dir(&raws[b1], e1), end_dir(&raws[b2], e2));
            d1.dot(-d2) < 0.866
                && m.cluster_saddle(&info)
                    .is_some_and(|(_, g)| g <= 0.25 * fit)
        };
        if k == 2 && special.is_none() && !kinked_crossing {
            let (b1, e1) = ends[ci][0];
            let (b2, e2) = ends[ci][1];
            let from = end_tp(&raws[b1], e1);
            let dir = end_dir(&raws[b1], e1);
            if let Some(path) = m.pass_through(from, dir, &info, None) {
                let target = end_tp(&raws[b2], e2);
                let last = path.last().copied().unwrap_or(from);
                if last.p.distance(target.p) <= 4.0 * info.extent.max(m.match_dist()) {
                    let mut path = path;
                    path.pop();
                    joins.push(((b1, e1), (b2, e2), path));
                    m.uncertified = true;
                    continue;
                }
            }
        }
        // Near-crossings (open issue 1): the curves pass by a saddle of `G` whose value
        // is clearly off zero, so the branches do not meet there. Pair the ends by
        // orientation-locked pass-throughs; a true (tangential) crossing, where the
        // saddle lies on both surfaces within `fit / 4`, stays a singular vertex.
        if k >= 2 && k.is_multiple_of(2) && special.is_none() {
            let near_crossing = m.cluster_saddle(&info).is_none_or(|(_, g)| g > 0.25 * fit);
            if near_crossing && let Some(js) = m.pair_locked(&raws, &ends[ci], &info) {
                joins.extend(js);
                m.uncertified = true;
                continue;
            }
        }
        // An odd number of branch ends and no surface singularity: the zero set of a
        // regular `G` has no odd vertex, so the curve leaves this cluster through another
        // one (the hairpin tip of a thin lens, tangent-band clusters along its sides).
        // A vertex here would be a dangling curve end; the ends are paired across
        // clusters after the loop.
        // Except at a true crossing (a saddle of `G` on both surfaces) on the edge of P's
        // box: one of its arms leaves the box there, the others meet at a vertex.
        let crossing_on_edge = || {
            let Some((suv, g)) = m.cluster_saddle(&info) else {
                return false;
            };
            if g > 0.25 * fit {
                return false;
            }
            let d = m.p.dom;
            let (su, sv) = (1e-4 * (d.u.1 - d.u.0), 1e-4 * (d.v.1 - d.v.0));
            let q = m.canonical(suv);
            let near_u = !m.full_u && ((q.x - d.u.0).abs() <= su || (q.x - d.u.1).abs() <= su);
            let near_v = !m.full_v && ((q.y - d.v.0).abs() <= sv || (q.y - d.v.1).abs() <= sv);
            near_u || near_v
        };
        if !k.is_multiple_of(2) && special.is_none() && !crossing_on_edge() {
            deferred.extend(ends[ci].iter().copied());
            continue;
        }
        if gap > fit {
            if outside_q(m, core_p) {
                continue;
            }
            return Err(unresolved(m, core_p, core_uv, gap, info.extent, k));
        }
        let kind = if special.is_some() {
            VertexKind::SurfaceSingularity
        } else {
            VertexKind::Singular
        };
        let v = pre_vertex(m, core_p, core_uv, kind, gap);
        for &(b, e) in &ends[ci] {
            let tp = end_tp(&raws[b], e);
            // Parameters of the core on P along this branch (for rows: the branch's u).
            let cuv = match special.and_then(|s| s.row) {
                Some(row) => Point2::new(tp.uv.x, row),
                None => core_uv + unwrap_shift(m, tp.uv, core_uv),
            };
            let mut extra = if special.is_some() {
                Vec::new()
            } else {
                m.approach(tp, core_p, cuv)
            };
            extra.push(Tp { uv: cuv, p: core_p });
            let rb = &mut raws[b];
            if e == 0 {
                for x in extra {
                    rb.pts.insert(0, x);
                }
            } else {
                rb.pts.extend(extra);
            }
            end_info[b][e] = EndInfo::Vertex(v);
        }
    }
    deferred.retain(|&(b, e)| !outside_q(m, end_tp(&raws[b], e).p));
    if !deferred.is_empty() {
        match m.pair_across(&raws, &deferred) {
            Some(js) => {
                joins.extend(js);
                m.uncertified = true;
            }
            None => {
                let (b, e) = deferred[0];
                let tp = end_tp(&raws[b], e);
                let gap = m.g.eval(tp.uv.x, tp.uv.y).abs();
                return Err(unresolved(m, tp.p, tp.uv, gap, 0.0, deferred.len()));
            }
        }
    }
    Ok(Assembled {
        branches: chain(raws, end_info, joins),
        points,
    })
}

/// A true branch crossing (a saddle of `G` lying on both surfaces within `fit / 4`) must
/// be a vertex of every branch through it. A trace can pass a small irregular cluster
/// through a neighbouring cell without entering it; such a branch is split at its point
/// nearest the saddle, so the cluster sees all its branch ends (a closed branch is
/// opened there).
fn split_at_crossings(
    m: &March<'_>,
    mut raws: Vec<RawBranch>,
    clusters: &[Vec<usize>],
    fit: f64,
) -> Vec<RawBranch> {
    for cells in clusters {
        if m.specials
            .iter()
            .any(|s| cells.iter().any(|&c| special_in_cell(m, s, c)))
        {
            continue;
        }
        let info = m.cluster_info(cells);
        let Some((core, g)) = m.cluster_saddle(&info) else {
            continue;
        };
        if g > 0.25 * fit {
            continue;
        }
        let core_p = m.p.surf.eval(core.x, core.y);
        let reach = 4.0 * info.extent.max(m.match_dist());
        if std::env::var_os("FORGE_SSI_DEBUG").is_some() {
            for (bi, rb) in raws.iter().enumerate() {
                let d = rb
                    .pts
                    .iter()
                    .map(|t| t.p.distance(core_p))
                    .fold(f64::INFINITY, f64::min);
                eprintln!(
                    "raw {bi}: {} pts closed {} ends {:?} first {:?} last {:?} nearest {d:e}",
                    rb.pts.len(),
                    rb.closed,
                    rb.ends,
                    rb.pts.first().map(|t| t.p),
                    rb.pts.last().map(|t| t.p)
                );
            }
        }
        let leaf = cells[0];
        let mut out: Vec<RawBranch> = Vec::with_capacity(raws.len() + 2);
        for rb in raws {
            let n = rb.pts.len();
            if n < 3 {
                out.push(rb);
                continue;
            }
            // Distance of each segment to the core.
            let seg: Vec<(f64, usize)> = (0..n - 1)
                .map(|i| {
                    let (a, b) = (rb.pts[i].p, rb.pts[i + 1].p);
                    let ab = b - a;
                    let l2 = ab.norm_squared();
                    let s = if l2 > 0.0 {
                        ((core_p - a).dot(ab) / l2).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    (
                        (a + ab * s).distance(core_p),
                        if s < 0.5 { i } else { i + 1 },
                    )
                })
                .collect();
            // Visits: maximal runs of segments within reach; a visit touching an end that
            // already lies in this cluster is that end, every other visit is a pass-by.
            let in_here = |e: RawEnd| matches!(e, RawEnd::Cluster(l) if cells.contains(&l));
            let mut cuts: Vec<usize> = Vec::new();
            let mut i = 0;
            while i < seg.len() {
                if seg[i].0 > reach {
                    i += 1;
                    continue;
                }
                let run_start = i;
                let mut best = seg[i];
                while i < seg.len() && seg[i].0 <= reach {
                    if seg[i].0 < best.0 {
                        best = seg[i];
                    }
                    i += 1;
                }
                let touches_start = run_start == 0;
                let touches_end = i == seg.len();
                let is_end = !rb.closed
                    && ((touches_start && in_here(rb.ends[0]))
                        || (touches_end && in_here(rb.ends[1])));
                if !is_end && best.1 > 0 && best.1 + 1 < n {
                    cuts.push(best.1);
                }
            }
            if cuts.is_empty() {
                out.push(rb);
                continue;
            }
            if rb.closed {
                // Open the loop at the first cut, then split at the others.
                let c0 = cuts[0];
                let mut pts: Vec<Tp> = rb.pts[c0..n - 1].to_vec();
                pts.extend_from_slice(&rb.pts[..=c0]);
                let shift = n - 1 - c0;
                let rest: Vec<usize> = cuts[1..].iter().map(|&c| c + shift).collect();
                let mut prev = 0;
                for &c in rest.iter().chain(std::iter::once(&(pts.len() - 1))) {
                    out.push(RawBranch {
                        pts: pts[prev..=c].to_vec(),
                        ends: [RawEnd::Cluster(leaf), RawEnd::Cluster(leaf)],
                        closed: false,
                    });
                    prev = c;
                }
            } else {
                let mut prev = 0;
                let mut first_end = rb.ends[0];
                for &c in &cuts {
                    out.push(RawBranch {
                        pts: rb.pts[prev..=c].to_vec(),
                        ends: [first_end, RawEnd::Cluster(leaf)],
                        closed: false,
                    });
                    prev = c;
                    first_end = RawEnd::Cluster(leaf);
                }
                out.push(RawBranch {
                    pts: rb.pts[prev..].to_vec(),
                    ends: [first_end, rb.ends[1]],
                    closed: false,
                });
            }
        }
        raws = out;
    }
    raws
}

/// Shift that brings `core` (canonical) next to the unwrapped `uv` of a branch end.
fn unwrap_shift(m: &March<'_>, uv: Point2, core: Point2) -> Vec2 {
    let c = m.canonical(uv);
    let mut s = uv - c;
    // Core and end are in the same cluster; if the canonical core is across the seam,
    // move it by a period.
    if m.full_u {
        let du = (core.x + s.x) - uv.x;
        if du > math::PI {
            s.x -= math::TAU;
        } else if du < -math::PI {
            s.x += math::TAU;
        }
    }
    if m.full_v {
        let dv = (core.y + s.y) - uv.y;
        if dv > math::PI {
            s.y -= math::TAU;
        } else if dv < -math::PI {
            s.y += math::TAU;
        }
    }
    s
}

fn special_in_cell(m: &March<'_>, s: &crate::ssi::march::Special, c: usize) -> bool {
    let cell = m.cells[c];
    match s.row {
        Some(r) => r >= cell.v.0 - 1e-12 && r <= cell.v.1 + 1e-12,
        None => {
            let uv = m.canonical(s.uv);
            cell.contains(uv)
                || ((uv.x - cell.u.0).abs() <= 1e-12 || (uv.x - cell.u.1).abs() <= 1e-12)
                    && uv.y >= cell.v.0 - 1e-12
                    && uv.y <= cell.v.1 + 1e-12
        }
    }
}

fn nearest_cluster(m: &March<'_>, clusters: &[Vec<usize>], uv: Point2) -> Option<usize> {
    let c = m.canonical(uv);
    // Distance from `x` to `[lo, hi]`, across the seam of a direction that covers a full
    // period: a branch stuck just below the window's end (`u₀ + 2π − ε`) is next to a cluster
    // at its start (`u₀`), e.g. a tangent point of two cylinders on `P`'s seam (boolean seed
    // 53 #38, #387).
    let gap = |x: f64, (lo, hi): (f64, f64), full: bool| -> f64 {
        let d = |x: f64| (lo - x).max(x - hi).max(0.0);
        if full {
            d(x).min(d(x - math::TAU)).min(d(x + math::TAU))
        } else {
            d(x)
        }
    };
    let mut best = (usize::MAX, f64::INFINITY);
    for (ci, cells) in clusters.iter().enumerate() {
        for &l in cells {
            let cell = m.cells[l];
            let du = gap(c.x, cell.u, m.full_u);
            let dv = gap(c.y, cell.v, m.full_v);
            let d = math::hypot(du, dv);
            if d < best.1 {
                best = (ci, d);
            }
        }
    }
    let tol = 1e-3 * (m.p.dom.u.1 - m.p.dom.u.0).max(m.p.dom.v.1 - m.p.dom.v.0);
    (best.1 <= tol).then_some(best.0)
}

fn end_tp(rb: &RawBranch, e: usize) -> Tp {
    if e == 0 {
        rb.pts[0]
    } else {
        *rb.pts.last().expect("pts")
    }
}

/// Direction (in `P`'s parameters) pointing out of the branch at end `e`.
fn end_dir(rb: &RawBranch, e: usize) -> Vec2 {
    let n = rb.pts.len();
    let (a, b) = if e == 0 {
        (rb.pts[1].uv, rb.pts[0].uv)
    } else {
        (rb.pts[n - 2].uv, rb.pts[n - 1].uv)
    };
    (b - a).normalize().unwrap_or(Vec2::unit_x())
}

/// `true` if `p` lies clearly outside `Q`'s parameter box (by more than a thousandth of
/// its size): what happens there is clipped away with the branches anyway.
fn outside_q(m: &March<'_>, p: Point3) -> bool {
    let (qu, qv) = m.q.refs();
    let uv = uv_near(m.q.surf, p, qu, qv);
    let d = m.q.dom;
    let slack = [1e-3 * (d.u.1 - d.u.0), 1e-3 * (d.v.1 - d.v.0)];
    !d.contains(m.q.surf, uv, slack)
}

fn unresolved(m: &March<'_>, p: Point3, uv: Point2, gap: f64, extent: f64, k: usize) -> SsiError {
    let (uv_a, uv_b) = pair_uv(m, uv, p);
    SsiError::TangentUnresolved {
        point: p.to_array(),
        uv_a: uv_a.to_array(),
        uv_b: uv_b.to_array(),
        gap,
        extent,
        branch_ends: k,
    }
}

/// `(uv on a, uv on b)` of a point with `P`-parameters `uv`.
fn pair_uv(m: &March<'_>, uv: Point2, p: Point3) -> (Point2, Point2) {
    let (qu, qv) = m.q.refs();
    let q = uv_near(m.q.surf, p, qu, qv);
    if m.p_is_a { (uv, q) } else { (q, uv) }
}

fn pre_vertex(m: &March<'_>, p: Point3, uv: Point2, kind: VertexKind, gap: f64) -> PreVertex {
    let (a, b) = pair_uv(m, uv, p);
    PreVertex {
        point: p,
        uv: [a, b],
        kind,
        contact: Contact::Tangent { gap },
    }
}

/// Chain raw branches through pass-through joins into resolved branches.
fn chain(raws: Vec<RawBranch>, end_info: Vec<[EndInfo; 2]>, joins: Vec<Join>) -> Vec<Resolved> {
    let n = raws.len();
    // partner[b][e] = Some((b2, e2, path from (b,e) to (b2,e2)))
    let mut partner: Vec<[Option<Partner>; 2]> = vec![[None, None]; n];
    for ((b1, e1), (b2, e2), path) in joins {
        let mut rev = path.clone();
        rev.reverse();
        partner[b1][e1] = Some((b2, e2, path));
        partner[b2][e2] = Some((b1, e1, rev));
    }
    let mut used = vec![false; n];
    let mut out = Vec::new();
    for s in 0..n {
        if used[s] {
            continue;
        }
        if raws[s].closed {
            used[s] = true;
            out.push(Resolved {
                pts: raws[s].pts.clone(),
                closed: true,
                ends: [EndInfo::Domain, EndInfo::Domain],
            });
            continue;
        }
        // Walk back to a chain start (an end without partner), detecting loops.
        let (mut b, mut e) = (s, 0usize);
        let mut guard = 0;
        while let Some((pb, pe, _)) = &partner[b][e] {
            let (nb, ne) = (*pb, 1 - *pe);
            guard += 1;
            if nb == s || guard > n {
                break;
            }
            b = nb;
            e = ne;
        }
        // Now walk forward from (b, e) (the chain's start end).
        let start = (b, e);
        let mut pts: Vec<Tp> = Vec::new();
        let first_end = end_info[b][e];
        let mut last_end;
        let mut closed = false;
        let (mut cb, mut ce) = start;
        loop {
            used[cb] = true;
            let mut seg = raws[cb].pts.clone();
            if ce == 1 {
                seg.reverse();
            }
            if !pts.is_empty() {
                seg.remove(0);
            }
            pts.extend(seg);
            let exit = 1 - ce;
            last_end = end_info[cb][exit];
            match &partner[cb][exit] {
                Some((nb, ne, path)) => {
                    pts.extend(path.iter().copied());
                    if (*nb, *ne) == start {
                        closed = true;
                        break;
                    }
                    if used[*nb] {
                        break;
                    }
                    cb = *nb;
                    ce = *ne;
                }
                None => break,
            }
        }
        out.push(Resolved {
            pts,
            closed,
            ends: [first_end, last_end],
        });
    }
    out
}

// ---------------------------------------------------------------------------------------
// Fitting of marched branches

/// Exact node of the intersection curve at `P`-parameters `uv_p`.
pub(crate) fn node_from_uv(
    m: &March<'_>,
    uv_p: Point2,
    t: f64,
    prev: [Point2; 2],
    hint: Vec3,
) -> Node {
    let (ip, iq) = if m.p_is_a { (0, 1) } else { (1, 0) };
    let p = m.p.surf.eval(uv_p.x, uv_p.y);
    let np = m.p.surf.normal(uv_p.x, uv_p.y).unwrap_or(Vec3::zero());
    let gq = m.q.surf.distance_form_grad(p).unwrap_or(Vec3::zero());
    let cross = np.cross(gq);
    let mut d = if cross.norm() > 1e-9 {
        cross / cross.norm()
    } else {
        hint.normalize().unwrap_or(Vec3::unit_x())
    };
    if d.dot(hint) < 0.0 {
        d = -d;
    }
    let mut uv = [Point2::zero(); 2];
    uv[ip] = uv_p;
    let qr = prev[iq];
    let mut uq = uv_near(m.q.surf, p, qr.x, qr.y);
    if singular_param(m.q.surf, uq) {
        uq.x = qr.x;
    }
    uv[iq] = uq;
    // Curvature vector (arc length): ∇F·C'' = −C'ᵀ H_F C' for both distance forms and
    // C'·C'' = 0; directional second derivatives by nested duals.
    let dd = {
        use forge_core::scalar::Dual;
        let lift = |a: f64| Dual::constant(Dual::constant(a));
        let s = Dual::new(Dual::new(0.0, 1.0), Dual::new(1.0, 0.0));
        let q = Vec3::new(
            lift(p.x) + s * lift(d.x),
            lift(p.y) + s * lift(d.y),
            lift(p.z) + s * lift(d.z),
        );
        let row = |surf: &forge_core::geom::Surface| -> Option<(Vec3, f64)> {
            let g = surf.distance_form_grad(p)?;
            let h = surf.distance_form(q)?.d.d;
            (g.is_finite() && h.is_finite()).then_some((g, -h))
        };
        match (row(m.p.surf), row(m.q.surf)) {
            (Some((g1, r1)), Some((g2, r2))) => {
                solve3([g1, g2, d], [r1, r2, 0.0]).unwrap_or(Vec3::zero())
            }
            _ => Vec3::zero(),
        }
    };
    let mut duv = [Vec2::zero(); 2];
    let mut dduv = [Vec2::zero(); 2];
    let nan = Vec2::new(f64::NAN, f64::NAN);
    for k in 0..2 {
        let s = if k == ip { m.p.surf } else { m.q.surf };
        match uv_derivative(s, uv[k], d) {
            Some(g) => {
                duv[k] = g;
                dduv[k] = uv_second(s, uv[k], g, dd).unwrap_or(nan);
            }
            None => {
                duv[k] = nan;
                dduv[k] = nan;
            }
        }
    }
    Node {
        t,
        p,
        d,
        dd,
        uv,
        duv,
        dduv,
    }
}

/// Arc length between two nodes with unit tangents, estimated by the circular arc with
/// the same chord and turning angle (`c·(θ/2)/sin(θ/2)`, exact for circles).
fn arc_estimate(a: &Node, b: &Node) -> f64 {
    let c = a.p.distance(b.p);
    let cos = a.d.dot(b.d).clamp(-1.0, 1.0);
    let half = 0.5 * math::acos(cos);
    if half < 1e-8 {
        c
    } else {
        c * half / math::sin(half)
    }
}

/// Solve the 3×3 system with the given rows (Cramer's rule); `None` if singular.
fn solve3(rows: [Vec3; 3], rhs: [f64; 3]) -> Option<Vec3> {
    let [a, b, c] = rows;
    let det = a.dot(b.cross(c));
    let scale = a.norm() * b.norm() * c.norm();
    if det.is_nan() || det.abs() <= 1e-12 * scale {
        return None;
    }
    // x = (rhs₀ (b×c) + rhs₁ (c×a) + rhs₂ (a×b)) / det
    Some((b.cross(c) * rhs[0] + c.cross(a) * rhs[1] + a.cross(b) * rhs[2]) / det)
}

/// Fill undefined parameter derivatives (singular points) by finite differences.
fn fill_duv(nodes: &mut [Node]) {
    let n = nodes.len();
    for i in 0..n {
        for k in 0..2 {
            if nodes[i].duv[k].is_finite() && nodes[i].dduv[k].is_finite() {
                continue;
            }
            let (a, b) = if i + 1 < n { (i, i + 1) } else { (i - 1, i) };
            let dt = nodes[b].t - nodes[a].t;
            if !nodes[i].duv[k].is_finite() {
                nodes[i].duv[k] = if dt != 0.0 {
                    (nodes[b].uv[k] - nodes[a].uv[k]) / dt
                } else {
                    Vec2::zero()
                };
            }
            // Second derivative at a parametric singularity: consistent with the chord
            // (a quadratic through the neighbour).
            let other = if i + 1 < n { b } else { a };
            let h = nodes[other].t - nodes[i].t;
            nodes[i].dduv[k] = if h != 0.0 && !nodes[i].dduv[k].is_finite() {
                (nodes[other].uv[k] - nodes[i].uv[k] - nodes[i].duv[k] * h) * (2.0 / (h * h))
            } else if nodes[i].dduv[k].is_finite() {
                nodes[i].dduv[k]
            } else {
                Vec2::zero()
            };
        }
    }
}

/// Node source for marched branches: Hermite guess, projected onto `G = 0` along the
/// normal of the chord in `P`'s parameters.
struct MarchNodes<'m, 'a> {
    m: &'m March<'a>,
}

impl MarchNodes<'_, '_> {
    /// Fast path: project the Hermite guess at `t` onto the curve along the normal of
    /// the `P`-parameter chord `lo → hi` (keeps the node near the middle of the arc).
    /// `None` if Newton leaves the half-chord window or does not converge.
    fn project_on_chord_normal(&self, lo: &Node, hi: &Node, t: f64) -> Option<Point2> {
        let m = self.m;
        let ip = if m.p_is_a { 0 } else { 1 };
        let guess = hermite2(lo, hi, ip, t);
        let chord = hi.uv[ip] - lo.uv[ip];
        let nrm = chord.perp().normalize().unwrap_or(Vec2::unit_y());
        let lim = 0.5 * chord.norm();
        let mut s = 0.0;
        for _ in 0..40 {
            let x = guess + nrm * s;
            let (g, gr) = m.g.grad(x);
            let dg = gr.dot(nrm);
            if dg == 0.0 || !dg.is_finite() {
                return None;
            }
            let step = g / dg;
            s -= step;
            if s.abs() > lim {
                return None;
            }
            if step.abs() <= 1e-15 * (1.0 + x.norm()) || g.abs() <= 1e-13 * m.len {
                let x = guess + nrm * s;
                return (m.g.eval(x.x, x.y).abs() <= 1e-10 * m.len).then_some(x);
            }
        }
        None
    }

    /// Robust path: follow the curve from `lo` to `hi` with a step-controlled
    /// predictor–corrector (steps that jump — corrector moving far from the predictor,
    /// the tangent turning sharply or reversing its raw orientation — are halved), then
    /// return the point at fraction `frac` of the traced arc length. Used where the
    /// chord-normal line misses the arc: hairpins of thin lens-shaped curves at
    /// near-tangential contacts, near-crossings.
    fn retrace_to(&self, lo: &Node, hi: &Node, frac: f64) -> Option<Point2> {
        let m = self.m;
        let ip = if m.p_is_a { 0 } else { 1 };
        let chord = lo.p.distance(hi.p);
        let h_floor = 1e-9 * m.len.max(1e-300);
        let mut h = (0.125 * chord).max(h_floor);
        let mut x = lo.uv[ip];
        let mut p = lo.p;
        let orient = |t3: Vec3, prev: Vec3| if t3.dot(prev) < 0.0 { -1.0 } else { 1.0 };
        let (tau0, t3) = m.tangent(x)?;
        // The raw tangent perp(∇G) keeps its orientation along a regular branch; a
        // corrected point needing the opposite sign lies on another piece of the curve
        // (the far side of a thin lens, the other branch at a near-crossing): a jump.
        let sign = orient(t3, lo.d);
        let mut dir3 = t3 * sign;
        let mut tau = tau0 * sign;
        let mut pts: Vec<(Point2, Point3, f64)> = vec![(x, p, 0.0)];
        let mut arc = 0.0;
        for _ in 0..4000 {
            // Arrived: `hi` is within one step ahead.
            let to_hi = hi.p - p;
            if to_hi.norm() <= 1.5 * h && to_hi.dot(dir3) >= 0.0 {
                arc += to_hi.norm();
                pts.push((hi.uv[ip], hi.p, arc));
                break;
            }
            let pred = x + tau * h;
            let Some(y) = m.correct(pred) else {
                h *= 0.5;
                if h < h_floor {
                    return None;
                }
                continue;
            };
            let q = m.p.surf.eval(y.x, y.y);
            let (tau1, t31) = m.tangent(y)?;
            let jump = q.distance(m.p.surf.eval(pred.x, pred.y)) > 0.2 * h
                || (t31 * sign).dot(dir3) < 0.94
                || q.distance(p) > 1.5 * h;
            if jump {
                h *= 0.5;
                if h < h_floor {
                    return None;
                }
                continue;
            }
            arc += q.distance(p);
            x = y;
            p = q;
            dir3 = t31 * sign;
            tau = tau1 * sign;
            pts.push((x, p, arc));
            h = (h * 1.5).min(0.25 * chord.max(h_floor));
        }
        let (_, last_p, total) = *pts.last()?;
        if last_p.distance(hi.p) > 1e-9 * m.len.max(1.0) || total <= 0.0 {
            return None;
        }
        let half = frac.clamp(0.0, 1.0) * total;
        let k = pts.iter().position(|e| e.2 >= half)?;
        if k == 0 {
            return Some(pts[0].0);
        }
        let (a, b) = (pts[k - 1], pts[k]);
        let f = if b.2 > a.2 {
            (half - a.2) / (b.2 - a.2)
        } else {
            0.0
        };
        m.correct(a.0 + (b.0 - a.0) * f)
    }
}

impl NodeSource for MarchNodes<'_, '_> {
    fn node_at(&self, lo: &Node, hi: &Node, t: f64) -> Result<Node, SsiError> {
        let m = self.m;
        let hint = lo.d + hi.d;
        // Place the node at its arc-length position: split the span in proportion to
        // the estimated sub-arcs (keeps the parametrization consistent with the unit
        // tangents and curvature vectors of the nodes).
        let place = |x: Point2| -> (Node, f64) {
            let mut n = node_from_uv(m, x, t, lo.uv, hint);
            let (s1, s2) = (arc_estimate(lo, &n), arc_estimate(&n, hi));
            let f = if s1 > 0.0 && s2 > 0.0 {
                s1 / (s1 + s2)
            } else {
                0.5
            };
            n.t = lo.t + (hi.t - lo.t) * f.clamp(0.05, 0.95);
            (n, f)
        };
        // Requested position: fraction `f_req` of the span (the midpoint for refinement,
        // anywhere for a clip point).
        let f_req = if hi.t > lo.t {
            ((t - lo.t) / (hi.t - lo.t)).clamp(0.0, 1.0)
        } else {
            0.5
        };
        // Fast projection, unless the span turns by more than ~150° (a hairpin: the
        // chord-normal line may miss the arc). Its result is rejected if it lies on
        // another piece of the curve (raw tangent orientation perp(∇G) opposite to
        // `lo`'s, e.g. the far side of a thin lens) or far from the requested position
        // along the arc.
        let ip = if m.p_is_a { 0 } else { 1 };
        let raw_sign = |uv: Point2, d: Vec3| {
            m.tangent(uv)
                .map(|(_, t3)| if t3.dot(d) < 0.0 { -1.0 } else { 1.0 })
        };
        let sign_lo = raw_sign(lo.uv[ip], lo.d);
        let fast = if hint.norm() < 0.25 {
            None
        } else {
            self.project_on_chord_normal(lo, hi, t)
                .filter(|&x| sign_lo.is_some() && raw_sign(x, hint) == sign_lo)
                .map(place)
                .filter(|(_, f)| (f - f_req).abs() <= 0.4)
        };
        let (mut n, _) = match fast {
            Some(r) => r,
            None => match self.retrace_to(lo, hi, f_req) {
                Some(x) => place(x),
                None => {
                    // Neither applies when a span ends at a vertex that is within `fit`
                    // of both surfaces but off the exact curve (a contact cluster at the
                    // tip of a near-tangential lens, where the exact curve turns with a
                    // radius far below `fit`). The contract is distance to both surfaces,
                    // so the interpolated point itself is a valid node if it lies within
                    // `fit / 4` of Q (it is on P by construction); certification checks
                    // the fitted curve afterwards.
                    let guess = hermite2(lo, hi, ip, t);
                    let g = m.g.eval(guess.x, guess.y);
                    if g.abs() <= 0.25 * m.ctx.tol.fit {
                        place(guess)
                    } else {
                        return Err(not_converged(
                            "fit node projection",
                            m.p.surf.eval(guess.x, guess.y),
                            g.abs(),
                            40,
                        ));
                    }
                }
            },
        };
        let mut one = [n];
        fill_one(&mut one, lo, hi);
        n = one[0];
        Ok(n)
    }
}

fn fill_one(n: &mut [Node; 1], lo: &Node, hi: &Node) {
    for k in 0..2 {
        if !n[0].duv[k].is_finite() {
            n[0].duv[k] = (hi.uv[k] - lo.uv[k]) / (hi.t - lo.t);
        }
        if !n[0].dduv[k].is_finite() {
            n[0].dduv[k] = (hi.duv[k] - lo.duv[k]) / (hi.t - lo.t);
        }
    }
}

/// Fit a resolved branch, clip it to `Q`'s box and build the output branches.
pub(crate) fn fit_branch(
    m: &March<'_>,
    rb: &Resolved,
    stats: &mut SsiStats,
) -> Result<Vec<PreBranch>, SsiError> {
    if rb.pts.len() < 2 {
        return Ok(Vec::new());
    }
    let (ip, iq) = if m.p_is_a { (0, 1) } else { (1, 0) };
    let (qu, qv) = m.q.refs();
    // Nodes at the traced points, parametrized by (estimated) arc length.
    let mut nodes: Vec<Node> = Vec::with_capacity(rb.pts.len());
    let mut prev = [Point2::zero(); 2];
    prev[iq] = Point2::new(qu, qv);
    prev[ip] = rb.pts[0].uv;
    let np = rb.pts.len();
    // Orientation of the node tangents: the direction of travel. A chord shorter than
    // this is noise (the tracer can emit a point twice, e.g. at a box boundary) and must
    // not decide the sign; the previous node's tangent does then (tangent continuity).
    let degenerate = 1e-9 * m.len.max(1e-300);
    let first_hint = rb
        .pts
        .windows(2)
        .map(|w| w[1].p - w[0].p)
        .find(|c| c.norm() > degenerate)
        .unwrap_or(Vec3::zero());
    // A traced point a hair *behind* the previous node on its tangent line (within `fit`
    // of the line, at most a minimal cell back) records a stretch of curve already passed,
    // out of order. It happens where the curve grazes a cell edge (tangent to it within
    // ~1e-11 in the parameter, e.g. at `u = kπ/2` of an axis-aligned scene whose box start
    // is 1e-14 off the tangent line): the two edge crossings are a near-double root of `G`
    // along the edge, placed only to within `G`'s rounding (1e-7…1e-6 mm along the curve).
    // Kept, the point would reverse its node's tangent (the chord picks the sign) and the
    // fit would fail ("fit node projection"). Every traced point lies on the curve, so the
    // one out of order is dropped — or, for the branch's last point (an end, whose position
    // is kept), the nodes it lies behind; refinement adds nodes where they are needed.
    // (Shorter steps back are the duplicates of `degenerate` above, handled as before.)
    let backtracks = |last: &Node, p: Point3| -> bool {
        let c = p - last.p;
        let along = c.dot(last.d);
        -along > degenerate && -along <= m.h_min && (c - last.d * along).norm() <= m.ctx.tol.fit
    };
    // Index in `rb.pts` of each node.
    let mut kept: Vec<usize> = Vec::with_capacity(np);
    for i in 0..np {
        if let Some(last) = nodes.last()
            && backtracks(last, rb.pts[i].p)
        {
            if i + 1 < np {
                continue;
            }
            while nodes.len() > 1 && nodes.last().is_some_and(|l| backtracks(l, rb.pts[i].p)) {
                nodes.pop();
                kept.pop();
            }
            if let Some(last) = nodes.last() {
                prev = last.uv;
            }
        }
        let back = match kept.last() {
            Some(&j) => rb.pts[i].p - rb.pts[j].p,
            None => Vec3::zero(),
        };
        let hint = match nodes.last() {
            _ if back.norm() > degenerate => back,
            Some(last) => last.d,
            None => first_hint,
        };
        let mut node = node_from_uv(m, rb.pts[i].uv, 0.0, prev, hint);
        if let Some(last) = nodes.last() {
            node.t = last.t + arc_estimate(last, &node);
        }
        prev = node.uv;
        nodes.push(node);
        kept.push(i);
    }
    // Drop coincident consecutive nodes.
    nodes.dedup_by(|b, a| b.t - a.t <= 1e-12 * m.len);
    if nodes.len() < 2 {
        return Ok(Vec::new());
    }
    fill_duv(&mut nodes);
    let surfs = m.ctx.surfs();
    let src = MarchNodes { m };
    let mut opts = FitOptions {
        fit: m.ctx.tol.fit,
        need_3d: true,
        need_pcurve: [true, true],
        max_nodes: 100_000,
        min_span: 1e-10 * m.len,
        check_position: true,
    };
    let flags = [periodic_flags(surfs[0]), periodic_flags(surfs[1])];
    let nodes = densify_periodic(nodes, &src, flags, opts.max_nodes)?;
    let mut nodes = refine(nodes, &src, surfs, &HermiteRef, &opts)?;
    // Orient along n_a × n_b.
    let mid = nodes.len() / 2;
    let na = surfs[0]
        .normal(nodes[mid].uv[0].x, nodes[mid].uv[0].y)
        .unwrap_or(Vec3::zero());
    let nb = surfs[1]
        .normal(nodes[mid].uv[1].x, nodes[mid].uv[1].y)
        .unwrap_or(Vec3::zero());
    let mut ends = rb.ends;
    if nodes[mid].d.dot(na.cross(nb)) < 0.0 {
        let t_end = nodes.last().expect("nodes").t;
        nodes.reverse();
        for n in &mut nodes {
            n.t = t_end - n.t;
            n.d = -n.d;
            n.duv = [-n.duv[0], -n.duv[1]];
        }
        ends.swap(0, 1);
    }
    // Clip to Q's box on Q's pcurve (a cubic Bézier per span: convex-hull test, then
    // subdivision), which is within `fit` of the 3D curve.
    let t0 = nodes[0].t;
    let t1 = nodes.last().expect("nodes").t;
    let (pieces, whole) = clip_nodes(m, &nodes, iq, rb.closed);
    let mut out = Vec::new();
    for (a, b) in pieces {
        let closed = rb.closed && whole;
        // A piece of no length (the curve grazes the box, e.g. through a cone apex on its
        // bound) is no branch.
        if b - a <= opts.min_span {
            continue;
        }
        let mut sub = sub_nodes(&src, &nodes, a, b, t1 - t0, rb.closed)?;
        if !whole {
            // The clip points are new nodes: check the spans next to them.
            sub = refine(sub, &src, surfs, &HermiteRef, &opts)?;
        }
        // Certify; refine further if the certificate misses the tolerance.
        let mut attempt = 0;
        let (c3, pa, pb, bound) = loop {
            let c3 = nurbs3(&sub)?;
            let segs = bezier_segments(&c3);
            let mut worst: f64 = 0.0;
            for s in surfs {
                worst = worst.max(certify_curve(&segs, s, 0.5 * opts.fit, opts.fit).bound);
            }
            let pe = verify_pcurves(&sub, surfs, &HermiteRef);
            let bound = worst.max(pe[0]).max(pe[1]);
            if bound <= opts.fit {
                break (c3, nurbs2(&sub, 0)?, nurbs2(&sub, 1)?, bound);
            }
            attempt += 1;
            if attempt > 3 {
                return Err(SsiError::FitFailed {
                    what: "3d curve",
                    achieved: bound,
                    required: opts.fit,
                    spans: sub.len() - 1,
                });
            }
            opts.fit *= 0.25;
            sub = refine(sub, &src, surfs, &HermiteRef, &opts)?;
            opts.fit = m.ctx.tol.fit;
        };
        stats.spans += sub.len() - 1;
        let range = (sub[0].t, sub.last().expect("nodes").t);
        let curve = Curve3::BSpline(c3);
        let pc = [
            forge_core::geom::Curve2::BSpline(pa),
            forge_core::geom::Curve2::BSpline(pb),
        ];
        let (min_angle, sense) = angle_and_sense(m.ctx, &curve, range, &pc);
        let branch = Branch {
            curve,
            range,
            pcurve_a: pc[0].clone(),
            pcurve_b: pc[1].clone(),
            closed,
            contact: Contact::Transversal,
            sense,
            representation: Representation::Fitted,
            start: None,
            end: None,
            error_bound: bound,
            min_angle,
        };
        let end_vertex = |node: &Node, at_start: bool| -> PreVertex {
            let info = if at_start && (a - t0).abs() <= 1e-9 * m.len {
                Some(ends[0])
            } else if !at_start && (b - t1).abs() <= 1e-9 * m.len {
                Some(ends[1])
            } else {
                None
            };
            match info {
                Some(EndInfo::Vertex(v)) => PreVertex {
                    point: v.point,
                    uv: node.uv,
                    ..v
                },
                _ => PreVertex {
                    point: node.p,
                    uv: node.uv,
                    kind: VertexKind::DomainBoundary,
                    contact: Contact::Transversal,
                },
            }
        };
        let ends_v = if closed {
            None
        } else {
            let first = sub[0];
            let last = *sub.last().expect("nodes");
            Some([end_vertex(&first, true), end_vertex(&last, false)])
        };
        out.push(PreBranch {
            branch,
            ends: ends_v,
        });
    }
    Ok(out)
}

/// Pieces of a node list inside `Q`'s box, from the crossings of `Q`'s pcurve with the
/// box bounds; `(pieces, whole)` as for [`clip_to_patches`].
fn clip_nodes(m: &March<'_>, nodes: &[Node], iq: usize, closed: bool) -> (Vec<(f64, f64)>, bool) {
    let q = m.q.surf;
    let dom = m.q.dom;
    let full = [dom.full_u(q), dom.full_v(q)];
    let flags = periodic_flags(q);
    let t0 = nodes[0].t;
    let t1 = nodes.last().expect("nodes").t;
    let cuts = pcurve_box_crossings(nodes, iq, &dom, full, flags);
    let mut pts = vec![t0];
    pts.extend(cuts.iter().copied().filter(|&c| c > t0 && c < t1));
    pts.push(t1);
    let inside = |t: f64| {
        let i = nodes.partition_point(|n| n.t < t).clamp(1, nodes.len() - 1);
        let uv = hermite2(&nodes[i - 1], &nodes[i], iq, t);
        dom.contains(
            q,
            uv,
            [1e-12 * (1.0 + uv.x.abs()), 1e-12 * (1.0 + uv.y.abs())],
        )
    };
    let mut pieces: Vec<(f64, f64)> = Vec::new();
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        if b <= a || !inside(0.5 * a + 0.5 * b) {
            continue;
        }
        match pieces.last_mut() {
            Some(last) if crate::clip::same(last.1, a) => last.1 = b,
            _ => pieces.push((a, b)),
        }
    }
    let whole = pts.len() == 2 && pieces.len() == 1;
    if closed && pieces.len() >= 2 {
        let first = pieces[0];
        let last = *pieces.last().expect("pieces");
        if crate::clip::same(first.0, t0) && crate::clip::same(last.1, t1) {
            pieces.pop();
            pieces[0] = (last.0, first.1 + (t1 - t0));
        }
    }
    (pieces, whole)
}

/// The nodes of `[a, b]` (inserting exact nodes at the ends); for closed branches a
/// range may wrap past the end (`b > t_end`).
fn sub_nodes(
    src: &MarchNodes<'_, '_>,
    nodes: &[Node],
    a: f64,
    b: f64,
    period: f64,
    closed: bool,
) -> Result<Vec<Node>, SsiError> {
    let t_end = nodes.last().expect("nodes").t;
    let pick = |lo: f64, hi: f64, shift: f64| -> Result<Vec<Node>, SsiError> {
        let mut out = Vec::new();
        let eps = 1e-12 * (1.0 + t_end.abs());
        let at = |t: f64| -> Result<Node, SsiError> {
            if let Some(n) = nodes.iter().find(|n| (n.t - t).abs() <= eps) {
                return Ok(*n);
            }
            let i = nodes.partition_point(|n| n.t < t).clamp(1, nodes.len() - 1);
            src.node_at(&nodes[i - 1], &nodes[i], t)
        };
        let mut s = at(lo)?;
        s.t += shift;
        out.push(s);
        for n in nodes {
            if n.t > lo + eps && n.t < hi - eps {
                let mut n = *n;
                n.t += shift;
                out.push(n);
            }
        }
        let mut e = at(hi)?;
        e.t += shift;
        out.push(e);
        Ok(out)
    };
    if closed && b > t_end + 1e-12 * (1.0 + t_end.abs()) {
        let mut first = pick(a, t_end, 0.0)?;
        let mut second = pick(0.0, b - period, period)?;
        // Continue the (periodic) parameters of the second part from the first: shift
        // them by the net parameter change around the loop.
        let n0 = nodes[0];
        let nl = *nodes.last().expect("nodes");
        let shift = [nl.uv[0] - n0.uv[0], nl.uv[1] - n0.uv[1]];
        for n in &mut second {
            n.uv[0] += shift[0];
            n.uv[1] += shift[1];
        }
        first.pop();
        first.extend(second);
        return Ok(first);
    }
    pick(a, b, 0.0)
}
