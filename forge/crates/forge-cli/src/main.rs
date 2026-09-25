//! `aicad` — headless evaluation of IR documents (the harness for agents and CI).
//!
//! ```text
//! aicad eval <file.json> [--format json|text] [--out <path>] [--report-version auto|v1]
//! aicad export <file.json> --out <model.3mf|.stl|.obj> [--deflection 0.05] [--angular 0.35]
//! aicad migrate <file.json> [--out <doc.json>] [--renames <renames.json>]
//! aicad solve <file.json> [--sketch <id>]... [--write-back] [--out <doc.json>]
//! ```
//!
//! `eval` and `export` accept `aicad.ir/0` and `aicad.ir/1` documents and dispatch on the exact
//! `schema` (SPEC-v1 §0.5 rule 4 step 2):
//! - `aicad.ir/0` keeps the v0 evaluator and its `aicad.metrics/0` report, byte for byte,
//!   unless `--report-version v1` asks for SPEC-v1 §0.2 rule 4 (migrate, then evaluate as v1;
//!   the report then carries `migration` when ids were rewritten);
//! - everything else — `aicad.ir/1`, any other or missing `schema`, text that is not JSON —
//!   goes through `forge_regen::v1` and gets an `aicad.metrics/1` report: an unknown or missing
//!   schema is rejected with `UNSUPPORTED_SCHEMA` at `/schema`, unreadable JSON with
//!   `IR_PARSE_ERROR`, and a document using the optional `draft` (not implemented by Forge,
//!   §6.9) with `UNSUPPORTED_FEATURE` at the feature's `/type` (§0.2 rule 3). Every mandatory
//!   type — `hole`, `fillet`, `chamfer`, `shell` and `pattern` since Phase C — is evaluated.
//!
//! **Open contract issue (W0), not resolved here:** §0.2 rule 4 says the report of a migrated
//! v0 input "is then a v1 report". The default `auto` keeps the v0 report for v0 input because
//! every current consumer of `aicad eval` on v0 documents parses `aicad.metrics/0` (the oracle's
//! `diff`, which runs `eval` without flags and compares with its own v0 report; the app's and
//! the evals' Forge CLI engines) and because the oracle CLI has the same default; switching it
//! alone would break them. `--report-version v1` gives the SPEC's v1 report (WASM: the
//! `reportVersion` option). W0 either amends §0.2 rule 4 ("… unless the caller asks for the v0
//! report") or the default flips together with those consumers.
//!
//! Command-layer verbs (SPEC-v1 §0.6, W9):
//! - `migrate` prints `migrate_v0_to_v1` of a v0 document (§9.1) as canonical v1 JSON — a v1
//!   document is returned unchanged, in canonical form — and writes the migration report
//!   (`{ "renames": [...] }`) with `--renames`; rewritten ids are listed on stderr (path, kind,
//!   new id; never the rejected id). Exit 0, or 2 for a rejected document (its codes and paths
//!   on stderr, nothing on stdout).
//! - `solve` evaluates the document and prints each selected constrained sketch's report entry
//!   (`{ "sketches": [...] }`); with `--write-back` it prints the document with the solved
//!   geometry written back instead (`writeBackSolution`, `forge_regen::v1::write_back`) and the
//!   summary on stderr. Exit 0 when every selected constrained sketch solved, 1 when one did not
//!   (it is left as it was), 2 for a rejected document or an unknown `--sketch` id.
//!
//! Exit codes of `eval`:
//! - `0`: the document parsed, validated and was evaluated; for a v0 report the report's
//!   `status` may still be `error` when features failed (v0 behaviour);
//! - `1`: a v1 report whose `status` is `error` (a feature or parameter failed; SPEC-v1 §7.2);
//! - `2`: the document was **rejected** (unreadable, unparseable, or structurally
//!   invalid, SPEC §0 [R-10], SPEC-v1 §0.5); diagnostics go to stderr, and a report with a
//!   document-level `error` is still written so tools that parse the output see why.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand, ValueEnum};
use forge_ir::{EvalReport, IrError, METRICS_SCHEMA, ReportError, Status};

