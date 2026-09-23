//! Exact per-entity geometry (fingerprint sizes, centroids, boxes: SPEC-v1 §5.3, §5.6) and
//! probes (§7.6), with closed-form cases, agreement with forge-check's body metrics, and
//! property tests over random plates.
// Expected values are exact on purpose (closed forms, bit-exact frames).
#![allow(clippy::float_cmp)]

mod common;

use common::{Model, d_shape, doc, e1, eval, half_cone, l_shape, plate, r, stadium};
use forge_core::math;
use forge_core::topo::{EdgeId, FaceId};
use forge_ir::v1::metrics::RefStatus;
use forge_ir::v1::{EntityKind, LINEAR_TOLERANCE, Ref};
use forge_refs::exact::{edge_props, face_props, point_on_edge, point_on_face};
use forge_refs::probe::{FACE_PROBE_MARGIN, distance_to_edge};
use forge_refs::{EntityId, Scope, capture, resolve, synthesize_query};
use proptest::prelude::*;
use serde_json::json;

fn models() -> Vec<(&'static str, Model)> {
    vec![
        ("plate", plate()),
        ("d", d_shape()),
        ("cone", half_cone()),
        ("l", l_shape()),
        ("stadium", stadium()),
    ]
}

#[test]
fn face_areas_sum_to_the_body_area_and_boxes_to_the_body_box() {
    for (name, m) in models() {
        for (body, _) in &m.bodies {
            let mp = forge_check::mass_properties(body).expect("mass");
            let (bmin, bmax) = forge_check::bbox(body).expect("bbox");
            let mut area = 0.0;
            let mut lo = [f64::INFINITY; 3];
            let mut hi = [f64::NEG_INFINITY; 3];
            for (fid, _) in body.faces().iter() {
                let p = face_props(body, fid).expect("face props");
                area += p.area;
                for i in 0..3 {
                    lo[i] = lo[i].min(p.bbox.min[i]);
                    hi[i] = hi[i].max(p.bbox.max[i]);
                }
            }
            assert!(
                (area - mp.area).abs() <= 1e-12 * mp.area,
                "{name}: {area} vs {}",
                mp.area
            );
            assert_eq!((lo, hi), (bmin, bmax), "{name}");
        }
    }
}

fn face_by_key(s: &Scope<'_>, key: &str) -> FaceId {
    let e = s.with_key(key)[0];
    let EntityId::Face(f) = e.id else {
        panic!("{key} is not a face")
    };
    f
}

fn edge_by_key(s: &Scope<'_>, key: &str) -> EdgeId {
    let e = s.with_key(key)[0];
    let EntityId::Edge(x) = e.id else {
        panic!("{key} is not an edge")
    };
    x
}

#[test]
fn closed_form_face_and_edge_properties() {
    let m = plate();
    let s = m.scope();
    let body = &m.bodies[0].0;
    let cap = face_props(body, face_by_key(&s, "e1/cap:end@bottom")).expect("cap");
    let hole = 9.0 * math::PI;
    assert!((cap.area - (800.0 - hole)).abs() < 1e-11, "{}", cap.area);
    let cx = -(hole * 10.0) / (800.0 - hole);
    assert!(
        (cap.centroid[0] - cx).abs() < 1e-12 && cap.centroid[1].abs() < 1e-12,
        "{:?}",
        cap.centroid
    );
    assert_eq!(cap.centroid[2], 5.0);
    assert_eq!(
        (cap.bbox.min, cap.bbox.max),
        ([-20.0, -10.0, 5.0], [20.0, 10.0, 5.0])
    );
    let ring = face_props(body, face_by_key(&s, "e1/side:ring")).expect("ring");
    assert!((ring.area - 30.0 * math::PI).abs() < 1e-11);
    assert!((ring.centroid[0] - 10.0).abs() < 1e-12 && ring.centroid[1].abs() < 1e-12);
    assert!((ring.centroid[2] - 2.5).abs() < 1e-12);
    assert_eq!(
        (ring.bbox.min, ring.bbox.max),
        ([7.0, -3.0, 0.0], [13.0, 3.0, 5.0])
    );
    let rim = edge_props(
        body,
        edge_by_key(&s, "e1/edge:{e1/cap:end@bottom|e1/side:ring}"),
    )
    .expect("rim");
    assert!((rim.length - 6.0 * math::PI).abs() < 1e-12);
    assert_eq!(rim.centroid, [10.0, 0.0, 5.0]);
    // A half circle's centroid lies 2r/π from its centre (the half cone's base, radius 4).
    let c = half_cone();
    let cs = c.scope();
    let arc = cs
        .entities(EntityKind::Edge)
        .into_iter()
        .find(|e| cs.carrier(*e).0 == forge_ir::v1::FingerprintType::Circle)
        .expect("base arc");
    let p = cs.props(arc).expect("arc");
    assert!((p.size - 4.0 * math::PI).abs() < 1e-12);
    let d = (p.centroid[0].powi(2) + p.centroid[1].powi(2)).sqrt();
    assert!((d - 8.0 / math::PI).abs() < 1e-12, "{:?}", p.centroid);
    // Half of a cone's lateral surface: π r l / 2, centroid at a third of the height.
    let side = cs.with_key("r1/side:b")[0];
    let sp = cs.props(side).expect("cone side");
    let l = (16.0f64 + 36.0).sqrt();
    assert!(
        (sp.size - 0.5 * math::PI * 4.0 * l).abs() < 1e-11,
        "{}",
        sp.size
    );
    assert!((sp.centroid[2] - 2.0).abs() < 1e-12, "{:?}", sp.centroid);
}

