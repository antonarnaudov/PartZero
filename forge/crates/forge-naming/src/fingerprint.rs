//! Geometric fingerprints of faces and edges.
//!
//! A [`Fingerprint`] is what a stored reference remembers about the geometry of the
//! entity it points at, *in addition to* its provenance name. It is only consulted when
//! the name alone is not trustworthy (ADR 0006 layers 2 and 4): to pick among split
//! pieces or index siblings, to notice that a name now denotes a changed entity, and to
//! find a geometric match when the name is gone.
//!
//! # Fields
//! - [`GeomKind`]: surface or curve type.
//! - [`Support`]: the exact carrier (plane with oriented normal and offset, cylinder
//!   axis/radius, line direction/position, circle centre/normal/radius, …) in world
//!   coordinates, with sign-canonical axis directions so equal carriers compare equal.
//! - `size`: face area (integrated on a deflection-bounded tessellation, a heuristic
//!   only) or edge length (from a fine polyline).
//! - `centroid` (world) and `local` (the centroid normalised to the body's bounding box,
//!   i.e. "in the body's local terms", robust to moving or scaling the whole body).
//! - `bbox`: the entity's own bounding box.
//! - `same_support_neighbors`: how many adjacent entities lie on the *same* carrier (a
//!   face's coplanar/co-cylindrical neighbours across an edge, an edge's collinear or
//!   co-circular neighbours through a vertex). An increase is the signature of a split.
//! - `family`: how many entities of the body share the name up to its `#index`.
//!
//! Everything here is deterministic: arenas are walked in index order and all reductions
//! run in a fixed order.

use std::collections::{BTreeMap, BTreeSet};

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Point3, Vec3};
use forge_core::math;
use forge_core::topo::{Body, EdgeId, FaceId, VertexId};
use forge_mesh::{BodyMesh, TessParams, tessellate};

/// Angle (rad) within which two carrier directions are the same.
pub const SUPPORT_ANGLE_TOL: f64 = 1e-7;
/// Relative linear tolerance (times `max(1, scale)`) within which two carriers coincide.
pub const SUPPORT_LINEAR_TOL: f64 = 1e-6;
/// Segments used to sample an edge for its length, centroid and box.
const EDGE_SEGMENTS: usize = 64;

/// Surface or curve type of an entity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum GeomKind {
    /// Planar face.
    Plane,
    /// Cylindrical face.
    Cylinder,
    /// Conical face.
    Cone,
    /// Spherical face.
    Sphere,
    /// Toroidal face.
    Torus,
    /// B-spline face.
    BSplineSurface,
    /// Straight edge.
    Line,
    /// Circular edge (arc or ring).
    Circle,
    /// Elliptical edge.
    Ellipse,
    /// B-spline edge.
    BSplineCurve,
}

impl GeomKind {
    /// Lower-case name used in reports.
    pub fn as_str(self) -> &'static str {
        match self {
            GeomKind::Plane => "plane",
            GeomKind::Cylinder => "cylinder",
            GeomKind::Cone => "cone",
            GeomKind::Sphere => "sphere",
            GeomKind::Torus => "torus",
            GeomKind::BSplineSurface => "bspline",
            GeomKind::Line => "line",
            GeomKind::Circle => "circle",
            GeomKind::Ellipse => "ellipse",
            GeomKind::BSplineCurve => "bspline-curve",
        }
    }
}

