//! Face orientation and mass properties of a STEP B-rep, from the written faces alone.
//!
//! A STEP face is the part of its surface to the *left* of each of its loops, seen from the
//! face's normal (the surface normal, reversed when `same_sense` is `.F.`). A writer bug that
//! flips `same_sense`, or turns a whole shell inside out, still uses every edge twice in
//! opposite directions, so the topology check cannot see it, and OCCT's healing silently
//! repairs such files. [`face_mass`] maps every loop into the surface's parameter plane and
//! integrates over the region the loops bound, which gives two checks:
//!
//! - **per face:** the loops close in the parameter plane (a loop that winds around a
//!   periodic surface lacks its seam) and bound a region of positive area on the side the
//!   face's normal says; a flipped `same_sense` makes that area negative;
//! - **per shell** ([`super::verify`]): the volume the faces enclose, `⅓ ∑ ∬ (x − c)·n dA`,
//!   is positive for every `CLOSED_SHELL` as written (a void's `ORIENTED_CLOSED_SHELL .F.`
//!   turns it round). This catches a consistently inside-out shell, and faces whose loops do
//!   not decide their side.
//!
//! The integrals use Green's theorem in the parameter plane, `∬ f du dv = ∮ F dv` with
//! `F(u, v) = ∫_{u*}^{u} f(s, v) ds`: Gauss–Legendre along every edge in its own parameter
//! (split at knots and quarter turns) and across `u`. Forge's surface normal is
//! `normalize(S_u × S_v)`, the same convention STEP uses for every surface it writes.
//!
//! Periodic parameters are unwrapped along each loop by continuity (subdividing where a
//! step is large). Where a loop passes through a singular point of the surface (a sphere's
//! pole, a cone's or spindle torus's apex: `S_u = 0`), the loop does not say how far `u`
//! runs along the singular row: the jump is taken in the direction that keeps the face on
//! its normal's side (a reader's rule), and the loop must then close. For a face that meets
//! singular points more than once (a whole sphere, a lune between two meridians) the loops
//! alone do not decide the side, so only the shell volume checks its orientation.

use std::cmp::Ordering;

use forge_core::geom::quadrature::gauss_legendre;
use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point3, Vec3};
use forge_core::math;

/// Gauss–Legendre order along edges and across `u`.
const ORDER: usize = 16;
/// Order along a degenerate column of a B-spline surface (`S_v = 0`) that joins two edges
/// in the parameter plane.
const JOIN_ORDER: usize = 4;
/// Relative distance from an edge's end at which its end parameters are sampled (the end
/// itself may be a singular point, where `u` is undefined).
const END_OFFSET: f64 = 1e-7;
/// A `u` jump along a singular row shorter than this (radians) is the loop touching the
/// point and turning back: it runs the whole row instead.
const ZERO_JUMP: f64 = 1e-5;
/// Deepest subdivision when unwrapping a large parameter step along an edge.
const MAX_DEPTH: u32 = 24;

/// One oriented edge of a loop, as read from the file.
pub(super) struct Use<'a> {
    /// The edge's curve.
    pub curve: &'a Curve3,
    /// Curve parameter where the use starts.
    pub from: f64,
    /// Curve parameter where it ends.
    pub to: f64,
    /// The vertex it starts at.
    pub start: Point3,
}

/// One bound of a face: its loop in listed order and the bound's orientation.
pub(super) struct Bound<'a> {
    /// `FACE_(OUTER_)BOUND.orientation`.
    pub orientation: bool,
    /// The loop's oriented edges, in listed order, each in its own direction.
    pub uses: Vec<Use<'a>>,
}

/// A face's contributions to its shell's mass properties.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct FaceMass {
    /// Its area (positive).
    pub area: f64,
    /// `⅓ ∬ (x − c)·n dA` over the face, `n` its normal (sums to the shell's volume).
    pub volume: f64,
}

/// A parameter-plane sample: raw projection, then unwrapped.
#[derive(Clone, Copy, Debug)]
struct Uv {
    u: f64,
    v: f64,
}

/// An integration node of an edge use: its unwrapped `(u, v)` and `w · dv/dt · dt`.
#[derive(Clone, Copy, Debug)]
struct Node {
    uv: Uv,
    dv: f64,
}

