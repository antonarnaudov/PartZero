//! Mass properties, bounding boxes and validity on bodies with closed-form answers:
//! forge-core's reference bodies and the eight corpus programs built by forge-ops.

use forge_check::{Issue, bbox, body_metrics, mass_properties, validate};
use forge_core::Tolerance;
use forge_core::math::PI;
use forge_core::topo::{Body, Severity, samples};
use forge_ir::{Document, Feature};
use forge_ops::{extrude, regions, revolve, sketch_frame};

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs().max(1e-300)
}

fn errors(issues: &[Issue]) -> Vec<&Issue> {
    issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .collect()
}

fn corpus_bodies(name: &str) -> Vec<Body> {
    let path = format!(
        "{}/../../../corpus/programs/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let doc: Document =
        forge_ir::from_json(&std::fs::read_to_string(&path).expect("read")).expect("valid IR");
    let feats = &doc.parts[0].features;
    let Feature::Sketch(sk) = &feats[0] else {
        panic!("sketch first")
    };
    let frame = sketch_frame(&sk.plane).expect("frame");
    regions(sk, &Tolerance::IR_DEFAULT)
        .expect("regions")
        .iter()
        .map(|r| match &feats[1] {
            Feature::Extrude(e) => extrude(r, &frame, e.distance, e.direction, &e.name),
            Feature::Revolve(v) => revolve(r, &frame, &v.axis, v.angle, v.direction, &v.name),
            Feature::Sketch(_) => panic!("body feature second"),
        })
        .collect::<Result<_, _>>()
        .expect("bodies")
}

/// `(volume, area, centroid, bbox_min, bbox_max)` expectations.
type Expect = (f64, f64, [f64; 3], [f64; 3], [f64; 3]);

fn check(name: &str, want: &[Expect]) {
    let bodies = corpus_bodies(name);
    assert_eq!(bodies.len(), want.len());
    for (i, (b, (v, a, c, lo, hi))) in bodies.iter().zip(want).enumerate() {
        let issues = validate(b);
        assert!(errors(&issues).is_empty(), "{name}[{i}]: {issues:#?}");
        let mp = mass_properties(b).expect("mass properties");
        assert!(
            rel(mp.volume, *v) < 1e-12,
            "{name}[{i}] volume {} vs {v}",
            mp.volume
        );
        assert!(
            rel(mp.area, *a) < 1e-12,
            "{name}[{i}] area {} vs {a}",
            mp.area
        );
        for (got, want) in mp.centroid.iter().zip(c) {
            assert!(
                (got - want).abs() < 1e-10,
                "{name}[{i}] centroid {:?}",
                mp.centroid
            );
        }
        let (bmin, bmax) = bbox(b).expect("bbox");
        for k in 0..3 {
            assert!(
                (bmin[k] - lo[k]).abs() < 1e-12,
                "{name}[{i}] bbox_min {bmin:?}"
            );
            assert!(
                (bmax[k] - hi[k]).abs() < 1e-12,
                "{name}[{i}] bbox_max {bmax:?}"
            );
        }
        let m = body_metrics(b).expect("metrics");
        assert!(m.valid);
    }
}

#[test]
fn reference_bodies_have_exact_mass_properties() {
    let cube = samples::unit_cube();
    let mp = mass_properties(&cube).expect("cube");
    assert!(
        rel(mp.volume, 1.0) < 1e-14 && rel(mp.area, 6.0) < 1e-14,
        "{mp:?}"
    );
    assert!(mp.centroid.iter().all(|c| (c - 0.5).abs() < 1e-14));
    let cyl = samples::cylinder(2.0, 5.0);
    let mp = mass_properties(&cyl).expect("cylinder");
    assert!(rel(mp.volume, PI * 4.0 * 5.0) < 1e-13, "{mp:?}");
    assert!(rel(mp.area, 2.0 * PI * 2.0 * 5.0 + 2.0 * PI * 4.0) < 1e-13);
    assert!((mp.centroid[2] - 2.5).abs() < 1e-13);
    let ball = samples::sphere(3.0);
    let mp = mass_properties(&ball).expect("sphere");
    assert!(rel(mp.volume, 4.0 / 3.0 * PI * 27.0) < 1e-13, "{mp:?}");
    assert!(rel(mp.area, 4.0 * PI * 9.0) < 1e-13);
    let (lo, hi) = bbox(&ball).expect("bbox");
    assert_eq!(lo.map(|x| (x + 3.0).abs() < 1e-14), [true; 3]);
    assert_eq!(hi.map(|x| (x - 3.0).abs() < 1e-14), [true; 3]);
    for b in [&cube, &cyl, &ball] {
        assert!(errors(&validate(b)).is_empty());
    }
}

#[test]
fn extrude_box_matches_closed_form() {
    check(
        "extrude_box",
        &[(
            32000.0,
            10080.0,
            [0.0, 0.0, 4.0],
            [-40.0, -25.0, 0.0],
            [40.0, 25.0, 8.0],
        )],
    );
}

#[test]
fn plate_with_holes_matches_closed_form() {
    let hole = PI * 2.75 * 2.75;
    let v = (6000.0 - 4.0 * hole) * 5.0;
    let a = 2.0 * (6000.0 - 4.0 * hole) + 2.0 * (100.0 + 60.0) * 5.0 + 4.0 * 2.0 * PI * 2.75 * 5.0;
    check(
        "extrude_plate_with_holes",
        &[(v, a, [50.0, 30.0, 2.5], [0.0, 0.0, 0.0], [100.0, 60.0, 5.0])],
    );
}

#[test]
fn slot_matches_closed_form() {
    let area2d = 40.0 * 12.0 + PI * 36.0;
    let perim = 80.0 + 2.0 * PI * 6.0;
    check(
        "extrude_slot_symmetric_xz",
        &[(
            area2d * 10.0,
            2.0 * area2d + perim * 10.0,
            [0.0, 0.0, 0.0],
            [-26.0, -5.0, -6.0],
            [26.0, 5.0, 6.0],
        )],
    );
}

#[test]
fn two_regions_match_closed_form() {
    let disc = PI * 64.0;
    let ring = PI * (400.0 - 144.0);
    check(
        "extrude_two_regions",
        &[
            (
                disc * 3.0,
                2.0 * disc + 2.0 * PI * 8.0 * 3.0,
                [50.0, 0.0, -1.5],
                [42.0, -8.0, -3.0],
                [58.0, 8.0, 0.0],
            ),
            (
                ring * 3.0,
                2.0 * ring + 2.0 * PI * (20.0 + 12.0) * 3.0,
                [0.0, 0.0, -1.5],
                [-20.0, -20.0, -3.0],
                [20.0, 20.0, 0.0],
            ),
        ],
    );
}

#[test]
fn solid_cylinder_revolve_matches_closed_form() {
    check(
        "revolve_solid_cylinder",
        &[(
            PI * 100.0 * 30.0,
            800.0 * PI,
            [0.0, 0.0, 15.0],
            [-10.0, -10.0, 0.0],
            [10.0, 10.0, 30.0],
        )],
    );
}

#[test]
fn torus_revolve_matches_closed_form() {
    check(
        "revolve_torus",
        &[(
            2.0 * PI * PI * 15.0 * 16.0,
            4.0 * PI * PI * 15.0 * 4.0,
            [0.0, 0.0, 0.0],
            [-19.0, -19.0, -4.0],
            [19.0, 19.0, 4.0],
        )],
    );
}

#[test]
fn quarter_ring_revolve_matches_closed_form() {
    let v = PI / 4.0 * (32.0 * 32.0 - 20.0 * 20.0) * 6.0;
    let a =
        2.0 * 72.0 + PI / 4.0 * (32.0 * 32.0 - 20.0 * 20.0) * 2.0 + PI / 2.0 * (32.0 + 20.0) * 6.0;
    // Centroid of an annular sector of angle π/2: r̄ = (2/3)(R³ − r³)/(R² − r²)·sin(π/4)/(π/4).
    let rbar = 2.0 / 3.0 * (32f64.powi(3) - 20f64.powi(3)) / (32.0 * 32.0 - 20.0 * 20.0);
    let cxy = rbar * (0.5f64).sqrt() / (PI / 4.0) * (0.5f64).sqrt();
    check(
        "revolve_partial_ring",
        &[(v, a, [cxy, cxy, 3.0], [0.0, 0.0, 0.0], [32.0, 32.0, 6.0])],
    );
}

#[test]
fn cone_sphere_revolve_matches_closed_form() {
    let v = PI * 100.0 * 20.0 / 3.0 + 2.0 / 3.0 * PI * 1000.0;
    let a = PI * 10.0 * (100.0f64 + 400.0).sqrt() + 2.0 * PI * 100.0;
    // Cone centroid at 20/4 above the base, hemisphere centroid 3r/8 below.
    let cz = (PI * 100.0 * 20.0 / 3.0 * 5.0 - 2.0 / 3.0 * PI * 1000.0 * 3.75) / v;
    check(
        "revolve_cone_sphere",
        &[(
            v,
            a,
            [0.0, 0.0, cz],
            [-10.0, -10.0, -10.0],
            [10.0, 10.0, 20.0],
        )],
    );
}

#[test]
fn inward_orientation_is_reported() {
    use forge_core::geom::{Sphere, Surface};
    use forge_core::linalg::Frame;
    use forge_core::topo::{BodyBuilder, Provenance};
    let mut b = BodyBuilder::new();
    let shell = b.add_shell(true);
    let s = Sphere::new(Frame::world(), 2.0).expect("sphere");
    b.add_face(
        shell,
        Surface::Sphere(s),
        false,
        Provenance::side("ball", "a"),
    )
    .expect("face");
    let body = b.finish();
    let codes: Vec<String> = errors(&validate(&body))
        .iter()
        .map(|i| i.code.clone())
        .collect();
    assert_eq!(codes, ["NEGATIVE_VOLUME"]);
    let mp = mass_properties(&body).expect("mass");
    assert!(rel(mp.volume, -4.0 / 3.0 * PI * 8.0) < 1e-13);
    assert!(!body_metrics(&body).expect("metrics").valid);
}

#[test]
fn missing_pcurves_are_reported_not_guessed() {
    use forge_core::geom::{Circle3, Curve3, Cylinder, Plane, Surface};
    use forge_core::linalg::{Frame, Vec3};
    use forge_core::topo::{BodyBuilder, Provenance};
    // The reference cylinder without pcurves.
    let top = Frame::world().with_origin(Vec3::new(0.0, 0.0, 3.0));
    let mut b = BodyBuilder::new();
    let e0 = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), 1.0).expect("c")),
            Provenance::new("cyl", forge_core::topo::Role::EdgeBetween)
                .with_sources(["cyl/cap:start", "cyl/side:c"]),
        )
        .expect("ring");
    let e1 = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(top, 1.0).expect("c")),
            Provenance::new("cyl", forge_core::topo::Role::EdgeBetween)
                .with_sources(["cyl/cap:end", "cyl/side:c"]),
        )
        .expect("ring");
    let shell = b.add_shell(true);
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(Frame::world())),
            false,
            Provenance::cap_start("cyl"),
        )
        .expect("face");
    b.add_loop(f, &[(e0, false)]).expect("loop");
    let f = b
        .add_face(
            shell,
            Surface::Plane(Plane::new(top)),
            true,
            Provenance::cap_end("cyl"),
        )
        .expect("face");
    b.add_loop(f, &[(e1, true)]).expect("loop");
    let cyl = Cylinder::new(Frame::world(), 1.0).expect("cyl");
    let f = b
        .add_face(
            shell,
            Surface::Cylinder(cyl),
            true,
            Provenance::side("cyl", "c"),
        )
        .expect("face");
    b.add_loop(f, &[(e0, true)]).expect("loop");
    b.add_loop(f, &[(e1, false)]).expect("loop");
    let body = b.finish();
    assert!(forge_core::topo::validate(&body).is_empty());
    let e = mass_properties(&body).unwrap_err();
    assert_eq!(e.code(), "FORGE_MISSING_PCURVE");
    let codes: Vec<String> = errors(&validate(&body))
        .iter()
        .map(|i| i.code.clone())
        .collect();
    assert_eq!(codes, ["FORGE_MISSING_PCURVE"]);
}

