//! Properties of `migrate_v0_to_v1` (SPEC-v1 §9.1) on random v0 documents, including ids and
//! names outside the v1 id grammar ([W0-12]).

use forge_ir::v1;
use proptest::prelude::*;

/// Ids: mostly valid, some with provenance-reserved characters, spaces, unicode, digits first,
/// empty, over-long, or colliding after sanitizing.
fn id() -> impl Strategy<Value = String> {
    prop_oneof![
        6 => "[a-z][a-z0-9_]{0,6}",
        1 => Just(String::new()),
        1 => "[0-9][a-z]{0,3}",
        1 => "[a-z]{1,3}[-/:{}|+#@% .][a-z]{1,3}",
        1 => "[a-zé]{1,4}",
        1 => "x{60,70}",
        1 => Just("a_b".to_string()),
        1 => Just("a-b".to_string()),
    ]
}

fn name() -> impl Strategy<Value = String> {
    prop_oneof![5 => "[a-z][a-zA-Z0-9_]{0,8}", 1 => "n{60,70}"]
}

fn circle() -> impl Strategy<Value = forge_ir::SketchCurve> {
    (id(), -50.0..50.0f64, -50.0..50.0f64, 0.5..20.0f64).prop_map(|(id, x, y, r)| {
        forge_ir::SketchCurve::Circle {
            id,
            center: [x, y],
            radius: r,
        }
    })
}

fn part() -> impl Strategy<Value = forge_ir::PartStudio> {
    (
        id(),
        prop_oneof![3 => "[a-z]{1,6}", 1 => "[A-Z][a-z]{1,4} [A-Z][a-z]{1,4}"],
        prop::collection::vec(
            (
                id(),
                name(),
                prop::collection::vec(circle(), 1..4),
                0.1..30.0f64,
            ),
            1..4,
        ),
    )
        .prop_map(|(pid, pname, sketches)| {
            let mut features = Vec::new();
            for (k, (sid, sname, curves, dist)) in sketches.into_iter().enumerate() {
                features.push(forge_ir::Feature::Sketch(forge_ir::SketchFeature {
                    id: sid,
                    name: sname.clone(),
                    suppressed: false,
                    plane: forge_ir::PlaneSpec::Named(forge_ir::NamedPlane::XY),
                    curves,
                }));
                features.push(forge_ir::Feature::Extrude(forge_ir::ExtrudeFeature {
                    id: format!("e{k}"),
                    name: format!("x{k}"),
                    suppressed: false,
                    sketch: sname,
                    regions: forge_ir::RegionSelection::All,
                    distance: dist,
                    direction: forge_ir::SweepDirection::Normal,
                    op: forge_ir::BodyOp::NewBody,
                }));
            }
            forge_ir::PartStudio {
                id: pid,
                name: pname,
                features,
            }
        })
}

fn document() -> impl Strategy<Value = forge_ir::Document> {
    prop::collection::vec(part(), 1..3).prop_map(|parts| forge_ir::Document {
        schema: forge_ir::IR_SCHEMA.to_string(),
        meta: forge_ir::Meta::default(),
        units: forge_ir::Units::default(),
        parts,
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    #[test]
    fn migration_is_deterministic_idempotent_and_leaves_only_valid_ids(d in document()) {
        let (m, report) = v1::migrate_v0_to_v1_report(&d);
        let (m2, report2) = v1::migrate_v0_to_v1_report(&d);
        prop_assert_eq!(&m, &m2);
        prop_assert_eq!(&report, &report2);
        prop_assert_eq!(m.schema.as_str(), v1::IR_SCHEMA);
        // Idempotence: a v1 document is returned unchanged by the dispatch.
        prop_assert_eq!(forge_ir::VersionedDocument::V1(m.clone()).into_v1(), m.clone());
        // Every id and name now matches the grammar.
        for p in &m.parts {
            prop_assert!(v1::ids::is_id(&p.id) && v1::ids::is_id(&p.name));
            for f in &p.features {
                prop_assert!(v1::ids::is_id(f.id()) && v1::ids::is_id(f.name()));
                if let v1::Feature::Sketch(s) = f {
                    for c in &s.curves {
                        prop_assert!(v1::ids::is_id(c.id()));
                    }
                }
            }
        }
        // Renames touch invalid ids only, and valid ones keep their value.
        for r in &report.renames {
            prop_assert!(!v1::ids::is_id(&r.from));
            prop_assert!(v1::ids::is_id(&r.to));
        }
        // Canonical text round-trips exactly (typed parse; the random document may be invalid).
        let text = v1::to_json(&m);
        let back: v1::Document = v1::json::from_str(&text).unwrap();
        prop_assert_eq!(&back, &m);
        prop_assert_eq!(v1::to_json(&back), text);
        // Without rewrites, the compatibility path is the exact inverse.
        if report.renames.is_empty() {
            prop_assert_eq!(v1::downgrade_to_v0(&m).unwrap(), d.clone());
        }
        // Each extrude names the sketch just before it (the latest earlier sketch with that
        // name), by its possibly rewritten id.
        for p in &m.parts {
            for (k, f) in p.features.iter().enumerate() {
                if let v1::Feature::Extrude(e) = f {
                    let v1::Feature::Sketch(s) = &p.features[k - 1] else { unreachable!() };
                    prop_assert_eq!(&e.sketch, &s.id);
                }
            }
        }
    }
}
