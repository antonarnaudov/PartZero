//! Clearance of a thread's region: the groove is built directly, so no other face of the
//! body may reach into the annulus it occupies (a wall thinner than the thread depth, a
//! cross hole, a slot through the bore), and a plane the thread ends on must hold the groove
//! sections. Every test here is **conservative**: a face is accepted only when a bound proves
//! it clear; anything not proven clear is `THREAD_INTERFERENCE`.
//!
//! # The region
//! `ρ ∈ [min(R_c, R_r) − m, max(R_c, R_r) + m]`, `z ∈ [z_a − m, z_b + m]` in the thread
//! frame, with the margin `m =` [`CLEARANCE`].
//!
//! # Bounds per face (the first that decides wins)
//! - planes across the axis: their height; inside the region's heights, their boundary's
//!   radial range and the winding of their boundary around the axis point (a face that
//!   contains the axis point reaches radius 0);
//! - planes along the axis: their distance from it;
//! - coaxial cylinders and cones: their radius over their axial extent;
//! - cylinders with a parallel axis and spheres: centre distance ± radius;
//! - otherwise the box of the face's boundary (planes, cylinders, cones and helicoids lie in
//!   the convex hull of their boundary; spheres, tori and B-splines add their surface's box)
//!   mapped to the thread frame: its axial range and its radial distance range.

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point3, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{Body, FaceId};
use forge_ir::v1::LINEAR_TOLERANCE;

use super::{AXIS_EPS, EndKind, Geo, ThreadError};

/// The margin (mm) the thread's region is grown by: ten times the linear tolerance, so that
/// no face of the result comes within tolerance of another one it does not share an edge
/// with.
pub const CLEARANCE: f64 = 10.0 * LINEAR_TOLERANCE;

/// The region: radial and axial ranges (thread frame).
#[derive(Clone, Copy, Debug)]
struct Region {
    r: (f64, f64),
    z: (f64, f64),
}

impl Region {
    fn clear_radially(&self, lo: f64, hi: f64) -> bool {
        hi < self.r.0 || lo > self.r.1
    }
    fn clear_axially(&self, lo: f64, hi: f64) -> bool {
        hi < self.z.0 || lo > self.z.1
    }
}

/// An axis-aligned box.
#[derive(Clone, Copy, Debug)]
struct Bx {
    lo: Point3,
    hi: Point3,
}

impl Bx {
    fn empty() -> Self {
        let inf = f64::INFINITY;
        Self {
            lo: Vec3::new(inf, inf, inf),
            hi: Vec3::new(-inf, -inf, -inf),
        }
    }
    fn add(&mut self, p: Point3) {
        self.lo = self.lo.min_components(p);
        self.hi = self.hi.max_components(p);
    }
    fn merge(&mut self, o: &Bx) {
        self.add(o.lo);
        self.add(o.hi);
    }
    fn corners(&self) -> [Point3; 8] {
        core::array::from_fn(|i| {
            Vec3::new(
                if i & 1 == 0 { self.lo.x } else { self.hi.x },
                if i & 2 == 0 { self.lo.y } else { self.hi.y },
                if i & 4 == 0 { self.lo.z } else { self.hi.z },
            )
        })
    }
}

/// A conservative box of an edge curve over its range.
fn curve_box(c: &Curve3, r: (f64, f64)) -> Bx {
    let mut b = Bx::empty();
    b.add(c.eval(r.0));
    b.add(c.eval(r.1));
    let disk = |b: &mut Bx, o: Point3, z: Vec3, rad: f64| {
        let ext = |zi: f64| rad * (1.0 - zi * zi).max(0.0).sqrt();
        let e = Vec3::new(ext(z.x), ext(z.y), ext(z.z));
        b.add(o - e);
        b.add(o + e);
    };
    match c {
        Curve3::Line(_) => {}
        Curve3::Circle(k) => disk(&mut b, k.frame().origin(), k.frame().z(), k.radius()),
        Curve3::Ellipse(e) => disk(
            &mut b,
            e.frame().origin(),
            e.frame().z(),
            e.rx().max(e.ry()),
        ),
        Curve3::Helix(h) => {
            let f = h.frame();
            let rad = h.radius_at(r.0).abs().max(h.radius_at(r.1).abs());
            for t in [r.0, r.1] {
                disk(&mut b, f.origin() + f.z() * (h.rise() * t), f.z(), rad);
            }
        }
        Curve3::BSpline(n) => {
            for p in n.control_points() {
                b.add(Vec3::new(p[0], p[1], p[2]));
            }
        }
    }
    b
}