mod print;

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
    /// Evaluate an IR document and print its metrics report (`aicad.metrics/0` for an
    /// `aicad.ir/0` document, `aicad.metrics/1` for anything else: an `aicad.ir/1` document, or
    /// a rejected document of another or no schema).
    Eval {
        /// IR document (`aicad.ir/0` or `aicad.ir/1` JSON).
        file: PathBuf,
        /// Output format.
        #[arg(long, value_enum, default_value_t = Format::Json)]
        format: Format,
        /// Write the report to this file instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Report version: `auto` (the document's) or `v1` (migrate a v0 document and write
        /// the `aicad.metrics/1` report, SPEC-v1 §0.2 rule 4).
        #[arg(long, value_enum, default_value_t = ReportVersion::Auto)]
        report_version: ReportVersion,
    },
    /// Evaluate an IR document, tessellate every body and write a mesh file.
    ///
    /// The format follows the extension of `--out` (`.3mf`, `.stl`, `.obj`) unless
    /// `--mesh-format` is given. Exit codes: 0 written; 1 the document has failed features
    /// (nothing written unless `--allow-partial`); 2 rejected document; 3 I/O or mesh error;
    /// 4 the bodies do not fit the bed of `--bed` (`EXPORT_BED_FIT`, nothing written).
    ///
    /// For a printer (3MF only): `--bed` centres the bodies on the bed with their lowest
    /// point at z = 0 through the build items' transform (the vertices are unchanged), after
    /// checking that they fit the bed less `--bed-margin` per side; `--title` and
    /// `--application` set the 3MF metadata. `--summary` writes a JSON record of the export
    /// (`aicad.export/1`: bodies, watertightness, bounding boxes, placement or error, layout
    /// warnings such as a body stacked above another, and a geometry hash without metadata).
    Export {
        /// IR document (`aicad.ir/0` or `aicad.ir/1` JSON). For v1, the final bodies of
        /// every part are written.
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
        /// Centre the bodies on a printer bed of this size, `X,Y,Z` in mm (e.g.
        /// `256,256,256`), and refuse bodies that do not fit it (3MF only).
        #[arg(long, value_name = "X,Y,Z", value_parser = print::parse_bed_size)]
        bed: Option<[f64; 3]>,
        /// Room kept free on each side of the bed in X and Y, mm (for a brim or skirt).
        #[arg(long, value_name = "MM", default_value = "10", value_parser = print::parse_margin, requires = "bed")]
        bed_margin: f64,
        /// An area of the bed no body may cover, `X0,Y0,X1,Y1` in bed coordinates (mm);
        /// repeatable.
        #[arg(long = "bed-exclude", value_name = "X0,Y0,X1,Y1", value_parser = print::parse_bed_rect, requires = "bed")]
        bed_exclude: Vec<[f64; 4]>,
        /// `Title` metadata of the 3MF (e.g. the document name).
        #[arg(long)]
        title: Option<String>,
        /// `Application` metadata of the 3MF (default `forge-io`).
        #[arg(long)]
        application: Option<String>,
        /// Also write a JSON summary of the export (`aicad.export/1`) to this file.
        #[arg(long, value_name = "FILE")]
        summary: Option<PathBuf>,
    },
    /// Migrate an `aicad.ir/0` document to canonical `aicad.ir/1` JSON (SPEC-v1 §9.1).
    ///
    /// A v1 document is printed unchanged, in canonical form. Exit codes: 0 migrated;
    /// 2 rejected document (codes and paths on stderr); 3 I/O error.
    Migrate {
        /// IR document (`aicad.ir/0` or `aicad.ir/1` JSON).
        file: PathBuf,
        /// Write the v1 document to this file instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Also write the migration report (`{ "renames": [...] }`) to this file.
        #[arg(long)]
        renames: Option<PathBuf>,
    },
    /// Solve the constrained sketches of a document; with `--write-back`, store the solutions
    /// in the document (SPEC-v1 §0.6 `writeBackSolution`).
    ///
    /// Exit codes: 0 every selected constrained sketch solved; 1 one did not (not written);
    /// 2 rejected document or unknown `--sketch` id; 3 I/O error.
    Solve {
        /// IR document (`aicad.ir/0` or `aicad.ir/1` JSON).
        file: PathBuf,
        /// Only these sketches (ids; repeatable). Default: every constrained sketch.
        #[arg(long = "sketch")]
        sketches: Vec<String>,
        /// Print the document with the solved geometry written back (canonical v1 JSON)
        /// instead of the sketch reports.
        #[arg(long)]
        write_back: bool,
        /// Write the output to this file instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
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

impl MeshFormat {
    /// The `--mesh-format` spelling.
    fn name(self) -> &'static str {
        match self {
            MeshFormat::ThreeMf => "3mf",
            MeshFormat::Stl => "stl",
            MeshFormat::StlAscii => "stl-ascii",
            MeshFormat::Obj => "obj",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum ReportVersion {
    /// The document's version: v0 → `aicad.metrics/0`, v1 → `aicad.metrics/1`.
    Auto,
    /// Always `aicad.metrics/1` (a v0 document is migrated first).
    V1,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Format {
    /// The report as pretty-printed JSON.
    Json,
    /// A human-readable summary.
    Text,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Eval {
            file,
            format,
            out,
            report_version,
        } => eval(&file, format, out.as_deref(), report_version),
        Command::Export {
            file,
            out,
            mesh_format,
            deflection,
            angular,
            allow_partial,
            bed,
            bed_margin,
            bed_exclude,
            title,
            application,
            summary,
        } => {
            let extras = print::ExportExtras {
                print: print::PrintOptions {
                    bed: bed.map(|size| print::build_volume(size, bed_margin, &bed_exclude)),
                    title,
                    application,
                },
                summary,
                deflection,
                angular,
            };
            export(&file, &out, mesh_format, allow_partial, &extras)
        }
        Command::Migrate { file, out, renames } => {
            migrate(&file, out.as_deref(), renames.as_deref())
        }
        Command::Solve {
            file,
            sketches,
            write_back,
            out,
        } => solve(&file, &sketches, write_back, out.as_deref()),
    }
}

fn export(
    file: &Path,
    out: &Path,
    mesh_format: Option<MeshFormat>,
    allow_partial: bool,
    extras: &print::ExportExtras,
) -> ExitCode {
    let (deflection, angular) = (extras.deflection, extras.angular);
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
    if format != MeshFormat::ThreeMf && extras.print.any() {
        eprintln!(
            "aicad: --bed, --title and --application apply to 3MF only (the placement is the 3MF build items' transform)"
        );
        return ExitCode::from(3);
    }
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("aicad: cannot read {}: {e}", file.display());
            return ExitCode::from(2);
        }
    };
    if !is_v0(&text) {
        let meshes = match v1_meshes(file, &text, deflection, angular, allow_partial) {
            Ok(m) => m,
            Err(code) => return code,
        };
        return write_meshes(out, format, meshes, extras);
    }
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
    write_meshes(out, format, meshes, extras)
}

/// Encode and write the meshes of an export (shared by the v0 and v1 paths).
fn write_meshes(
    out: &Path,
    format: MeshFormat,
    meshes: Vec<(String, forge_mesh::BodyMesh)>,
    extras: &print::ExportExtras,
) -> ExitCode {
    if meshes.is_empty() {
        eprintln!("aicad: the document produced no bodies; nothing to export");
        return ExitCode::from(1);
    }
    let named: Vec<(&str, &forge_mesh::BodyMesh)> =
        meshes.iter().map(|(n, m)| (n.as_str(), m)).collect();
    let only: Vec<&forge_mesh::BodyMesh> = meshes.iter().map(|(_, m)| m).collect();
    let mut summary = print::Summary {
        format: format.name(),
        deflection: extras.deflection,
        angular: extras.angular,
        meshes: &meshes,
        bed: extras.print.bed.as_ref(),
        placement: None,
        bytes: None,
        error: None,
        warnings: Vec::new(),
        geometry_hash: None,
    };
    let bytes = match format {
        MeshFormat::ThreeMf => match print::encode_3mf(&named, &extras.print) {
            Ok((bytes, placement)) => {
                summary.placement = placement;
                if let Some(p) = &placement {
                    summary.warnings = print::layout_warnings(&meshes, p, extras.deflection);
                }
                Ok(bytes)
            }
            Err(print::Print3mfError::Placement(e)) => {
                eprintln!("aicad: {}: {e}", e.code());
                let code = if e.code() == "EXPORT_BED_FIT" {
                    print::EXIT_BED_FIT
                } else {
                    3
                };
                summary.error = Some((e.code(), e.to_string(), print::placement_details(&e)));
                if let Some(path) = &extras.summary {
                    print::write_summary(path, &summary);
                }
                return ExitCode::from(code);
            }
            Err(print::Print3mfError::Io(e)) => Err(e),
        },
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
    if meshes.len() > 1 && matches!(format, MeshFormat::Stl | MeshFormat::StlAscii) {
        eprintln!(
            "aicad: note: STL has no objects, so a slicer loads these {} bodies as one object; export 3MF to keep them apart",
            meshes.len()
        );
    }
    for w in &summary.warnings {
        eprintln!(
            "aicad: warning: {}: {}",
            w["code"].as_str().unwrap_or("WARNING"),
            w["message"].as_str().unwrap_or("")
        );
    }
    summary.bytes = Some(bytes.len());
    summary.geometry_hash = Some(forge_io::geometry_hash(
        &named,
        summary.placement.map(|p| p.translation),
    ));
    if let Some(path) = &extras.summary
        && !print::write_summary(path, &summary)
    {
        return ExitCode::from(3);
    }
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

fn eval(file: &Path, format: Format, out: Option<&Path>, version: ReportVersion) -> ExitCode {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("aicad: cannot read {}: {e}", file.display());
            let r = rejected(file_stem(file), "IR_READ_ERROR", e.to_string());
            return emit(&r, format, out, ExitCode::from(2));
        }
    };
    if version == ReportVersion::V1 || !is_v0(&text) {
        return eval_v1(file, &text, format, out);
    }
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
    write_out(text, out, code)
}

fn write_out(text: String, out: Option<&Path>, code: ExitCode) -> ExitCode {
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

// ---- IR v1 (`aicad.ir/1`, SPEC-v1) ------------------------------------------------------------

/// `true` iff the text is a JSON object whose `schema` is exactly `aicad.ir/0`: the only input
/// that takes the v0 path (and keeps its `aicad.metrics/0` report). Everything else — v1, an
/// unknown or missing schema, text that is not JSON — goes through `forge_regen::v1`, whose
/// rejection pipeline answers `UNSUPPORTED_SCHEMA` / `IR_PARSE_ERROR` in an `aicad.metrics/1`
/// report (SPEC-v1 §0.5 rule 4 step 2).
fn is_v0(text: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("schema")?.as_str().map(|s| s == forge_ir::IR_SCHEMA))
        .unwrap_or(false)
}

/// `aicad eval` of anything but a v0 document (or of a v0 one with `--report-version v1`): the
/// `aicad.metrics/1` report; exit 0 ok, 1 a feature or parameter failed, 2 rejected.
fn eval_v1(file: &Path, text: &str, format: Format, out: Option<&Path>) -> ExitCode {
    let (report, evaluation) =
        forge_regen::v1::evaluate_text(text, &forge_regen::engine_id(), &file_stem(file));
    let code = match (&evaluation, report.status) {
        (None, _) => {
            if let Some(e) = &report.error {
                let errors = e
                    .details
                    .get("errors")
                    .and_then(serde_json::Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                for x in &errors {
                    eprintln!(
                        "aicad: {}: {} at {}: {}",
                        file.display(),
                        x["code"].as_str().unwrap_or("?"),
                        x["path"].as_str().unwrap_or(""),
                        x["message"].as_str().unwrap_or("")
                    );
                }
                if errors.is_empty() {
                    eprintln!("aicad: {}: {}: {}", file.display(), e.code, e.message);
                }
            }
            ExitCode::from(2)
        }
        (Some(_), forge_ir::v1::metrics::Status::Ok) => ExitCode::SUCCESS,
        (Some(_), forge_ir::v1::metrics::Status::Error) => ExitCode::from(1),
    };
    let text = match format {
        Format::Json => match serde_json::to_string_pretty(&report) {
            Ok(s) => s + "\n",
            Err(e) => {
                eprintln!("aicad: cannot serialize the report: {e}");
                return ExitCode::from(3);
            }
        },
        Format::Text => text_report_v1(&report),
    };
    write_out(text, out, code)
}

/// Evaluate a v1 document and tessellate the final bodies of every part (SPEC-v1 §7.2
/// `parts[].bodies`), named `part/feature` after their origin feature (`#k` when several
/// bodies share a name, in canonical order).
fn v1_meshes(
    file: &Path,
    text: &str,
    deflection: f64,
    angular: f64,
    allow_partial: bool,
) -> Result<Vec<(String, forge_mesh::BodyMesh)>, ExitCode> {
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
    let params = forge_mesh::TessParams::new(deflection, angular);
    let mut meshes = Vec::new();
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
            match forge_mesh::tessellate(&body.body, &params) {
                Ok(m) => meshes.push((name, m)),
                Err(e) => {
                    eprintln!("aicad: cannot tessellate {name}: {e}");
                    return Err(ExitCode::from(3));
                }
            }
        }
    }
    Ok(meshes)
}

