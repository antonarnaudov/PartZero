//! Lifting a forge-solve sketch to an IR v1 constrained sketch (test and corpus tooling).
//!
//! The acceptance gates of W2 (IR-V1 plan §4) run on forge-solve's generated corpus
//! (`forge_solve::generate::corpus`) "lifted to IR". forge-solve entities share point
//! entities by id; IR curves own their ends. The lift therefore:
//! - maps every forge-solve point to the IR id of its first use (`<line>.start`, `<arc>.end`,
//!   `<circle>.center`, …) or, when no curve uses it, to a `point` curve with its own id;
//! - relies on welding (SPEC-v1 §4.3) for a point shared as an **end** by several lines/arcs
//!   (the ends get identical stored coordinates, so they weld);
//! - adds an explicit `coincident` (id `lift_c<k>`) where a shared point is a **centre** in
//!   one of its uses (centres never weld), and a `fix` (id `lift_f<k>`) for every `fixed`
//!   entity (the IR has no fixed entities). Those lift constraints come **first**, so the
//!   original constraints keep forge-solve's attribution order.
//!
//! A lift is [`Lifted::exact`] when it needed no lift constraint and its welding joins exactly
//! the shared ends: the lowered IR sketch is then the original problem up to entity order.

use std::collections::BTreeMap;

use forge_ir::v1::ids;
use forge_ir::v1::{BoolScalar, Constraint, PlaneRef, Scalar, SketchCurve, SketchFeature};
use forge_solve::{ConstraintKind as K, Geometry, Sketch};

use crate::geometry::stored_geometry;
use crate::weld::Welding;

/// A lifted sketch.
#[derive(Debug, Clone, PartialEq)]
pub struct Lifted {
    /// The IR sketch (constrained mode; plane `XY`).
    pub sketch: SketchFeature,
    /// No lift constraint was needed and welding joins exactly the shared ends.
    pub exact: bool,
    /// forge-solve point id → IR entity id.
    pub points: BTreeMap<String, String>,
}

/// Why a sketch cannot be lifted.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LiftError {
    /// An id outside the IR id grammar.
    #[error("id {0:?} is not a valid IR id")]
    InvalidId(String),
    /// A reference to a missing or wrong entity.
    #[error("entity {0:?} is missing or not a point")]
    BadReference(String),
}

