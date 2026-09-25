//! Geometric helpers of the boolean: pcurves by projection, bounding boxes, curve
//! parameters of points, surface identity.

use forge_core::geom::{Curve2, Curve3, Ellipse2, NurbsCurve2, NurbsCurve3, Surface};
use forge_core::linalg::{Point2, Point3, Vec2, Vec3};
use forge_core::math;
use forge_core::scalar::Interval;

use super::error::BooleanError;

/// Pcurves fitted by projection deviate from the edge curve by at most this (mm) plus 1.5
/// times the curve's own distance from the surface (checked at seven points per span and
/// on a uniform grid).
///
/// Tight on purpose (review round 4): every face of a result integrates its region through
/// its boundary images, and two faces meeting along an edge have independently fitted
/// pcurves. Where the images part (a "crack" of width `w` along an edge of length `L`), the
/// body is not exactly closed and its divergence-theorem volume depends on the reference
/// point by `|Δc|·w·L/3`; forge-check takes each body's box centre, so the volume
/// identities `vol(A ∪ B) + vol(A ∩ B) = vA + vB` failed by ~1e-9 relative with 5e-8 fits.
/// Fitted intersection curves lie within ~1e-9 mm of both surfaces in practice (the SSI's
/// contract is 1e-7), so the cracks are now ~1e-9 mm and the identities hold to ~1e-11.
pub(crate) const PCURVE_FIT: f64 = 1e-10;

/// The fallback where the tight fit cannot converge (a fitted section passing a cone apex or
/// sphere pole at a small offset): the round-3 contract, deviation from the edge curve at
/// most this plus 1.5 times the curve's distance from the surface.
pub(crate) const PCURVE_FIT_RELAXED: f64 = 5e-8;

/// An axis-aligned box.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Aabb {
    pub lo: Point3,
    pub hi: Point3,
}

impl Aabb {
    pub fn empty() -> Self {
        Self {
            lo: Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY),
            hi: Point3::new(f64::NEG_INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY),
        }
    }
    pub fn add_point(&mut self, p: Point3) {
        self.lo = self.lo.min_components(p);
        self.hi = self.hi.max_components(p);
    }
    pub fn add_box(&mut self, o: &Aabb) {
        self.lo = self.lo.min_components(o.lo);
        self.hi = self.hi.max_components(o.hi);
    }
    pub fn grown(&self, d: f64) -> Self {
        let g = Vec3::new(d, d, d);
        Self {
            lo: self.lo - g,
            hi: self.hi + g,
        }
    }
    pub fn overlaps(&self, o: &Aabb) -> bool {
        self.lo.x <= o.hi.x
            && o.lo.x <= self.hi.x
            && self.lo.y <= o.hi.y
            && o.lo.y <= self.hi.y
            && self.lo.z <= o.hi.z
            && o.lo.z <= self.hi.z
    }
    pub fn is_empty(&self) -> bool {
        !(self.lo.x <= self.hi.x && self.lo.y <= self.hi.y && self.lo.z <= self.hi.z)
    }
    pub fn diag(&self) -> f64 {
        if self.is_empty() {
            0.0
        } else {
            self.hi.distance(self.lo)
        }
    }
    /// Euclidean distance between two boxes (0 if they overlap).
    pub fn distance(&self, o: &Aabb) -> f64 {
        let d = |a0: f64, a1: f64, b0: f64, b1: f64| (b0 - a1).max(a0 - b1).max(0.0);
        let dx = d(self.lo.x, self.hi.x, o.lo.x, o.hi.x);
        let dy = d(self.lo.y, self.hi.y, o.lo.y, o.hi.y);
        let dz = d(self.lo.z, self.hi.z, o.lo.z, o.hi.z);
        math::sqrt(dx * dx + dy * dy + dz * dz)
    }
}

/// A certified box of the surface over a parameter box (interval arithmetic on a
/// `n × n` split).
pub(crate) fn surface_box(s: &Surface, u: (f64, f64), v: (f64, f64), n: usize) -> Aabb {
    let mut b = Aabb::empty();
    for i in 0..n {
        for j in 0..n {
            let u0 = u.0 + (u.1 - u.0) * i as f64 / n as f64;
            let u1 = if i + 1 == n {
                u.1
            } else {
                u.0 + (u.1 - u.0) * (i + 1) as f64 / n as f64
            };
            let v0 = v.0 + (v.1 - v.0) * j as f64 / n as f64;
            let v1 = if j + 1 == n {
                v.1
            } else {
                v.0 + (v.1 - v.0) * (j + 1) as f64 / n as f64
            };
            let p = s.eval(Interval::new(u0, u1), Interval::new(v0, v1));
            b.add_point(Point3::new(p.x.lo(), p.y.lo(), p.z.lo()));
            b.add_point(Point3::new(p.x.hi(), p.y.hi(), p.z.hi()));
        }
    }
    b
}

/// A certified box of a curve over a parameter range.
pub(crate) fn curve_box(c: &Curve3, range: (f64, f64)) -> Aabb {
    let mut b = Aabb::empty();
    let spans: Vec<(f64, f64)> = match c {
        Curve3::BSpline(n) => {
            let mut ks: Vec<f64> = n
                .knots()
                .iter()
                .copied()
                .filter(|k| *k > range.0 && *k < range.1)
                .collect();
            ks.dedup_by(|a, b| a.to_bits() == b.to_bits());
            let mut pts = vec![range.0];
            pts.extend(ks);
            pts.push(range.1);
            pts.windows(2).map(|w| (w[0], w[1])).collect()
        }
        _ => vec![range],
    };
    for (a, z) in spans {
        let n = 8;
        for i in 0..n {
            let t0 = a + (z - a) * i as f64 / n as f64;
            let t1 = if i + 1 == n {
                z
            } else {
                a + (z - a) * (i + 1) as f64 / n as f64
            };
            let p = c.eval(Interval::new(t0, t1));
            b.add_point(Point3::new(p.x.lo(), p.y.lo(), p.z.lo()));
            b.add_point(Point3::new(p.x.hi(), p.y.hi(), p.z.hi()));
        }
    }
    b
}

/// `true` for the surface types the boolean supports: plane, cylinder, cone, sphere,
/// ring torus, and helicoid (modelled thread flanks) as long as nothing but rays meets it
/// (forge-ssi intersects lines with helicoids; any other intersection with one is
/// `SSI_UNSUPPORTED`).
pub(crate) fn supported_surface(s: &Surface) -> bool {
    match s {
        Surface::Plane(_)
        | Surface::Cylinder(_)
        | Surface::Cone(_)
        | Surface::Sphere(_)
        | Surface::Helicoid(_) => true,
        Surface::Torus(t) => t.minor() < t.major() && t.spindle_patch().is_none(),
        Surface::BSpline(_) => false,
    }
}

/// Values of `v` on which the surface collapses to a point (cone apex, sphere poles).
pub(crate) fn singular_vs(s: &Surface) -> Vec<f64> {
    match s {
        Surface::Cone(c) => vec![c.apex_v()],
        Surface::Sphere(_) => vec![-math::FRAC_PI_2, math::FRAC_PI_2],
        _ => Vec::new(),
    }
}

/// A curve end within this distance (mm) of a surface's singular point is **on** it: its
/// pcurve ends exactly on the singular line (forge-check joins pcurves there only when
/// both ends lie on the line within 1e-9 rad, and a fitted section curve passes a pole it
/// crosses only within the SSI fit tolerance).
pub(crate) const SINGULAR_SNAP: f64 = forge_ir::v1::LINEAR_TOLERANCE;

/// The singular `v` (cone apex, sphere pole) whose point lies within `tol` of `p`, if any.
pub(crate) fn singular_v_at(s: &Surface, p: Point3, tol: f64) -> Option<f64> {
    singular_vs(s)
        .into_iter()
        .find(|&vs| s.eval(0.0, vs).distance(p) <= tol)
}

/// Parameter distance from the singular line `v = vs` at which the surface lies `dist`
/// (mm) from its singular point (a sphere of radius `r`: `dist / r`; a cone: `dist·cos α`).
pub(crate) fn singular_offset(s: &Surface, vs: f64, dist: f64) -> f64 {
    let h = 1e-3;
    let q = s.eval(0.0, vs);
    let speed = (s.eval(0.0, vs + h).distance(q) / h).max(s.eval(0.0, vs - h).distance(q) / h);
    if speed > 0.0 { dist / speed } else { dist }
}

