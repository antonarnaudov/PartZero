//! Faces as **curves of the cross-section** (W6 review round 3: the curved pairs of SPEC
//! §6.6's supported set). In the plane normal to a line edge, or the meridian half-plane of
//! a circle edge, each face adjacent to the edge is a curve through the edge point `E`:
//! - a **line** — a plane; a plane perpendicular to a circle edge's axis, a coaxial
//!   cylinder or cone (the families of [`super::edge`]);
//! - a **circle** — a cylinder whose axis is parallel to a line edge (a D-flat's edge is one
//!   of its generators), a sphere centred on a circle edge's axis (a dimple's rim), a ring
//!   torus about it (its meridian circle).
//!
//! The cross-section is then constant along the edge, so the blends stay analytic: the
//! rolling ball's centre moves on a line (a **cylinder** blend) or a circle about the axis (a
//! **torus**), and a bevel through two contact lines or circles is a **plane** or a surface
//! of revolution (plane, cylinder, cone).
//!
//! - **Fillet**: the ball of radius `r` touches each face from the side where the other face
//!   lies (the inside of the angle between their tangents at `E`): its centre is where the
//!   faces' offsets by `r` meet — a line moved by `r`, a concentric circle of radius `R ∓ r`
//!   (smaller when the ball is on the centre's side) — at the intersection nearest the one of
//!   the tangent lines (exact when both faces are lines), and it touches a line at the foot
//!   of the perpendicular, a circle on the ray from its centre through the ball's.
//! - **Chamfer**: the contact on each face at the **chord** distance `d` from `E` (OCCT's
//!   convention, checked on a D-flat and a dimple: its bevel meets the cylinder and the
//!   sphere at chord distance `d`, not arc length); in the distance–angle form, from the
//!   contact on a planar side face along the direction at the angle to it until the other
//!   face.
//!
//! Every value that makes a construction impossible — an offset circle of radius ≤ 0, offsets
//! that do not meet, a contact that does not lie on the face's arc leaving `E` (less than a
//! quarter turn, so that the region of [`super::region`] is the one between the arcs), a
//! chord longer than the circle's diameter — is `curvature` infeasibility: the feasible range
//! is searched for as for any other limit.

use forge_core::linalg::Vec2;
use forge_core::math;
use forge_ir::v1::LINEAR_TOLERANCE;

/// A face's curve in the cross-section, through `E`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Sec {
    /// A line along the face's tangent direction at `E`.
    Line,
    /// A circle with centre `c` and radius `r`.
    Circle { c: Vec2, r: f64 },
}

/// Why a section construction failed: the value is too large for the faces' curvature
/// (`side`: 0 for face `a`, 1 for `b`, the face whose curve limits it).
#[derive(Clone, Debug)]
pub(crate) struct SecFail {
    pub side: usize,
    pub what: String,
}

fn fail(side: usize, what: impl Into<String>) -> SecFail {
    SecFail {
        side,
        what: what.into(),
    }
}

/// The unit normal to `dir` on the side of `toward`.
pub(crate) fn toward(dir: Vec2, toward: Vec2) -> Vec2 {
    let n = Vec2::new(-dir.y, dir.x);
    if n.dot(toward) >= 0.0 { n } else { -n }
}

/// The largest arc (radians) a contact may lie from `E` on a circle face.
const MAX_ARC: f64 = math::FRAC_PI_2;

/// The signed angle, in the direction face `i` leaves `E`, from `E` to `p` on the circle
/// `(c, r)`.
fn arc_from(e: Vec2, i: Vec2, c: Vec2, p: Vec2) -> f64 {
    let (a, b) = (e - c, p - c);
    let ccw = a.perp_dot(i) > 0.0;
    let ang = math::atan2(a.perp_dot(b), a.dot(b));
    if ccw { ang } else { -ang }
}

/// The contact of face `k` (curve `sec`, tangent `i` at `e`) with a ball centred at `c2`,
/// checked to lie on the face's arc (line: ahead of `E`; circle: within a quarter turn).
fn foot(k: usize, e: Vec2, i: Vec2, sec: Sec, c2: Vec2) -> Result<Vec2, SecFail> {
    match sec {
        Sec::Line => {
            let s = (c2 - e).dot(i);
            if s <= 10.0 * LINEAR_TOLERANCE {
                return Err(fail(
                    k,
                    "the ball does not touch the face ahead of the edge",
                ));
            }
            Ok(e + i * s)
        }
        Sec::Circle { c, r } => {
            let Some(u) = (c2 - c).normalize() else {
                return Err(fail(
                    k,
                    "the ball is centred on the face's axis of curvature",
                ));
            };
            let p = c + u * r;
            let a = arc_from(e, i, c, p);
            if !(a > 0.0 && a <= MAX_ARC) {
                return Err(fail(
                    k,
                    format!(
                        "the ball touches the curved face {:.1}° from the edge (at most 90°)",
                        math::rad_to_deg(a)
                    ),
                ));
            }
            Ok(p)
        }
    }
}

