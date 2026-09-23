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
