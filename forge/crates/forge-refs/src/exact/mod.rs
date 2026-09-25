//! Exact per-entity geometry: face area, area centroid and tight box; edge length, centroid
//! and box. Nothing here tessellates (SPEC-v1 §5.3: "sizes and centroids are computed on the
//! exact geometry, as metrics are").
//!
//! - Face integrals use the formulation of forge-check's mass properties (Green's theorem on
//!   the lifted pcurve loops of the trimmed domain, composite 16-point Gauss–Legendre, angular
//!   panels ≤ π/8), with the area-moment density `|S_u × S_v| · (1, P − c)` instead of the
//!   volume density. The domain reconstruction and the box helpers are ported from forge-check
//!   (`domain`, `bbox`); the tests check that face areas sum to forge-check's body area and
//!   that face and edge boxes union to its body box.
//! - Edge lengths use [`forge_core::geom::Curve3::arc_length`] (exact for lines and circles);
//!   centroids are closed-form for lines and circular arcs, quadrature otherwise.
//!
//! Every function is deterministic: fixed quadrature, fixed traversal order.

pub(crate) mod bbox;
pub(crate) mod domain;

use std::sync::OnceLock;

use forge_check::CheckError;
use forge_core::geom::quadrature::gauss_legendre;
use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point3, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{Body, EdgeId, FaceId};

use domain::{FaceDomain, face_domain};

/// An axis-aligned box `[min, max]`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Box3 {
    /// Lower corner.
    pub min: [f64; 3],
    /// Upper corner.
    pub max: [f64; 3],
}

impl Box3 {
    /// The centre.
    pub fn center(&self) -> [f64; 3] {
        [0, 1, 2].map(|i| 0.5 * (self.min[i] + self.max[i]))
    }
    /// The diagonal length.
    pub fn diagonal(&self) -> f64 {
        Vec3::from(self.min).distance(Vec3::from(self.max))
    }
    /// The smallest box containing both.
    pub fn union(&self, o: &Box3) -> Box3 {
        Box3 {
            min: [0, 1, 2].map(|i| self.min[i].min(o.min[i])),
            max: [0, 1, 2].map(|i| self.max[i].max(o.max[i])),
        }
    }
    fn from_aabb(b: &bbox::Aabb) -> Option<Box3> {
        (!b.is_empty()).then(|| Box3 {
            min: b.min.to_array(),
            max: b.max.to_array(),
        })
    }
}

/// Exact properties of a face.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FaceProps {
    /// Area (mm²).
    pub area: f64,
    /// Area centroid (mm).
    pub centroid: [f64; 3],
    /// Tight box.
    pub bbox: Box3,
}

/// Exact properties of an edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EdgeProps {
    /// Length (mm).
    pub length: f64,
    /// Length centroid (mm).
    pub centroid: [f64; 3],
    /// Tight box.
    pub bbox: Box3,
}

/// The gap tolerance forge-check uses for the domain reconstruction of `body`
/// ([`forge_check::GAP_TOLERANCE_FACTOR`] times its largest vertex or edge tolerance).
pub fn gap_tolerance(body: &Body) -> f64 {
    let t = body
        .vertices()
        .values()
        .map(|v| v.tolerance)
        .chain(body.edges().values().map(|e| e.tolerance))
        .fold(forge_core::tolerance::IR_LINEAR_TOLERANCE, f64::max);
    forge_check::GAP_TOLERANCE_FACTOR * t
}

/// The reconstructed trimmed domain of a face.
pub(crate) fn domain_of(body: &Body, fid: FaceId) -> Result<FaceDomain<'_>, CheckError> {
    let face = body.face(fid).ok_or(CheckError::Empty)?;
    face_domain(body, face, gap_tolerance(body))
}