/// A box containing face `f`: its boundary's box, plus its surface's box where the face can
/// bulge past the hull of its boundary.
fn face_box(body: &Body, f: FaceId) -> Option<Bx> {
    let face = body.face(f)?;
    let mut b = Bx::empty();
    for e in body.face_edges(f) {
        let e = body.edge(e)?;
        b.merge(&curve_box(&e.curve, e.t_range));
    }
    match &face.surface {
        Surface::Sphere(s) => {
            let r = s.radius();
            b.add(s.frame().origin() - Vec3::new(r, r, r));
            b.add(s.frame().origin() + Vec3::new(r, r, r));
        }
        Surface::Torus(t) => {
            let r = t.major() + t.minor();
            b.add(t.frame().origin() - Vec3::new(r, r, r));
            b.add(t.frame().origin() + Vec3::new(r, r, r));
        }
        Surface::BSpline(n) => {
            for &p in n.control_points() {
                b.add(p);
            }
        }
        _ => {}
    }
    (b.lo.x <= b.hi.x).then_some(b)
}

/// Distance from the origin to the convex hull of 2D points (0 inside).
fn hull_distance(pts: &[Vec2]) -> f64 {
    // Gift wrapping (at most 8 points).
    let n = pts.len();
    if n == 0 {
        return f64::INFINITY;
    }
    let mut start = 0;
    for i in 1..n {
        if (pts[i].x, pts[i].y) < (pts[start].x, pts[start].y) {
            start = i;
        }
    }
    let mut hull = vec![start];
    let mut cur = start;
    loop {
        let mut next = (cur + 1) % n;
        for i in 0..n {
            let a = pts[next] - pts[cur];
            let b = pts[i] - pts[cur];
            let cr = a.perp_dot(b);
            if cr < 0.0 || (cr == 0.0 && b.norm() > a.norm()) {
                next = i;
            }
        }
        if next == start || hull.len() > n {
            break;
        }
        hull.push(next);
        cur = next;
    }
    let seg_dist = |a: Vec2, b: Vec2| -> f64 {
        let d = b - a;
        let l2 = d.dot(d);
        let t = if l2 > 0.0 {
            (-a.dot(d) / l2).clamp(0.0, 1.0)
        } else {
            0.0
        };
        (a + d * t).norm()
    };
    let m = hull.len();
    if m < 3 {
        return (0..m)
            .map(|i| seg_dist(pts[hull[i]], pts[hull[(i + 1) % m]]))
            .fold(f64::INFINITY, f64::min);
    }
    // Inside a counter-clockwise hull: every edge has the origin on its left.
    let inside = (0..m).all(|i| {
        let a = pts[hull[i]];
        let b = pts[hull[(i + 1) % m]];
        (b - a).perp_dot(-a) >= 0.0
    });
    if inside {
        return 0.0;
    }
    (0..m)
        .map(|i| seg_dist(pts[hull[i]], pts[hull[(i + 1) % m]]))
        .fold(f64::INFINITY, f64::min)
}

/// `(ρ_min, ρ_max, z_min, z_max)` of a box in the thread frame (conservative).
fn box_ranges(g: &Geo, b: &Bx) -> (f64, f64, f64, f64) {
    let mut pts = Vec::with_capacity(8);
    let (mut zlo, mut zhi, mut rhi) = (f64::INFINITY, f64::NEG_INFINITY, 0.0f64);
    for c in b.corners() {
        let l = g.frame.to_local_point(c);
        zlo = zlo.min(l.z);
        zhi = zhi.max(l.z);
        rhi = rhi.max(math::hypot(l.x, l.y));
        pts.push(Vec2::new(l.x, l.y));
    }
    // Rounding of the frame transform: pad by a relative epsilon.
    let pad = 1e-12 * (1.0 + rhi + zlo.abs().max(zhi.abs()));
    (
        (hull_distance(&pts) - pad).max(0.0),
        rhi + pad,
        zlo - pad,
        zhi + pad,
    )
}

/// `(ρ_min, ρ_max)` of an edge lying in a plane across the axis (conservative).
fn edge_radial_range(g: &Geo, c: &Curve3, r: (f64, f64)) -> (f64, f64) {
    let rho = |p: Point3| {
        let l = g.frame.to_local_point(p);
        math::hypot(l.x, l.y)
    };
    match c {
        Curve3::Line(_) => {
            let (a, b) = (
                g.frame.to_local_point(c.eval(r.0)),
                g.frame.to_local_point(c.eval(r.1)),
            );
            let (a, b) = (Vec2::new(a.x, a.y), Vec2::new(b.x, b.y));
            let d = b - a;
            let l2 = d.dot(d);
            let t = if l2 > 0.0 {
                (-a.dot(d) / l2).clamp(0.0, 1.0)
            } else {
                0.0
            };
            ((a + d * t).norm(), a.norm().max(b.norm()))
        }
        Curve3::Circle(k) => {
            let cd = rho(k.frame().origin());
            if cd <= LINEAR_TOLERANCE && k.frame().z().cross(g.z()).norm() <= AXIS_EPS {
                (k.radius(), k.radius())
            } else {
                ((cd - k.radius()).max(0.0), cd + k.radius())
            }
        }
        _ => {
            let (lo, hi, _, _) = box_ranges(g, &curve_box(c, r));
            (lo, hi)
        }
    }
}

