//! # Modelled screw threads
//!
//! [`thread_face`] turns a cylindrical face — a hole's wall (nut thread) or a boss (bolt
//! thread) — into an exact helical thread of the 60° basic profile ([`ThreadForm`], ISO 68-1 /
//! ASME B1.1), by **direct B-rep construction**: no boolean and no surface–surface
//! intersection is involved, so no B-spline approximation enters the model.
//!
//! # Geometry (thread frame: origin on the axis, `z` along it)
//! Start `j` of `n` has its groove centre at `z = j·P + p·θ` (`p = ±n·P/2π`, positive for a
//! right-hand thread); at `θ = 0` the groove of start 0 is centred on `z = 0`. Its faces:
//! - two **flanks**, exact [`Helicoid`]s `z = c + k·ρ + p·θ` with `k = ∓tan 30°`;
//! - the **root**, a strip of the cylinder at the root radius (`D/2` nut, `D1/2` bolt);
//! - the **crest** is what remains of the original cylinder face.
//!
//! Every edge is exact: flank ∩ cylinder is a circular [`Helix3`]; flank ∩ end plane is an
//! Archimedean spiral (a [`Helix3`] of rise 0, pcurve [`Spiral2`] on the plane); cylinder ∩
//! end plane are circular arcs. Every pcurve on a flank or cylinder is a straight line of the
//! face's `(u, v)` space.
//!
//! # Ends
//! The thread spans `[z_a, z_b]` of the face (`z_1 ≤ z_a < z_b ≤ z_2`). At each end:
//! - **on a plane across the axis** (the entry face of a hole, a through hole's exit, a flat
//!   floor, the shoulder under a boss): the plane's boundary circle becomes the boundary of
//!   the bore plus the groove sections (nut) or of the boss minus them (bolt) — the plane
//!   loses (entry face) or gains (floor) the sections, whichever side it is on;
//! - **on a coaxial cone** on the far side (a drill point, a countersink): a planar end face
//!   closes each groove, and the circle is split between the crest and the end faces;
//! - **inside the face** (a thread shorter than the bore): a planar end face closes each
//!   groove; the crest face continues past it as the plain cylinder.
//!
//! # Checks (never silently wrong)
//! The form's numbers and the crest diameter ([`ThreadForm::check_crest`]); the face is a
//! coaxial cylinder bounded by exactly two full circles; the ends; and the **clearance** of
//! the thread's region (`clear`): no other face of the body may come within the annulus the
//! groove occupies, and a plane end must hold the groove sections — otherwise the groove
//! would break through a wall, which direct construction cannot represent
//! (`THREAD_INTERFERENCE`). The result must pass `forge_core::topo::validate` and
//! `forge_check::validate`; a failure there is `FORGE_THREAD_INTERNAL`.
//!
//! # Identity
//! The crest face keeps its provenance. New faces are `F/thread_upper`, `F/thread_lower`,
//! `F/thread_root`, `F/thread_end_start`, `F/thread_end_end` (the qualifier of the request —
//! a hole position — as `@p`; starts after the first as the source `s<j>`), new edges
//! `F/edge:{A|B}` and vertices `F/vertex:{…}` keyed by the faces around them, as booleans
//! name theirs. A circle split at a cone end keeps the circle's key on its crest pieces.

mod clear;
mod error;
mod form;

pub use error::ThreadError;
pub use form::{MIN_CREST_FLAT, ThreadForm, ThreadKind};

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::geom::{
    Circle2, Circle3, Curve2, Curve3, Cylinder, Helicoid, Helix3, Line2, NurbsCurve2, Plane,
    Spiral2, Surface,
};
use forge_core::linalg::{Frame, Point2, Point3, Vec2, Vec3};
use forge_core::math;
use forge_core::topo::{Body, BodyBuilder, CoedgeId, EdgeId, FaceId, Provenance, Role, VertexId};
use forge_ir::v1::LINEAR_TOLERANCE;

/// Smallest distance (mm) between a thread end inside a face and the face's boundary
/// circle: closer ends would leave a sliver of plain bore (`THREAD_END_TOO_CLOSE`).
pub const END_MARGIN: f64 = 1e-3;

/// Directions are parallel (coaxial surfaces, planes across the axis) when the sine of the
/// angle between them is at most this.
pub const AXIS_EPS: f64 = 1e-9;

/// What to thread: the form, where its axis is, and how far it runs.
#[derive(Clone, Copy, Debug)]
pub struct ThreadRequest<'a> {
    /// The thread form.
    pub form: ThreadForm,
    /// The thread frame: origin on the axis, `z` along it. The groove of start 0 is centred
    /// on `z = 0` at the angle of `x`.
    pub frame: Frame,
    /// The axial range `[z_a, z_b]` (thread-frame `z`) to thread; it must lie within the
    /// face (its ends on the face's boundary circles or at least [`END_MARGIN`] inside).
    pub z_range: (f64, f64),
    /// The feature id naming the new entities.
    pub feature: &'a str,
    /// The key qualifier of the new faces (a hole position), if any.
    pub qualifier: Option<&'a str>,
}

// ---- geometry ------------------------------------------------------------------------------

/// The resolved numbers of a thread in its frame.
#[derive(Clone, Copy, Debug)]
struct Geo {
    frame: Frame,
    /// Rise per radian (signed).
    h: f64,
    /// `tan 30°`.
    t: f64,
    /// Crest and root radius.
    rc: f64,
    rr: f64,
    /// `+1` nut, `−1` bolt.
    sigma: f64,
    w_root: f64,
    pitch: f64,
    starts: u32,
}

impl Geo {
    /// `(c, k)` of a flank of start `j`: `z = c + k·ρ + h·θ`.
    fn flank(&self, j: u32, up: bool) -> (f64, f64) {
        let base = j as f64 * self.pitch;
        let half = 0.5 * self.w_root + self.sigma * self.rr * self.t;
        if up {
            (base + half, -self.sigma * self.t)
        } else {
            (base - half, self.sigma * self.t)
        }
    }
    /// The angle at which a flank passes radius `r` at height `z`.
    fn theta(&self, j: u32, up: bool, z: f64, r: f64) -> f64 {
        let (c, k) = self.flank(j, up);
        (z - c - k * r) / self.h
    }
    fn point(&self, theta: f64, r: f64, z: f64) -> Point3 {
        let (s, c) = math::sin_cos(theta);
        self.frame.eval_point(Vec3::new(r * c, r * s, z))
    }
    fn er(&self, theta: f64) -> Vec3 {
        let (s, c) = math::sin_cos(theta);
        self.frame.eval_vector(Vec3::new(c, s, 0.0))
    }
    fn eu(&self, theta: f64) -> Vec3 {
        let (s, c) = math::sin_cos(theta);
        self.frame.eval_vector(Vec3::new(-s, c, 0.0))
    }
    fn z(&self) -> Vec3 {
        self.frame.z()
    }
    /// The frame moved along the axis to height `z`.
    fn at(&self, z: f64) -> Frame {
        self.frame
            .with_origin(self.frame.origin() + self.frame.z() * z)
    }
    fn helicoid(&self, j: u32, up: bool) -> Result<Helicoid, ThreadError> {
        let (c, k) = self.flank(j, up);
        Helicoid::new(self.at(c), self.h, k).map_err(|e| ThreadError::internal(e.to_string()))
    }
    /// Local `(θ ∈ (−π, π], ρ, z)` of a point.
    fn local(&self, p: Point3) -> (f64, f64, f64) {
        let l = self.frame.to_local_point(p);
        (math::atan2(l.y, l.x), math::hypot(l.x, l.y), l.z)
    }
}

