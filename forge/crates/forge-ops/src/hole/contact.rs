//! Tangent contacts between the tools of a hole or pattern and the planar faces of the
//! result: a guard against known gaps in W4's contact checks (SPEC §6.0.3,
//! `BOOLEAN_NON_MANIFOLD`).
//!
//! # Why
//! W4's assembly decides whether a tangent contact line makes the result touch itself by
//! classifying the **midpoint** of the contact piece against the face. A contact line that
//! runs across an existing inner loop of a planar face (the opening of a hole it crosses) has
//! that midpoint off the face, so the check is skipped and the cut returns a body that touches
//! itself along the line, with no edge there. The W5 differential found it through a pattern
//! (fixed case `regression_909_59`: a circular pattern of a counterbored blind hole puts a
//! copy's wall tangent to the plate's bottom face across the seed hole's opening; OCCT fails
//! with `BOOLEAN_NON_MANIFOLD`). Likewise a drill-point apex within *tol* of a face (but not
//! on it) lies on that face by [R-3], so the result touches itself at a point exactly as when
//! the apex is on the face (where W4 fails with `BOOLEAN_NON_MANIFOLD`, kind `vertex`); W4
//! returns a body there (review 5: an M3 tip 0.5e-6 mm above the far face). Until W4 covers
//! both (BACKLOG, W4), [`tangent_contact`] checks every result of `apply_hole` and
//! `apply_seed` so that neither returns such a body.
//!
//! # The line test
//! A tool face on a **cylinder** (radius `r`, axis `o + v·z`) or a **cone** (apex, axis `z`,
//! half angle `α`) of a convex tool (its outward normal points away from the axis) lies along
//! a line on a planar result face `F` (outward normal `n`) when:
//! - cylinder: the ruling of the cylinder nearest `F` on the conflicting side (direction
//!   `σ·n` projected normal to the axis) is within `LINEAR_TOLERANCE` of `F`'s plane at both
//!   ends of the face's axial range (an axis that is not parallel to `F` fails that test at
//!   one end, unless the face is shorter than `2·tol / |z·n|`: then it is within tol all
//!   along);
//! - cone: the generator whose outward normal is `σ·n` (`|z·σn + sin α| ≤ ANGULAR_TOLERANCE`)
//!   is within `LINEAR_TOLERANCE` of the plane at both ends of the face's axial range.
//!
//! A face with a boundary edge that is neither a circle coaxial with it nor a line (a ruling)
//! is not tested. The conflicting side `σ` is the material's side for a **cut** (the tool's
//! outward normal at the line is `n`: the tool removes the material right under `F`) and the
//! outside for a **join** (`−n`: the tool adds material right above `F`); an intersect is not
//! tested.
//!
//! **The tool must be there.** The face's axial range spans all of its edges, but the face
//! need not cover the whole ruling over that range: a rod whose bottom a notch removed over
//! part of its length keeps the full ruling elsewhere (a face whose (u, v) domain is not a
//! rectangle). A point of the ruling at height `h` belongs to the (closed) tool face when the
//! ray from it along the axis towards `+v` (away from a cone's apex; the face is compact, so
//! the ray ends outside it) crosses the face's boundary an odd number of times: once per
//! coaxial boundary arc above `h` whose angular span contains the ruling (the face's line
//! edges are rulings, parallel to the ray). The count is taken just beside the ruling, at
//! `±BOUNDARY_ANGLE` about the axis, and either side counts: a ruling along a boundary line of
//! the face belongs to the closed face (and a ruling that close to the face's edge lies within
//! `r·BOUNDARY_ANGLE²/2 ≪ tol` of the extreme one, the [R-3] reading). Arcs at different
//! heights never stand in for each other.
//!
//! If `F` contains a point of the line **in its interior** (inside and farther than
//! `LINEAR_TOLERANCE` from its boundary) **where the tool face contains the ruling**, the
//! result is wrong: in a correct result `F` cannot pass across the line, since the tool
//! removes (adds) material on its inner (outer) side right there. The regularized set touches
//! itself along the line, so the operation fails with `BOOLEAN_NON_MANIFOLD` (`probe`: `kind`
//! edge, a point of the line inside `F`), exactly as SPEC §6.0.3 says and as OCCT does. A tool
//! within `LINEAR_TOLERANCE` of `F` without crossing it leaves a region nowhere thicker than
//! tol ([W0-53]): a contact too. So is a tool that crosses `F` by less than tol: the part of
//! it beyond `F` is an overlap nowhere thicker than tol, which SPEC §6.0.3 [W0-41](1) reads
//! as a **contact**, not volume — the result touches itself along the line exactly as for a
//! tangent tool, and `F` stays whole across it (a finding; review 6: a through hole whose wall
//! pierces a side face by 0.5e-6 or 0.9e-6 mm fails with `BOOLEAN_NON_MANIFOLD`, test
//! `a_hole_wall_piercing_a_side_face_within_tol_is_non_manifold` in `tests/hole_contact.rs`).
//! A sub-tol slot that W4 opened in `F` there would be W4's error, not a legitimate opening;
//! this guard, which classifies the line against the result's `F`, would not see it (the line
//! would lie in the slot, outside `F`), so that case rests on W4's own check.
//!
//! The points of the line inside `F` are found exactly: the segment is split where it crosses
//! `F`'s edges (certified `forge_ssi::intersect_curve_surface` with the plane through the
//! segment perpendicular to `F`) and at the heights of the tool face's arcs, and three points
//! of every piece longer than `2·tol` are classified by the tool-face test above and by
//! `planar_face_classify` (the ray-parity test of [`super::face`]).
//!
//! # The apex test
//! A cone face that reaches its apex (a drill-point tip) touches `F` at a point when the cone
//! lies strictly on the conflicting side of `F`'s plane near the apex — every generator
//! `z·cos α + e·sin α` points to side `−σ·n`, i.e. `z·(−σ·n) > sin α + ANGULAR_TOLERANCE`
//! (at `sin α` a generator lies along the plane: the line test's case) — and the apex is
//! within `LINEAR_TOLERANCE` of the plane with `F` all around its foot: eight points on the
//! circle of radius `tol·(tan α + 2)` about the foot lie in `F`'s interior (farther than tol
//! from its boundary). The ring, not the foot itself, is classified because a tip within tol
//! **under** the face may have pierced it with an opening of radius up to `tol·tan α`, which
//! the ring leaves out by more than tol. The operation then fails with `BOOLEAN_NON_MANIFOLD`
//! (`probe`: `kind` vertex, the apex's foot on `F`): the [R-3] reading of an apex within tol
//! of the face, the same outcome as an apex exactly on it. (Whether a tip touching the far face should instead
//! be `HOLE_BREAKS_THROUGH`, as the W7b oracle reads it, is a W5 contract question.)
//!
//! # Limits
//! Only plane–cylinder and plane–cone contacts of the operation's **tools** are tested: the
//! contacts of hole and pattern tools with the flat faces of a part. Contacts between two
//! curved faces (a copied wall tangent to an existing hole's wall) stay W4's check alone.