/// An edge use traced in the parameter plane (`u` relative to its segment's frame).
struct Trace {
    /// Just after the start vertex.
    start: Uv,
    nodes: Vec<Node>,
    /// Just before the end vertex.
    end: Uv,
}

fn wrap_half(x: f64, p: f64) -> f64 {
    // Into [-p/2, p/2).
    math::rem_euclid(x + 0.5 * p, p) - 0.5 * p
}

/// `x` moved by whole periods next to `near`.
fn nearest(x: f64, near: f64, p: Option<f64>) -> f64 {
    match p {
        Some(p) => near + wrap_half(x - near, p),
        None => x,
    }
}

struct Ctx<'a> {
    s: &'a Surface,
    per_u: Option<f64>,
    per_v: Option<f64>,
    centre: Point3,
    rule: Vec<(f64, f64)>,
    join_rule: Vec<(f64, f64)>,
    /// Distinct `u` knots of a B-spline surface (inner integral breaks).
    u_knots: Vec<f64>,
    /// `|S_u|` at or below which a vertex is a singular point of a periodic `u`.
    singular: f64,
}

impl Ctx<'_> {
    fn project(&self, p: Point3) -> Uv {
        let (u, v, _) = self.s.project(p);
        Uv { u, v }
    }

    /// Unwrap `raw` (at curve parameter `t1`) next to `prev` (at `t0`), subdividing while a
    /// step of a periodic parameter is larger than an eighth of the period. Only a half whose
    /// own step stays large recurses, so a continuous curve costs a few calls per big step.
    fn track(&self, c: &Curve3, t0: f64, prev: Uv, t1: f64, raw: Uv, depth: u32) -> Uv {
        let big = |d: f64, p: Option<f64>| p.is_some_and(|p| d.abs() > 0.125 * p);
        let du = self
            .per_u
            .map_or(raw.u - prev.u, |p| wrap_half(raw.u - prev.u, p));
        let dv = self
            .per_v
            .map_or(raw.v - prev.v, |p| wrap_half(raw.v - prev.v, p));
        // Subdivide only where the curve can make progress (a join has t0 == t1).
        let stuck = depth >= MAX_DEPTH || (t1 - t0).abs() <= 1e-12 * (1.0 + t0.abs());
        if stuck || !(big(du, self.per_u) || big(dv, self.per_v)) {
            return Uv {
                u: nearest(raw.u, prev.u, self.per_u),
                v: nearest(raw.v, prev.v, self.per_v),
            };
        }
        let tm = 0.5 * (t0 + t1);
        let mid = self.track(c, t0, prev, tm, self.project(c.eval(tm)), depth + 1);
        self.track(c, tm, mid, t1, raw, depth + 1)
    }

    /// `dv/dt` along a curve with tangent `ct` through `(u, v)`.
    fn dv_dt(&self, uv: Uv, ct: Vec3) -> f64 {
        let [_, su, sv] = self.s.derivs1(uv.u, uv.v);
        let (e, f, g) = (su.dot(su), su.dot(sv), sv.dot(sv));
        let det = e * g - f * f;
        if det > 1e-12 * e * g && det > 0.0 {
            (e * sv.dot(ct) - f * su.dot(ct)) / det
        } else if g > 0.0 {
            sv.dot(ct) / g
        } else {
            0.0
        }
    }

    /// Trace one edge use: its end samples and integration nodes, unwrapped from `from`.
    fn trace(&self, e: &Use<'_>, from: Uv) -> Trace {
        let c = e.curve;
        let (a, b) = (e.from, e.to);
        let ta = a + END_OFFSET * (b - a);
        let tb = b - END_OFFSET * (b - a);
        let start = from;
        let mut prev = (ta, start);
        let mut nodes = Vec::new();
        let breaks = self.breaks(c, a, b);
        for w in breaks.windows(2) {
            let (lo, hi) = (w[0], w[1]);
            let half = 0.5 * (hi - lo);
            let mid = 0.5 * (hi + lo);
            for &(x, wt) in &self.rule {
                let t = mid + half * x;
                let [p, ct, _] = c.derivs2(t);
                let uv = self.track(c, prev.0, prev.1, t, self.project(p), 0);
                prev = (t, uv);
                nodes.push(Node {
                    uv,
                    dv: wt * half * self.dv_dt(uv, ct),
                });
            }
        }
        let end = self.track(c, prev.0, prev.1, tb, self.project(c.eval(tb)), 0);
        Trace { start, nodes, end }
    }

    /// Integration breaks of `[a, b]` in traversal order: B-spline knots, quarter turns.
    fn breaks(&self, c: &Curve3, a: f64, b: f64) -> Vec<f64> {
        let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
        let mut out = vec![lo];
        match c {
            Curve3::BSpline(n) => {
                for &k in n.knots() {
                    if k > lo && k < hi && out.last().is_none_or(|&l| k > l) {
                        out.push(k);
                    }
                }
            }
            Curve3::Circle(_) | Curve3::Ellipse(_) | Curve3::Helix(_) => {
                let n = ((hi - lo) / (0.25 * math::PI)).ceil().max(1.0) as usize;
                for i in 1..n {
                    out.push(lo + (hi - lo) * i as f64 / n as f64);
                }
            }
            Curve3::Line(_) => {}
        }
        out.push(hi);
        if a > b {
            out.reverse();
        }
        out
    }

    /// `F(u, v) = ∫_{u0}^{u} f(s, v) ds` for `f = ((S − c)·(S_u × S_v), |S_u × S_v|)`.
    fn inner(&self, u0: f64, u: f64, v: f64) -> (f64, f64) {
        let (lo, hi, sign) = if u0 < u { (u0, u, 1.0) } else { (u, u0, -1.0) };
        let mut cuts = vec![lo];
        if let Some(p) = self.per_u {
            let n = ((hi - lo) / (0.25 * p)).ceil().max(1.0) as usize;
            for i in 1..n {
                cuts.push(lo + (hi - lo) * i as f64 / n as f64);
            }
        } else {
            cuts.extend(self.u_knots.iter().copied().filter(|&k| k > lo && k < hi));
        }
        cuts.push(hi);
        let (mut vol, mut area) = (0.0, 0.0);
        for w in cuts.windows(2) {
            let half = 0.5 * (w[1] - w[0]);
            let mid = 0.5 * (w[1] + w[0]);
            for &(x, wt) in &self.rule {
                let [p, su, sv] = self.s.derivs1(mid + half * x, v);
                let n = su.cross(sv);
                vol += wt * half * (p - self.centre).dot(n);
                area += wt * half * n.norm();
            }
        }
        (sign * vol, sign * area)
    }
}

