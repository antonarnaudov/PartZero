//! Validation and compilation of a [`Sketch`] into scalar quantities and equations.
//!
//! - **Quantities** are the scalar parameters of the sketch in entity order: `x, y` for
//!   every point and `radius` for every circle. A quantity is an *unknown* unless the
//!   entity (or an entity that references it) is `fixed`.
//! - **Equations** `f(q) = 0` come from the built-in arc rules (first, in entity order)
//!   and then from the driving constraints (in constraint order). Every residual has the
//!   unit of a length (mm), so rows are commensurable: angular conditions (sin, cos or
//!   angle error of the line directions) are multiplied by a *constant* length `s` taken
//!   from the input geometry (the geometric mean of the two line lengths). The scale is
//!   deliberately not a function of the unknowns: a residual scaled by the current
//!   lengths would be "satisfied" by collapsing the lines to zero length.
//! - Residuals are written once, generically over [`Scalar`]: `f64` for values and
//!   [`Dual`] for exact forward-mode Jacobians.

use std::collections::BTreeMap;
use std::ops::Range;

use forge_core::math;
use forge_core::{Scalar, Vec2};

use crate::error::SketchError;
use crate::model::{ConstraintKind, Geometry, Sketch};

/// Index of a scalar quantity.
pub(crate) type Q = u32;

/// `ε²` inside every Euclidean norm (`sqrt(v·v + ε²)`, ε = 1e-9 mm): keeps residuals and
/// derivatives finite for momentarily zero-length vectors; its effect on non-degenerate
/// geometry (relative `ε²/2|v|²`) is far below double precision.
const NORM_EPS2: f64 = 1e-18;

/// The quantities of a point.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct P {
    pub x: Q,
    pub y: Q,
}

/// Where a radius comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Rad {
    /// A circle's radius parameter.
    Param(Q),
    /// An arc: `|start − center|`.
    Arc { s: P },
}

/// A circle or an arc as used by curve constraints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Curve {
    pub c: P,
    pub r: Rad,
}

/// A line segment `a → b`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Seg {
    pub a: P,
    pub b: P,
}

/// One scalar equation `f(q) = 0`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum EqKind {
    /// `q[a] − q[b]` (coincident components, horizontal, vertical).
    Diff { a: Q, b: Q },
    /// `q[a] − v` (fix).
    Target { a: Q, v: f64 },
    /// `|b − a| − v`.
    PPDist { a: P, b: P, v: f64 },
    /// `|cross(d, p − l.a)| / |d| − v`.
    PLDist { p: P, l: Seg, v: f64 },
    /// `cross(d, p − l.a) / |d|` (signed distance to the infinite line).
    PointOnLine { p: P, l: Seg },
    /// `s · cross(d1, d2) / (|d1||d2|)` (= s·sin φ).
    Parallel { l1: Seg, l2: Seg, s: f64 },
    /// `s · dot(d1, d2) / (|d1||d2|)` (= s·cos φ).
    Perpendicular { l1: Seg, l2: Seg, s: f64 },
    /// `s · wrap(atan2(cross, dot) − θ)`, θ in radians.
    Angle {
        l1: Seg,
        l2: Seg,
        theta: f64,
        s: f64,
    },
    /// `|d1| − |d2|`.
    EqualLength { l1: Seg, l2: Seg },
    /// `r1 − r2`.
    EqualRadius { c1: Curve, c2: Curve },
    /// `r − v`.
    Radius { c: Curve, v: f64 },
    /// `|p − c| − r`.
    PointOnCurve { p: P, c: Curve },
    /// `|cross(d, c − l.a)| / |d| − r` (tangency anywhere along the line).
    TangentLine { l: Seg, c: Curve },
    /// Tangency at a joint `p` shared by the line and the arc: the radius `p − c` is
    /// perpendicular to the line, `s · dot(d, p − c) / (|d||p − c|)`.
    TangentLineAt { l: Seg, p: P, c: P, s: f64 },
    /// Tangency of two arcs at a shared endpoint `p`: the radii are collinear,
    /// `s · cross(p − c1, p − c2) / (|p − c1||p − c2|)`.
    TangentCurvesAt { p: P, c1: P, c2: P, s: f64 },
    /// `|c2 − c1| − (r1 + r2)` or `|c2 − c1| − |r1 − r2|`.
    TangentCurves {
        c1: Curve,
        c2: Curve,
        internal: bool,
    },
    /// `q[p] − (q[a] + q[b]) / 2`.
    MidCoord { p: Q, a: Q, b: Q },
    /// Midpoint of `a, b` on the line: `cross(d, (a+b)/2 − l.a) / |d|`.
    SymMid { a: P, b: P, l: Seg },
    /// `b − a` perpendicular to the line: `dot(d, b − a) / |d|`.
    SymPerp { a: P, b: P, l: Seg },
    /// Built-in arc rule `|e − c| − |s − c|`.
    ArcRule { c: P, s: P, e: P },
}

#[inline]
fn k<S: Scalar>(v: f64) -> S {
    S::from_f64(v)
}
#[inline]
fn pt<S: Scalar, G: Fn(Q) -> S>(g: &G, p: P) -> Vec2<S> {
    Vec2::new(g(p.x), g(p.y))
}
#[inline]
fn snorm<S: Scalar>(v: Vec2<S>) -> S {
    (v.dot(v) + k(NORM_EPS2)).sqrt()
}
#[inline]
fn dir<S: Scalar, G: Fn(Q) -> S>(g: &G, l: Seg) -> Vec2<S> {
    pt(g, l.b) - pt(g, l.a)
}
#[inline]
fn radius<S: Scalar, G: Fn(Q) -> S>(g: &G, c: Curve) -> S {
    match c.r {
        Rad::Param(q) => g(q),
        Rad::Arc { s } => snorm(pt(g, s) - pt(g, c.c)),
    }
}

