//! One part studio's timeline (SPEC-v1 §7.1): each feature in order, the checks of §7.1 step 2
//! in their order, failed features passing their input through (step 3).

use std::collections::{BTreeMap, BTreeSet};

use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::Body;
use forge_ir::v1::expr::{ExprScope, feature_sites, parse};
use forge_ir::v1::metrics::{
    BodyChange, DatumReport, FeatureReport, Origin, Severity, Status, Warning,
};
use forge_ir::v1::{
    BodyOp as IrBodyOp, BooleanFeature, BooleanOp, Cardinality, Document, Feature, FieldType,
    LINEAR_TOLERANCE, PartStudio, PlaneRef, Ref, SP2, SP3, Scalar, SketchFeature, Targets,
};
use forge_ops::{BodyOp, OpBody, Region, check_revolve_profile, extrude, revolve, sketch_frame};
use forge_params::ParamValues;
use forge_refs::{
    DatumValue, EntityId, FeatureInfo, FeatureStatus, FeatureTable, FieldSpec, Junction,
    Resolution, Scope, ScopeBuilder, SweepRegion,
};
use forge_sketch::{SiteRef, SketchError, SketchResult, ValueError};
use serde_json::{Value, json};

use super::bodies::{PartBody, canonical_perm, scale_of};
use super::deps::{ByIdKind, by_id};
use super::error::{FeatureError, finite};
use crate::checked;

/// The feature types this engine evaluates (SPEC-v1 §6). [`super::load`] rejects every other
/// IR v1 type (§0.2 rule 3): the optional ones of [`super::REJECTED_FEATURE_TYPES`] with
/// `UNSUPPORTED_FEATURE`, the mandatory ones of [`super::UNIMPLEMENTED_FEATURE_TYPES`] (none
/// since Phase C) with `UNSUPPORTED_FEATURE_VERSION`.
pub const SUPPORTED_FEATURE_TYPES: [&str; 13] = [
    "sketch",
    "extrude",
    "revolve",
    "boolean",
    "hole",
    "fillet",
    "chamfer",
    "shell",
    "pattern",
    "datum_plane",
    "datum_axis",
    "tag",
    "thread",
];

/// Defensive, engine-internal feature error (SPEC-v1 §7.5 "engine-internal failures keep the
/// engine prefix"): a feature whose type is not in [`SUPPORTED_FEATURE_TYPES`] reached
/// evaluation because the caller built the [`Document`] without [`super::load`], which rejects
/// such documents (§0.2 rule 3). Never produced through `load` (the CLI, WASM and every report
/// of this crate's text entry points); details `{ type, supported }`.
pub const UNSUPPORTED_CODE: &str = "FORGE_UNSUPPORTED_FEATURE";

/// The info note of a body operation that left one or more of its targets as they were
/// (engine-prefixed, like `FORGE_BOOLEAN_UNCERTIFIED`; not a catalogue code, so `kernel-diff`
/// does not compare it): details `{ op, targets }` (the unchanged targets' origins, in
/// canonical order). SPEC-v1 §6.0.5 lists created or modified bodies only; such targets are in
/// neither `bodies` nor `removed`, so without this note nothing in the report would name them.
/// Raised for a join whose tools lie inside or equal a target, a join target no tool reaches,
/// and a cut target no tool meets; an intersect always lists every surviving target as
/// `modified` (forge-ops). Whether an unchanged join target counts as `modified` is an open W0
/// ruling (the oracle lists it).
pub const NO_CHANGE_CODE: &str = "FORGE_BOOLEAN_NO_CHANGE";

/// A sketch's outcome, for the features that consume it by id.
pub(super) enum SketchState {
    Suppressed,
    Failed { code: String, message: String },
    Done(Box<SketchResult>),
}

/// A feature seed's tool bodies **as evaluated at the seed** (SPEC-v1 §6.10), kept for the
/// patterns that name the feature in `seed.features`: an extrude's or revolve's tools (the
/// created bodies of a `new_body` sweep) with the keys forge-refs gives their entities (junction
/// qualifiers included), a hole's tools with their `HoleToolInfo`.
#[derive(Clone, Debug)]
pub(super) struct SeedTools {
    /// What the seed does with them.
    pub(super) op: forge_ops::pattern::SeedOp,
    /// The tools, in the seed's order (regions, or hole positions).
    pub(super) bodies: Vec<forge_ops::pattern::SeedBody>,
}

/// What committing a body operation's result produced for the feature entry (§6.0.5).
pub(super) struct Committed {
    /// The bodies created or modified, in the operation's (canonical) order.
    pub(super) bodies: Vec<forge_ir::v1::metrics::BodyReport>,
    /// Target origins no body of the part carries afterwards ([W0-40]).
    pub(super) removed: Vec<Origin>,
    /// The operation's notes (`BOOLEAN_SPLIT`, `BOOLEAN_BODY_CONSUMED`, the engine-prefixed
    /// `FORGE_BOOLEAN_NO_CHANGE` / `FORGE_BOOLEAN_UNCERTIFIED`), in the order raised.
    pub(super) warnings: Vec<Warning>,
}

/// The final state of a part (SPEC-v1 §7.2 `parts[]`).
#[derive(Clone, Debug)]
pub struct PartResult {
    /// Part name.
    pub part: String,
    /// Part id.
    pub part_id: String,
    /// Every body at the end of the timeline, in canonical order (§5.4).
    pub bodies: Vec<PartBody>,
}

/// Everything one part's evaluation produced.
pub(crate) struct PartRun {
    /// Feature report entries, in timeline order.
    pub(crate) features: Vec<FeatureReport>,
    /// The part's final state.
    pub(crate) part: PartResult,
    /// Key-invariant findings (only with [`PartEval::with_key_check`]).
    pub(crate) key_problems: Vec<String>,
    /// Every sketch that evaluated successfully, by sketch id.
    pub(crate) sketches: BTreeMap<String, Box<SketchResult>>,
}

