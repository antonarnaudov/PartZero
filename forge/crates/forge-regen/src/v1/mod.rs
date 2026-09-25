//! # IR v1 evaluation (`aicad.ir/1` → `aicad.metrics/1`)
//!
//! [`evaluate`] runs a (validated) v1 document per SPEC-v1 §7.1 on top of the workstream
//! crates:
//!
//! | Step | Crate | SPEC |
//! |---|---|---|
//! | parameters, feature expressions, `PARAM_FAILED` | `forge-params` (W1) | §2.7, §2.8 |
//! | explicit and constrained sketches, regions by member | `forge-sketch` (W2) | §4 |
//! | plane/axis references, datums, tags, body references | `forge-refs` (W3) | §3, §5 |
//! | `join` / `cut` / `intersect` on extrude, revolve and `boolean` | `forge-ops` booleans (W4) | §6.0.3–§6.0.5, §6.4 |
//! | `hole`, `pattern` (linear, circular, mirror; feature and body seeds) | `forge-ops` holes and patterns (W5) | §6.5, §6.10 |
//! | `fillet`, `chamfer`, `shell` | `forge-blend` (W6) | §6.6–§6.8 |
//!
//! Per feature, the checks of §7.1 step 2 run in order and the first failure decides the code:
//! `PARAM_FAILED` → features referenced by id (`SKETCH_SUPPRESSED`, `DEPENDENCY_SUPPRESSED`,
//! `DEPENDENCY_FAILED`) → field expressions (`EXPR_DOMAIN`, `EXPR_NOT_INTEGER`) and range
//! checks (`INVALID_DISTANCE`, …) → references in field order (`REF_*`) → the operation →
//! the validity of every produced body (`INVALID_RESULT`, v0 [R-12]). A failed feature passes
//! its input through; later features still run.
//!
//! The features a feature references **by id** — its sketch, `{ "datum" }` planes and axes,
//! the tags of `{ "op": "tagged" }` queries anywhere in its Refs, pattern seeds — are checked
//! in field order before its expressions (§7.1 step 2), so a failed or suppressed tag decides
//! the code even when a range check of the feature would also fail.
//!
//! Feature types (SPEC-v1 §0.2 rule 3, §7.5 stages): every mandatory type is evaluated
//! ([`SUPPORTED_FEATURE_TYPES`], Phase C: `hole`, `pattern`, `fillet`, `chamfer`, `shell`
//! joined). The **rejections** (stage R, CLI exit 2, no feature is evaluated), exactly as the
//! frozen text states them:
//! - the optional `draft` (§6.9), which this engine does not implement: [`load`] runs the
//!   rejection pipeline with [`validate_options`], so a document using it gets
//!   `UNSUPPORTED_FEATURE` at the feature's `/type` (suppressed or not: rule 3 is about the
//!   document);
//! - a mandatory type this build does not implement ([`UNIMPLEMENTED_FEATURE_TYPES`], empty
//!   since Phase C; kept for the next type): "an engine that does not implement a feature's `v`
//!   rejects the document with `UNSUPPORTED_FEATURE_VERSION` (path of the `v` field)" —
//!   [`load`] adds one problem per such feature at `…/features/<i>/v`, details
//!   `{ type, v, supported: [] }`. [`evaluate`] of a document that bypassed [`load`] never
//!   evaluates an unsupported type: the feature fails with the engine-internal
//!   [`UNSUPPORTED_CODE`].
//!
//! A join or cut that leaves targets as they were (tools inside or equal to a target, a cut
//! tool missing a target, a join target no tool reaches) does not list them in `bodies`
//! (§6.0.5: created or modified bodies only) and carries the info note
//! `FORGE_BOOLEAN_NO_CHANGE` naming them (details `{ op, targets }`), whether some or every
//! target was left unchanged. Whether an unchanged join target counts as `modified` is an open
//! W0 ruling (the oracle lists it; see `tests/v1_oracle_known_differences.json`).
//!
//! Provenance is stamped with **feature ids** (SPEC-v1 §5.2 rule 1); bodies carry their
//! origin (§5.2 rule 4) through booleans; `parts[].bodies` is the final state of each part in
//! canonical order (§5.4).
//!
//! v0 documents: [`load`] migrates them (SPEC-v1 §9.1) and records the migration report. The
//! v0 path of this crate ([`crate::evaluate`], [`crate::report`]) is unchanged and still
//! produces the `aicad.metrics/0` report byte for byte; engines choose the report version.
//!
//! Deterministic: every map is ordered, bodies are ordered canonically, and all numerics come
//! from the workstream crates (bit-identical on every target).

