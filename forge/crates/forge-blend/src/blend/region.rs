//! **Obstacles**: nothing of the input body may lie in the material a blend removes (a
//! convex edge) or fills (a concave edge) — a hole, a boss, a channel, a pocket that runs
//! through the blended region would otherwise be left inside the new body's volume or
//! hanging outside it, and the result would be silently wrong. A blend cannot be trimmed by
//! such a feature here. SPEC §6.6 defines the rolling ball there (OCCT builds it, trimmed
//! around the feature) and gives no size limit for it (W6 review round 6), so a hit on
//! another feature is an **obstacle** ([`super::Violation::obstacle`]): when it binds, the
//! operation is `*_FAILED` naming the feature's face — a capability gap, with the largest value
//! that builds clear of it in the reason — never `*_TOO_LARGE`. A hit on the **outer
//! boundary** of a face the blend touches or ends on (the strip a contact sweeps reaching the
//! face's far edge) is that face's own width: a size limit (`face-width`).
//!
//! # The regions
//! - **Prism** of a blended edge: its cross-section region `D` (the triangle `E, P_a, P_b`
//!   between the edge point and the contact points, outside the ball for a fillet, on the
//!   edge's side of the bevel line for a chamfer; a curved face's side of it is the face's
//!   circle from `E` to its contact, and `D` stays within the contacts' distance of `E`)
//!   swept along the edge. Its sides on the two
//!   faces are **closed** (a boundary point of face `a` inside the strip the blend removes
//!   from `a` is an obstacle: a hole's rim, a boss's root), and so are its ends: the face the
//!   blend ends on (`one`), the cross-section at a tangent vertex, the mitre plane, the plane
//!   of a corner patch's closing curve. The profile (arc or bevel) is closed **with a
//!   margin**: points within `M` of the new blend surface on its far side count too — an
//!   obstacle touching the blend surface (a drill point exactly on the bevel) would leave the
//!   result touching itself, a degenerate body (W6 review round 3: the supremum of such a
//!   range is never suggested).
//! - **Cell** of a three-edge corner: inside the three faces (closed), on the vertex's side of
//!   the three closing planes (closed), outside the corner ball less `M` (or on a face) —
//!   for a chamfer, on the vertex's side of the corner plane moved `M` away from it.
//!
//! # The tests (exact where the geometry allows)
//! A body entity meets a closed region iff one of its points lies in it or it crosses the
//! region's boundary. Its boundary pieces on the faces cannot be crossed transversally by an
//! edge of a valid body except at the edge's end points (the faces would intersect), so for
//! every edge of the input (except the blended edge and the edges at its end vertices, which
//! the construction trims):
//! 1. every **vertex** (and one point of every ring edge, and of every face without loops) is
//!    tested for membership;
//! 2. every edge is intersected (forge-ssi's certified curve–surface intersection) with the
//!    region's other boundary surfaces: the profile offset by `M` away from the region
//!    (cylinder, torus, plane or cone; the corner sphere or plane), the walls on the faces `M`
//!    short of the contact curves, the closed end planes; a hit that satisfies the region's
//!    other constraints is inside it;
//! 3. a **curved face** can cross the region while its whole boundary stays outside it: a
//!    ball-end hole's tip poking into a fillet, an undercut cavity or a drill point crossing
//!    a **planar** bevel, a closed void (a face without loops) straddling a profile or a
//!    mitre plane (W6 review round 3: planar profiles and faces without loops were skipped).
//!    Such a face must cross one of the region's **open pieces** — the profile, or a closing
//!    plane inside the material (the sides on the blended faces and the end faces are faces
//!    of the body, crossed only through a hole whose edges steps 1–2 find): forge-ssi's
//!    surface–surface intersection of each open piece with the face over the face's whole
//!    parameter box (its poles and apex included, [`crate::interfere::face_uvbox`]). Along a
//!    branch, membership in the region changes only where the branch crosses a surface on
//!    which one of the region's constraints changes sign (the other pieces, the blended
//!    faces' surfaces, the fillet's hypotenuse, the end faces: certified curve–surface hits)
//!    and membership in the face only where the face's boundary meets the piece (step 2):
//!    each piece of the branch between those crossings is tested at its middle and quarter
//!    points (region membership, and point in face with a clearance certificate), and so is
//!    every tangential contact point. Planar faces cannot cross the region that way. A
//!    B-spline face whose box meets the region cannot be certified clear (forge-ssi has no
//!    B-spline surfaces), nor can a face that cannot be bounded: both are undecided.
//!
//! Every hit is an `Infeasible` violation (`face-width`, naming the obstacle's face: the
//! feature's own face rather than a face the blend touches or ends on), flagged as an
//! obstacle unless the entity hit lies on the outer boundary of such a face; the feasible
//! range is searched as for any other limit, and [`super::finish`] decides the code. A test that cannot be certified — an
//! intersection forge-ssi cannot certify, a face near the region that cannot be bounded or
//! is free-form (forge-ssi has no B-spline surfaces), a point-in-face test without a
//! certificate — is **undecided** (W6 review round 5): never an unchecked result, and never
//! a size limit either: the attempt is `Unverified` (`*_FAILED` naming the obstacle's face)
//! unless a proven hit is found too.

use forge_core::geom::{Cone, Curve3, Cylinder, Plane, Sphere, Surface, Torus};
use forge_core::linalg::{Point3, Vec2, Vec3};
use forge_core::math;
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ssi::{SsiTolerance, UvBox, intersect_curve_surface, intersect_surfaces};

use super::edge::{Eg, Fam, Prof};
use super::section::Sec;
use super::{St, Violation};
use crate::error::Limit;
use crate::geom::frame_zx;
use crate::plan::Plan;

/// Closedness tolerance (mm): a point this close to a closed side counts as on it.
const EPS: f64 = LINEAR_TOLERANCE;
/// Strictness margin (mm) at the profile.
const M: f64 = 10.0 * LINEAR_TOLERANCE;

/// How the material of a blend ends at one vertex.
#[derive(Clone, Copy, Debug)]
pub(crate) enum EndKind {
    /// On the face (plane) through `o` with **outward** normal `n` (the blend ends on it).
    Face { o: Point3, n: Vec3 },
    /// At the plane through `o` with normal `n` pointing **into** the region (a tangent
    /// cross-section, a mitre, a corner patch's closing plane).
    Plane { o: Point3, n: Vec3 },
    /// On face `f` of the input, which is not a plane across the cross-section (a curved
    /// face, or a plane oblique to a circle blend's meridians): the region lies inside its
    /// surface (outward signed distance ≤ 0). `window`: the stations the blend's end curve
    /// spans, with the vertex's (a circle blend's angular window extends to it); `bx`: a box
    /// of that end of the region.
    OnFace {
        f: usize,
        window: (f64, f64),
        bx: (Point3, Point3),
    },
}

