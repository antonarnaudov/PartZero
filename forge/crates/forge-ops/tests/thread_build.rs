//! Modelled threads built on hole walls and bosses: validity, exact volume and area against
//! the closed forms of the helical groove, tessellation at print quality, the end cases
//! (plane, cone, inside), handedness and starts, and the structured failures.
//!
//! # Closed forms (thread frame, `n` starts, pitch `P`, `w(r)` the groove width)
//! Every section of the thread across its axis is the same up to a rotation, so the groove
//! volume over a length `L` is `L · (2π/P) · ∫ r·w(r) dr` over `[R_c, R_r]`; a flank's area is
//! `(L/|p|) · ∫ √(v²(1 + k²) + p²) dv` (`p` the rise per radian, `k = tan 30°`); the root strip
//! covers `2π·w_root/P` of the root cylinder, the crest strip `2π·(1 − w(R_c)/P)` of the
//! crest cylinder; each end plane loses (or gains) `(2π/P)·∫ r·w(r) dr` of area.

use std::f64::consts::PI;

use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::{Body, FaceId, Role, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ir::v1::{HoleFeature, HolePlacement};
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::OpBody;
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::hole::{HoleSite, apply_hole, hole_positions, hole_spec, literal_hole};
use forge_ops::thread::{
    ThreadError, ThreadForm, ThreadKind, ThreadRequest, crest_faces, thread_face,
};
use serde_json::{Value, json};

fn rect(x0: f64, y0: f64, w: f64, h: f64) -> Vec<SketchCurve> {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    vec![
        l("b", [x0, y0], [x0 + w, y0]),
        l("r", [x0 + w, y0], [x0 + w, y0 + h]),
        l("t", [x0 + w, y0 + h], [x0, y0 + h]),
        l("l", [x0, y0 + h], [x0, y0]),
    ]
}

fn extruded(feature: &str, z0: f64, curves: Vec<SketchCurve>, h: f64) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(IrFrame {
                origin: [0.0, 0.0, z0],
                normal: [0.0, 0.0, 1.0],
                x_dir: [1.0, 0.0, 0.0],
            }),
            curves,
        },
        sweep: Sweep::Extrude {
            distance: h,
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("extrude")
}

fn ob(body: Body, feature: &str) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "b".into(),
            instance: None,
        },
        timeline: 0,
    }
}

fn cap_end(b: &Body) -> FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("end cap")
}

fn hole(fields: Value) -> HoleFeature {
    let mut v = json!({ "id": "h1", "name": "holes", "on": "XY" });
    for (k, x) in fields.as_object().expect("object") {
        v[k] = x.clone();
    }
    serde_json::from_value(v).expect("hole feature")
}

/// A 30 × 30 × `t` plate with one hole at the centre of its top face.
fn plate_with_hole(fields: Value, t: f64) -> Body {
    let plate = extruded("e1", 0.0, rect(-15.0, -15.0, 30.0, 30.0), t);
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, t));
    let lit = literal_hole(&hole(fields), |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    assert!(matches!(lit.at, HolePlacement::List(_)));
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = cap_end(&plate);
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&plate, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let out = apply_hole(&spec, &pos, &site, &[ob(plate.clone(), "e1")]).expect("hole");
    assert_eq!(out.op.bodies.len(), 1);
    out.op.bodies[0].body.clone()
}

fn at_centre(extra: Value) -> Value {
    let mut v = json!({ "at": { "list": [{ "id": "p", "at": [0.0, 0.0] }] } });
    for (k, x) in extra.as_object().expect("object") {
        v[k] = x.clone();
    }
    v
}

/// The thread frame of the centre hole of a plate of thickness `t`: origin on the top face,
/// `z` into the material.
fn hole_frame(t: f64) -> Frame {
    Frame::from_normal_x(
        Vec3::new(0.0, 0.0, t),
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::new(1.0, 0.0, 0.0),
    )
    .expect("frame")
}

fn form(kind: ThreadKind, major: f64, pitch: f64) -> ThreadForm {
    ThreadForm {
        kind,
        major,
        pitch,
        starts: 1,
        right_hand: true,
    }
}

