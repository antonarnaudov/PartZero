//! Explicit sketches (SPEC-v1 §4.1, §4.2, §4.5): expressions by resolved value, compound
//! curves checked against the oracle's golden expansions, construction geometry, structural
//! checks on computed values, regions and region selection.

mod common;

use std::collections::BTreeMap;

use common::*;
use forge_core::linalg::Frame;
use forge_ir::v1::metrics::SketchMode;
use forge_ir::v1::{AllKeyword, LiteralCurve, RegionSelection};
use forge_sketch::{
    MAX_POLYGON_SIDES, MAX_SKETCH_CURVES, ResolvedValues, SketchError, ValueError, evaluate_sketch,
    sketch_expr_sites,
};
use serde_json::{Value, json};

fn rect_sketch(w: Value, h: Value, r: Value) -> forge_ir::v1::SketchFeature {
    sketch(json!({
        "id": "s1", "name": "base", "plane": "XY",
        "curves": [{ "kind": "rect", "id": "outline", "center": [0, 0], "w": w, "h": h, "r": r }]
    }))
}

#[test]
fn spec_2_10_params_plate_expands_the_rect_with_parameter_values() {
    let (s, params) = program_sketch("corpus/v1/programs/params_plate.json");
    let r = eval_params(&s, &params).expect("evaluates");
    assert_eq!(r.mode, SketchMode::Explicit);
    assert_eq!(r.trace.mode, SketchMode::Explicit);
    assert_eq!(r.trace.status, None);
    assert_eq!(r.trace.dof, None);
    assert!(r.trace.dimensions.is_empty());
    let ids: Vec<&str> = r.trace.solved.iter().map(LiteralCurve::id).collect();
    assert_eq!(
        ids,
        [
            "outline.bottom",
            "outline.c_br",
            "outline.right",
            "outline.c_tr",
            "outline.top",
            "outline.c_tl",
            "outline.left",
            "outline.c_bl"
        ]
    );
    assert_eq!(r.regions.len(), 1);
    let m = &r.region_metrics()[0];
    assert_eq!(m.loops, 1);
    let mut expected: Vec<String> = ids.iter().map(|s| s.to_string()).collect();
    expected.sort();
    assert_eq!(m.outer_curves, expected);
    // 80 × 50 minus the four corner cut-offs (4 − π)·r².
    let area = 80.0 * 50.0 - (4.0 - std::f64::consts::PI) * 16.0;
    assert!((m.area - area).abs() <= 1e-9 * area, "{} vs {area}", m.area);
    assert!(r.warnings.is_empty());
}

#[test]
fn expression_values_are_read_by_feature_relative_path() {
    let s = rect_sketch(json!("width"), json!("depth"), json!(0));
    let sites: Vec<String> = sketch_expr_sites(&s).into_iter().map(|x| x.path).collect();
    assert_eq!(sites, ["/curves/0/w", "/curves/0/h"]);
    let v = ResolvedValues::new()
        .with("/curves/0/w", 30.0)
        .with("/curves/0/h", 20.0);
    let r = evaluate_sketch(&s, &v, &Frame::world()).expect("ok");
    assert!((r.regions[0].area - 600.0).abs() <= 1e-12);
    assert_eq!(r.point("outline.top.end"), Some([-15.0, 10.0]));
}

#[test]
fn a_missing_expression_value_fails_loudly_instead_of_defaulting() {
    let s = rect_sketch(json!("width"), json!(20), json!(0));
    let e = eval(&s).expect_err("no value for /curves/0/w");
    assert_eq!(e.code(), "FORGE_INTERNAL");
    assert_eq!(e.path(), Some("/curves/0/w"));
    assert!(matches!(e, SketchError::MissingValue { .. }));
}

#[test]
fn an_expression_error_is_passed_through_with_its_code_and_details() {
    let s = rect_sketch(json!("sqrt(0 - width)"), json!(20), json!(0));
    let mut v = ResolvedValues::new();
    v.insert(
        "/curves/0/w",
        Err(ValueError::new(
            "EXPR_DOMAIN",
            "sqrt of a negative number",
            json!({ "expr": "sqrt(0 - width)", "subexpr": "sqrt(0 - width)", "operands": [-80.0] }),
        )),
    );
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("domain");
    assert_eq!(e.code(), "EXPR_DOMAIN");
    assert_eq!(e.path(), Some("/curves/0/w"));
    assert_eq!(e.details()["operands"], json!([-80.0]));
    assert_error_conforms(&e);
}