/// What bounds a corner cell away from the vertex.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Interior {
    /// Outside the corner ball (fillet).
    Ball { c: Point3, r: f64 },
    /// On the vertex's side of the corner plane through `o` (`n` points towards the vertex).
    Plane { o: Point3, n: Vec3 },
}

/// The material a three-edge corner patch removes or fills.
#[derive(Clone, Debug)]
pub(crate) struct Cell {
    pub v: usize,
    pub edges: Vec<usize>,
    /// `(face, point, normal into the cell)` of the three faces (closed): the cell is on the
    /// material side of a convex corner's faces, on the air side of a concave one's.
    pub faces: Vec<(usize, Point3, Vec3)>,
    /// Closing planes `(point, normal into the cell)` (closed).
    pub planes: Vec<(Point3, Vec3)>,
    pub interior: Interior,
}

/// The piece of a region's boundary a hit lies on (its constraint is then relaxed).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Piece {
    Profile,
    WallA,
    WallB,
    End(usize),
    CellPlane(usize),
}

/// One side of a prism's cross-section: the face's curve through `E` ([`Sec`]), up to its
/// contact point. The region lies on the side of the curve towards the other face.
#[derive(Clone, Copy, Debug)]
struct Side {
    sec: Sec,
    /// Unit tangent of the face at `E`, into it.
    t: Vec2,
    /// Unit normal at `E` towards the region.
    n: Vec2,
    /// How far the contact is along the face from `E`: a distance on a line, an angle
    /// (radians) on a circle.
    reach: f64,
    /// A circle: whether the region lies on its centre's side.
    inside: bool,
}

impl Side {
    fn new(e2: Vec2, sec: Sec, t: Vec2, other: Vec2, p: Vec2) -> Option<Self> {
        let n = inward_normal(t, other);
        let (reach, inside) = match sec {
            Sec::Line => ((p - e2).dot(t), false),
            Sec::Circle { c, .. } => (arc_along(e2, t, c, p), (c - e2).dot(n) > 0.0),
        };
        (reach.is_finite() && reach > 0.0).then_some(Self {
            sec,
            t,
            n,
            reach,
            inside,
        })
    }
    /// Signed distance of `q` from the face's curve, positive on the region's side.
    fn dist(&self, e2: Vec2, q: Vec2) -> f64 {
        match self.sec {
            Sec::Line => (q - e2).dot(self.n),
            Sec::Circle { c, r } => {
                let d = (q - c).norm();
                if self.inside { r - d } else { d - r }
            }
        }
    }
    /// Position of a point of the face's curve along it from `E` (the unit of `reach`).
    fn along(&self, e2: Vec2, q: Vec2) -> f64 {
        match self.sec {
            Sec::Line => (q - e2).dot(self.t),
            Sec::Circle { c, .. } => arc_along(e2, self.t, c, q),
        }
    }
    /// The margin `M` in the unit of `reach`.
    fn margin(&self) -> f64 {
        match self.sec {
            Sec::Line => M,
            Sec::Circle { r, .. } => M / r,
        }
    }
    /// The point of the curve at `along = x`, and the unit tangent there.
    fn at(&self, e2: Vec2, x: f64) -> (Vec2, Vec2) {
        match self.sec {
            Sec::Line => (e2 + self.t * x, self.t),
            Sec::Circle { c, .. } => {
                let a = e2 - c;
                let ccw = a.perp_dot(self.t) > 0.0;
                let (s, co) = math::sin_cos(if ccw { x } else { -x });
                let q = Vec2::new(a.x * co - a.y * s, a.x * s + a.y * co);
                let tan = Vec2::new(-q.y, q.x).normalize().unwrap_or(self.t);
                (c + q, if ccw { tan } else { -tan })
            }
        }
    }
}

/// The signed angle from `e` to `q` about `c`, in the direction `t` leaves `e`.
fn arc_along(e: Vec2, t: Vec2, c: Vec2, q: Vec2) -> f64 {
    let (a, b) = (e - c, q - c);
    let ang = math::atan2(a.perp_dot(b), a.dot(b));
    if a.perp_dot(t) > 0.0 { ang } else { -ang }
}

/// The prism of one blended edge.
struct Prism<'a> {
    g: &'a Eg,
    ends: [Option<EndKind>; 2],
    /// The surfaces (and senses) of the faces the blend ends on at `OnFace` ends.
    end_surf: [Option<(Surface, bool)>; 2],
    /// The sides on faces `a` and `b`.
    sides: [Side; 2],
    /// The cross-section lies within this distance of `E` (its farthest points are the
    /// contacts: the faces' arcs from `E` are under a quarter turn and the profile faces
    /// `E`). With a curved side, the other constraints alone admit far pieces of the
    /// cross-section plane (the flat's other end on a D-flat's circle, the air above a dome).
    rmax: f64,
    /// Fillet: the hypotenuse (point, normal towards `E`), closed.
    hyp: Option<(Vec2, Vec2)>,
    /// Chamfer: the bevel line (point, normal towards `E`), strict.
    bevel: Option<(Vec2, Vec2)>,
    /// The two vertices of the edge (none for a ring).
    verts: Vec<usize>,
}

fn inward_normal(dir: Vec2, toward: Vec2) -> Vec2 {
    let n = Vec2::new(-dir.y, dir.x);
    if n.dot(toward) >= 0.0 { n } else { -n }
}

impl<'a> Prism<'a> {
    fn new(plan: &Plan, g: &'a Eg, ends: [Option<EndKind>; 2]) -> Option<Self> {
        let end_surf = ends.map(|x| match x {
            Some(EndKind::OnFace { f, .. }) => {
                plan.fs[f].as_ref().map(|pf| (pf.surf.clone(), pf.sense))
            }
            _ => None,
        });
        let sides = [
            Side::new(g.e2, g.sec[0], g.ta, g.tb, g.pa)?,
            Side::new(g.e2, g.sec[1], g.tb, g.ta, g.pb)?,
        ];
        let rmax = (g.pa - g.e2).norm().max((g.pb - g.e2).norm());
        let chord = (g.pb - g.pa).normalize()?;
        let cn = inward_normal(chord, g.e2 - g.pa);
        let (hyp, bevel) = if g.is_fillet() {
            (Some((g.pa, cn)), None)
        } else {
            (None, Some((g.pa, cn)))
        };
        let pe = &plan.es[g.e];
        Some(Self {
            g,
            ends,
            end_surf,
            sides,
            rmax,
            hyp,
            bevel,
            verts: [pe.start, pe.end].into_iter().flatten().collect(),
        })
    }

    /// Station window test (closed) for the circle family: angles within the edge's range.
    fn angular_ok(&self, st: f64, rho: f64) -> bool {
        let Some((s0, s1)) = self.window() else {
            return true;
        };
        let tol = EPS / rho.max(1e-9);
        let mut a = crate::geom::wrap(st - s0);
        if a > math::TAU - tol {
            a -= math::TAU;
        }
        a >= -tol && a <= (s1 - s0) + tol
    }

