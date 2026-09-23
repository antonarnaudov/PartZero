//! Property tests over the generated sketch families: solutions satisfy every constraint
//! (checked independently), drags keep them satisfied, diagnostics match the analytic
//! design intent, and results are bit-for-bit deterministic.

mod common;

use forge_solve::generate::{self, Generated, Intent, Rng};
use forge_solve::{
    ClusterReport, Geometry, RankMethod, SolveOptions, SolveResult, SolveStatus, SolvedGeometry,
    Solver, solve,
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

/// `true` when the rank decision of cluster `c` is robust: it converged (its DOF and
/// redundancy were analysed at a solution, not at a least-squares point of a failed solve)
/// and is not `near_degenerate` (its rank decision was not within three decades of the rank
/// tolerance). Only then must the QRCP and Jacobi-SVD backends agree on its DOF and
/// redundancy: for a failed or near-degenerate cluster the two factorizations may
/// legitimately draw the rank line on different sides of a borderline pivot / singular value
/// (e.g. `polygon/c/1455554950525772012/k4`: a `failed_to_converge` cluster with conditioning
/// 2e-8, where QRCP keeps rank 6 (DOF 2) and SVD rank 5 (DOF 3)).
fn cluster_is_robust(c: &ClusterReport) -> bool {
    c.status.is_solved() && !c.near_degenerate
}

/// `true` when every cluster of `r` is robust ([`cluster_is_robust`]).
fn rank_decisions_are_robust(r: &SolveResult) -> bool {
    r.clusters.iter().all(cluster_is_robust)
}

/// The redundant constraints of `r` that belong to cluster `c`, in `r`'s order.
fn redundant_in<'a>(r: &'a SolveResult, c: &ClusterReport) -> Vec<&'a String> {
    r.redundant
        .iter()
        .map(|x| &x.constraint)
        .filter(|id| c.constraints.contains(id))
        .collect()
}

/// Same input, same output bits (solve and the JSON boundary); the QRCP and Jacobi-SVD
/// rank backends decompose identically and agree, **cluster by cluster**, on the status, DOF,
/// rank and redundancy of every cluster that is robust in both ([`cluster_is_robust`]) —
/// including the solved clusters of a sketch whose other clusters conflict or fail — and on
/// the overall status, DOF and redundancy when every cluster is robust.
fn check_deterministic_and_backend_independent(g: &Generated) -> Result<(), TestCaseError> {
    let a = serde_json::to_string(&solve(&g.sketch, &SolveOptions::default()).expect("valid"))
        .expect("json");
    let b = serde_json::to_string(&solve(&g.sketch, &SolveOptions::default()).expect("valid"))
        .expect("json");
    prop_assert_eq!(&a, &b);
    // The JSON boundary is deterministic too: the same request text gives the same
    // response text. (serde_json without its `float_roundtrip` feature may parse a
    // decimal 1 ULP away from the f64 that printed it, identically on every target,
    // so a print→parse round trip is not asserted to be bit-exact here.)
    let request = format!(
        "{{\"sketch\":{}}}",
        serde_json::to_string(&g.sketch).expect("json")
    );
    prop_assert_eq!(
        forge_solve::solve_json(&request),
        forge_solve::solve_json(&request)
    );
    let svd = SolveOptions {
        rank_method: RankMethod::Svd,
        ..SolveOptions::default()
    };
    let (q, s) = (
        solve(&g.sketch, &SolveOptions::default()).expect("valid"),
        solve(&g.sketch, &svd).expect("valid"),
    );
    // Decomposition does not depend on the backend.
    prop_assert_eq!(q.clusters.len(), s.clusters.len(), "{}", g.name);
    for (cq, cs) in q.clusters.iter().zip(&s.clusters) {
        prop_assert_eq!(cq.index, cs.index, "{}", g.name);
        prop_assert_eq!(&cq.entities, &cs.entities, "{}", g.name);
        prop_assert_eq!(&cq.constraints, &cs.constraints, "{}", g.name);
        prop_assert_eq!(cq.unknowns, cs.unknowns, "{}", g.name);
        prop_assert_eq!(cq.equations, cs.equations, "{}", g.name);
        if cluster_is_robust(cq) && cluster_is_robust(cs) {
            let at = format!("{} cluster {}", g.name, cq.index);
            prop_assert_eq!(cq.status, cs.status, "{}", at);
            prop_assert_eq!(cq.dof, cs.dof, "{}", at);
            prop_assert_eq!(cq.rank, cs.rank, "{}", at);
            prop_assert_eq!(redundant_in(&q, cq), redundant_in(&s, cs), "{}", at);
        }
    }
    let any_near_degenerate = q
        .clusters
        .iter()
        .chain(&s.clusters)
        .any(|c| c.near_degenerate);
    if !any_near_degenerate {
        // No borderline rank decision: the status (which for a solved cluster is decided
        // by its DOF and redundancy) must agree.
        prop_assert_eq!(q.status, s.status, "{}", g.name);
    }
    if rank_decisions_are_robust(&q) && rank_decisions_are_robust(&s) {
        prop_assert_eq!(q.dof, s.dof, "{}", g.name);
        prop_assert_eq!(
            q.redundant
                .iter()
                .map(|x| &x.constraint)
                .collect::<Vec<_>>(),
            s.redundant
                .iter()
                .map(|x| &x.constraint)
                .collect::<Vec<_>>(),
            "{}",
            g.name
        );
    }
    Ok(())
}

