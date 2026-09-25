//! `aicad export` for a printer (ALPHA-0-PLAN W5): 3MF metadata, centring on the bed with the
//! bed-fit check (`--bed`, `EXPORT_BED_FIT`), and the JSON export summary (`--summary`) that
//! the desktop's print handoff turns into a receipt: bodies, watertightness, placement, layout
//! warnings (`EXPORT_BODY_FLOATING`, `EXPORT_BODIES_OVERLAP`) and a geometry hash that ignores
//! the metadata.

use std::path::{Path, PathBuf};

use forge_io::{BedPlacement, BedRect, BuildVolume, PlacementError, ThreeMfOptions};
use forge_mesh::BodyMesh;
use serde_json::{Value, json};

/// Schema id of the `--summary` document.
pub const SUMMARY_SCHEMA: &str = "aicad.export/1";

/// Exit code of `aicad export` when the bodies do not fit the bed.
pub const EXIT_BED_FIT: u8 = 4;

/// The 3MF-only options of `aicad export`.
#[derive(Clone, Debug, Default)]
pub struct PrintOptions {
    /// Centre on this bed and check the fit.
    pub bed: Option<BuildVolume>,
    /// `Title` metadata.
    pub title: Option<String>,
    /// `Application` metadata.
    pub application: Option<String>,
}

/// Everything `aicad export` needs besides the document and the output path.
#[derive(Clone, Debug)]
pub struct ExportExtras {
    /// The 3MF-only options.
    pub print: PrintOptions,
    /// Where to write the `aicad.export/1` summary.
    pub summary: Option<PathBuf>,
    /// Maximum chordal deviation, mm.
    pub deflection: f64,
    /// Maximum normal deviation along a mesh edge, radians.
    pub angular: f64,
}

impl PrintOptions {
    /// Whether any option is set (they need the 3MF format).
    pub fn any(&self) -> bool {
        self.bed.is_some() || self.title.is_some() || self.application.is_some()
    }
}

/// `--bed X,Y,Z`: three positive finite sizes in mm.
pub fn parse_bed_size(s: &str) -> Result<[f64; 3], String> {
    let v = numbers(s)?;
    let arr: [f64; 3] = v
        .try_into()
        .map_err(|_| "expected X,Y,Z in mm, e.g. 256,256,256".to_string())?;
    if arr.iter().any(|x| *x <= 0.0) {
        return Err("bed sizes must be positive".into());
    }
    Ok(arr)
}

/// `--bed-exclude X0,Y0,X1,Y1`: a rectangle in bed coordinates, mm.
pub fn parse_bed_rect(s: &str) -> Result<[f64; 4], String> {
    let v = numbers(s)?;
    let r: [f64; 4] = v
        .try_into()
        .map_err(|_| "expected X0,Y0,X1,Y1 in mm".to_string())?;
    if r[0] >= r[2] || r[1] >= r[3] {
        return Err("expected X0 < X1 and Y0 < Y1".into());
    }
    Ok(r)
}

/// `--bed-margin`: a finite, non-negative length.
pub fn parse_margin(s: &str) -> Result<f64, String> {
    let v = s
        .trim()
        .parse::<f64>()
        .map_err(|_| format!("not a number: {s}"))?;
    if !v.is_finite() || v < 0.0 {
        return Err("the margin must be finite and not negative".into());
    }
    Ok(v)
}

fn numbers(s: &str) -> Result<Vec<f64>, String> {
    s.split(',')
        .map(|t| {
            t.trim()
                .parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .ok_or_else(|| format!("not a finite number: {:?}", t.trim()))
        })
        .collect()
}

/// The build volume of `--bed`, `--bed-margin` and `--bed-exclude`.
pub fn build_volume(size: [f64; 3], margin: f64, exclusions: &[[f64; 4]]) -> BuildVolume {
    BuildVolume {
        size,
        margin,
        exclusions: exclusions
            .iter()
            .map(|r| BedRect {
                min: [r[0], r[1]],
                max: [r[2], r[3]],
            })
            .collect(),
    }
}

/// Why a 3MF for a printer was not written.
pub enum Print3mfError {
    /// The bodies cannot be placed on the bed.
    Placement(PlacementError),
    /// The encoder failed.
    Io(forge_io::IoError),
}

/// Place (when a bed is given) and encode the 3MF.
pub fn encode_3mf(
    named: &[(&str, &BodyMesh)],
    opts: &PrintOptions,
) -> Result<(Vec<u8>, Option<BedPlacement>), Print3mfError> {
    let placement = match &opts.bed {
        Some(bed) => {
            let meshes: Vec<&BodyMesh> = named.iter().map(|(_, m)| *m).collect();
            Some(forge_io::place_on_bed(&meshes, bed).map_err(Print3mfError::Placement)?)
        }
        None => None,
    };
    let three_mf = ThreeMfOptions {
        title: opts.title.clone(),
        application: opts.application.clone(),
        translation: placement.map(|p| p.translation),
    };
    let bytes = forge_io::try_write_3mf_with(named, &three_mf).map_err(Print3mfError::Io)?;
    Ok((bytes, placement))
}

fn aabb(b: &forge_io::Aabb) -> Value {
    json!({ "min": b.min, "max": b.max })
}

/// The structured context of a placement error (`details` of the summary's `error`).
pub fn placement_details(e: &PlacementError) -> Value {
    match e {
        PlacementError::DoesNotFit {
            extent,
            usable,
            size,
            margin,
            overflows,
        } => json!({
            "extent": extent,
            "usable": usable,
            "bed": size,
            "margin": margin,
            "overflows": overflows.iter().map(|o| json!({
                "axis": o.axis.as_str(),
                "extent": o.extent,
                "usable": o.usable,
                "excess": o.excess(),
            })).collect::<Vec<_>>(),
        }),
        PlacementError::ExclusionZone {
            zone,
            rect,
            footprint,
        } => json!({
            "zone": zone,
            "rect": { "min": rect.min, "max": rect.max },
            "footprint": { "min": footprint.min, "max": footprint.max },
        }),
        _ => json!({}),
    }
}

