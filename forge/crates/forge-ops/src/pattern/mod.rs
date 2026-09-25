//! # Patterns (SPEC §6.10 [D-47], interface I4 `pattern_instances`)
//!
//! Linear, circular and mirror patterns of **feature seeds** (the tool bodies of earlier
//! `extrude`, `revolve` or `hole` features, as evaluated at the seed) and of **body seeds**
//! (copies of current bodies).
//!
//! # Instances ([`pattern_instances`])
//! | Layout | Instances (index) | Motion |
//! |---|---|---|
//! | linear | `[i]` for `i = 1 … count−1`; with `dir2`, `[i, j]` for `i < count`, `j < count2`, except `[0, 0]` | translation by `(i·spacing)·u1 + (j·spacing2)·u2` |
//! | circular | `[k]` for `k = 1 … count−1` | rotation by `k·Δ` degrees about the axis (right-hand rule), `Δ = 360/count` for a full turn, else `angle/(count − 1)`; sine and cosine by `forge_ir::v1::degtrig` (exact at multiples of 30° and 45°) |
//! | mirror | `[1]` | reflection in the plane |
//!
//! Instances are listed in lexicographic index order; `skip` removes instances (entries
//! outside the layout's range name no instance and are ignored: validation rejects them
//! when the counts are literals, SPEC [W0-16]; a parametric count may drop below them).
//!
//! # Copies and identity (SPEC §5.2)
//! Every entity of a copy is keyed `P/copy:{K}@q` ([`copy_provenance`]: a
//! `Role::Derived("copy")` provenance whose source is the key `K`), `P` the pattern id, `K`
//! the seed entity's key (verbatim, nested in braces) and `q` the instance (`i` or `i.j`),
//! e.g. `pt1/copy:{h1/wall@a}@2` or, for a pattern of a pattern,
//! `pt2/copy:{pt1/copy:{e1/side:r}@1}@3`. `K` comes from [`seed_keys`] (forge-ops' own
//! rendering: caps stamped with the seed body's member, edge and vertex sources as face keys)
//! unless the caller passes the keys it computed (forge-refs derives junction qualifiers that
//! forge-ops does not see). New bodies get the origin
//! `{ feature: P, member: the seed body's member, instance: q }`.
//!
//! # Hole seeds ([`SeedOp::Hole`] with [`SeedBody::hole`])
//! A hole seed's tools must come with their [`HoleToolInfo`] (`HoleOutcome::seed_bodies`),
//! and a hole tool is only ever applied as [`SeedOp::Hole`]: otherwise the checks below could
//! not run, and the pattern fails with `FORGE_PATTERN_HOLE_SEED_MISMATCH { seed, at, what }`
//! before anything is built.
//!
//! SPEC §6.10 copies the seed's tool bodies **as evaluated at the seed**, and §6.5 leaves the
//! length of a `through` tool unstated ("long enough to leave every target"; Forge sizes it
//! to the seed's targets). A moved copy can therefore end inside the pattern's targets (a
//! translation along the axis, a rotation or mirror that tilts it, thicker targets
//! re-resolved in the pattern's scope). Forge never returns that pocket: every copy of a
//! through tool whose far end does not clear the targets' boxes along its moved axis is
//! extended by a cylinder of the hole's radius from its far end past those boxes, and if
//! that extension meets the material left by the pattern (or the targets, when every
//! instance was skipped) the pattern fails with `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT`
//! `{ index, seed, at, length, reach }` (`reach`: how far the targets extend along the copy's
//! axis — a copy longer than that would leave them), for the first such instance in index
//! order, before any instance is skipped or the pattern declared failed. A copy whose
//! extension meets nothing gives exactly the result of an unbounded through tool. A copy of
//! the tool's `end` face that survives in the result is the same error (an invariant check).
//! The Contract stage decides whether such copies should be rebuilt instead (W5 contract
//! issue). Kept instances of hole seeds also get the hole's diagnostics, engine-prefixed
//! until the Contract stage rules on them (§8.2 does not compare them), per kept instance
//! and seed tool in that order:
//! `FORGE_PATTERN_HOLE_POSITION_MISSED { index, seed, at }` (a copied position whose tool
//! meets no target while another position of the same instance does: the instance is kept,
//! SPEC §6.10 skips only instances whose tools all miss), `FORGE_PATTERN_HOLE_TOP_INSIDE
//! { index, seed, at }` (the copy's top disc `H/top@p` survives: the moved placement point
//! lies inside the material, so the copy is closed at its top — only the far end of a
//! through copy is extended, SPEC §6.5 "from `P` along `d`"; W5 contract issue) and
//! `FORGE_PATTERN_HOLE_BREAKS_THROUGH { index, seed, at }` (a copied blind hole, by the
//! break-through test of [`crate::hole`], with the seed hole's faces and every copy of them
//! counting as the hole's faces: a copy's bottom that another copy removed or borders — two
//! copies that coincide, as when a multi-position seed is patterned at its own pitch — is
//! decided on that copy's cut of the targets alone, so a coincident copy never makes it
//! break through).
//!
//! # No instance
//! A layout with no non-seed instance (linear `count` 1, a parametric count that drops to 1,
//! or `skip` naming every instance) applies nothing: `Ok` with `op: None`, no skipped
//! instance, no warning — "every instance is skipped" is not read as vacuously true. The W7b
//! oracle (`patterns.py`) raises `PATTERN_ALL_INSTANCES_FAILED` there (also when `skip` leaves
//! no instance), so the feature's status differs between the engines: open W5 contract
//! question (SPEC §6.10 is silent); the W5 differential classifies the disagreement
//! `OPEN_CONTRACT`.
//!
//! # Limits
//! At most [`MAX_PATTERN_INSTANCES`] non-seed instances (`FORGE_PATTERN_TOO_MANY_INSTANCES`
//! `{ field, value, max }`, decided before any instance is built: the SPEC caps each count
//! at 2^31 only), at most [`MAX_PATTERN_COPIES`] moved copies per seed — kept instances ×
//! seed bodies, e.g. the positions of a hole seed (`FORGE_PATTERN_TOO_MANY_COPIES
//! { instances, seed_bodies, copies, max }`, decided in [`apply_seed`] before any copy is
//! built) — and instance positions must be finite (`INVALID_VALUE` at the spacing).
//!
//! # Applying a seed ([`apply_seed`])
//! - `new_body` seeds: every kept instance creates a moved copy of every seed body.
//! - Body-operation and hole seeds: the seed's operation is applied **once** with all
//!   instance tools together to the targets the caller re-resolved in the pattern's scope.
//!   An instance **whose tools meet no target** is skipped with the warning
//!   `PATTERN_INSTANCE_SKIPPED { index, code }` (`code`: what the operation raises for that
//!   instance alone — `BOOLEAN_NO_INTERSECTION`, `BOOLEAN_EMPTY_RESULT` for an intersect,
//!   `HOLE_MISSES_BODY` for a hole); when every instance is skipped the pattern fails with
//!   `PATTERN_ALL_INSTANCES_FAILED { instances }`. Misses are decided without guessing:
//!   1. an instance whose tools' tight boxes stay farther than `10·tol` from every target's
//!      box is a miss;
//!   2. join: when the combined join fails (with any error), the live instances are re-tested
//!      in index order ([`join_instance`]): the instance's tools joined alone, then — if that
//!      fails — each tool alone (detached: `BOOLEAN_NO_INTERSECTION`; meets: the join
//!      succeeds, or fails with `BOOLEAN_NON_MANIFOLD`, which a join assembles only from an
//!      overlap). An instance whose tools are all detached is skipped and the join re-run; the
//!      first instance (in index order) that meets through one tool but has another detached
//!      tool fails the pattern with `BOOLEAN_NO_INTERSECTION` naming that tool (SPEC [W0-39],
//!      applied per tool) — **before** the combined join's own failure (a
//!      `BOOLEAN_NON_MANIFOLD` of the met tools, say), the order of [`crate::hole`]: misses,
//!      then the operation's own failures (review 6, seed 313 #37). Only when no instance is
//!      skipped or mixed does the combined join's error stand;
//!   3. cut, intersect and hole: an instance is met when a face of the combined result (or a
//!      key merged away by §6.0.4) carries the key of one of its tools' faces (keys of this
//!      seed's copies only: an earlier seed of the same pattern leaves faces with the same
//!      qualifiers); any other instance is re-tested alone (a tool can be covered by another
//!      instance's tool, or swallow the whole target); a missing tool leaves the combined
//!      result unchanged, so the result stands. When the combined operation fails with
//!      another error than its miss code, every live instance is re-tested alone first (in
//!      index order): the missing ones are skipped and the operation re-run, and its error
//!      stands only when no instance misses.
//!
//! The combined operation's result is checked for tangent contacts (a copy lying along a
//! planar face of the result across its interior, which W4's own check misses when the line
//! crosses an inner loop of the face, or a copied drill point's apex within tol of such a
//! face: `crate::hole::tool_contact`): `BOOLEAN_NON_MANIFOLD`, as if the operation had failed,
//! before any instance is skipped (W5 differential case `regression_909_59`; W4 release
//! blocker).
//!
//! Every error is a [`PatternError`] with a stable code and structured details.

