//! `hole` (SPEC-v1 §6.5) in the timeline: W5's `forge_ops::hole` on the part's state.
//!
//! Order of checks (§7.1 step 2; the W7b oracle's order):
//! 1. **values and range checks**: every numeric field evaluated (`literal_hole`), the
//!    resolved spec (`hole_spec`: diameters from `HOLE_SIZES`, depths, tips, heads, the
//!    `HOLE_*` rejections re-checked for documents that bypassed validation), the sketch points
//!    of a `points` placement (`QUERY_UNKNOWN_CURVE`), and the placement's own range checks
//!    (`INVALID_COUNT`, `INVALID_VALUE`, `FORGE_HOLE_TOO_MANY_POSITIONS`) — decided on a unit
//!    frame, since only the positions' 3D placement depends on the `on` plane;
//! 2. **references** in field order: `/on/face` (or the datum or named plane), `/depth/up_to`,
//!    `/targets` (default: the body owning the `on` face; `BOOLEAN_TARGETS_REQUIRED` when `on`
//!    is not a face, a rejection validation owns);
//! 3. **the operation**: the positions on the placement plane (`DUPLICATE_ID`,
//!    `HOLE_DUPLICATE_POSITION`), then `apply_hole` (`HOLE_POINT_OFF_FACE`, `HOLE_UP_TO_MISSED`,
//!    the `up_to` head check, `HOLE_MISSES_BODY`, the combined cut) — see `forge_ops::hole`;
//! 4. the validity of every produced body ([R-12], in `commit_op`).
//!
//! The report gets the cut's `bodies` / `removed` / notes, the `holes` entries (position
//! order), the warning `HOLE_BREAKS_THROUGH { at }` per blind position that breaks through
//! (after the cut's own notes, as the oracle lists them) and the engine-prefixed
//! `FORGE_HOLE_THREAD_DEEPER_THAN_HOLE`. A hole named as a pattern seed keeps its tools with
//! their `HoleToolInfo` (`HoleOutcome::seed_bodies`).

use forge_core::linalg::{Frame, Point3, Vec3};
use forge_ir::v1::metrics::{FeatureReport, Severity, Warning};
use forge_ir::v1::{
    Cardinality, HoleDepth, HoleFeature, HolePlacement, LiteralCurve, PointIds, Targets,
};
use forge_ops::BodyOp;
use forge_ops::hole::{
    HoleError, HoleNote, HoleSite, apply_hole, hole_positions, hole_spec, literal_hole,
};
use forge_refs::{Entity, EntityId};
use serde_json::{Value, json};

use super::bodies::scale_of;
use super::error::FeatureError;
use super::part::{PartEval, SeedTools, SketchState, timelines};

