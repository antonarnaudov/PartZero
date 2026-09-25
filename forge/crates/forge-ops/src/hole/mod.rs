//! # Holes (SPEC §6.5 [D-42], interface I4 `hole_tools`)
//!
//! A hole is one `cut` of its targets by a tool of revolution per position (§6.0.3):
//! 1. [`literal_hole`] + [`hole_spec`]: the fields to numbers — the diameter and presets from
//!    `forge_ir::v1::holes::tool_dims` (`HOLE_SIZES`), the depth, tip and thread, with the
//!    §6.5 range checks;
//! 2. [`hole_positions`]: the placement forms (`list`, `grid`, `circle`, sketch `points`) on
//!    the placement plane, `DUPLICATE_ID`, `HOLE_DUPLICATE_POSITION`;
//! 3. [`apply_hole`]: `HOLE_POINT_OFF_FACE` (every position on the `on` face within tol),
//!    `up_to` depths (`HOLE_UP_TO_MISSED`, then the head depth), the tools ([`hole_tool`]),
//!    the combined cut, and per position `HOLE_MISSES_BODY`, the warning
//!    `HOLE_BREAKS_THROUGH` and the
//!    engine-prefixed warning `FORGE_HOLE_THREAD_DEEPER_THAN_HOLE { at, depth, hole_depth }`
//!    (an explicit thread `depth` beyond a blind or up-to hole's depth: SPEC §6.5 bounds it
//!    only by tol, so the report keeps it as given; W5 contract issue), and the report's
//!    `holes` entries.
//!
//! # Drilling direction
//! `d = −n` with `n` the placement frame's normal (the `on` face's **outward** normal, §3.1):
//! into the material; `flip` gives `d = n`.
//!
//! # Order of checks
//! The first failure in this order is reported (W5 proposal to the Contract stage, the order
//! the W7b oracle follows): `DUPLICATE_ID`, `HOLE_DUPLICATE_POSITION` (in
//! [`hole_positions`]); `HOLE_POINT_OFF_FACE` (first position in order); for `up_to`,
//! `HOLE_UP_TO_MISSED` for the first position whose axis misses the face, **then** the head
//! check (`INVALID_VALUE` at the counterbore depth or countersink diameter, like a blind
//! hole's, against the shallowest position's depth — the first in order among equals); then
//! `HOLE_MISSES_BODY` (first position in order); then the combined cut's own failures
//! (`BOOLEAN_NON_MANIFOLD`, `FORGE_BOOLEAN_*`). A failed combined cut is therefore followed by
//! the single-position miss tests before its error is returned.
//!
//! # Tangent contacts
//! A tool that lies along a planar face of the result across that face's interior (a wall
//! tangent to another face of the part), or whose drill-point apex lies within tol of such a
//! face (on it, by [R-3]), makes the correct result touch itself; W4's own checks miss such a
//! line when it crosses an inner loop of the face, and an apex within tol of a face but not
//! on it. Every result of [`apply_hole`] (and of `apply_seed`) is checked by [`tool_contact`]
//! (module `contact`), which fails the operation with `BOOLEAN_NON_MANIFOLD`
//! `{ probe: { kind: edge | vertex, point } }` (a point of the line, or the apex's foot,
//! inside the face) instead of returning that body — among the combined cut's own failures,
//! after the misses. The line test checks that the tool face really contains the ruling where
//! it reports a point (a notched rod's face does not). W4 items until its checks cover these
//! contacts (W5 differential cases `regression_909_59`, `tip_band_*`).
//!
//! # Misses (`HOLE_MISSES_BODY`)
//! A position's tool meets a target when the combined cut's result carries one of its faces
//! (`H/…@p`, or a key merged away by §6.0.4); otherwise the tool alone is cut from the
//! targets, and `BOOLEAN_NO_INTERSECTION` there is the miss (another position's tool may
//! cover the material this one removes). The first missing position in position order is
//! reported; a position whose own cut fails otherwise reports that failure only when no
//! later position misses.
//!
//! # Break-through (`HOLE_BREAKS_THROUGH`)
//! SPEC §6.5 names the warning without a test. Here a **blind** hole (`blind` depth or an
//! insert) breaks through when its bottom — the `tip` cone or the flat `floor` — is not
//! entirely inside the targets' material **as they were before the hole**, read on the cut of
//! the targets by that position's tool alone: that result has no face carrying the bottom's
//! key (or its alias), or a bottom face shares an edge with a face that is not a face of the
//! hole (the target's far side, a pocket, the part's outside). The combined cut decides where
//! it can, without another boolean: a bottom bounded only by the position's own faces is
//! inside, a bottom sharing an edge with a target face is open. A bottom that another
//! position's tool removed or borders (a small blind position inside a deeper, wider one;
//! overlapping holes) is decided on the single-position cut, so another position of the same
//! hole never makes a position break through. (If that cut fails, the combined result's
//! reading stands: a removed bottom warns.) This is the reading of the W7b oracle, which tests
//! each tool's bottom against the uncut targets.
//!
//! **`up_to` holes never warn** (Forge's reading of "then as blind with a flat floor": the
//! floor lies on the face the author chose, typically the part's far side). The W7b oracle
//! warns when that floor lies within tol of a target face. Open W5 contract question (SPEC
//! §6.5 is silent); the W5 differential classifies the disagreement `OPEN_CONTRACT`. The
//! literal reading favours warning — "then as `blind` with a flat floor" plus "a blind hole
//! that breaks through" warns — and Forge's own blind rule warns on the same geometry (a
//! `blind` flat floor at exactly the plate's thickness is `Absent`, so it breaks through):
//! until the Contract stage rules, full-document diffs of `up_to` holes to a far face differ
//! in this warning.
//!
//! # Patterns of holes
//! [`HoleOutcome::seed_bodies`] hands a pattern (SPEC §6.10) the tools with their
//! [`HoleToolInfo`] (axis, radius, length, how the tool ends), so that `apply_seed` can check
//! each moved copy: a copied `through` tool must still leave every target (it fails with
//! `FORGE_PATTERN_THROUGH_COPY_TOO_SHORT` otherwise, never a blind pocket), and a copied
//! blind tool is tested for break-through with the rule above.
//!
//! # Pending (tracked, not implemented)
//! - **Thread attribute on the wall face.** SPEC §6.5 says the wall face `H/wall@p` "carries
//!   the thread attribute for drawings and export". forge-core faces have no attribute store
//!   yet, so Forge records a thread only in the report (`holes[].thread`, [`HoleReport`]);
//!   exporters and drawings must not assume the face carries it. Needs a forge-core face
//!   attribute (owner: forge-core) and then `apply_hole` setting it on every `H/wall@p`
//!   piece (BACKLOG / SPEC §11.1 item requested from the integrator).