mod error;
mod motion;

use std::collections::{BTreeMap, BTreeSet};

use forge_core::linalg::{Mat3, Point3, Transform, Vec3};
use forge_core::topo::{Body, EdgeId, FaceId, KeyRoleArg, Provenance, Role, VertexId, parse_key};
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ir::v1::degtrig;
use forge_ir::v1::metrics::{BodyChange, HoleKind, Origin};

use crate::boolean::{
    BodyOp, BodyOpResult, BooleanError, OpBody, ResultBody, apply_body_op, apply_body_op_in_scope,
};
use crate::hole::{
    BottomState, Depth, HoleSpec, HoleToolInfo, Tip, ToolEnd, bottom_state, breaks_through_alone,
    hole_face_provenance, hole_tool, tangent_contact,
};

pub use error::{
    DetailValue, HoleCopyNote, PatternError, PatternErrorDetails, PatternNote, Skipped,
};
pub use motion::{Entity, Motion, move_body};

/// A linear layout, resolved (unit or any non-zero directions, numeric values).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinearLayout {
    /// First direction `u1` (normalized here).
    pub dir: Vec3,
    /// `count ≥ 1`.
    pub count: f64,
    /// `|spacing| > tol` (mm; negative spacing runs against `dir`).
    pub spacing: f64,
    /// Second direction `u2`, `count2 ≥ 1` and `spacing2` (instances `[i, j]`).
    pub second: Option<(Vec3, f64, f64)>,
}

/// A circular layout, resolved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CircularLayout {
    /// A point of the axis.
    pub origin: Point3,
    /// The axis direction (right-hand rule).
    pub axis: Vec3,
    /// `count ≥ 2`.
    pub count: f64,
    /// Total angle in `(0, 360]` degrees.
    pub angle: f64,
}

/// A mirror layout, resolved.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MirrorLayout {
    /// A point of the mirror plane.
    pub origin: Point3,
    /// The plane normal (any non-zero length).
    pub normal: Vec3,
}

/// A resolved pattern layout (SPEC §6.10).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Layout {
    /// `linear`.
    Linear(LinearLayout),
    /// `circular`.
    Circular(CircularLayout),
    /// `mirror`.
    Mirror(MirrorLayout),
}

/// One non-seed instance of a layout.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Instance {
    /// `[i]` (or `[i, j]` for two-direction linear layouts; index 0 in slot 1 then).
    index: [u32; 2],
    /// `1` or `2`.
    arity: u8,
    /// Where the copy goes.
    pub motion: Motion,
}

impl Instance {
    /// The instance index, `[i]` or `[i, j]`.
    pub fn index(&self) -> Vec<u32> {
        self.index[..usize::from(self.arity)].to_vec()
    }
    /// The key qualifier and origin instance: `"i"` or `"i.j"`.
    pub fn qualifier(&self) -> String {
        qualifier_of(&self.index())
    }
}

/// `"i"` or `"i.j"` for an instance index.
pub fn qualifier_of(index: &[u32]) -> String {
    index
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(".")
}

/// The most non-seed instances one layout may define (an engine limit; see the module docs).
pub const MAX_PATTERN_INSTANCES: u64 = 10_000;

/// The most moved copies (kept instances × seed bodies) one seed of a pattern may build (an
/// engine limit; see the module docs).
pub const MAX_PATTERN_COPIES: u64 = 10_000;

fn too_many(field: &str, n: u64) -> Result<(), PatternError> {
    if n > MAX_PATTERN_INSTANCES {
        return Err(PatternError::TooManyInstances {
            field: field.into(),
            value: n as f64,
            max: MAX_PATTERN_INSTANCES as f64,
        });
    }
    Ok(())
}

fn count_of(field: &str, v: f64, min: f64, expected: &'static str) -> Result<u32, PatternError> {
    // Exact comparison on purpose: counts are exact integers.
    #[allow(clippy::float_cmp)]
    let integral = v.is_finite() && v.trunc() == v;
    if !integral || v < min || v > f64::from(u32::MAX) {
        return Err(PatternError::InvalidCount {
            field: field.into(),
            value: v,
            expected,
        });
    }
    Ok(v as u32)
}

fn unit(field: &str, v: Vec3) -> Result<Vec3, PatternError> {
    v.normalize()
        .filter(|u| u.is_finite())
        .ok_or_else(|| PatternError::InvalidValue {
            field: field.into(),
            value: DetailValue::Num(v.norm()),
            expected: "a non-zero direction",
        })
}

/// The rotation by `deg` degrees about the line through `origin` along the unit `k`, with
/// the normative degree trigonometry.
fn rotation_deg(origin: Point3, k: Vec3, deg: f64) -> Result<Transform, PatternError> {
    let (s, c) = degtrig::sin_cos_deg(deg)
        .ok_or_else(|| PatternError::internal(format!("rotation angle {deg} is not finite")))?;
    let r = Mat3::rotation_from_sin_cos(k, s, c);
    Transform::try_from_parts(r, origin - r.mul_vec(origin), 1e-9)
        .ok_or_else(|| PatternError::internal("rotation matrix is not orthonormal"))
}

/// The number of non-seed instances a layout defines (before `skip`).
pub fn layout_instance_count(layout: &Layout) -> Result<u32, PatternError> {
    Ok(pattern_instances(layout, &[])?.len() as u32)
}

