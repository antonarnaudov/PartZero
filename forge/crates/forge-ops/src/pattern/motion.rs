//! Motions of pattern instances and copies of bodies moved by them (SPEC §6.10).
//!
//! A pattern instance is either a **rigid motion** (linear and circular layouts: a
//! translation or a rotation, `forge_core::linalg::Transform`) or a **reflection** in a plane
//! (mirror). `forge_core`'s `Transform` is rigid by construction, so reflections are their
//! own variant here.
//!
//! # Copying a body
//! [`move_body`] rebuilds a body entity by entity with a [`forge_core::topo::BodyBuilder`]
//! (same shells, faces, loops, edges and vertices in the same order, same tolerances) with
//! moved geometry and a provenance chosen by the caller:
//! - **Rigid motions** move every frame, curve and vertex; parametrizations move with their
//!   frames, so pcurves, loop orders and face senses are unchanged.
//! - **Reflections** reverse orientation. With `R` the reflection:
//!   - curves keep their parameter: a line maps to the line through `R·o` along `R·d`; a
//!     circle or ellipse in frame `(o, x, y, z)` to the one in the right-handed frame
//!     `(R·o, R·x, R·y, −R·z)` (`R·x × R·y = −R·z`), whose points are `R·C(t)` for the same
//!     `t`; B-spline control points are reflected;
//!   - planes use the frame `(R·o, R·x, R·y, −R·z)` too: `S'(u, v) = R·S(u, v)` with the
//!     normal `−R·n`, so the face's `sense` flips and its pcurves are unchanged;
//!   - cylinders, cones, spheres and tori (angle `u` about the frame's `z`) use the
//!     right-handed frame `(R·o, R·x, −R·y, R·z)`: `S'(u, v) = R·S(−u, v)` and the normal is
//!     `R·n` (the closed-form normals are radial), so `sense` is kept and every pcurve is
//!     mapped by `u ↦ 2π − u` (lines and B-splines map exactly, keeping their parameter; a
//!     circle or ellipse pcurve on such a surface cannot keep its parameter under a
//!     reflection of the `(u, v)` plane and is reported as `FORGE_PATTERN_MIRROR_UNSUPPORTED`,
//!     never approximated);
//!   - B-spline surfaces reflect their control points (`S' = R∘S`, normal `−R·n`): `sense`
//!     flips, pcurves are unchanged;
//!   - every loop is reversed (coedge order reversed, each coedge's direction flipped):
//!     walking a loop with the face on the left seen from outside becomes walking it with the
//!     face on the right after a reflection.
//!
//! The copy is checked with `forge_core::topo::validate` before it is returned; a copy that
//! fails is an error (`FORGE_PATTERN_INVALID_COPY`), never a returned body.

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::geom::{
    Circle3, Cone, Curve2, Curve3, Cylinder, Ellipse3, Line2, Line3, NurbsSurface, Plane, Sphere,
    Surface, Torus,
};
use forge_core::linalg::{Frame, Point2, Point3, Transform, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{
    Body, BodyBuilder, EdgeId, EntityNames, FaceId, Provenance, VertexId, has_errors, validate,
};

use super::error::PatternError;

/// Where a pattern instance puts a copy of its seed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Motion {
    /// A rigid motion (linear: a translation; circular: a rotation about the axis).
    Rigid(Transform),
    /// The reflection in the plane through `origin` with the unit `normal` (mirror).
    Reflection {
        /// A point of the mirror plane.
        origin: Point3,
        /// The plane's unit normal.
        normal: Vec3,
    },
}

impl Motion {
    /// The identity motion.
    pub fn identity() -> Self {
        Motion::Rigid(Transform::identity())
    }

    /// The reflection in the plane through `origin` with normal `normal` (any non-zero
    /// length); `None` for a zero or non-finite normal.
    pub fn reflection(origin: Point3, normal: Vec3) -> Option<Self> {
        let normal = normal.normalize()?;
        (origin.is_finite() && normal.is_finite()).then_some(Motion::Reflection { origin, normal })
    }

    /// `true` for a reflection (orientation reversing).
    pub fn is_reflection(&self) -> bool {
        matches!(self, Motion::Reflection { .. })
    }

    /// Apply to a point.
    pub fn point(&self, p: Point3) -> Point3 {
        match self {
            Motion::Rigid(t) => t.transform_point(p),
            Motion::Reflection { origin, normal } => {
                p - *normal * (2.0 * (p - *origin).dot(*normal))
            }
        }
    }

