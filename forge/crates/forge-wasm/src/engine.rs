//! Host-independent core of the bindings: evaluate + tessellate an IR document, and
//! export meshes. No JS types here, so it is tested natively.
//!
//! Both IR versions are accepted, dispatched on the exact `schema` like `aicad eval` (SPEC-v1
//! §0.5 rule 4 step 2). An `aicad.ir/0` document keeps the v0 evaluator and its
//! `aicad.metrics/0` report (unchanged). Everything else goes through `forge_regen::v1` and is
//! reported as `aicad.metrics/1` (SPEC-v1 §7): an `aicad.ir/1` document's bodies are the final
//! bodies of every part (`parts[].bodies`: later features modify earlier bodies); an unknown
//! or missing schema is rejected with `UNSUPPORTED_SCHEMA`. Every feature type is evaluated,
//! the optional `draft` (§6.9) included.
//!
//! A feature at a behavior version `v` Forge does not implement (SPEC-v1 §0.2 rule 3; since
//! Phase C every mandatory type is implemented at `v: 1`) is rejected with
//! `UNSUPPORTED_FEATURE_VERSION` at the feature's `/v`, like `aicad eval`.
//!
//! Report version: [`ReportVersion::Auto`] (the default) keeps the v0 report for a v0 input, as
//! `aicad eval` without `--report-version v1` does; [`ReportVersion::V1`] migrates it and
//! returns the `aicad.metrics/1` report that SPEC-v1 §0.2 rule 4 describes ("the report is then
//! a v1 report"). The default is an open W0 contract issue (see forge-cli's crate docs): every
//! current v0 consumer parses `aicad.metrics/0`.
//!
//! Command-layer entry points (SPEC-v1 §0.6, W9): [`migrate`] (§9.1, with the rename report),
//! [`canonicalize`] (the migrated document with canonical expressions: what a DocStore stores),
//! [`params`] (the report's `params` block, no feature evaluated) and [`write_back`]
//! (`writeBackSolution`, to its fixed point).

use forge_ir::{EvalReport, IrError, METRICS_SCHEMA, ReportError, Status};
use forge_mesh::{BodyMesh, RenderMesh, TessParams};

/// Default chordal deflection (mm).
pub const DEFAULT_CHORDAL: f64 = 0.05;
/// Default angular deflection (rad).
pub const DEFAULT_ANGULAR: f64 = 0.35;

/// Tessellation parameters from optional JS arguments.
pub fn tess_params(chordal: Option<f64>, angular: Option<f64>) -> TessParams {
    TessParams::new(
        chordal.unwrap_or(DEFAULT_CHORDAL),
        angular.unwrap_or(DEFAULT_ANGULAR),
    )
}

/// A structured error for JS (`code` + message).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
    /// Stable machine-readable code.
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

impl CoreError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        CoreError {
            code: code.to_string(),
            message: message.into(),
        }
    }
}

/// One tessellated body.
#[derive(Clone, Debug)]
pub struct EvalBody {
    /// `part/feature`, or `part/feature#i` when the feature produced several bodies (the
    /// same names `aicad export` writes).
    pub name: String,
    /// The render mesh (per-face vertices, exact normals, face ranges, edge polylines).
    pub mesh: RenderMesh,
}

/// A body that evaluated but could not be tessellated.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeshFailure {
    /// Body name.
    pub body: String,
    /// `MESH_*` code.
    pub code: String,
    /// Message.
    pub message: String,
}

/// Milliseconds spent in each phase (per the host clock).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Timings {
    /// JSON parse + structural validation.
    pub parse_ms: f64,
    /// Feature evaluation (forge-regen) + metrics report.
    pub evaluate_ms: f64,
    /// Tessellation of every body.
    pub tessellate_ms: f64,
}

/// Which report a v0 document gets (a v1 document always gets the v1 report).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ReportVersion {
    /// The document's version: `aicad.metrics/0` for `aicad.ir/0`, `aicad.metrics/1` otherwise.
    #[default]
    Auto,
    /// Always `aicad.metrics/1`: a v0 document is migrated first (SPEC-v1 §0.2 rule 4).
    V1,
}

impl ReportVersion {
    /// `"auto"` / `"v1"`, or `None` (the default); anything else is `REPORT_VERSION`.
    pub fn parse(s: Option<&str>) -> Result<Self, CoreError> {
        match s {
            None | Some("auto") => Ok(ReportVersion::Auto),
            Some("v1") => Ok(ReportVersion::V1),
            Some(_) => Err(CoreError::new(
                "REPORT_VERSION",
                "unknown report version; use \"auto\" or \"v1\"",
            )),
        }
    }
}

/// A metrics report of either version.
#[derive(Clone, Debug, PartialEq)]
pub enum Report {
    /// `aicad.metrics/0`, for an `aicad.ir/0` document.
    V0(EvalReport),
    /// `aicad.metrics/1`, for an `aicad.ir/1` document.
    V1(forge_ir::v1::metrics::EvalReport),
}

impl Report {
    /// The report's JSON text.
    pub fn to_json(&self) -> serde_json::Result<String> {
        match self {
            Report::V0(r) => serde_json::to_string(r),
            Report::V1(r) => serde_json::to_string(r),
        }
    }

    /// `true` iff the report's `status` is `ok`.
    pub fn is_ok(&self) -> bool {
        match self {
            Report::V0(r) => r.status == Status::Ok,
            Report::V1(r) => r.status == forge_ir::v1::metrics::Status::Ok,
        }
    }

    /// The document-level error of a rejected document.
    pub fn error_code(&self) -> Option<&str> {
        match self {
            Report::V0(r) => r.error.as_ref().map(|e| e.code.as_str()),
            Report::V1(r) => r.error.as_ref().map(|e| e.code.as_str()),
        }
    }
}

/// Result of [`evaluate_document`].
#[derive(Clone, Debug)]
pub struct EvalOutput {
    /// The metrics report (`aicad.metrics/0` or `/1`; document-level `error` when the
    /// document was rejected).
    pub report: Report,
    /// Bodies, in timeline order.
    pub bodies: Vec<EvalBody>,
    /// Bodies that failed to tessellate.
    pub mesh_errors: Vec<MeshFailure>,
    /// Phase timings.
    pub timings: Timings,
}

/// Name of body `i` of `n` produced by `part/feature`.
pub fn body_name(part: &str, feature: &str, i: usize, n: usize) -> String {
    if n == 1 {
        format!("{part}/{feature}")
    } else {
        format!("{part}/{feature}#{i}")
    }
}

fn meta_name(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let name = v.get("meta")?.get("name")?.as_str()?;
    (!name.is_empty()).then(|| name.to_string())
}

fn rejected(document: String, code: &str, message: String) -> EvalReport {
    EvalReport {
        schema: METRICS_SCHEMA.to_string(),
        engine: forge_regen::engine_id(),
        document,
        status: Status::Error,
        error: Some(ReportError {
            code: code.to_string(),
            message,
        }),
        features: Vec::new(),
    }
}

/// Parse, validate and evaluate `ir_json`; tessellate every body for rendering.
///
/// A document that cannot be parsed or is structurally invalid is not an error here:
/// the report carries a document-level `error` (like `aicad eval`) and there are no
/// bodies. Invalid tessellation parameters are an error (`MESH_INVALID_PARAMS`).
pub fn evaluate_document(
    ir_json: &str,
    params: &TessParams,
    version: ReportVersion,
    clock: &dyn Fn() -> f64,
) -> Result<EvalOutput, CoreError> {
    params
        .validate()
        .map_err(|e| CoreError::new(e.code(), e.to_string()))?;
    let t0 = clock();
    if version == ReportVersion::V1 || !is_v0(ir_json) {
        return Ok(evaluate_v1(ir_json, params, clock, t0));
    }
    let name = meta_name(ir_json).unwrap_or_default();
    let doc = match forge_ir::from_json(ir_json) {
        Ok(d) => d,
        Err(e) => {
            let (code, message) = match &e {
                IrError::Parse(p) => ("IR_PARSE_ERROR".to_string(), p.to_string()),
                IrError::Invalid(errs) => (
                    errs.first().map_or("IR_INVALID", |x| x.code).to_string(),
                    errs.iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("; "),
                ),
            };
            return Ok(EvalOutput {
                report: Report::V0(rejected(name, &code, message)),
                bodies: Vec::new(),
                mesh_errors: Vec::new(),
                timings: Timings {
                    parse_ms: clock() - t0,
                    ..Timings::default()
                },
            });
        }
    };
    let t1 = clock();
    let evaluation = forge_regen::evaluate(&doc);
    let report = forge_regen::report(&doc, &evaluation, &forge_regen::engine_id(), &name);
    let t2 = clock();
    let mut bodies = Vec::new();
    let mut mesh_errors = Vec::new();
    for f in &evaluation.features {
        let Ok(forge_regen::FeatureOutput::Bodies(bs)) = &f.outcome else {
            continue;
        };
        for (i, body) in bs.iter().enumerate() {
            let name = body_name(&f.part, &f.feature, i, bs.len());
            match forge_mesh::tessellate_render(body, params) {
                Ok(mesh) => bodies.push(EvalBody { name, mesh }),
                Err(e) => mesh_errors.push(MeshFailure {
                    body: name,
                    code: e.code().to_string(),
                    message: e.to_string(),
                }),
            }
        }
    }
    let t3 = clock();
    Ok(EvalOutput {
        report: Report::V0(report),
        bodies,
        mesh_errors,
        timings: Timings {
            parse_ms: t1 - t0,
            evaluate_ms: t2 - t1,
            tessellate_ms: t3 - t2,
        },
    })
}