/// Unsolved clusters keep their input geometry. An entity's quantities can belong to several
/// clusters (a point whose `y` is tied to a conflicting cluster by a `horizontal` while its
/// `x` sits in a solved one), and `ClusterReport::entities` lists it under each; so the check
/// goes quantity by quantity ([`Solver::quantity_clusters`]): every coordinate (point `x`,
/// `y`; circle radius) of an entity of an unsolved cluster that no *solved* cluster owns must
/// be bit-for-bit unchanged.
fn check_unsolved_clusters_keep_their_geometry(
    g: &Generated,
    solver: &Solver,
    r: &SolveResult,
    out: &forge_solve::Sketch,
) -> Result<(), TestCaseError> {
    let owned_by_solved = |c: Option<usize>| {
        c.is_some_and(|i| {
            r.clusters
                .iter()
                .find(|x| x.index == i)
                .is_some_and(|x| x.status.is_solved())
        })
    };
    for c in r.clusters.iter().filter(|c| !c.status.is_solved()) {
        for id in &c.entities {
            let a = &g
                .sketch
                .entities
                .iter()
                .find(|e| &e.id == id)
                .expect("entity")
                .geometry;
            let b = &out
                .entities
                .iter()
                .find(|e| &e.id == id)
                .expect("entity")
                .geometry;
            let owners = solver.quantity_clusters(id).expect("entity");
            let keep = |k: usize, x: f64, y: f64| -> Result<(), TestCaseError> {
                if !owned_by_solved(owners[k]) {
                    prop_assert_eq!(
                        x.to_bits(),
                        y.to_bits(),
                        "{}: unsolved cluster moved {} (quantity {})",
                        g.name,
                        id,
                        k
                    );
                }
                Ok(())
            };
            match (a, b) {
                (Geometry::Point { x: x0, y: y0 }, Geometry::Point { x, y }) => {
                    keep(0, *x0, *x)?;
                    keep(1, *y0, *y)?;
                }
                (Geometry::Circle { radius: r0, .. }, Geometry::Circle { radius, .. }) => {
                    keep(0, *r0, *radius)?;
                }
                (a, b) => prop_assert_eq!(a, b, "{}: {}", g.name, id),
            }
        }
    }
    Ok(())
}

