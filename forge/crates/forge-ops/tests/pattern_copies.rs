//! Moved and mirrored copies of bodies (SPEC §6.10 instances): every copy is a valid body
//! whose exact mass properties are the moved ones (volume and area unchanged, centroid
//! moved), over the boolean corpus's operands (extrudes of lines, arcs and circles; revolves
//! to planes, cylinders, cones, spheres and tori) and boolean results (B-spline section
//! edges and pcurves), and copies are keyed `P/copy:{K}@i`.

// Exact comparisons on purpose: golden values and exact placements.
#![allow(clippy::float_cmp)]

use forge_core::linalg::{Transform, Vec3};
use forge_core::topo::{Body, KeyRoleArg, Severity, parse_key};
use forge_ir::v1::metrics::Origin;
use forge_ops::boolean::corpus::cases;
use forge_ops::boolean::{OpBody, apply_body_op};
use forge_ops::pattern::{Motion, copy_body, move_body, seed_keys};
use proptest::prelude::*;

struct Mass {
    volume: f64,
    area: f64,
    centroid: Vec3,
}

fn mass(b: &Body) -> Mass {
    let issues = forge_check::validate(b);
    assert!(
        issues.iter().all(|i| i.severity != Severity::Error),
        "invalid copy: {issues:?}"
    );
    let m = forge_check::mass_properties(b).expect("mass");
    Mass {
        volume: m.volume,
        area: m.area,
        centroid: Vec3::from(m.centroid),
    }
}

fn motions() -> Vec<(&'static str, Motion)> {
    vec![
        (
            "mirror-yz",
            Motion::reflection(Vec3::new(1.5, 0.0, 0.0), Vec3::unit_x()).expect("plane"),
        ),
        (
            "mirror-oblique",
            Motion::reflection(Vec3::new(0.3, -0.7, 1.1), Vec3::new(1.0, -2.0, 0.7))
                .expect("plane"),
        ),
        (
            "rotate",
            Motion::Rigid(
                Transform::rotation_about_axis_deg(
                    Vec3::new(1.0, 2.0, 0.0),
                    Vec3::new(0.2, 0.3, 1.0),
                    37.0,
                )
                .expect("axis"),
            ),
        ),
        (
            "translate",
            Motion::Rigid(Transform::translation(Vec3::new(12.5, -3.0, 0.25))),
        ),
    ]
}

