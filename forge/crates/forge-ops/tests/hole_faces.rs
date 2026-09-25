//! Point–face tests of holes on planar faces with **curved boundaries** (SPEC §6.5
//! `HOLE_POINT_OFF_FACE` "inside or on its boundary within tol", `up_to` "the first point of
//! the face", `HOLE_UP_TO_MISSED`): faces bounded by an ellipse (a slanted cut of a
//! cylinder, a plate cut by a tilted cylinder), by B-splines (a plate notched by a cone whose
//! axis is parallel to it: hyperbolas, typed `bspline` by [W0-51]) and by circular arcs.
//!
//! Every expectation comes from the exact geometry (the ellipse or cone equation), never from
//! the classifier under test. Regression: the ray-parity search used to be bounded by the
//! edges' end points only, so the far side of a closed ellipse edge fell outside the search
//! box, the parity flipped, and points about 1 mm outside the face were "on" it (a missed
//! `HOLE_POINT_OFF_FACE`, and an `up_to` axis that misses the face "hitting" it).

// Exact comparisons on purpose: exact placements and the classifier's 0.
#![allow(clippy::float_cmp)]

use forge_core::geom::{Curve3, Surface};
use forge_core::linalg::{Frame, Point3, Vec3};
use forge_core::topo::{Body, FaceId};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame as IrFrame, PlaneSpec, SketchAxis, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, OpBody, apply_body_op};
use forge_ops::hole::{
    HoleError, HoleSite, apply_hole, hole_positions, hole_spec, literal_hole, planar_face_distance,
    up_to_depth,
};
use serde_json::{Value, json};

const TAN70: f64 = 2.747_477_419_454_622;

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

fn sweep(feature: &str, plane: IrFrame, curves: Vec<SketchCurve>, sweep: Sweep) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane: PlaneSpec::Frame(plane),
            curves,
        },
        sweep,
    }
    .build()
    .expect("operand")
}

fn extrude(h: f64) -> Sweep {
    Sweep::Extrude {
        distance: h,
        direction: SweepDirection::Normal,
    }
}

fn xy(z: f64) -> IrFrame {
    IrFrame {
        origin: [0.0, 0.0, z],
        normal: [0.0, 0.0, 1.0],
        x_dir: [1.0, 0.0, 0.0],
    }
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

fn cut(target: Body, tool: Body) -> Body {
    let mut r =
        apply_body_op(BodyOp::Cut, &[ob(target, "e1")], &[ob(tool, "e2")], "e2").expect("cut");
    assert_eq!(r.bodies.len(), 1, "one body");
    r.bodies.remove(0).body
}

/// The planar face whose outward normal is `n` (within 1e-9) and which contains `p`'s plane.
fn planar_face(b: &Body, n: Vec3, p: Point3) -> FaceId {
    b.faces()
        .iter()
        .find(|(_, f)| {
            let Surface::Plane(pl) = &f.surface else {
                return false;
            };
            let m = pl.frame().z() * if f.sense { 1.0 } else { -1.0 };
            (m - n).norm() < 1e-9 && (p - pl.frame().origin()).dot(m).abs() < 1e-9
        })
        .map(|(id, _)| id)
        .expect("planar face")
}

fn edge_kinds(b: &Body, f: FaceId) -> Vec<&'static str> {
    b.face_edges(f)
        .into_iter()
        .filter_map(|e| b.edge(e))
        .map(|e| match e.curve {
            Curve3::Line(_) => "line",
            Curve3::Circle(_) => "circle",
            Curve3::Ellipse(_) => "ellipse",
            Curve3::BSpline(_) => "bspline",
        })
        .collect()
}

/// A z-cylinder of radius 10 on `z ∈ [0, 60]` with everything above the plane through
/// `(0, 0, 30)` tilted 70° about X removed; the cutter's sketch x axis is `x_dir` (the slanted
/// face's frame). Returns the body, the slanted face, its unit outward normal and in-plane
/// axes `(u, w)`: `(0, 0, 30) + u·X + v·w` is inside the face iff `u² + (v·cos70)² < 100`.
fn slanted_cylinder(x_dir: [f64; 3]) -> (Body, FaceId, Vec3, Vec3) {
    slanted(x_dir, 10.0, 70.0)
}

