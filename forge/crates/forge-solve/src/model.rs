//! The sketch model: entities and constraints with stable string ids.
//!
//! This is the input contract of the solver (and, later, the constraint part of the IR).
//! It is plain data with serde: JSON in, JSON out.
//!
//! # Parameters
//! | Entity | Own parameters | Notes |
//! |---|---|---|
//! | `point` | `x`, `y` | the only carriers of position |
//! | `line` | — | two point references `p1 → p2` (the direction matters for `angle`) |
//! | `circle` | `radius` | center is a point reference |
//! | `arc` | — | center, start, end point references; counter-clockwise from start to end; radius is `|start − center|`; the built-in *arc rule* `|end − center| = |start − center|` is always enforced |
//!
//! `fixed: true` turns every parameter the entity depends on into a constant (a fixed
//! line fixes both of its points, a fixed circle its center and radius). The `fix`
//! *constraint* is different: it is an ordinary, removable constraint that can take part
//! in conflicts. `construction: true` is carried through untouched; it never changes
//! solving.
//!
//! # Units
//! Lengths in millimetres, angles in **degrees** (like the IR).

use serde::{Deserialize, Serialize};

fn is_false(b: &bool) -> bool {
    !*b
}
fn is_true(b: &bool) -> bool {
    *b
}
fn yes() -> bool {
    true
}

/// A 2D sketch: ordered entities and ordered constraints.
///
/// Order matters only for determinism and for *attribution*: when constraints are
/// dependent, the later ones are reported as the redundant ones, and a conflict suggests
/// removing its most recently added member.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Sketch {
    /// Geometry, in any order (references may point forward).
    #[serde(default)]
    pub entities: Vec<Entity>,
    /// Constraints, oldest first.
    #[serde(default)]
    pub constraints: Vec<Constraint>,
}

/// A sketch entity with a stable id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entity {
    /// Stable id, unique among all entities and constraints of the sketch.
    pub id: String,
    /// The geometry.
    #[serde(flatten)]
    pub geometry: Geometry,
    /// All parameters this entity depends on are constants.
    #[serde(default, skip_serializing_if = "is_false")]
    pub fixed: bool,
    /// Construction geometry (informational only).
    #[serde(default, skip_serializing_if = "is_false")]
    pub construction: bool,
}

/// Entity geometry (tagged by `type` in JSON).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Geometry {
    /// A point.
    Point {
        /// x coordinate (mm).
        x: f64,
        /// y coordinate (mm).
        y: f64,
    },
    /// A line segment from point `p1` to point `p2`.
    Line {
        /// Start point id.
        p1: String,
        /// End point id.
        p2: String,
    },
    /// A full circle.
    Circle {
        /// Center point id.
        center: String,
        /// Radius (mm), a parameter of the circle.
        radius: f64,
    },
    /// A circular arc, counter-clockwise from `start` to `end` around `center`.
    Arc {
        /// Center point id.
        center: String,
        /// Start point id (defines the radius).
        start: String,
        /// End point id (kept on the circle by the built-in arc rule).
        end: String,
    },
}

impl Geometry {
    /// The `type` tag used in JSON.
    pub fn type_name(&self) -> &'static str {
        match self {
            Geometry::Point { .. } => "point",
            Geometry::Line { .. } => "line",
            Geometry::Circle { .. } => "circle",
            Geometry::Arc { .. } => "arc",
        }
    }
}

/// A constraint with a stable id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Constraint {
    /// Stable id, unique among all entities and constraints of the sketch.
    pub id: String,
    /// What is constrained.
    #[serde(flatten)]
    pub kind: ConstraintKind,
    /// For dimensions only (`distance`, `angle`, `radius`, `diameter`): `false` makes it
    /// a *reference* (driven) dimension that is measured, never enforced.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub driving: bool,
}