#[test]
fn computed_range_errors_use_the_literal_codes_at_evaluation() {
    // w = t − 10 with t = 8 → −2: INVALID_VALUE on w (SPEC-v1 §0.5 rule 2).
    let s = rect_sketch(json!("t - 10"), json!(5), json!(0));
    let v = ResolvedValues::new().with("/curves/0/w", -2.0);
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("w <= tol");
    assert_eq!(e.code(), "INVALID_VALUE");
    assert_eq!(e.path(), Some("/curves/0/w"));
    let d = e.details();
    assert_eq!(d["field"], json!("w"));
    assert_eq!(d["value"], json!(-2.0));
    assert_error_conforms(&e);

    // Corner radius larger than min(w, h)/2.
    let s = rect_sketch(json!(10), json!(6), json!("rr"));
    let v = ResolvedValues::new().with("/curves/0/r", 3.5);
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("r too large");
    assert_eq!((e.code(), e.path()), ("INVALID_VALUE", Some("/curves/0/r")));
    // Exactly the catalogue's keys (as validation reports them); the curve is in the message.
    assert_eq!(e.details()["field"], json!("r"));
    assert!(e.to_string().contains("\"outline\""), "{e}");
    assert_error_conforms(&e);
}

#[test]
fn every_scalar_is_evaluated_before_any_curve_is_checked_or_expanded() {
    // SPEC-v1 §4.2: "evaluate every Scalar, expand compound curves, then v0 §3". Curve 0's
    // w evaluates to −1 (INVALID_VALUE at expansion), curve 1's radius fails to evaluate
    // (EXPR_DOMAIN): the expression error of the later curve decides.
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "rect", "id": "outline", "center": [0, 0], "w": "a - 11", "h": 5 },
            { "kind": "circle", "id": "hole", "center": [40, 0], "radius": "sqrt(0 - a)" }
        ]
    }));
    let domain = || {
        Err(ValueError::new(
            "EXPR_DOMAIN",
            "sqrt of a negative number",
            json!({ "expr": "sqrt(0 - a)", "subexpr": "sqrt(0 - a)", "operands": [-10.0] }),
        ))
    };
    let mut v = ResolvedValues::new().with("/curves/0/w", -1.0);
    v.insert("/curves/1/radius", domain());
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("fails");
    assert_eq!(
        (e.code(), e.path()),
        ("EXPR_DOMAIN", Some("/curves/1/radius"))
    );
    // With every Scalar evaluating, the expansion error of curve 0 comes first.
    let v = ResolvedValues::new()
        .with("/curves/0/w", -1.0)
        .with("/curves/1/radius", -2.0);
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("fails");
    assert_eq!((e.code(), e.path()), ("INVALID_VALUE", Some("/curves/0/w")));
    assert_error_conforms(&e);
    // A structural error of an earlier curve still precedes a later curve's expansion.
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "l", "start": [0, 0], "end": ["x", 0] },
            { "kind": "rect", "id": "outline", "center": [0, 0], "w": "a - 11", "h": 5 }
        ]
    }));
    let v = ResolvedValues::new()
        .with("/curves/0/end/0", 0.0)
        .with("/curves/1/w", -1.0);
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("fails");
    assert_eq!(
        (e.code(), e.path()),
        ("DEGENERATE_CURVE", Some("/curves/0"))
    );
}