/// [`slanted_cylinder`] with radius `r` and tilt `tilt` (degrees).
fn slanted(x_dir: [f64; 3], r: f64, tilt: f64) -> (Body, FaceId, Vec3, Vec3) {
    let cyl = sweep(
        "e1",
        xy(0.0),
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: [0.0, 0.0],
            radius: r,
        }],
        extrude(60.0),
    );
    let (s, c) = (tilt.to_radians().sin(), tilt.to_radians().cos());
    let n = Vec3::new(0.0, -s, c);
    let cutter = sweep(
        "e2",
        IrFrame {
            origin: [0.0, 0.0, 30.0],
            normal: n.to_array(),
            x_dir,
        },
        rect(-100.0, -100.0, 200.0, 200.0),
        extrude(100.0),
    );
    let body = cut(cyl, cutter);
    let face = planar_face(&body, n, Vec3::new(0.0, 0.0, 30.0));
    assert_eq!(
        edge_kinds(&body, face),
        ["ellipse"],
        "one closed ellipse edge"
    );
    (body, face, n, Vec3::new(0.0, c, s))
}

/// Distance in the slanted plane from `(u, v)` to the ellipse `u² + (v·cos70)² = 100`
/// (dense sampling, then golden-section refinement).
fn ellipse_distance(u: f64, v: f64) -> f64 {
    ellipse_distance_of(u, v, 10.0, 70.0)
}

/// [`ellipse_distance`] for the ellipse of [`slanted`] with radius `r` and tilt `tilt`.
fn ellipse_distance_of(u: f64, v: f64, r: f64, tilt: f64) -> f64 {
    let b = r / tilt.to_radians().cos();
    let at = |t: f64| (r * t.cos() - u).hypot(b * t.sin() - v);
    let n = 20_000;
    let h = std::f64::consts::TAU / f64::from(n);
    let mut best = (0.0, at(0.0));
    for k in 1..n {
        let t = h * f64::from(k);
        if at(t) < best.1 {
            best = (t, at(t));
        }
    }
    let (mut lo, mut hi) = (best.0 - h, best.0 + h);
    let g = 0.5 * (5f64.sqrt() - 1.0);
    for _ in 0..100 {
        let (a, bb) = (hi - g * (hi - lo), lo + g * (hi - lo));
        if at(a) < at(bb) {
            hi = bb;
        } else {
            lo = a;
        }
    }
    best.1.min(at(0.5 * (lo + hi)))
}

/// In-plane sample points `(u, v)`: a coarse grid over the face and around it, a dense patch
/// around the ellipse's vertex side `u ≈ −10`, and the reviewer's point `(−11, −5.04)`.
fn slanted_samples() -> Vec<(f64, f64)> {
    let mut v = vec![(-11.0, -5.04)];
    for i in 0..15 {
        for j in 0..19 {
            v.push((
                -14.0 + 2.0 * f64::from(i) + 0.13,
                -36.0 + 4.0 * f64::from(j) + 0.29,
            ));
        }
    }
    for i in 0..9 {
        for j in 0..9 {
            v.push((-13.1 + 0.5 * f64::from(i), -8.2 + 2.0 * f64::from(j)));
        }
    }
    v
}

/// Every sample of the slanted ellipse face (both face frames) is classified by the exact
/// ellipse, with the exact distance outside.
#[test]
fn a_face_bounded_by_an_ellipse_classifies_points_by_the_ellipse() {
    for x_dir in [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]] {
        let (body, face, _, w) = slanted_cylinder(x_dir);
        let c70 = 70f64.to_radians().cos();
        let mut checked = 0;
        for (u, v) in slanted_samples() {
            let truth = ellipse_distance(u, v);
            if truth < 1e-3 {
                continue; // on the boundary within the sampling's reach
            }
            let inside = u * u + (v * c70) * (v * c70) < 100.0;
            let p = Vec3::new(0.0, 0.0, 30.0) + Vec3::unit_x() * u + w * v;
            let d = planar_face_distance(&body, face, p).expect("classified");
            if inside {
                assert_eq!(d, 0.0, "x_dir {x_dir:?}: ({u}, {v}) is inside");
            } else {
                assert!(
                    (d - truth).abs() <= 1e-6,
                    "x_dir {x_dir:?}: ({u}, {v}) is {truth} mm outside, got {d}"
                );
            }
            checked += 1;
        }
        assert!(checked > 350, "{checked}");
    }
}

