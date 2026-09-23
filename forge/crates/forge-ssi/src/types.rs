//! Public input and result types.

use forge_core::geom::{Curve2, Curve3, Surface};
use forge_core::math;
use forge_core::{Point2, Point3};

use crate::error::{Operand, SsiError};

/// A closed parameter box `[u0, u1] × [v0, v1]` on a surface: the face's parameter
/// bounding box. Trimming by the face's loops is the caller's job (the boolean), not
/// SSI's.
///
/// For a periodic parameter the range may start anywhere but must not be wider than the
/// period (`u1 − u0 <= 2π`); a range of exactly one period means "all the way round", so
/// its two ends are the same curve on the surface and are not a boundary.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UvBox {
    /// `u` range.
    pub u: (f64, f64),
    /// `v` range.
    pub v: (f64, f64),
}

/// Relative slack for "exactly one period" (`u1 − u0 >= 2π·(1 − PERIOD_SLACK)` counts as a
/// full period).
pub(crate) const PERIOD_SLACK: f64 = 1e-12;

impl UvBox {
    /// `[u0, u1] × [v0, v1]`.
    pub fn new(u0: f64, u1: f64, v0: f64, v1: f64) -> Self {
        Self {
            u: (u0, u1),
            v: (v0, v1),
        }
    }
    /// The surface's natural domain with infinite directions clamped to
    /// `[−bound, bound]` (planes, cylinder and cone heights).
    pub fn natural(surface: &Surface, bound: f64) -> Self {
        let ((u0, u1), (v0, v1)) = surface.domain();
        let c = |a: f64, b: f64| {
            (
                if a.is_finite() { a } else { -bound },
                if b.is_finite() { b } else { bound },
            )
        };
        Self {
            u: c(u0, u1),
            v: c(v0, v1),
        }
    }
    /// `true` if `(u, v)` lies in the box, with periodic parameters compared modulo their
    /// period and each bound relaxed by `slack` (parameter units).
    pub fn contains(&self, surface: &Surface, uv: Point2, slack: [f64; 2]) -> bool {
        let (pu, pv) = surface.periodicity();
        in_range(self.u, pu, uv.x, slack[0]) && in_range(self.v, pv, uv.y, slack[1])
    }
    /// `true` if the `u` range covers a whole period of a periodic `u`.
    pub fn full_u(&self, surface: &Surface) -> bool {
        surface
            .periodicity()
            .0
            .is_some_and(|p| self.u.1 - self.u.0 >= p * (1.0 - PERIOD_SLACK))
    }
    /// `true` if the `v` range covers a whole period of a periodic `v`.
    pub fn full_v(&self, surface: &Surface) -> bool {
        surface
            .periodicity()
            .1
            .is_some_and(|p| self.v.1 - self.v.0 >= p * (1.0 - PERIOD_SLACK))
    }

    pub(crate) fn validate(&self, surface: &Surface, operand: Operand) -> Result<(), SsiError> {
        let (pu, pv) = surface.periodicity();
        let ((nu0, nu1), (nv0, nv1)) = surface.domain();
        check_range(operand, "u", self.u, pu, (nu0, nu1))?;
        check_range(operand, "v", self.v, pv, (nv0, nv1))
    }
}

fn check_range(
    operand: Operand,
    param: &'static str,
    (lo, hi): (f64, f64),
    period: Option<f64>,
    natural: (f64, f64),
) -> Result<(), SsiError> {
    let err = |reason| SsiError::InvalidDomain {
        operand,
        param,
        lo,
        hi,
        reason,
    };
    if !(lo.is_finite() && hi.is_finite()) {
        return Err(err("bounds must be finite"));
    }
    if hi <= lo {
        return Err(err("empty or inverted range"));
    }
    match period {
        Some(p) => {
            if hi - lo > p * (1.0 + PERIOD_SLACK) {
                return Err(err("wider than the period"));
            }
        }
        None => {
            // Non-periodic parameters with a finite natural range (sphere latitude,
            // spindle patch) must stay inside it.
            let eps = 1e-12 * (1.0 + natural.0.abs().max(natural.1.abs()));
            if (natural.0.is_finite() && lo < natural.0 - eps)
                || (natural.1.is_finite() && hi > natural.1 + eps)
            {
                return Err(err("outside the surface's parameter range"));
            }
        }
    }
    Ok(())
}