fn thread(
    body: &Body,
    f: ThreadForm,
    frame: Frame,
    crest_r: f64,
    z: (f64, f64),
) -> Result<Body, ThreadError> {
    let faces = crest_faces(body, &frame, crest_r, z);
    assert_eq!(faces.len(), 1, "one crest face: {faces:?}");
    thread_face(
        body,
        faces[0].0,
        &ThreadRequest {
            form: f,
            frame,
            z_range: z,
            feature: "t1",
            qualifier: Some("p"),
        },
    )
}

fn valid(b: &Body) {
    let issues = forge_check::validate(b);
    assert!(
        issues.iter().all(|i| i.severity != Severity::Error),
        "invalid: {issues:?}"
    );
}

/// `∫ r·w(r) dr` over the groove, and `∫ √(v²(1 + k²) + p²) dv`.
fn groove_moment(f: &ThreadForm, rc: f64) -> f64 {
    let rr = f.root_radius();
    let (a, b) = if rr > rc { (rc, rr) } else { (rr, rc) };
    let n = 20_000;
    let h = (b - a) / n as f64;
    // Simpson: w is linear, so r·w is a quadratic: exact.
    let g = |r: f64| r * f.groove_width(r);
    (0..n)
        .map(|i| {
            let x0 = a + h * i as f64;
            h / 6.0 * (g(x0) + 4.0 * g(x0 + 0.5 * h) + g(x0 + h))
        })
        .sum()
}

fn flank_width_integral(f: &ThreadForm, rc: f64) -> f64 {
    let rr = f.root_radius();
    let (a, b) = if rr > rc { (rc, rr) } else { (rr, rc) };
    let k2 = 1.0 / 3.0;
    let p = f.rise();
    let aa = 1.0 + k2;
    let prim = |v: f64| {
        let s = (aa * v * v + p * p).sqrt();
        0.5 * v * s + p * p / (2.0 * aa.sqrt()) * (aa.sqrt() * v + s).ln()
    };
    prim(b) - prim(a)
}

fn close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * b.abs().max(1.0)
}

#[test]
fn m8_through_hole_matches_the_closed_forms() {
    let t = 10.0;
    let d = 6.647;
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": "through" })), t);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, t)).expect("thread");
    valid(&th);
    let rc = 0.5 * d;
    let mp = forge_check::mass_properties(&th).expect("mass");
    let groove = t * 2.0 * PI / f.pitch * groove_moment(&f, rc);
    let v_expected = 30.0 * 30.0 * t - PI * rc * rc * t - groove;
    assert!(
        close(mp.volume, v_expected, 1e-10),
        "{} vs {v_expected}",
        mp.volume
    );
    let rr = f.root_radius();
    let wc = f.groove_width(rc);
    let area_plate = 2.0 * 900.0 + 4.0 * 30.0 * t;
    let ends = 2.0 * (PI * rc * rc + 2.0 * PI / f.pitch * groove_moment(&f, rc));
    let crest = 2.0 * PI * rc * t * (1.0 - wc / f.pitch);
    let root = 2.0 * PI * rr * t * f.root_flat() / f.pitch;
    let flanks = 2.0 * t / f.rise().abs() * flank_width_integral(&f, rc);
    let a_expected = area_plate - ends + crest + root + flanks;
    assert!(
        close(mp.area, a_expected, 1e-10),
        "{} vs {a_expected}",
        mp.area
    );
    // The centroid stays on the plate's axis (x, y) within the rounding.
    assert!(mp.centroid[0].abs() < 1e-3 && mp.centroid[1].abs() < 1e-3);
    // Faces: the wall, two flanks, the root; the plate's two caps changed.
    let kinds: Vec<&str> = th.faces().values().map(|f| f.surface.kind_name()).collect();
    assert_eq!(kinds.iter().filter(|k| **k == "helicoid").count(), 2);
    let keys: Vec<String> = th.faces().values().map(|f| f.provenance.key()).collect();
    for k in [
        "t1/thread_upper@p",
        "t1/thread_lower@p",
        "t1/thread_root@p",
        "h1/wall@p",
    ] {
        assert!(keys.iter().any(|x| x == k), "{k} in {keys:?}");
    }
}