/// Constraint kinds (tagged by `type` in JSON). Entity arguments are entity ids.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ConstraintKind {
    /// Two points coincide (2 equations).
    Coincident {
        /// A point.
        a: String,
        /// Another point.
        b: String,
    },
    /// A line is horizontal (`p1.y = p2.y`).
    Horizontal {
        /// The line.
        line: String,
    },
    /// A line is vertical (`p1.x = p2.x`).
    Vertical {
        /// The line.
        line: String,
    },
    /// Two lines are parallel (or anti-parallel).
    Parallel {
        /// A line.
        a: String,
        /// Another line.
        b: String,
    },
    /// Two lines are perpendicular.
    Perpendicular {
        /// A line.
        a: String,
        /// Another line.
        b: String,
    },
    /// Tangency: line–circle, line–arc, circle–circle, circle–arc or arc–arc.
    /// Line tangency is to the full underlying circle. Curve–curve tangency is external
    /// (`|c1 − c2| = r1 + r2`) or internal (`|c1 − c2| = |r1 − r2|`); when `internal` is
    /// omitted it is decided from the input geometry (internal iff the center distance
    /// is below the larger radius).
    Tangent {
        /// First entity.
        a: String,
        /// Second entity.
        b: String,
        /// Force internal (`true`) or external (`false`) curve–curve tangency.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        internal: Option<bool>,
    },
    /// Equal length (two lines) or equal radius (two circles/arcs).
    Equal {
        /// First entity.
        a: String,
        /// Second entity.
        b: String,
    },
    /// Dimension: distance point–point, or point–(infinite) line when `b` is a line.
    Distance {
        /// A point.
        a: String,
        /// A point or a line.
        b: String,
        /// Distance in mm (> 0).
        value: f64,
    },
    /// Dimension: signed angle in degrees, counter-clockwise from the direction of line
    /// `a` (`p1 → p2`) to the direction of line `b`.
    Angle {
        /// First line.
        a: String,
        /// Second line.
        b: String,
        /// Angle in degrees.
        value: f64,
    },
    /// Dimension: radius of a circle or arc.
    Radius {
        /// Circle or arc.
        curve: String,
        /// Radius in mm (> 0).
        value: f64,
    },
    /// Dimension: diameter of a circle or arc.
    Diameter {
        /// Circle or arc.
        curve: String,
        /// Diameter in mm (> 0).
        value: f64,
    },
    /// A point lies on the infinite line through `line`.
    PointOnLine {
        /// The point.
        point: String,
        /// The line.
        line: String,
    },
    /// A point lies on a circle, or on the full circle of an arc.
    PointOnCircle {
        /// The point.
        point: String,
        /// Circle or arc.
        curve: String,
    },
    /// A point is the midpoint of a line (2 equations).
    Midpoint {
        /// The point.
        point: String,
        /// The line.
        line: String,
    },
    /// Points `a` and `b` are mirror images about `line` (2 equations).
    Symmetric {
        /// A point.
        a: String,
        /// Its mirror point.
        b: String,
        /// The mirror line.
        line: String,
    },
    /// Pin an entity where it is: a point (2 equations; `x`/`y` override the target), a
    /// line (both endpoints, 4 equations) or a circle (center and radius, 3 equations).
    Fix {
        /// The entity.
        entity: String,
        /// Target x for a point (default: its input x).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        /// Target y for a point (default: its input y).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
}

impl ConstraintKind {
    /// The `type` tag used in JSON.
    pub fn type_name(&self) -> &'static str {
        match self {
            ConstraintKind::Coincident { .. } => "coincident",
            ConstraintKind::Horizontal { .. } => "horizontal",
            ConstraintKind::Vertical { .. } => "vertical",
            ConstraintKind::Parallel { .. } => "parallel",
            ConstraintKind::Perpendicular { .. } => "perpendicular",
            ConstraintKind::Tangent { .. } => "tangent",
            ConstraintKind::Equal { .. } => "equal",
            ConstraintKind::Distance { .. } => "distance",
            ConstraintKind::Angle { .. } => "angle",
            ConstraintKind::Radius { .. } => "radius",
            ConstraintKind::Diameter { .. } => "diameter",
            ConstraintKind::PointOnLine { .. } => "point_on_line",
            ConstraintKind::PointOnCircle { .. } => "point_on_circle",
            ConstraintKind::Midpoint { .. } => "midpoint",
            ConstraintKind::Symmetric { .. } => "symmetric",
            ConstraintKind::Fix { .. } => "fix",
        }
    }

    /// `true` for dimensions (the kinds that carry a value and may be non-driving).
    pub fn is_dimension(&self) -> bool {
        matches!(
            self,
            ConstraintKind::Distance { .. }
                | ConstraintKind::Angle { .. }
                | ConstraintKind::Radius { .. }
                | ConstraintKind::Diameter { .. }
        )
    }

    /// The entity ids this constraint references, in argument order.
    pub fn references(&self) -> Vec<&str> {
        match self {
            ConstraintKind::Coincident { a, b }
            | ConstraintKind::Parallel { a, b }
            | ConstraintKind::Perpendicular { a, b }
            | ConstraintKind::Tangent { a, b, .. }
            | ConstraintKind::Equal { a, b }
            | ConstraintKind::Distance { a, b, .. }
            | ConstraintKind::Angle { a, b, .. } => vec![a, b],
            ConstraintKind::Horizontal { line } | ConstraintKind::Vertical { line } => {
                vec![line]
            }
            ConstraintKind::Radius { curve, .. } | ConstraintKind::Diameter { curve, .. } => {
                vec![curve]
            }
            ConstraintKind::PointOnLine { point, line }
            | ConstraintKind::Midpoint { point, line } => vec![point, line],
            ConstraintKind::PointOnCircle { point, curve } => vec![point, curve],
            ConstraintKind::Symmetric { a, b, line } => vec![a, b, line],
            ConstraintKind::Fix { entity, .. } => vec![entity],
        }
    }
}