/// The non-seed instances of `layout` minus `skip`, in index order (see the module docs).
///
/// Errors: `INVALID_COUNT` (`count` < 1 linear, < 2 circular, `count2` < 1, or not an
/// integer), `INVALID_VALUE` (`|spacing| ≤ tol`, a zero direction or normal, a `skip` entry
/// of the wrong arity or naming the seed, a spacing whose instances overflow),
/// `INVALID_ANGLE` (circular `angle` outside `(0, 360]`), `FORGE_PATTERN_TOO_MANY_INSTANCES`
/// (more than [`MAX_PATTERN_INSTANCES`] non-seed instances). Field paths are relative to the
/// feature (`/layout/linear/count`).
pub fn pattern_instances(
    layout: &Layout,
    skip: &[Vec<u32>],
) -> Result<Vec<Instance>, PatternError> {
    let (arity, mut out): (u8, Vec<Instance>) = match layout {
        Layout::Linear(l) => {
            let n1 = count_of("/layout/linear/count", l.count, 1.0, "an integer >= 1")?;
            if !(l.spacing.is_finite() && l.spacing.abs() > LINEAR_TOLERANCE) {
                return Err(PatternError::InvalidValue {
                    field: "/layout/linear/spacing".into(),
                    value: DetailValue::Num(l.spacing),
                    expected: "|spacing| > 1e-6 mm",
                });
            }
            let u1 = unit("/layout/linear/dir", l.dir)?;
            let second = match l.second {
                None => None,
                Some((d2, c2, s2)) => {
                    let n2 = count_of("/layout/linear/count2", c2, 1.0, "an integer >= 1")?;
                    if !(s2.is_finite() && s2.abs() > LINEAR_TOLERANCE) {
                        return Err(PatternError::InvalidValue {
                            field: "/layout/linear/spacing2".into(),
                            value: DetailValue::Num(s2),
                            expected: "|spacing2| > 1e-6 mm",
                        });
                    }
                    Some((unit("/layout/linear/dir2", d2)?, n2, s2))
                }
            };
            let arity = if second.is_some() { 2 } else { 1 };
            let n2 = second.map_or(1, |s| s.1);
            too_many(
                if second.is_some() {
                    "/layout/linear"
                } else {
                    "/layout/linear/count"
                },
                u64::from(n1) * u64::from(n2) - 1,
            )?;
            let mut v = Vec::new();
            for i in 0..n1 {
                for j in 0..n2 {
                    if i == 0 && j == 0 {
                        continue;
                    }
                    let t1 = u1 * (f64::from(i) * l.spacing);
                    let mut t = t1;
                    if let Some((u2, _, s2)) = second {
                        t += u2 * (f64::from(j) * s2);
                    }
                    if !t.is_finite() {
                        let (field, value) = match second {
                            Some((_, _, s2)) if t1.is_finite() => ("/layout/linear/spacing2", s2),
                            _ => ("/layout/linear/spacing", l.spacing),
                        };
                        return Err(PatternError::InvalidValue {
                            field: field.into(),
                            value: DetailValue::Num(value),
                            expected: "a spacing giving finite instance positions",
                        });
                    }
                    v.push(Instance {
                        index: [i, j],
                        arity,
                        motion: Motion::Rigid(Transform::translation(t)),
                    });
                }
            }
            (arity, v)
        }
        Layout::Circular(c) => {
            let n = count_of("/layout/circular/count", c.count, 2.0, "an integer >= 2")?;
            if !(c.angle.is_finite() && c.angle > 0.0 && c.angle <= 360.0) {
                return Err(PatternError::InvalidAngle {
                    field: "/layout/circular/angle".into(),
                    value: c.angle,
                    expected: "in (0, 360] degrees",
                });
            }
            let k = unit("/layout/circular/axis", c.axis)?;
            if !c.origin.is_finite() {
                return Err(PatternError::InvalidValue {
                    field: "/layout/circular/axis".into(),
                    value: DetailValue::Num(c.origin.norm()),
                    expected: "an axis through a finite point",
                });
            }
            too_many("/layout/circular/count", u64::from(n) - 1)?;
            let delta = if c.angle >= 360.0 {
                360.0 / f64::from(n)
            } else {
                c.angle / f64::from(n - 1)
            };
            let mut v = Vec::new();
            for i in 1..n {
                v.push(Instance {
                    index: [i, 0],
                    arity: 1,
                    motion: Motion::Rigid(rotation_deg(c.origin, k, f64::from(i) * delta)?),
                });
            }
            (1, v)
        }
        Layout::Mirror(m) => {
            let motion = Motion::reflection(m.origin, m.normal).ok_or_else(|| {
                PatternError::InvalidValue {
                    field: "/layout/mirror/plane".into(),
                    value: DetailValue::Num(m.normal.norm()),
                    expected: "a plane with a non-zero normal",
                }
            })?;
            (
                1,
                vec![Instance {
                    index: [1, 0],
                    arity: 1,
                    motion,
                }],
            )
        }
    };
    let mut skipped: BTreeSet<Vec<u32>> = BTreeSet::new();
    for (k, s) in skip.iter().enumerate() {
        if s.len() != usize::from(arity) {
            return Err(PatternError::InvalidValue {
                field: format!("/skip/{k}"),
                value: DetailValue::Index(s.clone()),
                expected: if arity == 2 {
                    "an instance index [i, j]"
                } else {
                    "an instance index [i]"
                },
            });
        }
        if s.iter().all(|&x| x == 0) {
            return Err(PatternError::InvalidValue {
                field: format!("/skip/{k}"),
                value: DetailValue::Index(s.clone()),
                expected: "an index other than the seed's",
            });
        }
        skipped.insert(s.clone());
    }
    out.retain(|i| !skipped.contains(&i.index()));
    out.sort_by_key(Instance::index);
    Ok(out)
}

// ---- keys and copies ------------------------------------------------------------------------

/// SPEC §5.2 keys of a body's entities.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SeedKeys {
    /// Face keys.
    pub faces: BTreeMap<FaceId, String>,
    /// Edge keys.
    pub edges: BTreeMap<EdgeId, String>,
    /// Vertex keys.
    pub vertices: BTreeMap<VertexId, String>,
}

fn is_cap(role: &Role) -> bool {
    matches!(
        role,
        Role::CapStart | Role::CapEnd | Role::EndCapStart | Role::EndCapEnd
    )
}

/// The keys forge-ops renders for `body` with origin `origin` (the boolean's convention):
/// caps and end caps of the origin feature without a qualifier get the origin's member
/// (§5.2 rules 1 and 4); edge and vertex sources that are face display names become those
/// faces' keys (a name several faces with different keys share, or a source that already
/// is a key, is kept). Junction qualifiers (`@c.end`) appear only where the provenance
/// records them; forge-refs derives the others, so a caller that has its keys passes them to
/// [`copy_body`] instead.
pub fn seed_keys(body: &Body, origin: &Origin) -> SeedKeys {
    let stamp = |p: &Provenance| -> Provenance {
        if is_cap(&p.role) && p.qualifier.is_none() && p.feature == origin.feature {
            p.clone().with_qualifier(origin.member.clone())
        } else {
            p.clone()
        }
    };
    let mut keys = SeedKeys::default();
    let mut by_name: BTreeMap<String, Option<String>> = BTreeMap::new();
    for (fid, f) in body.faces().iter() {
        let p = stamp(&f.provenance);
        let k = p.key();
        match by_name.get_mut(&f.provenance.name()) {
            Some(slot) => {
                if slot.as_ref() != Some(&k) {
                    *slot = None;
                }
            }
            None => {
                by_name.insert(f.provenance.name(), Some(k.clone()));
            }
        }
        keys.faces.insert(fid, k);
    }
    let source_keys = |p: &Provenance| -> String {
        if matches!(p.role, Role::EdgeBetween | Role::VertexAt) {
            let s: Vec<String> = p
                .sources
                .iter()
                .map(|s| match by_name.get(s) {
                    Some(Some(k)) => k.clone(),
                    _ => s.clone(),
                })
                .collect();
            p.key_with_sources(&s)
        } else {
            p.key()
        }
    };
    for (eid, e) in body.edges().iter() {
        keys.edges.insert(eid, source_keys(&e.provenance));
    }
    for (vid, v) in body.vertices().iter() {
        keys.vertices.insert(vid, source_keys(&v.provenance));
    }
    keys
}

/// The provenance of the copy of the seed entity keyed `seed_key` in pattern `pattern`,
/// instance qualifier `qualifier` (SPEC §5.2: `P/copy:{K}@q`, a [`Role::Derived`] `copy`
/// whose one source is the seed key, rendered verbatim).
pub fn copy_provenance(pattern: &str, seed_key: &str, qualifier: &str) -> Provenance {
    Provenance::new(pattern, Role::Derived("copy".into()))
        .with_sources([seed_key.to_string()])
        .with_qualifier(qualifier)
}

