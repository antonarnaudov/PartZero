//! Topology tests: the reference bodies validate cleanly; the builder rejects local
//! errors; the validator reports each class of global error with its code.

use std::collections::BTreeMap;

use forge_core::geom::{
    Circle2, Circle3, Cone, Curve2, Curve3, Cylinder, Line2, Line3, Plane, Sphere, Surface, Torus,
};
use forge_core::topo::{
    Body, BodyBuilder, EntityRef, IssueCode, Provenance, Role, Severity, euler_summary, has_errors,
    samples, validate,
};
use forge_core::{Frame, Id, Vec2, Vec3};

fn codes(body: &Body) -> Vec<&'static str> {
    validate(body).iter().map(|i| i.code.as_str()).collect()
}

fn histogram<'a>(names: impl Iterator<Item = &'a str>) -> BTreeMap<&'a str, usize> {
    let mut m = BTreeMap::new();
    for n in names {
        *m.entry(n).or_insert(0) += 1;
    }
    m
}

fn face_names(body: &Body) -> Vec<String> {
    body.faces().values().map(|f| f.provenance.name()).collect()
}

// ---- reference bodies -------------------------------------------------------------------

#[test]
fn unit_cube_is_valid_with_expected_counts() {
    let body = samples::unit_cube();
    let issues = validate(&body);
    assert!(issues.is_empty(), "{issues:#?}");
    let c = body.counts();
    assert_eq!(
        (c.shells, c.faces, c.loops, c.coedges, c.edges, c.vertices),
        (1, 6, 6, 24, 12, 8)
    );
    assert_eq!(
        histogram(body.faces().values().map(|f| f.surface.kind_name())),
        BTreeMap::from([("plane", 6)])
    );
    assert_eq!(
        histogram(body.edges().values().map(|e| e.curve.kind_name())),
        BTreeMap::from([("line", 12)])
    );
    let eu = euler_summary(&body, body.shell_ids()[0]).expect("shell");
    assert_eq!(
        (
            eu.vertices,
            eu.edges,
            eu.faces,
            eu.loops,
            eu.chi,
            eu.genus()
        ),
        (8, 12, 6, 6, 2, Some(0))
    );
    assert!(body.coedges().values().all(|c| c.pcurve.is_some()));
    assert!(body.shells().values().all(|s| s.closed));
}

#[test]
fn unit_cube_provenance_names_are_canonical_and_unique() {
    let body = samples::unit_cube();
    assert_eq!(
        face_names(&body),
        [
            "cube/cap:start",
            "cube/cap:end",
            "cube/side:s0",
            "cube/side:s1",
            "cube/side:s2",
            "cube/side:s3"
        ]
    );
    let mut all: Vec<String> = face_names(&body);
    all.extend(body.edges().values().map(|e| e.provenance.name()));
    all.extend(body.vertices().values().map(|v| v.provenance.name()));
    let n = all.len();
    all.sort();
    all.dedup();
    assert_eq!(all.len(), n, "names must be unique");
    assert!(all.contains(&"cube/edge:{cube/cap:start|cube/side:s0}".to_string()));
    assert!(all.contains(&"cube/vertex:{cube/cap:start|cube/side:s0|cube/side:s3}".to_string()));
}