/// `true` if `p` lies on the face within `tol`: on its surface (closest-point distance) and
/// inside its trimmed domain. Used to match probes (§7.6, §8.1) and to test points against
/// faces (e.g. hole positions).
pub fn point_on_face(body: &Body, fid: FaceId, p: [f64; 3], tol: f64) -> Result<bool, CheckError> {
    let face = body.face(fid).ok_or(CheckError::Empty)?;
    let (u, v, d) = face.surface.project(Vec3::from(p));
    if d.is_nan() || d > tol {
        return Ok(false);
    }
    let dom = face_domain(body, face, gap_tolerance(body))?;
    if domain::contains(&dom, u, v) {
        return Ok(true);
    }
    // On the boundary (within tol) counts as on the face.
    Ok(body
        .face_edges(fid)
        .iter()
        .filter_map(|e| body.edge(*e))
        .any(|e| crate::probe::distance_to_edge(Vec3::from(p), &e.curve, e.t_range) <= tol))
}

/// `true` if `p` lies on the edge (its curve over its parameter range) within `tol`.
pub fn point_on_edge(body: &Body, eid: EdgeId, p: [f64; 3], tol: f64) -> bool {
    body.edge(eid)
        .is_some_and(|e| crate::probe::distance_to_edge(Vec3::from(p), &e.curve, e.t_range) <= tol)
}

/// Area, area centroid and tight box of a face.
pub fn face_props(body: &Body, fid: FaceId) -> Result<FaceProps, CheckError> {
    let face = body.face(fid).ok_or(CheckError::Empty)?;
    let dom = face_domain(body, face, gap_tolerance(body))?;
    let bbox = face_box(body, fid, &dom)?;
    let c = Vec3::from(bbox.center());
    let q = face_moments(&dom, c).map_err(|e| match e {
        CheckError::UnboundedDomain { .. } => CheckError::UnboundedDomain {
            face: face.provenance.name(),
        },
        other => other,
    })?;
    let [area, mx, my, mz] = q;
    if !q.iter().all(|x| x.is_finite()) {
        return Err(CheckError::NonFinite {
            what: "face moments",
        });
    }
    let centroid = if area > 0.0 {
        c + Vec3::new(mx, my, mz) / area
    } else {
        c
    };
    Ok(FaceProps {
        area,
        centroid: centroid.to_array(),
        bbox,
    })
}

/// The tight box of a face: its boundary vertices and edges' analytic extremes plus the
/// interior critical and singular points its domain reaches.
fn face_box(body: &Body, fid: FaceId, dom: &FaceDomain<'_>) -> Result<Box3, CheckError> {
    let mut b = bbox::Aabb::empty();
    for e in body.face_edges(fid) {
        let Some(edge) = body.edge(e) else { continue };
        for v in [edge.start, edge.end].into_iter().flatten() {
            if let Some(v) = body.vertex(v) {
                b.add(v.point);
            }
        }
        bbox::add_edge(&mut b, &edge.curve, edge.t_range.0, edge.t_range.1)?;
    }
    bbox::add_face(&mut b, dom)?;
    Box3::from_aabb(&b).ok_or(CheckError::Empty)
}

/// Length, length centroid and tight box of an edge.
pub fn edge_props(body: &Body, eid: EdgeId) -> Result<EdgeProps, CheckError> {
    let e = body.edge(eid).ok_or(CheckError::Empty)?;
    let (t0, t1) = e.t_range;
    let mut b = bbox::Aabb::empty();
    for v in [e.start, e.end].into_iter().flatten() {
        if let Some(v) = body.vertex(v) {
            b.add(v.point);
        }
    }
    bbox::add_edge(&mut b, &e.curve, t0, t1)?;
    let bbox = Box3::from_aabb(&b).ok_or(CheckError::Empty)?;
    let length = e.curve.arc_length(t0, t1);
    let centroid = curve_centroid(&e.curve, t0, t1, length);
    if !(length.is_finite() && centroid.iter().all(|x| x.is_finite())) {
        return Err(CheckError::NonFinite {
            what: "edge length or centroid",
        });
    }
    Ok(EdgeProps {
        length,
        centroid,
        bbox,
    })
}