/// The evaluation state of one part.
pub(crate) struct PartEval<'d> {
    doc: &'d Document,
    pub(super) pi: usize,
    pub(super) part: &'d PartStudio,
    pub(super) pv: &'d ParamValues,
    /// Every feature of the part as references see it (types, profiles, tags from the
    /// document; statuses, sweep regions and datum values as evaluation proceeds). The scope of
    /// feature `i` holds the first `i`.
    pub(super) infos: Vec<FeatureInfo>,
    /// Feature id → timeline index.
    pub(super) index_of: BTreeMap<&'d str, usize>,
    pub(super) sketches: BTreeMap<String, SketchState>,
    /// The part's current bodies.
    pub(super) bodies: Vec<PartBody>,
    /// Keys merged away by same-domain merging (§5.2 rule 3) → the surviving key.
    pub(super) aliases: BTreeMap<String, String>,
    /// Ids of the features some pattern of the part names in `seed.features` (§6.10): only
    /// these keep their tools ([`SeedTools`]).
    pub(super) seed_ids: BTreeSet<&'d str>,
    /// The tools of every evaluated seed feature, by feature id.
    pub(super) seeds: BTreeMap<String, SeedTools>,
    /// Seed holes whose thread is modelled: a pattern of them is refused
    /// (`FORGE_PATTERN_MODELED_THREAD`, the copies would not be threaded).
    pub(super) threaded_seeds: BTreeSet<String>,
    /// Feature report entries, in timeline order (suppressed features have none).
    pub(crate) features: Vec<FeatureReport>,
    /// Check the key invariant (SPEC-v1 §5.2 rule 3) after every feature that produced bodies.
    check_keys: bool,
    /// Its findings, `feature id: key: problem`.
    pub(crate) key_problems: Vec<String>,
}

impl<'d> PartEval<'d> {
    pub(crate) fn new(doc: &'d Document, pi: usize, pv: &'d ParamValues) -> Self {
        let part = &doc.parts[pi];
        let table = FeatureTable::from_part(part, part.features.len());
        PartEval {
            doc,
            pi,
            part,
            pv,
            infos: table.iter().cloned().collect(),
            index_of: part
                .features
                .iter()
                .enumerate()
                .map(|(i, f)| (f.id(), i))
                .collect(),
            sketches: BTreeMap::new(),
            bodies: Vec::new(),
            aliases: BTreeMap::new(),
            seed_ids: part
                .features
                .iter()
                .filter_map(|f| match f {
                    Feature::Pattern(p) => match &p.seed {
                        forge_ir::v1::PatternSeed::Features(ids) => Some(ids),
                        forge_ir::v1::PatternSeed::Bodies(_) => None,
                    },
                    _ => None,
                })
                .flatten()
                .map(String::as_str)
                .collect(),
            seeds: BTreeMap::new(),
            threaded_seeds: BTreeSet::new(),
            features: Vec::new(),
            check_keys: false,
            key_problems: Vec::new(),
        }
    }

    /// Also run the key invariant checker of forge-refs after every feature that produced
    /// bodies (the part's state with that feature in the table).
    pub(crate) fn with_key_check(mut self) -> Self {
        self.check_keys = true;
        self
    }

    /// Evaluate every feature in timeline order; returns the part's final state.
    pub(crate) fn run(self) -> (Vec<FeatureReport>, PartResult, Vec<String>) {
        let r = self.run_full();
        (r.features, r.part, r.key_problems)
    }

    /// [`PartEval::run`], also returning every sketch that evaluated (for the command layer's
    /// `writeBackSolution`, SPEC-v1 §0.6).
    pub(crate) fn run_full(mut self) -> PartRun {
        for (fi, f) in self.part.features.iter().enumerate() {
            if let Some(entry) = self.feature(fi, f) {
                let made_bodies = entry.status == Status::Ok && !entry.bodies.is_empty();
                self.features.push(entry);
                if self.check_keys && made_bodies {
                    let found = self.with_scope(fi + 1, |s| s.key_problems());
                    self.key_problems.extend(
                        found
                            .into_iter()
                            .map(|p| format!("{}: {}: {}", f.id(), p.key, p.problem)),
                    );
                }
            }
        }
        let mut bodies = std::mem::take(&mut self.bodies);
        super::bodies::canonical_bodies(&mut bodies);
        let sketches = std::mem::take(&mut self.sketches)
            .into_iter()
            .filter_map(|(id, s)| match s {
                SketchState::Done(r) => Some((id, r)),
                SketchState::Suppressed | SketchState::Failed { .. } => None,
            })
            .collect();
        PartRun {
            features: self.features,
            part: PartResult {
                part: self.part.name.clone(),
                part_id: self.part.id.clone(),
                bodies,
            },
            key_problems: self.key_problems,
            sketches,
        }
    }

    // ---- one feature -----------------------------------------------------------------------

    fn feature(&mut self, fi: usize, f: &'d Feature) -> Option<FeatureReport> {
        let mut entry = FeatureReport {
            part: self.part.name.clone(),
            feature: f.name().to_string(),
            feature_id: f.id().to_string(),
            feature_type: f.type_name().to_string(),
            status: Status::Ok,
            error: None,
            warnings: Vec::new(),
            regions: Vec::new(),
            sketch: None,
            datum: None,
            bodies: Vec::new(),
            removed: Vec::new(),
            refs: Vec::new(),
            holes: Vec::new(),
            fillet: None,
            chamfer: None,
            shell: None,
            pattern: None,
            thread: None,
        };
        // Suppressed features are skipped and produce no entry (v0); a `suppressed` expression
        // that cannot be evaluated fails the feature.
        match self.pv.boolean(self.pi, f.suppressed()) {
            Ok(true) => {
                self.infos[fi].status = FeatureStatus::Suppressed;
                if let Feature::Sketch(s) = f {
                    self.sketches.insert(s.id.clone(), SketchState::Suppressed);
                }
                return None;
            }
            Ok(false) => {}
            Err(e) => {
                self.fail(fi, f, &mut entry, e.into());
                return Some(entry);
            }
        }
        if let Err(e) = self.evaluate(fi, f, &mut entry) {
            self.fail(fi, f, &mut entry, e);
        }
        Some(entry)
    }