/// The exact carrier of an entity, in world coordinates. Axis directions are
/// sign-canonical (see [`canonical_axis`]); a plane keeps its *outward* normal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Support {
    /// Plane `normal · p = offset` (outward normal).
    Plane {
        /// Outward unit normal.
        normal: [f64; 3],
        /// Signed offset along `normal`.
        offset: f64,
    },
    /// Circular cylinder.
    Cylinder {
        /// Canonical axis direction.
        axis: [f64; 3],
        /// Point of the axis closest to the world origin.
        point: [f64; 3],
        /// Radius.
        radius: f64,
    },
    /// Circular cone.
    Cone {
        /// Canonical axis direction.
        axis: [f64; 3],
        /// Apex.
        apex: [f64; 3],
        /// Half angle (rad).
        half_angle: f64,
    },
    /// Sphere.
    Sphere {
        /// Centre.
        center: [f64; 3],
        /// Radius.
        radius: f64,
    },
    /// Torus.
    Torus {
        /// Canonical axis direction.
        axis: [f64; 3],
        /// Centre.
        center: [f64; 3],
        /// Major radius.
        major: f64,
        /// Minor radius.
        minor: f64,
    },
    /// Infinite line.
    Line {
        /// Canonical direction.
        dir: [f64; 3],
        /// Point of the line closest to the world origin.
        point: [f64; 3],
    },
    /// Full circle carrying an arc or ring edge.
    Circle {
        /// Canonical normal.
        normal: [f64; 3],
        /// Centre.
        center: [f64; 3],
        /// Radius.
        radius: f64,
    },
    /// No analytic carrier (B-splines, ellipses): only size and position are compared.
    Free,
}

/// How far apart two carriers are: `(angle between directions, linear offset)`.
/// `None` when they are of different types (or [`Support::Free`]).
pub fn support_gap(a: &Support, b: &Support) -> Option<(f64, f64)> {
    let ang = |x: &[f64; 3], y: &[f64; 3]| angle(v3(*x), v3(*y));
    let dist = |x: &[f64; 3], y: &[f64; 3]| v3(*x).distance(v3(*y));
    Some(match (a, b) {
        (
            Support::Plane {
                normal: n1,
                offset: d1,
            },
            Support::Plane {
                normal: n2,
                offset: d2,
            },
        ) => (ang(n1, n2), (d1 - d2).abs()),
        (
            Support::Cylinder {
                axis: a1,
                point: p1,
                radius: r1,
            },
            Support::Cylinder {
                axis: a2,
                point: p2,
                radius: r2,
            },
        ) => (ang(a1, a2), dist(p1, p2) + (r1 - r2).abs()),
        (
            Support::Cone {
                axis: a1,
                apex: p1,
                half_angle: h1,
            },
            Support::Cone {
                axis: a2,
                apex: p2,
                half_angle: h2,
            },
        ) => (ang(a1, a2) + (h1 - h2).abs(), dist(p1, p2)),
        (
            Support::Sphere {
                center: c1,
                radius: r1,
            },
            Support::Sphere {
                center: c2,
                radius: r2,
            },
        ) => (0.0, dist(c1, c2) + (r1 - r2).abs()),
        (
            Support::Torus {
                axis: a1,
                center: c1,
                major: m1,
                minor: n1,
            },
            Support::Torus {
                axis: a2,
                center: c2,
                major: m2,
                minor: n2,
            },
        ) => (
            ang(a1, a2),
            dist(c1, c2) + (m1 - m2).abs() + (n1 - n2).abs(),
        ),
        (Support::Line { dir: d1, point: p1 }, Support::Line { dir: d2, point: p2 }) => {
            (ang(d1, d2), dist(p1, p2))
        }
        (
            Support::Circle {
                normal: n1,
                center: c1,
                radius: r1,
            },
            Support::Circle {
                normal: n2,
                center: c2,
                radius: r2,
            },
        ) => (ang(n1, n2), dist(c1, c2) + (r1 - r2).abs()),
        _ => return None,
    })
}

/// `true` if the two carriers coincide (same type, directions within
/// [`SUPPORT_ANGLE_TOL`], offsets within [`SUPPORT_LINEAR_TOL`]` · max(1, scale)`).
pub fn same_support(a: &Support, b: &Support, scale: f64) -> bool {
    match support_gap(a, b) {
        Some((ang, off)) => ang <= SUPPORT_ANGLE_TOL && off <= SUPPORT_LINEAR_TOL * scale.max(1.0),
        None => false,
    }
}