/// Distances next to the ellipse's seam vertex: the foot point of a point just off the minor
/// axis lies on the other side of the seam from the nearest sample (oracle probe 101#22: r =
/// 8.5, tilt 55°, Forge 1.76144 vs OCCT 1.76056 before the seam-wrapping refinement).
#[test]
fn distances_across_the_seam_of_a_closed_ellipse_edge_are_exact() {
    for x_dir in [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]] {
        for (r, tilt) in [(8.5, 55.0), (10.0, 70.0)] {
            let (body, face, _, w) = slanted(x_dir, r, tilt);
            for sx in [1.0, -1.0] {
                for v in [-0.3, -0.0578, -1e-3, 0.0, 1e-3, 0.0578, 0.3] {
                    for du in [0.01, 0.5, 1.7605] {
                        let u = sx * (r + du);
                        let p = Vec3::new(0.0, 0.0, 30.0) + Vec3::unit_x() * u + w * v;
                        let d = planar_face_distance(&body, face, p).expect("classified");
                        let truth = ellipse_distance_of(u, v, r, tilt);
                        assert!(
                            (d - truth).abs() <= 1e-9,
                            "{x_dir:?} r {r} tilt {tilt}: ({u}, {v}) {d} vs {truth}"
                        );
                    }
                }
            }
        }
    }
    // The probe itself.
    let (body, face, _, _) = slanted([1.0, 0.0, 0.0], 8.5, 55.0);
    let p = Vec3::new(
        10.260501695313462,
        -0.033050195410088926,
        29.952799429302644,
    );
    let d = planar_face_distance(&body, face, p).expect("classified");
    assert!((d - 1.76056185).abs() < 1e-8, "{d}");
}

/// `up_to` the slanted ellipse face from below (both face frames): a vertical axis hits it
/// exactly when it passes inside the cylinder, at the plane's height; outside it is `None`
/// (`HOLE_UP_TO_MISSED`). The points around `x = ±10` are where the end-point bound flipped
/// the parity (outside "hit", inside "missed").
#[test]
fn up_to_an_ellipse_face_hits_inside_its_projection_only() {
    for x_dir in [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]] {
        let (body, face, _, _) = slanted_cylinder(x_dir);
        for sx in [1.0, -1.0] {
            for (x, y) in [
                (10.44, -0.2428),
                (10.44, 0.7935),
                (9.97, -1.2792),
                (11.0, -1.724),
                (8.09, -0.2428),
                (7.15, 0.448),
                (9.0, 3.0),
                (0.0, 9.95),
                (0.0, 10.05),
                (7.2, -7.2),
                (7.0, -7.0),
            ] {
                let x = sx * x;
                let got =
                    up_to_depth(&body, face, Vec3::new(x, y, -5.0), Vec3::unit_z()).expect("ray");
                if f64::hypot(x, y) > 10.0 + 1e-3 {
                    assert_eq!(
                        got, None,
                        "{x_dir:?}: ({x}, {y}) passes outside the cylinder"
                    );
                } else {
                    let z = 30.0 + y * TAN70;
                    let h = got.unwrap_or_else(|| panic!("{x_dir:?}: ({x}, {y}) passes inside"));
                    assert!((h - (z + 5.0)).abs() < 1e-9, "{x_dir:?}: ({x}, {y}): {h}");
                }
            }
        }
    }
}

