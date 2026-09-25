//! STEP export of the hand-built sample bodies: structure, determinism (golden bytes),
//! names, colours, schemas, refusals, and the verifier's own negative cases.

use forge_core::topo::samples;
use forge_io::step::parse::{Instance, Value, parse};
use forge_io::step::{StepBody, StepOptions, StepSchema, verify_step, write_step};
use proptest::prelude::*;

fn export(name: &str, body: &forge_core::topo::Body) -> (String, forge_io::StepReport) {
    let (bytes, report) = write_step(
        &[StepBody {
            name,
            body,
            color: None,
        }],
        &StepOptions::default(),
    )
    .unwrap_or_else(|e| panic!("{name}: {} {e}", e.code()));
    (String::from_utf8(bytes).expect("ascii"), report)
}

#[test]
fn a_cube_exports_as_six_planar_faces() {
    let (text, r) = export("cube", &samples::unit_cube());
    let b = &r.bodies[0];
    assert_eq!((b.faces, b.edges, b.vertices, b.seam_edges), (6, 12, 8, 0));
    assert_eq!(text.matches("PLANE(").count(), 6);
    let s = verify_step(text.as_bytes()).expect("verifies");
    assert_eq!(s.solids.len(), 1);
    assert_eq!(s.solids[0].edges, 12);
}

#[test]
fn a_cylinder_gets_one_seam_and_ring_vertices() {
    let (text, r) = export("cyl", &samples::cylinder(10.0, 30.0));
    let b = &r.bodies[0];
    assert_eq!(
        (b.faces, b.edges, b.vertices, b.seam_edges),
        (3, 3, 2, 1),
        "{text}"
    );
    let s = verify_step(text.as_bytes()).expect("verifies");
    assert_eq!(s.solids[0].seam_edges, 1);
}

#[test]
fn a_sphere_gets_a_pole_to_pole_seam() {
    let (text, r) = export("ball", &samples::sphere(5.0));
    let b = &r.bodies[0];
    assert_eq!(
        (b.faces, b.edges, b.vertices, b.seam_edges),
        (1, 1, 2, 1),
        "{text}"
    );
    verify_step(text.as_bytes()).expect("verifies");
}

/// Golden bytes: any change to the writer's output is deliberate (regenerate with
/// `STEP_GOLDEN_UPDATE=1 cargo test -p forge-io --test step_samples`).
#[test]
fn the_cylinder_file_matches_its_golden_bytes() {
    let (text, _) = export("cylinder", &samples::cylinder(10.0, 30.0));
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/golden/cylinder.step");
    if std::env::var_os("STEP_GOLDEN_UPDATE").is_some() {
        std::fs::create_dir_all(path.parent().expect("dir")).expect("mkdir");
        std::fs::write(&path, &text).expect("write golden");
    }
    let golden = std::fs::read_to_string(&path).expect("golden file (STEP_GOLDEN_UPDATE=1)");
    assert_eq!(text, golden, "the STEP bytes changed");
}

#[test]
fn names_colours_and_schemas_are_written_as_asked() {
    let cube = samples::unit_cube();
    let ball = samples::sphere(2.0);
    let opts = StepOptions {
        schema: StepSchema::Ap242,
        product_name: "Klammer 'ü'".into(),
        ..StepOptions::default()
    };
    let (bytes, report) = write_step(
        &[
            StepBody {
                name: "Körper/1",
                body: &cube,
                color: Some([1.0, 0.5, 0.0]),
            },
            StepBody {
                name: "ball",
                body: &ball,
                color: None,
            },
        ],
        &opts,
    )
    .expect("writes");
    assert_eq!(report.bodies.len(), 2);
    let f = parse(&bytes).expect("parses");
    assert_eq!(
        f.schemas(),
        vec!["AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }"]
    );
    let names: Vec<String> = f
        .data
        .values()
        .filter_map(|i| i.record("MANIFOLD_SOLID_BREP"))
        .filter_map(|r| r.args[0].as_str().map(str::to_string))
        .collect();
    assert_eq!(names, vec!["Körper/1", "ball"]);
    let product = f
        .data
        .values()
        .find_map(|i| i.record("PRODUCT"))
        .expect("product");
    assert_eq!(product.args[1], Value::Str("Klammer 'ü'".into()));
    let rgb: Vec<&Instance> = f
        .data
        .values()
        .filter(|i| i.record("COLOUR_RGB").is_some())
        .collect();
    assert_eq!(rgb.len(), 1, "one coloured body");
    let styled = f
        .data
        .values()
        .filter(|i| i.record("STYLED_ITEM").is_some())
        .count();
    assert_eq!(styled, 1);
    let s = verify_step(&bytes).expect("verifies");
    assert_eq!(s.solids.len(), 2);
}