/// The contributions of one face to its shell's mass properties, after checking that its
/// loops close in the parameter plane and bound a region on its normal's side (see the
/// module docs). `centre` is a point near the shell (for conditioning), `tol` the file's
/// distance tolerance. Errors are details for [`super::StepError::SelfCheck`].
pub(super) fn face_mass(
    surface: &Surface,
    sense: bool,
    bounds: &[Bound<'_>],
    centre: Point3,
    tol: f64,
) -> Result<FaceMass, String> {
    let (per_u, per_v) = surface.periodicity();
    let u_knots = match surface {
        Surface::BSpline(n) => {
            let mut k: Vec<f64> = n.knots_u().to_vec();
            k.dedup();
            k
        }
        _ => Vec::new(),
    };
    let ctx = Ctx {
        s: surface,
        per_u,
        per_v,
        centre,
        rule: gauss_legendre(ORDER),
        join_rule: gauss_legendre(JOIN_ORDER),
        u_knots,
        singular: 16.0 * tol,
    };
    let mut total = FaceMass::default();
    for (bi, bound) in bounds.iter().enumerate() {
        let o = if sense == bound.orientation {
            1.0
        } else {
            -1.0
        };
        let m = loop_mass(&ctx, &bound.uses, o).map_err(|e| format!("bound {bi}: {e}"))?;
        let s = if bound.orientation { 1.0 } else { -1.0 };
        total.area += s * m.area;
        total.volume += s * m.volume;
    }
    let o = if sense { 1.0 } else { -1.0 };
    // NaN (a failed projection) is not a positive area either.
    if (total.area * o).partial_cmp(&0.0) != Some(Ordering::Greater) {
        return Err(format!(
            "its loops bound a region of area {:e} mm² on the side its normal (same_sense {}) \
             points away from: the face is inside out",
            total.area * o,
            if sense { ".T." } else { ".F." }
        ));
    }
    Ok(FaceMass {
        area: total.area * o,
        volume: total.volume,
    })
}

/// Integrals of one loop, traversed in listed order (`o`: `+1` when the face lies on the
/// left of that traversal in the parameter plane, `−1` on the right).
fn loop_mass(ctx: &Ctx<'_>, uses: &[Use<'_>], o: f64) -> Result<FaceMass, String> {
    let n = uses.len();
    if n == 0 {
        return Err("an empty loop".into());
    }
    // Singular vertices (where a periodic `u` is undefined): the row's `v`, per use start.
    let singular: Vec<Option<f64>> = uses
        .iter()
        .map(|e| {
            let uv = ctx.project(e.start);
            let [_, su, _] = ctx.s.derivs1(uv.u, uv.v);
            (ctx.per_u.is_some() && su.norm() <= ctx.singular).then_some(uv.v)
        })
        .collect();
    // Start right after a singular vertex, if there is one, so no segment wraps around.
    let first = singular.iter().position(Option::is_some).unwrap_or(0);
    let order: Vec<usize> = (0..n).map(|k| (first + k) % n).collect();

    // Trace every use. Within a segment (between singular vertices) `u` is unwrapped by
    // continuity; each segment's `u` starts from its raw projection and is placed later.
    // `v` is continuous along the whole loop.
    let mut traces: Vec<Trace> = Vec::with_capacity(n);
    let mut seg_of: Vec<usize> = Vec::with_capacity(n);
    // Per singular vertex, in loop order after `order[0]`: the side of its row the loop is on.
    let mut sides: Vec<f64> = Vec::new();
    for &i in &order {
        let e = &uses[i];
        let raw = ctx.project(e.curve.eval(e.from + END_OFFSET * (e.to - e.from)));
        let from = match (traces.last(), singular[i]) {
            (None, _) => raw,
            (Some(prev), Some(vs)) => {
                let v = nearest(raw.v, prev.end.v, ctx.per_v);
                sides.push(side(prev.end.v, v, nearest(vs, prev.end.v, ctx.per_v))?);
                Uv { u: raw.u, v }
            }
            (Some(prev), None) => ctx.track(e.curve, e.from, prev.end, e.from, raw, 0),
        };
        seg_of.push(sides.len());
        traces.push(ctx.trace(e, from));
    }
    let segments = sides.len() + 1;
    let last = &traces[n - 1];
    let head = traces[0].start;
    // The loop's start as reached from its end, and the `u` offset of every segment.
    let (close, offsets) = match singular[order[0]] {
        Some(vs) => {
            let p = ctx
                .per_u
                .ok_or("a singular vertex on a non-periodic parameter")?;
            let v_head = nearest(head.v, last.end.v, ctx.per_v);
            sides.push(side(
                last.end.v,
                v_head,
                nearest(vs, last.end.v, ctx.per_v),
            )?);
            let mut starts = vec![f64::NAN; segments];
            let mut ends = vec![f64::NAN; segments];
            for (t, &s) in traces.iter().zip(&seg_of) {
                if starts[s].is_nan() {
                    starts[s] = t.start.u;
                }
                ends[s] = t.end.u;
            }
            // The jump along the row after segment k runs towards the face's side.
            let mut offsets = vec![0.0; segments];
            let mut run = 0.0;
            for k in 0..segments {
                let next = (k + 1) % segments;
                let b = wrap_half(starts[next] - ends[k], p);
                let dir = sides[k] * o;
                let j = if b * dir > ZERO_JUMP { b } else { b + dir * p };
                run += ends[k] - starts[k] + j;
                if next != 0 {
                    offsets[next] = p * ((offsets[k] + ends[k] + j - starts[next]) / p).round();
                }
            }
            if run.abs() > 0.25 * p {
                return Err(format!(
                    "the loop does not close in the parameter plane with the face's orientation \
                     (u runs {run:.6} through its singular points): same_sense disagrees with \
                     the loop"
                ));
            }
            (
                Uv {
                    u: head.u,
                    v: v_head,
                },
                offsets,
            )
        }
        None => {
            let e = &uses[order[0]];
            let back = ctx.track(e.curve, e.from, last.end, e.from, head, 0);
            for (d, p, name) in [
                (back.u - head.u, ctx.per_u, "u"),
                (back.v - head.v, ctx.per_v, "v"),
            ] {
                if let Some(p) = p
                    && d.abs() > 0.25 * p
                {
                    return Err(format!(
                        "the loop winds {:.3} times around the surface in {name}: a seam is \
                         missing",
                        d / p
                    ));
                }
            }
            (back, vec![0.0])
        }
    };
    if let Some(p) = ctx.per_v
        && (close.v - head.v).abs() > 0.25 * p
    {
        return Err("the loop winds around the surface in v: a seam is missing".into());
    }

    // ∮ F dv along every use. Consecutive uses meet at their common vertex; at a singular
    // point of `u` they are joined along its row (`dv = 0`: nothing to add), at a
    // degenerate column of a B-spline (`S_v = 0`) along the column, which is integrated.
    let u_ref = head.u;
    let mut m = FaceMass::default();
    let mut add = |uv: Uv, dv: f64| {
        let (vol, area) = ctx.inner(u_ref, uv.u, uv.v);
        m.volume += vol * dv / 3.0;
        m.area += area * dv;
    };
    for (k, t) in traces.iter().enumerate() {
        let off = offsets[seg_of[k]];
        for nd in &t.nodes {
            add(
                Uv {
                    u: nd.uv.u + off,
                    v: nd.uv.v,
                },
                nd.dv,
            );
        }
        let (next_use, b) = match traces.get(k + 1) {
            Some(next) => (
                &uses[order[k + 1]],
                Uv {
                    u: next.start.u + offsets[seg_of[k + 1]],
                    v: next.start.v,
                },
            ),
            None => (&uses[order[0]], close),
        };
        let at = ctx.project(next_use.start);
        let [_, _, sv] = ctx.s.derivs1(at.u, at.v);
        if sv.norm() > ctx.singular {
            continue;
        }
        let a = Uv {
            u: t.end.u + off,
            v: t.end.v,
        };
        let half = 0.5 * (b.v - a.v);
        for &(x, wt) in &ctx.join_rule {
            let s = 0.5 * (1.0 + x);
            add(
                Uv {
                    u: a.u + (b.u - a.u) * s,
                    v: a.v + (b.v - a.v) * s,
                },
                wt * half,
            );
        }
    }
    Ok(m)
}

