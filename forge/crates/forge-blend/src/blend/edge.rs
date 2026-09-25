//! The blend of one edge: its cross-section (a 2D problem) and the 3D curves and surface
//! it sweeps.
//!
//! Two families of edges have a constant cross-section and exact analytic blends:
//! - **line** edges between two planes: the cross-section lives in the plane normal to the
//!   edge (coordinates along `u` = into face `a`, and `w = t × u`); the rolling ball sweeps a
//!   **cylinder** (fillet), the bevel is a **plane** (chamfer);
//! - **circle** edges between two faces of revolution about the circle's axis with
//!   straight meridians (a plane perpendicular to the axis, a coaxial cylinder or cone): the
//!   cross-section lives in the meridian half-plane `(ρ, ζ)`; the ball sweeps a **torus**
//!   (a spindle-torus patch when the ball's centre circle is smaller than the ball), the
//!   bevel is a **cone** (or a plane or cylinder when the bevel is perpendicular or parallel
//!   to the axis).
//!
//! In both, each face is a straight line of the cross-section through the edge point `E`
//! along the unit direction `i` pointing into the face; with `φ` the angle between `i_a`
//! and `i_b`, the ball of radius `r` touching both lines has its centre on the bisector at
//! `r / sin(φ/2)` from `E` and touches the faces at the setback `r / tan(φ/2)` (for a
//! convex edge inside the material, for a concave one in the air wedge — the same
//! formulas). A chamfer's bevel joins the points at setbacks `d_a` and `d_b`.

use forge_core::geom::{
    Circle3, Cone, Curve3, Cylinder, Line3, Plane, SpindlePatch, Surface, Torus,
};
use forge_core::linalg::{Point3, Vec2, Vec3};
use forge_core::math;
use forge_ir::v1::{ANGULAR_TOLERANCE, LINEAR_TOLERANCE, QUERY_ANGLE_TOLERANCE};

use super::section::{self, Sec};
use crate::error::Limit;
use crate::geom::frame_zx;
use crate::plan::Plan;
use crate::topo::{Adj, Convexity, convexity_at, into_face};

/// How the cross-section's contact points are set back.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Prof {
    /// Rolling ball of radius `r`.
    Fillet(f64),
    /// Bevel: distance `d` on both faces, or on the edge's `side` face with the other
    /// distance `d2`, or with the bevel at `angle` (radians) to the `side` face (the side
    /// of each edge is passed to [`edge_blend`]).
    Chamfer {
        d: f64,
        d2: Option<f64>,
        angle: Option<f64>,
    },
}

/// The family of an edge (see the module docs).
#[derive(Clone, Copy, Debug)]
pub(crate) enum Fam {
    /// `X(s, p) = o + s·t + p.x·u + p.y·w`.
    Line {
        o: Point3,
        t: Vec3,
        u: Vec3,
        w: Vec3,
    },
    /// `X(θ, p) = o + p.x·e_ρ(θ) + p.y·z`, `e_ρ(θ) = cos θ·x0 + sin θ·y0`.
    Circle {
        o: Point3,
        z: Vec3,
        x0: Vec3,
        y0: Vec3,
    },
}

impl Fam {
    /// A cross-section point at a station (arc length along a line, angle about an axis).
    pub fn to3(&self, st: f64, p: Vec2) -> Point3 {
        match *self {
            Fam::Line { o, t, u, w } => o + t * st + u * p.x + w * p.y,
            Fam::Circle { o, z, x0, y0 } => {
                let (s, c) = math::sin_cos(st);
                o + (x0 * c + y0 * s) * p.x + z * p.y
            }
        }
    }
    /// A cross-section direction at a station.
    pub fn vec3(&self, st: f64, d: Vec2) -> Vec3 {
        match *self {
            Fam::Line { u, w, .. } => u * d.x + w * d.y,
            Fam::Circle { z, x0, y0, .. } => {
                let (s, c) = math::sin_cos(st);
                (x0 * c + y0 * s) * d.x + z * d.y
            }
        }
    }
    /// Station and cross-section coordinates of a point.
    pub fn to2(&self, q: Point3) -> (f64, Vec2) {
        match *self {
            Fam::Line { o, t, u, w } => {
                let l = q - o;
                (l.dot(t), Vec2::new(l.dot(u), l.dot(w)))
            }
            Fam::Circle { o, z, x0, y0 } => {
                let l = q - o;
                let h = l.dot(z);
                let rad = l - z * h;
                let th = math::atan2(rad.dot(y0), rad.dot(x0));
                (th, Vec2::new(rad.norm(), h))
            }
        }
    }
    /// The edge tangent direction at a station (unit; the family's positive direction).
    pub fn tangent(&self, st: f64) -> Vec3 {
        match *self {
            Fam::Line { t, .. } => t,
            Fam::Circle { x0, y0, .. } => {
                let (s, c) = math::sin_cos(st);
                y0 * c - x0 * s
            }
        }
    }
    pub fn is_line(&self) -> bool {
        matches!(self, Fam::Line { .. })
    }
}