// ----- small builder helpers (used by generators, tests and examples) -------------------

impl Entity {
    /// A free point.
    pub fn point(id: impl Into<String>, x: f64, y: f64) -> Self {
        Self::new(id, Geometry::Point { x, y })
    }
    /// A line `p1 → p2`.
    pub fn line(id: impl Into<String>, p1: impl Into<String>, p2: impl Into<String>) -> Self {
        Self::new(
            id,
            Geometry::Line {
                p1: p1.into(),
                p2: p2.into(),
            },
        )
    }
    /// A circle.
    pub fn circle(id: impl Into<String>, center: impl Into<String>, radius: f64) -> Self {
        Self::new(
            id,
            Geometry::Circle {
                center: center.into(),
                radius,
            },
        )
    }
    /// An arc (counter-clockwise from `start` to `end`).
    pub fn arc(
        id: impl Into<String>,
        center: impl Into<String>,
        start: impl Into<String>,
        end: impl Into<String>,
    ) -> Self {
        Self::new(
            id,
            Geometry::Arc {
                center: center.into(),
                start: start.into(),
                end: end.into(),
            },
        )
    }
    /// An entity from its geometry.
    pub fn new(id: impl Into<String>, geometry: Geometry) -> Self {
        Self {
            id: id.into(),
            geometry,
            fixed: false,
            construction: false,
        }
    }
    /// Builder: mark fixed.
    pub fn fixed(mut self) -> Self {
        self.fixed = true;
        self
    }
    /// Builder: mark as construction geometry.
    pub fn construction(mut self) -> Self {
        self.construction = true;
        self
    }
}

impl Constraint {
    /// A driving constraint.
    pub fn new(id: impl Into<String>, kind: ConstraintKind) -> Self {
        Self {
            id: id.into(),
            kind,
            driving: true,
        }
    }
    /// Builder: make a dimension a reference (driven) dimension.
    pub fn reference(mut self) -> Self {
        self.driving = false;
        self
    }
}

/// Shorthand constructors for [`ConstraintKind`] (`c::distance("p0", "p1", 10.0)`).
pub mod c {
    use super::ConstraintKind as K;

    fn s(x: &str) -> String {
        x.to_owned()
    }
    /// Coincident points.
    pub fn coincident(a: &str, b: &str) -> K {
        K::Coincident { a: s(a), b: s(b) }
    }
    /// Horizontal line.
    pub fn horizontal(line: &str) -> K {
        K::Horizontal { line: s(line) }
    }
    /// Vertical line.
    pub fn vertical(line: &str) -> K {
        K::Vertical { line: s(line) }
    }
    /// Parallel lines.
    pub fn parallel(a: &str, b: &str) -> K {
        K::Parallel { a: s(a), b: s(b) }
    }
    /// Perpendicular lines.
    pub fn perpendicular(a: &str, b: &str) -> K {
        K::Perpendicular { a: s(a), b: s(b) }
    }
    /// Tangency (internal/external decided from the input geometry).
    pub fn tangent(a: &str, b: &str) -> K {
        K::Tangent {
            a: s(a),
            b: s(b),
            internal: None,
        }
    }
    /// Equal length / radius.
    pub fn equal(a: &str, b: &str) -> K {
        K::Equal { a: s(a), b: s(b) }
    }
    /// Distance point–point or point–line.
    pub fn distance(a: &str, b: &str, value: f64) -> K {
        K::Distance {
            a: s(a),
            b: s(b),
            value,
        }
    }
    /// Angle (degrees, counter-clockwise from `a` to `b`).
    pub fn angle(a: &str, b: &str, value: f64) -> K {
        K::Angle {
            a: s(a),
            b: s(b),
            value,
        }
    }
    /// Radius.
    pub fn radius(curve: &str, value: f64) -> K {
        K::Radius {
            curve: s(curve),
            value,
        }
    }
    /// Diameter.
    pub fn diameter(curve: &str, value: f64) -> K {
        K::Diameter {
            curve: s(curve),
            value,
        }
    }
    /// Point on line.
    pub fn point_on_line(point: &str, line: &str) -> K {
        K::PointOnLine {
            point: s(point),
            line: s(line),
        }
    }
    /// Point on circle/arc.
    pub fn point_on_circle(point: &str, curve: &str) -> K {
        K::PointOnCircle {
            point: s(point),
            curve: s(curve),
        }
    }
    /// Midpoint.
    pub fn midpoint(point: &str, line: &str) -> K {
        K::Midpoint {
            point: s(point),
            line: s(line),
        }
    }
    /// Symmetric about a line.
    pub fn symmetric(a: &str, b: &str, line: &str) -> K {
        K::Symmetric {
            a: s(a),
            b: s(b),
            line: s(line),
        }
    }
    /// Fix an entity where it is.
    pub fn fix(entity: &str) -> K {
        K::Fix {
            entity: s(entity),
            x: None,
            y: None,
        }
    }
}