    /// A failed feature passes its input through (§7.1 step 3): nothing it computed is kept.
    fn fail(&mut self, fi: usize, f: &Feature, entry: &mut FeatureReport, e: FeatureError) {
        entry.status = Status::Error;
        entry.regions.clear();
        entry.sketch = None;
        entry.datum = None;
        entry.bodies.clear();
        entry.removed.clear();
        self.infos[fi].status = FeatureStatus::Failed {
            code: e.code.clone(),
            message: e.message.clone(),
        };
        self.infos[fi].datum = None;
        self.infos[fi].regions.clear();
        self.seeds.remove(f.id());
        if let Feature::Sketch(s) = f {
            self.sketches.insert(
                s.id.clone(),
                SketchState::Failed {
                    code: e.code.clone(),
                    message: e.message.clone(),
                },
            );
        }
        entry.error = Some(e.to_report());
    }

    /// §7.1 step 2, in order: `PARAM_FAILED` → features referenced by id → field
    /// expressions and range checks → references (field order) → the operation → the
    /// validity of every produced body.
    fn evaluate(
        &mut self,
        fi: usize,
        f: &'d Feature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        if let Some(fail) = self.pv.feature_failure(self.doc, self.pi, fi) {
            return Err(fail.into());
        }
        // Features referenced by id (§7.1 step 2: sketch, datum, tag, pattern seed), in field
        // order, before any field expression or range check of this feature.
        for (id, kind) in by_id(f) {
            match kind {
                ByIdKind::Sketch => self.sketch_dep(&id)?,
                ByIdKind::Datum | ByIdKind::Tag | ByIdKind::Seed => {
                    self.by_id_dep(fi, &id, kind)?
                }
            }
        }
        if !SUPPORTED_FEATURE_TYPES.contains(&f.type_name()) {
            // Unreachable through [`super::load`], which rejects the document (§0.2 rule 3:
            // `UNSUPPORTED_FEATURE_VERSION` / `UNSUPPORTED_FEATURE`). A caller that built the
            // document otherwise still never gets a guessed result: the feature fails with the
            // engine-internal code and passes its input through.
            return Err(FeatureError::new(
                UNSUPPORTED_CODE,
                format!(
                    "Forge does not evaluate {} features yet (supported: {})",
                    f.type_name(),
                    SUPPORTED_FEATURE_TYPES.join(", ")
                ),
                json!({ "type": f.type_name(), "supported": SUPPORTED_FEATURE_TYPES }),
            ));
        }
        // Field expressions (§7.1): every expression site of the feature, in field order, so
        // an `EXPR_DOMAIN` / `EXPR_NOT_INTEGER` is reported with its own code before any
        // range check, reference or operation.
        for site in feature_sites(self.pi, self.part, f, fi) {
            self.pv.eval_expr(site.scope, site.text, site.field)?;
        }
        match f {
            Feature::Sketch(s) => self.sketch(fi, s, entry),
            Feature::Extrude(_) | Feature::Revolve(_) => self.sweep(fi, f, entry),
            Feature::Boolean(b) => self.boolean(fi, b, entry),
            Feature::DatumPlane(d) => {
                let ev = self.with_scope(fi, |s| forge_refs::datum_plane(d, s, ""));
                take_refs(ev.refs, entry);
                let frame = ev.result?;
                entry.datum = Some(DatumReport::Plane(frame.to_report()));
                self.infos[fi].datum = Some(DatumValue::Plane(frame));
                Ok(())
            }
            Feature::DatumAxis(d) => {
                let ev = self.with_scope(fi, |s| forge_refs::datum_axis(d, s, ""));
                take_refs(ev.refs, entry);
                let line = ev.result?;
                entry.datum = Some(DatumReport::Axis(line.to_report()));
                self.infos[fi].datum = Some(DatumValue::Axis(line));
                Ok(())
            }
            Feature::Tag(t) => {
                self.resolve(fi, &t.target, "/target", Cardinality::SOME, entry)?;
                Ok(())
            }
            Feature::Hole(h) => self.hole(fi, h, entry),
            Feature::Thread(t) => self.thread(fi, t, entry),
            Feature::Pattern(p) => self.pattern(fi, p, entry),
            Feature::Fillet(x) => self.fillet(fi, x, entry),
            Feature::Chamfer(x) => self.chamfer(fi, x, entry),
            Feature::Shell(x) => self.shell(fi, x, entry),
            // Unreachable: failed above with FORGE_UNSUPPORTED_FEATURE (the optional `draft`,
            // §6.9, is rejected by `load`).
            Feature::Draft(_) => Err(FeatureError::new(
                "FORGE_INTERNAL",
                "unsupported feature reached evaluation",
                json!({}),
            )),
        }
    }

    // ---- dependencies by id (§7.1) ----------------------------------------------------------

    pub(super) fn name_of(&self, id: &str) -> String {
        self.index_of.get(id).map_or_else(
            || id.to_string(),
            |&i| self.part.features[i].name().to_string(),
        )
    }

    /// The consumed sketch of a sweep: `SKETCH_SUPPRESSED`, `DEPENDENCY_FAILED` (v0 [R-1]).
    fn sketch_dep(&self, id: &str) -> Result<(), FeatureError> {
        let name = self.name_of(id);
        match self.sketches.get(id) {
            Some(SketchState::Done(_)) => Ok(()),
            Some(SketchState::Suppressed) => Err(FeatureError::new(
                "SKETCH_SUPPRESSED",
                format!("sketch {name:?} is suppressed"),
                json!({ "sketch": id }),
            )),
            Some(SketchState::Failed { code, message }) => Err(FeatureError::new(
                "DEPENDENCY_FAILED",
                format!("sketch {name:?} failed with {code}: {message}"),
                json!({ "feature": id, "code": code, "message": message }),
            )),
            // Validation rejects references to non-sketches and forward references.
            None => Err(FeatureError::new(
                "UNRESOLVED_SKETCH",
                format!("{id:?} is not an earlier sketch of this part"),
                json!({ "sketch": id }),
            )),
        }
    }

    /// A datum, tag or pattern seed referenced by id: `DEPENDENCY_SUPPRESSED`,
    /// `DEPENDENCY_FAILED` (§7.1 step 2, §7.5).
    fn by_id_dep(&self, fi: usize, id: &str, kind: ByIdKind) -> Result<(), FeatureError> {
        let name = self.name_of(id);
        let noun = kind.noun();
        match self.index_of.get(id).filter(|&&i| i < fi) {
            // Validation rejects these (UNRESOLVED_FEATURE, stage R); defence in depth.
            None => Err(FeatureError::new(
                "UNRESOLVED_FEATURE",
                format!("{id:?} is not an earlier feature of this part"),
                json!({ "id": id, "field": noun, "expected": match kind {
                    ByIdKind::Datum => "datum_plane or datum_axis",
                    ByIdKind::Tag => "tag",
                    ByIdKind::Seed | ByIdKind::Sketch => "an earlier feature",
                } }),
            )),
            Some(&i) => match &self.infos[i].status {
                FeatureStatus::Suppressed => Err(FeatureError::new(
                    "DEPENDENCY_SUPPRESSED",
                    format!("{noun} {name:?} is suppressed"),
                    json!({ "feature": id }),
                )),
                FeatureStatus::Failed { code, message } => Err(FeatureError::new(
                    "DEPENDENCY_FAILED",
                    format!("{noun} {name:?} failed with {code}: {message}"),
                    json!({ "feature": id, "code": code, "message": message }),
                )),
                FeatureStatus::Ok => Ok(()),
            },
        }
    }

    // ---- scopes and references ------------------------------------------------------------

    /// Run `f` with the scope of feature `fi` (§5.3): the part's current bodies, the earlier
    /// features, the aliases of merged keys, and the W1 evaluator behind the expression hooks.
    pub(super) fn with_scope<R>(&self, fi: usize, f: impl FnOnce(&Scope<'_>) -> R) -> R {
        let (pv, pi) = (self.pv, self.pi);
        let num = move |t: &str| hook_num(pv, pi, t);
        let boolean = move |t: &str| hook_bool(pv, pi, t);
        let mut table = FeatureTable::new();
        for info in &self.infos[..fi] {
            table.push(info.clone());
        }
        let mut b = ScopeBuilder::new(table).scalars(&num).bools(&boolean);
        for pb in &self.bodies {
            b = b.body(&pb.body, pb.origin.clone());
        }
        for (alias, key) in &self.aliases {
            b = b.alias(alias.clone(), key.clone());
        }
        let scope = b.build();
        f(&scope)
    }

    /// Resolve one Ref-valued field (§5.7); its report entry and warnings go into `entry`.
    pub(super) fn resolve(
        &self,
        fi: usize,
        r: &Ref,
        field: &str,
        card: Cardinality,
        entry: &mut FeatureReport,
    ) -> Result<Resolution, FeatureError> {
        let spec = FieldSpec {
            field: field.to_string(),
            card,
        };
        let res = self.with_scope(fi, |s| forge_refs::resolve_with(r, s, &spec));
        entry.refs.push(res.report.clone());
        entry.warnings.extend(res.warnings.iter().cloned());
        match &res.error {
            Some(e) => Err(FeatureError::new(
                e.code.clone(),
                &e.message,
                Value::Object(e.details.clone()),
            )),
            None => Ok(res),
        }
    }

    /// The part bodies a body reference resolves to (indices into the current bodies).
    pub(super) fn resolve_bodies(
        &self,
        fi: usize,
        r: &Ref,
        field: &str,
        entry: &mut FeatureReport,
    ) -> Result<Vec<usize>, FeatureError> {
        let res = self.resolve(fi, r, field, Cardinality::SOME, entry)?;
        let mut idx: Vec<usize> = res
            .members
            .iter()
            .filter(|m| m.entity.id == EntityId::Body)
            .map(|m| m.entity.body)
            .collect();
        if idx.len() != res.members.len() {
            return Err(FeatureError::new(
                "REF_KIND_MISMATCH",
                format!("{field}: a body reference resolved to entities that are not bodies"),
                json!({ "field": field, "expected": "body", "found": "face, edge or vertex" }),
            ));
        }
        idx.sort_unstable();
        idx.dedup();
        Ok(idx)
    }

    // ---- values -----------------------------------------------------------------------------

    pub(super) fn scalar(&self, s: &Scalar, field: FieldType) -> Result<f64, FeatureError> {
        Ok(self.pv.scalar(self.pi, s, field)?)
    }

    pub(super) fn p2(&self, v: &SP2, field: FieldType) -> Result<[f64; 2], FeatureError> {
        Ok([self.scalar(&v[0], field)?, self.scalar(&v[1], field)?])
    }

    pub(super) fn p3(&self, v: &SP3, field: FieldType) -> Result<[f64; 3], FeatureError> {
        Ok([
            self.scalar(&v[0], field)?,
            self.scalar(&v[1], field)?,
            self.scalar(&v[2], field)?,
        ])
    }

    // ---- sketches (§4) ----------------------------------------------------------------------

    fn sketch(
        &mut self,
        fi: usize,
        s: &SketchFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let (pv, pi) = (self.pv, self.pi);
        let values = move |site: &SiteRef<'_>| -> Result<f64, ValueError> {
            pv.scalar(pi, &Scalar::Expr(site.text.to_string()), site.field)
                .map_err(|f| ValueError::new(f.code, f.message, Value::Object(f.details)))
        };
        let constrained = !s.constraints.is_empty();
        // The curves' values and checks, then the plane, then the operation (solve, regions):
        // regions are computed in sketch coordinates, the frame is only carried along.
        let result = forge_sketch::evaluate_sketch(s, &values, &Frame::world());
        if let Err(e) = &result
            && before_plane(e, constrained)
        {
            return Err(e.clone().into());
        }
        let frame = self.plane(fi, &s.plane, "/plane", entry)?;
        let mut r = result?;
        r.frame = frame;
        entry.regions = r.region_metrics();
        entry.sketch = Some(r.trace.clone());
        entry.warnings.extend(r.warnings.iter().cloned());
        self.sketches
            .insert(s.id.clone(), SketchState::Done(Box::new(r)));
        Ok(())
    }

    /// The frame of a sketch plane (§3.1). Named planes and explicit frames use the v0
    /// construction (so migrated v0 documents keep their exact frames); faces and datums
    /// go through forge-refs.
    pub(super) fn plane(
        &self,
        fi: usize,
        p: &PlaneRef,
        path: &str,
        entry: &mut FeatureReport,
    ) -> Result<Frame, FeatureError> {
        Ok(self.plane_on(fi, p, path, entry)?.0)
    }

    /// [`PartEval::plane`], also returning the face a `{ "face": Ref }` plane resolved to
    /// (a hole's `on` face, §6.5: positions must lie on it, and it names the default target).
    pub(super) fn plane_on(
        &self,
        fi: usize,
        p: &PlaneRef,
        path: &str,
        entry: &mut FeatureReport,
    ) -> Result<(Frame, Option<forge_refs::Entity>), FeatureError> {
        match p {
            PlaneRef::Face(_) => {
                let ev = self.with_scope(fi, |s| forge_refs::plane_frame(p, s, path));
                let face_field = format!("{path}/face");
                let face = ev
                    .refs
                    .iter()
                    .find(|r| r.report.field == face_field)
                    .and_then(|r| r.members.first())
                    .map(|m| m.entity);
                take_refs(ev.refs, entry);
                let pf = ev.result?;
                let frame = pf.to_frame().ok_or_else(|| {
                    FeatureError::new(
                        "FORGE_INTERNAL",
                        format!("{path}: the evaluated plane frame is degenerate"),
                        json!({ "field": path }),
                    )
                })?;
                Ok((frame, face))
            }
            _ => Ok((self.plane_frame_of(fi, p, path, entry)?, None)),
        }
    }

    fn plane_frame_of(
        &self,
        fi: usize,
        p: &PlaneRef,
        path: &str,
        entry: &mut FeatureReport,
    ) -> Result<Frame, FeatureError> {
        match p {
            PlaneRef::Named(n) => Ok(sketch_frame(&forge_ir::PlaneSpec::Named(*n))?),
            PlaneRef::Frame(fp) => {
                let o = self.p3(&fp.origin, FieldType::Length)?;
                let n = self.p3(&fp.normal, FieldType::Ratio)?;
                let x = self.p3(&fp.x_dir, FieldType::Ratio)?;
                let computed = fp
                    .normal
                    .iter()
                    .chain(&fp.x_dir)
                    .any(|s| s.literal().is_none());
                if computed {
                    check_frame(n, x, path)?;
                }
                Ok(sketch_frame(&forge_ir::PlaneSpec::Frame(
                    forge_ir::Frame {
                        origin: o,
                        normal: n,
                        x_dir: x,
                    },
                ))?)
            }
            PlaneRef::Face(_) | PlaneRef::Datum(_) => {
                let ev = self.with_scope(fi, |s| forge_refs::plane_frame(p, s, path));
                take_refs(ev.refs, entry);
                let pf = ev.result?;
                pf.to_frame().ok_or_else(|| {
                    FeatureError::new(
                        "FORGE_INTERNAL",
                        format!("{path}: the evaluated plane frame is degenerate"),
                        json!({ "field": path }),
                    )
                })
            }
        }
    }

    // ---- extrude and revolve (§6.2, §6.3) ---------------------------------------------------

    fn sweep(
        &mut self,
        fi: usize,
        f: &'d Feature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        enum Sweep {
            Extrude(f64),
            Revolve(forge_ir::SketchAxis, f64),
        }
        let (sketch_id, selection, direction, op, targets) = match f {
            Feature::Extrude(e) => (&e.sketch, &e.regions, e.direction, e.op, &e.targets),
            Feature::Revolve(r) => (&r.sketch, &r.regions, r.direction, r.op, &r.targets),
            _ => unreachable!("sweep() is called for extrude and revolve only"),
        };
        let fid = f.id();
        // Range checks on the evaluated values (§0.5 rule 2: the literal codes and paths).
        let kind = match f {
            Feature::Extrude(e) => {
                let d = self.scalar(&e.distance, FieldType::Length)?;
                if d.is_nan() || d <= LINEAR_TOLERANCE {
                    return Err(FeatureError::new(
                        "INVALID_DISTANCE",
                        format!("distance = {d}: must be > 1e-6"),
                        json!({ "field": "distance", "value": finite(d), "expected": "> 1e-6" }),
                    ));
                }
                Sweep::Extrude(d)
            }
            Feature::Revolve(r) => {
                let a = self.scalar(&r.angle, FieldType::Angle)?;
                if a.is_nan() || a <= 0.0 || a > 360.0 {
                    return Err(FeatureError::new(
                        "INVALID_ANGLE",
                        format!("angle = {a}: must be in (0, 360]"),
                        json!({ "field": "angle", "value": finite(a), "expected": "in (0, 360]" }),
                    ));
                }
                let origin = self.p2(&r.axis.origin, FieldType::Length)?;
                let dir = self.p2(&r.axis.direction, FieldType::Ratio)?;
                let len = dir[0].hypot(dir[1]);
                if len.is_nan() || len <= LINEAR_TOLERANCE {
                    return Err(FeatureError::new(
                        "INVALID_AXIS",
                        "the revolve axis direction must be non-zero",
                        json!({ "field": "axis", "value": [finite(dir[0]), finite(dir[1])],
                                "expected": "a non-zero direction" }),
                    ));
                }
                Sweep::Revolve(
                    forge_ir::SketchAxis {
                        origin,
                        direction: dir,
                    },
                    a,
                )
            }
            _ => unreachable!("sweep() is called for extrude and revolve only"),
        };
        let (frame, regions) = {
            let Some(SketchState::Done(sk)) = self.sketches.get(sketch_id.as_str()) else {
                return Err(FeatureError::new(
                    "FORGE_INTERNAL",
                    "the consumed sketch has no result",
                    json!({ "sketch": sketch_id }),
                ));
            };
            let regions: Vec<Region> = sk.select_regions(selection)?.into_iter().cloned().collect();
            (sk.frame, regions)
        };
        if regions.is_empty() {
            // A sketch without profile curves (points and construction geometry only).
            return Err(FeatureError::new(
                "SKETCH_NO_REGIONS",
                format!("sketch {:?} yields no regions", self.name_of(sketch_id)),
                json!({ "sketch": sketch_id }),
            ));
        }
        // References (§6.0.2): the targets, before the operation.
        let targets = match op {
            IrBodyOp::NewBody => None,
            _ => Some(match targets {
                Some(Targets::All(_)) => (0..self.bodies.len()).collect(),
                Some(Targets::Ref(r)) => self.resolve_bodies(fi, r, "/targets", entry)?,
                None => {
                    return Err(FeatureError::new(
                        "BOOLEAN_TARGETS_REQUIRED",
                        "a body operation needs explicit targets",
                        json!({ "feature": fid }),
                    ));
                }
            }),
        };
        // The operation: one tool body per region, in canonical region order (v0 §4).
        if let Sweep::Revolve(axis, _) = &kind {
            // v0 [R-7]: one crossing region fails the whole feature.
            for r in &regions {
                check_revolve_profile(r, axis, forge_core::Tolerance::IR_DEFAULT.linear)?;
            }
        }
        let mut tools: Vec<(Body, Origin)> = Vec::with_capacity(regions.len());
        for r in &regions {
            let body = match &kind {
                Sweep::Extrude(d) => extrude(r, &frame, *d, direction, fid)?,
                Sweep::Revolve(axis, a) => revolve(r, &frame, axis, *a, direction, fid)?,
            };
            let member = r
                .outer_curves
                .iter()
                .min_by(|a, b| a.as_bytes().cmp(b.as_bytes()))
                .cloned()
                .unwrap_or_default();
            tools.push((
                checked(body)?,
                Origin {
                    feature: fid.to_string(),
                    member,
                    instance: None,
                },
            ));
        }
        self.infos[fi].regions = regions.iter().map(|r| sweep_region(r, &frame)).collect();
        // A pattern seed (§6.10) keeps its tools as evaluated here, keyed as forge-refs keys
        // them (with this feature's regions, so junction edges carry their `@c.end`).
        if self.seed_ids.contains(fid) {
            let seed = SeedTools {
                op: match op {
                    IrBodyOp::NewBody => forge_ops::pattern::SeedOp::NewBody,
                    IrBodyOp::Join => forge_ops::pattern::SeedOp::Body(BodyOp::Join),
                    IrBodyOp::Cut => forge_ops::pattern::SeedOp::Body(BodyOp::Cut),
                    IrBodyOp::Intersect => forge_ops::pattern::SeedOp::Body(BodyOp::Intersect),
                },
                bodies: self.tool_seed_bodies(fi, &tools),
            };
            self.seeds.insert(fid.to_string(), seed);
        }
        match (op, targets) {
            (IrBodyOp::NewBody, _) | (_, None) => {
                let mut made = Vec::with_capacity(tools.len());
                for (body, origin) in tools {
                    made.push(PartBody::new(body, origin, fi)?);
                }
                let order = {
                    let scale = scale_of(made.iter().map(|b| &b.metrics));
                    let items: Vec<(usize, &Origin, &[f64; 3])> = made
                        .iter()
                        .map(|b| (b.timeline, &b.origin, &b.metrics.centroid))
                        .collect();
                    canonical_perm(&items, scale)
                };
                entry.bodies = order
                    .iter()
                    .map(|&i| made[i].report(BodyChange::Created))
                    .collect();
                self.bodies.extend(made);
                Ok(())
            }
            (op, Some(targets)) => {
                let op = match op {
                    IrBodyOp::Join => BodyOp::Join,
                    IrBodyOp::Cut => BodyOp::Cut,
                    _ => BodyOp::Intersect,
                };
                let tools = tools
                    .into_iter()
                    .map(|(body, origin)| OpBody {
                        body,
                        origin,
                        timeline: fi,
                    })
                    .collect();
                self.body_op(fi, op, &targets, tools, &[], entry)
            }
        }
    }

    // ---- boolean (§6.4) ---------------------------------------------------------------------

    fn boolean(
        &mut self,
        fi: usize,
        b: &BooleanFeature,
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let keep_tools = self.pv.boolean(self.pi, &b.keep_tools)?;
        let targets = self.resolve_bodies(fi, &b.targets, "/targets", entry)?;
        let tools = self.resolve_bodies(fi, &b.tools, "/tools", entry)?;
        if let Some(&i) = targets.iter().find(|i| tools.contains(i)) {
            let o = &self.bodies[i].origin;
            return Err(FeatureError::new(
                "BOOLEAN_TOOL_IS_TARGET",
                format!(
                    "body {}/{} is both a target and a tool",
                    o.feature, o.member
                ),
                json!({ "origin": o }),
            ));
        }
        let op = match b.op {
            BooleanOp::Join => BodyOp::Join,
            BooleanOp::Cut => BodyOp::Cut,
            BooleanOp::Intersect => BodyOp::Intersect,
        };
        let tool_bodies: Vec<OpBody> = tools.iter().map(|&i| self.op_body(i)).collect();
        let consumed: Vec<usize> = if keep_tools { Vec::new() } else { tools };
        self.body_op(fi, op, &targets, tool_bodies, &consumed, entry)
    }

    pub(super) fn op_body(&self, i: usize) -> OpBody {
        let b = &self.bodies[i];
        OpBody {
            body: b.body.clone(),
            origin: b.origin.clone(),
            timeline: b.timeline,
        }
    }

    /// Apply a body operation (§6.0.3) to the current bodies `targets` with `tools`; the
    /// current bodies `consumed` (a boolean's tools) disappear with the targets.
    fn body_op(
        &mut self,
        fi: usize,
        op: BodyOp,
        targets: &[usize],
        tools: Vec<OpBody>,
        consumed: &[usize],
        entry: &mut FeatureReport,
    ) -> Result<(), FeatureError> {
        let fid = self.part.features[fi].id();
        if targets.is_empty() {
            // `targets: "all"` in a part without bodies: no tool can meet a target.
            return Err(FeatureError::new(
                "BOOLEAN_NO_INTERSECTION",
                "the operation has no target bodies",
                json!({ "tool": tools.first().map(|t| &t.origin), "min_distance": null }),
            ));
        }
        let scale = scale_of(self.bodies.iter().map(|b| &b.metrics));
        let t_ops: Vec<OpBody> = targets.iter().map(|&i| self.op_body(i)).collect();
        let timeline_of = timelines(&t_ops, &tools);
        let res = forge_ops::apply_body_op_in_scope(op, &t_ops, &tools, fid, scale)?;
        let c = self.commit_op(fi, op, targets, consumed, res, &timeline_of)?;
        entry.bodies = c.bodies;
        entry.removed = c.removed;
        entry.warnings.extend(c.warnings);
        Ok(())
    }

    /// Commit a body operation's result (§6.0.3, §6.0.5): every produced body passes the
    /// validity check and is measured ([R-12]) before anything changes; then the `targets`
    /// (indices into the current bodies) are replaced — untouched ones stay — and `consumed`
    /// bodies disappear; the aliases of same-domain merges are recorded. A failure leaves the
    /// part as it was. `timeline_of` maps the operands' origin features to their timeline
    /// index (canonical order of `removed`).
    ///
    /// `removed` ([W0-40]) is forge-ops' list of target origins that no result body or
    /// untouched target carries, minus the origins bodies of the part outside the operation
    /// still carry; `merged_into` keys are never added back (a merged origin whose sibling
    /// piece survives elsewhere did not vanish — kernel-fixes review finding 1).
    pub(super) fn commit_op(
        &mut self,
        fi: usize,
        op: BodyOp,
        targets: &[usize],
        consumed: &[usize],
        res: forge_ops::BodyOpResult,
        timeline_of: &BTreeMap<String, usize>,
    ) -> Result<Committed, FeatureError> {
        // SPEC [R-12]: every produced body passes Forge's validity check, then is measured.
        let mut produced: Vec<(PartBody, BodyChange)> = Vec::with_capacity(res.bodies.len());
        for rb in res.bodies {
            let timeline = timeline_of
                .get(&rb.origin.feature)
                .copied()
                .or_else(|| self.index_of.get(rb.origin.feature.as_str()).copied())
                .unwrap_or(fi);
            produced.push((
                PartBody::new(checked(rb.body)?, rb.origin, timeline)?,
                rb.change,
            ));
        }
        // Commit: targets are replaced (untouched ones stay), consumed tools disappear.
        let untouched: BTreeSet<usize> = res
            .untouched_targets
            .iter()
            .filter_map(|&k| targets.get(k).copied())
            .collect();
        let gone: BTreeSet<usize> = targets
            .iter()
            .copied()
            .filter(|i| !untouched.contains(i))
            .chain(consumed.iter().copied())
            .collect();
        let old = std::mem::take(&mut self.bodies);
        self.bodies = old
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !gone.contains(i))
            .map(|(_, b)| b)
            .collect();
        let bodies = produced.iter().map(|(b, c)| b.report(*c)).collect();
        self.bodies.extend(produced.into_iter().map(|(b, _)| b));
        // `removed` ([W0-40]): target origins no body of the part carries afterwards.
        let mut removed: Vec<Origin> = res.removed.clone();
        removed.retain(|o| !self.bodies.iter().any(|b| b.origin == *o));
        removed.sort_by(|a, b| {
            let ta = timeline_of.get(&a.feature).copied().unwrap_or(usize::MAX);
            let tb = timeline_of.get(&b.feature).copied().unwrap_or(usize::MAX);
            ta.cmp(&tb)
                .then_with(|| a.member.as_bytes().cmp(b.member.as_bytes()))
                .then_with(|| a.instance.cmp(&b.instance))
        });
        removed.dedup();
        let mut warnings = Vec::new();
        for n in &res.notes {
            let (message, severity) = match n {
                forge_ops::boolean::BooleanNote::Split { origin, pieces } => (
                    format!(
                        "body {}/{} was split into {pieces} pieces",
                        origin.feature, origin.member
                    ),
                    Severity::Info,
                ),
                forge_ops::boolean::BooleanNote::Consumed { origin } => (
                    format!("body {}/{} was consumed", origin.feature, origin.member),
                    Severity::Warning,
                ),
            };
            warnings.push(Warning {
                code: n.code().to_string(),
                severity,
                message,
                details: match serde_json::to_value(n) {
                    Ok(Value::Object(m)) => m,
                    _ => serde_json::Map::new(),
                },
            });
        }
        if !res.untouched_targets.is_empty() {
            // Targets left as they were (a join target no tool reaches, a cut target no tool
            // meets): they stay in the part but are in neither `bodies` (§6.0.5 lists created
            // or modified bodies only) nor `removed`, so this note names them — whether some or
            // all targets were left unchanged.
            let name = match op {
                BodyOp::Join => "join",
                BodyOp::Cut => "cut",
                BodyOp::Intersect => "intersect",
            };
            let (k, n) = (res.untouched_targets.len(), targets.len());
            let mut details = serde_json::Map::new();
            details.insert("op".into(), json!(name));
            details.insert("targets".into(), json!(res.untouched));
            warnings.push(Warning {
                code: NO_CHANGE_CODE.into(),
                severity: Severity::Info,
                message: if k == n {
                    format!(
                        "the {name} left every target body as it was (no tool changes a target)"
                    )
                } else {
                    format!("the {name} left {k} of its {n} target bodies as they were")
                },
                details,
            });
        }
        if res.uncertified {
            warnings.push(Warning {
                code: "FORGE_BOOLEAN_UNCERTIFIED".into(),
                severity: Severity::Info,
                message:
                    "an intersection was not certified complete, or an operand's volume could \
                          not be measured (the result passed the validity and volume checks)"
                        .into(),
                details: serde_json::Map::new(),
            });
        }
        for (alias, key) in res.aliases {
            self.aliases.insert(alias, key);
        }
        Ok(Committed {
            bodies,
            removed,
            warnings,
        })
    }

    /// The seed bodies of the tools `(body, origin)` of feature `fi` (SPEC §6.10 "tool bodies
    /// as evaluated at the seed"), each with the keys forge-refs gives its entities in a scope
    /// of the tools alone (the earlier features and `fi`, whose regions are set): the copies of
    /// a pattern are keyed `P/copy:{K}@q` from exactly these `K`.
    pub(super) fn tool_seed_bodies(
        &self,
        fi: usize,
        tools: &[(Body, Origin)],
    ) -> Vec<forge_ops::pattern::SeedBody> {
        let mut table = FeatureTable::new();
        for info in &self.infos[..=fi] {
            table.push(info.clone());
        }
        let mut b = ScopeBuilder::new(table);
        for (body, origin) in tools {
            b = b.body(body, origin.clone());
        }
        let scope = b.build();
        tools
            .iter()
            .enumerate()
            .map(|(k, (body, origin))| forge_ops::pattern::SeedBody {
                body: body.clone(),
                origin: origin.clone(),
                keys: Some(scope_keys(&scope, k)),
                hole: None,
            })
            .collect()
    }
}

