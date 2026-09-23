//! Property tests over the generated sketch families: solutions satisfy every constraint
//! (checked independently), drags keep them satisfied, diagnostics match the analytic
//! design intent, and results are bit-for-bit deterministic.

mod common;

use forge_solve::generate::{self, Generated, Intent, Rng};
use forge_solve::{
    Geometry, RankMethod, SolveOptions, SolveResult, SolveStatus, SolvedGeometry, Solver, solve,
};
use proptest::prelude::*;

fn family(seed: u64, pick: usize) -> Generated {
    let mut rng = Rng::new(seed ^ 0x5eed);
    match pick % 7 {
        0 => generate::rectangle(seed, rng.below(generate::RECT_VARIANTS)),
        1 => generate::slot(seed, rng.below(generate::SLOT_VARIANTS)),
        2 => generate::bolt_circle(seed, rng.below(generate::BOLT_VARIANTS)),
        3 => generate::rounded_rect(seed, rng.below(generate::ROUNDED_VARIANTS)),
        4 => generate::arc_chain(seed, rng.below(generate::ARC_CHAIN_VARIANTS)),
        5 => generate::polygon(seed, false),
        _ => generate::polygon(seed, true),
    }
}

fn solved(g: &Generated) -> (Solver, SolveResult) {
    let mut s =
        Solver::new(&g.sketch, &SolveOptions::default()).expect("generated sketches are valid");
    let r = s.solve();
    (s, r)
}