    /// Apply to a free vector (no translation).
    pub fn vector(&self, v: Vec3) -> Vec3 {
        match self {
            Motion::Rigid(t) => t.transform_vector(v),
            Motion::Reflection { normal, .. } => v - *normal * (2.0 * v.dot(*normal)),
        }
    }
}

/// A face, edge or vertex of the body being copied (ids of the **source** body).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Entity {
    /// A face.
    Face(FaceId),
    /// An edge.
    Edge(EdgeId),
    /// A vertex.
    Vertex(VertexId),
}

/// A frame from exactly given axes (checked orthonormal and right-handed within 1e-12), or
/// re-orthonormalized from its `z` and `x` when rounding moved it outside that.
fn frame_of(o: Point3, x: Vec3, y: Vec3, z: Vec3) -> Result<Frame, PatternError> {
    Frame::try_from_axes(o, x, y, z, 1e-12)
        .or_else(|| Frame::from_normal_x(o, z, x))
        .ok_or_else(|| PatternError::internal("degenerate frame after the motion"))
}

/// The frame `(R·o, R·x, R·y, −R·z)` (curves and planes, parametrization kept).
fn reflect_frame_keep_xy(f: &Frame, m: &Motion) -> Result<Frame, PatternError> {
    frame_of(
        m.point(f.origin()),
        m.vector(f.x()),
        m.vector(f.y()),
        -m.vector(f.z()),
    )
}

/// The frame `(R·o, R·x, −R·y, R·z)` (surfaces of revolution, `u ↦ −u`).
fn reflect_frame_flip_y(f: &Frame, m: &Motion) -> Result<Frame, PatternError> {
    frame_of(
        m.point(f.origin()),
        m.vector(f.x()),
        -m.vector(f.y()),
        m.vector(f.z()),
    )
}

fn geom(e: forge_core::geom::GeomError) -> PatternError {
    PatternError::internal(format!("geometry after the motion: {e}"))
}

/// The curve moved (parameter kept).
pub(crate) fn move_curve(c: &Curve3, m: &Motion) -> Result<Curve3, PatternError> {
    Ok(match m {
        Motion::Rigid(t) => c.transform(t),
        Motion::Reflection { .. } => match c {
            Curve3::Line(l) => Line3::new(m.point(l.origin()), m.vector(l.dir()))
                .map_err(geom)?
                .into(),
            Curve3::Circle(k) => Circle3::new(reflect_frame_keep_xy(k.frame(), m)?, k.radius())
                .map_err(geom)?
                .into(),
            Curve3::Ellipse(e) => {
                Ellipse3::new(reflect_frame_keep_xy(e.frame(), m)?, e.rx(), e.ry())
                    .map_err(geom)?
                    .into()
            }
            Curve3::BSpline(b) => Curve3::BSpline(
                b.map_control_points(|p| m.point(Vec3::new(p[0], p[1], p[2])).to_array()),
            ),
        },
    })
}

/// How a reflection changes a face: its moved surface, whether `sense` flips, and whether
/// pcurves map by `u ↦ 2π − u`.
struct MovedSurface {
    surface: Surface,
    flip_sense: bool,
    mirror_u: bool,
}

fn move_surface(s: &Surface, m: &Motion) -> Result<MovedSurface, PatternError> {
    if let Motion::Rigid(t) = m {
        return Ok(MovedSurface {
            surface: s.transform(t),
            flip_sense: false,
            mirror_u: false,
        });
    }
    let rev = |surface: Surface| MovedSurface {
        surface,
        flip_sense: false,
        mirror_u: true,
    };
    Ok(match s {
        Surface::Plane(p) => MovedSurface {
            surface: Plane::new(reflect_frame_keep_xy(p.frame(), m)?).into(),
            flip_sense: true,
            mirror_u: false,
        },
        Surface::Cylinder(c) => rev(
            Cylinder::new(reflect_frame_flip_y(c.frame(), m)?, c.radius())
                .map_err(geom)?
                .into(),
        ),
        Surface::Cone(c) => rev(Cone::new(
            reflect_frame_flip_y(c.frame(), m)?,
            c.radius(),
            c.half_angle(),
        )
        .map_err(geom)?
        .into()),
        Surface::Sphere(c) => rev(Sphere::new(reflect_frame_flip_y(c.frame(), m)?, c.radius())
            .map_err(geom)?
            .into()),
        Surface::Torus(t) => {
            let f = reflect_frame_flip_y(t.frame(), m)?;
            let moved = match t.spindle_patch() {
                Some(patch) => Torus::spindle(f, t.major(), t.minor(), patch),
                None => Torus::new(f, t.major(), t.minor()),
            };
            rev(moved.map_err(geom)?.into())
        }
        Surface::BSpline(b) => {
            let (du, dv) = b.degrees();
            let (ku, kv) = (b.knots_u().to_vec(), b.knots_v().to_vec());
            let (nu, nv) = (ku.len() - du - 1, kv.len() - dv - 1);
            let pts: Vec<Point3> = b.control_points().iter().map(|&p| m.point(p)).collect();
            let w = b.weights().map(<[f64]>::to_vec);
            let moved = NurbsSurface::new(du, dv, ku, kv, nu, nv, pts, w)
                .map_err(|e| PatternError::internal(format!("B-spline surface: {e}")))?;
            MovedSurface {
                surface: Surface::BSpline(moved),
                flip_sense: true,
                mirror_u: false,
            }
        }
    })
}