    /// The station window: the edge's, widened to the end curves of `OnFace` ends.
    fn window(&self) -> Option<(f64, f64)> {
        let (mut s0, mut s1) = self.g.st_range?;
        if let Some(EndKind::OnFace { window, .. }) = self.ends[0] {
            s0 = s0.min(window.0);
        }
        if let Some(EndKind::OnFace { window, .. }) = self.ends[1] {
            s1 = s1.max(window.1);
        }
        Some((s0, s1))
    }

    /// Inside the faces the blend ends on at `OnFace` ends.
    fn inside_end_faces(&self, q: Point3) -> bool {
        self.end_surf.iter().flatten().all(|(surf, sense)| {
            let (u, v, _) = surf.project(q);
            let Some(n) = surf.normal(u, v) else {
                return true;
            };
            let n = if *sense { n } else { -n };
            (q - surf.eval(u, v)).dot(n) <= EPS
        })
    }

    fn test(&self, q: Point3, relax: Option<Piece>) -> bool {
        let g = self.g;
        if !self.inside_end_faces(q) {
            return false;
        }
        let (st, p) = g.fam.to2(q);
        let [sa, sb] = &self.sides;
        let (da, db) = (sa.dist(g.e2, p), sb.dist(g.e2, p));
        if da < -EPS || db < -EPS || (p - g.e2).norm() > self.rmax + EPS {
            return false;
        }
        if let Some((h0, hn)) = self.hyp
            && (p - h0).dot(hn) < -EPS
        {
            return false;
        }
        match g.fam {
            Fam::Line { .. } => {
                for (k, end) in self.ends.iter().enumerate() {
                    if relax == Some(Piece::End(k)) {
                        continue;
                    }
                    match end {
                        Some(EndKind::Face { o, n }) => {
                            if (q - *o).dot(*n) > EPS {
                                return false;
                            }
                        }
                        Some(EndKind::Plane { o, n }) => {
                            if (q - *o).dot(*n) < -EPS {
                                return false;
                            }
                        }
                        Some(EndKind::OnFace { .. }) | None => {}
                    }
                }
            }
            Fam::Circle { .. } => match (relax, self.window()) {
                (Some(Piece::End(k)), Some((s0, s1))) => {
                    // On the end's meridian plane: its half at the end angle, not the
                    // opposite one.
                    let target = if k == 0 { s0 } else { s1 };
                    let d = crate::geom::wrap(st - target + math::PI) - math::PI;
                    if d.abs() > math::FRAC_PI_2 {
                        return false;
                    }
                }
                _ => {
                    if !self.angular_ok(st, p.x) {
                        return false;
                    }
                }
            },
        }
        // Strictly inside the profile, or on a face within its strip.
        let profile = relax == Some(Piece::Profile)
            || match (self.bevel, g.is_fillet()) {
                (Some((b0, bn)), _) => (p - b0).dot(bn) > -M,
                (None, true) => (p - g.c2).norm() > g.r - M,
                _ => false,
            };
        let on = |sd: &Side, d: f64, wall: Piece| {
            let x = sd.along(g.e2, p);
            d.abs() <= EPS
                && x >= -sd.margin()
                && (x < sd.reach - sd.margin() || relax == Some(wall))
        };
        profile || on(sa, da, Piece::WallA) || on(sb, db, Piece::WallB)
    }

    /// The boundary surfaces a crossing edge must hit, with the piece each one is.
    fn surfaces(&self) -> Vec<(Surface, Piece)> {
        let g = self.g;
        let mut out = Vec::new();
        // Profile, offset by M away from the region (closed with a margin).
        let prof = match (g.fam, g.is_fillet()) {
            (Fam::Line { t, .. }, true) => {
                frame_zx(g.fam.to3(0.0, g.c2), t, g.fam.vec3(0.0, self.sides[0].t))
                    .and_then(|fr| Cylinder::new(fr, g.r - M).ok())
                    .map(Surface::Cylinder)
            }
            (Fam::Circle { o, z, x0, .. }, true) => {
                let major = g.c2.x;
                let minor = g.r - M;
                frame_zx(o + z * g.c2.y, z, x0)
                    .and_then(|fr| {
                        if major >= minor {
                            Torus::new(fr, major, minor).ok()
                        } else if major > 0.0 {
                            Torus::spindle(fr, major, minor, forge_core::geom::SpindlePatch::Outer)
                                .ok()
                        } else {
                            None
                        }
                    })
                    .map(Surface::Torus)
            }
            (_, false) => {
                let (_, bn) = self.bevel.expect("bevel");
                let (pa, pb) = (g.pa - bn * M, g.pb - bn * M);
                match g.fam {
                    Fam::Line { t, .. } => frame_zx(g.fam.to3(0.0, pa), g.fam.vec3(0.0, bn), t)
                        .map(|fr| Surface::Plane(Plane::new(fr))),
                    Fam::Circle { o, z, x0, .. } => revolution(o, z, x0, pa, pb),
                }
            }
        };
        out.extend(prof.map(|s| (s, Piece::Profile)));
        // Walls on the faces, M short of the contact curves: a surface across the face
        // through the strip's boundary (for a curved face, along its normal there).
        for (sd, piece) in [(self.sides[0], Piece::WallA), (self.sides[1], Piece::WallB)] {
            let (at, dir) = sd.at(g.e2, sd.reach - sd.margin());
            let wall = match (g.fam, sd.sec) {
                (Fam::Line { t, .. }, _) => frame_zx(g.fam.to3(0.0, at), g.fam.vec3(0.0, dir), t)
                    .map(|fr| Surface::Plane(Plane::new(fr))),
                (Fam::Circle { o, z, x0, .. }, Sec::Circle { c, .. }) => {
                    revolution(o, z, x0, c, at)
                }
                (Fam::Circle { o, z, x0, .. }, Sec::Line) => {
                    if dir.y.abs() <= 1e-9 {
                        // A plane perpendicular to the axis: the wall is a coaxial cylinder.
                        (at.x > 0.0)
                            .then(|| frame_zx(o, z, x0))
                            .flatten()
                            .and_then(|fr| Cylinder::new(fr, at.x).ok())
                            .map(Surface::Cylinder)
                    } else {
                        // A cylinder or cone: the wall is the plane across the axis there.
                        frame_zx(o + z * at.y, z, x0).map(|fr| Surface::Plane(Plane::new(fr)))
                    }
                }
            };
            out.extend(wall.map(|s| (s, piece)));
        }
        // Closed end planes.
        match g.fam {
            Fam::Line { t, .. } => {
                for (k, end) in self.ends.iter().enumerate() {
                    if let Some(EndKind::Plane { o, n }) = end
                        && let Some(fr) = frame_zx(*o, *n, t.cross(*n))
                    {
                        out.push((Surface::Plane(Plane::new(fr)), Piece::End(k)));
                    }
                }
            }
            Fam::Circle { o, z, .. } => {
                if let Some((s0, s1)) = self.window() {
                    for (k, s) in [(0usize, s0), (1usize, s1)] {
                        let n = g.fam.tangent(s);
                        if let Some(fr) = frame_zx(o, n, z) {
                            out.push((Surface::Plane(Plane::new(fr)), Piece::End(k)));
                        }
                    }
                }
            }
        }
        out
    }

