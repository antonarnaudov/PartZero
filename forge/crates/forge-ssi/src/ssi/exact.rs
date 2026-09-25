//! Closed-form intersection of analytic surface pairs.
//!
//! | Family | Pairs | Result |
//! |---|---|---|
//! | Plane–plane | plane × plane | line, none, coincident |
//! | Common extrusion direction | plane ∥ cylinder axis, cylinders with parallel axes | lines from a 2D line/circle arrangement; tangent lines; coincident |
//! | Common axis of revolution | any two of {plane ⟂ axis, cylinder, cone, sphere, torus} sharing an axis (a sphere shares every axis through its centre, so plane–sphere and sphere–sphere always qualify) | circles from the meridian arrangement; tangent circles; axis points; coincident |
//! | Plane–cylinder, oblique | | ellipse |
//! | Plane–cone | | ellipse, parabola / hyperbola (exact rational arcs), line pairs through the apex, the apex alone |
//! | Plane through a torus axis | | the two meridian circles |
//! | Bitangent plane of a ring torus | | the two Villarceau circles, crossing at the two tangency points |
//! | Equal cylinders, intersecting axes | | two ellipses crossing at two tangency points |
//!
//! Geometric decisions ("parallel", "on the axis", "tangent") are made at a scale of
//! `0.1·fit` over the problem size, so snapping never moves the result by more than the
//! output tolerance; every exact branch is certified afterwards and falls back to
//! marching if the certificate fails.

use forge_core::geom::{Circle3, Cylinder, Ellipse3, Line3, Plane, SpindlePatch, Surface};
use forge_core::math;
use forge_core::{Frame, Point2, Point3, Vec2, Vec3};

use crate::ssi::Ctx;
use crate::ssi::carrier::{Carrier, ConeSection};
use crate::types::{Coincidence, Contact, Method, UvAffine, VertexKind};

/// An exact carrier with its contact type and extra split points.
#[derive(Clone, Debug)]
pub(crate) struct Feature {
    pub carrier: Carrier,
    pub contact: Contact,
    /// Points where the carrier must be split (branch crossings), with the vertex kind.
    pub splits: Vec<(Point3, VertexKind)>,
}

/// An isolated intersection point.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IsoPoint {
    pub p: Point3,
    pub kind: VertexKind,
    pub contact: Contact,
}

/// A closed-form result.
#[derive(Clone, Debug)]
pub(crate) struct ExactOutcome {
    pub method: Method,
    pub features: Vec<Feature>,
    pub points: Vec<IsoPoint>,
    pub coincidence: Option<Coincidence>,
}

impl ExactOutcome {
    fn new(method: Method) -> Self {
        Self {
            method,
            features: Vec::new(),
            points: Vec::new(),
            coincidence: None,
        }
    }
    fn feature(&mut self, carrier: Carrier, contact: Contact) {
        self.features.push(Feature {
            carrier,
            contact,
            splits: Vec::new(),
        });
    }
}

/// Try every closed-form family in order.
pub(crate) fn detect(ctx: &Ctx) -> Option<ExactOutcome> {
    plane_plane(ctx)
        .or_else(|| extrusion(ctx))
        .or_else(|| revolution(ctx))
        .or_else(|| plane_cylinder(ctx))
        .or_else(|| plane_cone(ctx))
        .or_else(|| plane_torus_meridian(ctx))
        .or_else(|| plane_torus_villarceau(ctx))
        .or_else(|| equal_cylinders(ctx))
}

// ---------------------------------------------------------------------------------------
// 2D arrangement of lines and circles (cross-sections and meridians)

#[derive(Clone, Copy, Debug)]
enum Prim {
    /// `n·y = c`, `|n| = 1`.
    Line { n: Vec2, c: f64 },
    /// `|y − c| = r`.
    Circle { c: Point2, r: f64 },
}