/// The reference cylinder (radius 2, height 5), optionally with the side face's `sense`
/// flipped while its loops stay: the loops then run against the orientation the sense
/// implies. The side's volume contribution is unchanged (sense and domain orientation
/// both flip), so only the per-face domain-area check can see it (audit M1).
fn cylinder_with_side_sense(side_sense: bool) -> Body {
    use forge_core::geom::{Circle2, Circle3, Curve2, Curve3, Cylinder, Line2, Plane, Surface};
    use forge_core::linalg::{Frame, Vec2, Vec3};
    use forge_core::topo::{BodyBuilder, LoopId, Provenance};
    let (r, h) = (2.0, 5.0);
    let top = Frame::world().with_origin(Vec3::new(0.0, 0.0, h));
    let (cs, ce, side) = (
        Provenance::cap_start("cyl"),
        Provenance::cap_end("cyl"),
        Provenance::side("cyl", "c"),
    );
    let mut b = BodyBuilder::new();
    let e0 = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(Frame::world(), r).expect("c")),
            Provenance::edge_between("cyl", cs.name(), side.name()),
        )
        .expect("ring");
    let e1 = b
        .add_ring_edge(
            Curve3::Circle(Circle3::new(top, r).expect("c")),
            Provenance::edge_between("cyl", ce.name(), side.name()),
        )
        .expect("ring");
    let set = |b: &mut BodyBuilder, l: LoopId, pc: Curve2| {
        let cid = b.body().loop_(l).expect("loop").coedges[0];
        b.set_pcurve(cid, pc).expect("pcurve");
    };
    let disc = || Curve2::Circle(Circle2::new(Vec2::zero(), r).expect("c"));
    let shell = b.add_shell(true);
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(Frame::world())), false, cs)
        .expect("face");
    let l = b.add_loop(f, &[(e0, false)]).expect("loop");
    set(&mut b, l, disc());
    let f = b
        .add_face(shell, Surface::Plane(Plane::new(top)), true, ce)
        .expect("face");
    let l = b.add_loop(f, &[(e1, true)]).expect("loop");
    set(&mut b, l, disc());
    let cyl = Cylinder::new(Frame::world(), r).expect("cyl");
    let f = b
        .add_face(shell, Surface::Cylinder(cyl), side_sense, side)
        .expect("face");
    let l = b.add_loop(f, &[(e0, true)]).expect("loop");
    set(
        &mut b,
        l,
        Curve2::Line(Line2::new(Vec2::zero(), Vec2::unit_x()).expect("l")),
    );
    let l = b.add_loop(f, &[(e1, false)]).expect("loop");
    set(
        &mut b,
        l,
        Curve2::Line(Line2::new(Vec2::new(0.0, h), Vec2::unit_x()).expect("l")),
    );
    b.finish()
}