/// What a reference remembers about an entity's geometry (see the module docs).
#[derive(Clone, Debug, PartialEq)]
pub struct Fingerprint {
    /// Surface or curve type.
    pub kind: GeomKind,
    /// Exact carrier.
    pub support: Support,
    /// Area (faces) or length (edges); 0 when unknown.
    pub size: f64,
    /// Centroid (world).
    pub centroid: [f64; 3],
    /// Centroid normalised to the owning body's bounding box (each component in `[0, 1]`).
    pub local: [f64; 3],
    /// Centre of the owning body's bounding box (world): tells apart look-alike bodies
    /// whose local coordinates coincide.
    pub body_center: [f64; 3],
    /// The entity's bounding box `(min, max)`.
    pub bbox: ([f64; 3], [f64; 3]),
    /// Diagonal of the owning body's bounding box (the length scale of comparisons).
    pub scale: f64,
    /// Adjacent entities on the same carrier (split signature).
    pub same_support_neighbors: u32,
    /// Entities of the body sharing the name up to its `#index`.
    pub family: u32,
}

// ---- vector helpers ---------------------------------------------------------------------

pub(crate) fn v3(a: [f64; 3]) -> Vec3 {
    Vec3::from(a)
}

fn sq(x: f64) -> f64 {
    x * x
}

fn angle(a: Vec3, b: Vec3) -> f64 {
    // atan2(|a × b|, a · b) is accurate for tiny angles (acos is not).
    math::atan2(a.cross(b).norm(), a.dot(b))
}

/// Sign-canonical direction: the first component with magnitude above 1e-9 is positive.
pub fn canonical_axis(d: Vec3) -> Vec3 {
    let s = [d.x, d.y, d.z]
        .into_iter()
        .find(|c| c.abs() > 1e-9)
        .map_or(1.0, |c| if c < 0.0 { -1.0 } else { 1.0 });
    d * s
}

/// Point of the line `(p, d)` (unit `d`) closest to the world origin.
fn closest_to_origin(p: Point3, d: Vec3) -> Point3 {
    p - d * p.dot(d)
}

// ---- supports ----------------------------------------------------------------------------

/// Kind and carrier of a face (outward normal for planes).
pub fn face_support(surface: &Surface, sense: bool) -> (GeomKind, Support) {
    match surface {
        Surface::Plane(p) => {
            let n = if sense { p.frame().z() } else { -p.frame().z() };
            (
                GeomKind::Plane,
                Support::Plane {
                    normal: n.to_array(),
                    offset: n.dot(p.frame().origin()),
                },
            )
        }
        Surface::Cylinder(c) => {
            let a = canonical_axis(c.frame().z());
            (
                GeomKind::Cylinder,
                Support::Cylinder {
                    axis: a.to_array(),
                    point: closest_to_origin(c.frame().origin(), a).to_array(),
                    radius: c.radius(),
                },
            )
        }
        Surface::Cone(c) => (
            GeomKind::Cone,
            Support::Cone {
                axis: canonical_axis(c.frame().z()).to_array(),
                apex: c.apex().to_array(),
                half_angle: c.half_angle(),
            },
        ),
        Surface::Sphere(s) => (
            GeomKind::Sphere,
            Support::Sphere {
                center: s.frame().origin().to_array(),
                radius: s.radius(),
            },
        ),
        Surface::Torus(t) => (
            GeomKind::Torus,
            Support::Torus {
                axis: canonical_axis(t.frame().z()).to_array(),
                center: t.frame().origin().to_array(),
                major: t.major(),
                minor: t.minor(),
            },
        ),
        Surface::BSpline(_) => (GeomKind::BSplineSurface, Support::Free),
    }
}

/// Kind and carrier of an edge curve.
pub fn edge_support(curve: &Curve3) -> (GeomKind, Support) {
    match curve {
        Curve3::Line(l) => {
            let d = canonical_axis(l.dir());
            (
                GeomKind::Line,
                Support::Line {
                    dir: d.to_array(),
                    point: closest_to_origin(l.origin(), d).to_array(),
                },
            )
        }
        Curve3::Circle(c) => (
            GeomKind::Circle,
            Support::Circle {
                normal: canonical_axis(c.frame().z()).to_array(),
                center: c.frame().origin().to_array(),
                radius: c.radius(),
            },
        ),
        Curve3::Ellipse(_) => (GeomKind::Ellipse, Support::Free),
        Curve3::BSpline(_) => (GeomKind::BSplineCurve, Support::Free),
    }
}

