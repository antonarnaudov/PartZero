//! The IR → forge-solve mapping of SPEC-v1 §4.3 [D-21].
//!
//! - **Entities** in curve order, each curve's points before the curve: `point p` → point
//!   `p`; `line l` → points `l.start`, `l.end`, line `l`; `arc a` → points `a.start`, `a.end`,
//!   `a.center`, arc `a` = (`a.center`, `a.start`, `a.end`) if `ccw`, else (`a.center`,
//!   `a.end`, `a.start`); `circle c` → point `c.center`, circle `c`. A welded end that is not
//!   its group's representative gets no point: every reference to it goes to the
//!   representative.
//! - **Constraints** in IR order, the same ids, arguments resolved through the welding.
//!   [W0-9]: two different argument ids that welding maps to one solver point are not a
//!   self-reference. forge-solve rejects a constraint naming one point twice, so the lowering
//!   decides those constraints itself, exactly as forge-solve would with the two points merged:
//!   - `coincident(a, b)`: its two equations are identically zero → redundant, implied by the
//!     welding; left out of the solver input;
//!   - `distance(a, b)` between points: a driving value (> 0) can never hold → a conflict of
//!     its own; a reference distance measures 0; left out of the solver input;
//!   - `symmetric(a, b, line)`: the perpendicularity equation is identically zero (partially
//!     redundant), the remaining one is "the point lies on the line" → lowered to
//!     `point_on_line(a, line)` with the same id.
//! - Dimension values are the evaluated Scalars; a reference dimension (no `value`) gets a
//!   positive placeholder, which forge-solve never uses (it only measures).

use forge_ir::v1::{Constraint, LiteralCurve};
use forge_solve::{Constraint as SConstraint, ConstraintKind as K, Entity, Sketch as SSketch};

use crate::weld::Welding;

/// Evaluated values of one IR constraint.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ConstraintValues {
    /// A driving dimension's evaluated `value` (mm or degrees).
    pub value: Option<f64>,
    /// A `fix`'s evaluated `x` target.
    pub x: Option<f64>,
    /// A `fix`'s evaluated `y` target.
    pub y: Option<f64>,
}

/// A constraint between two welded ends that the lowering decided without forge-solve (see
/// the module docs).
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Decided {
    /// `coincident` between two welded ends: fully redundant.
    Coincident { a: String, b: String },
    /// Driving `distance` between two welded ends: a conflict.
    DrivingDistance { a: String, b: String, value: f64 },
    /// Reference `distance` between two welded ends: measures 0.
    ReferenceDistance,
    /// `symmetric` about a line of two welded ends: partially redundant, lowered to
    /// `point_on_line`.
    Symmetric { a: String, b: String },
}

/// The forge-solve input and what the lowering decided itself, per IR constraint index.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Lowered {
    pub sketch: SSketch,
    pub decided: Vec<Option<Decided>>,
}

/// Lower the stored geometry and constraints (constrained mode) to a forge-solve sketch.
pub(crate) fn lower(
    curves: &[LiteralCurve],
    constraints: &[Constraint],
    values: &[ConstraintValues],
    welding: &Welding,
) -> Lowered {
    let mut entities = Vec::new();
    let point = |id: String, p: [f64; 2], construction: bool| {
        let e = Entity::point(id, p[0], p[1]);
        if construction { e.construction() } else { e }
    };
    for c in curves {
        match c {
            LiteralCurve::Point {
                id,
                at,
                construction,
            } => entities.push(point(id.clone(), *at, *construction)),
            LiteralCurve::Line {
                id,
                start,
                end,
                construction,
            } => {
                let (s, e) = (format!("{id}.start"), format!("{id}.end"));
                for (pid, p) in [(&s, start), (&e, end)] {
                    if !welding.is_alias(pid) {
                        entities.push(point(pid.clone(), *p, *construction));
                    }
                }
                let line = Entity::line(id.clone(), welding.resolve(&s), welding.resolve(&e));
                entities.push(if *construction {
                    line.construction()
                } else {
                    line
                });
            }
            LiteralCurve::Arc {
                id,
                start,
                end,
                center,
                ccw,
                construction,
            } => {
                let (s, e, m) = (
                    format!("{id}.start"),
                    format!("{id}.end"),
                    format!("{id}.center"),
                );
                for (pid, p) in [(&s, start), (&e, end)] {
                    if !welding.is_alias(pid) {
                        entities.push(point(pid.clone(), *p, *construction));
                    }
                }
                entities.push(point(m.clone(), *center, *construction));
                let (rs, re) = (welding.resolve(&s), welding.resolve(&e));
                let arc = if *ccw {
                    Entity::arc(id.clone(), m, rs, re)
                } else {
                    Entity::arc(id.clone(), m, re, rs)
                };
                entities.push(if *construction {
                    arc.construction()
                } else {
                    arc
                });
            }
            LiteralCurve::Circle {
                id,
                center,
                radius,
                construction,
            } => {
                let m = format!("{id}.center");
                entities.push(point(m.clone(), *center, *construction));
                let circle = Entity::circle(id.clone(), m, *radius);
                entities.push(if *construction {
                    circle.construction()
                } else {
                    circle
                });
            }
        }
    }

    let mut out = Vec::with_capacity(constraints.len());
    let mut decided = Vec::with_capacity(constraints.len());
    for (con, v) in constraints.iter().zip(values) {
        let (kind, d) = lower_constraint(con, v, welding);
        decided.push(d);
        if let Some(kind) = kind {
            let driving = con.dimension().is_none_or(|(_, driving)| driving);
            let mut c = SConstraint::new(con.id(), kind);
            c.driving = driving;
            out.push(c);
        }
    }
    Lowered {
        sketch: SSketch {
            entities,
            constraints: out,
        },
        decided,
    }
}

