//! Spindle-torus patches (`minor > major`): construction, parameter ranges, normals,
//! projection, and a loop-less patch face that validates as a sphere-like shell.

use forge_core::geom::{Surface, Torus};
use forge_core::math::{self, TAU};
use forge_core::topo::{BodyBuilder, Provenance, euler_summary, validate};
use forge_core::{Frame, SpindlePatch, Vec3};
use proptest::prelude::*;

fn tilted() -> Frame {
    Frame::from_normal_x(
        Vec3::new(1.0, -2.0, 0.5),
        Vec3::new(0.2, 0.3, 1.0),
        Vec3::new(1.0, 0.0, 0.0),
    )
    .expect("frame")
}

fn patches(frame: Frame, major: f64, minor: f64) -> [Torus; 2] {
    [
        Torus::spindle(frame, major, minor, SpindlePatch::Outer).expect("outer"),
        Torus::spindle(frame, major, minor, SpindlePatch::Inner).expect("inner"),
    ]
}

#[test]
fn spindle_constructor_requires_minor_greater_than_major() {
    let f = Frame::world();
    for (major, minor) in [(2.0, 2.0), (3.0, 1.0), (0.0, 1.0), (1.0, f64::NAN)] {
        let e = Torus::spindle(f, major, minor, SpindlePatch::Outer).unwrap_err();
        assert_eq!(e.code(), "GEOM_INVALID_PARAMETER", "({major}, {minor})");
    }
    // Ring and horn tori are unchanged and still reject minor > major.
    assert!(Torus::new(f, 1.0, 2.0).is_err());
    let ring = Torus::new(f, 3.0, 1.0).expect("ring");
    assert_eq!(ring.spindle_patch(), None);
    assert_eq!(ring.spindle_v_range(), None);
    assert_eq!(Surface::from(ring).periodicity(), (Some(TAU), Some(TAU)));
}

#[test]
fn spindle_patch_ranges_end_on_the_axis() {
    let [outer, inner] = patches(Frame::world(), 3.0, 5.0);
    let vs = math::acos(-3.0 / 5.0);
    let (a, b) = outer.spindle_v_range().expect("outer range");
    assert!((a + vs).abs() < 1e-15 && (b - vs).abs() < 1e-15);
    let (c, d) = inner.spindle_v_range().expect("inner range");
    assert!((c - vs).abs() < 1e-15 && (d - (TAU - vs)).abs() < 1e-15);
    for t in [outer, inner] {
        let s = Surface::from(t);
        assert_eq!(s.periodicity(), (Some(TAU), None));
        let (_, (v0, v1)) = s.domain();
        for v in [v0, v1] {
            // Both ends are the axis points (0, 0, ±4): S_u vanishes there.
            let p = s.eval(0.7, v);
            assert!(math::hypot(p.x, p.y) < 1e-12, "{p:?}");
            assert!((p.z.abs() - 4.0).abs() < 1e-12);
            assert!(s.du(0.7, v).norm() < 1e-12);
        }
        assert!(s.is_closed_without_boundary());
    }
}

proptest! {
    #[test]
    fn spindle_normals_follow_su_cross_sv(
        major in 0.5..4.0f64,
        extra in 0.1..3.0f64,
        a in 0.0..1.0f64,
        b in 0.02..0.98f64,
    ) {
        let minor = major + extra;
        for t in patches(tilted(), major, minor) {
            let s = Surface::from(t);
            let (_, (v0, v1)) = s.domain();
            let (u, v) = (TAU * a, v0 + (v1 - v0) * b);
            let [_, du, dv] = s.derivs1(u, v);
            let n = s.normal(u, v).expect("normal");
            prop_assert!((n.norm() - 1.0).abs() < 1e-14);
            let cr = du.cross(dv).normalize().expect("regular inside the patch");
            prop_assert!((n - cr).norm() < 1e-12, "{:?}: {n:?} vs {cr:?}", t.spindle_patch());
        }
    }

    #[test]
    fn spindle_projection_round_trips_inside_the_patch(
        major in 0.5..4.0f64,
        extra in 0.1..3.0f64,
        a in 0.0..1.0f64,
        b in 0.02..0.98f64,
    ) {
        let minor = major + extra;
        for t in patches(tilted(), major, minor) {
            let s = Surface::from(t);
            let (_, (v0, v1)) = s.domain();
            let (u, v) = (TAU * a, v0 + (v1 - v0) * b);
            let p = s.eval(u, v);
            let (up, vp, d) = s.project(p);
            prop_assert!(d < 1e-9, "{:?}: d = {d}", t.spindle_patch());
            prop_assert!(s.eval(up, vp).distance(p) < 1e-9);
            prop_assert!(vp >= v0 - 1e-9 && vp <= v1 + 1e-9, "{vp} not in [{v0}, {v1}]");
        }
    }
}

#[test]
fn loopless_spindle_patch_face_is_a_sphere_like_shell() {
    let t = Torus::spindle(Frame::world(), 3.0, 5.0, SpindlePatch::Outer).expect("apple");
    let mut b = BodyBuilder::new();
    let shell = b.add_shell(true);
    b.add_face(
        shell,
        Surface::Torus(t),
        true,
        Provenance::side("apple", "arc"),
    )
    .expect("face");
    let body = b.finish();
    let issues = validate(&body);
    assert!(issues.is_empty(), "{issues:#?}");
    let eu = euler_summary(&body, body.shell_ids()[0]).expect("shell");
    assert_eq!((eu.face_genus, eu.chi, eu.genus()), (0, 2, Some(0)));
}
