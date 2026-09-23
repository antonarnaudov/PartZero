//! Resolver behaviour on small hand-written IR v0 documents: one test per layer of the
//! ADR 0006 chain and per flag reason.

use forge_ir::Document;
use forge_naming::{
    AUTO_ACCEPT_CONFIDENCE, EntityRef, Loc, ModelView, Reason, Resolution, Status, resolve,
};

fn doc(curves: &str, features: &str) -> Document {
    let json = format!(
        r#"{{ "schema": "aicad.ir/0", "meta": {{ "name": "t" }}, "parts": [{{ "id": "p", "name": "p", "features": [
            {{ "type": "sketch", "id": "s", "name": "base", "plane": "XY", "curves": [{curves}] }},
            {features}
        ]}}]}}"#
    );
    forge_ir::from_json(&json).unwrap_or_else(|e| panic!("bad test doc: {e:?}\n{json}"))
}

const EXTRUDE: &str =
    r#"{ "type": "extrude", "id": "e", "name": "plate", "sketch": "base", "distance": 5 }"#;

/// A 40 × 20 plate with one hole, the right edge at `right`.
fn plate(right: f64, hole: &str) -> String {
    format!(
        r#"{{ "kind": "line", "id": "bottom", "start": [0, 0], "end": [{right}, 0] }},
           {{ "kind": "line", "id": "right", "start": [{right}, 0], "end": [{right}, 20] }},
           {{ "kind": "line", "id": "top", "start": [{right}, 20], "end": [0, 20] }},
           {{ "kind": "line", "id": "left", "start": [0, 20], "end": [0, 0] }}{hole}"#
    )
}

const HOLE: &str = r#", { "kind": "circle", "id": "h", "center": [10, 10], "radius": 2 }"#;

fn loc_named(view: &ModelView, name: &str) -> Loc {
    let hits: Vec<Loc> = view
        .entities()
        .into_iter()
        .filter(|l| view.name(*l) == name)
        .collect();
    assert_eq!(hits.len(), 1, "{name}: {hits:?}");
    hits[0]
}

fn capture(view: &ModelView, name: &str) -> EntityRef {
    EntityRef::capture(view, loc_named(view, name)).expect("capture")
}

fn top_name(view: &ModelView, r: &Resolution) -> String {
    r.top()
        .map_or("<none>".into(), |l| view.name(l).to_string())
}

#[test]
fn dimension_edit_keeps_every_reference_exact() {
    let before = ModelView::build(&doc(&plate(40.0, HOLE), EXTRUDE));
    let after = ModelView::build(&doc(&plate(47.5, HOLE), EXTRUDE));
    for (_, r) in EntityRef::capture_all(&before) {
        let res = resolve(&r, &after);
        assert!(res.is_exact(), "{}: {}", r.name, res.describe(&after));
        assert_eq!(top_name(&after, &res), r.name);
    }
}

#[test]
fn renamed_hole_is_found_by_geometry_and_flagged() {
    let before = ModelView::build(&doc(&plate(40.0, HOLE), EXTRUDE));
    let renamed = HOLE.replace("\"h\"", "\"hole\"");
    let after = ModelView::build(&doc(&plate(40.0, &renamed), EXTRUDE));
    let res = resolve(&capture(&before, "plate/side:h"), &after);
    assert!(
        matches!(res.status, Status::GeometricMatch { .. }),
        "{}",
        res.describe(&after)
    );
    assert!(res.is_flagged());
    assert_eq!(res.reason, Reason::NameNotFound);
    assert!(res.confidence() >= AUTO_ACCEPT_CONFIDENCE);
    assert_eq!(top_name(&after, &res), "plate/side:hole");
    let edge = resolve(
        &capture(&before, "plate/edge:{plate/cap:end|plate/side:h}"),
        &after,
    );
    assert_eq!(
        top_name(&after, &edge),
        "plate/edge:{plate/cap:end|plate/side:hole}"
    );
}

#[test]
fn removed_hole_is_missing_not_matched_to_another_hole() {
    let two = r#", { "kind": "circle", "id": "h", "center": [10, 10], "radius": 2 },
                  { "kind": "circle", "id": "g", "center": [30, 10], "radius": 2 }"#;
    let before = ModelView::build(&doc(&plate(40.0, two), EXTRUDE));
    let after = ModelView::build(&doc(
        &plate(
            40.0,
            r#", { "kind": "circle", "id": "g", "center": [30, 10], "radius": 2 }"#,
        ),
        EXTRUDE,
    ));
    for name in [
        "plate/side:h",
        "plate/edge:{plate/cap:start|plate/side:h}",
        "plate/edge:{plate/cap:end|plate/side:h}",
    ] {
        let res = resolve(&capture(&before, name), &after);
        assert_eq!(
            res.status,
            Status::Missing,
            "{name}: {}",
            res.describe(&after)
        );
    }
}

