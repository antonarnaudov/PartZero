//! The committed JSON Schemas and constants are consumed by TS codegen and the oracle; they must
//! match the Rust types. Regenerate with `cargo run -p forge-ir --example dump_schema`.
#[test]
fn committed_schemas_match_types() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schema");
    for (file, schema) in [
        ("ir-v0.schema.json", forge_ir::document_schema()),
        ("metrics-v0.schema.json", forge_ir::report_schema()),
        ("ir-v1.schema.json", forge_ir::v1::document_schema()),
        ("metrics-v1.schema.json", forge_ir::v1::report_schema()),
        ("ir-v1.constants.json", forge_ir::v1::constants_json()),
    ] {
        let committed = std::fs::read_to_string(dir.join(file))
            .unwrap_or_else(|_| panic!("missing schema/{file}; run the dump_schema example"));
        let committed: serde_json::Value = serde_json::from_str(&committed).unwrap();
        assert_eq!(
            committed, schema,
            "schema/{file} is stale; run the dump_schema example"
        );
    }
}

#[test]
fn v0_constants_file_is_unchanged() {
    // v0 is frozen: its constants file must keep exactly the v0 values.
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("schema");
    let c: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("ir-v0.constants.json")).unwrap())
            .unwrap();
    assert_eq!(c["IR_SCHEMA"], "aicad.ir/0");
    assert_eq!(c["METRICS_SCHEMA"], "aicad.metrics/0");
    assert_eq!(
        c["RESERVED_NAMES"],
        serde_json::json!(forge_ir::RESERVED_NAMES)
    );
}