#[test]
fn inverted_face_domain_is_reported() {
    let good = cylinder_with_side_sense(true);
    assert!(errors(&validate(&good)).is_empty());
    let bad = cylinder_with_side_sense(false);
    assert!(forge_core::topo::validate(&bad).is_empty());
    // The signed volume alone looks fine …
    let mp = mass_properties(&bad).expect("mass");
    assert!(rel(mp.volume, PI * 4.0 * 5.0) < 1e-13, "{mp:?}");
    // … but the side face's domain area is −2π·2·5: its loops are inverted.
    let issues = validate(&bad);
    let errs = errors(&issues);
    assert_eq!(errs.len(), 1, "{issues:#?}");
    assert_eq!(errs[0].code, "FORGE_FACE_AREA_NOT_POSITIVE");
    assert_eq!(errs[0].entity.as_deref(), Some("cyl/side:c"));
    assert!(!body_metrics(&bad).expect("metrics").valid);
}

#[test]
fn cavity_shells_must_point_into_the_void() {
    use forge_core::geom::{Sphere, Surface};
    use forge_core::linalg::Frame;
    use forge_core::topo::{BodyBuilder, Provenance};
    let hollow = |cavity_sense: bool| {
        let mut b = BodyBuilder::new();
        for (i, (r, sense)) in [(3.0, true), (1.0, cavity_sense)].into_iter().enumerate() {
            let shell = b.add_shell(true);
            b.add_face(
                shell,
                Surface::Sphere(Sphere::new(Frame::world(), r).expect("sphere")),
                sense,
                Provenance::side("ball", format!("s{i}")),
            )
            .expect("face");
        }
        b.finish()
    };
    let good = hollow(false);
    assert!(errors(&validate(&good)).is_empty());
    let v = mass_properties(&good).expect("mass").volume;
    assert!(rel(v, 4.0 / 3.0 * PI * (27.0 - 1.0)) < 1e-13);
    // A cavity oriented like an outer shell: V_outer + V_cavity is positive, so only the
    // per-shell orientation check (audit M1) sees it.
    let bad = hollow(true);
    let issues = validate(&bad);
    let errs = errors(&issues);
    assert_eq!(errs.len(), 1, "{issues:#?}");
    assert_eq!(errs[0].code, "FORGE_SHELL_ORIENTATION");
    assert_eq!(errs[0].entity.as_deref(), Some("shell 1 (ball/side:s1)"));
}