#[test]
fn suppressed_feature_is_missing() {
    let before = ModelView::build(&doc(&plate(40.0, HOLE), EXTRUDE));
    let suppressed = EXTRUDE.replace("\"distance\"", "\"suppressed\": true, \"distance\"");
    let after = ModelView::build(&doc(&plate(40.0, HOLE), &suppressed));
    let res = resolve(&capture(&before, "plate/cap:end"), &after);
    assert_eq!(res.status, Status::Missing);
    assert_eq!(res.reason, Reason::FeatureAbsent);
}

#[test]
fn split_line_keeping_its_id_is_ambiguous_with_both_pieces() {
    let before = ModelView::build(&doc(&plate(40.0, ""), EXTRUDE));
    let split = r#"{ "kind": "line", "id": "bottom", "start": [0, 0], "end": [16, 0] },
                   { "kind": "line", "id": "bottom_s", "start": [16, 0], "end": [40, 0] },
                   { "kind": "line", "id": "right", "start": [40, 0], "end": [40, 20] },
                   { "kind": "line", "id": "top", "start": [40, 20], "end": [0, 20] },
                   { "kind": "line", "id": "left", "start": [0, 20], "end": [0, 0] }"#;
    let after = ModelView::build(&doc(split, EXTRUDE));
    let res = resolve(&capture(&before, "plate/side:bottom"), &after);
    assert_eq!(res.reason, Reason::Split, "{}", res.describe(&after));
    let Status::Ambiguous { candidates } = &res.status else {
        panic!("expected ambiguous, got {}", res.describe(&after));
    };
    let names: Vec<&str> = candidates.iter().map(|c| after.name(c.loc)).collect();
    assert_eq!(names, ["plate/side:bottom", "plate/side:bottom_s"]);
    // Its top edge is split too; the untouched junction at its start stays exact.
    let top = resolve(
        &capture(&before, "plate/edge:{plate/cap:end|plate/side:bottom}"),
        &after,
    );
    assert_eq!(top.reason, Reason::Split);
    let corner = resolve(
        &capture(&before, "plate/edge:{plate/side:bottom|plate/side:left}"),
        &after,
    );
    assert!(corner.is_exact());
    // The junction at its end is now named after the new piece: found by geometry.
    let moved = resolve(
        &capture(&before, "plate/edge:{plate/side:bottom|plate/side:right}"),
        &after,
    );
    assert_eq!(
        top_name(&after, &moved),
        "plate/edge:{plate/side:bottom_s|plate/side:right}"
    );
    assert!(moved.is_flagged());
}

#[test]
fn bulged_line_is_flagged_as_kind_changed() {
    let before = ModelView::build(&doc(&plate(40.0, ""), EXTRUDE));
    let bulged = r#"{ "kind": "line", "id": "bottom", "start": [0, 0], "end": [40, 0] },
                    { "kind": "line", "id": "right", "start": [40, 0], "end": [40, 20] },
                    { "kind": "arc", "id": "top", "start": [40, 20], "end": [0, 20], "center": [20, 0], "ccw": true },
                    { "kind": "line", "id": "left", "start": [0, 20], "end": [0, 0] }"#;
    let after = ModelView::build(&doc(bulged, EXTRUDE));
    let res = resolve(&capture(&before, "plate/side:top"), &after);
    assert_eq!(res.reason, Reason::KindChanged);
    assert!(matches!(res.status, Status::Disambiguated { .. }));
    assert_eq!(top_name(&after, &res), "plate/side:top");
}

#[test]
fn fillet_consumes_the_corner_edge() {
    let before = ModelView::build(&doc(&plate(40.0, ""), EXTRUDE));
    let filleted = r#"{ "kind": "line", "id": "bottom", "start": [0, 0], "end": [35, 0] },
                      { "kind": "arc", "id": "f", "start": [35, 0], "end": [40, 5], "center": [35, 5], "ccw": true },
                      { "kind": "line", "id": "right", "start": [40, 5], "end": [40, 20] },
                      { "kind": "line", "id": "top", "start": [40, 20], "end": [0, 20] },
                      { "kind": "line", "id": "left", "start": [0, 20], "end": [0, 0] }"#;
    let after = ModelView::build(&doc(filleted, EXTRUDE));
    let res = resolve(
        &capture(&before, "plate/edge:{plate/side:bottom|plate/side:right}"),
        &after,
    );
    assert_eq!(res.status, Status::Missing, "{}", res.describe(&after));
    assert_eq!(res.reason, Reason::FacesNoLongerMeet);
    // The faces themselves are the same design faces.
    assert!(resolve(&capture(&before, "plate/side:right"), &after).is_exact());
}