/// The blend of one edge.
#[derive(Clone, Debug)]
pub(crate) struct Eg {
    /// Plan edge.
    pub e: usize,
    /// Plan faces: `a` uses the edge in its first use's direction, `b` the other.
    pub a: usize,
    pub b: usize,
    pub fam: Fam,
    pub convex: bool,
    /// Cross-section: edge point and contact points.
    pub e2: Vec2,
    pub pa: Vec2,
    pub pb: Vec2,
    /// Fillet: ball centre and radius (`r = 0` for chamfers).
    pub c2: Vec2,
    pub r: f64,
    /// Full carrier curves of the two contact curves (on `a` and on `b`).
    pub contact: [Curve3; 2],
    /// Blend surface and whether its normal is the outward one.
    pub surf: Surface,
    pub sense: bool,
    /// Stations of the edge's ends (`None` for ring edges), in the edge's curve direction.
    pub st_range: Option<(f64, f64)>,
    /// The two faces' curves in the cross-section ([`section`]) and their unit tangents at
    /// `E`, into each face.
    pub sec: [Sec; 2],
    pub ta: Vec2,
    pub tb: Vec2,
}

/// Why an edge's blend cannot be built.
#[derive(Clone, Debug)]
pub(crate) enum EgFail {
    /// A structural limitation (`*_FAILED`).
    Failed(String),
    /// The value is too large for this edge (curvature: a radius reaches zero).
    Infeasible {
        limit: Limit,
        face: usize,
        what: String,
    },
}

/// Is `s` a plane perpendicular to the axis `(o, z)`, or a cylinder (of radius `radius`) or
/// cone about it? Axis directions are parallel within `ANGULAR_TOLERANCE` (SPEC §1).
fn coaxial(s: &Surface, o: Point3, z: Vec3, radius: f64) -> bool {
    let tol = LINEAR_TOLERANCE;
    let par = |a: Vec3| a.cross(z).norm() <= ANGULAR_TOLERANCE;
    let on_axis = |p: Point3, a: Vec3| {
        let w = o - p;
        (w - a * w.dot(a)).norm() <= tol
    };
    match s {
        Surface::Plane(p) => par(p.frame().z()),
        Surface::Cylinder(c) => {
            let f = c.frame();
            par(f.z()) && on_axis(f.origin(), f.z()) && (c.radius() - radius).abs() <= tol
        }
        Surface::Cone(c) => {
            let f = c.frame();
            par(f.z()) && on_axis(f.origin(), f.z())
        }
        _ => false,
    }
}

/// The curve of face surface `s` in the cross-section of a line edge (`fam`) through the
/// point `pm`: a plane is a line; a cylinder whose axis is parallel to the edge (the edge one
/// of its generators) a circle. `None` otherwise.
fn line_section(s: &Surface, fam: &Fam, pm: Point3) -> Option<Sec> {
    let Fam::Line { t, .. } = *fam else {
        return None;
    };
    match s {
        Surface::Plane(_) => Some(Sec::Line),
        Surface::Cylinder(c) => {
            let f = c.frame();
            if f.z().cross(t).norm() > ANGULAR_TOLERANCE {
                return None;
            }
            let w = pm - f.origin();
            let d = (w - f.z() * w.dot(f.z())).norm();
            if (d - c.radius()).abs() > LINEAR_TOLERANCE {
                return None;
            }
            Some(Sec::Circle {
                c: fam.to2(f.origin()).1,
                r: c.radius(),
            })
        }
        _ => None,
    }
}