// ---- boxes -------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub(crate) struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

impl Aabb {
    pub fn empty() -> Self {
        let inf = f64::INFINITY;
        Self {
            min: Vec3::new(inf, inf, inf),
            max: Vec3::new(-inf, -inf, -inf),
        }
    }
    pub fn add(&mut self, p: Vec3) {
        self.min = self.min.min_components(p);
        self.max = self.max.max_components(p);
    }
    pub fn is_empty(&self) -> bool {
        self.min.x > self.max.x
    }
    pub fn center(&self) -> Vec3 {
        (self.min + self.max) * 0.5
    }
    pub fn to_arrays(self) -> ([f64; 3], [f64; 3]) {
        (self.min.to_array(), self.max.to_array())
    }
}

/// Sample points of an edge (`EDGE_SEGMENTS + 1`, start to end).
pub(crate) fn edge_samples(body: &Body, e: EdgeId) -> Vec<Point3> {
    let Some(edge) = body.edge(e) else {
        return Vec::new();
    };
    let (t0, t1) = edge.t_range;
    (0..=EDGE_SEGMENTS)
        .map(|i| {
            let t = t0 + (t1 - t0) * (i as f64 / EDGE_SEGMENTS as f64);
            edge.curve.eval(t)
        })
        .collect()
}

/// Length, centroid and box of a polyline.
fn polyline_stats(pts: &[Point3]) -> (f64, Point3, Aabb) {
    let mut len = 0.0;
    let mut acc = Vec3::zero();
    let mut bb = Aabb::empty();
    for p in pts {
        bb.add(*p);
    }
    for w in pts.windows(2) {
        let l = w[0].distance(w[1]);
        len += l;
        acc += (w[0] + w[1]) * (0.5 * l);
    }
    let c = if len > 0.0 {
        acc / len
    } else {
        pts.first().copied().unwrap_or_else(Vec3::zero)
    };
    (len, c, bb)
}

/// Area, centroid and box of each face's triangles, in face (arena) order.
fn mesh_face_stats(mesh: &BodyMesh) -> Vec<(f64, Point3, Aabb)> {
    let pos = |i: u32| Vec3::from(mesh.positions[i as usize]);
    (0..mesh.face_ranges.len())
        .map(|fi| {
            let mut area = 0.0;
            let mut acc = Vec3::zero();
            let mut bb = Aabb::empty();
            for t in mesh.face_triangles(fi) {
                let (a, b, c) = (pos(t[0]), pos(t[1]), pos(t[2]));
                let ar = 0.5 * (b - a).cross(c - a).norm();
                area += ar;
                acc += (a + b + c) * (ar / 3.0);
                bb.add(a);
                bb.add(b);
                bb.add(c);
            }
            let c = if area > 0.0 { acc / area } else { bb.center() };
            (area, c, bb)
        })
        .collect()
}

/// Box of a loop-less closed face (sphere, torus) from its carrier.
fn closed_surface_box(s: &Surface) -> Aabb {
    let mut bb = Aabb::empty();
    let (c, r) = match s {
        Surface::Sphere(sp) => (sp.frame().origin(), sp.radius()),
        Surface::Torus(t) => (t.frame().origin(), t.major() + t.minor()),
        _ => return bb,
    };
    bb.add(c - Vec3::new(r, r, r));
    bb.add(c + Vec3::new(r, r, r));
    bb
}

// ---- adjacency ---------------------------------------------------------------------------

/// Faces adjacent to `f` across an edge (deduplicated, deterministic order).
pub(crate) fn face_neighbors(body: &Body, f: FaceId) -> Vec<FaceId> {
    let mut out = Vec::new();
    for e in body.face_edges(f) {
        for g in body.edge_faces(e) {
            if g != f && !out.contains(&g) {
                out.push(g);
            }
        }
    }
    out
}

