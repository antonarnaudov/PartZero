//! Analytic feasible ranges (SPEC §6.6: `max_r` "computed analytically where possible (e.g.
//! the width of the narrowest adjacent planar face across the edge) and otherwise by
//! bisection").
//!
//! For an edge with an exact cross-section (a line between planes, a circle between faces of
//! revolution about it; see [`super::edge`]), the contact curve on each face `f` runs parallel
//! to the edge at the **setback** `s_f = c_f · x`, linear in the searched value `x` (`r` for a
//! fillet; `d` for a chamfer, whose other distance scales with it). The contact must stay
//! inside `f`: with `w_f` the **width** of `f` across the edge — the smallest distance, along
//! the direction into `f` in the cross-section, from the edge to any other boundary point of
//! `f` whose station lies along the edge — the limit is `x < w_f / c_f`. When the nearest
//! boundary is another blended edge parallel to this one (the opposite edge of a strip, the
//! other rim of a hole) whose contact advances towards it with `c'_f`, the two share the width:
//! `x < w_f / (c_f + c'_f)`. A contact circle moving towards the axis on a plane is limited by
//! the axis (`curvature`).
//!
//! Pairs of blended edges on one **plane** have closed forms too ([`pair_limits`]): two
//! contact circles of radii `R_i ± c_i·x` meet when their centres' distance equals the sum
//! (or difference) of the radii — `(D − R_1 − R_2) / 2` for two hole rims filleted together —
//! and a contact circle meets a contact line advancing towards it at `(d_0 − R) / (c + σ)`.
//!
//! These values are candidates: [`super::finish`] accepts the smallest only when the
//! construction confirms it (the largest multiple of 0.001 mm below it builds, the next one
//! does not) and bisects otherwise, since vertices, other features of the body and curvature
//! can limit the value first.

use std::collections::BTreeMap;

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point3, Vec2};
use forge_ir::v1::LINEAR_TOLERANCE;

use super::Cx;
use super::edge::{Eg, Fam, Prof, edge_blend};
use crate::error::Limit;

/// The analytic limit of one blended edge: the value `x` its contact reaches the other side
/// of face `face` at.
#[derive(Clone, Debug)]
pub(crate) struct AnaLimit {
    pub e: usize,
    pub x: f64,
    pub face: usize,
    pub limit: Limit,
    /// The boundary met bounds a hole in the face's domain: another feature (see
    /// [`super::Violation::obstacle`]).
    pub obstacle: bool,
    /// The width of the face across the edge (mm) when the limit is that face's own width
    /// (for the message: SPEC §6.6's "face width 6.82 at slab/side:right").
    pub width: Option<f64>,
}

/// The nearest boundary of a face across an edge.
struct Width {
    lambda: f64,
    /// A blended edge parallel to the edge at that distance.
    partner: Option<usize>,
    limit: Limit,
    /// The face named with the limit: the face itself when its own width limits the contact
    /// (its outer boundary, or a ring bounding a band such as a hole's wall), the face beyond
    /// the boundary when that boundary bounds a **hole** in the face's domain
    /// ([`bounds_hole`]) — another feature (a hole's wall, a boss's side) the contact runs
    /// into (W6 review round 3: name the obstacle, not the face that holds it).
    named: usize,
    /// The boundary bounds a hole in the face's domain (another feature).
    obstacle: bool,
}