/// `x` in `[lo − slack, hi + slack]`, periodic parameters compared modulo the period.
pub(crate) fn in_range(r: (f64, f64), period: Option<f64>, x: f64, slack: f64) -> bool {
    match period {
        Some(p) => {
            if r.1 - r.0 >= p * (1.0 - PERIOD_SLACK) {
                return true;
            }
            let w = math::wrap_angle(x - r.0 + slack, 0.0);
            w <= (r.1 - r.0) + 2.0 * slack || w >= p - 1e-15
        }
        None => x >= r.0 - slack && x <= r.1 + slack,
    }
}

/// How two surfaces (or a curve and a surface) meet along a branch or at a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Contact {
    /// The normals are not parallel: a crossing.
    Transversal,
    /// The surfaces touch: normals parallel (within the fit tolerance's geometric
    /// consequence) and the separation `gap` (mm, `<= fit`) at the contact.
    Tangent {
        /// Separation of the two surfaces at the contact (mm).
        gap: f64,
    },
}

impl Contact {
    /// `true` for [`Contact::Tangent`].
    pub fn is_tangent(&self) -> bool {
        matches!(self, Contact::Tangent { .. })
    }
}

/// Interval-arithmetic certificate of a curve–surface root.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RootCertificate {
    /// Enclosure `[lo, hi]` of the curve parameter of the root.
    pub t_enclosure: (f64, f64),
    /// Enclosure of the distance form of the surface over `t_enclosure` (mm); contains 0.
    pub residual: (f64, f64),
    /// `true` if interval Newton proved that `t_enclosure` contains exactly one root
    /// (simple root). `false` for tangential (multiple) roots, whose enclosure is the
    /// cluster in which `|distance| <= fit`.
    pub unique: bool,
    /// Upper bound of the distance between `point` and the surface (mm).
    pub distance_bound: f64,
}

/// One intersection point of a curve with a surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CurveSurfaceHit {
    /// Curve parameter.
    pub t: f64,
    /// Surface parameters (periodic parameters inside the query domain's range).
    pub uv: Point2,
    /// The 3D point `C(t)`.
    pub point: Point3,
    /// Crossing or tangency.
    pub contact: Contact,
    /// Multiplicity of the root of the distance form (1 simple, 2 tangent, 3 tangent
    /// crossing / inflection, …); an estimate for multiplicities above 1.
    pub multiplicity: u8,
    /// Interval certificate.
    pub certificate: RootCertificate,
}

/// A parameter range over which the curve lies in the surface (within `fit`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CurveSurfaceOverlap {
    /// Curve parameter range.
    pub t_range: (f64, f64),
    /// Surface parameters at the start.
    pub uv_start: Point2,
    /// Surface parameters at the end.
    pub uv_end: Point2,
    /// Certified bound of the curve's distance to the surface over the range (mm).
    pub distance_bound: f64,
}

/// Result of [`intersect_curve_surface`](crate::intersect_curve_surface): isolated
/// intersection points and overlap ranges, sorted by curve parameter.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CurveSurfaceHits {
    /// Isolated intersection points.
    pub points: Vec<CurveSurfaceHit>,
    /// Ranges where the curve lies in the surface.
    pub overlaps: Vec<CurveSurfaceOverlap>,
    /// `true` if the complement of the returned roots was certified root-free by
    /// interval arithmetic (always `true` unless an error is returned).
    pub certified_complete: bool,
}

/// How a branch is represented.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Representation {
    /// Closed form: a line, circle, ellipse or exact rational conic arc.
    Exact,
    /// Certified cubic B-spline approximation of a marched branch.
    Fitted,
}