mod blend;
mod bodies;
mod deps;
mod error;
mod hole;
mod part;
mod pattern;
mod ref_for;

use forge_ir::v1::metrics::{EvalReport, ParamReport, PartReport, ReportError, Status};
use forge_ir::v1::{
    Document, Feature, IR_SCHEMA, LoadError, METRICS_SCHEMA, MigrationReport, ValidationError,
};
use serde_json::{Value, json};

pub use bodies::PartBody;
pub use error::FeatureError;
pub use forge_ir::v1::metrics::FeatureReport;
pub use part::{NO_CHANGE_CODE, PartResult, SUPPORTED_FEATURE_TYPES, UNSUPPORTED_CODE};
pub use ref_for::{Pick, RefFor, RefForError, RefForMember, ref_for};

/// Optional IR v1 feature types this engine does not implement (SPEC-v1 §6.9: `draft`).
/// [`load`] rejects documents that use them with `UNSUPPORTED_FEATURE` at the feature's `/type`
/// (§0.2 rule 3, §7.5 stage R).
pub const REJECTED_FEATURE_TYPES: [&str; 1] = ["draft"];

/// Mandatory IR v1 feature types this build does not implement yet: none since Phase C
/// (`hole`, `pattern`: W5; `fillet`, `chamfer`, `shell`: W6). [`load`] rejects a document that
/// uses one with `UNSUPPORTED_FEATURE_VERSION` at the feature's `/v` (SPEC-v1 §0.2 rule 3;
/// details `{ type, v, supported: [] }`, §7.5). Together with [`SUPPORTED_FEATURE_TYPES`] and
/// [`REJECTED_FEATURE_TYPES`] this partitions `forge_ir::v1::FEATURE_TYPES`; a future mandatory
/// type starts here until it is implemented.
pub const UNIMPLEMENTED_FEATURE_TYPES: [&str; 0] = [];

/// The code of [`load`]'s rejection of an [`UNIMPLEMENTED_FEATURE_TYPES`] feature.
pub const UNIMPLEMENTED_CODE: &str = "UNSUPPORTED_FEATURE_VERSION";

/// This engine's options for the rejection pipeline of SPEC-v1 §0.5 rule 4: W1's expression
/// checker (step 5) and the optional types it rejects ([`REJECTED_FEATURE_TYPES`]). Every entry
/// point that loads a v1 document for evaluation by this crate uses them.
pub fn validate_options() -> forge_ir::v1::ValidateOptions<'static> {
    forge_ir::v1::ValidateOptions {
        expr: Some(&forge_ir::v1::expr::CHECKER),
        unsupported_features: &REJECTED_FEATURE_TYPES,
    }
}

/// The evaluation of a v1 document.
#[derive(Clone, Debug)]
pub struct Evaluation {
    /// Every parameter (document parameters first, then per part, in declaration order).
    pub params: Vec<ParamReport>,
    /// One entry per non-suppressed feature, in timeline order over all parts.
    pub features: Vec<FeatureReport>,
    /// The final bodies of each part, in part order.
    pub parts: Vec<PartResult>,
}

impl Evaluation {
    /// `true` iff every parameter and every feature is ok (§7.2).
    pub fn is_ok(&self) -> bool {
        self.params.iter().all(|p| p.error.is_none())
            && self.features.iter().all(|f| f.status == Status::Ok)
    }
}

/// Evaluate a (validated) v1 document (SPEC-v1 §7.1).
pub fn evaluate(doc: &Document) -> Evaluation {
    run(doc, false).0
}

/// [`evaluate`], also running forge-refs' key invariant checker (SPEC-v1 §5.2 rule 3:
/// every key complete, unique within its body except split pieces) on the part's bodies after
/// every feature that produced bodies. Returns its findings as `feature id: key: problem`.
/// Not part of the report: a diagnostic for tests and the integration gates (booleans still
/// leave alias sources that the checker flags, a known contract issue of W3/W4).
pub fn evaluate_with_key_check(doc: &Document) -> (Evaluation, Vec<String>) {
    run(doc, true)
}