/// A body of loop-less sphere and torus shells: `(surface, sense)` per shell, in order.
fn closed_shells(shells: Vec<(forge_core::geom::Surface, bool)>) -> Body {
    use forge_core::topo::{BodyBuilder, Provenance};
    let mut b = BodyBuilder::new();
    for (i, (surface, sense)) in shells.into_iter().enumerate() {
        let shell = b.add_shell(true);
        b.add_face(
            shell,
            surface,
            sense,
            Provenance::side("lump", format!("s{i}")),
        )
        .expect("face");
    }
    b.finish()
}

fn ball(r: f64) -> forge_core::geom::Surface {
    use forge_core::geom::{Sphere, Surface};
    Surface::Sphere(Sphere::new(forge_core::linalg::Frame::world(), r).expect("sphere"))
}

#[test]
fn a_lump_in_the_hole_of_a_ring_is_not_a_cavity() {
    // Audit M1 review: a ball of radius 2.5 in the hole of a ring torus (R = 10, r = 3) is
    // a second lump, not a cavity, although its box lies inside the ring's box. With the
    // box heuristic the correct body was rejected and the inverted ball passed with the
    // volume V_ring − V_ball.
    use forge_core::geom::{Surface, Torus};
    use forge_core::linalg::Frame;
    let ring = || Surface::Torus(Torus::new(Frame::world(), 10.0, 3.0).expect("torus"));
    let (v_ring, v_ball) = (2.0 * PI * PI * 10.0 * 9.0, 4.0 / 3.0 * PI * 2.5f64.powi(3));

    let good = closed_shells(vec![(ring(), true), (ball(2.5), true)]);
    let issues = validate(&good);
    assert!(errors(&issues).is_empty(), "{issues:#?}");
    assert!(
        rel(
            mass_properties(&good).expect("mass").volume,
            v_ring + v_ball
        ) < 1e-13
    );
    assert!(body_metrics(&good).expect("metrics").valid);

    let bad = closed_shells(vec![(ring(), true), (ball(2.5), false)]);
    // The total alone looks like a solid …
    assert!(rel(mass_properties(&bad).expect("mass").volume, v_ring - v_ball) < 1e-13);
    // … but the ball is an outer shell that points inwards.
    let issues = validate(&bad);
    let errs = errors(&issues);
    assert_eq!(errs.len(), 1, "{issues:#?}");
    assert_eq!(errs[0].code, "FORGE_SHELL_ORIENTATION");
    assert_eq!(errs[0].entity.as_deref(), Some("shell 1 (lump/side:s1)"));
    assert!(
        errs[0].message.contains("inside 0 other shell"),
        "{}",
        errs[0]
    );
    assert!(!body_metrics(&bad).expect("metrics").valid);

    // Same with the ring listed second and the ball off the axis (still in the hole).
    let off = || {
        Surface::Sphere(
            forge_core::geom::Sphere::new(
                Frame::world().with_origin(forge_core::linalg::Vec3::new(1.5, -2.0, 0.25)),
                2.5,
            )
            .expect("sphere"),
        )
    };
    assert!(
        errors(&validate(&closed_shells(vec![
            (off(), true),
            (ring(), true)
        ])))
        .is_empty()
    );
    let issues = validate(&closed_shells(vec![(off(), false), (ring(), true)]));
    let codes: Vec<_> = errors(&issues).iter().map(|i| i.code.clone()).collect();
    assert_eq!(codes, ["FORGE_SHELL_ORIENTATION"], "{issues:#?}");

    // A ball inside the tube is a cavity of the ring, at any azimuth around it.
    for (k, phi) in [0.3f64, 2.0, 4.1].into_iter().enumerate() {
        let (s, c) = forge_core::math::sin_cos(phi);
        let tube = || {
            Surface::Sphere(
                forge_core::geom::Sphere::new(
                    Frame::world().with_origin(forge_core::linalg::Vec3::new(
                        10.0 * c,
                        10.0 * s,
                        0.5,
                    )),
                    1.5,
                )
                .expect("sphere"),
            )
        };
        let issues = validate(&closed_shells(vec![(ring(), true), (tube(), false)]));
        assert!(errors(&issues).is_empty(), "{k}: {issues:#?}");
        let issues = validate(&closed_shells(vec![(tube(), true), (ring(), true)]));
        let errs = errors(&issues);
        assert_eq!(errs.len(), 1, "{k}: {issues:#?}");
        assert!(
            errs[0].message.starts_with("cavity shell (inside 1"),
            "{}",
            errs[0]
        );
        assert_eq!(errs[0].entity.as_deref(), Some("shell 0 (lump/side:s0)"));
    }
}

