//! The naming harness in v1 mode (every reference an IR v1 query resolved by forge-refs) as a
//! regression gate: the W3 criteria hold on all 20 spike models with 0 SILENT_WRONG — in the
//! single-edit families and in (g) two edits against a stale capture, (h) multi-member and
//! (i) pick references —, every reference of an unedited model resolves exactly to itself,
//! and runs are deterministic.

use forge_ir::v1::metrics::RefStatus;
use forge_naming::harness::Outcome;
use forge_naming::harness::models::models;
use forge_naming::harness::v1::{self, V1Family};

#[test]
fn v1_criteria_hold_on_all_models() {
    let rep = v1::run_v1();
    let c = v1::criteria_v1(&rep);
    let silent: Vec<String> = rep
        .refs
        .iter()
        .filter(|r| r.outcome == Outcome::SilentWrong)
        .map(|r| {
            format!(
                "{} {} {}: {} / {}",
                r.model, r.mutation, r.key, r.expected, r.resolution
            )
        })
        .collect();
    assert!(
        silent.is_empty(),
        "silent-wrong references:\n{}",
        silent.join("\n")
    );
    assert!(
        rep.identity_failures.is_empty(),
        "{:#?}",
        rep.identity_failures
    );
    assert!(rep.key_problems.is_empty(), "{:#?}", rep.key_problems);
    assert_eq!(
        rep.captures_with_index, 0,
        "`#k` never appears in a capture"
    );
    assert_eq!(
        rep.auto_accept_violations, 0,
        "only geometry-identical matches reach 0.95"
    );
    assert_eq!(rep.models, 20);
    for f in [
        V1Family::Dimension,
        V1Family::Suppress,
        V1Family::Topology,
        V1Family::RenameCurve,
        V1Family::RenameFeature,
        V1Family::Parameter,
        V1Family::TwoStep,
        V1Family::MultiMember,
        V1Family::Pick,
    ] {
        assert!(
            rep.mutations.get(&f).copied().unwrap_or(0) > 0,
            "{f:?} exercised"
        );
        assert!(
            rep.refs.iter().any(|r| r.family == f),
            "{f:?} has references"
        );
    }
    // (g) covers the stale-capture sequences the reviewers named: a reversal and a split
    // after an exact commit that did not refresh the capture.
    for pair in ["extrude_distance", "scale_sketch"] {
        for second in ["reverse_curve", "split_line_keep_id"] {
            assert!(
                rep.refs.iter().any(|r| r.family == V1Family::TwoStep
                    && r.mutation.starts_with(pair)
                    && r.mutation.contains(&format!(" + {second}"))),
                "(g) {pair} + {second} exercised"
            );
        }
    }
    // (h) and (i) hold multi-member captures and picks (`extreme`, `largest`, `filter`).
    for op in ["\"extreme\"", "\"largest\"", "\"filter\""] {
        assert!(
            rep.refs
                .iter()
                .any(|r| r.family == V1Family::Pick && r.query.contains(op)),
            "(i) {op} exercised"
        );
    }
    // (i) scores picks over split sources (the pick over every piece is the truth): none is
    // excluded any more, and splits are among the scored ones.
    assert!(
        rep.refs
            .iter()
            .filter(|r| r.family == V1Family::Pick)
            .all(|r| r.outcome != Outcome::Excluded),
        "(i) excludes no reference"
    );
    assert!(
        rep.refs
            .iter()
            .any(|r| r.family == V1Family::Pick && r.mutation.starts_with("split_line_keep_id")),
        "(i) picks over split sources are scored"
    );
    // Renames and parameter edits resolve exactly, never through a geometric match.
    for r in rep.refs.iter().filter(|r| {
        matches!(
            r.family,
            V1Family::RenameCurve | V1Family::RenameFeature | V1Family::Parameter
        )
    }) {
        assert_eq!(
            r.status,
            RefStatus::Exact,
            "{} {} {}: {}",
            r.model,
            r.mutation,
            r.key,
            r.resolution
        );
    }
    // The parameter family holds parameter-dependent queries (the scalar hook is live).
    assert!(
        rep.refs
            .iter()
            .any(|r| r.family == V1Family::Parameter && r.query.contains("\"radius\"")),
        "no parameter-dependent reference was exercised"
    );
    assert!(c.go(), "{c:?}\n{}", v1::render_v1(&rep));
}

#[test]
fn every_v1_reference_resolves_exactly_to_itself_on_an_unedited_model() {
    for m in models() {
        let failures = v1::v1_identity_failures(&m.doc);
        assert!(failures.is_empty(), "{}: {failures:#?}", m.name);
    }
}

#[test]
fn v1_harness_runs_are_deterministic() {
    let pick = [
        "t1-knob",
        "naming-d-coupler-plate",
        "naming-revolve-bead-partial",
    ];
    let subset: Vec<_> = models()
        .into_iter()
        .filter(|m| pick.contains(&m.name))
        .collect();
    assert_eq!(subset.len(), pick.len());
    let a = v1::render_v1(&v1::run_v1_models(&subset));
    let b = v1::render_v1(&v1::run_v1_models(&subset));
    assert_eq!(a, b);
}
