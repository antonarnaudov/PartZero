//! Property tests on random profiles: extrude volume = region area × distance
//! (1e-12 relative), revolve volume by Pappus = area × centroid radius × angle
//! (1e-10 relative), revolve surface area by Pappus for polygon profiles, centroids,
//! and validity of every produced body.

use forge_check::{bbox, mass_properties, validate};
use forge_core::Tolerance;
use forge_core::linalg::{Frame, Vec3};
use forge_core::math::{self, PI, TAU};
use forge_core::topo::{Body, Severity};
use forge_ir::{
    Frame as IrFrame, NamedPlane, PlaneSpec, SketchAxis, SketchCurve, SketchFeature, SweepDirection,
};
use forge_ops::{extrude, regions, revolve, sketch_frame};
use proptest::prelude::*;

fn sk(plane: PlaneSpec, curves: Vec<SketchCurve>) -> SketchFeature {
    SketchFeature {
        id: "s".into(),
        name: "s".into(),
        suppressed: false,
        plane,
        curves,
    }
}

fn line(id: &str, a: [f64; 2], b: [f64; 2]) -> SketchCurve {
    SketchCurve::Line {
        id: id.into(),
        start: a,
        end: b,
    }
}

fn polygon(pts: &[[f64; 2]]) -> Vec<SketchCurve> {
    (0..pts.len())
        .map(|k| line(&format!("p{k}"), pts[k], pts[(k + 1) % pts.len()]))
        .collect()
}

fn star(n: usize, radii: &[f64], c: [f64; 2], phase: f64) -> Vec<[f64; 2]> {
    (0..n)
        .map(|k| {
            let a = phase + TAU * k as f64 / n as f64;
            let r = radii[k % radii.len()];
            [c[0] + r * math::cos(a), c[1] + r * math::sin(a)]
        })
        .collect()
}

/// `(area, centroid)` of a simple polygon.
fn polygon_props(p: &[[f64; 2]]) -> (f64, [f64; 2]) {
    let n = p.len();
    let (mut a2, mut cx, mut cy) = (0.0, 0.0, 0.0);
    for i in 0..n {
        let (x0, y0, x1, y1) = (p[i][0], p[i][1], p[(i + 1) % n][0], p[(i + 1) % n][1]);
        let c = x0 * y1 - x1 * y0;
        a2 += c;
        cx += (x0 + x1) * c;
        cy += (y0 + y1) * c;
    }
    (0.5 * a2.abs(), [cx / (3.0 * a2), cy / (3.0 * a2)])
}

fn assert_valid(b: &Body) {
    let errs: Vec<_> = validate(b)
        .into_iter()
        .filter(|i| i.severity == Severity::Error)
        .collect();
    assert!(errs.is_empty(), "{errs:#?}");
}

fn rel(a: f64, b: f64) -> f64 {
    (a - b).abs() / b.abs()
}

fn plane_strategy() -> impl Strategy<Value = PlaneSpec> {
    let named = prop_oneof![
        Just(PlaneSpec::Named(NamedPlane::XY)),
        Just(PlaneSpec::Named(NamedPlane::XZ)),
        Just(PlaneSpec::Named(NamedPlane::YZ)),
    ];
    let explicit = (
        prop::array::uniform3(-50.0..50.0f64),
        prop::array::uniform3(-1.0..1.0f64),
        prop::array::uniform3(-1.0..1.0f64),
    )
        .prop_filter_map("degenerate frame", |(o, n, a)| {
            let n = Vec3::from(n).normalize()?;
            let a = Vec3::from(a);
            let x = a - n * a.dot(n);
            if x.norm() < 0.2 {
                return None;
            }
            Some(PlaneSpec::Frame(IrFrame {
                origin: o,
                normal: n.to_array(),
                x_dir: x.to_array(),
            }))
        });
    prop_oneof![named, explicit]
}

fn direction_strategy() -> impl Strategy<Value = SweepDirection> {
    prop_oneof![
        Just(SweepDirection::Normal),
        Just(SweepDirection::Reverse),
        Just(SweepDirection::Symmetric),
    ]
}