/// The metrics report of [`evaluate_document`] without tessellating anything (the command
/// layer reads references, candidates and parameter values from it). Same report, same
/// version rules.
pub fn report(ir_json: &str, version: ReportVersion) -> Report {
    if version == ReportVersion::V1 || !is_v0(ir_json) {
        let (r, _) = forge_regen::v1::evaluate_text(ir_json, &forge_regen::engine_id(), "");
        return Report::V1(r);
    }
    let name = meta_name(ir_json).unwrap_or_default();
    match forge_ir::from_json(ir_json) {
        Ok(doc) => {
            let evaluation = forge_regen::evaluate(&doc);
            Report::V0(forge_regen::report(
                &doc,
                &evaluation,
                &forge_regen::engine_id(),
                &name,
            ))
        }
        Err(e) => {
            let (code, message) = match &e {
                IrError::Parse(p) => ("IR_PARSE_ERROR".to_string(), p.to_string()),
                IrError::Invalid(errs) => (
                    errs.first().map_or("IR_INVALID", |x| x.code).to_string(),
                    errs.iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join("; "),
                ),
            };
            Report::V0(rejected(name, &code, message))
        }
    }
}

/// Mesh export formats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExportFormat {
    /// 3MF (mm, one object per body).
    ThreeMf,
    /// Binary STL.
    Stl,
    /// Wavefront OBJ.
    Obj,
}

impl ExportFormat {
    /// `3mf | stl | obj` (case-insensitive).
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "3mf" => Some(ExportFormat::ThreeMf),
            "stl" => Some(ExportFormat::Stl),
            "obj" => Some(ExportFormat::Obj),
            _ => None,
        }
    }
}

/// Evaluate, tessellate (watertight `forge_mesh::tessellate`) and encode every body, like
/// `aicad export`. Fails with the first feature error unless `allow_partial`.
pub fn export_mesh(
    ir_json: &str,
    format: ExportFormat,
    params: &TessParams,
    allow_partial: bool,
) -> Result<Vec<u8>, CoreError> {
    params
        .validate()
        .map_err(|e| CoreError::new(e.code(), e.to_string()))?;
    if !is_v0(ir_json) {
        let meshes = v1_export_meshes(ir_json, params, allow_partial)?;
        return encode(format, meshes);
    }
    let doc = forge_ir::from_json(ir_json).map_err(|e| match &e {
        IrError::Parse(p) => CoreError::new("IR_PARSE_ERROR", p.to_string()),
        IrError::Invalid(errs) => {
            CoreError::new(errs.first().map_or("IR_INVALID", |x| x.code), e.to_string())
        }
    })?;
    let evaluation = forge_regen::evaluate(&doc);
    if !allow_partial
        && let Some((f, e)) = evaluation
            .features
            .iter()
            .find_map(|f| f.outcome.as_ref().err().map(|e| (f, e)))
    {
        return Err(CoreError::new(
            e.code(),
            format!("{}/{}: {e}", f.part, f.feature),
        ));
    }
    let mut meshes = Vec::new();
    for f in &evaluation.features {
        let Ok(forge_regen::FeatureOutput::Bodies(bs)) = &f.outcome else {
            continue;
        };
        for (i, body) in bs.iter().enumerate() {
            let name = body_name(&f.part, &f.feature, i, bs.len());
            let m = forge_mesh::tessellate(body, params)
                .map_err(|e| CoreError::new(e.code(), format!("{name}: {e}")))?;
            meshes.push((name, m));
        }
    }
    encode(format, meshes)
}

fn encode(format: ExportFormat, meshes: Vec<(String, BodyMesh)>) -> Result<Vec<u8>, CoreError> {
    if meshes.is_empty() {
        return Err(CoreError::new(
            "EXPORT_NO_BODIES",
            "the document produced no bodies; nothing to export",
        ));
    }
    let named: Vec<(&str, &forge_mesh::BodyMesh)> =
        meshes.iter().map(|(n, m)| (n.as_str(), m)).collect();
    let only: Vec<&forge_mesh::BodyMesh> = meshes.iter().map(|(_, m)| m).collect();
    let bytes = match format {
        ExportFormat::ThreeMf => forge_io::try_write_3mf(&named),
        ExportFormat::Obj => forge_io::try_write_obj(&named),
        ExportFormat::Stl => forge_io::try_write_stl(&only, true),
    };
    bytes.map_err(|e| CoreError::new(e.code(), e.to_string()))
}

// ---- IR v1 ------------------------------------------------------------------------------------

/// `true` iff the text is a JSON object whose `schema` is exactly `aicad.ir/0`: the only input
/// that takes the v0 path (and keeps its `aicad.metrics/0` report, byte for byte). Everything
/// else — `aicad.ir/1`, an unknown or missing schema, text that is not JSON — goes through
/// `forge_regen::v1`, whose rejection pipeline answers `UNSUPPORTED_SCHEMA` at `/schema` /
/// `IR_PARSE_ERROR` in an `aicad.metrics/1` report (SPEC-v1 §0.5 rule 4 step 2), like
/// `aicad eval`.
pub fn is_v0(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("schema")?.as_str().map(|s| s == forge_ir::IR_SCHEMA))
        .unwrap_or(false)
}

/// The names of a v1 evaluation's final bodies: `part/feature` after the origin feature's
/// name, `#k` when several bodies share a name (canonical order), as `aicad export` writes.
fn v1_bodies<'e>(
    doc: &forge_ir::v1::Document,
    ev: &'e forge_regen::v1::Evaluation,
) -> Vec<(String, &'e forge_regen::v1::PartBody)> {
    let mut out = Vec::new();
    for (pi, part) in ev.parts.iter().enumerate() {
        let names: Vec<String> = part
            .bodies
            .iter()
            .map(|b| {
                let feature = doc
                    .parts
                    .get(pi)
                    .and_then(|p| p.features.iter().find(|f| f.id() == b.origin.feature))
                    .map_or(b.origin.feature.as_str(), |f| f.name());
                format!("{}/{feature}", part.part)
            })
            .collect();
        for (i, b) in part.bodies.iter().enumerate() {
            let same: Vec<usize> = (0..names.len()).filter(|&j| names[j] == names[i]).collect();
            let name = if same.len() == 1 {
                names[i].clone()
            } else {
                let k = same.iter().position(|&j| j == i).unwrap_or(0);
                format!("{}#{k}", names[i])
            };
            out.push((name, b));
        }
    }
    out
}

fn evaluate_v1(ir_json: &str, params: &TessParams, clock: &dyn Fn() -> f64, t0: f64) -> EvalOutput {
    let loaded = forge_regen::v1::load(ir_json);
    let t1 = clock();
    let mut out_bodies = Vec::new();
    let mut mesh_errors = Vec::new();
    let (report, t2) = match loaded {
        Err(e) => {
            let name = meta_name(ir_json).unwrap_or_default();
            let r = forge_regen::v1::rejected_report(&e, &forge_regen::engine_id(), &name);
            (r, clock())
        }
        Ok(l) => {
            let ev = forge_regen::v1::evaluate(&l.doc);
            let r = forge_regen::v1::report(
                &ev,
                &forge_regen::engine_id(),
                &l.doc.meta.name,
                l.migration.as_ref(),
            );
            let t2 = clock();
            for (name, b) in v1_bodies(&l.doc, &ev) {
                match forge_mesh::tessellate_render(&b.body, params) {
                    Ok(mesh) => out_bodies.push(EvalBody { name, mesh }),
                    Err(e) => mesh_errors.push(MeshFailure {
                        body: name,
                        code: e.code().to_string(),
                        message: e.to_string(),
                    }),
                }
            }
            (r, t2)
        }
    };
    let t3 = clock();
    EvalOutput {
        report: Report::V1(report),
        bodies: out_bodies,
        mesh_errors,
        timings: Timings {
            parse_ms: t1 - t0,
            evaluate_ms: t2 - t1,
            tessellate_ms: t3 - t2,
        },
    }
}

