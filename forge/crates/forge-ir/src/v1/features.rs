//! Features (SPEC-v1 §6). Every feature has the common fields of §6.0.1 [D-34]:
//! `id`, `name`, `type`, `v` (behavior version, default 1), `suppressed` (default false) and the
//! non-semantic metadata `note`, `intent`, `author`, `assumptions`, `decision_ids`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::planes::{AxisRef, Dir, PlaneRef, PointRef, SketchAxis};
use super::refs::{InstanceIndex, Ref};
use super::scalar::{BoolScalar, SP2, SP3, Scalar, zero2};
use super::sketch::{Constraint, SketchCurve, skip_zero2};
use crate::SweepDirection;

fn one() -> u32 {
    1
}
fn is_one(v: &u32) -> bool {
    *v == 1
}
fn is_default<T: Default + PartialEq>(v: &T) -> bool {
    *v == T::default()
}

/// Declares a feature struct with the common fields of §6.0.1 around its specific fields.
macro_rules! feature_struct {
    (
        $(#[$meta:meta])*
        $name:ident { $($(#[$fmeta:meta])* $field:ident : $ty:ty),* $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
        #[serde(deny_unknown_fields)]
        pub struct $name {
            /// Non-empty, unique across the document (`INVALID_ID`, `DUPLICATE_ID`).
            pub id: String,
            /// The CadScript `const` name; shares one namespace with parameters (§0.3).
            pub name: String,
            /// Behavior version (§0.2): a feature type's semantics never change for a given `v`.
            #[serde(default = "one", skip_serializing_if = "is_one")]
            #[schemars(extend("default" = 1), range(min = 1))]
            pub v: u32,
            /// Suppressed features are skipped and produce no report entry. Accepts a Bool
            /// expression ([W0-3]).
            #[serde(default = "BoolScalar::r#false", skip_serializing_if = "BoolScalar::is_false")]
            #[schemars(extend("default" = false))]
            pub suppressed: BoolScalar,
            $($(#[$fmeta])* pub $field: $ty,)*
            /// Not semantic (§6.0.1).
            #[serde(default, skip_serializing_if = "String::is_empty")]
            #[schemars(extend("default" = ""))]
            pub note: String,
            /// Not semantic (§6.0.1).
            #[serde(default, skip_serializing_if = "String::is_empty")]
            #[schemars(extend("default" = ""))]
            pub intent: String,
            /// Not semantic (§6.0.1).
            #[serde(default, skip_serializing_if = "String::is_empty")]
            #[schemars(extend("default" = ""))]
            pub author: String,
            /// Not semantic (§6.0.1).
            #[serde(default, skip_serializing_if = "Vec::is_empty")]
            #[schemars(extend("default" = []))]
            pub assumptions: Vec<String>,
            /// Not semantic (§6.0.1).
            #[serde(default, skip_serializing_if = "Vec::is_empty")]
            #[schemars(extend("default" = []))]
            pub decision_ids: Vec<String>,
        }
    };
}

/// A feature in the timeline. `type` selects the variant.
// Plain data mirrored 1:1 by the JSON Schema; boxing variants would only add friction.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Feature {
    Sketch(SketchFeature),
    Extrude(ExtrudeFeature),
    Revolve(RevolveFeature),
    Boolean(BooleanFeature),
    Hole(HoleFeature),
    Fillet(FilletFeature),
    Chamfer(ChamferFeature),
    Shell(ShellFeature),
    Draft(DraftFeature),
    Pattern(PatternFeature),
    DatumPlane(DatumPlaneFeature),
    DatumAxis(DatumAxisFeature),
    Tag(TagFeature),
    Thread(ThreadFeature),
}

/// Every feature `type` of IR v1, in declaration order.
pub const FEATURE_TYPES: [&str; 14] = [
    "sketch",
    "extrude",
    "revolve",
    "boolean",
    "hole",
    "fillet",
    "chamfer",
    "shell",
    "draft",
    "pattern",
    "datum_plane",
    "datum_axis",
    "tag",
    "thread",
];

/// The behavior versions this revision of the contract defines, per feature type (§0.2).
pub fn defined_versions(feature_type: &str) -> &'static [u32] {
    if FEATURE_TYPES.contains(&feature_type) {
        &[1]
    } else {
        &[]
    }
}

macro_rules! each_feature {
    ($self:expr, $f:ident => $e:expr) => {
        match $self {
            Feature::Sketch($f) => $e,
            Feature::Extrude($f) => $e,
            Feature::Revolve($f) => $e,
            Feature::Boolean($f) => $e,
            Feature::Hole($f) => $e,
            Feature::Fillet($f) => $e,
            Feature::Chamfer($f) => $e,
            Feature::Shell($f) => $e,
            Feature::Draft($f) => $e,
            Feature::Pattern($f) => $e,
            Feature::DatumPlane($f) => $e,
            Feature::DatumAxis($f) => $e,
            Feature::Tag($f) => $e,
            Feature::Thread($f) => $e,
        }
    };
}

impl Feature {
    pub fn id(&self) -> &str {
        each_feature!(self, f => &f.id)
    }
    pub fn name(&self) -> &str {
        each_feature!(self, f => &f.name)
    }
    pub fn v(&self) -> u32 {
        each_feature!(self, f => f.v)
    }
    pub fn suppressed(&self) -> &BoolScalar {
        each_feature!(self, f => &f.suppressed)
    }
    pub fn type_name(&self) -> &'static str {
        match self {
            Feature::Sketch(_) => "sketch",
            Feature::Extrude(_) => "extrude",
            Feature::Revolve(_) => "revolve",
            Feature::Boolean(_) => "boolean",
            Feature::Hole(_) => "hole",
            Feature::Fillet(_) => "fillet",
            Feature::Chamfer(_) => "chamfer",
            Feature::Shell(_) => "shell",
            Feature::Draft(_) => "draft",
            Feature::Pattern(_) => "pattern",
            Feature::DatumPlane(_) => "datum_plane",
            Feature::DatumAxis(_) => "datum_axis",
            Feature::Tag(_) => "tag",
            Feature::Thread(_) => "thread",
        }
    }
}

// ---- sketch ---------------------------------------------------------------------------------

feature_struct! {
    /// A 2D sketch (§4). **Explicit** mode when `constraints` is empty (Scalars and compound
    /// curves allowed); **constrained** mode otherwise (literal geometry only, solved by
    /// forge-solve).
    SketchFeature {
        plane: PlaneRef,
        curves: Vec<SketchCurve>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[schemars(extend("default" = []))]
        constraints: Vec<Constraint>,
    }
}

// ---- extrude / revolve ----------------------------------------------------------------------

/// `"all"`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AllKeyword {
    #[default]
    All,
}

/// Which regions of the consumed sketch a body feature uses (§4.5): `"all"`, or the curve ids
/// whose region's outer loop contains them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum RegionSelection {
    All(AllKeyword),
    Curves(Vec<String>),
}

impl Default for RegionSelection {
    fn default() -> Self {
        RegionSelection::All(AllKeyword::All)
    }
}

/// What a body feature does with its tools (§6.0.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BodyOp {
    #[default]
    NewBody,
    Join,
    Cut,
    Intersect,
}