impl EqKind {
    /// Evaluate the residual with quantity accessor `g`.
    pub(crate) fn eval<S: Scalar, G: Fn(Q) -> S>(&self, g: &G) -> S {
        match *self {
            EqKind::Diff { a, b } => g(a) - g(b),
            EqKind::Target { a, v } => g(a) - k(v),
            EqKind::PPDist { a, b, v } => snorm(pt(g, b) - pt(g, a)) - k(v),
            EqKind::PLDist { p, l, v } => {
                let d = dir(g, l);
                d.perp_dot(pt(g, p) - pt(g, l.a)).abs() / snorm(d) - k(v)
            }
            EqKind::PointOnLine { p, l } => {
                let d = dir(g, l);
                d.perp_dot(pt(g, p) - pt(g, l.a)) / snorm(d)
            }
            EqKind::Parallel { l1, l2, s } => {
                let (u, v) = (dir(g, l1), dir(g, l2));
                u.perp_dot(v) / (snorm(u) * snorm(v)) * k(s)
            }
            EqKind::Perpendicular { l1, l2, s } => {
                let (u, v) = (dir(g, l1), dir(g, l2));
                u.dot(v) / (snorm(u) * snorm(v)) * k(s)
            }
            EqKind::Angle { l1, l2, theta, s } => {
                let (u, v) = (dir(g, l1), dir(g, l2));
                let phi = u.perp_dot(v).atan2(u.dot(v));
                let mut e = phi - k(theta);
                // Branch cut opposite the target: wrap into (−π, π].
                if e > S::pi() {
                    e -= S::tau();
                } else if e <= -S::pi() {
                    e += S::tau();
                }
                e * k(s)
            }
            EqKind::EqualLength { l1, l2 } => snorm(dir(g, l1)) - snorm(dir(g, l2)),
            EqKind::EqualRadius { c1, c2 } => radius(g, c1) - radius(g, c2),
            EqKind::Radius { c, v } => radius(g, c) - k(v),
            EqKind::PointOnCurve { p, c } => snorm(pt(g, p) - pt(g, c.c)) - radius(g, c),
            EqKind::TangentLine { l, c } => {
                let d = dir(g, l);
                d.perp_dot(pt(g, c.c) - pt(g, l.a)).abs() / snorm(d) - radius(g, c)
            }
            EqKind::TangentLineAt { l, p, c, s } => {
                let d = dir(g, l);
                let r = pt(g, p) - pt(g, c);
                d.dot(r) / (snorm(d) * snorm(r)) * k(s)
            }
            EqKind::TangentCurvesAt { p, c1, c2, s } => {
                let pp = pt(g, p);
                let (u, v) = (pp - pt(g, c1), pp - pt(g, c2));
                u.perp_dot(v) / (snorm(u) * snorm(v)) * k(s)
            }
            EqKind::TangentCurves { c1, c2, internal } => {
                let dist = snorm(pt(g, c2.c) - pt(g, c1.c));
                let (r1, r2) = (radius(g, c1), radius(g, c2));
                if internal {
                    dist - (r1 - r2).abs()
                } else {
                    dist - (r1 + r2)
                }
            }
            EqKind::MidCoord { p, a, b } => g(p) - (g(a) + g(b)) * k(0.5),
            EqKind::SymMid { a, b, l } => {
                let d = dir(g, l);
                let m = (pt(g, a) + pt(g, b)) * k(0.5);
                d.perp_dot(m - pt(g, l.a)) / snorm(d)
            }
            EqKind::SymPerp { a, b, l } => {
                let d = dir(g, l);
                d.dot(pt(g, b) - pt(g, a)) / snorm(d)
            }
            EqKind::ArcRule { c, s, e } => {
                let cc = pt(g, c);
                snorm(pt(g, e) - cc) - snorm(pt(g, s) - cc)
            }
        }
    }

    /// Every quantity the residual depends on (sorted, unique).
    pub(crate) fn vars(&self) -> Vec<Q> {
        let mut v: Vec<Q> = Vec::with_capacity(8);
        let p = |v: &mut Vec<Q>, p: P| {
            v.push(p.x);
            v.push(p.y);
        };
        let s = |v: &mut Vec<Q>, l: Seg| {
            p(v, l.a);
            p(v, l.b);
        };
        let c = |v: &mut Vec<Q>, c: Curve| {
            p(v, c.c);
            match c.r {
                Rad::Param(q) => v.push(q),
                Rad::Arc { s } => p(v, s),
            }
        };
        match *self {
            EqKind::Diff { a, b } => v.extend([a, b]),
            EqKind::Target { a, .. } => v.push(a),
            EqKind::PPDist { a, b, .. } => {
                p(&mut v, a);
                p(&mut v, b);
            }
            EqKind::PLDist { p: q, l, .. } | EqKind::PointOnLine { p: q, l } => {
                p(&mut v, q);
                s(&mut v, l);
            }
            EqKind::Parallel { l1, l2, .. }
            | EqKind::Perpendicular { l1, l2, .. }
            | EqKind::Angle { l1, l2, .. }
            | EqKind::EqualLength { l1, l2 } => {
                s(&mut v, l1);
                s(&mut v, l2);
            }
            EqKind::EqualRadius { c1, c2 } | EqKind::TangentCurves { c1, c2, .. } => {
                c(&mut v, c1);
                c(&mut v, c2);
            }
            EqKind::Radius { c: cc, .. } => c(&mut v, cc),
            EqKind::PointOnCurve { p: q, c: cc } => {
                p(&mut v, q);
                c(&mut v, cc);
            }
            EqKind::TangentLine { l, c: cc } => {
                s(&mut v, l);
                c(&mut v, cc);
            }
            EqKind::TangentLineAt { l, p: q, c: cc, .. } => {
                s(&mut v, l);
                p(&mut v, q);
                p(&mut v, cc);
            }
            EqKind::TangentCurvesAt { p: q, c1, c2, .. } => {
                p(&mut v, q);
                p(&mut v, c1);
                p(&mut v, c2);
            }
            EqKind::MidCoord { p: q, a, b } => v.extend([q, a, b]),
            EqKind::SymMid { a, b, l } | EqKind::SymPerp { a, b, l } => {
                p(&mut v, a);
                p(&mut v, b);
                s(&mut v, l);
            }
            EqKind::ArcRule { c: cc, s: ss, e } => {
                p(&mut v, cc);
                p(&mut v, ss);
                p(&mut v, e);
            }
        }
        v.sort_unstable();
        v.dedup();
        v
    }
}

