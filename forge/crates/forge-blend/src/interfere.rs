//! Certified **interference** of pairs of faces: do two trimmed faces intersect, touch or
//! come within the SSI tolerance of each other, anywhere except along what they share by
//! construction (common edges, and edges of one that lie in the other by construction)?
//!
//! A shell is only correct when its offset body neither intersects itself nor crosses the
//! input except at the openings ([`crate::shell`]); sampling points of the offset edges
//! cannot certify that (walls colliding between samples, a wall pushed through an opening).
//! This module decides it for faces on analytic surfaces with forge-ssi's certified
//! intersections and the certified parameter-plane tests of [`crate::cert2d`]:
//!
//! 1. **Boxes**: rigorous 3D boxes of both faces (the surface over the face's parameter box,
//!    itself bounded by the Bézier hulls of the loops and extended to the poles or apex the
//!    face holds, [`face_uvbox`]) must meet. The parameter box is also the domain of every
//!    intersection below, so it must hold the whole face.
//! 2. **Pierce points**: every edge of one face that is not shared is intersected with the
//!    other face's surface (`intersect_curve_surface`: certified complete, tangential
//!    contacts reported); a hit inside the other face, or on its boundary, is a contact.
//!    An edge lying in the other surface (an overlap range) is mapped into that face's
//!    parameter plane and tested against its boundary.
//! 3. **Branches**: the surfaces' intersection (`intersect_surfaces`, certified complete)
//!    is split at the shared points on it; along a piece the part inside both faces can only
//!    start or stop where a face boundary crosses the other surface (a pierce point, step 2)
//!    or at a split, so each piece is tested at its middle and quarter points (point in face
//!    with a clearance certificate on both faces). Pieces on a shared edge are skipped.
//!    Isolated tangential contact points are tested the same way. Coincident surfaces: the
//!    two faces overlap iff their boundaries meet in the common parameter plane or one
//!    contains a boundary point of the other.
//!
//! Contacts within [`JOINT`] of a shared point are ignored (the construction joins the
//! faces there). A plane and a sphere are intersected exactly (a circle), not by forge-ssi.
//! Two faces joined tangentially along what they share are decided first by the **band
//! certificate** ([`Checker::separated`]): outside a band around the shared edges (and the
//! shared points where they are tangent) every patch is certified clear — exactly in the
//! meridian plane for coaxial surfaces of revolution and against a plane by interval bounds of
//! the signed distance, otherwise by boxes — and inside it the faces are the two sides of one
//! C¹ surface (the strict form, [`Checker::band_g1`], used by shells). Anything that cannot be
//! certified is reported as [`Outcome::Unverified`]: the verification helper and the blends'
//! checks treat it as a violation; a shell reports it as `SHELL_FAILED`, never as walls
//! colliding (W6 review round 4).

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point2, Point3};
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ssi::{SsiTolerance, UvBox, intersect_curve_surface, intersect_surfaces};

use crate::cert2d::{Boundary, Inside, JOINT_BALL, Meet, pieces};
use crate::pcurve::pcurve_for;
use crate::plan::Plan;

/// Radius (mm) around a shared point within which contacts are ignored.
pub(crate) const JOINT: f64 = JOINT_BALL * LINEAR_TOLERANCE;

/// Largest angle (rad) between two faces' normals at a shared vertex for them to count as
/// tangent there: a vertex where several tangent faces meet (a shell's offset of a blended
/// corner) is placed by Gauss–Newton on nearly parallel surfaces, a few 1e-6 mm off each, so
/// its normals agree to about 1e-6 rad — not to `ANGULAR_TOLERANCE` — while a real corner
/// differs by far more. The strict band around such a point is kept within `tol/θ` of it
/// (θ the actual angle there), so that what it leaves out is at most `tol` deep (W6 review
/// round 5).
const POINT_TANGENCY: f64 = 1e-4;

/// What two faces share by construction.
#[derive(Clone, Debug, Default)]
pub(crate) struct Shared {
    /// Edges whose curves lie on both faces (not pierce-tested; branch pieces along them
    /// are skipped).
    pub edges: Vec<usize>,
    /// Points (shared vertices, ends of the shared edges) around which contacts are
    /// ignored.
    pub points: Vec<Point3>,
}