#[test]
fn closed_cylinder_has_no_seam_and_no_vertices() {
    let body = samples::cylinder(10.0, 30.0);
    let issues = validate(&body);
    assert!(issues.is_empty(), "{issues:#?}");
    let c = body.counts();
    assert_eq!(
        (c.faces, c.loops, c.coedges, c.edges, c.vertices),
        (3, 4, 4, 2, 0)
    );
    assert_eq!(
        histogram(body.faces().values().map(|f| f.surface.kind_name())),
        BTreeMap::from([("cylinder", 1), ("plane", 2)])
    );
    assert_eq!(
        histogram(body.edges().values().map(|e| e.curve.kind_name())),
        BTreeMap::from([("circle", 2)])
    );
    assert!(body.edges().values().all(|e| e.is_ring()));
    let side = body
        .faces()
        .values()
        .find(|f| f.surface.kind_name() == "cylinder")
        .expect("side face");
    assert_eq!(side.loops.len(), 2);
    assert_eq!(side.provenance.name(), "cyl/side:c");
    let eu = euler_summary(&body, body.shell_ids()[0]).expect("shell");
    assert_eq!(
        (eu.vertices, eu.ring_edges, eu.edges, eu.chi, eu.genus()),
        (0, 2, 2, 2, Some(0))
    );
    let names: Vec<String> = body.edges().values().map(|e| e.provenance.name()).collect();
    assert_eq!(
        names,
        [
            "cyl/edge:{cyl/cap:start|cyl/side:c}",
            "cyl/edge:{cyl/cap:end|cyl/side:c}"
        ]
    );
}

#[test]
fn sphere_is_one_face_without_loops() {
    let body = samples::sphere(7.0);
    assert!(validate(&body).is_empty());
    let c = body.counts();
    assert_eq!((c.faces, c.loops, c.edges, c.vertices), (1, 0, 0, 0));
    let eu = euler_summary(&body, body.shell_ids()[0]).expect("shell");
    assert_eq!((eu.chi, eu.genus()), (2, Some(0)));
    assert_eq!(face_names(&body), ["ball/side:a"]);
}

#[test]
fn full_cone_is_bounded_only_by_its_base_ring() {
    let (r, h) = (5.0, 12.0);
    let half = forge_core::math::atan(r / h);
    let apex_frame = Frame::from_normal_x(
        Vec3::new(0.0, 0.0, h),
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::unit_x(),
    )
    .expect("frame");
    let cone = Cone::new(apex_frame, 0.0, half).expect("cone");
    let (base_name, side_name) = (
        Provenance::cap_start("rev"),
        Provenance::side("rev", "slant"),
    );
    let mut b = BodyBuilder::new();
    let ring = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), r).expect("circle")),
            Provenance::edge_between("rev", base_name.name(), side_name.name()),
        )
        .expect("ring");
    let shell = b.add_shell(true);
    let base = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            base_name,
        )
        .expect("base");
    b.add_loop(base, &[(ring, false)]).expect("loop");
    let side = b
        .add_face(shell, Surface::Cone(cone), true, side_name)
        .expect("side");
    let lp = b.add_loop(side, &[(ring, true)]).expect("loop");
    // The cone's frame is upside down, so its u runs clockwise: u = −t, v = h.
    let cid = b.body().loop_(lp).expect("loop").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Line(Line2::new(Vec2::new(0.0, h), Vec2::new(-1.0, 0.0)).expect("line")),
    )
    .expect("pc");
    let body = b.finish_validated().expect("valid cone body");
    let eu = euler_summary(&body, body.shell_ids()[0]).expect("shell");
    assert_eq!(
        (eu.vertices, eu.ring_edges, eu.edges, eu.faces, eu.chi),
        (0, 1, 1, 2, 2)
    );
    // The apex lies on the surface but is not a vertex or edge.
    assert!(cone.apex().distance(Vec3::new(0.0, 0.0, h)) < 1e-15);
    assert_eq!(body.counts().vertices, 0);
}

#[test]
fn full_torus_face_has_genus_one() {
    let mut b = BodyBuilder::new();
    let shell = b.add_shell(true);
    let t = Torus::new(Frame::world(), 10.0, 3.0).expect("torus");
    b.add_face(
        shell,
        Surface::Torus(t),
        true,
        Provenance::side("ring", "c"),
    )
    .expect("face");
    let body = b.finish_validated().expect("valid torus");
    let eu = euler_summary(&body, body.shell_ids()[0]).expect("shell");
    assert_eq!((eu.face_genus, eu.chi, eu.genus()), (1, 0, Some(1)));
}

