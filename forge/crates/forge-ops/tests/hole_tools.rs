//! Hole tools (SPEC §6.5): the resolved dimensions against the I9 golden cases
//! (`corpus/v1/conformance/holes/tools.json`, every size × fit and every preset), and every
//! tool body against its closed-form volume, its face types and its keys.

// Exact comparisons on purpose: golden values and exact placements.
#![allow(clippy::float_cmp)]

use forge_core::linalg::{Frame, Vec3};
use forge_core::topo::{Body, Severity, parse_key};
use forge_ir::v1::HoleFeature;
use forge_ir::v1::metrics::HoleKind;
use forge_ops::hole::{Depth, HoleSpec, Tip, hole_spec, hole_tool, literal_hole, tool_volume};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../corpus/v1/conformance/holes/tools.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("tools.json")).expect("json")
}

/// A hole feature with the given size-related fields (placement irrelevant here).
fn feature(fields: &Value) -> HoleFeature {
    let mut v = json!({
        "id": "h1", "name": "holes", "on": "XY",
        "at": { "list": [{ "id": "a", "at": [0, 0] }] },
    });
    for (k, x) in fields.as_object().expect("object") {
        v[k] = x.clone();
    }
    serde_json::from_value(v).expect("hole feature")
}

fn spec_of(fields: &Value) -> Result<HoleSpec, forge_ops::hole::HoleError> {
    let lit = literal_hole(&feature(fields), |s, _, _| s.literal().ok_or(())).expect("literals");
    hole_spec(&lit)
}

fn kind_name(k: HoleKind) -> &'static str {
    match k {
        HoleKind::Simple => "simple",
        HoleKind::Counterbore => "counterbore",
        HoleKind::Countersink => "countersink",
        HoleKind::Insert => "insert",
    }
}

fn valid(b: &Body) -> bool {
    forge_check::validate(b)
        .iter()
        .all(|i| i.severity != Severity::Error)
}

/// The tool drilled down (−Z) from the origin; blind depth from the spec, through tools
/// 20 mm long.
fn tool(spec: &HoleSpec) -> (Body, f64, bool) {
    let (h, through) = match spec.depth {
        Depth::Blind(h) => (h, false),
        _ => (20.0, true),
    };
    let b = hole_tool(
        spec,
        "a",
        Vec3::zero(),
        -Vec3::unit_z(),
        Vec3::unit_x(),
        h,
        through,
    )
    .expect("tool");
    (b, h, through)
}

#[test]
fn golden_tool_dimensions_match_the_conformance_fixture() {
    let fx = fixture();
    let cases = fx["cases"].as_array().expect("cases");
    assert!(cases.len() >= 50, "{} cases", cases.len());
    for c in cases {
        let id = c["id"].as_str().expect("id");
        let got = spec_of(&c["hole"]);
        if let Some(code) = c.get("error") {
            let e = got.expect_err(id);
            assert_eq!(e.code(), code.as_str().expect("code"), "{id}");
            continue;
        }
        let s = got.unwrap_or_else(|e| panic!("{id}: {e}"));
        let x = &c["expected"];
        assert_eq!(s.d, x["d"].as_f64().expect("d"), "{id}: d");
        assert_eq!(
            kind_name(s.kind),
            x["kind"].as_str().expect("kind"),
            "{id}: kind"
        );
        let pair =
            |v: &Value, a: &str, b: &str| (v[a].as_f64().expect("a"), v[b].as_f64().expect("b"));
        match x.get("cbore") {
            Some(v) => assert_eq!(s.cbore, Some(pair(v, "d", "depth")), "{id}: cbore"),
            None => assert_eq!(s.cbore, None, "{id}"),
        }
        match x.get("csink") {
            Some(v) => assert_eq!(s.csink, Some(pair(v, "d", "angle")), "{id}: csink"),
            None => assert_eq!(s.csink, None, "{id}"),
        }
        match x.get("insert") {
            Some(v) => {
                assert_eq!(s.insert, Some(pair(v, "d", "depth")), "{id}: insert");
                assert_eq!(
                    s.depth,
                    Depth::Blind(x["depth"].as_f64().expect("depth")),
                    "{id}"
                );
                assert_eq!(s.tip, Tip::Flat, "{id}: insert holes have flat floors");
            }
            None => assert_eq!(s.insert, None, "{id}"),
        }
        match x.get("thread") {
            Some(v) => assert_eq!(s.thread.map(|t| t.0), v["pitch"].as_f64(), "{id}: pitch"),
            None => assert_eq!(s.thread, None, "{id}"),
        }
    }
}