/// A copy of `body` moved by `motion` whose entities are keyed as copies of `keys` (see
/// [`copy_provenance`]).
pub fn copy_body(
    body: &Body,
    keys: &SeedKeys,
    motion: &Motion,
    pattern: &str,
    qualifier: &str,
) -> Result<Body, PatternError> {
    let missing = || PatternError::internal("a seed entity has no key");
    let mut err = None;
    let out = move_body(body, motion, |e, p| {
        let k = match e {
            Entity::Face(f) => keys.faces.get(&f),
            Entity::Edge(x) => keys.edges.get(&x),
            Entity::Vertex(v) => keys.vertices.get(&v),
        };
        match k {
            Some(k) => copy_provenance(pattern, k, qualifier),
            None => {
                err.get_or_insert_with(missing);
                p.clone()
            }
        }
    })?;
    match err {
        Some(e) => Err(e),
        None => Ok(out),
    }
}

// ---- applying a seed -------------------------------------------------------------------------

/// What a seed does with its (moved) tool bodies.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeedOp {
    /// `new_body`: every instance creates new bodies.
    NewBody,
    /// A body operation on the targets (extrude/revolve `join`/`cut`/`intersect`, a body
    /// seed with `op: join`).
    Body(BodyOp),
    /// A hole: a cut whose misses are `HOLE_MISSES_BODY`. Every seed body is a hole tool with
    /// its [`HoleToolInfo`] ([`SeedBody::hole`], from `HoleOutcome::seed_bodies`); hole tools
    /// are never applied as another operation (`FORGE_PATTERN_HOLE_SEED_MISMATCH`).
    Hole,
}

impl SeedOp {
    fn body_op(self) -> Option<BodyOp> {
        match self {
            SeedOp::NewBody => None,
            SeedOp::Body(op) => Some(op),
            SeedOp::Hole => Some(BodyOp::Cut),
        }
    }
    fn miss_code(self) -> &'static str {
        match self {
            SeedOp::Hole => "HOLE_MISSES_BODY",
            SeedOp::Body(BodyOp::Intersect) => "BOOLEAN_EMPTY_RESULT",
            _ => "BOOLEAN_NO_INTERSECTION",
        }
    }
}

/// A seed body: a tool of a feature seed as evaluated at the seed, or a body of a body seed.
#[derive(Clone, Debug)]
pub struct SeedBody {
    /// The body.
    pub body: Body,
    /// Its origin (the member names the copies' origins).
    pub origin: Origin,
    /// Its entities' keys; `None`: [`seed_keys`].
    pub keys: Option<SeedKeys>,
    /// For a hole seed's tool: its axis and extent (`HoleOutcome::seed_bodies`), which
    /// [`apply_seed`] checks every moved copy with (see the module docs). Required with
    /// [`SeedOp::Hole`] and refused otherwise (`FORGE_PATTERN_HOLE_SEED_MISMATCH`).
    pub hole: Option<HoleToolInfo>,
}

/// What [`apply_seed`] produced.
#[derive(Clone, Debug)]
pub struct PatternOutcome {
    /// Bodies created by a `new_body` seed, in instance order then seed order, each with
    /// the origin `{ pattern, seed member, instance }` and change `created`.
    pub created: Vec<ResultBody>,
    /// The body operation's result (body-operation and hole seeds).
    pub op: Option<BodyOpResult>,
    /// Instances skipped because their tools meet no target, in index order.
    pub skipped: Vec<Skipped>,
    /// One `PATTERN_INSTANCE_SKIPPED` per skipped instance, then (hole seeds) the
    /// engine-prefixed hole diagnostics of the kept instances in index order, per instance
    /// in seed-tool order (see the module docs).
    pub notes: Vec<PatternNote>,
    /// The moved tools of every kept instance, in index order (their origins carry the
    /// instance): the pattern's own tool bodies, e.g. for a later pattern of this pattern.
    pub tools: Vec<(Vec<u32>, Vec<OpBody>)>,
}

fn copy_origin(pattern: &str, seed: &Origin, index: &[u32]) -> Origin {
    Origin {
        feature: pattern.to_string(),
        member: seed.member.clone(),
        instance: Some(index.to_vec()),
    }
}

/// An axis-aligned box `(lo, hi)`.
type Aabb = ([f64; 3], [f64; 3]);

fn bbox_of(b: &Body) -> Result<([f64; 3], [f64; 3]), PatternError> {
    forge_check::bbox(b).map_err(|e| PatternError::internal(format!("bounding box: {e}")))
}

/// The distance between two axis-aligned boxes `(lo, hi)` (0 when they overlap).
pub(crate) fn box_gap(a: &([f64; 3], [f64; 3]), b: &([f64; 3], [f64; 3])) -> f64 {
    let mut d2: f64 = 0.0;
    for k in 0..3 {
        let g = (a.0[k] - b.1[k]).max(b.0[k] - a.1[k]).max(0.0);
        d2 += g * g;
    }
    d2.sqrt()
}

/// Face keys of a body operation's result: faces of the result bodies and keys merged away
/// by §6.0.4 (SPEC §5.2 rule 3).
fn result_face_keys(res: &BodyOpResult) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = res
        .bodies
        .iter()
        .flat_map(|rb| rb.body.faces().iter().map(|(_, f)| f.provenance.key()))
        .collect();
    out.extend(res.aliases.iter().map(|(merged, _)| merged.clone()));
    out
}

/// The face keys of an instance's tools (what a met instance leaves in the result).
fn tool_face_keys(tools: &[OpBody]) -> BTreeSet<String> {
    tools
        .iter()
        .flat_map(|t| t.body.faces().iter().map(|(_, f)| f.provenance.key()))
        .collect()
}

fn run_op(
    op: BodyOp,
    targets: &[OpBody],
    tools: &[OpBody],
    pattern: &str,
    scale: Option<f64>,
) -> Result<BodyOpResult, BooleanError> {
    match scale {
        Some(s) => apply_body_op_in_scope(op, targets, tools, pattern, s),
        None => apply_body_op(op, targets, tools, pattern),
    }
}

/// `true` when the seed's operation with only these tools misses every target (its miss
/// code), `false` when it meets one; other failures propagate.
fn misses_alone(
    op: BodyOp,
    targets: &[OpBody],
    tools: &[OpBody],
    pattern: &str,
    scale: Option<f64>,
) -> Result<bool, PatternError> {
    match run_op(op, targets, tools, pattern, scale) {
        Ok(_) => Ok(false),
        Err(BooleanError::NoIntersection { .. } | BooleanError::EmptyResult { .. }) => Ok(true),
        Err(e) => Err(e.into()),
    }
}

/// An instance's (or a tool's) verdict when re-tested alone after the combined operation
/// failed.
#[derive(Debug)]
enum Alone {
    /// Every tool misses (cut, intersect, hole: the operation's miss code; join: every tool
    /// is detached): the instance is skipped.
    Misses,
    /// The instance meets the targets.
    Meets,
    /// Join: the instance meets through one tool and has another detached tool, SPEC [W0-39]
    /// per tool: the join's `BOOLEAN_NO_INTERSECTION` naming the (first) detached tool.
    Mixed(BooleanError),
    /// The operation alone fails otherwise: nothing is decided here.
    Undecided,
}

/// A join tool joined alone.
enum JoinTool {
    /// Detached: the join's `BOOLEAN_NO_INTERSECTION` (kept for a mixed instance).
    Detached(BooleanError),
    /// The join succeeds, or fails with `BOOLEAN_NON_MANIFOLD`: a join assembles a union —
    /// where it can find the result non-manifold — only from operands that overlap, and a
    /// detached tool is reported before any contact of the union is examined.
    Meets,
    /// Any other failure.
    Undecided,
}