#[test]
fn construction_is_deterministic() {
    let a = format!("{:?}", samples::unit_cube());
    let b = format!("{:?}", samples::unit_cube());
    assert_eq!(a, b);
    let c = format!("{:?}", samples::cylinder(10.0, 30.0));
    assert_eq!(c, format!("{:?}", samples::cylinder(10.0, 30.0)));
}

#[test]
fn adjacency_helpers() {
    let body = samples::unit_cube();
    for (fid, _) in body.faces().iter() {
        assert_eq!(body.face_edges(fid).len(), 4);
    }
    for (eid, _) in body.edges().iter() {
        assert_eq!(body.edge_faces(eid).len(), 2);
    }
    for (lid, lp) in body.loops().iter() {
        let n = lp.coedges.len();
        for i in 0..n {
            assert_eq!(
                body.coedge_end(lp.coedges[i]),
                body.coedge_start(lp.coedges[(i + 1) % n]),
                "{lid:?}"
            );
        }
    }
}

// ---- builder rejects local errors -------------------------------------------------------

#[test]
fn builder_rejects_local_errors_with_codes() {
    let mut b = BodyBuilder::new();
    let v0 = b
        .add_vertex(Vec3::zero(), Provenance::vertex_at("t", ["a"]))
        .expect("v0");
    let v1 = b
        .add_vertex(Vec3::unit_x(), Provenance::vertex_at("t", ["b"]))
        .expect("v1");
    let v_far = b
        .add_vertex(Vec3::new(0.0, 5.0, 0.0), Provenance::vertex_at("t", ["c"]))
        .expect("v2");
    let line = || Curve3::Line(Line3::through(Vec3::zero(), Vec3::unit_x()).expect("line"));
    let p = || Provenance::edge_between("t", "a", "b");

    fn err<T>(r: Result<T, forge_core::TopoError>) -> &'static str {
        r.map(|_| ()).unwrap_err().code()
    }
    assert_eq!(
        err(b.add_vertex(Vec3::new(f64::NAN, 0.0, 0.0), p())),
        "TOPO_NON_FINITE"
    );
    assert_eq!(
        err(b.add_edge(line(), (0.0, 1.0), v0, v_far, p())),
        "TOPO_VERTEX_OFF_CURVE"
    );
    assert_eq!(
        err(b.add_edge(line(), (1.0, 1.0), v0, v1, p())),
        "TOPO_INVALID_RANGE"
    );
    assert_eq!(
        err(b.add_edge(line(), (0.0, 1.0), v0, Id::from_raw_parts(99, 0), p())),
        "TOPO_INVALID_ID"
    );
    assert_eq!(
        err(b.add_ring_edge(line(), p())),
        "TOPO_RING_CURVE_NOT_CLOSED"
    );

    let e01 = b.add_edge(line(), (0.0, 1.0), v0, v1, p()).expect("edge");
    let ring = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), 1.0).expect("c")),
            p(),
        )
        .expect("ring");
    let shell = b.add_shell(false);
    let face = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            true,
            Provenance::cap_end("t"),
        )
        .expect("f");
    assert_eq!(err(b.add_loop(face, &[])), "TOPO_EMPTY_LOOP");
    assert_eq!(
        err(b.add_loop(face, &[(e01, true)])),
        "TOPO_LOOP_NOT_CLOSED"
    );
    assert_eq!(
        err(b.add_loop(face, &[(e01, true), (e01, false), (ring, true)])),
        "TOPO_RING_EDGE_IN_MULTI_LOOP"
    );
    assert_eq!(
        err(b.set_edge_tolerance(e01, -1.0)),
        "TOPO_INVALID_TOLERANCE"
    );
    // A there-and-back loop is topologically closed (the validator flags its zero area).
    b.add_loop(face, &[(e01, true), (e01, false)])
        .expect("closed topologically");
}

// ---- validator reports global errors ------------------------------------------------------

/// Knobs for a deliberately broken cube.
#[derive(Default)]
struct Knobs {
    skip_face: Option<usize>,
    reverse_face: Option<usize>,
    flip_sense: Option<usize>,
    face_provenance: Option<(usize, Provenance)>,
}

