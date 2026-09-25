//! `pattern` (SPEC-v1 §6.10) in the timeline: W5's `forge_ops::pattern` on the part's state.
//!
//! Order of checks (§7.1 step 2):
//! 1. the seed features by id (`DEPENDENCY_FAILED` / `DEPENDENCY_SUPPRESSED`, in the caller);
//! 2. **values and range checks**: counts, spacings, the circular angle and `skip`
//!    (`INVALID_COUNT`, `INVALID_VALUE`, `INVALID_ANGLE`, `FORGE_PATTERN_TOO_MANY_INSTANCES`),
//!    decided by `pattern_instances` on a stand-in layout with unit directions (the directions,
//!    axis and mirror plane are references);
//! 3. **references** in field order: `/seed/bodies`, the layout's `dir` / `dir2`, `axis` or
//!    `plane`, `/targets` (body seeds with `op: join`);
//! 4. **the operation**, per seed: body seeds are copied from the current state; feature seeds
//!    (in timeline order) copy the seed's tools **as evaluated at the seed** (kept by the
//!    seed's own evaluation, [`super::part::SeedTools`]) and apply the seed's operation once
//!    with every instance's tools — `new_body` seeds create bodies, body-operation and hole
//!    seeds act on the seed's targets **re-resolved in the pattern's scope** (the seed's
//!    `targets`, or for a hole without `targets` the body owning its `on` face; these
//!    resolutions are not fields of the pattern, so they add no `refs` entry — as in the
//!    oracle). Seeds apply one after the other on the part's current state; a failure of any
//!    seed fails the pattern, which then passes its input through.
//!
//! Report: `pattern: { instances, skipped }` — `instances` the non-seed instances the layout
//! defines minus `skip`, `skipped` the instances some seed skipped (sorted, each once, the W7b
//! oracle's reading for several seeds); one `PATTERN_INSTANCE_SKIPPED { index, code }` per
//! seed and skipped instance, then the seed's engine-prefixed hole diagnostics; `bodies` the
//! created and modified bodies in canonical order (a body a later seed modifies again is listed
//! once, in its final state), `removed` the target origins no body carries afterwards.
//!
//! A layout without non-seed instances (count 1, or `skip` naming every instance) applies
//! nothing: `Ok`, no warning (W5's reading; open contract issue — the oracle raises
//! `PATTERN_ALL_INSTANCES_FAILED`).

use std::collections::BTreeSet;

use forge_core::linalg::{Point3, Vec3};
use forge_ir::v1::metrics::{
    BodyChange, BodyReport, FeatureReport, Origin, PatternReport, Severity, Warning,
};
use forge_ir::v1::{
    Cardinality, Feature, FieldType, PatternFeature, PatternLayout, PatternOp, PatternSeed,
    PlaneRef, Targets,
};
use forge_ops::BodyOp;
use forge_ops::pattern::{
    CircularLayout, Instance, Layout, LinearLayout, MirrorLayout, PatternNote, SeedBody, SeedOp,
    apply_seed, pattern_instances,
};
use forge_refs::{FieldSpec, Scope};
use serde_json::{Value, json};

use super::bodies::{PartBody, canonical_perm, scale_of};
use super::error::FeatureError;
use super::part::{Committed, PartEval, scope_keys, take_refs, timelines};
use crate::checked;

/// The evaluated numbers of a layout (step 2 of the module docs).
enum LayoutValues {
    Linear {
        count: f64,
        spacing: f64,
        /// `(count2, spacing2)` with `dir2`.
        second: Option<(f64, f64)>,
    },
    Circular {
        count: f64,
        angle: f64,
    },
    Mirror,
}