/// How a coaxial cylinder's `(u, v)` depend on the thread's `(θ, z)`:
/// `u = s·θ − φ`·… (see [`CylMap::uv`]).
#[derive(Clone, Copy, Debug)]
struct CylMap {
    /// `+1` when the cylinder's axis points along the thread's `z`.
    s: f64,
    /// Angle of the cylinder's `x` in the thread frame.
    phi0: f64,
    /// Height of the cylinder's origin in the thread frame.
    delta: f64,
}

impl CylMap {
    fn new(g: &Geo, f: &Frame) -> Self {
        let l = g.frame.to_local_vector(f.x());
        Self {
            s: if f.z().dot(g.z()) > 0.0 { 1.0 } else { -1.0 },
            phi0: math::atan2(l.y, l.x),
            delta: (f.origin() - g.frame.origin()).dot(g.z()),
        }
    }
    fn uv(&self, theta: f64, z: f64) -> Vec2 {
        Vec2::new(self.s * (theta - self.phi0), self.s * (z - self.delta))
    }
}

/// How a circle's parameter depends on the thread angle: `θ = ψ + ζ·t`.
#[derive(Clone, Copy, Debug)]
struct CircMap {
    zeta: f64,
    psi: f64,
}

impl CircMap {
    fn new(g: &Geo, f: &Frame) -> Self {
        let l = g.frame.to_local_vector(f.x());
        Self {
            zeta: if f.z().dot(g.z()) > 0.0 { 1.0 } else { -1.0 },
            psi: math::atan2(l.y, l.x),
        }
    }
    fn theta(&self, t: f64) -> f64 {
        self.psi + self.zeta * t
    }
    fn t(&self, theta: f64) -> f64 {
        self.zeta * (theta - self.psi)
    }
}

/// A straight pcurve through `p0` (at `t0`) and `p1` (at `t1`): a [`Line2`] when it is
/// traversed at unit speed along a parameter axis (bit-exact), a degree-1 B-spline otherwise.
fn linear_pcurve(t0: f64, t1: f64, p0: Vec2, p1: Vec2) -> Result<Curve2, ThreadError> {
    let d = (p1 - p0) * (1.0 / (t1 - t0));
    // Bit-exact tests on purpose: only an exactly unit, axis-aligned speed is a Line2.
    let one = |x: f64| x.abs().to_bits() == 1f64.to_bits();
    let zero = |x: f64| x.abs().to_bits() == 0f64.to_bits();
    let unit_axis = (one(d.x) && zero(d.y)) || (zero(d.x) && one(d.y));
    if unit_axis {
        return Line2::new(p0 - d * t0, d)
            .map(Into::into)
            .map_err(|e| ThreadError::internal(e.to_string()));
    }
    NurbsCurve2::new(
        1,
        vec![t0, t0, t1, t1],
        vec![p0.to_array(), p1.to_array()],
        None,
    )
    .map(Into::into)
    .map_err(|e| ThreadError::internal(e.to_string()))
}

/// A pcurve that moves along `u` at unit speed (`du/dt = ±1`) at constant `v`: an arc on a
/// coaxial cylinder.
fn u_line(u_at_0: f64, du: f64, v: f64) -> Result<Curve2, ThreadError> {
    Line2::new(Point2::new(u_at_0, v), Vec2::new(du, 0.0))
        .map(Into::into)
        .map_err(|e| ThreadError::internal(e.to_string()))
}

// ---- the body under construction -----------------------------------------------------------

/// A face of the new body.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Slot {
    /// The rebuilt crest face.
    Crest,
    /// Flank of start `j`, upper (`true`) or lower.
    Flank(u32, bool),
    /// Root strip of start `j`.
    Root(u32),
    /// Groove end face at end `e` (0 = `z_a`, 1 = `z_b`) of start `j`.
    End(usize, u32),
    /// The neighbour face at end `e` (a plane or a cone), rebuilt around its circle.
    Neighbor(usize),
}

/// A loop as `(edge, forward, pcurve)` uses, in traversal order.
type LoopUses = Vec<(EdgeId, bool, Curve2)>;

/// One use of a new edge by a face: direction and pcurve.
#[derive(Clone, Debug)]
struct Use {
    edge: EdgeId,
    fwd: bool,
    pcurve: Curve2,
}

/// The geometry of a slot's face, for orientation.
#[derive(Clone, Debug)]
struct SlotFace {
    surface: Surface,
    sense: bool,
    prov: Provenance,
}

/// The ring circle at one end of the crest face.
#[derive(Clone, Debug)]
struct Ring {
    edge: EdgeId,
    circle: Circle3,
    range: (f64, f64),
    /// Height along the thread axis.
    z: f64,
    /// Forward flag and pcurve of the ring's coedge on the crest face.
    crest_fwd: bool,
    crest_pc: Curve2,
    /// The other face using the circle, with its coedge's forward flag and pcurve.
    neighbor: FaceId,
    neighbor_fwd: bool,
    neighbor_pc: Curve2,
}

/// How a thread end meets the body.
#[derive(Clone, Debug)]
enum EndKind {
    /// On the ring's plane across the axis.
    Plane(Ring),
    /// On the ring, whose other face is a coaxial cone on the far side.
    Cone(Ring),
    /// Inside the crest face.
    Inside,
}

impl EndKind {
    fn ring(&self) -> Option<&Ring> {
        match self {
            EndKind::Plane(r) | EndKind::Cone(r) => Some(r),
            EndKind::Inside => None,
        }
    }
    /// A groove end face closes the groove at this end.
    fn has_end_face(&self) -> bool {
        !matches!(self, EndKind::Plane(_))
    }
}

fn face_name(body: &Body, f: FaceId) -> String {
    body.face(f)
        .map(|f| f.provenance.name())
        .unwrap_or_else(|| "?".into())
}

/// The ring at one loop of the crest face (a full circle on the thread's axis with the
/// crest radius), or why the loop is not one.
fn ring_of_loop(
    body: &Body,
    g: &Geo,
    crest: FaceId,
    lid: forge_core::topo::LoopId,
) -> Result<Ring, String> {
    let lp = body.loop_(lid).ok_or("dangling loop")?;
    if lp.coedges.len() != 1 {
        return Err(format!(
            "a boundary loop has {} edges; a threadable cylinder is bounded by two full circles",
            lp.coedges.len()
        ));
    }
    let cid = lp.coedges[0];
    let c = body.coedge(cid).ok_or("dangling coedge")?;
    let e = body.edge(c.edge).ok_or("dangling edge")?;
    let Curve3::Circle(circle) = &e.curve else {
        return Err(format!(
            "a boundary edge is a {}, not a circle",
            e.curve.kind_name()
        ));
    };
    if !e.is_ring() {
        return Err("a boundary circle is split by vertices".into());
    }
    let (_, rho, z) = g.local(circle.frame().origin());
    if rho > LINEAR_TOLERANCE || circle.frame().z().cross(g.z()).norm() > AXIS_EPS {
        return Err("a boundary circle is not centred on the axis".into());
    }
    if (circle.radius() - g.rc).abs() > LINEAR_TOLERANCE {
        return Err("a boundary circle's radius differs from the cylinder's".into());
    }
    let crest_pc = c.pcurve.clone().ok_or("a coedge has no pcurve")?;
    let other = e
        .coedges
        .iter()
        .copied()
        .find(|&x| x != cid)
        .ok_or("a boundary circle has one face")?;
    if e.coedges.len() != 2 {
        return Err("a boundary circle is not used by exactly two faces".into());
    }
    let oc = body.coedge(other).ok_or("dangling coedge")?;
    let neighbor = body.loop_(oc.loop_id).ok_or("dangling loop")?.face;
    if neighbor == crest {
        return Err("the circle bounds the face on both sides".into());
    }
    Ok(Ring {
        edge: c.edge,
        circle: *circle,
        range: e.t_range,
        z,
        crest_fwd: c.forward,
        crest_pc,
        neighbor,
        neighbor_fwd: oc.forward,
        neighbor_pc: oc.pcurve.clone().ok_or("a coedge has no pcurve")?,
    })
}

