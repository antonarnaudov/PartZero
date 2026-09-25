//! Property tests: closed-form volumes over random boxes and plates, the feasible-range
//! property (a suggested `max_feasible_*` succeeds, `1.01×` fails with the same code) for
//! fillets, the three chamfer forms and shells, validity of every returned body, and
//! repeatability.
#![cfg(not(target_family = "wasm"))]

mod common;

use common::*;
use forge_blend::{
    BlendError, BlendOptions, ChamferSpec, ShellDirection, ShellOptions, chamfer, fillet, shell,
};
use forge_core::math::PI;
use proptest::prelude::*;

fn half_mm(lo: u32, hi: u32) -> impl Strategy<Value = f64> {
    (lo..=hi).prop_map(|k| k as f64 * 0.5)
}

fn rounded_box(a: f64, b: f64, c: f64, r: f64) -> f64 {
    (a - 2.0 * r) * (b - 2.0 * r) * (c - 2.0 * r)
        + 2.0
            * r
            * ((a - 2.0 * r) * (b - 2.0 * r)
                + (b - 2.0 * r) * (c - 2.0 * r)
                + (a - 2.0 * r) * (c - 2.0 * r))
        + PI * r * r * ((a - 2.0 * r) + (b - 2.0 * r) + (c - 2.0 * r))
        + 4.0 / 3.0 * PI * r * r * r
}

fn chamfered_box(a: f64, b: f64, c: f64, d: f64) -> f64 {
    a * b * c
        - d * d / 2.0 * 4.0 * ((a - 2.0 * d) + (b - 2.0 * d) + (c - 2.0 * d))
        - 8.0 * 5.0 / 6.0 * d * d * d
}

