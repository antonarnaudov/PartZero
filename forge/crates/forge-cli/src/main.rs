//! `aicad` — headless evaluation of IR documents (the harness for agents and CI).
//!
//! ```text
//! aicad eval <file.json> [--format json|text] [--out <path>]
//! aicad export <file.json> --out <model.3mf|.stl|.obj> [--deflection 0.05] [--angular 0.35]
//! ```
//!
//! Exit codes:
//! - `0`: the document parsed, validated and was evaluated (the report's `status` may
//!   still be `error` when features failed);
//! - `2`: the document was **rejected** (unreadable, unparseable, or structurally
//!   invalid, SPEC §0 [R-10]); diagnostics go to stderr, and a report with a
//!   document-level `error` is still written so tools that parse the output see why.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use forge_ir::{EvalReport, IrError, METRICS_SCHEMA, ReportError, Status};

#[derive(Parser)]
#[command(
    name = "aicad",
    version,
    about = "AI-native CAD: headless Forge evaluation"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Evaluate an IR document and print its `aicad.metrics/0` report.
    Eval {
        /// IR document (`aicad.ir/0` JSON).
        file: PathBuf,
        /// Output format.
        #[arg(long, value_enum, default_value_t = Format::Json)]
        format: Format,
        /// Write the report to this file instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Evaluate an IR document, tessellate every body and write a mesh file.
    ///
    /// The format follows the extension of `--out` (`.3mf`, `.stl`, `.obj`) unless
    /// `--mesh-format` is given. Exit codes: 0 written; 1 the document has failed features
    /// (nothing written unless `--allow-partial`); 2 rejected document; 3 I/O or mesh error.
    Export {
        /// IR document (`aicad.ir/0` JSON).
        file: PathBuf,
        /// Output mesh file.
        #[arg(long)]
        out: PathBuf,
        /// Mesh format (default: from the `--out` extension).
        #[arg(long, value_enum)]
        mesh_format: Option<MeshFormat>,
        /// Maximum chordal deviation from the exact surface, mm.
        #[arg(long, default_value_t = 0.05)]
        deflection: f64,
        /// Maximum normal deviation along a mesh edge, radians.
        #[arg(long, default_value_t = 0.35)]
        angular: f64,
        /// Export the bodies that did evaluate even if some features failed.
        #[arg(long)]
        allow_partial: bool,
    },
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum MeshFormat {
    /// 3MF (millimetres, one object per body). Preferred for 3D printing.
    #[value(name = "3mf")]
    ThreeMf,
    /// Binary STL.
    Stl,
    /// ASCII STL.
    StlAscii,
    /// Wavefront OBJ.
    Obj,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Format {
    /// Pretty-printed `aicad.metrics/0` JSON.
    Json,
    /// A human-readable summary.
    Text,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Eval { file, format, out } => eval(&file, format, out.as_deref()),
        Command::Export {
            file,
            out,
            mesh_format,
            deflection,
            angular,
            allow_partial,
        } => export(&file, &out, mesh_format, deflection, angular, allow_partial),
    }
}

fn export(
    file: &Path,
    out: &Path,
    mesh_format: Option<MeshFormat>,
    deflection: f64,
    angular: f64,
    allow_partial: bool,
) -> ExitCode {
    let format = match mesh_format.or_else(|| format_from_extension(out)) {
        Some(f) => f,
        None => {
            eprintln!(
                "aicad: cannot infer the mesh format from {}; use .3mf, .stl or .obj, or pass --mesh-format",
                out.display()
            );
            return ExitCode::from(3);
        }
    };
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("aicad: cannot read {}: {e}", file.display());
            return ExitCode::from(2);
        }
    };
    let doc = match forge_ir::from_json(&text) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("aicad: {}: {e}", file.display());
            return ExitCode::from(2);
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
        return ExitCode::from(1);
    }
    let params = forge_mesh::TessParams::new(deflection, angular);
    let mut meshes: Vec<(String, forge_mesh::BodyMesh)> = Vec::new();
    for f in &evaluation.features {
        let Ok(forge_regen::FeatureOutput::Bodies(bodies)) = &f.outcome else {
            continue;
        };
        for (i, body) in bodies.iter().enumerate() {
            let name = if bodies.len() == 1 {
                format!("{}/{}", f.part, f.feature)
            } else {
                format!("{}/{}#{i}", f.part, f.feature)
            };
            match forge_mesh::tessellate(body, &params) {
                Ok(m) => meshes.push((name, m)),
                Err(e) => {
                    eprintln!("aicad: cannot tessellate {name}: {e}");
                    return ExitCode::from(3);
                }
            }
        }
    }
    if meshes.is_empty() {
        eprintln!("aicad: the document produced no bodies; nothing to export");
        return ExitCode::from(1);
    }
    let named: Vec<(&str, &forge_mesh::BodyMesh)> =
        meshes.iter().map(|(n, m)| (n.as_str(), m)).collect();
    let only: Vec<&forge_mesh::BodyMesh> = meshes.iter().map(|(_, m)| m).collect();
    let bytes = match format {
        MeshFormat::ThreeMf => forge_io::try_write_3mf(&named),
        MeshFormat::Obj => forge_io::try_write_obj(&named),
        MeshFormat::Stl => forge_io::try_write_stl(&only, true),
        MeshFormat::StlAscii => forge_io::try_write_stl(&only, false),
    };
    let bytes = match bytes {
        Ok(b) => b,
        Err(e) => {
            eprintln!("aicad: cannot encode the mesh file: {e}");
            return ExitCode::from(3);
        }
    };
    if let Err(e) = std::fs::write(out, &bytes) {
        eprintln!("aicad: cannot write {}: {e}", out.display());
        return ExitCode::from(3);
    }
    let triangles: usize = meshes.iter().map(|(_, m)| m.triangles.len()).sum();
    eprintln!(
        "aicad: wrote {} ({} bodies, {triangles} triangles, {} bytes)",
        out.display(),
        meshes.len(),
        bytes.len()
    );
    ExitCode::SUCCESS
}

