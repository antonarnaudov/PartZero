//! The eight corpus programs: every produced body validates cleanly and has the face and
//! edge counts and types SPEC §4.4 prescribes (and the OCCT oracle reports).

use std::collections::BTreeMap;

use forge_core::Tolerance;
use forge_core::topo::{Body, validate};
use forge_ir::{Document, Feature};
use forge_ops::{extrude, regions, revolve, sketch_frame};

fn corpus(name: &str) -> Document {
    let path = format!(
        "{}/../../../corpus/programs/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    forge_ir::from_json(&text).expect("corpus program is valid IR")
}

/// Bodies of the (single) body feature of a corpus program.
fn bodies(name: &str) -> Vec<Body> {
    let doc = corpus(name);
    let feats = &doc.parts[0].features;
    let Feature::Sketch(sk) = &feats[0] else {
        panic!("first feature is a sketch")
    };
    let frame = sketch_frame(&sk.plane).expect("frame");
    let regs = regions(sk, &Tolerance::IR_DEFAULT).expect("regions");
    regs.iter()
        .map(|r| match &feats[1] {
            Feature::Extrude(e) => extrude(r, &frame, e.distance, e.direction, &e.name),
            Feature::Revolve(v) => revolve(r, &frame, &v.axis, v.angle, v.direction, &v.name),
            Feature::Sketch(_) => panic!("second feature is a body feature"),
        })
        .collect::<Result<_, _>>()
        .unwrap_or_else(|e| panic!("{name}: {e} ({})", e.code()))
}

fn histogram<'a>(names: impl Iterator<Item = &'a str>) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for n in names {
        *m.entry(n.to_string()).or_insert(0) += 1;
    }
    m
}

type Expect<'a> = (usize, usize, &'a [(&'a str, usize)], &'a [(&'a str, usize)]);

fn check(name: &str, expected: &[Expect<'_>]) {
    let bs = bodies(name);
    assert_eq!(bs.len(), expected.len(), "{name}: body count");
    for (i, (b, (faces, edges, ft, et))) in bs.iter().zip(expected).enumerate() {
        let issues = validate(b);
        assert!(issues.is_empty(), "{name}[{i}]: {issues:#?}");
        let c = b.counts();
        assert_eq!((c.faces, c.edges), (*faces, *edges), "{name}[{i}] counts");
        let hf = histogram(b.faces().values().map(|f| f.surface.kind_name()));
        let he = histogram(b.edges().values().map(|e| e.curve.kind_name()));
        let want = |v: &[(&str, usize)]| {
            v.iter()
                .map(|(k, n)| (k.to_string(), *n))
                .collect::<BTreeMap<_, _>>()
        };
        assert_eq!(hf, want(ft), "{name}[{i}] face types");
        assert_eq!(he, want(et), "{name}[{i}] edge types");
        // Every face, edge and vertex has a well-formed, unique name.
        let mut names: Vec<String> = b
            .faces()
            .values()
            .map(|f| f.provenance.name())
            .chain(b.edges().values().map(|e| e.provenance.name()))
            .chain(b.vertices().values().map(|v| v.provenance.name()))
            .collect();
        let n = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), n, "{name}[{i}]: provenance names are unique");
    }
}

#[test]
fn extrude_box_is_a_six_face_prism() {
    check("extrude_box", &[(6, 12, &[("plane", 6)], &[("line", 12)])]);
}

#[test]
fn extrude_plate_with_holes_has_ring_edges_and_no_seams() {
    check(
        "extrude_plate_with_holes",
        &[(
            10,
            20,
            &[("cylinder", 4), ("plane", 6)],
            &[("circle", 8), ("line", 12)],
        )],
    );
}

#[test]
fn extrude_slot_keeps_tangent_faces_separate() {
    check(
        "extrude_slot_symmetric_xz",
        &[(
            6,
            12,
            &[("cylinder", 2), ("plane", 4)],
            &[("circle", 4), ("line", 8)],
        )],
    );
}

#[test]
fn extrude_two_regions_gives_two_bodies_in_canonical_order() {
    check(
        "extrude_two_regions",
        &[
            (3, 2, &[("cylinder", 1), ("plane", 2)], &[("circle", 2)]),
            (4, 4, &[("cylinder", 2), ("plane", 2)], &[("circle", 4)]),
        ],
    );
}

#[test]
fn revolve_cone_sphere_has_singular_apex_and_pole() {
    check(
        "revolve_cone_sphere",
        &[(2, 1, &[("cone", 1), ("sphere", 1)], &[("circle", 1)])],
    );
}

#[test]
fn revolve_partial_ring_has_end_caps_and_arc_edges() {
    check(
        "revolve_partial_ring",
        &[(
            6,
            12,
            &[("cylinder", 2), ("plane", 4)],
            &[("circle", 4), ("line", 8)],
        )],
    );
}

#[test]
fn revolve_solid_cylinder_drops_the_axis_edge() {
    check(
        "revolve_solid_cylinder",
        &[(3, 2, &[("cylinder", 1), ("plane", 2)], &[("circle", 2)])],
    );
}

#[test]
fn revolve_torus_is_one_loopless_face() {
    check("revolve_torus", &[(1, 0, &[("torus", 1)], &[])]);
}