/// Who produced an equation.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Owner {
    /// The built-in rule of the arc with this entity index.
    ArcRule(usize),
    /// The constraint with this index.
    Constraint(usize),
}

/// A compiled equation.
#[derive(Clone, Debug)]
pub(crate) struct Equation {
    pub kind: EqKind,
    pub owner: Owner,
    /// Sorted unique quantities the residual depends on.
    pub vars: Vec<Q>,
}

/// How to measure a dimension on the current geometry.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Measure {
    PPDist {
        a: P,
        b: P,
    },
    PLDist {
        p: P,
        l: Seg,
    },
    /// Degrees, counter-clockwise from `l1` to `l2`, in (−180, 180].
    Angle {
        l1: Seg,
        l2: Seg,
    },
    Radius {
        c: Curve,
    },
    Diameter {
        c: Curve,
    },
}

impl Measure {
    pub(crate) fn eval(&self, q: &[f64]) -> f64 {
        let g = |i: Q| q[i as usize];
        match *self {
            Measure::PPDist { a, b } => (pt(&g, b) - pt(&g, a)).norm(),
            Measure::PLDist { p, l } => {
                let d = dir(&g, l);
                d.perp_dot(pt(&g, p) - pt(&g, l.a)).abs() / d.norm()
            }
            Measure::Angle { l1, l2 } => {
                let (u, v) = (dir(&g, l1), dir(&g, l2));
                math::rad_to_deg(math::atan2(u.perp_dot(v), u.dot(v)))
            }
            Measure::Radius { c } => radius(&g, c),
            Measure::Diameter { c } => 2.0 * radius(&g, c),
        }
    }
}

/// Per-entity compiled information.
#[derive(Clone, Debug)]
pub(crate) struct EntityInfo {
    /// The point's quantities (points only).
    pub point: Option<P>,
    /// The radius quantity (circles only).
    pub radius: Option<Q>,
    /// All quantities the entity's shape depends on (its DOF block), sorted.
    pub block: Vec<Q>,
}

/// A validated, compiled sketch.
#[derive(Clone, Debug)]
pub(crate) struct System {
    /// Input values of all quantities.
    pub values0: Vec<f64>,
    /// Whether each quantity is an unknown.
    pub unknown: Vec<bool>,
    /// All equations: arc rules first, then driving constraints in order.
    pub equations: Vec<Equation>,
    /// Per constraint: its equation range (empty for reference dimensions).
    pub constraint_eqs: Vec<Range<usize>>,
    /// Per constraint: how to measure it (dimensions only).
    pub measures: Vec<Option<Measure>>,
    /// Per entity.
    pub entities: Vec<EntityInfo>,
    /// Entity id → index.
    pub entity_index: BTreeMap<String, usize>,
}

impl System {
    pub(crate) fn nq(&self) -> usize {
        self.values0.len()
    }

    /// Evaluate equation `e` at `q` in `f64`.
    pub(crate) fn residual(&self, e: usize, q: &[f64]) -> f64 {
        self.equations[e].kind.eval(&|i: Q| q[i as usize])
    }

    /// Evaluate equation `e` and its partial derivative with respect to each quantity in
    /// `vars` by forward-mode AD (one [`Dual`] pass per unknown quantity). `out` receives
    /// `(quantity, ∂f/∂q)` for the unknown quantities; the return value is `f`.
    #[cfg(test)]
    pub(crate) fn residual_and_gradient(
        &self,
        e: usize,
        q: &[f64],
        out: &mut Vec<(Q, f64)>,
    ) -> f64 {
        out.clear();
        let eq = &self.equations[e];
        let mut value = None;
        for &seed in &eq.vars {
            if !self.unknown[seed as usize] {
                continue;
            }
            let r: forge_core::Dual = eq.kind.eval(&|i: Q| {
                if i == seed {
                    forge_core::Dual::variable(q[i as usize])
                } else {
                    forge_core::Dual::constant(q[i as usize])
                }
            });
            value.get_or_insert(r.v);
            out.push((seed, r.d));
        }
        value.unwrap_or_else(|| self.residual(e, q))
    }
}

// ----- compilation ---------------------------------------------------------------------

struct Ctx<'a> {
    sketch: &'a Sketch,
    index: BTreeMap<String, usize>,
    /// First quantity of each entity (points: x, y; circles: r).
    q_start: Vec<Option<Q>>,
    /// Union–find over points (by x quantity) joined by driving coincident constraints:
    /// two point references denote the same location when their roots agree.
    joint_root: Vec<Q>,
}

#[derive(Clone, Copy)]
enum Ent {
    Point(P),
    Line(Seg),
    Circle(Curve),
    /// The arc's curve and its end point (the start is in the curve's radius source).
    Arc(Curve, P),
}

impl Ent {
    fn type_name(&self) -> &'static str {
        match self {
            Ent::Point(_) => "point",
            Ent::Line(_) => "line",
            Ent::Circle(_) => "circle",
            Ent::Arc(..) => "arc",
        }
    }
}

impl<'a> Ctx<'a> {
    fn lookup(&self, owner: &str, id: &str) -> Result<usize, SketchError> {
        self.index
            .get(id)
            .copied()
            .ok_or_else(|| SketchError::UnknownReference {
                owner: owner.to_owned(),
                reference: id.to_owned(),
            })
    }

    /// Resolve an entity reference to its compiled form. Only called after every entity
    /// has been validated, so the nested point references of lines, circles and arcs are
    /// known to exist and to be points.
    fn ent(&self, owner: &str, id: &str) -> Result<Ent, SketchError> {
        let i = self.lookup(owner, id)?;
        let pq = |pid: &String| self.point_q(self.index[pid.as_str()]);
        Ok(match &self.sketch.entities[i].geometry {
            Geometry::Point { .. } => Ent::Point(self.point_q(i)),
            Geometry::Line { p1, p2 } => Ent::Line(Seg {
                a: pq(p1),
                b: pq(p2),
            }),
            Geometry::Circle { center, .. } => Ent::Circle(Curve {
                c: pq(center),
                r: Rad::Param(self.q_start[i].expect("circle has a radius quantity")),
            }),
            Geometry::Arc { center, start, end } => Ent::Arc(
                Curve {
                    c: pq(center),
                    r: Rad::Arc { s: pq(start) },
                },
                pq(end),
            ),
        })
    }