/// Edges sharing a vertex with `e` (deduplicated, deterministic order).
pub(crate) fn edge_neighbors(
    body: &Body,
    e: EdgeId,
    incident: &BTreeMap<VertexId, Vec<EdgeId>>,
) -> Vec<EdgeId> {
    let mut out = Vec::new();
    let Some(edge) = body.edge(e) else {
        return out;
    };
    for v in [edge.start, edge.end].into_iter().flatten() {
        for &e2 in incident.get(&v).map(Vec::as_slice).unwrap_or(&[]) {
            if e2 != e && !out.contains(&e2) {
                out.push(e2);
            }
        }
    }
    out
}

/// Vertex → incident edges.
pub(crate) fn incidence(body: &Body) -> BTreeMap<VertexId, Vec<EdgeId>> {
    let mut m: BTreeMap<VertexId, Vec<EdgeId>> = BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        for v in [e.start, e.end].into_iter().flatten() {
            let list = m.entry(v).or_default();
            if !list.contains(&eid) {
                list.push(eid);
            }
        }
    }
    m
}

// ---- body fingerprints ------------------------------------------------------------------

/// Fingerprints of every face and edge of a body. `family` is left at 1 (the caller,
/// which knows the names, fills it in).
pub(crate) struct BodyFingerprints {
    pub faces: BTreeMap<FaceId, Fingerprint>,
    pub edges: BTreeMap<EdgeId, Fingerprint>,
}

/// Compute the fingerprints of a body's faces and edges.
pub(crate) fn body_fingerprints(body: &Body) -> BodyFingerprints {
    // Body box (exact when forge-check can compute it, else from edge samples).
    let mut body_box = Aabb::empty();
    if let Ok((lo, hi)) = forge_check::bbox(body) {
        body_box.add(v3(lo));
        body_box.add(v3(hi));
    } else {
        for (eid, _) in body.edges().iter() {
            for p in edge_samples(body, eid) {
                body_box.add(p);
            }
        }
        for (_, f) in body.faces().iter() {
            let b = closed_surface_box(&f.surface);
            if !b.is_empty() {
                body_box.add(b.min);
                body_box.add(b.max);
            }
        }
    }
    let body_center = if body_box.is_empty() {
        Vec3::zero()
    } else {
        body_box.center()
    };
    let scale = if body_box.is_empty() {
        1.0
    } else {
        body_box.min.distance(body_box.max).max(1e-9)
    };
    let local = |c: Vec3| -> [f64; 3] {
        if body_box.is_empty() {
            return [0.5; 3];
        }
        let ext = body_box.max - body_box.min;
        let n = |x: f64, lo: f64, e: f64| if e > 1e-9 { (x - lo) / e } else { 0.5 };
        [
            n(c.x, body_box.min.x, ext.x),
            n(c.y, body_box.min.y, ext.y),
            n(c.z, body_box.min.z, ext.z),
        ]
    };

    // Edges.
    let mut edges = BTreeMap::new();
    for (eid, e) in body.edges().iter() {
        let (kind, support) = edge_support(&e.curve);
        let (len, c, bb) = polyline_stats(&edge_samples(body, eid));
        edges.insert(
            eid,
            Fingerprint {
                kind,
                support,
                size: len,
                centroid: c.to_array(),
                local: local(c),
                body_center: body_center.to_array(),
                bbox: bb.to_arrays(),
                scale,
                same_support_neighbors: 0,
                family: 1,
            },
        );
    }

    // Faces: area and centroid from a tessellation when it succeeds, else from the
    // boundary samples (area unknown = 0).
    let mesh_stats = tessellate(body, &TessParams::default())
        .ok()
        .map(|m| mesh_face_stats(&m));
    let mut faces = BTreeMap::new();
    for (k, (fid, f)) in body.faces().iter().enumerate() {
        let (kind, support) = face_support(&f.surface, f.sense);
        let (area, c, bb) = match mesh_stats.as_ref().and_then(|s| s.get(k)) {
            Some(&(a, c, bb)) if !bb.is_empty() => (a, c, bb),
            _ => {
                let mut pts = Vec::new();
                for e in body.face_edges(fid) {
                    pts.extend(edge_samples(body, e));
                }
                let (_, _, mut bb) = polyline_stats(&pts);
                if bb.is_empty() {
                    bb = closed_surface_box(&f.surface);
                }
                (0.0, bb.center(), bb)
            }
        };
        faces.insert(
            fid,
            Fingerprint {
                kind,
                support,
                size: area,
                centroid: c.to_array(),
                local: local(c),
                body_center: body_center.to_array(),
                bbox: bb.to_arrays(),
                scale,
                same_support_neighbors: 0,
                family: 1,
            },
        );
    }

    // Same-support neighbour counts.
    let face_counts: Vec<(FaceId, u32)> = faces
        .iter()
        .map(|(&fid, fp)| {
            let n = face_neighbors(body, fid)
                .into_iter()
                .filter(|g| same_support(&fp.support, &faces[g].support, scale))
                .count();
            (fid, n as u32)
        })
        .collect();
    for (fid, n) in face_counts {
        if let Some(fp) = faces.get_mut(&fid) {
            fp.same_support_neighbors = n;
        }
    }
    let inc = incidence(body);
    let edge_counts: Vec<(EdgeId, u32)> = edges
        .iter()
        .map(|(&eid, fp)| {
            let n = edge_neighbors(body, eid, &inc)
                .into_iter()
                .filter(|g| same_support(&fp.support, &edges[g].support, scale))
                .count();
            (eid, n as u32)
        })
        .collect();
    for (eid, n) in edge_counts {
        if let Some(fp) = edges.get_mut(&eid) {
            fp.same_support_neighbors = n;
        }
    }
    BodyFingerprints { faces, edges }
}