/// Region metrics of the single region of `curves`, plus the body of `op`.
fn one_region(plane: &PlaneSpec, curves: Vec<SketchCurve>) -> (forge_ops::Region, Frame) {
    let s = sk(plane.clone(), curves);
    let mut r = regions(&s, &Tolerance::IR_DEFAULT).expect("regions");
    assert_eq!(r.len(), 1);
    (r.remove(0), sketch_frame(&s.plane).expect("frame"))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn extruded_polygon_volume_is_area_times_distance(
        plane in plane_strategy(),
        n in 3usize..10,
        radii in prop::collection::vec(1.0..20.0f64, 1..4),
        c in prop::array::uniform2(-30.0..30.0f64),
        phase in 0.0..1.0f64,
        d in 0.5..40.0f64,
        dir in direction_strategy(),
    ) {
        let pts = star(n, &radii, c, phase);
        let (area, cen) = polygon_props(&pts);
        let (region, frame) = one_region(&plane, polygon(&pts));
        prop_assert!(rel(region.area, area) < 1e-12);
        let body = extrude(&region, &frame, d, dir, "ex").expect("extrude");
        assert_valid(&body);
        prop_assert_eq!(body.counts().faces, n + 2);
        prop_assert_eq!(body.counts().edges, 3 * n);
        let mp = mass_properties(&body).expect("mass");
        prop_assert!(rel(mp.volume, area * d) < 1e-12, "{} vs {}", mp.volume, area * d);
        let z = match dir {
            SweepDirection::Normal => 0.5 * d,
            SweepDirection::Reverse => -0.5 * d,
            SweepDirection::Symmetric => 0.0,
        };
        let want = frame.to_world_point(Vec3::new(cen[0], cen[1], z));
        let got = Vec3::from(mp.centroid);
        prop_assert!(got.distance(want) < 1e-9 * (1.0 + want.norm()), "{got:?} vs {want:?}");
    }

    #[test]
    fn extruded_circle_with_hole_volume_is_area_times_distance(
        plane in plane_strategy(),
        r0 in 2.0..30.0f64,
        k in 0.05..0.9f64,
        off in prop::array::uniform2(-0.45..0.45f64),
        d in 0.5..40.0f64,
        dir in direction_strategy(),
    ) {
        let r1 = r0 * k;
        let hc = [off[0] * (r0 - r1), off[1] * (r0 - r1)];
        let curves = vec![
            SketchCurve::Circle { id: "o".into(), center: [0.0, 0.0], radius: r0 },
            SketchCurve::Circle { id: "i".into(), center: hc, radius: r1 },
        ];
        let (region, frame) = one_region(&plane, curves);
        let area = PI * (r0 * r0 - r1 * r1);
        let body = extrude(&region, &frame, d, dir, "ex").expect("extrude");
        assert_valid(&body);
        let mp = mass_properties(&body).expect("mass");
        prop_assert!(rel(mp.volume, area * d) < 1e-12, "{} vs {}", mp.volume, area * d);
        let side = 2.0 * PI * (r0 + r1) * d;
        prop_assert!(rel(mp.area, 2.0 * area + side) < 1e-12);
    }

    #[test]
    fn extruded_slot_volume_and_box(
        len in 1.0..50.0f64,
        w in 0.5..10.0f64,
        d in 0.5..20.0f64,
    ) {
        let h = 0.5 * w;
        let curves = vec![
            line("lo", [-len, -h], [len, -h]),
            SketchCurve::Arc { id: "r".into(), start: [len, -h], end: [len, h], center: [len, 0.0], ccw: true },
            line("up", [len, h], [-len, h]),
            SketchCurve::Arc { id: "l".into(), start: [-len, h], end: [-len, -h], center: [-len, 0.0], ccw: true },
        ];
        let (region, frame) = one_region(&PlaneSpec::Named(NamedPlane::XY), curves);
        let area = 4.0 * len * h + PI * h * h;
        let body = extrude(&region, &frame, d, SweepDirection::Normal, "ex").expect("extrude");
        assert_valid(&body);
        let mp = mass_properties(&body).expect("mass");
        prop_assert!(rel(mp.volume, area * d) < 1e-12);
        let (lo, hi) = bbox(&body).expect("bbox");
        prop_assert!((lo[0] + len + h).abs() < 1e-12 && (hi[0] - len - h).abs() < 1e-12);
        prop_assert!((lo[1] + h).abs() < 1e-12 && (hi[1] - h).abs() < 1e-12);
    }
}