/// Parameters of `p` on the surface nearest to `near` (periodic parameters shifted by
/// whole periods towards `near`).
pub(crate) fn uv_near(s: &Surface, p: Point3, near: Option<Point2>) -> Point2 {
    let (u, v, _) = s.project(p);
    let mut uv = Point2::new(u, v);
    if let Some(n) = near {
        let (pu, pv) = s.periodicity();
        if let Some(per) = pu {
            uv.x += ((n.x - uv.x) / per).round() * per;
        }
        if let Some(per) = pv {
            uv.y += ((n.y - uv.y) / per).round() * per;
        }
    }
    uv
}

/// Largest distance between `S(pc(t))` and `C(t)` on `samples` points per span plus the
/// ends.
pub(crate) fn pcurve_error(
    s: &Surface,
    c: &Curve3,
    pc: &Curve2,
    range: (f64, f64),
    samples: usize,
) -> f64 {
    let n = samples.max(2);
    let mut worst: f64 = 0.0;
    for i in 0..=n {
        let t = if i == n {
            range.1
        } else {
            range.0 + (range.1 - range.0) * i as f64 / n as f64
        };
        let uv = pc.eval(t);
        worst = worst.max(s.eval(uv.x, uv.y).distance(c.eval(t)));
    }
    worst
}

/// A pcurve of `curve` over `range` on `surface`, sharing the curve's parameter, and its
/// verified deviation (mm).
///
/// Exact forms first: an **affine** image (lines on planes, cylinders and cones; circles
/// that are parallels of a surface of revolution) becomes a degree-1 B-spline, a circle
/// or ellipse on a plane whose image turns counter-clockwise an [`Ellipse2`]. Otherwise a
/// C⁰ quintic B-spline interpolating the curve's surface projection at Chebyshev–Lobatto
/// nodes, spans halved until the image is within [`PCURVE_FIT`] (1e-10 mm) of that
/// projection; where that cannot converge (a fitted section passing a singular point at a
/// small offset), the round-3 cubic Hermite fit within [`PCURVE_FIT_RELAXED`] plus 1.5 times
/// the curve's distance from the surface. The returned deviation is from the curve itself
/// (for the edge tolerance). `near` selects the period copy of the start (periodic
/// parameters).
#[track_caller]
pub(crate) fn fit_pcurve(
    surface: &Surface,
    curve: &Curve3,
    range: (f64, f64),
    near: Option<Point2>,
) -> Result<(Curve2, f64), BooleanError> {
    let caller = std::panic::Location::caller();
    let r = fit_generic(surface, FitTarget::Curve(curve), range, near);
    debug_fit(caller, "fit", curve, surface, &r);
    r
}

/// Refits of a boundary onto **another parametrization** of the carrier it already lies on
/// (a face merged into another face on one carrier, a sphere face moved to another pole)
/// reproduce the old boundary image `S_old(pc_old(t))` within this (mm), not the 3D curve:
/// every result of an operation integrates a face region through its boundary image, so a
/// refit in one result must keep the partition the other results use (the volume
/// identities `vol(A ∪ B) + vol(A ∩ B) = vA + vB` hold to this, not to the fit tolerance).
pub(crate) const REFIT_TOL: f64 = 1e-10;

/// A pcurve on `surface` for the edge `curve` over `range` that reproduces the image of the
/// edge's current pcurve `old_pc` on `old_surface` within [`REFIT_TOL`] (plus the image's
/// distance from `surface`), and its deviation from `curve` (for the edge tolerance). Exact
/// forms are used only when they reproduce that image.
#[track_caller]
pub(crate) fn refit_pcurve(
    surface: &Surface,
    curve: &Curve3,
    range: (f64, f64),
    near: Option<Point2>,
    old_surface: &Surface,
    old_pc: &Curve2,
) -> Result<(Curve2, f64), BooleanError> {
    let caller = std::panic::Location::caller();
    let r = fit_generic(
        surface,
        FitTarget::Image {
            surface: old_surface,
            pcurve: old_pc,
            curve,
        },
        range,
        near,
    )
    .map(|(pc, _)| {
        let dev = pcurve_error(surface, curve, &pc, range, 64);
        (pc, dev)
    });
    debug_fit(caller, "refit", curve, surface, &r);
    r
}

/// The point where surfaces `a` and `b` meet in the plane through `p` normal to `d`
/// (Newton on the signed distances to both surfaces and the plane): a point of their true
/// intersection next to a point `p` of a fitted intersection curve with tangent `d`. `None`
/// where the surfaces meet at a small angle (the point is ill-conditioned: tangent sections)
/// or Newton does not converge to within `LINEAR_TOLERANCE` of `p`.
pub(crate) fn meet(a: &Surface, b: &Surface, p0: Point3, d: Vec3) -> Option<Point3> {
    let dn = d.normalize()?;
    let scale = 1.0 + p0.norm();
    let mut p = p0;
    for _ in 0..12 {
        let (u1, v1, _) = a.project(p);
        let (u2, v2, _) = b.project(p);
        let (n1, n2) = (a.normal(u1, v1)?, b.normal(u2, v2)?);
        if n1.cross(n2).norm() < 1e-4 {
            return None;
        }
        let f = [
            n1.dot(p - a.eval(u1, v1)),
            n2.dot(p - b.eval(u2, v2)),
            dn.dot(p - p0),
        ];
        if f.iter().all(|x| x.abs() <= 1e-15 * scale) {
            return Some(p);
        }
        // Solve [n1; n2; dn] Δ = −f by Cramer's rule.
        let det = n1.dot(n2.cross(dn));
        if det.abs() < 1e-12 {
            return None;
        }
        let rhs = Vec3::new(-f[0], -f[1], -f[2]);
        let col = |c: usize| {
            let r = |v: Vec3| [v.x, v.y, v.z];
            let (a0, a1, a2) = (r(n1), r(n2), r(dn));
            let mut m = [a0, a1, a2];
            m[0][c] = rhs.x;
            m[1][c] = rhs.y;
            m[2][c] = rhs.z;
            let v = |row: [f64; 3]| Vec3::new(row[0], row[1], row[2]);
            v(m[0]).dot(v(m[1]).cross(v(m[2])))
        };
        let step = Vec3::new(col(0), col(1), col(2)) * (1.0 / det);
        p += step;
        if (p - p0).norm() > forge_ir::v1::LINEAR_TOLERANCE {
            return None;
        }
        if step.norm() <= 1e-16 * scale {
            return Some(p);
        }
    }
    None
}

/// A pcurve on `own` for the section edge `curve` between `own` and `other` whose image
/// lies on their **true** intersection ([`meet`]) within [`PCURVE_FIT`], so that the two
/// faces of the edge close up to that however far the fitted curve lies from them (the
/// SSI's contract is 1e-7 mm). Only where the surfaces meet transversally along the whole
/// piece (every one of 65 samples meets, the normals at least 1e-3 rad apart: a target
/// mixing true and fitted points would not be smooth); `None` otherwise (the caller keeps
/// what it has). Returns the pcurve and its deviation from `curve`.
#[track_caller]
pub(crate) fn fit_section_pcurve(
    own: &Surface,
    other: &Surface,
    curve: &Curve3,
    range: (f64, f64),
    near: Option<Point2>,
) -> Option<Result<(Curve2, f64), BooleanError>> {
    let caller = std::panic::Location::caller();
    let transversal = (0..=64).all(|i| {
        let t = range.0 + (range.1 - range.0) * i as f64 / 64.0;
        meet(own, other, curve.eval(t), curve.d1(t)).is_some_and(|p| {
            let (u1, v1, _) = own.project(p);
            let (u2, v2, _) = other.project(p);
            match (own.normal(u1, v1), other.normal(u2, v2)) {
                (Some(a), Some(b)) => a.cross(b).norm() >= 1e-3,
                _ => false,
            }
        })
    });
    if !transversal {
        return None;
    }
    let r = fit_generic(own, FitTarget::Section { curve, own, other }, range, near);
    debug_fit(caller, "section", curve, own, &r);
    Some(r)
}

fn debug_fit(
    caller: &std::panic::Location<'_>,
    what: &str,
    curve: &Curve3,
    surface: &Surface,
    r: &Result<(Curve2, f64), BooleanError>,
) {
    if std::env::var_os("FORGE_BOOLEAN_DEBUG_FIT").is_some() {
        match r {
            Ok((pc, err)) => eprintln!(
                "{what}_pcurve {}:{} {} on {} -> {} err {err:.2e} ctrl {}",
                caller.file(),
                caller.line(),
                curve.kind_name(),
                surface.kind_name(),
                pc.kind_name(),
                match pc {
                    Curve2::BSpline(n) => n.control_points().len(),
                    _ => 0,
                }
            ),
            Err(e) => eprintln!(
                "{what}_pcurve {}:{} failed: {e}",
                caller.file(),
                caller.line()
            ),
        }
    }
}