    /// Every surface on which one of [`Prism::test`]'s constraints changes sign: the
    /// boundary pieces ([`Prism::surfaces`]), the two faces' lines (`da`, `db`), the fillet's
    /// hypotenuse and the faces the blend ends on. Along a curve, membership in the region
    /// (with any one piece relaxed) can change only where the curve crosses one of them.
    fn constraint_surfaces(&self) -> Vec<(Surface, Option<Piece>)> {
        let g = self.g;
        let mut out: Vec<(Surface, Option<Piece>)> = self
            .surfaces()
            .into_iter()
            .map(|(s, p)| (s, Some(p)))
            .collect();
        let line = |p0: Vec2, dir: Vec2| -> Option<Surface> {
            match g.fam {
                Fam::Line { t, .. } => {
                    let n = Vec2::new(-dir.y, dir.x);
                    frame_zx(g.fam.to3(0.0, p0), g.fam.vec3(0.0, n), t)
                        .map(|fr| Surface::Plane(Plane::new(fr)))
                }
                Fam::Circle { o, z, x0, .. } => revolution(o, z, x0, p0, p0 + dir),
            }
        };
        for sd in &self.sides {
            let face = match (sd.sec, g.fam) {
                (Sec::Line, _) => line(g.e2, sd.t),
                (Sec::Circle { c, r }, Fam::Line { t, .. }) => {
                    frame_zx(g.fam.to3(0.0, c), t, g.fam.vec3(0.0, sd.t))
                        .and_then(|fr| Cylinder::new(fr, r).ok())
                        .map(Surface::Cylinder)
                }
                (Sec::Circle { c, r }, Fam::Circle { o, z, x0, .. }) => {
                    let fr = frame_zx(o + z * c.y, z, x0);
                    if c.x.abs() <= EPS {
                        fr.and_then(|fr| Sphere::new(fr, r).ok())
                            .map(Surface::Sphere)
                    } else {
                        fr.and_then(|fr| Torus::new(fr, c.x, r).ok())
                            .map(Surface::Torus)
                    }
                }
            };
            out.extend(face.map(|s| (s, None)));
        }
        if let Some((h0, _)) = self.hyp {
            out.extend(line(h0, g.pb - g.pa).map(|s| (s, None)));
        }
        for (surf, _) in self.end_surf.iter().flatten() {
            out.push((surf.clone(), None));
        }
        // The bounding disk around `E`: a cylinder about the edge, or the torus (both
        // sheets of a spindle torus) its circle sweeps about the axis.
        match g.fam {
            Fam::Line { t, .. } => out.extend(
                frame_zx(g.fam.to3(0.0, g.e2), t, g.fam.vec3(0.0, self.sides[0].t))
                    .and_then(|fr| Cylinder::new(fr, self.rmax).ok())
                    .map(|c| (Surface::Cylinder(c), None)),
            ),
            Fam::Circle { o, z, x0, .. } => {
                if let Some(fr) = frame_zx(o + z * g.e2.y, z, x0) {
                    let (major, minor) = (g.e2.x, self.rmax);
                    if major >= minor {
                        out.extend(
                            Torus::new(fr, major, minor)
                                .ok()
                                .map(|t| (Surface::Torus(t), None)),
                        );
                    } else if major > 0.0 {
                        for sheet in [
                            forge_core::geom::SpindlePatch::Outer,
                            forge_core::geom::SpindlePatch::Inner,
                        ] {
                            out.extend(
                                Torus::spindle(fr, major, minor, sheet)
                                    .ok()
                                    .map(|t| (Surface::Torus(t), None)),
                            );
                        }
                    }
                }
            }
        }
        if let Fam::Line { t, .. } = g.fam {
            for end in self.ends.iter().flatten() {
                if let EndKind::Face { o, n } = end
                    && let Some(fr) = frame_zx(*o, *n, t.cross(*n))
                {
                    out.push((Surface::Plane(Plane::new(fr)), None));
                }
            }
        }
        out
    }

    /// A box containing the region (for pre-filtering).
    fn bbox(&self, plan: &Plan) -> (Point3, Point3) {
        let g = self.g;
        // The cross-section's corners, and points of a curved side's arc (the region bulges
        // out to it), with the sagitta of the arcs between them as padding.
        let mut tri = vec![g.e2, g.pa, g.pb];
        let mut sag: f64 = 0.0;
        for sd in &self.sides {
            if let Sec::Circle { r, .. } = sd.sec {
                const N: usize = 8;
                for k in 1..N {
                    tri.push(sd.at(g.e2, sd.reach * k as f64 / N as f64).0);
                }
                sag = sag.max(r * (1.0 - math::cos(0.5 * sd.reach / N as f64)));
            }
        }
        let mut pts: Vec<Point3> = Vec::new();
        match g.fam {
            Fam::Line { t, .. } => {
                let (s0, s1) = g.st_range.unwrap_or((0.0, 0.0));
                // The stations the ends reach at the triangle's corners.
                let mut lo = s0;
                let mut hi = s1;
                for (k, end) in self.ends.iter().enumerate() {
                    let s_end = if k == 0 { s0 } else { s1 };
                    let (o, n) = match end {
                        Some(EndKind::Face { o, n } | EndKind::Plane { o, n }) => (*o, *n),
                        Some(EndKind::OnFace { .. }) | None => continue,
                    };
                    let den = t.dot(n);
                    for &c in &tri {
                        let p0 = g.fam.to3(s_end, c);
                        let s = if den.abs() > 1e-12 {
                            s_end + (o - p0).dot(n) / den
                        } else {
                            s_end
                        };
                        if s.is_finite() {
                            lo = lo.min(s);
                            hi = hi.max(s);
                        }
                    }
                }
                for s in [lo, hi] {
                    for &c in &tri {
                        pts.push(g.fam.to3(s, c));
                    }
                }
            }
            Fam::Circle { o, z, .. } => {
                let rho = tri.iter().map(|c| c.x).fold(0.0, f64::max);
                for &c in &tri {
                    let h = o + z * c.y;
                    for axis in 0..3 {
                        let e = [Vec3::unit_x(), Vec3::unit_y(), Vec3::unit_z()][axis];
                        let k = (1.0 - z.dot(e).powi(2)).max(0.0).sqrt() * rho;
                        pts.push(h + e * k);
                        pts.push(h - e * k);
                    }
                }
            }
        }
        let _ = plan;
        for end in self.ends.iter().flatten() {
            if let EndKind::OnFace { bx, .. } = end {
                pts.push(bx.0);
                pts.push(bx.1);
            }
        }
        bounds(&pts, M + EPS + sag)
    }
}

