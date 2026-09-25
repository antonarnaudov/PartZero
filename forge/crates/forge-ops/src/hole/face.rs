//! Point–face tests for hole placement (`HOLE_POINT_OFF_FACE`) and `up_to` depths
//! (`HOLE_UP_TO_MISSED`), on planar faces.
//!
//! [`planar_face_distance`] is the distance from a point of a planar face's plane to the
//! face (0 inside):
//! 1. the distance to the boundary is the smallest distance to the trimmed edges (closed
//!    form for lines and circles; for ellipses and B-splines 256 samples, then golden-section
//!    refinement around every sampled local minimum, across the seam of a closed edge);
//! 2. a point farther than the SSI fit tolerance from the boundary is classified by the
//!    parity of the boundary crossings of a ray in the plane, each edge intersected with the
//!    plane through the ray perpendicular to the face by the certified
//!    `forge_ssi::intersect_curve_surface` (complete root sets) inside a box that contains
//!    the whole boundary (bounded per edge by its end points, circle or ellipse radius, or
//!    B-spline control polygon — not by the end points alone, which miss the far side of an
//!    ellipse or spline edge and flip the parity). A ray that grazes an edge,
//!    runs along one or passes within `1e-7·s` of a vertex is discarded for the next of a
//!    fixed list of directions; if every direction is ambiguous the test fails explicitly.
//!
//! Positions within `tol` of the face's boundary are on the face (SPEC §6.5: "inside or on
//! its boundary within tol").

use forge_core::geom::{Curve3, Plane, Surface};
use forge_core::linalg::{Point3, Vec3};
use forge_core::math;
use forge_core::topo::{Body, Edge, FaceId};
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ssi::{SsiTolerance, UvBox, intersect_curve_surface};

use super::error::HoleError;

/// Distance from `p` to the trimmed edge (mm).
fn edge_distance(e: &Edge, p: Point3) -> f64 {
    let (t0, t1) = e.t_range;
    match &e.curve {
        Curve3::Line(l) => {
            let t = (p - l.origin()).dot(l.dir()).clamp(t0, t1);
            l.eval(t).distance(p)
        }
        Curve3::Circle(c) => {
            let f = c.frame();
            let q = f.to_local_point(p);
            let rho = math::hypot(q.x, q.y);
            let ends = e
                .curve
                .eval(t0)
                .distance(p)
                .min(e.curve.eval(t1).distance(p));
            if rho <= 0.0 {
                return math::hypot(c.radius(), q.z);
            }
            let phi = math::atan2(q.y, q.x);
            // The angle of the foot point, brought into [t0, t0 + 2π).
            let a = math::wrap_angle(phi, t0);
            if a <= t1 {
                math::hypot(rho - c.radius(), q.z).min(ends)
            } else {
                ends
            }
        }
        _ => {
            // Sampling, then golden-section refinement around every sampled local minimum. A
            // closed edge wraps around its seam: its first and last samples are neighbours, and
            // a minimum next to the seam is refined on both sides of it (refining only after
            // the first sample missed a foot point just before the seam: 9e-4 mm too far).
            let n = 256usize;
            let at = |t: f64| e.curve.eval(t).distance(p);
            let h = (t1 - t0) / n as f64;
            let d: Vec<f64> = (0..=n).map(|k| at(t0 + h * k as f64)).collect();
            let closed = e.curve.eval(t0).distance(e.curve.eval(t1)) <= LINEAR_TOLERANCE;
            let golden = |mut a: f64, mut b: f64| {
                let g = 0.5 * (5f64.sqrt() - 1.0);
                for _ in 0..80 {
                    let (c, d) = (b - g * (b - a), a + g * (b - a));
                    if at(c) < at(d) {
                        b = d;
                    } else {
                        a = c;
                    }
                }
                at(0.5 * (a + b))
            };
            let mut best = d.iter().copied().fold(f64::INFINITY, f64::min);
            for k in 0..=n {
                let prev = match k {
                    0 if closed => d[n - 1],
                    0 => f64::INFINITY,
                    _ => d[k - 1],
                };
                let next = match k {
                    _ if k == n && closed => d[1],
                    _ if k == n => f64::INFINITY,
                    _ => d[k + 1],
                };
                if d[k] > prev || d[k] > next {
                    continue;
                }
                let tk = t0 + h * k as f64;
                best = best.min(golden((tk - h).max(t0), (tk + h).min(t1)));
                if closed && k == 0 {
                    best = best.min(golden(t1 - h, t1));
                }
                if closed && k == n {
                    best = best.min(golden(t0, t0 + h));
                }
            }
            best
        }
    }
}

