//! Probes (SPEC-v1 §7.6): a point that locates an entity without persisting it.
//!
//! - **Face**: a point on the face at distance ≥ `10·tol·max(1, s)` from its boundary (so it
//!   stays 10× clear of the oracle's `1e-6·s` probe-matching tolerance, §8.1), with the outward
//!   normal there. The projection of the face's exact area centroid is used when it lies inside
//!   the trimmed domain and deep enough (most faces); otherwise the deepest point of a fixed
//!   12×12 grid (then 48×48) over the domain's parameter box. Faces too small for the margin
//!   get their deepest interior point.
//! - **Edge**: the point at the middle of the parameter range (ring edges: half a turn from the
//!   start, ADR 0012).
//! - **Vertex**: its position. **Body**: the probe of its face with the smallest key (in
//!   [`crate::Scope`]).
//!
//! Deterministic: fixed candidates in a fixed order, ties to the first.

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point3, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{Body, EdgeId, FaceId, VertexId};
use forge_ir::v1::EntityKind;
use forge_ir::v1::metrics::Probe;

use crate::error::RefError;
use crate::exact::domain::{FaceDomain, contains};
use crate::exact::domain_of;
use crate::geom::clean3;

/// The margin (times `max(1, s)`) a face probe keeps from the face boundary.
pub const FACE_PROBE_MARGIN: f64 = 10.0 * forge_ir::v1::LINEAR_TOLERANCE;

fn probe_err(face: &str, what: &str) -> RefError {
    RefError::Geometry {
        code: "FORGE_PROBE_FAILED".into(),
        message: format!("no interior probe point on face {face}: {what}"),
    }
}

/// The probe of a face whose exact area centroid is `centroid`, at scope scale `s`.
pub fn face_probe(body: &Body, fid: FaceId, centroid: [f64; 3], s: f64) -> Result<Probe, RefError> {
    let face = body.face(fid).ok_or_else(|| probe_err("?", "stale face"))?;
    let dom = domain_of(body, fid)?;
    let surface = &face.surface;
    let margin = FACE_PROBE_MARGIN * s.max(1.0);
    let edges = body.face_edges(fid);
    let depth = |p: Point3| -> f64 {
        edges
            .iter()
            .filter_map(|e| body.edge(*e))
            .map(|e| distance_to_edge(p, &e.curve, e.t_range))
            .fold(f64::INFINITY, f64::min)
    };
    let sign = if face.sense { 1.0 } else { -1.0 };
    let finish = |u: f64, v: f64| -> Result<Probe, RefError> {
        let p = surface.eval(u, v);
        let n = surface
            .normal(u, v)
            .ok_or_else(|| probe_err(&face.provenance.name(), "undefined normal"))?;
        Ok(Probe {
            kind: EntityKind::Face,
            point: clean3(p),
            normal: Some(clean3(n * sign)),
        })
    };
    // 1. The centroid's projection.
    let (u0, v0, _) = surface.project(Vec3::from(centroid));
    if inside(&dom, u0, v0) && depth(surface.eval(u0, v0)) >= margin {
        return finish(u0, v0);
    }
    // 2. The deepest grid point.
    let ((ulo, uhi), (vlo, vhi)) = param_box(&dom, surface);
    let mut best: Option<(f64, f64, f64)> = None;
    for g in [12usize, 48] {
        for i in 0..g {
            for j in 0..g {
                let u = ulo + (uhi - ulo) * (i as f64 + 0.5) / g as f64;
                let v = vlo + (vhi - vlo) * (j as f64 + 0.5) / g as f64;
                if !inside(&dom, u, v) {
                    continue;
                }
                let d = depth(surface.eval(u, v));
                if best.is_none_or(|(_, _, bd)| d > bd) {
                    best = Some((u, v, d));
                }
            }
        }
        if best.is_some_and(|(_, _, d)| d >= margin) {
            break;
        }
    }
    match best {
        Some((u, v, _)) => finish(u, v),
        None if inside(&dom, u0, v0) => finish(u0, v0),
        None => Err(probe_err(
            &face.provenance.name(),
            "the domain grid missed the face",
        )),
    }
}

fn inside(dom: &FaceDomain<'_>, u: f64, v: f64) -> bool {
    u.is_finite() && v.is_finite() && contains(dom, u, v)
}