fn v1_export_meshes(
    ir_json: &str,
    params: &TessParams,
    allow_partial: bool,
) -> Result<Vec<(String, BodyMesh)>, CoreError> {
    let l = forge_regen::v1::load(ir_json).map_err(|e| {
        let code = e.errors().first().map_or("IR_PARSE_ERROR", |x| x.code);
        CoreError::new(code, e.to_string())
    })?;
    let ev = forge_regen::v1::evaluate(&l.doc);
    if !allow_partial {
        if let Some(p) = ev.params.iter().find(|p| p.error.is_some()) {
            let e = p.error.as_ref().expect("an error");
            return Err(CoreError::new(
                &e.code,
                format!("parameter {}: {}", p.name, e.message),
            ));
        }
        if let Some(f) = ev.features.iter().find(|f| f.error.is_some()) {
            let e = f.error.as_ref().expect("an error");
            return Err(CoreError::new(
                &e.code,
                format!("{}/{}: {}", f.part, f.feature, e.message),
            ));
        }
    }
    let mut meshes = Vec::new();
    for (name, b) in v1_bodies(&l.doc, &ev) {
        let m = forge_mesh::tessellate(&b.body, params)
            .map_err(|e| CoreError::new(e.code(), format!("{name}: {e}")))?;
        meshes.push((name, m));
    }
    Ok(meshes)
}

// ---- command layer (SPEC-v1 §0.6, §9.1; W9) -----------------------------------------------------

/// A rejected input of a command-layer entry point: the first problem's `code` and the message
/// of all of them, and every problem as `{ code, path, message, details }` (none for a parse
/// error or a usage error). A command-layer refusal that is not an IR rejection (an unknown
/// feature, a reference without a proposal, …; see [`crate::commands`]) has no `errors` and
/// carries its structured context in `details`.
#[derive(Clone, Debug, PartialEq)]
pub struct Rejection {
    /// Stable machine-readable code (`IR_PARSE_ERROR`, a rejection code of SPEC-v1 §7.5,
    /// `WRITE_BACK_UNKNOWN_SKETCH`, or a `COMMAND_*` code of [`crate::commands`]).
    pub code: String,
    /// Human-readable message.
    pub message: String,
    /// Every problem, `{ code, path, message, details }`.
    pub errors: Vec<serde_json::Value>,
    /// Structured context of a command-layer refusal (an empty object for IR rejections).
    pub details: serde_json::Value,
}

impl Rejection {
    pub(crate) fn of(e: &forge_ir::v1::LoadError) -> Self {
        let r = forge_regen::v1::rejected_report(e, &forge_regen::engine_id(), "");
        let err = r
            .error
            .unwrap_or_else(|| forge_ir::v1::metrics::ReportError {
                code: "IR_INVALID".into(),
                message: e.to_string(),
                details: serde_json::Map::new(),
            });
        Rejection {
            code: err.code,
            message: err.message,
            errors: err
                .details
                .get("errors")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default(),
            details: serde_json::Value::Object(serde_json::Map::new()),
        }
    }
}

/// Result of [`migrate`].
#[derive(Clone, Debug, PartialEq)]
pub struct Migrated {
    /// The canonical `aicad.ir/1` text (SPEC-v1 §0.4), ending with a newline — byte-identical to
    /// the `.v1.json` migration fixtures and to `aicad migrate`.
    pub document: String,
    /// The migration report (`renames`; empty for a v1 input or when no id was rewritten).
    pub report: forge_ir::v1::MigrationReport,
}

/// `migrate_v0_to_v1` (SPEC-v1 §9.1) with its report. A v1 document is returned unchanged, in
/// canonical form. Engine-independent: validated with the default pipeline (a document with
/// types Forge does not evaluate is still migrated).
pub fn migrate(ir_json: &str) -> Result<Migrated, Rejection> {
    let (doc, report) = migrated(ir_json)?;
    Ok(Migrated {
        document: forge_ir::v1::to_json(&doc) + "\n",
        report,
    })
}

fn migrated(
    ir_json: &str,
) -> Result<(forge_ir::v1::Document, forge_ir::v1::MigrationReport), Rejection> {
    match forge_ir::VersionedDocument::from_json(ir_json) {
        Ok(forge_ir::VersionedDocument::V0(d)) => Ok(forge_ir::v1::migrate_v0_to_v1_report(&d)),
        Ok(forge_ir::VersionedDocument::V1(d)) => Ok((d, forge_ir::v1::MigrationReport::default())),
        Err(e) => Err(Rejection::of(&e)),
    }
}

/// The document of record a DocStore stores (SPEC-v1 §0.4, §2.4: "the CadScript compiler and
/// the DocStore MUST store the canonical form"): [`migrate`], then every expression in its
/// canonical form (`forge_ir::v1::expr::canonicalize_expressions`: `"8"` → `8`, `"width/10"` →
/// `"width / 10"`). Engine-independent like [`migrate`]. Refused, never stored non-canonically,
/// when the canonical form would be rejected ([W0-20]: a string literal `"-5"` whose literal
/// `-5` fails its range, a canonical text beyond the length limit): the rejection's code with
/// every problem at its site's path.
pub fn canonicalize(ir_json: &str) -> Result<Migrated, Rejection> {
    let (doc, report) = migrated(ir_json)?;
    let doc =
        crate::commands::canonical_expressions(&doc, &forge_ir::v1::ValidateOptions::default())?;
    Ok(Migrated {
        document: crate::commands::canonical(&doc),
        report,
    })
}

/// The `params` block of the document's `aicad.metrics/1` report (SPEC-v1 §7.2), without
/// evaluating any feature (a v0 document has none). Loaded like [`evaluate_document`] (this
/// engine's rejections included), so it answers exactly when evaluation would.
pub fn params(ir_json: &str) -> Result<Vec<forge_ir::v1::metrics::ParamReport>, Rejection> {
    let l = forge_regen::v1::load(ir_json).map_err(|e| Rejection::of(&e))?;
    Ok(forge_regen::v1::params(&l.doc))
}

/// Result of [`write_back`].
#[derive(Clone, Debug, PartialEq)]
pub struct WrittenBack {
    /// The canonical `aicad.ir/1` text with the solutions written back, ending with a newline:
    /// the fixed point (writing back again changes nothing).
    pub document: String,
    /// `false` when the document was already at its fixed point (the output equals the
    /// canonical input).
    pub changed: bool,
    /// The sketches written by any pass, in document order.
    pub written: Vec<String>,
    /// `{ sketch, reason, code? }` for each selected sketch not written, in document order:
    /// `explicit`, `suppressed`, `failed` (its evaluation fails, `code`), or `would-fail` — it
    /// solves, but its written-back solution would fail it (`code`, e.g. a driving distance
    /// ≤ *tol* that the weld turns into `SKETCH_CONSTRAINT_CONFLICT`, SPEC-v1 §4.4 rule 9
    /// [W0-31]), so it is withheld and its stored geometry left as it was.
    pub skipped: Vec<serde_json::Value>,
    /// The passes run, the confirming one included (1 when nothing changed; 2 for an ordinary
    /// write-back; 3 when the solution welded ends the stored geometry did not weld).
    pub passes: usize,
}

/// The most passes [`write_back`] runs. SPEC-v1 §4.4 rule 9 [W0-31]: a solution that brings
/// ends together the stored geometry did not weld changes the next evaluation (it welds them),
/// and "the second write-back is the fixed point"; the third pass confirms it.
pub const WRITE_BACK_PASSES: usize = 3;

