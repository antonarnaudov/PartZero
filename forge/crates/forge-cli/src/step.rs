//! `aicad export --format step` (or an `.step` / `.stp` output): the exact B-rep of the
//! final bodies as a STEP AP214 / AP242 file, written by forge-io's own writer.
//!
//! Bodies are named as in the mesh exports (`part/feature`, `#k` for repeats). `--title`
//! sets the STEP product name (default: the output file's stem) and `--application` the
//! originating system; `--bed` does not apply (a STEP file keeps model coordinates).
//! `--summary` writes an `aicad.export/1` record with, per body, Forge's own metrics
//! (volume, area, bounding box, topology counts) next to what the STEP writer produced
//! (solids, faces, edges, vertices, synthesized seams and vertices), which the oracle's
//! `step-check` compares with OCCT's reading of the file.
//!
//! Exit codes: 0 written; 1 features failed (without `--allow-partial`) or no bodies;
//! 2 the document was rejected; 3 I/O error or a `STEP_*` export error (code on stderr).

use std::path::Path;
use std::process::ExitCode;

use forge_core::topo::Body;
use forge_io::step::{StepBody, StepOptions, StepReport, StepSchema, write_step};
use serde_json::{Value, json};

use crate::print::{ExportExtras, SUMMARY_SCHEMA};

/// One body to export, with Forge's metrics of it.
struct Named {
    name: String,
    body: Body,
    volume: f64,
    area: f64,
    bbox_min: [f64; 3],
    bbox_max: [f64; 3],
}

/// Run the STEP export.
pub(crate) fn export(
    file: &Path,
    out: &Path,
    allow_partial: bool,
    extras: &ExportExtras,
    schema: StepSchema,
) -> ExitCode {
    if extras.print.bed.is_some() {
        eprintln!("aicad: --bed applies to 3MF only; a STEP file keeps the model's coordinates");
        return ExitCode::from(3);
    }
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("aicad: cannot read {}: {e}", file.display());
            return ExitCode::from(2);
        }
    };
    let bodies = if crate::is_v0(&text) {
        v0_bodies(file, &text, allow_partial)
    } else {
        v1_bodies(file, &text, allow_partial)
    };
    let bodies = match bodies {
        Ok(b) => b,
        Err(code) => return code,
    };
    if bodies.is_empty() {
        eprintln!("aicad: the document produced no bodies; nothing to export");
        return ExitCode::from(1);
    }
    let stem = out
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "part".into());
    let opts = StepOptions {
        schema,
        product_name: extras.print.title.clone().unwrap_or(stem),
        file_name: out
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        originating_system: extras
            .print
            .application
            .clone()
            .unwrap_or_else(|| StepOptions::default().originating_system),
        ..StepOptions::default()
    };
    let items: Vec<StepBody<'_>> = bodies
        .iter()
        .map(|b| StepBody {
            name: &b.name,
            body: &b.body,
            color: None,
        })
        .collect();
    let (bytes, report) = match write_step(&items, &opts) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("aicad: {}: {e}", e.code());
            if let Some(path) = &extras.summary {
                write_json(
                    path,
                    &summary(&bodies, None, schema, Some((e.code(), e.to_string()))),
                );
            }
            return ExitCode::from(3);
        }
    };
    if let Err(e) = std::fs::write(out, &bytes) {
        eprintln!("aicad: cannot write {}: {e}", out.display());
        return ExitCode::from(3);
    }
    let seams: usize = report.bodies.iter().map(|b| b.seam_edges).sum();
    eprintln!(
        "aicad: wrote {} ({} bodies, STEP {}, {} entities, {seams} seams, {} bytes)",
        out.display(),
        bodies.len(),
        schema.name(),
        report.entities,
        bytes.len()
    );
    if let Some(path) = &extras.summary
        && !write_json(path, &summary(&bodies, Some(&report), schema, None))
    {
        return ExitCode::from(3);
    }
    ExitCode::SUCCESS
}

fn summary(
    bodies: &[Named],
    report: Option<&StepReport>,
    schema: StepSchema,
    error: Option<(&str, String)>,
) -> Value {
    let list: Vec<Value> = bodies
        .iter()
        .enumerate()
        .map(|(i, b)| {
            let c = b.body.counts();
            let step = report.and_then(|r| r.bodies.get(i)).map(|s| {
                json!({
                    "solids": s.solids,
                    "voids": s.voids,
                    "faces": s.faces,
                    "edges": s.edges,
                    "vertices": s.vertices,
                    "seamEdges": s.seam_edges,
                    "splitPieces": s.split_pieces,
                    "newVertices": s.new_vertices,
                })
            });
            json!({
                "name": b.name,
                "forge": {
                    "volume": b.volume,
                    "area": b.area,
                    "bboxMin": b.bbox_min,
                    "bboxMax": b.bbox_max,
                    "shells": c.shells,
                    "faces": c.faces,
                    "edges": c.edges,
                    "vertices": c.vertices,
                },
                "step": step,
            })
        })
        .collect();
    json!({
        "schema": SUMMARY_SCHEMA,
        "format": "step",
        "stepSchema": schema.name(),
        "bytes": report.map(|r| r.bytes),
        "entities": report.map(|r| r.entities),
        "uncertainty": report.map(|r| r.uncertainty),
        "bodies": list,
        "error": error.map(|(code, message)| json!({ "code": code, "message": message })),
    })
}