    /// The first point of `a` that is the same location as a point of `b` (identical
    /// reference or joined by coincident constraints), tried in argument order.
    fn joint(&self, a: &[P], b: &[P]) -> Option<P> {
        a.iter().copied().find(|pa| {
            b.iter()
                .any(|pb| root(&self.joint_root, pa.x) == root(&self.joint_root, pb.x))
        })
    }

    fn point_q(&self, i: usize) -> P {
        let x = self.q_start[i].expect("point has quantities");
        P { x, y: x + 1 }
    }

    fn wrong(owner: &str, reference: &str, expected: &'static str, found: &Ent) -> SketchError {
        SketchError::WrongEntityType {
            owner: owner.to_owned(),
            reference: reference.to_owned(),
            expected,
            found: found.type_name(),
        }
    }

    /// A point reference (non-recursive: safe while entities are being validated).
    fn point(&self, owner: &str, id: &str) -> Result<P, SketchError> {
        let i = self.lookup(owner, id)?;
        match &self.sketch.entities[i].geometry {
            Geometry::Point { .. } => Ok(self.point_q(i)),
            g => Err(SketchError::WrongEntityType {
                owner: owner.to_owned(),
                reference: id.to_owned(),
                expected: "point",
                found: g.type_name(),
            }),
        }
    }
    fn line(&self, owner: &str, id: &str) -> Result<Seg, SketchError> {
        match self.ent(owner, id)? {
            Ent::Line(l) => Ok(l),
            e => Err(Self::wrong(owner, id, "line", &e)),
        }
    }
    fn curve(&self, owner: &str, id: &str) -> Result<Curve, SketchError> {
        match self.ent(owner, id)? {
            Ent::Circle(c) | Ent::Arc(c, _) => Ok(c),
            e => Err(Self::wrong(owner, id, "circle or arc", &e)),
        }
    }
}

fn root(parent: &[Q], mut a: Q) -> Q {
    while parent[a as usize] != a {
        a = parent[a as usize];
    }
    a
}

fn finite(id: &str, field: &'static str, v: f64) -> Result<(), SketchError> {
    if v.is_finite() {
        Ok(())
    } else {
        Err(SketchError::NonFinite {
            id: id.to_owned(),
            field,
        })
    }
}

fn positive(id: &str, v: f64, what: &'static str) -> Result<(), SketchError> {
    finite(id, "value", v)?;
    if v > 0.0 {
        Ok(())
    } else {
        Err(SketchError::InvalidDimension {
            id: id.to_owned(),
            value: v,
            reason: what,
        })
    }
}

fn distinct(id: &str, a: &str, b: &str) -> Result<(), SketchError> {
    if a == b {
        Err(SketchError::SelfReference {
            id: id.to_owned(),
            reference: a.to_owned(),
        })
    } else {
        Ok(())
    }
}

