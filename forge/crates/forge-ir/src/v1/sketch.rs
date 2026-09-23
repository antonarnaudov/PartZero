//! Sketch curves and constraints (SPEC-v1 §4 [D-19]–[D-23]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::scalar::{SP2, Scalar, is_zero2};
use crate::P2;

fn is_false(b: &bool) -> bool {
    !*b
}
fn is_true(b: &bool) -> bool {
    *b
}
fn yes() -> bool {
    true
}

/// A sketch curve (§4.1). v0's `line`, `arc` and `circle` keep their fields with Scalars;
/// `point` is a sketch point; `rect`, `slot` and `polygon` are **compound** curves that expand
/// into member curves `<id>.<member>` (§4.1, [`super::compound`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SketchCurve {
    /// A line segment `start → end`.
    Line {
        id: String,
        start: SP2,
        end: SP2,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    /// A circular arc from `start` to `end` around `center`, counter-clockwise when `ccw`.
    Arc {
        id: String,
        start: SP2,
        end: SP2,
        center: SP2,
        ccw: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    /// A full circle.
    Circle {
        id: String,
        center: SP2,
        radius: Scalar,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    /// A sketch point: never part of a loop; used by constraints, hole placement and queries.
    Point {
        id: String,
        at: SP2,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    /// Compound: a rectangle with optional corner radius. Exactly one of `center` / `corner`
    /// (the lower-left corner).
    Rect {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        center: Option<SP2>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        corner: Option<SP2>,
        w: Scalar,
        h: Scalar,
        /// Corner radius, `0 ≤ r ≤ min(w, h)/2`.
        #[serde(default = "zero", skip_serializing_if = "Scalar::is_zero")]
        #[schemars(extend("default" = 0))]
        r: Scalar,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    /// Compound: a straight slot with round ends centred on `a` and `b`, width `w`.
    Slot {
        id: String,
        a: SP2,
        b: SP2,
        w: Scalar,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    /// Compound: a regular polygon with `n ≥ 3` sides. Exactly one of `circumradius`,
    /// `inradius`, `across_flats`, `side`.
    Polygon {
        id: String,
        center: SP2,
        /// A count.
        n: Scalar,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        circumradius: Option<Scalar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inradius: Option<Scalar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        across_flats: Option<Scalar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<Scalar>,
        /// Angle of vertex 0 from +u, degrees.
        #[serde(default = "zero", skip_serializing_if = "Scalar::is_zero")]
        #[schemars(extend("default" = 0))]
        rotation: Scalar,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
}

fn zero() -> Scalar {
    Scalar::Num(0.0)
}

impl SketchCurve {
    pub fn id(&self) -> &str {
        match self {
            SketchCurve::Line { id, .. }
            | SketchCurve::Arc { id, .. }
            | SketchCurve::Circle { id, .. }
            | SketchCurve::Point { id, .. }
            | SketchCurve::Rect { id, .. }
            | SketchCurve::Slot { id, .. }
            | SketchCurve::Polygon { id, .. } => id,
        }
    }
    /// The `kind` tag.
    pub fn kind(&self) -> &'static str {
        match self {
            SketchCurve::Line { .. } => "line",
            SketchCurve::Arc { .. } => "arc",
            SketchCurve::Circle { .. } => "circle",
            SketchCurve::Point { .. } => "point",
            SketchCurve::Rect { .. } => "rect",
            SketchCurve::Slot { .. } => "slot",
            SketchCurve::Polygon { .. } => "polygon",
        }
    }
    pub fn construction(&self) -> bool {
        match self {
            SketchCurve::Line { construction, .. }
            | SketchCurve::Arc { construction, .. }
            | SketchCurve::Circle { construction, .. }
            | SketchCurve::Point { construction, .. }
            | SketchCurve::Rect { construction, .. }
            | SketchCurve::Slot { construction, .. }
            | SketchCurve::Polygon { construction, .. } => *construction,
        }
    }
    /// `true` for `rect`, `slot` and `polygon`.
    pub fn is_compound(&self) -> bool {
        matches!(
            self,
            SketchCurve::Rect { .. } | SketchCurve::Slot { .. } | SketchCurve::Polygon { .. }
        )
    }
}

/// A rect's `center` default helper for canonical output of grids and bolt circles.
pub(crate) fn skip_zero2(p: &SP2) -> bool {
    is_zero2(p)
}

/// A constraint (§4.3). The 16 kinds, their `type` tags and argument names are exactly
/// forge-solve's (`forge-solve/src/model.rs`). Arguments are solver entity ids: `p`, `l`,
/// `l.start`, `l.end`, `a.center`, `c.center`, …; dimension `value`s are Scalars.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Constraint {
    /// Two points coincide.
    Coincident { id: String, a: String, b: String },
    /// A line is horizontal (relative to the sketch's u axis).
    Horizontal { id: String, line: String },
    /// A line is vertical (relative to the sketch's v axis).
    Vertical { id: String, line: String },
    /// Two lines are parallel (or anti-parallel).
    Parallel { id: String, a: String, b: String },
    /// Two lines are perpendicular.
    Perpendicular { id: String, a: String, b: String },
    /// Tangency: line–circle/arc, circle/arc–circle/arc.
    Tangent {
        id: String,
        a: String,
        b: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        internal: Option<bool>,
    },
    /// Equal length (two lines) or equal radius (two circles/arcs).
    Equal { id: String, a: String, b: String },
    /// Dimension (length): point–point, or point–(infinite) line when `b` is a line.
    Distance {
        id: String,
        a: String,
        b: String,
        /// Required when driving; forbidden on a reference dimension.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Scalar>,
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        #[schemars(extend("default" = true))]
        driving: bool,
    },
    /// Dimension (angle): counter-clockwise from line `a` (`p1 → p2`) to line `b`.
    Angle {
        id: String,
        a: String,
        b: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Scalar>,
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        #[schemars(extend("default" = true))]
        driving: bool,
    },
    /// Dimension (length): radius of a circle or arc.
    Radius {
        id: String,
        curve: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Scalar>,
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        #[schemars(extend("default" = true))]
        driving: bool,
    },
    /// Dimension (length): diameter of a circle or arc.
    Diameter {
        id: String,
        curve: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Scalar>,
        #[serde(default = "yes", skip_serializing_if = "is_true")]
        #[schemars(extend("default" = true))]
        driving: bool,
    },
    /// A point lies on the infinite line through `line`.
    PointOnLine {
        id: String,
        point: String,
        line: String,
    },
    /// A point lies on a circle, or on the full circle of an arc.
    PointOnCircle {
        id: String,
        point: String,
        curve: String,
    },
    /// A point is the midpoint of a line.
    Midpoint {
        id: String,
        point: String,
        line: String,
    },
    /// Points `a` and `b` are mirror images about `line`.
    Symmetric {
        id: String,
        a: String,
        b: String,
        line: String,
    },
    /// Pin a point (optionally at `x`, `y`), a line or a circle where it is.
    Fix {
        id: String,
        entity: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<Scalar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<Scalar>,
    },
}

/// The dimension constraint types (those that carry `value` and `driving`).
pub const DIMENSION_TYPES: [&str; 4] = ["distance", "angle", "radius", "diameter"];
/// Every constraint `type`, in forge-solve's declaration order.
pub const CONSTRAINT_TYPES: [&str; 16] = [
    "coincident",
    "horizontal",
    "vertical",
    "parallel",
    "perpendicular",
    "tangent",
    "equal",
    "distance",
    "angle",
    "radius",
    "diameter",
    "point_on_line",
    "point_on_circle",
    "midpoint",
    "symmetric",
    "fix",
];

impl Constraint {
    pub fn id(&self) -> &str {
        use Constraint as C;
        match self {
            C::Coincident { id, .. }
            | C::Horizontal { id, .. }
            | C::Vertical { id, .. }
            | C::Parallel { id, .. }
            | C::Perpendicular { id, .. }
            | C::Tangent { id, .. }
            | C::Equal { id, .. }
            | C::Distance { id, .. }
            | C::Angle { id, .. }
            | C::Radius { id, .. }
            | C::Diameter { id, .. }
            | C::PointOnLine { id, .. }
            | C::PointOnCircle { id, .. }
            | C::Midpoint { id, .. }
            | C::Symmetric { id, .. }
            | C::Fix { id, .. } => id,
        }
    }
    /// The `type` tag (forge-solve's `ConstraintKind::type_name`).
    pub fn type_name(&self) -> &'static str {
        use Constraint as C;
        match self {
            C::Coincident { .. } => "coincident",
            C::Horizontal { .. } => "horizontal",
            C::Vertical { .. } => "vertical",
            C::Parallel { .. } => "parallel",
            C::Perpendicular { .. } => "perpendicular",
            C::Tangent { .. } => "tangent",
            C::Equal { .. } => "equal",
            C::Distance { .. } => "distance",
            C::Angle { .. } => "angle",
            C::Radius { .. } => "radius",
            C::Diameter { .. } => "diameter",
            C::PointOnLine { .. } => "point_on_line",
            C::PointOnCircle { .. } => "point_on_circle",
            C::Midpoint { .. } => "midpoint",
            C::Symmetric { .. } => "symmetric",
            C::Fix { .. } => "fix",
        }
    }
    /// For dimensions: `(value, driving)`.
    pub fn dimension(&self) -> Option<(Option<&Scalar>, bool)> {
        use Constraint as C;
        match self {
            C::Distance { value, driving, .. }
            | C::Angle { value, driving, .. }
            | C::Radius { value, driving, .. }
            | C::Diameter { value, driving, .. } => Some((value.as_ref(), *driving)),
            _ => None,
        }
    }
    /// The entity arguments, as `(argument name, entity id)` in argument order.
    pub fn arguments(&self) -> Vec<(&'static str, &str)> {
        use Constraint as C;
        match self {
            C::Coincident { a, b, .. }
            | C::Parallel { a, b, .. }
            | C::Perpendicular { a, b, .. }
            | C::Tangent { a, b, .. }
            | C::Equal { a, b, .. }
            | C::Distance { a, b, .. }
            | C::Angle { a, b, .. } => vec![("a", a), ("b", b)],
            C::Horizontal { line, .. } | C::Vertical { line, .. } => vec![("line", line)],
            C::Radius { curve, .. } | C::Diameter { curve, .. } => vec![("curve", curve)],
            C::PointOnLine { point, line, .. } | C::Midpoint { point, line, .. } => {
                vec![("point", point), ("line", line)]
            }
            C::PointOnCircle { point, curve, .. } => vec![("point", point), ("curve", curve)],
            C::Symmetric { a, b, line, .. } => vec![("a", a), ("b", b), ("line", line)],
            C::Fix { entity, .. } => vec![("entity", entity)],
        }
    }
}

/// A curve with literal geometry: the members of an expanded compound curve (§4.1) and the
/// `solved` geometry of a sketch report (§4.4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum LiteralCurve {
    Line {
        id: String,
        start: P2,
        end: P2,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    Arc {
        id: String,
        start: P2,
        end: P2,
        center: P2,
        ccw: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    Circle {
        id: String,
        center: P2,
        radius: f64,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
    Point {
        id: String,
        at: P2,
        #[serde(default, skip_serializing_if = "is_false")]
        #[schemars(extend("default" = false))]
        construction: bool,
    },
}

impl LiteralCurve {
    pub fn id(&self) -> &str {
        match self {
            LiteralCurve::Line { id, .. }
            | LiteralCurve::Arc { id, .. }
            | LiteralCurve::Circle { id, .. }
            | LiteralCurve::Point { id, .. } => id,
        }
    }
}