fn run(doc: &Document, check_keys: bool) -> (Evaluation, Vec<String>) {
    let pv = forge_params::evaluate(doc);
    let mut features = Vec::new();
    let mut parts = Vec::with_capacity(doc.parts.len());
    let mut problems = Vec::new();
    for pi in 0..doc.parts.len() {
        let mut pe = part::PartEval::new(doc, pi, &pv);
        if check_keys {
            pe = pe.with_key_check();
        }
        let (f, p, k) = pe.run();
        features.extend(f);
        parts.push(p);
        problems.extend(k);
    }
    (
        Evaluation {
            params: pv.report(),
            features,
            parts,
        },
        problems,
    )
}

/// The `aicad.metrics/1` report of an evaluation (§7.2). `document` is the document's
/// `meta.name` or file stem; `migration` is the report of a v0 input's migration (kept only
/// when it rewrote ids, [W0-16]).
pub fn report(
    ev: &Evaluation,
    engine: &str,
    document: &str,
    migration: Option<&MigrationReport>,
) -> EvalReport {
    EvalReport {
        schema: METRICS_SCHEMA.to_string(),
        engine: engine.to_string(),
        document: document.to_string(),
        status: if ev.is_ok() {
            Status::Ok
        } else {
            Status::Error
        },
        error: None,
        migration: migration.filter(|m| !m.renames.is_empty()).cloned(),
        params: ev.params.clone(),
        features: ev.features.clone(),
        parts: ev
            .parts
            .iter()
            .map(|p| PartReport {
                part: p.part.clone(),
                part_id: p.part_id.clone(),
                bodies: p.bodies.iter().map(|b| b.metrics.clone()).collect(),
            })
            .collect(),
    }
}

/// The parameter block of a (validated) document's report (§7.2 `params`, §2.7–§2.8): every
/// parameter's value or failure, without evaluating any feature. The same entries, in the same
/// order, as [`evaluate`]'s `params`.
pub fn params(doc: &Document) -> Vec<ParamReport> {
    forge_params::evaluate(doc).report()
}

// ---- command layer: writeBackSolution (SPEC-v1 §0.6, §4.4 rule 9) ------------------------------

/// A command-layer failure (not an IR report code): the op was not applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandError {
    /// `WRITE_BACK_UNKNOWN_SKETCH`: a requested id is not a sketch of the document.
    pub code: &'static str,
    /// Human-readable message (never echoes an id that fails the id grammar).
    pub message: String,
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for CommandError {}

/// A sketch [`write_back`] did not write.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteBackSkip {
    /// Sketch id.
    pub sketch: String,
    /// `explicit` (no constraints: nothing to write), `suppressed`, or `failed` (the sketch's
    /// evaluation failed; `code` says why, and its stored geometry is left as it was).
    pub reason: &'static str,
    /// The failed sketch's error code.
    pub code: Option<String>,
}

impl WriteBackSkip {
    /// `{ "sketch", "reason", "code"? }`.
    pub fn to_json(&self) -> Value {
        let mut o = serde_json::Map::new();
        o.insert("sketch".into(), json!(self.sketch));
        o.insert("reason".into(), json!(self.reason));
        if let Some(c) = &self.code {
            o.insert("code".into(), json!(c));
        }
        Value::Object(o)
    }
}

/// Result of [`write_back`].
#[derive(Clone, Debug, PartialEq)]
pub struct WriteBack {
    /// The document with the solved geometry of every written sketch (nothing else changes).
    pub doc: Document,
    /// The sketches written (constrained, solved successfully), in document order.
    pub written: Vec<String>,
    /// Requested sketches (or, with no request, constrained ones) that were not written.
    pub skipped: Vec<WriteBackSkip>,
}