/// Intersections of two primitives: `(points, coincident)`.
fn meet(a: Prim, b: Prim, tol: f64) -> (Vec<(Point2, Contact)>, bool) {
    match (a, b) {
        (Prim::Line { n: n1, c: c1 }, Prim::Line { n: n2, c: c2 }) => {
            let det = n1.perp_dot(n2);
            if det.abs() <= 1e-15 {
                let same = if n1.dot(n2) > 0.0 { c1 - c2 } else { c1 + c2 };
                return (Vec::new(), same.abs() <= tol);
            }
            let y = Point2::new((c1 * n2.y - c2 * n1.y) / det, (n1.x * c2 - n2.x * c1) / det);
            (vec![(y, Contact::Transversal)], false)
        }
        (Prim::Line { n, c }, Prim::Circle { c: m, r })
        | (Prim::Circle { c: m, r }, Prim::Line { n, c }) => {
            let delta = n.dot(m) - c;
            let foot = m - n * delta;
            let gap = delta.abs() - r;
            if gap > tol {
                (Vec::new(), false)
            } else if gap.abs() <= tol {
                (vec![(foot, Contact::Tangent { gap: gap.abs() })], false)
            } else {
                let h = (r * r - delta * delta).max(0.0).sqrt();
                let t = n.perp();
                (
                    vec![
                        (foot + t * h, Contact::Transversal),
                        (foot - t * h, Contact::Transversal),
                    ],
                    false,
                )
            }
        }
        (Prim::Circle { c: c1, r: r1 }, Prim::Circle { c: c2, r: r2 }) => {
            let dv = c2 - c1;
            let d = dv.norm();
            if d <= tol {
                return (Vec::new(), (r1 - r2).abs() <= tol);
            }
            let u = dv / d;
            let ext = d - (r1 + r2);
            let int = (r1 - r2).abs() - d;
            if ext > tol || int > tol {
                (Vec::new(), false)
            } else if ext.abs() <= tol {
                (
                    vec![(c1 + u * r1, Contact::Tangent { gap: ext.abs() })],
                    false,
                )
            } else if int.abs() <= tol {
                let s = if r1 >= r2 { 1.0 } else { -1.0 };
                (
                    vec![(c1 + u * (s * r1), Contact::Tangent { gap: int.abs() })],
                    false,
                )
            } else {
                let a = (d * d + r1 * r1 - r2 * r2) / (2.0 * d);
                let h = (r1 * r1 - a * a).max(0.0).sqrt();
                let base = c1 + u * a;
                let p = u.perp();
                (
                    vec![
                        (base + p * h, Contact::Transversal),
                        (base - p * h, Contact::Transversal),
                    ],
                    false,
                )
            }
        }
    }
}

// ---------------------------------------------------------------------------------------
// Plane–plane

fn plane_plane(ctx: &Ctx) -> Option<ExactOutcome> {
    let (Surface::Plane(p1), Surface::Plane(p2)) = (ctx.a.surf, ctx.b.surf) else {
        return None;
    };
    let mut out = ExactOutcome::new(Method::PlanePlane);
    let (n1, n2) = (p1.frame().z(), p2.frame().z());
    if ctx.parallel(n1, n2) {
        let delta = p1.signed_distance(p2.frame().origin());
        if delta.abs() <= ctx.snap() {
            out.coincidence = Some(Coincidence {
                same_orientation: n1.dot(n2) > 0.0,
                uv_map: Some(plane_map(p1, p2)),
            });
        }
        return Some(out);
    }
    let dir = n1.cross(n2).normalize()?;
    let c = p1.frame().origin() * 0.5 + p2.frame().origin() * 0.5;
    let k = n1.dot(n2);
    let e1 = n1.dot(p1.frame().origin() - c);
    let e2 = n2.dot(p2.frame().origin() - c);
    let det = 1.0 - k * k;
    let (al, be) = ((e1 - k * e2) / det, (e2 - k * e1) / det);
    let x = c + n1 * al + n2 * be;
    out.feature(
        Carrier::Line(Line3::new(x, dir).ok()?),
        Contact::Transversal,
    );
    Some(out)
}

fn plane_map(a: &Plane, b: &Plane) -> UvAffine {
    let (fa, fb) = (a.frame(), b.frame());
    let d = fa.origin() - fb.origin();
    UvAffine {
        m: [
            [fa.x().dot(fb.x()), fa.y().dot(fb.x())],
            [fa.x().dot(fb.y()), fa.y().dot(fb.y())],
        ],
        c: [d.dot(fb.x()), d.dot(fb.y())],
    }
}

// ---------------------------------------------------------------------------------------
// Common extrusion direction: planes parallel to a cylinder axis, parallel cylinders.