/// Classify the thread end at height `ze` on the side `s` (`+1`: the thread lies at larger
/// `z`, end `a`; `−1`: end `b`), given the crest face's ring at that side.
fn end_kind(
    body: &Body,
    g: &Geo,
    crest_name: &str,
    ze: f64,
    s: f64,
    ring: Ring,
) -> Result<EndKind, ThreadError> {
    let gap = (ze - ring.z).abs();
    if gap > LINEAR_TOLERANCE {
        if gap < END_MARGIN {
            return Err(ThreadError::EndTooClose {
                face: crest_name.into(),
                distance: gap,
                margin: END_MARGIN,
            });
        }
        return Ok(EndKind::Inside);
    }
    let nb = body
        .face(ring.neighbor)
        .ok_or_else(|| ThreadError::internal("dangling neighbour face"))?;
    let nname = nb.provenance.name();
    match &nb.surface {
        Surface::Plane(p) => {
            if p.frame().z().cross(g.z()).norm() > AXIS_EPS {
                return Err(ThreadError::EndUnsupported {
                    face: nname,
                    reason: "the plane is not perpendicular to the thread's axis".into(),
                });
            }
            Ok(EndKind::Plane(ring))
        }
        Surface::Cone(c) => {
            let (_, rho, _) = g.local(c.frame().origin());
            if rho > LINEAR_TOLERANCE || c.frame().z().cross(g.z()).norm() > AXIS_EPS {
                return Err(ThreadError::EndUnsupported {
                    face: nname,
                    reason: "the cone is not coaxial with the thread".into(),
                });
            }
            // The cone must lie on the far side of the end (a drill point below a bore, a
            // countersink above it), never over the thread's region.
            let far = far_point(body, ring.neighbor, ring.edge, c.apex())?;
            let (_, _, zf) = g.local(far);
            if (zf - ze) * s >= -LINEAR_TOLERANCE {
                return Err(ThreadError::EndUnsupported {
                    face: nname,
                    reason: "the cone lies over the thread's region".into(),
                });
            }
            Ok(EndKind::Cone(ring))
        }
        other => Err(ThreadError::EndUnsupported {
            face: nname,
            reason: format!(
                "a thread can end on a plane across the axis or a coaxial cone, not on a {}",
                other.kind_name()
            ),
        }),
    }
}

/// A point of face `f` away from its circle `ring`: the start of another loop's first edge,
/// or the cone's apex when the circle is the face's only boundary.
fn far_point(body: &Body, f: FaceId, ring: EdgeId, apex: Point3) -> Result<Point3, ThreadError> {
    let face = body
        .face(f)
        .ok_or_else(|| ThreadError::internal("dangling face"))?;
    for &lid in &face.loops {
        let lp = body
            .loop_(lid)
            .ok_or_else(|| ThreadError::internal("dangling loop"))?;
        for &cid in &lp.coedges {
            let c = body
                .coedge(cid)
                .ok_or_else(|| ThreadError::internal("dangling coedge"))?;
            if c.edge == ring {
                continue;
            }
            let e = body
                .edge(c.edge)
                .ok_or_else(|| ThreadError::internal("dangling edge"))?;
            return Ok(e.curve.eval(0.5 * (e.t_range.0 + e.t_range.1)));
        }
    }
    Ok(apex)
}

/// Is a use of `curve` (over `range`) by a face with `surface`/`sense` forward, given the
/// direction `d` pointing into the face at the curve's midpoint? The face lies to the left of
/// its boundary seen from outside: `(N × T)·d > 0`.
fn forward(
    curve: &Curve3,
    range: (f64, f64),
    pcurve: &Curve2,
    surface: &Surface,
    sense: bool,
    d: Vec3,
) -> Result<bool, ThreadError> {
    let tm = 0.5 * (range.0 + range.1);
    let tan = curve.d1(tm);
    let uv = pcurve.eval(tm);
    let n = surface
        .normal(uv.x, uv.y)
        .ok_or_else(|| ThreadError::internal("degenerate normal"))?;
    let n = if sense { n } else { -n };
    let x = n.cross(tan).dot(d);
    if x.abs() <= 1e-9 * tan.norm() * d.norm() {
        return Err(ThreadError::internal(
            "an edge's orientation on a face is undecided",
        ));
    }
    Ok(x > 0.0)
}

/// The inward direction at the midpoint of a use, given in thread terms.
#[derive(Clone, Copy, Debug)]
enum Into_ {
    /// `±z`.
    Axial(f64),
    /// `±e_r(θ)` at the point.
    Radial(f64),
    /// `±e_u(θ)` at the point.
    Tangential(f64),
    /// `±S_u` of the face's surface at the pcurve point.
    Su(f64),
    /// `±S_v` of the face's surface at the pcurve point.
    Sv(f64),
}

/// Build the thread (see the module docs).
pub fn thread_face(
    body: &Body,
    face: FaceId,
    req: &ThreadRequest<'_>,
) -> Result<Body, ThreadError> {
    let form = req.form;
    form.validate()?;
    let fc = body
        .face(face)
        .ok_or_else(|| ThreadError::internal("the face id does not resolve"))?;
    let crest_name = fc.provenance.name();
    let unsupported = |reason: &str| ThreadError::FaceUnsupported {
        face: crest_name.clone(),
        reason: reason.into(),
    };
    let Surface::Cylinder(cyl) = &fc.surface else {
        return Err(unsupported(&format!(
            "it is a {}, not a cylinder",
            fc.surface.kind_name()
        )));
    };
    let frame = req.frame;
    let rc = cyl.radius();
    let g = Geo {
        frame,
        h: form.rise(),
        t: ThreadForm::tan_half_angle(),
        rc,
        rr: form.root_radius(),
        sigma: form.sigma(),
        w_root: form.root_flat(),
        pitch: form.pitch,
        starts: form.starts,
    };
    {
        let (_, rho, _) = g.local(cyl.frame().origin());
        if rho > LINEAR_TOLERANCE || cyl.frame().z().cross(frame.z()).norm() > AXIS_EPS {
            return Err(unsupported("the cylinder is not on the thread's axis"));
        }
    }
    form.check_crest(2.0 * rc)?;
    // The material side must match the thread kind: a nut's bore faces the axis.
    let outward_is_out = fc.sense;
    match form.kind {
        ThreadKind::Internal if outward_is_out => {
            return Err(unsupported(
                "an internal thread needs a bore (the face's material is inside it)",
            ));
        }
        ThreadKind::External if !outward_is_out => {
            return Err(unsupported(
                "an external thread needs a boss (the face's material is outside it)",
            ));
        }
        _ => {}
    }
    if fc.loops.len() != 2 {
        return Err(unsupported(&format!(
            "it has {} boundary loops; a threadable cylinder is bounded by two full circles",
            fc.loops.len()
        )));
    }
    let mut rings = Vec::with_capacity(2);
    for &lid in &fc.loops {
        rings.push(ring_of_loop(body, &g, face, lid).map_err(|r| unsupported(&r))?);
    }
    rings.sort_by(|a, b| a.z.total_cmp(&b.z));
    let ring_b = rings.pop().expect("two rings");
    let ring_a = rings.pop().expect("two rings");
    let (za, zb) = req.z_range;
    if !(za.is_finite() && zb.is_finite() && zb - za > END_MARGIN) {
        return Err(ThreadError::InvalidValue {
            field: "length".into(),
            value: zb - za,
            expected: format!("> {END_MARGIN} mm"),
        });
    }
    if za < ring_a.z - LINEAR_TOLERANCE || zb > ring_b.z + LINEAR_TOLERANCE {
        return Err(ThreadError::LengthOutOfRange {
            face: crest_name.clone(),
            start: za,
            end: zb,
            face_start: ring_a.z,
            face_end: ring_b.z,
        });
    }
    let ends = [
        end_kind(body, &g, &crest_name, za, 1.0, ring_a.clone())?,
        end_kind(body, &g, &crest_name, zb, -1.0, ring_b.clone())?,
    ];
    if matches!(ends, [EndKind::Inside, EndKind::Inside]) {
        // A groove band floating inside the bore would be a hole winding several turns in
        // the crest face; a thread starts at an opening of its face.
        return Err(ThreadError::EndUnsupported {
            face: crest_name.clone(),
            reason: "a thread must start at an end of its cylinder (both ends are inside it)"
                .into(),
        });
    }
    // Thread ends on a ring are exactly at the ring's height.
    let zs = [
        ends[0].ring().map_or(za, |r| r.z),
        ends[1].ring().map_or(zb, |r| r.z),
    ];
    clear::check(body, face, &g, zs, &ends)?;
    Builder::new(body, face, g, zs, ends, req)?.build()
}