/// The same face through `apply_hole` (both face frames): a position outside the ellipse is
/// `HOLE_POINT_OFF_FACE` with its distance, positions inside near the ellipse's far side are
/// on the face, and an `up_to` hole placed on a datum plane below the cylinder whose axis
/// misses the face is `HOLE_UP_TO_MISSED` — never a hole with a floor.
#[test]
fn holes_on_and_up_to_an_ellipse_face_fail_explicitly_outside_it() {
    for x_dir in [[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0]] {
        let (body, face, n, w) = slanted_cylinder(x_dir);
        // The slanted face's frame for the positions: x = X, y = w, outward normal n.
        let frame =
            Frame::from_normal_x(Vec3::new(0.0, 0.0, 30.0), n, Vec3::unit_x()).expect("frame");
        assert!((frame.y() - w).norm() < 1e-12);
        let run = |fields: Value, frame: &Frame, on: bool, up: bool| {
            let mut v = json!({ "id": "h1", "name": "holes", "on": "XY" });
            for (k, x) in fields.as_object().expect("object") {
                v[k] = x.clone();
            }
            let h: forge_ir::v1::HoleFeature = serde_json::from_value(v).expect("hole");
            let lit = literal_hole(&h, |s, _, _| s.literal().ok_or(())).expect("literals");
            let spec = hole_spec(&lit).expect("spec");
            let pos = hole_positions(&lit.at, frame, &[]).expect("positions");
            let site = HoleSite {
                frame,
                flip: false,
                on_face: on.then_some((&body, face)),
                up_to: up.then_some((&body, face)),
                timeline: 1,
                scope_scale: None,
            };
            apply_hole(&spec, &pos, &site, &[ob(body.clone(), "e1")])
        };
        for sx in [1.0, -1.0] {
            let e = run(
                json!({ "at": { "list": [{ "id": "in", "at": [sx * 7.62, 0.3] },
                                         { "id": "out", "at": [sx * 10.44, -0.71] }] },
                        "d": 1, "depth": { "blind": 2 } }),
                &frame,
                true,
                false,
            )
            .expect_err("off the face");
            let HoleError::PointOffFace { at, distance } = &e else {
                panic!("{x_dir:?}: {e}")
            };
            assert_eq!(at, "out", "{x_dir:?}");
            let truth = ellipse_distance(10.44, -0.71);
            assert!(
                (distance - truth).abs() < 1e-6,
                "{x_dir:?}: {distance} vs {truth}"
            );
            let o = run(
                json!({ "at": { "list": [{ "id": "in", "at": [sx * 7.62, 0.3] },
                                         { "id": "in2", "at": [sx * 8.09, -1.72] }] },
                        "d": 1, "depth": { "blind": 2 } }),
                &frame,
                true,
                false,
            )
            .unwrap_or_else(|e| panic!("{x_dir:?}: inside: {e}"));
            assert_eq!(o.holes.len(), 2);
            // `up_to` from a datum plane at z = −5 drilling up (its normal −Z, d = +Z).
            let below =
                Frame::from_normal_x(Vec3::new(0.0, 0.0, -5.0), -Vec3::unit_z(), Vec3::unit_x())
                    .expect("frame");
            let up_to = json!({ "up_to": { "kind": "face", "q": { "op": "cap", "feature": "e2", "end": "start" } } });
            // In `below`'s frame y = −Y.
            let e = run(
                json!({ "at": { "list": [{ "id": "a", "at": [sx * 10.44, 0.2428] }] }, "d": 1, "depth": up_to }),
                &below,
                false,
                true,
            )
            .expect_err("misses the face");
            assert_eq!(e.code(), "HOLE_UP_TO_MISSED", "{x_dir:?}: {e}");
            let o = run(
                json!({ "at": { "list": [{ "id": "a", "at": [sx * 8.09, 0.2428] }] }, "d": 1, "depth": up_to }),
                &below,
                false,
                true,
            )
            .unwrap_or_else(|e| panic!("{x_dir:?}: hits: {e}"));
            let h = o.holes[0].depth.expect("depth");
            assert!((h - (35.0 - 0.2428 * TAN70)).abs() < 1e-9, "{x_dir:?}: {h}");
        }
    }
}