/// Target bodies of a body operation (§6.0.2): `"all"` or a Ref (body, default `some`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Targets {
    All(AllKeyword),
    Ref(Ref),
}

feature_struct! {
    /// Extrude (§6.2 [D-39]).
    ExtrudeFeature {
        /// Id of an earlier sketch of the same part (`UNRESOLVED_SKETCH`).
        sketch: String,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "all"))]
        regions: RegionSelection,
        /// Length, > tol (`INVALID_DISTANCE`).
        distance: Scalar,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "normal"))]
        direction: SweepDirection,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "new_body"))]
        op: BodyOp,
        /// Required when `op ≠ new_body` (`BOOLEAN_TARGETS_REQUIRED`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        targets: Option<Targets>,
    }
}

feature_struct! {
    /// Revolve (§6.3 [D-40]): v0 §4.3 plus `regions`, `op` and `targets`.
    RevolveFeature {
        sketch: String,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "all"))]
        regions: RegionSelection,
        /// In sketch coordinates.
        axis: SketchAxis,
        /// Angle in (0, 360] (`INVALID_ANGLE`).
        angle: Scalar,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "normal"))]
        direction: SweepDirection,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "new_body"))]
        op: BodyOp,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        targets: Option<Targets>,
    }
}

// ---- boolean --------------------------------------------------------------------------------