/// Winding number of face `f`'s boundary (a plane across the axis) around the axis, given
/// that every boundary point lies at least `min_r > 0` from it: the sum of the angles its
/// edges subtend, sampled finely enough that no step turns by π/2 or more.
fn winding_about_axis(body: &Body, g: &Geo, f: FaceId, min_r: f64) -> Option<i64> {
    let face = body.face(f)?;
    let mut total = 0.0;
    for &lid in &face.loops {
        let lp = body.loop_(lid)?;
        for &cid in &lp.coedges {
            let c = body.coedge(cid)?;
            let e = body.edge(c.edge)?;
            let (t0, t1) = e.t_range;
            // Arc length bound: chord steps of at most min_r keep each step under 60°.
            let len = e.curve.arc_length(t0, t1).max(1e-12);
            let n = ((len / min_r).ceil() as usize).clamp(4, 100_000);
            let ang = |t: f64| {
                let l = g.frame.to_local_point(e.curve.eval(t));
                math::atan2(l.y, l.x)
            };
            let mut prev = ang(if c.forward { t0 } else { t1 });
            for k in 1..=n {
                let s = k as f64 / n as f64;
                let t = if c.forward {
                    t0 + (t1 - t0) * s
                } else {
                    t1 - (t1 - t0) * s
                };
                let a = ang(t);
                let mut d = a - prev;
                if d > math::PI {
                    d -= math::TAU;
                } else if d < -math::PI {
                    d += math::TAU;
                }
                total += d;
                prev = a;
            }
        }
    }
    Some((total / math::TAU).round() as i64)
}

/// Check the thread's region (see the module docs).
pub(super) fn check(
    body: &Body,
    crest: FaceId,
    g: &Geo,
    zs: [f64; 2],
    ends: &[EndKind; 2],
) -> Result<(), ThreadError> {
    let m = CLEARANCE;
    let reg = Region {
        r: (g.rc.min(g.rr) - m, g.rc.max(g.rr) + m),
        z: (zs[0] - m, zs[1] + m),
    };
    let interference = |f: FaceId| ThreadError::Interference {
        face: body
            .face(f)
            .map(|x| x.provenance.name())
            .unwrap_or_default(),
        r_in: reg.r.0,
        r_out: reg.r.1,
        z_start: reg.z.0,
        z_end: reg.z.1,
    };
    // Plane ends: the plane's other boundary stays out of the annulus.
    for end in ends {
        if let EndKind::Plane(r) = end {
            let f = body
                .face(r.neighbor)
                .ok_or_else(|| ThreadError::internal("neighbour"))?;
            for &lid in &f.loops {
                let lp = body
                    .loop_(lid)
                    .ok_or_else(|| ThreadError::internal("loop"))?;
                for &cid in &lp.coedges {
                    let c = body
                        .coedge(cid)
                        .ok_or_else(|| ThreadError::internal("coedge"))?;
                    if c.edge == r.edge {
                        continue;
                    }
                    let e = body
                        .edge(c.edge)
                        .ok_or_else(|| ThreadError::internal("edge"))?;
                    let (lo, hi) = edge_radial_range(g, &e.curve, e.t_range);
                    if !reg.clear_radially(lo, hi) {
                        return Err(interference(r.neighbor));
                    }
                }
            }
        }
    }
    let skip = |f: FaceId| {
        f == crest
            || ends
                .iter()
                .any(|e| e.ring().is_some_and(|r| r.neighbor == f))
    };
    for (fid, face) in body.faces().iter() {
        if skip(fid) {
            continue;
        }
        if face_clear(body, g, &reg, fid, &face.surface) != Some(true) {
            return Err(interference(fid));
        }
    }
    Ok(())
}