mod contact;
mod error;
mod face;
mod place;
mod spec;
mod tool;

use std::collections::BTreeSet;

use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::topo::{Body, FaceId, parse_key};
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ir::v1::metrics::{CboreOut, CsinkOut, HoleReport, Origin};

use crate::boolean::{
    BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op, apply_body_op_in_scope,
};
use crate::pattern::{SeedBody, box_gap};

pub(crate) use contact::tangent_contact;
pub use contact::{ToolContact, tool_contact};
pub use error::{HoleError, HoleErrorDetails, HoleNote};
pub use face::{planar_face_distance, up_to_depth};
pub use place::{HolePos, MAX_HOLE_POSITIONS, hole_positions};
pub use spec::{Depth, HoleSpec, Tip, hole_spec, literal_hole};
pub use tool::{hole_face_provenance, hole_tool, tool_volume};

/// The drilling direction for the placement frame's normal `n` (§6.5): `−n`, or `n` with
/// `flip`.
pub fn drill_direction(frame: &Frame, flip: bool) -> Vec3 {
    if flip { frame.z() } else { -frame.z() }
}

/// Everything [`apply_hole`] needs besides the spec.
#[derive(Clone, Copy, Debug)]
pub struct HoleSite<'a> {
    /// The placement plane's frame (§3.1; `z` is the `on` face's outward normal).
    pub frame: &'a Frame,
    /// `flip` (evaluated).
    pub flip: bool,
    /// The `on` face (body and face), when `on` is a face: positions must lie on it.
    pub on_face: Option<(&'a Body, FaceId)>,
    /// The `up_to` face, for `depth: { up_to }`.
    pub up_to: Option<(&'a Body, FaceId)>,
    /// The hole's timeline index (the tools' origin timeline).
    pub timeline: usize,
    /// The scope scale for the canonical order of split pieces (`apply_body_op_in_scope`);
    /// `None`: the operands' box.
    pub scope_scale: Option<f64>,
}

/// How a hole tool ends (SPEC §6.5 depth forms).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolEnd {
    /// `through`: the tool's far `end` disc lies beyond every target of the hole.
    Through,
    /// `blind` (and inserts): a drill-point `tip` or a flat `floor` at the shoulder depth.
    Blind,
    /// `up_to`: a flat `floor` on the up-to face.
    UpTo,
}

