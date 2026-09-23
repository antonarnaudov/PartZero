//! Shared helpers for the forge-ssi integration tests.
#![allow(dead_code)]

use forge_core::geom::{Curve3, Surface};
use forge_core::math;
use forge_core::{Frame, Point3, Vec3};
use forge_ssi::{Branch, IntersectionGraph, UvBox};

/// A frame from a normal and an x hint (panics on degenerate input).
pub fn frame(o: [f64; 3], n: [f64; 3], x: [f64; 3]) -> Frame {
    Frame::from_normal_x(Vec3::from(o), Vec3::from(n), Vec3::from(x)).expect("frame")
}

/// Distance of a point to a surface via its distance form.
pub fn dist(s: &Surface, p: Point3) -> f64 {
    s.distance_form(p).expect("analytic").abs()
}

/// Samples of a branch: `n + 1` uniform in the parameter, plus (for B-splines, whose
/// rational parametrization can be very non-uniform) 16 per knot span.
pub fn samples(b: &Branch, n: usize) -> Vec<(f64, Point3)> {
    let mut ts: Vec<f64> = (0..=n)
        .map(|i| b.range.0 + (b.range.1 - b.range.0) * i as f64 / n as f64)
        .collect();
    if let Curve3::BSpline(c) = &b.curve {
        let mut k: Vec<f64> = c
            .knots()
            .iter()
            .copied()
            .filter(|&x| x >= b.range.0 && x <= b.range.1)
            .collect();
        k.dedup();
        for w in k.windows(2) {
            for j in 1..16 {
                ts.push(w[0] + (w[1] - w[0]) * j as f64 / 16.0);
            }
        }
        ts.sort_by(f64::total_cmp);
    }
    ts.into_iter().map(|t| (t, b.curve.eval(t))).collect()
}

/// Distance from `p` to a polyline.
pub fn polyline_distance(p: Point3, pl: &[Point3]) -> f64 {
    if pl.len() == 1 {
        return pl[0].distance(p);
    }
    pl.windows(2)
        .map(|w| {
            let ab = w[1] - w[0];
            let l2 = ab.norm_squared();
            let s = if l2 > 0.0 {
                ((p - w[0]).dot(ab) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            (w[0] + ab * s).distance(p)
        })
        .fold(f64::INFINITY, f64::min)
}

/// Check the output contract on every branch of a graph: points on both surfaces within
/// `tol`, pcurves consistent, error bound honoured. Returns the worst deviation seen.
pub fn check_contract(g: &IntersectionGraph, a: &Surface, b: &Surface, tol: f64) -> f64 {
    let mut worst: f64 = 0.0;
    for (bi, br) in g.branches.iter().enumerate() {
        assert!(
            br.error_bound <= tol,
            "branch {bi}: error bound {}",
            br.error_bound
        );
        for (t, p) in samples(br, 400) {
            let da = dist(a, p);
            let db = dist(b, p);
            let uva = br.pcurve_a.eval(t);
            let uvb = br.pcurve_b.eval(t);
            let ea = a.eval(uva.x, uva.y).distance(p);
            let eb = b.eval(uvb.x, uvb.y).distance(p);
            let w = da.max(db).max(ea).max(eb);
            assert!(
                w <= tol,
                "branch {bi} ({}) t = {t}: d_a {da:e}, d_b {db:e}, pc_a {ea:e}, pc_b {eb:e}",
                br.curve.kind_name()
            );
            worst = worst.max(w);
        }
    }
    for v in &g.vertices {
        assert!(dist(a, v.point) <= 10.0 * tol && dist(b, v.point) <= 10.0 * tol);
    }
    worst
}

/// Total length of all branches.
pub fn total_length(g: &IntersectionGraph) -> f64 {
    g.branches
        .iter()
        .map(|b| match &b.curve {
            Curve3::BSpline(_) => {
                let s = samples(b, 2000);
                s.windows(2).map(|w| w[0].1.distance(w[1].1)).sum()
            }
            c => c.arc_length(b.range.0, b.range.1),
        })
        .sum()
}

/// A full-period box for periodic surfaces, `[-h, h]` for unbounded directions.
pub fn natural(s: &Surface, h: f64) -> UvBox {
    UvBox::natural(s, h)
}

/// Brute-force "missed branch" detector: sample surface `a` densely over its box, find
/// the points of `a` on `b` (sign changes of b's distance form between neighbours,
/// refined by bisection: certainly intersection points) inside `b`'s box, and check each
/// is within `reach` of the returned intersection (branches or vertices).
/// Returns the number of uncovered sign-change samples.
pub fn missed_samples(
    g: &IntersectionGraph,
    a: &Surface,
    da: &UvBox,
    b: &Surface,
    db: &UvBox,
    n: usize,
    reach: f64,
) -> usize {
    let mut lines: Vec<Vec<Point3>> = g
        .branches
        .iter()
        .map(|br| samples(br, 600).into_iter().map(|x| x.1).collect())
        .collect();
    lines.extend(g.vertices.iter().map(|v| vec![v.point]));
    let (pu, pv) = b.periodicity();
    let _ = (pu, pv);
    let grid = |i: usize, j: usize| {
        let u = da.u.0 + (da.u.1 - da.u.0) * i as f64 / n as f64;
        let v = da.v.0 + (da.v.1 - da.v.0) * j as f64 / n as f64;
        (u, v)
    };
    let val = |u: f64, v: f64| b.distance_form(a.eval(u, v)).expect("d");
    let mut missed = 0;
    for i in 0..n {
        for j in 0..n {
            let (u, v) = grid(i, j);
            let f0 = val(u, v);
            for (di, dj) in [(1, 0), (0, 1)] {
                let (u1, v1) = grid(i + di, j + dj);
                let f1 = val(u1, v1);
                if f0 == 0.0 || f0.signum() != f1.signum() {
                    // A crossing between two samples, located by bisection (linear
                    // interpolation misplaces it where the distance form is far from
                    // linear along the edge, e.g. at near-tangential crossings).
                    let (mut lo, mut hi) = (0.0f64, 1.0f64);
                    if f0 != 0.0 {
                        for _ in 0..60 {
                            let m = 0.5 * (lo + hi);
                            let fm = val(u + (u1 - u) * m, v + (v1 - v) * m);
                            if fm.signum() == f0.signum() && fm != 0.0 {
                                lo = m;
                            } else {
                                hi = m;
                            }
                        }
                    }
                    let s = if f0 == 0.0 { 0.0 } else { 0.5 * (lo + hi) };
                    let q = a.eval(u + (u1 - u) * s, v + (v1 - v) * s);
                    // Only count points inside b's box.
                    let (ur, vr) = (0.5 * db.u.0 + 0.5 * db.u.1, 0.5 * db.v.0 + 0.5 * db.v.1);
                    let (qu, qv, _) = b.project(q);
                    let quv = forge_core::Point2::new(
                        if b.periodicity().0.is_some() {
                            ur + math::wrap_angle(qu - ur + math::PI, 0.0) - math::PI
                        } else {
                            qu
                        },
                        if b.periodicity().1.is_some() {
                            vr + math::wrap_angle(qv - vr + math::PI, 0.0) - math::PI
                        } else {
                            qv
                        },
                    );
                    if !db.contains(b, quv, [1e-9, 1e-9]) {
                        continue;
                    }
                    let near = lines.iter().any(|pl| polyline_distance(q, pl) <= reach);
                    if !near {
                        missed += 1;
                    }
                }
            }
        }
    }
    missed
}