/// Validate and compile a sketch.
pub(crate) fn compile(sketch: &Sketch) -> Result<System, SketchError> {
    // Ids: non-empty and unique across entities and constraints.
    let mut index = BTreeMap::new();
    let mut seen = BTreeMap::new();
    for (i, e) in sketch.entities.iter().enumerate() {
        if e.id.is_empty() {
            return Err(SketchError::EmptyId {
                what: "entity",
                index: i,
            });
        }
        if seen.insert(e.id.as_str(), ()).is_some() {
            return Err(SketchError::DuplicateId { id: e.id.clone() });
        }
        index.insert(e.id.clone(), i);
    }
    for (i, c) in sketch.constraints.iter().enumerate() {
        if c.id.is_empty() {
            return Err(SketchError::EmptyId {
                what: "constraint",
                index: i,
            });
        }
        if seen.insert(c.id.as_str(), ()).is_some() {
            return Err(SketchError::DuplicateId { id: c.id.clone() });
        }
    }

    // Quantities in entity order.
    let mut values0 = Vec::new();
    let mut q_start = vec![None; sketch.entities.len()];
    for (i, e) in sketch.entities.iter().enumerate() {
        match e.geometry {
            Geometry::Point { x, y } => {
                finite(&e.id, "x", x)?;
                finite(&e.id, "y", y)?;
                q_start[i] = Some(values0.len() as Q);
                values0.extend([x, y]);
            }
            Geometry::Circle { radius, .. } => {
                finite(&e.id, "radius", radius)?;
                if radius <= 0.0 {
                    return Err(SketchError::DegenerateEntity {
                        id: e.id.clone(),
                        reason: "radius must be > 0",
                    });
                }
                q_start[i] = Some(values0.len() as Q);
                values0.push(radius);
            }
            Geometry::Line { .. } | Geometry::Arc { .. } => {}
        }
    }
    let ctx = Ctx {
        sketch,
        index,
        q_start,
        joint_root: Vec::new(),
    };

    // Entity references, degeneracy, blocks and fixed quantities.
    let mut unknown = vec![true; values0.len()];
    let mut entities = Vec::with_capacity(sketch.entities.len());
    let mut equations = Vec::new();
    for (i, e) in sketch.entities.iter().enumerate() {
        let id = e.id.as_str();
        let info = match &e.geometry {
            Geometry::Point { .. } => {
                let p = ctx.point_q(i);
                EntityInfo {
                    point: Some(p),
                    radius: None,
                    block: vec![p.x, p.y],
                }
            }
            Geometry::Line { p1, p2 } => {
                let a = ctx.point(id, p1)?;
                let b = ctx.point(id, p2)?;
                if p1 == p2 {
                    return Err(SketchError::DegenerateEntity {
                        id: id.to_owned(),
                        reason: "line endpoints must be distinct points",
                    });
                }
                EntityInfo {
                    point: None,
                    radius: None,
                    block: vec![a.x, a.y, b.x, b.y],
                }
            }
            Geometry::Circle { center, .. } => {
                let c = ctx.point(id, center)?;
                let r = ctx.q_start[i].expect("circle radius quantity");
                EntityInfo {
                    point: None,
                    radius: Some(r),
                    block: vec![c.x, c.y, r],
                }
            }
            Geometry::Arc { center, start, end } => {
                let c = ctx.point(id, center)?;
                let s = ctx.point(id, start)?;
                let en = ctx.point(id, end)?;
                if center == start || center == end || start == end {
                    return Err(SketchError::DegenerateEntity {
                        id: id.to_owned(),
                        reason: "arc center, start and end must be distinct points",
                    });
                }
                equations.push(Equation {
                    kind: EqKind::ArcRule { c, s, e: en },
                    owner: Owner::ArcRule(i),
                    vars: Vec::new(),
                });
                EntityInfo {
                    point: None,
                    radius: None,
                    block: vec![c.x, c.y, s.x, s.y, en.x, en.y],
                }
            }
        };
        if e.fixed {
            for &q in &info.block {
                unknown[q as usize] = false;
            }
        }
        let mut info = info;
        info.block.sort_unstable();
        entities.push(info);
    }

    // Joints: points joined by driving coincident constraints (for tangency at a joint).
    let mut joint_root: Vec<Q> = (0..values0.len() as Q).collect();
    for con in &sketch.constraints {
        if con.driving
            && let ConstraintKind::Coincident { a, b } = &con.kind
            && let (Ok(pa), Ok(pb)) = (ctx.point(&con.id, a), ctx.point(&con.id, b))
        {
            let (ra, rb) = (root(&joint_root, pa.x), root(&joint_root, pb.x));
            let (lo, hi) = (ra.min(rb), ra.max(rb));
            joint_root[hi as usize] = lo;
        }
    }
    let ctx = Ctx { joint_root, ..ctx };

    // Constraints.
    let mut constraint_eqs = Vec::with_capacity(sketch.constraints.len());
    let mut measures = Vec::with_capacity(sketch.constraints.len());
    for (ci, con) in sketch.constraints.iter().enumerate() {
        let id = con.id.as_str();
        if !con.driving && !con.kind.is_dimension() {
            return Err(SketchError::NotADimension { id: id.to_owned() });
        }
        let (kinds, measure) = compile_constraint(&ctx, id, &con.kind, &values0)?;
        let start = equations.len();
        if con.driving {
            for kind in kinds {
                equations.push(Equation {
                    kind,
                    owner: Owner::Constraint(ci),
                    vars: Vec::new(),
                });
            }
        }
        constraint_eqs.push(start..equations.len());
        measures.push(measure);
    }
    for eq in &mut equations {
        eq.vars = eq.kind.vars();
    }

    Ok(System {
        values0,
        unknown,
        equations,
        constraint_eqs,
        measures,
        entities,
        entity_index: ctx.index,
    })
}

fn unsupported(id: &str, kind: &'static str, a: &Ent, b: &Ent) -> SketchError {
    SketchError::UnsupportedCombination {
        id: id.to_owned(),
        kind,
        a: a.type_name(),
        b: b.type_name(),
    }
}

/// Distance-based curve–curve tangency (internal/external from the input geometry unless
/// forced).
fn curve_tangency(c1: Curve, c2: Curve, internal: Option<bool>, q0: &[f64]) -> EqKind {
    let internal = internal.unwrap_or_else(|| {
        let d = point_dist(c1.c, c2.c, q0);
        d < eval_radius(c1, q0).max(eval_radius(c2, q0))
    });
    EqKind::TangentCurves { c1, c2, internal }
}

fn point_dist(a: P, b: P, q: &[f64]) -> f64 {
    let g = |i: Q| q[i as usize];
    (pt(&g, b) - pt(&g, a)).norm()
}

fn dir_len(l: Seg, q: &[f64]) -> f64 {
    point_dist(l.a, l.b, q)
}

/// Constant scale of a joint-tangency residual: `sqrt(len · |p − c|)` on the input,
/// floored at 1 µm.
fn joint_scale(len: f64, p: P, c: P, q: &[f64]) -> f64 {
    (len * point_dist(p, c, q)).sqrt().max(1e-3)
}

/// Constant length scale of an angular residual: the geometric mean of the two input
/// line lengths, floored at 1 µm.
fn angular_scale(l1: Seg, l2: Seg, q: &[f64]) -> f64 {
    let g = |i: Q| q[i as usize];
    (dir(&g, l1).norm() * dir(&g, l2).norm()).sqrt().max(1e-3)
}

fn eval_radius(c: Curve, q: &[f64]) -> f64 {
    radius(&|i: Q| q[i as usize], c)
}

type Compiled = (Vec<EqKind>, Option<Measure>);