/// One hole tool's axis and extent (SPEC §6.5 "Geometry"): what a pattern of the hole needs
/// to check the tool's moved copies (see the module docs).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoleToolInfo {
    /// The placement point `P` (the tool's top, on the placement plane).
    pub point: Point3,
    /// The unit drilling direction `d`.
    pub dir: Vec3,
    /// The hole radius `D/2` (the radius of the tool's far end).
    pub radius: f64,
    /// The depth of the shoulder along `d` (blind, up-to), or the tool's length `L` (through).
    pub length: f64,
    /// How the tool ends.
    pub end: ToolEnd,
}

/// What a hole produced.
#[derive(Clone, Debug)]
pub struct HoleOutcome {
    /// The cut (bodies, identity, notes such as `BOOLEAN_SPLIT`, aliases).
    pub op: BodyOpResult,
    /// The report's `holes` entries, in position order.
    pub holes: Vec<HoleReport>,
    /// Warnings in position order, per position `HOLE_BREAKS_THROUGH` then
    /// `FORGE_HOLE_THREAD_DEEPER_THAN_HOLE`.
    pub notes: Vec<HoleNote>,
    /// The tools, in position order (origin `{ H, position id }`): what a pattern of this
    /// hole copies (SPEC §6.10 "tool bodies as evaluated at the seed").
    pub tools: Vec<OpBody>,
    /// Each tool's axis and extent, in position order (parallel to `tools`).
    pub tool_info: Vec<HoleToolInfo>,
}

impl HoleOutcome {
    /// The tools as the seed bodies of a pattern of this hole (SPEC §6.10), each with its
    /// [`HoleToolInfo`] (what `apply_seed` checks the moved copies with).
    pub fn seed_bodies(&self) -> Vec<SeedBody> {
        self.tools
            .iter()
            .zip(&self.tool_info)
            .map(|(t, info)| SeedBody {
                body: t.body.clone(),
                origin: t.origin.clone(),
                keys: None,
                hole: Some(*info),
            })
            .collect()
    }
}