use std::collections::BTreeMap;

use forge_core::geom::{Circle3, Curve3, Plane, Surface};
use forge_core::linalg::{Point3, Vec3};
use forge_core::math;
use forge_core::topo::{Body, FaceId};
use forge_ir::v1::{ANGULAR_TOLERANCE, EntityKind, LINEAR_TOLERANCE};
use forge_ssi::{SsiTolerance, UvBox, intersect_curve_surface};

use super::error::HoleError;
use super::face::{edge_reach, face_edges, planar_face_classify};
use crate::boolean::{BodyOp, BodyOpResult, OpBody};

/// The angle (radians) about the axis at which the tool-face test looks beside a ruling (see
/// the module docs). A ruling that close to the extreme one lies within `r·δ²/2` of it
/// (5e-15·r mm): far inside tol for any part size, so either side is the [R-3] reading.
const BOUNDARY_ANGLE: f64 = 1e-7;

/// A boundary circle of a tool face, coaxial with it: the circle, its parameter range and
/// its height along the face's axis.
#[derive(Clone, Debug)]
struct Arc {
    circle: Circle3,
    t: (f64, f64),
    h: f64,
}

/// A convex tool face on a cylinder or a cone.
#[derive(Clone, Debug)]
enum Ruled {
    /// `o + v·z + r·e(u)`.
    Cylinder {
        o: Point3,
        z: Vec3,
        r: f64,
        /// The face's axial range.
        v: (f64, f64),
        /// Boundary circles coaxial with the face.
        arcs: Vec<Arc>,
    },
    /// `o + v·z + (R + v·tan α)·e(u)`.
    Cone {
        o: Point3,
        z: Vec3,
        radius: f64,
        alpha: f64,
        v: (f64, f64),
        arcs: Vec<Arc>,
        /// The face reaches its apex (a drill-point tip).
        apex: bool,
    },
}

impl Ruled {
    fn axis(&self) -> Vec3 {
        match self {
            Ruled::Cylinder { z, .. } | Ruled::Cone { z, .. } => *z,
        }
    }
    fn arcs(&self) -> &[Arc] {
        match self {
            Ruled::Cylinder { arcs, .. } | Ruled::Cone { arcs, .. } => arcs,
        }
    }
}

/// Is the circle coaxial with the axis `o + v·z`?
fn coaxial(c: &Circle3, o: Point3, z: Vec3) -> bool {
    let f = c.frame();
    let off = f.origin() - o;
    f.z().cross(z).norm() <= ANGULAR_TOLERANCE && (off - z * off.dot(z)).norm() <= LINEAR_TOLERANCE
}