/// The curve of face surface `s` in the meridian half-plane of a circle edge (axis `o`, `z`,
/// radius `radius`): a line for a plane perpendicular to the axis, a coaxial cylinder or
/// cone; a circle for a sphere centred on the axis or a ring torus about it. `None`
/// otherwise.
fn circle_section(s: &Surface, o: Point3, z: Vec3, radius: f64) -> Option<Sec> {
    if coaxial(s, o, z, radius) {
        return Some(Sec::Line);
    }
    let tol = LINEAR_TOLERANCE;
    let on_axis = |p: Point3| {
        let w = p - o;
        (w - z * w.dot(z)).norm() <= tol
    };
    let e = Vec2::new(radius, 0.0);
    let sec = match s {
        Surface::Sphere(sp) => {
            let c = sp.frame().origin();
            if !on_axis(c) {
                return None;
            }
            Sec::Circle {
                c: Vec2::new(0.0, (c - o).dot(z)),
                r: sp.radius(),
            }
        }
        Surface::Torus(tr) if tr.spindle_patch().is_none() => {
            let f = tr.frame();
            if f.z().cross(z).norm() > ANGULAR_TOLERANCE || !on_axis(f.origin()) {
                return None;
            }
            Sec::Circle {
                c: Vec2::new(tr.major(), (f.origin() - o).dot(z)),
                r: tr.minor(),
            }
        }
        _ => return None,
    };
    // The edge point lies on the curve.
    match sec {
        Sec::Circle { c, r } if (e.distance(c) - r).abs() <= tol => Some(sec),
        _ => None,
    }
}