/// Length centroid of `curve` over `[t0, t1]` (closed form for lines and circular arcs).
fn curve_centroid(curve: &Curve3, t0: f64, t1: f64, length: f64) -> [f64; 3] {
    match curve {
        Curve3::Line(_) => curve.eval(0.5 * (t0 + t1)).to_array(),
        Curve3::Circle(c) => {
            // The centroid of an arc of angle θ about its middle direction lies at
            // r·sin(θ/2)/(θ/2) from the centre.
            let theta = (t1 - t0).abs();
            let f = c.frame();
            if theta >= math::TAU {
                return f.origin().to_array();
            }
            let mid = 0.5 * (t0 + t1);
            let (s, co) = math::sin_cos(mid);
            let half = 0.5 * theta;
            let k = if half > 0.0 {
                c.radius() * math::sin(half) / half
            } else {
                c.radius()
            };
            (f.origin() + (f.x() * co + f.y() * s) * k).to_array()
        }
        _ => {
            // ∫ C(t) |C'(t)| dt / L on panels of at most π/8 (ellipses) or per 1/64 of the
            // range (B-splines), 16-point Gauss–Legendre.
            let (lo, hi) = if t0 <= t1 { (t0, t1) } else { (t1, t0) };
            let pieces = match curve {
                Curve3::Ellipse(_) => (((hi - lo) / (math::PI / 8.0)).ceil() as usize).max(1),
                _ => 64,
            };
            let mut acc = Vec3::zero();
            let h = (hi - lo) / pieces as f64;
            for k in 0..pieces {
                let a = lo + h * k as f64;
                let b = if k + 1 == pieces { hi } else { a + h };
                let (m, r) = (0.5 * (a + b), 0.5 * (b - a));
                for &(x, w) in rule() {
                    let t = m + r * x;
                    acc += curve.eval(t) * (w * r * curve.d1(t).norm());
                }
            }
            if length > 0.0 {
                (acc / length).to_array()
            } else {
                curve.eval(lo).to_array()
            }
        }
    }
}

// ---- face moments (adapted from forge-check's `mass` module) ------------------------------

/// Maximum panel width (radians) for angular coordinates (forge-check's `ANGULAR_PANEL`).
const ANGULAR_PANEL: f64 = forge_check::ANGULAR_PANEL;

/// `[area, Mx, My, Mz]` (moments about the reference point).
type Q4 = [f64; 4];

fn rule() -> &'static [(f64, f64)] {
    static RULE: OnceLock<Vec<(f64, f64)>> = OnceLock::new();
    RULE.get_or_init(|| gauss_legendre(16))
}

fn add(a: &mut Q4, b: Q4, w: f64) {
    for i in 0..4 {
        a[i] += w * b[i];
    }
}

fn angular(surface: &Surface) -> (bool, bool) {
    match surface {
        Surface::Plane(_) | Surface::BSpline(_) => (false, false),
        Surface::Cylinder(_) | Surface::Cone(_) | Surface::Helicoid(_) => (true, false),
        Surface::Sphere(_) | Surface::Torus(_) => (true, true),
    }
}

fn panels(delta: f64, is_angle: bool) -> usize {
    if is_angle {
        ((delta.abs() / ANGULAR_PANEL).ceil() as usize).max(1)
    } else {
        1
    }
}

/// Area-moment density at `(u, v)`: `|n| · (1, P − c)`.
fn density(surface: &Surface, c: Point3, u: f64, v: f64) -> Q4 {
    let [p, su, sv] = surface.derivs1(u, v);
    let a = su.cross(sv).norm();
    let q = p - c;
    [a, a * q.x, a * q.y, a * q.z]
}

fn integrate(mut f: impl FnMut(f64) -> Q4, a: f64, b: f64, n: usize) -> Q4 {
    let mut out = [0.0; 4];
    if a.to_bits() == b.to_bits() {
        return out;
    }
    let h = (b - a) / n as f64;
    for k in 0..n {
        let lo = a + h * k as f64;
        let hi = if k + 1 == n { b } else { lo + h };
        let (mid, half) = (0.5 * (lo + hi), 0.5 * (hi - lo));
        for &(x, w) in rule() {
            add(&mut out, f(mid + half * x), w * half);
        }
    }
    out
}

