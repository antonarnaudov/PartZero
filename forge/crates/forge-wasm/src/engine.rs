//! Host-independent core of the bindings: evaluate + tessellate an IR document, and
//! export meshes. No JS types here, so it is tested natively.

use forge_ir::{EvalReport, IrError, METRICS_SCHEMA, ReportError, Status};
use forge_mesh::{RenderMesh, TessParams};

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

/// Result of [`evaluate_document`].
#[derive(Clone, Debug)]
pub struct EvalOutput {
    /// The `aicad.metrics/0` report (document-level `error` when the document was rejected).
    pub report: EvalReport,
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
    clock: &dyn Fn() -> f64,
) -> Result<EvalOutput, CoreError> {
    params
        .validate()
        .map_err(|e| CoreError::new(e.code(), e.to_string()))?;
    let t0 = clock();
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
                report: rejected(name, &code, message),
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
        report,
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
        let out = evaluate_document(BOX, &tess_params(None, None), &clock).expect("ok");
        assert_eq!(out.report.status, Status::Ok);
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
        let out = evaluate_document("{ nope", &tess_params(None, None), &clock).expect("ok");
        assert_eq!(out.report.status, Status::Error);
        assert_eq!(
            out.report.error.as_ref().map(|e| e.code.as_str()),
            Some("IR_PARSE_ERROR")
        );
        assert!(out.bodies.is_empty());
    }

    #[test]
    fn invalid_tessellation_parameters_are_errors() {
        let e = evaluate_document(BOX, &tess_params(Some(0.0), None), &clock).unwrap_err();
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
        let a = evaluate_document(BOX, &tess_params(None, None), &clock).expect("ok");
        let b = evaluate_document(BOX, &tess_params(None, None), &clock).expect("ok");
        assert_eq!(a.bodies[0].mesh, b.bodies[0].mesh);
    }
}
