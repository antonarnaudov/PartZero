//! Topology details: cavity shells, provenance names and their instance indices,
//! singular points on the axis, the axis-crossing check, and parameter validation.

use forge_core::Tolerance;
use forge_core::topo::{Body, validate};
use forge_ir::{NamedPlane, PlaneSpec, SketchAxis, SketchCurve, SketchFeature, SweepDirection};
use forge_ops::{Region, extrude, regions, revolve, sketch_frame};

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn region_of(curves: Vec<SketchCurve>) -> Region {
    let s = SketchFeature {
        id: "s".into(),
        name: "s".into(),
        suppressed: false,
        plane: PlaneSpec::Named(NamedPlane::XZ),
        curves,
    };
    let mut r = regions(&s, &Tolerance::IR_DEFAULT).expect("regions");
    assert_eq!(r.len(), 1);
    r.remove(0)
}

fn frame() -> forge_core::Frame {
    sketch_frame(&PlaneSpec::Named(NamedPlane::XZ)).expect("frame")
}

fn z_axis() -> SketchAxis {
    SketchAxis {
        origin: [0.0, 0.0],
        direction: [0.0, 1.0],
    }
}

fn names(b: &Body) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut f: Vec<String> = b.faces().values().map(|x| x.provenance.name()).collect();
    let mut e: Vec<String> = b.edges().values().map(|x| x.provenance.name()).collect();
    let mut v: Vec<String> = b.vertices().values().map(|x| x.provenance.name()).collect();
    f.sort();
    e.sort();
    v.sort();
    (f, e, v)
}

#[test]
fn full_revolve_of_a_region_with_a_hole_has_a_cavity_shell() {
    let r = region_of(vec![
        SketchCurve::Circle {
            id: "outer".into(),
            center: [20.0, 0.0],
            radius: 6.0,
        },
        SketchCurve::Circle {
            id: "inner".into(),
            center: [21.0, 0.5],
            radius: 2.0,
        },
    ]);
    let b = revolve(
        &r,
        &frame(),
        &z_axis(),
        360.0,
        SweepDirection::Normal,
        "donut",
    )
    .expect("revolve");
    assert!(validate(&b).is_empty(), "{:#?}", validate(&b));
    assert_eq!(b.shell_ids().len(), 2);
    assert_eq!(b.counts().faces, 2);
    assert_eq!(b.counts().edges, 0);
    let (f, _, _) = names(&b);
    assert_eq!(f, ["donut/side:inner", "donut/side:outer"]);
}

#[test]
fn partial_revolve_names_edges_after_their_faces() {
    let r = region_of(vec![
        line("inner", [20.0, 0.0], [20.0, 6.0]),
        line("top", [20.0, 6.0], [32.0, 6.0]),
        line("outer", [32.0, 6.0], [32.0, 0.0]),
        line("bottom", [32.0, 0.0], [20.0, 0.0]),
    ]);
    let b = revolve(&r, &frame(), &z_axis(), 90.0, SweepDirection::Normal, "q").expect("revolve");
    let (f, e, v) = names(&b);
    assert_eq!(
        f,
        [
            "q/endcap:end",
            "q/endcap:start",
            "q/side:bottom",
            "q/side:inner",
            "q/side:outer",
            "q/side:top"
        ]
    );
    assert!(e.contains(&"q/edge:{q/endcap:start|q/side:inner}".to_string()));
    assert!(e.contains(&"q/edge:{q/side:inner|q/side:top}".to_string()));
    assert!(v.contains(&"q/vertex:{q/endcap:end|q/side:inner|q/side:top}".to_string()));
    // All names are distinct.
    let mut all = [f, e, v].concat();
    let n = all.len();
    all.dedup();
    assert_eq!(all.len(), n);
}

