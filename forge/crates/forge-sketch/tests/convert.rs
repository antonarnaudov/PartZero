//! `convertSketch` (forge_sketch::convert through the session): an explicit sketch with compound
//! curves and expressions becomes a constrained sketch with the **same geometry**, whose sizes are
//! driving dimensions bound to the **same parameters**.

use forge_core::linalg::Frame;
use forge_ir::v1::{Feature, LiteralCurve, SketchFeature};
use forge_sketch::session::{LoadRequest, SketchSession};
use forge_sketch::{ResolvedValues, evaluate_sketch};
use forge_solve::SolveStatus;
use proptest::prelude::*;
use serde_json::{Value, json};

fn doc(params: &[(&str, f64)]) -> Value {
    json!({
        "schema": "aicad.ir/1",
        "params": params.iter().map(|(n, v)| json!({ "name": n, "unit": "mm", "value": v })).collect::<Vec<_>>(),
        "parts": [{ "id": "p", "name": "p", "features": [] }]
    })
}

/// The explicit sketch's geometry, its expressions evaluated by the evaluator of record.
fn explicit_geometry(sketch: &Value, params: &[(&str, f64)]) -> Vec<LiteralCurve> {
    let s: SketchFeature = serde_json::from_value(sketch.clone()).unwrap();
    let d: forge_ir::v1::Document = serde_json::from_value(doc(params)).unwrap();
    let pv = forge_params::evaluate(&d);
    let values = ResolvedValues::resolve(&s, |site| {
        pv.scalar(
            0,
            &forge_ir::v1::Scalar::Expr(site.text.to_string()),
            site.field,
        )
        .map_err(|f| forge_sketch::ValueError::new(f.code, f.message, Value::Object(f.details)))
    });
    let r = evaluate_sketch(&s, &values, &Frame::world()).unwrap();
    r.trace.solved
}

fn load(sketch: &Value, params: &[(&str, f64)]) -> SketchSession {
    SketchSession::load(LoadRequest {
        sketch: sketch.clone(),
        document: Some(doc(params)),
        part: None,
        convert: None,
    })
    .unwrap_or_else(|e| panic!("{e}"))
}

/// Same geometry, curve for curve, members matched through the renames.
fn same_geometry(s: &SketchSession, explicit: &[LiteralCurve], tol: f64) {
    let snap = s.snapshot();
    assert!(snap.ok, "{:?}", snap.error);
    let renames = &s.conversion().expect("converted").renames;
    for e in explicit {
        let id = renames
            .iter()
            .find(|(from, _)| from == e.id())
            .map_or(e.id(), |(_, to)| to.as_str());
        let got = snap
            .curves
            .iter()
            .find(|c| c.id() == id)
            .unwrap_or_else(|| panic!("no {id}"));
        let (a, b) = (
            serde_json::to_value(e).unwrap(),
            serde_json::to_value(got).unwrap(),
        );
        let nums = |v: &Value| -> Vec<f64> {
            let mut out = Vec::new();
            fn walk(v: &Value, out: &mut Vec<f64>) {
                match v {
                    Value::Number(n) => out.push(n.as_f64().unwrap()),
                    Value::Array(a) => a.iter().for_each(|x| walk(x, out)),
                    Value::Object(o) => o
                        .iter()
                        .filter(|(k, _)| *k != "id")
                        .for_each(|(_, x)| walk(x, out)),
                    _ => {}
                }
            }
            walk(v, &mut out);
            out
        };
        for (x, y) in nums(&a).iter().zip(nums(&b)) {
            assert!((x - y).abs() <= tol, "{id}: {a} vs {b}");
        }
    }
}

#[test]
fn a_parametric_rect_becomes_lines_and_dimensions_bound_to_its_parameters() {
    let sketch = json!({ "id": "base", "name": "base", "plane": "XY", "curves": [
        { "kind": "rect", "id": "outline", "center": [0, 0], "w": "width", "h": "depth" }
    ] });
    let params = [("width", 60.0), ("depth", 35.0)];
    let s = load(&sketch, &params);
    let conv = s.conversion().unwrap();
    assert!(
        conv.renames
            .contains(&("outline.bottom".to_string(), "outline_bottom".to_string()))
    );
    same_geometry(&s, &explicit_geometry(&sketch, &params), 0.0);
    let snap = s.snapshot();
    assert_eq!(
        snap.status,
        Some(SolveStatus::FullyConstrained),
        "{:?}",
        snap.redundant
    );
    let exprs: Vec<&str> = snap
        .constraints
        .iter()
        .filter_map(|c| c.expr.as_deref())
        .collect();
    assert!(
        exprs.contains(&"width") && exprs.contains(&"depth"),
        "{exprs:?}"
    );
    // The finished feature evaluates (constrained mode) to the same region.
    let fin = s.finish();
    assert!(fin.ok, "{:?} {:?}", fin.error, fin.validation);
    assert_eq!(fin.regions, 1);
    assert!(fin.conversion.is_some());
    // Loading it with other parameter values moves the geometry with them.
    let converted = fin.feature.clone();
    let s2 = SketchSession::load(LoadRequest {
        sketch: converted,
        document: Some(doc(&[("width", 80.0), ("depth", 35.0)])),
        part: None,
        convert: None,
    })
    .unwrap();
    let bottom = s2
        .snapshot()
        .curves
        .iter()
        .find_map(|c| match c {
            LiteralCurve::Line { id, start, end, .. } if id == "outline_bottom" => {
                Some((*start, *end))
            }
            _ => None,
        })
        .unwrap();
    assert!(
        ((bottom.1[0] - bottom.0[0]) - 80.0).abs() < 1e-9,
        "{bottom:?}"
    );
    assert!(
        (bottom.0[0] + 40.0).abs() < 1e-9,
        "the rect stays centred: {bottom:?}"
    );
}