/// Dragging a movable point keeps every constraint satisfied; a rejected frame leaves the
/// geometry untouched.
fn check_drag(seed: u64, pick: usize, frames: usize) -> Result<(), TestCaseError> {
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
    for frame in 0..frames {
        let before = solver.sketch();
        let p = solver.point(&id).expect("point");
        let t = [p[0] + rng.range(-2.0, 2.0), p[1] + rng.range(-2.0, 2.0)];
        let f = solver.drag(&id, t).expect("movable point");
        let after = solver.sketch();
        if f.converged {
            prop_assert!(f.max_residual <= 1e-10);
            let v = common::max_violation(&after, &g.sketch);
            prop_assert!(
                v <= 1e-9,
                "{}: drag {} frame {}: violation {}",
                g.name,
                id,
                frame,
                v
            );
        } else {
            prop_assert_eq!(points(&before), points(&after));
        }
    }
    Ok(())
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
            check_unsolved_clusters_keep_their_geometry(&g, &solver, &r, &out)?;
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
        check_drag(seed, pick, frames)?;
    }

    /// Same input, same output bits; the QRCP and Jacobi-SVD rank backends agree wherever
    /// the rank decisions are robust (see [`check_deterministic_and_backend_independent`]).
    #[test]
    fn results_are_deterministic_and_backend_independent(seed in any::<u64>(), pick in 0usize..7) {
        check_deterministic_and_backend_independent(&family(seed, pick))?;
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

/// Pinned regression of `results_are_deterministic_and_backend_independent` (it was flaky
/// on this input): `seed = 1455554950525772012, pick = 6` generates
/// `polygon/c/1455554950525772012/k4`, whose single cluster fails to converge with a
/// near-degenerate rank decision (conditioning 2e-8): QRCP reports DOF 2, Jacobi SVD 3.
/// Both are legitimate readings of a borderline Jacobian at a least-squares point, so the
/// backends are compared on DOF and redundancy only where rank decisions are robust.
#[test]
fn backends_may_disagree_on_dof_only_for_failed_near_degenerate_clusters() {
    let g = family(1_455_554_950_525_772_012, 6);
    assert_eq!(g.name, "polygon/c/1455554950525772012/k4");
    let q = solve(&g.sketch, &SolveOptions::default()).expect("valid");
    let svd = SolveOptions {
        rank_method: RankMethod::Svd,
        ..SolveOptions::default()
    };
    let s = solve(&g.sketch, &svd).expect("valid");
    // The pinned situation: a failed, near-degenerate cluster in both backends, which then
    // agree on the status but not on the DOF.
    for r in [&q, &s] {
        assert_eq!(r.status, SolveStatus::FailedToConverge);
        assert!(!rank_decisions_are_robust(r));
        assert!(r.clusters.iter().all(|c| c.near_degenerate));
    }
    // The property holds on it (and never compares the non-robust DOF).
    check_deterministic_and_backend_independent(&g).expect("property holds");
}

/// Pinned regression of `solutions_satisfy_constraints` (it was flaky on this input):
/// `seed = 6121581300860278226, pick = 6` (`polygon/c/6121581300860278226/k6`) has a
/// conflicting cluster and a solved one sharing point `p1` (its `y` in the first, its `x` in
/// the second); the solved cluster legitimately moves `p1.x`.
#[test]
fn a_point_shared_by_a_solved_and_a_conflicting_cluster_may_move_in_the_solved_one() {
    let g = family(6_121_581_300_860_278_226, 6);
    assert_eq!(g.name, "polygon/c/6121581300860278226/k6");
    let (solver, r) = solved(&g);
    assert_eq!(r.status, SolveStatus::Conflict);
    let shared = |id: &str| {
        r.clusters
            .iter()
            .filter(|c| c.entities.iter().any(|e| e == id))
            .count()
    };
    assert_eq!(shared("p1"), 2);
    check_unsolved_clusters_keep_their_geometry(&g, &solver, &r, &solver.sketch())
        .expect("property holds");
    // Quantity by quantity: p1's y is the conflicting cluster's (kept), its x the solved one's.
    let owners = solver.quantity_clusters("p1").expect("p1");
    let status = |c: Option<usize>| c.map(|i| r.clusters[i].status);
    assert!(
        owners
            .iter()
            .any(|&c| status(c) == Some(SolveStatus::Conflict))
    );
    assert!(
        owners
            .iter()
            .any(|&c| status(c).is_some_and(|s| s.is_solved()))
    );
}

/// Investigation aid for `drag_keeps_constraints_satisfied` (it failed once in 13 runs of 160
/// cases without a persisted seed): the same property over a large deterministic sample.
#[test]
#[ignore = "slow: cargo test -p forge-solve --test properties -- --ignored drag_sweep"]
fn drag_sweep() {
    let mut rng = Rng::new(0xd7a6);
    let n: usize = std::env::var("DRAG_SWEEP_CASES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20_000);
    let mut failures = Vec::new();
    let mut rejected = [0usize; 6];
    let mut drawn = [0usize; 6];
    for _ in 0..n {
        let seed = rng.next_u64();
        let (pick, frames) = (rng.below(6), 1 + rng.below(5));
        drawn[pick] += 1;
        match check_drag(seed, pick, frames) {
            Ok(()) => {}
            Err(TestCaseError::Reject(_)) => rejected[pick] += 1,
            Err(e) => failures.push(format!("seed={seed} pick={pick} frames={frames}: {e}")),
        }
    }
    eprintln!("drag sweep: {n} cases, rejected per family {rejected:?} of {drawn:?}");
    for f in &failures {
        eprintln!("{f}");
    }
    assert!(failures.is_empty(), "{} failures", failures.len());
}

/// [`Solver::quantity_clusters`]: a point's `[x, y]`, a circle's `[radius]`, nothing for a
/// line; `None` for fixed quantities and unknown ids.
#[test]
fn quantity_clusters_split_entities_by_quantity() {
    use forge_solve::{Constraint, Entity, Sketch, c};
    let sketch = Sketch {
        entities: vec![
            Entity::point("a", 0.0, 0.0).fixed(),
            Entity::point("b", 9.0, 1.0),
            Entity::line("ab", "a", "b"),
            Entity::point("m", 20.0, 0.0),
            Entity::circle("k", "m", 3.0),
        ],
        constraints: vec![
            Constraint::new("h", c::horizontal("ab")),
            Constraint::new("r", c::radius("k", 4.0)),
        ],
    };
    let mut solver = Solver::new(&sketch, &SolveOptions::default()).expect("valid");
    let r = solver.solve();
    assert!(r.ok);
    let owner = |id: &str| solver.quantity_clusters(id).expect("entity");
    assert_eq!(owner("a"), [None, None], "fixed");
    let b = owner("b");
    assert_eq!(b[0], None, "b.x: no equation touches it");
    let hb = b[1].expect("b.y is in the horizontal's cluster");
    assert!(r.clusters[hb].constraints.contains(&"h".to_string()));
    assert_eq!(owner("ab"), Vec::<Option<usize>>::new());
    let k = owner("k");
    assert_eq!(k.len(), 1);
    assert!(
        r.clusters[k[0].expect("radius")]
            .constraints
            .contains(&"r".to_string())
    );
    // A curve equation's quantities include its centre: same cluster as the radius.
    assert_eq!(owner("m"), [k[0], k[0]]);
    assert_eq!(solver.quantity_clusters("nope"), None);
}