#[test]
fn a_sketch_beyond_the_curve_limit_fails_with_a_forge_code() {
    // A 4096-gon alone is at the limit; one more curve crosses it.
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "polygon", "id": "p", "center": [0, 0], "n": 4096, "circumradius": 100 },
            { "kind": "point", "id": "q", "at": [500, 0] }
        ]
    }));
    let e = eval(&s).expect_err("limit");
    assert_eq!(e.code(), "FORGE_LIMIT_EXCEEDED");
    assert_eq!(e.path(), Some("/curves"));
    let d = e.details();
    assert_eq!(d["curve"], json!("q"));
    assert_eq!(d["field"], json!("curves"));
    assert_eq!(d["value"], json!(4097.0));
    assert_eq!(d["limit"], json!(MAX_SKETCH_CURVES as f64));
    assert_eq!(MAX_SKETCH_CURVES, 4096);
    // Constrained sketches are bounded the same way.
    // (The boundary itself is the 4096-gon of the polygon-limit test above.)
    let curves: Vec<Value> = (0..=MAX_SKETCH_CURVES)
        .map(|i| json!({ "kind": "point", "id": format!("p{i}"), "at": [i, 0] }))
        .collect();
    let c = sketch(json!({
        "id": "s", "name": "s", "plane": "XY", "curves": curves,
        "constraints": [{ "id": "f", "type": "fix", "entity": "p0" }]
    }));
    let e = eval(&c).expect_err("limit");
    assert_eq!(e.code(), "FORGE_LIMIT_EXCEEDED");
    assert_eq!(e.details()["curve"], json!(format!("p{MAX_SKETCH_CURVES}")));
}

#[test]
fn polygon_count_errors_follow_the_compound_rules() {
    let poly = |n: Value| {
        sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [{ "kind": "polygon", "id": "hex", "center": [0, 0], "n": n, "across_flats": 5.5 }]
        }))
    };
    let v = |n: f64| ResolvedValues::new().with("/curves/0/n", n);
    let e = evaluate_sketch(&poly(json!("k")), &v(2.0), &Frame::world()).expect_err("n < 3");
    assert_eq!((e.code(), e.path()), ("INVALID_COUNT", Some("/curves/0/n")));
    let e = evaluate_sketch(&poly(json!("k")), &v(4.5), &Frame::world()).expect_err("fraction");
    assert_eq!(e.code(), "EXPR_NOT_INTEGER");
    assert_eq!(e.details()["expr"], json!("k"));
    assert_error_conforms(&e);
    let ok = evaluate_sketch(&poly(json!("k")), &v(6.0), &Frame::world()).expect("hexagon");
    assert_eq!(ok.trace.solved.len(), 6);
    // Across flats 5.5: area = 2·√3·(5.5/2)².
    let area = 2.0 * 3f64.sqrt() * 2.75 * 2.75;
    assert!((ok.regions[0].area - area).abs() <= 1e-12 * area);
}

#[test]
fn a_polygon_beyond_the_engine_limit_fails_with_a_forge_code_after_spec_checks() {
    let poly = |size: f64| {
        sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [{ "kind": "polygon", "id": "p", "center": [0, 0], "n": "k", "circumradius": size }]
        }))
    };
    let v = ResolvedValues::new().with("/curves/0/n", 1e9);
    let e = evaluate_sketch(&poly(10.0), &v, &Frame::world()).expect_err("limit");
    assert_eq!(e.code(), "FORGE_LIMIT_EXCEEDED");
    assert_eq!(e.details()["limit"], json!(MAX_POLYGON_SIDES));
    // A SPEC-defined error of the same curve still wins.
    let e = evaluate_sketch(&poly(0.0), &v, &Frame::world()).expect_err("size");
    assert_eq!(e.code(), "INVALID_VALUE");
    assert_eq!(e.path(), Some("/curves/0/circumradius"));
    // At the limit it expands.
    let v = ResolvedValues::new().with("/curves/0/n", MAX_POLYGON_SIDES);
    let r = evaluate_sketch(&poly(100.0), &v, &Frame::world()).expect("4096-gon");
    assert_eq!(r.trace.solved.len(), 4096);
}

