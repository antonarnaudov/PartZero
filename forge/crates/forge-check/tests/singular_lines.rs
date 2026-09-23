//! Faces that reach a singular line (sphere pole, spindle-torus axis point, horn-torus
//! centre) against closed forms: the silent-wrong repros of the Phase 0 audit.
//!
//! - **H1**: a revolve within ~4e-7° of 360° dropped every face running from the axis to
//!   the axis (its two meridians were joined as an ε-wide sliver instead of a `2π − ε`
//!   domain), so volume, area and centroid came out wrong with the body reported valid.
//! - **H2**: the tight box of 360° spindle (lemon/apple) and horn faces included torus
//!   critical points beyond the singular line (the other sheet, the far side of the horn).
//!
//! Every expectation is a closed form (Pappus: `V = θ·∫ρ dA`, `A = θ·∫ρ ds`).

use forge_check::{Issue, bbox, body_metrics, mass_properties, validate};
use forge_core::Tolerance;
use forge_core::math::{self, PI};
use forge_core::topo::{Body, Severity};
use forge_ir::{Document, Feature};
use forge_ops::{regions, revolve, sketch_frame};

fn errors(issues: &[Issue]) -> Vec<&Issue> {
    issues
        .iter()
        .filter(|i| i.severity == Severity::Error)
        .collect()
}

/// The bodies of a one-sketch, one-revolve document.
fn revolve_bodies(sketch_json: &str, plane: &str, angle: f64, direction: &str) -> Vec<Body> {
    let json = format!(
        r#"{{"schema":"aicad.ir/0","meta":{{"name":"t"}},"parts":[{{"id":"p1","name":"part",
        "features":[{{"type":"sketch","id":"s1","name":"profile","plane":"{plane}",
        "curves":{sketch_json}}},
        {{"type":"revolve","id":"r1","name":"spinner","sketch":"profile",
        "axis":{{"origin":[0,0],"direction":[0,1]}},"angle":{angle:?},
        "direction":"{direction}"}}]}}]}}"#
    );
    let doc: Document = forge_ir::from_json(&json).expect("valid IR");
    let feats = &doc.parts[0].features;
    let (Feature::Sketch(sk), Feature::Revolve(v)) = (&feats[0], &feats[1]) else {
        panic!("sketch + revolve")
    };
    let frame = sketch_frame(&sk.plane).expect("frame");
    regions(sk, &Tolerance::IR_DEFAULT)
        .expect("regions")
        .iter()
        .map(|r| revolve(r, &frame, &v.axis, v.angle, v.direction, &v.name).expect("revolve"))
        .collect()
}

struct Want {
    volume: f64,
    area: f64,
    /// Centroid component along the revolve axis (world z for plane XZ).
    axial_centroid: Option<f64>,
    bbox: Option<([f64; 3], [f64; 3])>,
}

fn assert_body(what: &str, body: &Body, want: &Want) {
    let issues = validate(body);
    assert!(errors(&issues).is_empty(), "{what}: {issues:#?}");
    let mp = mass_properties(body).expect("mass properties");
    let rel = |a: f64, b: f64| (a - b).abs() / b.abs();
    assert!(
        rel(mp.volume, want.volume) < 1e-10,
        "{what}: volume {} vs {}",
        mp.volume,
        want.volume
    );
    assert!(
        rel(mp.area, want.area) < 1e-10,
        "{what}: area {} vs {}",
        mp.area,
        want.area
    );
    if let Some(z) = want.axial_centroid {
        assert!(
            (mp.centroid[2] - z).abs() < 1e-9,
            "{what}: centroid {:?} vs z = {z}",
            mp.centroid
        );
    }
    if let Some((lo, hi)) = want.bbox {
        let (bmin, bmax) = bbox(body).expect("bbox");
        for k in 0..3 {
            assert!(
                (bmin[k] - lo[k]).abs() < 1e-9 && (bmax[k] - hi[k]).abs() < 1e-9,
                "{what}: bbox {bmin:?}..{bmax:?} vs {lo:?}..{hi:?}"
            );
        }
    }
    let m = body_metrics(body).expect("metrics");
    assert!(m.valid, "{what}");
}

fn deg(a: f64) -> f64 {
    a * PI / 180.0
}

/// Angles that exercise the singular joins: near 360° on both sides of the old
/// `PERIOD_EPS` threshold, the largest `f64` below 360, ordinary, and tiny.
const ANGLES: [f64; 8] = [
    359.9999999,
    359.9999996,
    359.9999995,
    359.999_999_999_999_94,
    300.0,
    90.0,
    1e-4,
    1e-7,
];