#[test]
fn an_island_inside_a_cavity_is_a_lump() {
    // Three concentric shells: outer (+), cavity (−), island (+). The island lies inside
    // two shells (even depth), so it must enclose positive volume.
    let body = |senses: [bool; 3]| {
        closed_shells(vec![
            (ball(10.0), senses[0]),
            (ball(6.0), senses[1]),
            (ball(3.0), senses[2]),
        ])
    };
    let good = body([true, false, true]);
    let issues = validate(&good);
    assert!(errors(&issues).is_empty(), "{issues:#?}");
    let v = mass_properties(&good).expect("mass").volume;
    assert!(rel(v, 4.0 / 3.0 * PI * (1000.0 - 216.0 + 27.0)) < 1e-13);

    for (senses, bad_shell) in [
        ([true, false, false], "shell 2 (lump/side:s2)"),
        ([true, true, true], "shell 1 (lump/side:s1)"),
    ] {
        let issues = validate(&body(senses));
        let errs = errors(&issues);
        assert_eq!(errs.len(), 1, "{senses:?}: {issues:#?}");
        assert_eq!(errs[0].code, "FORGE_SHELL_ORIENTATION");
        assert_eq!(errs[0].entity.as_deref(), Some(bad_shell));
    }
}

/// The bodies of a one-sketch, one-extrude document with the given sketch plane (IR JSON)
/// and curves.
fn extruded(name: &str, plane: &str, curves: &str, distance: f64) -> Body {
    let json = format!(
        r#"{{"schema":"aicad.ir/0","meta":{{"name":"{name}"}},"parts":[{{"id":"p1",
        "name":"part","features":[{{"type":"sketch","id":"s1","name":"{name}_sketch",
        "plane":{plane},"curves":{curves}}},{{"type":"extrude","id":"e1","name":"{name}",
        "sketch":"{name}_sketch","distance":{distance:?}}}]}}]}}"#
    );
    let doc: Document = forge_ir::from_json(&json).expect("valid IR");
    let feats = &doc.parts[0].features;
    let (Feature::Sketch(sk), Feature::Extrude(e)) = (&feats[0], &feats[1]) else {
        panic!("sketch + extrude")
    };
    let frame = sketch_frame(&sk.plane).expect("frame");
    let mut bodies: Vec<Body> = regions(sk, &Tolerance::IR_DEFAULT)
        .expect("regions")
        .iter()
        .map(|r| extrude(r, &frame, e.distance, e.direction, &e.name).expect("extrude"))
        .collect();
    assert_eq!(bodies.len(), 1);
    bodies.pop().expect("body")
}