fn join_tool(targets: &[OpBody], tool: &OpBody, pattern: &str, scale: Option<f64>) -> JoinTool {
    match run_op(
        BodyOp::Join,
        targets,
        std::slice::from_ref(tool),
        pattern,
        scale,
    ) {
        Ok(_) | Err(BooleanError::NonManifold { .. }) => JoinTool::Meets,
        Err(e @ BooleanError::NoIntersection { .. }) => JoinTool::Detached(e),
        Err(_) => JoinTool::Undecided,
    }
}

/// A join instance re-tested alone (module docs, item 2): its tools joined together; if that
/// fails, each tool alone ([`join_tool`]). Every tool detached: `Misses`; one detached and
/// one meeting: `Mixed` (the first detached tool in seed order, with W4's `min_distance`);
/// otherwise `Meets` or `Undecided`. (A tool whose box stays far from every target's is
/// detached at the cost of W4's box test and distance.)
fn join_instance(targets: &[OpBody], tools: &[OpBody], pattern: &str, scale: Option<f64>) -> Alone {
    if run_op(BodyOp::Join, targets, tools, pattern, scale).is_ok() {
        // SPEC [W0-39]: a join succeeds only when every tool meets a target.
        return Alone::Meets;
    }
    let (mut detached, mut meets, mut undecided) = (None, false, false);
    for t in tools {
        match join_tool(targets, t, pattern, scale) {
            JoinTool::Detached(e) => {
                detached.get_or_insert(e);
            }
            JoinTool::Meets => meets = true,
            JoinTool::Undecided => undecided = true,
        }
    }
    match (detached, meets, undecided) {
        (Some(e), true, _) => Alone::Mixed(e),
        (Some(_), false, false) => Alone::Misses,
        (None, true, false) => Alone::Meets,
        _ => Alone::Undecided,
    }
}

/// Is `s` a hole tool (a body built by [`hole_tool`] for its origin's feature and position:
/// a `H/wall@p` face)?
fn is_hole_tool(s: &SeedBody) -> bool {
    s.body.faces().iter().any(|(_, f)| {
        let p = &f.provenance;
        p.feature == s.origin.feature
            && p.qualifier.as_deref() == Some(s.origin.member.as_str())
            && matches!(&p.role, Role::Other(r) if r == "wall")
    })
}

/// `FORGE_PATTERN_HOLE_SEED_MISMATCH` unless hole seeds and hole tool information go
/// together: with [`SeedOp::Hole`] every seed carries its [`HoleToolInfo`]; with any other
/// operation no seed carries one and no seed is a hole tool (applied as a plain cut, a
/// copied through tool could become a pocket unchecked).
fn check_hole_seeds(op: SeedOp, seeds: &[SeedBody]) -> Result<(), PatternError> {
    for s in seeds {
        let what = match (op == SeedOp::Hole, s.hole.is_some()) {
            (true, false) => {
                "a hole seed's tool without its tool information (SeedBody::hole; use \
                 HoleOutcome::seed_bodies): its moved copies cannot be checked"
            }
            (false, true) => "hole tool information on a seed not applied as a hole (SeedOp::Hole)",
            (false, false) if is_hole_tool(s) => {
                "a hole tool applied as another operation: apply it with SeedOp::Hole and its \
                 tool information"
            }
            _ => continue,
        };
        return Err(PatternError::HoleSeedMismatch {
            seed: s.origin.feature.clone(),
            at: s.origin.member.clone(),
            what: what.into(),
        });
    }
    Ok(())
}

/// Apply one seed of pattern `pattern` (timeline index `timeline`) to its `instances`
/// (see the module docs). `seeds` are the seed's tool bodies (feature seeds) or the seed
/// bodies (body seeds); `targets` the bodies the caller resolved for the seed's operation in
/// the pattern's scope (ignored for `new_body`); `scope_scale` as for
/// [`apply_body_op_in_scope`].
///
/// Before anything is built: `FORGE_PATTERN_TOO_MANY_COPIES` (more than
/// [`MAX_PATTERN_COPIES`] moved copies) and `FORGE_PATTERN_HOLE_SEED_MISMATCH` (a hole seed
/// without its [`HoleToolInfo`], see [`SeedBody::hole`]).
pub fn apply_seed(
    pattern: &str,
    timeline: usize,
    op: SeedOp,
    seeds: &[SeedBody],
    instances: &[Instance],
    targets: &[OpBody],
    scope_scale: Option<f64>,
) -> Result<PatternOutcome, PatternError> {
    let copies = instances.len() as u64 * seeds.len() as u64;
    if copies > MAX_PATTERN_COPIES {
        return Err(PatternError::TooManyCopies {
            instances: instances.len() as f64,
            seed_bodies: seeds.len() as f64,
            copies: copies as f64,
            max: MAX_PATTERN_COPIES as f64,
        });
    }
    check_hole_seeds(op, seeds)?;
    // Moved copies of every seed body, per instance.
    let keys: Vec<SeedKeys> = seeds
        .iter()
        .map(|s| {
            s.keys
                .clone()
                .unwrap_or_else(|| seed_keys(&s.body, &s.origin))
        })
        .collect();
    let mut per: Vec<(Vec<u32>, Vec<OpBody>)> = Vec::with_capacity(instances.len());
    for inst in instances {
        let (index, q) = (inst.index(), inst.qualifier());
        let mut tools = Vec::with_capacity(seeds.len());
        for (s, k) in seeds.iter().zip(&keys) {
            tools.push(OpBody {
                body: copy_body(&s.body, k, &inst.motion, pattern, &q)?,
                origin: copy_origin(pattern, &s.origin, &index),
                timeline,
            });
        }
        per.push((index, tools));
    }
    let Some(bop) = op.body_op() else {
        let created = per
            .iter()
            .flat_map(|(_, tools)| tools.iter())
            .map(|t| ResultBody {
                body: t.body.clone(),
                origin: t.origin.clone(),
                change: BodyChange::Created,
            })
            .collect();
        return Ok(PatternOutcome {
            created,
            op: None,
            skipped: Vec::new(),
            notes: Vec::new(),
            tools: per,
        });
    };
    let code = op.miss_code();
    let mut skipped: BTreeSet<usize> = BTreeSet::new();
    // 1. Box pre-filter.
    let target_boxes = targets
        .iter()
        .map(|t| bbox_of(&t.body))
        .collect::<Result<Vec<_>, _>>()?;
    for (k, (_, tools)) in per.iter().enumerate() {
        let mut near = false;
        for t in tools {
            let b = bbox_of(&t.body)?;
            if target_boxes
                .iter()
                .any(|tb| box_gap(&b, tb) <= 10.0 * LINEAR_TOLERANCE)
            {
                near = true;
                break;
            }
        }
        if !near {
            skipped.insert(k);
        }
    }
    // 2.–3. The combined operation.
    let mut result: Option<BodyOpResult> = None;
    // Instances re-tested alone after a failure of the combined operation (misses first).
    let mut retested: BTreeSet<usize> = BTreeSet::new();
    loop {
        let live: Vec<usize> = (0..per.len()).filter(|k| !skipped.contains(k)).collect();
        if live.is_empty() || targets.is_empty() {
            skipped.extend(live);
            break;
        }
        let tools: Vec<OpBody> = live
            .iter()
            .flat_map(|&k| per[k].1.iter().cloned())
            .collect();
        match run_op(bop, targets, &tools, pattern, scope_scale) {
            Ok(res) => {
                // A tool lying along a planar face across its interior: the result touches
                // itself (W4's contact-line check misses lines that cross a face's inner
                // loop; see `crate::hole::tangent_contact`), the combined operation's own
                // failure.
                if let Some(c) = tangent_contact(bop, &res, &tools)
                    .map_err(|e| PatternError::internal(e.to_string()))?
                {
                    return Err(BooleanError::non_manifold(c.kind, c.point.to_array()).into());
                }
                if bop != BodyOp::Join {
                    let seen = result_face_keys(&res);
                    for &k in &live {
                        if !tool_face_keys(&per[k].1).is_disjoint(&seen) {
                            continue;
                        }
                        if misses_alone(bop, targets, &per[k].1, pattern, scope_scale)? {
                            skipped.insert(k);
                        }
                    }
                }
                result = Some(res);
                break;
            }
            Err(BooleanError::NoIntersection { .. } | BooleanError::EmptyResult { .. })
                if bop != BodyOp::Join =>
            {
                // Cut / hole: no tool meets any target; intersect: every target empty.
                skipped.extend(live);
                break;
            }
            Err(e) => {
                // Misses before the operation's own failures: re-test the live instances
                // alone, in index order (see the module docs, items 2 and 3).
                let mut newly_skipped = false;
                for &k in &live {
                    if !retested.insert(k) {
                        continue;
                    }
                    let verdict = if bop == BodyOp::Join {
                        join_instance(targets, &per[k].1, pattern, scope_scale)
                    } else {
                        match misses_alone(bop, targets, &per[k].1, pattern, scope_scale) {
                            Ok(true) => Alone::Misses,
                            Ok(false) => Alone::Meets,
                            // Undecided alone: the combined operation's error stands for it.
                            Err(_) => Alone::Undecided,
                        }
                    };
                    match verdict {
                        Alone::Misses => {
                            skipped.insert(k);
                            newly_skipped = true;
                        }
                        Alone::Mixed(detached) => return Err(detached.into()),
                        Alone::Meets | Alone::Undecided => {}
                    }
                }
                if !newly_skipped {
                    return Err(e.into());
                }
            }
        }
    }
    // Hole seeds: copies of through tools must still leave every target (before any
    // instance is declared skipped or the pattern failed: a skipped copy may be one that
    // stopped short of the part).
    let mut hole_notes = Vec::new();
    if op == SeedOp::Hole {
        let copies = HoleCopies {
            pattern,
            timeline,
            seeds,
            keys: &keys,
            per: &per,
            instances,
            targets,
            target_boxes: &target_boxes,
            scope_scale,
        };
        copies.check_through(result.as_ref())?;
        if let Some(res) = &result {
            hole_notes = copies.diagnostics(res, &skipped)?;
        }
    }
    let skipped_list: Vec<Skipped> = skipped
        .iter()
        .map(|&k| Skipped {
            index: per[k].0.clone(),
            code: code.to_string(),
        })
        .collect();
    if !per.is_empty() && skipped.len() == per.len() {
        return Err(PatternError::AllInstancesFailed {
            instances: skipped_list,
        });
    }
    let mut notes: Vec<PatternNote> = skipped_list
        .iter()
        .cloned()
        .map(PatternNote::InstanceSkipped)
        .collect();
    notes.extend(hole_notes);
    let tools = per
        .into_iter()
        .enumerate()
        .filter(|(k, _)| !skipped.contains(k))
        .map(|(_, x)| x)
        .collect();
    Ok(PatternOutcome {
        created: Vec::new(),
        op: result,
        skipped: skipped_list,
        notes,
        tools,
    })
}