/// The offset of face `k` by `r` towards `n`: a line (point, direction) or a circle (centre,
/// radius).
enum Off {
    Line(Vec2, Vec2),
    Circle(Vec2, f64),
}

fn offset(k: usize, e: Vec2, i: Vec2, n: Vec2, sec: Sec, r: f64) -> Result<Off, SecFail> {
    match sec {
        Sec::Line => Ok(Off::Line(e + n * r, i)),
        Sec::Circle { c, r: rad } => {
            let inside = (c - e).dot(n) > 0.0;
            let rr = if inside { rad - r } else { rad + r };
            if rr <= 10.0 * LINEAR_TOLERANCE {
                return Err(fail(
                    k,
                    format!("the radius {r} reaches the face's radius of curvature {rad}"),
                ));
            }
            Ok(Off::Circle(c, rr))
        }
    }
}

/// Points where the two offsets meet.
fn meet(a: &Off, b: &Off) -> Vec<Vec2> {
    let line_circle = |p: Vec2, d: Vec2, c: Vec2, rr: f64| -> Vec<Vec2> {
        // |p + d s − c|² = rr², |d| = 1.
        let w = p - c;
        let bq = w.dot(d);
        let cq = w.dot(w) - rr * rr;
        let disc = bq * bq - cq;
        if disc < 0.0 {
            return Vec::new();
        }
        let sq = math::sqrt(disc);
        vec![p + d * (-bq - sq), p + d * (-bq + sq)]
    };
    match (a, b) {
        (Off::Line(p, d), Off::Line(q, e)) => {
            let den = d.perp_dot(*e);
            if den.abs() <= 1e-15 {
                return Vec::new();
            }
            let s = (*q - *p).perp_dot(*e) / den;
            vec![*p + *d * s]
        }
        (Off::Line(p, d), Off::Circle(c, rr)) | (Off::Circle(c, rr), Off::Line(p, d)) => {
            line_circle(*p, *d, *c, *rr)
        }
        (Off::Circle(c1, r1), Off::Circle(c2, r2)) => {
            let dd = *c2 - *c1;
            let dist = dd.norm();
            if dist <= 1e-15 || dist > r1 + r2 || dist < (r1 - r2).abs() {
                return Vec::new();
            }
            let a = (r1 * r1 - r2 * r2 + dist * dist) / (2.0 * dist);
            let h = math::sqrt((r1 * r1 - a * a).max(0.0));
            let u = dd / dist;
            let m = *c1 + u * a;
            let n = Vec2::new(-u.y, u.x);
            vec![m + n * h, m - n * h]
        }
    }
}

/// Fillet: the ball centre and the contacts `(c2, pa, pb)` of a ball of radius `r` touching
/// both faces inside the angle between their tangents `ia`, `ib` at `e`.
pub(crate) fn fillet(
    e: Vec2,
    ia: Vec2,
    ib: Vec2,
    secs: [Sec; 2],
    r: f64,
) -> Result<(Vec2, Vec2, Vec2), SecFail> {
    let phi = math::acos(ia.dot(ib).clamp(-1.0, 1.0));
    let (sh, _) = math::sin_cos(0.5 * phi);
    let m = (ia + ib)
        .normalize()
        .ok_or_else(|| fail(0, "degenerate edge angle"))?;
    // The ball of the tangent lines (exact when both faces are lines).
    let c0 = e + m * (r / sh);
    if secs == [Sec::Line, Sec::Line] {
        return Ok((c0, e + ia * (c0 - e).dot(ia), e + ib * (c0 - e).dot(ib)));
    }
    let (na, nb) = (toward(ia, ib), toward(ib, ia));
    let oa = offset(0, e, ia, na, secs[0], r)?;
    let ob = offset(1, e, ib, nb, secs[1], r)?;
    let Some(c2) = meet(&oa, &ob)
        .into_iter()
        .min_by(|p, q| p.distance(c0).total_cmp(&q.distance(c0)))
    else {
        return Err(fail(
            usize::from(matches!(secs[0], Sec::Line)),
            "the faces' offsets by the radius do not meet",
        ));
    };
    let pa = foot(0, e, ia, secs[0], c2)?;
    let pb = foot(1, e, ib, secs[1], c2)?;
    Ok((c2, pa, pb))
}

/// Chamfer: the point of face `k` (tangent `i` at `e`) at chord distance `d` from `e`.
pub(crate) fn at_distance(k: usize, e: Vec2, i: Vec2, sec: Sec, d: f64) -> Result<Vec2, SecFail> {
    match sec {
        Sec::Line => Ok(e + i * d),
        Sec::Circle { c, r } => {
            let half = d / (2.0 * r);
            if half.is_nan() || half >= 1.0 {
                return Err(fail(
                    k,
                    format!("the distance {d} exceeds the face's diameter {}", 2.0 * r),
                ));
            }
            let th = 2.0 * math::asin(half);
            if th > MAX_ARC {
                return Err(fail(
                    k,
                    format!(
                        "the distance {d} reaches a quarter turn of the curved face (radius {r})"
                    ),
                ));
            }
            let a = e - c;
            let ccw = a.perp_dot(i) > 0.0;
            let (s, co) = math::sin_cos(if ccw { th } else { -th });
            Ok(c + Vec2::new(a.x * co - a.y * s, a.x * s + a.y * co))
        }
    }
}