/// A closed polyline through `pts` as sketch lines with ids `{tag}0, {tag}1, …`.
fn polyline(tag: &str, pts: &[(f64, f64)]) -> Vec<String> {
    (0..pts.len())
        .map(|i| {
            let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
            format!(
                r#"{{"kind":"line","id":"{tag}{i}","start":[{:?},{:?}],"end":[{:?},{:?}]}}"#,
                a.0, a.1, b.0, b.1
            )
        })
        .collect()
}

fn square(tag: &str, h: f64) -> Vec<String> {
    polyline(tag, &[(-h, -h), (h, -h), (h, h), (-h, h)])
}

/// One body holding the shells of `parts`; an inverted part has every face sense flipped
/// and every loop reversed (a consistently inside-out shell, which `forge_core` accepts).
fn merged(parts: Vec<(Body, bool)>) -> Body {
    use forge_core::topo::BodyBuilder;
    use std::collections::BTreeMap;
    let mut b = BodyBuilder::new();
    for (src, invert) in parts {
        let mut vmap = BTreeMap::new();
        for (vid, v) in src.vertices().iter() {
            vmap.insert(
                vid,
                b.add_vertex(v.point, v.provenance.clone()).expect("vertex"),
            );
        }
        let mut emap = BTreeMap::new();
        for (eid, e) in src.edges().iter() {
            let ne = match (e.start, e.end) {
                (Some(s), Some(t)) => b.add_edge(
                    e.curve.clone(),
                    e.t_range,
                    vmap[&s],
                    vmap[&t],
                    e.provenance.clone(),
                ),
                _ => b.add_ring_edge_with_range(e.curve.clone(), e.t_range, e.provenance.clone()),
            };
            emap.insert(eid, ne.expect("edge"));
        }
        for &sid in src.shell_ids() {
            let sh = src.shell(sid).expect("shell");
            let nsh = b.add_shell(sh.closed);
            for &fid in &sh.faces {
                let f = src.face(fid).expect("face");
                let nf = b
                    .add_face(
                        nsh,
                        f.surface.clone(),
                        f.sense != invert,
                        f.provenance.clone(),
                    )
                    .expect("face");
                for &lid in &f.loops {
                    let mut uses: Vec<_> = src
                        .loop_(lid)
                        .expect("loop")
                        .coedges
                        .iter()
                        .map(|&c| {
                            let c = src.coedge(c).expect("coedge");
                            (emap[&c.edge], c.forward, c.pcurve.clone())
                        })
                        .collect();
                    if invert {
                        uses.reverse();
                        for u in &mut uses {
                            u.1 = !u.1;
                        }
                    }
                    let pairs: Vec<_> = uses.iter().map(|u| (u.0, u.1)).collect();
                    let nl = b.add_loop(nf, &pairs).expect("loop");
                    let cids = b.body().loop_(nl).expect("new loop").coedges.clone();
                    for (cid, u) in cids.into_iter().zip(uses) {
                        b.set_pcurve(cid, u.2.expect("pcurve")).expect("set pcurve");
                    }
                }
            }
        }
    }
    b.finish()
}