#[test]
fn golden_tools_have_closed_form_volumes_face_types_and_keys() {
    let fx = fixture();
    let mut built = 0;
    for c in fx["cases"].as_array().expect("cases") {
        let id = c["id"].as_str().expect("id");
        let Ok(s) = spec_of(&c["hole"]) else {
            continue;
        };
        let (b, h, through) = tool(&s);
        assert!(valid(&b), "{id}: invalid tool");
        let m = forge_check::body_metrics(&b).expect("metrics");
        let want = tool_volume(&s, h, through);
        assert!(
            (m.volume - want).abs() <= 1e-9 * want,
            "{id}: volume {} vs closed form {want}",
            m.volume
        );
        // Faces: top + wall + bottom, plus the counterbore's two or the countersink's one.
        let extra = match (s.cbore, s.csink) {
            (Some(_), _) => 2,
            (_, Some(_)) => 1,
            _ => 0,
        };
        assert_eq!(
            m.faces as usize,
            3 + extra,
            "{id}: faces {:?}",
            m.face_types
        );
        let cones =
            u32::from(s.csink.is_some()) + u32::from(matches!(s.tip, Tip::Angle(_)) && !through);
        assert_eq!(
            m.face_types.get("cone").copied().unwrap_or(0),
            cones,
            "{id}"
        );
        // Every face keyed h1/<role>@a, every edge h1/edge:{…} between them.
        let mut roles: Vec<String> = Vec::new();
        for (_, f) in b.faces().iter() {
            let p = parse_key(&f.provenance.key()).expect("face key");
            assert_eq!(
                (p.feature.as_str(), p.qualifier.as_deref()),
                ("h1", Some("a")),
                "{id}"
            );
            roles.push(p.label);
        }
        roles.sort();
        let mut want_roles = vec!["top", "wall"];
        if s.cbore.is_some() {
            want_roles.extend(["cbore_floor", "cbore_wall"]);
        }
        if s.csink.is_some() {
            want_roles.push("csink");
        }
        want_roles.push(if through {
            "end"
        } else if matches!(s.tip, Tip::Flat) {
            "floor"
        } else {
            "tip"
        });
        want_roles.sort();
        assert_eq!(roles, want_roles, "{id}");
        for (_, e) in b.edges().iter() {
            let k = e.provenance.key();
            assert!(k.starts_with("h1/edge:{h1/"), "{id}: edge key {k}");
        }
        built += 1;
    }
    assert!(built >= 45, "{built} tools");
}

