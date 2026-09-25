//! `fillet`, `chamfer` and `shell` (SPEC-v1 §6.6–§6.8) in the timeline: W6's `forge-blend` on
//! the part's state.
//!
//! Order of checks (§7.1 step 2):
//! 1. **values and range checks**: `r` (`INVALID_RADIUS`), `d` / `d2` / `thickness`
//!    (`INVALID_VALUE`, `> 1e-6`), the chamfer `angle` (`INVALID_VALUE`, `in (0, 90)`: the code
//!    and range validation uses for literals, §0.5 rule 2), `tangent_chain`;
//! 2. **references** in field order: `/edges` (edge, `some`) and `/side` (face, `one`); `/body`
//!    (body, `one`) and `/open` (face, `any`);
//! 3. **the operation**: forge-blend on each body the edges lie on (in the order the edges'
//!    bodies first appear: a blend is a per-body construction, and the feature is atomic — any
//!    body failing fails the feature), with the keys and display names forge-refs gives the
//!    body's entities (so `details` and the report name entities as queries do);
//! 4. the validity of every produced body ([R-12]).
//!
//! The modified bodies keep their origins; the report gets `fillet` / `chamfer`
//! (`{ edges, chain_added, faces_created }`, concatenated over the bodies) or `shell`
//! (`{ removed_faces, closed_void? }`) and, for a shell without open faces, the info
//! `SHELL_CLOSED_VOID`.
//!
//! `draft` (§6.9, optional): the `angle` in (0, 45) (`INVALID_VALUE`), `/faces` (face,
//! `some`), the `neutral` plane (its references), then `forge-blend`'s draft on each body the
//! faces lie on, the pull direction being the neutral plane's normal (reversed for
//! `pull: reverse`). Drafted faces keep their keys; the report lists the modified bodies.

use forge_blend::{
    BlendOptions, BlendOutput, ChamferSpec, DraftOptions, DraftSpec, KeyMap, Pick, ShellOptions,
};
use forge_core::topo::{Body, EdgeId, FaceId};
use forge_ir::v1::metrics::{BlendReport, BodyChange, FeatureReport, Origin, Severity, Warning};
use forge_ir::v1::{
    Cardinality, ChamferFeature, DraftFeature, FieldType, FilletFeature, LINEAR_TOLERANCE,
    PullDirection, Ref, ShellFeature,
};
use forge_refs::{Entity, EntityId, Scope};
use serde_json::json;

use super::bodies::{PartBody, canonical_perm, scale_of};
use super::error::{FeatureError, finite};
use super::part::PartEval;
use crate::checked;

/// `code` for `field = value` outside `expected` (the shape of validation's range errors).
fn range(code: &str, field: &str, value: f64, expected: &str) -> FeatureError {
    FeatureError::new(
        code,
        format!("{field} = {value}: must be {expected}"),
        json!({ "field": field, "value": finite(value), "expected": expected }),
    )
}

/// A length that must be `> tol`.
fn positive(code: &str, field: &str, v: f64) -> Result<f64, FeatureError> {
    if v.is_finite() && v > LINEAR_TOLERANCE {
        Ok(v)
    } else {
        Err(range(code, field, v, &format!("> {LINEAR_TOLERANCE}")))
    }
}

/// The keys and display names forge-refs gives every entity of body `b` of `scope`.
fn key_map(scope: &Scope<'_>, b: usize) -> KeyMap {
    let body = scope.body(Scope::body_entity(b));
    let mut km = KeyMap::default();
    let e = |id: EntityId| Entity { body: b, id };
    for (f, _) in body.faces().iter() {
        let x = e(EntityId::Face(f));
        km.set_face(f, scope.key(x), scope.display_name(x));
    }
    for (id, _) in body.edges().iter() {
        let x = e(EntityId::Edge(id));
        km.set_edge(id, scope.key(x), scope.display_name(x));
    }
    for (v, _) in body.vertices().iter() {
        let x = e(EntityId::Vertex(v));
        km.set_vertex(v, scope.key(x), scope.display_name(x));
    }
    km
}

/// A fillet's or chamfer's operation on one body.
enum BlendKind {
    Fillet(f64),
    Chamfer(ChamferForm),
}