/// Lift `s` to an IR sketch with id and name `id`. With `reverse_arcs`, every arc is written
/// clockwise (`ccw: false`, start and end swapped), which lowers to the same forge-solve arc.
pub fn lift(id: &str, s: &Sketch, reverse_arcs: bool) -> Result<Lifted, LiftError> {
    let valid = |x: &str| -> Result<(), LiftError> {
        if ids::is_id(x) {
            Ok(())
        } else {
            Err(LiftError::InvalidId(x.to_string()))
        }
    };
    let coords: BTreeMap<&str, [f64; 2]> = s
        .entities
        .iter()
        .filter_map(|e| match e.geometry {
            Geometry::Point { x, y } => Some((e.id.as_str(), [x, y])),
            _ => None,
        })
        .collect();
    let pt = |pid: &str| -> Result<[Scalar; 2], LiftError> {
        let p = coords
            .get(pid)
            .ok_or_else(|| LiftError::BadReference(pid.to_string()))?;
        Ok([Scalar::Num(p[0]), Scalar::Num(p[1])])
    };

    // Uses of every point: (IR id, is an end).
    let mut uses: BTreeMap<String, Vec<(String, bool)>> = BTreeMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut use_point = |pid: &str, ir: String, end: bool| {
        if !uses.contains_key(pid) {
            order.push(pid.to_string());
        }
        uses.entry(pid.to_string()).or_default().push((ir, end));
    };
    let mut curves = Vec::new();
    for e in &s.entities {
        valid(&e.id)?;
        let construction = e.construction;
        match &e.geometry {
            Geometry::Point { .. } => {}
            Geometry::Line { p1, p2 } => {
                use_point(p1, format!("{}.start", e.id), true);
                use_point(p2, format!("{}.end", e.id), true);
                curves.push(SketchCurve::Line {
                    id: e.id.clone(),
                    start: pt(p1)?,
                    end: pt(p2)?,
                    construction,
                });
            }
            Geometry::Arc { center, start, end } => {
                let (s_id, e_id) = (format!("{}.start", e.id), format!("{}.end", e.id));
                // Clockwise IR arcs swap start and end (SPEC-v1 §4.3 ccw rule).
                let (ir_s, ir_e) = if reverse_arcs {
                    (end, start)
                } else {
                    (start, end)
                };
                use_point(ir_s, s_id, true);
                use_point(ir_e, e_id, true);
                use_point(center, format!("{}.center", e.id), false);
                curves.push(SketchCurve::Arc {
                    id: e.id.clone(),
                    start: pt(ir_s)?,
                    end: pt(ir_e)?,
                    center: pt(center)?,
                    ccw: !reverse_arcs,
                    construction,
                });
            }
            Geometry::Circle { center, radius } => {
                use_point(center, format!("{}.center", e.id), false);
                curves.push(SketchCurve::Circle {
                    id: e.id.clone(),
                    center: pt(center)?,
                    radius: Scalar::Num(*radius),
                    construction,
                });
            }
        }
    }
    let mut exact = true;
    let mut points: BTreeMap<String, String> = BTreeMap::new();
    let mut lift_constraints: Vec<Constraint> = Vec::new();
    for pid in &order {
        let u = &uses[pid];
        let home = u[0].0.clone();
        for (other, end) in &u[1..] {
            // Ends weld by coordinates; anything involving a centre needs a constraint.
            if !(u[0].1 && *end) {
                exact = false;
                lift_constraints.push(Constraint::Coincident {
                    id: format!("lift_c{}", lift_constraints.len()),
                    a: home.clone(),
                    b: other.clone(),
                });
            }
        }
        points.insert(pid.clone(), home);
    }
    // Free points become point curves.
    for e in &s.entities {
        if let Geometry::Point { .. } = e.geometry
            && !points.contains_key(&e.id)
        {
            curves.push(SketchCurve::Point {
                id: e.id.clone(),
                at: pt(&e.id)?,
                construction: e.construction,
            });
            points.insert(e.id.clone(), e.id.clone());
        }
    }
    // Fixed entities become fix constraints.
    for e in s.entities.iter().filter(|e| e.fixed) {
        exact = false;
        let entity = match e.geometry {
            Geometry::Point { .. } => points[&e.id].clone(),
            _ => e.id.clone(),
        };
        match e.geometry {
            Geometry::Arc { .. } => {
                // An arc is fixed through its three points.
                for which in ["start", "end", "center"] {
                    lift_constraints.push(Constraint::Fix {
                        id: format!("lift_f{}", lift_constraints.len()),
                        entity: format!("{}.{which}", e.id),
                        x: None,
                        y: None,
                    });
                }
            }
            _ => lift_constraints.push(Constraint::Fix {
                id: format!("lift_f{}", lift_constraints.len()),
                entity,
                x: None,
                y: None,
            }),
        }
    }
    let map = |pid: &str| -> Result<String, LiftError> {
        points
            .get(pid)
            .cloned()
            .or_else(|| {
                s.entities
                    .iter()
                    .any(|e| e.id == pid && !matches!(e.geometry, Geometry::Point { .. }))
                    .then(|| pid.to_string())
            })
            .ok_or_else(|| LiftError::BadReference(pid.to_string()))
    };
    let mut constraints = lift_constraints;
    for c in &s.constraints {
        valid(&c.id)?;
        let id = c.id.clone();
        let value = |v: f64| {
            if c.driving {
                Some(Scalar::Num(v))
            } else {
                None
            }
        };
        let driving = c.driving;
        constraints.push(match &c.kind {
            K::Coincident { a, b } => Constraint::Coincident {
                id,
                a: map(a)?,
                b: map(b)?,
            },
            K::Horizontal { line } => Constraint::Horizontal {
                id,
                line: map(line)?,
            },
            K::Vertical { line } => Constraint::Vertical {
                id,
                line: map(line)?,
            },
            K::Parallel { a, b } => Constraint::Parallel {
                id,
                a: map(a)?,
                b: map(b)?,
            },
            K::Perpendicular { a, b } => Constraint::Perpendicular {
                id,
                a: map(a)?,
                b: map(b)?,
            },
            K::Tangent { a, b, internal } => Constraint::Tangent {
                id,
                a: map(a)?,
                b: map(b)?,
                internal: *internal,
            },
            K::Equal { a, b } => Constraint::Equal {
                id,
                a: map(a)?,
                b: map(b)?,
            },
            K::Distance { a, b, value: v } => Constraint::Distance {
                id,
                a: map(a)?,
                b: map(b)?,
                value: value(*v),
                driving,
            },
            K::Angle { a, b, value: v } => Constraint::Angle {
                id,
                a: map(a)?,
                b: map(b)?,
                value: value(*v),
                driving,
            },
            K::Radius { curve, value: v } => Constraint::Radius {
                id,
                curve: map(curve)?,
                value: value(*v),
                driving,
            },
            K::Diameter { curve, value: v } => Constraint::Diameter {
                id,
                curve: map(curve)?,
                value: value(*v),
                driving,
            },
            K::PointOnLine { point, line } => Constraint::PointOnLine {
                id,
                point: map(point)?,
                line: map(line)?,
            },
            K::PointOnCircle { point, curve } => Constraint::PointOnCircle {
                id,
                point: map(point)?,
                curve: map(curve)?,
            },
            K::Midpoint { point, line } => Constraint::Midpoint {
                id,
                point: map(point)?,
                line: map(line)?,
            },
            K::Symmetric { a, b, line } => Constraint::Symmetric {
                id,
                a: map(a)?,
                b: map(b)?,
                line: map(line)?,
            },
            K::Fix { entity, x, y } => Constraint::Fix {
                id,
                entity: map(entity)?,
                x: x.map(Scalar::Num),
                y: y.map(Scalar::Num),
            },
        });
    }
    let sketch = SketchFeature {
        id: id.to_string(),
        name: id.to_string(),
        v: 1,
        suppressed: BoolScalar::Bool(false),
        plane: PlaneRef::Named(forge_ir::NamedPlane::XY),
        curves,
        constraints,
        note: String::new(),
        intent: String::new(),
        author: String::new(),
        assumptions: Vec::new(),
        decision_ids: Vec::new(),
    };
    // Exact only if welding joins exactly the ends that share a forge-solve point.
    if exact && let Ok(stored) = stored_geometry(&sketch) {
        let w = Welding::compute(&stored);
        let mut shared: BTreeMap<String, &str> = BTreeMap::new();
        for pid in &order {
            for (ir, end) in &uses[pid] {
                if *end {
                    shared.insert(ir.clone(), pid);
                }
            }
        }
        for g in w.groups() {
            let owner = shared.get(&g.representative);
            if g.members.iter().any(|m| shared.get(m) != owner) {
                exact = false;
            }
        }
        for (ir, pid) in &shared {
            let rep = w.resolve(ir);
            if shared.get(rep) != Some(pid) {
                exact = false;
            }
        }
    }
    Ok(Lifted {
        sketch,
        exact,
        points,
    })
}