/// The kind of a graph vertex.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum VertexKind {
    /// A branch leaves the parameter box of `a` and/or `b` here.
    DomainBoundary,
    /// An isolated tangential contact point (no branch passes through it).
    TangentPoint,
    /// Several branch ends meet: a crossing of intersection branches (e.g. the two
    /// tangency points where Villarceau circles cross) or a tangential branching point.
    Singular,
    /// A singular point of one surface's parametrization or geometry (cone apex, sphere
    /// pole, torus axis point) that lies on the intersection; branches are split there
    /// because pcurves are discontinuous through it.
    SurfaceSingularity,
}

/// A point of the intersection graph: branch end, branch crossing or isolated contact.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vertex {
    /// 3D point.
    pub point: Point3,
    /// Parameters on `a`.
    pub uv_a: Point2,
    /// Parameters on `b`.
    pub uv_b: Point2,
    /// Kind.
    pub kind: VertexKind,
    /// `true` if the point is on the boundary of `a`'s parameter box.
    pub on_boundary_a: bool,
    /// `true` if the point is on the boundary of `b`'s parameter box.
    pub on_boundary_b: bool,
    /// Contact of the surfaces at the vertex.
    pub contact: Contact,
}

/// One branch of the intersection: a 3D curve over a parameter range with a pcurve on
/// each surface sharing its parameter.
#[derive(Clone, Debug, PartialEq)]
pub struct Branch {
    /// The 3D curve.
    pub curve: Curve3,
    /// Parameter range `[t0, t1]` of the branch on `curve` (`t1 − t0 = 2π` for a full
    /// circle or ellipse).
    pub range: (f64, f64),
    /// Pcurve on `a`: `a.eval(pcurve_a(t)) ≈ curve(t)` within `fit`.
    pub pcurve_a: Curve2,
    /// Pcurve on `b`.
    pub pcurve_b: Curve2,
    /// Closed branch (no end vertices).
    pub closed: bool,
    /// Transversal or tangent (surfaces tangent along the whole branch).
    pub contact: Contact,
    /// Orientation of a transversal branch relative to the surface normals:
    /// `Some(true)` if `C'(t)` points along `n_a × n_b`, `Some(false)` if against it;
    /// `None` for tangent branches (where `n_a × n_b = 0`). Exact curves keep their
    /// natural parametrization (e.g. circles counter-clockwise in a plane operand, so the
    /// plane pcurve is an exact `Ellipse2`); the boolean reads the side from this flag.
    pub sense: Option<bool>,
    /// Exact or fitted.
    pub representation: Representation,
    /// Start vertex (index into [`IntersectionGraph::vertices`]); `None` if closed.
    pub start: Option<usize>,
    /// End vertex; `None` if closed.
    pub end: Option<usize>,
    /// Certified upper bound (mm) of the distance of any curve point to either surface
    /// and of `|S(pcurve(t)) − C(t)|` for both pcurves.
    pub error_bound: f64,
    /// Smallest angle (radians) between the surface normals along the branch (sampled);
    /// small values warn the boolean about near-tangential crossings.
    pub min_angle: f64,
}

/// An affine map `(u_b, v_b) = M·(u_a, v_a) + c` between the parameter spaces of two
/// coincident surfaces (periodic parameters modulo their period).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct UvAffine {
    /// Row-major 2×2 matrix `M`.
    pub m: [[f64; 2]; 2],
    /// Offset `c`.
    pub c: [f64; 2],
}

impl UvAffine {
    /// Apply the map.
    pub fn apply(&self, uv: Point2) -> Point2 {
        Point2::new(
            self.m[0][0] * uv.x + self.m[0][1] * uv.y + self.c[0],
            self.m[1][0] * uv.x + self.m[1][1] * uv.y + self.c[1],
        )
    }
}