/// Faces reachable from `f` through neighbours on the same carrier (including `f`), in
/// breadth-first order from `f`.
pub(crate) fn same_support_component_faces(
    body: &Body,
    fps: &BTreeMap<FaceId, Fingerprint>,
    f: FaceId,
) -> Vec<FaceId> {
    let Some(fp) = fps.get(&f) else {
        return vec![f];
    };
    let mut seen = BTreeSet::from([f]);
    let mut order = vec![f];
    let mut i = 0;
    while i < order.len() {
        let cur = order[i];
        i += 1;
        for g in face_neighbors(body, cur) {
            if !seen.contains(&g)
                && fps
                    .get(&g)
                    .is_some_and(|gp| same_support(&fp.support, &gp.support, fp.scale))
            {
                seen.insert(g);
                order.push(g);
            }
        }
    }
    order
}

/// Edges reachable from `e` through vertex-sharing neighbours on the same carrier
/// (including `e`), in breadth-first order from `e`.
pub(crate) fn same_support_component_edges(
    body: &Body,
    fps: &BTreeMap<EdgeId, Fingerprint>,
    e: EdgeId,
) -> Vec<EdgeId> {
    let Some(fp) = fps.get(&e) else {
        return vec![e];
    };
    let inc = incidence(body);
    let mut seen = BTreeSet::from([e]);
    let mut order = vec![e];
    let mut i = 0;
    while i < order.len() {
        let cur = order[i];
        i += 1;
        for g in edge_neighbors(body, cur, &inc) {
            if !seen.contains(&g)
                && fps
                    .get(&g)
                    .is_some_and(|gp| same_support(&fp.support, &gp.support, fp.scale))
            {
                seen.insert(g);
                order.push(g);
            }
        }
    }
    order
}

// ---- comparison --------------------------------------------------------------------------

/// How a candidate's fingerprint compares with a reference's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Comparison {
    /// Same carrier (within the support tolerances).
    pub same_support: bool,
    /// The candidate's box lies inside the reference's box (padded by 1e-4 · scale).
    pub contained: bool,
    /// `min(size) / max(size)` (1 when both are unknown).
    pub size_ratio: f64,
    /// Centroid distance relative to the scale: the smaller of the world distance / scale
    /// and the body-local distance plus the body's own displacement / scale.
    pub position: f64,
    /// Geometry indistinguishable from the reference: same carrier, same box and size.
    pub identical: bool,
    /// Soft similarity in `[0, 1]` (see [`compare`]).
    pub score: f64,
}