/// `Some(true)` if face `fid` is proven clear of the region.
fn face_clear(body: &Body, g: &Geo, reg: &Region, fid: FaceId, s: &Surface) -> Option<bool> {
    let z = g.z();
    let local = |p: Point3| g.frame.to_local_point(p);
    // Surface-specific exact bounds.
    match s {
        Surface::Plane(p) => {
            let n = p.frame().z();
            if n.cross(z).norm() <= AXIS_EPS {
                let zp = local(p.frame().origin()).z;
                if reg.clear_axially(zp, zp) {
                    return Some(true);
                }
                // Across the region's heights: clear only if its boundary stays outside the
                // annulus radially and the face does not contain the axis point.
                let mut lo = f64::INFINITY;
                let mut hi: f64 = 0.0;
                for e in body.face_edges(fid) {
                    let e = body.edge(e)?;
                    let (a, b) = edge_radial_range(g, &e.curve, e.t_range);
                    lo = lo.min(a);
                    hi = hi.max(b);
                }
                if hi < reg.r.0 && winding_about_axis(body, g, fid, lo.max(1e-9))? == 0 {
                    return Some(true);
                }
                if lo > reg.r.1 && winding_about_axis(body, g, fid, lo)? == 0 {
                    return Some(true);
                }
                return Some(false);
            }
            if n.dot(z).abs() <= AXIS_EPS {
                // The axis runs parallel to the plane at this distance.
                let dist = (p.frame().origin() - g.frame.origin()).dot(n).abs();
                if dist > reg.r.1 {
                    return Some(true);
                }
            }
        }
        Surface::Cylinder(c) => {
            let parallel = c.frame().z().cross(z).norm() <= AXIS_EPS;
            if parallel {
                let o = local(c.frame().origin());
                let cd = math::hypot(o.x, o.y);
                let (zlo, zhi) = axial_extent(body, g, fid)?;
                if reg.clear_axially(zlo, zhi) {
                    return Some(true);
                }
                if cd <= LINEAR_TOLERANCE {
                    return Some(reg.clear_radially(c.radius(), c.radius()));
                }
                if cd - c.radius() > reg.r.1 {
                    return Some(true);
                }
            }
        }
        Surface::Cone(c) => {
            let o = local(c.frame().origin());
            if math::hypot(o.x, o.y) <= LINEAR_TOLERANCE
                && c.frame().z().cross(z).norm() <= AXIS_EPS
            {
                let (zlo, zhi) = axial_extent(body, g, fid)?;
                if reg.clear_axially(zlo, zhi) {
                    return Some(true);
                }
                // The radius is linear in the height: extreme at the extent's ends (or 0 at
                // the apex, if the face reaches it).
                let s = c.frame().z().dot(z);
                let v_of = |zz: f64| s * (zz - o.z);
                let (ra, rb) = (c.radius_at(v_of(zlo)).abs(), c.radius_at(v_of(zhi)).abs());
                let apex_z = o.z + s * c.apex_v();
                let lo = if apex_z >= zlo && apex_z <= zhi {
                    0.0
                } else {
                    ra.min(rb)
                };
                return Some(reg.clear_radially(lo, ra.max(rb)));
            }
        }
        Surface::Sphere(sp) => {
            let o = local(sp.frame().origin());
            if math::hypot(o.x, o.y) - sp.radius() > reg.r.1 {
                return Some(true);
            }
        }
        _ => {}
    }
    // Generic: the face's box.
    let b = face_box(body, fid)?;
    let (rlo, rhi, zlo, zhi) = box_ranges(g, &b);
    Some(reg.clear_axially(zlo, zhi) || reg.clear_radially(rlo, rhi))
}

/// The axial extent (thread frame) of a face's boundary: exact for circles across the axis
/// and lines, from the edge's box otherwise.
fn axial_extent(body: &Body, g: &Geo, f: FaceId) -> Option<(f64, f64)> {
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for e in body.face_edges(f) {
        let e = body.edge(e)?;
        let (a, b) = match &e.curve {
            Curve3::Circle(k) if k.frame().z().cross(g.z()).norm() <= AXIS_EPS => {
                let zc = g.frame.to_local_point(k.frame().origin()).z;
                (zc, zc)
            }
            Curve3::Line(_) => {
                let za = g.frame.to_local_point(e.curve.eval(e.t_range.0)).z;
                let zb = g.frame.to_local_point(e.curve.eval(e.t_range.1)).z;
                (za.min(zb), za.max(zb))
            }
            c => {
                let (_, _, a, b) = box_ranges(g, &curve_box(c, e.t_range));
                (a, b)
            }
        };
        lo = lo.min(a);
        hi = hi.max(b);
    }
    (lo <= hi).then_some((lo - 1e-12 * (1.0 + lo.abs()), hi + 1e-12 * (1.0 + hi.abs())))
}