/// The convex cylinder and cone faces of `tool`, with their axial ranges and coaxial boundary
/// circles (faces that do not qualify, see the module docs, are left out).
fn ruled_faces(tool: &Body) -> Vec<Ruled> {
    let mut out = Vec::new();
    for (fid, f) in tool.faces().iter() {
        // Convex: the outward normal is the surface normal, which points away from the axis
        // for both surfaces.
        if !f.sense {
            continue;
        }
        let (o, z) = match &f.surface {
            Surface::Cylinder(c) => (c.frame().origin(), c.frame().z()),
            Surface::Cone(k) => (k.frame().origin(), k.frame().z()),
            _ => continue,
        };
        let mut v = (f64::INFINITY, f64::NEG_INFINITY);
        let mut arcs = Vec::new();
        let mut regular = true;
        for eid in tool.face_edges(fid) {
            let Some(e) = tool.edge(eid) else {
                regular = false;
                break;
            };
            match &e.curve {
                Curve3::Circle(c) if coaxial(c, o, z) => arcs.push(Arc {
                    circle: *c,
                    t: e.t_range,
                    h: (c.frame().origin() - o).dot(z),
                }),
                Curve3::Line(_) => {}
                _ => {
                    regular = false;
                    break;
                }
            }
            let (t0, t1) = e.t_range;
            for k in 0..=8 {
                let t = t0 + (t1 - t0) * (k as f64 / 8.0);
                let h = (e.curve.eval(t) - o).dot(z);
                v = (v.0.min(h), v.1.max(h));
            }
        }
        // A cone face bounded by rings at one height only (a drill-point tip) runs from them
        // to the apex: the only finite region of one nappe such rings bound.
        if let Surface::Cone(k) = &f.surface
            && regular
            && v.1 - v.0 <= 2.0 * LINEAR_TOLERANCE
            && arcs
                .iter()
                .all(|a| a.t.1 - a.t.0 >= std::f64::consts::TAU - ANGULAR_TOLERANCE)
        {
            let a = k.apex_v();
            v = (v.0.min(a), v.1.max(a));
        }
        if !regular || arcs.is_empty() || v.1 - v.0 <= 2.0 * LINEAR_TOLERANCE {
            continue;
        }
        out.push(match &f.surface {
            Surface::Cylinder(c) => Ruled::Cylinder {
                o,
                z,
                r: c.radius(),
                v,
                arcs,
            },
            Surface::Cone(k) => {
                // The main nappe only (the ray of the tool-face test runs towards +v).
                if v.0 < k.apex_v() - LINEAR_TOLERANCE {
                    continue;
                }
                Ruled::Cone {
                    o,
                    z,
                    radius: k.radius(),
                    alpha: k.half_angle(),
                    v,
                    arcs,
                    apex: v.0 <= k.apex_v() + LINEAR_TOLERANCE,
                }
            }
            _ => unreachable!("filtered above"),
        });
    }
    out
}

/// Does the arc's angular span contain the direction `dir` (unit, normal to the axis)? A full
/// circle contains every direction; otherwise strictly (the tool-face test looks beside the
/// ruling, so an end point never decides).
fn spans(a: &Arc, dir: Vec3) -> bool {
    let (t0, t1) = a.t;
    if t1 - t0 >= std::f64::consts::TAU - ANGULAR_TOLERANCE {
        return true;
    }
    let f = a.circle.frame();
    let phi = math::atan2(dir.dot(f.y()), dir.dot(f.x()));
    math::wrap_angle(phi, t0) < t1
}

/// Is the point of the ruling in direction `dir` (unit, normal to the axis `z`) at height `h`
/// in the closed tool face bounded (in part) by `arcs`? The ray-parity test of the module
/// docs, taken at `±BOUNDARY_ANGLE` beside the ruling.
fn tool_contains(z: Vec3, arcs: &[Arc], dir: Vec3, h: f64) -> bool {
    let (s, c) = math::sin_cos(BOUNDARY_ANGLE);
    let side = z.cross(dir);
    [dir * c + side * s, dir * c - side * s]
        .iter()
        .any(|&d| arcs.iter().filter(|a| a.h > h && spans(a, d)).count() % 2 == 1)
}

/// The contact line of a tool face with a plane: its end points on the plane (the feet of the
/// ruling at the ends of the face's axial range `v`), and the ruling's direction from the axis.
#[derive(Clone, Copy, Debug)]
struct Segment {
    q0: Point3,
    q1: Point3,
    v: (f64, f64),
    dir: Vec3,
}