fn extrusion(ctx: &Ctx) -> Option<ExactOutcome> {
    // The frame of the cross-section: the first cylinder.
    let (cyl, other) = match (ctx.a.surf, ctx.b.surf) {
        (Surface::Cylinder(c), o) => (c, o),
        (o, Surface::Cylinder(c)) => (c, o),
        _ => return None,
    };
    let f = cyl.frame();
    let d = f.z();
    let to2 = |p: Point3| {
        let l = f.to_local_point(p);
        Point2::new(l.x, l.y)
    };
    let prim_cyl = Prim::Circle {
        c: Point2::zero(),
        r: cyl.radius(),
    };
    let prim_other = match other {
        Surface::Plane(p) => {
            let n = p.frame().z();
            if !ctx.perpendicular(n, d) {
                return None;
            }
            let n2 = Vec2::new(n.dot(f.x()), n.dot(f.y())).normalize()?;
            Prim::Line {
                n: n2,
                c: n2.dot(to2(p.frame().origin())),
            }
        }
        Surface::Cylinder(c2) => {
            if !ctx.parallel(c2.frame().z(), d) {
                return None;
            }
            Prim::Circle {
                c: to2(c2.frame().origin()),
                r: c2.radius(),
            }
        }
        _ => return None,
    };
    let mut out = ExactOutcome::new(Method::CommonExtrusion);
    let (pts, coincident) = meet(prim_cyl, prim_other, ctx.snap());
    if coincident {
        if let (Surface::Cylinder(ca), Surface::Cylinder(cb)) = (ctx.a.surf, ctx.b.surf) {
            out.coincidence = Some(Coincidence {
                same_orientation: true,
                uv_map: Some(axial_map(ca.frame(), cb.frame(), false)),
            });
        }
        return Some(out);
    }
    for (y, contact) in pts {
        let o = f.to_world_point(Vec3::new(y.x, y.y, 0.0));
        out.feature(Carrier::Line(Line3::new(o, d).ok()?), contact);
    }
    Some(out)
}

/// Parameter map between two surfaces of revolution sharing an axis (cylinders, cones,
/// tori): `u_b = σ·u_a + φ`, `v_b = σ·v_a + offset` (`offset` only for axial `v`).
fn axial_map(fa: &Frame, fb: &Frame, angular_v: bool) -> UvAffine {
    let sigma = if fa.z().dot(fb.z()) >= 0.0 { 1.0 } else { -1.0 };
    let phi = math::atan2(fa.x().dot(fb.y()), fa.x().dot(fb.x()));
    let off = if angular_v {
        0.0
    } else {
        (fa.origin() - fb.origin()).dot(fb.z())
    };
    UvAffine {
        m: [[sigma, 0.0], [0.0, sigma]],
        c: [phi, off],
    }
}

// ---------------------------------------------------------------------------------------
// Common axis of revolution.

#[derive(Clone, Copy, Debug)]
struct Axis {
    o: Point3,
    z: Vec3,
}

fn own_axis(s: &Surface) -> Option<Axis> {
    let f = match s {
        Surface::Cylinder(c) => c.frame(),
        Surface::Cone(c) => c.frame(),
        Surface::Torus(t) => t.frame(),
        _ => return None,
    };
    Some(Axis {
        o: f.origin(),
        z: f.z(),
    })
}

/// Does `s` have `ax` as an axis of revolution (within the snap distance)?
fn revolves_about(ctx: &Ctx, s: &Surface, ax: &Axis) -> bool {
    let on_axis = |p: Point3| (p - ax.o).cross(ax.z).norm() <= ctx.snap();
    match s {
        Surface::Plane(p) => ctx.parallel(p.frame().z(), ax.z),
        Surface::Sphere(sp) => on_axis(sp.frame().origin()),
        Surface::Cylinder(_) | Surface::Cone(_) | Surface::Torus(_) => {
            let own = own_axis(s).expect("has axis");
            ctx.parallel(own.z, ax.z) && on_axis(own.o)
        }
        Surface::Helicoid(_) | Surface::BSpline(_) => false,
    }
}