/// The operation of a standalone `boolean` (§6.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum BooleanOp {
    Join,
    Cut,
    Intersect,
}

feature_struct! {
    /// Boolean (§6.4 [D-41]).
    BooleanFeature {
        op: BooleanOp,
        /// Body, default `some`.
        targets: Ref,
        /// Body, default `some`.
        tools: Ref,
        #[serde(default = "BoolScalar::r#false", skip_serializing_if = "BoolScalar::is_false")]
        #[schemars(extend("default" = false))]
        keep_tools: BoolScalar,
    }
}

// ---- hole -----------------------------------------------------------------------------------

/// Standard metric sizes of the `HOLE_SIZES` table (§6.5).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, JsonSchema,
)]
pub enum HoleSize {
    M2,
    #[serde(rename = "M2.5")]
    M2_5,
    M3,
    M4,
    M5,
    M6,
    M8,
}

impl HoleSize {
    pub const ALL: [HoleSize; 7] = [
        HoleSize::M2,
        HoleSize::M2_5,
        HoleSize::M3,
        HoleSize::M4,
        HoleSize::M5,
        HoleSize::M6,
        HoleSize::M8,
    ];
    pub fn as_str(self) -> &'static str {
        match self {
            HoleSize::M2 => "M2",
            HoleSize::M2_5 => "M2.5",
            HoleSize::M3 => "M3",
            HoleSize::M4 => "M4",
            HoleSize::M5 => "M5",
            HoleSize::M6 => "M6",
            HoleSize::M8 => "M8",
        }
    }
    pub fn parse(s: &str) -> Option<HoleSize> {
        HoleSize::ALL.into_iter().find(|h| h.as_str() == s)
    }
}

/// Which table diameter a hole uses (§6.5).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HoleFit {
    /// ISO 273 fine clearance.
    Close,
    /// ISO 273 medium clearance.
    #[default]
    Normal,
    /// ISO 273 coarse clearance.
    Loose,
    /// Tap drill.
    Tap,
}

/// Where the holes go (§6.5): exactly one placement form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum HolePlacement {
    /// Sketch points (`point` curves or `<circle>.center`); ids are the point ids.
    Points(PointsPlacement),
    /// (u, v) positions in the placement plane's frame.
    List(Vec<HolePosition>),
    /// A centred grid; ids `g<i>_<j>`.
    Grid(GridPlacement),
    /// A bolt circle; ids `c<k>`.
    Circle(CirclePlacement),
}

/// `{ "sketch": "<id>", "ids": [...] | "all" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PointsPlacement {
    pub sketch: String,
    pub ids: PointIds,
}

/// A list of sketch point ids, or `"all"` (every `point` curve of the sketch, in curve order).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum PointIds {
    All(AllKeyword),
    Ids(Vec<String>),
}

/// One listed position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct HolePosition {
    /// The position id (names the hole instance and its faces).
    pub id: String,
    pub at: SP2,
}

/// `{ "nx", "ny", "dx", "dy", "center" }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GridPlacement {
    /// Count ≥ 1.
    pub nx: Scalar,
    /// Count ≥ 1.
    pub ny: Scalar,
    pub dx: Scalar,
    pub dy: Scalar,
    #[serde(default = "zero2", skip_serializing_if = "skip_zero2")]
    #[schemars(extend("default" = [0, 0]))]
    pub center: SP2,
}

/// `{ "n", "d", "center", "start" }`: a bolt circle of diameter `d`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CirclePlacement {
    /// Count ≥ 1.
    pub n: Scalar,
    /// Bolt-circle diameter, > tol.
    pub d: Scalar,
    #[serde(default = "zero2", skip_serializing_if = "skip_zero2")]
    #[schemars(extend("default" = [0, 0]))]
    pub center: SP2,
    /// Angle of position `c0`.
    #[serde(default = "zero_scalar", skip_serializing_if = "Scalar::is_zero")]
    #[schemars(extend("default" = 0))]
    pub start: Scalar,
}

fn zero_scalar() -> Scalar {
    Scalar::Num(0.0)
}

/// Hole depth (§6.5): `"through"`, `{ "blind": length }` or `{ "up_to": Ref }` (face, `one`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum HoleDepth {
    Through,
    Blind(Scalar),
    UpTo(Ref),
}

/// `"flat"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FlatKeyword {
    Flat,
}