/// The contact line of `face` with a plane of outward normal `n` and offset `c` (`x·n = c`)
/// on side `sigma`, or `None` when the face's ruling does not lie along the plane (module
/// docs). Whether the face contains the ruling is decided point by point ([`tool_contains`]).
fn contact_segment(face: &Ruled, n: Vec3, c: f64, sigma: f64) -> Option<Segment> {
    let dist = |p: Point3| p.dot(n) - c;
    let foot = |p: Point3| p - n * dist(p);
    let (a, b, v, dir) = match face {
        Ruled::Cylinder { o, z, r, v, .. } => {
            // The ruling nearest the plane on side σ: away from the axis along σ·n_perp. (No
            // angular pre-filter: an axis that is not parallel to the plane fails the end
            // distances below unless the whole face is within tol of the plane.)
            let w = (n - *z * z.dot(n)).normalize()?;
            let at = |h: f64| *o + *z * h + w * (sigma * r);
            (at(v.0), at(v.1), *v, w * sigma)
        }
        Ruled::Cone {
            o,
            z,
            radius,
            alpha,
            v,
            ..
        } => {
            let sn = n * sigma;
            let (sa, ca) = math::sin_cos(*alpha);
            if (z.dot(sn) + sa).abs() > ANGULAR_TOLERANCE {
                return None;
            }
            // The generator whose outward normal cos α·e − sin α·z is σ·n.
            let e = (sn - *z * z.dot(sn)).normalize()?;
            let ta = sa / ca;
            let at = |h: f64| *o + *z * h + e * (radius + h * ta);
            (at(v.0), at(v.1), *v, e)
        }
    };
    if dist(a).abs() > LINEAR_TOLERANCE || dist(b).abs() > LINEAR_TOLERANCE {
        return None;
    }
    Some(Segment {
        q0: foot(a),
        q1: foot(b),
        v,
        dir,
    })
}

/// The foot on the plane (outward normal `n`, offset `c`) of the apex of `face`, and the
/// radius of the ring about it that the face must contain, when the face reaches its apex,
/// the cone lies strictly on side `−σ·n` near it and the apex is within tol of the plane (the
/// apex test of the module docs).
fn apex_foot(face: &Ruled, n: Vec3, c: f64, sigma: f64) -> Option<(Point3, f64)> {
    let Ruled::Cone {
        o,
        z,
        radius,
        alpha,
        apex: true,
        ..
    } = face
    else {
        return None;
    };
    let (sa, ca) = math::sin_cos(*alpha);
    if z.dot(n * -sigma) <= sa + ANGULAR_TOLERANCE {
        return None;
    }
    let a = *o + *z * (-radius * ca / sa);
    let dist = a.dot(n) - c;
    (dist.abs() <= LINEAR_TOLERANCE).then(|| (a - n * dist, LINEAR_TOLERANCE * (sa / ca + 2.0)))
}

/// Does the planar face `face` of `body` (plane `plane`) contain the ring of radius `rho`
/// about `foot` in its interior (eight points, each farther than tol from its boundary)?
fn ring_inside(
    body: &Body,
    face: FaceId,
    plane: &Plane,
    foot: Point3,
    rho: f64,
) -> Result<bool, HoleError> {
    let (x, y) = (plane.frame().x(), plane.frame().y());
    for k in 0..8 {
        let (s, c) = math::sin_cos(std::f64::consts::FRAC_PI_4 * k as f64);
        let (inside, boundary) = planar_face_classify(body, face, foot + (x * c + y * s) * rho)?;
        if !inside || boundary <= LINEAR_TOLERANCE {
            return Ok(false);
        }
    }
    Ok(true)
}