/// An upper bound on the distance from `p` to every point of the trimmed edge: its end
/// points for a line; the center distance plus the radius (circle) or the major radius
/// (ellipse); the farthest control point for a B-spline (convex hull property: forge-core
/// NURBS weights are positive).
pub(super) fn edge_reach(e: &Edge, p: Point3) -> f64 {
    let ends = || {
        e.curve
            .eval(e.t_range.0)
            .distance(p)
            .max(e.curve.eval(e.t_range.1).distance(p))
    };
    match &e.curve {
        Curve3::Line(_) => ends(),
        Curve3::Circle(c) => c.frame().origin().distance(p) + c.radius(),
        Curve3::Ellipse(c) => c.frame().origin().distance(p) + c.rx().abs().max(c.ry().abs()),
        // Inside the cylinder of the largest radius around the axis segment it spans.
        Curve3::Helix(h) => {
            let f = h.frame();
            let (t0, t1) = e.t_range;
            let r = h.radius_at(t0).abs().max(h.radius_at(t1).abs());
            let axis = |t: f64| f.origin() + f.z() * (h.rise() * t);
            axis(t0).distance(p).max(axis(t1).distance(p)) + r
        }
        Curve3::BSpline(n) => n
            .control_points()
            .iter()
            .map(|q| Vec3::new(q[0], q[1], q[2]).distance(p))
            .fold(ends(), f64::max),
    }
}

/// The plane of a planar face, or `PLANE_NOT_PLANAR`.
fn plane_of(body: &Body, face: FaceId) -> Result<Plane, HoleError> {
    let f = body
        .face(face)
        .ok_or_else(|| HoleError::internal("the face is not in the body"))?;
    match &f.surface {
        Surface::Plane(p) => Ok(*p),
        s => Err(HoleError::NotPlanar {
            surface: s.kind_name().into(),
        }),
    }
}

pub(super) fn face_edges(body: &Body, face: FaceId) -> Vec<&Edge> {
    let Some(f) = body.face(face) else {
        return Vec::new();
    };
    f.loops
        .iter()
        .filter_map(|&l| body.loop_(l))
        .flat_map(|l| l.coedges.iter())
        .filter_map(|&c| body.coedge(c))
        .filter_map(|c| body.edge(c.edge))
        .collect()
}

/// Ray directions tried in turn (angles in the face plane, radians): irrational-looking
/// offsets so that axis-aligned boundaries are never hit along an edge.
const RAY_ANGLES: [f64; 8] = [
    0.3141, 1.9137, 3.7713, 5.1023, 0.8622, 2.6457, 4.4449, 5.8831,
];

/// Distance from `p` (on the face's plane) to the planar face `face` of `body`: 0 inside or
/// on the boundary, the distance to the boundary outside.
pub fn planar_face_distance(body: &Body, face: FaceId, p: Point3) -> Result<f64, HoleError> {
    let (inside, boundary) = planar_face_classify(body, face, p)?;
    Ok(if inside { 0.0 } else { boundary })
}

