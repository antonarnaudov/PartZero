//! References and queries (SPEC-v1 §5 [D-24]–[D-31]).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::planes::Dir;
use super::scalar::Scalar;
use crate::P3;

/// The kind of topological entity a reference designates.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Face,
    Edge,
    Vertex,
    Body,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Face => "face",
            EntityKind::Edge => "edge",
            EntityKind::Vertex => "vertex",
            EntityKind::Body => "body",
        }
    }
}

/// A reference (§5.1): a typed query plus a declared cardinality, with an optional capture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Ref {
    /// Must equal the static kind of `q` and be accepted by the field (`REF_KIND_MISMATCH`).
    pub kind: EntityKind,
    /// The query: the intent of the reference.
    pub q: Query,
    /// Declared cardinality (§5.5). Omitted means the field's default (canonical JSON omits
    /// a `card` equal to the field's default).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<Cardinality>,
    /// Snapshot of what the reference resolved to when it was last accepted (§5.6). Written
    /// only by the command layer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture: Option<Capture>,
}

/// Declared cardinality (§5.5): `one`, `some`, `any`, or an exact count `n ≥ 1`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Cardinality {
    Word(CardWord),
    Exactly(#[schemars(range(min = 1))] u32),
}

/// The named cardinalities.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum CardWord {
    /// Exactly 1 (0 → `REF_MISSING`, ≥ 2 → `REF_AMBIGUOUS` / `REF_SPLIT`).
    One,
    /// At least 1 (0 → `REF_MISSING`).
    Some,
    /// Any number, including 0.
    Any,
}

impl Cardinality {
    pub const ONE: Cardinality = Cardinality::Word(CardWord::One);
    pub const SOME: Cardinality = Cardinality::Word(CardWord::Some);
    pub const ANY: Cardinality = Cardinality::Word(CardWord::Any);
}

/// `start` / `end` of a sweep or of a curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum End {
    Start,
    End,
}

/// The faces a hole creates at one position (§5.2 rule 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HolePart {
    Wall,
    Tip,
    Floor,
    CboreWall,
    CboreFloor,
    Csink,
}

/// `max` / `min` of an `extreme` pick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Which {
    Max,
    Min,
}

/// An instance index of a pattern: `[i]` or `[i, j]` (two-direction linear patterns).
pub type InstanceIndex = Vec<u32>;

/// The query AST (§5.3). Kinds: **F** faces, **E** edges, **V** vertices, **B** bodies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Query {
    /// B, named: bodies whose origin feature is `feature` (with `member`: whose origin region's
    /// outer loop contains `member`), including every piece of a split.
    Body {
        feature: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        member: Option<String>,
    },
    /// B, broad: every body in scope.
    Bodies {},
    /// F, named: an extrude's cap faces.
    Cap {
        feature: String,
        end: End,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        member: Option<String>,
    },
    /// F, named: a revolve's end-cap faces.
    Endcap {
        feature: String,
        end: End,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        member: Option<String>,
    },
    /// F, named: faces keyed `F/side:curve` (all pieces).
    Side { feature: String, curve: String },
    /// F, broad: every side face of the feature.
    Sides {
        feature: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        member: Option<String>,
    },
    /// E, named: the junction edges swept from the sketch vertex at that curve end.
    EdgeAt {
        feature: String,
        curve: String,
        end: End,
    },
    /// E, named if `a` and `b` are both named: edges with one adjacent face in `a` and the
    /// other in `b`.
    Between { a: Box<Query>, b: Box<Query> },
    /// F, named: a face a hole created at position `at`.
    HoleFace {
        feature: String,
        at: String,
        part: HolePart,
    },
    /// F, broad: every face whose key has that feature id (and role label).
    Created {
        feature: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        role: Option<String>,
    },
    /// F, broad: every face of that pattern instance.
    Instance {
        feature: String,
        #[schemars(length(min = 1, max = 2))]
        index: InstanceIndex,
    },
    /// The tag's kind; the tag's query re-evaluated in the current scope (§6.12).
    Tagged { feature: String },
    /// B → faces of the bodies; E → the two adjacent faces; V → incident faces.
    Faces { of: Box<Query> },
    /// B → all edges; F → boundary edges; V → incident edges.
    Edges { of: Box<Query> },
    /// B, F, E → vertices.
    Vertices { of: Box<Query> },
    /// F, E, V → the bodies containing them.
    Owner { of: Box<Query> },
    /// Set union (operands of one kind).
    Union { of: Vec<Query> },
    /// Set intersection (operands of one kind).
    Intersect { of: Vec<Query> },
    /// Members of `a` not in `b`.
    Minus { a: Box<Query>, b: Box<Query> },
    /// Members satisfying the predicate.
    Filter {
        of: Box<Query>,
        #[serde(rename = "where")]
        #[schemars(rename = "where")]
        pred: Predicate,
    },
    /// Members whose centroid projected on `dir` is within `LINEAR_TOLERANCE·s` of the max (min).
    Extreme {
        of: Box<Query>,
        dir: Dir,
        which: Which,
    },
    /// Members of maximal size (area, length or volume).
    Largest { of: Box<Query> },
    /// Members of minimal size.
    Smallest { of: Box<Query> },
}