/// The blend of plan edge `e` with profile `prof` (`side`: the chamfer's side face of this
/// edge, for the two-distance and distance–angle forms).
pub(crate) fn edge_blend(
    p: &Plan,
    adj: &Adj,
    e: usize,
    prof: Prof,
    side: Option<usize>,
) -> Result<Eg, EgFail> {
    let pe = &p.es[e];
    let us = &adj.uses[e];
    if us.len() != 2 || us[0].face == us[1].face {
        return Err(EgFail::Failed(
            "the edge does not lie between two faces".into(),
        ));
    }
    let (a, b) = (us[0].face, us[1].face);
    let fa = p.fs[a].as_ref().expect("live face");
    let fb = p.fs[b].as_ref().expect("live face");
    let fwd_a = fa.loops[us[0].lp][us[0].idx].fwd;
    let fwd_b = fb.loops[us[1].lp][us[1].idx].fwd;
    let tm = 0.5 * (pe.range.0 + pe.range.1);
    let pm = pe.curve.eval(tm);
    let (conv, _) = convexity_at(pe, fa, fwd_a, fb, fwd_b, tm)
        .ok_or_else(|| EgFail::Failed("degenerate face normals at the edge".into()))?;
    let convex = match conv {
        Convexity::Convex => true,
        Convexity::Concave => false,
        Convexity::Smooth => return Err(EgFail::Failed("the edge is smooth".into())),
    };
    let ia3 =
        into_face(pe, fwd_a, fa, tm).ok_or_else(|| EgFail::Failed("degenerate edge".into()))?;
    let ib3 =
        into_face(pe, fwd_b, fb, tm).ok_or_else(|| EgFail::Failed("degenerate edge".into()))?;
    let not_impl = || {
        EgFail::Failed(format!(
            "blending a {} edge between a {} and a {} is not implemented",
            pe.curve.kind_name(),
            fa.surf.kind_name(),
            fb.surf.kind_name()
        ))
    };
    let (fam, e2, ia, ib, st_range, secs) = match (&pe.curve, &fa.surf, &fb.surf) {
        (Curve3::Line(l), sa, sb) => {
            let t = l.dir();
            let u = ia3;
            let w = t.cross(u);
            let fam = Fam::Line {
                o: l.origin(),
                t,
                u,
                w,
            };
            let (Some(xa), Some(xb)) = (line_section(sa, &fam, pm), line_section(sb, &fam, pm))
            else {
                return Err(not_impl());
            };
            let ib = Vec2::new(ib3.dot(u), ib3.dot(w));
            let st = if pe.is_ring() {
                None
            } else {
                Some((pe.range.0, pe.range.1))
            };
            (fam, Vec2::zero(), Vec2::new(1.0, 0.0), ib, st, [xa, xb])
        }
        (Curve3::Circle(c), sa, sb) => {
            let f = c.frame();
            let (o, z) = (f.origin(), f.z());
            let (Some(xa), Some(xb)) = (
                circle_section(sa, o, z, c.radius()),
                circle_section(sb, o, z, c.radius()),
            ) else {
                return Err(not_impl());
            };
            let fam = Fam::Circle {
                o,
                z,
                x0: f.x(),
                y0: f.y(),
            };
            let (th, _) = fam.to2(pm);
            let er = fam.vec3(th, Vec2::new(1.0, 0.0));
            let ia = Vec2::new(ia3.dot(er), ia3.dot(z));
            let ib = Vec2::new(ib3.dot(er), ib3.dot(z));
            let (ia, ib) = match (ia.normalize(), ib.normalize()) {
                (Some(x), Some(y)) => (x, y),
                _ => return Err(not_impl()),
            };
            // Circle parameter t is the angle about z from x (the family's own frame).
            let st = if pe.is_ring() {
                None
            } else {
                Some((pe.range.0, pe.range.1))
            };
            (fam, Vec2::new(c.radius(), 0.0), ia, ib, st, [xa, xb])
        }
        _ => return Err(not_impl()),
    };
    let ib = ib
        .normalize()
        .ok_or_else(|| EgFail::Failed("degenerate edge".into()))?;
    // The dihedral angle between the faces (in the cross-section); tangent faces within
    // `QUERY_ANGLE_TOLERANCE` are `smooth` (§5.3), faces folded onto each other likewise.
    let phi = math::acos(ia.dot(ib).clamp(-1.0, 1.0));
    if !(phi > QUERY_ANGLE_TOLERANCE && phi < math::PI - QUERY_ANGLE_TOLERANCE) {
        return Err(EgFail::Failed(
            "the faces meet at a degenerate angle".into(),
        ));
    }
    // The contacts (and the ball's centre) in the cross-section ([`section`]).
    let sec_fail = |f: section::SecFail| EgFail::Infeasible {
        limit: Limit::Curvature,
        face: if f.side == 0 { a } else { b },
        what: f.what,
    };
    let planar = secs == [Sec::Line, Sec::Line];
    let (pa, pb, c2, r) = match prof {
        Prof::Fillet(r) => {
            let (c2, pa, pb) = section::fillet(e2, ia, ib, secs, r).map_err(sec_fail)?;
            (pa, pb, c2, r)
        }
        Prof::Chamfer { d, d2, angle } => {
            let at = |k: usize, i: Vec2, x: f64| {
                section::at_distance(k, e2, i, secs[k], x).map_err(sec_fail)
            };
            let (pa, pb) = match (d2, angle, side) {
                (Some(d2), _, Some(sd)) => {
                    let (da, db) = if sd == a { (d, d2) } else { (d2, d) };
                    (at(0, ia, da)?, at(1, ib, db)?)
                }
                (None, Some(th), Some(sd)) if planar => {
                    if phi + th >= math::PI - ANGULAR_TOLERANCE {
                        return Err(EgFail::Failed(format!(
                            "a bevel at {:.6}° to the side face never meets the other face (faces at {:.6}°)",
                            math::rad_to_deg(th),
                            math::rad_to_deg(phi)
                        )));
                    }
                    let other = d * math::sin(th) / math::sin(phi + th);
                    // The derived distance is a length too (SPEC §6.7: lengths > tol): a
                    // near-null bevel is refused, never built.
                    if other.is_nan() || other <= LINEAR_TOLERANCE {
                        // sin θ / sin(φ + θ) grows with θ: the smallest angle giving
                        // `other > tol` (to 1e-9 relative), for the message.
                        let (mut lo, mut hi) = (th, math::PI - phi);
                        for _ in 0..200 {
                            let m = 0.5 * (lo + hi);
                            if d * math::sin(m) / math::sin(phi + m) > LINEAR_TOLERANCE {
                                hi = m;
                            } else {
                                lo = m;
                            }
                        }
                        return Err(EgFail::Failed(format!(
                            "the bevel's distance on the other face, d·sin(angle)/sin(φ + angle) = {other:.3e} mm, is not a length > {LINEAR_TOLERANCE} mm (the angle must exceed {:.3e}°)",
                            math::rad_to_deg(hi)
                        )));
                    }
                    let (da, db) = if sd == a { (d, other) } else { (other, d) };
                    (e2 + ia * da, e2 + ib * db)
                }
                (None, Some(th), Some(sd)) => {
                    // A curved face: from the contact on a planar side face along the bevel's
                    // direction to the curved face.
                    let (ks, is_, io) = if sd == a { (0, ia, ib) } else { (1, ib, ia) };
                    if secs[ks] != Sec::Line {
                        return Err(EgFail::Failed(format!(
                            "a distance–angle chamfer measured on a curved side face ({}) is not implemented",
                            p.fs[sd].as_ref().expect("face").surf.kind_name()
                        )));
                    }
                    let Some(po) = section::along_angle(e2, is_, io, secs[1 - ks], d, th) else {
                        return Err(EgFail::Infeasible {
                            limit: Limit::Curvature,
                            face: if ks == 0 { b } else { a },
                            what: "the bevel at the angle does not meet the curved face within a quarter turn".into(),
                        });
                    };
                    if po.distance(e2) <= LINEAR_TOLERANCE {
                        return Err(EgFail::Failed(
                            "the bevel's distance on the other face is not a length".into(),
                        ));
                    }
                    let ps = e2 + is_ * d;
                    if ks == 0 { (ps, po) } else { (po, ps) }
                }
                _ => (at(0, ia, d)?, at(1, ib, d)?),
            };
            (pa, pb, e2, 0.0)
        }
    };
    let infeasible = |face: usize, what: &str| EgFail::Infeasible {
        limit: Limit::Curvature,
        face,
        what: what.into(),
    };
    // Contact carriers.
    let contact_of = |pt: Vec2, face: usize| -> Result<Curve3, EgFail> {
        match fam {
            Fam::Line { t, .. } => Line3::new(fam.to3(0.0, pt), t)
                .map(Curve3::Line)
                .map_err(|_| EgFail::Failed("degenerate contact line".into())),
            Fam::Circle { o, z, x0, .. } => {
                if pt.x <= 10.0 * LINEAR_TOLERANCE {
                    return Err(infeasible(face, "the contact circle shrinks to the axis"));
                }
                let c = o + z * pt.y;
                let fs = &p.fs[face].as_ref().expect("face").surf;
                let fr = match fs {
                    Surface::Plane(pl) => pl.frame().with_origin(c),
                    _ => frame_zx(c, z, x0).expect("frame"),
                };
                Circle3::new(fr, pt.x)
                    .map(Curve3::Circle)
                    .map_err(|_| EgFail::Failed("degenerate contact circle".into()))
            }
        }
    };
    let contact = [contact_of(pa, a)?, contact_of(pb, b)?];
    // Blend surface, and the outward direction it must have at the middle of the profile.
    let sigma = if convex { 1.0 } else { -1.0 };
    let (surf, q2, out2) = match prof {
        Prof::Fillet(_) => {
            let toward = (e2 - c2)
                .normalize()
                .ok_or_else(|| EgFail::Failed("degenerate ball".into()))?;
            let q2 = c2 + toward * r;
            let surf = match fam {
                Fam::Line { t, .. } => {
                    let fr = frame_zx(fam.to3(0.0, c2), t, fam.vec3(0.0, toward)).expect("frame");
                    Surface::Cylinder(
                        Cylinder::new(fr, r).map_err(|_| EgFail::Failed("bad cylinder".into()))?,
                    )
                }
                Fam::Circle { o, z, x0, .. } => {
                    let major = c2.x;
                    if major <= 10.0 * LINEAR_TOLERANCE {
                        return Err(infeasible(
                            a,
                            "the ball's centre circle shrinks to the axis",
                        ));
                    }
                    // The arc must stay off the axis: its points nearest the axis are its
                    // ends or the ball point facing the axis (ρ = major − r) when inside it.
                    let ang = |q: Vec2| math::atan2(q.y - c2.y, q.x - c2.x);
                    let (aa, ab, am) = (ang(pa), ang(pb), ang(q2));
                    let within = |x: f64| {
                        // Is the direction x on the short arc from aa to ab through am?
                        let span = |from: f64, to: f64| crate::geom::wrap(to - from);
                        let (s_ab, s_am) = (span(aa, ab), span(aa, am));
                        if s_am <= s_ab {
                            span(aa, x) <= s_ab
                        } else {
                            span(ab, x) <= span(ab, aa)
                        }
                    };
                    let rho_min = if within(math::PI) {
                        major - r
                    } else {
                        pa.x.min(pb.x)
                    };
                    if rho_min <= 10.0 * LINEAR_TOLERANCE {
                        return Err(infeasible(a, "the blend reaches the axis"));
                    }
                    let fr = frame_zx(o + z * c2.y, z, x0).expect("frame");
                    let tor = if major >= r {
                        Torus::new(fr, major, r)
                    } else {
                        Torus::spindle(fr, major, r, SpindlePatch::Outer)
                    };
                    Surface::Torus(tor.map_err(|_| EgFail::Failed("bad torus".into()))?)
                }
            };
            (surf, q2, toward * sigma)
        }
        Prof::Chamfer { .. } => {
            let chord = pb - pa;
            let mut n2 = Vec2::new(-chord.y, chord.x)
                .normalize()
                .ok_or_else(|| EgFail::Failed("degenerate bevel".into()))?;
            if n2.dot(e2 - pa) < 0.0 {
                n2 = -n2;
            }
            let q2 = (pa + pb) * 0.5;
            let surf = match fam {
                Fam::Line { t, .. } => {
                    let n3 = fam.vec3(0.0, n2 * sigma);
                    let fr = frame_zx(fam.to3(0.0, pa), n3, t).expect("frame");
                    Surface::Plane(Plane::new(fr))
                }
                Fam::Circle { o, z, x0, .. } => bevel_of_revolution(o, z, x0, pa, pb)?,
            };
            (surf, q2, n2 * sigma)
        }
    };
    let q3 = fam.to3(0.0, q2);
    let out3 = fam.vec3(0.0, out2);
    let (u, v, dist) = surf.project(q3);
    if dist > 1e-9 * (1.0 + q3.norm()) {
        return Err(EgFail::Failed("inconsistent blend surface".into()));
    }
    let n = surf
        .normal(u, v)
        .ok_or_else(|| EgFail::Failed("degenerate blend surface".into()))?;
    let sense = n.dot(out3) > 0.0;
    Ok(Eg {
        e,
        a,
        b,
        fam,
        convex,
        e2,
        pa,
        pb,
        c2,
        r,
        contact,
        surf,
        sense,
        st_range,
        sec: secs,
        ta: ia,
        tb: ib,
    })
}