impl LayoutValues {
    /// The layout with unit stand-ins for its references (only the range checks of
    /// `pattern_instances` depend on it).
    fn stand_in(&self) -> Layout {
        match *self {
            LayoutValues::Linear {
                count,
                spacing,
                second,
            } => Layout::Linear(LinearLayout {
                dir: Vec3::unit_x(),
                count,
                spacing,
                second: second.map(|(c, s)| (Vec3::unit_y(), c, s)),
            }),
            LayoutValues::Circular { count, angle } => Layout::Circular(CircularLayout {
                origin: Point3::new(0.0, 0.0, 0.0),
                axis: Vec3::unit_z(),
                count,
                angle,
            }),
            LayoutValues::Mirror => Layout::Mirror(MirrorLayout {
                origin: Point3::new(0.0, 0.0, 0.0),
                normal: Vec3::unit_z(),
            }),
        }
    }
}

/// The report state a pattern accumulates over its seeds.
#[derive(Default)]
struct Acc {
    bodies: Vec<BodyReport>,
    removed: Vec<Origin>,
    warnings: Vec<Warning>,
    skipped: BTreeSet<Vec<u32>>,
}

impl Acc {
    /// Merge one seed operation's commit: a body an earlier seed reported as modified and this
    /// one modifies again keeps one entry (its latest state); removed origins stay unique.
    fn merge(&mut self, c: Committed) {
        for b in c.bodies {
            self.bodies
                .retain(|x| !(x.origin == b.origin && x.change == Some(BodyChange::Modified)));
            self.bodies.push(b);
        }
        for o in c.removed {
            if !self.removed.contains(&o) {
                self.removed.push(o);
            }
        }
        self.warnings.extend(c.warnings);
    }
}

