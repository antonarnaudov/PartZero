//! Structural validation of IR documents (no geometry evaluation).
//!
//! Geometric validity of sketches (closed loops, crossings, nesting) is decided by
//! the engine at evaluation time and reported as a feature error, not here.

use std::collections::BTreeSet;

use crate::doc::*;
use crate::{IR_SCHEMA, LINEAR_TOLERANCE, RESERVED_NAMES};

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
#[error("{code} at {path}: {message}")]
pub struct ValidationError {
    /// Stable machine-readable code, e.g. `DUPLICATE_NAME`.
    pub code: &'static str,
    /// JSON-pointer-like path to the offending element.
    pub path: String,
    pub message: String,
}

fn err(code: &'static str, path: impl Into<String>, message: impl Into<String>) -> ValidationError {
    ValidationError {
        code,
        path: path.into(),
        message: message.into(),
    }
}

/// Validate a document. Returns every problem found (not just the first).
pub fn validate(doc: &Document) -> Result<(), Vec<ValidationError>> {
    let mut errs = Vec::new();
    if doc.schema != IR_SCHEMA {
        errs.push(err(
            "UNSUPPORTED_SCHEMA",
            "/schema",
            format!("expected {IR_SCHEMA:?}, got {:?}", doc.schema),
        ));
    }
    if doc.parts.is_empty() {
        errs.push(err(
            "NO_PARTS",
            "/parts",
            "a document needs at least one part studio",
        ));
    }
    let mut part_ids = BTreeSet::new();
    let mut part_names = BTreeSet::new();
    // Feature ids and names are unique across the WHOLE document: names are CadScript
    // consts sharing one file scope, ids key spans/diagnostics document-wide.
    let mut feature_ids = BTreeSet::new();
    let mut feature_names = BTreeSet::new();
    for (pi, part) in doc.parts.iter().enumerate() {
        let pp = format!("/parts/{pi}");
        if !part_ids.insert(part.id.as_str()) {
            errs.push(err(
                "DUPLICATE_ID",
                format!("{pp}/id"),
                format!("part id {:?}", part.id),
            ));
        }
        if part.name.is_empty() {
            errs.push(err(
                "INVALID_NAME",
                format!("{pp}/name"),
                "part names must be non-empty",
            ));
        } else if !part_names.insert(part.name.as_str()) {
            errs.push(err(
                "DUPLICATE_NAME",
                format!("{pp}/name"),
                format!("part {:?}", part.name),
            ));
        }
        validate_part(part, &pp, &mut feature_ids, &mut feature_names, &mut errs);
    }
    if errs.is_empty() { Ok(()) } else { Err(errs) }
}

fn validate_part<'a>(
    part: &'a PartStudio,
    pp: &str,
    ids: &mut BTreeSet<&'a str>,
    names: &mut BTreeSet<&'a str>,
    errs: &mut Vec<ValidationError>,
) {
    // Names of sketch features seen so far (features may only reference earlier ones).
    let mut sketches_before: BTreeSet<&str> = BTreeSet::new();
    for (fi, f) in part.features.iter().enumerate() {
        let fp = format!("{pp}/features/{fi}");
        if !ids.insert(f.id()) {
            errs.push(err(
                "DUPLICATE_ID",
                format!("{fp}/id"),
                format!("feature id {:?}", f.id()),
            ));
        }
        if !names.insert(f.name()) {
            errs.push(err(
                "DUPLICATE_NAME",
                format!("{fp}/name"),
                format!("{:?}", f.name()),
            ));
        }
        if !is_identifier(f.name()) {
            errs.push(err(
                "INVALID_NAME",
                format!("{fp}/name"),
                format!(
                    "{:?} must match [A-Za-z_][A-Za-z0-9_]* (it is a CadScript const)",
                    f.name()
                ),
            ));
        } else if RESERVED_NAMES.contains(&f.name()) {
            errs.push(err(
                "RESERVED_NAME",
                format!("{fp}/name"),
                format!(
                    "{:?} is a reserved word or CadScript builtin; pick another name",
                    f.name()
                ),
            ));
        }
        match f {
            Feature::Sketch(s) => {
                validate_sketch(s, &fp, errs);
                sketches_before.insert(s.name.as_str());
            }
            Feature::Extrude(e) => {
                check_sketch_ref(&e.sketch, &sketches_before, &fp, errs);
                if !(e.distance.is_finite() && e.distance > LINEAR_TOLERANCE) {
                    errs.push(err(
                        "INVALID_DISTANCE",
                        format!("{fp}/distance"),
                        format!(
                            "must be finite and > {LINEAR_TOLERANCE} mm, got {}",
                            e.distance
                        ),
                    ));
                }
            }
            Feature::Revolve(r) => {
                check_sketch_ref(&r.sketch, &sketches_before, &fp, errs);
                if !(r.angle.is_finite() && r.angle > 0.0 && r.angle <= 360.0) {
                    errs.push(err(
                        "INVALID_ANGLE",
                        format!("{fp}/angle"),
                        format!("must be in (0, 360] degrees, got {}", r.angle),
                    ));
                }
                let d = r.axis.direction;
                if !(finite2(r.axis.origin) && finite2(d))
                    || (d[0] * d[0] + d[1] * d[1]).sqrt() <= LINEAR_TOLERANCE
                {
                    errs.push(err(
                        "INVALID_AXIS",
                        format!("{fp}/axis"),
                        "axis origin/direction must be finite and direction non-zero",
                    ));
                }
            }
        }
    }
}