/// Meridian primitives of `s` about `ax` in the full meridian plane `(ρ', h)`.
fn meridian(s: &Surface, ax: &Axis) -> Vec<Prim> {
    let h_of = |p: Point3| (p - ax.o).dot(ax.z);
    match s {
        Surface::Plane(p) => vec![Prim::Line {
            n: Vec2::new(0.0, 1.0),
            c: h_of(p.frame().origin()),
        }],
        Surface::Cylinder(c) => vec![
            Prim::Line {
                n: Vec2::new(1.0, 0.0),
                c: c.radius(),
            },
            Prim::Line {
                n: Vec2::new(-1.0, 0.0),
                c: c.radius(),
            },
        ],
        Surface::Cone(k) => {
            let sigma = if k.frame().z().dot(ax.z) >= 0.0 {
                1.0
            } else {
                -1.0
            };
            let (sa, ca) = math::sin_cos(k.half_angle());
            let ta = sa / ca;
            let ho = h_of(k.frame().origin());
            // ρ' = R + σ·tanα·(h − h_o)  ⟺  cosα·ρ' − σ·sinα·h = (R − σ·tanα·h_o)·cosα
            let c = (k.radius() - sigma * ta * ho) * ca;
            vec![
                Prim::Line {
                    n: Vec2::new(ca, -sigma * sa),
                    c,
                },
                Prim::Line {
                    n: Vec2::new(-ca, -sigma * sa),
                    c,
                },
            ]
        }
        Surface::Sphere(sp) => vec![Prim::Circle {
            c: Point2::new(0.0, h_of(sp.frame().origin())),
            r: sp.radius(),
        }],
        Surface::Torus(t) => {
            let ht = h_of(t.frame().origin());
            let near = Prim::Circle {
                c: Point2::new(t.major(), ht),
                r: t.minor(),
            };
            let far = Prim::Circle {
                c: Point2::new(-t.major(), ht),
                r: t.minor(),
            };
            match t.spindle_patch() {
                None => vec![near, far],
                Some(SpindlePatch::Outer) => vec![near],
                Some(SpindlePatch::Inner) => vec![far],
            }
        }
        Surface::Helicoid(_) | Surface::BSpline(_) => Vec::new(),
    }
}

fn revolution(ctx: &Ctx) -> Option<ExactOutcome> {
    let (a, b) = (ctx.a.surf, ctx.b.surf);
    let ax = own_axis(a)
        .or_else(|| own_axis(b))
        .or_else(|| match (a, b) {
            (Surface::Sphere(s1), Surface::Sphere(s2)) => {
                let (c1, c2) = (s1.frame().origin(), s2.frame().origin());
                let z = (c2 - c1).normalize().unwrap_or(Vec3::unit_z());
                Some(Axis { o: c1, z })
            }
            (Surface::Plane(p), Surface::Sphere(s)) | (Surface::Sphere(s), Surface::Plane(p)) => {
                Some(Axis {
                    o: s.frame().origin(),
                    z: p.frame().z(),
                })
            }
            _ => None,
        })?;
    if !(revolves_about(ctx, a, &ax) && revolves_about(ctx, b, &ax)) {
        return None;
    }
    let (ma, mb) = (meridian(a, &ax), meridian(b, &ax));
    let tol = ctx.snap();
    let mut out = ExactOutcome::new(Method::CommonAxis);
    let mut pts: Vec<(Point2, Contact)> = Vec::new();
    let mut coincident = false;
    for &pa in &ma {
        for &pb in &mb {
            let (p, c) = meet(pa, pb, tol);
            coincident |= c;
            pts.extend(p);
        }
    }
    if coincident {
        out.coincidence = Some(Coincidence {
            same_orientation: same_orientation(ctx),
            uv_map: coincident_map(a, b),
        });
        return Some(out);
    }
    // Keep ρ' >= 0 (the mirror copies are duplicates), dedupe.
    let mut kept: Vec<(Point2, Contact)> = Vec::new();
    for (y, c) in pts {
        if y.x < -tol {
            continue;
        }
        let y = Point2::new(y.x.max(0.0), y.y);
        if let Some(k) = kept.iter_mut().find(|(q, _)| q.distance(y) <= tol) {
            if c.is_tangent() {
                k.1 = c;
            }
            continue;
        }
        kept.push((y, c));
    }
    kept.sort_by(|p, q| p.0.y.total_cmp(&q.0.y).then(p.0.x.total_cmp(&q.0.x)));
    // Circle frames: CCW in a plane operand if any, else about the first own axis with
    // that surface's x axis (so its pcurve is u = t + const).
    let frame_basis: (Vec3, Vec3) = match (a, b) {
        (Surface::Plane(p), _) | (_, Surface::Plane(p)) => (p.frame().z(), p.frame().x()),
        _ => {
            let f = match (a, b) {
                (Surface::Cylinder(c), _) => *c.frame(),
                (Surface::Cone(c), _) => *c.frame(),
                (Surface::Torus(t), _) => *t.frame(),
                (_, Surface::Cylinder(c)) => *c.frame(),
                (_, Surface::Cone(c)) => *c.frame(),
                (_, Surface::Torus(t)) => *t.frame(),
                (Surface::Sphere(s), _) => {
                    let x = ax.z.any_perpendicular().unwrap_or(s.frame().x());
                    Frame::from_normal_x(Point3::zero(), ax.z, x).unwrap_or(*s.frame())
                }
                _ => return None,
            };
            (f.z(), f.x())
        }
    };
    for (y, contact) in kept {
        let centre = ax.o + ax.z * y.y;
        if y.x <= tol {
            let kind = if is_singular_point(a, centre, tol) || is_singular_point(b, centre, tol) {
                VertexKind::SurfaceSingularity
            } else {
                VertexKind::TangentPoint
            };
            out.points.push(IsoPoint {
                p: centre,
                kind,
                contact: Contact::Tangent { gap: 0.0 },
            });
            continue;
        }
        let frame = Frame::from_normal_x(centre, frame_basis.0, frame_basis.1)?;
        out.feature(Carrier::Circle(Circle3::new(frame, y.x).ok()?), contact);
    }
    Some(out)
}