/// The depth of each position's tool: `(h, through)`.
fn depths(
    spec: &HoleSpec,
    positions: &[HolePos],
    d: Vec3,
    site: &HoleSite<'_>,
    targets: &[OpBody],
) -> Result<Vec<(f64, bool)>, HoleError> {
    match spec.depth {
        Depth::Blind(h) => Ok(vec![(h, false); positions.len()]),
        Depth::UpTo => {
            let (body, face) = site
                .up_to
                .ok_or_else(|| HoleError::internal("an up_to hole without its face"))?;
            // 1. Every axis reaches the face (the first miss in position order).
            let mut hs = Vec::with_capacity(positions.len());
            for p in positions {
                match up_to_depth(body, face, p.point, d)? {
                    Some(h) => hs.push(h),
                    None => return Err(HoleError::UpToMissed { at: p.id.clone() }),
                }
            }
            // 2. The counterbore or countersink ends above the floor, as for blind holes: the
            //    shallowest position decides (the first in position order among equals).
            let shallowest = hs.iter().enumerate().fold(
                None,
                |best: Option<(usize, f64)>, (k, &h)| match best {
                    Some((_, b)) if b <= h => best,
                    _ => Some((k, h)),
                },
            );
            if let Some((k, h)) = shallowest {
                up_to_head_check(spec, h, &positions[k].id)?;
            }
            Ok(hs.into_iter().map(|h| (h, false)).collect())
        }
        Depth::Through => {
            // Beyond the farthest point of every target's box along d, plus a margin.
            let mut corners = Vec::new();
            let mut diag: f64 = 0.0;
            for t in targets {
                let (lo, hi) = forge_check::bbox(&t.body)
                    .map_err(|e| HoleError::internal(format!("bounding box: {e}")))?;
                diag = diag.max(Vec3::from(hi).distance(Vec3::from(lo)));
                for k in 0..8 {
                    corners.push(Vec3::new(
                        if k & 1 == 0 { lo[0] } else { hi[0] },
                        if k & 2 == 0 { lo[1] } else { hi[1] },
                        if k & 4 == 0 { lo[2] } else { hi[2] },
                    ));
                }
            }
            let margin = 1.0 + 1e-2 * diag;
            positions
                .iter()
                .map(|p| {
                    let far = corners
                        .iter()
                        .map(|&c| (c - p.point).dot(d))
                        .fold(0.0_f64, f64::max);
                    let mut h = far + margin;
                    if let Some((_, hc)) = spec.cbore {
                        h = h.max(hc + margin);
                    }
                    if let Some((dk, beta)) = spec.csink {
                        h = h.max(0.5 * (dk - spec.d) / spec::tan_half_deg(beta) + margin);
                    }
                    Ok((h, true))
                })
                .collect()
        }
    }
}

/// SPEC §6.5: the counterbore depth `hc` (or the countersink's depth) is less than the hole
/// depth `h` by more than tol — for an `up_to` hole, `h` is the shallowest position's depth
/// (`at`). Reported like the blind-hole check of [`hole_spec`]: `INVALID_VALUE` at the head's
/// field ([`HoleSpec::head_field`]) with the counterbore depth or the countersink diameter as
/// the value and the feasible bound.
fn up_to_head_check(spec: &HoleSpec, h: f64, at: &str) -> Result<(), HoleError> {
    let field = |default: &str| spec.head_field.unwrap_or(default).to_string();
    if let Some((_, hc)) = spec.cbore
        && h - hc <= LINEAR_TOLERANCE
    {
        return Err(HoleError::InvalidValue {
            field: field("/cbore/depth"),
            value: hc,
            expected: format!(
                "< {} mm (shallower than the up-to depth {} mm at {at} by more than 1e-6 mm)",
                spec::bound(h - LINEAR_TOLERANCE),
                spec::bound(h)
            ),
        });
    }
    if let Some((dk, beta)) = spec.csink
        && h - 0.5 * (dk - spec.d) / spec::tan_half_deg(beta) <= LINEAR_TOLERANCE
    {
        return Err(HoleError::InvalidValue {
            field: field("/csink/d"),
            value: dk,
            expected: format!(
                "< {} mm (a countersink shallower than the up-to depth {} mm at {at} by more \
                 than 1e-6 mm at {}°)",
                spec::bound(spec.d + 2.0 * (h - LINEAR_TOLERANCE) * spec::tan_half_deg(beta)),
                spec::bound(h),
                spec::bound(beta)
            ),
        });
    }
    Ok(())
}

/// The report entry of one position.
fn report(spec: &HoleSpec, p: &HolePos, d: Vec3, depth: Option<f64>) -> HoleReport {
    HoleReport {
        at: p.id.clone(),
        center: p.point.to_array(),
        axis: d.to_array(),
        d: spec.d,
        depth,
        kind: spec.kind,
        size: spec.size,
        cbore: spec.cbore.map(|(d, depth)| CboreOut { d, depth }),
        csink: spec.csink.map(|(d, angle)| CsinkOut { d, angle }),
        insert: spec.insert.map(|(d, depth)| CboreOut { d, depth }),
        thread: spec.thread_out(depth),
    }
}