fn write_json(path: &Path, v: &Value) -> bool {
    let text = match serde_json::to_string_pretty(v) {
        Ok(t) => t + "\n",
        Err(e) => {
            eprintln!("aicad: cannot serialize the export summary: {e}");
            return false;
        }
    };
    if let Err(e) = std::fs::write(path, text) {
        eprintln!("aicad: cannot write {}: {e}", path.display());
        return false;
    }
    true
}

fn v0_bodies(file: &Path, text: &str, allow_partial: bool) -> Result<Vec<Named>, ExitCode> {
    let doc = match forge_ir::from_json(text) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aicad: {}: {e}", file.display());
            return Err(ExitCode::from(2));
        }
    };
    let evaluation = forge_regen::evaluate(&doc);
    let mut failed = false;
    for f in &evaluation.features {
        if let Err(e) = &f.outcome {
            failed = true;
            eprintln!("aicad: {}/{}: {} {e}", f.part, f.feature, e.code());
        }
    }
    if failed && !allow_partial {
        eprintln!(
            "aicad: nothing written because features failed (pass --allow-partial to export the rest)"
        );
        return Err(ExitCode::from(1));
    }
    let report = forge_regen::report(&doc, &evaluation, &forge_regen::engine_id(), "export");
    let mut out = Vec::new();
    for (fi, f) in evaluation.features.iter().enumerate() {
        let Ok(forge_regen::FeatureOutput::Bodies(bodies)) = &f.outcome else {
            continue;
        };
        let metrics = report.features.get(fi).map(|r| &r.bodies);
        for (i, body) in bodies.iter().enumerate() {
            let name = if bodies.len() == 1 {
                format!("{}/{}", f.part, f.feature)
            } else {
                format!("{}/{}#{i}", f.part, f.feature)
            };
            let Some(m) = metrics.and_then(|m| m.get(i)) else {
                eprintln!("aicad: internal: no metrics for {name}");
                return Err(ExitCode::from(3));
            };
            out.push(Named {
                name,
                body: body.clone(),
                volume: m.volume,
                area: m.area,
                bbox_min: m.bbox_min,
                bbox_max: m.bbox_max,
            });
        }
    }
    Ok(out)
}

fn v1_bodies(file: &Path, text: &str, allow_partial: bool) -> Result<Vec<Named>, ExitCode> {
    let loaded = match forge_regen::v1::load(text) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("aicad: {}: {e}", file.display());
            return Err(ExitCode::from(2));
        }
    };
    let evaluation = forge_regen::v1::evaluate(&loaded.doc);
    let mut failed = false;
    for p in &evaluation.params {
        if let Some(e) = &p.error {
            failed = true;
            eprintln!("aicad: parameter {}: {} {}", p.name, e.code, e.message);
        }
    }
    for f in &evaluation.features {
        if let Some(e) = &f.error {
            failed = true;
            eprintln!("aicad: {}/{}: {} {}", f.part, f.feature, e.code, e.message);
        }
    }
    if failed && !allow_partial {
        eprintln!(
            "aicad: nothing written because features failed (pass --allow-partial to export the rest)"
        );
        return Err(ExitCode::from(1));
    }
    let mut out = Vec::new();
    for (pi, part) in evaluation.parts.iter().enumerate() {
        let names: Vec<String> = part
            .bodies
            .iter()
            .map(|b| {
                let feature = loaded.doc.parts[pi]
                    .features
                    .iter()
                    .find(|f| f.id() == b.origin.feature)
                    .map_or(b.origin.feature.as_str(), |f| f.name());
                format!("{}/{feature}", part.part)
            })
            .collect();
        for (i, body) in part.bodies.iter().enumerate() {
            let same: Vec<usize> = (0..names.len()).filter(|&j| names[j] == names[i]).collect();
            let name = if same.len() == 1 {
                names[i].clone()
            } else {
                let k = same.iter().position(|&j| j == i).unwrap_or(0);
                format!("{}#{k}", names[i])
            };
            let m = &body.metrics;
            out.push(Named {
                name,
                body: body.body.clone(),
                volume: m.volume,
                area: m.area,
                bbox_min: m.bbox_min,
                bbox_max: m.bbox_max,
            });
        }
    }
    Ok(out)
}