/// What a pcurve is fitted to.
#[derive(Clone, Copy)]
enum FitTarget<'a> {
    /// A 3D curve.
    Curve(&'a Curve3),
    /// The image of an existing pcurve of the edge `curve` on another surface.
    Image {
        surface: &'a Surface,
        pcurve: &'a Curve2,
        curve: &'a Curve3,
    },
    /// The true intersection of the pcurve's surface with `other` near the fitted
    /// intersection curve `curve` ([`meet`]), where it converges; `curve` elsewhere.
    Section {
        curve: &'a Curve3,
        own: &'a Surface,
        other: &'a Surface,
    },
}

impl FitTarget<'_> {
    /// The edge's 3D curve.
    fn curve(&self) -> &Curve3 {
        match self {
            FitTarget::Curve(c) => c,
            FitTarget::Image { curve, .. } | FitTarget::Section { curve, .. } => curve,
        }
    }
    /// The point the pcurve must map `t` onto.
    fn point(&self, t: f64) -> Point3 {
        match self {
            FitTarget::Curve(c) => c.eval(t),
            FitTarget::Section { curve, own, other } => {
                let p = curve.eval(t);
                meet(own, other, p, curve.d1(t)).unwrap_or(p)
            }
            FitTarget::Image {
                surface, pcurve, ..
            } => {
                let uv = pcurve.eval(t);
                surface.eval(uv.x, uv.y)
            }
        }
    }
    /// The exact derivative of [`Self::point`] where it is well conditioned (an image away
    /// from its surface's singular points); `None` for 3D curves (fitted intersection
    /// curves can carry micro-spans where their analytic derivative loses all precision
    /// while their points stay exact).
    fn deriv(&self, t: f64) -> Option<Vec3> {
        match self {
            FitTarget::Curve(_) | FitTarget::Section { .. } => None,
            FitTarget::Image {
                surface, pcurve, ..
            } => {
                let uv = pcurve.eval(t);
                let d = pcurve.d1(t);
                let [_, su, sv] = surface.derivs1(uv.x, uv.y);
                let area = su.cross(sv).norm();
                if area <= 1e-6 * su.norm().max(sv.norm()).powi(2) {
                    return None;
                }
                Some(su * d.x + sv * d.y)
            }
        }
    }
}

/// Parameter derivative on `surface` at `uv` of a 3D curve with derivative `d`: the
/// least-squares solution of `S_u a + S_v b = d`; `None` near a singular point.
fn uv_rate(surface: &Surface, uv: Point2, d: Vec3) -> Option<Vec2> {
    let [_, su, sv] = surface.derivs1(uv.x, uv.y);
    let (a, b, c) = (su.dot(su), su.dot(sv), sv.dot(sv));
    let det = a * c - b * b;
    if det.partial_cmp(&(1e-12 * (a * c).max(f64::MIN_POSITIVE)))
        != Some(std::cmp::Ordering::Greater)
    {
        return None;
    }
    let (r1, r2) = (su.dot(d), sv.dot(d));
    let x = Vec2::new((c * r1 - b * r2) / det, (a * r2 - b * r1) / det);
    (x.x.is_finite() && x.y.is_finite()).then_some(x)
}

