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
//! deterministic: same document, same bytes, on every target. Error messages name
//! entities by provenance, never by arena id: forge-check and forge-ops name them with
//! [`forge_core::topo::EntityNames`] while the body exists, and every message still passes
//! [`forge_core::topo::scrub_arena_ids`] as a backstop.
//!
//! IR v1 (`aicad.ir/1`, SPEC-v1) is evaluated by [`v1`] ([`v1::evaluate`], [`v1::report`]:
//! the `aicad.metrics/1` report). The v0 functions of this module stay the evaluator of v0
//! documents with the `aicad.metrics/0` report, unchanged byte for byte; [`v1::load`]
//! migrates a v0 document for engines that want its v1 report (SPEC-v1 §0.2 rule 4).

pub mod v1;

use std::collections::BTreeMap;

use forge_check::{CheckError, body_metrics, validate};
use forge_core::Tolerance;
use forge_core::linalg::Frame;
use forge_core::topo::{Body, Severity, scrub_arena_ids};
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
pub(crate) fn checked(body: Body) -> Result<Body, OpError> {
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

/// A failed feature's report entry. Every message passes [`scrub_arena_ids`], a backstop:
/// entities are named where the body exists (forge-ops' `INVALID_RESULT`, forge-check's
/// issues), but an error built without the body (a builder error) may still carry
/// `Debug`-formatted arena ids, which never leave the process.
fn error_entry(fe: &FeatureEval, code: &str, message: String) -> FeatureReport {
    let message = scrub_arena_ids(&message);
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

#[cfg(test)]
mod tests {
    //! SPEC §4 [R-12]: a body that fails Forge's own validity check never reaches a report
    //! as `ok`; the feature fails with `INVALID_RESULT`.

    use forge_core::geom::{Sphere, Surface};
    use forge_core::linalg::Frame;
    use forge_core::topo::{BodyBuilder, Provenance, samples};

    use super::*;

    /// Balls centred at the origin, one shell each: `(radius, sense, shell closed)`.
    fn balls(spec: &[(f64, bool, bool)]) -> Body {
        let mut b = BodyBuilder::new();
        for (i, &(r, sense, closed)) in spec.iter().enumerate() {
            let shell = b.add_shell(closed);
            let s = Sphere::new(Frame::world(), r).expect("sphere");
            b.add_face(
                shell,
                Surface::Sphere(s),
                sense,
                Provenance::side("ball", format!("s{i}")),
            )
            .expect("face");
        }
        b.finish()
    }

    fn invalid_issues(body: Body) -> Vec<String> {
        match checked(body) {
            Err(e @ OpError::InvalidResult { .. }) => {
                assert_eq!(e.code(), "INVALID_RESULT");
                let OpError::InvalidResult { issues } = e else {
                    unreachable!()
                };
                issues
            }
            Err(e) => panic!("expected INVALID_RESULT, got {} ({e})", e.code()),
            Ok(_) => panic!("an invalid body passed checked()"),
        }
    }

    #[test]
    fn checked_passes_valid_bodies() {
        assert!(checked(samples::unit_cube()).is_ok());
        // A hollow ball: the cavity shell points into the void (sense false).
        assert!(checked(balls(&[(3.0, true, true), (1.0, false, true)])).is_ok());
    }

    #[test]
    fn checked_turns_an_inward_body_into_invalid_result() {
        let issues = invalid_issues(balls(&[(2.0, false, true)]));
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(issues[0].starts_with("[NEGATIVE_VOLUME]"), "{issues:?}");
    }

    #[test]
    fn checked_turns_an_open_shell_into_invalid_result() {
        let issues = invalid_issues(balls(&[(2.0, true, false)]));
        assert!(
            issues
                .iter()
                .any(|i| i.starts_with("[SHELL_NOT_CLOSED] shell 0 (ball/side:s0)")),
            "{issues:?}"
        );
    }

    #[test]
    fn checked_rejects_a_cavity_that_points_into_the_material() {
        // Outer ball and a cavity ball both oriented outwards: the signed volume
        // V_outer + V_cavity is positive, so only the per-shell check catches it.
        let issues = invalid_issues(balls(&[(3.0, true, true), (1.0, true, true)]));
        assert_eq!(issues.len(), 1, "{issues:?}");
        assert!(
            issues[0].starts_with("[FORGE_SHELL_ORIENTATION] shell 1 (ball/side:s1)"),
            "{issues:?}"
        );
    }

    #[test]
    fn invalid_result_reaches_the_report_as_an_error_without_arena_ids() {
        let doc = forge_ir::from_json(
            r#"{"schema":"aicad.ir/0","meta":{"name":"x"},"parts":[{"id":"p1","name":"p",
               "features":[{"type":"sketch","id":"s1","name":"sk","plane":"XY","curves":[
               {"kind":"circle","id":"c","center":[0,0],"radius":1}]}]}]}"#,
        )
        .expect("valid IR");
        let outcome = checked(balls(&[(3.0, true, true), (1.0, true, true)]))
            .map(|b| FeatureOutput::Bodies(vec![b]));
        let eval = Evaluation {
            features: vec![FeatureEval {
                part: "p".into(),
                feature: "body".into(),
                feature_type: "revolve",
                outcome,
            }],
        };
        let r = report(&doc, &eval, "forge test", "x");
        assert_eq!(r.status, Status::Error);
        let f = &r.features[0];
        assert_eq!(f.status, Status::Error);
        assert!(f.bodies.is_empty());
        let e = f.error.as_ref().expect("error");
        assert_eq!(e.code, "INVALID_RESULT");
        assert!(!has_arena_id(&e.message), "arena id in {:?}", e.message);
    }

    /// `true` if `s` holds a forge-core id's `Debug` form `Kind#<index>v<generation>`.
    fn has_arena_id(s: &str) -> bool {
        s.match_indices('#').any(|(i, _)| {
            let before = s[..i]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_ascii_alphabetic());
            let rest = &s[i + 1..];
            let n = rest.chars().take_while(char::is_ascii_digit).count();
            before && n > 0 && rest[n..].starts_with('v')
        })
    }

    #[test]
    fn arena_ids_in_error_messages_never_reach_the_report() {
        // Audit L3, the backstop: forge-ops names entities while the body exists (see
        // `forge_ops` plan tests), but an error built without the body can still carry
        // `TopoIssue`'s Display, `[CODE] Edge(Edge#3v0): …`. Build such a message (a unit
        // cube with a second copy of one face: its edges are used three times) with the
        // in-process Display and check that the report scrubs it.
        let cube = samples::unit_cube();
        let (_, f) = cube.faces().iter().next().expect("face");
        let uses: Vec<_> = cube
            .loop_(f.loops[0])
            .expect("loop")
            .coedges
            .iter()
            .map(|&c| {
                let c = cube.coedge(c).expect("coedge");
                (c.edge, c.forward)
            })
            .collect();
        let (surface, sense, shell) = (f.surface.clone(), f.sense, f.shell);
        let mut bb = BodyBuilder::from_body(cube.clone(), Tolerance::IR_DEFAULT);
        let dup = bb
            .add_face(shell, surface, sense, Provenance::side("dup", "a"))
            .expect("face");
        bb.add_loop(dup, &uses).expect("loop");
        let issues = bb.finish_validated().expect_err("edges used three times");
        let err = OpError::InvalidResult {
            issues: issues
                .iter()
                .filter(|i| i.severity == Severity::Error)
                .map(ToString::to_string)
                .collect(),
        };
        // The op-level message does carry ids …
        assert!(has_arena_id(&err.to_string()), "{err}");
        let doc = forge_ir::from_json(
            r#"{"schema":"aicad.ir/0","meta":{"name":"x"},"parts":[{"id":"p1","name":"p",
               "features":[{"type":"sketch","id":"s1","name":"sk","plane":"XY","curves":[
               {"kind":"circle","id":"c","center":[0,0],"radius":1}]}]}]}"#,
        )
        .expect("valid IR");
        let eval = Evaluation {
            features: vec![FeatureEval {
                part: "p".into(),
                feature: "body".into(),
                feature_type: "extrude",
                outcome: Err(err),
            }],
        };
        // … the report's does not.
        let r = report(&doc, &eval, "forge test", "x");
        let e = r.features[0].error.as_ref().expect("error");
        assert_eq!(e.code, "INVALID_RESULT");
        assert!(!has_arena_id(&e.message), "arena id in {:?}", e.message);
        assert!(e.message.contains("an edge"), "{:?}", e.message);
    }
}
