//! Properties over random plates with holes: dimension edits never change what a
//! reference resolves to, and a renamed curve is never silently re-bound.

use forge_ir::Document;
use forge_naming::harness::truth::{Expected, Intent, expected, label};
use forge_naming::harness::{Outcome, score};
use forge_naming::{EntityRef, ModelView, resolve};
use proptest::prelude::*;

/// A `w × h` plate with a hole `id` of radius `r` at `(cx, cy)`, extruded by `d`.
fn plate(w: f64, h: f64, id: &str, cx: f64, cy: f64, r: f64, d: f64) -> Document {
    let json = format!(
        r#"{{ "schema": "aicad.ir/0", "meta": {{ "name": "p" }}, "parts": [{{ "id": "p", "name": "p", "features": [
            {{ "type": "sketch", "id": "s", "name": "base", "plane": "XY", "curves": [
                {{ "kind": "line", "id": "bottom", "start": [0, 0], "end": [{w}, 0] }},
                {{ "kind": "line", "id": "right", "start": [{w}, 0], "end": [{w}, {h}] }},
                {{ "kind": "line", "id": "top", "start": [{w}, {h}], "end": [0, {h}] }},
                {{ "kind": "line", "id": "left", "start": [0, {h}], "end": [0, 0] }},
                {{ "kind": "circle", "id": "{id}", "center": [{cx}, {cy}], "radius": {r} }}
            ]}},
            {{ "type": "extrude", "id": "e", "name": "plate", "sketch": "base", "distance": {d} }}
        ]}}]}}"#
    );
    forge_ir::from_json(&json).expect("valid plate")
}

/// Score every reference of `a` resolved in `b` under `intent`.
fn outcomes(a: &Document, b: &Document, intent: &Intent) -> Vec<(String, Outcome, Expected)> {
    let (va, vb) = (ModelView::build(a), ModelView::build(b));
    let (ta, tb) = (label(a, &va), label(b, &vb));
    EntityRef::capture_all(&va)
        .into_iter()
        .map(|(loc, r)| {
            let e = expected(&ta, &tb, intent, loc);
            let o = score(&e, &resolve(&r, &vb));
            (r.name, o, e)
        })
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(24))]

    #[test]
    fn dimension_edits_keep_every_reference_correct(
        w in 20.0f64..80.0, h in 10.0f64..50.0, d in 1.0f64..20.0,
        fx in 0.3f64..0.7, fy in 0.3f64..0.7, fr in 0.05f64..0.2,
        sw in 0.7f64..1.4, sh in 0.7f64..1.4, sd in 0.5f64..2.0,
    ) {
        let r = fr * w.min(h);
        let a = plate(w, h, "h", fx * w, fy * h, r, d);
        let b = plate(w * sw, h * sh, "h", fx * w * sw, fy * h * sh, r, d * sd);
        for (name, o, e) in outcomes(&a, &b, &Intent::identity()) {
            prop_assert_eq!(o, Outcome::Correct, "{} expected {:?}", name, e);
        }
    }

    #[test]
    fn a_renamed_hole_is_never_silently_rebound(
        w in 20.0f64..80.0, h in 10.0f64..50.0,
        fx in 0.3f64..0.7, fy in 0.3f64..0.7, fr in 0.05f64..0.2,
        dx in -0.05f64..0.05,
    ) {
        let r = fr * w.min(h);
        let a = plate(w, h, "h", fx * w, fy * h, r, 5.0);
        let b = plate(w, h, "g", (fx + dx) * w, fy * h, r, 5.0);
        let mut intent = Intent { sketch: Some("base".into()), ..Intent::default() };
        intent.curve_map.insert("h".into(), vec!["g".into()]);
        intent.renamed.insert("h".into());
        for (name, o, e) in outcomes(&a, &b, &intent) {
            prop_assert!(o != Outcome::SilentWrong, "{} expected {:?}", name, e);
            prop_assert!(o != Outcome::Excluded, "{}", name);
        }
    }
}