#[test]
fn threads_tessellate_watertight_at_print_quality() {
    let t = 6.0;
    let d = 6.8; // the ISO 2306 tap drill: a wider crest
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": "through" })), t);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, t)).expect("thread");
    let params = forge_mesh::TessParams::new(0.01, 5f64.to_radians());
    let mesh = forge_mesh::tessellate(&th, &params).expect("mesh");
    forge_mesh::check_watertight(&mesh).expect("watertight");
    let dev = forge_mesh::max_deviation(&th, &mesh).expect("deviation");
    assert!(dev <= 0.01, "deviation {dev}");
    let v = forge_check::mass_properties(&th).expect("mass").volume;
    let vm = forge_mesh::mesh_volume(&mesh);
    assert!((vm - v).abs() < 1e-3 * v, "{vm} vs {v}");
}

/// The groove volume of a thread of length `l` on crest radius `rc`.
fn groove_volume(f: &ThreadForm, rc: f64, l: f64) -> f64 {
    l * 2.0 * PI / f.pitch * groove_moment(f, rc)
}

fn volume(b: &Body) -> f64 {
    valid(b);
    forge_check::mass_properties(b).expect("mass").volume
}

fn mesh_ok(b: &Body) {
    let params = forge_mesh::TessParams::new(0.01, 5f64.to_radians());
    let mesh = forge_mesh::tessellate(b, &params).expect("mesh");
    forge_mesh::check_watertight(&mesh).expect("watertight");
    let dev = forge_mesh::max_deviation(b, &mesh).expect("deviation");
    assert!(dev <= 0.01, "deviation {dev}");
}

#[test]
fn a_blind_flat_floor_gains_the_groove_sections() {
    // Thread to the floor: the floor plane grows into the groove (a plane end on the
    // inside of the circle).
    let (t, h, d) = (12.0, 8.0, 6.647);
    let body = plate_with_hole(
        at_centre(json!({ "d": d, "depth": { "blind": h }, "tip": "flat" })),
        t,
    );
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, h)).expect("thread");
    let rc = 0.5 * d;
    let v = 900.0 * t - PI * rc * rc * h - groove_volume(&f, rc, h);
    assert!(close(volume(&th), v, 1e-10), "{} vs {v}", volume(&th));
    mesh_ok(&th);
}

#[test]
fn a_thread_ending_at_a_drill_point_closes_its_groove_with_an_end_face() {
    let (t, h, d) = (12.0, 8.0, 6.8);
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": { "blind": h } })), t);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, h)).expect("thread");
    let rc = 0.5 * d;
    let tip_h = rc / (59f64.to_radians()).tan();
    let v = 900.0 * t - PI * rc * rc * h - PI * rc * rc * tip_h / 3.0 - groove_volume(&f, rc, h);
    assert!(close(volume(&th), v, 1e-9), "{} vs {v}", volume(&th));
    let keys: Vec<String> = th.faces().values().map(|f| f.provenance.key()).collect();
    assert!(keys.iter().any(|k| k == "t1/thread_end_end@p"), "{keys:?}");
    mesh_ok(&th);
}

#[test]
fn a_thread_shorter_than_the_bore_ends_inside_it() {
    let (t, d, l) = (10.0, 6.647, 4.0);
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": "through" })), t);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, l)).expect("thread");
    let rc = 0.5 * d;
    let v = 900.0 * t - PI * rc * rc * t - groove_volume(&f, rc, l);
    assert!(close(volume(&th), v, 1e-10), "{} vs {v}", volume(&th));
    mesh_ok(&th);
    // Ending at the far end of the bore instead (the thread starts inside, at the exit).
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (5.5, t)).expect("thread");
    let v = 900.0 * t - PI * rc * rc * t - groove_volume(&f, rc, 4.5);
    assert!(close(volume(&th), v, 1e-10), "{} vs {v}", volume(&th));
    mesh_ok(&th);
    // Two starts ending inside: the plain bore joins the crest strips into one face.
    let f2 = ThreadForm { starts: 2, ..f };
    let th = thread(&body, f2, hole_frame(t), 0.5 * d, (0.0, l)).expect("thread");
    assert!(close(
        volume(&th),
        900.0 * t - PI * rc * rc * t - groove_volume(&f, rc, l),
        1e-10
    ));
    mesh_ok(&th);
    // A thread in the middle of the bore, touching neither end, is refused.
    let e = thread(&body, f, hole_frame(t), 0.5 * d, (3.0, 7.5)).unwrap_err();
    assert_eq!(e.code(), "THREAD_END_UNSUPPORTED");
}