/// The analytic limit of every edge of the set that has one (at most one per edge: its
/// smallest), for the profile `prof` whose searched value is `value`.
pub(crate) fn analytic_limits(cx: &Cx<'_>, prof: Prof, value: f64) -> Vec<AnaLimit> {
    if !(value.is_finite() && value > 0.0) {
        return Vec::new();
    }
    let mut egs: BTreeMap<usize, Eg> = BTreeMap::new();
    // Setback per unit of the searched value, per (edge, face).
    let mut per: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    for &e in &cx.set {
        let Ok(g) = edge_blend(cx.plan0, cx.adj, e, prof, cx.sides.get(&e).copied()) else {
            continue;
        };
        per.insert((e, g.a), (g.pa - g.e2).norm() / value);
        per.insert((e, g.b), (g.pb - g.e2).norm() / value);
        egs.insert(e, g);
    }
    let mut out: Vec<AnaLimit> = Vec::new();
    for (&e, g) in &egs {
        let mut best: Option<AnaLimit> = None;
        for (k, f) in [(0usize, g.a), (1usize, g.b)] {
            let c = per[&(e, f)];
            if !(c.is_finite() && c > 0.0) {
                continue;
            }
            let pk = if k == 0 { g.pa } else { g.pb };
            let Some(dir) = (pk - g.e2).normalize() else {
                continue;
            };
            let Some(w) = face_width(cx, g, f, dir) else {
                continue;
            };
            let (x, limit) = match w.partner.and_then(|o| per.get(&(o, f))) {
                Some(&c2) => (w.lambda / (c + c2), Limit::FaceWidth),
                None => (w.lambda / c, w.limit),
            };
            if x.is_finite() && x > 0.0 && best.as_ref().is_none_or(|b| x < b.x) {
                best = Some(AnaLimit {
                    e,
                    x,
                    face: w.named,
                    limit,
                    obstacle: w.obstacle,
                    width: (limit == Limit::FaceWidth && !w.obstacle).then_some(w.lambda),
                });
            }
        }
        out.extend(best);
    }
    // Pairs of blended edges whose contacts advance towards each other on a common plane.
    for (e, f, x) in pair_limits(cx, &egs, &per) {
        let cand = AnaLimit {
            e,
            x,
            face: f,
            limit: Limit::AdjacentBlend,
            obstacle: false,
            width: None,
        };
        match out.iter_mut().find(|a| a.e == e) {
            Some(a) if a.x <= x => {}
            Some(a) => *a = cand,
            None => out.push(cand),
        }
    }
    out.sort_by_key(|a| a.e);
    out
}

/// A contact on a plane, in the plane's frame: a circle (centre, radius at the value 0, signed
/// radial rate: positive when it grows) or a line (point and unit direction of the edge,
/// unit direction the contact advances in, rate, station window of the edge along the
/// direction).
enum Contact2 {
    Circle {
        c: Vec2,
        r0: f64,
        rate: f64,
    },
    Line {
        p: Vec2,
        t: Vec2,
        n: Vec2,
        rate: f64,
        window: (f64, f64),
    },
}

/// The contact of blended edge `g` on the planar face `f`, in the plane's frame.
fn contact_on_plane(g: &Eg, f: usize, pl: &forge_core::geom::Plane, rate: f64) -> Option<Contact2> {
    let k = if g.a == f {
        g.pa
    } else if g.b == f {
        g.pb
    } else {
        return None;
    };
    let fr = pl.frame();
    let d = k - g.e2;
    let to2 = |q: Point3| fr.to_local_point(q).truncate();
    match g.fam {
        Fam::Circle { o, z, .. } => {
            // The axis must be the plane's normal and the contact purely radial.
            if z.cross(fr.z()).norm() > 1e-9 || d.y.abs() > 1e-9 * (1.0 + d.x.abs()) {
                return None;
            }
            let centre = o + z * g.e2.y;
            Some(Contact2::Circle {
                c: to2(centre),
                r0: g.e2.x,
                rate: rate * d.x.signum(),
            })
        }
        Fam::Line { o, t, .. } => {
            let (s0, s1) = g.st_range?;
            let dir3 = g.fam.vec3(0.0, d.normalize()?);
            let p = to2(g.fam.to3(0.0, g.e2));
            let tt = fr.to_local_vector(t).truncate();
            let nn = fr.to_local_vector(dir3).truncate();
            if (tt.norm() - 1.0).abs() > 1e-9 || (nn.norm() - 1.0).abs() > 1e-9 {
                return None;
            }
            let _ = o;
            Some(Contact2::Line {
                p,
                t: tt,
                n: nn,
                rate,
                window: (s0, s1),
            })
        }
    }
}