fn fit_generic(
    surface: &Surface,
    target: FitTarget<'_>,
    range: (f64, f64),
    near: Option<Point2>,
) -> Result<(Curve2, f64), BooleanError> {
    let curve = target.curve();
    let (t0, t1) = range;
    let fail =
        |what: &str| BooleanError::inconsistent(format!("pcurve fit: {what}"), curve.kind_name());
    if t0.partial_cmp(&t1) != Some(std::cmp::Ordering::Less) {
        return Err(fail("empty range"));
    }
    let refit = matches!(target, FitTarget::Image { .. });
    // Continuous parameters along the curve. At a singular point (cone apex, sphere pole)
    // `u` is arbitrary (the projection returns the angle of rounding noise): an end there
    // takes the limit of `u` along the curve, from a point just inside the range.
    let sing = singular_vs(surface);
    // The side of each singular line the curve lies on (from its middle): projections of
    // points within rounding of the singular point can land on the far side (a cone's other
    // nappe), which the pcurve must never cross.
    let side: Vec<f64> = {
        let vm = uv_near(surface, target.point(0.5 * (t0 + t1)), None).y;
        sing.iter()
            .map(|&vs| if vm >= vs { 1.0 } else { -1.0 })
            .collect()
    };
    let uv_at = |t: f64, prev: Option<Point2>| {
        let p = target.point(t);
        let mut uv = uv_near(surface, p, prev);
        for (&vs, &sd) in sing.iter().zip(&side) {
            if (uv.y - vs) * sd < 0.0 {
                uv.y = vs;
            }
        }
        // A range end at a singular point (within `SINGULAR_SNAP`: the vertex there is the
        // singular point) ends exactly on the singular line.
        if (t.to_bits() == t0.to_bits() || t.to_bits() == t1.to_bits())
            && let Some(vs) = singular_v_at(surface, p, SINGULAR_SNAP)
        {
            uv.y = vs;
        }
        if sing
            .iter()
            .any(|&vs| (uv.y - vs).abs() <= 1e-9 * (1.0 + vs.abs()))
        {
            // Linear extrapolation from two points just inside (u is smooth along the
            // curve up to the singular point; the error is second order in the offset).
            let inward = if t - t0 <= t1 - t { 1.0 } else { -1.0 };
            let d = 1e-6 * (t1 - t0);
            let q1 = uv_near(surface, target.point(t + inward * d), prev.or(Some(uv)));
            let q2 = uv_near(surface, target.point(t + inward * 2.0 * d), Some(q1));
            uv.x = 2.0 * q1.x - q2.x;
        }
        uv
    };
    // What the pcurve's image must reproduce: the target's closest point on the surface
    // (the target itself when it lies on the surface; a fitted intersection curve lies off
    // it by up to the SSI fit tolerance, and every face of the edge then reproduces its own
    // projection of the curve, so two faces part by about twice that distance, never by the
    // fit tolerance on top).
    let goal = |t: f64| -> Point3 {
        let (u, v, _) = surface.project(target.point(t));
        surface.eval(u, v)
    };
    let dev_of = |pc: &Curve2, samples: usize| -> f64 {
        let n = samples.max(2);
        (0..=n)
            .map(|i| {
                let t = if i == n {
                    t1
                } else {
                    t0 + (t1 - t0) * i as f64 / n as f64
                };
                let uv = pc.eval(t);
                surface.eval(uv.x, uv.y).distance(goal(t))
            })
            .fold(0.0, f64::max)
    };
    // The deviation reported for the edge tolerance: from the target itself.
    let dev_target = |pc: &Curve2| -> f64 {
        let n = 256;
        (0..=n)
            .map(|i| {
                let t = if i == n {
                    t1
                } else {
                    t0 + (t1 - t0) * i as f64 / n as f64
                };
                let uv = pc.eval(t);
                surface.eval(uv.x, uv.y).distance(target.point(t))
            })
            .fold(0.0, f64::max)
    };
    let size = 1.0 + curve.eval(t0).norm().max(curve.eval(t1).norm());
    // No pcurve is continuous through a singular point inside the range (its `u` jumps; a
    // fit would slide along the singular line and add area to the face's domain integral):
    // the edge needs a vertex there. An explicit error, never a sliding pcurve.
    for &vs in &sing {
        let sp = surface.eval(0.0, vs);
        let (t, d) = param_on(curve, range, sp);
        let inner = t - t0 > 1e-9 * (t1 - t0) && t1 - t > 1e-9 * (t1 - t0);
        if inner && d <= forge_ir::v1::LINEAR_TOLERANCE {
            return Err(fail(&format!(
                "the curve passes through a singular point of the {} at t = {t} (it needs a vertex there)",
                surface.kind_name()
            )));
        }
    }
    // The target may lie off the surface: a fitted intersection curve by up to the SSI fit
    // tolerance, an image on another carrier within the merge tolerance; the pcurve cannot
    // do better than that.
    let mut off: f64 = 0.0;
    for i in 0..=64 {
        let t = t0 + (t1 - t0) * i as f64 / 64.0;
        off = off.max(surface.project(target.point(t)).2);
    }
    if off > 1e-6 {
        return Err(fail(&format!(
            "the curve does not lie on the {} (offset {off:.3e})",
            surface.kind_name()
        )));
    }
    if std::env::var_os("FORGE_BOOLEAN_DEBUG_FIT").is_some() {
        eprintln!(
            "  fit target off {off:.2e} ({} on {})",
            curve.kind_name(),
            surface.kind_name()
        );
    }
    let tol = if refit { REFIT_TOL } else { PCURVE_FIT }.max(1e-12 * size);
    let start = uv_at(t0, near);
    // Affine: the image is a straight segment in (u, v), uniformly parametrized.
    let end = {
        let mut prev = start;
        let n = 16;
        for i in 1..=n {
            let t = t0 + (t1 - t0) * i as f64 / n as f64;
            prev = uv_at(t, Some(prev));
        }
        prev
    };
    let lin = NurbsCurve2::new(
        1,
        vec![t0, t0, t1, t1],
        vec![start.to_array(), end.to_array()],
        None,
    )
    .map_err(|_| fail("degree-1 construction"))?;
    let lin: Curve2 = lin.into();
    let e_lin = dev_of(&lin, 32);
    if e_lin <= 1e-10 * size && e_lin <= tol {
        return Ok((lin.clone(), dev_target(&lin)));
    }
    // Circles / ellipses on planes.
    if let (Surface::Plane(pl), Curve3::Circle(_) | Curve3::Ellipse(_)) = (surface, curve) {
        let f = pl.frame();
        let (fr, rx, ry) = match curve {
            Curve3::Circle(c) => (*c.frame(), c.radius(), c.radius()),
            Curve3::Ellipse(e) => (*e.frame(), e.rx(), e.ry()),
            _ => unreachable!(),
        };
        let o = f.to_local_point(fr.origin());
        let x = f.to_local_vector(fr.x()).truncate();
        let y = f.to_local_vector(fr.y()).truncate();
        let (xl, yl) = (x.norm(), y.norm());
        // Counter-clockwise, orthogonal images of the curve's axes.
        if xl > 0.0 && yl > 0.0 && x.dot(y).abs() <= 1e-12 && x.perp_dot(y) > 0.0 {
            let e2 = Ellipse2::new(o.truncate(), x, rx * xl, ry * yl)
                .map_err(|_| fail("ellipse construction"))?;
            let pc: Curve2 = e2.into();
            let err = dev_of(&pc, 64);
            if err <= tol {
                let dev = dev_target(&pc);
                return Ok((pc, dev));
            }
        }
    }
    // The target's own knots inside the range (a fitted B-spline curve or pcurve has jumps
    // in a higher derivative there; spans straddling them converge slowly).
    let own_knots: Vec<f64> = {
        let own: &[f64] = match target {
            FitTarget::Curve(Curve3::BSpline(n)) => n.knots(),
            FitTarget::Image {
                pcurve: Curve2::BSpline(n),
                ..
            } => n.knots(),
            _ => &[],
        };
        let margin = 1e-9 * (t1 - t0);
        let mut v: Vec<f64> = own
            .iter()
            .copied()
            .filter(|&k| k > t0 + margin && k < t1 - margin)
            .collect();
        v.dedup_by(|a, b| (*a - *b).abs() <= margin);
        if v.len() > 2048 { Vec::new() } else { v }
    };
    // Tight pass: C⁰ quintic pieces interpolating the target's surface projection at six
    // Chebyshev–Lobatto nodes per span (points only: robust on fitted curves whose
    // analytic derivatives are poor), spans halved until every one is within `tol` of the
    // projection at interior samples. Error ~h⁶: a few dozen spans reach 1e-10 mm.
    // (A span checked at 24 interior points can still hide a peak a uniform grid over the
    // range finds: then once more with a tenth of the tolerance.)
    for pass_tol in [tol, 0.1 * tol] {
        if let Some(pc) = quintic_pass(
            &uv_at, &goal, surface, range, start, &own_knots, pass_tol, 4096,
        ) {
            let err = dev_of(&pc, 256);
            if err <= tol {
                let dev = dev_target(&pc).max(err);
                return Ok((pc, dev));
            }
        }
    }
    if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
        eprintln!(
            "fit_pcurve: tight pass failed: {} on {}, range {range:?}, off {off:e}, tol {tol:e}",
            curve.kind_name(),
            surface.kind_name()
        );
    }
    // Relaxed pass (the round-3 fit), where the tight one cannot converge (a fitted section
    // passing a cone apex or sphere pole at a small offset, where `u` swings within that
    // offset): adaptive cubic Hermite spans within `PCURVE_FIT_RELAXED` plus 1.5 times the
    // target's distance from the surface, against the target itself. Derivatives by
    // one-sided differences of projected points, or exact for images of pcurves; every span
    // whose deviation, sampled at seven interior points, exceeds the tolerance is halved.
    let relaxed_tol = PCURVE_FIT_RELAXED.max(1.5 * off + 1e-12 * size);
    {
        let (tol, max_spans) = (relaxed_tol, 40_000);
        let goal = |t: f64| target.point(t);
        let mut ts: Vec<f64> = (0..=8)
            .map(|i| {
                if i == 8 {
                    t1
                } else {
                    t0 + (t1 - t0) * i as f64 / 8.0
                }
            })
            .collect();
        ts.extend(own_knots.iter().copied());
        ts.sort_by(f64::total_cmp);
        ts.dedup_by(|a, b| a.to_bits() == b.to_bits());
        let min_span = 1e-13 * (1.0 + t0.abs().max(t1.abs()));
        for _round in 0..64 {
            let n = ts.len() - 1;
            let mut pts = Vec::with_capacity(n + 1);
            let mut prev = start;
            for (i, &t) in ts.iter().enumerate() {
                let uv = if i == 0 { start } else { uv_at(t, Some(prev)) };
                pts.push(uv);
                prev = uv;
            }
            let rate = |i: usize, inward: f64, other: usize| -> Vec2 {
                // At a range end on a singular line the curve may pass the singular point at a
                // small offset (a fitted section, within its fit tolerance): `u` swings through
                // up to π/2 within that offset of the end, so a difference quotient there is
                // meaningless. The secant to the next knot is used (the pcurve is straight up
                // to the singular point at the scale of the knot spacing).
                if (i == 0 || i == n) && sing.iter().any(|&vs| pts[i].y.to_bits() == vs.to_bits()) {
                    return (pts[other] - pts[i]) / (ts[other] - ts[i]);
                }
                if let Some(d) = target
                    .deriv(ts[i])
                    .and_then(|d| uv_rate(surface, pts[i], d))
                {
                    return d;
                }
                // Second-order one-sided difference from inside the span (error ~eps²·|uv'''|,
                // far below the tight fit tolerance).
                let h = (ts[other] - ts[i]).abs();
                let eps = 1e-3 * h;
                let q1 = uv_at(ts[i] + inward * eps, Some(pts[i]));
                let q2 = uv_at(ts[i] + inward * 2.0 * eps, Some(q1));
                let fd = (q1 * 4.0 - pts[i] * 3.0 - q2) / (2.0 * inward * eps);
                if fd.is_finite() && eps > 0.0 {
                    fd
                } else {
                    (pts[other] - pts[i]) / (ts[other] - ts[i])
                }
            };
            let mut knots = vec![t0; 4];
            let mut ctrl: Vec<[f64; 2]> = Vec::with_capacity(3 * n + 1);
            let mut spans: Vec<[Point2; 4]> = Vec::with_capacity(n);
            for i in 0..n {
                let h = ts[i + 1] - ts[i];
                let (p0, p1) = (pts[i], pts[i + 1]);
                let (d0, d1) = (rate(i, 1.0, i + 1), rate(i + 1, -1.0, i));
                let (c1, c2) = (p0 + d0 * (h / 3.0), p1 - d1 * (h / 3.0));
                spans.push([p0, c1, c2, p1]);
                if i == 0 {
                    ctrl.push(p0.to_array());
                }
                ctrl.push(c1.to_array());
                ctrl.push(c2.to_array());
                ctrl.push(p1.to_array());
                if i + 1 < n {
                    knots.push(ts[i + 1]);
                    knots.push(ts[i + 1]);
                    knots.push(ts[i + 1]);
                }
            }
            knots.extend([t1; 4]);
            // Per-span deviation (Bézier evaluated directly).
            let bez = |c: &[Point2; 4], s: f64| -> Point2 {
                let r = 1.0 - s;
                c[0] * (r * r * r)
                    + c[1] * (3.0 * r * r * s)
                    + c[2] * (3.0 * r * s * s)
                    + c[3] * (s * s * s)
            };
            let mut worst: f64 = 0.0;
            let mut split: Vec<f64> = Vec::new();
            for i in 0..n {
                let mut e: f64 = 0.0;
                for k in 1..8 {
                    let sx = k as f64 / 8.0;
                    let t = ts[i] + (ts[i + 1] - ts[i]) * sx;
                    let uv = bez(&spans[i], sx);
                    e = e.max(surface.eval(uv.x, uv.y).distance(goal(t)));
                }
                worst = worst.max(e);
                if e > tol && ts[i + 1] - ts[i] > min_span {
                    split.push(0.5 * (ts[i] + ts[i + 1]));
                }
            }
            if worst <= tol {
                let nc = NurbsCurve2::new(3, knots, ctrl, None)
                    .map_err(|_| fail("B-spline construction"))?;
                let pc: Curve2 = nc.into();
                // Independent check on a uniform grid; spans it catches are refined.
                let k = 4 * n;
                let mut err: f64 = worst;
                for j in 0..=k {
                    let t = if j == k {
                        t1
                    } else {
                        t0 + (t1 - t0) * j as f64 / k as f64
                    };
                    let uv = pc.eval(t);
                    let e = surface.eval(uv.x, uv.y).distance(goal(t));
                    err = err.max(e);
                    if e > tol {
                        let i = ts.partition_point(|&x| x <= t).clamp(1, n) - 1;
                        if ts[i + 1] - ts[i] > min_span {
                            split.push(0.5 * (ts[i] + ts[i + 1]));
                        }
                    }
                }
                if err <= tol {
                    let dev = dev_target(&pc).max(err);
                    return Ok((pc, dev));
                }
                split.sort_by(f64::total_cmp);
                split.dedup();
            }
            if split.is_empty() || ts.len() + split.len() > max_spans {
                if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                    eprintln!(
                        "fit_pcurve relaxed pass failed: {} on {}, range {range:?}, off {off:e}, target {tol:e}, worst {worst:e}, spans {n}, refit {refit}",
                        curve.kind_name(),
                        surface.kind_name()
                    );
                }
                break;
            }
            ts.extend(split);
            ts.sort_by(f64::total_cmp);
        }
    }
    Err(fail("deviation above the fit tolerance"))
}