/// Drill-point angle of a blind hole, or `"flat"`. The keyword wins over an expression that
/// names a parameter `flat` ([W0-10]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum HoleTip {
    Flat(FlatKeyword),
    Angle(Scalar),
}

impl HoleTip {
    pub(crate) fn default_tip() -> Self {
        HoleTip::Angle(Scalar::Num(118.0))
    }
    pub(crate) fn is_default(&self) -> bool {
        matches!(self, HoleTip::Angle(s) if s.is_literal(118.0))
    }
}

/// `"iso4762"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum CboreKeyword {
    #[serde(rename = "iso4762")]
    Iso4762,
}

/// Counterbore: the ISO 4762 preset (`HOLE_SIZES`) or explicit `{ d, depth }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Counterbore {
    Preset(CboreKeyword),
    Custom(CustomCounterbore),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CustomCounterbore {
    pub d: Scalar,
    pub depth: Scalar,
}

/// `"iso10642"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum CsinkKeyword {
    #[serde(rename = "iso10642")]
    Iso10642,
}

/// Countersink: the ISO 10642 preset (90°) or explicit `{ d, angle }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Countersink {
    Preset(CsinkKeyword),
    Custom(CustomCountersink),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CustomCountersink {
    pub d: Scalar,
    /// Included angle, degrees.
    #[serde(default = "ninety", skip_serializing_if = "is_ninety")]
    #[schemars(extend("default" = 90))]
    pub angle: Scalar,
}

fn ninety() -> Scalar {
    Scalar::Num(90.0)
}
fn is_ninety(s: &Scalar) -> bool {
    s.is_literal(90.0)
}

/// `"std"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum InsertKeyword {
    Std,
}

/// Heat-set insert hole: the `std` preset (`HOLE_SIZES`) or explicit `{ d, depth }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Insert {
    Preset(InsertKeyword),
    Custom(CustomInsert),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CustomInsert {
    pub d: Scalar,
    pub depth: Scalar,
}

/// Thread: `true`, or `{ pitch?, depth?, standard?, modeled?, hand?, starts? }` (defaults: the
/// size's coarse pitch, the full hole depth, cosmetic, right hand, one start). `false` means no
/// thread. A **cosmetic** thread changes no geometry; a **modelled** one (`modeled: true`) cuts
/// the helical groove of the 60° basic profile into the hole's wall (§6.5, `THREAD_STANDARDS`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Thread {
    Flag(bool),
    Spec(ThreadSpec),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ThreadSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pitch: Option<Scalar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub depth: Option<Scalar>,
    /// A `THREAD_STANDARDS` designation (`M8`, `M14x1`, `1/2-20 UNF`): the major diameter and
    /// pitch of the thread (`pitch` still overrides). Without it the major diameter is the
    /// hole `size`'s nominal diameter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub standard: Option<String>,
    /// Cut the helical groove (true) or record a cosmetic thread only (false).
    #[serde(
        default = "BoolScalar::r#false",
        skip_serializing_if = "BoolScalar::is_false"
    )]
    #[schemars(extend("default" = false))]
    pub modeled: BoolScalar,
    #[serde(default, skip_serializing_if = "is_default")]
    #[schemars(extend("default" = "right"))]
    pub hand: ThreadHand,
    /// Number of starts (a count in `[1, 8]`, default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub starts: Option<Scalar>,
}

/// Thread handedness.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ThreadHand {
    #[default]
    Right,
    Left,
}

feature_struct! {
    /// Hole (§6.5 [D-42]).
    HoleFeature {
        /// The placement plane, usually `{ "face": Ref }` (face, `one`).
        on: PlaneRef,
        /// Reverses the drilling direction `d = −n`.
        #[serde(default = "BoolScalar::r#false", skip_serializing_if = "BoolScalar::is_false")]
        #[schemars(extend("default" = false))]
        flip: BoolScalar,
        at: HolePlacement,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        size: Option<HoleSize>,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "normal"))]
        fit: HoleFit,
        /// Overrides the table diameter. One of `d` and `size` is required.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        d: Option<Scalar>,
        /// Required, except with `insert` (whose preset sets a blind depth).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        depth: Option<HoleDepth>,
        /// Blind holes only.
        #[serde(default = "HoleTip::default_tip", skip_serializing_if = "HoleTip::is_default")]
        #[schemars(extend("default" = 118))]
        tip: HoleTip,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cbore: Option<Counterbore>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        csink: Option<Countersink>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        insert: Option<Insert>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        thread: Option<Thread>,
        /// Default: the body owning the `on` face; required when `on` is not a face.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        targets: Option<Targets>,
    }
}