// ---- construction ---------------------------------------------------------------------------

struct Builder<'a> {
    src: &'a Body,
    crest: FaceId,
    g: Geo,
    zs: [f64; 2],
    ends: [EndKind; 2],
    feature: &'a str,
    qualifier: Option<&'a str>,
    bb: BodyBuilder,
    vmap: BTreeMap<VertexId, VertexId>,
    emap: BTreeMap<EdgeId, EdgeId>,
    /// New edges: curve and range (for orientation), start and end vertex.
    edges: BTreeMap<EdgeId, (Curve3, (f64, f64), VertexId, VertexId)>,
    uses: BTreeMap<Slot, Vec<Use>>,
    slots: BTreeMap<Slot, SlotFace>,
}

impl<'a> Builder<'a> {
    fn new(
        src: &'a Body,
        crest: FaceId,
        g: Geo,
        zs: [f64; 2],
        ends: [EndKind; 2],
        req: &ThreadRequest<'a>,
    ) -> Result<Self, ThreadError> {
        let mut b = Self {
            src,
            crest,
            g,
            zs,
            ends,
            feature: req.feature,
            qualifier: req.qualifier,
            bb: BodyBuilder::with_tolerance(Tolerance::IR_DEFAULT),
            vmap: BTreeMap::new(),
            emap: BTreeMap::new(),
            edges: BTreeMap::new(),
            uses: BTreeMap::new(),
            slots: BTreeMap::new(),
        };
        b.define_slots()?;
        Ok(b)
    }

    fn face_prov(&self, label: &str, j: u32) -> Provenance {
        let mut p = Provenance::new(self.feature, Role::Other(label.into()));
        if j > 0 {
            p = p.with_sources([format!("s{j}")]);
        }
        if let Some(q) = self.qualifier {
            p = p.with_qualifier(q);
        }
        p.with_index(j)
    }

    /// The end planes' frames: a ring's circle frame (so the circle's pcurve on the end
    /// face is a `Circle2`), or the thread frame at the end's height.
    fn end_frame(&self, e: usize) -> Frame {
        match self.ends[e].ring() {
            Some(r) => *r.circle.frame(),
            None => self.g.at(self.zs[e]),
        }
    }

    fn define_slots(&mut self) -> Result<(), ThreadError> {
        let src = self.src;
        let cf = src
            .face(self.crest)
            .ok_or_else(|| ThreadError::internal("crest face"))?;
        self.slots.insert(
            Slot::Crest,
            SlotFace {
                surface: cf.surface.clone(),
                sense: cf.sense,
                prov: cf.provenance.clone(),
            },
        );
        let internal = self.g.sigma > 0.0;
        for j in 0..self.g.starts {
            for up in [true, false] {
                let label = if up { "thread_upper" } else { "thread_lower" };
                self.slots.insert(
                    Slot::Flank(j, up),
                    SlotFace {
                        surface: self.g.helicoid(j, up)?.into(),
                        // The parametric normal points to smaller heights: outward (into the
                        // groove) on the upper flank.
                        sense: up,
                        prov: self.face_prov(label, j),
                    },
                );
            }
            let root = Cylinder::new(self.g.frame, self.g.rr)
                .map_err(|e| ThreadError::internal(e.to_string()))?;
            self.slots.insert(
                Slot::Root(j),
                SlotFace {
                    surface: root.into(),
                    // Nut: the material is outside the root, its outward normal points in.
                    sense: !internal,
                    prov: self.face_prov("thread_root", j),
                },
            );
            for e in 0..2 {
                if self.ends[e].has_end_face() {
                    let f = self.end_frame(e);
                    // Outward: into the groove, i.e. towards the thread's side of the end.
                    let out = if e == 0 { self.g.z() } else { -self.g.z() };
                    let label = if e == 0 {
                        "thread_end_start"
                    } else {
                        "thread_end_end"
                    };
                    self.slots.insert(
                        Slot::End(e, j),
                        SlotFace {
                            surface: Plane::new(f).into(),
                            sense: f.z().dot(out) > 0.0,
                            prov: self.face_prov(label, j),
                        },
                    );
                }
            }
        }
        for e in 0..2 {
            if let Some(r) = self.ends[e].ring() {
                let nf = src
                    .face(r.neighbor)
                    .ok_or_else(|| ThreadError::internal("neighbour face"))?;
                self.slots.insert(
                    Slot::Neighbor(e),
                    SlotFace {
                        surface: nf.surface.clone(),
                        sense: nf.sense,
                        prov: nf.provenance.clone(),
                    },
                );
            }
        }
        Ok(())
    }

    fn key(&self, s: Slot) -> String {
        self.slots[&s].prov.key()
    }

    fn edge_prov(&self, a: Slot, b: Slot, index: u32) -> Provenance {
        Provenance::edge_between(self.feature, self.key(a), self.key(b)).with_index(index)
    }

    fn vertex_prov(&self, slots: &[Slot], index: u32) -> Provenance {
        let keys: Vec<String> = slots.iter().map(|&s| self.key(s)).collect();
        Provenance::vertex_at(self.feature, keys).with_index(index)
    }

    fn topo(e: forge_core::topo::TopoError) -> ThreadError {
        ThreadError::internal(format!("topology: {e}"))
    }

    fn add_edge(
        &mut self,
        curve: Curve3,
        range: (f64, f64),
        start: VertexId,
        end: VertexId,
        prov: Provenance,
    ) -> Result<EdgeId, ThreadError> {
        let id = self
            .bb
            .add_edge(curve.clone(), range, start, end, prov)
            .map_err(Self::topo)?;
        self.edges.insert(id, (curve, range, start, end));
        Ok(id)
    }

