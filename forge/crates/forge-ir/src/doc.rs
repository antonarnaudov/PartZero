//! Document model types. See `SPEC.md` for the normative semantics.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// A 2D point or vector in sketch coordinates (millimetres).
pub type P2 = [f64; 2];
/// A 3D point or vector in model coordinates (millimetres).
pub type P3 = [f64; 3];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Document {
    /// Must equal [`crate::IR_SCHEMA`].
    pub schema: String,
    #[serde(default, skip_serializing_if = "Meta::is_empty")]
    #[schemars(extend("default" = {}))]
    pub meta: Meta,
    #[serde(default, skip_serializing_if = "Units::is_default")]
    #[schemars(extend("default" = { "length": "mm", "angle": "deg" }))]
    pub units: Units,
    pub parts: Vec<PartStudio>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Meta {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[schemars(extend("default" = ""))]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[schemars(extend("default" = ""))]
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Units {
    pub length: LengthUnit,
    pub angle: AngleUnit,
}

impl Meta {
    pub fn is_empty(&self) -> bool {
        self.name.is_empty() && self.description.is_empty()
    }
}

impl Units {
    pub fn is_default(&self) -> bool {
        *self == Units::default()
    }
}

impl Default for Units {
    fn default() -> Self {
        Self {
            length: LengthUnit::Mm,
            angle: AngleUnit::Deg,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum LengthUnit {
    Mm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AngleUnit {
    Deg,
}

/// An ordered feature timeline that produces a set of bodies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PartStudio {
    pub id: String,
    pub name: String,
    pub features: Vec<Feature>,
}

/// A feature in the timeline. `type` selects the variant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Feature {
    Sketch(SketchFeature),
    Extrude(ExtrudeFeature),
    Revolve(RevolveFeature),
}

impl Feature {
    pub fn id(&self) -> &str {
        match self {
            Feature::Sketch(f) => &f.id,
            Feature::Extrude(f) => &f.id,
            Feature::Revolve(f) => &f.id,
        }
    }
    pub fn name(&self) -> &str {
        match self {
            Feature::Sketch(f) => &f.name,
            Feature::Extrude(f) => &f.name,
            Feature::Revolve(f) => &f.name,
        }
    }
    pub fn suppressed(&self) -> bool {
        match self {
            Feature::Sketch(f) => f.suppressed,
            Feature::Extrude(f) => f.suppressed,
            Feature::Revolve(f) => f.suppressed,
        }
    }
    pub fn type_name(&self) -> &'static str {
        match self {
            Feature::Sketch(_) => "sketch",
            Feature::Extrude(_) => "extrude",
            Feature::Revolve(_) => "revolve",
        }
    }
}

/// A 2D sketch on a plane. Curves form closed loops; loops nest into regions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SketchFeature {
    pub id: String,
    /// Unique within the whole document; this is the CadScript `const` name.
    pub name: String,
    #[serde(default, skip_serializing_if = "is_false")]
    #[schemars(extend("default" = false))]
    pub suppressed: bool,
    pub plane: PlaneSpec,
    pub curves: Vec<SketchCurve>,
}

/// Sketch plane: a named datum plane or an explicit frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PlaneSpec {
    Named(NamedPlane),
    Frame(Frame),
}

/// Named datum planes. Frames (x axis, y axis, normal):
/// `XY` = (+X, +Y, +Z), `XZ` = (+X, +Z, −Y), `YZ` = (+Y, +Z, +X).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum NamedPlane {
    XY,
    XZ,
    YZ,
}

/// An explicit right-handed frame. `y = normal × x_dir`. Vectors need not be unit
/// length but must be non-zero and mutually perpendicular (tolerance: see SPEC.md).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub origin: P3,
    pub normal: P3,
    pub x_dir: P3,
}

impl PlaneSpec {
    /// Resolve to (origin, x axis, y axis, normal), all unit vectors except origin.
    pub fn resolve(&self) -> ([f64; 3], [f64; 3], [f64; 3], [f64; 3]) {
        match self {
            PlaneSpec::Named(NamedPlane::XY) => {
                ([0.0; 3], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
            }
            PlaneSpec::Named(NamedPlane::XZ) => {
                ([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0])
            }
            PlaneSpec::Named(NamedPlane::YZ) => {
                ([0.0; 3], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0])
            }
            PlaneSpec::Frame(f) => {
                // SPEC §2 [R-14]: re-orthogonalise x against the normal before y = n × x.
                let n = normalize(f.normal);
                let d = f.x_dir[0] * n[0] + f.x_dir[1] * n[1] + f.x_dir[2] * n[2];
                let x = normalize([
                    f.x_dir[0] - d * n[0],
                    f.x_dir[1] - d * n[1],
                    f.x_dir[2] - d * n[2],
                ]);
                let y = cross(n, x);
                (f.origin, x, y, n)
            }
        }
    }
}

/// A sketch curve. Every curve has an `id` unique within its sketch; ids are the
/// stable handles used for naming the faces and edges the curve generates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SketchCurve {
    Line {
        id: String,
        start: P2,
        end: P2,
    },
    /// Circular arc from `start` to `end` around `center`, counter-clockwise when
    /// `ccw` is true (viewed from the plane normal). |start−center| must equal
    /// |end−center| within the linear tolerance.
    Arc {
        id: String,
        start: P2,
        end: P2,
        center: P2,
        ccw: bool,
    },
    Circle {
        id: String,
        center: P2,
        radius: f64,
    },
}

impl SketchCurve {
    pub fn id(&self) -> &str {
        match self {
            SketchCurve::Line { id, .. }
            | SketchCurve::Arc { id, .. }
            | SketchCurve::Circle { id, .. } => id,
        }
    }
}

/// Which regions of the referenced sketch a feature consumes. v0: all regions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum RegionSelection {
    #[default]
    All,
}

/// What a body-creating feature does with its result. v0: always new bodies.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BodyOp {
    #[default]
    NewBody,
}

/// Direction of a sweep relative to the sketch normal (extrude) or the axis (revolve).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum SweepDirection {
    /// Along +normal (extrude) / right-hand rule about the axis (revolve).
    #[default]
    Normal,
    /// Along −normal / negative rotation.
    Reverse,
    /// Half of the extent on each side.
    Symmetric,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ExtrudeFeature {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "is_false")]
    #[schemars(extend("default" = false))]
    pub suppressed: bool,
    /// Name of an earlier sketch feature in the same part studio.
    pub sketch: String,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "all"))]
    pub regions: RegionSelection,
    /// Total extrusion distance in mm, > 0.
    pub distance: f64,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "normal"))]
    pub direction: SweepDirection,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "new_body"))]
    pub op: BodyOp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RevolveFeature {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "is_false")]
    #[schemars(extend("default" = false))]
    pub suppressed: bool,
    pub sketch: String,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "all"))]
    pub regions: RegionSelection,
    /// Revolution axis, given in the sketch's 2D coordinates.
    pub axis: SketchAxis,
    /// Total sweep angle in degrees, in (0, 360].
    pub angle: f64,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "normal"))]
    pub direction: SweepDirection,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "new_body"))]
    pub op: BodyOp,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SketchAxis {
    pub origin: P2,
    pub direction: P2,
}

fn is_false(b: &bool) -> bool {
    !*b
}

fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

pub(crate) fn normalize(v: [f64; 3]) -> [f64; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / len, v[1] / len, v[2] / len]
}

pub(crate) fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