fn check_sketch_ref(
    name: &str,
    sketches_before: &BTreeSet<&str>,
    fp: &str,
    errs: &mut Vec<ValidationError>,
) {
    if !sketches_before.contains(name) {
        errs.push(err(
            "UNRESOLVED_SKETCH",
            format!("{fp}/sketch"),
            format!("{name:?} is not an earlier sketch feature in this part studio"),
        ));
    }
}

fn validate_sketch(s: &SketchFeature, fp: &str, errs: &mut Vec<ValidationError>) {
    if let PlaneSpec::Frame(f) = &s.plane {
        let n = len3(f.normal);
        let x = len3(f.x_dir);
        let finite = f
            .origin
            .iter()
            .chain(&f.normal)
            .chain(&f.x_dir)
            .all(|v| v.is_finite());
        if !finite || n <= LINEAR_TOLERANCE || x <= LINEAR_TOLERANCE {
            errs.push(err(
                "INVALID_PLANE",
                format!("{fp}/plane"),
                "degenerate frame",
            ));
        } else {
            let dot =
                (f.normal[0] * f.x_dir[0] + f.normal[1] * f.x_dir[1] + f.normal[2] * f.x_dir[2])
                    / (n * x);
            if dot.abs() > 1e-9 {
                errs.push(err(
                    "INVALID_PLANE",
                    format!("{fp}/plane"),
                    format!("normal and x_dir must be perpendicular (cos = {dot:e})"),
                ));
            }
        }
    }
    if s.curves.is_empty() {
        errs.push(err(
            "EMPTY_SKETCH",
            format!("{fp}/curves"),
            "a sketch needs at least one curve",
        ));
    }
    let mut ids = BTreeSet::new();
    for (ci, c) in s.curves.iter().enumerate() {
        let cp = format!("{fp}/curves/{ci}");
        if !ids.insert(c.id()) {
            errs.push(err(
                "DUPLICATE_ID",
                format!("{cp}/id"),
                format!("curve id {:?}", c.id()),
            ));
        }
        match c {
            SketchCurve::Line { start, end, .. } => {
                if !(finite2(*start) && finite2(*end)) {
                    errs.push(err("NON_FINITE", &cp, "line endpoints must be finite"));
                } else if dist2(*start, *end) <= LINEAR_TOLERANCE {
                    errs.push(err("DEGENERATE_CURVE", &cp, "zero-length line"));
                }
            }
            SketchCurve::Arc {
                start, end, center, ..
            } => {
                if !(finite2(*start) && finite2(*end) && finite2(*center)) {
                    errs.push(err("NON_FINITE", &cp, "arc points must be finite"));
                    continue;
                }
                let r0 = dist2(*start, *center);
                let r1 = dist2(*end, *center);
                if r0 <= LINEAR_TOLERANCE || r1 <= LINEAR_TOLERANCE {
                    errs.push(err("DEGENERATE_CURVE", &cp, "zero-radius arc"));
                } else if (r0 - r1).abs() > LINEAR_TOLERANCE {
                    errs.push(err(
                        "INCONSISTENT_ARC",
                        &cp,
                        format!("|start−center| = {r0} but |end−center| = {r1}"),
                    ));
                } else if dist2(*start, *end) <= LINEAR_TOLERANCE {
                    errs.push(err(
                        "DEGENERATE_CURVE",
                        &cp,
                        "arc start == end; use a circle for a full turn",
                    ));
                }
            }
            SketchCurve::Circle { center, radius, .. } => {
                if !(finite2(*center) && radius.is_finite()) {
                    errs.push(err(
                        "NON_FINITE",
                        &cp,
                        "circle center and radius must be finite",
                    ));
                } else if *radius <= LINEAR_TOLERANCE {
                    errs.push(err("DEGENERATE_CURVE", &cp, "circle radius must be > 0"));
                }
            }
        }
    }
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c == '_' || c.is_ascii_alphabetic())
        && chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
}

fn finite2(p: [f64; 2]) -> bool {
    p[0].is_finite() && p[1].is_finite()
}

fn dist2(a: [f64; 2], b: [f64; 2]) -> f64 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt()
}

fn len3(v: [f64; 3]) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}