/// The two surfaces are the same geometric surface (within `fit`) on the overlap of
/// their parameter boxes. The overlap region is two-dimensional; splitting faces along
/// it is the boolean's job.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Coincidence {
    /// `true` if the surface normals agree.
    pub same_orientation: bool,
    /// Parameter map from `a` to `b` when it is affine (planes, coaxial cylinders, cones
    /// and tori); `None` otherwise (e.g. two spheres with different frames).
    pub uv_map: Option<UvAffine>,
}

/// How a result was obtained.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Method {
    /// The parameter boxes' bounding boxes are disjoint.
    Disjoint,
    /// Two planes (line, parallel or coincident).
    PlanePlane,
    /// Surfaces extruded along a common direction (planes parallel to a cylinder axis,
    /// cylinders with parallel axes): lines from a 2D cross-section.
    CommonExtrusion,
    /// Surfaces of revolution about a common axis (including planes perpendicular to it,
    /// spheres centred on it, plane–sphere and sphere–sphere): circles from the meridian.
    CommonAxis,
    /// Plane section of a cylinder (ellipse).
    PlaneCylinder,
    /// Plane section of a cone (conics, line pairs, apex point).
    PlaneCone,
    /// Plane containing a torus axis (meridian circles).
    PlaneTorusMeridian,
    /// Bitangent plane of a ring torus through its centre (two Villarceau circles).
    PlaneTorusVillarceau,
    /// Two cylinders of equal radius with intersecting axes (two ellipses).
    EqualCylinders,
    /// Certified subdivision + marching + fitting.
    Marching,
}

impl Method {
    /// `true` for closed-form methods.
    pub fn is_closed_form(&self) -> bool {
        !matches!(self, Method::Marching | Method::Disjoint)
    }
}

/// Work counters (for diagnostics and performance reports).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SsiStats {
    /// Subdivision cells examined.
    pub cells: usize,
    /// Regular leaf cells.
    pub regular_cells: usize,
    /// Irregular (contact-cluster) leaf cells.
    pub irregular_cells: usize,
    /// Cell-boundary crossings found.
    pub crossings: usize,
    /// Marching steps.
    pub steps: usize,
    /// Fitted B-spline spans.
    pub spans: usize,
}

/// Result of [`intersect_surfaces`](crate::intersect_surfaces).
///
/// # Ordering (deterministic)
/// Branches are sorted by their start point `curve(range.0)` (lexicographic `x, y, z`,
/// then end point), vertices by first use in that order, then isolated vertices
/// lexicographically. Marched branches are oriented along `n_a × n_b`; exact branches
/// keep their natural parametrization. [`Branch::sense`] tells the boolean which way
/// every transversal branch runs.
#[derive(Clone, Debug, PartialEq)]
pub struct IntersectionGraph {
    /// Branches (curves with pcurves).
    pub branches: Vec<Branch>,
    /// Vertices: branch ends, crossings, isolated contact points.
    pub vertices: Vec<Vertex>,
    /// `Some` if the surfaces coincide (then `branches` and `vertices` are empty).
    pub coincidence: Option<Coincidence>,
    /// Method used.
    pub method: Method,
    /// `true` if the result is proven complete: closed forms (algebraic completeness)
    /// or marching whose every subdivision cell was certified empty, certified regular
    /// and traced, or resolved as a contact point.
    pub certified_complete: bool,
    /// Work counters.
    pub stats: SsiStats,
}

impl IntersectionGraph {
    pub(crate) fn empty(method: Method) -> Self {
        Self {
            branches: Vec::new(),
            vertices: Vec::new(),
            coincidence: None,
            method,
            certified_complete: true,
            stats: SsiStats::default(),
        }
    }
    /// Vertices of kind [`VertexKind::TangentPoint`].
    pub fn tangent_points(&self) -> impl Iterator<Item = &Vertex> {
        self.vertices
            .iter()
            .filter(|v| v.kind == VertexKind::TangentPoint)
    }
    /// `true` if there is no intersection at all.
    pub fn is_empty(&self) -> bool {
        self.branches.is_empty() && self.vertices.is_empty() && self.coincidence.is_none()
    }
}