/// The parameter box of a face's lifted domain (the surface's natural box for loop-less
/// faces), sampled along every boundary piece.
fn param_box(dom: &FaceDomain<'_>, surface: &Surface) -> ((f64, f64), (f64, f64)) {
    if dom.is_loopless() {
        let ((u0, u1), (v0, v1)) = surface.domain();
        let fin = |a: f64, b: f64| {
            if a.is_finite() && b.is_finite() {
                (a, b)
            } else {
                (0.0, math::TAU)
            }
        };
        return (fin(u0, u1), fin(v0, v1));
    }
    let mut lo = Vec2::new(f64::INFINITY, f64::INFINITY);
    let mut hi = Vec2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    for piece in dom.pieces() {
        for (a, b) in piece.spans() {
            for k in 0..=32 {
                let t = a + (b - a) * k as f64 / 32.0;
                let (uv, _) = piece.eval(t);
                lo = Vec2::new(lo.x.min(uv.x), lo.y.min(uv.y));
                hi = Vec2::new(hi.x.max(uv.x), hi.y.max(uv.y));
            }
        }
    }
    // A band closed by a singular line extends to it.
    if let Some(vs) = dom.band_singular_v() {
        lo.y = lo.y.min(vs);
        hi.y = hi.y.max(vs);
    }
    ((lo.x, hi.x), (lo.y, hi.y))
}

/// Distance from `p` to the edge curve restricted to `[t0, t1]`.
pub fn distance_to_edge(p: Point3, curve: &Curve3, (t0, t1): (f64, f64)) -> f64 {
    match curve {
        Curve3::Line(l) => {
            let t = (p - l.origin()).dot(l.dir()).clamp(t0.min(t1), t0.max(t1));
            p.distance(l.eval(t))
        }
        Curve3::Circle(c) => {
            let f = c.frame();
            let w = p - f.origin();
            let (x, y) = (w.dot(f.x()), w.dot(f.y()));
            let a = math::atan2(y, x);
            let d = math::wrap_angle(a - t0, 0.0);
            if d <= (t1 - t0) + 1e-15 * (1.0 + t1.abs()) {
                let h = w.dot(f.z());
                let rho = math::hypot(x, y);
                math::hypot(h, rho - c.radius())
            } else {
                p.distance(curve.eval(t0)).min(p.distance(curve.eval(t1)))
            }
        }
        _ => {
            // Sampled, then refined by golden-section search around the best sample.
            let n = 128;
            let (lo, hi) = (t0.min(t1), t0.max(t1));
            let at = |t: f64| p.distance(curve.eval(t));
            let mut best = (lo, at(lo));
            for k in 1..=n {
                let t = lo + (hi - lo) * k as f64 / n as f64;
                let d = at(t);
                if d < best.1 {
                    best = (t, d);
                }
            }
            let step = (hi - lo) / n as f64;
            let (mut a, mut b) = ((best.0 - step).max(lo), (best.0 + step).min(hi));
            let g = 0.618_033_988_749_894_9;
            for _ in 0..60 {
                let c = b - g * (b - a);
                let d = a + g * (b - a);
                if at(c) <= at(d) {
                    b = d;
                } else {
                    a = c;
                }
            }
            best.1.min(at(0.5 * (a + b)))
        }
    }
}

/// The probe of an edge: the middle of its parameter range.
pub fn edge_probe(body: &Body, eid: EdgeId) -> Option<Probe> {
    let e = body.edge(eid)?;
    let t = 0.5 * (e.t_range.0 + e.t_range.1);
    Some(Probe {
        kind: EntityKind::Edge,
        point: clean3(e.curve.eval(t)),
        normal: None,
    })
}

/// The probe of a vertex: its position.
pub fn vertex_probe(body: &Body, vid: VertexId) -> Option<Probe> {
    let v = body.vertex(vid)?;
    Some(Probe {
        kind: EntityKind::Vertex,
        point: clean3(v.point),
        normal: None,
    })
}

#[cfg(test)]
#[allow(clippy::float_cmp)] // exact expectations on purpose
mod tests {
    use forge_core::geom::{Circle3, Line3};
    use forge_core::linalg::Frame;

    use super::*;

    #[test]
    fn distance_to_line_segments_and_arcs() {
        let l: Curve3 = Line3::new(Vec3::zero(), Vec3::unit_x())
            .expect("line")
            .into();
        assert_eq!(
            distance_to_edge(Vec3::new(0.5, 2.0, 0.0), &l, (0.0, 1.0)),
            2.0
        );
        assert_eq!(
            distance_to_edge(Vec3::new(4.0, 0.0, 0.0), &l, (0.0, 1.0)),
            3.0
        );
        let c: Curve3 = Circle3::new(Frame::world(), 2.0).expect("circle").into();
        // On the arc's side: radial distance; beyond its ends: the nearer end.
        let d = distance_to_edge(Vec3::new(0.0, 3.0, 0.0), &c, (0.0, math::PI));
        assert!((d - 1.0).abs() < 1e-15);
        let d = distance_to_edge(Vec3::new(0.0, -3.0, 0.0), &c, (0.0, math::FRAC_PI_2));
        assert!((d - Vec3::new(0.0, -3.0, 0.0).distance(Vec3::new(2.0, 0.0, 0.0))).abs() < 1e-12);
    }
}