/// The surface of revolution through the meridian points `pa`, `pb` (as the chamfer bevel).
fn revolution(o: Point3, z: Vec3, x0: Vec3, pa: Vec2, pb: Vec2) -> Option<Surface> {
    let (dr, dz) = (pb.x - pa.x, pb.y - pa.y);
    if dz.abs() <= 1e-12 * (1.0 + dr.abs()) {
        return frame_zx(o + z * pa.y, z, x0).map(|fr| Surface::Plane(Plane::new(fr)));
    }
    if dr.abs() <= 1e-12 * (1.0 + dz.abs()) {
        return frame_zx(o, z, x0)
            .and_then(|fr| Cylinder::new(fr, pa.x).ok())
            .map(Surface::Cylinder);
    }
    let sgn = if dr * dz > 0.0 { 1.0 } else { -1.0 };
    let alpha = math::atan(dr / (dz * sgn));
    frame_zx(o + z * pa.y, z * sgn, x0)
        .and_then(|fr| Cone::new(fr, pa.x, alpha).ok())
        .map(Surface::Cone)
}

impl Cell {
    fn test(&self, q: Point3, relax: Option<Piece>) -> bool {
        let mut on_face = false;
        for (_, o, n) in &self.faces {
            let d = (q - *o).dot(*n);
            if d < -EPS {
                return false;
            }
            on_face |= d.abs() <= EPS;
        }
        for (k, (o, n)) in self.planes.iter().enumerate() {
            if relax != Some(Piece::CellPlane(k)) && (q - *o).dot(*n) < -EPS {
                return false;
            }
        }
        match self.interior {
            Interior::Ball { c, r } => {
                relax == Some(Piece::Profile) || (q - c).norm() > r - M || on_face
            }
            Interior::Plane { o, n } => relax == Some(Piece::Profile) || (q - o).dot(n) > -M,
        }
    }

    fn surfaces(&self) -> Vec<(Surface, Piece)> {
        let mut out = Vec::new();
        match self.interior {
            Interior::Ball { c, r } => {
                if let Some(fr) = frame_zx(c, Vec3::unit_z(), Vec3::unit_x())
                    && let Ok(s) = Sphere::new(fr, r - M)
                {
                    out.push((Surface::Sphere(s), Piece::Profile));
                }
            }
            Interior::Plane { o, n } => {
                if let Some(fr) = frame_zx(
                    o - n * M,
                    n,
                    n.any_perpendicular().unwrap_or(Vec3::unit_x()),
                ) {
                    out.push((Surface::Plane(Plane::new(fr)), Piece::Profile));
                }
            }
        }
        for (k, (o, n)) in self.planes.iter().enumerate() {
            if let Some(fr) = frame_zx(*o, *n, n.any_perpendicular().unwrap_or(Vec3::unit_x())) {
                out.push((Surface::Plane(Plane::new(fr)), Piece::CellPlane(k)));
            }
        }
        out
    }

    /// Every surface on which one of [`Cell::test`]'s constraints changes sign: the boundary
    /// pieces and the three faces' planes.
    fn constraint_surfaces(&self) -> Vec<(Surface, Option<Piece>)> {
        let mut out: Vec<(Surface, Option<Piece>)> = self
            .surfaces()
            .into_iter()
            .map(|(s, p)| (s, Some(p)))
            .collect();
        for (_, o, n) in &self.faces {
            if let Some(fr) = frame_zx(*o, *n, n.any_perpendicular().unwrap_or(Vec3::unit_x())) {
                out.push((Surface::Plane(Plane::new(fr)), None));
            }
        }
        out
    }

    /// An exact box of the cell: the vertices of the polytope bounded by its faces' planes,
    /// its closing planes and (a chamfer's) corner plane — every point where three of those
    /// planes meet and all the constraints hold — padded by `M + EPS`; for a fillet's ball
    /// cell the polytope is the one the ball cuts, so it bounds the cell too. (W6 review
    /// round 3: the former reach, four times the corner plane's distance, is not a bound at
    /// an oblique vertex, whose corner points can lie farther out.)
    fn bbox(&self, plan: &Plan) -> (Point3, Point3) {
        let vp = plan.vs[self.v].p;
        let mut hs: Vec<(Point3, Vec3)> = self.faces.iter().map(|(_, o, n)| (*o, *n)).collect();
        hs.extend(self.planes.iter().copied());
        if let Interior::Plane { o, n } = self.interior {
            hs.push((o, n));
        }
        let mut pts: Vec<Point3> = vec![vp];
        let slack = 1e-9 * (1.0 + vp.norm());
        for i in 0..hs.len() {
            for j in (i + 1)..hs.len() {
                for k in (j + 1)..hs.len() {
                    let ns = [hs[i].1, hs[j].1, hs[k].1];
                    let ds = [hs[i].0, hs[j].0, hs[k].0]
                        .iter()
                        .zip(ns)
                        .map(|(o, n)| n.dot(*o))
                        .collect::<Vec<f64>>();
                    let Some(x) = crate::geom::three_planes(ns, [ds[0], ds[1], ds[2]]) else {
                        continue;
                    };
                    if hs.iter().all(|(o, n)| (x - *o).dot(*n) >= -slack) {
                        pts.push(x);
                    }
                }
            }
        }
        if pts.len() < 4 {
            // Not a bounded polytope (never at a three-edge corner): a box no cell exceeds.
            let reach = match self.interior {
                Interior::Ball { c, r } => (c - vp).norm() + r,
                Interior::Plane { .. } => 1e4,
            };
            return bounds(&[vp], reach + M);
        }
        bounds(&pts, M + EPS)
    }
}

fn bounds(pts: &[Point3], pad: f64) -> (Point3, Point3) {
    let mut lo = Point3::new(f64::INFINITY, f64::INFINITY, f64::INFINITY);
    let mut hi = -lo;
    for p in pts {
        lo = lo.min_components(*p);
        hi = hi.max_components(*p);
    }
    let d = Vec3::new(pad, pad, pad);
    (lo - d, hi + d)
}

fn boxes_meet(a: &(Point3, Point3), b: &(Point3, Point3)) -> bool {
    a.0.x <= b.1.x
        && b.0.x <= a.1.x
        && a.0.y <= b.1.y
        && b.0.y <= a.1.y
        && a.0.z <= b.1.z
        && b.0.z <= a.1.z
}