fn check_copy(what: &str, b: &Body, m: &Motion) {
    let before = mass(b);
    let copy = move_body(b, m, |_, p| p.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
    let after = mass(&copy);
    let s = before.volume.abs().cbrt().max(1.0);
    assert!(
        (after.volume - before.volume).abs() <= 1e-9 * before.volume.abs().max(1.0),
        "{what}: volume {} → {}",
        before.volume,
        after.volume
    );
    assert!(
        (after.area - before.area).abs() <= 1e-9 * before.area.max(1.0),
        "{what}: area {} → {}",
        before.area,
        after.area
    );
    let want = m.point(before.centroid);
    assert!(
        after.centroid.distance(want) <= 1e-9 * s.max(want.norm()),
        "{what}: centroid {:?} vs {:?}",
        after.centroid,
        want
    );
    let (fb, fa) = (
        forge_check::body_metrics(b).expect("m"),
        forge_check::body_metrics(&copy).expect("m"),
    );
    assert_eq!(
        (fb.faces, fb.edges, fb.face_types, fb.edge_types),
        (fa.faces, fa.edges, fa.face_types, fa.edge_types),
        "{what}: topology"
    );
}

#[test]
fn copies_of_corpus_operands_keep_their_mass_properties() {
    let mut n = 0;
    for c in cases(23, 48) {
        for (side, op) in [("a", &c.a), ("b", &c.b)] {
            let Ok(b) = op.build() else { continue };
            for (name, m) in motions() {
                check_copy(&format!("case {} {} {side} {name}", c.id, c.family), &b, &m);
                n += 1;
            }
        }
    }
    assert!(n >= 300, "{n} copies");
}

#[test]
fn copies_of_boolean_results_keep_their_mass_properties() {
    let ob = |body: Body, f: &str| OpBody {
        body,
        origin: Origin {
            feature: f.into(),
            member: "m".into(),
            instance: None,
        },
        timeline: 0,
    };
    let mut n = 0;
    for c in cases(29, 36) {
        let (Ok(a), Ok(b)) = (c.a.build(), c.b.build()) else {
            continue;
        };
        let Ok(res) = apply_body_op(c.op, &[ob(a, "a")], &[ob(b, "b")], "g") else {
            continue;
        };
        for rb in &res.bodies {
            for (name, m) in motions().into_iter().take(2) {
                check_copy(
                    &format!("result of case {} {} {name}", c.id, c.family),
                    &rb.body,
                    &m,
                );
                n += 1;
            }
        }
    }
    assert!(n >= 20, "{n} copies");
}

#[test]
fn mirroring_twice_restores_the_geometry() {
    let m =
        Motion::reflection(Vec3::new(0.3, -0.7, 1.1), Vec3::new(1.0, -2.0, 0.7)).expect("plane");
    for c in cases(31, 12) {
        let Ok(b) = c.a.build() else { continue };
        let twice = move_body(
            &move_body(&b, &m, |_, p| p.clone()).expect("1"),
            &m,
            |_, p| p.clone(),
        )
        .expect("2");
        let (x, y) = (mass(&b), mass(&twice));
        assert!((x.volume - y.volume).abs() <= 1e-9 * x.volume.abs().max(1.0));
        assert!(x.centroid.distance(y.centroid) <= 1e-9 * x.centroid.norm().max(1.0));
        let (bx, by) = (
            forge_check::bbox(&b).expect("b"),
            forge_check::bbox(&twice).expect("b"),
        );
        for k in 0..3 {
            assert!((bx.0[k] - by.0[k]).abs() < 1e-9 && (bx.1[k] - by.1[k]).abs() < 1e-9);
        }
    }
}

#[test]
fn copies_are_keyed_as_copies_of_the_seed_entities() {
    let c = &cases(5, 1)[0];
    let b = c.a.build().expect("a");
    let origin = Origin {
        feature: c.a.feature.clone(),
        member: "m".into(),
        instance: None,
    };
    let keys = seed_keys(&b, &origin);
    let m = Motion::reflection(Vec3::zero(), Vec3::unit_y()).expect("plane");
    let copy = copy_body(&b, &keys, &m, "pt1", "1").expect("copy");
    let mut seed: Vec<String> = keys.faces.values().cloned().collect();
    seed.sort();
    let mut inner: Vec<String> = Vec::new();
    for (_, f) in copy.faces().iter() {
        let key = f.provenance.key();
        let p = parse_key(&key).expect("key");
        assert_eq!(
            (p.feature.as_str(), p.label.as_str(), p.qualifier.as_deref()),
            ("pt1", "copy", Some("1"))
        );
        // SPEC §5.2 `P/copy:{K}@q`: the seed key verbatim in braces.
        let KeyRoleArg::Keys(ks) = p.arg else {
            panic!("{key}: nested key expected")
        };
        let [k] = ks.as_slice() else {
            panic!("{key}: one seed key expected")
        };
        assert_eq!(key, format!("pt1/copy:{{{k}}}@1"));
        inner.push(k.clone());
    }
    inner.sort();
    assert_eq!(inner, seed, "every face names its seed face's key");
    // Seed caps carry the body member (§5.2 rule 4), and the copy's key is exactly the
    // SPEC string.
    assert!(seed.iter().any(|k| k.contains("/cap:end@m")), "{seed:?}");
    let cap = format!("pt1/copy:{{{}/cap:end@m}}@1", c.a.feature);
    assert!(
        copy.faces().iter().any(|(_, f)| f.provenance.key() == cap),
        "{cap} missing"
    );
    // Edges and vertices too, and the copy passes validation (no malformed provenance).
    assert!(
        copy.edges()
            .iter()
            .all(|(_, e)| e.provenance.key().starts_with("pt1/copy:{"))
    );
    mass(&copy);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

    /// Any rigid motion or reflection preserves volume and area and moves the centroid.
    #[test]
    fn random_motions_preserve_mass_properties(
        k in 0usize..40,
        ox in -5.0f64..5.0, oy in -5.0f64..5.0, oz in -5.0f64..5.0,
        nx in -1.0f64..1.0, ny in -1.0f64..1.0, nz in 0.1f64..1.0,
        deg in -360.0f64..360.0,
        mirror in any::<bool>(),
    ) {
        let c = &cases(41, 40)[k];
        let Ok(b) = c.a.build() else { return Ok(()); };
        let o = Vec3::new(ox, oy, oz);
        let n = Vec3::new(nx, ny, nz);
        let m = if mirror {
            Motion::reflection(o, n).expect("plane")
        } else {
            Motion::Rigid(Transform::rotation_about_axis_deg(o, n, deg).expect("axis"))
        };
        check_copy(&format!("case {} {}", c.id, c.family), &b, &m);
    }
}