/// `writeBackSolution` (SPEC-v1 §0.6, §4.4 rule 9) **to its fixed point**:
/// [`forge_regen::v1::write_back`] repeated until the document stops changing, at most
/// [`WRITE_BACK_PASSES`] passes, so the op is idempotent (`write_back(write_back(d)) ==
/// write_back(d)`) even when a solve welds ends: the second pass's geometry change (up to *tol*)
/// is part of this edit, never carried by the next unrelated one. A document that still changes
/// after the last pass is refused with `COMMAND_NOT_EXACT` (`{ op, reason, passes, sketches }`,
/// the sketches still moving); nothing is written. The document is loaded like every
/// command-layer op (a v0 input is migrated, expressions are stored canonically; the output is
/// canonical v1). `sketches` restricts it to those ids.
///
/// **A write-back never makes the model fail.** §0.6 writes back a sketch that re-solved
/// successfully; [W0-31] notes that the next evaluation welds ends the solve brought within
/// *tol*, which can turn a successful sketch into a failing one (a driving `distance` ≤ *tol*
/// between them becomes `SKETCH_CONSTRAINT_CONFLICT`). Such a sketch is **withheld**: the
/// write-back is recomputed without it, and it is listed in `skipped` with reason `would-fail`
/// and the code it would fail with; its stored geometry is unchanged, so the document still
/// evaluates as before. Then, when anything changed, every feature that succeeded before must
/// still succeed; otherwise the write-back is refused (`COMMAND_NOT_EXACT`, reason "a feature
/// would fail", `features: [{ feature, code }]`) and nothing is written. (W9 rules, beyond
/// §0.6's "a constrained sketch that re-solved successfully" and §4.4 rule 9's two passes:
/// listed as a W0 contract issue in the W9 report.)
///
/// **Cost.** Only the evaluation of what a solve depends on is run: nothing at all when no
/// selected sketch has constraints (nothing to write), else each part up to its last selected
/// constrained sketch (features only reference earlier ones, so the prefix's solutions are the
/// whole document's). The whole model is evaluated only to check a write-back that changed the
/// document.
pub fn write_back(ir_json: &str, sketches: Option<&[String]>) -> Result<WrittenBack, Rejection> {
    let doc = crate::commands::load(ir_json)?;
    let input = crate::commands::canonical(&doc);
    let order: Vec<String> = doc
        .parts
        .iter()
        .flat_map(|p| &p.features)
        .map(|f| f.id().to_string())
        .collect();
    let is_sketch = |id: &str| {
        doc.parts
            .iter()
            .flat_map(|p| &p.features)
            .any(|f| matches!(f, forge_ir::v1::Feature::Sketch(s) if s.id == id))
    };
    if let Some(id) = sketches.and_then(|ids| ids.iter().find(|id| !is_sketch(id))) {
        return Err(unknown_sketch(id));
    }
    if !doc
        .parts
        .iter()
        .flat_map(|p| &p.features)
        .any(|f| written_back(f, sketches))
    {
        // Nothing to write: the requested sketches without constraints are `explicit`, as
        // forge-regen's write-back lists them.
        let skipped = doc
            .parts
            .iter()
            .flat_map(|p| &p.features)
            .filter_map(|f| match f {
                forge_ir::v1::Feature::Sketch(s)
                    if sketches.is_some_and(|ids| ids.contains(&s.id)) =>
                {
                    Some(serde_json::json!({ "sketch": s.id, "reason": "explicit" }))
                }
                _ => None,
            })
            .collect();
        return Ok(WrittenBack {
            document: input,
            changed: false,
            written: Vec::new(),
            skipped,
            passes: 1,
        });
    }
    // Sketches whose written-back solution would fail them, with that code.
    let mut withheld: Vec<(String, Option<String>)> = Vec::new();
    let fp = loop {
        let only: Option<Vec<String>> = if withheld.is_empty() {
            sketches.map(<[String]>::to_vec)
        } else {
            let selected: Vec<String> = match sketches {
                Some(s) => s.to_vec(),
                None => doc
                    .parts
                    .iter()
                    .flat_map(|p| &p.features)
                    .filter_map(|f| match f {
                        forge_ir::v1::Feature::Sketch(s) if !s.constraints.is_empty() => {
                            Some(s.id.clone())
                        }
                        _ => None,
                    })
                    .collect(),
            };
            Some(
                selected
                    .into_iter()
                    .filter(|s| withheld.iter().all(|(w, _)| w != s))
                    .collect(),
            )
        };
        let fp = fixed_point(&doc, &input, only.as_deref())?;
        // A sketch some pass wrote whose written-back geometry then fails its evaluation.
        let broke: Vec<(String, Option<String>)> = fp
            .skipped
            .iter()
            .filter(|s| s.reason == "failed" && fp.written.contains(&s.sketch))
            .map(|s| (s.sketch.clone(), s.code.clone()))
            .collect();
        if broke.is_empty() {
            break fp;
        }
        withheld.extend(broke);
    };
    let changed = fp.text != input;
    if changed {
        let broken = newly_failing(&doc, &fp.doc);
        if !broken.is_empty() {
            let names: Vec<&str> = broken
                .iter()
                .filter_map(|b| b["feature"].as_str())
                .collect();
            return Err(Rejection {
                code: "COMMAND_NOT_EXACT".into(),
                message: format!(
                    "writeBackSolution was not applied: its result failed verification (the \
                     written-back document fails {} that succeeded before: {})",
                    if broken.len() == 1 {
                        "a feature"
                    } else {
                        "features"
                    },
                    names.join(", ")
                ),
                errors: Vec::new(),
                details: serde_json::json!({
                    "op": "writeBackSolution",
                    "reason": "a feature would fail",
                    "features": broken,
                }),
            });
        }
    }
    let mut skipped: Vec<(usize, serde_json::Value)> = fp
        .skipped
        .iter()
        .map(|s| (0, forge_regen::v1::WriteBackSkip::to_json(s)))
        .chain(withheld.iter().map(|(s, code)| {
            let mut o = serde_json::json!({ "sketch": s, "reason": "would-fail" });
            if let Some(c) = code {
                o["code"] = serde_json::json!(c);
            }
            (0, o)
        }))
        .collect();
    for (rank, s) in skipped.iter_mut() {
        *rank = order
            .iter()
            .position(|id| s["sketch"].as_str() == Some(id.as_str()))
            .unwrap_or(usize::MAX);
    }
    // Stable: a sketch appears once (withheld sketches are not selected by the last run).
    skipped.sort_by_key(|(rank, _)| *rank);
    Ok(WrittenBack {
        changed,
        document: fp.text,
        written: order
            .iter()
            .filter(|id| fp.written.contains(*id))
            .cloned()
            .collect(),
        skipped: skipped.into_iter().map(|(_, s)| s).collect(),
        passes: fp.passes,
    })
}

/// `{ feature, code }` of every feature that succeeds in `before` and fails in `after`, in
/// `after`'s timeline order.
fn newly_failing(
    before: &forge_ir::v1::Document,
    after: &forge_ir::v1::Document,
) -> Vec<serde_json::Value> {
    let status = |d: &forge_ir::v1::Document| -> Vec<(String, bool, Option<String>)> {
        let ev = forge_regen::v1::evaluate(d);
        forge_regen::v1::report(&ev, &forge_regen::engine_id(), &d.meta.name, None)
            .features
            .into_iter()
            .map(|f| {
                let failed = f.status == forge_ir::v1::metrics::Status::Error;
                (f.feature_id, failed, f.error.map(|e| e.code))
            })
            .collect()
    };
    let was = status(before);
    status(after)
        .into_iter()
        .filter(|(id, failed, _)| *failed && was.iter().any(|(b, f, _)| b == id && !*f))
        .map(|(id, _, code)| serde_json::json!({ "feature": id, "code": code }))
        .collect()
}

/// A write-back run to its fixed point (see [`write_back`]).
struct FixedPoint {
    doc: forge_ir::v1::Document,
    /// Canonical text of `doc`.
    text: String,
    /// Sketches written by any pass.
    written: std::collections::BTreeSet<String>,
    /// The last pass's skipped sketches.
    skipped: Vec<forge_regen::v1::WriteBackSkip>,
    passes: usize,
}

/// Whether feature `f` is a sketch the write-back selects (`only`, or every one) and would
/// write: it has constraints (forge-regen never writes an explicit sketch).
fn written_back(f: &forge_ir::v1::Feature, only: Option<&[String]>) -> bool {
    matches!(f, forge_ir::v1::Feature::Sketch(s)
        if !s.constraints.is_empty() && only.is_none_or(|ids| ids.contains(&s.id)))
}

/// `WRITE_BACK_UNKNOWN_SKETCH` (forge-regen's code and message): `id` is not a sketch of the
/// document.
fn unknown_sketch(id: &str) -> Rejection {
    let valid = forge_ir::v1::ids::is_id(id);
    let shown = if valid {
        format!("{id:?}")
    } else {
        format!("(an invalid id of {} bytes)", id.len())
    };
    Rejection {
        code: "WRITE_BACK_UNKNOWN_SKETCH".into(),
        message: format!("{shown} is not the id of a sketch of the document"),
        errors: Vec::new(),
        details: serde_json::json!({ "sketch": if valid { serde_json::json!(id) } else { serde_json::Value::Null } }),
    }
}