#[test]
fn a_countersunk_entry_ends_the_thread_on_the_cone() {
    let (t, d) = (10.0, 6.8);
    let body = plate_with_hole(
        at_centre(json!({ "d": d, "depth": "through", "csink": { "d": 12.0, "angle": 90 } })),
        t,
    );
    let rc = 0.5 * d;
    let hk = 6.0 - rc; // 90°: the cone drops as much as it narrows
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), rc, (hk, t)).expect("thread");
    let frustum = PI * hk / 3.0 * (36.0 + 6.0 * rc + rc * rc);
    let v = 900.0 * t - frustum - PI * rc * rc * (t - hk) - groove_volume(&f, rc, t - hk);
    assert!(close(volume(&th), v, 1e-9), "{} vs {v}", volume(&th));
    mesh_ok(&th);
}

/// A rod of radius `r` and length `l` along +Z from the origin.
fn rod(r: f64, l: f64) -> Body {
    extruded(
        "e1",
        0.0,
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: [0.0, 0.0],
            radius: r,
        }],
        l,
    )
}

#[test]
fn an_external_thread_on_a_rod_matches_the_closed_forms() {
    let (r, l) = (4.0, 16.0);
    let body = rod(r, l);
    let f = form(ThreadKind::External, 8.0, 1.25);
    let th = thread(&body, f, Frame::world(), r, (0.0, l)).expect("thread");
    let v = PI * r * r * l - groove_volume(&f, r, l);
    assert!(close(volume(&th), v, 1e-10), "{} vs {v}", volume(&th));
    mesh_ok(&th);
    // Part of the rod only: the thread ends inside at the top.
    let th = thread(&body, f, Frame::world(), r, (0.0, 10.0)).expect("thread");
    let v = PI * r * r * l - groove_volume(&f, r, 10.0);
    assert!(close(volume(&th), v, 1e-10), "{} vs {v}", volume(&th));
    mesh_ok(&th);
}

#[test]
fn hand_and_starts_change_the_helix_not_the_volume() {
    let (t, d) = (8.0, 6.647);
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": "through" })), t);
    let rc = 0.5 * d;
    let base = form(ThreadKind::Internal, 8.0, 1.25);
    let v = 900.0 * t - PI * rc * rc * t - groove_volume(&base, rc, t);
    for (starts, right_hand) in [(1, false), (2, true), (3, false)] {
        let f = ThreadForm {
            starts,
            right_hand,
            ..base
        };
        let th = thread(&body, f, hole_frame(t), rc, (0.0, t)).expect("thread");
        let vol = volume(&th);
        assert!(close(vol, v, 1e-10), "{starts} {right_hand}: {vol} vs {v}");
        let flanks = th
            .faces()
            .values()
            .filter(|f| f.surface.kind_name() == "helicoid")
            .count();
        assert_eq!(flanks, 2 * starts as usize);
        // Handedness is the sign of the helicoids' rise.
        for face in th.faces().values() {
            if let forge_core::geom::Surface::Helicoid(h) = &face.surface {
                assert_eq!(h.rise() > 0.0, right_hand);
            }
        }
        mesh_ok(&th);
    }
}

#[test]
fn threads_are_deterministic() {
    let (t, d) = (8.0, 6.8);
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": "through" })), t);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let a = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, t)).expect("thread");
    let b = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, t)).expect("thread");
    assert_eq!(format!("{a:?}"), format!("{b:?}"));
    let params = forge_mesh::TessParams::new(0.01, 5f64.to_radians());
    let ma = forge_mesh::tessellate(&a, &params).expect("mesh");
    let mb = forge_mesh::tessellate(&b, &params).expect("mesh");
    assert_eq!(ma.positions, mb.positions);
    assert_eq!(ma.triangles, mb.triangles);
}