/// A unit cube built from vertex cycles with per-face frames derived from the cycle.
fn cube_with(k: &Knobs) -> Body {
    let pos = |i: usize| Vec3::new((i & 1) as f64, ((i >> 1) & 1) as f64, ((i >> 2) & 1) as f64);
    let mut cycles: Vec<Vec<usize>> = vec![
        vec![0, 2, 3, 1],
        vec![4, 5, 7, 6],
        vec![0, 1, 5, 4],
        vec![1, 3, 7, 5],
        vec![2, 6, 7, 3],
        vec![0, 4, 6, 2],
    ];
    if let Some(r) = k.reverse_face {
        cycles[r].reverse();
    }
    let names: Vec<Provenance> = (0..6)
        .map(|i| Provenance::side("box", format!("f{i}")))
        .collect();
    let mut b = BodyBuilder::new();
    let verts: Vec<_> = (0..8)
        .map(|i| {
            b.add_vertex(pos(i), Provenance::vertex_at("box", [format!("v{i}")]))
                .expect("v")
        })
        .collect();
    let mut edges = BTreeMap::new();
    for cyc in &cycles {
        for j in 0..4 {
            let (a, c) = (cyc[j], cyc[(j + 1) % 4]);
            let key = (a.min(c), a.max(c));
            if let std::collections::btree_map::Entry::Vacant(slot) = edges.entry(key) {
                let line = Line3::through(pos(key.0), pos(key.1)).expect("line");
                let e = b
                    .add_edge(
                        Curve3::Line(line),
                        (0.0, 1.0),
                        verts[key.0],
                        verts[key.1],
                        Provenance::edge_between("box", "x", "y"),
                    )
                    .expect("edge");
                slot.insert(e);
            }
        }
    }
    let shell = b.add_shell(true);
    for (i, cyc) in cycles.iter().enumerate() {
        if k.skip_face == Some(i) {
            continue;
        }
        let (p0, p1, p2) = (pos(cyc[0]), pos(cyc[1]), pos(cyc[2]));
        let frame = Frame::from_normal_x(p0, (p1 - p0).cross(p2 - p1), p1 - p0).expect("frame");
        let sense = k.flip_sense != Some(i);
        let prov = match &k.face_provenance {
            Some((j, p)) if *j == i => p.clone(),
            _ => names[i].clone(),
        };
        let f = b
            .add_face(shell, Surface::Plane(Plane::new(frame)), sense, prov)
            .expect("face");
        let uses: Vec<_> = (0..4)
            .map(|j| {
                let (a, c) = (cyc[j], cyc[(j + 1) % 4]);
                (edges[&(a.min(c), a.max(c))], a < c)
            })
            .collect();
        b.add_loop(f, &uses).expect("loop");
    }
    b.finish()
}

#[test]
fn well_formed_knob_cube_is_valid() {
    let issues = validate(&cube_with(&Knobs::default()));
    assert!(issues.is_empty(), "{issues:#?}");
}

#[test]
fn missing_face_breaks_edge_use_counts() {
    let body = cube_with(&Knobs {
        skip_face: Some(1),
        ..Default::default()
    });
    let issues = validate(&body);
    let counts: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::EdgeUseCount)
        .collect();
    assert_eq!(counts.len(), 4, "{issues:#?}");
    assert!(
        counts
            .iter()
            .all(|i| i.measured == Some(1.0) && i.allowed == Some(2.0))
    );
    assert!(has_errors(&issues));
    assert!(
        BodyBuilder::from_body(body, forge_core::Tolerance::IR_DEFAULT)
            .finish_validated()
            .is_err()
    );
}

#[test]
fn reversed_face_breaks_edge_orientation() {
    let issues = validate(&cube_with(&Knobs {
        reverse_face: Some(3),
        ..Default::default()
    }));
    let n = issues
        .iter()
        .filter(|i| i.code == IssueCode::EdgeOrientation)
        .count();
    assert_eq!(n, 4, "{issues:#?}");
}