/// Distance–angle chamfer: from the contact `ps` at distance `d` on the side face `s`
/// (a line, tangent `is`), along the direction at `angle` to it towards the other face `o`
/// (tangent `io`, curve `so`), to where it meets `o`. `None` when it never does.
pub(crate) fn along_angle(
    e: Vec2,
    is: Vec2,
    io: Vec2,
    so: Sec,
    d: f64,
    angle: f64,
) -> Option<Vec2> {
    let ps = e + is * d;
    let n = toward(is, io);
    let (s, c) = math::sin_cos(angle);
    let w = -is * c + n * s;
    let hits: Vec<f64> = match so {
        Sec::Line => {
            let den = w.perp_dot(io);
            if den.abs() <= 1e-15 {
                return None;
            }
            vec![(e - ps).perp_dot(io) / den]
        }
        Sec::Circle { c: cc, r } => {
            let q = ps - cc;
            let bq = q.dot(w);
            let disc = bq * bq - (q.dot(q) - r * r);
            if disc < 0.0 {
                return None;
            }
            let sq = math::sqrt(disc);
            vec![-bq - sq, -bq + sq]
        }
    };
    hits.into_iter()
        .filter(|&t| t > 10.0 * LINEAR_TOLERANCE)
        .map(|t| ps + w * t)
        .filter(|p| match so {
            Sec::Line => (*p - e).dot(io) > 10.0 * LINEAR_TOLERANCE,
            Sec::Circle { c, .. } => {
                let a = arc_from(e, io, c, *p);
                a > 0.0 && a <= MAX_ARC
            }
        })
        .min_by(|p, q| p.distance(ps).total_cmp(&q.distance(ps)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: Vec2, b: Vec2) -> bool {
        a.distance(b) <= 1e-12 * (1.0 + a.norm())
    }

    #[test]
    fn two_lines_give_the_planar_ball() {
        let (e, ia, ib) = (Vec2::zero(), Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0));
        let (c2, pa, pb) = fillet(e, ia, ib, [Sec::Line, Sec::Line], 2.0).unwrap();
        assert!(
            close(c2, Vec2::new(2.0, 2.0))
                && close(pa, Vec2::new(2.0, 0.0))
                && close(pb, Vec2::new(0.0, 2.0))
        );
    }

    #[test]
    fn a_d_flat_ball_touches_the_flat_and_the_shaft() {
        // Shaft radius 10 about the origin, flat x = 7; the edge point E = (7, √51); the
        // material is inside the circle and at x ≤ 7.
        let e = Vec2::new(7.0, 51f64.sqrt());
        let ia = Vec2::new(0.0, -1.0); // down the flat
        let ib = Vec2::new(-e.y, e.x).normalize().unwrap(); // along the circle, counter-clockwise
        let secs = [
            Sec::Line,
            Sec::Circle {
                c: Vec2::zero(),
                r: 10.0,
            },
        ];
        let r = 2.0;
        let (c2, pa, pb) = fillet(e, ia, ib, secs, r).unwrap();
        // Centre at distance r from the flat and 10 − r from the axis.
        assert!(
            (c2.x - 5.0).abs() < 1e-12 && (c2.norm() - 8.0).abs() < 1e-12,
            "{c2:?}"
        );
        assert!((pa - c2).norm() - r < 1e-12 && (pa.x - 7.0).abs() < 1e-12);
        assert!(((pb - c2).norm() - r).abs() < 1e-12 && (pb.norm() - 10.0).abs() < 1e-12);
        // Too large for the flat's arc: the ball would reach past a quarter turn.
        assert!(fillet(e, ia, ib, secs, 9.99).is_err());
    }

    #[test]
    fn chamfer_contacts_are_at_chord_distance() {
        let e = Vec2::new(7.0, 51f64.sqrt());
        let ib = Vec2::new(-e.y, e.x).normalize().unwrap();
        let p = at_distance(
            1,
            e,
            ib,
            Sec::Circle {
                c: Vec2::zero(),
                r: 10.0,
            },
            2.0,
        )
        .unwrap();
        assert!((p.distance(e) - 2.0).abs() < 1e-12 && (p.norm() - 10.0).abs() < 1e-12);
        // OCCT's contact on the D-flat of the experiment (R 10, flat 3 deep, d 2).
        assert!(
            p.distance(Vec2::new(5.438873686, 8.391582272)) < 1e-8,
            "{p:?}"
        );
        assert!(p.dot(ib) > e.dot(ib));
    }

    #[test]
    fn distance_angle_on_lines_is_the_law_of_sines() {
        let (e, ia, ib) = (Vec2::zero(), Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0));
        let th = 30f64.to_radians();
        let p = along_angle(e, ia, ib, Sec::Line, 2.0, th).unwrap();
        let other = 2.0 * th.sin() / (std::f64::consts::FRAC_PI_2 + th).sin();
        assert!(close(p, Vec2::new(0.0, other)), "{p:?} {other}");
    }
}