// ---- hole seeds ------------------------------------------------------------------------------

/// The copies of a hole seed's tools, for the checks of the module docs.
struct HoleCopies<'a> {
    pattern: &'a str,
    timeline: usize,
    seeds: &'a [SeedBody],
    keys: &'a [SeedKeys],
    per: &'a [(Vec<u32>, Vec<OpBody>)],
    instances: &'a [Instance],
    targets: &'a [OpBody],
    target_boxes: &'a [([f64; 3], [f64; 3])],
    scope_scale: Option<f64>,
}

/// How far the boxes extend along the unit `d` from `p` (the largest `(c − p)·d` over their
/// corners).
fn reach_along(boxes: &[([f64; 3], [f64; 3])], p: Point3, d: Vec3) -> f64 {
    let mut reach = f64::NEG_INFINITY;
    for (lo, hi) in boxes {
        for k in 0..8 {
            let c = Vec3::new(
                if k & 1 == 0 { lo[0] } else { hi[0] },
                if k & 2 == 0 { lo[1] } else { hi[1] },
                if k & 4 == 0 { lo[2] } else { hi[2] },
            );
            reach = reach.max((c - p).dot(d));
        }
    }
    reach
}

/// A unit vector perpendicular to the unit `d` (deterministic: `d` × the world axis least
/// aligned with it).
fn perpendicular(d: Vec3) -> Option<Vec3> {
    let axes = [Vec3::unit_x(), Vec3::unit_y(), Vec3::unit_z()];
    let a = axes
        .into_iter()
        .min_by(|a, b| d.dot(*a).abs().total_cmp(&d.dot(*b).abs()))?;
    d.cross(a).normalize()
}