/// Compare a candidate fingerprint with a reference fingerprint of the same entity kind.
///
/// `score = s_support · s_size · s_position` where
/// - `s_support = 1` for the same carrier, else `exp(−(Δangle/0.05)² − (Δoffset/(0.02·s))²)`
///   (0 for different carrier types);
/// - `s_size = size_ratio`;
/// - `s_position = exp(−(position/0.05)²)`.
///
/// Different [`GeomKind`]s score 0.
pub fn compare(reference: &Fingerprint, cand: &Fingerprint) -> Comparison {
    let scale = reference.scale.max(cand.scale).max(1.0);
    let same = same_support(&reference.support, &cand.support, scale);
    let pad = 1e-4 * scale + 1e-6;
    let (rmin, rmax) = reference.bbox;
    let (cmin, cmax) = cand.bbox;
    let contained = (0..3).all(|i| cmin[i] >= rmin[i] - pad && cmax[i] <= rmax[i] + pad);
    let box_equal =
        (0..3).all(|i| (cmin[i] - rmin[i]).abs() <= pad && (cmax[i] - rmax[i]).abs() <= pad);
    let size_ratio = match (reference.size > 0.0, cand.size > 0.0) {
        (true, true) => reference.size.min(cand.size) / reference.size.max(cand.size),
        (false, false) => 1.0,
        _ => 0.0,
    };
    let world = v3(reference.centroid).distance(v3(cand.centroid)) / scale;
    // Body-local position, plus how far the body itself moved: robust to a body being
    // moved or resized as a whole, yet able to tell identical bodies apart.
    let body_shift = v3(reference.body_center).distance(v3(cand.body_center)) / scale;
    let local = v3(reference.local).distance(v3(cand.local)) + body_shift;
    let position = world.min(local);
    let identical = same
        && box_equal
        && size_ratio >= 0.999
        && v3(reference.centroid).distance(v3(cand.centroid)) <= pad;
    let s_support = if same {
        1.0
    } else {
        match support_gap(&reference.support, &cand.support) {
            Some((a, o)) => math::exp(-sq(a / 0.05) - sq(o / (0.02 * scale))),
            None if matches!(reference.support, Support::Free)
                && matches!(cand.support, Support::Free) =>
            {
                1.0
            }
            None => 0.0,
        }
    };
    let s_pos = math::exp(-sq(position / 0.05));
    let score = if reference.kind == cand.kind {
        s_support * size_ratio * s_pos
    } else {
        0.0
    };
    Comparison {
        same_support: same,
        contained,
        size_ratio,
        position,
        identical,
        score,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_axis_is_sign_independent() {
        let a = canonical_axis(Vec3::new(0.0, -1.0, 0.0));
        let b = canonical_axis(Vec3::new(0.0, 1.0, 0.0));
        assert_eq!(a, b);
        assert_eq!(a, Vec3::new(0.0, 1.0, 0.0));
        let c = canonical_axis(Vec3::new(-0.6, 0.8, 0.0));
        assert_eq!(c, Vec3::new(0.6, -0.8, 0.0));
    }

    #[test]
    fn planes_with_opposite_outward_normals_are_different_supports() {
        let a = Support::Plane {
            normal: [0.0, 0.0, 1.0],
            offset: 2.0,
        };
        let b = Support::Plane {
            normal: [0.0, 0.0, -1.0],
            offset: -2.0,
        };
        assert!(!same_support(&a, &b, 10.0));
        assert!(same_support(&a, &a, 10.0));
    }

    #[test]
    fn different_support_types_never_match() {
        let a = Support::Line {
            dir: [1.0, 0.0, 0.0],
            point: [0.0; 3],
        };
        let b = Support::Circle {
            normal: [0.0, 0.0, 1.0],
            center: [0.0; 3],
            radius: 1.0,
        };
        assert!(support_gap(&a, &b).is_none());
        assert!(!same_support(&a, &b, 1.0));
    }

    #[test]
    fn tiny_angles_are_measured_accurately() {
        let a = Vec3::new(1.0, 0.0, 0.0);
        let b = Vec3::new(1.0, 1e-9, 0.0);
        let ang = angle(a, b);
        assert!((ang - 1e-9).abs() < 1e-15, "{ang}");
    }
}