#[test]
fn edges_between_the_same_two_faces_get_canonical_indices() {
    // A "D" profile: the line and the arc meet twice, so the two vertical edges between
    // their side faces share a name and are told apart by index (ordered by junction).
    let s = SketchFeature {
        id: "s".into(),
        name: "s".into(),
        suppressed: false,
        plane: PlaneSpec::Named(NamedPlane::XY),
        curves: vec![
            line("chord", [-1.0, 0.0], [1.0, 0.0]),
            SketchCurve::Arc {
                id: "bow".into(),
                start: [1.0, 0.0],
                end: [-1.0, 0.0],
                center: [0.0, 0.0],
                ccw: true,
            },
        ],
    };
    let r = regions(&s, &Tolerance::IR_DEFAULT)
        .expect("regions")
        .remove(0);
    let fr = sketch_frame(&s.plane).expect("frame");
    let b = extrude(&r, &fr, 1.0, SweepDirection::Normal, "d").expect("extrude");
    let (_, e, _) = names(&b);
    let between: Vec<&String> = e
        .iter()
        .filter(|n| n.starts_with("d/edge:{d/side:bow|d/side:chord}"))
        .collect();
    assert_eq!(
        between,
        [
            "d/edge:{d/side:bow|d/side:chord}",
            "d/edge:{d/side:bow|d/side:chord}#1"
        ]
    );
    // The index follows the sketch identity of the junction, not construction order:
    // "bow:end|chord:start" sorts before "bow:start|chord:end".
    let first = b
        .edges()
        .values()
        .find(|x| x.provenance.name() == "d/edge:{d/side:bow|d/side:chord}")
        .expect("edge");
    assert!(first.curve.eval(0.0).distance([-1.0, 0.0, 0.0].into()) < 1e-12);
}

#[test]
fn profile_vertex_on_the_axis_is_a_singular_point_at_360_and_a_vertex_below() {
    let tri = vec![
        line("a", [0.0, 0.0], [5.0, 2.0]),
        line("b", [5.0, 2.0], [5.0, 6.0]),
        line("c", [5.0, 6.0], [0.0, 0.0]),
    ];
    let r = region_of(tri);
    let full = revolve(&r, &frame(), &z_axis(), 360.0, SweepDirection::Normal, "t").expect("full");
    assert!(validate(&full).is_empty());
    assert_eq!((full.counts().edges, full.counts().vertices), (2, 0));
    let part = revolve(
        &r,
        &frame(),
        &z_axis(),
        120.0,
        SweepDirection::Symmetric,
        "t",
    )
    .expect("part");
    assert!(validate(&part).is_empty());
    // One apex vertex shared by both caps, two vertices per off-axis profile vertex.
    assert_eq!(part.counts().vertices, 5);
}

#[test]
fn a_region_crossing_the_axis_is_rejected_with_its_extent() {
    let r = region_of(vec![
        line("a", [-1.0, 0.0], [3.0, 0.0]),
        line("b", [3.0, 0.0], [3.0, 2.0]),
        line("c", [3.0, 2.0], [-1.0, 2.0]),
        line("d", [-1.0, 2.0], [-1.0, 0.0]),
    ]);
    let e = revolve(&r, &frame(), &z_axis(), 90.0, SweepDirection::Normal, "x").unwrap_err();
    assert_eq!(e.code(), "REVOLVE_CROSSES_AXIS");
    let forge_ops::OpError::RevolveCrossesAxis { min, max, .. } = e else {
        unreachable!()
    };
    assert_eq!((min, max), (-3.0, 1.0));
}

#[test]
fn invalid_parameters_are_rejected() {
    let r = region_of(vec![SketchCurve::Circle {
        id: "c".into(),
        center: [10.0, 0.0],
        radius: 1.0,
    }]);
    let e = extrude(&r, &frame(), 0.0, SweepDirection::Normal, "e").unwrap_err();
    assert_eq!(e.code(), "INVALID_PARAMETER");
    let e = revolve(&r, &frame(), &z_axis(), 400.0, SweepDirection::Normal, "r").unwrap_err();
    assert_eq!(e.code(), "INVALID_PARAMETER");
    let bad_id = region_of(vec![SketchCurve::Circle {
        id: "c:1".into(),
        center: [10.0, 0.0],
        radius: 1.0,
    }]);
    let e = extrude(&bad_id, &frame(), 1.0, SweepDirection::Normal, "e").unwrap_err();
    assert_eq!(e.code(), "FORGE_INVALID_CURVE_ID");
}