#[test]
fn flipped_sense_breaks_planar_loop_orientation() {
    let issues = validate(&cube_with(&Knobs {
        flip_sense: Some(0),
        ..Default::default()
    }));
    assert_eq!(
        issues.iter().map(|i| i.code).collect::<Vec<_>>(),
        [IssueCode::LoopOrientation],
        "{issues:#?}"
    );
}

#[test]
fn provenance_problems_are_reported() {
    let body = cube_with(&Knobs {
        face_provenance: Some((2, Provenance::new("", Role::Side))),
        ..Default::default()
    });
    assert!(codes(&body).contains(&"PROVENANCE_MISSING"));
    let body = cube_with(&Knobs {
        face_provenance: Some((2, Provenance::side("box", "a+b"))),
        ..Default::default()
    });
    let issues = validate(&body);
    let bad: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::ProvenanceMalformed)
        .collect();
    assert_eq!(bad.len(), 1);
    assert!(matches!(bad[0].entity, EntityRef::Face(_)));
}

#[test]
fn edge_off_surface_and_bad_pcurve_are_reported_with_measurements() {
    // A cylinder whose side surface is 0.5 mm too large.
    let mut b = BodyBuilder::new();
    let bottom = Curve3::Circle(Circle3::new(Frame::world(), 10.0).expect("c"));
    let top = Curve3::Circle(
        Circle3::new(Frame::world().with_origin(Vec3::new(0.0, 0.0, 30.0)), 10.0).expect("c"),
    );
    let eb = b
        .add_ring_edge(bottom, Provenance::edge_between("c", "a", "s"))
        .expect("ring");
    let et = b
        .add_ring_edge(top, Provenance::edge_between("c", "b", "s"))
        .expect("ring");
    let shell = b.add_shell(true);
    let fb = b
        .add_face(
            shell,
            Plane::new(Frame::world()).into(),
            false,
            Provenance::cap_start("c"),
        )
        .expect("f");
    let lb = b.add_loop(fb, &[(eb, false)]).expect("l");
    let top_plane = Plane::new(Frame::world().with_origin(Vec3::new(0.0, 0.0, 30.0)));
    let ft = b
        .add_face(shell, top_plane.into(), true, Provenance::cap_end("c"))
        .expect("f");
    b.add_loop(ft, &[(et, true)]).expect("l");
    let fs = b
        .add_face(
            shell,
            Cylinder::new(Frame::world(), 10.5).expect("cyl").into(),
            true,
            Provenance::side("c", "k"),
        )
        .expect("f");
    b.add_loop(fs, &[(eb, true)]).expect("l");
    b.add_loop(fs, &[(et, false)]).expect("l");
    // Wrong pcurve on the bottom cap: radius 9 instead of 10.
    let cid = b.body().loop_(lb).expect("loop").coedges[0];
    b.set_pcurve(
        cid,
        Curve2::Circle(Circle2::new(Vec2::zero(), 9.0).expect("c")),
    )
    .expect("pc");
    let issues = validate(&b.finish());
    let off: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::EdgeNotOnSurface)
        .collect();
    assert_eq!(off.len(), 2, "{issues:#?}");
    assert!(
        off.iter()
            .all(|i| (i.measured.expect("distance") - 0.5).abs() < 1e-12)
    );
    let pc: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::PcurveDeviation)
        .collect();
    assert_eq!(pc.len(), 1);
    assert!((pc[0].measured.expect("deviation") - 1.0).abs() < 1e-12);
}