/// The result of one pair.
#[derive(Clone, Debug)]
pub(crate) enum Outcome {
    Clear,
    Hit { at: Point3, what: &'static str },
    Unverified(String),
}

pub(crate) type Box3 = (Point3, Point3);

fn box_of(pts: impl IntoIterator<Item = Point3>) -> Option<Box3> {
    let mut it = pts.into_iter();
    let first = it.next()?;
    let (mut lo, mut hi) = (first, first);
    for p in it {
        lo = lo.min_components(p);
        hi = hi.max_components(p);
    }
    Some((lo, hi))
}

fn boxes_meet(a: Box3, b: Box3, pad: f64) -> bool {
    a.0.x <= b.1.x + pad
        && b.0.x <= a.1.x + pad
        && a.0.y <= b.1.y + pad
        && b.0.y <= a.1.y + pad
        && a.0.z <= b.1.z + pad
        && b.0.z <= a.1.z + pad
}

/// A rigorous box of an edge curve over its range.
fn curve_box(c: &Curve3, r: (f64, f64)) -> Option<Box3> {
    match c {
        Curve3::Line(_) => box_of([c.eval(r.0), c.eval(r.1)]),
        Curve3::Circle(k) => {
            let (o, z, rad) = (k.frame().origin(), k.frame().z(), k.radius());
            let ext = |zi: f64| rad * (1.0 - zi * zi).max(0.0).sqrt();
            let e = Point3::new(ext(z.x), ext(z.y), ext(z.z));
            Some((o - e, o + e))
        }
        Curve3::Ellipse(el) => {
            let f = el.frame();
            let (x, y) = (f.x() * el.rx(), f.y() * el.ry());
            let h = forge_core::math::hypot;
            let e = Point3::new(h(x.x, y.x), h(x.y, y.y), h(x.z, y.z));
            Some((f.origin() - e, f.origin() + e))
        }
        Curve3::BSpline(n) => box_of(
            n.control_points()
                .iter()
                .map(|p| Point3::new(p[0], p[1], p[2])),
        ),
    }
}

/// A rigorous box of `surf` over the parameter box `b`.
fn surface_box(surf: &Surface, b: &UvBox) -> Option<Box3> {
    let (u0, u1) = b.u;
    let (v0, v1) = b.v;
    let local = |fr: &forge_core::linalg::Frame, x: f64, y: f64, z0: f64, z1: f64| {
        let mut pts = Vec::with_capacity(8);
        for sx in [-x, x] {
            for sy in [-y, y] {
                for sz in [z0, z1] {
                    pts.push(fr.to_world_point(Point3::new(sx, sy, sz)));
                }
            }
        }
        box_of(pts)
    };
    match surf {
        Surface::Plane(_) => box_of([
            surf.eval(u0, v0),
            surf.eval(u1, v0),
            surf.eval(u0, v1),
            surf.eval(u1, v1),
        ]),
        Surface::Cylinder(c) => local(c.frame(), c.radius(), c.radius(), v0, v1),
        Surface::Cone(c) => {
            let r = c.radius_at(v0).abs().max(c.radius_at(v1).abs());
            local(c.frame(), r, r, v0, v1)
        }
        Surface::Sphere(s) => {
            let r = s.radius();
            local(
                s.frame(),
                r,
                r,
                r * forge_core::math::sin(v0),
                r * forge_core::math::sin(v1),
            )
        }
        Surface::Torus(t) => {
            let r = t.major() + t.minor();
            local(t.frame(), r, r, -t.minor(), t.minor())
        }
        Surface::BSpline(n) => box_of(n.control_points().iter().copied()),
    }
}

/// `[min, max]` of `cos` (`sin`: shifted by −π/2) over `[a, b]`.
pub(crate) fn cos_range(a: f64, b: f64) -> (f64, f64) {
    let (ca, cb) = (forge_core::math::cos(a), forge_core::math::cos(b));
    let (mut lo, mut hi) = (ca.min(cb), ca.max(cb));
    let pi = forge_core::math::PI;
    // Extremes at multiples of π inside the range.
    let k0 = (a / pi).ceil() as i64;
    let k1 = (b / pi).floor() as i64;
    for k in k0..=k1 {
        if k.rem_euclid(2) == 0 {
            hi = 1.0;
        } else {
            lo = -1.0;
        }
    }
    (lo, hi)
}

fn sin_range(a: f64, b: f64) -> (f64, f64) {
    let h = forge_core::math::FRAC_PI_2;
    cos_range(a - h, b - h)
}

/// The box of the annular sector `{ρ·(cos u, sin u)}`, `ρ ∈ [r0, r1]`, `u ∈ [u0, u1]`.
fn sector(r0: f64, r1: f64, u0: f64, u1: f64) -> (f64, f64, f64, f64) {
    let (c0, c1) = cos_range(u0, u1);
    let (s0, s1) = sin_range(u0, u1);
    let xs = [r0 * c0, r0 * c1, r1 * c0, r1 * c1];
    let ys = [r0 * s0, r0 * s1, r1 * s0, r1 * s1];
    let mn = |v: &[f64]| v.iter().copied().fold(f64::INFINITY, f64::min);
    let mx = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (mn(&xs), mx(&xs), mn(&ys), mx(&ys))
}

/// A rigorous (and, for small patches, tight) box of `surf` over the parameter box `b`: the
/// surfaces of revolution as annular sectors swept over their height range, in the local
/// frame, mapped to the world (a slight overestimate, never an underestimate).
fn patch_box(surf: &Surface, b: &UvBox) -> Option<Box3> {
    let (u0, u1) = b.u;
    let (v0, v1) = b.v;
    let world = |fr: &forge_core::linalg::Frame, sx: (f64, f64, f64, f64), z0: f64, z1: f64| {
        let mut pts = Vec::with_capacity(8);
        for x in [sx.0, sx.1] {
            for y in [sx.2, sx.3] {
                for z in [z0, z1] {
                    pts.push(fr.to_world_point(Point3::new(x, y, z)));
                }
            }
        }
        box_of(pts)
    };
    match surf {
        Surface::Plane(_) => box_of([
            surf.eval(u0, v0),
            surf.eval(u1, v0),
            surf.eval(u0, v1),
            surf.eval(u1, v1),
        ]),
        Surface::Cylinder(c) => world(c.frame(), sector(c.radius(), c.radius(), u0, u1), v0, v1),
        Surface::Cone(c) => {
            let (ra, rb) = (c.radius_at(v0), c.radius_at(v1));
            if ra < 0.0 || rb < 0.0 {
                return surface_box(surf, b);
            }
            world(c.frame(), sector(ra.min(rb), ra.max(rb), u0, u1), v0, v1)
        }
        Surface::Sphere(s) => {
            let r = s.radius();
            let (c0, c1) = cos_range(v0, v1);
            let (s0, s1) = sin_range(v0, v1);
            world(
                s.frame(),
                sector(r * c0.max(0.0), r * c1, u0, u1),
                r * s0,
                r * s1,
            )
        }
        Surface::Torus(t) => {
            let (c0, c1) = cos_range(v0, v1);
            let (s0, s1) = sin_range(v0, v1);
            let (ra, rb) = (t.major() + t.minor() * c0, t.major() + t.minor() * c1);
            if ra < 0.0 {
                return surface_box(surf, b);
            }
            world(
                t.frame(),
                sector(ra, rb, u0, u1),
                t.minor() * s0,
                t.minor() * s1,
            )
        }
        Surface::BSpline(_) => surface_box(surf, b),
    }
}

/// The angle in `[a0, a1]` nearest `t` (periodically).
fn clamp_angle(t: f64, a0: f64, a1: f64) -> f64 {
    let tau = forge_core::math::TAU;
    if a1 - a0 >= tau {
        return t;
    }
    let x = a0 + forge_core::math::rem_euclid(t - a0, tau);
    if x <= a1 {
        return x;
    }
    // Past the end: the nearer of the two ends going round.
    if x - a1 <= a0 + tau - x { a1 } else { a0 }
}

/// The exact distance from `x` to the patch of `s` over the parameter box `b` (`None` for
/// cones and B-splines). Planes: the rectangle; cylinders, spheres and tori: the nearest
/// angle about the axis is the clamped one (the rest of the distance does not depend on
/// it), then the nearest point of the clamped height, latitude or tube arc.
fn patch_dist(s: &Surface, b: &UvBox, x: Point3) -> Option<f64> {
    let clamp = |t: f64, lo: f64, hi: f64| t.max(lo).min(hi);
    match s {
        Surface::Plane(p) => {
            let l = p.frame().to_local_point(x);
            let dx = l.x - clamp(l.x, b.u.0, b.u.1);
            let dy = l.y - clamp(l.y, b.v.0, b.v.1);
            Some((dx * dx + dy * dy + l.z * l.z).sqrt())
        }
        Surface::Cylinder(c) => {
            let l = c.frame().to_local_point(x);
            let (rho, th) = (
                forge_core::math::hypot(l.x, l.y),
                forge_core::math::atan2(l.y, l.x),
            );
            let u = clamp_angle(th, b.u.0, b.u.1);
            let r = c.radius();
            let h2 = (rho * rho + r * r - 2.0 * rho * r * forge_core::math::cos(th - u)).max(0.0);
            let dz = l.z - clamp(l.z, b.v.0, b.v.1);
            Some((h2 + dz * dz).sqrt())
        }
        Surface::Sphere(sp) => {
            let l = sp.frame().to_local_point(x);
            let (rho, th) = (
                forge_core::math::hypot(l.x, l.y),
                forge_core::math::atan2(l.y, l.x),
            );
            let u = clamp_angle(th, b.u.0, b.u.1);
            let rp = rho * forge_core::math::cos(th - u);
            let v = clamp(forge_core::math::atan2(l.z, rp), b.v.0, b.v.1);
            let r = sp.radius();
            let dot = rp * forge_core::math::cos(v) + l.z * forge_core::math::sin(v);
            Some((l.norm_squared() + r * r - 2.0 * r * dot).max(0.0).sqrt())
        }
        Surface::Torus(t) if t.spindle_patch() != Some(forge_core::geom::SpindlePatch::Inner) => {
            let l = t.frame().to_local_point(x);
            let (rho, th) = (
                forge_core::math::hypot(l.x, l.y),
                forge_core::math::atan2(l.y, l.x),
            );
            let u = clamp_angle(th, b.u.0, b.u.1);
            let (su, cu) = forge_core::math::sin_cos(th - u);
            // In the meridian half-plane at u: the point (ρ cos, z), out of it by ρ sin.
            let (qx, qz) = (rho * cu, l.z);
            let (big, r) = (t.major(), t.minor());
            let at = |v: f64| {
                let (sv, cv) = forge_core::math::sin_cos(v);
                forge_core::math::hypot(qx - big - r * cv, qz - r * sv)
            };
            let phi = forge_core::math::atan2(qz, qx - big);
            let v = clamp_angle(phi, b.v.0, b.v.1);
            let d2 = at(v).min(at(b.v.0)).min(at(b.v.1));
            Some(forge_core::math::hypot(rho * su, d2))
        }
        _ => None,
    }
}

/// The `v` parameters of a surface's **singular points** — a sphere's poles, a cone's apex,
/// the axis points of a spindle-torus patch: each is a whole line `v = const` of the
/// parameter plane mapped to one point, so a face can hold one with no loop reaching it in
/// `(u, v)` (a spherical cap bounded by its rim circle, a drill point bounded by its rim).
fn singular_vs(surf: &Surface) -> Vec<f64> {
    match surf {
        Surface::Sphere(_) => vec![-forge_core::math::FRAC_PI_2, forge_core::math::FRAC_PI_2],
        Surface::Cone(c) => vec![c.apex_v()],
        Surface::Torus(t) => t
            .spindle_v_range()
            .map(|(a, b)| vec![a, b])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The parameter box of a face: the box of its boundary's Bézier hulls, padded, clamped to
/// the surface's parameter range (a whole period where the loops span one), and extended to
/// every **singular point** of the surface the face holds ([`singular_vs`]; W6 review round
/// 3: a cap's pole or a cone's apex lies outside its loops' box). No boundary lies between
/// the loops' box and a singular line `v = s` outside it, so the whole strip is in the face
/// or none of it: a point of the strip decides, and an uncertain answer extends the box.
/// Sound: every point of the face has its parameters in the box (a whole face without loops
/// — a closed void — gets the surface's natural domain).
pub(crate) fn face_uvbox(plan: &Plan, f: usize) -> Option<UvBox> {
    let face = plan.fs[f].as_ref()?;
    let surf = &face.surf;
    if face.loops.is_empty() {
        return Some(UvBox::natural(surf, 1e6));
    }
    let mut lo = Point2::new(f64::INFINITY, f64::INFINITY);
    let mut hi = Point2::new(f64::NEG_INFINITY, f64::NEG_INFINITY);
    for lp in &face.loops {
        for u in lp {
            let e = &plan.es[u.edge];
            for b in pieces(u.pc.as_ref()?, e.range, u.fwd)? {
                let (l, h) = b.bbox();
                lo = Point2::new(lo.x.min(l.x), lo.y.min(l.y));
                hi = Point2::new(hi.x.max(h.x), hi.y.max(h.y));
            }
        }
    }
    let (pu, pv) = surf.periodicity();
    let ((nu0, nu1), (nv0, nv1)) = surf.domain();
    let range = |lo: f64, hi: f64, per: Option<f64>, n0: f64, n1: f64| -> (f64, f64) {
        let pad = 1e-6 * (1.0 + lo.abs().max(hi.abs()) + (hi - lo));
        match per {
            Some(p) => {
                if hi - lo + 2.0 * pad >= p {
                    (lo, lo + p)
                } else {
                    (lo - pad, hi + pad)
                }
            }
            None => {
                let a = if n0.is_finite() {
                    (lo - pad).max(n0)
                } else {
                    lo - pad
                };
                let b = if n1.is_finite() {
                    (hi + pad).min(n1)
                } else {
                    hi + pad
                };
                (a, b)
            }
        }
    };
    let (u0, u1) = range(lo.x, hi.x, pu, nu0, nu1);
    let (mut v0, mut v1) = range(lo.y, hi.y, pv, nv0, nv1);
    let sing = singular_vs(surf);
    if !sing.is_empty() {
        let bnd = Boundary::of_face(plan, f);
        for s in sing {
            if s >= v0 && s <= v1 {
                continue;
            }
            let probe = if s > v1 {
                0.5 * (v1 + s)
            } else {
                0.5 * (v0 + s)
            };
            let inside = bnd
                .as_ref()
                .and_then(|b| b.contains(Point2::new(0.5 * (u0 + u1), probe)));
            if inside != Some(false) {
                if s > v1 {
                    v1 = s;
                } else {
                    v0 = s;
                }
            }
        }
    }
    Some(UvBox::new(u0, u1, v0, v1))
}

/// A rigorous 3D box of face `f` (its surface over [`face_uvbox`]); `None` when the face's
/// boundary cannot be bounded (a use without a pcurve).
pub(crate) fn face_box(plan: &Plan, f: usize) -> Option<Box3> {
    let b = face_uvbox(plan, f)?;
    surface_box(&plan.fs[f].as_ref()?.surf, &b)
}

/// Interference tests on the faces of a plan (see the module docs).
pub(crate) struct Checker<'a> {
    plan: &'a Plan,
    bnd: Vec<Option<Boundary>>,
    uvbox: Vec<Option<UvBox>>,
    fbox: Vec<Option<Box3>>,
    tol: SsiTolerance,
    /// Verification helper only ([`crate::self_intersections`]): where forge-ssi cannot
    /// resolve two faces tangent along a shared edge (a blend and its neighbour), certify them
    /// apart outside a band around the shared edges instead ([`Checker::separated`]).
    pub tangent_band: bool,
    /// Shells (W6 review round 4): two faces **tangent** (G1) along every edge and at every
    /// point they share — the offsets of a blend and its neighbours — are decided by the band
    /// certificate first ([`Checker::separated`]), in its strict form: a band at most half the
    /// smallest curvature radius of either face, skipping a patch only where it is also near
    /// what they share in the parameter plane (see [`Checker::separated`] for why that is
    /// sound).
    pub band_g1: bool,
    /// Point-in-face and boundary tests that could not be certified (W6 review round 5):
    /// each counts as "not in" so that the scan goes on to a proven contact, and a pair whose
    /// tests find none but left one of these undecided is [`Outcome::Unverified`] — never
    /// counted as a contact, never as clear.
    undecided: std::cell::Cell<u32>,
}

impl<'a> Checker<'a> {
    /// A checker for the faces `faces` of `plan` (pcurves filled).
    pub fn new(plan: &'a Plan, faces: &[usize]) -> Self {
        let n = plan.fs.len();
        let mut bnd = vec![None; n];
        let mut uvbox = vec![None; n];
        let mut fbox = vec![None; n];
        for &f in faces {
            bnd[f] = Boundary::of_face(plan, f);
            uvbox[f] = face_uvbox(plan, f);
            fbox[f] = match (&plan.fs[f], &uvbox[f]) {
                (Some(pf), Some(b)) => surface_box(&pf.surf, b),
                _ => None,
            };
        }
        Checker {
            plan,
            bnd,
            uvbox,
            fbox,
            tol: SsiTolerance {
                fit: LINEAR_TOLERANCE,
                ..SsiTolerance::default()
            },
            tangent_band: false,
            band_g1: false,
            undecided: std::cell::Cell::new(0),
        }
    }

    /// The edges and vertices faces `a` and `b` share in the plan's topology.
    pub fn topo_shared(&self, a: usize, b: usize) -> Shared {
        let edges_of = |f: usize| -> Vec<usize> {
            self.plan.fs[f]
                .as_ref()
                .map(|x| x.loops.iter().flatten().map(|u| u.edge).collect())
                .unwrap_or_default()
        };
        let verts_of = |es: &[usize]| -> Vec<usize> {
            let mut v: Vec<usize> = es
                .iter()
                .flat_map(|&e| [self.plan.es[e].start, self.plan.es[e].end])
                .flatten()
                .collect();
            v.sort_unstable();
            v.dedup();
            v
        };
        let (ea, eb) = (edges_of(a), edges_of(b));
        let mut edges: Vec<usize> = ea.iter().copied().filter(|e| eb.contains(e)).collect();
        edges.sort_unstable();
        edges.dedup();
        let (va, vb) = (verts_of(&ea), verts_of(&eb));
        let points = va
            .iter()
            .filter(|v| vb.contains(v))
            .map(|&v| self.plan.vs[v].p)
            .collect();
        Shared { edges, points }
    }

    fn near_shared(&self, x: Point3, sh: &Shared) -> bool {
        sh.points.iter().any(|p| p.distance(x) <= JOINT)
    }

    fn on_shared_edge(&self, x: Point3, sh: &Shared) -> bool {
        sh.edges.iter().any(|&e| {
            let pe = &self.plan.es[e];
            let (t, d) = pe.curve.project(x);
            if d > 10.0 * LINEAR_TOLERANCE {
                return false;
            }
            let t = into_range(t, pe.range, pe.curve.period());
            let slack = 1e-9 * (1.0 + pe.range.0.abs().max(pe.range.1.abs()));
            t >= pe.range.0 - slack && t <= pe.range.1 + slack
        })
    }

    /// Is `uv` in face `f`, its boundary included (within about the face's tolerance)?
    /// An answer that cannot be certified is `false` and recorded as undecided (see
    /// [`Checker::undecided`]; W6 review round 5).
    fn maybe_in(&self, f: usize, uv: Point2) -> bool {
        match self.bnd[f].as_ref().map(|b| b.contains_ex(uv)) {
            Some(Inside::In | Inside::Boundary) => true,
            Some(Inside::Out) => false,
            Some(Inside::Unknown) | None => {
                self.undecided.set(self.undecided.get() + 1);
                false
            }
        }
    }

    /// Does `other` come near the boundary of face `f` (see [`Boundary::meets_curve`])? An
    /// unresolved answer is `false` and recorded as undecided.
    fn meets_boundary(
        &self,
        b: &Boundary,
        other: &[crate::cert2d::Bez],
        balls: &[(Point2, f64)],
    ) -> bool {
        match b.meets_curve(other, balls) {
            Meet::Near => true,
            Meet::Apart => false,
            Meet::Unresolved => {
                self.undecided.set(self.undecided.get() + 1);
                false
            }
        }
    }

    /// Faces `p` and `q` (see the module docs): a contact found by certified tests
    /// ([`Outcome::Hit`]); none, with every test certified ([`Outcome::Clear`]); or none but
    /// a test left undecided ([`Outcome::Unverified`]).
    pub fn pair(&self, p: usize, q: usize, sh: &Shared) -> Outcome {
        let before = self.undecided.get();
        match self.pair_tests(p, q, sh) {
            Outcome::Clear if self.undecided.get() > before => Outcome::Unverified(
                "a point-in-face or boundary test could not be certified".into(),
            ),
            other => other,
        }
    }

    /// The tests of [`Checker::pair`].
    fn pair_tests(&self, p: usize, q: usize, sh: &Shared) -> Outcome {
        let (Some(bp), Some(bq)) = (self.fbox[p], self.fbox[q]) else {
            return Outcome::Unverified("a face's parameter box could not be bounded".into());
        };
        if !boxes_meet(bp, bq, 10.0 * LINEAR_TOLERANCE) {
            return Outcome::Clear;
        }
        if self.bnd[p].is_none() || self.bnd[q].is_none() {
            return Outcome::Unverified("a face boundary could not be converted".into());
        }
        for (a, b) in [(p, q), (q, p)] {
            let mut seen: Vec<usize> = Vec::new();
            for u in self.plan.fs[a]
                .as_ref()
                .expect("face")
                .loops
                .iter()
                .flatten()
            {
                if seen.contains(&u.edge) || sh.edges.contains(&u.edge) {
                    continue;
                }
                seen.push(u.edge);
                match self.pierce(u.edge, b, sh) {
                    Outcome::Clear => {}
                    other => return other,
                }
            }
        }
        self.surfaces(p, q, sh)
    }

    /// Edge `e` against face `q` (step 2).
    fn pierce(&self, e: usize, q: usize, sh: &Shared) -> Outcome {
        let pe = &self.plan.es[e];
        let (Some(eb), Some(qb)) = (curve_box(&pe.curve, pe.range), self.fbox[q]) else {
            return Outcome::Unverified("an edge could not be bounded".into());
        };
        if !boxes_meet(eb, qb, 10.0 * LINEAR_TOLERANCE) {
            return Outcome::Clear;
        }
        let qf = self.plan.fs[q].as_ref().expect("face");
        let dom = self.uvbox[q].expect("box");
        let hits = match intersect_curve_surface(&pe.curve, pe.range, &qf.surf, dom, &self.tol) {
            Ok(h) => h,
            Err(err) => {
                return Outcome::Unverified(format!(
                    "an edge–surface intersection ({})",
                    err.code()
                ));
            }
        };
        for h in &hits.points {
            if self.near_shared(h.point, sh) {
                continue;
            }
            if h.contact.is_tangent() {
                // A tangential root's enclosure may be wide: ignore it when it holds a
                // shared point.
                let (t0, t1) = h.certificate.t_enclosure;
                let holds = sh.points.iter().any(|&x| {
                    let (t, d) = pe.curve.project(x);
                    let t = into_range(t, pe.range, pe.curve.period());
                    d <= JOINT && t >= t0 - 1e-12 && t <= t1 + 1e-12
                });
                if holds {
                    continue;
                }
            }
            if self.maybe_in(q, h.uv) {
                return Outcome::Hit {
                    at: h.point,
                    what: "an edge pierces a face",
                };
            }
        }
        // The longest range a curved edge can stay within `fit` of a surface it only touches:
        // `2·√(2ρ·fit)` for curvature radii up to `ρ` (curve and surface), doubled.
        let radius = |c: &Curve3| match c {
            Curve3::Circle(k) => Some(k.radius()),
            Curve3::Ellipse(e) => {
                let (a, b) = (e.rx().max(e.ry()), e.rx().min(e.ry()));
                Some(a * a / b)
            }
            // A line touching a curved surface separates from it at the surface's curvature.
            Curve3::Line(_) => Some(0.0),
            _ => None,
        };
        let surf_r = match &qf.surf {
            Surface::Cylinder(c) => c.radius(),
            Surface::Sphere(x) => x.radius(),
            Surface::Torus(t) => t.major() + t.minor(),
            Surface::Cone(c) => c.radius_at(dom.v.0).abs().max(c.radius_at(dom.v.1).abs()),
            _ => 0.0,
        };
        let touch_len =
            radius(&pe.curve).map(|r| 4.0 * (2.0 * r.max(surf_r).max(1.0) * self.tol.fit).sqrt());
        for ov in &hits.overlaps {
            // A short range around a shared point is a curved edge touching the surface there
            // tangentially (as a tangential root's enclosure would be), not lying in it.
            let chord = pe
                .curve
                .eval(ov.t_range.0)
                .distance(pe.curve.eval(ov.t_range.1));
            let holds = touch_len.is_some_and(|len| chord <= len)
                && sh.points.iter().any(|&x| {
                    let (t, d) = pe.curve.project(x);
                    let t = into_range(t, pe.range, pe.curve.period());
                    let slack = 1e-12 * (1.0 + t.abs());
                    d <= JOINT && t >= ov.t_range.0 - slack && t <= ov.t_range.1 + slack
                });
            if holds {
                continue;
            }
            let short = touch_len.is_some_and(|len| chord <= len);
            match self.curve_in_face(&pe.curve, ov.t_range, q, sh, short) {
                Outcome::Clear => {}
                other => return other,
            }
        }
        Outcome::Clear
    }

    /// A curve lying in face `q`'s surface over `r`: does it enter the face? `short`: the
    /// range is no longer than a curve touching the surface tangentially stays within the
    /// tolerance of it — when no pcurve follows it there (it touches rather than lies in the
    /// surface: a corner patch's arc touching a side face at its foot, W6 review round 3),
    /// its ends and middle are tested as contact points.
    fn curve_in_face(
        &self,
        c: &Curve3,
        r: (f64, f64),
        q: usize,
        sh: &Shared,
        short: bool,
    ) -> Outcome {
        let qf = self.plan.fs[q].as_ref().expect("face");
        let Some(bq) = &self.bnd[q] else {
            return Outcome::Unverified("a face boundary could not be converted".into());
        };
        if r.1 - r.0 <= 1e-12 * (1.0 + r.0.abs()) {
            let x = c.eval(0.5 * (r.0 + r.1));
            if self.near_shared(x, sh) {
                return Outcome::Clear;
            }
            let (u, v, _) = qf.surf.project(x);
            return if self.maybe_in(q, Point2::new(u, v)) {
                Outcome::Hit {
                    at: x,
                    what: "an edge touches a face",
                }
            } else {
                Outcome::Clear
            };
        }
        let Ok((pc, _)) = pcurve_for(&qf.surf, c, r, None) else {
            if !short {
                return Outcome::Unverified("an edge lying in a face's surface".into());
            }
            // Next to a shared point (within twice its own length) it is the joint's
            // tangential contact, which the construction makes.
            let len = c.eval(r.0).distance(c.eval(r.1));
            let ends = [c.eval(r.0), c.eval(r.1)];
            if sh
                .points
                .iter()
                .any(|p| ends.iter().any(|x| x.distance(*p) <= 2.0 * len + JOINT))
            {
                return Outcome::Clear;
            }
            for t in [r.0, 0.5 * (r.0 + r.1), r.1] {
                let x = c.eval(t);
                if self.near_shared(x, sh) {
                    continue;
                }
                let (u, v, _) = qf.surf.project(x);
                if self.maybe_in(q, Point2::new(u, v)) {
                    return Outcome::Hit {
                        at: x,
                        what: "an edge touches a face",
                    };
                }
            }
            return Outcome::Clear;
        };
        let Some(ps) = pieces(&pc, r, true) else {
            return Outcome::Unverified("an edge lying in a face's surface".into());
        };
        let balls: Vec<(Point2, f64)> = sh
            .points
            .iter()
            .map(|&x| {
                let (u, v, _) = qf.surf.project(x);
                (Point2::new(u, v), JOINT_BALL * bq.tol)
            })
            .collect();
        let at = c.eval(0.5 * (r.0 + r.1));
        if self.meets_boundary(bq, &ps, &balls) {
            return Outcome::Hit {
                at,
                what: "an edge runs into a face",
            };
        }
        if !self.near_shared(at, sh) && self.maybe_in(q, pc.eval(0.5 * (r.0 + r.1))) {
            return Outcome::Hit {
                at,
                what: "an edge lies in a face",
            };
        }
        Outcome::Clear
    }

    /// Step 3: the surfaces' intersection.
    fn surfaces(&self, p: usize, q: usize, sh: &Shared) -> Outcome {
        let (pf, qf) = (
            self.plan.fs[p].as_ref().expect("face"),
            self.plan.fs[q].as_ref().expect("face"),
        );
        let (dp, dq) = (self.uvbox[p].expect("box"), self.uvbox[q].expect("box"));
        // forge-ssi can fail to converge where a branch leaves the parameter box at a
        // near-tangency with `fit = 1e-6` and still certify the pair with its default
        // (tighter) tolerance: retry with it before giving up.
        // The verification helper: two faces joined tangentially (G1) along a shared edge — a
        // blend continuing into the next one of its tangent chain — meet tangentially along
        // it, where forge-ssi is slow (seconds per pair) or fails; the band certificate below
        // decides them first, and the intersection only when it cannot.
        let banded = if self.tangent_band {
            !sh.edges.is_empty() && self.g1_joined(p, q, sh)
        } else {
            self.band_g1
                && !(sh.edges.is_empty() && sh.points.is_empty())
                && self.g1_joined(p, q, sh)
                && self.tangent_at_points(p, q, sh)
        };
        if banded && self.separated(p, q, sh) {
            return Outcome::Clear;
        }
        if let Some(o) = self.plane_sphere(p, q, sh) {
            return o;
        }
        let first = intersect_surfaces(&pf.surf, dp, &qf.surf, dq, &self.tol)
            .or_else(|_| intersect_surfaces(&pf.surf, dp, &qf.surf, dq, &SsiTolerance::default()));
        let g = match first {
            Ok(g) => g,
            Err(err) => {
                // Faces that share nothing may still be certified apart by their patches;
                // the verification helper also accepts faces apart outside a band around
                // their shared edges.
                let alone = sh.edges.is_empty() && sh.points.is_empty();
                if (alone || (self.tangent_band && !(sh.edges.is_empty() && sh.points.is_empty())))
                    && self.separated(p, q, sh)
                {
                    return Outcome::Clear;
                }
                return Outcome::Unverified(format!(
                    "a surface–surface intersection ({})",
                    err.code()
                ));
            }
        };
        if !g.certified_complete {
            // As for a failed intersection: the verification helper certifies tangent
            // neighbours apart outside the band around what they share.
            if self.tangent_band
                && !(sh.edges.is_empty() && sh.points.is_empty())
                && self.separated(p, q, sh)
            {
                return Outcome::Clear;
            }
            return Outcome::Unverified("a surface–surface intersection (not certified)".into());
        }
        if g.coincidence.is_some() {
            return self.coincident(p, q, sh);
        }
        for br in &g.branches {
            let mut cuts = vec![br.range.0, br.range.1];
            for &x in &sh.points {
                let (t, d) = br.curve.project(x);
                if d <= JOINT {
                    let t = into_range(t, br.range, br.curve.period());
                    if t > br.range.0 && t < br.range.1 {
                        cuts.push(t);
                    }
                }
            }
            cuts.sort_by(f64::total_cmp);
            cuts.dedup();
            for w in cuts.windows(2) {
                let (a, b) = (w[0], w[1]);
                if b - a <= 1e-12 * (1.0 + a.abs().max(b.abs())) {
                    continue;
                }
                for frac in [0.5, 0.25, 0.75] {
                    let t = a + (b - a) * frac;
                    let x = br.curve.eval(t);
                    if self.near_shared(x, sh) || self.on_shared_edge(x, sh) {
                        continue;
                    }
                    if self.maybe_in(p, br.pcurve_a.eval(t))
                        && self.maybe_in(q, br.pcurve_b.eval(t))
                    {
                        return Outcome::Hit {
                            at: x,
                            what: "two faces intersect",
                        };
                    }
                }
            }
        }
        for v in g.tangent_points() {
            if self.near_shared(v.point, sh) || self.on_shared_edge(v.point, sh) {
                continue;
            }
            if self.maybe_in(p, v.uv_a) && self.maybe_in(q, v.uv_b) {
                return Outcome::Hit {
                    at: v.point,
                    what: "two faces touch",
                };
            }
        }
        Outcome::Clear
    }

    /// A plane and a sphere meet exactly in a circle, a point or nothing: forge-ssi marches
    /// the circle in the sphere's parameters and can fail where it runs through one of their
    /// poles (a shell's lateral rim through a corner sphere's centre and pole, W6 review round
    /// 4). The circle is cut at the shared points and each piece tested at its middle and
    /// quarter points, as a branch is ([`Checker::surfaces`]), however small it is; a plane
    /// that touches the sphere or misses it by at most `10·tol` is tested at the foot of the
    /// centre (the closest points). `None` for other pairs.
    fn plane_sphere(&self, p: usize, q: usize, sh: &Shared) -> Option<Outcome> {
        let (pf, qf) = (
            self.plan.fs[p].as_ref().expect("face"),
            self.plan.fs[q].as_ref().expect("face"),
        );
        let (pl, sp, ip, is) = match (&pf.surf, &qf.surf) {
            (Surface::Plane(a), Surface::Sphere(b)) => (a, b, p, q),
            (Surface::Sphere(b), Surface::Plane(a)) => (a, b, q, p),
            _ => return None,
        };
        let (plane_s, sphere_s) = (
            &self.plan.fs[ip].as_ref().expect("face").surf,
            &self.plan.fs[is].as_ref().expect("face").surf,
        );
        let n = pl.frame().z();
        let c = sp.frame().origin();
        let d = (c - pl.frame().origin()).dot(n);
        let r = sp.radius();
        let tol = 10.0 * LINEAR_TOLERANCE;
        if d.abs() > r + tol {
            return Some(Outcome::Clear);
        }
        let foot = c - n * d;
        let inside = |x: Point3| {
            let (u, v, _) = plane_s.project(x);
            let (a, b, _) = sphere_s.project(x);
            self.maybe_in(ip, Point2::new(u, v)) && self.maybe_in(is, Point2::new(a, b))
        };
        // Touching or apart by at most `tol`: the closest points are at the foot. Where the
        // surfaces do intersect, however little, their contact circle is tested like any
        // other (W6 review round 5: within `tol` of tangency only the foot was).
        if d.abs() >= r {
            if self.near_shared(foot, sh) || self.on_shared_edge(foot, sh) || !inside(foot) {
                return Some(Outcome::Clear);
            }
            return Some(Outcome::Hit {
                at: foot,
                what: "two faces touch",
            });
        }
        let rho = (r * r - d * d).sqrt();
        let circle =
            Curve3::Circle(forge_core::geom::Circle3::new(pl.frame().with_origin(foot), rho).ok()?);
        let tau = forge_core::math::TAU;
        let mut cuts = vec![0.0, tau];
        for &x in &sh.points {
            let (t, dist) = circle.project(x);
            if dist <= JOINT {
                cuts.push(forge_core::math::rem_euclid(t, tau));
            }
        }
        cuts.sort_by(f64::total_cmp);
        cuts.dedup();
        for w in cuts.windows(2) {
            let (a, b) = (w[0], w[1]);
            if b - a <= 1e-12 {
                continue;
            }
            for frac in [0.5, 0.25, 0.75] {
                let x = circle.eval(a + (b - a) * frac);
                if self.near_shared(x, sh) || self.on_shared_edge(x, sh) {
                    continue;
                }
                if inside(x) {
                    return Some(Outcome::Hit {
                        at: x,
                        what: "two faces intersect",
                    });
                }
            }
        }
        Some(Outcome::Clear)
    }

    /// The largest angle (its sine) between the outward normals of faces `p` and `q` at the
    /// points they share (0 without shared points; 1 where a normal is undefined).
    fn point_angle(&self, p: usize, q: usize, sh: &Shared) -> f64 {
        let (fp, fq) = (
            self.plan.fs[p].as_ref().expect("face"),
            self.plan.fs[q].as_ref().expect("face"),
        );
        let normal = |f: &crate::plan::PF, x: Point3| {
            let (u, v, _) = f.surf.project(x);
            f.surf.normal(u, v).map(|n| if f.sense { n } else { -n })
        };
        sh.points
            .iter()
            .map(|&x| match (normal(fp, x), normal(fq, x)) {
                (Some(a), Some(b)) => a.cross(b).norm(),
                _ => 1.0,
            })
            .fold(0.0, f64::max)
    }

    /// Are faces `p` and `q` tangent at every point they share (outward normals pointing the
    /// same way, parallel within [`POINT_TANGENCY`])?
    fn tangent_at_points(&self, p: usize, q: usize, sh: &Shared) -> bool {
        let (fp, fq) = (
            self.plan.fs[p].as_ref().expect("face"),
            self.plan.fs[q].as_ref().expect("face"),
        );
        // Outward normals: two faces joined tangentially in a solid have the **same**
        // outward normal there; opposite ones are a fold (a knife edge), not a tangency.
        let normal = |f: &crate::plan::PF, x: Point3| {
            let (u, v, _) = f.surf.project(x);
            f.surf.normal(u, v).map(|n| if f.sense { n } else { -n })
        };
        sh.points
            .iter()
            .all(|&x| match (normal(fp, x), normal(fq, x)) {
                (Some(a), Some(b)) => a.dot(b) > 0.0 && a.cross(b).norm() <= POINT_TANGENCY,
                _ => false,
            })
    }

    /// Are faces `p` and `q` tangent (G1) along every edge they share? Their outward normals
    /// point the same way and are parallel (within `ANGULAR_TOLERANCE`) at both ends and the
    /// middle of each.
    fn g1_joined(&self, p: usize, q: usize, sh: &Shared) -> bool {
        let (fp, fq) = (
            self.plan.fs[p].as_ref().expect("face"),
            self.plan.fs[q].as_ref().expect("face"),
        );
        // Outward normals: two faces joined tangentially in a solid have the **same**
        // outward normal there; opposite ones are a fold (a knife edge), not a tangency.
        let normal = |f: &crate::plan::PF, x: Point3| {
            let (u, v, _) = f.surf.project(x);
            f.surf.normal(u, v).map(|n| if f.sense { n } else { -n })
        };
        sh.edges.iter().all(|&e| {
            let pe = &self.plan.es[e];
            [0.0, 0.5, 1.0].iter().all(|&k| {
                let x = pe.curve.eval(pe.range.0 + (pe.range.1 - pe.range.0) * k);
                match (normal(fp, x), normal(fq, x)) {
                    (Some(a), Some(b)) => {
                        a.dot(b) > 0.0 && a.cross(b).norm() <= forge_ir::v1::ANGULAR_TOLERANCE
                    }
                    _ => false,
                }
            })
        })
    }

    /// Are faces `p` and `q` more than the tolerance apart? One face's parameter box is
    /// subdivided until each patch's rigorous 3D box ([`patch_box`]) is certainly farther
    /// than the tolerance from the other face's patch (its exact distance, [`patch_dist`],
    /// at the box centre, less the half diagonal: distance is 1-Lipschitz); `false` when
    /// that does not happen within the budget (they may touch) or no closed form applies.
    ///
    /// With shared edges (the verification helper's tangent pairs), patches lying within a
    /// band around them are skipped: two surfaces tangent along an edge separate like
    /// `s²/(2R)` at a distance `s` from it (`R` bounding the surfaces' radii), so the band of
    /// half-width `√(2R·500·pad)` only leaves out contacts closer than `500·pad` (5e-3 mm) to
    /// each other there, and the patches just outside it are certified at that separation.
    ///
    /// **Strict form** ([`Checker::band_g1`], shells): the band follows what two faces
    /// share where they are tangent (G1 along the shared edges, the same normal at the shared
    /// points), its half-width `w` is at most half the smallest principal curvature radius `ρ`
    /// of either face over its parameter box ([`rho_min`]), and a patch is skipped only if it
    /// is near what is shared in the parameter plane too: within `w` of a shared edge along
    /// the surface's own parameter lines ([`Checker::patch_within`], for iso-parametric pcurve
    /// pieces and on planes), or inside the band's parameter-plane image with its box within
    /// `w` in space ([`Checker::edge_uv_guard`]: the pieces' and points' boxes widened by `w`
    /// over the surface's smallest parametric speed). Inside it the two faces are the two
    /// sides of one C¹ surface (tangent there, each on its own side) whose curvature radii
    /// are at least `2w`, so within `w` of what they share that surface is a graph over its
    /// tangent planes and the faces meet only there; the parameter-plane condition keeps out
    /// a far part of the subdivided face that folds back near the edge in space. Everything
    /// outside the band is certified patch by patch as below, splitting across an
    /// iso-parametric shared edge first. A face with no such bound (a B-spline, a cone near
    /// its apex, the inner sheet of a spindle torus) gets no band.
    fn separated(&self, p: usize, q: usize, sh: &Shared) -> bool {
        let (sp, sq) = (
            &self.plan.fs[p].as_ref().expect("face").surf,
            &self.plan.fs[q].as_ref().expect("face").surf,
        );
        let (Some(bp), Some(bq)) = (self.uvbox[p], self.uvbox[q]) else {
            return false;
        };
        // `b`: the face measured exactly; `a`: the face subdivided.
        let probe = Point3::new(0.0, 0.0, 0.0);
        let plane = |s: &Surface| matches!(s, Surface::Plane(_));
        // A plane is measured exactly and the curved face subdivided: its shared edges are
        // then iso-parametric lines of it (a blend's contacts), which the strict band follows
        // intrinsically ([`Checker::patch_within`]).
        let ((ia, sa, ba), (sb, bb)) = if plane(sp) && !plane(sq) {
            ((q, sq, bq), (sp, bp))
        } else if patch_dist(sq, &bq, probe).is_some() {
            ((p, sp, bp), (sq, bq))
        } else if patch_dist(sp, &bp, probe).is_some() {
            ((q, sq, bq), (sp, bp))
        } else {
            return false;
        };
        let strict = self.band_g1 && !self.tangent_band;
        let pad = 10.0 * LINEAR_TOLERANCE;
        let radius = |s: &Surface| match s {
            Surface::Cylinder(c) => c.radius(),
            Surface::Sphere(x) => x.radius(),
            Surface::Torus(t) => t.major() + t.minor(),
            Surface::Cone(c) => c.radius_at(0.0).abs(),
            _ => 0.0,
        };
        // A band around what the faces share: their edges, and their shared points too (the
        // verification helper; in the strict form they are points where the faces are
        // tangent, see [`Checker::surfaces`]).
        let banded =
            !sh.edges.is_empty() || ((self.tangent_band || strict) && !sh.points.is_empty());
        let mut band = if !banded {
            0.0
        } else {
            (2.0 * radius(sp).max(radius(sq)).max(1.0) * 500.0 * pad).sqrt()
        };
        // The strict form: at most half the smallest curvature radius, and only where the
        // patch is near the shared edges in the parameter plane too.
        let mut guard: Vec<UvBox> = Vec::new();
        if strict && band > 0.0 {
            band = band.min(0.5 * rho_min(sp, &bp).min(rho_min(sq, &bq)));
            // At a shared point the faces' normals may differ by up to `POINT_TANGENCY`: to
            // first order they part (or cross) by `θ·s` at a distance `s` from it, so a band
            // of half-width `w` could hide an interpenetration of depth up to `θ·w`. Keeping
            // `w ≤ tol/θ` bounds that depth by the tolerance (W6 review round 5).
            let th = self.point_angle(p, q, sh);
            if th > 0.0 {
                band = band.min(LINEAR_TOLERANCE / th);
            }
            match self.edge_uv_guard(ia, sa, &ba, sh, band) {
                Some(g) if band > 0.0 => guard = g,
                _ => band = 0.0,
            }
        }
        let in_guard = |a: &UvBox| {
            !strict
                || guard
                    .iter()
                    .any(|g| a.u.0 <= g.u.1 && g.u.0 <= a.u.1 && a.v.0 <= g.v.1 && g.v.0 <= a.v.1)
        };
        let near_edge = |x: Point3, half: f64| {
            sh.points.iter().any(|&p| p.distance(x) + half <= band)
                || sh.edges.iter().any(|&e| {
                    let pe = &self.plan.es[e];
                    let (t, d) = pe.curve.project(x);
                    let t = into_range(t, pe.range, pe.curve.period());
                    let d = if t >= pe.range.0 && t <= pe.range.1 {
                        d
                    } else {
                        x.distance(pe.curve.eval(pe.range.0))
                            .min(x.distance(pe.curve.eval(pe.range.1)))
                    };
                    d + half <= band
                })
        };
        // The iso-parametric shared edge pieces on face `a`: `(iso_v, c, lo, hi)`.
        let iso: Vec<(bool, f64, f64, f64)> = if band > 0.0 && !sh.edges.is_empty() {
            self.iso_pieces(ia, sh)
        } else {
            Vec::new()
        };
        let (su_min, sv_min) = speed_min(sa, &ba);
        // Split across an iso edge while the patch reaches into its band and is still wider
        // (across it) than a quarter of the band; otherwise the 3D rule.
        let across = |a: &UvBox| -> Option<bool> {
            for &(iso_v, c, lo, hi) in &iso {
                if iso_v {
                    let dv = if sv_min > 0.0 {
                        band / sv_min
                    } else {
                        f64::INFINITY
                    };
                    if a.u.1 >= lo
                        && a.u.0 <= hi
                        && a.v.0 <= c + dv
                        && a.v.1 >= c - dv
                        && (a.v.1 - a.v.0) * sv_min.max(1e-300) > 0.25 * band
                    {
                        return Some(false);
                    }
                } else {
                    let du = if su_min > 0.0 {
                        band / su_min
                    } else {
                        f64::INFINITY
                    };
                    if a.v.1 >= lo
                        && a.v.0 <= hi
                        && a.u.0 <= c + du
                        && a.u.1 >= c - du
                        && (a.u.1 - a.u.0) * su_min.max(1e-300) > 0.25 * band
                    {
                        return Some(true);
                    }
                }
            }
            None
        };
        let mut budget = if band > 0.0 { 20_000usize } else { 100_000 };
        let mut stack: Vec<UvBox> = vec![ba];
        while let Some(a) = stack.pop() {
            if budget == 0 {
                return false;
            }
            budget -= 1;
            let Some(bx) = patch_box(sa, &a) else {
                return false;
            };
            let c = (bx.0 + bx.1) * 0.5;
            let half = 0.5 * bx.0.distance(bx.1);
            if band > 0.0
                && ((near_edge(c, half) && in_guard(&a)) || self.patch_within(ia, sa, &a, sh, band))
            {
                continue;
            }
            // The patch is on one side of the whole surface `sb`, clear of it: exactly in the
            // meridian plane when the two surfaces share an axis, else by its box.
            if coaxial_clear(sa, &a, sb, pad)
                || plane_clear(sa, &a, sb, pad)
                || clear_of_surface(sb, bx, pad)
            {
                continue;
            }
            let Some(d) = patch_dist(sb, &bb, c) else {
                return false;
            };
            if d - half > pad {
                continue;
            }
            if half <= 50.0 * LINEAR_TOLERANCE {
                return false;
            }
            let (um, vm) = (0.5 * (a.u.0 + a.u.1), 0.5 * (a.v.0 + a.v.1));
            let du = sa.eval(a.u.0, vm).distance(sa.eval(a.u.1, vm));
            let dv = sa.eval(um, a.v.0).distance(sa.eval(um, a.v.1));
            // Next to an iso-parametric shared edge, split across it: the strip along the
            // edge is what the band takes ([`Checker::patch_within`]), whatever its length.
            let split_u = match (band > 0.0).then(|| across(&a)).flatten() {
                Some(u) => u,
                None => du >= dv,
            };
            if split_u {
                stack.push(UvBox::new(a.u.0, um, a.v.0, a.v.1));
                stack.push(UvBox::new(um, a.u.1, a.v.0, a.v.1));
            } else {
                stack.push(UvBox::new(a.u.0, a.u.1, a.v.0, vm));
                stack.push(UvBox::new(a.u.0, a.u.1, vm, a.v.1));
            }
        }
        true
    }

    /// The shared edges' pcurve pieces on face `f` that are iso-parametric segments:
    /// `(true, v, u₀, u₁)` for `v = const`, `(false, u, v₀, v₁)` for `u = const`.
    fn iso_pieces(&self, f: usize, sh: &Shared) -> Vec<(bool, f64, f64, f64)> {
        let mut out = Vec::new();
        let Some(face) = self.plan.fs[f].as_ref() else {
            return out;
        };
        if matches!(face.surf, Surface::Plane(_)) {
            return out;
        }
        for u in face.loops.iter().flatten() {
            if !sh.edges.contains(&u.edge) {
                continue;
            }
            let e = &self.plan.es[u.edge];
            let Some(ps) = u.pc.as_ref().and_then(|pc| pieces(pc, e.range, u.fwd)) else {
                continue;
            };
            for b in ps.iter().filter(|b| b.is_linear()) {
                let (p0, p1) = (b.start(), b.end());
                let tiny = 1e-12 * (1.0 + p0.x.abs().max(p0.y.abs()));
                if (p0.y - p1.y).abs() <= tiny {
                    out.push((true, p0.y, p0.x.min(p1.x), p0.x.max(p1.x)));
                } else if (p0.x - p1.x).abs() <= tiny {
                    out.push((false, p0.x, p0.y.min(p1.y), p0.y.max(p1.y)));
                }
            }
        }
        out
    }

    /// Is every point of the patch `a` of face `f` (surface `s`) within `w` of a shared edge,
    /// measured along the surface's own parameter lines? For a pcurve piece that is an
    /// **iso-parametric** segment (`v = c` over `[u₀, u₁]`, or `u = c`) whose range covers the
    /// patch's, a patch point `S(u, v)` is within `|v − c|` times the largest speed of `v`
    /// (`u`) of the edge point `S(u, c)` (`S(c, v)`); on a plane, the largest distance from
    /// the patch's corners to a straight piece (distance to a segment is convex). The patch
    /// is then the strip along the edge itself, never a far part of the face folding back.
    fn patch_within(&self, f: usize, s: &Surface, a: &UvBox, sh: &Shared, w: f64) -> bool {
        let Some(face) = self.plan.fs[f].as_ref() else {
            return false;
        };
        let (pu, _) = s.periodicity();
        // Largest parametric speeds of `u` and `v` over the patch.
        let (smu, smv) = match s {
            Surface::Plane(_) => (1.0, 1.0),
            Surface::Cylinder(c) => (c.radius(), 1.0),
            Surface::Sphere(x) => (x.radius(), x.radius()),
            Surface::Torus(t) => (t.major() + t.minor(), t.minor()),
            Surface::Cone(c) => (
                c.radius_at(a.v.0).abs().max(c.radius_at(a.v.1).abs()),
                1.0 / forge_core::math::cos(c.half_angle()),
            ),
            Surface::BSpline(_) => return false,
        };
        // The face's parameter box is padded past its boundary (`face_uvbox`: 1e-6 relative):
        // a patch may overhang the edge's range by that much (its points there are outside
        // the face, within `slack·speed` of the edge's end).
        // (Twice the pad of [`face_uvbox`], from the face's own box.)
        let bf = self.uvbox[f];
        let slack = |lo: f64, hi: f64| {
            let r = |x: (f64, f64)| 2e-6 * (1.0 + x.0.abs().max(x.1.abs()) + (x.1 - x.0));
            let own = 2e-6 * (1.0 + lo.abs().max(hi.abs()) + (hi - lo));
            match bf {
                Some(b) => own.max(r(b.u)).max(r(b.v)),
                None => own,
            }
        };
        let covers = |lo: f64, hi: f64, x0: f64, x1: f64, per: Option<f64>| {
            let ks: &[f64] = if per.is_some() {
                &[-1.0, 0.0, 1.0]
            } else {
                &[0.0]
            };
            let e = slack(lo, hi);
            ks.iter().any(|k| {
                let d = k * per.unwrap_or(0.0);
                lo - e <= x0 + d && x1 + d <= hi + e
            })
        };
        for u in face.loops.iter().flatten() {
            if !sh.edges.contains(&u.edge) {
                continue;
            }
            let e = &self.plan.es[u.edge];
            let Some(ps) = u.pc.as_ref().and_then(|pc| pieces(pc, e.range, u.fwd)) else {
                continue;
            };
            for b in ps {
                if !b.is_linear() {
                    continue;
                }
                let (p0, p1) = (b.start(), b.end());
                if matches!(s, Surface::Plane(_)) {
                    let far = [
                        Point2::new(a.u.0, a.v.0),
                        Point2::new(a.u.1, a.v.0),
                        Point2::new(a.u.0, a.v.1),
                        Point2::new(a.u.1, a.v.1),
                    ]
                    .iter()
                    .map(|&q| crate::cert2d::pseg(q, p0, p1))
                    .fold(0.0, f64::max);
                    if far <= w {
                        return true;
                    }
                    continue;
                }
                let tiny = 1e-12 * (1.0 + p0.x.abs().max(p0.y.abs()));
                if (p0.y - p1.y).abs() <= tiny {
                    // v = c over [u0, u1].
                    let (lo, hi) = (p0.x.min(p1.x), p0.x.max(p1.x));
                    let dv = (a.v.0 - p0.y).abs().max((a.v.1 - p0.y).abs());
                    if covers(lo, hi, a.u.0, a.u.1, pu) && smv * dv + smu * slack(lo, hi) <= w {
                        return true;
                    }
                } else if (p0.x - p1.x).abs() <= tiny {
                    // u = c over [v0, v1].
                    let (lo, hi) = (p0.y.min(p1.y), p0.y.max(p1.y));
                    let du = [a.u.0, a.u.1]
                        .iter()
                        .map(|&x| {
                            let mut d = (x - p0.x).abs();
                            if let Some(p) = pu {
                                d = d.min((x - p0.x - p).abs()).min((x - p0.x + p).abs());
                            }
                            d
                        })
                        .fold(0.0, f64::max);
                    if covers(lo, hi, a.v.0, a.v.1, None) && smu * du + smv * slack(lo, hi) <= w {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// The parameter-plane image of the band of half-width `w` around what faces share on
    /// face `f` (surface `s`, parameter box `b`): per Bézier piece of each shared edge's pcurve
    /// and per shared point (projected), its box widened by `w` over the surface's smallest
    /// parametric speed in each direction ([`speed_min`]), with copies one period either side
    /// on periodic surfaces. `None` when a pcurve is missing or a speed has no positive lower
    /// bound.
    fn edge_uv_guard(
        &self,
        f: usize,
        s: &Surface,
        b: &UvBox,
        sh: &Shared,
        w: f64,
    ) -> Option<Vec<UvBox>> {
        let face = self.plan.fs[f].as_ref()?;
        let (su, sv) = speed_min(s, b);
        if !(su > 1e-9 && sv > 1e-9) {
            return None;
        }
        let (du, dv) = (w / su, w / sv);
        let (pu, pv) = s.periodicity();
        let shifts = |p: Option<f64>| -> Vec<f64> { p.map_or(vec![0.0], |p| vec![-p, 0.0, p]) };
        let mut out = Vec::new();
        let mut push = |lo: Point2, hi: Point2| {
            for ku in shifts(pu) {
                for kv in shifts(pv) {
                    out.push(UvBox::new(
                        lo.x - du + ku,
                        hi.x + du + ku,
                        lo.y - dv + kv,
                        hi.y + dv + kv,
                    ));
                }
            }
        };
        let mut edges_seen = 0usize;
        for u in face.loops.iter().flatten() {
            if !sh.edges.contains(&u.edge) {
                continue;
            }
            edges_seen += 1;
            let e = &self.plan.es[u.edge];
            for piece in pieces(u.pc.as_ref()?, e.range, u.fwd)? {
                let (l, h) = piece.bbox();
                push(l, h);
            }
        }
        if edges_seen == 0 && !sh.edges.is_empty() {
            return None;
        }
        for &x in &sh.points {
            let (u, v, _) = s.project(x);
            let q = Point2::new(u, v);
            push(q, q);
        }
        (!out.is_empty()).then_some(out)
    }

    /// Faces on the same surface: do their regions overlap?
    fn coincident(&self, p: usize, q: usize, sh: &Shared) -> Outcome {
        let pf = self.plan.fs[p].as_ref().expect("face");
        let qf = self.plan.fs[q].as_ref().expect("face");
        let bp = self.bnd[p].as_ref().expect("boundary");
        let balls: Vec<(Point2, f64)> = sh
            .points
            .iter()
            .map(|&x| {
                let (u, v, _) = pf.surf.project(x);
                (Point2::new(u, v), JOINT_BALL * bp.tol)
            })
            .collect();
        let mut seen: Vec<usize> = Vec::new();
        for u in qf.loops.iter().flatten() {
            if seen.contains(&u.edge) || sh.edges.contains(&u.edge) {
                continue;
            }
            seen.push(u.edge);
            let e = &self.plan.es[u.edge];
            let Ok((pc, _)) = pcurve_for(&pf.surf, &e.curve, e.range, None) else {
                return Outcome::Unverified("a boundary on a coincident face".into());
            };
            let Some(ps) = pieces(&pc, e.range, true) else {
                return Outcome::Unverified("a boundary on a coincident face".into());
            };
            if self.meets_boundary(bp, &ps, &balls) {
                return Outcome::Hit {
                    at: e.curve.eval(0.5 * (e.range.0 + e.range.1)),
                    what: "the boundaries of two faces on one surface meet",
                };
            }
        }
        // No boundary meets the other: overlap iff one contains a boundary point of the other.
        for (a, b) in [(q, p), (p, q)] {
            let af = self.plan.fs[a].as_ref().expect("face");
            let bf = self.plan.fs[b].as_ref().expect("face");
            let Some(u) = af
                .loops
                .iter()
                .flatten()
                .find(|u| !sh.edges.contains(&u.edge))
            else {
                continue;
            };
            let e = &self.plan.es[u.edge];
            let x = e.curve.eval(0.5 * (e.range.0 + e.range.1));
            if self.near_shared(x, sh) {
                continue;
            }
            let (uu, vv, _) = bf.surf.project(x);
            if self.maybe_in(b, Point2::new(uu, vv)) {
                return Outcome::Hit {
                    at: x,
                    what: "two faces on one surface overlap",
                };
            }
        }
        Outcome::Clear
    }
}

/// The axis of a surface of revolution (its frame), `None` for planes and B-splines.
fn axis_frame(s: &Surface) -> Option<&forge_core::linalg::Frame> {
    match s {
        Surface::Cylinder(c) => Some(c.frame()),
        Surface::Cone(c) => Some(c.frame()),
        Surface::Sphere(x) => Some(x.frame()),
        Surface::Torus(t) => Some(t.frame()),
        _ => None,
    }
}

/// Is the patch of `sa` over the parameter box `a` farther than `pad` from the whole surface
/// `sb`, when the two share an axis (surfaces of revolution about one line, or `sb` a plane
/// across `sa`'s axis)? Exact in the meridian plane: the patch's points have their distance
/// `ρ` from the axis and their height `z` in a rectangle computed from its parameters (a
/// cylinder: `ρ = R`, `z ∈ [v₀, v₁]`; a torus: `ρ = R + r cos v`, `z = r sin v`; a sphere:
/// `ρ = R cos v`, `z = R sin v`; a cone: `ρ = |r(v)|`, `z = v`), and `sb`'s profile is a line
/// `ρ = R` (cylinder), `z = h` (plane) or a circle (sphere, torus). A box of the patch in
/// space is much looser when it is a long thin arc (a thin blend's offset along a corner).
pub(crate) fn coaxial_clear(sa: &Surface, a: &UvBox, sb: &Surface, pad: f64) -> bool {
    let Some(fa) = axis_frame(sa) else {
        return false;
    };
    let za = fa.z();
    // `sb`'s frame: the same axis line (parallel, through `fa`'s origin).
    let (zb, ob) = match sb {
        Surface::Plane(p) => (p.frame().z(), p.frame().origin()),
        _ => match axis_frame(sb) {
            Some(f) => (f.z(), f.origin()),
            None => return false,
        },
    };
    if za.cross(zb).norm() > 1e-12 {
        return false;
    }
    let w = ob - fa.origin();
    if !matches!(sb, Surface::Plane(_)) && (w - za * w.dot(za)).norm() > 1e-9 * (1.0 + w.norm()) {
        return false;
    }
    // The patch's meridian rectangle in `sa`'s frame.
    let (rho, z) = match sa {
        Surface::Cylinder(c) => ((c.radius(), c.radius()), (a.v.0, a.v.1)),
        Surface::Cone(c) => {
            let (r0, r1) = (c.radius_at(a.v.0), c.radius_at(a.v.1));
            if r0 * r1 < 0.0 {
                return false;
            }
            (
                (r0.abs().min(r1.abs()), r0.abs().max(r1.abs())),
                (a.v.0, a.v.1),
            )
        }
        Surface::Sphere(x) => {
            let (c0, c1) = cos_range(a.v.0, a.v.1);
            let (s0, s1) = sin_range(a.v.0, a.v.1);
            let r = x.radius();
            ((r * c0.max(0.0), r * c1.max(0.0)), (r * s0, r * s1))
        }
        Surface::Torus(t) => {
            let (c0, c1) = cos_range(a.v.0, a.v.1);
            let (s0, s1) = sin_range(a.v.0, a.v.1);
            let lo = t.major() + t.minor() * c0;
            if lo < 0.0 {
                return false;
            }
            (
                (lo, t.major() + t.minor() * c1),
                (t.minor() * s0, t.minor() * s1),
            )
        }
        _ => return false,
    };
    // Heights in `sb`'s frame: z_b = (o_a − o_b)·z_b + z_a (z_a·z_b).
    let sgn = za.dot(zb).signum();
    let base = (fa.origin() - ob).dot(zb);
    let (zb0, zb1) = {
        let (p, q) = (base + sgn * z.0, base + sgn * z.1);
        (p.min(q), p.max(q))
    };
    // Distance range from (cρ, cz) to the rectangle ρ × [zb0, zb1].
    let rect = |cr: f64, cz: f64| {
        let dr = if rho.0 > cr {
            rho.0 - cr
        } else if rho.1 < cr {
            cr - rho.1
        } else {
            0.0
        };
        let dz = if zb0 > cz {
            zb0 - cz
        } else if zb1 < cz {
            cz - zb1
        } else {
            0.0
        };
        let fr = (rho.0 - cr).abs().max((rho.1 - cr).abs());
        let fz = (zb0 - cz).abs().max((zb1 - cz).abs());
        (dr.hypot(dz), fr.hypot(fz))
    };
    match sb {
        Surface::Plane(_) => zb0 > pad || zb1 < -pad,
        Surface::Cylinder(c) => rho.1 < c.radius() - pad || rho.0 > c.radius() + pad,
        Surface::Sphere(x) => {
            let (near, far) = rect(0.0, 0.0);
            far < x.radius() - pad || near > x.radius() + pad
        }
        Surface::Torus(t) if t.spindle_patch().is_none() => {
            let (near, far) = rect(t.major(), 0.0);
            far < t.minor() - pad || near > t.minor() + pad
        }
        _ => false,
    }
}

/// Is the patch of the surface of revolution `sa` over the parameter box `a` farther than
/// `pad` from the whole plane `sb`, on one side of it? Its signed distance is
/// `c + ρ(v)·K·cos(u − φ) + z(v)·(z·n)` (with `S = o + ρ(v)·e_r(u) + z(v)·z` in `sa`'s frame,
/// `K = |(x·n, y·n)|`): bounded by interval products over the box, which are exact for each
/// factor — a thin blend's patch along a wall it is tangent to separates by `ρ(1 − cos φ)`,
/// far below the looseness of its box in space.
pub(crate) fn plane_clear(sa: &Surface, a: &UvBox, sb: &Surface, pad: f64) -> bool {
    let Surface::Plane(pl) = sb else {
        return false;
    };
    let Some(fa) = axis_frame(sa) else {
        return false;
    };
    let n = pl.frame().z();
    let c = (fa.origin() - pl.frame().origin()).dot(n);
    let (kx, ky, kz) = (fa.x().dot(n), fa.y().dot(n), fa.z().dot(n));
    let k = kx.hypot(ky);
    let phi = forge_core::math::atan2(ky, kx);
    let (cu0, cu1) = cos_range(a.u.0 - phi, a.u.1 - phi);
    // ρ(v) and z(v) ranges.
    let (rho, z) = match sa {
        Surface::Cylinder(cy) => ((cy.radius(), cy.radius()), (a.v.0, a.v.1)),
        Surface::Cone(co) => {
            let (r0, r1) = (co.radius_at(a.v.0), co.radius_at(a.v.1));
            ((r0.min(r1), r0.max(r1)), (a.v.0, a.v.1))
        }
        Surface::Sphere(x) => {
            let (c0, c1) = cos_range(a.v.0, a.v.1);
            let (s0, s1) = sin_range(a.v.0, a.v.1);
            let r = x.radius();
            ((r * c0, r * c1), (r * s0, r * s1))
        }
        Surface::Torus(t) if t.spindle_patch().is_none() => {
            let (c0, c1) = cos_range(a.v.0, a.v.1);
            let (s0, s1) = sin_range(a.v.0, a.v.1);
            (
                (t.major() + t.minor() * c0, t.major() + t.minor() * c1),
                (t.minor() * s0, t.minor() * s1),
            )
        }
        _ => return false,
    };
    let prods = [rho.0 * cu0, rho.0 * cu1, rho.1 * cu0, rho.1 * cu1];
    let (p0, p1) = (
        k * prods.iter().copied().fold(f64::INFINITY, f64::min),
        k * prods.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    );
    let (q0, q1) = ((z.0 * kz).min(z.1 * kz), (z.0 * kz).max(z.1 * kz));
    let (lo, hi) = (c + p0 + q0, c + p1 + q1);
    // Rounding of the terms: a few ulps of their magnitudes.
    let eps = 1e-12 * (1.0 + c.abs() + rho.1.abs().max(rho.0.abs()) + z.0.abs().max(z.1.abs()));
    lo > pad + eps || hi < -pad - eps
}

/// Is the box `bx` certainly farther than `pad` from the whole surface `s` (all of it on
/// one side)? Planes: the signed distances of its corners. Cylinders, spheres and tori: the
/// box of its corners in the surface's frame bounds the radial distance from the axis (the
/// centre) and the height, hence the distance to the surface: the axis distance over the
/// local box is at least the distance from the axis to its xy rectangle and at most that of
/// its farthest corner; a torus's tube is the circle of radius `R` in the meridian plane.
/// `false` for cones and B-splines.
pub(crate) fn clear_of_surface(s: &Surface, bx: Box3, pad: f64) -> bool {
    let corners = |fr: &forge_core::linalg::Frame| -> Vec<forge_core::linalg::Vec3> {
        let mut v = Vec::with_capacity(8);
        for x in [bx.0.x, bx.1.x] {
            for y in [bx.0.y, bx.1.y] {
                for z in [bx.0.z, bx.1.z] {
                    v.push(fr.to_local_point(Point3::new(x, y, z)));
                }
            }
        }
        v
    };
    // The local box: [x0, x1] × [y0, y1] × [z0, z1].
    let local = |fr: &forge_core::linalg::Frame| {
        let c = corners(fr);
        let mn = |f: &dyn Fn(&forge_core::linalg::Vec3) -> f64| {
            c.iter().map(f).fold(f64::INFINITY, f64::min)
        };
        let mx = |f: &dyn Fn(&forge_core::linalg::Vec3) -> f64| {
            c.iter().map(f).fold(f64::NEG_INFINITY, f64::max)
        };
        (
            (mn(&|p| p.x), mx(&|p| p.x)),
            (mn(&|p| p.y), mx(&|p| p.y)),
            (mn(&|p| p.z), mx(&|p| p.z)),
        )
    };
    // Distance range from the origin of the rectangle [x0,x1] × [y0,y1].
    let rect_range = |x: (f64, f64), y: (f64, f64)| {
        let cx = if x.0 > 0.0 {
            x.0
        } else if x.1 < 0.0 {
            -x.1
        } else {
            0.0
        };
        let cy = if y.0 > 0.0 {
            y.0
        } else if y.1 < 0.0 {
            -y.1
        } else {
            0.0
        };
        let far_x = x.0.abs().max(x.1.abs());
        let far_y = y.0.abs().max(y.1.abs());
        (cx.hypot(cy), far_x.hypot(far_y))
    };
    match s {
        Surface::Plane(p) => {
            let n = p.frame().z();
            let o = p.frame().origin();
            let mut lo = f64::INFINITY;
            let mut hi = f64::NEG_INFINITY;
            for x in [bx.0.x, bx.1.x] {
                for y in [bx.0.y, bx.1.y] {
                    for z in [bx.0.z, bx.1.z] {
                        let d = (Point3::new(x, y, z) - o).dot(n);
                        lo = lo.min(d);
                        hi = hi.max(d);
                    }
                }
            }
            lo > pad || hi < -pad
        }
        Surface::Cylinder(c) => {
            let (x, y, _) = local(c.frame());
            let (rmin, rmax) = rect_range(x, y);
            rmax < c.radius() - pad || rmin > c.radius() + pad
        }
        Surface::Sphere(sp) => {
            let (x, y, z) = local(sp.frame());
            let (rmin, rmax) = rect_range(x, y);
            let cz = if z.0 > 0.0 {
                z.0
            } else if z.1 < 0.0 {
                -z.1
            } else {
                0.0
            };
            let fz = z.0.abs().max(z.1.abs());
            let (dmin, dmax) = (rmin.hypot(cz), rmax.hypot(fz));
            dmax < sp.radius() - pad || dmin > sp.radius() + pad
        }
        // A spindle torus's two sheets are two tube circles in the meridian plane: not here.
        Surface::Torus(t) if t.spindle_patch().is_none() => {
            let (x, y, z) = local(t.frame());
            let (rmin, rmax) = rect_range(x, y);
            // In the meridian plane: the rectangle [rmin, rmax] × [z0, z1] against the tube
            // circle of radius `minor` about (major, 0).
            let big = t.major();
            let dx = if rmin > big {
                rmin - big
            } else if rmax < big {
                big - rmax
            } else {
                0.0
            };
            let dz = if z.0 > 0.0 {
                z.0
            } else if z.1 < 0.0 {
                -z.1
            } else {
                0.0
            };
            let near = dx.hypot(dz);
            let far = (rmin - big)
                .abs()
                .max((rmax - big).abs())
                .hypot(z.0.abs().max(z.1.abs()));
            far < t.minor() - pad || near > t.minor() + pad
        }
        _ => false,
    }
}

/// A lower bound of the principal curvature radii of `s` over the parameter box `b`
/// (`∞` for a plane, `0` where none is known: a B-spline, a cone whose box reaches the
/// apex, a spindle-torus patch). A torus's radii are `r` and `(R + r cos v)/cos v`, whose
/// smallest magnitude over the box is `R/c − r` with `c` the largest `−cos v`; a cone's
/// circumferential radius is the section radius over `cos α`.
pub(crate) fn rho_min(s: &Surface, b: &UvBox) -> f64 {
    match s {
        Surface::Plane(_) => f64::INFINITY,
        Surface::Cylinder(c) => c.radius(),
        Surface::Sphere(x) => x.radius(),
        Surface::Cone(c) => {
            let (ra, rb) = (c.radius_at(b.v.0), c.radius_at(b.v.1));
            if ra * rb <= 0.0 {
                0.0
            } else {
                ra.abs().min(rb.abs()) / forge_core::math::cos(c.half_angle())
            }
        }
        Surface::Torus(t) => {
            if t.spindle_patch() == Some(forge_core::geom::SpindlePatch::Inner) {
                return 0.0;
            }
            // Ring and horn tori, and the outer sheet of a spindle torus over the face's range.
            let (c0, _) = cos_range(b.v.0, b.v.1);
            let c = -c0;
            let other = if c > 0.0 {
                (t.major() / c - t.minor()).max(0.0)
            } else {
                f64::INFINITY
            };
            t.minor().min(other)
        }
        Surface::BSpline(_) => 0.0,
    }
}

/// Lower bounds of the parametric speeds `|S_u|`, `|S_v|` of `s` over the parameter box `b`
/// (`0` where none is known).
pub(crate) fn speed_min(s: &Surface, b: &UvBox) -> (f64, f64) {
    match s {
        Surface::Plane(_) => (1.0, 1.0),
        Surface::Cylinder(c) => (c.radius(), 1.0),
        Surface::Sphere(x) => {
            let (c0, _) = cos_range(b.v.0, b.v.1);
            (x.radius() * c0.max(0.0), x.radius())
        }
        Surface::Cone(c) => {
            let (ra, rb) = (c.radius_at(b.v.0), c.radius_at(b.v.1));
            let su = if ra * rb <= 0.0 {
                0.0
            } else {
                ra.abs().min(rb.abs())
            };
            (su, 1.0)
        }
        Surface::Torus(t) => {
            if t.spindle_patch() == Some(forge_core::geom::SpindlePatch::Inner) {
                return (0.0, t.minor());
            }
            let (c0, _) = cos_range(b.v.0, b.v.1);
            ((t.major() + t.minor() * c0).max(0.0), t.minor())
        }
        Surface::BSpline(_) => (0.0, 0.0),
    }
}

/// `t` shifted by whole periods into (or nearest to) `r`.
fn into_range(t: f64, r: (f64, f64), period: Option<f64>) -> f64 {
    match period {
        Some(p) => {
            let mut x = r.0 + forge_core::math::rem_euclid(t - r.0, p);
            // Nearer to the range's end from below the start?
            if x > r.1 && (x - p - r.0).abs() < (x - r.1) {
                x -= p;
            }
            x
        }
        None => t,
    }
}

#[cfg(test)]
mod tests {
    //! W6 review round 3: a face holding a pole or an apex that no loop reaches in `(u, v)`
    //! must be bounded (and intersected) over its whole extent, or a face crossing it near
    //! the pole is certified clear.
    use super::*;
    use forge_core::topo::Body;
    use forge_ir::v1::metrics::Origin;
    use forge_ir::{Frame, PlaneSpec, SketchCurve, SketchFeature, SweepDirection};
    use forge_ops::boolean::corpus::{Operand, Sweep};
    use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};

    fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
        SketchCurve::Line {
            id: id.into(),
            start: a,
            end: b,
        }
    }

    fn operand(
        feature: &str,
        plane: [f64; 3],
        normal: [f64; 3],
        curves: Vec<SketchCurve>,
    ) -> Operand {
        Operand {
            feature: feature.into(),
            sketch: SketchFeature {
                id: format!("s_{feature}"),
                name: format!("s_{feature}"),
                suppressed: false,
                plane: PlaneSpec::Frame(Frame {
                    origin: plane,
                    normal,
                    x_dir: [1.0, 0.0, 0.0],
                }),
                curves,
            },
            sweep: Sweep::Extrude {
                distance: 1.0,
                direction: SweepDirection::Normal,
            },
        }
    }

    fn slab(feature: &str, x0: f64, y0: f64, w: f64, z0: f64, h: f64) -> Body {
        let mut op = operand(
            feature,
            [0.0, 0.0, z0],
            [0.0, 0.0, 1.0],
            vec![
                line("b", [x0, y0], [x0 + w, y0]),
                line("r", [x0 + w, y0], [x0 + w, y0 + w]),
                line("t", [x0 + w, y0 + w], [x0, y0 + w]),
                line("l", [x0, y0 + w], [x0, y0]),
            ],
        );
        op.sweep = Sweep::Extrude {
            distance: h,
            direction: SweepDirection::Normal,
        };
        op.build().expect("slab")
    }

    /// A solid of revolution about the vertical line through `(x, y)` (profile in the
    /// half plane (radius, z)).
    fn revolved(x: f64, y: f64, curves: Vec<SketchCurve>) -> Body {
        let mut op = operand("rev", [x, y, 0.0], [0.0, -1.0, 0.0], curves);
        op.sweep = Sweep::Revolve {
            axis: forge_ir::SketchAxis {
                origin: [0.0, 0.0],
                direction: [0.0, 1.0],
            },
            angle: 360.0,
            direction: SweepDirection::Normal,
        };
        op.build().expect("revolved")
    }

    fn cut(target: Body, tool: Body) -> Body {
        let ob = |body, f: &str, t| OpBody {
            body,
            origin: Origin {
                feature: f.into(),
                member: "m".into(),
                instance: None,
            },
            timeline: t,
        };
        let r = apply_body_op(
            BodyOp::Cut,
            &[ob(target, "a", 0)],
            &[ob(tool, "b", 1)],
            "c1",
        )
        .expect("cut");
        r.bodies.into_iter().next().expect("body").body
    }

    /// The plans of `a` and `b` as one plan of two shells (indices of `b` shifted).
    fn merged(a: &Body, b: &Body) -> Plan {
        let mut p = Plan::from_body(a).expect("plan a");
        let q = Plan::from_body(b).expect("plan b");
        let (nv, ne, ns) = (p.vs.len(), p.es.len(), p.shells.len());
        p.shells.extend(q.shells.iter().copied());
        p.vs.extend(q.vs.iter().cloned());
        for mut e in q.es.iter().cloned() {
            e.start = e.start.map(|v| v + nv);
            e.end = e.end.map(|v| v + nv);
            p.es.push(e);
        }
        for f in q.fs.iter().flatten() {
            let mut f = f.clone();
            f.shell += ns;
            for u in f.loops.iter_mut().flatten() {
                u.edge += ne;
            }
            p.fs.push(Some(f));
        }
        p
    }

    fn face_where(p: &Plan, pred: impl Fn(&Surface) -> bool) -> usize {
        (0..p.fs.len())
            .find(|&f| p.fs[f].as_ref().is_some_and(|x| pred(&x.surf)))
            .expect("face")
    }

    fn plane_at_z(p: &Plan, z: f64, from: usize) -> usize {
        (from..p.fs.len())
            .find(|&f| {
                matches!(&p.fs[f].as_ref().expect("face").surf,
                    Surface::Plane(pl) if pl.frame().z().z.abs() > 0.99
                        && (pl.frame().origin().z - z).abs() < 1e-9)
            })
            .expect("plane face")
    }

    fn pair(p: &Plan, a: usize, b: usize) -> Outcome {
        let all: Vec<usize> = (0..p.fs.len()).collect();
        let ck = Checker::new(p, &all);
        let sh = ck.topo_shared(a, b);
        ck.pair(a, b, &sh)
    }

    #[test]
    fn a_spherical_cap_is_bounded_down_to_its_pole() {
        // A plate with a dimple (ball centre z = 7, r = 5, bottom at z = 2), and a small
        // separate slab crossing the dimple's bottom at z = 2.1 (its edges outside the ball).
        let ball = revolved(
            20.0,
            15.0,
            vec![
                SketchCurve::Arc {
                    id: "a".into(),
                    start: [0.0, 2.0],
                    end: [0.0, 12.0],
                    center: [0.0, 7.0],
                    ccw: true,
                },
                line("x", [0.0, 12.0], [0.0, 2.0]),
            ],
        );
        let plate = cut(slab("p", 0.0, 0.0, 40.0, 0.0, 6.0), ball);
        let probe = slab("s", 18.0, 13.0, 4.0, 2.1, 0.2);
        let p = merged(&plate, &probe);
        let cap = face_where(&p, |s| matches!(s, Surface::Sphere(_)));
        let b = face_uvbox(&p, cap).expect("box");
        assert!(b.v.0 <= -forge_core::math::FRAC_PI_2, "{b:?}");
        let under = plane_at_z(&p, 2.1, Plan::from_body(&plate).unwrap().fs.len());
        assert!(
            matches!(pair(&p, cap, under), Outcome::Hit { .. }),
            "the slab crosses the cap near its pole"
        );
        // Clear when the slab is below the cap.
        let low = merged(&plate, &slab("s", 18.0, 13.0, 4.0, 1.0, 0.2));
        let under = plane_at_z(&low, 1.2, Plan::from_body(&plate).unwrap().fs.len());
        assert!(matches!(pair(&low, cap, under), Outcome::Clear));
    }

    #[test]
    fn a_drill_point_is_bounded_up_to_its_apex() {
        // A blind drill from below: cylinder r = 1 up to z = 16, apex at z = 19; a separate
        // slab crossing the point at z = 18.5 (radius 1/6 there; its edges far away).
        let drill = revolved(
            20.0,
            15.0,
            vec![
                line("b", [0.0, -1.0], [1.0, -1.0]),
                line("s", [1.0, -1.0], [1.0, 16.0]),
                line("t", [1.0, 16.0], [0.0, 19.0]),
                line("x", [0.0, 19.0], [0.0, -1.0]),
            ],
        );
        let block = cut(slab("p", 0.0, 0.0, 40.0, 0.0, 20.0), drill);
        let p = merged(&block, &slab("s", 18.0, 13.0, 4.0, 18.5, 0.2));
        let cone = face_where(&p, |s| matches!(s, Surface::Cone(_)));
        let Surface::Cone(c) = &p.fs[cone].as_ref().unwrap().surf else {
            unreachable!()
        };
        let b = face_uvbox(&p, cone).expect("box");
        assert!(
            b.v.0 <= c.apex_v() && c.apex_v() <= b.v.1,
            "{b:?} apex {}",
            c.apex_v()
        );
        // Never the other nappe: the box ends at the apex.
        assert!(
            b.v.0 >= c.apex_v() - 1e-9 || b.v.1 <= c.apex_v() + 1e-9,
            "{b:?}"
        );
        let n0 = Plan::from_body(&block).unwrap().fs.len();
        let under = plane_at_z(&p, 18.5, n0);
        assert!(
            matches!(pair(&p, cone, under), Outcome::Hit { .. }),
            "the slab crosses the drill point"
        );
        // A slab above the apex is clear (the other nappe is not part of the face).
        let q = merged(&block, &slab("s", 18.0, 13.0, 4.0, 19.5, 0.2));
        let under = plane_at_z(&q, 19.5, n0);
        assert!(matches!(pair(&q, cone, under), Outcome::Clear));
    }
}