fn status_v1(s: forge_ir::v1::metrics::Status) -> &'static str {
    match s {
        forge_ir::v1::metrics::Status::Ok => "ok",
        forge_ir::v1::metrics::Status::Error => "error",
    }
}

fn text_report_v1(r: &forge_ir::v1::metrics::EvalReport) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(
        s,
        "{} — {} ({}, {})",
        r.document,
        status_v1(r.status),
        r.engine,
        r.schema
    );
    if let Some(e) = &r.error {
        let _ = writeln!(s, "  rejected: {}: {}", e.code, e.message);
    }
    for p in &r.params {
        match (&p.value, &p.error) {
            (Some(v), _) => {
                let v = match v {
                    forge_ir::v1::metrics::ParamOut::Num(x) => x.to_string(),
                    forge_ir::v1::metrics::ParamOut::Bool(b) => b.to_string(),
                };
                let _ = writeln!(s, "param {} ({}) = {v} {:?}", p.name, p.scope, p.unit);
            }
            (None, Some(e)) => {
                let _ = writeln!(
                    s,
                    "param {} ({}): {}: {}",
                    p.name, p.scope, e.code, e.message
                );
            }
            (None, None) => {}
        }
    }
    for f in &r.features {
        let _ = write!(
            s,
            "{}/{} [{} {}]: {}",
            f.part,
            f.feature,
            f.feature_type,
            f.feature_id,
            status_v1(f.status)
        );
        match &f.error {
            Some(e) => {
                let _ = writeln!(s, " — {}: {}", e.code, e.message);
            }
            None => {
                let _ = writeln!(s);
            }
        }
        for w in &f.warnings {
            let _ = writeln!(s, "  {:?} {}: {}", w.severity, w.code, w.message);
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
        for x in &f.refs {
            let _ = writeln!(
                s,
                "  ref {}: {:?}{} ({} member(s))",
                x.field,
                x.status,
                x.code.as_ref().map(|c| format!(" {c}")).unwrap_or_default(),
                x.members.len()
            );
        }
        if let Some(d) = &f.datum {
            let _ = writeln!(
                s,
                "  datum {}",
                serde_json::to_string(d).unwrap_or_default()
            );
        }
        for b in &f.bodies {
            let _ = writeln!(
                s,
                "  body {}/{} ({:?}): volume {} mm³, area {} mm², {} faces, {} edges, {} shell(s)",
                b.origin.feature,
                b.origin.member,
                b.change,
                b.volume,
                b.area,
                b.faces,
                b.edges,
                b.shells
            );
        }
        for o in &f.removed {
            let _ = writeln!(s, "  removed {}/{}", o.feature, o.member);
        }
    }
    for p in &r.parts {
        let _ = writeln!(s, "part {} ({} bodies)", p.part, p.bodies.len());
        for b in &p.bodies {
            let _ = writeln!(
                s,
                "  {}/{}: volume {} mm³, centroid {:?}, bbox {:?} .. {:?}, valid {}",
                b.origin.feature,
                b.origin.member,
                b.volume,
                b.centroid,
                b.bbox_min,
                b.bbox_max,
                b.valid
            );
        }
    }
    s
}