fn points(s: &forge_solve::Sketch) -> Vec<(String, [f64; 2])> {
    s.entities
        .iter()
        .filter_map(|e| match e.geometry {
            Geometry::Point { x, y } => Some((e.id.clone(), [x, y])),
            _ => None,
        })
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(160))]

    /// Every solved sketch satisfies every driving constraint to 1e-10 (solver residual)
    /// and to 1e-9 in natural units (independent checker); unsolved clusters keep their
    /// input geometry exactly.
    #[test]
    fn solutions_satisfy_constraints(seed in any::<u64>(), pick in 0usize..7) {
        let g = family(seed, pick);
        let (solver, r) = solved(&g);
        let out = solver.sketch();
        if r.ok {
            prop_assert!(r.max_residual <= 1e-10, "{}: residual {}", g.name, r.max_residual);
            let v = common::max_violation(&out, &g.sketch);
            prop_assert!(v <= 1e-9, "{}: independent violation {v}", g.name);
        } else {
            prop_assert!(matches!(r.status, SolveStatus::Conflict | SolveStatus::FailedToConverge));
            for c in r.clusters.iter().filter(|c| !c.status.is_solved()) {
                for id in &c.entities {
                    let a = g.sketch.entities.iter().find(|e| &e.id == id).expect("entity");
                    let b = out.entities.iter().find(|e| &e.id == id).expect("entity");
                    prop_assert_eq!(&a.geometry, &b.geometry, "unsolved cluster moved");
                }
            }
        }
        // Fixed entities never move.
        for e in g.sketch.entities.iter().filter(|e| e.fixed) {
            let o = out.entities.iter().find(|x| x.id == e.id).expect("entity");
            prop_assert_eq!(&e.geometry, &o.geometry);
        }
    }

    /// Consistent families: the status and DOF match the analytic design intent.
    #[test]
    fn diagnostics_match_design_intent(seed in any::<u64>(), pick in 0usize..5) {
        let g = family(seed, pick);
        let (_, r) = solved(&g);
        match g.intent {
            Intent::Under => prop_assert_eq!(r.status, SolveStatus::UnderConstrained, "{}", g.name),
            Intent::Fully => prop_assert_eq!(r.status, SolveStatus::FullyConstrained, "{}", g.name),
            Intent::Redundant => prop_assert_eq!(r.status, SolveStatus::OverConstrainedRedundant, "{}", g.name),
            Intent::Conflict => {
                prop_assert_eq!(r.status, SolveStatus::Conflict, "{}: {}", g.name, r.explanation);
                if let Some(expected) = &g.expected_conflict {
                    let mut a = r.conflicts[0].constraints.clone();
                    let mut b = expected.clone();
                    a.sort();
                    b.sort();
                    prop_assert_eq!(a, b, "{}", g.name);
                }
            }
        }
        if let (Some(dof), true) = (g.expected_dof, r.status != SolveStatus::Conflict) {
            prop_assert_eq!(r.dof, dof, "{}", g.name);
        }
        // An entity's DOF never exceeds the sketch's, and all vanish when fully constrained.
        prop_assert!(r.entities.iter().all(|e| e.dof <= r.dof));
        if r.status == SolveStatus::FullyConstrained {
            prop_assert!(r.entities.iter().all(|e| e.dof == 0));
        }
    }

    /// Dragging any movable point keeps every constraint satisfied; a rejected frame
    /// leaves the geometry untouched.
    #[test]
    fn drag_keeps_constraints_satisfied(seed in any::<u64>(), pick in 0usize..6, frames in 1usize..6) {
        let g = family(seed, pick);
        let (mut solver, r) = solved(&g);
        prop_assume!(r.ok);
        let movable: Vec<String> = r
            .entities
            .iter()
            .filter(|e| e.dof > 0 && matches!(e.geometry, SolvedGeometry::Point { .. }))
            .map(|e| e.id.clone())
            .collect();
        prop_assume!(!movable.is_empty());
        let mut rng = Rng::new(seed);
        let id = movable[rng.below(movable.len())].clone();
        for _ in 0..frames {
            let before = solver.sketch();
            let p = solver.point(&id).expect("point");
            let t = [p[0] + rng.range(-2.0, 2.0), p[1] + rng.range(-2.0, 2.0)];
            let f = solver.drag(&id, t).expect("movable point");
            let after = solver.sketch();
            if f.converged {
                prop_assert!(f.max_residual <= 1e-10);
                let v = common::max_violation(&after, &g.sketch);
                prop_assert!(v <= 1e-9, "{}: drag {id} violation {v}", g.name);
            } else {
                prop_assert_eq!(points(&before), points(&after));
            }
        }
    }

    /// Same input, same output bits; the QRCP and Jacobi-SVD rank backends agree.
    #[test]
    fn results_are_deterministic_and_backend_independent(seed in any::<u64>(), pick in 0usize..7) {
        let g = family(seed, pick);
        let a = serde_json::to_string(&solve(&g.sketch, &SolveOptions::default()).expect("valid")).expect("json");
        let b = serde_json::to_string(&solve(&g.sketch, &SolveOptions::default()).expect("valid")).expect("json");
        prop_assert_eq!(&a, &b);
        // The JSON boundary is deterministic too: the same request text gives the same
        // response text. (serde_json without its `float_roundtrip` feature may parse a
        // decimal 1 ULP away from the f64 that printed it, identically on every target,
        // so a print→parse round trip is not asserted to be bit-exact here.)
        let request = format!("{{\"sketch\":{}}}", serde_json::to_string(&g.sketch).expect("json"));
        prop_assert_eq!(forge_solve::solve_json(&request), forge_solve::solve_json(&request));
        let svd = SolveOptions { rank_method: RankMethod::Svd, ..SolveOptions::default() };
        let (q, s) = (solve(&g.sketch, &SolveOptions::default()).expect("valid"), solve(&g.sketch, &svd).expect("valid"));
        prop_assert_eq!(q.status, s.status);
        prop_assert_eq!(q.dof, s.dof);
        prop_assert_eq!(
            q.redundant.iter().map(|x| &x.constraint).collect::<Vec<_>>(),
            s.redundant.iter().map(|x| &x.constraint).collect::<Vec<_>>()
        );
    }

    /// A solved sketch is a fixed point: solving it again moves nothing.
    #[test]
    fn solved_geometry_is_a_fixed_point(seed in any::<u64>(), pick in 0usize..6) {
        let g = family(seed, pick);
        let (solver, r) = solved(&g);
        prop_assume!(r.ok);
        let once = solver.sketch();
        let mut again = Solver::new(&once, &SolveOptions::default()).expect("valid");
        let r2 = again.solve();
        prop_assert_eq!(r2.iterations, 0);
        prop_assert_eq!(points(&once), points(&again.sketch()));
        prop_assert_eq!(r.status, r2.status);
        prop_assert_eq!(r.dof, r2.dof);
    }
}

#[test]
fn every_generated_family_is_exercised_with_all_intents() {
    let corpus = generate::corpus(7, 400);
    for intent in [
        Intent::Under,
        Intent::Fully,
        Intent::Redundant,
        Intent::Conflict,
    ] {
        assert!(corpus.iter().any(|g| g.intent == intent), "{intent:?}");
    }
    for fam in [
        "rectangle",
        "slot",
        "bolt_circle",
        "rounded_rect",
        "arc_chain",
        "polygon",
    ] {
        assert!(corpus.iter().any(|g| g.family == fam), "{fam}");
    }
}