/// Axis through `o` along `d` (sketch coordinates); `side` picks which side the profile
/// is placed on. Returns the axis and a map from profile `(ρ, h)` to sketch points.
fn axis_frame(o: [f64; 2], ang: f64, side: f64) -> (SketchAxis, impl Fn([f64; 2]) -> [f64; 2]) {
    let (s, c) = math::sin_cos(ang);
    let d = [c, s];
    let nrm = [-s * side, c * side];
    let axis = SketchAxis {
        origin: o,
        direction: [3.0 * c, 3.0 * s],
    };
    let to = move |q: [f64; 2]| {
        [
            o[0] + q[1] * d[0] + q[0] * nrm[0],
            o[1] + q[1] * d[1] + q[0] * nrm[1],
        ]
    };
    (axis, to)
}

fn angle_strategy() -> impl Strategy<Value = f64> {
    prop_oneof![Just(360.0), Just(90.0), 1.0..359.0f64]
}

fn revolve_and_check(
    curves: Vec<SketchCurve>,
    axis: &SketchAxis,
    angle: f64,
    dir: SweepDirection,
    area: f64,
    rho_bar: f64,
) -> Result<Body, TestCaseError> {
    let (region, frame) = one_region(&PlaneSpec::Named(NamedPlane::XZ), curves);
    prop_assert!(
        rel(region.area, area) < 1e-12,
        "{} vs {}",
        region.area,
        area
    );
    let body = revolve(&region, &frame, axis, angle, dir, "rv").expect("revolve");
    assert_valid(&body);
    let mp = mass_properties(&body).expect("mass");
    let want = area * rho_bar * math::deg_to_rad(angle);
    prop_assert!(
        rel(mp.volume, want) < 1e-10,
        "Pappus: {} vs {}",
        mp.volume,
        want
    );
    Ok(body)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    #[test]
    fn revolved_polygon_obeys_pappus(
        o in prop::array::uniform2(-20.0..20.0f64),
        ang in 0.0..TAU,
        side in prop_oneof![Just(1.0), Just(-1.0)],
        n in 3usize..9,
        radii in prop::collection::vec(1.0..8.0f64, 1..3),
        gap in 0.5..20.0f64,
        h0 in -20.0..20.0f64,
        angle in angle_strategy(),
        dir in direction_strategy(),
    ) {
        let rmax = radii.iter().copied().fold(0.0, f64::max);
        let prof = star(n, &radii, [rmax + gap, h0], 0.3);
        let (area, cen) = polygon_props(&prof);
        let (axis, to) = axis_frame(o, ang, side);
        let pts: Vec<[f64; 2]> = prof.iter().map(|q| to(*q)).collect();
        let body = revolve_and_check(polygon(&pts), &axis, angle, dir, area, cen[0])?;
        // Surface area by Pappus: lateral faces (length × midpoint radius × Θ) plus two
        // end caps below 360°.
        let th = math::deg_to_rad(angle);
        let mut lateral = 0.0;
        for i in 0..n {
            let (a, b) = (prof[i], prof[(i + 1) % n]);
            let len = ((b[0] - a[0]).powi(2) + (b[1] - a[1]).powi(2)).sqrt();
            lateral += len * 0.5 * (a[0] + b[0]) * th;
        }
        let caps = if angle >= 360.0 { 0.0 } else { 2.0 * area };
        let mp = mass_properties(&body).expect("mass");
        prop_assert!(rel(mp.area, lateral + caps) < 1e-10, "{} vs {}", mp.area, lateral + caps);
        if angle >= 360.0 {
            prop_assert_eq!(body.counts().faces, n);
            prop_assert_eq!(body.counts().edges, n);
        } else {
            prop_assert_eq!(body.counts().faces, n + 2);
            prop_assert_eq!(body.counts().edges, 3 * n);
        }
    }

    #[test]
    fn revolved_rectangle_on_the_axis_gives_a_cylinder(
        w in 0.5..20.0f64,
        h in 0.5..20.0f64,
        angle in angle_strategy(),
        dir in direction_strategy(),
    ) {
        let (axis, to) = axis_frame([0.0, 0.0], 1.0, 1.0);
        let pts = [[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]].map(to);
        let body = revolve_and_check(polygon(&pts), &axis, angle, dir, w * h, 0.5 * w)?;
        // 360°: cylinder + 2 discs, 2 rings. Below: + 2 end caps, 1 shared axis edge.
        let c = body.counts();
        if angle >= 360.0 {
            prop_assert_eq!((c.faces, c.edges, c.vertices), (3, 2, 0));
        } else {
            prop_assert_eq!((c.faces, c.edges, c.vertices), (5, 9, 6));
        }
    }

    #[test]
    fn revolved_triangle_with_apex_on_the_axis_gives_cones(
        r in 1.0..10.0f64,
        h in 1.0..10.0f64,
        shift in -5.0..5.0f64,
        angle in angle_strategy(),
    ) {
        // Apex on the axis, base vertices off it: two cones (no apex edge or vertex).
        let (axis, to) = axis_frame([1.0, -2.0], 0.4, -1.0);
        let prof = [[0.0, 0.0], [r, h + shift], [r, 2.0 * h + shift]];
        let (area, cen) = polygon_props(&prof);
        let pts = prof.map(to);
        let body = revolve_and_check(polygon(&pts), &axis, angle, SweepDirection::Normal, area, cen[0])?;
        let hist: Vec<&str> = body.faces().values().map(|f| f.surface.kind_name()).collect();
        prop_assert_eq!(hist.iter().filter(|k| **k == "cone").count(), 2);
    }

    #[test]
    fn revolved_half_disc_gives_a_sphere(
        r in 0.5..20.0f64,
        c in -10.0..10.0f64,
        angle in angle_strategy(),
        dir in direction_strategy(),
    ) {
        let (axis, to) = axis_frame([2.0, 3.0], 2.0, 1.0);
        let (s, e, m) = (to([0.0, c - r]), to([0.0, c + r]), to([0.0, c]));
        let curves = vec![
            SketchCurve::Arc { id: "a".into(), start: s, end: e, center: m, ccw: true },
            line("d", e, s),
        ];
        // The arc runs counter-clockwise in (ρ, h) only for one orientation of the map;
        // pick the one that bulges to the positive side.
        let ccw_side = {
            let t = to([r, c]);
            let (u, v) = (s[0] - m[0], s[1] - m[1]);
            let (p, q) = (t[0] - m[0], t[1] - m[1]);
            u * q - v * p > 0.0
        };
        let curves = if ccw_side { curves } else {
            vec![
                SketchCurve::Arc { id: "a".into(), start: s, end: e, center: m, ccw: false },
                line("d", e, s),
            ]
        };
        let area = 0.5 * PI * r * r;
        let body = revolve_and_check(curves, &axis, angle, dir, area, 4.0 * r / (3.0 * PI))?;
        let c = body.counts();
        if angle >= 360.0 {
            prop_assert_eq!((c.faces, c.edges, c.vertices), (1, 0, 0));
        } else {
            prop_assert_eq!((c.faces, c.edges, c.vertices), (3, 3, 2));
        }
    }

    #[test]
    fn revolved_circular_segments_give_spindle_tori(
        r in 1.0..10.0f64,
        k in 0.1..0.9f64,
        c in -10.0..10.0f64,
        angle in angle_strategy(),
        apple in any::<bool>(),
    ) {
        // A circle of radius r whose centre is d = k·r from the axis, cut by the axis.
        // apple: centre on the profile side, region = major segment; lemon: centre on
        // the far side, region = minor segment.
        let d = k * r;
        let half = (r * r - d * d).sqrt();
        let minor = r * r * math::acos(d / r) - d * half;
        let xbar = 2.0 / 3.0 * half * half * half / minor; // minor centroid from centre
        let (area, rho_bar, ctr) = if apple {
            let a = PI * r * r - minor;
            (a, (d * PI * r * r - (d - xbar) * minor) / a, d)
        } else {
            (minor, xbar - d, -d)
        };
        let (axis, to) = axis_frame([0.0, 0.0], 1.0, 1.0);
        let (s, e, m) = (to([0.0, c - half]), to([0.0, c + half]), to([ctr, c]));
        let mk = |ccw: bool| vec![
            SketchCurve::Arc { id: "a".into(), start: s, end: e, center: m, ccw },
            line("d", e, s),
        ];
        // The arc must pass through the circle's point farthest out along +ρ.
        let probe = to([ctr + r, c]);
        let ccw = {
            let (u, v) = (s[0] - m[0], s[1] - m[1]);
            let (p, q) = (probe[0] - m[0], probe[1] - m[1]);
            u * q - v * p > 0.0
        };
        let body = revolve_and_check(mk(ccw), &axis, angle, SweepDirection::Normal, area, rho_bar)?;
        let torus = body.faces().values().find_map(|f| match &f.surface {
            forge_core::geom::Surface::Torus(t) => Some(t.spindle_patch()),
            _ => None,
        });
        prop_assert!(torus.flatten().is_some(), "a spindle-torus patch face");
    }
}