#[test]
fn rounded_rects_slots_polygons_circles_and_expression_lines_convert() {
    let sketch = json!({ "id": "s", "name": "s", "plane": "XY", "curves": [
        { "kind": "rect", "id": "plate", "corner": [-50, -30], "w": "width", "h": 60, "r": "round_r" },
        { "kind": "slot", "id": "slot1", "a": [-20, 0], "b": [10, 0], "w": "slot_w" },
        { "kind": "polygon", "id": "hex", "center": [30, 10], "n": 6, "across_flats": "af" },
        { "kind": "circle", "id": "hole", "center": ["hx", -15], "radius": "hr" },
        { "kind": "line", "id": "guide", "start": [-45, 25], "end": ["width - 55", 25], "construction": true },
        { "kind": "point", "id": "mark", "at": [0, "0 - 20"] }
    ] });
    let params = [
        ("width", 100.0),
        ("round_r", 6.0),
        ("slot_w", 8.0),
        ("af", 10.0),
        ("hx", -35.0),
        ("hr", 3.0),
    ];
    let s = load(&sketch, &params);
    same_geometry(&s, &explicit_geometry(&sketch, &params), 1e-9);
    let snap = s.snapshot();
    assert!(snap.ok);
    assert!(
        matches!(
            snap.status,
            Some(SolveStatus::FullyConstrained | SolveStatus::OverConstrainedRedundant)
        ),
        "{:?} dof {:?}",
        snap.status,
        snap.dof
    );
    assert_eq!(snap.dof, Some(0), "every converted curve is fully defined");
    let fin = s.finish();
    assert!(fin.ok, "{:?} {:?}", fin.error, fin.validation);
    assert_eq!(
        fin.regions, 1,
        "the plate with a slot, a hexagon and a hole is one region"
    );
    let f: Feature = serde_json::from_value(fin.feature).unwrap();
    let Feature::Sketch(f) = f else { panic!() };
    assert!(
        f.curves.iter().any(|c| c.id() == "hex_circle"),
        "the polygon's construction circumcircle"
    );
}

#[test]
fn conversion_can_be_refused() {
    let r = SketchSession::load(LoadRequest {
        sketch: json!({ "id": "s", "name": "s", "plane": "XY", "curves": [{ "kind": "rect", "id": "r", "center": [0, 0], "w": 10, "h": 5 }] }),
        document: None,
        part: None,
        convert: Some(false),
    });
    assert_eq!(r.unwrap_err().code, "SESSION_NEEDS_CONVERSION");
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 32, ..ProptestConfig::default() })]

    /// Whatever the sizes, a converted rect / slot / polygon has the explicit geometry, solves
    /// with no degrees of freedom, and finishes into a valid feature.
    #[test]
    fn converted_compounds_keep_their_geometry(
        w in 5.0f64..200.0, h in 5.0f64..200.0, rf in 0.0f64..0.45,
        sw in 1.0f64..20.0, len in 1.0f64..60.0,
        n in 3u32..12, size in 1.0f64..40.0, rot in -180.0f64..180.0,
    ) {
        let r = rf * w.min(h);
        let sketch = json!({ "id": "s", "name": "s", "plane": "XY", "curves": [
            { "kind": "rect", "id": "a", "center": [0, 0], "w": "w", "h": "h", "r": "r" },
            { "kind": "slot", "id": "b", "a": [500, 0], "b": ["500 + len", 0], "w": "sw" },
            { "kind": "polygon", "id": "c", "center": [-500, 0], "n": n, "circumradius": "size", "rotation": rot }
        ] });
        let params = [("w", w), ("h", h), ("r", r), ("sw", sw), ("len", len), ("size", size)];
        let s = load(&sketch, &params);
        same_geometry(&s, &explicit_geometry(&sketch, &params), 1e-7);
        prop_assert_eq!(s.snapshot().dof, Some(0));
        let fin = s.finish();
        prop_assert!(fin.ok, "{:?} {:?}", fin.error, fin.validation);
        prop_assert_eq!(fin.regions, 3);
    }
}