#[test]
fn structural_checks_run_on_computed_values() {
    let line = |x: Value| {
        sketch(json!({
            "id": "s", "name": "s", "plane": "XY",
            "curves": [
                { "kind": "line", "id": "a", "start": [0, 0], "end": [x, 0] },
            ]
        }))
    };
    let v = ResolvedValues::new().with("/curves/0/end/0", 5e-7);
    let e = evaluate_sketch(&line(json!("t")), &v, &Frame::world()).expect_err("zero length");
    assert_eq!(e.code(), "DEGENERATE_CURVE");
    assert_eq!(e.details()["reason"], json!("zero-length line"));
    assert_eq!(e.details()["curve"], json!("a"));
    assert_error_conforms(&e);

    let arc = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [{ "kind": "arc", "id": "a", "start": [10, 0], "end": [0, "r"], "center": [0, 0], "ccw": true }]
    }));
    let v = ResolvedValues::new().with("/curves/0/end/1", 10.5);
    let e = evaluate_sketch(&arc, &v, &Frame::world()).expect_err("inconsistent");
    assert_eq!(e.code(), "INCONSISTENT_ARC");
    assert_eq!(e.details()["r_end"], json!(10.5));
    assert_error_conforms(&e);

    let circle = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [{ "kind": "circle", "id": "c", "center": [0, 0], "radius": "r" }]
    }));
    let v = ResolvedValues::new().with("/curves/0/radius", 1e-6);
    let e = evaluate_sketch(&circle, &v, &Frame::world()).expect_err("radius <= tol");
    assert_eq!(e.code(), "DEGENERATE_CURVE");
    let v = ResolvedValues::new().with("/curves/0/radius", f64::INFINITY);
    let e = evaluate_sketch(&circle, &v, &Frame::world()).expect_err("non-finite");
    assert_eq!(
        (e.code(), e.path()),
        ("NON_FINITE", Some("/curves/0/radius"))
    );
}

#[test]
fn construction_curves_and_points_are_in_the_trace_but_never_in_regions() {
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "rect", "id": "box", "corner": [0, 0], "w": 10, "h": 10 },
            { "kind": "line", "id": "diag", "start": [0, 0], "end": [10, 10], "construction": true },
            { "kind": "rect", "id": "guide", "center": [5, 5], "w": 4, "h": 4, "construction": true },
            { "kind": "point", "id": "p", "at": [5, 5] },
            { "kind": "circle", "id": "hole", "center": ["cx", 5], "radius": 2 }
        ]
    }));
    let v = ResolvedValues::new().with("/curves/4/center/0", 5.0);
    let r = evaluate_sketch(&s, &v, &Frame::world()).expect("ok");
    // 4 box members + diag + 4 guide members + point + circle.
    assert_eq!(r.trace.solved.len(), 11);
    assert!(
        r.trace
            .solved
            .iter()
            .filter(|c| c.id().starts_with("guide."))
            .all(|c| matches!(
                c,
                LiteralCurve::Line {
                    construction: true,
                    ..
                }
            ))
    );
    // The construction diagonal would cross the hole and the box; it is ignored. The circle
    // is a hole of the box region (an odd-depth loop is not a region of its own, v0 §3).
    assert_eq!(r.regions.len(), 1);
    let outer = &r.regions[0];
    assert!(outer.outer_curves.iter().all(|c| c.starts_with("box.")));
    assert_eq!(outer.holes.len(), 1);
    assert!((outer.area - (100.0 - std::f64::consts::PI * 4.0)).abs() <= 1e-9);
    assert!(
        r.profile
            .iter()
            .all(|c| !c.id().starts_with("guide") && c.id() != "diag")
    );
    assert_eq!(r.point("p"), Some([5.0, 5.0]));
    assert_eq!(r.point("hole.center"), Some([5.0, 5.0]));
    assert_eq!(r.point("box.bottom.start"), Some([0.0, 0.0]));
    assert_eq!(r.point("nope"), None);
}

#[test]
fn a_sketch_of_points_only_has_no_regions_and_no_error() {
    let s = sketch(json!({
        "id": "holes", "name": "holes", "plane": "XY",
        "curves": [
            { "kind": "point", "id": "a", "at": [0, 0] },
            { "kind": "point", "id": "b", "at": [10, "y"] },
            { "kind": "line", "id": "g", "start": [0, 0], "end": [1, 1], "construction": true }
        ]
    }));
    let v = ResolvedValues::new().with("/curves/1/at/1", 4.0);
    let r = evaluate_sketch(&s, &v, &Frame::world()).expect("ok");
    assert!(r.regions.is_empty());
    assert!(r.profile.is_empty());
    assert_eq!(r.point("b"), Some([10.0, 4.0]));
}

