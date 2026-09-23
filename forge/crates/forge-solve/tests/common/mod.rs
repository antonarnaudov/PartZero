//! An independent checker: measures how far a sketch is from satisfying each constraint
//! with plain geometric formulas, deliberately *not* reusing the solver's residual code.
//! Units are natural: millimetres for lengths, radians / sines for angular conditions.

#![allow(dead_code)]

use std::collections::BTreeMap;

use forge_core::math;
use forge_solve::{ConstraintKind as K, Geometry, Sketch};

type Pt = [f64; 2];

struct View<'a> {
    by_id: BTreeMap<&'a str, &'a Geometry>,
    input: BTreeMap<&'a str, &'a Geometry>,
}

impl<'a> View<'a> {
    fn pt(&self, id: &str) -> Pt {
        match self.by_id[id] {
            Geometry::Point { x, y } => [*x, *y],
            g => panic!("{id} is not a point: {g:?}"),
        }
    }
    fn input_pt(&self, id: &str) -> Pt {
        match self.input[id] {
            Geometry::Point { x, y } => [*x, *y],
            g => panic!("{id} is not a point: {g:?}"),
        }
    }
    fn line(&self, id: &str) -> (Pt, Pt) {
        match self.by_id[id] {
            Geometry::Line { p1, p2 } => (self.pt(p1), self.pt(p2)),
            g => panic!("{id} is not a line: {g:?}"),
        }
    }
    /// Center and radius of a circle or arc.
    fn curve(&self, id: &str) -> (Pt, f64) {
        match self.by_id[id] {
            Geometry::Circle { center, radius } => (self.pt(center), *radius),
            Geometry::Arc { center, start, .. } => {
                let c = self.pt(center);
                (c, dist(c, self.pt(start)))
            }
            g => panic!("{id} is not a curve: {g:?}"),
        }
    }
    fn is(&self, id: &str, t: &str) -> bool {
        self.by_id[id].type_name() == t
    }
}

fn sub(a: Pt, b: Pt) -> Pt {
    [a[0] - b[0], a[1] - b[1]]
}
fn dist(a: Pt, b: Pt) -> f64 {
    math::hypot(b[0] - a[0], b[1] - a[1])
}
fn cross(a: Pt, b: Pt) -> f64 {
    a[0] * b[1] - a[1] * b[0]
}
fn dot(a: Pt, b: Pt) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}
fn len(a: Pt) -> f64 {
    math::hypot(a[0], a[1])
}
fn line_dist(p: Pt, l: (Pt, Pt)) -> f64 {
    let d = sub(l.1, l.0);
    cross(d, sub(p, l.0)).abs() / len(d)
}

/// Largest violation of any driving constraint or arc rule of `solved`. `input` supplies
/// the default targets of `fix` constraints.
pub fn max_violation(solved: &Sketch, input: &Sketch) -> f64 {
    let v = View {
        by_id: solved
            .entities
            .iter()
            .map(|e| (e.id.as_str(), &e.geometry))
            .collect(),
        input: input
            .entities
            .iter()
            .map(|e| (e.id.as_str(), &e.geometry))
            .collect(),
    };
    let mut worst = 0.0f64;
    for e in &solved.entities {
        if let Geometry::Arc { center, start, end } = &e.geometry {
            let c = v.pt(center);
            worst = worst.max((dist(c, v.pt(start)) - dist(c, v.pt(end))).abs());
        }
    }
    for con in &solved.constraints {
        if !con.driving {
            continue;
        }
        let err = match &con.kind {
            K::Coincident { a, b } => dist(v.pt(a), v.pt(b)),
            K::Horizontal { line } => {
                let (a, b) = v.line(line);
                (b[1] - a[1]).abs()
            }
            K::Vertical { line } => {
                let (a, b) = v.line(line);
                (b[0] - a[0]).abs()
            }
            K::Parallel { a, b } => {
                let (u, w) = (v.line(a), v.line(b));
                let (u, w) = (sub(u.1, u.0), sub(w.1, w.0));
                cross(u, w).abs() / (len(u) * len(w))
            }
            K::Perpendicular { a, b } => {
                let (u, w) = (v.line(a), v.line(b));
                let (u, w) = (sub(u.1, u.0), sub(w.1, w.0));
                dot(u, w).abs() / (len(u) * len(w))
            }
            K::Tangent { a, b, .. } => {
                if v.is(a, "line") || v.is(b, "line") {
                    let (l, cv) = if v.is(a, "line") { (a, b) } else { (b, a) };
                    let (c, r) = v.curve(cv);
                    (line_dist(c, v.line(l)) - r).abs()
                } else {
                    let ((c1, r1), (c2, r2)) = (v.curve(a), v.curve(b));
                    let d = dist(c1, c2);
                    (d - (r1 + r2)).abs().min((d - (r1 - r2).abs()).abs())
                }
            }
            K::Equal { a, b } => {
                if v.is(a, "line") {
                    let (u, w) = (v.line(a), v.line(b));
                    (dist(u.0, u.1) - dist(w.0, w.1)).abs()
                } else {
                    (v.curve(a).1 - v.curve(b).1).abs()
                }
            }
            K::Distance { a, b, value } => {
                if v.is(b, "line") {
                    (line_dist(v.pt(a), v.line(b)) - value).abs()
                } else {
                    (dist(v.pt(a), v.pt(b)) - value).abs()
                }
            }
            K::Angle { a, b, value } => {
                let (u, w) = (v.line(a), v.line(b));
                let (u, w) = (sub(u.1, u.0), sub(w.1, w.0));
                let phi = math::atan2(cross(u, w), dot(u, w));
                let e = phi - math::deg_to_rad(*value);
                math::atan2(math::sin(e), math::cos(e)).abs()
            }
            K::Radius { curve, value } => (v.curve(curve).1 - value).abs(),
            K::Diameter { curve, value } => (2.0 * v.curve(curve).1 - value).abs(),
            K::PointOnLine { point, line } => line_dist(v.pt(point), v.line(line)),
            K::PointOnCircle { point, curve } => {
                let (c, r) = v.curve(curve);
                (dist(c, v.pt(point)) - r).abs()
            }
            K::Midpoint { point, line } => {
                let (a, b) = v.line(line);
                dist(v.pt(point), [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0])
            }
            K::Symmetric { a, b, line } => {
                let (pa, pb) = (v.pt(a), v.pt(b));
                let l = v.line(line);
                let m = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
                let d = sub(l.1, l.0);
                line_dist(m, l) + dot(d, sub(pb, pa)).abs() / len(d)
            }
            K::Fix { entity, x, y } => match v.by_id[entity.as_str()] {
                Geometry::Point { .. } => {
                    let t = v.input_pt(entity);
                    dist(v.pt(entity), [x.unwrap_or(t[0]), y.unwrap_or(t[1])])
                }
                Geometry::Line { p1, p2 } => {
                    dist(v.pt(p1), v.input_pt(p1)).max(dist(v.pt(p2), v.input_pt(p2)))
                }
                Geometry::Circle { center, radius } => {
                    let r0 = match v.input[entity.as_str()] {
                        Geometry::Circle { radius, .. } => *radius,
                        _ => unreachable!(),
                    };
                    dist(v.pt(center), v.input_pt(center)).max((radius - r0).abs())
                }
                Geometry::Arc { .. } => unreachable!("fix on arcs is rejected"),
            },
        };
        worst = worst.max(err);
    }
    worst
}
