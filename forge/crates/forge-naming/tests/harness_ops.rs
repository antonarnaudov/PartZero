//! The Phase C families of the naming harness v1 ([`forge_naming::harness::ops`]): references
//! across booleans, holes, fillets and patterns on IR v1 models, resolved by forge-regen itself
//! (each reference a `tag` feature), scored against a geometric ground truth. Gates: 0
//! SILENT_WRONG, every family ≥ 90 % correct (the plan's W4 boolean-family gate), every base
//! reference exact on its own model, deterministic runs; and each scripted mutation changes the
//! model the way the ground truth assumes.

use forge_ir::v1::metrics::Status;
use forge_naming::harness::Outcome;
use forge_naming::harness::ops::{self, Motion, ops_models, ops_mutations};
use forge_naming::harness::v1::{self, V1Family, V1Report};
use serde_json::Value;

fn run() -> V1Report {
    let mut rep = V1Report::default();
    rep.ops = ops::run_ops(&mut rep);
    rep
}

#[test]
fn phase_c_families_hold_with_no_silent_wrong() {
    let rep = run();
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
    assert_eq!(rep.captures_with_index, 0);
    assert_eq!(rep.auto_accept_violations, 0);
    assert!(rep.ops.skipped.is_empty(), "{:?}", rep.ops.skipped);
    assert_eq!(rep.ops.models, 3);
    let c = v1::criteria_v1(&rep);
    for (f, rate) in [
        (V1Family::Boolean, c.boolean),
        (V1Family::Hole, c.hole),
        (V1Family::Fillet, c.fillet),
        (V1Family::Pattern, c.pattern),
    ] {
        assert!(
            rep.mutations.get(&f).copied().unwrap_or(0) >= ops::min_family_mutations(f),
            "{f:?} mutations"
        );
        let scored = rep
            .refs
            .iter()
            .filter(|r| r.family == f && r.outcome != Outcome::Excluded)
            .count();
        assert!(
            scored >= ops::min_family_scored(f),
            "{f:?}: {scored} scored references"
        );
        assert!(rate >= 0.9, "{f:?}: {rate}");
    }
    assert!(c.go(), "{c:?}\n{}", v1::render_v1(&rep));
    // The interesting cases are exercised: a split (REF_SPLIT), removed entities (REF_MISSING),
    // pattern copies (`P/copy:…@i`, through `instance` queries) and hole faces by position.
    for code in ["REF_SPLIT", "REF_MISSING"] {
        assert!(
            rep.refs.iter().any(|r| r.code.as_deref() == Some(code)),
            "{code} exercised"
        );
    }
    assert!(
        rep.refs
            .iter()
            .filter(|r| r.family == V1Family::Pattern
                && r.key.contains("/copy:{")
                && r.outcome == Outcome::Correct)
            .count()
            >= 100,
        "pattern copies are scored"
    );
    assert!(
        rep.refs
            .iter()
            .any(|r| r.query.contains(r#""op":"hole_face""#))
    );
    // Family (l) scores references to the blends themselves (the fillet's faces and edges,
    // through authored `created`/`between` queries), not only to the plate around them.
    let blend = |mutation: &str| -> Vec<&v1::V1Record> {
        rep.refs
            .iter()
            .filter(|r| {
                r.family == V1Family::Fillet
                    && r.mutation == mutation
                    && r.key.contains("f_corners/")
                    && ops::is_blend_key(&r.key)
            })
            .collect()
    };
    let scored_blend = rep
        .refs
        .iter()
        .filter(|r| {
            r.family == V1Family::Fillet
                && r.outcome != Outcome::Excluded
                && r.key.contains("f_corners/")
        })
        .count();
    assert!(
        scored_blend >= ops::MIN_BLEND_SCORED,
        "{scored_blend} scored f_corners references"
    );
    assert_eq!(
        rep.ops.blend, 20,
        "4 blend faces and their 16 edges are referenced"
    );
    // A new radius: every blend entity is the same entity, scaled about its corner.
    let radius = blend("fillet_radius");
    assert_eq!(radius.len(), 20);
    assert!(
        radius
            .iter()
            .all(|r| r.outcome == Outcome::Correct && r.expected.starts_with("same")),
        "{radius:#?}"
    );
    // The fillet removed: every blend entity is gone, and every reference says so.
    let removed = blend("fillet_remove");
    assert_eq!(removed.len(), 20);
    assert!(removed.iter().all(|r| r.expected == "gone"
        && r.code.as_deref() == Some("REF_MISSING")
        && r.outcome == Outcome::FlaggedCorrectly));
    // A later blend consumes the arcs it runs through (top fillet, bottom chamfer) and only
    // trims the rest.
    for m in [
        "fillet_add_top",
        "chamfer_bottom_rim",
        "fillet_radius+chamfer_bottom_rim",
    ] {
        let rs = blend(m);
        assert_eq!(rs.len(), 20, "{m}");
        assert_eq!(
            rs.iter().filter(|r| r.expected == "gone").count(),
            4,
            "{m}: the four arcs on the blended rim"
        );
        assert!(
            rs.iter()
                .all(|r| matches!(r.outcome, Outcome::Correct | Outcome::FlaggedCorrectly)),
            "{m}: {rs:#?}"
        );
    }
    assert!(v1::coverage_problems(&rep).is_empty());
    // The dropped and broad counts are pinned at their maxima, like the unreferenced entities.
    assert_eq!(rep.ops.dropped, ops::MAX_DROPPED);
    assert_eq!(rep.ops.broad, ops::MAX_BROAD);
    // The entities left unscored (no synthesized query), pinned by name so a regression in
    // `synthesize_query` cannot shrink the evidence unnoticed: edges of pattern copies on the
    // rail model (a copy's own edges, and edges between a copy and another face).
    let unscored = [
        "f_row/copy:{f_boss/edge:{f_boss/cap:end@ring|f_boss/side:ring}}@1",
        "f_row/copy:{f_boss/edge:{f_boss/cap:end@ring|f_boss/side:ring}}@2",
        "f_row/copy:{f_boss/edge:{f_boss/cap:end@ring|f_boss/side:ring}}@3",
        "f_row/edge:{f_row/copy:{f_bore/wall@p}@1|f_row/copy:{f_boss/cap:end@ring}@1}",
        "f_row/edge:{f_row/copy:{f_bore/wall@p}@2|f_row/copy:{f_boss/cap:end@ring}@2}",
        "f_row/edge:{f_row/copy:{f_bore/wall@p}@3|f_row/copy:{f_boss/cap:end@ring}@3}",
        "f_ring/copy:{f_pocket/edge:{f_pocket/cap:end@pocket.bottom|f_pocket/side:pocket.bottom}}@2",
        "f_ring/copy:{f_pocket/edge:{f_pocket/cap:end@pocket.bottom|f_pocket/side:pocket.bottom}}@3",
        "f_ring/copy:{f_pocket/edge:{f_pocket/cap:end@pocket.bottom|f_pocket/side:pocket.top}}@2",
        "f_ring/copy:{f_pocket/edge:{f_pocket/cap:end@pocket.bottom|f_pocket/side:pocket.top}}@3",
        "f_ring/edge:{f_disc/cap:end@rim|f_ring/copy:{f_pocket/side:pocket.bottom}@3}",
        "f_ring/edge:{f_disc/cap:end@rim|f_ring/copy:{f_pocket/side:pocket.top}@2}",
    ]
    .map(|k| format!("ops-pattern-rail: {k}"));
    assert_eq!(rep.ops.unreferenced, unscored);
    assert_eq!(rep.ops.unreferenced.len(), ops::MAX_UNREFERENCED);
    assert!(v1::render_v1(&rep).contains(&format!("- `{}`", unscored[0])));
}

#[test]
fn the_gate_never_passes_vacuously() {
    let rep = run();
    assert!(v1::criteria_v1(&rep).go());
    // A skipped Phase C mutation is NO-GO.
    let mut skipped = rep.clone();
    skipped
        .ops
        .skipped
        .push("ops-hole-plate/x: rejected".into());
    assert!(!v1::criteria_v1(&skipped).go());
    assert_eq!(v1::coverage_problems(&skipped).len(), 1);
    // A family that scored nothing is NO-GO (its rate is NaN, not 100 %).
    let mut empty = rep.clone();
    empty.refs.retain(|r| r.family != V1Family::Fillet);
    let c = v1::criteria_v1(&empty);
    assert!(c.fillet.is_nan());
    assert!(!c.go());
    // Too few mutations in a family, or too few scored blend references, is NO-GO.
    let mut few = rep.clone();
    few.mutations.insert(V1Family::Pattern, 2);
    assert!(!v1::criteria_v1(&few).go());
    let mut no_blend = rep.clone();
    no_blend
        .refs
        .retain(|r| !(r.family == V1Family::Fillet && ops::is_blend_key(&r.key)));
    assert!(!v1::criteria_v1(&no_blend).go());
    assert!(
        v1::coverage_problems(&no_blend)
            .iter()
            .any(|p| p.contains("blend entities")),
        "{:?}",
        v1::coverage_problems(&no_blend)
    );
    // A large loss of scored references in one family is NO-GO (the floors sit near today's
    // coverage), and so is a query that no longer resolves to its own entity, or more picks
    // over broad sources (both leave the evidence unscored).
    let mut thin = rep.clone();
    let mut kept = 0;
    thin.refs.retain(|r| {
        if r.family != V1Family::Hole || r.outcome == Outcome::Excluded {
            return true;
        }
        kept += 1;
        kept < ops::min_family_scored(V1Family::Hole)
    });
    assert!(!v1::criteria_v1(&thin).go());
    assert!(
        v1::coverage_problems(&thin)
            .iter()
            .any(|p| p.starts_with("(k)") && p.contains("scored references (minimum")),
        "{:?}",
        v1::coverage_problems(&thin)
    );
    let mut dropped = rep.clone();
    dropped.ops.dropped = ops::MAX_DROPPED + 1;
    assert!(!v1::criteria_v1(&dropped).go());
    assert!(v1::coverage_problems(&dropped)[0].contains("did not resolve to their own entity"));
    let mut broad = rep.clone();
    broad.ops.broad = ops::MAX_BROAD + 1;
    assert!(!v1::criteria_v1(&broad).go());
    assert!(v1::coverage_problems(&broad)[0].contains("broad sources"));
    // More entities without a synthesized query than the pinned maximum is NO-GO.
    let mut unscored = rep.clone();
    unscored
        .ops
        .unreferenced
        .push("ops-hole-plate: f_x/side:y".into());
    assert!(!v1::criteria_v1(&unscored).go());
    assert!(
        v1::coverage_problems(&unscored)[0].contains("without a synthesized query"),
        "{:?}",
        v1::coverage_problems(&unscored)
    );
    // Without spike models (`--ops-only`) the spike gates do not apply; with some, an empty
    // gated spike family is a coverage problem.
    let mut spike = rep.clone();
    spike.models = 1;
    assert!(!v1::criteria_v1(&spike).go());
    assert!(
        v1::coverage_problems(&spike)
            .iter()
            .any(|p| p.contains("(a) dimension"))
    );
}

#[test]
fn phase_c_runs_are_deterministic() {
    // One model keeps the debug-build run short; every model goes through the same code.
    let models = &ops_models()[..1];
    let once = || {
        let mut rep = V1Report::default();
        rep.ops = ops::run_ops_models(models, &mut rep);
        v1::render_v1(&rep)
    };
    assert_eq!(once(), once());
}

fn evaluate(v: &Value) -> forge_regen::v1::Evaluation {
    let loaded = forge_regen::v1::load(&v.to_string()).expect("loads");
    forge_regen::v1::evaluate(&loaded.doc)
}

fn bodies(ev: &forge_regen::v1::Evaluation, part: usize) -> usize {
    ev.parts[part].bodies.len()
}

fn feature<'a>(
    ev: &'a forge_regen::v1::Evaluation,
    id: &str,
) -> Option<&'a forge_ir::v1::metrics::FeatureReport> {
    ev.features.iter().find(|f| f.feature_id == id)
}