/// A point of the segment `seg` (on the face's plane) strictly inside the planar face `face`
/// of `body` (farther than tol from its boundary) where the tool face (axis `z`, `arcs`)
/// contains the ruling, if there is one.
fn inside_point(
    body: &Body,
    face: FaceId,
    plane: &Plane,
    seg: &Segment,
    z: Vec3,
    arcs: &[Arc],
) -> Result<Option<Point3>, HoleError> {
    let (q0, q1) = (seg.q0, seg.q1);
    let len = (q1 - q0).norm();
    if len <= 2.0 * LINEAR_TOLERANCE {
        return Ok(None);
    }
    let u = (q1 - q0) * (1.0 / len);
    let n = plane.frame().z();
    let edges = face_edges(body, face);
    let reach = edges.iter().map(|e| edge_reach(e, q0)).fold(len, f64::max);
    if !reach.is_finite() {
        return Err(HoleError::internal(
            "tangent contact check: a face boundary without a finite extent",
        ));
    }
    let cut = Plane::from_point_normal(q0, n.cross(u))
        .map_err(|e| HoleError::internal(format!("tangent contact check: {e}")))?;
    let cut = Surface::Plane(cut);
    let tol = SsiTolerance::default();
    let mut split = vec![0.0, 1.0];
    let along = |p: Point3| (p - q0).dot(u) / len;
    for e in &edges {
        let hits = intersect_curve_surface(
            &e.curve,
            e.t_range,
            &cut,
            UvBox::natural(&cut, 4.0 * reach + 1.0),
            &tol,
        )
        .map_err(|err| HoleError::internal(format!("tangent contact check: {err}")))?;
        split.extend(hits.points.iter().map(|h| along(h.point)));
        for o in &hits.overlaps {
            split.push(along(e.curve.eval(o.t_range.0)));
            split.push(along(e.curve.eval(o.t_range.1)));
        }
    }
    // The tool face's own boundary along the ruling: its arcs' heights (the segment is affine
    // in the height, from v.0 at q0 to v.1 at q1).
    let (v0, v1) = seg.v;
    split.extend(arcs.iter().map(|a| (a.h - v0) / (v1 - v0)));
    let mut split: Vec<f64> = split
        .into_iter()
        .filter(|l| (0.0..=1.0).contains(l))
        .collect();
    split.sort_by(f64::total_cmp);
    for w in split.windows(2) {
        let (a, b) = (w[0], w[1]);
        if (b - a) * len <= 2.0 * LINEAR_TOLERANCE {
            continue;
        }
        for f in [0.5, 0.25, 0.75] {
            let s = a + (b - a) * f;
            if !tool_contains(z, arcs, seg.dir, v0 + s * (v1 - v0)) {
                continue;
            }
            let m = q0 + u * (len * s);
            let (inside, boundary) = planar_face_classify(body, face, m)?;
            if inside && boundary > LINEAR_TOLERANCE {
                return Ok(Some(m));
            }
        }
    }
    Ok(None)
}

/// Where a tool of a body operation touches a planar face of the result across that face's
/// interior ([`tool_contact`]): the correct result touches itself there.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolContact {
    /// `Edge`: a ruling of the tool lies along the face (the line test); `Vertex`: a cone's
    /// apex lies on it (the apex test).
    pub kind: EntityKind,
    /// A point of the contact inside the face.
    pub point: Point3,
}

/// [`tool_contact`] on a body operation's result bodies and tools.
pub(crate) fn tangent_contact(
    op: BodyOp,
    res: &BodyOpResult,
    tools: &[OpBody],
) -> Result<Option<ToolContact>, HoleError> {
    let result: Vec<&Body> = res.bodies.iter().map(|rb| &rb.body).collect();
    let tools: Vec<&Body> = tools.iter().map(|t| &t.body).collect();
    tool_contact(op, &result, &tools)
}