/// Sub-ranges of `range` outside which `c` certainly stays out of `bb`: the whole range for
/// analytic curves; for a B-spline, the unions of consecutive knot spans whose control
/// points' box (the span's convex hull) meets `bb`.
fn near_ranges(c: &Curve3, range: (f64, f64), bb: &(Point3, Point3)) -> Vec<(f64, f64)> {
    let Curve3::BSpline(n) = c else {
        return if boxes_meet(&curve_box(c, range), bb) {
            vec![range]
        } else {
            Vec::new()
        };
    };
    let p = n.degree();
    let k = n.knots();
    let cp = n.control_points();
    let mut out: Vec<(f64, f64)> = Vec::new();
    for j in p..cp.len() {
        let (lo, hi) = (k[j].max(range.0), k[j + 1].min(range.1));
        if hi <= lo {
            continue;
        }
        let pts: Vec<Point3> = (j - p..=j)
            .map(|i| Point3::new(cp[i][0], cp[i][1], cp[i][2]))
            .collect();
        if !boxes_meet(&bounds(&pts, 0.0), bb) {
            continue;
        }
        // Consecutive spans share their knot exactly.
        #[allow(clippy::float_cmp)]
        let joins = out.last().is_some_and(|last| last.1 == lo);
        match out.last_mut() {
            Some(last) if joins => last.1 = hi,
            _ => out.push((lo, hi)),
        }
    }
    out
}

/// A conservative box of an edge's curve over its range.
fn curve_box(c: &Curve3, range: (f64, f64)) -> (Point3, Point3) {
    match c {
        Curve3::Line(_) => bounds(&[c.eval(range.0), c.eval(range.1)], 0.0),
        Curve3::Circle(k) => disk_box(k.frame().origin(), k.frame().z(), k.radius()),
        Curve3::Ellipse(k) => disk_box(k.frame().origin(), k.frame().z(), k.rx().max(k.ry())),
        Curve3::BSpline(n) => {
            let pts: Vec<Point3> = n
                .control_points()
                .iter()
                .map(|p| Point3::new(p[0], p[1], p[2]))
                .collect();
            bounds(&pts, 0.0)
        }
    }
}

fn disk_box(c: Point3, z: Vec3, r: f64) -> (Point3, Point3) {
    let k = |e: Vec3| (1.0 - z.dot(e).powi(2)).max(0.0).sqrt() * r;
    let d = Vec3::new(k(Vec3::unit_x()), k(Vec3::unit_y()), k(Vec3::unit_z()));
    (c - d, c + d)
}

/// A rigorous box containing face `f`: its surface over its parameter box, which holds the
/// poles or apex the face contains and, for a face without loops (a closed void), the whole
/// surface ([`crate::interfere::face_box`]). W6 review round 3: the box of the boundary
/// padded by a radius missed a cap larger than a hemisphere, a drill point's apex and every
/// face without loops (which were then skipped).
fn face_box(plan: &Plan, f: usize) -> Option<(Point3, Point3)> {
    crate::interfere::face_box(plan, f)
}

/// One region to check.
enum Reg<'a> {
    Prism(Box<Prism<'a>>),
    Cell(&'a Cell),
}

impl Reg<'_> {
    fn test(&self, q: Point3, relax: Option<Piece>) -> bool {
        match self {
            Reg::Prism(p) => p.test(q, relax),
            Reg::Cell(c) => c.test(q, relax),
        }
    }
    fn surfaces(&self) -> Vec<(Surface, Piece)> {
        match self {
            Reg::Prism(p) => p.surfaces(),
            Reg::Cell(c) => c.surfaces(),
        }
    }
    fn constraint_surfaces(&self) -> Vec<(Surface, Option<Piece>)> {
        match self {
            Reg::Prism(p) => p.constraint_surfaces(),
            Reg::Cell(c) => c.constraint_surfaces(),
        }
    }
    /// The boundary pieces a face of the body can cross without an edge of the body
    /// crossing the region's boundary too: the profile and the closing planes that lie
    /// inside the body's material (not on its faces). The sides on the blended faces, and a
    /// face the blend ends on, are faces of the body: another face can only reach the region
    /// through them where they have a hole, whose edges steps 1–2 find.
    fn open_pieces(&self) -> Vec<(Surface, Piece)> {
        self.surfaces()
            .into_iter()
            .filter(|(_, p)| match (self, p) {
                (_, Piece::WallA | Piece::WallB) => false,
                (Reg::Prism(pr), Piece::End(k)) => {
                    !matches!(pr.ends[*k], Some(EndKind::Face { .. })) || !pr.g.fam.is_line()
                }
                _ => true,
            })
            .collect()
    }
    fn bbox(&self, plan: &Plan) -> (Point3, Point3) {
        match self {
            Reg::Prism(p) => p.bbox(plan),
            Reg::Cell(c) => c.bbox(plan),
        }
    }
    /// Vertices whose edges the construction trims (excluded from the tests).
    fn own_vertices(&self) -> Vec<usize> {
        match self {
            Reg::Prism(p) => p.verts.clone(),
            Reg::Cell(c) => vec![c.v],
        }
    }
    fn blended(&self) -> Vec<usize> {
        match self {
            Reg::Prism(p) => vec![p.g.e],
            Reg::Cell(c) => c.edges.clone(),
        }
    }
    /// The faces the region lies on (their own boundaries are checked by the crossings).
    fn own_faces(&self) -> Vec<usize> {
        match self {
            Reg::Prism(p) => vec![p.g.a, p.g.b],
            Reg::Cell(c) => c.faces.iter().map(|x| x.0).collect(),
        }
    }
}