#[test]
fn unbounded_face_disconnected_shell_and_orphans_are_reported() {
    // A plane face without loops.
    let mut b = BodyBuilder::new();
    let s = b.add_shell(false);
    b.add_face(
        s,
        Plane::new(Frame::world()).into(),
        true,
        Provenance::cap_end("p"),
    )
    .expect("f");
    assert!(codes(&b.finish()).contains(&"FACE_UNBOUNDED"));

    // A closed shell made of two disjoint closed surfaces has χ = 4.
    let mut b = BodyBuilder::from_body(samples::unit_cube(), forge_core::Tolerance::IR_DEFAULT);
    let shell = b.body().shell_ids()[0];
    let far = Frame::world().with_origin(Vec3::new(10.0, 0.0, 0.0));
    b.add_face(
        shell,
        Sphere::new(far, 1.0).expect("s").into(),
        true,
        Provenance::side("ball", "a"),
    )
    .expect("f");
    // And an unused vertex.
    b.add_vertex(
        Vec3::new(5.0, 5.0, 5.0),
        Provenance::vertex_at("stray", ["x"]),
    )
    .expect("v");
    let issues = validate(&b.finish());
    let euler: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::EulerCharacteristic)
        .collect();
    assert_eq!(euler.len(), 1);
    assert_eq!(euler[0].measured, Some(4.0));
    let orphan: Vec<_> = issues
        .iter()
        .filter(|i| i.code == IssueCode::OrphanEntity)
        .collect();
    assert_eq!(orphan.len(), 1);
    assert_eq!(orphan[0].severity, Severity::Warning);
}

#[test]
fn edge_used_three_times_is_reported() {
    let mut b = BodyBuilder::from_body(samples::unit_cube(), forge_core::Tolerance::IR_DEFAULT);
    let body = b.body().clone();
    let (eid, e) = body.edges().iter().next().expect("edge");
    let (v0, v1) = (e.start.expect("v"), e.end.expect("v"));
    // A dangling fin: a triangle hanging off one cube edge.
    let tip = b
        .add_vertex(
            Vec3::new(0.5, -1.0, -1.0),
            Provenance::vertex_at("fin", ["t"]),
        )
        .expect("v");
    let p0 = body.vertex(v0).expect("v").point;
    let p1 = body.vertex(v1).expect("v").point;
    let tip_p = Vec3::new(0.5, -1.0, -1.0);
    let e1 = b
        .add_edge(
            Line3::through(p1, tip_p).expect("l").into(),
            (0.0, p1.distance(tip_p)),
            v1,
            tip,
            Provenance::edge_between("fin", "a", "b"),
        )
        .expect("e");
    let e2 = b
        .add_edge(
            Line3::through(tip_p, p0).expect("l").into(),
            (0.0, tip_p.distance(p0)),
            tip,
            v0,
            Provenance::edge_between("fin", "a", "c"),
        )
        .expect("e");
    let shell = b.body().shell_ids()[0];
    let frame = Frame::from_normal_x(p0, (p1 - p0).cross(tip_p - p1), p1 - p0).expect("frame");
    let f = b
        .add_face(
            shell,
            Plane::new(frame).into(),
            true,
            Provenance::side("fin", "t"),
        )
        .expect("f");
    b.add_loop(f, &[(eid, true), (e1, true), (e2, true)])
        .expect("loop");
    let issues = validate(&b.finish());
    assert!(issues.iter().any(|i| i.code == IssueCode::EdgeUseCount
        && i.entity == EntityRef::Edge(eid)
        && i.measured == Some(3.0)));
}

#[test]
fn issue_display_includes_code_and_entity() {
    let body = cube_with(&Knobs {
        skip_face: Some(0),
        ..Default::default()
    });
    let issues = validate(&body);
    let s = issues[0].to_string();
    assert!(s.starts_with("[EDGE_USE_COUNT] Edge(Edge#"), "{s}");
}

#[test]
fn ir_tolerance_matches_the_spec_constant() {
    assert_eq!(
        forge_core::Tolerance::IR_DEFAULT.linear.to_bits(),
        forge_ir::LINEAR_TOLERANCE.to_bits()
    );
    assert_eq!(
        forge_core::tolerance::IR_LINEAR_TOLERANCE.to_bits(),
        forge_ir::LINEAR_TOLERANCE.to_bits()
    );
}