/// The side (`±1`) of the singular row `v = vs` a loop arrives from (`va`) and leaves to
/// (`vd`); the face lies on that side.
fn side(va: f64, vd: f64, vs: f64) -> Result<f64, String> {
    let (a, d) = (va - vs, vd - vs);
    if a == 0.0 || d == 0.0 || a.signum() != d.signum() {
        return Err("the loop crosses a singular point of the surface".into());
    }
    Ok(a.signum())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapping_keeps_values_within_half_a_period_of_their_neighbour() {
        let p = math::TAU;
        for (x, near) in [(0.1, 6.2), (6.2, 0.1), (3.0, 3.0), (-7.0, 12.0)] {
            let y = nearest(x, near, Some(p));
            assert!(
                (y - near).abs() <= 0.5 * p + 1e-12,
                "{x} near {near} gave {y}"
            );
            assert!((math::rem_euclid(y - x, p)).min(p - math::rem_euclid(y - x, p)) < 1e-12);
        }
        assert!(
            (nearest(5.0, -3.0, None) - 5.0).abs() < 1e-15,
            "no period: unchanged"
        );
        assert!((wrap_half(0.75 * p, p) + 0.25 * p).abs() < 1e-12);
    }

    #[test]
    fn a_loop_must_stay_on_one_side_of_a_singular_row() {
        assert_eq!(side(1.0, 1.2, 1.5), Ok(-1.0));
        assert_eq!(side(-1.0, -1.2, -1.5), Ok(1.0));
        assert!(side(1.0, 2.0, 1.5).is_err());
        assert!(side(1.5, 1.0, 1.5).is_err());
    }
}