#[test]
fn refusals_carry_stable_codes() {
    let cube = samples::unit_cube();
    let e = write_step(&[], &StepOptions::default()).expect_err("no bodies");
    assert_eq!(e.code(), "STEP_NO_BODIES");
    let e = write_step(
        &[StepBody {
            name: "c",
            body: &cube,
            color: Some([1.5, 0.0, 0.0]),
        }],
        &StepOptions::default(),
    )
    .expect_err("bad colour");
    assert_eq!(e.code(), "STEP_INVALID_OPTIONS");
    let io: forge_io::IoError = e.into();
    assert_eq!(io.code(), "STEP_INVALID_OPTIONS");
}

/// The verifier is what stands between a writer bug and a bad file: it must catch broken
/// topology and geometry.
#[test]
fn the_verifier_rejects_broken_files() {
    let (text, _) = export("cube", &samples::unit_cube());
    verify_step(text.as_bytes()).expect("the original verifies");

    // A vertex moved off its edges.
    let first_vertex_point = text
        .lines()
        .find(|l| l.contains("VERTEX_POINT"))
        .and_then(|l| l.split('#').nth(2))
        .and_then(|s| s.split(')').next())
        .expect("a vertex point")
        .to_string();
    let moved = text
        .lines()
        .map(|l| {
            if l.starts_with(&format!("#{first_vertex_point}=CARTESIAN_POINT")) {
                format!("#{first_vertex_point}=CARTESIAN_POINT('',(0.25,0.,0.));")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let e = verify_step(moved.as_bytes()).expect_err("moved vertex");
    assert_eq!(e.code(), "STEP_SELF_CHECK", "{e}");

    // One oriented edge flipped: that edge is then used twice in the same direction.
    let first_oe = text
        .lines()
        .find(|l| l.contains("ORIENTED_EDGE") && l.contains(".T.)"))
        .expect("an oriented edge");
    let flipped = text.replacen(first_oe, &first_oe.replace(".T.)", ".F.)"), 1);
    let e = verify_step(flipped.as_bytes()).expect_err("flipped edge");
    assert!(
        e.to_string().contains("loop is not closed") || e.to_string().contains("used"),
        "{e}"
    );

    // A dangling reference (a vertex the edges use is gone).
    let vertex = text
        .lines()
        .find(|l| l.contains("=VERTEX_POINT("))
        .expect("a vertex");
    let dangling = text.replacen(vertex, "", 1);
    let e = verify_step(dangling.as_bytes()).expect_err("dangling");
    assert_eq!(e.code(), "STEP_SELF_CHECK");

    // Not millimetres.
    let inches = text.replace("SI_UNIT(.MILLI.,.METRE.)", "SI_UNIT($,.METRE.)");
    assert!(verify_step(inches.as_bytes()).is_err());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Any cylinder or sphere exports, verifies, and keeps Forge's counts plus exactly one
    /// seam; the bytes are a pure function of the input.
    #[test]
    fn random_cylinders_and_spheres_export_verify_and_are_deterministic(
        r in 0.01f64..500.0,
        h in 0.01f64..500.0,
    ) {
        let cyl = samples::cylinder(r, h);
        let (a, ra) = export("cyl", &cyl);
        let (b, _) = export("cyl", &cyl);
        prop_assert_eq!(&a, &b);
        prop_assert_eq!(ra.bodies[0].seam_edges, 1);
        prop_assert_eq!(ra.bodies[0].edges, 3);
        verify_step(a.as_bytes()).expect("cylinder verifies");
        let ball = samples::sphere(r);
        let (s, rs) = export("ball", &ball);
        prop_assert_eq!(rs.bodies[0].seam_edges, 1);
        verify_step(s.as_bytes()).expect("sphere verifies");
    }
}