proptest! {
    // Each case builds, checks and validates whole bodies (a rounded box has 26 faces):
    // few cases per run in debug builds; the OCCT differential covers the breadth.
    #![proptest_config(ProptestConfig { cases: 12, .. ProptestConfig::default() })]

    #[test]
    fn filleting_every_box_edge_gives_the_rounded_box(
        a in half_mm(6, 60), b in half_mm(6, 60), c in half_mm(6, 60), f in 0.02f64..0.45,
    ) {
        let body = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
        let r = f * a.min(b).min(c);
        let all: Vec<_> = body.edges().iter().map(|(id, _)| id).collect();
        let out = fillet(&body, &es(&body, &all), r, &BlendOptions::new("f1")).expect("fillet");
        assert_valid(&out.body);
        let v = volume(&out.body);
        prop_assert!(rel(v, rounded_box(a, b, c, r)) < 1e-10, "{} vs {}", v, rounded_box(a, b, c, r));
        let m = forge_check::body_metrics(&out.body).expect("metrics");
        prop_assert_eq!((m.faces, m.edges), (26, 48));
    }

    #[test]
    fn chamfering_every_box_edge_gives_the_closed_form(
        a in half_mm(6, 60), b in half_mm(6, 60), c in half_mm(6, 60), f in 0.02f64..0.45,
    ) {
        let body = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
        let d = f * a.min(b).min(c);
        let all: Vec<_> = body.edges().iter().map(|(id, _)| id).collect();
        let out = chamfer(&body, &es(&body, &all), &ChamferSpec::Equal { d }, &BlendOptions::new("c1")).expect("chamfer");
        assert_valid(&out.body);
        prop_assert!(rel(volume(&out.body), chamfered_box(a, b, c, d)) < 1e-10);
    }

    #[test]
    fn a_too_large_radius_suggests_a_value_that_works(
        a in half_mm(4, 40), b in half_mm(4, 40), c in half_mm(4, 40),
        pick in 0usize..12, k in 1usize..4, f in 0.55f64..1.5,
    ) {
        let body = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
        let edges: Vec<_> = body.edges().iter().map(|(id, _)| id).collect();
        let sel: Vec<_> = (0..k).map(|i| edges[(pick + 5 * i) % edges.len()]).collect();
        let r = f * a.min(b).min(c);
        match fillet(&body, &es(&body, &sel), r, &BlendOptions::new("f1")) {
            Ok(out) => assert_valid(&out.body),
            Err(BlendError::RadiusTooLarge { max_feasible_r, edges: lim, .. }) => {
                prop_assert!(max_feasible_r > 0.0 && max_feasible_r < r);
                prop_assert!(lim.iter().all(|e| e.max_r >= max_feasible_r));
                prop_assert!((lim.iter().map(|e| e.max_r).fold(f64::INFINITY, f64::min) - max_feasible_r).abs() < 1e-12);
                let ok = fillet(&body, &es(&body, &sel), max_feasible_r, &BlendOptions::new("f1")).expect("max works");
                assert_valid(&ok.body);
                let e = fillet(&body, &es(&body, &sel), 1.01 * max_feasible_r, &BlendOptions::new("f1")).expect_err("above max");
                prop_assert_eq!(e.code(), "FILLET_RADIUS_TOO_LARGE");
            }
            Err(e) => prop_assert!(false, "unexpected {}: {}", e.code(), e),
        }
    }

    #[test]
    fn a_too_large_chamfer_suggests_a_value_that_works(
        a in half_mm(4, 40), b in half_mm(4, 40), c in half_mm(4, 40),
        pick in 0usize..12, k in 1usize..4, f in 0.55f64..1.5,
        form in 0usize..3, ratio in 0.4f64..2.5, angle in 20.0f64..80.0,
    ) {
        let body = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
        let edges: Vec<_> = body.edges().iter().map(|(id, _)| id).collect();
        let d = f * a.min(b).min(c);
        // Two distances and distance–angle: one edge, the side one of its faces.
        let (sel, spec): (Vec<_>, ChamferSpec) = match form {
            0 => (
                (0..k).map(|i| edges[(pick + 5 * i) % edges.len()]).collect(),
                ChamferSpec::Equal { d },
            ),
            _ => {
                let e = edges[pick % edges.len()];
                let side = f1(&body, body.edge_faces(e)[k % 2]);
                let spec = if form == 1 {
                    ChamferSpec::TwoDistances { d, d2: d * ratio, side }
                } else {
                    ChamferSpec::DistanceAngle { d, angle_deg: angle, side }
                };
                (vec![e], spec)
            }
        };
        let with = |x: f64, d2: Option<f64>| -> ChamferSpec {
            match &spec {
                ChamferSpec::Equal { .. } => ChamferSpec::Equal { d: x },
                ChamferSpec::TwoDistances { side, .. } => ChamferSpec::TwoDistances {
                    d: x, d2: d2.expect("d2"), side: side.clone(),
                },
                ChamferSpec::DistanceAngle { angle_deg, side, .. } => ChamferSpec::DistanceAngle {
                    d: x, angle_deg: *angle_deg, side: side.clone(),
                },
            }
        };
        match chamfer(&body, &es(&body, &sel), &spec, &BlendOptions::new("c1")) {
            Ok(out) => assert_valid(&out.body),
            Err(BlendError::DistanceTooLarge { max_feasible_d, edges: lim, d2, .. }) => {
                prop_assert!(max_feasible_d > 0.0 && max_feasible_d < d);
                prop_assert!((lim.iter().map(|e| e.max_d).fold(f64::INFINITY, f64::min) - max_feasible_d).abs() < 1e-12);
                let d2 = d2.map(|x| x.1);
                let ok = chamfer(&body, &es(&body, &sel), &with(max_feasible_d, d2), &BlendOptions::new("c1"))
                    .expect("max works");
                assert_valid(&ok.body);
                let e = chamfer(&body, &es(&body, &sel), &with(1.01 * max_feasible_d, d2.map(|x| 1.01 * x)), &BlendOptions::new("c1"))
                    .expect_err("above max");
                prop_assert_eq!(e.code(), "CHAMFER_DISTANCE_TOO_LARGE");
            }
            Err(e) => prop_assert!(false, "unexpected {}: {}", e.code(), e),
        }
    }

    #[test]
    fn hole_rims_remove_the_pappus_ring(
        w in half_mm(40, 80), d in half_mm(40, 80), h in half_mm(6, 20),
        rh in half_mm(2, 12), f in 0.05f64..0.45,
    ) {
        let plate = aabox("e1", [0.0, 0.0, 0.0], [w, d, h]);
        let hole = zcyl("e2", [w / 2.0, d / 2.0], -1.0, rh, h + 2.0);
        let body = cut(plate, hole, "c1");
        let v0 = volume(&body);
        let rim = circle_near(&body, [w / 2.0 + rh, d / 2.0, h]);
        let r = f * h;
        let out = fillet(&body, &es(&body, &[rim]), r, &BlendOptions::new("f1")).expect("fillet");
        assert_valid(&out.body);
        let ring = 2.0 * PI * (r * r * rh + r * r * r / 2.0 - PI * r * r * rh / 4.0 - PI * r * r * r / 4.0 + r * r * r / 3.0);
        prop_assert!(rel(volume(&out.body), v0 - ring) < 1e-10);
    }

    #[test]
    fn open_box_shells_match_the_closed_form_or_report_the_limit(
        a in half_mm(4, 40), b in half_mm(4, 40), c in half_mm(4, 40), f in 0.02f64..0.8, outward in any::<bool>(),
    ) {
        let body = aabox("e1", [0.0, 0.0, 0.0], [a, b, c]);
        let top = face_near(&body, [a / 2.0, b / 2.0, c]);
        let t = f * a.min(b);
        let dir = if outward { ShellDirection::Outward } else { ShellDirection::Inward };
        match shell(&body, &fs(&body, &[top]), t, dir, &ShellOptions::new("sh1")) {
            Ok(out) => {
                assert_valid(&out.body);
                let expect = if outward {
                    (a + 2.0 * t) * (b + 2.0 * t) * (c + t) - a * b * c
                } else {
                    a * b * c - (a - 2.0 * t) * (b - 2.0 * t) * (c - t)
                };
                prop_assert!(rel(volume(&out.body), expect) < 1e-10);
            }
            Err(BlendError::ThicknessTooLarge { max_feasible_thickness: Some(m), .. }) => {
                prop_assert!(!outward);
                prop_assert!(m < t && m <= a.min(b).min(2.0 * c) / 2.0);
                shell(&body, &fs(&body, &[top]), m, dir, &ShellOptions::new("sh1")).expect("max works");
                let e = shell(&body, &fs(&body, &[top]), 1.01 * m, dir, &ShellOptions::new("sh1"))
                    .expect_err("above max");
                prop_assert_eq!(e.code(), "SHELL_THICKNESS_TOO_LARGE");
            }
            Err(e) => prop_assert!(false, "unexpected {}: {}", e.code(), e),
        }
    }
}

/// The same operation twice gives bit-identical bodies (no hash-order or scheduling
/// dependence).
#[test]
fn blends_are_repeatable_bit_for_bit() {
    let fp = || {
        let plate = aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 8.0]);
        let hole = zcyl("e2", [20.0, 15.0], -1.0, 5.0, 10.0);
        let b = cut(plate, hole, "c1");
        let all: Vec<_> = b.edges().iter().map(|(id, _)| id).collect();
        let out = fillet(&b, &es(&b, &all), 1.5, &BlendOptions::new("f1")).expect("fillet");
        let mut s = String::new();
        for (_, v) in out.body.vertices().iter() {
            s.push_str(&format!(
                "{:x}{:x}{:x}{}",
                v.point.x.to_bits(),
                v.point.y.to_bits(),
                v.point.z.to_bits(),
                v.provenance.key()
            ));
        }
        for (_, f) in out.body.faces().iter() {
            s.push_str(&f.provenance.key());
        }
        s.push_str(&format!("{:x}", volume(&out.body).to_bits()));
        s
    };
    assert_eq!(fp(), fp());
}
