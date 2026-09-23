//! # forge-regen — evaluation of IR documents
//!
//! [`evaluate`] runs every part studio's feature timeline in order (SPEC §4):
//! - suppressed features are skipped and produce no entry;
//! - a sketch produces its regions ([`forge_ops::regions`]);
//! - `extrude` / `revolve` produce one body per region of the referenced sketch, in
//!   canonical region order; referencing a suppressed sketch fails with
//!   `SKETCH_SUPPRESSED`, a failed sketch with `DEPENDENCY_FAILED` [R-1];
//! - a revolve first checks every region against the axis, so one crossing region fails
//!   the whole feature [R-7];
//! - every produced body must pass [`forge_check::validate`], otherwise the feature fails
//!   with `INVALID_RESULT` [R-12];
//! - a failure never stops later features.
//!
//! [`report`] turns an [`Evaluation`] into the `aicad.metrics/0` report. The output is
//! deterministic: same document, same bytes, on every target.

use std::collections::BTreeMap;

use forge_check::{CheckError, body_metrics, validate};
use forge_core::Tolerance;
use forge_core::linalg::Frame;
use forge_core::topo::{Body, Severity};
use forge_ir::{
    BodyMetrics, Document, EvalReport, Feature, FeatureReport, METRICS_SCHEMA, RegionMetrics,
    ReportError, SketchFeature, Status,
};
use forge_ops::{OpError, Region, check_revolve_profile, extrude, regions, revolve, sketch_frame};

/// What a successful feature produced.
#[derive(Clone, Debug)]
pub enum FeatureOutput {
    /// A sketch's regions, in canonical order.
    Regions(Vec<Region>),
    /// A body feature's bodies, one per region in canonical region order.
    Bodies(Vec<Body>),
}

/// The evaluation of one (non-suppressed) feature.
#[derive(Clone, Debug)]
pub struct FeatureEval {
    /// Part studio name.
    pub part: String,
    /// Feature name.
    pub feature: String,
    /// Feature type (`sketch`, `extrude`, `revolve`).
    pub feature_type: &'static str,
    /// The result.
    pub outcome: Result<FeatureOutput, OpError>,
}

/// The evaluation of a document: one entry per non-suppressed feature, in timeline order
/// over all part studios.
#[derive(Clone, Debug, Default)]
pub struct Evaluation {
    /// Feature results.
    pub features: Vec<FeatureEval>,
}

impl Evaluation {
    /// `true` if every feature succeeded.
    pub fn is_ok(&self) -> bool {
        self.features.iter().all(|f| f.outcome.is_ok())
    }
}

enum SketchState {
    Suppressed,
    Done(Result<(Frame, Vec<Region>), OpError>),
}

fn eval_sketch(s: &SketchFeature) -> Result<(Frame, Vec<Region>), OpError> {
    let frame = sketch_frame(&s.plane)?;
    let regs = regions(s, &Tolerance::IR_DEFAULT)?;
    Ok((frame, regs))
}

fn with_sketch<'a>(
    sketches: &'a BTreeMap<String, SketchState>,
    name: &str,
) -> Result<&'a (Frame, Vec<Region>), OpError> {
    match sketches.get(name) {
        None => Err(OpError::UnresolvedSketch {
            sketch: name.to_string(),
        }),
        Some(SketchState::Suppressed) => Err(OpError::SketchSuppressed {
            sketch: name.to_string(),
        }),
        Some(SketchState::Done(Err(e))) => Err(OpError::DependencyFailed {
            sketch: name.to_string(),
            code: e.code().to_string(),
            message: e.to_string(),
        }),
        Some(SketchState::Done(Ok(v))) => Ok(v),
    }
}

/// SPEC §4 [R-12]: a produced body must pass Forge's own validity check.
fn checked(body: Body) -> Result<Body, OpError> {
    let issues: Vec<String> = validate(&body)
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .map(ToString::to_string)
        .collect();
    if issues.is_empty() {
        Ok(body)
    } else {
        Err(OpError::InvalidResult { issues })
    }
}