/// Probes (§7.6): on their entity, clear of the boundary by the margin, and matching exactly
/// one entity of their kind **in their body** within the oracle's `1e-6·s` (§8.1). Touching
/// bodies (v0 models stack walls on floors without a boolean) have coincident faces, so a
/// probe can only be unique once its body is known.
fn check_probes(name: &str, s: &Scope<'_>) {
    let tol = LINEAR_TOLERANCE * s.scale();
    let margin = FACE_PROBE_MARGIN * s.scale().max(1.0);
    for kind in [EntityKind::Face, EntityKind::Edge, EntityKind::Vertex] {
        let all = s.entities(kind);
        for e in &all {
            let p = s.probe(*e).expect("probe");
            assert_eq!(p.kind, kind);
            let matches = all
                .iter()
                .filter(|o| o.body == e.body)
                .filter(|o| {
                    let body = s.body(**o);
                    match o.id {
                        EntityId::Face(f) => point_on_face(body, f, p.point, tol).expect("on face"),
                        EntityId::Edge(x) => point_on_edge(body, x, p.point, tol),
                        EntityId::Vertex(v) => body.vertex(v).is_some_and(|v| {
                            forge_core::linalg::Vec3::from(p.point).distance(v.point) <= tol
                        }),
                        EntityId::Body => false,
                    }
                })
                .count();
            assert_eq!(
                matches,
                1,
                "{name}: probe of {} matches {matches} entities",
                s.key(*e)
            );
            if let EntityId::Face(f) = e.id {
                let body = s.body(*e);
                let depth = body
                    .face_edges(f)
                    .iter()
                    .filter_map(|x| body.edge(*x))
                    .map(|x| {
                        distance_to_edge(
                            forge_core::linalg::Vec3::from(p.point),
                            &x.curve,
                            x.t_range,
                        )
                    })
                    .fold(f64::INFINITY, f64::min);
                assert!(
                    depth >= margin,
                    "{name}: {} probe {depth} from its boundary",
                    s.key(*e)
                );
                let n = p.normal.expect("face probes carry a normal");
                assert!((n.iter().map(|x| x * x).sum::<f64>() - 1.0).abs() < 1e-12);
            }
            // §7.6: an edge probe is at distance ≥ 10·tol from the edge's vertices.
            if let EntityId::Edge(x) = e.id {
                let body = s.body(*e);
                let edge = body.edge(x).expect("edge");
                for v in [edge.start, edge.end].into_iter().flatten() {
                    let vp = body.vertex(v).expect("vertex").point;
                    let d = forge_core::linalg::Vec3::from(p.point).distance(vp);
                    assert!(
                        d >= margin,
                        "{name}: {} probe {d} from its vertex",
                        s.key(*e)
                    );
                }
            }
        }
    }
    // Deterministic.
    let again: Vec<_> = s
        .entities(EntityKind::Face)
        .iter()
        .map(|e| s.probe(*e).expect("p"))
        .collect();
    let first: Vec<_> = s
        .entities(EntityKind::Face)
        .iter()
        .map(|e| s.probe(*e).expect("p"))
        .collect();
    assert_eq!(again, first);
}

#[test]
fn probes_lie_on_their_entity_and_match_exactly_one() {
    for (name, m) in models() {
        check_probes(name, &m.scope());
    }
}

#[test]
fn the_probe_of_a_ring_face_avoids_the_hole() {
    // The cap's centroid lies in the plate, but an annulus' centroid lies in its hole: the
    // grid search must find a point on the face.
    let m = eval(&doc(
        r#"{ "kind": "circle", "id": "outer", "center": [0, 0], "radius": 10 },
           { "kind": "circle", "id": "inner", "center": [0, 0], "radius": 9 }"#,
        &e1(2.0),
    ));
    let s = m.scope();
    check_probes("annulus", &s);
    let cap = s.with_key("e1/cap:end@outer")[0];
    let p = s.probe(cap).expect("probe").point;
    let r = (p[0] * p[0] + p[1] * p[1]).sqrt();
    assert!(r > 9.0 && r < 10.0, "{p:?}");
}

