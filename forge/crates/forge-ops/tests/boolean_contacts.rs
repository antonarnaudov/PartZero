//! Booleans at degenerate contacts: a sphere pole or cone apex touching a face (the
//! parameters there are a whole singular line), and near-coincident faces swept through
//! the band between the intersection's coincidence resolution and the linear tolerance.
//! Every outcome is a valid body with the closed-form volume, or an explicit error with the
//! code the configuration calls for, never a silently non-manifold or wrong body.

use forge_core::topo::{Body, Severity};
use forge_ir::v1::metrics::Origin;
use forge_ir::{Frame, PlaneSpec, SketchAxis, SketchCurve, SweepDirection};
use forge_ops::boolean::corpus::{Operand, Sweep};
use forge_ops::boolean::{BodyOp, BodyOpResult, BooleanError, OpBody, apply_body_op};

const PI: f64 = std::f64::consts::PI;

fn plane(origin: [f64; 3], normal: [f64; 3], x_dir: [f64; 3]) -> PlaneSpec {
    PlaneSpec::Frame(Frame {
        origin,
        normal,
        x_dir,
    })
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn build(feature: &str, plane: PlaneSpec, curves: Vec<SketchCurve>, sweep: Sweep) -> Body {
    Operand {
        feature: feature.into(),
        sketch: forge_ir::SketchFeature {
            id: format!("s_{feature}"),
            name: format!("s_{feature}"),
            suppressed: false,
            plane,
            curves,
        },
        sweep,
    }
    .build()
    .unwrap_or_else(|e| panic!("operand {feature}: {e:?}"))
}

fn extrude(d: f64) -> Sweep {
    Sweep::Extrude {
        distance: d,
        direction: SweepDirection::Normal,
    }
}

fn revolve_y() -> Sweep {
    Sweep::Revolve {
        axis: SketchAxis {
            origin: [0.0, 0.0],
            direction: [0.0, 1.0],
        },
        angle: 360.0,
        direction: SweepDirection::Normal,
    }
}

/// Axis-aligned box `lo + [0, size]`.
fn aabox(feature: &str, lo: [f64; 3], size: [f64; 3]) -> Body {
    let (x0, y0, w, h) = (lo[0], lo[1], size[0], size[1]);
    build(
        feature,
        plane([0.0, 0.0, lo[2]], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        vec![
            line("b", [x0, y0], [x0 + w, y0]),
            line("r", [x0 + w, y0], [x0 + w, y0 + h]),
            line("t", [x0 + w, y0 + h], [x0, y0 + h]),
            line("l", [x0, y0 + h], [x0, y0]),
        ],
        extrude(size[2]),
    )
}

/// Cylinder of radius `r` about the Z axis through `c`, from `z0` to `z0 + h`.
fn zcyl(feature: &str, c: [f64; 2], r: f64, z0: f64, h: f64) -> Body {
    build(
        feature,
        plane([0.0, 0.0, z0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
        vec![SketchCurve::Circle {
            id: "c".into(),
            center: c,
            radius: r,
        }],
        extrude(h),
    )
}

#[derive(Clone, Copy, Debug)]
enum Axis {
    X,
    Y,
    Z,
}

/// A sketch frame at `o` whose sketch `y` direction is the given world axis (±).
fn axis_frame(o: [f64; 3], axis: Axis) -> PlaneSpec {
    match axis {
        // y = n × x = (0,-1,0) × (1,0,0) = +Z.
        Axis::Z => plane(o, [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]),
        // y = (0,0,1) × (0,1,0) = −X.
        Axis::X => plane(o, [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
        // y = (1,0,0) × (0,0,1) = −Y.
        Axis::Y => plane(o, [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
    }
}

/// Sphere of radius `r` at `c`, revolved about a line through `c` along `axis`: its poles
/// lie on that axis.
fn sphere(feature: &str, c: [f64; 3], r: f64, axis: Axis) -> Body {
    build(
        feature,
        axis_frame(c, axis),
        vec![
            SketchCurve::Arc {
                id: "a".into(),
                start: [0.0, -r],
                end: [0.0, r],
                center: [0.0, 0.0],
                ccw: true,
            },
            line("l", [0.0, r], [0.0, -r]),
        ],
        revolve_y(),
    )
}

/// Solid cone with its apex at `apex`, axis along +Z (`up`) or −Z, base radius `r` at
/// height `h` from the apex.
fn cone(feature: &str, apex: [f64; 3], r: f64, h: f64, up: bool) -> Body {
    let s = if up { 1.0 } else { -1.0 };
    // The sketch's y is +Z; an apex-down cone opens upwards.
    let pts = [[0.0, 0.0], [r, -s * h], [0.0, -s * h]];
    let curves = if up {
        // Apex at the top: profile below it.
        vec![
            line("g", pts[0], pts[2]),
            line("b", pts[2], pts[1]),
            line("s", pts[1], pts[0]),
        ]
    } else {
        vec![
            line("s", pts[0], pts[1]),
            line("b", pts[1], pts[2]),
            line("g", pts[2], pts[0]),
        ]
    };
    build(feature, axis_frame(apex, Axis::Z), curves, revolve_y())
}

fn ob(body: Body, feature: &str, timeline: usize) -> OpBody {
    OpBody {
        body,
        origin: Origin {
            feature: feature.into(),
            member: "m".into(),
            instance: None,
        },
        timeline,
    }
}

fn op(o: BodyOp, a: &Body, b: &Body) -> Result<BodyOpResult, BooleanError> {
    apply_body_op(o, &[ob(a.clone(), "a", 0)], &[ob(b.clone(), "b", 1)], "g")
}

fn mass(b: &Body) -> (f64, f64) {
    let mp = forge_check::mass_properties(b).expect("mass");
    (mp.volume, mp.area)
}

/// Total volume of the result of `op(o, a, b)` (an untouched target counts with its own
/// volume), and the largest area involved (result or operands): an offset `ε` between
/// faces treated as coincident moves the volume by at most `ε` times that area.
fn outcome_volume(r: &BodyOpResult, a: &Body, b: &Body, what: &str) -> (f64, f64) {
    let (mut v, area) = checked(r, what);
    if !r.untouched.is_empty() {
        assert!(r.bodies.is_empty(), "{what}");
        v += mass(a).0;
    }
    (v, area.max(mass(a).1).max(mass(b).1))
}

/// Valid bodies; total volume and area.
fn checked(r: &BodyOpResult, what: &str) -> (f64, f64) {
    let (mut v, mut a) = (0.0, 0.0);
    for b in &r.bodies {
        let issues = forge_check::validate(&b.body);
        assert!(
            issues.iter().all(|i| i.severity != Severity::Error),
            "{what}: invalid result {issues:?}"
        );
        let mp = forge_check::mass_properties(&b.body).expect("mass");
        v += mp.volume;
        a += mp.area;
    }
    (v, a)
}

fn code<T>(r: &Result<T, BooleanError>) -> &'static str {
    match r {
        Ok(_) => "OK",
        Err(e) => e.code(),
    }
}

/// A sphere cavity whose pole touches the target's boundary from inside is a solid that
/// touches itself at a point: `BOOLEAN_NON_MANIFOLD`, wherever the pole is and whichever
/// face it touches (it used to be returned as a two-shell body, because the pole's
/// parameters are a whole line outside every chart window).
#[test]
fn a_sphere_pole_touching_a_face_from_inside_is_non_manifold() {
    let target = aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let cases: [([f64; 3], Axis); 8] = [
        ([2.0, 1.5, 1.0], Axis::Z), // south pole on the bottom face
        ([1.3, 2.7, 1.0], Axis::Z), // elsewhere on it
        ([2.5, 2.5, 1.0], Axis::Z), // on the face's diagonal
        ([2.0, 2.0, 1.0], Axis::Z), // at the face's centre
        ([2.0, 1.5, 3.0], Axis::Z), // north pole on the top face
        ([1.0, 2.2, 1.7], Axis::X), // pole on the side x = 0
        ([2.2, 3.0, 1.7], Axis::Y), // pole on the side y = 4
        ([3.0, 1.1, 2.3], Axis::X), // pole on the side x = 4
    ];
    for (c, axis) in cases {
        let s = sphere("k", c, 1.0, axis);
        let r = op(BodyOp::Cut, &target, &s);
        match &r {
            Err(e) => {
                assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{c:?} {axis:?}: {e}");
                let d = serde_json::to_value(e.details()).expect("details");
                let p = &d["probe"]["point"];
                let at: Vec<f64> = (0..3).map(|i| p[i].as_f64().expect("coord")).collect();
                // The probe is the contact point: on the sphere and on the box boundary.
                let dc = ((at[0] - c[0]).powi(2) + (at[1] - c[1]).powi(2) + (at[2] - c[2]).powi(2))
                    .sqrt();
                assert!((dc - 1.0).abs() < 1e-6, "{c:?}: probe {at:?}");
            }
            Ok(res) => panic!(
                "{c:?} {axis:?}: a non-manifold cut returned {} bodies",
                res.bodies.len()
            ),
        }
        // The intersection is the sphere itself (a manifold body).
        let r = op(BodyOp::Intersect, &target, &s).expect("intersect");
        let (v, _) = checked(&r, "intersect");
        assert!((v - 4.0 * PI / 3.0).abs() < 1e-9, "{c:?}: {v}");
    }
}

/// Control: the same contact at a regular point of the sphere (its equator) was already
/// non-manifold; a sphere clear of the faces cuts a void.
#[test]
fn equator_contacts_and_clear_voids_are_unchanged() {
    let target = aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let e = op(
        BodyOp::Cut,
        &target,
        &sphere("k", [2.0, 1.5, 1.0], 1.0, Axis::X),
    )
    .expect_err("equator contact");
    assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD");
    let r = op(
        BodyOp::Cut,
        &target,
        &sphere("k", [2.0, 1.5, 1.5], 1.0, Axis::Z),
    )
    .expect("void");
    assert_eq!(r.bodies[0].body.shell_ids().len(), 2);
    let (v, _) = checked(&r, "void");
    assert!((v - (64.0 - 4.0 * PI / 3.0)).abs() < 1e-9, "{v}");
}

/// A cone apex resting on a face from inside the target: the cavity touches the outside at
/// the apex (an isolated singular point of the intersection, not a tangent point).
#[test]
fn a_cone_apex_touching_a_face_from_inside_is_non_manifold() {
    let target = aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    for (apex, up) in [
        ([2.0, 2.0, 0.0], false),
        ([1.4, 2.6, 0.0], false),
        ([2.0, 2.0, 4.0], true),
        ([2.7, 1.2, 4.0], true),
    ] {
        let k = cone("k", apex, 1.0, 2.0, up);
        let e = op(BodyOp::Cut, &target, &k).expect_err("apex contact");
        assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "{apex:?}: {e}");
        // Intersect: the cone itself.
        let r = op(BodyOp::Intersect, &target, &k).expect("intersect");
        let (v, _) = checked(&r, "intersect");
        assert!((v - PI * 2.0 / 3.0).abs() < 1e-9, "{apex:?}: {v}");
    }
}

/// An intersection whose result touches itself at a sphere pole: the target's bottom face
/// passes through the pole of a cavity of the tool.
#[test]
fn an_intersection_pinched_at_a_pole_is_non_manifold() {
    // Tool: a box with a spherical void (clear of its faces).
    let outer = aabox("k0", [0.0, 0.0, -1.0], [4.0, 4.0, 4.0]);
    for (x, y) in [(2.0, 2.0), (1.6, 2.3)] {
        let cav = sphere("c", [x, y, 1.0], 1.0, Axis::Z);
        let tool = op(BodyOp::Cut, &outer, &cav).expect("void");
        assert_eq!(tool.bodies[0].body.shell_ids().len(), 2);
        let tool = tool.bodies[0].body.clone();
        // Target: everything above z = 0, which passes through the void's south pole.
        let target = aabox("t", [-1.0, -1.0, 0.0], [6.0, 6.0, 5.0]);
        let e = op(BodyOp::Intersect, &target, &tool).expect_err("pinched at the pole");
        assert_eq!(e.code(), "BOOLEAN_NON_MANIFOLD", "({x}, {y}): {e}");
        // Lower the target by 0.5: the void is cut open, a valid body.
        let target = aabox("t", [-1.0, -1.0, 0.5], [6.0, 6.0, 5.0]);
        let r = op(BodyOp::Intersect, &target, &tool).expect("open void");
        let (v, _) = checked(&r, "open");
        // [0,4]²×[0.5,3] minus the ball above z = 0.5 (the ball minus its cap of height
        // 0.5 below that plane).
        let want = 16.0 * 2.5 - (4.0 * PI / 3.0 - (PI * 0.5 * 0.5 * (3.0 - 0.5) / 3.0));
        assert!(
            (v - want).abs() < 1e-9 * want.max(1.0),
            "({x}, {y}): {v} vs {want}"
        );
    }
}

/// Near-coincident faces, swept from well below the intersection's coincidence resolution
/// to well above the linear tolerance. Each case is either a valid body with the closed-form
/// volume (up to the offset times the area it moved), or `FORGE_BOOLEAN_NEAR_COINCIDENT`
/// with the measured offset; away from the band (≤ 1e-9, ≥ 1e-5) it must succeed.
#[test]
fn near_coincident_faces_succeed_or_say_so() {
    let eps = [1e-10, 1e-9, 1e-8, 3e-8, 1e-7, 5e-7, 1e-6, 3e-6, 1e-5, 1e-4];
    let target = aabox("t", [0.0, 0.0, 0.0], [4.0, 4.0, 4.0]);
    let mut band = 0;
    for e in eps {
        // (operation, tool, exact volume, what)
        let cases: Vec<(BodyOp, Body, f64, &str)> = vec![
            (
                BodyOp::Join,
                aabox("k", [1.0, 1.0, 2.0], [2.0, 2.0, 2.0 + e]),
                64.0 + 4.0 * e,
                "boss flush with the top (+ε)",
            ),
            (
                BodyOp::Cut,
                aabox("k", [1.0, 1.0, 2.0], [2.0, 2.0, 2.0 + e]),
                64.0 - 8.0,
                "pocket through the top (+ε)",
            ),
            (
                BodyOp::Cut,
                aabox("k", [1.0, 1.0, 2.0], [2.0, 2.0, 2.0 - e]),
                64.0 - 4.0 * (2.0 - e),
                "pocket ε under the top",
            ),
            (
                BodyOp::Intersect,
                aabox("k", [1.0, 1.0, 2.0], [2.0, 2.0, 2.0 + e]),
                8.0,
                "intersect through the top (+ε)",
            ),
            (
                BodyOp::Join,
                aabox("k", [4.0 + e, 1.0, 1.0], [2.0, 2.0, 2.0]),
                f64::NAN,
                "side by side, gap ε",
            ),
            (
                BodyOp::Join,
                aabox("k", [4.0 - e, 1.0, 1.0], [2.0, 2.0, 2.0]),
                64.0 + 4.0 * (2.0 - e),
                "side by side, overlap ε",
            ),
        ];
        for (o, k, want, what) in cases {
            let r = op(o, &target, &k);
            match &r {
                Ok(res) => {
                    let (v, a) = outcome_volume(res, &target, &k, what);
                    if want.is_finite() {
                        let tol = 1e-9 * want + 2.0 * e * a;
                        assert!((v - want).abs() <= tol, "ε={e:e} {what}: {v} vs {want}");
                    }
                }
                Err(err) => {
                    let c = err.code();
                    let gap_ok = want.is_nan() && c == "BOOLEAN_NO_INTERSECTION";
                    assert!(
                        c == "FORGE_BOOLEAN_NEAR_COINCIDENT" || gap_ok,
                        "ε={e:e} {what}: {c} {err}"
                    );
                    if c == "FORGE_BOOLEAN_NEAR_COINCIDENT" {
                        band += 1;
                        assert!(
                            (1e-9..1e-5).contains(&e),
                            "ε={e:e} {what}: near-coincident outside the band"
                        );
                        let d = serde_json::to_value(err.details()).expect("details");
                        let off = d["offset"].as_f64().expect("offset");
                        assert!(off <= 10.0 * e + 1e-9, "ε={e:e} {what}: offset {off}");
                    }
                }
            }
        }
    }
    eprintln!("near-coincident band cases: {band}");
}

/// Concentric spheres and coaxial cylinders offset by ε: a valid body with the exact
/// volume, or `FORGE_BOOLEAN_NEAR_COINCIDENT`.
#[test]
fn near_coincident_curved_faces_succeed_or_say_so() {
    for e in [1e-9, 3e-8, 1e-7, 3e-7, 1e-6, 3e-6, 1e-5, 1e-4] {
        let outer = sphere("a", [0.0, 0.0, 0.0], 2.0, Axis::Z);
        let inner = sphere("b", [0.0, 0.0, 0.0], 2.0 - e, Axis::Z);
        let r = op(BodyOp::Cut, &outer, &inner);
        let want = 4.0 * PI / 3.0 * (8.0 - (2.0 - e).powi(3));
        match &r {
            Ok(res) => {
                let (v, a) = outcome_volume(res, &outer, &inner, "shell");
                assert!(
                    (v - want).abs() <= 1e-9 * 34.0 + 2.0 * e * a,
                    "ε={e:e}: {v} vs {want}"
                );
            }
            Err(err) => assert_eq!(
                err.code(),
                "FORGE_BOOLEAN_NEAR_COINCIDENT",
                "ε={e:e} spheres: {err}"
            ),
        }
        let a = zcyl("a", [0.0, 0.0], 2.0, 0.0, 4.0);
        let b = zcyl("b", [0.0, 0.0], 2.0 + e, 1.0, 2.0);
        let r = op(BodyOp::Join, &a, &b);
        let want = PI * 4.0 * 2.0 + PI * (2.0 + e) * (2.0 + e) * 2.0;
        match &r {
            Ok(res) => {
                let (v, ar) = outcome_volume(res, &a, &b, "cylinders");
                assert!(
                    (v - want).abs() <= 1e-9 * want + 2.0 * e * ar,
                    "ε={e:e}: {v} vs {want}"
                );
            }
            Err(err) => assert_eq!(
                err.code(),
                "FORGE_BOOLEAN_NEAR_COINCIDENT",
                "ε={e:e} cylinders: {err}"
            ),
        }
        if e >= 1e-5 || e <= 1e-9 {
            assert_eq!(
                code(&r),
                "OK",
                "ε={e:e}: cylinders outside the band must succeed"
            );
        }
    }
}

/// SPEC [R-3] for near-coincident faces (review round 4), the same for every operation:
/// - aligned faces at most `LINEAR_TOLERANCE` (1e-6 mm) apart are **coincident**: the tool is
///   translated onto the target (by at most the tolerance), and the result is the
///   coincident configuration's, its volume within `|d| × face area` of it;
/// - farther apart they are distinct: boxes give the exact volumes; where the boolean cannot
///   separate distinct faces closer than 1e-5 mm (two circles on a cap 3e-6 apart) it says
///   so with `FORGE_BOOLEAN_NEAR_COINCIDENT` and the measured separation;
/// - coaxial cylinders whose radii differ by at most the tolerance are coincident per [R-3]
///   too, but no translation makes them one surface: `FORGE_BOOLEAN_NEAR_COINCIDENT`, with
///   the reason.
#[test]
fn near_coincident_band_is_one_rule_for_every_operation() {
    let ops = [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect];
    // A box whose face x = 2 is offset by d from the target's face x = 2 (both signs: the
    // tool's face just outside or just inside the target).
    let target = aabox("t", [0.0, 0.0, 0.0], [2.0, 2.0, 2.0]);
    for d in [
        3e-8, 1e-7, 5e-7, 6e-7, 8e-7, 9.9e-7, 1e-6, 1.5e-6, 3e-6, 9e-6, -3e-8, -5e-7, -6e-7,
        -9.9e-7, -1e-6, -1.5e-6, -9e-6, 1e-5, 3e-5, -3e-5,
    ] {
        let k = aabox("k", [1.0, 0.5, 0.5], [1.0 + d, 1.0, 1.0]);
        for o in ops {
            let r = op(o, &target, &k);
            let res = r.unwrap_or_else(|e| panic!("d={d:e} {o:?}: {} {e}", e.code()));
            let (v, _) = outcome_volume(&res, &target, &k, &format!("d={d:e} {o:?}"));
            let (want, tol) = if d.abs() <= 1e-6 {
                // Coincident: the tool's face on the target's, the tool moved by |d|.
                let w = match o {
                    BodyOp::Join => 8.0,
                    BodyOp::Cut => 7.0,
                    BodyOp::Intersect => 1.0,
                };
                (w, d.abs() * (1.0 + 1e-9) + 1e-12)
            } else {
                let w = match o {
                    BodyOp::Join => 8.0 + d.max(0.0),
                    BodyOp::Cut => 8.0 - (1.0 + d.min(0.0)),
                    BodyOp::Intersect => 1.0 + d.min(0.0),
                };
                (w, 1e-9 * w)
            };
            assert!((v - want).abs() <= tol, "d={d:e} {o:?}: {v} vs {want}");
        }
    }
    // Coaxial cylinders of radius 1 and 1 + d with overlapping heights, and equal
    // cylinders whose axes are d apart.
    let a = zcyl("a", [0.0, 0.0], 1.0, 0.0, 2.0);
    for d in [1e-7, 1e-6, 3e-6] {
        for (what, k) in [
            ("radius", zcyl("k", [0.0, 0.0], 1.0 + d, 1.0, 2.0)),
            ("axis", zcyl("k", [d, 0.0], 1.0, 1.0, 2.0)),
        ] {
            for o in ops {
                let r = op(o, &a, &k);
                if what == "axis" && d <= 1e-6 {
                    // Snapped: the coaxial configuration (π per unit of height).
                    let res = r.unwrap_or_else(|e| panic!("{what} d={d:e} {o:?}: {e}"));
                    let (v, _) = outcome_volume(&res, &a, &k, "cylinders");
                    let want = match o {
                        BodyOp::Join => 3.0 * PI,
                        BodyOp::Cut | BodyOp::Intersect => PI,
                    };
                    assert!(
                        (v - want).abs() <= 2.0 * PI * 2.0 * d + 1e-12,
                        "{what} d={d:e} {o:?}: {v} vs {want}"
                    );
                    continue;
                }
                let e = r.expect_err(&format!("{what} d={d:e} {o:?}"));
                assert_eq!(
                    e.code(),
                    "FORGE_BOOLEAN_NEAR_COINCIDENT",
                    "{what} d={d:e} {o:?}: {e}"
                );
                let det = serde_json::to_value(e.details()).expect("details");
                let off = det["offset"].as_f64().expect("offset");
                assert!(
                    (off - d).abs() <= 1e-9,
                    "{what} d={d:e} {o:?}: offset {off}"
                );
                let reason = det["reason"].as_str().expect("reason");
                if d <= 1e-6 {
                    assert!(
                        reason.contains("no translation"),
                        "{what} d={d:e}: {reason}"
                    );
                }
            }
        }
    }
}

/// A slab on the plane through (5, 5, 10) with normal (sin t, 0, cos t), 5 thick, over the
/// box [0, 10]³'s top face: A ∩ slab = 125·tan t.
fn tilted_slab(t: f64) -> Body {
    let (s, c) = (t.sin(), t.cos());
    let l = |id: &str, a: [f64; 2], b: [f64; 2]| SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    };
    Operand {
        feature: "k".into(),
        sketch: forge_ir::SketchFeature {
            id: "s_k".into(),
            name: "s_k".into(),
            suppressed: false,
            plane: PlaneSpec::Frame(Frame {
                origin: [5.0, 5.0, 10.0],
                normal: [s, 0.0, c],
                x_dir: [c, 0.0, -s],
            }),
            curves: vec![
                l("b", [-6.0, -6.0], [6.0, -6.0]),
                l("r", [6.0, -6.0], [6.0, 6.0]),
                l("t", [6.0, 6.0], [-6.0, 6.0]),
                l("l", [-6.0, 6.0], [-6.0, -6.0]),
            ],
        },
        sweep: Sweep::Extrude {
            distance: 5.0,
            direction: SweepDirection::Normal,
        },
    }
    .build()
    .expect("slab")
}

/// The review's near-tangent and small-angle configurations (round 4), one rule for every
/// operation and sphere axis:
/// - a slab whose bottom plane crosses the box's top face at an angle `t`: while the faces
///   never part by more than 1e-5 mm over the top face (`t ≤ 1e-6`), the boolean cannot
///   separate them and says so (`FORGE_BOOLEAN_NEAR_COINCIDENT`, "cross at"); from
///   `t = 1e-5` the exact wedge `125 tan t`;
/// - a cylinder or sphere dipping `h` into the top face: within the linear tolerance
///   (`h ≤ 1e-6`) the contact is a tangency (SPEC [R-3]: the tool is snapped onto it), so
///   the join and cut have no intersection and the intersection is empty (the 1e-6 mm
///   sliver of review round 4 is gone); a little deeper, the exact volume or
///   `FORGE_BOOLEAN_NEAR_COINCIDENT`; from 1e-4 the exact volume.
#[test]
fn near_tangent_and_small_angle_contacts_follow_one_rule() {
    let bx = aabox("t", [0.0, 0.0, 0.0], [10.0, 10.0, 10.0]);
    let ops = [BodyOp::Join, BodyOp::Cut, BodyOp::Intersect];
    for t in [1e-7, 1e-6, 1e-5, 1e-4, 3e-4, 1e-3] {
        let k = tilted_slab(t);
        for o in ops {
            let r = op(o, &bx, &k);
            if t <= 1e-6 {
                let e = r.expect_err(&format!("t={t:e} {o:?}"));
                assert_eq!(
                    e.code(),
                    "FORGE_BOOLEAN_NEAR_COINCIDENT",
                    "t={t:e} {o:?}: {e}"
                );
                let det = serde_json::to_value(e.details()).expect("details");
                assert!(
                    det["reason"]
                        .as_str()
                        .is_some_and(|x| x.contains("cross at")),
                    "{det}"
                );
                assert!(det["offset"].as_f64().is_some_and(|x| x <= 1e-5), "{det}");
                continue;
            }
            let res = r.unwrap_or_else(|e| panic!("t={t:e} {o:?}: {} {e}", e.code()));
            let (v, _) = outcome_volume(&res, &bx, &k, "tilt");
            let want = match o {
                BodyOp::Join => 1720.0 - 125.0 * t.tan(),
                BodyOp::Cut => 1000.0 - 125.0 * t.tan(),
                BodyOp::Intersect => 125.0 * t.tan(),
            };
            assert!(
                (v - want).abs() <= 1e-9 * 1720.0,
                "t={t:e} {o:?}: {v} vs {want}"
            );
        }
    }
    // Two balls, and two parallel cylinders, touching within the tolerance (both signs of
    // the gap): a tangency, whatever the balls' axes.
    for gap in [-8e-7, -2e-7, 3e-7, 1e-6] {
        for ax in 0..3 {
            let s1 = forge_ops::boolean::corpus::sphere_operand("s", [0.0, 0.0, 0.0], 2.0, ax)
                .build()
                .expect("s");
            let s2 = forge_ops::boolean::corpus::sphere_operand(
                "t",
                [4.0 + gap, 0.0, 0.0],
                2.0,
                (ax + 1) % 3,
            )
            .build()
            .expect("t");
            for o in ops {
                let want = if o == BodyOp::Intersect {
                    "BOOLEAN_EMPTY_RESULT"
                } else {
                    "BOOLEAN_NO_INTERSECTION"
                };
                assert_eq!(
                    code(&op(o, &s1, &s2)),
                    want,
                    "balls gap {gap:e} axis {ax} {o:?}"
                );
            }
        }
        // Axes (0, 0) and (√8.75 + gap, 0.5): 3 + gap apart up to second order.
        let dx = (9.0f64 - 0.25).sqrt() + gap;
        let c1 = forge_ops::boolean::corpus::cylinder_operand("c", 2, [0.0, 0.0], 0.0, 1.5, 4.0)
            .build()
            .expect("c");
        let c2 = forge_ops::boolean::corpus::cylinder_operand("d", 2, [dx, 0.5], 1.0, 1.5, 4.0)
            .build()
            .expect("d");
        let gap_true = (dx * dx + 0.25).sqrt() - 3.0;
        assert!(
            (gap_true - gap).abs() < 0.2 * gap.abs(),
            "{gap_true} vs {gap}"
        );
        for o in ops {
            let want = if o == BodyOp::Intersect {
                "BOOLEAN_EMPTY_RESULT"
            } else {
                "BOOLEAN_NO_INTERSECTION"
            };
            assert_eq!(code(&op(o, &c1, &c2)), want, "cylinders gap {gap:e} {o:?}");
        }
    }
    let segment =
        |r: f64, h: f64| r * r * ((r - h) / r).acos() - (r - h) * (2.0 * r * h - h * h).sqrt();
    let cap = |r: f64, h: f64| PI * h * h * (3.0 * r - h) / 3.0;
    let mut tools: Vec<(String, f64, Body, f64, f64)> = Vec::new();
    for h in [1e-9, 1e-8, 1e-7, 1e-6, 2e-6, 1e-5, 1e-4] {
        let k =
            forge_ops::boolean::corpus::cylinder_operand("c", 0, [5.0, 12.0 - h], -1.0, 2.0, 12.0)
                .build()
                .expect("c");
        let vk = PI * 4.0 * 12.0;
        tools.push((
            format!("x-cylinder h={h:e}"),
            h,
            k,
            vk,
            segment(2.0, h) * 10.0,
        ));
        for ax in 0..3 {
            let k = forge_ops::boolean::corpus::sphere_operand("s", [5.0, 5.0, 12.0 - h], 2.0, ax)
                .build()
                .expect("s");
            tools.push((
                format!("sphere axis {ax} h={h:e}"),
                h,
                k,
                4.0 / 3.0 * PI * 8.0,
                cap(2.0, h),
            ));
        }
    }
    for (what, h, k, vk, vi) in &tools {
        for o in ops {
            let r = op(o, &bx, k);
            if *h <= 1e-6 {
                let want = if o == BodyOp::Intersect {
                    "BOOLEAN_EMPTY_RESULT"
                } else {
                    "BOOLEAN_NO_INTERSECTION"
                };
                assert_eq!(code(&r), want, "{what} {o:?}");
                continue;
            }
            match r {
                Ok(res) => {
                    let (v, _) = outcome_volume(&res, &bx, k, what);
                    let want = match o {
                        BodyOp::Join => 1000.0 + vk - vi,
                        BodyOp::Cut => 1000.0 - vi,
                        BodyOp::Intersect => *vi,
                    };
                    assert!(
                        (v - want).abs() <= 1e-9 * (1000.0 + vk),
                        "{what} {o:?}: {v} vs {want}"
                    );
                }
                Err(e) => {
                    assert!(*h < 1e-4, "{what} {o:?}: {} {e}", e.code());
                    assert_eq!(
                        e.code(),
                        "FORGE_BOOLEAN_NEAR_COINCIDENT",
                        "{what} {o:?}: {e}"
                    );
                }
            }
        }
    }
}