/// The prefix of `doc` a write-back evaluates: each part up to its last sketch that
/// [`written_back`] selects (a part with none keeps no feature). A feature only references
/// earlier features of its part, so the prefix's sketches solve as in the whole document.
fn solve_prefix(doc: &forge_ir::v1::Document, only: Option<&[String]>) -> forge_ir::v1::Document {
    let mut out = doc.clone();
    for p in &mut out.parts {
        let keep = p
            .features
            .iter()
            .rposition(|f| written_back(f, only))
            .map_or(0, |i| i + 1);
        p.features.truncate(keep);
    }
    out
}

/// [`forge_regen::v1::write_back`] from `doc` (whose canonical text is `input`) until the
/// document stops changing, at most [`WRITE_BACK_PASSES`] passes. Each pass evaluates the
/// [`solve_prefix`] only and writes its solutions into the whole document.
fn fixed_point(
    doc: &forge_ir::v1::Document,
    input: &str,
    only: Option<&[String]>,
) -> Result<FixedPoint, Rejection> {
    let mut cur = doc.clone();
    let mut text = input.to_string();
    let mut written = std::collections::BTreeSet::new();
    let mut pass = 0;
    loop {
        pass += 1;
        let prefix = solve_prefix(&cur, only);
        let sketch_ids = |d: &forge_ir::v1::Document| -> Vec<String> {
            d.parts
                .iter()
                .flat_map(|p| &p.features)
                .filter_map(|f| match f {
                    forge_ir::v1::Feature::Sketch(s) => Some(s.id.clone()),
                    _ => None,
                })
                .collect()
        };
        let in_prefix = sketch_ids(&prefix);
        // The requested ids the prefix has (the others are sketches after the last constrained
        // one, so explicit: listed as forge-regen lists them).
        let asked: Option<Vec<String>> = only.map(|ids| {
            ids.iter()
                .filter(|id| in_prefix.contains(id))
                .cloned()
                .collect()
        });
        let mut wb =
            forge_regen::v1::write_back(&prefix, asked.as_deref()).map_err(|e| Rejection {
                code: e.code.to_string(),
                message: e.message,
                errors: Vec::new(),
                details: serde_json::Value::Object(serde_json::Map::new()),
            })?;
        if let Some(ids) = only {
            for id in sketch_ids(&cur) {
                if !in_prefix.contains(&id) && ids.contains(&id) {
                    wb.skipped.push(forge_regen::v1::WriteBackSkip {
                        sketch: id,
                        reason: "explicit",
                        code: None,
                    });
                }
            }
        }
        written.extend(wb.written.iter().cloned());
        let mut next_doc = cur.clone();
        for (part, solved) in next_doc.parts.iter_mut().zip(&wb.doc.parts) {
            for (f, s) in part.features.iter_mut().zip(&solved.features) {
                *f = s.clone();
            }
        }
        let next = crate::commands::canonical(&next_doc);
        if next == text {
            return Ok(FixedPoint {
                doc: next_doc,
                text: next,
                written,
                skipped: wb.skipped,
                passes: pass,
            });
        }
        if pass == WRITE_BACK_PASSES {
            let moving: Vec<String> = cur
                .parts
                .iter()
                .zip(&next_doc.parts)
                .flat_map(|(a, b)| a.features.iter().zip(&b.features))
                .filter(|(a, b)| a != b)
                .map(|(a, _)| a.id().to_string())
                .collect();
            return Err(Rejection {
                code: "COMMAND_NOT_EXACT".into(),
                message: format!(
                    "writeBackSolution was not applied: its result failed verification (the \
                     write-back did not reach its fixed point in {WRITE_BACK_PASSES} passes; \
                     still moving: {})",
                    moving.join(", ")
                ),
                errors: Vec::new(),
                details: serde_json::json!({
                    "op": "writeBackSolution",
                    "reason": "no fixed point",
                    "passes": WRITE_BACK_PASSES,
                    "sketches": moving,
                }),
            });
        }
        cur = next_doc;
        text = next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOX: &str = r#"{
      "schema": "aicad.ir/0",
      "meta": { "name": "box" },
      "parts": [{ "id": "p1", "name": "part", "features": [
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
          { "kind": "line", "id": "bottom", "start": [-40, -25], "end": [40, -25] },
          { "kind": "line", "id": "right",  "start": [40, -25],  "end": [40, 25] },
          { "kind": "line", "id": "top",    "start": [40, 25],   "end": [-40, 25] },
          { "kind": "line", "id": "left",   "start": [-40, 25],  "end": [-40, -25] }
        ]},
        { "type": "extrude", "id": "e1", "name": "plate", "sketch": "base", "distance": 8 }
      ]}]
    }"#;

    fn clock() -> f64 {
        0.0
    }

    #[test]
    fn evaluates_and_tessellates_a_box_with_named_faces_and_edges() {
        let out = evaluate_document(BOX, &tess_params(None, None), ReportVersion::Auto, &clock)
            .expect("ok");
        assert!(out.report.is_ok());
        assert!(matches!(out.report, Report::V0(_)));
        assert_eq!(out.bodies.len(), 1);
        let b = &out.bodies[0];
        assert_eq!(b.name, "part/plate");
        assert_eq!(b.mesh.face_ranges.len(), 6);
        assert_eq!(b.mesh.edge_polylines.len(), 12);
        assert_eq!(b.mesh.triangles.len(), 12);
        assert!(
            b.mesh
                .face_ranges
                .iter()
                .any(|f| f.face_name == "plate/cap:end")
        );
        assert!(out.mesh_errors.is_empty());
    }

    #[test]
    fn rejected_documents_yield_a_report_not_an_error() {
        let out = evaluate_document(
            "{ nope",
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        assert!(!out.report.is_ok());
        assert_eq!(out.report.error_code(), Some("IR_PARSE_ERROR"));
        assert!(out.bodies.is_empty());
        // A v0 document's rejection keeps the v0 report.
        let bad_v0 = BOX.replace("\"distance\": 8", "\"distance\": -1");
        let out = evaluate_document(
            &bad_v0,
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        assert!(matches!(out.report, Report::V0(_)));
        assert_eq!(out.report.error_code(), Some("INVALID_DISTANCE"));
    }

    /// SPEC-v1 §0.5 rule 4 step 2: only `aicad.ir/0` takes the v0 path; an unknown or missing
    /// schema is `UNSUPPORTED_SCHEMA` in an `aicad.metrics/1` report (evaluate), and the same
    /// code from `export_mesh`.
    #[test]
    fn unknown_or_missing_schemas_are_unsupported_schema_in_a_v1_report() {
        assert!(is_v0(BOX));
        for text in [
            BOX.replace("aicad.ir/0", "aicad.ir/2"),
            r#"{"parts":[]}"#.to_string(),
            r#"{"schema":0,"parts":[]}"#.to_string(),
        ] {
            assert!(!is_v0(&text));
            let out =
                evaluate_document(&text, &tess_params(None, None), ReportVersion::Auto, &clock)
                    .expect("ok");
            let Report::V1(r) = &out.report else {
                panic!("expected an aicad.metrics/1 report for {text}");
            };
            assert_eq!(r.schema, "aicad.metrics/1");
            assert_eq!(out.report.error_code(), Some("UNSUPPORTED_SCHEMA"));
            let errors = r.error.as_ref().unwrap().details["errors"]
                .as_array()
                .unwrap();
            assert_eq!(errors.len(), 1);
            assert_eq!(errors[0]["path"], "/schema");
            assert!(out.bodies.is_empty());
            let e =
                export_mesh(&text, ExportFormat::Stl, &tess_params(None, None), true).unwrap_err();
            assert_eq!(e.code, "UNSUPPORTED_SCHEMA");
        }
        let out = evaluate_document(
            "{ nope",
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        assert!(matches!(out.report, Report::V1(_)));
    }

    /// SPEC-v1 §6.9: Forge evaluates the optional `draft` (planar walls between planar faces),
    /// in the viewer as in the CLI.
    #[test]
    fn a_document_with_a_draft_is_evaluated_and_exported() {
        let with_draft = V1_PLATE.replace(
            "\n      ]}]\n    }",
            r#",
        { "type": "draft", "id": "d1", "name": "taper",
          "faces": { "kind": "face", "q": { "op": "sides", "feature": "e1" } },
          "neutral": "XY", "angle": 2 }
      ]}]
    }"#,
        );
        assert_ne!(with_draft, V1_PLATE);
        let out = evaluate_document(
            &with_draft,
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        assert!(out.report.is_ok(), "{r:#?}");
        assert_eq!(out.bodies.len(), 1);
        assert!(out.mesh_errors.is_empty());
        // The 80 × 50 × 8 slab's walls lean in by k = tan 2° per unit height (the frustum of a
        // rectangle: A h − P k h²/2 + 4 k² h³/3); the boss on its top cap is untouched.
        let k = 2.0f64.to_radians().tan();
        let slab = 4000.0 * 8.0 - 260.0 * k * 32.0 + 4.0 * k * k * 512.0 / 3.0;
        let want = slab + std::f64::consts::PI * 121.0 * 12.0;
        let got = r.parts[0].bodies[0].volume;
        assert!((got - want).abs() < 1e-9 * want, "{got} vs {want}");
        export_mesh(
            &with_draft,
            ExportFormat::Stl,
            &tess_params(None, None),
            false,
        )
        .expect("the drafted plate exports");
        // A literal angle outside (0, 45) is a static error: the document is rejected.
        let steep = with_draft.replace("\"angle\": 2", "\"angle\": 50");
        let e = export_mesh(&steep, ExportFormat::Stl, &tess_params(None, None), true).unwrap_err();
        assert_eq!(e.code, "INVALID_VALUE");
    }

    #[test]
    fn invalid_tessellation_parameters_are_errors() {
        let e = evaluate_document(
            BOX,
            &tess_params(Some(0.0), None),
            ReportVersion::Auto,
            &clock,
        )
        .unwrap_err();
        assert_eq!(e.code, "MESH_INVALID_PARAMS");
    }

    #[test]
    fn exports_all_three_formats() {
        let p = tess_params(None, None);
        let stl = export_mesh(BOX, ExportFormat::Stl, &p, false).expect("stl");
        assert_eq!(stl.len(), 84 + 12 * 50);
        let obj = export_mesh(BOX, ExportFormat::Obj, &p, false).expect("obj");
        assert!(obj.starts_with(b"# forge-io OBJ"));
        let tmf = export_mesh(BOX, ExportFormat::ThreeMf, &p, false).expect("3mf");
        assert!(tmf.starts_with(b"PK"));
        assert_eq!(ExportFormat::parse("STL"), Some(ExportFormat::Stl));
        assert_eq!(ExportFormat::parse("step"), None);
    }

    #[test]
    fn output_is_deterministic() {
        let a = evaluate_document(BOX, &tess_params(None, None), ReportVersion::Auto, &clock)
            .expect("ok");
        let b = evaluate_document(BOX, &tess_params(None, None), ReportVersion::Auto, &clock)
            .expect("ok");
        assert_eq!(a.bodies[0].mesh, b.bodies[0].mesh);
    }

    /// A v1 plate with a boss joined on its top face (sketch on face, `op: join`).
    const V1_PLATE: &str = r#"{
      "schema": "aicad.ir/1",
      "meta": { "name": "plate" },
      "params": [{ "name": "t", "unit": "mm", "value": 8 }],
      "parts": [{ "id": "p1", "name": "part", "features": [
        { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
          { "kind": "rect", "id": "outline", "center": [0, 0], "w": 80, "h": 50 } ] },
        { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": "t" },
        { "type": "sketch", "id": "s2", "name": "bossSk",
          "plane": { "face": { "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end" } } },
          "curves": [{ "kind": "circle", "id": "ring", "center": [0, 0], "radius": 11 }] },
        { "type": "extrude", "id": "e2", "name": "boss", "sketch": "s2", "distance": 12,
          "op": "join", "targets": { "kind": "body", "q": { "op": "body", "feature": "e1" } } }
      ]}]
    }"#;

    #[test]
    fn v1_documents_are_evaluated_with_the_v1_report_and_final_bodies() {
        let out = evaluate_document(
            V1_PLATE,
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        assert_eq!(r.schema, "aicad.metrics/1");
        assert!(out.report.is_ok(), "{r:#?}");
        // One final body: the boss joined into the slab (named after its origin feature).
        assert_eq!(out.bodies.len(), 1);
        assert_eq!(out.bodies[0].name, "part/slab");
        assert!(out.mesh_errors.is_empty());
        let json = out.report.to_json().expect("json");
        assert!(json.contains("\"schema\":\"aicad.metrics/1\""));
        // Deterministic.
        let again = evaluate_document(
            V1_PLATE,
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        assert_eq!(again.report, out.report);
        assert_eq!(again.bodies[0].mesh, out.bodies[0].mesh);
    }

    #[test]
    fn rejected_v1_documents_yield_a_v1_report_with_every_problem() {
        let bad = V1_PLATE.replace("\"distance\": \"t\"", "\"distance\": \"nope\"");
        let out = evaluate_document(&bad, &tess_params(None, None), ReportVersion::Auto, &clock)
            .expect("ok");
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        assert_eq!(out.report.error_code(), Some("EXPR_UNKNOWN_NAME"));
        assert!(r.error.as_ref().unwrap().details["errors"].is_array());
        assert!(out.bodies.is_empty());
    }

    #[test]
    fn v1_documents_export_their_final_bodies() {
        let p = tess_params(None, None);
        let stl = export_mesh(V1_PLATE, ExportFormat::Stl, &p, false).expect("stl");
        assert!(stl.len() > 84);
        // A failed feature blocks the export unless partial results are allowed.
        let failing = V1_PLATE.replace("\"distance\": 12", "\"distance\": \"t - 20\"");
        let e = export_mesh(&failing, ExportFormat::Stl, &p, false).unwrap_err();
        assert_eq!(e.code, "INVALID_DISTANCE");
        assert!(export_mesh(&failing, ExportFormat::Stl, &p, true).is_ok());
    }

    #[test]
    fn report_version_v1_gives_a_v0_document_the_v1_report() {
        assert_eq!(ReportVersion::parse(None), Ok(ReportVersion::Auto));
        assert_eq!(ReportVersion::parse(Some("auto")), Ok(ReportVersion::Auto));
        assert_eq!(ReportVersion::parse(Some("v1")), Ok(ReportVersion::V1));
        assert_eq!(
            ReportVersion::parse(Some("v0")).unwrap_err().code,
            "REPORT_VERSION"
        );
        let p = tess_params(None, None);
        let v0 = evaluate_document(BOX, &p, ReportVersion::Auto, &clock).expect("ok");
        let v1 = evaluate_document(BOX, &p, ReportVersion::V1, &clock).expect("ok");
        let Report::V1(r) = &v1.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        assert_eq!(r.schema, "aicad.metrics/1");
        assert_eq!(r.document, "box");
        assert!(v1.report.is_ok());
        assert!(r.migration.is_none(), "no id needed a rewrite");
        // Same body, same mesh (SPEC-v1 §9.1 metric preservation); v1 provenance is stamped
        // with the feature id instead of its name (§5.2 rule 1).
        assert_eq!(v1.bodies.len(), 1);
        assert_eq!(v1.bodies[0].name, v0.bodies[0].name);
        let (m1, m0) = (&v1.bodies[0].mesh, &v0.bodies[0].mesh);
        assert_eq!(
            (&m1.positions, &m1.normals, &m1.triangles),
            (&m0.positions, &m0.normals, &m0.triangles)
        );
        assert_eq!(m1.face_ranges[1].face_name, "e1/cap:end");
        assert_eq!(m0.face_ranges[1].face_name, "plate/cap:end");
        let Report::V0(r0) = &v0.report else {
            panic!("expected an aicad.metrics/0 report");
        };
        assert_eq!(
            r.features[1].bodies[0].volume.to_bits(),
            r0.features[1].bodies[0].volume.to_bits()
        );
        // A rejected v0 document: its v0 codes, with paths, in a v1 report.
        let bad_v0 = BOX.replace("\"distance\": 8", "\"distance\": -1");
        let out = evaluate_document(&bad_v0, &p, ReportVersion::V1, &clock).expect("ok");
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        assert_eq!(out.report.error_code(), Some("INVALID_DISTANCE"));
        assert_eq!(
            r.error.as_ref().unwrap().details["errors"][0]["path"],
            "/parts/0/features/1/distance"
        );
        // v1 input is unaffected by the option.
        let a = evaluate_document(V1_PLATE, &p, ReportVersion::Auto, &clock).expect("ok");
        let b = evaluate_document(V1_PLATE, &p, ReportVersion::V1, &clock).expect("ok");
        assert_eq!(a.report, b.report);
    }

    /// SPEC-v1 §0.2 rule 3: a feature at a behavior version this engine does not implement
    /// rejects the document (`UNSUPPORTED_FEATURE_VERSION` at its `/v`, details `{ type, v,
    /// supported }`), in the viewer as in the CLI. Since Phase C every mandatory type is
    /// implemented at `v: 1` (forge-regen's `UNIMPLEMENTED_FEATURE_TYPES` is empty; `fillet`,
    /// which this test used before, now evaluates), so a version the contract does not define
    /// is the case left: it is rejected by the contract's pipeline too, so `migrate` refuses it.
    #[test]
    fn a_feature_at_an_unimplemented_version_is_rejected() {
        let v2 = V1_PLATE.replace(
            r#"{ "type": "extrude", "id": "e1", "name": "slab","#,
            r#"{ "type": "extrude", "id": "e1", "v": 2, "name": "slab","#,
        );
        assert_ne!(v2, V1_PLATE);
        let p = tess_params(None, None);
        let out = evaluate_document(&v2, &p, ReportVersion::Auto, &clock).expect("ok");
        assert_eq!(out.report.error_code(), Some("UNSUPPORTED_FEATURE_VERSION"));
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        let e = &r.error.as_ref().unwrap().details["errors"][0];
        assert_eq!(e["path"], "/parts/0/features/1/v");
        assert_eq!(e["details"]["type"], "extrude");
        assert_eq!(e["details"]["supported"], serde_json::json!([1]));
        assert!(out.bodies.is_empty() && r.features.is_empty());
        let e = export_mesh(&v2, ExportFormat::Stl, &p, true).unwrap_err();
        assert_eq!(e.code, "UNSUPPORTED_FEATURE_VERSION");
        // The command layer answers the same way.
        assert_eq!(params(&v2).unwrap_err().code, "UNSUPPORTED_FEATURE_VERSION");
        assert_eq!(
            migrate(&v2).unwrap_err().code,
            "UNSUPPORTED_FEATURE_VERSION"
        );
        assert_eq!(
            write_back(&v2, None).unwrap_err().code,
            "UNSUPPORTED_FEATURE_VERSION"
        );
    }

    fn repo(rel: &str) -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join(rel)
    }

    /// `migrate` reproduces the I9 migration fixtures byte for byte (canonical text) with their
    /// rename reports, and is idempotent.
    #[test]
    fn migrate_matches_the_conformance_fixtures() {
        let mut n = 0;
        for dir in ["programs", "makerbench", "renames"] {
            let dir = repo(&format!("corpus/v1/conformance/migration/{dir}"));
            let mut files: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.to_string_lossy().ends_with(".v0.json"))
                .collect();
            files.sort();
            for v0p in files {
                let v1p = v0p.to_string_lossy().replace(".v0.json", ".v1.json");
                let rp = v0p.to_string_lossy().replace(".v0.json", ".renames.json");
                let m = migrate(&std::fs::read_to_string(&v0p).unwrap())
                    .unwrap_or_else(|e| panic!("{}: {e:?}", v0p.display()));
                let want = std::fs::read_to_string(&v1p).unwrap();
                assert_eq!(m.document, want, "{v1p}");
                let renames = serde_json::to_value(&m.report).unwrap();
                let want_r: serde_json::Value = std::fs::read_to_string(&rp)
                    .map(|t| serde_json::from_str(&t).unwrap())
                    .unwrap_or_else(|_| serde_json::json!({ "renames": [] }));
                assert_eq!(renames, want_r, "{rp}");
                let again = migrate(&m.document).unwrap();
                assert_eq!(again.document, m.document);
                assert!(again.report.renames.is_empty());
                n += 1;
            }
        }
        assert!(n >= 69, "{n}");
        let e = migrate("{ nope").unwrap_err();
        assert_eq!(e.code, "IR_PARSE_ERROR");
        let e = migrate(&BOX.replace("\"distance\": 8", "\"distance\": -1")).unwrap_err();
        assert_eq!(e.code, "INVALID_DISTANCE");
        assert_eq!(e.errors[0]["path"], "/parts/0/features/1/distance");
    }

    /// `report` is `evaluate_document`'s report, bit for bit, for both versions and rejections.
    #[test]
    fn report_is_the_evaluation_report_without_meshes() {
        let p = tess_params(None, None);
        for text in [
            BOX.to_string(),
            V1_PLATE.to_string(),
            "{ nope".to_string(),
            BOX.replace("\"distance\": 8", "\"distance\": -1"),
        ] {
            for version in [ReportVersion::Auto, ReportVersion::V1] {
                let full = evaluate_document(&text, &p, version, &clock).expect("ok");
                assert_eq!(report(&text, version), full.report, "{text} {version:?}");
            }
        }
    }

    #[test]
    fn params_are_the_reports_params_block() {
        let ps = params(V1_PLATE).expect("ok");
        assert_eq!(ps.len(), 1);
        assert_eq!(ps[0].name, "t");
        let out = evaluate_document(
            V1_PLATE,
            &tess_params(None, None),
            ReportVersion::Auto,
            &clock,
        )
        .expect("ok");
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        assert_eq!(ps, r.params);
        assert!(params(BOX).expect("v0 has no parameters").is_empty());
        assert_eq!(params("{ nope").unwrap_err().code, "IR_PARSE_ERROR");
    }

    #[test]
    fn write_back_stores_solutions_and_is_idempotent() {
        let text =
            std::fs::read_to_string(repo("corpus/v1/programs/constrained_plate.json")).unwrap();
        let wb = write_back(&text, None).expect("ok");
        assert_eq!(wb.written, ["s1"]);
        assert!(wb.skipped.is_empty());
        let doc = forge_ir::v1::from_json(&wb.document).expect("valid v1");
        assert_eq!(forge_ir::v1::to_json(&doc) + "\n", wb.document);
        assert_eq!(
            write_back(&wb.document, None).unwrap().document,
            wb.document
        );
        // The written document evaluates to the same report.
        let p = tess_params(None, None);
        let a = evaluate_document(&text, &p, ReportVersion::Auto, &clock).expect("ok");
        let b = evaluate_document(&wb.document, &p, ReportVersion::Auto, &clock).expect("ok");
        let (Report::V1(ra), Report::V1(rb)) = (&a.report, &b.report) else {
            panic!("v1 reports expected");
        };
        assert_eq!(ra.features, rb.features);
        assert_eq!(ra.parts, rb.parts);
        // Selection, unknown ids, explicit sketches.
        let e = write_back(&text, Some(&["nope".to_string()])).unwrap_err();
        assert_eq!(e.code, "WRITE_BACK_UNKNOWN_SKETCH");
        let wb = write_back(V1_PLATE, Some(&["s1".to_string()])).expect("ok");
        assert!(wb.written.is_empty());
        assert!(!wb.changed);
        assert_eq!(wb.passes, 1);
        assert_eq!(
            wb.skipped,
            [serde_json::json!({ "sketch": "s1", "reason": "explicit" })]
        );
    }

    /// One `forge_regen::v1::write_back` pass on `text` (canonical text).
    fn one_pass(text: &str) -> String {
        let doc = forge_regen::v1::load(text).expect("loads").doc;
        forge_ir::v1::to_json(&forge_regen::v1::write_back(&doc, None).expect("ok").doc) + "\n"
    }

    /// SPEC-v1 §4.4 rule 9 [W0-31]: a solve that brings together ends the stored geometry did
    /// not weld changes the next evaluation, so one pass is not a fixed point; `write_back`
    /// runs to it, and is then idempotent.
    #[test]
    fn write_back_reaches_its_fixed_point_when_a_solve_welds_ends() {
        let plate: serde_json::Value = forge_ir::v1::json::parse(
            &std::fs::read_to_string(repo("corpus/v1/programs/constrained_plate.json")).unwrap(),
        )
        .unwrap();
        // The corner bottom.end / right.start opened by 0.36 mm and closed by a `coincident`.
        let mut open = plate.clone();
        open["parts"][0]["features"][0]["curves"][1]["start"] = serde_json::json!([40.3, -25.2]);
        open["parts"][0]["features"][0]["constraints"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({ "type": "coincident", "id": "cc",
                                      "a": "bottom.end", "b": "right.start" }));
        // A triangle whose `a.end` / `b.start` gap (0.001, 0.0007) is closed by `k1`.
        let triangle = serde_json::json!({
            "schema": "aicad.ir/1", "meta": { "name": "t" },
            "parts": [{ "id": "p1", "name": "part", "features": [
                { "type": "sketch", "id": "s1", "name": "base", "plane": "XY", "curves": [
                    { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0] },
                    { "kind": "line", "id": "b", "start": [10.001, 0.0007], "end": [5, 8] },
                    { "kind": "line", "id": "c", "start": [5, 8], "end": [0, 0] } ],
                  "constraints": [
                    { "type": "coincident", "id": "k1", "a": "a.end", "b": "b.start" },
                    { "type": "horizontal", "id": "h", "line": "a" },
                    { "type": "distance", "id": "L", "a": "a.start", "b": "a.end", "value": 10 },
                    { "type": "fix", "id": "f", "entity": "a.start" } ] },
                { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 3 }
            ]}]
        });
        for (name, doc) in [("plate", open), ("triangle", triangle)] {
            let text = crate::commands::canonical(
                &forge_regen::v1::load(&doc.to_string()).expect("loads").doc,
            );
            // One pass is not the fixed point: the second pass moves the geometry again.
            let p1 = one_pass(&text);
            let p2 = one_pass(&p1);
            assert_ne!(p1, text, "{name}: pass 1 writes the solution");
            assert_ne!(p2, p1, "{name}: pass 2 moves the welded geometry ([W0-31])");
            // The op runs to the fixed point in one call…
            let wb = write_back(&text, None).expect("ok");
            assert!(wb.changed, "{name}");
            assert_eq!(wb.passes, 3, "{name}");
            assert_eq!(wb.written, ["s1"], "{name}");
            assert_eq!(one_pass(&wb.document), wb.document, "{name}: a fixed point");
            // …so write_back ∘ write_back = write_back.
            let again = write_back(&wb.document, None).expect("ok");
            assert!(!again.changed, "{name}");
            assert_eq!(again.passes, 1, "{name}");
            assert_eq!(again.document, wb.document, "{name}");
        }
    }

    /// `(feature id, error code)` of every feature of `text`'s v1 report.
    fn feature_codes(text: &str) -> Vec<(String, Option<String>)> {
        let doc = forge_regen::v1::load(text).expect("loads").doc;
        let ev = forge_regen::v1::evaluate(&doc);
        forge_regen::v1::report(&ev, &forge_regen::engine_id(), "t", None)
            .features
            .into_iter()
            .map(|f| (f.feature_id, f.error.map(|e| e.code)))
            .collect()
    }

    /// W9 review 3: a write-back must not turn a successful model into a failing one. [W0-31]:
    /// the weld of ends a solve brought within *tol* turns a driving distance ≤ *tol* between
    /// them into a conflict on the next evaluation. Such a sketch is withheld (`would-fail`,
    /// with the code), the others are written, and the document still evaluates as before.
    #[test]
    fn write_back_withholds_a_sketch_whose_weld_would_fail_it() {
        let line = |id: &str, a: [f64; 2], b: [f64; 2]| serde_json::json!({ "kind": "line", "id": id, "start": a, "end": b });
        let doc = serde_json::json!({
            "schema": "aicad.ir/1", "meta": { "name": "t" },
            "parts": [{ "id": "p1", "name": "part", "features": [
                // `a.end` / `b.start` stored 0.0012 apart, driven to 5e-7 apart by `g`.
                { "type": "sketch", "id": "s1", "name": "tri", "plane": "XY", "curves": [
                    line("a", [0.0, 0.0], [10.0, 0.0]),
                    line("b", [10.001, 0.0007], [5.0, 8.0]),
                    line("c", [5.0, 8.0], [0.0, 0.0]) ],
                  "constraints": [
                    { "type": "distance", "id": "g", "a": "a.end", "b": "b.start", "value": 5e-7 },
                    { "type": "horizontal", "id": "h", "line": "a" },
                    { "type": "distance", "id": "L", "a": "a.start", "b": "a.end", "value": 10 },
                    { "type": "fix", "id": "f", "entity": "a.start" } ] },
                { "type": "extrude", "id": "e1", "name": "slab", "sketch": "s1", "distance": 3 },
                // An ordinary sketch whose solution moves a welded corner by 0.5 mm.
                { "type": "sketch", "id": "s2", "name": "tri2", "plane": "XY", "curves": [
                    line("p", [0.0, 20.0], [10.5, 20.0]),
                    line("q", [10.5, 20.0], [5.0, 28.0]),
                    line("r", [5.0, 28.0], [0.0, 20.0]) ],
                  "constraints": [
                    { "type": "horizontal", "id": "h2", "line": "p" },
                    { "type": "distance", "id": "L2", "a": "p.start", "b": "p.end", "value": 10 },
                    { "type": "fix", "id": "f2", "entity": "p.start" } ] },
                { "type": "extrude", "id": "e2", "name": "slab2", "sketch": "s2", "distance": 3 }
            ]}]
        });
        let text = crate::commands::canonical(
            &forge_regen::v1::load(&doc.to_string()).expect("loads").doc,
        );
        let ok = |t: &str| feature_codes(t).into_iter().all(|(_, c)| c.is_none());
        assert!(ok(&text), "{:?}", feature_codes(&text));
        // What one raw pass does: s1 is written and then fails (its consumer with it).
        let raw_text = one_pass(&text);
        let raw = feature_codes(&raw_text);
        assert!(
            raw.contains(&("s1".into(), Some("SKETCH_CONSTRAINT_CONFLICT".into()))),
            "{raw:?}"
        );
        // The last guard of the op (a feature that succeeded and would fail refuses the whole
        // write-back) sees exactly those features.
        let load = |t: &str| forge_regen::v1::load(t).expect("loads").doc;
        let broken = newly_failing(&load(&text), &load(&raw_text));
        let ids: Vec<&str> = broken
            .iter()
            .filter_map(|b| b["feature"].as_str())
            .collect();
        assert_eq!(ids, ["s1", "e1"], "{broken:?}");
        assert_eq!(broken[0]["code"], "SKETCH_CONSTRAINT_CONFLICT");
        assert!(newly_failing(&load(&raw_text), &load(&text)).is_empty());
        // The op withholds s1 and writes s2.
        let wb = write_back(&text, None).expect("ok");
        assert!(wb.changed);
        assert_eq!(wb.written, ["s2"]);
        let withheld = serde_json::json!([{ "sketch": "s1", "reason": "would-fail",
                                            "code": "SKETCH_CONSTRAINT_CONFLICT" }]);
        assert_eq!(serde_json::Value::from(wb.skipped.clone()), withheld);
        assert!(ok(&wb.document), "{:?}", feature_codes(&wb.document));
        let sketch = |t: &str, i: usize| {
            forge_ir::v1::json::parse(t).unwrap()["parts"][0]["features"][i].clone()
        };
        assert_eq!(sketch(&wb.document, 0), sketch(&text, 0), "s1 is untouched");
        assert_ne!(sketch(&wb.document, 2), sketch(&text, 2), "s2 is written");
        // Idempotent, and the same answer when s1 is asked for explicitly.
        let again = write_back(&wb.document, None).expect("ok");
        assert!(!again.changed);
        assert_eq!(serde_json::Value::from(again.skipped), withheld);
        let only = write_back(&text, Some(&["s1".to_string()])).expect("ok");
        assert!(!only.changed);
        assert!(only.written.is_empty());
        assert_eq!(serde_json::Value::from(only.skipped), withheld);
    }

    /// The DocStore's document of record (SPEC-v1 §2.4): canonical expressions, or a refusal
    /// with the canonical form's rejections at their sites ([W0-20]).
    #[test]
    fn canonicalize_stores_canonical_expressions_and_refuses_rejected_forms() {
        let text = std::fs::read_to_string(repo("corpus/v1/programs/params_plate.json")).unwrap();
        let mut v: serde_json::Value = forge_ir::v1::json::parse(&text).unwrap();
        v["params"][1]["value"] = serde_json::json!("width/10");
        v["params"][2]["value"] = serde_json::json!("8.50");
        let m = canonicalize(&v.to_string()).expect("ok");
        let c: serde_json::Value = forge_ir::v1::json::parse(&m.document).unwrap();
        assert_eq!(c["params"][1]["value"], "width / 10");
        assert_eq!(c["params"][2]["value"], serde_json::json!(8.5));
        // migrate alone keeps the text as stored; canonicalize is idempotent.
        assert!(
            migrate(&v.to_string())
                .unwrap()
                .document
                .contains("\"width/10\"")
        );
        assert_eq!(canonicalize(&m.document).unwrap().document, m.document);
        // A literal string that its literal form would reject (`thick` has min 2).
        v["params"][2]["value"] = serde_json::json!("1");
        assert!(migrate(&v.to_string()).is_ok(), "the stored text loads");
        let e = canonicalize(&v.to_string()).expect_err("its canonical form does not");
        assert_eq!(e.code, "PARAM_OUT_OF_RANGE");
        assert_eq!(e.errors[0]["path"], "/params/2/value");
        // Engine-independent, like migrate: a document with a type Forge does not evaluate.
        let features =
            std::fs::read_to_string(repo("corpus/v1/programs/plate_features.json")).unwrap();
        assert!(canonicalize(&features).is_ok());
        // A v0 document is migrated.
        assert!(canonicalize(BOX).unwrap().document.contains("aicad.ir/1"));
    }
}