/// Face keys of the cut's result: faces of the result bodies and keys merged away by §6.0.4.
fn result_face_keys(res: &BodyOpResult) -> BTreeSet<String> {
    let mut out: BTreeSet<String> = res
        .bodies
        .iter()
        .flat_map(|rb| rb.body.faces().iter().map(|(_, f)| f.provenance.key()))
        .collect();
    out.extend(res.aliases.iter().map(|(merged, _)| merged.clone()));
    out
}

/// Where a blind tool's bottom face stands in a cut's result (the break-through test of the
/// module docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BottomState {
    /// Bounded by this tool's own faces only: inside the material.
    Inside,
    /// It shares an edge with a face that is not a hole face (a target's face): it opens
    /// there.
    Open,
    /// No face carries it (or its merge survivor): it lies outside the material, or another
    /// tool of the same hole removed it.
    Absent,
    /// It shares an edge with another tool's face of the same hole (and with no target face).
    BesideSibling,
}

/// The [`BottomState`] of the bottom face keyed `bottom_key` in `res`: `is_mine` accepts the
/// keys of this tool's own faces, `is_hole` those of every face of the hole (this tool's,
/// the other positions', a pattern's copies).
pub(crate) fn bottom_state(
    res: &BodyOpResult,
    bottom_key: &str,
    is_mine: impl Fn(&str) -> bool,
    is_hole: impl Fn(&str) -> bool,
) -> BottomState {
    // The key of the face that carries the bottom now (itself, or its merge survivor).
    let carrier = res
        .aliases
        .iter()
        .find(|(m, _)| m == bottom_key)
        .map_or(bottom_key.to_string(), |(_, into)| into.clone());
    let mut found = false;
    let mut sibling = false;
    for rb in &res.bodies {
        let b = &rb.body;
        for (fid, f) in b.faces().iter() {
            if f.provenance.key() != carrier {
                continue;
            }
            found = true;
            for eid in b.face_edges(fid) {
                for g in b.edge_faces(eid) {
                    if g == fid {
                        continue;
                    }
                    let Some(gf) = b.face(g) else {
                        return BottomState::Open;
                    };
                    let key = gf.provenance.key();
                    if !is_hole(&key) {
                        return BottomState::Open;
                    }
                    sibling |= !is_mine(&key);
                }
            }
        }
    }
    match (found, sibling) {
        (false, _) => BottomState::Absent,
        (true, true) => BottomState::BesideSibling,
        (true, false) => BottomState::Inside,
    }
}

/// The break-through test on the cut of the targets by **one** tool alone (see the module
/// docs): the bottom breaks through when no face carries it or it shares an edge with a face
/// that is not a hole face (`is_hole`; faces of holes already in the targets count as the
/// hole's). A tool that alone meets no target made no hole: `false`. Another failure of that
/// cut leaves the combined result's reading (`fallback`).
pub(crate) fn breaks_through_alone(
    targets: &[OpBody],
    tool: &OpBody,
    feature: &str,
    scale: Option<f64>,
    bottom_key: &str,
    is_hole: impl Fn(&str) -> bool,
    fallback: bool,
) -> bool {
    match run_cut(targets, std::slice::from_ref(tool), feature, scale) {
        Ok(res) => matches!(
            bottom_state(&res, bottom_key, &is_hole, &is_hole),
            BottomState::Open | BottomState::Absent
        ),
        Err(BooleanError::NoIntersection { .. } | BooleanError::EmptyResult { .. }) => false,
        Err(_) => fallback,
    }
}

fn run_cut(
    targets: &[OpBody],
    tools: &[OpBody],
    feature: &str,
    scale: Option<f64>,
) -> Result<BodyOpResult, BooleanError> {
    match scale {
        Some(s) => apply_body_op_in_scope(BodyOp::Cut, targets, tools, feature, s),
        None => apply_body_op(BodyOp::Cut, targets, tools, feature),
    }
}