#[test]
fn region_stage_errors_carry_catalogue_details() {
    let open = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "line", "id": "a", "start": [0, 0], "end": [10, 0] },
            { "kind": "line", "id": "b", "start": [10, 0], "end": [10, 10] }
        ]
    }));
    let e = eval(&open).expect_err("open");
    assert_eq!(e.code(), "SKETCH_OPEN_LOOP");
    assert_eq!(e.details()["curve"], json!("a"));
    assert_eq!(e.details()["end"], json!("start"));
    assert_error_conforms(&e);

    let cross = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "rect", "id": "r1", "center": [0, 0], "w": 10, "h": 10 },
            { "kind": "rect", "id": "r2", "center": [5, 5], "w": 10, "h": 10 }
        ]
    }));
    let e = eval(&cross).expect_err("cross");
    assert_eq!(e.code(), "SKETCH_CURVES_CROSS");
    assert_error_conforms(&e);
}

#[test]
fn regions_are_selected_by_a_member_of_their_outer_loop() {
    let s = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [
            { "kind": "rect", "id": "outer", "center": [0, 0], "w": 40, "h": 40 },
            { "kind": "slot", "id": "cut", "a": [-5, 0], "b": [5, 0], "w": 4 },
            { "kind": "circle", "id": "far", "center": [100, 0], "radius": 3 }
        ]
    }));
    let r = eval(&s).expect("ok");
    // The outer rect with the slot as its hole, and the far circle.
    assert_eq!(r.regions.len(), 2);
    let all = r
        .select_regions(&RegionSelection::All(AllKeyword::All))
        .expect("all");
    assert_eq!(all.len(), 2);
    let sel = |ids: &[&str]| {
        r.select_regions(&RegionSelection::Curves(
            ids.iter().map(|s| s.to_string()).collect(),
        ))
    };
    // Twice the same region, listed out of order: once each, canonical order.
    let picked = sel(&["far", "outer.top", "outer.left"]).expect("found");
    assert_eq!(picked.len(), 2);
    let pos = |x: &forge_ops::Region| r.regions.iter().position(|y| std::ptr::eq(x, y));
    assert!(pos(picked[0]) < pos(picked[1]), "canonical order");
    let one = sel(&["outer.left", "outer.top"]).expect("found");
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].holes.len(), 1);
    // The slot is a hole, not on any region's outer loop.
    let e = sel(&["cut.cap_a"]).expect_err("a hole's curve selects nothing");
    assert_eq!(e.curve, "cut.cap_a");
    let e = sel(&["outer.top", "missing"]).expect_err("not found");
    assert_eq!(e.code(), "REGION_NOT_FOUND");
    assert_eq!(e.details()["curve"], json!("missing"));
    assert_catalogue_details(e.code(), &e.details());
}