    /// Record the use of `edge` by `slot`, oriented by the inward direction `into`.
    fn use_edge(
        &mut self,
        slot: Slot,
        edge: EdgeId,
        pcurve: Curve2,
        into: Into_,
    ) -> Result<(), ThreadError> {
        let (curve, range, _, _) = self.edges[&edge].clone();
        let sf = &self.slots[&slot];
        let tm = 0.5 * (range.0 + range.1);
        let (theta, _, _) = self.g.local(curve.eval(tm));
        let uv = pcurve.eval(tm);
        let d = match into {
            Into_::Axial(s) => self.g.z() * s,
            Into_::Radial(s) => self.g.er(theta) * s,
            Into_::Tangential(s) => self.g.eu(theta) * s,
            Into_::Su(s) => sf.surface.du(uv.x, uv.y) * s,
            Into_::Sv(s) => sf.surface.dv(uv.x, uv.y) * s,
        };
        let fwd = forward(&curve, range, &pcurve, &sf.surface, sf.sense, d)?;
        self.uses
            .entry(slot)
            .or_default()
            .push(Use { edge, fwd, pcurve });
        Ok(())
    }

    /// Record a use with a known direction (pieces of an existing circle keep its
    /// coedges' directions).
    fn use_edge_dir(&mut self, slot: Slot, edge: EdgeId, fwd: bool, pcurve: Curve2) {
        self.uses
            .entry(slot)
            .or_default()
            .push(Use { edge, fwd, pcurve });
    }

    fn build(mut self) -> Result<Body, ThreadError> {
        let src = self.src;
        let g = self.g;
        let n = g.starts;
        let (rc, rr) = (g.rc, g.rr);
        let sgn_h = if g.h > 0.0 { 1.0 } else { -1.0 };

        // 1. Copy the vertices and the edges that stay.
        for (vid, v) in src.vertices().iter() {
            let nv = self
                .bb
                .add_vertex(v.point, v.provenance.clone())
                .map_err(Self::topo)?;
            self.bb
                .set_vertex_tolerance(nv, v.tolerance)
                .map_err(Self::topo)?;
            self.vmap.insert(vid, nv);
        }
        let replaced: Vec<EdgeId> = self
            .ends
            .iter()
            .filter_map(|e| e.ring().map(|r| r.edge))
            .collect();
        for (eid, e) in src.edges().iter() {
            if replaced.contains(&eid) {
                continue;
            }
            let ne = match (e.start, e.end) {
                (Some(a), Some(b)) => self.bb.add_edge(
                    e.curve.clone(),
                    e.t_range,
                    self.vmap[&a],
                    self.vmap[&b],
                    e.provenance.clone(),
                ),
                _ => self.bb.add_ring_edge_with_range(
                    e.curve.clone(),
                    e.t_range,
                    e.provenance.clone(),
                ),
            }
            .map_err(Self::topo)?;
            self.bb
                .set_edge_tolerance(ne, e.tolerance)
                .map_err(Self::topo)?;
            self.emap.insert(eid, ne);
        }

        // 2. Thread vertices: V[e][j][up][outer] (outer: root radius).
        let mut verts: BTreeMap<(usize, u32, bool, bool), VertexId> = BTreeMap::new();
        for e in 0..2 {
            let ze = self.zs[e];
            let plane = if self.ends[e].has_end_face() {
                None
            } else {
                Some(Slot::Neighbor(e))
            };
            for j in 0..n {
                for up in [true, false] {
                    for outer in [false, true] {
                        let r = if outer { rr } else { rc };
                        let p = g.point(g.theta(j, up, ze, r), r, ze);
                        let mut around = vec![Slot::Flank(j, up)];
                        around.push(if outer { Slot::Root(j) } else { Slot::Crest });
                        match plane {
                            Some(s) => around.push(s),
                            None => {
                                around.push(Slot::End(e, j));
                                if !outer && matches!(self.ends[e], EndKind::Cone(_)) {
                                    around.push(Slot::Neighbor(e));
                                }
                            }
                        }
                        let prov = self.vertex_prov(&around, 0);
                        let v = self.bb.add_vertex(p, prov).map_err(Self::topo)?;
                        verts.insert((e, j, up, outer), v);
                    }
                }
            }
        }

        // 3. Helices: flank ∩ crest and flank ∩ root.
        for j in 0..n {
            for up in [true, false] {
                let (c, k) = g.flank(j, up);
                for outer in [false, true] {
                    let r = if outer { rr } else { rc };
                    let ta = g.theta(j, up, self.zs[0], r);
                    let tb = g.theta(j, up, self.zs[1], r);
                    let (t0, t1, v0, v1) = if ta < tb {
                        (ta, tb, verts[&(0, j, up, outer)], verts[&(1, j, up, outer)])
                    } else {
                        (tb, ta, verts[&(1, j, up, outer)], verts[&(0, j, up, outer)])
                    };
                    let helix = Helix3::new(g.at(c + k * r), r, 0.0, g.h)
                        .map_err(|e| ThreadError::internal(e.to_string()))?;
                    let cyl_slot = if outer { Slot::Root(j) } else { Slot::Crest };
                    let prov = self.edge_prov(Slot::Flank(j, up), cyl_slot, 0);
                    let eid = self.add_edge(helix.into(), (t0, t1), v0, v1, prov)?;
                    // On the flank: u = t, v = r.
                    let pc_f = u_line(0.0, 1.0, r)?;
                    let toward_other = if outer { rc - rr } else { rr - rc };
                    self.use_edge(
                        Slot::Flank(j, up),
                        eid,
                        pc_f,
                        Into_::Sv(toward_other.signum()),
                    )?;
                    // On the cylinder: (θ, z(θ)) mapped.
                    let cyl_frame = match &self.slots[&cyl_slot].surface {
                        Surface::Cylinder(cy) => *cy.frame(),
                        _ => return Err(ThreadError::internal("cylinder slot")),
                    };
                    let m = CylMap::new(&g, &cyl_frame);
                    let z_of = |t: f64| c + k * r + g.h * t;
                    let pc_c = linear_pcurve(t0, t1, m.uv(t0, z_of(t0)), m.uv(t1, z_of(t1)))?;
                    // The crest lies beyond the groove, the root inside it.
                    let axial = match (outer, up) {
                        (false, true) | (true, false) => 1.0,
                        (false, false) | (true, true) => -1.0,
                    };
                    self.use_edge(cyl_slot, eid, pc_c, Into_::Axial(axial))?;
                }
            }
        }

        // 4. Per end: spirals, root arcs, arcs at the crest radius.
        for e in 0..2 {
            let ze = self.zs[e];
            let s_e = if e == 0 { 1.0 } else { -1.0 };
            let end = self.ends[e].clone();
            // The plane of this end (a neighbour plane, or the end faces' plane).
            let plane_frame = match &end {
                EndKind::Plane(r) => match &src.face(r.neighbor).map(|f| &f.surface) {
                    Some(Surface::Plane(p)) => *p.frame(),
                    _ => return Err(ThreadError::internal("plane neighbour")),
                },
                _ => self.end_frame(e),
            };
            // For a plane end: which side of the circle the plane lies on (+1 inside), and the
            // inward directions of the region X = bore ∪ sections (nut) / boss − sections (bolt).
            let plane_side = match &end {
                EndKind::Plane(r) => {
                    let nf = src
                        .face(r.neighbor)
                        .ok_or_else(|| ThreadError::internal("neighbour"))?;
                    let tm = 0.5 * (r.range.0 + r.range.1);
                    let tan = r.circle.derivs2(tm)[1] * if r.neighbor_fwd { 1.0 } else { -1.0 };
                    let pn = plane_frame.z() * if nf.sense { 1.0 } else { -1.0 };
                    let (theta, _, _) = g.local(r.circle.eval(tm));
                    let left = pn.cross(tan);
                    if left.dot(-g.er(theta)) > 0.0 {
                        1.0
                    } else {
                        -1.0
                    }
                }
                _ => 1.0,
            };
            let internal = g.sigma > 0.0;
            for j in 0..n {
                // Spirals.
                for up in [true, false] {
                    let (c, k) = g.flank(j, up);
                    let r0 = (ze - c) / k;
                    let a = -g.h / k;
                    let tc = g.theta(j, up, ze, rc);
                    let tr = g.theta(j, up, ze, rr);
                    let (t0, t1, v0, v1) = if tc < tr {
                        (tc, tr, verts[&(e, j, up, false)], verts[&(e, j, up, true)])
                    } else {
                        (tr, tc, verts[&(e, j, up, true)], verts[&(e, j, up, false)])
                    };
                    let spiral = Helix3::new(g.at(ze), r0, a, 0.0)
                        .map_err(|x| ThreadError::internal(x.to_string()))?;
                    let pslot = if end.has_end_face() {
                        Slot::End(e, j)
                    } else {
                        Slot::Neighbor(e)
                    };
                    let prov = self.edge_prov(Slot::Flank(j, up), pslot, 0);
                    let eid = self.add_edge(spiral.into(), (t0, t1), v0, v1, prov)?;
                    let pc_f = linear_pcurve(
                        t0,
                        t1,
                        Vec2::new(t0, r0 + a * t0),
                        Vec2::new(t1, r0 + a * t1),
                    )?;
                    self.use_edge(Slot::Flank(j, up), eid, pc_f, Into_::Su(s_e * sgn_h))?;
                    let pc_p: Curve2 = Spiral2::from_planar_helix(&spiral, &plane_frame)
                        .map_err(|x| ThreadError::internal(x.to_string()))?
                        .into();
                    // Into the groove section: from the upper flank towards the lower one.
                    let into_section = if up { sgn_h } else { -sgn_h };
                    let d = if end.has_end_face() {
                        into_section
                    } else if internal {
                        // X = bore ∪ sections: into the section.
                        plane_side * into_section
                    } else {
                        // X = boss − sections: away from the section.
                        -plane_side * into_section
                    };
                    self.use_edge(pslot, eid, pc_p, Into_::Tangential(d))?;
                }
                // Root arc across the groove's root flat.
                let arc_frame = plane_frame.with_origin(g.at(ze).origin());
                let cm = CircMap::new(&g, &arc_frame);
                let tu = cm.t(g.theta(j, true, ze, rr));
                let tl = cm.t(g.theta(j, false, ze, rr));
                let (t0, span) = if tu < tl {
                    (tu, tl - tu)
                } else {
                    (tl, tu - tl)
                };
                let (va, vb) = if tu < tl {
                    (verts[&(e, j, true, true)], verts[&(e, j, false, true)])
                } else {
                    (verts[&(e, j, false, true)], verts[&(e, j, true, true)])
                };
                let arc = Circle3::new(arc_frame, rr)
                    .map_err(|x| ThreadError::internal(x.to_string()))?;
                let pslot = if end.has_end_face() {
                    Slot::End(e, j)
                } else {
                    Slot::Neighbor(e)
                };
                let prov = self.edge_prov(Slot::Root(j), pslot, 0);
                let eid = self.add_edge(arc.into(), (t0, t0 + span), va, vb, prov)?;
                let root_m = CylMap::new(&g, &g.frame);
                let pc_r = u_line(
                    root_m.s * (cm.psi - root_m.phi0),
                    root_m.s * cm.zeta,
                    root_m.s * (ze - root_m.delta),
                )?;
                self.use_edge(Slot::Root(j), eid, pc_r, Into_::Axial(s_e))?;
                let centre = plane_frame.to_local_point(arc_frame.origin());
                let pc_p: Curve2 = Circle2::new(Vec2::new(centre.x, centre.y), rr)
                    .map_err(|x| ThreadError::internal(x.to_string()))?
                    .into();
                let to_crest = (rc - rr).signum();
                let d = if end.has_end_face() {
                    to_crest
                } else if internal {
                    // Into the section (towards the axis).
                    plane_side * to_crest
                } else {
                    // Into the boss's remainder (inside the root).
                    -plane_side
                };
                self.use_edge(pslot, eid, pc_p, Into_::Radial(d))?;
            }
            // Arcs at the crest radius.
            self.crest_arcs(e, &verts, plane_frame, plane_side)?;
        }

        // 5. Faces, in the source's order; the thread's new faces after them.
        self.emit_faces()?;
        let body = self.bb.finish();
        let issues = forge_core::topo::validate(&body);
        if std::env::var_os("FORGE_THREAD_DEBUG").is_some() {
            debug_dump(&body, &issues);
        }
        if forge_core::topo::has_errors(&issues) {
            let first: Vec<String> = issues
                .iter()
                .filter(|i| i.severity == forge_core::topo::Severity::Error)
                .take(4)
                .map(|i| format!("{}: {}", i.code.as_str(), i.message))
                .collect();
            return Err(ThreadError::internal(format!(
                "the threaded body is invalid: {}",
                first.join("; ")
            )));
        }
        let report = forge_check::validate(&body);
        if let Some(i) = report
            .iter()
            .find(|i| i.severity == forge_core::topo::Severity::Error)
        {
            return Err(ThreadError::internal(format!(
                "the threaded body fails its checks: {} {}",
                i.code, i.message
            )));
        }
        Ok(body)
    }