#[test]
fn a_bore_outside_the_form_is_a_diameter_mismatch() {
    let body = plate_with_hole(at_centre(json!({ "d": 7.9, "depth": "through" })), 8.0);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let e = thread(&body, f, hole_frame(8.0), 3.95, (0.0, 8.0)).unwrap_err();
    assert_eq!(e.code(), "THREAD_DIAMETER_MISMATCH");
    let ThreadError::DiameterMismatch { min_d, max_d, .. } = e else {
        unreachable!()
    };
    assert!(min_d < 6.647 && max_d > 6.8 && max_d < 7.9);
}

#[test]
fn a_wall_thinner_than_the_thread_is_interference() {
    // A hole 11.1 mm from the centre of a 30 mm plate: the M8 groove reaches 15.1 mm.
    let off = |x: f64| json!({ "at": { "list": [{ "id": "p", "at": [x, 0.0] }] }, "d": 6.647, "depth": "through" });
    let frame_at = |x: f64| {
        Frame::from_normal_x(
            Vec3::new(x, 0.0, 8.0),
            Vec3::new(0.0, 0.0, -1.0),
            Vec3::new(1.0, 0.0, 0.0),
        )
        .unwrap()
    };
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let body = plate_with_hole(off(11.1), 8.0);
    let e = thread(&body, f, frame_at(11.1), 3.3235, (0.0, 8.0)).unwrap_err();
    assert_eq!(e.code(), "THREAD_INTERFERENCE", "{e}");
    // 1.5 mm further in, the wall holds the thread.
    let body = plate_with_hole(off(9.6), 8.0);
    let th = thread(&body, f, frame_at(9.6), 3.3235, (0.0, 8.0)).expect("thread");
    valid(&th);
}

#[test]
fn booleans_away_from_the_thread_keep_it_and_rays_classify_through_it() {
    use forge_ops::boolean::{BodyOp, apply_body_op};
    let (t, d) = (8.0, 6.647);
    let body = plate_with_hole(at_centre(json!({ "d": d, "depth": "through" })), t);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, t)).expect("thread");
    let v0 = volume(&th);
    // A pin hole in a corner and a block joined on the far side: the helicoid faces are
    // copied untouched, and the classification rays cross the thread's faces.
    let pin = extruded(
        "pin",
        -1.0,
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: [10.0, 10.0],
            radius: 1.0,
        }],
        t + 2.0,
    );
    let cut = apply_body_op(
        BodyOp::Cut,
        &[ob(th.clone(), "e1")],
        &[ob(pin, "pin")],
        "b1",
    )
    .expect("cut");
    let b = &cut.bodies[0].body;
    assert!(
        close(volume(b), v0 - PI * t, 1e-9),
        "{} vs {}",
        volume(b),
        v0 - PI * t
    );
    let helicoids = b
        .faces()
        .values()
        .filter(|f| f.surface.kind_name() == "helicoid")
        .count();
    assert_eq!(helicoids, 2);
    mesh_ok(b);
    let block = extruded("blk", t, rect(5.0, -15.0, 10.0, 30.0), 4.0);
    let join = apply_body_op(
        BodyOp::Join,
        &[ob(b.clone(), "e1")],
        &[ob(block, "blk")],
        "b2",
    )
    .expect("join");
    let j = &join.bodies[0].body;
    assert!(close(volume(j), volume(b) + 1200.0, 1e-9));
    mesh_ok(j);
    // A tool that reaches the thread is refused with a structured error, never cut wrongly.
    let cross = extruded("x", -1.0, rect(-1.0, -12.0, 2.0, 24.0), t + 2.0);
    let e = apply_body_op(
        BodyOp::Cut,
        &[ob(th.clone(), "e1")],
        &[ob(cross, "x")],
        "b3",
    )
    .expect_err("a cut across the thread");
    assert!(format!("{e:?}").contains("helicoid"), "{e:?}");
}

mod properties {
    use super::*;
    use proptest::prelude::*;

    /// `(major, pitch)` of forms that fit a 30 mm plate with margin.
    const FORMS: [(f64, f64); 8] = [
        (3.0, 0.5),
        (5.0, 0.8),
        (8.0, 1.25),
        (8.0, 1.0),
        (12.0, 1.75),
        (14.0, 1.0),
        (12.7, 1.27),
        (7.9375, 25.4 / 18.0),
    ];