impl PartEval<'_> {
    /// Evaluate hole feature `h` at timeline index `fi` (see the module docs).
    pub(super) fn hole(
        &mut self,
        fi: usize,
        h: &HoleFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        // 1. Values and range checks.
        let lit = literal_hole(h, |s, t, _path| self.scalar(s, t))?;
        let flip = self.pv.boolean(self.pi, &h.flip)?;
        let spec = hole_spec(&lit)?;
        let sketch_points = self.hole_sketch_points(&lit.at)?;
        if let Err(
            e @ (HoleError::InvalidCount { .. }
            | HoleError::InvalidValue { .. }
            | HoleError::TooManyPositions { .. }),
        ) = hole_positions(&lit.at, &Frame::world(), &sketch_points)
        {
            return Err(e.into());
        }
        // 2. References, in field order.
        let (frame, on_face) = self.plane_on(fi, &h.on, "/on", entry)?;
        let up_to = match &h.depth {
            Some(HoleDepth::UpTo(r)) => {
                Some(self.resolve_entity(fi, r, "/depth/up_to", Cardinality::ONE, entry)?)
            }
            _ => None,
        };
        let targets: Vec<usize> = match &h.targets {
            None => match on_face {
                Some(e) => vec![e.body],
                None => {
                    return Err(FeatureError::new(
                        "BOOLEAN_TARGETS_REQUIRED",
                        "a hole whose `on` is not a face needs explicit targets",
                        json!({ "feature": h.id }),
                    ));
                }
            },
            Some(Targets::All(_)) => (0..self.bodies.len()).collect(),
            Some(Targets::Ref(r)) => self.resolve_bodies(fi, r, "/targets", entry)?,
        };
        // 3. The operation.
        let positions = hole_positions(&lit.at, &frame, &sketch_points)?;
        let t_ops: Vec<forge_ops::OpBody> = targets.iter().map(|&i| self.op_body(i)).collect();
        let scale = scale_of(self.bodies.iter().map(|b| &b.metrics));
        let face_of = |e: Option<Entity>| match e {
            Some(Entity {
                body,
                id: EntityId::Face(f),
            }) => Some((&self.bodies[body].body, f)),
            _ => None,
        };
        let site = HoleSite {
            frame: &frame,
            flip,
            on_face: face_of(on_face),
            up_to: face_of(up_to),
            timeline: fi,
            scope_scale: Some(scale),
        };
        if up_to.is_some() && site.up_to.is_none() {
            return Err(FeatureError::new(
                "REF_KIND_MISMATCH",
                "/depth/up_to: the reference resolved to an entity that is not a face",
                json!({ "field": "/depth/up_to", "expected": "face", "found": "not a face" }),
            ));
        }
        let outcome = apply_hole(&spec, &positions, &site, &t_ops)?;
        let timeline_of = timelines(&t_ops, &outcome.tools);
        let seed = self.seed_ids.contains(h.id.as_str()).then(|| SeedTools {
            op: forge_ops::pattern::SeedOp::Hole,
            bodies: outcome.seed_bodies(),
        });
        let c = self.commit_op(fi, BodyOp::Cut, &targets, &[], outcome.op, &timeline_of)?;
        entry.bodies = c.bodies;
        entry.removed = c.removed;
        entry.warnings.extend(c.warnings);
        entry
            .warnings
            .extend(outcome.notes.iter().map(hole_warning));
        entry.holes = outcome.holes;
        if let Some(seed) = seed {
            self.seeds.insert(h.id.clone(), seed);
        }
        Ok(())
    }

    /// The sketch points of a `points` placement (§6.5), in the feature's order, in world
    /// coordinates on the sketch's plane (projected onto the placement plane by
    /// `hole_positions`): `point` curves and `<circle>.center` of the sketch's solved geometry;
    /// `"all"` is every `point` curve in curve order. An id that names neither is
    /// `QUERY_UNKNOWN_CURVE` (a rejection validation owns, re-checked here). Empty for the other
    /// placement forms.
    fn hole_sketch_points(
        &self,
        at: &HolePlacement,
    ) -> Result<Vec<(String, Point3)>, FeatureError> {
        let HolePlacement::Points(p) = at else {
            return Ok(Vec::new());
        };
        let Some(SketchState::Done(sk)) = self.sketches.get(p.sketch.as_str()) else {
            // The sketch is a dependency by id, checked before the feature's values.
            return Err(FeatureError::new(
                "FORGE_INTERNAL",
                "the placement's sketch has no result",
                json!({ "sketch": p.sketch }),
            ));
        };
        let solved = &sk.trace.solved;
        let ids: Vec<String> = match &p.ids {
            PointIds::All(_) => solved
                .iter()
                .filter_map(|c| match c {
                    LiteralCurve::Point { id, .. } => Some(id.clone()),
                    _ => None,
                })
                .collect(),
            PointIds::Ids(v) => v.clone(),
        };
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            let uv = solved.iter().find_map(|c| match c {
                LiteralCurve::Point { id: x, at, .. } if *x == id => Some(*at),
                LiteralCurve::Circle { id: x, center, .. }
                    if id.strip_suffix(".center") == Some(x.as_str()) =>
                {
                    Some(*center)
                }
                _ => None,
            });
            let Some(uv) = uv else {
                return Err(FeatureError::new(
                    "QUERY_UNKNOWN_CURVE",
                    format!(
                        "{id:?} is not a point (or circle centre) of sketch {:?}",
                        self.name_of(&p.sketch)
                    ),
                    json!({ "feature": p.sketch, "curve": id, "similar": [] }),
                ));
            };
            out.push((id, sk.frame.to_world_point(Vec3::new(uv[0], uv[1], 0.0))));
        }
        Ok(out)
    }

    /// Resolve a single-entity Ref-valued field (§5.7): its entity (report entry and warnings
    /// into `entry`).
    pub(super) fn resolve_entity(
        &self,
        fi: usize,
        r: &forge_ir::v1::Ref,
        field: &str,
        card: Cardinality,
        entry: &mut FeatureReport,
    ) -> Result<Entity, FeatureError> {
        let res = self.resolve(fi, r, field, card, entry)?;
        res.members.first().map(|m| m.entity).ok_or_else(|| {
            FeatureError::new(
                "FORGE_INTERNAL",
                format!("{field}: a resolved reference has no member"),
                json!({ "field": field }),
            )
        })
    }
}

/// A hole's warning in the report (§7.3): `HOLE_BREAKS_THROUGH { at }`, or the
/// engine-prefixed `FORGE_HOLE_THREAD_DEEPER_THAN_HOLE { at, depth, hole_depth }`.
fn hole_warning(n: &HoleNote) -> Warning {
    let message = match n {
        HoleNote::BreaksThrough { at } => format!("the blind hole at {at:?} breaks through"),
        HoleNote::ThreadDeeperThanHole {
            at,
            depth,
            hole_depth,
        } => format!(
            "the thread at {at:?} is {depth} mm deep, deeper than the hole ({hole_depth} mm)"
        ),
    };
    Warning {
        code: n.code().into(),
        severity: Severity::Warning,
        message,
        details: match serde_json::to_value(n) {
            Ok(Value::Object(m)) => m,
            _ => serde_json::Map::new(),
        },
    }
}