#[test]
fn blind_tips_flat_floors_and_explicit_dimensions() {
    // A 118° drill point: the cone's height is R / tan 59°.
    let s = spec_of(&json!({ "d": 5, "depth": { "blind": 8 } })).expect("spec");
    assert_eq!((s.depth, s.tip), (Depth::Blind(8.0), Tip::Angle(118.0)));
    let (b, h, through) = tool(&s);
    let v = forge_check::mass_properties(&b).expect("mass").volume;
    let r: f64 = 2.5;
    let cone_h = r / (59.0_f64.to_radians()).tan();
    let want = std::f64::consts::PI * r * r * (h + cone_h / 3.0);
    assert!(!through && (v - want).abs() < 1e-9 * want, "{v} vs {want}");
    // The deepest point is the apex.
    let (lo, _) = forge_check::bbox(&b).expect("bbox");
    assert!((lo[2] + (8.0 + cone_h)).abs() < 1e-9, "apex at {}", lo[2]);
    // `tip: "flat"`.
    let s = spec_of(&json!({ "d": 5, "depth": { "blind": 8 }, "tip": "flat" })).expect("spec");
    assert_eq!(s.tip, Tip::Flat);
    let (b, _, _) = tool(&s);
    let v = forge_check::mass_properties(&b).expect("mass").volume;
    assert!((v - std::f64::consts::PI * 6.25 * 8.0).abs() < 1e-9 * v);
    // Custom counterbore and countersink.
    let s = spec_of(&json!({ "d": 4, "depth": { "blind": 10 }, "cbore": { "d": 8, "depth": 3 } }))
        .expect("spec");
    assert_eq!((s.kind, s.cbore), (HoleKind::Counterbore, Some((8.0, 3.0))));
    let s = spec_of(&json!({ "d": 4, "depth": "through", "csink": { "d": 8, "angle": 82 } }))
        .expect("spec");
    assert_eq!(
        (s.kind, s.csink),
        (HoleKind::Countersink, Some((8.0, 82.0)))
    );
    let (b, h, through) = tool(&s);
    let v = forge_check::mass_properties(&b).expect("mass").volume;
    assert!((v - tool_volume(&s, h, through)).abs() < 1e-9 * v);
}

#[test]
fn out_of_range_values_are_invalid_value_with_the_field() {
    let err = |fields: Value| spec_of(&fields).expect_err("invalid");
    let e = err(json!({ "d": 4, "depth": { "blind": 3 }, "cbore": { "d": 8, "depth": 3 } }));
    assert_eq!(
        (e.code(), e.to_string().contains("/cbore/depth")),
        ("INVALID_VALUE", true)
    );
    let e = err(json!({ "d": 4, "depth": "through", "cbore": { "d": 4, "depth": 1 } }));
    assert!(e.to_string().contains("/cbore/d"), "{e}");
    let e = err(json!({ "d": 4, "depth": { "blind": 1 }, "csink": { "d": 8 } }));
    assert!(
        e.to_string().contains("/csink/d"),
        "{e}: the 90° countersink is 2 mm deep"
    );
    let e = err(json!({ "d": 0, "depth": "through" }));
    assert!(e.to_string().contains("/d"), "{e}");
    let e = err(json!({ "d": 3, "depth": { "blind": 5 }, "tip": 180 }));
    assert!(e.to_string().contains("/tip"), "{e}");
    // Rejections re-checked for callers that bypass validation.
    assert_eq!(
        err(json!({ "depth": "through" })).code(),
        "HOLE_SIZE_REQUIRED"
    );
    assert_eq!(err(json!({ "d": 3 })).code(), "HOLE_DEPTH_REQUIRED");
    let e = err(json!({ "size": "M2", "depth": "through", "cbore": "iso4762" }));
    let forge_ops::hole::HoleErrorDetails::Allowed { allowed, .. } = e.details() else {
        panic!("{e}")
    };
    assert!(!allowed.contains(&"M2".to_string()) && allowed.contains(&"M3".to_string()));
    assert_eq!(
        err(json!({ "d": 3, "depth": { "blind": 5 }, "thread": true })).code(),
        "HOLE_OPTIONS_CONFLICT"
    );
}

/// `(field, value, expected)` of an `INVALID_VALUE`.
fn range(e: &forge_ops::hole::HoleError) -> (String, f64, String) {
    assert_eq!(e.code(), "INVALID_VALUE", "{e}");
    let forge_ops::hole::HoleErrorDetails::Range {
        field,
        value,
        expected,
    } = e.details()
    else {
        panic!("{e}")
    };
    (field, value, expected)
}