/// The origin feature → timeline index of the operands of a body operation.
pub(super) fn timelines(targets: &[OpBody], tools: &[OpBody]) -> BTreeMap<String, usize> {
    targets
        .iter()
        .chain(tools)
        .map(|o| (o.origin.feature.clone(), o.timeline))
        .collect()
}

/// The keys forge-refs gives every face, edge and vertex of body `b` of `scope` (SPEC §5.2),
/// as forge-ops' pattern copies take them.
pub(super) fn scope_keys(scope: &Scope<'_>, b: usize) -> forge_ops::pattern::SeedKeys {
    let body = scope.body(Scope::body_entity(b));
    let key = |id: EntityId| scope.key(forge_refs::Entity { body: b, id }).to_string();
    forge_ops::pattern::SeedKeys {
        faces: body
            .faces()
            .iter()
            .map(|(f, _)| (f, key(EntityId::Face(f))))
            .collect(),
        edges: body
            .edges()
            .iter()
            .map(|(e, _)| (e, key(EntityId::Edge(e))))
            .collect(),
        vertices: body
            .vertices()
            .iter()
            .map(|(v, _)| (v, key(EntityId::Vertex(v))))
            .collect(),
    }
}

/// Every resolution's report entry and warnings, in order, into the feature entry.
pub(super) fn take_refs(refs: Vec<Resolution>, entry: &mut FeatureReport) {
    for r in refs {
        entry.warnings.extend(r.warnings);
        entry.refs.push(r.report);
    }
}