/// Chebyshev–Lobatto nodes of the quintic pass on `[0, 1]`: `(1 − cos(kπ/5)) / 2`.
const QUINTIC_NODES: [f64; 6] = [
    0.0,
    0.095_491_502_812_526_27,
    0.345_491_502_812_526_3,
    0.654_508_497_187_473_7,
    0.904_508_497_187_473_7,
    1.0,
];

/// Binomial coefficients of degree 5.
const BINOM5: [f64; 6] = [1.0, 5.0, 10.0, 10.0, 5.0, 1.0];

/// Inverse of the quintic Bernstein collocation matrix `B_j(s_k)` at [`QUINTIC_NODES`].
fn quintic_inverse() -> &'static [[f64; 6]; 6] {
    static INV: std::sync::OnceLock<[[f64; 6]; 6]> = std::sync::OnceLock::new();
    INV.get_or_init(|| {
        let mut a = [[0.0f64; 12]; 6];
        for (k, &s) in QUINTIC_NODES.iter().enumerate() {
            for j in 0..6 {
                a[k][j] = BINOM5[j] * math::powi(s, j as i32) * math::powi(1.0 - s, 5 - j as i32);
            }
            a[k][6 + k] = 1.0;
        }
        // Gauss–Jordan with partial pivoting (a fixed, well-conditioned 6 × 6 system).
        for c in 0..6 {
            let p = (c..6)
                .max_by(|&x, &y| a[x][c].abs().total_cmp(&a[y][c].abs()))
                .expect("rows");
            a.swap(c, p);
            let d = a[c][c];
            for x in &mut a[c] {
                *x /= d;
            }
            for r in 0..6 {
                if r != c {
                    let f = a[r][c];
                    if f != 0.0 {
                        let row = a[c];
                        for (x, y) in a[r].iter_mut().zip(row) {
                            *x -= f * y;
                        }
                    }
                }
            }
        }
        let mut inv = [[0.0; 6]; 6];
        for (r, row) in inv.iter_mut().enumerate() {
            row.copy_from_slice(&a[r][6..]);
        }
        inv
    })
}

/// A quintic Bézier piece at `s ∈ [0, 1]`.
fn bezier5(c: &[Point2; 6], s: f64) -> Point2 {
    let r = 1.0 - s;
    let (mut x, mut y) = (0.0, 0.0);
    for (j, cj) in c.iter().enumerate() {
        let b = BINOM5[j] * math::powi(s, j as i32) * math::powi(r, 5 - j as i32);
        x += b * cj.x;
        y += b * cj.y;
    }
    Point2::new(x, y)
}

/// The tight pass of [`fit_generic`]: a C⁰ quintic B-spline pcurve whose spans interpolate
/// `uv_at` at the Chebyshev–Lobatto nodes, halved until `S(pc(t))` is within `tol` of
/// `goal(t)` at 24 interior points of every span; `None` past `max_spans` spans or when
/// a span cannot be split further.
#[allow(clippy::too_many_arguments)]
fn quintic_pass(
    uv_at: &dyn Fn(f64, Option<Point2>) -> Point2,
    goal: &dyn Fn(f64) -> Point3,
    surface: &Surface,
    (t0, t1): (f64, f64),
    start: Point2,
    own_knots: &[f64],
    tol: f64,
    max_spans: usize,
) -> Option<Curve2> {
    let inv = quintic_inverse();
    let min_span = 1e-12 * (1.0 + t0.abs().max(t1.abs()));
    // Breakpoints: four uniform spans and the target's knots.
    let mut ts: Vec<f64> = (0..=4)
        .map(|i| {
            if i == 4 {
                t1
            } else {
                t0 + (t1 - t0) * i as f64 / 4.0
            }
        })
        .collect();
    ts.extend(own_knots.iter().copied());
    ts.sort_by(f64::total_cmp);
    ts.dedup_by(|a, b| a.to_bits() == b.to_bits());
    // Spans in parameter order; each is fitted with its start value taken from the end of
    // the span before it (period copies stay continuous), and replaced by its halves until
    // it is within the tolerance.
    let mut spans: Vec<(f64, f64)> = ts.windows(2).map(|w| (w[0], w[1])).collect();
    let mut out: Vec<[Point2; 6]> = Vec::with_capacity(spans.len());
    let mut breaks: Vec<f64> = Vec::with_capacity(spans.len() + 1);
    breaks.push(t0);
    let mut prev = start;
    let mut i = 0;
    while i < spans.len() {
        let (a, b) = spans[i];
        let mut vals = [prev; 6];
        let mut p = prev;
        for (k, &s) in QUINTIC_NODES.iter().enumerate().skip(1) {
            let t = if k == 5 { b } else { a + (b - a) * s };
            p = uv_at(t, Some(p));
            vals[k] = p;
        }
        let mut c = [Point2::new(0.0, 0.0); 6];
        for (j, cj) in c.iter_mut().enumerate() {
            let (mut x, mut y) = (0.0, 0.0);
            for (k, v) in vals.iter().enumerate() {
                x += inv[j][k] * v.x;
                y += inv[j][k] * v.y;
            }
            *cj = Point2::new(x, y);
        }
        // The ends exactly (the interpolation reproduces them up to rounding).
        c[0] = vals[0];
        c[5] = vals[5];
        let mut e: f64 = 0.0;
        for m in 0..24 {
            let s = (m as f64 + 0.5) / 24.0;
            let uv = bezier5(&c, s);
            e = e.max(surface.eval(uv.x, uv.y).distance(goal(a + (b - a) * s)));
        }
        if e > tol {
            if b - a <= min_span || spans.len() >= max_spans {
                if std::env::var_os("FORGE_BOOLEAN_DEBUG").is_some() {
                    eprintln!(
                        "quintic pass: span ({a}, {b}) deviation {e:e} > {tol:e} with {} spans",
                        spans.len()
                    );
                }
                return None;
            }
            let m = 0.5 * (a + b);
            spans[i] = (a, m);
            spans.insert(i + 1, (m, b));
            continue;
        }
        out.push(c);
        breaks.push(b);
        prev = vals[5];
        i += 1;
    }
    // Knots of multiplicity 5 at the interior breakpoints (C⁰ joins).
    let mut knots = vec![t0; 6];
    let mut ctrl: Vec<[f64; 2]> = Vec::with_capacity(5 * out.len() + 1);
    for (k, c) in out.iter().enumerate() {
        if k == 0 {
            ctrl.push(c[0].to_array());
        }
        for cj in &c[1..] {
            ctrl.push(cj.to_array());
        }
        if k + 1 < out.len() {
            knots.extend([breaks[k + 1]; 5]);
        }
    }
    knots.extend([t1; 6]);
    NurbsCurve2::new(5, knots, ctrl, None).ok().map(Into::into)
}