/// Check every blend's prism and every corner cell of the attempt against the input body;
/// violations are pushed to `st.viol`.
pub(crate) fn check_obstacles(st: &mut St<'_>, _prof: Prof) {
    let cx = st.cx;
    let plan = cx.plan0;
    let adj = cx.adj;
    let mut regs: Vec<Reg<'_>> = Vec::new();
    let egs = st.egs.clone();
    let cells = st.cells.clone();
    for g in egs.values() {
        let pe = &plan.es[g.e];
        let ends = [pe.start, pe.end].map(|v| v.and_then(|v| st.endk.get(&(v, g.e)).copied()));
        if let Some(p) = Prism::new(plan, g, ends) {
            regs.push(Reg::Prism(Box::new(p)));
        }
    }
    for c in &cells {
        regs.push(Reg::Cell(c));
    }
    let scale = cx.scale.max(1.0);
    let tol = SsiTolerance::default();
    let bound = 4.0 * scale + 10.0;
    let mut found: Vec<Violation> = Vec::new();
    let mut undecided: Vec<(std::collections::BTreeSet<usize>, String)> = Vec::new();
    for reg in &regs {
        let own_v = reg.own_vertices();
        let blended = reg.blended();
        let own_f = reg.own_faces();
        // Faces around the region's own vertices continue it there (the construction joins
        // them): not obstacles for the surface test.
        let mut near_f: Vec<usize> = own_f.clone();
        for &v in &own_v {
            near_f.extend(adj.corners[v].iter().map(|c| c.face));
        }
        let bb = reg.bbox(plan);
        // The face named for a hit: the feature's own face, not a face the blend touches or
        // ends on (W6 review round 6: a tunnel through the end cap was named by the cap).
        let obstacle_face = |fs: Vec<usize>| -> Option<usize> {
            fs.iter()
                .copied()
                .find(|f| !near_f.contains(f))
                .or_else(|| fs.iter().copied().find(|f| !own_f.contains(f)))
                .or_else(|| fs.first().copied())
        };
        // Is the hit entity on the **own extent** of a face the blend touches or ends on (an
        // edge of a loop of such a face that does not bound a hole in it: the contact or the
        // end curve runs off that face, a face-width limit), or another feature of the body
        // (an obstacle, see [`super::Violation::obstacle`])?
        let own_edge = |e: usize| {
            near_f
                .iter()
                .any(|&f| super::limits::on_hole_loop(plan, f, e) == Some(false))
        };
        let own_vertex = |v: usize| adj.vertex_edges(v).into_iter().any(own_edge);
        // A proven hit (face named, what, whether it is an obstacle), and the first test that
        // could not be decided (W6 review round 5).
        let mut hit: Option<(Option<usize>, String, bool)> = None;
        let mut open: Option<(Option<usize>, String)> = None;
        // 1. Points: vertices, ring edges, faces without loops.
        for (v, pv) in plan.vs.iter().enumerate() {
            if own_v.contains(&v) || hit.is_some() {
                continue;
            }
            if reg.test(pv.p, None) {
                let fs: Vec<usize> = adj.corners[v].iter().map(|c| c.face).collect();
                hit = Some((obstacle_face(fs), "a vertex".into(), !own_vertex(v)));
            }
        }
        for (e, pe) in plan.es.iter().enumerate() {
            if hit.is_some() {
                break;
            }
            if pe.is_ring() && !blended.contains(&e) {
                let q = pe.curve.eval(0.5 * (pe.range.0 + pe.range.1));
                if reg.test(q, None) {
                    hit = Some((
                        obstacle_face(adj.edge_faces(e)),
                        "an edge".into(),
                        !own_edge(e),
                    ));
                }
            }
        }
        for (f, pf) in plan.fs.iter().enumerate() {
            if hit.is_some() {
                break;
            }
            if let Some(pf) = pf
                && pf.loops.is_empty()
            {
                let ((u0, u1), (v0, v1)) = pf.surf.domain();
                let mid = |a: f64, b: f64| {
                    if a.is_finite() && b.is_finite() {
                        0.5 * (a + b)
                    } else {
                        0.0
                    }
                };
                let q = pf.surf.eval(mid(u0, u1), mid(v0, v1));
                if reg.test(q, None) {
                    hit = Some((Some(f), "a closed face".into(), true));
                }
            }
        }
        // Singular points of curved faces (a drill point's apex, a sphere's pole): points of
        // the face that are no vertex, and where a face first enters the region as the value
        // grows — an exact membership test decides them, where the surface intersection of
        // step 3 meets a tangency (W6 review round 5).
        for f in 0..plan.fs.len() {
            if hit.is_some() {
                break;
            }
            if near_f.contains(&f) {
                continue;
            }
            for q in singular_points(plan, f) {
                if reg.test(q, None) {
                    hit = Some((Some(f), "a face's apex or pole".into(), true));
                    break;
                }
            }
        }
        // 2. Edges crossing the boundary surfaces.
        if hit.is_none() {
            let surfs = reg.surfaces();
            'edges: for (e, pe) in plan.es.iter().enumerate() {
                if blended.contains(&e)
                    || [pe.start, pe.end]
                        .into_iter()
                        .flatten()
                        .any(|v| own_v.contains(&v))
                {
                    continue;
                }
                if !boxes_meet(&curve_box(&pe.curve, pe.range), &bb) {
                    continue;
                }
                for (surf, piece) in &surfs {
                    let dom = UvBox::natural(surf, bound);
                    match intersect_curve_surface(&pe.curve, pe.range, surf, dom, &tol) {
                        Ok(h) => {
                            let mut pts: Vec<Point3> = h.points.iter().map(|x| x.point).collect();
                            for o in &h.overlaps {
                                for t in
                                    [o.t_range.0, 0.5 * (o.t_range.0 + o.t_range.1), o.t_range.1]
                                {
                                    pts.push(pe.curve.eval(t));
                                }
                            }
                            if pts.iter().any(|&q| reg.test(q, Some(*piece))) {
                                hit = Some((
                                    obstacle_face(adj.edge_faces(e)),
                                    "an edge".into(),
                                    !own_edge(e),
                                ));
                                break 'edges;
                            }
                        }
                        Err(err) => {
                            if open.is_none() {
                                open = Some((
                                    obstacle_face(adj.edge_faces(e)),
                                    format!(
                                        "an edge (its intersection with the region's boundary could not be certified: {})",
                                        err.code()
                                    ),
                                ));
                            }
                        }
                    }
                }
            }
        }
        // 3. Curved faces crossing the region's open boundary pieces (the profile, closing
        //    planes inside the material) with their whole boundary outside it: a ball-end
        //    tip piercing a fillet, an undercut cavity or a drill point crossing a planar
        //    bevel, a closed void (a face without loops) straddling the profile or a mitre.
        if hit.is_none() {
            let (h, o) = curved_faces(plan, reg, &near_f, &bb, bound, &tol);
            hit = h.map(|(f, w)| (f, w, true));
            if open.is_none() {
                open = o;
            }
        }
        let names: Vec<String> = blended.iter().map(|&e| cx.ename[e].clone()).collect();
        if let Some((face, what, obstacle)) = hit {
            let fname = face.map(|f| cx.fname[f].clone()).unwrap_or_default();
            found.push(Violation {
                obstacle,
                edges: blended.iter().copied().collect(),
                limit: Limit::FaceWidth,
                face,
                what: if obstacle {
                    format!(
                        "the blend of {} runs into {what} of {fname}: another feature of the body lies in the material it would remove or fill",
                        names.join(", ")
                    )
                } else {
                    format!(
                        "the blend of {} runs across {what} of {fname}: it is wider than the face",
                        names.join(", ")
                    )
                },
            });
        } else if let Some((face, what)) = open {
            let fname = face.map(|f| cx.fname[f].clone()).unwrap_or_default();
            undecided.push((
                blended.iter().copied().collect(),
                format!(
                    "whether the blend of {} runs into {what} of {fname} could not be decided",
                    names.join(", ")
                ),
            ));
        }
    }
    st.viol.extend(found);
    st.unverified.extend(undecided);
}