    proptest! {
        #![proptest_config(ProptestConfig { cases: 24, ..ProptestConfig::default() })]

        /// Any form, crest diameter in its range, length, hand and number of starts on a
        /// through or flat-bottomed hole: a valid body whose volume is the closed form.
        #[test]
        fn random_threads_are_valid_with_the_closed_form_volume(
            fi in 0usize..FORMS.len(),
            crest_frac in 0.0f64..0.8,
            t in 4.0f64..14.0,
            len_frac in 0.3f64..1.0,
            full in any::<bool>(),
            right_hand in any::<bool>(),
            starts in 1u32..=3,
            blind in any::<bool>(),
        ) {
            let (major, pitch) = FORMS[fi];
            let f = ThreadForm { kind: ThreadKind::Internal, major, pitch, starts, right_hand };
            let (lo, hi) = f.crest_range();
            let d = f.basic_minor().max(lo) + crest_frac * (hi - f.basic_minor().max(lo));
            let depth = if blind { 0.8 * t } else { t };
            let fields = if blind {
                json!({ "d": d, "depth": { "blind": depth }, "tip": "flat" })
            } else {
                json!({ "d": d, "depth": "through" })
            };
            let body = plate_with_hole(at_centre(fields), t);
            let l = if full { depth } else { (len_frac * depth).max(1.0).min(depth - 0.01) };
            let th = thread(&body, f, hole_frame(t), 0.5 * d, (0.0, l)).expect("thread");
            let rc = 0.5 * d;
            let v = 900.0 * t - PI * rc * rc * depth - groove_volume(&f, rc, l);
            let got = volume(&th);
            prop_assert!(close(got, v, 1e-9), "{} vs {}", got, v);
        }

        /// External threads on rods: any form, boss diameter in its range, full or partial.
        #[test]
        fn random_bolt_threads_are_valid_with_the_closed_form_volume(
            fi in 0usize..FORMS.len(),
            crest_frac in 0.2f64..1.0,
            l in 4.0f64..20.0,
            len_frac in 0.3f64..1.0,
            full in any::<bool>(),
            right_hand in any::<bool>(),
            starts in 1u32..=2,
        ) {
            let (major, pitch) = FORMS[fi];
            let f = ThreadForm { kind: ThreadKind::External, major, pitch, starts, right_hand };
            let (lo, hi) = f.crest_range();
            let d = lo + crest_frac * (hi.min(major) - lo);
            let r = 0.5 * d;
            let body = rod(r, l);
            let lt = if full { l } else { (len_frac * l).max(1.0).min(l - 0.01) };
            let th = thread(&body, f, Frame::world(), r, (0.0, lt)).expect("thread");
            let v = PI * r * r * l - groove_volume(&f, r, lt);
            let got = volume(&th);
            prop_assert!(close(got, v, 1e-9), "{} vs {}", got, v);
        }
    }
}

#[test]
fn a_thread_running_past_the_face_or_too_close_to_its_end_is_refused() {
    let body = plate_with_hole(at_centre(json!({ "d": 6.647, "depth": "through" })), 8.0);
    let f = form(ThreadKind::Internal, 8.0, 1.25);
    let e = thread(&body, f, hole_frame(8.0), 3.3235, (0.0, 9.0)).unwrap_err();
    assert_eq!(e.code(), "THREAD_LENGTH_OUT_OF_RANGE");
    let e = thread(&body, f, hole_frame(8.0), 3.3235, (0.0, 7.9999)).unwrap_err();
    assert_eq!(e.code(), "THREAD_END_TOO_CLOSE");
    // An external form on a bore is refused.
    let e = thread(
        &body,
        form(ThreadKind::External, 6.647, 1.0),
        hole_frame(8.0),
        3.3235,
        (0.0, 8.0),
    )
    .unwrap_err();
    assert!(
        matches!(
            e.code(),
            "THREAD_FACE_UNSUPPORTED" | "THREAD_DIAMETER_MISMATCH"
        ),
        "{e}"
    );
}
