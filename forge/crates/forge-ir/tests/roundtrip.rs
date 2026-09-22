use forge_ir::*;

fn corpus(name: &str) -> String {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../corpus/programs")
        .join(name);
    std::fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
}

#[test]
fn corpus_programs_parse_validate_and_roundtrip() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../corpus/programs");
    let mut n = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "json") {
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            let doc = from_json(&corpus(&name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            let again = from_json(&to_json(&doc)).unwrap();
            assert_eq!(doc, again, "{name} did not round-trip");
            n += 1;
        }
    }
    assert!(n >= 3, "expected corpus programs in {}", dir.display());
}

#[test]
fn rejects_forward_references_and_bad_values() {
    let text = r#"{
      "schema": "aicad.ir/0",
      "parts": [{ "id": "p1", "name": "part", "features": [
        { "type": "extrude", "id": "f1", "name": "early", "sketch": "base", "distance": -1 },
        { "type": "sketch", "id": "f2", "name": "base", "plane": "XY",
          "curves": [ { "kind": "circle", "id": "c", "center": [0,0], "radius": 0 } ] }
      ]}]
    }"#;
    let IrError::Invalid(errs) = from_json(text).unwrap_err() else {
        panic!("expected Invalid")
    };
    let codes: Vec<_> = errs.iter().map(|e| e.code).collect();
    assert!(codes.contains(&"UNRESOLVED_SKETCH"), "{codes:?}");
    assert!(codes.contains(&"INVALID_DISTANCE"), "{codes:?}");
    assert!(codes.contains(&"DEGENERATE_CURVE"), "{codes:?}");
}

#[test]
fn rejects_unknown_fields() {
    let text = r#"{ "schema": "aicad.ir/0", "parts": [], "bogus": 1 }"#;
    assert!(matches!(from_json(text), Err(IrError::Parse(_))));
}

#[test]
fn named_planes_are_right_handed() {
    for p in [NamedPlane::XY, NamedPlane::XZ, NamedPlane::YZ] {
        let (_, x, y, n) = PlaneSpec::Named(p).resolve();
        let c = [
            x[1] * y[2] - x[2] * y[1],
            x[2] * y[0] - x[0] * y[2],
            x[0] * y[1] - x[1] * y[0],
        ];
        // Named frames are exact unit axes, so the cross product must be exact too.
        let exact = c
            .iter()
            .zip(n)
            .all(|(a, b)| a.to_bits() == b.to_bits() || (*a == 0.0 && b == 0.0));
        assert!(exact, "{p:?}: x × y = {c:?} must equal normal {n:?}");
    }
}

#[test]
fn names_and_ids_are_unique_document_wide() {
    let text = r#"{
      "schema": "aicad.ir/0",
      "parts": [
        { "id": "p1", "name": "a", "features": [
          { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
            "curves": [ { "kind": "circle", "id": "c", "center": [0,0], "radius": 1 } ] } ] },
        { "id": "p2", "name": "b", "features": [
          { "type": "sketch", "id": "s1", "name": "base", "plane": "XY",
            "curves": [ { "kind": "circle", "id": "c", "center": [0,0], "radius": 1 } ] } ] }
      ]
    }"#;
    let IrError::Invalid(errs) = from_json(text).unwrap_err() else {
        panic!("expected Invalid")
    };
    let codes: Vec<_> = errs.iter().map(|e| (e.code, e.path.as_str())).collect();
    assert!(
        codes.contains(&("DUPLICATE_ID", "/parts/1/features/0/id")),
        "{codes:?}"
    );
    assert!(
        codes.contains(&("DUPLICATE_NAME", "/parts/1/features/0/name")),
        "{codes:?}"
    );
}

#[test]
fn rejects_reserved_names_and_unknown_curve_fields() {
    let reserved = r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p", "name": "p", "features": [
        { "type": "sketch", "id": "s", "name": "extrude", "plane": "XY",
          "curves": [ { "kind": "circle", "id": "c", "center": [0,0], "radius": 1 } ] } ] }] }"#;
    let IrError::Invalid(errs) = from_json(reserved).unwrap_err() else {
        panic!()
    };
    assert_eq!(errs[0].code, "RESERVED_NAME");

    let unknown = r#"{ "schema": "aicad.ir/0", "parts": [{ "id": "p", "name": "p", "features": [
        { "type": "sketch", "id": "s", "name": "base", "plane": "XY",
          "curves": [ { "kind": "circle", "id": "c", "center": [0,0], "radius": 1, "bogus": 2 } ] } ] }] }"#;
    assert!(matches!(from_json(unknown), Err(IrError::Parse(_))));
}

#[test]
fn canonical_json_omits_defaults() {
    let doc = from_json(&corpus("extrude_box.json")).unwrap();
    let json = to_json(&doc);
    for field in [
        "\"units\"",
        "\"regions\"",
        "\"op\"",
        "\"direction\"",
        "\"suppressed\"",
    ] {
        assert!(
            !json.contains(field),
            "canonical JSON should omit default {field}:\n{json}"
        );
    }
}