/// The probe property and the key invariant over every body of the corpus (the 8 v0 corpus
/// programs and the 20 naming-harness models), and every face, edge and vertex referenced by
/// a synthesized query that resolves exactly to it.
#[test]
fn corpus_probes_keys_and_self_references() {
    // Paths without `..` components (a WASI runner resolves them inside one preopened dir).
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let crates = root.parent().expect("crates dir");
    let repo = crates
        .parent()
        .and_then(std::path::Path::parent)
        .expect("repo root");
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    for dir in [
        repo.join("corpus/programs"),
        crates.join("forge-naming/models"),
    ] {
        let mut v: Vec<_> = std::fs::read_dir(dir)
            .expect("corpus dir")
            .map(|e| e.expect("entry").path())
            .filter(|p| p.extension().is_some_and(|x| x == "json"))
            .collect();
        v.sort();
        files.extend(v);
    }
    assert_eq!(files.len(), 28);
    let mut bodies = 0;
    for f in files {
        let text = std::fs::read_to_string(&f).expect("read");
        for pi in 0..common::part_count(&text) {
            let m = common::eval_part(&text, pi);
            bodies += m.bodies.len();
            let s = m.scope();
            let name = f.display().to_string();
            assert!(
                s.key_problems().is_empty(),
                "{name}: {:?}",
                s.key_problems()
            );
            check_probes(&name, &s);
            for kind in [EntityKind::Face, EntityKind::Edge, EntityKind::Vertex] {
                for e in s.entities(kind) {
                    let q = synthesize_query(e, &s, None)
                        .unwrap_or_else(|| panic!("{name}: no query selects {}", s.key(e)));
                    let res = resolve(&r(json!({ "kind": kind.as_str(), "q": q })), &s);
                    assert_eq!(res.entities(), vec![e], "{name}: {}", s.key(e));
                }
            }
        }
    }
    assert!(bodies >= 30, "{bodies} bodies");
}

fn plate_doc(w: f64, h: f64, d: f64, rx: f64, rr: f64) -> String {
    let (a, b) = (w / 2.0, h / 2.0);
    doc(
        &format!(
            r#"{{ "kind": "line", "id": "bottom", "start": [{}, {}], "end": [{a}, {}] }},
               {{ "kind": "line", "id": "right", "start": [{a}, {}], "end": [{a}, {b}] }},
               {{ "kind": "line", "id": "top", "start": [{a}, {b}], "end": [{}, {b}] }},
               {{ "kind": "line", "id": "left", "start": [{}, {b}], "end": [{}, {}] }},
               {{ "kind": "circle", "id": "ring", "center": [{rx}, 0], "radius": {rr} }}"#,
            -a, -b, -b, -b, -a, -a, -a, -b
        ),
        &e1(d),
    )
}

/// Every face and edge referenced through its synthesized query, captured.
fn capture_all(s: &Scope<'_>) -> Vec<Ref> {
    let mut out = Vec::new();
    for kind in [EntityKind::Face, EntityKind::Edge] {
        for e in s.canonical(s.entities(kind)) {
            let q =
                synthesize_query(e, s, None).unwrap_or_else(|| panic!("no query for {}", s.key(e)));
            let rf = r(json!({ "kind": kind.as_str(), "q": q }));
            let res = resolve(&rf, s);
            assert_eq!(res.status, RefStatus::Exact, "{}", s.key(e));
            assert_eq!(res.entities(), vec![e]);
            let mut rf = rf;
            rf.capture = Some(capture(&res.members, s).expect("capture"));
            out.push(rf);
        }
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, .. ProptestConfig::default() })]

    /// Keys are complete and unique, every entity has a synthesized query selecting exactly
    /// it, probes match exactly one entity, and every captured reference still resolves
    /// exactly after a dimension edit that keeps the topology.
    #[test]
    fn dimension_edits_keep_every_reference_exact(
        w in 10.0f64..80.0, h in 10.0f64..80.0, d in 1.0f64..30.0,
        k in 0.2f64..0.8, sw in 0.8f64..1.25, sd in 0.5f64..2.0,
    ) {
        let rr = 0.2 * w.min(h);
        let rx = (k - 0.5) * (w - 2.5 * rr);
        let a = eval(&plate_doc(w, h, d, rx, rr));
        let sa = a.scope();
        prop_assert!(sa.key_problems().is_empty());
        check_probes("random plate", &sa);
        let refs = capture_all(&sa);
        let b = eval(&plate_doc(w * sw, h, d * sd, rx * sw, rr));
        let sb = b.scope();
        for rf in &refs {
            let res = resolve(rf, &sb);
            prop_assert_eq!(res.status, RefStatus::Exact, "{:?} {:?}", rf.q, res.error);
        }
    }
}