/// The surface of revolution (about `o`, `z`) through the meridian points `pa` and `pb`
/// (`(ρ, ζ)`): a plane perpendicular to the axis, a cylinder, or a cone.
fn bevel_of_revolution(
    o: Point3,
    z: Vec3,
    x0: Vec3,
    pa: Vec2,
    pb: Vec2,
) -> Result<Surface, EgFail> {
    let (dr, dz) = (pb.x - pa.x, pb.y - pa.y);
    let bad = || EgFail::Failed("degenerate bevel of revolution".into());
    if dz.abs() <= 1e-12 * (1.0 + dr.abs()) {
        let fr = frame_zx(o + z * pa.y, z, x0).ok_or_else(bad)?;
        return Ok(Surface::Plane(Plane::new(fr)));
    }
    if dr.abs() <= 1e-12 * (1.0 + dz.abs()) {
        let fr = frame_zx(o, z, x0).ok_or_else(bad)?;
        return Cylinder::new(fr, pa.x)
            .map(Surface::Cylinder)
            .map_err(|_| bad());
    }
    // The cone widens towards the frame's +z: pick its sign so that tan α > 0.
    let sgn = if dr * dz > 0.0 { 1.0 } else { -1.0 };
    let zc = z * sgn;
    let tan = dr / (dz * sgn);
    let alpha = math::atan(tan);
    let fr = frame_zx(o + z * pa.y, zc, x0).ok_or_else(bad)?;
    Cone::new(fr, pa.x, alpha)
        .map(Surface::Cone)
        .map_err(|_| bad())
}

impl Eg {
    /// Contact point on side `k` (0 = a, 1 = b) at a station.
    pub fn contact_at(&self, k: usize, st: f64) -> Point3 {
        self.fam.to3(st, if k == 0 { self.pa } else { self.pb })
    }
    /// Side index of face `f` (0 = a, 1 = b).
    pub fn side_of(&self, f: usize) -> Option<usize> {
        if f == self.a {
            Some(0)
        } else if f == self.b {
            Some(1)
        } else {
            None
        }
    }
    /// The station of a point.
    pub fn station(&self, q: Point3) -> f64 {
        self.fam.to2(q).0
    }
    /// `true` for a fillet (rolling ball), `false` for a chamfer.
    pub fn is_fillet(&self) -> bool {
        self.r > 0.0
    }
    /// The point of the blend's cross-section facing the edge (middle of the profile).
    pub fn mid_profile(&self, st: f64) -> Point3 {
        if self.is_fillet() {
            let toward = (self.e2 - self.c2).normalize().unwrap_or(Vec2::zero());
            self.fam.to3(st, self.c2 + toward * self.r)
        } else {
            self.fam.to3(st, (self.pa + self.pb) * 0.5)
        }
    }
}
