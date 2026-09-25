//! STEP export of the hand-built sample bodies.

use forge_core::topo::samples;
use forge_io::step::{StepBody, StepOptions, verify_step, write_step};

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