#[test]
fn every_mutation_evaluates_cleanly_and_does_what_the_truth_assumes() {
    for model in ops_models() {
        let base: Value = serde_json::from_str(model.json).unwrap();
        let b = evaluate(&base);
        assert!(b.is_ok(), "{} base", model.name);
        for m in ops_mutations(model.name) {
            let ev = evaluate(&m.apply(&base));
            assert!(
                ev.is_ok(),
                "{} {}: {:?}",
                model.name,
                m.id,
                ev.features
                    .iter()
                    .filter(|f| f.status != Status::Ok)
                    .collect::<Vec<_>>()
            );
            let holes = |id: &str| feature(&ev, id).map_or(0, |f| f.holes.len());
            let instances = |id: &str| {
                feature(&ev, id)
                    .and_then(|f| f.pattern.as_ref())
                    .map_or(0, |p| p.instances)
            };
            match (model.name, m.id) {
                ("ops-hole-plate", "hole_add") => assert_eq!(holes("f_holes"), 4),
                ("ops-hole-plate", "hole_remove_position") => assert_eq!(holes("f_holes"), 2),
                ("ops-hole-plate", "hole_move") => {
                    assert!(
                        (feature(&ev, "f_holes").unwrap().holes[0].center[0] + 25.0).abs() < 1e-12
                    )
                }
                ("ops-hole-plate", "hole_resize") => {
                    assert!((feature(&ev, "f_holes").unwrap().holes[0].d - 7.0).abs() < 1e-12)
                }
                ("ops-hole-plate", "hole_cbore_to_csink") => {
                    assert!(feature(&ev, "f_screw").unwrap().holes[0].csink.is_some())
                }
                ("ops-hole-plate", "fillet_add_top") => {
                    assert!(feature(&ev, "f_top").unwrap().fillet.is_some())
                }
                ("ops-hole-plate", "fillet_remove") => assert!(feature(&ev, "f_corners").is_none()),
                ("ops-hole-plate", "chamfer_bottom_rim") => {
                    // The four bottom straight edges, and the corner blends' bottom arcs by
                    // tangent-chain expansion.
                    let c = feature(&ev, "f_rim").unwrap().chamfer.as_ref().unwrap();
                    assert_eq!(c.edges.len(), 8);
                    assert_eq!(c.chain_added.len(), 4);
                }
                ("ops-pattern-rail", "row_count_up") => assert_eq!(instances("f_row"), 4),
                ("ops-pattern-rail", "row_count_down") => assert_eq!(instances("f_row"), 2),
                ("ops-pattern-rail", "row_skip") => assert_eq!(instances("f_row"), 2),
                ("ops-pattern-rail", "ring_count_up") => assert_eq!(instances("f_ring"), 5),
                ("ops-boolean-block", "cut_splits_body") => {
                    assert_eq!(bodies(&ev, 0), 3, "the block splits in two")
                }
                ("ops-boolean-block", "join_merges_bodies") => {
                    assert_eq!(bodies(&ev, 0), 1, "the bridge merges both blocks")
                }
                ("ops-boolean-block", "cut_suppressed") => {
                    assert!(feature(&ev, "f_groove").is_none())
                }
                _ => {}
            }
        }
        assert_eq!(
            bodies(&b, 0),
            if model.name == "ops-boolean-block" {
                2
            } else {
                1
            }
        );
    }
}