// ---- H1: the pocket family (a sphere / spindle face from the axis to the axis) ---------

/// Profile: an 8×22 (or 9×22) rectangle on the axis with a pocket arc from (0,10) to
/// (0,0) bulging into it, centred at `(cx, 5)`.
fn pocket_sketch(cx: f64, width: f64) -> String {
    format!(
        r#"[{{"kind":"arc","id":"pocket","start":[0,10],"end":[0,0],"center":[{cx:?},5],"ccw":false}},
        {{"kind":"line","id":"ax1","start":[0,0],"end":[0,-10]}},
        {{"kind":"line","id":"bot","start":[0,-10],"end":[{width:?},-10]}},
        {{"kind":"line","id":"side","start":[{width:?},-10],"end":[{width:?},12]}},
        {{"kind":"line","id":"top","start":[{width:?},12],"end":[0,12]}},
        {{"kind":"line","id":"ax2","start":[0,12],"end":[0,10]}}]"#
    )
}

/// `(∫ρ dA, ∫ρ·z dA, region area, ∫ρ ds over the pocket arc)` of a pocket profile.
fn pocket_moments(cx: f64, width: f64) -> (f64, f64, f64, f64) {
    let r2 = 25.0 + cx * cx;
    let r = r2.sqrt();
    let d = cx.abs();
    // Circle segment cut off by the axis x = 0 on the side away from the centre (lemon,
    // cx < 0) or towards it (apple, cx > 0); cx = 0 is the half disc.
    let alpha = math::acos(d / r); // half-angle of the minor segment seen from the centre
    let minor_area = r2 * alpha - d * 5.0;
    let minor_moment = 2.0 / 3.0 * 125.0 - 2.0 * d * (r2 * alpha - d * 5.0) / 2.0;
    let (seg_area, seg_moment, arc_rho) = if cx < 0.0 {
        (minor_area, minor_moment, r * (10.0 - 2.0 * d * alpha))
    } else if cx > 0.0 {
        (
            PI * r2 - minor_area,
            2.0 / 3.0 * 125.0 + 2.0 * d * (PI * r2 / 2.0 - minor_area / 2.0),
            r * (2.0 * d * (PI - alpha) + 10.0),
        )
    } else {
        (PI * 12.5, 250.0 / 3.0, 50.0)
    };
    let rect_moment = width * width / 2.0 * 22.0;
    // ∫ρ·z dA: the rectangle, minus the segment (symmetric about z = 5).
    let rect_z = width * width / 2.0 * (144.0 - 100.0) / 2.0;
    (
        rect_moment - seg_moment,
        rect_z - 5.0 * seg_moment,
        width * 22.0 - seg_area,
        arc_rho,
    )
}

fn check_pocket(name: &str, cx: f64, width: f64) {
    let (m, mz, region, arc) = pocket_moments(cx, width);
    let sketch = pocket_sketch(cx, width);
    for angle in ANGLES {
        for direction in ["normal", "reverse", "symmetric"] {
            let bodies = revolve_bodies(&sketch, "XZ", angle, direction);
            assert_eq!(bodies.len(), 1);
            let th = deg(angle);
            let caps = if angle < 360.0 { 2.0 * region } else { 0.0 };
            let want = Want {
                volume: th * m,
                area: th * (width * 22.0 + width * width + arc) + caps,
                axial_centroid: Some(mz / m),
                bbox: (angle > 359.0).then_some(([-width, -width, -10.0], [width, width, 12.0])),
            };
            assert_body(&format!("{name} {angle}° {direction}"), &bodies[0], &want);
        }
    }
}

#[test]
fn sphere_pocket_revolved_near_360_keeps_its_sphere_face() {
    // Audit H1: at 359.9999999° Forge reported 4423.36 mm³ (the pocket missing) against
    // π·64·22 − 4/3·π·125 = 3899.76.
    check_pocket("pocket", 0.0, 8.0);
    let b = &revolve_bodies(&pocket_sketch(0.0, 8.0), "XZ", 359.9999999, "normal")[0];
    let v = mass_properties(b).expect("mass").volume;
    let full = PI * 64.0 * 22.0 - 4.0 / 3.0 * PI * 125.0;
    assert!((v / full - 359.9999999 / 360.0).abs() < 1e-12, "{v}");
}