/// Closed forms of the value at which the contacts of two blended edges on one plane meet
/// (SPEC §6.6 "computed analytically where possible"): two contact circles of radii
/// `ρ_i(x) = R_i + σ_i·x` whose centres are `D` apart touch at `D = ρ_1 + ρ_2` (outside
/// each other) or `D = ρ_1 − ρ_2` (one inside the other); a circle and a contact line
/// advancing towards it (the circle's nearest point within the edge's stations) at
/// `d_0 − c·x = R + σ·x`. Candidates `(edge, face, x)`, confirmed by construction like the
/// face widths.
fn pair_limits(
    cx: &Cx<'_>,
    egs: &BTreeMap<usize, Eg>,
    per: &BTreeMap<(usize, usize), f64>,
) -> Vec<(usize, usize, f64)> {
    let plan = cx.plan0;
    let mut out = Vec::new();
    let slack = 1e-9 * cx.scale.max(1.0);
    let list: Vec<(&usize, &Eg)> = egs.iter().collect();
    for (i, &(&e1, g1)) in list.iter().enumerate() {
        for &(&e2, g2) in &list[i + 1..] {
            for f in [g1.a, g1.b] {
                if f != g2.a && f != g2.b {
                    continue;
                }
                let Some(face) = plan.fs[f].as_ref() else {
                    continue;
                };
                let Surface::Plane(pl) = &face.surf else {
                    continue;
                };
                let (Some(&r1), Some(&r2)) = (per.get(&(e1, f)), per.get(&(e2, f))) else {
                    continue;
                };
                let (Some(c1), Some(c2)) = (
                    contact_on_plane(g1, f, pl, r1),
                    contact_on_plane(g2, f, pl, r2),
                ) else {
                    continue;
                };
                let x = match (&c1, &c2) {
                    (
                        Contact2::Circle {
                            c: ca,
                            r0: ra,
                            rate: sa,
                        },
                        Contact2::Circle {
                            c: cb,
                            r0: rb,
                            rate: sb,
                        },
                    ) => {
                        let d = ca.distance(*cb);
                        if d >= ra + rb {
                            (sa + sb > 0.0).then(|| (d - ra - rb) / (sa + sb))
                        } else if d + rb <= *ra {
                            // b inside a.
                            (sb - sa > 0.0).then(|| (ra - rb - d) / (sb - sa))
                        } else if d + ra <= *rb {
                            (sa - sb > 0.0).then(|| (rb - ra - d) / (sa - sb))
                        } else {
                            None
                        }
                    }
                    (
                        Contact2::Circle { c, r0, rate: sg },
                        Contact2::Line {
                            p,
                            t,
                            n,
                            rate,
                            window,
                        },
                    )
                    | (
                        Contact2::Line {
                            p,
                            t,
                            n,
                            rate,
                            window,
                        },
                        Contact2::Circle { c, r0, rate: sg },
                    ) => {
                        let st = (*c - *p).dot(*t);
                        let d0 = (*c - *p).dot(*n);
                        (st >= window.0 - slack
                            && st <= window.1 + slack
                            && d0 > *r0
                            && rate + sg > 0.0)
                            .then(|| (d0 - r0) / (rate + sg))
                    }
                    _ => None,
                };
                if let Some(x) = x.filter(|x| x.is_finite() && *x > 0.0) {
                    out.push((e1, f, x));
                    out.push((e2, f, x));
                }
            }
        }
    }
    out
}

/// Is station `st` within the edge's station range (all stations for a ring)?
fn in_window(g: &Eg, st: f64, slack: f64) -> bool {
    match (g.st_range, g.fam) {
        (None, _) => true,
        (Some((s0, s1)), Fam::Line { .. }) => st >= s0 - slack && st <= s1 + slack,
        (Some((s0, s1)), Fam::Circle { .. }) => {
            let x = s0 + crate::geom::wrap(st - s0);
            x <= s1 + slack || x >= s0 + forge_core::math::TAU - slack
        }
    }
}

