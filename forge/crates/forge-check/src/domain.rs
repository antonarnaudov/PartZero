//! A face's trimmed parameter domain, reconstructed from its loops' pcurves.
//!
//! # Lifting
//! Pcurves live in the face surface's `(u, v)` space; values may lie outside the
//! canonical period. Each loop is walked coedge by coedge and **lifted** into one
//! continuous path:
//! - when the next pcurve starts one or more whole periods away from where the previous
//!   one ended (within [`PERIOD_EPS`]), it is shifted by those periods;
//! - any remaining gap is closed by a straight **gap segment**. A gap must be degenerate
//!   in 3D: either the vertex tolerance between two curve ends, or a stretch of a
//!   **singular line** (cone apex, sphere pole, spindle-torus axis point) where the
//!   surface collapses to a point. This is checked by sampling the segment on the
//!   surface.
//!
//! The lifted loop's net displacement is a whole number of periods: a loop that wraps
//! around a periodic direction (a ring on a cylinder) is **non-contractible**.
//!
//! # Orientation
//! Loops run with the face on their left seen from outside. In `(u, v)` the domain is
//! therefore on the left of the path when `sense` is true (`S_u × S_v` is the outward
//! direction) and on the right otherwise; `sigma = ±1` records this.

use forge_core::geom::{Curve2, Surface};
use forge_core::linalg::Vec2;
use forge_core::math;
use forge_core::topo::{Body, Face};

use crate::CheckError;

/// Two pcurve end points are a whole number of periods apart when the residual is at most
/// this (radians). Pcurves built by Forge meet exactly; this only absorbs rounding.
pub const PERIOD_EPS: f64 = 1e-9;

/// A piece of a lifted boundary path.
#[derive(Clone, Debug)]
pub(crate) enum PieceKind<'a> {
    /// A pcurve traversed from `t0` to `t1` (`t1 < t0` for reversed coedges).
    Pcurve { curve: &'a Curve2, t0: f64, t1: f64 },
    /// A straight segment `a → b` in `(u, v)` (parameter `s ∈ [0, 1]`).
    Segment { a: Vec2, b: Vec2 },
}

#[derive(Clone, Debug)]
pub(crate) struct Piece<'a> {
    pub kind: PieceKind<'a>,
    /// Added to the pcurve's values.
    pub shift: Vec2,
}

impl Piece<'_> {
    /// Parameter range in traversal order.
    pub fn range(&self) -> (f64, f64) {
        match self.kind {
            PieceKind::Pcurve { t0, t1, .. } => (t0, t1),
            PieceKind::Segment { .. } => (0.0, 1.0),
        }
    }
    /// `(uv, d uv / dt)` at parameter `t`.
    pub fn eval(&self, t: f64) -> (Vec2, Vec2) {
        match &self.kind {
            PieceKind::Pcurve { curve, .. } => {
                let [p, d, _] = curve.derivs2(t);
                (p + self.shift, d)
            }
            PieceKind::Segment { a, b } => (a.lerp(*b, t), *b - *a),
        }
    }
    pub fn start(&self) -> Vec2 {
        self.eval(self.range().0).0
    }
    pub fn end(&self) -> Vec2 {
        self.eval(self.range().1).0
    }
    /// Sub-intervals of the parameter range on which the piece is smooth (knot spans of
    /// a B-spline pcurve), in traversal order.
    pub fn spans(&self) -> Vec<(f64, f64)> {
        let (t0, t1) = self.range();
        let PieceKind::Pcurve {
            curve: Curve2::BSpline(b),
            ..
        } = &self.kind
        else {
            return vec![(t0, t1)];
        };
        let (lo, hi) = (t0.min(t1), t0.max(t1));
        let mut cuts: Vec<f64> = b
            .knots()
            .iter()
            .copied()
            .filter(|k| *k > lo && *k < hi)
            .collect();
        cuts.dedup_by(|a, b| a.to_bits() == b.to_bits());
        let mut pts = vec![lo];
        pts.extend(cuts);
        pts.push(hi);
        let mut spans: Vec<(f64, f64)> = pts.windows(2).map(|w| (w[0], w[1])).collect();
        if t1 < t0 {
            spans.reverse();
            for s in &mut spans {
                *s = (s.1, s.0);
            }
        }
        spans
    }
    /// `true` if the parameter itself is an angle (circle/ellipse pcurves).
    pub fn angular_parameter(&self) -> bool {
        matches!(
            self.kind,
            PieceKind::Pcurve {
                curve: Curve2::Circle(_) | Curve2::Ellipse(_),
                ..
            }
        )
    }
}