#[test]
fn lemon_pocket_revolved_near_360_keeps_its_spindle_face() {
    check_pocket("lemon pocket", -2.0, 8.0);
}

#[test]
fn apple_pocket_revolved_near_360_keeps_its_spindle_face() {
    check_pocket("apple pocket", 2.0, 9.0);
}

// ---- H2: 360° spindle and horn faces, tight box ----------------------------------------

/// `∫_{a}^{b} √(R² − z²) dz`.
fn circ_int(r: f64, a: f64, b: f64) -> f64 {
    let f = |z: f64| 0.5 * (z * (r * r - z * z).sqrt() + r * r * math::asin(z / r));
    f(b) - f(a)
}

/// A spindle-torus lemon from the axis point `(0, zs)` to the equator `(xe, 0)` of the
/// circle of radius `r` centred at `(−c, 0)` (`xe = r − c`), closed by the line to the
/// origin and the axis. Returns `(V, A)` of the 360° revolve.
fn lemon_closed_form(c: f64, r: f64) -> (f64, f64) {
    let zs = (r * r - c * c).sqrt();
    // ∫∫ x dA = ½∫ (√(r² − z²) − c)² dz over z ∈ [−zs, 0].
    let moment = 0.5 * ((r * r + c * c) * zs - zs.powi(3) / 3.0 - 2.0 * c * circ_int(r, -zs, 0.0));
    let beta = math::asin(zs / r);
    let arc = r * (r * math::sin(beta) - c * beta); // ∫ρ ds over the arc
    let xe = r - c;
    (2.0 * PI * moment, 2.0 * PI * arc + PI * xe * xe)
}

fn check_lemon(what: &str, sketch: &str, c: f64, r: f64, up: bool) {
    let (v, a) = lemon_closed_form(c, r);
    let (xe, zs) = (r - c, (r * r - c * c).sqrt());
    for plane in ["XZ", "XY"] {
        let bodies = revolve_bodies(sketch, plane, 360.0, "normal");
        assert_eq!(bodies.len(), 1);
        let (h0, h1) = if up { (0.0, zs) } else { (-zs, 0.0) };
        // XZ: axis = world z, radial x/y. XY: axis = world y, radial x/z.
        let bbox = if plane == "XZ" {
            ([-xe, -xe, h0], [xe, xe, h1])
        } else {
            ([-xe, h0, -xe], [xe, h1, xe])
        };
        let want = Want {
            volume: v,
            area: a,
            axial_centroid: None,
            bbox: Some(bbox),
        };
        assert_body(&format!("{what} on {plane}"), &bodies[0], &want);
    }
}

#[test]
fn lemon_bbox_ends_at_the_axis_point() {
    // Audit H2: Forge reported [-2,-2,-10]..[8,2,0] against [-2,-2,-6]..[2,2,0].
    check_lemon(
        "lemon",
        r#"[{"kind":"arc","id":"arc","start":[0,-6],"end":[2,0],"center":[-8,0],"ccw":true},
            {"kind":"line","id":"top","start":[2,0],"end":[0,0]},
            {"kind":"line","id":"ax","start":[0,0],"end":[0,-6]}]"#,
        8.0,
        10.0,
        false,
    );
}

#[test]
fn upward_lemon_bbox_ends_at_the_axis_point() {
    // Audit H2: Forge reported ±18 in x/y against ±2.
    check_lemon(
        "upward lemon",
        r#"[{"kind":"arc","id":"arc","start":[2,0],"end":[0,6],"center":[-8,0],"ccw":true},
            {"kind":"line","id":"ax","start":[0,6],"end":[0,0]},
            {"kind":"line","id":"bot","start":[0,0],"end":[2,0]}]"#,
        8.0,
        10.0,
        true,
    );
}

#[test]
fn half_lemon_bbox_ends_at_the_axis_point() {
    // Audit H2 (lemonhalf_360): Forge reported z_min = −5 (the tube's bottom on the other
    // sheet) against −√21.
    let zs = 21f64.sqrt();
    check_lemon(
        "half lemon",
        &format!(
            r#"[{{"kind":"arc","id":"arc","start":[0,{:?}],"end":[3,0],"center":[-2,0],"ccw":true}},
            {{"kind":"line","id":"l","start":[3,0],"end":[0,0]}},
            {{"kind":"line","id":"ax","start":[0,0],"end":[0,{:?}]}}]"#,
            -zs, -zs
        ),
        2.0,
        5.0,
        false,
    );
}

