//! Winding number of a sketch loop around a point (ray casting towards +x).
//!
//! The loop is cut into y-monotone pieces whose end points are shared exactly between
//! consecutive pieces (junction points, and the exact top/bottom points of arcs), so the
//! half-open rule `y0 ≤ p.y < y1` counts every crossing once. A piece is crossed when the
//! point lies strictly left of it at height `p.y`:
//! - line pieces: the exact sign of [`orient2d`] (Sunday's algorithm);
//! - arc pieces: `p.x < x_arc(p.y)` with `x_arc = cx ± √((r − |dy|)(r + |dy|))`.
//!
//! The caller guarantees that `p` is farther than the linear tolerance from the loop
//! (sketch stage 2), which makes the closed-form arc comparison robust.

use forge_core::linalg::Point2;
use forge_core::{math, orient2d};

use super::{Loop, LoopCurveGeom};

pub(super) fn winding_number(lp: &Loop, p: Point2) -> i32 {
    let n = lp.curves.len();
    let mut wn = 0;
    for (k, c) in lp.curves.iter().enumerate() {
        match c.geom {
            LoopCurveGeom::Line { start, end } => wn += line_piece(start, end, p),
            LoopCurveGeom::Arc {
                center,
                radius,
                start_angle,
                sweep,
            } => {
                let a = lp.junctions[k].point;
                let b = lp.junctions[(k + 1) % n].point;
                wn += arc_pieces(p, center, radius, start_angle, sweep, a, b);
            }
            LoopCurveGeom::Circle {
                center,
                radius,
                ccw,
            } => {
                let bottom = Point2::new(center.x, center.y - radius);
                let top = Point2::new(center.x, center.y + radius);
                // CCW: right half upward, left half downward; CW: the reverse.
                let (right, left) = if ccw {
                    ((bottom, top), (top, bottom))
                } else {
                    ((top, bottom), (bottom, top))
                };
                wn += arc_piece(p, center, radius, true, right.0, right.1);
                wn += arc_piece(p, center, radius, false, left.0, left.1);
            }
        }
    }
    wn
}

fn line_piece(a: Point2, b: Point2, p: Point2) -> i32 {
    if a.y <= p.y {
        if b.y > p.y && orient2d(a, b, p) > 0.0 {
            return 1;
        }
    } else if b.y <= p.y && orient2d(a, b, p) < 0.0 {
        return -1;
    }
    0
}

/// Crossing count of one y-monotone arc piece `q0 → q1` on the right (`x ≥ cx`) or left
/// half of the circle.
fn arc_piece(p: Point2, c: Point2, r: f64, right: bool, q0: Point2, q1: Point2) -> i32 {
    let crossed = || {
        let dy = (p.y - c.y).abs().min(r);
        let w = ((r - dy) * (r + dy)).sqrt();
        let x = if right { c.x + w } else { c.x - w };
        p.x < x
    };
    if q0.y <= p.y && p.y < q1.y {
        if crossed() {
            return 1;
        }
    } else if q1.y <= p.y && p.y < q0.y && crossed() {
        return -1;
    }
    0
}

/// Split the arc at its top/bottom points and count the crossings of each piece.
fn arc_pieces(
    p: Point2,
    c: Point2,
    r: f64,
    start_angle: f64,
    sweep: f64,
    a: Point2,
    b: Point2,
) -> i32 {
    let half_pi = math::FRAC_PI_2;
    let end_angle = start_angle + sweep;
    // Split angles s = π/2 + kπ strictly inside the sweep, in traversal order.
    let mut splits: Vec<(f64, Point2)> = Vec::new();
    let (lo, hi) = if sweep > 0.0 {
        (start_angle, end_angle)
    } else {
        (end_angle, start_angle)
    };
    let mut k = ((lo - half_pi) / math::PI).floor() as i64;
    loop {
        let s = half_pi + k as f64 * math::PI;
        if s >= hi {
            break;
        }
        if s > lo {
            let top = k.rem_euclid(2) == 0;
            let q = Point2::new(c.x, if top { c.y + r } else { c.y - r });
            splits.push((s, q));
        }
        k += 1;
    }
    if sweep < 0.0 {
        splits.reverse();
    }
    let mut angles = vec![start_angle];
    let mut points = vec![a];
    for (s, q) in splits {
        angles.push(s);
        points.push(q);
    }
    angles.push(end_angle);
    points.push(b);
    let mut wn = 0;
    for i in 0..points.len() - 1 {
        let mid = 0.5 * (angles[i] + angles[i + 1]);
        let right = math::cos(mid) >= 0.0;
        wn += arc_piece(p, c, r, right, points[i], points[i + 1]);
    }
    wn
}