// ---- thread ---------------------------------------------------------------------------------

feature_struct! {
    /// Thread (FM9 stretch, §6.13): a screw thread of the 60° basic profile on a cylindrical
    /// face — a bore gets a nut thread, a boss a bolt thread. `modeled` (default) cuts the
    /// exact helical groove; `false` records a cosmetic thread in the report only.
    ThreadFeature {
        /// The cylindrical face (face, `one`).
        face: Ref,
        /// A `THREAD_STANDARDS` designation (`M8`, `M14x1`, `1/2-20 UNF`). Required unless
        /// both `major` and `pitch` are given (`THREAD_SIZE_REQUIRED`).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        standard: Option<String>,
        /// Basic major diameter (overrides the standard's).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        major: Option<Scalar>,
        /// Pitch (overrides the standard's).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pitch: Option<Scalar>,
        /// Threaded length from the start end (default: the rest of the face).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        length: Option<Scalar>,
        /// Distance of the thread's start from the start end (default 0).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        offset: Option<Scalar>,
        /// Start from the other end of the face.
        #[serde(default = "BoolScalar::r#false", skip_serializing_if = "BoolScalar::is_false")]
        #[schemars(extend("default" = false))]
        flip: BoolScalar,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "right"))]
        hand: ThreadHand,
        /// Number of starts (a count in `[1, 8]`, default 1).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        starts: Option<Scalar>,
        /// Cut the helical groove (default) or record a cosmetic thread only.
        #[serde(default = "BoolScalar::r#true", skip_serializing_if = "BoolScalar::is_true")]
        #[schemars(extend("default" = true))]
        modeled: BoolScalar,
    }
}

// ---- fillet / chamfer / shell / draft -------------------------------------------------------

fn bool_true() -> BoolScalar {
    BoolScalar::r#true()
}

feature_struct! {
    /// Fillet (§6.6 [D-43]).
    FilletFeature {
        /// Edge, default `some`.
        edges: Ref,
        /// Length, > tol (`INVALID_RADIUS`).
        r: Scalar,
        #[serde(default = "bool_true", skip_serializing_if = "BoolScalar::is_true")]
        #[schemars(extend("default" = true))]
        tangent_chain: BoolScalar,
    }
}

feature_struct! {
    /// Chamfer (§6.7 [D-44]): exactly one of `{ d }`, `{ d, d2, side }`, `{ d, angle, side }`.
    ChamferFeature {
        /// Edge, default `some`.
        edges: Ref,
        d: Scalar,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        d2: Option<Scalar>,
        /// In (0, 90).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angle: Option<Scalar>,
        /// Face, `one`: the face `d` is measured on.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        side: Option<Ref>,
        #[serde(default = "bool_true", skip_serializing_if = "BoolScalar::is_true")]
        #[schemars(extend("default" = true))]
        tangent_chain: BoolScalar,
    }
}

/// Shell offset direction (§6.8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShellDirection {
    #[default]
    Inward,
    Outward,
}

feature_struct! {
    /// Shell (§6.8 [D-45]).
    ShellFeature {
        /// Body, `one`.
        body: Ref,
        /// Face, default `any`: faces removed.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        open: Option<Ref>,
        /// Length, > tol.
        thickness: Scalar,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "inward"))]
        direction: ShellDirection,
    }
}

/// Pull direction of a draft (§6.9).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PullDirection {
    #[default]
    Normal,
    Reverse,
}

feature_struct! {
    /// Draft (§6.9 [D-46]); optional in v1: engines without it reject `UNSUPPORTED_FEATURE`.
    DraftFeature {
        /// Face, default `some`.
        faces: Ref,
        neutral: PlaneRef,
        /// In (0, 45).
        angle: Scalar,
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "normal"))]
        pull: PullDirection,
    }
}

// ---- pattern --------------------------------------------------------------------------------

/// What a pattern copies (§6.10).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum PatternSeed {
    /// Earlier `extrude`, `revolve` or `hole` features of the same part.
    Features(Vec<String>),
    /// Bodies (body, default `some`), copied from the current state.
    Bodies(Ref),
}