/// Does loop `li` of face `f` bound a **hole** in the face's domain (another feature: a
/// hole's wall, a boss's side), rather than the face's own extent? Decided from the loop, not
/// from its index (W6 review round 5): its image in the face's parameters, unwrapped along
/// the periodic directions, must close without winding around one (the two ring loops of a
/// hole's wall bound a band: neither is a hole in it), and it must run clockwise in the
/// parameters when `S_u × S_v` points outward (counter-clockwise otherwise) — loops run with
/// the face on their left seen from outside, so the outer boundary runs the other way. A
/// face with one loop has no hole.
pub(crate) fn bounds_hole(plan: &crate::plan::Plan, f: usize, li: usize) -> bool {
    let Some(face) = plan.fs[f].as_ref() else {
        return false;
    };
    if face.loops.len() < 2 {
        return false;
    }
    let Some(lp) = face.loops.get(li) else {
        return false;
    };
    let (pu, pv) = face.surf.periodicity();
    let unwrap = |x: f64, prev: f64, per: Option<f64>| match per {
        Some(p) => x - ((x - prev) / p).round() * p,
        None => x,
    };
    let mut pts: Vec<(f64, f64)> = Vec::new();
    for u in lp {
        let e = &plan.es[u.edge];
        let n = 32;
        for i in 0..n {
            let k = if u.fwd { i } else { n - i };
            let t = e.range.0 + (e.range.1 - e.range.0) * k as f64 / n as f64;
            let (a, b, _) = face.surf.project(e.curve.eval(t));
            let q = match pts.last() {
                Some(&(pa, pb)) => (unwrap(a, pa, pu), unwrap(b, pb, pv)),
                None => (a, b),
            };
            pts.push(q);
        }
    }
    let (Some(&first), Some(&last)) = (pts.first(), pts.last()) else {
        return false;
    };
    // Closing step, unwrapped like the others: a loop that winds around a periodic
    // direction ends a whole period away from where it started.
    let close = (unwrap(first.0, last.0, pu), unwrap(first.1, last.1, pv));
    let winds = |d: f64, per: Option<f64>| per.is_some_and(|p| d.abs() > 0.5 * p);
    if winds(close.0 - first.0, pu) || winds(close.1 - first.1, pv) {
        return false;
    }
    let n = pts.len();
    let area: f64 = (0..n)
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % n]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    let oriented = if face.sense { area } else { -area };
    oriented < 0.0
}

/// Does edge `e` bound face `f` on a loop that [`bounds_hole`] — the rim of another feature
/// inside the face — (`Some(true)`), on the face's own extent (`Some(false)`), or not at all
/// (`None`)?
pub(crate) fn on_hole_loop(plan: &crate::plan::Plan, f: usize, e: usize) -> Option<bool> {
    let face = plan.fs.get(f)?.as_ref()?;
    let mut on = None;
    for (li, lp) in face.loops.iter().enumerate() {
        if lp.iter().any(|u| u.edge == e) {
            if !bounds_hole(plan, f, li) {
                return Some(false);
            }
            on = Some(true);
        }
    }
    on
}