/// `true` if `p` is a geometric singular point of `s` (cone apex, horn / spindle axis
/// point).
fn is_singular_point(s: &Surface, p: Point3, tol: f64) -> bool {
    match s {
        Surface::Cone(k) => k.apex().distance(p) <= tol,
        Surface::Torus(t) if t.minor() >= t.major() => {
            let l = t.frame().to_local_point(p);
            math::hypot(l.x, l.y) <= tol
        }
        _ => false,
    }
}

fn same_orientation(ctx: &Ctx) -> bool {
    let (a, b) = (ctx.a.surf, ctx.b.surf);
    let (ur, vr) = ctx.a.refs();
    let p = a.eval(ur, vr);
    let (ub, vb) = ctx.b.refs();
    let uvb = crate::func::uv_near(b, p, ub, vb);
    match (a.normal(ur, vr), b.normal(uvb.x, uvb.y)) {
        (Some(na), Some(nb)) => na.dot(nb) > 0.0,
        _ => true,
    }
}

fn coincident_map(a: &Surface, b: &Surface) -> Option<UvAffine> {
    match (a, b) {
        (Surface::Cylinder(x), Surface::Cylinder(y)) => {
            Some(axial_map(x.frame(), y.frame(), false))
        }
        (Surface::Cone(x), Surface::Cone(y)) => Some(axial_map(x.frame(), y.frame(), false)),
        (Surface::Torus(x), Surface::Torus(y)) => Some(axial_map(x.frame(), y.frame(), true)),
        (Surface::Plane(x), Surface::Plane(y)) => Some(plane_map(x, y)),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------
// Plane sections

fn plane_and<'a>(ctx: &'a Ctx) -> Option<(&'a Plane, &'a Surface)> {
    match (ctx.a.surf, ctx.b.surf) {
        (Surface::Plane(p), o) | (o, Surface::Plane(p)) if !matches!(o, Surface::Plane(_)) => {
            Some((p, o))
        }
        _ => None,
    }
}

/// Oblique plane section of a cylinder: an ellipse.
fn plane_cylinder(ctx: &Ctx) -> Option<ExactOutcome> {
    let (pl, Surface::Cylinder(cyl)) = plane_and(ctx)? else {
        return None;
    };
    let ellipse = cylinder_section(pl.frame().z(), pl.frame().origin(), cyl)?;
    let mut out = ExactOutcome::new(Method::PlaneCylinder);
    out.feature(Carrier::Ellipse(ellipse), Contact::Transversal);
    Some(out)
}

/// The ellipse cut from a cylinder by the plane through `o` with normal `n` (not
/// parallel to the axis), counter-clockwise about `n`.
fn cylinder_section(n: Vec3, o: Point3, cyl: &Cylinder) -> Option<Ellipse3> {
    let z = cyl.frame().z();
    let nz = n.dot(z);
    if nz == 0.0 {
        return None;
    }
    let oc = cyl.frame().origin();
    let centre = oc + z * (n.dot(o - oc) / nz);
    let m = z.cross(n).normalize()?;
    let r = cyl.radius();
    let frame = Frame::from_normal_x(centre, n, m)?;
    Ellipse3::new(frame, r, r / nz.abs()).ok()
}

/// Plane sections of a cone.
fn plane_cone(ctx: &Ctx) -> Option<ExactOutcome> {
    let (pl, Surface::Cone(cone)) = plane_and(ctx)? else {
        return None;
    };
    let n = pl.frame().z();
    let d = n.dot(pl.frame().origin());
    let apex = cone.apex();
    let (sa, ca) = math::sin_cos(cone.half_angle());
    let ta = sa / ca;
    let sec = ConeSection {
        frame: *cone.frame(),
        apex,
        ta,
        n,
        num: d - n.dot(apex),
    };
    let (amp, th_n, n3) = sec.nw_form();
    let mut out = ExactOutcome::new(Method::PlaneCone);
    // Angular slack equivalent to the snap distance over the problem size.
    let eps = ctx.snap() / ctx.scale;
    if sec.num.abs() <= ctx.snap() {
        // Through the apex: generators with n·w(θ) = 0.
        let w_norm = 1.0 / ca;
        let ratio = -n3 / amp.max(1e-300);
        if amp <= 0.0 || ratio.abs() > 1.0 + eps * w_norm {
            out.points.push(IsoPoint {
                p: apex,
                kind: VertexKind::SurfaceSingularity,
                contact: Contact::Tangent { gap: 0.0 },
            });
            return Some(out);
        }
        let gen_dir = |th: f64| {
            let (s, c) = math::sin_cos(th);
            cone.frame().to_world_vector(Vec3::new(ta * c, ta * s, 1.0))
        };
        if (ratio.abs() - 1.0).abs() <= eps * w_norm {
            let th = if ratio > 0.0 { th_n } else { th_n + math::PI };
            out.feature(
                Carrier::Line(Line3::new(apex, gen_dir(th)).ok()?),
                Contact::Tangent { gap: 0.0 },
            );
        } else {
            let h = math::acos(ratio);
            for th in [th_n - h, th_n + h] {
                out.feature(
                    Carrier::Line(Line3::new(apex, gen_dir(th)).ok()?),
                    Contact::Transversal,
                );
            }
        }
        return Some(out);
    }
    // Conic: ellipse when n·w keeps its sign.
    if n3.abs() > amp * (1.0 + 1e-9) {
        let v1 = sec_point(&sec, th_n);
        let v2 = sec_point(&sec, th_n + math::PI);
        let centre = v1 * 0.5 + v2 * 0.5;
        let a = 0.5 * v1.distance(v2);
        if a <= 100.0 * ctx.scale {
            let major = (v1 - v2).normalize()?;
            let m = n.cross(major).normalize()?;
            // Minor radius: the cone's algebraic form along centre + s·m is even in s.
            let q = |s: f64| {
                Surface::Cone(*cone)
                    .algebraic_form(centre + m * s)
                    .unwrap_or(f64::NAN)
            };
            let (q0, q1) = (q(0.0), q(1.0));
            let qm = q(-1.0);
            let alpha = 0.5 * (q1 + qm) - q0;
            let b2 = -q0 / alpha;
            if b2 > 0.0 {
                let frame = Frame::from_normal_x(centre, n, major)?;
                out.feature(
                    Carrier::Ellipse(Ellipse3::new(frame, a, b2.sqrt()).ok()?),
                    Contact::Transversal,
                );
                return Some(out);
            }
        }
    }
    out.feature(Carrier::Section(sec), Contact::Transversal);
    Some(out)
}

fn sec_point(s: &ConeSection, th: f64) -> Point3 {
    use crate::clip::ParamCurve;
    s.point(th)
}

/// A plane containing a torus axis: the two meridian circles.
fn plane_torus_meridian(ctx: &Ctx) -> Option<ExactOutcome> {
    let (pl, Surface::Torus(t)) = plane_and(ctx)? else {
        return None;
    };
    let n = pl.frame().z();
    let z = t.frame().z();
    let o = t.frame().origin();
    if !(ctx.perpendicular(n, z) && pl.signed_distance(o).abs() <= ctx.snap()) {
        return None;
    }
    let m = z.cross(n).normalize()?;
    let mut out = ExactOutcome::new(Method::PlaneTorusMeridian);
    for s in [1.0, -1.0] {
        let frame = Frame::from_normal_x(o + m * (s * t.major()), n, m)?;
        out.feature(
            Carrier::Circle(Circle3::new(frame, t.minor()).ok()?),
            Contact::Transversal,
        );
    }
    Some(out)
}

/// A bitangent plane of a ring torus (`R > r`): through the centre, its normal at angle
/// `asin(r/R)` to the axis. The section is the two Villarceau circles of radius `R`,
/// centred at `o ± r·a` with `a = unit(z × n)` (the line where the plane meets the
/// equatorial plane); they cross at the two points `o ± √(R² − r²)·(n × a)` where the
/// plane touches the torus.
fn plane_torus_villarceau(ctx: &Ctx) -> Option<ExactOutcome> {
    let (pl, Surface::Torus(t)) = plane_and(ctx)? else {
        return None;
    };
    let (big, small) = (t.major(), t.minor());
    if big - small <= ctx.snap() {
        return None;
    }
    let n = pl.frame().z();
    let z = t.frame().z();
    let o = t.frame().origin();
    let zn = z.cross(n);
    if pl.signed_distance(o).abs() > ctx.snap()
        || (zn.norm() - small / big).abs() * ctx.scale > ctx.snap()
    {
        return None;
    }
    let a = zn.normalize()?;
    let c = n.cross(a);
    let h = (big * big - small * small).sqrt();
    let touch = [o + c * h, o - c * h];
    let mut out = ExactOutcome::new(Method::PlaneTorusVillarceau);
    for s in [1.0, -1.0] {
        let frame = Frame::from_normal_x(o + a * (s * small), n, a)?;
        out.features.push(Feature {
            carrier: Carrier::Circle(Circle3::new(frame, big).ok()?),
            contact: Contact::Transversal,
            splits: touch.iter().map(|&p| (p, VertexKind::Singular)).collect(),
        });
    }
    Some(out)
}

/// Two cylinders of equal radius whose axes intersect: two ellipses in the bisector
/// planes, crossing at the two points where the cylinders are tangent.
fn equal_cylinders(ctx: &Ctx) -> Option<ExactOutcome> {
    let (Surface::Cylinder(c1), Surface::Cylinder(c2)) = (ctx.a.surf, ctx.b.surf) else {
        return None;
    };
    if (c1.radius() - c2.radius()).abs() > ctx.snap() {
        return None;
    }
    let (z1, z2) = (c1.frame().z(), c2.frame().z());
    let (o1, o2) = (c1.frame().origin(), c2.frame().origin());
    let perp = z1.cross(z2);
    let pn = perp.norm();
    if pn * ctx.scale <= ctx.snap() {
        return None;
    }
    // Distance between the axis lines.
    let gap = (o2 - o1).dot(perp) / pn;
    if gap.abs() > ctx.snap() {
        return None;
    }
    // Intersection point of the axes: o1 + s·z1 closest to line 2.
    let w = o1 - o2;
    let (b, d, e) = (z1.dot(z2), z1.dot(w), z2.dot(w));
    let s = (b * e - d) / (1.0 - b * b);
    let centre = o1 + z1 * s;
    let pu = perp / pn;
    let r = c1.radius();
    let touch = [centre + pu * r, centre - pu * r];
    let mut out = ExactOutcome::new(Method::EqualCylinders);
    for nrm in [z1 - z2, z1 + z2] {
        let n = nrm.normalize()?;
        let e = cylinder_section(n, centre, c1)?;
        out.features.push(Feature {
            carrier: Carrier::Ellipse(e),
            contact: Contact::Transversal,
            splits: touch.iter().map(|&p| (p, VertexKind::Singular)).collect(),
        });
    }
    Some(out)
}