/// Parameter of the point of `curve` nearest to `p`, restricted to `range` (periodic
/// curves: the representative inside the range, or the nearer end), and its distance.
pub(crate) fn param_on(curve: &Curve3, range: (f64, f64), p: Point3) -> (f64, f64) {
    let (t, _) = curve.project(p);
    let t = match curve.period() {
        Some(per) => {
            let mut x = range.0 + math::rem_euclid(t - range.0, per);
            if x > range.1 {
                // Outside: the nearer end (through the period gap).
                let d_end = x - range.1;
                let d_start = range.0 + per - x;
                x = if d_end <= d_start { range.1 } else { range.0 };
            }
            x
        }
        None => t.clamp(range.0, range.1),
    };
    // Refine by projection onto the tangent line (the global projection of B-splines
    // is approximate).
    let mut t = t;
    for _ in 0..8 {
        let [c, d, _] = curve.derivs2(t);
        let dd = d.dot(d);
        if dd.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            break;
        }
        let step = (p - c).dot(d) / dd;
        let nt = (t + step).clamp(range.0, range.1);
        if (nt - t).abs() <= 1e-15 * (1.0 + t.abs()) {
            t = nt;
            break;
        }
        t = nt;
    }
    (t, curve.eval(t).distance(p))
}

/// `true` if two surfaces are the same geometric surface (same type, same carrier), up
/// to `tol` (mm) and the angular tolerance; the orientation of the normals is compared
/// separately.
pub(crate) fn same_carrier(a: &Surface, b: &Surface, tol: f64) -> bool {
    let ang = 1e-9;
    let par = |x: Vec3, y: Vec3| x.cross(y).norm() <= ang;
    match (a, b) {
        (Surface::Plane(p), Surface::Plane(q)) => {
            par(p.frame().z(), q.frame().z())
                && (q.frame().origin() - p.frame().origin())
                    .dot(p.frame().z())
                    .abs()
                    <= tol
        }
        (Surface::Cylinder(p), Surface::Cylinder(q)) => {
            let (fp, fq) = (p.frame(), q.frame());
            par(fp.z(), fq.z())
                && (p.radius() - q.radius()).abs() <= tol
                && (fq.origin() - fp.origin()).cross(fp.z()).norm() <= tol
        }
        (Surface::Cone(p), Surface::Cone(q)) => {
            let (fp, fq) = (p.frame(), q.frame());
            fp.z().dot(fq.z()) > 0.0
                && par(fp.z(), fq.z())
                && (p.half_angle() - q.half_angle()).abs() <= ang
                && p.apex().distance(q.apex()) <= tol
        }
        (Surface::Sphere(p), Surface::Sphere(q)) => {
            (p.radius() - q.radius()).abs() <= tol
                && p.frame().origin().distance(q.frame().origin()) <= tol
        }
        (Surface::Torus(p), Surface::Torus(q)) => {
            let (fp, fq) = (p.frame(), q.frame());
            par(fp.z(), fq.z())
                && (p.major() - q.major()).abs() <= tol
                && (p.minor() - q.minor()).abs() <= tol
                && fp.origin().distance(fq.origin()) <= tol
        }
        _ => false,
    }
}

/// A pcurve whose B-spline domain is exactly the edge range (a sub-range of an SSI branch
/// pcurve is refitted), so that its ends can be welded.
pub(crate) fn clamp_pcurve(
    surface: &Surface,
    curve: &Curve3,
    range: (f64, f64),
    pc: &Curve2,
) -> Result<Curve2, BooleanError> {
    if let Curve2::BSpline(b) = pc {
        let (d0, d1) = b.domain();
        let tol = 1e-12 * (1.0 + d0.abs().max(d1.abs()));
        if (d0 - range.0).abs() > tol || (d1 - range.1).abs() > tol {
            // The exact sub-range (knot insertion): the same image, so the faces of the
            // edge keep closing up as the pcurve they were cut from did; a refit only
            // where the range leaves the pcurve's domain.
            if range.0 >= d0 - tol
                && range.1 <= d1 + tol
                && let Some(seg) = nurbs_segment(b, range.0.max(d0), range.1.min(d1))
            {
                let (s0, s1) = seg.domain();
                if (s0 - range.0).abs() <= tol && (s1 - range.1).abs() <= tol {
                    return Ok(seg.into());
                }
            }
            let (c, _) = fit_pcurve(surface, curve, range, Some(pc.eval(range.0)))?;
            return Ok(c);
        }
    }
    Ok(pc.clone())
}

/// A 2D curve moved by `d`.
pub(crate) fn shift_curve2(c: &Curve2, d: Vec2) -> Curve2 {
    use forge_core::geom::{Circle2, Line2};
    if d.x == 0.0 && d.y == 0.0 {
        return c.clone();
    }
    match c {
        Curve2::Line(l) => Line2::new(l.origin() + d, l.dir())
            .map(Into::into)
            .unwrap_or_else(|_| c.clone()),
        Curve2::Circle(k) => Circle2::new(k.center() + d, k.radius())
            .map(Into::into)
            .unwrap_or_else(|_| c.clone()),
        Curve2::Ellipse(e) => Ellipse2::new(e.center() + d, e.x_dir(), e.rx(), e.ry())
            .map(Into::into)
            .unwrap_or_else(|_| c.clone()),
        Curve2::Spiral(s) => forge_core::geom::Spiral2::new(
            s.center() + d,
            s.x_dir(),
            s.is_ccw(),
            s.radius(),
            s.radius_rate(),
        )
        .map(Into::into)
        .unwrap_or_else(|_| c.clone()),
        Curve2::BSpline(b) => {
            let pts: Vec<[f64; 2]> = b
                .control_points()
                .iter()
                .map(|p| [p[0] + d.x, p[1] + d.y])
                .collect();
            let w = b.weights().map(<[f64]>::to_vec);
            NurbsCurve2::new(b.degree(), b.knots().to_vec(), pts, w)
                .map(Into::into)
                .unwrap_or_else(|_| c.clone())
        }
    }
}

/// The pcurve with its value at parameter `t` (an end of its clamped domain) moved to
/// `target`: B-splines move their end control point (clamped ends interpolate it), lines
/// become degree-1 B-splines over `range`. `None` for circles and ellipses (exact conics,
/// only on planes, which have no periods).
fn snap_end(c: &Curve2, range: (f64, f64), at_start: bool, target: Point2) -> Option<Curve2> {
    let b = match c {
        Curve2::BSpline(b) => b.clone(),
        Curve2::Line(_) => NurbsCurve2::new(
            1,
            vec![range.0, range.0, range.1, range.1],
            vec![c.eval(range.0).to_array(), c.eval(range.1).to_array()],
            None,
        )
        .ok()?,
        _ => return None,
    };
    let (d0, d1) = b.domain();
    let t = if at_start { range.0 } else { range.1 };
    // Only a clamped end of the domain can be moved by its control point.
    let tol = 1e-12 * (1.0 + d0.abs().max(d1.abs()));
    let mut pts: Vec<[f64; 2]> = b.control_points().to_vec();
    let idx = if (t - d0).abs() <= tol {
        0
    } else if (t - d1).abs() <= tol {
        pts.len() - 1
    } else {
        return None;
    };
    pts[idx] = target.to_array();
    let w = b.weights().map(<[f64]>::to_vec);
    NurbsCurve2::new(b.degree(), b.knots().to_vec(), pts, w)
        .ok()
        .map(Into::into)
}

