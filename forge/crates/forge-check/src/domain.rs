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
//! # Joins on a singular line
//! Where a loop passes through a singular point (a B-rep vertex at a pole or apex), the
//! outgoing pcurve may start at any `u`: the whole iso-line is one 3D point. The period
//! shift there is **not** the nearest one. The gap segment runs along the singular line in
//! the direction that keeps the domain on the correct side (the rule of forge-mesh's
//! `jump_sign`/`continuation_shift`): with the domain below the line (the path arrived
//! from smaller `v`) it runs towards −u, above the line towards +u, both times `σ`; its
//! length is brought into `(0, P]`. A join is "no jump" only when the two `u` values are
//! bitwise equal modulo whole periods: a revolve of `2π − ε` has a face bounded by two
//! meridians `ε` apart whose domain is `[0, 2π − ε]`, not the `ε`-sliver between them
//! (Phase 0 audit H1).
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
/// this (radians, relative to `1 + |Δ|`). Pcurves built by Forge meet exactly; this only
/// absorbs rounding. Also the parameter distance below which two regular pcurve ends are
/// the same point (relative to `1 + |uv|`), so no gap segment is needed.
pub const PERIOD_EPS: f64 = 1e-9;

/// A parameter value `v` lies on the singular line `v = v_s` when `|v − v_s|` is at most
/// this, relative to `1 + |v_s|` (radians, or mm for a cone's axial parameter). Singular
/// `v` values come from `acos`/`atan2`/`−R/tan α` and pcurve ends from other formulas,
/// so they agree only to rounding; a point this close to a singular line is, in 3D,
/// within `radius × 1e-9` of the singular point, far below any vertex tolerance.
pub const SINGULAR_LINE_EPS: f64 = 1e-9;

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
    /// `true` if the parameter itself is an angle (circle, ellipse and spiral pcurves).
    pub fn angular_parameter(&self) -> bool {
        matches!(
            self.kind,
            PieceKind::Pcurve {
                curve: Curve2::Circle(_) | Curve2::Ellipse(_) | Curve2::Spiral(_),
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
    /// The singular line that closes a band domain (`winding_u() != 0`): for a positive
    /// winding the domain extends from its boundary up to the first singular line at or
    /// above the highest boundary point, for a negative winding down to the last one at or
    /// below the lowest. `None` for a contractible domain or a band that no singular line
    /// closes (an unbounded domain). Periodic `v` (horn torus) considers every period.
    pub fn band_singular_v(&self) -> Option<f64> {
        let w = self.winding_u();
        if w == 0 {
            return None;
        }
        let (lo, hi) = self.v_extent();
        let eps = SINGULAR_LINE_EPS * (1.0 + lo.abs().max(hi.abs()));
        let pv = self.surface.periodicity().1;
        let reps = singular_v(self.surface).into_iter().filter_map(|vs| {
            if w > 0 {
                match pv {
                    Some(p) => Some(vs + ((hi - eps - vs) / p).ceil() * p),
                    None => (vs >= hi - eps).then_some(vs),
                }
            } else {
                match pv {
                    Some(p) => Some(vs + ((lo + eps - vs) / p).floor() * p),
                    None => (vs <= lo + eps).then_some(vs),
                }
            }
        });
        if w > 0 {
            reps.reduce(f64::min)
        } else {
            reps.reduce(f64::max)
        }
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
    let sigma = if face.sense { 1.0 } else { -1.0 };
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
        let Some(first) = raw.first().cloned() else {
            return Err(CheckError::Dangling { face: fname() });
        };
        let join = |prev: &Piece<'a>, next: &Piece<'a>, pe: Vec2, st: Vec2| {
            join_shift(
                &face.surface,
                sigma,
                periods,
                (prev, pe),
                (next, st),
                &fname,
            )
        };
        let mut pieces: Vec<Piece<'a>> = Vec::with_capacity(raw.len() + 2);
        for mut p in raw {
            if let Some(prev) = pieces.last() {
                let pe = prev.end();
                let (shift, singular) = join(prev, &p, pe, p.start())?;
                p.shift = shift;
                push_gap(
                    &mut pieces,
                    &face.surface,
                    pe,
                    p.start(),
                    singular,
                    gap_tol,
                    &fname,
                )?;
            }
            pieces.push(p);
        }
        let last = pieces.last().expect("non-empty loop").clone();
        let pe = last.end();
        let (wrap, singular) = join(&last, &first, pe, first.start())?;
        push_gap(
            &mut pieces,
            &face.surface,
            pe,
            first.start() + wrap,
            singular,
            gap_tol,
            &fname,
        )?;
        let k = |w: f64, per: Option<f64>| per.map_or(0, |t| (w / t).round() as i64);
        loops.push(LoopPath {
            pieces,
            wraps: (k(wrap.x, pu), k(wrap.y, pv)),
        });
    }
    Ok(FaceDomain {
        surface: &face.surface,
        sigma,
        loops,
    })
}

/// Add the gap segment `a → b` if the join is not exact: at a singular join any
/// difference counts (bitwise), elsewhere differences below [`PERIOD_EPS`] are rounding.
fn push_gap<'a>(
    pieces: &mut Vec<Piece<'a>>,
    surface: &Surface,
    a: Vec2,
    b: Vec2,
    singular: bool,
    gap_tol: f64,
    face: &dyn Fn() -> String,
) -> Result<(), CheckError> {
    let exact = a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits();
    if exact || (!singular && same_point(a, b)) {
        return Ok(());
    }
    check_gap(surface, a, b, gap_tol, face)?;
    pieces.push(Piece {
        kind: PieceKind::Segment { a, b },
        shift: Vec2::zero(),
    });
    Ok(())
}

/// The whole-period shift of the next piece at a join from `pe` (end of `prev`) to `st`
/// (start of `next`, unshifted), and whether the join lies on a singular line (see the
/// module docs).
fn join_shift(
    surface: &Surface,
    sigma: f64,
    periods: [Option<f64>; 2],
    (prev, pe): (&Piece<'_>, Vec2),
    (next, st): (&Piece<'_>, Vec2),
    face: &dyn Fn() -> String,
) -> Result<(Vec2, bool), CheckError> {
    let (Some(pu), Some(vs)) = (periods[0], singular_line_at(surface, pe.y)) else {
        return Ok((period_shift(pe - st, periods), false));
    };
    if singular_line_at(surface, st.y).is_none() {
        // Only one end on the singular line: an inconsistent join, which the gap check
        // then reports as an open boundary.
        return Ok((period_shift(pe - st, periods), false));
    }
    let sy = periods[1].map_or(0.0, |p| ((pe.y - st.y) / p).round() * p);
    // Which side of the line the domain lies on: where the arriving piece comes from,
    // or else where the departing one goes (both in lifted coordinates).
    let side = side_of(prev, vs, 0.0)
        .or_else(|| side_of(next, vs, sy))
        .ok_or_else(|| CheckError::AmbiguousSingularJoin { face: face() })?;
    // Domain below the line: run towards −u; above: towards +u (times σ).
    let sign = side * sigma;
    let mut k = ((pe.x - st.x) / pu).round();
    let du = st.x + k * pu - pe.x;
    if du != 0.0 {
        if sign > 0.0 && du < 0.0 {
            k += 1.0;
        } else if sign < 0.0 && du > 0.0 {
            k -= 1.0;
        }
    }
    Ok((Vec2::new(k * pu, sy), true))
}

/// The representative `v_s` (in the period of `v`) of the singular line through `v`.
fn singular_line_at(surface: &Surface, v: f64) -> Option<f64> {
    let pv = surface.periodicity().1;
    singular_v(surface).into_iter().find_map(|vs| {
        let vs = match pv {
            Some(p) => vs + ((v - vs) / p).round() * p,
            None => vs,
        };
        ((v - vs).abs() <= SINGULAR_LINE_EPS * (1.0 + vs.abs())).then_some(vs)
    })
}

/// `+1` if the middle of `piece` (its `v` plus `dv`) lies above the line `v = vs`, `−1`
/// below, `None` on it.
fn side_of(piece: &Piece<'_>, vs: f64, dv: f64) -> Option<f64> {
    let (t0, t1) = piece.range();
    let v = piece.eval(0.5 * (t0 + t1)).0.y + dv;
    let eps = SINGULAR_LINE_EPS * (1.0 + vs.abs());
    if v > vs + eps {
        Some(1.0)
    } else if v < vs - eps {
        Some(-1.0)
    } else {
        None
    }
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
/// lies on it, or the domain is a band that this line closes).
pub(crate) fn touches_singular(dom: &FaceDomain<'_>, vs: f64) -> bool {
    if dom.is_loopless() {
        return true;
    }
    let eps = SINGULAR_LINE_EPS * (1.0 + vs.abs());
    if dom
        .pieces()
        .any(|p| (p.start().y - vs).abs() <= eps || (p.end().y - vs).abs() <= eps)
    {
        return true;
    }
    let pv = dom.surface.periodicity().1;
    dom.band_singular_v().is_some_and(|b| {
        let d = match pv {
            Some(p) => vs - b - ((vs - b) / p).round() * p,
            None => vs - b,
        };
        d.abs() <= eps
    })
}

/// Point-in-face test in `(u, v)` (see the module docs of `bbox` for its use). Points on
/// the boundary may be classified either way.
///
/// A band closed by a singular line ([`FaceDomain::band_singular_v`]) is the region
/// between its boundary and that line: points beyond the line are outside even though no
/// boundary piece separates them (a spindle-torus patch or a horn torus ends there; the
/// rest of the surface's parameter range is another sheet or the other side of the horn),
/// and the ray towards the line must not wrap around a periodic `v` through it.
pub(crate) fn contains(dom: &FaceDomain<'_>, u: f64, v: f64) -> bool {
    if dom.is_loopless() {
        let (_, (v0, v1)) = dom.surface.domain();
        let pv = dom.surface.periodicity().1;
        let eps = SINGULAR_LINE_EPS * (1.0 + v.abs());
        return pv.is_some() || (v >= v0 - eps && v <= v1 + eps);
    }
    let (pu, pv) = dom.surface.periodicity();
    if dom.wraps_v() && !dom.wraps_u() {
        // Cast towards +u; the nearest crossing's direction decides.
        return match nearest_crossing(dom, [v, u], 1, 0, pv, pu) {
            Some(dv_pos) => dv_pos > 0.0,
            None => false,
        };
    }
    let w = dom.winding_u();
    if w != 0 {
        let Some(vs) = dom.band_singular_v() else {
            // Unbounded: the mass properties report it.
            return false;
        };
        let v = match pv {
            // The representative on the domain's side of the line, within one period.
            Some(p) if w > 0 => vs - math::rem_euclid(vs - v, p),
            Some(p) => vs + math::rem_euclid(v - vs, p),
            None => v,
        };
        let eps = SINGULAR_LINE_EPS * (1.0 + vs.abs());
        if (w > 0 && v > vs + eps) || (w < 0 && v < vs - eps) {
            return false;
        }
        return match nearest_crossing(dom, [u, v], 0, 1, pu, None) {
            Some(du_pos) => du_pos < 0.0,
            None => w > 0,
        };
    }
    match nearest_crossing(dom, [u, v], 0, 1, pu, pv) {
        Some(du_pos) => du_pos < 0.0,
        None => false,
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
