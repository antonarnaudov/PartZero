//! Host-independent core of the bindings: evaluate + tessellate an IR document, and
//! export meshes. No JS types here, so it is tested natively.
//!
//! Both IR versions are accepted, dispatched on the exact `schema` like `aicad eval` (SPEC-v1
//! §0.5 rule 4 step 2). An `aicad.ir/0` document keeps the v0 evaluator and its
//! `aicad.metrics/0` report (unchanged). Everything else goes through `forge_regen::v1` and is
//! reported as `aicad.metrics/1` (SPEC-v1 §7): an `aicad.ir/1` document's bodies are the final
//! bodies of every part (`parts[].bodies`: later features modify earlier bodies); an unknown
//! or missing schema is rejected with `UNSUPPORTED_SCHEMA`, and a document using the optional
//! `draft` (not implemented, §6.9) with `UNSUPPORTED_FEATURE`.
//!
//! A document using a mandatory type Forge does not implement yet (`hole`, `fillet`, `chamfer`,
//! `shell`, `pattern`) is rejected with `UNSUPPORTED_FEATURE_VERSION` at the feature's `/v`
//! (SPEC-v1 §0.2 rule 3), like `aicad eval`.
//!
//! Report version: [`ReportVersion::Auto`] (the default) keeps the v0 report for a v0 input, as
//! `aicad eval` without `--report-version v1` does; [`ReportVersion::V1`] migrates it and
//! returns the `aicad.metrics/1` report that SPEC-v1 §0.2 rule 4 describes ("the report is then
//! a v1 report"). The default is an open W0 contract issue (see forge-cli's crate docs): every
//! current v0 consumer parses `aicad.metrics/0`.
//!
//! Command-layer entry points (SPEC-v1 §0.6, W9): [`migrate`] (§9.1, with the rename report),
//! [`params`] (the report's `params` block, no feature evaluated) and [`write_back`]
//! (`writeBackSolution`).

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
/// error or a usage error).
#[derive(Clone, Debug, PartialEq)]
pub struct Rejection {
    /// Stable machine-readable code (`IR_PARSE_ERROR`, a rejection code of SPEC-v1 §7.5, or
    /// `WRITE_BACK_UNKNOWN_SKETCH`).
    pub code: String,
    /// Human-readable message.
    pub message: String,
    /// Every problem, `{ code, path, message, details }`.
    pub errors: Vec<serde_json::Value>,
}

impl Rejection {
    fn of(e: &forge_ir::v1::LoadError) -> Self {
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
    let (doc, report) = match forge_ir::VersionedDocument::from_json(ir_json) {
        Ok(forge_ir::VersionedDocument::V0(d)) => forge_ir::v1::migrate_v0_to_v1_report(&d),
        Ok(forge_ir::VersionedDocument::V1(d)) => (d, forge_ir::v1::MigrationReport::default()),
        Err(e) => return Err(Rejection::of(&e)),
    };
    Ok(Migrated {
        document: forge_ir::v1::to_json(&doc) + "\n",
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
    /// The canonical `aicad.ir/1` text with the solutions written back, ending with a newline.
    pub document: String,
    /// The sketches written, in document order.
    pub written: Vec<String>,
    /// `{ sketch, reason, code? }` for each selected sketch that was not written.
    pub skipped: Vec<serde_json::Value>,
}

/// `writeBackSolution` (SPEC-v1 §0.6): [`forge_regen::v1::write_back`] on the loaded document
/// (a v0 input is migrated; the output is always v1). `sketches` restricts it to those ids.
pub fn write_back(ir_json: &str, sketches: Option<&[String]>) -> Result<WrittenBack, Rejection> {
    let l = forge_regen::v1::load(ir_json).map_err(|e| Rejection::of(&e))?;
    let wb = forge_regen::v1::write_back(&l.doc, sketches).map_err(|e| Rejection {
        code: e.code.to_string(),
        message: e.message,
        errors: Vec::new(),
    })?;
    Ok(WrittenBack {
        document: forge_ir::v1::to_json(&wb.doc) + "\n",
        written: wb.written,
        skipped: wb
            .skipped
            .iter()
            .map(forge_regen::v1::WriteBackSkip::to_json)
            .collect(),
    })
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

    /// SPEC-v1 §6.9: Forge does not implement the optional `draft`; a document using it is
    /// rejected (`UNSUPPORTED_FEATURE` at the draft's `/type`), in the viewer as in the CLI.
    #[test]
    fn a_document_with_a_draft_is_rejected() {
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
        assert_eq!(out.report.error_code(), Some("UNSUPPORTED_FEATURE"));
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        let errors = r.error.as_ref().unwrap().details["errors"]
            .as_array()
            .unwrap();
        assert_eq!(errors[0]["path"], "/parts/0/features/4/type");
        assert!(out.bodies.is_empty());
        let e = export_mesh(
            &with_draft,
            ExportFormat::Stl,
            &tess_params(None, None),
            true,
        )
        .unwrap_err();
        assert_eq!(e.code, "UNSUPPORTED_FEATURE");
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

    /// SPEC-v1 §0.2 rule 3: a mandatory type Forge does not implement yet rejects the document
    /// (`UNSUPPORTED_FEATURE_VERSION` at its `/v`), in the viewer as in the CLI.
    #[test]
    fn a_document_with_an_unimplemented_type_is_rejected() {
        let with_fillet = V1_PLATE.replace(
            "\n      ]}]\n    }",
            r#",
        { "type": "fillet", "id": "f1", "name": "round", "r": 1,
          "edges": { "kind": "edge", "q": { "op": "edges", "of": { "op": "body", "feature": "e1" } } } }
      ]}]
    }"#,
        );
        assert_ne!(with_fillet, V1_PLATE);
        let p = tess_params(None, None);
        let out = evaluate_document(&with_fillet, &p, ReportVersion::Auto, &clock).expect("ok");
        assert_eq!(out.report.error_code(), Some("UNSUPPORTED_FEATURE_VERSION"));
        let Report::V1(r) = &out.report else {
            panic!("expected an aicad.metrics/1 report");
        };
        let e = &r.error.as_ref().unwrap().details["errors"][0];
        assert_eq!(e["path"], "/parts/0/features/4/v");
        assert_eq!(e["details"]["type"], "fillet");
        assert!(out.bodies.is_empty() && r.features.is_empty());
        let e = export_mesh(&with_fillet, ExportFormat::Stl, &p, true).unwrap_err();
        assert_eq!(e.code, "UNSUPPORTED_FEATURE_VERSION");
        // The command layer answers the same way.
        assert_eq!(
            params(&with_fillet).unwrap_err().code,
            "UNSUPPORTED_FEATURE_VERSION"
        );
        // Migration is engine-independent: the document is still printed.
        assert!(migrate(&with_fillet).is_ok());
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
        assert_eq!(
            wb.skipped,
            [serde_json::json!({ "sketch": "s1", "reason": "explicit" })]
        );
    }
}