/// How the instances are placed (§6.10).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum PatternLayout {
    Linear(LinearLayout),
    Circular(CircularLayout),
    Mirror(MirrorLayout),
}

/// Instances `(i, j)`, `i < count`, `j < count2`, translated by `i·spacing·u1 + j·spacing2·u2`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LinearLayout {
    pub dir: Dir,
    /// Count ≥ 1.
    pub count: Scalar,
    /// Length, `|spacing| > tol`.
    pub spacing: Scalar,
    /// Second direction; requires `spacing2`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dir2: Option<Dir>,
    /// Count ≥ 1 (default 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count2: Option<Scalar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing2: Option<Scalar>,
}

/// Instances `k = 1 … count−1` rotated by `k·Δ` about the axis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CircularLayout {
    pub axis: AxisRef,
    /// Count ≥ 2.
    pub count: Scalar,
    /// In (0, 360].
    #[serde(default = "three_sixty", skip_serializing_if = "is_three_sixty")]
    #[schemars(extend("default" = 360))]
    pub angle: Scalar,
}

fn three_sixty() -> Scalar {
    Scalar::Num(360.0)
}
fn is_three_sixty(s: &Scalar) -> bool {
    s.is_literal(360.0)
}

/// One instance (index 1): the reflection in `plane`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MirrorLayout {
    pub plane: PlaneRef,
}

/// A body-seed pattern's operation (§6.10).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum PatternOp {
    #[default]
    NewBody,
    Join,
}

feature_struct! {
    /// Pattern (§6.10 [D-47]).
    PatternFeature {
        seed: PatternSeed,
        layout: PatternLayout,
        /// Instance indices not created.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        #[schemars(extend("default" = []))]
        skip: Vec<InstanceIndex>,
        /// Body seeds only.
        #[serde(default, skip_serializing_if = "is_default")]
        #[schemars(extend("default" = "new_body"))]
        op: PatternOp,
        /// Body seeds with `op: join` only (required there).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        targets: Option<Targets>,
    }
}

// ---- datums and tags ------------------------------------------------------------------------

/// `datum_plane` modes (§3.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatumPlaneMode {
    /// `from`, `distance`.
    Offset,
    /// `from`, `axis`, `angle`.
    Angle,
    /// `a`, `b`.
    Midplane,
    /// `points` (three).
    Through,
    /// `origin`, `normal`, `x_dir`.
    Frame,
}

feature_struct! {
    /// Datum plane (§3.3 [D-17]); produces no body. The fields allowed and required depend on
    /// `mode` (`DATUM_OPTIONS_CONFLICT`, [W0-8]).
    DatumPlaneFeature {
        mode: DatumPlaneMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        from: Option<PlaneRef>,
        /// Length, any sign.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        distance: Option<Scalar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        axis: Option<AxisRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        angle: Option<Scalar>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        a: Option<PlaneRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        b: Option<PlaneRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        points: Option<[PointRef; 3]>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        origin: Option<SP3>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        normal: Option<SP3>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x_dir: Option<SP3>,
    }
}

/// `datum_axis` modes (§3.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum DatumAxisMode {
    /// `edge`.
    Edge,
    /// `face` (a cylinder or cone).
    Cylinder,
    /// `a`, `b` (planes).
    Planes,
    /// `points` (two).
    Points,
}

feature_struct! {
    /// Datum axis (§3.4 [D-18]). The fields allowed and required depend on `mode`
    /// (`DATUM_OPTIONS_CONFLICT`, [W0-8]).
    DatumAxisFeature {
        mode: DatumAxisMode,
        /// Edge, `one`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edge: Option<Ref>,
        /// Face, `one`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        face: Option<Ref>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        a: Option<PlaneRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        b: Option<PlaneRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        points: Option<[PointRef; 2]>,
        #[serde(default = "BoolScalar::r#false", skip_serializing_if = "BoolScalar::is_false")]
        #[schemars(extend("default" = false))]
        flip: BoolScalar,
    }
}

feature_struct! {
    /// Tag (§6.12 [D-48]): a stable, named handle for a selection; produces no geometry.
    TagFeature {
        /// Any kind; default card `some`.
        target: Ref,
    }
}
