//! Planes, axes, points and directions (SPEC-v1 §3 [D-15], [D-16]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::refs::Ref;
use super::scalar::{BoolScalar, SP2, SP3};
use crate::NamedPlane;

/// A plane reference (§3.1): a named plane, an explicit frame, the frame of a planar face, or
/// a `datum_plane` feature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PlaneRef {
    /// `"XY"`, `"XZ"`, `"YZ"` (v0 §2).
    Named(NamedPlane),
    /// An explicit right-handed frame (v0 §2); Scalars allowed.
    Frame(FramePlane),
    /// The face frame of a planar face (§3.1).
    Face(FacePlane),
    /// The frame of a `datum_plane` feature.
    Datum(DatumPlaneRef),
}

/// An explicit frame: `y = normal × x_dir` after re-orthogonalising `x_dir` (v0 [R-14]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FramePlane {
    /// Length components.
    pub origin: SP3,
    /// Direction (ratio components); non-zero.
    pub normal: SP3,
    /// Direction (ratio components); non-zero, perpendicular to `normal`.
    pub x_dir: SP3,
}

/// `{ "face": Ref }`: the face frame of §3.1 (kind `face`, card `one`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FacePlane {
    pub face: Ref,
    /// Projected onto the face plane; default: the world origin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<SP3>,
    /// Projected onto the face plane; default: the world axis least aligned with the normal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x_dir: Option<SP3>,
}

/// `{ "datum": "<feature id>" }`: the frame of an earlier `datum_plane` feature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatumPlaneRef {
    pub datum: String,
}

/// The world axes usable as an AxisRef (origin at the world origin, direction +X/+Y/+Z).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum AxisName {
    X,
    Y,
    Z,
}

/// An oriented line (§3.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AxisRef {
    /// `"X"`, `"Y"`, `"Z"`.
    Named(AxisName),
    /// An edge, cylinder, datum or explicit line.
    Object(AxisObject),
}

/// The object forms of an AxisRef; each may carry `flip`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum AxisObject {
    Edge(EdgeAxis),
    Cylinder(CylinderAxis),
    Datum(DatumAxisRef),
    Line(LineAxis),
}

impl AxisObject {
    pub fn flip(&self) -> &BoolScalar {
        match self {
            AxisObject::Edge(a) => &a.flip,
            AxisObject::Cylinder(a) => &a.flip,
            AxisObject::Datum(a) => &a.flip,
            AxisObject::Line(a) => &a.flip,
        }
    }
}

/// `{ "edge": Ref }` (edge, `one`): a line edge's line or a circular edge's axis, sign-canonical.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EdgeAxis {
    pub edge: Ref,
    #[serde(
        default = "BoolScalar::r#false",
        skip_serializing_if = "BoolScalar::is_false"
    )]
    #[schemars(extend("default" = false))]
    pub flip: BoolScalar,
}

/// `{ "cylinder": Ref }` (face, `one`): the axis of a cylindrical or conical face.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CylinderAxis {
    pub cylinder: Ref,
    #[serde(
        default = "BoolScalar::r#false",
        skip_serializing_if = "BoolScalar::is_false"
    )]
    #[schemars(extend("default" = false))]
    pub flip: BoolScalar,
}

/// `{ "datum": "<feature id>" }`: an earlier `datum_axis` feature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DatumAxisRef {
    pub datum: String,
    #[serde(
        default = "BoolScalar::r#false",
        skip_serializing_if = "BoolScalar::is_false"
    )]
    #[schemars(extend("default" = false))]
    pub flip: BoolScalar,
}

/// `{ "line": { "origin", "direction" } }`: an explicit line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LineAxis {
    pub line: AxisLine,
    #[serde(
        default = "BoolScalar::r#false",
        skip_serializing_if = "BoolScalar::is_false"
    )]
    #[schemars(extend("default" = false))]
    pub flip: BoolScalar,
}

/// An explicit line in model coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AxisLine {
    /// Length components.
    pub origin: SP3,
    /// Direction (ratio components); non-zero, normalised by the engine.
    pub direction: SP3,
}

/// A point (§3.2): a literal/expression `P3`, or a vertex.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PointRef {
    Point(SP3),
    Vertex(VertexPoint),
}

/// `{ "vertex": Ref }` (vertex, `one`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct VertexPoint {
    pub vertex: Ref,
}

/// Named directions (§3.2): signed `+X` … `-Z`, and unsigned `X`, `Y`, `Z` (parallel tests
/// ignore the sign; where a sign is needed they mean `+`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum DirName {
    #[serde(rename = "+X")]
    PosX,
    #[serde(rename = "-X")]
    NegX,
    #[serde(rename = "+Y")]
    PosY,
    #[serde(rename = "-Y")]
    NegY,
    #[serde(rename = "+Z")]
    PosZ,
    #[serde(rename = "-Z")]
    NegZ,
    X,
    Y,
    Z,
}

/// A direction (§3.2): a named direction, a vector (ratio components), or an AxisRef object
/// (its direction).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Dir {
    Name(DirName),
    Vector(SP3),
    Axis(Box<AxisObject>),
}

/// A revolve axis in the sketch's 2D coordinates (v0 §4.3; Scalars allowed).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SketchAxis {
    /// Length components.
    pub origin: SP2,
    /// Direction (ratio components); non-zero.
    pub direction: SP2,
}
