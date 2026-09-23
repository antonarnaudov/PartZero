//! Property tests: analytic region areas of compound curves (an independent oracle),
//! welding by tolerance, the flip check's independence of the sketch position, constrained
//! rectangles driven by random dimensions (replay check, fixed point, idempotent write-back),
//! and bit-for-bit determinism.

mod common;

use std::collections::BTreeMap;
use std::f64::consts::PI;

use common::*;
use forge_core::linalg::Frame;
use forge_ir::v1::LiteralCurve;
use forge_sketch::check::check_trace;
use forge_sketch::{ResolvedValues, constraint_values, evaluate_sketch, write_back};
use proptest::prelude::*;
use serde_json::json;

fn rel_close(a: f64, b: f64, rel: f64) -> bool {
    (a - b).abs() <= rel * a.abs().max(b.abs()).max(1.0)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(96))]

    /// rect(w, h, r) with expressions: one region of area w·h − (4 − π)·r², 4 or 8 members
    /// (6 for a stadium), in member-table order.
    #[test]
    fn rect_region_area_is_analytic(
        cx in -100.0f64..100.0, cy in -100.0f64..100.0,
        w in 0.5f64..200.0, h in 0.5f64..200.0, rf in 0.0f64..1.0, rounded in any::<bool>(),
    ) {
        let r = if rounded { rf * w.min(h) / 2.0 } else { 0.0 };
        let s = sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [{ "kind": "rect", "id": "o", "center": ["cx", "cy"], "w": "w", "h": "h", "r": "r" }]
        }));
        let v = ResolvedValues::new()
            .with("/curves/0/center/0", cx).with("/curves/0/center/1", cy)
            .with("/curves/0/w", w).with("/curves/0/h", h).with("/curves/0/r", r);
        let res = evaluate_sketch(&s, &v, &Frame::world()).expect("valid rect");
        prop_assert_eq!(res.regions.len(), 1);
        let area = w * h - (4.0 - PI) * r * r;
        prop_assert!(rel_close(res.regions[0].area, area, 1e-9), "{} vs {area}", res.regions[0].area);
        let n = res.trace.solved.len();
        prop_assert!(n == 4 || n == 6 || n == 8, "{n}");
        // Determinism: the same input gives the same result.
        prop_assert_eq!(evaluate_sketch(&s, &v, &Frame::world()).unwrap(), res);
    }

    /// slot(a, b, w): area |b − a|·w + π(w/2)².
    #[test]
    fn slot_region_area_is_analytic(
        ax in -50.0f64..50.0, ay in -50.0f64..50.0, len in 0.01f64..100.0, ang in 0.0f64..360.0,
        w in 0.01f64..20.0,
    ) {
        let (s_, c_) = forge_core::math::sin_cos(ang.to_radians());
        let b = [ax + len * c_, ay + len * s_];
        let s = sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [{ "kind": "slot", "id": "sl", "a": [ax, ay], "b": b, "w": w }]
        }));
        let res = eval(&s).expect("valid slot");
        let d = ((b[0] - ax).powi(2) + (b[1] - ay).powi(2)).sqrt();
        let area = d * w + PI * (w / 2.0).powi(2);
        prop_assert!(rel_close(res.regions[0].area, area, 1e-9), "{} vs {area}", res.regions[0].area);
    }

    /// polygon(n, size): area ½·n·R²·sin(360°/n) with R from the size field.
    #[test]
    fn polygon_region_area_is_analytic(
        n in 3u32..40, size in 0.5f64..50.0, which in 0usize..4, rot in -720.0f64..720.0,
    ) {
        let nf = f64::from(n);
        let half = PI / nf;
        let (field, big_r) = match which {
            0 => ("circumradius", size),
            1 => ("inradius", size / half.cos()),
            2 => ("across_flats", size / (2.0 * half.cos())),
            _ => ("side", size / (2.0 * half.sin())),
        };
        let s = sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [{ "kind": "polygon", "id": "p", "center": [1, 2], "n": n, field: size, "rotation": rot }]
        }));
        let res = eval(&s).expect("valid polygon");
        prop_assert_eq!(res.trace.solved.len(), n as usize);
        let area = 0.5 * nf * big_r * big_r * (2.0 * half).sin();
        prop_assert!(rel_close(res.regions[0].area, area, 1e-9), "{} vs {area}", res.regions[0].area);
    }

    /// Welding decides by the stored geometry (construction curves weld too): an end within
    /// tol of another welds (they are one point, bit-exactly, after the solve); beyond tol it
    /// does not (the solver keeps the ends as distinct points).
    #[test]
    fn ends_within_tol_weld_and_farther_ends_do_not(gap in 0.0f64..3e-6, dir in 0.0f64..360.0) {
        let (sy, sx) = forge_core::math::sin_cos(dir.to_radians());
        let end = [gap * sx, 5.0 + gap * sy];
        let s = sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [
                { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0], "construction": true },
                { "kind": "line", "id": "b", "start": [10, 0], "end": [0, 5], "construction": true },
                { "kind": "line", "id": "c", "start": end, "end": [0, 0], "construction": true }
            ],
            "constraints": [{ "id": "h", "type": "horizontal", "line": "a" }]
        }));
        let d = (end[0].powi(2) + (end[1] - 5.0).powi(2)).sqrt();
        let welded = d <= forge_ir::v1::LINEAR_TOLERANCE;
        let r = eval(&s).expect("valid triangle");
        let groups = &r.solve_report.as_ref().unwrap().welds;
        let joined = groups.iter().any(|g| g.members.contains(&"c.start".to_string()));
        prop_assert_eq!(joined, welded, "gap {}", d);
        if welded {
            prop_assert_eq!(r.point("c.start"), r.point("b.end"));
        } else {
            prop_assert_eq!(r.point("c.start"), Some(end));
        }
    }

    /// The flip check (SPEC-v1 §4.4 rule 8) does not depend on where the sketch sits: a
    /// triangle whose stored guess leaves the loop open (t3 ends `gap` away from t1.start; a
    /// `coincident` closes it), its apex fixed on either side of the base, gets the same
    /// warnings at any translation, and `SKETCH_LOOP_FLIPPED` is raised exactly when the fix
    /// pulls the apex across the base.
    #[test]
    fn the_flip_check_does_not_depend_on_the_sketch_position(
        ax in 2.0f64..8.0, ay in 3.0f64..8.0, below in any::<bool>(),
        ty in 3.0f64..8.0, target_below in any::<bool>(),
        gap in 0.01f64..0.5, gdir in 0.0f64..360.0,
        ox in -1e4f64..1e4, oy in -1e4f64..1e4,
    ) {
        let ay = if below { -ay } else { ay };
        let ty = if target_below { -ty } else { ty };
        let (gs, gc) = forge_core::math::sin_cos(gdir.to_radians());
        let build = |o: [f64; 2]| {
            let p = |x: f64, y: f64| json!([x + o[0], y + o[1]]);
            sketch(json!({
                "id": "s", "name": "s", "plane": "XY",
                "curves": [
                    { "kind": "line", "id": "t1", "start": p(0.0, 0.0), "end": p(10.0, 0.0) },
                    { "kind": "line", "id": "t2", "start": p(10.0, 0.0), "end": p(ax, ay) },
                    { "kind": "line", "id": "t3", "start": p(ax, ay), "end": p(gap * gc, gap * gs) }
                ],
                "constraints": [
                    { "id": "c", "type": "coincident", "a": "t3.end", "b": "t1.start" },
                    { "id": "f1", "type": "fix", "entity": "t1.start" },
                    { "id": "f2", "type": "fix", "entity": "t1.end" },
                    { "id": "f3", "type": "fix", "entity": "t2.end", "x": ax + o[0], "y": ty + o[1] }
                ]
            }))
        };
        let base = eval(&build([0.0, 0.0])).expect("solves");
        let moved = eval(&build([ox, oy])).expect("solves");
        prop_assert_eq!(&moved.warnings, &base.warnings);
        let flagged = base.warnings.iter().any(|w| w.code == "SKETCH_LOOP_FLIPPED");
        prop_assert_eq!(flagged, below != target_below);
        prop_assert!(rel_close(base.regions[0].area, 5.0 * ty.abs(), 1e-9));
    }

    /// A rectangle driven by two random dimensions and a fixed corner: fully constrained, the
    /// dimensions hold, the replay check passes, write-back is a bit-exact fixed point.
    #[test]
    fn constrained_rectangles_solve_verify_and_write_back(
        w in 1.0f64..300.0, h in 1.0f64..300.0, ox in -50.0f64..50.0, oy in -50.0f64..50.0,
        noise in 0.0f64..0.2, rot in 0.0f64..10.0,
    ) {
        // A perturbed stored guess.
        let (w0, h0) = (w * (1.0 + noise), h * (1.0 - noise / 2.0));
        let t = rot.to_radians() * noise;
        let (st, ct) = (t.sin(), t.cos());
        let p = |x: f64, y: f64| [ox + ct * x - st * y, oy + st * x + ct * y];
        let (c0, c1, c2, c3) = (p(0.0, 0.0), p(w0, 0.0), p(w0, h0), p(0.0, h0));
        let s = sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [
                { "kind": "line", "id": "bottom", "start": c0, "end": c1 },
                { "kind": "line", "id": "right", "start": c1, "end": c2 },
                { "kind": "line", "id": "top", "start": c2, "end": c3 },
                { "kind": "line", "id": "left", "start": c3, "end": c0 }
            ],
            "constraints": [
                { "id": "h1", "type": "horizontal", "line": "bottom" },
                { "id": "v1", "type": "vertical", "line": "left" },
                { "id": "p1", "type": "perpendicular", "a": "bottom", "b": "right" },
                { "id": "p2", "type": "parallel", "a": "bottom", "b": "top" },
                { "id": "w", "type": "distance", "a": "bottom.start", "b": "bottom.end", "value": "width" },
                { "id": "d", "type": "distance", "a": "left.start", "b": "left.end", "value": "depth" },
                { "id": "o", "type": "fix", "entity": "bottom.start", "x": ox, "y": oy }
            ]
        }));
        let mut params = BTreeMap::new();
        params.insert("width".to_string(), w);
        params.insert("depth".to_string(), h);
        let v = ResolvedValues::from_params(&s, &params);
        let r = evaluate_sketch(&s, &v, &Frame::world()).expect("solves");
        prop_assert_eq!(r.trace.dof, Some(0));
        // Each constraint holds to 1e-10 mm; `horizontal` bounds an endpoint height difference,
        // so a 1 mm line may tilt by 1e-10 rad and a perpendicular 300 mm line inherits it: the
        // area is exact only to ~1e-8 relative for such aspect ratios.
        prop_assert!(rel_close(r.regions[0].area, w * h, 1e-7), "{} vs {}", r.regions[0].area, w * h);
        let stored: Vec<LiteralCurve> = s.curves.iter()
            .map(|c| serde_json::from_value(serde_json::to_value(c).unwrap()).unwrap())
            .collect();
        let cv = constraint_values(&s, &v).unwrap();
        prop_assert!(check_trace(&stored, &s.constraints, &cv, &r.trace).is_ok());
        let wb = write_back(&s, &r).expect("constrained");
        let r2 = evaluate_sketch(&wb, &v, &Frame::world()).expect("solves");
        prop_assert_eq!(&r2.trace, &r.trace);
        prop_assert_eq!(&r2.regions, &r.regions);
        let wb2 = write_back(&wb, &r2);
        prop_assert_eq!(wb2.as_ref(), Some(&wb));
    }
}