/// The command layer's `writeBackSolution` (SPEC-v1 §0.6): evaluate the document and replace
/// the literal geometry of each constrained sketch that solved successfully by its solution
/// (`forge_sketch::write_back`, §4.4 rule 9: the solved coordinates, nothing else). `only`
/// restricts it to those sketch ids (every one must be a sketch of the document, else
/// `WRITE_BACK_UNKNOWN_SKETCH` and nothing is written); `None` writes back every constrained
/// sketch. Explicit sketches are never changed. Pure: the input is not modified.
///
/// Idempotent where forge-sketch's fixed point holds (every stored end already welded as
/// solved): `write_back(write_back(d).doc).doc == write_back(d).doc`.
pub fn write_back(doc: &Document, only: Option<&[String]>) -> Result<WriteBack, CommandError> {
    if let Some(ids) = only {
        for id in ids {
            let found = doc
                .parts
                .iter()
                .flat_map(|p| &p.features)
                .any(|f| matches!(f, Feature::Sketch(s) if &s.id == id));
            if !found {
                let shown = if forge_ir::v1::ids::is_id(id) {
                    format!("{id:?}")
                } else {
                    format!("(an invalid id of {} bytes)", id.len())
                };
                return Err(CommandError {
                    code: "WRITE_BACK_UNKNOWN_SKETCH",
                    message: format!("{shown} is not the id of a sketch of the document"),
                });
            }
        }
    }
    let pv = forge_params::evaluate(doc);
    let mut out = doc.clone();
    let mut written = Vec::new();
    let mut skipped = Vec::new();
    for pi in 0..doc.parts.len() {
        let run = part::PartEval::new(doc, pi, &pv).run_full();
        for (fi, f) in doc.parts[pi].features.iter().enumerate() {
            let Feature::Sketch(s) = f else {
                continue;
            };
            let requested = only.is_some_and(|ids| ids.contains(&s.id));
            if only.is_some() && !requested {
                continue;
            }
            if s.constraints.is_empty() {
                if requested {
                    skipped.push(WriteBackSkip {
                        sketch: s.id.clone(),
                        reason: "explicit",
                        code: None,
                    });
                }
                continue;
            }
            let entry = run.features.iter().find(|e| e.feature_id == s.id);
            match (run.sketches.get(&s.id), entry) {
                (Some(r), _) => match forge_sketch::write_back(s, r) {
                    Some(ws) => {
                        out.parts[pi].features[fi] = Feature::Sketch(ws);
                        written.push(s.id.clone());
                    }
                    None => skipped.push(WriteBackSkip {
                        sketch: s.id.clone(),
                        reason: "explicit",
                        code: None,
                    }),
                },
                (None, None) => skipped.push(WriteBackSkip {
                    sketch: s.id.clone(),
                    reason: "suppressed",
                    code: None,
                }),
                (None, Some(e)) => skipped.push(WriteBackSkip {
                    sketch: s.id.clone(),
                    reason: "failed",
                    code: e.error.as_ref().map(|x| x.code.clone()),
                }),
            }
        }
    }
    Ok(WriteBack {
        doc: out,
        written,
        skipped,
    })
}

/// The report of a rejected document (§7.2 [W0-16]): `error` is the first rejection, and
/// `details.errors` lists every one (`{ code, path, message, details }`). A document that is
/// not JSON (or not the schema's shape) is `IR_PARSE_ERROR`.
pub fn rejected_report(err: &LoadError, engine: &str, document: &str) -> EvalReport {
    let (code, message, errors): (String, String, Vec<Value>) = match err {
        LoadError::Parse { path, message } => (
            "IR_PARSE_ERROR".into(),
            message.clone(),
            vec![
                json!({ "code": "IR_PARSE_ERROR", "path": path.clone().unwrap_or_default(),
                         "message": message, "details": {} }),
            ],
        ),
        LoadError::Invalid(errs) => (
            errs.first().map_or("IR_INVALID", |e| e.code).to_string(),
            errs.iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; "),
            errs.iter()
                .map(|e| {
                    json!({ "code": e.code, "path": e.path, "message": e.message,
                            "details": e.details })
                })
                .collect(),
        ),
    };
    let mut details = serde_json::Map::new();
    details.insert("errors".into(), Value::Array(errors));
    EvalReport {
        schema: METRICS_SCHEMA.to_string(),
        engine: engine.to_string(),
        document: document.to_string(),
        status: Status::Error,
        error: Some(ReportError {
            code,
            message: forge_core::topo::scrub_arena_ids(&message),
            details,
        }),
        migration: None,
        params: Vec::new(),
        features: Vec::new(),
        parts: Vec::new(),
    }
}

/// A loaded document of either schema version, as v1.
#[derive(Clone, Debug)]
pub struct Loaded {
    /// The v1 document (a v0 input migrated, SPEC-v1 §9.1).
    pub doc: Document,
    /// The migration report of a v0 input (`None` for v1 input).
    pub migration: Option<MigrationReport>,
}