/// The width of face `f` across the blended edge of `g`, along the unit cross-section
/// direction `dir` into `f` (see the module docs); `None` when nothing bounds it (or the
/// face is not one whose boundary the cross-section describes exactly).
fn face_width(cx: &Cx<'_>, g: &Eg, f: usize, dir: Vec2) -> Option<Width> {
    let plan = cx.plan0;
    let face = plan.fs[f].as_ref()?;
    let exact = matches!(
        (g.fam, &face.surf),
        (Fam::Line { .. }, Surface::Plane(_))
            | (
                Fam::Circle { .. },
                Surface::Plane(_) | Surface::Cylinder(_) | Surface::Cone(_)
            )
    );
    if !exact {
        return None;
    }
    let pe = &plan.es[g.e];
    let own: Vec<usize> = [pe.start, pe.end].into_iter().flatten().collect();
    let slack = 1e-9 * cx.scale.max(1.0);
    let floor = 10.0 * LINEAR_TOLERANCE;
    let lam = |q: Point3| -> Option<f64> {
        let (st, p) = g.fam.to2(q);
        if !in_window(g, st, slack) {
            return None;
        }
        let l = (p - g.e2).dot(dir);
        (l > floor).then_some(l)
    };
    let mut best: Option<Width> = None;
    let tie = 1e-9 * (1.0 + cx.scale);
    // The face named for a limit met at boundary edge `e` of loop `li` (see `Width::named`).
    let holes: Vec<bool> = (0..face.loops.len())
        .map(|li| bounds_hole(plan, f, li))
        .collect();
    let named = |li: usize, e: usize| -> (usize, bool) {
        if !holes[li] {
            return (f, false);
        }
        (
            cx.adj
                .edge_faces(e)
                .into_iter()
                .find(|&o| o != f)
                .unwrap_or(f),
            true,
        )
    };
    let mut consider =
        |l: f64, partner: Option<usize>, limit: Limit, (named, obstacle): (usize, bool)| {
            // The nearest boundary; at a tie (a parallel blended edge's end points are as near
            // as the edge) the shared width wins.
            let better = best.as_ref().is_none_or(|b| {
                l < b.lambda - tie
                    || (l <= b.lambda + tie && partner.is_some() && b.partner.is_none())
            });
            if better {
                best = Some(Width {
                    lambda: l,
                    partner,
                    limit,
                    named,
                    obstacle,
                });
            }
        };
    for (li, u) in face
        .loops
        .iter()
        .enumerate()
        .flat_map(|(li, lp)| lp.iter().map(move |u| (li, u)))
    {
        let e = u.edge;
        if e == g.e {
            continue;
        }
        let x = &plan.es[e];
        for v in [x.start, x.end].into_iter().flatten() {
            if !own.contains(&v)
                && let Some(l) = lam(plan.vs[v].p)
            {
                consider(l, None, Limit::FaceWidth, named(li, e));
            }
        }
        let incident = [x.start, x.end]
            .into_iter()
            .flatten()
            .any(|v| own.contains(&v));
        if incident {
            continue;
        }
        // The curve's interior: exact for a line in a line-family cross-section (station and
        // distance are affine along it), sampled otherwise (the result is only a candidate,
        // confirmed by construction).
        let (t0, t1) = x.range;
        let mut vals: Vec<f64> = Vec::new();
        match (&x.curve, g.fam) {
            (Curve3::Line(_), Fam::Line { .. }) => {
                let (sa, pa) = g.fam.to2(x.curve.eval(t0));
                let (sb, pb) = g.fam.to2(x.curve.eval(t1));
                let (la, lb) = ((pa - g.e2).dot(dir), (pb - g.e2).dot(dir));
                let (w0, w1) = g.st_range.unwrap_or((f64::NEG_INFINITY, f64::INFINITY));
                // Clip [0, 1] to the station window.
                let (mut a, mut b) = (0.0f64, 1.0f64);
                let ds = sb - sa;
                if ds.abs() <= 1e-15 {
                    if !(sa >= w0 - slack && sa <= w1 + slack) {
                        continue;
                    }
                } else {
                    let (ta, tb) = ((w0 - slack - sa) / ds, (w1 + slack - sa) / ds);
                    a = a.max(ta.min(tb));
                    b = b.min(ta.max(tb));
                    if a > b {
                        continue;
                    }
                }
                for s in [a, b] {
                    let l = la + (lb - la) * s;
                    if l > floor {
                        vals.push(l);
                    }
                }
            }
            _ => {
                let n = 256;
                for i in 0..=n {
                    let t = t0 + (t1 - t0) * i as f64 / n as f64;
                    if let Some(l) = lam(x.curve.eval(t)) {
                        vals.push(l);
                    }
                }
            }
        }
        let Some(lmin) = vals.iter().copied().reduce(f64::min) else {
            continue;
        };
        let lmax = vals.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        let parallel = lmax - lmin <= 1e-9 * (1.0 + cx.scale);
        let partner = (parallel && cx.set.contains(&e)).then_some(e);
        consider(lmin, partner, Limit::FaceWidth, named(li, e));
    }
    // A contact circle moving towards the axis on a plane reaches it at λ = ρ_E.
    if let (Fam::Circle { .. }, Surface::Plane(_)) = (g.fam, &face.surf)
        && dir.x < -0.5
    {
        consider(g.e2.x, None, Limit::Curvature, (f, false));
    }
    best
}