/// Make the pcurves of one loop (traversal order: `(pcurve, edge range, forward)`) meet
/// exactly at every join, modulo the surface's periods: each pcurve is shifted by whole
/// periods to continue the previous one, then the snappable end at each join (B-splines,
/// lines) is moved onto the other side's point. forge-check reads loops by exact period
/// shifts (to 1e-9), while vertices merge within the linear tolerance; this closes that gap
/// without moving any curve by more than the vertex tolerance. Returns the deviation
/// introduced (parameter units).
pub(crate) fn weld_loop(surface: &Surface, uses: &mut [(Curve2, (f64, f64), bool)]) -> f64 {
    let (pu, pv) = surface.periodicity();
    let n = uses.len();
    if n == 0 {
        return 0.0;
    }
    let ends = |u: &(Curve2, (f64, f64), bool)| -> (Point2, Point2) {
        let (a, b) = if u.2 { (u.1.0, u.1.1) } else { (u.1.1, u.1.0) };
        (u.0.eval(a), u.0.eval(b))
    };
    let per_shift = |d: Vec2| -> Vec2 {
        Vec2::new(
            pu.map_or(0.0, |p| (d.x / p).round() * p),
            pv.map_or(0.0, |p| (d.y / p).round() * p),
        )
    };
    // Continuous lift.
    for i in 1..n {
        let prev_end = ends(&uses[i - 1]).1;
        let st = ends(&uses[i]).0;
        let s = per_shift(prev_end - st);
        if s.x != 0.0 || s.y != 0.0 {
            uses[i].0 = shift_curve2(&uses[i].0, s);
        }
    }
    let mut moved: f64 = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        let prev_end = ends(&uses[i]).1;
        let next_start = ends(&uses[j]).0;
        // The closing join may differ by whole periods (a wrapping loop).
        let wrap = per_shift(prev_end - next_start);
        let target = prev_end - wrap; // where the next pcurve should start
        let gap = target.distance(next_start);
        if gap == 0.0 {
            continue;
        }
        // Joins on a singular line (apex, pole) are not gaps: any `u` is the same point
        // there, and forge-check runs such joins along the line. Only rounding-size gaps
        // are welded; anything larger is left for the checks to report.
        if singular_vs(surface)
            .iter()
            .any(|&vs| (prev_end.y - vs).abs() <= 1e-7 * (1.0 + vs.abs()))
            || gap > 1e-5 * (1.0 + target.x.abs().max(target.y.abs()))
        {
            continue;
        }
        // Prefer moving the next pcurve's start; else the previous one's end.
        let (c, r, fwd) = (&uses[j].0, uses[j].1, uses[j].2);
        if n > 1 || i != j {
            if let Some(nc) = snap_end(c, r, fwd, target) {
                uses[j].0 = nc;
                moved = moved.max(gap);
                continue;
            }
            let (c, r, fwd) = (&uses[i].0, uses[i].1, uses[i].2);
            if let Some(nc) = snap_end(c, r, !fwd, next_start + wrap) {
                uses[i].0 = nc;
                moved = moved.max(gap);
            }
        }
    }
    moved
}

/// The piece of a B-spline over `[a, b]` (inside its domain) as a clamped B-spline with the
/// same parametrization: exact, by knot insertion to full multiplicity at the ends.
pub(crate) fn nurbs_segment<const D: usize>(
    c: &forge_core::geom::nurbs::NurbsCurve<D>,
    a: f64,
    b: f64,
) -> Option<forge_core::geom::nurbs::NurbsCurve<D>> {
    let p = c.degree();
    let (d0, d1) = c.domain();
    if a.partial_cmp(&b) != Some(std::cmp::Ordering::Less) || a < d0 || b > d1 {
        return None;
    }
    // Knots within rounding of a cut parameter are that parameter: snap the cut to an
    // existing knot there (inserting next to it would leave a knot one ulp inside the
    // segment, i.e. too many end knots, and a concatenation the constructor rejects).
    let eps = 1e-12 * (1.0 + (d1 - d0).abs());
    let snap = |u: f64, knots: &[f64]| {
        knots
            .iter()
            .copied()
            .find(|&k| (k - u).abs() <= eps)
            .unwrap_or(u)
    };
    let (a, b) = (snap(a, c.knots()), snap(b, c.knots()));
    let mut cur = c.clone();
    for u in [a, b] {
        if u > d0 && u < d1 {
            let s = cur
                .knots()
                .iter()
                .filter(|&&k| k.to_bits() == u.to_bits())
                .count();
            if s < p {
                cur = cur.insert_knot(u, p - s).ok()?;
            }
        }
    }
    let knots = cur.knots();
    // Inserted copies may differ from `u` in the last bits: count within `eps`.
    let ra = knots.iter().filter(|&&k| k <= a + eps).count();
    let sb = knots.iter().filter(|&&k| k < b - eps).count();
    let (ia, ib) = (ra.checked_sub(p + 1)?, sb.checked_sub(1)?);
    if ib < ia || ib >= cur.control_points().len() {
        return None;
    }
    let ctrl = cur.control_points()[ia..=ib].to_vec();
    let weights = cur.weights().map(|w| w[ia..=ib].to_vec());
    let mut kv = vec![a; p + 1];
    kv.extend(
        knots
            .iter()
            .copied()
            .filter(|&k| k > a + eps && k < b - eps),
    );
    kv.extend(std::iter::repeat_n(b, p + 1));
    forge_core::geom::nurbs::NurbsCurve::<D>::new(p, kv, ctrl, weights).ok()
}