/// A countersink or drill point no taller than tol is `INVALID_VALUE` with the angle bound
/// (never the tool's internal `FORGE_HOLE_TOOL` / `SKETCH_CURVES_CROSS`, never a
/// sub-tolerance cone face); just inside the bound the tool builds.
#[test]
fn cones_no_taller_than_tol_are_invalid_with_the_feasible_angle() {
    let err = |fields: Value| spec_of(&fields).expect_err("invalid");
    // The reviewer's inputs: Dk − D = 2.5e-6 at 170°, Dk − D = 6.6 at 179.99999°.
    let (field, value, expected) = range(&err(
        json!({ "d": 3.4, "depth": { "blind": 8 }, "csink": { "d": 3.4000025, "angle": 170 } }),
    ));
    assert_eq!((field.as_str(), value), ("/csink/angle", 170.0));
    // 2·atan(1.25e-6 / 1e-6) = 102.68°.
    assert!(expected.starts_with("< 102.68"), "{expected}");
    let (field, _, expected) = range(&err(
        json!({ "d": 3.4, "depth": { "blind": 8 }, "csink": { "d": 10, "angle": 179.99999 } }),
    ));
    assert_eq!(field, "/csink/angle");
    let bound: f64 = expected[2..]
        .split('°')
        .next()
        .expect("bound")
        .parse()
        .expect("number");
    assert!(bound > 179.99995 && bound < 179.99999, "{expected}");
    // Just inside the bound the countersink cone is taller than tol and the tool builds.
    let ok = spec_of(
        &json!({ "d": 3.4, "depth": "through", "csink": { "d": 10, "angle": bound - 1e-5 } }),
    )
    .expect("inside the bound");
    let (b, _, _) = tool(&ok);
    assert!(valid(&b));
    // A drill point: (D/2)/tan(tip/2) ≤ tol.
    let (field, value, expected) = range(&err(
        json!({ "d": 3.4, "depth": { "blind": 4 }, "tip": 179.9999999 }),
    ));
    assert_eq!((field.as_str(), value), ("/tip", 179.9999999));
    assert!(expected.starts_with("< 179.9999"), "{expected}");
    assert!(expected.contains("flat"), "{expected}");
    let ok = spec_of(&json!({ "d": 3.4, "depth": { "blind": 4 }, "tip": 179.999 })).expect("ok");
    let (b, _, _) = tool(&ok);
    assert!(valid(&b));
}

/// Relations between fields quote their numeric bound in `expected`.
#[test]
fn relational_range_errors_quote_the_numeric_bound() {
    let err = |fields: Value| spec_of(&fields).expect_err("invalid");
    let (field, value, expected) = range(&err(
        json!({ "d": 3, "depth": { "blind": 6 }, "cbore": { "d": 6, "depth": 6 } }),
    ));
    assert_eq!((field.as_str(), value), ("/cbore/depth", 6.0));
    assert!(expected.starts_with("< 5.999999 mm"), "{expected}");
    assert!(expected.contains("hole depth 6 mm"), "{expected}");
    let (field, _, expected) = range(&err(
        json!({ "d": 3, "depth": "through", "cbore": { "d": 3.000001, "depth": 1 } }),
    ));
    assert_eq!(field, "/cbore/d");
    assert!(expected.starts_with("> 3.000002 mm"), "{expected}");
    // A 90° countersink of Dk = 8 on D = 3 is 2.5 mm deep; blind 2 needs Dk < 3 + 2·(2 − tol).
    let (field, _, expected) = range(&err(
        json!({ "d": 3, "depth": { "blind": 2 }, "csink": { "d": 8 } }),
    ));
    assert_eq!(field, "/csink/d");
    assert!(expected.starts_with("< 6.99999"), "{expected}");
}

#[test]
fn expressions_are_evaluated_by_the_callers_evaluator() {
    let h = feature(&json!({
        "d": "dia", "depth": { "blind": "2 * dia" },
        "at": { "grid": { "nx": "n", "ny": 1, "dx": "pitch", "dy": 0 } },
    }));
    let mut seen = Vec::new();
    let lit = literal_hole(&h, |s, t, path| -> Result<f64, ()> {
        seen.push((path.to_string(), t));
        Ok(match s.expr() {
            Some("dia") => 3.0,
            Some("2 * dia") => 6.0,
            Some("n") => 3.0,
            Some("pitch") => 7.5,
            Some(other) => panic!("{other}"),
            None => s.literal().expect("literal"),
        })
    })
    .expect("literal");
    let s = hole_spec(&lit).expect("spec");
    assert_eq!((s.d, s.depth), (3.0, Depth::Blind(6.0)));
    let paths: Vec<&str> = seen.iter().map(|(p, _)| p.as_str()).collect();
    assert!(
        paths.contains(&"/d") && paths.contains(&"/depth/blind") && paths.contains(&"/at/grid/nx")
    );
    let frame = Frame::world();
    let pos = forge_ops::hole::hole_positions(&lit.at, &frame, &[]).expect("positions");
    let ids: Vec<&str> = pos.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, ["g0_0", "g1_0", "g2_0"]);
    assert_eq!(pos[0].uv.x, -7.5);
}