/// One lifted loop.
#[derive(Clone, Debug)]
pub(crate) struct LoopPath<'a> {
    pub pieces: Vec<Piece<'a>>,
    /// Net displacement in whole periods `(k_u, k_v)`.
    pub wraps: (i64, i64),
}

/// The reconstructed domain of a face.
#[derive(Clone, Debug)]
pub(crate) struct FaceDomain<'a> {
    pub surface: &'a Surface,
    /// +1 if the domain lies left of the paths in `(u, v)`, −1 otherwise.
    pub sigma: f64,
    pub loops: Vec<LoopPath<'a>>,
}

impl<'a> FaceDomain<'a> {
    pub fn pieces(&self) -> impl Iterator<Item = &Piece<'a>> {
        self.loops.iter().flat_map(|l| l.pieces.iter())
    }
    pub fn is_loopless(&self) -> bool {
        self.loops.is_empty()
    }
    /// `σ · Σ k_u`: +1 if the domain extends (in the positively oriented sense) above its
    /// u-wrapping boundary towards larger `v`, −1 towards smaller `v`, 0 for a band or a
    /// contractible domain.
    pub fn winding_u(&self) -> i64 {
        let s: i64 = self.loops.iter().map(|l| l.wraps.0).sum();
        if self.sigma > 0.0 { s } else { -s }
    }
    pub fn winding_v(&self) -> i64 {
        let s: i64 = self.loops.iter().map(|l| l.wraps.1).sum();
        if self.sigma > 0.0 { s } else { -s }
    }
    pub fn wraps_u(&self) -> bool {
        self.loops.iter().any(|l| l.wraps.0 != 0)
    }
    pub fn wraps_v(&self) -> bool {
        self.loops.iter().any(|l| l.wraps.1 != 0)
    }
    /// Smallest and largest `v` over the piece end points.
    pub fn v_extent(&self) -> (f64, f64) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for p in self.pieces() {
            for q in [p.start(), p.end()] {
                lo = lo.min(q.y);
                hi = hi.max(q.y);
            }
        }
        (lo, hi)
    }
    /// Smallest and largest `u` over the piece end points.
    pub fn u_extent(&self) -> (f64, f64) {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for p in self.pieces() {
            for q in [p.start(), p.end()] {
                lo = lo.min(q.x);
                hi = hi.max(q.x);
            }
        }
        (lo, hi)
    }
}

/// Values of `v` on which the surface collapses to a point (`S_u = 0` along the whole
/// line): cone apex, sphere poles, the axis points of a spindle-torus patch, the centre
/// of a horn torus (every `π + 2πk`, reported for `k = −1, 0, 1`).
pub(crate) fn singular_v(surface: &Surface) -> Vec<f64> {
    match surface {
        Surface::Cone(c) => vec![c.apex_v()],
        Surface::Sphere(_) => vec![-math::FRAC_PI_2, math::FRAC_PI_2],
        Surface::Torus(t) => {
            if let Some((a, b)) = t.spindle_v_range() {
                vec![a, b]
            } else if (t.minor() - t.major()).abs() <= 0.0 {
                vec![-math::PI, math::PI, 3.0 * math::PI]
            } else {
                Vec::new()
            }
        }
        _ => Vec::new(),
    }
}

