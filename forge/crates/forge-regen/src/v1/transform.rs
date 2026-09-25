//! `transform` (SPEC-v1 §6.13, amendment set F) in the timeline: move, or copy, bodies by a
//! rigid motion — the rotation (`rotate`: `angle` degrees about an AxisRef, right-hand rule)
//! first, then the translation (`translate`).
//!
//! Order of checks (§7.1 step 2):
//! 1. **values**: `translate` (lengths), `rotate.angle` (degrees, `|angle| ≤ 360`,
//!    `INVALID_ANGLE`), `copy`;
//! 2. **references** in field order: `/bodies` (body, `some`), `/rotate/axis`;
//! 3. **the operation**: a move rebuilds each body with moved geometry, keeping its origin and
//!    every entity's key (an operation that only modifies entities keeps their keys, §5.2); a
//!    copy is a one-instance body pattern (`forge_ops::pattern::apply_seed`, instance `[1]`):
//!    new bodies with the origin `{ transform, source member, [1] }` and keys `T/copy:{K}@1`;
//! 4. the validity of every produced body ([R-12]).
//!
//! Report: `bodies` — the moved bodies (`modified`) or the copies (`created`), canonical order.

use forge_core::linalg::{Point3, Transform, Vec3};
use forge_core::topo::{Provenance, parse_key};
use forge_ir::v1::metrics::{BodyChange, FeatureReport, Origin};
use forge_ir::v1::{FieldType, TransformFeature};
use forge_ops::pattern::{
    Entity, Instance, Motion, SeedBody, SeedKeys, SeedOp, apply_seed, move_body,
};
use serde_json::json;

use super::bodies::{PartBody, canonical_perm, scale_of};
use super::error::FeatureError;
use super::part::{PartEval, scope_keys, take_refs};
use crate::checked;

impl PartEval<'_> {
    /// Evaluate transform feature `t` at timeline index `fi` (see the module docs).
    pub(super) fn transform(
        &mut self,
        fi: usize,
        t: &TransformFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        // 1. Values.
        let translate = self.p3(&t.translate, FieldType::Length)?;
        let angle = match &t.rotate {
            Some(r) => {
                let a = self.scalar(&r.angle, FieldType::Angle)?;
                if !(a.is_finite() && a.abs() <= 360.0) {
                    return Err(FeatureError::new(
                        "INVALID_ANGLE",
                        format!("rotate/angle = {a}: must be in [-360, 360]"),
                        json!({ "field": "rotate/angle", "value": if a.is_finite() { json!(a) } else { json!(null) }, "expected": "in [-360, 360]" }),
                    ));
                }
                Some(a)
            }
            None => None,
        };
        let copy = self.pv.boolean(self.pi, &t.copy)?;
        // 2. References, in field order.
        let idx = self.resolve_bodies(fi, &t.bodies, "/bodies", entry)?;
        let rotation = match (&t.rotate, angle) {
            (Some(r), Some(a)) => {
                let ev = self.with_scope(fi, |s| forge_refs::axis(&r.axis, s, "/rotate/axis"));
                take_refs(ev.refs, entry);
                let ax = ev.result?;
                Some(
                    Transform::rotation_about_axis_deg(
                        Point3::from(ax.origin),
                        Vec3::from(ax.direction),
                        a,
                    )
                    .ok_or_else(|| {
                        FeatureError::new(
                            "FORGE_INTERNAL",
                            "the rotation axis has no direction",
                            json!({ "field": "rotate/axis" }),
                        )
                    })?,
                )
            }
            _ => None,
        };
        let shift = Transform::translation(Vec3::from(translate));
        let motion = Motion::Rigid(match rotation {
            Some(r) => r.then(&shift),
            None => shift,
        });
        // 3. The operation.
        let made: Vec<PartBody> = if copy {
            let seeds: Vec<SeedBody> = self.with_scope(fi, |s| {
                idx.iter()
                    .map(|&b| SeedBody {
                        body: self.bodies[b].body.clone(),
                        origin: self.bodies[b].origin.clone(),
                        keys: Some(scope_keys(s, b)),
                        hole: None,
                    })
                    .collect()
            });
            let scale = scale_of(self.bodies.iter().map(|b| &b.metrics));
            let out = apply_seed(
                &t.id,
                fi,
                SeedOp::NewBody,
                &seeds,
                &[Instance::single(motion)],
                &[],
                Some(scale),
            )?;
            let mut made = Vec::with_capacity(out.created.len());
            for rb in out.created {
                made.push(PartBody::new(checked(rb.body)?, rb.origin, fi)?);
            }
            made
        } else {
            let mut moved = Vec::with_capacity(idx.len());
            for &b in &idx {
                // The keys before the move: a junction edge's qualifier (§5.2 rule 3) is found
                // from where the sketch put the junction, which a moved body no longer is, so it
                // is stamped into the provenance (the key stays the same, §6.13).
                let keys = self.with_scope(fi, |s| scope_keys(s, b));
                let src = &self.bodies[b];
                let body = move_body(&src.body, &motion, |e, p| stamp_qualifier(e, p, &keys))?;
                moved.push(PartBody::new(
                    checked(body)?,
                    src.origin.clone(),
                    src.timeline,
                )?);
            }
            moved
        };
        let change = if copy {
            BodyChange::Created
        } else {
            BodyChange::Modified
        };
        let order = {
            let items: Vec<(usize, &Origin, &[f64; 3])> = made
                .iter()
                .map(|b| (b.timeline, &b.origin, &b.metrics.centroid))
                .collect();
            canonical_perm(&items, scale_of(made.iter().map(|b| &b.metrics)))
        };
        entry.bodies = order.iter().map(|&i| made[i].report(change)).collect();
        if copy {
            self.bodies.extend(made);
        } else {
            for (&b, body) in idx.iter().zip(made) {
                self.bodies[b] = body;
            }
        }
        Ok(())
    }
}

/// An edge's or vertex's provenance with the qualifier its key had before the move, when the key
/// had one the provenance does not carry (a junction qualifier the key computation derived from
/// the entity's position). Faces and qualified entities are kept as they are.
fn stamp_qualifier(e: Entity, p: &Provenance, keys: &SeedKeys) -> Provenance {
    if p.qualifier.is_some() {
        return p.clone();
    }
    let key = match e {
        Entity::Edge(id) => keys.edges.get(&id),
        Entity::Vertex(id) => keys.vertices.get(&id),
        Entity::Face(_) => None,
    };
    match key
        .and_then(|k| parse_key(k).ok())
        .and_then(|k| k.qualifier)
    {
        Some(q) => {
            let mut out = p.clone();
            out.qualifier = Some(q);
            out
        }
        None => p.clone(),
    }
}