/// [W0-10]: `hole_spec` rejects every conflicting combination for callers that bypass
/// validation, instead of silently reinterpreting it (dropping a tip, a depth, a
/// countersink, or a thread's tap drill).
#[test]
fn conflicting_options_are_rejected_not_reinterpreted() {
    let conflict = |fields: Value| {
        let e = spec_of(&fields).expect_err("conflict");
        assert_eq!(e.code(), "HOLE_OPTIONS_CONFLICT", "{fields}: {e}");
        let forge_ops::hole::HoleErrorDetails::Allowed { field, allowed } = e.details() else {
            panic!("{e}")
        };
        (field, allowed)
    };
    // A tip on a hole that is not blind.
    let (f, a) = conflict(json!({ "d": 3, "depth": "through", "tip": 90 }));
    assert_eq!((f.as_str(), a), ("/tip", vec!["blind".to_string()]));
    assert_eq!(
        conflict(json!({ "d": 3, "depth": "through", "tip": "flat" })).0,
        "/tip"
    );
    assert_eq!(
        conflict(json!({ "size": "M3", "insert": "std", "tip": 90 })).0,
        "/tip"
    );
    // An insert sets its own depth.
    assert_eq!(
        conflict(json!({ "size": "M3", "insert": "std", "depth": { "blind": 4 } })).0,
        "/depth"
    );
    // At most one of cbore, csink, insert (the second one is named).
    assert_eq!(
        conflict(
            json!({ "size": "M4", "depth": "through", "cbore": "iso4762", "csink": "iso10642" })
        )
        .0,
        "/csink"
    );
    assert_eq!(
        conflict(json!({ "size": "M4", "csink": "iso10642", "insert": "std" })).0,
        "/insert"
    );
    // Threads exclude inserts and the close / loose clearance series.
    assert_eq!(
        conflict(json!({ "size": "M4", "insert": "std", "thread": true })).0,
        "/thread"
    );
    for fit in ["close", "loose"] {
        let (f, a) =
            conflict(json!({ "size": "M4", "fit": fit, "depth": "through", "thread": true }));
        assert_eq!(
            (f.as_str(), a),
            ("/fit", vec!["normal".to_string(), "tap".to_string()])
        );
    }
    // The defaults and the allowed combinations still resolve.
    for ok in [
        json!({ "d": 3, "depth": "through" }),
        json!({ "d": 3, "depth": "through", "tip": 118 }),
        json!({ "size": "M4", "fit": "tap", "depth": "through", "thread": true }),
        json!({ "size": "M4", "depth": { "blind": 8 }, "thread": true, "tip": 90 }),
        json!({ "size": "M3", "insert": "std" }),
        json!({ "size": "M4", "depth": "through", "thread": false, "fit": "close" }),
    ] {
        spec_of(&ok).unwrap_or_else(|e| panic!("{ok}: {e}"));
    }
}

/// Hand-built specs cannot lose a countersink either: the tool builder refuses a counterbore
/// with a countersink.
#[test]
fn a_tool_with_counterbore_and_countersink_is_refused() {
    let mut s =
        spec_of(&json!({ "size": "M4", "depth": "through", "cbore": "iso4762" })).expect("spec");
    s.csink = Some((9.0, 90.0));
    let e = hole_tool(
        &s,
        "a",
        Vec3::zero(),
        -Vec3::unit_z(),
        Vec3::unit_x(),
        20.0,
        true,
    )
    .expect_err("refused");
    assert_eq!(e.code(), "FORGE_HOLE_TOOL");
}