    /// The circle of the crest radius at end `e`: split at the flanks. Plane ends keep the
    /// crest pieces (the openings are inside the plane's new boundary), inner ends the
    /// opening pieces (the crest face continues past the end), cone ends both.
    fn crest_arcs(
        &mut self,
        e: usize,
        verts: &BTreeMap<(usize, u32, bool, bool), VertexId>,
        plane_frame: Frame,
        plane_side: f64,
    ) -> Result<(), ThreadError> {
        let g = self.g;
        let n = g.starts;
        let ze = self.zs[e];
        let s_e = if e == 0 { 1.0 } else { -1.0 };
        let sgn_h = if g.h > 0.0 { 1.0 } else { -1.0 };
        let end = self.ends[e].clone();
        let (circle, t_base) = match end.ring() {
            Some(r) => (r.circle, r.range.0),
            None => (
                Circle3::new(g.at(ze), g.rc).map_err(|x| ThreadError::internal(x.to_string()))?,
                0.0,
            ),
        };
        let cm = CircMap::new(&g, circle.frame());
        // Split points in the circle's parameter, within [t_base, t_base + 2π).
        let mut pts: Vec<(f64, u32, bool)> = Vec::with_capacity(2 * n as usize);
        for j in 0..n {
            for up in [true, false] {
                let t = cm.t(g.theta(j, up, ze, g.rc));
                pts.push((t_base + math::rem_euclid(t - t_base, math::TAU), j, up));
            }
        }
        pts.sort_by(|a, b| a.0.total_cmp(&b.0));
        // Going in increasing t, an opening starts at an upper flank iff ζ·sign(h) > 0.
        let opening_starts_up = cm.zeta * sgn_h > 0.0;
        let crest_m = match &self.slots[&Slot::Crest].surface {
            Surface::Cylinder(cy) => CylMap::new(&g, cy.frame()),
            _ => return Err(ThreadError::internal("crest cylinder")),
        };
        let crest_sense_pc = |t: f64| -> Vec2 { crest_m.uv(cm.theta(t), ze) };
        let m = pts.len();
        let mut crest_index = 0u32;
        for i in 0..m {
            let (ta, ja, upa) = pts[i];
            let (tb0, jb, upb) = pts[(i + 1) % m];
            let tb = if i + 1 == m { tb0 + math::TAU } else { tb0 };
            if tb.partial_cmp(&ta) != Some(std::cmp::Ordering::Greater) {
                return Err(ThreadError::internal("coincident flank points on a circle"));
            }
            let opening = ja == jb && upa == opening_starts_up && upb != upa;
            let va = verts[&(e, ja, upa, false)];
            let vb = verts[&(e, jb, upb, false)];
            let keep = matches!(
                (&end, opening),
                (EndKind::Plane(_), false) | (EndKind::Inside, true) | (EndKind::Cone(_), _)
            );
            if !keep {
                continue;
            }
            if opening {
                let j = ja;
                // Crest face ↔ end face (inner end) or neighbour ↔ end face (cone end).
                let other = match &end {
                    EndKind::Inside => Slot::Crest,
                    _ => Slot::Neighbor(e),
                };
                let prov = self.edge_prov(Slot::End(e, j), other, 0);
                let eid = self.add_edge(circle.into(), (ta, tb), va, vb, prov)?;
                let pc_end: Curve2 = Circle2::new(Vec2::zero(), g.rc)
                    .map_err(|x| ThreadError::internal(x.to_string()))?
                    .into();
                // The end face lies across the groove, beyond the crest radius (nut) or
                // inside it (bolt).
                self.use_edge(
                    Slot::End(e, j),
                    eid,
                    pc_end,
                    Into_::Radial((g.rr - g.rc).signum()),
                )?;
                match &end {
                    EndKind::Inside => {
                        let p0 = crest_sense_pc(0.0);
                        let p1 = crest_sense_pc(1.0);
                        let pc = u_line(p0.x, p1.x - p0.x, p0.y)?;
                        // The crest face continues past the end, away from the thread.
                        self.use_edge(Slot::Crest, eid, pc, Into_::Axial(-s_e))?;
                    }
                    EndKind::Cone(r) => {
                        let (fwd, pc) = (r.neighbor_fwd, r.neighbor_pc.clone());
                        self.use_edge_dir(Slot::Neighbor(e), eid, fwd, pc);
                    }
                    EndKind::Plane(_) => unreachable!("plane ends keep no openings"),
                }
            } else {
                // A crest piece of the ring: crest face ↔ neighbour, the ring's key.
                let r = end
                    .ring()
                    .expect("crest pieces are kept on ring ends")
                    .clone();
                let src_prov = self
                    .src
                    .edge(r.edge)
                    .map(|x| x.provenance.clone())
                    .ok_or_else(|| ThreadError::internal("ring edge"))?;
                let prov = src_prov.with_index(crest_index);
                crest_index += 1;
                let eid = self.add_edge(circle.into(), (ta, tb), va, vb, prov)?;
                self.use_edge_dir(Slot::Crest, eid, r.crest_fwd, r.crest_pc.clone());
                self.use_edge_dir(
                    Slot::Neighbor(e),
                    eid,
                    r.neighbor_fwd,
                    r.neighbor_pc.clone(),
                );
                // Cross-check the kept direction with the geometric rule on the plane.
                if let EndKind::Plane(_) = &end {
                    let d = -plane_side;
                    let (curve, range, _, _) = self.edges[&eid].clone();
                    let sf = &self.slots[&Slot::Neighbor(e)];
                    let pc = &r.neighbor_pc;
                    let tm = 0.5 * (range.0 + range.1);
                    let (theta, _, _) = g.local(curve.eval(tm));
                    let want = forward(&curve, range, pc, &sf.surface, sf.sense, g.er(theta) * d)?;
                    if want != r.neighbor_fwd {
                        return Err(ThreadError::internal(
                            "the plane's side of its circle is inconsistent",
                        ));
                    }
                    let _ = plane_frame;
                }
            }
        }
        Ok(())
    }