#[test]
fn sketch_sites_match_the_contract_site_walker() {
    // The feature-relative sites must be exactly forge-ir's curve and constraint sites.
    let text = std::fs::read_to_string(repo_root().join("corpus/v1/programs/params_plate.json"))
        .expect("program");
    let mut doc: serde_json::Value = serde_json::from_str(&text).expect("json");
    // Add every curve kind with expressions, and a constrained twin with dimension values.
    doc["parts"][0]["features"][0]["curves"] = json!([
        { "kind": "line", "id": "l", "start": ["a", 0], "end": [1, "a"] },
        { "kind": "arc", "id": "c", "start": [1, 0], "end": [0, 1], "center": ["a", "a"], "ccw": true },
        { "kind": "circle", "id": "k", "center": [0, 0], "radius": "a" },
        { "kind": "point", "id": "p", "at": ["a", "a"] },
        { "kind": "rect", "id": "r", "corner": ["a", 0], "w": "a", "h": 2, "r": "a" },
        { "kind": "slot", "id": "s", "a": [0, "a"], "b": ["a", 0], "w": "a" },
        { "kind": "polygon", "id": "g", "center": ["a", "a"], "n": "a", "side": "a", "rotation": "a" }
    ]);
    doc["params"] = json!([{ "name": "a", "unit": "mm", "value": 1 }]);
    let doc: forge_ir::v1::Document = serde_json::from_value(doc).expect("typed");
    let part = &doc.parts[0];
    let f = &part.features[0];
    let forge_ir::v1::Feature::Sketch(s) = f else {
        panic!("sketch")
    };
    let contract: Vec<(String, forge_ir::v1::FieldType)> =
        forge_ir::v1::expr::feature_sites(0, part, f, 0)
            .into_iter()
            .filter(|x| x.path.contains("/curves/") || x.path.contains("/constraints/"))
            .map(|x| {
                (
                    x.path
                        .strip_prefix("/parts/0/features/0")
                        .unwrap()
                        .to_string(),
                    x.field,
                )
            })
            .collect();
    let ours: Vec<(String, forge_ir::v1::FieldType)> = sketch_expr_sites(s)
        .into_iter()
        .map(|x| (x.path, x.field))
        .collect();
    assert_eq!(ours, contract);
    assert!(ours.len() > 15);
    // And `resolve` fills every one of them.
    let v = ResolvedValues::resolve(s, |_| Ok(1.0));
    assert_eq!(v.len(), ours.len());
    // A constrained sketch's dimension and fix sites.
    let c = sketch(json!({
        "id": "s", "name": "s", "plane": "XY",
        "curves": [{ "kind": "line", "id": "l", "start": [0, 0], "end": [1, 0] }],
        "constraints": [
            { "id": "d", "type": "distance", "a": "l.start", "b": "l.end", "value": "a" },
            { "id": "an", "type": "angle", "a": "l", "b": "l", "value": "b" },
            { "id": "f", "type": "fix", "entity": "l.start", "x": "a", "y": 0 },
            { "id": "rd", "type": "radius", "curve": "l", "driving": false }
        ]
    }));
    let sites: Vec<(String, forge_ir::v1::FieldType)> = sketch_expr_sites(&c)
        .into_iter()
        .map(|x| (x.path, x.field))
        .collect();
    use forge_ir::v1::FieldType::*;
    assert_eq!(
        sites,
        [
            ("/constraints/0/value".to_string(), Length),
            ("/constraints/1/value".to_string(), Angle),
            ("/constraints/2/x".to_string(), Length)
        ]
    );
}

#[test]
fn from_params_resolves_single_names_only() {
    let s = rect_sketch(json!("width"), json!("width / 2"), json!(0));
    let mut p = BTreeMap::new();
    p.insert("width".to_string(), 12.0);
    let v = ResolvedValues::from_params(&s, &p);
    assert_eq!(v.len(), 1);
    let e = evaluate_sketch(&s, &v, &Frame::world()).expect_err("h unresolved");
    assert_eq!(e.path(), Some("/curves/0/h"));
}

#[test]
fn a_closure_can_serve_as_the_value_source() {
    let s = rect_sketch(json!("w"), json!("h"), json!(0));
    let src = |site: &forge_sketch::SiteRef<'_>| -> Result<f64, ValueError> {
        Ok(if site.text == "w" { 8.0 } else { 2.0 })
    };
    let r = evaluate_sketch(&s, &src, &Frame::world()).expect("ok");
    assert!((r.regions[0].area - 16.0).abs() <= 1e-12);
}

#[test]
fn the_plane_frame_is_carried_into_the_result() {
    let s = rect_sketch(json!(4), json!(4), json!(0));
    let f = Frame::from_normal_x(
        forge_core::linalg::Vec3::new(1.0, 2.0, 3.0),
        forge_core::linalg::Vec3::new(0.0, 0.0, 1.0),
        forge_core::linalg::Vec3::new(1.0, 0.0, 0.0),
    )
    .expect("frame");
    let r = evaluate_sketch(&s, &ResolvedValues::new(), &f).expect("ok");
    assert_eq!(r.frame, f);
}

#[test]
fn an_unimplemented_sketch_version_is_refused() {
    let mut s = rect_sketch(json!(4), json!(4), json!(0));
    s.v = 2;
    let e = eval(&s).expect_err("v2");
    assert_eq!(e.code(), "UNSUPPORTED_FEATURE_VERSION");
    assert_eq!(e.details()["supported"], json!([1]));
    assert_error_conforms(&e);
}