#[test]
fn a_block_in_the_hole_of_a_square_frame_is_not_a_cavity() {
    // Planar/looped version of the ring case: a 10×10×2 frame with a 6×6 hole, and a
    // 2×2×1 block in the hole at mid-height (its box lies inside the frame's box).
    let frame_curves = format!(
        "[{}]",
        [square("o", 5.0), square("i", 3.0)].concat().join(",")
    );
    let frame = || extruded("rim", r#""XY""#, &frame_curves, 2.0);
    let block_plane = r#"{"origin":[0,0,0.5],"normal":[0,0,1],"x_dir":[1,0,0]}"#;
    let block_curves = format!("[{}]", square("b", 1.0).join(","));
    let block = || extruded("plug", block_plane, &block_curves, 1.0);

    let good = merged(vec![(frame(), false), (block(), false)]);
    let issues = validate(&good);
    assert!(errors(&issues).is_empty(), "{issues:#?}");
    assert!(
        rel(
            mass_properties(&good).expect("mass").volume,
            64.0 * 2.0 + 4.0
        ) < 1e-13
    );

    let bad = merged(vec![(frame(), false), (block(), true)]);
    assert!(
        rel(
            mass_properties(&bad).expect("mass").volume,
            64.0 * 2.0 - 4.0
        ) < 1e-13
    );
    let issues = validate(&bad);
    let errs = errors(&issues);
    assert_eq!(errs.len(), 1, "{issues:#?}");
    assert_eq!(errs[0].code, "FORGE_SHELL_ORIENTATION");
    assert!(errs[0].message.contains("outer shell"), "{}", errs[0]);
}

#[test]
fn a_box_cavity_must_point_into_the_void() {
    // A 10×10×10 box with a 2×2×2 box cavity: the planar, looped counterpart of the
    // concentric balls (the cavity's faces are trimmed planes).
    let outer_curves = format!("[{}]", square("o", 5.0).join(","));
    let outer = || extruded("shell_box", r#""XY""#, &outer_curves, 10.0);
    let void_plane = r#"{"origin":[0.5,-0.25,4],"normal":[0,0,1],"x_dir":[1,0,0]}"#;
    let void_curves = format!("[{}]", square("v", 1.0).join(","));
    let void = || extruded("hollow", void_plane, &void_curves, 2.0);

    let good = merged(vec![(outer(), false), (void(), true)]);
    let issues = validate(&good);
    assert!(errors(&issues).is_empty(), "{issues:#?}");
    assert!(rel(mass_properties(&good).expect("mass").volume, 1000.0 - 8.0) < 1e-13);

    let bad = merged(vec![(outer(), false), (void(), false)]);
    let issues = validate(&bad);
    let errs = errors(&issues);
    assert_eq!(errs.len(), 1, "{issues:#?}");
    assert_eq!(errs[0].code, "FORGE_SHELL_ORIENTATION");
    assert!(
        errs[0].message.contains("cavity shell (inside 1 other"),
        "{}",
        errs[0]
    );
}