/// The tools of hole `spec` at `positions` (SPEC §6.5 "Geometry"; interface I4
/// `hole_tools`): per position its tool body with origin `{ H, position id }`, and its depth
/// `(h, through)`. `targets` bound the length of through tools.
pub fn hole_tools(
    spec: &HoleSpec,
    positions: &[HolePos],
    site: &HoleSite<'_>,
    targets: &[OpBody],
) -> Result<Vec<(OpBody, f64, bool)>, HoleError> {
    let d = drill_direction(site.frame, site.flip);
    let e = site.frame.x();
    let depth = depths(spec, positions, d, site, targets)?;
    positions
        .iter()
        .zip(depth)
        .map(|(p, (h, through))| {
            let body = hole_tool(spec, &p.id, p.point, d, e, h, through)?;
            Ok((
                OpBody {
                    body,
                    origin: Origin {
                        feature: spec.feature.clone(),
                        member: p.id.clone(),
                        instance: None,
                    },
                    timeline: site.timeline,
                },
                h,
                through,
            ))
        })
        .collect()
}

/// Apply hole `spec` at `positions` to `targets` (see the module docs).
///
/// Errors: `HOLE_POINT_OFF_FACE`, `HOLE_UP_TO_MISSED`, `HOLE_MISSES_BODY` (first position in
/// order), `PLANE_NOT_PLANAR` (a non-planar `on` face), `FORGE_HOLE_UP_TO_UNSUPPORTED` (a
/// non-planar `up_to` face), the cut's own failures (`BOOLEAN_NON_MANIFOLD`,
/// `FORGE_BOOLEAN_*`) and `FORGE_HOLE_*` internal failures.
pub fn apply_hole(
    spec: &HoleSpec,
    positions: &[HolePos],
    site: &HoleSite<'_>,
    targets: &[OpBody],
) -> Result<HoleOutcome, HoleError> {
    let first = positions
        .first()
        .ok_or_else(|| HoleError::internal("a hole without positions"))?;
    if let Some((body, face)) = site.on_face {
        for p in positions {
            let distance = planar_face_distance(body, face, p.point)?;
            if distance > LINEAR_TOLERANCE {
                return Err(HoleError::PointOffFace {
                    at: p.id.clone(),
                    distance,
                });
            }
        }
    }
    let d = drill_direction(site.frame, site.flip);
    let tools = hole_tools(spec, positions, site, targets)?;
    if targets.is_empty() {
        return Err(HoleError::MissesBody {
            at: first.id.clone(),
        });
    }
    let tool_bodies: Vec<OpBody> = tools.iter().map(|(t, _, _)| t.clone()).collect();
    // The tool of one position alone: `Ok(true)` misses every target, `Ok(false)` meets one,
    // `Err` undecided (that cut failed otherwise).
    let misses_alone = |tool: &OpBody| -> Result<bool, BooleanError> {
        match run_cut(
            targets,
            std::slice::from_ref(tool),
            &spec.feature,
            site.scope_scale,
        ) {
            Ok(_) => Ok(false),
            Err(BooleanError::NoIntersection { .. }) => Ok(true),
            Err(e) => Err(e),
        }
    };
    let res = match run_cut(targets, &tool_bodies, &spec.feature, site.scope_scale) {
        Ok(res) => res,
        Err(BooleanError::NoIntersection { .. }) => {
            return Err(HoleError::MissesBody {
                at: first.id.clone(),
            });
        }
        Err(e) => {
            // Misses come before the cut's own failures (module docs, "Order of checks").
            if tools.len() > 1 {
                for (p, (tool, _, _)) in positions.iter().zip(&tools) {
                    if matches!(misses_alone(tool), Ok(true)) {
                        return Err(HoleError::MissesBody { at: p.id.clone() });
                    }
                }
            }
            return Err(e.into());
        }
    };
    // Misses: evidence in the result, else the tool alone. A position whose test failed
    // otherwise reports that failure unless a later position misses.
    let seen = result_face_keys(&res);
    let mut undecided: Option<BooleanError> = None;
    for (p, (tool, _, _)) in positions.iter().zip(&tools) {
        if tool
            .body
            .faces()
            .iter()
            .any(|(_, f)| seen.contains(&f.provenance.key()))
        {
            continue;
        }
        match misses_alone(tool) {
            Ok(false) => {}
            Ok(true) => return Err(HoleError::MissesBody { at: p.id.clone() }),
            Err(e) => {
                undecided.get_or_insert(e);
            }
        }
    }
    if let Some(e) = undecided {
        return Err(e.into());
    }
    // A tool lying along a planar face across its interior, or a drill point's apex within
    // tol of one: the result touches itself (W4's checks miss lines that cross a face's inner
    // loop and apexes within tol of a face; see `contact`).
    if let Some(c) = tangent_contact(BodyOp::Cut, &res, &tool_bodies)? {
        return Err(BooleanError::non_manifold(c.kind, c.point.to_array()).into());
    }
    let feature = spec.feature.as_str();
    let is_hole = |key: &str| {
        parse_key(key)
            .is_ok_and(|q| q.feature == feature && q.qualifier.is_some() && q.label != "edge")
    };
    // Tool boxes, for the break-through test: a removed bottom is open unless another
    // position's tool comes near this one (computed once, when needed).
    let mut boxes: Option<Vec<([f64; 3], [f64; 3])>> = None;
    let mut near_sibling = |k: usize| -> Result<bool, HoleError> {
        if boxes.is_none() {
            boxes = Some(
                tools
                    .iter()
                    .map(|(t, _, _)| forge_check::bbox(&t.body))
                    .collect::<Result<_, _>>()
                    .map_err(|e| HoleError::internal(format!("bounding box: {e}")))?,
            );
        }
        let b = boxes.as_deref().unwrap_or_default();
        Ok(b.iter()
            .enumerate()
            .any(|(j, x)| j != k && box_gap(x, &b[k]) <= 10.0 * LINEAR_TOLERANCE))
    };
    let mut notes = Vec::new();
    let mut holes = Vec::with_capacity(positions.len());
    for (k, (p, (tool, h, through))) in positions.iter().zip(&tools).enumerate() {
        let depth = (!through).then_some(*h);
        if matches!(spec.depth, Depth::Blind(_)) {
            let bottom = match spec.tip {
                Tip::Angle(_) => "tip",
                Tip::Flat => "floor",
            };
            let key = hole_face_provenance(feature, bottom, &p.id).key();
            let is_mine = |key: &str| {
                parse_key(key).is_ok_and(|q| {
                    q.feature == feature
                        && q.qualifier.as_deref() == Some(p.id.as_str())
                        && q.label != "edge"
                })
            };
            let breaks = match bottom_state(&res, &key, is_mine, is_hole) {
                BottomState::Inside => false,
                BottomState::Open => true,
                BottomState::Absent if !near_sibling(k)? => true,
                state => breaks_through_alone(
                    targets,
                    tool,
                    feature,
                    site.scope_scale,
                    &key,
                    is_hole,
                    state == BottomState::Absent,
                ),
            };
            if breaks {
                notes.push(HoleNote::BreaksThrough { at: p.id.clone() });
            }
        }
        if let (Some(hd), Some((_, Some(td)))) = (depth, spec.thread)
            && td - hd > LINEAR_TOLERANCE
        {
            notes.push(HoleNote::ThreadDeeperThanHole {
                at: p.id.clone(),
                depth: td,
                hole_depth: hd,
            });
        }
        holes.push(report(spec, p, d, depth));
    }
    let end = match spec.depth {
        Depth::Through => ToolEnd::Through,
        Depth::Blind(_) => ToolEnd::Blind,
        Depth::UpTo => ToolEnd::UpTo,
    };
    let tool_info = positions
        .iter()
        .zip(&tools)
        .map(|(p, (_, h, _))| HoleToolInfo {
            point: p.point,
            dir: d,
            radius: 0.5 * spec.d,
            length: *h,
            end,
        })
        .collect();
    Ok(HoleOutcome {
        op: res,
        holes,
        notes,
        tools: tools.into_iter().map(|(t, _, _)| t).collect(),
        tool_info,
    })
}