impl Query {
    /// The `op` tag.
    pub fn op(&self) -> &'static str {
        match self {
            Query::Body { .. } => "body",
            Query::Bodies {} => "bodies",
            Query::Cap { .. } => "cap",
            Query::Endcap { .. } => "endcap",
            Query::Side { .. } => "side",
            Query::Sides { .. } => "sides",
            Query::EdgeAt { .. } => "edge_at",
            Query::Between { .. } => "between",
            Query::HoleFace { .. } => "hole_face",
            Query::Created { .. } => "created",
            Query::Instance { .. } => "instance",
            Query::Tagged { .. } => "tagged",
            Query::Faces { .. } => "faces",
            Query::Edges { .. } => "edges",
            Query::Vertices { .. } => "vertices",
            Query::Owner { .. } => "owner",
            Query::Union { .. } => "union",
            Query::Intersect { .. } => "intersect",
            Query::Minus { .. } => "minus",
            Query::Filter { .. } => "filter",
            Query::Extreme { .. } => "extreme",
            Query::Largest { .. } => "largest",
            Query::Smallest { .. } => "smallest",
        }
    }
}

/// Canonical surface and curve types a `type` predicate can test (v0 §5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum GeomTypeName {
    /// F.
    Plane,
    /// F.
    Cylinder,
    /// F.
    Cone,
    /// F.
    Sphere,
    /// F.
    Torus,
    /// F or E.
    Bspline,
    /// E.
    Line,
    /// E.
    Circle,
    /// E.
    Ellipse,
}

impl GeomTypeName {
    pub fn as_str(self) -> &'static str {
        match self {
            GeomTypeName::Plane => "plane",
            GeomTypeName::Cylinder => "cylinder",
            GeomTypeName::Cone => "cone",
            GeomTypeName::Sphere => "sphere",
            GeomTypeName::Torus => "torus",
            GeomTypeName::Bspline => "bspline",
            GeomTypeName::Line => "line",
            GeomTypeName::Circle => "circle",
            GeomTypeName::Ellipse => "ellipse",
        }
    }
    /// Whether the type applies to entities of `kind`.
    pub fn applies_to(self, kind: EntityKind) -> bool {
        use GeomTypeName as T;
        match kind {
            EntityKind::Face => matches!(
                self,
                T::Plane | T::Cylinder | T::Cone | T::Sphere | T::Torus | T::Bspline
            ),
            EntityKind::Edge => matches!(self, T::Line | T::Circle | T::Ellipse | T::Bspline),
            _ => false,
        }
    }
}

/// One predicate of a `filter` (§5.3); all angle tests use `QUERY_ANGLE_TOLERANCE`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Predicate {
    /// F, E: the canonical type is `t`.
    Type(GeomTypeName),
    /// F: planar, outward normal equal to the **signed** direction.
    Normal(Dir),
    /// E: a line parallel to the direction (either sign). F: a plane whose normal is
    /// perpendicular to it, or a cylinder/cone whose axis is parallel to it.
    Parallel(Dir),
    /// E: a line perpendicular to it, or a circle whose normal is parallel to it. F: a plane
    /// whose normal is parallel to it (either sign).
    Perpendicular(Dir),
    /// E: material angle < 180° − tol. Must be `true`.
    Convex(bool),
    /// E: material angle > 180° + tol. Must be `true`.
    Concave(bool),
    /// E: material angle within tol of 180°. Must be `true`.
    Smooth(bool),
    /// F (cylinder, sphere; torus: minor radius), E (circle).
    Radius(RadiusBound),
}

/// `{ "eq": r }` or `{ "min"?: r, "max"?: r }` (lengths, inclusive).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RadiusBound {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eq: Option<Scalar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<Scalar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<Scalar>,
}

// ---- capture (§5.6) -------------------------------------------------------------------------

/// Snapshot of a reference's resolution (§5.6): one entry per member of the resolved set, in
/// canonical order. Canonical JSON, part of the feature's cache key, never shown in CadScript.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Capture {
    pub members: Vec<CaptureMember>,
}

/// Whether a member came from a named source or a broad one (§5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    Named,
    Broad,
}

/// One captured member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CaptureMember {
    /// Provenance key (§5.2), never containing `#index`.
    pub key: String,
    pub via: Via,
    /// Edge members: the keys of the two adjacent faces (naming recommendation 5), sorted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faces: Option<[String; 2]>,
    pub geom: Fingerprint,
}

/// The canonical type recorded in a fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FingerprintType {
    Plane,
    Cylinder,
    Cone,
    Sphere,
    Torus,
    Bspline,
    Line,
    Circle,
    Ellipse,
    /// A face or edge of another type.
    Other,
    /// A vertex member.
    Vertex,
    /// A body member.
    Body,
}

/// Fingerprint fields of a captured member (§5.6). Values are exact (not tessellated).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Fingerprint {
    #[serde(rename = "type")]
    #[schemars(rename = "type")]
    pub geom_type: FingerprintType,
    pub carrier: Carrier,
    /// The entity's bounding box `[min, max]`.
    pub bbox: [P3; 2],
    /// Area (faces), length (edges), volume (bodies), 0 (vertices).
    pub size: f64,
    /// World centroid (a vertex: its position).
    pub centroid: P3,
    /// The centroid normalised to the owning body's bounding box.
    pub local: P3,
    /// The owning body's bounding-box centre.
    pub body_center: P3,
    /// Adjacent entities on the same carrier (the split signature).
    pub neighbors: u32,
}

/// The exact carrier of a captured entity; axis directions are sign-canonical (§3.2), plane
/// normals outward. Angles in degrees ([W0-7]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Carrier {
    Plane {
        normal: P3,
        offset: f64,
    },
    Cylinder {
        axis: P3,
        point: P3,
        radius: f64,
    },
    Cone {
        axis: P3,
        apex: P3,
        half_angle: f64,
    },
    Sphere {
        center: P3,
        radius: f64,
    },
    Torus {
        axis: P3,
        center: P3,
        major: f64,
        minor: f64,
    },
    Line {
        direction: P3,
        point: P3,
    },
    Circle {
        normal: P3,
        center: P3,
        radius: f64,
    },
    /// Any other carrier (B-spline, vertex, body).
    Free,
}