/// Reconstruct the domain of `face`. `gap_tol` bounds the 3D extent of gap segments.
pub(crate) fn face_domain<'a>(
    body: &'a Body,
    face: &'a Face,
    gap_tol: f64,
) -> Result<FaceDomain<'a>, CheckError> {
    let fname = || face.provenance.name();
    let (pu, pv) = face.surface.periodicity();
    let periods = [pu, pv];
    let mut loops = Vec::with_capacity(face.loops.len());
    for &lid in &face.loops {
        let lp = body
            .loop_(lid)
            .ok_or_else(|| CheckError::Dangling { face: fname() })?;
        let mut raw: Vec<Piece<'a>> = Vec::with_capacity(lp.coedges.len());
        for &cid in &lp.coedges {
            let c = body
                .coedge(cid)
                .ok_or_else(|| CheckError::Dangling { face: fname() })?;
            let e = body
                .edge(c.edge)
                .ok_or_else(|| CheckError::Dangling { face: fname() })?;
            let curve = c
                .pcurve
                .as_ref()
                .ok_or_else(|| CheckError::MissingPcurve { face: fname() })?;
            let (t0, t1) = if c.forward {
                e.t_range
            } else {
                (e.t_range.1, e.t_range.0)
            };
            raw.push(Piece {
                kind: PieceKind::Pcurve { curve, t0, t1 },
                shift: Vec2::zero(),
            });
        }
        let first_start = raw[0].start();
        let mut pieces: Vec<Piece<'a>> = Vec::with_capacity(raw.len() + 2);
        let mut prev_end: Option<Vec2> = None;
        for mut p in raw {
            let st = p.start();
            if let Some(pe) = prev_end {
                let shift = period_shift(pe - st, periods);
                p.shift = shift;
                let st = st + shift;
                if !same_point(pe, st) {
                    check_gap(&face.surface, pe, st, gap_tol, &fname)?;
                    pieces.push(Piece {
                        kind: PieceKind::Segment { a: pe, b: st },
                        shift: Vec2::zero(),
                    });
                }
            }
            prev_end = Some(p.end());
            pieces.push(p);
        }
        let pe = prev_end.expect("non-empty loop");
        let wrap = period_shift(pe - first_start, periods);
        let closing = first_start + wrap;
        if !same_point(pe, closing) {
            check_gap(&face.surface, pe, closing, gap_tol, &fname)?;
            pieces.push(Piece {
                kind: PieceKind::Segment { a: pe, b: closing },
                shift: Vec2::zero(),
            });
        }
        let k = |w: f64, per: Option<f64>| per.map_or(0, |t| (w / t).round() as i64);
        loops.push(LoopPath {
            pieces,
            wraps: (k(wrap.x, pu), k(wrap.y, pv)),
        });
    }
    Ok(FaceDomain {
        surface: &face.surface,
        sigma: if face.sense { 1.0 } else { -1.0 },
        loops,
    })
}

fn same_point(a: Vec2, b: Vec2) -> bool {
    let scale = 1.0 + a.x.abs().max(a.y.abs());
    (a - b).x.abs() <= PERIOD_EPS * scale && (a - b).y.abs() <= PERIOD_EPS * scale
}

/// Whole-period shift `s` (per periodic direction) such that `d − s` is within
/// [`PERIOD_EPS`] of zero; directions where no multiple fits are not shifted.
fn period_shift(d: Vec2, periods: [Option<f64>; 2]) -> Vec2 {
    let one = |x: f64, per: Option<f64>| -> f64 {
        let Some(t) = per else { return 0.0 };
        let m = (x / t).round();
        if m != 0.0 && (x - m * t).abs() <= PERIOD_EPS * (1.0 + x.abs()) {
            m * t
        } else {
            0.0
        }
    };
    Vec2::new(one(d.x, periods[0]), one(d.y, periods[1]))
}

/// A gap segment must stay (numerically) at one 3D point.
fn check_gap(
    surface: &Surface,
    a: Vec2,
    b: Vec2,
    gap_tol: f64,
    face: &dyn Fn() -> String,
) -> Result<(), CheckError> {
    let p0 = surface.eval(a.x, a.y);
    let mut worst = 0.0f64;
    for i in 1..=8 {
        let q = a.lerp(b, i as f64 / 8.0);
        worst = worst.max(surface.eval(q.x, q.y).distance(p0));
    }
    if worst <= gap_tol {
        Ok(())
    } else {
        Err(CheckError::OpenBoundary {
            face: face(),
            gap: worst,
        })
    }
}

/// `true` if the lifted domain reaches the singular line `v = vs` (a boundary point
/// lies on it, or the domain extends towards it without a boundary).
pub(crate) fn touches_singular(dom: &FaceDomain<'_>, vs: f64) -> bool {
    if dom.is_loopless() {
        return true;
    }
    let eps = 1e-9 * (1.0 + vs.abs());
    if dom
        .pieces()
        .any(|p| (p.start().y - vs).abs() <= eps || (p.end().y - vs).abs() <= eps)
    {
        return true;
    }
    let w = dom.winding_u();
    let (lo, hi) = dom.v_extent();
    (w > 0 && vs >= hi - eps) || (w < 0 && vs <= lo + eps)
}