fn format_from_extension(path: &Path) -> Option<MeshFormat> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "3mf" => Some(MeshFormat::ThreeMf),
        "stl" => Some(MeshFormat::Stl),
        "obj" => Some(MeshFormat::Obj),
        _ => None,
    }
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `meta.name` of a JSON document, if it has a non-empty one.
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

fn eval(file: &Path, format: Format, out: Option<&Path>) -> ExitCode {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("aicad: cannot read {}: {e}", file.display());
            let r = rejected(file_stem(file), "IR_READ_ERROR", e.to_string());
            return emit(&r, format, out, ExitCode::from(2));
        }
    };
    let name = meta_name(&text).unwrap_or_else(|| file_stem(file));
    let doc = match forge_ir::from_json(&text) {
        Ok(d) => d,
        Err(IrError::Parse(e)) => {
            eprintln!("aicad: {}: IR_PARSE_ERROR: {e}", file.display());
            let r = rejected(name, "IR_PARSE_ERROR", e.to_string());
            return emit(&r, format, out, ExitCode::from(2));
        }
        Err(IrError::Invalid(errs)) => {
            for e in &errs {
                eprintln!("aicad: {}: {e}", file.display());
            }
            let code = errs.first().map_or("IR_INVALID", |e| e.code);
            let message = errs
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join("; ");
            let r = rejected(name, code, message);
            return emit(&r, format, out, ExitCode::from(2));
        }
    };
    let evaluation = forge_regen::evaluate(&doc);
    let report = forge_regen::report(&doc, &evaluation, &forge_regen::engine_id(), &name);
    emit(&report, format, out, ExitCode::SUCCESS)
}

fn emit(report: &EvalReport, format: Format, out: Option<&Path>, code: ExitCode) -> ExitCode {
    let text = match format {
        Format::Json => match serde_json::to_string_pretty(report) {
            Ok(s) => s + "\n",
            Err(e) => {
                eprintln!("aicad: cannot serialize the report: {e}");
                return ExitCode::from(3);
            }
        },
        Format::Text => text_report(report),
    };
    match out {
        Some(path) => {
            if let Err(e) = std::fs::write(path, text) {
                eprintln!("aicad: cannot write {}: {e}", path.display());
                return ExitCode::from(3);
            }
        }
        None => print!("{text}"),
    }
    code
}

fn status_str(s: Status) -> &'static str {
    match s {
        Status::Ok => "ok",
        Status::Error => "error",
    }
}

fn text_report(r: &EvalReport) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(
        s,
        "{} — {} ({})",
        r.document,
        status_str(r.status),
        r.engine
    );
    if let Some(e) = &r.error {
        let _ = writeln!(s, "  rejected: {}: {}", e.code, e.message);
    }
    for f in &r.features {
        let _ = write!(
            s,
            "{}/{} [{}]: {}",
            f.part,
            f.feature,
            f.feature_type,
            status_str(f.status)
        );
        match &f.error {
            Some(e) => {
                let _ = writeln!(s, " — {}: {}", e.code, e.message);
            }
            None => {
                let _ = writeln!(s);
            }
        }
        for g in &f.regions {
            let _ = writeln!(
                s,
                "  region [{}]: area {} mm², {} loop(s)",
                g.outer_curves.join(", "),
                g.area,
                g.loops
            );
        }
        for (i, b) in f.bodies.iter().enumerate() {
            let hist = |h: &std::collections::BTreeMap<String, u32>| {
                h.iter()
                    .map(|(k, v)| format!("{k} {v}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            let _ = writeln!(
                s,
                "  body {i}: volume {} mm³, area {} mm², centroid {:?}\n    bbox {:?} .. {:?}\n    {} faces ({}), {} edges ({}), valid {}",
                b.volume,
                b.area,
                b.centroid,
                b.bbox_min,
                b.bbox_max,
                b.faces,
                hist(&b.face_types),
                b.edges,
                hist(&b.edge_types),
                b.valid
            );
        }
    }
    s
}