/// Sketch errors found before the plane is resolved (§7.1: field values and range checks come
/// before references): every error of an explicit sketch but the region stage; the values of a
/// constrained sketch (solving and the solved geometry's checks are the operation).
fn before_plane(e: &SketchError, constrained: bool) -> bool {
    match e {
        SketchError::Regions(_)
        | SketchError::Solver(_)
        | SketchError::Conflict { .. }
        | SketchError::SolveFailed { .. } => false,
        SketchError::DegenerateCurve { .. } | SketchError::LimitExceeded { .. } => !constrained,
        _ => true,
    }
}

/// An expression-driven explicit frame (§3.1, v0 §2): `INVALID_PLANE` for zero or
/// non-perpendicular vectors, the test validation applies to literals ([W0-8]).
fn check_frame(n: [f64; 3], x: [f64; 3], path: &str) -> Result<(), FeatureError> {
    let len = |v: [f64; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    let (ln, lx) = (len(n), len(x));
    if ln.is_nan() || lx.is_nan() || ln <= LINEAR_TOLERANCE || lx <= LINEAR_TOLERANCE {
        return Err(FeatureError::new(
            "INVALID_PLANE",
            "degenerate frame",
            json!({ "field": path, "reason": "zero-length normal or x_dir" }),
        ));
    }
    let c = (n[0] * x[0] + n[1] * x[1] + n[2] * x[2]) / (ln * lx);
    if c.is_nan() || c.abs() > 1e-9 {
        return Err(FeatureError::new(
            "INVALID_PLANE",
            format!("normal and x_dir must be perpendicular (cos = {c:e})"),
            json!({ "field": path, "reason": "normal and x_dir are not perpendicular" }),
        ));
    }
    Ok(())
}

/// The region a sweep created a body from, as references see it (§5.2 rules 3–4): its curves
/// and its junctions in world coordinates.
fn sweep_region(r: &Region, frame: &Frame) -> SweepRegion {
    SweepRegion {
        outer_curves: r.outer_curves.clone(),
        inner_curves: {
            let mut v: Vec<String> = r.holes.iter().flat_map(|l| l.sorted_ids()).collect();
            v.sort();
            v
        },
        junctions: r
            .loops()
            .flat_map(|l| l.junctions.iter())
            .map(|j| Junction {
                key: j.key.clone(),
                point: frame
                    .to_world_point(Vec3::new(j.point.x, j.point.y, 0.0))
                    .to_array(),
            })
            .collect(),
    }
}

/// The scope's number hook: any expression text of the part, evaluated with W1's evaluator
/// (the value does not depend on the use-site type; every site was type-checked by
/// validation and evaluated before the feature's references).
fn hook_num(pv: &ParamValues, pi: usize, text: &str) -> Option<f64> {
    let v = hook_value(pv, pi, text)?;
    v.as_num().map(forge_params::no_neg_zero)
}

fn hook_bool(pv: &ParamValues, pi: usize, text: &str) -> Option<bool> {
    hook_value(pv, pi, text)?.as_bool()
}

fn hook_value(pv: &ParamValues, pi: usize, text: &str) -> Option<forge_params::Value> {
    let e = parse(text).ok()?;
    let scope = ExprScope::Part(pi);
    if pv.failed_use(scope, &e).is_some() {
        return None;
    }
    let lookup = |name: &str| pv.lookup(scope, name)?.result.as_ref().ok().copied();
    forge_params::eval(&e, &lookup).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_with_zero_or_skew_vectors_are_invalid_planes() {
        assert!(check_frame([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], "/plane").is_ok());
        let e = check_frame([0.0, 0.0, 1.0], [1.0, 0.0, 1e-3], "/plane").unwrap_err();
        assert_eq!(e.code, "INVALID_PLANE");
        let e = check_frame([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], "/plane").unwrap_err();
        assert_eq!(e.code, "INVALID_PLANE");
        let e = check_frame([f64::NAN, 0.0, 1.0], [1.0, 0.0, 0.0], "/plane").unwrap_err();
        assert_eq!(e.code, "INVALID_PLANE");
    }
}