/// `x` followed by `y` (same degree, `y` starting where `x` ends) as one B-spline whose
/// parameter continues `x`'s: `y`'s domain is shifted to start at `x`'s end. Exact; the
/// joint is a knot of multiplicity `degree` (C⁰ in the parametrization).
pub(crate) fn nurbs_concat(x: &NurbsCurve3, y: &NurbsCurve3) -> Option<NurbsCurve3> {
    let p = x.degree();
    if y.degree() != p || x.is_rational() != y.is_rational() {
        return None;
    }
    let (_, xb) = x.domain();
    let (ya, _) = y.domain();
    let shift = xb - ya;
    let xk = x.knots();
    let yk = y.knots();
    let mut kv: Vec<f64> = xk[..xk.len() - (p + 1)].to_vec();
    kv.extend(std::iter::repeat_n(xb, p));
    kv.extend(yk[p + 1..].iter().map(|k| k + shift));
    let mut ctrl = x.control_points().to_vec();
    ctrl.extend_from_slice(&y.control_points()[1..]);
    let weights = match (x.weights(), y.weights()) {
        (Some(wx), Some(wy)) => {
            let scale = wx[wx.len() - 1] / wy[0];
            let mut w = wx.to_vec();
            w.extend(wy[1..].iter().map(|v| v * scale));
            Some(w)
        }
        _ => None,
    };
    NurbsCurve3::new(p, kv, ctrl, weights).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::geom::{Circle3, Cone, Cylinder, Line3, Plane, Sphere};
    use forge_core::linalg::Frame;

    fn frame(o: [f64; 3], n: [f64; 3], x: [f64; 3]) -> Frame {
        Frame::from_normal_x(Vec3::from(o), Vec3::from(n), Vec3::from(x)).expect("frame")
    }

    #[test]
    fn affine_pcurves_are_exact_degree_one() {
        let cyl: Surface = Cylinder::new(Frame::world(), 2.0).expect("c").into();
        let line: Curve3 = Line3::new(Vec3::new(2.0, 0.0, -1.0), Vec3::unit_z())
            .expect("l")
            .into();
        let (pc, err) = fit_pcurve(&cyl, &line, (0.0, 3.0), None).expect("fit");
        assert!(err <= 1e-12, "{err}");
        assert!(matches!(&pc, Curve2::BSpline(b) if b.degree() == 1));
        // A parallel circle of a cone.
        let cone: Surface = Cone::new(Frame::world(), 1.0, 0.5).expect("k").into();
        let r = 1.0 + 2.0 * math::tan(0.5);
        let circ: Curve3 =
            Circle3::new(frame([0.0, 0.0, 2.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]), r)
                .expect("c")
                .into();
        let (pc, err) = fit_pcurve(&cone, &circ, (0.5, 4.0), None).expect("fit");
        assert!(err <= 1e-10, "{err}");
        assert!(matches!(&pc, Curve2::BSpline(b) if b.degree() == 1));
    }

    #[test]
    fn plane_circles_are_ellipses_or_hermite_when_clockwise() {
        let pl: Surface = Plane::new(Frame::world()).into();
        let ccw: Curve3 = Circle3::new(
            frame([1.0, 2.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            3.0,
        )
        .expect("c")
        .into();
        let (pc, err) = fit_pcurve(&pl, &ccw, (0.0, 2.0), None).expect("fit");
        assert!(matches!(pc, Curve2::Ellipse(_)));
        assert!(err <= 1e-12);
        let cw: Curve3 = Circle3::new(
            frame([1.0, 2.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),
            3.0,
        )
        .expect("c")
        .into();
        let (pc, err) = fit_pcurve(&pl, &cw, (0.0, 2.0), None).expect("fit");
        assert!(matches!(pc, Curve2::BSpline(_)));
        assert!(err <= PCURVE_FIT);
    }

    #[test]
    fn general_pcurves_meet_the_fit_tolerance_on_spheres() {
        let sph: Surface = Sphere::new(Frame::world(), 3.0).expect("s").into();
        // A small circle, not a parallel: tilted plane section.
        let n = Vec3::new(0.3, 0.2, 1.0).normalize().expect("n");
        let d = 1.2;
        let r = math::sqrt(9.0 - d * d);
        let fr = Frame::from_normal(n * d, n).expect("f");
        let c: Curve3 = Circle3::new(fr, r).expect("c").into();
        let (pc, err) = fit_pcurve(&sph, &c, (0.0, math::TAU), None).expect("fit");
        assert!(err <= PCURVE_FIT, "{err}");
        // Dense independent check.
        assert!(pcurve_error(&sph, &c, &pc, (0.0, math::TAU), 5000) <= 2.0 * PCURVE_FIT);
    }

    #[test]
    fn pcurves_ending_at_a_cone_apex_take_the_limit_u() {
        // A generator from the base circle to the apex (the apex's own `u` is arbitrary):
        // the pcurve is the exact vertical segment, its apex end at the generator's `u`.
        let cone: Surface = Cone::new(Frame::world(), 2.0, 0.5).expect("k").into();
        let apex = Vec3::new(0.0, 0.0, -2.0 / math::tan(0.5));
        let base = Vec3::new(-2.0 * 0.6, -2.0 * 0.8, 0.0);
        let line: Curve3 = Line3::new(base, (apex - base).normalize().expect("d"))
            .expect("l")
            .into();
        let len = (apex - base).norm();
        let (pc, err) = fit_pcurve(&cone, &line, (0.0, len), None).expect("fit");
        assert!(err <= 1e-10, "{err}");
        let (a, b) = (pc.eval(0.0), pc.eval(len));
        assert!((a.x - b.x).abs() <= 1e-9, "{a:?} -> {b:?}");
        assert!(matches!(&pc, Curve2::BSpline(x) if x.degree() == 1));
        // Reversed: the apex at the start.
        let back: Curve3 = Line3::new(apex, (base - apex).normalize().expect("d"))
            .expect("l")
            .into();
        let (pc, _) = fit_pcurve(&cone, &back, (0.0, len), None).expect("fit");
        assert!((pc.eval(0.0).x - pc.eval(len).x).abs() <= 1e-9);
    }

    #[test]
    fn pcurves_near_a_singular_point_stay_on_its_side() {
        // A generator ending at a cone's apex: projections of points within rounding of
        // the apex can land on the other nappe; the pcurve never crosses the apex row.
        let cone: Surface = Cone::new(Frame::world(), 2.0, 0.5).expect("k").into();
        let apex_v = -2.0 / math::tan(0.5);
        let apex = Vec3::new(0.0, 0.0, apex_v);
        let base = Vec3::new(2.0, 0.0, 0.0);
        let dir = (apex - base).normalize().expect("d");
        let line: Curve3 = Line3::new(base, dir).expect("l").into();
        let len = (apex - base).norm();
        let (pc, _) = fit_pcurve(&cone, &line, (0.0, len), None).expect("fit");
        for i in 0..=1000 {
            let t = len * i as f64 / 1000.0;
            assert!(pc.eval(t).y >= apex_v - 1e-12, "t {t}: {:?}", pc.eval(t));
        }
    }

    #[test]
    fn nurbs_segments_and_concatenations_are_exact() {
        // A cubic B-spline with interior knots.
        let ctrl = vec![
            [0.0, 0.0, 0.0],
            [1.0, 2.0, 0.0],
            [2.0, -1.0, 1.0],
            [3.0, 3.0, 0.5],
            [4.0, 0.0, -1.0],
            [5.0, 1.0, 0.0],
        ];
        let knots = vec![0.0, 0.0, 0.0, 0.0, 1.0, 2.5, 4.0, 4.0, 4.0, 4.0];
        let c = NurbsCurve3::new(3, knots, ctrl, None).expect("c");
        let (a, m, b) = (0.3, 1.7, 3.6);
        let x = nurbs_segment(&c, a, m).expect("x");
        let y = nurbs_segment(&c, m, b).expect("y");
        assert_eq!(x.domain(), (a, m));
        for i in 0..=50 {
            let t = a + (m - a) * i as f64 / 50.0;
            let (p, q) = (x.eval(t), c.eval(t));
            assert!(p.distance(q) <= 1e-12, "{t}");
        }
        let cat = nurbs_concat(&x, &y).expect("cat");
        assert_eq!(cat.domain(), (a, b));
        for i in 0..=100 {
            let t = a + (b - a) * i as f64 / 100.0;
            assert!(cat.eval(t).distance(c.eval(t)) <= 1e-12, "{t}");
        }
        // Across the closure of a closed curve: the end piece followed by the start piece,
        // the second continuing the first's parameter.
        let mut ctrl = c.control_points().to_vec();
        let first = ctrl[0];
        *ctrl.last_mut().expect("ctrl") = first;
        let closed = NurbsCurve3::new(3, c.knots().to_vec(), ctrl, None).expect("closed");
        let w = nurbs_segment(&closed, 3.0, 4.0).expect("w");
        let z = nurbs_segment(&closed, 0.0, 1.0).expect("z");
        let j = nurbs_concat(&w, &z).expect("j");
        assert_eq!(j.domain(), (3.0, 5.0));
        for i in 0..=40 {
            let t = 3.0 + 2.0 * i as f64 / 40.0;
            let s = if t <= 4.0 { t } else { t - 4.0 };
            assert!(j.eval(t).distance(closed.eval(s)) <= 1e-12, "{t}");
        }
        // Cuts within rounding of an interior knot of full multiplicity (a C0 joint of a
        // fitted curve), 1.0 give or take an ulp: the cut snaps to the knot. Inserting next
        // to it gave a piece with a second cluster of end knots one ulp inside, whose
        // concatenation the constructor rejects; a closed intersection curve then stayed
        // split in two edges (case 23:307).
        let ctrl: Vec<[f64; 3]> = (0..8)
            .map(|i| {
                let t = f64::from(i);
                [t, (0.7 * t).sin(), 0.1 * t * t]
            })
            .collect();
        let knots = vec![0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 1.0, 2.5, 4.0, 4.0, 4.0, 4.0];
        let c0 = NurbsCurve3::new(3, knots, ctrl, None).expect("c0");
        for m in [
            f64::from_bits(1.0f64.to_bits() + 1),
            f64::from_bits(1.0f64.to_bits() - 1),
            1.0 + 4e-13,
        ] {
            let x = nurbs_segment(&c0, 0.3, m).expect("x");
            let y = nurbs_segment(&c0, m, 3.6).expect("y");
            let cat = nurbs_concat(&x, &y).expect("concatenation");
            let (d0, d1) = cat.domain();
            assert!((d0 - 0.3).abs() <= 1e-12 && (d1 - 3.6).abs() <= 1e-12);
            for i in 0..=60 {
                let t = d0 + (d1 - d0) * i as f64 / 60.0;
                assert!(cat.eval(t).distance(c0.eval(t)) <= 1e-10, "{m} {t}");
            }
            // Across the closure: the start piece is shifted by the period, which rounds
            // the knot and the ulp-off cut to one value (multiplicity 7 > 4 without the
            // snap).
            let tail = nurbs_segment(&c0, 3.0, 4.0).expect("tail");
            let head = nurbs_segment(&c0, 0.0, m).expect("head");
            let j = nurbs_concat(&tail, &head).expect("concatenation across the closure");
            let (j0, j1) = j.domain();
            assert!(
                (j0 - 3.0).abs() <= 1e-12 && (j1 - 5.0).abs() <= 1e-12,
                "{j0} {j1}"
            );
        }
    }

    #[test]
    fn param_on_restricts_periodic_curves_to_their_range() {
        let c: Curve3 = Circle3::new(Frame::world(), 1.0).expect("c").into();
        let p = c.eval(5.0);
        let (t, d) = param_on(&c, (4.0, 7.0), p);
        assert!((t - 5.0).abs() <= 1e-12 && d <= 1e-12);
        let (t, _) = param_on(&c, (-1.5, 1.0), c.eval(-1.0));
        assert!((t + 1.0).abs() <= 1e-12, "{t}");
    }

    #[test]
    fn surface_boxes_contain_samples() {
        let cyl: Surface = Cylinder::new(
            frame([1.0, 2.0, 3.0], [0.3, 0.1, 1.0], [1.0, 0.0, 0.0]),
            2.0,
        )
        .expect("c")
        .into();
        let b = surface_box(&cyl, (0.2, 2.5), (-1.0, 4.0), 4);
        for i in 0..=20 {
            for j in 0..=20 {
                let p = cyl.eval(0.2 + 2.3 * i as f64 / 20.0, -1.0 + 5.0 * j as f64 / 20.0);
                assert!(b.grown(1e-12).overlaps(&Aabb { lo: p, hi: p }));
            }
        }
    }
}