/// A pcurve mapped by `u ↦ 2π − u` (parameter kept), or `None` when that is not
/// representable (circle and ellipse pcurves).
fn mirror_pcurve_u(c: &Curve2) -> Option<Curve2> {
    let tau = math::TAU;
    match c {
        Curve2::Line(l) => {
            let (o, d) = (l.origin(), l.dir());
            Line2::new(Point2::new(tau - o.x, o.y), Vec2::new(-d.x, d.y))
                .ok()
                .map(Into::into)
        }
        Curve2::BSpline(b) => Some(Curve2::BSpline(
            b.map_control_points(|p| [tau - p[0], p[1]]),
        )),
        Curve2::Circle(_) | Curve2::Ellipse(_) => None,
    }
}

/// Copy `body` moved by `motion`, with the provenance `prov` returns for each entity of the
/// source body (see the module docs). The copy passes `forge_core::topo::validate`.
pub fn move_body(
    body: &Body,
    motion: &Motion,
    mut prov: impl FnMut(Entity, &Provenance) -> Provenance,
) -> Result<Body, PatternError> {
    let reflect = motion.is_reflection();
    let mut bb = BodyBuilder::with_tolerance(Tolerance::IR_DEFAULT);
    let topo = |e: forge_core::topo::TopoError| PatternError::internal(format!("topology: {e}"));
    let mut vmap: BTreeMap<VertexId, VertexId> = BTreeMap::new();
    for (vid, v) in body.vertices().iter() {
        let nv = bb
            .add_vertex(
                motion.point(v.point),
                prov(Entity::Vertex(vid), &v.provenance),
            )
            .map_err(topo)?;
        bb.set_vertex_tolerance(nv, v.tolerance).map_err(topo)?;
        vmap.insert(vid, nv);
    }
    let mut emap: BTreeMap<EdgeId, EdgeId> = BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        let curve = move_curve(&e.curve, motion)?;
        let p = prov(Entity::Edge(eid), &e.provenance);
        let ne = match (e.start, e.end) {
            (Some(s), Some(t)) => bb.add_edge(curve, e.t_range, vmap[&s], vmap[&t], p),
            _ => bb.add_ring_edge_with_range(curve, e.t_range, p),
        }
        .map_err(topo)?;
        bb.set_edge_tolerance(ne, e.tolerance).map_err(topo)?;
        emap.insert(eid, ne);
    }
    for &sid in body.shell_ids() {
        let shell = body
            .shell(sid)
            .ok_or_else(|| PatternError::internal("dangling shell id"))?;
        let ns = bb.add_shell(shell.closed);
        for &fid in &shell.faces {
            let f = body
                .face(fid)
                .ok_or_else(|| PatternError::internal("dangling face id"))?;
            let moved = move_surface(&f.surface, motion)?;
            let sense = f.sense != moved.flip_sense;
            let nf = bb
                .add_face(
                    ns,
                    moved.surface,
                    sense,
                    prov(Entity::Face(fid), &f.provenance),
                )
                .map_err(topo)?;
            for &lid in &f.loops {
                let lp = body
                    .loop_(lid)
                    .ok_or_else(|| PatternError::internal("dangling loop id"))?;
                let mut order: Vec<_> = lp.coedges.clone();
                if reflect {
                    order.reverse();
                }
                let mut uses = Vec::with_capacity(order.len());
                for &cid in &order {
                    let c = body
                        .coedge(cid)
                        .ok_or_else(|| PatternError::internal("dangling coedge id"))?;
                    uses.push((emap[&c.edge], c.forward != reflect));
                }
                let nl = bb.add_loop(nf, &uses).map_err(topo)?;
                let new_coedges = bb
                    .body()
                    .loop_(nl)
                    .map(|l| l.coedges.clone())
                    .ok_or_else(|| PatternError::internal("lost a new loop"))?;
                for (&old, &new) in order.iter().zip(&new_coedges) {
                    let Some(pc) = body.coedge(old).and_then(|c| c.pcurve.as_ref()) else {
                        continue;
                    };
                    let pc = if moved.mirror_u {
                        mirror_pcurve_u(pc).ok_or_else(|| PatternError::MirrorUnsupported {
                            entity: f.provenance.name(),
                            what: format!(
                                "a {} pcurve on a {} face cannot keep its parameter under a reflection",
                                pc.kind_name(),
                                f.surface.kind_name()
                            ),
                        })?
                    } else {
                        pc.clone()
                    };
                    bb.set_pcurve(new, pc).map_err(topo)?;
                }
            }
        }
    }
    let out = bb.finish();
    let issues = validate(&out);
    if has_errors(&issues) {
        let names = EntityNames::new(&out);
        return Err(PatternError::InvalidCopy {
            issues: issues
                .iter()
                .filter(|i| i.severity == forge_core::topo::Severity::Error)
                .map(|i| names.describe(i))
                .collect(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflection_of_points_and_vectors_is_involutive_and_exact_on_axis_planes() {
        let m =
            Motion::reflection(Vec3::new(2.0, 0.0, 0.0), Vec3::new(3.0, 0.0, 0.0)).expect("plane");
        let p = Vec3::new(5.5, -1.25, 7.0);
        assert_eq!(m.point(p), Vec3::new(-1.5, -1.25, 7.0));
        assert_eq!(m.point(m.point(p)), p);
        assert_eq!(
            m.vector(Vec3::new(1.0, 2.0, 3.0)),
            Vec3::new(-1.0, 2.0, 3.0)
        );
        assert!(Motion::reflection(Vec3::zero(), Vec3::zero()).is_none());
    }

    #[test]
    fn reflected_curves_keep_their_parameter() {
        let m = Motion::reflection(Vec3::new(0.3, -0.2, 0.1), Vec3::new(1.0, 2.0, -0.5))
            .expect("plane");
        let f = Frame::from_normal_x(
            Vec3::new(1.0, 2.0, 3.0),
            Vec3::new(0.2, 0.1, 1.0),
            Vec3::unit_x(),
        )
        .expect("frame");
        let curves: Vec<Curve3> = vec![
            Line3::new(Vec3::new(1.0, 1.0, 1.0), Vec3::new(1.0, -2.0, 0.5))
                .expect("l")
                .into(),
            Circle3::new(f, 2.5).expect("c").into(),
            Ellipse3::new(f, 3.0, 1.5).expect("e").into(),
        ];
        for c in &curves {
            let mc = move_curve(c, &m).expect("moved");
            for k in 0..16 {
                let t = 0.37 * f64::from(k);
                let want = m.point(c.eval(t));
                assert!(
                    mc.eval(t).distance(want) < 1e-12,
                    "{} at {t}",
                    c.kind_name()
                );
            }
        }
    }

    #[test]
    fn reflected_surfaces_map_points_and_normals() {
        let m = Motion::reflection(Vec3::new(0.3, -0.2, 0.1), Vec3::new(1.0, 2.0, -0.5))
            .expect("plane");
        let f = Frame::from_normal_x(
            Vec3::new(1.0, 2.0, 3.0),
            Vec3::new(0.2, 0.1, 1.0),
            Vec3::unit_x(),
        )
        .expect("frame");
        let surfaces: Vec<Surface> = vec![
            Plane::new(f).into(),
            Cylinder::new(f, 2.0).expect("cyl").into(),
            Cone::new(f, 2.0, 0.4).expect("cone").into(),
            Sphere::new(f, 2.0).expect("sph").into(),
            Torus::new(f, 3.0, 1.0).expect("tor").into(),
        ];
        for s in &surfaces {
            let ms = move_surface(s, &m).expect("moved");
            for (u, v) in [(0.3, 0.2), (1.7, -0.4), (4.0, 0.9)] {
                let u2 = if ms.mirror_u { math::TAU - u } else { u };
                let want = m.point(s.eval(u, v));
                assert!(
                    ms.surface.eval(u2, v).distance(want) < 1e-12,
                    "{}",
                    s.kind_name()
                );
                let n = s.normal(u, v).expect("n");
                let n2 = ms.surface.normal(u2, v).expect("n2");
                let sign = if ms.flip_sense { -1.0 } else { 1.0 };
                assert!(
                    (n2 * sign).distance(m.vector(n)) < 1e-12,
                    "{} normal",
                    s.kind_name()
                );
            }
        }
    }
}