/// Point-in-face test in `(u, v)` (see the module docs of `bbox` for its use). Points on
/// the boundary may be classified either way.
pub(crate) fn contains(dom: &FaceDomain<'_>, u: f64, v: f64) -> bool {
    if dom.is_loopless() {
        let (_, (v0, v1)) = dom.surface.domain();
        let pv = dom.surface.periodicity().1;
        return pv.is_some() || (v >= v0 - 1e-12 && v <= v1 + 1e-12);
    }
    let (pu, pv) = dom.surface.periodicity();
    if dom.wraps_v() && !dom.wraps_u() {
        // Cast towards +u; the nearest crossing's direction decides.
        match nearest_crossing(dom, [v, u], 1, 0, pv, pu) {
            Some(dv_pos) => dv_pos > 0.0,
            None => false,
        }
    } else {
        match nearest_crossing(dom, [u, v], 0, 1, pu, pv) {
            Some(du_pos) => du_pos < 0.0,
            None => dom.winding_u() > 0,
        }
    }
}

/// Cast a ray from the point (coordinate `along` fixed at `q[0]`, moving in `+across`
/// from `q[1]`) and return, for the nearest boundary crossing, the rate of change of
/// coordinate `along` in the positively oriented boundary direction.
fn nearest_crossing(
    dom: &FaceDomain<'_>,
    q: [f64; 2],
    along: usize,
    across: usize,
    per_along: Option<f64>,
    per_across: Option<f64>,
) -> Option<f64> {
    let coord = |p: Vec2, i: usize| if i == 0 { p.x } else { p.y };
    let mut best: Option<(f64, f64)> = None;
    for piece in dom.pieces() {
        for (a, b) in piece.spans() {
            let n = 64;
            let mut prev_t = a;
            let mut prev_uv = piece.eval(a).0;
            for i in 1..=n {
                let t = if i == n {
                    b
                } else {
                    a + (b - a) * i as f64 / n as f64
                };
                let uv = piece.eval(t).0;
                let (x0, x1) = (coord(prev_uv, along), coord(uv, along));
                // Candidate period shifts of the target so it falls in [x0, x1].
                let shifts: Vec<f64> = match per_along {
                    Some(per) => {
                        let lo = x0.min(x1);
                        let hi = x0.max(x1);
                        let k0 = ((lo - q[0]) / per).ceil() as i64;
                        let k1 = ((hi - q[0]) / per).floor() as i64;
                        (k0..=k1).map(|k| k as f64 * per).collect()
                    }
                    None => vec![0.0],
                };
                for s in shifts {
                    let target = q[0] + s;
                    let (f0, f1) = (x0 - target, x1 - target);
                    // Half-open: count [x0, x1) crossings in either direction.
                    let crosses = (f0 <= 0.0 && f1 > 0.0) || (f0 > 0.0 && f1 <= 0.0);
                    if !crosses {
                        continue;
                    }
                    // Bisection for the crossing parameter.
                    let (mut lo_t, mut hi_t, mut flo) = (prev_t, t, f0);
                    for _ in 0..80 {
                        let mid = 0.5 * (lo_t + hi_t);
                        let fm = coord(piece.eval(mid).0, along) - target;
                        if (fm <= 0.0) == (flo <= 0.0) {
                            lo_t = mid;
                            flo = fm;
                        } else {
                            hi_t = mid;
                        }
                    }
                    let tc = 0.5 * (lo_t + hi_t);
                    let (uv_c, d) = piece.eval(tc);
                    let mut dist = coord(uv_c, across) - q[1];
                    if let Some(per) = per_across {
                        dist = math::wrap_angle(dist, 0.0);
                        if dist <= 0.0 {
                            dist += per;
                        }
                    }
                    if dist <= 0.0 {
                        continue;
                    }
                    let dir = if b >= a { 1.0 } else { -1.0 };
                    let rate = dom.sigma * dir * coord(d, along);
                    if best.is_none_or(|(bd, _)| dist < bd) {
                        best = Some((dist, rate));
                    }
                }
                prev_t = t;
                prev_uv = uv;
            }
        }
    }
    best.map(|(_, r)| r)
}