    /// Chain uses into closed loops (each vertex has exactly one outgoing use).
    fn chain(&self, uses: &[Use]) -> Result<Vec<Vec<usize>>, ThreadError> {
        let ends = |u: &Use| -> (VertexId, VertexId) {
            let (_, _, a, b) = self.edges[&u.edge];
            if u.fwd { (a, b) } else { (b, a) }
        };
        let mut by_start: BTreeMap<VertexId, Vec<usize>> = BTreeMap::new();
        for (i, u) in uses.iter().enumerate() {
            by_start.entry(ends(u).0).or_default().push(i);
        }
        if by_start.values().any(|v| v.len() != 1) {
            return Err(ThreadError::internal(
                "a vertex starts more than one boundary edge of a face",
            ));
        }
        let mut used = vec![false; uses.len()];
        let mut loops = Vec::new();
        for s in 0..uses.len() {
            if used[s] {
                continue;
            }
            let start_v = ends(&uses[s]).0;
            let mut lp = Vec::new();
            let mut cur = s;
            loop {
                if used[cur] {
                    return Err(ThreadError::internal("a boundary loop does not close"));
                }
                used[cur] = true;
                lp.push(cur);
                let next_v = ends(&uses[cur]).1;
                if next_v == start_v {
                    break;
                }
                cur = *by_start
                    .get(&next_v)
                    .and_then(|v| v.first())
                    .ok_or_else(|| ThreadError::internal("a boundary loop is open"))?;
            }
            loops.push(lp);
        }
        Ok(loops)
    }

    fn add_loop_with_pcurves(
        &mut self,
        f: FaceId,
        uses: &[(EdgeId, bool, Curve2)],
    ) -> Result<(), ThreadError> {
        let spec: Vec<(EdgeId, bool)> = uses.iter().map(|(e, d, _)| (*e, *d)).collect();
        let lid = self.bb.add_loop(f, &spec).map_err(Self::topo)?;
        let cids: Vec<CoedgeId> = self
            .bb
            .body()
            .loop_(lid)
            .map(|l| l.coedges.clone())
            .unwrap_or_default();
        for (cid, (_, _, pc)) in cids.into_iter().zip(uses) {
            self.bb.set_pcurve(cid, pc.clone()).map_err(Self::topo)?;
        }
        Ok(())
    }

    /// The new loops of a slot, chained from its uses.
    fn slot_loops(&self, slot: Slot) -> Result<Vec<LoopUses>, ThreadError> {
        let uses = self.uses.get(&slot).cloned().unwrap_or_default();
        let loops = self.chain(&uses)?;
        Ok(loops
            .into_iter()
            .map(|lp| {
                lp.into_iter()
                    .map(|i| (uses[i].edge, uses[i].fwd, uses[i].pcurve.clone()))
                    .collect()
            })
            .collect())
    }