fn compile_constraint(
    ctx: &Ctx<'_>,
    id: &str,
    kind: &ConstraintKind,
    q0: &[f64],
) -> Result<Compiled, SketchError> {
    use ConstraintKind as K;
    Ok(match kind {
        K::Coincident { a, b } => {
            distinct(id, a, b)?;
            let (a, b) = (ctx.point(id, a)?, ctx.point(id, b)?);
            (
                vec![
                    EqKind::Diff { a: a.x, b: b.x },
                    EqKind::Diff { a: a.y, b: b.y },
                ],
                None,
            )
        }
        K::Horizontal { line } => {
            let l = ctx.line(id, line)?;
            (vec![EqKind::Diff { a: l.b.y, b: l.a.y }], None)
        }
        K::Vertical { line } => {
            let l = ctx.line(id, line)?;
            (vec![EqKind::Diff { a: l.b.x, b: l.a.x }], None)
        }
        K::Parallel { a, b } => {
            distinct(id, a, b)?;
            let (l1, l2) = (ctx.line(id, a)?, ctx.line(id, b)?);
            let s = angular_scale(l1, l2, q0);
            (vec![EqKind::Parallel { l1, l2, s }], None)
        }
        K::Perpendicular { a, b } => {
            distinct(id, a, b)?;
            let (l1, l2) = (ctx.line(id, a)?, ctx.line(id, b)?);
            let s = angular_scale(l1, l2, q0);
            (vec![EqKind::Perpendicular { l1, l2, s }], None)
        }
        K::Tangent { a, b, internal } => {
            distinct(id, a, b)?;
            let (ea, eb) = (ctx.ent(id, a)?, ctx.ent(id, b)?);
            let eq = match (ea, eb) {
                (Ent::Line(l), Ent::Arc(c, end)) | (Ent::Arc(c, end), Ent::Line(l)) => {
                    let Rad::Arc { s: start } = c.r else {
                        unreachable!("arcs derive their radius from the start point")
                    };
                    match ctx.joint(&[l.a, l.b], &[start, end]) {
                        Some(p) => EqKind::TangentLineAt {
                            l,
                            p,
                            c: c.c,
                            s: joint_scale(dir_len(l, q0), p, c.c, q0),
                        },
                        None => EqKind::TangentLine { l, c },
                    }
                }
                (Ent::Line(l), Ent::Circle(c)) | (Ent::Circle(c), Ent::Line(l)) => {
                    EqKind::TangentLine { l, c }
                }
                (Ent::Arc(c1, e1), Ent::Arc(c2, e2)) => {
                    let (Rad::Arc { s: s1 }, Rad::Arc { s: s2 }) = (c1.r, c2.r) else {
                        unreachable!("arcs derive their radius from the start point")
                    };
                    match ctx.joint(&[s1, e1], &[s2, e2]) {
                        Some(p) => EqKind::TangentCurvesAt {
                            p,
                            c1: c1.c,
                            c2: c2.c,
                            s: joint_scale(point_dist(p, c1.c, q0), p, c2.c, q0),
                        },
                        None => curve_tangency(c1, c2, *internal, q0),
                    }
                }
                (Ent::Circle(c1) | Ent::Arc(c1, _), Ent::Circle(c2) | Ent::Arc(c2, _)) => {
                    curve_tangency(c1, c2, *internal, q0)
                }
                (x, y) => return Err(unsupported(id, "tangent", &x, &y)),
            };
            (vec![eq], None)
        }
        K::Equal { a, b } => {
            distinct(id, a, b)?;
            let (ea, eb) = (ctx.ent(id, a)?, ctx.ent(id, b)?);
            let eq = match (ea, eb) {
                (Ent::Line(l1), Ent::Line(l2)) => EqKind::EqualLength { l1, l2 },
                (Ent::Circle(c1) | Ent::Arc(c1, _), Ent::Circle(c2) | Ent::Arc(c2, _)) => {
                    EqKind::EqualRadius { c1, c2 }
                }
                (x, y) => return Err(unsupported(id, "equal", &x, &y)),
            };
            (vec![eq], None)
        }
        K::Distance { a, b, value } => {
            positive(
                id,
                *value,
                "distance must be > 0 (use coincident / point_on_line)",
            )?;
            distinct(id, a, b)?;
            let p = ctx.point(id, a)?;
            match ctx.ent(id, b)? {
                Ent::Point(q) => (
                    vec![EqKind::PPDist {
                        a: p,
                        b: q,
                        v: *value,
                    }],
                    Some(Measure::PPDist { a: p, b: q }),
                ),
                Ent::Line(l) => (
                    vec![EqKind::PLDist { p, l, v: *value }],
                    Some(Measure::PLDist { p, l }),
                ),
                e => return Err(Ctx::wrong(id, b, "point or line", &e)),
            }
        }
        K::Angle { a, b, value } => {
            finite(id, "value", *value)?;
            distinct(id, a, b)?;
            let (l1, l2) = (ctx.line(id, a)?, ctx.line(id, b)?);
            let theta = math::wrap_angle(math::deg_to_rad(*value), -math::PI);
            let s = angular_scale(l1, l2, q0);
            (
                vec![EqKind::Angle { l1, l2, theta, s }],
                Some(Measure::Angle { l1, l2 }),
            )
        }
        K::Radius { curve, value } => {
            positive(id, *value, "radius must be > 0")?;
            let c = ctx.curve(id, curve)?;
            (
                vec![EqKind::Radius { c, v: *value }],
                Some(Measure::Radius { c }),
            )
        }
        K::Diameter { curve, value } => {
            positive(id, *value, "diameter must be > 0")?;
            let c = ctx.curve(id, curve)?;
            (
                vec![EqKind::Radius { c, v: *value * 0.5 }],
                Some(Measure::Diameter { c }),
            )
        }
        K::PointOnLine { point, line } => {
            let (p, l) = (ctx.point(id, point)?, ctx.line(id, line)?);
            (vec![EqKind::PointOnLine { p, l }], None)
        }
        K::PointOnCircle { point, curve } => {
            let (p, c) = (ctx.point(id, point)?, ctx.curve(id, curve)?);
            (vec![EqKind::PointOnCurve { p, c }], None)
        }
        K::Midpoint { point, line } => {
            let (p, l) = (ctx.point(id, point)?, ctx.line(id, line)?);
            (
                vec![
                    EqKind::MidCoord {
                        p: p.x,
                        a: l.a.x,
                        b: l.b.x,
                    },
                    EqKind::MidCoord {
                        p: p.y,
                        a: l.a.y,
                        b: l.b.y,
                    },
                ],
                None,
            )
        }
        K::Symmetric { a, b, line } => {
            distinct(id, a, b)?;
            let (pa, pb, l) = (ctx.point(id, a)?, ctx.point(id, b)?, ctx.line(id, line)?);
            (
                vec![
                    EqKind::SymMid { a: pa, b: pb, l },
                    EqKind::SymPerp { a: pa, b: pb, l },
                ],
                None,
            )
        }
        K::Fix { entity, x, y } => {
            let target = |q: Q, over: Option<f64>| -> Result<EqKind, SketchError> {
                let v = over.unwrap_or(q0[q as usize]);
                finite(id, "value", v)?;
                Ok(EqKind::Target { a: q, v })
            };
            match ctx.ent(id, entity)? {
                Ent::Point(p) => (vec![target(p.x, *x)?, target(p.y, *y)?], None),
                e @ (Ent::Line(_) | Ent::Circle(_)) if x.is_some() || y.is_some() => {
                    return Err(Ctx::wrong(id, entity, "point (x/y targets)", &e));
                }
                Ent::Line(l) => (
                    vec![
                        target(l.a.x, None)?,
                        target(l.a.y, None)?,
                        target(l.b.x, None)?,
                        target(l.b.y, None)?,
                    ],
                    None,
                ),
                Ent::Circle(c) => {
                    let Rad::Param(r) = c.r else {
                        unreachable!("circles have a radius parameter")
                    };
                    (
                        vec![target(c.c.x, None)?, target(c.c.y, None)?, target(r, None)?],
                        None,
                    )
                }
                e @ Ent::Arc(..) => {
                    return Err(Ctx::wrong(
                        id,
                        entity,
                        "point, line or circle (fix an arc's points)",
                        &e,
                    ));
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Constraint, Entity, Sketch, c};
    use proptest::prelude::*;
    use std::collections::BTreeSet;

    /// A sketch that exercises every equation kind (checked below).
    fn zoo() -> Sketch {
        let mut s = Sketch::default();
        let pts = [
            ("a", 0.0, 0.0),
            ("b", 10.0, 1.0),
            ("c", 3.0, 8.0),
            ("d", 12.0, 9.5),
            ("e", -4.0, 5.0),
            ("f", 6.0, -3.0),
            ("m", 5.2, 0.4),
            ("o1", 20.0, 0.0),
            ("o2", 29.5, 1.0),
            ("o3", 21.0, 0.5),
            ("ac", 0.0, 20.0),
            ("as", 5.0, 20.2),
            ("ae", 0.1, 25.0),
            ("bc", 10.1, 20.3),
            ("be", 10.0, 25.1),
            ("ls", 5.0, 14.0),
        ];
        for (id, x, y) in pts {
            s.entities.push(Entity::point(id, x, y));
        }
        s.entities.push(Entity::line("ab", "a", "b"));
        s.entities.push(Entity::line("cd", "c", "d"));
        s.entities.push(Entity::line("ef", "e", "f"));
        s.entities.push(Entity::line("tan", "ls", "as"));
        s.entities.push(Entity::circle("C1", "o1", 4.0));
        s.entities.push(Entity::circle("C2", "o2", 5.0));
        s.entities.push(Entity::circle("C3", "o3", 1.5));
        s.entities.push(Entity::arc("A1", "ac", "as", "ae"));
        s.entities.push(Entity::arc("A2", "bc", "as", "be"));
        let k = |s: &mut Sketch, id: &str, kind| s.constraints.push(Constraint::new(id, kind));
        k(&mut s, "k0", c::coincident("m", "f"));
        k(&mut s, "k1", c::horizontal("ab"));
        k(&mut s, "k2", c::vertical("ef"));
        k(&mut s, "k3", c::parallel("ab", "cd"));
        k(&mut s, "k4", c::perpendicular("ab", "ef"));
        k(&mut s, "k5", c::tangent("cd", "C1"));
        k(&mut s, "k6", c::tangent("tan", "A1"));
        k(&mut s, "k7", c::tangent("ab", "A1"));
        k(&mut s, "k8", c::tangent("C1", "C2"));
        k(&mut s, "k9", c::tangent("C1", "C3"));
        k(&mut s, "k10", c::tangent("A1", "A2"));
        k(&mut s, "k11", c::tangent("C2", "A2"));
        k(&mut s, "k12", c::equal("ab", "cd"));
        k(&mut s, "k13", c::equal("C1", "A1"));
        k(&mut s, "k14", c::distance("a", "c", 8.0));
        k(&mut s, "k15", c::distance("e", "ab", 5.0));
        k(&mut s, "k16", c::angle("ab", "cd", 30.0));
        k(&mut s, "k17", c::radius("A1", 5.0));
        k(&mut s, "k18", c::diameter("C2", 10.0));
        k(&mut s, "k19", c::point_on_line("m", "ab"));
        k(&mut s, "k20", c::point_on_circle("d", "C1"));
        k(&mut s, "k21", c::point_on_circle("e", "A2"));
        k(&mut s, "k22", c::midpoint("m", "ab"));
        k(&mut s, "k23", c::symmetric("c", "d", "ef"));
        k(&mut s, "k24", c::fix("a"));
        k(&mut s, "k25", c::fix("cd"));
        k(&mut s, "k26", c::fix("C3"));
        s
    }

    fn sq(x: f64) -> f64 {
        x * x
    }

    fn variant_index(k: &EqKind) -> usize {
        match k {
            EqKind::Diff { .. } => 0,
            EqKind::Target { .. } => 1,
            EqKind::PPDist { .. } => 2,
            EqKind::PLDist { .. } => 3,
            EqKind::PointOnLine { .. } => 4,
            EqKind::Parallel { .. } => 5,
            EqKind::Perpendicular { .. } => 6,
            EqKind::Angle { .. } => 7,
            EqKind::EqualLength { .. } => 8,
            EqKind::EqualRadius { .. } => 9,
            EqKind::Radius { .. } => 10,
            EqKind::PointOnCurve { .. } => 11,
            EqKind::TangentLine { .. } => 12,
            EqKind::TangentLineAt { .. } => 13,
            EqKind::TangentCurvesAt { .. } => 14,
            EqKind::TangentCurves {
                internal: false, ..
            } => 15,
            EqKind::TangentCurves { internal: true, .. } => 16,
            EqKind::MidCoord { .. } => 17,
            EqKind::SymMid { .. } => 18,
            EqKind::SymPerp { .. } => 19,
            EqKind::ArcRule { .. } => 20,
        }
    }

    #[test]
    fn the_zoo_covers_every_equation_kind() {
        let sys = compile(&zoo()).expect("valid zoo");
        let kinds: BTreeSet<usize> = sys
            .equations
            .iter()
            .map(|e| variant_index(&e.kind))
            .collect();
        assert_eq!(kinds, (0..21).collect::<BTreeSet<_>>());
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(64))]

        /// Forward-mode AD (Dual) equals central finite differences for every equation.
        #[test]
        fn dual_jacobian_matches_central_differences(offsets in proptest::collection::vec(-0.3f64..0.3, 64)) {
            let sys = compile(&zoo()).expect("valid zoo");
            let mut q = sys.values0.clone();
            for (i, v) in q.iter_mut().enumerate() {
                *v += offsets[i % offsets.len()];
            }
            let mut grad = Vec::new();
            for e in 0..sys.equations.len() {
                let f0 = sys.residual_and_gradient(e, &q, &mut grad);
                prop_assert!((f0 - sys.residual(e, &q)).abs() <= 1e-12 * (1.0 + f0.abs()));
                for &(v, d) in &grad {
                    let h = 1e-6 * (1.0 + q[v as usize].abs());
                    let mut qp = q.clone();
                    qp[v as usize] += h;
                    let mut qm = q.clone();
                    qm[v as usize] -= h;
                    let fd = (sys.residual(e, &qp) - sys.residual(e, &qm)) / (2.0 * h);
                    prop_assert!((d - fd).abs() <= 1e-5 * (1.0 + d.abs()),
                        "eq {e} ({:?}) var {v}: dual {d} fd {fd}", sys.equations[e].kind);
                }
            }
        }
    }

    /// Hand-derived gradients agree with forward-mode AD to rounding.
    #[test]
    fn dual_jacobian_matches_hand_derived_gradients() {
        let sys = compile(&zoo()).expect("valid zoo");
        let q = &sys.values0;
        let v = |p: P| [q[p.x as usize], q[p.y as usize]];
        let mut grad = Vec::new();
        let mut checked = BTreeSet::new();
        for e in 0..sys.equations.len() {
            sys.residual_and_gradient(e, q, &mut grad);
            let g = |var: Q| {
                grad.iter()
                    .find(|(w, _)| *w == var)
                    .map_or(0.0, |(_, d)| *d)
            };
            let close = |a: f64, b: f64| (a - b).abs() <= 1e-13 * (1.0 + b.abs());
            match sys.equations[e].kind {
                EqKind::Diff { a, b } if sys.unknown[a as usize] && sys.unknown[b as usize] => {
                    assert!(close(g(a), 1.0) && close(g(b), -1.0));
                    checked.insert("diff");
                }
                EqKind::PPDist { a, b, .. } => {
                    let (pa, pb) = (v(a), v(b));
                    let n = (sq(pb[0] - pa[0]) + sq(pb[1] - pa[1]) + NORM_EPS2).sqrt();
                    let u = [(pb[0] - pa[0]) / n, (pb[1] - pa[1]) / n];
                    if sys.unknown[b.x as usize] {
                        assert!(close(g(b.x), u[0]) && close(g(b.y), u[1]));
                    }
                    if sys.unknown[a.x as usize] {
                        assert!(close(g(a.x), -u[0]) && close(g(a.y), -u[1]));
                    }
                    checked.insert("ppdist");
                }
                EqKind::PointOnLine { p, l } => {
                    // f = cross(d, p − a)/|d|  ⇒  ∂f/∂p = (−d_y, d_x)/|d|.
                    let (a, b) = (v(l.a), v(l.b));
                    let d = [b[0] - a[0], b[1] - a[1]];
                    let n = (d[0] * d[0] + d[1] * d[1] + NORM_EPS2).sqrt();
                    assert!(close(g(p.x), -d[1] / n) && close(g(p.y), d[0] / n));
                    checked.insert("point_on_line");
                }
                EqKind::MidCoord { p, a, b } => {
                    assert!(close(g(p), 1.0) && close(g(a), -0.5) && close(g(b), -0.5));
                    checked.insert("midpoint");
                }
                EqKind::Radius {
                    c: Curve {
                        r: Rad::Param(r), ..
                    },
                    ..
                } => {
                    assert!(close(g(r), 1.0));
                    checked.insert("radius");
                }
                EqKind::ArcRule { c, s, e: en } => {
                    let (pc, ps, pe) = (v(c), v(s), v(en));
                    let ne = (sq(pe[0] - pc[0]) + sq(pe[1] - pc[1]) + NORM_EPS2).sqrt();
                    let ns = (sq(ps[0] - pc[0]) + sq(ps[1] - pc[1]) + NORM_EPS2).sqrt();
                    let ue = [(pe[0] - pc[0]) / ne, (pe[1] - pc[1]) / ne];
                    let us = [(ps[0] - pc[0]) / ns, (ps[1] - pc[1]) / ns];
                    assert!(close(g(en.x), ue[0]) && close(g(en.y), ue[1]));
                    assert!(close(g(s.x), -us[0]) && close(g(s.y), -us[1]));
                    assert!(close(g(c.x), -ue[0] + us[0]) && close(g(c.y), -ue[1] + us[1]));
                    checked.insert("arc_rule");
                }
                EqKind::EqualLength { l1, l2 } => {
                    let d1 = [v(l1.b)[0] - v(l1.a)[0], v(l1.b)[1] - v(l1.a)[1]];
                    let n1 = (d1[0] * d1[0] + d1[1] * d1[1] + NORM_EPS2).sqrt();
                    let d2 = [v(l2.b)[0] - v(l2.a)[0], v(l2.b)[1] - v(l2.a)[1]];
                    let n2 = (d2[0] * d2[0] + d2[1] * d2[1] + NORM_EPS2).sqrt();
                    assert!(close(g(l1.b.x), d1[0] / n1) && close(g(l1.a.y), -d1[1] / n1));
                    if sys.unknown[l2.b.x as usize] {
                        assert!(close(g(l2.b.x), -d2[0] / n2) && close(g(l2.a.y), d2[1] / n2));
                    }
                    checked.insert("equal_length");
                }
                _ => {}
            }
        }
        assert_eq!(checked.len(), 7, "{checked:?}");
    }
}
