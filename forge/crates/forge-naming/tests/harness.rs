//! The spike-2 harness as a regression test: the criteria hold on all models, the
//! ground truth agrees with provenance on every unedited model, every reference of an
//! unedited model resolves exactly to itself, and runs are deterministic.

use forge_naming::AUTO_ACCEPT_CONFIDENCE;
use forge_naming::harness::mutate::Family;
use forge_naming::harness::{self, Outcome, models::models, report};

#[test]
fn spike_criteria_hold_on_all_models() {
    let rep = harness::run();
    let c = report::criteria(&rep);
    let silent: Vec<String> = rep
        .refs
        .iter()
        .filter(|r| r.outcome == Outcome::SilentWrong)
        .map(|r| {
            format!(
                "{} {} {}: {} / {}",
                r.model, r.mutation, r.name, r.expected, r.resolution
            )
        })
        .collect();
    assert!(
        silent.is_empty(),
        "silent-wrong references:\n{}",
        silent.join("\n")
    );
    assert!(c.go(), "{c:?}");

    // 12–20 models, each with at least 10 accepted mutations, fully labelled, and the
    // ground truth agreeing one-to-one with provenance names before any edit.
    assert!((12..=20).contains(&rep.sanity.len()));
    for s in &rep.sanity {
        assert!(s.mutations >= 10, "{}: {} mutations", s.model, s.mutations);
        assert_eq!(s.unlabelled, 0, "{}", s.model);
        assert_eq!(s.agree, s.entities, "{}", s.model);
    }
    // Every family is exercised and nothing is excluded from scoring.
    for f in [Family::Dimension, Family::Suppress, Family::Topology] {
        assert!(rep.mutations.iter().any(|m| m.family == f), "{f:?}");
    }
    assert!(rep.refs.iter().all(|r| r.outcome != Outcome::Excluded));
    assert!(rep.mutations.iter().all(|m| m.truth_problems == 0));

    // Auto-accept confidence is reserved for geometry-identical matches.
    for r in &rep.refs {
        if r.status != "exact" && r.confidence >= AUTO_ACCEPT_CONFIDENCE {
            assert_eq!(
                r.status, "geometric",
                "{} {} {}",
                r.model, r.mutation, r.name
            );
        }
    }
}

#[test]
fn every_reference_resolves_exactly_to_itself_on_an_unedited_model() {
    for m in models() {
        let failures = harness::identity_failures(&m.doc);
        assert!(failures.is_empty(), "{}: {failures:?}", m.name);
    }
}

#[test]
fn harness_runs_are_deterministic() {
    let pick = [
        "t1-knob",
        "t5-pcb-spacers",
        "naming-d-coupler-plate",
        "naming-revolve-bead-partial",
    ];
    let subset: Vec<_> = models()
        .into_iter()
        .filter(|m| pick.contains(&m.name))
        .collect();
    assert_eq!(subset.len(), pick.len());
    let a = report::render(&harness::run_models(&subset));
    let b = report::render(&harness::run_models(&subset));
    assert_eq!(a, b);
}