#[test]
fn motions_follow_the_edits() {
    let muts = ops_mutations("ops-hole-plate");
    let mv = muts.iter().find(|m| m.id == "hole_move").unwrap();
    assert_eq!(
        mv.motion("f_holes/wall@a"),
        Motion::Translate([5.0, 0.0, 0.0])
    );
    assert_eq!(
        mv.motion("f_plate/edge:{f_holes/wall@a|f_plate/cap:end@outline.bottom}"),
        Motion::Translate([5.0, 0.0, 0.0])
    );
    assert_eq!(mv.motion("f_holes/wall@b"), Motion::Same);
    let rs = muts.iter().find(|m| m.id == "hole_resize").unwrap();
    assert!(matches!(
        rs.motion("f_holes/wall@c"),
        Motion::Radial {
            from: 3.0,
            to: 3.5,
            ..
        }
    ));
    // A new fillet radius scales each corner's blend entities about the sharp edge it replaced.
    let fr = muts.iter().find(|m| m.id == "fillet_radius").unwrap();
    let corner = |x: f64, y: f64| Motion::Radial {
        origin: [x, y, 0.0],
        dir: [0.0, 0.0, 1.0],
        from: 5.0,
        to: 8.0,
    };
    assert_eq!(fr.motion("f_corners/blend:{f_plate/edge:{f_plate/side:outline.bottom|f_plate/side:outline.left}@outline.bottom.start}"), corner(-50.0, -30.0));
    assert_eq!(
        fr.motion("f_corners/edge:{f_corners/blend:{f_plate/edge:{f_plate/side:outline.right|f_plate/side:outline.top}@outline.right.end}|f_plate/cap:end@outline.bottom}"),
        corner(50.0, 30.0)
    );
    assert_eq!(
        fr.motion("f_corners/edge:{f_corners/blend:{f_plate/edge:{f_plate/side:outline.bottom|f_plate/side:outline.right}@outline.bottom.end}|f_plate/side:outline.right}"),
        corner(50.0, -30.0)
    );
    assert_eq!(fr.motion("f_plate/side:outline.right"), Motion::Same);
    // The sequence composes the radius change with the later chamfer.
    let sq = muts
        .iter()
        .find(|m| m.id == "fillet_radius+chamfer_bottom_rim")
        .unwrap();
    assert_eq!(sq.motion("f_corners/blend:{f_plate/edge:{f_plate/side:outline.left|f_plate/side:outline.top}@outline.left.start}"), corner(-50.0, 30.0));
    let rail = ops_mutations("ops-pattern-rail");
    let sp = rail.iter().find(|m| m.id == "row_spacing").unwrap();
    assert_eq!(
        sp.motion("f_row/copy:{f_boss/side:ring}@3"),
        Motion::Translate([6.0, 0.0, 0.0])
    );
    assert_eq!(sp.motion("f_boss/side:ring"), Motion::Same);
    let block = ops_mutations("ops-boolean-block");
    let deeper = block.iter().find(|m| m.id == "cut_deeper").unwrap();
    assert_eq!(
        deeper.motion("f_groove/cap:end@groove.bottom"),
        Motion::Translate([0.0, 0.0, -2.0])
    );
    assert_eq!(
        deeper.motion("f_groove/edge:{f_block/cap:end@body.bottom|f_groove/side:groove.left}"),
        Motion::Same
    );
}