impl PartEval<'_> {
    /// Evaluate pattern feature `p` at timeline index `fi` (see the module docs).
    pub(super) fn pattern(
        &mut self,
        fi: usize,
        p: &PatternFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        // 2. Values and range checks.
        let values = self.layout_values(p)?;
        let skip: Vec<Vec<u32>> = p.skip.clone();
        pattern_instances(&values.stand_in(), &skip)?;
        // 3. References, in field order.
        let seed_bodies = match &p.seed {
            PatternSeed::Bodies(r) => Some(self.resolve_bodies(fi, r, "/seed/bodies", entry)?),
            PatternSeed::Features(_) => None,
        };
        let layout = self.layout(fi, p, &values, entry)?;
        let join_targets = match (&p.seed, p.op) {
            (PatternSeed::Bodies(_), PatternOp::Join) => Some(match &p.targets {
                Some(Targets::All(_)) => (0..self.bodies.len()).collect(),
                Some(Targets::Ref(r)) => self.resolve_bodies(fi, r, "/targets", entry)?,
                None => {
                    return Err(FeatureError::new(
                        "BOOLEAN_TARGETS_REQUIRED",
                        "a body pattern with op join needs targets",
                        json!({ "feature": p.id }),
                    ));
                }
            }),
            _ => None,
        };
        let instances = pattern_instances(&layout, &skip)?;
        // 4. The operation, on the part's state; a failure restores it (§7.1 step 3).
        let saved = (self.bodies.clone(), self.aliases.clone());
        let mut acc = Acc::default();
        let run = self.pattern_seeds(fi, p, seed_bodies, join_targets, &instances, &mut acc);
        if let Err(e) = run {
            (self.bodies, self.aliases) = saved;
            return Err(e);
        }
        // `removed` ([W0-40]): origins no body of the part carries afterwards.
        acc.removed
            .retain(|o| !self.bodies.iter().any(|b| b.origin == *o));
        let order = {
            let timeline =
                |o: &Origin| self.index_of.get(o.feature.as_str()).copied().unwrap_or(fi);
            let items: Vec<(usize, &Origin, &[f64; 3])> = acc
                .bodies
                .iter()
                .map(|b| (timeline(&b.origin), &b.origin, &b.centroid))
                .collect();
            canonical_perm(&items, scale_of(acc.bodies.iter()))
        };
        let mut slots: Vec<Option<BodyReport>> = acc.bodies.into_iter().map(Some).collect();
        entry.bodies = order.into_iter().filter_map(|i| slots[i].take()).collect();
        entry.removed = acc.removed;
        entry.warnings.extend(acc.warnings);
        entry.pattern = Some(PatternReport {
            instances: instances.len() as u32,
            skipped: acc.skipped.into_iter().collect(),
        });
        Ok(())
    }

    /// Apply every seed (body seeds, or the feature seeds in timeline order) to `instances`.
    fn pattern_seeds(
        &mut self,
        fi: usize,
        p: &PatternFeature,
        seed_bodies: Option<Vec<usize>>,
        join_targets: Option<Vec<usize>>,
        instances: &[Instance],
        acc: &mut Acc,
    ) -> Result<(), FeatureError> {
        if let Some(idx) = seed_bodies {
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
            let op = match join_targets {
                Some(_) => SeedOp::Body(BodyOp::Join),
                None => SeedOp::NewBody,
            };
            return self.apply_one_seed(fi, &p.id, op, &seeds, join_targets, instances, acc);
        }
        let PatternSeed::Features(ids) = &p.seed else {
            return Ok(());
        };
        let mut order: Vec<(usize, &str)> = ids
            .iter()
            .map(|id| {
                (
                    self.index_of
                        .get(id.as_str())
                        .copied()
                        .unwrap_or(usize::MAX),
                    id.as_str(),
                )
            })
            .collect();
        order.sort_unstable();
        order.dedup();
        for (si, sid) in order {
            if self.threaded_seeds.contains(sid) {
                return Err(FeatureError::new(
                    "FORGE_PATTERN_MODELED_THREAD",
                    format!(
                        "the seed {:?} is a hole with a modelled thread; a pattern would not \
                         thread its copies (place the holes with the hole's list, grid or \
                         circle placement instead)",
                        self.name_of(sid)
                    ),
                    json!({ "seed": sid }),
                ));
            }
            let Some(tools) = self.seeds.get(sid).cloned() else {
                return Err(FeatureError::new(
                    "FORGE_PATTERN_SEED_UNAVAILABLE",
                    format!("the seed {:?} kept no tools", self.name_of(sid)),
                    json!({ "seed": sid }),
                ));
            };
            let targets = match tools.op {
                SeedOp::NewBody => None,
                SeedOp::Body(_) | SeedOp::Hole => Some(self.seed_targets(fi, si)?),
            };
            self.apply_one_seed(fi, &p.id, tools.op, &tools.bodies, targets, instances, acc)?;
        }
        Ok(())
    }

    /// Apply one seed's tools to the instances and commit the result into `acc`.
    #[allow(clippy::too_many_arguments)]
    fn apply_one_seed(
        &mut self,
        fi: usize,
        pid: &str,
        op: SeedOp,
        seeds: &[SeedBody],
        targets: Option<Vec<usize>>,
        instances: &[Instance],
        acc: &mut Acc,
    ) -> Result<(), FeatureError> {
        let targets = targets.unwrap_or_default();
        let t_ops: Vec<forge_ops::OpBody> = targets.iter().map(|&i| self.op_body(i)).collect();
        let scale = scale_of(self.bodies.iter().map(|b| &b.metrics));
        let out = apply_seed(pid, fi, op, seeds, instances, &t_ops, Some(scale))?;
        acc.skipped
            .extend(out.skipped.iter().map(|s| s.index.clone()));
        // `PATTERN_INSTANCE_SKIPPED` first, then the operation's notes, then the hole
        // diagnostics of the kept instances.
        let (skips, diagnostics): (Vec<&PatternNote>, Vec<&PatternNote>) = out
            .notes
            .iter()
            .partition(|n| matches!(n, PatternNote::InstanceSkipped(_)));
        acc.warnings.extend(skips.into_iter().map(pattern_warning));
        let diagnostics: Vec<Warning> = diagnostics.into_iter().map(pattern_warning).collect();
        if !out.created.is_empty() {
            // `new_body` seeds: every copy is a new body (validity checked, measured).
            let mut made = Vec::with_capacity(out.created.len());
            for rb in out.created {
                made.push(PartBody::new(checked(rb.body)?, rb.origin, fi)?);
            }
            acc.bodies
                .extend(made.iter().map(|b| b.report(BodyChange::Created)));
            self.bodies.extend(made);
        }
        if let Some(res) = out.op {
            let bop = match op {
                SeedOp::Body(b) => b,
                SeedOp::Hole | SeedOp::NewBody => BodyOp::Cut,
            };
            let tools: Vec<forge_ops::OpBody> = out
                .tools
                .iter()
                .flat_map(|(_, t)| t.iter().cloned())
                .collect();
            let timeline_of = timelines(&t_ops, &tools);
            let c = self.commit_op(fi, bop, &targets, &[], res, &timeline_of)?;
            acc.merge(c);
        }
        acc.warnings.extend(diagnostics);
        Ok(())
    }

    /// The targets of feature seed `si` re-resolved in the pattern's scope (§6.10): its
    /// `targets` (`"all"`: every current body), or for a hole without `targets` the body owning
    /// its `on` face. Not fields of the pattern: no `refs` entry; a failed resolution fails the
    /// pattern with its code.
    fn seed_targets(&self, fi: usize, si: usize) -> Result<Vec<usize>, FeatureError> {
        let f = &self.part.features[si];
        let (targets, on) = match f {
            Feature::Extrude(e) => (e.targets.as_ref(), None),
            Feature::Revolve(r) => (r.targets.as_ref(), None),
            Feature::Hole(h) => (h.targets.as_ref(), Some(&h.on)),
            _ => (None, None),
        };
        let own = |r: &forge_ir::v1::Ref, field: &str, card: Cardinality| {
            let spec = FieldSpec {
                field: field.to_string(),
                card,
            };
            let res = self.with_scope(fi, |s: &Scope<'_>| forge_refs::resolve_with(r, s, &spec));
            match res.error {
                Some(e) => Err(FeatureError::new(
                    e.code,
                    &e.message,
                    Value::Object(e.details),
                )),
                None => Ok(res.members.iter().map(|m| m.entity).collect::<Vec<_>>()),
            }
        };
        let mut out: Vec<usize> = match (targets, on) {
            (Some(Targets::All(_)), _) => (0..self.bodies.len()).collect(),
            (Some(Targets::Ref(r)), _) => own(r, "/targets", Cardinality::SOME)?
                .iter()
                .map(|e| e.body)
                .collect(),
            (None, Some(PlaneRef::Face(pf))) => own(&pf.face, "/on/face", Cardinality::ONE)?
                .iter()
                .map(|e| e.body)
                .collect(),
            _ => {
                return Err(FeatureError::new(
                    "BOOLEAN_TARGETS_REQUIRED",
                    format!("the seed {:?} has no targets", self.name_of(f.id())),
                    json!({ "feature": f.id() }),
                ));
            }
        };
        out.sort_unstable();
        out.dedup();
        Ok(out)
    }

    /// The layout's numbers (§6.10): counts, spacings, the circular angle.
    fn layout_values(&self, p: &PatternFeature) -> Result<LayoutValues, FeatureError> {
        Ok(match &p.layout {
            PatternLayout::Linear(l) => {
                let second = match (&l.dir2, &l.spacing2) {
                    (None, None) if l.count2.is_none() => None,
                    (Some(_), Some(s2)) => Some((
                        match &l.count2 {
                            Some(c) => self.scalar(c, FieldType::Count)?,
                            None => 1.0,
                        },
                        self.scalar(s2, FieldType::Length)?,
                    )),
                    _ => {
                        // Validation rejects these ([W0-16]); defence in depth.
                        return Err(FeatureError::new(
                            "PATTERN_OPTIONS_CONFLICT",
                            "dir2 and spacing2 come together, and count2 needs them",
                            json!({ "fields": ["dir2", "count2", "spacing2"] }),
                        ));
                    }
                };
                LayoutValues::Linear {
                    count: self.scalar(&l.count, FieldType::Count)?,
                    spacing: self.scalar(&l.spacing, FieldType::Length)?,
                    second,
                }
            }
            PatternLayout::Circular(c) => LayoutValues::Circular {
                count: self.scalar(&c.count, FieldType::Count)?,
                angle: self.scalar(&c.angle, FieldType::Angle)?,
            },
            PatternLayout::Mirror(_) => LayoutValues::Mirror,
        })
    }

    /// The layout with its references resolved (step 3): the linear directions, the circular
    /// axis or the mirror plane.
    fn layout(
        &self,
        fi: usize,
        p: &PatternFeature,
        values: &LayoutValues,
        entry: &mut FeatureReport,
    ) -> Result<Layout, FeatureError> {
        let dir = |d: &forge_ir::v1::Dir, path: &str, entry: &mut FeatureReport| {
            let ev = self.with_scope(fi, |s| forge_refs::direction_eval(d, s, path));
            take_refs(ev.refs, entry);
            ev.result.map_err(FeatureError::from)
        };
        Ok(match (&p.layout, values) {
            (
                PatternLayout::Linear(l),
                &LayoutValues::Linear {
                    count,
                    spacing,
                    second,
                },
            ) => {
                let u1 = dir(&l.dir, "/layout/linear/dir", entry)?;
                let second = match (&l.dir2, second) {
                    (Some(d2), Some((c2, s2))) => {
                        Some((dir(d2, "/layout/linear/dir2", entry)?, c2, s2))
                    }
                    _ => None,
                };
                Layout::Linear(LinearLayout {
                    dir: u1,
                    count,
                    spacing,
                    second,
                })
            }
            (PatternLayout::Circular(c), &LayoutValues::Circular { count, angle }) => {
                let ev = self.with_scope(fi, |s| {
                    forge_refs::axis(&c.axis, s, "/layout/circular/axis")
                });
                take_refs(ev.refs, entry);
                let ax = ev.result?;
                Layout::Circular(CircularLayout {
                    origin: Vec3::from(ax.origin),
                    axis: Vec3::from(ax.direction),
                    count,
                    angle,
                })
            }
            (PatternLayout::Mirror(m), LayoutValues::Mirror) => {
                let frame = self.plane(fi, &m.plane, "/layout/mirror/plane", entry)?;
                Layout::Mirror(MirrorLayout {
                    origin: frame.origin(),
                    normal: frame.z(),
                })
            }
            _ => {
                return Err(FeatureError::new(
                    "FORGE_INTERNAL",
                    "pattern layout values do not match the layout",
                    json!({}),
                ));
            }
        })
    }
}

/// A pattern's warning in the report (§7.3): `PATTERN_INSTANCE_SKIPPED { index, code }`, or a
/// hole seed's engine-prefixed diagnostic `{ index, seed, at }`.
fn pattern_warning(n: &PatternNote) -> Warning {
    let message = match n {
        PatternNote::InstanceSkipped(s) => {
            format!("instance {:?} meets no target ({})", s.index, s.code)
        }
        PatternNote::HoleBreaksThrough(h) => format!(
            "instance {:?}: the copy of blind hole {:?} position {:?} breaks through",
            h.index, h.seed, h.at
        ),
        PatternNote::HolePositionMissed(h) => format!(
            "instance {:?}: the copy of hole {:?} position {:?} meets no target",
            h.index, h.seed, h.at
        ),
        PatternNote::HoleTopInside(h) => format!(
            "instance {:?}: the copy of hole {:?} position {:?} starts inside the material",
            h.index, h.seed, h.at
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