    /// The source loop of a face as new uses (edges mapped, pcurves kept).
    fn copied_loop(&self, lid: forge_core::topo::LoopId) -> Result<LoopUses, ThreadError> {
        let src = self.src;
        let lp = src
            .loop_(lid)
            .ok_or_else(|| ThreadError::internal("dangling loop"))?;
        lp.coedges
            .iter()
            .map(|&cid| {
                let c = src
                    .coedge(cid)
                    .ok_or_else(|| ThreadError::internal("dangling coedge"))?;
                let e = *self
                    .emap
                    .get(&c.edge)
                    .ok_or_else(|| ThreadError::internal("an edge was not copied"))?;
                let pc = c
                    .pcurve
                    .clone()
                    .ok_or_else(|| ThreadError::internal("a coedge has no pcurve"))?;
                Ok((e, c.forward, pc))
            })
            .collect()
    }

    fn emit_faces(&mut self) -> Result<(), ThreadError> {
        let src = self.src;
        let mut smap = BTreeMap::new();
        for &sid in src.shell_ids() {
            let closed = src.shell(sid).map(|s| s.closed).unwrap_or(true);
            smap.insert(sid, self.bb.add_shell(closed));
        }
        let ring_loop_of = |fid: FaceId, edge: EdgeId| -> Option<forge_core::topo::LoopId> {
            src.face(fid)?.loops.iter().copied().find(|&l| {
                src.loop_(l).is_some_and(|lp| {
                    lp.coedges
                        .iter()
                        .any(|&c| src.coedge(c).is_some_and(|c| c.edge == edge))
                })
            })
        };
        let mut crest_shell = None;
        for (fid, f) in src.faces().iter() {
            let shell = smap[&f.shell];
            let nf = self
                .bb
                .add_face(shell, f.surface.clone(), f.sense, f.provenance.clone())
                .map_err(Self::topo)?;
            if fid == self.crest {
                crest_shell = Some(shell);
                // Untouched rings (inner ends) first, in the source's order, then the new
                // loops.
                for &lid in &f.loops {
                    let ring_edge = src
                        .loop_(lid)
                        .and_then(|l| l.coedges.first().copied())
                        .and_then(|c| src.coedge(c))
                        .map(|c| c.edge);
                    let replaced = self
                        .ends
                        .iter()
                        .any(|e| e.ring().is_some_and(|r| Some(r.edge) == ring_edge));
                    if !replaced {
                        let lp = self.copied_loop(lid)?;
                        self.add_loop_with_pcurves(nf, &lp)?;
                    }
                }
                // Threaded end to end, the crest is one helical strip per start: separate
                // faces (pieces of the original face, sharing its key). Otherwise the plain
                // part of the bore joins the strips into one face.
                let loops = self.slot_loops(Slot::Crest)?;
                let split = self.ends.iter().all(|e| e.ring().is_some());
                let mut pieces = loops.into_iter();
                if let Some(first) = pieces.next() {
                    self.add_loop_with_pcurves(nf, &first)?;
                }
                for (k, lp) in pieces.enumerate() {
                    let target = if split {
                        self.bb
                            .add_face(
                                shell,
                                f.surface.clone(),
                                f.sense,
                                f.provenance.clone().with_index(k as u32 + 1),
                            )
                            .map_err(Self::topo)?
                    } else {
                        nf
                    };
                    self.add_loop_with_pcurves(target, &lp)?;
                }
                continue;
            }
            let mut end_here = None;
            for e in 0..2 {
                if let Some(r) = self.ends[e].ring()
                    && r.neighbor == fid
                {
                    end_here = Some((e, r.edge));
                }
            }
            match end_here {
                None => {
                    for &lid in &f.loops {
                        let lp = self.copied_loop(lid)?;
                        self.add_loop_with_pcurves(nf, &lp)?;
                    }
                }
                Some((e, ring_edge)) => {
                    let ring_loop = ring_loop_of(fid, ring_edge);
                    for &lid in &f.loops {
                        if Some(lid) == ring_loop {
                            let loops = self.slot_loops(Slot::Neighbor(e))?;
                            if loops.len() != 1 {
                                return Err(ThreadError::internal(format!(
                                    "the circle's replacement on {} forms {} loops",
                                    face_name(src, fid),
                                    loops.len()
                                )));
                            }
                            self.add_loop_with_pcurves(nf, &loops[0])?;
                        } else {
                            let lp = self.copied_loop(lid)?;
                            self.add_loop_with_pcurves(nf, &lp)?;
                        }
                    }
                }
            }
        }
        let shell = crest_shell.ok_or_else(|| ThreadError::internal("crest shell"))?;
        let slots: Vec<Slot> = self
            .slots
            .keys()
            .copied()
            .filter(|s| !matches!(s, Slot::Crest | Slot::Neighbor(_)))
            .collect();
        for s in slots {
            let sf = self.slots[&s].clone();
            let nf = self
                .bb
                .add_face(shell, sf.surface, sf.sense, sf.prov)
                .map_err(Self::topo)?;
            let loops = self.slot_loops(s)?;
            if loops.len() != 1 {
                return Err(ThreadError::internal(format!(
                    "a thread face forms {} loops",
                    loops.len()
                )));
            }
            self.add_loop_with_pcurves(nf, &loops[0])?;
        }
        Ok(())
    }
}

/// `FORGE_THREAD_DEBUG`: every face's loops (edge kinds, directions, ends) and the
/// validation issues, on stderr.
fn debug_dump(body: &Body, issues: &[forge_core::topo::TopoIssue]) {
    for i in issues {
        eprintln!("[thread] issue {}: {}", i.code.as_str(), i.message);
    }
    for f in body.faces().values() {
        eprintln!(
            "[thread] face {} {} sense={} loops={}",
            f.provenance.name(),
            f.surface.kind_name(),
            f.sense,
            f.loops.len()
        );
        for &lid in &f.loops {
            let Some(lp) = body.loop_(lid) else { continue };
            for &cid in &lp.coedges {
                let Some(c) = body.coedge(cid) else { continue };
                let Some(e) = body.edge(c.edge) else { continue };
                let (a, b) = (e.curve.eval(e.t_range.0), e.curve.eval(e.t_range.1));
                let (a, b) = if c.forward { (a, b) } else { (b, a) };
                eprintln!(
                    "[thread]   {} fwd={} {:.4?} -> {:.4?} ({})",
                    e.curve.kind_name(),
                    c.forward,
                    a.to_array(),
                    b.to_array(),
                    e.provenance.name()
                );
            }
            eprintln!("[thread]   --");
        }
    }
}

/// The coaxial cylinder faces of `body` with radius `r` (within the tolerance) whose axial
/// extent (thread-frame `z`) overlaps `z_range`, in body order, with their extents.
pub fn crest_faces(
    body: &Body,
    frame: &Frame,
    r: f64,
    z_range: (f64, f64),
) -> Vec<(FaceId, (f64, f64))> {
    let mut out = Vec::new();
    for (fid, f) in body.faces().iter() {
        let Surface::Cylinder(c) = &f.surface else {
            continue;
        };
        let l = frame.to_local_point(c.frame().origin());
        if math::hypot(l.x, l.y) > LINEAR_TOLERANCE
            || c.frame().z().cross(frame.z()).norm() > AXIS_EPS
            || (c.radius() - r).abs() > LINEAR_TOLERANCE
        {
            continue;
        }
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for e in body.face_edges(fid) {
            let Some(e) = body.edge(e) else { continue };
            for k in 0..=8 {
                let t = e.t_range.0 + (e.t_range.1 - e.t_range.0) * k as f64 / 8.0;
                let z = frame.to_local_point(e.curve.eval(t)).z;
                lo = lo.min(z);
                hi = hi.max(z);
            }
        }
        if lo <= z_range.1 && hi >= z_range.0 {
            out.push((fid, (lo, hi)));
        }
    }
    out
}