// ---- command-layer verbs (SPEC-v1 §0.6, §9.1; W9) --------------------------------------------------

fn read_text(file: &Path) -> Result<String, ExitCode> {
    std::fs::read_to_string(file).map_err(|e| {
        eprintln!("aicad: cannot read {}: {e}", file.display());
        ExitCode::from(3)
    })
}

/// Every problem of a rejected document on stderr, `code at path: message`.
fn print_rejection(file: &Path, e: &forge_ir::v1::LoadError) {
    match e {
        forge_ir::v1::LoadError::Parse { .. } => {
            eprintln!("aicad: {}: IR_PARSE_ERROR: {e}", file.display());
        }
        forge_ir::v1::LoadError::Invalid(errs) => {
            for x in errs {
                eprintln!(
                    "aicad: {}: {} at {}: {}",
                    file.display(),
                    x.code,
                    x.path,
                    x.message
                );
            }
        }
    }
}

/// `aicad migrate`: SPEC-v1 §9.1 `migrate_v0_to_v1` as canonical v1 JSON (§0.4), the
/// migration report with `--renames`.
fn migrate(file: &Path, out: Option<&Path>, renames: Option<&Path>) -> ExitCode {
    let text = match read_text(file) {
        Ok(t) => t,
        Err(code) => return code,
    };
    let (doc, report) = match forge_ir::VersionedDocument::from_json(&text) {
        Ok(forge_ir::VersionedDocument::V0(d)) => forge_ir::v1::migrate_v0_to_v1_report(&d),
        Ok(forge_ir::VersionedDocument::V1(d)) => (d, forge_ir::v1::MigrationReport::default()),
        Err(e) => {
            print_rejection(file, &e);
            return ExitCode::from(2);
        }
    };
    for r in &report.renames {
        // `from` is untrusted data ([W0-12]): never echoed.
        let kind = serde_json::to_value(r.kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_default();
        eprintln!(
            "aicad: {}: renamed the {kind} at {} to {}",
            file.display(),
            r.path,
            r.to
        );
    }
    if let Some(path) = renames {
        let json = match serde_json::to_string_pretty(&report) {
            Ok(s) => s + "\n",
            Err(e) => {
                eprintln!("aicad: cannot serialize the migration report: {e}");
                return ExitCode::from(3);
            }
        };
        if let Err(e) = std::fs::write(path, json) {
            eprintln!("aicad: cannot write {}: {e}", path.display());
            return ExitCode::from(3);
        }
    }
    write_out(forge_ir::v1::to_json(&doc) + "\n", out, ExitCode::SUCCESS)
}

/// `aicad solve`: the selected constrained sketches' report entries, or (`--write-back`) the
/// document with their solutions written back (`forge_regen::v1::write_back`).
fn solve(file: &Path, sketches: &[String], write_back: bool, out: Option<&Path>) -> ExitCode {
    let text = match read_text(file) {
        Ok(t) => t,
        Err(code) => return code,
    };
    let doc = match forge_regen::v1::load(&text) {
        Ok(l) => l.doc,
        Err(e) => {
            print_rejection(file, &e);
            return ExitCode::from(2);
        }
    };
    let only = (!sketches.is_empty()).then_some(sketches);
    if write_back {
        let wb = match forge_regen::v1::write_back(&doc, only) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("aicad: {}: {e}", file.display());
                return ExitCode::from(2);
            }
        };
        for id in &wb.written {
            eprintln!(
                "aicad: {}: wrote back the solution of sketch {id}",
                file.display()
            );
        }
        let mut failed = false;
        for s in &wb.skipped {
            failed |= s.reason == "failed";
            eprintln!(
                "aicad: {}: sketch {} not written ({}{})",
                file.display(),
                s.sketch,
                s.reason,
                s.code
                    .as_ref()
                    .map(|c| format!(": {c}"))
                    .unwrap_or_default()
            );
        }
        let code = if failed {
            ExitCode::from(1)
        } else {
            ExitCode::SUCCESS
        };
        return write_out(forge_ir::v1::to_json(&wb.doc) + "\n", out, code);
    }
    // Without write-back: the report entries of the selected sketches (every constrained one by
    // default), `{ "part", "feature_id", "status": "suppressed" }` for a suppressed one.
    let all: Vec<(&str, &forge_ir::v1::SketchFeature)> = doc
        .parts
        .iter()
        .flat_map(|p| {
            p.features.iter().filter_map(move |f| match f {
                forge_ir::v1::Feature::Sketch(s) => Some((p.name.as_str(), s)),
                _ => None,
            })
        })
        .collect();
    if let Some(ids) = only
        && let Some(id) = ids.iter().find(|id| !all.iter().any(|(_, s)| &s.id == *id))
    {
        let shown = if forge_ir::v1::ids::is_id(id) {
            format!("{id:?}")
        } else {
            format!("(an invalid id of {} bytes)", id.len())
        };
        eprintln!(
            "aicad: {}: WRITE_BACK_UNKNOWN_SKETCH: {shown} is not the id of a sketch of the document",
            file.display()
        );
        return ExitCode::from(2);
    }
    let ev = forge_regen::v1::evaluate(&doc);
    let mut entries = Vec::new();
    let mut failed = false;
    for (part, s) in all {
        let selected = match only {
            Some(ids) => ids.contains(&s.id),
            None => !s.constraints.is_empty(),
        };
        if !selected {
            continue;
        }
        match ev.features.iter().find(|f| f.feature_id == s.id) {
            Some(e) => {
                failed |= e.error.is_some();
                entries.push(serde_json::to_value(e).unwrap_or_default());
            }
            None => entries.push(serde_json::json!({
                "part": part, "feature_id": s.id, "status": "suppressed"
            })),
        }
    }
    let code = if failed {
        ExitCode::from(1)
    } else {
        ExitCode::SUCCESS
    };
    match serde_json::to_string_pretty(&serde_json::json!({ "sketches": entries })) {
        Ok(s) => write_out(s + "\n", out, code),
        Err(e) => {
            eprintln!("aicad: cannot serialize the sketch reports: {e}");
            ExitCode::from(3)
        }
    }
}