fn outer_panels(
    angular_param: bool,
    a: f64,
    b: f64,
    ua: Vec2,
    ub: Vec2,
    ang_u: bool,
    ang_v: bool,
) -> usize {
    let by_param = panels(b - a, angular_param);
    let by_u = panels(ub.x - ua.x, ang_u);
    let by_v = panels(ub.y - ua.y, ang_v);
    by_param.max(by_u).max(by_v)
}

/// `∬_D |n| · (1, S − c) du dv` over the trimmed domain (the v-form / u-form / loop-less
/// cases of forge-check's `face_integrals`).
fn face_moments(dom: &FaceDomain<'_>, c: Point3) -> Result<Q4, CheckError> {
    let s = dom.surface;
    if matches!(s, Surface::BSpline(_)) {
        return Err(CheckError::Unsupported {
            what: "area moments of B-spline faces",
        });
    }
    let (ang_u, ang_v) = angular(s);
    if dom.is_loopless() {
        let ((u0, u1), (v0, v1)) = s.domain();
        let nu = panels(u1 - u0, ang_u);
        let nv = panels(v1 - v0, ang_v);
        return Ok(integrate(
            |u| integrate(|v| density(s, c, u, v), v0, v1, nv),
            u0,
            u1,
            nu,
        ));
    }
    let (pu, pv) = s.periodicity();
    let use_u_form = pv.is_some() && dom.wraps_v() && !dom.wraps_u();
    if pu.is_some() && dom.wraps_u() && dom.wraps_v() {
        return Err(CheckError::Unsupported {
            what: "faces whose loops wrap around both periodic directions",
        });
    }
    let first = dom
        .pieces()
        .next()
        .map(|p| p.start())
        .unwrap_or(Vec2::zero());
    let mut total = [0.0; 4];
    if use_u_form {
        if dom.winding_v() != 0 {
            return Err(CheckError::UnboundedDomain {
                face: String::new(),
            });
        }
        let u_star = first.x;
        for piece in dom.pieces() {
            for (a, b) in piece.spans() {
                let (ua, _) = piece.eval(a);
                let (ub, _) = piece.eval(b);
                let n = outer_panels(piece.angular_parameter(), a, b, ua, ub, ang_u, ang_v);
                let q = integrate(
                    |t| {
                        let (uv, d) = piece.eval(t);
                        let inner = integrate(
                            |x| density(s, c, x, uv.y),
                            u_star,
                            uv.x,
                            panels(uv.x - u_star, ang_u),
                        );
                        let mut o = [0.0; 4];
                        add(&mut o, inner, d.y);
                        o
                    },
                    a,
                    b,
                    n,
                );
                add(&mut total, q, dom.sigma);
            }
        }
        return Ok(total);
    }
    let v_star = if dom.winding_u() == 0 {
        first.y
    } else {
        dom.band_singular_v().ok_or(CheckError::UnboundedDomain {
            face: String::new(),
        })?
    };
    for piece in dom.pieces() {
        for (a, b) in piece.spans() {
            let (ua, _) = piece.eval(a);
            let (ub, _) = piece.eval(b);
            let n = outer_panels(piece.angular_parameter(), a, b, ua, ub, ang_u, ang_v);
            let q = integrate(
                |t| {
                    let (uv, d) = piece.eval(t);
                    let inner = integrate(
                        |y| density(s, c, uv.x, y),
                        v_star,
                        uv.y,
                        panels(uv.y - v_star, ang_v),
                    );
                    let mut o = [0.0; 4];
                    add(&mut o, inner, d.x);
                    o
                },
                a,
                b,
                n,
            );
            add(&mut total, q, -dom.sigma);
        }
    }
    Ok(total)
}