/// Parse and validate a document of either version through the rejection pipeline of
/// SPEC-v1 §0.5 rule 4 with this engine's [`validate_options`] (W1's expression checker; the
/// optional `draft` rejected with `UNSUPPORTED_FEATURE`); a v0 document is migrated. Any schema
/// other than `aicad.ir/0` and `aicad.ir/1` (or none) is `UNSUPPORTED_SCHEMA` at `/schema`.
///
/// This engine's capability check comes with it (§0.2 rule 3): every feature of a type in
/// [`UNIMPLEMENTED_FEATURE_TYPES`] is an `UNSUPPORTED_FEATURE_VERSION` problem at its `/v`,
/// added to the pipeline's problems (every problem is reported, §0.5 rule 3), or the only
/// problems of an otherwise valid document. A parse error stays alone.
pub fn load(text: &str) -> Result<Loaded, LoadError> {
    let loaded = forge_ir::VersionedDocument::from_json_with(text, &validate_options());
    let unimplemented = match &loaded {
        Err(LoadError::Parse { .. }) => Vec::new(),
        _ => unimplemented_versions(text),
    };
    match loaded {
        Err(LoadError::Invalid(mut errs)) => {
            for u in unimplemented {
                if !errs.iter().any(|e| e.path == u.path) {
                    errs.push(u);
                }
            }
            Err(LoadError::Invalid(errs))
        }
        Err(e) => Err(e),
        Ok(_) if !unimplemented.is_empty() => Err(LoadError::Invalid(unimplemented)),
        Ok(forge_ir::VersionedDocument::V0(d)) => {
            let (doc, rep) = forge_ir::v1::migrate_v0_to_v1_report(&d);
            Ok(Loaded {
                doc,
                migration: Some(rep),
            })
        }
        Ok(forge_ir::VersionedDocument::V1(doc)) => Ok(Loaded {
            doc,
            migration: None,
        }),
    }
}

/// The `UNSUPPORTED_FEATURE_VERSION` problems of an `aicad.ir/1` text's features whose type
/// this build does not implement ([`UNIMPLEMENTED_FEATURE_TYPES`]), in document order. Read
/// from the raw JSON so that they are found whatever else the document gets wrong; a feature
/// whose `v` is not a defined version is left to the pipeline's own pre-check (same code and
/// path). Empty for any other schema (v0 has none of these types).
fn unimplemented_versions(text: &str) -> Vec<ValidationError> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    if value.get("schema").and_then(Value::as_str) != Some(IR_SCHEMA) {
        return Vec::new();
    }
    let mut out = Vec::new();
    let parts = value.get("parts").and_then(Value::as_array);
    for (pi, part) in parts.into_iter().flatten().enumerate() {
        let features = part.get("features").and_then(Value::as_array);
        for (fi, f) in features.into_iter().flatten().enumerate() {
            let Some(ty) = f.get("type").and_then(Value::as_str) else {
                continue;
            };
            let Some(&ty) = UNIMPLEMENTED_FEATURE_TYPES.iter().find(|t| **t == ty) else {
                continue;
            };
            let v = match f.get("v") {
                None => 1,
                Some(v) => match v.as_u64() {
                    Some(n)
                        if forge_ir::v1::defined_versions(ty)
                            .iter()
                            .any(|d| u64::from(*d) == n) =>
                    {
                        n
                    }
                    _ => continue,
                },
            };
            out.push(ValidationError::new(
                UNIMPLEMENTED_CODE,
                format!("/parts/{pi}/features/{fi}/v"),
                format!(
                    "Forge does not implement {ty} v{v} yet (supported versions: none; \
                     implemented feature types: {})",
                    SUPPORTED_FEATURE_TYPES.join(", ")
                ),
                json!({ "type": ty, "v": v, "supported": [] }),
            ));
        }
    }
    out
}

/// Load, evaluate and report in one call: the report (a rejected document's report when it
/// does not load) and the evaluation (`None` when rejected). `fallback_name` names the
/// document when it has no `meta.name`.
pub fn evaluate_text(
    text: &str,
    engine: &str,
    fallback_name: &str,
) -> (EvalReport, Option<Evaluation>) {
    match load(text) {
        Ok(l) => {
            let name = if l.doc.meta.name.is_empty() {
                fallback_name.to_string()
            } else {
                l.doc.meta.name.clone()
            };
            let ev = evaluate(&l.doc);
            (report(&ev, engine, &name, l.migration.as_ref()), Some(ev))
        }
        Err(e) => {
            let name = meta_name(text).unwrap_or_else(|| fallback_name.to_string());
            (rejected_report(&e, engine, &name), None)
        }
    }
}

/// `meta.name` of a JSON document, if it has a non-empty string one.
fn meta_name(text: &str) -> Option<String> {
    let v: Value = serde_json::from_str(text).ok()?;
    let name = v.get("meta")?.get("name")?.as_str()?;
    (!name.is_empty()).then(|| name.to_string())
}