/// A 60 × 40 × 8 plate notched by a cone whose axis runs along X at `y = 20, z = 10` (apex at
/// the origin's side, half-angle atan 0.2): the top face (2 below the axis) is bounded by a
/// hyperbola and the bottom face (10 below) by another, both B-splines ([W0-51]).
fn coned_plate() -> Body {
    let plate = sweep("e1", xy(0.0), rect(0.0, 0.0, 60.0, 40.0), extrude(8.0));
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    let cone = sweep(
        "e2",
        IrFrame {
            origin: [0.0, 20.0, 10.0],
            normal: [0.0, -1.0, 0.0],
            x_dir: [1.0, 0.0, 0.0],
        },
        vec![
            l("a", [0.0, 0.0], [70.0, 0.0]),
            l("b", [70.0, 0.0], [70.0, 14.0]),
            l("c", [70.0, 14.0], [0.0, 0.0]),
        ],
        Sweep::Revolve {
            axis: SketchAxis {
                origin: [0.0, 0.0],
                direction: [1.0, 0.0],
            },
            angle: 360.0,
            direction: SweepDirection::Normal,
        },
    );
    cut(plate, cone)
}

/// Inside the cone (the notch): `hypot(y − 20, z − 10) < 0.2·x`.
fn in_cone(x: f64, y: f64, z: f64) -> f64 {
    f64::hypot(y - 20.0, z - 10.0) - 0.2 * x
}

#[test]
fn a_face_bounded_by_bsplines_classifies_points_by_the_cone() {
    let body = coned_plate();
    for (z, n) in [(8.0, Vec3::unit_z()), (0.0, -Vec3::unit_z())] {
        let face = planar_face(&body, n, Vec3::new(0.0, 0.0, z));
        assert!(
            edge_kinds(&body, face).contains(&"bspline"),
            "z = {z}: {:?}",
            edge_kinds(&body, face)
        );
        let mut checked = (0, 0);
        for i in 0..24 {
            for j in 0..17 {
                let (x, y) = (2.0 + 2.5 * f64::from(i) + 0.11, 0.7 + 2.3 * f64::from(j));
                let g = in_cone(x, y, z);
                if g.abs() < 1e-2 {
                    continue;
                }
                let d = planar_face_distance(&body, face, Vec3::new(x, y, z)).expect("classified");
                if g < 0.0 {
                    assert!(d > 1e-3, "z = {z}: ({x}, {y}) is in the notch, got {d}");
                    checked.1 += 1;
                } else {
                    assert_eq!(d, 0.0, "z = {z}: ({x}, {y}) is on the face");
                    checked.0 += 1;
                }
            }
        }
        assert!(checked.0 > 100 && checked.1 > 10, "{checked:?}");
    }
    // Rays from the top down to the bottom face: they miss where the bottom is notched.
    let bottom = planar_face(&body, -Vec3::unit_z(), Vec3::zero());
    for (x, y) in [
        (55.0, 20.0),
        (55.0, 26.0),
        (59.0, 14.0),
        (45.0, 20.0),
        (52.0, 31.0),
    ] {
        let got = up_to_depth(&body, bottom, Vec3::new(x, y, 8.0), -Vec3::unit_z()).expect("ray");
        if in_cone(x, y, 0.0) < 0.0 {
            assert_eq!(got, None, "({x}, {y}) is over the bottom notch");
        } else {
            assert_eq!(got, Some(8.0), "({x}, {y})");
        }
    }
}

/// A plate notched at its edge by a vertical cylinder: the top face's boundary has a
/// circular arc; points in the notch are off the face by their distance to the arc.
#[test]
fn a_face_bounded_by_an_arc_classifies_points_by_the_circle() {
    let plate = sweep("e1", xy(0.0), rect(0.0, 0.0, 60.0, 40.0), extrude(8.0));
    let post = sweep(
        "e2",
        xy(-1.0),
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: [60.0, 20.0],
            radius: 12.0,
        }],
        extrude(10.0),
    );
    let body = cut(plate, post);
    let face = planar_face(&body, Vec3::unit_z(), Vec3::new(0.0, 0.0, 8.0));
    assert!(edge_kinds(&body, face).contains(&"circle"));
    for (x, y) in [
        (50.0, 20.0),
        (47.5, 20.0),
        (55.0, 30.0),
        (49.0, 26.0),
        (59.5, 33.0),
    ] {
        let r = f64::hypot(x - 60.0, y - 20.0);
        let d = planar_face_distance(&body, face, Vec3::new(x, y, 8.0)).expect("classified");
        if r < 12.0 {
            assert!((d - (12.0 - r)).abs() < 1e-9, "({x}, {y}): {d}");
        } else {
            assert_eq!(d, 0.0, "({x}, {y})");
        }
    }
}