impl HoleCopies<'_> {
    /// The key of seed `s`'s face with hole role `role` (`H/<role>@p`), if the seed has one.
    fn seed_face_key(&self, s: usize, role: &str) -> Option<&String> {
        let o = &self.seeds[s].origin;
        let want = hole_face_provenance(&o.feature, role, &o.member).key();
        self.keys[s].faces.values().find(|k| **k == want)
    }

    fn too_short(&self, k: usize, s: usize, h: &HoleToolInfo, reach: f64) -> PatternError {
        PatternError::ThroughCopyTooShort {
            index: self.per[k].0.clone(),
            seed: self.seeds[s].origin.feature.clone(),
            at: self.seeds[s].origin.member.clone(),
            length: h.length,
            reach,
        }
    }

    /// The copy of instance `k` of through tool `h`: its top point, unit axis and how far the
    /// targets' boxes extend along that axis.
    fn moved_axis(&self, k: usize, h: &HoleToolInfo) -> Result<(Point3, Vec3, f64), PatternError> {
        let m = &self.instances[k].motion;
        let p = m.point(h.point);
        let d = m
            .vector(h.dir)
            .normalize()
            .ok_or_else(|| PatternError::internal("a hole tool without an axis"))?;
        Ok((p, d, reach_along(self.target_boxes, p, d)))
    }

    /// `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT` for the first instance (index order) whose copy
    /// of a through tool does not leave every target (see the module docs); `result` is the
    /// combined operation's result (`None`: every instance skipped).
    fn check_through(&self, result: Option<&BodyOpResult>) -> Result<(), PatternError> {
        let mut remaining: Option<Vec<OpBody>> = None;
        for k in 0..self.per.len() {
            for (s, seed) in self.seeds.iter().enumerate() {
                let Some(h) = seed.hole.filter(|h| h.end == ToolEnd::Through) else {
                    continue;
                };
                if self.target_boxes.is_empty() {
                    return Ok(());
                }
                let (p, d, reach) = self.moved_axis(k, &h)?;
                if h.length - reach > 10.0 * LINEAR_TOLERANCE {
                    continue; // the far end clears every target's box
                }
                let rem = remaining.get_or_insert_with(|| match result {
                    Some(res) => res
                        .bodies
                        .iter()
                        .map(|rb| OpBody {
                            body: rb.body.clone(),
                            origin: rb.origin.clone(),
                            timeline: 0,
                        })
                        .chain(
                            res.untouched_targets
                                .iter()
                                .map(|&i| self.targets[i].clone()),
                        )
                        .collect(),
                    None => self.targets.to_vec(),
                });
                if rem.is_empty() {
                    return Ok(());
                }
                let ext = self.extension(p, d, h.radius, h.length, reach.max(h.length) + 1.0)?;
                // Far from every remaining body's box: the extension meets nothing (no cut
                // needed; the tight boxes contain the bodies).
                let eb = bbox_of(&ext.body)?;
                let mut near = false;
                for r in rem.iter() {
                    if box_gap(&eb, &bbox_of(&r.body)?) <= 10.0 * LINEAR_TOLERANCE {
                        near = true;
                        break;
                    }
                }
                if near
                    && !misses_alone(
                        BodyOp::Cut,
                        rem,
                        std::slice::from_ref(&ext),
                        self.pattern,
                        self.scope_scale,
                    )?
                {
                    return Err(self.too_short(k, s, &h, reach));
                }
            }
        }
        // Invariant: no copy of a through tool's far `end` face survives.
        if let Some(res) = result {
            let seen = result_face_keys(res);
            for (k, inst) in self.instances.iter().enumerate() {
                for (s, seed) in self.seeds.iter().enumerate() {
                    let Some(h) = seed.hole.filter(|h| h.end == ToolEnd::Through) else {
                        continue;
                    };
                    let Some(end) = self.seed_face_key(s, "end") else {
                        continue;
                    };
                    let copy = copy_provenance(self.pattern, end, &inst.qualifier()).key();
                    if seen.contains(&copy) {
                        let (_, _, reach) = self.moved_axis(k, &h)?;
                        return Err(self.too_short(k, s, &h, reach));
                    }
                }
            }
        }
        Ok(())
    }

    /// A cylinder of radius `r` on the axis `p + y·d`, `y ∈ [from, to]`.
    fn extension(
        &self,
        p: Point3,
        d: Vec3,
        r: f64,
        from: f64,
        to: f64,
    ) -> Result<OpBody, PatternError> {
        let spec = HoleSpec {
            feature: self.pattern.to_string(),
            kind: HoleKind::Simple,
            d: 2.0 * r,
            depth: Depth::Blind(to - from),
            tip: Tip::Flat,
            cbore: None,
            csink: None,
            insert: None,
            size: None,
            thread: None,
            thread_form: None,
            head_field: None,
        };
        let e = perpendicular(d).ok_or_else(|| PatternError::internal("a zero hole axis"))?;
        let body = hole_tool(&spec, "through_check", p + d * from, d, e, to - from, false)
            .map_err(|err| PatternError::internal(format!("through check cylinder: {err}")))?;
        Ok(OpBody {
            body,
            origin: Origin {
                feature: self.pattern.to_string(),
                member: "through_check".into(),
                instance: None,
            },
            timeline: self.timeline,
        })
    }

    /// Is `b`'s box within `10·tol` of a target's box (else `b` meets no target, without a
    /// boolean)?
    fn near_targets(&self, b: &Body) -> Result<bool, PatternError> {
        let bb = bbox_of(b)?;
        Ok(self
            .target_boxes
            .iter()
            .any(|tb| box_gap(&bb, tb) <= 10.0 * LINEAR_TOLERANCE))
    }

    /// Is `key` a face of seed `s`'s hole: the seed hole's own faces (`H/<role>@p`) or a copy
    /// of one by this pattern (edges excluded)?
    fn is_hole_face(&self, s: usize, key: &str) -> bool {
        let feature = &self.seeds[s].origin.feature;
        let Ok(p) = parse_key(key) else {
            return false;
        };
        if p.label == "edge" {
            return false;
        }
        if p.feature == *feature {
            return p.qualifier.is_some();
        }
        if p.feature != self.pattern || p.label != "copy" {
            return false;
        }
        let KeyRoleArg::Keys(inner) = &p.arg else {
            return false;
        };
        inner
            .iter()
            .any(|k| parse_key(k).is_ok_and(|q| q.feature == *feature && q.label != "edge"))
    }

    /// The engine-prefixed hole diagnostics of the kept instances (see the module docs).
    fn diagnostics(
        &self,
        res: &BodyOpResult,
        skipped: &BTreeSet<usize>,
    ) -> Result<Vec<PatternNote>, PatternError> {
        let seen = result_face_keys(res);
        // The boxes of every kept copy and of the seed's tools (whose holes the targets
        // already have): a removed copy bottom is open unless one of them comes near this copy
        // (computed once, when needed).
        let mut boxes: Option<Vec<((usize, usize), Aabb)>> = None;
        let mut near_other = |k: usize, s: usize| -> Result<bool, PatternError> {
            if boxes.is_none() {
                let mut v = Vec::new();
                for (j, (_, tools)) in self.per.iter().enumerate() {
                    if skipped.contains(&j) {
                        continue;
                    }
                    for (i, t) in tools.iter().enumerate() {
                        v.push(((j, i), bbox_of(&t.body)?));
                    }
                }
                for (i, seed) in self.seeds.iter().enumerate() {
                    v.push(((usize::MAX, i), bbox_of(&seed.body)?));
                }
                boxes = Some(v);
            }
            let b = boxes.as_deref().unwrap_or_default();
            let Some((_, mine)) = b.iter().find(|(id, _)| *id == (k, s)) else {
                return Ok(true);
            };
            Ok(b.iter()
                .any(|(id, x)| *id != (k, s) && box_gap(x, mine) <= 10.0 * LINEAR_TOLERANCE))
        };
        let mut notes = Vec::new();
        for (k, (index, tools)) in self.per.iter().enumerate() {
            if skipped.contains(&k) {
                continue;
            }
            let q = self.instances[k].qualifier();
            for (s, (seed, tool)) in self.seeds.iter().zip(tools).enumerate() {
                let note = |what: fn(HoleCopyNote) -> PatternNote| {
                    what(HoleCopyNote {
                        index: index.clone(),
                        seed: seed.origin.feature.clone(),
                        at: seed.origin.member.clone(),
                    })
                };
                let met = tools.len() == 1
                    || !tool_face_keys(std::slice::from_ref(tool)).is_disjoint(&seen)
                    || (self.near_targets(&tool.body)?
                        && !misses_alone(
                            BodyOp::Cut,
                            self.targets,
                            std::slice::from_ref(tool),
                            self.pattern,
                            self.scope_scale,
                        )?);
                if !met {
                    notes.push(note(PatternNote::HolePositionMissed));
                    continue;
                }
                if let Some(top) = self.seed_face_key(s, "top")
                    && seen.contains(&copy_provenance(self.pattern, top, &q).key())
                {
                    notes.push(note(PatternNote::HoleTopInside));
                }
                if seed.hole.is_none_or(|h| h.end != ToolEnd::Blind) {
                    continue;
                }
                let Some(bottom) = self
                    .seed_face_key(s, "tip")
                    .or_else(|| self.seed_face_key(s, "floor"))
                else {
                    continue;
                };
                let copy = copy_provenance(self.pattern, bottom, &q).key();
                // This copy's own faces: the copies of seed `s`'s faces in instance `q`.
                let mine: BTreeSet<String> = self.keys[s]
                    .faces
                    .values()
                    .map(|k| copy_provenance(self.pattern, k, &q).key())
                    .collect();
                let is_hole = |key: &str| self.is_hole_face(s, key);
                let breaks = match bottom_state(res, &copy, |key| mine.contains(key), is_hole) {
                    BottomState::Inside => false,
                    BottomState::Open => true,
                    BottomState::Absent if !near_other(k, s)? => true,
                    // Another tool (a coincident copy, an overlapping position) removed or
                    // borders the bottom: decided on this copy's cut alone.
                    state => breaks_through_alone(
                        self.targets,
                        tool,
                        self.pattern,
                        self.scope_scale,
                        &copy,
                        is_hole,
                        state == BottomState::Absent,
                    ),
                };
                if breaks {
                    notes.push(note(PatternNote::HoleBreaksThrough));
                }
            }
        }
        Ok(notes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_core::topo::parse_key;

    fn lin(count: f64, spacing: f64) -> Layout {
        Layout::Linear(LinearLayout {
            dir: Vec3::unit_x(),
            count,
            spacing,
            second: None,
        })
    }

    #[test]
    fn linear_instances_exclude_the_seed_and_honour_skip() {
        let v = pattern_instances(&lin(4.0, 2.5), &[vec![2]]).expect("ok");
        let idx: Vec<Vec<u32>> = v.iter().map(Instance::index).collect();
        assert_eq!(idx, vec![vec![1], vec![3]]);
        let Motion::Rigid(t) = v[1].motion else {
            panic!("rigid")
        };
        assert_eq!(t.transform_point(Vec3::zero()), Vec3::new(7.5, 0.0, 0.0));
        assert!(
            pattern_instances(&lin(1.0, 2.5), &[])
                .expect("ok")
                .is_empty()
        );
    }

    #[test]
    fn two_direction_grid_is_lexicographic_with_pair_indices() {
        let l = Layout::Linear(LinearLayout {
            dir: Vec3::unit_x(),
            count: 2.0,
            spacing: 3.0,
            second: Some((Vec3::unit_y(), 3.0, -1.0)),
        });
        let v = pattern_instances(&l, &[vec![1, 2]]).expect("ok");
        let q: Vec<String> = v.iter().map(Instance::qualifier).collect();
        assert_eq!(q, vec!["0.1", "0.2", "1.0", "1.1"]);
        let Motion::Rigid(t) = v[3].motion else {
            panic!("rigid")
        };
        assert_eq!(t.transform_point(Vec3::zero()), Vec3::new(3.0, -1.0, 0.0));
    }

    #[test]
    fn circular_instances_use_exact_degree_rotations() {
        let c = Layout::Circular(CircularLayout {
            origin: Vec3::new(1.0, 1.0, 0.0),
            axis: Vec3::new(0.0, 0.0, 2.0),
            count: 4.0,
            angle: 360.0,
        });
        let v = pattern_instances(&c, &[]).expect("ok");
        assert_eq!(v.len(), 3);
        let Motion::Rigid(t) = v[0].motion else {
            panic!("rigid")
        };
        assert_eq!(
            t.transform_point(Vec3::new(2.0, 1.0, 5.0)),
            Vec3::new(1.0, 2.0, 5.0)
        );
        // A partial angle spreads count − 1 steps over it.
        let c = Layout::Circular(CircularLayout {
            origin: Vec3::zero(),
            axis: Vec3::unit_z(),
            count: 3.0,
            angle: 60.0,
        });
        let v = pattern_instances(&c, &[]).expect("ok");
        let Motion::Rigid(t) = v[1].motion else {
            panic!("rigid")
        };
        let p = t.transform_point(Vec3::unit_x());
        assert_eq!((p.x, p.y), (0.5, 0.8660254037844386));
    }

    #[test]
    fn invalid_layouts_have_codes_and_fields() {
        let e = pattern_instances(&lin(0.0, 1.0), &[]).unwrap_err();
        assert_eq!(
            (e.code(), e.to_string().contains("/layout/linear/count")),
            ("INVALID_COUNT", true)
        );
        assert_eq!(
            pattern_instances(&lin(2.5, 1.0), &[]).unwrap_err().code(),
            "INVALID_COUNT"
        );
        assert_eq!(
            pattern_instances(&lin(2.0, 1e-7), &[]).unwrap_err().code(),
            "INVALID_VALUE"
        );
        let c = |count: f64, angle: f64| {
            Layout::Circular(CircularLayout {
                origin: Vec3::zero(),
                axis: Vec3::unit_z(),
                count,
                angle,
            })
        };
        assert_eq!(
            pattern_instances(&c(1.0, 360.0), &[]).unwrap_err().code(),
            "INVALID_COUNT"
        );
        assert_eq!(
            pattern_instances(&c(3.0, 0.0), &[]).unwrap_err().code(),
            "INVALID_ANGLE"
        );
        assert_eq!(
            pattern_instances(&c(3.0, 361.0), &[]).unwrap_err().code(),
            "INVALID_ANGLE"
        );
        assert_eq!(
            pattern_instances(&lin(3.0, 1.0), &[vec![0]])
                .unwrap_err()
                .code(),
            "INVALID_VALUE"
        );
        assert_eq!(
            pattern_instances(&lin(3.0, 1.0), &[vec![1, 0]])
                .unwrap_err()
                .code(),
            "INVALID_VALUE"
        );
        // Out of range: names no instance (a parametric count may drop below it).
        assert_eq!(
            pattern_instances(&lin(3.0, 1.0), &[vec![7]])
                .expect("ok")
                .len(),
            2
        );
        let m = Layout::Mirror(MirrorLayout {
            origin: Vec3::zero(),
            normal: Vec3::zero(),
        });
        assert_eq!(
            pattern_instances(&m, &[]).unwrap_err().code(),
            "INVALID_VALUE"
        );
    }

    #[test]
    fn copy_keys_carry_pattern_seed_key_and_instance() {
        // SPEC §5.2: `P/copy:{K}@q`, the seed key verbatim inside the braces.
        let p = copy_provenance("pt1", "e1/side:a", "2.1");
        assert!(p.problems().is_empty(), "{:?}", p.problems());
        let k = p.key();
        assert_eq!(k, "pt1/copy:{e1/side:a}@2.1");
        let parts = parse_key(&k).expect("parses");
        assert_eq!(parts.feature, "pt1");
        assert_eq!(parts.label, "copy");
        assert_eq!(parts.qualifier.as_deref(), Some("2.1"));
        assert_eq!(parts.arg, KeyRoleArg::Keys(vec!["e1/side:a".into()]));
        // Keys with qualifiers and escapes stay verbatim; copies of copies nest.
        let hole = copy_provenance("pt1", "h1/end@a", "1").key();
        assert_eq!(hole, "pt1/copy:{h1/end@a}@1");
        let nested = copy_provenance("pt2", &hole, "3").key();
        assert_eq!(nested, "pt2/copy:{pt1/copy:{h1/end@a}@1}@3");
        let parts = parse_key(&nested).expect("parses");
        assert_eq!(
            (parts.arg, parts.qualifier.as_deref()),
            (KeyRoleArg::Keys(vec![hole.clone()]), Some("3"))
        );
        let edge = copy_provenance("pt1", "e1/edge:{e1/cap:end@b|e1/side:r}", "4");
        assert_eq!(edge.key(), "pt1/copy:{e1/edge:{e1/cap:end@b|e1/side:r}}@4");
        assert!(edge.problems().is_empty(), "{:?}", edge.problems());
    }

    #[test]
    fn instance_limits_are_checked_before_building_instances() {
        let grid = Layout::Linear(LinearLayout {
            dir: Vec3::unit_x(),
            count: 2_147_483_648.0,
            spacing: 1.0,
            second: Some((Vec3::unit_y(), 2_147_483_648.0, 1.0)),
        });
        let e = pattern_instances(&grid, &[]).unwrap_err();
        assert_eq!(e.code(), "FORGE_PATTERN_TOO_MANY_INSTANCES");
        let PatternErrorDetails::Limit { field, max, .. } = e.details() else {
            panic!("{e}")
        };
        assert_eq!((field.as_str(), max), ("/layout/linear", 10_000.0));
        let circ = Layout::Circular(CircularLayout {
            origin: Vec3::zero(),
            axis: Vec3::unit_z(),
            count: 10_002.0,
            angle: 360.0,
        });
        assert_eq!(
            pattern_instances(&circ, &[]).unwrap_err().code(),
            "FORGE_PATTERN_TOO_MANY_INSTANCES"
        );
        // The limit itself is fine.
        assert_eq!(
            pattern_instances(&lin(10_001.0, 1.0), &[])
                .expect("ok")
                .len(),
            10_000
        );
        // Overflowing positions are INVALID_VALUE at the spacing.
        let e = pattern_instances(&lin(5.0, 1e308), &[]).unwrap_err();
        assert_eq!(
            (e.code(), e.to_string().contains("/layout/linear/spacing")),
            ("INVALID_VALUE", true)
        );
    }
}