/// The singular points of face `f` that lie on it: a cone's apex, a sphere's poles, when the
/// face's parameter box ([`crate::interfere::face_uvbox`]) reaches them.
fn singular_points(plan: &Plan, f: usize) -> Vec<Point3> {
    let Some(pf) = plan.fs[f].as_ref() else {
        return Vec::new();
    };
    let Some(bx) = crate::interfere::face_uvbox(plan, f) else {
        return Vec::new();
    };
    let within = |x: f64, (a, b): (f64, f64)| {
        let slack = 1e-9 * (1.0 + x.abs());
        x >= a - slack && x <= b + slack
    };
    match &pf.surf {
        Surface::Cone(c) if within(c.apex_v(), bx.v) => vec![c.apex()],
        Surface::Sphere(sp) => {
            let (o, z) = (sp.frame().origin(), sp.frame().z());
            let h = forge_core::math::FRAC_PI_2;
            let mut out = Vec::new();
            if within(h, bx.v) {
                out.push(o + z * sp.radius());
            }
            if within(-h, bx.v) {
                out.push(o - z * sp.radius());
            }
            out
        }
        _ => Vec::new(),
    }
}

/// What a region test found: the face concerned (when one is) and what it is.
type Found = (Option<usize>, String);

/// Records the first undecided test of a region (see [`curved_faces`]).
fn note(open: &mut Option<(Option<usize>, String)>, f: usize, what: String) {
    if open.is_none() {
        *open = Some((Some(f), what));
    }
}

/// Step 3 of [`check_obstacles`] for one region: the first curved face of the input (not
/// around the region's own vertices) that meets it through one of its open boundary pieces
/// ([`Reg::open_pieces`]), with what it is; and, apart, the first face for which that could
/// not be decided. Each piece's surface is intersected with the
/// face's surface over the face's whole parameter box (poles and apexes included,
/// [`crate::interfere::face_uvbox`]); a branch is cut wherever it crosses a surface on which
/// one of the region's constraints changes sign ([`Reg::constraint_surfaces`]) and each
/// piece between cuts is tested at its middle and quarter points — membership in the region
/// with that boundary piece relaxed, and in the face (certified point in face, its boundary
/// included; a face without loops holds every point). Tangential contact points are tested
/// too. Planar faces are skipped: a plane crossing the region must cross a side on a blended
/// face or an end face (steps 1–2 or an invalid input). Whatever cannot be bounded or
/// certified is undecided (W6 review round 5), never a hit.
fn curved_faces(
    plan: &Plan,
    reg: &Reg<'_>,
    near_f: &[usize],
    bb: &(Point3, Point3),
    bound: f64,
    tol: &SsiTolerance,
) -> (Option<Found>, Option<Found>) {
    let pieces = reg.open_pieces();
    let cons = reg.constraint_surfaces();
    let mut open: Option<(Option<usize>, String)> = None;
    'faces: for (f, pf) in plan.fs.iter().enumerate() {
        let Some(pf) = pf else { continue };
        if near_f.contains(&f) || matches!(pf.surf, Surface::Plane(_)) {
            continue;
        }
        let (Some(fb), Some(dom_f)) = (face_box(plan, f), crate::interfere::face_uvbox(plan, f))
        else {
            note(&mut open, f, "a face that cannot be bounded".into());
            continue;
        };
        if !boxes_meet(&fb, bb) {
            continue;
        }
        if matches!(pf.surf, Surface::BSpline(_)) {
            // forge-ssi has no B-spline surfaces: a face near the region cannot be certified
            // clear of it.
            note(&mut open, f, "a free-form face".into());
            continue;
        }
        // Point in the (closed) face: `Some(in)`, `None` when not certified.
        let in_face = |uv: forge_core::linalg::Point2| match crate::check::face_inside(plan, f, uv)
        {
            crate::cert2d::Inside::In | crate::cert2d::Inside::Boundary => Some(true),
            crate::cert2d::Inside::Out => Some(false),
            crate::cert2d::Inside::Unknown => None,
        };
        let mut uncertain_point = false;
        for (ps, piece) in &pieces {
            let dom_p = UvBox::natural(ps, bound);
            let gr = match intersect_surfaces(&pf.surf, dom_f, ps, dom_p, tol) {
                Ok(gr) => gr,
                Err(err) => {
                    note(
                        &mut open,
                        f,
                        format!(
                            "a face (its intersection with the region could not be certified: {})",
                            err.code()
                        ),
                    );
                    continue 'faces;
                }
            };
            if !gr.certified_complete || gr.coincidence.is_some() {
                note(
                    &mut open,
                    f,
                    "a face (its intersection with the region is not certified)".into(),
                );
                continue 'faces;
            }
            for v in gr.tangent_points() {
                if reg.test(v.point, Some(*piece)) {
                    match in_face(v.uv_a) {
                        Some(true) => return (Some((Some(f), "a face".into())), open),
                        Some(false) => {}
                        None => uncertain_point = true,
                    }
                }
            }
            for br in &gr.branches {
                // Only the parts of the branch whose hull meets the region's box.
                for (r0, r1) in near_ranges(&br.curve, br.range, bb) {
                    let mut cuts = vec![r0, r1];
                    for (cs, cp) in &cons {
                        if *cp == Some(*piece) {
                            continue;
                        }
                        let dom = UvBox::natural(cs, bound);
                        match intersect_curve_surface(&br.curve, (r0, r1), cs, dom, tol) {
                            Ok(h) => {
                                cuts.extend(h.points.iter().map(|x| x.t));
                                for o in &h.overlaps {
                                    cuts.push(o.t_range.0);
                                    cuts.push(o.t_range.1);
                                }
                            }
                            Err(err) => {
                                note(
                                    &mut open,
                                    f,
                                    format!(
                                        "a face (where it crosses the region could not be certified: {})",
                                        err.code()
                                    ),
                                );
                                continue 'faces;
                            }
                        }
                    }
                    cuts.retain(|t| *t >= r0 && *t <= r1);
                    cuts.sort_by(f64::total_cmp);
                    cuts.dedup();
                    for w in cuts.windows(2) {
                        if w[1] - w[0] <= 1e-12 * (1.0 + w[0].abs().max(w[1].abs())) {
                            continue;
                        }
                        for frac in [0.5, 0.25, 0.75] {
                            let t = w[0] + (w[1] - w[0]) * frac;
                            if reg.test(br.curve.eval(t), Some(*piece)) {
                                match in_face(br.pcurve_a.eval(t)) {
                                    Some(true) => {
                                        return (Some((Some(f), "a face".into())), open);
                                    }
                                    Some(false) => {}
                                    None => uncertain_point = true,
                                }
                            }
                        }
                    }
                }
            }
        }
        if uncertain_point {
            note(
                &mut open,
                f,
                "a face (a point-in-face test could not be certified)".into(),
            );
        }
    }
    (None, open)
}
