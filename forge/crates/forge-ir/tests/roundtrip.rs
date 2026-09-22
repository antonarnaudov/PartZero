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
    let IrError::Invalid(errs) = from_json(text).unwrap_err() else { panic!("expected Invalid") };
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
        let c = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
        assert_eq!(c, n, "{p:?}: x × y must equal normal");
    }
}