/// A chamfer's form with its `side` face still an entity of the scope.
enum ChamferForm {
    Equal(f64),
    TwoDistances(f64, f64, Entity),
    DistanceAngle(f64, f64, Entity),
}

impl PartEval<'_> {
    /// Evaluate fillet feature `x` at timeline index `fi` (see the module docs).
    pub(super) fn fillet(
        &mut self,
        fi: usize,
        x: &FilletFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let r = positive("INVALID_RADIUS", "r", self.scalar(&x.r, FieldType::Length)?)?;
        let chain = self.pv.boolean(self.pi, &x.tangent_chain)?;
        let edges = self.resolve_all(fi, &x.edges, "/edges", Cardinality::SOME, entry)?;
        let report = self.blend(fi, &edges, chain, &BlendKind::Fillet(r), entry)?;
        entry.fillet = Some(report);
        Ok(())
    }

    /// Evaluate chamfer feature `x` at timeline index `fi` (see the module docs).
    pub(super) fn chamfer(
        &mut self,
        fi: usize,
        x: &ChamferFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let d = positive("INVALID_VALUE", "d", self.scalar(&x.d, FieldType::Length)?)?;
        let d2 = match &x.d2 {
            Some(v) => Some(positive(
                "INVALID_VALUE",
                "d2",
                self.scalar(v, FieldType::Length)?,
            )?),
            None => None,
        };
        let angle = match &x.angle {
            Some(v) => {
                let a = self.scalar(v, FieldType::Angle)?;
                if !(a.is_finite() && a > 0.0 && a < 90.0) {
                    return Err(range("INVALID_VALUE", "angle", a, "in (0, 90)"));
                }
                Some(a)
            }
            None => None,
        };
        let chain = self.pv.boolean(self.pi, &x.tangent_chain)?;
        let edges = self.resolve_all(fi, &x.edges, "/edges", Cardinality::SOME, entry)?;
        let side = match &x.side {
            Some(r) => Some(self.resolve_entity(fi, r, "/side", Cardinality::ONE, entry)?),
            None => None,
        };
        let form = match (d2, angle, side) {
            (None, None, None) => ChamferForm::Equal(d),
            (Some(d2), None, Some(s)) => ChamferForm::TwoDistances(d, d2, s),
            (None, Some(a), Some(s)) => ChamferForm::DistanceAngle(d, a, s),
            _ => {
                // Validation rejects these (§6.7); defence in depth.
                return Err(FeatureError::new(
                    "CHAMFER_OPTIONS_CONFLICT",
                    "a chamfer is { d }, { d, d2, side } or { d, angle, side }",
                    json!({ "fields": ["d", "d2", "angle", "side"] }),
                ));
            }
        };
        let report = self.blend(fi, &edges, chain, &BlendKind::Chamfer(form), entry)?;
        entry.chamfer = Some(report);
        Ok(())
    }

    /// Evaluate shell feature `x` at timeline index `fi` (see the module docs).
    pub(super) fn shell(
        &mut self,
        fi: usize,
        x: &ShellFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let t = positive(
            "INVALID_VALUE",
            "thickness",
            self.scalar(&x.thickness, FieldType::Length)?,
        )?;
        let body = self.resolve_entity(fi, &x.body, "/body", Cardinality::ONE, entry)?;
        if body.id != EntityId::Body {
            return Err(kind_mismatch("/body", "body"));
        }
        let open = match &x.open {
            Some(r) => self.resolve_all(fi, r, "/open", Cardinality::ANY, entry)?,
            None => Vec::new(),
        };
        let b = body.body;
        let out = self.with_scope(fi, |s| {
            let picks: Vec<Pick<FaceId>> = open
                .iter()
                .filter_map(|e| match e.id {
                    EntityId::Face(f) => Some(Pick::new(e.body, f, s.key(*e))),
                    _ => None,
                })
                .collect();
            if picks.len() != open.len() {
                return Err(kind_mismatch("/open", "face"));
            }
            let opts = ShellOptions {
                feature: self.part.features[fi].id().to_string(),
                keys: Some(key_map(s, b)),
                body: b,
            };
            Ok(forge_blend::shell(
                &self.bodies[b].body,
                &picks,
                t,
                x.direction,
                &opts,
            )?)
        })?;
        let closed = out.report.closed_void;
        entry.bodies = self.replace_bodies(vec![(b, out.body)])?;
        entry.shell = Some(out.report);
        if closed {
            entry.warnings.push(Warning {
                code: "SHELL_CLOSED_VOID".into(),
                severity: Severity::Info,
                message: "the shell has no open face: the body gets an internal void".into(),
                details: serde_json::Map::new(),
            });
        }
        Ok(())
    }

    /// Evaluate draft feature `x` at timeline index `fi` (see the module docs).
    pub(super) fn draft(
        &mut self,
        fi: usize,
        x: &DraftFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let a = self.scalar(&x.angle, FieldType::Angle)?;
        if !(a.is_finite() && a > 0.0 && a < 45.0) {
            return Err(range("INVALID_VALUE", "angle", a, "in (0, 45)"));
        }
        let faces = self.resolve_all(fi, &x.faces, "/faces", Cardinality::SOME, entry)?;
        let frame = self.plane(fi, &x.neutral, "/neutral", entry)?;
        let n = frame.z();
        let pull = match x.pull {
            PullDirection::Normal => n,
            PullDirection::Reverse => -n,
        };
        let spec = DraftSpec {
            neutral_origin: frame.origin(),
            neutral_normal: n,
            pull,
            angle_deg: a,
        };
        let mut per_body: Vec<(usize, Vec<FaceId>)> = Vec::new();
        for e in &faces {
            let EntityId::Face(id) = e.id else {
                return Err(kind_mismatch("/faces", "face"));
            };
            match per_body.iter_mut().find(|(b, _)| *b == e.body) {
                Some((_, v)) => v.push(id),
                None => per_body.push((e.body, vec![id])),
            }
        }
        let fid = self.part.features[fi].id().to_string();
        let made: Vec<(usize, Body)> = self.with_scope(fi, |s| {
            let mut out = Vec::with_capacity(per_body.len());
            for (b, ids) in &per_body {
                let picks: Vec<Pick<FaceId>> = ids
                    .iter()
                    .map(|&id| {
                        Pick::new(
                            *b,
                            id,
                            s.key(Entity {
                                body: *b,
                                id: EntityId::Face(id),
                            }),
                        )
                    })
                    .collect();
                let opts = DraftOptions {
                    feature: fid.clone(),
                    keys: Some(key_map(s, *b)),
                    body: *b,
                };
                out.push((
                    *b,
                    forge_blend::draft(&self.bodies[*b].body, &picks, &spec, &opts)?,
                ));
            }
            Ok::<_, FeatureError>(out)
        })?;
        entry.bodies = self.replace_bodies(made)?;
        Ok(())
    }

    /// Resolve a Ref-valued field (§5.7) to its entities, in canonical order.
    fn resolve_all(
        &self,
        fi: usize,
        r: &Ref,
        field: &str,
        card: Cardinality,
        entry: &mut FeatureReport,
    ) -> Result<Vec<Entity>, FeatureError> {
        Ok(self.resolve(fi, r, field, card, entry)?.entities())
    }

    /// Blend `edges` (fillet or chamfer) on each body they lie on; returns the merged report
    /// block after committing the modified bodies.
    fn blend(
        &mut self,
        fi: usize,
        edges: &[Entity],
        chain: bool,
        kind: &BlendKind,
        entry: &mut FeatureReport,
    ) -> Result<BlendReport, FeatureError> {
        let mut per_body: Vec<(usize, Vec<EdgeId>)> = Vec::new();
        for e in edges {
            let EntityId::Edge(id) = e.id else {
                return Err(kind_mismatch("/edges", "edge"));
            };
            match per_body.iter_mut().find(|(b, _)| *b == e.body) {
                Some((_, v)) => v.push(id),
                None => per_body.push((e.body, vec![id])),
            }
        }
        let fid = self.part.features[fi].id().to_string();
        let outs: Vec<(usize, BlendOutput)> = self.with_scope(fi, |s| {
            let mut outs = Vec::with_capacity(per_body.len());
            for (b, ids) in &per_body {
                let picks: Vec<Pick<EdgeId>> = ids
                    .iter()
                    .map(|&id| {
                        Pick::new(
                            *b,
                            id,
                            s.key(Entity {
                                body: *b,
                                id: EntityId::Edge(id),
                            }),
                        )
                    })
                    .collect();
                let opts = BlendOptions {
                    feature: fid.clone(),
                    tangent_chain: chain,
                    keys: Some(key_map(s, *b)),
                    body: *b,
                };
                let body: &Body = &self.bodies[*b].body;
                let face_pick = |e: &Entity| -> Result<Pick<FaceId>, FeatureError> {
                    match e.id {
                        EntityId::Face(f) => Ok(Pick::new(e.body, f, s.key(*e))),
                        _ => Err(kind_mismatch("/side", "face")),
                    }
                };
                let out = match kind {
                    BlendKind::Fillet(r) => forge_blend::fillet(body, &picks, *r, &opts)?,
                    BlendKind::Chamfer(form) => {
                        let spec = match form {
                            ChamferForm::Equal(d) => ChamferSpec::Equal { d: *d },
                            ChamferForm::TwoDistances(d, d2, side) => ChamferSpec::TwoDistances {
                                d: *d,
                                d2: *d2,
                                side: face_pick(side)?,
                            },
                            ChamferForm::DistanceAngle(d, a, side) => ChamferSpec::DistanceAngle {
                                d: *d,
                                angle_deg: *a,
                                side: face_pick(side)?,
                            },
                        };
                        forge_blend::chamfer(body, &picks, &spec, &opts)?
                    }
                };
                outs.push((*b, out));
            }
            Ok::<_, FeatureError>(outs)
        })?;
        let mut report = BlendReport {
            edges: Vec::new(),
            chain_added: Vec::new(),
            faces_created: Vec::new(),
        };
        let mut made = Vec::with_capacity(outs.len());
        for (b, out) in outs {
            report.edges.extend(out.report.edges);
            report.chain_added.extend(out.report.chain_added);
            report.faces_created.extend(out.report.faces_created);
            made.push((b, out.body));
        }
        entry.bodies = self.replace_bodies(made)?;
        Ok(report)
    }

    /// Replace bodies of the part (index, new body) by their blended or shelled versions: same
    /// origin and timeline, validity checked and measured ([R-12]) before anything changes.
    /// Returns their `modified` reports in canonical order.
    fn replace_bodies(
        &mut self,
        made: Vec<(usize, Body)>,
    ) -> Result<Vec<forge_ir::v1::metrics::BodyReport>, FeatureError> {
        let mut new: Vec<(usize, PartBody)> = Vec::with_capacity(made.len());
        for (b, body) in made {
            let old = &self.bodies[b];
            new.push((
                b,
                PartBody::new(checked(body)?, old.origin.clone(), old.timeline)?,
            ));
        }
        let reports: Vec<forge_ir::v1::metrics::BodyReport> = new
            .iter()
            .map(|(_, pb)| pb.report(BodyChange::Modified))
            .collect();
        for (b, pb) in new {
            self.bodies[b] = pb;
        }
        let order = {
            let items: Vec<(usize, &Origin, &[f64; 3])> = new_items(&reports, self);
            canonical_perm(&items, scale_of(reports.iter()))
        };
        let mut slots: Vec<Option<forge_ir::v1::metrics::BodyReport>> =
            reports.into_iter().map(Some).collect();
        Ok(order.into_iter().filter_map(|i| slots[i].take()).collect())
    }
}

/// Canonical-order items of body reports (timeline of the origin feature).
fn new_items<'a>(
    reports: &'a [forge_ir::v1::metrics::BodyReport],
    pe: &PartEval<'_>,
) -> Vec<(usize, &'a Origin, &'a [f64; 3])> {
    reports
        .iter()
        .map(|r| {
            (
                pe.index_of
                    .get(r.origin.feature.as_str())
                    .copied()
                    .unwrap_or(usize::MAX),
                &r.origin,
                &r.centroid,
            )
        })
        .collect()
}

/// `REF_KIND_MISMATCH` for a field that resolved to the wrong kind of entity (static typing
/// prevents it; defence in depth).
fn kind_mismatch(field: &str, expected: &str) -> FeatureError {
    FeatureError::new(
        "REF_KIND_MISMATCH",
        format!("{field}: the reference resolved to entities that are not of kind {expected}"),
        json!({ "field": field, "expected": expected, "found": "another kind" }),
    )
}