/// Where a tool of the body operation `op` lies along a planar face of one of the `result`
/// bodies across that face's interior, or touches it there with a cone's apex (see the module
/// docs), or `None`: where the correct result touches itself (`BOOLEAN_NON_MANIFOLD`). Line
/// contacts are reported before apex contacts. An intersect is not tested. Failures of the
/// test itself are `FORGE_HOLE_INTERNAL` (never a silent pass).
pub fn tool_contact(
    op: BodyOp,
    result: &[&Body],
    tools: &[&Body],
) -> Result<Option<ToolContact>, HoleError> {
    let sigma = match op {
        BodyOp::Cut => 1.0,
        BodyOp::Join => -1.0,
        BodyOp::Intersect => return Ok(None),
    };
    let ruled: Vec<Ruled> = tools.iter().flat_map(|t| ruled_faces(t)).collect();
    if ruled.is_empty() {
        return Ok(None);
    }
    // Planar faces of the result, grouped by their plane's bits (an optimization only): the
    // outward normal, the offset and the faces (body index, face, plane).
    type PlaneKey = [u64; 4];
    type PlaneFaces = (Vec3, f64, Vec<(usize, FaceId, Plane)>);
    let mut planes: BTreeMap<PlaneKey, PlaneFaces> = BTreeMap::new();
    for (b, body) in result.iter().enumerate() {
        for (fid, f) in body.faces().iter() {
            let Surface::Plane(pl) = &f.surface else {
                continue;
            };
            let n = if f.sense {
                pl.frame().z()
            } else {
                -pl.frame().z()
            };
            let c = pl.frame().origin().dot(n);
            let key = [n.x.to_bits(), n.y.to_bits(), n.z.to_bits(), c.to_bits()];
            planes
                .entry(key)
                .or_insert_with(|| (n, c, Vec::new()))
                .2
                .push((b, fid, *pl));
        }
    }
    for face in &ruled {
        for (n, c, faces) in planes.values() {
            let Some(seg) = contact_segment(face, *n, *c, sigma) else {
                continue;
            };
            for (b, fid, pl) in faces {
                if let Some(p) = inside_point(result[*b], *fid, pl, &seg, face.axis(), face.arcs())?
                {
                    return Ok(Some(ToolContact {
                        kind: EntityKind::Edge,
                        point: p,
                    }));
                }
            }
        }
    }
    for face in &ruled {
        for (n, c, faces) in planes.values() {
            let Some((foot, rho)) = apex_foot(face, *n, *c, sigma) else {
                continue;
            };
            for (b, fid, pl) in faces {
                if ring_inside(result[*b], *fid, pl, foot, rho)? {
                    return Ok(Some(ToolContact {
                        kind: EntityKind::Vertex,
                        point: foot,
                    }));
                }
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::linalg::Frame;
    use std::f64::consts::{FRAC_PI_2, PI, TAU};

    fn circle(o: Point3, z: Vec3, x: Vec3, r: f64) -> Circle3 {
        let f = Frame::from_normal_x(o, z, x).expect("frame");
        Circle3::new(f, r).expect("circle")
    }

    fn arc(o: Point3, z: Vec3, x: Vec3, r: f64, t: (f64, f64)) -> Arc {
        Arc {
            circle: circle(o, z, x, r),
            t,
            h: o.dot(z),
        }
    }

    #[test]
    fn a_drill_point_tip_runs_from_its_base_ring_to_the_apex() {
        use super::super::spec::{Depth, HoleSpec, Tip};
        use super::super::tool::hole_tool;
        use forge_ir::v1::metrics::HoleKind;
        // Ø3, blind 5, a 90° tip: the apex 1.5 below the shoulder.
        let spec = HoleSpec {
            feature: "h1".into(),
            kind: HoleKind::Simple,
            d: 3.0,
            depth: Depth::Blind(5.0),
            tip: Tip::Angle(90.0),
            cbore: None,
            csink: None,
            insert: None,
            size: None,
            thread: None,
            head_field: None,
        };
        let tool = hole_tool(
            &spec,
            "a",
            Point3::new(0.0, 0.0, 0.0),
            -Vec3::unit_z(),
            Vec3::unit_x(),
            5.0,
            false,
        )
        .expect("tool");
        let faces = ruled_faces(&tool);
        let len = |f: &Ruled| match f {
            Ruled::Cylinder { v, .. } | Ruled::Cone { v, .. } => v.1 - v.0,
        };
        let cyl: Vec<f64> = faces
            .iter()
            .filter(|f| matches!(f, Ruled::Cylinder { .. }))
            .map(len)
            .collect();
        let cone: Vec<&Ruled> = faces
            .iter()
            .filter(|f| matches!(f, Ruled::Cone { .. }))
            .collect();
        assert_eq!(cyl.len(), 1);
        assert!((cyl[0] - 5.0).abs() < 1e-12, "{cyl:?}");
        assert_eq!(cone.len(), 1);
        assert!((len(cone[0]) - 1.5).abs() < 1e-12, "{cone:?}");
        assert!(matches!(cone[0], Ruled::Cone { apex: true, .. }));
        // The apex (0, 0, −6.5) is in the face; the tip's ring (height of the shoulder) bounds
        // it, so every ruling point between them is too, and none beyond the ring.
        let Ruled::Cone { z, arcs, v, .. } = cone[0] else {
            unreachable!()
        };
        for k in 0..8 {
            let (s, c) = math::sin_cos(k as f64 * 0.8);
            let dir = (Vec3::new(c, s, 0.0) - *z * Vec3::new(c, s, 0.0).dot(*z))
                .normalize()
                .expect("unit");
            assert!(tool_contains(*z, arcs, dir, v.0 + 1e-3));
            assert!(tool_contains(*z, arcs, dir, 0.5 * (v.0 + v.1)));
            assert!(!tool_contains(*z, arcs, dir, v.1 + 1e-3));
        }
    }

    #[test]
    fn a_full_circle_spans_every_direction_and_an_arc_only_its_span() {
        let o = Point3::new(0.0, 0.0, 0.0);
        let full = arc(o, Vec3::unit_z(), Vec3::unit_x(), 2.0, (0.0, TAU));
        for k in 0..12 {
            let (s, c) = math::sin_cos(k as f64 * 0.5);
            assert!(spans(&full, Vec3::new(c, s, 0.0)));
        }
        // A quarter arc from +x to +y: its ends are not spanned (strict).
        let quarter = arc(o, Vec3::unit_z(), Vec3::unit_x(), 2.0, (0.0, FRAC_PI_2));
        assert!(spans(
            &quarter,
            Vec3::new(1.0, 1.0, 0.0).normalize().expect("unit")
        ));
        assert!(!spans(&quarter, -Vec3::unit_x()));
        assert!(!spans(
            &quarter,
            Vec3::new(1.0, -0.01, 0.0).normalize().expect("unit")
        ));
        // A circle whose frame is flipped against the axis measures angles its own way.
        let flipped = arc(o, -Vec3::unit_z(), Vec3::unit_x(), 2.0, (0.0, FRAC_PI_2));
        assert!(spans(
            &flipped,
            Vec3::new(1.0, -1.0, 0.0).normalize().expect("unit")
        ));
        assert!(!spans(
            &flipped,
            Vec3::new(1.0, 1.0, 0.0).normalize().expect("unit")
        ));
    }

    /// Review 5: the face of a rod along +x (radius 2) whose bottom a notch removed over
    /// `x ∈ [0, 25]`: boundary arcs at x = 0 (the top part), x = 25 (the bottom part, the
    /// step) and x = 40 (a full circle), plus two ruling lines along the notch. The bottom
    /// ruling belongs to the face over `[25, 40]` only; the top ruling over `[0, 40]`.
    #[test]
    fn a_notched_face_contains_a_ruling_only_where_the_notch_left_it() {
        let z = Vec3::unit_x();
        let x = -Vec3::unit_z(); // angle 0 at the bottom ruling (direction −Z)
        let at = |h: f64| Point3::new(h, 0.0, 0.0);
        // The notch removes the angles |φ| < 60° about the bottom (z below 12 − 1).
        let (lo, hi) = (PI / 3.0, 2.0 * PI - PI / 3.0);
        let arcs = vec![
            arc(at(0.0), z, x, 2.0, (lo, hi)),
            arc(at(25.0), z, x, 2.0, (-PI / 3.0, PI / 3.0)),
            arc(at(40.0), z, x, 2.0, (0.0, TAU)),
        ];
        let bottom = -Vec3::unit_z();
        let top = Vec3::unit_z();
        for h in [0.5, 2.5, 12.5, 24.9] {
            assert!(!tool_contains(z, &arcs, bottom, h), "bottom at {h}");
            assert!(tool_contains(z, &arcs, top, h), "top at {h}");
        }
        for h in [25.1, 32.5, 39.9] {
            assert!(tool_contains(z, &arcs, bottom, h), "bottom at {h}");
            assert!(tool_contains(z, &arcs, top, h), "top at {h}");
        }
        for h in [-0.1, 40.1] {
            assert!(!tool_contains(z, &arcs, bottom, h));
            assert!(!tool_contains(z, &arcs, top, h));
        }
        // The notch's boundary ruling (φ = 60°) belongs to the closed face all along.
        let (s, c) = math::sin_cos(PI / 3.0);
        let edge = x * c + z.cross(x) * s;
        for h in [2.5, 12.5, 32.5] {
            assert!(tool_contains(z, &arcs, edge, h), "the notch's edge at {h}");
        }
    }

    #[test]
    fn a_cylinder_lies_along_a_plane_only_on_the_conflicting_side_and_within_tol() {
        let (o, z) = (Point3::new(0.0, 0.0, 1.5), Vec3::unit_y());
        let arcs = vec![arc(o, z, Vec3::unit_x(), 1.5, (0.0, TAU))];
        let cyl = |dz: f64| Ruled::Cylinder {
            o: o + Vec3::unit_z() * dz,
            z,
            r: 1.5,
            v: (0.0, 10.0),
            arcs: arcs.clone(),
        };
        // The plate's bottom face z = 0 (outward normal −z): the cylinder above it is inside
        // the material (cut side), below it outside (join side).
        let n = -Vec3::unit_z();
        let seg = contact_segment(&cyl(0.0), n, 0.0, 1.0).expect("tangent from the material side");
        assert!(seg.q0.distance(Point3::new(0.0, 0.0, 0.0)) < 1e-12);
        assert!(seg.q1.distance(Point3::new(0.0, 10.0, 0.0)) < 1e-12);
        assert!(seg.dir.distance(-Vec3::unit_z()) < 1e-12);
        assert!(contact_segment(&cyl(0.0), n, 0.0, -1.0).is_none());
        assert!(contact_segment(&cyl(-3.0), n, 0.0, -1.0).is_some());
        assert!(contact_segment(&cyl(0.9e-6), n, 0.0, 1.0).is_some());
        assert!(contact_segment(&cyl(-0.9e-6), n, 0.0, 1.0).is_some());
        assert!(contact_segment(&cyl(1.1e-6), n, 0.0, 1.0).is_none());
        assert!(contact_segment(&cyl(-1.1e-6), n, 0.0, 1.0).is_none());
        // Tilted: one end within tol, the other not.
        let tilted = |dz: f64, len: f64| Ruled::Cylinder {
            o,
            z: Vec3::new(0.0, 1.0, dz).normalize().expect("unit"),
            r: 1.5,
            v: (0.0, len),
            arcs: arcs.clone(),
        };
        assert!(contact_segment(&tilted(2e-7, 10.0), n, 0.0, 1.0).is_none());
        // A face so short that a tilted ruling stays within tol all along is a contact (the
        // end distances decide; no angular pre-filter): 1e-3 rad over 1e-3 mm is 1e-6 mm.
        assert!(contact_segment(&tilted(0.5e-3, 1e-3), n, 0.0, 1.0).is_some());
        assert!(contact_segment(&tilted(2.5e-3, 1e-3), n, 0.0, 1.0).is_none());
        // An axis along the normal has no ruling along the plane.
        let upright = Ruled::Cylinder {
            o,
            z: Vec3::unit_z(),
            r: 1.5,
            v: (0.0, 10.0),
            arcs,
        };
        assert!(contact_segment(&upright, n, 0.0, 1.0).is_none());
    }

    #[test]
    fn a_cone_lies_along_a_plane_through_its_apex_at_its_half_angle() {
        // A 90° countersink cone (α = 45°) with its apex at the origin and axis tilted so a
        // generator lies in the plane z = 0; the cone above (inside the material of a bottom
        // face with outward normal −z).
        let alpha = std::f64::consts::FRAC_PI_4;
        let z = Vec3::new(1.0, 0.0, 1.0).normalize().expect("unit");
        let x = Vec3::new(-1.0, 0.0, 1.0).normalize().expect("unit");
        let o = Point3::new(0.0, 0.0, 0.0);
        let full = |h: f64| arc(o + z * h, z, x, h, (0.0, TAU));
        let cone = Ruled::Cone {
            o,
            z,
            radius: 0.0,
            alpha,
            v: (1.0, 3.0),
            arcs: vec![full(1.0), full(3.0)],
            apex: false,
        };
        let n = -Vec3::unit_z();
        let seg = contact_segment(&cone, n, 0.0, 1.0).expect("a generator in the plane");
        // The generator along +x: heights 1 and 3 along the axis are x = √2 and 3√2.
        assert!(
            seg.q0.distance(Point3::new(2f64.sqrt(), 0.0, 0.0)) < 1e-12,
            "{seg:?}"
        );
        assert!(
            seg.q1.distance(Point3::new(3.0 * 2f64.sqrt(), 0.0, 0.0)) < 1e-12,
            "{seg:?}"
        );
        assert!(contact_segment(&cone, n, 0.0, -1.0).is_none());
        assert!(contact_segment(&cone, Vec3::unit_z(), 0.0, 1.0).is_none());
        // Its apex lies in the plane, but a generator does too: a line contact, not an apex.
        assert!(apex_foot(&cone, n, 0.0, 1.0).is_none());
    }

    #[test]
    fn an_apex_touches_a_plane_it_meets_within_tol_from_the_conflicting_side() {
        // A drill tip (α = 59°) pointing down, apex at height `dz` over the plane z = 0 (a
        // plate's bottom face, outward normal −z): the cone widens upwards (+z).
        let alpha = 59f64.to_radians();
        let tip = |dz: f64, axis: Vec3| {
            let z = axis.normalize().expect("unit");
            Ruled::Cone {
                o: Point3::new(0.0, 0.0, dz),
                z,
                radius: 0.0,
                alpha,
                v: (0.0, 1.0),
                arcs: vec![arc(
                    Point3::new(0.0, 0.0, dz) + z,
                    z,
                    Vec3::unit_x(),
                    alpha.tan(),
                    (0.0, TAU),
                )],
                apex: true,
            }
        };
        let n = -Vec3::unit_z();
        let up = Vec3::unit_z();
        for dz in [0.0, 0.5e-6, -0.5e-6, 0.99e-6] {
            let (foot, rho) = apex_foot(&tip(dz, up), n, 0.0, 1.0).expect("an apex on the face");
            assert!(
                foot.distance(Point3::new(0.0, 0.0, 0.0)) < 1e-15,
                "{dz}: {foot:?}"
            );
            assert!((rho - 1e-6 * (alpha.tan() + 2.0)).abs() < 1e-15, "{rho}");
        }
        for dz in [1.5e-6, -1.5e-6] {
            assert!(apex_foot(&tip(dz, up), n, 0.0, 1.0).is_none(), "{dz}");
        }
        // A cut's tool touching the face from outside (the join's side) removes nothing there.
        assert!(apex_foot(&tip(0.0, -up), n, 0.0, 1.0).is_none());
        assert!(apex_foot(&tip(0.0, -up), n, 0.0, -1.0).is_some());
        // Tilted by more than 90° − α = 31°, a generator crosses the plane: no point contact.
        let (s, c) = math::sin_cos(30f64.to_radians());
        assert!(apex_foot(&tip(0.0, Vec3::new(s, 0.0, c)), n, 0.0, 1.0).is_some());
        let (s, c) = math::sin_cos(32f64.to_radians());
        assert!(apex_foot(&tip(0.0, Vec3::new(s, 0.0, c)), n, 0.0, 1.0).is_none());
        // A cone face that does not reach its apex has no apex contact.
        let mut frustum = tip(0.0, up);
        if let Ruled::Cone { apex, .. } = &mut frustum {
            *apex = false;
        }
        assert!(apex_foot(&frustum, n, 0.0, 1.0).is_none());
    }
}