/// Evaluate a (structurally valid) document.
pub fn evaluate(doc: &Document) -> Evaluation {
    let mut out = Evaluation::default();
    for part in &doc.parts {
        let mut sketches: BTreeMap<String, SketchState> = BTreeMap::new();
        for f in &part.features {
            if let Feature::Sketch(s) = f
                && s.suppressed
            {
                sketches.insert(s.name.clone(), SketchState::Suppressed);
            }
            if f.suppressed() {
                continue;
            }
            let outcome = match f {
                Feature::Sketch(s) => {
                    let r = eval_sketch(s);
                    let outcome = r.clone().map(|(_, regs)| FeatureOutput::Regions(regs));
                    sketches.insert(s.name.clone(), SketchState::Done(r));
                    outcome
                }
                Feature::Extrude(e) => {
                    with_sketch(&sketches, &e.sketch).and_then(|(frame, regs)| {
                        regs.iter()
                            .map(|r| {
                                extrude(r, frame, e.distance, e.direction, &e.name)
                                    .and_then(checked)
                            })
                            .collect::<Result<Vec<_>, _>>()
                            .map(FeatureOutput::Bodies)
                    })
                }
                Feature::Revolve(v) => {
                    with_sketch(&sketches, &v.sketch).and_then(|(frame, regs)| {
                        for r in regs {
                            check_revolve_profile(r, &v.axis, Tolerance::IR_DEFAULT.linear)?;
                        }
                        regs.iter()
                            .map(|r| {
                                revolve(r, frame, &v.axis, v.angle, v.direction, &v.name)
                                    .and_then(checked)
                            })
                            .collect::<Result<Vec<_>, _>>()
                            .map(FeatureOutput::Bodies)
                    })
                }
            };
            out.features.push(FeatureEval {
                part: part.name.clone(),
                feature: f.name().to_string(),
                feature_type: f.type_name(),
                outcome,
            });
        }
    }
    out
}

/// Replace `-0.0` by `0.0` (both are valid, but one spelling keeps reports stable).
fn clean(x: f64) -> f64 {
    x + 0.0
}

fn finite_metrics(m: &BodyMetrics) -> bool {
    std::iter::once(m.volume)
        .chain(std::iter::once(m.area))
        .chain(m.centroid)
        .chain(m.bbox_min)
        .chain(m.bbox_max)
        .all(f64::is_finite)
}

fn metrics_of(body: &Body) -> Result<BodyMetrics, CheckError> {
    let mut m = body_metrics(body)?;
    if !finite_metrics(&m) {
        return Err(CheckError::NonFinite {
            what: "body metrics",
        });
    }
    m.volume = clean(m.volume);
    m.area = clean(m.area);
    m.centroid = m.centroid.map(clean);
    m.bbox_min = m.bbox_min.map(clean);
    m.bbox_max = m.bbox_max.map(clean);
    Ok(m)
}

fn error_entry(fe: &FeatureEval, code: &str, message: String) -> FeatureReport {
    FeatureReport {
        part: fe.part.clone(),
        feature: fe.feature.clone(),
        feature_type: fe.feature_type.to_string(),
        status: Status::Error,
        error: Some(ReportError {
            code: code.to_string(),
            message,
        }),
        regions: Vec::new(),
        bodies: Vec::new(),
    }
}

/// The `aicad.metrics/0` report of an evaluation (SPEC §5). `engine` is free text such
/// as `forge 0.0.1`; `document_name` is the document's `meta.name` or file stem (an
/// empty name falls back to `meta.name`).
pub fn report(doc: &Document, eval: &Evaluation, engine: &str, document_name: &str) -> EvalReport {
    let mut features = Vec::with_capacity(eval.features.len());
    for fe in &eval.features {
        let entry = match &fe.outcome {
            Err(e) => error_entry(fe, e.code(), e.to_string()),
            Ok(FeatureOutput::Regions(regs)) => {
                let regions: Vec<RegionMetrics> = regs
                    .iter()
                    .map(|r| RegionMetrics {
                        area: clean(r.area),
                        loops: r.loop_count() as u32,
                        outer_curves: r.outer_curves.clone(),
                    })
                    .collect();
                if regions.iter().all(|r| r.area.is_finite()) {
                    FeatureReport {
                        part: fe.part.clone(),
                        feature: fe.feature.clone(),
                        feature_type: fe.feature_type.to_string(),
                        status: Status::Ok,
                        error: None,
                        regions,
                        bodies: Vec::new(),
                    }
                } else {
                    error_entry(fe, "FORGE_NON_FINITE", "non-finite region area".into())
                }
            }
            Ok(FeatureOutput::Bodies(bodies)) => {
                match bodies.iter().map(metrics_of).collect::<Result<Vec<_>, _>>() {
                    Ok(bodies) => FeatureReport {
                        part: fe.part.clone(),
                        feature: fe.feature.clone(),
                        feature_type: fe.feature_type.to_string(),
                        status: Status::Ok,
                        error: None,
                        regions: Vec::new(),
                        bodies,
                    },
                    Err(e) => error_entry(fe, e.code(), e.to_string()),
                }
            }
        };
        features.push(entry);
    }
    let status = if features.iter().all(|f| f.status == Status::Ok) {
        Status::Ok
    } else {
        Status::Error
    };
    let document = if document_name.is_empty() {
        doc.meta.name.clone()
    } else {
        document_name.to_string()
    };
    EvalReport {
        schema: METRICS_SCHEMA.to_string(),
        engine: engine.to_string(),
        document,
        status,
        error: None,
        features,
    }
}

/// The engine identifier Forge writes into reports: `forge <version>`.
pub fn engine_id() -> String {
    format!("forge {}", env!("CARGO_PKG_VERSION"))
}
