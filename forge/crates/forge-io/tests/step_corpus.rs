//! STEP export of real Forge bodies: every operand and result of the boolean corpus is
//! written, re-read and verified by `write_step` itself, and the writer's counts must
//! account exactly for Forge's topology: faces unchanged, edges equal to Forge's plus the
//! split pieces and seams, vertices equal to Forge's plus the synthesized ones. The OCCT
//! oracle (`oracle/src/aicad_oracle/step_check.py`) checks the same files' volumes, areas
//! and validity independently.

mod common {
    pub mod step_corpus;
}

use common::step_corpus::{NamedBody, corpus, samples};
use forge_io::step::{StepBody, StepOptions, verify_step, write_step};

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
