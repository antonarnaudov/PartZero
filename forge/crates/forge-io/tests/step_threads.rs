//! STEP export of modelled threads (forge-ops `thread_face`): AP242 has no helicoid or helix,
//! so the writer replaces them by certified B-splines (`step::threads`). The file must read
//! back, verify, keep Forge's topology counts, and bound the same volume and area as Forge's
//! exact body within the approximation's reach (1e-7 mm of surface deviation).

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::{Body, Role};
use forge_io::step::{StepBody, StepOptions, verify_step, write_step};
use forge_ir::v1::metrics::Origin;
use forge_ir::v1::{HoleFeature, HolePlacement};
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchCurve, SweepDirection};
use forge_ops::boolean::OpBody;
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::hole::{HoleSite, apply_hole, hole_positions, hole_spec, literal_hole};
use forge_ops::thread::{ThreadForm, ThreadKind, ThreadRequest, crest_faces, thread_face};
use serde_json::json;

fn extruded(curves: Vec<SketchCurve>, h: f64) -> Body {
    Operand {
        feature: "e1".into(),
        sketch: forge_ir::SketchFeature {
            id: "s1".into(),
            name: "s1".into(),
            suppressed: false,
            plane: PlaneSpec::Frame(IrFrame {
                origin: [0.0, 0.0, 0.0],
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

fn square(s: f64) -> Vec<SketchCurve> {
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    vec![
        l("b", [-s, -s], [s, -s]),
        l("r", [s, -s], [s, s]),
        l("t", [s, s], [-s, s]),
        l("l", [-s, s], [-s, -s]),
    ]
}

/// A 30 × 30 × `t` plate with a through hole of diameter `d` at its centre.
fn plate_with_hole(d: f64, t: f64) -> Body {
    let plate = extruded(square(15.0), t);
    let frame = Frame::world().with_origin(Vec3::new(0.0, 0.0, t));
    let h: HoleFeature = serde_json::from_value(json!({
        "id": "h1", "name": "holes", "on": "XY",
        "at": { "list": [{ "id": "p", "at": [0.0, 0.0] }] },
        "d": d, "depth": "through"
    }))
    .expect("hole");
    let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
    let spec = hole_spec(&lit).expect("spec");
    assert!(matches!(lit.at, HolePlacement::List(_)));
    let pos = hole_positions(&lit.at, &frame, &[]).expect("positions");
    let face = plate
        .faces()
        .iter()
        .find(|(_, f)| f.provenance.role == Role::CapEnd)
        .map(|(id, _)| id)
        .expect("end cap");
    let site = HoleSite {
        frame: &frame,
        flip: false,
        on_face: Some((&plate, face)),
        up_to: None,
        timeline: 1,
        scope_scale: None,
    };
    let op = OpBody {
        body: plate.clone(),
        origin: Origin {
            feature: "e1".into(),
            member: "b".into(),
            instance: None,
        },
        timeline: 0,
    };
    let out = apply_hole(&spec, &pos, &site, &[op]).expect("hole");
    out.op.bodies[0].body.clone()
}

fn threaded(body: &Body, form: ThreadForm, frame: Frame, crest_r: f64, z: (f64, f64)) -> Body {
    let faces = crest_faces(body, &frame, crest_r, z);
    assert_eq!(faces.len(), 1, "{faces:?}");
    thread_face(
        body,
        faces[0].0,
        &ThreadRequest {
            form,
            frame,
            z_range: z,
            feature: "t1",
            qualifier: None,
        },
    )
    .expect("thread")
}

fn m8(kind: ThreadKind, starts: u32) -> ThreadForm {
    ThreadForm {
        kind,
        major: 8.0,
        pitch: 1.25,
        starts,
        right_hand: true,
    }
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / a.abs().max(b.abs())
}

/// Writes one body, verifies it, and compares the verifier's volume and area with Forge's.
fn exports(name: &str, body: &Body) -> Vec<u8> {
    let helicoids = body
        .faces()
        .values()
        .filter(|f| matches!(f.surface, Surface::Helicoid(_)))
        .count();
    let helices = body
        .edges()
        .values()
        .filter(|e| matches!(e.curve, Curve3::Helix(_)))
        .count();
    assert!(helicoids > 0 && helices > 0, "{name}: not threaded");
    let item = StepBody {
        name,
        body,
        color: None,
    };
    let (bytes, report) = write_step(&[item], &StepOptions::default()).expect("writes");
    let text = std::str::from_utf8(&bytes).expect("ascii");
    // The helicoids became B-spline surfaces: the file names no other surface kind for them.
    assert!(
        text.matches("B_SPLINE_SURFACE_WITH_KNOTS").count() >= helicoids,
        "{name}: {helicoids} helicoids"
    );
    let r = &report.bodies[0];
    let c = body.counts();
    assert_eq!(r.faces, c.faces, "{name}: faces");
    assert_eq!(
        r.edges - r.seam_edges - r.split_pieces,
        c.edges,
        "{name}: edges {r:?}"
    );
    let s = verify_step(&bytes).unwrap_or_else(|e| panic!("{name}: {} {e}", e.code()));
    let m = forge_check::mass_properties(body).expect("mass");
    let v: f64 = s.solids.iter().map(|x| x.volume).sum();
    let a: f64 = s.solids.iter().map(|x| x.area).sum();
    assert!(
        rel(v, m.volume) < 1e-7,
        "{name}: volume {v} vs {}",
        m.volume
    );
    assert!(rel(a, m.area) < 1e-7, "{name}: area {a} vs {}", m.area);
    bytes
}

#[test]
fn a_threaded_through_hole_exports_as_verified_bsplines() {
    // Short threads keep the debug-build test quick: the verifier's cost grows with the square
    // of the B-spline spans (about 21 per turn at 1e-7 mm).
    let t = 4.0;
    let body = plate_with_hole(6.8, t);
    let frame = Frame::from_normal_x(
        Vec3::new(0.0, 0.0, t),
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::new(1.0, 0.0, 0.0),
    )
    .expect("frame");
    let nut = threaded(&body, m8(ThreadKind::Internal, 1), frame, 3.4, (0.0, t));
    exports("nut", &nut);
    // Two starts, thread ending inside the bore (planar end faces).
    let nut2 = threaded(&body, m8(ThreadKind::Internal, 2), frame, 3.4, (0.0, 2.5));
    exports("nut2", &nut2);
}

#[test]
fn an_external_thread_exports_and_is_deterministic() {
    let rod = extruded(
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: [0.0, 0.0],
            radius: 4.0,
        }],
        8.0,
    );
    let bolt = threaded(
        &rod,
        m8(ThreadKind::External, 1),
        Frame::world(),
        4.0,
        (0.0, 4.0),
    );
    let a = exports("bolt", &bolt);
    let item = StepBody {
        name: "bolt",
        body: &bolt,
        color: None,
    };
    let (b, _) = write_step(&[item], &StepOptions::default()).expect("writes");
    assert_eq!(a, b);
    if let Ok(dir) = std::env::var("FORGE_STEP_THREADS_DUMP") {
        std::fs::write(std::path::Path::new(&dir).join("bolt.step"), &a).expect("dump");
    }
}