#[test]
fn horn_bbox_ends_at_the_horn_centre() {
    // Audit H2: Forge reported [-8,-8,-4]..[8,8,4] against [-4,-4,-4]..[4,4,0].
    let sketch = r#"[{"kind":"arc","id":"arc","start":[0,0],"end":[4,-4],"center":[4,0],"ccw":true},
        {"kind":"line","id":"l","start":[4,-4],"end":[0,-4]},
        {"kind":"line","id":"ax","start":[0,-4],"end":[0,0]}]"#;
    // Region: the 4×4 square minus the quarter disc centred at (4, 0).
    let moment = 32.0 - (16.0 * PI - 64.0 / 3.0);
    let volume = 2.0 * PI * moment;
    let area = 2.0 * PI * 4.0 * (2.0 * PI - 4.0) + 16.0 * PI;
    for (plane, bbox) in [
        ("XZ", ([-4.0, -4.0, -4.0], [4.0, 4.0, 0.0])),
        ("XY", ([-4.0, -4.0, -4.0], [4.0, 0.0, 4.0])),
    ] {
        let bodies = revolve_bodies(sketch, plane, 360.0, "normal");
        let want = Want {
            volume,
            area,
            axial_centroid: None,
            bbox: Some(bbox),
        };
        assert_body(&format!("horn on {plane}"), &bodies[0], &want);
    }
}

#[test]
fn upward_horn_bbox_ends_at_the_horn_centre() {
    let sketch = r#"[{"kind":"arc","id":"arc","start":[4,4],"end":[0,0],"center":[4,0],"ccw":true},
        {"kind":"line","id":"ax","start":[0,0],"end":[0,4]},
        {"kind":"line","id":"l","start":[0,4],"end":[4,4]}]"#;
    let moment = 32.0 - (16.0 * PI - 64.0 / 3.0);
    let bodies = revolve_bodies(sketch, "XZ", 360.0, "normal");
    let want = Want {
        volume: 2.0 * PI * moment,
        area: 2.0 * PI * 4.0 * (2.0 * PI - 4.0) + 16.0 * PI,
        axial_centroid: None,
        bbox: Some(([-4.0, -4.0, 0.0], [4.0, 4.0, 4.0])),
    };
    assert_body("upward horn", &bodies[0], &want);
}

#[test]
fn lemon_and_horn_faces_below_360_keep_their_boxes() {
    // Partial revolves of the same profiles (contractible domains through the singular
    // joins): the box is the swept profile's, checked here at 180° about world z, where
    // the sweep covers x ≥ 0 … by symmetry y ∈ [0, ρ_max].
    let lemon = r#"[{"kind":"arc","id":"arc","start":[0,-6],"end":[2,0],"center":[-8,0],"ccw":true},
        {"kind":"line","id":"top","start":[2,0],"end":[0,0]},
        {"kind":"line","id":"ax","start":[0,0],"end":[0,-6]}]"#;
    let (v, a) = lemon_closed_form(8.0, 10.0);
    let region = {
        // ∫∫ dA = ∫ (√(100 − z²) − 8) dz over [−6, 0].
        circ_int(10.0, -6.0, 0.0) - 48.0
    };
    let bodies = revolve_bodies(lemon, "XZ", 180.0, "normal");
    let (lo, hi) = bbox(&bodies[0]).expect("bbox");
    let want = Want {
        volume: v / 2.0,
        area: a / 2.0 + 2.0 * region,
        axial_centroid: None,
        bbox: None,
    };
    assert_body("lemon 180°", &bodies[0], &want);
    assert!(
        (lo[2] + 6.0).abs() < 1e-12 && hi[2].abs() < 1e-12,
        "{lo:?} {hi:?}"
    );
    assert!(
        (hi[0] - 2.0).abs() < 1e-12 && (lo[0] + 2.0).abs() < 1e-12,
        "{lo:?} {hi:?}"
    );
}

// ---- Profiles the oracle (OCCT) cannot revolve: Forge against closed forms only ---------
//
// OCCT errors on these, so `oracle diff` leaves Forge's result unverified (ROBUSTNESS);
// these closed forms are the only check of it.

/// `(∫ρ dA, ∫ρ ds, profile area)` → the `Want` of a revolve by `angle` degrees.
fn pappus(angle: f64, moment: f64, curve_moment: f64, profile_area: f64) -> (f64, f64) {
    let t = deg(angle);
    let caps = if angle >= 360.0 {
        0.0
    } else {
        2.0 * profile_area
    };
    (t * moment, t * curve_moment + caps)
}