/// Placeholder value of a reference dimension (never used by forge-solve, which only
/// measures reference dimensions; distances, radii and diameters must still be > 0).
const REFERENCE_PLACEHOLDER: f64 = 1.0;

fn lower_constraint(
    con: &Constraint,
    v: &ConstraintValues,
    w: &Welding,
) -> (Option<K>, Option<Decided>) {
    let r = |id: &str| w.resolve(id).to_string();
    // Two argument ids, different as written, that welding maps to one solver point.
    let merged = |a: &str, b: &str| a != b && w.resolve(a) == w.resolve(b);
    let dim = |placeholder: f64| v.value.unwrap_or(placeholder);
    match con {
        Constraint::Coincident { a, b, .. } => {
            if merged(a, b) {
                return (
                    None,
                    Some(Decided::Coincident {
                        a: a.clone(),
                        b: b.clone(),
                    }),
                );
            }
            (Some(K::Coincident { a: r(a), b: r(b) }), None)
        }
        Constraint::Horizontal { line, .. } => (Some(K::Horizontal { line: r(line) }), None),
        Constraint::Vertical { line, .. } => (Some(K::Vertical { line: r(line) }), None),
        Constraint::Parallel { a, b, .. } => (Some(K::Parallel { a: r(a), b: r(b) }), None),
        Constraint::Perpendicular { a, b, .. } => {
            (Some(K::Perpendicular { a: r(a), b: r(b) }), None)
        }
        Constraint::Tangent { a, b, internal, .. } => (
            Some(K::Tangent {
                a: r(a),
                b: r(b),
                internal: *internal,
            }),
            None,
        ),
        Constraint::Equal { a, b, .. } => (Some(K::Equal { a: r(a), b: r(b) }), None),
        Constraint::Distance { a, b, driving, .. } => {
            if merged(a, b) {
                let d = if *driving {
                    Decided::DrivingDistance {
                        a: a.clone(),
                        b: b.clone(),
                        value: dim(REFERENCE_PLACEHOLDER),
                    }
                } else {
                    Decided::ReferenceDistance
                };
                return (None, Some(d));
            }
            (
                Some(K::Distance {
                    a: r(a),
                    b: r(b),
                    value: dim(REFERENCE_PLACEHOLDER),
                }),
                None,
            )
        }
        Constraint::Angle { a, b, .. } => (
            Some(K::Angle {
                a: r(a),
                b: r(b),
                value: dim(0.0),
            }),
            None,
        ),
        Constraint::Radius { curve, .. } => (
            Some(K::Radius {
                curve: r(curve),
                value: dim(REFERENCE_PLACEHOLDER),
            }),
            None,
        ),
        Constraint::Diameter { curve, .. } => (
            Some(K::Diameter {
                curve: r(curve),
                value: dim(REFERENCE_PLACEHOLDER),
            }),
            None,
        ),
        Constraint::PointOnLine { point, line, .. } => (
            Some(K::PointOnLine {
                point: r(point),
                line: r(line),
            }),
            None,
        ),
        Constraint::PointOnCircle { point, curve, .. } => (
            Some(K::PointOnCircle {
                point: r(point),
                curve: r(curve),
            }),
            None,
        ),
        Constraint::Midpoint { point, line, .. } => (
            Some(K::Midpoint {
                point: r(point),
                line: r(line),
            }),
            None,
        ),
        Constraint::Symmetric { a, b, line, .. } => {
            if merged(a, b) {
                return (
                    Some(K::PointOnLine {
                        point: r(a),
                        line: r(line),
                    }),
                    Some(Decided::Symmetric {
                        a: a.clone(),
                        b: b.clone(),
                    }),
                );
            }
            (
                Some(K::Symmetric {
                    a: r(a),
                    b: r(b),
                    line: r(line),
                }),
                None,
            )
        }
        Constraint::Fix { entity, .. } => (
            Some(K::Fix {
                entity: r(entity),
                x: v.x,
                y: v.y,
            }),
            None,
        ),
    }
}