/// A "D": `arc_a` and `line_b` meet twice, so the two vertical edges between their
/// side faces share a name and are told apart by `#index`, ordered by junction keys
/// such as `arc_a:end|line_b:start`. Reversing `arc_a` rewrites those keys and swaps
/// the indices; the resolver must notice.
#[test]
fn index_swap_after_curve_reversal_is_flagged_and_corrected() {
    let d = |arc: &str| {
        format!(r#"{arc}, {{ "kind": "line", "id": "line_b", "start": [-5, 0], "end": [5, 0] }}"#)
    };
    let fwd = r#"{ "kind": "arc", "id": "arc_a", "start": [5, 0], "end": [-5, 0], "center": [0, 0], "ccw": true }"#;
    let rev = r#"{ "kind": "arc", "id": "arc_a", "start": [-5, 0], "end": [5, 0], "center": [0, 0], "ccw": false }"#;
    let before = ModelView::build(&doc(&d(fwd), EXTRUDE));
    let after = ModelView::build(&doc(&d(rev), EXTRUDE));
    let base = "plate/edge:{plate/side:arc_a|plate/side:line_b}";
    for name in [base.to_string(), format!("{base}#1")] {
        let r = capture(&before, &name);
        let res = resolve(&r, &after);
        assert_eq!(
            res.reason,
            Reason::IndexFamily,
            "{name}: {}",
            res.describe(&after)
        );
        // The proposal sits where the referenced edge was.
        let top = res.top().expect("candidate");
        let c = after.info(top).expect("info").fingerprint.centroid;
        let d = r.fingerprint.centroid;
        assert!(
            (c[0] - d[0]).abs() < 1e-9 && (c[1] - d[1]).abs() < 1e-9,
            "{name}"
        );
        // And its name is the *other* index: the raw name would have been wrong.
        assert_ne!(after.name(top), name);
    }
}

#[test]
fn caps_of_region_bodies_are_told_apart_by_region() {
    let two = r#"{ "kind": "circle", "id": "a", "center": [0, 0], "radius": 3 },
                 { "kind": "circle", "id": "b", "center": [10, 0], "radius": 3 }"#;
    let three =
        format!(r#"{two}, {{ "kind": "circle", "id": "c", "center": [20, 0], "radius": 3 }}"#);
    let before = ModelView::build(&doc(two, EXTRUDE));
    let after = ModelView::build(&doc(&three, EXTRUDE));
    let refs = EntityRef::capture_all(&before);
    let (_, cap_b) = refs
        .iter()
        .find(|(_, r)| r.name == "plate/cap:end" && r.region == ["b"])
        .expect("cap of body b");
    let res = resolve(cap_b, &after);
    assert!(res.is_exact(), "{}", res.describe(&after));
    let top = res.top().expect("top");
    assert_eq!(after.bodies[top.body].region, ["b"]);
}

#[test]
fn renamed_region_is_disambiguated_by_position() {
    let discs = |b: &str| {
        format!(
            r#"{{ "kind": "circle", "id": "a", "center": [0, 0], "radius": 3 }},
               {{ "kind": "circle", "id": "{b}", "center": [10, 0], "radius": 3 }},
               {{ "kind": "circle", "id": "c", "center": [20, 0], "radius": 3 }}"#
        )
    };
    let before = ModelView::build(&doc(&discs("b"), EXTRUDE));
    let after = ModelView::build(&doc(&discs("b2"), EXTRUDE));
    let refs = EntityRef::capture_all(&before);
    let (_, cap_b) = refs
        .iter()
        .find(|(_, r)| r.name == "plate/cap:start" && r.region == ["b"])
        .expect("cap of body b");
    let res = resolve(cap_b, &after);
    assert_eq!(res.reason, Reason::RegionChanged);
    assert!(res.is_flagged());
    let top = res.top().expect("top");
    assert_eq!(after.bodies[top.body].region, ["b2"]);
}

#[test]
fn only_identical_geometry_reaches_auto_accept_confidence() {
    // Rename *and* move the hole: the name is gone and the geometry changed, so the
    // resolver may propose it but must stay below auto-accept.
    let before = ModelView::build(&doc(&plate(40.0, HOLE), EXTRUDE));
    let moved = r#", { "kind": "circle", "id": "hole", "center": [10.3, 10.2], "radius": 2 }"#;
    let after = ModelView::build(&doc(&plate(40.0, moved), EXTRUDE));
    let res = resolve(&capture(&before, "plate/side:h"), &after);
    assert!(res.is_flagged());
    assert!(
        res.confidence() < AUTO_ACCEPT_CONFIDENCE,
        "{}",
        res.describe(&after)
    );
}