#[test]
fn circle_touching_the_axis_within_tolerance_revolves_to_a_horn_torus() {
    // Audit repro `horncut`: centre (5, 0), radius 5.0000005 crosses the axis by 5e-7, less
    // than the IR linear tolerance, so the profile touches it: a horn torus R = r = 5. The
    // expectations hold to 1e-6 (the snap is within the tolerance, relative 2e-7).
    let sketch = r#"[{"kind":"circle","id":"c","center":[5,0],"radius":5.0000005}]"#;
    for angle in [360.0, 359.9999999, 300.0, 90.0, 1e-4] {
        let bodies = revolve_bodies(sketch, "XZ", angle, "normal");
        assert_eq!(bodies.len(), 1, "{angle}");
        let body = &bodies[0];
        let issues = validate(body);
        assert!(errors(&issues).is_empty(), "{angle}: {issues:#?}");
        let (v, a) = pappus(angle, 125.0 * PI, 50.0 * PI, 25.0 * PI);
        let mp = mass_properties(body).expect("mass");
        let rel = |x: f64, y: f64| (x - y).abs() / y.abs();
        assert!(
            rel(mp.volume, v) < 1e-6,
            "{angle}: volume {} vs {v}",
            mp.volume
        );
        assert!(rel(mp.area, a) < 1e-6, "{angle}: area {} vs {a}", mp.area);
        if angle >= 360.0 {
            let (lo, hi) = bbox(body).expect("bbox");
            for k in 0..3 {
                let r = if k == 2 { 5.0 } else { 10.0 };
                assert!(
                    (lo[k] + r).abs() < 1e-6 && (hi[k] - r).abs() < 1e-6,
                    "{lo:?} {hi:?}"
                );
            }
        }
        assert!(body_metrics(body).expect("metrics").valid);
    }
}

#[test]
fn arrow_touching_the_axis_twice_matches_closed_form() {
    // Audit repro `arrow`: triangle (0,0),(5,5),(0,10) minus (0,0),(3,5),(0,10); four cone
    // faces meeting at two apexes on the axis.
    let sketch = r#"[{"kind":"line","id":"e0","start":[0,0],"end":[5,5]},
        {"kind":"line","id":"e1","start":[5,5],"end":[0,10]},
        {"kind":"line","id":"e2","start":[0,10],"end":[3,5]},
        {"kind":"line","id":"e3","start":[3,5],"end":[0,0]}]"#;
    let moment = 25.0 * 5.0 / 3.0 - 15.0;
    let curve_moment = 25.0 * math::sqrt(2.0) + 3.0 * math::sqrt(34.0);
    for angle in [360.0, 359.9999999, 200.0, 1e-4] {
        let bodies = revolve_bodies(sketch, "XZ", angle, "normal");
        let (volume, area) = pappus(angle, moment, curve_moment, 10.0);
        let full = angle >= 360.0;
        let want = Want {
            volume,
            area,
            axial_centroid: full.then_some(5.0),
            bbox: full.then_some(([-5.0, -5.0, 0.0], [5.0, 5.0, 10.0])),
        };
        assert_body(&format!("arrow {angle}°"), &bodies[0], &want);
    }
}

#[test]
fn sphere_pinched_by_two_cones_matches_closed_form() {
    // Audit repro `spherepinch`: half disc r = 5 minus the triangle (0,5),(3,0),(0,−5); a
    // sphere face and two cone faces meeting at the poles.
    let sketch = r#"[{"kind":"arc","id":"a","start":[0,-5],"end":[0,5],"center":[0,0],"ccw":true},
        {"kind":"line","id":"l1","start":[0,5],"end":[3,0]},
        {"kind":"line","id":"l2","start":[3,0],"end":[0,-5]}]"#;
    let moment = 250.0 / 3.0 - 15.0;
    let curve_moment = 50.0 + 3.0 * math::sqrt(34.0);
    for angle in [360.0, 359.9999999, 200.0, 1e-4] {
        let bodies = revolve_bodies(sketch, "XZ", angle, "normal");
        let (volume, area) = pappus(angle, moment, curve_moment, 12.5 * PI - 15.0);
        let full = angle >= 360.0;
        let want = Want {
            volume,
            area,
            axial_centroid: full.then_some(0.0),
            bbox: full.then_some(([-5.0, -5.0, -5.0], [5.0, 5.0, 5.0])),
        };
        assert_body(&format!("spherepinch {angle}°"), &bodies[0], &want);
    }
}
