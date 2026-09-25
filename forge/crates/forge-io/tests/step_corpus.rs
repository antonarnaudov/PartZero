//! STEP export of real Forge bodies: every operand and result of the boolean corpus is
//! written, re-read and verified by `write_step` itself, and the writer's counts must
//! account exactly for Forge's topology: faces unchanged, edges equal to Forge's plus the
//! split pieces and seams, vertices equal to Forge's plus the synthesized ones. The OCCT
//! oracle (`oracle/src/aicad_oracle/step_check.py`) checks the same files' volumes, areas
//! and validity independently.

mod common {
    pub mod step_corpus;
    pub mod step_mutate;
}

use common::step_corpus::{NamedBody, corpus, samples};
use common::step_mutate::{flip_face, invert_shells};
use forge_io::step::{StepBody, StepOptions, verify_step, write_step};

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs()).max(1e-300)
}

/// Forge's exact volume and area of a corpus body.
fn exact(b: &NamedBody) -> (f64, f64) {
    match b.known {
        Some((v, a, _, _)) => (v, a),
        None => {
            let m = forge_check::mass_properties(&b.body)
                .unwrap_or_else(|e| panic!("{}: mass properties: {e}", b.name));
            (m.volume, m.area)
        }
    }
}

fn check(b: &NamedBody, unsupported: &mut Vec<String>) {
    let item = StepBody {
        name: &b.name,
        body: &b.body,
        color: None,
    };
    match write_step(&[item], &StepOptions::default()) {
        Ok((bytes, report)) => {
            let r = &report.bodies[0];
            let c = b.body.counts();
            assert_eq!(r.faces, c.faces, "{}: faces", b.name);
            assert_eq!(
                r.edges - r.seam_edges - r.split_pieces,
                c.edges,
                "{}: edges {r:?}",
                b.name
            );
            assert_eq!(
                r.vertices,
                c.vertices + r.new_vertices,
                "{}: vertices {r:?}",
                b.name
            );
            let s = verify_step(&bytes).expect("verifies");
            let faces: usize = s.solids.iter().map(|x| x.faces).sum();
            assert_eq!(faces, c.faces, "{}", b.name);
            let seams: usize = s.solids.iter().map(|x| x.seam_edges).sum();
            assert_eq!(seams, r.seam_edges, "{}: seams read back", b.name);
            // The verifier's own volume and area (the faces as the file bounds them) are
            // Forge's exact metrics.
            let (volume, area) = exact(b);
            let v: f64 = s.solids.iter().map(|x| x.volume).sum();
            let a: f64 = s.solids.iter().map(|x| x.area).sum();
            assert!(
                rel(v, volume) < 1e-6,
                "{}: volume {v} vs Forge {volume}",
                b.name
            );
            assert!(rel(a, area) < 1e-6, "{}: area {a} vs Forge {area}", b.name);
        }
        Err(e) if e.code().starts_with("STEP_UNSUPPORTED") => {
            unsupported.push(format!("{}: {} {e}", b.name, e.code()));
        }
        Err(e) => panic!("{}: {} {e}", b.name, e.code()),
    }
}

#[test]
fn every_boolean_corpus_body_exports_and_verifies() {
    let n = if cfg!(debug_assertions) { 60 } else { 400 };
    let mut unsupported = Vec::new();
    let mut total = 0;
    for seed in [1u64, 7] {
        for b in corpus(seed, n) {
            total += 1;
            check(&b, &mut unsupported);
        }
    }
    assert!(total > 100, "only {total} bodies");
    assert!(
        unsupported.is_empty(),
        "{} of {total} bodies were refused:\n{}",
        unsupported.len(),
        unsupported.join("\n")
    );
}

#[test]
fn hand_built_samples_including_bspline_faces_export_and_verify() {
    let mut unsupported = Vec::new();
    for b in samples() {
        check(&b, &mut unsupported);
    }
    assert!(unsupported.is_empty(), "{unsupported:?}");
}

#[test]
fn export_is_deterministic() {
    let bodies = corpus(3, 12);
    let items: Vec<StepBody<'_>> = bodies
        .iter()
        .map(|b| StepBody {
            name: &b.name,
            body: &b.body,
            color: Some([0.2, 0.4, 0.6]),
        })
        .collect();
    let (a, _) = write_step(&items, &StepOptions::default()).expect("writes");
    let (b, _) = write_step(&items, &StepOptions::default()).expect("writes");
    assert_eq!(a, b);
    let s = verify_step(&a).expect("verifies");
    assert!(s.solids.len() >= bodies.len());
}

/// Every face of real bodies turned inside out, one at a time: the verifier rejects it, or
/// (for a face whose loops alone do not decide its side, such as a spherical lune between
/// two pole-to-pole edges) the volume or area it then measures is no longer Forge's. And
/// every shell turned inside out as a whole is rejected.
#[test]
fn every_inside_out_face_or_shell_of_the_corpus_is_caught() {
    let n = if cfg!(debug_assertions) { 24 } else { 120 };
    let (mut flips, mut by_verifier, mut by_metrics) = (0, 0, 0);
    let mut escaped = Vec::new();
    let mut bodies = samples();
    bodies.extend(corpus(1, n));
    for b in &bodies {
        let item = StepBody {
            name: &b.name,
            body: &b.body,
            color: None,
        };
        let Ok((bytes, _)) = write_step(&[item], &StepOptions::default()) else {
            continue;
        };
        let text = String::from_utf8(bytes).expect("ascii");
        let e = verify_step(invert_shells(&text).as_bytes())
            .expect_err(&format!("{}: inside-out shells verify", b.name));
        assert!(e.to_string().contains("point inwards"), "{}: {e}", b.name);
        let (volume, area) = exact(b);
        for k in 0..text.matches("=ADVANCED_FACE(").count() {
            flips += 1;
            match verify_step(flip_face(&text, k).as_bytes()) {
                Err(e) => {
                    assert_eq!(e.code(), "STEP_SELF_CHECK", "{}: {e}", b.name);
                    by_verifier += 1;
                }
                Ok(s) => {
                    let v: f64 = s.solids.iter().map(|x| x.volume).sum();
                    let a: f64 = s.solids.iter().map(|x| x.area).sum();
                    if rel(v, volume) > 1e-6 || rel(a, area) > 1e-6 {
                        by_metrics += 1;
                    } else {
                        escaped.push(format!("{} face {k}", b.name));
                    }
                }
            }
        }
    }
    eprintln!(
        "{flips} flipped faces: {by_verifier} rejected by the verifier, {by_metrics} by metrics"
    );
    assert!(escaped.is_empty(), "flipped faces not caught: {escaped:?}");
    assert!(flips > 300, "only {flips} faces");
    // The verifier alone decides nearly every face.
    assert!(
        by_verifier * 100 >= flips * 97,
        "{by_verifier} of {flips} flips rejected by the verifier, {by_metrics} only by metrics"
    );
}