/// Where `p` (on the face's plane) lies with respect to the planar face `face` of `body`:
/// `(inside, boundary)`, `inside` when `p` is inside the face or on its boundary (within the
/// SSI fit tolerance), `boundary` the distance from `p` to the face's boundary (the
/// module docs' step 1). A point strictly inside, farther than `δ` from the boundary, is
/// `inside && boundary > δ`.
pub(crate) fn planar_face_classify(
    body: &Body,
    face: FaceId,
    p: Point3,
) -> Result<(bool, f64), HoleError> {
    let plane = plane_of(body, face)?;
    let edges = face_edges(body, face);
    if edges.is_empty() {
        return Err(HoleError::internal("a planar face without boundary"));
    }
    let boundary = edges
        .iter()
        .map(|e| edge_distance(e, p))
        .fold(f64::INFINITY, f64::min);
    let tol = SsiTolerance::default();
    if boundary <= 10.0 * tol.fit {
        return Ok((true, boundary));
    }
    let fr = plane.frame();
    let (x, y, n) = (fr.x(), fr.y(), fr.z());
    // Size of the problem: a bound on the distance from p to every point of the boundary
    // (the cutting plane's box must contain every crossing, or the parity is wrong).
    let reach = edges
        .iter()
        .map(|e| edge_reach(e, p))
        .fold(1.0_f64, f64::max);
    if !reach.is_finite() {
        return Err(HoleError::internal(
            "a face boundary without a finite extent",
        ));
    }
    let bound = 4.0 * reach + 1.0;
    let vtol = 1e-7 * (1.0 + reach);
    'dirs: for a in RAY_ANGLES {
        let (s, c) = math::sin_cos(a);
        let w: Vec3 = x * c + y * s;
        let Some(cut) = Plane::from_point_normal(p, n.cross(w)).ok() else {
            continue;
        };
        let cut = Surface::Plane(cut);
        let mut crossings = 0usize;
        for e in &edges {
            let hits = intersect_curve_surface(
                &e.curve,
                e.t_range,
                &cut,
                UvBox::natural(&cut, bound),
                &tol,
            )
            .map_err(|err| HoleError::internal(format!("ray test: {err}")))?;
            if !hits.overlaps.is_empty() {
                continue 'dirs;
            }
            for h in &hits.points {
                let along = (h.point - p).dot(w);
                if along <= 0.0 {
                    continue;
                }
                let at_end = [e.t_range.0, e.t_range.1]
                    .iter()
                    .any(|&t| e.curve.eval(t).distance(h.point) <= vtol);
                if at_end || h.multiplicity % 2 == 0 {
                    continue 'dirs;
                }
                crossings += 1;
            }
        }
        return Ok((crossings % 2 == 1, boundary));
    }
    Err(HoleError::internal(
        "could not classify a point against a face (every ray was ambiguous)",
    ))
}

/// The depth `h ≥ tol` at which the ray `p + h·d` first reaches the face `face` of `body`
/// (inside or on its boundary within tol), or `None`. Planar faces only
/// (`FORGE_HOLE_UP_TO_UNSUPPORTED` otherwise).
pub fn up_to_depth(
    body: &Body,
    face: FaceId,
    p: Point3,
    d: Vec3,
) -> Result<Option<f64>, HoleError> {
    let f = body
        .face(face)
        .ok_or_else(|| HoleError::internal("the up-to face is not in the body"))?;
    let Surface::Plane(pl) = &f.surface else {
        return Err(HoleError::UpToUnsupported {
            surface: f.surface.kind_name().into(),
        });
    };
    let m = pl.frame().z();
    // No angular cut-off: an axis parallel to the plane gives a non-finite `t` (no hit), and
    // a nearly parallel one hits the plane far away, where the face test below decides
    // whether that point is on the face (SPEC §6.5 "the first point of the face").
    let t = (pl.frame().origin() - p).dot(m) / d.dot(m);
    if !(t.is_finite() && t >= LINEAR_TOLERANCE) {
        return Ok(None);
    }
    let x = p + d * t;
    // The hit lies on the plane up to rounding; measure it against the face.
    Ok((planar_face_distance(body, face, x)? <= LINEAR_TOLERANCE).then_some(t))
}