/// What `--summary` records about one export.
pub struct Summary<'a> {
    /// `3mf`, `stl`, `stl-ascii` or `obj`.
    pub format: &'a str,
    /// Chordal and angular tessellation tolerances.
    pub deflection: f64,
    /// See `deflection`.
    pub angular: f64,
    /// The named meshes.
    pub meshes: &'a [(String, BodyMesh)],
    /// The bed, when `--bed` was given.
    pub bed: Option<&'a BuildVolume>,
    /// The placement, when the bodies were placed.
    pub placement: Option<BedPlacement>,
    /// Bytes written, when the file was written.
    pub bytes: Option<usize>,
    /// `(code, message, details)` of the failure that stopped the export.
    pub error: Option<(&'a str, String, Value)>,
    /// What a slicer would load differently from the model (see [`layout_warnings`]).
    pub warnings: Vec<Value>,
    /// [`forge_io::geometry_hash`] of the written file, when it was written.
    pub geometry_hash: Option<u64>,
}

/// `fnv1a64:<16 hex digits>`, the summary's (and the print receipt's) determinism hash.
pub fn geometry_hash_text(h: u64) -> String {
    format!("fnv1a64:{h:016x}")
}

/// The [`forge_io::LayoutWarning`]s of a placed export as summary entries
/// (`{ code, message, details }`), bodies named as in the file. The contact tolerance is the
/// export's chordal tolerance: a curved underside's mesh sits up to that far above the bed.
pub fn layout_warnings(
    meshes: &[(String, BodyMesh)],
    placement: &BedPlacement,
    deflection: f64,
) -> Vec<Value> {
    let refs: Vec<&BodyMesh> = meshes.iter().map(|(_, m)| m).collect();
    let name = |i: usize| format!("body {:?}", meshes[i].0);
    match forge_io::layout_warnings(&refs, placement, deflection) {
        Ok(ws) => ws
            .iter()
            .map(|w| {
                let details = match w {
                    forge_io::LayoutWarning::Floating { body, z_min } => json!({
                        "body": body,
                        "name": meshes[*body].0,
                        "zMin": z_min,
                    }),
                    forge_io::LayoutWarning::StackedOverlap { bodies, overlap } => json!({
                        "bodies": bodies,
                        "names": [meshes[bodies[0]].0, meshes[bodies[1]].0],
                        "overlap": { "min": overlap.min, "max": overlap.max },
                    }),
                };
                json!({ "code": w.code(), "message": w.describe(name), "details": details })
            })
            .collect(),
        // The meshes were placed already, so only a bad tolerance fails here: say so.
        Err(e) => vec![json!({ "code": e.code(), "message": e.to_string(), "details": {} })],
    }
}

/// The `aicad.export/1` JSON document (see [`Summary`]).
pub fn summary_json(s: &Summary) -> Value {
    let bodies: Vec<Value> = s
        .meshes
        .iter()
        .map(|(name, m)| {
            let bounds = forge_io::mesh_bounds(&[m]).ok();
            json!({
                "name": name,
                "vertices": m.positions.len(),
                "triangles": m.triangles.len(),
                "watertight": forge_mesh::check_watertight(m).is_ok(),
                "bbox": bounds.as_ref().map(aabb),
            })
        })
        .collect();
    let refs: Vec<&BodyMesh> = s.meshes.iter().map(|(_, m)| m).collect();
    let bbox = forge_io::mesh_bounds(&refs).ok();
    json!({
        "schema": SUMMARY_SCHEMA,
        "engine": forge_regen::engine_id(),
        "status": if s.error.is_none() { "ok" } else { "error" },
        "error": s.error.as_ref().map(|(code, message, details)| json!({
            "code": code, "message": message, "details": details,
        })),
        "format": s.format,
        "tessellation": { "deflection": s.deflection, "angular": s.angular },
        "bodies": bodies,
        "watertight": s.meshes.iter().all(|(_, m)| forge_mesh::check_watertight(m).is_ok()),
        "bbox": bbox.as_ref().map(aabb),
        "bed": s.bed.map(|b| json!({
            "size": b.size,
            "margin": b.margin,
            "exclusions": b.exclusions.iter().map(|r| json!({ "min": r.min, "max": r.max })).collect::<Vec<_>>(),
        })),
        "placement": s.placement.map(|p| json!({
            "translation": p.translation,
            "bbox": aabb(&p.placed),
        })),
        "bytes": s.bytes,
        "geometryHash": s.geometry_hash.map(geometry_hash_text),
        "warnings": s.warnings,
    })
}

/// Write the summary; `false` (with a message on stderr) when it cannot be written.
pub fn write_summary(path: &Path, s: &Summary) -> bool {
    let text = match serde_json::to_string_pretty(&summary_json(s)) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bed_arguments_parse_and_reject_nonsense() {
        assert_eq!(parse_bed_size("256,256, 256"), Ok([256.0, 256.0, 256.0]));
        assert!(parse_bed_size("256,256").is_err());
        assert!(parse_bed_size("256,0,256").is_err());
        assert!(parse_bed_size("256,inf,256").is_err());
        assert_eq!(parse_bed_rect("0,0,18,28"), Ok([0.0, 0.0, 18.0, 28.0]));
        assert!(parse_bed_rect("5,0,5,28").is_err());
        assert_eq!(parse_margin("10"), Ok(10.0));
        assert!(parse_margin("-1").is_err());
        assert!(parse_margin("NaN").is_err());
    }
}
